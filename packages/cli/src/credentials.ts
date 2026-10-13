import { Effect, Predicate, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { contactIn } from "@telipot/catalog";

// A finding names the kind and never prints the value. A `loose` kind skips placeholders.
interface Look {
  readonly kind: string;
  readonly pattern: RegExp;
  readonly loose?: true;
}

const tokenChar = /[A-Za-z0-9_\-/+=.]/;
const assigned = `(?<value>(?=${tokenChar.source}*\\d)${tokenChar.source}{20,})`;
const credentials: ReadonlyArray<Look> = [
  { kind: "a private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: "an AWS access key id", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  {
    kind: "a GitHub token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/,
  },
  { kind: "a Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { kind: "a secret key", pattern: /\b(?:sk|rk)[-_](?:live_|test_|ant-|proj-)?[A-Za-z0-9_-]{20,}/ },
  { kind: "a telipot token", pattern: /\btlp_[A-Za-z0-9]{16,}/ },
  { kind: "a Firecrawl key", pattern: /\bfc-[0-9a-f]{32}\b/ },
  { kind: "a bearer token", pattern: /\bBearer [A-Za-z0-9._~+/-]{20,}=*/ },
  {
    kind: "a URL with a password",
    pattern: /\bhttps?:\/\/[^/\s:@]+:(?<value>[^/\s:@{}"'$]{6,})@/,
    loose: true,
  },
  {
    kind: "an assigned secret",
    pattern: new RegExp(
      `(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret|password|passwd)["']?\\s*[:=]\\s*["']?${assigned}`,
      "i",
    ),
    loose: true,
  },
  {
    kind: "a key in a query string",
    pattern: new RegExp(`[?&](?:key|api_key|apikey|token|access_token)=${assigned}`, "i"),
    loose: true,
  },
];

// A random token mixes letters and digits within a part;
// `only-for-schema-generation-32-chars` does not.
const placeholder = /example|placeholder|changeme|your[-_]|test|dummy|fake|xxxx/i;
const words = (value: string) =>
  value.split(/[-_./+=]/).every((part) => /^(?:[a-z]*|\d*)$/.test(part));

// `capture` scrubs contact details, so this catches a pasted or hand-written example.
const exampleFile = /^catalog\/examples\/.*\.json$/;
const jsonString = /"((?:[^"\\]|\\.)*)"/g;

// A lockfile is hashes, not credentials.
const lockfile = /(?:^|\/)[^/]*\.lock$/;

export interface Finding {
  readonly file: string;
  readonly line: number;
  readonly kind: string;
}

export const formatFinding = ({ file, line, kind }: Finding) =>
  `${file}:${line}: looks like ${kind}`;

export const findCredentials = (diff: string): ReadonlyArray<Finding> => {
  const found: Array<Finding> = [];
  let file: string | undefined;
  let line = 0;
  for (const text of diff.split("\n")) {
    const header = /^\+\+\+ b\/(.*)$/.exec(text);
    if (Predicate.isNotNull(header)) {
      file = header[1];
      continue;
    }
    const hunk = /^@@ -\S+ \+(\d+)/.exec(text);
    if (Predicate.isNotNull(hunk)) {
      line = Number(hunk[1]);
      continue;
    }
    if (!text.startsWith("+") || text.startsWith("+++") || Predicate.isUndefined(file)) continue;
    const added = text.slice(1);
    if (!lockfile.test(file)) {
      for (const { kind, pattern, loose } of credentials) {
        const hit = pattern.exec(added);
        if (Predicate.isNull(hit)) continue;
        const value = hit.groups?.value ?? hit[0];
        if (loose === true && (placeholder.test(hit[0]) || words(value))) continue;
        found.push({ file, line, kind });
      }
      if (exampleFile.test(file)) {
        const strings = [...added.matchAll(jsonString)].map(([, text]) => text ?? "");
        for (const kind of new Set(strings.flatMap(contactIn))) found.push({ file, line, kind });
      }
    }
    line++;
  }
  return found;
};

export const addedSince = Effect.fnUntraced(function* (base: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make("git", [
      "diff",
      "--no-color",
      "--unified=0",
      "--diff-filter=AMR",
      base,
      "HEAD",
    ]),
  );
  const [diff, exitCode] = yield* Effect.all(
    [Stream.mkString(Stream.decodeText(child.stdout)), child.exitCode],
    { concurrency: "unbounded" },
  );
  return Number(exitCode) === 0 ? diff : yield* Effect.die(`git diff against ${base} failed`);
}, Effect.scoped);
