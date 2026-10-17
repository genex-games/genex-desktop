/**
 * A game's engine record in its studio.json (`engine`, see `shared/game-engine.ts`), read and
 * written by real path. studio.json sits in the folder agents write, so a record is only believed
 * while its engine is one an installed plugin declares and its project file is still a regular file
 * of that engine's declared kind at exactly the path recorded: a link swapped in for the file or for
 * any folder on its way reads as no binding, and the game is a web game again until Genex links it
 * anew.
 */
import { lstat, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type EngineBinding,
  type EngineCatalog,
  type EngineDeclaration,
  type EngineId,
  type EngineRemote,
  isProjectPath,
  parseEngineBinding,
} from "../shared/game-engine.ts";
import { readJsonForUpdate, readJsonIfExists } from "./fsx.ts";

const STUDIO_JSON = "studio.json";

/** Why a project can't be linked, in words the agent or the panel shows as they are. */
export const EngineLinkErrorCode = {
  NotEngine: "not-engine",
  NotProject: "not-project",
  Missing: "missing",
  NotFile: "not-file",
} as const;
export type EngineLinkErrorCode = (typeof EngineLinkErrorCode)[keyof typeof EngineLinkErrorCode];

/** What a refusal names: the file asked for, and the engine it was asked for when there is one. */
type Refused = { file: string; engine?: Pick<EngineDeclaration, "label" | "projectFiles">; kind?: string };

/** "an Unreal", "a Toy": the article the label's first letter takes. */
const withArticle = (label: string) => `${/^[aeiou]/i.test(label) ? "an" : "a"} ${label}`;

const MESSAGE = {
  [EngineLinkErrorCode.NotEngine]: ({ kind }: Refused) => `No installed plugin builds games in "${kind ?? ""}".`,
  [EngineLinkErrorCode.NotProject]: ({ file, engine }: Refused) =>
    engine
      ? `${file} is not ${withArticle(engine.label)} project file (${engine.projectFiles.join(", ")}).`
      : `${file} is not a project file.`,
  [EngineLinkErrorCode.Missing]: ({ file }: Refused) => `${file} does not exist.`,
  [EngineLinkErrorCode.NotFile]: ({ file }: Refused) => `${file} is not a regular file.`,
} as const satisfies Record<EngineLinkErrorCode, (refused: Refused) => string>;

/** A refused link, with a code a caller can act on. */
export class EngineLinkError extends Error {
  readonly code: EngineLinkErrorCode;
  constructor(code: EngineLinkErrorCode, refused: Refused) {
    super(MESSAGE[code](refused));
    this.name = "EngineLinkError";
    this.code = code;
  }
}

/**
 * The real path of a project file of `engine`'s kind: absolute, plainly spelled, a regular file
 * with one of the engine's declared extensions once every link on the way is resolved. Throws
 * {@link EngineLinkError} otherwise.
 */
export async function projectFileOf(
  file: string,
  engine: Pick<EngineDeclaration, "label" | "projectFiles">,
): Promise<string> {
  const refuse = (code: EngineLinkErrorCode) => new EngineLinkError(code, { file, engine });
  if (!isProjectPath(file, engine.projectFiles)) throw refuse(EngineLinkErrorCode.NotProject);
  const real = await realpath(file).catch(() => undefined);
  if (!real) throw refuse(EngineLinkErrorCode.Missing);
  if (!isProjectPath(real, engine.projectFiles)) throw refuse(EngineLinkErrorCode.NotProject);
  const stat = await lstat(real);
  if (!stat.isFile()) throw refuse(EngineLinkErrorCode.NotFile);
  return real;
}

/**
 * Whether a recorded binding still holds: its engine is one `catalog` declares and its project is
 * still a regular file of that engine's kind at exactly that real path.
 */
export async function stillThere(binding: EngineBinding, catalog: EngineCatalog): Promise<boolean> {
  const engine = catalog.get(binding.kind);
  if (!engine) return false;
  const real = await projectFileOf(binding.project, engine).catch(() => undefined);
  return real === path.normalize(binding.project);
}

/**
 * The engine record of the game in `dir` among the engines `catalog` declares, or undefined when
 * it is a web game or the record no longer holds.
 */
export async function readEngineBinding(dir: string, catalog: EngineCatalog): Promise<EngineBinding | undefined> {
  const meta = await readJsonIfExists<{ engine?: unknown }>(path.join(dir, STUDIO_JSON)).catch(() => null);
  const binding = parseEngineBinding(meta?.engine, catalog);
  if (!binding) return undefined;
  return (await stillThere(binding, catalog)) ? binding : undefined;
}

/** When a link is made, and the published game's ids when the project lives at the engine's service. */
export type EngineBindingOptions = { now?: () => Date; remote?: EngineRemote };

/**
 * Links the game in `dir` to a project of the engine `kind` (one `catalog` declares): studio.json
 * gains `engine` with the project's real path, the time and the published game's ids. The rest of
 * studio.json is kept; one that does not parse is the user's to fix and is never replaced. Returns
 * the record and the one it replaced (of any engine `catalog` declares).
 */
export async function writeEngineBinding(
  dir: string,
  project: string,
  kind: EngineId,
  catalog: EngineCatalog,
  options: EngineBindingOptions = {},
): Promise<{ binding: EngineBinding; previous?: EngineBinding }> {
  const engine = catalog.get(kind);
  if (!engine) throw new EngineLinkError(EngineLinkErrorCode.NotEngine, { file: project, kind });
  const real = await projectFileOf(project, engine);
  const file = path.join(dir, STUDIO_JSON);
  const current = (await readJsonForUpdate<Record<string, unknown>>(file)) ?? {};
  const previous = parseEngineBinding(current.engine, catalog);
  const linkedAt = (options.now ?? (() => new Date()))().toISOString();
  const binding: EngineBinding = {
    kind,
    project: real,
    linkedAt,
    ...(options.remote ? { remote: options.remote } : {}),
  };
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
