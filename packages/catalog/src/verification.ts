import { Effect, FileSystem, Path, Predicate, Result, Schema } from "effect";
import { type Pair, type YAMLMap, isMap, isScalar, isSeq, parseDocument } from "yaml";

import type { Entry, Verification } from "./rules";
import { ExamplePath, verificationStates } from "./schema";

const isExamplePath = Schema.is(ExamplePath);

// What `telipot catalog verify` found for one task.
export type Replayed =
  | { readonly state: "verified"; readonly date: string; readonly example: Schema.Json }
  | { readonly state: Exclude<Verification["state"], "verified">; readonly reason: string };

const keyOf = (pair: Pair) => (isScalar(pair.key) ? pair.key.value : pair.key);

// New fields go before the example and output schema, as the files are written by hand.
const before = (task: YAMLMap) => {
  const at = task.items.findIndex((pair) =>
    ["example_response", "output"].some((name) => keyOf(pair) === name),
  );
  return at === -1 ? task.items.length : at;
};

// Keeps the rest of the file as written, comments included.
export const stamp = (
  text: string,
  id: string,
  verification: Verification,
  example: string,
): Result.Result<string, string> => {
  const document = parseDocument(text);
  const endpoints = document.get("endpoints");
  const task = isSeq(endpoints)
    ? endpoints.items.find((item): item is YAMLMap => isMap(item) && item.get("id") === id)
    : undefined;
  if (Predicate.isUndefined(task)) return Result.fail(`${id} is not a task in this file`);

  for (const name of verificationStates) task.delete(name);
  const value = verification.state === "verified" ? verification.date : verification.reason;
  task.items.splice(before(task), 0, document.createPair(verification.state, value));
  if (verification.state === "verified" && !task.has("example_response")) {
    task.items.splice(before(task), 0, document.createPair("example_response", example));
  }
  return Result.succeed(document.toString({ lineWidth: 0 }));
};

// The entry came from this catalog, so a missing task, an extended task (its file is generated)
// or an example outside `examples/` is a defect, refused before anything is written.
export const recordVerification = Effect.fnUntraced(function* (
  directory: string,
  entry: Entry,
  found: Replayed,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { id } = entry.task;
  if (entry.tier !== "core") return yield* Effect.die(`${id} is in a generated file`);
  const example = entry.task.example_response ?? `examples/${id}.json`;
  if (found.state === "verified" && !isExamplePath(example)) {
    return yield* Effect.die(`${id}'s example is not in examples/`);
  }
  const verification: Verification =
    found.state === "verified"
      ? { state: found.state, date: found.date }
      : { state: found.state, reason: found.reason };
  const providerFile = path.join(directory, "providers", `${entry.provider.provider}.yaml`);
  const stamped = yield* Effect.fromResult(
    stamp(yield* fs.readFileString(providerFile), id, verification, example),
  ).pipe(Effect.orDie);
  if (found.state === "verified") {
    const file = path.join(directory, example);
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, `${JSON.stringify(found.example, null, 2)}\n`);
  }
  yield* fs.writeFileString(providerFile, stamped);
});
