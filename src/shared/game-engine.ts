/**
 * Which engine a game builds in. A game is a web game unless Genex linked it to an engine project;
 * `studio.json` then records `engine`, and everything that would treat the game as a web page (the
 * chat brief, the preview health check, the Live tab, the Loop) asks this record first. Words
 * never decide it: a game asked for "in Unreal" in a web-template folder is still a web game until
 * linked.
 *
 * studio.json sits in the folder agents write, so this module only checks the record's shape;
 * `substrate/game-engine-binding.ts` checks the project file itself by its real path.
 */

import type { EnginePlayDeclaration } from "./engine-play.ts";

/** The engines a game can build in, by their wire names. */
export const GameEngine = { Web: "web", Unreal: "unreal", Godot: "godot" } as const;
export type GameEngine = (typeof GameEngine)[keyof typeof GameEngine];

const ENGINES: ReadonlySet<unknown> = new Set(Object.values(GameEngine));

/** Whether `value` names an engine Genex knows. */
export const isGameEngine = (value: unknown): value is GameEngine => ENGINES.has(value);

/** The extension of an Unreal project file. */
export const UPROJECT_EXTENSION = ".uproject";

/**
 * An engine's id: the id of the plugin that declares it (`engine.id`), so the host, not the
 * plugin, decides which engine a link names. Lowercase letters, digits and dashes, 2–40, a letter
 * first. `GameEngine` stays the closed vocabulary of skills' `engines`; this one is open.
 */
export const ENGINE_ID = /^[a-z][a-z0-9-]{1,39}$/;
export type EngineId = string;

/** Whether `value` is spelled as an engine id. */
export const isEngineId = (value: unknown): value is EngineId => typeof value === "string" && ENGINE_ID.test(value);

/** A project file's extension as an engine declares it: one or two dotted parts (`.uproject`, `.project.json`). */
export const PROJECT_FILE_EXTENSION = /^(\.[a-z0-9]{1,16}){1,2}$/;

/**
 * A project file's whole name as an engine declares it, for an engine whose project is a folder
 * marked by one fixed file (`project.godot`): a lowercase name and one or two dotted parts.
 */
export const PROJECT_FILE_NAME = /^[a-z0-9][a-z0-9_-]{0,39}(\.[a-z0-9]{1,16}){1,2}$/;

/** Whether `value` is a project file as an engine may declare it: an extension, or a whole file name. */
export const isProjectFileEntry = (value: unknown): value is string =>
  typeof value === "string" && (PROJECT_FILE_EXTENSION.test(value) || PROJECT_FILE_NAME.test(value));

/** Whether a declared project file is a whole file name (`project.godot`) rather than an extension. */
const isWholeName = (entry: string) => !entry.startsWith(".");

/** The last part of a path, by either separator. */
const baseName = (value: string) => value.split(/[\\/]/).pop() ?? value;

/**
 * The declared project file `file` is, of `entries`: a whole name it is named exactly, else the
 * longest extension it ends with, in any case. None when it is none of them.
 */
function ownEntry(file: string, entries: readonly string[]): string | undefined {
  const name = baseName(file);
  const whole = entries.find((entry) => isWholeName(entry) && name === entry);
  if (whole) return whole;
  const lower = name.toLowerCase();
  const extensions = entries.filter((entry) => !isWholeName(entry) && lower.endsWith(entry));
  return extensions.sort((a, b) => b.length - a.length)[0];
}

/** The apps an engine's editor runs as, which computer use never drives to build or play: Mac bundle ids, Windows `.exe` names. */
export interface EngineApps {
  mac?: string[];
  windows?: string[];
}

/**
 * The engine a `game-engine` plugin declares (`engine` in its manifest, API 3): its id (the
 * plugin's own), the name the person reads, the project files a game links, the fact a linked
 * game holds, whether the Loop needs the project inside the game folder (its save points hold it),
 * whether its agents change the project as files, what its editor can do in play, the apps its
 * editor runs as, and the apps its published games are played in.
 */
export interface EngineDeclaration {
  id: EngineId;
  /** 1–40 characters: "Unreal". */
  label: string;
  /** 1–4 extensions (`PROJECT_FILE_EXTENSION`) or whole file names (`PROJECT_FILE_NAME`), each once. */
  projectFiles: string[];
  /** A fact the plugin's `detect` declares, or one of Genex's own (`CoreFact`). */
  fact: string;
  projectInFolder: boolean;
  /**
   * Whether the engine's agents change the project as files (scenes and scripts), so a linked
   * project outside the game's folder is a folder its sessions read and write; one whose agents
   * change it only through its editor leaves it unreached.
   */
  writesProjectFiles?: boolean;
  play?: EnginePlayDeclaration;
  apps?: EngineApps;
  /** The apps the engine's games are played in by everyone (a live server): computer use never drives them, not even in a setup assist. */
  playerApps?: EngineApps;
}

/** The engines installed plugins declare, by id. */
export type EngineCatalog = ReadonlyMap<EngineId, EngineDeclaration>;

/**
 * What the app reads of a linked game's engine, as its plugin declares it, carried on the game's
 * descriptor: the name the person reads, the project files whose names it shows, and whether the
 * Loop needs the project inside the game folder.
 */
export interface LinkedEngine {
  label: string;
  projectFiles: string[];
  projectInFolder: boolean;
}

/** The part of an engine's declaration a linked game's descriptor carries. */
export const linkedEngineOf = ({ label, projectFiles, projectInFolder }: EngineDeclaration): LinkedEngine => ({
  label,
  projectFiles: [...projectFiles],
  projectInFolder,
});

/**
 * A published game's ids at its engine's service, kept beside a link when the project lives there
 * rather than in a file on this computer: decimal strings, never numbers, which would lose digits.
 */
export interface EngineRemote {
  placeId: string;
  universeId: string;
}

/** A positive decimal id of at most 20 digits, with no leading zero. */
const DECIMAL_ID = /^[1-9][0-9]{0,19}$/;

/** A published game's ids, by shape: both decimal ids, else none. */
export function parseEngineRemote(raw: unknown): EngineRemote | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const { placeId, universeId } = raw as Record<string, unknown>;
  const valid = typeof placeId === "string" && typeof universeId === "string";
  if (!valid || !DECIMAL_ID.test(placeId) || !DECIMAL_ID.test(universeId)) return undefined;
  return { placeId, universeId };
}

/**
 * A game linked to an engine project: the engine (an installed plugin's `engine.id`), the project
 * file (absolute, real path, of a kind that engine declares), when Genex linked it, and the
 * published game's ids when the project lives at the engine's service.
 */
export type EngineBinding = {
  kind: EngineId;
  project: string;
  linkedAt: string;
  remote?: EngineRemote;
};

/** The longest project path Genex records; Unreal itself refuses far shorter ones. */
const MAX_PROJECT_PATH = 1024;

const isAbsolute = (value: string) => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused.
const CONTROL = /[\0-\x1f\x7f]/;

/**
 * Whether `value` is an absolute path to one of an engine's declared project files (`entries`:
 * Unreal's `.uproject` when none are given), spelled plainly: no `..` part, no control characters.
 */
export function isProjectPath(value: unknown, entries: readonly string[] = [UPROJECT_EXTENSION]): value is string {
  if (typeof value !== "string" || !value || value.length > MAX_PROJECT_PATH) return false;
  if (!isAbsolute(value) || CONTROL.test(value)) return false;
  if (!ownEntry(value, entries)) return false;
  return !value.split(/[\\/]/).some((part) => part === "..");
}

/**
 * The binding a studio.json records, by shape: an engine `catalog` declares (the installed
 * plugins'), a plain absolute path to a project file of that engine's kind, a date, and the
 * published game's ids when they parse (ids of any other shape are dropped, the link stays).
 * Anything else, including a record for an engine no installed plugin declares, is no binding: the
 * game stays a web game.
 */
export function parseEngineBinding(raw: unknown, catalog: EngineCatalog): EngineBinding | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const engine = isEngineId(record.kind) ? catalog.get(record.kind) : undefined;
  if (!engine || !isProjectPath(record.project, engine.projectFiles)) return undefined;
  const linkedAt =
    typeof record.linkedAt === "string" && !Number.isNaN(Date.parse(record.linkedAt)) ? record.linkedAt : "";
  const remote = parseEngineRemote(record.remote);
  return { kind: engine.id, project: record.project, linkedAt, ...(remote ? { remote } : {}) };
}

/** Whether two links name the same published game: both name none, or both the same ids. */
export const sameRemote = (a: EngineRemote | undefined, b: EngineRemote | undefined): boolean =>
  a?.placeId === b?.placeId && a?.universeId === b?.universeId;

/** The engine a game builds in: its binding's, else the web. */
export const engineOf = (binding: EngineBinding | undefined | null): EngineId => binding?.kind ?? GameEngine.Web;

/**
 * Whether `kind` names an engine game: an engine id other than the web's. Everything that asks
 * whether a game is a web page asks this of its engine; only Unreal's own card, editor and words
 * ask for Unreal by name. The harness keeps a copy (`loop/engine-game.ts`).
 */
export const isEngineGame = (kind: unknown): kind is EngineId => isEngineId(kind) && kind !== GameEngine.Web;

/**
 * The project's name as its engine's project list shows it at a glance, by the engine's declared
 * project files (`entries`: Unreal's `.uproject` when none are given): a whole-name project file's
 * folder name (a Godot project's), else the file name without the longest extension it ends with.
 */
export function projectName(project: string, entries: readonly string[] = [UPROJECT_EXTENSION]): string {
  const parts = project.split(/[\\/]/).filter(Boolean);
  const file = parts.at(-1) ?? project;
  const own = ownEntry(project, entries);
  if (!own) return file;
  if (isWholeName(own)) return parts.at(-2) ?? file;
  return file.slice(0, file.length - own.length);
}

/**
 * The chat's record that a game now builds in an engine project ("Lantern now builds in Unreal ·
 * Lantern", with Undo): the plugin that linked it, the game, the engine and its label, the project
 * file and its name, when, and the project it replaced. `auto` marks a link the plugin made by itself rather
 * than at the person's word (older hosts linked a game at its first call; none does now). `setUp`
 * marks a link that also set its project up for Genex: its one Undo takes the set-up back first.
 */
export type EngineLinkedPayload = {
  pluginId?: string;
  project?: string;
  /** The game's title as studio.json named it then. */
  title?: string;
  /** The engine's id (`EngineBinding.kind`); none in records from before engines were declared, all Unreal's. */
  engine?: EngineId;
  /** The engine's name as its plugin declares it ("Unreal"). */
  label?: string;
  file?: string;
  name?: string;
  linkedAt?: string;
  previous?: string;
  auto?: boolean;
  /** The plugin set the project up for Genex to make this link (`game.engine.link {setUp}`). */
  setUp?: boolean;
};

/**
 * The chat's record that Undo took a link back: the link it undid, the project it restored (none:
 * a web game again), and the project whose set-up it also took back, by name.
 */
export type EngineLinkUndonePayload = {
  pluginId?: string;
  project?: string;
  linkedAt?: string;
  restored?: string;
  setUpUndone?: string;
  /** The project whose set-up Undo left in place, by name: another game's link still uses it. */
  setUpKept?: string;
};

/**
 * The actions the host itself runs on a `game-engine` plugin. Undo of a link that set its project
 * up (`setUp`) runs `UndoSetUp` with {@link EngineUndoSetUpArgs} before it takes the link back,
 * with no question: the chat's Undo is the person's word.
 */
export const EngineHostAction = { UndoSetUp: "undo-setup" } as const;
export type EngineHostAction = (typeof EngineHostAction)[keyof typeof EngineHostAction];

/**
 * What the host hands `EngineHostAction.UndoSetUp`: the linked project file by its real path, and
 * `ifSetUp`, which asks for nothing (not a refusal) when the project is no longer set up.
 */
export type EngineUndoSetUpArgs = { project: string; ifSetUp: true };

/** The chat line's Undo: which plugin's link of which game, made when, asked from which chat. */
export type EngineLinkUndo = { project: string; pluginId: string; linkedAt: string; threadId?: string };

/** The chat's record that an engine plugin offers its steps card here (its steps are read live from the plugin). */
export type EngineStepsPayload = { pluginId?: string; project?: string };
