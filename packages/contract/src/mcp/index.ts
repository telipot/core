import { Context, Predicate, Schema, Struct } from "effect";
import { Tool, Toolkit } from "effect/ai";

import { ConnectionList } from "../connections";
import { ConnectSessionCreated, NewConnectSession } from "../connect";
import { Discover, Discovery } from "../discover";
import { CatalogId } from "../free-text";
import { ProblemDetails } from "../problem";
import { Principal, RunHeaders, ReceiptOptions } from "../receipt";
import { Run, Task } from "../tasks";

// The MCP server answers at this path on each API host, but clients are given MCP_URL alone,
// since every MCP access token is bound to that exact address.
export const mcpPath = "/mcp";

// Every answer field optional and nullable, so a client that checks a tool's output against its
// schema never refuses one the API grows.
const loose = <Fields extends Schema.Struct.Fields>(
  fields: Fields,
  keep?: ReadonlyArray<keyof Fields>,
) =>
  Schema.Struct(
    Object.fromEntries(
      Object.keys(fields)
        .filter((key) => Predicate.isUndefined(keep) || keep.includes(key))
        .map((key) => [key, Schema.optionalKey(Schema.NullOr(Schema.Json))]),
    ),
  );

const principal = {
  principal: Schema.optionalKey(Principal).annotate({
    description: "Whom to act as: organization, or an end user as user:<id>.",
  }),
};

// A tool sends the id in a route's path, where `.` and `..` would name another route.
const taskId = {
  id: CatalogId.check(
    Schema.makeFilter((id) => (id !== "." && id !== "..") || "a task id from discover"),
  ).annotate({ description: "A task id from discover." }),
};

// A vendor's credential is never an MCP argument: no MCP client may carry one.
const RunArguments = Schema.Struct({
  ...taskId,
  input: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Json).check(
      Schema.makeFilter(
        (input) =>
          !Object.hasOwn(input, "receipt") ||
          "the task's input, with the options in receipt beside it",
      ),
    ),
  ).annotate({ description: "The task's input, as inspect describes it." }),
  receipt: Schema.optionalKey(
    ReceiptOptions.mapFields((fields) => ({
      ...Struct.omit(fields, ["credential"]),
      // Refused, not dropped, so a client never believes its key served the call.
      credential: Schema.optionalKey(Schema.Never),
    })),
  ),
  idempotency_key: RunHeaders.fields["idempotency-key"].annotate({
    description: "Repeat a call under the same key and it runs once.",
  }),
});

const quoted = ["id", "price", "identity", "credential_in_place"] as const;

// Problem Details: branch on `code`, and open `connect_url` when there is one.
const failure = ProblemDetails;

// Only a run reaches a vendor; the other tools read and write telipot alone.
const readsOurs = Context.make(Tool.Readonly, true).pipe(
  Context.add(Tool.Destructive, false),
  Context.add(Tool.OpenWorld, false),
);

const writesOurs = Context.make(Tool.Readonly, false).pipe(
  Context.add(Tool.Destructive, false),
  Context.add(Tool.OpenWorld, false),
);

const readsVendor = Context.make(Tool.Readonly, true).pipe(Context.add(Tool.Destructive, false));
const changesVendor = Context.make(Tool.Readonly, false);

const discover = Tool.make("discover", {
  description: "Find tasks for a job, described in a sentence.",
  parameters: Schema.Struct({ ...Discover.fields, ...principal }),
  success: loose(Discovery.fields),
  failure,
}).annotateMerge(readsOurs);

const inspect = Tool.make("inspect", {
  description: "One task: its input, price, auth and which identity would serve it.",
  parameters: Schema.Struct({ ...taskId, ...principal }),
  success: loose(Task.fields),
  failure,
}).annotateMerge(readsOurs);

// Answers the task inspect does; its schema keeps only `quoted`.
const quote = Tool.make("quote", {
  description: "A task's price and which identity would pay for it, before it runs.",
  parameters: Schema.Struct({ ...taskId, ...principal }),
  success: loose(Task.fields, quoted),
  failure,
}).annotateMerge(readsOurs);

const run = Tool.make("run", {
  description: "Run a task that reads: kind data or utility.",
  parameters: RunArguments,
  success: loose(Run.fields),
  failure,
}).annotateMerge(readsVendor);

const runAction = Tool.make("run_action", {
  description: "Run a task that changes something: kind action or account.",
  parameters: RunArguments,
  success: loose(Run.fields),
  failure,
}).annotateMerge(changesVendor);

const connect = Tool.make("connect", {
  description: "A link for a principal to connect their account on a provider.",
  parameters: NewConnectSession,
  success: loose(ConnectSessionCreated.fields),
  failure,
}).annotateMerge(writesOurs);

const connections = Tool.make("connections", {
  description: "The connections the organization or an end user holds.",
  parameters: Schema.Struct(principal),
  success: loose(ConnectionList.fields),
  failure,
}).annotateMerge(readsOurs);

// Never one tool per provider: a task is an argument.
export const McpTools = Toolkit.make(
  discover,
  inspect,
  quote,
  run,
  runAction,
  connect,
  connections,
);
