/**
 * What a Loop chat is told about the Loop it may start: allowed, not owed. A delegated session reads
 * `launchRules` in its contractor brief (chat-session.ts). Mechanics only: what to build, and how, is
 * the user's and the session's to decide.
 */
import { MAX_RUN_HOURS } from "./config.ts";
import { UNTIL_DONE_WORDS } from "./until-done-prompts.ts";
import { isEngineGame } from "./engine-game.ts";
import { LoopProfile } from "./folder-facts.ts";
import { type EngineId, GameEngine } from "./game-engine.ts";
import { askUser } from "./interview-question.ts";
import { toolCall } from "./model-roles.ts";
import { openBuildWords, openStillsWords } from "./open-loop-prompts.ts";

/** The build a Loop chat may start: its launch tool, the composer's hours, stills and folder. */
export interface LaunchGrant {
  toolName: string;
  /** The composer's hours for a build; none runs it until its lead finishes it (`UNTIL_DONE_WORDS`). */
  hours?: number | null;
  /** How many stills the commission carries. */
  frameCount?: number;
  /** The chat's folder, which the launch tool is handed. */
  project?: string;
}

/**
 * How a resumed Loop chat is told to go on: from the new message, not "finish the remaining
 * work" — its last turn may have been an answer or a plan, with no build left to finish.
 */
export const RESUME_LOOP_CHAT =
  "You are resuming your own session in this workspace — your context is restored. Continue from where you left off.";

/** Small talk is neither a build nor unclear. */
const SMALL_TALK =
  "A greeting, thanks or small talk: reply in a sentence or two, like a person. No tools and no question.";

/**
 * What a launch sells for Nex: a store item the build lists with its picture (loop/store-items.ts).
 * Nex is Genex's own currency; any other currency is the game's.
 */
const STORE_ITEMS_RULE =
  "Whatever the user sells for Nex (Genex's currency) goes in the launch's store_items with its name and price (100 Nex when they named none): the build lists each item, with its picture, in the game's store. Store items never need a launch: genex__cli shop add, shop set and shop remove change one at any time, and every item needs its picture (the image option). A currency or a shop inside the game is the game's own, never store_items.";

/** How long a build may run, as the chat reads it. */
function budgetWords(hours: number | null | undefined): string {
  if (typeof hours === "number" && hours > 0) return `up to ${hours} h`;
  return `${UNTIL_DONE_WORDS}, ${MAX_RUN_HOURS} h at most`;
}

/** What a build is, as a Loop chat is told: the web Loop, or the Unreal Loop in the user's open editor. */
function buildWords(gameEngine: EngineId, hours: number | null | undefined): string {
  const span = typeof hours === "number" && hours > 0 ? `up to ${hours} h` : `up to ${MAX_RUN_HOURS} h`;
  if (gameEngine === GameEngine.Unreal)
    return `the Unreal Loop — one lead works in the open Unreal editor, with helpers in copies of the game (${span})`;
  return `the Loop — you lead it in a copy of this game, with optional workers, and its finish lands it here (${budgetWords(hours)})`;
}

/** The Loop a project gets when its caller named none: the one Loop in place for a game in any engine but Unreal, else the web Loop. */
function loopProfileFor(gameEngine: EngineId, profile: LoopProfile | undefined): LoopProfile | undefined {
  if (profile) return profile;
  return isEngineGame(gameEngine) && gameEngine !== GameEngine.Unreal ? LoopProfile.Open : undefined;
}

/** What a build is, for the Loop a project gets. */
function buildOf(gameEngine: EngineId, profile: LoopProfile | undefined, hours: number | null | undefined): string {
  if (profile === LoopProfile.Open) return openBuildWords(hours);
  return buildWords(gameEngine, hours);
}

/** Who receives the commission's stills: the Loop's lead. */
function stillsWords(frames: number, profile: LoopProfile | undefined): string {
  if (frames <= 0) return "";
  if (profile === LoopProfile.Open) return openStillsWords(frames);
  return `The user attached ${frames} still(s); the Loop's lead receives them.`;
}

/**
 * What a delegated Loop chat adds to the contractor's rules, its tools spelled the way `engine`
 * calls them: answer, research and edit here; start a Loop when the ask is one.
 */
export function launchRules(
  engine: string | undefined,
  grant: LaunchGrant,
  gameEngine: EngineId = GameEngine.Web,
  profile?: LoopProfile,
): string[] {
  const launch = toolCall(engine, grant.toolName);
  const ask = toolCall(engine, askUser.name);
  const loop = loopProfileFor(gameEngine, profile);
  const build = buildOf(gameEngine, loop, grant.hours);
  return [
    `Loop is on: you may start ${build}. It is allowed, not required. Decide from the latest message:`,
    `- ${SMALL_TALK}`,
    "- A question, research, a plan or a contained change: do it yourself and answer here. A request for research or a plan is not a request to build.",
    `- A build of the game, or work that needs hours: call ${launch} with the goal in the user's words.`,
    `- When you ask the user something (${ask}), end your reply: never call ${launch} in the same reply as a question.`,
    STORE_ITEMS_RULE,
    `A Loop starts when your reply ends, from this folder exactly as you leave it: call ${launch} last, then recap in one short paragraph.`,
    stillsWords(grant.frameCount ?? 0, loop),
    grant.project ? `Pass "${grant.project}" as the tool's project argument.` : "",
  ].filter(Boolean);
}
