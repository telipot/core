import type { Entry } from "./rules";
import {
  type AuthScheme,
  type Input,
  credentialPlace,
  fillPlaceholders,
  inputLocations,
} from "./schema";
import { Predicate, type Schema } from "effect";
import { HttpClientRequest } from "effect/http";
import { Base64 } from "effect/encoding";

type Pairs = Array<readonly [name: string, value: string]>;

interface Bound {
  readonly method: Entry["task"]["method"];
  readonly url: string;
  readonly params: Pairs;
  readonly headers: Record<string, string>;
  readonly body?: { readonly json: Schema.Json } | { readonly form: Pairs };
}

export type CallInput = Readonly<Record<string, Schema.Json>>;

const isJsonArray = (value: Schema.Json): value is Schema.JsonArray => Array.isArray(value);

const text = (value: Schema.Json) => (Predicate.isString(value) ? value : JSON.stringify(value));

// An array repeats its name: `a=1&a=2`.
const pairs = (fields: CallInput): Pairs =>
  Object.entries(fields).flatMap(([name, value]) =>
    (isJsonArray(value) ? value : [value]).map((item): readonly [string, string] => [
      name,
      text(item),
    ]),
  );

// A field is declared in one location only, so the locations split the input without overlap.
const fieldsIn = (input: CallInput, declared: Input, location: (typeof inputLocations)[number]) =>
  Object.fromEntries(
    Object.keys(declared[location] ?? {}).flatMap((name) => {
      const value = Object.hasOwn(input, name) ? input[name] : undefined;
      return Predicate.isUndefined(value) ? [] : [[name, value] as const];
    }),
  );

const valueOf = (scheme: AuthScheme, credential: string) => {
  switch (scheme.type) {
    case "api_key":
      return scheme.in === "basic" ? `Basic ${Base64.encode(`${credential}:`)}` : credential;
    case "bearer":
    case "oauth2":
      return `Bearer ${credential}`;
    case "basic":
      // As UTF-8, as RFC 7617 asks, so a password holds any character.
      return `Basic ${Base64.encode(credential)}`;
  }
};

// Header names are lowercased, so the credential and a declared header are one key each.
export const inject = (
  scheme: AuthScheme,
  credential: string,
): { readonly params?: Pairs; readonly headers?: Record<string, string> } => {
  const { location, name } = credentialPlace(scheme);
  const value = valueOf(scheme, credential);
  return location === "queryParams"
    ? { params: [[name, value]] }
    : { headers: { [name.toLowerCase()]: value } };
};

const injectFor = (access: Entry["access"], credential: string) =>
  access._tag === "Public" ? {} : inject(access.scheme, credential);

export const masked = "***";

// A basic pair's password is a secret on its own, which a vendor may echo without the name.
const passwordOf = (entry: Entry, credential: string) => {
  const pair = entry.access._tag === "Credentialed" && entry.access.scheme.type === "basic";
  const colon = credential.indexOf(":");
  return pair && colon >= 0 ? credential.slice(colon + 1) : "";
};

// The shortest key a principal may paste. A shorter password is masked only as a whole value:
// masked anywhere, `a` would turn `accountId` into `***ccountId`.
const shortestMaskedAlone = 8;

// Every encoding the credential is sent in, so a stored answer can be scrubbed of any echo.
// A vendor that echoes its URL may spell a query value as `encodeURIComponent` does.
export const sentForms = (entry: Entry, credential: string): ReadonlyArray<string> => {
  const { headers = {}, params = [] } = injectFor(entry.access, credential);
  const password = passwordOf(entry, credential);
  const maskedAlone = password.length >= shortestMaskedAlone ? [password] : [];
  return [
    ...new Set([
      credential,
      ...Object.values(headers).map((value) => value.replace(/^(?:Basic|Bearer) /, "")),
      ...params.flatMap(([, value]) => [
        value,
        new URLSearchParams([["", value]]).toString().slice(1),
        encodeURIComponent(value),
      ]),
      ...maskedAlone,
    ]),
  ];
};

// A vendor may echo the credential, so every form of it is masked in keys and values. A failure
// also masks the field named where the scheme places the credential; an answer keeps it.
export const withoutCredential = (
  entry: Entry,
  credential: string,
  body: Schema.Json,
  { failure }: { readonly failure: boolean },
): Schema.Json => {
  const forms = sentForms(entry, credential).filter((form) => form !== "");
  const password = passwordOf(entry, credential);
  const short = password.length < shortestMaskedAlone ? password : "";
  // Walking a large answer costs more than parsing it, so one that echoes no form is relayed as
  // is. The parsed body is searched, not the vendor's text, which may hide `/` as `\/`.
  if (!failure) {
    const written = JSON.stringify(body);
    const echoes = (form: string) => written.includes(JSON.stringify(form).slice(1, -1));
    if (!forms.some(echoes) && (short === "" || !written.includes(JSON.stringify(short)))) {
      return body;
    }
  }

  const placed =
    !failure || entry.access._tag === "Public"
      ? undefined
      : credentialPlace(entry.access.scheme).name;

  const mask = (text: string) => forms.reduce((safe, form) => safe.replaceAll(form, masked), text);
  const scrub = (value: Schema.Json): Schema.Json => {
    if (Predicate.isString(value)) return short !== "" && value === short ? masked : mask(value);
    // An all-digit key can come back as a JSON number.
    if (Predicate.isNumber(value)) return forms.includes(String(value)) ? masked : value;
    if (Array.isArray(value)) return value.map(scrub);
    if (!Predicate.isReadonlyObject(value)) return value;
    return Object.fromEntries(
      Object.entries(value as Readonly<Record<string, Schema.Json>>).map(([key, field]) => [
        mask(key),
        key.toLowerCase() === placed?.toLowerCase() ? masked : scrub(field),
      ]),
    );
  };

  return scrub(body);
};

export const bind = (entry: Entry, input: CallInput, credential: string | undefined): Bound => {
  const { task, access, baseUrl } = entry;
  const [pathParams, queryParams, headerFields, body] = inputLocations.map((location) =>
    fieldsIn(input, task.input, location),
  ) as [CallInput, CallInput, CallInput, CallInput];

  const path = fillPlaceholders(task.path, (name) =>
    encodeURIComponent(text(pathParams[name] ?? "")),
  );

  const params = pairs(queryParams);
  const headers: Record<string, string> = {};
  for (const [name, value] of pairs(headerFields)) headers[name.toLowerCase()] = value;

  if (Predicate.isNotUndefined(credential)) {
    const placed = injectFor(access, credential);
    params.push(...(placed.params ?? []));
    Object.assign(headers, placed.headers);
  }

  const bound = { method: task.method, url: `${baseUrl}${path}`, params, headers };
  if (Predicate.isUndefined(task.input.body)) return bound;
  return {
    ...bound,
    body: task.input.bodyType === "form" ? { form: pairs(body) } : { json: body },
  };
};

// Runs and catalog replays both build requests here, so a verified task is the task a caller runs.
export const request = (entry: Entry, input: CallInput, credential: string | undefined) => {
  const bound = bind(entry, input, credential);
  const sent = HttpClientRequest.make(bound.method)(bound.url).pipe(
    HttpClientRequest.appendUrlParams(bound.params),
    HttpClientRequest.setHeaders(bound.headers),
  );

  if (Predicate.isUndefined(bound.body)) return sent;
  return "json" in bound.body
    ? HttpClientRequest.bodyJsonUnsafe(sent, bound.body.json)
    : HttpClientRequest.bodyUrlParams(sent, bound.body.form);
};

// The keys and indexes of a `json_path` such as `statuses[0].status`.
export const jsonPathKeys = (path: string) => path.split(/[.[\]]+/).filter((key) => key !== "");

export const valueAt = (value: unknown, path: string): unknown =>
  jsonPathKeys(path).reduce<unknown>(
    (current, key) =>
      Predicate.isObjectOrArray(current) && Object.hasOwn(current, key)
        ? (current as Record<string, unknown>)[key]
        : undefined,
    value,
  );

export const holdsAt = (value: unknown, path: string, equals: unknown) =>
  JSON.stringify(valueAt(value, path)) === JSON.stringify(equals);
