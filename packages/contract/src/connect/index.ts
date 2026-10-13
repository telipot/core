import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import { PrincipalForbidden, RoleForbidden } from "../caller";
import { Cursor } from "../cursor";
import { CatalogId, FreeText } from "../free-text";
import { problem } from "../problem";
import { EndUserPrincipal, Principal } from "../receipt";
import { RateLimited } from "../tasks";

const loopback = ["localhost", "127.0.0.1"] as const;

export const RedirectUri = FreeText(2000).check(
  Schema.makeFilter((text) => {
    if (!URL.canParse(text)) return "an absolute URL";
    const url = new URL(text);
    const onThisMachine = loopback.some((host) => host === url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && onThisMachine)) {
      return `https, or http on ${loopback.join(" or ")}`;
    }
    if (text.includes("#")) return "an address with no fragment";
    if (url.username !== "" || url.password !== "") return "an address with no user or password";
    return true;
  }),
);

// Matched on scheme, host, port and path, so an entry carries no query.
export const RedirectAllowlist = Schema.Struct({
  redirect_uris: Schema.Array(
    RedirectUri.check(
      Schema.makeFilter((text) => !text.includes("?") || "an address with no query"),
    ),
  ).check(Schema.isMaxLength(50)),
}).annotate({ identifier: "RedirectAllowlist" });
export type RedirectAllowlist = typeof RedirectAllowlist.Type;

export const NewConnectSession = Schema.Struct({
  provider: CatalogId,
  principal: Principal,
  // Catalog scope names; left out, those the principal's tasks on the provider require, except
  // those only actions need. A provider that takes the organization's key asks for none.
  scopes: Schema.optionalKey(Schema.Array(CatalogId).check(Schema.isMaxLength(100))),
  // On the redirect allowlist, or the dashboard for the organization or a member's session; gets
  // `session_id` and `status` appended on completion.
  redirect_uri: RedirectUri,
  label: Schema.optionalKey(FreeText(200)),
}).annotate({ identifier: "NewConnectSession" });

export const ConnectSessionCreated = Schema.Struct({
  session_id: Schema.String,
  // The hosted page to send the person to; it works once, until `expires_at`.
  url: Schema.String,
  expires_at: Schema.String,
}).annotate({ identifier: "ConnectSessionCreated", httpApiStatus: 201 });

// The statuses `@telipot/credentials` reads a session in; `connect.test.ts` holds the two equal.
export const ConnectSessionStatus = Schema.Literals(["pending", "completed", "expired"]);
export type ConnectSessionStatus = typeof ConnectSessionStatus.Type;

export const ConnectSession = Schema.Struct({
  session_id: Schema.String,
  provider: Schema.String,
  principal: Schema.String,
  status: ConnectSessionStatus,
  // The connection the session made, once it completes.
  connection_id: Schema.NullOr(Schema.String),
  expires_at: Schema.String,
}).annotate({ identifier: "ConnectSession" });

// What the organization's list shows of a session; never its PKCE verifier.
export const ConnectSessionRecord = Schema.Struct({
  ...ConnectSession.fields,
  created_at: Schema.String,
  label: Schema.NullOr(Schema.String),
  // The catalog's names for the scopes it asks.
  scopes: Schema.Array(Schema.String),
  redirect_uri: Schema.String,
  // The connection it adds scopes to, or signs in again, instead of making one.
  adds_to: Schema.NullOr(Schema.String),
}).annotate({ identifier: "ConnectSessionRecord" });

export const connectSessionsPage = 50;

// Newest first. A page never splits one millisecond's sessions, so it may run a little past fifty,
// and none is skipped between pages. The hourly sweep deletes sessions a day past expiry.
export const ConnectSessionList = Schema.Struct({
  sessions: Schema.Array(ConnectSessionRecord),
  next_cursor: Schema.NullOr(Schema.String),
}).annotate({ identifier: "ConnectSessionList" });

// A page listing one end user's own connections for them to revoke; never the organization's.
export const NewConnectionsPage = Schema.Struct({ principal: EndUserPrincipal }).annotate({
  identifier: "NewConnectionsPage",
});

export const ConnectionsPageCreated = Schema.Struct({
  // The page to hand the end user; it opens as often as they like until `expires_at`.
  url: Schema.String,
  expires_at: Schema.String,
}).annotate({ identifier: "ConnectionsPageCreated", httpApiStatus: 201 });

// Another organization's session answers the same.
export class ConnectSessionNotFound extends Schema.TaggedError<ConnectSessionNotFound>()(
  "ConnectSessionNotFound",
  { detail: Schema.String },
) {
  static readonly problem = problem(this, { status: 404, code: "connect_session_not_found" });
}

// The provider connects only through the organization's own OAuth app, such as Gmail, whose
// restricted scopes Google lets no shared app ask for, and the organization has set none.
export class OAuthAppRequired extends Schema.TaggedError<OAuthAppRequired>()("OAuthAppRequired", {
  detail: Schema.String,
}) {
  static readonly problem = problem(this, { status: 409, code: "oauth_app_required" });
}

export class ConnectApi extends HttpApiGroup.make("connect")
  .add(
    HttpApiEndpoint.post("start", "/connect/sessions", {
      payload: NewConnectSession,
      success: ConnectSessionCreated,
      error: [
        RoleForbidden.problem,
        PrincipalForbidden.problem,
        RateLimited.problem,
        OAuthAppRequired.problem,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.get("list", "/connect/sessions", {
      query: {
        cursor: Schema.optionalKey(Cursor),
        principal: Schema.optionalKey(Principal),
        status: Schema.optionalKey(ConnectSessionStatus),
      },
      success: ConnectSessionList,
      error: [RoleForbidden.problem],
    }),
  )
  .add(
    HttpApiEndpoint.get("session", "/connect/sessions/:id", {
      params: { id: FreeText(100) },
      success: ConnectSession,
      error: [ConnectSessionNotFound.problem],
    }),
  )
  .add(
    HttpApiEndpoint.post("connectionsPage", "/connect/connections-pages", {
      payload: NewConnectionsPage,
      success: ConnectionsPageCreated,
      error: [RoleForbidden.problem],
    }),
  )
  .add(
    HttpApiEndpoint.get("redirectUris", "/connect/redirect-uris", {
      success: RedirectAllowlist,
    }),
  )
  .add(
    HttpApiEndpoint.put("replaceRedirectUris", "/connect/redirect-uris", {
      payload: RedirectAllowlist,
      success: RedirectAllowlist,
    }),
  ) {}
