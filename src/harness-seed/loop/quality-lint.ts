/**
 * Asks that buy a worse game, refused where a lead writes a builder's mandate (`worker_start
 * move=` and `milestones=`, `worker_steer move=`). Gen1 asked for "head bob and handheld shake",
 * gen2 for "heavy head-bob and roll", gen3 for "a sprint that tilts and shakes the view" and for
 * "birch and pine billboards"; gen3's director capped textures at 1k. The builders built each one.
 * A mandate names the result a player sees, never the cheaper means.
 *
 * A new module: a kept older sibling can never shadow these names.
 */

/** What an anti-quality ask asks for. */
export const QualityAsk = {
  /** Flat cards or sprites standing in for trees or foliage near the player. */
  Billboard: "billboard",
  /** Textures held to 1k, 512 or 256 px, or a "low-res" look. */
  LowResolution: "low-resolution",
  /** Camera shake, head bob, wobble or roll as a feature. */
  Shake: "shake",
} as const;
export type QualityAsk = (typeof QualityAsk)[keyof typeof QualityAsk];

/** Each ask's words in a mandate. */
const PHRASES: Record<QualityAsk, RegExp> = {
  [QualityAsk.Billboard]: /\b(bill-?boards?|sprite (trees?|foliage)|flat (tree|foliage) cards?|cut-?out trees?)\b/i,
  [QualityAsk.LowResolution]: /\b(1k|512 ?px|256 ?px|low[- ]res(olution)?)\b/i,
  [QualityAsk.Shake]:
    /\b(shak(e|es|ing|y)|head[- ]?bob(s|bing)?|heavy bob|wobbl(e|es|y|ing)|tilts? (and|the) (view|camera))\b/i,
};

/** What a mandate asks for instead, by ask. */
const INSTEAD: Record<QualityAsk, string> = {
  [QualityAsk.Billboard]:
    "name trees and foliage that read as the species up close (a generated, CC0 or engine-grown model with leaf or twig cards; impostors only far away)",
  [QualityAsk.LowResolution]:
    "name near surfaces with 2k scans and their normal and ORM maps; a boot budget is met by streaming asset groups",
  [QualityAsk.Shake]:
    "name a grounded first-person camera inside the engine rig's comfort caps (the player feels weight in sound, the viewmodel and impacts, not a shaking view)",
};

/** The anti-quality asks in one mandate's words, in vocabulary order. */
export function qualityAsks(text: unknown): QualityAsk[] {
  const words = String(text ?? "");
  return (Object.values(QualityAsk) as QualityAsk[]).filter((ask) => PHRASES[ask].test(words));
}

/**
 * Why a lead's mandate is refused, or null when none of its rungs asks for less. `label` names the
 * argument (`milestones`, `move`) the way the refusal quotes it.
 */
export function qualityRefusal(label: string, rungs: readonly unknown[]): string | null {
  for (const [index, rung] of rungs.entries()) {
    const what = typeof rung === "string" ? rung : (rung as { what?: unknown } | null)?.what;
    const asks = qualityAsks(what);
    if (!asks.length) continue;
    const instead = asks.map((ask) => INSTEAD[ask]).join("; ");
    return `${label}: rung ${index + 1} asks for ${asks.join(" and ")} ("${String(what).slice(0, 120)}"), which makes the game worse — ${instead}. Write the result a player sees instead.`;
  }
  return null;
}
