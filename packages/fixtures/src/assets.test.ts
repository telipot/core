import { BunServices } from "@effect/platform-bun";
import { assert, layer } from "@effect/vitest";
import { catalogFixtures, openApiFixtures } from "@telipot/fixtures";
import { Effect, FileSystem } from "effect";
import { isAbsolute } from "node:path";

layer(BunServices.layer)("shared fixture assets", (it) => {
  it.effect("resolves each catalog independently of the consumer's working directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      for (const directory of Object.values(catalogFixtures)) {
        assert.isTrue(isAbsolute(directory));
        assert.strictEqual((yield* fs.stat(directory)).type, "Directory");
        yield* fs.access(`${directory}/ids.lock.json`, { readable: true });
        yield* fs.access(`${directory}/fx.yaml`, { readable: true });
      }
    }),
  );

  it.effect("resolves every OpenAPI document to a readable absolute file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      for (const file of Object.values(openApiFixtures)) {
        assert.isTrue(isAbsolute(file));
        assert.strictEqual((yield* fs.stat(file)).type, "File");
        assert.isNotEmpty(yield* fs.readFileString(file));
      }
    }),
  );
});
