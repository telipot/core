import { BunServices } from "@effect/platform-bun";
import { assert, layer } from "@effect/vitest";
import { Catalog } from "./catalog";
import type { Entry } from "./rules";
import { catalogFixtures } from "@telipot/fixtures/catalog";
import { Effect, Predicate, Result } from "effect";

import { bind, sentForms, valueAt, withoutCredential } from "./bind";

const bindOrThrow = (...args: Parameters<typeof bind>) => Result.getOrThrow(bind(...args));

const entries = Catalog.validate(catalogFixtures.verify).pipe(
  Effect.map(({ tasks }) => (id: string) => {
    const entry = tasks.find(({ task }) => task.id === id);
    if (Predicate.isUndefined(entry)) throw new Error(`${id} is not in the fixture`);
    return entry;
  }),
);

const replayOf = ({ task }: Entry) => {
  const { pathParams, queryParams, headers, body } = task.test_request ?? {};
  return { ...pathParams, ...queryParams, ...headers, ...body };
};

const credentialed = (entry: Entry, scheme: object): Entry => ({
  ...entry,
  access: { _tag: "Credentialed", scheme: scheme as never, principal: "organization" },
});

layer(BunServices.layer)("bind", (it) => {
  it.effect("puts a public task's input on the base URL and no credential", () =>
    Effect.gen(function* () {
      const entry = (yield* entries)("vendor.page.text");
      assert.deepStrictEqual(bindOrThrow(entry, replayOf(entry), undefined), {
        method: "GET",
        url: "http://vendor.test/v1/page",
        params: [["url", "https://example.com"]],
        headers: {},
      });
    }),
  );

  it.effect("puts a task on the host its entry names, the task's own before its provider's", () =>
    Effect.gen(function* () {
      const entry = (yield* entries)("vendor.page.text");
      const other = { ...entry, baseUrl: "http://other.test/v2" };
      assert.strictEqual(
        bindOrThrow(other, replayOf(entry), undefined).url,
        "http://other.test/v2/page",
      );
    }),
  );

  it.effect("names every form a credential is sent in, its scheme's encoding included", () =>
    Effect.gen(function* () {
      const entry = (yield* entries)("vendor.keywords.volume");
      assert.deepStrictEqual(sentForms(entry, "k-1"), ["k-1"]);
      // A query value travels form-encoded, and a vendor may echo it percent-encoded.
      assert.deepStrictEqual(sentForms(entry, "a b+"), ["a b+", "a+b%2B", "a%20b%2B"]);
      const basic = credentialed(entry, { type: "api_key", in: "basic" });
      assert.deepStrictEqual(sentForms(basic, "k-1"), ["k-1", btoa("k-1:")]);
      const bearer = credentialed(entry, { type: "bearer" });
      assert.deepStrictEqual(sentForms(bearer, "k-1"), ["k-1"]);
    }),
  );

  it.effect("masks a basic pair's password on its own, as a vendor may echo it alone", () =>
    Effect.gen(function* () {
      const pair = credentialed((yield* entries)("vendor.keywords.volume"), { type: "basic" });
      const credential = "ben@acme.example:correct horse";
      assert.include(sentForms(pair, credential), "correct horse");
      assert.deepStrictEqual(
        withoutCredential(
          pair,
          credential,
          { error: "Rejected password correct horse for ben@acme.example" },
          { failure: true },
        ),
        { error: "Rejected password *** for ben@acme.example" },
      );

      // A pair with no password sends nothing beyond the whole credential to mask.
      assert.deepStrictEqual(sentForms(pair, "ben:"), ["ben:", btoa("ben:")]);
      // A short password masked anywhere would rewrite the answer, so only a value that is the
      // whole password is masked.
      const answer = { accountId: "tr_ben", labels: ["tab", "lab"], count: 1, name: "Ben" };
      for (const short of ["a", "ab", "1", "e"]) {
        assert.deepStrictEqual(
          withoutCredential(pair, `ben@acme.example:${short}`, answer, { failure: false }),
          answer,
          short,
        );
      }

      assert.deepStrictEqual(
        withoutCredential(
          pair,
          "ben@acme.example:pin1",
          { echoed: "pin1", sent: ["pin1"], note: "pin10" },
          { failure: false },
        ),
        { echoed: "***", sent: ["***"], note: "pin10" },
      );
    }),
  );

  it.effect("sends a basic pair as UTF-8, as RFC 7617 asks, whatever characters it holds", () =>
    Effect.gen(function* () {
      const entry = (yield* entries)("vendor.keywords.volume");
      const pair = credentialed(entry, { type: "basic" });
      const credential = "bén@acme.example:pässwörd €";
      const utf8 = Buffer.from(credential, "utf8").toString("base64");
      assert.strictEqual(
        bindOrThrow(pair, replayOf(entry), credential).headers.authorization,
        `Basic ${utf8}`,
      );

      assert.include(sentForms(pair, credential), utf8);
    }),
  );

  it.effect("injects an api key into the query, a header, basic auth or a bearer header", () =>
    Effect.gen(function* () {
      const entry = (yield* entries)("vendor.keywords.volume");
      const input = replayOf(entry);
      assert.deepStrictEqual(bindOrThrow(entry, input, "k-1").params, [
        ["phrase", "openrouter"],
        ["limit", "1"],
        ["key", "k-1"],
      ]);

      const header = bindOrThrow(
        credentialed(entry, { type: "api_key", in: "header", name: "X-API-Key" }),
        input,
        "k-1",
      );

      assert.deepStrictEqual(header.headers, { "x-api-key": "k-1" });
      assert.deepStrictEqual(header.params, [
        ["phrase", "openrouter"],
        ["limit", "1"],
      ]);

      const basic = bindOrThrow(
        credentialed(entry, { type: "api_key", in: "basic", name: "key" }),
        input,
        "k-1",
      );

      assert.deepStrictEqual(basic.headers, { authorization: `Basic ${btoa("k-1:")}` });

      const bearer = bindOrThrow(credentialed(entry, { type: "bearer" }), input, "k-1");
      assert.deepStrictEqual(bearer.headers, { authorization: "Bearer k-1" });

      const oauth = bindOrThrow(credentialed(entry, { type: "oauth2" }), input, "ya29.t");
      assert.deepStrictEqual(oauth.headers, { authorization: "Bearer ya29.t" });

      const pair = bindOrThrow(credentialed(entry, { type: "basic" }), input, "ana:pw");
      assert.deepStrictEqual(pair.headers, { authorization: `Basic ${btoa("ana:pw")}` });
    }),
  );

  it.effect("sends a JSON body, or a form, as the task's bodyType says", () =>
    Effect.gen(function* () {
      const get = yield* entries;
      const overview = get("vendor.domain.overview");
      assert.deepStrictEqual(bindOrThrow(overview, replayOf(overview), "k").body, {
        json: { domain: "example.com" },
      });

      const search = get("vendor.keywords.search");
      assert.deepStrictEqual(bindOrThrow(search, replayOf(search), "k").body, {
        form: [["prompt", "openrouter"]],
      });
    }),
  );

  it.effect("binds each field where the task declares it, whatever order the input has", () =>
    Effect.gen(function* () {
      const entry = (yield* entries)("vendor.keywords.volume");
      const bound = bindOrThrow(
        {
          ...entry,
          task: {
            // oxlint-disable-next-line typescript/no-misused-spread -- `bind` reads the task's fields only.
            ...entry.task,
            path: "/sites/{site}/keywords",
            input: {
              pathParams: { site: { type: "string", required: true } },
              queryParams: { tag: { type: "array" }, exact: { type: "boolean" } },
              headers: { "X-Trace": { type: "string" } },
            },
          },
        },
        { exact: true, "X-Trace": "t-1", tag: ["x", "y"], site: "sc-domain:a b/c" },
        "k",
      );

      assert.strictEqual(bound.url, "http://vendor.test/v1/sites/sc-domain%3Aa%20b%2Fc/keywords");
      assert.deepStrictEqual(bound.params, [
        ["tag", "x"],
        ["tag", "y"],
        ["exact", "true"],
        ["key", "k"],
      ]);

      assert.deepStrictEqual(bound.headers, { "x-trace": "t-1" });
      assert.isUndefined(bound.body);

      // Both lowercased, so a declared header and the credential's are one key each.
      const both = bindOrThrow(
        credentialed(
          {
            ...entry,
            // oxlint-disable-next-line typescript/no-misused-spread -- `bind` reads the task's fields only.
            task: { ...entry.task, input: { headers: { "X-Trace": { type: "string" } } } },
          },
          { type: "api_key", in: "header", name: "X-API-Key" },
        ),
        { "X-Trace": "t-1" },
        "k",
      );

      assert.deepStrictEqual(both.headers, { "x-trace": "t-1", "x-api-key": "k" });
    }),
  );

  it.effect("refuses a path segment of only dots, which would move the call off its route", () =>
    Effect.gen(function* () {
      const entry = (yield* entries)("vendor.page.text");
      const at = (path: string): Entry => ({
        ...entry,
        task: {
          // oxlint-disable-next-line typescript/no-misused-spread -- `bind` reads the task's fields only.
          ...entry.task,
          path,
          input: { pathParams: { a: { type: "string" }, b: { type: "string" } } },
        },
      });

      // A URL resolves `/sites/..` to `/`, and the credential would go with it.
      for (const [path, input, named] of [
        ["/sites/{a}", { a: ".." }, "a"],
        ["/sites/{a}", { a: "." }, "a"],
        ["/sites/{a}/{b}", { a: "..", b: "x" }, "a"],
        ["/sites/{a}/{b}", { a: "..", b: ".." }, "a, b"],
        ["/files/{a}.{b}", { a: "", b: "" }, "a, b"],
        // A URL reads `%2e` as a dot, so a path's own `%2e` counts as one.
        ["/files/{a}%2E", { a: "." }, "a"],
      ] as const) {
        const said = Result.match(bind(at(path), input, "k"), {
          onFailure: ({ message }) => message,
          onSuccess: ({ url }) => `sent to ${url}`,
        });

        assert.strictEqual(
          said,
          `vendor.page.text: ${named} cannot make a path segment of only dots`,
          path,
        );
      }

      // Dots beside other text, or percent-encoded, stay in their segment.
      for (const value of ["a..b", "v1.2", "...a", "%2e%2e"]) {
        assert.strictEqual(
          bindOrThrow(at("/sites/{a}"), { a: value }, "k").url,
          `http://vendor.test/v1/sites/${encodeURIComponent(value)}`,
        );
      }
    }),
  );

  it.effect("masks every form of the credential an answer echoes, and in a failure its place", () =>
    Effect.gen(function* () {
      const entry = (yield* entries)("vendor.keywords.volume");
      assert.deepStrictEqual(
        withoutCredential(
          entry,
          "a b+",
          {
            url: "https://vendor.test/v1?phrase=x&key=a+b%2B",
            sent: ["a b+", "a%20b%2B"],
            key: "anything",
            Key: { nested: true },
            "a b+": 1,
            count: 3,
          },
          { failure: true },
        ),
        {
          url: "https://vendor.test/v1?phrase=x&key=***",
          sent: ["***", "***"],
          key: "***",
          Key: "***",
          "***": 1,
          count: 3,
        },
      );

      const basic = credentialed(entry, { type: "api_key", in: "basic", name: "key" });
      assert.strictEqual(
        withoutCredential(basic, "k-1", `Authorization: Basic ${btoa("k-1:")}`, { failure: false }),
        "Authorization: Basic ***",
      );

      assert.deepStrictEqual(
        withoutCredential(basic, "k-1", { authorization: "Basic other" }, { failure: true }),
        { authorization: "***" },
      );

      // An answer's own field of that name is its data.
      assert.deepStrictEqual(
        withoutCredential(entry, "a b+", { key: "a b+ and more", Key: "kept" }, { failure: false }),
        { key: "*** and more", Key: "kept" },
      );

      // An all-digit key comes back as a JSON number too.
      assert.deepStrictEqual(
        withoutCredential(entry, "12345678", { echoed: [12345678], count: 3 }, { failure: false }),
        { echoed: ["***"], count: 3 },
      );

      // JSON escapes quotes, backslashes and control characters, so an echo is written differently
      // from the credential.
      const escaped = 'k"1\\2\n3';
      assert.deepStrictEqual(
        withoutCredential(
          entry,
          escaped,
          { echoed: `key ${escaped}`, count: 3 },
          { failure: false },
        ),
        { echoed: "key ***", count: 3 },
      );

      // An answer that echoes it only as a key, never as a value, is walked too.
      assert.deepStrictEqual(
        withoutCredential(entry, escaped, { [escaped]: 1, count: 3 }, { failure: false }),
        { "***": 1, count: 3 },
      );
    }),
  );
});

layer(BunServices.layer)("valueAt", (it) => {
  it.effect("follows keys and indexes, and finds nothing past a missing one", () =>
    Effect.sync(() => {
      const body = { statuses: [{ status: "success" }], ok: false };
      assert.strictEqual(valueAt(body, "statuses[0].status"), "success");
      assert.strictEqual(valueAt(body, "ok"), false);
      assert.isUndefined(valueAt(body, "statuses[1].status"));
      assert.isUndefined(valueAt(body, "constructor"));
    }),
  );
});
