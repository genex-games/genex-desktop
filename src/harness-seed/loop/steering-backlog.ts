/**
 * The "Steering backlog" section older classic builds wrote into a game's NOTES.md: steering that
 * reached a build after its last round, kept there for the next run. NOTES.md is read in every
 * later chat, so a "stop the workers" said to one build told every later agent the work was
 * cancelled. Steering now stays with the build it was said to (its run's inbox, read again if that
 * build goes on), and the chat removes the studio's old section before it answers in that game.
 */
import { HostMethod } from "./host-methods.ts";
import type { HostCall } from "../types/harness.d.ts";

/** The NOTES.md heading the studio wrote the section under. */
export const STEERING_BACKLOG_HEADING = "## Steering backlog";
/** The game file the section lives in. */
const NOTES_FILE = "NOTES.md";
/** The section: its heading line, then everything up to the next `## ` heading or the end. */
const SECTION = /^## Steering backlog[^\n]*\n[\s\S]*?(?=^## |(?![\s\S]))/m;

/** `notes` without the studio's steering backlog section; unchanged when it has none. */
export function withoutSteeringBacklog(notes: string): string {
  if (!notes.includes(STEERING_BACKLOG_HEADING)) return notes;
  const removed = notes.replace(SECTION, "");
  return `${removed.trimEnd()}\n`;
}

/**
 * Remove the studio's steering backlog section from the game's NOTES.md, keeping everything else
 * as it was. Answers whether it removed one; a game it cannot read or write is left as it is.
 */
export async function dropSteeringBacklog(
  host: { call: HostCall },
  project: string | null | undefined,
): Promise<boolean> {
  if (!project) return false;
  const read = await host.call(HostMethod.GameRead, { project, file: NOTES_FILE }).catch(() => null);
  const text = typeof read === "string" ? read : ((read as { text?: string } | null)?.text ?? null);
  if (!text?.includes(STEERING_BACKLOG_HEADING)) return false;
  const kept = withoutSteeringBacklog(text);
  if (kept === text) return false;
  return host
    .call(HostMethod.GameWrite, { project, file: NOTES_FILE, contents: kept })
    .then(() => true)
    .catch(() => false);
}
