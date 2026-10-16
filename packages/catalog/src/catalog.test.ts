import { BunServices } from "@effect/platform-bun";
import { assert, describe, it, layer } from "@effect/vitest";
import { type CatalogFixtureName, catalogFixtures } from "@telipot/fixtures/catalog";
import {
  BigDecimal,
  Context,
  DateTime,
  Effect,
  FileSystem,
  JsonSchema,
  Layer,
  Option,
  Predicate,
  Result,
  Schema,
  SchemaParser,
  SchemaRepresentation,
} from "effect";
import { TestClock } from "effect/testing";

import { Catalog, formatIssue } from "./catalog";
import { quote, reserve } from "./price";
import { type Entry, outputCheck, scopesMissing, takesOwnApp } from "./rules";

const catalogAt = (path: string) => Catalog.layer(path).pipe(Layer.provide(BunServices.layer));

const entry = Effect.fnUntraced(function* (id: string) {
  const found = (yield* Catalog).get(id);
  if (Option.isNone(found)) return assert.fail(`${id} is not in the catalog`);
  return found.value;
});

// The native figures are written out: two equal decimals can differ in scale.
const paid = Effect.fnUntraced(function* (id: string) {
  const { price } = yield* entry(id);
  if (Predicate.isUndefined(price) || price.type === "free")
    return assert.fail(`${id} is not paid`);

  const { native } = price;
  return {
    ...price,
    usd: price.usd && BigDecimal.format(price.usd),
    native: native && {
      floor: BigDecimal.format(native.floor),
      ceiling: BigDecimal.format(native.ceiling),
    },
  };
});

const credentialed = ({ task, access }: Entry) =>
  access._tag === "Credentialed" ? access : assert.fail(`${task.id} is public`);

const realCatalog = `${import.meta.dirname}/../../../catalog`;

const found = Effect.fnUntraced(function* (query: string) {
  const search = (yield* Catalog).search(query);
  return search._tag === "Found" ? search.hits.map(({ task }) => task.id) : [];
});

const googleProviders = [
  { slug: "google-search-console", principal: "organization" },
  { slug: "google-analytics", principal: "organization" },
  { slug: "google-calendar", principal: "user" },
] as const;

// Behind a vendor key, so the customer's to run until a vendor agreement exists.
const keyBasedProviders = ["semrush", "hunter", "exa", "firecrawl", "apollo"];

layer(catalogAt(realCatalog))("the real catalog", (it) => {
  it.effect("finds Hacker News search from the alias hn", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* found("hn"), ["hackernews.news.search"]);
    }),
  );

  it.effect("finds each task in queries.yaml within the first eight, at the floor or above", () =>
    Effect.gen(function* () {
      // `Catalog.validate` measures nothing without the file, so a deleted one would pass.
      const fs = yield* FileSystem.FileSystem;
      assert.isTrue(yield* fs.exists(`${realCatalog}/queries.yaml`));
      const { issues } = yield* Catalog.validate(realCatalog);
      assert.deepStrictEqual(issues.map(formatIssue), []);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("serves Hacker News search as a public core task", () =>
    Effect.gen(function* () {
      const search = yield* entry("hackernews.news.search");
      assert.strictEqual(search.provider.base_url, "https://hn.algolia.com/api/v1");
      assert.strictEqual(search.tier, "core");
      assert.deepStrictEqual(search.access, { _tag: "Public" });
      assert.strictEqual(search.task.capability, "news.search");
    }),
  );

  // Scope is per task: Apollo's people search is any_account.
  it.effect("serves the key-based providers' tasks on the organization's key", () =>
    Effect.gen(function* () {
      const { tasks } = yield* Catalog;
      for (const slug of keyBasedProviders) {
        const own = tasks.filter(
          ({ provider, tier }) => provider.provider === slug && tier === "core",
        );

        assert.isAtLeast(own.length, 8, `${slug} curates 8 to 15 tasks`);
        assert.isAtMost(own.length, 15, `${slug} curates 8 to 15 tasks`);
        for (const found of own) {
          assert.strictEqual(credentialed(found).principal, "organization", found.task.id);
        }
      }

      const ownAccount = tasks
        .filter(
          ({ task, provider }) =>
            task.scope === "own_account" && keyBasedProviders.includes(provider.provider),
        )
        .map(({ task }) => task.id);

      assert.deepStrictEqual(ownAccount.toSorted(), [
        "apollo.account.profile",
        "apollo.email.sequences.search",
        "apollo.people.contacts.create",
        "apollo.people.contacts.search",
      ]);

      assert.strictEqual((yield* entry("apollo.people.search")).task.scope, "any_account");
    }),
  );

  // The loader refuses other own_account mistakes, but cannot know each Google provider's principal.
  it.effect(
    "serves Search Console and GA4 in the organization's accounts and Calendar in a user's",
    () =>
      Effect.gen(function* () {
        const { tasks } = yield* Catalog;
        for (const { slug, principal } of googleProviders) {
          const own = tasks.filter(
            ({ provider, tier }) => provider.provider === slug && tier === "core",
          );

          const [first] = own;
          if (Predicate.isUndefined(first)) return assert.fail(`${slug} has no core task`);
          for (const found of own) {
            const { task } = found;
            assert.strictEqual(task.scope, "own_account", task.id);
            assert.strictEqual(credentialed(found).principal, principal, task.id);
            assert.isDefined(found.example, task.id);
            assert.deepStrictEqual(found.price, { type: "free" }, task.id);
          }

          assert.deepStrictEqual(first.provider.oauth_app, { byo: true }, slug);
          const { scheme } = credentialed(first);
          if (scheme.type !== "oauth2") return assert.fail(`${slug} has no OAuth scheme`);
          assert.deepStrictEqual(scheme.principals, [principal], slug);
          assert.isTrue(scheme.pkce, slug);
          assert.isDefined(scheme.revocation_url, slug);
          // Without it Google issues no refresh token, and the connection dies within the hour.
          assert.deepStrictEqual(scheme.authorization_params, { access_type: "offline" }, slug);
          assert.strictEqual(scheme.refresh, "static", slug);
          assert.strictEqual(scheme.token_type, "Bearer", slug);
        }
      }),
  );

  // The identity gate calls this task as user:ana, so its id is fixed.
  it.effect("serves google-calendar.events.list on a read scope", () =>
    Effect.gen(function* () {
      const { task } = yield* entry("google-calendar.events.list");
      assert.strictEqual(task.kind, "data");
      assert.deepStrictEqual(task.required_scopes, ["calendar.readonly"]);
    }),
  );

  it.effect("accepts Search Console analytics rows with and without dimensions", () =>
    Effect.gen(function* () {
      const { task } = yield* entry("google-search-console.search.analytics");
      if (Predicate.isUndefined(task.output)) return assert.fail("missing output schema");
      const check = outputCheck(task.output);
      if (Result.isFailure(check)) return assert.fail(check.failure);
      const totals = { clicks: 1, impressions: 10, ctr: 0.1, position: 2 };
      for (const row of [totals, { ...totals, keys: ["agent"] }]) {
        assert.deepStrictEqual(
          check.success({ rows: [row], responseAggregationType: "byProperty" }),
          [],
        );
      }
    }),
  );

  it.effect("asks Calendar reads for calendar.readonly and writes for calendar.events", () =>
    Effect.gen(function* () {
      const { tasks } = yield* Catalog;
      const writes = ["google-calendar.events.create", "google-calendar.events.update"];
      const calendar = tasks.filter(({ provider }) => provider.provider === "google-calendar");
      assert.isAbove(calendar.length, writes.length);
      for (const { task } of calendar) {
        const write = writes.includes(task.id);
        assert.strictEqual(task.kind === "action", write, task.id);
        assert.deepStrictEqual(
          task.required_scopes,
          [write ? "calendar.events" : "calendar.readonly"],
          task.id,
        );
      }
    }),
  );

  // One provider is one connection and one grant, so the Admin host's tasks name their host.
  it.effect("serves Analytics reports and property listing as one provider on two hosts", () =>
    Effect.gen(function* () {
      const accounts = yield* entry("google-analytics.accounts.summaries");
      const reports = yield* entry("google-analytics.reports.run");
      assert.strictEqual(accounts.provider.provider, reports.provider.provider);
      assert.strictEqual(accounts.task.base_url, "https://analyticsadmin.googleapis.com");
      assert.isUndefined(reports.task.base_url);
      assert.strictEqual(reports.provider.base_url, "https://analyticsdata.googleapis.com");
    }),
  );

  // Neither API documents its list order, so a connection tied to the first item could switch
  // accounts; the Google user's id is stable.
  it.effect("ties a Search Console or GA4 connection to the Google account that granted it", () =>
    Effect.gen(function* () {
      for (const { slug } of googleProviders.filter(
        ({ principal }) => principal === "organization",
      )) {
        const { provider, task } = yield* entry(`${slug}.userinfo.get`);
        assert.deepStrictEqual(
          provider.identity,
          { task: task.id, account_path: "sub", label_path: "email" },
          slug,
        );

        assert.strictEqual(task.base_url, "https://openidconnect.googleapis.com", slug);
        assert.deepStrictEqual(task.required_scopes, ["openid", "email"], slug);
      }
    }),
  );

  it.effect("asks a Search Console connect for every scope its tasks need, and no other", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog;
      assert.deepStrictEqual(catalog.connectScopes("google-search-console", "organization"), [
        "openid",
        "email",
        "webmasters.readonly",
      ]);

      assert.deepStrictEqual(catalog.connectScopes("google-search-console", "user"), []);
      assert.deepStrictEqual(catalog.connectScopes("semrush", "organization"), []);
    }),
  );

  it.effect("leaves out of a session's default scopes those only actions need", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog;
      assert.deepStrictEqual(catalog.connectScopes("google-calendar", "user"), [
        "calendar.readonly",
      ]);

      assert.deepStrictEqual((yield* entry("google-calendar.events.create")).task.required_scopes, [
        "calendar.events",
      ]);
    }),
  );

  it.effect("counts a grant Google confirmed, short names included, as covering the task", () =>
    Effect.gen(function* () {
      const confirmed = [
        "openid",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/webmasters.readonly",
      ];

      for (const id of [
        "google-search-console.userinfo.get",
        "google-search-console.search.analytics",
      ]) {
        assert.deepStrictEqual(scopesMissing(yield* entry(id), confirmed), [], id);
      }

      const reads = ["https://www.googleapis.com/auth/calendar.readonly"];
      assert.deepStrictEqual(scopesMissing(yield* entry("google-calendar.events.create"), reads), [
        "calendar.events",
      ]);

      assert.deepStrictEqual(scopesMissing(yield* entry("google-calendar.events.list"), reads), []);
    }),
  );

  it.effect("says which of a provider's tasks a grant of some scopes can run", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog;
      const runs = (scopes: ReadonlyArray<string>) =>
        catalog.connectTasks("google-calendar", "user", scopes).map(({ task }) => task.id);

      const reads = runs(["calendar.readonly"]);
      assert.include(reads, "google-calendar.events.list");
      assert.notInclude(reads, "google-calendar.events.create");
      assert.includeMembers(runs(["calendar.readonly", "calendar.events"]), [
        ...reads,
        "google-calendar.events.create",
      ]);

      assert.deepStrictEqual(runs([]), []);
      assert.deepStrictEqual(
        catalog.connectTasks("google-calendar", "organization", ["calendar.readonly"]),
        [],
      );

      assert.include(
        catalog.connectTasks("semrush", "organization", []).map(({ task }) => task.id),
        "semrush.seo.keywords.volume",
      );
    }),
  );

  it.effect("carries Semrush's note that its terms limit using its data in AI systems", () =>
    Effect.gen(function* () {
      const { provider } = yield* entry("semrush.seo.keywords.volume");
      assert.match(provider.terms?.url ?? "", /^https:\/\/www\.semrush\.com\//);
      assert.match(provider.terms?.note ?? "", /AI/);
    }),
  );

  it.effect("serves fetch URL as text as a public core task, verified against the vendor", () =>
    Effect.gen(function* () {
      const text = yield* entry("jina-reader.web.page.text");
      assert.deepStrictEqual(text.access, { _tag: "Public" });
      assert.strictEqual(text.verification?.state, "verified");
      assert.isDefined(text.example);
    }),
  );

  it.effect("serves Hacker News search as free", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual((yield* entry("hackernews.news.search")).price, { type: "free" });
    }),
  );

  it.effect("serves the example captured from its test request", () =>
    Effect.gen(function* () {
      const { example } = yield* entry("hackernews.news.search");
      assert.deepInclude(example, { query: "agent tools", hitsPerPage: 2 });
    }),
  );

  it.effect("serves an input schema Effect's importer turns into the call's validation", () =>
    Effect.gen(function* () {
      const { inputSchema } = yield* entry("hackernews.news.search");
      const input = Schema.make<Schema.Codec<unknown>>(
        SchemaRepresentation.fromJsonSchemaDocument(JsonSchema.fromSchemaDraft2020_12(inputSchema))
          .ast,
      );

      const admits = (value: unknown) =>
        Result.isSuccess(
          SchemaParser.decodeUnknownResult(input, { onExcessProperty: "error" })(value),
        );

      assert.isTrue(admits({ query: "agent tools", hitsPerPage: 2 }));
      assert.isFalse(admits({ hitsPerPage: 2 }), "query is required");
      assert.isFalse(admits({ query: "agent tools", hitsPerPage: 51 }), "50 at most");
      assert.isFalse(admits({ query: "agent tools", page: 2 }), "page is no field");
    }),
  );
});

const refusals = (name: CatalogFixtureName) =>
  Layer.build(catalogAt(catalogFixtures[name])).pipe(
    Effect.scoped,
    Effect.flip,
    Effect.map((error) => error.issues.map((issue) => `${issue.file} ${issue.path}`)),
  );

const validate = (name: CatalogFixtureName, previousLock?: ReadonlyArray<string>) =>
  Catalog.validate(catalogFixtures[name], previousLock).pipe(Effect.provide(BunServices.layer));

const validated = (name: CatalogFixtureName) =>
  validate(name).pipe(
    Effect.map(({ issues }) => issues.map(({ file, path }) => `${file} ${path}`)),
  );

const rules: ReadonlyArray<readonly [rule: string, file: string, path: string]> = [
  ["a field outside its schema", "providers/malformed.yaml", "endpoints[0].method"],
  [
    "a field the specification does not name",
    "providers/unknown-field.yaml",
    "endpoints[0].requried_scopes",
  ],
  ["a provider without a version", "providers/no-version.yaml", "version"],
  ["a provider without a base URL", "providers/no-base-url.yaml", "base_url"],
  ["a file that is not valid YAML", "providers/syntax.yaml", ""],
  ["a provider named unlike its file", "providers/misnamed.yaml", "provider"],
  ["a task id used twice", "providers/duplicate-id.yaml", "endpoints[1].id"],
  [
    "a capability outside the taxonomy",
    "providers/unknown-capability.yaml",
    "endpoints[0].capability",
  ],
  ["a public task with a scope", "providers/public-with-scope.yaml", "endpoints[0].scope"],
  ["a credentialed task without a scope", "providers/missing-scope.yaml", "endpoints[0].scope"],
  [
    "an auth scheme the header does not declare",
    "providers/undeclared-scheme.yaml",
    "endpoints[0].auth",
  ],
  [
    "a principal the scheme cannot serve",
    "providers/principal-outside-scheme.yaml",
    "endpoints[0].principal",
  ],
  [
    "an own-account task without a principal",
    "providers/own-account-without-principal.yaml",
    "endpoints[0].principal",
  ],
  [
    "a required scope the scheme does not map",
    "providers/undeclared-scope.yaml",
    "endpoints[0].required_scopes[0]",
  ],
  [
    "an own-account task with a test request",
    "providers/own-account-test-request.yaml",
    "endpoints[0].test_request",
  ],
  ["own-account tasks without an identity", "providers/no-identity.yaml", "identity"],
  [
    "a core task without an output schema",
    "providers/core-without-output.yaml",
    "endpoints[0].output",
  ],
  [
    "an example its output schema does not admit",
    "examples/example-mismatch.data.get.json",
    "items[1].title",
  ],
  [
    "an example that is not there",
    "providers/example-missing.yaml",
    "endpoints[0].example_response",
  ],
  [
    "an output schema Effect cannot import",
    "providers/output-unsupported.yaml",
    "endpoints[0].output",
  ],
  [
    "an output schema with a null where a keyword belongs",
    "providers/output-null-key.yaml",
    'endpoints[0].output.properties.kind["ANDROID or IOS"]',
  ],
  ["a task id missing from the lock", "providers/unlocked.yaml", "endpoints[0].id"],
  ["a locked id removed without a tombstone", "ids.lock.json", "[0]"],
  ["an extended file edited by hand", "providers/edited.extended.yaml", "digest"],
  ["an extended file without its core file", "providers/orphan.extended.yaml", "provider"],
  [
    "an OAuth task without required scopes",
    "providers/oauth-without-scopes.yaml",
    "endpoints[0].required_scopes",
  ],
  ["an identity naming no task", "providers/identity-unknown-task.yaml", "identity.task"],
  ["an identity task that needs input", "providers/identity-needs-input.yaml", "identity.task"],
  ["a task id outside its provider", "providers/foreign-id.yaml", "endpoints[0].id"],
  [
    "a task id that is not lowercase words joined by dots",
    "providers/bad-id.yaml",
    "endpoints[0].id",
  ],
  [
    "own-account extended tasks without an identity",
    "providers/extended-own-account.yaml",
    "identity",
  ],
  [
    "a twin of a core route missing from the lock",
    "providers/twin.extended.yaml",
    "endpoints[0].id",
  ],
  [
    "a platform unlike its capability's first segment",
    "providers/platform-mismatch.yaml",
    "endpoints[0].platform",
  ],
  [
    "a platform capabilities.yaml does not list",
    "providers/unknown-platform.yaml",
    "endpoints[0].platform",
  ],
  ["a capability on an unlisted platform", "capabilities.yaml", 'capabilities["ghost.data.get"]'],
  ["a tombstone without a note", "providers/status-without-note.yaml", "endpoints[0].status_note"],
  ["a tombstone note without a status", "providers/floating-note.yaml", "endpoints[0].status_note"],
  [
    "a successor that is not a live task",
    "providers/bad-successor.yaml",
    "endpoints[0].superseded_by",
  ],
  ["a successor that is a dropped twin", "providers/twin.yaml", "endpoints[1].superseded_by"],
  ["two verification states on one task", "providers/two-states.yaml", "endpoints[0].skipped"],
  [
    "a verified task without its evidence",
    "providers/verified-without-example.yaml",
    "endpoints[0].verified",
  ],
  [
    "an untestable task with a test request",
    "providers/untestable-test-request.yaml",
    "endpoints[0].test_request",
  ],
  [
    "a verification state without a reason",
    "providers/empty-state.yaml",
    "endpoints[0].unverified",
  ],
  ["a miss that is not a 4xx", "providers/bad-miss.yaml", "endpoints[0].miss.status"],
  ["a retry in_body that is no pattern", "providers/bad-retry-pattern.yaml", "retry.in_body"],
  [
    "an input field named in two locations",
    "providers/input-twice.yaml",
    "endpoints[0].input.body.id",
  ],
  [
    "an input field named receipt, the key a run reserves",
    "providers/input-reserved.yaml",
    "endpoints[0].input.queryParams.receipt",
  ],
  [
    "a replay missing a required field with a default",
    "providers/request-required.yaml",
    "endpoints[0].test_request.queryParams.id",
  ],
  [
    "a replay field in the wrong location",
    "providers/request-location.yaml",
    "endpoints[0].test_request.body.id",
  ],
  [
    "a replay value of the wrong type",
    "providers/request-type.yaml",
    "endpoints[0].test_request.queryParams.count",
  ],
  [
    "an undeclared replay field, including inherited names",
    "providers/request-unknown.yaml",
    "endpoints[0].test_request.queryParams.constructor",
  ],
  [
    "a replay missing a path placeholder even when it has a default",
    "providers/request-path.yaml",
    "endpoints[0].test_request.pathParams.id",
  ],
  [
    "a test request that makes a path segment of only dots",
    "providers/request-dots.yaml",
    "endpoints[0].test_request.pathParams.id",
  ],
  [
    "a path placeholder without a declared input field",
    "providers/input-path.yaml",
    "endpoints[0].input.pathParams.id",
  ],
  [
    "a path input field without a placeholder",
    "providers/input-unused-path.yaml",
    "endpoints[0].input.pathParams.id",
  ],
  [
    "input bounds no value can satisfy",
    "providers/input-bounds.yaml",
    "endpoints[0].input.queryParams.id.max",
  ],
  [
    "a length bound that is not a count",
    "providers/input-length.yaml",
    "endpoints[0].input.queryParams.id.min",
  ],
  [
    "integer bounds no integer can satisfy",
    "providers/input-integer-bounds.yaml",
    "endpoints[0].input.queryParams.count.max",
  ],
  [
    "an input default that does not fit its field",
    "providers/input-default.yaml",
    "endpoints[0].input.queryParams.id.default",
  ],
  [
    "an input example that does not fit its field",
    "providers/input-example.yaml",
    "endpoints[0].input.queryParams.count.example",
  ],
  [
    "an input enum value that does not fit its field",
    "providers/input-enum.yaml",
    "endpoints[0].input.queryParams.count.enum[0]",
  ],
  [
    "an input const that does not fit its field",
    "providers/input-const.yaml",
    "endpoints[0].input.queryParams.count.const",
  ],
  [
    "an input const outside its enum",
    "providers/input-const-enum.yaml",
    "endpoints[0].input.queryParams.id.const",
  ],
  [
    "an input constraint Effect cannot import",
    "providers/input-unimportable.yaml",
    "endpoints[0].input.queryParams.values",
  ],
  [
    "a replay outside its field's bounds",
    "providers/request-bounds.yaml",
    "endpoints[0].test_request.queryParams.id",
  ],
  [
    "a replay outside its field's enum",
    "providers/request-enum.yaml",
    "endpoints[0].test_request.queryParams.id",
  ],
  [
    "a replay unlike its field's const",
    "providers/request-const.yaml",
    "endpoints[0].test_request.queryParams.id",
  ],
  [
    "an input header where the scheme sends the key",
    "providers/credential-header-input.yaml",
    `endpoints[0].input.headers["x-api-key"]`,
  ],
  [
    "an input query field where the scheme sends the key",
    "providers/credential-query-input.yaml",
    "endpoints[0].input.queryParams.key",
  ],
  ["a probe on a provider that takes no key", "providers/probe-without-key.yaml", "probe"],
  [
    "a probe naming a scheme the header does not declare",
    "providers/probe-unknown-scheme.yaml",
    "probe.auth",
  ],
  [
    "a probe naming a scheme an end user's key does not go in",
    "providers/probe-misses-a-principal.yaml",
    "probe.auth",
  ],
  ["a probe with both a path and a url", "providers/probe-two-addresses.yaml", "probe"],
  ["a probe's json_path without equals", "providers/probe-half-rule.yaml", "probe.expect"],
  // A connection's secret would be a key to one task and OAuth tokens to another.
  ["a key and OAuth for one principal", "providers/key-and-oauth.yaml", "auth.schemes"],
  // price.test.ts holds one row per pricing rule.
  [
    "a price in a currency fx.yaml has no rate for",
    "providers/currency-without-rate.yaml",
    "endpoints[0].cost.currency",
  ],
];

class Refused extends Context.Service<Refused, ReadonlyArray<string>>()(
  "@telipot/catalog/test/Refused",
) {}

layer(Layer.effect(Refused, refusals("refused")))("the refused fixture catalog", (it) => {
  for (const [rule, file, path] of rules) {
    it.effect(`refuses ${rule} at the bad field`, () =>
      Effect.gen(function* () {
        assert.include(yield* Refused, `${file} ${path}`);
      }),
    );
  }

  it.effect("refuses nothing else", () =>
    Effect.gen(function* () {
      assert.sameMembers(
        [...(yield* Refused)],
        rules.map(([, file, path]) => `${file} ${path}`),
      );
    }),
  );

  // Its aliases.yaml holds a key live tasks here are found by, and its
  // queries.yaml a sentence naming no live task.
  it.effect("measures neither aliases.yaml nor queries.yaml while another rule refuses it", () =>
    Effect.gen(function* () {
      assert.sameMembers(
        yield* validated("refused"),
        rules.map(([, file, path]) => `${file} ${path}`),
      );
    }),
  );
});

// fx.yaml is one file, and the refused catalog's rules need it to decode.
describe("a catalog whose fx.yaml is refused", () => {
  it.effect("refuses a rate without its basis, where it was read, or when", () =>
    Effect.gen(function* () {
      assert.sameMembers(yield* refusals("refused-fx"), [
        "fx.yaml rates_to_usd.EUR.basis",
        "fx.yaml credit_rates_usd.acme.source",
        "fx.yaml meter_rates_usd.acme.api_unit.checked",
      ]);
    }),
  );
});

// These are checked only once no other rule refuses the folder. search.test.ts holds one row per rule.
describe("a catalog whose aliases.yaml and queries.yaml are refused", () => {
  it.effect("refuses the alias and the sentence in Catalog.validate", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* validated("refused-search"), [
        'aliases.yaml aliases["Web Page"]',
        "queries.yaml queries[0].finds",
      ]);
    }),
  );

  // The server never reads queries.yaml, so a ranking change cannot stop a deploy.
  it.effect("refuses the alias at boot and never reads the sentence", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* refusals("refused-search"), [
        'aliases.yaml aliases["Web Page"]',
      ]);
    }),
  );
});

layer(catalogAt(catalogFixtures["clean-input"]))(
  "a catalog with a replay that fits its input",
  (it) => {
    it.effect("accepts every field type and location through the schema it serves", () =>
      Effect.gen(function* () {
        const replay = yield* entry("input-replay.data.get");
        const { properties } = replay.inputSchema;
        if (!Predicate.isObject(properties)) return assert.fail("missing input properties");
        assert.isTrue(Object.hasOwn(properties, "__proto__"));
        assert.isTrue(Object.hasOwn(properties, "constructor"));
        // The path requires its value even when the written flag and default
        // could suggest otherwise; resolving input does not rewrite the record.
        assert.strictEqual(replay.task.input.pathParams?.id?.required, false);
        assert.include(replay.inputSchema.required, "id");
        const schema = Schema.make<Schema.Codec<unknown>>(
          SchemaRepresentation.fromJsonSchemaDocument(
            JsonSchema.fromSchemaDraft2020_12(replay.inputSchema),
          ).ast,
        );

        const decode = SchemaParser.decodeUnknownResult(schema, { onExcessProperty: "error" });
        const flat = Object.fromEntries(
          Object.values(replay.task.test_request ?? {}).flatMap((fields) => Object.entries(fields)),
        );

        assert.isTrue(Result.isSuccess(decode(flat)));
        const { id: _, ...withoutPath } = flat;
        assert.isTrue(Result.isFailure(decode(withoutPath)), "the default does not supply a path");
        assert.isTrue(Result.isFailure(decode({ ...flat, undeclared: true })));
        assert.deepStrictEqual((yield* validate("clean-input")).issues, []);
      }),
    );

    it.effect("allows a task that needs input and has no test request", () =>
      Effect.gen(function* () {
        const unreplayed = yield* entry("input-replay.data.unreplayed");
        assert.isUndefined(unreplayed.task.test_request);
        assert.deepStrictEqual(unreplayed.inputSchema.required, ["id"]);
      }),
    );
  },
);

layer(catalogAt(catalogFixtures.clean))("the clean fixture catalog", (it) => {
  it.effect("serves a task at its own host before its provider's, without a trailing slash", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        (yield* entry("acme.widget.get")).baseUrl,
        "https://widgets.acme.example/v2",
      );

      assert.strictEqual((yield* entry("acme.page.text")).baseUrl, "https://api.acme.example");
    }),
  );

  it.effect("checks a call's input, refusing a path segment of only dots", () =>
    Effect.gen(function* () {
      const { decodeInput } = yield* entry("acme.widget.get");
      assert.deepStrictEqual(decodeInput({ widgetId: "w_1" }), Result.succeed({ widgetId: "w_1" }));
      for (const dots of [".", ".."]) {
        assert.deepStrictEqual(
          decodeInput({ widgetId: dots }),
          Result.fail([{ path: ["widgetId"], message: "cannot make a path segment of only dots" }]),
        );
      }

      assert.isTrue(Result.isSuccess(decodeInput({ widgetId: "w.1" })));
      assert.isTrue(Result.isFailure(decodeInput({ widgetId: "w_1", extra: 1 })));
    }),
  );

  it.effect("acts as the organization when an any_account task names no principal", () =>
    Effect.gen(function* () {
      const text = yield* entry("acme.page.text");
      assert.strictEqual(credentialed(text).principal, "organization");
      assert.strictEqual(credentialed(yield* entry("acme.x.gadgets")).principal, "organization");
      // The record stays as written.
      assert.isUndefined(text.task.principal);
    }),
  );

  it.effect("accepts a capability proposed in the provider's own file", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog;
      assert.strictEqual((yield* entry("acme.widgets.list")).task.capability, "acme.widgets.list");
      assert.strictEqual(catalog.capabilities["acme.widgets.list"], "Widgets in an Acme catalogue");
      assert.strictEqual(catalog.capabilities["web.page.text"], "The readable text of a web page");
    }),
  );

  it.effect("serves every task its files define but the twins, core before extended", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog;
      const served = [
        "acme.page.text",
        "acme.widgets.list",
        "acme.widget.get",
        "acme.page.old",
        "acme.people.search",
        "acme.report.run",
        "acme.people.enrich",
        "acme.page.translate",
        "acme.video.make",
        "acme.widgets.export",
        "acme.x.gadgets",
        "graph.page.insights",
        "graph.x.post-insights",
      ];

      assert.deepStrictEqual(
        catalog.tasks.map(({ task }) => task.id),
        served,
      );

      // acme.x.page shares GET /page and acme.x.widget GET /widgets/{…} with core tasks.
      assert.isTrue(Option.isNone(catalog.get("acme.x.page")));
      assert.isTrue(Option.isNone(catalog.get("acme.x.widget")));
      assert.deepStrictEqual(
        (yield* validate("clean")).tasks.map(({ task }) => task.id),
        served,
      );
    }),
  );

  it.effect("joins an extended task to its core provider's header and scheme", () =>
    Effect.gen(function* () {
      const gadgets = yield* entry("acme.x.gadgets");
      assert.strictEqual(gadgets.tier, "extended");
      assert.strictEqual(gadgets.provider.base_url, "https://api.acme.example");
      const { scheme } = credentialed(gadgets);
      assert.strictEqual(scheme.type, "api_key");
      assert.deepStrictEqual(scheme.principals, ["organization"]);
    }),
  );

  it.effect("serves the example a task captured", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual((yield* entry("acme.page.text")).example, {
        status: "ok",
        text: "Example Domain",
      });
    }),
  );

  it.effect("serves a task's one verification state with its date or reason", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual((yield* entry("acme.page.text")).verification, {
        state: "verified",
        date: "2026-10-04",
      });

      assert.deepStrictEqual((yield* entry("acme.widget.get")).verification, {
        state: "untestable",
        reason: "needs a widget id only the caller holds",
      });

      assert.isUndefined((yield* entry("acme.widgets.list")).verification);
    }),
  );

  it.effect(
    "serves a task's input as one JSON Schema object, every location's fields by name",
    () =>
      Effect.gen(function* () {
        assert.deepStrictEqual((yield* entry("acme.video.make")).inputSchema, {
          type: "object",
          properties: {
            prompt: { type: "string", examples: ["a widget on a desk"] },
            model: { type: "string", enum: ["small", "large"] },
            resolution: { type: "string", enum: ["512", "1080"], default: "512" },
            duration: { type: "integer", minimum: 2, maximum: 10, default: 5 },
          },
          required: ["prompt", "model"],
          additionalProperties: false,
        });

        assert.deepStrictEqual((yield* entry("acme.widget.get")).inputSchema, {
          type: "object",
          properties: { widgetId: { type: "string", examples: ["w_1"] } },
          required: ["widgetId"],
          additionalProperties: false,
        });
      }),
  );

  it.effect("serves a retired task's tombstone, with why and what replaced it", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual((yield* entry("acme.page.old")).tombstone, {
        status: "retired",
        note: "Replaced by the authenticated route",
        supersededBy: "acme.page.text",
      });

      assert.isUndefined((yield* entry("acme.page.text")).tombstone);
    }),
  );

  it.effect("serves nothing for an id it does not know", () =>
    Effect.gen(function* () {
      assert.isTrue(Option.isNone((yield* Catalog).get("acme.page.unknown")));
    }),
  );

  it.effect("lists the live tasks that serve a capability, cheapest first", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog;
      const serving = (capability: string) =>
        catalog.serving(capability).map(({ task }) => task.id);

      // €0.001 converts below $0.006, and the retired page task serves nothing.
      assert.deepStrictEqual(serving("web.page.text"), ["acme.page.translate", "acme.page.text"]);
      // Free before unpriced, which never ranks as free.
      assert.deepStrictEqual(serving("acme.widgets.list"), [
        "acme.widgets.export",
        "acme.widgets.list",
      ]);

      // $0.0004 a result ranks before $3 per 1,000.
      assert.deepStrictEqual(serving("acme.people.search"), [
        "acme.people.enrich",
        "acme.people.search",
      ]);

      assert.deepStrictEqual(serving("web.page.unknown"), []);
    }),
  );

  it.effect("lists the live tasks in catalog order, those its filters keep", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog;
      const live = (filters?: Parameters<typeof catalog.live>[0]) =>
        catalog.live(filters).map(({ task }) => task.id);

      // The retired page task is no longer live.
      assert.deepStrictEqual(
        live(),
        catalog.tasks.map(({ task }) => task.id).filter((id) => id !== "acme.page.old"),
      );

      assert.deepStrictEqual(live({ provider: "graph" }), [
        "graph.page.insights",
        "graph.x.post-insights",
      ]);

      assert.deepStrictEqual(live({ provider: "graph", tier: "extended" }), [
        "graph.x.post-insights",
      ]);

      assert.deepStrictEqual(live({ capability: "web.page.text" }), [
        "acme.page.text",
        "acme.page.translate",
      ]);

      assert.deepStrictEqual(live({ kind: "action" }), []);
      // Text matches an id, a name or a summary, in any case.
      assert.deepStrictEqual(live({ text: "WIDGET" }), [
        "acme.widgets.list",
        "acme.widget.get",
        "acme.widgets.export",
      ]);

      assert.deepStrictEqual(live({ text: "translated" }), ["acme.page.translate"]);
      assert.deepStrictEqual(live({ text: "x.gadg" }), ["acme.x.gadgets"]);
      assert.deepStrictEqual(live({ text: "insights", tier: "core" }), ["graph.page.insights"]);
    }),
  );

  it.effect("keeps a reviewed field corrected by hand in an extended file", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* entry("acme.x.gadgets")).task.name, "Acme gadgets, newest first");
    }),
  );

  it.effect(
    "keeps a route that differs by placeholder name when the provider matches exactly",
    () =>
      Effect.gen(function* () {
        assert.strictEqual(
          (yield* entry("graph.x.post-insights")).task.path,
          "/{post_id}/insights",
        );
      }),
  );

  it.effect("lists the platforms with their labels", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog;
      assert.strictEqual(catalog.platforms["social"], "Social networks");
    }),
  );

  it.effect("reads a task's success rule and its no-result status", () =>
    Effect.gen(function* () {
      const { task } = yield* entry("acme.page.text");
      assert.deepStrictEqual(task.expect, { json_path: "status", equals: "ok" });
      assert.deepStrictEqual(task.miss, { status: 404, means: "the page does not exist" });
    }),
  );

  it.effect("prices a call in integer micro-USD, with where the price came from", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* paid("acme.page.text"), {
        type: "per_call",
        currency: "USD",
        usd: "1",
        native: { floor: "0.006", ceiling: "0.006" },
        microUsd: { floor: 6000, ceiling: 6000 },
        per: 1,
        unit: "call",
        source: "docs",
        sourceUrl: "https://docs.acme.example/pricing",
        checked: "2026-10-04",
        confidence: "documented",
        settle: { type: "quote" },
      });
    }),
  );

  it.effect("keeps the provider's figure as an exact decimal, never a float", () =>
    Effect.gen(function* () {
      const { cost } = (yield* entry("acme.page.text")).task;
      if (cost?.type !== "per_call" || Predicate.isUndefined(cost.value))
        return assert.fail("not priced per call");

      assert.strictEqual(BigDecimal.format(cost.value), "0.006");
    }),
  );

  it.effect("leaves a task with no cost block unpriced, never free", () =>
    Effect.gen(function* () {
      assert.isUndefined((yield* entry("acme.widgets.list")).price);
    }),
  );

  it.effect("serves a free task as free, asynchronous or not", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual((yield* entry("acme.widgets.export")).price, { type: "free" });
    }),
  );

  it.effect(
    "prices a result by the block its value covers, the linear slice a reserve scales",
    () =>
      Effect.gen(function* () {
        assert.deepInclude(yield* paid("acme.people.search"), {
          type: "per_result",
          currency: "USD",
          usd: "1",
          native: { floor: "3", ceiling: "3" },
          microUsd: { floor: 3_000_000, ceiling: 3_000_000 },
          per: 1000,
          unit: "row",
        });
      }),
  );

  it.effect(
    "prices credits at the provider's own rate in fx.yaml, the rate a charge settles at",
    () =>
      Effect.gen(function* () {
        // 1.5 credits at $0.012 each, charged only when the async job succeeds;
        // the credits it reports settle at the same rate.
        assert.deepInclude(yield* paid("acme.report.run"), {
          type: "per_success",
          currency: "credit",
          usd: "0.012",
          native: { floor: "1.5", ceiling: "1.5" },
          microUsd: { floor: 18_000, ceiling: 18_000 },
          per: 1,
          unit: "call",
          settle: { type: "reported_charge", path: "usage.credits" },
        });
      }),
  );

  it.effect("prices a provider meter at its rate in fx.yaml, per result", () =>
    Effect.gen(function* () {
      // 10 API units a result at $0.00004 a unit; the cost's `unit` names the
      // meter, so it labels the native figure.
      assert.deepInclude(yield* paid("acme.people.enrich"), {
        type: "per_result",
        currency: "api_unit",
        usd: "0.00004",
        native: { floor: "10", ceiling: "10" },
        microUsd: { floor: 400, ceiling: 400 },
        per: 1,
        unit: "result",
        settle: { type: "usage", header: "X-Units-Used" },
      });
    }),
  );

  it.effect("converts a real currency at its rate and rounds up to a whole micro-USD", () =>
    Effect.gen(function* () {
      // €0.001 at $1.1712 is 1,171.2 micro-USD.
      assert.deepInclude(yield* paid("acme.page.translate"), {
        currency: "EUR",
        usd: "1.1712",
        native: { floor: "0.001", ceiling: "0.001" },
        microUsd: { floor: 1172, ceiling: 1172 },
      });
    }),
  );

  it.effect("serves no USD figure for credits whose provider publishes no USD price", () =>
    Effect.gen(function* () {
      assert.deepInclude(yield* paid("graph.page.insights"), {
        currency: "credit",
        usd: undefined,
        native: { floor: "3", ceiling: "3" },
        microUsd: undefined,
        confidence: "documented",
      });
    }),
  );

  it.effect("serves an unknown price with no USD figure and never as free", () =>
    Effect.gen(function* () {
      assert.deepInclude(yield* paid("acme.widget.get"), {
        type: "per_call",
        native: undefined,
        microUsd: undefined,
        confidence: "unknown",
      });
    }),
  );

  it.effect(
    "quotes a table from its cheapest row to its fallback, the ceiling a reserve holds",
    () =>
      Effect.gen(function* () {
        // The cheapest row is the small model at its shortest clip, 2 × $0.06.
        assert.deepInclude(yield* paid("acme.video.make"), {
          type: "per_success",
          currency: "USD",
          usd: "1",
          native: { floor: "0.12", ceiling: "2.5" },
          microUsd: { floor: 120_000, ceiling: 2_500_000 },
          settle: { type: "quote" },
        });
      }),
  );

  it.effect("quotes one request against a served table, and reserves at its fallback", () =>
    Effect.gen(function* () {
      const { price } = yield* entry("acme.video.make");
      // The large model for 4 seconds, 4 × $0.15.
      assert.deepStrictEqual(quote(price, { model: "large", duration: 4 }), Option.some(600_000));
      assert.deepStrictEqual(reserve(price), Option.some(2_500_000));
    }),
  );

  it.effect("keeps a tombstoned task", () =>
    Effect.gen(function* () {
      const { task } = yield* entry("acme.page.old");
      assert.strictEqual(task.status, "retired");
      assert.strictEqual(task.superseded_by, "acme.page.text");
    }),
  );

  it.effect("serves a task on its capability's platform when it names none", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog;
      assert.deepStrictEqual(
        catalog.tasks.flatMap(({ task, platform }) =>
          Predicate.isUndefined(task.platform) && Predicate.isNotUndefined(task.capability)
            ? [`${task.id} ${platform}`]
            : [],
        ),
        ["graph.x.post-insights social"],
      );
    }),
  );
});

describe("the clean fixture catalog on 4 October 2026", () => {
  it.effect("warns about a price or a rate checked more than 90 days before", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.makeUnsafe("2026-10-04").epochMilliseconds);
      const { issues, warnings } = yield* validate("clean");
      assert.isEmpty(issues);
      assert.sameMembers(
        warnings.map(({ file, path }) => `${file} ${path}`),
        [
          "providers/acme.yaml endpoints[2].cost.checked",
          "fx.yaml credit_rates_usd.graph.checked",
          "aliases.yaml aliases.gizmo",
        ],
      );

      assert.include(warnings.find(({ path }) => path === "aliases.gizmo")?.message, "thingamajig");
    }),
  );
});

// The library sees one commit; `telipot catalog validate --previous-lock` hands
// it the lock as it stood before the change.
describe("the clean fixture catalog against a previous lock", () => {
  it.effect("refuses an id the lock dropped, even one renamed in its file too", () =>
    Effect.gen(function* () {
      // As if acme.page.txt had become acme.page.text in its file and the lock.
      const { issues, tasks } = yield* validate("clean", ["acme.page.txt", "acme.page.text"]);
      assert.deepStrictEqual(
        issues.map(({ file, path }) => `${file} ${path}`),
        ["ids.lock.json "],
      );

      assert.include(issues[0]?.message, "acme.page.txt");
      assert.isEmpty(tasks);
    }),
  );

  it.effect("accepts a lock that only grew", () =>
    Effect.gen(function* () {
      const { issues } = yield* validate("clean", ["acme.page.text"]);
      assert.isEmpty(issues);
    }),
  );
});

layer(catalogAt(catalogFixtures.gateway))("the gateway fixture catalog", (it) => {
  it.effect("names an OAuth task's scopes as its provider does, and none for another task", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual((yield* entry("mailbox.messages.list")).vendorScopes, [
        "https://mailbox.example/auth/read",
      ]);

      assert.deepStrictEqual((yield* entry("fetcher.page.text")).vendorScopes, []);
      assert.deepStrictEqual((yield* entry("acme.page.text")).vendorScopes, []);
    }),
  );

  it.effect("names, in its own words, each scope a grant lacks, and none for a key", () =>
    Effect.gen(function* () {
      const mailbox = yield* entry("mailbox.messages.list");
      assert.deepStrictEqual(scopesMissing(mailbox, []), ["read"]);
      assert.deepStrictEqual(scopesMissing(mailbox, ["read"]), ["read"]);
      assert.deepStrictEqual(scopesMissing(mailbox, ["https://mailbox.example/auth/read"]), []);
      assert.deepStrictEqual(scopesMissing(yield* entry("acme.page.text"), []), []);
    }),
  );

  it.effect("says which providers take an organization's own OAuth app", () =>
    Effect.gen(function* () {
      const { provider: mailbox } = yield* entry("mailbox.messages.list");
      assert.isTrue(takesOwnApp(mailbox));
      assert.isFalse(takesOwnApp({ ...mailbox, oauth_app: { byo: false } }));
      // A provider that takes keys has no OAuth app to bring, whatever its file says.
      const { provider: acme } = yield* entry("acme.page.text");
      assert.isFalse(takesOwnApp({ ...acme, oauth_app: { byo: true } }));
    }),
  );
});
