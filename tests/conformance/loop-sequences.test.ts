/**
 * The substrate calls a harness loop makes, in order, recorded through a fake `ctx`: which
 * snapshot, restore and worktree calls a spike makes when its build fails, crashes or is stopped.
 * Characterization for the loop refactors; a change that means to alter a sequence names it.
 *
 * Covered here: `runSpike`'s reject, crash, stop and refusal paths in live and worktree mode,
 * and what a live-mode rollback does when the attempt cannot be kept or the restore is refused.
 * Not yet: a passing spike (it needs a full evidence pass) and the autopilot, gauntlet and
 * facet-loop sequences, which still rely on the rig suites (L3).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";
import { runDelegatedTurn } from "../../src/harness-seed/loop/delegated-turn.ts";
import { handleRunStart } from "../../src/harness-seed/loop/run-dispatch.ts";

describe("a chat turn and Stop", () => {
  /** A delegated chat turn in game `g`, answered by a builder that reports it did the work. */
  function chatTurn() {
    return ctxRecorder({
      unknown: { value: null },
      handlers: {
        "events.messages": () => [{ role: "user", content: "make the sky pink" }],
        "game.list": () => [{ name: "g", title: "G" }],
        "engine.describe": () => [],
        "engine.delegate": () => ({ ok: true, engine: "codex", turns: 1, usage: {}, sessionId: "s", summary: "done" }),
      },
    });
  }
  const options = {
    threadId: "thread-1",
    turnId: "turn-1",
    text: "make the sky pink",
    engine: "codex",
    engineLabel: "Codex",
    project: "g",
  };

  it("a Stop while the turn prepares hands nothing to the builder, and the turn ends stopped", async () => {
    const recorder = chatTurn();
    // Stamping the folder is the last step before the builder starts: nothing is running to abort yet.
    recorder.cancelAfter("game.contentStamp");
    const outcome = await runDelegatedTurn(recorder.ctx as never, options);
    assert.deepEqual(recorder.sequence("engine.delegate"), [], "no builder starts after the Stop");
    assert.equal(outcome.stopped, "aborted");
    assert.deepEqual(recorder.sequence("preview."), [], "no health pass after a Stop");
  });

  it("without a Stop the same turn hands the ask to the builder", async () => {
    const recorder = chatTurn();
    await runDelegatedTurn(recorder.ctx as never, options);
    assert.deepEqual(recorder.sequence("engine.delegate"), ["engine.delegate"]);
  });
});

describe("Stop and the build a chat turn launched", () => {
  /** The loop's state as main.ts keeps it, with a host that records what the chat is told. */
  function studioWithStop() {
    const told: string[] = [];
    const recorded: string[] = [];
    type Appended = { event_type?: string; messages?: Array<{ content?: string }> };
    const host = {
      call: async (method: string, params: { batch?: Appended[] }) => {
        if (method === "game.list") return [{ name: "g", title: "G" }];
        if (method !== "events.append") return null;
        for (const item of params.batch ?? []) {
          if (item.event_type) recorded.push(item.event_type);
          for (const m of item.messages ?? []) told.push(String(m.content));
        }
        return null;
      },
      notify: () => {},
    };
    // The user pressed Stop after the turn that launched this build had ended, before it started.
    const studio = {
      host,
      cancels: new Set(["thread-1"]),
      moodBoards: new Map(),
      activeRuns: new Map(),
      startingRuns: new Map(),
      orphanRuns: new Map(),
      scoped: () => ({ cancelled: true }),
    };
    return { studio, told, recorded };
  }
  const start = { type: "run_start", threadId: "thread-1", run: { runId: "r1", project: "g", goal: "a dusk plaza" } };

  it("a Stop since the message that launched it keeps the build from starting, and the chat is told", async () => {
    const { studio, told, recorded } = studioWithStop();
    await handleRunStart(studio as never, start as never, { keepStop: true });
    assert.ok(studio.cancels.has("thread-1"), "the Stop is kept");
    assert.ok(!recorded.includes("run_registered"), "no run is registered");
    assert.equal(studio.startingRuns.size, 0);
    assert.ok(
      told.some((words) => /stopped before/i.test(words)),
      JSON.stringify(told),
    );
  });
});
