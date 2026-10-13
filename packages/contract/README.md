# @telipot/contract

The contract of telipot's HTTP API: the `HttpApi`, every body it answers and every error, as Effect `Schema`s. It depends on `effect` alone, so the SDK, the CLI and the web app take it without the server, and it ships in the public repository, [`telipot/core`](https://github.com/telipot/core), with the catalog. The hosted server answers it.

## Entries

- `@telipot/contract`: `Api`, its groups, the bodies they answer (`Task`, `TaskSummary`, a task as `GET /v1/tasks` lists it, `TaskPage` and `tasksPage`, the tasks a page holds, `Capability`, `ProviderSummary`, `ProviderList`, `Connection`, `ConnectionDetail`, `Grant`, `PrincipalSummary`, `ConnectSession`, `ConnectSessionRecord`, `ConnectionsPageCreated`, `RedirectAllowlist`, `OAuthApp`, `Webhook`, `WebhookCreated`, `WebhookDelivery`, `WebhookEventBody`, the body every delivery sends, `UserBoundToken`, `HeldUserBoundTokens`), `McpTools`, the MCP server's seven tools, and `mcpPath`, where it is served, `userBoundTokenLifetime`, the seconds a user-bound token lasts unless asked, at least and at most, `cliClientId`, the one client the auth adapter issues a device code to, `telipot login`, `cliTokenName`, the name of the organization key that login issues, so the dashboard tells it apart, `Caller`, `Actor`, who acted for an organization as its records name them, `member:<user id>` or `token:<id>`, the bounds free text is held to (`FreeText`, `CatalogId`, discover's `Sentence`, connect's `RedirectUri`), `Cursor`, the `next_cursor` a list's page answered, every error and `ProblemDetails`, `CallerAuth`, `Problems`, `maxBodyBytes`, the most of a body the server reads, `appOrigins`, the origins the web app calls from, and the seams auth fills (`Callers`, which also proves the caller of a request to the MCP server by a token alone (`resolveForMcp`), says whether a member's role allows an action in an organization (`memberAllows`), whether a signed-in session's role does in a given organization, and what an organization is named, `UserBoundTokens`, which issues and revokes user-bound tokens, and `AuthHandler`). Imported by everyone: the web app, the CLI, the SDK, `@telipot/auth`, the server.

Each feature's contract is `src/<feature>/index.ts`, reached as `@telipot/contract/<feature>`; a schema several features read has its own file at `src/`, as `receipt.ts`, `problem.ts`, `free-text.ts`, `cursor.ts` and `origins.ts`, each its own entry.

A client never bundles server code. A feature's contract is its `index.ts`, and every other file of the feature is the server's, in `@telipot/api-server`. `src/client.test.ts` fails when `src/index.ts` reaches a package other than `effect`, or any file in a folder but a feature's `index.ts`.

## Checks

```sh
bun run test
bun run check-types
```

`src/client.test.ts` also fails when `package.json` lists a dependency but `effect`; `src/api.test.ts` holds every code an endpoint answers to `/openapi.json`.
