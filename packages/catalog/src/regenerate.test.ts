import { BunServices } from "@effect/platform-bun";
import { assert, it, layer } from "@effect/vitest";
import { catalogFixtures } from "@telipot/fixtures/catalog";
import { copyDirectory } from "@telipot/fixtures/filesystem";
import { openApiFixtures } from "@telipot/fixtures/openapi";
import { Effect, FileSystem, Result } from "effect";
import { readFileSync } from "node:fs";
import { parse, parseDocument } from "yaml";

import { Catalog, formatIssue } from "./catalog";
import { extendedDigest } from "./extended";
import { type OpenApi, readOpenApi, routesOf, scaffold, schemesOf, tasksOf } from "./openapi";
import { extendedFile, lockedIds } from "./regenerate";
import type { ExtendedProvider } from "./schema";

type Written = typeof ExtendedProvider.Encoded;

const specUrl = "https://api.widgetly.example/openapi.json";
const spec = readFileSync(openApiFixtures.widgetly, "utf8");

const widgetly = (): OpenApi => {
  const read = readOpenApi(spec, specUrl);
  return Result.isSuccess(read) ? read.success : assert.fail(read.failure);
};

const schemes = schemesOf({
  apiKey: { type: "api_key", in: "header", name: "X-Widgetly-Key" },
  oauth: { type: "oauth2", principals: ["user"] },
});
const { tasks } = tasksOf(widgetly(), "widgetly", schemes);
const routes = routesOf(widgetly());
const nothing = { route_match: "normalized", endpoints: [] } as const;

const regenerate = (over: Partial<Parameters<typeof extendedFile>[0]> = {}) =>
  extendedFile({
    provider: "widgetly",
    openapi: specUrl,
    docs: null,
    core: nothing,
    tasks,
    routes,
    previous: undefined,
    lock: [],
    today: "2026-10-06",
    ...over,
  });

const task = (file: Written, id: string) =>
  file.endpoints.find((one) => one.id === id) ?? assert.fail(`no ${id}`);

const written = (text: string) => parse(text) as Written;

const changing = (
  file: Written,
  change: (one: Written["endpoints"][number]) => Written["endpoints"][number],
): Written => ({
  ...file,
  endpoints: file.endpoints.map(change),
});

layer(BunServices.layer)("extendedFile", (it) => {
  it.effect("writes a digest the loader works out again from the file as written", () =>
    Effect.gen(function* () {
      const { file, text } = yield* regenerate();
      assert.strictEqual(file.digest, yield* extendedDigest(written(text)));
      assert.strictEqual(file.endpoints.length, tasks.length);
    }),
  );

  it.effect("is byte-identical on another day when the spec is unchanged", () =>
    Effect.gen(function* () {
      const first = yield* regenerate();
      const again = yield* regenerate({ previous: written(first.text), today: "2026-11-30" });
      assert.strictEqual(again.text, first.text);
    }),
  );

  it.effect("is dated again when the spec changed", () =>
    Effect.gen(function* () {
      const first = yield* regenerate();
      const changed = tasks.map((one) =>
        one.id === "widgetly.x.get-status" ? { ...one, summary: "Whether Widgetly answers" } : one,
      );
      const again = yield* regenerate({
        previous: written(first.text),
        tasks: changed,
        today: "2026-11-30",
      });
      assert.notStrictEqual(again.file.digest, first.file.digest);
      assert.strictEqual(again.file.version, "2026-11-30");
      assert.strictEqual(again.file.source.curated, "2026-11-30");
    }),
  );

  it.effect("keeps a reviewed field edited in place, and the file it was edited in", () =>
    Effect.gen(function* () {
      const first = yield* regenerate();
      const edited = changing(written(first.text), (one) =>
        one.id === "widgetly.x.list-widgets"
          ? { ...one, name: "Widgets by owner", capability: "widgets.list", kind: "action" }
          : one,
      );
      const again = yield* regenerate({ previous: edited, today: "2026-11-30" });
      const list = task(again.file, "widgetly.x.list-widgets");
      assert.strictEqual(list.name, "Widgets by owner");
      assert.strictEqual(list.capability, "widgets.list");
      assert.strictEqual(list.kind, "action");
      // The digest leaves reviewed fields out, so the edit changed nothing else.
      assert.strictEqual(again.file.digest, first.file.digest);
      assert.strictEqual(again.file.version, "2026-10-06");
    }),
  );

  it.effect("keeps a reviewed field a reviewer removed", () =>
    Effect.gen(function* () {
      const first = yield* regenerate();
      assert.strictEqual(task(first.file, "widgetly.x.create-widget").kind, "action");
      const edited = changing(written(first.text), (one) => {
        const { kind: _, ...rest } = one;
        return rest;
      });
      const again = yield* regenerate({ previous: edited });
      assert.notProperty(task(again.file, "widgetly.x.create-widget"), "kind");
    }),
  );

  it.effect("leaves out a route core curates, and says which", () =>
    Effect.gen(function* () {
      const { file, twins } = yield* regenerate({
        core: {
          route_match: "normalized",
          endpoints: [{ id: "widgetly.widgets.get", method: "GET", path: "/widgets/{id}" }],
        },
      });
      assert.deepStrictEqual(twins, ["widgetly.x.get-widget"]);
      assert.notInclude(
        file.endpoints.map(({ id }) => id),
        "widgetly.x.get-widget",
      );
    }),
  );

  it.effect("compares placeholder names exactly when the provider sets route_match exact", () =>
    Effect.gen(function* () {
      const { twins } = yield* regenerate({
        core: {
          route_match: "exact",
          endpoints: [{ id: "widgetly.widgets.get", method: "GET", path: "/widgets/{id}" }],
        },
      });
      assert.deepStrictEqual(twins, []);
    }),
  );

  it.effect("keeps a locked id whose route core now curates, as a tombstone pointing at core", () =>
    Effect.gen(function* () {
      const first = yield* regenerate();
      const again = yield* regenerate({
        previous: written(first.text),
        lock: first.file.endpoints.map(({ id }) => id),
        core: {
          route_match: "normalized",
          endpoints: [{ id: "widgetly.widgets.get", method: "GET", path: "/widgets/{widgetId}" }],
        },
      });
      const gone = task(again.file, "widgetly.x.get-widget");
      assert.strictEqual(gone.status, "retired");
      assert.strictEqual(gone.status_note, "widgetly.widgets.get curates this route now");
      assert.strictEqual(gone.superseded_by, "widgetly.widgets.get");
      assert.deepStrictEqual(again.tombstoned, [
        { id: "widgetly.x.get-widget", note: "widgetly.widgets.get curates this route now" },
      ]);
      // Told once, as the tombstone it became, not again as a twin.
      assert.deepStrictEqual(again.twins, []);
    }),
  );

  it.effect("keeps a locked id the spec no longer offers, and drops one never locked", () =>
    Effect.gen(function* () {
      const first = yield* regenerate();
      const withdrawn = ["/status", "/widgets/{widgetId}"];
      const fewer = tasks.filter(
        ({ id }) => id !== "widgetly.x.get-status" && id !== "widgetly.x.delete-widget",
      );
      const again = yield* regenerate({
        previous: written(first.text),
        tasks: fewer,
        routes: routes.filter(({ path }) => !withdrawn.includes(path)),
        lock: ["widgetly.x.get-status"],
      });
      const gone = task(again.file, "widgetly.x.get-status");
      assert.strictEqual(gone.status, "retired");
      assert.strictEqual(gone.status_note, "the provider's spec no longer offers this route");
      assert.notProperty(gone, "superseded_by");
      assert.notInclude(
        again.file.endpoints.map(({ id }) => id),
        "widgetly.x.delete-widget",
      );
    }),
  );

  it.effect("retires a locked id the spec now marks deprecated, saying so", () =>
    Effect.gen(function* () {
      const first = yield* regenerate();
      const again = yield* regenerate({
        previous: written(first.text),
        tasks: tasks.filter(({ id }) => id !== "widgetly.x.get-status"),
        routes: routes.map((route) =>
          route.path === "/status" ? { ...route, deprecated: true } : route,
        ),
        lock: ["widgetly.x.get-status"],
      });
      assert.strictEqual(
        task(again.file, "widgetly.x.get-status").status_note,
        "the provider's spec marks this route deprecated",
      );
    }),
  );

  it.effect(
    "keeps as written a task whose route the spec still offers but no task can be made of",
    () =>
      Effect.gen(function* () {
        // As when a scheme was renamed in the core file: the spec has the route, and
        // a 410 for an id that works would be worse than a refusal from the loader.
        const first = yield* regenerate();
        const again = yield* regenerate({
          previous: written(first.text),
          tasks: tasks.filter(({ id }) => id !== "widgetly.x.get-widget"),
          lock: first.file.endpoints.map(({ id }) => id),
        });
        assert.deepStrictEqual(again.stale, ["widgetly.x.get-widget"]);
        assert.deepStrictEqual(again.tombstoned, []);
        assert.deepStrictEqual(
          task(again.file, "widgetly.x.get-widget"),
          task(first.file, "widgetly.x.get-widget"),
        );
      }),
  );

  it.effect(
    "carries what was recorded of a task: its verification, request, example and ownership",
    () =>
      Effect.gen(function* () {
        const first = yield* regenerate();
        const request = { pathParams: { widgetId: "w_9" } };
        const recorded = changing(written(first.text), (one) =>
          one.id === "widgetly.x.get-widget"
            ? {
                ...one,
                test_request: request,
                verified: "2026-10-01",
                example_response: "examples/widgetly.x.get-widget.json",
                resource_ownership: { produces: ["id"] },
              }
            : one,
        );
        const again = yield* regenerate({ previous: recorded, today: "2026-11-30" });
        const widget = task(again.file, "widgetly.x.get-widget");
        assert.strictEqual(widget.verified, "2026-10-01");
        assert.deepStrictEqual(widget.test_request, request);
        assert.strictEqual(widget.example_response, "examples/widgetly.x.get-widget.json");
        assert.deepStrictEqual(widget.resource_ownership, { produces: ["id"] });
        assert.notProperty(widget, "untestable");
      }),
  );

  it.effect("keeps the generated reason a task cannot be tested when nothing was verified", () =>
    Effect.gen(function* () {
      const first = yield* regenerate();
      const again = yield* regenerate({ previous: written(first.text) });
      assert.strictEqual(
        task(again.file, "widgetly.x.list-widgets").untestable,
        task(first.file, "widgetly.x.list-widgets").untestable,
      );
    }),
  );

  it.effect("keeps a tombstone as it was written, and brings back a route the spec restored", () =>
    Effect.gen(function* () {
      const first = yield* regenerate();
      const lock = first.file.endpoints.map(({ id }) => id);
      const fewer = tasks.filter(({ id }) => id !== "widgetly.x.get-status");
      const retired = yield* regenerate({ previous: written(first.text), tasks: fewer, lock });
      const stays = yield* regenerate({ previous: retired.file, tasks: fewer, lock });
      assert.strictEqual(stays.text, retired.text);
      const restored = yield* regenerate({ previous: retired.file, lock });
      assert.notProperty(task(restored.file, "widgetly.x.get-status"), "status");
    }),
  );

  it.effect("takes no test request from a task a reviewer made the connected account's", () =>
    Effect.gen(function* () {
      const first = yield* regenerate();
      const edited = changing(written(first.text), (one) =>
        one.id === "widgetly.x.get-widget"
          ? { ...one, scope: "own_account", principal: "user" }
          : one,
      );
      const again = yield* regenerate({ previous: edited });
      const widget = task(again.file, "widgetly.x.get-widget");
      assert.notProperty(widget, "test_request");
      assert.notProperty(widget, "untestable");
    }),
  );

  it.effect("writes a value two fields share twice, never as an anchor and an alias", () =>
    Effect.gen(function* () {
      const shared = { text: "Alice" };
      const [first] = tasks;
      const { text } = yield* regenerate({
        tasks: [
          {
            ...(first ?? assert.fail("no task")),
            input: {
              body: {
                a: { type: "object", example: shared },
                b: { type: "object", example: shared },
              },
            },
          },
        ],
      });
      assert.notMatch(text, /&a|\*a/);
      assert.strictEqual(text.match(/text: Alice/g)?.length, 2);
    }),
  );

  it.effect("uses the spec's address for the documentation page it was not given", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* regenerate()).file.source.docs, specUrl);
      assert.strictEqual(
        (yield* regenerate({ docs: "https://docs.widgetly.example" })).file.source.docs,
        "https://docs.widgetly.example",
      );
    }),
  );
});

it("adds ids to the lock in the order it is kept, once", () => {
  assert.deepStrictEqual(lockedIds(["b.x", "a.y"], ["a.x", "b.x"]), ["a.x", "a.y", "b.x"]);
});

layer(BunServices.layer)("a generated provider", (it) => {
  it.effect("loads clean beside the catalog it joins, once the flagged fields are filled", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* copyDirectory(catalogFixtures.clean);

      const header = scaffold("widgetly", "2026-10-06", widgetly());
      const core = parseDocument(header.text);
      yield* fs.writeFileString(`${directory}/providers/widgetly.yaml`, header.text);
      const unfilled = yield* Catalog.validate(directory);
      assert.isAbove(unfilled.issues.length, 0);
      assert.include(unfilled.issues.map(formatIssue).join("\n"), "providers/widgetly.yaml");

      core.set("docs_url", "https://docs.widgetly.example");
      core.setIn(["source", "docs"], "https://docs.widgetly.example");
      core.setIn(["identity", "task"], "widgetly.x.get-current-user");
      core.setIn(["identity", "account_path"], "id");
      core.setIn(["identity", "label_path"], "name");
      yield* fs.writeFileString(`${directory}/providers/widgetly.yaml`, String(core));

      const { text, file } = yield* regenerate({ docs: "https://docs.widgetly.example" });
      yield* fs.writeFileString(`${directory}/providers/widgetly.extended.yaml`, text);
      const lock = JSON.parse(yield* fs.readFileString(`${directory}/ids.lock.json`)) as string[];
      yield* fs.writeFileString(
        `${directory}/ids.lock.json`,
        JSON.stringify(
          lockedIds(
            lock,
            file.endpoints.map(({ id }) => id),
          ),
        ),
      );

      const { issues } = yield* Catalog.validate(directory);
      assert.deepStrictEqual(issues.map(formatIssue), []);
    }).pipe(Effect.scoped),
  );
});
