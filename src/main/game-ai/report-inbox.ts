/**
 * The Player report inbox of the creator's own published game (owner decision D9): the reports
 * genex.games holds for it, and Fix with agent, which saves one report's replay as a playtest the
 * in-app agent replays with `ai.replay`.
 *
 * What genex.games answers is hostile input: a list is read whole or refused, a bundle must be the
 * very report asked for, of this game's published self, and is redacted before anything is
 * written. The playtest goes only into the game's own `ai/tapes/`, every folder on the way a real
 * folder of the game (never a link), and never through a link planted at its name.
 */
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { playGameKey } from "../../shared/game-ai.ts";
import {
  type AiReportFixOutcome,
  AiReportFailure,
  type AiReportInboxItem,
  readAiReportBundle,
  readAiReportInbox,
  redactReportBundle,
  reportTapeName,
} from "../../shared/game-ai-report.ts";
import {
  AI_TAPE_EXTENSION,
  AI_TAPE_MAX_BYTES,
  AI_TAPE_MAX_LINES,
  AI_TAPES_DIR,
  readTapeLine,
  type TapeLine,
} from "../../shared/game-ai-tape.ts";
import { t } from "../../shared/i18n.ts";
import { ensureDirBelow, writeFileInDir } from "../../substrate/fsx.ts";
import type { GameAiInboxHost } from "./types.ts";

/** A library game as the inbox needs it: its folder, and its project on genex.games once published. */
export interface ReportInboxGame {
  /** The game's folder, resolved through the library. */
  root: string;
  /** Its genex.games project id; null while it was never published. */
  playProject: string | null;
}

/** What genex.games answered for one report's bundle. */
export type ReportSourceAnswer = { ok: true; body: unknown } | { ok: false; failure: AiReportFailure };

/** genex.games, as the inbox asks it: raw answers, read here. */
export interface ReportInboxSource {
  /** The reports of a published project; throws when they could not be fetched. */
  list(playProject: string): Promise<unknown>;
  /** One report's whole bundle. */
  bundle(playProject: string, id: string): Promise<ReportSourceAnswer>;
}

/** What the inbox runs on. */
export interface ReportInboxDeps {
  /** A library game by name, resolved by realpath; throws for one the library does not have. */
  game(project: string): Promise<ReportInboxGame>;
  source: ReportInboxSource;
}

const REFUSED: AiReportFixOutcome = { ok: false, failure: AiReportFailure.Refused };
const TOO_LARGE: AiReportFixOutcome = { ok: false, failure: AiReportFailure.TooLarge };

/** The playtest's file name for a report. */
const tapeFileName = (id: string): string => `${reportTapeName(id)}${AI_TAPE_EXTENSION}`;

/** Whether the game already has the playtest Fix with agent saved: a regular file in its own real `ai/tapes`. */
async function hasSavedTape(root: string, id: string): Promise<boolean> {
  const base = await realpath(root);
  const dir = path.join(base, AI_TAPES_DIR);
  if ((await realpath(dir).catch(() => null)) !== dir) return false;
  const info = await lstat(path.join(dir, tapeFileName(id))).catch(() => null);
  return info?.isFile() === true;
}

/** A tape's lines as the file holds them, or null when one no longer reads as a line after redaction. */
function tapeText(lines: readonly TapeLine[]): string | null {
  const rows: string[] = [];
  for (const line of lines) {
    const read = readTapeLine(line);
    if (!read) return null;
    rows.push(JSON.stringify(read));
  }
  return rows.length ? `${rows.join("\n")}\n` : "";
}

/** The inbox over genex.games and the game's own folder. */
export function createReportInbox(deps: ReportInboxDeps): GameAiInboxHost {
  return {
    async inbox(project: string): Promise<AiReportInboxItem[]> {
      const game = await deps.game(project);
      if (game.playProject === null) return [];
      const items = readAiReportInbox(await deps.source.list(game.playProject));
      if (!items) throw new Error(t("The game's reports can't be read right now"));
      return Promise.all(
        items.map(async (item) => ({
          ...item,
          tape: (await hasSavedTape(game.root, item.id)) ? reportTapeName(item.id) : null,
        })),
      );
    },

    async inboxFix(project: string, id: string): Promise<AiReportFixOutcome> {
      const game = await deps.game(project);
      if (game.playProject === null) return REFUSED;
      const answer = await deps.source.bundle(game.playProject, id);
      if (!answer.ok) return { ok: false, failure: answer.failure };
      const bundle = readAiReportBundle(answer.body);
      const ours = bundle?.id === id && bundle.game.key === playGameKey(game.playProject);
      if (!bundle || !ours) return REFUSED;
      const lines = redactReportBundle(bundle).replay.tape;
      if (lines.length > AI_TAPE_MAX_LINES) return TOO_LARGE;
      const text = tapeText(lines);
      if (text === null) return REFUSED;
      if (Buffer.byteLength(text) > AI_TAPE_MAX_BYTES) return TOO_LARGE;
      const dir = await ensureDirBelow(game.root, AI_TAPES_DIR.split("/"));
      await writeFileInDir(dir, tapeFileName(id), text);
      return { ok: true, tape: reportTapeName(id) };
    },
  };
}
