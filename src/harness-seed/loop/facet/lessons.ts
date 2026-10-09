/**
 * The lessons a facet's builder writes under `## Fixed by looking` and after `HARNESS:`, logged as
 * `facet_lessons` for SkillOpt once each: after every round, before a lost round's rollback takes
 * the notes away, and once more when the facet ends. A facet cut short by a crash has already
 * logged every round it finished.
 *
 * Its own module: a seed upgrade keeps a sibling the agent edited, and a new name imported from a
 * kept old keep.ts or facet-loop.ts would fail to link.
 */
import { lessonsFromNotes } from "./rules.ts";
import type { AnyRecord } from "../../types/harness.d.ts";

/** The most lessons one `facet_lessons` record carries. */
const MAX_LESSONS = 12;

/** What the lessons need of the loop: the lessons it logged so far, and who it is. */
type LessonLoop = { seenLessons?: Set<string>; facet: { id: string }; run: { runId?: string; project?: string } };

/**
 * The lessons in these notes the facet has not logged yet, at most a record's worth, now marked
 * as logged. A loop from before the field starts its own set.
 */
export function unseenLessons(loop: LessonLoop, notes: unknown): string[] {
  loop.seenLessons ??= new Set();
  const seen = loop.seenLessons;
  const fresh = lessonsFromNotes(notes)
    .filter((lesson) => !seen.has(lesson))
    .slice(0, MAX_LESSONS);
  for (const lesson of fresh) seen.add(lesson);
  return fresh;
}

/** The `facet_lessons` payload for these lessons: the run, the facet and the game they came from. */
export function lessonsPayload(loop: LessonLoop, lessons: string[]): AnyRecord {
  return { runId: loop.run.runId, facetId: loop.facet.id, project: loop.run.project, lessons };
}
