/**
 * Keep building: after a Loop ended with something still to fix, the person's one tap starts the
 * chat's Loop again on what is left. The chat's result card and the Builds card both ask the chat
 * that owns the run through this event; the chat sends it through its composer (`loopOn`).
 */
import { RunState } from "../shared/run-state.ts";
import type { HistoryEntry } from "./build-progress.ts";
import type { ComposerExtras } from "./ui/PromptBar.tsx";
import { STILL_TO_FIX_WORDS } from "./words.ts";

export const KEEP_BUILDING_EVENT = "studio:keep-building";

/** A Keep building tap: the chat whose run it was, and what that run left to fix. */
export interface KeepBuildingAsk {
  threadId: string;
  notDone: string[];
}

/** A Keep building tap on a card: what is left; true once its message went out. */
export type KeepBuildingTap = (notDone: string[]) => Promise<boolean>;

/** The tap as the open chat takes it: it marks it `taken`, and answers whether its message went out. */
export interface KeepBuilding extends KeepBuildingAsk {
  taken?: boolean;
  answer: (sent: boolean) => void;
}

/**
 * Ask the chat that owns the run to keep building on what is left; true once its message went out
 * (false when no open chat took it, or it sent nothing: a sign-in first, a Loop this game can't run).
 */
export function keepBuilding(ask: KeepBuildingAsk): Promise<boolean> {
  return new Promise((resolve) => {
    const detail: KeepBuilding = { ...ask, answer: resolve };
    window.dispatchEvent(new CustomEvent<KeepBuilding>(KEEP_BUILDING_EVENT, { detail }));
    if (!detail.taken) resolve(false);
  });
}

/**
 * Whether a chat's result card offers Keep building: only its newest one (`latest`), and only while
 * nothing of the chat runs or waits paused (a Resume belongs to that run).
 */
export function keepsBuildingIn(
  card: { latest?: true },
  chat: { activeRunId: string | null; pausedRunId: string | null },
): boolean {
  return card.latest === true && !chat.activeRunId && !chat.pausedRunId;
}

/** A send that runs one at a time: a call while the last one is under way sends nothing (false). */
export function oneAtATime<Args extends unknown[]>(
  send: (...args: Args) => Promise<boolean>,
): (...args: Args) => Promise<boolean> {
  let busy = false;
  return async (...args) => {
    if (busy) return false;
    busy = true;
    try {
      return await send(...args);
    } finally {
      busy = false;
    }
  };
}

/**
 * Whether the Builds card offers Keep building on a run: only on the chat's newest build, once it
 * ended (a paused one keeps Resume, and a newer build or chat turn makes this one history).
 */
export function keepsBuildingOn(builds: readonly HistoryEntry[], runId: string | null | undefined): boolean {
  const newest = builds.at(-1);
  if (!runId || !newest || newest.chat) return false;
  return newest.runId === runId && newest.state === RunState.Finished;
}

/** The message Keep building sends: what is left, as the person's ask. */
export const keepBuildingAsk = (notDone: readonly string[]): string => STILL_TO_FIX_WORDS.ask(notDone);

/** A Loop commission sent with Keep building's mark, or none when the chat's Loop can't run here. */
export function keepBuildingExtras(extras: ComposerExtras): ComposerExtras | null {
  return extras.autopilot ? { ...extras, autopilot: { ...extras.autopilot, keepBuilding: true } } : null;
}
