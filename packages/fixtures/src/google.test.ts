import { BunServices } from "@effect/platform-bun";
import { assert, layer } from "@effect/vitest";
import { ConsentRefused, Google, type GoogleAccount } from "@telipot/fixtures/google";
import { Crypto, Effect, Layer, Predicate, Schema } from "effect";
import { Base64, Base64Url } from "effect/encoding";
import { HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";

import type { VendorRoute } from "./vendors";

const callback = "https://connect.telipot.com/callback/google-calendar";
const verifier = "a-code-verifier-long-enough-for-pkce-0123456789";
const calendarScope = "https://www.googleapis.com/auth/calendar.readonly";

// The calendar's example belongs to `contact@example.com`, so each account's differs.
const route = (task: string, url: string, scopes: ReadonlyArray<string>, example: Schema.Json) =>
  ({
    task,
    method: "GET",
    url,
    fields: {},
    check: () => [],
    example,
    scopes,
  }) satisfies VendorRoute;

const calendarFields = new Set(["calendarId", "maxResults"]);
const routes = [
  {
    ...route(
      "google-calendar.events.list",
      "https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events",
      [calendarScope],
      { items: [{ summary: "Planning", organizer: { email: "contact@example.com" } }] },
    ),
    fields: {
      calendarId: { in: "pathParams", type: "string" },
      maxResults: { in: "queryParams", type: "integer" },
    },
    check: (input: Readonly<Record<string, unknown>>) =>
      Object.keys(input)
        .filter((name) => !calendarFields.has(name))
        .map((name) => `${name} is not an input field`),
  },
  route(
    "google-search-console.sites.list",
    "https://searchconsole.googleapis.com/webmasters/v3/sites",
    ["https://www.googleapis.com/auth/webmasters.readonly"],
    { siteEntry: [] },
  ),
  route(
    "google-calendar.userinfo.get",
    "https://openidconnect.googleapis.com/v1/userinfo",
    ["openid", "email"],
    { sub: "110000000000000000001", email: "contact@example.com" },
  ),
] satisfies ReadonlyArray<VendorRoute>;

const telipot = { id: "telipot", secret: "telipot-secret" };
const another = { id: "acme-own-app", secret: "acme-secret" };
const globex = { id: "globex-own-app", secret: "globex-secret" };
const googleShaped = { id: "1234-abc.apps.googleusercontent.com", secret: "s3cr:et" };
// Registered as Google would never let them be, so only the rule under test refuses each.
const loose = {
  id: "loose",
  secret: "loose-secret",
  redirectUris: [
    "http://connect.example.com/callback",
    "http://localhost:3000/callback",
    "https://connect.example.com/callback#done",
  ],
};

const GoogleLive = Google.layer({
  routes,
  authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  revocationUrl: "https://oauth2.googleapis.com/revoke",
  clients: [
    ...[telipot, another, globex, googleShaped].map((client) => ({
      ...client,
      redirectUris: [callback],
    })),
    loose,
  ],
});

const authorizationUrl = (challenge: string, asked: Record<string, string> = {}) => {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: telipot.id,
    redirect_uri: callback,
    scope: calendarScope,
    state: "signed-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...asked,
  }).toString();

  return url.href;
};

const challengeOf = Effect.fnUntraced(function* (codeVerifier: string) {
  const crypto = yield* Crypto.Crypto;
  return Base64Url.encode(yield* crypto.digest("SHA-256", new TextEncoder().encode(codeVerifier)));
});

const codeFor = Effect.fnUntraced(function* (
  account: GoogleAccount,
  asked: Record<string, string> = {},
) {
  const google = yield* Google;
  const back = new URL(
    yield* google.consent(authorizationUrl(yield* challengeOf(verifier), asked), account),
  );

  assert.strictEqual(`${back.origin}${back.pathname}`, callback);
  assert.strictEqual(back.searchParams.get("state"), "signed-state");
  return back.searchParams.get("code") ?? "";
});

interface Exchange {
  readonly codeVerifier?: string;
  readonly redirectUri?: string;
  readonly client?: { readonly id: string; readonly secret: string } | undefined;
  readonly basic?: boolean;
}

const exchange = Effect.fnUntraced(function* (code: string, options: Exchange = {}) {
  const { client } = yield* Google;
  const { id, secret } = ("client" in options ? options.client : telipot) ?? {};
  const inBody = !options.basic && id && secret ? { client_id: id, client_secret: secret } : {};
  const request = HttpClientRequest.post("https://oauth2.googleapis.com/token").pipe(
    HttpClientRequest.bodyUrlParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: options.redirectUri ?? callback,
      code_verifier: options.codeVerifier ?? verifier,
      ...inBody,
    }),
  );

  return yield* client.execute(
    options.basic && id && secret
      ? HttpClientRequest.setHeader(
          request,
          "authorization",
          `Basic ${Base64.encode(`${formEncoded(id)}:${formEncoded(secret)}`)}`,
        )
      : request,
  );
});

// RFC 6749's encoding of Basic credentials, strict as oauth4webapi applies it.
const formEncoded = (text: string) =>
  encodeURIComponent(text).replace(
    /[-_.!~*'()]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const Tokens = Schema.Struct({ access_token: Schema.String, scope: Schema.String });

const tokenFor = Effect.fnUntraced(function* (
  account: GoogleAccount,
  asked: Record<string, string> = {},
) {
  const response = yield* exchange(yield* codeFor(account, asked));
  assert.strictEqual(response.status, 200);
  return (yield* HttpClientResponse.schemaBodyJson(Tokens)(response)).access_token;
});

const call = Effect.fnUntraced(function* (url: string, token?: string) {
  const { client } = yield* Google;
  return yield* client.get(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
});

const events = (token?: string) =>
  call("https://www.googleapis.com/calendar/v3/calendars/primary/events", token);

const Offline = Schema.Struct({ access_token: Schema.String, refresh_token: Schema.String });
const Renewed = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optionalKey(Schema.String),
});

const offlineFor = Effect.fnUntraced(function* (account: GoogleAccount) {
  const response = yield* exchange(yield* codeFor(account, { access_type: "offline" }));
  assert.strictEqual(response.status, 200);
  return yield* HttpClientResponse.schemaBodyJson(Offline)(response);
});

const refreshOn = Effect.fnUntraced(function* (
  refreshToken: string,
  { id, secret }: { readonly id: string; readonly secret: string } = telipot,
) {
  const { client } = yield* Google;
  return yield* client.execute(
    HttpClientRequest.post("https://oauth2.googleapis.com/token").pipe(
      HttpClientRequest.bodyUrlParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: id,
        client_secret: secret,
      }),
    ),
  );
});

const renewedBy = Effect.fnUntraced(function* (refreshToken: string) {
  const response = yield* refreshOn(refreshToken);
  assert.strictEqual(response.status, 200);
  return yield* HttpClientResponse.schemaBodyJson(Renewed)(response);
});

const revoked = Effect.fnUntraced(function* (token: string) {
  const { client } = yield* Google;
  return yield* client.execute(
    HttpClientRequest.post("https://oauth2.googleapis.com/revoke").pipe(
      HttpClientRequest.bodyUrlParams({ token }),
    ),
  );
});

layer(Layer.provideMerge(GoogleLive, BunServices.layer))("the Google fixture", (it) => {
  it.effect("answers each account's own calendar on the token its consent issued", () =>
    Effect.gen(function* () {
      const google = yield* Google;
      const ana = yield* events(yield* tokenFor("ana"));
      const ben = yield* events(yield* tokenFor("ben"));

      assert.strictEqual(ana.status, 200);
      assert.deepStrictEqual(yield* ana.json, yield* google.events("ana"));
      assert.deepStrictEqual(yield* ben.json, yield* google.events("ben"));
      assert.notDeepEqual(yield* google.events("ana"), yield* google.events("ben"));
    }),
  );

  it.effect("spends a code on a client's first exchange of it, right or wrong", () =>
    Effect.gen(function* () {
      const code = yield* codeFor("ana");
      assert.strictEqual((yield* exchange(code)).status, 200);
      assert.strictEqual((yield* exchange(code)).status, 400);

      const guessed = yield* codeFor("ana");
      const wrong = { codeVerifier: "another-verifier-of-the-same-sort-0123456789" };
      assert.strictEqual((yield* exchange(guessed, wrong)).status, 400);
      assert.strictEqual((yield* exchange(guessed)).status, 400);
    }),
  );

  it.effect("refuses a code exchanged on another redirect_uri", () =>
    Effect.gen(function* () {
      const code = yield* codeFor("ana");
      const elsewhere = { redirectUri: "https://connect.telipot.com/callback/other" };
      assert.strictEqual((yield* exchange(code, elsewhere)).status, 400);
      assert.strictEqual((yield* exchange(code)).status, 400);
    }),
  );

  it.effect("refuses a code verifier outside RFC 7636's 43 to 128 characters", () =>
    Effect.gen(function* () {
      const google = yield* Google;
      for (const outside of ["short-verifier", "v".repeat(129)]) {
        const url = authorizationUrl(yield* challengeOf(outside));
        const code = new URL(yield* google.consent(url, "ana")).searchParams.get("code") ?? "";
        assert.strictEqual((yield* exchange(code, { codeVerifier: outside })).status, 400);
      }
    }),
  );

  it.effect("exchanges a code only for the client that asked, with a secret", () =>
    Effect.gen(function* () {
      const noClient = yield* exchange(yield* codeFor("ana"), { client: undefined });
      assert.strictEqual(noClient.status, 401);
      assert.deepStrictEqual(yield* noClient.json, { error: "invalid_client" });

      assert.strictEqual((yield* exchange(yield* codeFor("ana"), { client: another })).status, 400);

      assert.strictEqual((yield* exchange(yield* codeFor("ana"), { basic: true })).status, 200);
      const code = yield* codeFor("ana", { client_id: googleShaped.id });
      const encoded = yield* exchange(code, { client: googleShaped, basic: true });
      assert.strictEqual(encoded.status, 200);
    }),
  );

  it.effect("refuses one organization's client id on another organization's secret", () =>
    Effect.gen(function* () {
      const asked = { client_id: another.id };
      const crossed = { id: another.id, secret: globex.secret };
      for (const basic of [false, true]) {
        const refused = yield* exchange(yield* codeFor("ana", asked), { client: crossed, basic });
        assert.strictEqual(refused.status, 401, `basic: ${basic}`);
        assert.deepStrictEqual(yield* refused.json, { error: "invalid_client" });
      }

      const own = yield* exchange(yield* codeFor("ana", asked), { client: another });
      assert.strictEqual(own.status, 200);
    }),
  );

  it.effect("answers 401 invalid_client to an unknown client or a wrong secret", () =>
    Effect.gen(function* () {
      for (const client of [
        { id: telipot.id, secret: "not-its-secret" },
        { id: "a-stranger", secret: "any-secret" },
      ]) {
        for (const basic of [false, true]) {
          const refused = yield* exchange(yield* codeFor("ana"), { client, basic });
          assert.strictEqual(refused.status, 401, `${client.id}, basic: ${basic}`);
          assert.deepStrictEqual(yield* refused.json, { error: "invalid_client" });
        }
      }
    }),
  );

  it.effect(
    "refuses a client or redirect_uri it does not know, off https, or with a fragment",
    () =>
      Effect.gen(function* () {
        const google = yield* Google;
        const challenge = yield* challengeOf(verifier);
        const asLoose = (redirect_uri: string) =>
          authorizationUrl(challenge, { client_id: loose.id, redirect_uri });

        const refusals = [
          authorizationUrl(challenge, { client_id: "a-stranger" }),
          authorizationUrl(challenge, { redirect_uri: `${callback}-elsewhere` }),
          asLoose("http://connect.example.com/callback"),
          asLoose("https://connect.example.com/callback#done"),
        ];

        for (const url of refusals) {
          const error = yield* Effect.flip(google.consent(url, "ana"));
          assert.instanceOf(error, ConsentRefused, url);
        }

        const loopback = new URL(
          yield* google.consent(asLoose("http://localhost:3000/callback"), "ana"),
        );

        assert.strictEqual(
          `${loopback.origin}${loopback.pathname}`,
          "http://localhost:3000/callback",
        );
      }),
  );

  it.effect("confirms scopes as Google names them, leaving out any the person unticked", () =>
    Effect.gen(function* () {
      const google = yield* Google;
      const userinfo = "https://www.googleapis.com/auth/userinfo.email";
      const asked = authorizationUrl(yield* challengeOf(verifier), {
        scope: `openid email ${calendarScope}`,
      });

      const back = new URL(yield* google.consent(asked, "ana"));
      assert.strictEqual(back.searchParams.get("scope"), `openid ${userinfo} ${calendarScope}`);
      const tokens = yield* exchange(back.searchParams.get("code") ?? "");
      assert.strictEqual(
        (yield* HttpClientResponse.schemaBodyJson(Tokens)(tokens)).scope,
        `openid ${userinfo} ${calendarScope}`,
      );

      const unticked = new URL(yield* google.consent(asked, "ana", { untick: [calendarScope] }));
      assert.strictEqual(unticked.searchParams.get("scope"), `openid ${userinfo}`);
      const narrow = yield* exchange(unticked.searchParams.get("code") ?? "");
      const { access_token, scope } = yield* HttpClientResponse.schemaBodyJson(Tokens)(narrow);
      assert.strictEqual(scope, `openid ${userinfo}`);
      assert.strictEqual((yield* events(access_token)).status, 403);
    }),
  );

  it.effect("sends the person back with access_denied and the state when they refuse", () =>
    Effect.gen(function* () {
      const google = yield* Google;
      const url = authorizationUrl(yield* challengeOf(verifier));
      const back = new URL(yield* google.consent(url, "ana", { refuse: true }));
      assert.strictEqual(`${back.origin}${back.pathname}`, callback);
      assert.deepStrictEqual(Object.fromEntries(back.searchParams), {
        error: "access_denied",
        state: "signed-state",
      });
    }),
  );

  it.effect("refuses a client without its secret, and a grant other than a code", () =>
    Effect.gen(function* () {
      const { client } = yield* Google;
      const token = (body: Record<string, string>, authorization?: string) => {
        const request = HttpClientRequest.post("https://oauth2.googleapis.com/token").pipe(
          HttpClientRequest.bodyUrlParams({
            redirect_uri: callback,
            code_verifier: verifier,
            grant_type: "authorization_code",
            ...body,
          }),
        );

        return client.execute(
          Predicate.isUndefined(authorization)
            ? request
            : HttpClientRequest.setHeader(request, "authorization", authorization),
        );
      };

      const inBody = { client_id: telipot.id, client_secret: telipot.secret };

      const noSecret = yield* token({ code: yield* codeFor("ana"), client_id: telipot.id });
      assert.strictEqual(noSecret.status, 401);
      const emptySecret = `Basic ${Base64.encode(`${telipot.id}:`)}`;
      assert.strictEqual((yield* token({ code: yield* codeFor("ana") }, emptySecret)).status, 401);
      // Valid body credentials must not rescue an unreadable Basic header.
      const unreadable = yield* token(
        { code: yield* codeFor("ana"), ...inBody },
        "Basic not-base64!",
      );

      assert.strictEqual(unreadable.status, 401);

      const code = yield* codeFor("ana");
      const password = yield* token({ code, ...inBody, grant_type: "password" });
      assert.strictEqual(password.status, 400);
      assert.strictEqual((yield* exchange(code)).status, 400);
    }),
  );

  it.effect("answers 400 to a call whose input does not fit its task", () =>
    Effect.gen(function* () {
      const token = yield* tokenFor("ana");
      const url = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
      assert.strictEqual((yield* call(`${url}?maxResults=5`, token)).status, 200);
      const refused = yield* call(`${url}?pageSize=5`, token);
      assert.strictEqual(refused.status, 400);
      assert.include(JSON.stringify(yield* refused.json), "pageSize is not an input field");
    }),
  );

  it.effect("answers 401 to a call without a token it issued", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* events()).status, 401);
      assert.strictEqual((yield* events("ya29.made-up")).status, 401);
    }),
  );

  it.effect("answers 403 to a token without every scope the task requires", () =>
    Effect.gen(function* () {
      const sites = "https://searchconsole.googleapis.com/webmasters/v3/sites";
      assert.strictEqual((yield* call(sites, yield* tokenFor("ana"))).status, 403);

      const userinfo = "https://openidconnect.googleapis.com/v1/userinfo";
      const openid = yield* tokenFor("owner", { scope: "openid" });
      assert.strictEqual((yield* call(userinfo, openid)).status, 403);
      const both = yield* tokenFor("owner", { scope: "openid email" });
      assert.strictEqual((yield* call(userinfo, both)).status, 200);
    }),
  );

  it.effect("refuses an authorization request Google would refuse", () =>
    Effect.gen(function* () {
      const google = yield* Google;
      const challenge = yield* challengeOf(verifier);
      const refusals: ReadonlyArray<string> = [
        authorizationUrl(challenge, { code_challenge: "" }),
        authorizationUrl(challenge, { code_challenge_method: "plain" }),
        authorizationUrl(challenge, { response_type: "token" }),
        authorizationUrl(challenge, { state: "" }),
        authorizationUrl(challenge, { redirect_uri: "not a url" }),
        authorizationUrl(challenge).replace("accounts.google.com", "accounts.example.com"),
        "not a url",
      ];

      for (const url of refusals) {
        const error = yield* Effect.flip(google.consent(url, "ana"));
        assert.instanceOf(error, ConsentRefused, url);
      }
    }),
  );

  it.effect("issues a refresh token only when access_type=offline is asked", () =>
    Effect.gen(function* () {
      const online = yield* exchange(yield* codeFor("ana"));
      assert.notProperty(yield* online.json, "refresh_token");
      const offline = yield* exchange(yield* codeFor("ana", { access_type: "offline" }));
      assert.isString((yield* HttpClientResponse.schemaBodyJson(Offline)(offline)).refresh_token);
    }),
  );

  it.effect("refreshes an expired access token for the client the grant was issued to", () =>
    Effect.gen(function* () {
      const google = yield* Google;
      const { access_token, refresh_token } = yield* offlineFor("ana");
      yield* TestClock.adjust("1 hour");
      assert.strictEqual((yield* events(access_token)).status, 401);

      assert.strictEqual((yield* refreshOn(refresh_token, another)).status, 400);
      const before = yield* google.refreshes;
      const renewed = yield* renewedBy(refresh_token);
      assert.strictEqual(yield* google.refreshes, before + 1);
      assert.isUndefined(renewed.refresh_token);
      assert.strictEqual((yield* events(renewed.access_token)).status, 200);
      // Google keeps the refresh token.
      assert.strictEqual((yield* refreshOn(refresh_token)).status, 200);
    }),
  );

  it.effect("rotates when told, honouring the replaced token until the new one is used", () =>
    Effect.gen(function* () {
      const google = yield* Google;
      const { refresh_token: first } = yield* offlineFor("ana");
      yield* google.rotate("on");
      const second = (yield* renewedBy(first)).refresh_token ?? "";
      assert.notStrictEqual(second, first);
      // The answer carrying `second` may have been lost, so `first` still works once.
      const third = (yield* renewedBy(first)).refresh_token ?? "";
      yield* renewedBy(third);
      assert.strictEqual((yield* refreshOn(first)).status, 400);

      yield* google.rotate("forgotten");
      const { refresh_token: kept } = yield* offlineFor("ben");
      const lost = (yield* renewedBy(kept)).refresh_token ?? "";
      assert.strictEqual((yield* refreshOn(lost)).status, 400);
      assert.strictEqual((yield* refreshOn(kept)).status, 200);
      yield* google.rotate("off");
    }),
  );

  it.effect("ends a grant on its revocation, by either token, and when the person removes it", () =>
    Effect.gen(function* () {
      const google = yield* Google;
      const before = (yield* google.revocations).length;
      for (const which of ["access_token", "refresh_token"] as const) {
        const tokens = yield* offlineFor("ana");
        assert.strictEqual((yield* revoked(tokens[which])).status, 200);
        assert.strictEqual((yield* events(tokens.access_token)).status, 401);
        assert.strictEqual((yield* refreshOn(tokens.refresh_token)).status, 400);
        assert.strictEqual((yield* revoked(tokens[which])).status, 400);
      }

      assert.deepStrictEqual((yield* google.revocations).slice(before), ["ana", "ana"]);

      const ben = yield* offlineFor("ben");
      const ana = yield* offlineFor("ana");
      yield* google.revokeAccess("ben");
      assert.strictEqual((yield* refreshOn(ben.refresh_token)).status, 400);
      assert.strictEqual((yield* refreshOn(ana.refresh_token)).status, 200);
    }),
  );

  it.effect("ends the grant a code issued when the code is replayed", () =>
    Effect.gen(function* () {
      const code = yield* codeFor("ana", { access_type: "offline" });
      const { access_token, refresh_token } = yield* HttpClientResponse.schemaBodyJson(Offline)(
        yield* exchange(code),
      );

      assert.strictEqual((yield* exchange(code)).status, 400);
      assert.strictEqual((yield* events(access_token)).status, 401);
      assert.strictEqual((yield* refreshOn(refresh_token)).status, 400);
    }),
  );

  it.effect("fails as a transport error on a route it does not fake", () =>
    Effect.gen(function* () {
      const { client } = yield* Google;
      const unfaked = [
        HttpClientRequest.get("https://api.example.com/anything"),
        HttpClientRequest.get("https://www.googleapis.com/calendar/v3/nope"),
        HttpClientRequest.delete("https://www.googleapis.com/calendar/v3/calendars/primary/events"),
      ];

      for (const request of unfaked) {
        const error = yield* Effect.flip(client.execute(request));
        assert.instanceOf(error.reason, HttpClientError.TransportError, request.url);
      }
    }),
  );
});
