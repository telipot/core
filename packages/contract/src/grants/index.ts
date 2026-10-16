import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import { Cursor } from "../cursor";
import { Principal } from "../receipt";

// A revoked connection's grant stays as its tombstone. `revoked_by` is an `Actor`, a `user:`
// principal or `provider`; null on a grant revoked before it was recorded.
export const ConnectionGrant = Schema.Struct({
  id: Schema.String,
  scopes: Schema.Array(Schema.String),
  created_at: Schema.String,
  revoked_at: Schema.NullOr(Schema.String),
  revoked_by: Schema.NullOr(Schema.String),
});

const { id, ...allowed } = ConnectionGrant.fields;

export const Grant = Schema.Struct({
  id,
  connection_id: Schema.String,
  provider: Schema.String,
  principal: Schema.String,
  account: Schema.NullOr(Schema.String),
  ...allowed,
}).annotate({ identifier: "Grant" });

export type Grant = typeof Grant.Type;

export const grantsPage = 50;

// Newest first. A page never splits one millisecond's grants, so it may run a little past fifty,
// and none is skipped though grants change between pages.
export const GrantList = Schema.Struct({
  grants: Schema.Array(Grant),
  next_cursor: Schema.NullOr(Schema.String),
}).annotate({ identifier: "GrantList" });

// A grant is active until its connection is revoked.
export const GrantState = Schema.Literals(["active", "revoked"]);

export class GrantsApi extends HttpApiGroup.make("grants").add(
  HttpApiEndpoint.get("list", "/grants", {
    query: {
      cursor: Schema.optionalKey(Cursor),
      principal: Schema.optionalKey(Principal),
      state: Schema.optionalKey(GrantState),
    },
    success: GrantList,
  }),
) {}
