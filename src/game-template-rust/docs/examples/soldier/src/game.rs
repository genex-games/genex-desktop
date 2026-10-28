//! The soldier kit's entry owner: a yard with cover, a sun and a sky, and a scripted soldier whose
//! state is exactly what a network game replicates for a remote player (`SoldierNet`). A
//! deterministic script plays the server: it walks, runs, strafes, backs off, crouches, sweeps its
//! aim up and down, fires, reloads, takes hits from each side and dies, then respawns. The
//! `soldier.rs` facet animates the kit from that state alone. The game camera frames the soldier
//! close, so every animation can be seen; `side` and `yard` are named cameras.

use genex::math::{self, Vec3, vec3};
use genex::prelude::*;
use genex::render::Environment;

/// What the network carries for one soldier, and all the animation reads. Counters, not events:
/// a lost or late packet still shows the shot, the reload or the hit once.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SoldierNet {
    pub pos: Vec3,
    pub vel: Vec3,
    /// Facing about +y (0 along +x) and the aim's tilt (up positive), radians.
    pub yaw: f32,
    pub pitch: f32,
    pub crouch: bool,
    pub shots: u32,
    pub reloads: u32,
    pub hits: u32,
    /// The world yaw the latest hit came from.
    pub hit_from: f32,
    pub hp: f32,
}

/// The script's phases and how long each lasts (s); the kit's tests and captures seek them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Idle,
    Walk,
    Run,
    StrafeLeft,
    StrafeRight,
    Back,
    Crouch,
    AimSweep,
    Fire,
    Reload,
    Hits,
    Death,
}

pub const PHASES: [(Phase, f32); 12] = [
    (Phase::Idle, 2.0),
    (Phase::Walk, 2.5),
    (Phase::Run, 2.0),
    (Phase::StrafeLeft, 2.0),
    (Phase::StrafeRight, 2.0),
    (Phase::Back, 2.0),
    (Phase::Crouch, 2.5),
    (Phase::AimSweep, 4.0),
    (Phase::Fire, 2.0),
    (Phase::Reload, 2.6),
    (Phase::Hits, 2.4),
    (Phase::Death, 3.5),
];

/// Speeds (m/s) the script moves at, and the aim's sweep (radians).
const WALK: f32 = 1.3;
const RUN: f32 = 4.0;
const STRAFE: f32 = 1.2;
const BACK: f32 = 1.0;
const CROUCH_WALK: f32 = 0.9;
const SWEEP: f32 = 0.5;
/// Rounds a second while firing, and full health.
const ROUNDS_EVERY_TICKS: u64 = 6;
pub const HEALTH: f32 = 100.0;
/// Where the soldier starts, facing +z.
const START: Vec3 = vec3(0.0, 0.0, 0.0);
const FACING: f32 = std::f32::consts::FRAC_PI_2;

/// The yard's boxes (min, max): the ground and some cover.
const BOXES: [(Vec3, Vec3); 4] = [
    (vec3(-15.0, -0.5, -15.0), vec3(15.0, 0.0, 15.0)),
    (vec3(-6.0, 0.0, 6.0), vec3(-3.0, 1.1, 6.6)),
    (vec3(3.5, 0.0, -4.0), vec3(4.3, 2.2, -1.0)),
    (vec3(-14.0, 0.0, 14.0), vec3(14.0, 3.0, 15.0)),
];

/// Everything the simulation owns.
#[derive(Default)]
pub struct World {
    pub tick: u64,
    /// The remote soldier as the last packet left it.
    pub soldier: SoldierNet,
    /// The script stops writing `soldier` (a demo, or a game's own network code, writes it).
    pub paused: bool,
}

/// The phase at `seconds` into the script's loop, and the seconds into that phase.
pub fn phase_at(seconds: f32) -> (Phase, f32) {
    let length: f32 = PHASES.iter().map(|(_, s)| s).sum();
    let mut t = seconds % length;
    for (phase, span) in PHASES {
        if t < span {
            return (phase, t);
        }
        t -= span;
    }
    (Phase::Idle, 0.0)
}

/// The server's tick: where the scripted soldier goes and what it does, written into `SoldierNet`.
fn serve(world: &mut World, dt: f32) {
    if world.paused {
        return;
    }
    let (phase, t) = phase_at(world.tick as f32 * dt);
    let net = &mut world.soldier;
    if world.tick == 0 || (phase == Phase::Idle && t < dt) {
        *net = SoldierNet { pos: START, yaw: FACING, hp: HEALTH, ..SoldierNet::default() };
    }
    let forward = vec3(math::cos(net.yaw), 0.0, math::sin(net.yaw));
    let right = vec3(-forward.z, 0.0, forward.x);
    net.crouch = phase == Phase::Crouch;
    net.vel = match phase {
        Phase::Walk => forward * WALK,
        Phase::Run => forward * RUN,
        Phase::StrafeLeft => -right * STRAFE,
        Phase::StrafeRight => right * STRAFE,
        Phase::Back => -forward * BACK,
        Phase::Crouch if t > 1.0 => forward * CROUCH_WALK,
        _ => Vec3::ZERO,
    };
    net.pos += net.vel * dt;
    net.pitch = if phase == Phase::AimSweep { SWEEP * math::sin(t / 4.0 * std::f32::consts::TAU) } else { 0.0 };
    let ticks = (t / dt) as u64;
    if phase == Phase::Fire && ticks.is_multiple_of(ROUNDS_EVERY_TICKS) && t < 1.5 {
        net.shots += 1;
    }
    if phase == Phase::Reload && ticks == 0 {
        net.reloads += 1;
    }
    if phase == Phase::Hits && ticks.is_multiple_of(36) {
        net.hits += 1;
        net.hit_from = net.yaw + std::f32::consts::FRAC_PI_2 * (net.hits % 4) as f32;
        net.hp = (net.hp - 10.0).max(1.0);
    }
    if phase == Phase::Death {
        net.hp = 0.0;
    }
}

/// Register the entry owner's hooks.
pub fn wire(game: &mut Game<World>) {
    game.on_update(|sim, ctx| {
        sim.world.tick = ctx.tick;
        serve(&mut sim.world, ctx.dt);
    });
    game.on_draw(|_sim, frame, _camera| draw(frame));
    game.camera(|sim| close(&sim.world.soldier, 2.8, 0.9));
    game.named_camera("side", |sim| close(&sim.world.soldier, 3.2, 2.2));
    game.named_camera("yard", |_| Camera::look_at(vec3(-9.0, 6.0, -9.0), vec3(0.0, 0.5, 2.0)));
    game.player(|sim| {
        let net = sim.world.soldier;
        json!({ "x": net.pos.x, "z": net.pos.z, "yaw": net.yaw, "pitch": net.pitch, "hp": net.hp, "phase": format!("{:?}", phase_at(sim.world.tick as f32 / 60.0).0) })
    });
}

/// A camera `distance` in front of the soldier and `aside` to its left, at chest height: the
/// soldier fills the frame from the knees up.
pub fn close(net: &SoldierNet, distance: f32, aside: f32) -> Camera {
    let forward = vec3(math::cos(net.yaw), 0.0, math::sin(net.yaw));
    let left = vec3(forward.z, 0.0, -forward.x);
    let chest = net.pos + Vec3::Y * 1.15;
    let eye = chest + forward * distance + left * aside + Vec3::Y * 0.25;
    Camera { fovy: 45.0, ..Camera::look_at(eye, chest) }
}

/// The yard under a low sun.
fn draw(frame: &mut Frame) {
    frame.clear(Color::rgb(120, 140, 160)).ambient(Color::rgb(170, 185, 210), 0.25);
    frame.sun(vec3(0.5, 0.7, -0.4), Color::WHITE, 3.0).environment(Environment::sky());
    frame.tag("yard");
    let ground = Material::color(Color::rgb(140, 132, 118)).with_roughness(0.9);
    for (min, max) in BOXES {
        frame.cube_with(Transform::from_translation((min + max) * 0.5).with_scale(max - min), &ground);
    }
}
