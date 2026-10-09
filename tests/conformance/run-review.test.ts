/**
 * Morning review reconstruction — the filmstrip is per game, rebuilt from the log alone.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EventEnvelope } from "../../src/substrate/types.ts";
import {
  fillIncumbentShots,
  reviewOutcome,
  lastLoopRunForProject,
  playSnapshotId,
  undoneSelfChanges,
  type RunIterationView,
} from "../../src/shared/run-review.ts";

function envelope(id: string, data: EventEnvelope["data"]): EventEnvelope {
  return {
    id,
    thread_id: "t",
    session_id: null,
    turn_id: null,
    created_at: "2026-08-22T00:00:00.000Z",
    data,
  };
}

function event(id: string, eventType: string, payload: Record<string, unknown>): EventEnvelope {
  return envelope(id, { type: "custom", event_type: eventType, payload });
}

const shot = (camera: string, path: string) => ({ camera, path, bytes: 12 });

describe("lastLoopRunForProject", () => {
  it("does not mash two games into one page", () => {
    const events = [
      event("1", "run_started", { runId: "run-a", project: "alpha", goal: "alpha run" }),
      event("2", "run_iteration", {
        runId: "run-a",
        project: "alpha",
        iteration: 1,
        winner: "challenger",
        snapshot: "snap-a",
        shots: [shot("default", "/runs/a/1.jpg")],
      }),
      event("3", "run_finished", { runId: "run-a", project: "alpha", goal: "alpha run" }),
      event("4", "run_started", { runId: "run-b", project: "beta", goal: "beta run" }),
      event("5", "run_iteration", {
        runId: "run-b",
        project: "beta",
        iteration: 1,
        winner: "incumbent",
        snapshot: "snap-b",
        shots: [shot("default", "/runs/b/1.jpg")],
      }),
      event("6", "run_finished", { runId: "run-b", project: "beta", goal: "beta run" }),
    ];

    const none = lastLoopRunForProject(events, null);
    assert.equal(none.started, null);
    assert.equal(none.iterations.length, 0);

    const alpha = lastLoopRunForProject(events, "alpha");
    assert.equal(alpha.started?.goal, "alpha run");
    assert.equal(alpha.iterations.length, 1);
    assert.equal(alpha.iterations[0]!.snapshot, "snap-a");

    const beta = lastLoopRunForProject(events, "beta");
    assert.equal(beta.started?.goal, "beta run");
    assert.equal(beta.iterations[0]!.snapshot, "snap-b");
  });

  it("attaches legacy iterations (no runId) to the last started run", () => {
    const events = [
      event("1", "run_started", { runId: "run-a", project: "pong", goal: "old log" }),
      event("2", "run_iteration", {
        iteration: 1,
        winner: "challenger",
        snapshot: "snap-1",
        shots: [shot("default", "/runs/a/1.jpg")],
      }),
      event("3", "run_finished", { runId: "run-a", project: "pong" }),
    ];
    const loopRun = lastLoopRunForProject(events, "pong");
    assert.equal(loopRun.iterations.length, 1);
    assert.equal(loopRun.iterations[0]!.runId, "run-a");
    assert.equal(loopRun.iterations[0]!.winner, "challenger");
  });

  it("keeps every iteration of a run far larger than the renderer's 600-event bootstrap tail", () => {
    // The morning-review IPC replays the project's full thread log; a real 3-iteration run is
    // over a thousand events, so the run must survive being buried under later noise.
    const events: EventEnvelope[] = [event("1", "run_started", { runId: "run-x", project: "pong", goal: "long run" })];
    for (let i = 1; i <= 3; i++) {
      events.push(
        event(`iter-${i}`, "run_iteration", {
          runId: "run-x",
          project: "pong",
          iteration: i,
          winner: i === 2 ? "incumbent" : "challenger",
          snapshot: `snap-${i}`,
          shots: [shot("default", `/runs/x/${i}.jpg`)],
        }),
      );
    }
    events.push(event("fin", "run_finished", { runId: "run-x", project: "pong", victory: false }));
    for (let i = 0; i < 700; i++) {
      events.push(event(`noise-${i}`, "context_usage", { tokens: i }));
    }
    const loopRun = lastLoopRunForProject(events, "pong");
    assert.equal(loopRun.started?.goal, "long run");
    assert.equal(loopRun.iterations.length, 3);
    assert.equal(loopRun.iterations[1]!.winner, "incumbent");
    assert.ok(loopRun.finished);
  });

  it("prefers the attempt snapshot when playing a row", () => {
    const row: RunIterationView = {
      iteration: 2,
      iterationId: "002",
      runId: "r",
      project: "pong",
      winner: "incumbent",
      outcome: "rejected",
      biggest_gap: "smear",
      reason: "tie",
      snapshot: "kept",
      attemptSnapshot: "tried",
      shots: [],
      incumbentShots: [],
    };
    assert.equal(playSnapshotId(row), "tried");
    assert.equal(playSnapshotId({ ...row, attemptSnapshot: null }), "kept");
  });
});

describe("undoneSelfChanges", () => {
  const snap = (id: string, snapshotId: string, scope: "harness" | "game" | "both" = "harness") =>
    envelope(id, {
      type: "snapshot_created",
      snapshot_id: snapshotId,
      scope,
      git: scope === "game" ? { game: `c-${snapshotId}` } : { harness: `c-${snapshotId}` },
      healthy: true,
      reason: `snapshot ${snapshotId}`,
    });
  const restore = (id: string, snapshotId: string, scope: "harness" | "game" | "both", reason = "watchdog: wedged") =>
    envelope(id, { type: "workspace_restored", snapshot_id: snapshotId, reason, scope });

  it("flags a change when a later harness-scope restore rewinds past its post snapshot", () => {
    const events = [
      snap("1", "snap-old"),
      snap("2", "snap-pre"),
      snap("3", "snap-post"),
      event("4", "self_edit", {
        file: "loop/agent.mjs",
        reason: "r",
        snapshot_id: "snap-pre",
        post_snapshot_id: "snap-post",
      }),
      restore("5", "snap-old", "harness"),
    ];
    const undone = undoneSelfChanges(events);
    assert.equal(undone.get("snap-pre"), "watchdog: wedged");
  });

  it("flags on a 'both'-scope restore too — its scope covers the harness", () => {
    const events = [
      snap("1", "snap-pre"),
      snap("2", "snap-post"),
      event("3", "skillopt_accepted", { skill: "camera", snapshot_id: "snap-pre", post_snapshot_id: "snap-post" }),
      // The restore target is the change's own pre-write snapshot — older than post by
      // construction, so the flag must not depend on seeing snap-pre's creation order.
      restore("4", "snap-pre", "both", "manual rollback"),
    ];
    const undone = undoneSelfChanges(events);
    assert.equal(undone.get("snap-pre"), "manual rollback");
  });

  it("does not flag when the restore is earlier in the log, game-scope, or not older", () => {
    const events = [
      snap("1", "snap-old"),
      restore("2", "snap-old", "harness"), // before the change: it cannot have undone it
      snap("3", "snap-pre"),
      snap("4", "snap-post"),
      event("5", "self_edit", {
        file: "loop/agent.mjs",
        reason: "r",
        snapshot_id: "snap-pre",
        post_snapshot_id: "snap-post",
      }),
      snap("6", "snap-game", "game"),
      restore("7", "snap-game", "game"), // a game rewind never touches the harness
      restore("8", "snap-post", "harness"), // restoring the post snapshot keeps the change
      snap("9", "snap-newer"),
      restore("10", "snap-newer", "harness"), // newer than post: the change is still in place
      restore("11", "snap-unknown", "harness"), // unknown vintage proves nothing
    ];
    assert.equal(undoneSelfChanges(events).size, 0);
  });

  it("never flags a historical change that has no post snapshot to compare against", () => {
    const events = [
      snap("1", "snap-old"),
      snap("2", "snap-pre"),
      event("3", "self_edit", { file: "tools/x.mjs", reason: "r", snapshot_id: "snap-pre" }),
      restore("4", "snap-old", "harness"),
    ];
    assert.equal(undoneSelfChanges(events).size, 0);
  });
});

describe("fillIncumbentShots", () => {
  it("rebuilds the incumbent strip from the last kept challenger when the log omitted it", () => {
    const first: RunIterationView = {
      iteration: 1,
      iterationId: "001",
      runId: "r",
      project: "pong",
      winner: "challenger",
      outcome: "accepted",
      biggest_gap: "",
      reason: "",
      snapshot: "s1",
      attemptSnapshot: "a1",
      shots: [shot("default", "/a.jpg")],
      incumbentShots: [],
    };
    const second: RunIterationView = {
      ...first,
      iteration: 2,
      iterationId: "002",
      winner: "incumbent",
      outcome: "rejected",
      snapshot: "s1",
      attemptSnapshot: "a2",
      shots: [shot("default", "/b.jpg")],
      incumbentShots: [],
    };
    const filled = fillIncumbentShots([first, second]);
    assert.equal(filled[0]!.incumbentShots.length, 0);
    assert.equal(filled[1]!.incumbentShots[0]!.path, "/a.jpg");
  });
});

describe("director review truthfulness", () => {
  it("uses event timestamps when a director report omits duration, preserving the first start on resume", () => {
    const start = event("1", "run_started", { runId: "r", project: "p", mode: "director" });
    const resume = event("2", "run_started", { runId: "r", project: "p", resumed: true });
    resume.created_at = "2026-08-22T00:20:00.000Z";
    const end = event("3", "run_finished", { runId: "r", project: "p", mode: "director" });
    end.created_at = "2026-08-22T00:23:00.000Z";
    assert.equal(lastLoopRunForProject([start, resume, end], "p").finished?.durationMs, 23 * 60000);
    assert.equal(lastLoopRunForProject([end], "p").finished?.durationMs, null);
  });
  it("does not turn a landed first build into a comparative win", () => {
    assert.deepEqual(
      reviewOutcome({ mode: "director", victory: true, landed: true, landingResult: { verified: false } }),
      { value: "live", label: "result" },
    );
    assert.deepEqual(reviewOutcome({ mode: "director", landed: true, landingResult: { verified: true } }), {
      value: "preferred",
      label: "result",
    });
    assert.deepEqual(reviewOutcome({ victory: true }), { value: "won", label: "vs the bar" });
  });
});
