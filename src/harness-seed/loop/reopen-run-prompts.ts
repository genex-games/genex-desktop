/**
 * What the chat's own session reads and records to reopen its finished build (reopen-run.ts): the
 * tool, its rules in the after-run note, the coordinator's rules when its continue_build reopens
 * the build instead, and what the chat is told. A module of its own: the
 * existing parts that read these (after-loop-run-prompts.ts, delegated-turn.ts) import new names only
 * from here, and this imports only names every older seed exported
 * (tests/fixtures/seed-exports-pre-reopen.json).
 */
import { MAX_RUN_HOURS } from "./config.ts";
import { askUser } from "./interview-question.ts";
import { toolCall } from "./model-roles.ts";
import { endClock } from "./wall-clock.ts";
import type { RunSpec, StudioToolSpec } from "../types/host-api.d.ts";

/** The tool the chat's own session records to reopen its finished build: done once its reply ends. */
export const REOPEN_RUN = "reopen_run";

/** Its spec, bridged in like a Loop chat's launch: only the request — never a run to name. */
export const reopenRunTool: StudioToolSpec = {
  name: REOPEN_RUN,
  description:
    "Reopen this chat's finished build as the same build — its run, plan, workers and Builds graph — until what the user asks is checked, within the working time Loop gives it; you lead it again. Use when the user asks for more work on the game than one contained change while Loop is on; never for a contained change you can make yourself, never for a question, never to start over. Supply their request as text. The build goes on when your reply ends: call it once, last, and edit nothing in that reply.",
  parameters: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "The user's request for the build, in their words, with what the build needs to know.",
      },
    },
    required: ["text"],
  },
};

/** A finished build's reopen as the note words it: the Loop's hours (null: until satisfied), the stills, the folder, the start-over tool. */
export interface ReopenGrant {
  hours: number | null;
  frameCount: number;
  project?: string;
  /** The launch bridged beside the reopen, for an explicit start over; null when none is. */
  launchTool: string | null;
}

/** What the chat is told of a reopen. */
export const MESSAGE = {
  notReopened: (why: string) => `The build was not reopened: ${why}`,
  notTheLatest: "it is no longer the finished build this chat answers after.",
  noJournal: "its saved record could not be read.",
  alreadyBuilding: (project: string) => `a build is already running for ${project}.`,
  /** Why, when Stop came after the reply and before the build was under way again. */
  stoppedFirst: "Stop came before it started again. It stays finished.",
  reopening: (end: string) =>
    `The build goes on until your request is checked, by about ${end} at the latest — keep the app open and the Mac awake.`,
  reopeningUntilSatisfied: (ceiling: string) =>
    `The build goes on until its critics are satisfied, and stops by about ${ceiling} whatever happens — keep the app open and the Mac awake.`,
  /** Said once for a finished build that no Loop can go on from here (chat-dispatch.ts); the message is answered as with Loop off. */
  loopUnused:
    "Loop can't continue this build here, so this message is answered as with Loop off — the build stays as it finished.",
} as const;

/** How long the reopened build may run, as the session reads it. */
function budgetWords(hours: number | null): string {
  if (typeof hours === "number" && hours > 0) return `up to ${hours} h`;
  return `until its judges are satisfied, ${MAX_RUN_HOURS} h at most`;
}

/** An explicit start over, and the question when it is unclear: only beside a bridged launch. */
function startOverRules(engine: string | undefined, reopen: string, grant: ReopenGrant): string[] {
  if (!grant.launchTool) return [];
  const launch = toolCall(engine, grant.launchTool);
  const ask = toolCall(engine, askUser.name);
  const project = grant.project ? ` Pass "${grant.project}" as its project argument.` : "";
  return [
    `- Only when the user explicitly asks to start over — from scratch, a brand-new game, throw this build away — call ${launch} instead, with the goal in their words: it starts a new build from this folder as you leave it. Never for a change to this game.${project}`,
    `- If it is unclear whether a change is contained, whether they want the build to go on or to start over, or any work at all, ask with ${ask} (recommended choice first) — your estimate in each choice, the direct change first when it takes minutes ("Fix it now — a few minutes" / "Continue the build — ${budgetWords(grant.hours)}") — and end your reply. Never call ${reopen} or ${launch} in the same reply as a question, and never both.`,
  ];
}

/**
 * The after-run note's rules for a finished build with Loop on, its tools spelled the way `engine`
 * calls them. Loop allows the build to go on; it never orders it ("work of any size — a fix…"
 * would send a seventy-second fix to a three-hour build). A question is answered, a
 * contained change is the session's own edit, more work reopens the same build, and only an explicit
 * start over launches a new one.
 */
export function reopenRules(engine: string | undefined, grant: ReopenGrant): string[] {
  const reopen = toolCall(engine, REOPEN_RUN);
  const stills =
    grant.frameCount > 0
      ? `- The user attached ${grant.frameCount} still(s) to this message: look at them, and say in your request what they show.`
      : "";
  return [
    `- Loop is on: you may continue this build — the same run goes on, its plan, its workers, its Builds graph, from where it finished, and you lead it again until what the user asks is checked (${budgetWords(grant.hours)}). It is allowed, not required. Decide from the latest message:`,
    "- A question, research or a plan is not a request for work: answer it here yourself, then offer to continue the build with it.",
    "- A contained change — a fix, a tweak, one feature, anything they want quickly: make it yourself here in the game folder, look at it in your own window, and say what changed. The build stays finished.",
    `- More work than one contained change — several systems, new features, the look of the whole game, "more", "keep going": call ${reopen} once, last, with their request in their words as text, and edit nothing in that reply. The build goes on when your reply ends.`,
    ...startOverRules(engine, reopen, grant),
    stills,
  ].filter(Boolean);
}

/**
 * The coordinator's rules when a Loop came with a message after a finished build it answers for
 * (coordinator-prompts.ts): its continue_build reopens the same build with the Loop's time, which
 * the rules it answers by otherwise forbid (no new run, no clock reset), unless the ask is a contained
 * change (`build: false`, one builder turn); a question continues nothing. The stills it was shown
 * reach the build only as its words.
 */
export function coordinatorReopenRules(hours: number | null, frameCount = 0): string[] {
  const stills =
    frameCount > 0
      ? `The user attached ${frameCount} still(s) to this message: look at them, and say in continue_build's text what they show — the build goes on from your words, not the pictures.`
      : "";
  return [
    `Loop is on for this message, and this build has finished: you may continue it. continue_build reopens it — its run, plan, workers and Builds graph — from where it finished and with the models it was built with, once your reply ends, until what the user asks is checked (${budgetWords(hours)}). That is the one clock you may set going again: the Loop's working time on this same build, never another run.`,
    'Decide from the latest message. A contained change — a fix, a tweak, one feature, anything they want quickly — is not a build: call continue_build with their request in their words and build: false, and one builder makes it in this chat while the build stays finished. More work than one contained change — several systems, new features, "more", "keep going": call continue_build once with their request in their words, and say the build goes on. A question, research or a plan is not work: answer it, and continue nothing.',
    stills,
  ].filter(Boolean);
}

/** What the chat promises the moment a reopened build starts at `now`: when it ends, and what it needs. */
export function reopenPromise(budgets: RunSpec["budgets"], now: number): string {
  const end = endClock(budgets.wallClockMs, now);
  return budgets.untilSatisfied ? MESSAGE.reopeningUntilSatisfied(end) : MESSAGE.reopening(end);
}
