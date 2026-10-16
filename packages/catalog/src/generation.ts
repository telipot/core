import { Effect, Predicate, Result, Schema } from "effect";
import { parse } from "yaml";

import { type OpenApi, docsOf, routesOf, scaffold, schemesOf, tasksOf } from "./openapi";
import { extendedFile, lockedIds } from "./regenerate";
import {
  ApiKeyScheme,
  ExtendedProvider,
  HttpScheme,
  type IdsLock,
  OAuth2Scheme,
  Provider,
  Task,
} from "./schema";

export class GenerationRefused extends Schema.TaggedError<GenerationRefused>()(
  "GenerationRefused",
  {
    message: Schema.String,
  },
) {}

// Only what generation uses, since other fields may still be null in an unfinished scaffold.
const CoreView = Schema.Struct({
  route_match: Schema.optionalKey(Provider.fields.route_match),
  auth: Schema.optionalKey(
    Schema.Struct({
      schemes: Schema.Record(
        Schema.String,
        Schema.Struct({
          type: Schema.Union([
            ApiKeyScheme.fields.type,
            OAuth2Scheme.fields.type,
            HttpScheme.fields.type,
          ]),
          in: Schema.optionalKey(Schema.String),
          name: Schema.optionalKey(Schema.String),
          // Whom an OAuth scheme serves decides whom its generated tasks act as.
          principals: Schema.optionalKey(Schema.Array(Schema.String)),
        }),
      ),
    }),
  ),
  endpoints: Schema.Array(
    Schema.Struct({
      id: Task.fields.id,
      method: Task.fields.method,
      path: Task.fields.path,
      status: Task.fields.status,
      input: Schema.optionalKey(Schema.Unknown),
    }),
  ),
});

const yaml = (text: string, file: string) =>
  Effect.try({
    try: () => parse(text) as unknown,
    catch: () => new GenerationRefused({ message: `${file} cannot be read as YAML` }),
  });

// No fetching or writing. Published ids are reconciled before reviewed facts are attached.
export const generateProvider = Effect.fnUntraced(function* (input: {
  readonly provider: string;
  readonly today: string;
  readonly document: OpenApi | undefined;
  readonly core: string | undefined;
  readonly previous: string | undefined;
  readonly lock: IdsLock;
}) {
  const { provider, document, today } = input;
  const header = Predicate.isUndefined(input.core)
    ? scaffold(provider, today, document)
    : undefined;

  const created = Predicate.isUndefined(header)
    ? undefined
    : { text: header.text, reviews: header.reviews };

  const coreFile = `providers/${provider}.yaml`;
  const extendedPath = `providers/${provider}.extended.yaml`;
  const core: typeof CoreView.Type = Predicate.isUndefined(input.core)
    ? { endpoints: [], route_match: "normalized" as const }
    : yield* yaml(input.core, coreFile).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(CoreView)),
        Effect.mapError(
          () =>
            new GenerationRefused({
              message: `${coreFile} has no endpoints list; run telipot catalog validate`,
            }),
        ),
      );

  if (Predicate.isUndefined(document)) {
    return { created, extended: undefined, lock: input.lock, lockText: undefined };
  }

  const previous = Predicate.isUndefined(input.previous)
    ? undefined
    : yield* yaml(input.previous, extendedPath).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.toEncoded(ExtendedProvider))),
        Effect.mapError(
          () =>
            new GenerationRefused({
              message: `${extendedPath} does not load; restore a valid previous file before regenerating`,
            }),
        ),
      );

  if (Predicate.isNotUndefined(previous) && previous.provider !== provider) {
    return yield* new GenerationRefused({
      message: `${extendedPath} describes ${previous.provider}`,
    });
  }

  for (const task of core.endpoints) {
    const before = previous?.endpoints.find((one) => one.id === task.id);
    if (
      Predicate.isNotUndefined(before) &&
      (before.method !== task.method || before.path !== task.path)
    ) {
      return yield* new GenerationRefused({
        message: `${coreFile} reassigns ${task.id} from ${before.method} ${before.path}; keep its published route or use a new id`,
      });
    }
  }

  const known = new Set([
    ...core.endpoints.map(({ id }) => id),
    ...(previous?.endpoints ?? []).map(({ id }) => id),
  ]);

  const missing = input.lock.filter((id) => id.startsWith(`${provider}.x.`) && !known.has(id));
  if (missing.length > 0) {
    return yield* new GenerationRefused({
      message: `${extendedPath} has no history for ${missing.join(", ")}; restore their published tasks before regenerating`,
    });
  }

  const curated = {
    route_match: core.route_match ?? "normalized",
    endpoints: core.endpoints.map(({ input, ...route }) => {
      const read = Schema.decodeUnknownResult(Task.fields.input)(input);
      return { ...route, input: Result.isSuccess(read) ? read.success : undefined };
    }),
  };

  const generated = tasksOf(
    document,
    provider,
    header?.schemes ?? schemesOf(core.auth?.schemes ?? {}),
    {
      previous: previous?.endpoints ?? [],
      reserved: [...input.lock, ...core.endpoints.map(({ id }) => id)],
      core: curated,
    },
  );

  const extended = yield* extendedFile({
    provider,
    openapi: document.url,
    docs: docsOf(document),
    core: curated,
    tasks: generated.tasks,
    routes: routesOf(document),
    previous,
    lock: input.lock,
    today,
  });

  const lock = lockedIds(
    input.lock,
    extended.file.endpoints.map(({ id }) => id),
  );

  return {
    created,
    extended: { ...extended, leftOut: generated.leftOut },
    lock,
    lockText: lock.length === input.lock.length ? undefined : `${JSON.stringify(lock, null, 2)}\n`,
  };
});
