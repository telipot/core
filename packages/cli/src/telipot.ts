import { Command } from "effect/cli";

import { version } from "../package.json";
import { catalog } from "./catalog";
import { gatewayCommands } from "./gateway";

export const telipot = Command.make("telipot").pipe(
  Command.withDescription("The telipot command line"),
  Command.withSubcommands([catalog, ...gatewayCommands]),
);

// Lets tests run `telipot` in their own process.
export const runTelipot = Command.runWith(telipot, { version });
