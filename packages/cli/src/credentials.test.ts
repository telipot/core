import { BunServices } from "@effect/platform-bun";
import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, FileSystem, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { findCredentials } from "./credentials";
import { telipot } from "./testing";

// Each planted value is built from fragments, so this file holds no credential
// the scan could flag when it reads this very change.
const planted = {
  "a private key": `-----BEGIN ${"RSA"} PRIVATE KEY-----`,
  "an AWS access key id": `AKIA${"A1B2C3D4E5F6G7H8"}`,
  "a GitHub token": `ghp_${"a1B2".repeat(9)}`,
  "a Slack token": `xoxb-${"1234567890"}-${"abcdefghij"}`,
  "a secret key": `sk-${"proj".repeat(2)}${"Zx9".repeat(8)}`,
  "a telipot token": `tlp_${"Qx7f".repeat(6)}`,
  "a Firecrawl key": `fc-${"0123456789abcdef".repeat(2)}`,
  "a bearer token": `Authorization: Bearer ${"eyJhbGciOiJIUzI1NiJ9"}.${"abcDEF123456"}`,
  "a URL with a password": `https://ana:${"hunter2hunter2"}@db.acme.io/app`,
  "an assigned secret": `api_key: ${"k9X2mQ7vL4pR8sT1wZ3n"}`,
  "a key in a query string": `https://api.acme.io/v1/data?key=${"k9X2mQ7vL4pR8sT1wZ3n"}`,
};

const diff = (file: string, ...added: Array<string>) =>
  [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -10,0 +11,${added.length} @@`,
    ...added.map((line) => `+${line}`),
  ].join("\n");

describe("findCredentials", () => {
  it("flags a contact detail in an example, and only in an example", () => {
    const lines = [
      '  "email": "ana.lopez@acme.io",',
      '  "phone": "+44 20 7946 0958",',
      '  "profile": "https://www.linkedin.com/in/ana-lopez-1a2b3c/",',
    ];
    assert.deepStrictEqual(
      findCredentials(diff("catalog/examples/acme.people.find.json", ...lines)).map(
        ({ line, kind }) => [line, kind],
      ),
      [
        [11, "an email address"],
        [12, "a phone number"],
        [13, "a LinkedIn profile"],
      ],
    );
    assert.deepStrictEqual(findCredentials(diff("docs/notes.md", ...lines)), []);

    const placeholders = [
      '  "email": "contact@example.com",',
      '  "phone": "+1 555 0100",',
      '  "profile": "https://www.linkedin.com/in/example",',
    ];
    assert.deepStrictEqual(
      findCredentials(diff("catalog/examples/acme.people.find.json", ...placeholders)),
      [],
    );
  });

  it("flags every number capture would scrub, and an address at example.com passes", () => {
    const lines = [
      '  "phone": "(415) 555-0132",',
      '  "site": "linkedin.com/in/ana-lopez",',
      '  "sample": "ana@example.com",',
      '  "both": ["ana@acme.io", "bob@acme.io"],',
    ];
    assert.deepStrictEqual(
      findCredentials(diff("catalog/examples/acme.people.find.json", ...lines)).map(
        ({ line, kind }) => [line, kind],
      ),
      [
        [11, "a phone number"],
        [12, "a LinkedIn profile"],
        [14, "an email address"],
      ],
    );
  });

  it("names each kind of credential, with its file and line, and never prints the value", () => {
    for (const [kind, value] of Object.entries(planted)) {
      const found = findCredentials(diff("catalog/note.txt", "ok", value));
      assert.deepStrictEqual(
        found.map(({ file, line, kind }) => [file, line, kind]),
        [["catalog/note.txt", 12, kind]],
        kind,
      );
      assert.notInclude(JSON.stringify(found), value);
    }
  });

  it("passes a variable, a placeholder, a short example and a documentation token", () => {
    const fine = [
      "api_key: ${SEMRUSH_API_KEY}",
      "SEMRUSH_API_KEY=",
      "key: { type: string, required: true }",
      "Authorization: Bearer tlp_7Qx...",
      "BETTER_AUTH_SECRET: ci-test-secret-that-is-at-least-32-characters",
      "password: your-password-1234567890-here",
      "curl 'https://api.semrush.com/?key=YOUR_API_KEY_123456789&phrase=x'",
      "const secret = Redacted.make(value)",
    ];
    assert.deepStrictEqual(findCredentials(diff("docs/readme.md", ...fine)), []);
  });

  it("reads the line numbers from each hunk and skips lockfiles", () => {
    const both = [
      diff("a.txt", "one", planted["a GitHub token"]),
      diff("bun.lock", planted["a GitHub token"]),
      diff("b.txt", planted["a GitHub token"]),
    ].join("\n");
    assert.deepStrictEqual(
      findCredentials(both).map(({ file, line }) => [file, line]),
      [
        ["a.txt", 12],
        ["b.txt", 11],
      ],
    );
  });

  it("looks only at what a change adds", () => {
    const removed = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -3 +3 @@",
      `-${planted["a GitHub token"]}`,
      "+gone",
    ].join("\n");
    assert.deepStrictEqual(findCredentials(removed), []);
  });
});

const run = Effect.fnUntraced(function* (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(ChildProcess.make(command, args, { cwd, extendEnv: true }));
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      Stream.mkString(Stream.decodeText(child.stdout)),
      Stream.mkString(Stream.decodeText(child.stderr)),
      child.exitCode,
    ],
    { concurrency: "unbounded" },
  );
  return { stdout, stderr, exitCode: Number(exitCode) };
}, Effect.scoped);

layer(BunServices.layer, { excludeTestServices: true })("telipot catalog scan", (it) => {
  it.effect("fails a change that adds a credential and passes one that does not", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const repository = yield* fs.makeTempDirectoryScoped();
        const git = (...args: Array<string>) =>
          run("git", ["-c", "user.name=t", "-c", "user.email=t@t.test", ...args], repository);
        yield* git("init", "-q");
        yield* fs.writeFileString(`${repository}/notes.txt`, "one\n");
        yield* git("add", ".");
        yield* git("commit", "-q", "-m", "first");
        const base = (yield* git("rev-parse", "HEAD")).stdout.trim();

        yield* fs.writeFileString(`${repository}/notes.txt`, "one\ntwo\n");
        yield* git("commit", "-qam", "clean");
        const clean = yield* telipot(["catalog", "scan", "--base", base], { cwd: repository });
        assert.strictEqual(clean.exitCode, 0, clean.stderr);

        const token = planted["a GitHub token"];
        yield* fs.writeFileString(`${repository}/leak.txt`, `a\n${token}\n`);
        yield* git("add", ".");
        yield* git("commit", "-qm", "leak");
        const leaked = yield* telipot(["catalog", "scan", "--base", base], { cwd: repository });
        assert.notStrictEqual(leaked.exitCode, 0);
        assert.include(leaked.stderr, "leak.txt:2: looks like a GitHub token");
        assert.notInclude(leaked.stderr, token);
        assert.notInclude(leaked.stdout, token);
      }),
    ),
  );
});
