import { Effect, Order, Predicate } from "effect";
import { stringify } from "yaml";

import { type Curated, curatedBy, extendedDigest, isReviewed, isTwin } from "./extended";
import { type ExtendedProvider, type IdsLock, type Task, verificationStates } from "./schema";

type Written = typeof ExtendedProvider.Encoded;
type WrittenTask = typeof Task.Encoded;

// What `verify` stamps on a task; `untestable` is the generator's own to write.
const stamps: ReadonlyArray<string> = verificationStates.filter((state) => state !== "untestable");
// What a person or `verify` records beyond the spec, carried into the regenerated file.
const recorded = [...stamps, "example_response", "resource_ownership"];

// A fixed key order, so a regenerated file differs from the last only where a value does.
const taskKeys = [
  "id",
  "capability",
  "kind",
  "auth",
  "scope",
  "principal",
  "required_scopes",
  "method",
  "path",
  "base_url",
  "name",
  "summary",
  "docs_url",
  "input",
  "async",
  "test_request",
  "untestable",
  "verified",
  "unverified",
  "skipped",
  "example_response",
  "resource_ownership",
  "status",
  "status_note",
  "superseded_by",
];

const rank = (key: string) => {
  const at = taskKeys.indexOf(key);
  return at === -1 ? taskKeys.length : at;
};

const inOrder = (task: WrittenTask): WrittenTask =>
  Object.fromEntries(
    Object.entries(task).toSorted(Order.mapInput(Order.Number, ([key]) => rank(key))),
  ) as WrittenTask;

const only = (task: WrittenTask, keep: (key: string) => boolean) =>
  Object.fromEntries(Object.entries(task).filter(([key]) => keep(key)));

// Reviewed fields carry whole, so what a reviewer set or removed stays; a recorded verification
// beats a generated `untestable`. An own_account task is replayed live, so it has no test request.
const carry = (generated: WrittenTask, before: WrittenTask | undefined): WrittenTask => {
  if (Predicate.isUndefined(before)) return generated;
  const stamped = Object.keys(before).some((key) => stamps.includes(key));
  const fromBefore = (key: string) =>
    isReviewed(key) || recorded.includes(key) || (stamped && key === "test_request");
  const task = {
    ...only(generated, (key) => !fromBefore(key) && !(stamped && key === "untestable")),
    ...only(before, fromBefore),
  } as WrittenTask;
  if (task.scope !== "own_account") return task;
  const { test_request: _, untestable: __, ...rest } = task;
  return rest;
};

export const lockedIds = (lock: IdsLock, ids: ReadonlyArray<string>): IdsLock =>
  [...new Set([...lock, ...ids])].toSorted(Order.String);

interface Route {
  readonly method: string;
  readonly path: string;
  readonly deprecated: boolean;
}

// A locked task no longer offered becomes a tombstone so its id keeps answering; an unlocked one
// is dropped. Dates stay put while only reviewed fields differ, so an unchanged spec gives a
// byte-identical file.
export const extendedFile = Effect.fnUntraced(function* (input: {
  readonly provider: string;
  readonly openapi: string;
  readonly docs: string | null;
  readonly core: Curated;
  readonly tasks: ReadonlyArray<WrittenTask>;
  // Every route the spec has, whether or not a task was made of it.
  readonly routes: ReadonlyArray<Route>;
  readonly previous: Written | undefined;
  readonly lock: IdsLock;
  readonly today: string;
}) {
  const { core, previous } = input;
  const before = new Map((previous?.endpoints ?? []).map((task) => [task.id, task]));
  const locked = new Set(input.lock);
  const routeOf = (task: Pick<WrittenTask, "method" | "path">) =>
    input.routes.find(({ method, path }) => method === task.method && path === task.path);

  const offered = input.tasks
    .filter((task) => !isTwin(core, task))
    .map((task) => inOrder(carry(task, before.get(task.id))));
  const offeredIds = new Set(offered.map(({ id }) => id));

  const gone = (previous?.endpoints ?? []).filter(
    (task) =>
      !offeredIds.has(task.id) &&
      locked.has(task.id) &&
      !core.endpoints.some((one) => one.id === task.id),
  );
  const retire = (task: WrittenTask): { readonly kept: boolean; readonly task: WrittenTask } => {
    const curator = curatedBy(core, task);
    if (Predicate.isNotUndefined(curator)) {
      const { superseded_by: _, ...old } = task;
      return {
        kept: false,
        task: inOrder({
          ...old,
          status: "retired",
          status_note: `${curator.id} curates this route now`,
          ...(Predicate.isUndefined(curator.status) ? { superseded_by: curator.id } : {}),
        }),
      };
    }
    // Repairs an older file that published two ids for one route: the extra id becomes a tombstone.
    const successor = offered.find((one) => one.method === task.method && one.path === task.path);
    if (Predicate.isNotUndefined(successor)) {
      return {
        kept: false,
        task: inOrder({
          ...task,
          status: "retired",
          status_note: `${successor.id} serves this route now`,
          superseded_by: successor.id,
        }),
      };
    }
    if (Predicate.isNotUndefined(task.status)) return { kept: false, task };
    const route = routeOf(task);
    if (Predicate.isNotUndefined(route) && !route.deprecated) return { kept: true, task };
    const why = Predicate.isUndefined(route)
      ? "the provider's spec no longer offers this route"
      : "the provider's spec marks this route deprecated";
    return { kept: false, task: inOrder({ ...task, status: "retired", status_note: why }) };
  };
  const retired = gone.map(retire);

  const current = new Map<string, Pick<WrittenTask, "id" | "status" | "superseded_by">>([
    ...core.endpoints.map((task) => [task.id, task] as const),
    ...offered.map((task) => [task.id, task] as const),
    ...retired.map(({ task }) => [task.id, task] as const),
  ]);
  // A successor may itself be retired; point at the live end of the chain so the loader never follows one.
  const successorOf = (id: string, seen = new Set<string>()): string | undefined => {
    if (seen.has(id)) return undefined;
    seen.add(id);
    const task = current.get(id);
    if (Predicate.isUndefined(task)) return undefined;
    if (Predicate.isUndefined(task.status)) return id;
    return Predicate.isUndefined(task.superseded_by)
      ? undefined
      : successorOf(task.superseded_by, seen);
  };
  const reconcile = (task: WrittenTask): WrittenTask => {
    if (Predicate.isUndefined(task.superseded_by)) return task;
    const successor = successorOf(task.superseded_by);
    if (successor === task.superseded_by) return task;
    const { superseded_by: _, ...rest } = task;
    return inOrder(
      Predicate.isUndefined(successor)
        ? rest
        : {
            ...rest,
            superseded_by: successor,
            status_note: `${successor} supersedes this task now`,
          },
    );
  };
  const endpoints = [...offered, ...retired.map(({ task }) => task)]
    .map(reconcile)
    .toSorted(Order.mapInput(Order.String, (task: WrittenTask) => task.id));
  const written = Effect.fnUntraced(function* (date: string, curated: string) {
    const file: Written = {
      provider: input.provider,
      source: { docs: input.docs ?? input.openapi, openapi: input.openapi, curated },
      version: date,
      digest: "",
      endpoints,
    };
    return { ...file, digest: yield* extendedDigest(file) };
  });

  const unchanged = Predicate.isUndefined(previous)
    ? undefined
    : yield* written(previous.version, previous.source.curated);
  const file =
    Predicate.isNotUndefined(unchanged) && unchanged.digest === previous?.digest
      ? unchanged
      : yield* written(input.today, input.today);

  const emitted = new Map(endpoints.map((task) => [task.id, task]));
  const tombstoned = retired.flatMap(({ kept, task }) => {
    const note = emitted.get(task.id)?.status_note;
    return kept || Predicate.isUndefined(note) ? [] : [{ id: task.id, note }];
  });
  const tombstonedIds = new Set(tombstoned.map(({ id }) => id));
  return {
    file,
    // Write a value shared through a `$ref` out twice, never as a YAML anchor and alias.
    text: stringify(file, { lineWidth: 0, aliasDuplicateObjects: false }),
    // Left out since core curates the route; a published one is reported as a tombstone instead.
    twins: input.tasks
      .filter((task) => isTwin(core, task) && !tombstonedIds.has(task.id))
      .map(({ id }) => id),
    tombstoned,
    // Still offered by the spec, but no task could be made now, so kept as written.
    stale: retired.flatMap(({ kept, task }) => (kept ? [task.id] : [])),
  };
});
