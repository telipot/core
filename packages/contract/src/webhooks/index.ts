import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import { RoleForbidden } from "../caller";
import { Connection } from "../connections";
import { FreeText } from "../free-text";
import { problem } from "../problem";
import { RateLimited } from "../tasks";

// The events `@telipot/connections` starts; `webhooks.test.ts` holds the two equal.
export const WebhookEvent = Schema.Literals([
  "connection.created",
  "connection.needs_reauth",
  "connection.revoked",
  "connection.restored",
  "connection.expiring",
]);

// Signed as the `webhook-id`, `webhook-timestamp` and `webhook-signature` headers say.
export const WebhookEventBody = Schema.Struct({
  type: WebhookEvent,
  timestamp: Schema.String,
  data: Schema.Struct({
    connection: Connection,
    // When a credential that cannot be renewed stops working, or null.
    expires_at: Schema.NullOr(Schema.String),
  }),
}).annotate({ identifier: "WebhookEventBody" });

// The states `@telipot/db` checks a delivery against; `webhooks.test.ts` holds the two equal.
export const WebhookDeliveryState = Schema.Literals(["pending", "delivered", "failed"]);

// An https address on a public host.
export const NewWebhook = Schema.Struct({ url: FreeText(2000) }).annotate({
  identifier: "NewWebhook",
});

// Never the signing secret.
export const Webhook = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  created_at: Schema.String,
}).annotate({ identifier: "Webhook" });

// The only answer carrying the signing secret, `whsec_` and its base64, which verifies every
// delivery as Standard Webhooks describes.
export const WebhookCreated = Schema.Struct({
  ...Webhook.fields,
  secret: Schema.String,
}).annotate({ identifier: "WebhookCreated" });

export const WebhookList = Schema.Struct({ webhooks: Schema.Array(Webhook) }).annotate({
  identifier: "WebhookList",
});

// `pending` while retried, `delivered` once an attempt got a 2xx, `failed` once the last did not.
export const WebhookDelivery = Schema.Struct({
  id: Schema.String,
  // The `webhook-id` header, the same on every attempt.
  event_id: Schema.String,
  event: WebhookEvent,
  state: WebhookDeliveryState,
  attempts: Schema.Int,
  // The last attempt's status, or null when it got no answer.
  last_status: Schema.NullOr(Schema.Int),
  // Why the last attempt got no 2xx, or null.
  last_error: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
}).annotate({ identifier: "WebhookDelivery" });

export const WebhookDeliveryList = Schema.Struct({
  deliveries: Schema.Array(WebhookDelivery),
}).annotate({ identifier: "WebhookDeliveryList" });

export class WebhookNotFound extends Schema.TaggedError<WebhookNotFound>()("WebhookNotFound", {
  detail: Schema.String,
}) {
  static readonly problem = problem(this, { status: 404, code: "webhook_not_found" });
}

// Not https, or the host is or resolves to a non-public address, cloud metadata among them.
// Checked again before every delivery.
export class WebhookTargetRefused extends Schema.TaggedError<WebhookTargetRefused>()(
  "WebhookTargetRefused",
  { detail: Schema.String },
) {
  static readonly problem = problem(this, { status: 422, code: "webhook_target_refused" });
}

export class WebhookLimitReached extends Schema.TaggedError<WebhookLimitReached>()(
  "WebhookLimitReached",
  { detail: Schema.String },
) {
  static readonly problem = problem(this, { status: 409, code: "webhook_limit_reached" });
}

export class WebhooksApi extends HttpApiGroup.make("webhooks")
  .add(
    HttpApiEndpoint.post("create", "/webhooks", {
      payload: NewWebhook,
      success: WebhookCreated,
      error: [
        RoleForbidden.problem,
        WebhookTargetRefused.problem,
        WebhookLimitReached.problem,
        RateLimited.problem,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.get("list", "/webhooks", {
      success: WebhookList,
      error: [RoleForbidden.problem],
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/webhooks/:id", {
      params: { id: FreeText(100) },
      success: Webhook,
      error: [RoleForbidden.problem, WebhookNotFound.problem],
    }),
  )
  .add(
    HttpApiEndpoint.get("deliveries", "/webhooks/:id/deliveries", {
      params: { id: FreeText(100) },
      success: WebhookDeliveryList,
      error: [RoleForbidden.problem, WebhookNotFound.problem],
    }),
  ) {}
