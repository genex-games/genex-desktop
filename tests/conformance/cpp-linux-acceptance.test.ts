import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AcceptanceJournal, finishAcceptance } from "../../scripts/cpp-linux-evidence.ts";
import { pinnedToolchainFetch } from "../../scripts/ci-cpp-linux-host.ts";
import { assertStarterWitness } from "../../scripts/cpp-linux-browser-witness.mjs";
import { ToolchainHost } from "../../src/shared/toolchain.ts";
import { TOOLCHAIN_MANIFEST } from "../../src/substrate/toolchain-store/manifest.ts";

test("Linux acceptance downloads only the host's pinned archives and forwards cancellation", async () => {
  const calls: Array<{ url: string; signal?: AbortSignal }> = [];
  const response = new Response("fixture");
  const download = pinnedToolchainFetch(ToolchainHost.LinuxX64, async (url, init) => {
    calls.push({ url, signal: init?.signal });
    return response;
  });
  const signal = new AbortController().signal;
  const url = TOOLCHAIN_MANIFEST.find((entry) => entry.host === ToolchainHost.LinuxX64)?.archives[0]?.url;
  assert.ok(url);
  assert.equal(await download(url, { signal }), response);
  assert.deepEqual(calls, [{ url, signal }]);
  for (const refused of ["https://api.anthropic.com/v1/messages", `${url}?other=1`]) {
    await assert.rejects(download(refused), /not a pinned Linux toolchain archive/);
  }
  const mac = TOOLCHAIN_MANIFEST.find((entry) => entry.host === ToolchainHost.MacArm64)?.archives[0]?.url;
  assert.ok(mac);
  await assert.rejects(download(mac), /not a pinned Linux toolchain archive/);
  assert.equal(calls.length, 1);
});

test("browser acceptance requires successful verbs, simulation progress and a clean rendered starter", () => {
  const before = { seed: 7, frame: 0, simulatedMs: 0, running: false, error: null, __render: { drawCalls: 2 } };
  const after = { ...before, frame: 6, simulatedMs: 100 };
  const good = {
    paused: true,
    seeded: 7,
    step: { frame: 6, simulatedMs: 100, steppedFrames: 6, drawCalls: 2 },
    before,
    after,
  };
  assert.doesNotThrow(() => assertStarterWitness(good));
  for (const bad of [
    { ...good, paused: undefined },
    { ...good, seeded: undefined },
    { ...good, step: undefined },
    { ...good, after: { ...after, frame: 0 } },
    { ...good, after: { ...after, simulatedMs: 0 } },
    { ...good, after: { ...after, error: "WebGL failed" } },
    { ...good, after: { ...after, __render: { drawCalls: 0 } } },
  ])
    assert.throws(() => assertStarterWitness(bad));
});

test("Linux acceptance leaves durable phase and command evidence before work can hang", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "cpp-acceptance-journal-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const report: Record<string, unknown> = { stage: "host", passed: false };
  const journal = new AcceptanceJournal(folder, report, () => {});
  journal.phase("first-single-target-setup");
  journal.checkpoint("command-start", { owner: "prewarm", command: "fixture compiler", timeoutMs: 200 });
  const saved = JSON.parse(await readFile(path.join(folder, "summary.json"), "utf8"));
  assert.equal(saved.stage, "first-single-target-setup");
  assert.equal(saved.passed, false);
  const events = (await readFile(path.join(folder, "journal.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(events.at(-1).event, "command-start");
  assert.equal(events.at(-1).command, "fixture compiler");
  assert.equal(events.at(-1).timeoutMs, 200);
});

test("Linux acceptance persists runtime results before bounded cleanup and rejects a stalled disposal", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "cpp-acceptance-cleanup-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const report: Record<string, unknown> = { stage: "browser-state-and-capture", passed: true, browser: { drew: true } };
  const journal = new AcceptanceJournal(folder, report, () => {});
  let beforeDisposal: Record<string, unknown> | undefined;
  const passed = await finishAcceptance(
    journal,
    async () => {
      beforeDisposal = JSON.parse(await readFile(path.join(folder, "summary.json"), "utf8"));
      return new Promise<void>(() => {});
    },
    20,
  );
  assert.equal(passed, false);
  assert.equal(beforeDisposal?.checksPassed, true);
  assert.equal(beforeDisposal?.passed, false);
  assert.deepEqual(beforeDisposal?.browser, { drew: true });
  const saved = JSON.parse(await readFile(path.join(folder, "summary.json"), "utf8"));
  assert.equal(saved.passed, false);
  assert.equal(saved.cleanup.completed, false);
  assert.match(saved.cleanup.error, /cleanup exceeded 20 ms/);
  assert.ok(saved.finishedAt);
});

test("an interrupted Linux acceptance never passes, even when a phase ignores the abort and finishes", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "cpp-acceptance-interrupt-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const report: Record<string, unknown> = { stage: "build-linux", passed: false };
  const journal = new AcceptanceJournal(folder, report, () => {});
  journal.interrupt("SIGTERM");
  // The phase that ignored the signal returns and the runner records its checks as passed.
  report.passed = true;
  assert.equal(await finishAcceptance(journal, async () => {}), false);
  const saved = JSON.parse(await readFile(path.join(folder, "summary.json"), "utf8"));
  assert.equal(saved.passed, false);
  assert.equal(saved.checksPassed, false);
  assert.equal(saved.interrupted.signal, "SIGTERM");
  assert.equal(saved.interrupted.stage, "build-linux");
});
