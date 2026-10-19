/**
 * A game's saved playtests on disk: `<game>/ai/tapes/<demo>.jsonl`, one answer a line. The game's
 * folder is agent-writable, so every path is realpath-contained in it: the tapes folder may not lead
 * out of the game, a tape is opened without following a link, never blocks on a FIFO and never
 * reads past its cap, and a recording is written only into a folder made below the game without a
 * link on the way. A demo's name is checked before the disk is touched. Lines are read as hostile
 * input (`readTape`); a damaged line is counted, never thrown.
 */
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  AI_TAPE_EXTENSION,
  AI_TAPE_MAX_BYTES,
  AI_TAPE_MAX_LINES,
  AI_TAPES_DIR,
  isTapeName,
  readTape,
  tapeLineText,
  type TapeLine,
} from "../../shared/game-ai-tape.ts";
import type { AiTapeSummary } from "../../shared/game-ai-views.ts";
import { ensureDirBelow, readRegularFile, realpathNearest, writeFileInDir } from "../../substrate/fsx.ts";
import { containedReal, isBelow } from "../../substrate/paths.ts";
import type { GameAiTapes } from "./types.ts";

/** The most tapes one game's list reads. */
const MAX_LISTED_TAPES = 200;
/** The tapes folder's parts below the game's folder. */
const TAPES_PARTS = AI_TAPES_DIR.split("/");

const MESSAGE = {
  badName: (name: string) => `not a saved playtest's name: ${JSON.stringify(name.slice(0, 80))}`,
  outside: "the game's saved playtests lead out of its folder",
} as const;

/** A demo's name, or a refusal before anything is read or written. */
function demoName(name: string): string {
  if (!isTapeName(name)) throw new Error(MESSAGE.badName(String(name)));
  return name;
}

/**
 * The game's tapes folder by real path, contained in the game; null when the game has none. A folder
 * on the way that leads out of the game is refused even when what it leads to has no tapes.
 */
async function tapesDir(game: string): Promise<string | null> {
  const base = await realpath(game);
  const target = await realpathNearest(path.join(base, ...TAPES_PARTS));
  if (!isBelow(base, target)) throw new Error(MESSAGE.outside);
  try {
    return await containedReal(base, AI_TAPES_DIR);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** A tape's text: no link, no FIFO, never past the cap. */
async function tapeText(dir: string, name: string): Promise<string> {
  return (await readRegularFile(path.join(dir, `${name}${AI_TAPE_EXTENSION}`), AI_TAPE_MAX_BYTES)).toString("utf8");
}

/** One tape's summary, or null when it is not a tape that can be read. */
async function summaryOf(dir: string, name: string): Promise<AiTapeSummary | null> {
  try {
    const text = await tapeText(dir, name);
    const read = readTape(text);
    const info = await lstat(path.join(dir, `${name}${AI_TAPE_EXTENSION}`));
    return {
      name,
      calls: read.lines.length,
      sites: [...new Set(read.lines.map((line) => line.site))].sort(),
      rejected: read.rejected,
      bytes: Buffer.byteLength(text),
      recordedAt: info.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

/** The demo names in a tapes folder: regular files named like a tape, links and others skipped. */
async function tapeNames(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(AI_TAPE_EXTENSION))
    .map((entry) => entry.name.slice(0, -AI_TAPE_EXTENSION.length))
    .filter((name) => isTapeName(name))
    .sort()
    .slice(0, MAX_LISTED_TAPES);
}

/** A recording: lines kept as answers settle, written whole on close, within the tape's caps. */
async function recording(game: string, name: string) {
  const dir = await ensureDirBelow(game, TAPES_PARTS);
  const lines: string[] = [];
  let bytes = 0;
  let open = true;
  return {
    append: async (line: TapeLine) => {
      const text = tapeLineText(line);
      const size = Buffer.byteLength(text);
      if (!open || lines.length >= AI_TAPE_MAX_LINES || bytes + size > AI_TAPE_MAX_BYTES) return;
      lines.push(text);
      bytes += size;
    },
    close: async () => {
      if (!open) return;
      open = false;
      await writeFileInDir(dir, `${name}${AI_TAPE_EXTENSION}`, lines.join(""));
    },
  };
}

/** The tapes of games on this Mac; `game` is the game's folder, which the caller resolved through the library. */
export function createGameAiTapes(): GameAiTapes {
  return {
    async list(game) {
      const dir = await tapesDir(game);
      if (!dir) return [];
      const summaries = await Promise.all((await tapeNames(dir)).map((name) => summaryOf(dir, name)));
      return summaries.filter((summary): summary is AiTapeSummary => summary !== null);
    },
    async read(game, demo) {
      const name = demoName(demo);
      const dir = await tapesDir(game);
      if (!dir) throw Object.assign(new Error(MESSAGE.badName(name)), { code: "ENOENT" });
      return readTape(await tapeText(dir, name)).lines;
    },
    async record(game, demo) {
      return recording(game, demoName(demo));
    },
  };
}
