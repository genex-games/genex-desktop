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
import { setImmediate as nextTurn } from "node:timers/promises";
import type { PluginEngineLink, PluginToolbarStatus } from "../../src/plugin-sdk/index.d.ts";
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
import type { EpicInstallDeps } from "../../src/plugins/unreal/epic-install.ts";
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
 * A fake Mac (or, with `platform`, a fake Windows PC) with the engines listed in Epic's launcher
 * list, a 5.8 project Lantern and a second one, Harbor; with `game` the calls come from that open
 * Genex game, whose link the host keeps.
 */
async function computer(
  options: {
    engines?: Installed;
    game?: string | null;
    platform?: "darwin" | "win32";
    /** What Do it for me installs with; none: the launcher's step opens Epic's download page. */
    install?: EpicInstallDeps;
    /** Whether Windows has the runtime Unreal's editor loads, asked each time. */
    runtime?: () => boolean;
    /** Whether the host can hand a setup task to the chat, and how it answers one. */
    assist?: { can: boolean; answer: { started: boolean; reason?: string } };
  } = {},
) {
  const root = await realpath(await tmpDir("studio-unreal-first-use-"));
  const home = path.join(root, "home");
  const storage = path.join(root, "storage");
  const platform = options.platform ?? "darwin";
  const windows = platform === "win32";
  const programData = path.join(home, "ProgramData");
  /** Where Epic keeps its launcher's own files on this computer. */
  const epicData = windows ? path.join(programData, "Epic") : path.join(home, "Library", "Application Support", "Epic");
  /** An engine's folder with its editor in it, as Epic's launcher installs it. */
  const engineFolder = async (version: string) => {
    const folder = path.join(root, "Engines", `UE_${version}`);
    const binaries = path.join(folder, "Engine", "Binaries");
    if (windows) {
      await mkdir(path.join(binaries, "Win64"), { recursive: true });
      await writeFile(path.join(binaries, "Win64", "UnrealEditor.exe"), "MZ");
    } else await mkdir(path.join(binaries, "Mac", "UnrealEditor.app"), { recursive: true });
    return folder;
  };
  const list = [];
  for (const [version, build] of options.engines ?? ONLY_58)
    list.push({
      InstallLocation: await engineFolder(version),
      AppVersion: `${build}-1+++UE5+Release-${version}-Mac`,
      AppName: `UE_${version}`,
    });
  const epic = path.join(epicData, "UnrealEngineLauncher");
  await mkdir(epic, { recursive: true });
  await writeFile(path.join(epic, "LauncherInstalled.dat"), JSON.stringify({ InstallationList: list }));
  /** Unreal installed as Epic's launcher records it since 2025: in an install record of its own, its list left as it was. */
  const installByRecord = async (version: string, build: string) => {
    const records = path.join(epicData, "EpicGamesLauncher", "Data", "Manifests");
    await mkdir(records, { recursive: true });
    const record = {
      bIsIncompleteInstall: false,
      InstallLocation: await engineFolder(version),
      AppName: `UE_${version}`,
      AppVersionString: `${build}-1+++UE5+Release-${version}-Windows`,
    };
    await writeFile(path.join(records, `UE_${version}.item`), JSON.stringify(record, null, "\t"));
  };
  /** Where each system's launcher is looked for: Applications on a Mac, both Program Files on Windows. */
  const folders = windows
    ? { applications: path.join(root, "Program Files (x86)"), programFiles: path.join(root, "Program Files") }
    : { applications: path.join(root, "Applications") };
  /** Epic's launcher, installed where it installs itself: the 64-bit one in Program Files, or the Mac app. */
  const launcherExe = path.join(root, "Program Files", "Epic Games", "Launcher", "Portal", "Binaries", "Win64");
  const addLauncher = async () => {
    if (!windows) {
      const app = path.join(folders.applications, "Epic Games Launcher.app");
      await mkdir(app, { recursive: true });
      return app;
    }
    await mkdir(launcherExe, { recursive: true });
    await writeFile(path.join(launcherExe, "EpicGamesLauncher.exe"), "MZ");
    return path.join(launcherExe, "EpicGamesLauncher.exe");
  };
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
    platform,
    programData,
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
      ...folders,
      now: () => clock.now,
    },
    ...(options.install ? { install: options.install } : {}),
    ...(options.runtime ? { runtime: async () => options.runtime?.() ?? true } : {}),
  });
  const game: { link: PluginEngineLink | null } = { link: null };
  /** The games whose Loop is going, as the host's `game.engine.runs` names them. */
  const runs: Array<{ game: string; title: string; project: string }> = [];
  /** Each task handed to the chat with `game.engine.assist`. */
  const assisted: string[] = [];
  const host = async (method: string, args?: { project: string; task?: string }) => {
    if (method === "storage.root") return storage;
    if (method === "game.engine.runs") return runs;
    if (method === "game.engine.read") return game.link;
    if (method === "game.engine.steps") return true;
    if (method === "game.engine.canAssist" && options.assist) return options.assist.can;
    if (method === "game.engine.assist" && options.assist) {
      assisted.push(args?.task ?? "");
      return options.assist.answer;
    }
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
  /** The same calls from another open game of the same Genex. */
  const inGame = (other: string) => ({ ...context, project: other, directory: path.join(root, "games", other) });
  const actFor = async (other: string, name: string) => backend.action?.(name, {}, inGame(other));
  const toolFor = async (other: string, name: string, args: Record<string, unknown> = {}) =>
    backend.tool?.(name, args as never, inGame(other));
  const lantern = await project("Lantern");
  const harbor = await project("Harbor");
  /** Lantern set up and this game linked to it, as New game leaves it. */
  const linkLantern = async () => {
    await act("setup", { project: lantern });
    await act("use-project", { project: lantern });
    return realpath(lantern);
  };
  return {
    root,
    storage,
    live,
    clock,
    launched,
    assisted,
    installByRecord,
    addLauncher,
    act,
    tool,
    actFor,
    toolFor,
    lantern,
    harbor,
    linkLantern,
    runs,
  };
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
    it(`says Not installed, not Set up or Add (${game ? "in a game" : "no game open"})`, async () => {
      const c = await computer({ engines: [], game });
      const status = (await c.act("toolbar-status")) as { badge: string; title: string; dot: boolean };
      assert.deepEqual([status.badge, status.dot], ["Not installed", true]);
      assert.match(status.title, /5\.8/);
    });

  it("comes out only on a game whose chat chose Unreal (show-steps, or new-game refused), never on another", async () => {
    const c = await computer({ engines: [] });
    const shown = async (game?: string) =>
      ((game ? await c.actFor(game, "toolbar-status") : await c.act("toolbar-status")) as PluginToolbarStatus).shown;
    assert.equal(await shown(), undefined, "a game whose chat never asked for Unreal");
    assert.match(
      String(await c.tool("show-steps")),
      /Unreal setup card is in the chat, and the Unreal button is above the game/,
    );
    assert.equal(await shown(), true);
    assert.equal(await shown("harbor-night"), undefined, "another game's strip stays as it was");
    await assert.rejects(
      c.toolFor("harbor-night", "new-game", { template: "TP_BlankBP", name: "Harbor" }),
      /isn't on this computer/,
    );
    assert.equal(await shown("harbor-night"), true, "a new game refused for want of Unreal brings it out too");
  });
});

describe("the Unreal setup card on a Mac without Unreal", () => {
  it("shows getting Unreal while it's missing, and closes on Don't use Unreal until the agent shows it again", async () => {
    const c = await computer({ engines: [] });
    type Card = { open: boolean; steps: { id: string }[]; doneSays?: string };
    const card = async () => (await c.act("steps")) as Card;
    await c.tool("show-steps");
    const missing = await card();
    assert.equal(missing.open, true);
    assert.deepEqual(
      missing.steps.map((step) => step.id),
      ["get-launcher", "install-engine"],
    );
    await c.act("skip");
    const skipped = await card();
    assert.equal(skipped.open, false);
    assert.match(String(skipped.doneSays), /web game/);
    await c.tool("show-steps");
    assert.equal((await card()).open, true, "the person changed their mind");
  });
});

describe("Unreal on a fresh Windows PC", () => {
  type Card = { open: boolean; steps: { id: string; done: boolean }[]; doneSays?: string };
  const card = async (c: Awaited<ReturnType<typeof computer>>) => (await c.act("steps")) as Card;

  it("notices Unreal that Epic's launcher keeps only in its install record: the card closes and tells the agent to go on", async () => {
    const c = await computer({ engines: [], platform: "win32" });
    await c.tool("show-steps");
    assert.equal((await card(c)).open, true);
    await c.installByRecord("5.8", "5.8.4");
    const status = (await c.tool("engine-status")) as Record<string, unknown>;
    assert.deepEqual([status.engine, status.version, status.ready], [EngineReadiness.Ready, "5.8", true]);
    const done = await card(c);
    assert.equal(done.open, false);
    assert.match(String(done.doneSays), /^Unreal 5\.8 is installed on this computer\. Go on with the person's game/);
    const toolbar = (await c.act("toolbar-status")) as { badge?: string };
    assert.notEqual(toolbar.badge, "Not installed");
  });

  it("counts Epic's 64-bit launcher in Program Files as got, and its button opens that launcher", {
    skip: process.platform !== "win32" && "Windows paths name a PC's own folders",
  }, async () => {
    const c = await computer({ engines: [], platform: "win32" });
    await c.tool("show-steps");
    const steps = async () => (await card(c)).steps.map((step) => [step.id, step.done]);
    assert.deepEqual(await steps(), [
      ["get-launcher", false],
      ["install-engine", false],
    ]);
    const launcher = await c.addLauncher();
    assert.deepEqual(await steps(), [
      ["get-launcher", true],
      ["install-engine", false],
    ]);
    assert.deepEqual(await c.act("get-unreal"), { opened: "launcher" });
    assert.deepEqual(c.launched, [{ command: launcher, args: [], detached: true }]);
  });
});

describe("Do it for me on the Unreal setup card", () => {
  type Button = { name: string; label: string };
  type Card = {
    open: boolean;
    steps: { id: string; done: boolean; you?: true; working?: true; detail: string }[];
    primary?: Button;
    secondary?: Button;
    doneSays?: string;
    stuckSays?: string;
  };
  type Answer = { step: string; started: boolean; message: string; reason?: string };
  const card = async (c: Awaited<ReturnType<typeof computer>>) => (await c.act("steps")) as Card;
  const step = (shown: Card, id: string) => shown.steps.find((row) => row.id === id);
  const EPIC = "CN=Epic Games Inc., O=Epic Games Inc., L=Cary, S=North Carolina, C=US";
  const MICROSOFT = "CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US";

  /** Looks again, a turn of the event loop apart, until `check` holds. */
  async function settle(check: () => Promise<boolean>) {
    for (let turn = 0; turn < 500; turn++) {
      if (await check()) return;
      await nextTurn();
    }
    assert.fail("Do it for me never got there");
  }

  /**
   * Windows' side of Do it for me, faked: Epic's download held until `gate` opens (or the Stop),
   * Authenticode answering Epic's or Microsoft's signature by the file checked (none when
   * `unsigned`), and each installer's run handed to `onInstall`.
   */
  async function fakeInstall(
    script: { gate?: Promise<void>; unsigned?: boolean; onInstall?: (file: string) => Promise<void> } = {},
  ) {
    const ran: string[] = [];
    const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
      const stopped = new Promise<never>((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
      );
      await Promise.race([script.gate ?? Promise.resolve(), stopped]);
      return new Response(Buffer.from("epic installer"), { status: 200 });
    }) as typeof fetch;
    const run: EpicInstallDeps["run"] = async (file, _args, options) => {
      ran.push(path.win32.basename(file));
      if (!file.endsWith("powershell.exe")) {
        await script.onInstall?.(file);
        return { code: 0, stdout: "" };
      }
      const subject = options.env?.GENEX_INSTALLER?.endsWith(".msi") ? EPIC : MICROSOFT;
      const signature = script.unsigned ? { status: "NotSigned", subject: "" } : { status: "Valid", subject };
      return { code: 0, stdout: JSON.stringify(signature) };
    };
    const tempRoot = await tmpDir("unreal-for-me-");
    const install: EpicInstallDeps = {
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      fetch: fetchFn,
      run,
      tempRoot,
    };
    return { install, ran };
  }

  it("hands installing Unreal to the game's chat once the launcher is here, opening the launcher first", async () => {
    const c = await computer({ engines: [], assist: { can: true, answer: { started: true } } });
    const launcher = await c.addLauncher();
    await c.tool("show-steps");
    const shown = await card(c);
    assert.equal(shown.primary?.name, "install-for-me");
    assert.equal(step(shown, "install-engine")?.you, undefined, "Genex does it; only signing in is the person's");
    const answer = (await c.act("install-for-me")) as Answer;
    assert.deepEqual([answer.step, answer.started], ["engine", true]);
    const [opened] = c.launched;
    assert.equal(c.launched.length, 1);
    assert.deepEqual(
      [opened?.command, opened?.args[0], path.normalize(opened?.args[1] ?? "")],
      ["/usr/bin/open", "-a", path.normalize(launcher)],
    );
    assert.equal(c.assisted.length, 1);
    const task = c.assisted[0] ?? "";
    assert.match(task, /^Install Unreal Engine 5\.8 in the Epic Games Launcher/);
    assert.ok(task.length <= 300 && !task.includes("\n"), "one plain line, as the host takes a task");
  });

  it("leaves the launcher open with the click path when the chat can't click, and tells the agent why", async () => {
    const c = await computer({ engines: [], assist: { can: true, answer: { started: false, reason: "declined" } } });
    await c.addLauncher();
    const answer = (await c.act("install-for-me")) as Answer;
    assert.deepEqual([answer.started, answer.reason], [false, "declined"]);
    assert.match(answer.message, /Library, \+ beside Engine Versions, 5\.8, Install/);
    assert.equal(c.launched.length, 1, "the launcher is open for the person");
    assert.match(String(await c.tool("install-unreal")), /couldn't hand the install to this chat \(declined\)/);
  });

  it("offers no Do it for me for Unreal itself where the chat can't click, leaving it the person's", async () => {
    const c = await computer({
      engines: [],
      assist: { can: false, answer: { started: false, reason: "unavailable" } },
    });
    await c.addLauncher();
    await c.tool("show-steps");
    const shown = await card(c);
    assert.equal(shown.primary, undefined);
    assert.equal(step(shown, "install-engine")?.you, true);
  });

  it("installs Epic's launcher itself on Windows: the card follows the install, and the launcher opens once it is in", async () => {
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    // Windows Installer puts the launcher where it installs itself, on the computer below.
    const installed: { add?: () => Promise<string> } = {};
    const { install, ran } = await fakeInstall({ gate, onInstall: async () => void (await installed.add?.()) });
    const d = await computer({
      engines: [],
      platform: "win32",
      install,
      assist: { can: true, answer: { started: true } },
    });
    installed.add = d.addLauncher;
    await d.tool("show-steps");
    const offered = await card(d);
    assert.equal(offered.primary?.name, "install-for-me");
    assert.match(step(offered, "get-launcher")?.detail ?? "", /downloads it from Epic/);
    const answer = (await d.act("install-for-me")) as Answer;
    assert.deepEqual([answer.step, answer.started], ["launcher", true]);
    const working = await card(d);
    assert.deepEqual(
      [step(working, "get-launcher")?.working, working.secondary?.name, working.primary],
      [true, "stop-install", undefined],
    );
    assert.match(step(working, "get-launcher")?.detail ?? "", /Downloading the Epic Games Launcher from Epic/);
    open();
    // The install is over once Stop goes: the launcher's row may tick sooner, as soon as it is found.
    await settle(async () => (await card(d)).secondary?.name !== "stop-install");
    assert.deepEqual(
      ran,
      ["powershell.exe", "msiexec.exe"],
      "Epic's signature checked before Windows Installer ran it",
    );
    assert.equal(d.launched.length, 1, "the launcher (or, where it can't be found, Epic's page) opens for the sign-in");
    assert.equal((await card(d)).stuckSays, undefined);
  });

  it("stops the download at the person's Stop without telling the agent, and tells it once an install fails", async () => {
    const held = await fakeInstall({ gate: new Promise<void>(() => {}) });
    const c = await computer({ engines: [], platform: "win32", install: held.install });
    await c.tool("show-steps");
    await c.act("install-for-me");
    assert.deepEqual(await c.act("stop-install"), { stopped: true, message: "Stopped." });
    await settle(async () => (await card(c)).secondary?.name !== "stop-install");
    assert.equal((await card(c)).stuckSays, undefined, "the person's own Stop is not news to the agent");
    assert.deepEqual(held.ran, [], "nothing ran");
    const unsigned = await fakeInstall({ unsigned: true });
    const d = await computer({ engines: [], platform: "win32", install: unsigned.install });
    await d.tool("show-steps");
    await d.act("install-for-me");
    await settle(async () => (await card(d)).stuckSays !== undefined);
    assert.match(String((await card(d)).stuckSays), /^Do it for me stopped; the card says: The installer isn't signed/);
    assert.deepEqual(unsigned.ran, ["powershell.exe"], "an unsigned installer never runs");
  });

  it("refuses a new game while Windows lacks Unreal's runtime, then installs it from Unreal's own copy and closes the card", async () => {
    const present = { runtime: false };
    const { install, ran } = await fakeInstall({
      onInstall: async () => {
        present.runtime = true;
      },
    });
    const c = await computer({ platform: "win32", install, runtime: () => present.runtime });
    const redist = path.join(c.root, "Engines", "UE_5.8", "Engine", "Extras", "Redist", "en-us");
    await mkdir(redist, { recursive: true });
    await writeFile(path.join(redist, "vc_redist.x64.exe"), "MZ");
    await assert.rejects(c.tool("new-game", { template: "TP_BlankBP", name: "Lantern" }), /Visual C\+\+ runtime/);
    const missing = await card(c);
    assert.equal(missing.open, true, "the game chose Unreal: its card shows what is missing");
    assert.deepEqual(
      missing.steps.map((row) => [row.id, row.done]),
      [
        ["get-launcher", true],
        ["install-engine", true],
        ["install-runtime", false],
      ],
    );
    assert.equal(missing.primary?.name, "install-for-me");
    const answer = (await c.act("install-for-me")) as Answer;
    assert.deepEqual([answer.step, answer.started], ["runtime", true]);
    await settle(async () => !(await card(c)).open);
    assert.deepEqual(ran, ["powershell.exe", "vc_redist.x64.exe"]);
    assert.match(String((await card(c)).doneSays), /^Unreal 5\.8 is installed on this computer/);
  });

  it("answers what is left once everything is in", async () => {
    const c = await computer({ assist: { can: true, answer: { started: true } } });
    const answer = (await c.act("install-for-me")) as Answer;
    assert.deepEqual([answer.step, answer.started], ["done", false]);
    assert.match(answer.message, /Unreal 5\.8 and everything it needs are on this computer/);
    assert.match(String(await c.tool("install-unreal")), /call unreal__new-game/);
    assert.deepEqual(c.assisted, [], "nothing handed to the chat");
  });
});

describe("the toolbar with Unreal installed", () => {
  it("leaves a game with no Unreal project to its facts: nothing brings the button out", async () => {
    const c = await computer();
    assert.deepEqual(await c.act("toolbar-status"), { tone: "info", title: "Make this game in Unreal" });
  });
});
