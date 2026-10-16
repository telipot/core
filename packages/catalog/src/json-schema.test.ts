import { BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Result, Schema } from "effect";
import { parse } from "yaml";

import { jsonSchemaDecoder } from "./input";
import { providerJsonSchema, providerSchemaFile, schemaModeline } from "./json-schema";

const realCatalog = `${import.meta.dirname}/../../../catalog`;
const schemaPath = `${realCatalog}/${providerSchemaFile}`;

const committed = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  assert.isTrue(yield* fs.exists(schemaPath), `${schemaPath} is missing`);
  return yield* Schema.decodeEffect(
    Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
  )(yield* fs.readFileString(schemaPath));
});

// The committed file, as an editor reads it; its patterns are ours, so they apply.
const decoder = Effect.fnUntraced(function* () {
  const decode = jsonSchemaDecoder(yield* committed(), { patterns: "apply" });
  if (Result.isFailure(decode)) return assert.fail(decode.failure);
  return decode.success;
});

describe("the provider JSON Schema", () => {
  it.effect("is committed as the schema generates it", () =>
    Effect.gen(function* () {
      const generated: unknown = providerJsonSchema();
      assert.deepStrictEqual(
        yield* committed(),
        generated,
        `run: bun run telipot catalog schema > catalog/${providerSchemaFile}`,
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("admits every provider file and is named in its first line", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const decode = yield* decoder();
      const files = (yield* fs.readDirectory(`${realCatalog}/providers`)).filter(
        (file) => file.endsWith(".yaml") && !file.endsWith(".extended.yaml"),
      );

      assert.isAbove(files.length, 0);
      for (const file of files) {
        const text = yield* fs.readFileString(`${realCatalog}/providers/${file}`);
        assert.isTrue(text.startsWith(`# ${schemaModeline}\n`), `${file} does not name the schema`);
        const decoded = decode(parse(text));
        assert.isTrue(Result.isSuccess(decoded), `${file} fails the JSON Schema`);
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("refuses an unknown field and a URL without a scheme", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const decode = yield* decoder();
      const hackernews = yield* Schema.decodeUnknownEffect(
        Schema.Record(Schema.String, Schema.Unknown),
      )(parse(yield* fs.readFileString(`${realCatalog}/providers/hackernews.yaml`)));

      assert.isTrue(Result.isSuccess(decode(hackernews)));
      assert.isTrue(Result.isFailure(decode({ ...hackernews, homepage: "https://example.com" })));
      assert.isTrue(Result.isFailure(decode({ ...hackernews, base_url: "hn.algolia.com" })));
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
