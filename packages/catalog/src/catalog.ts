import {
  Context,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Order,
  Path,
  Predicate,
  Result,
  Schema,
} from "effect";
import { parse } from "yaml";

import { extendedDigest } from "./extended";
import { firstLine } from "./input";
import { cheapestFirst } from "./price";
import {
  CatalogIssue,
  type Documents,
  type Entry,
  type ProviderFiles,
  type Served,
  issue,
  resolve,
  schemaIssues,
} from "./rules";
import {
  AliasesFile,
  CapabilitiesFile,
  ExtendedProvider,
  FxFile,
  IdsLock,
  Provider,
  type Principal,
  type ProviderHeader,
  QueriesFile,
} from "./schema";
import { type LiveFilters, type Search, type SearchOptions, checkSearch, keeps } from "./search";
import { type Snapshot, snapshotFileSystem, snapshotYaml } from "./snapshot";

export const formatIssue = ({ file, path, message }: CatalogIssue) =>
  `${file}${path === "" ? "" : ` ${path}`}: ${message}`;

export const formatIssues = (issues: ReadonlyArray<CatalogIssue>) =>
  issues.map(formatIssue).join("\n");

// aliases.yaml's issues wait until nothing else refuses the catalog.
export class CatalogInvalid extends Schema.TaggedError<CatalogInvalid>()("CatalogInvalid", {
  issues: Schema.Array(CatalogIssue),
}) {
  override get message() {
    return formatIssues(this.issues);
  }
}

export class Catalog extends Context.Service<
  Catalog,
  Served & {
    // Either tier, tombstoned or not.
    readonly get: (id: string) => Option.Option<Entry>;
    // Live tasks, cheapest first, in slug order between equal prices.
    readonly serving: (capability: string) => ReadonlyArray<Entry>;
    // Live tasks in catalog order, those the filters keep.
    readonly live: (filters?: LiveFilters) => ReadonlyArray<Entry>;
    readonly search: (query: string, options?: SearchOptions) => Search;
    // A provider with at least one task served.
    readonly provider: (slug: string) => Option.Option<ProviderHeader>;
    // Every provider with a task served, in catalog order.
    readonly providers: ReadonlyArray<ProviderHeader>;
    // The scopes a principal's live tasks on the provider require, in catalog order, but those
    // only actions require: what a connect session asks for when the caller names none.
    readonly connectScopes: (slug: string, principal: Principal) => ReadonlyArray<string>;
    // The principal's live tasks on the provider that these catalog scopes can run.
    readonly connectTasks: (
      slug: string,
      principal: Principal,
      scopes: ReadonlyArray<string>,
    ) => ReadonlyArray<Entry>;
  }
>()("@telipot/catalog/Catalog") {
  static readonly layer = (directory: string) => loadLayer(directory, parseFolderYaml);

  // The same loader over a snapshot's files instead of a folder, for a runtime with no
  // filesystem, such as a Worker. It needs no service.
  static readonly fromSnapshot = (snapshot: Snapshot) =>
    loadLayer(".", snapshotYaml(snapshot)).pipe(
      Layer.provide([
        Layer.succeed(FileSystem.FileSystem)(snapshotFileSystem(snapshot)),
        Path.layer,
      ]),
    );

  // The same rules as `layer`, but never fails on what it finds. `previousLock` also refuses an
  // id the lock dropped.
  static readonly validate = Effect.fnUntraced(function* (
    directory: string,
    previousLock?: IdsLock,
  ) {
    const { catalog, warnings } = yield* check(directory, { previousLock, measure: true });
    return Result.match(catalog, {
      onSuccess: ({ tasks }): Validation => ({ issues: [], warnings, tasks }),
      onFailure: (issues): Validation => ({ issues, warnings, tasks: [] }),
    });
  });
}

export interface Validation {
  readonly issues: ReadonlyArray<CatalogIssue>;
  readonly warnings: ReadonlyArray<CatalogIssue>;
  readonly tasks: ReadonlyArray<Entry>;
}

// A snapshot's build stores its YAML files as JSON, so it parses them differently from a folder.
type ParseYaml = (text: string, file: string) => unknown;
const parseFolderYaml: ParseYaml = (text) => parse(text);

const read = Effect.fnUntraced(function* (
  directory: string,
  measure: boolean,
  parseYaml: ParseYaml,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const issues: Array<CatalogIssue> = [];

  // Undefined once the file's issues are recorded.
  const decode = <A, I>(file: string, schema: Schema.Codec<A, I>, format: "yaml" | "json") =>
    fs.readFileString(path.join(directory, file)).pipe(
      Effect.mapError((error) => [issue(file, [], `cannot be read: ${error.message}`)]),
      Effect.flatMap((text) =>
        Effect.try({
          try: () => (format === "json" ? JSON.parse(text) : parseYaml(text, file)),
          // The first line of a YAML or JSON syntax error names the line and column.
          catch: (error) => [issue(file, [], firstLine(error))],
        }),
      ),
      Effect.flatMap((written) =>
        Schema.decodeUnknownEffect(schema)(written, {
          errors: "all",
          onExcessProperty: "error",
        }).pipe(
          Effect.mapError((error) => schemaIssues(file, error.issue)),
          Effect.map((record) => ({ file, written, record })),
        ),
      ),
      Effect.catch((refused) =>
        Effect.sync(() => {
          issues.push(...refused);
          return undefined;
        }),
      ),
    );

  const capabilities = yield* decode("capabilities.yaml", CapabilitiesFile, "yaml");
  const aliases = yield* decode("aliases.yaml", AliasesFile, "yaml");
  const fx = yield* decode("fx.yaml", FxFile, "yaml");
  const lock = yield* decode("ids.lock.json", IdsLock, "json");
  const queries =
    measure &&
    (yield* fs.exists(path.join(directory, "queries.yaml")).pipe(Effect.orElseSucceed(() => false)))
      ? yield* decode("queries.yaml", QueriesFile, "yaml")
      : undefined;

  const names = yield* fs.readDirectory(path.join(directory, "providers")).pipe(
    Effect.map((entries) => entries.filter((name) => name.endsWith(".yaml"))),
    Effect.catch((error) =>
      Effect.sync((): Array<string> => {
        issues.push(issue("providers", [], `cannot be read: ${error.message}`));
        return [];
      }),
    ),
  );
  const slugs = [...new Set(names.map((name) => name.replace(/(\.extended)?\.yaml$/, "")))].sort();
  const providers: Array<ProviderFiles> = [];
  for (const slug of slugs) {
    const hasCore = names.includes(`${slug}.yaml`);
    const hasExtended = names.includes(`${slug}.extended.yaml`);
    const core = hasCore ? yield* decode(`providers/${slug}.yaml`, Provider, "yaml") : undefined;
    const generated = hasExtended
      ? yield* decode(`providers/${slug}.extended.yaml`, ExtendedProvider, "yaml")
      : undefined;
    // A file that decoded is an extended file as written, so the cast holds.
    const extended = generated && {
      ...generated,
      contentDigest: yield* extendedDigest(generated.written as typeof ExtendedProvider.Encoded),
    };
    providers.push({
      slug,
      core,
      extended,
      unread:
        (hasCore && Predicate.isUndefined(core)) ||
        (hasExtended && Predicate.isUndefined(generated)),
    });
  }

  // A missing example is left out, for the rules to name.
  const named = providers
    .flatMap(({ core, extended }) => [
      ...(core?.record.endpoints ?? []),
      ...(extended?.record.endpoints ?? []),
    ])
    .flatMap((task) =>
      Predicate.isUndefined(task.example_response) ? [] : [task.example_response],
    );
  const examples = new Map<string, Option.Option<Schema.Json>>();
  for (const example of new Set(named)) {
    if (
      !(yield* fs.exists(path.join(directory, example)).pipe(Effect.orElseSucceed(() => false)))
    ) {
      continue;
    }
    const json = yield* decode(example, Schema.Json, "json");
    examples.set(example, Predicate.isUndefined(json) ? Option.none() : Option.some(json.record));
  }

  const documents: Documents = {
    capabilities: capabilities?.record,
    fx: fx?.record,
    lock: lock?.record,
    providers,
    examples,
  };
  return { documents, aliases: aliases?.record.aliases ?? {}, queries: queries?.record, issues };
});

// The sort is stable, so a file's issues keep the order they were found.
const byFile = (a: CatalogIssue, b: CatalogIssue) => a.file.localeCompare(b.file);

// The sort is stable, so equal prices keep the slug order `tasks` has.
const byPrice = Order.mapInput(cheapestFirst, (entry: Entry) => entry.price);

const serve = (
  served: Served,
  aliases: AliasesFile["aliases"],
  queries: QueriesFile | undefined,
): {
  readonly catalog: Result.Result<Catalog["Service"], ReadonlyArray<CatalogIssue>>;
  readonly warnings: ReadonlyArray<CatalogIssue>;
} => {
  const byId = new Map(served.tasks.map((entry) => [entry.task.id, entry]));
  const providers = new Map(served.tasks.map(({ provider }) => [provider.provider, provider]));
  const live = served.tasks.filter(({ tombstone }) => Predicate.isUndefined(tombstone));
  const liveByPrice = live.toSorted(byPrice);
  const connectable = (slug: string, principal: Principal) =>
    served.tasks.filter(
      ({ provider, access, tombstone }) =>
        provider.provider === slug &&
        Predicate.isUndefined(tombstone) &&
        access._tag === "Credentialed" &&
        access.principal === principal,
    );
  const { search, problems, warnings } = checkSearch({ ...served, aliases }, queries);
  const issues = problems.map(({ file, path, message }) => issue(file, path, message));
  return {
    catalog:
      issues.length > 0
        ? Result.fail(issues)
        : Result.succeed(
            Catalog.of({
              ...served,
              get: (id) => Option.fromUndefinedOr(byId.get(id)),
              serving: (capability) =>
                liveByPrice.filter(({ task }) => task.capability === capability),
              live: (filters = {}) => live.filter((entry) => keeps(entry, filters)),
              search,
              provider: (slug) => Option.fromUndefinedOr(providers.get(slug)),
              providers: [...providers.values()],
              connectScopes: (slug, principal) => [
                ...new Set(
                  connectable(slug, principal)
                    .filter(({ task }) => task.kind !== "action")
                    .flatMap(({ task }) => task.required_scopes ?? []),
                ),
              ],
              connectTasks: (slug, principal, scopes) =>
                connectable(slug, principal).filter(({ task }) =>
                  (task.required_scopes ?? []).every((scope) => scopes.includes(scope)),
                ),
            }),
          ),
    warnings: warnings.map(({ file, path, message }) => issue(file, path, message)),
  };
};

// Only CI hands over the previous lock and asks to measure the search.
const check = Effect.fnUntraced(function* (
  directory: string,
  {
    previousLock,
    measure,
    parseYaml = parseFolderYaml,
  }: { readonly previousLock?: IdsLock; readonly measure: boolean; readonly parseYaml?: ParseYaml },
) {
  const {
    documents,
    aliases,
    queries,
    issues: unread,
  } = yield* read(directory, measure, parseYaml);
  const { served, issues, warnings } = resolve(documents, {
    today: yield* DateTime.now,
    previousLock,
  });
  const refused = [...unread, ...issues];
  // aliases.yaml and queries.yaml are measured on the served tasks, so they wait for the rest.
  const built: ReturnType<typeof serve> =
    refused.length > 0
      ? { catalog: Result.fail(refused), warnings: [] }
      : serve(served, aliases, queries);
  return {
    catalog: Result.mapError(built.catalog, (all) => all.toSorted(byFile)),
    warnings: [...warnings, ...built.warnings].toSorted(byFile),
  };
});

const loadLayer = (directory: string, parseYaml: ParseYaml) =>
  Layer.effect(
    Catalog,
    check(directory, { measure: false, parseYaml }).pipe(
      Effect.flatMap(({ catalog }) =>
        Effect.fromResult(Result.mapError(catalog, (issues) => new CatalogInvalid({ issues }))),
      ),
    ),
  );
