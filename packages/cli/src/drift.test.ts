import { BunServices } from "@effect/platform-bun";
import { assert, layer } from "@effect/vitest";
import { catalogFixtures } from "@telipot/fixtures/catalog";
import { copyDirectory } from "@telipot/fixtures/filesystem";
import { Effect, FileSystem, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { parseDocument } from "yaml";

import { drift } from "./drift";

const specUrl = "http://vendor.test/openapi.json";
const otherUrl = "http://other.test/openapi.json";

const publisher = (spec: unknown, status = 200, elsewhere: Record<string, unknown> = {}) => {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      seen.push({ url: url.toString(), headers: { ...request.headers } });
      const document = Object.hasOwn(elsewhere, url.toString()) ? elsewhere[url.toString()] : spec;
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(document), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    }),
  );

  return { seen, layer: Layer.succeed(HttpClient.HttpClient, client) };
};

const editing = Effect.fnUntraced(function* (change: (text: string) => string = (text) => text) {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* copyDirectory(catalogFixtures.verify);
  const file = `${directory}/providers/vendor.yaml`;
  const text = yield* fs.readFileString(file);
  yield* fs.writeFileString(file, change(text.replace("openapi: null", `openapi: ${specUrl}`)));
  return directory;
});

const relatedAt = (path: string, match = "normalized") =>
  editing((text) => {
    const document = parseDocument(text);
    const task = ["endpoints", 3];
    document.setIn([...task, "path"], path);
    document.set("route_match", match);
    if (path.includes("{phrase}")) {
      const field = document.getIn([...task, "input", "queryParams", "phrase"], true);
      const value = document.getIn([...task, "test_request", "queryParams", "phrase"]);
      document.deleteIn([...task, "input", "queryParams", "phrase"]);
      document.deleteIn([...task, "test_request", "queryParams", "phrase"]);
      document.setIn([...task, "input", "pathParams", "phrase"], field);
      document.setIn([...task, "test_request", "pathParams", "phrase"], value);
    }

    return String(document);
  });

const operation = { responses: { "200": { description: "ok" } } };

const paths = {
  "/page": { get: operation },
  "/keywords": { get: operation },
  "/related": { get: operation },
  "/domains/overview": { post: operation },
  "/lookup": { get: operation },
  "/search": { post: operation },
  "/similar": { get: operation },
  "/account": { get: operation },
  "/contacts": { get: operation },
};

const spec = (more: object = {}) => ({
  openapi: "3.1.0",
  info: { title: "Vendor" },
  servers: [{ url: "http://vendor.test/v1" }],
  paths,
  ...more,
});

// Discovery nests each method under resources, with its path relative to the service path.
const discovery = (methods: Record<string, object>, more: object = {}) => ({
  kind: "discovery#restDescription",
  discoveryVersion: "v1",
  rootUrl: "http://vendor.test/",
  servicePath: "v1/",
  resources: { vendor: { resources: { reports: { methods } } } },
  ...more,
});

const discoveryMethods = Object.fromEntries(
  Object.entries(paths).flatMap(([path, operations]) =>
    Object.keys(operations).map((method) => [
      `${method}${path}`,
      { httpMethod: method.toUpperCase(), path: path.slice(1) },
    ]),
  ),
);

layer(BunServices.layer)("telipot catalog drift", (it) => {
  it.effect("finds nothing when every route is still in the vendor's spec", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* editing();
        const vendor = publisher(spec());
        assert.deepStrictEqual(yield* drift(directory).pipe(Effect.provide(vendor.layer)), []);
        assert.deepStrictEqual(vendor.seen, [{ url: specUrl, headers: vendor.seen[0]?.headers }]);
        assert.notProperty(vendor.seen[0]?.headers ?? {}, "authorization");
      }),
    ),
  );

  it.effect("reports each task whose route moved, and the vendor's own paths do not hide it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* editing();
        // /keywords moved under /v2; /search lost its POST and answers GET.
        const { "/keywords": moved, "/search": changed, ...rest } = paths;
        const vendor = publisher(
          spec({ paths: { ...rest, "/v2/keywords": moved, "/search": { get: changed.post } } }),
        );

        const found = yield* drift(directory).pipe(Effect.provide(vendor.layer));
        assert.deepStrictEqual(
          found.map(({ task, route }) => [task, route]),
          [
            ["vendor.keywords.volume", "GET /v1/keywords"],
            ["vendor.keywords.volume.again", "GET /v1/keywords"],
            ["vendor.keywords.search", "POST /v1/search"],
          ],
        );

        assert.include(found[0]?.message ?? "", specUrl);
      }),
    ),
  );

  it.effect("ignores placeholder names, since the spec may spell them differently", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* relatedAt("/related/{phrase}");
        const { "/related": _, ...rest } = paths;
        const vendor = publisher(
          spec({ paths: { ...rest, "/related/{term}": { get: operation } } }),
        );

        assert.deepStrictEqual(yield* drift(directory).pipe(Effect.provide(vendor.layer)), []);
      }),
    ),
  );

  it.effect("compares placeholder names when the provider sets route_match: exact", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* relatedAt("/related/{phrase}", "exact");
        const { "/related": _, ...rest } = paths;
        const renamed = publisher(
          spec({ paths: { ...rest, "/related/{term}": { get: operation } } }),
        );

        const found = yield* drift(directory).pipe(Effect.provide(renamed.layer));
        assert.deepStrictEqual(
          found.map(({ route }) => route),
          ["GET /v1/related/{phrase}"],
        );

        const same = publisher(
          spec({ paths: { ...rest, "/related/{phrase}": { get: operation } } }),
        );

        assert.deepStrictEqual(yield* drift(directory).pipe(Effect.provide(same.layer)), []);
      }),
    ),
  );

  it.effect("reads a Google Discovery document as the vendor's spec", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* editing();
        const complete = publisher(discovery(discoveryMethods));
        assert.deepStrictEqual(yield* drift(directory).pipe(Effect.provide(complete.layer)), []);

        // /keywords moved under /v2.
        const { "get/keywords": moved, ...rest } = discoveryMethods;
        const moving = publisher(
          discovery({ ...rest, "get/v2/keywords": { ...moved, path: "v2/keywords" } }),
        );

        const found = yield* drift(directory).pipe(Effect.provide(moving.layer));
        assert.deepStrictEqual(
          found.map(({ task, route }) => [task, route]),
          [
            ["vendor.keywords.volume", "GET /v1/keywords"],
            ["vendor.keywords.volume.again", "GET /v1/keywords"],
          ],
        );
      }),
    ),
  );

  it.effect("compares a Discovery method by its flat path, placeholders ignored", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* relatedAt("/related/{phrase}");
        const { "get/related": _, ...rest } = discoveryMethods;
        // `path` spells the placeholder with reserved expansion; `flatPath` as a segment.
        const vendor = publisher(
          discovery({
            ...rest,
            related: { httpMethod: "GET", path: "{+name}", flatPath: "related/{termId}" },
          }),
        );

        assert.deepStrictEqual(yield* drift(directory).pipe(Effect.provide(vendor.layer)), []);
      }),
    ),
  );

  it.effect(
    "finds a Discovery method whose service path is empty and whose path holds it all",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* editing();
          const whole = Object.fromEntries(
            Object.entries(discoveryMethods).map(([name, method]) => [
              name,
              { ...method, path: `v1/${method.path}` },
            ]),
          );

          const vendor = publisher(discovery(whole, { servicePath: "" }));
          assert.deepStrictEqual(yield* drift(directory).pipe(Effect.provide(vendor.layer)), []);
        }),
      ),
  );

  it.effect("accepts a task that pins the value of a placeholder in the vendor's route", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* relatedAt("/related/primary");
        const { "/related": _, ...rest } = paths;
        const vendor = publisher(
          spec({ paths: { ...rest, "/related/{calendarId}": { get: operation } } }),
        );

        assert.deepStrictEqual(yield* drift(directory).pipe(Effect.provide(vendor.layer)), []);

        const other = publisher(
          spec({ paths: { ...rest, "/related/{id}/more": { get: operation } } }),
        );

        const found = yield* drift(directory).pipe(Effect.provide(other.layer));
        assert.deepStrictEqual(
          found.map(({ route }) => route),
          ["GET /v1/related/primary"],
        );
      }),
    ),
  );

  it.effect("does not let a placeholder absorb a :verb the vendor's route lacks", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { "/related": _, ...rest } = paths;
        const { "get/related": __, ...flat } = discoveryMethods;
        for (const task of ["/related/{phrase}:move", "/related/primary:move"]) {
          const directory = yield* relatedAt(task);
          for (const vendor of [
            publisher(spec({ paths: { ...rest, "/related/{id}": { get: operation } } })),
            publisher(
              discovery({
                ...flat,
                related: { httpMethod: "GET", path: "related/{+id}", flatPath: "related/{id}" },
              }),
            ),
          ]) {
            const found = yield* drift(directory).pipe(Effect.provide(vendor.layer));
            assert.deepStrictEqual(
              found.map(({ route }) => route),
              [`GET /v1${task}`],
            );
          }
        }
      }),
    ),
  );

  it.effect("checks a task against its own host's document, and reads every document", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* editing((text) =>
          text
            .replace(`openapi: ${specUrl}`, `openapi: [${specUrl}, ${otherUrl}]`)
            .replace(
              "    path: /related\n",
              "    path: /related\n    base_url: http://other.test/v2\n",
            ),
        );

        // /related is under /v2 on the other host and nowhere on the first.
        const { "/related": _, ...rest } = paths;
        const other = {
          openapi: "3.1.0",
          info: { title: "Other" },
          servers: [{ url: "http://other.test/v2" }],
          paths: { "/related": { get: operation } },
        };

        const both = publisher(spec({ paths: rest }), 200, { [otherUrl]: other });
        assert.deepStrictEqual(yield* drift(directory).pipe(Effect.provide(both.layer)), []);
        assert.deepStrictEqual(
          both.seen.map(({ url }) => url),
          [specUrl, otherUrl],
        );

        // With one document unreadable, no task is judged on half the routes.
        const gone = publisher(spec({ paths: rest }), 200, { [otherUrl]: { error: "gone" } });
        const found = yield* drift(directory).pipe(Effect.provide(gone.layer));
        assert.strictEqual(found.length, 1);
        assert.match(found[0]?.message ?? "", /^cannot read http:\/\/other\.test\/openapi\.json: /);
      }),
    ),
  );

  it.effect("rejects a route published only on another host, even with the same path", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { "/related": _, ...rest } = paths;
        const otherDocuments = [
          {
            openapi: "3.1.0",
            info: { title: "Other" },
            servers: [{ url: "http://other.test/v1" }],
            paths: { "/related": { get: operation } },
          },
          discovery(
            { related: { httpMethod: "GET", path: "related" } },
            { rootUrl: "http://other.test/" },
          ),
        ];

        const fs = yield* FileSystem.FileSystem;
        for (const other of otherDocuments) {
          const directory = yield* editing((text) =>
            text.replace(`openapi: ${specUrl}`, `openapi: [${specUrl}, ${otherUrl}]`),
          );

          const vendor = publisher(spec({ paths: rest }), 200, { [otherUrl]: other });
          const found = yield* drift(directory).pipe(Effect.provide(vendor.layer));
          assert.deepStrictEqual(
            found.map(({ task, route }) => [task, route]),
            [["vendor.keywords.related", "GET /v1/related"]],
          );

          assert.include(found[0]?.message ?? "", "GET http://vendor.test/v1/related");

          const file = `${directory}/providers/vendor.yaml`;
          const text = yield* fs.readFileString(file);
          yield* fs.writeFileString(
            file,
            text.replace(
              "    path: /related\n",
              "    path: /related\n    base_url: http://other.test/v1\n",
            ),
          );

          assert.deepStrictEqual(yield* drift(directory).pipe(Effect.provide(vendor.layer)), []);
        }
      }),
    ),
  );

  it.effect("uses the API host declared by a document served from another host", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* editing((text) =>
          text.replace(`openapi: ${specUrl}`, `openapi: ${otherUrl}`),
        );

        for (const document of [
          spec(),
          { swagger: "2.0", host: "vendor.test", schemes: ["http"], basePath: "/v1", paths },
          discovery(discoveryMethods),
        ]) {
          const vendor = publisher(document);
          assert.deepStrictEqual(yield* drift(directory).pipe(Effect.provide(vendor.layer)), []);
        }
      }),
    ),
  );

  it.effect("resolves relative OpenAPI servers and omitted Swagger hosts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* editing();
        for (const document of [
          spec({ servers: [{ url: "/v1" }] }),
          { swagger: "2.0", basePath: "/v1", paths },
        ]) {
          const vendor = publisher(document);
          assert.deepStrictEqual(yield* drift(directory).pipe(Effect.provide(vendor.layer)), []);
        }
      }),
    ),
  );

  it.effect("reads a route on the servers its Path Item names, before the document's", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* editing();
        // /related moves to another host; the document's server still lists the rest.
        const moved = publisher(
          spec({
            paths: {
              ...paths,
              "/related": { get: operation, servers: [{ url: "http://other.test/v1" }] },
            },
          }),
        );

        const found = yield* drift(directory).pipe(Effect.provide(moved.layer));
        assert.deepStrictEqual(
          found.map(({ task }) => task),
          ["vendor.keywords.related"],
        );
      }),
    ),
  );

  it.effect("fills a server's variables and applies the provider's patch, as new does", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* editing();
        const templated = spec({
          servers: [{ url: "http://{host}/v1", variables: { host: { default: "vendor.test" } } }],
        });

        const filled = publisher(templated);
        assert.deepStrictEqual(yield* drift(directory).pipe(Effect.provide(filled.layer)), []);

        // The vendor's document lacks /related, and the patch says it has it.
        const { "/related": _, ...rest } = paths;
        const missing = publisher(spec({ paths: rest }));
        const found = yield* drift(directory).pipe(Effect.provide(missing.layer));
        assert.deepStrictEqual(
          found.map(({ task }) => task),
          ["vendor.keywords.related"],
        );

        yield* fs.makeDirectory(`${directory}/patches`, { recursive: true });
        yield* fs.writeFileString(
          `${directory}/patches/vendor.json`,
          JSON.stringify([{ op: "add", path: "/paths/~1related", value: { get: operation } }]),
        );

        assert.deepStrictEqual(yield* drift(directory).pipe(Effect.provide(missing.layer)), []);

        yield* fs.writeFileString(`${directory}/patches/vendor.json`, '[{ "op": "move" }]');
        const [refused] = yield* drift(directory).pipe(Effect.provide(missing.layer));
        assert.include(refused?.message ?? "", "patches/vendor.json is not a JSON Patch");
      }),
    ),
  );

  it.effect("reports a spec it cannot read, and skips a provider that publishes none", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* editing();
        const down = publisher({ error: "gone" }, 404);
        const found = yield* drift(directory).pipe(Effect.provide(down.layer));
        assert.strictEqual(found.length, 1);
        assert.match(found[0]?.message ?? "", /cannot read .*openapi\.json: it answered 404/);

        for (const body of [{ error: "gone" }, discovery({ bad: { path: "x" } })]) {
          const odd = publisher(body);
          const [only] = yield* drift(directory).pipe(Effect.provide(odd.layer));
          assert.match(only?.message ?? "", /neither an OpenAPI nor a Google Discovery document/);
        }

        const none = publisher(spec());
        const plain = yield* copyDirectory(catalogFixtures.verify);
        assert.deepStrictEqual(yield* drift(plain).pipe(Effect.provide(none.layer)), []);
        assert.deepStrictEqual(none.seen, []);
      }),
    ),
  );
});
