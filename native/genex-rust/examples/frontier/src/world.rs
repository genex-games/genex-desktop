//! The frontier's ground and content: a 2 x 2 km valley of 64 m cells (cells -16..=15 on both axes).
//!
//! - **Terrain** is procedural ([`height`]): flat in the town (cells -1..=0 on both axes) and along
//!   the road east, rolling hills elsewhere. Streamed tiles of 65 samples a side give the sim its
//!   ground and each sim-active cell its heightfield collider; the game draws one terrain patch
//!   round the camera, rebuilt when the camera moves to another 256 m block.
//! - **Authored content** comes from the compiled cell pack (`world/frontier.cells.json` compiled by
//!   the host's C-28 compiler, `src/pack_table.rs`): six huts and the watchtower in the town with
//!   their colliders, nine waystones along the road and four rock fields. Placements are authored as
//!   heights above the ground; the cell builder stands them on the tile's ground.
//! - **Nav islands** for the town cells are baked offline into `assets/islands/` (`tests/islands.rs`
//!   writes them from [`island_input`], `src/island_table.rs` lists them) and read on the cell's
//!   build worker with `NavIsland::from_bytes`, the one path the web has.
//! - **The forest** is scattered per cell on the tile, clear of the town, the road and the props:
//!   pines with a build-time impostor (`game.impostor_bake`) and a far field.

use std::collections::BTreeMap;
use std::sync::{Arc, LazyLock};

use genex::math::{self, Vec2, Vec3, vec2, vec3};
use genex::nav::{NavArea, NavConfig, NavInput, NavIsland};
use genex::physics::{ColliderBuilder, Pose};
use genex::prelude::{Character, CharacterNav, Mat4};
use genex::{CellBuild, CellColliders, CellId, CellInputs, CellPart, CharacterParams, Far, Impostor, InstanceGroup, Model, Scatter, Terrain, TerrainLayer, TerrainTiles, Transform};
use genex_stream::pack::{PackShape, PackTransform, cell_file, pack_file};
use genex_stream::{CellPack, PackError, PackWorld};

use crate::island_table::ISLAND_FILES;
use crate::pack_table::{PACK_FILES, PACK_FOLDER};
use crate::props::PINE;

/// The cell side, in metres.
pub const CELL: f32 = 64.0;
/// Half the world's side, in metres: cells -16..=15 on both axes.
pub const WORLD_HALF: f32 = 1024.0;
/// Samples a streamed tile side.
pub const TILE_SAMPLES: u32 = 65;
/// The tiles' quantization range, in metres.
pub const HEIGHT_RANGE: (f32, f32) = (-16.0, 128.0);
/// The town: cells -1..=0 on both axes, flat at height 0 (metres either side of the origin).
pub const TOWN_HALF: f32 = 64.0;
/// The town cells, the ones with offline nav islands, ascending.
pub const TOWN_CELLS: [CellId; 4] = [CellId { x: -1, z: -1 }, CellId { x: 0, z: -1 }, CellId { x: -1, z: 0 }, CellId { x: 0, z: 0 }];
/// Nav tiles, metres (two a cell side).
pub const NAV_TILE: f32 = 32.0;
/// The nav input reaches this far past its cell (more than a tile's border), metres.
const NAV_MARGIN: f32 = 3.0;
/// The ground goes from flat to hills between these distances from the town's middle (metres, the
/// larger of |x| and |z|), and between these distances from the road's centre line (z = 0).
const TOWN_FLAT: (f32, f32) = (80.0, 200.0);
const ROAD_FLAT: (f32, f32) = (30.0, 120.0);
/// Kinds of the placement file's things.
pub const KIND_HUT: u32 = 1;
/// A waystone on the road.
pub const KIND_STONE: u32 = 2;
/// The watchtower.
pub const KIND_TOWER: u32 = 3;
/// Trees a square metre in the forest.
const FOREST_DENSITY: f32 = 0.006;
/// No tree grows closer than this to a prop, or to the road's centre line, in metres; none in the
/// town or within this much of it.
const PROP_CLEARING: f32 = 9.0;
const ROAD_CLEARING: f32 = 14.0;
const TOWN_CLEARING: f32 = 24.0;
/// The forest's far field: past `start` metres fewer, larger copies, a quarter at `end`.
const FAR_FIELD: (f32, f32) = (220.0, 700.0);
/// The drawn terrain patch: samples a side, their spacing and the block it snaps to.
const PATCH_SAMPLES: u32 = 769;
const PATCH_SPACING: f32 = 2.0;
const PATCH_BLOCK: f32 = 256.0;
const MEADOW: genex::Color = genex::Color::rgb(92, 124, 62);

fn smoothstep(edges: (f32, f32), value: f32) -> f32 {
    let t = ((value - edges.0) / (edges.1 - edges.0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// The ground at world (`x`, `z`), in metres: exactly 0 in the town and on the road east, hills
/// elsewhere. Pure and libm-backed, so every destination and thread computes the same bits.
pub fn height(x: f32, z: f32) -> f32 {
    let square = x.abs().max(z.abs());
    let town = smoothstep(TOWN_FLAT, square);
    // The road runs east from the town along z = 0; west of the town there is no road.
    let road = 1.0 - (1.0 - smoothstep(ROAD_FLAT, z.abs())) * smoothstep((-100.0, 0.0), x);
    let rim = square / WORLD_HALF;
    let hills = 30.0 + 22.0 * math::sin(x / 181.0) * math::cos(z / 233.0) + 8.0 * math::sin((x + 2.0 * z) / 97.0) + 40.0 * rim * rim;
    hills * town * road
}

/// The valley's streamed terrain tiles.
pub fn tiles() -> TerrainTiles {
    let tiles = TerrainTiles::procedural(TILE_SAMPLES, height).expect("65 samples a tile is a tile size");
    tiles.with_height_range(HEIGHT_RANGE.0, HEIGHT_RANGE.1).expect("an ordered finite range")
}

/// The drawn terrain patch's block for a camera at `at`.
pub fn patch_block(at: Vec3) -> [i32; 2] {
    [math::round(at.x / PATCH_BLOCK) as i32, math::round(at.z / PATCH_BLOCK) as i32]
}

/// The drawn terrain patch: the block it is centred on, [`height`] at each of its grid points (row
/// after row, as `Terrain::from_fn` samples them) and the terrain made of them.
pub struct Patch {
    /// The block it is centred on.
    pub block: [i32; 2],
    heights: Arc<[f32]>,
    /// The terrain drawn.
    pub terrain: Terrain,
}

/// Samples a block moves the patch by on each axis.
const PATCH_BLOCK_SAMPLES: i64 = (PATCH_BLOCK / PATCH_SPACING) as i64;

/// The drawn terrain patch centred on `block`. The heights `previous` already sampled where the
/// two overlap are taken from it (the same grid points, so the same bits; GE fix r2: sampling all
/// 591k points was a 6 ms tick each time the camera crossed a block) and only the rest are sampled.
pub fn patch(block: [i32; 2], previous: Option<&Patch>) -> Patch {
    let half = (PATCH_SAMPLES - 1) as f32 * PATCH_SPACING * 0.5;
    let origin = vec2(block[0] as f32 * PATCH_BLOCK - half, block[1] as f32 * PATCH_BLOCK - half);
    let side = PATCH_SAMPLES as i64;
    // Where sample (x, z) of this patch sits in `previous`, when it has it.
    let shift = previous.map(|old| ((block[0] - old.block[0]) as i64 * PATCH_BLOCK_SAMPLES, (block[1] - old.block[1]) as i64 * PATCH_BLOCK_SAMPLES, &old.heights));
    let mut heights = Vec::with_capacity((side * side) as usize);
    for z in 0..side {
        for x in 0..side {
            let kept = shift.and_then(|(dx, dz, old)| {
                let (ox, oz) = (x + dx, z + dz);
                let inside = (0..side).contains(&ox) && (0..side).contains(&oz);
                inside.then(|| old[(oz * side + ox) as usize])
            });
            heights.push(kept.unwrap_or_else(|| height(origin.x + x as f32 * PATCH_SPACING, origin.y + z as f32 * PATCH_SPACING)));
        }
    }
    let terrain = Terrain::from_heights([PATCH_SAMPLES, PATCH_SAMPLES], origin, PATCH_SPACING, &heights).expect("the patch is within the sample cap");
    let terrain = terrain.with_layers(vec![TerrainLayer::flat(MEADOW).with_roughness(0.95)]).expect("one layer");
    Patch { block, heights: heights.into(), terrain }
}

/// The capsule every agent uses.
pub fn params() -> CharacterParams {
    CharacterParams::default()
}

/// The nav config the islands are baked with: the capsule's own (`character.nav_config()`), 32 m
/// tiles.
pub fn nav_config() -> NavConfig {
    let probe = Character::on_ground(Vec3::ZERO, params()).expect("default parameters");
    probe.nav_config().with_tile(NAV_TILE)
}

/// The cell under a point.
pub fn cell_of(at: Vec3) -> CellId {
    CellId { x: math::floor(at.x / CELL) as i32, z: math::floor(at.z / CELL) as i32 }
}

fn cell_min(cell: CellId) -> Vec2 {
    vec2(cell.x as f32 * CELL, cell.z as f32 * CELL)
}

// ---------------------------------------------------------------------------------------------
// The compiled pack.

/// A thing a cell holds: the placement's kind, where it stands and its data text's FNV-1a 64.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Spot {
    /// The placement file's kind number.
    pub kind: u32,
    /// Where it stands, on the ground.
    pub at: Vec3,
    /// The FNV-1a 64 of its JSON data text.
    pub data: u64,
}

/// The compiled pack, read once: its `world.json` and every listed cell's content.
#[derive(Debug)]
pub struct Packs {
    /// The pack's grid and listed cells.
    pub world: PackWorld,
    /// Each listed cell's content.
    pub cells: BTreeMap<CellId, CellPack>,
}

static PACKS: LazyLock<Result<Packs, String>> = LazyLock::new(read_packs);

fn pack_bytes(file: &str) -> Result<&'static [u8], String> {
    let path = pack_file(PACK_FOLDER, file).map_err(|error| refusal(&error))?;
    PACK_FILES.iter().find(|(name, _)| *name == path).map(|(_, bytes)| *bytes).ok_or_else(|| format!("{path} is not in the pack table"))
}

fn refusal(error: &PackError) -> String {
    format!("{error:?}")
}

fn read_packs() -> Result<Packs, String> {
    let world = PackWorld::read(pack_bytes(genex_stream::pack::PACK_WORLD_FILE)?).map_err(|error| refusal(&error))?;
    let mut cells = BTreeMap::new();
    for entry in world.cells() {
        let pack = CellPack::read(entry, pack_bytes(&cell_file(entry.cell))?).map_err(|error| refusal(&error))?;
        cells.insert(entry.cell, pack);
    }
    Ok(Packs { world, cells })
}

/// The compiled pack, or why the built-in table does not read.
pub fn packs() -> Result<&'static Packs, &'static str> {
    PACKS.as_ref().map_err(String::as_str)
}

fn pack_of(cell: CellId) -> Option<&'static CellPack> {
    packs().ok().and_then(|packs| packs.cells.get(&cell))
}

fn grounded(tile: Option<&Terrain>, t: &PackTransform) -> Transform {
    let ground = tile.map_or_else(|| height(t.translation.x, t.translation.z), |tile| tile.height(t.translation.x, t.translation.z));
    Transform::from_translation(t.translation + Vec3::Y * ground).with_rotation(t.rotation).with_scale(t.scale)
}

fn collider(shape: &PackShape, at: &Transform) -> Option<ColliderBuilder> {
    let builder = match *shape {
        PackShape::Cuboid { half } => ColliderBuilder::cuboid(half.x, half.y, half.z),
        PackShape::Ball { radius } => ColliderBuilder::ball(radius),
        PackShape::Capsule { half_height, radius } => ColliderBuilder::capsule_y(half_height, radius),
        PackShape::Cylinder { half_height, radius } => ColliderBuilder::cylinder(half_height, radius),
        // The tiles stream the whole ground's colliders.
        PackShape::Heightfield { .. } => return None,
    };
    Some(builder.position(Pose::from_parts(at.translation, at.rotation)))
}

/// The pack's content for a cell, stood on `tile`: things, single models, colliders and groups.
fn add_pack(build: CellBuild<Spot>, pack: &CellPack, tile: Option<&Terrain>, inputs: &CellInputs, clear: &mut Vec<Vec2>) -> CellBuild<Spot> {
    let mut build = build;
    for thing in &pack.things {
        let at = grounded(tile, &thing.transform).translation;
        build = build.thing(Spot { kind: thing.kind, at, data: genex_core::digest::fnv1a64(thing.data.as_bytes()) });
    }
    for placed in &pack.models {
        let at = grounded(tile, &placed.transform);
        clear.push(vec2(at.translation.x, at.translation.z));
        build = build.model(&inputs.model(&placed.path), at);
    }
    let colliders = pack.colliders.iter().filter_map(|c| collider(&c.shape, &grounded(tile, &c.transform))).fold(CellColliders::new(), CellColliders::with);
    for group in &pack.groups {
        let placed: Vec<Transform> = group.instances.iter().map(|t| grounded(tile, t)).collect();
        clear.extend(placed.iter().map(|t| vec2(t.translation.x, t.translation.z)));
        if let Ok(group) = InstanceGroup::models(&inputs.model(&group.model), placed) {
            build = build.group(group);
        }
    }
    build.part(colliders)
}

// ---------------------------------------------------------------------------------------------
// Nav islands, baked offline.

/// A cell's nav island, carried as a part from its build to the commit.
pub struct IslandPart(pub NavIsland);

impl CellPart for IslandPart {}

/// The offline bake's input for a town cell: its ground (reaching a little past it, inside the
/// town) and the boxes of the pack's colliders in the cell and its eight neighbours, so the
/// islands of two cells meet where one bake's tiles would. The town is flat at height 0.
pub fn island_input(cell: CellId) -> NavInput {
    let min = (cell_min(cell) - Vec2::splat(NAV_MARGIN)).max(Vec2::splat(-TOWN_HALF));
    let max = (cell_min(cell) + Vec2::splat(CELL + NAV_MARGIN)).min(Vec2::splat(TOWN_HALF));
    let ground = [vec3(min.x, 0.0, min.y), vec3(max.x, 0.0, min.y), vec3(max.x, 0.0, max.y), vec3(min.x, 0.0, max.y)];
    let mut input = NavInput::new().with_triangles(&ground, &[0, 2, 1, 0, 3, 2], NavArea::WALK).expect("the town's ground");
    for dz in -1..=1 {
        for dx in -1..=1 {
            let Some(pack) = pack_of(CellId { x: cell.x + dx, z: cell.z + dz }) else { continue };
            for placed in &pack.colliders {
                let PackShape::Cuboid { half } = placed.shape else { continue };
                let at = grounded(None, &placed.transform);
                let matrix = Mat4::from_scale_rotation_translation(half * 2.0, at.rotation, at.translation);
                input = input.with_box(matrix, NavArea::WALK).expect("a placed box");
            }
        }
    }
    input
}

/// The island file of a town cell, under `assets/`.
pub fn island_path(cell: CellId) -> String {
    format!("islands/{}_{}.navmesh", cell.x, cell.z)
}

/// A town cell's offline island, read from the built-in table (`None` for any other cell).
fn island_of(cell: CellId) -> Option<NavIsland> {
    let path = island_path(cell);
    let bytes = ISLAND_FILES.iter().find(|(name, _)| *name == path).map(|(_, bytes)| *bytes)?;
    Some(NavIsland::from_bytes(bytes).expect("a committed island reads"))
}

// ---------------------------------------------------------------------------------------------
// The forest.

/// The pine every cell scatters, with its impostor (baked when the game is built).
pub fn pine(model: Model) -> Model {
    model.with_impostor(Impostor::hemi())
}

fn forest_rule() -> Scatter {
    Scatter::new(FOREST_DENSITY, &[0]).with_scale(0.7, 1.5).on_flat_ground(0.85).with_seed(41)
}

/// Whether a tree at `at` keeps clear of the town, the road and `clear`'s props.
fn tree_fits(at: Vec2, clear: &[Vec2]) -> bool {
    let off_town = at.x.abs().max(at.y.abs()) > TOWN_HALF + TOWN_CLEARING;
    let off_road = at.y.abs() > ROAD_CLEARING || at.x < -TOWN_HALF;
    off_town && off_road && clear.iter().all(|prop| prop.distance(at) > PROP_CLEARING)
}

/// The cell builder: the pack's content for the cell, the town cells' islands, then its forest.
pub fn cell_content(tiles: TerrainTiles) -> impl Fn(CellId, &CellInputs) -> CellBuild<Spot> + Send + Sync + 'static {
    move |cell, inputs| {
        let tile = tiles.tile(cell, CELL);
        let mut clear = Vec::new();
        let mut build = CellBuild::default();
        if let Some(pack) = pack_of(cell) {
            build = add_pack(build, pack, tile.as_ref(), inputs, &mut clear);
        }
        if let Some(island) = island_of(cell) {
            build = build.part(IslandPart(island));
        }
        let Some(tile) = tile else { return build };
        let trees: Vec<Transform> = inputs.scatter(&tile, &forest_rule()).into_iter().filter(|t| tree_fits(vec2(t.translation.x, t.translation.z), &clear)).collect();
        let group = InstanceGroup::models(&pine(inputs.model(PINE)), trees).and_then(|group| group.with_far(Far::thin(FAR_FIELD.0, FAR_FIELD.1)));
        match group {
            Ok(group) if !group.is_empty() => build.group(group),
            _ => build,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// GE fix r2: a patch made from its neighbour's heights holds every height a patch sampled
    /// whole holds, bit for bit, for each way the camera can cross into the next block.
    #[test]
    fn a_patch_made_from_its_neighbour_equals_one_sampled_whole() {
        let start = patch([0, 0], None);
        for block in [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [4, 0]] {
            let moved = patch(block, Some(&start));
            let whole = patch(block, None);
            let bits = |patch: &Patch| patch.heights.iter().map(|h| h.to_bits()).collect::<Vec<u32>>();
            assert_eq!(bits(&moved), bits(&whole), "block {block:?}");
        }
    }
}
