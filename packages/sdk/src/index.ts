import {
  Api,
  type ConnectConfirmation,
  type Discover,
  type NewConnectSession,
  ProblemDetails,
  type RunBody,
  type ReceiptOptions,
  slugVariable,
  telipotHeader,
} from "@telipot/contract";
import {
  Config,
  Effect,
  type Layer,
  ManagedRuntime,
  Option,
  Predicate,
  Redacted,
  Schedule,
  Schema,
  Struct,
  flow,
} from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";
import { HttpApiClient } from "effect/http-api";

export const defaultBaseUrl = "https://api.telipot.com";

// What a client reads from the environment, as the CLI does: the token, and where to send it.
export const tokenConfig = Config.Redacted("TELIPOT_TOKEN");
export const baseUrlConfig = Config.schema(
  Schema.String.check(
    Schema.makeFilter((url: string) => URL.canParse(url) && /^https?:\/\//.test(url), {
      expected: "an http or https address",
    }),
  ),
  "TELIPOT_API_URL",
).pipe(Config.withDefault(defaultBaseUrl));

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

// A problem this client's contract does not list, such as a code a newer gateway added, with its
// `code`, `detail` and other members, such as a `connect_url`, kept.
export class UnknownProblem extends Schema.TaggedError<UnknownProblem>()("UnknownProblem", {
  status: Schema.Int,
  code: Schema.String,
  detail: Schema.String,
  extensions: Schema.Record(Schema.String, Schema.Json),
  cause: Schema.Defect(),
}) {
  override get message() {
    return this.detail;
  }
}

const isProblem = Schema.is(ProblemDetails);

const problemOf = <E>(
  response: HttpClientResponse.HttpClientResponse,
  error: E,
): Effect.Effect<never, E | UnknownProblem> =>
  response.json.pipe(
    Effect.orElseSucceed(() => undefined),
    Effect.flatMap((body): Effect.Effect<never, E | UnknownProblem> =>
      isProblem(body)
        ? Effect.fail(
            new UnknownProblem({
              status: body.status,
              code: body.code,
              detail: body.detail,
              extensions: Struct.omit(body, ["type", "title", "status", "code", "detail"]),
              cause: error,
            }),
          )
        : Effect.fail(error),
    ),
  );

// The answer's body was read already, so reading it again here costs nothing.
const keepingProblems = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | UnknownProblem, R> =>
  effect.pipe(
    Effect.catch((error): Effect.Effect<never, E | UnknownProblem> =>
      HttpClientError.isHttpClientError(error) &&
      (error.reason._tag === "StatusCodeError" || error.reason._tag === "DecodeError")
        ? problemOf(error.reason.response, error)
        : Effect.fail(error),
    ),
  );

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
  const authorized = HttpClient.mapRequest(HttpClientRequest.bearerToken(token));
  const baseUrl = options.baseUrl ?? defaultBaseUrl;
  const client = yield* HttpApiClient.make(Api, { baseUrl, transformClient: authorized });
  // Only calls that change nothing are tried again. A run is not, keyed or not: the gateway keeps
  // only a success under a key, so a run tried after a vendor's 5xx runs at the vendor again.
  const reading = yield* HttpApiClient.make(Api, {
    baseUrl,
    transformClient: flow(
      authorized,
      HttpClient.retryTransient({
        times: 3,
        schedule: Schedule.exponential("200 millis").pipe(Schedule.jittered),
      }),
    ),
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
      keepingProblems(
        reading.discover.discover({ payload: request, headers: principalHeaders(call) }),
      ),

    inspect: (task: string, call: CallOptions = {}) =>
      keepingProblems(
        reading.tasks.inspect({ params: { id: task }, headers: principalHeaders(call) }),
      ),

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
    }, keepingProblems),

    // With no `as`, the principal is the end user a user-bound token is fixed to, from `/v1/me`,
    // or else the organization.
    connect: Effect.fnUntraced(function* (provider: string, { as, ...session }: ConnectOptions) {
      let principal = as ?? options.as;
      if (Predicate.isUndefined(principal)) {
        const { credential } = yield* reading.me();
        principal = (credential._tag === "Token" ? credential.principal : null) ?? "organization";
      }

      return yield* client.connect.start({ payload: { ...session, provider, principal } });
    }, keepingProblems),

    // Its status, and while `consented` the account its consent was given on, to show the person
    // signed in before confirming them.
    session: (sessionId: string) =>
      keepingProblems(reading.connect.session({ params: { id: sessionId } })),

    // An end user's session connects nothing until the backend confirms whom it signed in, and
    // the account it showed them.
    confirm: (sessionId: string, confirmation: typeof ConnectConfirmation.Type) =>
      keepingProblems(client.connect.confirm({ params: { id: sessionId }, payload: confirmation })),

    // When the person signed in says the account is not theirs; nothing is kept.
    decline: (sessionId: string) =>
      keepingProblems(client.connect.decline({ params: { id: sessionId } })),
  };
});

export type Client = Effect.Success<ReturnType<typeof make>>;

// A call through the Promise facade may also take a signal, which interrupts it: the request is
// aborted and the promise rejects with the signal's reason. A run aborted after it was sent may
// still have run at the vendor.
export interface Abortable {
  readonly signal?: AbortSignal;
}

// The same as promises, for code that does not run Effect. A refused call rejects with the API's
// own tagged error, such as `PrincipalForbidden`, whose `detail` says why. `dispose`, or `await
// using`, releases what the `httpClient` layer holds.
export class Telipot implements AsyncDisposable {
  readonly #runtime: ManagedRuntime.ManagedRuntime<HttpClient.HttpClient, never>;
  readonly #client: Promise<Client>;

  constructor(
    options: ClientOptions & {
      // Where requests go out; `fetch` unless given. Built once, and kept until `dispose`.
      readonly httpClient?: Layer.Layer<HttpClient.HttpClient>;
    },
  ) {
    const { httpClient = FetchHttpClient.layer, ...client } = options;
    this.#runtime = ManagedRuntime.make(httpClient);
    // Started now and shared as a Promise, so no call waits on another's fiber.
    this.#client = this.#runtime.runPromise(make(client));
    // A failed start rejects every call instead; alone it is no unhandled rejection.
    this.#client.catch(() => undefined);
  }

  async #call<A, E>(use: (client: Client) => Effect.Effect<A, E>, signal?: AbortSignal) {
    const client = await this.#client;
    try {
      return await this.#runtime.runPromise(use(client), { signal });
    } catch (error) {
      throw signal?.aborted === true ? signal.reason : error;
    }
  }

  discover(request: Discover, { signal, ...call }: CallOptions & Abortable = {}) {
    return this.#call((client) => client.discover(request, call), signal);
  }

  inspect(task: string, { signal, ...call }: CallOptions & Abortable = {}) {
    return this.#call((client) => client.inspect(task, call), signal);
  }

  run(
    task: string,
    input: Readonly<Record<string, Schema.Json>> = {},
    { signal, ...call }: RunOptions & Abortable = {},
  ) {
    return this.#call((client) => client.run(task, input, call), signal);
  }

  connect(provider: string, { signal, ...session }: ConnectOptions & Abortable) {
    return this.#call((client) => client.connect(provider, session), signal);
  }

  session(sessionId: string, { signal }: Abortable = {}) {
    return this.#call((client) => client.session(sessionId), signal);
  }

  confirm(
    sessionId: string,
    confirmation: typeof ConnectConfirmation.Type,
    { signal }: Abortable = {},
  ) {
    return this.#call((client) => client.confirm(sessionId, confirmation), signal);
  }

  decline(sessionId: string, { signal }: Abortable = {}) {
    return this.#call((client) => client.decline(sessionId), signal);
  }

  dispose() {
    return this.#runtime.dispose();
  }

  [Symbol.asyncDispose]() {
    return this.dispose();
  }
}
