import { Context, type Effect, type Option, Schema } from "effect";
import type { Headers } from "effect/http";
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from "effect/http-api";
import { problem } from "../problem";
import { EndUserPrincipal } from "../receipt";

export class Caller extends Schema.Class<Caller>("Caller")({
  organizationId: Schema.String,
  credential: Schema.Union([
    Schema.TaggedStruct("Session", { userId: Schema.String }),
    // A `backendOnly` token may send a vendor credential for one call. A user-bound one acts only
    // as `principal`, the end user it was issued for.
    Schema.TaggedStruct("Token", {
      tokenId: Schema.String,
      debugCapture: Schema.Boolean,
      backendOnly: Schema.Boolean,
      principal: Schema.NullOr(EndUserPrincipal),
    }),
  ]),
}) {}

// `member:<user id>`, or `token:<token id>` for the organization's own token. Records write an end
// user as `user:<id>` and the provider as `provider` instead.
export const Actor = Schema.TemplateLiteral([
  Schema.Literals(["member", "token"]),
  ":",
  Schema.NonEmptyString,
]);

export type Actor = typeof Actor.Type;

// The actions a member's role is checked for, by resource.
export const connectionActions = ["create", "read", "update", "delete"] as const;
export interface Permission {
  readonly connection: ReadonlyArray<(typeof connectionActions)[number]>;
}

export class CurrentCaller extends Context.Service<CurrentCaller, Caller>()(
  "@telipot/contract/caller/CurrentCaller",
) {}

export class Unauthenticated extends Schema.TaggedError<Unauthenticated>()("Unauthenticated", {
  detail: Schema.String,
}) {
  static readonly problem = problem(this, { status: 401, code: "unauthenticated" });
}

export class InvalidToken extends Schema.TaggedError<InvalidToken>()("InvalidToken", {
  detail: Schema.String,
}) {
  static readonly problem = problem(this, { status: 401, code: "invalid_token" });
}

export class NoActiveOrganization extends Schema.TaggedError<NoActiveOrganization>()(
  "NoActiveOrganization",
  { detail: Schema.String },
) {
  static readonly problem = problem(this, { status: 403, code: "no_active_organization" });
}

export class UntrustedOrigin extends Schema.TaggedError<UntrustedOrigin>()("UntrustedOrigin", {
  detail: Schema.String,
}) {
  static readonly problem = problem(this, { status: 403, code: "untrusted_origin" });
}

export class RoleForbidden extends Schema.TaggedError<RoleForbidden>()("RoleForbidden", {
  detail: Schema.String,
}) {
  static readonly problem = problem(this, { status: 403, code: "role_forbidden" });
}

// A user-bound token named a principal other than its own.
export class PrincipalForbidden extends Schema.TaggedError<PrincipalForbidden>()(
  "PrincipalForbidden",
  { detail: Schema.String },
) {
  static readonly problem = problem(this, { status: 403, code: "principal_forbidden" });
}

// A user-bound token gets `RoleForbidden` from every endpoint it has no power for.
export class CallerAuth extends HttpApiMiddleware.Service<
  CallerAuth,
  { provides: CurrentCaller }
>()("@telipot/contract/caller/CallerAuth", {
  error: [
    Unauthenticated.problem,
    InvalidToken.problem,
    NoActiveOrganization.problem,
    UntrustedOrigin.problem,
    RoleForbidden.problem,
  ],
}) {}

// `@telipot/auth` provides this and `AuthHandler`.
export class Callers extends Context.Service<
  Callers,
  {
    readonly resolve: (
      headers: Headers.Headers,
    ) => Effect.Effect<Caller, Unauthenticated | InvalidToken | NoActiveOrganization>;
    // A token alone, never a cookie: one `resolve` takes, or an MCP access token, accepted only
    // here and only while the member belongs to the organization they consented for.
    readonly resolveForMcp: (
      headers: Headers.Headers,
    ) => Effect.Effect<Caller, Unauthenticated | InvalidToken>;
    readonly memberAllows: (
      organizationId: string,
      userId: string,
      permission: Permission,
    ) => Effect.Effect<boolean>;
    readonly sessionAllows: (
      headers: Headers.Headers,
      organizationId: string,
      permission: Permission,
    ) => Effect.Effect<boolean>;
    readonly organizationName: (organizationId: string) => Effect.Effect<Option.Option<string>>;
    readonly revokeToken: (organizationId: string, tokenId: string) => Effect.Effect<boolean>;
  }
>()("@telipot/contract/caller/Callers") {}

// The auth provider's own routes under /api/auth.
export class AuthHandler extends Context.Service<
  AuthHandler,
  { handler(request: Request): Effect.Effect<Response> }
>()("@telipot/contract/caller/AuthHandler") {}

export class CallerApi extends HttpApiGroup.make("caller", { topLevel: true }).add(
  HttpApiEndpoint.get("me", "/me", { success: Caller }),
) {}
