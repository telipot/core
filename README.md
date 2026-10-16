<p align="center">
  <a href="https://telipot.com">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset=".github/assets/logo-dark.png">
      <img alt="telipot" src=".github/assets/logo-light.png" width="236">
    </picture>
  </a>
</p>

<h3 align="center">The open core of telipot</h3>

<p align="center">
  <a href="LICENSE"><img alt="Licence: Apache 2.0" src="https://img.shields.io/badge/licence-Apache%202.0-4A4D4A?style=flat-square"></a>
  <img alt="Status: pre-release" src="https://img.shields.io/badge/status-pre--release-FF5A1F?style=flat-square">
  <a href="https://telipot.com/catalog"><img alt="Browse the catalog" src="https://img.shields.io/badge/browse-telipot.com%2Fcatalog-4A4D4A?style=flat-square"></a>
</p>

<p align="center">
  <a href="https://telipot.com">Website</a> ·
  <a href="https://telipot.com/catalog">Catalog</a> ·
  <a href="https://docs.telipot.com">Docs</a> ·
  <a href="packages/cli">CLI</a> ·
  <a href="skills/telipot/SKILL.md">Skill</a>
</p>

<br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/carrier-celebrate-dark.png">
  <img alt="The Carrier, telipot's character, celebrating a task that landed" src=".github/assets/carrier-celebrate.png" width="168" align="right">
</picture>

An agent that can only chat is a demo. One that can query Semrush, read a calendar and look up a lead is a worker. Each of those calls needs a vendor's route, its auth, its price and its input schema.

This repository holds all of that as data. Each provider is one YAML file, and each task is one entry in it, with typed input and output, the credential it needs, whose account it acts in and what it costs. A change to the catalog is a pull request with no runtime code.

[telipot](https://telipot.com) runs these tasks for agents on one token. Everything public about it lives here: the catalog, the library that checks it, the API contract, the SDK and the `telipot` CLI. The catalog is open so a fix reaches everyone, and so any tool can read it.

> **Pre-release.** The formats and commands can still change before the first release.

<br clear="right">

## What is here

| Path                                   | What it holds                                                                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `catalog/providers/`                   | One YAML file per provider: its tasks, routes, auth, scopes and prices. A generated `*.extended.yaml` beside it holds a vendor's wider OpenAPI surface |
| `catalog/examples/`                    | One sanitized response per verified task                                                                                                               |
| `catalog/provider.schema.json`         | The provider file's JSON Schema, which each file names in its first line, so an editor underlines a wrong field as it is typed                         |
| `catalog/capabilities.yaml`            | Provider-neutral jobs, such as `email.find`, that several providers' tasks can serve                                                                   |
| `catalog/aliases.yaml`, `queries.yaml` | The words tasks are found by, and the sentences discovery is tested against                                                                            |
| `catalog/fx.yaml`                      | Documented conversions from vendor credits to USD                                                                                                      |
| `catalog/ids.lock.json`                | Every task id ever published. Ids only grow; a retired task stays as a tombstone                                                                       |
| `packages/catalog`                     | `@telipot/catalog`: the schema, the cross-file rules, search, prices, request binding and the catalog commands                                         |
| `packages/contract`                    | `@telipot/contract`: the telipot HTTP API's definition, schemas and errors                                                                             |
| `packages/sdk`                         | `@telipot/sdk`: discover, inspect, run and connect over that contract                                                                                  |
| [`packages/cli`](packages/cli)         | `@telipot/cli`: the `telipot` command, the SDK's verbs at a shell, and `telipot catalog` for contributors                                              |
| `skills/telipot/SKILL.md`              | The skill file an agent installs to find and run tasks: `npx skills add telipot/core`                                                                  |

## The catalog today

| Provider              | Whose data                      | Tasks |
| --------------------- | ------------------------------- | ----: |
| Apollo                | Behind your vendor key          |    13 |
| Exa                   | Behind your vendor key          |     8 |
| Firecrawl             | Behind your vendor key          |    11 |
| Google Analytics 4    | Your organization's own account |     9 |
| Google Calendar       | Your end users' accounts        |     7 |
| Google Search Console | Your organization's own account |     7 |
| Hacker News           | Public                          |     1 |
| Hunter                | Behind your vendor key          |    11 |
| Jina Reader           | Public                          |     1 |
| Semrush               | Behind your vendor key          |    14 |

Ten providers and 82 tasks, across the four kinds of data a task can reach: public data, data behind a vendor key, your organization's own accounts, and your end users' accounts.

## What a task looks like

```yaml
- id: hackernews.news.search
  capability: news.search
  platform: news
  auth: public
  kind: data
  method: GET
  path: /search
  name: Hacker News stories by query, ranked by relevance
  summary: Search Hacker News stories and comments
  input:
    queryParams:
      query: { type: string, required: true, example: agent tools }
      tags: { type: string, required: false, enum: [story, comment], default: story }
      hitsPerPage: { type: integer, required: false, min: 1, max: 50, default: 10 }
  test_request: { queryParams: { query: agent tools, hitsPerPage: 2 } }
  cost: { type: free }
  verified: 2026-10-05
  example_response: examples/hackernews.news.search.json
  output:
    type: object
    required: [hits, hitsPerPage, nbHits, nbPages, page, query]
    # properties: the JSON Schema of every field the answer carries
```

The schema refuses unknown fields, and cross-file rules check ids, capabilities, prices and examples. A task that acts in someone's account names its `principal`, so an agent is never left to guess whose account a call opens.

## Contribute

You can fix a task in an afternoon, with no telipot account and no vendor key.

```bash
git clone https://github.com/telipot/core && cd core
bun install
bun run telipot catalog validate                      # every rule, offline
bun run telipot catalog new <provider> --openapi <url> # scaffold from a vendor's OpenAPI document
bun run telipot catalog verify <provider> --dry-run    # the calls a live check would make, and their price
```

1. Pick a provider or a task to improve. A new provider names its docs, auth, the principal it acts as, its useful tasks and the source of its price.
2. Generate from OpenAPI where the vendor publishes one, or write the file from its documentation. Read the closest existing provider first.
3. Choose 8 to 15 tasks an agent would reach for. Fill in input, output, auth, scope, principal, kind and the price with its source.
4. Run `catalog validate`. If you want, verify live with your own key and an explicit budget: `bun run telipot catalog verify <provider> --budget 0.50`. No key ever enters the pull request.
5. Open a pull request with your sources and what you verified, signed off under the [Developer Certificate of Origin](https://developercertificate.org/) (`git commit -s`).

Small fixes count as much as new providers: a tighter input constraint, a price with its source, a response schema, a route that moved.

## Open here, hosted at telipot

Everything needed to read, check and improve a provider is in this repository. The hosted service at [telipot.com](https://telipot.com) adds what cannot be public: stored credentials, whose account a call runs as, consent, quotes, billing and the audit log. Calls on public data and on your own keys cost $0 from telipot.

A merged change does not deploy itself. It reaches the hosted gateway when telipot moves its pin of this repository to it, after a review of where each changed provider sends a credential.

## Licence

[Apache 2.0](LICENSE). Vendor names, logos, OpenAPI documents and API responses belong to their owners. This licence covers the catalog's own text and code, and grants no access to any vendor's API.

<br>

<p align="center">
  <sub>Made by <a href="https://missing.studio">missing studio</a> · <a href="mailto:hello@missing.studio">hello@missing.studio</a></sub>
</p>
