import { BunServices } from "@effect/platform-bun";
import { assert, layer } from "@effect/vitest";
import { catalogFixtures } from "@telipot/fixtures/catalog";
import { copyDirectory } from "@telipot/fixtures/filesystem";
import { openApiFixtures } from "@telipot/fixtures/openapi";
import { Effect, FileSystem, Option, Result } from "effect";
import { readFileSync } from "node:fs";
import { parse, parseDocument, stringify } from "yaml";

import { Catalog, formatIssue, generateProvider, readOpenApi } from "./index";

const address = "https://api.widgetly.example/openapi.json";
const document = (
  routes: ReadonlyArray<{ readonly path: string; readonly operationId: string }>,
) => {
  const read = readOpenApi(
    JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Widgetly", version: "1.0.0" },
      servers: [{ url: "https://api.widgetly.example" }],
      externalDocs: { url: "https://docs.widgetly.example" },
      security: [{}],
      paths: Object.fromEntries(
        routes.map(({ path, operationId }) => [
          path,
          {
            get: { operationId, responses: { 200: { description: "Ok" } } },
          },
        ]),
      ),
    }),
    address,
  );
  return Result.isSuccess(read) ? read.success : assert.fail(read.failure);
};

const original = document([{ path: "/status", operationId: "getStatus" }]);
const generation = (over: Partial<Parameters<typeof generateProvider>[0]> = {}) =>
  generateProvider({
    provider: "widgetly",
    today: "2026-10-06",
    document: original,
    core: undefined,
    previous: undefined,
    lock: [],
    ...over,
  });
type Generated = Effect.Success<ReturnType<typeof generateProvider>>;
const extended = (made: Generated) => made.extended ?? assert.fail("no extended file");
const task = (made: Generated, id: string) =>
  extended(made).file.endpoints.find((one) => one.id === id) ?? assert.fail(`no ${id}`);
const rerun = (before: Generated, over: Partial<Parameters<typeof generateProvider>[0]> = {}) =>
  generation({
    core: before.created?.text,
    previous: extended(before).text,
    lock: before.lock,
    ...over,
  });

const assertLoads = Effect.fnUntraced(function* (made: Generated, core: string) {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* copyDirectory(catalogFixtures.clean);
  const provider = extended(made).file.provider;
  yield* fs.writeFileString(`${directory}/providers/${provider}.yaml`, core);
  yield* fs.writeFileString(
    `${directory}/providers/${provider}.extended.yaml`,
    extended(made).text,
  );
  const lock = JSON.parse(yield* fs.readFileString(`${directory}/ids.lock.json`)) as string[];
  yield* fs.writeFileString(
    `${directory}/ids.lock.json`,
    JSON.stringify([...new Set([...lock, ...made.lock])]),
  );
  assert.deepStrictEqual((yield* Catalog.validate(directory)).issues.map(formatIssue), []);
}, Effect.scoped);

// A vendor that takes both an organization's key and OAuth, each operation on OAuth.
const keyAndOAuth = (paths: ReadonlyArray<string>) => {
  const read = readOpenApi(
    JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Widgetly", version: "1.0.0" },
      servers: [{ url: "https://api.widgetly.example" }],
      externalDocs: { url: "https://docs.widgetly.example" },
      components: {
        securitySchemes: {
          apiKey: { type: "apiKey", in: "header", name: "X-Widgetly-Key" },
          oauth: {
            type: "oauth2",
            flows: {
              authorizationCode: {
                authorizationUrl: "https://auth.widgetly.example/authorize",
                tokenUrl: "https://auth.widgetly.example/token",
                scopes: { profile: "Profile" },
              },
            },
          },
        },
      },
      paths: Object.fromEntries(
        paths.map((path) => [
          path,
          {
            get: {
              operationId: `get${path.replaceAll("/", "-")}`,
              security: [{ oauth: ["profile"] }],
              responses: { 200: { description: "Ok" } },
            },
          },
        ]),
      ),
    }),
    address,
  );
  return Result.isSuccess(read) ? read.success : assert.fail(read.failure);
};

layer(BunServices.layer)("provider generation", (it) => {
  it.effect("keeps a vendor's OAuth for users when it is generated again beside a key", () =>
    Effect.gen(function* () {
      const first = yield* generation({ document: keyAndOAuth(["/me"]) });
      const again = yield* rerun(first, { document: keyAndOAuth(["/me", "/me/widgets"]) });
      const principals = extended(again).file.endpoints.map(({ principal }) => principal);
      assert.deepStrictEqual(principals, ["user", "user"]);
    }),
  );

  it.effect(
    "keeps a published route's id and reviewed facts when an earlier slug collision arrives",
    () =>
      Effect.gen(function* () {
        const first = yield* generation();
        const edited = {
          ...extended(first).file,
          endpoints: extended(first).file.endpoints.map((one) => ({
            ...one,
            name: "Reviewed availability",
            verified: "2026-10-01",
          })),
        };
        const again = yield* rerun(first, {
          previous: stringify(edited),
          document: document([
            { path: "/aaa", operationId: "get-status" },
            { path: "/status", operationId: "getStatus" },
          ]),
        });
        const status = task(again, "widgetly.x.get-status");
        assert.strictEqual(status.path, "/status");
        assert.strictEqual(status.name, "Reviewed availability");
        assert.strictEqual(status.verified, "2026-10-01");
        const fresh = task(again, "widgetly.x.get-status-2");
        assert.strictEqual(fresh.path, "/aaa");
        assert.notProperty(fresh, "verified");
        assert.notStrictEqual(fresh.name, status.name);
      }),
  );

  it.effect("keeps one live task and its id when the vendor renames the operation", () =>
    Effect.gen(function* () {
      const first = yield* generation();
      const again = yield* rerun(first, {
        document: document([{ path: "/status", operationId: "healthCheck" }]),
      });
      assert.deepStrictEqual(
        extended(again).file.endpoints.map(({ id }) => id),
        ["widgetly.x.get-status"],
      );
      assert.deepStrictEqual(extended(again).stale, []);
      assert.strictEqual(task(again, "widgetly.x.get-status").path, "/status");
    }),
  );

  it.effect(
    "reserves published and locked ids when a route disappears, then restores its original id",
    () =>
      Effect.gen(function* () {
        const core = stringify({
          endpoints: [{ id: "widgetly.x.get-status-2", method: "GET", path: "/core-only" }],
        });
        const first = yield* generation({ core, lock: ["widgetly.x.get-status-2"] });
        const moved = yield* rerun(first, {
          core,
          document: document([{ path: "/other", operationId: "getStatus" }]),
        });
        assert.strictEqual(task(moved, "widgetly.x.get-status").path, "/status");
        assert.strictEqual(task(moved, "widgetly.x.get-status").status, "retired");
        assert.strictEqual(task(moved, "widgetly.x.get-status-3").path, "/other");
        const restored = yield* generation({
          document: document([
            { path: "/status", operationId: "renamedStatus" },
            { path: "/other", operationId: "getStatus" },
          ]),
          core,
          previous: extended(moved).text,
          lock: moved.lock,
        });
        assert.notProperty(task(restored, "widgetly.x.get-status"), "status");
        assert.strictEqual(task(restored, "widgetly.x.get-status").path, "/status");
        assert.strictEqual(task(restored, "widgetly.x.get-status-3").path, "/other");
      }),
  );

  it.effect("does not reassign a collision's suffix when its earlier route is deleted", () =>
    Effect.gen(function* () {
      const first = yield* generation({
        document: document([
          { path: "/aaa", operationId: "get-status" },
          { path: "/status", operationId: "getStatus" },
        ]),
      });
      const again = yield* rerun(first);
      assert.strictEqual(task(again, "widgetly.x.get-status").path, "/aaa");
      assert.strictEqual(task(again, "widgetly.x.get-status").status, "retired");
      assert.strictEqual(task(again, "widgetly.x.get-status-2").path, "/status");
      assert.notProperty(task(again, "widgetly.x.get-status-2"), "status");
    }),
  );

  it.effect("reserves a previous file's id even when its lock never held it", () =>
    Effect.gen(function* () {
      const first = yield* generation();
      const again = yield* rerun(first, {
        lock: [],
        document: document([{ path: "/other", operationId: "getStatus" }]),
      });
      assert.strictEqual(task(again, "widgetly.x.get-status-2").path, "/other");
      assert.notInclude(
        extended(again).file.endpoints.map(({ id }) => id),
        "widgetly.x.get-status",
      );
    }),
  );

  it.effect(
    "retires a locked id when core takes its route, and restores it if core releases it",
    () =>
      Effect.gen(function* () {
        const first = yield* generation();
        const core = parseDocument(first.created?.text ?? assert.fail("no core"));
        core.set("endpoints", [
          { ...task(first, "widgetly.x.get-status"), id: "widgetly.status.get" },
        ]);
        const promoted = yield* rerun(first, {
          core: String(core),
          lock: [...first.lock, "widgetly.status.get"],
        });
        assert.strictEqual(task(promoted, "widgetly.x.get-status").status, "retired");
        assert.strictEqual(
          task(promoted, "widgetly.x.get-status").superseded_by,
          "widgetly.status.get",
        );
        const restored = yield* generation({
          core: first.created?.text,
          previous: extended(promoted).text,
          lock: promoted.lock,
        });
        assert.notProperty(task(restored, "widgetly.x.get-status"), "status");
        assert.notProperty(task(restored, "widgetly.x.get-status"), "superseded_by");
      }),
  );

  it.effect("repairs an older file's two published ids for the same route", () =>
    Effect.gen(function* () {
      const first = yield* generation();
      const duplicate = { ...task(first, "widgetly.x.get-status"), id: "widgetly.x.health-check" };
      const again = yield* rerun(first, {
        previous: stringify({
          ...extended(first).file,
          endpoints: [...extended(first).file.endpoints, duplicate],
        }),
        lock: [...first.lock, duplicate.id],
      });
      assert.notProperty(task(again, "widgetly.x.get-status"), "status");
      assert.strictEqual(task(again, duplicate.id).status, "retired");
      assert.strictEqual(task(again, duplicate.id).superseded_by, "widgetly.x.get-status");

      const core = parseDocument(first.created?.text ?? assert.fail("no core"));
      core.set("endpoints", [
        { ...task(first, "widgetly.x.get-status"), id: "widgetly.status.get" },
      ]);
      const promoted = yield* generation({
        core: String(core),
        previous: extended(again).text,
        lock: [...again.lock, "widgetly.status.get"],
      });
      assert.strictEqual(
        task(promoted, "widgetly.x.get-status").superseded_by,
        "widgetly.status.get",
      );
      assert.strictEqual(task(promoted, duplicate.id).superseded_by, "widgetly.status.get");

      core.set("endpoints", []);
      const gone = yield* generation({
        document: document([]),
        core: String(core),
        previous: extended(promoted).text,
        lock: promoted.lock,
      });
      assert.notProperty(task(gone, "widgetly.x.get-status"), "superseded_by");
      assert.notProperty(task(gone, duplicate.id), "superseded_by");
    }),
  );

  it.effect(
    "allows core to keep a published id on its route, and refuses to move that id to another route",
    () =>
      Effect.gen(function* () {
        const first = yield* generation();
        const core = parseDocument(first.created?.text ?? assert.fail("no core"));
        core.set("endpoints", [task(first, "widgetly.x.get-status")]);
        const promoted = yield* rerun(first, { core: String(core) });
        assert.deepStrictEqual(extended(promoted).file.endpoints, []);
        assert.deepStrictEqual(promoted.lock, first.lock);
        core.set("endpoints", [{ ...task(first, "widgetly.x.get-status"), path: "/unrelated" }]);
        const refused = yield* rerun(first, { core: String(core) }).pipe(Effect.flip);
        assert.include(refused.message, "reassigns widgetly.x.get-status");
      }),
  );

  it.effect("writes the same bytes and no lock update when only the day changes", () =>
    Effect.gen(function* () {
      const first = yield* generation();
      const again = yield* rerun(first, { today: "2026-11-30" });
      assert.strictEqual(extended(again).text, extended(first).text);
      assert.deepStrictEqual(again.lock, first.lock);
      assert.isUndefined(again.lockText);
      assert.isUndefined(again.created);
    }),
  );

  it.effect("chooses core's live poll after its retired predecessor and maps the placeholder", () =>
    Effect.gen(function* () {
      const read = readOpenApi(
        readFileSync(openApiFixtures.jobs, "utf8"),
        "https://api.jobs.example/openapi.json",
      );
      const jobs = Result.isSuccess(read) ? read.success : assert.fail(read.failure);
      const first = yield* generation({ provider: "jobs", document: jobs });
      const poll = task(first, "jobs.x.jobs-get");
      const core = parseDocument(first.created?.text ?? assert.fail("no core"));
      core.set("proposed_capabilities", { "web.job.state": "The state of a submitted job" });
      const curatedPoll = {
        ...poll,
        id: "jobs.jobs.get",
        capability: "web.job.state",
        platform: "web",
        output: { type: "object" },
        path: "/jobs/{id}",
        input: { pathParams: { id: poll.input?.pathParams?.job_id } },
        test_request: { pathParams: { id: "job_1" } },
      };
      core.set("endpoints", [
        {
          ...curatedPoll,
          id: "jobs.jobs.old",
          status: "retired",
          status_note: "jobs.jobs.get curates this route now",
          superseded_by: "jobs.jobs.get",
        },
        curatedPoll,
      ]);
      const again = yield* generation({
        provider: "jobs",
        document: jobs,
        core: String(core),
        previous: stringify({
          ...extended(first).file,
          endpoints: extended(first).file.endpoints.map((one) =>
            one.id === poll.id ? { ...one, capability: "web.job.state" } : one,
          ),
        }),
        lock: [...first.lock, "jobs.jobs.old", "jobs.jobs.get"],
      });
      assert.deepStrictEqual(task(again, "jobs.x.jobs-create").async?.poll, {
        task: "jobs.jobs.get",
        param: { in: "pathParams", name: "id" },
      });
      assert.strictEqual(task(again, "jobs.x.jobs-get").superseded_by, "jobs.jobs.get");

      const fs = yield* FileSystem.FileSystem;
      const directory = yield* copyDirectory(catalogFixtures.clean);
      yield* fs.writeFileString(`${directory}/providers/jobs.yaml`, String(core));
      yield* fs.writeFileString(`${directory}/providers/jobs.extended.yaml`, extended(again).text);
      const existing = JSON.parse(
        yield* fs.readFileString(`${directory}/ids.lock.json`),
      ) as string[];
      yield* fs.writeFileString(
        `${directory}/ids.lock.json`,
        JSON.stringify([...new Set([...existing, ...again.lock])]),
      );
      assert.deepStrictEqual((yield* Catalog.validate(directory)).issues.map(formatIssue), []);
      const catalog = yield* Catalog.pipe(Effect.provide(Catalog.layer(directory)));
      const old =
        Option.getOrUndefined(catalog.get("jobs.x.jobs-get")) ??
        assert.fail("published poll id vanished");
      assert.strictEqual(old.task.status, "retired");
      assert.strictEqual(old.task.superseded_by, "jobs.jobs.get");
      assert.notInclude(
        catalog.serving("web.job.state").map(({ task }) => task.id),
        old.task.id,
      );
      const found = catalog.search("state submitted job");
      assert.strictEqual(found._tag, "Found");
      if (found._tag === "Found")
        assert.notInclude(
          found.hits.map(({ task }) => task.id),
          old.task.id,
        );
    }).pipe(Effect.scoped),
  );

  it.effect("describes no async poll whose chosen task needs another required input", () =>
    Effect.gen(function* () {
      const source = readFileSync(openApiFixtures.jobs, "utf8");
      const read = readOpenApi(source, "https://api.jobs.example/openapi.json");
      const jobs = Result.isSuccess(read) ? read.success : assert.fail(read.failure);
      const first = yield* generation({ provider: "jobs", document: jobs });
      const poll = task(first, "jobs.x.jobs-get");
      for (const location of ["queryParams", "body", "headers"] as const) {
        for (const required of [true, false]) {
          const core = parseDocument(first.created?.text ?? assert.fail("no core"));
          core.set("proposed_capabilities", { "web.job.state": "The state of a submitted job" });
          core.set("endpoints", [
            {
              ...poll,
              id: "jobs.jobs.get",
              capability: "web.job.state",
              platform: "web",
              output: { type: "object" },
              input: {
                ...poll.input,
                [location]: { region: { type: "string", required, default: "east" } },
              },
              test_request: {
                ...poll.test_request,
                ...(required ? { [location]: { region: "east" } } : {}),
              },
            },
          ]);
          const made = yield* generation({
            provider: "jobs",
            document: jobs,
            core: String(core),
            lock: ["jobs.jobs.get"],
          });
          if (required) assert.notProperty(task(made, "jobs.x.jobs-create"), "async");
          else
            assert.deepStrictEqual(task(made, "jobs.x.jobs-create").async?.poll, {
              task: "jobs.jobs.get",
              param: { in: "pathParams", name: "job_id" },
            });
          yield* assertLoads(made, String(core));
        }
      }

      const patched = readOpenApi(source, jobs.url, [
        {
          op: "add",
          path: "/paths/~1jobs~1{job_id}/get/parameters/-",
          value: {
            name: "region",
            in: "query",
            required: true,
            schema: { type: "string", default: "east" },
            example: "east",
          },
        },
      ]);
      const withRequiredQuery = Result.isSuccess(patched)
        ? patched.success
        : assert.fail(patched.failure);
      const made = yield* generation({ provider: "jobs", document: withRequiredQuery });
      assert.notProperty(task(made, "jobs.x.jobs-create"), "async");
      yield* assertLoads(made, made.created?.text ?? assert.fail("no core"));

      const twoPaths = readOpenApi(source, jobs.url, [
        {
          op: "add",
          path: "/paths/~1jobs~1{job_id}~1{region}",
          value: {
            get: {
              operationId: "jobs.get",
              parameters: [
                {
                  name: "job_id",
                  in: "path",
                  required: true,
                  schema: { type: "string" },
                  example: "job_1",
                },
                {
                  name: "region",
                  in: "path",
                  required: true,
                  schema: { type: "string" },
                  example: "east",
                },
              ],
              responses: {
                200: {
                  description: "Job state",
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: {
                          status: { type: "string", enum: ["done", "error", "running"] },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        { op: "remove", path: "/paths/~1jobs~1{job_id}" },
      ]);
      const withTwoPaths = Result.isSuccess(twoPaths)
        ? twoPaths.success
        : assert.fail(twoPaths.failure);
      assert.notProperty(
        task(yield* generation({ provider: "jobs", document: withTwoPaths }), "jobs.x.jobs-create"),
        "async",
      );
      const core = parseDocument(first.created?.text ?? assert.fail("no core"));
      core.set("endpoints", [
        {
          ...poll,
          id: "jobs.jobs.get",
          path: "/jobs/{id}/{zone}",
          input: {
            pathParams: { id: { type: "string" }, zone: { type: "string", required: false } },
          },
        },
      ]);
      assert.notProperty(
        task(
          yield* generation({ provider: "jobs", document: withTwoPaths, core: String(core) }),
          "jobs.x.jobs-create",
        ),
        "async",
      );
    }),
  );

  it.effect("without a document writes only a new core header and leaves the lock alone", () =>
    Effect.gen(function* () {
      const made = yield* generation({ document: undefined, lock: ["published.id"] });
      assert.strictEqual(parse(made.created?.text ?? assert.fail("no core")).source.openapi, null);
      assert.isUndefined(made.extended);
      assert.deepStrictEqual(made.lock, ["published.id"]);
      assert.isUndefined(made.lockText);
    }),
  );

  it.effect(
    "refuses missing published history while allowing a fresh provider beside other providers' ids",
    () =>
      Effect.gen(function* () {
        const refused = yield* generation({ lock: ["widgetly.x.get-status"] }).pipe(Effect.flip);
        assert.include(refused.message, "has no history for widgetly.x.get-status");
        assert.include(refused.message, "restore");
        const fresh = yield* generation({ lock: ["acme.x.published"] });
        assert.strictEqual(task(fresh, "widgetly.x.get-status").path, "/status");
      }),
  );
});
