import { test } from "node:test";
import assert from "node:assert/strict";
import { cliInstallProblemWords, newerReport } from "../../src/renderer/cli-install.ts";
import {
  CliInstallOperation,
  CliInstallPhase,
  CliInstallProblem,
  type CliInstallJob,
} from "../../src/shared/cli-install.ts";

const started: CliInstallJob = {
  provider: "codex",
  phase: CliInstallPhase.Installing,
  startedAt: "2026-09-28T12:00:00.000Z",
};
const finished: CliInstallJob = {
  ...started,
  phase: CliInstallPhase.Installed,
  finishedAt: "2026-09-28T12:01:00.000Z",
};

test("Install's own answer never undoes the news that the same install already finished", () => {
  assert.equal(newerReport(null, started), started);
  assert.equal(newerReport(finished, started), finished, "a late answer for the finished install");
  assert.equal(newerReport(started, finished), finished);
  const again: CliInstallJob = { ...started, startedAt: "2026-09-28T12:05:00.000Z" };
  assert.equal(newerReport(finished, again), again, "a new install replaces the last one");
});

test("only a failed install has words, one line per reason, naming the CLI", () => {
  assert.equal(cliInstallProblemWords(null), null);
  assert.equal(cliInstallProblemWords(started), null);
  assert.equal(cliInstallProblemWords(finished), null);
  const lines = Object.values(CliInstallProblem).map((problem) =>
    cliInstallProblemWords({ ...finished, phase: CliInstallPhase.Failed, problem }),
  );
  for (const line of lines) assert.match(String(line), /Codex/);
  assert.equal(new Set(lines).size, lines.length);
  assert.match(
    String(
      cliInstallProblemWords({
        ...finished,
        provider: "claude-code",
        phase: CliInstallPhase.Failed,
        problem: CliInstallProblem.Download,
      }),
    ),
    /Claude Code/,
  );
});

test("a failed update of an app's own copy names the app to update", () => {
  const failed: CliInstallJob = {
    ...finished,
    operation: CliInstallOperation.Update,
    phase: CliInstallPhase.Failed,
    problem: CliInstallProblem.AppManaged,
  };
  assert.match(String(cliInstallProblemWords(failed)), /Update the ChatGPT app/);
  assert.match(String(cliInstallProblemWords({ ...failed, provider: "claude-code" })), /Update the Claude app/);
  const other = String(cliInstallProblemWords({ ...failed, provider: "grok" }));
  assert.match(other, /Update the app/);
  const generic = cliInstallProblemWords({ ...failed, problem: CliInstallProblem.Installer });
  assert.notEqual(cliInstallProblemWords(failed), generic);
});
