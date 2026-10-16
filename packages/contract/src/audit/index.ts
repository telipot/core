import { Schema, Struct } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import { RoleForbidden } from "../caller";
import { Cursor } from "../cursor";
import { CatalogId, FreeText } from "../free-text";
import { problem } from "../problem";
import { IdentityMode, Principal, Receipt, Usd } from "../receipt";
import { TaskKind } from "../tasks";

// miss is the vendor's declared "no result"; fault is any other answer or none;
// pending means the vendor finishes the job later.
export const Outcome = Schema.Literals(["hit", "miss", "fault", "pending"]);
export type Outcome = typeof Outcome.Type;

const { connection, ...served } = Receipt.fields;

// Never holds a body. `request_hash` is hex HMAC-SHA-256 of the input with keys sorted, under
// REQUEST_HASH_SECRET, so a client cannot compute it.
export const Call = Schema.Struct({
  ...served,
  at: Schema.String,
  connection_id: connection,
  organization_id: Schema.String,
  token_id: Schema.NullOr(Schema.String),
  // True when a user-bound token fixed the principal; false for any other caller.
  principal_bound: Schema.Boolean,
  provider: Schema.String,
  kind: TaskKind,
  outcome: Outcome,
  upstream_status: Schema.NullOr(Schema.Int),
  tag: Schema.NullOr(Schema.String),
  idempotency_key: Schema.NullOr(Schema.String),
  request_hash: Schema.String,
}).annotate({ identifier: "Call" });

export type Call = typeof Call.Type;

export class CallNotFound extends Schema.TaggedError<CallNotFound>()("CallNotFound", {
  detail: Schema.String,
}) {
  static readonly problem = problem(this, { status: 404, code: "call_not_found" });
}

// Redacted before it is kept, and kept 24 hours.
export const Capture = Schema.Struct({
  call_id: Schema.String,
  task: Schema.String,
  at: Schema.String,
  expires_at: Schema.String,
  request: Schema.Json,
  response_status: Schema.NullOr(Schema.Int),
  response: Schema.NullOr(Schema.Json),
}).annotate({ identifier: "Capture" });

export type Capture = typeof Capture.Type;

// Debug capture was off, 24 hours passed, or the call is another organization's.
export class CaptureNotFound extends Schema.TaggedError<CaptureNotFound>()("CaptureNotFound", {
  detail: Schema.String,
}) {
  static readonly problem = problem(this, { status: 404, code: "capture_not_found" });
}

// About how many calls a page of `GET /v1/calls`, or captures one of `GET /v1/captures`, holds.
export const callsPage = 50;

// A call that named no principal acted for the organization, so `principal=organization` finds
// it too.
export const CallFilters = Schema.Struct({
  task: Schema.optionalKey(CatalogId),
  provider: Schema.optionalKey(CatalogId),
  principal: Schema.optionalKey(Principal),
  outcome: Schema.optionalKey(Outcome),
  token: Schema.optionalKey(FreeText(100)),
  connection: Schema.optionalKey(FreeText(100)),
});

export type CallFilters = typeof CallFilters.Type;

// Newest first. A page never splits one millisecond's calls, so it may run a little past fifty,
// and none is skipped or repeated though calls land between pages.
export const CallList = Schema.Struct({
  calls: Schema.Array(Call),
  next_cursor: Schema.NullOr(Schema.String),
}).annotate({ identifier: "CallList" });

// The UTC days usage counts, the last of them today so far.
export const usageDays = { choices: ["1", "7", "30"], default: "7" } as const;

// How many tasks, and principals, usage ranks by calls.
export const usageTop = 10;

// A count for each member of a closed set, zeros included.
const countsOf = <const Members extends ReadonlyArray<string>>(members: Members) =>
  Schema.Struct(
    Object.fromEntries(members.map((member) => [member, Schema.Int])) as {
      readonly [K in Members[number]]: typeof Schema.Int;
    },
  );

const perOutcome = countsOf(Outcome.literals);

// From the start of the first UTC day to now. `by_day` (oldest first) and `by_identity` include
// zeros; `by_task` and `by_principal` are most called first. A call naming no principal counts as
// `organization`.
export const Usage = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  calls: Schema.Int,
  outcomes: perOutcome,
  by_day: Schema.Array(
    Schema.Struct({
      day: Schema.String,
      calls: Schema.Int,
      ...perOutcome.fields,
      by_identity: countsOf(IdentityMode.literals),
    }),
  ),
  by_identity: Schema.Array(Schema.Struct({ identity: IdentityMode, calls: Schema.Int })),
  by_task: Schema.Array(
    Schema.Struct({
      task: Schema.String,
      provider: Schema.String,
      calls: Schema.Int,
      hits: Schema.Int,
      faults: Schema.Int,
    }),
  ),
  by_principal: Schema.Array(Schema.Struct({ principal: Schema.String, calls: Schema.Int })),
  // The distinct end users the calls named.
  end_users: Schema.Int,
  charged_usd: Usd,
}).annotate({ identifier: "Usage" });

export type Usage = typeof Usage.Type;

// A capture without its bodies, which only `GET /v1/calls/{id}/capture` answers.
export const CaptureSummary = Capture.mapFields((fields) =>
  Struct.omit(fields, ["request", "response"]),
).annotate({ identifier: "CaptureSummary" });

export type CaptureSummary = typeof CaptureSummary.Type;

// The captures not yet deleted, newest first, paged as `CallList` is.
export const CaptureList = Schema.Struct({
  captures: Schema.Array(CaptureSummary),
  next_cursor: Schema.NullOr(Schema.String),
}).annotate({ identifier: "CaptureList" });

export class AuditApi extends HttpApiGroup.make("audit")
  .add(
    HttpApiEndpoint.get("list", "/calls", {
      query: { cursor: Schema.optionalKey(Cursor), ...CallFilters.fields },
      success: CallList,
    }),
  )
  .add(
    HttpApiEndpoint.get("usage", "/usage", {
      query: {
        days: Schema.optionalKey(
          Schema.Literals(usageDays.choices).annotate({
            description: `How many UTC days to count, today's so far among them; ${usageDays.default} unless given.`,
          }),
        ),
        token: Schema.optionalKey(FreeText(100)),
      },
      success: Usage,
    }),
  )
  .add(
    HttpApiEndpoint.get("captures", "/captures", {
      query: { cursor: Schema.optionalKey(Cursor) },
      success: CaptureList,
      error: [RoleForbidden.problem],
    }),
  )
  .add(
    HttpApiEndpoint.get("call", "/calls/:id", {
      params: { id: FreeText(100) },
      success: Call,
      error: [CallNotFound.problem],
    }),
  )
  .add(
    HttpApiEndpoint.get("capture", "/calls/:id/capture", {
      params: { id: FreeText(100) },
      success: Capture,
      error: [CaptureNotFound.problem, RoleForbidden.problem],
    }),
  ) {}
