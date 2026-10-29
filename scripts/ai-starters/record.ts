/**
 * Write the AI starters' tapes: play each starter's demo on its authored answers (`answers.ts`) and
 * save what it asked, keyed as the host keys it, as `ai/tapes/<demo>.jsonl` beside the starter.
 * `--check` writes nothing and fails when a shipped tape is not what its starter and answers make
 * (a prompt, a schema or a site changed without recording again).
 *
 *   node scripts/ai-starters/record.ts           # write the tapes
 *   node scripts/ai-starters/record.ts --check   # verify them
 */
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { tapeLineText } from "../../src/shared/game-ai-tape.ts";
import { authorFor } from "./answers.ts";
import { playDemo, StarterLane } from "./lanes.ts";
import { STARTERS, type StarterSpec, starterTape } from "./starters.ts";

/** The seed a tape is recorded on: the first of the seeds a replay runs. */
export const RECORD_SEED = 1;

/** A starter's tape as its demo and its answers make it, or why they cannot. */
export async function starterTapeText(starter: StarterSpec): Promise<{ text: string } | { problem: string }> {
  const played = await playDemo(starter.play, {
    lane: StarterLane.Author,
    seed: RECORD_SEED,
    author: authorFor(starter.name),
  });
  const { invalid, lines, calls } = played.record;
  if (invalid > 0) return { problem: `${starter.name}: ${invalid} of ${calls} calls had no valid authored answer` };
  if (played.stuck > 0) return { problem: `${starter.name}: ${played.stuck} calls still waited when the demo ended` };
  return { text: lines.map(tapeLineText).join("") };
}

/** Write (or, with `check`, verify) every starter's tape; the problems found. */
export async function recordStarters({ check }: { check: boolean }): Promise<string[]> {
  const problems: string[] = [];
  for (const starter of STARTERS) {
    const made = await starterTapeText(starter);
    if ("problem" in made) {
      problems.push(made.problem);
      continue;
    }
    const file = starterTape(starter);
    const shipped = await readFile(file, "utf8").catch(() => null);
    if (shipped === made.text) continue;
    if (check)
      problems.push(`${starter.name}: ${starter.demo}'s tape is stale — run node scripts/ai-starters/record.ts`);
    else await writeFile(file, made.text);
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = await recordStarters({ check: process.argv.includes("--check") });
  for (const problem of problems) console.error(problem);
  process.exitCode = problems.length ? 1 : 0;
  if (!problems.length) console.log(`AI starters: ${STARTERS.length} tapes current`);
}
