/**
 * New Godot game: a small project from one of Genex's templates (2D or 3D, each a player that moves
 * and a camera in the `genex_shot` group, so stills work from the first turn) in the game's
 * `godot/` folder, where checkpoints and Rewind cover it. The game folder is the person's: nothing
 * is written through a link, nothing that is there is replaced, and a step that fails takes back
 * only the folder it made.
 */
import { cp, lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { GAME_PROJECT_FOLDER, PROJECT_FILE } from "./game-project.ts";

/** The templates New Godot game offers. Never rename a value: agents and the panel send them. */
export const GodotTemplate = { TwoD: "2d", ThreeD: "3d" } as const;
export type GodotTemplate = (typeof GodotTemplate)[keyof typeof GodotTemplate];

/** A game's name as Godot shows it: letters, digits, spaces, dashes and underscores, at most 40. */
const GAME_NAME = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/;
const NAME_MARK = "{{NAME}}";

const MESSAGE = {
  BadTemplate: (asked: string) => `There is no Godot template "${asked}". Choose 2d or 3d.`,
  BadName:
    "A Godot game's name is 1 to 40 letters, digits, spaces, dashes or underscores, starting with a letter or digit.",
  HasProject: "This game already has a Godot project, so New Godot game won't make another one here.",
  FolderTaken: "This game already has a godot folder, so New Godot game can't make its project there.",
} as const;

/** Why New Godot game refused: the words the agent or the panel shows. */
export class NewProjectError extends Error {}

const TEMPLATES: ReadonlySet<string> = new Set(Object.values(GodotTemplate));
const isTemplate = (value: string): value is GodotTemplate => TEMPLATES.has(value);

/** A template and a name as asked, checked: the template one Genex ships, the name one Godot shows as is. */
export function checkRequest(template: string, name: string): { template: GodotTemplate; name: string } {
  const asked = template.trim().toLowerCase();
  if (!isTemplate(asked)) throw new NewProjectError(MESSAGE.BadTemplate(template.trim()));
  const trimmed = name.trim();
  if (!GAME_NAME.test(trimmed)) throw new NewProjectError(MESSAGE.BadName);
  return { template: asked, name: trimmed };
}

/** Refuses a game that already is a Godot project at its root or has anything at `godot`. */
async function assertGameFree(game: string): Promise<void> {
  if (await lstat(path.join(game, PROJECT_FILE)).catch(() => null)) throw new NewProjectError(MESSAGE.HasProject);
  if (await lstat(path.join(game, GAME_PROJECT_FOLDER)).catch(() => null))
    throw new NewProjectError(MESSAGE.FolderTaken);
}

/** `project.godot` with the game's name in it; a quote can't be in a checked name, so the file stays Godot's. */
async function nameProject(folder: string, name: string): Promise<void> {
  const file = path.join(folder, PROJECT_FILE);
  await writeFile(file, (await readFile(file, "utf8")).replaceAll(NAME_MARK, name));
}

/** The template's files into the fresh folder, each refused rather than written over. */
async function copyTemplate(from: string, folder: string): Promise<void> {
  for (const entry of await readdir(from))
    await cp(path.join(from, entry), path.join(folder, entry), { recursive: true, errorOnExist: true, force: false });
}

/**
 * Makes the game's Godot project from `template` in `<game>/godot/`, named `name`, and answers its
 * folder's real path. `templates` is the folder of Genex's shipped templates.
 */
export async function createProject(
  gameDir: string,
  request: { template: string; name: string },
  templates: string,
): Promise<string> {
  const { template, name } = checkRequest(request.template, request.name);
  const game = await realpath(gameDir);
  await assertGameFree(game);
  const folder = path.join(game, GAME_PROJECT_FOLDER);
  // Not recursive: a folder that appeared since the check is refused, never written into.
  await mkdir(folder).catch(() => {
    throw new NewProjectError(MESSAGE.FolderTaken);
  });
  try {
    await copyTemplate(path.join(templates, template), folder);
    await nameProject(folder, name);
    return folder;
  } catch (error) {
    await rm(folder, { recursive: true, force: true });
    throw error;
  }
}
