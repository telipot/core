import { BunServices } from "@effect/platform-bun";
import { assert, layer } from "@effect/vitest";
import { ConfigProvider, Effect, Exit, FileSystem, Option, Redacted } from "effect";

import { credentialsFile, forgetToken, loginToken, savedToken, saveToken } from "./signed-in";

const inHome = (env: Record<string, string>) =>
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })));

const modeOf = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  return (yield* fs.stat(path)).mode & 0o777;
});

layer(BunServices.layer, { excludeTestServices: true })("the credentials file", (it) => {
  it.effect("is created readable by its owner alone, in a folder only they can open", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      const file = yield* saveToken(Redacted.make("tlp_first")).pipe(inHome({ HOME: home }));
      assert.strictEqual(file, `${home}/.config/telipot/credentials`);
      assert.strictEqual(yield* modeOf(file), 0o600);
      assert.strictEqual(yield* modeOf(`${home}/.config/telipot`), 0o700);
      assert.strictEqual(
        Redacted.value(yield* savedToken.pipe(inHome({ HOME: home }))),
        "tlp_first",
      );
    }),
  );

  it.effect("replaces a file and a folder anyone could read with ones only its owner can", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      const env = { XDG_CONFIG_HOME: home };
      const file = yield* credentialsFile.pipe(inHome(env));
      yield* fs.makeDirectory(`${home}/telipot`, { mode: 0o755 });
      yield* fs.chmod(`${home}/telipot`, 0o755);
      yield* fs.writeFileString(file, '{"token":"tlp_old"}', { mode: 0o644 });
      assert.strictEqual(yield* modeOf(file), 0o644);

      yield* saveToken(Redacted.make("tlp_new")).pipe(inHome(env));
      assert.strictEqual(yield* modeOf(file), 0o600);
      assert.strictEqual(yield* modeOf(`${home}/telipot`), 0o700);
      assert.strictEqual(Redacted.value(yield* savedToken.pipe(inHome(env))), "tlp_new");
    }),
  );

  it.effect("is removed on sign-out, after which no token is saved", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      const file = yield* saveToken(Redacted.make("tlp_leaving")).pipe(inHome({ HOME: home }));
      yield* forgetToken(file);
      yield* forgetToken(file);

      assert.isFalse(yield* fs.exists(file));
      assert.isTrue(Option.isNone(yield* loginToken.pipe(inHome({ HOME: home }))));
      assert.isTrue(Exit.isFailure(yield* Effect.exit(savedToken.pipe(inHome({ HOME: home })))));
    }),
  );

  it.effect("takes TELIPOT_TOKEN over the file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      yield* saveToken(Redacted.make("tlp_saved")).pipe(inHome({ HOME: home }));
      const token = yield* savedToken.pipe(inHome({ HOME: home, TELIPOT_TOKEN: "tlp_env" }));
      assert.strictEqual(Redacted.value(token), "tlp_env");
    }),
  );
});
