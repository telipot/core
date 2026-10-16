import { ConfigProvider, Effect, Exit, Layer, Option, Predicate } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { TestConsole } from "effect/testing";

import { runTelipot } from "./telipot";

// The gateway address tests pass as `TELIPOT_API_URL`. A gateway world's client prefixes its own,
// so `onWorld` strips this one from each request after every other prefix.
export const testApiUrl = "https://api.telipot.test";
export const onWorld = (world: HttpClient.HttpClient) =>
  HttpClient.make((request) =>
    world.execute(HttpClientRequest.setUrl(request, request.url.replace(testApiUrl, ""))),
  );

// Given `cwd`, what it spawns, such as `scan`'s git, starts there. Requests go out on the test's
// `HttpClient` when it has one, such as a gateway world's, and on `fetch` otherwise.
export const telipot = Effect.fnUntraced(
  function* (
    args: ReadonlyArray<string>,
    options?: { readonly env?: Record<string, string>; readonly cwd?: string },
  ) {
    const cwd = options?.cwd;
    const http = yield* Effect.serviceOption(HttpClient.HttpClient);
    const exit = yield* runTelipot(args).pipe(
      Effect.provide([
        Option.match(http, {
          onNone: () => FetchHttpClient.layer,
          onSome: (world) => Layer.succeed(HttpClient.HttpClient, onWorld(world)),
        }),
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: { ...options?.env } })),
      ]),
      Effect.updateService(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
        Predicate.isUndefined(cwd)
          ? spawner
          : ChildProcessSpawner.make((command) => spawner.spawn(ChildProcess.setCwd(command, cwd))),
      ),
      Effect.exit,
    );

    const printed = (lines: ReadonlyArray<unknown>) =>
      lines.map((line) => `${String(line)}\n`).join("");

    return {
      exitCode: Exit.isSuccess(exit) ? 0 : 1,
      stdout: printed(yield* TestConsole.logLines),
      stderr: printed(yield* TestConsole.errorLines),
    };
  },
  Effect.provide(Layer.fresh(TestConsole.layer)),
);

export { runTelipot } from "./telipot";
export { Credentials } from "./signed-in";
