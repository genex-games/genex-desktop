/**
 * A job's end wakes the lead. The harness reads a run's job ends from the host's registry
 * (`jobs.list`) after a cursor it keeps, so nothing is told twice or lost; an end the lead caused
 * itself is passed over; an app without `jobs.list` wakes nobody and fails nothing; and a resting
 * director is woken soon by a line that names the job. The run's own use of the cursor is in
 * director-journal.test.ts, the Unreal lead's in unreal-lead.test.ts.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JobRole, JobState, JobStopper } from "../../src/harness-seed/loop/jobs/contract.ts";
import { JOB_POLL_MS, jobEnds } from "../../src/harness-seed/loop/jobs/watch.ts";
import { MINUTE_MS, SECOND_MS } from "../../src/harness-seed/loop/time.ts";
import type { JobView } from "../../src/shared/jobs.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";

const T0 = Date.UTC(2026, 9, 7, 14, 0, 0);
const RUN = { project: "plaza", runId: "run-jobs" };
const BUILD_ID = "0b5e3c1a-3f7e-4f3d-9f0e-6f1c2d3e4a5b";
const SERVER_ID = "1c6f4d2b-4a8f-4a4e-8a1f-7a2d3e4f5b6c";

/** A job of the run that ended: a worker's build that failed after four minutes, unless the row says otherwise. */
const ended = (over: Partial<JobView> = {}): JobView => ({
  id: BUILD_ID,
  title: "Unreal build",
  role: JobRole.Worker,
  worker: "Scene builder",
  command: "make build",
  state: JobState.Failed,
  exitCode: 2,
  endedAt: new Date(T0).toISOString(),
  endSeq: 1,
  durationMs: 4 * MINUTE_MS,
  stoppedBy: null,
  ...over,
});

describe("a job's end wakes the lead", () => {
  it("the watcher reads ends after its cursor, once, and skips the lead's own stops", async () => {
    const answers = [
      {
        jobs: [
          ended(),
          ended({ id: SERVER_ID, title: "Server", state: JobState.Stopped, stoppedBy: JobStopper.Agent, endSeq: 2 }),
        ],
        seq: 2,
      },
      { jobs: [], seq: 2 },
    ];
    const rec = ctxRecorder({ handlers: { "jobs.list": () => answers.shift() } });
    const first = await jobEnds(rec.ctx, RUN, 0);
    assert.deepEqual(
      first.ends.map((end) => end.id),
      [BUILD_ID],
      "the stop the lead made is not news",
    );
    assert.equal(first.cursor, 2, "the cursor moves past every end read, the skipped one too");
    const second = await jobEnds(rec.ctx, RUN, first.cursor);
    assert.deepEqual(second, { ends: [], cursor: 2 });
    assert.deepEqual(rec.paramsOf("jobs.list"), [
      { ...RUN, endedAfter: 0 },
      { ...RUN, endedAfter: 2 },
    ]);
  });

  it("an app without jobs.list wakes nobody and fails nothing", async () => {
    const older = ctxRecorder();
    assert.deepEqual(await jobEnds(older.ctx, RUN, 3), { ends: [], cursor: 3 });
    const odd = ctxRecorder({ handlers: { "jobs.list": () => ({ jobs: "none", seq: "x" }) } });
    assert.deepEqual(await jobEnds(odd.ctx, RUN, 3), { ends: [], cursor: 3 }, "an answer it cannot read moves nothing");
    const nothing = ctxRecorder({ handlers: { "jobs.list": () => null } });
    assert.deepEqual(await jobEnds(nothing.ctx, RUN, 0), { ends: [], cursor: 0 });
    assert.ok(JOB_POLL_MS >= SECOND_MS, "the host is asked at most every few seconds");
  });
});
