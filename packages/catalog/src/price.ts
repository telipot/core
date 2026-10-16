import { BigDecimal, DateTime, Option, Order, Predicate, Record, Result } from "effect";

import {
  type Confidence,
  type Cost,
  type FxFile,
  type Input,
  type ProviderHeader,
  type Settle,
  type Task,
  inputLocations,
} from "./schema";
import { isRequired } from "./input";

// A task names each field once across locations, so a row's `body.model` reads `values.model`.
type CallInput = { readonly [field: string]: unknown };

interface RowField {
  readonly name: string;
  readonly default: unknown;
}

// Every `when` must hold; `value` is multiplied by the `times` field.
interface Row {
  readonly when: ReadonlyArray<RowField & { readonly wanted: string | number | boolean }>;
  readonly value: BigDecimal.BigDecimal;
  readonly times: (RowField & { readonly least: number; readonly most: number }) | undefined;
}

// A task with no cost block has no price: unpriced, never free.
export type Price =
  | { readonly type: "free" }
  | {
      readonly type: "per_call" | "per_success" | "per_result";
      // With an unknown list price, `usd` is kept only for USD, so a reported USD charge settles.
      readonly currency: string;
      readonly usd: BigDecimal.BigDecimal | undefined;
      // None when the list price is unknown; a plain value, with empty `rows`, charges its ceiling.
      readonly native:
        | {
            readonly floor: BigDecimal.BigDecimal;
            readonly ceiling: BigDecimal.BigDecimal;
            readonly rows: ReadonlyArray<Row>;
          }
        | undefined;
      // Rounded up. Compare prices by `ceiling / per`, not `ceiling`.
      readonly microUsd: { readonly floor: number; readonly ceiling: number } | undefined;
      readonly per: number;
      readonly unit: string;
      readonly source: string | undefined;
      readonly sourceUrl: string | undefined;
      readonly checked: string;
      readonly confidence: Confidence;
      readonly settle: Settle | undefined;
    };

// `path` is relative to the task or fx.yaml, or to `file` when it is set.
export interface Problem {
  readonly file?: string;
  readonly path: ReadonlyArray<PropertyKey>;
  readonly message: string;
}

// `fx` is undefined when fx.yaml did not decode, its issues already recorded. ISO dates compare
// as strings.
export interface Pricing {
  readonly fx: FxFile | undefined;
  readonly staleBefore: string;
}

const shelfLife = 90;
export const pricingOn = (today: DateTime.DateTime, fx: FxFile | undefined): Pricing => ({
  fx,
  staleBefore: DateTime.formatIsoDate(DateTime.subtract(today, { days: shelfLife })),
});

const microsPerUsd = BigDecimal.fromBigInt(1_000_000n);
const one = BigDecimal.fromBigInt(1n);

// Rounded up, so a reserve never falls short.
const toMicroUsd = (amount: BigDecimal.BigDecimal, usd: BigDecimal.BigDecimal) =>
  BigDecimal.toNumberUnsafe(BigDecimal.ceil(BigDecimal.multiplyAll([amount, usd, microsPerUsd])));

const times = (amount: BigDecimal.BigDecimal, n: number) =>
  BigDecimal.multiply(amount, BigDecimal.fromNumberUnsafe(n));

const slice = (amount: BigDecimal.BigDecimal, units: number, per: number) =>
  BigDecimal.divideUnsafe(times(amount, units), BigDecimal.fromNumberUnsafe(per));

type PaidCost = Exclude<Cost, { readonly type: "free" }>;
type TableRow = NonNullable<PaidCost["table"]>[number];

const locate = (reference: string) => {
  const dot = reference.indexOf(".");
  return {
    location: inputLocations.find((name) => name === reference.slice(0, dot)),
    name: reference.slice(dot + 1),
  };
};

const fieldAt = (input: Input, reference: string) => {
  const { location, name } = locate(reference);
  const fields = Predicate.isUndefined(location) ? undefined : input[location];
  return Predicate.isUndefined(fields) ? Option.none() : Record.get(fields, name);
};

const valueOf = (values: CallInput, field: RowField): unknown => {
  const given = Option.getOrUndefined(Record.get(values, field.name));
  return Predicate.isUndefined(given) ? field.default : given;
};

// A `times` field counts from its min, or one without a positive min, to its max.
const timesOf = (row: TableRow, input: Input) => {
  if (Predicate.isUndefined(row.times)) return undefined;

  const field = Option.getOrUndefined(fieldAt(input, row.times));
  if (Predicate.isUndefined(field?.max)) return undefined;

  return {
    name: locate(row.times).name,
    default: field.default,
    least: Math.min(
      field.max,
      Predicate.isNotUndefined(field.min) && field.min > 0 ? field.min : 1,
    ),
    most: field.max,
  };
};

const span = (row: Row) => {
  if (Predicate.isUndefined(row.times)) return { least: row.value, most: row.value };

  return { least: times(row.value, row.times.least), most: times(row.value, row.times.most) };
};

const rowsOf = (table: ReadonlyArray<TableRow>, input: Input): ReadonlyArray<Row> =>
  table.map((row) => ({
    when: Object.entries(row.when).map(([reference, wanted]) => ({
      name: locate(reference).name,
      default: Option.getOrUndefined(fieldAt(input, reference))?.default,
      wanted,
    })),
    value: row.value,
    times: timesOf(row, input),
  }));

// The ceiling when no row matches or `times` is out of range.
const amountAt = (rows: ReadonlyArray<Row>, ceiling: BigDecimal.BigDecimal, values: CallInput) => {
  const row = rows.find(({ when }) =>
    when.every((field) => valueOf(values, field) === field.wanted),
  );

  if (Predicate.isUndefined(row)) return ceiling;
  if (Predicate.isUndefined(row.times)) return row.value;

  const n = valueOf(values, row.times);
  return Predicate.isNumber(n) && n >= row.times.least && n <= row.times.most
    ? times(row.value, n)
    : ceiling;
};

// Null when fx.yaml says the provider publishes no USD price.
const usdPerUnit = (
  { currency, unit }: PaidCost,
  slug: string,
  fx: FxFile,
): Result.Result<
  BigDecimal.BigDecimal | null,
  { readonly field: "currency" | "unit"; readonly message: string }
> => {
  const found = (
    rate: Option.Option<{ readonly usd: BigDecimal.BigDecimal | null }>,
    field: "currency" | "unit",
    missing: string,
  ) =>
    Option.match(rate, {
      onNone: () => Result.fail({ field, message: missing }),
      onSome: ({ usd }) => Result.succeed(usd),
    });

  switch (currency) {
    case "USD":
      return Result.succeed(one);
    case "credit":
      return found(
        Record.get(fx.credit_rates_usd, slug),
        "currency",
        `fx.yaml credit_rates_usd has no rate for ${slug}`,
      );
    case "meter":
      if (Predicate.isUndefined(unit)) {
        return Result.fail({ field: "unit", message: "names the meter when currency is meter" });
      }

      return found(
        Record.get(fx.meter_rates_usd, slug).pipe(
          Option.flatMap((meters) => Record.get(meters, unit)),
        ),
        "unit",
        `fx.yaml meter_rates_usd has no ${unit} for ${slug}`,
      );
    default:
      return found(
        Record.get(fx.rates_to_usd, currency),
        "currency",
        `fx.yaml rates_to_usd has no ${currency}`,
      );
  }
};

// A meter without a `unit` is already refused.
const currencyOf = ({ currency, unit }: PaidCost) =>
  currency === "meter" ? (unit ?? currency) : currency;

const paidPrice = (
  cost: PaidCost,
  rows: ReadonlyArray<Row>,
  usd: BigDecimal.BigDecimal | null | undefined,
): Price => {
  // A value is its own ceiling; a table's is its fallback, which caps every row.
  const ceiling = cost.value ?? cost.fallback?.value;
  const conversion =
    Predicate.isUndefined(ceiling) && cost.currency !== "USD" ? undefined : (usd ?? undefined);

  const native = Predicate.isUndefined(ceiling)
    ? undefined
    : {
        floor: rows.map((row) => span(row).least).reduce(BigDecimal.min, ceiling),
        ceiling,
        rows,
      };

  const counted = cost.type === "per_result" ? "result" : "call";

  return {
    type: cost.type,
    currency: currencyOf(cost),
    usd: conversion,
    native,
    microUsd:
      Predicate.isUndefined(native) || Predicate.isUndefined(conversion)
        ? undefined
        : {
            floor: toMicroUsd(native.floor, conversion),
            ceiling: toMicroUsd(native.ceiling, conversion),
          },
    per: cost.per,
    // A meter's `unit` names the currency, so `per` counts calls or results.
    unit: cost.currency === "meter" ? counted : (cost.unit ?? counted),
    source: cost.source,
    sourceUrl: cost.source_url,
    checked: cost.checked,
    confidence: cost.confidence,
    settle: cost.settle,
  };
};

const rated = (price: Price | undefined) =>
  price?.type !== "free" &&
  Predicate.isNotUndefined(price?.native) &&
  Predicate.isNotUndefined(price.usd)
    ? { native: price.native, usd: price.usd, per: price.per }
    : undefined;

// Micro-USD, rounded up once.
export const quote = (
  price: Price | undefined,
  values: CallInput,
  units = 1,
): Option.Option<number> => {
  if (price?.type === "free") return Option.some(0);
  return Option.map(Option.fromUndefinedOr(rated(price)), ({ native, usd, per }) =>
    toMicroUsd(slice(amountAt(native.rows, native.ceiling, values), units, per), usd),
  );
};

// The most a call of `units` is charged, in micro-USD rounded up once.
export const reserve = (price: Price | undefined, units = 1): Option.Option<number> => {
  if (price?.type === "free") return Option.some(0);
  return Option.map(Option.fromUndefinedOr(rated(price)), ({ native, usd, per }) =>
    toMicroUsd(slice(native.ceiling, units, per), usd),
  );
};

// `reported` is in the cost's own currency; a USD charge needs no list price.
export const settle = (
  price: Price | undefined,
  reported: BigDecimal.BigDecimal,
): Option.Option<number> => {
  if (price?.type === "free") return Option.some(0);
  if (Predicate.isUndefined(price?.usd)) return Option.none();
  return Option.some(toMicroUsd(reported, price.usd));
};

const standing = (price: Price | undefined) => {
  if (Predicate.isUndefined(price)) return 3;
  if (price.type === "free") return 0;
  return Predicate.isUndefined(rated(price)) ? 2 : 1;
};

const ceilingPerUnit = (price: Price | undefined) => {
  const known = rated(price);
  return Predicate.isUndefined(known)
    ? BigDecimal.fromBigInt(0n)
    : slice(BigDecimal.multiply(known.native.ceiling, known.usd), 1, known.per);
};

// By one unit at the ceiling: $3 per 1,000 rows beats $0.006 a call. An unknown price never ranks
// as free.
export const cheapestFirst: Order.Order<Price | undefined> = Order.combine(
  Order.mapInput(Order.Number, standing),
  Order.mapInput(BigDecimal.Order, ceilingPerUnit),
);

export const checkRates = ({ fx, staleBefore }: Pricing): ReadonlyArray<Problem> => {
  if (Predicate.isUndefined(fx)) return [];
  const rates = [
    ...Object.entries(fx.rates_to_usd).map(
      ([code, rate]) => [["rates_to_usd", code], rate] as const,
    ),
    ...Object.entries(fx.credit_rates_usd).map(
      ([slug, rate]) => [["credit_rates_usd", slug], rate] as const,
    ),
    ...Object.entries(fx.meter_rates_usd).flatMap(([slug, meters]) =>
      Object.entries(meters).map(
        ([unit, rate]) => [["meter_rates_usd", slug, unit], rate] as const,
      ),
    ),
  ];

  return rates.flatMap(([path, { checked }]) =>
    checked < staleBefore
      ? [
          {
            path: [...path, "checked"],
            message: `${checked} is more than ${shelfLife} days ago; check the rate again`,
          },
        ]
      : [],
  );
};

export const checkPrice = (
  task: Task,
  provider: Pick<ProviderHeader, "provider" | "async">,
  { fx, staleBefore }: Pricing,
): {
  readonly price: Result.Result<Price | undefined, ReadonlyArray<Problem>>;
  readonly warnings: ReadonlyArray<Problem>;
} => {
  const problems: Array<Problem> = [];
  const report = (path: ReadonlyArray<PropertyKey>, message: string) => {
    problems.push({ path, message });
  };

  const warnings: Array<Problem> = [];
  const warn = (path: ReadonlyArray<PropertyKey>, message: string) => {
    warnings.push({ path, message });
  };

  const { cost } = task;
  const paid = cost?.type === "free" ? undefined : cost;
  const rows = rowsOf(paid?.table ?? [], task.input);
  const rate =
    Predicate.isUndefined(paid) || Predicate.isUndefined(fx)
      ? undefined
      : usdPerUnit(paid, provider.provider, fx);

  if (Predicate.isNotUndefined(paid)) {
    if (Predicate.isNotUndefined(rate) && Result.isFailure(rate)) {
      report(["cost", rate.failure.field], rate.failure.message);
    }

    if (paid.checked < staleBefore) {
      warn(
        ["cost", "checked"],
        `${paid.checked} is more than ${shelfLife} days ago; check the price again`,
      );
    }

    // Rows match in file order, on fields that always hold a value.
    const table = paid.table ?? [];
    for (const [index, row] of table.entries()) {
      const at = (...path: ReadonlyArray<PropertyKey>) => ["cost", "table", index, ...path];
      for (const reference of Object.keys(row.when)) {
        const { location, name } = locate(reference);
        const field = fieldAt(task.input, reference);
        if (Option.isNone(field) || Predicate.isUndefined(location)) {
          report(
            at("when", reference),
            "names no input field; write its location first, such as body.model",
          );
        } else if (
          !isRequired(task.path, location, name, field.value) &&
          Predicate.isUndefined(field.value.default)
        ) {
          report(at("when", reference), "an optional input field needs a default to match on");
        }
      }

      if (Predicate.isNotUndefined(row.times)) {
        const field = Option.getOrUndefined(fieldAt(task.input, row.times));
        if (
          (field?.type !== "integer" && field?.type !== "number") ||
          Predicate.isUndefined(field.max) ||
          field.max <= 0
        ) {
          report(at("times"), "names no integer or number input field with a positive max");
        }
      }

      const earlier = table
        .slice(0, index)
        .findIndex(({ when }) =>
          Object.entries(when).every(
            ([key, value]) => Object.hasOwn(row.when, key) && row.when[key] === value,
          ),
        );

      const before = table[earlier];
      if (Predicate.isNotUndefined(before)) {
        report(
          at("when"),
          Object.keys(before.when).length === Object.keys(row.when).length
            ? `duplicates row ${earlier}`
            : `row ${earlier} matches every request it does, so it never prices one`,
        );
      }
    }

    // A reserve at the fallback must cover any call.
    if (Predicate.isNotUndefined(paid.fallback) && rows.length > 0) {
      const [dearest, most] = rows
        .map((row, index) => [index, span(row).most] as const)
        .reduce((a, b) => (BigDecimal.isLessThan(a[1], b[1]) ? b : a));

      if (BigDecimal.isLessThan(paid.fallback.value, most)) {
        report(
          ["cost", "fallback", "value"],
          `below row ${dearest} at its most, ${BigDecimal.format(most)} ${currencyOf(paid)}`,
        );
      }
    }

    // A task-level `async` block replaces the provider's whole.
    if (Predicate.isNotUndefined(task.async ?? provider.async) && paid.type !== "per_success") {
      report(["cost", "type"], "an asynchronous task is per_success");
    }
  }

  if (problems.length > 0) return { price: Result.fail(problems), warnings };
  if (Predicate.isUndefined(cost)) return { price: Result.succeed(undefined), warnings };
  if (Predicate.isUndefined(paid)) return { price: Result.succeed({ type: "free" }), warnings };
  const usd = Predicate.isUndefined(rate) ? undefined : Result.getOrUndefined(rate);
  return { price: Result.succeed(paidPrice(paid, rows, usd)), warnings };
};
