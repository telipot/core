import { Schema } from "effect";

// The `next_cursor` a page of a list answered, sent back for the page after it: the millisecond
// that page ended on. Fifteen digits stay within the milliseconds a date can hold.
export const Cursor = Schema.String.check(
  Schema.isPattern(/^\d{1,15}$/, { expected: "a next_cursor" }),
);
