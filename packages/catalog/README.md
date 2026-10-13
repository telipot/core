# @telipot/catalog

Reads the `catalog/` folder into the tasks an agent can call, and refuses to load while any file in it is wrong.

## Why the catalog exists

An agent asks for a job in plain words. To answer, telipot needs a record of every task it can run: the provider, the route, the credential, whose account it acts in, and what comes back. That record is the catalog.

The catalog is data, not code. A provider is one YAML file and a task is one entry in it, so adding a provider is a pull request with no TypeScript in it. The format is `src/schema.ts`, and the rules across files are `src/rules.ts`.

The libraries built on this one read a task's facts from here. Credentials read its scheme, connections its scope and principal, the executor its method, path and input, and metering its price. A wrong field means a call to the wrong route, on the wrong account, at the wrong price. So the catalog is checked once, when it loads, and a bad file stops the load. Nothing is left to catch at call time.

## Why it is a package

Anything that reads the catalog goes through this package: the server, the `telipot` command line, the generators, and the public catalog pages, which `@telipot/ui` renders from `Catalog` through `catalogView`. None of them parses the YAML itself. That makes `telipot catalog validate` in CI and the server at boot give the same answer about the same file.

It depends on nothing else in the stack, so any of them can load it without a database or an HTTP client.

## Why this README

Three places describe the catalog, and each has one job.

- The PRD's "Catalog specification": what a catalog file may say, with every field, every rule and worked examples.
- `src/schema.ts` and `src/rules.ts`: how each rule is checked, with one comment per rule.
- This file: why the package is shaped this way, what callers may rely on, and how to change it safely.

The code cannot say why a rule exists or which fields a caller should read. The PRD does not know the code. This file covers that gap and nothing else. If a line here restates a field table or a rule, cut it.

## What callers get

```ts
import { BunServices } from "@effect/platform-bun";
import { Catalog } from "@telipot/catalog";
import { Effect, Layer, Option } from "effect";

const CatalogLive = Catalog.layer("catalog").pipe(Layer.provide(BunServices.layer));

// Some("https://hn.algolia.com/api/v1/search")
const searchUrl = Effect.gen(function* () {
  const catalog = yield* Catalog;
  return Option.map(
    catalog.get("hackernews.news.search"),
    ({ provider, task }) => `${provider.base_url}${task.path}`,
  );
}).pipe(Effect.provide(CatalogLive));
```

`Catalog.layer(directory)` reads the folder once. It needs `FileSystem` and `Path`, which `BunServices.layer` provides; an extended file's digest is WebCrypto's SHA-256, which every runtime has.

A runtime with no filesystem, such as a Worker, loads a snapshot instead: `buildSnapshot(directory, publications)` reads the same files into one JSON-safe value (`telipot catalog build` writes it as `snapshot.json`), and `Catalog.fromSnapshot(snapshot)` serves the same `Catalog` from it, needing no service. The snapshot is read by the same loader over an in-memory folder, so it decodes, resolves and indexes exactly as its folder does; its YAML files are stored as the JSON they parse to, since parsing YAML took most of a load (172 ms cold for the real catalog from YAML text, 79 ms from JSON). `publications` is the lock's history from git, which a Worker cannot read.

When a file is wrong, the layer fails with `CatalogInvalid`. Each of its `issues` carries `file`, `path` and `message`, and its `message` prints them one per line, grouped by file:

```
examples/example-mismatch.data.get.json items[1].title: Expected string
providers/missing-scope.yaml endpoints[0].scope: required unless auth is public
```

An example that its task's output schema does not admit is reported in the example file, at the bad value, not in the provider file.

The service holds:

- `tasks`: every task served, tombstones included. Providers come in slug order, each with its core tasks before its extended ones.
- `get(id)`: the task with that id in either tier, or none.
- `serving(capability)`: every live task for the job, cheapest first.
- `live(filters?)`: every live task in catalog order, those of one `provider`, `tier`, `kind` or `capability`, and, given `text`, those whose id, name or summary holds it, in any case. `GET /v1/tasks` pages through it.
- `search(query, { limit?, filters? })`: `Found` with the live tasks a sentence in plain words finds, best first, or `Missed` when none qualifies, filtered by `provider`, `tier` or `kind`. `Missed` lists in `nearMisses` the tasks that came closest, most words matched first, with the words each `matched` and the words that counted against it, `missed`; a soft word it lacks, or a word no live task holds, cost it nothing and is left out. `limit`, eight unless given, caps the hits or the near misses and never decides which one comes back, so a limit below one finds no hit and is still `Found`. `POST /v1/discover` is this method behind the gateway.
- `provider(slug)`: a provider with at least one task served, by its header, or none.
- `providers`: every provider with at least one task served, by its header, in the order its first task is.
- `connectScopes(slug, principal)`: the scopes the principal's live tasks on the provider require, each once, in catalog order, leaving out those only `action` tasks require: what a connect session asks for when its caller names none, so such a scope is asked for only when named.
- `connectTasks(slug, principal, scopes)`: the principal's live tasks on the provider that a connection with those scopes can run, in catalog order: what a connect page says the grant, or a key, which needs none, allows.
- `platforms` and `capabilities`. `capabilities` is the taxonomy plus every provider's proposals; the taxonomy's description wins.

`Catalog.validate(directory, previousLock?)` checks the folder as CI does, through the same rules, and never fails on what it finds. It returns every `issue`, every `warning` and, when there is no issue, the `tasks` of the catalog the layer builds from the same folder. A warning is what loads but should be looked at again, such as a price or an `fx.yaml` rate checked more than 90 days ago. Given the lock as it stood before the change, it also refuses an id that `previousLock` holds and `ids.lock.json` no longer does. When the folder holds `queries.yaml`, it measures that catalog's search against it: a sentence whose task is not live, a sentence that does not find its task within the first eight, and a mean reciprocal rank under the file's floor are each an issue. The `aliases.yaml` rules and this measurement read the live tasks a server would hold, so they wait until no other rule refuses the folder: a refused catalog reports neither, nor `aliases.yaml`'s warnings, and they arrive on the run after the rest is fixed. `outputCheck(output)` turns a task's `output` schema into a check on a body: the problems it finds at the body's paths, or why Effect cannot import the schema. The loader refuses a committed example with it, and `telipot catalog verify` a captured response, so the two cannot disagree. `recordVerification(directory, entry, found)` writes what a replay found into the task's core provider file, comments kept, and on a pass the example at the path the task names, or `examples/<task-id>.json` when it names none, so the file `telipot catalog verify` writes is the one this loader reads. An extended task's file is generated, so it refuses one. An `example_response` is a JSON file directly in `examples/`, so neither the loader nor verify reaches past it. `formatPath` prints a problem's path as the issues do, and `formatIssue` prints an issue or a warning on one line, as `CatalogInvalid` prints its issues. `telipot catalog validate` prints the warnings under `WARN`, refused or not, and passes when there is no issue.

The generation module behind `telipot catalog new` writes nothing. `readOpenApi(text, url, patch?)` reads an OpenAPI 3 document with a provider's `SpecPatch` applied, or says why it cannot. `generateProvider({ provider, today, document, core, previous, lock })` takes that document, the existing core and extended YAML text when present, and the current id lock. It returns the new core header when needed, the generated extended file and its report, and the next lock with text to write when ids were added. It owns partial-core decoding, scheme selection, published task continuity, reviewed-field carryover and file serialization. A key scheme is the organization's, and an OAuth scheme serves organizations and users unless the document also takes a key, when it serves users and its tasks act as the user. Fetching, file reads and writes stay in the CLI. A malformed existing file fails with `GenerationRefused`; flagged core fields may still be `null` while a contributor finishes them.

Each task is an `Entry`. `entry.task` is the record exactly as the file wrote it, so some answers live on the entry instead:

- Read `entry.access`, not `task.auth`, `task.scope` or `task.principal`. It is `Public`, or `Credentialed` with the scheme and the principal the task acts as. An `any_account` task that names no principal acts as the organization, yet `task.principal` stays empty.
- Read `entry.provider`, not the extended file's own header. An extended task runs under its core file's header: `base_url`, schemes, `identity`.
- Read `entry.verification`, not `verified`, `unverified`, `untestable` or `skipped`. It is the task's one state, with its date or its reason.
- Read `entry.example`, not `task.example_response`. It is the example's JSON, read at load and typed as JSON. The field is only its path.
- Read `entry.price`, not `task.cost`. It is the price in the provider's own currency and in integer micro-USD, worked out from `fx.yaml`, with the cost's provenance. `{ type: "free" }` is free; none is unpriced, never free.
- Read `entry.inputSchema`, not `task.input`. It is the input as one JSON Schema 2020-12 object: every location's fields by name, closed to any other, the body a call sends. Effect's JSON Schema importer turns it into the call's check.
- Read `entry.tombstone`, not `task.status`, `task.status_note` or `task.superseded_by`. It is why the task can no longer be called, `retired` or `broken`, with its note and its live successor, if any; none while the task is live. The rules refuse a status without its note, so a tombstone always has one.

`entry.vendorScopes` are the scopes the task requires in the provider's own words, as a grant keeps them, and `scopesMissing(entry, granted)` names, in the catalog's words, those a grant of `granted` lacks: none for a task on a key. Google confirms `email` as `https://www.googleapis.com/auth/userinfo.email`, so its providers' files name that scope so.

`entry.tier` says where the task came from: `core` or `extended`. `entry.platform` is the platform the task sits on: as the file writes it, or its capability's first segment when it names none, as an extended task may.

A paid `entry.price` carries its `currency` and `usd` conversion rate independently of its list price. `currency` is the ISO code, `credit`, or the meter's name. `native: { floor, ceiling, rows }` is the price for `per` `unit`s in that currency, and `rows` are its table, which only `quote` reads. `microUsd: { floor, ceiling }` is the same price in integer micro-USD, for display. A value has floor equal to ceiling and no rows; a table runs from its cheapest row to its fallback, which is its ceiling. `native` is none when the list price is unknown. `microUsd` is none then too, and when the provider publishes no USD price for its unit; show `native` instead. A reported USD charge still has its conversion rate when the list price is unknown, so verification can count it without a second money rule. Other unknown prices keep their reported charge unknown. `entry.price.settle` says where a charge is reported.

Work out money with the functions beside the price, never with arithmetic on its fields or by reading `rows`. Each takes the price, never its entry or task. `quote`, `reserve` and `settle` return integer micro-USD, rounded up once so a reserve never falls short. A free task returns zero; quoting and reserving need a known list price and conversion rate, while settlement needs the conversion rate alone.

- `quote(price, values, units?)`: what `units` of what `per` counts cost for a call whose input is `values`, one object by field name as `POST /v1/tasks/{id}/run` sends it, such as `{ model: "large" }`. A table prices it at the first row its values match, defaults filled in, times its `times` field; at the ceiling, its fallback, when no row matches or that field is out of its range. A value prices every call at itself. A quote for `per` units never falls outside the price's floor and ceiling.
- `reserve(price, units?)`: what `units` cost at the ceiling, the most a call of that size is charged and what a reserve holds.
- `settle(price, reported)`: a figure the provider reported, in the cost's own currency, at `price.usd`. A reported USD charge can settle even when its list price is unknown; `quote` and `reserve` still return none for that price. Metering reads the figure from the response, at `settle.path` or `settle.header`.
- `cheapestFirst`: an `Order` on prices by what one unit costs at the ceiling, so $3 per 1,000 rows comes before $0.006 a call. A price with no USD figure and an unpriced task come last, so an unknown price never ranks as free.

How a call is made from a task, an input and a credential is decided here too, so `telipot catalog verify`, the public tools and the gateway build and send the same request (`src/bind.ts`, `src/send.ts`; the executor's retries, timeouts and outcomes stay in `@telipot/executor`):

- `bind(entry, input, credential)` and `request(...)`: each input field placed where the task declares it (path, query, headers or body), on the entry's base URL, and the credential where its scheme says; `inject` places a credential alone.
- `withoutCredential`, `sentForms` and `masked`: the same request with the credential masked, and every form the credential takes on the wire, so a log or capture can strip each.
- `valueAt`, `jsonPathKeys` and `holdsAt`: a value read from an answer by a probe's or an account's JSON path, and whether it equals what is expected.
- `sendOnce(client, maxBytes)`: the bound call sent once, never following a redirect, the credential kept out of the request's span, and the answer read within `maxBytes` (`defaultMaxBytes`, 10 MiB; `AnswerTooLarge` past it) as JSON when it says so, else text. No timeout, retry or outcome: `catalog verify` judges the answer itself (`meetsExpect`), and the gateway's executor adds the rest. `src/send.ts`.

What may leave in a body, a committed example or a debug capture, is decided here too, from one table of contact details:

- `redact(body)`: a body as a debug capture keeps it: every value under a key `isCredentialKey` accepts (a word naming a secret, a snake or camelCase key or key id) masked as `***`, and every contact detail replaced with its placeholder. `@telipot/api-server`'s debug capture store keeps bodies through it.
- `scrubContact(text)` and `contactIn(text)`: each contact detail in a string replaced with its placeholder, and the kinds a string holds. The CLI's `capture` and `scan` read the same table, so what one writes the other never flags.
- `isCredentialKey(key)`: whether a key names a secret, so its value is masked whatever it looks like.

## How a file is checked

- `src/catalog.ts`: Reads every file, parses its YAML or JSON and decodes it. A file that cannot be read, parsed or decoded is recorded and left out. Holds the `Catalog` service and builds it once no rule refuses the catalog: every task by id, the live ones cheapest first for `serving`, and the search over them, with `aliases.yaml` and `queries.yaml` checked against it.
- `src/schema.ts`: Shape: types, patterns, required fields. Unknown keys are refused.
- `src/rules.ts`: Every rule that relates one field to another, a task to its provider, or one file to another. Decides which tasks are served, every core task and each extended task that is not a twin, and builds each one's `Entry` from the values it checked.
- `src/price.ts`: The pricing rules, which `rules.ts` runs on each task, and the price it is served with.
- `src/input.ts`: Proves a task's declared fields, path placeholders and verification replay agree, and builds the input schema from those same fields.
- `src/extended.ts`: What the loader and the extended-file generator must agree on: the digest, the reviewed fields and the twin test.
- `src/openapi.ts`: Reads a vendor's OpenAPI 3 document into what `telipot catalog new` writes: a core file's header, and a task for each operation. Nothing here is read by the loader.
- `src/published.ts`: Reads the routes a vendor's document publishes, OpenAPI 3 through `openapi.ts`'s servers and operations, and Swagger 2 and Google Discovery besides, with the provider's patch applied, for `telipot catalog drift`. Nothing here is read by the loader.
- `src/redact.ts`: The table of contact details and the test for a key that names a secret, which `redact`, `scrubContact`, `contactIn` and `isCredentialKey` read. Nothing here is read by the loader.
- `src/regenerate.ts`: Writes an extended file whole from those tasks, the core file beside it and the file it replaces. Nothing here is read by the loader.
- `src/generation.ts`: Owns provider generation behind the caller's interface: existing file decoding, scheme selection, published task continuity, generated files and lock updates. Nothing here fetches or writes.
- `src/verification.ts`: Writes what `telipot catalog verify` found: a task's verification state into its provider file, comments kept, and a pass's example where the task names it.
- `src/search.ts`: The words each live task is found by, indexed once; the ranking `Catalog.search` runs over them; and the `aliases.yaml` and `queries.yaml` rules, which `catalog.ts` runs on the catalog it builds, the second only for `Catalog.validate`.

A new check that reads one field goes in `schema.ts`. A check that reads two goes in `rules.ts`, or `price.ts` when it is about a price, `input.ts` when it is about the input, and `search.ts` when it is about a word or what a sentence finds.

## Decisions that look like extra work

- **One bad file stops the whole load.** Serving the rest would drop that provider's tasks without a word, and every agent holding one of their ids would start getting 404s. A refused load is loud, and CI catches it before the server does.
- **Every issue, not the first.** The rules run once over every file that decoded, so one broken rule never hides another. A contributor fixes a file in one pass. The search's rules wait: `aliases.yaml` and `queries.yaml` are measured against the live tasks a server would hold, so they run once nothing else refuses the catalog. On part of it they would blame `queries.yaml` for a task whose own file broke, and pass an alias that collides only with a refused task.
- **Unknown keys are refused.** A misspelled field such as `requried_scopes` would otherwise vanish, and the task would run without its scope check. A field joins `schema.ts` when the first code reads it. An `output` schema is held to the same: a null under a key, which an unquoted comma in a YAML flow mapping leaves behind, is refused.
- **A provider is one connection, so a task may name its own host.** A connection is one credential for one provider. A product a vendor serves from several hosts, as Google serves Analytics, stays one provider and one grant: a task sets `base_url` when its host is not the provider's, and `source.openapi` lists one document for each host. The identity task names the account a connection belongs to, so it is one the connect flow can call with no input: no placeholder in its path and no required field.
- **Core wins over extended.** A person curated the core file; the extended file came out of a spec. When both offer one method and path, the live extended task is a twin: checked, locked, never served. A published extended id replaced by core stays served as a tombstone, so its caller gets a 410 and its successor. Placeholder names are ignored when routes are compared, unless the provider sets `route_match: exact`. That is for APIs where the placeholder is the route, such as a graph whose first segment is a node id.
- **Extended files carry a digest.** They are regenerated from the provider's spec, so a hand edit would be lost on the next run. The digest leaves out `reviewedFields`, so a reviewer can still correct `kind`, `name`, `capability`, `scope` or `principal` in place. It hashes the file as written, not as decoded, so a new decoding default changes no digest.
- **The generator writes the extended file whole from the spec and its published history.** Dates stay while only reviewed fields differ, the documentation page is the spec's own or its address, and operation order changes no output. Published ids, reviewed fields and recorded verification stay with their tasks. It carries each reviewed field whole, so a reviewer who removes `kind: action` keeps that removal. A locked id the spec no longer offers, or whose route core now curates, is kept as a tombstone, pointing at the core task when there is one; an id the lock never held was never published, and is dropped. Successive-document tests cross `generateProvider`, and the generated files load clean through the real catalog.
- **The scaffold leaves `null` for what a spec does not say.** A guess that passes `validate` and that nothing in the spec backs is a claim nobody checked, such as a documentation page or an OAuth `pkce` flag. (An API key's principal is the exception: the format's own default for a key is the organization.) A `null` fails `validate` at its path, so the file cannot be committed until a person has looked, and the same list is printed and written at the top of the file. What the spec can say is written: the server, each scheme the file format has a place for, and the scopes as the provider's own strings. Operations that need a scheme it cannot declare, such as a cookie, are left out and listed, never given a wrong `auth`.
- **A generated task is never tested with a guess.** `test_request` holds only values the spec documents, for every required field, on a read, and nothing else. A write, or a read with nothing to send, is `untestable` with that reason, since an empty request may be billed in full. A task of the connected account has neither, as `rules.ts` requires.
- **The generator reads OpenAPI and nothing else, and a patch says what a vendor left out.** A guess at what a spec means, such as reading a header named like a key as the API's key, is a rule nobody can look up, and it breaks on the next vendor. OpenAPI 3.2 says a document's security list may be incomplete, so an operation whose security is not declared is left out, not called public. What a vendor's document should have said, the contributor says in `catalog/patches/<provider>.json`: a JSON Patch over the document, applied with `effect`'s `JsonPatch` before every read, so the output stays a function of the spec. Where OpenAPI has a way to say something, it is read that way: a nullable value written `anyOf: [{...}, {type: "null"}]` is the value, `examples` on a schema and `dataValue` on an Example Object are the example, a Path Item's or an operation's `servers` are the task's `base_url`, and a `$ref` is a JSON Pointer, through `effect`'s `JsonPointer`.
- **An asynchronous job comes from a Link.** OpenAPI's way to say "call this next, with this id" is a Link Object, so a submission is asynchronous when one of its success responses links to a GET that reads the job back, passing one path parameter from the response body. That gives the `async` block its poll task and its `id_from`. Which `status` values end the job is the one thing OpenAPI cannot say, so they are read from the linked answer's `status` enum by what they say; a status with no success or no failure, or two Links that could poll, describe nothing.
- **A task that cannot be made is not a task the spec dropped.** A tombstone is served as a 410, so it says what is true: curated in core, no longer offered, or deprecated. A route the spec still has, which no task can be made of this run, such as when a scheme was renamed in the core file, keeps its task as written, and the loader refuses it if it no longer works, rather than answering 410 for an id that did.
- **Ids never go away.** Agents store task ids, so every id ever published is in `ids.lock.json`. A retired task stays as a tombstone with `status` and `status_note`, and a caller learns it is gone and what replaced it. The loader sees one commit only, so renaming an id in both the file and the lock passes on its own. CI catches it by handing `telipot catalog validate --previous-lock` the lock at the merge base.
- **A generated id stays with its published method and path.** Regeneration matches the existing task before attaching reviewed fields or verification. Renaming an operation keeps its id; inserting a route whose name has the same slug cannot take an existing or locked id. A changed method or literal path gets a new id, and the old one remains a tombstone. Placeholder normalization still decides which route core curates, while published continuity uses the literal path so another parameter's request never inherits verification. A Link to a poll route core curates names the core task and its own path parameter.
- **Money is exact.** Amounts decode to Effect's `BigDecimal`, and USD comes out in integer micro-USD, rounded up so a reserve never falls short. A float never reaches a quote or the ledger.
- **Prices stay in the provider's unit.** USD is worked out from `fx.yaml` at load, so a rate refresh re-prices every task without touching a provider file. Credits and meters convert per provider, because one provider's credit is worth nothing at another. A provider that publishes no USD price for them has `usd: null`, and its tasks show the native figure and no USD one, never a guess.
- **Quoting and settling belong beside the pricing rules, not in metering.** The rules already say how a table row matches a request: in file order, with defaults filled in, and a `times` value out of range at the fallback. They also say what one unit is worth in USD. A quoter or settler in another package would hold the same rules a second time, and the two would drift until the validator passed a table that metering prices differently. So `quote`, `reserve` and `settle` live in `price.ts`, and so does the order discovery ranks prices by. `checkPrice` reads each row onto the served price once, from the input fields the rules check, and the fallback rule caps those same rows, so `quote` takes the price alone, as `reserve` and `settle` do, and cannot be handed one task's input with another task's price.
- **CI validates; the server loads.** `Catalog.validate` and `Catalog.layer` run the same `resolve` and build the same catalog from it, so they give one answer about one file and validate's `tasks` are the layer's. Only CI reads the previous lock and the warnings, so the service the server holds carries neither, and a refused catalog still shows the warnings of its provider files and `fx.yaml`.
- **Free is written one way, and a missing price is never free.** `Cost` is a union of one class per `type`, so `type: free` with anything beside it is refused by the schema. A task with no cost block, or `confidence: unknown`, has no USD figure.
- **An old price warns, and does not refuse.** A price checked 91 days ago is probably still right, and refusing the catalog over it would stop every deploy. The warning reads the clock, so tests on a price's age set `TestClock`.
- **A call's input is one flat object.** `POST /v1/tasks/{id}/run` takes the task's input as one body and the executor binds each field to its location, so a field name may appear in one location only. The input schema the API serves is built from the same fields at load, beside that rule, so the schema an agent reads and the check a call passes cannot drift. `min` and `max` bound a number's value, a string's length or an array's size.
- **Verification replays the declared input.** A present `test_request` must use the field's declared location and satisfy its type and constraints. Required fields and path placeholders need explicit replay values, even when a field has a default, because the transport sends the request as written. Defaults and examples must satisfy their field, and supported bounds must admit a value. A task with no test request keeps the existing verification rules.
- **Search is lexical, and a miss is fixed in the vocabulary.** A sentence loses its URLs, email addresses and domains, which are a task's input and never a word of its job, then is lowercased, split on anything but letters and digits, and stripped of single letters, function words and the request verbs a sentence opens with (get, find, show, check); each word is read through `aliases.yaml`, which maps nouns only, since a verb alias floods its matches. A word matches by its Porter stem (the `stemmer` package), so "meetings" finds "meeting", and an alias key reads every word of its stem. A task is found by its name, its capability's description, its provider's slug and display name, its summary and its platform slug, each field with a weight; a matched word scores that weight times BM25's idf, once for its stem and again when the task holds the very word the sentence wrote, so "calendars" ranks the task named for calendars above one named for a calendar. A word no live task holds, such as a name, a date or a topic, tells no task from another: it neither counts against a task nor toward the miss budget. Of the rest, a sentence of three words or more may miss one word in three, fewer must match every word, and a word in more than a quarter of the live tasks never counts against a task, whatever the filters. Ties rerank by bucket, never a blended score: core before extended, then `cheapestFirst`, then the catalog's slug order; seven-day reliability joins once it exists. When a sentence an agent would write finds nothing, add the word to the capability description or `aliases.yaml`; the scorer does not change for one query. `catalog/queries.yaml` is the fixed set of agent-shaped sentences every ranking change is measured against by `Catalog.validate`: each task within the first eight, the hits a search returns unless given a limit, and the mean reciprocal rank at the file's floor. `src/search.test.ts` ranks tasks that compete on catalogs written inline, so a rank and each rule can fail where the real catalog is still too small to contest one.
- **An alias replaces a word, and the live tasks are indexed once.** `catalog.ts` hands `search.ts` the served tasks once no rule refuses them; it indexes the live ones once, checks `aliases.yaml` against that index and answers `Catalog.search` from it, so the alias rules and the search never disagree about a word, and a tombstoned task is never a hit, and none of its words is one an alias must avoid. Nothing outside `search.ts` sees the tokenizer, the weights, idf, the soft words or the miss budget. An alias replaces the query word rather than adding one, so its key may not be a word any live task is found by, or the alias would hide those tasks from it, and its target is one word, so an alias never changes how many words a sentence has, and with it the miss budget.
- **The server never measures the search.** `queries.yaml` is read by `Catalog.validate` alone, as `previousLock` is, so a ranking change is caught in CI and never stops a deploy.
- **Output schemas go through Effect's JSON Schema importer**, and the captured example must decode under the result. An agent reads `output` to learn what comes back. If Effect cannot import the schema, nothing downstream can use it. If the example does not decode, the schema describes a response the provider does not send.

## Changing the package

File-based test data lives in [@telipot/fixtures](../fixtures/README.md). Import its catalog and OpenAPI paths, and use its scoped `copyDirectory` before changing a dataset. Catalog rules and the tests that assert them stay in this package.

**Add a rule.**

1. Write it in `src/rules.ts`, or `src/price.ts` for a pricing rule, `src/input.ts` for a rule on the input, or `src/search.ts` for a rule on `aliases.yaml` or `queries.yaml`, beside the rules on the same thing, under a comment that states it in one sentence. Report it at the path of the bad field.
2. Add one file to `../fixtures/data/catalog/refused/` that breaks this rule and no other. Put any task id it defines in `../fixtures/data/catalog/refused/ids.lock.json`.
3. Add a row to the `rules` table in `src/catalog.test.ts`: the rule in words, the file, and the path.
4. Run the tests. "refuses nothing else" fails if the new file breaks a second rule, or if the new rule catches a file meant for another.

A pricing rule needs no file. Add a row to the `rules` table in `src/price.test.ts` instead: the rule in words, the task fields that break it written inline, and the path relative to the task. The row fails if those fields break a second rule, and "accept a price of every kind" fails if the rule catches a valid one.

A rule on `aliases.yaml` or `queries.yaml` needs no file either. Add a row to the `rules` table in `src/search.test.ts`: the rule in words, the aliases or sentences that break it written inline, and the path. The row fails if they break a second rule, and "accept aliases and sentences that break no rule" fails if the rule catches a valid one.

If the rule also changes what a valid file means, such as a default or a precedence, add the valid case to `../fixtures/data/catalog/clean/` and assert on the `Entry`.

A rule that reads what the caller passes, such as `previousLock`, has no refused file to add. Test it on `../fixtures/data/catalog/clean/` with the input that breaks it, as `catalog.test.ts` does for `previousLock`.

`fx.yaml` is one file, and the refused catalog's pricing rules need it to decode, so a bad `fx.yaml` goes in `../fixtures/data/catalog/refused-fx/` instead.

**Fix a missed query.** Add the sentence to `catalog/queries.yaml` with the task it should find, watch `telipot catalog validate` refuse it, then add the word it lacks to that task's capability description or map it in `aliases.yaml`. The validator refuses an alias key the tokenizer would never produce or a live task is found by, and a target that is not one word, and warns on a target no task is found by.

**Add a field.** Add it to `src/schema.ts` when the first code reads it, not before. Until then a file that uses it is refused, which is the point. Blocks the PRD names whose fields nothing reads yet (`async`, `resource_ownership`) decode as plain JSON objects. `probe` is read: a path or a url, the method, the scheme the key goes in, and `expect` and `reject` rules on the status, a `json_path` and its `equals`, or a `body_pattern`, with `reject` also read on every task's answer, for a vendor that answers a bad key with a 200; `keyScheme(provider, principal)` names the scheme a principal's pasted key is sent in, the organization's or an end user's, `probeScheme(provider)` a scheme the probe can send one in, the organization's else an end user's, and a probe no such scheme serves is refused, as is one whose named scheme leaves out a principal that pastes a key; `oauthScheme(provider, principal)` names the one OAuth scheme a principal connects through, or none when there are none or several. A provider whose schemes give one principal both a key and OAuth is refused, since a connection keeps one secret. `credentialPlace(scheme)` says where a scheme sends the credential, and a task whose input declares a field there is refused. `Catalog.provider(slug)` reads a provider's header. The pricing rules read only whether `async` is there.

**Change the digest or the reviewed fields.** Every extended file's digest changes with them, the fixtures' included. Update them all in the same change, or the catalog refuses every one. The generator reads the same two definitions, so it changes with them.

**Change what the generator writes.** Add the case to a document in `../fixtures/data/openapi/` (made-up vendors: `widgetly.json` declares its schemes, `keyed.json` declares no security and is read with a patch, `jobs.json` uses Links, `query`, servers of its own and references), and the expected task to `src/openapi.test.ts`. Try it on a real vendor's spec as well, such as `https://api.replicate.com/openapi.json`, with and without a patch: a fixture holds the cases you thought of. Read a rule from the [OpenAPI Specification](https://spec.openapis.org/oas/latest.html) before writing one; if it is not there, it belongs in a provider's patch. A change to the file it writes must keep `src/regenerate.test.ts`'s byte-identical regeneration and its round trip through the loader passing, and the files must stay as `bun run format` leaves them, so a contributor's formatter never makes a diff.

**Run the checks** from `packages/catalog`:

```bash
bun run test
```

```bash
bun run check-types
```

`catalog.test.ts` loads six catalogs with the real layer and mocks no modules: `catalog/` at the repository root, `../fixtures/data/catalog/clean/`, `../fixtures/data/catalog/clean-input/`, `../fixtures/data/catalog/refused/`, `../fixtures/data/catalog/refused-fx/` and `../fixtures/data/catalog/refused-search/`. The input fixture exercises served schemas and verification replays across every field type. `generation.test.ts` exercises successive provider documents through the public generation interface and loads generated files through the catalog. `openapi.test.ts` and `regenerate.test.ts` keep detailed generator coverage on `../fixtures/data/openapi/`. `price.test.ts` runs the pricing rules and the money functions on cost blocks written inline, through `price.ts`'s interface, which metering crosses too. The refused catalog keeps one pricing file, to show the rules run on every task with the folder's `fx.yaml`. `search.test.ts` runs the search and the `aliases.yaml` and `queries.yaml` rules on tasks written inline, through `search.ts`'s interface, so each test holds every live task its idf and soft words are counted over. `../fixtures/data/catalog/refused-search/` holds no task, one bad alias and one bad sentence, to show `Catalog.layer` refuses `aliases.yaml` and only `Catalog.validate` measures `queries.yaml`. The refused catalog keeps one alias and one sentence that would each be refused, to show neither is reported while another rule refuses the folder.
