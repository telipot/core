import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import { PrincipalForbidden, RoleForbidden } from "../caller";
import { CatalogId, FreeText } from "../free-text";
import { ConnectionGrant } from "../grants";
import { problem } from "../problem";
import { readable } from "../readable";
import { Principal, VendorCredential } from "../receipt";
import { ConnectionNotFound, RateLimited } from "../tasks";
import { Timestamp } from "../timestamp";

// The states `@telipot/db` checks a row against; `connections.test.ts` holds the two equal.
export const ConnectionState = Schema.Literals(["active", "needs_reauth", "revoked", "expired"]);

// Never the credential.
export const Connection = Schema.Struct({
  id: Schema.String,
  provider: Schema.String,
  principal: Schema.String,
  // The provider-side identity, or null where the provider names none.
  account: Schema.NullOr(Schema.String),
  label: Schema.NullOr(Schema.String),
  state: readable(ConnectionState),
  // Serves when the principal holds several on the provider and a call names none of them.
  default: Schema.Boolean,
  scopes: Schema.Array(Schema.String),
}).annotate({ identifier: "Connection" });

export type Connection = typeof Connection.Type;

export const ConnectionList = Schema.Struct({ connections: Schema.Array(Connection) }).annotate({
  identifier: "ConnectionList",
});

// Any state, revoked included; never the credential.
export const ConnectionDetail = Schema.Struct({
  ...Connection.fields,
  created_at: Timestamp,
  // Null for a credential that renews or never expires.
  expires_at: Schema.NullOr(Timestamp),
  grant: ConnectionGrant,
}).annotate({ identifier: "ConnectionDetail" });

// The organization's own key; an end user's connection comes through a connect session.
export const NewConnection = Schema.Struct({
  provider: CatalogId,
  principal: Schema.Literal("organization"),
  credential: VendorCredential,
  label: Schema.optionalKey(FreeText(200)),
}).annotate({ identifier: "NewConnection" });

// A field left out stays as it is. Making one the default clears the principal's other default
// on the provider.
export const ConnectionChange = Schema.Struct({
  default: Schema.optionalKey(Schema.Boolean),
  label: Schema.optionalKey(Schema.NullOr(FreeText(200))),
}).annotate({ identifier: "ConnectionChange" });

// The provider turned the key down when it was checked; nothing was saved.
export class CredentialRefused extends Schema.TaggedError<CredentialRefused>()(
  "CredentialRefused",
  { detail: Schema.String },
) {
  override get message() {
    return this.detail;
  }

  static readonly problem = problem(this, { status: 422, code: "credential_refused" });
}

// The probe, or the task naming the key's account, went unanswered, answered 429 or 5xx, or named
// no account, so the key could not be checked; nothing was saved.
export class ProbeUnavailable extends Schema.TaggedError<ProbeUnavailable>()("ProbeUnavailable", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail;
  }

  static readonly problem = problem(this, { status: 503, code: "probe_unavailable" });
}

export class ConnectionsApi extends HttpApiGroup.make("connections")
  .add(
    HttpApiEndpoint.post("add", "/connections", {
      payload: NewConnection,
      success: Connection,
      error: [
        RoleForbidden.problem,
        CredentialRefused.problem,
        RateLimited.problem,
        ProbeUnavailable.problem,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.get("list", "/connections", {
      query: { principal: Schema.optionalKey(Principal) },
      success: ConnectionList,
      error: PrincipalForbidden.problem,
    }),
  )
  .add(
    HttpApiEndpoint.get("get", "/connections/:id", {
      params: { id: FreeText(100) },
      success: ConnectionDetail,
      error: ConnectionNotFound.problem,
    }),
  )
  .add(
    HttpApiEndpoint.patch("update", "/connections/:id", {
      params: { id: FreeText(100) },
      payload: ConnectionChange,
      success: Connection,
      error: [RoleForbidden.problem, ConnectionNotFound.problem],
    }),
  )
  .add(
    HttpApiEndpoint.delete("revoke", "/connections/:id", {
      params: { id: FreeText(100) },
      success: Connection,
      error: [RoleForbidden.problem, ConnectionNotFound.problem],
    }),
  ) {}
