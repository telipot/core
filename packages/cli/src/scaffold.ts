import { IdsLock, Provider, type Review, generateProvider, readOpenApi } from "@telipot/catalog";
import { DateTime, Effect, FileSystem, Path, Predicate, Result, Schema } from "effect";

import { fetchDocument, readPatch } from "./published";

class ScaffoldRefused extends Schema.TaggedError<ScaffoldRefused>()("ScaffoldRefused", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export interface ScaffoldReport {
  // Relative to the catalog folder.
  readonly written: ReadonlyArray<string>;
  // The core file was already there, so it was left as it was.
  readonly kept: boolean;
  // Tombstones included.
  readonly taskCount: number;
  readonly reviews: ReadonlyArray<Review>;
  readonly leftOut: ReadonlyArray<string>;
  readonly twins: ReadonlyArray<string>;
  readonly tombstoned: ReadonlyArray<{ readonly id: string; readonly note: string }>;
  // Ids whose route the spec still offers but no task could be made of this run.
  readonly stale: ReadonlyArray<string>;
  readonly patch: string | undefined;
}

const refuse = (message: string, cause?: unknown) =>
  new ScaffoldRefused({ message, ...(Predicate.isUndefined(cause) ? {} : { cause }) });

// A person curates the core file, so it is written once; a rerun with `openapi` refreshes only
// the extended file.
export const scaffoldProvider = Effect.fnUntraced(function* (options: {
  readonly provider: string;
  readonly directory: string;
  readonly openapi: string | undefined;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { provider, directory, openapi } = options;

  const inDirectory = (file: string) => path.join(directory, file);
  const exists = (file: string) =>
    fs.exists(inDirectory(file)).pipe(Effect.orElseSucceed(() => false));

  const readFile = (file: string) =>
    fs
      .readFileString(inDirectory(file))
      .pipe(Effect.mapError((cause) => refuse(`${file} cannot be read as YAML`, cause)));

  if (Result.isFailure(Schema.decodeResult(Provider.fields.provider)(provider))) {
    return yield* refuse(
      `${provider} is not a slug: lowercase letters and digits, joined by dashes`,
    );
  }

  const coreFile = `providers/${provider}.yaml`;
  const extendedPath = `providers/${provider}.extended.yaml`;
  const hasCore = yield* exists(coreFile);
  if (hasCore && Predicate.isUndefined(openapi)) {
    return yield* refuse(
      `${coreFile} exists; give --openapi to refresh ${extendedPath} from the vendor's document`,
    );
  }

  const { file: patchFile, patch } = yield* readPatch(directory, provider).pipe(
    Effect.mapError((cause) => refuse(cause.message, cause)),
  );

  const spec = Predicate.isUndefined(openapi)
    ? undefined
    : yield* fetchDocument(openapi).pipe(
        Effect.mapError((cause) => refuse(cause.message, cause)),
        Effect.flatMap((text) => {
          const read = readOpenApi(text, openapi, patch);
          return Result.isSuccess(read)
            ? Effect.succeed(read.success)
            : Effect.fail(refuse(`cannot use ${openapi}: ${read.failure}`));
        }),
      );

  const today = DateTime.formatIsoDateUtc(yield* DateTime.now);

  const lock = yield* fs.readFileString(inDirectory("ids.lock.json")).pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(IdsLock))),
    Effect.mapError((cause) =>
      refuse(`${directory} has no ids.lock.json; is it a catalog folder?`, cause),
    ),
  );

  const core = hasCore ? yield* readFile(coreFile) : undefined;
  const previous =
    Predicate.isNotUndefined(spec) && (yield* exists(extendedPath))
      ? yield* readFile(extendedPath)
      : undefined;

  const generated = yield* generateProvider({
    provider,
    today,
    document: spec,
    core,
    previous,
    lock,
  }).pipe(Effect.mapError((cause) => refuse(cause.message, cause)));

  const { created, extended } = generated;

  const written: Array<string> = [];
  if (Predicate.isNotUndefined(created)) {
    yield* fs.writeFileString(inDirectory(coreFile), created.text);
    written.push(coreFile);
  }

  if (Predicate.isNotUndefined(extended)) {
    yield* fs.writeFileString(inDirectory(extendedPath), extended.text);
    written.push(extendedPath);
    if (Predicate.isNotUndefined(generated.lockText)) {
      yield* fs.writeFileString(inDirectory("ids.lock.json"), generated.lockText);
      written.push("ids.lock.json");
    }
  }

  return {
    written,
    kept: hasCore,
    taskCount: extended?.file.endpoints.length ?? 0,
    reviews: created?.reviews ?? [],
    leftOut: extended?.leftOut ?? [],
    twins: extended?.twins ?? [],
    tombstoned: extended?.tombstoned ?? [],
    stale: extended?.stale ?? [],
    patch: Predicate.isUndefined(patch) || Predicate.isUndefined(spec) ? undefined : patchFile,
  } satisfies ScaffoldReport;
});
