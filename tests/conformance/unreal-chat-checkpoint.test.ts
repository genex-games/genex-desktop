/**
 * The studio's checkpoint tool on a game whose plugins hook checkpoints makes a real checkpoint. On
 * a web game it lights the user's Reload with the session's note; on an Unreal game the note alone
 * kept nothing: a long chat turn could end with hundreds of unsaved levels and assets while its
 * checkpoint answered "Shown to the user." There Genex's checkpoint runs the Unreal plugin's steps
 * (its editor's work saved, never during a play session) around a snapshot of the game folder,
 * and the tool answers with what they did. Both engines' tools answer the host's words; only the
 * chat's own session on such a game, in its folder, gets them.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { type MomentOps, saveAtMoment } from "../../src/plugins/unreal/editor-moments.ts";
import { ReopenState } from "../../src/plugins/unreal/editor-reopen.ts";
import { probeAnswer } from "../../src/plugins/unreal/hook-answers.ts";
import { HelperState } from "../../src/plugins/unreal/setup.ts";
import { SnapshotScope } from "../../src/shared/event-log.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import { type PluginBinding, PluginSourceKind, PluginToolAudience } from "../../src/shared/plugins.ts";
import type { PluginRegistry } from "../../src/substrate/plugins/registry.ts";
import { ClaudeCodeEngine } from "../../src/substrate/engines/claude-code.ts";
import { CodexEngine } from "../../src/substrate/engines/codex.ts";
import { writeEngineBinding } from "../../src/substrate/game-engine-binding.ts";
import type { DelegateRequest } from "../../src/substrate/engines/types.ts";
import { coreLite, type CoreLite } from "../helpers/core-lite.ts";
import { fixtureCodingCli } from "../helpers/external-cli.ts";
import { scriptedClaude } from "../helpers/scripted-claude.ts";
import { scriptedCodex } from "../helpers/scripted-codex.ts";
import { HOOK_PLUGIN, hookPackage } from "../helpers/hook-plugin.ts";
import { tmpDir } from "../helpers/tmp.ts";

// An engine resolves its login homes the moment it is built: these get tmp homes of their own.
delete process.env.CLAUDE_CONFIG_DIR;

const NOTE = "first light on the rails";
const HOST_ANSWER = "Saved 3 unsaved files in Unreal. Took snapshot snap_1 of the game folder. Shown to the user.";

/** A host checkpoint that keeps each note it is handed and answers {@link HOST_ANSWER}. */
function answering(notes: string[]): (note: string) => Promise<string> {
  return async (note) => {
    notes.push(note);
    return HOST_ANSWER;
  };
}

describe("the checkpoint tool", () => {
  async function claude(queryFn: never): Promise<ClaudeCodeEngine> {
    const root = await tmpDir("checkpoint-claude-");
    const home = path.join(root, "claude-home");
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, ".credentials.json"), "{}");
    return new ClaudeCodeEngine({
      resolveCli: fixtureCodingCli,
      engineHome: home,
      systemHome: path.join(root, "none"),
      queryFn,
    });
  }

  async function codex(execFn: never): Promise<CodexEngine> {
    const root = await tmpDir("checkpoint-codex-");
    const home = path.join(root, "codex-home");
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, "auth.json"), "{}");
    return new CodexEngine({
      resolveCli: fixtureCodingCli,
      engineHome: home,
      systemHome: path.join(root, "none"),
      executable: "/fake/codex",
      authStatusFn: async () => ({ loggedIn: true, method: "chatgpt", detail: "Logged in using ChatGPT" }),
      execFn,
    });
  }

  it("on Claude Code answers what the host's checkpoint answers, and only shows the note without one", async () => {
    const notes: string[] = [];
    const script = scriptedClaude([{ tool: "checkpoint", args: { note: NOTE } }]);
    const engine = await claude(script.queryFn);
    const cwd = await tmpDir("checkpoint-claude-run-");
    await engine.delegate({ prompt: "build", cwd, onCheckpoint: answering(notes) });
    assert.deepEqual(notes, [NOTE]);
    assert.equal(script.calls[0]?.text, HOST_ANSWER);
    assert.equal(script.calls[0]?.isError, false);

    const plain = scriptedClaude([{ tool: "checkpoint", args: { note: NOTE } }]);
    await (await claude(plain.queryFn)).delegate({ prompt: "build", cwd });
    assert.equal(plain.calls[0]?.text, "Shown to the user.");
  });

  it("on Claude Code reports a checkpoint that failed as failed, and the session goes on", async () => {
    const script = scriptedClaude([{ tool: "checkpoint", args: { note: NOTE } }]);
    const engine = await claude(script.queryFn);
    const result = await engine.delegate({
      prompt: "build",
      cwd: await tmpDir("checkpoint-claude-run-"),
      onCheckpoint: async () => {
        throw new Error("the game folder is gone");
      },
    });
    assert.equal(script.calls[0]?.isError, true);
    assert.match(script.calls[0]?.text ?? "", /the game folder is gone/);
    assert.equal(result.ok, true);
  });

  it("on Codex answers what the host's checkpoint answers", async () => {
    const notes: string[] = [];
    const script = scriptedCodex([{ tool: "checkpoint", args: { note: NOTE } }]);
    const engine = await codex(script.fn as never);
    await engine.delegate({
      prompt: "build",
      cwd: await tmpDir("checkpoint-codex-run-"),
      onCheckpoint: answering(notes),
    });
    assert.deepEqual(notes, [NOTE]);
    assert.match(script.seen[0]?.stdout ?? "", /Took snapshot snap_1/);
  });
});

/** The Unreal plugin's id, as its tools' agent names start. */
const UNREAL = "unreal";
const SAVED = { saved: true, dirty: [], ms: 40 };

/**
 * The game's editor as the stand-in plugin answers for it: what it is doing (or a throw: it can't
 * say), what its save answers (or a throw: the save failed), and whether the person started the play.
 */
interface StandInEditor {
  activity: { pie: boolean; dirty: number } | Error;
  save: unknown;
  personPlays?: boolean;
}

/** The editor operations the plugin's own moment code uses, over the stand-in editor. */
function standInOps(editor: StandInEditor): MomentOps {
  const fail = (value: unknown) => {
    if (value instanceof Error) throw value;
    return value;
  };
  const state = { answering: true, running: true, reopening: { state: ReopenState.Idle }, helper: HelperState.Current };
  return {
    now: () => Date.now(),
    sleep: async () => {},
    signal: new AbortController().signal,
    answers: async () => true,
    running: async () => true,
    activity: async () => fail(editor.activity) as { pie: boolean; dirty: number },
    save: async () => {
      const saved = fail(editor.save) as { saved?: unknown; dirty?: unknown };
      return { saved: saved?.saved !== false, dirty: Array.isArray(saved?.dirty) ? saved.dirty.map(String) : [] };
    },
    end: async () => ({ ended: 1 }),
    reopen: async () => ({ started: true }),
    state: async () => state,
    start: async () => null,
    projectName: async () => "RailYard",
    updateHelper: async () => ({ from: "0", to: "0", kept: [] }),
    exported: async () => true,
    exportReference: async () => ({}),
    restoreClosed: { mark: () => {}, take: () => false },
  };
}

/**
 * The Unreal plugin's tools as a stand-in backend answers them: its moment steps through the
 * plugin's own moment code (`editor-moments.ts`), its lock's probe as `editor-activity` answers it.
 */
function standInTool(editor: StandInEditor, ran: string[], callers: unknown[]): PluginRegistry["tool"] {
  return (async (name: string, _args: unknown, binding: PluginBinding, _signal: unknown, caller: unknown) => {
    ran.push(name);
    callers.push(caller);
    const hook = binding.hook;
    if (name === `${UNREAL}__editor-activity`) {
      const activity = editor.activity;
      if (activity instanceof Error) throw activity;
      return probeAnswer(activity, editor.personPlays !== true, false);
    }
    if (name === `${UNREAL}__save-all` && hook) return saveAtMoment(standInOps(editor), hook);
    return {};
  }) as PluginRegistry["tool"];
}

/** A core with the Unreal plugin on, an Unreal game linked to a real `.uproject`, a web game, and a fixture engine that checkpoints once per turn. */
async function unrealWorld(lites: CoreLite[]) {
  let now = Date.now();
  const lite = await coreLite({
    gamesRoot: await realpath(await tmpDir("checkpoint-games-")),
    // The person-first wait runs on a clock of its own: a wait is over at once.
    locks: {
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
    },
  });
  lites.push(lite);
  const { core } = lite;
  await core.plugins.setEnabled(UNREAL, true);
  const seen: Array<{ request: DelegateRequest; answer: string | null }> = [];
  core.engines.register({
    id: "claude-code",
    label: "fixture",
    kind: "delegated",
    status: async () => ({ code: "ready", detail: "fixture" }),
    models: async () => [],
    delegate: async (request: DelegateRequest) => {
      const answer = request.onCheckpoint ? await request.onCheckpoint(NOTE) : null;
      seen.push({ request, answer });
      return { ok: true, engine: "claude-code", summary: "fixture", turns: 1, usage: {} };
    },
  } as never);
  const editor: StandInEditor = { activity: { pie: false, dirty: 3 }, save: SAVED };
  const ran: string[] = [];
  const callers: unknown[] = [];
  core.plugins.tool = standInTool(editor, ran, callers);
  const unreal = await core.games.scaffold("rail-yard");
  const web = await core.games.scaffold("pond");
  const projects = await realpath(await tmpDir("checkpoint-projects-"));
  await mkdir(path.join(projects, "RailYard"));
  const uproject = path.join(projects, "RailYard", "RailYard.uproject");
  await writeFile(uproject, '{"FileVersion":3}\n');
  await writeEngineBinding(unreal.dir, uproject);
  const api = core.api() as unknown as Record<"engine.delegate", (params: unknown) => Promise<unknown>>;
  const turn = async (game: { name: string }, extra: Record<string, unknown> = {}) => {
    // What the person was doing a moment ago is asked again.
    now += 10_000;
    ran.length = 0;
    callers.length = 0;
    const threadId = await core.threadForGame(game.name);
    await api["engine.delegate"]({ engine: "claude-code", prompt: "Build", project: game.name, threadId, ...extra });
    const last = seen.at(-1);
    assert.ok(last);
    return last;
  };
  const snapshots = () => core.snapshotIndex.all().filter((s) => s.reason.includes(NOTE));
  return { core, unreal, web, turn, ran, callers, editor, snapshots };
}

describe("an Unreal game's checkpoint", () => {
  const lites: CoreLite[] = [];
  let world: Awaited<ReturnType<typeof unrealWorld>>;
  before(async () => {
    world = await unrealWorld(lites);
  });
  after(async () => {
    for (const lite of lites) {
      lite.core.plugins.cancel();
      await lite.close();
    }
  });

  /** One chat turn's checkpoint on the Unreal game, the editor as `editor` says. */
  async function checkpointWith(editor: Partial<StandInEditor>) {
    Object.assign(world.editor, { activity: { pie: false, dirty: 3 }, save: SAVED, personPlays: false }, editor);
    const before = world.snapshots().length;
    const { answer } = await world.turn(world.unreal);
    return { answer: answer ?? "", ran: [...world.ran], snapshots: world.snapshots().length - before };
  }

  it("saves the editor's unsaved work, then snapshots the game folder named for the note", async () => {
    const done = await checkpointWith({ activity: { pie: false, dirty: 3 } });
    assert.ok(done.ran.includes(`${UNREAL}__save-all`), done.ran.join(", "));
    assert.equal(done.snapshots, 1);
    assert.match(done.answer, /Saved 3 unsaved files in Unreal/);
    assert.match(done.answer, /Took snapshot \S+ of the game folder/);
    assert.match(done.answer, /Shown to the user\.$/);
  });

  it("never saves during a play session, and takes no snapshot then", async () => {
    const done = await checkpointWith({ activity: { pie: true, dirty: 3 } });
    assert.equal(done.snapshots, 0);
    assert.match(done.answer, /playing/);
    // The same words end a chat turn's line for the person, so they name no tool.
    assert.match(done.answer, /Stop the play session, then save again\./);
    assert.doesNotMatch(done.answer, /call checkpoint/);
  });

  it("with nothing unsaved, saves nothing and still snapshots", async () => {
    const done = await checkpointWith({ activity: { pie: false, dirty: 0 } });
    assert.equal(done.snapshots, 1);
    assert.match(done.answer, /nothing unsaved/);
  });

  it("never saves an editor that can't say what it is doing: the editor waits for a person Genex can't rule out", async () => {
    const done = await checkpointWith({ activity: new Error("The Genex editor helper didn't answer editor_activity") });
    assert.ok(!done.ran.includes(`${UNREAL}__save-all`), done.ran.join(", "));
    assert.equal(done.snapshots, 0);
    assert.match(done.answer, /could not tell whether the person is using Unreal/);
  });

  it("still snapshots what is on disk when the save fails or leaves work unsaved, and says so", async () => {
    const failed = await checkpointWith({
      save: new Error("This game's Unreal isn't answering, so Genex saved nothing."),
    });
    assert.equal(failed.snapshots, 1);
    assert.match(failed.answer, /not saved: This game's Unreal isn't answering/);
    const partial = await checkpointWith({
      activity: { pie: false, dirty: 2 },
      save: { saved: false, dirty: ["/Game/Maps/Yard", "/Game/Kit/Rail"], ms: 10 },
    });
    assert.equal(partial.snapshots, 1);
    assert.match(partial.answer, /2 files stayed unsaved in Unreal \(\/Game\/Maps\/Yard, \/Game\/Kit\/Rail\)/);
  });

  it("does nothing while the chat is in Plan mode", async () => {
    const threadId = await world.core.threadForGame(world.unreal.name);
    await world.core.setPermissionMode(threadId, PermissionMode.Plan);
    try {
      const done = await checkpointWith({});
      assert.deepEqual(done.ran, []);
      assert.equal(done.snapshots, 0);
      assert.match(done.answer, /Plan mode/);
    } finally {
      await world.core.setPermissionMode(threadId, PermissionMode.Manual);
    }
  });

  it("waits for the person's own play, and saves nothing while they are in it", async () => {
    const done = await checkpointWith({ activity: { pie: true, dirty: 3 }, personPlays: true });
    assert.ok(!done.ran.includes(`${UNREAL}__save-all`), done.ran.join(", "));
    assert.equal(done.snapshots, 0);
    assert.match(done.answer, /The person is using Unreal/);
  });
});

describe("which sessions get the real checkpoint", () => {
  const lites: CoreLite[] = [];
  after(async () => {
    for (const lite of lites) {
      lite.core.plugins.cancel();
      await lite.close();
    }
  });

  it("the chat's own session on an Unreal game saves and snapshots its game", async () => {
    const { core, unreal, turn, ran, callers } = await unrealWorld(lites);
    const { answer } = await turn(unreal);
    assert.deepEqual(
      ran.filter((name) => name !== `${UNREAL}__editor-activity`),
      [`${UNREAL}__save-all`, `${UNREAL}__log-errors`, `${UNREAL}__hero-shots`],
      "the plugin's steps at the checkpoint, in its manifest's order",
    );
    // Every one is a tool the plugin keeps for the harness: the registry runs them for no other caller.
    assert.ok(callers.length > 0 && callers.every((caller) => caller === PluginToolAudience.Harness));
    assert.match(answer ?? "", /Saved 3 unsaved files in Unreal/);
    const snapshot = core.snapshotIndex.all().find((s) => s.reason.includes(NOTE));
    assert.ok(snapshot, "a snapshot names the note");
    assert.equal(snapshot.scope, SnapshotScope.Game);
    const log = await readFile(path.join(unreal.dir, ".git", "logs", "HEAD"), "utf8");
    assert.match(log, new RegExp(snapshot.snapshot_id), "the game folder holds the snapshot's commit");
  });

  it("the chat's own session on a linked Unreal game with the plugin off still snapshots its game, running no step", async () => {
    const { core, unreal, turn, ran } = await unrealWorld(lites);
    await core.plugins.setEnabled(UNREAL, false);
    const { request, answer } = await turn(unreal);
    assert.ok(request.onCheckpoint, "the checkpoint is a real one");
    assert.deepEqual(ran, [], "no step of a plugin that is off");
    assert.match(answer ?? "", /Took snapshot snap_\w+ of the game folder/);
    const snapshot = core.snapshotIndex.all().find((s) => s.reason.includes(NOTE));
    assert.ok(snapshot, "a snapshot names the note");
    assert.equal(snapshot.scope, SnapshotScope.Game);
  });

  it("a web game's, a worktree's and a run's sessions only show the note", async () => {
    const { core, unreal, web, turn, ran } = await unrealWorld(lites);
    const worktree = path.join(core.layout.scratch, "autopilot", "run_x", "agent-1");
    await mkdir(worktree, { recursive: true });
    for (const [label, game, extra] of [
      ["a web game", web, {}],
      ["a sub-agent's worktree", unreal, { cwd: worktree }],
      ["a run's builder", unreal, { selfCapture: { project: unreal.name, root: unreal.dir, runId: "run_x" } }],
    ] as const) {
      const { request } = await turn(game, extra);
      assert.equal(request.onCheckpoint, undefined, label);
      assert.deepEqual(ran, [], label);
    }
  });

  it("a game whose plugins hook checkpoints gets the real checkpoint, and a web game only the note", async () => {
    const lite = await coreLite({ gamesRoot: await realpath(await tmpDir("checkpoint-hooked-")) });
    lites.push(lite);
    const { core } = lite;
    const hk = await hookPackage();
    await core.plugins.installLocal(hk.dir, PluginSourceKind.Local, []);
    await core.plugins.setEnabled(HOOK_PLUGIN, true);
    await hk.script({ "checkpoint.before:save": { note: "Saved the desk." } });
    const seen: Array<{ request: DelegateRequest; answer: string | null }> = [];
    core.engines.register({
      id: "claude-code",
      label: "fixture",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "fixture" }),
      models: async () => [],
      delegate: async (request: DelegateRequest) => {
        const answer = request.onCheckpoint ? await request.onCheckpoint(NOTE) : null;
        seen.push({ request, answer });
        return { ok: true, engine: "claude-code", summary: "fixture", turns: 1, usage: {} };
      },
    } as never);
    const desk = await core.games.scaffold("desk-yard");
    await writeFile(path.join(desk.dir, "Desk.hkproj"), "{}\n");
    const web = await core.games.scaffold("puddle");
    const api = core.api() as unknown as Record<"engine.delegate", (params: unknown) => Promise<unknown>>;
    for (const game of [desk, web]) {
      const threadId = await core.threadForGame(game.name);
      await api["engine.delegate"]({ engine: "claude-code", prompt: "Build", project: game.name, threadId });
    }
    const [hooked, plain] = seen;
    assert.match(hooked?.answer ?? "", /Saved the desk\./);
    const snapshot = core.snapshotIndex.all().find((s) => s.reason.includes(NOTE));
    assert.ok(snapshot, "a snapshot names the note");
    assert.match(hooked?.answer ?? "", new RegExp(`Took snapshot ${snapshot.snapshot_id} of the game folder`));
    assert.deepEqual(await hk.trail(), [
      "probe",
      "checkpoint.before:save",
      "checkpoint.before:flush",
      "checkpoint.after:shot",
    ]);
    assert.equal(plain?.request.onCheckpoint, undefined, "a web game's checkpoint only shows the note");
  });
});
