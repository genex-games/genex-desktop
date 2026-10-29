/**
 * The Genex Library's curation record: which CC0 assets the catalog carries, under which category
 * and budget. `build-library.ts pin` expands each pick from its source's API (name, tags, authors,
 * real size, upstream files pinned by size and md5) into `src/plugins/library/catalog.json`; the
 * catalog is what ships, this list is how it was chosen. Poly Haven picks favour widely used scans
 * with an ARM map at 2k and 4k; a model over its budget is decimated by the build.
 */
import {
  LibraryBudget,
  LibraryKind,
  LibrarySkyTime,
  LibrarySkyWeather,
  type LibraryTier,
  LibraryTier as Tier,
} from "../../src/shared/genex-library.ts";

/** A material pick: a Poly Haven texture. */
export interface MaterialPick {
  kind: typeof LibraryKind.Material;
  source: string;
  category: string;
  /** Tags beyond the source's own, in the words a game's brief uses. */
  tags: string[];
}

/** A sky pick: a Poly Haven HDRI. */
export interface SkyPick {
  kind: typeof LibraryKind.Sky;
  source: string;
  time: LibrarySkyTime;
  weather: LibrarySkyWeather;
  tags: string[];
}

/** A model pick: a Poly Haven model and its budget class. */
export interface ModelPick {
  kind: typeof LibraryKind.Model;
  source: string;
  category: string;
  budget: LibraryBudget;
  tags: string[];
}

/** A vegetation slot the tree generator (aaa-vegetation) fills. */
export interface SlotPick {
  kind: typeof LibraryKind.Vegetation;
  slug: string;
  name: string;
  category: string;
  brief: string;
  budget: LibraryBudget;
  sizeMetres: [number, number, number];
  tags: string[];
}

export type LibraryPick = MaterialPick | SkyPick | ModelPick | SlotPick;

/** The tiers a material or sky carries. */
export const PICK_TIERS: readonly LibraryTier[] = [Tier.TwoK, Tier.FourK];
/** The texture tier a model's GLB embeds. */
export const MODEL_TIER: LibraryTier = Tier.TwoK;

const material = (source: string, category: string, tags: string[] = []): MaterialPick => ({
  kind: LibraryKind.Material,
  source,
  category,
  tags,
});
const sky = (source: string, time: LibrarySkyTime, weather: LibrarySkyWeather, tags: string[] = []): SkyPick => ({
  kind: LibraryKind.Sky,
  source,
  time,
  weather,
  tags,
});
const model = (source: string, category: string, budget: LibraryBudget, tags: string[] = []): ModelPick => ({
  kind: LibraryKind.Model,
  source,
  category,
  budget,
  tags,
});

/** About 66 PBR materials across the surfaces most games need. */
const MATERIALS: MaterialPick[] = [
  material("snow_02", "snow", ["winter", "ground"]),
  material("snow_01", "snow", ["winter", "ground"]),
  material("snow_03", "snow", ["winter", "ground", "footprints"]),
  material("snow_floor", "snow", ["winter", "ground", "slush"]),
  material("brown_mud_leaves_01", "mud", ["ground", "autumn", "forest"]),
  material("brown_mud_dry", "mud", ["ground", "dry", "dirt"]),
  material("brown_mud_02", "mud", ["ground", "wet", "dirt"]),
  material("forrest_ground_01", "ground", ["forest", "dirt", "leaves"]),
  material("forest_ground_04", "ground", ["forest", "dirt", "roots"]),
  material("forest_leaves_02", "ground", ["forest", "leaves", "autumn"]),
  material("rocks_ground_02", "ground", ["stones", "dirt", "path"]),
  material("rocky_trail_02", "ground", ["trail", "path", "dirt"]),
  material("leafy_grass", "grass", ["lawn", "ground", "park"]),
  material("asphalt_01", "asphalt", ["road", "street", "urban"]),
  material("asphalt_track", "asphalt", ["road", "street", "race"]),
  material("asphalt_06", "asphalt", ["road", "street", "worn"]),
  material("clean_asphalt", "asphalt", ["road", "street", "new"]),
  material("asphalt_pit_lane", "asphalt", ["road", "parking", "markings"]),
  material("gravelly_sand", "gravel", ["ground", "path", "sand"]),
  material("gravel_stones", "gravel", ["ground", "path", "driveway"]),
  material("gravel_floor_02", "gravel", ["ground", "path"]),
  material("sand_01", "sand", ["beach", "desert", "ground"]),
  material("coast_sand_01", "sand", ["beach", "coast", "ground"]),
  material("beige_wall_001", "plaster", ["wall", "interior", "painted"]),
  material("grey_plaster", "plaster", ["wall", "interior"]),
  material("plastered_wall", "plaster", ["wall", "exterior", "stucco"]),
  material("concrete_wall_003", "plaster", ["wall", "concrete", "exterior"]),
  material("cracked_concrete_wall", "plaster", ["wall", "concrete", "damaged"]),
  material("concrete_floor_worn_001", "concrete", ["floor", "industrial", "worn"]),
  material("concrete_floor_02", "concrete", ["floor", "garage"]),
  material("concrete_layers_02", "concrete", ["wall", "bunker", "brutalist"]),
  material("gravel_embedded_concrete", "concrete", ["floor", "pavement", "sidewalk"]),
  material("concrete_floor_painted", "concrete", ["floor", "painted", "warehouse"]),
  material("red_brick", "brick", ["wall", "exterior", "building"]),
  material("red_brick_03", "brick", ["wall", "exterior", "old"]),
  material("brick_wall_001", "brick", ["wall", "exterior"]),
  material("castle_brick_02_red", "brick", ["wall", "castle", "medieval"]),
  material("medieval_blocks_03", "brick", ["wall", "stone", "medieval"]),
  material("interior_tiles", "tiles", ["floor", "wall", "bathroom", "kitchen"]),
  material("worn_tile_floor", "tiles", ["floor", "old", "hospital"]),
  material("checkered_pavement_tiles", "tiles", ["floor", "pavement", "checker"]),
  material("concrete_tiles_02", "tiles", ["floor", "pavement", "sidewalk"]),
  material("laminate_floor_02", "floor", ["wood", "interior", "laminate"]),
  material("diagonal_parquet", "floor", ["wood", "interior", "parquet"]),
  material("old_planks_02", "floor", ["wood", "planks", "old"]),
  material("dark_wooden_planks", "floor", ["wood", "planks", "dark"]),
  material("plank_flooring", "floor", ["wood", "planks", "interior"]),
  material("plywood", "wood", ["board", "construction"]),
  material("oak_veneer_01", "wood", ["furniture", "veneer", "oak"]),
  material("weathered_brown_planks", "wood", ["planks", "fence", "weathered"]),
  material("wood_planks_dirt", "wood", ["planks", "dirty", "barn"]),
  material("metal_plate", "metal", ["floor", "industrial", "tread"]),
  material("rust_coarse_01", "metal", ["rust", "industrial", "old"]),
  material("rusty_metal_02", "metal", ["rust", "painted", "old"]),
  material("corrugated_iron", "metal", ["roof", "shed", "sheet"]),
  material("green_metal_rust", "metal", ["painted", "rust", "container"]),
  material("fabric_leather_02", "fabric", ["cloth", "upholstery", "sofa"]),
  material("hessian_230", "fabric", ["burlap", "sack", "cloth"]),
  material("brown_leather", "fabric", ["leather", "sofa", "upholstery"]),
  material("denmin_fabric_02", "fabric", ["denim", "cloth", "jeans"]),
  material("dirty_carpet", "fabric", ["carpet", "floor", "interior"]),
  material("rock_face_03", "rock", ["cliff", "stone", "mountain"]),
  material("rocks_ground_01", "rock", ["stones", "ground", "rubble"]),
  material("cobblestone_floor_04", "cobblestone", ["street", "pavement", "old town"]),
  material("grassy_cobblestone", "cobblestone", ["street", "path", "overgrown"]),
  material("roof_slates_03", "roofing", ["roof", "slate"]),
  material("ceramic_roof_01", "roofing", ["roof", "tiles", "terracotta"]),
];

/** Skies across times of day and weather. */
const SKIES: SkyPick[] = [
  sky("kloofendal_48d_partly_cloudy_puresky", LibrarySkyTime.Noon, LibrarySkyWeather.PartlyCloudy, ["day", "clouds"]),
  sky("noon_grass", LibrarySkyTime.Noon, LibrarySkyWeather.Clear, ["day", "sunny", "field"]),
  sky("autumn_field_puresky", LibrarySkyTime.Morning, LibrarySkyWeather.Clear, ["day", "sunny", "autumn"]),
  sky("overcast_soil_puresky", LibrarySkyTime.Morning, LibrarySkyWeather.Overcast, ["grey", "cloudy", "soft"]),
  sky("snowy_park_01", LibrarySkyTime.Noon, LibrarySkyWeather.Snow, ["winter", "grey", "park"]),
  sky("snowy_field", LibrarySkyTime.Morning, LibrarySkyWeather.Snow, ["winter", "sunny", "field"]),
  sky("lilienstein", LibrarySkyTime.Sunset, LibrarySkyWeather.PartlyCloudy, ["evening", "golden hour"]),
  sky("spruit_sunrise", LibrarySkyTime.Dawn, LibrarySkyWeather.Clear, ["sunrise", "golden hour"]),
  sky("canary_wharf", LibrarySkyTime.Afternoon, LibrarySkyWeather.PartlyCloudy, ["city", "urban"]),
  sky("kloppenheim_02", LibrarySkyTime.Night, LibrarySkyWeather.Clear, ["stars", "dark"]),
  sky("moonless_golf", LibrarySkyTime.Night, LibrarySkyWeather.Clear, ["stars", "dark", "lights"]),
  sky("winter_evening", LibrarySkyTime.Night, LibrarySkyWeather.Overcast, ["winter", "city", "street lights"]),
  sky("brown_photostudio_02", LibrarySkyTime.Interior, LibrarySkyWeather.Studio, ["indoor", "room", "studio"]),
];

/** Props, rocks and debris where CC0 has them. */
const MODELS: ModelPick[] = [
  model("painted_wooden_bench", "bench", LibraryBudget.SmallProp, ["seat", "park", "street furniture"]),
  model("modular_street_seating", "bench", LibraryBudget.LargeProp, ["seat", "plaza", "street furniture"]),
  model("street_lamp_01", "lamp", LibraryBudget.LargeProp, ["street light", "pole", "urban"]),
  model("street_lamp_02", "lamp", LibraryBudget.LargeProp, ["street light", "wall lamp", "urban"]),
  model("metal_trash_can", "bin", LibraryBudget.Prop, ["dumpster", "garbage", "street"]),
  model("trashbag", "bin", LibraryBudget.SmallProp, ["garbage", "bag", "litter"]),
  model("Barrel_01", "barrel", LibraryBudget.SmallProp, ["wood", "container"]),
  model("barrel_03", "barrel", LibraryBudget.SmallProp, ["metal", "oil drum", "industrial"]),
  model("wooden_crate_01", "crate", LibraryBudget.Prop, ["box", "wood", "storage"]),
  model("wooden_crate_02", "crate", LibraryBudget.Prop, ["box", "wood", "storage"]),
  model("plastic_crate_02", "crate", LibraryBudget.Prop, ["box", "plastic", "storage"]),
  model("cardboard_box_01", "crate", LibraryBudget.Prop, ["box", "cardboard", "storage"]),
  model("modular_chainlink_fence", "fence", LibraryBudget.Structure, ["chain link", "barrier", "industrial"]),
  model("concrete_road_barrier", "barrier", LibraryBudget.Prop, ["road", "jersey barrier", "concrete"]),
  model("fire_hydrant", "hydrant", LibraryBudget.Prop, ["street", "urban"]),
  model("utility_box_02", "utility", LibraryBudget.Prop, ["electric", "street", "cabinet"]),
  model("exterior_aircon_unit", "utility", LibraryBudget.Prop, ["air conditioner", "wall", "building"]),
  model("rollershutter_door", "door", LibraryBudget.SmallProp, ["garage", "shutter", "shop"]),
  model("large_castle_door", "door", LibraryBudget.Prop, ["wood", "medieval", "gate"]),
  model("rollershutter_window_01", "window", LibraryBudget.SmallProp, ["shop", "shutter"]),
  model("covered_car", "vehicle", LibraryBudget.Vehicle, ["car", "tarp", "parked"]),
  model("old_tyre", "debris", LibraryBudget.SmallProp, ["tire", "junk", "rubber"]),
  model("wooden_picnic_table", "table", LibraryBudget.Prop, ["park", "outdoor", "bench"]),
  model("WoodenTable_01", "table", LibraryBudget.SmallProp, ["wood", "interior"]),
  model("metal_office_desk", "table", LibraryBudget.Prop, ["desk", "office", "interior"]),
  model("plastic_monobloc_chair_01", "chair", LibraryBudget.SmallProp, ["seat", "plastic", "garden"]),
  model("sofa_02", "chair", LibraryBudget.SmallProp, ["couch", "living room", "interior"]),
  model("steel_frame_shelves_01", "shelf", LibraryBudget.SmallProp, ["storage", "warehouse", "metal"]),
  model("painted_wooden_cabinet", "shelf", LibraryBudget.SmallProp, ["cupboard", "kitchen", "interior"]),
  model("WetFloorSign_01", "sign", LibraryBudget.SmallProp, ["caution", "interior"]),
  model("rock", LibraryBudget.Rock, ["boulder", "stone", "nature"]),
  model("namaqualand_boulder_02", "rock", LibraryBudget.Rock, ["boulder", "stone", "desert"]),
  model("namaqualand_boulder_03", "rock", LibraryBudget.Rock, ["boulder", "stone", "desert"]),
  model("rock_moss_set_01", "rock", LibraryBudget.Rock, ["moss", "stones", "forest"]),
  model("rock_moss_set_02", "rock", LibraryBudget.Rock, ["moss", "stones", "forest"]),
  model("stone_fire_pit", "rock", LibraryBudget.SmallProp, ["campfire", "stones", "camp"]),
  model("tree_stump_01", "debris", LibraryBudget.Rock, ["stump", "wood", "forest"]),
  model("dead_tree_trunk", "debris", LibraryBudget.Rock, ["log", "wood", "forest"]),
  model("dry_branches_medium_01", "debris", LibraryBudget.Prop, ["branches", "sticks", "forest floor"]),
];

const slot = (
  slug: string,
  name: string,
  brief: string,
  sizeMetres: [number, number, number],
  tags: string[],
  category = "tree",
): SlotPick => ({
  kind: LibraryKind.Vegetation,
  slug,
  name,
  category,
  brief,
  budget: LibraryBudget.Tree,
  sizeMetres,
  tags,
});

/** Vegetation slots: the tree generator fills them; the catalog only fixes what each must be. */
const SLOTS: SlotPick[] = [
  slot(
    "birch_winter",
    "Birch, winter",
    "bare silver birch, white bark with black lenticels, twig crown, 12-18 m",
    [6, 15, 6],
    ["birch", "winter", "bare"],
  ),
  slot(
    "birch_summer",
    "Birch, summer",
    "silver birch in leaf, drooping twigs, 12-18 m",
    [7, 15, 7],
    ["birch", "summer", "leafy"],
  ),
  slot(
    "spruce",
    "Spruce",
    "Norway spruce, dense conical crown, 15-25 m",
    [7, 20, 7],
    ["conifer", "evergreen", "forest"],
  ),
  slot(
    "pine",
    "Scots pine",
    "Scots pine, orange upper bark, flat high crown, 15-25 m",
    [8, 20, 8],
    ["conifer", "evergreen", "forest"],
  ),
  slot(
    "oak_summer",
    "Oak, summer",
    "English oak in leaf, broad crown, 15-20 m",
    [14, 17, 14],
    ["oak", "summer", "park"],
  ),
  slot(
    "oak_bare",
    "Oak, bare",
    "English oak in winter, gnarled bare branches, 15-20 m",
    [14, 17, 14],
    ["oak", "winter", "bare"],
  ),
  slot("bush_leafy", "Leafy bush", "rounded deciduous shrub, 1-2 m", [2, 1.6, 2], ["shrub", "hedge", "garden"], "bush"),
  slot(
    "grass_tuft",
    "Grass tuft",
    "clump of wild grass cards for scattering, 0.3-0.6 m",
    [0.6, 0.5, 0.6],
    ["grass", "meadow", "scatter"],
    "grass",
  ),
];

/** Every pick, in catalog order. */
export const LIBRARY_PICKS: readonly LibraryPick[] = [...MATERIALS, ...SKIES, ...MODELS, ...SLOTS];

/**
 * The starter subset (`build-library.ts build --only starter`): about 25 materials, 6 skies and 15
 * props that any game uses, built first so a pack is useful before the full set is.
 */
export const STARTER_IDS: readonly string[] = [
  ...[
    "snow_02",
    "brown_mud_leaves_01",
    "forrest_ground_01",
    "rocky_trail_02",
    "leafy_grass",
    "asphalt_01",
    "asphalt_06",
    "gravel_stones",
    "sand_01",
    "beige_wall_001",
    "plastered_wall",
    "concrete_wall_003",
    "concrete_floor_worn_001",
    "concrete_floor_02",
    "red_brick",
    "brick_wall_001",
    "interior_tiles",
    "worn_tile_floor",
    "laminate_floor_02",
    "old_planks_02",
    "weathered_brown_planks",
    "metal_plate",
    "rust_coarse_01",
    "corrugated_iron",
    "brown_leather",
  ].map((id) => `material/${id}`),
  ...[
    "kloofendal_48d_partly_cloudy_puresky",
    "noon_grass",
    "overcast_soil_puresky",
    "snowy_park_01",
    "lilienstein",
    "kloppenheim_02",
  ].map((id) => `sky/${id}`),
  ...[
    "painted_wooden_bench",
    "street_lamp_01",
    "metal_trash_can",
    "barrel_01",
    "wooden_crate_01",
    "plastic_crate_02",
    "modular_chainlink_fence",
    "concrete_road_barrier",
    "fire_hydrant",
    "rollershutter_door",
    "wooden_picnic_table",
    "woodentable_01",
    "plastic_monobloc_chair_01",
    "boulder_01",
    "steel_frame_shelves_01",
  ].map((id) => `model/${id}`),
];
