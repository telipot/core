import { Api, cliClientId } from "@telipot/contract";
import { make } from "@telipot/sdk";
import { Console, Duration, Effect, Option, Predicate, Redacted, Schema } from "effect";
import { Argument, CliError, Command, Flag } from "effect/cli";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { HttpApiClient } from "effect/http-api";

import { plain } from "./capture";
import { rendering, vendorJson } from "./render";
import {
  apiUrl,
  environmentToken,
  forgetToken,
  loginToken,
  savedToken,
  saveToken,
} from "./signed-in";

// A refusal's `detail` says why, and its `connect_url`, when it has one, where to fix it.
const said = (error: unknown) => {
  if (Predicate.hasProperty(error, "detail") && Predicate.isString(error.detail)) {
    const link =
      Predicate.hasProperty(error, "connect_url") && Predicate.isString(error.connect_url)
        ? `\nOpen ${plain(error.connect_url)} to fix it, then run this again.`
        : "";

    return `${plain(error.detail)}${link}`;
  }

  if (Predicate.hasProperty(error, "_tag") && error._tag === "HttpClientError") {
    return "telipot could not be reached. Check TELIPOT_API_URL and your connection.";
  }

  return "telipot answered in a way this version of telipot does not read. Update it.";
};

// `Command.run` prints a UserError under ERROR and exits 1; the cause is kept for a debugger.
const toUserError = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.mapError(effect, (cause) =>
    cause instanceof CliError.UserError
      ? cause
      : new CliError.UserError({ cause, userMessage: said(cause) }),
  );

// A command run by a person runs whatever version is served unless they pin one.
const client = Effect.gen(function* () {
  return yield* make({ token: yield* savedToken, baseUrl: yield* apiUrl, latest: true });
});

const as = Flag.String("as").pipe(
  Flag.withDescription("Act as organization, or an end user as user:<id>"),
  Flag.optional,
);

const asOption = (principal: Option.Option<string>) =>
  Option.match(principal, { onNone: () => ({}), onSome: (named) => ({ as: named }) });

const discover = Command.make(
  "discover",
  {
    task: Argument.String("task").pipe(Argument.withDescription("The job, in a sentence")),
    as,
  },
  Effect.fnUntraced(function* ({ task, as: principal }) {
    const { discovered } = yield* rendering;
    const ms = yield* client;
    yield* Console.log(discovered(yield* ms.discover({ task }, asOption(principal))));
  }, toUserError),
).pipe(Command.withDescription("Find tasks for a job, described in a sentence"));

const inspect = Command.make(
  "inspect",
  {
    task: Argument.String("task").pipe(Argument.withDescription("A task id from discover")),
    as,
  },
  Effect.fnUntraced(function* ({ task, as: principal }) {
    const ms = yield* client;
    yield* Console.log(vendorJson(yield* ms.inspect(task, asOption(principal))));
  }, toUserError),
).pipe(Command.withDescription("Read a task's schema, price and identity without running it"));

const Input = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json));

const run = Command.make(
  "run",
  {
    task: Argument.String("task").pipe(Argument.withDescription("A task id from discover")),
    input: Flag.String("input-json").pipe(
      Flag.withDescription("The task's input, as a JSON object"),
      Flag.withDefault("{}"),
    ),
    quote: Flag.Boolean("quote").pipe(
      Flag.withDescription("Print the price and whose credential would pay, and run nothing"),
      Flag.withDefault(false),
    ),
    catalogVersion: Flag.String("catalog-version").pipe(
      Flag.withDescription("Run only if the provider is still served at this catalog version"),
      Flag.optional,
    ),
    as,
  },
  Effect.fnUntraced(function* ({ task, input, quote, catalogVersion, as: principal }) {
    const { quoted, ran } = yield* rendering;
    const ms = yield* client;
    if (quote) {
      return yield* Console.log(quoted(yield* ms.inspect(task, asOption(principal))));
    }

    const given = yield* Schema.decodeEffect(Input)(input).pipe(
      Effect.mapError(
        (cause) =>
          new CliError.UserError({ cause, userMessage: "--input-json takes a JSON object." }),
      ),
    );

    const { output, receipt } = yield* ms.run(task, given, {
      ...asOption(principal),
      ...Option.match(catalogVersion, {
        onNone: () => ({}),
        onSome: (version) => ({ version }),
      }),
    });

    yield* Console.log(vendorJson(output));
    yield* Console.error(ran(receipt));
  }, toUserError),
).pipe(Command.withDescription("Run a task, or price it with --quote"));

const connect = Command.make(
  "connect",
  {
    provider: Argument.String("provider").pipe(Argument.withDescription("The provider's slug")),
    as,
    redirectUri: Flag.String("redirect-uri").pipe(
      Flag.withDescription("Where the person lands once connected; on your redirect allowlist"),
      Flag.withDefault("https://app.telipot.com"),
    ),
  },
  Effect.fnUntraced(function* ({ provider, as: principal, redirectUri }) {
    const { connectLink } = yield* rendering;
    const ms = yield* client;
    const session = yield* ms.connect(provider, {
      ...asOption(principal),
      redirect_uri: redirectUri,
    });

    yield* Console.log(connectLink(provider, session));
  }, toUserError),
).pipe(Command.withDescription("A link to connect an account on a provider"));

const DeviceCode = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri_complete: Schema.String,
  interval: Schema.Int,
});

const Issued = Schema.Struct({ access_token: Schema.String });
const Refused = Schema.Struct({
  error: Schema.String,
  error_description: Schema.optionalKey(Schema.String),
});

// RFC 8628 from the device's side: show the code, then ask for the token every `interval` seconds,
// five more after each `slow_down`, until the person approves or refuses it or it expires.
const login = Command.make(
  "login",
  {},
  Effect.fnUntraced(function* () {
    const { deviceCode, signedIn } = yield* rendering;
    const http = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest(HttpClientRequest.prependUrl(yield* apiUrl)),
    );

    const send = (path: string, body: Readonly<Record<string, string>>) =>
      http.execute(HttpClientRequest.post(path).pipe(HttpClientRequest.bodyJsonUnsafe(body)));

    const code = yield* send("/api/auth/device/code", { client_id: cliClientId }).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(DeviceCode)),
    );

    yield* Console.log(deviceCode(plain(code.verification_uri_complete), plain(code.user_code)));

    let interval = Duration.seconds(code.interval);
    while (true) {
      yield* Effect.sleep(interval);
      const answer = yield* send("/api/auth/device/token", {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: code.device_code,
        client_id: cliClientId,
      });

      if (answer.status === 200) {
        const { access_token } = yield* HttpClientResponse.schemaBodyJson(Issued)(answer);
        return yield* Console.log(signedIn(yield* saveToken(Redacted.make(access_token))));
      }

      if (answer.status >= 500) {
        return yield* new CliError.UserError({
          cause: undefined,
          userMessage: "telipot failed to issue the token. Run telipot login again.",
        });
      }

      const { error, error_description } =
        yield* HttpClientResponse.schemaBodyJson(Refused)(answer);

      if (error === "slow_down") interval = Duration.sum(interval, Duration.seconds(5));
      else if (error !== "authorization_pending") {
        return yield* new CliError.UserError({
          cause: undefined,
          userMessage: plain(error_description ?? `The sign-in ended: ${error}.`),
        });
      }
    }
  }, toUserError),
).pipe(Command.withDescription("Sign in with a code you approve in the browser"));

// The API's own routes on one token, for what the four verbs do not cover.
const accountOn = (token: Redacted.Redacted) =>
  Effect.flatMap(apiUrl, (baseUrl) =>
    HttpApiClient.make(Api, {
      baseUrl,
      transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
    }),
  );

const whoami = Command.make(
  "whoami",
  {},
  Effect.fnUntraced(function* () {
    const { signedInAs } = yield* rendering;
    const account = yield* accountOn(yield* savedToken);
    yield* Console.log(signedInAs(yield* account.me()));
  }, toUserError),
).pipe(Command.withDescription("The organization and principal the token signs in as"));

// A token in TELIPOT_TOKEN belongs to whoever set it, so only the one `telipot login` saved ends.
const logout = Command.make(
  "logout",
  {},
  Effect.fnUntraced(function* () {
    const { signedOut, notLoggedIn, environmentKept } = yield* rendering;
    const saved = yield* loginToken;
    if (Option.isNone(saved)) {
      yield* Console.log(notLoggedIn);
    } else {
      const account = yield* accountOn(saved.value.token);
      // A token that expired, or was revoked from the dashboard, has ended already.
      yield* account.tokens
        .revokeCurrent()
        .pipe(Effect.catchTag(["InvalidToken", "TokenNotFound"], () => Effect.void));

      yield* forgetToken(saved.value.file);
      yield* Console.log(signedOut(saved.value.file));
    }

    if (Option.isSome(yield* environmentToken)) yield* Console.log(environmentKept);
  }, toUserError),
).pipe(Command.withDescription("Revoke the token telipot login saved, and remove it"));

export const gatewayCommands = [login, logout, whoami, discover, inspect, run, connect] as const;
