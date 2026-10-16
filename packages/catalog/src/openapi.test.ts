import { assert, describe, it } from "@effect/vitest";
import { openApiFixtures } from "@telipot/fixtures/openapi";
import { Result } from "effect";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { schemaModeline } from "./json-schema";
import { type OpenApi, type SpecPatch, readOpenApi, scaffold, schemesOf, tasksOf } from "./openapi";

interface Header {
  readonly auth: { readonly schemes: Readonly<Record<string, unknown>> };
  readonly source: { readonly openapi: string | null; readonly [field: string]: unknown };
  readonly [field: string]: unknown;
}

const specUrl = "https://api.widgetly.example/openapi.json";
const text = readFileSync(openApiFixtures.widgetly, "utf8");

const widgetly = (): OpenApi => {
  const read = readOpenApi(text, specUrl);
  return Result.isSuccess(read) ? read.success : assert.fail(read.failure);
};

const schemes = schemesOf({
  apiKey: { type: "api_key", in: "header", name: "X-Widgetly-Key", principals: ["organization"] },
  oauth: { type: "oauth2", principals: ["user"] },
});

const generated = () => {
  const { tasks, leftOut } = tasksOf(widgetly(), "widgetly", schemes);
  const byId = (id: string) => tasks.find((task) => task.id === id) ?? assert.fail(`no ${id}`);
  return { tasks, leftOut, byId };
};

describe("readOpenApi", () => {
  it("reads YAML as well as JSON", () => {
    const yaml = "openapi: 3.1.0\ninfo: { title: Acme }\npaths: {}\n";
    assert.isTrue(Result.isSuccess(readOpenApi(yaml, specUrl)));
  });

  it("refuses a Swagger document, naming what it is", () => {
    const swagger = JSON.stringify({ swagger: "2.0", info: { title: "Old" }, paths: {} });
    const read = readOpenApi(swagger, specUrl);
    assert.isTrue(Result.isFailure(read));
    assert.include(Result.isFailure(read) ? read.failure : "", "OpenAPI 3");
  });

  it("refuses text that is not a document", () => {
    assert.isTrue(Result.isFailure(readOpenApi("<html>not found</html>", specUrl)));
  });
});

describe("scaffold", () => {
  const filled = () => scaffold("widgetly", "2026-10-06", widgetly());
  const header = () => parse(filled().text) as Header;

  it("takes the server relative to where the spec was fetched", () => {
    assert.strictEqual(header().base_url, "https://api.widgetly.example/v1");
  });

  it("names the provider from the spec's title, and records where the spec is", () => {
    assert.strictEqual(header().provider, "widgetly");
    assert.strictEqual(header().display_name, "Widgetly");
    assert.deepStrictEqual(header().source, {
      docs: null,
      openapi: specUrl,
      curated: "2026-10-06",
    });

    assert.strictEqual(header().version, "2026-10-06");
    assert.deepStrictEqual(header().endpoints, []);
  });

  it("declares the schemes it can, and writes the scopes as the provider's own strings", () => {
    assert.deepStrictEqual(header().auth.schemes.apiKey, {
      type: "api_key",
      in: "header",
      name: "X-Widgetly-Key",
      principals: ["organization"],
    });

    assert.deepStrictEqual(header().auth.schemes.oauth, {
      type: "oauth2",
      authorization_url: "https://auth.widgetly.example/authorize",
      token_url: "https://auth.widgetly.example/token",
      pkce: true,
      refresh: "static",
      principals: ["user"],
      scopes: { profile: "profile", "widgets.write": "widgets.write" },
    });

    assert.notProperty(header().auth.schemes, "session");
  });

  it("leaves null what the spec does not say, and flags each with its path", () => {
    assert.strictEqual(header().docs_url, null);
    assert.deepStrictEqual(header().identity, { task: null, account_path: null, label_path: null });
    const paths = filled().reviews.map(({ path }) => path);
    assert.deepStrictEqual(paths, [
      "display_name",
      "docs_url",
      "source.docs",
      "auth.schemes.oauth",
      "identity",
    ]);

    assert.isTrue(filled().text.startsWith(`# ${schemaModeline}\n\n# Review before`));
  });

  it("returns the schemes it declared, by name and type", () => {
    assert.deepStrictEqual(filled().schemes, schemes);
  });

  it("without a spec records openapi: null and flags what only a person knows", () => {
    const bare = scaffold("widgetly", "2026-10-06");
    const written = parse(bare.text) as Header;
    assert.strictEqual(written.source.openapi, null);
    assert.strictEqual(written.base_url, null);
    assert.strictEqual(written.display_name, "Widgetly");
    assert.deepStrictEqual(
      bare.reviews.map(({ path }) => path),
      ["display_name", "base_url", "docs_url", "source.docs"],
    );

    assert.deepStrictEqual(bare.schemes, {});
  });
});

describe("tasksOf", () => {
  it("makes a task of each operation, by id, and leaves out what it cannot serve", () => {
    const { tasks, leftOut } = generated();
    assert.deepStrictEqual(
      tasks.map(({ id }) => id),
      [
        "widgetly.x.create-widget",
        "widgetly.x.delete-widget",
        "widgetly.x.get-current-user",
        "widgetly.x.get-status",
        "widgetly.x.get-widget",
        "widgetly.x.get-widgets-widget-id-parts",
        "widgetly.x.list-widgets",
      ],
    );

    assert.deepStrictEqual(leftOut, [
      "GET /cookie-only: needs the session scheme, which a provider file does not declare",
      "GET /old-widgets: the spec marks it deprecated",
    ]);
  });

  it("types a path parameter from the document, with the example the provider gives", () => {
    assert.deepStrictEqual(generated().byId("widgetly.x.get-widget"), {
      id: "widgetly.x.get-widget",
      auth: "apiKey",
      scope: "any_account",
      method: "GET",
      path: "/widgets/{widgetId}",
      name: "Get a widget by id",
      summary: "Get a widget by id",
      docs_url: "https://docs.widgetly.example/widgets/get",
      input: { pathParams: { widgetId: { type: "string", required: true, example: "w_1" } } },
      test_request: { pathParams: { widgetId: "w_1" } },
    });
  });

  it("reads a shared parameter by reference, with its bounds, and keeps the provider's text", () => {
    const list = generated().byId("widgetly.x.list-widgets");
    assert.strictEqual(list.name, "List widgets");
    assert.strictEqual(list.summary, "Widgets the owner has, newest first.");
    assert.deepStrictEqual(list.input, {
      queryParams: {
        limit: {
          type: "integer",
          note: "How many widgets to return",
          default: 20,
          min: 1,
          max: 100,
        },
        owner: { type: "string", required: true, note: "The owner's handle" },
      },
    });
  });

  it("makes a task untestable, naming the field, when a required value has no example", () => {
    const list = generated().byId("widgetly.x.list-widgets");
    assert.notProperty(list, "test_request");
    assert.strictEqual(list.untestable, "no example value in the spec for owner");
  });

  it("makes a task untestable rather than send an empty request", () => {
    const status = generated().byId("widgetly.x.get-status");
    assert.notProperty(status, "test_request");
    assert.strictEqual(
      status.untestable,
      "nothing to send: an empty request may be answered, and billed, in full",
    );
  });

  it("writes a body field by field, and treats a write as an action no test replays", () => {
    const create = generated().byId("widgetly.x.create-widget");
    assert.strictEqual(create.kind, "action");
    assert.deepStrictEqual(create.input, {
      body: {
        name: {
          type: "string",
          required: true,
          example: "Sprocket",
          note: "What the widget is called",
        },
        size: { type: "integer", min: 1, max: 10 },
        tags: { type: "array" },
      },
      bodyType: "json",
    });

    assert.notProperty(create, "test_request");
    assert.strictEqual(
      create.untestable,
      "an action changes the provider's data, so no test replays it",
    );
  });

  it("names a task by method and path when the spec gives no operation id", () => {
    const parts = generated().byId("widgetly.x.get-widgets-widget-id-parts");
    assert.strictEqual(parts.name, "Parts a widget is made of");
    assert.deepStrictEqual(parts.test_request, { pathParams: { widgetId: "w_1" } });
    assert.deepStrictEqual(parts.input.queryParams, {
      kind: { type: "string", enum: ["gear", "spring"] },
    });
  });

  it("serves an operation with no security as public, with no scope", () => {
    const status = generated().byId("widgetly.x.get-status");
    assert.strictEqual(status.auth, "public");
    assert.notProperty(status, "scope");
  });

  it("serves an OAuth operation as the connected account's, with the scopes it asks", () => {
    const me = generated().byId("widgetly.x.get-current-user");
    assert.strictEqual(me.auth, "oauth");
    assert.strictEqual(me.scope, "own_account");
    // Widgetly also takes an organization's key, so its OAuth acts as a user.
    assert.strictEqual(me.principal, "user");
    assert.deepStrictEqual(me.required_scopes, ["profile"]);
    assert.notProperty(me, "test_request");
    assert.notProperty(me, "untestable");
    // With no principals named, the scheme serves the organization too.
    const { tasks } = tasksOf(widgetly(), "widgetly", { ...schemes, oauth: { type: "oauth2" } });
    assert.strictEqual(
      tasks.find(({ id }) => id === "widgetly.x.get-current-user")?.principal,
      "organization",
    );
  });

  it("is the same for the same document", () => {
    assert.deepStrictEqual(generated().tasks, generated().tasks);
  });
});

// As a framework writes one: no security or server, the key sent as a header parameter, and
// 3.1's `anyOf` with null for an optional value.
describe("a spec that declares no security", () => {
  const keyedUrl = "https://api.keyed.example/openapi.json";
  const keyedText = readFileSync(openApiFixtures.keyed, "utf8");
  const patch: SpecPatch = [
    {
      op: "add",
      path: "/components/securitySchemes",
      value: { key: { type: "apiKey", in: "header", name: "x-keyed-api-key" } },
    },
    { op: "add", path: "/security", value: [{ key: [] }] },
    { op: "add", path: "/paths/~1v1~1models/get/security", value: [] },
  ];

  const keyed = (with_: SpecPatch = []): OpenApi => {
    const read = readOpenApi(keyedText, keyedUrl, with_);
    return Result.isSuccess(read) ? read.success : assert.fail(read.failure);
  };

  const made = (with_: SpecPatch = patch) => {
    const { schemes } = scaffold("keyed", "2026-10-06", keyed(with_));
    const { tasks, leftOut } = tasksOf(keyed(with_), "keyed", schemes);
    const byId = (id: string) => tasks.find((task) => task.id === id) ?? assert.fail(`no ${id}`);
    return { tasks, leftOut, byId };
  };

  it("leaves out every operation whose security it does not declare, saying a patch can", () => {
    const { tasks, leftOut } = made([]);
    assert.deepStrictEqual(tasks, []);
    assert.include(
      leftOut,
      "GET /v1/clips/{clip_id}: the spec declares no security for it; a patch can declare it",
    );
  });

  it("reads the scheme and the security a patch adds, as if the vendor had written them", () => {
    const header = parse(scaffold("keyed", "2026-10-06", keyed(patch)).text) as Header;
    assert.deepStrictEqual(header.auth.schemes.key, {
      type: "api_key",
      in: "header",
      name: "x-keyed-api-key",
      principals: ["organization"],
    });

    const { byId } = made();
    assert.strictEqual(byId("keyed.x.get-clip").auth, "key");
    assert.strictEqual(byId("keyed.x.get-clip").scope, "any_account");
    // The patch removes the document's security from this one operation.
    assert.strictEqual(byId("keyed.x.get-models").auth, "public");
  });

  it("refuses a patch that does not apply, saying so", () => {
    const read = readOpenApi(keyedText, keyedUrl, [{ op: "remove", path: "/nowhere/at/all" }]);
    assert.isTrue(Result.isFailure(read));
    assert.include(Result.isFailure(read) ? read.failure : "", "the patch does not apply");
  });

  it("takes the server from where the spec was fetched, and the name without the words after it", () => {
    const header = parse(scaffold("keyed", "2026-10-06", keyed()).text) as Header;
    assert.strictEqual(header.base_url, "https://api.keyed.example");
    assert.strictEqual(header.display_name, "Keyed");
  });

  it("does not offer the key as an input, since the credential sets it", () => {
    const { byId } = made();
    assert.notProperty(byId("keyed.x.get-clip").input, "headers");
    assert.notProperty(byId("keyed.x.create-clip").input, "headers");
  });

  it("does not offer a key sent in the query as an input either, which the loader refuses", () => {
    const { byId } = made([
      {
        op: "add",
        path: "/components/securitySchemes",
        value: { key: { type: "apiKey", in: "query", name: "api_key" } },
      },
      { op: "add", path: "/security", value: [{ key: [] }] },
      {
        op: "add",
        path: "/paths/~1v1~1clips~1{clip_id}/get/parameters/-",
        value: { name: "API_KEY", in: "query", required: true, schema: { type: "string" } },
      },
    ]);

    assert.notProperty(byId("keyed.x.get-clip").input, "queryParams");
  });

  it("reads an example from the schema's own list, for a value to test with", () => {
    const clip = made().byId("keyed.x.get-clip");
    assert.deepStrictEqual(clip.input.pathParams, {
      clip_id: { type: "string", required: true, example: "clip_7" },
    });

    assert.deepStrictEqual(clip.test_request, { pathParams: { clip_id: "clip_7" } });
  });

  it("reads past a null in anyOf for the type, the bounds and a referenced enum", () => {
    const create = made().byId("keyed.x.create-clip");
    assert.deepStrictEqual(create.input.body, {
      text: { type: "string", required: true, example: "Hello" },
      mode: { type: "string", enum: ["fast", "slow"] },
      volume: { type: "number", min: 0, max: 2 },
    });
  });

  it("sends nothing it was not given an example for, so a list with no required field is untestable", () => {
    const list = made().byId("keyed.x.list-clips");
    assert.notProperty(list, "test_request");
    assert.strictEqual(
      list.untestable,
      "nothing to send: an empty request may be answered, and billed, in full",
    );
  });

  it("leaves out a deprecated parameter, and a body it cannot carry, saying why", () => {
    const { byId, leftOut } = made();
    assert.notProperty(byId("keyed.x.list-clips").input.queryParams, "sort");
    assert.deepStrictEqual(leftOut, [
      "POST /v1/clips/upload: its body is multipart, which a call's input cannot carry",
    ]);
  });
});

describe("a spec that uses more of OpenAPI", () => {
  const jobsUrl = "https://api.jobs.example/openapi.json";
  const jobsText = readFileSync(openApiFixtures.jobs, "utf8");
  const jobs = (patch: SpecPatch = []): OpenApi => {
    const read = readOpenApi(jobsText, jobsUrl, patch);
    return Result.isSuccess(read) ? read.success : assert.fail(read.failure);
  };

  const made = (patch: SpecPatch = []) => {
    const { schemes } = scaffold("jobs", "2026-10-06", jobs(patch));
    const { tasks, leftOut } = tasksOf(jobs(patch), "jobs", schemes);
    const byId = (id: string) => tasks.find((task) => task.id === id) ?? assert.fail(`no ${id}`);
    return { byId, leftOut };
  };

  it("describes a job a Link reads back, and when it is over", () => {
    assert.deepStrictEqual(made().byId("jobs.x.jobs-create").async, {
      id_from: "id",
      poll: { task: "jobs.x.jobs-get", param: { in: "pathParams", name: "job_id" } },
      status: {
        path: "status",
        success: ["done"],
        failure: ["error", "cancelled"],
        progress: ["queued", "running"],
      },
    });
  });

  it("follows a Link by operationRef, with its parameter qualified by where it goes", () => {
    assert.deepStrictEqual(made().byId("jobs.x.calls-start").async, {
      id_from: "call_id",
      poll: { task: "jobs.x.calls-get", param: { in: "pathParams", name: "call_id" } },
      status: {
        path: "status",
        success: ["done"],
        failure: ["failed"],
        progress: ["started", "in-progress"],
      },
    });
  });

  it("describes no job where no Link says how to read it back, or two Links could", () => {
    const { byId } = made();
    assert.notProperty(byId("jobs.x.jobs-cancel"), "async");
    assert.notProperty(byId("jobs.x.reports-create"), "async");
    assert.notProperty(byId("jobs.x.pages-create"), "async");
  });

  it("describes the job a patch links, as if the vendor had written the Link", () => {
    const linked = made([
      {
        op: "add",
        path: "/paths/~1reports/post/responses/200/links",
        value: {
          state: { operationId: "calls.get", parameters: { call_id: "$response.body#/call_id" } },
        },
      },
    ]);

    assert.strictEqual(linked.byId("jobs.x.reports-create").async?.id_from, "call_id");
  });

  it("leaves out an operation a task has no method for", () => {
    assert.include(made().leftOut, "QUERY /search: a task has no QUERY method");
  });

  it("serves an operation from the server its Path Item names", () => {
    assert.strictEqual(
      made().byId("jobs.x.uploads-list").base_url,
      "https://uploads.jobs.example/v1",
    );

    assert.notProperty(made().byId("jobs.x.jobs-get"), "base_url");
  });

  it("reads a Path Item by reference, and its explicitly optional security as public", () => {
    assert.strictEqual(made().byId("jobs.x.health").auth, "public");
  });

  it("reads an example from an Example Object's dataValue", () => {
    assert.deepStrictEqual(made().byId("jobs.x.jobs-get").test_request, {
      pathParams: { job_id: "job_1" },
    });
  });

  it("leaves out an operation that refers to another document, naming the reference", () => {
    assert.include(
      made().leftOut,
      "GET /elsewhere: it refers to common.yaml#/components/parameters/Page, which is not in this document",
    );
  });

  it("reads the bearer scheme the spec declares, and the title without its words", () => {
    const { text, schemes } = scaffold("jobs", "2026-10-06", jobs());
    const header = parse(text) as Header;
    assert.deepStrictEqual(schemes, {
      bearerAuth: {
        type: "bearer",
        place: { location: "headers", name: "Authorization" },
        principals: ["organization"],
      },
    });

    assert.strictEqual(header.display_name, "Jobs");
    assert.strictEqual(header.docs_url, "https://docs.jobs.example");
    assert.strictEqual(made().byId("jobs.x.jobs-create").auth, "bearerAuth");
  });
});
