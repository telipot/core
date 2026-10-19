import { assert, describe, it } from "@effect/vitest";
import { Predicate, Schema } from "effect";
import { OpenApi } from "effect/http-api";

import {
  Api,
  Call,
  ConnectSession,
  ConnectSessionStatus,
  Filters,
  IdentityMode,
  Receipt,
  Task,
  TaskAuth,
  TaskKind,
  Tier,
} from "./index";

const WithProperties = Schema.Struct({ properties: Schema.Record(Schema.String, Schema.Unknown) });

describe("Api", () => {
  it("names bearer authentication on every /v1 operation, and on none outside it", () => {
    const spec = OpenApi.fromApi(Api);
    assert.strictEqual(spec.info.version, "1.0.0");
    assert.deepInclude(spec.components.securitySchemes["bearer"], {
      type: "http",
      scheme: "Bearer",
    });

    for (const [path, operations] of Object.entries(spec.paths)) {
      for (const operation of Object.values(operations)) {
        if (!Predicate.hasProperty(operation, "security")) continue;
        assert.deepStrictEqual(
          operation.security,
          path.startsWith("/v1/") ? [{ bearer: [] }] : [],
          path,
        );
      }
    }
  });

  it("describes the error shape once in the OpenAPI document", () => {
    const spec = OpenApi.fromApi(Api);
    assert.deepStrictEqual(Object.keys(spec.components.schemas).toSorted(), [
      "Call",
      "CallList",
      "CallerEncoded",
      "Capability",
      "Capture",
      "CaptureList",
      "CaptureSummary",
      "CatalogVersion",
      "ConnectConfirmation",
      "ConnectSession",
      "ConnectSessionCreated",
      "ConnectSessionList",
      "ConnectSessionRecord",
      "Connection",
      "ConnectionChange",
      "ConnectionDetail",
      "ConnectionList",
      "ConnectionsPageCreated",
      "Discover",
      "Discovery",
      "Filters",
      "Grant",
      "GrantList",
      "HeldUserBoundToken",
      "HeldUserBoundTokens",
      "NearMiss",
      "NewConnectSession",
      "NewConnection",
      "NewConnectionsPage",
      "NewOAuthApp",
      "NewUserBoundToken",
      "NewWebhook",
      "OAuthApp",
      "Price",
      "Principal",
      "PrincipalList",
      "PrincipalSummary",
      "ProblemDetails",
      "ProviderList",
      "ProviderSummary",
      "Receipt",
      "ReceiptOptions",
      "RedirectAllowlist",
      "Run",
      "RunBody",
      "Task",
      "TaskPage",
      "TaskSummary",
      "Usage",
      "UserBoundToken",
      "Webhook",
      "WebhookCreated",
      "WebhookDelivery",
      "WebhookDeliveryList",
      "WebhookList",
    ]);

    const problem = { $ref: "#/components/schemas/ProblemDetails" };
    const schemaAt = (status: number) =>
      spec.paths["/v1/me"]?.get?.responses[status]?.content?.["application/problem+json"]?.schema;

    assert.deepStrictEqual(schemaAt(401), { anyOf: [problem, problem] });
    assert.deepStrictEqual(schemaAt(403), { anyOf: [problem, problem, problem] });
    assert.deepStrictEqual(schemaAt(400), problem);
    assert.deepStrictEqual(schemaAt(413), problem);
    assert.deepStrictEqual(schemaAt(500), problem);
  });

  it("lists invalid input, a body too large and an internal error on every endpoint, by code", () => {
    const spec = OpenApi.fromApi(Api);
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const method of ["get", "post", "put", "patch", "delete"] as const) {
        const operation = item[method];
        if (Predicate.isUndefined(operation)) continue;
        const codes = (status: number) =>
          operation.responses[status]?.description.split(" | ") ?? [];

        assert.include(codes(400), "invalid_input", `${method} ${path}`);
        assert.include(codes(413), "payload_too_large", `${method} ${path}`);
        assert.include(codes(500), "internal_error", `${method} ${path}`);
        assert.notInclude(
          Object.values(operation.responses).flatMap(({ description }) => description.split(" | ")),
          "route_not_found",
          `${method} ${path}`,
        );
      }
    }
  });

  it("describes every free-text input's maximum length and its refusal of a NUL or a lone surrogate", () => {
    const spec = OpenApi.fromApi(Api);
    const bounded = (maxLength: number) => ({
      maxLength,
      pattern: "^[^\\x00]*$",
      description: "Text without a NUL or a lone surrogate.",
    });

    const pathId = (path: string) => spec.paths[path]?.get?.parameters[0]?.schema;
    const property = (schema: string, name: string) =>
      Schema.decodeUnknownSync(WithProperties)(spec.components.schemas[schema]).properties[name];

    assert.deepInclude(property("Discover", "task"), bounded(500));
    assert.deepInclude(property("Filters", "provider"), bounded(100));
    assert.deepInclude(pathId("/v1/tasks/{id}"), bounded(100));
    assert.deepInclude(pathId("/v1/capabilities/{id}"), bounded(100));
  });

  it("serves every endpoint but the health check under /v1, behind the caller", () => {
    const spec = OpenApi.fromApi(Api);
    for (const [path, item] of Object.entries(spec.paths)) {
      if (path === "/health") continue;
      assert.match(path, /^\/v1\//);
      for (const method of ["get", "post", "put", "patch", "delete"] as const) {
        const operation = item[method];
        if (operation) assert.property(operation.responses, "401", `${method} ${path}`);
      }
    }
  });
});

describe("ConnectSession", () => {
  const read = Schema.decodeUnknownSync(ConnectSession);
  const session = (status: string) => ({
    session_id: "cs_01J0000000000000000000000",
    provider: "google-calendar",
    principal: "user:ana",
    status,
    connection_id: null,
    expires_at: "2026-10-17T09:00:00.000Z",
    account: null,
    account_label: null,
  });

  // A newer server's, or one a rollback's client never knew, so the rest of a list still reads.
  it("reads a status this client does not know as unknown, and every other as it is", () => {
    assert.strictEqual(read(session("paused")).status, "unknown");
    for (const status of ConnectSessionStatus.literals) {
      assert.strictEqual(read(session(status)).status, status);
    }

    assert.throws(() => read(session("x".repeat(65))));
  });
});

describe("an answer's growing sets", () => {
  const receipt = (fields: Record<string, string>) =>
    Schema.decodeSync(Receipt)({
      call_id: "call_1",
      task: "acme.x.get",
      identity: "user",
      principal: "user:ana",
      connection: null,
      account: null,
      credential_source: "byoc",
      quoted_usd: "0",
      charged_usd: "0",
      latency_ms: 12,
      ...fields,
    });

  // Every field a newer server may add a value to reads that value as unknown, not a failure.
  it("read a value this client does not know as unknown, and every other as it is", () => {
    assert.strictEqual(receipt({ identity: "delegated" }).identity, "unknown");
    assert.strictEqual(receipt({ credential_source: "pooled" }).credential_source, "unknown");
    for (const identity of IdentityMode.literals) {
      assert.strictEqual(receipt({ identity }).identity, identity);
    }

    for (const [field, known] of [
      ["kind", TaskKind],
      ["tier", Tier],
      ["auth", TaskAuth],
    ] as const) {
      const read = Schema.decodeUnknownSync(Task.fields[field]);
      assert.strictEqual(read("newer"), "unknown");
      for (const value of known.literals) assert.strictEqual(read(value), value);
    }

    assert.strictEqual(Schema.decodeSync(Call.fields.outcome)("retried"), "unknown");
  });

  it("stay strict in a request", () => {
    assert.isFalse(Schema.is(Filters.fields.kind)("newer"));
  });
});
