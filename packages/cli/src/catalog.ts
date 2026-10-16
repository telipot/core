import { Catalog, CatalogInvalid, type CatalogIssue, IdsLock, formatIssue } from "@telipot/catalog";
import { Console, Effect, Option, Predicate } from "effect";
import { Argument, CliError, Command, Flag } from "effect/cli";

import { addedSince, findCredentials, formatFinding } from "./credentials";
import { drift } from "./drift";
import { rendering } from "./render";
import { scaffoldProvider } from "./scaffold";
import { writeSnapshot } from "./snapshot";
import { verifyProvider } from "./verify";

// `Command.run` prints a UserError under ERROR, indented, and exits 1.
const refuse = (cause: unknown, userMessage: string) =>
  new CliError.UserError({ cause, userMessage });

const indented = (issues: ReadonlyArray<CatalogIssue>) => issues.map(formatIssue).join("\n  ");

const directory = Argument.Directory("dir").pipe(
  Argument.withDescription("The catalog folder"),
  Argument.withDefault("catalog"),
);

const provider = Argument.String("provider").pipe(Argument.withDescription("The provider's slug"));

// The server's rules plus what only CI has: the previous lock and the `queries.yaml` measurement.
const validate = Command.make(
  "validate",
  {
    directory,
    // The library sees one commit, so CI hands it the lock at the merge base.
    previousLock: Flag.FileSchema("previous-lock", IdsLock, { format: "json" }).pipe(
      Flag.withDescription("ids.lock.json before the change; every id in it must stay locked"),
      Flag.optional,
    ),
  },
  Effect.fnUntraced(function* ({ directory, previousLock }) {
    const { ok, warnHeading } = yield* rendering;
    const { issues, warnings, tasks } = yield* Catalog.validate(
      directory,
      Option.getOrUndefined(previousLock),
    );

    if (warnings.length > 0) {
      yield* Console.error(`${warnHeading}\n  ${indented(warnings)}`);
    }

    if (issues.length > 0) {
      return yield* refuse(new CatalogInvalid({ issues }), indented(issues));
    }

    const core = tasks.filter(({ tier }) => tier === "core");
    const providers = new Set(core.map(({ provider }) => provider.provider));
    yield* Console.log(ok(`${providers.size} providers, ${core.length} tasks valid`));
  }),
).pipe(Command.withDescription("Check every file in the catalog folder"));

const verify = Command.make(
  "verify",
  {
    provider,
    directory,
    budget: Flag.Finite("budget").pipe(
      Flag.withDescription("Stop before a call whose list price would pass this many USD"),
      Flag.optional,
    ),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription("Print the queue and its list price; call nothing"),
      Flag.withDefault(false),
    ),
    again: Flag.Boolean("again").pipe(
      Flag.withDescription("Replay tasks that already passed, as after a fix to this tool"),
      Flag.withDefault(false),
    ),
    accountRate: Flag.Int("account-rate").pipe(
      Flag.withDescription("Calls per second to the provider's account"),
      Flag.withDefault(2),
    ),
    routeRate: Flag.Int("route-rate").pipe(
      Flag.withDescription("Calls per minute to one route"),
      Flag.withDefault(30),
    ),
  },
  Effect.fnUntraced(function* ({ budget, ...flags }) {
    const { progressPrinter, queue, summary } = yield* rendering;
    const print = progressPrinter();
    const report = yield* verifyProvider({
      ...flags,
      budget: Option.map(budget, (usd) => Math.round(usd * 1_000_000)).pipe(Option.getOrUndefined),
      progress: (event) => Console.log(print(event)),
    }).pipe(Effect.catchTag("VerifyRefused", (cause) => Effect.fail(refuse(cause, cause.message))));

    if (flags.dryRun) return yield* Console.log(queue(flags.provider, report));

    const gap = report.queue.length > 0 ? "\n" : "";
    yield* Console.log(`${gap}${summary(flags.provider, report)}`);
    if (report.failed.length > 0) {
      return yield* refuse(report, `${report.failed.length} tasks did not pass`);
    }

    if (Predicate.isNotUndefined(report.rateLimited)) {
      return yield* refuse(report, "the vendor rate-limited the run; run it again to resume");
    }
  }),
).pipe(Command.withDescription("Replay each task's test request against the vendor"));

const driftCommand = Command.make(
  "drift",
  {
    directory,
  },
  Effect.fnUntraced(function* ({ directory }) {
    const { ok } = yield* rendering;
    const found = yield* drift(directory).pipe(
      Effect.catchTag("CatalogInvalid", (cause) =>
        Effect.fail(refuse(cause, indented(cause.issues))),
      ),
    );

    if (found.length > 0) {
      return yield* refuse(found, found.map(({ message }) => message).join("\n  "));
    }

    yield* Console.log(ok("every route matches the spec its provider publishes"));
  }),
).pipe(Command.withDescription("Compare every route with its provider's public OpenAPI"));

const scan = Command.make(
  "scan",
  {
    base: Flag.String("base").pipe(
      Flag.withDescription("The commit the change started from, as the merge base"),
    ),
  },
  Effect.fnUntraced(function* ({ base }) {
    const { ok } = yield* rendering;
    const found = findCredentials(yield* addedSince(base));
    if (found.length > 0) {
      return yield* refuse(found, found.map(formatFinding).join("\n  "));
    }

    yield* Console.log(ok(`no credential in what changed since ${base}`));
  }),
).pipe(Command.withDescription("Refuse a change that adds a credential"));

const newProvider = Command.make(
  "new",
  {
    provider,
    directory,
    openapi: Flag.String("openapi").pipe(
      Flag.withDescription("The vendor's OpenAPI 3 document; with none, openapi is recorded null"),
      Flag.optional,
    ),
  },
  Effect.fnUntraced(function* ({ provider, directory, openapi }) {
    const { scaffolded } = yield* rendering;
    const report = yield* scaffoldProvider({
      provider,
      directory,
      openapi: Option.getOrUndefined(openapi),
    }).pipe(
      Effect.catchTag("ScaffoldRefused", (cause) => Effect.fail(refuse(cause, cause.message))),
    );

    yield* Console.log(scaffolded(provider, report));
  }),
).pipe(Command.withDescription("Scaffold a provider file from the vendor's OpenAPI document"));

// The catalog as one JSON file, for a runtime with no filesystem: the Workers and the site import
// it. It is built only from a folder that validates.
const build = Command.make(
  "build",
  {
    directory,
    out: Flag.String("out").pipe(
      Flag.withDescription("Where to write the snapshot; snapshot.json in the folder unless given"),
      Flag.optional,
    ),
  },
  Effect.fnUntraced(function* ({ directory, out }) {
    const { ok } = yield* rendering;
    const { issues } = yield* Catalog.validate(directory);
    if (issues.length > 0) {
      return yield* refuse(new CatalogInvalid({ issues }), indented(issues));
    }

    const at = Option.getOrElse(out, () => `${directory}/snapshot.json`);
    const snapshot = yield* writeSnapshot(directory, at);
    yield* Console.log(
      ok(
        `${Object.keys(snapshot.files).length} files and ${snapshot.publications.length} publications in ${at}`,
      ),
    );
  }),
).pipe(Command.withDescription("Write the catalog folder as one JSON snapshot"));

export const catalog = Command.make("catalog").pipe(
  Command.withDescription("Work on the catalog folder"),
  Command.withSubcommands([validate, verify, driftCommand, scan, newProvider, build]),
);
