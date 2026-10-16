import { Context, type Effect, Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";

import { type Actor, RoleForbidden } from "../caller";
import { Cursor } from "../cursor";
import { FreeText } from "../free-text";
import { problem } from "../problem";
import { EndUserPrincipal } from "../receipt";
import { RateLimited } from "../tasks";

// The only client the auth provider issues a device code to: `telipot login`.
export const cliClientId = "telipot-cli";
export const cliTokenName = "telipot CLI";
export const cliTokenLifetime = 90 * 86_400;

// In seconds: a token leaked from a browser dies within the hour by default.
export const userBoundTokenLifetime = { default: 3600, minimum: 60, maximum: 86_400 } as const;

export const NewUserBoundToken = Schema.Struct({
  principal: EndUserPrincipal,
  expires_in: Schema.optionalKey(
    Schema.Int.check(
      Schema.isBetween({
        minimum: userBoundTokenLifetime.minimum,
        maximum: userBoundTokenLifetime.maximum,
      }),
    ).annotate({
      description: `Seconds the token lasts, ${userBoundTokenLifetime.default} unless given and ${userBoundTokenLifetime.maximum} at most.`,
    }),
  ),
}).annotate({ identifier: "NewUserBoundToken" });

// The only answer that carries the token itself.
export const UserBoundToken = Schema.Struct({
  id: Schema.String,
  token: Schema.String,
  principal: Schema.String,
  expires_at: Schema.String,
}).annotate({ identifier: "UserBoundToken", httpApiStatus: 201 });

// Never the token itself; it stops once its `issued_by` actor is gone or loses the role.
export const HeldUserBoundToken = Schema.Struct({
  id: Schema.String,
  principal: Schema.String,
  expires_at: Schema.String,
  issued_by: Schema.String,
}).annotate({ identifier: "HeldUserBoundToken" });

export const heldTokensPage = 100;

// Newest first. A page never splits one millisecond's tokens, so it may run a little past a
// hundred, and none is skipped though tokens change between pages.
export const HeldUserBoundTokens = Schema.Struct({
  tokens: Schema.Array(HeldUserBoundToken),
  next_cursor: Schema.NullOr(Schema.String),
}).annotate({ identifier: "HeldUserBoundTokens" });

// The organization's own token, or another organization's user-bound one, answers the same.
export class TokenNotFound extends Schema.TaggedError<TokenNotFound>()("TokenNotFound", {
  detail: Schema.String,
}) {
  static readonly problem = problem(this, { status: 404, code: "token_not_found" });
}

export interface HeldToken {
  readonly id: string;
  readonly principal: string;
  readonly expiresAt: Date;
  readonly issuedBy: string;
}

// `@telipot/auth` provides this beside `Callers`.
export class UserBoundTokens extends Context.Service<
  UserBoundTokens,
  {
    readonly issue: (
      organizationId: string,
      principal: string,
      expiresInSeconds: number,
      issuedBy: Actor,
    ) => Effect.Effect<{ readonly id: string; readonly token: string; readonly expiresAt: Date }>;
    // False when the organization holds no user-bound token with the id.
    readonly revoke: (organizationId: string, id: string) => Effect.Effect<boolean>;
    // Unexpired tokens, newest first.
    readonly list: (
      organizationId: string,
      cursor: string | undefined,
      limit: number,
    ) => Effect.Effect<{ readonly tokens: ReadonlyArray<HeldToken>; readonly next: string | null }>;
  }
>()("@telipot/contract/tokens/UserBoundTokens") {}

export class TokensApi extends HttpApiGroup.make("tokens")
  .add(
    HttpApiEndpoint.post("issue", "/tokens", {
      payload: NewUserBoundToken,
      success: UserBoundToken,
      error: [RoleForbidden.problem, RateLimited.problem],
    }),
  )
  .add(
    HttpApiEndpoint.get("list", "/tokens", {
      query: { cursor: Schema.optionalKey(Cursor) },
      success: HeldUserBoundTokens,
      error: [RoleForbidden.problem],
    }),
  )
  .add(
    // Whichever token the request carries, so `telipot logout` ends the key it saved.
    HttpApiEndpoint.delete("revokeCurrent", "/tokens/current", {
      success: HttpApiSchema.NoContent,
      error: [TokenNotFound.problem],
    }),
  )
  .add(
    HttpApiEndpoint.delete("revoke", "/tokens/:id", {
      params: { id: FreeText(100) },
      success: HttpApiSchema.NoContent,
      error: [RoleForbidden.problem, TokenNotFound.problem],
    }),
  ) {}
