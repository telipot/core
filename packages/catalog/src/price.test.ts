import { assert, describe, it } from "@effect/vitest";
import { BigDecimal, DateTime, Option, Result, Schema, SchemaParser, Struct } from "effect";

import { checkInput } from "./input";
import {
  type Price,
  cheapestFirst,
  checkPrice,
  checkRates,
  pricingOn,
  quote,
  reserve,
  settle,
} from "./price";
import { formatPath, schemaIssues } from "./rules";
import { FxFile, Task } from "./schema";

// Cost blocks written inline; catalog.test.ts shows the loader runs these rules.

const today = DateTime.makeUnsafe("2026-10-04");

const rate = (usd: number | null, checked = "2026-10-04") => ({
  usd,
  basis: "the provider's pricing page",
  source: "https://docs.acme.example/pricing",
  checked,
});

const fx = Schema.decodeUnknownSync(FxFile)({
  rates_to_usd: { EUR: rate(1.1712) },
  // Graph sells credits only through sales, so its tasks have no USD figure.
  credit_rates_usd: { acme: rate(0.012), graph: rate(null) },
  meter_rates_usd: {
    acme: { api_unit: rate(0.00004) },
    graph: { api_unit: rate(null) },
  },
});

const pricing = pricingOn(today, fx);

const documented = {
  type: "per_call",
  currency: "USD",
  value: 0.006,
  source: "docs",
  source_url: "https://docs.acme.example/pricing",
  checked: "2026-10-04",
  confidence: "documented",
  settle: { type: "quote" },
};

const unpublished = {
  ...Struct.omit(documented, ["value"]),
  confidence: "unknown",
  note: "not published",
};

// Narrow rows before broad ones; the fallback is above the large model at its longest clip.
const table = {
  ...Struct.omit(documented, ["value"]),
  table: [
    { when: { "body.model": "small", "body.resolution": "512" }, value: 0.4 },
    { when: { "body.model": "small" }, value: 0.06, times: "body.duration" },
    { when: { "body.model": "large" }, value: 0.15, times: "body.duration" },
  ],
  fallback: { value: 2.5 },
};

const written = (fields: object) => ({
  id: "acme.video.make",
  auth: "api_key",
  scope: "any_account",
  method: "POST",
  path: "/videos",
  name: "Acme video by prompt",
  summary: "Renders a video",
  input: {
    body: {
      prompt: { type: "string", required: true },
      model: { type: "string", required: true, enum: ["small", "large"] },
      resolution: { type: "string", required: false, enum: ["512", "1080"], default: "512" },
      duration: { type: "integer", required: false, min: 2, max: 10, default: 5 },
      count: { type: "integer", required: false, default: 1 },
      style: { type: "string", required: false },
    },
  },
  ...fields,
});

const decode = SchemaParser.decodeUnknownResult(Task, {
  errors: "all",
  onExcessProperty: "error",
});

const refusals = (fields: object, slug = "acme") => {
  const decoded = decode(written(fields));
  if (Result.isFailure(decoded)) return schemaIssues("", decoded.failure).map(({ path }) => path);
  const { price } = checkPrice(decoded.success, { provider: slug }, pricing);
  return Result.isFailure(price) ? price.failure.map(({ path }) => formatPath(path)) : [];
};

const served = (fields: object, slug = "acme") => {
  const task = Schema.decodeUnknownSync(Task)(written(fields));
  const { price } = checkPrice(task, { provider: slug }, pricing);
  if (Result.isFailure(price)) {
    return assert.fail(price.failure.map(({ message }) => message).join("; "));
  }

  return price.success;
};

const rules: ReadonlyArray<readonly [rule: string, fields: object, path: string, slug?: string]> = [
  ["a free price with a value", { cost: { type: "free", value: 1 } }, "cost.value"],
  ["a paid price of zero", { cost: { ...documented, value: 0 } }, "cost.value"],
  [
    "a price without the date it was checked",
    { cost: Struct.omit(documented, ["checked"]) },
    "cost.checked",
  ],
  [
    "a documented price that names no page",
    { cost: Struct.omit(documented, ["source_url"]) },
    "cost.source_url",
  ],
  [
    "an unknown price with a value",
    { cost: { ...documented, confidence: "unknown", note: "no published price" } },
    "cost.value",
  ],
  ["a known price without a value", { cost: Struct.omit(documented, ["value"]) }, "cost.value"],
  [
    "an unknown price that does not say why",
    { cost: { ...Struct.omit(documented, ["value"]), confidence: "unknown" } },
    "cost.note",
  ],
  ["a price with both a value and a table", { cost: { ...table, value: 0.006 } }, "cost.table"],
  ["a table without a fallback", { cost: Struct.omit(table, ["fallback"]) }, "cost.fallback"],
  [
    "a fallback without a table",
    { cost: { ...documented, fallback: { value: 1 } } },
    "cost.fallback",
  ],
  [
    "a settlement without the path to its figure",
    { cost: { ...documented, settle: { type: "reported_charge" } } },
    "cost.settle.path",
  ],
  [
    "an asynchronous task charged per call",
    { async: { id_from: "job_id" }, cost: documented },
    "cost.type",
  ],
  [
    "a currency fx.yaml has no rate for",
    { cost: { ...documented, currency: "GBP" } },
    "cost.currency",
  ],
  [
    "credits fx.yaml has no rate for",
    { cost: { ...documented, currency: "credit" } },
    "cost.currency",
    "other",
  ],
  ["a meter that unit does not name", { cost: { ...documented, currency: "meter" } }, "cost.unit"],
  [
    "a meter fx.yaml has no rate for",
    { cost: { ...documented, currency: "meter", unit: "row_unit" } },
    "cost.unit",
  ],
  [
    "a table row on a field without its location",
    { cost: { ...table, table: [{ when: { model: "small" }, value: 0.1 }] } },
    "cost.table[0].when.model",
  ],
  [
    "a table row on an optional field without a default",
    { cost: { ...table, table: [{ when: { "body.style": "bold" }, value: 0.1 }] } },
    'cost.table[0].when["body.style"]',
  ],
  [
    "a multiplier on a field with no maximum",
    {
      cost: {
        ...table,
        table: [{ when: { "body.model": "small" }, value: 0.1, times: "body.count" }],
      },
    },
    "cost.table[0].times",
  ],
  [
    "a table row written twice",
    {
      cost: {
        ...table,
        table: [
          { when: { "body.model": "small", "body.resolution": "1080" }, value: 0.1 },
          { when: { "body.resolution": "1080", "body.model": "small" }, value: 0.2 },
        ],
      },
    },
    "cost.table[1].when",
  ],
  [
    "a table row hidden behind an earlier, broader row",
    {
      cost: {
        ...table,
        table: [
          { when: { "body.model": "small" }, value: 0.1 },
          { when: { "body.model": "small", "body.resolution": "1080" }, value: 0.2 },
        ],
      },
    },
    "cost.table[1].when",
  ],
  [
    "a fallback below a row's maximum",
    { cost: { ...table, fallback: { value: 1 } } },
    "cost.fallback.value",
  ],
];

describe("the pricing rules", () => {
  for (const [rule, fields, path, slug] of rules) {
    it(`refuse ${rule} at the bad field, and nothing else`, () => {
      assert.deepStrictEqual(refusals(fields, slug), [path]);
    });
  }

  it("accept a price of every kind", () => {
    for (const cost of [
      documented,
      table,
      { type: "free" },
      unpublished,
      { ...documented, currency: "EUR", value: 0.001 },
      { ...documented, currency: "credit", value: 1.5 },
      { ...documented, type: "per_result", currency: "meter", unit: "api_unit", value: 10 },
    ]) {
      assert.deepStrictEqual(refusals({ cost }), [], JSON.stringify(cost));
    }

    assert.deepStrictEqual(refusals({ cost: { ...documented, currency: "credit" } }, "graph"), []);
    assert.deepStrictEqual(refusals({}), []);
  });

  it("warn about a price checked more than 90 days before, and still serve it", () => {
    const task = Schema.decodeUnknownSync(Task)(
      written({ cost: { ...documented, checked: "2026-07-05" } }),
    );

    const { price, warnings } = checkPrice(task, { provider: "acme" }, pricing);
    assert.isTrue(Result.isSuccess(price));
    assert.deepStrictEqual(
      warnings.map(({ path }) => formatPath(path)),
      ["cost.checked"],
    );

    const onTheDay = Schema.decodeUnknownSync(Task)(
      written({ cost: { ...documented, checked: "2026-07-06" } }),
    );

    assert.isEmpty(checkPrice(onTheDay, { provider: "acme" }, pricing).warnings);
  });

  it("warn about an fx.yaml rate checked more than 90 days before", () => {
    const stale = Schema.decodeSync(FxFile)({
      rates_to_usd: {},
      credit_rates_usd: { graph: rate(null, "2026-06-01") },
      meter_rates_usd: { acme: { api_unit: rate(0.00004) } },
    });

    assert.deepStrictEqual(
      checkRates(pricingOn(today, stale)).map(({ path }) => formatPath(path)),
      ["credit_rates_usd.graph.checked"],
    );
  });
});

describe("a quote", () => {
  const video = served({ cost: table });
  const quoted = (values: { readonly [field: string]: unknown }) => quote(video, values);

  it("prices a call at the first table row its input matches, defaults filled in", () => {
    // The small model at the default 512.
    assert.deepStrictEqual(quoted({ model: "small" }), Option.some(400_000));
    // The small model at 1080 for 3 seconds, 3 × $0.06; then for the default 5.
    assert.deepStrictEqual(
      quoted({ model: "small", resolution: "1080", duration: 3 }),
      Option.some(180_000),
    );

    assert.deepStrictEqual(quoted({ model: "small", resolution: "1080" }), Option.some(300_000));
    assert.deepStrictEqual(quoted({ model: "large", duration: 10 }), Option.some(1_500_000));
  });

  it("prices at the fallback when no row matches or the multiplier is out of its range", () => {
    for (const body of [
      { model: "medium" },
      { model: "large", duration: 11 },
      { model: "large", duration: 1 },
      { model: "large", duration: "4" },
    ]) {
      assert.deepStrictEqual(quoted(body), Option.some(2_500_000), JSON.stringify(body));
    }
  });

  it("never falls outside the price's floor and ceiling", () => {
    assert.deepInclude(video, { microUsd: { floor: 120_000, ceiling: 2_500_000 } });
    for (const model of ["small", "large", "medium"]) {
      for (const resolution of ["512", "1080", undefined]) {
        for (const duration of [undefined, 1, 2, 5, 10, 11]) {
          const charged = Option.getOrThrow(quoted({ model, resolution, duration }));
          assert.isTrue(
            charged >= 120_000 && charged <= 2_500_000,
            `${model} ${resolution} ${duration}`,
          );

          // A call never costs more than it reserves, at any count of units.
          for (const units of [1, 3, 1000]) {
            const reserved = Option.getOrThrow(reserve(video, units));
            const unitsQuoted = Option.getOrThrow(
              quote(video, { model, resolution, duration }, units),
            );

            assert.isAtMost(unitsQuoted, reserved, `${model} ${resolution} ${duration} ×${units}`);
          }
        }
      }
    }
  });

  it("reads a field by its name, whatever part of the request carries it", () => {
    const regional = served({
      input: { queryParams: { region: { type: "string", required: true } } },
      cost: {
        ...Struct.omit(documented, ["value"]),
        table: [{ when: { "queryParams.region": "eu" }, value: 0.01 }],
        fallback: { value: 0.02 },
      },
    });

    assert.deepStrictEqual(quote(regional, { region: "eu" }), Option.some(10_000));
    assert.deepStrictEqual(quote(regional, { region: "us" }), Option.some(20_000));
  });

  it("matches a path field required by its placeholder even without a required flag", () => {
    for (const field of [{ type: "string" }, { type: "string", required: false }]) {
      const task = Schema.decodeUnknownSync(Task)(
        written({
          path: "/videos/{model}",
          input: { pathParams: { model: field } },
          test_request: { pathParams: { model: "small" } },
          cost: {
            ...Struct.omit(documented, ["value"]),
            table: [{ when: { "pathParams.model": "small" }, value: 0.01 }],
            fallback: { value: 0.02 },
          },
        }),
      );

      const input = checkInput(task);
      if (Result.isFailure(input)) return assert.fail("the path input was refused");
      assert.deepStrictEqual(input.success.required, ["model"]);
      const { price } = checkPrice(task, { provider: "acme" }, pricing);
      if (Result.isFailure(price)) return assert.fail("the required path price was refused");
      assert.deepStrictEqual(quote(price.success, { model: "small" }), Option.some(10_000));
      assert.deepStrictEqual(reserve(price.success), Option.some(20_000));
    }
  });

  // Only the call's own keys count: `constructor` is on every object's prototype.
  it("fills in the default of a field the call leaves out, whatever its name", () => {
    const named = served({
      input: { body: { constructor: { type: "string", required: false, default: "x" } } },
      cost: {
        ...Struct.omit(documented, ["value"]),
        table: [{ when: { "body.constructor": "x" }, value: 0.01 }],
        fallback: { value: 0.02 },
      },
    });

    assert.deepStrictEqual(quote(named, {}), Option.some(10_000));
    assert.deepStrictEqual(quote(named, { constructor: "y" }), Option.some(20_000));
  });

  it("scales a price per block by the units asked for, rounding up once", () => {
    const rows = served({
      cost: { ...documented, type: "per_result", value: 3, per: 1000, unit: "row" },
    });

    assert.deepStrictEqual(quote(rows, {}), Option.some(3000));
    assert.deepStrictEqual(quote(rows, {}, 1500), Option.some(4_500_000));
    // €0.001 at $1.1712 is 1,171.2 micro-USD: a call rounds up, a thousand calls round once.
    const euro = served({ cost: { ...documented, currency: "EUR", value: 0.001 } });
    assert.deepStrictEqual(quote(euro, {}), Option.some(1172));
    assert.deepStrictEqual(quote(euro, {}, 1000), Option.some(1_171_200));
  });

  it("is zero for a free task, and none for an unpriced, unknown or non-USD price", () => {
    assert.deepStrictEqual(quote(served({ cost: { type: "free" } }), {}), Option.some(0));
    assert.isTrue(Option.isNone(quote(served({}), {})));
    assert.isTrue(Option.isNone(quote(served({ cost: unpublished }), {})));
    const graph = served({ cost: { ...documented, currency: "credit", value: 3 } }, "graph");
    assert.isTrue(Option.isNone(quote(graph, {})));
    assert.deepInclude(graph, { microUsd: undefined });
  });
});

describe("a reserve", () => {
  it("holds the ceiling for the units asked for", () => {
    const price = served({ cost: table });
    assert.deepStrictEqual(reserve(price), Option.some(2_500_000));
    assert.deepStrictEqual(reserve(price, 3), Option.some(7_500_000));
    const rows = served({
      cost: { ...documented, type: "per_result", value: 3, per: 1000, unit: "row" },
    });

    assert.deepStrictEqual(reserve(rows, 250), Option.some(750_000));
  });

  it("is zero for a free task, and none without a USD figure", () => {
    assert.deepStrictEqual(reserve({ type: "free" }), Option.some(0));
    assert.isTrue(Option.isNone(reserve(undefined)));
    const graph = served({ cost: { ...documented, currency: "credit", value: 3 } }, "graph");
    assert.isTrue(Option.isNone(reserve(graph)));
  });
});

describe("a settlement", () => {
  it("settles a reported USD charge without publishing a quote or reserve", () => {
    const price = served({
      cost: { ...unpublished, settle: { type: "reported_charge", path: "usage.cost" } },
    });

    assert.deepInclude(price, { currency: "USD", native: undefined, microUsd: undefined });
    assert.deepStrictEqual(settle(price, BigDecimal.fromStringUnsafe("0.004")), Option.some(4000));
    assert.deepStrictEqual(settle(price, BigDecimal.fromStringUnsafe("0.0000001")), Option.some(1));
    assert.isTrue(Option.isNone(quote(price, {})));
    assert.isTrue(Option.isNone(reserve(price)));
  });

  it("prices a reported figure in the cost's own currency at its fx.yaml rate", () => {
    // 2.5 credits at $0.012, and 37 API units at $0.00004.
    const credits = served({
      cost: {
        ...documented,
        currency: "credit",
        value: 1.5,
        settle: { type: "reported_charge", path: "usage.credits" },
      },
    });

    assert.deepStrictEqual(
      settle(credits, BigDecimal.fromStringUnsafe("2.5")),
      Option.some(30_000),
    );

    const meter = served({
      cost: {
        ...documented,
        type: "per_result",
        currency: "meter",
        unit: "api_unit",
        value: 10,
        settle: { type: "usage", header: "X-Units-Used" },
      },
    });

    assert.deepStrictEqual(settle(meter, BigDecimal.fromBigInt(37n)), Option.some(1480));
    const euro = served({ cost: { ...documented, currency: "EUR", value: 0.001 } });
    assert.deepStrictEqual(settle(euro, BigDecimal.fromStringUnsafe("0.004")), Option.some(4685));
  });

  it("never assumes an observed charge is USD without a conversion rate", () => {
    const prices = [
      served({}),
      served({ cost: { ...documented, currency: "credit", value: 3 } }, "graph"),
      served({ cost: { ...documented, currency: "meter", unit: "api_unit", value: 10 } }, "graph"),
      // Unknown non-USD prices stay unknown even where fx.yaml has a rate for the currency.
      served({ cost: { ...unpublished, currency: "EUR" } }),
      served({ cost: { ...unpublished, currency: "credit" } }),
      served({ cost: { ...unpublished, currency: "meter", unit: "api_unit" } }),
    ];

    for (const price of prices) {
      assert.isTrue(Option.isNone(settle(price, BigDecimal.fromStringUnsafe("0.004"))));
    }

    assert.deepStrictEqual(settle({ type: "free" }, BigDecimal.fromBigInt(3n)), Option.some(0));
  });
});

describe("cheapest first", () => {
  it("ranks by what one unit costs at the ceiling, an unknown price never as free", () => {
    const prices: ReadonlyArray<readonly [string, Price | undefined]> = [
      ["unpriced", undefined],
      ["no USD figure", served({ cost: { ...documented, currency: "credit", value: 3 } }, "graph")],
      ["unknown USD", served({ cost: unpublished })],
      ["$0.006 a call", served({ cost: documented })],
      [
        "$3 per 1,000 rows",
        served({ cost: { ...documented, type: "per_result", value: 3, per: 1000, unit: "row" } }),
      ],
      ["free", { type: "free" }],
    ];

    assert.deepStrictEqual(
      prices.toSorted(([, a], [, b]) => cheapestFirst(a, b)).map(([label]) => label),
      ["free", "$3 per 1,000 rows", "$0.006 a call", "no USD figure", "unknown USD", "unpriced"],
    );
  });
});
