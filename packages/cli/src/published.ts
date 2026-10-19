import { SpecPatch } from "@telipot/catalog";
import { Effect, FileSystem, Path, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

// `new` and `drift` both read vendor documents here, so they see the same routes.

class Unread extends Schema.TaggedError<Unread>()("Unread", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

// Long enough for the largest vendor document over a slow link.
const documentTimeout = "60 seconds";

export const fetchDocument = Effect.fnUntraced(function* (url: string) {
  const unread = (why: string, cause?: unknown) =>
    new Unread({ message: `cannot read ${url}: ${why}`, cause });

  if (!/^https?:\/\//.test(url)) {
    return yield* new Unread({ message: `${url} is not an http or https address` });
  }

  const client = yield* HttpClient.HttpClient;
  return yield* Effect.gen(function* () {
    const response = yield* client.execute(HttpClientRequest.get(url));
    if (response.status !== 200) return yield* unread(`it answered ${response.status}`);
    return yield* response.text;
  }).pipe(
    Effect.catchTag("HttpClientError", (error) => Effect.fail(unread(error.message, error))),
    Effect.timeoutOrElse({
      duration: documentTimeout,
      orElse: () => Effect.fail(unread(`no answer within ${documentTimeout}`)),
    }),
  );
});

export const readPatch = Effect.fnUntraced(function* (directory: string, provider: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = `patches/${provider}.json`;
  const at = path.join(directory, file);
  const exists = yield* fs
    .exists(at)
    .pipe(Effect.mapError((cause) => new Unread({ message: `${file} cannot be checked`, cause })));

  if (!exists) return { file, patch: undefined };
  const patch = yield* fs.readFileString(at).pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(SpecPatch))),
    Effect.mapError(
      (cause) =>
        new Unread({
          message: `${file} is not a JSON Patch: a list of add, remove and replace`,
          cause,
        }),
    ),
  );

  return { file, patch };
});
