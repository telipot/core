import { Schema } from "effect";

// An instant as the API writes it, ISO 8601 in UTC, such as 2026-10-19T09:00:00.000Z. Named
// `date-time` in /openapi.json, so a generated client can read it as a date.
export const Timestamp = Schema.String.annotate({ format: "date-time" });
