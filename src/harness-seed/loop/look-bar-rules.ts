/**
 * The look bar's words a judge and a game's lessons read: the taste judge's ART BAR question, and
 * the rule each look blocker teaches (ledger.ts). Its own module: a workspace whose agent kept an
 * older look-bar-prompts.ts still loads the judge and the ledger.
 *
 * A new module: a kept older sibling can never shadow these names.
 */
import { ArtSource, LookBlocker } from "./look-bar.ts";

/**
 * The art-bar question a taste judge answers on a run with a visual bar: which look blockers the
 * build the checks accepted shows that the other does not, and the rule that a build below the
 * bar has regressed even where the other build lacks the thing. Gen3 kept a bench of twelve boxes
 * because a new ugly bench was never a regression against no bench.
 */
export function artBarLine(accepted: string): string {
  return `ART BAR: in "added", list each look blocker (tagged, what, where, camera) that build ${accepted} shows and the other build does not — a new box bench, stick tree or slab of snow where the other build had nothing is added. A round that adds one is not kept, whatever checks flipped. "Worse against the art bar" is a regression: when build ${accepted} adds something below the bar, pick the other build and name it in "regression", even though the other build lacks the thing.`;
}

/**
 * The rule a game learns when its judges keep naming one look blocker (ledger.ts): what sources it
 * and what fixes it, so the next run plans against it from its first round instead of meeting it
 * again. Art, sourcing and comfort lessons, said once.
 */
export const BLOCKER_RULES: Record<LookBlocker, string> = {
  [LookBlocker.Primitive]: `source props, vehicles and characters as ${ArtSource.GenexModel}, ${ArtSource.Cc0Model} or ${ArtSource.GenexCharacter} before builders start; a box or cone script is ${ArtSource.Code}`,
  [LookBlocker.DarkViewmodel]: "light the viewmodel with the scene and give it PBR materials; never draw it unlit",
  [LookBlocker.CrushedShadow]:
    "hold every playable camera in the luminance band: a practical light per fixture, centre metering, no negative lift",
  [LookBlocker.PlaceholderParticles]: "use soft, lit particles with size variance, never cubes or hard quads",
  [LookBlocker.SkyContradicts]: "source the sky as an HDRI scan matching the ask's weather and time",
  [LookBlocker.VisibleTiling]:
    "break tiling with 2k scans, stochastic tiling and decals; never a 4 m repeat at play distance",
  [LookBlocker.NotShipped]:
    "reach one area's finished look (its hero shot passes the art director) before spreading to more",
  [LookBlocker.FlatMaterial]: "give every surface a scan or generated texture with its normal and ORM maps",
  [LookBlocker.StickTree]: `source trees as models with leaf or twig cards (${ArtSource.GenexModel} or a decimated ${ArtSource.Cc0Model}); never cones`,
  [LookBlocker.SlabSnow]: "put snow or dust on by material cover and a terrain layer, never as boxes laid on props",
  [LookBlocker.ArtSourceMismatch]:
    "deliver each planned tag from the source the art pass names, and list it in docs/ASSETS.md",
  [LookBlocker.ExposurePump]:
    "keep doorway adaptation smooth: at most 1 EV per half second, a low ev_min, no overshoot",
  [LookBlocker.UncomfortableCamera]:
    "drive the first-person camera with the engine rig inside its comfort caps; never add shake or bob of your own",
};
