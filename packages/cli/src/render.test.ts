import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect } from "effect";

import { type Streams, colourFor, renderer, usd, vendorJson } from "./render";
import type { Report } from "./verify";

const { ok, progressPrinter, queue, summary } = renderer({ stdout: false, stderr: false });

const finished: Report = {
  callable: 1,
  variable: undefined,
  queue: [{ id: "a.page.text", listMicroUsd: 0 }],
  passed: [],
  failed: [],
  skipped: [],
  undeclared: [],
  spentMicroUsd: 0,
  unknownCost: [],
  stoppedBefore: undefined,
  unbounded: [],
  rateLimited: undefined,
};

describe("usd", () => {
  it("prints the figure without trailing zeros", () => {
    assert.strictEqual(usd(12_500), "$0.0125");
    assert.strictEqual(usd(4_000), "$0.004");
    assert.strictEqual(usd(1_000_000), "$1");
  });
});

describe("vendorJson", () => {
  it("escapes what could rewrite a terminal, and stays the same JSON", () => {
    // Escape, a bidi override, C1's CSI and a line separator.
    const unsafe = [0x1b, 0x202e, 0x9b, 0x2028].map((point) => String.fromCodePoint(point));
    const answer = { title: `a${unsafe.join("b")}c`, lines: [`d${unsafe[3]}e`] };
    const printed = vendorJson(answer);
    for (const character of unsafe) assert.notInclude(printed, character);
    assert.deepStrictEqual(JSON.parse(printed), answer);
  });
});

describe("queue", () => {
  it("lines the prices up under a header, and names the variable the run needs", () => {
    const printed = queue("hunter", {
      ...finished,
      variable: "HUNTER_API_KEY",
      queue: [
        { id: "hunter.account.usage", listMicroUsd: 0 },
        { id: "hunter.company.enrich", listMicroUsd: 4_900 },
        { id: "hunter.email.verify", listMicroUsd: 12_250 },
        { id: "hunter.company.search", listMicroUsd: undefined },
      ],
    });

    assert.strictEqual(
      printed,
      [
        "hunter · 4 calls · $0.01715 at list price · 1 with no price",
        "",
        "  task                   list price",
        "  hunter.account.usage         free",
        "  hunter.company.enrich     $0.0049",
        "  hunter.email.verify      $0.01225",
        "  hunter.company.search    no price",
        "",
        "set HUNTER_API_KEY to run them",
      ].join("\n"),
    );
  });

  it("says there is nothing to replay when the queue is empty, and says how to replay", () => {
    const printed = queue("exa", { ...finished, queue: [] });
    assert.include(printed, "exa · nothing to replay");
    assert.include(printed, "--again");
  });

  it("says no task has a test request, not that they passed, when nothing can be called", () => {
    const printed = queue("graph", { ...finished, queue: [], callable: 0 });
    assert.strictEqual(printed, "graph · nothing to call: no task has a test request");
  });

  it("needs no key line for a queue of public tasks, and calls a queue of free ones free", () => {
    const printed = queue("hackernews", finished);
    assert.notInclude(printed, "to run them");
    assert.include(printed, "hackernews · 1 call · free");
  });
});

describe("progressPrinter", () => {
  it("prints the headline, then a line per task with its ids lined up", () => {
    const print = progressPrinter();
    const queued = print({
      kind: "queue",
      provider: "exa",
      queue: [
        { id: "exa.web.search", listMicroUsd: 4_000 },
        { id: "exa.web.page.similar", listMicroUsd: undefined },
      ],
      followers: [],
    });

    assert.strictEqual(queued, "exa · 2 calls · $0.004 at list price · 1 with no price\n");
    assert.strictEqual(
      print({
        kind: "passed",
        id: "exa.web.search",
        waitedMs: 287.6,
        calls: 1,
        micro: 4_000,
        source: "listed",
      }),
      "  ✓ exa.web.search         288 ms  $0.004",
    );

    assert.strictEqual(
      print({
        kind: "passed",
        id: "exa.web.page.similar",
        waitedMs: 195,
        calls: 1,
        micro: 4_000,
        source: "reported",
      }),
      "  ✓ exa.web.page.similar   195 ms  $0.004 reported",
    );

    assert.strictEqual(
      print({
        kind: "passed",
        id: "exa.web.search",
        waitedMs: 5,
        calls: 1,
        micro: undefined,
        source: "unknown",
      }),
      "  ✓ exa.web.search           5 ms  cost unknown",
    );

    assert.strictEqual(
      print({
        kind: "passed",
        id: "exa.web.search",
        waitedMs: 40,
        calls: 1,
        micro: 0,
        source: "listed",
      }),
      "  ✓ exa.web.search          40 ms  free",
    );

    assert.strictEqual(
      print({
        kind: "failed",
        id: "exa.web.search",
        message: "401: Invalid API key",
        calls: 1,
        micro: 0,
      }),
      "  ✗ exa.web.search        401: Invalid API key",
    );

    assert.strictEqual(
      print({ kind: "skipped", id: "exa.web.page.similar", sibling: "exa.web.search" }),
      "  – exa.web.page.similar  same request as exa.web.search",
    );
  });

  it("shows a task called more than once at what the calls cost together", () => {
    const print = progressPrinter();
    print({
      kind: "queue",
      provider: "exa",
      queue: [{ id: "exa.web.search", listMicroUsd: 4_000 }],
      followers: [],
    });

    assert.strictEqual(
      print({
        kind: "passed",
        id: "exa.web.search",
        waitedMs: 90,
        calls: 3,
        micro: 12_000,
        source: "reported",
      }),
      "  ✓ exa.web.search    90 ms  $0.012 (3 calls)",
    );

    assert.strictEqual(
      print({
        kind: "failed",
        id: "exa.web.search",
        message: "500: boom",
        calls: 3,
        micro: 12_000,
      }),
      "  ✗ exa.web.search  500: boom  $0.012 (3 calls)",
    );

    assert.strictEqual(
      print({
        kind: "failed",
        id: "exa.web.search",
        message: "500: boom",
        calls: 2,
        micro: undefined,
      }),
      "  ✗ exa.web.search  500: boom  cost unknown (2 calls)",
    );
  });

  it("leaves a cost off a failure that cost nothing, and off one that made no call", () => {
    const print = progressPrinter();
    print({
      kind: "queue",
      provider: "exa",
      queue: [{ id: "exa.web.search", listMicroUsd: 4_000 }],
      followers: [],
    });

    assert.strictEqual(
      print({ kind: "failed", id: "exa.web.search", message: "401: no", calls: 2, micro: 0 }),
      "  ✗ exa.web.search  401: no",
    );

    assert.strictEqual(
      print({
        kind: "failed",
        id: "exa.web.search",
        message: "same request as exa.web.other: 401: no",
        calls: 0,
        micro: 0,
      }),
      "  ✗ exa.web.search  same request as exa.web.other: 401: no",
    );
  });

  it("lines the ids up over the tasks that take a queued task's answer too", () => {
    const print = progressPrinter();
    print({
      kind: "queue",
      provider: "vendor",
      queue: [{ id: "vendor.keywords.volume", listMicroUsd: 0 }],
      followers: ["vendor.keywords.volume.again"],
    });

    assert.strictEqual(
      print({
        kind: "passed",
        id: "vendor.keywords.volume",
        waitedMs: 12,
        calls: 1,
        micro: 0,
        source: "listed",
      }),
      "  ✓ vendor.keywords.volume          12 ms  free",
    );

    assert.strictEqual(
      print({
        kind: "skipped",
        id: "vendor.keywords.volume.again",
        sibling: "vendor.keywords.volume",
      }),
      "  – vendor.keywords.volume.again  same request as vendor.keywords.volume",
    );
  });
});

describe("summary", () => {
  it("opens with the counts and the spend", () => {
    const printed = summary("exa", {
      ...finished,
      passed: ["a", "b"],
      skipped: [{ id: "c", sibling: "a" }],
      spentMicroUsd: 26_000,
    });

    assert.strictEqual(printed, "2 passed · 0 failed · 1 skipped · spent $0.026");
  });

  it("groups failures by status and family, and says when one status explains them all", () => {
    const printed = summary("a", {
      ...finished,
      passed: ["a.page.text"],
      failed: [
        { id: "a.keywords.volume", status: 401, message: "401: bad key", family: "keywords" },
        { id: "a.domains.overview", status: 401, message: "401: bad key", family: "domains" },
      ],
      spentMicroUsd: 12_500,
    });

    assert.include(printed, "1 passed · 2 failed · 0 skipped · spent $0.0125");
    assert.include(
      printed,
      "Failed\n  401 × 2 (domains, keywords): a.keywords.volume, a.domains.overview",
    );

    assert.include(printed, "every failure is 401: the credential or the tooling");
  });

  it("names a run that got no answer as no response", () => {
    const printed = summary("a", {
      ...finished,
      failed: [
        { id: "a.one", status: 0, message: "no response: down", family: "a" },
        { id: "a.two", status: 0, message: "no response: down", family: "a" },
      ],
    });

    assert.include(printed, "no response × 2 (a): a.one, a.two");
    assert.include(printed, "every failure is no response:");
  });

  it("lists the keys output does not name, eight to a task and then a count", () => {
    const paths = Array.from({ length: 10 }, (_, i) => `key${i}`);
    const printed = summary("a", {
      ...finished,
      passed: ["a.page.text", "a.page.links"],
      undeclared: [
        { id: "a.page.text", paths },
        { id: "a.page.links", paths: ["hits[]._highlightResult"] },
      ],
    });

    assert.include(printed, "Not named by output, so the example leaves them out");
    assert.include(
      printed,
      [
        "  a.page.text",
        ...Array.from({ length: 8 }, (_, i) => `    key${i}`),
        "    and 2 more",
        "  a.page.links",
        "    hits[]._highlightResult",
      ].join("\n"),
    );

    assert.include(printed, "full answers: .verify/a/ in the catalog folder");
    assert.notInclude(summary("a", { ...finished, passed: ["a.page.text"] }), "Not named");
  });

  it("separates what it has to say into sections, and only prints a section with something in it", () => {
    const printed = summary("exa", {
      ...finished,
      passed: ["exa.web.search"],
      unknownCost: ["exa.web.research.list"],
      unbounded: ["exa.web.page.similar"],
      stoppedBefore: { id: "exa.web.answer", listMicroUsd: 5_000, leftMicroUsd: 1_000 },
      rateLimited: "exa.web.answer",
    });

    assert.include(printed, "\n\nCost unknown, not free\n  exa.web.research.list");
    assert.include(
      printed,
      "\n\nNot called, since no price bounds them under --budget\n  exa.web.page.similar",
    );

    assert.include(
      printed,
      "! stopped before exa.web.answer: it lists $0.005 and $0.001 of the budget is left",
    );

    assert.include(
      printed,
      "! stopped at exa.web.answer: the vendor kept answering 429; run again to resume",
    );

    assert.notInclude(printed, "Failed");
  });

  it("says nothing was replayed when every task had passed, even one that took a sibling's answer", () => {
    const printed = summary("exa", {
      ...finished,
      queue: [],
      skipped: [{ id: "exa.web.again", sibling: "exa.web.search" }],
    });

    assert.include(printed, "exa · nothing to replay");
    assert.notInclude(printed, "skipped");
  });

  it("says no task has a test request when there was nothing to call", () => {
    assert.strictEqual(
      summary("graph", { ...finished, queue: [], callable: 0 }),
      "graph · nothing to call: no task has a test request",
    );
  });
});

describe("ok", () => {
  it("leads a clean result with a check mark", () => {
    assert.strictEqual(ok("7 providers, 59 tasks valid"), "✓ 7 providers, 59 tasks valid");
  });
});

describe("colourFor", () => {
  const colour = (terminals: Streams, env: Record<string, string>) =>
    colourFor(terminals).pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
    );

  it.effect("paints a terminal and leaves a file plain, each stream on its own", () =>
    Effect.gen(function* () {
      const painted = renderer(yield* colour({ stdout: true, stderr: false }, {}));
      assert.strictEqual(painted.ok("valid"), "\u001b[32m✓\u001b[0m valid");
      assert.strictEqual(painted.warnHeading, "WARN");
      // An empty NO_COLOR counts as unset.
      const stderr = renderer(yield* colour({ stdout: false, stderr: true }, { NO_COLOR: "" }));
      assert.strictEqual(stderr.ok("valid"), "✓ valid");
      assert.strictEqual(stderr.warnHeading, "\u001b[33mWARN\u001b[0m");
    }),
  );

  it.effect("paints nothing under NO_COLOR set to anything, and keeps the glyphs", () =>
    Effect.gen(function* () {
      const plain = renderer(yield* colour({ stdout: true, stderr: true }, { NO_COLOR: "1" }));
      assert.strictEqual(plain.ok("valid"), "✓ valid");
      assert.strictEqual(plain.warnHeading, "WARN");
    }),
  );
});
