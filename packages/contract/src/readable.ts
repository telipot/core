import { Schema, SchemaTransformation } from "effect";

// A response field whose set may grow. A value this client does not know, such as one a newer
// server added, or one a rolled-back client never knew, reads as `unknown`, so the rest of the
// answer still reads. Requests stay strict, and a server never answers `unknown`.
export const readable = <const L extends ReadonlyArray<string>>(known: Schema.Literals<L>) => {
  const isKnown = Schema.is(known);
  return Schema.String.check(Schema.isMaxLength(64))
    .pipe(
      Schema.decodeTo(
        Schema.Union([known, Schema.Literal("unknown")]),
        SchemaTransformation.transform({
          decode: (value): L[number] | "unknown" => (isKnown(value) ? value : "unknown"),
          encode: (value) => value,
        }),
      ),
    )
    .annotate({
      description: `One of ${known.literals.join(", ")}; a client reads any other as unknown.`,
    });
};
