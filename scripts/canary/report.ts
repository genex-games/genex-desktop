// The canary's report: one table on the run page, and one GitHub issue per release while it fails.
//
//   node scripts/canary/report.ts --results <dir> --tag v0.1.11 --expect macos-26,windows-11 \
//     --run-url <url> [--assignee <login>]
//
// It reads every result.json under --results, writes the table to $GITHUB_STEP_SUMMARY, opens or
// comments on the release's issue when a machine failed (or sent no result), closes it once all
// pass, and exits 1 when anything failed.
import { execFile } from "node:child_process";
import { appendFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";
import {
  CanaryStep,
  type MachineResult,
  mergeMachines,
  machinePassed,
  RESULT_FILE,
  readResult,
  StepOutcome,
  type StepResult,
} from "./results.ts";

const run = promisify(execFile);

/** The label every canary issue carries. */
export const ISSUE_LABEL = "canary";
/** How much of a failed step's detail the issue quotes. */
const DETAIL_CHARS = 600;

const MESSAGE = {
  allPassed: (count: number) => `All ${count} machines passed.`,
  someFailed: (failed: number, count: number) => `${failed} of ${count} machines failed.`,
  noResult: "sent no result: the job stopped before its first step finished",
  issueTitle: (tag: string) => `Release canary: ${tag} fails on real machines`,
  issueClosed: (tag: string, runUrl: string) => `All machines pass ${tag} now: ${runUrl}`,
  rerun: (runUrl: string) => `Still failing in ${runUrl}`,
} as const;

/** How each outcome shows in the table. */
const CELL_MARK = {
  [StepOutcome.Pass]: "✔",
  [StepOutcome.Fail]: "✖",
  [StepOutcome.Warn]: "⚠",
  [StepOutcome.Skip]: "–",
} as const satisfies Record<StepOutcome, string>;

/** The table's step columns, in the order a machine runs them. */
const COLUMNS = Object.values(CanaryStep);

/** One machine's results with a stand-in for each expected machine that wrote none. */
export function withMissing(
  results: readonly MachineResult[],
  expected: readonly string[],
  tag: string,
): MachineResult[] {
  const merged = mergeMachines(results);
  const seen = new Set(merged.map((result) => result.machine));
  const missing = expected.filter((machine) => !seen.has(machine));
  const stand = missing.map(
    (machine): MachineResult => ({
      machine,
      tag,
      steps: [{ step: CanaryStep.Link, outcome: StepOutcome.Fail, detail: MESSAGE.noResult }],
    }),
  );
  return [...merged, ...stand];
}

function cell(steps: readonly StepResult[]): string {
  if (steps.length === 0) return "";
  return steps
    .map((step) => {
      const time = step.seconds === undefined ? "" : ` ${Math.round(step.seconds)} s`;
      const who = step.persona ? `${step.persona} ` : "";
      return `${who}${CELL_MARK[step.outcome]}${time}`;
    })
    .join("<br>");
}

/** The failed steps, one line each, with their detail cut to a readable length. */
export function failureLines(results: readonly MachineResult[]): string[] {
  return results.flatMap((result) =>
    result.steps
      .filter((step) => step.outcome === StepOutcome.Fail)
      .map((step) => {
        const who = step.persona ? ` (${step.persona})` : "";
        const detail = step.detail.replace(/\s+/g, " ").slice(0, DETAIL_CHARS);
        return `- **${result.machine}**${who} · ${step.step}: ${detail}`;
      }),
  );
}

/** The run page's report: the verdict, one row per machine, then what failed. */
export function summaryMarkdown(results: readonly MachineResult[], tag: string, runUrl: string): string {
  const failed = results.filter((result) => !machinePassed(result)).length;
  const verdict = failed ? MESSAGE.someFailed(failed, results.length) : MESSAGE.allPassed(results.length);
  const header = `| Machine | ${COLUMNS.join(" | ")} |`;
  const rule = `|${" --- |".repeat(COLUMNS.length + 1)}`;
  const rows = results.map((result) => {
    const cells = COLUMNS.map((column) => cell(result.steps.filter((step) => step.step === column)));
    return `| ${machinePassed(result) ? "✔" : "✖"} ${result.machine} | ${cells.join(" | ")} |`;
  });
  const failures = failureLines(results);
  const sections = [`## Release canary · ${tag}`, verdict, [header, rule, ...rows].join("\n")];
  if (failures.length) sections.push(`### What failed\n${failures.join("\n")}`);
  sections.push(`[Run and logs](${runUrl})`);
  return `${sections.join("\n\n")}\n`;
}

/** What to do with the release's canary issue. */
export const IssueAction = { Open: "open", Comment: "comment", Close: "close", None: "none" } as const;
export type IssueAction = (typeof IssueAction)[keyof typeof IssueAction];

/** Open one issue when a release first fails, comment on it while it keeps failing, close it once it passes. */
export function issueAction(failed: boolean, openIssue: number | null): IssueAction {
  if (failed) return openIssue === null ? IssueAction.Open : IssueAction.Comment;
  return openIssue === null ? IssueAction.None : IssueAction.Close;
}

async function resultFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name === RESULT_FILE)
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

async function gh(args: string[]): Promise<string> {
  const { stdout } = await run("gh", args, { maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

/** The open canary issue for `tag`, if any. */
async function openIssueFor(tag: string): Promise<number | null> {
  const listed = await gh(["issue", "list", "--label", ISSUE_LABEL, "--state", "open", "--json", "number,title"]);
  const issues = JSON.parse(listed || "[]") as Array<{ number: number; title: string }>;
  return issues.find((issue) => issue.title === MESSAGE.issueTitle(tag))?.number ?? null;
}

async function applyIssue(
  action: IssueAction,
  issue: number | null,
  body: string,
  tag: string,
  runUrl: string,
  assignee?: string,
) {
  if (action === IssueAction.Open) {
    await gh([
      "label",
      "create",
      ISSUE_LABEL,
      "--force",
      "--color",
      "B60205",
      "--description",
      "Release canary failures",
    ]);
    const assign = assignee ? ["--assignee", assignee] : [];
    console.log(
      await gh([
        "issue",
        "create",
        "--title",
        MESSAGE.issueTitle(tag),
        "--label",
        ISSUE_LABEL,
        "--body",
        body,
        ...assign,
      ]),
    );
  }
  if (action === IssueAction.Comment && issue !== null)
    await gh(["issue", "comment", String(issue), "--body", `${MESSAGE.rerun(runUrl)}\n\n${body}`]);
  if (action === IssueAction.Close && issue !== null)
    await gh(["issue", "close", String(issue), "--comment", MESSAGE.issueClosed(tag, runUrl)]);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      results: { type: "string" },
      tag: { type: "string" },
      expect: { type: "string", default: "" },
      "run-url": { type: "string", default: "" },
      assignee: { type: "string" },
      "no-issue": { type: "boolean", default: false },
    },
  });
  if (!values.results || !values.tag) throw new Error("--results and --tag are required");
  const tag = values.tag;
  const runUrl = values["run-url"];
  const read = await Promise.all((await resultFiles(values.results)).map(readResult));
  const expected = values.expect.split(",").filter(Boolean);
  const results = withMissing(read, expected, tag);
  const summary = summaryMarkdown(results, tag, runUrl);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  const failed = results.some((result) => !machinePassed(result));
  if (!values["no-issue"]) {
    const issue = await openIssueFor(tag);
    await applyIssue(issueAction(failed, issue), issue, summary, tag, runUrl, values.assignee || undefined);
  }
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
