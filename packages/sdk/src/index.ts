import {
  Api,
  type ConnectConfirmation,
  type Discover,
  type NewConnectSession,
  type RunBody,
  type ReceiptOptions,
  slugVariable,
  telipotHeader,
} from "@telipot/contract";
import { Config, Effect, type Layer, Option, Predicate, Redacted, Schema, Struct } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";

export const defaultBaseUrl = "https://api.telipot.com";

// The pin that runs whatever version the gateway serves when the call is made.
export const latest = "latest";

// The variable that pins a provider's catalog version when neither the call nor the client does.
export const versionVariable = (provider: string) =>
  `TELIPOT_CATALOG_VERSION_${slugVariable(provider)}`;

// An id with no dot is left for the route to refuse.
const providerOf = (task: string) => task.split(".", 1)[0] ?? task;

export class VersionRequired extends Schema.TaggedError<VersionRequired>()("VersionRequired", {
  detail: Schema.String,
  provider: Schema.String,
}) {}

export interface ClientOptions {
  readonly token: string | Redacted.Redacted;
  readonly baseUrl?: string;
  // Whom every call acts as unless it names another: `organization` or `user:<id>`. Left out,
  // the organization, or the end user a user-bound token is fixed to.
  readonly as?: string;
  // Each provider's catalog version by slug, a date such as 2026-10-04 or `latest`.
  readonly versions?: Readonly<Record<string, string>>;
  // Runs a provider that nothing pins at the version served, rather than refusing the run.
  readonly latest?: boolean;
}

export interface CallOptions {
  readonly as?: string;
}

export interface RunOptions extends CallOptions, Omit<ReceiptOptions, "principal" | "version"> {
  readonly version?: string;
  // Repeat a run under the same key and it runs once.
  readonly idempotencyKey?: string;
}

export type ConnectOptions = CallOptions &
  Omit<typeof NewConnectSession.Type, "provider" | "principal">;

// A user-bound token is sent as it is: the gateway refuses it a principal other than its own.
export const make = Effect.fnUntraced(function* (options: ClientOptions) {
  const token = Predicate.isString(options.token) ? Redacted.make(options.token) : options.token;
  const client = yield* HttpApiClient.make(Api, {
    baseUrl: options.baseUrl ?? defaultBaseUrl,
    transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
  });

  const principalOf = (call: CallOptions) => call.as ?? options.as;
  const principalHeaders = (call: CallOptions) =>
    Option.match(Option.fromUndefinedOr(principalOf(call)), {
      onNone: () => ({}),
      onSome: (principal) => ({ [telipotHeader("principal")]: principal }),
    });

  // The call's pin, then the client's, then the environment's; `latest` sends none.
  const versionOf = Effect.fnUntraced(function* (task: string, call: RunOptions) {
    const provider = providerOf(task);
    const pinned =
      call.version ??
      (Predicate.isNotUndefined(options.versions) && Object.hasOwn(options.versions, provider)
        ? options.versions[provider]
        : undefined) ??
      // `Config.option` is none only for an unset variable; any other failure is a broken
      // `ConfigProvider`, which no caller can act on.
      Option.getOrUndefined(
        yield* Config.option(Config.String(versionVariable(provider))).pipe(Effect.orDie),
      ) ??
      (options.latest === true ? latest : undefined);

    if (Predicate.isUndefined(pinned)) {
      return yield* new VersionRequired({
        detail: `Pin ${provider}'s catalog version with the call's version, the client's versions or ${versionVariable(provider)}, or set it to ${latest} to run whatever is served.`,
        provider,
      });
    }

    return pinned === latest ? undefined : pinned;
  });

  return {
    discover: (request: Discover, call: CallOptions = {}) =>
      client.discover.discover({ payload: request, headers: principalHeaders(call) }),

    inspect: (task: string, call: CallOptions = {}) =>
      client.tasks.inspect({ params: { id: task }, headers: principalHeaders(call) }),

    run: Effect.fnUntraced(function* (
      task: string,
      input: Readonly<Record<string, Schema.Json>> = {},
      call: RunOptions = {},
    ) {
      const version = yield* versionOf(task, call);
      const principal = principalOf(call);
      const receipt: ReceiptOptions = {
        ...Struct.omit(call, ["as", "version", "idempotencyKey"]),
        ...(Predicate.isUndefined(principal) ? {} : { principal }),
        ...(Predicate.isUndefined(version) ? {} : { version }),
      };

      return yield* client.tasks.run({
        params: { id: task },
        headers: Predicate.isUndefined(call.idempotencyKey)
          ? {}
          : { "idempotency-key": call.idempotencyKey },
        // The rest signature types `receipt` as JSON as well; the schema encodes it as options.
        payload: { ...input, receipt } as typeof RunBody.Type,
      });
    }),

    // With no `as`, the principal is the end user a user-bound token is fixed to, from `/v1/me`,
    // or else the organization.
    connect: Effect.fnUntraced(function* (provider: string, { as, ...session }: ConnectOptions) {
      let principal = as ?? options.as;
      if (Predicate.isUndefined(principal)) {
        const { credential } = yield* client.me();
        principal = (credential._tag === "Token" ? credential.principal : null) ?? "organization";
      }

      return yield* client.connect.start({ payload: { ...session, provider, principal } });
    }),

    // An end user's session connects nothing until the backend confirms whom it signed in.
    confirm: (sessionId: string, confirmation: typeof ConnectConfirmation.Type) =>
      client.connect.confirm({ params: { id: sessionId }, payload: confirmation }),
  };
});

export type Client = Effect.Success<ReturnType<typeof make>>;

// The same as promises, for code that does not run Effect. A refused call rejects with the API's
// own tagged error, such as `PrincipalForbidden`, whose `detail` says why.
export class Telipot {
  readonly #client: Client;

  constructor(
    options: ClientOptions & {
      // Where requests go out; `fetch` unless given.
      readonly httpClient?: Layer.Layer<HttpClient.HttpClient>;
    },
  ) {
    const { httpClient = FetchHttpClient.layer, ...client } = options;
    this.#client = Effect.runSync(Effect.provide(make(client), httpClient));
  }

  discover(...args: Parameters<Client["discover"]>) {
    return Effect.runPromise(this.#client.discover(...args));
  }

  inspect(...args: Parameters<Client["inspect"]>) {
    return Effect.runPromise(this.#client.inspect(...args));
  }

  run(...args: Parameters<Client["run"]>) {
    return Effect.runPromise(this.#client.run(...args));
  }

  connect(...args: Parameters<Client["connect"]>) {
    return Effect.runPromise(this.#client.connect(...args));
  }

  confirm(...args: Parameters<Client["confirm"]>) {
    return Effect.runPromise(this.#client.confirm(...args));
  }
}
