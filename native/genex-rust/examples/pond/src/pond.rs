//! The pond's world and hooks.

use genex::math::{self, TAU};
use genex::physics::{ColliderBuilder, RigidBodyBuilder, RigidBodyHandle};
use genex::prelude::*;
use genex_audio::{FRAMES_PER_TICK, MIXER_RATE_HZ, Mixer, Sound};

/// Bait a seed starts with; a cast spends one.
pub const STARTING_BAIT: u32 = 3;
/// Ticks a floating bobber waits before a fish bites, at least and at most.
pub const BITE_WAIT_TICKS: (u32, u32) = (45, 150);
/// Where the game's camera looks from.
pub const CAMERA_EYE: [f32; 3] = [0.0, 9.0, 14.0];

/// The water surface height.
const WATER_LEVEL: f32 = 0.0;
/// Floaters dropped on every seed.
const FLOATERS: u32 = 6;
const FLOATER_RADIUS: f32 = 0.35;
const BOBBER_RADIUS: f32 = 0.2;
/// Buoyancy at full submersion, as a multiple of the body's weight.
const BUOYANCY: f32 = 2.2;
/// Water drag per unit of submersion, per second.
const WATER_DRAG: f32 = 2.5;
const GRAVITY: f32 = 9.81;
/// Ticks the line stays taut after a bite before the rod is idle again.
const REEL_TICKS: u32 = 30;
/// Where the rod's tip is, and how far out a cast lands (from the tip, toward -Z).
const ROD_TIP: [f32; 3] = [0.0, 2.6, 7.5];
const CAST_REACH: (f32, f32) = (3.0, 7.0);
/// The splash: a decaying noise burst.
const SPLASH_TICKS: usize = 12;
const SPLASH_DECAY_PER_SECOND: f32 = 18.0;
const SPLASH_GAIN: f32 = 0.6;
const STONE: Color = Color::rgb(128, 124, 116);
const WATER: Color = Color::rgb(38, 92, 128);
const GRASS: Color = Color::rgb(64, 112, 52);
const ROD: Color = Color::rgb(112, 74, 40);
const LINE: Color = Color::rgb(230, 230, 220);
const BOBBER: Color = Color::rgb(220, 40, 40);
const FLOATER_COLORS: [Color; 3] = [Color::rgb(232, 196, 64), Color::rgb(240, 240, 232), Color::rgb(96, 168, 96)];

/// The rod's state.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Rod {
    /// Nothing in the water.
    #[default]
    Idle,
    /// The bobber floats; a fish bites at `bite_at` (a tick).
    Cast {
        /// The tick the bite comes on.
        bite_at: u64,
    },
    /// A fish is on; the rod is idle again at `idle_at`.
    Bite {
        /// The tick the rod is idle again.
        idle_at: u64,
    },
}

impl Rod {
    fn phase(self) -> &'static str {
        match self {
            Rod::Idle => "idle",
            Rod::Cast { .. } => "cast",
            Rod::Bite { .. } => "bite",
        }
    }
}

/// The device-less mixer and the splash it plays (audio is a volatile probe, never checksummed).
pub struct Splash {
    mixer: Option<Mixer>,
    sound: Sound,
}

impl Default for Splash {
    fn default() -> Self {
        Splash { mixer: Mixer::deviceless().ok(), sound: splash_sound() }
    }
}

/// A decaying noise burst from a fixed LCG: the same samples on every target.
fn splash_sound() -> Sound {
    let frames = FRAMES_PER_TICK * SPLASH_TICKS;
    let mut state: u32 = 0x2545_f491;
    let samples: Vec<[f32; 2]> = (0..frames)
        .map(|i| {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let noise = (state >> 8) as f32 / (1u32 << 24) as f32 * 2.0 - 1.0;
            let seconds = i as f32 / MIXER_RATE_HZ as f32;
            let sample = noise * SPLASH_GAIN * math::exp(-SPLASH_DECAY_PER_SECOND * seconds);
            [sample, sample]
        })
        .collect();
    Sound::from_frames(MIXER_RATE_HZ, &samples)
}

/// The pond's world.
#[derive(Default)]
pub struct World {
    rim: Model,
    water: Model,
    rod: Rod,
    fish: u32,
    score: u32,
    bait: u32,
    casts: u32,
    bites: u32,
    floaters: Vec<RigidBodyHandle>,
    bobber: Option<RigidBodyHandle>,
    /// The shop button's centre as a fraction of the world, from the last UI pass (the shop demo
    /// clicks it).
    shop_button: Option<[f32; 2]>,
    /// The HUD's area in world pixels from the last UI pass: a tap there is for the HUD, not a cast.
    hud_area: Option<[f32; 4]>,
    splash: Splash,
}

fn spawn_floaters(world: &mut World, physics: &mut PhysicsWorld, rng: &mut Pcg32) {
    for i in 0..FLOATERS {
        let angle = TAU * i as f32 / FLOATERS as f32 + rng.range_f32(-0.3, 0.3);
        let distance = rng.range_f32(1.5, 4.0);
        let height = rng.range_f32(1.0, 3.0);
        let (sin, cos) = math::sin_cos(angle);
        let body = RigidBodyBuilder::dynamic().translation(vec3(cos * distance, height, sin * distance)).angular_damping(1.0);
        let (handle, _) = physics.insert(body, ColliderBuilder::ball(FLOATER_RADIUS).density(0.6).restitution(0.1));
        world.floaters.push(handle);
    }
}

fn reset(sim: &mut Sim<World>, seed: u32, rng: &mut Pcg32, gfx: &Gfx) {
    let (world, physics) = sim.split();
    world.rim = gfx.assets().model("pond.glb");
    world.water = gfx.assets().model("water.glb");
    world.bait = STARTING_BAIT;
    world.fish = 2 + seed % 3 + rng.below(3);
    // The pond bed, so nothing sinks for ever.
    physics.insert_collider(ColliderBuilder::cuboid(8.0, 0.5, 8.0).translation(vec3(0.0, -2.5, 0.0)), None);
    spawn_floaters(world, physics, rng);
}

/// Push every body in the water up by the part of it that is submerged, and drag it.
fn float(physics: &mut PhysicsWorld, handle: RigidBodyHandle, radius: f32) {
    let Some(body) = physics.bodies.get_mut(handle) else { return };
    let bottom = body.translation().y - radius;
    let submerged = ((WATER_LEVEL - bottom) / (2.0 * radius)).clamp(0.0, 1.0);
    body.reset_forces(false);
    if submerged > 0.0 {
        let mass = body.mass();
        let lift = vec3(0.0, mass * GRAVITY * BUOYANCY * submerged, 0.0);
        let drag = -body.linvel() * (mass * WATER_DRAG * submerged);
        body.add_force(lift + drag, true);
    }
}

fn cast(world: &mut World, physics: &mut PhysicsWorld, ctx: &Ctx) {
    if world.rod != Rod::Idle || world.bait == 0 {
        return;
    }
    world.bait -= 1;
    world.casts += 1;
    let reach = ctx.rng.range_f32(CAST_REACH.0, CAST_REACH.1);
    let drift = ctx.rng.range_f32(-1.5, 1.5);
    let at = vec3(ROD_TIP[0] + drift, 1.5, ROD_TIP[2] - reach);
    let body = RigidBodyBuilder::dynamic().translation(at).angular_damping(1.0);
    let (handle, _) = physics.insert(body, ColliderBuilder::ball(BOBBER_RADIUS).density(0.4));
    world.bobber = Some(handle);
    let wait = ctx.rng.range_i32(BITE_WAIT_TICKS.0 as i32, BITE_WAIT_TICKS.1 as i32);
    world.rod = Rod::Cast { bite_at: ctx.tick + u64::from(wait.unsigned_abs()) };
}

fn reel(world: &mut World, physics: &mut PhysicsWorld, tick: u64) {
    match world.rod {
        Rod::Cast { bite_at } if tick >= bite_at => {
            if world.fish > 0 {
                world.fish -= 1;
                world.score += 1;
                world.bites += 1;
                if let Some(mixer) = world.splash.mixer.as_mut() {
                    let _ = mixer.play(&world.splash.sound);
                }
            }
            world.rod = Rod::Bite { idle_at: tick + u64::from(REEL_TICKS) };
        }
        Rod::Bite { idle_at } if tick >= idle_at => {
            if let Some(bobber) = world.bobber.take() {
                physics.remove_body(bobber);
            }
            world.rod = Rod::Idle;
        }
        _ => {}
    }
}

fn tapped_outside_hud(world: &World, ctx: &Ctx) -> bool {
    let inside = |p: Vec2| world.hud_area.is_some_and(|[x0, y0, x1, y1]| p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1);
    ctx.touches.tapped() && ctx.touches.all().iter().any(|touch| !inside(touch.position))
}

fn update(sim: &mut Sim<World>, ctx: &Ctx) {
    let (world, physics) = sim.split();
    if ctx.keys.pressed(Key::Space) || tapped_outside_hud(world, ctx) {
        cast(world, physics, ctx);
    }
    reel(world, physics, ctx.tick);
    for handle in world.floaters.iter().copied() {
        float(physics, handle, FLOATER_RADIUS);
    }
    if let Some(bobber) = world.bobber {
        float(physics, bobber, BOBBER_RADIUS);
    }
    if let Some(mixer) = world.splash.mixer.as_mut() {
        mixer.tick();
    }
}

fn shop(sim: &mut Sim<World>, ui: &mut egui::Ui, ctx: &Ctx) {
    let world = &mut sim.world;
    ui.label(format!("Score {}   Bait {}", world.score, world.bait));
    let button = ui.add_enabled(world.score > 0, egui::Button::new("Buy bait"));
    if button.clicked() && world.score > 0 {
        world.score -= 1;
        world.bait += 1;
    }
    let area = ui.min_rect();
    world.hud_area = Some([area.min.x, area.min.y, area.max.x, area.max.y]);
    let center = button.rect.center();
    world.shop_button = Some([center.x / ctx.world_size[0] as f32, center.y / ctx.world_size[1] as f32]);
}

fn body_position(physics: &PhysicsWorld, handle: RigidBodyHandle) -> Option<Vec3> {
    physics.bodies.get(handle).map(|body| body.translation())
}

fn draw(sim: &Sim<World>, frame: &mut Frame, _camera: &Camera) {
    let world = &sim.world;
    frame.tag("ground").cube(Transform::from_xyz(0.0, -0.6, 0.0).with_scale(vec3(40.0, 1.0, 40.0)), GRASS);
    frame.tag("water").model_tinted(&world.water, Transform::from_xyz(0.0, -0.04, 0.0), WATER);
    frame.tag("pond").model_tinted(&world.rim, Transform::IDENTITY, STONE);
    frame.tag("floaters");
    for (i, handle) in world.floaters.iter().enumerate() {
        if let Some(at) = body_position(&sim.physics, *handle) {
            frame.sphere(at, FLOATER_RADIUS, FLOATER_COLORS[i % FLOATER_COLORS.len()]);
        }
    }
    let tip = Vec3::from_array(ROD_TIP);
    frame.tag("rod").cube(Transform::from_xyz(0.0, 1.3, 8.4).with_scale(vec3(0.12, 2.6, 0.12)), ROD);
    if let Some(at) = world.bobber.and_then(|bobber| body_position(&sim.physics, bobber)) {
        frame.tag("bobber").sphere(at, BOBBER_RADIUS, BOBBER).line(tip, at, LINE);
    }
}

fn floaters_probe(sim: &Sim<World>) -> Value {
    let heights: Vec<f32> =
        sim.world.floaters.iter().filter_map(|h| body_position(&sim.physics, *h)).map(|at| at.y).collect();
    let afloat = heights.iter().filter(|y| (**y - WATER_LEVEL).abs() < 2.0 * FLOATER_RADIUS).count();
    let mean = if heights.is_empty() { 0.0 } else { heights.iter().sum::<f32>() / heights.len() as f32 };
    json!({ "count": heights.len(), "afloat": afloat, "meanY": mean })
}

fn demos(game: &mut Game<World>) {
    game.demo("cast", |d| {
        d.inject(Input::key_tap(Key::Space));
        d.advance_ms(2000);
        json!({ "casts": d.sim().world.casts, "phase": d.sim().world.rod.phase() })
    });
    game.demo("shop", |d| {
        d.sim_mut().world.score = 2;
        d.advance_ms(50);
        let Some([x, y]) = d.sim().world.shop_button else { return json!({ "bought": false }) };
        let bait = d.sim().world.bait;
        // Press and release on separate ticks, as a person's click arrives.
        d.inject(Input::pointer(x, y).and(Input::key_down(Key::Mouse1)));
        d.advance_ms(17);
        d.inject(Input::key_up(Key::Mouse1));
        d.advance_ms(50);
        json!({ "bought": d.sim().world.bait > bait, "bait": d.sim().world.bait })
    });
}

/// Register every pond hook on `game`.
pub fn wire(game: &mut Game<World>) {
    game.on_reset(reset);
    game.on_update(update);
    game.on_ui(shop);
    game.on_draw(draw);
    game.camera(|_| Camera::look_at(Vec3::from_array(CAMERA_EYE), Vec3::ZERO));
    game.probe("fishing", |sim| {
        let w = &sim.world;
        json!({ "phase": w.rod.phase(), "score": w.score, "bait": w.bait, "casts": w.casts, "bites": w.bites, "fish": w.fish })
    });
    game.probe("floaters", floaters_probe);
    game.probe_volatile("audioLevel", |sim| {
        let level = sim.world.splash.mixer.as_ref().map(|m| m.level().reported()).unwrap_or_default();
        json!({ "available": sim.world.splash.mixer.is_some(), "rms": level.rms, "centroid": level.centroid })
    });
    demos(game);
}
