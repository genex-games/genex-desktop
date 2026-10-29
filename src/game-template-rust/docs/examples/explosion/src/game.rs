//! GREYBOX: replace the barrel and the crates (primitives) with models before done.
//! Copy the blast's timing, particles, flash, sound, impulse and shake.
//!
//! An explosion: a barrel in a yard of crates goes off on a key, a pad button or a tap, and the
//! blast is six parts on the same tick: a fireball (an emissive sphere that swells and dies, with
//! fire particles), sparks that fall and bounce, a smoke cloud that thins out, a point light's
//! flash, the bang played where it happened, a radial impulse that throws the crates, and a shake
//! of the camera. A new barrel stands in the same spot a few seconds later.
//!
//! Particles are a pure function of their emitter and the tick, never of earlier frames, so an
//! emitter cannot start at a moment: a burst is an emitter drawn only while the blast is young.
//! Each part is made once at reset and drawn by the blast's age, and the smoke thins by drawing
//! ever sparser emitters, never by making a new one each frame. Everything on screen derives from
//! the tick the blast went off, so a capture of any tick shows the same blast.
//!
//! Without `assets/sfx/explosion.wav` the bang is silence and the `blast` probe says
//! `"sound": false`; the picture is the same.

use genex::Particles;
use genex::actions::{ActionId, Anchor, ContextId, ControlId, ShowWhen};
use genex::math::{self, Vec3, vec3};
use genex::physics::{Ball, ColliderBuilder, Pose, QueryFilter, RigidBodyBuilder, RigidBodyHandle};
use genex::prelude::*;
use genex::render::Environment;

const PLAY: ContextId = ContextId::new("play");
const DETONATE: ActionId = ActionId::new("detonate");
const BOOM: ControlId = ControlId::new("boom");

/// The bang under `assets/`.
const SOUND: &str = "sfx/explosion.wav";
/// Where the barrel stands, its half height and radius, and the ticks before a new one stands there.
const BARREL: Vec3 = vec3(0.0, 0.6, 0.0);
const BARREL_SIZE: (f32, f32) = (0.6, 0.4);
const REARM_TICKS: u64 = 300;
/// The blast's reach (m) and the change of velocity it gives a body at its centre (m/s).
const REACH: f32 = 7.0;
const STRENGTH: f32 = 14.0;
/// The fireball: its largest radius, the tick it reaches it and the tick it is gone; its glow.
const FIREBALL_RADIUS: f32 = 2.2;
const FIREBALL_PEAK: u64 = 8;
const FIREBALL_END: u64 = 26;
const FIREBALL_GLOW: f32 = 40.0;
/// The flash: a point light this bright and this far-reaching, gone after this many ticks.
const FLASH: f32 = 60.0;
const FLASH_RANGE: f32 = 22.0;
const FLASH_TICKS: u64 = 30;
/// Ticks each particle part is drawn for: the fire, the sparks and each stage of the smoke.
const FIRE_TICKS: u64 = 16;
const SPARK_TICKS: u64 = 40;
const SMOKE_FROM: u64 = 6;
const SMOKE_STAGE_TICKS: u64 = 70;
/// How hard the camera shakes (m and radians at full trauma) and how fast the trauma fades (a second).
const SHAKE: f32 = 0.35;
const SHAKE_FADE: f32 = 1.4;
/// The crates: a ring round the barrel and a second layer on half of them, 0.8 m each.
const CRATE_HALF: f32 = 0.4;
const RING: (usize, f32) = (10, 3.2);
const CRATE_COLOR: Color = Color::rgb(170, 120, 70);
/// Draw ids: the barrel, and one per crate from its handle.
const BARREL_ID: u64 = 0x4241_5252;

/// The blast that went off last: where, which tick, how many bodies it pushed.
#[derive(Clone, Copy)]
struct Blast {
    at: Vec3,
    tick: u64,
    pushed: usize,
}

/// The blast's particle parts, made once at reset.
struct Effects {
    fire: Particles,
    sparks: Particles,
    smoke: [Particles; 3],
}

/// Everything the simulation owns. Every seed rebuilds it from `World::default()`.
#[derive(Default)]
pub struct World {
    tick: u64,
    barrel: Option<RigidBodyHandle>,
    crates: Vec<RigidBodyHandle>,
    blast: Option<Blast>,
    detonations: u32,
    /// The camera's shake, 1 at a blast fading to 0.
    trauma: f32,
    sound: Option<Sound>,
    effects: Option<Effects>,
}

impl World {
    /// Ticks since the last blast, while it is still drawing.
    fn age(&self) -> Option<u64> {
        self.blast.map(|blast| self.tick.saturating_sub(blast.tick))
    }

    /// The camera: across the yard at the barrel, shaken by the trauma (its square, so a small
    /// trauma barely moves it). The shake is a sum of sines of the tick: smooth and repeatable.
    pub fn camera(&self) -> Camera {
        let (eye, target) = (vec3(0.0, 4.0, 12.0), vec3(0.0, 1.2, 0.0));
        let t = self.tick as f32;
        let shake = self.trauma * self.trauma * SHAKE;
        let wobble = vec3(math::sin(t * 1.9) + math::sin(t * 0.7), math::sin(t * 2.3 + 1.0), math::sin(t * 1.3 + 2.0)) * shake;
        Camera { fovy: 55.0, ..Camera::look_at(eye + wobble * 0.5, target + wobble) }
    }
}

/// Register every hook.
pub fn wire(game: &mut Game<World>) {
    game.input(ActionMap::new().context(Context::new(PLAY, 0).button(DETONATE, &[Key::Space.into(), Binding::Pad(PadButton::South), Binding::Touch(BOOM)])));
    game.touch_controls(TouchControls::new().button(BOOM, "Boom", Anchor::BottomRight([130.0, 150.0]), 60.0).show(ShowWhen::Touch));
    game.on_reset(|sim, _seed, _rng, gfx| {
        let (world, physics) = sim.split();
        physics.insert(RigidBodyBuilder::fixed().translation(vec3(0.0, -0.5, 0.0)), ColliderBuilder::cuboid(30.0, 0.5, 30.0).friction(0.8));
        physics.insert(RigidBodyBuilder::fixed().translation(vec3(0.0, 2.0, -9.0)), ColliderBuilder::cuboid(12.0, 2.0, 0.4));
        for index in 0..RING.0 {
            let angle = index as f32 / RING.0 as f32 * std::f32::consts::TAU;
            let foot = vec3(RING.1 * math::cos(angle), CRATE_HALF, RING.1 * math::sin(angle));
            let layers = if index % 2 == 0 { 2 } else { 1 };
            for layer in 0..layers {
                let at = foot + Vec3::Y * (layer as f32 * 2.0 * CRATE_HALF);
                let collider = ColliderBuilder::cuboid(CRATE_HALF, CRATE_HALF, CRATE_HALF).mass(15.0).friction(0.7);
                world.crates.push(physics.insert(RigidBodyBuilder::dynamic().translation(at).rotation(vec3(0.0, angle, 0.0)), collider).0);
            }
        }
        world.barrel = Some(barrel(physics));
        world.sound = Some(gfx.sound(SOUND));
        world.effects = effects(BARREL - Vec3::Y * BARREL_SIZE.0);
    });
    game.on_update(update);
    game.on_draw(|sim, frame, _camera| draw(sim, frame));
    game.on_ui(|_sim, ui, _ctx| {
        ui.label(egui::RichText::new("Space or Boom: set the barrel off").color(egui::Color32::WHITE).size(18.0));
    });
    game.camera(|sim| sim.world.camera());
    game.named_camera("close", |_| Camera::look_at(vec3(6.0, 2.2, 5.0), vec3(0.0, 1.0, 0.0)));
    game.probe("blast", |sim| {
        let world = &sim.world;
        // How far the crates lie from the barrel's spot on average: the ring's radius until a blast.
        let crates: Vec<Vec3> = world.crates.iter().filter_map(|handle| sim.physics.bodies.get(*handle)).map(|body| body.translation()).collect();
        let spread = crates.iter().map(|at| vec2(at.x - BARREL.x, at.z - BARREL.z).length()).sum::<f32>() / crates.len().max(1) as f32;
        json!({
            "detonations": world.detonations,
            "armed": world.barrel.is_some(),
            "age": world.age(),
            "pushed": world.blast.map_or(0, |blast| blast.pushed),
            "flash": world.age().map_or(0.0, flash),
            "trauma": world.trauma,
            "spread": spread,
            "sound": world.sound.as_ref().is_some_and(|sound| !sound.is_missing()),
        })
    });
    game.demo("boom", |d| {
        d.inject(Input::key_down(Key::Space));
        d.advance_ms(50);
        d.inject(Input::key_up(Key::Space));
        d.advance_ms(2000);
        json!({ "detonations": d.sim().world.detonations, "pushed": d.sim().world.blast.map_or(0, |blast| blast.pushed) })
    });
}

/// A barrel of 300 kg per cubic metre standing at [`BARREL`].
fn barrel(physics: &mut PhysicsWorld) -> RigidBodyHandle {
    physics.insert(RigidBodyBuilder::dynamic().translation(BARREL), ColliderBuilder::cylinder(BARREL_SIZE.0, BARREL_SIZE.1).density(300.0)).0
}

/// The fire, the sparks and three ever sparser smoke clouds, all rising from `ground`.
fn effects(ground: Vec3) -> Option<Effects> {
    let fire = Particles::fountain(ground + Vec3::Y)
        .with_origin(ground + Vec3::Y, Vec3::splat(0.6))
        .with_motion(vec3(0.0, 0.05, 0.0), 0.09, Vec3::ZERO)
        .with_look(0.9, 2.4, Color::rgb(255, 200, 90), Color::rgb(140, 30, 10))
        .with_rate(30, 16)
        .ok()?;
    let sparks = Particles::fountain(ground + Vec3::Y * 0.8)
        .with_motion(vec3(0.0, 0.14, 0.0), 0.16, vec3(0.0, -0.007, 0.0))
        .with_look(0.07, 0.4, Color::rgb(255, 240, 180), Color::rgb(255, 120, 30))
        .with_shape(2.5, 0.0, 0.0)
        .with_collision(0.3, 20)
        .with_rate(12, 50)
        .ok()?;
    let cloud = Particles::steam(ground + Vec3::Y * 1.5)
        .with_origin(ground + Vec3::Y * 1.5, vec3(1.4, 0.8, 1.4))
        .with_motion(vec3(0.0, 0.012, 0.0), 0.015, Vec3::ZERO)
        .with_look(1.8, 2.2, Color::rgb(70, 66, 62), Color::rgb(150, 146, 140))
        .with_soft(0.8)
        .with_sorted(true);
    let smoke = [cloud.with_rate(10, 120).ok()?, cloud.with_rate(5, 120).ok()?, cloud.with_rate(2, 120).ok()?];
    Some(Effects { fire, sparks, smoke })
}

/// The flash's intensity `age` ticks after the blast: full at once, falling off as a square.
fn flash(age: u64) -> f32 {
    let left = 1.0 - (age as f32 / FLASH_TICKS as f32).min(1.0);
    FLASH * left * left
}

/// Push every dynamic body within `radius` of `at` away from it, harder the closer it is: a change
/// of velocity of up to `strength` m/s. Answers how many bodies it pushed (`docs/api/physics.md`).
fn explode(physics: &mut PhysicsWorld, at: Vec3, radius: f32, strength: f32) -> usize {
    let near: Vec<RigidBodyHandle> = physics
        .intersect_shape(Pose::from_translation(at), &Ball::new(radius), QueryFilter::only_dynamic())
        .filter_map(|(_, collider)| collider.parent())
        .collect();
    for handle in &near {
        let Some(body) = physics.bodies.get_mut(*handle) else { continue };
        let away = body.translation() - at;
        let falloff = 1.0 - (away.length() / radius).min(1.0);
        let push = (away.normalize_or_zero() + Vec3::Y * 0.5) * strength * falloff * body.mass();
        body.apply_impulse(push, true);
    }
    near.len()
}

fn update(sim: &mut Sim<World>, ctx: &Ctx<'_>) {
    let (world, physics) = sim.split();
    world.tick = ctx.tick + 1;
    world.trauma = (world.trauma - SHAKE_FADE * ctx.dt).max(0.0);
    let rearmed = world.blast.is_some_and(|blast| world.tick >= blast.tick + REARM_TICKS);
    if world.barrel.is_none() && rearmed {
        world.barrel = Some(barrel(physics));
    }
    let Some(handle) = world.barrel.filter(|_| ctx.actions.pressed(DETONATE)) else { return };
    // The blast goes off where the barrel is now (a crate may have knocked it), and the barrel is gone.
    let at = physics.bodies.get(handle).map_or(BARREL, |body| body.translation());
    physics.remove_body(handle);
    world.barrel = None;
    let pushed = explode(physics, at, REACH, STRENGTH);
    world.blast = Some(Blast { at, tick: world.tick, pushed });
    world.detonations += 1;
    world.trauma = 1.0;
    if let Some(sound) = &world.sound {
        ctx.audio.play_at(sound, at);
    }
}

/// A draw id that stays with one body: its handle's slot and generation.
fn body_id(handle: RigidBodyHandle) -> u64 {
    let (slot, generation) = handle.into_raw_parts();
    u64::from(slot) | (u64::from(generation) << 32)
}

fn draw(sim: &Sim<World>, frame: &mut Frame) {
    let world = &sim.world;
    frame.clear(Color::rgb(140, 160, 185)).ambient(Color::rgb(170, 185, 210), 0.25);
    frame.sun(vec3(0.4, 0.55, 0.5), Color::WHITE, 2.6).environment(Environment::sky());
    let box_at = |center: Vec3, half: Vec3| Transform::from_translation(center).with_scale(half * 2.0);
    frame.tag("yard").cube_with(box_at(vec3(0.0, -0.5, 0.0), vec3(30.0, 0.5, 30.0)), &Material::color(Color::rgb(120, 112, 98)).with_roughness(0.95));
    frame.cube_with(box_at(vec3(0.0, 2.0, -9.0), vec3(12.0, 2.0, 0.4)), &Material::color(Color::rgb(160, 150, 136)).with_roughness(0.85));
    frame.tag("crates");
    let wood = Material::color(CRATE_COLOR).with_roughness(0.8);
    for handle in &world.crates {
        let Some(body) = sim.physics.bodies.get(*handle) else { continue };
        let at = Transform::from_translation(body.translation()).with_rotation(*body.rotation()).with_scale(Vec3::splat(2.0 * CRATE_HALF));
        frame.id(body_id(*handle)).cube_with(at, &wood);
    }
    frame.end_id();
    if let Some(body) = world.barrel.and_then(|handle| sim.physics.bodies.get(handle)) {
        let at = Transform::from_translation(body.translation()).with_rotation(*body.rotation()).with_scale(vec3(2.0 * BARREL_SIZE.1, 2.0 * BARREL_SIZE.0, 2.0 * BARREL_SIZE.1));
        frame.tag("barrel").id(BARREL_ID).cube_with(at, &Material::color(Color::rgb(180, 40, 30)).with_roughness(0.5).with_metallic(0.6));
        frame.end_id();
    }
    let (Some(blast), Some(age), Some(effects)) = (world.blast, world.age(), world.effects.as_ref()) else { return };
    draw_blast(frame, blast, age, effects);
}

/// Every part of the blast at `age` ticks: each one's window, size and glow from the age alone.
fn draw_blast(frame: &mut Frame, blast: Blast, age: u64, effects: &Effects) {
    if age < FIREBALL_END {
        let grow = (age as f32 / FIREBALL_PEAK as f32).min(1.0);
        let fade = 1.0 - age.saturating_sub(FIREBALL_PEAK) as f32 / (FIREBALL_END - FIREBALL_PEAK) as f32;
        let radius = FIREBALL_RADIUS * math::sqrt(grow) * (0.4 + 0.6 * fade);
        let glow = Material::emissive(Color::rgb(255, 150, 50), FIREBALL_GLOW * fade * fade);
        frame.tag("fireball").sphere_with(blast.at + Vec3::Y * radius * 0.5, radius, &glow);
    }
    if age < FLASH_TICKS {
        // A light is not a draw and takes no tag: the `blast` probe's `flash` measures it.
        frame.point_light(blast.at + Vec3::Y * 1.5, FLASH_RANGE, Color::rgb(255, 180, 100), flash(age));
    }
    if age < FIRE_TICKS {
        frame.tag("fire").particles(&effects.fire);
    }
    if age < SPARK_TICKS {
        frame.tag("sparks").particles(&effects.sparks);
    }
    let stage = age.checked_sub(SMOKE_FROM).map(|after| (after / SMOKE_STAGE_TICKS) as usize);
    if let Some(cloud) = stage.and_then(|stage| effects.smoke.get(stage)) {
        frame.tag("smoke").particles(cloud);
    }
}
