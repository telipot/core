import { Effect, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

// A git command that ended in failure: what it was asked, how it ended and what it said.
export class GitRefused extends Schema.TaggedError<GitRefused>()("GitRefused", {
  args: Schema.Array(Schema.String),
  exitCode: Schema.Int,
  stderr: Schema.String,
}) {}

const text = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  Stream.mkString(Stream.decodeText(stream));

// Runs git in `directory` and answers what it printed.
export const git = Effect.fnUntraced(function* (directory: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make("git", ["-C", directory, ...args], { stdin: "ignore" }),
  );

  const [output, stderr, exitCode] = yield* Effect.all(
    [text(child.stdout), text(child.stderr), child.exitCode],
    { concurrency: "unbounded" },
  );

  return Number(exitCode) === 0
    ? output
    : yield* new GitRefused({ args, exitCode: Number(exitCode), stderr: stderr.trim() });
}, Effect.scoped);
