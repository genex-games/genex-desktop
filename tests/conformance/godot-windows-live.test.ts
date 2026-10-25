/**
 * The Godot plugin on Windows for real, wired as the installed app wires it: its backend from a copy
 * of its package in the person's profile (where the app keeps plugin packages, which Genex's
 * sandbox user can't read), over a host whose `runtime.*` calls go to `PluginNativeServices` and
 * whose `sandbox.*` calls go to `PluginSandboxJobs` on a real `ProcessSandbox` (srt-win). The setup
 * card's Do it for me gets Godot (the manifest's pinned download, about 86 MB) and its Web template
 * (read out of Godot's templates archive by ranges, 10 MB), the agent is offered Godot, a new game
 * is made, imported, checked, run and photographed in the sandbox, the class reference is made, the
 * game is exported for the web, the Windows app templates are fetched for the agent's own shell,
 * the game's own launcher (`bin/play`) starts it for Genex's play under Git Bash in the sandbox,
 * and the person's editor opens the project and is found by its command line. Windows only, on a
 * machine whose sandbox is provisioned (the Windows CI job sets GENEX_WINDOWS_SANDBOX=ready), and
 * opt-in (`STUDIO_NETWORK_TESTS=1`): it reaches GitHub for Godot.
 */
import assert from "node:assert/strict";
import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import type { PluginContext, PluginScalar, PluginSetupCard } from "../../src/plugin-sdk/index.d.ts";
import { createGodotBackend } from "../../src/plugins/godot/backend.ts";
import { systemEditorEnv } from "../../src/plugins/godot/editor.ts";
import { systemGodotEnv } from "../../src/plugins/godot/find-godot.ts";
import { confinedRunner } from "../../src/plugins/godot/godot-run.ts";
import type { PluginBinding } from "../../src/shared/plugins.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { PluginNativeServices } from "../../src/substrate/plugins/native.ts";
import { PluginSandboxJobs } from "../../src/substrate/plugins/sandbox-jobs.ts";
import { killProcessTree } from "../../src/substrate/process-tree.ts";
import { ProcessSandbox } from "../../src/substrate/spawn.ts";
import { windowsProcesses } from "../../src/substrate/windows-processes.ts";
import { tmpDir } from "../helpers/tmp.ts";

const SKIP =
  (process.platform !== "win32" ||
    process.env.GENEX_WINDOWS_SANDBOX !== "ready" ||
    process.env.STUDIO_NETWORK_TESTS !== "1") &&
  "Windows with a provisioned sandbox and STUDIO_NETWORK_TESTS=1 only";
const PACKAGE = fileURLToPath(new URL("../../src/plugins/godot/", import.meta.url));
const PLUGIN = "godot";
/** Where the person's export templates for the pinned Godot are, in Godot's data folder (`%APPDATA%`). */
const TEMPLATES = path.join(process.env.APPDATA ?? "", "Godot", "export_templates", "4.7.2.stable");
/** How long an app export in the agent's shell may take. */
const EXPORT_MS = 240_000;
/** How long the launcher's game runs before it is stopped: long enough to say it is ready. */
const PLAY_MS = 45_000;
/** How long the editor may take to show up in the process list, and how often it is looked for. */
const EDITOR_WAIT_MS = 60_000;
const EDITOR_POLL_MS = 1_000;

type Answer = Record<string, unknown>;

let sandbox: ProcessSandbox;
let jobs: PluginSandboxJobs;
let call: (kind: "action" | "tool", name: string, args?: Record<string, PluginScalar>) => Promise<Answer>;
let game: string;

before(async () => {
  if (SKIP) return;
  const root = await tmpDir("gwin-live-");
  const runtimes = path.join(root, "native-runtimes");
  const work = path.join(root, "native-work");
  const storage = path.join(root, "storage");
  game = path.join(root, "AI Games", "Valley & Co");
  for (const dir of [runtimes, work, storage, game]) await mkdir(dir, { recursive: true });
  // Where the app keeps an installed plugin's package: the person's profile, never granted to the sandbox.
  const pack = path.join(root, "engine-homes", "plugins", "packages", PLUGIN, "installed");
  await cp(PACKAGE, pack, { recursive: true });
  const manifest = validateManifest(JSON.parse(await readFile(path.join(pack, "plugin.json"), "utf8")));
  const scratch = path.join(root, "scratch");
  sandbox = await ProcessSandbox.create({
    writableRoots: [game, work],
    scratchDir: scratch,
    secretPaths: [],
    readableRoots: [runtimes],
  });
  jobs = new PluginSandboxJobs({ run: (request) => sandbox.run(request), scratch: path.join(scratch, "plugin-jobs") });
  const native = new PluginNativeServices(root, [], {
    settings: async () => ({}),
    windows: { sandbox: () => sandbox, work, runtimes },
  });
  const backend = createGodotBackend({
    env: systemGodotEnv(),
    editor: systemEditorEnv(),
    run: confinedRunner(),
    scripts: path.join(pack, "scripts"),
    templates: path.join(pack, "templates"),
    addon: path.join(pack, "addon", "genex"),
    multiplayer: {
      addon: path.join(pack, "addon", "genex_multiplayer"),
      bridge: path.join(
        PACKAGE,
        "..",
        "..",
        "..",
        "node_modules",
        "@genex-ai",
        "multiplayer",
        "dist",
        "bridge.global.js",
      ),
      bridgeLicenses: path.join(pack, "multiplayer", "genex-multiplayer-bridge.LICENSES.md"),
      license: path.join(pack, "multiplayer", "COLYSEUS-LICENSE"),
    },
  });
  const binding: PluginBinding = { project: "valley", directory: game };
  call = async (kind, name, args = {}) => {
    const signal = new AbortController().signal;
    const invocation = { method: kind, name, signal };
    const host = (async (method: string, hostArgs?: unknown) => {
      if (method === "storage.root") return storage;
      if (method === "game.engine.steps") return true;
      if (method === "game.engine.read") return null;
      if (method.startsWith("sandbox.")) return jobs.call(PLUGIN, method, hostArgs, binding);
      if (method.startsWith("runtime."))
        return native.call(manifest, pack, storage, method, hostArgs, binding, invocation, () => {});
      throw new Error(`unexpected host call ${method}`);
    }) as PluginContext["host"];
    const context: PluginContext = { project: "valley", directory: game, signal, callId: 1, host };
    const answer =
      kind === "action" ? await backend.action?.(name, args, context) : await backend.tool?.(name, args, context);
    return answer as Answer;
  };
});

/** Ends every Godot this test started (the person's editor among them) and waits until none runs. */
async function endGodots(): Promise<void> {
  const ends = Date.now() + EDITOR_WAIT_MS;
  for (let rows = await windowsProcesses(["Godot%"]); rows?.length && Date.now() < ends; ) {
    for (const row of rows) await killProcessTree(row.pid);
    await sleep(EDITOR_POLL_MS);
    rows = await windowsProcesses(["Godot%"]);
  }
}

after(async () => {
  if (SKIP) return;
  await jobs?.stopAll();
  await endGodots();
  await sandbox?.dispose();
});

describe("Godot on Windows, for real", { skip: SKIP }, () => {
  it("gets Godot with the setup card's Do it for me, and the agent is offered it", async () => {
    const card = (await call("action", "steps")) as unknown as PluginSetupCard;
    assert.equal(card.open, true);
    assert.ok(card.primary, "the card has Do it for me");
    await call("action", card.primary.name);
    const status = await call("tool", "engine-status");
    assert.equal(status.ready, true, JSON.stringify(status));
    assert.equal(status.version, "4.7.2");
    assert.equal(((await call("action", "steps")) as unknown as PluginSetupCard).open, false);
    const web = path.join(TEMPLATES, "web_nothreads_release.zip");
    assert.ok((await stat(web)).size > 1_000_000, "Do it for me fetched the Web template");
  });

  it("answers the class reference before the game has a project, in a job folder of its own at the game's root", async () => {
    const answer = await call("tool", "class-reference", { query: "Node3D" });
    assert.match(String(answer), /class Node3D extends Node/);
    const own = (await readdir(game)).filter((name) => name.startsWith("genex-godot-job-"));
    assert.deepEqual(own, [], "its folder is gone with it, removed by the sandbox user's rd");
  });

  it("makes a new game, imported in the sandbox", async () => {
    const made = await call("tool", "new-game", { template: "3d", name: "Valley" });
    assert.match(String(made), /Made this game's Godot project/);
    assert.doesNotMatch(String(made), /first import didn't finish/);
    assert.ok(await stat(path.join(game, "godot", ".godot")));
  });

  it("checks the game in the sandbox", async () => {
    const checked = await call("tool", "check");
    assert.equal(checked.ok, true, JSON.stringify(checked));
    assert.match(String(checked.summary), /Loaded \d+ scripts, scenes and resources/);
  });

  it("runs the main scene in the sandbox", async () => {
    const ran = await call("tool", "run-scene", { seconds: 2 });
    assert.deepEqual(ran.errors, [], JSON.stringify(ran));
    assert.equal(ran.summary, undefined, JSON.stringify(ran));
  });

  it("takes a still of the hero camera in the sandbox", async () => {
    const shot = await call("tool", "screenshot");
    assert.deepEqual(shot.shots, ["HeroCamera"], JSON.stringify(shot.shots));
  });

  it("answers the installed Godot's class reference", async () => {
    const answer = await call("tool", "class-reference", { query: "Node3D" });
    assert.match(String(answer), /class Node3D extends Node/);
  });

  it("exports the game for the web in the sandbox with the Web template Do it for me fetched", async () => {
    const answer = await call("tool", "web-export");
    assert.match(String(answer), /Exported the game for the web/);
    assert.ok((await stat(path.join(game, "web", "index.pck"))).size > 0);
  });

  it("fetches the Windows app templates where the sandbox's Godot reads them, and exports the app with them", async () => {
    assert.match(String(await call("tool", "export-templates", { platforms: "windows" })), /are in place/);
    assert.ok((await stat(path.join(TEMPLATES, "windows_release_x86_64.exe"))).size > 1_000_000);
    const project = path.join(game, "godot");
    const presets = path.join(project, "export_presets.cfg");
    const current = await readFile(presets, "utf8");
    // Godot reads presets numbered from 0 with no gap: this one follows Genex's Web preset.
    const next = (current.match(/^\[preset\.\d+\]$/gm) ?? []).length;
    const preset = `[preset.${next}]\n\nname="Windows"\nplatform="Windows Desktop"\nrunnable=true\nexport_filter="all_resources"\nexport_path="../Builds/Windows/Valley.exe"\n\n[preset.${next}.options]\n\n`;
    await writeFile(presets, `${current}\n${preset}`);
    await mkdir(path.join(game, "Builds", "Windows"), { recursive: true });
    // What the agent's own shell runs, as the sandbox user: Godot finds the templates in that user's data folder.
    const godot = ((await call("action", "status")).godot as { binary: string }).binary.replaceAll("\\", "/");
    const exported = await sandbox.run({
      command: `'${godot}' --headless --path '${project.replaceAll("\\", "/")}' --export-release Windows '../Builds/Windows/Valley.exe'`,
      cwd: game,
      timeoutMs: EXPORT_MS,
    });
    const exe = await stat(path.join(game, "Builds", "Windows", "Valley.exe")).catch(() => null);
    assert.ok(exe && exe.size > 1_000_000, `${exported.stdout}\n${exported.stderr}`.slice(-3000));
  });

  it("starts the game for Genex's play with its launcher in the sandbox", async () => {
    const played = await sandbox.run({ command: "sh bin/play", cwd: game, timeoutMs: PLAY_MS });
    assert.match(played.stdout, /"event":\s*"ready"/, `${played.stdout}\n${played.stderr}`.slice(-3000));
  });

  it("removes every job's folder with the sandbox user's rd: none left in the project's .godot or at the game's root", async () => {
    // Each job above staged Genex's script or its output, so its folder held files only rd removes.
    const left = await readdir(path.join(game, "godot", ".godot", "genex-jobs")).catch(() => [] as string[]);
    assert.deepEqual(left, [], "the project's stages");
    const own = (await readdir(game)).filter((name) => name.startsWith("genex-godot-job-"));
    assert.deepEqual(own, [], "the game's own job folders");
  });

  it("opens the project in the person's Godot editor and finds it open", async () => {
    await call("action", "open-editor");
    const ends = Date.now() + EDITOR_WAIT_MS;
    let open = false;
    try {
      while (!open && Date.now() < ends) {
        open = (await call("action", "status")).editorOpen === true;
        if (!open) await sleep(EDITOR_POLL_MS);
      }
    } finally {
      // The editor holds the project folder open, which the test's folder removal waits on.
      await endGodots();
    }
    assert.equal(open, true);
  });
});
