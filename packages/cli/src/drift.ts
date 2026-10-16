import {
  Catalog,
  CatalogInvalid,
  type Provider,
  type PublishedRoute,
  type SpecPatch,
  blankPlaceholders,
  publishedRoutes,
} from "@telipot/catalog";
import { Effect, Predicate, Result } from "effect";

import { fetchDocument, readPatch } from "./published";

// `task` and `route` are undefined when the spec cannot be read.
interface Drift {
  readonly provider: string;
  readonly task: string | undefined;
  readonly route: string | undefined;
  readonly message: string;
}

// A vendor placeholder matches any plain segment the task writes; `{id}:move` is another route.
const sameSegment = (vendor: string, task: string) =>
  blankPlaceholders(vendor) === blankPlaceholders(task) ||
  (blankPlaceholders(vendor) === "{}" && !/[{:]/.test(task));

const sameRoute = (vendor: string, task: string) => {
  const [here, there] = [vendor.split("/"), task.split("/")];
  return here.length === there.length && here.every((s, i) => sameSegment(s, there[i] ?? ""));
};

const hasRoute = (
  routes: ReadonlyArray<PublishedRoute>,
  route: PublishedRoute,
  match: Provider["route_match"],
) =>
  routes.some(
    ({ method, origin, path }) =>
      method === route.method &&
      origin === route.origin &&
      (match === "exact" ? path === route.path : sameRoute(path, route.path)),
  );

const routesAt = (url: string, patch: SpecPatch | undefined) =>
  fetchDocument(url).pipe(
    Effect.map((text) =>
      Result.mapError(publishedRoutes(text, url, patch), (why) => `cannot read ${url}: ${why}`),
    ),
    Effect.catchTag("Unread", ({ message }) => Effect.succeed(Result.fail(message))),
  );

// Catches a route the vendor moved or removed before an agent pays for it.
export const drift = Effect.fnUntraced(function* (directory: string) {
  const { issues, tasks } = yield* Catalog.validate(directory);
  if (issues.length > 0) return yield* new CatalogInvalid({ issues });

  const published = Map.groupBy(
    tasks.flatMap((entry) => {
      const { openapi } = entry.provider.source;
      if (Predicate.isNull(openapi)) return [];
      return [{ ...entry, urls: Predicate.isString(openapi) ? [openapi] : openapi }];
    }),
    ({ provider }) => provider.provider,
  );

  const found: Array<Drift> = [];
  for (const [slug, group] of published) {
    const [first] = group;
    if (Predicate.isUndefined(first)) continue;
    const { urls, provider } = first;
    const unreadable = (message: string) =>
      found.push({ provider: slug, task: undefined, route: undefined, message });

    const patch = yield* readPatch(directory, slug).pipe(Effect.result);
    if (Result.isFailure(patch)) {
      unreadable(patch.failure.message);
      continue;
    }

    const reads = yield* Effect.forEach(urls, (url) => routesAt(url, patch.success.patch));
    const unread = reads.flatMap((read) => (Result.isFailure(read) ? [read.failure] : []));
    for (const why of unread) unreadable(why);
    if (unread.length > 0) continue;
    const routes = reads.flatMap((read) => (Result.isSuccess(read) ? read.success : []));

    for (const { task, baseUrl } of group) {
      const base = new URL(baseUrl);
      const route = {
        method: task.method,
        origin: base.origin,
        path: `${base.pathname.replace(/\/$/, "")}${task.path}`,
      };

      if (!hasRoute(routes, route, provider.route_match)) {
        found.push({
          provider: slug,
          task: task.id,
          route: `${route.method} ${route.path}`,
          message: `${task.id} calls ${route.method} ${route.origin}${route.path}, which is not in ${urls.join(" or ")}`,
        });
      }
    }
  }

  return found;
});
