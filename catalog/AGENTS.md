# Adding a provider to the catalog

You are adding one provider, or curating more tasks of one, in this folder. You will be given the vendor's API documentation; write every file from it, never from another catalog's file or code. Use the catalog's words, so a task is called a task and not an endpoint or a tool. Take the closest file in `providers/` as your reference implementation:

| The provider is                  | Read                         |
| -------------------------------- | ---------------------------- |
| Public, no credential            | `hackernews.yaml`            |
| Behind a vendor key              | `exa.yaml`, `semrush.yaml`   |
| The organization's own account   | `google-search-console.yaml` |
| Your end users' accounts (OAuth) | `google-calendar.yaml`       |

A provider is one YAML file and a task is one entry in it. Every field and every validator rule is in `packages/catalog/src/schema.ts` and `rules.ts`, the code that enforces them. A change here is YAML, examples and `ids.lock.json`. It is never TypeScript.

Run every command from the repository root. `<provider>` is the slug: lowercase, equal to the file name.

## The eight steps

### 1. Ingest from the provider's OpenAPI, or curate from its docs

```bash
bun run telipot catalog new <provider> --openapi <url-of-the-openapi-document>
```

This writes `providers/<provider>.yaml`, the header with no tasks, and `providers/<provider>.extended.yaml`, a task for every other route the document offers, and adds those ids to `ids.lock.json`. The header carries a comment listing what you must write before `validate` passes; each such field is `null`, so `validate` names it. Read what it guessed too: the display name, the scheme's principals, `pkce` and `refresh`.

With no OpenAPI document, write the file from the docs:

```bash
bun run telipot catalog new <provider>
```

That records `openapi: null` and leaves the header for you to fill.

The header's first line, `# yaml-language-server: $schema=../provider.schema.json`, points an editor with the YAML language server (VS Code, Zed) at the file's JSON Schema, so a wrong field is underlined as you type. Keep it. After a change to `packages/catalog/src/schema.ts`, regenerate the schema: `bun run telipot catalog schema > catalog/provider.schema.json`.

**Never discover a route by calling it.** The published spec decides the method, and the method and the parameter positions come from the same document, never one from the spec and the other from the docs. With no spec, take both from the same docs page. A call that asks "does this route exist" can cost money and teaches nothing the docs did not.

`new` reads only what the [OpenAPI Specification](https://spec.openapis.org/oas/latest.html) defines, and lists each operation it leaves out with why (`packages/cli/README.md`).

When a vendor's document leaves out what OpenAPI could have said, say it in a patch: `patches/<provider>.json`, a JSON Patch (RFC 6902; `add`, `remove` and `replace`) that `new` applies to the document before reading it, every run. A spec that never declares how it takes its key gets the Security Scheme and the `security` it should have had; a job's submission gets the Link to the route that reads it back. A patch writes only OpenAPI, never catalog fields, and each operation says why in its `description`. Commit it with the provider.

`new` reads OpenAPI 3 documents, 3.0 to 3.2. It refuses a Swagger 2 document, and it reads no Google Discovery document; curate those from the docs. It never rewrites a core file you have started: run it again with `--openapi` to refresh only the extended file.

### 2. Select 8 to 15 tasks an agent would reach for

Choose the jobs an agent asks for in a sentence, and always the capabilities other providers in `providers/` already implement, so comparison and failover work. Read `capabilities.yaml` and the other files in `providers/` to see which. Leave the rest in the extended file; it is the breadth, and the core file is the depth.

To promote a task, copy it from the extended file into `endpoints` of your core file and complete it by hand (steps 3 to 6), under an id of the form `<provider>.<capability>`, lowercase words joined by dots; extended ids carry `.x.`. Add the new id to `ids.lock.json`, which `new` does not do for core tasks. Then run `new --openapi` again: the extended copy of that route becomes a tombstone that points at yours, so its id keeps answering. Never edit the extended file by hand.

### 3. Map each task to a capability

A capability names the job, not the vendor's operation: `seo.keywords.volume`, not the vendor's name for its route. Its first segment is the platform, which must be listed under `platforms` in `capabilities.yaml`. If the job is new, propose it under `proposed_capabilities` in your provider file, with a one-line description; never edit the taxonomy to add a capability. A new platform is the one thing you add to `capabilities.yaml`.

Name each task for search, in at most 60 characters: the job in task words, the input the caller must hold, the top outputs. One concept gets one word across the catalog, so read how other providers name it. No dead words (API, get, fetch). Never claim an output the task does not return. `summary` is the vendor's own text, verbatim.

### 4. Describe the inputs, and how the task is authorized

Give every field its type, whether it is required, and any real constraint in `note`, `enum`, `min`, `max` or `default`. A call's input is one flat object: a name appears once across `pathParams`, `queryParams`, `headers` and `body`.

`auth`, `scope` and `principal` say whose credential runs the task. Set all three from the docs:

| The task reads                     | `auth`             | `scope`       | `principal`    | `test_request` |
| ---------------------------------- | ------------------ | ------------- | -------------- | -------------- |
| The same data whoever asks         | `public`           | none          | none           | yes            |
| The same data, behind a vendor key | a scheme           | `any_account` | `organization` | yes            |
| The organization's own account     | a scheme           | `own_account` | `organization` | never          |
| One end user's account             | an `oauth2` scheme | `own_account` | `user`         | never          |

Scope is per task, not per provider. An OAuth task names `required_scopes`, keys of its scheme's `scopes`. A provider with any `own_account` task declares `identity`, naming a task that takes no input and the paths to the account's id and label. Mark a task `kind: action` when it writes to the account.

A provider file holds provider facts only. Which tasks run on telipot's own credential, and which providers telipot holds an OAuth app for, are business decisions telipot keeps privately.

### 5. Record the cost, with its provenance

Write the price in the provider's own unit. The server converts it to USD from `fx.yaml`.

- `type` is `free`, `per_call`, `per_success` (not charged when the call fails) or `per_result`. Free is written `type: free` and nothing else. A task with no `cost` is unpriced, never free.
- `per` and `unit` say what `value` covers, such as `value: 2.00`, `per: 1000`, `unit: row`.
- `currency` is a real currency code, `credit` for the provider's credits, or `meter` with the `unit` that names it. A credit or a meter needs its rate, with its basis and source, in `fx.yaml`.
- A price that is not a flat figure is a `table`, matched in file order on location-qualified fields such as `body.model`, with a `fallback` ceiling. Put narrow rows before broad ones.
- Every price names `source` and `checked`. A `verified` or `documented` one names `source_url`. CI warns when `checked` is over 90 days old.
- `confidence` grades the price: `verified` (observed on the wire), `documented`, `inferred`, `unknown`. When the exact value is unknown, write `confidence: unknown`, say why in `note`, and leave `value` out. Never guess a figure, and never write a price you did not read.

### 6. Give each test a cheap request, or say it cannot be tested

A `public` or `any_account` task carries a `test_request`: the exact request `verify` replays, with the smallest explicit limit, on a public, well-known target such as `example.com`.

**The quota trap.** Never send an empty body, and never leave off the limit. Many vendors answer a request with no limit with their full default result set, and bill for every row of it. Pass `limit: 1` or the smallest page the route accepts, and check the vendor's usage before and after your first run.

Use only example values the vendor documents. If the docs give none, the task is `untestable`, with the reason. Never guess an id. A task whose answer names private individuals, such as a contact lookup, is `untestable` too: no call is possible without reading someone's details.

### 7. Verify, and stamp only what passed

```bash
<PROVIDER>_API_KEY=… bun run telipot catalog verify <provider> --dry-run
<PROVIDER>_API_KEY=… bun run telipot catalog verify <provider> --budget 0.50
```

The credential is read from `<PROVIDER>_API_KEY`: the slug in capitals, dashes as underscores. A provider whose tasks are all public needs none. Verify replays cheapest first, stops before the budget, resumes without paying twice, records each call's measured cost and time in `catalog/.verify/<provider>.jsonl` (not committed), and writes the state and the scrubbed example into the provider file. Never type a state by hand except `untestable`, which verify cannot find.

A task carries at most one of four verification states, each with its reason:

- `verified`: the call passed. Dated; needs the `test_request` it replayed and the `example_response` it captured.
- `unverified`: the call was made and failed. The status and the vendor's own message.
- `skipped`: affordable, but not made, since an identical request passed. Names that sibling.
- `untestable`: no call is possible with a bare credential. No `test_request`.

A task of the account itself (`own_account`) has none: it is replayed against a live connection, by someone who has one.

Every core task has an `output`: the JSON Schema of the vendor's body. Write it from the real answer, and let the example check it. List what an agent should know to plan before it pays, and nothing the answer does not carry.

### 8. Validate, then open the pull request

```bash
bun run telipot catalog validate
```

It must exit clean. Fix every issue at the file and path it names; do not work around one. Then:

1. Branch from `main`. Your change touches `providers/<provider>.yaml`, its extended file, `examples/`, `ids.lock.json`, and when needed `patches/<provider>.json`, `fx.yaml` and `capabilities.yaml`.
2. Check the lock only grew, as CI does: `git show main:catalog/ids.lock.json > /tmp/previous.lock` then `bun run telipot catalog validate --previous-lock /tmp/previous.lock`. An id is never renamed or removed; retire it with `status: retired` and a `status_note`, naming a live `superseded_by` when one replaces it.
3. Run `bun run telipot catalog scan --base $(git merge-base origin/main HEAD)`. It refuses a change that adds a credential, or a contact detail to an example.
4. When the provider has a spec, run `bun run telipot catalog drift`: it compares every route with the vendor's document, with no credential. CI is meant to run it daily, so a route the vendor moved is caught before an agent pays for it.
5. Run `bun run format`, then `bun run check` and `bun run test`.
6. In the description, list the provider, the tasks and why you chose them, where each price came from, how many tasks verified, and every one left `unverified`, `skipped` or `untestable` with its reason.

CI blocks the merge on any validator error, any credential in the diff, and a `verified` task without its example file.

## What an example may carry

An example is the vendor's real answer, kept small: arrays cut to two items, strings to 200 characters, about 10 KB in all. `verify` writes it, and keeps only the keys the task's `output` schema names. Read every example before you commit it. It must carry none of these:

- A named private individual: a person's name, handle or photo.
- A third party's contact details: an email address, phone number or LinkedIn profile. `verify` replaces them with placeholders; do not put one back.
- Your own identity: the account, organization or user ids of the credential you ran with. Examples of `own_account` tasks are scrubbed of first-party identity before they are committed.
- A credential of any kind, in a body, a header, a URL or a note.

When no call can avoid a private individual's data, the task is `untestable`, and there is no example.

## The extended tier

`providers/<provider>.extended.yaml` is generated; `packages/catalog/README.md` explains how. Edit only its reviewed fields, `kind`, `name`, `capability`, `scope` and `principal`, in place: the digest leaves them out, and `new --openapi` carries them across by id.

`new` guesses what a spec cannot say: a write is an `action`, an operation under an OAuth scheme is `own_account` for the `organization`, the rest is `any_account`. Correct each wrong guess, then run `new --openapi` again, which rewrites what the corrected `scope` allows (an `own_account` task has no `test_request`) and the digest with it. A generated task has a `test_request` only where the spec gives an example value for every required field; add the smallest explicit limit when you promote it.

A submission whose response has an OpenAPI Link to the GET that reads the job back gets an `async` block: where the id is, which task polls, and which values of the job's `status` mean done, failed or still going. Most vendors write no Links; add them in the patch, and check the block. A promoted async task's `cost.type` is `per_success`.
