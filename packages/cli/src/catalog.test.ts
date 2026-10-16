import { BunServices } from "@effect/platform-bun";
import { assert, layer } from "@effect/vitest";
import { Catalog, Snapshot, formatIssue } from "@telipot/catalog";
import { catalogFixtures } from "@telipot/fixtures/catalog";
import { copyDirectory } from "@telipot/fixtures/filesystem";
import { openApiFixtures } from "@telipot/fixtures/openapi";
import { Context, Effect, FileSystem, Layer, Predicate, Schema, Stream } from "effect";
import { type RequestListener, createServer } from "node:http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { readFileSync } from "node:fs";
import { parse, parseDocument } from "yaml";

import { telipot } from "./testing";

interface ProviderFile {
  readonly display_name: string;
  readonly base_url: string | null;
  readonly source: { readonly openapi: string | null };
  readonly auth: { readonly schemes: Readonly<Record<string, { readonly name?: string }>> };
}

const bin = `${import.meta.dirname}/bin.ts`;
const repository = `${import.meta.dirname}/../../..`;

// The real binary, in its own process.
const spawned = Effect.fnUntraced(function* (
  args: ReadonlyArray<string>,
  options?: { readonly cwd?: string },
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const run = yield* spawner.spawn(ChildProcess.make(bin, args, { ...options, extendEnv: true }));
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      Stream.mkString(Stream.decodeText(run.stdout)),
      Stream.mkString(Stream.decodeText(run.stderr)),
      run.exitCode,
    ],
    { concurrency: "unbounded" },
  );

  return { exitCode: Number(exitCode), stdout, stderr };
}, Effect.scoped);

const issues = (directory: string) =>
  Catalog.validate(directory).pipe(Effect.map(({ issues }) => issues.map(formatIssue)));

const lockFile = Effect.fnUntraced(function* (lock: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* fs.makeTempFileScoped({ suffix: ".json" });
  yield* fs.writeFileString(file, JSON.stringify(lock));
  return file;
});

// Live services, so verify's limiter runs on the real clock.
layer(BunServices.layer, { excludeTestServices: true })("telipot catalog validate", (it) => {
  it.effect("ends a clean run with the count of core providers and their tasks", () =>
    Effect.gen(function* () {
      const { exitCode, stdout } = yield* telipot(["catalog", "validate", catalogFixtures.clean]);
      assert.strictEqual(exitCode, 0);
      assert.strictEqual(stdout.trimEnd().split("\n").at(-1), "✓ 2 providers, 11 tasks valid");
    }),
  );

  it.effect("warns on stderr about a price checked more than 90 days ago, and still passes", () =>
    Effect.gen(function* () {
      const { exitCode, stderr } = yield* telipot(["catalog", "validate", catalogFixtures.clean]);
      assert.strictEqual(exitCode, 0);
      const lines = stderr.split("\n").map((line) => line.trim());
      assert.strictEqual(lines[0], "WARN");
      assert.include(
        lines,
        "providers/acme.yaml endpoints[2].cost.checked: 2026-06-01 is more than 90 days ago; check the price again",
      );
    }),
  );

  it.effect(
    "refuses a bad catalog, printing each issue on its own line with its file and field path",
    () =>
      Effect.gen(function* () {
        const { exitCode, stderr } = yield* telipot([
          "catalog",
          "validate",
          catalogFixtures.refused,
        ]);

        assert.notStrictEqual(exitCode, 0);
        const lines = stderr.split("\n").map((line) => line.trim());
        assert.include(
          lines,
          "providers/missing-scope.yaml endpoints[0].scope: required unless auth is public",
        );

        for (const issue of yield* issues(catalogFixtures.refused)) assert.include(lines, issue);
      }),
  );

  it.effect("passes the repository's catalog", () =>
    Effect.gen(function* () {
      const { exitCode } = yield* telipot(["catalog", "validate", `${repository}/catalog`]);
      assert.strictEqual(exitCode, 0);
    }),
  );

  // Over the small fixture: the binary's start takes most of this test's time.
  it.effect("checks the catalog folder in the working directory by default", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const folder = yield* fs.makeTempDirectoryScoped();
      yield* fs.copy(catalogFixtures.clean, `${folder}/catalog`);
      const named = yield* telipot(["catalog", "validate", `${folder}/catalog`]);
      assert.strictEqual(named.exitCode, 0);
      // The real binary prints what the in-process run printed.
      assert.deepStrictEqual(yield* spawned(["catalog", "validate"], { cwd: folder }), named);
    }),
  );

  it.effect(
    "refuses an id the previous lock held that the lock dropped, and still prints its warnings",
    () =>
      Effect.gen(function* () {
        // As if acme.page.txt had become acme.page.text in its file and the lock.
        const previous = yield* lockFile(["acme.page.txt", "acme.page.text"]);
        const { exitCode, stderr } = yield* telipot([
          "catalog",
          "validate",
          "--previous-lock",
          previous,
          catalogFixtures.clean,
        ]);

        assert.notStrictEqual(exitCode, 0);
        const lines = stderr.split("\n").map((line) => line.trim());
        assert.isTrue(
          lines.some((line) => line.startsWith("ids.lock.json: acme.page.txt ")),
          stderr,
        );

        assert.strictEqual(lines[0], "WARN");
      }),
  );
});

const routes = [
  "/page",
  "/keywords",
  "/related",
  "/lookup",
  "/search",
  "/similar",
  "/account",
  "/contacts",
];

const answers: Record<string, unknown> = {
  "/v1/page": { text: "hello" },
  "/v1/keywords": { rows: [{ phrase: "openrouter", volume: 100 }] },
  "/v1/related": { related: ["a"], usage: { cost: 0.04 } },
  "/v1/domains/overview": { domain: "example.com" },
  "/v1/lookup": "Ph;Nq",
  "/v1/search": { keywords: [] },
  "/v1/similar": { similar: ["a"], usage: { cost: 0.004 } },
  "/v1/account": { credits: 500 },
  // Every route of the fixture, with /keywords moved.
  "/openapi.json": {
    openapi: "3.1.0",
    info: { title: "Vendor" },
    servers: [{ url: "/v1" }],
    paths: Object.fromEntries<object>([
      ...routes.map((route): [string, object] => [
        route === "/keywords" ? "/v2/keywords" : route,
        { get: {} },
      ]),
      ["/domains/overview", { post: {} }],
    ]),
  },
};

const listening = (handler: RequestListener) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<ReturnType<typeof createServer>>((resolve) => {
          const server = createServer(handler);
          server.listen(0, "127.0.0.1", () => resolve(server));
        }),
    ),
    (server) => Effect.sync(() => server.close()),
  );

const portOf = (server: ReturnType<typeof createServer>) =>
  (server.address() as { port: number }).port;

const vendor = listening((request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  const answer = answers[path];
  response.writeHead(Predicate.isUndefined(answer) ? 404 : 200, {
    "content-type": Predicate.isString(answer) ? "text/plain" : "application/json",
  });

  response.end(Predicate.isString(answer) ? answer : JSON.stringify(answer ?? {}));
});

const catalogFor = Effect.fnUntraced(function* (port: number | undefined) {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* copyDirectory(catalogFixtures.verify);
  const file = `${directory}/providers/vendor.yaml`;
  const text = yield* fs.readFileString(file);
  yield* fs.writeFileString(
    file,
    text.replaceAll("http://vendor.test/v1", `http://127.0.0.1:${port ?? 9}/v1`),
  );

  return { directory, file };
});

layer(BunServices.layer, { excludeTestServices: true })("telipot catalog verify", (it) => {
  it.effect("prints the queue and its list price on a dry run, and calls nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { directory } = yield* catalogFor(undefined);
        const { exitCode, stdout } = yield* telipot([
          "catalog",
          "verify",
          "vendor",
          "--dry-run",
          directory,
        ]);

        assert.strictEqual(exitCode, 0);
        const lines = stdout.trimEnd().split("\n");
        assert.strictEqual(lines[0], "vendor · 8 calls · $0.11 at list price · 2 with no price");
        assert.match(lines[2] ?? "", /^ +task +list price$/);
        assert.match(lines[3] ?? "", /^ +vendor\.page\.text +free$/);
        assert.match(lines.at(-4) ?? "", /^ +vendor\.keywords\.lookup +no price$/);
        assert.match(lines.at(-3) ?? "", /^ +vendor\.keywords\.similar +no price$/);
        assert.strictEqual(lines.at(-1), "set VENDOR_API_KEY to run them");
      }),
    ),
  );

  it.effect("refuses a run without the credential, naming the variable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { directory } = yield* catalogFor(undefined);
        const { exitCode, stderr } = yield* telipot(["catalog", "verify", "vendor", directory]);
        assert.notStrictEqual(exitCode, 0);
        assert.include(stderr, "VENDOR_API_KEY");
      }),
    ),
  );

  it.effect("replays every test request and stamps verified in the provider's file", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const server = yield* vendor;
        const port = portOf(server);
        const { directory, file } = yield* catalogFor(port);

        // Fast enough that no test waits on the limiter; verify.test.ts proves the pacing.
        const { exitCode, stdout } = yield* telipot(
          ["catalog", "verify", "vendor", "--account-rate", "1000", directory],
          { env: { VENDOR_API_KEY: "sk-secret-123456" } },
        );

        assert.strictEqual(exitCode, 0, stdout);
        assert.include(stdout, "8 passed · 0 failed · 1 skipped");
        assert.match(stdout, /✓ vendor\.page\.text +\d+ ms/);
        assert.include(
          stdout,
          "– vendor.keywords.volume.again  same request as vendor.keywords.volume",
        );

        const text = yield* fs.readFileString(file);
        assert.strictEqual(text.match(/^ {4}verified: \d{4}-\d{2}-\d{2}$/gm)?.length, 8);
        assert.include(text, "skipped: same request as vendor.keywords.volume, which passed");
        assert.notInclude(text, "sk-secret-123456");
        assert.isTrue(yield* fs.exists(`${directory}/examples/vendor.keywords.volume.json`));

        const validated = yield* telipot(["catalog", "validate", directory]);
        assert.strictEqual(validated.exitCode, 0, validated.stderr);
        const again = yield* telipot(["catalog", "verify", "vendor", directory], {
          env: { VENDOR_API_KEY: "sk-secret-123456" },
        });

        assert.strictEqual(again.exitCode, 0, again.stderr);
        assert.include(again.stdout, "vendor · nothing to replay");
        assert.notInclude(again.stdout, "–");
      }),
    ),
  );

  it.effect("tells a failure as it ends, then summarises it, and exits non-zero", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Nothing listens on the port.
        const { directory } = yield* catalogFor(undefined);
        const { exitCode, stdout, stderr } = yield* telipot(
          ["catalog", "verify", "vendor", "--account-rate", "1000", directory],
          { env: { VENDOR_API_KEY: "sk-secret-123456" } },
        );

        assert.notStrictEqual(exitCode, 0);
        assert.include(stderr, "tasks did not pass");
        assert.match(stdout, /^vendor · 8 calls/);
        assert.match(stdout, /\n {2}✗ vendor\.page\.text +no response/);
        assert.match(stdout, /\n\n0 passed · \d+ failed · 0 skipped/);
        assert.include(stdout, "Failed\n  no response × ");
        assert.include(stdout, "every failure is no response");
      }),
    ),
  );
});

layer(BunServices.layer, { excludeTestServices: true })("telipot catalog drift", (it) => {
  it.effect("fails with the task whose route the vendor's spec no longer has", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const server = yield* vendor;
        const port = portOf(server);
        const { directory, file } = yield* catalogFor(port);
        const text = yield* fs.readFileString(file);
        yield* fs.writeFileString(
          file,
          text.replace("openapi: null", `openapi: http://127.0.0.1:${port}/openapi.json`),
        );

        const { exitCode, stderr } = yield* telipot(["catalog", "drift", directory]);
        assert.notStrictEqual(exitCode, 0);
        assert.include(
          stderr,
          `vendor.keywords.volume calls GET http://127.0.0.1:${port}/v1/keywords, which is not in http://127.0.0.1:${port}/openapi.json`,
        );

        assert.notInclude(stderr, "vendor.page.text");
      }),
    ),
  );
});

const widgetlySpec = readFileSync(openApiFixtures.widgetly, "utf8");
const keyedSpec = readFileSync(openApiFixtures.keyed, "utf8");
const specServer = listening((request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  const pages: Record<string, string> = {
    "/openapi.json": widgetlySpec,
    "/keyed.json": keyedSpec,
    "/docs": "<html>Docs</html>",
  };

  const page = Object.hasOwn(pages, path) ? pages[path] : undefined;
  response.writeHead(Predicate.isUndefined(page) ? 404 : 200);
  response.end(page);
});

const catalogWithSpec = Effect.fnUntraced(function* () {
  const server = yield* specServer;
  const directory = yield* copyDirectory(catalogFixtures.clean);
  return { directory, url: `http://127.0.0.1:${portOf(server)}/openapi.json` };
});

const fillWidgetly = Effect.fnUntraced(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const file = `${directory}/providers/widgetly.yaml`;
  const core = parseDocument(yield* fs.readFileString(file));
  core.set("docs_url", "https://docs.widgetly.example");
  core.setIn(["source", "docs"], "https://docs.widgetly.example");
  core.setIn(["identity", "task"], "widgetly.x.get-current-user");
  core.setIn(["identity", "account_path"], "id");
  core.setIn(["identity", "label_path"], "name");
  yield* fs.writeFileString(file, String(core));
});

const lines = (text: string) => text.split("\n").map((line) => line.trim());

layer(BunServices.layer, { excludeTestServices: true })("telipot catalog new", (it) => {
  it.effect(
    "turns a vendor's OpenAPI document into a file that passes validate once the flagged fields are filled",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { directory, url } = yield* catalogWithSpec();

          const made = yield* telipot(["catalog", "new", "widgetly", directory, "--openapi", url]);
          assert.strictEqual(made.exitCode, 0, made.stderr);
          assert.include(lines(made.stdout), "wrote providers/widgetly.yaml");
          assert.include(lines(made.stdout), "wrote providers/widgetly.extended.yaml");
          assert.include(made.stdout, "7 extended tasks");
          assert.include(made.stdout, "before telipot catalog validate passes");
          assert.match(made.stdout, /docs_url +the provider's documentation page/);
          assert.match(made.stdout, /identity +the task that returns the connected account/);
          assert.include(made.stdout, "GET /cookie-only: needs the session scheme");

          const core = parse(
            yield* fs.readFileString(`${directory}/providers/widgetly.yaml`),
          ) as ProviderFile;

          assert.strictEqual(core.source.openapi, url);
          // The spec's server is a path, so it resolves against where the spec was fetched.
          assert.strictEqual(core.base_url, `${url.replace("/openapi.json", "")}/v1`);
          const lock = JSON.parse(
            yield* fs.readFileString(`${directory}/ids.lock.json`),
          ) as ReadonlyArray<string>;

          assert.include(lock, "widgetly.x.get-widget");

          const unfilled = yield* telipot(["catalog", "validate", directory]);
          assert.notStrictEqual(unfilled.exitCode, 0);
          assert.include(lines(unfilled.stderr).join("\n"), "providers/widgetly.yaml docs_url");
          assert.include(
            lines(unfilled.stderr).join("\n"),
            "providers/widgetly.yaml identity.task",
          );

          yield* fillWidgetly(directory);
          const filled = yield* telipot(["catalog", "validate", directory]);
          assert.strictEqual(filled.exitCode, 0, filled.stderr);
        }),
      ),
  );

  it.effect("without a URL records openapi: null, and the file passes validate once written", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { directory } = yield* catalogWithSpec();
        const lock = yield* fs.readFileString(`${directory}/ids.lock.json`);

        const made = yield* telipot(["catalog", "new", "gadgets", directory]);
        assert.strictEqual(made.exitCode, 0, made.stderr);
        assert.deepStrictEqual(lines(made.stdout).slice(1, 2), ["wrote providers/gadgets.yaml"]);
        assert.match(made.stdout, /base_url +the API's root URL/);

        const file = `${directory}/providers/gadgets.yaml`;
        const core = parseDocument(yield* fs.readFileString(file));
        assert.strictEqual(core.getIn(["source", "openapi"]), null);
        assert.isFalse(yield* fs.exists(`${directory}/providers/gadgets.extended.yaml`));
        assert.strictEqual(yield* fs.readFileString(`${directory}/ids.lock.json`), lock);

        const unfilled = yield* telipot(["catalog", "validate", directory]);
        assert.notStrictEqual(unfilled.exitCode, 0);
        core.set("base_url", "https://api.gadgets.example");
        core.set("docs_url", "https://docs.gadgets.example");
        core.setIn(["source", "docs"], "https://docs.gadgets.example");
        yield* fs.writeFileString(file, String(core));
        const filled = yield* telipot(["catalog", "validate", directory]);
        assert.strictEqual(filled.exitCode, 0, filled.stderr);
      }),
    ),
  );

  it.effect(
    "regenerates the extended file byte for byte while the spec is unchanged, keeping a reviewed field edited in place",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { directory, url } = yield* catalogWithSpec();
          const extended = `${directory}/providers/widgetly.extended.yaml`;
          const run = () => telipot(["catalog", "new", "widgetly", directory, "--openapi", url]);

          yield* run();
          yield* fillWidgetly(directory);
          const first = yield* fs.readFileString(extended);

          const again = yield* run();
          assert.strictEqual(again.exitCode, 0, again.stderr);
          assert.include(again.stdout, "providers/widgetly.yaml is yours, and was left as it was");
          assert.notInclude(again.stdout, "wrote providers/widgetly.yaml");
          assert.strictEqual(yield* fs.readFileString(extended), first);

          // The digest leaves reviewed fields out, so a rename in place keeps it.
          const edited = first.replace("name: List widgets", "name: Widgets by owner");
          assert.notStrictEqual(edited, first);
          yield* fs.writeFileString(extended, edited);
          const validated = yield* telipot(["catalog", "validate", directory]);
          assert.strictEqual(validated.exitCode, 0, validated.stderr);

          const last = yield* run();
          assert.strictEqual(last.exitCode, 0, last.stderr);
          assert.strictEqual(yield* fs.readFileString(extended), edited);
          const revalidated = yield* telipot(["catalog", "validate", directory]);
          assert.strictEqual(revalidated.exitCode, 0, revalidated.stderr);
        }),
      ),
  );

  it.effect("refreshes the extended file while the core file still has fields to write", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { directory, url } = yield* catalogWithSpec();
        const run = () => telipot(["catalog", "new", "widgetly", directory, "--openapi", url]);
        yield* run();
        const first = yield* fs.readFileString(`${directory}/providers/widgetly.extended.yaml`);
        const again = yield* run();
        assert.strictEqual(again.exitCode, 0, again.stderr);
        assert.strictEqual(
          yield* fs.readFileString(`${directory}/providers/widgetly.extended.yaml`),
          first,
        );
      }),
    ),
  );

  it.effect(
    "keeps published ids and verification through spec collisions, renames, deletion and restoration",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { directory, url } = yield* catalogWithSpec();
          const run = () => telipot(["catalog", "new", "widgetly", directory, "--openapi", url]);
          const first = yield* run();
          assert.strictEqual(first.exitCode, 0, first.stderr);
          yield* fillWidgetly(directory);

          const extendedPath = `${directory}/providers/widgetly.extended.yaml`;
          const edited = parseDocument(yield* fs.readFileString(extendedPath));
          const before = edited.toJSON() as { endpoints: ReadonlyArray<{ id: string }> };
          const at = before.endpoints.findIndex(({ id }) => id === "widgetly.x.get-widget");
          assert.isAtLeast(at, 0);
          edited.setIn(["endpoints", at, "name"], "Reviewed widget lookup");
          edited.deleteIn(["endpoints", at, "untestable"]);
          edited.setIn(["endpoints", at, "verified"], "2026-10-01");
          edited.setIn(
            ["endpoints", at, "example_response"],
            "examples/widgetly.x.get-widget.json",
          );

          yield* fs.writeFileString(
            `${directory}/examples/widgetly.x.get-widget.json`,
            '{"id":"w_1"}',
          );

          yield* fs.writeFileString(extendedPath, String(edited));

          const inserted = {
            op: "add",
            path: "/paths/~1aaa",
            value: {
              get: {
                operationId: "get-widget",
                security: [],
                responses: { 200: { description: "Another route" } },
              },
            },
          };

          const renamed = {
            op: "replace",
            path: "/paths/~1widgets~1{widgetId}/get/operationId",
            value: "lookupWidget",
          };

          yield* fs.makeDirectory(`${directory}/patches`, { recursive: true });
          const patch = (operations: ReadonlyArray<unknown>) =>
            fs.writeFileString(`${directory}/patches/widgetly.json`, JSON.stringify(operations));

          const loaded = Effect.fnUntraced(function* () {
            const result = yield* Catalog.validate(directory);
            assert.deepStrictEqual(result.issues.map(formatIssue), []);
            return result.tasks ?? assert.fail("generated catalog did not load");
          });

          yield* patch([inserted]);
          const collision = yield* run();
          assert.strictEqual(collision.exitCode, 0, collision.stderr);
          const withCollision = yield* loaded();
          const status =
            withCollision.find(({ task }) => task.id === "widgetly.x.get-widget")?.task ??
            assert.fail("widget id vanished");

          assert.strictEqual(status.path, "/widgets/{widgetId}");
          assert.strictEqual(status.name, "Reviewed widget lookup");
          assert.strictEqual(status.verified, "2026-10-01");
          const fresh =
            withCollision.find(({ task }) => task.id === "widgetly.x.get-widget-2")?.task ??
            assert.fail("no fresh id");

          assert.strictEqual(fresh.path, "/aaa");
          assert.isUndefined(fresh.verified);

          yield* patch([inserted, renamed]);
          const rename = yield* run();
          assert.strictEqual(rename.exitCode, 0, rename.stderr);
          assert.deepStrictEqual(
            (yield* loaded())
              .filter(
                ({ provider, task }) =>
                  provider.provider === "widgetly" &&
                  task.path === "/widgets/{widgetId}" &&
                  task.method === "GET" &&
                  Predicate.isUndefined(task.status),
              )
              .map(({ task }) => task.id),
            [status.id],
          );

          yield* patch([renamed]);
          const deletion = yield* run();
          assert.strictEqual(deletion.exitCode, 0, deletion.stderr);
          assert.strictEqual(
            (yield* loaded()).find(({ task }) => task.id === fresh.id)?.task.status,
            "retired",
          );

          yield* patch([inserted, renamed]);
          const restoration = yield* run();
          assert.strictEqual(restoration.exitCode, 0, restoration.stderr);
          assert.isUndefined(
            (yield* loaded()).find(({ task }) => task.id === fresh.id)?.task.status,
          );

          const snapshot = yield* fs.readFileString(extendedPath);
          const unchanged = yield* run();
          assert.strictEqual(unchanged.exitCode, 0, unchanged.stderr);
          assert.strictEqual(yield* fs.readFileString(extendedPath), snapshot);
        }),
      ),
  );

  it.effect(
    "refuses an absent previous extended file with published ids before writing anything",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { directory, url } = yield* catalogWithSpec();
          const run = () => telipot(["catalog", "new", "widgetly", directory, "--openapi", url]);
          assert.strictEqual((yield* run()).exitCode, 0);
          const core = yield* fs.readFileString(`${directory}/providers/widgetly.yaml`);
          const lock = yield* fs.readFileString(`${directory}/ids.lock.json`);
          yield* fs.remove(`${directory}/providers/widgetly.extended.yaml`);
          const refused = yield* run();
          assert.notStrictEqual(refused.exitCode, 0);
          assert.include(refused.stderr, "has no history");
          assert.include(refused.stderr, "restore");
          assert.strictEqual(
            yield* fs.readFileString(`${directory}/providers/widgetly.yaml`),
            core,
          );

          assert.strictEqual(yield* fs.readFileString(`${directory}/ids.lock.json`), lock);
          assert.isFalse(yield* fs.exists(`${directory}/providers/widgetly.extended.yaml`));
        }),
      ),
  );

  it.effect("reads a spec that declares no security with the patch the provider keeps", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { directory, url } = yield* catalogWithSpec();
        const keyed = url.replace("/openapi.json", "/keyed.json");
        const run = () => telipot(["catalog", "new", "keyed", directory, "--openapi", keyed]);

        // Without a patch, the vendor's OpenAPI declares no security, so nothing is made.
        const bare = yield* run();
        assert.strictEqual(bare.exitCode, 0, bare.stderr);
        assert.include(bare.stdout, "the spec declares no security for it; a patch can declare it");
        yield* fs.remove(`${directory}/providers/keyed.yaml`);

        yield* fs.makeDirectory(`${directory}/patches`, { recursive: true });
        yield* fs.writeFileString(
          `${directory}/patches/keyed.json`,
          JSON.stringify([
            {
              op: "add",
              path: "/components/securitySchemes",
              value: { key: { type: "apiKey", in: "header", name: "x-keyed-api-key" } },
            },
            { op: "add", path: "/security", value: [{ key: [] }] },
          ]),
        );

        const made = yield* run();
        assert.strictEqual(made.exitCode, 0, made.stderr);
        assert.include(made.stdout, "with patches/keyed.json applied");
        assert.include(made.stdout, "POST /v1/clips/upload: its body is multipart");

        const core = parse(
          yield* fs.readFileString(`${directory}/providers/keyed.yaml`),
        ) as ProviderFile;

        assert.strictEqual(core.display_name, "Keyed");
        assert.strictEqual(core.auth.schemes.key?.name, "x-keyed-api-key");
        const extended = yield* fs.readFileString(`${directory}/providers/keyed.extended.yaml`);
        assert.include(extended, "auth: key");

        const file = parseDocument(yield* fs.readFileString(`${directory}/providers/keyed.yaml`));
        file.set("docs_url", "https://docs.keyed.example");
        file.setIn(["source", "docs"], "https://docs.keyed.example");
        yield* fs.writeFileString(`${directory}/providers/keyed.yaml`, String(file));
        const validated = yield* telipot(["catalog", "validate", directory]);
        assert.strictEqual(validated.exitCode, 0, validated.stderr);

        yield* fs.writeFileString(`${directory}/patches/keyed.json`, '[{ "op": "move" }]');
        const refused = yield* run();
        assert.notStrictEqual(refused.exitCode, 0);
        assert.include(refused.stderr, "patches/keyed.json is not a JSON Patch");
      }),
    ),
  );

  it.effect("refuses what it cannot use, naming why, and writes nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { directory, url } = yield* catalogWithSpec();
        const origin = url.replace("/openapi.json", "");
        const refused = Effect.fnUntraced(function* (args: ReadonlyArray<string>, why: string) {
          const { exitCode, stderr } = yield* telipot(["catalog", "new", ...args]);
          assert.notStrictEqual(exitCode, 0);
          assert.include(stderr, why);
        });

        yield* refused(["Widgetly", directory, "--openapi", url], "not a slug");
        yield* refused(
          ["widgetly", directory, "--openapi", `${origin}/missing`],
          "it answered 404",
        );

        yield* refused(
          ["widgetly", directory, "--openapi", `${origin}/docs`],
          "not an OpenAPI 3 document",
        );

        yield* refused(
          ["widgetly", directory, "--openapi", "http://127.0.0.1:9/openapi.json"],
          "cannot read",
        );

        yield* refused(
          ["widgetly", directory, "--openapi", "openapi.json"],
          "not an http or https address",
        );

        assert.isFalse(yield* fs.exists(`${directory}/providers/widgetly.yaml`));

        yield* refused(["acme", directory], "give --openapi to refresh");
      }),
    ),
  );
});

layer(BunServices.layer, { excludeTestServices: true })("telipot catalog build", (it) => {
  it.effect("writes a snapshot that loads the same catalog as the folder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const out = yield* fs.makeTempFileScoped({ suffix: ".json" });
      const { exitCode, stdout } = yield* telipot([
        "catalog",
        "build",
        catalogFixtures.clean,
        "--out",
        out,
      ]);

      assert.strictEqual(exitCode, 0);
      assert.match(stdout, /✓ \d+ files and \d+ publications in /);
      const snapshot = yield* Schema.decodeEffect(Schema.fromJsonString(Snapshot))(
        yield* fs.readFileString(out),
      );

      const fromSnapshot = yield* Effect.scoped(
        Effect.map(Layer.build(Catalog.fromSnapshot(snapshot)), (context) =>
          Context.get(context, Catalog).tasks.map(({ task }) => task.id),
        ),
      );

      const fromFolder = yield* Effect.scoped(
        Effect.map(Layer.build(Catalog.layer(catalogFixtures.clean)), (context) =>
          Context.get(context, Catalog).tasks.map(({ task }) => task.id),
        ),
      );

      assert.deepStrictEqual(fromSnapshot, fromFolder);
    }),
  );

  it.effect("refuses a folder that does not validate, and writes nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const folder = yield* fs.makeTempDirectoryScoped();
      const out = `${folder}/snapshot.json`;
      const { exitCode } = yield* telipot([
        "catalog",
        "build",
        catalogFixtures.refused,
        "--out",
        out,
      ]);

      assert.notStrictEqual(exitCode, 0);
      assert.isFalse(yield* fs.exists(out));
    }),
  );
});
