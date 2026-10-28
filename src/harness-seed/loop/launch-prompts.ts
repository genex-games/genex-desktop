/**
 * What a Loop chat is told about the build it may start: a build is allowed, not owed. A
 * delegated session reads `launchRules` in its contractor brief (chat-session.ts), a direct
 * engine reads `launchDecision` in its turn briefing (turn-prompts.ts); the decision is the same.
 * A request for research and a plan once reached a chat whose only way forward was a launch, and
 * became a seventeen-hour build of a title card.
 */
import { MAX_RUN_HOURS } from "./config.ts";
import { UNTIL_DONE_WORDS } from "./until-done-prompts.ts";
import { isEngineGame } from "./engine-game.ts";
import { LoopProfile } from "./folder-facts.ts";
import { type EngineId, GameEngine } from "./game-engine.ts";
import { askUser } from "./interview-question.ts";
import { toolCall } from "./model-roles.ts";
import { NARROW_TO_THE_ASK } from "./narrow-prompts.ts";
import { OPEN_QUICK_IS_A_BUILD, openBuildWords, openStillsWords } from "./open-loop-prompts.ts";

/** The build a Loop chat may start: its launch tool, the composer's hours, stills and folder. */
export interface LaunchGrant {
  toolName: string;
  /** The composer's hours for a build; none runs it until what was asked is verified (`UNTIL_DONE_WORDS`). */
  hours?: number | null;
  /** How many stills the commission carries (its mood board). */
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

/**
 * Before a build: what the game is and how it should look, and one question when either is
 * missing — the write-less interviewer this chat replaced asked it before every build it launched,
 * and without it a bare pitch ("make me a game, quickly") became hours of building in a style
 * nobody chose. `ask` is the question tool as the reader calls it.
 */
function askFirst(ask: string): string {
  return `Before you launch a build, know what the game is (what the player does in it) and how it should look and feel (a style, a game or film to match, or the stills). Take both from the conversation, the stills or the game already in this folder. If either is missing, do not guess: ask with ${ask} — one question that covers what is missing, up to 3 choices with your recommendation first — and end your reply; launch once they answer. Ask even when the user asks for speed: an answer costs them a click, a build in the wrong style costs hours. Never ask what they already said or showed, and ask once: after their answer, a gap in look takes your recommendation; ${NARROW_TO_THE_ASK}: a build is narrowed, never widened.`;
}

/**
 * Small talk is neither a build nor unclear: a "Hello" in a new game once came back as a question
 * card about what the game should be.
 */
const SMALL_TALK =
  "A greeting, thanks or small talk: reply in a sentence or two, like a person, and ask what they would like to make if they have not said. No tools and no question.";

/** A hurry changes how long a build runs, never whether a new game is one. */
const QUICK_IS_A_BUILD = "also when they want it fast: a quick build is still a build, and its judges still check it";

/**
 * What a launch sells for Nex: a store item the build lists with its picture, never a cut
 * (loop/store-items.ts). Nex is Genex's own currency; any other currency is the game's. Store items
 * are never tied to a launch: genex__cli lists or changes one at any time.
 */
const STORE_ITEMS_RULE =
  "Whatever the user sells for Nex (Genex's currency: a class, a character, a skin, an item) goes in the launch's store_items with its name and price (100 Nex when they named none), never in cut: the build draws each item's picture and lists it in the game's store. Ask nothing more about them (sharing with other games, resale, type, picture): each item's card leaves those to the person. Store items never need a launch: add, change or remove one at any time, with or without a build running, with genex__cli shop add, shop set and shop remove, and every item needs its picture (the image option). Coins, gold, gems or a shop in the game are the game's own currency and store: never store_items, and no question about them.";
/** The same for an Unreal game, whose Loop has no judges: its lead checks its own captures. */
const QUICK_IS_AN_UNREAL_BUILD = "also when they want it fast: a quick build is still a build";
/**
 * How an Unreal Loop's goal is written: a lead that reads a list of features builds features, so
 * the look leads, in the user's own words.
 */
const UNREAL_GOAL_LOOK_FIRST =
  "Write an Unreal build's goal with the look first: the user's own words about how it should look, then what the player sees (light, scale, materials, the characters as they look in play) before mechanics. Never turn a wish for a stunning game into a list of features.";

/** How long a build may run, as the chat reads it. */
function budgetWords(hours: number | null | undefined): string {
  if (typeof hours === "number" && hours > 0) return `up to ${hours} h`;
  return `${UNTIL_DONE_WORDS}, ${MAX_RUN_HOURS} h at most`;
}

/** How long an Unreal Loop runs, as the chat reads it: no judge ends it, its hours do. */
function unrealBudgetWords(hours: number | null | undefined): string {
  return `up to ${typeof hours === "number" && hours > 0 ? hours : MAX_RUN_HOURS} h`;
}

/** What a build is, as a Loop chat is told: the web Loop, or the Unreal Loop in the user's open editor. */
function buildWords(gameEngine: EngineId, hours: number | null | undefined): string {
  if (gameEngine === GameEngine.Unreal)
    return `the Unreal Loop — one lead builds the whole game itself in the open Unreal editor, judging its own captures and saving as it goes, while small helpers make models, characters, sounds and textures in copies of the game (${unrealBudgetWords(hours)})`;
  return `builders working in parallel and judges checking their work (${budgetWords(hours)})`;
}

/**
 * The Loop a project gets when its caller named none: the one Loop in place for a game in any
 * engine but Unreal (whose own Loop the words name), else the web Loop.
 */
function loopProfileFor(gameEngine: EngineId, profile: LoopProfile | undefined): LoopProfile | undefined {
  if (profile) return profile;
  return isEngineGame(gameEngine) && gameEngine !== GameEngine.Unreal ? LoopProfile.Open : undefined;
}

/** What a build is and how a quick one reads, for the Loop a project gets: the web Loop, the Unreal Loop, or the one Loop in place. */
function buildOf(gameEngine: EngineId, profile: LoopProfile | undefined, hours: number | null | undefined) {
  if (profile === LoopProfile.Open) return { words: openBuildWords(hours), quick: OPEN_QUICK_IS_A_BUILD };
  const quick = gameEngine === GameEngine.Unreal ? QUICK_IS_AN_UNREAL_BUILD : QUICK_IS_A_BUILD;
  return { words: buildWords(gameEngine, hours), quick };
}

/** Who receives the commission's stills: a web build's judges, or an open Loop's lead. */
function stillsWords(frames: number, profile: LoopProfile | undefined): string {
  if (frames <= 0) return "";
  if (profile === LoopProfile.Open) return openStillsWords(frames);
  return `The user attached ${frames} still(s); a build's judges receive them automatically.`;
}

/**
 * What a delegated Loop chat adds to the contractor's rules, its tools spelled the way `engine`
 * calls them: answer, research, plan and edit here; launch only when the ask is a build. A project
 * that isn't a web game (`LoopProfile.Open`) builds in the one Loop, its lead in place and a
 * reviewer checking its finish; with no profile named, an Unreal game's build is the Unreal Loop,
 * and a game in any other engine's the one Loop.
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
    `Loop is on: you may start a build — ${build.words}. It is allowed, not required. Decide from the latest message:`,
    `- ${SMALL_TALK}`,
    "- A question, research, a plan, a design document or a review: do it yourself and answer here; put plans and documents in this folder (docs/) when they are asked for. A request for research or a plan is not a request to build — deliver it, then offer to build from it.",
    "- A contained change (a fix, a tweak, one feature): make it yourself in this folder.",
    `- Building the game or changing it substantially (a new game from a pitch, several systems at once, the look of the whole game, hours of work): call ${launch} with the goal in the user's words, what it delivers in in_scope and what it leaves out in cut — ${build.quick}. Reading and research first are fine; do not build the game yourself.`,
    `- If it is unclear whether they want a build, or a build would take hours they may not expect, ask with ${ask} (recommended choice first) and end your reply. Never call ${launch} in the same reply as a question, and never recommend what the user ruled out.`,
    askFirst(ask),
    STORE_ITEMS_RULE,
    gameEngine === GameEngine.Unreal ? UNREAL_GOAL_LOOK_FIRST : "",
    `A build starts when your reply ends, from this folder exactly as you leave it: call ${launch} last, then recap in one short paragraph.`,
    stillsWords(grant.frameCount ?? 0, loop),
    grant.project ? `Pass "${grant.project}" as the tool's project argument.` : "",
  ].filter(Boolean);
}

/** The same decision for a direct engine's Loop or Autopilot briefing, which names `tool` bare. */
export function launchDecision(tool: string): string[] {
  return [
    `Decide from the latest message. ${SMALL_TALK}`,
    "Questions, research, plans, design documents and contained changes: do them yourself with your tools and answer here (put plans and documents in docs/ when asked). A request for research or a plan is not a request to build — deliver it, then offer to build from it.",
    `When the ask is to build the game or change it substantially, call ${tool} once, the goal in the user's words, what it delivers in in_scope and what it leaves out in cut — ${QUICK_IS_A_BUILD}; it starts from this folder as you leave it. If it is unclear whether they want a build, ask first.`,
    askFirst(askUser.name),
    STORE_ITEMS_RULE,
  ];
}
