//! The frontier's rules: the rider anchor, the town's 20 agents, the door and the probes.
//!
//! The anchor (the rider) waits in the town, rides east along the road to [`RIDE_FAR_X`] and back
//! over 120 s ([`RIDE_TICKS`]), and waits again; the camera follows it. The cells round it are
//! simulated (sim radius 1, hysteresis 1), so the town streams out while the rider is far and back
//! in when it returns.
//!
//! The 20 agents are mannequin `Character`s driven by nav through the documented loop:
//! `sim.nav.update(dt)` once; per agent the desired velocity into the animator's `speed`;
//! `animator.update(dt)`; `character.drive(.., CharacterMotion::Mixed { root, wish, .. })` (the
//! walk's and run's root motion moves the capsule, nav steers); then `nav.set_position`. Their graph
//! is a locomotion state machine (idle, walk, run on `speed`) with a `climb` state on `climbing`.
//! Agent 0 climbs: its path to the watchtower's top takes the ladder link, and between `take_link`
//! and `finish_link` it plays `Climb`. Agents 1..=3 run, the rest walk between the town's spots.
//!
//! An agent whose cell is not simulated is frozen: its agent is `off-mesh` with no desired
//! velocity, and neither its agent nor its capsule moves (owner call X1); it walks on when its cell
//! returns. The door swings open on its node clip while an agent is near it, and shut after.

use genex::animation::{BoolParam, FloatParam, LayerId, Motion, MotionSettings};
use genex::nav::{AgentId, Nav, NavAgent, NavDebug, NavIslands, NavLink, NavLinkId, NavLinkKind, NavStatus, StreamedNav};
use genex::prelude::*;
use genex::render::Environment;
use genex::{CellId, EnteredCell, FIXED_STEP_MS, NodeAnimator, StreamColliders, StreamCommit, Streaming};
use genex_core::digest::{fnv1a64_from, hex64};

use crate::mannequin::MANNEQUIN;
use crate::props::{DOOR, DOOR_CLOSE, DOOR_OPEN, PINE};
use crate::world::{self, CELL, IslandPart, KIND_HUT, KIND_STONE, KIND_TOWER, Patch, Spot, cell_of, params, patch, patch_block};

/// Agents in the town.
pub const AGENTS: usize = 20;
/// Agents 1..=RUNNERS run; agent 0 climbs; the rest walk.
const RUNNERS: usize = 3;
/// The observer camera that sits where the game camera does.
pub const OBSERVER: &str = "observer";
/// The anchor's name.
const ANCHOR: &str = "rider";
/// The ride: wait [`RIDE_WAIT`] ticks, ride out to [`RIDE_FAR_X`] over [`RIDE_LEG`] ticks, ride
/// back over as many, then wait. 120 s at the fixed step.
pub const RIDE_WAIT: u64 = 600;
/// Ticks of one leg of the ride.
pub const RIDE_LEG: u64 = 3000;
/// Ticks of the whole ride (120 s).
pub const RIDE_TICKS: u64 = 2 * RIDE_WAIT + 2 * RIDE_LEG;
/// How far east the rider goes, metres (the town's cells stream out past about 190 m).
pub const RIDE_FAR_X: f32 = 900.0;
/// The rider's height over the ground, metres.
const RIDE_HEIGHT: f32 = 2.0;
/// The camera's offset behind and above the rider, and how far ahead it looks, metres.
const CAMERA_BACK: f32 = 30.0;
const CAMERA_UP: f32 = 16.0;
const CAMERA_AHEAD: f32 = 60.0;
/// The sim radius, hysteresis and prefetch ring, in cells, and the view radius in metres.
const SIM_RADII: [u32; 3] = [1, 1, 1];
const VIEW_METRES: f32 = 768.0;

/// The watchtower's ladder: its ground and top ends (on the tower's south face), and the climb's
/// speed in metres a second.
const LADDER: (Vec3, Vec3) = (vec3(30.0, 0.0, 22.2), vec3(30.0, 3.0, 24.4));
const CLIMB_SPEED: f32 = 1.0;
/// The climber's two destinations: on the road side and on the tower's top.
const CLIMB_SPOTS: [Vec3; 2] = [vec3(30.0, 0.0, 12.0), vec3(30.0, 3.0, 27.5)];
/// Where the others wander, in the town's open ground.
const SPOTS: [Vec3; 12] = [
    vec3(-52.0, 0.0, -8.0),
    vec3(-26.0, 0.0, -10.0),
    vec3(0.0, 0.0, -8.0),
    vec3(26.0, 0.0, -10.0),
    vec3(50.0, 0.0, -8.0),
    vec3(-52.0, 0.0, 10.0),
    vec3(-26.0, 0.0, 10.0),
    vec3(-2.0, 0.0, 12.0),
    vec3(18.0, 0.0, 9.0),
    vec3(50.0, 0.0, 10.0),
    vec3(-26.0, 0.0, -42.0),
    vec3(-12.0, 0.0, 42.0),
];
/// Walkers' and runners' preferred and top speeds, and everyone's reach, metres (per second).
const WALK_SPEED: (f32, f32) = (1.4, 1.9);
const RUN_SPEED: (f32, f32) = (3.4, 4.2);
const CLIMBER_SPEED: (f32, f32) = (1.5, 2.0);
const REACH: f32 = 0.7;
/// How much of an agent's move its clip makes.
const ROOT_SHARE: f32 = 0.5;
/// The walk plays above this speed, the run above `RUN_ABOVE` and back to the walk below
/// `RUN_BELOW` (metres a second).
const WALK_ABOVE: f32 = 0.15;
const RUN_ABOVE: f32 = 2.8;
const RUN_BELOW: f32 = 2.4;
/// The door's hinge and the radius within which an agent opens it, metres.
const DOOR_AT: Vec3 = vec3(19.4, 0.0, -19.4);
const DOOR_NEAR: f32 = 5.0;

/// Look.
const SKY: Color = Color::rgb(150, 182, 216);
const SUN_TOWARDS: Vec3 = vec3(-0.5, 0.6, -0.6);
const WOOD: Color = Color::rgb(110, 76, 48);
const TINTS: [Color; 5] = [Color::rgb(230, 230, 230), Color::rgb(200, 120, 110), Color::rgb(120, 160, 200), Color::rgb(150, 190, 130), Color::rgb(210, 190, 120)];
const FROZEN: Color = Color::rgb(120, 170, 230);

/// What an agent does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Role {
    Climber,
    Runner,
    Walker,
}

/// A ladder crossing being played: the capsule is out of the world until it lands.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Crossing {
    from: Vec3,
    to: Vec3,
    elapsed: u32,
    ticks: u32,
}

/// One agent: its nav agent, capsule, animator and what the rows read.
struct Agent {
    role: Role,
    agent: AgentId,
    /// None while it crosses the ladder.
    character: Option<Character>,
    animator: Animator,
    /// Where it stands (the capsule's feet, or along the ladder) and which way it faces.
    at: Vec3,
    yaw: f32,
    crossing: Option<Crossing>,
    /// The spot it heads for (the climber: its index in [`CLIMB_SPOTS`]).
    spot: usize,
    /// Frozen now (its cell is not simulated), and where its agent and feet stood when it froze.
    frozen: Option<(Vec3, Vec3)>,
    arrivals: u32,
    arrivals_after_resume: u32,
    frozen_ticks: u32,
    freezes: u32,
    resumes: u32,
    /// Metres its clips moved it.
    rooted: f32,
}

/// The graph's parameters (one graph serves every agent).
#[derive(Clone, Copy)]
struct Params {
    speed: FloatParam,
    climbing: BoolParam,
    base: LayerId,
}

/// Everything the simulation owns.
#[derive(Default)]
pub struct World {
    /// Added to every agent's spot choice before a restore (the save row's other history).
    pub salt: u32,
    rng: Option<Pcg32>,
    tick: u64,
    /// The agents' animators, built at reset; agents spawn once the town's islands are in.
    pending: Option<(Vec<Animator>, Params)>,
    params: Option<Params>,
    agents: Vec<Agent>,
    ladder: Option<NavLinkId>,
    door: Option<NodeAnimator>,
    door_model: Option<Model>,
    /// The rider and the way it faces on the ground.
    at: Vec3,
    heading: Vec3,
    /// The drawn terrain patch.
    patch: Option<Patch>,
    /// Things entered by kind, and a digest over every entered thing in commit order.
    huts: u32,
    stones: u32,
    towers: u32,
    things_digest: u64,
    /// Frozen agent ticks whose agent was not `off-mesh`, or whose agent or capsule moved.
    freeze_breaks: u32,
    islands_entered: u32,
    islands_left: u32,
    /// The ladder rules: links taken and finished, crossing ticks, and of those the ticks the
    /// climber's graph was in `climb`; ticks outside a crossing it was (none, when the rule holds).
    taken: u32,
    finished: u32,
    crossing_ticks: u32,
    climbing_ticks: u32,
    climbing_outside: u32,
    /// Times the door opened.
    door_opens: u32,
}

/// What the probes and the rows read.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Totals {
    /// Agents spawned.
    pub agents: usize,
    /// Agent freezes (an agent's cell streamed out under it) and resumes (it came back).
    pub freezes: u32,
    /// See [`Totals::freezes`].
    pub resumes: u32,
    /// Agent ticks spent frozen.
    pub frozen_ticks: u32,
    /// Frozen agent ticks whose agent was not `off-mesh`, or whose agent or capsule moved.
    pub freeze_breaks: u32,
    /// Arrivals at spots, and of those, arrivals after the agent's first resume.
    pub arrivals: u32,
    /// See [`Totals::arrivals`].
    pub arrivals_after_resume: u32,
    /// Nav islands entered and left in the commit.
    pub islands_entered: u32,
    /// See [`Totals::islands_entered`].
    pub islands_left: u32,
    /// Ladder links taken and finished.
    pub taken: u32,
    /// See [`Totals::taken`].
    pub finished: u32,
    /// Ticks inside a crossing, and of those, ticks the climber's graph was in `climb`.
    pub crossing_ticks: u32,
    /// See [`Totals::crossing_ticks`].
    pub climbing_ticks: u32,
    /// Ticks outside every crossing on which the climber's graph was in `climb`.
    pub climbing_outside: u32,
    /// Metres every agent's clips moved it, together.
    pub rooted: f32,
    /// Times the door swung open.
    pub door_opens: u32,
    /// Huts, waystones and towers entered.
    pub huts: u32,
    /// See [`Totals::huts`].
    pub stones: u32,
    /// See [`Totals::huts`].
    pub towers: u32,
}

impl World {
    /// The scene's totals.
    pub fn totals(&self) -> Totals {
        let agents = &self.agents;
        Totals {
            agents: agents.len(),
            freezes: agents.iter().map(|a| a.freezes).sum(),
            resumes: agents.iter().map(|a| a.resumes).sum(),
            frozen_ticks: agents.iter().map(|a| a.frozen_ticks).sum(),
            freeze_breaks: self.freeze_breaks,
            arrivals: agents.iter().map(|a| a.arrivals).sum(),
            arrivals_after_resume: agents.iter().map(|a| a.arrivals_after_resume).sum(),
            islands_entered: self.islands_entered,
            islands_left: self.islands_left,
            taken: self.taken,
            finished: self.finished,
            crossing_ticks: self.crossing_ticks,
            climbing_ticks: self.climbing_ticks,
            climbing_outside: self.climbing_outside,
            rooted: agents.iter().map(|a| a.rooted).sum(),
            door_opens: self.door_opens,
            huts: self.huts,
            stones: self.stones,
            towers: self.towers,
        }
    }

    /// Where the rider is.
    pub fn rider(&self) -> Vec3 {
        self.at
    }

    /// A digest over every agent's feet, facing and animator state, in agent order.
    pub fn agents_digest(&self) -> u64 {
        self.agents.iter().fold(genex_core::digest::FNV_OFFSET_BASIS, |hash, a| {
            let bits = [a.at.x.to_bits(), a.at.y.to_bits(), a.at.z.to_bits(), a.yaw.to_bits()];
            let bytes: Vec<u8> = bits.iter().flat_map(|v| v.to_le_bytes()).chain(a.animator.digest().to_le_bytes()).collect();
            fnv1a64_from(&bytes, hash)
        })
    }
}

// ---------------------------------------------------------------------------------------------
// The ride.

/// Where the rider is on the ground at `tick` (x east along the road, z = 0).
pub fn ride_x(tick: u64) -> f32 {
    let leg = |t: u64| RIDE_FAR_X * t as f32 / RIDE_LEG as f32;
    match tick {
        t if t < RIDE_WAIT => 0.0,
        t if t < RIDE_WAIT + RIDE_LEG => leg(t - RIDE_WAIT),
        t if t < RIDE_WAIT + 2 * RIDE_LEG => RIDE_FAR_X - leg(t - RIDE_WAIT - RIDE_LEG),
        _ => 0.0,
    }
}

/// The rider at `tick`, on the ground plus its height.
pub fn rider_at(tick: u64) -> Vec3 {
    let x = ride_x(tick);
    vec3(x, world::height(x, 0.0) + RIDE_HEIGHT, 0.0)
}

fn follow(sim: &mut Sim<World>, tick: u64) {
    let at = rider_at(tick);
    // Riding back faces west; waiting and riding out face east.
    let back = (RIDE_WAIT + RIDE_LEG..RIDE_WAIT + 2 * RIDE_LEG).contains(&tick);
    sim.world.heading = if back { -Vec3::X } else { Vec3::X };
    sim.world.at = at;
    sim.stream.set_anchor(ANCHOR, at).expect("the road is inside the world");
    let block = patch_block(at);
    if sim.world.patch.as_ref().is_none_or(|drawn| drawn.block != block) {
        sim.world.patch = Some(patch(block, sim.world.patch.as_ref()));
    }
}

/// The game's own view (and the observer's): behind and above the rider, looking down the road.
pub fn camera(world: &World) -> Camera {
    let eye = world.at - world.heading * CAMERA_BACK + Vec3::Y * CAMERA_UP;
    Camera::look_at(eye, world.at + world.heading * CAMERA_AHEAD)
}

// ---------------------------------------------------------------------------------------------
// The commit: islands in and out.

/// The commit hook: a town cell's island goes into `sim.nav` as the cell enters and out as it
/// leaves.
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
pub(crate) fn wire(game: &mut Game<World>, salt: u32) {
    let tiles = world::tiles();
    let [radius, hysteresis, prefetch] = SIM_RADII;
    game.streaming(Streaming::grid(CELL).sim_radius(radius).hysteresis(hysteresis).prefetch(prefetch).view_radius(VIEW_METRES).terrain(tiles.clone()));
    game.navigation(world::nav_config());
    game.cell_content(world::cell_content(tiles.clone()));
    game.cell_content(tiles.colliders_content(CELL));
    game.stream_colliders();
    game.facet_state::<NavIslands>();
    game.stream_commit(IslandCommit);
    // The forest's pines are drawn by streaming, which never bakes mid-game: bake at build time.
    game.impostor_bake(|gfx| world::pine(gfx.assets().model(PINE)));
    game.on_reset(move |sim, seed, _, gfx| reset(sim, seed, salt, gfx));
    game.on_update(update);
    game.on_draw(draw);
    game.camera(|sim| camera(&sim.world));
    game.named_camera(OBSERVER, |sim| camera(&sim.world));
    game.probe("frontier", probe);
    game.probe("nav", |sim| Value::from(&sim.nav.probe()));
}

fn probe(sim: &Sim<World>) -> Value {
    let world = &sim.world;
    let t = world.totals();
    json!({
        "rider": [world.at.x, world.at.y, world.at.z],
        "agents": t.agents,
        "agentsDigest": hex64(world.agents_digest()),
        "frozen": world.agents.iter().filter(|a| a.frozen.is_some()).count(),
        "freezes": t.freezes,
        "resumes": t.resumes,
        "freezeBreaks": t.freeze_breaks,
        "arrivals": t.arrivals,
        "climbs": [t.taken, t.finished],
        "door": world.door.as_ref().map_or(Value::Null, |door| Value::from(door.probe().to_string())),
        "doorOpens": t.door_opens,
        "things": [t.huts, t.stones, t.towers, hex64(world.things_digest)],
        "colliders": sim.facets.get::<StreamColliders>().len(),
        "islands": hex64(sim.facets.get::<NavIslands>().digest(&sim.nav)),
        "active": sim.stream.active().count(),
    })
}

fn reset(sim: &mut Sim<World>, seed: u32, salt: u32, gfx: &Gfx) {
    sim.world = World { salt, rng: Some(Pcg32::seeded(u64::from(seed) ^ 0xf00d)), ..World::default() };
    follow(sim, 0);
    let asset = gfx.character(MANNEQUIN).expect("the mannequin animates");
    let moving = asset.with_root_motion(&MotionSettings::DEFAULT).expect("the mannequin's root");
    let (Some(idle), Some(walk), Some(run), Some(climb)) = (moving.clip("Idle"), moving.clip("Walk"), moving.clip("Run"), moving.clip("Climb")) else {
        panic!("the mannequin has Idle, Walk, Run and Climb")
    };
    let mut g = moving.graph();
    let speed = g.float("speed", 0.0);
    let climbing = g.bool("climbing", false);
    let base = g.layer("base");
    let idle = g.state(base, "idle", Motion::clip(idle));
    let walk = g.state(base, "walk", Motion::clip(walk));
    let run = g.state(base, "run", Motion::clip(run));
    let climb = g.state(base, "climb", Motion::clip(climb));
    g.transition(idle, walk).when(speed.above(WALK_ABOVE)).inertialize(0.15);
    g.transition(walk, idle).when(speed.below(WALK_ABOVE)).inertialize(0.2);
    g.transition(walk, run).when(speed.above(RUN_ABOVE)).inertialize(0.2);
    g.transition(run, walk).when(speed.below(RUN_BELOW)).inertialize(0.2);
    for from in [idle, walk, run] {
        g.transition(from, climb).when(climbing.is(true)).crossfade(0.15);
    }
    g.transition(climb, idle).when(climbing.is(false)).crossfade(0.2);
    let graph = g.build().expect("the agents' graph");
    let animators = (0..AGENTS).map(|_| moving.animator(&graph).expect("an agent's animator")).collect();
    sim.world.pending = Some((animators, Params { speed, climbing, base }));
    sim.world.door = Some(gfx.node_clips(DOOR).expect("the door's clips").animator());
    sim.world.door_model = Some(gfx.assets().model(DOOR));
}

// ---------------------------------------------------------------------------------------------
// The tick.

fn update(sim: &mut Sim<World>, ctx: &Ctx) {
    sim.world.tick += 1;
    count_entered(sim);
    // 1. Nav first, once.
    sim.nav.update(ctx.dt);
    if sim.world.agents.is_empty() {
        spawn(sim);
    }
    add_ladder(sim);
    for index in 0..sim.world.agents.len() {
        step_agent(sim, index, ctx.dt);
    }
    step_door(sim, ctx.dt);
    follow(sim, ctx.tick + 1);
}

fn count_entered(sim: &mut Sim<World>) {
    let mut digest = sim.world.things_digest;
    let entered: Vec<Spot> = sim.stream.entered().iter().flat_map(|cell| cell.things::<Spot>().copied().collect::<Vec<_>>()).collect();
    for spot in entered {
        match spot.kind {
            KIND_HUT => sim.world.huts += 1,
            KIND_STONE => sim.world.stones += 1,
            KIND_TOWER => sim.world.towers += 1,
            _ => {}
        }
        let bits = [spot.kind, spot.at.x.to_bits(), spot.at.y.to_bits(), spot.at.z.to_bits()];
        let bytes: Vec<u8> = bits.iter().flat_map(|v| v.to_le_bytes()).chain(spot.data.to_le_bytes()).collect();
        digest = fnv1a64_from(&bytes, digest);
    }
    sim.world.things_digest = digest;
}

fn town_in(sim: &Sim<World>) -> bool {
    world::TOWN_CELLS.iter().all(|cell| sim.stream.is_active(*cell))
}

fn on_mesh(nav: &Nav, at: Vec3) -> Vec3 {
    nav.closest_point(at, 1.5).map_or(at, |point| point.position)
}

/// Spawn the agents on the first tick the town's islands are in (they enter in that tick's commit
/// and stitch in the update before this).
fn spawn(sim: &mut Sim<World>) {
    if !town_in(sim) {
        return;
    }
    let Some((animators, params)) = sim.world.pending.take() else { return };
    sim.world.params = Some(params);
    for (index, animator) in animators.into_iter().enumerate() {
        let role = match index {
            0 => Role::Climber,
            i if i <= RUNNERS => Role::Runner,
            _ => Role::Walker,
        };
        let start = match role {
            Role::Climber => CLIMB_SPOTS[0],
            _ => vec3(-50.0 + (index % 10) as f32 * 11.0, 0.0, if index < 10 { -4.0 } else { 4.0 }),
        };
        let start = on_mesh(&sim.nav, start);
        let speed = match role {
            Role::Climber => CLIMBER_SPEED,
            Role::Runner => RUN_SPEED,
            Role::Walker => WALK_SPEED,
        };
        let agent = sim.nav.add_agent(NavAgent::new(start).with_speed(speed.0, speed.1).with_reach(REACH)).expect("an agent");
        let character = Character::spawn(&mut sim.physics, start, world::params()).expect("an agent's capsule");
        // Agents are sensors: nobody is stood on or pushed by them; the nav's avoidance keeps them
        // apart.
        if let Some(collider) = character.collider().and_then(|handle| sim.physics.colliders.get_mut(handle)) {
            collider.set_sensor(true);
        }
        sim.world.agents.push(Agent {
            role,
            agent,
            character: Some(character),
            animator,
            at: start,
            yaw: 0.0,
            crossing: None,
            spot: 0,
            frozen: None,
            arrivals: 0,
            arrivals_after_resume: 0,
            frozen_ticks: 0,
            freezes: 0,
            resumes: 0,
            rooted: 0.0,
        });
    }
    for index in 0..sim.world.agents.len() {
        send(sim, index);
    }
}

/// The ladder joins the tower's foot and top once the tower's island is in (a link needs a mesh at
/// both ends); it stays in the nav after.
fn add_ladder(sim: &mut Sim<World>) {
    if sim.world.ladder.is_some() || !sim.stream.is_active(cell_of(LADDER.0)) || sim.nav.tiles().next().is_none() {
        return;
    }
    let ends = (on_mesh(&sim.nav, LADDER.0), on_mesh(&sim.nav, LADDER.1));
    sim.world.ladder = sim.nav.add_link(NavLink::between(ends.0, ends.1, NavLinkKind::Ladder).both_ways()).ok();
}

/// Send agent `index` on: the climber to its other spot, the others to a random town spot.
fn send(sim: &mut Sim<World>, index: usize) {
    let agent = &mut sim.world.agents[index];
    if agent.role == Role::Climber {
        agent.spot = 1 - agent.spot;
        let target = CLIMB_SPOTS[agent.spot];
        sim.nav.move_to(agent.agent, target);
        return;
    }
    let here = agent.at;
    let rng = sim.world.rng.as_mut().expect("seeded at reset");
    let salt = sim.world.salt;
    let mut pick = (rng.below(SPOTS.len() as u32) + salt) as usize % SPOTS.len();
    if SPOTS[pick].distance(here) < 2.0 * REACH {
        pick = (pick + 1) % SPOTS.len();
    }
    agent.spot = pick;
    sim.nav.move_to(agent.agent, SPOTS[pick]);
}

/// One agent's tick: frozen while its cell is not simulated, a ladder crossing, or the documented
/// loop.
fn step_agent(sim: &mut Sim<World>, index: usize, dt: f32) {
    let Some(params) = sim.world.params else { return };
    let at = sim.world.agents[index].at;
    if !sim.stream.is_active(cell_of(at)) {
        freeze(sim, index);
        return;
    }
    if sim.world.agents[index].frozen.take().is_some() {
        sim.world.agents[index].resumes += 1;
    }
    if sim.world.agents[index].crossing.is_some() {
        play_crossing(sim, index, params, dt);
        return;
    }
    let agent = sim.world.agents[index].agent;
    match sim.nav.status(agent) {
        Some(NavStatus::AtLink) => {
            start_crossing(sim, index, params, dt);
            return;
        }
        Some(NavStatus::Arrived) => {
            let a = &mut sim.world.agents[index];
            a.arrivals += 1;
            if a.resumes > 0 {
                a.arrivals_after_resume += 1;
            }
            send(sim, index);
        }
        Some(NavStatus::NoPath | NavStatus::TargetOffMesh | NavStatus::Idle) => send(sim, index),
        _ => {}
    }
    drive(sim, index, params, dt);
}

/// The documented loop: desired velocity into the animator, its root motion and the velocity into
/// the capsule, the capsule's feet back to nav.
fn drive(sim: &mut Sim<World>, index: usize, params: Params, dt: f32) {
    let a = &mut sim.world.agents[index];
    // 2. The desired velocity into the animator; 3. the animator's root motion.
    let wish = sim.nav.desired_velocity(a.agent);
    a.animator.set_float(params.speed, wish.length());
    let root = a.animator.update(dt).root_motion;
    a.rooted += root.translation.length();
    if a.animator.state_name(params.base) == "climb" {
        sim.world.climbing_outside += 1;
    }
    let Some(character) = a.character.as_mut() else { return };
    // 4. The character makes the move; 5. nav hears where it went.
    character.drive(&mut sim.physics, CharacterMotion::Mixed { root, wish, jump: false, root_share: ROOT_SHARE }, dt);
    sim.nav.set_position(a.agent, character.feet(), character.velocity());
    a.at = character.feet();
    a.yaw = character.yaw();
}

/// The climber reached the ladder: its capsule leaves the world and its graph goes to `climb`.
fn start_crossing(sim: &mut Sim<World>, index: usize, params: Params, dt: f32) {
    let a = &mut sim.world.agents[index];
    let Some(reached) = sim.nav.take_link(a.agent) else { return };
    let ticks = ((reached.start.distance(reached.end) / CLIMB_SPEED) * 1000.0 / FIXED_STEP_MS as f32).ceil() as u32;
    if let Some(character) = a.character.take() {
        character.remove(&mut sim.physics);
    }
    a.crossing = Some(Crossing { from: reached.start, to: reached.end, elapsed: 0, ticks: ticks.max(1) });
    a.at = reached.start;
    // Face the tower: the ladder is on its south face.
    a.yaw = 0.0;
    a.animator.set_float(params.speed, 0.0);
    a.animator.set_bool(params.climbing, true);
    a.animator.update(dt);
    sim.world.taken += 1;
    sim.world.crossing_ticks += 1;
}

/// Advance the crossing; at its end the capsule lands, the link is finished and it walks on.
fn play_crossing(sim: &mut Sim<World>, index: usize, params: Params, dt: f32) {
    let a = &mut sim.world.agents[index];
    let Some(mut crossing) = a.crossing else { return };
    crossing.elapsed = (crossing.elapsed + 1).min(crossing.ticks);
    a.at = crossing.from.lerp(crossing.to, crossing.elapsed as f32 / crossing.ticks as f32);
    a.animator.update(dt);
    sim.world.crossing_ticks += 1;
    if a.animator.state_name(params.base) == "climb" {
        sim.world.climbing_ticks += 1;
    }
    if crossing.elapsed < crossing.ticks {
        a.crossing = Some(crossing);
        return;
    }
    let character = Character::spawn(&mut sim.physics, crossing.to, world::params()).expect("a capsule");
    if let Some(collider) = character.collider().and_then(|handle| sim.physics.colliders.get_mut(handle)) {
        collider.set_sensor(true);
    }
    sim.nav.set_position(a.agent, crossing.to, Vec3::ZERO);
    sim.nav.finish_link(a.agent);
    a.animator.set_bool(params.climbing, false);
    a.character = Some(character);
    a.crossing = None;
    sim.world.finished += 1;
}

/// An agent whose cell streamed out: its agent is off the mesh and stands still, and its capsule
/// is not driven. The first frozen tick records where both stood; every later one checks neither
/// moved and the agent is still off the mesh.
fn freeze(sim: &mut Sim<World>, index: usize) {
    let agent = sim.world.agents[index].agent;
    let at = sim.nav.position(agent).unwrap_or(Vec3::NAN);
    let off_mesh = sim.nav.status(agent) == Some(NavStatus::OffMesh) && sim.nav.desired_velocity(agent) == Vec3::ZERO;
    let a = &mut sim.world.agents[index];
    let feet = a.at;
    a.frozen_ticks += 1;
    let moved = match a.frozen {
        None => {
            a.freezes += 1;
            a.frozen = Some((at, feet));
            false
        }
        Some((was_at, was_feet)) => was_at != at || was_feet != feet,
    };
    // A climber frozen on the ladder has no nav position to keep: only its feet count.
    let crossing = a.crossing.is_some();
    if moved || !(off_mesh || crossing) {
        sim.world.freeze_breaks += 1;
    }
}

/// The door swings open while an agent is near and its town cell is simulated, and shut after.
fn step_door(sim: &mut Sim<World>, dt: f32) {
    if !sim.stream.is_active(cell_of(DOOR_AT)) {
        return;
    }
    let near = sim.world.agents.iter().any(|a| a.at.distance(DOOR_AT) < DOOR_NEAR);
    let Some(door) = sim.world.door.as_mut() else { return };
    let playing = door.playing();
    let open = playing.as_deref() == Some(DOOR_OPEN);
    if near && !open {
        door.play_once(DOOR_OPEN).expect("the door has an open clip");
        sim.world.door_opens += 1;
    } else if !near && open && door.finished() {
        door.play_once(DOOR_CLOSE).expect("the door has a close clip");
    }
    door.update(dt);
}

// ---------------------------------------------------------------------------------------------
// Drawing.

fn draw(sim: &Sim<World>, frame: &mut Frame, _: &Camera) {
    let world = &sim.world;
    frame.clear(SKY).ambient(Color::rgb(170, 190, 220), 0.3).sun(SUN_TOWARDS, Color::WHITE, 3.0);
    frame.environment(Environment::sky());
    if let Some(patch) = &world.patch {
        frame.tag("terrain").terrain(&patch.terrain);
    }
    if sim.stream.is_active(cell_of(LADDER.0)) {
        let mid = 0.5 * (LADDER.0 + LADDER.1);
        let lean = genex::math::atan2(LADDER.1.z - LADDER.0.z, LADDER.1.y - LADDER.0.y);
        let rails = Transform::from_translation(mid).with_rotation(Quat::from_rotation_x(lean)).with_scale(vec3(0.5, LADDER.0.distance(LADDER.1), 0.06));
        frame.tag("ladder").cube_with(rails, &Material::color(WOOD).with_roughness(0.8));
    }
    if let (Some(door), Some(model)) = (&world.door, &world.door_model)
        && sim.stream.is_active(cell_of(DOOR_AT))
    {
        frame.tag("door").model_posed(model, door, Transform::from_translation(DOOR_AT));
    }
    frame.tag("nav").nav_debug(&sim.nav, NavDebug::borders().with_links());
    frame.tag("agents");
    for (index, a) in world.agents.iter().enumerate() {
        let at = Transform::from_translation(a.at).with_rotation(Quat::from_rotation_y(a.yaw));
        let tint = if a.frozen.is_some() { FROZEN } else { TINTS[index % TINTS.len()] };
        frame.character_with(&a.animator, at, &genex::CharacterDraw::new().tint(tint));
    }
}

// ---------------------------------------------------------------------------------------------
// The static-world save.

/// A save of the scene: the streaming snapshot, the nav's, every agent's capsule and animator, the
/// door, the spot generator and the rule counters. The streamed cells, colliders and islands are
/// rebuilt from the streaming snapshot; the ladder and the islands are re-added as at the save.
#[derive(Clone)]
pub struct Saved {
    tick: u64,
    rng: Option<Pcg32>,
    stream: Value,
    nav: genex_core::json::Value,
    agents: Vec<SavedAgent>,
    door: Option<NodeAnimator>,
    counters: [u32; 12],
    things_digest: u64,
}

#[derive(Clone)]
struct SavedAgent {
    character: Option<genex_core::json::Value>,
    animator: genex_core::json::Value,
    at: Vec3,
    yaw: f32,
    crossing: Option<Crossing>,
    spot: usize,
    frozen: Option<(Vec3, Vec3)>,
    counts: [u32; 5],
    rooted: f32,
}

fn counters(world: &World) -> [u32; 12] {
    [
        world.huts,
        world.stones,
        world.towers,
        world.freeze_breaks,
        world.islands_entered,
        world.islands_left,
        world.taken,
        world.finished,
        world.crossing_ticks,
        world.climbing_ticks,
        world.climbing_outside,
        world.door_opens,
    ]
}

/// Save the scene (between ticks).
pub fn save(sim: &Sim<World>) -> Saved {
    let world = &sim.world;
    let agents = world
        .agents
        .iter()
        .map(|a| SavedAgent {
            character: a.character.as_ref().map(Character::snapshot),
            animator: a.animator.snapshot(),
            at: a.at,
            yaw: a.yaw,
            crossing: a.crossing,
            spot: a.spot,
            frozen: a.frozen,
            counts: [a.arrivals, a.arrivals_after_resume, a.frozen_ticks, a.freezes, a.resumes],
            rooted: a.rooted,
        })
        .collect();
    Saved {
        tick: world.tick,
        rng: world.rng,
        stream: sim.stream.snapshot(),
        nav: sim.nav.snapshot(),
        agents,
        door: world.door.clone(),
        counters: counters(world),
        things_digest: world.things_digest,
    }
}

/// Restore a [`save`] into a run of the same registration at the same tick whose agents have
/// spawned and whose ladder is in (the save row restores at the tick it saved). The salt goes back
/// to the saved run's (0).
pub fn restore(sim: &mut Sim<World>, saved: &Saved) -> Result<(), String> {
    if saved.agents.len() != sim.world.agents.len() || sim.world.ladder.is_none() {
        return Err("restore into a run whose agents and ladder are in".to_owned());
    }
    sim.stream.restore(&saved.stream).map_err(|error| format!("{error:?}"))?;
    sim.nav.restore(&saved.nav).map_err(|error| format!("{error:?}"))?;
    let world = &mut sim.world;
    world.salt = 0;
    world.tick = saved.tick;
    world.rng = saved.rng;
    world.door.clone_from(&saved.door);
    world.things_digest = saved.things_digest;
    [
        world.huts,
        world.stones,
        world.towers,
        world.freeze_breaks,
        world.islands_entered,
        world.islands_left,
        world.taken,
        world.finished,
        world.crossing_ticks,
        world.climbing_ticks,
        world.climbing_outside,
        world.door_opens,
    ] = saved.counters;
    for (a, s) in world.agents.iter_mut().zip(&saved.agents) {
        a.animator.restore(&s.animator).map_err(|error| format!("{error:?}"))?;
        restore_capsule(&mut sim.physics, a, s.character.as_ref())?;
        a.at = s.at;
        a.yaw = s.yaw;
        a.crossing = s.crossing;
        a.spot = s.spot;
        a.frozen = s.frozen;
        [a.arrivals, a.arrivals_after_resume, a.frozen_ticks, a.freezes, a.resumes] = s.counts;
        a.rooted = s.rooted;
    }
    Ok(())
}

/// An agent's capsule as saved: restored in place, spawned (a run that crossed the ladder at another
/// time) or removed (the saved agent was on the ladder).
fn restore_capsule(physics: &mut PhysicsWorld, a: &mut Agent, saved: Option<&genex_core::json::Value>) -> Result<(), String> {
    let Some(snapshot) = saved else {
        if let Some(character) = a.character.take() {
            character.remove(physics);
        }
        return Ok(());
    };
    if a.character.is_none() {
        let character = Character::spawn(physics, a.at, params()).map_err(|error| format!("{error:?}"))?;
        if let Some(collider) = character.collider().and_then(|handle| physics.colliders.get_mut(handle)) {
            collider.set_sensor(true);
        }
        a.character = Some(character);
    }
    let character = a.character.as_mut().expect("spawned above");
    character.restore(snapshot).map_err(|error| format!("{error:?}"))
}
