import { BigDecimal, Effect, Predicate, Result, Schema, SchemaTransformation } from "effect";

// Shape only; rules across fields, tasks or files live in rules.ts, and price rules in price.ts.
// A pattern carries the `u` flag, or Effect leaves it out of the editor's JSON Schema (json-schema.ts).

// A date such as 2026-10-04; `@telipot/contract` holds a copy as `CatalogVersion`, kept equal by a test.
export const IsoDate = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u));
const Url = Schema.String.check(Schema.isPattern(/^https?:\/\//u));
const Slug = Schema.String.check(Schema.isPattern(/^[a-z0-9]+(-[a-z0-9]+)*$/u));
// Capability and task ids, so either is safe in a URL and as a file name.
export const dottedWords = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/u;
const CapabilityId = Schema.String.check(Schema.isPattern(dottedWords));
const Reason = Schema.NonEmptyString;
// No deeper than `examples/`, so neither the loader nor `telipot catalog verify` reaches past it.
export const ExamplePath = Schema.String.check(
  Schema.isPattern(/^examples\/[A-Za-z0-9._-]+\.json$/u),
);

const isPattern = Schema.makeFilter<string>(
  (source) => Result.isSuccess(Result.try(() => new RegExp(source))),
  { expected: "a regular expression" },
);

const JsonObject = Schema.Record(Schema.String, Schema.Json);

export const Principal = Schema.Literals(["organization", "user"]);
export type Principal = typeof Principal.Type;

const Principals = Schema.NonEmptyArray(Principal);
export class ApiKeyScheme extends Schema.Class<ApiKeyScheme>("@telipot/catalog/ApiKeyScheme")({
  type: Schema.Literal("api_key"),
  in: Schema.Literals(["header", "query", "basic"]),
  name: Schema.String,
  principals: Principals,
}) {}

export class OAuth2Scheme extends Schema.Class<OAuth2Scheme>("@telipot/catalog/OAuth2Scheme")({
  type: Schema.Literal("oauth2"),
  authorization_url: Url,
  token_url: Url,
  revocation_url: Schema.optionalKey(Url),
  // Added to the consent address, for a provider that needs more than RFC 6749 asks to issue a
  // refresh token, such as Google's `access_type: offline`. The flow's own parameters win.
  authorization_params: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  pkce: Schema.Boolean,
  refresh: Schema.Literals(["static", "rotating"]),
  token_type: Schema.optionalKey(Schema.String),
  principals: Principals,
  // Scope key -> the provider's scope string. Tasks name the keys.
  scopes: Schema.Record(Schema.String, Schema.String),
}) {}

export class HttpScheme extends Schema.Class<HttpScheme>("@telipot/catalog/HttpScheme")({
  type: Schema.Literals(["basic", "bearer"]),
  principals: Principals,
}) {}

// The types are OpenAPI's security scheme types in snake case.
export const AuthScheme = Schema.Union([ApiKeyScheme, OAuth2Scheme, HttpScheme]);
export type AuthScheme = typeof AuthScheme.Type;

// Where a scheme sends the credential: the executor places it there, and no task input may.
export const credentialPlace = (
  scheme:
    | Pick<ApiKeyScheme, "type" | "in" | "name">
    | { readonly type: Exclude<AuthScheme["type"], "api_key"> },
): { readonly location: "headers" | "queryParams"; readonly name: string } => {
  if (scheme.type !== "api_key" || scheme.in === "basic") {
    return { location: "headers", name: "Authorization" };
  }

  return { location: scheme.in === "query" ? "queryParams" : "headers", name: scheme.name };
};

// Decoded to an exact decimal so no floating-point figure reaches a price.
// Positive: free is written `type: free`, never as a zero amount.
const Amount = Schema.Finite.pipe(
  Schema.decodeTo(
    Schema.BigDecimal.check(Schema.isGreaterThanBigDecimal(BigDecimal.fromBigInt(0n))),
    SchemaTransformation.transform({
      decode: BigDecimal.fromNumberUnsafe,
      encode: BigDecimal.toNumberUnsafe,
    }),
  ),
);

// Declared so no provider needs settlement code. A reported figure is in the cost's
// currency, never a count of rows or results.
export const Settle = Schema.Union([
  Schema.Struct({ type: Schema.Literal("quote") }),
  Schema.Struct({ type: Schema.Literal("reported_charge"), path: Schema.NonEmptyString }),
  Schema.Struct({ type: Schema.Literal("usage"), header: Schema.NonEmptyString }),
]);

export type Settle = typeof Settle.Type;

export const Confidence = Schema.Literals(["verified", "documented", "inferred", "unknown"]);
export type Confidence = typeof Confidence.Type;
// A price the provider published, so its source is cited.
export const published: ReadonlyArray<Confidence> = ["verified", "documented"];

// `value` `currency` per `per` `unit`, such as 2.00 USD per 1,000 rows. A `table` row
// matches request fields; `fallback` is the ceiling.
const paid = {
  value: Schema.optionalKey(Amount),
  table: Schema.optionalKey(
    Schema.NonEmptyArray(
      Schema.Struct({
        // Keys such as `body.model`, each with the value it must hold.
        when: Schema.Record(
          Schema.String,
          Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]),
        ),
        value: Amount,
        // A numeric input field the row's value is multiplied by.
        times: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  fallback: Schema.optionalKey(Schema.Struct({ value: Amount })),
  // ISO 4217, `credit` for the provider's credits, or `meter` for the meter `unit` names.
  currency: Schema.String.check(Schema.isPattern(/^([A-Z]{3}|credit|meter)$/u)),
  per: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(1)),
  ),
  unit: Schema.optionalKey(Schema.NonEmptyString),
  source: Schema.optionalKey(Schema.NonEmptyString),
  source_url: Schema.optionalKey(Url),
  // When the price was confirmed, not when the route was called.
  checked: IsoDate,
  // Grades the price only; a task's `verified` grades the route.
  confidence: Confidence,
  note: Schema.optionalKey(Schema.NonEmptyString),
  settle: Schema.optionalKey(Settle),
};

const paidRules = Schema.makeFilter<{
  readonly value?: unknown;
  readonly table?: unknown;
  readonly fallback?: unknown;
  readonly confidence: Confidence;
  readonly note?: string;
  readonly source_url?: string;
}>((cost) => {
  const issues: Array<{ readonly path: ReadonlyArray<PropertyKey>; readonly issue: string }> = [];
  const refuse = (field: string, issue: string) => issues.push({ path: [field], issue });
  const has = (field: "value" | "table" | "fallback") => Object.hasOwn(cost, field);
  if (has("value") && has("table")) refuse("table", "a price is a value or a table, not both");
  if (has("table") && !has("fallback")) {
    refuse("fallback", "required with a table, as the ceiling a reserve holds");
  }

  if (!has("table") && has("fallback")) refuse("fallback", "only a table has a fallback");
  if (cost.confidence === "unknown") {
    for (const field of ["value", "table"] as const) {
      if (has(field)) refuse(field, "absent when confidence is unknown");
    }

    if (!Object.hasOwn(cost, "note")) refuse("note", "says why the price is unknown");
  } else if (!has("value") && !has("table")) {
    refuse("value", "required unless confidence is unknown or a table prices the task");
  }

  if (published.includes(cost.confidence) && !Object.hasOwn(cost, "source_url")) {
    refuse("source_url", `required when confidence is ${cost.confidence}`);
  }

  return issues;
});

// A task with no cost is unpriced, never free. One class per type so a decoding
// error names the fields of the type the file wrote.
export class FreeCost extends Schema.Class<FreeCost>("@telipot/catalog/FreeCost")({
  type: Schema.Literal("free"),
}) {}

export class PerCallCost extends Schema.Class<PerCallCost>("@telipot/catalog/PerCallCost")(
  Schema.Struct({ type: Schema.Literal("per_call"), ...paid }).check(paidRules),
) {}

export class PerSuccessCost extends Schema.Class<PerSuccessCost>("@telipot/catalog/PerSuccessCost")(
  Schema.Struct({ type: Schema.Literal("per_success"), ...paid }).check(paidRules),
) {}

export class PerResultCost extends Schema.Class<PerResultCost>("@telipot/catalog/PerResultCost")(
  Schema.Struct({ type: Schema.Literal("per_result"), ...paid }).check(paidRules),
) {}

export const Cost = Schema.Union([FreeCost, PerCallCost, PerSuccessCost, PerResultCost]);
export type Cost = typeof Cost.Type;

export const fieldTypes = ["string", "integer", "number", "boolean", "array", "object"] as const;

const InputField = Schema.Struct({
  type: Schema.Literals(fieldTypes),
  required: Schema.optionalKey(Schema.Boolean),
  example: Schema.optionalKey(Schema.Json),
  note: Schema.optionalKey(Schema.String),
  enum: Schema.optionalKey(Schema.NonEmptyArray(Schema.Json)),
  const: Schema.optionalKey(Schema.Json),
  min: Schema.optionalKey(Schema.Finite),
  max: Schema.optionalKey(Schema.Finite),
  default: Schema.optionalKey(Schema.Json),
});

const InputFields = Schema.Record(Schema.String, InputField);

const Input = Schema.Struct({
  pathParams: Schema.optionalKey(InputFields),
  queryParams: Schema.optionalKey(InputFields),
  headers: Schema.optionalKey(InputFields),
  body: Schema.optionalKey(InputFields),
  bodyType: Schema.optionalKey(Schema.Literals(["json", "form"])),
});

export type Input = typeof Input.Type;
export type InputField = typeof InputField.Type;

// A run's options travel under this body key, so no input field may use it.
export const reservedInput = "receipt";

// In the order a call binds them.
export const inputLocations = [
  "pathParams",
  "queryParams",
  "headers",
  "body",
] as const satisfies ReadonlyArray<keyof Input>;

export const taskMethods = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

const placeholder = /\{([^}]*)\}/g;
export const placeholdersOf = (path: string) =>
  [...path.matchAll(placeholder)].map(([, name = ""]) => name);

// So routes that differ only in placeholder names compare equal.
export const blankPlaceholders = (path: string) => path.replace(placeholder, "{}");
export const fillPlaceholders = (path: string, valueOf: (name: string) => string) =>
  path.replace(placeholder, (_, name: string) => valueOf(name));

// How a call writes a value into its path, query or headers: a string as it is, else as JSON.
export const asText = (value: Schema.Json) =>
  Predicate.isString(value) ? value : JSON.stringify(value);

// The path a call is sent to, each placeholder holding its value encoded.
export const filledPath = (path: string, values: Readonly<Record<string, Schema.Json>>) =>
  fillPlaceholders(path, (name) =>
    encodeURIComponent(asText((Object.hasOwn(values, name) ? values[name] : undefined) ?? "")),
  );

// A URL resolves a `.` or `..` segment away, `%2e` spelling a dot too, so `/repos/{owner}` given
// `..` reaches `/`, a route the catalog does not describe, price or scope. `encodeURIComponent`
// keeps dots as they are, so each segment is checked as it is sent. Answers the placeholders of
// every segment that would be only dots.
export const offRoute = (path: string, values: Readonly<Record<string, Schema.Json>>) =>
  path.split("/").flatMap((segment) => {
    const names = placeholdersOf(segment);
    return names.length > 0 && /^(?:\.|%2e)+$/i.test(filledPath(segment, values)) ? names : [];
  });

export const offRouteMessage = "cannot make a path segment of only dots";

const TestRequest = Schema.Struct({
  pathParams: Schema.optionalKey(JsonObject),
  queryParams: Schema.optionalKey(JsonObject),
  headers: Schema.optionalKey(JsonObject),
  body: Schema.optionalKey(JsonObject),
});

export const taskKinds = ["data", "action", "account", "utility"] as const;

export class Task extends Schema.Class<Task>("@telipot/catalog/Task")({
  id: Schema.String,
  capability: Schema.optionalKey(CapabilityId),
  platform: Schema.optionalKey(Schema.String),
  domain: Schema.optionalKey(Schema.String),
  kind: Schema.Literals(taskKinds).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("data" as const)),
  ),
  // A scheme name from the provider header, or `public`.
  auth: Schema.String,
  scope: Schema.optionalKey(Schema.Literals(["any_account", "own_account"])),
  principal: Schema.optionalKey(Principal),
  required_scopes: Schema.optionalKey(Schema.Array(Schema.String)),
  method: Schema.Literals(taskMethods),
  path: Schema.String.check(Schema.isStartingWith("/")),
  // One product on several hosts, such as Google Analytics, stays one provider and one connection.
  base_url: Schema.optionalKey(Url),
  // Our search title: the job, the input the caller holds, the top outputs.
  name: Schema.String.check(Schema.isMaxLength(60)),
  // The provider's own text, verbatim.
  summary: Schema.String,
  input: Input,
  test_request: Schema.optionalKey(TestRequest),
  // For providers that answer 200 on failure.
  expect: Schema.optionalKey(Schema.Struct({ json_path: Schema.String, equals: Schema.Json })),
  cost: Schema.optionalKey(Cost),
  async: Schema.optionalKey(JsonObject),
  // The vendor's "no result" answer, so it reads as a miss and not a fault.
  miss: Schema.optionalKey(
    Schema.Struct({
      status: Schema.Int.check(Schema.isBetween({ minimum: 400, maximum: 499 })),
      means: Reason,
    }),
  ),
  resource_ownership: Schema.optionalKey(JsonObject),
  // At most one of these four is set.
  verified: Schema.optionalKey(IsoDate),
  unverified: Schema.optionalKey(Reason),
  untestable: Schema.optionalKey(Reason),
  skipped: Schema.optionalKey(Reason),
  example_response: Schema.optionalKey(ExamplePath),
  docs_url: Schema.optionalKey(Url),
  // JSON Schema 2020-12 of the vendor body.
  output: Schema.optionalKey(JsonObject),
  status: Schema.optionalKey(Schema.Literals(["retired", "broken"])),
  status_note: Schema.optionalKey(Reason),
  superseded_by: Schema.optionalKey(Schema.String),
}) {}

export const verificationStates = [
  "verified",
  "unverified",
  "untestable",
  "skipped",
] as const satisfies ReadonlyArray<keyof Task>;

const Source = Schema.Struct({
  docs: Url,
  // One document for each host the tasks use.
  openapi: Schema.NullOr(Schema.Union([Url, Schema.NonEmptyArray(Url)])),
  curated: IsoDate,
});

// What a probe's answer shows: a status, a value at `json_path`, or a body matching `body_pattern`.
const ProbeAnswer = Schema.Struct({
  status: Schema.optionalKey(Schema.Int),
  json_path: Schema.optionalKey(Schema.String),
  equals: Schema.optionalKey(Schema.Json),
  body_pattern: Schema.optionalKey(Schema.String.check(isPattern)),
}).check(
  Schema.makeFilter(
    (answer) =>
      Object.hasOwn(answer, "json_path") === Object.hasOwn(answer, "equals") ||
      "json_path and equals go together",
  ),
  Schema.makeFilter(
    (answer) => Object.keys(answer).length > 0 || "names a status, a json_path or a body_pattern",
  ),
);

export type ProbeAnswer = typeof ProbeAnswer.Type;

// A free request that checks a pasted key before it is saved, on `path` under the
// provider's base URL or at `url`. Never a paid route.
export const Probe = Schema.Struct({
  path: Schema.optionalKey(Schema.String.check(Schema.isStartingWith("/"))),
  url: Schema.optionalKey(Url),
  method: Schema.Literals(["GET", "POST"]).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("GET" as const)),
  ),
  // A scheme of `auth.schemes`; unset, the provider's one scheme an organization's key fits, or
  // else an end user's.
  auth: Schema.optionalKey(Schema.String),
  expect: ProbeAnswer,
  // For a provider that answers 200 to a bad key; every task's answer is checked against it too.
  reject: Schema.optionalKey(ProbeAnswer),
}).check(
  Schema.makeFilter(
    (probe) =>
      Object.hasOwn(probe, "path") !== Object.hasOwn(probe, "url") ||
      "names a path or a url, not both",
  ),
);

export type Probe = typeof Probe.Type;

// `providers/<provider>.yaml`, curated by a person.
export class Provider extends Schema.Class<Provider>("@telipot/catalog/Provider")({
  provider: Slug,
  display_name: Schema.String,
  base_url: Url,
  docs_url: Url,
  source: Source,
  // A date stamp, bumped on any change to a reviewed field.
  version: IsoDate,
  auth: Schema.optionalKey(Schema.Struct({ schemes: Schema.Record(Schema.String, AuthScheme) })),
  identity: Schema.optionalKey(
    Schema.Struct({ task: Schema.String, account_path: Schema.String, label_path: Schema.String }),
  ),
  probe: Schema.optionalKey(Probe),
  oauth_app: Schema.optionalKey(Schema.Struct({ byo: Schema.Boolean })),
  // `normalized` ignores placeholder names; `exact` is for APIs where the placeholder is
  // the route, such as a graph whose first segment is the node id.
  route_match: Schema.Literals(["normalized", "exact"]).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("normalized" as const)),
  ),
  retention: Schema.Literals(["zero", "standard"]).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("standard" as const)),
  ),
  limits: Schema.optionalKey(Schema.String),
  pricing_url: Schema.optionalKey(Url),
  async: Schema.optionalKey(JsonObject),
  // Nango's retry descriptor. `after` is a seconds header, `at` an epoch-seconds one; a status in
  // `error_code` (default 429 and 5xx) or a body matching `in_body` retries, unless the wait passes `max_wait`.
  retry: Schema.optionalKey(
    Schema.Struct({
      after: Schema.optionalKey(Schema.String),
      at: Schema.optionalKey(Schema.String),
      in_body: Schema.optionalKey(Schema.String.check(isPattern)),
      error_code: Schema.optionalKey(Schema.Array(Schema.Int)),
      max_wait: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
    }),
  ),
  terms: Schema.optionalKey(Schema.Struct({ url: Url, note: Schema.String })),
  proposed_capabilities: Schema.optionalKey(Schema.Record(CapabilityId, Schema.String)),
  endpoints: Schema.Array(Task),
}) {}

export type ProviderHeader = Omit<Provider, "endpoints">;

// `core` is curated by a person, `extended` generated from the spec; a search ranks them in
// this order.
export const tiers = ["core", "extended"] as const;
export type Tier = (typeof tiers)[number];

// Never edited by hand: `digest` covers every field but the reviewed ones, so any other edit is refused.
export class ExtendedProvider extends Schema.Class<ExtendedProvider>(
  "@telipot/catalog/ExtendedProvider",
)({
  provider: Slug,
  source: Source,
  version: IsoDate,
  digest: Schema.String,
  endpoints: Schema.Array(Task),
}) {}

// Platform slug -> label, and capability id -> description.
export const CapabilitiesFile = Schema.Struct({
  platforms: Schema.Record(Slug, Schema.String),
  capabilities: Schema.Record(CapabilityId, Schema.String),
});

export type CapabilitiesFile = typeof CapabilitiesFile.Type;

// Query word -> catalog word. Nouns only: a verb alias floods its matches.
export const AliasesFile = Schema.Struct({
  aliases: Schema.Record(Schema.String, Schema.String),
});

export type AliasesFile = typeof AliasesFile.Type;

export const QueriesFile = Schema.Struct({
  mean_reciprocal_rank_at_least: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  queries: Schema.NonEmptyArray(
    Schema.Struct({ task: Schema.NonEmptyString, finds: Schema.String }),
  ),
});

export type QueriesFile = typeof QueriesFile.Type;

// `usd: null`: the provider publishes no USD price, so show the native price, never a guess.
const rate = <S extends Schema.Top>(usd: S) =>
  Schema.Struct({ usd, basis: Schema.NonEmptyString, source: Url, checked: IsoDate });

// Credits are keyed by provider, since one provider's credit is worth nothing at another's.
export const FxFile = Schema.Struct({
  rates_to_usd: Schema.Record(Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/u)), rate(Amount)),
  credit_rates_usd: Schema.Record(Slug, rate(Schema.NullOr(Amount))),
  meter_rates_usd: Schema.Record(Slug, Schema.Record(Schema.String, rate(Schema.NullOr(Amount)))),
});

export type FxFile = typeof FxFile.Type;

// Every task id ever published.
export const IdsLock = Schema.Array(Schema.String);
export type IdsLock = typeof IdsLock.Type;
