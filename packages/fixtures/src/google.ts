import { Clock, Context, Crypto, Duration, Effect, Layer, Predicate, Result, Schema } from "effect";
import { Base64, Base64Url } from "effect/encoding";
import { type HttpBody, HttpClient, type HttpClientRequest } from "effect/http";

import { type VendorRoute, json, notFaked, readInput, routing } from "./vendors";

// Catalog examples belong to `contact@example.com`; each account gets them as its own.
export const googleAccounts = Object.freeze({
  ana: { email: "ana@acme.example", sub: "110000000000000000101" },
  ben: { email: "ben@acme.example", sub: "110000000000000000102" },
  ops: { email: "ops@acme.example", sub: "110000000000000000103" },
  owner: { email: "owner@acme.example", sub: "110000000000000000104" },
  anaHome: { email: "ana@home.example", sub: "110000000000000000105" },
});

export type GoogleAccount = keyof typeof googleAccounts;

export class ConsentRefused extends Schema.TaggedError<ConsentRefused>()("ConsentRefused", {
  message: Schema.String,
}) {}

// An OAuth client registered with Google, with the only redirect URIs it may use.
export interface GoogleClient {
  readonly id: string;
  readonly secret: string;
  readonly redirectUris: ReadonlyArray<string>;
}

// What the person does on the consent screen. `untick` leaves out scopes, written as asked or as
// Google confirms them; `refuse` answers `access_denied`; `alsoConfirm` adds scopes not asked.
export interface Consent {
  readonly untick?: ReadonlyArray<string>;
  readonly refuse?: boolean;
  readonly alsoConfirm?: ReadonlyArray<string>;
}

interface Authorization {
  readonly clientId: string;
  readonly account: GoogleAccount;
  readonly scopes: ReadonlyArray<string>;
  readonly redirectUri: string;
  readonly challenge: string;
  // `access_type=offline`: the exchange issues a refresh token as well.
  readonly offline: boolean;
}

// A revocation ends every token of one consent.
interface Grant {
  readonly clientId: string;
  readonly account: GoogleAccount;
  readonly scopes: ReadonlyArray<string>;
}

// `off` keeps the refresh token; `on` issues a new one each refresh, honouring the old until the
// new is first used; `forgotten` issues one it never records, so it is refused and the old stays.
export type Rotation = "off" | "on" | "forgotten";

// Google confirms these short names by the scope they stand for.
const confirmedAs: Readonly<Record<string, string>> = {
  email: "https://www.googleapis.com/auth/userinfo.email",
  profile: "https://www.googleapis.com/auth/userinfo.profile",
};

const confirmed = (scope: string) =>
  Object.hasOwn(confirmedAs, scope) ? (confirmedAs[scope] ?? scope) : scope;

const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);

const UnknownFromJson = Schema.fromJsonString(Schema.Unknown);

const personalise = (example: string, account: GoogleAccount) =>
  example
    .replaceAll("contact@example.com", googleAccounts[account].email)
    .replaceAll("110000000000000000001", googleAccounts[account].sub);

const googleError = (
  request: HttpClientRequest.HttpClientRequest,
  status: 401 | 403,
  message: string,
) =>
  json(
    request,
    status,
    JSON.stringify({
      error: {
        code: status,
        message,
        status: status === 401 ? "UNAUTHENTICATED" : "PERMISSION_DENIED",
      },
    }),
  );

const codeVerifier = /^[A-Za-z0-9\-._~]{43,128}$/;

// RFC 6749 2.3.1: Basic carries id and secret form-urlencoded, split at the first colon.
const credentialsOf = (request: HttpClientRequest.HttpClientRequest, form: URLSearchParams) => {
  const header = request.headers.authorization ?? "";
  if (!/^basic /i.test(header)) {
    return { id: form.get("client_id"), secret: form.get("client_secret") };
  }

  // A Basic header Google cannot read is refused, never passed over for the body.
  const basic = /^basic (\S+)$/i.exec(header)?.[1];
  const decoded = Predicate.isUndefined(basic) ? undefined : Base64.decodeString(basic);
  if (Predicate.isUndefined(decoded) || Result.isFailure(decoded)) return undefined;

  const colon = decoded.success.indexOf(":");
  if (colon < 0) return undefined;
  const credentials = new URLSearchParams(
    `id=${decoded.success.slice(0, colon)}&secret=${decoded.success.slice(colon + 1)}`,
  );

  return { id: credentials.get("id"), secret: credentials.get("secret") };
};

const formOf = (body: HttpBody.HttpBody) => {
  switch (body._tag) {
    case "Uint8Array":
      return new URLSearchParams(new TextDecoder().decode(body.body));
    case "Raw":
      return Predicate.isString(body.body) || body.body instanceof URLSearchParams
        ? new URLSearchParams(body.body)
        : new URLSearchParams();
    case "Empty":
    case "FormData":
    case "Stream":
      return new URLSearchParams();
  }
};

export class Google extends Context.Service<
  Google,
  {
    readonly client: HttpClient.HttpClient;
    // Returns the `redirect_uri` with a code, the `state` and the scopes Google confirms.
    readonly consent: (
      authorizationUrl: string,
      account: GoogleAccount,
      choice?: Consent,
    ) => Effect.Effect<string, ConsentRefused>;
    readonly events: (account: GoogleAccount) => Effect.Effect<unknown>;
    readonly rotate: (rotation: Rotation) => Effect.Effect<void>;
    // The person removes the app from their Google account: every grant of theirs ends.
    readonly revokeAccess: (account: GoogleAccount) => Effect.Effect<void>;
    // Refresh grants answered with a new access token.
    readonly refreshes: Effect.Effect<number>;
    // The accounts whose grant the revocation endpoint ended, in order.
    readonly revocations: Effect.Effect<ReadonlyArray<GoogleAccount>>;
  }
>()("@telipot/fixtures/google/Google") {
  static readonly layer = (google: {
    readonly routes: ReadonlyArray<VendorRoute>;
    readonly authorizationUrl: string;
    readonly tokenUrl: string;
    readonly revocationUrl: string;
    readonly clients: ReadonlyArray<GoogleClient>;
  }) =>
    Layer.effect(
      Google,
      Effect.gen(function* () {
        const crypto = yield* Crypto.Crypto;
        const find = routing(google.routes);
        const authorizationEndpoint = google.authorizationUrl;
        const tokenEndpoint = google.tokenUrl;
        const revocationEndpoint = google.revocationUrl;
        const eventsRoute = google.routes.find(
          ({ task }) => task === "google-calendar.events.list",
        );

        // Codes and tokens are numbered in issue order, so a run is repeatable.
        let issued = 0;
        const next = (prefix: string) => `${prefix}${++issued}`;
        const codes = new Map<string, Authorization>();
        // A spent code names the grant it issued, which a replay of it ends (RFC 6749 4.1.2).
        const spent = new Map<string, Grant | undefined>();
        // An access token lasts an hour, as at Google, read on the caller's clock.
        const tokenSeconds = 3599;
        const tokens = new Map<string, { readonly grant: Grant; readonly expiresAt: number }>();
        // A refresh token a rotation issued names the one it replaces, until it is first used.
        const refreshTokens = new Map<string, { readonly grant: Grant; replaces?: string }>();
        let rotation: Rotation = "off";
        let refreshes = 0;
        const revocations: Array<GoogleAccount> = [];
        const clients = new Map(google.clients.map((client) => [client.id, client]));
        // Answers `openid` with an ID token a client checks by issuer, audience and expiry. Its
        // signature is the fixture's own, never checked.
        const issuer = new URL(google.authorizationUrl).origin;
        const segment = (value: object) =>
          Base64Url.encode(new TextEncoder().encode(JSON.stringify(value)));

        const idToken = (clientId: string, { account, scopes }: Authorization) => {
          // The real clock, not the caller's: oauth4webapi checks `exp` against it, and a test
          // clock still at 1970 would make every token expired.
          const issuedAt = Math.floor(Date.now() / 1000);
          const { sub, email } = googleAccounts[account];
          return [
            segment({ alg: "RS256", kid: "fixture", typ: "JWT" }),
            segment({
              iss: issuer,
              azp: clientId,
              aud: clientId,
              sub,
              ...(scopes.includes(confirmed("email")) ? { email, email_verified: true } : {}),
              iat: issuedAt,
              exp: issuedAt + tokenSeconds,
            }),
            Base64Url.encode(new TextEncoder().encode("fixture-signature")),
          ].join(".");
        };

        const consent = Effect.fnUntraced(function* (
          authorizationUrl: string,
          account: GoogleAccount,
          choice: Consent = {},
        ) {
          const refused = (message: string) => new ConsentRefused({ message });
          if (!URL.canParse(authorizationUrl)) {
            return yield* refused(`${authorizationUrl} is not a URL`);
          }

          const url = new URL(authorizationUrl);
          const asked = url.searchParams;
          if (`${url.origin}${url.pathname}` !== authorizationEndpoint) {
            return yield* refused(`${url.origin}${url.pathname} is not Google's consent screen`);
          }

          const missing = ["client_id", "redirect_uri", "scope", "state", "code_challenge"].filter(
            (name) => !asked.get(name),
          );

          if (missing.length > 0) {
            return yield* refused(`The authorization request has no ${missing.join(", ")}`);
          }

          if (
            asked.get("response_type") !== "code" ||
            asked.get("code_challenge_method") !== "S256"
          ) {
            return yield* refused("Google answers only response_type=code with S256 PKCE");
          }

          const clientId = asked.get("client_id") ?? "";
          const client = clients.get(clientId);
          if (Predicate.isUndefined(client)) {
            return yield* refused(`invalid_client: no OAuth client has the id ${clientId}`);
          }

          const redirectUri = asked.get("redirect_uri") ?? "";
          if (!URL.canParse(redirectUri)) {
            return yield* refused(`The redirect_uri ${redirectUri} is not a URL`);
          }

          const back = new URL(redirectUri);
          if (!client.redirectUris.includes(redirectUri)) {
            return yield* refused(
              `redirect_uri_mismatch: ${clientId} did not register ${redirectUri}`,
            );
          }

          if (back.protocol !== "https:" && !loopback.has(back.hostname)) {
            return yield* refused(`${redirectUri} is neither https nor on a loopback address`);
          }

          if (back.hash !== "") return yield* refused(`${redirectUri} has a fragment`);

          back.searchParams.set("state", asked.get("state") ?? "");
          if (choice.refuse === true) {
            back.searchParams.set("error", "access_denied");
            return back.href;
          }

          const unticked = new Set((choice.untick ?? []).map(confirmed));
          const scopes = [
            ...new Set(
              [...(asked.get("scope") ?? "").split(" "), ...(choice.alsoConfirm ?? [])].map(
                confirmed,
              ),
            ),
          ].filter((scope) => scope !== "" && !unticked.has(scope));

          const code = next("4/fixture-code-");
          codes.set(code, {
            clientId,
            account,
            scopes,
            redirectUri,
            challenge: asked.get("code_challenge") ?? "",
            offline: asked.get("access_type") === "offline",
          });

          back.searchParams.set("code", code);
          back.searchParams.set("scope", scopes.join(" "));
          return back.href;
        });

        const accessTokenFor = Effect.fnUntraced(function* (grant: Grant) {
          const accessToken = next("ya29.fixture-");
          tokens.set(accessToken, {
            grant,
            expiresAt:
              (yield* Clock.currentTimeMillis) + Duration.toMillis(Duration.seconds(tokenSeconds)),
          });

          return accessToken;
        });

        const refreshTokenFor = (grant: Grant, replaces?: string) => {
          const refreshToken = next("1//fixture-refresh-");
          refreshTokens.set(
            refreshToken,
            Predicate.isUndefined(replaces) ? { grant } : { grant, replaces },
          );

          return refreshToken;
        };

        const issue = (request: HttpClientRequest.HttpClientRequest, body: object) =>
          json(
            request,
            200,
            JSON.stringify({ ...body, expires_in: tokenSeconds, token_type: "Bearer" }),
          );

        const end = (grant: Grant) => {
          for (const [token, held] of tokens) if (held.grant === grant) tokens.delete(token);
          for (const [token, held] of refreshTokens) {
            if (held.grant === grant) refreshTokens.delete(token);
          }
        };

        const refresh = Effect.fnUntraced(function* (
          request: HttpClientRequest.HttpClientRequest,
          clientId: string,
          form: URLSearchParams,
        ) {
          const presented = form.get("refresh_token") ?? "";
          const held = refreshTokens.get(presented);
          if (Predicate.isUndefined(held) || held.grant.clientId !== clientId) {
            return json(request, 400, JSON.stringify({ error: "invalid_grant" }));
          }

          // Its first use retires the token it replaced.
          if (Predicate.isNotUndefined(held.replaces)) refreshTokens.delete(held.replaces);
          delete held.replaces;
          refreshes += 1;
          const { grant } = held;
          const rotated = {
            off: () => undefined,
            on: () => refreshTokenFor(grant, presented),
            forgotten: () => next("1//fixture-refresh-"),
          }[rotation]();

          return issue(request, {
            access_token: yield* accessTokenFor(grant),
            scope: grant.scopes.join(" "),
            ...(Predicate.isUndefined(rotated) ? {} : { refresh_token: rotated }),
          });
        });

        const token = Effect.fnUntraced(function* (request: HttpClientRequest.HttpClientRequest) {
          const form = formOf(request.body);
          const invalidGrant = json(request, 400, JSON.stringify({ error: "invalid_grant" }));
          const credentials = credentialsOf(request, form);
          const client = clients.get(credentials?.id ?? "");
          if (
            Predicate.isUndefined(client) ||
            !credentials?.secret ||
            credentials.secret !== client.secret
          ) {
            return json(request, 401, JSON.stringify({ error: "invalid_client" }));
          }

          const clientId = client.id;
          if (form.get("grant_type") === "refresh_token") {
            return yield* refresh(request, clientId, form);
          }

          // As at Google, a client's first exchange spends the code, right or wrong.
          const code = form.get("code") ?? "";
          if (spent.has(code)) {
            const issued = spent.get(code);
            if (Predicate.isNotUndefined(issued)) end(issued);
            return invalidGrant;
          }

          const authorization = codes.get(code);
          codes.delete(code);
          if (code !== "") spent.set(code, undefined);
          if (
            form.get("grant_type") !== "authorization_code" ||
            Predicate.isUndefined(authorization)
          ) {
            return invalidGrant;
          }

          const challenge = Base64Url.encode(
            yield* crypto
              .digest("SHA-256", new TextEncoder().encode(form.get("code_verifier") ?? ""))
              .pipe(Effect.orDie),
          );

          if (
            clientId !== authorization.clientId ||
            form.get("redirect_uri") !== authorization.redirectUri ||
            !codeVerifier.test(form.get("code_verifier") ?? "") ||
            challenge !== authorization.challenge
          ) {
            return invalidGrant;
          }

          const grant: Grant = {
            clientId,
            account: authorization.account,
            scopes: authorization.scopes,
          };

          spent.set(code, grant);
          return issue(request, {
            access_token: yield* accessTokenFor(grant),
            scope: authorization.scopes.join(" "),
            ...(authorization.offline ? { refresh_token: refreshTokenFor(grant) } : {}),
            ...(authorization.scopes.includes("openid")
              ? { id_token: idToken(clientId, authorization) }
              : {}),
          });
        });

        const revoke = (request: HttpClientRequest.HttpClientRequest) => {
          const presented = formOf(request.body).get("token") ?? "";
          const grant = (tokens.get(presented) ?? refreshTokens.get(presented))?.grant;
          if (Predicate.isUndefined(grant)) {
            return json(request, 400, JSON.stringify({ error: "invalid_token" }));
          }

          end(grant);
          revocations.push(grant.account);
          return json(request, 200, "{}");
        };

        const client = HttpClient.make((request, url) =>
          Effect.gen(function* () {
            const address = `${url.origin}${url.pathname}`;
            if (request.method === "POST" && address === tokenEndpoint) {
              return yield* token(request);
            }

            if (request.method === "POST" && address === revocationEndpoint) {
              return revoke(request);
            }

            const found = find(request, url);
            if (Predicate.isUndefined(found)) return yield* notFaked(request, "Google");
            const { route, path } = found;
            const bearer = /^Bearer (\S+)$/.exec(request.headers.authorization ?? "")?.[1] ?? "";
            const holder = tokens.get(bearer);
            if (
              Predicate.isUndefined(holder) ||
              (yield* Clock.currentTimeMillis) >= holder.expiresAt
            ) {
              return googleError(request, 401, "Request had invalid authentication credentials.");
            }

            const { grant } = holder;
            if (!route.scopes.every((scope) => grant.scopes.includes(confirmed(scope)))) {
              return googleError(request, 403, "Request had insufficient authentication scopes.");
            }

            const { problems } = readInput(route, request, url, path);
            if (problems.length > 0) {
              return json(
                request,
                400,
                JSON.stringify({
                  error: { code: 400, message: problems.join("; "), status: "INVALID_ARGUMENT" },
                }),
              );
            }

            return json(request, 200, personalise(JSON.stringify(route.example), grant.account));
          }),
        );

        return Google.of({
          client,
          consent,
          events: (account) =>
            Predicate.isUndefined(eventsRoute)
              ? Effect.die("The routes hold no google-calendar.events.list")
              : Schema.decodeEffect(UnknownFromJson)(
                  personalise(JSON.stringify(eventsRoute.example), account),
                ).pipe(Effect.orDie),
          rotate: (next) =>
            Effect.sync(() => {
              rotation = next;
            }),
          revokeAccess: (account) =>
            Effect.sync(() => {
              for (const { grant } of [...tokens.values(), ...refreshTokens.values()]) {
                if (grant.account === account) end(grant);
              }
            }),
          refreshes: Effect.sync(() => refreshes),
          revocations: Effect.sync(() => [...revocations]),
        });
      }),
    );
}
