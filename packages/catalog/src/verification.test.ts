import { BunServices } from "@effect/platform-bun";
import { assert, describe, it, layer } from "@effect/vitest";
import { catalogFixtures } from "@telipot/fixtures/catalog";
import { copyDirectory } from "@telipot/fixtures/filesystem";
import { Effect, Exit, FileSystem, Option, Path, Result } from "effect";

import { Catalog, formatIssue } from "./catalog";
import type { Entry, Verification } from "./rules";
import { Task } from "./schema";
import { type Replayed, recordVerification, stamp as stampFile } from "./verification";

const stamp = (text: string, id: string, verification: Verification) =>
  Result.getOrThrow(stampFile(text, id, verification, `examples/${id}.json`));

const file = `provider: acme
# Acme bills per call.
endpoints:
  - id: acme.page.text
    auth: public
    test_request: { queryParams: { url: https://example.com } }
    cost: { type: free }
    output:
      type: string
  - id: acme.page.links
    auth: public
    unverified: "429: slow down"
    example_response: examples/acme.page.links.json
    output:
      type: object
`;

describe("stamp", () => {
  it("writes verified and the example path before output, and touches nothing else", () => {
    assert.strictEqual(
      stamp(file, "acme.page.text", { state: "verified", date: "2026-10-05" }),
      file.replace(
        "    output:\n      type: string",
        "    verified: 2026-10-05\n    example_response: examples/acme.page.text.json\n    output:\n      type: string",
      ),
    );
  });

  it("replaces the state a task carried, so it never holds two", () => {
    const stamped = stamp(file, "acme.page.links", { state: "verified", date: "2026-10-05" });
    assert.include(stamped, "    verified: 2026-10-05\n");
    assert.notInclude(stamped, "unverified");
    assert.strictEqual(stamped.match(/example_response/g)?.length, 1);

    const failed = stamp(stamped, "acme.page.links", {
      state: "unverified",
      reason: "401: Invalid API key",
    });

    assert.include(failed, '    unverified: "401: Invalid API key"\n');
    assert.notInclude(failed, "verified: 2026");
  });

  it("writes a skipped reason, and leaves the other task's lines alone", () => {
    const stamped = stamp(file, "acme.page.text", {
      state: "skipped",
      reason: "same request as acme.page.links, which passed",
    });

    assert.include(stamped, "    skipped: same request as acme.page.links, which passed\n");
    assert.include(stamped, '    unverified: "429: slow down"\n');
  });

  it("writes untestable over the state a task carried", () => {
    const stamped = stamp(file, "acme.page.links", {
      state: "untestable",
      reason: "a contact lookup needs a person",
    });

    assert.include(stamped, "    untestable: a contact lookup needs a person\n");
    assert.notInclude(stamped, "unverified");
  });

  it("refuses an id the file does not have", () => {
    const refused = stampFile(
      file,
      "acme.nothing",
      { state: "verified", date: "2026-10-05" },
      "examples/acme.nothing.json",
    );

    assert.isTrue(Result.isFailure(refused));
    if (Result.isFailure(refused)) assert.include(refused.failure, "acme.nothing");
  });
});

layer(BunServices.layer)("recordVerification", (it) => {
  const entryIn = (directory: string, id: string) =>
    Effect.gen(function* () {
      return Option.getOrThrow((yield* Catalog).get(id));
    }).pipe(Effect.provide(Catalog.layer(directory)));

  it.effect("keeps a pass's example where the task names it, and the catalog loads it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* copyDirectory(catalogFixtures.clean);
      const named = path.join(directory, "examples/acme.page.text.json");
      assert.isTrue(yield* fs.exists(named));
      const entry = yield* entryIn(directory, "acme.page.text");
      assert.strictEqual(entry.task.example_response, "examples/acme.page.text.json");
      yield* recordVerification(directory, entry, {
        state: "verified",
        date: "2026-10-08",
        example: { status: "ok", text: "A new page" },
      });

      assert.strictEqual(
        yield* fs.readFileString(named),
        `${JSON.stringify({ status: "ok", text: "A new page" }, null, 2)}\n`,
      );

      const after = yield* entryIn(directory, "acme.page.text");
      assert.deepStrictEqual(after.verification, { state: "verified", date: "2026-10-08" });
      assert.deepStrictEqual(after.example, { status: "ok", text: "A new page" });
    }),
  );

  it.effect("rewrites the example a task names elsewhere, rather than a new file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* copyDirectory(catalogFixtures.clean);
      const providerFile = path.join(directory, "providers/acme.yaml");
      yield* fs.rename(
        path.join(directory, "examples/acme.page.text.json"),
        path.join(directory, "examples/page.json"),
      );

      yield* fs.writeFileString(
        providerFile,
        (yield* fs.readFileString(providerFile)).replace(
          "example_response: examples/acme.page.text.json",
          "example_response: examples/page.json",
        ),
      );

      const entry = yield* entryIn(directory, "acme.page.text");
      yield* recordVerification(directory, entry, {
        state: "verified",
        date: "2026-10-08",
        example: { status: "ok", text: "A new page" },
      });

      assert.isFalse(yield* fs.exists(path.join(directory, "examples/acme.page.text.json")));
      const after = yield* entryIn(directory, "acme.page.text");
      assert.strictEqual(after.task.example_response, "examples/page.json");
      assert.deepStrictEqual(after.example, { status: "ok", text: "A new page" });
    }),
  );

  it.effect("writes a failure's reason and leaves the example alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* copyDirectory(catalogFixtures.clean);
      const named = path.join(directory, "examples/acme.page.text.json");
      const example = yield* fs.readFileString(named);
      const entry = yield* entryIn(directory, "acme.page.text");
      yield* recordVerification(directory, entry, {
        state: "unverified",
        reason: "401: Invalid API key",
      });

      assert.strictEqual(yield* fs.readFileString(named), example);
      const after = yield* entryIn(directory, "acme.page.text");
      assert.deepStrictEqual(after.verification, {
        state: "unverified",
        reason: "401: Invalid API key",
      });
    }),
  );

  it.effect("refuses an example outside examples/, so a pass never writes beside it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* copyDirectory(catalogFixtures.clean);
      const providerFile = path.join(directory, "providers/acme.yaml");
      yield* fs.writeFileString(
        path.join(directory, "notes.json"),
        yield* fs.readFileString(path.join(directory, "examples/acme.page.text.json")),
      );

      yield* fs.writeFileString(
        providerFile,
        (yield* fs.readFileString(providerFile)).replace(
          "example_response: examples/acme.page.text.json",
          "example_response: notes.json",
        ),
      );

      const { issues } = yield* Catalog.validate(directory);
      assert.isTrue(
        issues.map(formatIssue).some((issue) => issue.includes("example_response")),
        issues.map(formatIssue).join("\n"),
      );
    }),
  );

  it.effect("refuses to record an extended task, whose file is generated, and writes nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* copyDirectory(catalogFixtures.clean);
      const extendedFile = path.join(directory, "providers/acme.extended.yaml");
      const before = yield* fs.readFileString(extendedFile);
      const entry = yield* entryIn(directory, "acme.x.gadgets");
      const founds: ReadonlyArray<Replayed> = [
        { state: "unverified", reason: "401: nope" },
        { state: "verified", date: "2026-10-08", example: { gadgets: [] } },
      ];

      for (const found of founds) {
        assert.isTrue(
          Exit.isFailure(yield* Effect.exit(recordVerification(directory, entry, found))),
        );
      }

      assert.strictEqual(yield* fs.readFileString(extendedFile), before);
      assert.isFalse(yield* fs.exists(path.join(directory, "examples/acme.x.gadgets.json")));
      assert.deepStrictEqual((yield* Catalog.validate(directory)).issues, []);
    }),
  );

  it.effect("stamps a failure whatever its example, and never writes a pass's past examples/", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* copyDirectory(catalogFixtures.clean);
      const entry = yield* entryIn(directory, "acme.page.text");
      // The loader refuses such a path; `recordVerification` refuses it in a hand-built entry too.
      const task: Task = Object.assign(Object.create(Task.prototype) as Task, entry.task, {
        example_response: "../astray.json",
      });

      const astray: Entry = { ...entry, task };

      yield* recordVerification(directory, astray, { state: "unverified", reason: "401: nope" });
      assert.deepStrictEqual((yield* entryIn(directory, "acme.page.text")).verification, {
        state: "unverified",
        reason: "401: nope",
      });

      const passed = yield* Effect.exit(
        recordVerification(directory, astray, {
          state: "verified",
          date: "2026-10-08",
          example: { status: "ok", text: "A new page" },
        }),
      );

      assert.isTrue(Exit.isFailure(passed));
      assert.isFalse(yield* fs.exists(path.join(directory, "../astray.json")));
    }),
  );
});
