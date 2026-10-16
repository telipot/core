import { Effect, Predicate, Schema, Stream } from "effect";
import {
  FetchHttpClient,
  Headers,
  HttpClient,
  type HttpClientError,
  type HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";

import { type CallInput, holdsAt, request } from "./bind";
import type { Entry } from "./rules";
import { type AuthScheme, credentialPlace } from "./schema";

// Sending a bound call once, which the gateway's executor and `telipot catalog verify` share, so
// a replayed answer comes back under the same byte limit and redirect rule as a real call.

const ParsedJson = Schema.fromJsonString(Schema.Json);

export class AnswerTooLarge extends Schema.TaggedError<AnswerTooLarge>()("AnswerTooLarge", {
  limit: Schema.Int,
}) {}

// Refused past `limit` while reading, so one vendor cannot fill the server's memory.
// A 204 can come with no body stream.
export const textWithin = (response: HttpClientResponse.HttpClientResponse, limit: number) =>
  response.stream.pipe(
    Stream.catchIf(
      ({ reason }) => reason._tag === "EmptyBodyError",
      () => Stream.empty,
    ),
    Stream.limitBytes(
      limit,
      (): Stream.Stream<Uint8Array, HttpClientError.HttpClientError | AnswerTooLarge> =>
        Stream.fail(new AnswerTooLarge({ limit })),
    ),
    Stream.mkUint8Array,
    Effect.map((bytes) => new TextDecoder().decode(bytes)),
  );

export const bodyOf = (response: HttpClientResponse.HttpClientResponse, text: string) =>
  /\bjson\b/i.test(response.headers["content-type"] ?? "")
    ? Schema.decodeEffect(ParsedJson)(text).pipe(
        // A vendor that labels plain text as JSON gets its text relayed.
        Effect.catchTag("SchemaError", () => Effect.succeed<Schema.Json>(text)),
      )
    : Effect.succeed<Schema.Json>(text);

export const meetsExpect = ({ task: { expect } }: Entry, body: Schema.Json): boolean =>
  Predicate.isUndefined(expect) || holdsAt(body, expect.json_path, expect.equals);

export const defaultMaxBytes = 10 * 1024 * 1024;

// Redirects are never followed, so a credential never reaches another host; a 3xx is a fault.
export const unredirected = <E>(client: HttpClient.HttpClient.With<E>) =>
  HttpClient.transformResponse(
    client,
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
  );

// The client's own span records the full URL and every request header. A credential's header
// is redacted there; a credential in the query would sit in `url.full`, so that request is
// traced by a span of ours that names its origin and path only.
export const executeKeepingCredentialOut = <E>(
  client: HttpClient.HttpClient.With<E>,
  sent: HttpClientRequest.HttpClientRequest,
  scheme: AuthScheme | undefined,
) => {
  if (Predicate.isUndefined(scheme)) return client.execute(sent);
  const { location, name } = credentialPlace(scheme);
  if (location === "headers") {
    return Effect.gen(function* () {
      const names = yield* Headers.CurrentRedactedNames;
      return yield* Effect.provideService(client.execute(sent), Headers.CurrentRedactedNames, [
        ...names,
        name.toLowerCase(),
      ]);
    });
  }

  const url = new URL(sent.url);
  return client.execute(sent).pipe(
    Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
    Effect.withSpan(`http.client ${sent.method}`, {
      kind: "client",
      attributes: {
        "http.request.method": sent.method,
        "server.address": url.origin,
        "url.path": url.pathname,
      },
    }),
  );
};

const schemeOf = ({ access }: Entry) => (access._tag === "Public" ? undefined : access.scheme);

// No timeout, retry or outcome here: the gateway's executor adds those, and
// `telipot catalog verify` reads the answer itself.
export const sendOnce = <E>(client: HttpClient.HttpClient.With<E>, maxBytes: number) => {
  const sender = unredirected(client);
  return Effect.fnUntraced(function* ({
    entry,
    input,
    credential,
  }: {
    readonly entry: Entry;
    readonly input: CallInput;
    readonly credential: string | undefined;
  }) {
    const sent = request(entry, input, credential);
    const response = yield* Predicate.isUndefined(credential)
      ? sender.execute(sent)
      : executeKeepingCredentialOut(sender, sent, schemeOf(entry));

    const body = yield* bodyOf(response, yield* textWithin(response, maxBytes));
    return {
      status: response.status,
      headers: response.headers,
      body,
    };
  });
};
