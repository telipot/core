import { SpecPatch } from "@telipot/catalog";
import { Effect, FileSystem, Path, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

// `new` and `drift` both read vendor documents here, so they see the same routes.

class Unread extends Schema.TaggedError<Unread>()("Unread", {
  message: Schema.String,
}) {}

export const fetchDocument = Effect.fnUntraced(function* (url: string) {
  const unread = (why: string) => new Unread({ message: `cannot read ${url}: ${why}` });
  if (!/^https?:\/\//.test(url)) {
    return yield* new Unread({ message: `${url} is not an http or https address` });
  }

  const client = yield* HttpClient.HttpClient;
  const response = yield* client
    .execute(HttpClientRequest.get(url))
    .pipe(Effect.mapError((error) => unread(error.message)));

  if (response.status !== 200) return yield* unread(`it answered ${response.status}`);
  return yield* response.text.pipe(Effect.mapError((error) => unread(error.message)));
});

export const readPatch = Effect.fnUntraced(function* (directory: string, provider: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = `patches/${provider}.json`;
  const at = path.join(directory, file);
  if (!(yield* fs.exists(at).pipe(Effect.orElseSucceed(() => false)))) {
    return { file, patch: undefined };
  }

  const patch = yield* fs.readFileString(at).pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(SpecPatch))),
    Effect.mapError(
      () =>
        new Unread({ message: `${file} is not a JSON Patch: a list of add, remove and replace` }),
    ),
  );

  return { file, patch };
});
