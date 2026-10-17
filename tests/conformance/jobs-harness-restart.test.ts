/**
 * The app, not the harness, owns the agents' long processes: a job started through the real
 * sandbox keeps running while the harness restarts, and the registry still answers for it.
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import { type JobOwner, type JobRecord, JobRole, JobScopeKind, JobState, JobStopper } from "../../src/shared/jobs.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import { running } from "../helpers/processes.ts";
import { startRig } from "../helpers/studio-rig.ts";

const owner: JobOwner = {
  project: "game",
  chatThreadId: "thread-1",
  role: JobRole.Chat,
  scope: { kind: JobScopeKind.Chat },
};

it("a job outlives a harness restart, and the registry still lists it", {
  skip: process.platform === "win32" && "the POSIX process check",
}, async () => {
  const rig = await startRig();
  let job: JobRecord | undefined;
  try {
    job = await rig.core.jobs.start({
      owner,
      title: "Idle",
      command: `"${process.execPath}" -e "setTimeout(() => {}, 20000)"`,
      cwd: rig.core.layout.gamesRoot,
      policy: { allowedDomains: [], allowLocalBinding: true },
      mode: PermissionMode.Auto,
    });
    const pid = job.pid ?? 0;
    assert.ok(running(pid), "the job runs");
    await rig.core.host.restart();
    assert.ok(running(pid), "the job outlived the harness restart");
    const listed = await rig.core.jobs.list(owner.project);
    assert.deepEqual(
      listed.map((record) => [record.id, record.state]),
      [[job.id, JobState.Running]],
    );
  } finally {
    if (job) await rig.core.jobs.stop(owner.project, job.id, JobStopper.Agent);
    await rig.stop();
  }
});
