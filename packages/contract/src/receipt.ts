import { Predicate, Schema, SchemaTransformation } from "effect";

import { CatalogId, FreeText } from "./free-text";

// The user id is the customer's own: case-sensitive and never parsed.
export const Principal = Schema.String.check(
  Schema.isPattern(/^(organization|user:[\x21-\x7e]{1,128})$/, {
    expected: "organization, or user: and an id of 1 to 128 printable ASCII characters",
  }),
).annotate({ identifier: "Principal" });

export const EndUserPrincipal = Principal.check(
  Schema.makeFilter((principal) => principal.startsWith("user:") || "an end user, user:<id>"),
);

// Tried in this order; `anonymous` is for a public task.
export const IdentityMode = Schema.Literals(["user", "organization", "platform", "anonymous"]);
export type IdentityMode = typeof IdentityMode.Type;

// `byoc` is the customer's own credential; `managed` is the platform credential.
export const CredentialSource = Schema.Literals(["none", "byoc", "managed"]);

// A decimal string, not a JSON number, so it stays exact.
export const Usd = Schema.String.check(
  Schema.isPattern(/^\d{1,12}(\.\d{1,12})?$/, { expected: "US dollars, such as 0.006" }),
);

// At least 8 characters: every echo is masked, and a shorter key would mask ordinary text. Visible
// ASCII: fetch quotes a header value it refuses into the span, and trims a space the mask seeks.
export const VendorCredential = Schema.RedactedFromValue(
  FreeText(8192).check(
    Schema.isMinLength(8),
    Schema.isPattern(/^[\x21-\x7E]+$/, { expected: "visible ASCII, with no spaces" }),
  ),
);

// A provider file's `version`: the date its reviewed fields last changed.
export const CatalogVersion = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/, { expected: "a catalog version, such as 2026-10-04" }),
).annotate({ identifier: "CatalogVersion" });

const Slugs = Schema.Array(CatalogId).check(Schema.isMaxLength(50));

const commaList = Schema.String.pipe(
  Schema.decodeTo(
    Slugs,
    SchemaTransformation.transform({
      decode: (text): ReadonlyArray<string> =>
        text
          .split(",")
          .map((item) => item.trim())
          .filter((item) => item !== ""),
      encode: (items) => items.join(","),
    }),
  ),
);

const booleanText = Schema.Literals(["true", "false"]).pipe(
  Schema.decodeTo(
    Schema.Boolean,
    SchemaTransformation.transform({
      decode: (text) => text === "true",
      encode: (value) => (value ? "true" : "false"),
    }),
  ),
);

// Headers carry text, so a list is comma-separated and a flag is `true` or `false`.
const bodyAndHeader = <Body extends Schema.Top, Header extends Schema.Top>(
  body: Body,
  header: Header,
) => ({ body, header });

const sameInBoth = <S extends Schema.Top>(schema: S) => bodyAndHeader(schema, schema);

const options = {
  principal: sameInBoth(Principal),
  connection: sameInBoth(FreeText(100)),
  account: sameInBoth(FreeText(320)),
  credential: sameInBoth(VendorCredential),
  max_cost: sameInBoth(Usd),
  fallback: sameInBoth(Schema.Literal("platform")),
  tag: sameInBoth(FreeText(200)),
  order: bodyAndHeader(Slugs, commaList),
  only: bodyAndHeader(Slugs, commaList),
  sort: sameInBoth(Schema.Literals(["cost", "latency", "reliability"])),
  zero_retention: bodyAndHeader(Schema.Boolean, booleanText),
  version: sameInBoth(CatalogVersion),
};

type Options = typeof options;

type Kebab<K extends string> = K extends `${infer Head}_${infer Tail}`
  ? `${Head}-${Kebab<Tail>}`
  : K;

export const telipotHeader = <K extends string>(field: K) =>
  `telipot-${field.replaceAll("_", "-")}` as `telipot-${Kebab<K>}`;

const names = Object.keys(options) as ReadonlyArray<keyof Options>;

// These fields also drive the SDK's options and the MCP tool's arguments.
export const ReceiptOptions = Schema.Struct(
  Object.fromEntries(names.map((name) => [name, Schema.optionalKey(options[name].body)])) as {
    readonly [K in keyof Options]: Schema.optionalKey<Options[K]["body"]>;
  },
).annotate({ identifier: "ReceiptOptions" });

export type ReceiptOptions = typeof ReceiptOptions.Type;

// A run names its connection by one of these, never both.
export const connectionOptions = ["connection", "account"] as const satisfies ReadonlyArray<
  keyof ReceiptOptions
>;

// For curl and clients that cannot change the body.
export const RunHeaders = Schema.Struct({
  ...(Object.fromEntries(
    names.map((name) => [telipotHeader(name), Schema.optionalKey(options[name].header)]),
  ) as {
    readonly [K in keyof Options as `telipot-${Kebab<K>}`]: Schema.optionalKey<
      Options[K]["header"]
    >;
  }),
  "idempotency-key": Schema.optionalKey(FreeText(255)),
});

export type RunHeaders = typeof RunHeaders.Type;

// The end user whose connections, beside the organization's, decide each task's `identity`.
export const PrincipalHeaders = Schema.Struct({
  [telipotHeader("principal")]: Schema.optionalKey(options.principal.header),
});

// The body's `receipt` wins over a header that names the same option.
export const optionsOf = (
  headers: RunHeaders,
  body: ReceiptOptions | undefined,
): ReceiptOptions => {
  const sent: Record<string, unknown> = {};
  for (const name of names) {
    const value = headers[telipotHeader(name)];
    if (Predicate.isNotUndefined(value)) sent[name] = value;
  }

  return { ...(sent as ReceiptOptions), ...body };
};

// Mirrored in `Telipot-*` response headers so a stream carries it too.
export const Receipt = Schema.Struct({
  call_id: Schema.String,
  task: Schema.String,
  identity: IdentityMode,
  principal: Schema.NullOr(Schema.String),
  connection: Schema.NullOr(Schema.String),
  account: Schema.NullOr(Schema.String),
  credential_source: CredentialSource,
  quoted_usd: Usd,
  charged_usd: Usd,
  latency_ms: Schema.Int,
}).annotate({ identifier: "Receipt" });

export type Receipt = typeof Receipt.Type;

export const receiptHeaders = (receipt: Receipt): Record<string, string> =>
  Object.fromEntries(
    Object.entries(receipt).flatMap(([field, value]) =>
      Predicate.isNull(value) ? [] : [[telipotHeader(field), String(value)]],
    ),
  );
