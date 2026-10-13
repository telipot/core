# @telipot/fixtures

Shared test data for telipot packages and apps. This private workspace package gives consumers stable imports for catalog directories, OpenAPI documents, isolated copies of files they need to change, and the vendors tests reach instead of the network.

Add `"@telipot/fixtures": "workspace:*"` to a consumer's `devDependencies`. Tests, development previews, and test harness exports may use these fixtures. Production code loads the real catalog and customer data through their owning packages.

## Imports

| Import                         | Exports                                                       | Purpose                                                                                        |
| ------------------------------ | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `@telipot/fixtures/catalog`    | `catalogFixtures`, `CatalogFixtureName`                       | Absolute paths to catalog directories                                                          |
| `@telipot/fixtures/openapi`    | `openApiFixtures`, `OpenApiFixtureName`                       | Absolute paths to OpenAPI JSON files                                                           |
| `@telipot/fixtures/filesystem` | `copyDirectory`                                               | A writable directory copy owned by the caller's Effect scope                                   |
| `@telipot/fixtures/google`     | `Google`, `googleAccounts`, `GoogleAccount`, `ConsentRefused` | Google's OAuth, Search Console, Analytics and Calendar, answered from the catalog's examples   |
| `@telipot/fixtures/vendors`    | `Vendors`, `VendorRoute`, `Fault`, `Received`                 | Any vendor, answered from the catalog's examples, with scripted faults and the requests it got |
| `@telipot/fixtures`            | Both data maps and their name types                           | Convenience import without loading the filesystem helper                                       |

Paths resolve from the module's location with `fileURLToPath`, so they work from any package or app directory. Consumers do not construct paths into another package's source tree. The maps are frozen; the files on disk are shared, so treat them as read-only.

```ts
import { Catalog } from "@telipot/catalog";
import { catalogFixtures } from "@telipot/fixtures/catalog";
import { openApiFixtures } from "@telipot/fixtures/openapi";
import { readFileSync } from "node:fs";

const GatewayCatalog = Catalog.layer(catalogFixtures.gateway);
const document = readFileSync(openApiFixtures.widgetly, "utf8");
```

## Current data

All vendors, accounts, and captured responses in this package are synthetic. `data/catalog` holds complete directory trees, including provider files, taxonomy, aliases, examples, and id locks when the scenario needs them.

| Catalog name     | Scenario                                                                         | Owning tests                                       |
| ---------------- | -------------------------------------------------------------------------------- | -------------------------------------------------- |
| `clean`          | Valid catalog, curated and generated tasks, prices, examples, and identity rules | Catalog loader/generation and CLI catalog commands |
| `clean-input`    | Valid input schemas and verification requests across supported field types       | Catalog input rules                                |
| `refused`        | Deliberate rule failures, with one case per validation rule                      | Catalog validation and CLI error reporting         |
| `refused-fx`     | Invalid exchange, credit, and meter rates                                        | Catalog pricing validation                         |
| `refused-search` | Invalid aliases and query expectations                                           | Catalog search validation                          |
| `gateway`        | Public, organization, and end-user task scenarios                                | API gateway and auth harnesses                     |
| `oauth`          | OAuth providers on telipot's app, on only an organization's own, and on none     | `OAuthClients` and the resolver in connections     |
| `paged`          | One provider with 51 public tasks, one past a page of `GET /v1/tasks`            | The API's task list paging                         |
| `verify`         | Replay requests, captured responses, pricing, redaction, and verification states | CLI verification                                   |

| OpenAPI name | Scenario                                                       | Owning tests                                     |
| ------------ | -------------------------------------------------------------- | ------------------------------------------------ |
| `widgetly`   | Declared security schemes and provider generation              | Catalog importer/regeneration and CLI generation |
| `keyed`      | Security supplied through a provider patch                     | Catalog importer and CLI generation              |
| `jobs`       | Links, query operations, per-operation servers, and references | Catalog importer and provider generation         |

The real repository-root `catalog/` stays outside this package. It is product data, validated alongside the synthetic fixtures by the catalog's tests.

## Vendor fixtures

A vendor fixture stands in for a vendor's hosts at the vendor boundary, so a test reaches no network. This package depends on nothing of ours, so a fixture is handed its routes as data: each `VendorRoute` is one task's method, address (`{name}` for a path segment), where each input field travels and its type, the catalog's own check of an input, the example it answers with, the vendor's names for the scopes it requires, and where the task's scheme sends the credential, which the fixture records in `Received` as `credential` and never reads as input. `vendorRoutes` in `@telipot/api-server/testing` builds them from a loaded catalog, the one owner of those facts, so the executor and a fixture always agree on a task's address.

Every fixture reads a request back into the task's flat input, from the locations the task declares, and answers 400 when the catalog's check refuses that input or a field arrived somewhere else. A route it is not given fails as a transport error.

`Vendors.layer(routes)` provides `Vendors`:

- `client` answers each route with its example.
- `fail(task, fault)` scripts the task's next answer: a status with the vendor's headers and a JSON `body`, such as a 429 with `retry-after`, a 5xx, a redirect or the task's declared miss; a status with `text` sent as written, labelled JSON unless the headers say otherwise; `{ delay }`, the example after a wait, for a vendor too slow to answer; or `{ unreachable: true }`, a transport error, for a host that cannot be reached. Faults queue in order, one per call.
- `received` lists every request it served, oldest first, as the task, method, address and input, so a test asserts the exact calls a run made.

`Google.layer({ routes, authorizationUrl, tokenUrl, revocationUrl, clients })` provides `Google`, on the routes of Google's providers, the consent screen, token endpoint and revocation endpoint their OAuth scheme names, and the OAuth clients registered with it:

- `client` is an `HttpClient` that answers Google's token and revocation endpoints and every route at its address, with its example personalised to the account the bearer token was issued for. An access token lasts an hour on the caller's `Clock`. A token without every scope the task requires gets 403, and a request without a live token it issued gets 401.
- `consent(authorizationUrl, account)` is the person in `googleAccounts` approving at Google's consent screen. It requires `response_type=code` and S256 PKCE, and returns the request's `redirect_uri` with a one-time code and the request's `state`. The code exchanges once: only for the same `client_id`, authenticated with that client's secret by HTTP Basic or in the body, with a verifier of RFC 7636's 43 to 128 characters that matches the challenge, and with the same `redirect_uri`. Without the client's credentials the token endpoint answers 401 `invalid_client`. The exchange issues a refresh token only when `access_type=offline` was asked, and a replayed code ends the grant it issued (RFC 6749 4.1.2).
- The token endpoint takes `grant_type=refresh_token` from the client the grant was issued to, and answers `invalid_grant` to a refresh token it does not hold. `rotate(rotation)` scripts how it answers a refresh: `off`, as Google does, keeps the refresh token; `on` issues a new one and honours the one it replaced until the new one is first used; `forgotten` issues a new one it never records, as a provider that lost the rotation. `refreshes` counts the refreshes it answered.
- The revocation endpoint takes an access or a refresh token and ends its whole grant, and `revocations` lists the accounts whose grant it ended. `revokeAccess(account)` is the person removing the app from their Google account, which ends every grant of theirs.
- `events(account)` is what that account's primary calendar answers, so a test can tell Ana's calendar from Ben's.

`gatewayOn` builds `Vendors` on its own catalog and holds it; its `vendors` option takes another fixture's client, as `apps/server`'s OAuth tests give it Google's. `Google`'s layer needs `Crypto`, which `BunServices.layer` provides.

## Writable copies

Copy a directory before a test generates files, changes YAML, stamps verification, or updates an id lock. Each `copyDirectory` call creates a separate temporary directory. Its contents are removed when the caller's scope closes, including after failure or interruption.

`copyDirectory(source)` returns an `Effect<string, PlatformError, FileSystem | Scope>`. It accepts any source directory, preserves filesystem errors, and uses the caller's filesystem service. It supplies neither a runtime nor an internal scope, so the copied path remains usable throughout the caller's work.

`@effect/vitest` gives each `it.effect` test a scope. Supply the platform services through a layer:

```ts
import { BunServices } from "@effect/platform-bun";
import { assert, layer } from "@effect/vitest";
import { catalogFixtures } from "@telipot/fixtures/catalog";
import { copyDirectory } from "@telipot/fixtures/filesystem";
import { Effect, FileSystem } from "effect";

layer(BunServices.layer)("generated files", (it) => {
  it.effect("keeps generated output inside the test's copy", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* copyDirectory(catalogFixtures.clean);
      yield* fs.writeFileString(`${directory}/generated.txt`, "test output\n");

      assert.isTrue(yield* fs.exists(`${directory}/generated.txt`));
      assert.isFalse(yield* fs.exists(`${catalogFixtures.clean}/generated.txt`));
    }),
  );
});
```

For a standalone Effect program, wrap the entire operation that uses the path in `Effect.scoped`, then provide the application's platform layer. Closing the scope immediately around acquisition removes the directory before subsequent work can use it.

```ts
const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* copyDirectory(catalogFixtures.clean);
  return yield* fs.readFileString(`${directory}/ids.lock.json`);
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));
```

Copying the directory containing a document also makes a writable file copy. For example, copy `dirname(openApiFixtures.widgetly)` and read or edit `join(directory, basename(openApiFixtures.widgetly))` using `node:path`.

## Ownership and additions

This package owns where shared data lives and how callers access it. The package that defines a domain owns what its fixtures mean and the assertions that validate them. A catalog fixture change must pass the catalog's rules and the affected consumers' tests; a deliberately refused fixture must continue to break exactly its intended rules.

Keep file-based catalog and OpenAPI scenarios here, including specialized validation cases in the same fixture family. Small inputs and builders that explain one test clearly may stay inline beside that consumer. Add another domain when packages or apps need reusable scenario data. Each consumer selects the scenario it needs; unrelated scenarios keep separate directories.

When adding another shared domain:

1. Put deterministic, synthetic files under `data/<domain>/`.
2. Add a module exporting a frozen map of module-relative absolute paths and its fixture-name type.
3. Add an explicit `./<domain>` package export and re-export the data map and type from `src/index.ts`.
4. List the scenarios and their owning tests here, then migrate consumers to the public import.
5. Verify asset paths in this package and behavior in the domain and consumer suites.

Use fixed ids, timestamps, and fictional hosts. Real customer credentials, captured personal data, network access, and hidden environment requirements do not belong in shared fixture files. A fixture remains input to a test; expected outcomes and assertions stay with the test that owns the behavior.

Executable domain harnesses stay with their implementations:

| Requirement                                                                | Owner                                   |
| -------------------------------------------------------------------------- | --------------------------------------- |
| HTTP gateway layers, fake caller routing, requests, and response helpers   | `@telipot/api-server/testing`           |
| Better Auth setup, sign-up, organizations, tokens, and invitation outboxes | `@telipot/auth/testing`                 |
| Database migration, Postgres setup, and tenant isolation assertions        | `@telipot/db` tests and their consumers |
| UI component behavior and app-specific route state                         | The consuming app or `@telipot/ui`      |

A vendor's fake lives here, because no package of ours implements the vendor. Those harnesses can import shared data from this package. This package does not depend on catalog, API, auth, database, or app code, so consumers can reuse its data without creating dependency cycles. New shared UI or tenant record data follows the same domain-export pattern when concrete consumers need it.

## Checks

From `packages/fixtures`:

```sh
bun run test
bun run check-types
```

The tests check public asset paths, isolated nested copies, source preservation, cleanup on successful and failed scope exit, propagation of missing-source errors, the Google fixture's consent, code exchange and refusals, on routes written inline, and that only tests and `testing.ts` modules import this package, which no package lists as a runtime dependency. Domain suites keep validating the actual catalog and OpenAPI behavior.
