//! The world, the walker, the villagers and the rules that move them.
//!
//! The world is 6 x 3 cells of 16 m on the ground (x 0..96 m, z 0..48 m), streamed round one
//! anchor on the walker with a sim radius of 1 (3 x 3 cells simulated). Every cell is procedural and
//! pure (its seed and its id, never the world or a clock), built on a stream worker:
//! - its ground slab and rocks as static colliders (`game.stream_colliders()`);
//! - its rocks as things the world keeps while the cell is simulated, for drawing;
//! - its nav island, baked from the cell's ground and the rocks of the cell and its neighbours
//!   (so the islands of two cells meet where one bake's tiles would), carried as a part and added
//!   to `sim.nav` in the stream commit through `StreamedNav` (leaves descending, then enters
//!   ascending; a late island holds the frame).
//!
//! The walker is the GLB character `walker.glb` with an idle and a walk with root motion, driven
//! by nav through the documented loop: `sim.nav.update(dt)` once, its desired velocity into the
//! animator's `speed`, `animator.update(dt)`, `character.drive(.., CharacterMotion::Mixed { .. })`,
//! then `nav.set_position`. It walks east to [`FAR`] and back [`HOME`], and the anchor follows it.
//!
//! Villagers wander between spots near home. When the walker is far, their cells stream out: their
//! agents go `off-mesh` and freeze, and their capsules are not driven (characters in unloaded cells
//! freeze, owner call X1). When the walker comes back the cells stream in and they walk on.

use genex::nav::{AgentId, NavAgent, NavArea, NavConfig, NavDebug, NavInput, NavIsland, NavIslands, NavStatus, StreamedNav};
use genex::physics::ColliderBuilder;
use genex::prelude::*;
use genex::animation::{FloatParam, MotionSettings};
use genex::{CellBuild, CellColliders, CellId, CellInputs, CellPart, CharacterParams, EnteredCell, StreamCommit, Streaming};

/// Stream cells and nav tiles, metres (four tiles a cell).
pub const CELL: f32 = 16.0;
const TILE: f32 = 8.0;
/// The world's cells along x and z.
pub const WORLD_CELLS: [i32; 2] = [6, 3];
/// Where the walker starts and ends.
pub const HOME: Vec3 = Vec3::new(8.0, 0.0, 24.0);
/// The far end of its walk (three cells east: the cells round home stream out).
pub const FAR: Vec3 = Vec3::new(76.0, 0.0, 24.0);
/// Villagers.
pub const VILLAGERS: usize = 6;
/// The observer camera that sits where the game camera does.
pub const OBSERVER: &str = "observer";
/// The anchor's name.
const ANCHOR: &str = "walker";

/// Rocks a cell tries to place, how far from a cell edge they stand, and how far they keep from
/// every spot something stands on or walks to.
const ROCK_TRIES: u32 = 3;
const ROCK_EDGE: f32 = 1.5;
const ROCK_CLEARANCE: f32 = 2.6;
/// The nav input reaches this far past its cell (more than a tile's border), metres.
const NAV_MARGIN: f32 = 3.0;
/// Waypoints along the walk, metres apart, and how near one the walker heads for the next.
const WAYPOINT_STEP: f32 = 8.0;
const WAYPOINT_SWITCH: f32 = 3.0;
/// The walker's preferred and top speed and its reach, metres (per second).
const WALKER_SPEED: (f32, f32) = (2.2, 3.0);
const WALKER_REACH: f32 = 0.6;
/// How much of the walker's move its clip makes.
const ROOT_SHARE: f32 = 0.5;
/// The walk plays above this speed, metres per second.
const WALK_ABOVE: f32 = 0.1;
/// Villagers' preferred and top speed and reach.
const VILLAGER_SPEED: (f32, f32) = (1.3, 1.8);
const VILLAGER_REACH: f32 = 0.6;
/// Where the villagers start, and the spots they wander between.
const VILLAGER_SPAWNS: [Vec3; VILLAGERS] =
    [Vec3::new(4.0, 0.0, 8.0), Vec3::new(12.0, 0.0, 8.0), Vec3::new(20.0, 0.0, 8.0), Vec3::new(4.0, 0.0, 40.0), Vec3::new(12.0, 0.0, 40.0), Vec3::new(22.0, 0.0, 40.0)];
const VILLAGE_SPOTS: [Vec3; 8] = [
    Vec3::new(4.0, 0.0, 6.0),
    Vec3::new(14.0, 0.0, 12.0),
    Vec3::new(26.0, 0.0, 6.0),
    Vec3::new(28.0, 0.0, 18.0),
    Vec3::new(4.0, 0.0, 30.0),
    Vec3::new(14.0, 0.0, 36.0),
    Vec3::new(26.0, 0.0, 42.0),
    Vec3::new(6.0, 0.0, 44.0),
];

/// Look.
const SKY: Color = Color::rgb(150, 182, 216);
const SUN_TOWARDS: Vec3 = vec3(-0.45, 0.7, -0.55);
const GRASS: [Color; 2] = [Color::rgb(96, 132, 72), Color::rgb(108, 142, 80)];
const FAR_LAND: Color = Color::rgb(84, 112, 66);
/// The backdrop's side, metres.
const BACKDROP: f32 = 800.0;
const ROCK: Color = Color::rgb(138, 132, 124);
const VILLAGER: Color = Color::rgb(176, 96, 64);
const FROZEN: Color = Color::rgb(120, 170, 230);

/// A rock: its centre, half extents and turn about y (radians).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rock {
    /// Its centre, metres.
    pub center: Vec3,
    /// Its half extents, metres.
    pub half: Vec3,
    /// Its turn about y, radians.
    pub yaw: f32,
}

/// A cell's nav island, carried as a part from its build to the commit.
struct IslandPart(NavIsland);

impl CellPart for IslandPart {}

/// The walker: its nav agent, animator, speed parameter and capsule.
struct Walker {
    agent: AgentId,
    animator: Animator,
    speed: FloatParam,
    character: Character,
    /// The waypoint of [`route`] it heads for (past the end: home and done).
    waypoint: usize,
    /// Metres the clip moved it.
    rooted: f32,
}

/// One villager: its agent, its capsule and what the freeze rows read.
struct Villager {
    agent: AgentId,
    character: Character,
    arrivals: u32,
    /// Frozen now (its cell is not simulated), and where its agent and feet stood when it froze.
    frozen: Option<(Vec3, Vec3)>,
    /// Ticks frozen, freezes, resumes and arrivals made after its first resume.
    frozen_ticks: u32,
    freezes: u32,
    resumes: u32,
    arrivals_after_resume: u32,
}

/// Everything the simulation owns.
#[derive(Default)]
pub struct World {
    /// The walker's animator, built at reset and placed with its capsule and agent on the first
    /// tick (the cells, their colliders and islands enter in that tick's commit).
    pending: Option<(Animator, FloatParam)>,
    walker: Option<Walker>,
    villagers: Vec<Villager>,
    rocks: Vec<(CellId, Rock)>,
    rng: Option<Pcg32>,
    tick: u64,
    /// Ticks the walker reached FAR and got back HOME.
    far_tick: Option<u64>,
    home_tick: Option<u64>,
    /// Frozen villager ticks whose agent was not `off-mesh`, or whose agent or capsule moved.
    freeze_breaks: u32,
    /// Most cells simulated at once, and islands entered and left.
    active_peak: usize,
    /// Where the anchor was set last, and ticks on which a cell within one of its cell was not
    /// simulated (the 3 x 3 round the walker).
    anchor: Vec3,
    sim_misses: u32,
    islands_entered: u32,
    islands_left: u32,
}

/// What the probes and the rows read.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SliceTotals {
    /// The tick the walker reached the far end.
    pub far_tick: Option<u64>,
    /// The tick it got back home.
    pub home_tick: Option<u64>,
    /// Villager freezes (a villager's cell streamed out under it).
    pub freezes: u32,
    /// Villager resumes (its cell streamed back in).
    pub resumes: u32,
    /// Villager ticks spent frozen.
    pub frozen_ticks: u32,
    /// Frozen villager ticks whose agent was not `off-mesh`, or whose agent or capsule moved.
    pub freeze_breaks: u32,
    /// Villager arrivals at spots.
    pub arrivals: u32,
    /// Villager arrivals after the villager's first resume.
    pub arrivals_after_resume: u32,
    /// Most cells simulated at once (the 3 x 3 plus the cells hysteresis keeps).
    pub active_peak: usize,
    /// Ticks on which a cell of the 3 x 3 round the anchor was not simulated.
    pub sim_misses: u32,
    /// Nav islands entered in the commit.
    pub islands_entered: u32,
    /// Nav islands left in the commit.
    pub islands_left: u32,
    /// Metres the walker's clip moved it.
    pub rooted: f32,
}

impl World {
    /// The slice's totals.
    pub fn totals(&self) -> SliceTotals {
        let villagers = &self.villagers;
        SliceTotals {
            far_tick: self.far_tick,
            home_tick: self.home_tick,
            freezes: villagers.iter().map(|v| v.freezes).sum(),
            resumes: villagers.iter().map(|v| v.resumes).sum(),
            frozen_ticks: villagers.iter().map(|v| v.frozen_ticks).sum(),
            freeze_breaks: self.freeze_breaks,
            arrivals: villagers.iter().map(|v| v.arrivals).sum(),
            arrivals_after_resume: villagers.iter().map(|v| v.arrivals_after_resume).sum(),
            active_peak: self.active_peak,
            sim_misses: self.sim_misses,
            islands_entered: self.islands_entered,
            islands_left: self.islands_left,
            rooted: self.walker.as_ref().map_or(0.0, |w| w.rooted),
        }
    }

    /// The walker's feet, once it is in the world.
    pub fn walker_feet(&self) -> Option<Vec3> {
        self.walker.as_ref().map(|w| w.character.feet())
    }

    /// The walker's animator digest (its whole state).
    pub fn walker_pose(&self) -> u64 {
        self.walker.as_ref().map_or(0, |w| w.animator.digest())
    }

    /// The rocks the world holds now (cells simulated), in the order they entered.
    pub fn rocks(&self) -> usize {
        self.rocks.len()
    }
}

/// The capsule everyone uses.
fn params() -> CharacterParams {
    CharacterParams::default()
}

/// The walker the bake uses: the capsule's own (`character.nav_config()`), 8 m tiles.
pub fn nav_config() -> NavConfig {
    let probe = Character::on_ground(Vec3::ZERO, params()).expect("default parameters");
    probe.nav_config().with_tile(TILE)
}

/// The cell under a point.
pub fn cell_of(at: Vec3) -> CellId {
    CellId { x: (at.x / CELL).floor() as i32, z: (at.z / CELL).floor() as i32 }
}

fn in_world(cell: CellId) -> bool {
    (0..WORLD_CELLS[0]).contains(&cell.x) && (0..WORLD_CELLS[1]).contains(&cell.z)
}

fn cell_min(cell: CellId) -> Vec2 {
    vec2(cell.x as f32 * CELL, cell.z as f32 * CELL)
}

// ---------------------------------------------------------------------------------------------
// The cells: pure functions of the world seed and the cell.

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

fn fnv(hash: u64, bytes: &[u8]) -> u64 {
    bytes.iter().fold(hash, |hash, byte| (hash ^ u64::from(*byte)).wrapping_mul(FNV_PRIME))
}

/// Every spot something stands on or walks to: rocks keep clear of them.
fn keep_clear() -> impl Iterator<Item = Vec3> {
    route().into_iter().chain([HOME]).chain(VILLAGER_SPAWNS).chain(VILLAGE_SPOTS)
}

/// The rocks of `cell` for world seed `seed` (none outside the world).
pub fn rocks_of(seed: u32, cell: CellId) -> Vec<Rock> {
    if !in_world(cell) {
        return Vec::new();
    }
    let hash = [seed.to_le_bytes(), cell.x.to_le_bytes(), cell.z.to_le_bytes()].iter().fold(FNV_OFFSET, |hash, bytes| fnv(hash, bytes));
    let mut rng = Pcg32::seeded(hash);
    let min = cell_min(cell);
    let mut rocks = Vec::new();
    for _ in 0..ROCK_TRIES {
        let at = vec3(rng.range_f32(min.x + ROCK_EDGE, min.x + CELL - ROCK_EDGE), 0.0, rng.range_f32(min.y + ROCK_EDGE, min.y + CELL - ROCK_EDGE));
        let half = vec3(rng.range_f32(0.5, 1.2), rng.range_f32(0.5, 1.0), rng.range_f32(0.5, 1.2));
        let yaw = rng.range_f32(0.0, std::f32::consts::PI);
        let clear = keep_clear().all(|spot| vec2(spot.x - at.x, spot.z - at.z).length() > ROCK_CLEARANCE + half.max_element());
        if clear {
            rocks.push(Rock { center: at + Vec3::Y * half.y, half, yaw });
        }
    }
    rocks
}

fn rock_matrix(rock: &Rock) -> Mat4 {
    Mat4::from_scale_rotation_translation(rock.half * 2.0, Quat::from_rotation_y(rock.yaw), rock.center)
}

/// The nav input of `cell`: its ground (reaching [`NAV_MARGIN`] past it, inside the world) and the
/// rocks of the cell and its eight neighbours.
fn nav_input(seed: u32, cell: CellId) -> NavInput {
    let world_max = vec2(WORLD_CELLS[0] as f32, WORLD_CELLS[1] as f32) * CELL;
    let min = (cell_min(cell) - Vec2::splat(NAV_MARGIN)).max(Vec2::ZERO);
    let max = (cell_min(cell) + Vec2::splat(CELL + NAV_MARGIN)).min(world_max);
    let ground = [vec3(min.x, 0.0, min.y), vec3(max.x, 0.0, min.y), vec3(max.x, 0.0, max.y), vec3(min.x, 0.0, max.y)];
    let mut input = NavInput::new().with_triangles(&ground, &[0, 2, 1, 0, 3, 2], NavArea::WALK).expect("the ground");
    for dz in -1..=1 {
        for dx in -1..=1 {
            for rock in rocks_of(seed, CellId { x: cell.x + dx, z: cell.z + dz }) {
                input = input.with_box(rock_matrix(&rock), NavArea::WALK).expect("a rock");
            }
        }
    }
    input
}

/// Build one cell: rocks as things, the ground slab and rocks as colliders, and the nav island.
fn build_cell(cell: CellId, inputs: &CellInputs) -> CellBuild<Rock> {
    if !in_world(cell) {
        return CellBuild::default();
    }
    let rocks = rocks_of(inputs.seed(), cell);
    let center = cell_min(cell) + Vec2::splat(0.5 * CELL);
    let mut colliders = CellColliders::new().with(ColliderBuilder::cuboid(0.5 * CELL, 0.5, 0.5 * CELL).translation(vec3(center.x, -0.5, center.y)));
    for rock in &rocks {
        colliders.push(ColliderBuilder::cuboid(rock.half.x, rock.half.y, rock.half.z).translation(rock.center).rotation(vec3(0.0, rock.yaw, 0.0)));
    }
    let island = NavIsland::bake_cell(&nav_input(inputs.seed(), cell), &nav_config(), cell, CELL).expect("the cell's island bakes");
    let build = CellBuild::default().part(colliders).part(IslandPart(island));
    rocks.into_iter().fold(build, CellBuild::thing)
}

/// The commit hook: a cell's island goes into `sim.nav` as the cell enters and out as it leaves.
struct IslandCommit;

impl StreamCommit<World> for IslandCommit {
    fn leave(&self, sim: &mut Sim<World>, cell: CellId) {
        let islands = sim.facets.get_mut::<NavIslands>();
        if (StreamedNav { nav: &mut sim.nav, islands }).island_leave(cell) > 0 {
            sim.world.islands_left += 1;
        }
    }

    fn enter(&self, sim: &mut Sim<World>, cell: &EnteredCell) {
        let Some(IslandPart(island)) = cell.parts::<IslandPart>().next() else { return };
        let islands = sim.facets.get_mut::<NavIslands>();
        if (StreamedNav { nav: &mut sim.nav, islands }).island_enter(cell.cell(), island) > 0 {
            sim.world.islands_entered += 1;
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Registration.

/// Register every hook.
pub(crate) fn wire(game: &mut Game<World>) {
    game.streaming(Streaming::grid(CELL).sim_radius(1));
    game.navigation(nav_config());
    game.cell_content(build_cell);
    game.stream_colliders();
    game.facet_state::<NavIslands>();
    game.stream_commit(IslandCommit);
    game.on_reset(reset);
    game.on_update(update);
    game.on_draw(draw);
    game.camera(game_camera);
    game.named_camera(OBSERVER, game_camera);
    game.probe("slice", |sim| {
        let totals = sim.world.totals();
        let feet = sim.world.walker_feet().unwrap_or(Vec3::ZERO);
        json!({
            "walker": [feet.x, feet.y, feet.z],
            "waypoint": sim.world.walker.as_ref().map_or(0, |w| w.waypoint),
            "pose": format!("{:016x}", sim.world.walker_pose()),
            "farTick": totals.far_tick,
            "homeTick": totals.home_tick,
            "freezes": totals.freezes,
            "resumes": totals.resumes,
            "frozenTicks": totals.frozen_ticks,
            "freezeBreaks": totals.freeze_breaks,
            "arrivals": totals.arrivals,
            "rocks": sim.world.rocks(),
            "islands": format!("{:016x}", sim.facets.get::<NavIslands>().digest(&sim.nav)),
        })
    });
    game.probe("nav", |sim| Value::from(&sim.nav.probe()));
}

/// The game's view (and the observer's): behind and above the walker, looking past it.
fn game_camera(sim: &Sim<World>) -> Camera {
    let at = sim.world.walker_feet().unwrap_or(HOME);
    Camera::look_at(at + vec3(-5.0, 6.0, -9.0), at + vec3(2.0, 0.8, 3.0))
}

fn reset(sim: &mut Sim<World>, seed: u32, _: &mut Pcg32, gfx: &Gfx) {
    sim.world = World { rng: Some(Pcg32::seeded(u64::from(seed) ^ 0x5eed)), anchor: HOME, ..World::default() };
    sim.stream.set_anchor(ANCHOR, HOME).expect("home is inside the world");
    let walker = gfx.character("walker.glb").expect("walker.glb animates");
    let moving = walker.with_root_motion(&MotionSettings::DEFAULT).expect("the walker's root");
    let (Some(idle), Some(walk)) = (moving.clip("Idle"), moving.clip("Walk")) else { panic!("walker.glb has an Idle and a Walk") };
    let mut g = moving.graph();
    let speed = g.float("speed", 0.0);
    let base = g.layer("base");
    let idle = g.state(base, "idle", genex::animation::Motion::clip(idle));
    let walk = g.state(base, "walk", genex::animation::Motion::clip(walk));
    g.transition(idle, walk).when(speed.above(WALK_ABOVE)).inertialize(0.15);
    g.transition(walk, idle).when(speed.below(WALK_ABOVE)).inertialize(0.2);
    let animator = moving.animator(&g.build().expect("the walker's graph")).expect("the walker's animator");
    sim.world.pending = Some((animator, speed));
}

// ---------------------------------------------------------------------------------------------
// The tick.

fn update(sim: &mut Sim<World>, ctx: &Ctx) {
    sim.world.tick += 1;
    note_cells(sim);
    // 1. Nav first, once.
    sim.nav.update(ctx.dt);
    if sim.world.walker.is_none() {
        spawn(sim);
    }
    step_walker(sim, ctx.dt);
    for index in 0..sim.world.villagers.len() {
        step_villager(sim, index, ctx.dt);
    }
    let feet = sim.world.walker_feet().unwrap_or(HOME);
    sim.stream.set_anchor(ANCHOR, feet).expect("the walker stays inside the world");
    sim.world.anchor = feet;
}

/// Keep the rocks of the simulated cells, and count cells.
fn note_cells(sim: &mut Sim<World>) {
    let left = sim.stream.left().to_vec();
    sim.world.rocks.retain(|(cell, _)| !left.contains(cell));
    let entered: Vec<(CellId, Rock)> = sim.stream.entered().iter().flat_map(|cell| cell.things::<Rock>().map(|rock| (cell.cell(), *rock)).collect::<Vec<_>>()).collect();
    sim.world.rocks.extend(entered);
    let active = sim.stream.active().count();
    sim.world.active_peak = sim.world.active_peak.max(active);
    let anchor = cell_of(sim.world.anchor);
    let around = (-1..=1).flat_map(|dz| (-1..=1).map(move |dx| CellId { x: anchor.x + dx, z: anchor.z + dz }));
    if !around.into_iter().all(|cell| sim.stream.is_active(cell)) {
        sim.world.sim_misses += 1;
    }
}

fn spawn(sim: &mut Sim<World>) {
    let Some((animator, speed)) = sim.world.pending.take() else { return };
    let agent = sim.nav.add_agent(NavAgent::new(HOME).with_speed(WALKER_SPEED.0, WALKER_SPEED.1).with_reach(WALKER_REACH)).expect("the walker's agent");
    let character = Character::spawn(&mut sim.physics, HOME, params()).expect("the walker's capsule");
    sim.nav.move_to(agent, route()[0]);
    sim.world.walker = Some(Walker { agent, animator, speed, character, waypoint: 0, rooted: 0.0 });
    for at in VILLAGER_SPAWNS {
        let agent = sim.nav.add_agent(NavAgent::new(at).with_speed(VILLAGER_SPEED.0, VILLAGER_SPEED.1).with_reach(VILLAGER_REACH)).expect("a villager's agent");
        let character = Character::spawn(&mut sim.physics, at, params()).expect("a villager's capsule");
        // Villagers are sensors: the walker's capsule is never stood on or pushed by them; the nav's
        // avoidance keeps everyone apart.
        if let Some(collider) = character.collider().and_then(|handle| sim.physics.colliders.get_mut(handle)) {
            collider.set_sensor(true);
        }
        sim.world.villagers.push(Villager { agent, character, arrivals: 0, frozen: None, frozen_ticks: 0, freezes: 0, resumes: 0, arrivals_after_resume: 0 });
    }
    for index in 0..sim.world.villagers.len() {
        send_villager(sim, index);
    }
}

/// The documented loop for the walker: desired velocity into the animator, the animator's root
/// motion and the velocity into the capsule, the capsule's feet back to nav.
fn step_walker(sim: &mut Sim<World>, dt: f32) {
    let tick = sim.world.tick;
    let Some(walker) = sim.world.walker.as_mut() else { return };
    advance_route(walker, &mut sim.nav, tick, &mut sim.world.far_tick, &mut sim.world.home_tick);
    // 2. The desired velocity into the animator; 3. the animator's root motion.
    let wish = sim.nav.desired_velocity(walker.agent);
    walker.animator.set_float(walker.speed, wish.length());
    let root = walker.animator.update(dt).root_motion;
    walker.rooted += root.translation.length();
    // 4. The character makes the move; 5. nav hears where it went.
    walker.character.drive(&mut sim.physics, CharacterMotion::Mixed { root, wish, jump: false, root_share: ROOT_SHARE }, dt);
    sim.nav.set_position(walker.agent, walker.character.feet(), walker.character.velocity());
}

/// The walker's route: waypoints every [`WAYPOINT_STEP`] east from home to [`FAR`], then back.
/// Each waypoint lies in a cell the walker's anchor keeps simulated (a target in a cell that is not
/// in yet is `target-off-mesh`).
fn route() -> Vec<Vec3> {
    let steps = ((FAR.x - HOME.x) / WAYPOINT_STEP).ceil() as usize;
    let out = (1..=steps).map(|k| vec3((HOME.x + k as f32 * WAYPOINT_STEP).min(FAR.x), 0.0, HOME.z));
    let back = (0..steps).rev().map(|k| vec3(HOME.x + k as f32 * WAYPOINT_STEP, 0.0, HOME.z));
    out.chain(back).collect()
}

/// Head for the next waypoint once within [`WAYPOINT_SWITCH`] of this one (so the walk does not
/// stop at each); FAR and HOME are reached by arriving.
fn advance_route(walker: &mut Walker, nav: &mut genex::nav::Nav, tick: u64, far_tick: &mut Option<u64>, home_tick: &mut Option<u64>) {
    let route = route();
    let Some(target) = route.get(walker.waypoint).copied() else { return };
    let arrived = nav.status(walker.agent) == Some(NavStatus::Arrived);
    let end = target == FAR || walker.waypoint + 1 == route.len();
    let near = vec2(target.x - walker.character.feet().x, target.z - walker.character.feet().z).length() < WAYPOINT_SWITCH;
    if !(arrived || (near && !end)) {
        return;
    }
    if target == FAR {
        *far_tick = Some(tick);
    }
    walker.waypoint += 1;
    match route.get(walker.waypoint) {
        Some(next) => {
            nav.move_to(walker.agent, *next);
        }
        None => {
            *home_tick = Some(tick);
            nav.stop(walker.agent);
        }
    }
}

/// Send villager `index` to a spot in a simulated cell (or stop it when there is none).
fn send_villager(sim: &mut Sim<World>, index: usize) {
    let here = sim.world.villagers[index].character.feet();
    let open: Vec<Vec3> = VILLAGE_SPOTS.into_iter().filter(|spot| sim.stream.is_active(cell_of(*spot)) && spot.distance(here) > 2.0 * VILLAGER_REACH).collect();
    let agent = sim.world.villagers[index].agent;
    if open.is_empty() {
        sim.nav.stop(agent);
        return;
    }
    let rng = sim.world.rng.as_mut().expect("seeded at reset");
    let spot = open[rng.below(open.len() as u32) as usize];
    sim.nav.move_to(agent, spot);
}

/// One villager's tick: frozen while its cell is not simulated, else the documented loop with a
/// velocity move.
fn step_villager(sim: &mut Sim<World>, index: usize, dt: f32) {
    let agent = sim.world.villagers[index].agent;
    let feet = sim.world.villagers[index].character.feet();
    if !sim.stream.is_active(cell_of(feet)) {
        freeze_villager(sim, index);
        return;
    }
    if sim.world.villagers[index].frozen.take().is_some() {
        sim.world.villagers[index].resumes += 1;
    }
    match sim.nav.status(agent) {
        Some(NavStatus::Arrived) => {
            let villager = &mut sim.world.villagers[index];
            villager.arrivals += 1;
            if villager.resumes > 0 {
                villager.arrivals_after_resume += 1;
            }
            send_villager(sim, index);
        }
        Some(NavStatus::NoPath | NavStatus::TargetOffMesh | NavStatus::Idle) => send_villager(sim, index),
        _ => {}
    }
    let wish = sim.nav.desired_velocity(agent);
    let villager = &mut sim.world.villagers[index];
    villager.character.drive(&mut sim.physics, CharacterMotion::Velocity { wish, jump: false }, dt);
    sim.nav.set_position(agent, villager.character.feet(), villager.character.velocity());
}

/// A villager whose cell streamed out: its agent is off the mesh and stands still, and its capsule
/// is not driven. The first frozen tick records where both stood; every later one checks neither
/// moved and the agent is still off the mesh.
fn freeze_villager(sim: &mut Sim<World>, index: usize) {
    let agent = sim.world.villagers[index].agent;
    let at = sim.nav.position(agent).unwrap_or(Vec3::NAN);
    let off_mesh = sim.nav.status(agent) == Some(NavStatus::OffMesh) && sim.nav.desired_velocity(agent) == Vec3::ZERO;
    let villager = &mut sim.world.villagers[index];
    let feet = villager.character.feet();
    villager.frozen_ticks += 1;
    let moved = match villager.frozen {
        None => {
            villager.freezes += 1;
            villager.frozen = Some((at, feet));
            false
        }
        Some((was_at, was_feet)) => was_at != at || was_feet != feet,
    };
    if moved || !off_mesh {
        sim.world.freeze_breaks += 1;
    }
}

// ---------------------------------------------------------------------------------------------
// Drawing.

fn draw(sim: &Sim<World>, frame: &mut Frame, _: &Camera) {
    let world = &sim.world;
    frame.clear(SKY).ambient(Color::rgb(170, 190, 220), 0.3).sun(SUN_TOWARDS, Color::WHITE, 3.0);
    frame.environment(genex::render::Environment::sky());
    // The land past the simulated cells: one flat backdrop just under the cells' slabs (display
    // only, no collider), so the view never looks past the world's edge into the lower sky.
    frame.tag("backdrop").cube_with(Transform::from_xyz(0.5 * CELL * WORLD_CELLS[0] as f32, -1.05, 0.5 * CELL * WORLD_CELLS[1] as f32).with_scale(vec3(BACKDROP, 2.0, BACKDROP)), &Material::color(FAR_LAND).with_roughness(1.0));
    frame.tag("ground");
    for cell in sim.stream.active().filter(|cell| in_world(*cell)) {
        let center = cell_min(cell) + Vec2::splat(0.5 * CELL);
        let grass = Material::color(GRASS[((cell.x + cell.z) & 1) as usize]).with_roughness(0.95);
        frame.cube_with(Transform::from_xyz(center.x, -0.5, center.y).with_scale(vec3(CELL, 1.0, CELL)), &grass);
    }
    frame.tag("rocks");
    let stone = Material::color(ROCK).with_roughness(0.9);
    for (_, rock) in &world.rocks {
        frame.cube_with(Transform::from_translation(rock.center).with_rotation(Quat::from_rotation_y(rock.yaw)).with_scale(rock.half * 2.0), &stone);
    }
    frame.tag("nav").nav_debug(&sim.nav, NavDebug::borders());
    frame.tag("villagers");
    for villager in &world.villagers {
        let color = if villager.frozen.is_some() { FROZEN } else { VILLAGER };
        let body = Transform::from_translation(villager.character.feet() + Vec3::Y * 0.9).with_rotation(villager.character.facing()).with_scale(vec3(0.6, 1.8, 0.45));
        frame.cube_with(body, &Material::color(color).with_roughness(0.6));
    }
    if let Some(walker) = &world.walker {
        frame.tag("walker").character(&walker.animator, walker.character.transform().into());
    }
}
