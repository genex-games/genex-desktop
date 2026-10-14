/**
 * A game's engine record in its studio.json (`engine`, see `shared/game-engine.ts`), read and
 * written by real path. studio.json sits in the folder agents write, so a record is only believed
 * while its project file is still a regular `.uproject` at exactly the path recorded: a link swapped
 * in for the file or for any folder on its way reads as no binding, and the game is a web game
 * again until Genex links it anew.
 */
import { lstat, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { type EngineBinding, GameEngine, isProjectPath, parseEngineBinding } from "../shared/game-engine.ts";
import { readJsonForUpdate } from "./fsx.ts";
import { readStudioRecord } from "./project-facts.ts";

const STUDIO_JSON = "studio.json";

/** Why a project can't be linked, in words the agent or the panel shows as they are. */
export const EngineLinkErrorCode = {
  NotProject: "not-project",
  Missing: "missing",
  NotFile: "not-file",
} as const;
export type EngineLinkErrorCode = (typeof EngineLinkErrorCode)[keyof typeof EngineLinkErrorCode];

const MESSAGE = {
  [EngineLinkErrorCode.NotProject]: (file: string) => `${file} is not an Unreal project file (.uproject).`,
  [EngineLinkErrorCode.Missing]: (file: string) => `${file} does not exist.`,
  [EngineLinkErrorCode.NotFile]: (file: string) => `${file} is not a regular file.`,
} as const satisfies Record<EngineLinkErrorCode, (file: string) => string>;

/** A refused link, with a code a caller can act on. */
export class EngineLinkError extends Error {
  readonly code: EngineLinkErrorCode;
  constructor(code: EngineLinkErrorCode, file: string) {
    super(MESSAGE[code](file));
    this.name = "EngineLinkError";
    this.code = code;
  }
}

/**
 * The real path of an Unreal project file: absolute, plainly spelled, a regular `.uproject` file
 * once every link on the way is resolved. Throws {@link EngineLinkError} otherwise.
 */
export async function projectFileOf(file: string): Promise<string> {
  if (!isProjectPath(file)) throw new EngineLinkError(EngineLinkErrorCode.NotProject, file);
  const real = await realpath(file).catch(() => undefined);
  if (!real) throw new EngineLinkError(EngineLinkErrorCode.Missing, file);
  if (!isProjectPath(real)) throw new EngineLinkError(EngineLinkErrorCode.NotProject, file);
  const stat = await lstat(real);
  if (!stat.isFile()) throw new EngineLinkError(EngineLinkErrorCode.NotFile, file);
  return real;
}

/** Whether a recorded project is still a regular `.uproject` at exactly that real path. */
async function stillThere(project: string): Promise<boolean> {
  const real = await projectFileOf(project).catch(() => undefined);
  return real === path.normalize(project);
}

/** The engine record of the game in `dir`, or undefined when it is a web game or the record no longer holds. */
export async function readEngineBinding(dir: string): Promise<EngineBinding | undefined> {
  const binding = parseEngineBinding((await readStudioRecord(dir))?.engine);
  if (!binding) return undefined;
  return (await stillThere(binding.project)) ? binding : undefined;
}

/**
 * Links the game in `dir` to an Unreal project: studio.json gains `engine` with the project's real
 * path and the time. The rest of studio.json is kept; one that does not parse is the user's to fix
 * and is never replaced. Returns the record and the one it replaced.
 */
export async function writeEngineBinding(
  dir: string,
  project: string,
  now: () => Date = () => new Date(),
): Promise<{ binding: EngineBinding; previous?: EngineBinding }> {
  const real = await projectFileOf(project);
  const file = path.join(dir, STUDIO_JSON);
  const current = (await readJsonForUpdate<Record<string, unknown>>(file)) ?? {};
  const previous = parseEngineBinding(current.engine);
  const binding: EngineBinding = { kind: GameEngine.Unreal, project: real, linkedAt: now().toISOString() };
  await writeFile(file, `${JSON.stringify({ ...current, engine: binding }, null, 2)}\n`);
  return { binding, ...(previous ? { previous } : {}) };
}

/**
 * Puts back the record a link replaced: `previous` again, or no engine at all (the game is a web
 * game again). Used by Undo; nothing else in studio.json changes.
 */
export async function restoreEngineBinding(dir: string, previous: EngineBinding | undefined): Promise<void> {
  const file = path.join(dir, STUDIO_JSON);
  const current = await readJsonForUpdate<Record<string, unknown>>(file);
  if (!current) return;
  const { engine: _dropped, ...rest } = current;
  const next = previous ? { ...rest, engine: previous } : rest;
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`);
}
