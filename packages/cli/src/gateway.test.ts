import { BunServices } from "@effect/platform-bun";
import { assert, layer } from "@effect/vitest";
import { problemBody } from "@telipot/contract";
import { ConfigProvider, Effect, FileSystem, Layer, Predicate, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { saveToken } from "./signed-in";
import { telipot } from "./testing";

interface Answer {
  readonly status: number;
  readonly body?: unknown;
}

const refused = (status: 401 | 404, code: string): Answer => ({
  status,
  body: problemBody(status, code, `Refused with ${code}.`),
});

const revoked: Answer = { status: 204 };
const tokenNotFound = refused(404, "token_not_found");
const invalidToken = refused(401, "invalid_token");
const stillWorks: Answer = {
  status: 200,
  body: {
    organizationId: "org_acme",
    credential: {
      _tag: "Token",
      tokenId: "key_cli",
      debugCapture: false,
      backendOnly: false,
      principal: null,
    },
  },
};

// The gateway, outside this package: each route answers as given, and any other 404s.
const gateway = (answers: Readonly<Record<string, Answer>>) => {
  const sent: Array<string> = [];
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      const route = `${request.method} ${url.pathname}`;
      sent.push(`${route} ${request.headers.authorization}`);
      const { status, body } = answers[route] ?? refused(404, "route_not_found");

      return HttpClientResponse.fromWeb(
        request,
        new Response(Predicate.isUndefined(body) ? null : JSON.stringify(body), {
          status,
          headers: {
            "content-type": status < 400 ? "application/json" : "application/problem+json",
          },
        }),
      );
    }),
  );

  return { sent, layer: Layer.succeed(HttpClient.HttpClient, client) };
};

const loggedIn = Effect.fnUntraced(function* (env: Record<string, string> = {}) {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped();
  const all = { ...env, HOME: home };
  const file = yield* saveToken(Redacted.make("tlp_saved")).pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: all }))),
  );

  return { env: all, file };
});

const logout = (env: Record<string, string>, answers: Readonly<Record<string, Answer>>) => {
  const { sent, layer: world } = gateway(answers);
  return telipot(["logout"], { env }).pipe(
    Effect.map((printed) => ({ ...printed, sent })),
    Effect.provide(world),
  );
};

layer(BunServices.layer, { excludeTestServices: true })("telipot logout", (it) => {
  it.effect("revokes the saved token, then removes it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { env, file } = yield* loggedIn();
      assert.isTrue(yield* fs.exists(file));
      const { exitCode, stdout, stderr, sent } = yield* logout(env, {
        "DELETE /v1/tokens/current": revoked,
      });

      assert.strictEqual(exitCode, 0, stderr);
      assert.include(stdout, "Signed out");
      assert.deepStrictEqual(sent, ["DELETE /v1/tokens/current Bearer tlp_saved"]);
      assert.isFalse(yield* fs.exists(file));
    }),
  );

  it.effect("removes a token the gateway refuses already, since it has ended", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { env, file } = yield* loggedIn();
      assert.isTrue(yield* fs.exists(file));
      const { exitCode, stdout, stderr } = yield* logout(env, {
        "DELETE /v1/tokens/current": invalidToken,
      });

      assert.strictEqual(exitCode, 0, stderr);
      assert.include(stdout, "Signed out");
      assert.isFalse(yield* fs.exists(file));
    }),
  );

  // A gateway without DELETE /v1/tokens/current reads `current` as the id of a token it does not
  // hold, so its 404 says nothing about the saved one.
  it.effect("keeps a token the gateway did not revoke and still accepts, and says so", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { env, file } = yield* loggedIn();
      assert.isTrue(yield* fs.exists(file));
      const { exitCode, stdout, stderr, sent } = yield* logout(env, {
        "DELETE /v1/tokens/current": tokenNotFound,
        "GET /v1/me": stillWorks,
      });

      assert.strictEqual(exitCode, 1);
      assert.notInclude(stdout, "Signed out");
      assert.include(stderr, "telipot did not revoke the token, so it still works");
      assert.include(stderr, `${file} is kept`);
      assert.include(stderr, "API keys page (https://app.telipot.com/api-keys)");
      assert.deepStrictEqual(sent, [
        "DELETE /v1/tokens/current Bearer tlp_saved",
        "GET /v1/me Bearer tlp_saved",
      ]);

      assert.isTrue(yield* fs.exists(file));
    }),
  );

  it.effect("names no dashboard link for a gateway other than telipot's own", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { env, file } = yield* loggedIn({ TELIPOT_API_URL: "https://older.example" });
      assert.isTrue(yield* fs.exists(file));
      const { exitCode, stderr } = yield* logout(env, {
        "DELETE /v1/tokens/current": tokenNotFound,
        "GET /v1/me": stillWorks,
      });

      assert.strictEqual(exitCode, 1);
      assert.include(stderr, "Revoke it on the dashboard's API keys page, then");
      assert.notInclude(stderr, "app.telipot.com");
      assert.isTrue(yield* fs.exists(file));
    }),
  );

  it.effect("removes a token not found that the gateway then refuses, since it has ended", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { env, file } = yield* loggedIn();
      assert.isTrue(yield* fs.exists(file));
      const { exitCode, stdout, stderr } = yield* logout(env, {
        "DELETE /v1/tokens/current": tokenNotFound,
        "GET /v1/me": invalidToken,
      });

      assert.strictEqual(exitCode, 0, stderr);
      assert.include(stdout, "Signed out");
      assert.isFalse(yield* fs.exists(file));
    }),
  );
});

layer(BunServices.layer, { excludeTestServices: true })("telipot's own errors", (it) => {
  it.effect("names the setting that is wrong, rather than asking for an update", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      const { exitCode, stderr } = yield* telipot(["discover", "send an email"], {
        env: { HOME: home, TELIPOT_TOKEN: "tlp_x", TELIPOT_API_URL: "not an address" },
      }).pipe(Effect.provide(gateway({}).layer));

      assert.strictEqual(exitCode, 1);
      assert.include(stderr, "A setting is not right");
      assert.include(stderr, "TELIPOT_API_URL");
      assert.notInclude(stderr, "Update it");
    }),
  );
});
