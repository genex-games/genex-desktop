import assert from "node:assert/strict";
import { ChildProcess, execFile } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, it } from "node:test";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { MINUTE_MS } from "../../src/shared/duration.ts";

const run = promisify(execFile);
const FIXTURE = fileURLToPath(new URL("../fixtures/windows-acl-cleanup.mjs", import.meta.url));
const CHILD_TIMEOUT_MS = 15_000;
const REPLY = fileURLToPath(new URL("../fixtures/srt-acl-reply.mjs", import.meta.url));
const HANG = fileURLToPath(new URL("../fixtures/srt-acl-hang.mjs", import.meta.url));
const SYNC_DEADLINES = fileURLToPath(new URL("../fixtures/srt-acl-deadline.mjs", import.meta.url));
/** How long srt-win may take over an ACL call or the egress check: two minutes, for a slow disk or an antivirus scan. */
const SRT_WIN_DEADLINE_MS = 2 * MINUTE_MS;
const require = createRequire(import.meta.url);
const dist = path.join(path.dirname(require.resolve("@anthropic-ai/sandbox-runtime/package.json")), "dist");
const windows = await import(pathToFileURL(path.join(dist, "sandbox/windows-sandbox-utils.js")).href);

interface CleanupReport {
  events: string[];
  calls: { kind: string; opts: { sandboxUserSid: string; srtWin: { exe: string; prependArgs: string[] } } }[];
  beforeRelease: string[];
  settledBeforeRelease: boolean;
  originalError?: boolean;
}

type ReleaseOpts = { sandboxUserSid: string; holderPid?: number; srtWin: { exe: string; prependArgs: string[] } };

/** The async release `action` runs through (the patch's twins), answering its per-path outcomes. */
async function release(action: string, opts: ReleaseOpts): Promise<{ path: string; status: string }[] | undefined> {
  if (action === "restore") return windows.restoreWindowsAclAsync(opts);
  return (await windows.revokeWindowsAclCheckedAsync(opts)).outcomes;
}

async function exercise(scenario: string): Promise<CleanupReport> {
  const { stdout } = await run(process.execPath, ["--experimental-test-module-mocks", FIXTURE, scenario], {
    timeout: CHILD_TIMEOUT_MS,
    windowsHide: true,
  });
  return JSON.parse(stdout);
}

function assertAsyncCleanup(report: CleanupReport): void {
  assert.deepEqual(report.beforeRelease.slice(-1), ["async revoke start"]);
  assert.equal(report.settledBeforeRelease, false, "cleanup must finish before reset/rejection settles");
  assert.deepEqual(report.events.slice(-4), [
    "async revoke start",
    "async revoke end",
    "async restore start",
    "async restore end",
  ]);
  assert.deepEqual(
    report.calls.map(({ kind }) => kind),
    ["revoke", "restore"],
    "a second reset has no ACL work",
  );
  for (const { opts } of report.calls) {
    assert.deepEqual(opts, { sandboxUserSid: "fixture-sid", srtWin: { exe: "fixture-srt-win", prependArgs: [] } });
  }
}

describe("Windows ACL cleanup keeps the main process responsive", () => {
  it("yields during reset and waits for both cleanup commands", async () => {
    assertAsyncCleanup(await exercise("reset"));
  });

  it("yields during partial grant rollback and preserves the original error", async () => {
    const report = await exercise("grant-failure");
    assertAsyncCleanup(report);
    assert.equal(report.originalError, true);
  });

  it("yields during the rollback after a failed egress check and preserves the original error", async () => {
    const report = await exercise("egress-failure");
    assertAsyncCleanup(report);
    assert.equal(report.originalError, true);
  });

  it("uses async cleanup for a termination signal while the event loop still runs", async () => {
    const report = await exercise("signal");
    assert.deepEqual(report.beforeRelease.slice(-1), ["async revoke start"]);
    assert.deepEqual(
      report.calls.map(({ kind }) => kind),
      ["revoke", "restore"],
    );
  });

  it("retains synchronous cleanup on actual process exit after initialization", async () => {
    const report = await exercise("exit-ready");
    assert.deepEqual(report.events.slice(-2), ["sync revoke", "sync restore"]);
  });

  it("cleans a grant still being written synchronously if the process exits during initialization", async () => {
    const report = await exercise("exit-grant");
    assert.deepEqual(report.events, ["grant", "sync revoke", "sync restore"]);
  });

  it("retains exit cleanup while an async rollback is still pending", async () => {
    const report = await exercise("exit-rollback");
    assert.deepEqual(report.events, ["grant", "egress", "async revoke start", "sync revoke", "sync restore"]);
  });
});

describe("async Windows ACL cleanup transport", () => {
  it("uses the same holder, SID, binary and JSON arguments while letting the event loop run", async () => {
    for (const action of ["revoke", "restore"]) {
      let turned = false;
      const tick = setImmediate().then(() => {
        turned = true;
      });
      const outcomes = await release(action, {
        sandboxUserSid: "fixture sid with spaces",
        holderPid: 12345,
        srtWin: { exe: process.execPath, prependArgs: [REPLY, "array"] },
      });
      assert.equal(turned, true, "ACL subprocess must not block the caller's event loop");
      await tick;
      assert.ok(outcomes?.[0], action);
      assert.deepEqual(JSON.parse(outcomes[0].path), [
        "acl",
        action,
        "--holder-pid",
        "12345",
        "--sandbox-user-sid",
        "fixture sid with spaces",
        "--json",
      ]);
    }
  });

  it("retains legacy restore path and parent outcomes and defaults to the current holder PID", async () => {
    const outcomes = await windows.restoreWindowsAclAsync({
      sandboxUserSid: "fixture-sid",
      srtWin: { exe: process.execPath, prependArgs: [REPLY, "legacy"] },
    });
    assert.equal(outcomes[1].status, "stillHeld");
    assert.equal(JSON.parse(outcomes[0].path)[3], String(process.pid));
  });

  it("retains per-path outcomes on a nonzero cleanup exit", async () => {
    for (const action of ["revoke", "restore"]) {
      const outcomes = await release(action, {
        sandboxUserSid: "fixture-sid",
        srtWin: { exe: process.execPath, prependArgs: [REPLY, "partial"] },
      });
      assert.equal(outcomes?.[0]?.status, "revoked");
    }
  });

  it("keeps cleanup best effort on malformed JSON and a missing executable", async () => {
    for (const action of ["revoke", "restore"]) {
      for (const srtWin of [
        { exe: process.execPath, prependArgs: [REPLY, "bad-json"] },
        { exe: path.join(dist, "fixture-missing-srt-win"), prependArgs: [] },
      ]) {
        assert.equal(await release(action, { sandboxUserSid: "fixture-sid", srtWin }), undefined);
      }
    }
  });
});

describe("srt-win gets two minutes for the session release and the egress check", () => {
  it("gives srt-win two minutes for each synchronous revoke and restore", async () => {
    const { stdout } = await run(process.execPath, ["--experimental-test-module-mocks", SYNC_DEADLINES], {
      timeout: CHILD_TIMEOUT_MS,
      windowsHide: true,
    });
    assert.deepEqual(JSON.parse(stdout), {
      "acl revoke": SRT_WIN_DEADLINE_MS,
      "acl restore": SRT_WIN_DEADLINE_MS,
    });
  });

  it("stops a silent srt-win at two minutes, not before, on each async release and the egress check", async (t) => {
    const opts = { sandboxUserSid: "fixture-sid", srtWin: { exe: process.execPath, prependArgs: [HANG] } };
    const calls = {
      revoke: () => release("revoke", opts),
      restore: () => release("restore", opts),
      egress: () => windows.verifyWindowsWfpEgress({ target: "127.0.0.1:9", srtWin: opts.srtWin }),
    };
    const kill = t.mock.method(ChildProcess.prototype, "kill");
    t.mock.timers.enable({ apis: ["setTimeout"] });
    for (const [verb, call] of Object.entries(calls)) {
      kill.mock.resetCalls();
      const outcome = call().then(
        () => null,
        (error: { code?: string }) => error.code,
      );
      t.mock.timers.tick(SRT_WIN_DEADLINE_MS - 1);
      assert.equal(kill.mock.callCount(), 0, `${verb}: srt-win still has its time`);
      t.mock.timers.tick(1);
      assert.equal(kill.mock.callCount(), 1, `${verb}: srt-win is stopped at the deadline`);
      // An egress check that ran out of time fails the start; a revoke or restore stays best effort.
      const expected = verb === "revoke" || verb === "restore" ? null : "srt_win_timeout";
      assert.equal(await outcome, expected, verb);
    }
  });
});
