/**
 * Triangle budgets for a model's role in a game: what a decimation aims at when a fetched or
 * generated model is heavier than its role can carry (WP-0/WP-6). LOD0 sits at the budget, the
 * import step's levels halve it from there, and a far copy draws as its impostor. The import cap
 * is the hero budget: no static model reaches a game above it (`asset-import/decimate.ts`).
 */

/** A model's role, by how much of the frame it may cost. Wire values: the `tier` a tool takes. */
export const ModelTier = {
  /** Seen close and alone: a hero prop, a vehicle, a whole building. */
  Hero: "hero",
  /** Trees, bushes and large plants: drawn many times, with cards for leaves and an impostor far off. */
  Vegetation: "vegetation",
  /** A prop seen up close among others: furniture, crates, a bench, a bin. */
  Prop: "prop",
  /** Small things scattered by the dozen: debris, cups, stones, books. */
  Clutter: "clutter",
} as const;
export type ModelTier = (typeof ModelTier)[keyof typeof ModelTier];

/** Each tier's triangle budget for LOD0 (owner-tunable). */
export const MODEL_TIER_TRIANGLES = {
  [ModelTier.Hero]: 250_000,
  [ModelTier.Vegetation]: 40_000,
  [ModelTier.Prop]: 30_000,
  [ModelTier.Clutter]: 5_000,
} as const satisfies Record<ModelTier, number>;

/** The most triangles a static model reaches a game with: heavier ones are decimated to it. */
export const MODEL_IMPORT_TRIANGLES = MODEL_TIER_TRIANGLES[ModelTier.Hero];

const TIERS: ReadonlySet<string> = new Set(Object.values(ModelTier));

/** Whether `value` is a {@link ModelTier}. */
export const isModelTier = (value: unknown): value is ModelTier => typeof value === "string" && TIERS.has(value);

/** How a model's triangles stand against the import cap. Wire values in `cc0__search` results. */
export const ModelBudgetFit = {
  /** At or under the import cap: it imports as it is. */
  Within: "within",
  /** Over the import cap: fetching or importing it decimates it to a tier's budget. */
  OverImportCap: "over-import-cap",
} as const;
export type ModelBudgetFit = (typeof ModelBudgetFit)[keyof typeof ModelBudgetFit];

/** Where `triangles` stands against the import cap. */
export const modelBudgetFit = (triangles: number): ModelBudgetFit =>
  triangles > MODEL_IMPORT_TRIANGLES ? ModelBudgetFit.OverImportCap : ModelBudgetFit.Within;
