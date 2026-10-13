import { assert, describe, it } from "@effect/vitest";
import { Result, Schema } from "effect";

import { type Entry, type Served, formatPath } from "./rules";
import { type AliasesFile, type ProviderHeader, type QueriesFile, Task } from "./schema";
import { type Search, checkSearch } from "./search";

// Inline catalogs, so each test holds every live task its idf and soft words count over.

const header = (provider: string, display_name: string): ProviderHeader => ({
  provider,
  display_name,
  base_url: `https://api.${provider}.example`,
  docs_url: `https://docs.${provider}.example`,
  source: { docs: `https://docs.${provider}.example`, openapi: null, curated: "2026-10-04" },
  version: "2026-10-04",
  route_match: "normalized",
  retention: "standard",
});

const acme = header("acme", "Acme");

// A live, public, unpriced core task of acme's; `written` overrides its file,
// `over` the entry served.
const entry = (
  id: string,
  name: string,
  written: object = {},
  over: Partial<Entry> = {},
): Entry => {
  const task = Schema.decodeSync(Task)({
    id,
    auth: "public",
    method: "GET",
    path: "/",
    name,
    summary: "",
    input: {},
    ...written,
  });
  return {
    task,
    provider: acme,
    tier: "core",
    platform: task.platform,
    access: { _tag: "Public" },
    verification: undefined,
    example: undefined,
    price: undefined,
    inputSchema: { type: "object" },
    decodeInput: () => Result.succeed({}),
    baseUrl: acme.base_url,
    vendorScopes: [],
    idempotent: true,
    tombstone: undefined,
    ...over,
  };
};

// Tasks no sentence in a test names, counted toward its idf and soft words.
const others = (n: number) =>
  Array.from({ length: n }, (_, index) => entry(`other-${index}`, "Other thing"));

const free = { price: { type: "free" } } as const;
const retired = {
  tombstone: { status: "retired", note: "Replaced", supersededBy: undefined },
} as const;

const searchOver = (
  tasks: ReadonlyArray<Entry>,
  { capabilities = {}, aliases = {} }: Partial<Pick<Served, "capabilities"> & AliasesFile> = {},
) => checkSearch({ tasks, capabilities, aliases }, undefined).search;

const ids = (search: Search) =>
  search._tag === "Found" ? search.hits.map(({ task }) => task.id) : [];

describe("a search", () => {
  it("ranks the tasks a sentence matches, rare words first, before tier or price", () => {
    const search = searchOver([
      entry("a", "Page text", {}, free),
      entry("b", "Page english", {}, { tier: "extended" }),
      entry("c", "Text links"),
      entry("d", "Text title"),
      ...others(8),
    ]);
    assert.deepStrictEqual(ids(search("page text english")), ["b", "a"]);
  });

  it("reads each word through aliases.yaml, once", () => {
    const search = searchOver(
      [
        entry("a", "Page text"),
        entry("b", "Page text in English"),
        entry("pl", "Page links"),
        ...others(10),
      ],
      { aliases: { webpage: "page" } },
    );
    for (const sentence of ["webpage text", "page text", "webpage page text"]) {
      assert.deepStrictEqual(ids(search(sentence)), ["a", "b"], sentence);
    }
  });

  // Both tasks hold all three words, at weights 1, 3, 1 and 1, 1, 3: equal in
  // exact arithmetic, but summed in query order the floats differ by one ulp.
  it("ranks scores equal in exact arithmetic as a tie, whatever the floats sum to", () => {
    const search = searchOver([
      entry("x", "Beta", { summary: "Alpha gamma" }, { tier: "extended" }),
      entry("y", "Gamma", { summary: "Alpha beta" }),
      ...others(2),
    ]);
    assert.deepStrictEqual(ids(search("alpha beta gamma")), ["y", "x"]);
  });

  it("breaks a tie core before extended, then cheapest first, then in the order given", () => {
    const search = searchOver([
      entry("x", "Widgets newest", {}, { tier: "extended", ...free }),
      entry("y", "Widgets newest"),
      entry("u1", "Gadgets list"),
      entry("u2", "Gadgets list"),
      entry("f", "Gadgets list", {}, free),
      ...others(6),
    ]);
    assert.deepStrictEqual(ids(search("newest")), ["y", "x"]);
    assert.deepStrictEqual(ids(search("gadgets")), ["f", "u1", "u2"]);
  });

  it("lets a sentence of three words or more miss one in three, and a shorter one none", () => {
    const search = searchOver([
      entry("a", "Page text by URL"),
      entry("b", "Page text by URL in English"),
      entry("g", "Gizmos"),
      entry("t", "Translated"),
      ...others(8),
    ]);
    assert.deepStrictEqual(ids(search("page text english")), ["b", "a"]);
    assert.deepStrictEqual(ids(search("page translated english")), ["b"]);
    // Six words once the function words go: two may miss.
    assert.deepStrictEqual(ids(search("page text by url for gizmos translated in english")), ["b"]);
    assert.deepStrictEqual(ids(search("gizmos english")), []);
  });

  // Eight live tasks: report is in three, more than a quarter; export in two.
  it("never counts a soft word against a task, and a word in exactly a quarter is not soft", () => {
    const search = searchOver([
      entry("g", "Graph insights"),
      entry("r1", "Report one"),
      entry("r2", "Report two"),
      entry("r3", "Report three"),
      entry("e1", "Export one"),
      entry("e2", "Export two"),
      ...others(2),
    ]);
    assert.deepStrictEqual(ids(search("graph report")), ["g"]);
    assert.strictEqual(search("graph export")._tag, "Missed");
  });

  it("counts idf and soft words over every live task, whatever the filters", () => {
    const search = searchOver([
      entry("g", "Graph insights", {}, { provider: header("zeta", "Zeta") }),
      entry("r1", "Report one"),
      entry("r2", "Report two"),
      entry("r3", "Report three"),
      ...others(4),
    ]);
    assert.deepStrictEqual(ids(search("graph report", { filters: { provider: "zeta" } })), ["g"]);
    const zeta = header("zeta", "Zeta");
    const ranked = searchOver([
      entry("z1", "Alpha gamma", {}, { provider: zeta }),
      entry("z2", "Beta gamma", {}, { provider: zeta }),
      ...["one", "two", "three"].map((n) => entry(`a-${n}`, `Alpha ${n}`)),
      ...others(3),
    ]);
    assert.deepStrictEqual(ids(ranked("alpha beta gamma", { filters: { provider: "zeta" } })), [
      "z2",
      "z1",
    ]);
  });

  it("honours the limit, eight unless given, and the filters", () => {
    const search = searchOver([
      ...["w1", "w2", "w3", "w4", "w5", "w6", "w7"].map((id) => entry(id, "Widgets list")),
      entry("wx", "Widgets list", {}, { tier: "extended" }),
      entry("wa", "Widgets list", { kind: "action" }),
      entry("wz", "Widgets list", {}, { provider: header("zeta", "Zeta") }),
    ]);
    assert.lengthOf(ids(search("widgets")), 8);
    assert.deepStrictEqual(ids(search("widgets", { limit: 2 })), ["w1", "w2"]);
    for (const limit of [0, -2]) {
      assert.deepStrictEqual(search("widgets", { limit }), { _tag: "Found", hits: [] });
    }
    assert.deepStrictEqual(ids(search("widgets", { filters: { tier: "extended" } })), ["wx"]);
    assert.deepStrictEqual(ids(search("widgets", { filters: { kind: "action" } })), ["wa"]);
    assert.deepStrictEqual(ids(search("widgets", { filters: { provider: "zeta" } })), ["wz"]);
    assert.deepStrictEqual(search("widgets", { filters: { provider: "nobody" } }), {
      _tag: "Missed",
      nearMisses: [],
    });
  });

  // Four words may miss one; report is soft, so it never counts against a task.
  it("names what each near miss matched and missed, nearest first, up to the limit", () => {
    const search = searchOver([
      entry("r1", "Report run"),
      entry("r2", "Report list"),
      entry("r3", "Report invoices"),
      entry("i", "Invoices list"),
      entry("c", "Customer accounts"),
      entry("o", "Orders shipped"),
      ...others(2),
    ]);
    const nearMisses = (limit?: number) => {
      const found = search("report invoices customer orders", { limit });
      assert(found._tag === "Missed");
      return found.nearMisses.map(({ entry, matched, missed }) => [entry.task.id, matched, missed]);
    };
    assert.deepStrictEqual(nearMisses(), [
      ["r3", ["report", "invoices"], ["customer", "orders"]],
      ["c", ["customer"], ["invoices", "orders"]],
      ["o", ["orders"], ["invoices", "customer"]],
      ["i", ["invoices"], ["customer", "orders"]],
      ["r1", ["report"], ["invoices", "customer", "orders"]],
      ["r2", ["report"], ["invoices", "customer", "orders"]],
    ]);
    assert.deepStrictEqual(nearMisses(1), [["r3", ["report", "invoices"], ["customer", "orders"]]]);
  });

  it("never counts a word no live task holds, such as a name or a value, against a task", () => {
    const search = searchOver([
      entry("a", "Contacts saved"),
      entry("b", "Companies"),
      ...others(4),
    ]);
    assert.deepStrictEqual(ids(search("saved contacts at openai named john")), ["a"]);
    const missed = search("contacts at openai named john", { filters: { provider: "zeta" } });
    assert.deepStrictEqual(missed, { _tag: "Missed", nearMisses: [] });
    const near = search("companies saved contacts at openai");
    assert(near._tag === "Found");
    assert.deepStrictEqual(ids(near), ["a"]);
  });

  it("matches a word by its stem, and ranks the very word above its stem", () => {
    const search = searchOver([
      entry("one", "Calendar profile", { platform: "calendar" }),
      entry("all", "Calendars list", { platform: "calendar" }),
      entry("e", "Meeting notes"),
      ...others(6),
    ]);
    assert.deepStrictEqual(ids(search("calendars")), ["all", "one"]);
    assert.deepStrictEqual(ids(search("calendar")), ["one", "all"]);
    assert.deepStrictEqual(ids(search("meetings notes")), ["e"]);
  });

  it("reads an alias by its stem, so a key reads its plural", () => {
    const search = searchOver([entry("e", "Events on a calendar"), ...others(6)], {
      aliases: { meeting: "event" },
    });
    assert.deepStrictEqual(ids(search("upcoming meetings")), ["e"]);
  });

  it("reads a URL, an email address or a domain as a value, and request verbs as filler", () => {
    const search = searchOver([
      entry("t", "Page text as markdown by URL"),
      entry("x", "Example values", { summary: "com https" }),
      entry("v", "Email deliverable"),
      ...others(6),
    ]);
    assert.deepStrictEqual(ids(search("get the markdown of https://example.com/a?b=1")), ["t"]);
    assert.deepStrictEqual(ids(search("check if john@example.com is deliverable")), ["v"]);
    assert.deepStrictEqual(ids(search("find the markdown of docs.example.com")), ["t"]);
  });

  it("finds nothing for function words alone, or a word no task holds, an inherited key included", () => {
    const search = searchOver([entry("a", "Page text"), ...others(3)]);
    for (const sentence of ["the a of", "constructor"]) {
      assert.deepStrictEqual(search(sentence), { _tag: "Missed", nearMisses: [] }, sentence);
    }
  });

  it("finds a task by every field it is found by, platform above name above summary", () => {
    const search = searchOver(
      [
        entry("q", "Social posts"),
        entry("s", "Summary only", { summary: "profile" }),
        entry(
          "p",
          "Profile",
          {
            platform: "social",
            capability: "social.page.insights",
            summary: "Insights for a page",
          },
          { provider: header("graph", "Graph Networks") },
        ),
        ...others(6),
      ],
      { capabilities: { "social.page.insights": "Reach and engagement" } },
    );
    assert.deepStrictEqual(ids(search("social")), ["p", "q"]);
    assert.deepStrictEqual(ids(search("profile")), ["p", "s"]);
    for (const word of ["reach", "graph", "networks", "insights"]) {
      assert.deepStrictEqual(ids(search(word)), ["p"], word);
    }
  });

  it("leaves a tombstoned task out of the hits, the near misses and the counts", () => {
    const search = searchOver([
      entry("a", "Page text"),
      entry("old", "Page text, first version", {}, retired),
      ...others(2),
    ]);
    assert.deepStrictEqual(ids(search("page text")), ["a"]);
    assert.deepStrictEqual(search("version"), { _tag: "Missed", nearMisses: [] });
    // Report is in one of four live tasks, exactly a quarter, so it is hard: a
    // misses it as b misses page.
    const counted = searchOver([
      entry("a", "Page text"),
      entry("b", "Report run"),
      ...others(2),
      ...["o1", "o2", "o3", "o4"].map((id) => entry(id, "Report old", {}, retired)),
    ]);
    assert.strictEqual(counted("page report")._tag, "Missed");
  });
});

// The nine widgets tasks tie, so `widgets` ranks them in the order given.
const catalog = [
  entry("text", "Page text"),
  entry("english", "Page english"),
  entry("old", "Page old version", {}, retired),
  ...["w1", "w2", "w3", "w4", "w5", "w6", "w7", "w8", "w9"].map((id) => entry(id, "Widgets list")),
];

interface Written {
  readonly aliases?: AliasesFile["aliases"];
  readonly queries?: QueriesFile;
}

const checked = ({ aliases = {}, queries }: Written) =>
  checkSearch({ tasks: catalog, capabilities: {}, aliases }, queries);

const broken = (written: Written) => {
  const { problems, warnings } = checked(written);
  return {
    problems: problems.map(({ file, path }) => `${file} ${formatPath(path)}`),
    warnings: warnings.map(({ file, path }) => `${file} ${formatPath(path)}`),
  };
};

const rules: ReadonlyArray<readonly [rule: string, written: Written, path: string]> = [
  [
    "an alias key the tokenizer never produces",
    { aliases: { "Web Page": "page" } },
    'aliases.yaml aliases["Web Page"]',
  ],
  [
    "an alias target made only of dropped words",
    { aliases: { gadget: "the" } },
    "aliases.yaml aliases.gadget",
  ],
  // It also warns that no task is found by web.
  [
    "an alias target of two words",
    { aliases: { webpage: "web page" } },
    "aliases.yaml aliases.webpage",
  ],
  [
    "an alias key that a live task is found by",
    { aliases: { page: "text" } },
    "aliases.yaml aliases.page",
  ],
  [
    "a sentence naming no live task",
    {
      queries: {
        mean_reciprocal_rank_at_least: 0,
        queries: [{ task: "page old version", finds: "old" }],
      },
    },
    "queries.yaml queries[0].finds",
  ],
  [
    "a sentence whose task ranks below the first eight",
    { queries: { mean_reciprocal_rank_at_least: 0, queries: [{ task: "widgets", finds: "w9" }] } },
    "queries.yaml queries[0].task",
  ],
  [
    "a mean reciprocal rank under the floor",
    {
      queries: {
        mean_reciprocal_rank_at_least: 0.8,
        queries: [
          { task: "widgets", finds: "w1" },
          { task: "widgets", finds: "w2" },
        ],
      },
    },
    "queries.yaml mean_reciprocal_rank_at_least",
  ],
];

describe("the aliases.yaml and queries.yaml rules", () => {
  for (const [rule, written, path] of rules) {
    it(`refuse ${rule} at the bad field, and nothing else`, () => {
      assert.deepStrictEqual(broken(written).problems, [path]);
    });
  }

  it("accept aliases and sentences that break no rule", () => {
    assert.deepStrictEqual(
      broken({
        // Only the retired task is found by version.
        aliases: { webpage: "page", version: "page" },
        // Ranks 1 and 8, a mean reciprocal rank of exactly the floor.
        queries: {
          mean_reciprocal_rank_at_least: 0.5625,
          queries: [
            { task: "widgets", finds: "w1" },
            { task: "widgets", finds: "w8" },
          ],
        },
      }),
      { problems: [], warnings: [] },
    );
  });

  it("warn on an alias target no live task is found by, and still accept it", () => {
    const written = { aliases: { gizmo: "thingamajig" } };
    assert.deepStrictEqual(broken(written), {
      problems: [],
      warnings: ["aliases.yaml aliases.gizmo"],
    });
    assert.include(checked(written).warnings[0]?.message, "thingamajig");
  });
});
