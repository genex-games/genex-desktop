/**
 * Genex's own fixed chat lines: what the chat is told when the person's Stop ends a turn or a
 * build before or while it works. Each is recorded in English, which the agents read later, with
 * its code (`genex_line` on the `messages` record), so the app shows it in the language Genex is
 * set to. The app's copy of the codes is `GenexLine` in `shared/event-log.ts`
 * (tests/conformance/seed-contracts.test.ts); never rename a value, the logs keep them.
 *
 * A module of its own, built only on names that `hooks.ts`, `run-events.ts` and `host-methods.ts`
 * exported before it, so a kept copy of any of them still loads it.
 */
import type { HarnessCtx } from "../types/harness.d.ts";
import { READY_WORDS } from "./hooks.ts";
import { HostMethod } from "./host-methods.ts";
import { EventKind } from "./run-events.ts";

/** Which of Genex's fixed lines a `messages` record says. */
export const GenexLine = {
  /** A chat turn the Stop ended: what its builder finished stays in the game. */
  Stopped: "stopped",
  /** A chat turn stopped while it waited for the game's apps to be ready. */
  StoppedWaiting: "stopped_waiting",
  /** A chat turn stopped before it started. */
  StoppedBeforeTurn: "stopped_before_turn",
  /** A build the chat asked for, stopped before it started. */
  StoppedBeforeBuild: "stopped_before_build",
} as const;
export type GenexLine = (typeof GenexLine)[keyof typeof GenexLine];

/** Each line in English: what the record keeps for the agents, and what an app that doesn't know its code shows. */
export const GENEX_LINE_TEXT = {
  [GenexLine.Stopped]: "Stopped. Finished edits are preserved; send a message to continue.",
  [GenexLine.StoppedWaiting]: READY_WORDS.stopped,
  [GenexLine.StoppedBeforeTurn]: "Stopped before it started — nothing was done. Send a message to go on.",
  [GenexLine.StoppedBeforeBuild]: "Stopped before the build started — nothing was built.",
} as const satisfies Record<GenexLine, string>;

/** The `messages` record of one of Genex's lines, said by the assistant. */
export function genexLineRecord(line: GenexLine) {
  return {
    type: EventKind.Messages,
    messages: [{ role: "assistant" as const, content: GENEX_LINE_TEXT[line] }],
    genex_line: line,
  };
}

/** Say one of Genex's lines in the chat as this turn's reply: recorded on the turn, then pushed. */
export async function sayGenexLine(ctx: HarnessCtx, turnId: string, line: GenexLine): Promise<void> {
  await ctx.call(HostMethod.TurnAppend, { turnId, batch: [genexLineRecord(line)] });
  ctx.notify("chat.message", { role: "assistant", content: GENEX_LINE_TEXT[line] });
}
