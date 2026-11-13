/**
 * The Loop's start: the one tool a chat's own session is handed to start a Loop (delegated-turn.ts
 * bridges it in each turn of the chat's own session on the person's words; a run's turn, words
 * Genex wrote and the Studio's chat never have it). It lives here, outside `tools/`, so a direct engine's tool loop, which cannot lead a Loop,
 * is never handed it. The session decides when to call it; the tool says what a build is and when
 * one starts, since a tool that said only what it does was never called and the game was built in
 * the chat's replies. The harness runs it once the reply has ended (chat-dispatch.ts `launchFromIntake`).
 */
import type { AnyRecord, HarnessTool, ToolCtx } from "../types/harness.d.ts";
import { RunMode } from "./run-events.ts";
import { storeItemsOf } from "./store-items.ts";
import { TurnStop } from "./turn-record.ts";
import { askedMinutes, WORK_TIME_PARAMS, workBudget } from "./work-time.ts";

/** How many words of the ask a new folder's name keeps, and how long that name may be. */
const SLUG_WORDS = 3;
const MAX_SLUG_CHARS = 40;
/** The folder a run builds in when its words leave no name. */
const FALLBACK_FOLDER = "game";
/** Words that say nothing about which game this is, left out of its folder's name. */
const SLUG_STOP = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "i",
  "want",
  "make",
  "game",
  "some",
  "kind",
  "just",
  "like",
  "really",
  "very",
]);

const str = (description: string) => ({ type: "string", description });
/**
 * What a launch's goal is: the person's ask in their own words, nothing added. A goal once turned
 * "we need serious 1x1 arena, that looks like real man, hardcore" in a chat about combat feel into map
 * work with props and lighting, until the person said "not work on a map" (sword duel).
 */
const GOAL_WORDS =
  "What the person asked for: their own words, quoted as they wrote them, then what that means in this game in a sentence or two, at the stage the project is in (as they or its own notes, such as a HANDOFF.md, say). Add no work they didn't ask for (no packaging, publishing or finished game unless they asked), and where a word could mean more than one thing, read it by what they made the priority earlier in this chat.";
/** What a launch's reference is: whatever the user named, if anything. */
const DIRECTION_WORDS = "optional: a game, film or picture the user named as a reference, in their words";

/** What a launch sells in the game's Genex store: never cut, listed by the build with its picture (loop/store-items.ts). */
const STORE_ITEMS_WORDS =
  'each thing the user sells for Nex, Genex\'s currency (a class, a character, a skin, an item), as {"name","price","type","description"}: price in whole Nex as they named it (Genex takes the nearest step on the store grid), 100 when they named none; type "durable" for what is kept once bought (a class, a character, a skin), "consumable" only for what is used up. The build lists each in the game\'s store with its picture; an item can also be added or changed at any time with genex__cli, no launch needed. Leave it out when nothing is sold for Nex: coins, gold or gems are a currency the game keeps itself';

/** A store item list parameter: objects, or their JSON array as text from an engine that sends every field as a string. */
const storeList = () => ({
  type: "array",
  items: {
    type: "object",
    properties: {
      name: { type: "string" },
      price: { type: "number" },
      type: { type: "string" },
      description: { type: "string" },
    },
    required: ["name"],
  },
  acceptJsonString: true,
  description: STORE_ITEMS_WORDS,
});

/** A launch's store items as the run carries them (chat-dispatch.ts `intakeRun`); none when unnamed. */
function storeArgs(args: AnyRecord): { storeItems?: AnyRecord[] } {
  const storeItems = storeItemsOf(args.store_items);
  return storeItems.length ? { storeItems } : {};
}

/** The time the person named for the build, as its budgets carry it (work-time.ts); none when they named none. */
function timeArgs(args: AnyRecord): { budgets?: AnyRecord } {
  const minutes = askedMinutes(args);
  return minutes ? { budgets: workBudget(minutes) } : {};
}

/** The pictures the launching message carries, without empty slots: the build's lead receives them. */
function attachedFrames(stills: unknown): AnyRecord[] {
  return (Array.isArray(stills) ? stills : []).filter((frame: AnyRecord | null) => frame?.data);
}

/** A new folder's name from the words of the ask: its first few telling words, joined by dashes. */
function slugProject(text: unknown): string {
  const words = String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, " ")
    .split(/\s+/)
    // A word whose other half was not Latin ("game-магазин") keeps a dash at its edge: drop it.
    .map((word) => word.replace(/^-+|-+$/g, ""))
    .filter((word) => word && !SLUG_STOP.has(word));
  return (words.slice(0, SLUG_WORDS).join("-") || FALLBACK_FOLDER).slice(0, MAX_SLUG_CHARS);
}

/** start_autopilot: a Loop of this game, on the chat's engine and model and the message's roles. */
export const startAutopilot: HarnessTool = {
  name: "start_autopilot",
  description:
    "Start a build: work toward the goal the person set, which you lead with workers in parallel and save points until you call finish or the person stops it. Call it as soon as you set to making a game whose direction is settled (the person answered your questions and agreed to the design, said to just build, or asked for a small game their words give whole), or to a change of many steps the person asked for, instead of doing that work in your reply: say in a line what the build will do and end your reply. A build does only what the person asked, at the stage their project is in (a blockout stays a blockout, an asset search stays a search): packaging, publishing or finishing the whole game are its goal only when they ask for that. A question, a look, a choice the person makes (assets to pick, a layout to review) or a quick fix needs no build. It goes on in this session from this folder as you leave it. When this chat has a paused build and the person asks for more of its goal, go on with it (resume_run) unless the person wants to start over.",
  parameters: {
    type: "object",
    properties: {
      goal: str(GOAL_WORDS),
      direction: str(DIRECTION_WORDS),
      project: str("folder slug for a chat that has no folder yet, lowercase; a chat already bound to one keeps it"),
      ...WORK_TIME_PARAMS,
      store_items: storeList(),
    },
    required: ["goal"],
  },
  execute(args: AnyRecord, ctx: ToolCtx) {
    const goal = String(args.goal).trim();
    const frames = attachedFrames(ctx.stills);
    const run = {
      goal,
      // This slug only ever names a chat that has no folder yet: the launch stamps the chat's own
      // folder over it (delegated-turn.ts `withChatProject`) and a bound thread wins outright.
      project: slugProject(args.project || args.direction || args.goal),
      mode: RunMode.Autopilot,
      reference: { name: String(args.direction ?? "").trim() || goal, shots: [], ...(frames.length ? { frames } : {}) },
      engine: ctx.engine,
      ...(ctx.model ? { model: ctx.model } : {}),
      // The composer's roles panel: orchestrator / workers / judges, applied at launch (model-roles.ts).
      ...(ctx.roles ? { roles: ctx.roles } : {}),
      ...storeArgs(args),
      ...timeArgs(args),
    };
    return { ok: true, content: "Building.", stopTurn: TurnStop.LaunchRun, details: { run } };
  },
};
