import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cliInstallProblemWords,
  finishingInstall,
  installRunning,
  newerReport,
} from "../../src/renderer/cli-install.ts";
import { CliInstallPhase, CliInstallProblem, type CliInstallJob } from "../../src/shared/cli-install.ts";

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

test("an install that just finished reads as installing until the engines are read again, so Install never flashes back", () => {
  // The install's own news: the job finished here while the row still shows the old engines.
  const waiting = finishingInstall({ job: finished });
  assert.equal(installRunning(finished, waiting), true, "finished, but the engines still say the CLI is missing");
  assert.equal(installRunning(finished, finishingInstall({ enginesRead: true })), false);
  // A failed install has nothing to wait for.
  const failed: CliInstallJob = { ...finished, phase: CliInstallPhase.Failed, problem: CliInstallProblem.Installer };
  assert.equal(installRunning(failed, finishingInstall({ job: failed })), false);
  // A finished install read at mount (not watched finishing) waits for nothing.
  assert.equal(installRunning(finished, null), false);
  assert.equal(installRunning(started, null), true);
  // A new install's news replaces the old wait.
  const again: CliInstallJob = { ...started, startedAt: "2026-09-28T12:05:00.000Z" };
  assert.equal(installRunning(finished, finishingInstall({ job: again })), false);
});
