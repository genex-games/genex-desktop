/**
 * Quality presets own a game's look features; a check never does. Body-cam-6's lead switched its
 * volumetric fog off to pass the determinism check, and the dust shafts that made the reference
 * read as a photograph went with it. A round that draws a feature the accepted build drew, at the
 * same or a higher preset, with that feature off is a look blocker, and builders are told to report the check.
 *
 * Read from `state().volatile.render.features` (the preset's switches) and, where the game reports
 * them, `state().__render.look.features` (look features no preset switches, such as the lit volume).
 *
 * A new module: a kept older sibling can never shadow these names.
 */
import { LookBlocker } from "./look-bar.ts";
import type { AnyRecord } from "../types/harness.d.ts";

/** What every builder and the lead are told about a check a look feature fails. */
export const FEATURE_RULE =
  "A check you cannot pass is reported in your summary, never met by switching a look feature off (fog, a lit volume, shadows, bloom, AO, texture quality): the quality presets own every feature, and a round that turns one off is not kept.";

/** The look features a state reports as on or off, and the preset it was drawn at. */
interface LookFeatures {
  preset: string | null;
  on: Record<string, boolean>;
}

/** The boolean switches of a record, by name. */
function switches(raw: unknown): Record<string, boolean> {
  if (!raw || typeof raw !== "object") return {};
  return Object.fromEntries(Object.entries(raw as AnyRecord).filter(([, value]) => typeof value === "boolean"));
}

/** The quality presets, cheapest first (`QualityPreset` wire spellings). */
const PRESET_ORDER = ["low", "medium", "high", "ultra"];

/** The features one state reports, or null when it reports none; the look's own preset wins (a capture's pinned one). */
export function lookFeaturesOf(state: AnyRecord | null | undefined): LookFeatures | null {
  const render = (state?.volatile as AnyRecord | undefined)?.render as AnyRecord | undefined;
  const look = (state?.__render as AnyRecord | undefined)?.look as AnyRecord | undefined;
  const on = { ...switches(render?.features), ...switches(look?.features) };
  if (Object.keys(on).length === 0) return null;
  const preset = [look?.preset, render?.preset].find((value) => typeof value === "string");
  return { preset: typeof preset === "string" ? preset : null, on };
}

/** Does `now` draw at least what `had` drew: the same preset, or a higher one. */
function notCheaper(now: string | null, had: string | null): boolean {
  if (now === had) return true;
  const rankNow = PRESET_ORDER.indexOf(now ?? "");
  const rankHad = PRESET_ORDER.indexOf(had ?? "");
  return rankNow >= 0 && rankHad >= 0 && rankNow >= rankHad;
}

/**
 * The features the accepted build drew that this round's build switches off at the same or a
 * higher preset, as look blockers. A cheaper preset is the preset's word, not the round's; a
 * feature either side does not report is not compared.
 */
export function featuresTurnedOff(
  challenger: AnyRecord | null | undefined,
  incumbent: AnyRecord | null | undefined,
): string[] {
  const now = lookFeaturesOf(challenger);
  const had = lookFeaturesOf(incumbent);
  if (!now || !had || !notCheaper(now.preset, had.preset)) return [];
  const preset = had.preset ?? "its preset";
  return Object.entries(had.on)
    .filter(([feature, on]) => on && now.on[feature] === false)
    .map(
      ([feature]) =>
        `[${LookBlocker.FeatureOff}] ${feature}: the accepted build drew ${feature} on ${preset} and this round's build does not; a failing check is reported, never met by removing a feature`,
    );
}
