import { Effect, Schema, SchemaIssue, SchemaTransformation } from "effect";
import { HttpApiMiddleware, HttpApiSchema } from "effect/http-api";

const titles = {
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  410: "Gone",
  413: "Content Too Large",
  422: "Unprocessable Content",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
} as const;

export type ProblemStatus = keyof typeof titles;

// RFC 9457. Clients branch on `code`, which is stable; `detail` is prose.
export const ProblemDetails = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.String,
    title: Schema.String,
    status: Schema.Int,
    detail: Schema.String,
    code: Schema.String,
  }),
  [Schema.Record(Schema.String, Schema.Json)],
).annotate({ identifier: "ProblemDetails" });

export const problemBody = (
  status: ProblemStatus,
  code: string,
  detail: string,
  extensions: Readonly<Record<string, Schema.Json>> = {},
): typeof ProblemDetails.Type => ({
  type: "about:blank",
  title: titles[status],
  status,
  detail,
  code,
  ...extensions,
});

const pick = (from: object, keys: ReadonlyArray<string>) =>
  Object.fromEntries(
    keys.flatMap((key) =>
      Object.hasOwn(from, key) ? [[key, from[key as keyof typeof from]]] : [],
    ),
  );

// Described by its code, so /openapi.json names every code. Other fields become extension members,
// so they must be plain JSON. Each error also answers its `detail` as `message`, for a JS caller
// that logs it.
export const problem = <
  E extends Schema.Top & {
    readonly fields: Schema.Struct.Fields;
    readonly Type: { readonly detail: string };
  },
>(
  error: E,
  options: { readonly status: ProblemStatus; readonly code: string },
) => {
  const extensions = Object.keys(error.fields).filter((key) => key !== "_tag" && key !== "detail");
  return ProblemDetails.pipe(
    Schema.decodeTo(
      Schema.toType(error),
      SchemaTransformation.transformEffect<E["Type"], typeof ProblemDetails.Type>({
        // Checked, not typed as a literal, so every error shares one `ProblemDetails` schema.
        decode: (body) =>
          body.code === options.code
            ? error.makeEffect(pick(body, ["detail", ...extensions]))
            : Effect.fail(
                new SchemaIssue.InvalidValue({ message: `expected code ${options.code}` }, body),
              ),
        encode: (value) =>
          Effect.succeed(
            problemBody(
              options.status,
              options.code,
              value.detail,
              pick(value, extensions) as Record<string, Schema.Json>,
            ),
          ),
      }),
    ),
    HttpApiSchema.status(options.status),
    HttpApiSchema.asJson({ contentType: "application/problem+json" }),
    Schema.annotate({ description: options.code }),
  );
};

export class InvalidInput extends Schema.TaggedError<InvalidInput>()("InvalidInput", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail;
  }

  static readonly problem = problem(this, { status: 400, code: "invalid_input" });
}

// A run's input is plain JSON with no files, so a larger body is a mistake or an attack.
export const maxBodyBytes = 1024 * 1024;
export class PayloadTooLarge extends Schema.TaggedError<PayloadTooLarge>()("PayloadTooLarge", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail;
  }

  static readonly problem = problem(this, { status: 413, code: "payload_too_large" });
}

// Its detail never names the cause.
export class InternalError extends Schema.TaggedError<InternalError>()("InternalError", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail;
  }

  static readonly problem = problem(this, { status: 500, code: "internal_error" });
}

export class RouteNotFound extends Schema.TaggedError<RouteNotFound>()("RouteNotFound", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail;
  }

  static readonly problem = problem(this, { status: 404, code: "route_not_found" });
}

export class Problems extends HttpApiMiddleware.Service<Problems>()("@telipot/contract/Problems", {
  error: [InvalidInput.problem, PayloadTooLarge.problem, InternalError.problem],
}) {}
