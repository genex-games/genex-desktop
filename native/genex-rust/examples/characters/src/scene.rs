//! The yard, its characters and the rules that move them.
//!
//! Layout (metres, ground at y 0, the camera south of the yard looking north):
//! - a 40 m square yard with a 6 m square block 3 m high to the north, a ladder on its south face
//!   (a nav ladder link, both ways) and a 20° ramp to the west (scenery);
//! - the hero, a simple animator ([`Animator::simple`]'s graph, `build_simple`), on a 4 m circle in
//!   the west: idle, walk, run, walk, idle every 12 s, with a slash played once while idle and while
//!   running, `crossfade` called every tick;
//! - the duelist, a two-layer graph (idle, walk and run on a `speed` parameter; a slash on the
//!   upper body on an `attack` trigger, with its `hit` event), pacing a line in the east;
//! - the climber, a nav agent moved through the documented loop (`sim.nav.update`, the desired
//!   velocity, `Character::drive`, `nav.set_position`), sent between the yard and the block's top,
//!   so its path takes the ladder: between `take_link` and `finish_link` it plays `Climb`;
//! - 30 walkers, simple animators on circles round the middle that stop for 1.5 s every 10 s.
//!
//! Every character's state (its animator's whole-state digest and pose digest) is in the
//! `characters` probe, so the checksum covers it; the `climb` probe counts the ladder rules.

use genex::glam::Vec3Swizzles;
use genex::math;
use genex::nav::{AgentId, NavAgent, NavArea, NavConfig, NavInput, NavLink, NavLinkKind, NavMesh, NavStatus};
use genex::physics::ColliderBuilder;
use genex::prelude::*;
use genex::{CharacterAsset, CharacterParams, FIXED_STEP_MS};
use genex::animation::{ClipId, FloatParam, Motion, TriggerParam, EventId, Mask, BodyPart};

use crate::mannequin::MANNEQUIN;

/// Walkers on the circles round the middle.
pub const WALKERS: usize = 30;
/// The observer eye, placed where the game camera is (its captures must equal the game's).
pub const OBSERVER_EYE: &str = "observer";
/// The hero's loop and the duelist's, in ticks.
pub const HERO_LOOP_TICKS: u64 = 720;
const DUELIST_LOOP_TICKS: u64 = 600;
/// The duelist attacks every this many ticks.
const DUELIST_ATTACK_TICKS: u64 = 180;
/// A walker stops for this many ticks every [`WALKER_PERIOD_TICKS`].
const WALKER_PAUSE_TICKS: u64 = 90;
const WALKER_PERIOD_TICKS: u64 = 600;

/// The yard's half side, the block's centre, half side and height.
const YARD_HALF: f32 = 20.0;
const BLOCK_AT: Vec3 = vec3(0.0, 0.0, -8.0);
const BLOCK_HALF: f32 = 3.0;
const BLOCK_HEIGHT: f32 = 3.0;
/// The ladder's ground and top ends (on the block's south face) and the climb's speed.
const LADDER: (Vec3, Vec3) = (vec3(0.0, 0.0, -3.8), vec3(0.0, BLOCK_HEIGHT, -5.6));
const CLIMB_SPEED: f32 = 1.0;
/// The ramp (scenery): centre, half extents, slope.
const RAMP_AT: Vec3 = vec3(-14.0, 0.6, -6.0);
const RAMP_HALF: Vec3 = vec3(3.0, 0.15, 2.0);
const RAMP_DEGREES: f32 = 20.0;
/// The climber's two destinations: in the yard and on the block.
const CLIMBER_SPOTS: [Vec3; 2] = [vec3(5.0, 0.0, -1.0), vec3(0.0, BLOCK_HEIGHT, -9.5)];
const CLIMBER_SPEED: (f32, f32) = (1.6, 2.2);
/// The hero's circle (centre, radius) and its speeds, metres per second.
const HERO_CIRCLE: (Vec3, f32) = (vec3(-9.0, 0.0, 6.0), 4.0);
const WALK_SPEED: f32 = 1.4;
const RUN_SPEED: f32 = 4.0;
/// The duelist paces x between these at this z.
const DUELIST_LINE: (f32, f32, f32) = (10.0, 16.0, 4.0);
/// The walkers' circles: centre, the first radius and the step out per ring.
const WALKER_CENTRE: Vec3 = vec3(0.0, 0.0, 10.0);
const WALKER_RADIUS: (f32, f32) = (3.0, 1.0);
/// How long a simple animator's crossfades are, seconds.
const FADE: f32 = 0.25;

/// Look.
const CLEAR: Color = Color::rgb(150, 182, 220);
const SUN_TOWARDS: Vec3 = vec3(-0.45, 0.7, 0.55);
const GROUND: Color = Color::rgb(118, 128, 104);
const STONE: Color = Color::rgb(160, 150, 136);
const WOOD: Color = Color::rgb(110, 76, 48);
const TINTS: [Color; 5] = [Color::rgb(230, 230, 230), Color::rgb(200, 120, 110), Color::rgb(120, 160, 200), Color::rgb(150, 190, 130), Color::rgb(210, 190, 120)];

/// The game camera (and the observer eye).
pub fn game_camera() -> Camera {
    Camera::look_at(vec3(0.0, 9.0, 24.0), vec3(0.0, 1.0, 0.0))
}

/// The mannequin's clips, looked up once.
#[derive(Clone, Copy, Debug)]
pub struct Clips {
    /// `Idle`.
    pub idle: ClipId,
    /// `Walk`.
    pub walk: ClipId,
    /// `Run`.
    pub run: ClipId,
    /// `Slash`, played once.
    pub slash: ClipId,
    /// `Climb`, on the ladder.
    pub climb: ClipId,
}

impl Clips {
    fn of(asset: &CharacterAsset) -> Option<Clips> {
        Some(Clips { idle: asset.clip("Idle")?, walk: asset.clip("Walk")?, run: asset.clip("Run")?, slash: asset.clip("Slash")?, climb: asset.clip("Climb")? })
    }
}

/// A character drawn at a place, facing a heading.
#[derive(Clone, Debug)]
pub struct Placed {
    /// Its animator.
    pub animator: Animator,
    /// Its feet.
    pub at: Vec3,
    /// Its heading about y, radians (0 faces +z).
    pub yaw: f32,
}

impl Placed {
    fn transform(&self) -> Transform {
        Transform::from_translation(self.at).with_rotation(Quat::from_rotation_y(self.yaw))
    }
}

/// The duelist's graph handles.
#[derive(Clone, Copy, Debug)]
struct DuelHandles {
    speed: FloatParam,
    attack: TriggerParam,
    hit: EventId,
}

/// The climber: its agent, capsule and crossing.
#[derive(Debug, Default)]
struct Climber {
    agent: Option<AgentId>,
    character: Option<Character>,
    crossing: Option<Crossing>,
    spot: usize,
}

/// A ladder crossing being played: the capsule is out of the world until it lands.
#[derive(Clone, Copy, Debug)]
struct Crossing {
    from: Vec3,
    to: Vec3,
    elapsed: u32,
    ticks: u32,
}

/// What the ladder rules counted.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ClimbTotals {
    /// Links taken (`take_link`).
    pub taken: u32,
    /// Links finished (`finish_link`).
    pub finished: u32,
    /// Ticks inside a crossing.
    pub crossing_ticks: u32,
    /// Of those, the ticks the climber's animator played `Climb`.
    pub climbing_ticks: u32,
    /// Ticks outside every crossing on which it played `Climb` (none, when the rule holds).
    pub climbing_outside: u32,
}

/// The game's world.
#[derive(Debug, Default)]
pub struct World {
    tick: u64,
    clips: Option<Clips>,
    /// The simple animator.
    pub hero: Option<Placed>,
    hero_angle: f32,
    /// The graph animator.
    pub duelist: Option<Placed>,
    duel: Option<DuelHandles>,
    duelist_heading: f32,
    hits: u32,
    /// The nav-driven climber.
    pub climber: Option<Placed>,
    climb: Climber,
    totals: ClimbTotals,
    /// The walkers.
    pub walkers: Vec<Placed>,
}

impl World {
    /// The ladder rules' totals.
    pub fn climb_totals(&self) -> ClimbTotals {
        self.totals
    }

    /// The clips, once the mannequin loaded.
    pub fn clips(&self) -> Option<Clips> {
        self.clips
    }

    /// Every character, the hero first.
    pub fn characters(&self) -> impl Iterator<Item = &Placed> {
        self.hero.iter().chain(&self.duelist).chain(&self.climber).chain(&self.walkers)
    }
}

/// The capsule the climber uses.
fn params() -> CharacterParams {
    CharacterParams::default()
}

fn nav_config() -> NavConfig {
    Character::on_ground(Vec3::ZERO, params()).expect("default parameters").nav_config()
}

/// Register every hook.
pub(crate) fn wire(game: &mut Game<World>) {
    game.navigation(nav_config());
    game.on_reset(|sim, _, _, gfx| reset(sim, gfx));
    game.on_update(update);
    game.on_draw(draw);
    game.camera(|_| game_camera());
    game.eye(OBSERVER_EYE, |_| game_camera());
    game.probe("characters", |sim| {
        let entry = |placed: &Placed| json!({ "state": placed.animator.state_name(genex_first_layer(&placed.animator)), "digest": format!("{:016x}", placed.animator.digest()), "pose": format!("{:016x}", placed.animator.pose_digest()) });
        let walkers = sim.world.walkers.iter().fold(0xcbf2_9ce4_8422_2325_u64, |hash, walker| fnv_u64(hash, walker.animator.digest()));
        json!({
            "hero": sim.world.hero.as_ref().map(entry),
            "duelist": sim.world.duelist.as_ref().map(entry),
            "climber": sim.world.climber.as_ref().map(entry),
            "walkers": format!("{walkers:016x}"),
            "hits": sim.world.hits,
        })
    });
    game.demo(crate::DEFAULT_DEMO, |d| {
        d.advance_ms(10_000);
        let totals = d.sim().world.totals;
        json!({ "taken": totals.taken, "hits": d.sim().world.hits })
    });
    game.probe("climb", |sim| {
        let totals = sim.world.totals;
        json!({
            "taken": totals.taken,
            "finished": totals.finished,
            "crossingTicks": totals.crossing_ticks,
            "climbingTicks": totals.climbing_ticks,
            "climbingOutside": totals.climbing_outside,
        })
    });
}

/// An animator's first layer (the simple animator's only one).
fn genex_first_layer(animator: &Animator) -> genex::animation::LayerId {
    animator.graph().layers().next().expect("every graph has a layer")
}

fn fnv_u64(hash: u64, value: u64) -> u64 {
    value.to_le_bytes().iter().fold(hash, |hash, byte| (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3))
}

// ---------------------------------------------------------------------------------------------
// The level.

fn cuboid(physics: &mut PhysicsWorld, center: Vec3, half: Vec3) {
    physics.insert_collider(ColliderBuilder::cuboid(half.x, half.y, half.z).translation(center), None);
}

fn build_level(physics: &mut PhysicsWorld) {
    cuboid(physics, vec3(0.0, -0.5, 0.0), vec3(YARD_HALF, 0.5, YARD_HALF));
    cuboid(physics, BLOCK_AT + Vec3::Y * (0.5 * BLOCK_HEIGHT), vec3(BLOCK_HALF, 0.5 * BLOCK_HEIGHT, BLOCK_HALF));
}

/// A simple animator of `asset` playing `clip` (the facade's `Animator::simple` is this graph).
fn simple(asset: &CharacterAsset, clip: ClipId) -> Animator {
    let graph = asset.graph().build_simple().expect("the mannequin's simple graph");
    let mut animator = asset.animator(&graph).expect("an animator of the mannequin");
    animator.play(clip);
    animator
}

/// The duelist's graph: idle, walk and run on `speed`; a slash on the upper body on `attack`.
fn duelist(asset: &CharacterAsset, clips: Clips) -> (Animator, DuelHandles) {
    let mut g = asset.graph();
    let speed = g.float("speed", 0.0);
    let attack = g.trigger("attack");
    let base = g.layer("base");
    let idle = g.state(base, "idle", Motion::clip(clips.idle));
    let walk = g.state(base, "walk", Motion::clip(clips.walk));
    let run = g.state(base, "run", Motion::clip(clips.run));
    g.transition(idle, walk).when(speed.above(0.1)).inertialize(0.2);
    g.transition(walk, run).when(speed.above(2.5)).crossfade(0.25);
    g.transition(run, walk).when(speed.below(2.5)).crossfade(0.25);
    g.transition(walk, idle).when(speed.below(0.1)).inertialize(0.25);
    let upper = g.layer("upper");
    g.layer_mask(upper, Mask::Humanoid(BodyPart::UpperBody));
    let none = g.state(upper, "none", Motion::Empty);
    let swing = g.state(upper, "slash", Motion::clip(clips.slash).once());
    g.transition(none, swing).when(attack.fired()).crossfade(0.1);
    g.transition(swing, none).at_end().crossfade(0.2);
    let hit = g.event(clips.slash, 0.3, "hit");
    let graph = g.build().expect("the duelist's graph");
    (asset.animator(&graph).expect("an animator of the mannequin"), DuelHandles { speed, attack, hit })
}

fn reset(sim: &mut Sim<World>, gfx: &Gfx) {
    build_level(&mut sim.physics);
    let input = NavInput::new().with_static_colliders(&sim.physics, NavArea::WALK).expect("the yard");
    sim.nav.add_mesh(&NavMesh::bake(&input, &nav_config()).expect("the mesh")).expect("the tiles");
    // Islands stitch on an update; the ladder's ends sit on the polygons.
    sim.nav.update(FIXED_STEP_MS as f32 / 1000.0);
    let on_mesh = |nav: &genex::nav::Nav, at: Vec3| nav.closest_point(at, 1.0).map_or(at, |point| point.position);
    let ladder = (on_mesh(&sim.nav, LADDER.0), on_mesh(&sim.nav, LADDER.1));
    sim.nav.add_link(NavLink::between(ladder.0, ladder.1, NavLinkKind::Ladder).both_ways()).expect("the ladder");
    sim.nav.update(FIXED_STEP_MS as f32 / 1000.0);
    sim.world = World::default();
    let Ok(asset) = gfx.character(MANNEQUIN) else { return };
    let Some(clips) = Clips::of(&asset) else { return };
    let world = &mut sim.world;
    world.clips = Some(clips);
    world.hero = Some(Placed { animator: simple(&asset, clips.idle), at: HERO_CIRCLE.0 + Vec3::X * HERO_CIRCLE.1, yaw: 0.0 });
    let (animator, handles) = duelist(&asset, clips);
    world.duelist = Some(Placed { animator, at: vec3(DUELIST_LINE.0, 0.0, DUELIST_LINE.2), yaw: std::f32::consts::FRAC_PI_2 });
    world.duel = Some(handles);
    world.duelist_heading = 1.0;
    world.walkers = (0..WALKERS)
        .map(|index| {
            let mut animator = simple(&asset, clips.walk);
            animator.speed(1.0 + 0.1 * (index % 3) as f32);
            let (at, yaw) = walker_place(index, 0);
            Placed { animator, at, yaw }
        })
        .collect();
    let start = on_mesh(&sim.nav, CLIMBER_SPOTS[0]);
    let agent = sim.nav.add_agent(NavAgent::new(start).with_speed(CLIMBER_SPEED.0, CLIMBER_SPEED.1)).expect("the climber's agent");
    sim.nav.move_to(agent, CLIMBER_SPOTS[1]);
    sim.world.climb = Climber { agent: Some(agent), character: Some(Character::spawn(&mut sim.physics, start, params()).expect("a capsule")), crossing: None, spot: 1 };
    sim.world.climber = Some(Placed { animator: simple(&asset, clips.idle), at: start, yaw: 0.0 });
}

// ---------------------------------------------------------------------------------------------
// The rules.

fn update(sim: &mut Sim<World>, ctx: &Ctx) {
    let dt = ctx.dt;
    let Some(clips) = sim.world.clips else { return };
    let tick = sim.world.tick;
    sim.world.tick += 1;
    sim.nav.update(dt);
    step_hero(&mut sim.world, clips, tick, dt);
    step_duelist(&mut sim.world, tick, dt);
    step_climber(sim, clips, dt);
    for (index, walker) in sim.world.walkers.iter_mut().enumerate() {
        let moving = (tick + index as u64 * 37) % WALKER_PERIOD_TICKS >= WALKER_PAUSE_TICKS;
        walker.animator.crossfade(if moving { clips.walk } else { clips.idle }, 0.3);
        walker.animator.update(dt);
        if moving {
            let (at, yaw) = walker_place(index, walker_ticks_moving(tick, index));
            (walker.at, walker.yaw) = (at, yaw);
        }
    }
}

/// The ticks walker `index` has walked by `tick` (it stops for a pause each period).
fn walker_ticks_moving(tick: u64, index: usize) -> u64 {
    let shifted = tick + index as u64 * 37;
    let periods = shifted / WALKER_PERIOD_TICKS;
    let into = shifted % WALKER_PERIOD_TICKS;
    periods * (WALKER_PERIOD_TICKS - WALKER_PAUSE_TICKS) + into.saturating_sub(WALKER_PAUSE_TICKS)
}

/// Walker `index` after walking `ticks`: its feet and heading on its circle.
fn walker_place(index: usize, ticks: u64) -> (Vec3, f32) {
    let ring = (index % 6) as f32;
    let radius = WALKER_RADIUS.0 + ring * WALKER_RADIUS.1;
    let direction = if index.is_multiple_of(2) { 1.0 } else { -1.0 };
    let start = index as f32 * 2.399;
    let angle = start + direction * WALK_SPEED * (ticks as f32 * FIXED_STEP_MS as f32 / 1000.0) / radius;
    let at = WALKER_CENTRE + vec3(radius * math::cos(angle), 0.0, radius * math::sin(angle));
    // The tangent of the circle in the walking direction.
    let tangent = vec3(-math::sin(angle), 0.0, math::cos(angle)) * direction;
    (at, math::atan2(tangent.x, tangent.z))
}

/// The hero's schedule: (speed, clip) at `tick` of its loop.
fn hero_plan(clips: Clips, tick: u64) -> (f32, ClipId) {
    match tick % HERO_LOOP_TICKS {
        0..120 => (0.0, clips.idle),
        120..360 => (WALK_SPEED, clips.walk),
        360..540 => (RUN_SPEED, clips.run),
        540..660 => (WALK_SPEED, clips.walk),
        _ => (0.0, clips.idle),
    }
}

fn step_hero(world: &mut World, clips: Clips, tick: u64, dt: f32) {
    let Some(hero) = world.hero.as_mut() else { return };
    let (speed, clip) = hero_plan(clips, tick);
    hero.animator.crossfade(clip, FADE);
    if matches!(tick % HERO_LOOP_TICKS, 60 | 450) {
        hero.animator.play_once(clips.slash);
    }
    hero.animator.update(dt);
    world.hero_angle += speed * dt / HERO_CIRCLE.1;
    let (centre, radius) = HERO_CIRCLE;
    hero.at = centre + vec3(radius * math::cos(world.hero_angle), 0.0, radius * math::sin(world.hero_angle));
    hero.yaw = math::atan2(-math::sin(world.hero_angle), math::cos(world.hero_angle));
}

fn step_duelist(world: &mut World, tick: u64, dt: f32) {
    let (Some(duelist), Some(handles)) = (world.duelist.as_mut(), world.duel) else { return };
    let speed = match tick % DUELIST_LOOP_TICKS {
        0..150 => 0.0,
        150..400 => WALK_SPEED,
        _ => 3.5,
    };
    duelist.animator.set_float(handles.speed, speed);
    if tick % DUELIST_ATTACK_TICKS == DUELIST_ATTACK_TICKS - 1 {
        duelist.animator.fire(handles.attack);
    }
    let step = duelist.animator.update(dt);
    world.hits += step.events.iter().filter(|event| event.event == handles.hit).count() as u32;
    let (left, right, _) = DUELIST_LINE;
    let next = duelist.at.x + world.duelist_heading * speed * dt;
    if !(left..=right).contains(&next) {
        world.duelist_heading = -world.duelist_heading;
    }
    duelist.at.x = next.clamp(left, right);
    duelist.yaw = world.duelist_heading * std::f32::consts::FRAC_PI_2;
}

/// The climber's tick: play a crossing, take the ladder, turn round at a destination, or drive the
/// capsule; then its animator follows what it does.
fn step_climber(sim: &mut Sim<World>, clips: Clips, dt: f32) {
    let Some(agent) = sim.world.climb.agent else { return };
    let crossing_before = sim.world.climb.crossing.is_some();
    if crossing_before {
        play_crossing(sim, agent, clips);
    } else {
        match sim.nav.status(agent) {
            Some(NavStatus::AtLink) => start_crossing(sim, agent, clips),
            Some(NavStatus::Arrived | NavStatus::Idle | NavStatus::NoPath) => {
                let spot = 1 - sim.world.climb.spot;
                sim.world.climb.spot = spot;
                sim.nav.move_to(agent, CLIMBER_SPOTS[spot]);
            }
            _ => {}
        }
        drive_climber(sim, agent, clips, dt);
    }
    // A crossing's ticks run from `take_link`'s through the last before `finish_link`'s: on the
    // landing tick the walk crossfade has already started.
    let crossing = sim.world.climb.crossing.is_some();
    let Some(climber) = sim.world.climber.as_mut() else { return };
    climber.animator.update(dt);
    let climbing = climber.animator.playing_clip() == Some(clips.climb);
    let totals = &mut sim.world.totals;
    if crossing {
        totals.crossing_ticks += 1;
        totals.climbing_ticks += u32::from(climbing);
    } else {
        totals.climbing_outside += u32::from(climbing);
    }
}

fn drive_climber(sim: &mut Sim<World>, agent: AgentId, clips: Clips, dt: f32) {
    if sim.world.climb.crossing.is_some() {
        return;
    }
    let wish = sim.nav.desired_velocity(agent);
    let Some(character) = sim.world.climb.character.as_mut() else { return };
    character.drive(&mut sim.physics, CharacterMotion::Velocity { wish, jump: false }, dt);
    sim.nav.set_position(agent, character.feet(), character.velocity());
    let (feet, velocity) = (character.feet(), character.velocity());
    let Some(climber) = sim.world.climber.as_mut() else { return };
    climber.at = feet;
    let moving = velocity.xz().length() > 0.3;
    if moving {
        climber.yaw = math::atan2(velocity.x, velocity.z);
    }
    climber.animator.crossfade(if moving { clips.walk } else { clips.idle }, FADE);
}

/// The climber reached the ladder: its capsule leaves the world and it plays `Climb`.
fn start_crossing(sim: &mut Sim<World>, agent: AgentId, clips: Clips) {
    let Some(reached) = sim.nav.take_link(agent) else { return };
    let ticks = ((reached.start.distance(reached.end) / CLIMB_SPEED) * 1000.0 / FIXED_STEP_MS as f32).ceil() as u32;
    if let Some(character) = sim.world.climb.character.take() {
        character.remove(&mut sim.physics);
    }
    sim.world.climb.crossing = Some(Crossing { from: reached.start, to: reached.end, elapsed: 0, ticks: ticks.max(1) });
    sim.world.totals.taken += 1;
    if let Some(climber) = sim.world.climber.as_mut() {
        climber.animator.play(clips.climb);
        climber.at = reached.start;
        // Face the block: the ladder is on its south face.
        climber.yaw = std::f32::consts::PI;
    }
}

/// Advance the crossing; at its end the capsule lands, the link is finished and it walks on.
fn play_crossing(sim: &mut Sim<World>, agent: AgentId, clips: Clips) {
    let Some(mut crossing) = sim.world.climb.crossing else { return };
    crossing.elapsed = (crossing.elapsed + 1).min(crossing.ticks);
    sim.world.climb.crossing = Some(crossing);
    let progress = crossing.elapsed as f32 / crossing.ticks as f32;
    if let Some(climber) = sim.world.climber.as_mut() {
        climber.at = crossing.from.lerp(crossing.to, progress);
    }
    if crossing.elapsed < crossing.ticks {
        return;
    }
    let character = Character::spawn(&mut sim.physics, crossing.to, params()).expect("a capsule");
    sim.nav.set_position(agent, crossing.to, Vec3::ZERO);
    sim.nav.finish_link(agent);
    sim.world.totals.finished += 1;
    sim.world.climb.character = Some(character);
    sim.world.climb.crossing = None;
    if let Some(climber) = sim.world.climber.as_mut() {
        climber.animator.crossfade(clips.walk, FADE);
    }
}

// ---------------------------------------------------------------------------------------------
// Drawing.

fn draw(sim: &Sim<World>, frame: &mut Frame, _: &Camera) {
    let world = &sim.world;
    frame.clear(CLEAR).ambient(Color::rgb(170, 190, 220), 0.3).sun(SUN_TOWARDS, Color::WHITE, 3.0);
    frame.environment(genex::render::Environment::sky());
    let box_at = |center: Vec3, half: Vec3| Transform::from_translation(center).with_scale(half * 2.0);
    frame.tag("yard").cube_with(box_at(vec3(0.0, -0.5, 0.0), vec3(YARD_HALF, 0.5, YARD_HALF)), &Material::color(GROUND).with_roughness(0.95));
    frame.tag("block").cube_with(box_at(BLOCK_AT + Vec3::Y * (0.5 * BLOCK_HEIGHT), vec3(BLOCK_HALF, 0.5 * BLOCK_HEIGHT, BLOCK_HALF)), &Material::color(STONE).with_roughness(0.85));
    let rail = LADDER.0.lerp(LADDER.1, 0.5);
    let lean = math::atan2(LADDER.1.z - LADDER.0.z, LADDER.1.y - LADDER.0.y);
    frame.tag("ladder").cube_with(box_at(rail, vec3(0.4, 0.5 * LADDER.0.distance(LADDER.1), 0.04)).with_rotation(Quat::from_rotation_x(lean)), &Material::color(WOOD).with_roughness(0.8));
    let ramp = Quat::from_rotation_z(RAMP_DEGREES.to_radians());
    frame.tag("ramp").cube_with(box_at(RAMP_AT, RAMP_HALF).with_rotation(ramp), &Material::color(STONE).with_roughness(0.85));
    if let Some(hero) = &world.hero {
        frame.tag("hero").character(&hero.animator, hero.transform());
    }
    if let Some(duelist) = &world.duelist {
        frame.tag("duelist").character_with(&duelist.animator, duelist.transform(), &genex::CharacterDraw::new().tint(TINTS[1]));
    }
    if let Some(climber) = &world.climber {
        frame.tag("climber").character_with(&climber.animator, climber.transform(), &genex::CharacterDraw::new().tint(TINTS[2]));
    }
    frame.tag("walkers");
    for (index, walker) in world.walkers.iter().enumerate() {
        frame.character_with(&walker.animator, walker.transform(), &genex::CharacterDraw::new().tint(TINTS[index % TINTS.len()]));
    }
}
