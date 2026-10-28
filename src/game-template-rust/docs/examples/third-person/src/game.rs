//! A third-person character, distilled from the engine's characters example: a rigged hero on a
//! character capsule, moved relative to an orbit camera, with an animator graph (idle, walk and
//! run on a `speed` parameter; a slash on the upper body over the legs, with its `hit` event), and
//! a camera boom that pulls in when a wall comes between it and the hero.
//!
//! The camera's yaw and pitch belong to the camera, not the hero: the keys walk the hero along the
//! camera's ground directions and the controller turns the capsule to face where it walks (its
//! `turn_rate`). The boom is a ray from the hero's shoulders back to the eye, so the hero never
//! hides behind a pillar. Without `assets/characters/hero.glb` the hero is a stand-in block, so
//! the yard runs as soon as it is copied.
//!
//! Rename `CLIPS` to your GLB's clip names (`asset.clip_names()` lists them). Uthana makes a rigged,
//! animated character from a generated model.

use genex::{CharacterAsset, CharacterParams};
use genex::actions::{ActionId, Anchor, ContextId, ControlId, ShowWhen, StickMode};
use genex::animation::{BodyPart, EventId, FloatParam, Mask, Motion, TriggerParam};
use genex::math::{self, Vec3, vec3};
use genex::physics::{ColliderBuilder, QueryFilter, Ray, RigidBodyBuilder};
use genex::prelude::*;
use genex::render::Environment;

const PLAY: ContextId = ContextId::new("play");
const MOVE: ActionId = ActionId::new("move");
const LOOK: ActionId = ActionId::new("look");
const TURN: ActionId = ActionId::new("turn");
const RUN: ActionId = ActionId::new("run");
const JUMP: ActionId = ActionId::new("jump");
const ATTACK: ActionId = ActionId::new("attack");
const STICK: ControlId = ControlId::new("stick");
const SLASH: ControlId = ControlId::new("slash");

/// The hero's GLB under `assets/` and its clips: idle, walk, run and a one-shot attack.
const HERO_GLB: &str = "characters/hero.glb";
const CLIPS: [&str; 4] = ["Idle", "Walk", "Run", "Slash"];
/// Where the hero starts, and its walking and running speeds (m/s).
const SPAWN: Vec3 = vec3(0.0, 0.0, 6.0);
const WALK: f32 = 1.6;
const SPRINT: f32 = 4.2;
/// The animator walks above this speed and runs above the second.
const WALK_FROM: f32 = 0.2;
const RUN_FROM: f32 = 2.6;
/// Radians per pixel of mouse (or finger) movement, and per second of full stick.
const MOUSE_TURN: f32 = 0.004;
const PAD_TURN: f32 = 2.4;
/// The camera's tilt range (down negative) and where it starts.
const PITCH_RANGE: (f32, f32) = (-1.1, 0.35);
const PITCH_START: f32 = -0.28;
/// The boom: its pivot above the feet, its length, how close a wall may pull it, the gap it keeps
/// from a wall, and how fast it lets out again (per second).
const PIVOT: f32 = 1.5;
const BOOM: f32 = 4.5;
const BOOM_MIN: f32 = 0.6;
const BOOM_GAP: f32 = 0.25;
const BOOM_EASE: f32 = 3.0;
const FOVY: f32 = 60.0;
/// The hero's draw id: one key that stays with it, so TAA follows it.
const HERO_ID: u64 = 0x4845_524f;

/// The yard's boxes (min, max): ground, a wall, pillars, a step and a low block. Each is drawn and
/// is a fixed collider, so the capsule and the boom both meet what the picture shows.
const BOXES: [(Vec3, Vec3); 8] = [
    (vec3(-16.0, -0.5, -16.0), vec3(16.0, 0.0, 16.0)),
    (vec3(-10.0, 0.0, -8.5), vec3(10.0, 3.5, -8.0)),
    (vec3(-5.4, 0.0, -0.4), vec3(-4.6, 3.0, 0.4)),
    (vec3(4.6, 0.0, -0.4), vec3(5.4, 3.0, 0.4)),
    (vec3(-0.4, 0.0, 2.6), vec3(0.4, 3.0, 3.4)),
    (vec3(-3.0, 0.0, -4.0), vec3(3.0, 0.25, -2.0)),
    (vec3(-2.0, 0.25, -4.0), vec3(2.0, 0.5, -2.8)),
    (vec3(7.0, 0.0, 5.0), vec3(9.0, 1.0, 7.0)),
];
/// A 15° ramp up onto the low block (its north end high): centre, half extents.
const RAMP_AT: Vec3 = vec3(8.0, 0.35, 9.3);
const RAMP_HALF: Vec3 = vec3(1.0, 0.1, 2.4);
const RAMP_DEGREES: f32 = 15.0;

/// The graph's parameters and the attack clip's `hit` event.
#[derive(Clone, Copy)]
struct Rig {
    speed: FloatParam,
    attack: TriggerParam,
    hit: EventId,
}

/// Everything the simulation owns. Every seed rebuilds it from `World::default()`.
#[derive(Default)]
pub struct World {
    pub tick: u64,
    hero: Option<Character>,
    animator: Option<Animator>,
    rig: Option<Rig>,
    /// The camera's turn about +y (0 looks along -z) and tilt (up positive).
    pub yaw: f32,
    pub pitch: f32,
    /// The boom's length this tick (shorter than `BOOM` while a wall is behind the hero).
    pub boom: f32,
    /// The finger dragging the view, and where it was last tick.
    drag: Option<(u32, Vec2)>,
    /// Attacks started and the `hit` events their clips reached.
    pub attacks: u32,
    pub hits: u32,
}

impl World {
    /// Where the hero's feet are.
    pub fn feet(&self) -> Vec3 {
        self.hero.as_ref().map_or(SPAWN, Character::feet)
    }

    /// The camera's look direction (unit), from its yaw and pitch.
    fn look_dir(&self) -> Vec3 {
        let (sp, cp) = math::sin_cos(self.pitch);
        let (sy, cy) = math::sin_cos(self.yaw);
        vec3(-sy * cp, sp, -cy * cp)
    }

    /// The orbit camera: behind and above the hero's shoulders, `boom` metres back.
    pub fn camera(&self) -> Camera {
        let pivot = self.feet() + Vec3::Y * PIVOT;
        let eye = pivot - self.look_dir() * self.boom;
        Camera { fovy: FOVY, ..Camera::look_at(eye, pivot) }
    }
}

fn actions() -> ActionMap {
    let play = Context::new(PLAY, 0)
        .axis2(MOVE, &[Binding::WASD, Binding::Stick(Stick::Left), Binding::Touch(STICK)])
        .axis2(LOOK, &[Binding::Look])
        .axis2(TURN, &[Binding::Stick(Stick::Right)])
        .button(RUN, &[Key::ShiftLeft.into(), Binding::Pad(PadButton::LeftStickPress)])
        .button(JUMP, &[Key::Space.into(), Binding::Pad(PadButton::South)])
        .button(ATTACK, &[Key::Mouse1.into(), Binding::Pad(PadButton::West), Binding::Touch(SLASH)]);
    ActionMap::new().context(play)
}

/// Register every hook.
pub fn wire(game: &mut Game<World>) {
    game.input(actions());
    game.touch_controls(
        TouchControls::new()
            .stick(STICK, Anchor::BottomLeft([150.0, 150.0]), 70.0, StickMode::Floating)
            .button(SLASH, "Slash", Anchor::BottomRight([130.0, 150.0]), 52.0)
            .show(ShowWhen::Touch),
    );
    game.on_reset(|sim, _seed, _rng, gfx| {
        let (world, physics) = sim.split();
        for (min, max) in BOXES {
            let half = (max - min) * 0.5;
            physics.insert(RigidBodyBuilder::fixed().translation(min + half), ColliderBuilder::cuboid(half.x, half.y, half.z));
        }
        let tilt = vec3(-RAMP_DEGREES.to_radians(), 0.0, 0.0);
        physics.insert(RigidBodyBuilder::fixed().translation(RAMP_AT).rotation(tilt), ColliderBuilder::cuboid(RAMP_HALF.x, RAMP_HALF.y, RAMP_HALF.z));
        world.hero = Character::spawn(physics, SPAWN, CharacterParams::default()).ok();
        world.pitch = PITCH_START;
        world.boom = BOOM;
        // A missing or refused GLB leaves the stand-in: probe it, never panic.
        if let Some((animator, rig)) = gfx.character(HERO_GLB).ok().and_then(|asset| rig(&asset)) {
            world.animator = Some(animator);
            world.rig = Some(rig);
        }
    });
    game.on_update(update);
    game.on_draw(|sim, frame, _camera| draw(&sim.world, frame));
    game.on_ui(|_sim, ui, _ctx| {
        ui.label(egui::RichText::new("WASD walk · Shift run · Space jump · mouse orbit · click slash").color(egui::Color32::WHITE));
    });
    game.camera(|sim| sim.world.camera());
    game.named_camera("yard", |_| Camera::look_at(vec3(12.0, 9.0, 16.0), vec3(0.0, 0.5, 0.0)));
    game.player(|sim| {
        let at = sim.world.feet();
        json!({ "x": at.x, "z": at.z, "yaw": sim.world.yaw, "pitch": sim.world.pitch })
    });
    game.probe("hero", |sim| {
        let world = &sim.world;
        let hero = world.hero.as_ref();
        json!({
            "speed": hero.map_or(0.0, |h| h.velocity().length()),
            "grounded": hero.is_some_and(Character::grounded),
            "boom": world.boom,
            "attacks": world.attacks,
            "hits": world.hits,
            "anim": world.animator.as_ref().map(Animator::probe),
        })
    });
    // A walk the generic checks cannot make: forward round the near pillar, then a slash.
    game.demo("walk-and-slash", |d| {
        d.inject(Input::key_down(Key::KeyW));
        d.advance_ms(1500);
        d.inject(Input::look(200.0, 0.0));
        d.advance_ms(1000);
        d.inject(Input::key_up(Key::KeyW));
        d.inject(Input::key_down(Key::Mouse1));
        d.advance_ms(50);
        d.inject(Input::key_up(Key::Mouse1));
        d.advance_ms(1000);
        json!({ "hits": d.sim().world.hits })
    });
}

/// The hero's graph: idle, walk and run on `speed`; a slash on the upper body on `attack`.
fn rig(asset: &CharacterAsset) -> Option<(Animator, Rig)> {
    let [idle, walk, run, slash] = CLIPS.map(|name| asset.clip(name));
    let (idle, walk, run, slash) = (idle?, walk?, run?, slash?);
    let mut g = asset.graph();
    let speed = g.float("speed", 0.0);
    let attack = g.trigger("attack");
    let base = g.layer("base");
    let idling = g.state(base, "idle", Motion::clip(idle));
    let walking = g.state(base, "walk", Motion::clip(walk));
    let running = g.state(base, "run", Motion::clip(run));
    g.transition(idling, walking).when(speed.above(WALK_FROM)).inertialize(0.2);
    g.transition(walking, idling).when(speed.below(WALK_FROM)).inertialize(0.25);
    g.transition(walking, running).when(speed.above(RUN_FROM)).crossfade(0.25);
    g.transition(running, walking).when(speed.below(RUN_FROM)).crossfade(0.25);
    // The slash plays on the upper body only, so the legs keep walking under it.
    let upper = g.layer("upper");
    g.layer_mask(upper, Mask::Humanoid(BodyPart::UpperBody));
    let none = g.state(upper, "none", Motion::Empty);
    let swing = g.state(upper, "slash", Motion::clip(slash).once());
    g.transition(none, swing).when(attack.fired()).crossfade(0.1);
    g.transition(swing, none).at_end().crossfade(0.2);
    let hit = g.event(slash, 0.3, "hit");
    let graph = g.build().ok()?;
    Some((asset.animator(&graph).ok()?, Rig { speed, attack, hit }))
}

/// Orbit the camera, walk the capsule along the camera's ground directions, play the rig, and
/// pull the boom in against walls.
fn update(sim: &mut Sim<World>, ctx: &Ctx<'_>) {
    let (world, physics) = sim.split();
    world.tick = ctx.tick + 1;
    let turn = (ctx.actions.axis2(LOOK) + drag(world, ctx)) * MOUSE_TURN + ctx.actions.axis2(TURN) * PAD_TURN * ctx.dt;
    world.yaw -= turn.x;
    world.pitch = (world.pitch - turn.y).clamp(PITCH_RANGE.0, PITCH_RANGE.1);
    let Some(hero) = world.hero.as_mut() else { return };
    let (sy, cy) = math::sin_cos(world.yaw);
    let (forward, right) = (vec3(-sy, 0.0, -cy), vec3(cy, 0.0, -sy));
    let walk = ctx.actions.axis2(MOVE).clamp_length_max(1.0);
    let pace = if ctx.actions.down(RUN) { SPRINT } else { WALK };
    let wish = (right * walk.x - forward * walk.y) * pace;
    hero.drive(physics, CharacterMotion::Velocity { wish, jump: ctx.actions.pressed(JUMP) }, ctx.dt);
    let speed = vec2(hero.velocity().x, hero.velocity().z).length();
    let exclude = hero.body().map_or(QueryFilter::default(), |body| QueryFilter::default().exclude_rigid_body(body));
    if let (Some(animator), Some(rig)) = (world.animator.as_mut(), world.rig) {
        animator.set_float(rig.speed, speed);
        if ctx.actions.pressed(ATTACK) {
            animator.fire(rig.attack);
            world.attacks += 1;
        }
        let step = animator.update(ctx.dt);
        world.hits += step.events.iter().filter(|event| event.event == rig.hit).count() as u32;
    }
    // The boom: snap in at once when a wall is behind the hero, let out slowly once it is clear.
    let pivot = world.feet() + Vec3::Y * PIVOT;
    let back = -world.look_dir();
    let free = physics.cast_ray(&Ray::new(pivot, back), BOOM, true, exclude).map_or(BOOM, |(_, toi)| (toi - BOOM_GAP).max(BOOM_MIN));
    world.boom = if free < world.boom { free } else { world.boom + (free - world.boom) * (BOOM_EASE * ctx.dt).min(1.0) };
}

/// The view a free finger dragged this tick, in pixels (one finger at a time).
fn drag(world: &mut World, ctx: &Ctx<'_>) -> Vec2 {
    let finger = ctx.actions.free_touches().find(|touch| world.drag.is_none_or(|(id, _)| id == touch.id)).copied();
    let Some(touch) = finger else {
        world.drag = None;
        return Vec2::ZERO;
    };
    let moved = world.drag.map_or(Vec2::ZERO, |(_, last)| touch.position - last);
    let lifted = matches!(touch.phase, genex::TouchPhase::Ended | genex::TouchPhase::Tapped);
    world.drag = (!lifted).then_some((touch.id, touch.position));
    moved
}

fn draw(world: &World, frame: &mut Frame) {
    frame.clear(Color::rgb(150, 182, 220)).ambient(Color::rgb(170, 190, 220), 0.3);
    frame.sun(vec3(-0.45, 0.7, 0.55), Color::WHITE, 3.0).environment(Environment::sky());
    frame.tag("yard");
    let ground = Material::color(Color::rgb(118, 128, 104)).with_roughness(0.95);
    let stone = Material::color(Color::rgb(160, 150, 136)).with_roughness(0.85);
    for (index, (min, max)) in BOXES.into_iter().enumerate() {
        let material = if index == 0 { &ground } else { &stone };
        frame.cube_with(Transform::from_translation((min + max) * 0.5).with_scale(max - min), material);
    }
    let ramp = Transform::from_translation(RAMP_AT).with_scale(RAMP_HALF * 2.0).with_rotation(Quat::from_rotation_x(-RAMP_DEGREES.to_radians()));
    frame.cube_with(ramp, &stone);
    let Some(hero) = &world.hero else { return };
    let at: Transform = hero.transform().into();
    frame.tag("hero").id(HERO_ID);
    if let Some(animator) = &world.animator {
        frame.character(animator, at);
    } else {
        // The stand-in: a body and a nose that shows which way it faces.
        let body = Material::color(Color::rgb(200, 120, 110)).with_roughness(0.6);
        frame.cube_with(Transform::from_translation(at.translation + Vec3::Y * 0.9).with_rotation(at.rotation).with_scale(vec3(0.6, 1.8, 0.4)), &body);
        let nose = at.translation + Vec3::Y * 1.5 + at.rotation * Vec3::Z * 0.3;
        frame.cube_with(Transform::from_translation(nose).with_rotation(at.rotation).with_scale(Vec3::splat(0.18)), &body);
    }
    frame.end_id();
}
