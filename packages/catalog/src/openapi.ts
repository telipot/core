import { JsonPatch, JsonPointer, Order, Predicate, Record, Result, Schema } from "effect";
import { Document, parse } from "yaml";
import { type Curated, curatedBy } from "./extended";
import { bounds, firstLine } from "./input";
import {
  ApiKeyScheme,
  type AuthScheme,
  type InputField,
  type Task,
  credentialPlace,
  fieldTypes,
  inputLocations,
  placeholdersOf,
  taskMethods,
} from "./schema";

// Reads only what the OpenAPI spec defines; a patch adds what a vendor's document leaves out.

type EncodedTask = typeof Task.Encoded;
type Location = (typeof inputLocations)[number];

// `place` is where the credential goes, so a parameter there is not caller input. An OAuth
// task acts as the organization unless its scheme's `principals` leave the organization out.
interface SchemeFacts {
  readonly type: AuthScheme["type"];
  readonly place?: ReturnType<typeof credentialPlace>;
  readonly principals?: ReadonlyArray<string>;
}

export type Schemes = Readonly<Record<string, SchemeFacts>>;

// A scheme as a provider file writes it, which a scaffold may leave unfinished.
export interface WrittenScheme {
  readonly type: AuthScheme["type"];
  readonly in?: string;
  readonly name?: string | null;
  readonly principals?: ReadonlyArray<string>;
}

const isKeyPlace = Schema.is(ApiKeyScheme.fields.in);

const placeOf = ({ type, in: at, name }: WrittenScheme) => {
  if (type !== "api_key") return credentialPlace({ type });
  return isKeyPlace(at) && Predicate.isString(name)
    ? credentialPlace({ type, in: at, name })
    : undefined;
};

export const schemesOf = (written: Readonly<Record<string, WrittenScheme>>): Schemes =>
  Record.map(written, (scheme) => {
    const place = placeOf(scheme);
    return {
      type: scheme.type,
      ...(Predicate.isUndefined(place) ? {} : { place }),
      ...(Predicate.isUndefined(scheme.principals) ? {} : { principals: scheme.principals }),
    };
  });

// A scaffold field a person must check or write before `validate` passes.
export interface Review {
  readonly path: string;
  readonly note: string;
}

export interface Scaffold {
  readonly text: string;
  readonly reviews: ReadonlyArray<Review>;
  readonly schemes: Schemes;
}

// `catalog/patches/<provider>.json`: a JSON Patch (RFC 6902) adding what the vendor's
// document should have said, such as its security or the Links between operations.
export const SpecPatch = Schema.Array(
  Schema.Union([
    Schema.Struct({
      op: Schema.Literal("add"),
      path: Schema.String,
      value: Schema.Json,
      description: Schema.optionalKey(Schema.String),
    }),
    Schema.Struct({
      op: Schema.Literal("remove"),
      path: Schema.String,
      description: Schema.optionalKey(Schema.String),
    }),
    Schema.Struct({
      op: Schema.Literal("replace"),
      path: Schema.String,
      value: Schema.Json,
      description: Schema.optionalKey(Schema.String),
    }),
  ]),
);

export type SpecPatch = typeof SpecPatch.Type;

const Requirement = Schema.Record(Schema.String, Schema.Array(Schema.String));

export const Server = Schema.Struct({
  url: Schema.String,
  variables: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Struct({ default: Schema.String })),
  ),
});

const Spec = Schema.Struct({
  openapi: Schema.String.check(Schema.isPattern(/^3\./)),
  info: Schema.Struct({ title: Schema.String }),
  externalDocs: Schema.optionalKey(Schema.Struct({ url: Schema.String })),
  servers: Schema.optionalKey(Schema.Array(Server)),
  security: Schema.optionalKey(Schema.Array(Requirement)),
  components: Schema.optionalKey(
    Schema.Struct({
      securitySchemes: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
  paths: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});

// `root` is the patched document that a `$ref` points into.
export interface OpenApi {
  readonly url: string;
  readonly spec: typeof Spec.Type;
  readonly root: unknown;
}

export const readOpenApi = (
  text: string,
  url: string,
  patch: SpecPatch = [],
): Result.Result<OpenApi, string> =>
  patched(text, patch).pipe(Result.flatMap((root) => openApiAt(root, url)));

// The YAML parser reads JSON too.
export const patched = (text: string, patch: SpecPatch): Result.Result<Schema.Json, string> =>
  Result.try({
    try: () => parse(text) as Schema.Json,
    catch: (error) => `it is not YAML or JSON: ${firstLine(error)}`,
  }).pipe(
    Result.flatMap((written) =>
      Result.try({
        try: () => JsonPatch.apply(patch, written),
        catch: (error) => `the patch does not apply: ${firstLine(error)}`,
      }),
    ),
  );

export const openApiAt = (root: Schema.Json, url: string): Result.Result<OpenApi, string> =>
  Schema.decodeUnknownResult(Spec)(root).pipe(
    Result.map((spec) => ({ url, spec, root })),
    Result.mapError(() => "it is not an OpenAPI 3 document"),
  );

const SecurityScheme = Schema.Struct({
  type: Schema.String,
  in: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  scheme: Schema.optionalKey(Schema.String),
  flows: Schema.optionalKey(
    Schema.Struct({
      authorizationCode: Schema.optionalKey(
        Schema.Struct({
          authorizationUrl: Schema.String,
          tokenUrl: Schema.String,
          scopes: Schema.Record(Schema.String, Schema.String),
        }),
      ),
    }),
  ),
});

const Parameter = Schema.Struct({
  name: Schema.String,
  in: Schema.String,
  required: Schema.optionalKey(Schema.Boolean),
  deprecated: Schema.optionalKey(Schema.Boolean),
  description: Schema.optionalKey(Schema.String),
  schema: Schema.optionalKey(Schema.Unknown),
  content: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Struct({ schema: Schema.optionalKey(Schema.Unknown) })),
  ),
  example: Schema.optionalKey(Schema.Json),
  examples: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});

const Operation = Schema.Struct({
  operationId: Schema.optionalKey(Schema.String),
  summary: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  deprecated: Schema.optionalKey(Schema.Boolean),
  externalDocs: Schema.optionalKey(Schema.Struct({ url: Schema.String })),
  parameters: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  requestBody: Schema.optionalKey(Schema.Unknown),
  responses: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  security: Schema.optionalKey(Schema.Array(Requirement)),
  servers: Schema.optionalKey(Schema.Array(Server)),
});

const PathItem = Schema.Struct({
  summary: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  parameters: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  servers: Schema.optionalKey(Schema.Array(Server)),
  additionalOperations: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});

const Link = Schema.Struct({
  operationId: Schema.optionalKey(Schema.String),
  operationRef: Schema.optionalKey(Schema.String),
  parameters: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});

const SchemaNode = Schema.Struct({
  type: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  enum: Schema.optionalKey(Schema.NonEmptyArray(Schema.Json)),
  default: Schema.optionalKey(Schema.Json),
  example: Schema.optionalKey(Schema.Json),
  examples: Schema.optionalKey(Schema.Array(Schema.Json)),
  description: Schema.optionalKey(Schema.String),
  minimum: Schema.optionalKey(Schema.Finite),
  maximum: Schema.optionalKey(Schema.Finite),
  minLength: Schema.optionalKey(Schema.Finite),
  maxLength: Schema.optionalKey(Schema.Finite),
  minItems: Schema.optionalKey(Schema.Finite),
  maxItems: Schema.optionalKey(Schema.Finite),
  properties: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  required: Schema.optionalKey(Schema.Array(Schema.String)),
  items: Schema.optionalKey(Schema.Unknown),
  allOf: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  oneOf: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  anyOf: Schema.optionalKey(Schema.Array(Schema.Unknown)),
});

type Node = typeof SchemaNode.Type;

const decoded =
  <S extends Schema.Decoder<unknown>>(schema: S) =>
  (value: unknown) =>
    Result.getOrUndefined(Schema.decodeUnknownResult(schema)(value));

const asScheme = decoded(SecurityScheme);
const asParameter = decoded(Parameter);
const asOperation = decoded(Operation);
const asPathItem = decoded(PathItem);
const asLink = decoded(Link);
const asNode = decoded(SchemaNode);

const pointAt = (root: unknown, fragment: string) =>
  JsonPointer.parseUriFragment(fragment)?.reduce<unknown>(
    (at, key) => (Predicate.isObject(at) && Object.hasOwn(at, key) ? at[key] : undefined),
    root,
  );

const isReference = (node: unknown): node is { readonly $ref: string } =>
  Predicate.isObject(node) && Predicate.isString(node.$ref);

// A reference to another document, to nothing, or in a circle gives undefined.
const deref = (root: unknown, node: unknown): unknown => {
  let current = node;
  for (let hops = 0; hops < 8; hops++) {
    if (!isReference(current)) return current;
    current = pointAt(root, current.$ref);
  }

  return undefined;
};

const unresolved = (root: unknown, node: unknown) =>
  isReference(node) && Predicate.isUndefined(deref(root, node))
    ? `it refers to ${node.$ref}, which is not in this document`
    : undefined;

const isHttp = (url: string) => /^https?:\/\//.test(url);

const titleOf = (slug: string) =>
  slug
    .split("-")
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(" ");

const isNullType = (node: Node) =>
  Array.isArray(node.type) ? node.type.every((type) => type === "null") : node.type === "null";

// OpenAPI 3.1 writes an optional string as `anyOf: [string, null]`, so a shapeless node
// takes its first non-null member's shape; the node's own keywords win.
const nodeOf = (root: unknown, schema: unknown, depth = 0): Node | undefined => {
  const node = asNode(deref(root, schema));
  if (Predicate.isUndefined(node) || depth > 4) return node;
  const shaped = [node.type, node.properties, node.items, node.enum].some(Predicate.isNotUndefined);
  if (shaped) return node;
  for (const member of [...(node.allOf ?? []), ...(node.oneOf ?? []), ...(node.anyOf ?? [])]) {
    const inner = nodeOf(root, member, depth + 1);
    if (Predicate.isNotUndefined(inner) && !isNullType(inner)) return { ...inner, ...node };
  }

  return node;
};

const typeOf = (node: Node | undefined): InputField["type"] => {
  if (Predicate.isUndefined(node)) return "string";
  const declared = Predicate.isString(node.type)
    ? node.type
    : node.type?.find((type) => type !== "null");

  const known = fieldTypes.find((type) => type === declared);
  if (Predicate.isNotUndefined(known)) return known;
  if (Predicate.isNotUndefined(node.properties)) return "object";
  return Predicate.isNotUndefined(node.items) ? "array" : "string";
};

const trimmed = (text: string | undefined) => {
  const value = text?.trim();
  return Predicate.isUndefined(value) || value === "" ? undefined : value;
};

const fieldOf = (
  root: unknown,
  schema: unknown,
  extra: { readonly required: boolean; readonly example?: Schema.Json; readonly note?: string },
): InputField => {
  const node = nodeOf(root, schema);
  const type = typeOf(node);
  const [min, max] = bounds[type] ?? [];
  return {
    type,
    ...Record.filter(
      {
        required: extra.required ? true : undefined,
        example: extra.example ?? node?.example ?? node?.examples?.[0],
        note: trimmed(extra.note) ?? trimmed(node?.description),
        enum: node?.enum,
        default: Predicate.isNull(node?.default) ? undefined : node?.default,
        min: Predicate.isUndefined(min) ? undefined : node?.[min],
        max: Predicate.isUndefined(max) ? undefined : node?.[max],
      },
      Predicate.isNotUndefined,
    ),
  };
};

// An Example Object holds its data in `dataValue` or, in older documents, `value`.
const exampleOf = (root: unknown, parameter: typeof Parameter.Type) => {
  if (Predicate.isNotUndefined(parameter.example)) return parameter.example;
  for (const named of Object.values(parameter.examples ?? {})) {
    const example = deref(root, named);
    if (!Predicate.isObject(example)) continue;
    for (const key of ["dataValue", "value"]) {
      if (!Object.hasOwn(example, key)) continue;
      const value = Result.getOrUndefined(Schema.decodeUnknownResult(Schema.Json)(example[key]));
      if (Predicate.isNotUndefined(value)) return value;
    }
  }

  return undefined;
};

const parameterSchema = (parameter: typeof Parameter.Type) =>
  parameter.schema ?? Object.values(parameter.content ?? {})[0]?.schema;

const locationOf: Readonly<Record<string, Location>> = {
  path: "pathParams",
  query: "queryParams",
  header: "headers",
};

// Headers OpenAPI says a parameter definition SHALL ignore.
const ignoredHeaders = ["accept", "content-type", "authorization"];

const shorten = (text: string, length: number) => {
  if (text.length <= length) return text;
  const cut = text.slice(0, length);
  const space = cut.lastIndexOf(" ");
  return (space > length / 2 ? cut.slice(0, space) : cut).trimEnd();
};

// `listWidgets` -> `list-widgets`; `GET /widgets/{widgetId}` -> `get-widgets-widget-id`.
const slugOf = (text: string) =>
  text
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

// In OpenAPI's order; a Path Item's `additionalOperations` holds any other method.
const fixedMethods = ["get", "put", "post", "delete", "options", "head", "patch", "trace", "query"];

interface Candidate {
  readonly method: string;
  readonly path: string;
  readonly operation: typeof Operation.Type;
  readonly parameters: ReadonlyArray<unknown>;
  readonly servers: ReadonlyArray<typeof Server.Type> | undefined;
  readonly item: typeof PathItem.Type;
}

const route = ({ method, path }: Pick<Candidate, "method" | "path">) => `${method} ${path}`;

export const operationsOf = ({ spec, root }: OpenApi): ReadonlyArray<Candidate> =>
  Object.entries(spec.paths ?? {})
    .toSorted(Order.mapInput(Order.String, ([path]: readonly [string, unknown]) => path))
    .flatMap(([path, written]) => {
      const raw = deref(root, written);
      const item = asPathItem(raw);
      if (!Predicate.isObject(raw) || Predicate.isUndefined(item)) return [];
      const key = (value: unknown) => {
        const parameter = asParameter(deref(root, value));
        return `${parameter?.in}:${parameter?.name}`;
      };

      const operations = [
        ...fixedMethods.map((method) => [method.toUpperCase(), raw[method]] as const),
        ...Object.entries(item.additionalOperations ?? {}),
      ];

      return operations.flatMap(([method, value]) => {
        const operation = asOperation(deref(root, value));
        if (Predicate.isUndefined(value) || Predicate.isUndefined(operation)) return [];
        // An operation's own parameter replaces the path's of the same name and place.
        const own = new Set((operation.parameters ?? []).map(key));
        const shared = (item.parameters ?? []).filter((one) => !own.has(key(one)));
        return [
          {
            method,
            path,
            operation,
            parameters: [...shared, ...(operation.parameters ?? [])],
            servers: operation.servers ?? item.servers,
            item,
          },
        ];
      });
    });

export const routesOf = (openapi: OpenApi) =>
  operationsOf(openapi).map(({ method, path, operation }) => ({
    method,
    path,
    deprecated: operation.deprecated === true,
  }));

// Guesses what the document does not say, and is `null` where it cannot.
type Declared = WrittenScheme & { readonly [field: string]: unknown };

const declare = (scheme: NonNullable<ReturnType<typeof asScheme>>): Declared | undefined => {
  if (scheme.type === "apiKey" && (scheme.in === "header" || scheme.in === "query")) {
    return {
      type: "api_key",
      in: scheme.in,
      name: scheme.name ?? null,
      principals: ["organization"],
    };
  }

  // An HTTP authentication scheme's name is not case-sensitive.
  const flavour = scheme.scheme?.toLowerCase();
  if (scheme.type === "http" && (flavour === "basic" || flavour === "bearer")) {
    return { type: flavour, principals: ["organization"] };
  }

  const flow = scheme.flows?.authorizationCode;
  if (scheme.type === "oauth2" && Predicate.isNotUndefined(flow)) {
    return {
      type: "oauth2",
      authorization_url: flow.authorizationUrl,
      token_url: flow.tokenUrl,
      pkce: true,
      refresh: "static",
      principals: ["organization", "user"],
      scopes: Object.fromEntries(Object.keys(flow.scopes).map((scope) => [scope, scope])),
    };
  }

  return undefined;
};

// A connection keeps one secret, and the catalog refuses a principal that connects both ways,
// so where the vendor also takes an organization's key, its OAuth is for users.
const declaredSchemes = ({ spec, root }: OpenApi): Readonly<Record<string, Declared>> => {
  const declared = Object.fromEntries(
    Object.entries(spec.components?.securitySchemes ?? {}).flatMap(([name, value]) => {
      const scheme = asScheme(deref(root, value));
      const one = Predicate.isUndefined(scheme) ? undefined : declare(scheme);
      return Predicate.isUndefined(one) ? [] : [[name, one] as const];
    }),
  );

  if (!Object.values(declared).some(({ type }) => type !== "oauth2")) return declared;
  return Record.map(declared, (one) =>
    one.type === "oauth2" ? { ...one, principals: ["user"] } : one,
  );
};

// OpenAPI: an operation's `security` replaces the document's, and `[]` or `{}` needs no credential.
// An empty or absent document list declares nothing, since OpenAPI lets it be incomplete.
const authOf = (
  operation: typeof Operation.Type,
  spec: typeof Spec.Type,
  schemes: Schemes,
): Result.Result<
  { readonly scheme: string | undefined; readonly scopes: ReadonlyArray<string> },
  string
> => {
  const documented = spec.security?.length === 0 ? undefined : spec.security;
  const alternatives = operation.security ?? documented;
  if (Predicate.isUndefined(alternatives)) {
    return Result.fail("the spec declares no security for it; a patch can declare it");
  }

  if (alternatives.length === 0 || alternatives.some((one) => Object.keys(one).length === 0)) {
    return Result.succeed({ scheme: undefined, scopes: [] });
  }

  for (const alternative of alternatives) {
    const names = Object.keys(alternative);
    const [name] = names;
    if (names.length === 1 && Predicate.isNotUndefined(name) && Object.hasOwn(schemes, name)) {
      return Result.succeed({ scheme: name, scopes: alternative[name] ?? [] });
    }
  }

  const wanted = Object.keys(alternatives[0] ?? {}).join(" and ");
  return Result.fail(`needs the ${wanted} scheme, which a provider file does not declare`);
};

const requestOf = (input: NonNullable<EncodedTask["input"]>) => {
  const required = inputLocations.flatMap((location) =>
    Object.entries(input[location] ?? {})
      .filter(([, field]) => field.required === true)
      .map(([name, field]) => ({ location, name, field })),
  );

  const missing = required.filter(({ field }) => Predicate.isUndefined(field.example));
  if (missing.length > 0) {
    return Result.fail(
      `no example value in the spec for ${missing.map(({ name }) => name).join(", ")}`,
    );
  }

  if (required.length === 0) {
    return Result.fail("nothing to send: an empty request may be answered, and billed, in full");
  }

  const request: { [location in Location]?: { [name: string]: Schema.Json } } = {};
  for (const { location, name, field } of required) {
    request[location] = { ...request[location], [name]: field.example as Schema.Json };
  }

  return Result.succeed(request);
};

// A connected account's task is replayed against a live connection, not from a test request.
const testOf = (
  input: NonNullable<EncodedTask["input"]>,
  { ownAccount, action }: { readonly ownAccount: boolean; readonly action: boolean },
): Pick<EncodedTask, "test_request" | "untestable"> => {
  if (ownAccount) return {};
  if (action) return { untestable: "an action changes the provider's data, so no test replays it" };
  const request = requestOf(input);
  return Result.isSuccess(request)
    ? { test_request: request.success }
    : { untestable: request.failure };
};

const isJson = (media: string) =>
  media === "application/json" || /^application\/[^;]+\+json$/.test(media);

const bodyOf = (root: unknown, requestBody: unknown) => {
  const missing = unresolved(root, requestBody);
  if (Predicate.isNotUndefined(missing)) return Result.fail(missing);
  const content = deref(root, requestBody);
  const media =
    Predicate.isObject(content) && Predicate.isObject(content.content) ? content.content : {};

  const names = Object.keys(media);
  const json = names.find(isJson);
  const form = names.find((name) => name === "application/x-www-form-urlencoded");
  const chosen = json ?? form;
  if (Predicate.isUndefined(chosen)) {
    return Result.fail(
      names.some((name) => name.startsWith("multipart/"))
        ? "its body is multipart, which a call's input cannot carry"
        : "its body is neither JSON nor a URL-encoded form",
    );
  }

  const entry = media[chosen];
  const node = Predicate.isObject(entry) ? nodeOf(root, entry.schema) : undefined;
  if (Predicate.isUndefined(node?.properties)) {
    return Result.fail("its body is not an object with named fields");
  }

  const required = new Set(node.required ?? []);
  return Result.succeed({
    bodyType: Predicate.isUndefined(json) ? ("form" as const) : ("json" as const),
    fields: Object.entries(node.properties).map(
      ([name, property]) =>
        [name, fieldOf(root, property, { required: required.has(name) })] as const,
    ),
  });
};

export const notAUrl = "it names a server that is not a URL";

// As OpenAPI says, a relative server resolves against where the document was fetched,
// and no server means `/`.
export const resolveServer = (
  server: typeof Server.Type | undefined,
  url: string,
): Result.Result<URL | undefined, string> => {
  const template = (server?.url ?? "/").replace(
    /\{([^}]+)\}/g,
    (variable, name: string) => server?.variables?.[name]?.default ?? variable,
  );

  if (/\{[^}]*\}/.test(template)) return Result.succeed(undefined);
  return Result.try({ try: () => new URL(template, url), catch: () => notAUrl }).pipe(
    Result.map((resolved) => (isHttp(resolved.href) ? resolved : undefined)),
  );
};

const serverOf = (server: typeof Server.Type | undefined, url: string) =>
  Result.getOrUndefined(resolveServer(server, url));

const serverUrlOf = (servers: ReadonlyArray<typeof Server.Type>, url: string) =>
  serverOf(servers[0], url)?.href.replace(/\/$/, "");

const taskOf = (
  { spec, root, url }: OpenApi,
  candidate: Candidate,
  id: string,
  schemes: Schemes,
  base: string | null,
): Result.Result<EncodedTask, string> => {
  const { operation, path, item } = candidate;
  const method = taskMethods.find((one) => one === candidate.method);
  if (Predicate.isUndefined(method)) {
    return Result.fail(`a task has no ${candidate.method} method`);
  }

  const access = authOf(operation, spec, schemes);
  if (Result.isFailure(access)) return Result.fail(access.failure);
  const { scheme, scopes } = access.success;

  // A scheme's credential place is not caller input; names compare in any case, as the loader's.
  const placed = (location: Location, name: string) => `${location} ${name.toLowerCase()}`;
  const injected = new Set([
    ...ignoredHeaders.map((name) => placed("headers", name)),
    ...Object.values(schemes).flatMap(({ place }) =>
      Predicate.isUndefined(place) ? [] : [placed(place.location, place.name)],
    ),
  ]);

  const input: { [location in Location]?: { [name: string]: InputField } } = {};
  const seen = new Map<string, Location>();
  const place = (location: Location, name: string, field: InputField) => {
    const first = seen.get(name);
    if (Predicate.isNotUndefined(first)) {
      return `has ${name} in ${first} and in ${location}, and a call's input is one flat object`;
    }

    seen.set(name, location);
    input[location] = { ...input[location], [name]: field };
    return undefined;
  };

  for (const value of candidate.parameters) {
    const missing = unresolved(root, value);
    if (Predicate.isNotUndefined(missing)) return Result.fail(missing);
    const parameter = asParameter(deref(root, value));
    if (Predicate.isUndefined(parameter)) continue;
    if (parameter.in === "querystring") {
      return Result.fail("it takes its whole query string as one parameter, which an input cannot");
    }

    const required = parameter.in === "path" || parameter.required === true;
    if (parameter.in === "cookie" && required) {
      return Result.fail(`it needs the cookie ${parameter.name}, which a call cannot send`);
    }

    if (!Object.hasOwn(locationOf, parameter.in)) continue;
    const location = locationOf[parameter.in];
    if (Predicate.isUndefined(location)) continue;
    if (injected.has(placed(location, parameter.name))) continue;
    if (parameter.deprecated === true && !required) continue;
    const problem = place(
      location,
      parameter.name,
      fieldOf(root, parameterSchema(parameter), {
        required,
        example: exampleOf(root, parameter),
        note: parameter.description,
      }),
    );

    if (Predicate.isNotUndefined(problem)) return Result.fail(problem);
  }

  let bodyType: "json" | "form" | undefined;
  if (Predicate.isNotUndefined(operation.requestBody)) {
    const body = bodyOf(root, operation.requestBody);
    if (Result.isFailure(body)) return Result.fail(body.failure);
    bodyType = body.success.bodyType;
    for (const [name, field] of body.success.fields) {
      const problem = place("body", name, field);
      if (Predicate.isNotUndefined(problem)) return Result.fail(problem);
    }
  }

  // The servers an operation or its Path Item names replace the document's.
  const host = Predicate.isUndefined(candidate.servers)
    ? undefined
    : serverUrlOf(candidate.servers, url);

  const ownAccount = Predicate.isNotUndefined(scheme) && schemes[scheme]?.type === "oauth2";
  const actsAs =
    Predicate.isNotUndefined(scheme) &&
    schemes[scheme]?.principals?.includes("organization") === false
      ? "user"
      : "organization";

  const action = method !== "GET";
  const summary = trimmed(operation.summary) ?? trimmed(item.summary);
  const fallback = Predicate.isUndefined(operation.operationId)
    ? `${method} ${path}`
    : slugOf(operation.operationId).replaceAll("-", " ");

  const name = shorten(summary ?? fallback, 60);
  const described = trimmed(operation.description) ?? trimmed(item.description);
  const docs = operation.externalDocs?.url;
  const filled = { ...input, ...(Predicate.isUndefined(bodyType) ? {} : { bodyType }) };

  return Result.succeed({
    id,
    ...(action ? { kind: "action" as const } : {}),
    auth: scheme ?? "public",
    ...(Predicate.isUndefined(scheme) ? {} : { scope: ownAccount ? "own_account" : "any_account" }),
    ...(ownAccount ? { principal: actsAs, required_scopes: scopes } : {}),
    method,
    path,
    ...(Predicate.isNotUndefined(host) && host !== base ? { base_url: host } : {}),
    name,
    summary: trimmed(described?.split(/\n\s*\n/)[0]) ?? summary ?? name,
    ...(Predicate.isNotUndefined(docs) && isHttp(docs) ? { docs_url: docs } : {}),
    input: filled,
    ...testOf(filled, { ownAccount, action }),
  });
};

const answerOf = (root: unknown, operation: typeof Operation.Type, status: string) => {
  const response = deref(root, operation.responses?.[status]);
  const media = Predicate.isObject(response) ? response.content : undefined;
  const json = Predicate.isObject(media) ? media["application/json"] : undefined;
  return Predicate.isObject(json) ? nodeOf(root, json.schema) : undefined;
};

// Specific codes before the `2XX` range.
const successes = ["202", "201", "200", "2XX"];

const failed = /fail|error|cancel|abort|expire|timeout|reject/i;
const succeeded = /^(?:succe|complet|done|finish|ready)/i;

// OpenAPI cannot say when a job is over, so status values are read by their words.
// Without both a success and a failure value, the status is ignored.
const outcomesOf = (root: unknown, node: Node | undefined) => {
  const statuses = nodeOf(root, node?.properties?.status)?.enum?.filter(Predicate.isString) ?? [];
  const failure = statuses.filter((status) => failed.test(status));
  const success = statuses.filter((status) => !failed.test(status) && succeeded.test(status));
  const progress = statuses.filter(
    (status) => !failure.includes(status) && !success.includes(status),
  );

  return success.length > 0 && failure.length > 0 ? { success, failure, progress } : undefined;
};

// `$response.body#/id` becomes the dotted path `id_from` takes.
const idFrom = (expression: unknown) => {
  if (!Predicate.isString(expression) || !expression.startsWith("$response.body#")) {
    return undefined;
  }

  const tokens = JsonPointer.parseUriFragment(expression.slice("$response.body".length));
  return Predicate.isUndefined(tokens) || tokens.length === 0 ? undefined : tokens.join(".");
};

interface Poll {
  readonly id: string;
  readonly task: string;
  readonly param: string;
  readonly outcomes: NonNullable<ReturnType<typeof outcomesOf>>;
}

// A submission's success response Links to the GET that reads the job, passing one path
// parameter from the body. Two fitting links leave the choice to a person, so none is written.
const asyncOf = (
  { root }: OpenApi,
  candidates: ReadonlyArray<Candidate>,
  generated: ReadonlyMap<string, EncodedTask>,
  core: Curated | undefined,
): ReadonlyMap<string, { readonly [key: string]: Schema.Json }> => {
  const byOperationId = new Map(
    candidates.flatMap((candidate) =>
      Predicate.isUndefined(candidate.operation.operationId)
        ? []
        : [[candidate.operation.operationId, candidate] as const],
    ),
  );

  // An `operationRef` within this document: `#/paths/<template>/<method>`.
  const referenced = (ref: string) => {
    const tokens = JsonPointer.parseUriFragment(ref);
    const [paths, path, method] = tokens ?? [];
    if (paths !== "paths" || tokens?.length !== 3) return undefined;
    return candidates.find(
      (candidate) => candidate.path === path && candidate.method === method?.toUpperCase(),
    );
  };

  const targetOf = (link: typeof Link.Type) => {
    if (Predicate.isNotUndefined(link.operationId)) return byOperationId.get(link.operationId);
    return Predicate.isUndefined(link.operationRef) ? undefined : referenced(link.operationRef);
  };

  const pollOf = (value: unknown): Poll | undefined => {
    const link = asLink(deref(root, value));
    const target = Predicate.isUndefined(link) ? undefined : targetOf(link);
    const passed = Object.entries(link?.parameters ?? {});
    const [only] = passed;
    if (Predicate.isUndefined(target) || passed.length !== 1 || Predicate.isUndefined(only)) {
      return undefined;
    }

    if (target.method !== "GET" || target.operation.deprecated === true) return undefined;
    const param = only[0].replace(/^path\./, "");
    const takes = target.parameters.some((one) => {
      const parameter = asParameter(deref(root, one));
      return parameter?.in === "path" && parameter.name === param;
    });

    const id = idFrom(only[1]);
    const outcomes = outcomesOf(root, answerOf(root, target.operation, "200"));
    const curator = Predicate.isUndefined(core)
      ? undefined
      : curatedBy(core, { method: "GET", path: target.path });

    if (Predicate.isNotUndefined(curator?.status)) return undefined;
    const made = generated.get(route(target));
    const task = curator?.id ?? made?.id;
    if (!takes || Predicate.isUndefined(id) || Predicate.isUndefined(outcomes)) return undefined;
    if (Predicate.isUndefined(task)) return undefined;
    // A core route may name the same placeholder differently; pass it under the served name.
    const servedParam = Predicate.isUndefined(curator)
      ? param
      : placeholdersOf(curator.path)[placeholdersOf(target.path).indexOf(param)];

    if (Predicate.isUndefined(servedParam)) return undefined;
    const input = Predicate.isUndefined(curator) ? made?.input : curator.input;
    const servedPath = curator?.path ?? target.path;
    if (Predicate.isUndefined(input) || !Object.hasOwn(input.pathParams ?? {}, servedParam))
      return undefined;

    // The descriptor binds only the Link's id; nothing fills another required value at call time.
    if (placeholdersOf(servedPath).some((name) => name !== servedParam)) return undefined;
    for (const location of inputLocations) {
      if (
        Object.entries(input[location] ?? {}).some(
          ([name, field]) =>
            field.required === true && (location !== "pathParams" || name !== servedParam),
        )
      )
        return undefined;
    }

    return { id, task, param: servedParam, outcomes };
  };

  const described = new Map<string, { readonly [key: string]: Schema.Json }>();
  for (const candidate of candidates) {
    if (candidate.method === "GET" || candidate.operation.deprecated === true) continue;
    for (const status of successes) {
      const response = deref(root, candidate.operation.responses?.[status]);
      const links =
        Predicate.isObject(response) && Predicate.isObject(response.links)
          ? Object.values(response.links)
          : [];

      const polls = links.map(pollOf).filter(Predicate.isNotUndefined);
      const [poll] = polls;
      if (polls.length !== 1 || Predicate.isUndefined(poll)) continue;
      described.set(route(candidate), {
        id_from: poll.id,
        poll: { task: poll.task, param: { in: "pathParams", name: poll.param } },
        status: { path: "status", ...poll.outcomes },
      });

      break;
    }
  }

  return described;
};

const baseUrlOf = ({
  spec,
  url,
}: OpenApi): { readonly value: string | null; readonly note?: string } => {
  const servers = spec.servers ?? [];
  const resolved = serverUrlOf(servers, url);
  if (Predicate.isUndefined(resolved)) {
    return { value: null, note: "the spec's server is not an address; write the API's root URL" };
  }

  if (servers.length === 0) {
    return {
      value: resolved,
      note: "the spec names no server, so this is where it was fetched from",
    };
  }

  return servers.length > 1
    ? {
        value: resolved,
        note: `the spec lists ${servers.length} servers; check the first is production`,
      }
    : { value: resolved };
};

export const tasksOf = (
  openapi: OpenApi,
  provider: string,
  schemes: Schemes,
  history?: {
    readonly previous: ReadonlyArray<EncodedTask>;
    readonly reserved: ReadonlyArray<string>;
    readonly core: Curated;
  },
): {
  readonly tasks: ReadonlyArray<EncodedTask>;
  readonly leftOut: ReadonlyArray<string>;
} => {
  const leftOut: Array<string> = [];
  const used = new Map<string, number>();
  const reserved = new Set(history?.reserved ?? []);
  const allocated = new Set<string>();
  // A published id stays with its literal method and path, even if the vendor renames the
  // operation. Placeholders are not normalized here: a renamed one must not inherit verification.
  const prior = new Map<string, EncodedTask>();
  for (const task of (history?.previous ?? []).toSorted(
    Order.mapInput(
      Order.String,
      (task) => `${Predicate.isUndefined(task.status) ? "0" : "1"}${task.id}`,
    ),
  )) {
    reserved.add(task.id);
    if (!prior.has(route(task))) prior.set(route(task), task);
  }

  const operations = operationsOf(openapi);
  const base = baseUrlOf(openapi).value;
  const made: Array<{ readonly route: string; readonly task: EncodedTask }> = [];
  for (const candidate of operations) {
    if (candidate.operation.deprecated === true) {
      leftOut.push(`${route(candidate)}: the spec marks it deprecated`);
      continue;
    }

    const slug =
      slugOf(candidate.operation.operationId ?? `${candidate.method} ${candidate.path}`) || "root";

    const before = prior.get(route(candidate));
    const fresh = () => {
      let count = (used.get(slug) ?? 0) + 1;
      let id = `${provider}.x.${count === 1 ? slug : `${slug}-${count}`}`;
      while (reserved.has(id) || allocated.has(id)) {
        count += 1;
        id = `${provider}.x.${slug}-${count}`;
      }

      used.set(slug, count);
      return id;
    };

    const id = Predicate.isNotUndefined(before) && !allocated.has(before.id) ? before.id : fresh();
    allocated.add(id);
    const task = taskOf(openapi, candidate, id, schemes, base);
    if (Result.isSuccess(task)) made.push({ route: route(candidate), task: task.success });
    else leftOut.push(`${route(candidate)}: ${task.failure}`);
  }

  const jobs = asyncOf(
    openapi,
    operations,
    new Map(made.map(({ route, task }) => [route, task])),
    history?.core,
  );

  const tasks = made.map(({ route, task }) =>
    jobs.has(route) ? { ...task, async: jobs.get(route) } : task,
  );

  return {
    tasks: tasks.toSorted(Order.mapInput(Order.String, (task: EncodedTask) => task.id)),
    leftOut: leftOut.toSorted(Order.String),
  };
};

export const docsOf = ({ spec }: OpenApi) => {
  const docs = spec.externalDocs?.url;
  return Predicate.isNotUndefined(docs) && isHttp(docs) ? docs : null;
};

interface Facts {
  readonly name: string;
  readonly nameNote: string;
  readonly base: { readonly value: string | null; readonly note?: string };
  readonly docs: string | null;
  readonly declared: Readonly<Record<string, Declared>>;
  readonly schemes: Schemes;
  // A task in a connected account needs the file to name an identity task.
  readonly ownAccount: boolean;
}

const withoutSpec = (provider: string): Facts => ({
  name: titleOf(provider),
  nameNote: "how the catalog pages write the name",
  base: { value: null },
  docs: null,
  declared: {},
  schemes: {},
  ownAccount: false,
});

const withSpec = (provider: string, openapi: OpenApi): Facts => {
  const declared = declaredSchemes(openapi);
  const schemes = schemesOf(declared);
  return {
    // `Replicate HTTP API` becomes `Replicate`.
    name: openapi.spec.info.title
      .replace(/(?:\s+(?:API|REST|HTTP|Documentation|Docs|Reference))+$/i, "")
      .trim(),
    nameNote: "from the spec's title",
    base: baseUrlOf(openapi),
    docs: docsOf(openapi),
    declared,
    schemes,
    ownAccount: tasksOf(openapi, provider, schemes).tasks.some(
      ({ scope }) => scope === "own_account",
    ),
  };
};

// `null` marks what the spec does not say; `validate` refuses it until a person writes it.
// `endpoints` stays empty: a person curates them from the extended file.
export const scaffold = (provider: string, today: string, openapi?: OpenApi): Scaffold => {
  const facts = Predicate.isUndefined(openapi)
    ? withoutSpec(provider)
    : withSpec(provider, openapi);

  const reviews: Array<Review> = [];
  const review = (path: string, note: string) => reviews.push({ path, note });

  review("display_name", facts.nameNote);
  if (Predicate.isNotUndefined(facts.base.note) || Predicate.isNull(facts.base.value)) {
    review("base_url", facts.base.note ?? "the API's root URL");
  }

  if (Predicate.isNull(facts.docs)) {
    review("docs_url", "the provider's documentation page");
    review("source.docs", "the same page");
  }

  for (const [name, { type }] of Object.entries(facts.declared)) {
    if (type === "oauth2") {
      review(
        `auth.schemes.${name}`,
        "pkce, refresh and principals are guesses; check the provider's OAuth guide",
      );
    }
  }

  if (facts.ownAccount) {
    review(
      "identity",
      "the task that returns the connected account, and the paths to its id and label",
    );
  }

  const header = {
    provider,
    display_name: facts.name,
    base_url: facts.base.value,
    docs_url: facts.docs,
    source: { docs: facts.docs, openapi: openapi?.url ?? null, curated: today },
    version: today,
    ...(Record.isEmptyRecord(facts.declared) ? {} : { auth: { schemes: facts.declared } }),
    ...(facts.ownAccount ? { identity: { task: null, account_path: null, label_path: null } } : {}),
    endpoints: [],
  };

  // Write a shared value out twice, never as a YAML anchor and alias.
  const document = new Document(header, { aliasDuplicateObjects: false });
  document.commentBefore = [
    " Review before `telipot catalog validate` passes, then delete this block:",
    ...reviews.map(({ path, note }) => `   ${path}: ${note}`),
  ].join("\n");

  return {
    text: document.toString({ lineWidth: 0 }),
    reviews,
    schemes: facts.schemes,
  };
};
