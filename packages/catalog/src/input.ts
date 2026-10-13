import {
  JsonSchema,
  Predicate,
  Record,
  Result,
  Schema,
  SchemaIssue,
  SchemaParser,
  SchemaRepresentation,
} from "effect";

import type { Problem } from "./price";
import {
  type InputField,
  type Task,
  inputLocations,
  placeholdersOf,
  reservedInput,
} from "./schema";

// JSON Schema 2020-12.
export type InputSchema = { readonly [keyword: string]: Schema.Json };

export const bounds: {
  readonly [Type in InputField["type"]]?: readonly [
    min: "minimum" | "minLength" | "minItems",
    max: "maximum" | "maxLength" | "maxItems",
  ];
} = {
  integer: ["minimum", "maximum"],
  number: ["minimum", "maximum"],
  string: ["minLength", "maxLength"],
  array: ["minItems", "maxItems"],
};

export const isRequired = (
  path: string,
  location: (typeof inputLocations)[number],
  name: string,
  field: Pick<InputField, "required">,
) => field.required === true || (location === "pathParams" && placeholdersOf(path).includes(name));

const fieldSchema = (field: InputField): InputSchema => {
  const keywords: { [keyword: string]: Schema.Json | undefined } = {
    type: field.type,
    description: field.note,
    enum: field.enum,
    const: field.const,
    default: field.default,
    examples: Predicate.isUndefined(field.example) ? undefined : [field.example],
  };
  const [min, max] = bounds[field.type] ?? [];
  if (Predicate.isNotUndefined(min) && Predicate.isNotUndefined(max)) {
    keywords[min] = field.min;
    keywords[max] = field.max;
  }
  return Record.filter(keywords, Predicate.isNotUndefined);
};

const formatter = SchemaIssue.makeFormatterStandardSchemaV1();
const count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

// YAML, JSON and JSON Schema errors name the place on their first line.
export const firstLine = (error: unknown) => String(error).replace(/\n[\s\S]*/, "");

// Input, replays and outputs share one importer and its parse options, so a constraint means
// the same everywhere.
export const jsonSchemaDecoder = (
  schema: InputSchema,
  options?: SchemaRepresentation.FromJsonSchemaOptions,
) =>
  Result.try({
    try: () =>
      SchemaParser.decodeUnknownResult(
        Schema.make<Schema.Codec<unknown>>(
          SchemaRepresentation.fromJsonSchemaDocument(
            JsonSchema.fromSchemaDraft2020_12(schema),
            options,
          ).ast,
        ),
        { errors: "all", onExcessProperty: "error" },
      ),
    catch: firstLine,
  });

export const problemsIn = (
  issue: SchemaIssue.Issue,
  at: ReadonlyArray<PropertyKey> = [],
): Array<Problem> =>
  formatter(issue).issues.map((found) => ({
    path: [
      ...at,
      ...(found.path ?? []).map((segment) =>
        Predicate.hasProperty(segment, "key") ? segment.key : segment,
      ),
    ],
    message: found.message,
  }));

export type DecodeInput = (
  input: unknown,
) => Result.Result<Readonly<Record<string, Schema.Json>>, ReadonlyArray<Problem>>;

// A path value of only dots could reach a vendor route the catalog does not describe, price or scope.
const dotsOnly = /^\.+$/;

export const inputDecoder = (
  schema: InputSchema,
  pathFields: ReadonlyArray<string>,
): Result.Result<DecodeInput, string> =>
  Result.map(
    jsonSchemaDecoder(schema),
    (decode) => (input) =>
      Result.match(decode(input), {
        onSuccess: (decoded) => {
          // The schema is an object of JSON fields, so what it admits is one.
          const value = decoded as Readonly<Record<string, Schema.Json>>;
          const routing = pathFields.flatMap((name) => {
            const field = Object.hasOwn(value, name) ? value[name] : undefined;
            return Predicate.isString(field) && dotsOnly.test(field)
              ? [{ path: [name], message: "a path value cannot be only dots" }]
              : [];
          });
          return routing.length > 0 ? Result.fail(routing) : Result.succeed(value);
        },
        onFailure: (issue) => Result.fail(problemsIn(issue, [])),
      }),
  );

// A call's input is one flat object; a replay is written by location but must fit the same fields.
export const checkInput = ({
  input,
  path,
  test_request: request,
}: Pick<Task, "input" | "path" | "test_request">): Result.Result<
  InputSchema,
  ReadonlyArray<Problem>
> => {
  const problems: Array<Problem> = [];
  const properties = new Map<string, InputSchema>();
  const required: Array<string> = [];
  const seen = new Map<string, (typeof inputLocations)[number]>();
  const placeholders = new Set(placeholdersOf(path));
  const report = (at: ReadonlyArray<PropertyKey>, message: string) => {
    problems.push({ path: at, message });
  };
  const checkValue = (
    decode: ReturnType<typeof SchemaParser.decodeUnknownResult<Schema.Codec<unknown>>>,
    value: unknown,
    at: ReadonlyArray<PropertyKey>,
  ) => {
    const decoded = decode(value);
    if (Result.isFailure(decoded)) problems.push(...problemsIn(decoded.failure, at));
  };

  // An undeclared placeholder would be absent from the schema an agent reads.
  for (const name of placeholders) {
    if (!Object.hasOwn(input.pathParams ?? {}, name)) {
      report(["input", "pathParams", name], "the path placeholder needs a declared input field");
    }
  }

  const requested = new Set(
    inputLocations.flatMap((location) => Object.keys(request?.[location] ?? {})),
  );

  for (const location of inputLocations) {
    for (const [name, field] of Object.entries(input[location] ?? {})) {
      const at = ["input", location, name];
      const first = seen.get(name);
      if (Predicate.isNotUndefined(first)) {
        report(at, `${name} is already a field in ${first}; a call's input is one flat object`);
        continue;
      }
      seen.set(name, location);
      if (name === reservedInput) {
        report(at, `${reservedInput} is the key a run's options travel under`);
        continue;
      }
      if (location === "pathParams" && !placeholders.has(name)) {
        report(at, "names no placeholder in the task's path");
      }
      const needed = isRequired(path, location, name, field);
      if (needed) required.push(name);
      if (Predicate.isNotUndefined(request) && needed && !requested.has(name)) {
        report(["test_request", location, name], "required by the task's input");
      }

      const before = problems.length;
      // Length and size bounds are counts; numeric bounds may be decimals.
      if (field.type === "string" || field.type === "array") {
        for (const bound of ["min", "max"] as const) {
          if (
            Predicate.isNotUndefined(field[bound]) &&
            Result.isFailure(SchemaParser.decodeResult(count)(field[bound]))
          ) {
            report([...at, bound], "a length or size bound is a non-negative integer");
          }
        }
      }
      if (
        Object.hasOwn(bounds, field.type) &&
        Predicate.isNotUndefined(field.min) &&
        Predicate.isNotUndefined(field.max) &&
        field.min > field.max
      ) {
        report([...at, "max"], "must be at least min so an input can satisfy both bounds");
      } else if (
        field.type === "integer" &&
        Predicate.isNotUndefined(field.min) &&
        Predicate.isNotUndefined(field.max) &&
        Math.ceil(field.min) > Math.floor(field.max)
      ) {
        report([...at, "max"], "the bounds must admit at least one integer");
      }

      const schema = fieldSchema(field);
      properties.set(name, schema);
      if (problems.length > before) continue;

      // enum and const narrow the declared type, not replace it; defaults and examples must fit all.
      const { enum: _, const: __, ...base } = schema;
      const basic = jsonSchemaDecoder(base);
      if (Result.isFailure(basic)) {
        report(at, basic.failure);
        continue;
      }
      for (const [index, value] of (field.enum ?? []).entries()) {
        checkValue(basic.success, value, [...at, "enum", index]);
      }
      if (Predicate.isNotUndefined(field.const)) {
        checkValue(basic.success, field.const, [...at, "const"]);
      }
      if (problems.length > before) continue;

      const constrained = jsonSchemaDecoder(schema);
      if (Result.isFailure(constrained)) {
        report(at, constrained.failure);
        continue;
      }
      if (Predicate.isNotUndefined(field.const)) {
        checkValue(constrained.success, field.const, [...at, "const"]);
      }
      for (const declared of ["default", "example"] as const) {
        if (Predicate.isNotUndefined(field[declared])) {
          checkValue(constrained.success, field[declared], [...at, declared]);
        }
      }
      if (Predicate.isNotUndefined(request) && Object.hasOwn(request[location] ?? {}, name)) {
        checkValue(constrained.success, request[location]?.[name], [
          "test_request",
          location,
          name,
        ]);
      }
    }
  }

  // A replay is sent where the file wrote each value, so its locations must match the input's.
  for (const location of inputLocations) {
    for (const name of Object.keys(request?.[location] ?? {})) {
      if (Object.hasOwn(input[location] ?? {}, name)) continue;
      const declared = seen.get(name);
      report(
        ["test_request", location, name],
        Predicate.isUndefined(declared)
          ? "names no input field"
          : `the input field is declared in ${declared}, not ${location}`,
      );
    }
  }

  if (problems.length > 0) return Result.fail(problems);
  return Result.succeed({
    type: "object",
    properties: Object.fromEntries(properties),
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  });
};
