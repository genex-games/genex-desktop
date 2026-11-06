/**
 * The sidebar's second line under each game on Genex (mockup C1): Public, In review, Human review,
 * Not approved, Taken down, Fixing {n} things while a Fix with agent press is with the agent, and
 * Checking fixes once the fixed app went again. It comes from what Studio already keeps: the Genex
 * plugin's kept review (`review.json`, never a read of Genex), the game chat's fix records, and the
 * publish record, which says Public for any game listed on Genex, a web game's too. A game Genex does
 * not know has no line.
 *
 * Each game's review part is kept in memory until its review changes (`forget`, on every
 * `UiEvent.GenexReviewChanged`, which a fix's end says too, even one with no step after it); the
 * publish record is read each time, so a web publish shows at once. A game with no chat is read as
 * one with no fix: reading never makes a chat.
 * Electron-free: the games, the kept review, the chat and the publish record come in as deps.
 */
import type { EventEnvelope } from "../../shared/event-log.ts";
import {
  GenexAppReview,
  type GenexReviewRecord,
  type GenexReviewStatus,
  type GenexSidebarEntry,
  GenexSidebarLine,
  sidebarLineOf,
} from "../../shared/genex-review.ts";
import { fixWorkEnded, type GenexFixState, newestFix, sentByFix } from "../../shared/genex-review-log.ts";

/** What the lines are read from. */
export interface ReviewLinesDeps {
  /** The games on Genex: each whose publish record has a link there. */
  games(): Promise<string[]>;
  /** The Genex plugin's kept review of the game, read without asking Genex. */
  status(project: string): Promise<GenexReviewStatus>;
  /** The game chat's log, where its fix presses are. */
  events(project: string): Promise<readonly EventEnvelope[]>;
  /** Whether the game's publish record says it is listed on Genex. */
  published(project: string): Promise<boolean>;
}

/** The sidebar's lines over their deps. */
export interface ReviewLines {
  /** Each game's line that has one, by game. */
  lines(): Promise<Record<string, GenexSidebarEntry>>;
  /** The game's review or fix changed: its line is read again next time. */
  forget(project: string): void;
}

/** What a game's line is made from. */
export interface ReviewLineInput {
  record: GenexReviewRecord | null;
  fix: GenexFixState | null;
  /** The agent still works on the newest fix press. */
  fixing: boolean;
}

/** Whether Genex checks the very build the fix sent again: a later publish is In review, not Checking fixes. */
const checkingFixes = (input: ReviewLineInput): boolean =>
  input.record?.apps.some((app) => app.state === GenexAppReview.Checking && sentByFix(input.fix, app)) ?? false;

/** A game's line from its review and its newest fix press; null when the review says nothing. */
export function reviewLineOf(input: ReviewLineInput): GenexSidebarEntry | null {
  if (input.fix && input.fixing) return { line: GenexSidebarLine.Fixing, things: input.fix.count };
  if (checkingFixes(input)) return { line: GenexSidebarLine.CheckingFixes };
  const line = sidebarLineOf(input.record);
  return line ? { line } : null;
}

/** The game's line: its review's, else Public when its publish record says it is listed. */
export function sidebarEntryOf(review: GenexSidebarEntry | null, published: boolean): GenexSidebarEntry | null {
  if (review) return review;
  return published ? { line: GenexSidebarLine.Public } : null;
}

/** The review part of a game's line, read from its kept review and its chat. */
async function reviewPart(deps: ReviewLinesDeps, project: string): Promise<GenexSidebarEntry | null> {
  const [status, events] = await Promise.all([deps.status(project), deps.events(project)]);
  const fix = newestFix(events, project);
  const fixing = fix !== null && fix.outcome === undefined && fixWorkEnded(events, fix) === null;
  return reviewLineOf({ record: status.record, fix, fixing });
}

/** The sidebar's lines, each game's review part kept until it is forgotten. */
export function reviewLines(deps: ReviewLinesDeps): ReviewLines {
  const kept = new Map<string, Promise<GenexSidebarEntry | null>>();
  const partOf = (project: string): Promise<GenexSidebarEntry | null> => {
    const known = kept.get(project);
    if (known) return known;
    const read = reviewPart(deps, project).catch(() => {
      // A failed read is not kept: the next ask reads again.
      kept.delete(project);
      return null;
    });
    kept.set(project, read);
    return read;
  };
  return {
    async lines() {
      const games = await deps.games().catch(() => [] as string[]);
      const lines: Record<string, GenexSidebarEntry> = {};
      // One game after another: each part is a plugin call and a log read.
      for (const project of games) {
        const published = await deps.published(project).catch(() => false);
        const entry = sidebarEntryOf(await partOf(project), published);
        if (entry) lines[project] = entry;
      }
      for (const project of kept.keys()) if (!games.includes(project)) kept.delete(project);
      return lines;
    },
    forget(project) {
      kept.delete(project);
    },
  };
}
