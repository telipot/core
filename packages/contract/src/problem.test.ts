import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { problem } from "./problem";

class Gone extends Schema.TaggedError<Gone>()("Gone", {
  detail: Schema.String,
  status_note: Schema.String,
  superseded_by: Schema.optionalKey(Schema.String),
}) {
  static readonly problem = problem(this, { status: 410, code: "task_retired" });
}

describe("problem", () => {
  it.effect("sends an error's own fields as extension members and reads them back", () =>
    Effect.gen(function* () {
      const gone = new Gone({
        detail: "acme.page.old is retired.",
        status_note: "Replaced by the authenticated route",
        superseded_by: "acme.page.text",
      });

      const body = yield* Schema.encodeEffect(Gone.problem)(gone);
      assert.deepStrictEqual(body, {
        type: "about:blank",
        title: "Gone",
        status: 410,
        detail: "acme.page.old is retired.",
        code: "task_retired",
        status_note: "Replaced by the authenticated route",
        superseded_by: "acme.page.text",
      });

      const read = yield* Schema.decodeEffect(Gone.problem)(body);
      assert.strictEqual(read.superseded_by, "acme.page.text");
      assert.strictEqual(read.status_note, "Replaced by the authenticated route");
    }),
  );

  it.effect("leaves out an optional field the error does not carry", () =>
    Effect.gen(function* () {
      const body = yield* Schema.encodeEffect(Gone.problem)(
        new Gone({ detail: "acme.page.old is retired.", status_note: "No successor" }),
      );

      assert.isFalse(Object.hasOwn(body, "superseded_by"));
    }),
  );

  it.effect("refuses a body with another code", () =>
    Effect.gen(function* () {
      const refused = yield* Effect.flip(
        Schema.decodeEffect(Gone.problem)({
          type: "about:blank",
          title: "Gone",
          status: 410,
          detail: "gone",
          code: "task_not_found",
          status_note: "x",
        }),
      );

      assert.include(String(refused), "expected code task_retired");
    }),
  );
});
