/**
 * The packaged app's first sandbox start on this machine's profile, timed from launch through one
 * sandboxed command (`--studio-sandbox-start-smoke`, in a disposable smoke profile). It fails when
 * that command fails or ends later than FIRST_START_BUDGET_MS after launch, and prints each start
 * step the app logs as it ends (`[sandbox] <step>: N ms`, srt-win's own among them); in CI they go
 * to the job summary too. CI seeds a heavy profile first (`scripts/ci-heavy-profile.mjs`), since the
 * Windows deny stamp walks the whole profile. Evidence: .studio-dev/evidence/sandbox-start-packaged.json.
 *
 *   npm run package && node tests/e2e/run-sandbox-start-packaged.mjs
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fixtureElectronArgs, fixtureElectronEnv } from "../../scripts/electron-runtime.mjs";
import { startFakeOllama } from "../helpers/fake-ollama.ts";
import { packagedApp } from "./packaged-app.mjs";
import { sandboxStartReport, sandboxStartSummary, sandboxStartVerdict, sandboxStep } from "./sandbox-start-report.mjs";

/**
 * From launch until the first sandboxed command ends: how long a person waits the first time Genex
 * starts. srt-win gives each of its own steps 60 s, and the deny stamp ran past that on a large profile.
 */
const FIRST_START_BUDGET_MS = 60_000;
/** How long past the budget the runner still waits for the app's report, to show how the start ends. */
const REPORT_GRACE_MS = 180_000;
/** How long the app may take to quit after its report before the runner stops it. */
const EXIT_GRACE_MS = 60_000;
/** The tail of the app's stderr printed when it gives no report. */
const STDERR_TAIL_CHARS = 6_000;
const EVIDENCE = path.join(".studio-dev", "evidence", "sandbox-start-packaged.json");

const { bin } = packagedApp(path.resolve("."));
const fake = await startFakeOllama({ respond: () => ({ text: "Sandbox start fixture" }) });
console.log(`launching the packaged app for its first sandbox start (budget ${FIRST_START_BUDGET_MS} ms)…\n  ${bin}`);
const launched = performance.now();
const child = spawn(
  bin,
  fixtureElectronArgs(["--studio-smoke", "--studio-sandbox-start-smoke", `--ollama-host=${fake.host}`]),
  { env: fixtureElectronEnv(), stdio: ["ignore", "pipe", "pipe"] },
);
const steps = [];
let stdout = "";
let stderrTail = "";
child.stdout.setEncoding("utf8");
readline.createInterface({ input: child.stderr }).on("line", (line) => {
  stderrTail = `${stderrTail}${line}\n`.slice(-STDERR_TAIL_CHARS);
  const step = sandboxStep(line);
  if (!step) return;
  const at = Math.round(performance.now() - launched);
  steps.push({ at, ...step });
  console.log(`  ${String(at).padStart(7)} ms  ${step.step}: ${step.error ?? `${step.ms} ms`}`);
});

const report = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(sandboxStartReport(stdout)), FIRST_START_BUDGET_MS + REPORT_GRACE_MS);
  const done = (value) => {
    clearTimeout(timer);
    resolve(value);
  };
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    const found = sandboxStartReport(stdout);
    if (found) done(found);
  });
  // `close`, not `exit`: the report may still be in the pipe when the process has exited.
  child.on("close", () => done(sandboxStartReport(stdout)));
  child.on("error", (error) => {
    console.error(`could not launch the packaged app: ${error.message}; run \`npm run package\` first`);
    done(null);
  });
});
const running = child.exitCode === null && child.signalCode === null;
const quit =
  !running ||
  (await once(child, "exit", { signal: AbortSignal.timeout(EXIT_GRACE_MS) }).then(
    () => true,
    () => false,
  ));
if (!quit) {
  console.log(`::warning title=Packaged first start::the app did not quit within ${EXIT_GRACE_MS} ms of its report`);
  child.kill("SIGKILL");
}
await fake.close();

const verdict = sandboxStartVerdict(report, FIRST_START_BUDGET_MS);
if (!report) console.error(stderrTail);
await mkdir(path.dirname(EVIDENCE), { recursive: true });
await writeFile(
  EVIDENCE,
  JSON.stringify({ verdict, report, steps, budgetMs: FIRST_START_BUDGET_MS, profile: os.homedir() }, null, 2),
);
if (process.env.GITHUB_STEP_SUMMARY)
  await appendFile(process.env.GITHUB_STEP_SUMMARY, sandboxStartSummary(verdict, steps));
console.log(`${verdict.ok ? "✔" : "✖"} ${verdict.reason}`);
if (!verdict.ok && process.env.GITHUB_ACTIONS === "true") {
  console.log(`::error title=Packaged first start::${verdict.reason.replaceAll(/\s+/g, " ")}`);
}
process.exitCode = verdict.ok ? 0 : 1;
