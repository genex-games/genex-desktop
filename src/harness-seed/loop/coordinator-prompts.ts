/**
 * The words the game chat's coordinator (coordinator.ts) is given: who it is to the user, what
 * it may and may not do, and the run it answers for.
 */
import { runSnapshot } from "./run-inbox.ts";
import { coordinatorReopenRules } from "./reopen-run-prompts.ts";
import type { AnyRecord, HarnessEvent } from "../types/harness.d.ts";

/**
 * This prompt words a Loop's reopen when the chat offers one (`coordinatorPrompt`'s `reopen`):
 * chat-dispatch.ts keeps a Loop for the coordinator only when it and coordinator.ts say so
 * (`coordinatorReopens`), since a kept copy from before would never tell the coordinator.
 */
export const SERVES_REOPEN = true;

/** The system prompt of a completion-only coordinator, which answers only through its tools. */
export const COORDINATOR_SYSTEM = "You coordinate the existing run using only the provided tools.";

/** How much of the saved plan, the run snapshot and the saved progress the prompt carries. */
const PLAN_CHARS = 24_000;
const SNAPSHOT_CHARS = 24_000;
const PROGRESS_CHARS = 18_000;
/** How much of the recent conversation the prompt carries. */
const HISTORY_CHARS = 18_000;
/** All four together: the most a coordinator's prompt carries of the run, whatever the model. */
export const COORDINATOR_RECORD_CHARS = PLAN_CHARS + SNAPSHOT_CHARS + PROGRESS_CHARS + HISTORY_CHARS;

/** Who the coordinator is to the user, and the rules it answers by. */
const COORDINATOR_RULES = [
  "You are the assistant in this game's chat. A build (a Loop run) was started from this chat and now exists; you answer here on its behalf. To the user you are simply this chat: never describe yourself as a coordinator, a registrar or a separate Studio chat.",
  "Answer the latest message in context. The intake interview is over. Do not commission another run, repeat planning, reset a clock, or edit game files. Workers own implementation: you cannot generate assets or change files yourself, but the builders can, with the capabilities listed below, once resume_run or continue_build hands them the request.",
  "Use run_status for current facts, steer_run for requested changes during a run, finish_run to wait for current attempts then integrate/show the accepted work, or resume_run for continued work on a paused run. A new instruction after a stop is a request to continue with that instruction; include it as text in resume_run so the saved run receives it before building. A question alone needs an answer without restarting builders.",
  "When the user asks to see, run, play or launch what a run made — during, after or when it paused — use show_build (integration: what the run built; live: the game folder as it is), then say what it answered: open in Live, on the right, or waiting behind Reload while the user watches Live. A finished or paused run whose work was not landed can be put in the game folder with land_build; say what was landed.",
  "Speak the user's language, not the studio's internals: the panel on the right is Live (the game), Builds (the run's progress) and Assets. Never say integration branch, worktree, studio window, integration view or live view. The run's build is \"the build\"; the folder they play from is \"your game folder\".",
  "A question needs an answer, not worker instructions. Guidance is queued at iteration boundaries, not injected mid-command. Do not claim it has been applied until the evidence says so. Finish still performs integration and validation; never promise a broken build is playable.",
  "If this run has finished, answer questions about its results. For requested changes or unfinished work, use continue_build to continue in the existing game with its saved plan and conversation. Do not require a Keep going, Resume, or New build button. Never silently replace the plan or repeat completed work.",
];

/**
 * The coordinator's prompt: its rules — with a Loop's reopen when the chat offers one (`reopen`, the
 * Loop's hours) — then the saved plan and progress, the run, the conversation and the message.
 */
export function coordinatorPrompt({
  events,
  run,
  text,
  journal,
  savedPlan,
  history,
  reopen = null,
  budgetChars = COORDINATOR_RECORD_CHARS,
}: {
  events: readonly HarnessEvent[];
  run: AnyRecord;
  text: string | undefined;
  journal: AnyRecord | null;
  savedPlan: unknown;
  history: string;
  reopen?: { hours: number | null; frameCount?: number } | null;
  /** How much of the run the prompt may carry: a share of the model's window. */
  budgetChars?: number;
}): string {
  const progress = { phase: journal?.phase, base: journal?.base, facets: journal?.facets, director: journal?.director };
  // Each part keeps its share of what this model can take; the message is never cut.
  const share = (chars: number) =>
    Math.floor((chars * Math.min(budgetChars, COORDINATOR_RECORD_CHARS)) / COORDINATOR_RECORD_CHARS);
  return [
    ...COORDINATOR_RULES,
    ...(reopen ? coordinatorReopenRules(reopen.hours, reopen.frameCount ?? 0) : []),
    `SAVED PLAN (retain decisions and completed work):\n${head(JSON.stringify(savedPlan), share(PLAN_CHARS))}`,
    `SAVED PROGRESS:\n${head(JSON.stringify(progress), share(PROGRESS_CHARS))}`,
    `RUN SNAPSHOT:\n${head(JSON.stringify(runSnapshot(events, run.runId)), share(SNAPSHOT_CHARS))}`,
    `RECENT CONVERSATION (context only):\n${tail(history, share(HISTORY_CHARS))}`,
    `LATEST USER MESSAGE:\n${text}`,
  ].join("\n\n");
}

/** The start of `text` within `chars`, saying how much was cut — a record cut without a word reads as whole. */
function head(text: string, chars: number): string {
  if (text.length <= chars) return text;
  return `${text.slice(0, chars)} […${text.length - chars} characters cut]`;
}

/** The end of `text` within `chars` (the latest conversation), saying how much was cut before it. */
function tail(text: string, chars: number): string {
  if (text.length <= chars) return text;
  return `[…${text.length - chars} characters cut] ${text.slice(-chars)}`;
}
