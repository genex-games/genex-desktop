/**
 * Reading a packaged first start for run-sandbox-start-packaged.mjs: the start steps the app logs,
 * the report `--studio-sandbox-start-smoke` prints (`src/main/smoke/sandbox-start.ts`) and the
 * verdict against the runner's budget.
 */

/** The step a failed Windows start logs, with srt-win's error in place of a time. */
export const START_FAILED = "background start failed";

/**
 * One start step from a line of the app's stderr: `[sandbox] <step>: <n> ms` (srt-win's own steps
 * are `srt-win <step>`), the whole Windows start (`started in the background in <n> ms`) or its
 * failure; null for any other line.
 */
export function sandboxStep(line) {
  const text = line.trimEnd();
  const failed = /\[sandbox\] background start failed: (.*)$/.exec(text);
  if (failed) return { step: START_FAILED, error: failed[1] };
  const whole = /\[sandbox\] (started in the background) in (\d+) ms$/.exec(text);
  const step = whole ?? /\[sandbox\] (.+): (\d+) ms$/.exec(text);
  return step ? { step: step[1], ms: Number(step[2]) } : null;
}

/** The report the app printed between its markers, or null when it printed none. */
export function sandboxStartReport(stdout) {
  const match = /__SANDBOX_START_JSON__([\s\S]*?)__END__/.exec(stdout);
  return match ? JSON.parse(match[1]) : null;
}

/** Whether the first start passes: its command ran, sandboxed, and ended within `budgetMs` of launch. */
export function sandboxStartVerdict(report, budgetMs) {
  if (!report) return { ok: false, reason: "the app gave no report: its first sandboxed command never ended" };
  const after = `${report.firstCommandMs} ms after launch`;
  if (!report.ok) {
    return {
      ok: false,
      reason: `the first sandboxed command failed ${after}: ${report.error ?? `exit ${report.code}`}`,
    };
  }
  if (report.firstCommandMs > budgetMs) {
    return { ok: false, reason: `the first sandboxed command ended ${after}, over the ${budgetMs} ms budget` };
  }
  return { ok: true, reason: `the first sandboxed command ended ${after}, within the ${budgetMs} ms budget` };
}

/** The job summary in Markdown: the verdict, then each logged step with when it ended. */
export function sandboxStartSummary(verdict, steps) {
  const cell = (text) => text.replaceAll(/\s+/g, " ").replaceAll("|", "\\|");
  const rows = steps.map(
    ({ at, step, ms, error }) => `| ${at} ms | ${cell(step)} | ${error ? cell(error) : `${ms} ms`} |`,
  );
  const table = rows.length
    ? ["| Ended after launch | Step | Took |", "|---:|---|---:|", ...rows]
    : ["No start steps logged."];
  return ["### Packaged first start", "", `${verdict.ok ? "✅" : "❌"} ${cell(verdict.reason)}`, "", ...table, ""].join(
    "\n",
  );
}
