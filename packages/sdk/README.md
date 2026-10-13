# @telipot/sdk

The TypeScript SDK: the four verbs, `discover`, `inspect`, `run` and `connect`, over `HttpApiClient.make(Api)` from `effect/http-api`. It reads `@telipot/contract` and nothing else, so every request goes through the gateway's own routes, the ones its tests send, and a refusal comes back as the API's own tagged error, such as `PrincipalForbidden` or `CatalogVersionMismatch`, with its `detail`.

```ts
import { Telipot } from "@telipot/sdk";

const token = process.env.TELIPOT_TOKEN;
if (!token) throw new Error("Set TELIPOT_TOKEN first.");
const client = new Telipot({ token, latest: true });
const { candidates } = await client.discover({ task: "Hacker News stories about agent tools" });
const { output, receipt } = await client.run("hackernews.news.search", { query: "agent tools" });
const ana = await client.run(
  "google-calendar.events.list",
  {},
  { as: "user:ana", version: "latest" },
);
```

The SDK is not published to npm yet. After `bun install` at the repository root, save examples under `packages/sdk/` and run them with Bun so the workspace resolves the package. Ana must connect her Calendar before her call can run.

In Effect, `make(options)` gives the same four as Effects, on the `HttpClient` in context; `Telipot` runs them as promises, on `fetch` unless given another `HttpClient` layer.

- **The principal.** `as` on the client is whom every call acts as; `as` on a call overrides it. Left out, the organization, or the end user a user-bound token is fixed to. The SDK sends what it is given and checks nothing: on a user-bound token, the gateway refuses any other principal with `principal_forbidden`.
- **The catalog version.** A run is pinned per provider, by its slug, at the call (`version`), the client (`versions`), or the variable `versionVariable(provider)` names, `TELIPOT_CATALOG_VERSION_<SLUG>`, the slug in capitals with dashes as underscores, in that order. `latest` sends no pin. A provider nothing pins is refused with `VersionRequired` before any request, unless the client sets `latest: true`. The gateway refuses a pin it no longer serves with `catalog_version_mismatch`, naming the one it does.
- **`connect`** opens a connect session for the principal and answers the link to hand them. Unnamed, the principal is the end user a user-bound token is fixed to, read from `/v1/me`, or else the organization.

The hosted repository runs every verb against the gateway itself.
