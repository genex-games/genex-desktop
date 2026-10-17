/**
 * A chat's Loop: whether the composer commissions a looping build and for how long. Each chat
 * keeps its own, and a running build shows the one its start record kept (`runLoopSetting`).
 *
 * A game chat is pinned to the last pick when it first opens, the same way its model is; every
 * pick is also kept as the last pick, which seeds the next fresh chat.
 */
import type { ComposerSendOptions } from "../shared/composer.ts";
import { RunState } from "../shared/run-state.ts";
import { type EngineGame, engineLoopAvailable } from "./engine-game.ts";
import type { PickedFrame } from "./reference-frames.ts";
import {
  type KeyValueStorage,
  readJson,
  readNumber,
  readText,
  STORAGE_KEYS,
  storageKeyFor,
  writeJson,
  writeText,
} from "./storage.ts";
import { MAX_LOOP_HOURS, MIN_LOOP_HOURS } from "./ui/loop-duration.ts";
import type { ComposerExtras, RoleRecord } from "./ui/PromptBar.tsx";

/** The composer's Loop: on or off, and its hours, where `null` means ∞ (until satisfied). */
export interface LoopSetting {
  on: boolean;
  hours: number | null;
}

/** The build a chat's composer answers to: its state, and the Loop its start record kept. */
export interface ComposerBuild {
  state: RunState;
  loop: LoopSetting | null;
}

/**
 * What Mode shows and allows: the Loop it names, and whether it opens with that Loop to change.
 * `loopUnavailable`: the game can't run a Loop yet, so Mode shows Off and offers Off alone.
 */
export interface ComposerLoopView {
  shown: LoopSetting;
  editable: boolean;
  loopUnavailable?: true;
}

/**
 * Whether the composer may start a Loop in this game. A web game runs the Loop; an engine game runs
 * it unless its engine needs the project inside the game folder (`projectInFolder`, as Unreal's
 * does: each part's undo point holds it there) and it lies elsewhere. No game (a draft chat) is a
 * web game.
 */
export const loopAvailableFor = (game: EngineGame | null | undefined): boolean => engineLoopAvailable(game);

/** A composer answering a running build it was not told about still sends it no commission. */
export const RUNNING_BUILD: ComposerBuild = { state: RunState.Running, loop: null };

/** How the last pick keeps ∞ in `studio.autopilotHours`. */
const UNTIL_SATISFIED = "inf";
/** A build whose limit was not kept reads as Loop with no limit. */
const UNKNOWN_BUILD_LOOP: LoopSetting = { on: true, hours: null };

const hoursInRange = (hours: unknown): hours is number | null =>
  hours === null || (typeof hours === "number" && hours >= MIN_LOOP_HOURS && hours <= MAX_LOOP_HOURS);

/** A stored value as a Loop setting, or null when it is not one. */
function asLoopSetting(value: unknown): LoopSetting | null {
  if (typeof value !== "object" || value === null) return null;
  const { on, hours } = value as Record<string, unknown>;
  if (typeof on !== "boolean" || !hoursInRange(hours)) return null;
  return { on, hours };
}

/** The last Loop picked in any chat: on unless turned off, and ∞ unless a time was kept. */
export function lastLoop(storage: KeyValueStorage | null): LoopSetting {
  const on = readText(STORAGE_KEYS.composerLoop, storage) !== "0";
  if (readText(STORAGE_KEYS.autopilotHours, storage) === UNTIL_SATISFIED) return { on, hours: null };
  return { on, hours: readNumber(STORAGE_KEYS.autopilotHours, MIN_LOOP_HOURS, MAX_LOOP_HOURS, storage) };
}

/** The Loop a chat kept for itself, or null when it kept none (or none that reads). */
const ownLoop = (storage: KeyValueStorage | null, threadId: string): LoopSetting | null =>
  asLoopSetting(readJson<unknown>(storageKeyFor.threadLoop(threadId), null, storage));

/** A chat's own Loop when it kept a valid one, else the last pick (a fresh chat, or no chat). */
export function storedChatLoop(storage: KeyValueStorage | null, threadId?: string): LoopSetting {
  return (threadId ? ownLoop(storage, threadId) : null) ?? lastLoop(storage);
}

/** A game chat opens on its own Loop: the first time, the last pick becomes its own. */
export function pinChatLoop(storage: KeyValueStorage | null, threadId: string): void {
  if (ownLoop(storage, threadId)) return;
  writeJson(storageKeyFor.threadLoop(threadId), lastLoop(storage), storage);
}

/** A pick is the chat's own and the last pick; Off keeps the saved time for the next Loop. */
export function rememberChatLoop(
  storage: KeyValueStorage | null,
  threadId: string | undefined,
  setting: LoopSetting,
): void {
  if (threadId) writeJson(storageKeyFor.threadLoop(threadId), setting, storage);
  writeText(STORAGE_KEYS.composerLoop, setting.on ? "1" : "0", storage);
  writeText(STORAGE_KEYS.autopilotHours, setting.hours === null ? UNTIL_SATISFIED : String(setting.hours), storage);
}

/**
 * A typed message's Loop commissions a build in a chat with none yet, or once its build finished:
 * the chat's own session then decides whether that continues the same run or starts over, and the
 * run's coordinator whether it continues it. A running or paused build takes none. A command's
 * result follows `reportCommissions` instead.
 */
export function loopCommissions(build: Pick<ComposerBuild, "state"> | null | undefined): boolean {
  return !build || build.state === RunState.Finished;
}

/**
 * What Mode shows: the chat's own Loop while no build belongs to it or once its build finished; a
 * running or paused build's own limit, read-only (Stop and the Builds controls halt it). In a game
 * that can't run a Loop yet (`loopAvailableFor`) the chat's own Loop shows Off and commissions
 * nothing, while its kept pick stays for when the Loop can run; plan review still works.
 */
export function composerLoopView(input: {
  own: LoopSetting;
  build: ComposerBuild | null | undefined;
  loopAvailable?: boolean;
}): ComposerLoopView {
  const { own, build, loopAvailable = true } = input;
  if (!loopCommissions(build)) return { shown: build?.loop ?? UNKNOWN_BUILD_LOOP, editable: false };
  if (!loopAvailable) return { shown: { ...own, on: false }, editable: true, loopUnavailable: true };
  return { shown: own, editable: true };
}

/** How far the person reaches Mode: whether it opens, and whether its Loop can change. */
export interface ModeMenuReach {
  opens: boolean;
  changes: boolean;
}

/**
 * How far the person reaches Mode: it opens, and its Loop changes, only while no build owns the
 * chat and the run's coordinator is not answering.
 */
export function modeMenuReach(input: { view: ComposerLoopView; coordinating: boolean }): ModeMenuReach {
  const changes = input.view.editable && !input.coordinating;
  return { opens: changes, changes };
}

/** What a send carries besides its text: plan review, the pictures, and the Loop's commission. */
export function composerExtras(input: {
  gameMode: boolean;
  view: ComposerLoopView;
  reviewPlan: boolean;
  frames: PickedFrame[];
}): ComposerExtras {
  const { gameMode, view, frames } = input;
  const editable = gameMode && view.editable;
  const reviews = editable && input.reviewPlan;
  const commissions = editable && view.shown.on;
  return {
    ...(reviews ? { reviewPlan: true } : {}),
    ...(frames.length ? { frames } : {}),
    ...(commissions ? { autopilot: { hours: view.shown.hours, frames } } : {}),
  };
}

/**
 * The Loop commission a send carries, from the composer's extras: ∞ sends no hours, no pictures send
 * no frames, and plan review and the chosen roles ride along only when set. Pure, so an eval lane
 * can read a build's default commission from this very function (`scripts/evals/lanes/genex-app.ts`).
 */
export function autopilotSendOptions(
  autopilot: NonNullable<ComposerExtras["autopilot"]>,
  roles: RoleRecord | null,
): NonNullable<ComposerSendOptions["autopilot"]> {
  return {
    ...(autopilot.hours !== null ? { hours: autopilot.hours } : {}),
    ...(autopilot.frames.length ? { frames: autopilot.frames } : {}),
    ...(autopilot.reviewPlan ? { reviewPlan: true } : {}),
    ...(roles ? { roles } : {}),
  };
}

/**
 * A send the chat makes for the user (a command's result) commissions only while no build belongs to
 * the chat: the person's Loop intake goes on with it. Once one does — running, paused or finished — it
 * carries none: a result is not the person asking for more work, so it never reopens a finished build.
 */
export function reportCommissions(build: Pick<ComposerBuild, "state"> | null | undefined): boolean {
  return !build;
}

/**
 * The Loop a send the chat makes for the user (a command's result) carries: before the chat's first
 * build, the commission a message typed into this chat's composer would carry now, so the answer
 * continues the same kind of turn; after one, none (`reportCommissions`). No plan review and no pictures.
 */
export function chatLoopExtras(input: {
  storage: KeyValueStorage | null;
  threadId: string;
  build: ComposerBuild | null | undefined;
  coordinating: boolean;
  gameMode: boolean;
  /** The game can run a Loop (`loopAvailableFor`); without it the result carries none. */
  loopAvailable?: boolean;
}): ComposerExtras {
  const build = input.build ?? (input.coordinating ? RUNNING_BUILD : null);
  if (!reportCommissions(build)) return {};
  const own = storedChatLoop(input.storage, input.threadId);
  const view = composerLoopView({ own, build, loopAvailable: input.loopAvailable });
  return composerExtras({ gameMode: input.gameMode, view, reviewPlan: false, frames: [] });
}
