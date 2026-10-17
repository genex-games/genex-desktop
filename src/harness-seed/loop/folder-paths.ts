/**
 * Paths an agent names inside a folder it works in (the game's, a lead's copy): refused by their
 * shape alone (absolute, a climb, a hidden folder), and followed through every link to where they
 * really are, which must stay inside the folder they are named in.
 */
import { realpath } from "node:fs/promises";
import path from "node:path";

/** Why an input path is refused before anything starts. */
const INPUT_PROBLEM = {
  NotGamePath: "is not a path inside the game folder",
  Climbs: "climbs out of the game folder",
  Hidden: "is in a hidden folder",
  Missing: "is not in the game folder",
  Outside: "leads outside the game folder",
} as const;

/** Why a game-folder path is refused by its shape alone, or null when its shape is fine. */
export function pathShapeProblem(rel: string): string | null {
  const absolute = path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.startsWith("~");
  if (absolute || rel.includes("\\") || rel.includes("\0")) return INPUT_PROBLEM.NotGamePath;
  const segments = rel.split("/");
  if (segments.includes("..")) return INPUT_PROBLEM.Climbs;
  if (segments.some((s) => s === "" || s === ".")) return INPUT_PROBLEM.NotGamePath;
  return segments.some((s) => s.startsWith(".")) ? INPUT_PROBLEM.Hidden : null;
}

/**
 * Where `rel` really is when it stays inside `root` once every link is followed: `{ real }`, or
 * `{ problem }` when it is missing or leads out.
 */
export async function realInside(root: string, rel: string): Promise<{ real: string } | { problem: string }> {
  let base: string;
  let real: string;
  try {
    base = await realpath(root);
    real = await realpath(path.join(root, rel));
  } catch {
    return { problem: INPUT_PROBLEM.Missing };
  }
  return real === base || real.startsWith(`${base}${path.sep}`) ? { real } : { problem: INPUT_PROBLEM.Outside };
}
