/**
 * One owner of the screen. The part the director starts with `critic=screen` owns what the player
 * sees laid over the game — the HUD, the menus, the layout — and every other part publishes its
 * values (in `__studio.state()`, or the owner's model) instead of drawing them, so no part draws
 * readouts of its own beside the HUD part's.
 *
 * The rule is a source-code pattern over a diff's added lines, like the reviewer's Math.random rule:
 * a call into the template's contract HUD (`__studio.hud.…`, or `hud.text(…)` and its siblings) in
 * a part that does not own the screen, while another part does. A game of its own shape draws however
 * it already did, and a run where no part owns the screen is as it was. A new module, so a kept older
 * sibling can never shadow these names; it imports only a type from review.ts.
 */
import type { Violation } from "./review.ts";

/** The critic a part is reviewed by when it is the screen's (judge.ts `CRITIC_PRINCIPLES` key). */
export const SCREEN_CRITIC = "screen";

/** A finding's category: a part drew on the screen another part owns. */
export const SCREEN_OWNER_CATEGORY = "screen-owner";

/**
 * A line that draws on or changes the contract HUD, on `__studio.hud` or a handle to it: the
 * drawing calls (template `src/hud.js` `HudItemKind`, the screen flash, a font) and the ones that
 * remove, clear or switch it. Reading it (`get`, `items`) is a probe, not drawing.
 */
const HUD_CALL = /\bhud\.(?:text|bar|crosshair|flash|arc|path|image|panel|font|remove|clear|enable)\s*\(/;

/** Game code the rule reads: JavaScript or TypeScript. */
const SOURCE_FILE = /\.(?:m?js|ts)$/;

/** The contract's own modules, beside the entry's contract file: the HUD is defined there, not drawn. */
const CONTRACT_FILES = ["studio.js", "studio.d.ts", "hud.js"] as const;

/** What the rule says to a part that drew on a screen it does not own. */
const MESSAGE = {
  what: (owner: string) => `draws on the screen, which part "${owner}" owns`,
  fix: "publish the value in __studio.state() or the screen owner's model; the screen owner decides where it goes",
} as const;

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

/** The part that owns the screen while this one does not: its id, or null when the rule is inert. */
function otherOwner(spec: ScreenSpec): string | null {
  if (spec.ownsScreen === true) return null;
  return typeof spec.screenOwner === "string" && spec.screenOwner ? spec.screenOwner : null;
}

/** Is this file game code the rule reads, and not the contract's own module? */
function drawsFrom(file: string): boolean {
  const base = file.slice(file.lastIndexOf("/") + 1);
  return SOURCE_FILE.test(file) && !CONTRACT_FILES.some((name) => name === base);
}

/** The added lines of one file that draw on a screen another part owns; none in a game of its own shape. */
export function screenOwnership({ file, added, spec, template }: ScreenReview): Violation[] {
  const owner = otherOwner(spec);
  if (!template || !owner || !drawsFrom(file)) return [];
  return added
    .filter(({ text }) => HUD_CALL.test(text))
    .map(({ line }) => ({
      file,
      line,
      category: SCREEN_OWNER_CATEGORY,
      what: MESSAGE.what(owner),
      fix: MESSAGE.fix,
      source: "mechanical",
    }));
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
 * reads its spec live, so their next review applies it). A part that `replaces` the owner (its
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
    for (const each of specs) each.screenOwner = spec.id;
    spec.screenOwner = spec.id;
    return;
  }
  const owner = [...specs].reverse().find((each) => each.ownsScreen === true);
  if (owner) spec.screenOwner = owner.id;
}
