import { Schema } from "effect";

// The millisecond the previous page ended on; fifteen digits stay within what a date can hold.
export const Cursor = Schema.String.check(
  Schema.isPattern(/^\d{1,15}$/, { expected: "a next_cursor" }),
);
