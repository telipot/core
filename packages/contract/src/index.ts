import { HttpApi, OpenApi } from "effect/http-api";

import { AuditApi } from "./audit";
import { CapabilitiesApi } from "./capabilities";
import { CallerApi, CallerAuth } from "./caller";
import { ConnectApi } from "./connect";
import { ConnectionsApi } from "./connections";
import { DiscoverApi } from "./discover";
import { GrantsApi } from "./grants";
import { PrincipalsApi } from "./principals";
import { Problems } from "./problem";
import { ProvidersApi } from "./providers";
import { System } from "./system";
import { TasksApi } from "./tasks";
import { TokensApi } from "./tokens";
import { WebhooksApi } from "./webhooks";
export * from "./audit";
export * from "./capabilities";
export * from "./caller";
export * from "./connect";
export * from "./connections";
export * from "./cursor";
export * from "./discover";
export * from "./free-text";
export * from "./grants";
export * from "./mcp";
export * from "./origins";
export * from "./principals";
export * from "./problem";
export * from "./providers";
export * from "./receipt";
export * from "./system";
export * from "./tasks";
export * from "./tokens";
export * from "./webhooks";

// Middleware reaches only groups added before it, so groups go first.
const V1 = HttpApi.make("v1")
  .add(CallerApi)
  .add(TasksApi)
  .add(CapabilitiesApi)
  .add(DiscoverApi)
  .add(AuditApi)
  .add(ConnectionsApi)
  .add(GrantsApi)
  .add(PrincipalsApi)
  .add(ConnectApi)
  .add(ProvidersApi)
  .add(WebhooksApi)
  .add(TokensApi)
  .prefix("/v1")
  .middleware(CallerAuth);

// `Problems` goes last, so it reaches every group, the health check among them.
export class Api extends HttpApi.make("telipot")
  .add(System)
  .addHttpApi(V1)
  .middleware(Problems)
  .annotateMerge(OpenApi.annotations({ title: "telipot API" })) {}
