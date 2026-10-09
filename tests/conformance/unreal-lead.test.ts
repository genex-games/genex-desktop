/**
 * The Unreal Loop's lead, pinned on a fake host whose `engine.delegate` runs the lead's turns and
 * answers their run tools through the studio's own dispatch: ONE fresh session in the game folder,
 * resumed turn after turn until the run's time is up; the lead's own save points (refused while the
 * game plays, with the new log errors and the hero shots' tone numbers); rewinds, rebuilds and
 * crash restores cold and between turns; a paused run resuming from its journal; a fresh session
 * handed the run when the old one is lost; the cost read from per-turn deltas; and every editor
 * step run by the plugin at Genex's moments, with only the C++ module's tools called by name.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { HookEvent } from "../../src/shared/plugin-hooks.ts";
import { leadLineOf } from "../../src/harness-seed/loop/director/lead-line.ts";
import { GameEngine } from "../../src/harness-seed/loop/game-engine.ts";
import { chooseRunner } from "../../src/harness-seed/loop/run-dispatch.ts";
import { RunnerKind } from "../../src/harness-seed/loop/studio-state.ts";
import { LEAD_JOURNAL_KIND, type LeadJournal, LeadTool } from "../../src/harness-seed/loop/unreal/lead-contract.ts";
import { runUnrealLead } from "../../src/harness-seed/loop/unreal/lead.ts";
import { UnrealLoopTool } from "../../src/harness-seed/loop/unreal/live-contract.ts";
import {
  BROKEN_SOURCE,
  buildsAndSaves,
  buildsOnly,
  GAME,
  type LeadHost,
  leadHost,
  RUN,
  textOf,
  type Turn,
} from "../helpers/unreal-lead-host.ts";

const MINUTE = 60_000;

/** One lead run on the host, on its clock. */
function run(host: LeadHost, extra: { resume?: boolean; run?: Record<string, unknown> } = {}) {
  return runUnrealLead(host.rec.ctx as never, {
    threadId: "t1",
    run: (extra.run ?? RUN) as never,
    resume: extra.resume === true,
    now: host.now,
    sleep: host.sleep,
  });
}

/** A run of `minutes` working minutes. */
const shortRun = (minutes: number) => ({ ...RUN, budgets: { ...RUN.budgets, wallClockMs: minutes * MINUTE } });
/** The lead's turns, as they were delegated. */
const leadTurns = (host: LeadHost) => host.rec.paramsOf("engine.delegate");
/** The run's journal as it was saved last. */
const journalOf = (host: LeadHost) => host.artifacts.get(`autopilot_${RUN.runId}`) as LeadJournal;
/** Where in the trail `what` first sits at or after `from`. */
const indexAfter = (trail: string[], what: string, from: number) => trail.indexOf(what, from);
/** A plugin tool's calls, by its name. */
const calledTimes = (host: LeadHost, name: string) => host.tools().filter((tool) => tool === name).length;

/** The chat's bookmark naming its own Claude Code session, as the chat's turns leave it. */
const CHAT_BOOKMARK = [
  {
    data: {
      type: "custom",
      event_type: "contractor_session",
      payload: { sessionId: "chat-1", engine: "claude-code", project: GAME.name },
    },
  },
];

describe("the Unreal Loop's lead", () => {
  it("is the runner for a Loop on an Unreal game, and only for one", () => {
    const described = [{ id: "claude-code", kind: "delegated", supportsSessions: true }] as never;
    assert.equal(chooseRunner(RUN as never, described, GameEngine.Unreal), RunnerKind.Unreal);
    assert.equal(chooseRunner(RUN as never, described, GameEngine.Web), RunnerKind.Director);
  });

  it("builds in one fresh session in the game folder, resumed turn after turn, with its run tools at high effort", async () => {
    const host = leadHost();
    host.rec.handle("events.list", () => CHAT_BOOKMARK);
    await run(host, { run: shortRun(40) });
    const turns = leadTurns(host);
    assert.ok(turns.length >= 2, `${turns.length} turns`);
    assert.equal(turns[0]?.resume, undefined, "a fresh session, never the chat's own");
    for (const turn of turns.slice(1)) assert.equal(turn.resume, "session-1", "the same session goes on");
    for (const turn of turns) {
      assert.equal(turn.cwd, undefined, "seated in the game folder, by the host");
      assert.equal(turn.effort, "high");
      assert.equal(turn.engine, "claude-code");
      assert.deepEqual(turn.chatTurn, { messageId: RUN.runId });
      assert.equal(turn.creditCap, 600, "its own paid Genex jobs count against the run's cap");
      const director = turn.director as {
        root: string;
        project: string;
        runId: string;
        tools: Array<{ name: string }>;
      };
      assert.deepEqual([director.root, director.project, director.runId], [GAME.dir, GAME.name, RUN.runId]);
      assert.deepEqual(director.tools.map((t) => t.name).sort(), Object.values(LeadTool).sort());
    }
    assert.equal(host.inFlight.most, 1, "never two turns at once");
    assert.deepEqual(host.rec.paramsOf("snapshot.worktree"), [], "no copy of the game");
  });

  it("opens its first turn with the brief and every later one with a digest", async () => {
    const host = leadHost();
    await run(host, { run: shortRun(40) });
    const [first, second] = host.prompts();
    assert.match(String(first), /only builder/);
    assert.ok(String(first).includes(RUN.goal), "the goal, whole");
    assert.match(String(second), /^YOUR NEXT TURN/);
    assert.match(String(second), /Last save point: 'Turn 1'/);
    assert.doesNotMatch(String(second), /only builder/, "briefed once");
  });

  it("tells its first turn what the game's folder holds and where, from the game's facts", async () => {
    const linked = { id: "unreal-project", path: "unreal", source: "link" };
    const host = leadHost();
    host.rec.handle("game.list", () => [{ ...GAME, facts: [linked] }]);
    await run(host, { run: shortRun(40) });
    const [first] = host.prompts();
    assert.match(String(first), /folder `games\/tower-climb`; it holds an Unreal Engine project in `unreal\/`/);
    assert.doesNotMatch(String(first), /holds an Unreal Engine project at its root/);
  });

  it("works until its time is up, with no gap between turns, and closes with its report and journal", async () => {
    const host = leadHost();
    const report = await run(host);
    assert.equal(report.executionStatus, "completed");
    assert.equal(report.endReason, "time-up");
    assert.equal(report.landed, true);
    const turns = leadTurns(host).length;
    assert.ok(turns >= 15, `the three hours hold ${turns} ten-minute turns`);
    assert.equal(host.appended("run_finished").length, 1);
    assert.ok(host.rec.paramsOf("run.artifact").some((p) => p.name === "report.json"));
    const journal = journalOf(host);
    assert.deepEqual([journal.kind, journal.phase, journal.turns], [LEAD_JOURNAL_KIND, "done", turns]);
  });

  it("runs at the effort the person chose for the builders", async () => {
    const host = leadHost();
    const chosen = { ...shortRun(30), roles: { efforts: { builder: "medium" } } };
    await run(host, { run: chosen });
    assert.equal(leadTurns(host)[0]?.effort, "medium");
  });

  it("adds up each turn's own cost, as the engine reports a delegation's share", async () => {
    const shares = [1.5, 1, 1.5];
    const costs: Turn = (call) => {
      buildsAndSaves(call);
      return { usage: { cost_usd: shares[call.n - 1] ?? 0 } };
    };
    const host = leadHost({ turns: [costs, costs, costs] });
    const report = await run(host, { run: shortRun(35) });
    assert.equal(report.costUsd, 4, "1.5 + 1 + 1.5, none of it read as a running total");
  });
});

describe("the lead's fresh eyes", () => {
  it("reminds a lead that hasn't asked the critic for 45 minutes, and not again for the next 45", async () => {
    const host = leadHost();
    await run(host, { run: shortRun(120) });
    const prompts = leadTurns(host).map((turn) => String(turn.prompt));
    const reminded = prompts.filter((prompt) => /No fresh eyes on the game for \d+ minutes/.test(prompt));
    assert.ok(reminded.length >= 1, "reminded");
    assert.ok(reminded.length <= 2, `not every turn: ${reminded.length} of ${prompts.length}`);
    assert.match(reminded[0] ?? "", /mcp__studio__critic/);
  });
});

describe("the lead's save points", () => {
  it("saves all, names the log's new errors, snapshots under the label, and answers the hero shots' tone numbers", async () => {
    const answers: string[] = [];
    const saves: Turn = async ({ tool, host }) => {
      host.work("stair");
      host.logLines.push("LogBlueprint: Error: a pin has no connection");
      answers.push(textOf(await tool(LeadTool.SavePoint, { label: "Stair pass", summary: "a stair in fog" })));
      return undefined;
    };
    const host = leadHost({ turns: [saves] });
    await run(host, { run: shortRun(20) });
    const answer = answers[0] ?? "";
    assert.match(answer, /Saved 'Stair pass' \(snapshot snap-1\)/);
    assert.match(answer, /1 new error[^\n]*a pin has no connection/);
    assert.match(answer, /GX_Shot_Ant: black point p2 0\.03, white p98 0\.92, contrast std 0\.22/);
    // A lead that guesses its own time winds down early; the answer says how long the run goes on.
    assert.match(answer, /About \d+ minutes are left: keep building/);
    const trail = host.trail();
    const saved = trail.indexOf("tool:unreal__save-all");
    assert.ok(saved >= 0 && trail.indexOf("snapshot.create") > saved, "saved before the snapshot");
    const point = journalOf(host).savePoints[0];
    assert.deepEqual(
      point?.thumbnails.map((t) => t.camera),
      ["GX_Shot_Ant", "GX_Shot_Well"],
    );
    assert.equal(point?.thumbnails[0]?.tone?.std, 0.22);
    assert.match(String(point?.thumbnails[0]?.path), /\.jpg$/, "a JPEG run artefact");
  });

  it("refuses a save point while the game plays, and saves nothing", async () => {
    const answers: string[] = [];
    const playing: Turn = async ({ tool, host }) => {
      host.editor.playing = true;
      answers.push(textOf(await tool(LeadTool.SavePoint, { label: "Mid play", summary: "" })));
      host.editor.playing = false;
      return undefined;
    };
    const host = leadHost({ turns: [playing] });
    await run(host, { run: shortRun(20) });
    assert.match(answers[0] ?? "", /playing in the editor/);
    assert.ok(!host.snapshotReasons().includes("Mid play"));
  });

  it("refuses a save point, saving nothing, while the editor can't say whether the game plays", async () => {
    const answers: string[] = [];
    let savesDuring = -1;
    const unsure: Turn = async ({ tool, host }) => {
      host.work("stair");
      host.answers.set("unreal__editor-activity", () => {
        throw new Error("The Genex editor helper didn't answer editor_activity");
      });
      const saves = calledTimes(host, "unreal__save-all");
      answers.push(textOf(await tool(LeadTool.SavePoint, { label: "Stair", summary: "" })));
      savesDuring = calledTimes(host, "unreal__save-all") - saves;
      host.answers.delete("unreal__editor-activity");
      return undefined;
    };
    const host = leadHost({ turns: [unsure] });
    await run(host, { run: shortRun(20) });
    // The editor lock gives way to a person Genex can't rule out: it waited, then refused.
    assert.match(answers[0] ?? "", /could not tell whether the person is using Unreal/);
    assert.equal(savesDuring, 0, "the editor's work was not saved");
    assert.ok(!host.snapshotReasons().includes("Stair"));
  });

  it("makes no snapshot when the editor's save leaves work unsaved", async () => {
    const answers: string[] = [];
    const unsaved: Turn = async ({ tool, host }) => {
      host.answers.set("unreal__save-all", () => ({ saved: false, dirty: ["/Game/Maps/Tower"], ms: 3 }));
      answers.push(textOf(await tool(LeadTool.SavePoint, { label: "Tower", summary: "" })));
      host.answers.delete("unreal__save-all");
      return undefined;
    };
    const host = leadHost({ turns: [unsaved] });
    await run(host, { run: shortRun(20) });
    assert.match(answers[0] ?? "", /No save point: [^\n]*left 1 assets unsaved/);
    assert.ok(!host.snapshotReasons().includes("Tower"));
  });
});

describe("the lead's save points in a planning chat", () => {
  it("refuses a save point while the run's chat plans: nothing saved, no snapshot, no save point", async () => {
    const answers: string[] = [];
    const plans: Turn = async ({ tool, host }) => {
      host.work("stair");
      host.planning = true;
      answers.push(textOf(await tool(LeadTool.SavePoint, { label: "Planned", summary: "" })));
      host.planning = false;
      return undefined;
    };
    const host = leadHost({ turns: [plans] });
    await run(host, { run: shortRun(20) });
    assert.match(answers[0] ?? "", /No save point: [^\n]*Plan mode/);
    assert.ok(!host.snapshotReasons().includes("Planned"), host.snapshotReasons().join(", "));
    assert.ok(!journalOf(host).savePoints.some((point) => point.label === "Planned"));
  });

  it("skips the autosave between turns while the run's chat plans, and tells the lead why", async () => {
    const plans: Turn = ({ host, n }) => {
      host.work(`mark ${n}`);
      host.planning = true;
      return undefined;
    };
    const approved: Turn = ({ host }) => {
      host.planning = false;
      return undefined;
    };
    const host = leadHost({ turns: [plans, approved] });
    await run(host, { run: shortRun(25) });
    const trail = host.trail();
    const first = trail.indexOf("engine.delegate");
    const between = trail.slice(first, indexAfter(trail, "engine.delegate", first + 1));
    assert.ok(!between.includes("snapshot.create"), between.join(", "));
    assert.match(host.prompts()[1] ?? "", /Genex couldn't save it: [^\n]*Plan mode/);
  });
});

describe("between the lead's turns", () => {
  it("makes no autosave after a turn that saved itself, or one that left the editor clean", async () => {
    const clean: Turn = () => undefined;
    const host = leadHost({ turns: [buildsAndSaves, clean] });
    await run(host, { run: shortRun(30) });
    assert.ok(!host.snapshotReasons().includes("Autosave"), host.snapshotReasons().join(", "));
  });

  it("never saves the editor's work, between turns or at the close, while it can't say whether a play session runs", async () => {
    const unsure: Turn = ({ host, n }) => {
      host.work(`turn-${n}`);
      host.editor.dirty = null;
      return undefined;
    };
    const host = leadHost({ turns: [unsure, buildsOnly] });
    await run(host, { run: shortRun(25) });
    assert.equal(calledTimes(host, "unreal__save-all"), 0, "a save would end a play session the owner may be in");
    assert.ok(!host.snapshotReasons().includes("Autosave"), host.snapshotReasons().join(", "));
    assert.match(
      host.prompts()[1] ?? "",
      /Genex couldn't save it: [^\n]*couldn't tell whether Unreal held unsaved work/,
    );
  });

  it("a run whose Unreal can't say what the person does waits for them, then doesn't start, saying Genex couldn't tell", async () => {
    const host = leadHost({ turns: [buildsOnly, buildsOnly] });
    host.editor.dirty = null;
    const report = await run(host, { run: shortRun(25) });
    assert.equal(leadTurns(host).length, 0, "the run waited for the person, then did not start");
    assert.equal(report.executionStatus, "paused");
    assert.match(String(report.stoppedBecause), /couldn't tell whether you were using Unreal[^\n]*didn't start/);
    assert.doesNotMatch(String(report.stoppedBecause), /waited for you to finish|the person|Try again later/i);
    assert.equal(calledTimes(host, "unreal__save-all"), 0, "a save would end a play session the owner may be in");
  });

  it("the close's save Genex held because it couldn't tell what the person does says so, never that they used Unreal", async () => {
    const lastTurn: Turn = ({ host, n }) => {
      host.work(`turn-${n}`);
      // The autosave after the turn reads the editor three times (what is unsaved, whether the
      // person plays, its save); the close's first read sees unsaved work, then the editor stops
      // answering whether anyone plays.
      let reads = 0;
      host.answers.set("unreal__editor-activity", () => {
        reads += 1;
        if (reads > 4) throw new Error("Unknown tool: editor-activity");
        return { pie: false, dirty: 2 };
      });
      return undefined;
    };
    const host = leadHost({ turns: [lastTurn] });
    await run(host, { run: shortRun(12) });
    const told = host.appended("autopilot_decision").map((p) => String(p.plain ?? p.text));
    const close = told.find((line) => /last work as the Loop ended/.test(line));
    assert.ok(close, told.join(" | "));
    assert.match(close, /couldn't tell whether you were using Unreal/);
    assert.doesNotMatch(close, /: you were using Unreal|the person|Try again later/i);
  });

  it("goes back to a save point the lead asked to rewind to, cold, when its turn ends", async () => {
    const rewinds: Turn = async ({ tool, host }) => {
      host.work("bad bridge");
      const said = textOf(await tool(LeadTool.Rewind, { label: "Turn 1" }));
      assert.match(said, /goes back to 'Turn 1' when this turn ends/);
      return undefined;
    };
    const host = leadHost({ turns: [buildsAndSaves, rewinds] });
    await run(host, { run: shortRun(40) });
    assert.deepEqual(
      host.rec.paramsOf("snapshot.restore").map((p) => p.snapshotId),
      ["snap-1"],
    );
    const trail = host.trail();
    const second = indexAfter(trail, "engine.delegate", trail.indexOf("engine.delegate") + 1);
    const ended = indexAfter(trail, "tool:unreal__end-editor", second);
    const restored = indexAfter(trail, "snapshot.restore", ended);
    const reopened = indexAfter(trail, "tool:unreal__reopen-editor", restored);
    const third = indexAfter(trail, "engine.delegate", second + 1);
    assert.ok(
      ended > second && restored > ended && reopened > restored && third > reopened,
      "end, restore, reopen, then the next turn",
    );
    for (const step of ["snapshot.restore", "unreal__end-editor", "unreal__reopen-editor"])
      assert.ok(!host.duringTurn.includes(step), `${step} never runs under a turn`);
    assert.match(host.prompts()[2] ?? "", /put the game back to save point 'Turn 1'/);
    assert.ok(!host.level.marks.has("bad bridge"), "the level is the save point's");
  });

  it("answers the save points there are when a rewind names none of them", async () => {
    const answers: string[] = [];
    const rewinds: Turn = async ({ tool }) => {
      answers.push(textOf(await tool(LeadTool.Rewind, { label: "Never saved" })));
      return undefined;
    };
    const host = leadHost({ turns: [buildsAndSaves, rewinds] });
    await run(host, { run: shortRun(30) });
    assert.match(answers[0] ?? "", /no save point 'Never saved'\. The save points: Turn 1\./);
    assert.deepEqual(host.rec.paramsOf("snapshot.restore"), []);
  });

  it("rebuilds Unreal when the turn that asked for it ends, and never under it", async () => {
    const rebuilds: Turn = async ({ tool, host }) => {
      host.level.source = "src-2";
      assert.match(textOf(await tool(LeadTool.RebuildUnreal, { reason: "a sword class" })), /when this turn ends/);
      return undefined;
    };
    const host = leadHost({ turns: [buildsAndSaves, rebuilds] });
    await run(host, { run: shortRun(40) });
    assert.ok(calledTimes(host, "unreal__end-editor") >= 1);
    assert.ok(!host.duringTurn.includes("unreal__end-editor"), "Unreal never closes under the turn");
    assert.match(host.prompts()[2] ?? "", /restarted Unreal \(building the game's C\+\+ first/);
  });

  it("sends the game back to its last save point when its C++ doesn't build", async () => {
    const breaks: Turn = async ({ tool, host }) => {
      host.level.source = BROKEN_SOURCE;
      await tool(LeadTool.RebuildUnreal, { reason: "a sword class" });
      return undefined;
    };
    const host = leadHost({ turns: [buildsAndSaves, breaks] });
    const report = await run(host, { run: shortRun(40) });
    assert.equal(report.executionStatus, "completed", String(report.stoppedBecause));
    assert.deepEqual(
      host.rec.paramsOf("snapshot.restore").map((p) => p.snapshotId),
      ["snap-1"],
    );
    assert.match(host.prompts()[2] ?? "", /C\+\+ didn't build[^\n]*back to save point 'Turn 1'/);
  });

  it("never ends Unreal with unsaved work: a save that fails before a rewind leaves it open and the folder as it is", async () => {
    const rewinds: Turn = async ({ tool, host }) => {
      host.answers.set("unreal__save-all", () => {
        throw new Error("the editor refused the save");
      });
      await tool(LeadTool.Rewind, { label: "Turn 1" });
      return undefined;
    };
    const host = leadHost({ turns: [buildsAndSaves, rewinds, buildsOnly] });
    await run(host, { run: shortRun(40) });
    assert.equal(calledTimes(host, "unreal__end-editor"), 0, "Unreal is left open");
    // The seed asks Genex for the restore; the restore's before steps (the failed save) refuse it
    // before any file changes.
    assert.equal(host.rec.paramsOf("snapshot.restore").length, 1, "the rewind was asked once");
    assert.ok(!host.trail().includes("snapshot.restore"), "and the folder as it is");
    assert.match(host.prompts()[2] ?? "", /couldn't go back to 'Turn 1'/);
  });
});

describe("Unreal crashing under the lead", () => {
  it("goes back to the last save point when Unreal won't reopen twice, and tells the lead", async () => {
    const crashes: Turn = async ({ host }) => {
      host.editor.answering = false;
      host.editor.reopenFails = 2;
      await host.until(() => host.rec.paramsOf("snapshot.restore").length > 0);
      await host.until(() => host.steered().some((s) => /couldn't be reopened/.test(s)));
      return undefined;
    };
    const host = leadHost({ turns: [buildsAndSaves, crashes] });
    await run(host, { run: shortRun(40) });
    assert.deepEqual(
      host.rec.paramsOf("snapshot.restore").map((p) => p.snapshotId),
      ["snap-1"],
    );
    assert.ok(
      host.steered().some((s) => /back to save point 'Turn 1'/.test(s)),
      host.steered().join(" | "),
    );
    assert.deepEqual(
      journalOf(host).crashes.map((c) => [c.reopened, c.restoredTo]),
      [[false, "Turn 1"]],
    );
  });

  it("halts with why when Unreal can't come back and there is no save point to go back to", async () => {
    const crashes: Turn = async ({ host }) => {
      host.editor.answering = false;
      host.editor.reopenFails = 10;
      await host.until(() => journalOf(host)?.crashes?.length > 0);
      return undefined;
    };
    const host = leadHost({ turns: [crashes] });
    const report = await run(host, { run: shortRun(40) });
    assert.equal(report.executionStatus, "paused");
    assert.match(String(report.stoppedBecause), /couldn't be reopened/);
    assert.equal(leadTurns(host).length, 1, "no turn after it");
  });

  it("a crash Genex held back (the chat plans) halts with Plan's words, asking no reopen again", async () => {
    const crashes: Turn = async ({ host }) => {
      host.planning = true;
      host.editor.answering = false;
      await host.until(() => journalOf(host)?.crashes?.length > 0);
      return undefined;
    };
    const host = leadHost({ turns: [crashes] });
    const report = await run(host, { run: shortRun(40) });
    assert.equal(report.executionStatus, "paused");
    assert.match(String(report.stoppedBecause), /Plan mode/);
    assert.doesNotMatch(String(report.stoppedBecause), /couldn't be reopened/);
    const fired = host.rec.paramsOf("hooks.fire").map((p) => String(p.on));
    assert.deepEqual(
      fired.filter((on) => on === "crash"),
      ["crash"],
      `held once, never asked again at once: ${fired.join(", ")}`,
    );
    assert.equal(calledTimes(host, "unreal__reopen-editor"), 0, "nothing reopened");
  });

  it("a crash Genex held back for another holder rolls nothing back: no restore, and the run halts saying why", async () => {
    const crashes: Turn = async ({ host }) => {
      host.work("a stair");
      host.editor.answering = false;
      await host.until(() => journalOf(host)?.crashes?.length > 0);
      return undefined;
    };
    const host = leadHost({ turns: [buildsAndSaves, crashes] });
    const passOn = host.rec.ctx.call;
    const otherAtWork = {
      plugin: "@genex",
      tool: "",
      reason: '"Bake" is working in Unreal now.',
      hold: "busy",
      label: "Unreal",
    };
    host.rec.ctx.call = (method: string, params?: Record<string, unknown>) =>
      method === "hooks.fire" && params?.on === HookEvent.Crash
        ? Promise.resolve({ blocked: otherAtWork, pending: null, notes: [], images: [], ran: [] })
        : passOn(method, params);
    const report = await run(host, { run: shortRun(40) });
    assert.deepEqual(host.rec.paramsOf("snapshot.restore"), [], "the work since the save point stays");
    assert.equal(report.executionStatus, "paused");
    assert.match(String(report.stoppedBecause), /Something else was working in Unreal, so nothing was changed/);
    assert.doesNotMatch(String(report.stoppedBecause), /went back to|the person|ask them|Try again later/i);
  });

  it("never ends a busy Unreal for a rebuild: it waits, and leaves one that stays busy open with its work, halting with why", async () => {
    const busy: Turn = async ({ tool, host }) => {
      host.work("a long build script");
      await tool(LeadTool.RebuildUnreal, { reason: "a sword class" });
      host.editor.answering = false;
      host.editor.running = true;
      return undefined;
    };
    const host = leadHost({ turns: [buildsAndSaves, busy] });
    const report = await run(host, { run: shortRun(60) });
    assert.equal(calledTimes(host, "unreal__end-editor"), 0, "never ended unsaved");
    assert.equal(report.executionStatus, "paused");
    // A busy editor can't say whether the person is in it: the editor lock waited, then refused the
    // restart, and the person reads that Genex couldn't tell, in words for them, never the words
    // written for agents, and never that they were using it.
    assert.match(String(report.stoppedBecause), /couldn't tell whether you were using Unreal[^\n]*Resume the Loop/);
    assert.doesNotMatch(String(report.stoppedBecause), /waited for you to finish/);
    assert.doesNotMatch(String(report.stoppedBecause), /the person|ask them|Try again later/i);
  });

  it("takes one missed answer from a busy Unreal for no crash", async () => {
    const stalls: Turn = async ({ host }) => {
      host.work("stair");
      host.editor.misses = 1;
      await host.until(() => host.editor.misses === 0);
      await host.until(() => false, 200);
      return undefined;
    };
    const host = leadHost({ turns: [stalls] });
    await run(host, { run: shortRun(20) });
    assert.equal(calledTimes(host, "unreal__reopen-editor"), 0);
    assert.ok(!host.steered().some((s) => /crashed/.test(s)));
  });
});

describe("the lead at Genex's moments", () => {
  it("a run whose start step blocks closes before any turn, with the plugin's reason", async () => {
    const host = leadHost();
    host.stepAnswers.set("unreal__open-for-run", () => ({ block: "The workshop's licence ran out." }));
    const report = await run(host, { run: shortRun(20) });
    assert.equal(report.executionStatus, "paused");
    assert.match(String(report.stoppedBecause), /The workshop's licence ran out\. Then start the Loop again\./);
    assert.equal(leadTurns(host).length, 0, "no turn");
    const fired = host.rec.paramsOf("hooks.fire").map((p) => p.on);
    assert.equal(fired[0], "run.prepare");
  });

  it("a Stop while the run's start steps work ends the run as the user's stop, never as a hold", async () => {
    const host = leadHost();
    host.rec.handle("hooks.fire", (params) => {
      if (params.on !== HookEvent.RunPrepare) return { blocked: null, pending: null, notes: [], images: [], ran: [] };
      // The person's Stop: the stop flag lands first, then Genex ends the moment under way.
      host.rec.cancel();
      throw new Error("Stopped.");
    });
    const report = await run(host, { run: shortRun(20) });
    assert.equal(report.executionStatus, "cancelled");
    assert.equal(report.endReason, "stopped");
    assert.doesNotMatch(String(report.stoppedBecause), /couldn't ask|plugins|start the Loop again/i);
    assert.equal(leadTurns(host).length, 0, "no turn");
  });

  it("a Stop while a rewind's restore waits ends the run as the user's stop, never as a halt", async () => {
    const rewinds: Turn = async ({ tool }) => {
      await tool(LeadTool.Rewind, { label: "Turn 1" });
      return undefined;
    };
    const host = leadHost({ turns: [buildsAndSaves, rewinds] });
    host.rec.handle("snapshot.restore", () => {
      // Stopped once the restore's before steps had closed Unreal.
      host.editor.answering = false;
      host.rec.cancel();
      throw new Error("Stopped.");
    });
    const report = await run(host, { run: shortRun(40) });
    assert.equal(report.executionStatus, "cancelled");
    assert.equal(report.endReason, "stopped");
  });

  it("a turn a plugin holds back at its start never runs, and the lead hears why in its next digest", async () => {
    const quiet: Turn = async ({ host }) => {
      host.work("a stair");
      return undefined;
    };
    const base = leadHost().manifest;
    const manifest = { ...base, hooks: [...(base.hooks ?? []), { on: HookEvent.TurnStart, tool: "turn-gate" }] };
    const host = leadHost({ turns: [quiet, quiet], manifest });
    let starts = 0;
    host.stepAnswers.set("unreal__turn-gate", () => {
      starts += 1;
      return starts === 2 ? { block: "The bench is being oiled" } : {};
    });
    await run(host, { run: shortRun(40) });
    assert.ok(starts >= 3, `three turn starts at least, ${starts}`);
    const turns = leadTurns(host);
    assert.equal(turns.length, starts - 1, "the held turn never reached an engine");
    assert.match(String(turns[1]?.prompt), /Genex didn't start your last turn: The bench is being oiled\./);
  });

  it("a turn start that keeps being held never ends the run as idle: the lead waits between tries, then halts with why", async () => {
    const base = leadHost().manifest;
    const manifest = { ...base, hooks: [...(base.hooks ?? []), { on: HookEvent.TurnStart, tool: "turn-gate" }] };
    const host = leadHost({ manifest });
    let starts = 0;
    host.stepAnswers.set("unreal__turn-gate", () => {
      starts += 1;
      return { block: "The bench is being oiled" };
    });
    const startedAt = host.now();
    const report = await run(host, { run: shortRun(120) });
    assert.equal(leadTurns(host).length, 0, "no held turn reached an engine");
    assert.equal(report.executionStatus, "paused", "a hold is no idle lead");
    assert.notEqual(report.endReason, "idle");
    assert.match(String(report.stoppedBecause), /The bench is being oiled/);
    assert.doesNotMatch(String(report.stoppedBecause), /nothing more to build/);
    assert.ok(starts > 3, `it asked more than three times, ${starts}`);
    assert.ok(host.now() - startedAt >= (starts - 1) * MINUTE, "it waited between tries");
  });

  it("a run's start Genex held for the person playing in Unreal halts in words for the person", async () => {
    const host = leadHost();
    Object.assign(host.editor, { playing: true, personPlays: true });
    const report = await run(host, { run: shortRun(20) });
    assert.equal(leadTurns(host).length, 0);
    assert.match(String(report.stoppedBecause), /waited for you to finish in Unreal[^\n]*start the Loop again/i);
    assert.doesNotMatch(String(report.stoppedBecause), /the person|ask them|Try again later/i);
  });

  it("the close's save Genex held for the person playing in Unreal is told in words for the person", async () => {
    const plays: Turn = async ({ host }) => {
      host.work("a stair");
      Object.assign(host.editor, { playing: true, personPlays: true });
      return undefined;
    };
    const host = leadHost({ turns: [plays] });
    await run(host, { run: shortRun(12) });
    const told = host.appended("autopilot_decision").map((p) => String(p.plain ?? p.text));
    const close = told.find((line) => /last work as the Loop ended/.test(line));
    assert.ok(close, told.join(" | "));
    assert.match(close, /you were using Unreal/);
    assert.doesNotMatch(close, /the person|ask them|Try again later/i);
  });

  it("a crash is a health block: Genex runs the crash steps and waits until health is quiet", async () => {
    const crashes: Turn = async ({ host }) => {
      host.work("the second stair");
      host.editor.answering = false;
      await host.until(() => host.steered().some((said) => /crashed/.test(said)));
      return undefined;
    };
    const host = leadHost({ turns: [buildsAndSaves, crashes] });
    await run(host, { run: shortRun(40) });
    const fired = host.rec.paramsOf("hooks.fire").map((p) => String(p.on));
    const blocked = fired.indexOf("crash");
    assert.ok(blocked > 0 && fired[blocked - 1] === "health", fired.join(", "));
    assert.equal(fired[blocked + 1], "health", "then health until it is quiet");
    const trail = host.trail();
    const reopened = trail.indexOf("tool:unreal__reopen-editor");
    assert.ok(reopened > 0, "the crash step reopened Unreal");
    assert.deepEqual(host.rec.paramsOf("snapshot.restore"), [], "nothing restored");
    assert.deepEqual(
      journalOf(host).crashes.map((c) => [c.reopened, c.restoredTo]),
      [[true, null]],
    );
    for (const params of host.rec.paramsOf("hooks.fire"))
      assert.deepEqual([params.threadId, params.runId], ["t1", RUN.runId], "the run's moments name its chat and run");
  });
});

describe("the lead's pause and resume", () => {
  it("pauses on a usage cap and resumes from its journal: the same session, a digest, and the time it had left", async () => {
    const capped: Turn = ({ host }) => {
      host.work("half a bridge");
      throw Object.assign(new Error("You've hit your usage limit"), { kind: "usage_limit" });
    };
    const host = leadHost({ turns: [buildsAndSaves, capped] });
    const paused = await run(host);
    assert.equal(paused.executionStatus, "paused");
    assert.equal(paused.endReason, "limit");
    const journal = journalOf(host);
    assert.deepEqual([journal.kind, journal.phase, journal.sessionId], [LEAD_JOURNAL_KIND, "paused", "session-1"]);
    const before = leadTurns(host).length;
    host.clock.now += 5 * 60 * MINUTE;
    const resumed = await run(host, { resume: true });
    const next = leadTurns(host)[before];
    assert.equal(next?.resume, "session-1", "the journal's session goes on");
    assert.match(String(next?.prompt), /^YOUR NEXT TURN/, "a digest, not the brief again");
    assert.match(String(next?.prompt), /The run was paused and goes on now/);
    assert.equal(resumed.executionStatus, "completed");
    assert.equal(journalOf(host).ends.length, 2, "the pause and the end");
  });
});

describe("the lead's resume, and turns its engine failed", () => {
  it("runs a rewind still pending at the pause before the resumed lead's first turn", async () => {
    const rewindsThenCapped: Turn = async ({ tool, host }) => {
      host.work("a wrong turn");
      await tool(LeadTool.Rewind, { label: "Turn 1" });
      throw Object.assign(new Error("You've hit your usage limit"), { kind: "usage_limit" });
    };
    const host = leadHost({ turns: [buildsAndSaves, rewindsThenCapped] });
    await run(host);
    assert.equal(journalOf(host).between.rewind, "Turn 1", "the pause kept it");
    assert.deepEqual(host.rec.paramsOf("snapshot.restore"), []);
    const trailBefore = host.trail().length;
    host.clock.now += 5 * 60 * MINUTE;
    await run(host, { resume: true });
    const resumed = host.trail().slice(trailBefore);
    const restored = resumed.indexOf("snapshot.restore");
    assert.ok(restored >= 0 && restored < resumed.indexOf("engine.delegate"), resumed.join(", "));
  });

  it("closes the milestone it worked in before the pause once the resumed lead opens another", async () => {
    const opensA: Turn = async ({ tool, host }) => {
      await tool(LeadTool.Milestone, { id: "atrium", title: "Atrium" });
      host.work("the atrium");
      await tool(LeadTool.SavePoint, { label: "Atrium", summary: "the atrium" });
      throw Object.assign(new Error("You've hit your usage limit"), { kind: "usage_limit" });
    };
    const opensB: Turn = async ({ tool, host }) => {
      await tool(LeadTool.Milestone, { id: "shaft", title: "Shaft" });
      host.work("the shaft");
      await tool(LeadTool.SavePoint, { label: "Shaft", summary: "the shaft" });
      return undefined;
    };
    const host = leadHost({ turns: [opensA, opensB] });
    await run(host);
    host.clock.now += 5 * 60 * MINUTE;
    await run(host, { resume: true });
    const atrium = host.appended("director_worker").filter((p) => p.workerId === "lead-atrium");
    assert.equal(atrium.at(-1)?.state, "done", JSON.stringify(atrium));
  });

  it("ends as failed, with why, when its engine fails turn after turn, never as idle", async () => {
    const fails: Turn = () => ({ ok: false, stopReason: "error", errorText: "API error 529: overloaded" });
    const host = leadHost({ turns: [fails, fails, fails, fails] });
    host.turnMs = MINUTE / 2;
    const report = await run(host, { run: shortRun(60) });
    assert.equal(report.executionStatus, "failed");
    assert.equal(report.endReason, "failed");
    assert.match(String(report.stoppedBecause), /529: overloaded/);
  });
});

describe("the owner's words to the lead", () => {
  it("never tells a resumed lead the owner's words it heard before the pause, and still tells it new ones", async () => {
    const capped: Turn = () => {
      throw Object.assign(new Error("You've hit your usage limit"), { kind: "usage_limit" });
    };
    const host = leadHost({ turns: [buildsAndSaves, capped] });
    let inbox = ["add rain"];
    // Each run's inbox answers everything it holds once, as a new inbox does.
    const steering = async () => inbox.splice(0);
    Object.assign(host.rec.ctx, { runInbox: { finishing: async () => false, steering } });
    await run(host);
    assert.match(host.prompts()[0] ?? "", /add rain/, "heard on the first turn");
    const before = leadTurns(host).length;
    inbox = ["add rain", "make the fog thicker"];
    await run(host, { resume: true });
    const resumed = String(leadTurns(host)[before]?.prompt);
    assert.doesNotMatch(resumed, /add rain/);
    assert.match(resumed, /make the fog thicker/);
  });

  it("tells the lead the owner's words each time the owner says them, the same words too", async () => {
    const host = leadHost();
    const said = [["go on"], ["go on"]];
    Object.assign(host.rec.ctx, {
      runInbox: { finishing: async () => false, steering: async () => said.shift() ?? [] },
    });
    await run(host, { run: shortRun(30) });
    assert.match(host.prompts()[0] ?? "", /go on/);
    assert.match(host.prompts()[1] ?? "", /The owner says:\ngo on/);
  });
});

describe("the lead's limits, handovers and end", () => {
  it("waits out a rate limit that resets well before its end, then asks the same session again", async () => {
    const limited: Turn = () => {
      throw Object.assign(new Error("rate limited"), { kind: "rate_limit", retryAfterMs: 10 * MINUTE });
    };
    const host = leadHost({ turns: [buildsAndSaves, limited, buildsAndSaves] });
    const report = await run(host, { run: shortRun(90) });
    const turns = leadTurns(host);
    assert.equal(turns[2]?.resume, "session-1", "the same session after the wait");
    assert.ok(host.appended("autopilot_decision").some((p) => /waiting 10 minutes/.test(String(p.plain ?? p.text))));
    assert.equal(report.executionStatus, "completed");
  });

  it("hands the run to a fresh session with the brief and a handover when the context is full", async () => {
    const full: Turn = () => {
      throw Object.assign(new Error("context window threshold"), { kind: "context_threshold" });
    };
    const host = leadHost({ turns: [buildsAndSaves, full, buildsAndSaves] });
    await run(host, { run: shortRun(40) });
    const turns = leadTurns(host);
    assert.equal(turns[1]?.resume, "session-1", "the full session was asked first");
    assert.equal(turns[2]?.resume, undefined, "then a fresh one");
    const fresh = String(turns[2]?.prompt);
    assert.match(fresh, /You take over this Unreal Loop's lead[\s\S]*Save points, newest last: Turn 1/);
    assert.match(fresh, /only builder/, "briefed again");
    assert.equal(journalOf(host).handovers, 1);
  });

  it("ends the turn under way and closes when the owner asks the run to finish", async () => {
    let finishing = false;
    const asked: Turn = async ({ host }) => {
      host.work("stair");
      finishing = true;
      await host.until(() => host.rec.paramsOf("engine.abort").length > 0);
      return undefined;
    };
    const host = leadHost({ turns: [asked] });
    Object.assign(host.rec.ctx, { runInbox: { finishing: async () => finishing, steering: async () => [] } });
    const report = await run(host);
    assert.deepEqual(host.rec.paramsOf("engine.abort")[0], { cwd: GAME.dir });
    assert.equal(leadTurns(host).length, 1);
    assert.deepEqual([report.executionStatus, report.endReason], ["completed", "finished"]);
    assert.ok(host.snapshotReasons().includes("Autosave"), "what it built is saved");
  });

  it("stops when the user stops it, keeping what was built", async () => {
    const stopped: Turn = ({ host }) => {
      host.work("stair");
      host.rec.cancel();
      return { ok: false, stopReason: "stopped" };
    };
    const host = leadHost({ turns: [buildsAndSaves, stopped] });
    const report = await run(host);
    assert.equal(report.executionStatus, "cancelled");
    assert.equal(leadTurns(host).length, 2);
    assert.equal(journalOf(host).phase, "done");
    assert.equal(host.appended("run_finished").at(-1)?.executionStatus, "cancelled");
  });

  it("ends a run whose lead ends turn after turn within minutes, saving nothing: it has nothing more to build", async () => {
    const idle: Turn = () => undefined;
    const host = leadHost({ turns: [idle, idle, idle] });
    host.turnMs = 30_000;
    const report = await run(host);
    assert.equal(report.endReason, "idle");
    assert.equal(leadTurns(host).length, 3);
  });
});

describe("a game the lead can't build", () => {
  const OUTSIDE = { ...GAME, engine: { ...GAME.engine, project: "/elsewhere/TowerClimb.uproject" } };
  const ROWS: Array<[string, unknown[], unknown[], RegExp]> = [
    ["a web game", [{ ...GAME, engine: undefined }], [], /isn't linked to an Unreal project/],
    ["an Unreal project outside the game's folder", [OUTSIDE], [], /outside its folder/],
    ["an engine that keeps no session", [GAME], [{ id: "claude-code", kind: "direct" }], /keeps a session/],
  ];
  for (const [what, games, engines, why] of ROWS) {
    it(`ends ${what} with why, before any turn or editor call`, async () => {
      const host = leadHost();
      host.rec.handle("game.list", () => games);
      if (engines.length) host.rec.handle("engine.describe", () => engines);
      const report = await run(host);
      assert.match(String(report.stoppedBecause), why);
      assert.equal(leadTurns(host).length, 0);
      assert.deepEqual(host.tools(), [], "Unreal is never asked anything");
      assert.equal(host.appended("run_finished").length, 1);
    });
  }
});

describe("the lead's calls against the Unreal plugin", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../../src/plugins/unreal/plugin.json", import.meta.url), "utf8"),
  ) as {
    tools: Array<{ name: string; audience?: string }>;
  };

  it("calls only cpp-status and add-cpp-module by name, and every moment through Genex", async () => {
    const crashes: Turn = async ({ host }) => {
      host.work("stair");
      host.editor.answering = false;
      await host.until(() => calledTimes(host, "unreal__reopen-editor") > 0);
      return undefined;
    };
    const host = leadHost({ turns: [buildsAndSaves, crashes] });
    host.editor.helper = "outdated";
    await run(host, { run: shortRun(40) });
    const harnessTools = new Set(
      manifest.tools.filter((t) => t.audience === "harness").map((t) => `unreal__${t.name}`),
    );
    const byName = new Set(host.rec.paramsOf("plugins.invoke").map((p) => String(p.name)));
    assert.deepEqual([...byName], [UnrealLoopTool.CppStatus]);
    for (const name of new Set(host.tools()))
      assert.ok(harnessTools.has(name), `${name} is a harness tool of the plugin`);
    for (const name of [
      "unreal__open-for-run",
      "unreal__save-all",
      "unreal__log-errors",
      "unreal__hero-shots",
      "unreal__reopen-editor",
      "unreal__editor-state",
    ])
      assert.ok(host.tools().includes(name), `the plugin's ${name} ran at one of Genex's moments`);
    const fired = new Set(host.rec.paramsOf("hooks.fire").map((p) => String(p.on)));
    assert.deepEqual([...fired].sort(), ["crash", "health", "run.prepare"]);
    assert.ok(host.rec.paramsOf("checkpoint.take").length > 0, "save points are Genex's checkpoints");
  });

  it("sends adding the C++ module as part of its checkpoint, which Plan mode holds back, and every read as a plain step", async () => {
    const asksForCpp: Turn = async ({ tool, host }) => {
      host.work("stair");
      // A journaled call from before the rename: its `kind` and `brief` are still read.
      await tool(LeadTool.WorkerStart, { kind: "cpp", title: "Hit stop", brief: "A hit-stop component." });
      return undefined;
    };
    const host = leadHost({ turns: [buildsAndSaves, asksForCpp] });
    const status = { canCompile: true, xcode: "ok", platform: "darwin", module: null, adding: { state: "idle" } };
    host.answers.set(UnrealLoopTool.CppStatus, () => status);
    host.answers.set(UnrealLoopTool.AddCppModule, () => ({ already: true, module: "TowerClimb" }));
    await run(host, { run: shortRun(40) });
    const invokes = host.rec.paramsOf("plugins.invoke");
    const flags = (name: string) => invokes.filter((p) => p.name === name).map((p) => p.checkpoint);
    assert.ok(flags(UnrealLoopTool.AddCppModule).length > 0, "the run adds the module");
    assert.ok(
      flags(UnrealLoopTool.AddCppModule).every((flag) => flag === true),
      "as part of its checkpoint",
    );
    assert.ok(flags(UnrealLoopTool.CppStatus).length > 0, "the run reads the C++ status");
    assert.ok(
      flags(UnrealLoopTool.CppStatus).every((flag) => flag === undefined),
      "as a plain step",
    );
    assert.deepEqual(
      [...new Set(invokes.map((p) => String(p.name)))].sort(),
      [UnrealLoopTool.AddCppModule, UnrealLoopTool.CppStatus].sort(),
      "no other plugin tool by name",
    );
  });

  it("updates an older helper at the run's start once the closed editor's process has exited, not as soon as it stops answering", async () => {
    const host = leadHost();
    host.editor.helper = "outdated";
    host.editor.exitLag = 3;
    await run(host, { run: shortRun(20) });
    assert.equal(host.editor.helper, "current", "the helper was updated");
    assert.equal(host.editor.exitLag, 0, "its process was asked about until it was gone");
  });

  it("adds no C++ module the editor lock held back: no module snapshot, and why is said", async () => {
    const asksForCpp: Turn = async ({ tool, host }) => {
      host.work("stair");
      await tool(LeadTool.WorkerStart, { kind: "cpp", title: "Hit stop", brief: "A hit-stop component." });
      return undefined;
    };
    const host = leadHost({ turns: [buildsAndSaves, asksForCpp] });
    const status = { canCompile: true, xcode: "ok", platform: "darwin", module: null, adding: { state: "idle" } };
    host.answers.set(UnrealLoopTool.CppStatus, () => status);
    const held =
      "The person is using Unreal, and this waited for them to finish. Try again later, or ask them in the chat.";
    host.answers.set(UnrealLoopTool.AddCppModule, () => ({
      consent: "declined",
      blocker: "lock",
      lock: "Unreal",
      reason: "person_first",
      message: held,
    }));
    await run(host, { run: shortRun(40) });
    assert.ok(calledTimes(host, UnrealLoopTool.AddCppModule) > 0, "the run asked to add it");
    assert.ok(
      !host.snapshotReasons().some((reason) => /C\+\+ module/i.test(reason)),
      host.snapshotReasons().join(", "),
    );
    const decisions = host.rec
      .paramsOf("events.append")
      .flatMap((p) => (Array.isArray(p.events) ? p.events : [p]))
      .map((event) => JSON.stringify(event));
    const said = decisions.find((line) => /C\+\+ couldn't be added/.test(line));
    assert.ok(said, "the run says C++ wasn't added, and why");
    assert.match(said, /while you were using Unreal/, "Genex's hold, in the person's words");
    assert.doesNotMatch(said, /the person|ask them|Try again later/i);
  });

  it("a job that ends mid-turn is steered to the lead, and one it missed is in the next digest", async () => {
    /** One job of the run that ended, as `jobs.list` tells it. */
    const jobEnd = (endSeq: number, title: string, over: Record<string, unknown> = {}) => ({
      id: `0b5e3c1a-3f7e-4f3d-9f0e-6f1c2d3e4a5${endSeq}`,
      title,
      role: "lead",
      command: `run ${title.toLowerCase()}`,
      state: "failed",
      exitCode: 1,
      endedAt: new Date(0).toISOString(),
      endSeq,
      durationMs: 2 * MINUTE,
      stoppedBy: null,
      ...over,
    });
    const ends: Array<ReturnType<typeof jobEnd>> = [];
    const host = leadHost({
      turns: [
        async ({ host: h }) => {
          ends.push(jobEnd(1, "Light bake"));
          await h.until(() => h.steered().some((s) => /Light bake/.test(s)));
          // The lead stopped this one itself, and the next one ends while a steer can't reach the turn.
          ends.push(jobEnd(2, "Server", { state: "stopped", stoppedBy: "agent" }));
          h.takesSteers = false;
          ends.push(jobEnd(3, "Cook"));
          await h.until(() => h.steered().some((s) => /Cook/.test(s)));
          h.takesSteers = true;
          return undefined;
        },
      ],
    });
    host.rec.handle("jobs.list", (p) => ({
      jobs: ends.filter((end) => end.endSeq > Number(p.endedAfter)),
      seq: ends.length,
    }));
    await run(host, { run: shortRun(30) });

    assert.match(
      host.steered().find((s) => /Light bake/.test(s)) ?? "",
      /Job news:\n.*started by you\) failed \(exit 1\)/,
    );
    assert.ok(!host.steered().some((s) => /Server/.test(s)), "the lead's own stop is not news");
    const digest = host.prompts()[1] ?? "";
    assert.match(digest, /Jobs:\n- Cook \(`run cook`, started by you\) failed/, digest);
    assert.doesNotMatch(digest, /Light bake/, "what was steered is not said again");
    assert.doesNotMatch(host.prompts().slice(2).join("\n"), /Cook/, "nor what the digest said");
    assert.equal(journalOf(host).jobsCursor, 3);
    assert.ok(
      host.rec.paramsOf("jobs.list").every((p) => p.project === RUN.project && p.runId === RUN.runId),
      "only this run's jobs",
    );
  });

  it("hears the owner through the run's lead line while its turn works", async () => {
    const host = leadHost({
      turns: [
        async ({ host: h }) => {
          leadLineOf(RUN.runId)?.hear({ threadId: "t1", messageId: "m1", text: "add rain" }, async () => {});
          await h.until(() => h.steered().length > 0);
          return undefined;
        },
      ],
    });
    // The inbox holds the owner's message once the chat handed it to the line.
    let given = false;
    const steering = async () => {
      if (given || !leadLineOf(RUN.runId)?.count()) return [];
      given = true;
      return ["add rain"];
    };
    Object.assign(host.rec.ctx, { runInbox: { finishing: async () => false, steering } });
    await run(host, { run: shortRun(60) });
    assert.match(host.steered()[0] ?? "", /add rain/);
  });
});
