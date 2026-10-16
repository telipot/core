import type { ConnectSessionCreated, Discovery, Receipt, Task } from "@telipot/contract";
import { Config, Effect, Predicate } from "effect";
import { plain } from "./capture";
import type { ScaffoldReport } from "./scaffold";
import type { CostSource, Progress, Report } from "./verify";

export interface Streams {
  readonly stdout: boolean;
  readonly stderr: boolean;
}

// Each stream decides alone, since stdout can be a terminal while stderr goes to a file.
export const colourFor = (terminals: Streams) =>
  Config.String("NO_COLOR").pipe(
    Config.withDefault(""),
    Config.map((noColor): Streams => ({
      stdout: terminals.stdout && noColor === "",
      stderr: terminals.stderr && noColor === "",
    })),
  );

export const usd = (micro: number) => `$${micro / 1_000_000}`;
const longest = (texts: ReadonlyArray<string>) => Math.max(0, ...texts.map((text) => text.length));

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const calls = (n: number) => plural(n, "call");
const label = (micro: number | undefined) => {
  if (Predicate.isUndefined(micro)) return "no price";
  return micro === 0 ? "free" : usd(micro);
};

const maxPaths = 8;
const named = (status: number) => (status === 0 ? "no response" : `${status}`);

export const renderer = (colour: Streams) => {
  const painter = (on: boolean) => (code: number) => (text: string) =>
    on ? `\u001b[${code}m${text}\u001b[0m` : text;

  const paint = painter(colour.stdout);
  const bold = paint(1);
  const dim = paint(2);
  const red = paint(31);
  const green = paint(32);
  const yellow = paint(33);

  const ok = (text: string) => `${green("✓")} ${text}`;
  const stop = (text: string) => `${yellow("!")} ${text}`;
  // Printed on stderr, so stderr decides its colour.
  const warnHeading = painter(colour.stderr)(33)("WARN");

  const section = (title: string, lines: ReadonlyArray<string>) =>
    [bold(title), ...lines.map((line) => `  ${line}`)].join("\n");

  const price = (micro: number | undefined, width: number) => {
    const text = label(micro).padStart(width);
    if (Predicate.isUndefined(micro)) return yellow(text);
    return micro === 0 ? green(text) : text;
  };

  // A price in credits has no USD figure.
  const headline = (provider: string, queue: Report["queue"]) => {
    const known = queue.flatMap(({ listMicroUsd }) =>
      Predicate.isUndefined(listMicroUsd) ? [] : [listMicroUsd],
    );

    const total = known.reduce((sum, micro) => sum + micro, 0);
    const parts = [bold(provider), calls(queue.length)];
    if (known.length === 0) parts.push("no USD list price");
    else parts.push(total === 0 ? "free" : `${usd(total)} at list price`);

    if (known.length > 0 && known.length < queue.length) {
      parts.push(`${queue.length - known.length} with no price`);
    }

    return parts.join(" · ");
  };

  const nothingToReplay = (provider: string, report: Report) =>
    report.callable === 0
      ? `${bold(provider)} · nothing to call: no task has a test request`
      : `${bold(provider)} · nothing to replay: every task that can be called has passed; --again replays them`;

  const queue = (provider: string, report: Report) => {
    if (report.queue.length === 0) return nothingToReplay(provider, report);
    const ids = longest(report.queue.map(({ id }) => id));
    const prices = Math.max(
      "list price".length,
      longest(report.queue.map((q) => label(q.listMicroUsd))),
    );

    const rows = report.queue.map(
      ({ id, listMicroUsd }) => `  ${id.padEnd(ids)}  ${price(listMicroUsd, prices)}`,
    );

    const lines = [
      headline(provider, report.queue),
      "",
      dim(`  ${"task".padEnd(ids)}  ${"list price".padStart(prices)}`),
      ...rows,
    ];

    if (Predicate.isNotUndefined(report.variable)) {
      lines.push("", dim(`set ${report.variable} to run them`));
    }

    return lines.join("\n");
  };

  // A task's calls are totalled, so the lines add up to the summary's spend.
  const charge = (micro: number | undefined, source: CostSource | undefined, taken: number) => {
    const times = taken > 1 ? dim(` (${taken} calls)`) : "";
    if (Predicate.isUndefined(micro)) return `${yellow("cost unknown")}${times}`;
    if (micro === 0) return `${green("free")}${times}`;
    const reported = taken === 1 && source === "reported" ? ` ${dim("reported")}` : "";
    return `${usd(micro)}${reported}${times}`;
  };

  const progressPrinter = () => {
    let ids = 0;
    return (event: Progress): string => {
      switch (event.kind) {
        case "queue":
          ids = longest([...event.queue.map(({ id }) => id), ...event.followers]);
          return `${headline(event.provider, event.queue)}\n`;
        case "passed": {
          const time = `${Math.round(event.waitedMs)} ms`.padStart(7);
          return `  ${green("✓")} ${event.id.padEnd(ids)}  ${dim(time)}  ${charge(event.micro, event.source, event.calls)}`;
        }

        case "failed": {
          const paid =
            event.calls > 0 && event.micro !== 0
              ? `  ${charge(event.micro, undefined, event.calls)}`
              : "";

          return `  ${red("✗")} ${event.id.padEnd(ids)}  ${event.message}${paid}`;
        }

        case "skipped":
          return `  ${dim("–")} ${event.id.padEnd(ids)}  ${dim(`same request as ${event.sibling}`)}`;
      }
    };
  };

  const failures = (failed: Report["failed"]) => {
    const byStatus = Map.groupBy(failed, ({ status }) => status);
    const lines = [...byStatus].map(([status, group]) => {
      const families = [...new Set(group.map(({ family }) => family))].toSorted();
      return `${named(status)} × ${group.length} (${families.join(", ")}): ${group.map(({ id }) => id).join(", ")}`;
    });

    const [only, ...others] = byStatus.keys();
    if (failed.length > 1 && Predicate.isNotUndefined(only) && others.length === 0) {
      lines.push(
        dim(
          `every failure is ${named(only)}: the credential or the tooling is the likelier cause, so fix it before believing these`,
        ),
      );
    }

    return section("Failed", lines);
  };

  // One key per line, so a long list never wraps.
  const undeclared = (provider: string, found: Report["undeclared"]) => {
    const lines = found.flatMap(({ id, paths }) => {
      const more = paths.length - maxPaths;
      return [
        id,
        ...paths.slice(0, maxPaths).map((path) => `  ${path}`),
        ...(more > 0 ? [dim(`  and ${more} more`)] : []),
      ];
    });

    return section("Not named by output, so the example leaves them out", [
      ...lines,
      dim(`full answers: .verify/${provider}/ in the catalog folder`),
    ]);
  };

  const summary = (provider: string, report: Report) => {
    const { passed, failed, skipped } = report;
    if (report.queue.length === 0) return nothingToReplay(provider, report);
    const failedCount = `${failed.length} failed`;
    const sections = [
      [
        green(`${passed.length} passed`),
        failed.length > 0 ? red(failedCount) : failedCount,
        `${skipped.length} skipped`,
        `spent ${usd(report.spentMicroUsd)}`,
      ].join(" · "),
    ];

    if (failed.length > 0) sections.push(failures(failed));
    if (report.undeclared.length > 0) sections.push(undeclared(provider, report.undeclared));
    if (report.unknownCost.length > 0) {
      sections.push(section("Cost unknown, not free", report.unknownCost));
    }

    if (report.unbounded.length > 0) {
      sections.push(
        section("Not called, since no price bounds them under --budget", report.unbounded),
      );
    }

    if (Predicate.isNotUndefined(report.stoppedBefore)) {
      const { id, listMicroUsd, leftMicroUsd } = report.stoppedBefore;
      sections.push(
        stop(
          `stopped before ${id}: it lists ${usd(listMicroUsd)} and ${usd(leftMicroUsd)} of the budget is left`,
        ),
      );
    }

    if (Predicate.isNotUndefined(report.rateLimited)) {
      sections.push(
        stop(
          `stopped at ${report.rateLimited}: the vendor kept answering 429; run again to resume`,
        ),
      );
    }

    return sections.join("\n\n");
  };

  const scaffolded = (provider: string, report: ScaffoldReport) => {
    const count = report.taskCount === 0 ? "" : ` · ${plural(report.taskCount, "extended task")}`;
    const width = longest(report.reviews.map(({ path }) => path));
    const told: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
      ["Curated in the core file, so left out of the extended one", report.twins],
      [
        "Kept as tombstones, so their ids keep answering",
        report.tombstoned.map(({ id, note }) => `${id}: ${note}`),
      ],
      ["In the spec still, but not made into a task this time, so kept as they were", report.stale],
      ["Left out of the extended file", report.leftOut],
      [
        `Write these in providers/${provider}.yaml before telipot catalog validate passes`,
        report.reviews.map(({ path, note }) => `${yellow(path.padEnd(width))}  ${note}`),
      ],
    ];

    return [
      `${ok(`${bold(provider)}${count}`)}\n${report.written.map((file) => `  wrote ${file}`).join("\n")}`,
      ...(report.kept ? [dim(`providers/${provider}.yaml is yours, and was left as it was`)] : []),
      ...(Predicate.isUndefined(report.patch)
        ? []
        : [dim(`read the vendor's document with ${report.patch} applied`)]),
      ...told
        .filter(([, lines]) => lines.length > 0)
        .map(([title, lines]) => section(title, lines)),
    ].join("\n\n");
  };

  // A task's price and whose credential would pay, as discover and `run --quote` show it.
  const pays = (task: Task) =>
    [
      priceText(task.price),
      Predicate.isNull(task.identity) ? yellow("no credential in place") : `on ${task.identity}`,
    ].join(" · ");

  const discovered = ({ candidates, near_misses = [] }: Discovery) => {
    if (candidates.length > 0) {
      const width = longest(candidates.map(({ id }) => id));
      return candidates
        .map((task) => `${bold(task.id.padEnd(width))}  ${plain(task.name)} · ${pays(task)}`)
        .join("\n");
    }

    return [
      stop("No task does that."),
      ...near_misses.map(
        ({ id, missed }) => `  ${id}: has no ${missed.map((word) => plain(word)).join(", ")}`,
      ),
    ].join("\n");
  };

  const quoted = (task: Task) =>
    [
      `${bold(task.id)}  ${plain(task.name)}`,
      `  ${pays(task)}`,
      `  catalog version ${task.version}`,
      dim("  quoted only: nothing ran"),
    ].join("\n");

  // On stderr beside the vendor's answer on stdout, so a pipe gets the answer alone.
  const ran = (receipt: Receipt) =>
    painter(colour.stderr)(2)(
      [receipt.call_id, receipt.identity, receipt.principal, `charged $${receipt.charged_usd}`]
        .filter(Predicate.isNotNull)
        .join(" · "),
    );

  // The link works once; hand it to whoever connects, the end user `--as` named.
  const connectLink = (provider: string, session: typeof ConnectSessionCreated.Type) =>
    [
      `Open this link to connect ${bold(provider)}, once, before ${session.expires_at}:`,
      session.url,
    ].join("\n");

  const deviceCode = (url: string, code: string) =>
    [`Open ${url}`, `and approve the code ${bold(code)} there.`].join("\n");

  const signedIn = (file: string) => ok(`Signed in. The organization's token is in ${file}`);

  return {
    ok,
    warnHeading,
    queue,
    progressPrinter,
    summary,
    scaffolded,
    discovered,
    quoted,
    ran,
    connectLink,
    deviceCode,
    signedIn,
  };
};

const priceText = (price: Task["price"]) => {
  if (Predicate.isNull(price)) return "no price";
  if (price.type === "free") return "free";
  const per = `per ${price.per === 1 ? "" : `${price.per} `}${plain(price.unit)}`;
  if (Predicate.isNotNull(price.usd)) {
    const { floor, ceiling } = price.usd;
    return `${floor === ceiling ? `$${floor}` : `$${floor} to $${ceiling}`} ${per}`;
  }

  if (Predicate.isNotNull(price.native)) {
    const { floor, ceiling, currency } = price.native;
    return `${floor === ceiling ? floor : `${floor} to ${ceiling}`} ${plain(currency)} ${per}`;
  }

  return "no price";
};

// A vendor's answer as JSON. JSON escapes C0 controls already; DEL, C1 and format characters such
// as a bidi override are escaped too, so the text cannot rewrite a terminal, and stays the same JSON.
export const vendorJson = (value: unknown) =>
  JSON.stringify(value, null, 2).replace(
    /[\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/gu,
    (character) => `\\u${character.codePointAt(0)?.toString(16).padStart(4, "0")}`,
  );

export const rendering = Effect.suspend(() =>
  colourFor({ stdout: process.stdout.isTTY, stderr: process.stderr.isTTY }),
).pipe(Effect.map(renderer));
