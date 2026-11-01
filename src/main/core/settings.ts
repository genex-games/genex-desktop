/** The studio's own settings (Studio's header, Settings → Harness and Permissions) and the bounds they are read within. */
import { DEFAULT_BUILDERS } from "../../shared/builders.ts";
import { MAX_WORKERS_AT_ONCE } from "../../shared/workers.ts";
import { DEFAULT_POOL_MAX, MAX_POOL_MAX } from "../../substrate/preview-pool.ts";
import { isLanguageChoice, type LanguageChoice, SYSTEM_LANGUAGE } from "../../shared/locale.ts";

/** A saved language, or System for anything this version does not know. */
export function savedLanguage(value: unknown): LanguageChoice {
  return isLanguageChoice(value) ? value : SYSTEM_LANGUAGE;
}

/** 1..MAX_POOL_MAX; anything unusable is the default. */
export function clampAgents(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_POOL_MAX;
  return Math.max(1, Math.min(MAX_POOL_MAX, Math.round(n)));
}

/** 1..MAX_WORKERS_AT_ONCE, the most a lead's pool runs at once; anything unusable is the default. */
export function clampBuilders(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_BUILDERS;
  return Math.max(1, Math.min(MAX_WORKERS_AT_ONCE, Math.round(n)));
}

/** The pool size every build before "Maximum workers" saved without ever being changed. */
export const LEGACY_DEFAULT_POOL = 6;
/** The worker count builds saved, unchanged, before settings.json recorded the default it was saved under. */
export const LEGACY_DEFAULT_BUILDERS = 2;

export interface StudioSettings {
  /**
   * Self-improvement, the switch in Studio's header (default off: self-improvement is stopped, and
   * an install saved before the stop is switched off once). Off, the harness changes nothing of its
   * own code, prompts or skills (`guardian.write_self` refuses). What it already changed stays in
   * use and can still be undone; the log keeps recording.
   */
  learning: boolean;
  /**
   * Maximum concurrent workers (Settings → Harness): the most builders a run may use at once. A ceiling,
   * not a target — the lead decides how many it starts. Four by default; the most offered is the most
   * a lead's pool runs at once (`MAX_WORKERS_AT_ONCE`, eight), and a count saved above it reads as it.
   */
  buildersMax: number;
  /**
   * The preview-pool ceiling that sizes a run's parallelism: `buildersMax` plus the lead's own
   * windows. Kept on disk for older builds; an older caller may still set it directly.
   */
  agentsMax: number;
  /**
   * The modeller (AG-930): may builders reach for headless Blender? On by default; the picker
   * shows it beside the model because it reads as "this builder may model". A setting rather
   * than a per-run flag so chat builds get the same switch and nothing is copied through the
   * first-run extraction preference. Plugin enablement owns subsequent changes.
   */
  blender: boolean;
  /**
   * Resume builds automatically (Settings → Harness, default ON): a build an engine limit paused
   * resumes once the limit resets, and one the loop's crash paused resumes once it runs again —
   * bounded per run, never after the user's Stop or Finish (`core/auto-resume.ts`).
   */
  autoResume: boolean;
  /**
   * Let agents control your computer (Settings → Permissions, default OFF for every install, new
   * or existing; macOS and Windows). Off, no session is handed the `desktop` tool, no consent card shows,
   * cua-driver never starts and `desktop.computer` answers that it is off; turning it off stops a
   * running driver. On, each chat session and each app still asks first (`core/desktop-tools.ts`).
   */
  computerControl: boolean;
  /**
   * The app's language (Settings → Appearance), or System for the computer's. The window keeps
   * its own copy to load before main answers (`renderer/language.ts`); main's menus, dialogs and
   * notifications read this one.
   */
  language: LanguageChoice;
}
