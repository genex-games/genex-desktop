import type { HarnessTool } from "../types/harness.d.ts";
import { HostMethod } from "../loop/host-methods.ts";

/** Artwork stays in the host library, outside game sources and exports. The host draws the look. */
const LOOKS = {
  clouds: ["genex", "day", "night", "dawn", "mint", "storm"],
  aurora: ["aurora", "solar", "ice"],
  bands: ["amber", "ice", "rose"],
  marble: ["indigo", "jade", "onyx"],
  ember: ["lava", "violet", "toxic"],
  ocean: ["earth", "desert", "alien"],
};
/** Families whose colour the host picks, so no two games share a look. */
const ORBS = [
  "orbital",
  "bricks",
  "plasma",
  "pixel",
  "caustic",
  "tempest",
  "nimbus",
  "terminal",
  "voxel",
  "meadow",
  "galaxy",
  "thermal",
];
const HINTS =
  "Clouds suit cozy/casual/adventure; aurora night/sci-fi/magic; bands space/arcade; marble puzzle/strategy; ember action/horror/fantasy; ocean open world/survival; orbital science/physics; bricks building/sandbox/kids; plasma sci-fi/energy; pixel retro/platformer; caustic water/fishing/beach; tempest action/weather/racing; nimbus calm/zen; terminal hacking/text/coding; voxel crafting/survival; meadow exploration/dreamlike; galaxy space/exploration; thermal stealth/horror/detective.";
export const tools: HarnessTool[] = [
  {
    name: "set_game_cover",
    description: `Pick this game's sidebar cover once. Families with named palettes: ${Object.entries(LOOKS)
      .map(([family, palettes]) => `${family}: ${palettes.join("|")}`)
      .join(
        "; ",
      )}. Families whose colour the host picks: ${ORBS.join(", ")}. ${HINTS} Genre is only a hint; choose the family that will look best for this game. The host keeps every game's cover different, so it may use another palette or colour than the one named. The host draws it; an unknown look keeps the current cover. Uploaded or already chosen covers are kept.`,
    parameters: {
      type: "object",
      properties: {
        family: { type: "string", enum: [...Object.keys(LOOKS), ...ORBS] },
        palette: {
          type: "string",
          enum: [...new Set(Object.values(LOOKS).flat())],
          description: "Only for the families with named palettes.",
        },
        seed: { type: "integer", minimum: 0, maximum: 65535, description: "Varies shapes, tilt and starting spin." },
        motion: { type: "number", minimum: 0, maximum: 1, description: "0 still to 1 lively." },
      },
      required: ["family"],
    },
    async execute(args, ctx) {
      if (!ctx.project) return { ok: false, content: "Open a writable game first." };
      const { family, palette, seed, motion } = args;
      return {
        ok: true,
        content: await ctx.call(HostMethod.GameSetCover, {
          project: ctx.project,
          threadId: ctx.threadId,
          family,
          palette,
          seed,
          motion,
        }),
      };
    },
  },
];
