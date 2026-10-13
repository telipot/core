import { Array as Arr, Option, Order, Predicate, Record } from "effect";
import { stemmer } from "stemmer";

import { cheapestFirst, type Problem } from "./price";
import type { Entry, Served } from "./rules";
import { type AliasesFile, type QueriesFile, type Task, type Tier, tiers } from "./schema";

// aliases.yaml and queries.yaml are checked on the index the search runs over, so they never
// disagree about a word. Fix a missed query in a capability description or aliases.yaml, not here.

export interface Filters {
  readonly provider?: string;
  readonly tier?: Tier;
  readonly kind?: Task["kind"];
}

export interface SearchOptions {
  // Below one returns none, and never turns a hit into a miss.
  readonly limit?: number;
  readonly filters?: Filters;
}

// `missed` tells an agent which words to drop; soft words, and words no live task holds,
// cost nothing and are left out.
export interface NearMiss {
  readonly entry: Entry;
  readonly matched: ReadonlyArray<string>;
  readonly missed: ReadonlyArray<string>;
}

export type Search =
  | { readonly _tag: "Found"; readonly hits: ReadonlyArray<Entry> }
  | { readonly _tag: "Missed"; readonly nearMisses: ReadonlyArray<NearMiss> };

// Also the rank within which queries.yaml must find each sentence's task.
const defaultLimit = 8;

// With the request verbs a sentence opens with, which no task name holds.
const functionWords = new Set(
  `a an the and or but not no nor of for to in on at by with from as into onto about over
   under up down out off than then that this these those it its is are was were be been being
   am do does did done have has had having i me my mine we our us you your yours he him she her
   they them their what which who whom whose when where why how all any some each every both
   few more most other such only own same so too very just also can could will would shall
   should may might must please want wants need needs like
   if get gets got fetch find show give tell look let check many much`.split(/\s+/),
);

// A URL, an email address or a domain is a task's input, never a word of its job.
const values = /\S+@\S+|\b[a-z][a-z0-9+.-]*:\/\/\S+|\b[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\b\S*/gi;

const tokenize = (text: string): ReadonlyArray<string> =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !functionWords.has(word));

// A word is indexed by its Porter stem, so "meetings" finds "meeting", and as written, so a
// task that holds the very word a sentence says outranks one that holds only its stem.
const exactly = (word: string) => `=${word}`;
const keysOf = (text: string) => tokenize(text).flatMap((word) => [stemmer(word), exactly(word)]);

// The name is our search title, so it outweighs the provider's summary. A platform word
// narrows the whole area, so it scores double the name.
const weights = { platform: 6, name: 3, capability: 2, provider: 2, summary: 1 } as const;
type Field = keyof typeof weights;

const textsOf = (
  { task, provider, platform }: Entry,
  capabilities: Served["capabilities"],
): { readonly [F in Field]: string } => ({
  platform: platform ?? "",
  name: task.name,
  capability: Option.getOrElse(Record.get(capabilities, task.capability ?? ""), () => ""),
  provider: `${provider.provider} ${provider.display_name}`,
  summary: task.summary,
});

const passes = ({ provider, tier, task }: Entry, filters: Filters) =>
  (Predicate.isUndefined(filters.provider) || provider.provider === filters.provider) &&
  (Predicate.isUndefined(filters.tier) || tier === filters.tier) &&
  (Predicate.isUndefined(filters.kind) || task.kind === filters.kind);

// What `Catalog.live` keeps: the search's filters, a capability, and text that a task's id, name
// or summary holds, in any case.
export interface LiveFilters extends Filters {
  readonly capability?: string;
  readonly text?: string;
}

export const keeps = (entry: Entry, { capability, text, ...filters }: LiveFilters) => {
  const { id, name, summary } = entry.task;
  const needle = text?.toLowerCase();
  return (
    passes(entry, filters) &&
    (Predicate.isUndefined(capability) || entry.task.capability === capability) &&
    (Predicate.isUndefined(needle) ||
      [id, name, summary].some((field) => field.toLowerCase().includes(needle)))
  );
};

interface Word {
  readonly word: string;
  readonly stem: string;
  readonly exact?: string;
}

interface Scored extends NearMiss {
  readonly score: number;
  readonly qualifies: boolean;
}

// Rank by bucket, never a blended score: relevance, then core before extended,
// then price. Equal prices keep the catalog's slug order.
const byRank: Order.Order<Scored> = Order.combine(
  Order.mapInput(Order.flip(Order.Number), ({ score }: Scored) => score),
  Order.combine(
    Order.mapInput(Order.Number, ({ entry }: Scored) => tiers.indexOf(entry.tier)),
    Order.mapInput(cheapestFirst, ({ entry }: Scored) => entry.price),
  ),
);

const byNearness: Order.Order<Scored> = Order.combine(
  Order.mapInput(Order.flip(Order.Number), ({ matched }: Scored) => matched.length),
  byRank,
);

// An alias replaces the query word, so a key a live task is found by would hide that task.
// A one-word target keeps a sentence's word count, which decides how many words may miss.
const checkAliases = (
  aliases: AliasesFile["aliases"],
  inTasks: (word: string) => number,
): {
  readonly problems: ReadonlyArray<Required<Problem>>;
  readonly warnings: ReadonlyArray<Required<Problem>>;
} => {
  const problems: Array<Required<Problem>> = [];
  const warnings: Array<Required<Problem>> = [];
  for (const [key, target] of Object.entries(aliases)) {
    const path = ["aliases", key];
    const [word, ...rest] = tokenize(key);
    if (word !== key || rest.length > 0) {
      problems.push({
        file: "aliases.yaml",
        path,
        message:
          "is not a word a query is read as: lowercase letters and digits, no function word, two characters or more",
      });
    } else if (inTasks(stemmer(key)) > 0) {
      problems.push({
        file: "aliases.yaml",
        path,
        message: `is a word ${inTasks(stemmer(key))} task(s) are found by, which the alias would hide from it`,
      });
    }

    const targets = tokenize(target);
    if (targets.length !== 1) {
      problems.push({
        file: "aliases.yaml",
        path,
        message: `${target} is read as ${targets.length} words, not one`,
      });
    }

    for (const missing of targets.filter((found) => inTasks(stemmer(found)) === 0)) {
      warnings.push({ file: "aliases.yaml", path, message: `no task is found by ${missing}` });
    }
  }
  return { problems, warnings };
};

// Run by `Catalog.validate`, never by the server.
const checkQueries = (
  { queries, mean_reciprocal_rank_at_least: floor }: QueriesFile,
  search: (query: string) => Search,
  live: ReadonlySet<string>,
): ReadonlyArray<Required<Problem>> => {
  const problems: Array<Required<Problem>> = [];
  // The 1-based rank of the task each sentence should find, 0 when absent.
  const ranks = queries.map(({ task, finds }, index) => {
    if (!live.has(finds)) {
      problems.push({
        file: "queries.yaml",
        path: ["queries", index, "finds"],
        message: `${finds} is not a live task`,
      });
      return 0;
    }

    const found = search(task);
    const rank =
      found._tag === "Found" ? found.hits.findIndex(({ task }) => task.id === finds) + 1 : 0;
    if (rank === 0) {
      problems.push({
        file: "queries.yaml",
        path: ["queries", index, "task"],
        message: `does not find ${finds} within the first ${defaultLimit}`,
      });
    }
    return rank;
  });
  const reciprocal = ranks.reduce((sum, rank) => sum + (rank === 0 ? 0 : 1 / rank), 0);
  const mean = reciprocal / ranks.length;
  if (mean < floor) {
    problems.push({
      file: "queries.yaml",
      path: ["mean_reciprocal_rank_at_least"],
      message: `the sentences rank their tasks at a mean reciprocal rank of ${mean.toFixed(3)}, under ${floor}`,
    });
  }
  return problems;
};

export const checkSearch = (
  { tasks, capabilities, aliases }: Pick<Served, "tasks" | "capabilities"> & AliasesFile,
  queries: QueriesFile | undefined,
): {
  readonly search: (query: string, options?: SearchOptions) => Search;
  readonly problems: ReadonlyArray<Required<Problem>>;
  readonly warnings: ReadonlyArray<Required<Problem>>;
} => {
  const live = tasks.filter(({ tombstone }) => Predicate.isUndefined(tombstone));

  // A word's weight is the sum over the fields that hold it.
  const documents = live.map((entry) => {
    const texts = textsOf(entry, capabilities);
    const found = new Map<string, number>();
    for (const field of Object.keys(weights) as ReadonlyArray<Field>) {
      for (const word of new Set(keysOf(texts[field]))) {
        found.set(word, (found.get(word) ?? 0) + weights[field]);
      }
    }
    return { entry, weights: found };
  });
  const frequency = new Map<string, number>();
  for (const { weights } of documents) {
    for (const word of weights.keys()) frequency.set(word, (frequency.get(word) ?? 0) + 1);
  }
  const inTasks = (word: string) => frequency.get(word) ?? 0;
  const total = documents.length;

  // BM25's idf: a word in few tasks weighs more.
  const idf = (word: string) => Math.log(1 + (total - inTasks(word) + 0.5) / (inTasks(word) + 0.5));
  // A word in over a quarter of live tasks is soft: it adds score but never counts against a task.
  const isSoft = (word: string) => inTasks(word) > total / 4;
  // An alias is found by its stem, so `meeting` reads "meetings" too.
  const aliasOf = new Map(Object.entries(aliases).map(([key, target]) => [stemmer(key), target]));
  // Each word as read, after its alias, with the stem it matches by and the word as written,
  // which only the sentence's own word has; one per stem.
  const read = (sentence: string): ReadonlyArray<Word> =>
    Arr.dedupeWith(
      tokenize(sentence.replace(values, " ")).flatMap((said): ReadonlyArray<Word> =>
        Option.match(Option.fromNullishOr(aliasOf.get(stemmer(said))), {
          onNone: () => [{ word: said, stem: stemmer(said), exact: exactly(said) }],
          onSome: (target) => tokenize(target).map((word) => ({ word, stem: stemmer(word) })),
        }),
      ),
      (a, b) => a.stem === b.stem,
    );

  // Idf and soft words count every live task, so a filter never changes how a task scores.
  const search = (
    query: string,
    { limit = defaultLimit, filters = {} }: SearchOptions = {},
  ): Search => {
    // A word no live task holds, such as a name or a date, tells no task from another.
    const words = read(query).filter(({ stem }) => inTasks(stem) > 0);
    // Three words or more may miss one in three, rounded; one or two must all match.
    const allowed = words.length < 3 ? 0 : Math.round(words.length / 3);
    const scored = documents.flatMap(({ entry, weights }): ReadonlyArray<Scored> => {
      if (!passes(entry, filters)) return [];
      const matched = words.filter(({ stem }) => weights.has(stem));
      if (matched.length === 0) return [];
      const missed = words.filter(({ stem }) => !weights.has(stem) && !isSoft(stem));
      return [
        {
          entry,
          matched: matched.map(({ word }) => word),
          missed: missed.map(({ word }) => word),
          // Rounded so scores equal in exact arithmetic tie, however the floats summed.
          score: Math.round(
            matched.reduce(
              (sum, { stem, exact }) =>
                sum +
                [stem, exact].reduce(
                  (part, key) =>
                    Predicate.isUndefined(key) ? part : part + (weights.get(key) ?? 0) * idf(key),
                  0,
                ),
              0,
            ) * 1e9,
          ),
          qualifies: missed.length <= allowed,
        },
      ];
    });
    const qualified = scored.filter(({ qualifies }) => qualifies);
    if (qualified.length > 0) {
      return {
        _tag: "Found",
        hits: Arr.take(qualified.toSorted(byRank), limit).map(({ entry }) => entry),
      };
    }
    return {
      _tag: "Missed",
      nearMisses: Arr.take(scored.toSorted(byNearness), limit).map(
        ({ entry, matched, missed }) => ({ entry, matched, missed }),
      ),
    };
  };

  const checked = checkAliases(aliases, inTasks);
  return {
    search,
    problems: Predicate.isUndefined(queries)
      ? checked.problems
      : [
          ...checked.problems,
          ...checkQueries(queries, search, new Set(live.map(({ task }) => task.id))),
        ],
    warnings: checked.warnings,
  };
};
