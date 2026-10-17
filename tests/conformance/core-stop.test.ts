/**
 * `StudioCore.stop` on quit: one failing step must not skip the ones after it (review PROD-9),
 * or a connector, the harness host or the budget flush would be left behind. And the harness,
 * which runs detached in its own process group, must be gone when the app exits, however long
 * the connectors and previews take to close (B3).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { it } from "node:test";
import { runShutdown, settleWithin, shutdownSteps, type ShutdownTimers } from "../../src/main/app-lifecycle.ts";
import { type JobOwner, JobRole, JobScopeKind, JobState, JobStopper } from "../../src/shared/jobs.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import type { JobSpawn } from "../../src/substrate/jobs.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { running } from "../helpers/processes.ts";
import { startRig } from "../helpers/studio-rig.ts";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** Whether `pid` is gone within a second (Node reaps an exited child on its next turn). */
async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 50 && alive(pid); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  return !alive(pid);
}

it("a plugin turn lease whose release fails does not skip the rest of the shutdown (PROD-9)", async () => {
  const rig = await startRig();
  let closed = false;
  try {
    rig.core.plugins.lease = () => async () => {
      throw new Error("release failed");
    };
    await rig.core.append([{ type: "turn_started" }]);
    const close = rig.core.mcp.close.bind(rig.core.mcp);
    rig.core.mcp.close = async () => {
      closed = true;
      await close();
    };
    await rig.core.stop();
    assert.equal(closed, true, "connectors were still closed after the failed release");
  } finally {
    await rig.core.host.stop().catch(() => {});
    await rig.stop().catch(() => {});
  }
});

it("stopping the core stops the harness before anything that can hang, such as closing connectors (B3)", async () => {
  const rig = await startRig();
  const close = rig.core.mcp.close.bind(rig.core.mcp);
  try {
    const pid = rig.core.host.pid;
    assert.ok(pid && alive(pid), "the rig's harness is running");
    rig.core.mcp.close = () => new Promise<void>(() => {});
    await settleWithin(rig.core.stop(), 4_000, undefined);
    assert.equal(await gone(pid), true, "the harness outlived a quit whose connector close hung");
  } finally {
    rig.core.mcp.close = close;
    await close().catch(() => {});
    await rig.core.host.stop().catch(() => {});
    await rig.stop().catch(() => {});
  }
});

it("quitting kills a harness that will not stop, as the last step before the app exits (B3)", async () => {
  const rig = await startRig();
  const stop = rig.core.host.stop.bind(rig.core.host);
  try {
    const pid = rig.core.host.pid;
    assert.ok(pid && alive(pid), "the rig's harness is running");
    rig.core.host.stop = () => new Promise<void>(() => {});
    // Every bound a twentieth as long, so the test does not wait out the real quit budget.
    const quick: ShutdownTimers = {
      setTimeout: (run, ms) => setTimeout(run, ms / 20),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    const idle = { release() {}, dismiss() {}, cancel() {}, dispose() {} };
    const failed = await runShutdown(
      shutdownSteps({ keepAwake: idle, codexLogin: idle, claudeLogin: idle, terminals: idle, core: rig.core }),
      { log: () => {}, timers: quick },
    );
    assert.deepEqual(failed, ["stop the harness", "stop the studio core"]);
    assert.equal(await gone(pid), true, "the harness outlived the quit");
  } finally {
    rig.core.host.stop = stop;
    await stop().catch(() => {});
    await rig.stop().catch(() => {});
  }
});

/** Starts a job's command in a group of its own, as the sandbox does, without the sandbox. */
const plainJobSpawn: JobSpawn = async (request) => ({
  child: spawn("/bin/sh", ["-c", request.command], { cwd: request.cwd, detached: true, stdio: "pipe" }),
  sandboxed: false,
});

const jobOwner: JobOwner = {
  project: "game",
  chatThreadId: "thread-1",
  role: JobRole.Chat,
  scope: { kind: JobScopeKind.Chat },
};

function killGroup(pid: number | undefined): void {
  try {
    if (pid) process.kill(-pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

it("quitting stops every agent job after the harness and before the sandbox closes, and leaves other apps alone", {
  skip: process.platform === "win32" && "process groups and /bin/sh are POSIX",
}, async () => {
  const rig = await startRig({}, { jobSpawn: plainJobSpawn });
  // Stands in for an app a person can see, such as the editor a plugin opened: not a job.
  const other = spawn("/bin/sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
  const job = await rig.core.jobs.start({
    owner: jobOwner,
    title: "Server",
    command: "sleep 30",
    cwd: rig.userData,
    policy: {},
    mode: PermissionMode.Auto,
  });
  const seen: string[] = [];
  const hostStop = rig.core.host.stop.bind(rig.core.host);
  const dispose = rig.core.sandbox.dispose.bind(rig.core.sandbox);
  try {
    rig.core.host.stop = async () => {
      seen.push(`host stop, job ${running(job.pid ?? 0) ? "running" : "gone"}`);
      await hostStop();
    };
    rig.core.sandbox.dispose = async () => {
      seen.push(`sandbox dispose, job ${running(job.pid ?? 0) ? "running" : "gone"}`);
      await dispose();
    };
    await rig.core.stop();
    assert.deepEqual(seen, ["host stop, job running", "sandbox dispose, job gone"]);
    const record = await rig.core.jobs.get(jobOwner.project, job.id);
    assert.equal(record?.state, JobState.Stopped);
    assert.equal(record?.stoppedBy, JobStopper.Quit);
    assert.ok(other.pid && running(other.pid), "a process that is not a job is left running");
  } finally {
    rig.core.host.stop = hostStop;
    rig.core.sandbox.dispose = dispose;
    killGroup(job.pid);
    killGroup(other.pid);
    await rig.stop().catch(() => {});
  }
});

it("a core that never started still stops the jobs it was handed when it stops", {
  skip: process.platform === "win32" && "process groups and /bin/sh are POSIX",
}, async () => {
  const lite = await coreLite({ jobSpawn: plainJobSpawn });
  const job = await lite.core.jobs.start({
    owner: jobOwner,
    title: "Server",
    command: "sleep 30",
    cwd: lite.userData,
    policy: {},
    mode: PermissionMode.Auto,
  });
  try {
    await lite.close();
    assert.equal(running(job.pid ?? 0), false);
    assert.equal((await lite.core.jobs.get(jobOwner.project, job.id))?.stoppedBy, JobStopper.Quit);
  } finally {
    killGroup(job.pid);
  }
});
