import { BunServices } from "@effect/platform-bun";
import { assert, layer } from "@effect/vitest";
import { copyDirectory } from "@telipot/fixtures/filesystem";
import { Effect, FileSystem } from "effect";

layer(BunServices.layer)("fixture directory copies", (it) => {
  it.effect("isolates repeated copies and preserves source files after edits", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const source = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${source}/nested`);
      yield* fs.writeFileString(`${source}/nested/example.json`, '{"value":"original"}\n');
      const first = yield* copyDirectory(source);
      const second = yield* copyDirectory(source);

      assert.notStrictEqual(first, source);
      assert.notStrictEqual(second, source);
      assert.notStrictEqual(first, second);
      yield* fs.writeFileString(`${first}/nested/example.json`, '{"value":"changed"}\n');
      yield* fs.writeFileString(`${first}/generated.txt`, "new file\n");

      assert.strictEqual(
        yield* fs.readFileString(`${first}/nested/example.json`),
        '{"value":"changed"}\n',
      );
      for (const untouched of [source, second]) {
        assert.strictEqual(
          yield* fs.readFileString(`${untouched}/nested/example.json`),
          '{"value":"original"}\n',
        );
        assert.isFalse(yield* fs.exists(`${untouched}/generated.txt`));
      }
    }),
  );
});
