/**
 * A plugin manifest's `engine` section (API 3, capability `game-engine`): the engine the plugin
 * declares (`shared/game-engine.ts`). Its id is the plugin's own and never the web's, so a plugin
 * cannot speak for another engine; its fact is one the plugin detects or one Genex knows; its apps
 * are names, never paths. Checked here and kept in canonical form.
 */
import { ClockLevel } from "../../shared/computer-target.ts";
import { type EnginePlayDeclaration, MAX_PLAY_PLAYERS } from "../../shared/engine-play.ts";
import {
  type EngineApps,
  type EngineDeclaration,
  GameEngine,
  isEngineId,
  isProjectFileEntry,
} from "../../shared/game-engine.ts";
import { PluginCapability, type PluginManifest } from "../../shared/plugins.ts";
import { CoreFact, isFactId } from "../../shared/project-facts.ts";

/** How much one declaration may say. */
const LIMIT = { LabelChars: 40, ProjectFiles: 4, Apps: 4, BundleIdChars: 155, ExeChars: 64 } as const;

/** A Mac bundle id in reverse-DNS form: two or more dotted parts of letters, digits and dashes. */
const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
/** A Windows program's file name: a name of its own (spaces inside allowed) ending in `.exe`, never a path. */
const EXE_NAME = /^[A-Za-z0-9_-]([A-Za-z0-9 ._-]*[A-Za-z0-9_-])?\.exe$/i;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused.
const CONTROL = /[\0-\x1f\x7f]/;
const CORE_FACTS: ReadonlySet<unknown> = new Set(Object.values(CoreFact));
const CLOCK_LEVELS: ReadonlySet<unknown> = new Set(Object.values(ClockLevel));

/** What a publisher reads when `engine` is refused. */
const MESSAGE = {
  NeedsApi3: "engine requires apiVersion 3",
  NeedsCapability: "engine requires the game-engine capability",
  NotObject: "Invalid engine (an object with id, label, projectFiles, fact and projectInFolder)",
  InvalidId: "Invalid engine id: it is the plugin's own id, 2-40 lowercase letters, digits and dashes",
  WebId: "Invalid engine id: web is Genex's own engine",
  InvalidLabel: `Invalid engine label (1-${LIMIT.LabelChars} characters on one line, no outer spaces)`,
  InvalidProjectFiles: `Invalid engine projectFiles (1-${LIMIT.ProjectFiles} distinct extensions of one or two lowercase dotted parts, such as .uproject or .project.json, or whole lowercase file names such as project.godot)`,
  InvalidFact: "Invalid engine fact (one the plugin's detect declares, or one of Genex's own; never web-game)",
  InvalidProjectInFolder:
    "Invalid engine projectInFolder (true when the Loop needs the project inside the game folder)",
  InvalidWritesProjectFiles:
    "Invalid engine writesProjectFiles (true when the engine's agents change the project as files)",
  InvalidPlay: `Invalid engine play (an object with optional players 1-${MAX_PLAY_PLAYERS}, clock ${[...CLOCK_LEVELS].join("|")}, pointer and state booleans)`,
  InvalidApps: `Invalid engine apps (mac: 1-${LIMIT.Apps} distinct bundle ids such as com.example.Editor; windows: 1-${LIMIT.Apps} distinct .exe names, never paths)`,
  InvalidPlayerApps: `Invalid engine playerApps (mac: 1-${LIMIT.Apps} distinct bundle ids such as com.example.Player; windows: 1-${LIMIT.Apps} distinct .exe names, never paths)`,
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const isOptional = (value: unknown, valid: (v: unknown) => boolean) => value === undefined || valid(value);
const isBoolean = (value: unknown) => typeof value === "boolean";

/** Whether every entry is distinct and passes `valid`, with `min` to `max` of them. */
function isDistinctList(value: unknown, min: number, max: number, valid: (entry: unknown) => boolean): boolean {
  if (!Array.isArray(value) || value.length < min || value.length > max) return false;
  return value.every(valid) && new Set(value).size === value.length;
}

const isLabel = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= LIMIT.LabelChars &&
  value.trim() === value &&
  !CONTROL.test(value);
const isBundleId = (value: unknown) =>
  typeof value === "string" && value.length <= LIMIT.BundleIdChars && BUNDLE_ID.test(value);
const isExeName = (value: unknown) =>
  typeof value === "string" && value.length <= LIMIT.ExeChars && EXE_NAME.test(value);
const isPlayers = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_PLAY_PLAYERS;

/** The declaration's fact: a fact id the plugin's own `detect` declares, or a core fact other than the web game's. */
function isEngineFact(fact: unknown, m: Pick<PluginManifest, "detect">): fact is string {
  if (!isFactId(fact) || fact === CoreFact.WebGame) return false;
  return CORE_FACTS.has(fact) || (m.detect ?? []).some((rule) => rule.fact === fact);
}

/** What the editor can do in play, in canonical form: known fields only, in a fixed order. */
function enginePlay(raw: unknown): EnginePlayDeclaration {
  const valid =
    isRecord(raw) &&
    isOptional(raw.players, isPlayers) &&
    isOptional(raw.clock, (clock) => CLOCK_LEVELS.has(clock)) &&
    isOptional(raw.pointer, isBoolean) &&
    isOptional(raw.state, isBoolean);
  if (!valid) throw new Error(MESSAGE.InvalidPlay);
  const play: EnginePlayDeclaration = {};
  if (raw.players !== undefined) play.players = raw.players as number;
  if (raw.clock !== undefined) play.clock = raw.clock as ClockLevel;
  if (raw.pointer !== undefined) play.pointer = raw.pointer as boolean;
  if (raw.state !== undefined) play.state = raw.state as boolean;
  return play;
}

/** A list of apps, in canonical form: Mac bundle ids, then Windows program names; `refusal` names the field. */
function engineApps(raw: unknown, refusal: string): EngineApps {
  const valid =
    isRecord(raw) &&
    isOptional(raw.mac, (mac) => isDistinctList(mac, 1, LIMIT.Apps, isBundleId)) &&
    isOptional(raw.windows, (windows) => isDistinctList(windows, 1, LIMIT.Apps, isExeName));
  if (!valid) throw new Error(refusal);
  const apps: EngineApps = {};
  if (raw.mac !== undefined) apps.mac = [...(raw.mac as string[])];
  if (raw.windows !== undefined) apps.windows = [...(raw.windows as string[])];
  return apps;
}

/** The declaration's id: the plugin's own, an engine id, and never the web's. */
function assertEngineId(value: unknown, pluginId: string): asserts value is string {
  if (value === GameEngine.Web) throw new Error(MESSAGE.WebId);
  if (!isEngineId(value) || value !== pluginId) throw new Error(MESSAGE.InvalidId);
}

/** The manifest's `engine` in canonical form; throws on API 1 or 2, without `game-engine`, or on any bad field. */
export function validateEngine(
  m: Pick<PluginManifest, "apiVersion" | "id" | "capabilities" | "engine" | "detect">,
): EngineDeclaration {
  if (m.apiVersion !== 3) throw new Error(MESSAGE.NeedsApi3);
  if (!m.capabilities.includes(PluginCapability.GameEngine)) throw new Error(MESSAGE.NeedsCapability);
  const raw: unknown = m.engine;
  if (!isRecord(raw)) throw new Error(MESSAGE.NotObject);
  assertEngineId(raw.id, m.id);
  if (!isLabel(raw.label)) throw new Error(MESSAGE.InvalidLabel);
  if (!isDistinctList(raw.projectFiles, 1, LIMIT.ProjectFiles, isProjectFileEntry))
    throw new Error(MESSAGE.InvalidProjectFiles);
  if (!isEngineFact(raw.fact, m)) throw new Error(MESSAGE.InvalidFact);
  if (!isBoolean(raw.projectInFolder)) throw new Error(MESSAGE.InvalidProjectInFolder);
  if (!isOptional(raw.writesProjectFiles, isBoolean)) throw new Error(MESSAGE.InvalidWritesProjectFiles);
  const engine: EngineDeclaration = {
    id: raw.id,
    label: raw.label,
    projectFiles: [...(raw.projectFiles as string[])],
    fact: raw.fact,
    projectInFolder: raw.projectInFolder as boolean,
  };
  if (raw.writesProjectFiles === true) engine.writesProjectFiles = true;
  if (raw.play !== undefined) engine.play = enginePlay(raw.play);
  if (raw.apps !== undefined) engine.apps = engineApps(raw.apps, MESSAGE.InvalidApps);
  if (raw.playerApps !== undefined) engine.playerApps = engineApps(raw.playerApps, MESSAGE.InvalidPlayerApps);
  return engine;
}
