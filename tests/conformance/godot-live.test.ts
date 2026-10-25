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
import { liveEditor } from "../../src/plugins/godot/editor-bridge.ts";
import { hasWebTemplate, templateVersion } from "../../src/plugins/godot/web-export.ts";
import { findGodots, systemGodotEnv, usableGodot } from "../../src/plugins/godot/find-godot.ts";
import { confinedRunner } from "../../src/plugins/godot/godot-run.ts";
import { launchGameBridge } from "../../src/main/core/game-bridge-target.ts";
import { HookEvent } from "../../src/shared/plugin-hooks.ts";
import { CaptureSurface } from "../../src/shared/preview-contract.ts";
import { PluginNativeServices } from "../../src/substrate/plugins/native.ts";
import { spawnNativeLongLived } from "../../src/substrate/plugins/native-process.ts";
import { readProjectShape } from "../../src/substrate/project-shape.ts";
import { ADDON, MULTIPLAYER, SCRIPTS, TEMPLATES } from "../helpers/godot-fake-engine.ts";
import { tmpDir } from "../helpers/tmp.ts";

const LIVE = process.env.STUDIO_GODOT_LIVE === "1";
const PNG_SIGNATURE = "iVBORw0KGgo";
/** A first import and a first capture compile shaders: generous for a cold Mac. */
const LIVE_TIMEOUT_MS = 5 * 60 * 1000;
const run = promisify(execFile);
/** How often, and how many times, the test looks for the editor's first heartbeat. */
const EDITOR_START_POLL_MS = 500;
const EDITOR_START_TRIES = 120;

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
    multiplayer: MULTIPLAYER,
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
