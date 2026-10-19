import {
  Catalog,
  type Entry,
  type Replayed,
  type Settle,
  formatPath,
  outputCheck,
  quote,
  recordVerification,
  settle,
  defaultMaxBytes,
  meetsExpect,
  sendOnce,
} from "@telipot/catalog";
import { sentForms, valueAt } from "@telipot/catalog";
import {
  BigDecimal,
  Config,
  DateTime,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Order,
  Path,
  Predicate,
  Redacted,
  Result,
  Schema,
} from "effect";
import { slugVariable } from "@telipot/contract";
import { HttpClient } from "effect/http";
import { RateLimiter } from "effect/persistence";

import { capture, plain, scrub, shorten, unnamed, withoutSecrets } from "./capture";

// Raise after a fix to how a call is made or judged; tasks passed under an older one replay.
const verifier = 2;
const LogLine = Schema.Struct({ task: Schema.String, verifier: Schema.optionalKey(Schema.Finite) });

export interface VerifyOptions {
  readonly directory: string;
  readonly provider: string;
  readonly budget: number | undefined;
  readonly dryRun: boolean;
  readonly again: boolean;
  // Per second to the account; per minute to one route.
  readonly accountRate: number;
  readonly routeRate: number;
  readonly progress?: (event: Progress) => Effect.Effect<void>;
}

export type CostSource = "reported" | "listed" | "unknown" | "not_charged";

export type Progress =
  | {
      readonly kind: "queue";
      readonly provider: string;
      readonly queue: Report["queue"];
      // Tasks that take a queued task's answer, so their ids line up too.
      readonly followers: ReadonlyArray<string>;
    }
  | {
      readonly kind: "passed";
      readonly id: string;
      readonly waitedMs: number;
      // `micro` sums every call; undefined when any is unknown.
      readonly calls: number;
      readonly micro: number | undefined;
      // Of the last call.
      readonly source: CostSource;
    }
  | {
      readonly kind: "failed";
      readonly id: string;
      readonly message: string;
      readonly calls: number;
      readonly micro: number | undefined;
    }
  | { readonly kind: "skipped"; readonly id: string; readonly sibling: string };

class VerifyRefused extends Schema.TaggedError<VerifyRefused>()("VerifyRefused", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

interface Failure {
  readonly id: string;
  // 0 when the vendor never answered.
  readonly status: number;
  readonly message: string;
  readonly family: string;
}

export interface Report {
  readonly callable: number;
  readonly variable: string | undefined;
  // Cheapest first.
  readonly queue: ReadonlyArray<{ readonly id: string; readonly listMicroUsd: number | undefined }>;
  readonly passed: ReadonlyArray<string>;
  readonly failed: ReadonlyArray<Failure>;
  readonly skipped: ReadonlyArray<{ readonly id: string; readonly sibling: string }>;
  // Passed, with answer keys the `output` schema does not name.
  readonly undeclared: ReadonlyArray<{
    readonly id: string;
    readonly paths: ReadonlyArray<string>;
  }>;
  readonly spentMicroUsd: number;
  // Called, but nothing says what it cost.
  readonly unknownCost: ReadonlyArray<string>;
  readonly stoppedBefore:
    | { readonly id: string; readonly listMicroUsd: number; readonly leftMicroUsd: number }
    | undefined;
  // Not called under a budget, since no price bounds them.
  readonly unbounded: ReadonlyArray<string>;
  readonly rateLimited: string | undefined;
}

const credentialVariable = (provider: string) => `${slugVariable(provider)}_API_KEY`;

const messagePaths = [
  "error.message",
  "error",
  "message",
  "detail",
  "errors[0].details",
  "errors[0].message",
  "errors[0].detail",
];

const vendorMessage = (body: Schema.Json, secrets: ReadonlyArray<string>) => {
  const found = messagePaths
    .map((path) => valueAt(body, path))
    .find((value): value is string => Predicate.isString(value) && value !== "");

  const said = found ?? (Predicate.isString(body) ? body : JSON.stringify(body));
  return shorten(scrub(plain(said.split("\n")[0] ?? ""), secrets), 200);
};

interface Answer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Schema.Json;
  readonly waitedMs: number;
}

type Verdict =
  | {
      readonly ok: true;
      readonly status: number;
      readonly message: string;
      readonly example: Schema.Json;
      readonly undeclared: ReadonlyArray<string>;
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly message: string;
      readonly example: undefined;
      readonly undeclared: ReadonlyArray<string>;
    };

const requestKey = ({ task }: Entry) => JSON.stringify([task.method, task.path, task.test_request]);

const familyOf = ({ task, platform, provider }: Entry) =>
  task.domain ?? platform ?? provider.provider;

const flat = (entry: Entry) => {
  const { pathParams, queryParams, headers, body } = entry.task.test_request ?? {};
  return { ...pathParams, ...queryParams, ...headers, ...body };
};

// The price row the test request matches, not the ceiling; undefined without a USD figure.
const listPrice = (entry: Entry) => Option.getOrUndefined(quote(entry.price, flat(entry)));

// Unpriced last; equal prices keep the catalog's order.
const byPrice = Order.mapInput(Order.Number, (entry: Entry) => listPrice(entry) ?? Infinity);

// The loader already refused an `output` it cannot import.
const firstMismatch = (task: Entry["task"], body: Schema.Json) => {
  if (Predicate.isUndefined(task.output)) return undefined;
  const check = outputCheck(task.output);
  return Result.isSuccess(check) ? check.success(body)[0] : undefined;
};

const reportedCharge = (settling: Settle | undefined, answer: Answer): unknown => {
  if (settling?.type === "reported_charge") return valueAt(answer.body, settling.path);
  if (settling?.type === "usage") return Number(answer.headers[settling.header.toLowerCase()]);
  return undefined;
};

// Each pass is stamped before the next call, so an interrupted run resumes without paying twice.
export const verifyProvider = Effect.fnUntraced(
  function* (options: VerifyOptions) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const client = yield* HttpClient.HttpClient;

    const { issues, tasks } = yield* Catalog.validate(options.directory);
    if (issues.length > 0) {
      return yield* new VerifyRefused({
        message: `${options.directory} does not validate; run telipot catalog validate first`,
      });
    }

    const core = tasks.filter(
      ({ provider, tier, tombstone }) =>
        provider.provider === options.provider &&
        tier === "core" &&
        Predicate.isUndefined(tombstone),
    );

    if (core.length === 0) {
      return yield* new VerifyRefused({
        message: `${options.provider} has no core tasks in ${options.directory}`,
      });
    }

    // Tasks that send the same request share one call; the rest take the first's answer.
    const candidates = core
      .filter(({ task }) => Predicate.isNotUndefined(task.test_request))
      .toSorted(byPrice);

    const groups = new Map<string, Array<Entry>>();
    for (const entry of candidates) {
      groups.set(requestKey(entry), [...(groups.get(requestKey(entry)) ?? []), entry]);
    }

    const leaders = [...groups.values()].flatMap((group) => group.slice(0, 1));
    // A task with no log line counts as current, since the log stays on the machine it ran on.
    const logFile = path.join(options.directory, ".verify", `${options.provider}.jsonl`);
    const calledBy = new Map<string, number>();
    if (yield* fs.exists(logFile)) {
      const decode = Schema.decodeUnknownOption(Schema.fromJsonString(LogLine));
      for (const line of (yield* fs.readFileString(logFile)).split("\n")) {
        const logged = decode(line);
        if (Option.isSome(logged)) calledBy.set(logged.value.task, logged.value.verifier ?? 0);
      }
    }

    const outdated = ({ task }: Entry) => (calledBy.get(task.id) ?? verifier) !== verifier;
    const queue = leaders.filter(
      (entry) => options.again || entry.verification?.state !== "verified" || outdated(entry),
    );

    const planned = queue.map((entry) => ({ id: entry.task.id, listMicroUsd: listPrice(entry) }));
    const needsKey = queue.some(({ access }) => access._tag === "Credentialed");
    const variable = credentialVariable(options.provider);
    const empty: Report = {
      callable: leaders.length,
      variable: needsKey ? variable : undefined,
      queue: planned,
      passed: [],
      failed: [],
      skipped: [],
      undeclared: [],
      spentMicroUsd: 0,
      unknownCost: [],
      stoppedBefore: undefined,
      unbounded: [],
      rateLimited: undefined,
    };

    if (options.dryRun) return empty;

    const credential = needsKey
      ? yield* Config.Redacted(variable).pipe(
          Effect.map(Redacted.value),
          Effect.mapError(
            (cause) =>
              new VerifyRefused({
                message: `set ${variable} to a ${options.provider} credential`,
                cause,
              }),
          ),
        )
      : undefined;

    // Every encoding a queued task sends, so an echoed encoded header is scrubbed too.
    const secrets = Predicate.isUndefined(credential)
      ? []
      : [...new Set(queue.flatMap((entry) => sentForms(entry, credential)))];

    const limiter = yield* RateLimiter.RateLimiter;
    // The timeout sits under both limiters, so a limiter's wait is not the vendor's silence. The
    // account limiter retries a 429; one that outlasts it is the answer.
    const answering = HttpClient.transform(client, (effect) =>
      Effect.timeout(effect, "30 seconds"),
    );

    const limited = answering.pipe(
      HttpClient.withRateLimiter({
        limiter,
        window: "1 second",
        limit: options.accountRate,
        key: options.provider,
        times: 3,
      }),
      HttpClient.withRateLimiter({
        limiter,
        window: "1 minute",
        limit: options.routeRate,
        key: (request) => `${options.provider} ${request.method} ${request.url}`,
        times: 0,
      }),
    );

    const answers = path.join(path.dirname(logFile), options.provider);
    yield* fs.makeDirectory(answers, { recursive: true });

    const write = (entry: Entry, found: Replayed) =>
      recordVerification(options.directory, entry, found);

    // The gateway's own send, so a replay has the same byte limit and never follows a redirect.
    const sendBound = sendOnce(limited, defaultMaxBytes);
    const send = (entry: Entry) =>
      Effect.timed(sendBound({ entry, input: flat(entry), credential })).pipe(
        Effect.map(([waited, { status, headers, body }]): Answer => ({
          status,
          headers,
          body,
          waitedMs: Duration.toMillis(waited),
        })),
      );

    // The schema checks the body as it would be committed, not as it came.
    const judge = (entry: Entry, answer: Answer): Verdict => {
      const { task } = entry;
      const failure = (message: string): Verdict => ({
        ok: false,
        status: answer.status,
        message: `${answer.status}: ${message}`,
        example: undefined,
        undeclared: [],
      });

      if (answer.status < 200 || answer.status > 299) {
        return failure(vendorMessage(answer.body, secrets));
      }

      if (Predicate.isNotUndefined(task.expect) && !meetsExpect(entry, answer.body)) {
        return failure(`${task.expect.json_path} was not ${JSON.stringify(task.expect.equals)}`);
      }

      const captured = capture(answer.body, {
        secrets,
        masked: task.kind === "account",
        output: task.output,
      });

      if (Result.isFailure(captured)) return failure(captured.failure);
      const first = firstMismatch(task, captured.success);
      if (Predicate.isNotUndefined(first)) {
        const where = first.path.length === 0 ? "" : `${formatPath(first.path)}: `;
        return failure(`the response does not fit the output schema: ${where}${first.message}`);
      }

      return {
        ok: true,
        status: answer.status,
        message: "",
        example: captured.success,
        undeclared: unnamed(answer.body, task.output),
      };
    };

    const cost = (entry: Entry, answer: Answer, ok: boolean) => {
      const { price } = entry;
      if (price?.type === "per_success" && !ok) {
        return { micro: 0, source: "not_charged" } as const;
      }

      const reported = reportedCharge(price?.type === "free" ? undefined : price?.settle, answer);
      if (Predicate.isNumber(reported) && Number.isFinite(reported)) {
        const figure = BigDecimal.fromNumberUnsafe(reported);
        const micro = settle(price, figure);
        if (Option.isSome(micro)) return { micro: micro.value, source: "reported" } as const;
      }

      const listed = listPrice(entry);
      return Predicate.isNotUndefined(listed)
        ? ({ micro: listed, source: "listed" } as const)
        : ({ micro: undefined, source: "unknown" } as const);
    };

    const record = Effect.fnUntraced(function* (
      entry: Entry,
      answer: Answer,
      verdict: Verdict,
      charged: ReturnType<typeof cost>,
    ) {
      const when = DateTime.formatIso(yield* DateTime.now);
      const line = {
        task: entry.task.id,
        at: when,
        status: answer.status,
        ok: verdict.ok,
        waited_ms: answer.waitedMs,
        cost_usd_micro: charged.micro ?? null,
        cost_source: charged.source,
        verifier,
        ...(verdict.ok ? {} : { message: verdict.message }),
      };

      yield* fs.writeFileString(logFile, `${JSON.stringify(line)}\n`, { flag: "a" });
    });

    // Gitignored, never an example: a contributor reads keys `output` lacks without paying again.
    const keep = Effect.fnUntraced(function* (id: string, answer: Answer) {
      if (answer.status < 200 || answer.status > 299) return;
      const [file, text] = Predicate.isString(answer.body)
        ? [`${id}.txt`, answer.body]
        : [`${id}.json`, JSON.stringify(answer.body, null, 2)];

      yield* fs.writeFileString(path.join(answers, file), `${withoutSecrets(text, secrets)}\n`);
    });

    let spent = 0;
    const passed: Array<string> = [];
    const undeclared: Array<{ id: string; paths: ReadonlyArray<string> }> = [];
    const failed: Array<Failure> = [];
    const unknownCost: Array<string> = [];
    const unbounded: Array<string> = [];
    const outcomes = new Map<string, { readonly ok: boolean; readonly message: string }>();
    for (const entry of leaders) {
      if (entry.verification?.state === "verified") {
        outcomes.set(entry.task.id, { ok: true, message: "" });
      }
    }

    let stoppedBefore: Report["stoppedBefore"];
    let rateLimited: string | undefined;

    const withinBudget = (list: number | undefined) =>
      Predicate.isUndefined(options.budget) ||
      (Predicate.isNotUndefined(list) && spent + list <= options.budget);

    const tell = options.progress ?? (() => Effect.void);
    if (planned.length > 0) {
      const followers = queue.flatMap((leader) =>
        (groups.get(requestKey(leader)) ?? []).slice(1).map(({ task }) => task.id),
      );

      yield* tell({ kind: "queue", provider: options.provider, queue: planned, followers });
    }

    for (const entry of queue) {
      const id = entry.task.id;
      const list = listPrice(entry);
      if (Predicate.isNotUndefined(options.budget) && Predicate.isUndefined(list)) {
        unbounded.push(id);
        continue;
      }

      if (!withinBudget(list)) {
        stoppedBefore = {
          id,
          listMicroUsd: list ?? 0,
          leftMicroUsd: (options.budget ?? 0) - spent,
        };

        break;
      }

      // A failure is called again until two answers in a row agree, up to three calls.
      let last:
        | {
            readonly answer: Answer;
            readonly verdict: Verdict;
            readonly charged: ReturnType<typeof cost>;
          }
        | undefined;

      let before: Verdict | undefined;
      let calls = 0;
      let total: number | undefined = 0;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0 && !withinBudget(list)) break;
        const answer = yield* send(entry).pipe(
          Effect.catch((error) =>
            Effect.succeed<Answer>({
              status: 0,
              headers: {},
              body: `no response: ${
                error._tag === "AnswerTooLarge"
                  ? `the answer ran past ${error.limit} bytes`
                  : scrub(error.message, secrets)
              }`,
              waitedMs: 0,
            }),
          ),
        );

        if (answer.status === 429) {
          rateLimited = id;
          break;
        }

        const verdict: Verdict =
          answer.status === 0
            ? {
                ok: false,
                status: 0,
                message: Predicate.isString(answer.body) ? answer.body : "no response",
                example: undefined,
                undeclared: [],
              }
            : judge(entry, answer);

        const charged = cost(entry, answer, verdict.ok);
        yield* record(entry, answer, verdict, charged);
        yield* keep(id, answer);
        spent += charged.micro ?? 0;
        calls += 1;
        total =
          Predicate.isUndefined(total) || Predicate.isUndefined(charged.micro)
            ? undefined
            : total + charged.micro;

        if (Predicate.isUndefined(charged.micro) && !unknownCost.includes(id)) {
          unknownCost.push(id);
        }

        last = { answer, verdict, charged };
        if (verdict.ok) break;
        if (Predicate.isNotUndefined(before) && before.message === verdict.message) break;
        before = verdict;
      }

      // A 429 on the first call leaves the task as it was; else the last billed call is recorded.
      if (Predicate.isNotUndefined(last)) {
        const { verdict, answer, charged } = last;
        if (verdict.ok) {
          yield* write(entry, {
            state: "verified",
            date: DateTime.formatIsoDateUtc(yield* DateTime.now),
            example: verdict.example,
          });

          passed.push(id);
          if (verdict.undeclared.length > 0) undeclared.push({ id, paths: verdict.undeclared });
          yield* tell({
            kind: "passed",
            id,
            waitedMs: answer.waitedMs,
            calls,
            micro: total,
            source: charged.source,
          });
        } else {
          yield* write(entry, { state: "unverified", reason: verdict.message });
          failed.push({
            id,
            status: verdict.status,
            message: verdict.message,
            family: familyOf(entry),
          });

          yield* tell({ kind: "failed", id, message: verdict.message, calls, micro: total });
        }

        outcomes.set(id, { ok: verdict.ok, message: verdict.message });
      }

      if (Predicate.isNotUndefined(rateLimited)) break;
    }

    const skipped: Array<{ id: string; sibling: string }> = [];
    for (const group of groups.values()) {
      const [leader, ...followers] = group;
      const outcome = Predicate.isUndefined(leader) ? undefined : outcomes.get(leader.task.id);
      if (Predicate.isUndefined(leader) || Predicate.isUndefined(outcome)) continue;
      for (const follower of followers) {
        const id = follower.task.id;
        if (outcome.ok) {
          const reason = `same request as ${leader.task.id}, which passed`;
          if (
            follower.verification?.state !== "skipped" ||
            follower.verification.reason !== reason
          ) {
            yield* write(follower, { state: "skipped", reason });
          }

          skipped.push({ id, sibling: leader.task.id });
          if (queue.includes(leader)) yield* tell({ kind: "skipped", id, sibling: leader.task.id });
        } else if (queue.includes(leader)) {
          const message = `same request as ${leader.task.id}: ${outcome.message}`;
          yield* write(follower, { state: "unverified", reason: message });
          const status = failed.find((found) => found.id === leader.task.id)?.status ?? 0;
          failed.push({ id, status, message, family: familyOf(follower) });
          yield* tell({ kind: "failed", id, message, calls: 0, micro: 0 });
        }
      }
    }

    return {
      ...empty,
      passed,
      failed,
      skipped,
      undeclared,
      spentMicroUsd: spent,
      unknownCost,
      stoppedBefore,
      unbounded,
      rateLimited,
    } satisfies Report;
  },
  Effect.provide(Layer.provide(RateLimiter.layer, RateLimiter.layerStoreMemory)),
);
