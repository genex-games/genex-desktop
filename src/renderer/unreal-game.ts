/**
 * What the app shows differently for a game linked to an Unreal project (`shared/game-engine.ts`):
 * the Live tab's Unreal card in place of the web page, Rewind's note when the project lives
 * outside the game folder, and the bundled plugin that opens the editor. Pure, so each rule is
 * tested without a DOM.
 */
import { engineLoopGate, engineProjectInFolder, engineRewindNote } from "./engine-game.ts";
import { GameEngine, engineOf } from "../shared/game-engine.ts";
import type { GameProject } from "../shared/game-project.ts";
import { UNREAL_PLUGIN_ID } from "../shared/observers.ts";
import type { PluginInfo } from "../shared/plugins.ts";
import { UNREAL_WORDS } from "./words.ts";

/** The bundled Unreal plugin's id, re-exported for the renderer's readers (`shared/observers.ts`). */
export { UNREAL_PLUGIN_ID };

/** The Unreal plugin's actions the app presses itself, by their manifest names. */
export const UnrealPluginAction = {
  OpenEditor: "open-editor",
  QuitEditor: "quit-editor",
  Setup: "setup",
  StageStatus: "stage-status",
} as const;
export type UnrealPluginAction = (typeof UnrealPluginAction)[keyof typeof UnrealPluginAction];

/**
 * The step the plugin's `stage-status` names for the game's own project, as its panel names it
 * (the backend's `PanelStep`). Wire values: never rename.
 */
export const UnrealStageStep = {
  GetUnreal: "get-unreal",
  Choose: "choose",
  QuitFirst: "quit-first",
  SetUp: "set-up",
  Open: "open",
  Starting: "starting",
  Connected: "connected",
  Switch: "switch",
  NotAnswering: "not-answering",
  PortBlocked: "port-blocked",
  OpenWhenFree: "open-when-free",
  Crashed: "crashed",
} as const;
export type UnrealStageStep = (typeof UnrealStageStep)[keyof typeof UnrealStageStep];

/** A run going now that is using Unreal, as `stage-status` names it: its game's title, its project, and whether it is this game's. */
export type UnrealBusyRun = { title: string; project: string; here: boolean };

/**
 * The plugin's `stage-status` answer: the step, the game's project, since when it opens, the other
 * set-up project Unreal has open, what holds Unreal by name when known, how many editors run, the
 * run using Unreal, whether this is the project's first start, and whether another app holds its port.
 */
export type UnrealStageStatus = {
  next: UnrealStageStep;
  project: { name: string; file: string } | null;
  opening: { at: number; elapsedMs: number } | null;
  openProject: { name: string; file: string } | null;
  holder: string | null;
  editors: number;
  busyRun: UnrealBusyRun | null;
  firstStart: boolean;
  portTaken: boolean;
};

const STEPS: ReadonlySet<string> = new Set(Object.values(UnrealStageStep));
const isStageStep = (value: unknown): value is UnrealStageStep => typeof value === "string" && STEPS.has(value);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const named = (value: unknown): { name: string; file: string } | null =>
  isRecord(value) && typeof value.name === "string" && typeof value.file === "string"
    ? { name: value.name, file: value.file }
    : null;

/** A busy run as the plugin sends it; null for anything of another shape. */
function busyRunOf(value: unknown): UnrealBusyRun | null {
  if (!isRecord(value) || typeof value.title !== "string" || typeof value.project !== "string") return null;
  return { title: value.title, project: value.project, here: value.here === true };
}

/** The `stage-status` answer when it has the expected shape; null for anything else, which the card treats as unknown. */
export function parseStageStatus(value: unknown): UnrealStageStatus | null {
  if (!isRecord(value) || !isStageStep(value.next)) return null;
  const opening = isRecord(value.opening) && typeof value.opening.elapsedMs === "number" ? value.opening : null;
  return {
    next: value.next,
    project: named(value.project),
    opening: opening ? { at: Number(opening.at) || 0, elapsedMs: Number(opening.elapsedMs) } : null,
    openProject: named(value.openProject),
    holder: typeof value.holder === "string" && value.holder !== "" ? value.holder : null,
    editors: typeof value.editors === "number" ? value.editors : 0,
    busyRun: busyRunOf(value.busyRun),
    firstStart: value.firstStart === true,
    portTaken: value.portTaken === true,
  };
}

/** The part of a game these rules read: its folder and its engine record. */
type LinkedGame = Pick<GameProject, "engine"> & Partial<Pick<GameProject, "dir" | "linkedEngine">>;

/** The `.uproject` an Unreal game builds in, or null for a web game (or no game). */
export function unrealProjectOf(game: LinkedGame | null | undefined): string | null {
  const engine = game?.engine;
  if (!engine || engineOf(engine) !== GameEngine.Unreal) return null;
  return engine.project;
}

/**
 * What Rewind adds for an Unreal game whose project lives outside the game folder (`engineRewindNote`
 * for Unreal): its checkpoints hold only that folder, so what was changed in Unreal stays. Null for
 * any other game, and for a project inside the game folder, which Rewind restores with the rest.
 */
export function unrealRewindNote(game: LinkedGame | null | undefined): string | null {
  return unrealProjectOf(game) ? engineRewindNote(game) : null;
}

/**
 * Why Mode has no Loop for an Unreal game whose project lies outside its folder (`engineLoopGate`
 * for Unreal): Rewind can't undo what a Loop changes there, where the project is, and the two ways
 * to a Loop.
 */
export function unrealLoopGate(game: LinkedGame | null | undefined): string {
  return unrealProjectOf(game) ? engineLoopGate(game) : UNREAL_WORDS.loopUnavailable(null, "");
}

/** Whether an Unreal game's project lies inside its own folder (New game puts it in `unreal/`). */
export function unrealProjectInFolder(game: LinkedGame | null | undefined): boolean {
  return unrealProjectOf(game) !== null && engineProjectInFolder(game);
}

/** The Unreal plugin that can open the editor: installed, on, allowed and declaring Open in Unreal; else null. */
export function unrealOpener(plugins: readonly PluginInfo[]): PluginInfo | null {
  const plugin = plugins.find((item) => item.manifest.id === UNREAL_PLUGIN_ID);
  if (!plugin?.enabled || plugin.removed || plugin.unlisted) return null;
  const opens = plugin.manifest.actions.some((action) => action.name === UnrealPluginAction.OpenEditor);
  return opens ? plugin : null;
}
