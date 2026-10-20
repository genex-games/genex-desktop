// The agent command: the installed app's own self test (--studio-selftest, driven by the release's
// tests/e2e/run-electron-e2e.mjs against its fake engine) up to the chat turn whose agent runs its
// tools inside the sandbox. The canary stops it there: the rest of the self test checks games and
// Loop runs, which on a machine without a GPU says more about the machine than about the release.
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { MINUTE_MS } from "../../src/shared/duration.ts";
import type { Verdict } from "./platforms.ts";
import { StepOutcome } from "./results.ts";

/**
 * The self test's checks (src/main/smoke/selftest.ts) that make up one sandboxed agent command:
 * the harness starts in the sandbox, a chat turn on the fake engine ends, and its agent's tools ran
 * and wrote a file. The app prints each as `[selftest] PASS|FAIL <name>: <detail>` as it finishes.
 */
export const AGENT_CHECKS = [
  "harness boots inside the sandbox",
  "a chat turn completes end to end",
  "tools ran and were logged",
  "the agent wrote a game file",
] as const;
/**
 * The self test's Claude worker checks (src/main/smoke/claude-worker-check.ts), right after the chat
 * turn: one Loop worker on the real Claude Code CLI, which the vendor's installer puts in a home of
 * the stage's own, its model the runner's scripted Anthropic stand-in. Windows only, where Claude
 * Code's own sandbox cannot start and Genex's runs the worker's commands instead.
 */
export const CLAUDE_WORKER_CHECKS = [
  "the Claude Code CLI is installed",
  "a Claude worker ran its turn without being refused",
  "the Claude worker's command ran in its sandbox and wrote its folder",
] as const;
/** The runner switch that adds the Claude worker stage; a release whose runner lacks it never had one. */
const CLAUDE_WORKER_SWITCH = "--claude-worker";
const SELFTEST_LINE = /^\[selftest\] (PASS|FAIL) (.+?)(?:: (.*))?$/gm;
/**
 * The self test's own limit is 8 minutes; the agent checks come in its first few, and the Claude
 * worker's after them, its CLI download included.
 */
const AGENT_COMMAND_TIMEOUT_MS = 15 * MINUTE_MS;

/** Each self-test check seen so far, by name: whether it passed and what it said. */
export function readSelfTest(text: string): Map<string, { ok: boolean; detail: string }> {
  const seen = new Map<string, { ok: boolean; detail: string }>();
  for (const [, verdict, name, detail] of text.matchAll(SELFTEST_LINE))
    if (name) seen.set(name.trim(), { ok: verdict === "PASS", detail: detail ?? "" });
  return seen;
}

/**
 * The checks this machine's step waits for: the agent checks, and on Windows the Claude worker's
 * when the release's runner has that stage (`runnerText`, its source).
 */
export function agentChecksFor(platform: NodeJS.Platform, runnerText: string): readonly string[] {
  const claudeWorker = platform === "win32" && runnerText.includes(CLAUDE_WORKER_SWITCH);
  return claudeWorker ? [...AGENT_CHECKS, ...CLAUDE_WORKER_CHECKS] : AGENT_CHECKS;
}

/** Whether every check the step waits for has reported. */
export function agentChecksDone(seen: ReadonlyMap<string, unknown>, checks: readonly string[] = AGENT_CHECKS): boolean {
  return checks.every((name) => seen.has(name));
}

/** The step's verdict from the checks seen: each check it waits for must have passed. */
export function agentVerdict(
  seen: ReadonlyMap<string, { ok: boolean; detail: string }>,
  exit: string,
  checks: readonly string[] = AGENT_CHECKS,
): Verdict {
  const missing = checks.filter((name) => !seen.has(name));
  const failed = checks.filter((name) => seen.get(name)?.ok === false);
  if (missing.length === 0 && failed.length === 0)
    return { outcome: StepOutcome.Pass, detail: `${checks.length}/${checks.length} agent checks passed` };
  const lines = [
    ...failed.map((name) => `failed: ${name}: ${seen.get(name)?.detail ?? ""}`),
    ...missing.map((name) => `never reported: ${name}`),
  ];
  return { outcome: StepOutcome.Fail, detail: `${lines.join("; ")} (${exit})` };
}

/** Run the release's e2e runner on the installed app until the agent checks report; its verdict. */
export async function runAgentCommand(releaseSrc: string, packageDir: string, logFile: string): Promise<Verdict> {
  const runner = path.join(releaseSrc, "tests", "e2e", "run-electron-e2e.mjs");
  if (!existsSync(runner)) return { outcome: StepOutcome.Skip, detail: `no ${runner}` };
  const checks = agentChecksFor(process.platform, readFileSync(runner, "utf8"));
  const claudeWorker = checks.length > AGENT_CHECKS.length ? [CLAUDE_WORKER_SWITCH] : [];
  const out = createWriteStream(logFile);
  const child = spawn(process.execPath, [runner, "--packaged", ...claudeWorker], {
    cwd: releaseSrc,
    env: { ...process.env, STUDIO_PACKAGE_DIR: packageDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let text = "";
  let stopped = false;
  const listen = (chunk: Buffer) => {
    out.write(chunk);
    text += chunk.toString("utf8");
    if (!stopped && agentChecksDone(readSelfTest(text), checks)) {
      stopped = true;
      child.kill();
    }
  };
  child.stdout.on("data", listen);
  child.stderr.on("data", listen);
  const timer = setTimeout(() => child.kill("SIGKILL"), AGENT_COMMAND_TIMEOUT_MS);
  const code = await new Promise<number | null>((resolve) => child.on("close", (exit) => resolve(exit)));
  clearTimeout(timer);
  await new Promise((resolve) => out.end(resolve));
  const exit = stopped ? "stopped after the agent checks" : `runner exited ${code ?? "on a signal"}`;
  return agentVerdict(readSelfTest(text), exit, checks);
}
