import { Schema } from "effect";

// Stops at the first code point past the bound, so huge text is cheap to refuse.
const withinCodePoints = (input: string, maxLength: number) => {
  if (input.length <= maxLength) return true;
  let count = 0;
  for (const _ of input) if (++count > maxLength) return false;
  return true;
};

// Counts code points, as OpenAPI's maxLength does, not UTF-16 units. Text over the bound skips
// the later checks.
const isMaxCodePoints = (maxLength: number) =>
  Schema.makeFilter<string>(
    (input) => withinCodePoints(input, maxLength),
    { expected: `at most ${maxLength} characters`, toJsonSchema: () => [{ maxLength }, true] },
    true,
  );

// Not a pattern: Go's and Rust's regex engines refuse surrogate escapes in /openapi.json.
const isWellFormed = Schema.makeFilter<string>((input) => input.isWellFormed(), {
  expected: "text without a lone surrogate",
  // Without this, the schema's description would not reach /openapi.json.
  toJsonSchema: () => [{}, true],
});

// Postgres refuses NUL and lone surrogates and memory keeps them, so both are refused here.
export const FreeText = (maxLength: number) =>
  Schema.String.check(
    isMaxCodePoints(maxLength),
    // `\x00` reads the same in every engine that compiles the document's patterns.
    // oxlint-disable-next-line no-control-regex -- refusing a NUL is the point, and as a pattern it shows in /openapi.json.
    Schema.isPattern(/^[^\x00]*$/u, { expected: "text without a NUL (\\u0000)" }),
    isWellFormed,
  ).annotate({ description: "Text without a NUL or a lone surrogate." });

export const CatalogId = FreeText(100);

export const slugVariable = (slug: string) => slug.toUpperCase().replaceAll("-", "_");
