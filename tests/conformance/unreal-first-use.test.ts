/**
 * A newcomer's first steps with the Unreal plugin, through the backend's interface over a fake
 * computer: what the harness asks before a new game's engine question (`engine-status`) and after a
 * turn that made the game's Unreal project (`wait-editor`), the Live stage's own status
 * (`stage-status`), and the toolbar's word with no Unreal installed. Nothing here runs Unreal.
 */
import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import type { PluginEngineLink } from "../../src/plugin-sdk/index.d.ts";
import { createUnrealBackend, PanelStep } from "../../src/plugins/unreal/backend.ts";
import type { Launch } from "../../src/plugins/unreal/editor-launch.ts";
import type { EditorLog } from "../../src/plugins/unreal/editor-log.ts";
import { EditorStart } from "../../src/plugins/unreal/editor-status.ts";
import {
  EditorWait,
  EngineReadiness,
  WAIT_EDITOR_MAX_MS,
  waitForEditor,
} from "../../src/plugins/unreal/editor-wait.ts";
import type { SetupEnv } from "../../src/plugins/unreal/setup.ts";
import { XcodeState } from "../../src/plugins/unreal/xcode.ts";
import { tmpDir } from "../helpers/tmp.ts";

const HELPER = path.resolve("src/plugins/unreal/GenexEditorHelper");
const GIB = 1024 ** 3;
const START = Date.UTC(2026, 9, 6, 9, 0, 0);
const SECOND_MS = 1000;

/** Engines by version and build, as Epic's launcher lists them. */
type Installed = Array<[string, string]>;
const ONLY_58: Installed = [["5.8", "5.8.3"]];

/**
 * A fake Mac with the engines listed, a 5.8 project Lantern and a second one, Harbor; with `game`
 * the calls come from that open Genex game, whose link the host keeps.
 */
async function computer(options: { engines?: Installed; game?: string | null } = {}) {
  const root = await realpath(await tmpDir("studio-unreal-first-use-"));
  const home = path.join(root, "home");
  const storage = path.join(root, "storage");
  const list = [];
  for (const [version, build] of options.engines ?? ONLY_58) {
    const folder = path.join(root, "Engines", `UE_${version}`);
    await mkdir(path.join(folder, "Engine", "Binaries", "Mac", "UnrealEditor.app"), { recursive: true });
    list.push({
      InstallLocation: folder,
      AppVersion: `${build}-1+++UE5+Release-${version}-Mac`,
      AppName: `UE_${version}`,
    });
  }
  const epic = path.join(home, "Library", "Application Support", "Epic", "UnrealEngineLauncher");
  await mkdir(epic, { recursive: true });
  await writeFile(path.join(epic, "LauncherInstalled.dat"), JSON.stringify({ InstallationList: list }));
  const project = async (name: string) => {
    const file = path.join(root, "Projects", name, `${name}.uproject`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({ FileVersion: 3, EngineAssociation: "5.8" }, null, "\t")}\n`);
    return file;
  };
  /**
   * `serving`: the project the answering editor has open; `log`: what each project's own log says
   * (none: no log); `held`: the projects whose logs a running editor holds, by name.
   */
  const live: { running: boolean; serving: string | null; log?: EditorLog; held?: string[] } = {
    running: false,
    serving: null,
  };
  const env: SetupEnv = {
    home,
    platform: "darwin",
    programData: path.join(home, "ProgramData"),
    editorRunning: async () => live.running,
    editorLog: async () => live.log,
    heldProjects: async () => live.held ?? [],
    portListening: async () => false,
    editorAnswers: async (_port, asked) => live.running && live.serving !== null && live.serving === asked,
    xcode: async () => ({
      state: XcodeState.Ready,
      app: "/Applications/Xcode.app",
      version: "26.2",
      commandLineTools: true,
      supported: null,
      command: null,
    }),
    freeBytes: async () => 200 * GIB,
    totalMemory: () => 32 * GIB,
  };
  const launched: Launch[] = [];
  const clock = { now: START };
  const backend = createUnrealBackend({
    env,
    helper: HELPER,
    projects: async () => path.join(home, "Documents", "Unreal Projects"),
    launch: {
      open: async (l) => void launched.push(l),
      applications: path.join(root, "Applications"),
      now: () => clock.now,
    },
  });
  const game: { link: PluginEngineLink | null } = { link: null };
  /** The games whose Loop is going, as the host's `game.engine.runs` names them. */
  const runs: Array<{ game: string; title: string; project: string }> = [];
  const host = async (method: string, args?: { project: string }) => {
    if (method === "storage.root") return storage;
    if (method === "game.engine.runs") return runs;
    if (method === "game.engine.read") return game.link;
    if (method === "game.engine.steps") return true;
    if (method !== "game.engine.link") throw new Error(`unexpected host call ${method}`);
    const linked = args?.project ?? "";
    game.link = { kind: "unreal", project: linked, name: path.basename(linked, ".uproject"), linkedAt: "" };
    return game.link;
  };
  const gameName = options.game === undefined ? "lantern-run" : options.game;
  const context = {
    signal: new AbortController().signal,
    callId: 1,
    host: host as never,
    ...(gameName ? { project: gameName, directory: path.join(root, "games", gameName) } : {}),
  };
  const act = async (name: string, args: Record<string, unknown> = {}) => backend.action?.(name, args, context);
  const tool = async (name: string, args: Record<string, unknown> = {}) => backend.tool?.(name, args as never, context);
  const lantern = await project("Lantern");
  const harbor = await project("Harbor");
  /** Lantern set up and this game linked to it, as New game leaves it. */
  const linkLantern = async () => {
    await act("setup", { project: lantern });
    await act("use-project", { project: lantern });
    return realpath(lantern);
  };
  return { root, storage, live, clock, launched, act, tool, lantern, harbor, linkLantern, runs };
}

describe("engine-status, before a new game's engine question", () => {
  const rows: Array<[string, Installed, string, string | null]> = [
    ["no Unreal at all", [], EngineReadiness.None, null],
    ["only an Unreal older than 5.8", [["5.4", "5.4.4"]], EngineReadiness.OlderOnly, "5.4"],
    ["Unreal 5.8", ONLY_58, EngineReadiness.Ready, "5.8"],
    ["only a newer Unreal", [["5.9", "5.9.0"]], EngineReadiness.NewerOnly, "5.9"],
    ["a newer Unreal beside 5.8", [["5.9", "5.9.0"], ...ONLY_58], EngineReadiness.Ready, "5.8"],
  ];
  for (const [name, engines, engine, version] of rows)
    it(`says ${engine} for ${name}`, async () => {
      const c = await computer({ engines });
      const answer = (await c.tool("engine-status")) as Record<string, unknown>;
      assert.deepEqual({ engine: answer.engine, version: answer.version }, { engine, version });
      assert.equal(answer.ready, engine === EngineReadiness.Ready, "ready only when a new game can be made here");
      assert.equal(typeof answer.note, "string", "with the words the card shows");
    });
});

describe("wait-editor, after a turn that made the game's Unreal project", () => {
  it("says the game has no project to wait for until it is linked to a set-up one", async () => {
    const c = await computer();
    assert.deepEqual(await c.tool("wait-editor", { seconds: 0 }), { state: EditorWait.NoProject, project: null });
  });

  it("is ready once the game's own editor answers", async () => {
    const c = await computer();
    const project = await c.linkLantern();
    Object.assign(c.live, { running: true, serving: project });
    assert.deepEqual(await c.tool("wait-editor", { seconds: 0 }), { state: EditorWait.Ready, project: "Lantern" });
  });

  it("is starting right after Genex opened it, and not starting once nothing opens it", async () => {
    const c = await computer();
    await c.linkLantern();
    assert.equal(((await c.tool("wait-editor", { seconds: 0 })) as { state: string }).state, EditorWait.NotStarting);
    await c.act("open-editor", { project: c.lantern });
    assert.equal(c.launched.length, 1, "Unreal was asked to open it");
    assert.equal(((await c.tool("wait-editor", { seconds: 0 })) as { state: string }).state, EditorWait.Starting);
  });

  it("never waits on another project's editor", async () => {
    const c = await computer();
    await c.linkLantern();
    Object.assign(c.live, { running: true, serving: await realpath(c.harbor) });
    assert.notEqual(((await c.tool("wait-editor", { seconds: 0 })) as { state: string }).state, EditorWait.Ready);
  });
});

describe("waiting for an editor", () => {
  /** An editor that starts for `startsFor` asks, then answers (or, with `then`, stops starting that way). */
  function editor(startsFor: number, then: "answers" | EditorStart = "answers") {
    const clock = { now: 0, slept: 0, asked: 0 };
    const deps = {
      answers: async () => clock.asked > startsFor && then === "answers",
      start: async () =>
        clock.asked++ < startsFor ? EditorStart.Starting : then === "answers" ? EditorStart.Starting : then,
      now: () => clock.now,
      sleep: async (ms: number) => {
        clock.now += ms;
        clock.slept++;
      },
    };
    return { clock, deps };
  }

  it("answers Ready as soon as the editor answers, without sleeping when it already does", async () => {
    const ready = editor(0);
    ready.clock.asked = 1;
    assert.equal(await waitForEditor(ready.deps, 60 * SECOND_MS), EditorWait.Ready);
    assert.equal(ready.clock.slept, 0);
    const later = editor(3);
    assert.equal(await waitForEditor(later.deps, 60 * SECOND_MS), EditorWait.Ready);
    assert.ok(later.clock.slept >= 3);
  });

  it("stops at once when the editor stops starting without answering", async () => {
    assert.equal(await waitForEditor(editor(2, EditorStart.NotStarting).deps, 60 * SECOND_MS), EditorWait.NotStarting);
    assert.equal(await waitForEditor(editor(2, EditorStart.PortBlocked).deps, 60 * SECOND_MS), EditorWait.PortBlocked);
  });

  it("says Starting when its time runs out, and never waits longer than one plugin call may", async () => {
    const slow = editor(Number.POSITIVE_INFINITY);
    assert.equal(await waitForEditor(slow.deps, 10 * SECOND_MS), EditorWait.Starting);
    assert.ok(slow.clock.now >= 10 * SECOND_MS && slow.clock.now < 20 * SECOND_MS);
    const capped = editor(Number.POSITIVE_INFINITY);
    assert.equal(await waitForEditor(capped.deps, 60 * 60 * SECOND_MS), EditorWait.Starting);
    assert.ok(capped.clock.now <= WAIT_EDITOR_MAX_MS + 3 * SECOND_MS, "capped below the host's call limit");
    const look = editor(Number.POSITIVE_INFINITY);
    assert.equal(await waitForEditor(look.deps, 0), EditorWait.Starting);
    assert.equal(look.clock.slept, 0, "a wait of 0 only looks");
  });

  it("ends when its signal does", async () => {
    const stopped = new AbortController();
    stopped.abort();
    const slow = editor(Number.POSITIVE_INFINITY);
    assert.equal(await waitForEditor(slow.deps, 60 * SECOND_MS, stopped.signal), EditorWait.Starting);
    assert.equal(slow.clock.slept, 0);
  });
});

describe("stage-status, the Live card's own status", () => {
  type Stage = {
    next: string;
    firstStart: boolean;
    project: { name: string } | null;
    openProject: { name: string } | null;
    holder: string | null;
    busyRun: { title: string; project: string; here: boolean } | null;
  };
  const stage = async (c: Awaited<ReturnType<typeof computer>>) => (await c.act("stage-status")) as Stage;

  it("names the step the card offers for the game's own project, through each state", async () => {
    const c = await computer();
    assert.equal((await stage(c)).next, PanelStep.Choose, "no project yet");
    await c.act("use-project", { project: c.lantern }).catch(() => undefined);
    await c.act("setup", { project: c.lantern });
    await c.act("use-project", { project: c.lantern });
    const real = await realpath(c.lantern);
    assert.deepEqual([(await stage(c)).next, (await stage(c)).project?.name], [PanelStep.Open, "Lantern"]);
    await c.act("open-editor", { project: c.lantern });
    c.live.running = true;
    assert.deepEqual(
      [(await stage(c)).next, (await stage(c)).firstStart],
      [PanelStep.Starting, true],
      "Unreal never listed Lantern: its first start",
    );
    c.live.serving = real;
    assert.equal((await stage(c)).next, PanelStep.Connected);
  });

  it("offers Switch while Unreal has another set-up project open", async () => {
    const c = await computer();
    await c.act("setup", { project: c.harbor });
    await c.linkLantern();
    Object.assign(c.live, { running: true, serving: await realpath(c.harbor) });
    c.clock.now += 30 * 60 * SECOND_MS;
    const now = await stage(c);
    assert.deepEqual([now.next, now.openProject?.name], [PanelStep.Switch, "Harbor"]);
  });

  it("names the Loop that is using Unreal, so the card can keep it open", async () => {
    const c = await computer();
    await c.act("setup", { project: c.harbor });
    await c.linkLantern();
    const harbor = await realpath(c.harbor);
    Object.assign(c.live, { running: true, serving: harbor });
    c.clock.now += 30 * 60 * SECOND_MS;
    assert.equal((await stage(c)).busyRun, null, "no run is going");
    c.runs.push({ game: "harbor-night", title: "Harbor Night", project: harbor });
    const now = await stage(c);
    assert.deepEqual(
      [now.next, now.busyRun],
      [PanelStep.Switch, { title: "Harbor Night", project: harbor, here: false }],
    );
  });

  it("offers no restart while Unreal has a project open that isn't the game's, and names that project", async () => {
    const c = await computer();
    await c.linkLantern();
    Object.assign(c.live, { running: true, held: ["Harbor"] });
    c.clock.now += 30 * 60 * SECOND_MS;
    const now = await stage(c);
    assert.deepEqual([now.next, now.holder, now.busyRun], [PanelStep.OpenWhenFree, "Harbor", null]);
    c.live.log = {
      open: true,
      openedAt: c.clock.now - 60 * SECOND_MS,
      mtime: c.clock.now,
      mcpStarted: false,
      loaded: true,
    };
    assert.deepEqual(
      [(await stage(c)).next, (await stage(c)).holder],
      [PanelStep.NotAnswering, null],
      "Unreal has Lantern itself open, silent: restart it",
    );
  });

  it("offers Get Unreal when no Unreal Genex works with is installed", async () => {
    const c = await computer({ engines: [] });
    assert.equal((await stage(c)).next, PanelStep.GetUnreal);
  });
});

describe("the toolbar with no Unreal installed", () => {
  for (const game of ["lantern-run", null])
    it(`says Get, not Set up or Add (${game ? "in a game" : "no game open"})`, async () => {
      const c = await computer({ engines: [], game });
      const status = (await c.act("toolbar-status")) as { badge: string; title: string };
      assert.equal(status.badge, "Get");
      assert.match(status.title, /5\.8/);
    });
});
