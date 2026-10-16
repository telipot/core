import { Effect, Predicate } from "effect";
import { Hex } from "effect/encoding";

import { type ExtendedProvider, type Provider, type Task, blankPlaceholders } from "./schema";

// A reviewer may correct these in an extended file, so the digest leaves them out.
const reviewedFields = [
  "kind",
  "name",
  "capability",
  "scope",
  "principal",
] as const satisfies ReadonlyArray<keyof Task>;

const reviewed: ReadonlySet<string> = new Set(reviewedFields);
export const isReviewed = (key: string) => reviewed.has(key);

// Object keys sorted at every depth, so the digest ignores key order.
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (!Predicate.isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, canonical(value[key])]),
  );
};

// Hashes the written form, so a new decoding default changes no digest; WebCrypto runs anywhere.
export const extendedDigest = Effect.fnUntraced(function* (file: typeof ExtendedProvider.Encoded) {
  const { digest: _, endpoints, ...header } = file;
  const content = {
    ...header,
    endpoints: endpoints.map((task) =>
      Object.fromEntries(Object.entries(task).filter(([key]) => !reviewed.has(key))),
    ),
  };

  const bytes = yield* Effect.promise(() =>
    globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(canonical(content))),
    ),
  );

  return `sha256:${Hex.encode(new Uint8Array(bytes))}`;
});

export type Curated = Pick<Provider, "route_match"> & {
  readonly endpoints: ReadonlyArray<
    Pick<Task, "id" | "method" | "path" | "status"> & Partial<Pick<Task, "input">>
  >;
};

const routeKey = (task: Pick<Task, "method" | "path">, match: Provider["route_match"]) =>
  `${task.method} ${match === "exact" ? task.path : blankPlaceholders(task.path)}`;

export const curatedBy = (core: Curated, task: Pick<Task, "method" | "path">) => {
  const matches = core.endpoints.filter(
    (curated) => routeKey(curated, core.route_match) === routeKey(task, core.route_match),
  );

  return matches.find((curated) => Predicate.isUndefined(curated.status)) ?? matches[0];
};

// An extended task on a route core curates. Core wins; the twin's id stays in the lock.
export const isTwin = (core: Curated, task: Pick<Task, "method" | "path">) =>
  Predicate.isNotUndefined(curatedBy(core, task));
