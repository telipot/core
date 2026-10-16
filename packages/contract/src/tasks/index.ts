import { Schema, Struct } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import { PrincipalForbidden } from "../caller";
import { CatalogId, FreeText } from "../free-text";
import { problem } from "../problem";
import {
  CatalogVersion,
  IdentityMode,
  PrincipalHeaders,
  RunHeaders,
  Receipt,
  ReceiptOptions,
} from "../receipt";

// Money is a decimal string, not a JSON number, so it stays exact.
export const Price = Schema.Union([
  Schema.Struct({ type: Schema.Literal("free") }),
  Schema.Struct({
    type: Schema.Literals(["per_call", "per_success", "per_result"]),
    // Floor is the cheapest price row; ceiling is what a call reserves.
    usd: Schema.NullOr(Schema.Struct({ floor: Schema.String, ceiling: Schema.String })),
    // currency is an ISO code, `credit`, or the vendor's meter name.
    native: Schema.NullOr(
      Schema.Struct({ floor: Schema.String, ceiling: Schema.String, currency: Schema.String }),
    ),
    per: Schema.Int,
    unit: Schema.String,
    source: Schema.NullOr(Schema.String),
    source_url: Schema.NullOr(Schema.String),
    checked: Schema.String,
    confidence: Schema.Literals(["verified", "documented", "inferred", "unknown"]),
  }),
]).annotate({ identifier: "Price" });

export type Price = typeof Price.Type;

// `source` marks this as the catalog's claim, not a measurement.
export const Verification = Schema.Union([
  Schema.Struct({
    source: Schema.Literal("catalog"),
    state: Schema.Literal("verified"),
    date: Schema.String,
  }),
  Schema.Struct({
    source: Schema.Literal("catalog"),
    state: Schema.Literals(["unverified", "untestable", "skipped"]),
    reason: Schema.String,
  }),
]);

export type Verification = typeof Verification.Type;

// core is curated by hand; extended is generated from the vendor's spec.
export const Tier = Schema.Literals(["core", "extended"]);
export type Tier = typeof Tier.Type;

// Not the glossary's "kind of data", which is how a task is reached.
export const TaskKind = Schema.Literals(["data", "action", "account", "utility"]);
export type TaskKind = typeof TaskKind.Type;

const JsonSchema = Schema.Record(Schema.String, Schema.Json);
export const Task = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  summary: Schema.String,
  // The slug `Telipot-Order` takes.
  provider: Schema.String,
  // The provider file's version this answer was read from, which a run may be pinned to.
  version: CatalogVersion,
  capability: Schema.NullOr(Schema.String),
  tier: Tier,
  kind: TaskKind,
  // OpenAPI security scheme types.
  auth: Schema.Literals(["public", "api_key", "oauth2", "basic", "bearer"]),
  scope: Schema.NullOr(Schema.Literals(["any_account", "own_account"])),
  principal: Schema.NullOr(Schema.Literals(["organization", "user"])),
  required_scopes: Schema.Array(Schema.String),
  input: JsonSchema,
  output: Schema.NullOr(JsonSchema),
  // Null means unpriced, which is not free.
  price: Schema.NullOr(Price),
  example: Schema.Json,
  terms: Schema.NullOr(Schema.Struct({ url: Schema.String, note: Schema.String })),
  verification: Schema.NullOr(Verification),
  identity: Schema.NullOr(IdentityMode),
  credential_in_place: Schema.Boolean,
}).annotate({ identifier: "Task" });

export type Task = typeof Task.Type;

// A task as `GET /v1/tasks` lists it: inspect's answer without its schemas and example.
export const TaskSummary = Task.mapFields(Struct.omit(["input", "output", "example"])).annotate({
  identifier: "TaskSummary",
});

export type TaskSummary = typeof TaskSummary.Type;

export const tasksPage = 50;

// Live tasks in catalog order; `total` counts every match. A server's catalog never changes while
// it runs, so pages neither skip nor repeat a task.
export const TaskPage = Schema.Struct({
  tasks: Schema.Array(TaskSummary),
  next_cursor: Schema.NullOr(Schema.String),
  total: Schema.Int,
}).annotate({ identifier: "TaskPage" });

export type TaskPage = typeof TaskPage.Type;

export class TaskNotFound extends Schema.TaggedError<TaskNotFound>()("TaskNotFound", {
  detail: Schema.String,
}) {
  static readonly problem = problem(this, { status: 404, code: "task_not_found" });
}

const tombstone = {
  detail: Schema.String,
  status_note: Schema.String,
  superseded_by: Schema.NullOr(Schema.String),
};

// Gone for good: an agent drops the id.
export class TaskRetired extends Schema.TaggedError<TaskRetired>()("TaskRetired", tombstone) {
  static readonly problem = problem(this, { status: 410, code: "task_retired" });
}

// Down until fixed: an agent keeps the id and uses another task meanwhile.
export class TaskBroken extends Schema.TaggedError<TaskBroken>()("TaskBroken", tombstone) {
  static readonly problem = problem(this, { status: 410, code: "task_broken" });
}

// The task's input sits at the top level, so no task input may use the key `receipt`.
export const RunBody = Schema.StructWithRest(
  Schema.Struct({ receipt: Schema.optionalKey(ReceiptOptions) }),
  [Schema.Record(Schema.String, Schema.Json)],
).annotate({ identifier: "RunBody" });

// `output` is the vendor's body, unchanged.
export const Run = Schema.Struct({ output: Schema.Json, receipt: Receipt }).annotate({
  identifier: "Run",
});

export type Run = typeof Run.Type;

const ranCall = { detail: Schema.String, call_id: Schema.String };

// The vendor's declared "no result" answer; nothing failed.
export class Miss extends Schema.TaggedError<Miss>()("Miss", ranCall) {
  static readonly problem = problem(this, { status: 404, code: "miss" });
}

// upstream_status and upstream_body are null when the vendor never answered.
export class UpstreamError extends Schema.TaggedError<UpstreamError>()("UpstreamError", {
  ...ranCall,
  upstream_status: Schema.NullOr(Schema.Int),
  upstream_body: Schema.NullOr(Schema.Json),
}) {
  static readonly problem = problem(this, { status: 502, code: "upstream_error" });
}

// Either our per-minute limit (nothing ran, so no call_id or body) or the
// vendor's own 429, relayed with its body.
export class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", {
  detail: Schema.String,
  call_id: Schema.NullOr(Schema.String),
  upstream_body: Schema.NullOr(Schema.Json),
}) {
  static readonly problem = problem(this, { status: 429, code: "rate_limited" });
}

// Null when no link can be made; the detail says why.
const ConnectUrl = Schema.NullOr(Schema.String);

export class NoCredential extends Schema.TaggedError<NoCredential>()("NoCredential", {
  detail: Schema.String,
  connect_url: ConnectUrl,
}) {
  static readonly problem = problem(this, { status: 402, code: "no_credential" });
}

// The task acts as an end user, and the call named none.
export class PrincipalRequired extends Schema.TaggedError<PrincipalRequired>()(
  "PrincipalRequired",
  { detail: Schema.String },
) {
  static readonly problem = problem(this, { status: 400, code: "principal_required" });
}

// The end user has not connected their own account; nobody else's connection serves.
export class GrantRequired extends Schema.TaggedError<GrantRequired>()("GrantRequired", {
  detail: Schema.String,
  connect_url: ConnectUrl,
}) {
  static readonly problem = problem(this, { status: 403, code: "grant_required" });
}

// The task acts in the organization's own account on the provider, and the organization has not
// connected one. The platform never serves such a task.
export class ConnectionRequired extends Schema.TaggedError<ConnectionRequired>()(
  "ConnectionRequired",
  { detail: Schema.String, connect_url: ConnectUrl },
) {
  static readonly problem = problem(this, { status: 403, code: "connection_required" });
}

// The chosen connection's grant lacks the scopes in `missing`, which its link asks for alone.
export class ScopeRequired extends Schema.TaggedError<ScopeRequired>()("ScopeRequired", {
  detail: Schema.String,
  connection: Schema.String,
  missing: Schema.Array(Schema.String),
  connect_url: ConnectUrl,
}) {
  static readonly problem = problem(this, { status: 403, code: "scope_required" });
}

// Nothing else was tried. `connection` is null for a credential sent with the call; `call_id` is
// null when the connection was already marked and no call ran; `connect_url` is null when
// `detail` says why there is none.
export class ConnectionInvalid extends Schema.TaggedError<ConnectionInvalid>()(
  "ConnectionInvalid",
  {
    detail: Schema.String,
    connection: Schema.NullOr(Schema.String),
    call_id: Schema.NullOr(Schema.String),
    connect_url: Schema.NullOr(Schema.String),
  },
) {
  static readonly problem = problem(this, { status: 401, code: "connection_invalid" });
}

// A connection a run names, or a route changes, that the organization does not hold; another
// organization's answers the same.
export class ConnectionNotFound extends Schema.TaggedError<ConnectionNotFound>()(
  "ConnectionNotFound",
  { detail: Schema.String },
) {
  static readonly problem = problem(this, { status: 404, code: "connection_not_found" });
}

// The run is pinned to a catalog version other than the one its provider is served at.
export class CatalogVersionMismatch extends Schema.TaggedError<CatalogVersionMismatch>()(
  "CatalogVersionMismatch",
  { detail: Schema.String, served_version: CatalogVersion },
) {
  static readonly problem = problem(this, { status: 409, code: "catalog_version_mismatch" });
}

// Never the connection's key.
const Candidate = Schema.Struct({
  id: Schema.String,
  label: Schema.NullOr(Schema.String),
  account: Schema.NullOr(Schema.String),
});

// Several connections could serve, none is the default, and the call named none of them.
export class ConnectionAmbiguous extends Schema.TaggedError<ConnectionAmbiguous>()(
  "ConnectionAmbiguous",
  { detail: Schema.String, candidates: Schema.Array(Candidate) },
) {
  static readonly problem = problem(this, { status: 409, code: "connection_ambiguous" });
}

// Another run under the same Idempotency-Key was still running when this one stopped waiting.
export class IdempotencyInFlight extends Schema.TaggedError<IdempotencyInFlight>()(
  "IdempotencyInFlight",
  { detail: Schema.String },
) {
  static readonly problem = problem(this, { status: 409, code: "idempotency_in_flight" });
}

// The connection the call named belongs to another principal.
export class ConnectionForbidden extends Schema.TaggedError<ConnectionForbidden>()(
  "ConnectionForbidden",
  { detail: Schema.String, connection: Schema.String },
) {
  static readonly problem = problem(this, { status: 403, code: "connection_forbidden" });
}

export class TasksApi extends HttpApiGroup.make("tasks")
  .add(
    HttpApiEndpoint.get("list", "/tasks", {
      // `q` is text a task's id, name or summary holds, in any case.
      query: {
        cursor: Schema.optionalKey(CatalogId),
        provider: Schema.optionalKey(CatalogId),
        capability: Schema.optionalKey(CatalogId),
        kind: Schema.optionalKey(TaskKind),
        q: Schema.optionalKey(FreeText(200)),
      },
      headers: PrincipalHeaders,
      success: TaskPage,
      error: PrincipalForbidden.problem,
    }),
  )
  .add(
    HttpApiEndpoint.get("inspect", "/tasks/:id", {
      params: { id: CatalogId },
      headers: PrincipalHeaders,
      success: Task,
      error: [
        TaskNotFound.problem,
        TaskRetired.problem,
        TaskBroken.problem,
        PrincipalForbidden.problem,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.post("run", "/tasks/:id/run", {
      params: { id: CatalogId },
      headers: RunHeaders,
      payload: RunBody,
      success: Run,
      error: [
        TaskNotFound.problem,
        TaskRetired.problem,
        TaskBroken.problem,
        PrincipalRequired.problem,
        PrincipalForbidden.problem,
        CatalogVersionMismatch.problem,
        NoCredential.problem,
        GrantRequired.problem,
        ConnectionRequired.problem,
        ScopeRequired.problem,
        ConnectionInvalid.problem,
        ConnectionAmbiguous.problem,
        ConnectionForbidden.problem,
        ConnectionNotFound.problem,
        IdempotencyInFlight.problem,
        Miss.problem,
        UpstreamError.problem,
        RateLimited.problem,
      ],
    }),
  ) {}
