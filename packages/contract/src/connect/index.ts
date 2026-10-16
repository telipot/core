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
  // Catalog scope names. When left out, those the principal's tasks on the provider need, less
  // those only actions need; a provider on the organization's key asks for none.
  scopes: Schema.optionalKey(Schema.Array(CatalogId).check(Schema.isMaxLength(100))),
  // On the redirect allowlist, or the dashboard for the organization or a member's session. Gets
  // `session_id` and `status` appended: `completed`, or, for an end user not sent back to the
  // dashboard, `consented` and the `code` the organization's backend confirms them with.
  redirect_uri: RedirectUri,
  label: Schema.optionalKey(FreeText(200)),
}).annotate({ identifier: "NewConnectSession" });

export const ConnectSessionCreated = Schema.Struct({
  session_id: Schema.String,
  // The hosted page to send the person to; it works once, until `expires_at`.
  url: Schema.String,
  expires_at: Schema.String,
}).annotate({ identifier: "ConnectSessionCreated", httpApiStatus: 201 });

// `connect.test.ts` holds these equal to `@telipot/credentials`'s. `consented` connects nothing
// until the backend confirms the end user; `declined` means it named another, so nothing was kept.
export const ConnectSessionStatus = Schema.Literals([
  "pending",
  "consented",
  "completed",
  "declined",
  "expired",
]);

export type ConnectSessionStatus = typeof ConnectSessionStatus.Type;

export const ConnectSession = Schema.Struct({
  session_id: Schema.String,
  provider: Schema.String,
  principal: Schema.String,
  status: ConnectSessionStatus,
  // Null until the session completes.
  connection_id: Schema.NullOr(Schema.String),
  // The link's expiry; once `consented`, the deadline for the backend's confirm.
  expires_at: Schema.String,
  // While `consented`, the provider account consented on and its name, for the backend to show
  // before it confirms; null otherwise.
  account: Schema.NullOr(Schema.String),
  account_label: Schema.NullOr(Schema.String),
}).annotate({ identifier: "ConnectSession" });

// Never the session's PKCE verifier.
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

// Newest first. A page never splits one millisecond's sessions, so it may run a little past fifty
// and none is skipped. A session is deleted a day past its expiry.
export const ConnectSessionList = Schema.Struct({
  sessions: Schema.Array(ConnectSessionRecord),
  next_cursor: Schema.NullOr(Schema.String),
}).annotate({ identifier: "ConnectSessionList" });

// The backend's word on the browser that came back with `code`: the end user signed in there.
export const ConnectConfirmation = Schema.Struct({
  code: FreeText(200),
  principal: EndUserPrincipal,
}).annotate({ identifier: "ConnectConfirmation" });

// A page of one end user's own connections, for them to revoke; never the organization's.
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

// The provider takes only the organization's own OAuth app, as Gmail does, and none is set.
export class OAuthAppRequired extends Schema.TaggedError<OAuthAppRequired>()("OAuthAppRequired", {
  detail: Schema.String,
}) {
  static readonly problem = problem(this, { status: 409, code: "oauth_app_required" });
}

// The session is not awaiting a confirm, the `code` is not its own, or the connection it adds to
// changed since the consent; nothing was kept.
export class ConnectSessionNotConfirmable extends Schema.TaggedError<ConnectSessionNotConfirmable>()(
  "ConnectSessionNotConfirmable",
  { detail: Schema.String },
) {
  static readonly problem = problem(this, { status: 409, code: "connect_session_not_confirmable" });
}

// The backend named another end user than the session's; the session is declined.
export class ConnectPrincipalMismatch extends Schema.TaggedError<ConnectPrincipalMismatch>()(
  "ConnectPrincipalMismatch",
  { detail: Schema.String },
) {
  static readonly problem = problem(this, { status: 409, code: "connect_principal_mismatch" });
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
    HttpApiEndpoint.post("confirm", "/connect/sessions/:id/confirm", {
      params: { id: FreeText(100) },
      payload: ConnectConfirmation,
      success: ConnectSession,
      error: [
        RoleForbidden.problem,
        ConnectSessionNotFound.problem,
        ConnectSessionNotConfirmable.problem,
        ConnectPrincipalMismatch.problem,
      ],
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
      error: [RoleForbidden.problem],
    }),
  ) {}
