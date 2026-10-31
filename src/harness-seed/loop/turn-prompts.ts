/**
 * The words a chat turn on an engine with no session of its own (Ollama's tool loop) adds to its
 * model's prompt: that a Loop cannot run on it, and the note that puts attached pictures in front of
 * the model. Such a chat is plain chat: it answers and edits the game itself.
 */
import type { AnyRecord } from "../types/harness.d.ts";

/** What a direct engine's chat is told when the composer's Loop is on: it cannot lead one. */
export const NO_LOOP_HERE =
  "## Loop is ON, but this engine can't run one\n\nA Loop is led by an engine that keeps a session of its own (Claude Code, Codex, OpenCode, Grok Build or a local model's session). This one keeps none, so answer and work in this chat; if the user wants a Loop, tell them to pick such an engine.";

/** The extra system text a turn runs with: a Loop's note, or its own. */
export function turnBriefing(options: {
  autopilot?: AnyRecord | null;
  loop?: AnyRecord | null;
  extraSystem?: string;
}): string | undefined {
  if (options.autopilot || options.loop) return NO_LOOP_HERE;
  return options.extraSystem;
}

/** The note that puts this turn's pictures in front of the model. */
export function lookAtPictures(labels: string): string {
  return `Look at these pictures (${labels}). A path is not a picture.`;
}
