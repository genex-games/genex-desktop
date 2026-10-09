/** The studio's own settings (Studio's header and Settings → Harness) and the bounds they are read within. */
import { DEFAULT_BUILDERS, MAX_BUILDERS } from "../../shared/builders.ts";
import { DEFAULT_POOL_MAX, MAX_POOL_MAX } from "../../substrate/preview-pool.ts";

/** 1..MAX_POOL_MAX; anything unusable is the default. */
export function clampAgents(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_POOL_MAX;
  return Math.max(1, Math.min(MAX_POOL_MAX, Math.round(n)));
}

/** 1..MAX_BUILDERS; anything unusable is the default. */
export function clampBuilders(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_BUILDERS;
  return Math.max(1, Math.min(MAX_BUILDERS, Math.round(n)));
}

/** The pool size every build before "Maximum workers" saved without ever being changed. */
export const LEGACY_DEFAULT_POOL = 6;
/** The worker count builds saved, unchanged, before settings.json recorded the default it was saved under. */
export const LEGACY_DEFAULT_BUILDERS = 2;

export interface StudioSettings {
  /**
   * Self-improvement, the switch in Studio's header (default ON). Off, Studio learns nothing:
   * no learning pass after a run or on request, no lessons, recipe or catalogue statistics
   * (the harness asks `learning.enabled` before each), no automatic apply, no architect. What
   * it already learned stays in use and can still be undone; the log keeps recording.
   */
  learning: boolean;
  /**
   * Apply suggestions automatically (Settings → Harness, default off on a fresh install): staged SkillOpt proposals
   * auto-apply the moment they land, and idle-time architect jobs may run. Off = they wait for
   * review. Only while `learning` is on. Succeeds the old `autoApplyImprovements` key — an
   * existing install that had auto-apply off keeps its choice.
   */
  selfImproving: boolean;
  /**
   * The idle-time architect (structural self-rewrites). Off by default since the v2 loop
   * landed: a proposal must pass the loop's self-test in its fork, not just
   * boot — and until the v2 seed has stabilised across runs, nobody should be rewriting it
   * unattended. The check catalogue and recipe library are the self-improvement that runs.
   */
  architect: boolean;
  /**
   * Maximum concurrent workers (Settings → Harness): the most builders a run may use at once. A ceiling,
   * not a target — the lead decides how many it starts. Four by default; twelve is the most offered.
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
}
