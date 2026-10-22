/**
 * The words a chat session is given when the person changed how its turn runs while it worked
 * (steer-switch.ts, chat-steer.ts): what changed, in front of the leg's own prompt; and after a
 * slash command the person sent mid-turn, what the turn goes on with.
 */

import { WorkerTool } from "./workers/contract.ts";

/** Each message as a quote block, so the session reads it as the person's own words. */
function quoted(texts: readonly string[]): string[] {
  return texts.filter((text) => String(text).trim()).map((text) => `> ${String(text).trim().replace(/\n/g, "\n> ")}`);
}

/** What changed while the session worked, in front of `prompt`: one line each, then the prompt. */
export function switchedTurnPrompt(notes: readonly string[], prompt: string): string {
  return [
    "While you were working, the user changed how you work. From now on:",
    ...notes.map((note) => `- ${note}`),
    "",
    prompt,
  ].join("\n");
}

/**
 * The leg after a slash command the person sent while the session worked: the command has run;
 * when it cut the work short, the session carries it on; and anything they wrote with it.
 */
export function afterCommandPrompt(texts: readonly string[], carryOn: boolean): string {
  const lines = ["The command the user sent has run."];
  if (carryOn) lines.push("Carry on with what you were doing before it, unless it changed what they want.");
  const said = quoted(texts);
  if (said.length) lines.push("", "They also wrote this while you were working — address it:", ...said);
  return lines.join("\n");
}

/** The notes a switch opens the next leg with (delegated-turn.ts): one per setting that changed. */
export const SWITCH_NOTES = {
  model: (label: string) => `You now run on ${label}.`,
  engine: (label: string) =>
    `${label} takes over this chat: you are a new session, so read the conversation below before you act.`,
  loopOn: (tool: string, hours: number | null) =>
    `The Loop is on${hours === null ? " (until the ask is done)" : ` (${hours} h)`}: you may start a build with ${tool} when the ask needs one, or answer and edit yourself as before.`,
  loopHours: (hours: number | null) =>
    `The Loop's time changed: a build you start now runs ${hours === null ? "until the ask is done" : `for ${hours} h`}.`,
  loopOff: "The Loop is off: do what they ask yourself, and do not start a build.",
  loopRoles: "The Loop's roles changed: a build you start now uses the models they picked.",
  planReview: (on: boolean) =>
    on
      ? "A build you start now waits for them to read its plan first."
      : "A build you start now goes ahead without waiting for them to read its plan.",
  reopenOn: "The Loop is on: more work on the finished build goes to it with reopen_run, as your notes say.",
  moodBoard: (count: number) => `They sent a new mood board (${count} picture${count === 1 ? "" : "s"}) for the build.`,
  workersCarry: (count: number) =>
    `${count} worker${count === 1 ? " you started is" : "s you started are"} still working: a build you start takes ${count === 1 ? "it" : "them"} over and they keep going.`,
  dropped: (tools: readonly string[]) =>
    `The ${tools.join(" and ")} call you made before this change did not go out: make it again if it still fits the new settings.`,
  workersLand: (count: number) =>
    `${count} worker${count === 1 ? " you started is" : "s you started are"} still working: wait for ${count === 1 ? "it" : "them"} (${WorkerTool.Wait}) and mark what ${count === 1 ? "it" : "they"} made (${WorkerTool.Mark}) before you start a build. When the build starts, a worker writing in the game folder itself is waited for; any other still working stops.`,
} as const;

/** What a tool that only waits answers when the person's words ended its wait (person-wrote.ts). */
export const WAIT_ENDED = {
  workers: `The user just wrote in the chat, so this wait ended early: read their message and answer it, then wait again (${WorkerTool.Wait}) if you still need to.`,
  judge:
    "The user just wrote in the chat, so the wait for the busy reviewer ended early: read their message and answer it, then ask again if you still need the verdict.",
} as const;

/** What a build's lead reads beside the person's words once its wrap-up began (live-chat.ts). */
export const WRAPPING_UP_NOTE =
  "(You are wrapping up this build. Answer them briefly; a stop or finish they ask for is yours now. Anything else — more work, a change — the chat takes up itself as soon as this build has closed, so finish the wrap-up.)";
