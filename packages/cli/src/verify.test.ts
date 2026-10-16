import { BunServices } from "@effect/platform-bun";
import { assert, layer } from "@effect/vitest";
import { Catalog } from "@telipot/catalog";
import { catalogFixtures } from "@telipot/fixtures/catalog";
import { copyDirectory } from "@telipot/fixtures/filesystem";
import {
  Clock,
  ConfigProvider,
  DateTime,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Predicate,
} from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { renderer } from "./render";
import { type Progress, type VerifyOptions, verifyProvider } from "./verify";

const secret = "sk-secret-123456";
const { summary } = renderer({ stdout: false, stderr: false });

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

interface Reply {
  readonly status?: number;
  readonly body?: unknown;
  readonly text?: string;
  readonly headers?: Record<string, string>;
  readonly unreachable?: string;
}

const rows = [1, 2, 3].map((n) => ({ phrase: `openrouter ${n}`, volume: n * 100 }));

const answers: Record<string, Reply> = {
  "/v1/page": { body: { text: "hello" } },
  "/v1/keywords": { body: { rows } },
  "/v1/related": { body: { related: ["a", "b", "c"], usage: { cost: 0.04 } } },
  "/v1/domains/overview": { body: { domain: "example.com", owner_email: "ana@acme.io" } },
  "/v1/lookup": { text: "Ph;Nq\nopenrouter;1", headers: { "content-type": "text/plain" } },
  "/v1/search": { body: { keywords: [] } },
  "/v1/similar": { body: { similar: ["a", "b"], usage: { cost: 0.004 } } },
  "/v1/account": { body: { credits: 500, email: "founder@missing.studio" } },
};

const vendor = (script: (seen: Seen, nth: number) => Reply | undefined = () => undefined) => {
  const calls: Array<Seen> = [];
  const client = HttpClient.make((request, url) =>
    Effect.suspend(() => {
      const seen: Seen = {
        method: request.method,
        path: url.pathname,
        query: url.searchParams,
        headers: request.headers,
        body: request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
      };

      const nth = calls.filter(({ path }) => path === seen.path).length;
      calls.push(seen);
      const reply = script(seen, nth) ?? answers[seen.path] ?? { status: 404 };
      if (Predicate.isNotUndefined(reply.unreachable)) {
        return Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              description: reply.unreachable,
            }),
          }),
        );
      }

      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(reply.text ?? JSON.stringify(reply.body ?? {}), {
            status: reply.status ?? 200,
            headers: { "content-type": "application/json", ...reply.headers },
          }),
        ),
      );
    }),
  );

  return { calls, layer: Layer.succeed(HttpClient.HttpClient, client) };
};

const options = (directory: string, more: Partial<VerifyOptions> = {}): VerifyOptions => ({
  directory,
  provider: "vendor",
  budget: undefined,
  dryRun: false,
  again: false,
  // Fast enough that no test waits on the limiter.
  accountRate: 1_000,
  routeRate: 60_000,
  ...more,
});

const today = "2026-10-05";

const run = Effect.fnUntraced(function* (
  directory: string,
  more: Partial<VerifyOptions> = {},
  script?: Parameters<typeof vendor>[0],
  env: Record<string, string> = { VENDOR_API_KEY: secret },
) {
  yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(`${today}T12:00:00Z`)));
  const boundary = vendor(script);
  const report = yield* verifyProvider(options(directory, more)).pipe(
    Effect.provide(
      Layer.merge(boundary.layer, ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
    ),
  );

  return { report, seen: boundary.calls };
});

const verification = Effect.fnUntraced(function* (directory: string, id: string) {
  const { tasks } = yield* Catalog.validate(directory);
  const entry = tasks.find(({ task }) => task.id === id);
  assert.isDefined(entry, id);
  return {
    state: entry?.verification,
    example: entry?.example,
  };
});

const read = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(file);
});

interface LogLine {
  readonly task: string;
  readonly cost_usd_micro: number | null;
  readonly cost_source: string;
  readonly [field: string]: unknown;
}

const logLines = (text: string) =>
  text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as LogLine);

const everyFile = Effect.fnUntraced(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const files = yield* fs.readDirectory(directory, { recursive: true });
  const contents = yield* Effect.forEach(files, (file) =>
    fs.readFileString(`${directory}/${file}`).pipe(Effect.orElseSucceed(() => "")),
  );

  return contents.join("\n");
});

const paths = (seen: ReadonlyArray<Seen>) => seen.map(({ path }) => path);

layer(BunServices.layer)("telipot catalog verify", (it) => {
  it.effect("lists the queue cheapest first with list prices, and calls and writes nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* copyDirectory(catalogFixtures.verify);
        const before = yield* everyFile(directory);
        const { report, seen } = yield* run(directory, { dryRun: true }, undefined, {});
        assert.deepStrictEqual(seen, []);
        assert.deepStrictEqual(
          report.queue.map(({ id, listMicroUsd }) => [id, listMicroUsd]),
          [
            ["vendor.page.text", 0],
            ["vendor.credits.left", 0],
            ["vendor.keywords.volume", 10_000],
            ["vendor.domain.overview", 20_000],
            ["vendor.keywords.search", 30_000],
            ["vendor.keywords.related", 50_000],
            ["vendor.keywords.lookup", undefined],
            ["vendor.keywords.similar", undefined],
          ],
        );

        assert.strictEqual(yield* everyFile(directory), before);
      }),
    ),
  );

  it.effect("lists a price table at the row the test request matches, not at its ceiling", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* copyDirectory(catalogFixtures.verify);
        const file = `${directory}/providers/vendor.yaml`;
        const text = yield* fs.readFileString(file);
        yield* fs.writeFileString(
          file,
          text.replace(
            "      value: 0.02\n",
            "      table:\n        - { when: { body.domain: example.com }, value: 0.02 }\n      fallback: { value: 9 }\n",
          ),
        );

        const { report } = yield* run(directory, { dryRun: true }, undefined, {});
        assert.deepStrictEqual(
          report.queue.find(({ id }) => id === "vendor.domain.overview"),
          { id: "vendor.domain.overview", listMicroUsd: 20_000 },
        );
      }),
    ),
  );

  it.effect("stamps verified with the date on a pass, and writes a scrubbed example", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* copyDirectory(catalogFixtures.verify);
        const { report, seen } = yield* run(directory);
        assert.deepStrictEqual(report.failed, []);

        const volume = yield* verification(directory, "vendor.keywords.volume");
        assert.deepStrictEqual(volume.state, { state: "verified", date: today });
        assert.deepStrictEqual(volume.example, { rows: rows.slice(0, 2) });

        const overview = yield* verification(directory, "vendor.domain.overview");
        assert.deepStrictEqual(overview.example, {
          domain: "example.com",
          owner_email: "contact@example.com",
        });

        const account = yield* verification(directory, "vendor.credits.left");
        assert.deepStrictEqual(account.example, { credits: 500, email: "masked" });

        const contacts = yield* verification(directory, "vendor.contacts.find");
        assert.strictEqual(contacts.state?.state, "untestable");
        assert.notInclude(paths(seen), "/v1/contacts");

        assert.isTrue(seen.some(({ query }) => query.get("key") === secret));
        assert.notInclude(yield* everyFile(directory), secret);
      }),
    ),
  );

  it.effect("sends the test request as written: query, JSON body, form body", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* copyDirectory(catalogFixtures.verify);
        const { seen } = yield* run(directory);
        const at = (path: string) => seen.find((call) => call.path === path);
        assert.strictEqual(at("/v1/keywords")?.query.get("phrase"), "openrouter");
        assert.strictEqual(at("/v1/keywords")?.query.get("limit"), "1");
        assert.strictEqual(at("/v1/domains/overview")?.method, "POST");
        assert.deepStrictEqual(JSON.parse(at("/v1/domains/overview")?.body ?? ""), {
          domain: "example.com",
        });

        assert.strictEqual(at("/v1/search")?.body, "prompt=openrouter");
      }),
    ),
  );

  it.effect("stamps unverified with the status and the vendor's message on a failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* copyDirectory(catalogFixtures.verify);
        const { report, seen } = yield* run(directory, {}, ({ path }) =>
          path === "/v1/keywords"
            ? { status: 401, body: { error: { message: `Invalid API key ${secret}` } } }
            : undefined,
        );

        const volume = yield* verification(directory, "vendor.keywords.volume");
        assert.deepStrictEqual(volume.state, {
          state: "unverified",
          reason: "401: Invalid API key ***",
        });

        assert.deepStrictEqual(
          report.failed.map(({ id, status }) => [id, status]),
          [
            ["vendor.keywords.volume", 401],
            // Same request, same answer, no second payment.
            ["vendor.keywords.volume.again", 401],
          ],
        );

        const again = yield* verification(directory, "vendor.keywords.volume.again");
        assert.deepStrictEqual(again.state, {
          state: "unverified",
          reason: "same request as vendor.keywords.volume: 401: Invalid API key ***",
        });

        assert.strictEqual(paths(seen).filter((path) => path === "/v1/keywords").length, 2);
      }),
    ),
  );

  it.effect("scrubs the credential in the form its scheme sends, when the vendor echoes it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* copyDirectory(catalogFixtures.verify);
        const file = `${directory}/providers/vendor.yaml`;
        const scheme = "{ type: api_key, in: query, name: key, principals: [organization] }";
        const text = yield* fs.readFileString(file);
        assert.include(text, scheme);
        yield* fs.writeFileString(
          file,
          text.replace(
            scheme,
            "{ type: api_key, in: basic, name: key, principals: [organization] }",
          ),
        );

        yield* run(directory, {}, ({ path, headers }) =>
          path === "/v1/keywords"
            ? { status: 401, body: { error: { message: `Refused ${headers.authorization}` } } }
            : undefined,
        );

        const volume = yield* verification(directory, "vendor.keywords.volume");
        assert.deepStrictEqual(volume.state, {
          state: "unverified",
          reason: "401: Refused Basic ***",
        });
      }),
    ),
  );

  it.effect("stamps a vendor it cannot reach as no response, the credential scrubbed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* copyDirectory(catalogFixtures.verify);
        yield* run(directory, {}, ({ path }) =>
          path === "/v1/keywords" ? { unreachable: `refused, key ${secret}` } : undefined,
        );

        const { state } = yield* verification(directory, "vendor.keywords.volume");
        assert.strictEqual(state?.state, "unverified");
        assert.match(state?.state === "unverified" ? state.reason : "", /^no response: /);
        assert.notInclude(yield* everyFile(directory), secret);
      }),
    ),
  );

  it.effect("stamps an answer past the byte limit as no response, and keeps none of it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* copyDirectory(catalogFixtures.verify);
        const huge = "x".repeat(10 * 1024 * 1024 + 1);
        yield* run(directory, {}, ({ path }) =>
          path === "/v1/page"
            ? { text: huge, headers: { "content-type": "text/plain" } }
            : undefined,
        );

        const { state } = yield* verification(directory, "vendor.page.text");
        assert.deepStrictEqual(state, {
          state: "unverified",
          reason: "no response: the answer ran past 10485760 bytes",
        });
      }),
    ),
  );

  it.effect("reads a JSON body the vendor labels text/plain as text, as a run does", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* copyDirectory(catalogFixtures.verify);
        yield* run(directory, {}, ({ path }) =>
          path === "/v1/page"
            ? { text: JSON.stringify({ text: "hello" }), headers: { "content-type": "text/plain" } }
            : undefined,
        );

        const { state, example } = yield* verification(directory, "vendor.page.text");
        assert.strictEqual(state?.state, "unverified");
        assert.match(state?.state === "unverified" ? state.reason : "", /^200: /);
        assert.isUndefined(example);
      }),
    ),
  );

  it.effect("stamps a 200 its expect rule refuses, naming the path and the value", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* copyDirectory(catalogFixtures.verify);
        const file = `${directory}/providers/vendor.yaml`;
        const replay = "    test_request: { queryParams: { url: https://example.com } }\n";
        const text = yield* fs.readFileString(file);
        assert.include(text, replay);
        yield* fs.writeFileString(
          file,
          text.replace(replay, `${replay}    expect: { json_path: status, equals: ok }\n`),
        );

        yield* run(directory);
        const { state } = yield* verification(directory, "vendor.page.text");
        assert.deepStrictEqual(state, { state: "unverified", reason: '200: status was not "ok"' });
      }),
    ),
  );

  it.effect("reads the vendor's message from the first of a list of errors", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* copyDirectory(catalogFixtures.verify);
        yield* run(directory, {}, ({ path }) =>
          path === "/v1/keywords"
            ? { status: 400, body: { errors: [{ details: "phrase is too long" }] } }
            : undefined,
        );

        const volume = yield* verification(directory, "vendor.keywords.volume");
        assert.deepStrictEqual(volume.state, {
          state: "unverified",
          reason: "400: phrase is too long",
        });
      }),
    ),
  );

  it.effect("retries a failure until the answer stops changing, and believes a pass", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* copyDirectory(catalogFixtures.verify);
        const { seen } = yield* run(directory, {}, ({ path }, nth) =>
          path === "/v1/keywords" && nth === 0 ? { status: 500, text: "boom" } : undefined,
        );

        const volume = yield* verification(directory, "vendor.keywords.volume");
        assert.strictEqual(volume.state?.state, "verified");
        assert.strictEqual(paths(seen).filter((path) => path === "/v1/keywords").length, 2);
      }),
    ),
  );

  it.effect("makes one call for two tasks that send the same request, and names the sibling", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* copyDirectory(catalogFixtures.verify);
        const { report, seen } = yield* run(directory);
        assert.strictEqual(paths(seen).filter((path) => path === "/v1/keywords").length, 1);
        assert.deepStrictEqual(report.skipped, [
          { id: "vendor.keywords.volume.again", sibling: "vendor.keywords.volume" },
        ]);

        const again = yield* verification(directory, "vendor.keywords.volume.again");
        assert.deepStrictEqual(again.state, {
          state: "skipped",
          reason: "same request as vendor.keywords.volume, which passed",
        });
      }),
    ),
  );

  it.effect("refuses a pass whose body breaks the output schema, naming the field", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* copyDirectory(catalogFixtures.verify);
        yield* run(directory, {}, ({ path }) =>
          path === "/v1/page" ? { body: { text: 7 } } : undefined,
        );

        const page = yield* verification(directory, "vendor.page.text");
        assert.strictEqual(page.state?.state, "unverified");
        const reason = page.state && "reason" in page.state ? page.state.reason : "";
        assert.match(reason, /^200: the response does not fit the output schema: text: /);
      }),
    ),
  );

  it.effect("reads a vendor's 200 error text as a failure through the output pattern", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* copyDirectory(catalogFixtures.verify);
        yield* run(directory, {}, ({ path }) =>
          path === "/v1/lookup"
            ? { text: "ERROR 50 :: NOTHING FOUND", headers: { "content-type": "text/plain" } }
            : undefined,
        );

        const lookup = yield* verification(directory, "vendor.keywords.lookup");
        assert.strictEqual(lookup.state?.state, "unverified");

        const fixed = yield* copyDirectory(catalogFixtures.verify);
        yield* run(fixed);
        const passed = yield* verification(fixed, "vendor.keywords.lookup");
        assert.strictEqual(passed.state?.state, "verified");
        assert.strictEqual(passed.example, "Ph;Nq\nopenrouter;1");
      }),
    ),
  );

  it.effect("resumes: a second run calls only what has not passed, and --again calls all", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* copyDirectory(catalogFixtures.verify);
        yield* run(directory, {}, ({ path }) =>
          path === "/v1/keywords" ? { status: 503, text: "down" } : undefined,
        );

        const second = yield* run(directory);
        assert.deepStrictEqual(paths(second.seen), ["/v1/keywords"]);
        const volume = yield* verification(directory, "vendor.keywords.volume");
        assert.strictEqual(volume.state?.state, "verified");

        const third = yield* run(directory, { again: true });
        assert.strictEqual(third.seen.length, 8);
      }),
    ),
  );

  it.effect("stops before the call that would pass the budget, and leaves the rest alone", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* copyDirectory(catalogFixtures.verify);
        // The free tasks, then 0.01 and 0.02: 0.03 spent, and the 0.03 search would reach 0.06.
        const { report, seen } = yield* run(directory, { budget: 45_000 });
        assert.deepStrictEqual(report.passed, [
          "vendor.page.text",
          "vendor.credits.left",
          "vendor.keywords.volume",
          "vendor.domain.overview",
        ]);

        assert.strictEqual(report.spentMicroUsd, 30_000);
        assert.deepStrictEqual(report.stoppedBefore, {
          id: "vendor.keywords.search",
          listMicroUsd: 30_000,
          leftMicroUsd: 15_000,
        });

        assert.notInclude(paths(seen), "/v1/search");
        const search = yield* verification(directory, "vendor.keywords.search");
        assert.isUndefined(search.state);

        const next = yield* run(directory, { budget: 200_000 });
        assert.deepStrictEqual(paths(next.seen), ["/v1/search", "/v1/related"]);
      }),
    ),
  );

  it.effect("counts a charge the vendor reports, never a task with no price as free", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* copyDirectory(catalogFixtures.verify);
        // Related lists 0.05, reports 0.04; no budget covers unpriced lookup and similar.
        const { report, seen } = yield* run(directory, { budget: 200_000 });
        assert.strictEqual(report.spentMicroUsd, 10_000 + 20_000 + 30_000 + 40_000);
        assert.deepStrictEqual(report.unbounded, [
          "vendor.keywords.lookup",
          "vendor.keywords.similar",
        ]);

        assert.notInclude(paths(seen), "/v1/lookup");

        // Lookup reports nothing, so its cost is unknown, not zero; similar's charge counts.
        const free = yield* run(directory);
        assert.deepStrictEqual(paths(free.seen), ["/v1/lookup", "/v1/similar"]);
        assert.deepStrictEqual(free.report.unknownCost, ["vendor.keywords.lookup"]);
        assert.strictEqual(free.report.spentMicroUsd, 4_000);
      }),
    ),
  );

  it.effect("charges nothing for a failed call of a pay-per-success task", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* copyDirectory(catalogFixtures.verify);
        const { report } = yield* run(directory, {}, ({ path }) =>
          path === "/v1/search" ? { status: 500, text: "boom" } : undefined,
        );

        // Similar has no price and reports 0.004.
        assert.strictEqual(report.spentMicroUsd, 10_000 + 20_000 + 40_000 + 4_000);
      }),
    ),
  );

  it.effect("retries a 429 and never records it as the task's verdict", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* copyDirectory(catalogFixtures.verify);
        const { seen } = yield* run(directory, {}, ({ path }, nth) =>
          path === "/v1/keywords" && nth < 2 ? { status: 429, text: "slow down" } : undefined,
        );

        assert.strictEqual(paths(seen).filter((path) => path === "/v1/keywords").length, 3);
        const volume = yield* verification(directory, "vendor.keywords.volume");
        assert.strictEqual(volume.state?.state, "verified");
      }),
    ),
  );

  it.effect("stops on a 429 that will not clear, with the task left as it was", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* copyDirectory(catalogFixtures.verify);
        const { report, seen } = yield* run(directory, {}, ({ path }) =>
          path === "/v1/keywords" ? { status: 429, text: "slow down" } : undefined,
        );

        assert.strictEqual(report.rateLimited, "vendor.keywords.volume");
        assert.isUndefined((yield* verification(directory, "vendor.keywords.volume")).state);
        assert.notInclude(paths(seen), "/v1/domains/overview");
      }),
    ),
  );

  it.effect("does not count the wait for the rate limiter as the vendor's silence", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* copyDirectory(catalogFixtures.verify);
        // A stable failure is called twice at one call a minute: the second waits twice the
        // 30-second timeout.
        yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(`${today}T12:00:00Z`)));
        const clock = yield* Clock.clockWith(Effect.succeed);
        const calledAt: Array<number> = [];
        const boundary = vendor(({ path }) => {
          if (path !== "/v1/keywords") return undefined;
          calledAt.push(clock.currentTimeMillisUnsafe());
          return { status: 500, text: "boom" };
        });

        const fiber = yield* verifyProvider(options(directory, { routeRate: 1 })).pipe(
          Effect.provide(
            Layer.merge(
              boundary.layer,
              ConfigProvider.layer(ConfigProvider.fromUnknown({ VENDOR_API_KEY: secret })),
            ),
          ),
          Effect.forkChild,
        );

        // The clock steps while the run waits on files and the limiter, so every sleep is reached.
        yield* Fiber.join(fiber).pipe(
          Effect.raceFirst(
            Effect.forever(
              Effect.andThen(
                TestClock.adjust("10 seconds"),
                TestClock.withLive(Effect.sleep("5 millis")),
              ),
            ),
          ),
        );

        const [first, second] = calledAt;
        assert.isDefined(first);
        assert.isDefined(second);
        assert.isAtLeast(second - first, 60_000);
        const volume = yield* verification(directory, "vendor.keywords.volume");
        assert.deepStrictEqual(volume.state, { state: "unverified", reason: "500: boom" });
      }),
    ),
  );

  it.effect("stamps the failure a billed call had when a 429 then stops the run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* copyDirectory(catalogFixtures.verify);
        const { report } = yield* run(directory, {}, ({ path }, nth) => {
          if (path !== "/v1/keywords") return undefined;
          return nth === 0 ? { status: 500, text: "boom" } : { status: 429, text: "slow down" };
        });

        assert.strictEqual(report.rateLimited, "vendor.keywords.volume");
        const volume = yield* verification(directory, "vendor.keywords.volume");
        assert.deepStrictEqual(volume.state, { state: "unverified", reason: "500: boom" });
      }),
    ),
  );

  it.effect("replays a task that passed under an older version of this tool", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* copyDirectory(catalogFixtures.verify);
        yield* run(directory);
        const log = `${directory}/.verify/vendor.jsonl`;
        const lines = logLines(yield* read(log));

        const fs = yield* FileSystem.FileSystem;
        // Every call so far was made by the tool as it is; the volume call, by an older one.
        yield* fs.writeFileString(
          log,
          lines
            .map((line) =>
              JSON.stringify(
                line.task === "vendor.keywords.volume" ? { ...line, verifier: 0 } : line,
              ),
            )
            .join("\n") + "\n",
        );

        const again = yield* run(directory);
        assert.deepStrictEqual(paths(again.seen), ["/v1/keywords"]);
      }),
    ),
  );

  it.effect("lists a task once as unknown cost however many times it was called", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* copyDirectory(catalogFixtures.verify);
        const { report } = yield* run(directory, {}, ({ path }) =>
          path === "/v1/lookup" ? { status: 500, text: "boom" } : undefined,
        );

        assert.deepStrictEqual(report.unknownCost, ["vendor.keywords.lookup"]);
      }),
    ),
  );

  it.effect("records each call's measured cost and the time it waited, as it goes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* copyDirectory(catalogFixtures.verify);
        yield* run(directory);
        const lines = logLines(yield* read(`${directory}/.verify/vendor.jsonl`));

        const related = lines.find(({ task }) => task === "vendor.keywords.related");
        assert.deepStrictEqual(
          { ...related, at: undefined },
          {
            task: "vendor.keywords.related",
            at: undefined,
            status: 200,
            ok: true,
            waited_ms: 0,
            cost_usd_micro: 40_000,
            cost_source: "reported",
            verifier: 2,
          },
        );

        const lookup = lines.find(({ task }) => task === "vendor.keywords.lookup");
        assert.strictEqual(lookup?.cost_usd_micro, null);
        assert.strictEqual(lookup?.cost_source, "unknown");
        // No list price, but the vendor reports 0.004 USD.
        const similar = lines.find(({ task }) => task === "vendor.keywords.similar");
        assert.strictEqual(similar?.cost_usd_micro, 4_000);
        assert.strictEqual(similar?.cost_source, "reported");
        assert.strictEqual(lines.length, 8);
      }),
    ),
  );

  it.effect("refuses without the credential and names the variable, except on a dry run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* copyDirectory(catalogFixtures.verify);
        const refused = yield* run(directory, {}, undefined, {}).pipe(Effect.flip);
        assert.include(refused.message, "VENDOR_API_KEY");
        assert.isUndefined((yield* verification(directory, "vendor.page.text")).state);
      }),
    ),
  );

  it.effect("refuses a provider the catalog does not have", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* copyDirectory(catalogFixtures.verify);
        const refused = yield* run(directory, { provider: "nobody" }).pipe(Effect.flip);
        assert.include(refused.message, "nobody");
      }),
    ),
  );

  it.effect("reports the keys output does not name, and keeps the full answer under .verify", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* copyDirectory(catalogFixtures.verify);
        const { report } = yield* run(directory, {}, ({ path }) =>
          path === "/v1/page"
            ? { body: { text: "hello", trace: { id: "t1", echoed: secret } } }
            : undefined,
        );

        const gap = report.undeclared.find(({ id }) => id === "vendor.page.text");
        assert.deepStrictEqual(gap?.paths, ["trace"]);
        assert.include(summary("vendor", report), "  vendor.page.text\n    trace");

        const page = yield* verification(directory, "vendor.page.text");
        assert.deepStrictEqual(page.example, { text: "hello" });
        const kept = yield* read(`${directory}/.verify/vendor/vendor.page.text.json`);
        assert.include(kept, '"trace"');
        assert.include(kept, '"echoed": "***"');
        assert.notInclude(kept, secret);

        assert.include(
          yield* read(`${directory}/.verify/vendor/vendor.keywords.lookup.txt`),
          "openrouter;1",
        );
      }),
    ),
  );

  it.effect("tells the queue first, then each task as it ends, passed, failed or skipped", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* copyDirectory(catalogFixtures.verify);
        const events: Array<Progress> = [];
        const { report } = yield* run(
          directory,
          { progress: (event) => Effect.sync(() => void events.push(event)) },
          ({ path }) =>
            path === "/v1/search" ? { status: 401, body: { error: "bad key" } } : undefined,
        );

        const [first, ...rest] = events;
        assert.deepStrictEqual(first, {
          kind: "queue",
          provider: "vendor",
          queue: report.queue,
          followers: ["vendor.keywords.volume.again"],
        });

        assert.strictEqual(report.callable, report.queue.length);

        const passed = rest.find(
          (event) => event.kind === "passed" && event.id === "vendor.keywords.related",
        );

        assert.deepStrictEqual(passed && { ...passed, waitedMs: 0 }, {
          kind: "passed",
          id: "vendor.keywords.related",
          waitedMs: 0,
          calls: 1,
          micro: 40_000,
          source: "reported",
        });

        const failed = rest.find((event) => event.kind === "failed");
        assert.strictEqual(failed?.kind === "failed" && failed.id, "vendor.keywords.search");
        assert.deepStrictEqual(
          rest.find((event) => event.kind === "skipped"),
          {
            kind: "skipped",
            id: "vendor.keywords.volume.again",
            sibling: "vendor.keywords.volume",
          },
        );
      }),
    ),
  );

  it.effect("tells each task what its calls cost together, so the lines add up to the spend", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* copyDirectory(catalogFixtures.verify);
        const events: Array<Progress> = [];
        const { report } = yield* run(
          directory,
          { progress: (event) => Effect.sync(() => void events.push(event)) },
          ({ path }, nth) => {
            if (path === "/v1/keywords" && nth === 0) return { status: 500, text: "boom" };
            if (path === "/v1/search") return { status: 401, body: { error: "bad key" } };
            return undefined;
          },
        );

        const told = events.flatMap((event) =>
          event.kind === "passed" || event.kind === "failed" ? [event] : [],
        );

        const volume = told.find(({ id }) => id === "vendor.keywords.volume");
        assert.strictEqual(volume?.kind, "passed");
        assert.strictEqual(volume?.calls, 2);
        const search = told.find(({ id }) => id === "vendor.keywords.search");
        assert.strictEqual(search?.kind, "failed");
        assert.strictEqual(search?.calls, 2);

        assert.isAbove(report.spentMicroUsd, 0);
        assert.strictEqual(
          told.reduce((sum, { micro }) => sum + (micro ?? 0), 0),
          report.spentMicroUsd,
        );
      }),
    ),
  );

  it.effect(
    "tells a task that took a failed sibling's answer as failed, with no call of its own",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* copyDirectory(catalogFixtures.verify);
          const events: Array<Progress> = [];
          yield* run(
            directory,
            { progress: (event) => Effect.sync(() => void events.push(event)) },
            ({ path }) =>
              path === "/v1/keywords"
                ? { status: 401, body: { error: { message: "Invalid API key" } } }
                : undefined,
          );

          const failed = events.filter(
            (event) => event.kind === "failed" && event.id.startsWith("vendor.keywords.volume"),
          );

          assert.deepStrictEqual(
            failed.map(
              (event) => event.kind === "failed" && [event.id, event.message, event.calls],
            ),
            [
              ["vendor.keywords.volume", "401: Invalid API key", 2],
              [
                "vendor.keywords.volume.again",
                "same request as vendor.keywords.volume: 401: Invalid API key",
                0,
              ],
            ],
          );

          assert.deepStrictEqual(failed[1], {
            kind: "failed",
            id: "vendor.keywords.volume.again",
            message: "same request as vendor.keywords.volume: 401: Invalid API key",
            calls: 0,
            micro: 0,
          });

          assert.isFalse(events.some((event) => event.kind === "skipped"));
        }),
      ),
  );

  it.effect("tells nothing of a task that took a sibling's answer when no call was made", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* copyDirectory(catalogFixtures.verify);
        yield* run(directory);
        const events: Array<Progress> = [];
        const { report } = yield* run(directory, {
          progress: (event) => Effect.sync(() => void events.push(event)),
        });

        assert.deepStrictEqual(events, []);
        assert.deepStrictEqual(report.queue, []);
        assert.strictEqual(report.skipped.length, 1);
        assert.include(summary("vendor", report), "vendor · nothing to replay");
      }),
    ),
  );

  it.effect("prints no control character a vendor sent, in its message or in a key it added", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* copyDirectory(catalogFixtures.verify);
        const events: Array<Progress> = [];
        const { report } = yield* run(
          directory,
          { progress: (event) => Effect.sync(() => void events.push(event)) },
          ({ path }) => {
            if (path === "/v1/keywords") {
              return { status: 401, body: { error: { message: "bad\u001b[2J\rfake ‮" } } };
            }

            return path === "/v1/page" ? { body: { text: "hello", "tra\u001bce": 1 } } : undefined;
          },
        );

        const failed = events.find((event) => event.kind === "failed");
        const message = failed?.kind === "failed" ? failed.message : "";
        assert.include(message, "bad [2J fake");
        assert.notMatch(message, /[\p{Cc}\p{Cf}]/u);
        assert.notMatch(report.failed[0]?.message ?? "", /[\p{Cc}\p{Cf}]/u);
        const volume = yield* verification(directory, "vendor.keywords.volume");
        assert.deepStrictEqual(volume.state, { state: "unverified", reason: message });

        const gap = report.undeclared.find(({ id }) => id === "vendor.page.text");
        assert.deepStrictEqual(gap?.paths, ["tra ce"]);
      }),
    ),
  );

  it.effect("keeps no answer of a call that failed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* copyDirectory(catalogFixtures.verify);
        yield* run(directory, {}, ({ path }) =>
          path === "/v1/page" ? { status: 401, body: { error: "bad key" } } : undefined,
        );

        assert.isFalse(yield* fs.exists(`${directory}/.verify/vendor/vendor.page.text.json`));
      }),
    ),
  );

  it.effect("leaves the catalog valid, as the loader and CI read it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* copyDirectory(catalogFixtures.verify);
        yield* run(directory);
        const { issues } = yield* Catalog.validate(directory);
        assert.deepStrictEqual(issues, []);
      }),
    ),
  );
});
