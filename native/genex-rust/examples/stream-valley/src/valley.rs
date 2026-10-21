//! The valley: a 4 x 4 km streamed world of 64 m cells.
//!
//! - **Terrain** is procedural ([`height`]): streamed tiles of 65 samples a side (STR-23) give the
//!   sim its ground and each sim-active cell its heightfield collider; the game draws one terrain
//!   patch around the camera, rebuilt when the camera moves to another 256 m block.
//! - **Authored content** comes from the compiled cell pack (`world/valley.cells.json` compiled by
//!   the host's C-28 compiler, `src/pack_table.rs`): ten villages of huts with their colliders, 40
//!   waystones along the ring road, the centre tower and 24 rock fields. Placements are authored as
//!   heights above the ground; the cell builder stands them on the tile's ground.
//! - **Forests** are scattered per cell on the tile (STR-20), clear of the road and the props.
//! - **The anchor** drives the ring road at [`ANCHOR_SPEED`] (the STR-26b fly-through speed); the
//!   camera follows it. Things that enter are counted by kind in cell order, so two runs agree.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::LazyLock;

use genex::math::{self, Vec2, Vec3, vec2, vec3};
use genex::render::Environment;
use genex::{
    CellBuild, CellColliders, CellId, CellInputs, Color, FIXED_STEP_MS, Frame, Game, InstanceGroup, Scatter, Sim, StreamColliders, Streaming, Terrain,
    TerrainLayer, TerrainTiles, Transform, Value, json,
};
use genex::physics::{ColliderBuilder, Pose};
use genex::{Camera, Ctx};
use genex_core::digest::{fnv1a64, hex64};
use genex_stream::pack::{PackShape, PackTransform, cell_file, pack_file};
use genex_stream::{CellPack, PackError, PackWorld};

use crate::pack_table::{PACK_FILES, PACK_FOLDER};
use crate::props::PINE;

/// The cell side, in metres.
pub const CELL: f32 = 64.0;
/// Half the world's side, in metres: cells -32..=31 on both axes.
pub const WORLD_HALF: f32 = 2048.0;
/// Samples a streamed tile side.
pub const TILE_SAMPLES: u32 = 65;
/// The tiles' quantization range, in metres.
pub const HEIGHT_RANGE: (f32, f32) = (-32.0, 160.0);
/// The ring road's radius, in metres.
pub const RING_RADIUS: f32 = 1190.0;
/// How fast the anchor drives the road, metres a second (STR-26b's fly-through).
pub const ANCHOR_SPEED: f32 = 30.0;
/// The anchor's height over the ground, in metres.
pub const ANCHOR_HEIGHT: f32 = 2.0;
/// The sim radius, hysteresis and prefetch ring, in cells.
pub const SIM_RADII: [u32; 3] = [2, 1, 1];
/// Cells within this many metres of the camera are drawn.
pub const VIEW_METRES: f32 = 448.0;
/// The observer camera high over the anchor, which shows the streamed cells around it.
pub const OVERVIEW: &str = "overview";
/// The overview's height and distance behind the anchor, in metres.
const OVERVIEW_OFFSET: Vec3 = Vec3::new(0.0, 300.0, -260.0);
/// The anchor's name.
pub const ANCHOR: &str = "player";
/// Kinds of the placement file's things.
pub const KIND_VILLAGE: u32 = 1;
/// A waystone on the ring road.
pub const KIND_STONE: u32 = 2;
/// The centre tower.
pub const KIND_TOWER: u32 = 3;
/// Trees a square metre in the forests.
const FOREST_DENSITY: f32 = 0.012;
/// No tree grows closer than this to a prop, in metres.
const PROP_CLEARING: f32 = 9.0;
/// No tree grows closer than this to the road's centre line, in metres.
const ROAD_CLEARING: f32 = 12.0;
/// The drawn terrain patch: samples a side, their spacing and the block it snaps to.
const PATCH_SAMPLES: u32 = 769;
const PATCH_SPACING: f32 = 2.0;
const PATCH_BLOCK: f32 = 256.0;
/// The camera's offset behind and above the anchor, and how far ahead it looks, in metres.
const CAMERA_BACK: f32 = 38.0;
const CAMERA_UP: f32 = 22.0;
const CAMERA_AHEAD: f32 = 70.0;
const SKY: Color = Color::rgb(150, 180, 215);
const MEADOW: Color = Color::rgb(86, 120, 58);
/// Towards the sun (`Frame::sun`): low in the south-west, so the props cast long shadows.
const SUN_TOWARDS: Vec3 = Vec3::new(-0.5, 0.6, -0.6);

/// The valley's ground at world (`x`, `z`), in metres: a bowl rising towards the rim with ripples.
/// Pure and libm-backed, so every destination and thread computes the same bits.
pub fn height(x: f32, z: f32) -> f32 {
    let t = (math::sqrt(x * x + z * z) / 2000.0).min(1.0);
    let bowl = 120.0 * t * t * t;
    let ripples = 6.0 * math::sin(x / 97.0) * math::cos(z / 131.0) + 2.5 * math::sin((x - z) / 41.0);
    bowl + ripples
}

/// Where the anchor is at `tick`: on the ring road, driving anticlockwise at [`ANCHOR_SPEED`].
pub fn anchor_at(tick: u64) -> Vec3 {
    let (x, z) = ring_point(tick);
    vec3(x, height(x, z) + ANCHOR_HEIGHT, z)
}

fn ring_point(tick: u64) -> (f32, f32) {
    let seconds = tick as f32 * FIXED_STEP_MS as f32 / 1000.0;
    let angle = seconds * ANCHOR_SPEED / RING_RADIUS;
    let (sin, cos) = math::sin_cos(angle);
    (RING_RADIUS * cos, RING_RADIUS * sin)
}

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

fn table_bytes(path: &str) -> Option<&'static [u8]> {
    PACK_FILES.iter().find(|(name, _)| *name == path).map(|(_, bytes)| *bytes)
}

/// The bytes of `<folder>/<file>` in the built-in table, or why there are none.
fn pack_bytes(file: &str) -> Result<&'static [u8], String> {
    let path = pack_file(PACK_FOLDER, file).map_err(|error| refusal(&error))?;
    table_bytes(&path).ok_or_else(|| format!("{path} is not in the pack table"))
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

/// The valley's streamed terrain tiles.
pub fn tiles() -> TerrainTiles {
    let tiles = TerrainTiles::procedural(TILE_SAMPLES, height).expect("65 samples a tile is a tile size");
    tiles.with_height_range(HEIGHT_RANGE.0, HEIGHT_RANGE.1).expect("an ordered finite range")
}

/// The game's world.
#[derive(Debug, Default)]
pub struct World {
    /// The drawn terrain patch and the block it is centred on.
    pub patch: Option<(Terrain, [i32; 2])>,
    /// Where the anchor is.
    pub at: Vec3,
    /// The direction the anchor drives, on the ground plane.
    pub heading: Vec3,
    /// Cells entered so far.
    pub entered: u32,
    /// Things entered so far, by kind.
    pub kinds: BTreeMap<u32, u32>,
    /// The villages seen (their data digests).
    pub villages: BTreeSet<u64>,
    /// A digest over every entered thing, in commit order.
    pub things_digest: u64,
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

/// The pack's content for `cell`, stood on `tile`: things, single models, colliders and groups.
fn add_pack(build: CellBuild<Spot>, pack: &CellPack, tile: Option<&Terrain>, inputs: &CellInputs, clear: &mut Vec<Vec2>) -> CellBuild<Spot> {
    let mut build = build;
    for thing in &pack.things {
        let at = grounded(tile, &thing.transform).translation;
        build = build.thing(Spot { kind: thing.kind, at, data: fnv1a64(thing.data.as_bytes()) });
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

fn forest_rule() -> Scatter {
    Scatter::new(FOREST_DENSITY, &[0]).with_scale(0.7, 1.4).on_flat_ground(0.9).with_seed(31)
}

/// Whether a tree at `at` keeps clear of the road and of `clear`'s props.
fn tree_fits(at: Vec2, clear: &[Vec2]) -> bool {
    let off_road = (at.length() - RING_RADIUS).abs() > ROAD_CLEARING;
    off_road && clear.iter().all(|prop| prop.distance(at) > PROP_CLEARING)
}

/// The cell builder: the pack's content for the cell, then its forest.
fn cell_content(tiles: TerrainTiles) -> impl Fn(CellId, &CellInputs) -> CellBuild<Spot> + Send + Sync + 'static {
    move |cell, inputs| {
        let tile = tiles.tile(cell, CELL);
        let mut clear = Vec::new();
        let mut build = CellBuild::default();
        if let Some(pack) = packs().ok().and_then(|packs| packs.cells.get(&cell)) {
            build = add_pack(build, pack, tile.as_ref(), inputs, &mut clear);
        }
        let Some(tile) = tile else { return build };
        let trees: Vec<Transform> = inputs.scatter(&tile, &forest_rule()).into_iter().filter(|t| tree_fits(vec2(t.translation.x, t.translation.z), &clear)).collect();
        match InstanceGroup::models(&inputs.model(PINE), trees) {
            Ok(group) if !group.is_empty() => build.group(group),
            _ => build,
        }
    }
}

fn patch_block(at: Vec3) -> [i32; 2] {
    [math::round(at.x / PATCH_BLOCK) as i32, math::round(at.z / PATCH_BLOCK) as i32]
}

fn patch(block: [i32; 2]) -> Terrain {
    let half = (PATCH_SAMPLES - 1) as f32 * PATCH_SPACING * 0.5;
    let origin = vec2(block[0] as f32 * PATCH_BLOCK - half, block[1] as f32 * PATCH_BLOCK - half);
    let terrain = Terrain::from_fn([PATCH_SAMPLES, PATCH_SAMPLES], origin, PATCH_SPACING, height).expect("the patch is within the sample cap");
    terrain.with_layers(vec![TerrainLayer::flat(MEADOW).with_roughness(0.95)]).expect("one layer")
}

fn follow(sim: &mut Sim<World>, tick: u64) {
    let at = anchor_at(tick);
    let ahead = anchor_at(tick + 60);
    sim.world.heading = (ahead - at).with_y(0.0).normalize_or(Vec3::X);
    sim.world.at = at;
    sim.stream.set_anchor(ANCHOR, at).expect("the ring road is inside the world");
    let block = patch_block(at);
    if sim.world.patch.as_ref().is_none_or(|(_, drawn)| *drawn != block) {
        sim.world.patch = Some((patch(block), block));
    }
}

fn count_entered(sim: &mut Sim<World>) {
    let mut digest = sim.world.things_digest;
    let mut entered = Vec::new();
    for cell in sim.stream.entered() {
        entered.extend(cell.things::<Spot>().copied());
        sim.world.entered += 1;
    }
    for spot in entered {
        *sim.world.kinds.entry(spot.kind).or_default() += 1;
        if spot.kind == KIND_VILLAGE {
            sim.world.villages.insert(spot.data);
        }
        let bits = [spot.kind, spot.at.x.to_bits(), spot.at.y.to_bits(), spot.at.z.to_bits()];
        let bytes: Vec<u8> = bits.iter().flat_map(|v| v.to_le_bytes()).chain(spot.data.to_le_bytes()).collect();
        digest = genex_core::digest::fnv1a64_from(&bytes, digest);
    }
    sim.world.things_digest = digest;
}

/// The game's own view: behind and above the anchor, looking down the road.
pub fn camera(world: &World) -> Camera {
    let eye = world.at - world.heading * CAMERA_BACK + Vec3::Y * CAMERA_UP;
    Camera::look_at(eye, world.at + world.heading * CAMERA_AHEAD)
}

fn draw(sim: &Sim<World>, frame: &mut Frame, _camera: &Camera) {
    frame.clear(SKY).ambient(Color::rgb(170, 190, 220), 0.3).sun(SUN_TOWARDS, Color::WHITE, 3.0);
    frame.environment(Environment::sky());
    if let Some((terrain, _)) = &sim.world.patch {
        frame.tag("terrain").terrain(terrain);
    }
}

fn probe(sim: &Sim<World>) -> Value {
    let world = &sim.world;
    let kinds: BTreeMap<String, u32> = world.kinds.iter().map(|(kind, count)| (kind.to_string(), *count)).collect();
    json!({
        "active": sim.stream.active().count(),
        "entered": world.entered,
        "kinds": kinds,
        "villages": world.villages.len(),
        "things": hex64(world.things_digest),
        "colliders": sim.facets.get::<StreamColliders>().len(),
        "ground": sim.stream.ground(world.at.x, world.at.z).map(f32::to_bits),
    })
}

/// Register the valley on `game`: streaming, the cell builders, the anchor, the camera and probes.
pub fn wire(game: &mut Game<World>) {
    let tiles = tiles();
    let [radius, hysteresis, prefetch] = SIM_RADII;
    game.streaming(Streaming::grid(CELL).sim_radius(radius).hysteresis(hysteresis).prefetch(prefetch).view_radius(VIEW_METRES).terrain(tiles.clone()));
    game.cell_content(cell_content(tiles.clone()));
    game.cell_content(tiles.colliders_content(CELL));
    game.stream_colliders();
    game.on_reset(|sim, _, _, _| follow(sim, 0));
    game.on_update(|sim, ctx: &Ctx<'_>| {
        count_entered(sim);
        follow(sim, ctx.tick + 1);
    });
    game.camera(|sim| camera(&sim.world));
    game.named_camera(OVERVIEW, |sim| Camera::look_at(sim.world.at + OVERVIEW_OFFSET, sim.world.at));
    game.on_draw(draw);
    game.probe("valley", probe);
}
