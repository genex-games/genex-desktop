/**
 * The project fixtures (`tests/fixtures/projects/`) and the toy engine plugin
 * (`tests/fixtures/toy-engine-plugin/`), ready to use: a project copied into a test's own folder
 * with the files its engine writes while it runs, structural reads of a game's facts, a fake
 * harness ctx whose game calls reach a real core, and a registry with the toy plugin installed.
 */
import { cp, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { PluginSourceKind } from "../../src/shared/plugins.ts";
import { PluginRegistry } from "../../src/substrate/plugins/registry.ts";
import type { CoreLite } from "./core-lite.ts";
import { type CtxHandler, type CtxRecorder, ctxRecorder } from "./ctx-recorder.ts";
import { PLUGIN_SDK_BACKEND } from "./plugins.ts";
import { closeBeforeCleanup, tmpDir } from "./tmp.ts";

const FIXTURES = path.resolve(import.meta.dirname, "../fixtures");

/** The folder holding every project fixture. */
export const PROJECTS = path.join(FIXTURES, "projects");

/** The toy engine plugin's package folder. */
export const TOY_PLUGIN = path.join(FIXTURES, "toy-engine-plugin");

/** The toy engine plugin's id. */
export const TOY_PLUGIN_ID = "toy-engine";

/** The project fixtures by folder name. */
export const Project = {
  GodotGame: "godot-game",
  BlenderAssets: "blender-assets",
  WebFolder: "web-folder",
  UnrealGame: "unreal-game",
  UnrealPluginSource: "unreal-plugin-src",
  UnrealAndSite: "unreal-and-site",
  ToyProject: "toy-project",
} as const;
export type Project = (typeof Project)[keyof typeof Project];

/**
 * The files each project's engine writes while it runs: never committed as fixtures, so a test
 * sees them only in its own copy, the way a person's folder has them.
 */
const RUNTIME_FILES: Partial<Record<Project, Record<string, string>>> = {
  [Project.GodotGame]: { ".godot/imported/icon.ctex": "GST2 imported texture\n" },
  [Project.BlenderAssets]: { "props/crate.blend1": "BLENDER-v400 crate backup\n" },
  [Project.UnrealGame]: { "Saved/Logs/Lantern.log": "LogInit: Display: Engine started\n", "Intermediate/x": "x\n" },
  [Project.ToyProject]: { "Cache/x": "x\n" },
};

/** Copy one project fixture into `into/<name>`, add its runtime-only files, and answer the copy's real path. */
export async function copyProject(name: Project, into: string): Promise<string> {
  const dir = path.join(into, name);
  await cp(path.join(PROJECTS, name), dir, { recursive: true });
  for (const [file, text] of Object.entries(RUNTIME_FILES[name] ?? {})) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), text);
  }
  return realpath(dir);
}

/** A fact as a listed game may carry it: an id and the folder, relative to the game, it was found at. */
interface FactRead {
  id: string;
  path?: string;
}

/** A game's facts, read structurally: the field does not exist until facts are recorded. */
function factsOf(game: object): FactRead[] {
  const facts = (game as { facts?: unknown }).facts;
  return Array.isArray(facts) ? (facts as FactRead[]) : [];
}

/** The ids of a game's facts, sorted; empty for a game that records none. */
export function factIds(game: object): string[] {
  return [...new Set(factsOf(game).map((fact) => fact.id))].sort();
}

/** The folders (relative to the game, `.` for its root) where a game has the fact `id`, sorted. */
export function factsAt(game: object, id: string): string[] {
  return factsOf(game)
    .filter((fact) => fact.id === id)
    .map((fact) => fact.path || ".")
    .sort();
}

/**
 * A recorder whose `game.*` calls reach the real core's harness table (`lite.api()`), so a turn
 * reads the game the core really lists; every other method is answered by `overrides` (which also
 * win over the core for a `game.*` method), and anything else answers null.
 */
export function liteHost(lite: CoreLite, overrides: Record<string, CtxHandler> = {}): CtxRecorder {
  const api = lite.api() as unknown as Record<string, ((params: unknown) => unknown) | undefined>;
  const passThrough: Record<string, CtxHandler> = {};
  for (const [method, handler] of Object.entries(api)) {
    if (method.startsWith("game.") && handler) passThrough[method] = (params) => handler(params);
  }
  return ctxRecorder({ unknown: { value: null }, handlers: { ...passThrough, ...overrides } });
}

/** A registry in a temp folder with no bundled plugins and the toy engine plugin loaded from its folder as a local plugin. */
export async function toyRegistry(): Promise<PluginRegistry> {
  const root = await tmpDir("studio-toy-registry-");
  const seeds = path.join(root, "seeds");
  await mkdir(seeds);
  const registry = new PluginRegistry(path.join(root, "installed"), seeds, PLUGIN_SDK_BACKEND, async () => null);
  closeBeforeCleanup(async () => registry.cancel());
  await registry.init();
  await registry.installLocal(TOY_PLUGIN, PluginSourceKind.Local);
  return registry;
}
