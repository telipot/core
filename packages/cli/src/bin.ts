#!/usr/bin/env bun
// Subpaths, not the barrel, so starting `telipot` skips the server, cluster and worker modules.
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect } from "effect";
import { Command } from "effect/cli";
import { FetchHttpClient } from "effect/http";

import { version } from "../package.json";
import { telipot } from "./telipot";

telipot.pipe(
  Command.run({ version }),
  Effect.provide([BunServices.layer, FetchHttpClient.layer]),
  BunRuntime.runMain,
);
