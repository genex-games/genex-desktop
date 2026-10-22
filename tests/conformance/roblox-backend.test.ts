/**
 * The Roblox Studio plugin's backend through its plugin interface, over a fake Mac: the toolbar
 * button's word and dot for each state of Studio (not installed, not set up, not open, starting,
 * ready), the panel's status, the lock's probe, and that none of it reads the person's Documents
 * folder. Then the built package: it builds, seeds off, shows no button while off, and shows the
 * "Roblox Studio" button with the box glyph and a status word once turned on.
 */
import assert from "node:assert/strict";
import { access, lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import type {
  PluginContext,
  PluginEngineAssistAnswer,
  PluginEngineAssistRefusal,
  PluginReview,
  PluginToolbarStatus,
} from "../../src/plugin-sdk/index.d.ts";
import {
  type AssistAnswer,
  createRobloxBackend,
  PanelStep,
  type RobloxDeps,
  type RobloxStatus,
  type SetupAnswer,
  StudioStatus,
  studioStatusOf,
} from "../../src/plugins/roblox/backend.ts";
import type { StepsCard } from "../../src/renderer/chat/engine-steps.ts";
import { HELPER_FILE } from "../../src/plugins/roblox/setup.ts";
import type { InstallDeps } from "../../src/plugins/roblox/studio-install.ts";
import { type Launch, QUIT_WAIT_MS } from "../../src/plugins/roblox/studio-launch.ts";
import { MCP_SWITCH_CLICK_PATH, MESSAGE } from "../../src/plugins/roblox/words.ts";
import type { LocateStat, Run } from "../../src/plugins/roblox/studio-locate.ts";
import { STUDIO_MAC_APP } from "../../src/plugins/roblox/studio-locate.ts";
import { toolbarItems, visibleToolbarEntries } from "../../src/shared/plugin-toolbar.ts";
import type { GameKind } from "../../src/shared/project-facts.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { PluginRegistry } from "../../src/substrate/plugins/registry.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { makeResources } from "../helpers/resources.ts";
import { shippedHelper } from "../helpers/roblox-helper.ts";
import { tmpDir } from "../helpers/tmp.ts";

const SHIPPED_HELPER = await shippedHelper();

const HOME = "/Users/maker";
const STORAGE = "/Genex/plugins/roblox/storage";
/** Joined as the backend joins it, so the fake disk matches on Windows too. */
const SETUP_RECORD = path.join(STORAGE, "setup", "record.json");
const CONTENTS = `${STUDIO_MAC_APP}/Contents`;
const STUDIO_FILES = [`${CONTENTS}/MacOS/RobloxStudio`, `${CONTENTS}/MacOS/StudioMCP`, `${CONTENTS}/Info.plist`];
const BANNED_WORDS = /overnight|night|morning|tonight|Unreal/i;

/** A Mac as the backend sees it: which files exist, whether Studio runs and answers. */
interface Mac {
  installed: boolean;
  setUp: boolean;
  running: boolean;
  answering: boolean;
  /** Studio closes when asked to quit (else it stays open, as when the person keeps it). */
  quitCloses?: boolean;
}

/** No network in these tests unless one hands the backend its own. */
const NO_INSTALL: InstallDeps = {
  platform: "darwin",
  env: {},
  fetch: (async () => {
    throw new TypeError("no network in this test");
  }) as typeof fetch,
  run: async (file) => {
    throw new Error(`spawn ${file} ENOENT`);
  },
  tempRoot: "/nonexistent-temp",
};

function fakeMac(given: Mac, home = HOME) {
  const state = { ...given };
  const touched: string[] = [];
  const ran: string[] = [];
  const calls: Launch[] = [];
  const opened: Launch[] = [];
  let clock = 0;
  /** When the open Studio closes by itself (the installer's Studio after sign-in). */
  let closesAt: number | undefined;
  const dirs = new Set(["/Applications", ...(state.installed ? [STUDIO_MAC_APP] : [])]);
  const files = new Set([...(state.installed ? STUDIO_FILES : []), ...(state.setUp ? [SETUP_RECORD] : [])]);
  /** Roblox's installer puts Studio in Applications and opens it; it closes by itself after `runsFor`. */
  const installStudio = (runsFor: number) => {
    dirs.add(STUDIO_MAC_APP);
    for (const file of STUDIO_FILES) files.add(file);
    state.installed = true;
    state.running = true;
    closesAt = clock + runsFor;
  };
  const run: Run = async (file, args) => {
    ran.push(file);
    calls.push({ file, args: [...args] });
    if (file === "/usr/bin/osascript") {
      if (state.quitCloses) state.running = false;
      return { code: 0, stdout: "" };
    }
    if (file === "/usr/bin/plutil") return { code: 0, stdout: "0.743.0.7431133\n" };
    if (file === "/usr/bin/pgrep") return state.running ? { code: 0, stdout: "4530\n" } : { code: 1, stdout: "" };
    throw new Error(`spawn ${file} ENOENT`);
  };
  const deps: RobloxDeps = {
    platform: "darwin",
    env: { HOME: home },
    home,
    run,
    fs: {
      async lstat(file): Promise<LocateStat | undefined> {
        touched.push(file);
        if (dirs.has(file)) return { file: false, directory: true, link: false, mtimeMs: 0 };
        if (files.has(file)) return { file: true, directory: false, link: false, mtimeMs: 0 };
        return undefined;
      },
      async realpath(file) {
        touched.push(file);
        return file;
      },
      async readdir(dir) {
        touched.push(dir);
        return [];
      },
    },
    answers: async () => state.answering,
    helper: SHIPPED_HELPER,
    install: { fetch: NO_INSTALL.fetch, run: NO_INSTALL.run, tempRoot: NO_INSTALL.tempRoot },
    open: async (launch) => {
      opened.push(launch);
      state.running = true;
    },
    sleep: async (ms) => {
      clock += ms;
      if (closesAt !== undefined && clock >= closesAt) {
        state.running = false;
        closesAt = undefined;
      }
    },
    now: () => clock,
  };
  return { deps, touched, ran, calls, opened, installStudio };
}

/**
 * A plugin call's context: the plugin's storage, the host's answer to Do it for me, and whether the
 * host says Do it for me can run on this computer (computer control and its driver here).
 */
function context(
  storage = STORAGE,
  assist: (args: unknown) => PluginEngineAssistAnswer = () => ({ started: false, reason: "unavailable" }),
  canAssist = true,
): PluginContext {
  const host = (async (method: string, args: unknown) => {
    if (method === "storage.root") return storage;
    if (method === "game.engine.assist") return assist(args);
    if (method === "game.engine.canAssist") return canAssist;
    throw new Error(`No ${method} here`);
  }) as PluginContext["host"];
  return { signal: new AbortController().signal, callId: 1, host };
}

/** A call's context whose host names the games whose run is going. */
function withRuns(base: PluginContext, runs: unknown[]): PluginContext {
  const host = (async (method: string, args: unknown) =>
    method === "game.engine.runs" ? runs : base.host(method as never, args as never)) as PluginContext["host"];
  return { ...base, host };
}

const MISSING: Mac = { installed: false, setUp: false, running: false, answering: false };
const NOT_SET_UP: Mac = { installed: true, setUp: false, running: true, answering: false };
const CLOSED: Mac = { installed: true, setUp: true, running: false, answering: false };
const STARTING: Mac = { installed: true, setUp: true, running: true, answering: false };
const READY: Mac = { installed: true, setUp: true, running: true, answering: true };

/** Each state, the status it is, and the badge and tone its dot shows. */
const STATES: Array<[Mac, StudioStatus, string, NonNullable<PluginToolbarStatus["tone"]>]> = [
  [MISSING, StudioStatus.Get, "Not installed", "info"],
  [NOT_SET_UP, StudioStatus.SetUp, "Set up", "warn"],
  [CLOSED, StudioStatus.NotOpen, "Not open", "info"],
  [STARTING, StudioStatus.Starting, "Starting", "warn"],
  [READY, StudioStatus.Ready, "Ready", "ok"],
];

describe("the Roblox Studio toolbar button's word", () => {
  for (const [mac, status, badge, tone] of STATES)
    it(`says ${badge} (${status}) as a ${tone} dot, in plain words, without reading Documents`, async () => {
      const { deps, touched } = fakeMac(mac);
      const backend = createRobloxBackend(deps);
      const answer = (await backend.action?.("toolbar-status", {}, context())) as PluginToolbarStatus;
      assert.deepEqual([answer.badge, answer.tone, answer.dot], [badge, tone, true]);
      assert.ok(answer.title && answer.title.length > 0, "a title says what the state means");
      assert.doesNotMatch(`${answer.badge} ${answer.title}`, BANNED_WORDS);
      assert.deepEqual(
        touched.filter((file) => file.includes("/Documents")),
        [],
        "the button never reads Documents: macOS would ask the person for it",
      );
    });

  it("names the installed version while Studio is closed", async () => {
    const answer = (await createRobloxBackend(fakeMac(CLOSED).deps).action?.(
      "toolbar-status",
      {},
      context(),
    )) as PluginToolbarStatus;
    assert.match(answer.title ?? "", /0\.743/);
  });

  it("asks nothing further than it needs: no process check before setup, no answer check while closed", async () => {
    const missing = fakeMac(MISSING);
    await createRobloxBackend(missing.deps).action?.("toolbar-status", {}, context());
    assert.deepEqual(missing.ran, [], "nothing runs when Studio isn't there");
    const notSetUp = fakeMac(NOT_SET_UP);
    await createRobloxBackend(notSetUp.deps).action?.("toolbar-status", {}, context());
    assert.ok(!notSetUp.ran.includes("/usr/bin/pgrep"), "whether Studio runs doesn't matter before setup");
  });

  it("starts the helper link in the plugin's storage once Genex has set Studio up, never before", async () => {
    for (const mac of [MISSING, NOT_SET_UP]) {
      const { deps } = fakeMac(mac);
      const started: string[] = [];
      await createRobloxBackend({ ...deps, helperLink: (storage) => void started.push(storage) }).action?.(
        "toolbar-status",
        {},
        context(),
      );
      assert.deepEqual(started, [], "no helper can connect before setup added it");
    }
    const { deps } = fakeMac(CLOSED);
    const started: string[] = [];
    const backend = createRobloxBackend({ ...deps, helperLink: (storage) => void started.push(storage) });
    await backend.action?.("toolbar-status", {}, context());
    await backend.action?.("status", {}, context());
    assert.deepEqual(started, [STORAGE, STORAGE], "each read hands the storage over; the starter starts once");
  });

  it("hands the script sync each game's folder from the calls that carry one", async () => {
    const { deps } = fakeMac(CLOSED);
    const seen: string[][] = [];
    const backend = createRobloxBackend({
      ...deps,
      gameSeen: async (storage, game, folder) => void seen.push([storage, game, folder]),
    });
    await backend.action?.("toolbar-status", {}, context());
    await backend.action?.("status", {}, { ...context(), project: "game-1", directory: "/games/game-1" });
    await backend.tool?.("studio-activity", {}, { ...context(), project: "game-2", directory: "/games/game-2" });
    assert.deepEqual(seen, [
      [STORAGE, "game-1", "/games/game-1"],
      [STORAGE, "game-2", "/games/game-2"],
    ]);
  });

  it("answers check-scripts plainly while the Luau checks aren't added, checking nothing", async () => {
    const { deps, ran } = fakeMac(READY);
    const answer = (await createRobloxBackend(deps).tool?.("check-scripts", {}, context())) as {
      checked: boolean;
      message: string;
    };
    assert.equal(answer.checked, false);
    assert.match(answer.message, /Luau checks aren't added yet/);
    assert.doesNotMatch(answer.message, BANNED_WORDS);
    assert.deepEqual(ran, []);
  });

  it("orders the states: missing first, then setup, then open, then answering", () => {
    const facts = { installed: true, setUp: true, running: true, answering: true };
    assert.equal(studioStatusOf({ ...facts, installed: false }), StudioStatus.Get);
    assert.equal(studioStatusOf({ ...facts, setUp: false }), StudioStatus.SetUp);
    assert.equal(studioStatusOf({ ...facts, running: false }), StudioStatus.NotOpen);
    assert.equal(studioStatusOf({ ...facts, answering: false }), StudioStatus.Starting);
    assert.equal(studioStatusOf(facts), StudioStatus.Ready);
    assert.equal(
      studioStatusOf({ ...facts, running: false, answering: true }),
      StudioStatus.NotOpen,
      "an answer without a running Studio is not Studio's",
    );
  });
});

describe("the Roblox Studio panel's status and the lock's probe", () => {
  it("answers the status, the version, which panel steps are done, the rows and the step that is next", async () => {
    const backend = createRobloxBackend(fakeMac(STARTING).deps);
    const starting = (await backend.action?.("status", {}, context())) as RobloxStatus;
    assert.deepEqual(
      { studio: starting.studio, version: starting.version, steps: starting.steps, now: starting.now },
      {
        studio: StudioStatus.Starting,
        version: "0.743.0.7431133",
        steps: { [PanelStep.Studio]: true, [PanelStep.Helper]: true, [PanelStep.Mcp]: false, [PanelStep.Place]: false },
        now: "mcp",
      },
    );
    assert.deepEqual(
      starting.rows.map((row) => [row.id, row.done]),
      [
        ["studio", true],
        ["sign-in", false],
        ["helper", true],
        ["mcp", false],
        ["place", false],
      ],
    );
    assert.deepEqual(starting.mcp, { settings: 0, on: 0 }, "no settings file in this home");
    const missing = (await createRobloxBackend(fakeMac(MISSING).deps).action?.(
      "status",
      {},
      context(),
    )) as RobloxStatus;
    assert.deepEqual(
      { studio: missing.studio, steps: missing.steps, now: missing.now, mcp: missing.mcp },
      {
        studio: StudioStatus.Get,
        steps: {
          [PanelStep.Studio]: false,
          [PanelStep.Helper]: false,
          [PanelStep.Mcp]: false,
          [PanelStep.Place]: false,
        },
        now: "studio",
        mcp: undefined,
      },
    );
  });

  it("the steps card shows the panel's rows: same ids, words, ticks and buttons", async () => {
    for (const mac of [MISSING, NOT_SET_UP, CLOSED, STARTING, READY]) {
      const backend = createRobloxBackend(fakeMac(mac).deps);
      const panel = (await backend.action?.("status", {}, context())) as RobloxStatus;
      const card = (await backend.action?.("steps", {}, context())) as StepsCard;
      assert.deepEqual(
        card.steps.map(({ id, label, done, action }) => ({ id, label, done, action })),
        panel.rows.map(({ id, label, done, action }) => ({ id, label, done, action })),
      );
    }
  });

  it("offers Do it for me only where the host says computer control can run; elsewhere Restart Studio and Studio's clicks", async () => {
    const backend = createRobloxBackend(fakeMac(STARTING).deps);
    const mcpRow = async (canAssist: boolean) => {
      const status = (await backend.action?.("status", {}, context(STORAGE, undefined, canAssist))) as RobloxStatus;
      return status.rows.find((row) => row.id === "mcp");
    };
    const here = await mcpRow(true);
    assert.equal(here?.action?.name, "do-it-for-me");
    assert.deepEqual(here?.clickPath, MCP_SWITCH_CLICK_PATH.split(" › "));
    // No driver, or computer control can't run here: no Do it for me, and Studio's own clicks instead.
    const nowhere = await mcpRow(false);
    assert.equal(nowhere?.action?.name, "restart-studio");
    assert.equal(nowhere?.more, undefined);
    assert.deepEqual(nowhere?.clickPath, MCP_SWITCH_CLICK_PATH.split(" › "));
    const card = (await backend.action?.("steps", {}, context(STORAGE, undefined, false))) as StepsCard;
    assert.notEqual(card.steps.find((step) => step.id === "mcp")?.action?.name, "do-it-for-me");
  });

  it("the probe sees nobody using Studio, and an unknown action or tool is refused", async () => {
    const backend = createRobloxBackend(fakeMac(READY).deps);
    assert.deepEqual(await backend.tool?.("studio-activity", {}, context()), { personActive: false });
    await assert.rejects(() => backend.action!("publish", {}, context()), /Unknown Roblox Studio action: publish/);
    await assert.rejects(() => backend.tool!("insert", {}, context()), /Unknown Roblox Studio tool: insert/);
  });
});

describe("Set up, Restart Studio and Do it for me from the panel", () => {
  // Flipped: the task now also says to click only its path and stop at any other dialog, and that
  // the turn answering it clicks it itself with the desktop tool, never handing it on again.
  const TASK =
    "Turn on Studio's MCP server: Assistant › ⋯ › Settings › MCP Servers › Enable Studio as MCP server. Click only that path, now, with the desktop tool (not do-it-for-me). If Studio shows any other dialog or question (saving, signing in, updates, terms), stop and tell the person.";

  it("Set up refuses while Studio runs, reading nothing, and offers Restart Studio, Do it for me and the click path", async () => {
    const mac = fakeMac(NOT_SET_UP);
    const answer = (await createRobloxBackend(mac.deps).action?.("setup", {}, context())) as SetupAnswer;
    assert.equal(answer.done, false);
    assert.equal(answer.reason, "studio-running");
    assert.deepEqual(
      answer.choices?.map((choice) => [choice.action, choice.label]),
      [
        ["restart-studio", "Restart Studio"],
        ["do-it-for-me", "Do it for me"],
      ],
    );
    assert.equal(answer.clickPath, MCP_SWITCH_CLICK_PATH);
    assert.doesNotMatch(answer.message, BANNED_WORDS);
    assert.deepEqual(
      mac.touched.filter((file) => file.includes("/Documents")),
      [],
    );
    await assert.rejects(lstat(HOME), "the fake home was never made");
  });

  it("Do it for me hands the host the exact task, and starts the chat's turn when it can", async () => {
    const asked: unknown[] = [];
    const backend = createRobloxBackend(fakeMac(READY).deps);
    const started = (await backend.action?.(
      "do-it-for-me",
      {},
      context(STORAGE, (args) => {
        asked.push(args);
        return { started: true };
      }),
    )) as AssistAnswer;
    assert.deepEqual(asked, [{ task: TASK }]);
    assert.equal(started.started, true);
    assert.equal(started.clickPath, undefined);
  });

  it("Do it for me's task tells the chat's turn to stop at any other dialog and click only its own path", async () => {
    const asked: Array<{ task?: string }> = [];
    const backend = createRobloxBackend(fakeMac(READY).deps);
    await backend.action?.(
      "do-it-for-me",
      {},
      context(STORAGE, (args) => {
        asked.push(args as { task?: string });
        return { started: true };
      }),
    );
    const task = String(asked[0]?.task);
    assert.match(task, /If Studio shows any other dialog or question/);
    for (const kind of ["saving", "signing in", "updates", "terms"]) assert.ok(task.includes(kind), kind);
    assert.match(task, /stop and tell the person/);
  });

  const refusals: PluginEngineAssistRefusal[] = ["unavailable", "declined", "no-chat", "not-person", "no-apps"];
  for (const reason of refusals)
    it(`Do it for me answered ${reason} shows Studio's own click path`, async () => {
      const backend = createRobloxBackend(fakeMac(READY).deps);
      const answer = (await backend.action?.(
        "do-it-for-me",
        {},
        context(STORAGE, () => ({ started: false, reason })),
      )) as AssistAnswer;
      assert.equal(answer.started, false);
      assert.equal(answer.reason, reason);
      assert.equal(answer.clickPath, MCP_SWITCH_CLICK_PATH);
      assert.ok(answer.message.includes(MCP_SWITCH_CLICK_PATH), answer.message);
      assert.doesNotMatch(answer.message, BANNED_WORDS);
    });

  /** A Mac home with Roblox's folders and one account's settings, the switch off. */
  async function robloxHome() {
    const root = await tmpDir("roblox-restart-");
    const home = path.join(root, "home");
    await mkdir(path.join(home, "Documents", "Roblox"), { recursive: true });
    const settings = path.join(home, "Library", "Roblox", "AssistantSettings");
    await mkdir(settings, { recursive: true });
    await writeFile(path.join(settings, "1.json"), '{"mcp-server": {"enabled": false}}');
    return { home, storage: path.join(root, "storage"), settings: path.join(settings, "1.json") };
  }

  it("Restart Studio quits normally, sets up while Studio is closed and opens it once", {
    skip: process.platform === "win32" && "a Mac home on a Mac path",
  }, async () => {
    const { home, storage, settings } = await robloxHome();
    const mac = fakeMac({ ...NOT_SET_UP, quitCloses: true }, home);
    const answer = (await createRobloxBackend(mac.deps).action?.(
      "restart-studio",
      {},
      context(storage),
    )) as SetupAnswer;
    assert.equal(answer.done, true, answer.message);
    assert.equal(answer.reopened, true);
    const quits = mac.calls.filter((call) => call.file === "/usr/bin/osascript");
    assert.equal(quits.length, 1, "one quit");
    assert.equal(quits[0]?.args.at(-1), "4530", "the quit names the open Studio's process");
    assert.doesNotMatch(quits[0]?.args.join(" ") ?? "", /kill|-9|force/i, "never forced");
    assert.deepEqual(mac.opened, [{ file: "/usr/bin/open", args: ["-a", STUDIO_MAC_APP] }]);
    assert.ok((await lstat(path.join(home, "Documents", "Roblox", "Plugins", HELPER_FILE))).isFile());
    assert.equal(JSON.parse(await readFile(settings, "utf8"))["mcp-server"].enabled, true);
  });

  it("Restart Studio leaves Studio and every file alone when Studio stays open", {
    skip: process.platform === "win32" && "a Mac home on a Mac path",
  }, async () => {
    const { home, storage, settings } = await robloxHome();
    const mac = fakeMac({ ...NOT_SET_UP, quitCloses: false }, home);
    const answer = (await createRobloxBackend(mac.deps).action?.(
      "restart-studio",
      {},
      context(storage),
    )) as SetupAnswer;
    assert.equal(answer.done, false);
    assert.equal(answer.reason, "still-open");
    assert.deepEqual(mac.opened, [], "Studio was never closed, so it is not opened again");
    assert.ok(mac.deps.now() >= QUIT_WAIT_MS, "it waited the whole quit wait");
    await assert.rejects(lstat(path.join(home, "Documents", "Roblox", "Plugins")));
    assert.equal(await readFile(settings, "utf8"), '{"mcp-server": {"enabled": false}}');
  });

  it("Restart Studio leaves Studio and every file alone while a build uses it, as Quit Studio does", {
    skip: process.platform === "win32" && "a Mac home on a Mac path",
  }, async () => {
    const { home, storage, settings } = await robloxHome();
    const mac = fakeMac({ ...NOT_SET_UP, quitCloses: true }, home);
    const backend = createRobloxBackend(mac.deps);
    const busy = withRuns(context(storage), [{ game: "tower", title: "Tower", project: "/games/tower/tower.rbxlx" }]);
    const pressed = (await backend.action?.("restart-studio", {}, busy)) as SetupAnswer;
    assert.equal(pressed.done, false);
    assert.equal(pressed.reason, "in-use");
    assert.match(pressed.message, /Tower/);
    const called = String(await backend.tool?.("restart-studio", {}, busy));
    assert.match(called, /Tower/);
    assert.equal(mac.calls.filter((call) => call.file === "/usr/bin/osascript").length, 0, "never asked to quit");
    assert.deepEqual(mac.opened, []);
    await assert.rejects(lstat(path.join(home, "Documents", "Roblox", "Plugins")));
    assert.equal(await readFile(settings, "utf8"), '{"mcp-server": {"enabled": false}}');
  });

  it("where Genex can't click and Studio has no settings file yet, the agent is given the person's one click", {
    skip: process.platform === "win32" && "a Mac home on a Mac path",
  }, async () => {
    const root = await tmpDir("roblox-no-settings-");
    const home = path.join(root, "home");
    await mkdir(path.join(home, "Documents", "Roblox"), { recursive: true });
    const nowhere = context(path.join(root, "storage"), undefined, false);
    const restarted = String(
      await createRobloxBackend(fakeMac({ ...NOT_SET_UP, quitCloses: true }, home).deps).tool?.(
        "restart-studio",
        {},
        nowhere,
      ),
    );
    assert.ok(restarted.includes(MCP_SWITCH_CLICK_PATH), restarted);
    assert.doesNotMatch(restarted, /roblox__do-it-for-me/, "no tool to go round to");
    // Do it for me refused here names the same click, for when Restart Studio can't switch it on.
    const refused = context(STORAGE, undefined, false);
    const clicked = String(await createRobloxBackend(fakeMac(STARTING).deps).tool?.("do-it-for-me", {}, refused));
    assert.ok(clicked.includes(MCP_SWITCH_CLICK_PATH), clicked);
  });

  it("Set up's confirmation says what it does, naming the Documents prompt on a Mac", async () => {
    const review = (await createRobloxBackend(fakeMac(NOT_SET_UP).deps).review?.(
      "setup",
      {},
      context(),
    )) as PluginReview;
    assert.match(review.message ?? "", /Genex helper/);
    assert.match(review.detail ?? "", /macOS may ask to let Genex use your Documents folder/);
  });
});

/** The status once Get Roblox Studio has finished, or failed, polled as the panel polls it. */
async function finished(backend: ReturnType<typeof createRobloxBackend>, storage: string) {
  for (let tries = 0; tries < 400; tries++) {
    const answer = (await backend.action?.("status", {}, context(storage))) as RobloxStatus;
    if (answer.install && ["done", "failed"].includes(answer.install.phase)) return answer;
    await wait(5);
  }
  assert.fail("Get Roblox Studio never finished");
}

/** The steps card the chat draws, for the game the call is bound to. */
async function stepsCard(mac: Mac, linked = false) {
  const backend = createRobloxBackend(fakeMac(mac).deps);
  const host = (async (method: string) => {
    if (method === "storage.root") return STORAGE;
    if (method === "game.engine.read") return linked ? { kind: "roblox", project: "place.rbxl", name: "place" } : null;
    throw new Error(`No ${method} here`);
  }) as PluginContext["host"];
  const bound: PluginContext = { signal: new AbortController().signal, callId: 1, host, project: "game-1" };
  return (await backend.action?.("steps", {}, bound)) as StepsCard;
}

describe("Get Roblox Studio and the steps card", () => {
  it("on a computer with Studio, the Studio row ticks itself with the version and Get Roblox Studio isn't offered", async () => {
    const card = await stepsCard(CLOSED);
    const studio = card.steps.find((row) => row.id === "studio");
    assert.equal(studio?.done, true);
    assert.match(studio?.label ?? "", /Roblox Studio 0\.743 is on this computer/);
    assert.ok(!card.steps.some((row) => row.action?.name === "get-studio"), "no Get Roblox Studio");
    assert.deepEqual(
      card.steps.map((row) => row.id),
      ["studio", "sign-in", "helper", "mcp", "place"],
    );
  });

  it("without Studio, the Studio row offers Get Roblox Studio and sign-in stays the person's step", async () => {
    const card = await stepsCard(MISSING);
    const studio = card.steps.find((row) => row.id === "studio");
    assert.deepEqual(studio?.action, { name: "get-studio", args: {}, label: "Get Roblox Studio" });
    const signIn = card.steps.find((row) => row.id === "sign-in");
    assert.equal(signIn?.detail, MESSAGE.Steps.SignInDetail());
    assert.equal(signIn?.action, undefined, "Genex never signs in");
    assert.equal(card.open, true);
    for (const row of card.steps) assert.doesNotMatch(`${row.label} ${row.detail}`, BANNED_WORDS);
  });

  it("offers Open Studio only while Studio is closed, set up or not", async () => {
    const offersOpen = (card: StepsCard) => card.steps.some((row) => row.action?.name === "open-studio");
    assert.equal(offersOpen(await stepsCard(NOT_SET_UP)), false, "Studio runs, though Genex hasn't set it up");
    assert.equal(offersOpen(await stepsCard(STARTING)), false);
    assert.equal(offersOpen(await stepsCard(CLOSED)), true);
    assert.equal(offersOpen(await stepsCard({ ...NOT_SET_UP, running: false })), true);
  });

  it("ticks every row once Studio answers and the game builds in a place", async () => {
    const card = await stepsCard(READY, true);
    assert.deepEqual(
      card.steps.map((row) => [row.id, row.done]),
      [
        ["studio", true],
        ["sign-in", true],
        ["helper", true],
        ["mcp", true],
        ["place", true],
      ],
    );
    assert.equal(card.open, false);
  });

  it("Get Roblox Studio's confirmation names Roblox, this computer's download size, and the sign-in", async () => {
    const review = (await createRobloxBackend(fakeMac(MISSING).deps).review?.(
      "get-studio",
      {},
      context(),
    )) as PluginReview;
    assert.equal(
      review.message,
      "Download Roblox Studio from Roblox (about 11 MB), check that Roblox signed it, and install it?",
    );
    assert.match(review.detail ?? "", /setup\.rbxcdn\.com/);
    assert.match(review.detail ?? "", /Genex never sees your password/);
    assert.doesNotMatch(`${review.message} ${review.detail}`, BANNED_WORDS);
  });

  it("is not run again when Studio is already here: nothing is downloaded", async () => {
    const mac = fakeMac(CLOSED);
    const answer = (await createRobloxBackend(mac.deps).action?.("get-studio", {}, context())) as {
      started: boolean;
      message: string;
    };
    assert.equal(answer.started, false);
    assert.match(answer.message, /Roblox Studio 0\.743 is already on this computer/);
  });

  it("from nothing on a Mac: installs, waits for sign-in, sets up while Studio is closed, and opens it once", {
    skip: process.platform === "win32" && "a Mac home on a Mac path",
  }, async () => {
    const root = await tmpDir("roblox-get-studio-");
    const home = path.join(root, "home");
    await mkdir(path.join(home, "Documents", "Roblox"), { recursive: true });
    const settings = path.join(home, "Library", "Roblox", "AssistantSettings");
    await mkdir(settings, { recursive: true });
    await writeFile(path.join(settings, "1.json"), '{"mcp-server": {"enabled": false}}');
    const storage = path.join(root, "storage");
    const tempRoot = path.join(root, "temp");
    await mkdir(tempRoot);
    const mac = fakeMac(MISSING, home);
    const fetched: string[] = [];
    mac.deps.install = {
      fetch: (async (url: string) => {
        fetched.push(String(url));
        return new Response(Buffer.from("roblox dmg"));
      }) as typeof fetch,
      run: async (file, args) => {
        if (file === "/usr/bin/codesign" && !args.includes("--verify"))
          return { code: 0, stdout: "", stderr: "TeamIdentifier=2CFABCH843\n" };
        if (file === "/usr/bin/hdiutil" && args[0] === "attach")
          await mkdir(path.join(args[args.indexOf("-mountpoint") + 1] ?? "", "RobloxStudioInstaller.app"));
        // Roblox's installer: Studio lands in Applications and opens for the person to sign in.
        if (file === "/usr/bin/open") mac.installStudio(60_000);
        return { code: 0, stdout: "", stderr: "" };
      },
      tempRoot,
    };
    const backend = createRobloxBackend(mac.deps);
    const started = (await backend.action?.("get-studio", {}, context(storage))) as { started: boolean };
    assert.equal(started.started, true);
    const status = await finished(backend, storage);
    assert.equal(status.install?.phase, "done", status.install?.message);
    assert.deepEqual(fetched, ["https://setup.rbxcdn.com/mac/RobloxStudio.dmg"]);
    assert.deepEqual(
      mac.opened,
      [{ file: "/usr/bin/open", args: ["-a", STUDIO_MAC_APP] }],
      "opened once, after Set up",
    );
    assert.ok((await lstat(path.join(home, "Documents", "Roblox", "Plugins", HELPER_FILE))).isFile());
    assert.equal(JSON.parse(await readFile(path.join(settings, "1.json"), "utf8"))["mcp-server"].enabled, true);
    assert.equal(JSON.parse(await readFile(path.join(storage, "install", "state.json"), "utf8")).phase, "done");
    assert.deepEqual(await readdir(tempRoot), [], "the download is gone");
  });

  it("Stop ends a download under way, runs nothing and keeps no download", async () => {
    const root = await tmpDir("roblox-stop-get-");
    const tempRoot = path.join(root, "temp");
    await mkdir(tempRoot);
    const mac = fakeMac(MISSING);
    const ran: string[] = [];
    mac.deps.install = {
      fetch: (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(stream) {
              stream.enqueue(new Uint8Array(1024));
            },
          }),
        )) as typeof fetch,
      run: async (file) => {
        ran.push(file);
        return { code: 0, stdout: "", stderr: "" };
      },
      tempRoot,
    };
    const backend = createRobloxBackend(mac.deps);
    const storage = path.join(root, "storage");
    await backend.action?.("get-studio", {}, context(storage));
    const again = (await backend.action?.("get-studio", {}, context(storage))) as { started: boolean; message: string };
    assert.deepEqual([again.started, again.message], [false, "Genex is already getting Roblox Studio."]);
    await backend.action?.("cancel-get-studio", {}, context(storage));
    const status = await finished(backend, storage);
    assert.equal(status.install?.phase, "failed");
    assert.equal(status.install?.reason, "cancelled");
    assert.deepEqual(ran, [], "nothing ran");
    assert.deepEqual(await readdir(tempRoot), []);
    assert.deepEqual(mac.opened, []);
  });
});

describe("every panel action the person can press is also an agent tool", () => {
  const MANIFEST = path.resolve(import.meta.dirname, "../../src/plugins/roblox/plugin.json");
  /** Each action the panel offers a press for, and the agent tool that does the same. */
  const PRESSABLE: Record<string, string> = {
    setup: "setup",
    "undo-setup": "undo-setup",
    "restart-studio": "restart-studio",
    "do-it-for-me": "do-it-for-me",
    "get-studio": "get-studio",
    "cancel-get-studio": "cancel-get-studio",
    "open-studio": "open-studio",
    "quit-studio": "quit-studio",
    places: "places",
    "use-place": "use-project",
    create: "new-game",
    "add-luau-checks": "add-luau-checks",
    "publish-update": "publish-update",
    "first-publish": "first-publish",
  };
  /** The tools that ask on a card though their panel press doesn't: an agent never closes Studio unasked. */
  const ASKS_ONLY_AS_A_TOOL = new Set(["quit-studio"]);
  /** Words that hand the person a click Genex can do itself. */
  const HANDS_A_CLICK = /\bpress\b|click it yourself|turn it on yourself|in the Roblox Studio panel/i;

  it("the manifest declares a tool for each, asking on a card where its press asks (and before quitting Studio)", async () => {
    const manifest = validateManifest(JSON.parse(await readFile(MANIFEST, "utf8")));
    const read = new Set(["status", "toolbar-status", "steps"]);
    const actions = (manifest.actions ?? []).filter((action) => !read.has(action.name));
    assert.deepEqual(actions.map((action) => action.name).sort(), Object.keys(PRESSABLE).sort());
    for (const action of actions) {
      const tool = manifest.tools.find((entry) => entry.name === PRESSABLE[action.name]);
      assert.ok(tool, `a tool for ${action.name}`);
      assert.notEqual(tool.audience, "harness", `${tool.name} is the agents'`);
      const asks = Boolean(action.confirmation) || ASKS_ONLY_AS_A_TOOL.has(tool.name);
      assert.equal(Boolean(tool.confirmation), asks, `${tool.name} asks on a card only where it must`);
    }
  });

  /** The host as a tool call sees it: Do it for me's answer and the tasks it was handed. */
  function agentContext(answer: PluginEngineAssistAnswer = { started: true }) {
    const tasks: string[] = [];
    const ctx = context(STORAGE, (args) => {
      tasks.push(String((args as { task?: string }).task));
      return answer;
    });
    return { ctx, tasks };
  }

  it("do-it-for-me starts the switch's click itself while Studio is open and its MCP server off, and says to end the turn", async () => {
    const backend = createRobloxBackend(fakeMac(STARTING).deps);
    const { ctx, tasks } = agentContext();
    const answer = String(await backend.tool?.("do-it-for-me", {}, ctx));
    assert.deepEqual(tasks, [MESSAGE.Assist.Task]);
    // Flipped: the answer also says to click now when the task joined this very turn.
    assert.match(answer, /end this turn/i);
    assert.match(answer, /in front of you in this turn/);
    assert.doesNotMatch(answer, HANDS_A_CLICK);
  });

  it("do-it-for-me clicks nothing when Studio is closed, not set up or already answering, and names the tool to call instead", async () => {
    const cases: Array<[Mac, RegExp]> = [
      [CLOSED, /roblox__open-studio/],
      [NOT_SET_UP, /roblox__restart-studio/],
      [MISSING, /roblox__get-studio/],
      [READY, /answering/],
    ];
    for (const [mac, words] of cases) {
      const { ctx, tasks } = agentContext();
      const answer = String(await createRobloxBackend(fakeMac(mac).deps).tool?.("do-it-for-me", {}, ctx));
      assert.deepEqual(tasks, [], JSON.stringify(mac));
      assert.match(answer, words);
      assert.doesNotMatch(answer, HANDS_A_CLICK);
    }
  });

  for (const reason of ["unavailable", "declined", "no-chat", "not-person", "no-apps"] as const)
    it(`do-it-for-me answered ${reason} points the agent at Restart Studio, never at the person's clicks`, async () => {
      const backend = createRobloxBackend(fakeMac(STARTING).deps);
      const { ctx } = agentContext({ started: false, reason });
      const answer = String(await backend.tool?.("do-it-for-me", {}, ctx));
      if (reason !== "no-chat") assert.match(answer, /roblox__restart-studio/);
      assert.doesNotMatch(answer, HANDS_A_CLICK);
    });

  it("do-it-for-me in the turn that holds the chat's assist tells it to click now, never to call again", async () => {
    const backend = createRobloxBackend(fakeMac(STARTING).deps);
    const { ctx } = agentContext({ started: false, reason: "in-assist" });
    const answer = String(await backend.tool?.("do-it-for-me", {}, ctx));
    assert.match(answer, /desktop tool/);
    assert.doesNotMatch(answer, /roblox__restart-studio|roblox__do-it-for-me/);
    assert.doesNotMatch(answer, HANDS_A_CLICK);
  });

  it("setup with Studio open names restart-studio and do-it-for-me; with no Studio, get-studio; reading no Documents", async () => {
    const open = fakeMac(NOT_SET_UP);
    const running = String(await createRobloxBackend(open.deps).tool?.("setup", {}, context()));
    assert.match(running, /roblox__restart-studio/);
    assert.match(running, /roblox__do-it-for-me/);
    assert.doesNotMatch(running, HANDS_A_CLICK);
    assert.deepEqual(
      open.touched.filter((file) => file.includes("/Documents")),
      [],
    );
    const missing = String(await createRobloxBackend(fakeMac(MISSING).deps).tool?.("setup", {}, context()));
    assert.match(missing, /roblox__get-studio/);
  });

  it("places lists the places open in Studio and its recent files without reading Documents", async () => {
    const mac = fakeMac(READY);
    const answer = (await createRobloxBackend(mac.deps).tool?.("places", {}, context())) as {
      open: unknown[];
      files: unknown[];
      note: string;
    };
    assert.deepEqual([answer.open, answer.files], [[], []]);
    assert.match(answer.note, /roblox__use-project/);
    assert.deepEqual(
      mac.touched.filter((file) => file.includes("/Documents")),
      [],
    );
  });

  it("open-studio opens Studio, and get-studio on a computer with Studio says so in words", async () => {
    const mac = fakeMac(CLOSED);
    const backend = createRobloxBackend(mac.deps);
    const opened = String(await backend.tool?.("open-studio", {}, context()));
    assert.equal(mac.opened.length, 1);
    assert.match(opened, /Opening/);
    const got = String(await backend.tool?.("get-studio", {}, context()));
    assert.match(got, /already on this computer/);
    const quit = String(await createRobloxBackend(fakeMac(CLOSED).deps).tool?.("quit-studio", {}, context()));
    assert.match(quit, /isn't open/);
  });
});

describe("the built Roblox Studio plugin", () => {
  it("builds its backend, manifest, icon and panel with the panel SDK inlined", async () => {
    const resources = await makeResources({ tsc: false });
    const roblox = path.join(resources, "plugins", "roblox");
    for (const file of ["plugin.json", "icon.svg", "backend.mjs", "panel.html", HELPER_FILE])
      await access(path.join(roblox, file)).catch(() => assert.fail(`the package has ${file}`));
    const panel = await readFile(path.join(roblox, "panel.html"), "utf8");
    assert.doesNotMatch(panel, /<!-- STUDIO_PANEL_(SDK|FONTS) -->/, "the panel SDK and fonts are inlined");
    assert.match(panel, /window\.studioPlugin/);
    assert.match(panel, /Not affiliated with Roblox Corporation\. For people 18 and over\./);
  });

  it("is seeded off: no Roblox button until it is turned on, then Roblox Studio on a Roblox game only, with the box glyph and a word", async () => {
    const lite = await coreLite();
    const roblox = lite.core.plugins.list().find((p) => p.manifest.id === "roblox");
    assert.equal(roblox?.enabled, false, "the plugin ships turned off");
    const keys = (plugins: ReturnType<PluginRegistry["list"]>) => toolbarItems(plugins, null).map((entry) => entry.key);
    assert.ok(!keys(lite.core.plugins.list()).some((key) => key.startsWith("roblox:")), "off shows nothing Roblox");

    try {
      await lite.core.plugins.setEnabled("roblox", true);
      const on = (game: GameKind) =>
        visibleToolbarEntries(toolbarItems(lite.core.plugins.list(), "game", game), {}).find(
          (e) => e.key === "roblox:studio",
        );
      assert.equal(on({ facts: [{ id: "web-game", path: "." }] }), undefined, "a web game shows no Roblox button");
      const entry = on({ facts: [{ id: "roblox-project", path: "." }] });
      assert.deepEqual([entry?.item.label, entry?.item.icon], ["Roblox Studio", "box"]);
      const status = (await lite.core.plugins.action("roblox", "toolbar-status", {})) as PluginToolbarStatus;
      const words = STATES.map(([, , badge]) => badge);
      assert.ok(words.includes(status.badge ?? ""), `a status word: ${JSON.stringify(status)}`);
      assert.equal(status.dot, true);
    } finally {
      // A core that was never started leaves its plugins' processes to the test.
      lite.core.plugins.cancel();
      await lite.close();
    }
  });

  it("is listed with the engine it declares while off", async () => {
    const root = await tmpDir("roblox-registry-");
    const resources = await makeResources({ tsc: false });
    const registry = new PluginRegistry(
      path.join(root, "installed"),
      path.join(resources, "plugins"),
      path.join(resources, "plugin-sdk", "backend.mjs"),
      async () => null,
    );
    registry.seedEnabled = { roblox: false };
    await registry.init();
    try {
      assert.equal(registry.engines().get("roblox")?.label, "Roblox Studio");
      assert.equal(registry.enabled("roblox"), false);
    } finally {
      registry.cancel();
    }
  });
});
