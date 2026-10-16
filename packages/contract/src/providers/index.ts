import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";

import { RoleForbidden } from "../caller";
import { CatalogId, FreeText } from "../free-text";
import { problem } from "../problem";
import { Task } from "../tasks";

// Visible ASCII, as a provider issues them, so either can travel in a Basic header.
const ClientText = (maxLength: number) =>
  FreeText(maxLength).check(
    Schema.isPattern(/^[\x21-\x7E]+$/, { expected: "visible ASCII, with no spaces" }),
  );

// Registered with the provider on telipot's callback. The secret is Redacted once decoded.
export const NewOAuthApp = Schema.Struct({
  client_id: ClientText(512),
  client_secret: Schema.RedactedFromValue(ClientText(1024)),
}).annotate({ identifier: "NewOAuthApp" });

// Never the secret.
export const OAuthApp = Schema.Struct({
  provider: Schema.String,
  client_id: Schema.String,
}).annotate({ identifier: "OAuthApp" });

// `auth` is empty when every task is public. `oauth_app.own_required`: only the organization's
// own app connects the provider. `callback_url` is what an own app registers, null without OAuth.
// `tasks` counts live ones; `identity_task` reads the account a credential acts as.
export const ProviderSummary = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  docs_url: Schema.String,
  retention: Schema.Literals(["zero", "standard"]),
  auth: Schema.Array(Task.fields.auth.pick(["api_key", "oauth2", "basic", "bearer"])),
  connects: Schema.Struct({
    organization_key: Schema.Boolean,
    organization_oauth: Schema.Boolean,
    user_key: Schema.Boolean,
    user_oauth: Schema.Boolean,
  }),
  oauth_app: Schema.Struct({
    managed: Schema.Boolean,
    byo: Schema.Boolean,
    own_required: Schema.Boolean,
    client_id: Schema.NullOr(Schema.String),
  }),
  callback_url: Schema.NullOr(Schema.String),
  scopes: Schema.Array(
    Schema.Struct({ name: Schema.String, description: Schema.NullOr(Schema.String) }),
  ),
  tasks: Schema.Int,
  identity_task: Schema.NullOr(Schema.String),
}).annotate({ identifier: "ProviderSummary" });

export type ProviderSummary = typeof ProviderSummary.Type;

// Every provider with a task served, in catalog order.
export const ProviderList = Schema.Struct({
  providers: Schema.Array(ProviderSummary),
}).annotate({ identifier: "ProviderList" });

export type ProviderList = typeof ProviderList.Type;

export class ProviderNotFound extends Schema.TaggedError<ProviderNotFound>()("ProviderNotFound", {
  detail: Schema.String,
}) {
  static readonly problem = problem(this, { status: 404, code: "provider_not_found" });
}

// Another organization's app answers the same.
export class OAuthAppNotFound extends Schema.TaggedError<OAuthAppNotFound>()("OAuthAppNotFound", {
  detail: Schema.String,
}) {
  static readonly problem = problem(this, { status: 404, code: "oauth_app_not_found" });
}

export class ProvidersApi extends HttpApiGroup.make("providers")
  .add(HttpApiEndpoint.get("list", "/providers", { success: ProviderList }))
  .add(
    HttpApiEndpoint.get("get", "/providers/:slug", {
      params: { slug: CatalogId },
      success: ProviderSummary,
      error: ProviderNotFound.problem,
    }),
  )
  .add(
    HttpApiEndpoint.get("getOAuthApp", "/providers/:slug/oauth-app", {
      params: { slug: CatalogId },
      success: OAuthApp,
      error: [ProviderNotFound.problem, OAuthAppNotFound.problem],
    }),
  )
  .add(
    HttpApiEndpoint.put("setOAuthApp", "/providers/:slug/oauth-app", {
      params: { slug: CatalogId },
      payload: NewOAuthApp,
      success: OAuthApp,
      error: [RoleForbidden.problem],
    }),
  )
  .add(
    HttpApiEndpoint.delete("removeOAuthApp", "/providers/:slug/oauth-app", {
      params: { slug: CatalogId },
      success: HttpApiSchema.NoContent,
      error: [RoleForbidden.problem, ProviderNotFound.problem, OAuthAppNotFound.problem],
    }),
  ) {}
