import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { PrincipalForbidden } from "../caller";
import { CatalogId } from "../free-text";
import { problem } from "../problem";
import { PrincipalHeaders } from "../receipt";
import { Task } from "../tasks";

// Tasks are cheapest first.
export const Capability = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  tasks: Schema.Array(Task),
}).annotate({ identifier: "Capability" });

export type Capability = typeof Capability.Type;

export class CapabilityNotFound extends Schema.TaggedError<CapabilityNotFound>()(
  "CapabilityNotFound",
  { detail: Schema.String },
) {
  static readonly problem = problem(this, { status: 404, code: "capability_not_found" });
}

export class CapabilitiesApi extends HttpApiGroup.make("capabilities").add(
  HttpApiEndpoint.get("get", "/capabilities/:id", {
    params: { id: CatalogId },
    headers: PrincipalHeaders,
    success: Capability,
    error: [CapabilityNotFound.problem, PrincipalForbidden.problem],
  }),
) {}
