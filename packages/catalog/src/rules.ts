import { type DateTime, Option, Predicate, Result, Schema, SchemaIssue } from "effect";

import { isTwin } from "./extended";
import {
  type DecodeInput,
  type InputSchema,
  checkInput,
  inputDecoder,
  jsonSchemaDecoder,
  problemsIn,
} from "./input";
import { type Price, type Pricing, type Problem, checkPrice, checkRates, pricingOn } from "./price";
import {
  type AuthScheme,
  type CapabilitiesFile,
  type ExtendedProvider,
  type FxFile,
  type IdsLock,
  type OAuth2Scheme,
  Principal,
  type Probe,
  type Provider,
  type ProviderHeader,
  type Task,
  type Tier,
  credentialPlace,
  dottedWords,
  inputLocations,
  placeholdersOf,
  verificationStates,
} from "./schema";

// `resolve` runs on decoded files, so one broken rule never hides another in the same file.

// `file` is relative to the catalog directory.
export class CatalogIssue extends Schema.Class<CatalogIssue>("@telipot/catalog/CatalogIssue")({
  file: Schema.String,
  path: Schema.String,
  message: Schema.String,
}) {}

// `endpoints[0].input.queryParams["news.search"]`
export const formatPath = (path: ReadonlyArray<PropertyKey>) =>
  path
    .map((key, index) =>
      Predicate.isNumber(key)
        ? `[${key}]`
        : /^[A-Za-z_$][\w$]*$/.test(String(key))
          ? `${index === 0 ? "" : "."}${String(key)}`
          : `[${JSON.stringify(String(key))}]`,
    )
    .join("");

export const issue = (file: string, path: ReadonlyArray<PropertyKey>, message: string) =>
  new CatalogIssue({ file, path: formatPath(path), message });

export const schemaIssues = (file: string, refused: SchemaIssue.Issue) =>
  problemsIn(refused).map(({ path, message }) => issue(file, path, message));

// `file` is relative to the catalog directory.
interface Decoded<A> {
  readonly file: string;
  readonly record: A;
}

// A file that did not decode is undefined and makes the provider unread, so its
// locked ids are not held against it.
export interface ProviderFiles {
  readonly slug: string;
  readonly core: Decoded<Provider> | undefined;
  // `contentDigest` is the file as it reads now, to compare with the digest it records.
  readonly extended: (Decoded<ExtendedProvider> & { readonly contentDigest: string }) | undefined;
  readonly unread: boolean;
}

// An example that did not parse is none, its issue already recorded; a missing key is no file.
export interface Documents {
  readonly capabilities: CapabilitiesFile | undefined;
  readonly fx: FxFile | undefined;
  readonly lock: IdsLock | undefined;
  readonly providers: ReadonlyArray<ProviderFiles>;
  readonly examples: ReadonlyMap<string, Option.Option<Schema.Json>>;
}

export type Access =
  | { readonly _tag: "Public" }
  | { readonly _tag: "Credentialed"; readonly scheme: AuthScheme; readonly principal: Principal };

export type Verification =
  | { readonly state: "verified"; readonly date: string }
  | {
      readonly state: Exclude<(typeof verificationStates)[number], "verified">;
      readonly reason: string;
    };

export interface Tombstone {
  readonly status: "retired" | "broken";
  readonly note: string;
  readonly supersededBy: string | undefined;
}

// `platform` is the one written or its capability's first segment; `tombstone`
// is none while the task is live.
export interface Entry {
  readonly task: Task;
  readonly provider: ProviderHeader;
  readonly tier: Tier;
  readonly platform: string | undefined;
  readonly access: Access;
  readonly verification: Verification | undefined;
  readonly example: Schema.Json | undefined;
  readonly price: Price | undefined;
  readonly inputSchema: InputSchema;
  readonly decodeInput: DecodeInput;
  // No trailing slash; a call's address is this plus the task's `path`.
  readonly baseUrl: string;
  // The provider's own names for the scopes the task requires, in order.
  readonly vendorScopes: ReadonlyArray<string>;
  // Only `data` and `utility` tasks; only an idempotent call is retried.
  readonly idempotent: boolean;
  readonly tombstone: Tombstone | undefined;
}

// `capabilities` includes every provider's proposals. catalog.ts serves this
// only once no rule is broken.
export interface Served {
  readonly platforms: Readonly<Record<string, string>>;
  readonly capabilities: Readonly<Record<string, string>>;
  // Only tasks whose own rules passed, tombstones included, in provider order
  // with each provider's core tasks before its extended ones.
  readonly tasks: ReadonlyArray<Entry>;
}

const takesKey = (scheme: AuthScheme, principal: Principal) =>
  scheme.type !== "oauth2" && scheme.principals.includes(principal);

// The scheme a principal's pasted key is sent in: the probe's, or else the provider's only
// scheme that takes one from that principal.
export const keyScheme = (
  provider: ProviderHeader,
  principal: Principal,
): AuthScheme | undefined => {
  const schemes = provider.auth?.schemes ?? {};
  const named = provider.probe?.auth;
  if (Predicate.isNotUndefined(named)) {
    const scheme = Object.hasOwn(schemes, named) ? schemes[named] : undefined;
    return Predicate.isNotUndefined(scheme) && takesKey(scheme, principal) ? scheme : undefined;
  }
  const fitting = Object.values(schemes).filter((scheme) => takesKey(scheme, principal));
  return fitting.length === 1 ? fitting[0] : undefined;
};

// A scheme the provider's probe can send a pasted key in: the organization's, else an end
// user's. A key is probed in the scheme its own principal's key is sent in.
export const probeScheme = (provider: ProviderHeader): AuthScheme | undefined =>
  keyScheme(provider, "organization") ?? keyScheme(provider, "user");

// The provider's only OAuth scheme a principal connects through, or none when it has none or
// several.
export const oauthScheme = (
  provider: ProviderHeader,
  principal: Principal,
): OAuth2Scheme | undefined => {
  const fitting = Object.values(provider.auth?.schemes ?? {}).filter(
    (scheme): scheme is OAuth2Scheme =>
      scheme.type === "oauth2" && scheme.principals.includes(principal),
  );
  return fitting.length === 1 ? fitting[0] : undefined;
};

export const takesOwnApp = (provider: ProviderHeader) =>
  provider.oauth_app?.byo === true &&
  Principal.literals.some((principal) =>
    Predicate.isNotUndefined(oauthScheme(provider, principal)),
  );

export const probeUrl = (provider: ProviderHeader, probe: Probe) =>
  probe.url ?? `${provider.base_url.replace(/\/+$/, "")}${probe.path ?? ""}`;

const platformOf = (capability: string) => capability.split(".")[0] ?? capability;

// `any_account` acts as the organization unless the task names a principal.
const principalOf = (task: Pick<Task, "scope" | "principal">): Principal | undefined =>
  task.principal ?? (task.scope === "any_account" ? "organization" : undefined);

const needsInput = ({ path, input }: Pick<Task, "path" | "input">) =>
  placeholdersOf(path).length > 0 ||
  inputLocations.some((location) =>
    Object.values(input[location] ?? {}).some((field) => field.required === true),
  );

// The rules refuse a second, so a served task has one at most.
const verificationsOf = (task: Task): Array<Verification> =>
  verificationStates.flatMap((state) => {
    const value = task[state];
    if (Predicate.isUndefined(value)) return [];
    return [state === "verified" ? { state, date: value } : { state, reason: value }];
  });

const proof = <A>(
  problems: ReadonlyArray<Problem>,
  value: A,
): Result.Result<A, ReadonlyArray<Problem>> =>
  problems.length === 0 ? Result.succeed(value) : Result.fail(problems);

const problemsOf = <A>(result: Result.Result<A, ReadonlyArray<Problem>>) =>
  Result.isFailure(result) ? result.failure : [];

const checkCurated = (task: Task, tier: Tier): ReadonlyArray<Problem> =>
  tier === "core"
    ? (["capability", "platform", "output"] as const).flatMap((field) =>
        Predicate.isUndefined(task[field])
          ? [{ path: [field], message: "required in the core tier" }]
          : [],
      )
    : [];

const checkAccess = (
  task: Task,
  schemes: Readonly<Record<string, AuthScheme>> | undefined,
): Result.Result<Access, ReadonlyArray<Problem>> => {
  const problems: Array<Problem> = [];
  const report = (path: ReadonlyArray<PropertyKey>, message: string) => {
    problems.push({ path, message });
  };

  if (task.auth === "public") {
    if (Predicate.isNotUndefined(task.scope)) report(["scope"], "a public task has no scope");
    if (Predicate.isNotUndefined(task.required_scopes)) {
      report(["required_scopes"], "a public task has no scheme to take scopes from");
    }
  } else if (Predicate.isUndefined(task.scope)) {
    report(["scope"], "required unless auth is public");
  }

  if (task.scope === "own_account") {
    if (Predicate.isUndefined(task.principal))
      report(["principal"], "required when scope is own_account");
    if (Predicate.isNotUndefined(task.test_request)) {
      report(["test_request"], "an own_account task carries no test request");
    }
  }
  if (task.auth === "public") return proof(problems, { _tag: "Public" });

  const scheme =
    Predicate.isNotUndefined(schemes) && Object.hasOwn(schemes, task.auth)
      ? schemes[task.auth]
      : undefined;
  if (Predicate.isUndefined(scheme)) {
    report(["auth"], `${task.auth} is not a scheme in auth.schemes, nor public`);
    return Result.fail(problems);
  }

  // None only when a rule above already broke.
  const principal = principalOf(task);
  if (Predicate.isNotUndefined(principal) && !scheme.principals.includes(principal)) {
    report(
      ["principal"],
      `${principal} is not among the ${task.auth} scheme's principals, ${scheme.principals.join(", ")}`,
    );
  }

  // A caller's input in the credential's own place would replace or repeat it.
  const { location, name: placed } = credentialPlace(scheme);
  for (const name of Object.keys(task.input[location] ?? {})) {
    if (name.toLowerCase() === placed.toLowerCase()) {
      report(["input", location, name], `is where the ${task.auth} scheme places the credential`);
    }
  }

  if (scheme.type === "oauth2" && Predicate.isUndefined(task.required_scopes)) {
    report(["required_scopes"], "required for an OAuth task");
  }
  task.required_scopes?.forEach((scope, position) => {
    if (!(scheme.type === "oauth2" && Object.hasOwn(scheme.scopes, scope))) {
      report(
        ["required_scopes", position],
        `${scope} is not a key of the ${task.auth} scheme's scopes`,
      );
    }
  });
  return Predicate.isUndefined(principal)
    ? Result.fail(problems)
    : proof(problems, { _tag: "Credentialed", scheme, principal });
};

const checkPlatform = (
  task: Task,
  platforms: CapabilitiesFile["platforms"] | undefined,
): ReadonlyArray<Problem> => {
  if (Predicate.isUndefined(task.platform)) return [];
  if (Predicate.isNotUndefined(task.capability) && task.platform !== platformOf(task.capability)) {
    const message = `must equal ${platformOf(task.capability)}, the capability's first segment`;
    return [{ path: ["platform"], message }];
  }

  if (Predicate.isNotUndefined(platforms) && !Object.hasOwn(platforms, task.platform)) {
    return [
      { path: ["platform"], message: `${task.platform} is not in capabilities.yaml platforms` },
    ];
  }
  return [];
};

const checkCapability = (
  task: Task,
  taxonomy: CapabilitiesFile["capabilities"] | undefined,
  proposed: Readonly<Record<string, string>>,
): ReadonlyArray<Problem> =>
  Predicate.isNotUndefined(task.capability) &&
  Predicate.isNotUndefined(taxonomy) &&
  !Object.hasOwn(taxonomy, task.capability) &&
  !Object.hasOwn(proposed, task.capability)
    ? [
        {
          path: ["capability"],
          message: `${task.capability} is in neither capabilities.yaml nor proposed_capabilities`,
        },
      ]
    : [];

const checkTombstone = (
  task: Task,
): Result.Result<Tombstone | undefined, ReadonlyArray<Problem>> => {
  if (Predicate.isUndefined(task.status)) {
    const floating = (["status_note", "superseded_by"] as const).flatMap((field) =>
      Predicate.isUndefined(task[field])
        ? []
        : [{ path: [field], message: "needs a status, retired or broken" }],
    );
    return proof(floating, undefined);
  }
  if (Predicate.isUndefined(task.status_note)) {
    return Result.fail([{ path: ["status_note"], message: "required when a task has a status" }]);
  }
  return Result.succeed({
    status: task.status,
    note: task.status_note,
    supersededBy: task.superseded_by,
  });
};

const checkVerification = (
  task: Task,
): Result.Result<Verification | undefined, ReadonlyArray<Problem>> => {
  const [verification, ...others] = verificationsOf(task);
  const problems: Array<Problem> = others.map(({ state }) => ({
    path: [state],
    message: `a task carries one verification state, and has ${verification?.state}`,
  }));
  if (
    Predicate.isNotUndefined(task.verified) &&
    (Predicate.isUndefined(task.example_response) ||
      (Predicate.isUndefined(task.test_request) && task.scope !== "own_account"))
  ) {
    problems.push({
      path: ["verified"],
      message: "needs the test_request it replays and the example_response it captured",
    });
  }
  if (Predicate.isNotUndefined(task.untestable) && Predicate.isNotUndefined(task.test_request)) {
    problems.push({
      path: ["test_request"],
      message: "an untestable task carries no test request",
    });
  }
  return proof(problems, verification);
};

// Shared by the committed-example rule and `telipot catalog verify`'s captured response.
export const outputCheck = (
  output: NonNullable<Task["output"]>,
): Result.Result<(body: Schema.Json) => ReadonlyArray<Problem>, string> =>
  // Catalog files are reviewed, so their `pattern` keywords are applied.
  Result.map(jsonSchemaDecoder(output, { patterns: "apply" }), (decode) => (body) => {
    const decoded = decode(body);
    return Result.isFailure(decoded) ? problemsIn(decoded.failure) : [];
  });

// An unquoted comma in a YAML flow mapping, `description: A, B`, leaves a key `B` set to null,
// and the schema still imports.
const dataKeywords = new Set(["const", "default", "example", "examples", "enum"]);

const nullKeys = (node: unknown, path: ReadonlyArray<PropertyKey>): ReadonlyArray<Problem> => {
  if (Array.isArray(node)) return node.flatMap((item, index) => nullKeys(item, [...path, index]));
  if (!Predicate.isObject(node)) return [];
  return Object.entries(node).flatMap(([key, value]) => {
    if (dataKeywords.has(key)) return [];
    const at = [...path, key];
    return Predicate.isNull(value)
      ? [
          {
            path: at,
            message:
              "is null; an unquoted comma in a YAML flow mapping makes one, so quote the text",
          },
        ]
      : nullKeys(value, at);
  });
};

// A problem in the example is reported in the example's file.
const checkExample = (
  task: Task,
  examples: Documents["examples"],
): Result.Result<Schema.Json | undefined, ReadonlyArray<Problem>> => {
  const named = task.example_response;
  const example = Predicate.isUndefined(named) ? undefined : examples.get(named);
  const problems: Array<Problem> = [];
  if (Predicate.isNotUndefined(named) && Predicate.isUndefined(example)) {
    problems.push({ path: ["example_response"], message: `${named} does not exist` });
  }
  if (Predicate.isNotUndefined(task.output)) {
    problems.push(...nullKeys(task.output, ["output"]));
    const check = outputCheck(task.output);
    if (Result.isFailure(check)) {
      problems.push({ path: ["output"], message: check.failure });
    } else if (
      Predicate.isNotUndefined(named) &&
      Predicate.isNotUndefined(example) &&
      Option.isSome(example)
    ) {
      problems.push(...check.success(example.value).map((found) => ({ ...found, file: named })));
    }
  }
  return proof(
    problems,
    Predicate.isUndefined(example) ? undefined : Option.getOrUndefined(example),
  );
};

type Proved = Pick<
  Entry,
  | "access"
  | "verification"
  | "example"
  | "price"
  | "inputSchema"
  | "decodeInput"
  | "baseUrl"
  | "vendorScopes"
  | "idempotent"
  | "tombstone"
>;

const idempotentKinds: ReadonlyArray<Task["kind"]> = ["data", "utility"];

const vendorScopeOf = (access: Access, scope: string): string | undefined => {
  const scheme = access._tag === "Credentialed" ? access.scheme : undefined;
  if (scheme?.type !== "oauth2") return undefined;
  return Object.hasOwn(scheme.scopes, scope) ? scheme.scopes[scope] : undefined;
};

const vendorScopesOf = (task: Task, access: Access): ReadonlyArray<string> =>
  (task.required_scopes ?? []).flatMap((scope) => {
    const named = vendorScopeOf(access, scope);
    return Predicate.isUndefined(named) ? [] : [named];
  });

// `granted` is in the provider's words; the answer is in the catalog's.
export const scopesMissing = (
  { task, access }: Pick<Entry, "task" | "access">,
  granted: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  (task.required_scopes ?? []).filter((scope) => {
    const named = vendorScopeOf(access, scope);
    return Predicate.isUndefined(named) || !granted.includes(named);
  });

// `proved` is undefined when any rule found a problem.
const checkTask = (
  task: Task,
  tier: Tier,
  provider: ProviderHeader,
  documents: Documents,
  pricing: Pricing,
): {
  readonly problems: ReadonlyArray<Problem>;
  readonly warnings: ReadonlyArray<Problem>;
  readonly proved: Proved | undefined;
} => {
  const access = checkAccess(task, provider.auth?.schemes);
  const tombstone = checkTombstone(task);
  const verification = checkVerification(task);
  const example = checkExample(task, documents.examples);
  const inputSchema = checkInput(task);
  // Each field already decoded on its own, so the whole schema imports too.
  const decodeInput = Result.flatMap(inputSchema, (schema) =>
    Result.mapError(inputDecoder(schema, Object.keys(task.input.pathParams ?? {})), (message) => [
      { path: ["input"], message },
    ]),
  );
  const { price, warnings } = checkPrice(task, provider, pricing);

  const problems = [
    ...checkCurated(task, tier),
    ...problemsOf(access),
    ...checkPlatform(task, documents.capabilities?.platforms),
    ...checkCapability(
      task,
      documents.capabilities?.capabilities,
      provider.proposed_capabilities ?? {},
    ),
    ...problemsOf(tombstone),
    ...problemsOf(verification),
    ...problemsOf(example),
    ...problemsOf(inputSchema),
    ...(Result.isSuccess(inputSchema) ? problemsOf(decodeInput) : []),
    ...problemsOf(price),
  ];
  const proved = Result.all({
    access,
    verification,
    example,
    price,
    inputSchema,
    decodeInput,
    tombstone,
  });
  return {
    problems,
    warnings,
    proved:
      problems.length > 0
        ? undefined
        : Result.getOrUndefined(
            Result.map(proved, (found) => ({
              ...found,
              baseUrl: (task.base_url ?? provider.base_url).replace(/\/$/, ""),
              vendorScopes: vendorScopesOf(task, found.access),
              idempotent: idempotentKinds.includes(task.kind),
            })),
          ),
  };
};

// `previousLock` is the lock before the change; the files alone cannot show what it held.
export const resolve = (
  documents: Documents,
  { today, previousLock }: { readonly today: DateTime.DateTime; readonly previousLock?: IdsLock },
): {
  readonly served: Served;
  readonly issues: ReadonlyArray<CatalogIssue>;
  readonly warnings: ReadonlyArray<CatalogIssue>;
} => {
  const issues: Array<CatalogIssue> = [];
  const report = (file: string, path: ReadonlyArray<PropertyKey>, message: string) => {
    issues.push(issue(file, path, message));
  };
  const warnings: Array<CatalogIssue> = [];
  const warn = (file: string, path: ReadonlyArray<PropertyKey>, message: string) => {
    warnings.push(issue(file, path, message));
  };
  const pricing = pricingOn(today, documents.fx);
  for (const { path, message } of checkRates(pricing)) warn("fx.yaml", path, message);
  const platforms = documents.capabilities?.platforms;
  const taxonomy = documents.capabilities?.capabilities;

  for (const capability of Object.keys(taxonomy ?? {})) {
    if (Predicate.isNotUndefined(platforms) && !Object.hasOwn(platforms, platformOf(capability))) {
      report(
        "capabilities.yaml",
        ["capabilities", capability],
        `${platformOf(capability)} is not in platforms`,
      );
    }
  }

  // Twins included.
  const defined = new Map<
    string,
    { readonly file: string; readonly index: number; readonly task: Task; readonly serves: boolean }
  >();
  const entries: Array<Entry> = [];
  const proposals: Record<string, string> = {};

  for (const { slug, core, extended, unread } of documents.providers) {
    for (const named of [core, extended]) {
      if (Predicate.isNotUndefined(named) && named.record.provider !== slug) {
        report(named.file, ["provider"], `must equal the file name, ${slug}`);
      }
    }

    if (Predicate.isNotUndefined(extended) && extended.contentDigest !== extended.record.digest) {
      report(
        extended.file,
        ["digest"],
        "does not match the file, which is generated and never edited by hand",
      );
    }

    // A core file that did not decode has its own issues to fix first.
    if (Predicate.isUndefined(core)) {
      if (Predicate.isNotUndefined(extended) && !unread) {
        report(extended.file, ["provider"], `has no core file, providers/${slug}.yaml`);
      }
      continue;
    }
    const header = core.record;
    const { endpoints: _, ...provider } = header;
    // The first provider to propose a capability describes it.
    for (const [capability, description] of Object.entries(header.proposed_capabilities ?? {})) {
      if (!Object.hasOwn(proposals, capability)) proposals[capability] = description;
    }

    const files = [
      { file: core.file, tier: "core" as const, tasks: header.endpoints },
      ...(Predicate.isUndefined(extended)
        ? []
        : [{ file: extended.file, tier: "extended" as const, tasks: extended.record.endpoints }]),
    ];
    const serving: Array<Task> = [];
    for (const { file, tier, tasks } of files) {
      for (const [index, task] of tasks.entries()) {
        const at = (...path: ReadonlyArray<PropertyKey>) => ["endpoints", index, ...path];
        // Core wins over a live extended twin; a tombstone still answers by id.
        const serves =
          tier === "core" || Predicate.isNotUndefined(task.status) || !isTwin(header, task);

        if (!task.id.startsWith(`${slug}.`)) {
          report(file, at("id"), `must start with ${slug}.`);
        } else if (!dottedWords.test(task.id)) {
          report(file, at("id"), "must be lowercase words joined by dots");
        }
        const first = defined.get(task.id);
        if (Predicate.isUndefined(first)) defined.set(task.id, { file, index, task, serves });
        else report(file, at("id"), `${task.id} is already a task in ${first.file}`);

        const found = checkTask(task, tier, provider, documents, pricing);
        for (const { file: elsewhere, path, message } of found.problems) {
          if (Predicate.isUndefined(elsewhere)) report(file, at(...path), message);
          else report(elsewhere, path, message);
        }
        for (const { path, message } of found.warnings) warn(file, at(...path), message);
        if (!serves) continue;
        serving.push(task);

        if (Predicate.isNotUndefined(found.proved)) {
          const platform =
            task.platform ??
            (Predicate.isUndefined(task.capability) ? undefined : platformOf(task.capability));
          entries.push({ task, provider, tier, platform, ...found.proved });
        }
      }
    }

    // The identity task names the account a connection belongs to.
    const identity = header.identity;
    if (Predicate.isUndefined(identity)) {
      if (serving.some((task) => task.scope === "own_account")) {
        report(core.file, ["identity"], "required when any task is own_account");
      }
    } else {
      const task = serving.find(({ id }) => id === identity.task);
      if (Predicate.isUndefined(task)) {
        report(core.file, ["identity", "task"], `${identity.task} is not a task of ${slug}`);
      } else if (needsInput(task)) {
        report(
          core.file,
          ["identity", "task"],
          `${identity.task} needs input, and the connect flow calls it with none`,
        );
      }
    }

    // A connection keeps one secret, which a principal's key tasks would send as a key and its
    // OAuth tasks would read as tokens, so a principal connects one way or the other.
    const schemes = Object.values(header.auth?.schemes ?? {});
    const mixed = Principal.literals.filter(
      (principal) =>
        schemes.some(
          (scheme) => scheme.type === "oauth2" && scheme.principals.includes(principal),
        ) &&
        schemes.some((scheme) => scheme.type !== "oauth2" && scheme.principals.includes(principal)),
    );
    if (mixed.length > 0) {
      report(
        core.file,
        ["auth", "schemes"],
        `give ${mixed.join(" and ")} both a key and OAuth; a principal connects one way`,
      );
    }

    // A principal's pasted key is checked in the scheme it is sent in, so a probe that names a
    // scheme must take the key of every principal that pastes one.
    const named = header.probe?.auth;
    if (Predicate.isNotUndefined(named) && Predicate.isNotUndefined(probeScheme(header))) {
      for (const principal of Principal.literals) {
        if (!schemes.some((scheme) => takesKey(scheme, principal))) continue;
        if (Predicate.isUndefined(keyScheme(header, principal))) {
          const whose = principal === "user" ? "an end user's" : "an organization's";
          report(core.file, ["probe", "auth"], `${named} does not take ${whose} key`);
        }
      }
    }

    if (Predicate.isNotUndefined(header.probe) && Predicate.isUndefined(probeScheme(header))) {
      report(
        core.file,
        Predicate.isUndefined(header.probe.auth) ? ["probe"] : ["probe", "auth"],
        Predicate.isUndefined(header.probe.auth)
          ? "needs auth to name the scheme the key is sent in, unless exactly one scheme takes an organization's key, or an end user's"
          : `${header.probe.auth} is not a scheme in auth.schemes that takes a key`,
      );
    }
  }

  // A tombstone points only at another served task with no status; a dropped twin is not served.
  for (const [id, { file, index, task }] of defined) {
    if (Predicate.isUndefined(task.superseded_by)) continue;
    const successor = defined.get(task.superseded_by);
    if (
      task.superseded_by === id ||
      Predicate.isUndefined(successor) ||
      !successor.serves ||
      Predicate.isNotUndefined(successor.task.status)
    ) {
      report(
        file,
        ["endpoints", index, "superseded_by"],
        `${task.superseded_by} is not another live task`,
      );
    }
  }

  // An unread provider cannot answer for its locked ids until its files decode.
  const lock = documents.lock;
  if (Predicate.isNotUndefined(lock)) {
    const locked = new Set(lock);
    for (const [id, { file, index }] of defined) {
      if (!locked.has(id))
        report(file, ["endpoints", index, "id"], `${id} is not in ids.lock.json`);
    }
    const unread = new Set(
      documents.providers.flatMap(({ slug, unread }) => (unread ? [slug] : [])),
    );
    lock.forEach((id, index) => {
      if (!defined.has(id) && !unread.has(id.split(".")[0] ?? id)) {
        report("ids.lock.json", [index], `${id} has no task; tombstone it with status instead`);
      }
    });

    // The lock only grows, which catches an id renamed in both its file and the lock.
    for (const id of previousLock ?? []) {
      if (!locked.has(id)) {
        report(
          "ids.lock.json",
          [],
          `${id} was in the previous lock; put it back and keep its task, tombstoned with status`,
        );
      }
    }
  }

  // The taxonomy's description wins over a proposal of the same capability.
  const capabilities = { ...proposals, ...taxonomy };

  return { served: { platforms: platforms ?? {}, capabilities, tasks: entries }, issues, warnings };
};
