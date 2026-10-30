/**
 * The part that leads the screen. The part the director starts with `critic=screen` is reviewed as
 * the screen's (judge.ts `CRITIC_PRINCIPLES`) and answers for the HUD's layout checks a plan writes
 * (`HUD_LAYOUT_CHECKS`), and every part hears which part that is, so they can coordinate. How a part
 * draws on the screen is its builder's to decide (Loop phase 4): drawing there is no finding, and
 * `screenOwnership` finds nothing; its name stays for a kept older review.ts. A new module, so a
 * kept older sibling can never shadow these names; it imports only a type from review.ts.
 */
import type { Violation } from "./review.ts";
import { HUD_LAYOUT_CHECKS } from "./hud-layout.ts";

/** The critic a part is reviewed by when it is the screen's (judge.ts `CRITIC_PRINCIPLES` key). */
export const SCREEN_CRITIC = "screen";

/** A finding's category an older reviewer gave a part that drew on the screen another part owns: no longer raised. */
export const SCREEN_OWNER_CATEGORY = "screen-owner";

/** Take the HUD's layout checks off a part that does not draw it: it could never pass them by its own work. */
function dropHudLayout(spec: ScreenSpec): void {
  if (!Array.isArray(spec.checks)) return;
  spec.checks = spec.checks.filter((check: { id?: unknown }) => !HUD_LAYOUT_CHECKS.includes(String(check?.id)));
}

/** The part as the rule reads it: does it own the screen, and which part does. */
export interface ScreenSpec {
  ownsScreen?: unknown;
  screenOwner?: unknown;
  [field: string]: unknown;
}

/** One changed file, as the mechanical reviewer sees it (review.ts `FileReview`). */
export interface ScreenReview {
  file: string;
  added: ReadonlyArray<{ line: number; text: string }>;
  spec: ScreenSpec;
  template: boolean;
}

/**
 * A part drawing on a screen another part leads: no finding (Loop phase 4). The name stays for a kept
 * older review.ts that still asks.
 */
export function screenOwnership(_review: ScreenReview): Violation[] {
  return [];
}

/** A worker as the screen rule reads it. */
interface ScreenPart {
  id: string;
  spec?: ScreenSpec | null;
}

/** The running part that already owns the screen, by id; null when none does. */
export function runningScreenOwner(running: readonly ScreenPart[]): string | null {
  return running.find((part) => part.spec?.ownsScreen === true)?.id ?? null;
}

/**
 * Tell every part of the run who owns the screen, the newest owner winning: a part started later
 * learns the owner, and an owner started later is learnt by the parts already running (the loop
 * reads its spec live, so their next review applies it) — and they are no longer held to the
 * HUD's layout (`HUD_LAYOUT_CHECKS`), which is the owner's. A part that `replaces` the owner (its
 * restart) owns the screen in its place, whether or not it was started with critic=screen.
 */
export function linkScreenOwner(
  specs: readonly ScreenSpec[],
  spec: ScreenSpec & { id?: unknown },
  replaces?: string | null,
): void {
  const restartsOwner = Boolean(replaces) && specs.some((each) => each.id === replaces && each.ownsScreen === true);
  if (restartsOwner) spec.ownsScreen = true;
  if (spec.ownsScreen === true) {
    for (const each of specs) {
      each.screenOwner = spec.id;
      if (each !== spec) dropHudLayout(each);
    }
    spec.screenOwner = spec.id;
    return;
  }
  const owner = [...specs].reverse().find((each) => each.ownsScreen === true);
  if (owner) spec.screenOwner = owner.id;
}
