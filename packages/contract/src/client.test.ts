import { BunServices } from "@effect/platform-bun";
import { assert, layer } from "@effect/vitest";
import { Effect, FileSystem, Path, Predicate } from "effect";

const specifiers = (source: string) =>
  [
    ...source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"|^\s*import\s+"([^"]+)"/gm),
  ].flatMap(([, from, bare]) => [from ?? bare ?? ""]);

const reach = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const reached = new Set<string>();
  const packages: Array<string> = [];
  const queue = [path.join(import.meta.dirname, "index.ts")];
  for (let file = queue.pop(); Predicate.isNotUndefined(file); file = queue.pop()) {
    const relative = path.relative(import.meta.dirname, file);
    if (reached.has(relative)) continue;
    reached.add(relative);
    for (const specifier of specifiers(yield* fs.readFileString(file))) {
      if (!specifier.startsWith(".")) {
        if (specifier !== "effect" && !specifier.startsWith("effect/")) {
          packages.push(`${relative} imports ${specifier}`);
        }
        continue;
      }
      const target = path.resolve(path.dirname(file), specifier);
      queue.push(
        (yield* fs.exists(`${target}.ts`)) ? `${target}.ts` : path.join(target, "index.ts"),
      );
    }
  }
  // Every folder under src/ is a feature.
  const features: Array<string> = [];
  for (const name of yield* fs.readDirectory(import.meta.dirname)) {
    const stat = yield* fs.stat(path.join(import.meta.dirname, name));
    if (stat.type === "Directory") features.push(name);
  }
  return { reached: [...reached], packages, features };
});

// The contract is what the SDK, the CLI, the web app and the public repository take, so it
// reaches a feature only through its index.ts and needs no package but effect.
layer(BunServices.layer)("@telipot/contract", (it) => {
  it.effect("reaches each feature's index.ts and no other file in a folder", () =>
    Effect.gen(function* () {
      const { reached, features } = yield* reach;
      assert.isNotEmpty(features);
      assert.sameMembers(
        reached.filter((file) => file.includes("/")),
        features.map((feature) => `${feature}/index.ts`),
      );
    }),
  );

  it.effect("imports no package but effect", () =>
    Effect.gen(function* () {
      const { packages } = yield* reach;
      assert.deepStrictEqual(packages, []);
    }),
  );

  it.effect("lists only effect among its dependencies", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const manifest = JSON.parse(
        yield* fs.readFileString(`${import.meta.dirname}/../package.json`),
      ) as { readonly dependencies: Record<string, string> };
      assert.deepStrictEqual(Object.keys(manifest.dependencies), ["effect"]);
    }),
  );
});
