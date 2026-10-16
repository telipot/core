import { Predicate, Result, Schema } from "effect";

import {
  type OpenApi,
  type SpecPatch,
  type Server,
  notAUrl,
  openApiAt,
  operationsOf,
  patched,
  resolveServer,
} from "./openapi";
import { type Task, taskMethods } from "./schema";

export interface PublishedRoute {
  readonly method: Task["method"];
  readonly origin: string;
  readonly path: string;
}

const methodOf = (method: string) => taskMethods.find((one) => one === method.toUpperCase());

const Swagger = Schema.Struct({
  swagger: Schema.String,
  host: Schema.optionalKey(Schema.String),
  schemes: Schema.optionalKey(Schema.Array(Schema.String)),
  basePath: Schema.optionalKey(Schema.String),
  paths: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)),
});

// Google publishes Discovery documents in place of OpenAPI; their resources nest to any depth.
const Method = Schema.Struct({
  httpMethod: Schema.String,
  path: Schema.String,
  flatPath: Schema.optionalKey(Schema.String),
});

interface Resource {
  readonly methods?: { readonly [name: string]: typeof Method.Type };
  readonly resources?: { readonly [name: string]: Resource };
}

const Resource = Schema.Struct({
  methods: Schema.optionalKey(Schema.Record(Schema.String, Method)),
  resources: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.suspend((): Schema.Codec<Resource> => Resource),
    ),
  ),
});

const Discovery = Schema.Struct({
  discoveryVersion: Schema.String,
  rootUrl: Schema.String,
  servicePath: Schema.String,
  ...Resource.fields,
});

const under = (server: URL, path: string) => `${server.pathname.replace(/\/$/, "")}${path}`;

// A server that is not http is skipped; one that is not a URL fails the read.
const openApiRoutes = (
  openapi: OpenApi,
  url: string,
): Result.Result<ReadonlyArray<PublishedRoute>, string> =>
  Result.all(
    operationsOf(openapi).flatMap(({ method, path, servers }) => {
      const sent = methodOf(method);
      if (Predicate.isUndefined(sent)) return [];
      const declared: ReadonlyArray<typeof Server.Type | undefined> =
        servers ?? openapi.spec.servers ?? [];

      return (declared.length > 0 ? declared : [undefined]).map((server) =>
        resolveServer(server, url).pipe(
          Result.map((at): ReadonlyArray<PublishedRoute> =>
            Predicate.isUndefined(at)
              ? []
              : [{ method: sent, origin: at.origin, path: under(at, path) }],
          ),
        ),
      );
    }),
  ).pipe(Result.map((routes) => routes.flat()));

// Swagger 2 has no servers: use its host and schemes, else where it was fetched from.
const swaggerRoutes = (spec: typeof Swagger.Type, url: string): ReadonlyArray<PublishedRoute> => {
  const document = new URL(url);
  const servers = (spec.schemes ?? [document.protocol.slice(0, -1)]).map(
    (scheme) => new URL(`${scheme}://${spec.host ?? document.host}${spec.basePath ?? "/"}`),
  );

  return Object.entries(spec.paths).flatMap(([path, operations]) =>
    servers.flatMap((server) =>
      Object.keys(operations).flatMap((name) => {
        const method = methodOf(name);
        return Predicate.isUndefined(method)
          ? []
          : [{ method, origin: server.origin, path: under(server, path) }];
      }),
    ),
  );
};

const resourceMethods = (resource: Resource): ReadonlyArray<typeof Method.Type> => [
  ...Object.values(resource.methods ?? {}),
  ...Object.values(resource.resources ?? {}).flatMap(resourceMethods),
];

// `flatPath` spells each placeholder as one segment; `path` may use reserved expansion, `{+name}`.
const discoveryRoutes = (document: typeof Discovery.Type): ReadonlyArray<PublishedRoute> => {
  const server = new URL(document.servicePath, document.rootUrl);
  return resourceMethods(document).flatMap(({ httpMethod, path, flatPath }) => {
    const method = methodOf(httpMethod);
    if (Predicate.isUndefined(method)) return [];
    return [
      {
        method,
        origin: server.origin,
        path: `/${[server.pathname, flatPath ?? path]
          .map((part) => part.replace(/^\/|\/$/g, ""))
          .filter((part) => part !== "")
          .join("/")}`,
      },
    ];
  });
};

// A server that is not a URL fails the read, never the run.
const routesOf = (read: () => ReadonlyArray<PublishedRoute>) =>
  Result.try({ try: read, catch: () => notAUrl });

// Reads Swagger 2 and Google Discovery besides OpenAPI 3, for `telipot catalog drift`.
export const publishedRoutes = (
  text: string,
  url: string,
  patch: SpecPatch = [],
): Result.Result<ReadonlyArray<PublishedRoute>, string> =>
  patched(text, patch).pipe(
    Result.flatMap((root) =>
      openApiAt(root, url).pipe(
        Result.map((openapi) => openApiRoutes(openapi, url)),
        Result.orElse(() =>
          Schema.decodeUnknownResult(Swagger)(root).pipe(
            Result.map((spec) => routesOf(() => swaggerRoutes(spec, url))),
          ),
        ),
        Result.orElse(() =>
          Schema.decodeUnknownResult(Discovery)(root).pipe(
            Result.map((document) => routesOf(() => discoveryRoutes(document))),
          ),
        ),
        Result.mapError(() => "it is neither an OpenAPI nor a Google Discovery document"),
        Result.flatMap((routes) => routes),
      ),
    ),
  );
