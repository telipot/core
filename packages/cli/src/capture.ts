import { Predicate, Result, type Schema } from "effect";
import { isCredentialKey, scrubContact } from "@telipot/catalog";

const maxExampleBytes = 10_000;

const keptItems = 2;
const maxString = 200;

// A schema that combines others is not read; the value under it is kept whole.
const combined = ["anyOf", "oneOf", "allOf", "$ref", "patternProperties"];

// These keys name a person whatever the string says.
const personKey =
  /^(?:author|by|username|user_name|screen_name|display_name|first_name|last_name|full_name)$/i;
// Algolia tags an author as `author_<name>`.
const authorTag = /^author_/;
// An id names our own account, so it is masked even where counts are kept.
const idKey = /(?:^|_)id$|[a-z]Id$/;

const bytes = (json: Schema.Json) => new TextEncoder().encode(JSON.stringify(json, null, 2)).length;

export const shorten = (text: string, length: number) =>
  text.length > length ? `${text.slice(0, length)}…` : text;

// Vendor text is printed to a terminal, where an escape or carriage return could rewrite the screen.
export const plain = (text: string) => text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ");

export const withoutSecrets = (text: string, secrets: ReadonlyArray<string>) =>
  secrets.reduce((safe, secret) => (secret === "" ? safe : safe.replaceAll(secret, "***")), text);

export const scrub = (text: string, secrets: ReadonlyArray<string>) =>
  scrubContact(withoutSecrets(text, secrets));

const isJsonObject = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  Predicate.isObject(value);

const read = (schema: Schema.Json | undefined, key: string): Schema.Json | undefined =>
  isJsonObject(schema) && Object.hasOwn(schema, key) ? schema[key] : undefined;

const combines = (schema: Schema.Json | undefined) =>
  combined.some((key) => Predicate.isNotUndefined(read(schema, key)));

const shapeOf = (schema: Schema.Json | undefined, key: string) => {
  const others = read(schema, "additionalProperties");
  return read(read(schema, "properties"), key) ?? (Predicate.isObject(others) ? others : undefined);
};

// The `output` schema is the contributor's choice of what an agent sees, so a key it
// leaves out never reaches a committed file.
const named = (value: Schema.Json, schema: Schema.Json | undefined): Schema.Json => {
  if (combines(schema)) return value;
  if (Array.isArray(value)) return value.map((item) => named(item, read(schema, "items")));
  if (!isJsonObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, field]) => {
      const shape = shapeOf(schema, key);
      return Predicate.isUndefined(shape) ? [] : [[key, named(field, shape)]];
    }),
  );
};

const unnamedPaths = (
  value: Schema.Json,
  schema: Schema.Json | undefined,
  path: string,
): Array<string> => {
  if (combines(schema)) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => unnamedPaths(item, read(schema, "items"), `${path}[]`));
  }
  if (!isJsonObject(value)) return [];
  return Object.entries(value).flatMap(([key, field]) => {
    const here = path === "" ? key : `${path}.${key}`;
    const shape = shapeOf(schema, key);
    if (Predicate.isNotUndefined(shape)) return unnamedPaths(field, shape, here);
    // A schema that names no key of an object left it open on purpose.
    return Predicate.isObject(read(schema, "properties")) ? [here] : [];
  });
};

// Shows a contributor where the `output` schema is short, so the example drops keys.
export const unnamed = (
  body: Schema.Json,
  output: Schema.Json | undefined,
): ReadonlyArray<string> =>
  Predicate.isUndefined(output)
    ? []
    : [...new Set(unnamedPaths(body, output, "").map((path) => shorten(plain(path), maxString)))];

interface Options {
  readonly secrets: ReadonlyArray<string>;
  readonly masked: boolean;
  readonly output: Schema.Json | undefined;
}

const walkField = (key: string, field: Schema.Json, options: Options): Schema.Json => {
  if (Predicate.isString(field) && isCredentialKey(key)) return "***";
  if (Predicate.isString(field) && personKey.test(key)) return "user";
  if (options.masked && Predicate.isNumber(field) && idKey.test(key)) return 0;
  return walk(field, options);
};

// When masked, numbers other than ids are kept, since a count identifies no one.
const walk = (value: Schema.Json, options: Options): Schema.Json => {
  if (Array.isArray(value)) {
    return value.slice(0, keptItems).map((item) => walk(item, options));
  }
  if (Predicate.isString(value)) {
    if (options.masked) return "masked";
    if (authorTag.test(value)) return "author_user";
    return shorten(scrub(value, options.secrets), maxString);
  }
  if (isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, field]) => [
        scrub(key, options.secrets),
        walkField(key, field, options),
      ]),
    );
  }
  return value;
};

export const capture = (
  body: Schema.Json,
  options: Options,
): Result.Result<Schema.Json, string> => {
  const kept = Predicate.isUndefined(options.output) ? body : named(body, options.output);
  const example = walk(kept, options);
  return bytes(example) <= maxExampleBytes
    ? Result.succeed(example)
    : Result.fail(
        "the response stays over 10 KB after truncation; give the test request a smaller answer",
      );
};
