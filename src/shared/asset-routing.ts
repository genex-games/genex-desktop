/**
 * Where each kind of asset comes from (WP-0): one table, read by the asset tools' instructions so
 * every plugin and the template's Art bar send an agent the same way. Gen3 built its benches, bins
 * and birches from cube- and cone-stacked bpy scripts because the Genex plugin said "Blender first
 * for props"; this table puts sourced geometry (Tripo, CC0) first for anything seen up close and
 * keeps Blender for scan-textured kits and for finishing heavy models.
 *
 * {@link assetRoutingText} renders it as the paragraph the plugins' skills carry verbatim
 * (`asset-routing.test.ts` holds them to it).
 */
import { MODEL_TIER_TRIANGLES, ModelTier } from "./model-budget.ts";

/** What an asset is, by how the player sees it. Wire values. */
export const AssetClass = {
  /** Furniture, vehicles, weapons, bins, crates: one object seen up close. */
  CloseUpProp: "close-up-prop",
  /** Trees, bushes, rocks, food, anything grown or weathered rather than built. */
  Organic: "organic",
  /** A rigged person, animal or monster. */
  Character: "character",
  /** A surface a material covers: walls, floors, ground, bark, plating. */
  Surface: "surface",
  /** Leaf and grass cards, and decals (stains, cracks, signs, posters). */
  CardOrDecal: "card-or-decal",
  /** The sky and its light. */
  Sky: "sky",
  /** A building's repeated pieces: walls, floors, doors, frames, stairs, trim. */
  ModularKit: "modular-kit",
  /** A model over its role's triangle budget (a 7.85M-triangle scan, a dense generation). */
  HeavyModel: "heavy-model",
} as const;
export type AssetClass = (typeof AssetClass)[keyof typeof AssetClass];

/** A source an asset may come from: the tool call that makes or fetches it. Wire values. */
export const AssetSource = {
  /** `genex__asset` operation `model` (Tripo), with `face-limit` and `auto-size`. */
  GenexModel: "genex-model",
  /** `cc0__search` kind `model`, then `cc0__fetch` with the role's `tier`. */
  Cc0Model: "cc0-model",
  /** `genex__asset` operation `character` or `creature` (Meshy, rigged with clips). */
  GenexCharacter: "genex-character",
  /** `cc0__fetch` of a texture's diff, nor_gl and arm maps. */
  Cc0Texture: "cc0-texture",
  /** `genex__asset` operation `texture` for a surface the libraries lack. */
  GenexTexture: "genex-texture",
  /** `genex__asset` operation `image` with `transparent`. */
  GenexImageTransparent: "genex-image-transparent",
  /** `cc0__fetch` of an HDRI sky. */
  Cc0Hdri: "cc0-hdri",
  /** `blender__model` with `genex_bpy`: scanned slabs, bevels and one baked atlas. */
  BlenderKit: "blender-kit",
  /** `blender__model` with `genex_bpy` on a model already in the game: decimate, re-texture, bake. */
  BlenderFinish: "blender-finish",
} as const;
export type AssetSource = (typeof AssetSource)[keyof typeof AssetSource];

/** What an asset of a class may never be. Wire values. */
export const AssetNever = {
  /** Cubes, cones, cylinders or spheres stacked into a shape. */
  PrimitiveStack: "primitive-stack",
  /** A material of one colour with no image behind it. */
  FlatColour: "flat-colour",
  /** A picture standing in for something the game shows in 3D. */
  PictureFor3d: "picture-for-3d",
  /** A model over its role's budget left as it is. */
  OverBudget: "over-budget",
} as const;
export type AssetNever = (typeof AssetNever)[keyof typeof AssetNever];

/** One class's route: its sources in order of preference, and what it may never be. */
export interface AssetRoute {
  use: readonly AssetSource[];
  never: readonly AssetNever[];
}

/** The routing table. */
export const ASSET_ROUTES = {
  [AssetClass.CloseUpProp]: {
    use: [AssetSource.Cc0Model, AssetSource.GenexModel],
    never: [AssetNever.PrimitiveStack, AssetNever.FlatColour, AssetNever.PictureFor3d],
  },
  [AssetClass.Organic]: {
    use: [AssetSource.Cc0Model, AssetSource.GenexModel],
    never: [AssetNever.PrimitiveStack, AssetNever.FlatColour, AssetNever.OverBudget],
  },
  [AssetClass.Character]: {
    use: [AssetSource.GenexCharacter],
    never: [AssetNever.PrimitiveStack, AssetNever.PictureFor3d],
  },
  [AssetClass.Surface]: {
    use: [AssetSource.Cc0Texture, AssetSource.GenexTexture],
    never: [AssetNever.FlatColour],
  },
  [AssetClass.CardOrDecal]: {
    use: [AssetSource.GenexImageTransparent],
    never: [AssetNever.FlatColour],
  },
  [AssetClass.Sky]: {
    use: [AssetSource.Cc0Hdri],
    never: [AssetNever.FlatColour],
  },
  [AssetClass.ModularKit]: {
    use: [AssetSource.BlenderKit],
    never: [AssetNever.FlatColour],
  },
  [AssetClass.HeavyModel]: {
    use: [AssetSource.Cc0Model, AssetSource.BlenderFinish],
    never: [AssetNever.OverBudget],
  },
} as const satisfies Record<AssetClass, AssetRoute>;

const triangles = (tier: ModelTier) => `${MODEL_TIER_TRIANGLES[tier] / 1000}k`;

/** How the routing paragraph names each class. */
const CLASS_WORDS: Readonly<Record<AssetClass, string>> = {
  [AssetClass.CloseUpProp]: "Props seen up close (furniture, vehicles, weapons, bins, crates)",
  [AssetClass.Organic]: "Anything organic (trees, bushes, rocks, food)",
  [AssetClass.Character]: "Characters and creatures",
  [AssetClass.Surface]: "Surfaces (walls, floors, ground, bark, plating)",
  [AssetClass.CardOrDecal]: "Leaf and grass cards, decals",
  [AssetClass.Sky]: "The sky",
  [AssetClass.ModularKit]: "A building's modular kit (walls, floors, frames, stairs, trim)",
  [AssetClass.HeavyModel]: "A model over its tier's budget",
};

/** How the routing paragraph names each source. */
const SOURCE_WORDS: Readonly<Record<AssetSource, string>> = {
  [AssetSource.Cc0Model]: "a CC0 model fetched with its tier (cc0__search kind model, then cc0__fetch tier)",
  [AssetSource.GenexModel]: "genex__asset model (Tripo) with face-limit and auto-size",
  [AssetSource.GenexCharacter]: "genex__asset character or creature (Meshy, rigged)",
  [AssetSource.Cc0Texture]: "a CC0 scan (cc0__fetch diff, nor_gl and arm at the size it is seen)",
  [AssetSource.GenexTexture]: "genex__asset texture for a subject-specific surface (terrain for ground)",
  [AssetSource.GenexImageTransparent]: "genex__asset image with transparent",
  [AssetSource.Cc0Hdri]: "a CC0 HDRI (cc0__fetch kind hdri)",
  [AssetSource.BlenderKit]:
    "blender__model with genex_bpy: gx.slab and gx.pbr from fetched scans, gx.bevel, gx.bake_atlas with wear",
  [AssetSource.BlenderFinish]: "blender__model with genex_bpy on the model: gx.decimate_to, gx.pbr, gx.bake_atlas",
};

/** How the routing paragraph names each never. */
const NEVER_WORDS: Readonly<Record<AssetNever, string>> = {
  [AssetNever.PrimitiveStack]: "stacked cubes, cones or spheres",
  [AssetNever.FlatColour]: "flat colour",
  [AssetNever.PictureFor3d]: "a picture standing in for 3D",
  [AssetNever.OverBudget]: "left over budget",
};

/** The routing table as one paragraph, the line every asset tool's instructions carry verbatim. */
export function assetRoutingText(): string {
  const lines = Object.values(AssetClass).map((kind) => {
    const route: AssetRoute = ASSET_ROUTES[kind];
    const use = route.use.map((source) => SOURCE_WORDS[source]).join(", else ");
    const never = route.never.map((each) => NEVER_WORDS[each]).join(", ");
    return `${CLASS_WORDS[kind]}: ${use}; never ${never}.`;
  });
  return [
    "Asset routing (search and fetch before you generate, generate before you model):",
    ...lines,
    `Tiers (triangles of LOD0): ${Object.values(ModelTier)
      .map((tier) => `${tier} ${triangles(tier)}`)
      .join(
        ", ",
      )}; cc0__fetch decimates a heavier model to its tier, and the import step any static model past ${triangles(ModelTier.Hero)}.`,
  ].join(" ");
}
