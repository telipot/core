import { Effect, FileSystem } from "effect";

export const copyDirectory = Effect.fnUntraced(function* (source: string) {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped();
  yield* fs.copy(source, directory, { overwrite: true });
  return directory;
});
