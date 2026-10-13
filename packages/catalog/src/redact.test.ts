import { assert, describe, it } from "@effect/vitest";

import { contactIn, redact, scrubContact } from "./redact";

const details = [
  ["an email address", "ana.lopez@acme.io", "contact@example.com"],
  ["an email address", "write to bob@mail.example.com today", "write to contact@example.com today"],
  ["a phone number", "+44 20 7946 0958", "+1 555 0100"],
  ["a phone number", "(415) 555-0132", "+1 555 0100"],
  [
    "a LinkedIn profile",
    "https://www.linkedin.com/in/ana-lopez-1a2b3c/",
    "https://www.linkedin.com/in/example",
  ],
  ["a LinkedIn profile", "linkedin.com/in/ana", "https://www.linkedin.com/in/example"],
] as const;

describe("contact details", () => {
  it("finds each kind, and replaces it with its placeholder", () => {
    for (const [kind, text, scrubbed] of details) {
      assert.deepStrictEqual(contactIn(text), [kind], text);
      assert.strictEqual(scrubContact(text), scrubbed, text);
    }
  });

  it("finds nothing in what it wrote, so scan never flags what capture produces", () => {
    for (const [, text] of details) {
      assert.deepStrictEqual(contactIn(scrubContact(text)), [], text);
      assert.strictEqual(scrubContact(scrubContact(text)), scrubContact(text), text);
    }
  });

  it("leaves a placeholder, an address at example.com and what only looks like one", () => {
    const fine = [
      "contact@example.com",
      "ana@example.com",
      "+1 555 0100",
      "https://www.linkedin.com/in/example",
      "https://www.linkedin.com/company/acme",
      "2026-10-05",
      "1234567890123",
      "call +44 20 7946 0958 today",
    ];
    for (const text of fine) {
      assert.deepStrictEqual(contactIn(text), [], text);
      assert.strictEqual(scrubContact(text), text, text);
    }
  });

  it("names every kind a string holds", () => {
    assert.deepStrictEqual(contactIn("ana@acme.io and https://www.linkedin.com/in/ana"), [
      "an email address",
      "a LinkedIn profile",
    ]);
  });
});

describe("redact", () => {
  it("masks every value under a key that names a credential, at any depth", () => {
    assert.deepStrictEqual(
      redact({
        api_key: "k-1",
        nested: [{ access_token: "t-1", Authorization: "Bearer t-2" }],
        key: "k-2",
        private_key: "k-3",
        credential: "c-1",
        signature: "s-1",
        cookie: "c-2",
        keyword: "agents",
        secret: { anything: "inside" },
        page: 2,
      }),
      {
        api_key: "***",
        nested: [{ access_token: "***", Authorization: "***" }],
        key: "***",
        private_key: "***",
        credential: "***",
        signature: "***",
        cookie: "***",
        keyword: "agents",
        secret: "***",
        page: 2,
      },
    );
  });

  it("masks a camelCase key that ends in Key, and the short names for a secret", () => {
    assert.deepStrictEqual(
      redact({
        privateKey: "k-1",
        accessKey: "k-2",
        AccessKeyId: "k-3",
        access_key_id: "k-4",
        passphrase: "p-1",
        pwd: "p-2",
        jwt: "j-1",
        bearer: "b-1",
        sortkey: "name",
        monkey: "george",
      }),
      {
        privateKey: "***",
        accessKey: "***",
        AccessKeyId: "***",
        access_key_id: "***",
        passphrase: "***",
        pwd: "***",
        jwt: "***",
        bearer: "***",
        sortkey: "name",
        monkey: "george",
      },
    );
  });

  it("replaces a contact detail used as a key", () => {
    assert.deepStrictEqual(redact({ "ana.lopez@acme.io": "delivered", total: 1 }), {
      "contact@example.com": "delivered",
      total: 1,
    });
  });

  // A debug capture redacts a vendor's body on the server, so a long string
  // must not hold it up: a pattern that rescans from every character would.
  it("redacts a long run of word characters in linear time", () => {
    const long = "a".repeat(200_000);
    const started = performance.now();
    assert.strictEqual(redact(long), long);
    assert.isBelow(performance.now() - started, 500);
  });

  it("replaces a contact detail in any string with its placeholder, and keeps the rest", () => {
    assert.deepStrictEqual(
      redact({ to: "ana.lopez@acme.io", note: ["write to bob@mail.example.com"], ok: true }),
      { to: "contact@example.com", note: ["write to contact@example.com"], ok: true },
    );
    assert.strictEqual(redact("+44 20 7946 0958"), "+1 555 0100");
    assert.strictEqual(redact(null), null);
  });
});
