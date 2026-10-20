/**
 * The Godot plugin against the real Godot on this Mac, in Genex's native-job sandbox: a new game
 * from each template checks clean, a broken script is named by file and line, a scene runs, the
 * stills are real PNGs and the class reference is the installed version's. Machine-dependent, so
 * skipped unless asked for: `STUDIO_GODOT_LIVE=1 node --test tests/conformance/godot-live.test.ts`
 * with Godot 4.3 or newer in Applications.
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { PluginContext } from "../../src/plugin-sdk/index.d.ts";
import { createGodotBackend, GodotTool } from "../../src/plugins/godot/backend.ts";
import { systemEditorEnv } from "../../src/plugins/godot/editor.ts";
import { AI_RELAY_BEAT, BRIDGE_FOLDER, godotAiChannel, liveEditor } from "../../src/plugins/godot/editor-bridge.ts";
import { hasWebTemplate, templateVersion } from "../../src/plugins/godot/web-export.ts";
import { findGodots, systemGodotEnv, usableGodot } from "../../src/plugins/godot/find-godot.ts";
import { confinedRunner } from "../../src/plugins/godot/godot-run.ts";
import { launchGameBridge } from "../../src/main/core/game-bridge-target.ts";
import { editorAiRelay, runEditorAiRelay } from "../../src/main/game-ai/bridge-editor.ts";
import { AiBridgeOp } from "../../src/shared/game-ai.ts";
import { AiContext } from "../../src/shared/game-ai-route.ts";
import { HookEvent } from "../../src/shared/plugin-hooks.ts";
import { PlayOp } from "../../src/shared/play-protocol.ts";
import { CaptureSurface } from "../../src/shared/preview-contract.ts";
import { PluginNativeServices } from "../../src/substrate/plugins/native.ts";
import { spawnNativeLongLived } from "../../src/substrate/plugins/native-process.ts";
import { readProjectShape } from "../../src/substrate/project-shape.ts";
import { fixtureAiService, fixtureNativeHost } from "../helpers/ai-fixture-service.ts";
import { ADDON, SCRIPTS, TEMPLATES } from "../helpers/godot-fake-engine.ts";
import { tmpDir } from "../helpers/tmp.ts";

const LIVE = process.env.STUDIO_GODOT_LIVE === "1";
const PNG_SIGNATURE = "iVBORw0KGgo";
/** A first import and a first capture compile shaders: generous for a cold Mac. */
const LIVE_TIMEOUT_MS = 5 * 60 * 1000;
const run = promisify(execFile);
/** How often, and how many times, the test looks for the editor's first heartbeat. */
const EDITOR_START_POLL_MS = 500;
const EDITOR_START_TRIES = 120;
/** How often the stand-in for the editor plugin beats, as the plugin does. */
const EDITOR_BEAT_MS = 1000;

type Answer = Record<string, unknown>;

/** The real backend in a fresh game folder, its storage beside it. */
async function liveGame() {
  const root = await realpath(await tmpDir("studio-godot-live-"));
  const game = path.join(root, "game");
  const storage = path.join(root, "storage");
  await mkdir(game);
  await mkdir(storage);
  const backend = createGodotBackend({
    env: systemGodotEnv(),
    editor: systemEditorEnv(),
    run: confinedRunner(),
    scripts: SCRIPTS,
    templates: TEMPLATES,
    addon: ADDON,
  });
  const context = (more: Partial<PluginContext> = {}): PluginContext => ({
    project: "live",
    directory: game,
    signal: new AbortController().signal,
    callId: 1,
    host: (async (method: string) => {
      if (method === "storage.root") return storage;
      throw new Error(`unexpected host call ${method}`);
    }) as PluginContext["host"],
    ...more,
  });
  const call = async (name: string, args = {}, more = {}) =>
    (await backend.tool?.(name, args, context(more))) as Answer;
  return { game, project: path.join(game, "godot"), call };
}

/** What the AI probe prints, before each result it drains. */
const PROBE_MARK = "genex-ai-probe ";
/** A probe autoload that asks once, on its fifth physics tick, and prints each result it drains, short. */
const AI_PROBE = [
  "extends Node",
  "",
  "var _tick := 0",
  "",
  "func _physics_process(_delta: float) -> void:",
  "\t_tick += 1",
  "\tfor result in GenexAI.drain():",
  `\t\tprinterr("${PROBE_MARK}" + JSON.stringify([result.site, result.ok, result.value]))`,
  "\tif _tick == 5:",
  '\t\tvar schema := {"type": "object", "properties": {"move": {"type": "string", "enum": ["left", "right"]}}, "required": ["move"], "additionalProperties": false}',
  '\t\tGenexAI.ask("probe.move", "Pick the way the probe runs.", schema)',
  "",
].join("\n");

/** The game's Godot project with GenexAI and the probe as autoloads after the Genex addon's own. */
async function useAiProbe(project: string): Promise<void> {
  await writeFile(path.join(project, "ai_probe.gd"), AI_PROBE);
  const file = path.join(project, "project.godot");
  const settings = await readFile(file, "utf8");
  const play = /^GenexPlay=.*$/m;
  assert.match(settings, play);
  const autoloads = 'GenexAI="*res://addons/genex/genex_ai.gd"\nAiProbe="*res://ai_probe.gd"';
  await writeFile(
    file,
    settings.replace(play, (line) => `${line}\n${autoloads}`),
  );
}

/** Starts the plugin's Godot runtime for `game` the way Genex does: confined, with the GPU. */
async function godotRuntime(game: string) {
  const manifest = JSON.parse(await readFile("src/plugins/godot/plugin.json", "utf8"));
  const found = await new PluginNativeServices(os.tmpdir(), []).detect(manifest.nativeRuntimes[0], os.tmpdir());
  assert.equal(found.state, "ready", found.detail);
  const engine = (await readProjectShape(game)).play?.engine;
  assert.ok(engine && found.path);
  const scratch = await realpath(await tmpDir("studio-godot-play-"));
  return async () => ({
    child: await spawnNativeLongLived({
      binary: found.path ?? "",
      args: engine.args,
      cwd: game,
      scratch,
      reads: [game],
      writes: [game],
      denyRead: [],
      gpu: true,
    }),
  });
}

describe("the Godot plugin on this Mac's Godot", { skip: !LIVE, timeout: LIVE_TIMEOUT_MS }, () => {
  for (const template of ["3d", "2d"]) {
    it(`makes a ${template} game that checks clean and shows its hero camera`, async () => {
      const { call } = await liveGame();
      assert.equal((await call(GodotTool.EngineStatus)).ready, true);
      await call(GodotTool.NewGame, { template, name: "Live Probe" });
      const checked = await call(GodotTool.Check);
      assert.deepEqual(checked.errors, [], JSON.stringify(checked));
      assert.equal(checked.ok, true);
      const seen = await call(GodotTool.Screenshot);
      assert.deepEqual(seen.shots, ["HeroCamera"]);
      const [image] = seen.images as Array<{ mimeType: string; data: string }>;
      assert.ok(image?.data.startsWith(PNG_SIGNATURE));
    });
  }

  it("names a broken script by file and line, runs a scene, and notes it at a checkpoint", async () => {
    const { project, call } = await liveGame();
    await call(GodotTool.NewGame, { template: "3d", name: "Live Probe" });
    await writeFile(path.join(project, "broken.gd"), 'extends Node\nfunc _ready():\n\tvar x: int = "no"\n');
    const checked = await call(GodotTool.Check);
    assert.equal(checked.ok, false);
    assert.ok(
      (checked.errors as string[]).some((line) => line.startsWith("broken.gd:3:")),
      JSON.stringify(checked),
    );
    const note = await call(GodotTool.CheckpointCheck, {}, { hook: { on: HookEvent.CheckpointBefore } });
    assert.match(String(note.note), /broken\.gd:3/);
    const ran = await call(GodotTool.RunScene, { seconds: 1 });
    assert.deepEqual(ran.errors, []);
  });

  it("plays a new game through the Play Protocol: the plugin's Godot runtime, confined with the GPU", async () => {
    const { game, call } = await liveGame();
    await call(GodotTool.NewGame, { template: "3d", name: "Live Probe" });
    const manifest = JSON.parse(await readFile("src/plugins/godot/plugin.json", "utf8"));
    const found = await new PluginNativeServices(os.tmpdir(), []).detect(manifest.nativeRuntimes[0], os.tmpdir());
    assert.equal(found.state, "ready", found.detail);
    const engine = (await readProjectShape(game)).play?.engine;
    assert.ok(engine && found.path);
    const scratch = await realpath(await tmpDir("studio-godot-play-"));
    const spawnEngine = async () => ({
      child: await spawnNativeLongLived({
        binary: found.path ?? "",
        args: engine.args,
        cwd: game,
        scratch,
        reads: [game],
        writes: [game],
        denyRead: [],
        gpu: true,
      }),
    });
    const sandbox = { spawnLongLived: () => Promise.reject(new Error("the engine runs instead")) };
    const launched = await launchGameBridge({ sandbox, command: "", cwd: game, spawn: spawnEngine });
    try {
      assert.equal(launched.target.hello?.protocol, 3);
      assert.ok(launched.target.hello?.capabilities.actions.includes("jump"), "the template's own actions");
      await launched.target.clock?.pause();
      const before = await launched.target.screenshot({ quality: 80, surface: CaptureSurface.Auto });
      await launched.target.act?.([{ action: "jump", state: "press" }]);
      await launched.target.clock?.step?.(300);
      const after = await launched.target.screenshot({ quality: 80, surface: CaptureSurface.Auto });
      assert.notDeepEqual(after.jpeg, before.jpeg, "the jump shows");
    } finally {
      await launched.stop();
    }
  });

  it("answers a game's play-time AI through the Play Protocol: by its rid, before the step that drains it", async () => {
    const { game, project, call } = await liveGame();
    await call(GodotTool.NewGame, { template: "2d", name: "Live Probe" });
    await useAiProbe(project);
    const fixture = fixtureNativeHost("live", { replaying: true });
    const launched = await launchGameBridge({
      sandbox: { spawnLongLived: () => Promise.reject(new Error("the engine runs instead")) },
      command: "",
      cwd: game,
      spawn: await godotRuntime(game),
      target: { ai: fixture.host },
    });
    try {
      assert.equal(launched.target.hello?.capabilities.ai, true, "a game with GenexAI declares ai");
      await launched.target.clock?.pause();
      await launched.target.clock?.step?.(1000);
      await launched.target.clock?.step?.(100);
      const asked = fixture.asked.filter(({ message }) => message.op === AiBridgeOp.Call);
      assert.equal(asked.length, 1, "the probe asked once");
      assert.equal(asked[0]?.caller.channel, `native:${launched.child.pid}`);
      const state = (await launched.client.call(PlayOp.State, {})) as {
        volatile: { ai: { asked: string[]; answered: string[] } };
      };
      assert.deepEqual(state.volatile.ai.answered, state.volatile.ai.asked, "every line answered by its rid");
      const drained = launched.client
        .stderrTail()
        .filter((line) => line.startsWith(PROBE_MARK))
        .map((line) => JSON.parse(line.slice(PROBE_MARK.length)));
      assert.deepEqual(drained, [["probe.move", true, { move: "left" }]]);
    } finally {
      await launched.stop();
    }
  });

  it("relays a game's play-time AI while it plays in the person's editor, through .godot/genex", async () => {
    const { project, call } = await liveGame();
    await call(GodotTool.NewGame, { template: "2d", name: "Live Probe" });
    await useAiProbe(project);
    const install = usableGodot(await findGodots(systemGodotEnv()));
    assert.ok(install);
    const folder = path.join(project, BRIDGE_FOLDER);
    await mkdir(folder, { recursive: true });
    // The editor plugin's heartbeat while a scene plays, as the person's editor writes it.
    const beat = () => writeFile(path.join(folder, "editor.json"), JSON.stringify({ at: Date.now(), playing: true }));
    await beat();
    const beating = setInterval(() => void beat(), EDITOR_BEAT_MS);
    const fixture = fixtureAiService();
    const relay = editorAiRelay(godotAiChannel(project, systemEditorEnv()), {
      service: fixture.service,
      game: { name: "live", title: "Live Probe" },
      place: { cwd: project, channel: "editor:godot:live" },
      agentPlaying: () => false,
      createRouteEnabled: () => true,
    });
    const stop = new AbortController();
    const relaying = runEditorAiRelay(relay, { signal: stop.signal });
    await relay.tick(stop.signal);
    // The game as the editor plays it: Godot's own binary on the project, no Play Protocol.
    const game = spawn(install.binary, ["--headless", "--path", project], { stdio: ["ignore", "ignore", "pipe"] });
    const exited = once(game, "exit");
    let stderr = "";
    game.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    try {
      for (let tries = 0; tries < EDITOR_START_TRIES && !stderr.includes(PROBE_MARK); tries++)
        await sleep(EDITOR_START_POLL_MS);
      const drained = stderr
        .split("\n")
        .filter((line) => line.startsWith(PROBE_MARK))
        .map((line) => JSON.parse(line.slice(PROBE_MARK.length)));
      assert.deepEqual(drained, [["probe.move", true, { move: "left" }]]);
      assert.equal(fixture.asked[0]?.caller.context, AiContext.CreateLive);
      assert.deepEqual(
        (await readdir(folder)).filter((name) => name.startsWith("ai-")),
        [AI_RELAY_BEAT],
        "every line and answer was taken",
      );
    } finally {
      clearInterval(beating);
      stop.abort();
      await relaying;
      game.kill();
      await exited;
    }
  });

  it("answers a game's play-time AI ai_off at once where nothing relays it, so it plays its fallbacks", async () => {
    const { project, call } = await liveGame();
    await call(GodotTool.NewGame, { template: "2d", name: "Live Probe" });
    await useAiProbe(project);
    const install = usableGodot(await findGodots(systemGodotEnv()));
    assert.ok(install);
    const game = spawn(install.binary, ["--headless", "--path", project], { stdio: ["ignore", "ignore", "pipe"] });
    const exited = once(game, "exit");
    let stderr = "";
    game.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    try {
      for (let tries = 0; tries < EDITOR_START_TRIES && !stderr.includes(PROBE_MARK); tries++)
        await sleep(EDITOR_START_POLL_MS);
      const drained = stderr
        .split("\n")
        .filter((line) => line.startsWith(PROBE_MARK))
        .map((line) => JSON.parse(line.slice(PROBE_MARK.length)));
      assert.deepEqual(drained, [["probe.move", false, null]]);
    } finally {
      game.kill();
      await exited;
    }
  });

  it("asks the person's own editor to save before a checkpoint and to reload after a restore", async () => {
    const { project, call } = await liveGame();
    await call(GodotTool.NewGame, { template: "2d", name: "Live Probe" });
    const install = usableGodot(await findGodots(systemGodotEnv()));
    assert.ok(install);
    // The person's editor, headless: the Genex addon's editor plugin runs in it as in a windowed one.
    const editor = spawn(install.binary, ["--headless", "--editor", "--path", project], { stdio: "ignore" });
    const exited = once(editor, "exit");
    try {
      let beat = null;
      for (let tries = 0; tries < EDITOR_START_TRIES && !beat; tries++) {
        await sleep(EDITOR_START_POLL_MS);
        beat = await liveEditor(project, systemEditorEnv());
      }
      assert.ok(beat, "the editor beats");
      assert.deepEqual(await call(GodotTool.SaveAll, {}, { hook: { on: HookEvent.CheckpointBefore } }), {});
      assert.deepEqual(await call(GodotTool.SaveAll, {}, { hook: { on: HookEvent.RestoreBefore } }), {});
      assert.deepEqual(await call(GodotTool.ReloadEditor, {}, { hook: { on: HookEvent.RestoreAfter } }), {});
    } finally {
      editor.kill();
      await exited;
    }
  });

  it("exports a new game for the web: Godot's page, its data and its engine in web/", async (t) => {
    const install = usableGodot(await findGodots(systemGodotEnv()));
    assert.ok(install);
    if (!(await hasWebTemplate(os.homedir(), install))) {
      t.skip(`no Web export template for Godot ${templateVersion(install.version)} on this Mac`);
      return;
    }
    const { game, call } = await liveGame();
    await call(GodotTool.NewGame, { template: "2d", name: "Live Probe" });
    assert.match(String(await call(GodotTool.WebExport)), /Exported the game for the web/);
    const files = await readdir(path.join(game, "web"));
    for (const file of ["index.html", "index.js", "index.wasm", "index.pck"]) assert.ok(files.includes(file), file);
    // The pack loads: its project settings were written whole (a sandbox that kept Godot from its
    // temporary file once made a pack whose settings were empty).
    const loaded = await run(install.binary, [
      "--headless",
      "--main-pack",
      path.join(game, "web", "index.pck"),
      "--quit-after",
      "2",
    ]);
    assert.doesNotMatch(`${loaded.stdout}\n${loaded.stderr}`, /Corrupted|Couldn't load project data/);
  });

  it("answers the installed version's API", async () => {
    const { call } = await liveGame();
    const api = String(await call(GodotTool.ClassReference, { query: "CharacterBody3D" }));
    assert.match(api, /^class CharacterBody3D extends PhysicsBody3D/);
    assert.match(api, /move_and_slide\(\) -> bool/);
  });
});
