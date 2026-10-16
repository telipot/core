import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import { Cursor } from "../cursor";
import { FreeText } from "../free-text";

// The organization from its first connection, an end user from the first call or connect session
// naming them. Counts skip revoked connections.
export const PrincipalSummary = Schema.Struct({
  principal: Schema.String,
  created_at: Schema.String,
  connections: Schema.Int,
  // Turned down by the provider; they need a new sign-in or key.
  needs_reauth: Schema.Int,
  // Their providers, each once.
  providers: Schema.Array(Schema.String),
}).annotate({ identifier: "PrincipalSummary" });

export const principalsPage = 50;

// Newest first. A page never splits one millisecond's principals, so it may run a little past
// fifty, and none is skipped though principals arrive between pages.
export const PrincipalList = Schema.Struct({
  principals: Schema.Array(PrincipalSummary),
  next_cursor: Schema.NullOr(Schema.String),
}).annotate({ identifier: "PrincipalList" });

export class PrincipalsApi extends HttpApiGroup.make("principals").add(
  HttpApiEndpoint.get("list", "/principals", {
    query: {
      cursor: Schema.optionalKey(Cursor),
      // Case-insensitive substring of the principal.
      q: Schema.optionalKey(FreeText(140)),
    },
    success: PrincipalList,
  }),
) {}
