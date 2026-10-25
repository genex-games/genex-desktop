import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PluginContext } from "../../src/plugin-sdk/index.d.ts";
import { createUnityBackend } from "../../src/plugins/unity/backend.ts";
import type { Launch } from "../../src/plugins/unity/editor-launch.ts";
import type { EditorsEnv, UnityEditor } from "../../src/plugins/unity/editors.ts";
import { tmpDir } from "./tmp.ts";
import {
  editorRow,
  fakeEditor,
  json,
  macEnv,
  pluginContext,
  processTable,
  type Reply,
  type Seen,
  STAND_IN,
  editor as standInEditor,
  writeDescriptor,
} from "./unity-editor-stand-in.ts";

export const NOW = () => new Date("2026-10-14T09:00:00.000Z");
/** Genex's Unity multiplayer package where the source keeps it. */
export const MULTIPLAYER_PACKAGE_SOURCE = path.resolve("src/plugins/unity/multiplayer/com.genex.multiplayer");
/** The editor's flag naming the project a launch opens. */
const PROJECT_FLAG = "-projectPath";
export const realTmp = async (prefix: string) => realpath(await tmpDir(prefix));
export const ready = () => json(200, { status: "ready" });
export const settling = () => json(200, { status: "settling" });
export const look = () => json(200, { status: "ready", playMode: "stopped" });
export const ok = (result: unknown = {}) => json(200, { success: true, result });
export const commandsSent = (seen: Seen[]) =>
  seen.map((request) => (request.body as { command?: string } | undefined)?.command).filter(Boolean);

/** A Mac with these Unity versions installed by Hub. */
export async function mac(versions: string[]): Promise<{ env: EditorsEnv; editors: UnityEditor[] }> {
  const env = await macEnv();
  const folder = path.join(env.applications, "Unity", "Hub", "Editor");
  const editors: UnityEditor[] = [];
  for (const version of versions)
    editors.push(await fakeEditor(folder, version, { "com.unity.modules.physics": null, "com.unity.ugui": "2.0.0" }));
  return { env, editors };
}

/** What a test may set for {@link backendOn}: whether an opened editor starts, the clock, and which signals end which process. */
export interface BackendOptions {
  starts?: boolean;
  now?: () => Date;
  ends?: Record<number, NodeJS.Signals[]>;
  /** How long since the person last touched the keyboard or pointer; ten minutes (nobody there) unless said. */
  idleMs?: () => number | undefined;
  /** The plugin's settings as the host reads them; none stored unless said. */
  settings?: Record<string, unknown>;
}

/**
 * The backend on a Mac with `versions` installed and a game folder. Opening an editor is recorded
 * and, as a starting Unity does, starts the project's editor process and writes its descriptor
 * (unless `starts` is false); the editor's server answers with `replies`.
 */
export async function backendOn(versions: string[], replies: Reply[] = [], options: BackendOptions = {}) {
  const { starts = true, now = NOW, ends, idleMs = () => 10 * 60_000, settings = {} } = options;
  const { env, editors } = await mac(versions);
  const table = processTable([], ends);
  const stand = standInEditor(replies, { alive: (pid) => table.running().includes(pid) });
  const launches: Launch[] = [];
  const game = await realTmp("unity-game-");
  const storage = await realTmp("unity-storage-");
  /** An editor that has `root` open, its descriptor on disk. */
  const openIn = async (root: string) => {
    table.start(editorRow(STAND_IN.pid, root));
    await writeDescriptor(root);
  };
  const backend = createUnityBackend({
    now,
    multiplayerPackage: MULTIPLAYER_PACKAGE_SOURCE,
    editors: env,
    pipeline: stand.deps,
    processes: table.env,
    idleMs: async () => idleMs(),
    open: async (launch) => {
      launches.push(launch);
      // Only a launch that names a project starts an editor: Unity Hub or a web page starts none.
      const flag = launch.args.indexOf(PROJECT_FLAG);
      const root = flag < 0 ? undefined : launch.args[flag + 1];
      if (starts && root) await openIn(root);
    },
  });
  const context = (binding: Partial<PluginContext> = { project: "lantern", directory: game }) =>
    pluginContext(storage, binding, settings);
  const call = (tool: string, binding?: Partial<PluginContext>) => backend.tool?.(tool, {}, context(binding));
  /** One of the panel's actions, with whatever arguments a panel sends. */
  const act = (action: string, args: Record<string, unknown> = {}, binding?: Partial<PluginContext>) =>
    backend.action?.(action, args, context(binding));
  return { backend, call, act, context, env, game, storage, editors, launches, table, openIn, ...stand };
}

/** A game whose folder holds an existing Unity project saved with `version`, with this manifest. */
export async function withProject(game: string, version: string, dependencies: Record<string, string> = {}) {
  const root = path.join(game, "unity");
  await mkdir(path.join(root, "ProjectSettings"), { recursive: true });
  await mkdir(path.join(root, "Packages"));
  await writeFile(path.join(root, "ProjectSettings", "ProjectVersion.txt"), `m_EditorVersion: ${version}\n`);
  await writeFile(path.join(root, "Packages", "manifest.json"), `${JSON.stringify({ dependencies }, null, 2)}\n`);
  return root;
}

export const manifestOf = async (root: string) =>
  JSON.parse(await readFile(path.join(root, "Packages", "manifest.json"), "utf8"));
