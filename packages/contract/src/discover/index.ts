import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import { PrincipalForbidden } from "../caller";
import { CatalogId, FreeText } from "../free-text";
import { PrincipalHeaders } from "../receipt";
import { Task, TaskKind, Tier } from "../tasks";

export const Filters = Schema.Struct({
  provider: Schema.optionalKey(CatalogId),
  tier: Schema.optionalKey(Tier),
  kind: Schema.optionalKey(TaskKind),
}).annotate({ identifier: "Filters" });

export type Filters = typeof Filters.Type;

export const sentenceMaxLength = 500;

export const Sentence = FreeText(sentenceMaxLength).check(Schema.isNonEmpty());

export const Discover = Schema.Struct({
  task: Sentence,
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })).annotate({
      description:
        "How many candidates at most, or near misses when there is none; 8 unless given.",
    }),
  ),
  filters: Schema.optionalKey(Filters),
}).annotate({ identifier: "Discover" });

export type Discover = typeof Discover.Type;

// A word in much of the catalog never counts against a task and is left out.
export const NearMiss = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  matched: Schema.Array(Schema.String),
  missed: Schema.Array(Schema.String),
}).annotate({ identifier: "NearMiss" });

export type NearMiss = typeof NearMiss.Type;

// `near_misses` only when there are no candidates.
export const Discovery = Schema.Struct({
  candidates: Schema.Array(Task),
  near_misses: Schema.optionalKey(Schema.Array(NearMiss)),
}).annotate({ identifier: "Discovery" });

export type Discovery = typeof Discovery.Type;

export class DiscoverApi extends HttpApiGroup.make("discover").add(
  HttpApiEndpoint.post("discover", "/discover", {
    headers: PrincipalHeaders,
    payload: Discover,
    success: Discovery,
    error: PrincipalForbidden.problem,
  }),
) {}
