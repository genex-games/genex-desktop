/**
 * What the workspace's events remember between two moments: which way the person last asked to
 * go (read when home or a game comes up), one home visit, one Settings visit, and appearance
 * changes until they settle. In memory only, for this window; each takes its times as arguments,
 * so tests hold the clock. None of them sends anything itself.
 */
import { SECOND_MS } from "../../shared/duration.ts";
import type { SettingsSection } from "../settings-navigation.ts";
import type { WorkspaceEvent, WorkspaceEventProperties } from "./events/workspace.ts";
import { charsBucket, elapsedMs } from "./properties.ts";
import { DraftSource, type HomeLeftTo, NavVia, StageSwitchVia } from "./workspace-vocabulary.ts";

type Props<E extends WorkspaceEvent> = WorkspaceEventProperties[E];

/** How long a note of where the person asked to go waits for the screen it named. */
export const NAV_NOTE_MS = 3 * SECOND_MS;
/** How long an appearance field stays still before its change counts (a slider moves it many times). */
export const APPEARANCE_QUIET_MS = SECOND_MS;

/** One note, read once, and only while it is fresh. */
export interface Note<T> {
  /** Remember `value`, made at `at`. */
  note(value: T, at: number): void;
  /** The note still fresh at `at`, forgotten once read; `fallback` when there is none. */
  take(at: number, fallback: T): T;
}

/** A note that keeps for `freshMs`. */
export function createNote<T>(freshMs: number = NAV_NOTE_MS): Note<T> {
  let kept: { value: T; at: number } | null = null;
  return {
    note(value, at) {
      kept = { value, at };
    },
    take(at, fallback) {
      const fresh = kept !== null && at - kept.at <= freshMs && at >= kept.at;
      const value = fresh && kept ? kept.value : fallback;
      kept = null;
      return value;
    },
  };
}

/** How the person last asked to reach home or a game (`noteNav`). */
export const navNotes = createNote<NavVia>();

/** Remember how the person is about to reach home or a game: read when it comes up. */
export const noteNav = (via: NavVia, at: number = Date.now()): void => navNotes.note(via, at);

/** What is about to move the stage to another view: read by the layout store's watcher. */
export const stageNotes = createNote<StageSwitchVia>();

/** Remember what is about to move the stage; a move with no note is `other`. */
export const noteStageSwitch = (via: StageSwitchVia, at: number = Date.now()): void => stageNotes.note(via, at);

/** The stage watcher's read of the note, with `other` for a move nobody named. */
export const stageVia = { take: (at: number): StageSwitchVia => stageNotes.take(at, StageSwitchVia.Other) };

/** One home visit: from home coming up to a launch or to home going away. */
export interface HomeVisit {
  /** Whether a visit is going on. */
  open(): boolean;
  /** Home came up; the first home of the window is `launch`, a fresh note wins over both. */
  viewed(at: number, waiting: DraftSource | null): void;
  /** The way home was reached: a note, else `launch` for the window's first home, else `other`. */
  via(at: number): NavVia;
  /** Words are about to be put in the composer from `source` (a suggestion, the welcome's idea). */
  expect(source: DraftSource): void;
  /** The draft changed; the first words of the visit answer `home_draft_started`. */
  drafted(text: string, at: number): Props<typeof WorkspaceEvent.HomeDraftStarted> | null;
  /** Suggest prompt pressed. */
  suggested(draft: string): Props<typeof WorkspaceEvent.HomePromptSuggested>;
  /** The draft left as a launch: where its first words came from; the visit ends. */
  launched(): { fromSuggestion: boolean; fromWelcomeIdea: boolean };
  /** Home went away with `draft` in it: what was lost, unless the visit already ended. */
  left(draft: string, to: HomeLeftTo, at: number): Props<typeof WorkspaceEvent.HomeDraftDiscarded> | null;
}

/** A home visit's memory; `notes` is where navigation leaves its way in. */
export function createHomeVisit(notes: Note<NavVia> = navNotes): HomeVisit {
  let startedAt: number | null = null;
  let seen = false;
  let source: DraftSource | null = null;
  let expected: DraftSource | null = null;
  let suggestions = 0;
  const end = (): void => {
    startedAt = null;
    expected = null;
  };
  return {
    open: () => startedAt !== null,
    viewed(at, waiting) {
      startedAt = at;
      source = null;
      expected = waiting;
      suggestions = 0;
    },
    via(at) {
      const first = !seen;
      seen = true;
      return notes.take(at, first ? NavVia.Launch : NavVia.Other);
    },
    expect(next) {
      expected = next;
    },
    drafted(text, at) {
      if (startedAt === null || source !== null || !text.trim()) return null;
      source = expected ?? DraftSource.Typed;
      return { ms_since_home_viewed: elapsedMs(startedAt, at), source };
    },
    suggested(draft) {
      suggestions += 1;
      expected = DraftSource.Suggestion;
      return { nth_in_visit: suggestions, draft_was_empty: !draft.trim() };
    },
    launched() {
      const from = source;
      end();
      return { fromSuggestion: from === DraftSource.Suggestion, fromWelcomeIdea: from === DraftSource.WelcomeIdea };
    },
    left(draft, to, at) {
      if (startedAt === null || !draft.trim()) {
        end();
        return null;
      }
      const discarded = {
        chars_bucket: charsBucket(draft.trim().length),
        from_suggestion: source === DraftSource.Suggestion,
        dwell_ms: elapsedMs(startedAt, at),
        left_to: to,
      };
      end();
      return discarded;
    },
  };
}

/** The window's home visits. */
export const homeVisit = createHomeVisit();

/** One time Settings is open: when, where it went, and what changed or failed under it. */
export interface SettingsVisit {
  open(): boolean;
  /** Settings opened at `section`; false when it was open already. */
  opened(section: SettingsSection, at: number): boolean;
  /** Another section came up. */
  section(section: SettingsSection): void;
  /** A setting changed, or failed to. */
  changed(failed: boolean): void;
  /** An error was shown. */
  errored(): void;
  /** Settings closed: what the visit came to; null when it was not open. */
  closed(at: number): Props<typeof WorkspaceEvent.SettingsClosed> | null;
}

/** A Settings visit's memory. */
export function createSettingsVisit(): SettingsVisit {
  let visit: {
    at: number;
    last: SettingsSection;
    sections: Set<SettingsSection>;
    changes: number;
    errors: number;
  } | null = null;
  return {
    open: () => visit !== null,
    opened(section, at) {
      if (visit) return false;
      visit = { at, last: section, sections: new Set([section]), changes: 0, errors: 0 };
      return true;
    },
    section(section) {
      if (!visit) return;
      visit.last = section;
      visit.sections.add(section);
    },
    changed(failed) {
      if (!visit) return;
      visit.changes += 1;
      if (failed) visit.errors += 1;
    },
    errored() {
      if (visit) visit.errors += 1;
    },
    closed(at) {
      if (!visit) return null;
      const { last, sections, changes, errors } = visit;
      const dwell = elapsedMs(visit.at, at);
      visit = null;
      return { last_section: last, dwell_ms: dwell, sections_visited: sections.size, changes, errors_seen: errors };
    },
  };
}

/** The window's Settings visits. */
export const settingsVisit = createSettingsVisit();

/** Timers a settling tracker runs on. */
export interface QuietTimers {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const browserTimers: QuietTimers = {
  setTimeout: (run, ms) => globalThis.setTimeout(run, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Fields that count once they keep still for `quietMs`: a slider dragged across its range is one
 * change, not a hundred. `settled` hears each field once it has kept still.
 */
export function createQuietFields(
  settled: (field: string) => void,
  quietMs: number = APPEARANCE_QUIET_MS,
  timers: QuietTimers = browserTimers,
): (fields: readonly string[]) => void {
  const waiting = new Map<string, unknown>();
  return (fields) => {
    for (const field of fields) {
      timers.clearTimeout(waiting.get(field));
      waiting.set(
        field,
        timers.setTimeout(() => {
          waiting.delete(field);
          settled(field);
        }, quietMs),
      );
    }
  };
}
