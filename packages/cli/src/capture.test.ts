import { assert, describe, it } from "@effect/vitest";
import { Result } from "effect";

import { capture, plain, unnamed } from "./capture";

const kept = (body: unknown, options?: Partial<Parameters<typeof capture>[1]>) => {
  const result = capture(body as never, {
    secrets: [],
    masked: false,
    output: undefined,
    ...options,
  });

  assert.isTrue(Result.isSuccess(result), JSON.stringify(result));
  return Result.getOrThrow(result);
};

describe("capture", () => {
  it("cuts every array to two items, at any depth", () => {
    assert.deepStrictEqual(kept({ hits: [{ tags: [1, 2, 3] }, { tags: [4] }, { tags: [5] }] }), {
      hits: [{ tags: [1, 2] }, { tags: [4] }],
    });
  });

  it("replaces the credential wherever it appears, in a value or in a longer string", () => {
    const secrets = ["sk-live-1234567890"];
    assert.deepStrictEqual(
      kept(
        { echoed: "sk-live-1234567890", url: "https://x.test/?key=sk-live-1234567890&a=1" },
        { secrets },
      ),
      { echoed: "***", url: "https://x.test/?key=***&a=1" },
    );
  });

  it("replaces the value of a key that names a credential", () => {
    assert.deepStrictEqual(
      kept({ api_key: "abc", nested: { Authorization: "Bearer abc" }, tokens: 3 }),
      { api_key: "***", nested: { Authorization: "***" }, tokens: 3 },
    );
  });

  it("replaces an email address, a phone number and a LinkedIn profile with placeholders", () => {
    assert.deepStrictEqual(
      kept({
        email: "ana.lopez@acme.io",
        note: "write to bob@acme.io today",
        phone: "+44 20 7946 0958",
        profile: "https://www.linkedin.com/in/ana-lopez-1a2b3c/",
        company: "https://www.linkedin.com/company/acme",
      }),
      {
        email: "contact@example.com",
        note: "write to contact@example.com today",
        phone: "+1 555 0100",
        profile: "https://www.linkedin.com/in/example",
        company: "https://www.linkedin.com/company/acme",
      },
    );
  });

  it("replaces a contact detail or the credential used as a key", () => {
    const secrets = ["sk-live-1234567890"];
    assert.deepStrictEqual(
      kept({ "ana.lopez@acme.io": "delivered", "sk-live-1234567890": "active" }, { secrets }),
      { "contact@example.com": "delivered", "***": "active" },
    );
  });

  it("replaces a name a key says is a person's, wherever the vendor put it", () => {
    assert.deepStrictEqual(
      kept({
        hits: [{ author: "pancomplex", title: "Show HN", by: "jxmorris12" }],
        first_name: "Ana",
      }),
      { hits: [{ author: "user", title: "Show HN", by: "user" }], first_name: "user" },
    );
  });

  it("masks the ids of our own account, which name it, and keeps the counts", () => {
    assert.deepStrictEqual(
      kept(
        { team_id: 48213, id: 9, credits: 120, meta: { workspaceId: 7, seats: 5 } },
        { masked: true },
      ),
      { team_id: 0, id: 0, credits: 120, meta: { workspaceId: 0, seats: 5 } },
    );
  });

  it("masks every string when the answer belongs to our own account, and keeps the numbers", () => {
    assert.deepStrictEqual(
      kept(
        { plan: "Pro", owner: { email: "founder@missing.studio", seats: 5 }, credits: 120 },
        { masked: true },
      ),
      { plan: "masked", owner: { email: "masked", seats: 5 }, credits: 120 },
    );
  });

  it("shortens every long string, and refuses an example that stays over 10 KB", () => {
    const long = kept({ content: "word ".repeat(5_000) }) as { content: string };
    assert.strictEqual(long.content, `${"word ".repeat(40)}…`);

    const wide = Object.fromEntries(
      Array.from({ length: 1_000 }, (_, i) => [`field_${i}`, "value"]),
    );

    const refused = capture(wide, { secrets: [], masked: false, output: undefined });
    assert.isTrue(Result.isFailure(refused));
    if (Result.isFailure(refused)) assert.include(refused.failure, "10 KB");
  });

  it("names no author in a tag", () => {
    assert.deepStrictEqual(kept({ _tags: ["story", "author_pg"] }), {
      _tags: ["story", "author_user"],
    });
  });

  describe("the output schema", () => {
    const output = {
      type: "object",
      required: ["hits"],
      properties: {
        hits: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "string" }, title: { type: "string" } },
          },
        },
        meta: { type: "object" },
        counts: { type: "object", additionalProperties: { type: "integer" } },
      },
    };

    it("keeps the keys it names and drops the rest, at any depth", () => {
      assert.deepStrictEqual(
        kept(
          {
            hits: [{ id: "a", title: "A", _highlight: { author: { value: "pg" } } }],
            took: 3,
            counts: { eng: 4 },
          },
          { output },
        ),
        { hits: [{ id: "a", title: "A" }], counts: { eng: 4 } },
      );
    });

    it("keeps an object it says nothing about as an empty one", () => {
      assert.deepStrictEqual(kept({ hits: [], meta: { owner: "ana", seats: 3 } }, { output }), {
        hits: [],
        meta: {},
      });
    });

    it("keeps whole a value under a schema that combines others", () => {
      const anyOf = {
        type: "object",
        properties: {
          error: { anyOf: [{ type: "object", properties: { tag: { type: "string" } } }] },
        },
      };

      assert.deepStrictEqual(kept({ error: { tag: "x", detail: "y" } }, { output: anyOf }), {
        error: { tag: "x", detail: "y" },
      });
    });

    it("keeps every key of a task with no schema", () => {
      assert.deepStrictEqual(kept({ a: { b: 1 } }), { a: { b: 1 } });
    });
  });

  describe("unnamed", () => {
    const output = {
      type: "object",
      properties: {
        hits: { type: "array", items: { type: "object", properties: { id: { type: "string" } } } },
        took: { type: "integer" },
        meta: { type: "object" },
        counts: { type: "object", additionalProperties: { type: "integer" } },
      },
    };

    it("lists the keys the schema names others beside, by path, once", () => {
      assert.deepStrictEqual(
        unnamed(
          {
            hits: [
              { id: "a", _highlight: { author: "pg" } },
              { id: "b", _highlight: {}, children: [1] },
            ],
            took: 3,
            exhaustive: true,
          },
          output,
        ),
        ["hits[]._highlight", "hits[].children", "exhaustive"],
      );
    });

    it("says nothing of an object the schema left open, a map, or a schema that combines others", () => {
      assert.deepStrictEqual(unnamed({ meta: { owner: "ana" }, counts: { eng: 4 } }, output), []);
      const anyOf = { type: "object", properties: { error: { anyOf: [{ type: "object" }] } } };
      assert.deepStrictEqual(unnamed({ error: { tag: "x" } }, anyOf), []);
    });

    it("says nothing when the task has no schema", () => {
      assert.deepStrictEqual(unnamed({ a: 1 }, undefined), []);
    });
  });
});

describe("plain", () => {
  it("blanks what could move a terminal's cursor or reorder its text", () => {
    // Escape, carriage return, a bidi override, and the line and paragraph separators.
    assert.strictEqual(plain("a\u001b[2Jb\rc\u202ed\u2028e\u2029f"), "a [2Jb c d e f");
  });
});
