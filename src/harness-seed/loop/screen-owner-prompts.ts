/**
 * What a builder is told about the screen's one owner (loop/screen-owner.ts). The rule already had
 * teeth — a non-owner's call into the contract HUD is a code-review finding — but a builder that
 * reads nothing about the owner draws its own readouts beside the HUD part's and learns the rule
 * only from the review. The brief and the opening prompt
 * say it now, from the spec's typed fields and never from its words; a run where no part owns the
 * screen renders nothing here. A new module, so a kept older sibling can never shadow these names.
 */

/** The part as the lines read it: the same two fields the screen-owner rule reads. */
export interface ScreenOwnerSpec {
  ownsScreen?: unknown;
  screenOwner?: unknown;
}

/** What each side of the rule is told. */
const SCREEN_OWNER_WORDS = {
  owner:
    "- YOU OWN THE SCREEN: this part draws the HUD, the menus and the layout for the whole game — the title, the start on a key, the countdown and the results among them; a title, start key or countdown comes with config.begin and config.flow, or every judge sees the title, not the game. The other parts publish their values in __studio.state() or their module's API; read them there and decide where each one goes.",
  other: (owner: string) =>
    `- THE SCREEN BELONGS TO PART "${owner}": publish your values in __studio.state() or your module's API — the screen owner ${owner} draws them. Never draw on the screen from this part (no __studio.hud call of any kind — text, bar, arc, path, image, panel, font, crosshair or flash): each such line is a code-review finding you remove before your build is judged.`,
} as const;

/**
 * The finish stage's rules (facet/stage-prompts.ts `FINISH_RULES`) for a part that does not own
 * the screen: the same rules, written out whole so a kept older stage-prompts.ts never shifts
 * them, with the HUD's craft handed to the owner instead of polished here.
 */
const NON_OWNER_FINISH_RULES = (owner: string): readonly string[] => [
  "This iteration finishes what exists. Work the judge's polish list below and the defect ledger, worst first.",
  "Change how what exists looks, sounds and feels — materials, light, readability, motion — not what exists: no new systems, no new mechanics.",
  `A polish item about the HUD, the menus or the layout is the screen owner ${owner}'s: publish the value it needs and leave the drawing to that part.`,
  "Keep every passing check: a regression still rolls the build back.",
  "Capture and look at the real window before you stop: the judge picks blind between your build and the accepted one, and a build that adds a system or changes nothing a player can see loses.",
];

/** The part that owns the screen while this one does not, read exactly as screen-owner.ts reads it. */
function otherScreenOwner(spec: ScreenOwnerSpec): string | null {
  if (spec.ownsScreen === true) return null;
  return typeof spec.screenOwner === "string" && spec.screenOwner ? spec.screenOwner : null;
}

/**
 * The brief's and the opening prompt's line about the screen's owner: the owner hears that the
 * HUD, menus and layout are its; every other part hears to publish its values for the owner to
 * draw. Null when no part owns the screen, so that run's brief and prompt are as they were.
 */
export function screenOwnerLine(spec: ScreenOwnerSpec | null | undefined): string | null {
  if (!spec) return null;
  if (spec.ownsScreen === true) return SCREEN_OWNER_WORDS.owner;
  const owner = otherScreenOwner(spec);
  return owner ? SCREEN_OWNER_WORDS.other(owner) : null;
}

/**
 * The finish rules for a part another part's screen belongs to, or null when the stage's own
 * rules stand (this part owns the screen, or no part does): a finisher that may not draw is never
 * told to polish the HUD's craft.
 */
export function screenOwnerFinishRules(spec: ScreenOwnerSpec | null | undefined): readonly string[] | null {
  const owner = spec ? otherScreenOwner(spec) : null;
  return owner ? NON_OWNER_FINISH_RULES(owner) : null;
}
