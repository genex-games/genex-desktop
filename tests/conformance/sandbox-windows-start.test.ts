/**
 * The Windows sandbox's first start keeps the process answering: the real srt-win backend, no
 * mocks. The app starts it on Electron's main thread, where a blocked event loop freezes the
 * window ("Not Responding" after five seconds). srt-win's egress check alone runs for seconds on a
 * fresh process, and the folder grants that follow scale with the folders, so the start may run
 * long but must never hold the thread.
 *
 * Its own file, so the start it measures is this process's first: the egress check runs once per
 * process. Windows only, on a machine whose sandbox is provisioned (the Windows CI job does that
 * and sets GENEX_WINDOWS_SANDBOX=ready).
 */
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { ProcessSandbox } from "../../src/substrate/spawn.ts";
import { removeTree, tmpDir } from "../helpers/tmp.ts";

/** Why this machine cannot run the suite, or false when it can. */
function skipReason(): string | false {
  if (process.platform !== "win32") return "Windows only: the srt-win backend";
  if (process.env.GENEX_WINDOWS_SANDBOX !== "ready") return "needs a provisioned sandbox (GENEX_WINDOWS_SANDBOX=ready)";
  return false;
}
const SKIP = skipReason();

const TEST_TIMEOUT_MS = 300_000;
const RUN_TIMEOUT_MS = 60_000;
/** How often the probe asks for a turn of the event loop. */
const TICK_MS = 50;
/** The longest the start may hold the event loop: well under Windows' five-second hung-window rule. */
const LONGEST_STALL_MS = 1_000;

/** Counts the longest wait for a turn of the event loop while it runs; `stop` answers it. */
function stallProbe(): { stop(): number } {
  let last = performance.now();
  let longest = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - last - TICK_MS);
    last = now;
  }, TICK_MS);
  return {
    stop() {
      clearInterval(timer);
      return Math.round(Math.max(longest, performance.now() - last - TICK_MS));
    },
  };
}

let root: string | undefined;
let sandbox: ProcessSandbox | undefined;

after(async () => {
  if (SKIP) return;
  await sandbox?.dispose();
  if (root) await removeTree(root);
});

describe("Windows sandbox: a first start", { skip: SKIP, timeout: TEST_TIMEOUT_MS }, () => {
  it("keeps the event loop turning during the first start and the last session's cleanup", async () => {
    // Long names, as the app's own folders have: `os.tmpdir()` can be spelled with an 8.3 name.
    root = realpathSync.native(await tmpDir("genex-sandbox-start-"));
    const workspace = path.join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const probe = stallProbe();
    const started = performance.now();
    sandbox = await ProcessSandbox.create({
      writableRoots: [workspace],
      scratchDir: path.join(root, "scratch"),
      secretPaths: [],
    });
    const result = await sandbox.run({ command: "echo started", cwd: workspace, timeoutMs: RUN_TIMEOUT_MS });
    const stall = probe.stop();
    const took = Math.round(performance.now() - started);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.sandboxed, true);
    assert.ok(
      stall <= LONGEST_STALL_MS,
      `the start held the event loop for ${stall} ms at once (the whole start took ${took} ms)`,
    );
    const cleanupProbe = stallProbe();
    await sandbox.dispose();
    sandbox = undefined;
    const cleanupStall = cleanupProbe.stop();
    assert.ok(cleanupStall <= LONGEST_STALL_MS, `session cleanup held the event loop for ${cleanupStall} ms at once`);
  });
});
