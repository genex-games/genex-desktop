/**
 * The Godot project a game builds in: the one its engine link names (`game.engine.read`, kind
 * `godot`: a project chosen in the panel, wherever it is on this Mac), else the one in its own
 * folder (`game-project.ts`). Linking (`game.engine.link`) records a chosen project's
 * `project.godot` by its real path; the host keeps the record, its chat line and its Undo.
 */
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { PluginContext } from "../../plugin-sdk/index.d.ts";
import { isInside } from "../../substrate/paths.ts";
import { findGameProject, PROJECT_FILE, ProjectError } from "./game-project.ts";

/** The host services of a game's engine link. */
export const LinkService = { Read: "game.engine.read", Link: "game.engine.link" } as const;
/** The engine a Godot link names. */
const GODOT_KIND = "godot";

const MESSAGE = {
  NoGame: "Open a game in Genex first: a Godot project is a game's.",
  NoProject:
    "This game has no Godot project (project.godot) yet. Make one with godot__new-game, or open a folder that has one.",
  NotProject: (folder: string) => `${folder} isn't a Godot project folder (it has no project.godot).`,
} as const;

/** The folder of the Godot project the game is linked to, by its real path; null without one (or one no longer there). */
export async function linkedProject(context: PluginContext): Promise<string | null> {
  if (!context.project) return null;
  const link = await context.host(LinkService.Read).catch(() => null);
  if (link?.kind !== GODOT_KIND) return null;
  if (!(await lstat(link.project).catch(() => null))?.isFile()) return null;
  return realpath(path.dirname(link.project)).catch(() => null);
}

/** The game's Godot project: its link's, else the one in its folder; null outside a game or without one. */
export async function projectOf(context: PluginContext): Promise<string | null> {
  const linked = await linkedProject(context);
  if (linked) return linked;
  return context.directory ? findGameProject(context.directory) : null;
}

/** The game's Godot project, or why there is none: no game bound, or no project for it. */
export async function requireProject(context: PluginContext): Promise<string> {
  if (!context.directory) throw new ProjectError(MESSAGE.NoGame);
  const project = await projectOf(context);
  if (!project) throw new ProjectError(MESSAGE.NoProject);
  return project;
}

/** Whether the project lies outside the game's folder (a linked project elsewhere on this Mac). */
export async function outsideGame(gameDir: string, project: string): Promise<boolean> {
  const root = await realpath(gameDir).catch(() => path.resolve(gameDir));
  return root !== project && !isInside(root, project);
}

/** Links the calling game to the Godot project in `folder` (its real `project.godot`); refused unless it is one. */
export async function linkProject(context: PluginContext, folder: string): Promise<string> {
  if (!context.project) throw new ProjectError(MESSAGE.NoGame);
  const settings = path.join(folder, PROJECT_FILE);
  if (!path.isAbsolute(folder) || !(await lstat(settings).catch(() => null))?.isFile())
    throw new ProjectError(MESSAGE.NotProject(folder));
  await context.host(LinkService.Link, { project: await realpath(settings) });
  return realpath(folder);
}
