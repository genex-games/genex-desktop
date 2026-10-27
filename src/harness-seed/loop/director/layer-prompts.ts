/**
 * A high bar on a short clock. Bodycam's first run (2026-10-27) had 56 working minutes for a
 * "photorealistic" first-person interior: the director built a greybox in four, then spent the rest
 * polishing it — no geometry pass, no hands — and the reviewer turned the finish down three times.
 * The person's hours are theirs (they set them, and they pay for them), so the run does not grow;
 * the lead is told to build the look in layers, each finished before the next, and to say up front
 * which layer the time reaches.
 */
import { durationCommission } from "./commission.ts";
import type { Run } from "../../types/harness.d.ts";

/** A timed run with at most this many working minutes hears the layer order; past it every layer fits twice. */
export const LAYER_RULE_MAX_MINUTES = 240;

/** The layer order, as the lead's brief says it for `workingMinutes`; "" for a run with time for everything or no clock to beat. */
export function layeredBarRule(run: Pick<Run, "reference" | "budgets">, workingMinutes: number): string {
  if (!durationCommission(run) || workingMinutes > LAYER_RULE_MAX_MINUTES) return "";
  return [
    `A HIGH BAR ON ${workingMinutes} MINUTES: when the brief asks for more than these minutes can build (photoreal, AAA, a close-up interior, film-like characters), build the look in layers and finish each before starting the next:`,
    `(1) a greybox that plays, (2) real geometry — modelled kit pieces, openings with depth, props that are not boxes, (3) light and materials — the scene's lights, probes, textured surfaces, fog, (4) what sits closest to the camera — first-person hands and weapon, a character's face.`,
    `Never polish an earlier layer while a later one is missing: a lit, textured greybox still reads as a greybox. Say in the plan's risks which layer the time reaches, and say it again in the finish if the bar stays out of reach — the user would rather know than be shown a polished first layer.`,
  ].join(" ");
}
