import { defaultBaseUrl } from "@telipot/sdk";
import { Config, Effect, FileSystem, Option, Path, Redacted, Schema } from "effect";
import { CliError } from "effect/cli";

// The gateway every command but `catalog` talks to, its API and the sign-in it serves.
export const apiUrl = Config.String("TELIPOT_API_URL").pipe(Config.withDefault(defaultBaseUrl));

// Where `telipot login` keeps the token: `$XDG_CONFIG_HOME/telipot/credentials`, or
// `~/.config/telipot/credentials` when that is unset.
export const credentialsFile = Effect.gen(function* () {
  const path = yield* Path.Path;
  const configHome = Option.filter(
    yield* Config.option(Config.String("XDG_CONFIG_HOME")),
    (home) => home !== "",
  );

  const root = Option.isSome(configHome)
    ? configHome.value
    : path.join(yield* Config.String("HOME"), ".config");

  return path.join(root, "telipot", "credentials");
});

// The file `telipot login` writes.
export const Credentials = Schema.fromJsonString(Schema.Struct({ token: Schema.String }));

// Readable by its owner alone. The file is removed and created anew, since a write keeps an
// existing file's mode, and `wx` refuses to follow a link someone put in its place meanwhile.
export const saveToken = Effect.fnUntraced(function* (token: Redacted.Redacted) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = yield* credentialsFile;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true, mode: 0o700 });
  // A folder that was there already keeps its mode through `makeDirectory`.
  yield* fs.chmod(path.dirname(file), 0o700);
  yield* fs.remove(file, { force: true });
  yield* fs.writeFileString(
    file,
    `${yield* Schema.encodeEffect(Credentials)({ token: Redacted.value(token) })}\n`,
    { flag: "wx", mode: 0o600 },
  );

  return file;
});

export const environmentToken = Config.option(Config.Redacted("TELIPOT_TOKEN"));

// The token `telipot login` saved and the file it is in, none when there is no file.
export const loginToken = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* credentialsFile;
  if (!(yield* fs.exists(file))) return Option.none();
  const { token } = yield* Schema.decodeEffect(Credentials)(yield* fs.readFileString(file)).pipe(
    Effect.mapError(
      (cause) =>
        new CliError.UserError({
          cause,
          userMessage: `${file} is not one telipot login wrote. Run telipot login again.`,
        }),
    ),
  );

  return Option.some({ file, token: Redacted.make(token) });
});

// `TELIPOT_TOKEN` wins over the file, so a script or CI runs on a token of its own.
export const savedToken = Effect.gen(function* () {
  const fromEnvironment = yield* environmentToken;
  if (Option.isSome(fromEnvironment)) return fromEnvironment.value;

  const saved = yield* loginToken;
  if (Option.isNone(saved)) {
    return yield* new CliError.UserError({
      cause: undefined,
      userMessage: "Not signed in. Run telipot login, or set TELIPOT_TOKEN.",
    });
  }

  return saved.value.token;
});

// Removes the file `telipot login` wrote; a file already gone is no failure.
export const forgetToken = Effect.fnUntraced(function* (file: string) {
  yield* (yield* FileSystem.FileSystem).remove(file, { force: true });
});
