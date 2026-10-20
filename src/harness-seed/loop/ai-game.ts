/**
 * Routing a game that calls a model in play to the AI method, by its typed word only (`game.ai`, the
 * plan's `ai` and studio.json's game block; never by matching what a plan or a person says). Such a
 * game's builders find the method — the workspace's own `skills/llm-games.md`, which a seed upgrade
 * keeps when the agent edited it — in `.studio/AI.md` beside their brief, with the starters
 * (`library/ai-starters/`) in `.studio/ai-starters/`, and their brief says so;
 * its entry owner's board carries the AI checks (`spec.ts` `withHarnessChecks`).
 *
 * Its own module so a kept older facet phase or library.ts never asks a newer sibling for it.
 */
import { copyFile, lstat, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { writeWorktreeFile } from "./library.ts";
import { AI_METHOD_FILE_PATH, aiBriefLine } from "./ai-game-prompts.ts";
import { type AiRequirement, aiRequirementOf } from "./ai-contract.ts";

export { AI_METHOD_FILE_PATH, aiBriefLine };

/** The skill that is the AI method, by its slug (`skills/<slug>.md`). */
export const AI_METHOD_SKILL = "llm-games";
/** The method's file in a worktree's `.studio/`. */
export const AI_METHOD_FILE = path.posix.basename(AI_METHOD_FILE_PATH);

/** Where the starters are in the harness workspace, and where a builder finds them beside its brief. */
export const AI_STARTERS_DIR = "library/ai-starters";
export const AI_STARTERS_PATH = ".studio/ai-starters";
/** The most files and bytes the starters copy into one worktree: a guard, never a limit they reach. */
const STARTERS_MAX_FILES = 200;
const STARTERS_MAX_FILE_BYTES = 1024 * 1024;

/** A skill's front matter, as its first lines spell it. */
const FRONT_MATTER = /^---[\s\S]*?---\n?/;

/** The AI a game declares, from its typed word only; null when it declares none. */
export function aiOfGame(game: { ai?: unknown } | null | undefined): AiRequirement | null {
  return aiRequirementOf(game?.ai);
}

/** The workspace's AI method without its front matter; "" when it has none. */
export async function aiMethodText(workspace: string): Promise<string> {
  const text = await readFile(path.join(workspace, "skills", `${AI_METHOD_SKILL}.md`), "utf8").catch(() => "");
  return text.replace(FRONT_MATTER, "");
}

/** One folder's entries, or none when it cannot be read. */
const entriesOf = (dir: string) => readdir(dir, { withFileTypes: true }).catch(() => []);

/**
 * Copy the workspace's starters into a worktree's `.studio/ai-starters/`: regular files and folders
 * only — a link is never followed, in or out of the starters — at most `STARTERS_MAX_FILES` files of
 * `STARTERS_MAX_FILE_BYTES` each. `.studio/` is ignored by git, so nothing here reaches a commit.
 */
async function copyStarters(workspace: string, worktree: string): Promise<void> {
  const from = path.join(workspace, AI_STARTERS_DIR);
  const to = path.join(worktree, AI_STARTERS_PATH);
  const queue = [""];
  let copied = 0;
  while (queue.length && copied < STARTERS_MAX_FILES) {
    const rel = queue.shift() ?? "";
    for (const entry of await entriesOf(path.join(from, rel))) {
      const child = path.join(rel, entry.name);
      if (entry.isDirectory()) queue.push(child);
      else if (entry.isFile() && copied < STARTERS_MAX_FILES && (await copyRegular(from, to, child))) copied += 1;
    }
  }
}

/** Copy one regular file of the starters; false for a link, a special file or one too large. */
async function copyRegular(from: string, to: string, rel: string): Promise<boolean> {
  const info = await lstat(path.join(from, rel)).catch(() => null);
  if (!info?.isFile() || info.size > STARTERS_MAX_FILE_BYTES) return false;
  await mkdir(path.dirname(path.join(to, rel)), { recursive: true });
  await copyFile(path.join(from, rel), path.join(to, rel));
  return true;
}

/**
 * Write the AI method into a builder's worktree (`.studio/AI.md`) when its game declares AI; the
 * path the brief names, or null when the game declares none or the workspace holds no method.
 */
export async function writeAiMethodFile(
  workspace: string,
  worktree: string,
  game: { ai?: unknown } | null | undefined,
): Promise<string | null> {
  if (!aiOfGame(game)) return null;
  const method = await aiMethodText(workspace);
  if (!method.trim()) return null;
  await writeWorktreeFile(worktree, AI_METHOD_FILE, method);
  await copyStarters(workspace, worktree);
  return AI_METHOD_FILE_PATH;
}
