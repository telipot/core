import { Context, type Duration, Effect, Layer, Option, Predicate, Ref, Schema } from "effect";
import {
  type HttpBody,
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/http";

// This package depends on nothing of ours, so its consumer builds routes from the catalog.
export interface VendorRoute {
  readonly task: string;
  readonly method: string;
  // Each `{name}` matches one path segment.
  readonly url: string;
  // The type turns a query or form value back into the value the caller sent.
  readonly fields: Readonly<
    Record<
      string,
      {
        readonly in: "pathParams" | "queryParams" | "headers" | "body";
        readonly type: string;
      }
    >
  >;
  readonly check: (input: Readonly<Record<string, unknown>>) => ReadonlyArray<string>;
  readonly example: Schema.Json;
  readonly scopes: ReadonlyArray<string>;
  // Where the task's scheme sends the credential, so it is not read as input.
  readonly credential?: { readonly in: "headers" | "queryParams"; readonly name: string };
}

export interface Received {
  readonly task: string;
  readonly method: string;
  readonly url: string;
  readonly input: Readonly<Record<string, unknown>>;
  // As sent, with its scheme's prefix, such as `Bearer `.
  readonly credential?: string;
}

// `text` is sent as written, labelled JSON unless `headers` say otherwise.
export type Fault =
  | {
      readonly status: number;
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: Schema.Json;
    }
  | {
      readonly status: number;
      readonly headers?: Readonly<Record<string, string>>;
      readonly text: string;
    }
  | { readonly delay: Duration.Input }
  | { readonly unreachable: true };

export const json = (
  request: HttpClientRequest.HttpClientRequest,
  status: number,
  body: string,
  headers: Readonly<Record<string, string>> = {},
) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(body, {
      status,
      headers: { "content-type": "application/json; charset=utf-8", ...headers },
    }),
  );

export const notFaked = (request: HttpClientRequest.HttpClientRequest, vendor: string) =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({
      request,
      description: `The ${vendor} fixture fakes no such route`,
    }),
  });

const escaped = (text: string) => text.replace(/[.*+?^$()|[\]\\]/g, "\\$&");

interface Matcher {
  readonly route: VendorRoute;
  readonly address: RegExp;
  readonly placeholders: number;
}

// Where addresses overlap, fewer `{name}`s wins, as a vendor's literal path beats its pattern.
export const routing = (routes: ReadonlyArray<VendorRoute>) => {
  const matchers: Array<Matcher> = routes
    .map((route) => ({
      route,
      address: new RegExp(
        `^${route.url
          .split(/\{([^}]+)\}/)
          .map((part, index) => (index % 2 === 0 ? escaped(part) : `(?<${part}>[^/]+)`))
          .join("")}$`,
      ),
      placeholders: route.url.split("{").length - 1,
    }))
    .toSorted((one, other) => one.placeholders - other.placeholders);

  return (request: HttpClientRequest.HttpClientRequest, url: URL) => {
    const address = `${url.origin}${url.pathname}`;
    for (const { route, address: pattern } of matchers) {
      const found = route.method === request.method ? pattern.exec(address) : null;
      if (Predicate.isNotNull(found)) return { route, path: found.groups ?? {} };
    }

    return undefined;
  };
};

const JsonText = Schema.fromJsonString(Schema.Unknown);

// Text not of the declared type stays text, for the check to refuse.
const typed = (type: string, text: string): unknown => {
  switch (type) {
    case "integer":
    case "number":
      return text.trim() !== "" && Number.isFinite(Number(text)) ? Number(text) : text;
    case "boolean":
      if (text === "true") return true;
      if (text === "false") return false;
      return text;
    case "object":
      return Option.getOrElse(Schema.decodeOption(JsonText)(text), () => text);
    default:
      return text;
  }
};

const textOf = (body: HttpBody.HttpBody) => {
  switch (body._tag) {
    case "Uint8Array":
      return new TextDecoder().decode(body.body);
    case "Raw":
      return Predicate.isString(body.body) || body.body instanceof URLSearchParams
        ? String(body.body)
        : "";
    case "Empty":
    case "FormData":
    case "Stream":
      return "";
  }
};

type Location = VendorRoute["fields"][string]["in"];

// An undeclared field is kept, so the catalog's check refuses it.
export const readInput = (
  route: VendorRoute,
  request: HttpClientRequest.HttpClientRequest,
  url: URL,
  path: Readonly<Record<string, string>>,
) => {
  const input: Record<string, unknown> = {};
  const sentIn = new Map<string, Location>();
  const typeOf = (name: string) =>
    (Object.hasOwn(route.fields, name) ? route.fields[name]?.type : undefined) ?? "string";

  const put = (name: string, value: unknown, location: Location) => {
    input[name] = value;
    sentIn.set(name, location);
  };

  const read = (from: URLSearchParams, location: Location) => {
    for (const name of new Set(from.keys())) {
      const values = from.getAll(name);
      put(name, typeOf(name) === "array" ? values : typed(typeOf(name), values[0] ?? ""), location);
    }
  };

  for (const [name, value] of Object.entries(path)) {
    put(name, typed(typeOf(name), decodeURIComponent(value)), "pathParams");
  }

  const placed = route.credential;
  const query = new URLSearchParams(url.searchParams);
  let credential: string | undefined;
  if (placed?.in === "queryParams") {
    credential = query.get(placed.name) ?? undefined;
    query.delete(placed.name);
  } else if (Predicate.isNotUndefined(placed)) {
    credential = request.headers[placed.name.toLowerCase()];
  }

  read(query, "queryParams");
  for (const [name, field] of Object.entries(route.fields)) {
    const value = field.in === "headers" ? request.headers[name.toLowerCase()] : undefined;
    if (Predicate.isNotUndefined(value)) put(name, typed(field.type, value), "headers");
  }

  const text = textOf(request.body);
  if (request.body._tag !== "Empty" && /json/i.test(request.body.contentType ?? "")) {
    const body = Schema.decodeOption(JsonText)(text);
    const fields = Option.filter(body, Predicate.isReadonlyObject);
    if (Option.isSome(fields)) {
      for (const [name, value] of Object.entries(fields.value)) put(name, value, "body");
    } else {
      put("(body)", text, "body");
    }
  } else if (text !== "") {
    read(new URLSearchParams(text), "body");
  }

  const misplaced = [...sentIn].flatMap(([name, location]) => {
    const declared = Object.hasOwn(route.fields, name) ? route.fields[name]?.in : undefined;
    return Predicate.isNotUndefined(declared) && declared !== location
      ? [`${name} was sent in ${location}, but ${route.task} declares it in ${declared}`]
      : [];
  });

  return { input, credential, problems: [...route.check(input), ...misplaced] };
};

export class Vendors extends Context.Service<
  Vendors,
  {
    readonly client: HttpClient.HttpClient;
    readonly fail: (task: string, fault: Fault) => Effect.Effect<void>;
    readonly received: Effect.Effect<ReadonlyArray<Received>>;
  }
>()("@telipot/fixtures/vendors/Vendors") {
  static readonly layer = (routes: ReadonlyArray<VendorRoute>) =>
    Layer.effect(
      Vendors,
      Effect.gen(function* () {
        const find = routing(routes);
        const faults = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<Fault>>>(new Map());
        const received = yield* Ref.make<ReadonlyArray<Received>>([]);

        const nextFault = (task: string) =>
          Ref.modify(
            faults,
            (all): readonly [Fault | undefined, ReadonlyMap<string, ReadonlyArray<Fault>>] => {
              const [first, ...rest] = all.get(task) ?? [];
              return [first, new Map(all).set(task, rest)];
            },
          );

        const client = HttpClient.make((request, url) =>
          Effect.gen(function* () {
            const found = find(request, url);
            if (Predicate.isUndefined(found)) return yield* notFaked(request, "vendor");
            const { route, path } = found;
            const { input, credential, problems } = readInput(route, request, url, path);
            yield* Ref.update(received, (all) => [
              ...all,
              {
                task: route.task,
                method: request.method,
                url: `${url.origin}${url.pathname}`,
                input,
                ...(Predicate.isUndefined(credential) ? {} : { credential }),
              },
            ]);

            if (problems.length > 0) {
              return json(
                request,
                400,
                JSON.stringify({ error: `The request does not fit ${route.task}`, problems }),
              );
            }

            const fault = yield* nextFault(route.task);
            if (Predicate.isNotUndefined(fault) && "unreachable" in fault) {
              return yield* new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({
                  request,
                  description: `${route.task}'s vendor could not be reached`,
                }),
              });
            }

            if (Predicate.isNotUndefined(fault) && "status" in fault) {
              const body = "text" in fault ? fault.text : JSON.stringify(fault.body ?? {});
              return json(request, fault.status, body, fault.headers);
            }

            if (Predicate.isNotUndefined(fault)) yield* Effect.sleep(fault.delay);
            return json(request, 200, JSON.stringify(route.example));
          }),
        );

        return Vendors.of({
          client,
          fail: (task, fault) =>
            Ref.update(faults, (all) => new Map(all).set(task, [...(all.get(task) ?? []), fault])),
          received: Ref.get(received),
        });
      }),
    );
}
