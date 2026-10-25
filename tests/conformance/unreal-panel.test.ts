/**
 * The real Set up Unreal panel (`src/plugins/unreal/panel.html`) against the real backend, in
 * headless Chrome. The panel's `window.studioPlugin` is a stand-in whose `call("action", …)` runs
 * `createUnrealBackend` over a fake computer: a temporary home with Epic's launcher list and a fake
 * engine, a temporary storage, and an opener that records what it would start and starts nothing.
 * Every step the backend names must give the project view a headline or a primary button, and the
 * primary must send its action for the shown project. Opt-in: it launches a browser, so it runs only
 * with `STUDIO_BROWSER_TESTS=1` and Chrome or a Playwright Chromium already installed.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { type Browser, chromium, type Page } from "@playwright/test";
import type { PluginEngineLink } from "../../src/plugin-sdk/index.d.ts";
import { inlinePanelSdk, panelWordsScripts } from "../../src/plugin-sdk/inline-panel-sdk.mjs";
import { createUnrealBackend, PanelStep } from "../../src/plugins/unreal/backend.ts";
import type { Launch } from "../../src/plugins/unreal/editor-launch.ts";
import type { EditorLog } from "../../src/plugins/unreal/editor-log.ts";
import type { SetupEnv } from "../../src/plugins/unreal/setup.ts";
import { ENGINE_LINKS_FOLDER } from "../../src/shared/plugins.ts";
import { XcodeState } from "../../src/plugins/unreal/xcode.ts";
import { tmpDir } from "../helpers/tmp.ts";

const HELPER = path.resolve("src/plugins/unreal/GenexEditorHelper");
const PANEL = path.resolve("src/plugins/unreal/panel.html");
const GIB = 1024 ** 3;
const START = Date.UTC(2026, 9, 4, 9, 0, 0);
/** How often and how many times a test looks for a request the panel sends after a press. */
const WAIT_STEP_MS = 50;
const WAIT_TRIES = 160;
/** The panel refreshes every 3 s; Connected must show within two refreshes. */
const CONNECTED_WAIT_MS = 8_000;

const SkipReason = {
  NotOptedIn: "launches Chrome; set STUDIO_BROWSER_TESTS=1 to run",
} as const;
const skip = process.env.STUDIO_BROWSER_TESTS === "1" ? false : SkipReason.NotOptedIn;

/** The stand-in bridge: context answers a light theme, actions go to the backend the test exposes with the wait the panel asked for. */
const BRIDGE = `<script>
window.studioPlugin = {
  call: async (method, name, args, options) => {
    if (method === "context") return { project: null, apiVersion: 3, theme: { background: "#ffffff", foreground: "#111111", accent: "#2f6fed" } };
    const answer = await window.__backend(method, name ?? null, args ?? {}, options?.timeoutMs ?? null);
    if (answer.error) throw new Error(answer.error);
    return answer.value;
  },
  chooseFile: async () => null,
};
</script>`;

const uproject = (engine: string) => `${JSON.stringify({ FileVersion: 3, EngineAssociation: engine }, null, "\t")}\n`;

/**
 * A fake computer with 5.8 installed, a project Drift (5.8) and Cave (5.7), and an editor the test
 * sets. With `game`, the backend's calls come from that open Genex game, whose link the host keeps.
 */
async function computer(options: { game?: string } = {}) {
  const root = await realpath(await tmpDir("studio-unreal-panel-"));
  const home = path.join(root, "home");
  const storage = path.join(root, "storage");
  const engine = path.join(root, "Engines", "UE_5.8");
  await mkdir(path.join(engine, "Engine", "Binaries", "Mac", "UnrealEditor.app"), { recursive: true });
  const epic = path.join(home, "Library", "Application Support", "Epic", "UnrealEngineLauncher");
  await mkdir(epic, { recursive: true });
  await writeFile(
    path.join(epic, "LauncherInstalled.dat"),
    JSON.stringify({
      InstallationList: [
        { InstallLocation: engine, AppVersion: "5.8.3-58210709+++UE5+Release-5.8-Mac", AppName: "UE_5.8" },
      ],
    }),
  );
  const project = async (name: string, version: string) => {
    const file = path.join(root, "Projects", name, `${name}.uproject`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, uproject(version));
    return file;
  };
  /**
   * `serving`: the project the answering editor has open, when it isn't the one asked about; `log`:
   * its own log; `listening`: ports another app holds; `held`: the projects whose logs an editor holds.
   */
  const live: {
    running: boolean;
    answering: boolean;
    serving?: string;
    log?: EditorLog;
    listening?: Set<number>;
    /** Ports Unreal's crash reporter holds after a crash. */
    crashReporter?: Set<number>;
    held?: string[];
  } = {
    running: false,
    answering: false,
  };
  const env: SetupEnv = {
    home,
    platform: "darwin",
    programData: path.join(home, "ProgramData"),
    editorRunning: async () => live.running,
    editorLog: async () => live.log,
    heldProjects: async () => live.held ?? [],
    portListening: async (port) => live.listening?.has(port) ?? false,
    crashReporterHolds: async (port) => live.crashReporter?.has(port) ?? false,
    editorAnswers: async (_port, project) => live.answering && (live.serving === undefined || live.serving === project),
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
  const newGames = path.join(home, "Documents", "Unreal Projects");
  const backend = createUnrealBackend({
    env,
    helper: HELPER,
    projects: async () => newGames,
    launch: {
      open: async (launch) => void launched.push(launch),
      applications: path.join(root, "Applications"),
      now: () => START,
    },
  });
  /** The open game's link, as the host's game.engine services keep it. */
  const game: { link: PluginEngineLink | null } = { link: null };
  /** The games whose Loop is going, as the host's `game.engine.runs` names them. */
  const runs: Array<{ game: string; title: string; project: string }> = [];
  const host = async (method: string, args?: { project: string }) => {
    if (method === "game.engine.read") return game.link;
    if (method === "game.engine.runs") return runs;
    if (method !== "game.engine.link") return storage;
    const linked = args?.project ?? "";
    game.link = { kind: "unreal", project: linked, name: path.basename(linked, ".uproject"), linkedAt: "" };
    // As the host does, the link is also a record in the plugin's storage, where the backend reads it.
    if (options.game) {
      await mkdir(path.join(storage, ENGINE_LINKS_FOLDER), { recursive: true });
      await writeFile(path.join(storage, ENGINE_LINKS_FOLDER, `${options.game}.json`), JSON.stringify(game.link));
    }
    return game.link;
  };
  const context = {
    signal: new AbortController().signal,
    callId: 1,
    host: host as never,
    ...(options.game ? { project: options.game } : {}),
  };
  const sent: Array<[string, Record<string, unknown>]> = [];
  /** The wait the panel asked for on each action it sent, null for the SDK's own. */
  const waits: Array<[string, number | null]> = [];
  const act = async (name: string, args: Record<string, unknown> = {}) => backend.action?.(name, args, context);
  return {
    live,
    launched,
    newGames,
    sent,
    waits,
    act,
    context,
    backend,
    game,
    runs,
    project,
    drift: await project("Drift", "5.8"),
    cave: await project("Cave", "5.7"),
  };
}

type Computer = Awaited<ReturnType<typeof computer>>;

/** One step the backend can name, how to reach it, and the action its primary sends (none for a headline). */
const STEPS: Record<string, { arrange: (c: Computer) => Promise<string>; sends?: string }> = {
  [PanelStep.QuitFirst]: {
    arrange: async (c) => {
      c.live.running = true;
      // Unreal has Drift itself open: its own log is open.
      c.live.log = { open: true, openedAt: START, mtime: START, mcpStarted: false, loaded: true };
      return c.drift;
    },
    sends: "quit-editor",
  },
  [PanelStep.SetUp]: { arrange: async (c) => c.drift, sends: "setup" },
  [PanelStep.Open]: {
    arrange: async (c) => {
      await c.act("setup", { project: c.drift });
      return c.drift;
    },
    sends: "open-editor",
  },
  [PanelStep.Starting]: {
    arrange: async (c) => {
      await c.act("setup", { project: c.drift });
      await c.act("open-editor", { project: c.drift });
      c.live.running = true;
      return c.drift;
    },
  },
  [PanelStep.Connected]: {
    arrange: async (c) => {
      await c.act("setup", { project: c.drift });
      c.live.running = true;
      c.live.answering = true;
      return c.drift;
    },
  },
  [PanelStep.Switch]: {
    arrange: async (c) => {
      await c.act("setup", { project: c.cave });
      await c.act("setup", { project: c.drift });
      c.live.running = true;
      c.live.answering = true;
      c.live.serving = c.cave;
      return c.drift;
    },
    sends: "quit-editor",
  },
  [PanelStep.NotAnswering]: {
    arrange: async (c) => {
      await c.act("setup", { project: c.drift });
      c.live.running = true;
      // Unreal has Drift itself open (its own log is), but it doesn't answer.
      c.live.log = { open: true, openedAt: START, mtime: START, mcpStarted: true, loaded: true };
      return c.drift;
    },
    sends: "quit-editor",
  },
  [PanelStep.OpenWhenFree]: {
    arrange: async (c) => {
      await c.act("setup", { project: c.drift });
      // Unreal has another project open: Drift's own log isn't, so nothing here quits Unreal.
      c.live.running = true;
      return c.drift;
    },
  },
  [PanelStep.PortBlocked]: {
    arrange: async (c) => {
      await c.act("setup", { project: c.drift });
      c.live.running = true;
      c.live.log = { open: true, openedAt: START, mtime: START, mcpStarted: true, loaded: true, portBlocked: true };
      return c.drift;
    },
    sends: "quit-editor",
  },
  [PanelStep.Crashed]: {
    arrange: async (c) => {
      const { port } = (await c.act("setup", { project: c.drift })) as { port: number };
      c.live.listening = new Set([port]);
      c.live.crashReporter = new Set([port]);
      return c.drift;
    },
  },
};
/** Steps with a view of their own instead of the project view. */
const OTHER_VIEWS: string[] = [PanelStep.GetUnreal, PanelStep.Choose];

describe("The Set up Unreal panel", { skip }, () => {
  let browser: Browser;
  let server: http.Server;
  let url = "";
  before(async () => {
    // The stand-in bridge, then the SDK's own words (in English: the stand-in names no language).
    const words = await panelWordsScripts();
    const page = (await readFile(PANEL, "utf8")).replace("<!-- STUDIO_PANEL_SDK -->", () => BRIDGE + words);
    server = http.createServer((_request, response) =>
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    browser = await chromium
      .launch({ channel: "chrome", headless: true })
      .catch(() => chromium.launch({ headless: true }));
  });
  after(async () => {
    await browser?.close();
    server?.close();
  });

  /** The panel over computer `c`, with the backend's answers going through the stand-in bridge. */
  async function open(c: Computer) {
    const tab = await browser.newPage({ viewport: { width: 360, height: 720 } });
    const backend = async (method: string, name: string, args: Record<string, unknown>, wait: number | null) => {
      if (method !== "action") return { error: `unexpected ${method}` };
      // Looks the panel takes on every refresh are not what a press sends.
      const look = name === "status" || name === "agents";
      if (!look) c.sent.push([name, args]);
      if (!look) c.waits.push([name, wait]);
      try {
        return { value: await c.act(name, args) };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    };
    await tab.exposeFunction("__backend", backend);
    await tab.goto(url);
    await tab.waitForFunction(() => document.getElementById("app")?.getAttribute("aria-busy") === "false");
    return tab;
  }

  it("names every step the backend can give", () => {
    assert.deepEqual(
      Object.values(PanelStep)
        .filter((step) => !OTHER_VIEWS.includes(step))
        .sort(),
      Object.keys(STEPS).sort(),
      "a new PanelStep needs a row here and a view in the panel",
    );
  });

  for (const [step, row] of Object.entries(STEPS))
    it(`shows ${step} with a headline, a line or a primary that sends its action for the shown project`, async () => {
      const c = await computer();
      const file = await row.arrange(c);
      // The panel opens on the project chosen last, as after a person picked it.
      const status = (await c.act("status", { project: file })) as { next: string };
      assert.equal(status.next, step);
      const tab = await open(c);
      try {
        await tab.waitForSelector("#project:not([hidden])");
        const view = await tab.evaluate(() => {
          const primary = document.getElementById("primary") as HTMLButtonElement | null;
          const shown = !document.getElementById("primary-row")?.hidden;
          return {
            headline: document.getElementById("headline")?.textContent ?? "",
            say: document.getElementById("say")?.hidden ? "" : (document.getElementById("say")?.textContent ?? ""),
            primary: shown ? (primary?.textContent ?? "") : "",
            pressable: shown && !primary?.disabled,
          };
        });
        assert.ok(view.headline || view.primary || view.say, `${step} shows something to do or to read`);
        if (!row.sends) {
          assert.equal(view.pressable, false, `${step} has no primary button it can press`);
          return;
        }
        c.sent.length = 0;
        await tab.click("#primary");
        // Quit stays pressed while Unreal quits, so wait for the call, not for the button.
        for (let i = 0; i < 50 && c.sent.length === 0; i++) await tab.waitForTimeout(50);
        const shown = (status as unknown as { project: { file: string } }).project.file;
        assert.deepEqual(c.sent[0], [row.sends, { project: shown }]);
      } finally {
        await tab.close();
      }
    });

  it("says plainly that Unreal couldn't use the port Genex gave the project, without its number", async () => {
    const c = await computer();
    const file = await STEPS[PanelStep.PortBlocked].arrange(c);
    await c.act("status", { project: file });
    const tab = await open(c);
    try {
      await tab.waitForSelector("#project:not([hidden])");
      const say = await tab.evaluate(() => document.getElementById("say")?.textContent ?? "");
      assert.equal(say, "Unreal couldn't use the port Genex gave Drift.");
      // Restart quits Unreal, then opens the project again, as Switch does.
      assert.equal(await tab.evaluate(() => document.getElementById("primary")?.textContent), "Restart Unreal");
    } finally {
      await tab.close();
    }
  });

  it("a project that ray-traces says what it risks on this Mac, and its button turns ray tracing off", async () => {
    const c = await computer();
    const file = await STEPS[PanelStep.Open].arrange(c);
    const config = path.join(path.dirname(file), "Config", "DefaultEngine.ini");
    await mkdir(path.dirname(config), { recursive: true });
    await writeFile(config, "[/Script/Engine.RendererSettings]\nr.RayTracing=True\n");
    await c.act("status", { project: file });
    const tab = await open(c);
    try {
      await tab.waitForSelector("#ray-tracing:not([hidden])");
      const text = await tab.evaluate(() => document.getElementById("ray-tracing-text")?.textContent ?? "");
      assert.match(text, /^Ray tracing is on in Drift\./);
      c.sent.length = 0;
      await tab.click("#ray-tracing-off");
      for (let i = 0; i < WAIT_TRIES && c.sent.length === 0; i++) await tab.waitForTimeout(WAIT_STEP_MS);
      assert.equal(c.sent[0]?.[0], "ray-tracing-off");
      await tab.waitForSelector("#ray-tracing[hidden]", { state: "attached" });
      assert.match(await readFile(config, "utf8"), /r\.RayTracing=False/);
    } finally {
      await tab.close();
    }
  });

  it("a set-up project Unreal doesn't have open offers no restart, says which project holds Unreal and holds Open", async () => {
    const c = await computer();
    const file = await STEPS[PanelStep.OpenWhenFree].arrange(c);
    c.live.held = ["Harbor"];
    await c.act("status", { project: file });
    const tab = await open(c);
    try {
      await tab.waitForSelector("#project:not([hidden])");
      const view = await tab.evaluate(() => ({
        say: document.getElementById("say")?.textContent ?? "",
        primary: document.getElementById("primary-row")?.hidden ? "" : document.getElementById("primary")?.textContent,
        held: (document.getElementById("primary") as HTMLButtonElement | null)?.disabled,
      }));
      assert.deepEqual(view, {
        say: "Unreal has Harbor open. Open Drift once Unreal is free.",
        primary: "Open in Unreal",
        held: true,
      });
    } finally {
      await tab.close();
    }
  });

  it("a project whose helper is newer than this Genex's says so in one line and offers no update", async () => {
    const newer = "This project's Genex editor helper is newer than this Genex's, so Genex leaves it as it is.";
    const c = await computer();
    await c.act("setup", { project: c.drift });
    const descriptor = path.join(path.dirname(c.drift), "Plugins/GenexEditorHelper/GenexEditorHelper.uplugin");
    const shipped = JSON.parse(await readFile(descriptor, "utf8"));
    await writeFile(descriptor, JSON.stringify({ ...shipped, Version: shipped.Version + 1 }));
    await c.act("status", { project: c.drift });
    const tab = await open(c);
    const view = () =>
      tab.evaluate(() => ({
        say: document.getElementById("say")?.textContent ?? "",
        primary: document.getElementById("primary-row")?.hidden
          ? ""
          : (document.getElementById("primary")?.textContent ?? ""),
        hint: document.getElementById("hint")?.hidden ? "" : (document.getElementById("hint")?.textContent ?? ""),
      }));
    try {
      await tab.waitForSelector("#project:not([hidden])");
      const closed = await view();
      assert.deepEqual([closed.say, closed.primary], [newer, "Open in Unreal"]);
      c.live.running = true;
      c.live.answering = true;
      // No press: the panel's own refresh notices the editor answering.
      await tab.waitForFunction(() => document.getElementById("state")?.textContent === "Ready", null, {
        timeout: CONNECTED_WAIT_MS,
      });
      const connected = await view();
      assert.deepEqual([connected.primary, connected.hint], ["", newer]);
    } finally {
      await tab.close();
    }
  });

  it("an older helper in the open game's project: Open says it updates the helper first, waits for a build, and names the files it kept", async () => {
    const c = await computer({ game: "dirt-track" });
    await c.act("setup", { project: c.drift });
    await c.act("use-project", { project: c.drift });
    const tools = path.join(path.dirname(c.drift), "Plugins/GenexEditorHelper/Content/Python/genex_play/tools.py");
    await writeFile(tools, "# an older helper\n");
    const status = (await c.act("status", { project: c.drift })) as { next: string; helperOutdated: boolean };
    assert.deepEqual([status.next, status.helperOutdated], [PanelStep.Open, true]);
    const tab = await open(c);
    try {
      await tab.waitForSelector("#project:not([hidden])");
      const say = await tab.evaluate(() => document.getElementById("say")?.textContent ?? "");
      assert.match(say, /Open in Unreal updates it first/);
      c.sent.length = 0;
      await tab.click("#primary");
      await tab.waitForFunction(() => /as \.mine/.test(document.getElementById("kept")?.textContent ?? ""));
      assert.deepEqual(c.sent, [["open-editor", { project: c.drift }]]);
      const [, wait] = c.waits.find(([name]) => name === "open-editor") ?? [];
      assert.ok(
        typeof wait === "number" && wait >= 3 * 60_000,
        `Open waits for a build, not the SDK's minute (${wait})`,
      );
      assert.equal(await readFile(`${tools}.mine`, "utf8"), "# an older helper\n");
    } finally {
      await tab.close();
    }
  });

  it("an older helper in a project no open game builds in: the panel promises no update, and Open leaves the helper", async () => {
    const c = await computer();
    await c.act("setup", { project: c.drift });
    const tools = path.join(path.dirname(c.drift), "Plugins/GenexEditorHelper/Content/Python/genex_play/tools.py");
    await writeFile(tools, "# an older helper\n");
    await c.act("status", { project: c.drift });
    const tab = await open(c);
    try {
      await tab.waitForSelector("#project:not([hidden])");
      const say = await tab.evaluate(() => document.getElementById("say")?.textContent ?? "");
      assert.doesNotMatch(say, /Open in Unreal updates it/);
      assert.match(say, /Opening it from its Genex game updates it/);
      c.sent.length = 0;
      await tab.click("#primary");
      for (let i = 0; i < WAIT_TRIES && c.sent.length === 0; i++) await tab.waitForTimeout(WAIT_STEP_MS);
      assert.deepEqual(c.sent, [["open-editor", { project: c.drift }]]);
      assert.equal(await readFile(tools, "utf8"), "# an older helper\n", "the helper is left as it was");
    } finally {
      await tab.close();
    }
  });

  it("Undo setup waits while Unreal has the project open, and Quit Unreal is sent once and stays pressed while it quits", async () => {
    const c = await computer();
    await c.act("setup", { project: c.drift });
    c.live.running = true;
    c.live.answering = true;
    await c.act("status", { project: c.drift });
    const tab = await open(c);
    try {
      await tab.waitForSelector("#project:not([hidden])");
      await tab.evaluate(() => document.getElementById("more")?.setAttribute("open", ""));
      assert.equal(await tab.evaluate(() => document.getElementById("undo")?.hasAttribute("disabled")), true);
      c.sent.length = 0;
      await tab.click("#quit");
      await tab.waitForFunction(() => document.getElementById("app")?.getAttribute("aria-busy") === "false");
      await tab.waitForTimeout(200);
      assert.deepEqual(c.sent, [["quit-editor", { project: c.drift }]]);
      assert.equal(await tab.evaluate(() => document.getElementById("quit")?.hasAttribute("disabled")), true);
    } finally {
      await tab.close();
    }
  });

  /** The project view as a person reads it: the heading, and the primary, game line and Use in this game when shown. */
  const projectView = (tab: Page) =>
    tab.evaluate(() => {
      const shown = (id: string) => {
        const el = document.getElementById(id);
        return el && !el.closest("[hidden]") ? (el.textContent ?? "") : "";
      };
      return {
        name: document.getElementById("project-name")?.textContent ?? "",
        primary: shown("primary"),
        inGame: shown("in-game"),
        use: shown("use-here"),
      };
    });

  /** The first request the panel sends after a press, once it has sent one. */
  async function firstSent(c: Computer, tab: Page) {
    for (let i = 0; i < WAIT_TRIES && c.sent.length === 0; i++) await tab.waitForTimeout(WAIT_STEP_MS);
    return c.sent[0];
  }

  /** Dirt Track linked to Drift; then another game's panel set Neon up, which made Neon the chosen project. */
  async function linkedGameThenOtherChosen() {
    const c = await computer({ game: "dirt-track" });
    const neon = await c.project("Neon", "5.8");
    await c.act("setup", { project: c.drift });
    await c.act("use-project", { project: c.drift });
    await c.act("setup", { project: neon });
    return { c, neon };
  }

  it("a game linked to its project opens on that project, not the one chosen for another game, and Open opens it", async () => {
    const { c } = await linkedGameThenOtherChosen();
    const tab = await open(c);
    try {
      await tab.waitForSelector("#project:not([hidden])");
      assert.deepEqual(await projectView(tab), {
        name: "Drift",
        primary: "Open in Unreal",
        inGame: "",
        use: "",
      });
      c.sent.length = 0;
      await tab.click("#primary");
      assert.deepEqual(await firstSent(c, tab), ["open-editor", { project: c.drift }]);
      assert.equal(c.game.link?.project, c.drift, "the game's link is untouched");
    } finally {
      await tab.close();
    }
  });

  it("in a linked game, Change and a picked project offer Use in this game, which links the game to it", async () => {
    const { c, neon } = await linkedGameThenOtherChosen();
    const tab = await open(c);
    try {
      await tab.waitForSelector("#project:not([hidden])");
      await tab.click("#change");
      await tab.click(`#projects button.row[data-file="${neon}"]`);
      await tab.waitForFunction(
        () =>
          !document.getElementById("project")?.hidden &&
          document.getElementById("project-name")?.textContent === "Neon",
      );
      assert.deepEqual(await projectView(tab), {
        name: "Neon",
        primary: "Open in Unreal",
        inGame: "This game builds in Drift. Use this project instead?",
        use: "Use in this game",
      });
      c.sent.length = 0;
      await tab.click("#use-here");
      assert.deepEqual(await firstSent(c, tab), ["use-project", { project: neon }]);
      await tab.waitForFunction(() => document.getElementById("use-row")?.hidden === true);
      assert.deepEqual(
        [(await projectView(tab)).use, (await projectView(tab)).inGame],
        ["", ""],
        "nothing more to offer, nor to say, once the game uses it",
      );
    } finally {
      await tab.close();
    }
  });

  it("a game relinked while the panel is open moves the panel to its new project, offering no link back", async () => {
    const { c, neon } = await linkedGameThenOtherChosen();
    const tab = await open(c);
    try {
      await tab.waitForSelector("#project:not([hidden])");
      // The agent's use-project, from the game's chat.
      await c.act("use-project", { project: neon });
      // No press: the panel's own refresh notices the new link.
      await tab.waitForFunction(() => document.getElementById("project-name")?.textContent === "Neon", null, {
        timeout: CONNECTED_WAIT_MS,
      });
      assert.deepEqual(await projectView(tab), {
        name: "Neon",
        primary: "Open in Unreal",
        inGame: "",
        use: "",
      });
    } finally {
      await tab.close();
    }
  });

  it("a game with no link opens on the project chosen last and leads with using it in this game", async () => {
    const c = await computer({ game: "dirt-track" });
    await c.act("setup", { project: c.drift });
    const tab = await open(c);
    try {
      await tab.waitForSelector("#project:not([hidden])");
      assert.deepEqual(await projectView(tab), {
        name: "Drift",
        primary: "Use Drift in this game",
        inGame: "",
        use: "",
      });
      assert.equal(await tab.textContent("#secondary"), "Open in Unreal", "opening it follows, quieter");
      c.sent.length = 0;
      await tab.click("#primary");
      assert.deepEqual(await firstSent(c, tab), ["use-project", { project: c.drift }]);
    } finally {
      await tab.close();
    }
  });

  it("while a Loop is using Unreal, a step that would quit it offers only Open, held until then, and More has no Quit", async () => {
    const c = await computer();
    const file = await STEPS[PanelStep.Switch].arrange(c);
    c.runs.push({ game: "cave-night", title: "Cave Night", project: c.cave });
    await c.act("status", { project: file });
    const tab = await open(c);
    try {
      await tab.waitForSelector("#project:not([hidden])");
      const view = await tab.evaluate(() => ({
        say: document.getElementById("say")?.textContent,
        primary: document.getElementById("primary-row")?.hidden ? "" : document.getElementById("primary")?.textContent,
        held: (document.getElementById("primary") as HTMLButtonElement | null)?.disabled,
        quit: document.getElementById("quit")?.hidden,
      }));
      assert.deepEqual(view, {
        say: "A Loop in Cave Night is using Unreal. Open Drift after it ends.",
        primary: "Open in Unreal",
        held: true,
        quit: true,
      });
    } finally {
      await tab.close();
    }
  });

  /** The project list as a person reads it: each shown row's name, where it is and its tag. */
  const listRows = (tab: Page) =>
    tab.evaluate(() =>
      [...document.querySelectorAll("#projects li:not([hidden]) .row")].map((row) => ({
        name: row.querySelector(".name")?.textContent ?? "",
        where: row.querySelector(".path")?.textContent ?? "",
        tag: row.querySelector(".tag")?.textContent ?? "",
      })),
    );
  const byName = (rows: Array<{ name: string }>) => [...rows].sort((a, b) => a.name.localeCompare(b.name));

  it("a path reads from ~ in home, keeps a long one's ends, names a temporary folder, and the list tags what lies outside the open game", async () => {
    const c = await computer({ game: "lantern" });
    const home = path.dirname(path.dirname(c.newGames));
    const neon = await writeProject(path.join(c.newGames, "Neon", "Neon.uproject"));
    const deep = await writeProject(
      path.join(home, "work", "studio", "dev", "profiles", "manual", "Deep", "Deep.uproject"),
    );
    // The open game's folder holds Neon: Deep and Drift lie outside it. Drift is in the test's temporary folder.
    Object.assign(c.context, { directory: path.dirname(neon) });
    await c.act("setup", { project: c.drift });
    await c.act("status", { project: deep });
    const tab = await open(c);
    try {
      await tab.waitForSelector("#project:not([hidden])");
      const head = await tab.evaluate(() => ({
        where: document.getElementById("project-path")?.textContent,
        full: document.getElementById("project-path")?.title,
        reach: document.getElementById("fact-reach")?.hidden
          ? ""
          : document.getElementById("project-reach")?.textContent,
      }));
      assert.deepEqual(head, { where: "~/work/…/manual/Deep", full: deep, reach: "No, outside this game's folder" });
      await tab.click("#change");
      await tab.waitForSelector("#pick:not([hidden])");
      const temporary =
        process.platform === "win32" ? [] : [{ name: "Drift", where: "Temporary folder › Drift", tag: "Outside game" }];
      assert.deepEqual(
        byName(await listRows(tab)).filter((row) => process.platform !== "win32" || row.name !== "Drift"),
        byName([
          { name: "Deep", where: "~/work/…/manual/Deep", tag: "In use" },
          { name: "Neon", where: "~/Documents/Unreal Projects/Neon", tag: "" },
          ...temporary,
        ]),
      );
      assert.equal(
        await tab.textContent("#outside-note"),
        "Outside game: chats use it, Rewind and Loops can't reach it.",
      );
      await tab.click("#back");
      await tab.waitForSelector("#project:not([hidden])");
      assert.equal(
        await tab.evaluate(() => document.activeElement?.id),
        "project-name",
        "Back returns to the project's name",
      );
    } finally {
      await tab.close();
    }
  });

  it("Ready is the green dot alone, its word kept for screen readers; another state shows its word", async () => {
    const c = await computer();
    const file = await STEPS[PanelStep.Connected].arrange(c);
    await c.act("status", { project: file });
    const tab = await open(c);
    const state = () =>
      tab.evaluate(() => {
        const chip = document.getElementById("state");
        const word = document.getElementById("state-word");
        return {
          word: word?.textContent,
          title: chip?.title,
          wordSeen: (word?.getBoundingClientRect().width ?? 0) > 1,
          dot: chip ? getComputedStyle(chip, "::before").backgroundColor : "",
        };
      });
    try {
      await tab.waitForFunction(() => document.getElementById("state")?.textContent === "Ready", null, {
        timeout: CONNECTED_WAIT_MS,
      });
      // The light theme's green, chosen for 4.5:1 on white.
      assert.deepEqual(await state(), { word: "Ready", title: "Ready", wordSeen: false, dot: "rgb(29, 127, 70)" });
      c.live.running = false;
      c.live.answering = false;
      await tab.waitForFunction(() => document.getElementById("state")?.textContent === "Not open", null, {
        timeout: CONNECTED_WAIT_MS,
      });
      assert.equal((await state()).wordSeen, true);
    } finally {
      await tab.close();
    }
  });

  it("beside a project, shows whether agents may use Unreal while the person plays, on unless turned off, and keeps the choice", async () => {
    const c = await computer();
    const file = await STEPS[PanelStep.Connected].arrange(c);
    await c.act("status", { project: file });
    const tab = await open(c);
    try {
      const box = tab.locator("#while-playing");
      await tab.waitForFunction(() => !document.getElementById("agents")?.hidden);
      assert.match(await tab.locator("#agents").innerText(), /Agents may use Unreal while you play/);
      assert.equal(await box.isChecked(), true, "on unless the person turned it off");
      await tab.getByText("Agents may use Unreal while you play").click();
      await tab.waitForFunction(() => !(document.getElementById("while-playing") as HTMLInputElement).disabled);
      assert.equal(await box.isChecked(), false);
      assert.deepEqual(c.sent.at(-1), ["agents-wait", {}]);
      assert.deepEqual(await c.act("agents", {}), { whilePlaying: false }, "kept for every game");
    } finally {
      await tab.close();
    }
  });

  it("past six projects a filter narrows the list by name and says when nothing matches; six need none", async () => {
    const names = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta"];
    const seven = await computer();
    for (const name of names) await writeProject(path.join(seven.newGames, name, `${name}.uproject`));
    const tab = await open(seven);
    try {
      await tab.waitForSelector("#pick:not([hidden])");
      assert.equal((await listRows(tab)).length, 7);
      await tab.fill("#filter", "EP");
      assert.deepEqual(
        (await listRows(tab)).map((row) => row.name),
        ["Epsilon"],
      );
      assert.equal(await tab.isVisible("#no-match"), false);
      await tab.fill("#filter", "zzz");
      assert.deepEqual(await listRows(tab), []);
      assert.equal(await tab.isVisible("#no-match"), true);
      await tab.fill("#filter", "");
      assert.equal((await listRows(tab)).length, 7);
    } finally {
      await tab.close();
    }
    const six = await computer();
    for (const name of names.slice(0, 6)) await writeProject(path.join(six.newGames, name, `${name}.uproject`));
    const few = await open(six);
    try {
      await few.waitForSelector("#pick:not([hidden])");
      assert.equal((await listRows(few)).length, 6);
      assert.equal(await few.isVisible("#filter"), false);
    } finally {
      await few.close();
    }
  });
});

/** A 5.8 project file at `file`, its folder made. */
async function writeProject(file: string) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, uproject("5.8"));
  return file;
}

/**
 * The host page for the sandboxed tests: the panel, with Studio's real bridge SDK pasted in, runs in
 * an iframe with `sandbox="allow-scripts"` as PluginPanelHost serves it (no allow-forms). The host
 * answers bridge requests like PluginPanelHost: actions go to the test's backend; the New game
 * form's templates are canned, since the fake engine has no templates, and `create` refuses the name
 * unless the test stands in a maker. Studio's file picker answers `window.__picked` (null: cancelled).
 */
const SANDBOX_HOST = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<iframe id="f" sandbox="allow-scripts" src="/panel" style="width:360px;height:700px;border:0"></iframe>
<script>
window.__requests = [];
const card = { id: "TP_BlankBP", name: "Blank", description: "An empty level to build from scratch.", thumbnail: null };
const combat = { id: "TP_ThirdPersonBP", variant: "Combat", name: "Third Person · Combat", description: "Melee.", thumbnail: null };
window.__picked = null;
window.__makes = false;
async function answer(m) {
  if (m.method === "context") return { project: null, apiVersion: 3, theme: { background: "#ffffff", foreground: "#111111", accent: "#2f6fed" } };
  if (m.method === "chooseFile") return window.__picked;
  if (m.method !== "action") throw new Error("unexpected " + m.method);
  if (m.name === "templates") return { templates: [card, combat], place: ["Documents", "Unreal Projects"], name: "MyGame", newestUnverified: null };
  if (m.name === "create" && !window.__makes) throw new Error("Use no spaces; try MyGame or My_Game.");
  const reply = await window.__backend("action", m.name, m.args ?? {});
  if (reply.error) throw new Error(reply.error);
  return reply.value;
}
window.addEventListener("message", async (event) => {
  const f = document.getElementById("f");
  const m = event.data;
  if (event.source !== f.contentWindow || m?.type !== "studio-plugin-request") return;
  if (m.method === "action" && m.name !== "status" && m.name !== "agents") window.__requests.push([m.name, m.args]);
  if (m.method === "chooseFile") window.__requests.push(["chooseFile", m.args]);
  const reply = (body) => f.contentWindow.postMessage({ type: "studio-plugin-result", id: m.id, ...body }, "*");
  try { reply({ result: await answer(m) }); } catch (e) { reply({ error: String(e) }); }
});
</script></body></html>`;

/** Stands in for the backend's `create` on a fake engine: writes a 5.8 game and sets it up, as create does. */
async function makeGame(c: Computer, args: Record<string, unknown>) {
  const name = String(args.name);
  const file = path.join(c.newGames, name, `${name}.uproject`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, uproject("5.8"));
  return { project: file, state: await c.act("setup", { project: file }) };
}

describe("The Set up Unreal panel in Studio's sandboxed frame", { skip }, () => {
  let browser: Browser;
  let server: http.Server;
  let url = "";
  before(async () => {
    const panel = await inlinePanelSdk(await readFile(PANEL, "utf8"));
    server = http.createServer((request, response) =>
      response
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end(request.url?.startsWith("/panel") ? panel : SANDBOX_HOST),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    browser = await chromium
      .launch({ channel: "chrome", headless: true })
      .catch(() => chromium.launch({ headless: true }));
  });
  after(async () => {
    await browser?.close();
    server?.close();
  });

  /** The host page over computer `c`, and the panel's frame once it has rendered. */
  async function open(c: Computer) {
    const tab = await browser.newPage({ viewport: { width: 400, height: 760 } });
    await tab.exposeFunction("__backend", async (_method: string, name: string, args: Record<string, unknown>) => {
      try {
        if (name === "create") return { value: await makeGame(c, args) };
        return { value: await c.act(name, args) };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    });
    await tab.goto(url);
    const frame = await (await tab.waitForSelector("#f")).contentFrame();
    if (!frame) throw new Error("the panel frame did not load");
    await frame.waitForFunction(() => document.getElementById("app")?.getAttribute("aria-busy") === "false");
    const requests = () => tab.evaluate(() => (window as unknown as { __requests: unknown[] }).__requests);
    const focused = () =>
      frame.evaluate(() => {
        const a = document.activeElement;
        return { id: a?.id ?? "", text: a?.textContent?.trim() ?? "" };
      });
    /** A pause in which the panel could send a request it shouldn't; a check of what it shows waits with `answered`. */
    const settled = () => tab.waitForTimeout(600);
    /**
     * Waits until the project view shows its answer to a press: `#id`'s text starts with `text`, and
     * Change, held while an action runs, is pressable again. The panel puts focus back in the same
     * turn that renders the answer, so focus can be read right after.
     */
    const answered = (id: string, text: string) =>
      frame.waitForFunction(
        ([shownId, start]) =>
          (document.getElementById(shownId)?.textContent ?? "").startsWith(start) &&
          (document.getElementById("change") as HTMLButtonElement | null)?.disabled === false,
        [id, text] as const,
      );
    /** The names of the requests the panel sent, once `ready` holds for them or the wait runs out. */
    const sentOnce = async (ready: (names: string[]) => boolean) => {
      const names = async () => ((await requests()) as Array<[string]>).map(([name]) => name);
      for (let i = 0; i < WAIT_TRIES && !ready(await names()); i++) await tab.waitForTimeout(WAIT_STEP_MS);
      return names();
    };
    return { tab, frame, requests, focused, settled, answered, sentOnce };
  }

  for (const how of ["Enter in the name", "Enter on Create and open"] as const)
    it(`${how} sends one create; a refused name keeps focus in the field and announces why`, async () => {
      const c = await computer();
      const p = await open(c);
      try {
        await p.frame.waitForSelector("#new:not([hidden])");
        await p.frame.waitForSelector('input[name="template"]');
        await p.frame.fill("#name", "My game");
        await p.frame.focus(how === "Enter in the name" ? "#name" : "#create");
        await p.tab.keyboard.press("Enter");
        await p.settled();
        const creates = ((await p.requests()) as Array<[string]>).filter(([name]) => name === "create");
        assert.equal(creates.length, 1);
        assert.equal((await p.focused()).id, "name");
        const field = await p.frame.evaluate(() => ({
          invalid: document.getElementById("name")?.getAttribute("aria-invalid"),
          role: document.getElementById("name-error")?.getAttribute("role"),
          error: document.getElementById("name-error")?.textContent,
          hint: document.getElementById("name-hint")?.hidden,
        }));
        assert.deepEqual(field, {
          invalid: "true",
          role: "alert",
          error: "Use no spaces; try MyGame or My_Game.",
          hint: true,
        });
      } finally {
        await p.tab.close();
      }
    });

  it("a project whose Unreal isn't installed leads with getting it; after Set up, focus stays on the button, now Open", async () => {
    const c = await computer();
    // A project of an engine that isn't installed sets up without opening, so its next step is Open.
    const later = path.join(path.dirname(path.dirname(c.drift)), "Later", "Later.uproject");
    await mkdir(path.dirname(later), { recursive: true });
    await writeFile(later, uproject("5.9"));
    await c.act("status", { project: later });
    const p = await open(c);
    try {
      await p.frame.waitForSelector("#project:not([hidden])");
      assert.equal(await p.frame.textContent("#primary"), "Open the Epic Games Launcher");
      assert.equal(await p.frame.textContent("#secondary"), "Set up Later");
      await p.frame.focus("#secondary");
      await p.tab.keyboard.press("Enter");
      await p.answered("secondary", "Open in Unreal");
      assert.deepEqual(await p.focused(), { id: "secondary", text: "Open in Unreal" });
    } finally {
      await p.tab.close();
    }
  });

  it("Set up and open sends setup, then open-editor, and focus goes to the project's heading while it opens", async () => {
    const c = await computer();
    await c.act("status", { project: c.drift });
    const p = await open(c);
    try {
      await p.frame.waitForSelector("#project:not([hidden])");
      assert.equal(await p.frame.textContent("#primary"), "Set up and open Drift");
      await p.frame.focus("#primary");
      await p.tab.keyboard.press("Enter");
      await p.answered("headline", "Opening in Unreal");
      assert.deepEqual(
        ((await p.requests()) as Array<[string]>).map(([name]) => name),
        ["setup", "open-editor"],
      );
      assert.equal((await p.focused()).id, "project-name");
    } finally {
      await p.tab.close();
    }
  });

  it("Switch quits Unreal, then opens the shown project once Unreal has closed", async () => {
    const c = await computer();
    await c.act("setup", { project: c.cave });
    await c.act("setup", { project: c.drift });
    c.live.running = true;
    c.live.answering = true;
    c.live.serving = c.cave;
    await c.act("status", { project: c.drift });
    const p = await open(c);
    try {
      await p.frame.waitForSelector("#project:not([hidden])");
      assert.equal(await p.frame.textContent("#primary"), "Switch to Drift");
      // The keyboard, not a pointer: a refresh that moves the layout under a click lost the press.
      await p.frame.focus("#primary");
      await p.tab.keyboard.press("Enter");
      // Wait for the quit itself, then give the panel a refresh in which it could wrongly open.
      await p.sentOnce((names) => names.includes("quit-editor"));
      await p.settled();
      assert.deepEqual(await p.sentOnce(() => true), ["quit-editor"], "nothing opens while Unreal is still open");
      c.live.running = false;
      c.live.answering = false;
      assert.deepEqual(await p.sentOnce((names) => names.includes("open-editor")), ["quit-editor", "open-editor"]);
    } finally {
      await p.tab.close();
    }
  });

  it("Restart Unreal quits it, then opens the project again once Unreal has closed", async () => {
    const c = await computer();
    await c.act("setup", { project: c.drift });
    c.live.running = true;
    // Unreal has Drift itself open (its own log is), silent: Restart is the step.
    c.live.log = { open: true, openedAt: START, mtime: START, mcpStarted: true, loaded: true };
    await c.act("status", { project: c.drift });
    const p = await open(c);
    try {
      await p.frame.waitForSelector("#project:not([hidden])");
      assert.equal(await p.frame.textContent("#primary"), "Restart Unreal");
      await p.frame.focus("#primary");
      await p.tab.keyboard.press("Enter");
      await p.sentOnce((names) => names.includes("quit-editor"));
      await p.settled();
      assert.deepEqual(await p.sentOnce(() => true), ["quit-editor"], "nothing opens while Unreal is still open");
      c.live.running = false;
      assert.deepEqual(await p.sentOnce((names) => names.includes("open-editor")), ["quit-editor", "open-editor"]);
    } finally {
      await p.tab.close();
    }
  });

  it("Restart onto a port another app now holds shows Set up again instead of opening", async () => {
    const c = await computer();
    await c.act("setup", { project: c.drift });
    c.live.running = true;
    c.live.log = { open: true, openedAt: START, mtime: START, mcpStarted: true, loaded: true };
    const status = (await c.act("status", { project: c.drift })) as { port: number };
    const p = await open(c);
    try {
      await p.frame.waitForSelector("#project:not([hidden])");
      assert.equal(await p.frame.textContent("#primary"), "Restart Unreal");
      await p.frame.focus("#primary");
      await p.tab.keyboard.press("Enter");
      await p.sentOnce((names) => names.includes("quit-editor"));
      c.live.running = false;
      c.live.listening = new Set([status.port]);
      await p.frame.waitForFunction(
        () => document.getElementById("primary")?.textContent === "Set up and open Drift",
        null,
        { timeout: CONNECTED_WAIT_MS },
      );
      await p.settled();
      assert.deepEqual(await p.sentOnce(() => true), ["quit-editor"], "nothing opens onto the held port");
    } finally {
      await p.tab.close();
    }
  });

  it("a variant's card sends its template and variant with Create", async () => {
    const c = await computer();
    const p = await open(c);
    try {
      await p.tab.evaluate(() => {
        (window as unknown as { __makes: boolean }).__makes = true;
      });
      await p.frame.waitForSelector('input[name="template"][data-variant="Combat"]');
      await p.frame.check('input[name="template"][data-variant="Combat"]');
      await p.frame.fill("#name", "Blades");
      await p.frame.click("#create");
      await p.sentOnce((names) => names.includes("create"));
      const sent = ((await p.requests()) as Array<[string, Record<string, unknown>]>).find(
        ([name]) => name === "create",
      );
      assert.deepEqual(sent, ["create", { template: "TP_ThirdPersonBP", name: "Blades", variant: "Combat" }]);
    } finally {
      await p.tab.close();
    }
  });

  it("after Undo setup, focus is on the primary, Set up again", async () => {
    const c = await computer();
    await c.act("setup", { project: c.drift });
    await c.act("status", { project: c.drift });
    const p = await open(c);
    try {
      await p.frame.waitForSelector("#project:not([hidden])");
      await p.frame.evaluate(() => document.getElementById("more")?.setAttribute("open", ""));
      await p.frame.focus("#undo");
      await p.tab.keyboard.press("Enter");
      await p.answered("primary", "Set up and open Drift");
      assert.deepEqual(await p.focused(), { id: "primary", text: "Set up and open Drift" });
    } finally {
      await p.tab.close();
    }
  });

  it("after Undo setup keeps a helper file the person changed, the panel says so; the next action clears it", async () => {
    const c = await computer();
    await c.act("setup", { project: c.drift });
    const tools = path.join(path.dirname(c.drift), "Plugins/GenexEditorHelper/Content/Python/genex_play/tools.py");
    await writeFile(tools, "# my own tools\n");
    await c.act("status", { project: c.drift });
    const p = await open(c);
    try {
      await p.frame.waitForSelector("#project:not([hidden])");
      await p.frame.evaluate(() => document.getElementById("more")?.setAttribute("open", ""));
      await p.frame.focus("#undo");
      await p.tab.keyboard.press("Enter");
      await p.frame.waitForFunction(() => Boolean(document.getElementById("kept")?.textContent));
      const kept = await p.frame.evaluate(() => ({
        text: document.getElementById("kept")?.textContent,
        role: document.getElementById("kept")?.getAttribute("role"),
      }));
      assert.deepEqual(kept, {
        text: "Genex left 1 file you changed in Plugins/GenexEditorHelper.",
        role: "status",
      });
      // Unreal opens Drift itself (its own log is open), so setting it up again waits for a quit.
      c.live.running = true;
      c.live.log = { open: true, openedAt: START, mtime: START, mcpStarted: false, loaded: true };
      await p.frame.waitForFunction(() => document.getElementById("primary")?.textContent === "Quit Unreal");
      await p.frame.focus("#primary");
      await p.tab.keyboard.press("Enter");
      await p.frame.waitForFunction(() => !document.getElementById("kept")?.textContent);
    } finally {
      await p.tab.close();
    }
  });

  it("Choose another project… shows the picked file's project, and a cancelled picker changes nothing", async () => {
    const c = await computer();
    const picked = path.join(path.dirname(path.dirname(c.drift)), "Picked", "Picked.uproject");
    await mkdir(path.dirname(picked), { recursive: true });
    await writeFile(picked, uproject("5.8"));
    // Nothing is listed on this computer, so the New game form shows with Choose a project… under it.
    const p = await open(c);
    try {
      await p.frame.waitForSelector("#choose-new:not([hidden])");
      await p.frame.waitForSelector('input[name="template"]');
      await p.frame.click("#choose-new");
      await p.sentOnce((names) => names.includes("chooseFile"));
      await p.settled();
      const pickers = ((await p.requests()) as Array<[string, unknown]>).filter(([name]) => name !== "templates");
      assert.deepEqual(pickers, [["chooseFile", { title: "Choose a project", extensions: ["uproject"] }]]);
      assert.equal(await p.frame.isVisible("#new"), true, "a cancelled picker leaves the panel where it was");
      await p.tab.evaluate((file) => {
        (window as unknown as { __picked: string }).__picked = file;
      }, picked);
      await p.frame.click("#choose-new");
      await p.frame.waitForFunction(() => document.getElementById("primary")?.textContent === "Set up and open Picked");
      const status = (await c.act("status", {})) as { project: { file: string } };
      assert.equal(status.project.file, picked, "the picked project is the chosen one");
    } finally {
      await p.tab.close();
    }
  });

  it("Create and open sends create, then open-editor for the made game, shows Opening, then Connected by itself", async () => {
    const c = await computer();
    const p = await open(c);
    try {
      await p.tab.evaluate(() => {
        (window as unknown as { __makes: boolean }).__makes = true;
      });
      await p.frame.waitForSelector("#new:not([hidden])");
      await p.frame.waitForSelector('input[name="template"]');
      await p.frame.fill("#name", "GxNew");
      await p.frame.click("#create");
      await p.frame.waitForFunction(
        () =>
          document.getElementById("project-name")?.textContent === "GxNew" &&
          /^Opening in Unreal/.test(document.getElementById("headline")?.textContent ?? ""),
      );
      const made = path.join(c.newGames, "GxNew", "GxNew.uproject");
      const sent = ((await p.requests()) as Array<[string, Record<string, unknown>]>).filter(
        ([name]) => name !== "templates",
      );
      assert.deepEqual(sent, [
        ["create", { template: "TP_BlankBP", name: "GxNew" }],
        ["open-editor", { project: made }],
      ]);
      assert.equal(c.launched.length, 1, "one launch recorded, nothing started");
      c.live.running = true;
      c.live.answering = true;
      // No press: the panel's own refresh notices the editor answering.
      await p.frame.waitForFunction(
        () =>
          document.getElementById("project-name")?.textContent === "GxNew" &&
          document.getElementById("state")?.textContent === "Ready",
        null,
        { timeout: CONNECTED_WAIT_MS },
      );
    } finally {
      await p.tab.close();
    }
  });
});
