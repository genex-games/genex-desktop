//! The market, its crowd and the rules that move it.
//!
//! Layout (metres, the market centred on the origin, ground at y 0):
//! - a 128 m terrain, flat under the market and rising to low hills past 40 m; the walkable
//!   ground is a 72 m square of it;
//! - a 44 m square wall, 2.5 m high, with a 4 m gate in each side; the east gate is a door area
//!   that shuts every [`DOOR_PERIOD_TICKS`] (once nobody stands in it) and opens again a period on;
//! - 16 stalls on a 4 x 4 grid, the upper floor (an 8 m square block 3 m high) in the middle, a
//!   stair ramp down its east side, a ladder link on its west side (both ways) and a drop link off
//!   its south edge;
//! - targets either side of every stall, two on the upper floor and two outside the walls;
//! - the player: a capsule pushed round a loop between the stall rows, a nav body agents avoid;
//! - a crate carved into the mesh at [`CRATE_TICK`]; its collider goes in once no capsule stands
//!   where it lands.
//!
//! Every tick: the door and the crate, `sim.nav.update(dt)` once, the player, then each walker in
//! slice order: a link crossing is played (the capsule leaves the world and lands at the link's
//! end), an arrival picks the next target near the last, and otherwise the desired velocity drives
//! the capsule (`CharacterMotion::Velocity`) and `nav.set_position` reports where it went.
//!
//! Crowd rules: capsules are sensors (none blocks or stands on another; the nav's avoidance keeps
//! them apart), a walker heads for the least busy target near its last, walkers outside the shut
//! door wait for it, and every walker asks for its path again when the door opens.

use genex::nav::{AgentId, NavAgent, NavArea, NavBody, NavBodyId, NavConfig, NavDebug, NavInput, NavLink, NavLinkKind, NavMesh, NavObstacle, NavStatus};
use genex::physics::ColliderBuilder;
use genex::prelude::*;
use genex::glam::Vec3Swizzles;
use genex::math;
use genex::{Terrain, TerrainLayer, TerrainTexel};
use genex::{CharacterParams, FIXED_STEP_MS};

/// Agents in the crowd.
pub const AGENTS: usize = 200;
/// The tick the crate is carved in (or the first after it with nobody where it lands).
pub const CRATE_TICK: u64 = 600;
/// Ticks between the east gate's door shutting and opening.
pub const DOOR_PERIOD_TICKS: u64 = 600;
/// The stall rule (NAV-13's): this many ticks in a row of wanting to move and not moving (2 s).
pub const STALL_TICKS: u32 = 120;
/// The named eye that draws the nav debug overlay.
pub const CROWD_EYE: &str = "crowd";

/// Wanting to move: a desired speed above this, metres per second.
const STALL_DESIRED_SPEED: f32 = 0.5;
/// Not moving: a tick's move under this, metres.
const STALL_MOVE: f32 = 1.0e-3;
/// How far an off-mesh capsule looks for the mesh, metres, and how fast it walks back onto it.
const OFF_MESH_REACH: f32 = 1.5;
const OFF_MESH_SPEED: f32 = 1.0;
/// The agents' preferred and top speed, metres per second.
const AGENT_SPEED: (f32, f32) = (2.4, 3.2);
/// How close counts as arrived, metres.
const AGENT_REACH: f32 = 1.0;
/// The next target is one within this distance of the last, metres.
const NEXT_TARGET_RADIUS: f32 = 11.0;
/// A target lands up to this far from its spot along x and z, metres (along a stall's front).
const TARGET_JITTER: Vec2 = Vec2::new(1.4, 0.4);
/// Nav tiles, metres.
const TILE: f32 = 16.0;

/// Half the walkable ground's side and the terrain's.
const GROUND_HALF: f32 = 36.0;
const TERRAIN_SAMPLES: u32 = 129;
const TERRAIN_SPACING: f32 = 1.0;
/// The terrain is flat inside this half side and rises to [`HILL_HEIGHT`] at its edge.
const TERRAIN_FLAT_HALF: f32 = 40.0;
const HILL_HEIGHT: f32 = 5.0;
/// The market wall: half side, thickness, height, and the gates' half width.
const WALL_HALF: f32 = 22.0;
const WALL_THICK: f32 = 0.5;
const WALL_HEIGHT: f32 = 2.5;
const GATE_HALF: f32 = 2.0;
/// Stall rows and columns, a stall's half footprint and its counter's height.
const STALL_ROWS: [f32; 4] = [-15.0, -7.5, 7.5, 15.0];
const STALL_HALF: Vec2 = Vec2::new(1.5, 1.0);
const STALL_HEIGHT: f32 = 1.2;
/// A stall's target stands this far from its centre, on the side facing the corridor.
const STALL_FRONT: f32 = 2.2;
/// The upper floor: half side and height.
const UPPER_HALF: f32 = 4.0;
const UPPER_HEIGHT: f32 = 3.0;
/// The stair ramp runs from the upper floor's east edge down to this x, this wide (half), this thick.
const RAMP_FOOT_X: f32 = 9.0;
const RAMP_HALF_WIDTH: f32 = 1.2;
const RAMP_THICK: f32 = 0.4;
/// How far the ramp's slab runs on under the ground past its foot.
const RAMP_FOOT_RUN_ON: f32 = 0.8;
/// The ladder (west face) and the drop (south edge): their ground and top ends.
const LADDER: (Vec3, Vec3) = (Vec3::new(-4.8, 0.0, 0.0), Vec3::new(-3.4, UPPER_HEIGHT, 0.0));
const DROP: (Vec3, Vec3) = (Vec3::new(0.0, UPPER_HEIGHT, -3.4), Vec3::new(0.0, 0.0, -5.2));
/// Climbing a ladder, metres per second; a drop takes this many ticks.
const LADDER_SPEED: f32 = 1.2;
const DROP_TICKS: u32 = 30;
/// Targets on the upper floor and outside the walls (east through the door, west through a gate).
const UPPER_TARGETS: [Vec3; 2] = [Vec3::new(-2.0, UPPER_HEIGHT, 2.0), Vec3::new(2.0, UPPER_HEIGHT, -2.0)];
const OUTSIDE_TARGETS: [Vec3; 2] = [Vec3::new(24.5, 0.0, 0.0), Vec3::new(-24.5, 0.0, 0.0)];
/// The door area over the east gate.
const DOOR_MIN: Vec2 = Vec2::new(WALL_HALF - 1.0, -GATE_HALF);
const DOOR_MAX: Vec2 = Vec2::new(WALL_HALF + 1.0, GATE_HALF);
/// The player's loop (between the stall rows), speed, and its body's radius.
const PLAYER_LOOP: f32 = 11.25;
const PLAYER_SPEED: f32 = 2.2;
const PLAYER_RADIUS: f32 = 0.5;
/// The crate: centre and side.
const CRATE_AT: Vec3 = Vec3::new(0.0, 0.8, 7.5);
const CRATE_SIDE: f32 = 1.6;
/// Spawn points: a lattice this far apart, kept this far from anything solid.
const SPAWN_STEP: f32 = 1.5;
const SPAWN_CLEARANCE: f32 = 0.9;
/// A landing waits while another capsule stands this close to its spot (twice the radius, and a bit).
const LANDING_CLEARANCE: f32 = 0.8;

/// Look: sky colours, sun, materials.
const CLEAR: Color = Color::rgb(150, 180, 215);
const SUN_TOWARDS: Vec3 = vec3(-0.5, 0.62, -0.6);
const GRASS: Color = Color::rgb(92, 128, 70);
const STONE: Color = Color::rgb(150, 142, 128);
const WALL: Color = Color::rgb(176, 160, 136);
const COUNTER: Color = Color::rgb(120, 86, 56);
const AWNINGS: [Color; 4] = [Color::rgb(196, 64, 52), Color::rgb(222, 176, 64), Color::rgb(64, 120, 176), Color::rgb(92, 150, 96)];
const UPPER: Color = Color::rgb(160, 150, 138);
const DOOR: Color = Color::rgb(96, 64, 40);
const CRATE: Color = Color::rgb(170, 120, 60);
const PLAYER: Color = Color::rgb(255, 140, 20);
const AGENT_COLORS: [Color; 6] = [
    Color::rgb(70, 90, 160),
    Color::rgb(160, 70, 90),
    Color::rgb(70, 140, 120),
    Color::rgb(180, 160, 80),
    Color::rgb(120, 80, 160),
    Color::rgb(90, 90, 90),
];
const MARKER: Color = Color::rgb(255, 255, 255);
const HEADING: Color = Color::rgb(255, 210, 40);

/// A link crossing being played: the capsule is out of the world until it lands.
#[derive(Clone, Copy, Debug)]
struct Crossing {
    from: Vec3,
    to: Vec3,
    elapsed: u32,
    ticks: u32,
}

/// One walker: its nav agent and its capsule (none while crossing a link).
struct Walker {
    agent: AgentId,
    character: Option<Character>,
    crossing: Option<Crossing>,
    /// The target spot it walks to (an index into the market's targets).
    target: usize,
    arrivals: u32,
    links_taken: u32,
    /// Outside the shut east door, waiting for it to open.
    waiting_at_door: bool,
    /// Ticks in a row it wanted to move and did not, and the longest such run.
    stalled: u32,
    longest_stall: u32,
}

/// The player: a capsule pushed round the loop and the nav body agents steer around.
struct Player {
    character: Character,
    body: NavBodyId,
    corner: usize,
}

/// Everything the simulation owns.
#[derive(Default)]
pub struct World {
    walkers: Vec<Walker>,
    player: Option<Player>,
    targets: Vec<Vec3>,
    rng: Option<Pcg32>,
    tick: u64,
    door_open: bool,
    /// The tick the crate went in, the first tick after it with no rebuild pending, and the
    /// most rebuilds pending at once.
    crate_tick: Option<u64>,
    crate_solid_tick: Option<u64>,
    doors_shut: u32,
    settled_tick: Option<u64>,
    pending_peak: usize,
    /// Agents whose next corner lay inside the crate the tick after the mesh settled.
    corners_in_crate: Option<u32>,
    terrain: Option<Terrain>,
}

/// What the probes and the checks read: totals over the crowd.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CrowdTotals {
    /// The fewest arrivals any agent made.
    pub arrivals_min: u32,
    /// Every agent's arrivals.
    pub arrivals_total: u32,
    /// Agents whose longest stall reached [`STALL_TICKS`].
    pub stuck: u32,
    /// The longest stall of any agent, ticks.
    pub longest_stall: u32,
    /// Link crossings played.
    pub links_taken: u32,
    /// The tick the crate went in.
    pub crate_tick: Option<u64>,
    /// The tick the crate's collider went in (once its spot was clear).
    pub crate_solid_tick: Option<u64>,
    /// The first tick after the crate with no rebuild pending.
    pub settled_tick: Option<u64>,
    /// The most rebuilds pending at once after the crate.
    pub pending_peak: usize,
    /// Agents whose next corner lay inside the crate the tick after the nav settled.
    pub corners_in_crate: Option<u32>,
    /// Whether the east gate's door is open.
    pub door_open: bool,
    /// Times the door shut.
    pub doors_shut: u32,
}

impl World {
    /// The crowd's totals.
    pub fn totals(&self) -> CrowdTotals {
        let walkers = &self.walkers;
        CrowdTotals {
            arrivals_min: walkers.iter().map(|w| w.arrivals).min().unwrap_or(0),
            arrivals_total: walkers.iter().map(|w| w.arrivals).sum(),
            stuck: walkers.iter().filter(|w| w.longest_stall >= STALL_TICKS).count() as u32,
            longest_stall: walkers.iter().map(|w| w.longest_stall).max().unwrap_or(0),
            links_taken: walkers.iter().map(|w| w.links_taken).sum(),
            crate_tick: self.crate_tick,
            crate_solid_tick: self.crate_solid_tick,
            settled_tick: self.settled_tick,
            pending_peak: self.pending_peak,
            corners_in_crate: self.corners_in_crate,
            door_open: self.door_open,
            doors_shut: self.doors_shut,
        }
    }

    /// Each agent's arrivals and links taken, in slice order, with its nav agent.
    pub fn walkers(&self) -> Vec<(AgentId, u32, u32)> {
        self.walkers.iter().map(|w| (w.agent, w.arrivals, w.links_taken)).collect()
    }

    /// FNV-1a 64 of every capsule's digest in slice order (a crossing walker hashes its crossing).
    pub fn characters_digest(&self) -> u64 {
        let mut hash = FNV_OFFSET;
        for walker in &self.walkers {
            let part = match (&walker.character, &walker.crossing) {
                (Some(character), _) => character.digest(),
                (None, Some(crossing)) => u64::from(crossing.elapsed) ^ u64::from(crossing.to.x.to_bits()) << 32,
                (None, None) => 0,
            };
            hash = fnv_u64(hash, part);
        }
        if let Some(player) = &self.player {
            hash = fnv_u64(hash, player.character.digest());
        }
        hash
    }
}

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

fn fnv_u64(hash: u64, value: u64) -> u64 {
    value.to_le_bytes().iter().fold(hash, |hash, byte| (hash ^ u64::from(*byte)).wrapping_mul(FNV_PRIME))
}

/// The capsule every agent and the player use.
fn params() -> CharacterParams {
    CharacterParams::default()
}

/// A capsule standing at `feet`. Crowd capsules are sensors: no capsule blocks (or stands on)
/// another, so a jam at a stall cannot stack them; the nav's avoidance keeps them apart (red
/// without it: capsules climbed each other's heads at the stall fronts, 102 agents off the mesh
/// at tick 3,600, `nav17-crowd-3.log` in the I3 lane evidence).
fn spawn_capsule(physics: &mut PhysicsWorld, feet: Vec3) -> Character {
    let character = Character::spawn(physics, feet, params()).expect("a capsule");
    if let Some(collider) = character.collider().and_then(|handle| physics.colliders.get_mut(handle)) {
        collider.set_sensor(true);
    }
    character
}

/// The walker the bake uses: the capsule's own (`character.nav_config()`), 16 m tiles.
fn nav_config() -> NavConfig {
    let probe = Character::on_ground(Vec3::ZERO, params()).expect("default parameters");
    probe.nav_config().with_tile(TILE)
}

/// Register every hook.
pub(crate) fn wire(game: &mut Game<World>) {
    game.navigation(nav_config());
    game.on_reset(|sim, seed, _, _| reset(sim, u64::from(seed)));
    game.on_update(update);
    game.on_draw(draw);
    game.camera(|_| Camera::look_at(vec3(0.0, 36.0, 44.0), vec3(0.0, 0.0, 2.0)));
    game.eye(CROWD_EYE, |_| overlay_camera());
    game.probe("crowd", |sim| {
        let totals = sim.world.totals();
        json!({
            "arrivalsMin": totals.arrivals_min,
            "arrivals": totals.arrivals_total,
            "stuck": totals.stuck,
            "longestStall": totals.longest_stall,
            "links": totals.links_taken,
            "crateTick": totals.crate_tick,
            "crateSolidTick": totals.crate_solid_tick,
            "settledTick": totals.settled_tick,
            "pending": sim.nav.pending_rebuilds(),
            "doorOpen": totals.door_open,
            "doorsShut": totals.doors_shut,
            "characters": format!("{:016x}", sim.world.characters_digest()),
        })
    });
    game.probe("nav", |sim| Value::from(&sim.nav.probe()));
}

/// The `crowd` eye: high over the market's north-east corner, looking at the upper floor.
pub fn overlay_camera() -> Camera {
    Camera::look_at(vec3(18.0, 30.0, 26.0), vec3(0.0, 0.0, 0.0))
}

// ---------------------------------------------------------------------------------------------
// The level.

fn cuboid(physics: &mut PhysicsWorld, center: Vec3, half: Vec3) {
    physics.insert_collider(ColliderBuilder::cuboid(half.x, half.y, half.z).translation(center), None);
}

/// The wall pieces: centre and half extents (two per side, either side of its gate).
fn wall_pieces() -> Vec<(Vec3, Vec3)> {
    let run = 0.5 * (WALL_HALF - GATE_HALF);
    let mid = GATE_HALF + run;
    let y = 0.5 * WALL_HEIGHT;
    let mut pieces = Vec::new();
    for side in [-1.0, 1.0] {
        for along in [-1.0, 1.0] {
            pieces.push((vec3(along * mid, y, side * WALL_HALF), vec3(run + WALL_THICK * 0.5, y, WALL_THICK * 0.5)));
            pieces.push((vec3(side * WALL_HALF, y, along * mid), vec3(WALL_THICK * 0.5, y, run + WALL_THICK * 0.5)));
        }
    }
    pieces
}

/// Every stall's centre on the ground, row by row.
fn stalls() -> Vec<Vec3> {
    STALL_ROWS.iter().flat_map(|z| STALL_ROWS.iter().map(move |x| vec3(*x, 0.0, *z))).collect()
}

/// The ramp slab: centre, half extents and its turn about z (radians).
fn ramp() -> (Vec3, Vec3, f32) {
    let run = RAMP_FOOT_X - UPPER_HALF;
    let length = math::hypot(run, UPPER_HEIGHT);
    let angle = math::atan2(UPPER_HEIGHT, run);
    let top_mid = vec3(UPPER_HALF + 0.5 * run, 0.5 * UPPER_HEIGHT, 0.0);
    let normal = vec3(UPPER_HEIGHT, run, 0.0) / length;
    // Longer than the slope at its foot only, so it runs on into the ground; its top edge meets
    // the upper floor's edge (red: a top end run on into the floor stood 0.2 m proud of it).
    let down_slope = vec3(run, -UPPER_HEIGHT, 0.0) / length;
    let center = top_mid - normal * (0.5 * RAMP_THICK) + down_slope * (0.5 * RAMP_FOOT_RUN_ON);
    (center, vec3(0.5 * (length + RAMP_FOOT_RUN_ON), 0.5 * RAMP_THICK, RAMP_HALF_WIDTH), -angle)
}

fn build_level(physics: &mut PhysicsWorld) {
    cuboid(physics, vec3(0.0, -0.5, 0.0), vec3(GROUND_HALF, 0.5, GROUND_HALF));
    for (center, half) in wall_pieces() {
        cuboid(physics, center, half);
    }
    for stall in stalls() {
        cuboid(physics, stall + Vec3::Y * (0.5 * STALL_HEIGHT), vec3(STALL_HALF.x, 0.5 * STALL_HEIGHT, STALL_HALF.y));
    }
    cuboid(physics, vec3(0.0, 0.5 * UPPER_HEIGHT, 0.0), vec3(UPPER_HALF, 0.5 * UPPER_HEIGHT, UPPER_HALF));
    let (center, half, turn) = ramp();
    physics.insert_collider(ColliderBuilder::cuboid(half.x, half.y, half.z).translation(center).rotation(vec3(0.0, 0.0, turn)), None);
}

/// The targets: either side of every stall, the upper floor and outside the walls.
fn targets() -> Vec<Vec3> {
    let mut out: Vec<Vec3> = stalls()
        .into_iter()
        .flat_map(|stall| [stall + Vec3::Z * STALL_FRONT, stall - Vec3::Z * STALL_FRONT])
        .collect();
    out.extend(UPPER_TARGETS);
    out.extend(OUTSIDE_TARGETS);
    out
}

/// Whether a point on the ground is clear of every solid by `margin`.
fn clear_of_solids(at: Vec2, margin: f32) -> bool {
    let inside = |center: Vec2, half: Vec2| (at - center).abs().cmple(half + Vec2::splat(margin)).all();
    let walls = wall_pieces().into_iter().any(|(c, h)| inside(c.xz(), h.xz()));
    let stalls = stalls().into_iter().any(|s| inside(s.xz(), STALL_HALF));
    let upper = inside(Vec2::ZERO, Vec2::splat(UPPER_HALF));
    let ramp = inside(vec2(0.5 * (UPPER_HALF + RAMP_FOOT_X), 0.0), vec2(0.5 * (RAMP_FOOT_X - UPPER_HALF), RAMP_HALF_WIDTH));
    !(walls || stalls || upper || ramp)
}

/// [`AGENTS`] spawn points spread over the market floor, clear of solids and of each other.
fn spawn_points() -> Vec<Vec3> {
    let steps = ((2.0 * (WALL_HALF - 1.0)) / SPAWN_STEP) as i32;
    let start = -(WALL_HALF - 1.0);
    let lattice: Vec<Vec3> = (0..=steps)
        .flat_map(|row| (0..=steps).map(move |column| vec3(start + column as f32 * SPAWN_STEP, 0.0, start + row as f32 * SPAWN_STEP)))
        .filter(|at| clear_of_solids(at.xz(), SPAWN_CLEARANCE) && clear_of_player_loop(at.xz()))
        .collect();
    (0..AGENTS).map(|index| lattice[index * lattice.len() / AGENTS]).collect()
}

/// Keep spawns off the player's loop, so the player starts in a clear lane.
fn clear_of_player_loop(at: Vec2) -> bool {
    let on = |value: f32| (value.abs() - PLAYER_LOOP).abs() < 0.9;
    !((on(at.x) && at.y.abs() <= PLAYER_LOOP + 0.9) || (on(at.y) && at.x.abs() <= PLAYER_LOOP + 0.9))
}

fn terrain() -> Terrain {
    let origin = Vec2::splat(-0.5 * (TERRAIN_SAMPLES - 1) as f32 * TERRAIN_SPACING);
    let height = |x: f32, z: f32| {
        let out = (x.abs().max(z.abs()) - TERRAIN_FLAT_HALF).max(0.0) / (origin.x.abs() - TERRAIN_FLAT_HALF);
        HILL_HEIGHT * out * out * (0.75 + 0.25 * math::sin(0.21 * x) * math::cos(0.17 * z))
    };
    let terrain = Terrain::from_fn([TERRAIN_SAMPLES; 2], origin, TERRAIN_SPACING, height).expect("the terrain");
    let control: Vec<TerrainTexel> = (0..TERRAIN_SAMPLES)
        .flat_map(|row| (0..TERRAIN_SAMPLES).map(move |column| (row, column)))
        .map(|(row, column)| {
            let at = origin + vec2(column as f32, row as f32) * TERRAIN_SPACING;
            TerrainTexel::layer(u8::from(at.x.abs().max(at.y.abs()) <= WALL_HALF + 0.5))
        })
        .collect();
    let layers = vec![TerrainLayer::flat(GRASS).with_roughness(0.95), TerrainLayer::flat(STONE).with_roughness(0.85)];
    terrain.with_layers(layers).and_then(|t| t.with_control(&control)).expect("the terrain's layers")
}

fn reset(sim: &mut Sim<World>, seed: u64) {
    build_level(&mut sim.physics);
    let config = nav_config();
    let door: Vec<Vec2> = vec![DOOR_MIN, vec2(DOOR_MAX.x, DOOR_MIN.y), DOOR_MAX, vec2(DOOR_MIN.x, DOOR_MAX.y)];
    let input = NavInput::new()
        .with_static_colliders(&sim.physics, NavArea::WALK)
        .and_then(|input| input.with_area_volume(&door, -1.0, WALL_HEIGHT, NavArea::DOOR))
        .expect("the market");
    sim.nav.add_mesh(&NavMesh::bake(&input, &config).expect("the mesh")).expect("the tiles");
    // Islands stitch on an update; queries, links and agents read stitched islands. The links'
    // ends sit on the polygons, which stand up to a cell or so above the ground they were cut from.
    sim.nav.update(FIXED_STEP_MS as f32 / 1000.0);
    let on_mesh = |nav: &genex::nav::Nav, at: Vec3| nav.closest_point(at, 1.0).map_or(at, |point| point.position);
    let (ladder, drop) = ((on_mesh(&sim.nav, LADDER.0), on_mesh(&sim.nav, LADDER.1)), (on_mesh(&sim.nav, DROP.0), on_mesh(&sim.nav, DROP.1)));
    sim.nav.add_link(NavLink::between(ladder.0, ladder.1, NavLinkKind::Ladder).both_ways()).expect("the ladder");
    sim.nav.add_link(NavLink::between(drop.0, drop.1, NavLinkKind::Drop)).expect("the drop");
    sim.nav.update(FIXED_STEP_MS as f32 / 1000.0);
    let world = &mut sim.world;
    *world = World { targets: targets(), rng: Some(Pcg32::seeded(seed)), door_open: true, terrain: Some(terrain()), ..World::default() };
    for at in spawn_points() {
        let agent = sim.nav.add_agent(NavAgent::new(at).with_speed(AGENT_SPEED.0, AGENT_SPEED.1).with_reach(AGENT_REACH)).expect("an agent");
        let character = spawn_capsule(&mut sim.physics, at);
        sim.world.walkers.push(Walker { agent, character: Some(character), crossing: None, target: 0, arrivals: 0, links_taken: 0, waiting_at_door: false, stalled: 0, longest_stall: 0 });
    }
    for index in 0..sim.world.walkers.len() {
        let here = sim.world.walkers[index].character.as_ref().map_or(Vec3::ZERO, Character::feet);
        let nearest = nearest_target(&sim.world.targets, here);
        send_on(sim, index, nearest);
    }
    let start = vec3(PLAYER_LOOP, 0.0, -PLAYER_LOOP);
    let character = spawn_capsule(&mut sim.physics, start);
    let body = sim.nav.add_body(NavBody { position: start, velocity: Vec3::ZERO, radius: PLAYER_RADIUS }).expect("the player's body");
    sim.world.player = Some(Player { character, body, corner: 0 });
}

fn nearest_target(targets: &[Vec3], here: Vec3) -> usize {
    let mut best = 0;
    for (index, target) in targets.iter().enumerate() {
        if target.distance_squared(here) < targets[best].distance_squared(here) {
            best = index;
        }
    }
    best
}

/// Send walker `index` to a spot near target `near` (another target within reach of it).
fn send_on(sim: &mut Sim<World>, index: usize, near: usize) {
    let world = &mut sim.world;
    let from = world.targets[near];
    // Nobody heads for the spot behind the east gate while its door is shut.
    let behind = behind_door(world);
    let open = |target: usize| world.door_open || target != behind;
    let near_enough: Vec<usize> =
        (0..world.targets.len()).filter(|t| *t != near && open(*t) && world.targets[*t].distance(from) <= NEXT_TARGET_RADIUS).collect();
    // The least busy of them (the fewest walkers headed there), so a crowd spreads over the stalls
    // instead of jamming one (red without it: 6 agents arrived under 5 times, jammed at one stall).
    let busy = |target: usize| world.walkers.iter().filter(|w| w.target == target).count();
    let least = near_enough.iter().map(|t| busy(*t)).min().unwrap_or(0);
    let choices: Vec<usize> = near_enough.into_iter().filter(|t| busy(*t) == least).collect();
    let rng = world.rng.as_mut().expect("seeded at reset");
    let target = choices[rng.below(choices.len() as u32) as usize];
    let jitter = vec3(rng.range_f32(-TARGET_JITTER.x, TARGET_JITTER.x), 0.0, rng.range_f32(-TARGET_JITTER.y, TARGET_JITTER.y));
    world.walkers[index].target = target;
    let agent = world.walkers[index].agent;
    sim.nav.move_to(agent, world.targets[target] + jitter);
}

// ---------------------------------------------------------------------------------------------
// The tick.

/// The documented loop, once per tick, with the door, the crate and the player around it.
fn update(sim: &mut Sim<World>, ctx: &Ctx) {
    sim.world.tick += 1;
    update_door(sim);
    place_crate(sim);
    // 1. Nav first, once.
    sim.nav.update(ctx.dt);
    note_rebuilds(sim);
    drive_player(sim, ctx.dt);
    for index in 0..sim.world.walkers.len() {
        step_walker(sim, index, ctx.dt);
    }
}

/// Feet of every capsule in the world (crossing walkers have none).
fn feet(world: &World) -> impl Iterator<Item = Vec3> + '_ {
    let walkers = world.walkers.iter().filter_map(|w| w.character.as_ref().map(Character::feet));
    walkers.chain(world.player.iter().map(|p| p.character.feet()))
}

/// The east gate shuts each period once nobody stands in it, and opens on the next period.
fn update_door(sim: &mut Sim<World>) {
    let shut_period = (sim.world.tick / DOOR_PERIOD_TICKS) % 2 == 1;
    if !shut_period {
        if !sim.world.door_open {
            sim.nav.set_area_open(NavArea::DOOR, true);
            sim.world.door_open = true;
            door_opened(sim);
        }
        return;
    }
    let margin = Vec2::splat(params().radius);
    let occupied = feet(&sim.world).any(|at| at.xz().cmpge(DOOR_MIN - margin).all() && at.xz().cmple(DOOR_MAX + margin).all());
    if sim.world.door_open && !occupied {
        sim.nav.set_area_open(NavArea::DOOR, false);
        sim.world.door_open = false;
        door_shut(sim);
    }
}

/// The door shut: walkers outside it wait there for it to open, and walkers inside headed out
/// through it pick a stall near it instead (red without it: an agent caught outside walked a
/// 46 m detour round the walls, 3 arrivals in a minute).
fn door_shut(sim: &mut Sim<World>) {
    sim.world.doors_shut += 1;
    let behind = behind_door(&sim.world);
    for index in 0..sim.world.walkers.len() {
        let walker = &sim.world.walkers[index];
        let Some(at) = walker.character.as_ref().map(Character::feet) else { continue };
        if walker.target != behind {
            continue;
        }
        if at.x > WALL_HALF {
            sim.nav.stop(walker.agent);
            sim.world.walkers[index].waiting_at_door = true;
        } else {
            send_on(sim, index, behind);
        }
    }
}

/// The door opened: the waiting walkers go on, and every other walker asks for its path again (a
/// path found while the door was shut keeps its detour round the market).
fn door_opened(sim: &mut Sim<World>) {
    let behind = behind_door(&sim.world);
    for index in 0..sim.world.walkers.len() {
        if std::mem::take(&mut sim.world.walkers[index].waiting_at_door) {
            send_on(sim, index, behind);
        }
    }
    replan_walkers(sim);
}

/// The target spot behind the east gate's door.
fn behind_door(world: &World) -> usize {
    world.targets.len() - OUTSIDE_TARGETS.len()
}

/// Ask again for every walking agent's path.
fn replan_walkers(sim: &mut Sim<World>) {
    for walker in sim.world.walkers.iter().filter(|w| w.crossing.is_none()) {
        if let Some(target) = sim.nav.target(walker.agent) {
            sim.nav.move_to(walker.agent, target);
        }
    }
}

/// From [`CRATE_TICK`], once no capsule stands where it lands: a collider and a carved box.
fn place_crate(sim: &mut Sim<World>) {
    if sim.world.tick == CRATE_TICK {
        let transform = Mat4::from_scale_rotation_translation(Vec3::splat(CRATE_SIDE), Quat::IDENTITY, CRATE_AT);
        sim.nav.add_obstacle(NavObstacle::CarveBox { transform }).expect("the crate");
        sim.world.crate_tick = Some(sim.world.tick);
    }
    if sim.world.crate_tick.is_none() || sim.world.crate_solid_tick.is_some() {
        return;
    }
    // The collider waits until no capsule stands where it lands (the carve sends agents round it).
    let reach = 0.5 * CRATE_SIDE + params().radius + 0.1;
    if feet(&sim.world).any(|at| (at.xz() - CRATE_AT.xz()).abs().max_element() < reach) {
        return;
    }
    cuboid(&mut sim.physics, CRATE_AT, Vec3::splat(0.5 * CRATE_SIDE));
    sim.world.crate_solid_tick = Some(sim.world.tick);
}

/// Track the crate's rebuild: the peak pending, the first tick with none, and the tick after it.
fn note_rebuilds(sim: &mut Sim<World>) {
    let Some(_) = sim.world.crate_tick else { return };
    let pending = sim.nav.pending_rebuilds();
    sim.world.pending_peak = sim.world.pending_peak.max(pending);
    match sim.world.settled_tick {
        None if pending == 0 => sim.world.settled_tick = Some(sim.world.tick),
        Some(settled) if sim.world.tick == settled + 1 => {
            let half = 0.5 * CRATE_SIDE;
            let inside = |corner: Vec3| (corner.xz() - CRATE_AT.xz()).abs().max_element() < half;
            let count = sim.world.walkers.iter().filter(|w| sim.nav.next_corner(w.agent).is_some_and(inside)).count();
            sim.world.corners_in_crate = Some(count as u32);
        }
        _ => {}
    }
}

/// The player walks the loop's corners at its speed; agents see it as a nav body.
fn drive_player(sim: &mut Sim<World>, dt: f32) {
    let Some(player) = sim.world.player.as_mut() else { return };
    let corners = [vec3(PLAYER_LOOP, 0.0, PLAYER_LOOP), vec3(-PLAYER_LOOP, 0.0, PLAYER_LOOP), vec3(-PLAYER_LOOP, 0.0, -PLAYER_LOOP), vec3(PLAYER_LOOP, 0.0, -PLAYER_LOOP)];
    let to = corners[player.corner] - player.character.feet();
    if to.xz().length() < 0.5 {
        player.corner = (player.corner + 1) % corners.len();
    }
    let wish = vec3(to.x, 0.0, to.z).normalize_or_zero() * PLAYER_SPEED;
    player.character.drive(&mut sim.physics, CharacterMotion::Velocity { wish, jump: false }, dt);
    sim.nav.set_body(player.body, player.character.feet(), player.character.velocity());
}

/// One walker's tick: play a crossing, take a link, pick the next target, or drive the capsule.
fn step_walker(sim: &mut Sim<World>, index: usize, dt: f32) {
    if sim.world.walkers[index].crossing.is_some() {
        play_crossing(sim, index);
        return;
    }
    let agent = sim.world.walkers[index].agent;
    let waiting = sim.world.walkers[index].waiting_at_door;
    match sim.nav.status(agent).filter(|_| !waiting) {
        Some(NavStatus::AtLink) => {
            start_crossing(sim, index);
            return;
        }
        Some(NavStatus::Arrived) => {
            sim.world.walkers[index].arrivals += 1;
            let near = sim.world.walkers[index].target;
            send_on(sim, index, near);
        }
        Some(NavStatus::NoPath | NavStatus::TargetOffMesh | NavStatus::Idle) => {
            let near = sim.world.walkers[index].target;
            send_on(sim, index, near);
        }
        _ => {}
    }
    // 2. The desired velocity; 3. the character makes the move; 4. nav hears where it went.
    let wish = match sim.nav.status(agent) {
        _ if waiting => Vec3::ZERO,
        Some(NavStatus::OffMesh) => back_onto_mesh(sim, index),
        _ => sim.nav.desired_velocity(agent),
    };
    let walker = &mut sim.world.walkers[index];
    let Some(character) = walker.character.as_mut() else { return };
    let step = character.drive(&mut sim.physics, CharacterMotion::Velocity { wish, jump: false }, dt);
    sim.nav.set_position(agent, character.feet(), character.velocity());
    let moved = vec2(step.moved.x, step.moved.z).length();
    let off_mesh = sim.nav.status(agent) == Some(NavStatus::OffMesh);
    let stalled = off_mesh || (wish.length() > STALL_DESIRED_SPEED && moved < STALL_MOVE);
    walker.stalled = if stalled { walker.stalled + 1 } else { 0 };
    walker.longest_stall = walker.longest_stall.max(walker.stalled);
}

/// A capsule can stand a few centimetres past the mesh's edge (the bake erodes by whole cells
/// and simplifies its outline), where the nav calls its agent off the mesh and wants nothing: walk
/// it back onto the nearest polygon (red without it: agents pressed against a stall corner stayed
/// off the mesh for good, 5 of 200 by tick 3,600).
fn back_onto_mesh(sim: &Sim<World>, index: usize) -> Vec3 {
    let Some(feet) = sim.world.walkers[index].character.as_ref().map(Character::feet) else { return Vec3::ZERO };
    let Some(point) = sim.nav.closest_point(feet, OFF_MESH_REACH) else { return Vec3::ZERO };
    let toward = vec3(point.position.x - feet.x, 0.0, point.position.z - feet.z);
    toward.normalize_or_zero() * OFF_MESH_SPEED
}

/// The walker reached a link: its capsule leaves the world and the crossing plays.
fn start_crossing(sim: &mut Sim<World>, index: usize) {
    let agent = sim.world.walkers[index].agent;
    let Some(reached) = sim.nav.take_link(agent) else { return };
    let ticks = match reached.kind {
        NavLinkKind::Ladder => ((reached.start.distance(reached.end) / LADDER_SPEED) * 1000.0 / FIXED_STEP_MS as f32).ceil() as u32,
        _ => DROP_TICKS,
    };
    let walker = &mut sim.world.walkers[index];
    if let Some(character) = walker.character.take() {
        character.remove(&mut sim.physics);
    }
    walker.crossing = Some(Crossing { from: reached.start, to: reached.end, elapsed: 0, ticks: ticks.max(1) });
    walker.links_taken += 1;
    walker.stalled = 0;
}

/// Advance a crossing; at its end the capsule lands (once the spot is clear) and the walk goes on.
fn play_crossing(sim: &mut Sim<World>, index: usize) {
    let Some(mut crossing) = sim.world.walkers[index].crossing else { return };
    crossing.elapsed = (crossing.elapsed + 1).min(crossing.ticks);
    sim.world.walkers[index].crossing = Some(crossing);
    if crossing.elapsed < crossing.ticks {
        return;
    }
    let landing_taken = feet(&sim.world).any(|at| at.distance(crossing.to) < LANDING_CLEARANCE);
    if landing_taken {
        return;
    }
    let character = spawn_capsule(&mut sim.physics, crossing.to);
    let agent = sim.world.walkers[index].agent;
    sim.nav.set_position(agent, crossing.to, Vec3::ZERO);
    sim.nav.finish_link(agent);
    let walker = &mut sim.world.walkers[index];
    walker.character = Some(character);
    walker.crossing = None;
}

// ---------------------------------------------------------------------------------------------
// Drawing.

fn draw(sim: &Sim<World>, frame: &mut Frame, camera: &Camera) {
    let world = &sim.world;
    frame.clear(CLEAR).ambient(Color::rgb(170, 190, 220), 0.25).sun(SUN_TOWARDS, Color::WHITE, 3.0);
    frame.environment(genex::render::Environment::sky());
    if let Some(terrain) = &world.terrain {
        frame.tag("terrain").terrain(terrain);
    }
    draw_market(world, frame);
    draw_crowd(world, frame);
    if *camera == overlay_camera() {
        frame.tag("nav-debug").nav_debug(&sim.nav, NavDebug::mesh().with_links());
        draw_agent_markers(sim, frame);
    }
}

fn draw_market(world: &World, frame: &mut Frame) {
    let box_at = |center: Vec3, half: Vec3| Transform::from_translation(center).with_scale(half * 2.0);
    frame.tag("walls");
    for (center, half) in wall_pieces() {
        frame.cube_with(box_at(center, half), &Material::color(WALL).with_roughness(0.9));
    }
    frame.tag("stalls");
    for (index, stall) in stalls().into_iter().enumerate() {
        let counter = Material::color(COUNTER).with_roughness(0.8);
        frame.cube_with(box_at(stall + Vec3::Y * (0.5 * STALL_HEIGHT), vec3(STALL_HALF.x, 0.5 * STALL_HEIGHT, STALL_HALF.y)), &counter);
        let awning = Material::color(AWNINGS[index % AWNINGS.len()]).with_roughness(0.7);
        frame.cube_with(box_at(stall + Vec3::Y * 2.4, vec3(STALL_HALF.x + 0.2, 0.06, STALL_HALF.y + 0.3)), &awning);
    }
    frame.tag("upper");
    let stone = Material::color(UPPER).with_roughness(0.85);
    frame.cube_with(box_at(vec3(0.0, 0.5 * UPPER_HEIGHT, 0.0), vec3(UPPER_HALF, 0.5 * UPPER_HEIGHT, UPPER_HALF)), &stone);
    let (center, half, turn) = ramp();
    frame.cube_with(box_at(center, half).with_rotation(Quat::from_rotation_z(turn)), &stone);
    let rail = LADDER.0.lerp(LADDER.1, 0.5);
    frame.cube_with(box_at(rail, vec3(0.05, 0.5 * UPPER_HEIGHT, 0.4)), &Material::color(DOOR));
    if !world.door_open {
        frame.tag("door").cube_with(box_at(vec3(WALL_HALF, 0.5 * WALL_HEIGHT, 0.0), vec3(0.1, 0.5 * WALL_HEIGHT, GATE_HALF)), &Material::color(DOOR).with_roughness(0.8));
    }
    if world.crate_tick.is_some() {
        frame.tag("crate").cube_with(box_at(CRATE_AT, Vec3::splat(0.5 * CRATE_SIDE)), &Material::color(CRATE).with_roughness(0.8));
    }
}

fn draw_crowd(world: &World, frame: &mut Frame) {
    let capsule = |feet: Vec3, facing: Quat| Transform::from_translation(feet + Vec3::Y * 0.9).with_rotation(facing).with_scale(vec3(0.7, 1.8, 0.5));
    frame.tag("crowd");
    for (index, walker) in world.walkers.iter().enumerate() {
        let material = Material::color(AGENT_COLORS[index % AGENT_COLORS.len()]).with_roughness(0.6);
        match (&walker.character, &walker.crossing) {
            (Some(character), _) => frame.cube_with(capsule(character.feet(), character.facing()), &material),
            (None, Some(crossing)) => {
                let at = crossing.from.lerp(crossing.to, crossing.elapsed as f32 / crossing.ticks as f32);
                frame.cube_with(capsule(at, Quat::IDENTITY), &material)
            }
            (None, None) => frame,
        };
    }
    if let Some(player) = &world.player {
        frame.tag("player").cube_with(capsule(player.character.feet(), player.character.facing()), &Material::color(PLAYER).with_roughness(0.5));
    }
}

/// The overlay's agent marks: a cross at each agent and its heading (the desired velocity).
fn draw_agent_markers(sim: &Sim<World>, frame: &mut Frame) {
    let mut crosses = Vec::new();
    let mut headings = Vec::new();
    for walker in &sim.world.walkers {
        let Some(at) = sim.nav.position(walker.agent) else { continue };
        let lift = at + Vec3::Y * 0.15;
        crosses.extend([lift - Vec3::X * 0.3, lift + Vec3::X * 0.3, lift - Vec3::Z * 0.3, lift + Vec3::Z * 0.3]);
        headings.extend([lift, lift + sim.nav.desired_velocity(walker.agent) * 0.5]);
    }
    frame.tag("nav-agents").lines(&crosses, MARKER);
    frame.lines(&headings, HEADING);
}
