import { Effect, FileSystem, Path, Predicate, Result, Schema } from "effect";
import { parse } from "yaml";

// One ids.lock.json publication: its date and the ids it added.
export const Publication = Schema.Struct({
  date: Schema.String,
  ids: Schema.Array(Schema.String),
});

export type Publication = typeof Publication.Type;

// The catalog folder as data, for a runtime with no filesystem, plus the lock's history, which
// needs git. YAML listed in `json` is stored as parsed JSON, since parsing takes most of a load;
// a file that does not parse is kept as written.
export const Snapshot = Schema.Struct({
  format: Schema.Literal(1),
  files: Schema.Record(Schema.String, Schema.String),
  json: Schema.Array(Schema.String),
  publications: Schema.Array(Publication),
});

export type Snapshot = typeof Snapshot.Type;

// What `Catalog.layer` reads; only `Catalog.validate` reads queries.yaml, in CI. Folders are
// copied whole, so an empty one stays a folder.
const rootFiles = ["capabilities.yaml", "aliases.yaml", "fx.yaml", "ids.lock.json"];
const folders = ["providers", "examples"];

export const buildSnapshot = Effect.fnUntraced(function* (
  directory: string,
  publications: ReadonlyArray<Publication> = [],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files: Record<string, string> = {};
  const json: Array<string> = [];
  const keep = (file: string, text: string) => {
    if (!file.endsWith(".yaml")) {
      files[file] = text;
      return;
    }

    const parsed = Result.try((): unknown => parse(text));
    files[file] = Result.isSuccess(parsed) ? JSON.stringify(parsed.success) : text;
    if (Result.isSuccess(parsed)) json.push(file);
  };

  for (const file of rootFiles) {
    const at = path.join(directory, file);
    // A missing file stays missing, for the loader to refuse as it would the folder.
    if (yield* fs.exists(at)) keep(file, yield* fs.readFileString(at));
  }

  for (const name of folders) {
    const at = path.join(directory, name);
    if (!(yield* fs.exists(at))) continue;
    const names = (yield* fs.readDirectory(at)).toSorted();
    for (const file of names)
      keep(`${name}/${file}`, yield* fs.readFileString(path.join(at, file)));
  }

  return Snapshot.make({ format: 1, files, json, publications });
});

// A read-only folder at the root `.`; what it does not hold fails as a missing file does.
export const snapshotFileSystem = ({ files }: Snapshot): FileSystem.FileSystem => {
  const missing = FileSystem.makeNoop({});
  const names = Object.keys(files);
  const inFolder = (at: string) => at.replace(/^\.?\/+/, "").replace(/^\.$/, "");
  const childrenOf = (folder: string) => {
    const prefix = folder === "" ? "" : `${folder}/`;
    return [
      ...new Set(
        names
          .filter((name) => name.startsWith(prefix))
          .map((name) => name.slice(prefix.length).split("/", 1)[0] ?? ""),
      ),
    ];
  };

  return FileSystem.makeNoop({
    readFileString: (at, encoding) => {
      const text = files[inFolder(at)];
      return Predicate.isUndefined(text)
        ? missing.readFileString(at, encoding)
        : Effect.succeed(text);
    },
    exists: (at) => {
      const name = inFolder(at);
      return Effect.succeed(name in files || childrenOf(name).length > 0);
    },
    readDirectory: (at) => {
      const children = childrenOf(inFolder(at));
      return children.length > 0 ? Effect.succeed(children) : missing.readDirectory(at);
    },
  });
};

export const snapshotYaml = ({ json }: Snapshot) => {
  const stored = new Set(json);
  return (text: string, file: string): unknown =>
    stored.has(file) ? JSON.parse(text) : parse(text);
};
