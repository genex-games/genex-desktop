/**
 * `wake_later`: the chat's own session sets a timer and ends its turn, and Genex starts the chat's
 * next turn when it is due, with the agent's note. An agent that waits for a download in a
 * launcher no longer holds its turn open, so the person's words are answered at once meanwhile.
 * One timer per chat; Stop and Genex quitting end it; nothing else of the chat's is touched.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  callProjectTool,
  type ProjectToolCall,
  ProjectToolSeat,
  projectTools,
} from "../../src/main/core/project-tools.ts";
import {
  WAKE_LATER_MAX_MS,
  WAKE_LATER_MIN_MS,
  type WakeLaterDeps,
  WakeLaterTimers,
} from "../../src/main/core/wake-later.ts";
import { EntryKind, toEntries } from "../../src/renderer/chat-entries.ts";
import { SECOND_MS } from "../../src/shared/duration.ts";
import type { EventData, EventEnvelope } from "../../src/shared/event-log.ts";
import { CoreFact, type GameKind } from "../../src/shared/project-facts.ts";
import { ProjectTool } from "../../src/shared/project-tools.ts";
import { isChatReport, MessageOrigin } from "../../src/shared/protocol.ts";
import { coreLite } from "../helpers/core-lite.ts";

const THREAD = "t-later";
const PROJECT = "racer";
/** The longest a test waits for the chat's wake to reach its stand-in. */
const WAKE_ARRIVES_MS = 5_000;

/** A clock and timers the test moves by hand, and every wake and log line the timers made. */
function fakeClock() {
  let now = 0;
  const timers: Array<{ at: number; fire: () => void; live: boolean }> = [];
  const wakes: Array<{ threadId: string; project: string; text: string }> = [];
  const logs: string[] = [];
  let failWake = false;
  const schedule: WakeLaterDeps["schedule"] = (fire, ms) => {
    const timer = { at: now + ms, fire, live: true };
    timers.push(timer);
    return () => {
      timer.live = false;
    };
  };
  const deps: WakeLaterDeps = {
    wake: async (threadId, project, text) => {
      if (failWake) throw new Error("the chat is gone");
      wakes.push({ threadId, project, text });
    },
    schedule,
    now: () => now,
    log: (line) => logs.push(line),
  };
  /** Move the clock and let what fell due run to its end. */
  const tick = async (ms: number) => {
    now += ms;
    for (const timer of timers.filter((t) => t.live && t.at <= now)) {
      timer.live = false;
      timer.fire();
    }
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
  };
  const pending = () => timers.filter((t) => t.live).length;
  return { deps, schedule, wakes, logs, tick, pending, now: () => now, failNextWakes: () => (failWake = true) };
}

describe("a wake_later timer", () => {
  it("wakes the chat once when it is due, with the agent's note, and never before", async () => {
    const clock = fakeClock();
    const timers = new WakeLaterTimers(clock.deps);
    const set = timers.set(THREAD, PROJECT, 90 * SECOND_MS, "check the Unreal download in the launcher");
    assert.deepEqual(set, { ms: 90 * SECOND_MS, clamped: false, replaced: false });
    await clock.tick(89 * SECOND_MS);
    assert.equal(clock.wakes.length, 0, "nothing before it is due");
    await clock.tick(SECOND_MS);
    assert.equal(clock.wakes.length, 1);
    const [wake] = clock.wakes;
    assert.equal(wake?.threadId, THREAD);
    assert.equal(wake?.project, PROJECT);
    assert.match(wake?.text ?? "", /wake_later timer you set 90 s ago/);
    assert.match(wake?.text ?? "", /check the Unreal download in the launcher/);
    assert.match(wake?.text ?? "", /set wake_later again/);
    assert.equal(timers.size, 0);
    await clock.tick(WAKE_LATER_MAX_MS);
    assert.equal(clock.wakes.length, 1, "woken once");
    assert.equal(clock.pending(), 0, "no timer left");
  });

  it("keeps one timer per chat: a new one replaces the earlier, another chat's stands", async () => {
    const clock = fakeClock();
    const timers = new WakeLaterTimers(clock.deps);
    timers.set(THREAD, PROJECT, 60 * SECOND_MS, "first");
    timers.set("t-other", "other", 60 * SECOND_MS, "the other chat's");
    assert.equal(timers.set(THREAD, PROJECT, 120 * SECOND_MS, "second").replaced, true);
    assert.equal(clock.pending(), 2, "the replaced timer no longer runs");
    await clock.tick(60 * SECOND_MS);
    assert.deepEqual(
      clock.wakes.map((wake) => wake.threadId),
      ["t-other"],
    );
    await clock.tick(60 * SECOND_MS);
    assert.equal(clock.wakes.length, 2);
    assert.match(clock.wakes[1]?.text ?? "", /second/);
    assert.doesNotMatch(clock.wakes[1]?.text ?? "", /first/);
  });

  it("is set for the shortest or longest time when asked for less or more", () => {
    const clock = fakeClock();
    const timers = new WakeLaterTimers(clock.deps);
    assert.deepEqual(timers.set(THREAD, PROJECT, SECOND_MS, "soon"), {
      ms: WAKE_LATER_MIN_MS,
      clamped: true,
      replaced: false,
    });
    assert.deepEqual(timers.set(THREAD, PROJECT, 10 * WAKE_LATER_MAX_MS, "late"), {
      ms: WAKE_LATER_MAX_MS,
      clamped: true,
      replaced: true,
    });
  });

  it("wakes nothing once cancelled or disposed, and says whether one was set", async () => {
    const clock = fakeClock();
    const timers = new WakeLaterTimers(clock.deps);
    timers.set(THREAD, PROJECT, 30 * SECOND_MS, "check");
    assert.equal(timers.cancel(THREAD), true);
    assert.equal(timers.cancel(THREAD), false, "nothing left to cancel");
    timers.set("t-a", PROJECT, 30 * SECOND_MS, "a");
    timers.set("t-b", PROJECT, 30 * SECOND_MS, "b");
    timers.dispose();
    await clock.tick(WAKE_LATER_MAX_MS);
    assert.equal(clock.wakes.length, 0);
    assert.equal(clock.pending(), 0);
  });

  it("logs a wake that never reached the chat, and throws nothing", async () => {
    const clock = fakeClock();
    const timers = new WakeLaterTimers(clock.deps);
    timers.set(THREAD, PROJECT, 30 * SECOND_MS, "check");
    clock.failNextWakes();
    await clock.tick(30 * SECOND_MS);
    assert.equal(clock.wakes.length, 0);
    assert.match(clock.logs.join("\n"), /t-later wasn't woken by its wake_later timer: the chat is gone/);
  });
});

describe("the wake_later tool", () => {
  it("is one row in the chat that reads as a timer and names what it will check", () => {
    const event = (id: number, data: EventData): EventEnvelope => ({
      id: String(id).padStart(6, "0"),
      thread_id: THREAD,
      turn_id: "turn",
      session_id: null,
      created_at: new Date(id).toISOString(),
      data,
    });
    const note = "Is the Unreal download done?";
    for (const name of [ProjectTool.WakeLater, `mcp__studio__${ProjectTool.WakeLater}`]) {
      const rows = toEntries([
        event(1, {
          type: "tool_requested",
          tool_call_id: "call-1",
          request: { name, arguments: { seconds: 300, note } },
        }),
        event(2, {
          type: "tool_result",
          tool_call_id: "call-1",
          result: { ok: true, content: "Genex wakes this chat" },
        }),
      ]).flatMap((entry) => (entry.kind === EntryKind.Tools ? entry.rows : []));
      assert.equal(rows.length, 1, name);
      assert.equal(rows[0]?.label, "set a timer to check back", name);
      assert.equal(rows[0]?.chip, note, name);
    }
  });

  it("is handed to the chat's own session only", () => {
    const games: GameKind[] = [{ facts: [] }, { facts: [{ id: CoreFact.UnrealProject, path: "." }] }];
    const named = (game: GameKind, seat: ProjectToolSeat) => projectTools(game, seat).map((tool) => tool.name);
    for (const game of games) {
      assert.ok(named(game, ProjectToolSeat.Chat).includes(ProjectTool.WakeLater));
      for (const seat of [ProjectToolSeat.Lead, ProjectToolSeat.Worker, ProjectToolSeat.Reviewer, ProjectToolSeat.None])
        assert.ok(!named(game, seat).includes(ProjectTool.WakeLater), seat);
    }
  });

  it("sets the chat's timer, and its wake is one hidden message on the chat's last model", async () => {
    const clock = fakeClock();
    const { core, close } = await coreLite({ wakeLater: { schedule: clock.schedule, now: clock.now } });
    try {
      await core.games.scaffold(PROJECT, { title: "Racer" });
      const threadId = await core.threadForGame(PROJECT);
      await core.store.updateThread(threadId, { metadata: { lastEngine: "codex", lastModel: "gpt-5.5" } });
      const sent: Array<{ text: string; options: Record<string, unknown> }> = [];
      let delivered = () => {};
      const arrived = new Promise<void>((resolve) => {
        delivered = resolve;
      });
      core.sendUserMessage = (async (text: string, options: Record<string, unknown>) => {
        sent.push({ text, options });
        delivered();
      }) as never;
      const call = { project: PROJECT, threadId };
      const answer = await callProjectTool(
        core,
        null as never,
        ProjectTool.WakeLater,
        { seconds: "120", note: "check it" },
        call,
      );
      assert.match(String(answer), /in 120 s/);
      assert.match(String(answer), /End your turn now/);
      await clock.tick(119 * SECOND_MS);
      assert.equal(sent.length, 0, "nothing before it is due");
      await clock.tick(SECOND_MS);
      await Promise.race([arrived, delay(WAKE_ARRIVES_MS)]);
      assert.equal(sent.length, 1);
      assert.match(sent[0]?.text ?? "", /check it/);
      assert.deepEqual(sent[0]?.options, {
        thread: threadId,
        project: PROJECT,
        origin: MessageOrigin.WakeLater,
        engine: "codex",
        model: "gpt-5.5",
      });
      assert.ok(isChatReport(sent[0]?.options), "the transcript leaves it out");
    } finally {
      await close();
    }
  });

  it("cancels with seconds 0, refuses without seconds or a chat, and says a clamped time", async () => {
    const clock = fakeClock();
    const { core, close } = await coreLite({ wakeLater: { schedule: clock.schedule, now: clock.now } });
    try {
      const call: ProjectToolCall = { project: PROJECT, threadId: THREAD };
      const tool = (args: Record<string, unknown>, at = call) =>
        callProjectTool(core, null as never, ProjectTool.WakeLater, args, at).then(String);
      assert.match(await tool({ seconds: 0 }), /No timer was set/);
      assert.match(await tool({ note: "no time" }), /Give seconds/);
      assert.match(await tool({ seconds: 5, note: "soon" }), /in 10 s, the shortest/);
      assert.equal(core.wakeLater.size, 1);
      assert.match(await tool({ seconds: 0 }), /Cancelled/);
      assert.equal(core.wakeLater.size, 0);
      assert.match(await tool({ seconds: 30 }, { project: PROJECT }), /no chat to wake/);
      assert.equal(clock.pending(), 0);
    } finally {
      await close();
    }
  });

  it("is cancelled by the person's Stop in that chat, and only that chat's", async () => {
    const clock = fakeClock();
    const { core, close } = await coreLite({
      wakeLater: { schedule: clock.schedule, now: clock.now },
      stopSendWaitMs: 0,
    });
    try {
      await core.games.scaffold(PROJECT, { title: "Racer" });
      const threadId = await core.threadForGame(PROJECT);
      core.wakeLater.set(threadId, PROJECT, 60 * SECOND_MS, "check");
      core.wakeLater.set("t-other", "other", 60 * SECOND_MS, "the other chat's");
      await core.stopThread(threadId);
      assert.equal(core.wakeLater.size, 1);
      assert.equal(core.wakeLater.cancel("t-other"), true, "another chat's timer stands");
    } finally {
      await close();
    }
  });
});
