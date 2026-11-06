/**
 * A chat turn on a game whose plugins hook Genex's checkpoint ends with Genex's checkpoint, asked
 * only if something is unsaved: the plugins' steps save what their apps hold (the Unreal editor's
 * levels and assets), Genex snapshots the game folder, and the chat says so plainly after the
 * builder's report. The harness names no plugin's tool for it: it reads the checkpoint's answer.
 * Nothing unsaved, or an app that can't say, is said by nobody; a checkpoint Genex couldn't take
 * says why the work stays unsaved, and one whose steps Genex skipped (the person was using the app)
 * says so in the person's words, and that the files on disk were kept. A web game (its descriptor
 * lists no moment), a run's turn and a stopped turn take none.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runDelegatedTurn } from "../../src/harness-seed/loop/delegated-turn.ts";
import { GameEngine } from "../../src/harness-seed/loop/game-engine.ts";
import { CheckpointSkip, HookEvent, HookHold } from "../../src/harness-seed/loop/hooks.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";

const CLAUDE = "claude-code";
const NAME = "rail-yard";
const UPROJECT = "/Users/me/AI Games/rail-yard/unreal/RailYard.uproject";
const REPORT = "Laid the rails and the first gantry.";
const TURN = {
  threadId: "thread-1",
  turnId: "turn-1",
  text: "add a gantry",
  engine: CLAUDE,
  engineLabel: "Claude Code",
};
/** The moments the Unreal plugin hooks, as a game's descriptor lists them. */
const UNREAL_MOMENTS = [
  HookEvent.RunPrepare,
  HookEvent.CheckpointBefore,
  HookEvent.CheckpointAfter,
  HookEvent.RestoreBefore,
  HookEvent.RestoreAfter,
  HookEvent.Health,
];

/** A descriptor as `game.list` answers it: an Unreal game whose plugins hook checkpoints, or a web game. */
function game(hooked: boolean) {
  return {
    name: NAME,
    title: NAME,
    dir: `/games/${NAME}`,
    shape: { entry: "index.html", main: "src/main.js", build: null, own: false, kind: "studio-template" },
    built: true,
    ...(hooked
      ? { engine: { kind: GameEngine.Unreal, project: UPROJECT, linkedAt: "" }, hookEvents: UNREAL_MOMENTS }
      : {}),
  };
}

/** A checkpoint Genex took: its snapshot, and its steps' notes. */
const TAKEN = {
  snapshot: { snapshot_id: "snap_1", scope: "game", reason: "checkpoint" },
  notes: [{ plugin: "unreal", text: "Saved 412 unsaved files in Unreal." }],
  images: [],
};

/** What the turn asked of Genex and what the chat was told. */
interface Ended {
  checkpoints: Array<Record<string, unknown>>;
  plugin: Array<Record<string, unknown>>;
  snapshots: Array<Record<string, unknown>>;
  said: string;
}

/** One chat turn on the game: `checkpoint.take` answers `answer` (a thrown Error: the host failed). */
async function turnOn(options: {
  hooked?: boolean;
  answer?: unknown;
  builder?: Record<string, unknown>;
  turn?: Record<string, unknown>;
}): Promise<Ended> {
  const recorder = ctxRecorder({
    unknown: { value: null },
    handlers: {
      "events.messages": () => [{ role: "user", content: TURN.text }],
      "game.contentStamp": () => ({ all: "a", source: "a" }),
      "game.list": () => [game(options.hooked !== false)],
      "plugins.tools": () => ({ tools: [], guidance: "", revision: 1, kinds: [] }),
      "engine.describe": () => [],
      "preview.ready": () => ({ ready: false }),
      "hooks.fire": () => ({ blocked: null, pending: null, notes: [], images: [], ran: [] }),
      "engine.delegate": () => ({
        ok: true,
        engine: CLAUDE,
        turns: 1,
        usage: {},
        sessionId: "s",
        summary: REPORT,
        ...options.builder,
      }),
      "checkpoint.take": () => {
        if (options.answer instanceof Error) throw options.answer;
        return options.answer ?? TAKEN;
      },
    },
  });
  await runDelegatedTurn(recorder.ctx as never, { ...TURN, project: NAME, ...options.turn } as never);
  const said = recorder.notifications
    .filter((n) => n.type === "chat.message")
    .map((n) => String((n.payload as { content?: unknown }).content))
    .join("\n");
  return {
    checkpoints: recorder.paramsOf("checkpoint.take"),
    plugin: recorder.paramsOf("plugins.invoke"),
    snapshots: recorder.paramsOf("snapshot.create"),
    said,
  };
}

describe("a chat turn on a game whose plugins hook checkpoints", () => {
  it("ends with a checkpoint only if the editor holds unsaved work, and the chat hears what it saved", async () => {
    const ended = await turnOn({});
    assert.equal(ended.checkpoints.length, 1);
    const [asked] = ended.checkpoints;
    assert.equal(asked?.project, NAME);
    assert.equal(asked?.threadId, TURN.threadId);
    assert.equal(asked?.onlyIfUnsaved, true, "only when something is unsaved");
    assert.equal(typeof asked?.label, "string");
    assert.deepEqual(ended.plugin, [], "the harness names no plugin's tool");
    assert.deepEqual(ended.snapshots, [], "the snapshot is Genex's, inside the checkpoint");
    assert.ok(ended.said.includes(REPORT), "the builder's report still reaches the chat");
    assert.match(ended.said, /Genex saved it and took a snapshot of the game/);
    assert.match(ended.said, /Saved 412 unsaved files in Unreal\./, "with what the plugin's step saved");
    assert.ok(ended.said.indexOf(REPORT) < ended.said.indexOf("Saved 412"), "the line follows the report");
  });

  // Flipped: a play blocked the checkpoint; a step's play is a note now, and only a snapshot that
  // fails (or Plan mode) blocks one.
  it("a checkpoint Genex couldn't take is said, and nothing else happens", async () => {
    const reason = "No snapshot was taken: the game folder is locked.";
    const ended = await turnOn({ answer: { blocked: reason } });
    assert.equal(ended.checkpoints.length, 1);
    assert.match(ended.said, /stays unsaved: No snapshot was taken: the game folder is locked\./);
    assert.doesNotMatch(ended.said, /took a snapshot/);
    assert.deepEqual(ended.snapshots, []);
    const failed = await turnOn({ answer: new Error("the host went away") });
    assert.match(failed.said, /stays unsaved: Genex couldn't take the checkpoint: the host went away/);
  });

  it("Genex's own holds are said in the person's words: Plan mode says nothing, as a planning turn always did", async () => {
    const plan = await turnOn({
      answer: {
        blocked: "the chat is in Plan mode, so nothing changes until the plan is approved.",
        hold: HookHold.Plan,
      },
    });
    assert.equal(plan.checkpoints.length, 1);
    assert.ok(plan.said.includes(REPORT));
    assert.doesNotMatch(plan.said, /unsaved|Plan mode|snapshot/);

    // Flipped: a lock not given blocked the checkpoint; Genex now takes the snapshot alone, its
    // hold a note, and the chat says the work in the app stays unsaved, never "Genex saved it".
    const hostWords =
      "The checkpoint's steps were skipped, since Unreal was not free: its snapshot holds only the files on disk.";
    const alone = (hold: HookHold) => ({
      ...TAKEN,
      notes: [{ plugin: "@genex", text: hostWords, hold, label: "Unreal" }],
    });
    const person = await turnOn({ answer: alone(HookHold.PersonFirst) });
    assert.match(person.said, /This turn left unsaved work in Unreal, and it stays unsaved while you use it/);
    assert.match(person.said, /\byou\b/, "the person is spoken to");
    assert.match(person.said, /Genex took a snapshot of the files on disk\./);
    assert.doesNotMatch(person.said, /Genex saved it|skipped a step|was not free/, "never the host's words");

    const busy = await turnOn({ answer: alone(HookHold.Busy) });
    assert.match(
      busy.said,
      /This turn left unsaved work in Unreal, and it stays unsaved: something else was working there/,
    );
    assert.match(busy.said, /Genex took a snapshot of the files on disk\./);
    assert.doesNotMatch(busy.said, /Genex saved it/);

    const cantTell = await turnOn({ answer: alone(HookHold.CantTell) });
    assert.match(cantTell.said, /Genex couldn't tell whether you were using Unreal/);
    assert.match(cantTell.said, /Genex took a snapshot of the files on disk\./);
  });

  it("nothing unsaved, or an app that can't say, is said by nobody", async () => {
    for (const skipped of [CheckpointSkip.NothingUnsaved, CheckpointSkip.CantTell]) {
      const ended = await turnOn({ answer: { skipped, reason: "Nothing was unsaved in Unreal." } });
      assert.equal(ended.checkpoints.length, 1, skipped);
      assert.ok(ended.said.includes(REPORT), skipped);
      assert.doesNotMatch(ended.said, /unsaved|snapshot/, skipped);
    }
  });

  it("a web game, a run's turn or a stopped turn takes none", async () => {
    const cases: Record<string, Parameters<typeof turnOn>[0]> = {
      "a web game": { hooked: false },
      "a run's turn": { turn: { runId: "run_1" } },
      "a stopped turn": { builder: { ok: false, stopReason: "stopped" } },
    };
    for (const [label, options] of Object.entries(cases)) {
      const ended = await turnOn(options);
      assert.deepEqual(ended.checkpoints, [], label);
      assert.deepEqual(ended.plugin, [], label);
      assert.deepEqual(ended.snapshots, [], label);
    }
  });
});
