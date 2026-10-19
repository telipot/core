import { IdsLock, type Publication, buildSnapshot } from "@telipot/catalog";
import { Effect, FileSystem, Path, Schema } from "effect";

import { git } from "./git";

const decodeLock = Schema.decodeUnknownEffect(Schema.fromJsonString(IdsLock));

// Each id's date is the commit that first added it to ids.lock.json. A shallow clone would claim
// every id at once, so it gives none, as a folder outside git does; readers use the curation date.
const publications = Effect.fnUntraced(function* (directory: string) {
  const published: Array<Publication> = [];
  const shallow = yield* git(directory, ["rev-parse", "--is-shallow-repository"]).pipe(
    Effect.catchTag("GitRefused", () => Effect.succeed("outside")),
  );

  if (shallow.trim() !== "false") return published;
  // `--diff-filter=d`, which reads the same as `AMR`, selects no commit at all on git 2.50.
  const log = yield* git(directory, [
    "log",
    "--reverse",
    "--diff-filter=AMR",
    "--format=%H %cs",
    "--",
    "ids.lock.json",
  ]);

  const seen = new Set<string>();
  for (const line of log.split("\n").filter((line) => line !== "")) {
    const [sha = "", date = ""] = line.split(" ");
    // A lock in another shape gives no ids; the commits around it still count.
    const lock = yield* decodeLock(yield* git(directory, ["show", `${sha}:./ids.lock.json`])).pipe(
      Effect.catchTag("SchemaError", (error) =>
        Effect.as(Effect.logWarning(`The lock at ${sha} is not a list of ids`, error), []),
      ),
    );

    const ids = lock.filter((id) => !seen.has(id));
    for (const id of ids) seen.add(id);
    if (ids.length > 0) published.push({ date, ids });
  }

  return published;
});

export const writeSnapshot = Effect.fnUntraced(function* (directory: string, out: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const snapshot = yield* buildSnapshot(directory, yield* publications(directory));
  yield* fs.makeDirectory(path.dirname(out), { recursive: true });
  yield* fs.writeFileString(out, `${JSON.stringify(snapshot)}\n`);
  return snapshot;
});
