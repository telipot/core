---
name: telipot
description: Find a provider's task for a job from one sentence, with its price, schemas and identity. Reach for it when a job needs a third-party provider, before writing a scraper or calling a vendor's API.
---

# telipot

> telipot is the tool gateway between an AI agent and the vendors it calls: one token, a catalog of tasks, and an explicit answer to whose identity runs each call.

Ask for the task, not the tool. Send a job in plain words, and telipot answers with every catalog task that can do it.

## Errors

Every error is Problem Details (RFC 9457), sent as `application/problem+json`. Branch on its `code`; `detail` explains this occurrence.

- 400 `invalid_input`: The path, query or body failed its schema, and `detail` names the part. Fix it before you retry.
- 400 `principal_required`: The task acts in an end user's own account, and the run named no end user, so nothing ran. Send `"receipt": {"principal": "user:<their id>"}` and retry.
- 401 `unauthenticated`: No token arrived. Send `Authorization: Bearer $TELIPOT_TOKEN`.
- 401 `invalid_token`: The token is unknown, expired or revoked. Ask your human for a new one.
- 401 `connection_invalid`: The provider turned down the key or sign-in that served, after telipot renewed it where it could, and no other was tried; `connection` names it, and `call_id` the call, or null when nothing ran. Hand `connect_url` to whoever owns that connection, the end user or an owner or an admin, who signs in to the same account or adds a working key there, then retry. When `connect_url` is null, `detail` says why.
- 402 `no_credential`: No identity holds a credential for this task yet, so nothing ran. Hand `connect_url` to an owner or an admin of your organization, who adds the provider's key there, then retry; or use a task whose `credential_in_place` is true. When `connect_url` is null, `detail` says why. When the run named an `account`, no connection is on it: use an `account` that `GET /v1/connections` lists.
- 403 `no_active_organization`: A signed-in session has no organization chosen. Send a token instead.
- 403 `untrusted_origin`: A signed-in session tried a change from a page outside the web app, or the organization's token came from a web page, where it never belongs. Send the organization's token from a backend, or hand the page a user-bound token.
- 403 `role_forbidden`: The signed-in member's role may not make this change, or a user-bound token asked for more than discover, inspect, run and connect for its own end user. Ask an owner or an admin, or send it with the organization's token.
- 403 `connection_forbidden`: The connection the run named belongs to another principal, and `connection` names it. Name one of the principal's own, or none.
- 403 `principal_forbidden`: The token acts only as one end user, and the request named another principal, so nothing ran. Leave the principal out, or name the token's own.
- 403 `grant_required`: The task acts in the end user's own account, and that end user has not connected the provider, or none of their connections is on the account the run named, so nothing ran. Hand `connect_url` to that end user, then retry once they connect. It works once, for fifteen minutes. When it is null, `detail` says why.
- 403 `connection_required`: The task acts in your organization's own account on its provider, and none is connected, so nothing ran, or the run named an account no connection is on. Name a connected account, or hand `connect_url` to an owner or an admin, who connects that provider, then retry. When it is null, `detail` says why.
- 403 `scope_required`: The grant on `connection` lacks the scopes in `missing`, which the task needs, so nothing ran. Hand `connect_url` to whoever granted it: it asks for those scopes alone, on the same connection. Retry once they grant them. When it is null, `detail` says why.
- 404 `task_not_found`: No task has this id. Discover the job again.
- 404 `capability_not_found`: No capability has this id. Use a task's `capability`.
- 404 `provider_not_found`: No provider has this slug. Use a task's `provider`, or a `slug` that `GET /v1/providers` lists.
- 404 `route_not_found`: No route answers this path. Call only the routes this file names.
- 404 `miss`: The provider found nothing for this input, and nothing failed. Change the input rather than retry it.
- 404 `call_not_found`: No call of your organization has this id. Use a `call_id` a run answered.
- 404 `capture_not_found`: Nothing was kept of this call: its token has debug capture off, or 24 hours have passed. Run it again on a token issued with debug capture.
- 404 `connect_session_not_found`: No connect session of your organization has this id. Use a `session_id` that `POST /v1/connect/sessions` answered.
- 404 `connection_not_found`: No connection of your organization has this id, or none on the task's provider when a run names it. List the connections again.
- 404 `webhook_not_found`: No webhook of your organization has this id. List them with `GET /v1/webhooks`.
- 404 `oauth_app_not_found`: Your organization has set no OAuth app of its own for this provider, or the provider takes none, as `detail` says. Its sessions sign in on telipot's app where the provider's `oauth_app` is `managed`; otherwise ask your human, an owner or an admin, to set one with `PUT /v1/providers/{slug}/oauth-app`.
- 404 `token_not_found`: No user-bound token of your organization has this id, or `DELETE /v1/tokens/current` came with a dashboard session or a token revoked meanwhile. Use an `id` that `POST /v1/tokens` answered; to end the token you send, send it.
- 409 `oauth_app_required`: The provider connects only through your organization's own OAuth app, such as Gmail, whose scopes Google lets no shared app ask for, and your organization has set none, so no session opened. Ask your human, an owner or an admin, to register one with the provider and set it with `PUT /v1/providers/{slug}/oauth-app`, as `detail` says, then retry.
- 409 `webhook_limit_reached`: Your organization already keeps ten webhooks, so none was added. Remove one with `DELETE /v1/webhooks/{id}` first.
- 409 `connection_ambiguous`: Several connections can run the task, none is the default, and the run named none of them, so nothing ran; `candidates` lists each one's `id`, `label` and `account`. Ask your human which, then name it with `Telipot-Connection` or `Telipot-Account`.
- 409 `idempotency_in_flight`: Another request with this `Idempotency-Key` was still running when this one stopped waiting for it, so nothing ran. Send it again with the same key once that one ends: its success comes back as a replay.
- 409 `catalog_version_mismatch`: The run was pinned to a catalog version its provider is no longer served at, so nothing ran; `served_version` is the one served now. Inspect the task again, check its input still fits, then pin `served_version` and retry.
- 410 `task_retired`: The task is gone for good. Drop its id, and use `superseded_by` when it names a task.
- 410 `task_broken`: The task cannot be called until it is fixed. Keep its id, and use another task meanwhile.
- 413 `payload_too_large`: The body is over 1 MiB, so nothing read it. Send a shorter input.
- 422 `credential_refused`: The provider's check turned the key down, or the key may not read which account it belongs to, so nothing was saved. Check the key and what it may reach.
- 422 `webhook_target_refused`: The webhook's `url` is not https, or its host is or resolves to an address that is not public, such as a private, loopback, link-local or metadata one, so nothing was saved. Ask your human for an https address on a public host.
- 429 `rate_limited`: Your organization is past its runs a minute, or the keys it adds a minute on `POST /v1/connections`, or the connect sessions it starts a minute on `POST /v1/connect/sessions`, or the webhooks it adds a minute on `POST /v1/webhooks`, or the user-bound tokens it issues a minute on `POST /v1/tokens`; or one end user is past their own share of those runs, connect sessions or keys added; and `call_id` is null because nothing ran; or the provider is limiting calls. Wait as the `Retry-After` header says, then retry.
- 500 `internal_error`: A failure on our side. Retry later.
- 502 `upstream_error`: The provider failed or did not answer in time; `upstream_status` and `upstream_body` say what it sent. Retry later, or use another task. An `upstream_status` of 401 here means the provider turned down a sign-in telipot could not renew just then: the connection still stands, so retry in a minute.
- 503 `probe_unavailable`: The provider did not answer the check of a new key, or did not say which account it belongs to, so the key was neither accepted nor refused, and nothing was saved. Add it again later.

A 410 also carries `status_note`, why the task stopped, and `superseded_by`, the task that replaced it or null. A code missing from this list means this file is out of date: fetch https://telipot.com/skill.md again.

## Set up

1. Ask your human for a telipot token. It starts with `tlp_`, and they issue it at https://app.telipot.com.
2. Set it as `TELIPOT_TOKEN` where you run commands. Never write it into a file.
3. Keep a copy of https://telipot.com/skill.md where your client loads skills:
   - Claude Code: `.claude/skills/telipot/SKILL.md`
   - Codex: `.agents/skills/telipot/SKILL.md`
   - Cursor: `.cursor/skills/telipot/SKILL.md`

Send every request to `https://api.telipot.com/v1` with the header `Authorization: Bearer $TELIPOT_TOKEN`. Every field, bound and error is in the OpenAPI document at https://api.telipot.com/openapi.json.

## When to use it

Check telipot before you write a scraper or call a vendor's API by hand. The catalog grows, so search it rather than guess what it holds.

Your human's own tools come first. If they hold an MCP server, a CLI or a key for that provider, use it.

## Discover

The API serves three verbs today, discover, inspect and run, and the organization's connections. Call only the routes this file names.

`POST /v1/discover` takes a job in plain words. It answers with `candidates`, the tasks that can do it, best first.

```bash
curl https://api.telipot.com/v1/discover \
  -H "Authorization: Bearer $TELIPOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"task": "Hacker News stories about agent tools", "limit": 3}'
```

- `task`: the job and the data you want, in a short phrase or a plain sentence. Names, dates, URLs and email addresses in it are read as values and cost nothing. Send one sentence per source when a job spans several.
- `limit`: how many candidates at most.
- `filters`: keep to one `provider`, `tier` or `kind`.

When nothing qualifies, `candidates` is empty, and `near_misses` lists the closest tasks with the words each `matched` and `missed`. Reword or drop a missed word and ask again.

## Inspect

`GET /v1/tasks/{id}` answers with one task, in the shape of a candidate.

```bash
curl https://api.telipot.com/v1/tasks/hackernews.news.search \
  -H "Authorization: Bearer $TELIPOT_TOKEN"
```

`GET /v1/capabilities/{id}` answers with a capability and every provider's live task for it, cheapest first. A capability is a job several providers can do, and its id is a task's `capability`.

`GET /v1/tasks` lists the catalog's live tasks in catalog order, fifty a page, each as inspect answers it but without `input`, `output` and `example`, and `total`, how many the query keeps. Keep to one `provider`, `capability` or `kind`, or send `q` for text in a task's id, name or summary. Send `?cursor=` with the `next_cursor` a page answered for the next, with the same filters. To find a task for a job, discover it instead.

## Run

`POST /v1/tasks/{id}/run` runs a task. The body is the task's `input`, one JSON object.

```bash
curl https://api.telipot.com/v1/tasks/hackernews.news.search/run \
  -H "Authorization: Bearer $TELIPOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query": "agent tools", "hitsPerPage": 5}'
```

- `output` is the provider's answer, unchanged, so the provider's own documentation describes it.
- `receipt` is what telipot adds: `call_id`, `identity` and the `principal` it acted as, `credential_source`, `quoted_usd` and `charged_usd` as decimal strings, and `latency_ms`. The same fields come back as `Telipot-*` headers, such as `Telipot-Call-Id`.
- To act as someone, add `"receipt": {"principal": "user:ana"}` beside the input, or send `Telipot-Principal: user:ana`. The body wins when both are sent.
- To pin a run to the catalog version you read the task at, send `"receipt": {"version": "2026-10-04"}` or `Telipot-Version`, the `version` inspect answered. Left out, the run uses the version served now.
- `principal`, `tag`, `connection`, `account` and `version` are the options a run acts on today, and `credential` from a backend-only token: a provider key for that one call, used and never kept. Any other `receipt` option answers `invalid_input` until it works, so a limit you send is never dropped unseen.
- To pick among your organization's connections on a provider, send `"receipt": {"connection": "conn_..."}` or `Telipot-Connection`, or `"receipt": {"account": "..."}` or `Telipot-Account` for the one on that account, one or the other. With neither, the run uses the only connection or the default, and `receipt.connection` and `receipt.account` name the one it ran on.
- To retry safely, send an `Idempotency-Key` header, a string of your own. A success under it is answered again for 24 hours, the same `output` and `receipt`, without calling the provider. A run under a key finishes even when you hang up, so its retry is answered from its success. A failure is not kept, so the same key runs again. The key sent with another task, input, principal or connection answers `invalid_input`.
- telipot itself retries a provider's 429 or 5xx, but only for a task that reads (`kind` `data` or `utility`), and never waits longer than the provider's catalog entry allows. An action is sent once.
- `GET /v1/calls/{id}` reads a call back by its `call_id`: who ran it, on whose credential, what it cost and what happened. It never holds the input or the answer.
- `GET /v1/calls/{id}/capture` reads a call's input and the provider's answer, with credentials and contact details redacted, when the token was issued with debug capture on. A capture is deleted after 24 hours. A member's session is refused with `role_forbidden`, since a capture holds what an end user's call sent and got.
- `GET /v1/calls` lists your organization's calls, newest first, about fifty a page. Send `?cursor=` with the `next_cursor` a page answered for the next; none is skipped or repeated though calls land between pages. Narrow it with `task`, `provider`, `principal`, `outcome`, `token` or `connection`; `principal=organization` also finds the calls that named no principal.
- `GET /v1/usage` counts your organization's calls over the last `days` UTC days, `1`, `7` or `30`, today's so far among them, and `7` unless sent: by outcome and identity, each day with its own, the ten most called tasks with their `hits` and `faults`, the ten principals that called most, `end_users`, and the sum of `charged_usd`. Send `?token=` to count one token's calls alone.
- `GET /v1/captures` lists the captures still kept, newest first, about fifty a page by the same cursor, without the input or the answer; `GET /v1/calls/{id}/capture` reads those. A member's session is refused it too.

## Connections

A connection is a provider key your organization keeps with telipot, or a provider account it signed in to. That provider's tasks that work on any account, or in the organization's own account, then run on it, with `identity` `organization`, `credential_source` `byoc` and `charged_usd` `"0"`; a task's `credential_in_place` says whether it will.

An end user's connection is theirs alone. A task whose `principal` is `user` runs as the end user the run names, such as `user:ana`, on Ana's own connection and no one else's, with `identity` `user`.

- `GET /v1/connections` lists them: `id`, `provider`, `principal`, `account`, `label`, `state`, `default` and `scopes`, never the key. Add `?principal=organization` for the organization's own, or `?principal=user:ana` for Ana's.
- `GET /v1/connections/{id}` reads one, a revoked one too, with its `created_at`, `expires_at` when its key or sign-in cannot be renewed, and its `grant`: the `scopes` allowed and, once revoked, `revoked_at` and `revoked_by`, who revoked it.
- `GET /v1/grants` lists every grant in your organization, newest first, a revoked one kept with `revoked_at` and `revoked_by`. Add `?principal=user:ana`, or `?state=active` or `?state=revoked`.
- `GET /v1/principals` lists the organization and each end user it has seen, newest first, with how many `connections` each holds that are not revoked, how many of those `needs_reauth`, and their `providers`. Add `?q=ana` for those whose principal holds it.
- Those lists, and the connect sessions below, answer about fifty a page: send `?cursor=` with the `next_cursor` a page answered for the next.
- `POST /v1/connections` with `{"provider": "semrush", "principal": "organization", "credential": "<key>"}` adds the organization's key, once a free check with the provider passes. A provider with no such check has its key checked by the first run instead. Leave this to your human or their backend: never put a key in a prompt or a file.
- Where the provider can say which account a key belongs to, the key is kept on that `account`, and named after it unless you send a `label`. A key to another account is a second connection; a key to the same account replaces the first one's.
- The first connection on a provider is the `default`. A second clears it, so a run then answers `connection_ambiguous` until it names one or one is made the default.
- `PATCH /v1/connections/{id}` with `{"default": true}` makes one the default, or with `{"label": "..."}` renames it.
- `DELETE /v1/connections/{id}` revokes one, which stays listed as `revoked`.
- `POST /v1/connect/sessions` with `{"provider": "google-search-console", "principal": "organization", "redirect_uri": "<a page of the dashboard>"}` answers a `url` for your human, an owner or an admin, to open. It signs them in to the provider once, within fifteen minutes, then returns them to `redirect_uri` with `session_id` and `status`; a declined or failed sign-in shows them a page instead. `scopes` defaults to every scope the provider's tasks need, but those only actions need. For a provider that takes a key, such as Semrush, the page is a form where an owner or an admin adds the organization's key.
- `POST /v1/connect/sessions` with `{"provider": "google-calendar", "principal": "user:ana", "redirect_uri": "https://app.acme.com/settings/connections"}` answers a `url` for your human's backend to hand to Ana. The page names your organization, the provider and what the grant allows, and works only in the browser Ana opens it in. For a provider that takes each end user's own key, the page is a form where Ana adds hers, checked with the provider first. `redirect_uri` must match an address on the redirect allowlist on scheme, host, port and path.
- `POST /v1/connect/connections-pages` with `{"principal": "user:ana"}` answers a `url` for your human's backend to hand to Ana, with `expires_at`. For fifteen minutes it shows Ana her own connections in your organization, and no one else's, and lets her revoke any of them, with no account. A member's session is refused with `role_forbidden`, since the page revokes.
- `PUT /v1/providers/{slug}/oauth-app` with `{"client_id": "...", "client_secret": "..."}` sets your organization's own OAuth app for a provider whose catalog entry allows one, so the provider's consent screen names your organization rather than telipot. Every session on that provider then signs in through it, and the connections it makes work as any other. The answer names the `provider` and `client_id`, never the secret; telipot's own client id is refused. Setting another app replaces it, and connections signed in through the one replaced then answer `connection_invalid` with a link to sign in again. Leave this to your human, an owner or an admin: never put the secret in a prompt or a file.
- `GET /v1/providers/{slug}/oauth-app` reads the `client_id` of your organization's own app, never the secret. `DELETE /v1/providers/{slug}/oauth-app` removes it, for an owner or an admin, answering 204: sessions on that provider then sign in through telipot's app, where it has one, and connections signed in through the removed app need a new sign-in, so a run on one answers `connection_invalid`.
- `GET /v1/providers` lists every provider with a task served, and `GET /v1/providers/{slug}` reads one: the credential types it takes (`auth`), how the organization and an end user each connect it (`connects`), which OAuth app it signs in through and the `client_id` of your organization's own (`oauth_app`), the `callback_url` your own app registers with the provider as its redirect URI, the `scopes` a connect session may ask for, and its live `tasks`.
- `GET /v1/connect/redirect-uris` reads the redirect allowlist, and `PUT /v1/connect/redirect-uris` with `{"redirect_uris": ["https://app.acme.com/settings/connections"]}` replaces it whole. Each address is `https`, or `http` on `localhost` or `127.0.0.1`, with no query or fragment.
- `POST /v1/webhooks` with `{"url": "https://hooks.acme.com/telipot"}` tells your human's backend when a connection is created, needs a new sign-in or key, is restored, is revoked, or holds a credential that cannot be renewed and expires within the week. It answers the webhook's `secret`, once: keep it where the backend verifies deliveries, never in a prompt or a file. The `url` is https on a public host, and an organization keeps at most ten. Only an owner or an admin adds, lists (`GET /v1/webhooks`), removes (`DELETE /v1/webhooks/{id}`) or reads the delivery history of one (`GET /v1/webhooks/{id}/deliveries`). Each delivery is a POST of `{"type": "connection.created", "timestamp": "...", "data": {"connection": {...}, "expires_at": null}}`, signed as Standard Webhooks describes with the `webhook-id`, `webhook-timestamp` and `webhook-signature` headers, which any Standard Webhooks library verifies with the secret; `data.connection` is the connection as the change left it, and `expires_at` says when an expiring credential stops working. One not answered 2xx is sent again after 5 s, 5 min, 30 min, 2 h, 5 h, 10 h and 10 h, with the same `webhook-id`, so a backend keeps each once.
- `GET /v1/connect/sessions` lists your organization's connect sessions from about the last day, newest first, each with its `status`, the `scopes` it asks, its `redirect_uri` and `label`, and `adds_to`, the connection it adds scopes to or signs in again. Add `?principal=user:ana` or `?status=pending`. A member's session is refused with `role_forbidden`, since a pending session's id is its link.
- `GET /v1/connect/sessions/{id}` reads its `status`, `pending`, `completed` or `expired`, and the `connection_id` it made. Poll it, then retry the run. A link that can no longer finish, such as a key form that took five refused keys or a sign-in the provider failed after consent, stays `pending` until it expires: if a poll stays `pending` long after your human acted, ask for a new link.

## User-bound tokens

A backend acts as any end user with the organization's token and a principal, and needs no other token. An agent on the client side, such as in a browser, holds a user-bound token instead, which can only ever act as the one end user it was issued for.

- `POST /v1/tokens` with `{"principal": "user:ana", "expires_in": 3600}` answers the `token`, once, with its `id`, `principal` and `expires_at`. It lasts `expires_in` seconds, an hour unless sent and a day at most. The organization's token, an owner or an admin issues one, at most 60 a minute per organization, since it connects its end user. It stops working once whoever issued it is gone: that organization token deleted, or that member removed or no longer an owner or an admin.
- Sent as `Authorization: Bearer <token>`, from any web page, it discovers, inspects and runs as Ana with no principal in the request, opens connect sessions for her (`"principal": "user:ana"`), lists her connections alone, and revokes itself. A request naming anyone else answers `principal_forbidden`; adding, changing or revoking a connection, issuing a token, or anything else answers `role_forbidden`. Its end user may spend a quarter of the organization's runs and connect sessions a minute on their own, and five of its keys added, one link's tries, however many tokens they hold, so one end user never spends them all. A discover that finds nothing on it is not kept in the organization's miss log.
- `GET /v1/tokens` lists the organization's user-bound tokens not yet expired, newest first, about a hundred a page: `id`, `principal`, `expires_at` and `issued_by`, never the token. Send `?cursor=` with the `next_cursor` a page answered for the next; none is skipped though tokens are revoked between pages.
- `DELETE /v1/tokens/{id}` revokes one before it expires, answering 204.
- `DELETE /v1/tokens/current` revokes the token that sends it, of either kind, answering 204. `telipot logout` sends it for the key `telipot login` saved, which otherwise lasts 90 days.

## Read a task

- `id` never changes, so store it. A retired id answers 410 and names its successor.
- `input` is what a call takes, as one JSON Schema object. `output` is what the provider answers, or null.
- `price` is `free`, or what `per` `unit`s cost, with `usd` as decimal strings from `floor` to `ceiling`. Null is unpriced, never free.
- `auth` says how the provider's credential is presented, and `scope` whose account the task acts in.
- `principal` says whom the task acts as, the `organization` or one `user`. `required_scopes` is what a grant must cover.
- `identity` is whose credential would serve a call now: `user`, `organization`, `platform`, or `anonymous` for a public task. It is null, and `credential_in_place` false, while no credential is in place, or while several connections could serve and none is the default. Send `Telipot-Principal: user:ana` with discover, inspect or a capability to hear whether Ana's own connection would serve a task that acts as her.
- `terms` are the provider's terms and what they mean for you. Read the note before you use what a task returns.
- `verification` says when the catalog last replayed the task, or why it could not. `example` is a scrubbed response.

## Choose between tasks

When several tasks can do the job, work down this order:

1. A task whose `input` you can fill from what you hold. One that needs an id you lack is no substitute.
2. Then one whose `credential_in_place` is true, so it can run as things stand.
3. Then the lower `price`. A null price is unknown, not free.

## Browse the catalog

Every task, with its price and identity mode, is at https://telipot.com/catalog, and in markdown at https://telipot.com/catalog/md. Every capability is at https://telipot.com/catalog/capabilities/md.
