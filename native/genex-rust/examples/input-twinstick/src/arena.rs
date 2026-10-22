//! The arena: the world, the rules each tick and the drawing. A ship walks with `move`, aims with
//! `aim` (or the mouse pointer), fires with `fire` (or by pushing the aim stick), and dashes with
//! `dash`; drones come in from the edges and chase it. Every rule reads `ctx.actions`, so the same
//! tick rows give the same arena on every destination and in a replay.

use genex::actions::{Device, UI};
use genex::math::{Vec2, Vec3, tan};
use genex::prelude::*;

use crate::controls::{AIM, AIM_FIRES, DASH, FIRE, MOVE, PAUSE, PLAY};

/// Half the arena's width and depth, in metres.
pub const ARENA_HALF: [f32; 2] = [14.0, 8.0];
/// The ship's hit points at the start.
pub const HP_START: u32 = 3;
/// Where the camera looks from.
pub const CAMERA_EYE: [f32; 3] = [0.0, 22.0, 10.0];
/// Where the camera looks at.
pub const CAMERA_TARGET: [f32; 3] = [0.0, 0.0, 0.5];

/// How far the ship walks in a tick at full stick.
const SPEED_PER_TICK: f32 = 0.16;
/// A dash: this fast, for this many ticks, untouchable meanwhile.
const DASH_SPEED_PER_TICK: f32 = 0.6;
const DASH_TICKS: u32 = 8;
/// Shots: speed, life, cadence and size.
const SHOT_SPEED_PER_TICK: f32 = 0.45;
const SHOT_LIFE_TICKS: u32 = 50;
const FIRE_EVERY_TICKS: u32 = 8;
const SHOT_RADIUS: f32 = 0.18;
/// Drones: size, speed, and the spawn interval (it shortens as the score grows).
const DRONE_RADIUS: f32 = 0.5;
const DRONE_SPEED_PER_TICK: f32 = 0.05;
const SPAWN_FIRST_TICKS: u32 = 60;
const SPAWN_EVERY_TICKS: u32 = 90;
const SPAWN_EVERY_MIN_TICKS: u32 = 36;
const DRONES_MAX: usize = 24;
/// The ship: size and the ticks it cannot be hit after a hit.
const SHIP_RADIUS: f32 = 0.5;
const HURT_TICKS: u32 = 60;
/// While hurt the ship blinks, this many ticks on and off.
const HURT_BLINK_TICKS: u32 = 6;
/// Colours.
const FLOOR: Color = Color::rgb(64, 74, 96);
const GRID: Color = Color::rgb(110, 126, 160);
const WALL: Color = Color::rgb(96, 108, 132);
const SHIP: Color = Color::rgb(80, 200, 255);
const SHIP_HURT: Color = Color::rgb(255, 120, 120);
const AIM_MARK: Color = Color::rgb(255, 230, 120);
const SHOT: Color = Color::rgb(255, 214, 90);
const DRONE: Color = Color::rgb(232, 84, 96);

/// A shot in flight.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Shot {
    /// Where it is (x, z).
    pub at: [f32; 2],
    /// How far it moves in a tick.
    pub step: [f32; 2],
    /// Ticks left.
    pub life: u32,
}

/// What the HUD showed on its last pass: display only, never in a non-volatile probe, a save or a
/// rule (prompt labels change with the device and the keyboard layout).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Shown {
    /// The dash prompt's label ("Space", "Cross").
    pub dash: String,
    /// The fire prompt's label.
    pub fire: String,
    /// The pause prompt's label.
    pub pause: String,
    /// The device the prompts are for.
    pub device: String,
    /// The AccessKit label of the widget with keyboard focus in the pause menu.
    pub focused: Option<String>,
}

/// The arena's state.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct World {
    /// The ship (x, z).
    pub ship: [f32; 2],
    /// The way the ship aims (unit, x and z).
    pub aim: [f32; 2],
    /// Hit points; the run is over at 0.
    pub hp: u32,
    /// Drones shot down.
    pub score: u32,
    /// Dashes made.
    pub dashes: u32,
    /// Shots fired.
    pub shots_fired: u32,
    /// Ticks of the current dash left.
    pub dash_left: u32,
    /// The current dash's direction (unit, x and z).
    pub dash_dir: [f32; 2],
    /// Ticks until the next shot may leave.
    pub fire_wait: u32,
    /// Ticks until the ship can be hit again.
    pub hurt: u32,
    /// Shots in flight.
    pub shots: Vec<Shot>,
    /// Drones alive (x, z).
    pub drones: Vec<[f32; 2]>,
    /// Ticks until the next drone.
    pub spawn_wait: u32,
    /// Whether the pause menu is open.
    pub paused: bool,
    /// Whether the run is over (Fire or Dash restarts it).
    pub over: bool,
    /// Ticks played (not paused).
    pub ticks: u64,
    /// What the HUD showed (display only).
    pub shown: Shown,
}

impl World {
    /// A fresh run: the ship in the middle, aiming up the screen.
    pub fn fresh() -> World {
        World { aim: [0.0, -1.0], hp: HP_START, spawn_wait: SPAWN_FIRST_TICKS, ..World::default() }
    }
}

/// The reset hook: a fresh run.
pub fn reset(sim: &mut Sim<World>, _seed: u32, _rng: &mut Pcg32, _gfx: &Gfx) {
    sim.world = World::fresh();
}

/// Open or close the pause menu: the `ui` context takes over from `play` (from the next tick).
pub fn set_paused(world: &mut World, ctx: &Ctx, paused: bool) {
    world.paused = paused;
    if paused {
        ctx.actions.enable(UI);
        ctx.actions.disable(PLAY);
    } else {
        ctx.actions.disable(UI);
        ctx.actions.enable(PLAY);
    }
}

/// The update hook.
pub fn update(sim: &mut Sim<World>, ctx: &Ctx) {
    let world = &mut sim.world;
    let actions = ctx.actions;
    if world.paused {
        // The pause button, or the menu's back (Escape, the pad's back button) closes it.
        if actions.pressed(PAUSE) || actions.fired(genex::actions::UiAction::CANCEL) {
            set_paused(world, ctx, false);
        }
        return;
    }
    // Escape stays the system menu's key, so the game reads it raw to open its pause menu.
    if actions.pressed(PAUSE) || ctx.keys.pressed(Key::Escape) {
        set_paused(world, ctx, true);
        return;
    }
    if world.over {
        if actions.pressed(FIRE) || actions.fired(DASH) {
            *world = World { shown: world.shown.clone(), ..World::fresh() };
        }
        return;
    }
    world.ticks += 1;
    walk(world, ctx);
    shoot(world, ctx);
    drones(world, ctx);
}

/// Walk and dash.
fn walk(world: &mut World, ctx: &Ctx) {
    let stick = ctx.actions.axis2(MOVE);
    if ctx.actions.fired(DASH) && world.dash_left == 0 {
        world.dash_left = DASH_TICKS;
        world.dash_dir = unit(stick.to_array()).unwrap_or(world.aim);
        world.dashes += 1;
    }
    let step = if world.dash_left > 0 {
        world.dash_left -= 1;
        world.dash_dir.map(|d| d * DASH_SPEED_PER_TICK)
    } else {
        [stick.x * SPEED_PER_TICK, stick.y * SPEED_PER_TICK]
    };
    world.ship = clamp_to_arena([world.ship[0] + step[0], world.ship[1] + step[1]], SHIP_RADIUS);
}

/// Aim, then fire on the cadence: the aim stick fires when pushed; the mouse aims at the pointer
/// while the fire button is down.
fn shoot(world: &mut World, ctx: &Ctx) {
    let stick = ctx.actions.axis2(AIM);
    let pushed = stick.length() >= AIM_FIRES;
    let on_mouse = ctx.actions.device() == Device::KeyboardMouse;
    if pushed {
        world.aim = unit(stick.to_array()).unwrap_or(world.aim);
    } else if on_mouse {
        let at = pointer_on_floor(ctx.pointer, ctx.world_size);
        world.aim = unit([at[0] - world.ship[0], at[1] - world.ship[1]]).unwrap_or(world.aim);
    }
    world.fire_wait = world.fire_wait.saturating_sub(1);
    if !(pushed || ctx.actions.down(FIRE)) || world.fire_wait > 0 {
        return;
    }
    world.fire_wait = FIRE_EVERY_TICKS;
    world.shots_fired += 1;
    let step = world.aim.map(|d| d * SHOT_SPEED_PER_TICK);
    world.shots.push(Shot { at: world.ship, step, life: SHOT_LIFE_TICKS });
}

/// Move the shots and drones, spawn, and settle hits.
fn drones(world: &mut World, ctx: &Ctx) {
    for shot in &mut world.shots {
        shot.at = [shot.at[0] + shot.step[0], shot.at[1] + shot.step[1]];
        shot.life = shot.life.saturating_sub(1);
    }
    world.shots.retain(|shot| shot.life > 0 && inside(shot.at));
    world.spawn_wait = world.spawn_wait.saturating_sub(1);
    if world.spawn_wait == 0 && world.drones.len() < DRONES_MAX {
        world.drones.push(edge_point(ctx));
        world.spawn_wait = SPAWN_EVERY_TICKS.saturating_sub(world.score * 2).max(SPAWN_EVERY_MIN_TICKS);
    }
    let ship = world.ship;
    for drone in &mut world.drones {
        if let Some(toward) = unit([ship[0] - drone[0], ship[1] - drone[1]]) {
            *drone = [drone[0] + toward[0] * DRONE_SPEED_PER_TICK, drone[1] + toward[1] * DRONE_SPEED_PER_TICK];
        }
    }
    shots_hit(world);
    drones_hit(world);
}

/// A shot touching a drone takes both out and scores.
fn shots_hit(world: &mut World) {
    let reach = SHOT_RADIUS + DRONE_RADIUS;
    let mut hits = 0;
    world.drones.retain(|drone| {
        let Some(at) = world.shots.iter().position(|shot| distance(shot.at, *drone) < reach) else { return true };
        world.shots.swap_remove(at);
        hits += 1;
        false
    });
    world.score += hits;
}

/// A drone touching the ship costs a hit point, unless the ship is dashing or just hurt.
fn drones_hit(world: &mut World) {
    world.hurt = world.hurt.saturating_sub(1);
    let reach = SHIP_RADIUS + DRONE_RADIUS;
    let ship = world.ship;
    let Some(at) = world.drones.iter().position(|drone| distance(ship, *drone) < reach) else { return };
    if world.dash_left > 0 || world.hurt > 0 {
        return;
    }
    world.drones.swap_remove(at);
    world.hp = world.hp.saturating_sub(1);
    world.hurt = HURT_TICKS;
    world.over = world.hp == 0;
}

/// A point on the arena's edge, drawn from the tick's rng.
fn edge_point(ctx: &Ctx) -> [f32; 2] {
    let [hx, hz] = ARENA_HALF;
    let along = ctx.rng.range_f32(-1.0, 1.0);
    match ctx.rng.below(4) {
        0 => [along * hx, -hz],
        1 => [along * hx, hz],
        2 => [-hx, along * hz],
        _ => [hx, along * hz],
    }
}

/// Where the pointer (a fraction of the frame, y down) meets the floor, through the camera.
pub fn pointer_on_floor(pointer: Vec2, world_size: [u32; 2]) -> [f32; 2] {
    let camera = camera();
    let forward = (camera.target - camera.position).normalize();
    let right = forward.cross(camera.up).normalize();
    let up = right.cross(forward);
    let half_height = tan(camera.fovy.to_radians() * 0.5);
    let aspect = world_size[0] as f32 / world_size[1].max(1) as f32;
    let ndc = [pointer.x * 2.0 - 1.0, 1.0 - pointer.y * 2.0];
    let ray = forward + right * (ndc[0] * half_height * aspect) + up * (ndc[1] * half_height);
    if ray.y >= -f32::EPSILON {
        return [0.0, 0.0];
    }
    let reach = -camera.position.y / ray.y;
    let at = camera.position + ray * reach;
    clamp_to_arena([at.x, at.z], 0.0)
}

/// The game's camera.
pub fn camera() -> Camera {
    Camera::look_at(Vec3::from_array(CAMERA_EYE), Vec3::from_array(CAMERA_TARGET))
}

fn unit(v: [f32; 2]) -> Option<[f32; 2]> {
    let length = (v[0] * v[0] + v[1] * v[1]).sqrt();
    (length > 1e-4).then(|| [v[0] / length, v[1] / length])
}

fn distance(a: [f32; 2], b: [f32; 2]) -> f32 {
    let (dx, dz) = (a[0] - b[0], a[1] - b[1]);
    (dx * dx + dz * dz).sqrt()
}

fn inside(at: [f32; 2]) -> bool {
    at[0].abs() <= ARENA_HALF[0] && at[1].abs() <= ARENA_HALF[1]
}

fn clamp_to_arena(at: [f32; 2], margin: f32) -> [f32; 2] {
    let [hx, hz] = ARENA_HALF;
    [at[0].clamp(-hx + margin, hx - margin), at[1].clamp(-hz + margin, hz - margin)]
}

fn on_floor(at: [f32; 2], height: f32) -> Vec3 {
    Vec3::new(at[0], height, at[1])
}

/// The draw hook: floor, grid, walls, ship and its aim, shots and drones.
pub fn draw(sim: &Sim<World>, frame: &mut Frame, _camera: &Camera) {
    let world = &sim.world;
    let [hx, hz] = ARENA_HALF;
    frame.tag("arena").cube(Transform::from_xyz(0.0, -0.1, 0.0).with_scale(Vec3::new(hx * 2.0, 0.2, hz * 2.0)), FLOOR);
    for step in -6..=6 {
        let x = step as f32 * hx / 6.0;
        frame.cube(Transform::from_xyz(x, 0.01, 0.0).with_scale(Vec3::new(0.04, 0.02, hz * 2.0)), GRID);
    }
    for step in -4..=4 {
        let z = step as f32 * hz / 4.0;
        frame.cube(Transform::from_xyz(0.0, 0.01, z).with_scale(Vec3::new(hx * 2.0, 0.02, 0.04)), GRID);
    }
    let walls = [(0.0, -hz - 0.25, hx * 2.0 + 1.0, 0.5), (0.0, hz + 0.25, hx * 2.0 + 1.0, 0.5), (-hx - 0.25, 0.0, 0.5, hz * 2.0), (hx + 0.25, 0.0, 0.5, hz * 2.0)];
    for (x, z, sx, sz) in walls {
        frame.cube(Transform::from_xyz(x, 0.3, z).with_scale(Vec3::new(sx, 0.6, sz)), WALL);
    }
    let hurt_blink = world.hurt > 0 && (world.hurt / HURT_BLINK_TICKS).is_multiple_of(2);
    let ship = if hurt_blink { SHIP_HURT } else { SHIP };
    frame.tag("ship").sphere(on_floor(world.ship, SHIP_RADIUS), SHIP_RADIUS, ship);
    let mark = [world.ship[0] + world.aim[0] * 1.1, world.ship[1] + world.aim[1] * 1.1];
    frame.sphere(on_floor(mark, SHIP_RADIUS), 0.16, AIM_MARK);
    frame.tag("shots");
    for shot in &world.shots {
        frame.sphere(on_floor(shot.at, SHIP_RADIUS), SHOT_RADIUS, SHOT);
    }
    frame.tag("drones");
    for drone in &world.drones {
        frame.cube(Transform::from_translation(on_floor(*drone, DRONE_RADIUS)).with_scale(Vec3::splat(DRONE_RADIUS * 1.6)), DRONE);
    }
}

/// The `arena` probe: what a check reads to judge the mechanics (never the HUD's labels).
pub fn arena_probe(sim: &Sim<World>) -> Value {
    let world = &sim.world;
    json!({
        "ship": world.ship,
        "aim": world.aim,
        "hp": world.hp,
        "score": world.score,
        "dashes": world.dashes,
        "shotsFired": world.shots_fired,
        "shots": world.shots.len(),
        "drones": world.drones.len(),
        "paused": world.paused,
        "over": world.over,
        "ticks": world.ticks,
    })
}

/// The `prompts` probe (volatile, never checksummed): what the HUD showed.
pub fn prompts_probe(sim: &Sim<World>) -> Value {
    let shown = &sim.world.shown;
    json!({ "dash": shown.dash, "fire": shown.fire, "pause": shown.pause, "device": shown.device, "focused": shown.focused })
}
