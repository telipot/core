import { fileURLToPath } from "node:url";

import { BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { type CatalogFixtureName, catalogFixtures } from "@telipot/fixtures/catalog";
import { Cause, Context, Effect, Exit, Layer, Predicate, Schema } from "effect";

import { Catalog, CatalogInvalid, formatIssues } from "./catalog";
import { Snapshot, buildSnapshot } from "./snapshot";

const rootCatalog = fileURLToPath(new URL("../../../catalog/", import.meta.url));

// Sentences that reach search's both answers: hits, and near misses with their words.
const queries = [
  "Hacker News stories about agent tools",
  "find a person's work email",
  "keyword search volume",
  "events on my calendar",
  "crawl a website",
  "zzz nothing matches this",
];

// What a caller can see of a loaded catalog, or the issues that refused it.
const observe = <R>(layer: Layer.Layer<Catalog, unknown, R>) =>
  Effect.scoped(Layer.build(layer)).pipe(
    Effect.exit,
    Effect.map((exit) =>
      Exit.match(exit, {
        onFailure: (cause) => {
          const failed = Cause.squash(cause);
          return {
            refused:
              failed instanceof CatalogInvalid ? formatIssues(failed.issues) : String(failed),
          };
        },
        onSuccess: (context) => {
          const catalog = Context.get(context, Catalog);
          return {
            tasks: catalog.tasks.map(({ task, tier, tombstone }) => [
              task.id,
              tier,
              Predicate.isUndefined(tombstone) ? "live" : "tombstone",
            ]),
            providers: catalog.providers.map(({ provider }) => provider),
            search: queries.map((query) => {
              const found = catalog.search(query);
              return found._tag === "Found"
                ? found.hits.map(({ task }) => task.id)
                : found.nearMisses.map(({ entry }) => entry.task.id);
            }),
          };
        },
      }),
    ),
  );

const bothWays = (directory: string) =>
  Effect.gen(function* () {
    const fromFolder = yield* observe(Catalog.layer(directory));
    const snapshot = yield* buildSnapshot(directory);
    // The snapshot survives JSON, as a Worker imports it.
    const shipped = yield* Schema.decodeUnknownEffect(Snapshot)(
      JSON.parse(JSON.stringify(snapshot)),
    );

    const fromSnapshot = yield* observe(Catalog.fromSnapshot(shipped));
    return { fromFolder, fromSnapshot };
  }).pipe(Effect.provide(BunServices.layer));

describe("a catalog loaded from a snapshot", () => {
  for (const name of Object.keys(catalogFixtures) as Array<CatalogFixtureName>) {
    it.effect(`matches the ${name} fixture loaded from its folder`, () =>
      Effect.gen(function* () {
        const { fromFolder, fromSnapshot } = yield* bothWays(catalogFixtures[name]);
        assert.deepStrictEqual(fromSnapshot, fromFolder);
      }),
    );
  }

  it.effect("matches the real catalog loaded from its folder", () =>
    Effect.gen(function* () {
      const { fromFolder, fromSnapshot } = yield* bothWays(rootCatalog);
      assert.isTrue("tasks" in fromFolder, "the real catalog loads");
      assert.deepStrictEqual(fromSnapshot, fromFolder);
    }),
  );

  it.effect("carries the publications it was built with", () =>
    Effect.gen(function* () {
      const publications = [{ date: "2026-10-04", ids: ["hackernews.news.search"] }];
      const snapshot = yield* buildSnapshot(rootCatalog, publications).pipe(
        Effect.provide(BunServices.layer),
      );

      assert.deepStrictEqual(snapshot.publications, publications);
      assert.isTrue("providers/hackernews.yaml" in snapshot.files);
      assert.isFalse("queries.yaml" in snapshot.files, "CI's measurement stays out");
    }),
  );
});
