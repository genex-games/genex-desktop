//! The FPS set's entry owner: the action map, the player (a character capsule moved by the keys,
//! a pad or a touch stick), mouse look from the locked pointer, a chest-mounted camera moved by
//! `genex::camera::FirstPersonRig` (bob, roll, landings and recoil under the person's comfort
//! settings and the engine's caps), a greybox hall whose boxes are both drawn and Rapier colliders, and
//! the HUD. The facets add the rest: `viewmodel.rs` (forearms, gloves and a pistol from parts),
//! `weapon.rs` (hitscan against the colliders, recoil, impacts) and `enemy.rs` (a rigged enemy).
//!
//! The pointer is locked by the host, never by the game: on the web Live locks it on a click when
//! `studio.json` declares `game.mouseLook`. `ctx.look` carries the mouse's movement only while it
//! is locked (or when a check injects it), so apply it every tick; a finger the touch controls did
//! not take drags the view on a phone, and the right stick turns it on a pad.

use genex::actions::{ActionId, Anchor, ContextId, ControlId, ShowWhen, StickMode};
use genex::camera::{FirstPersonRig, RigStep};
use genex::math::{self, Vec3, vec3};
use genex::physics::{ColliderBuilder, QueryFilter, Ray, RigidBodyBuilder};
use genex::prelude::*;
use genex::render::Environment;
use genex::CharacterParams;

const PLAY: ContextId = ContextId::new("play");
/// The actions every facet reads (`super::FIRE` in a facet).
pub const MOVE: ActionId = ActionId::new("move");
pub const LOOK: ActionId = ActionId::new("look");
pub const TURN: ActionId = ActionId::new("turn");
pub const RUN: ActionId = ActionId::new("run");
pub const JUMP: ActionId = ActionId::new("jump");
pub const FIRE: ActionId = ActionId::new("fire");
pub const RELOAD: ActionId = ActionId::new("reload");
const STICK: ControlId = ControlId::new("stick");
const SHOOT: ControlId = ControlId::new("shoot");

/// Radians per pixel of mouse (or finger) movement, and per second of full stick.
const MOUSE_TURN: f32 = 0.0022;
const PAD_TURN: f32 = 2.6;
/// The view never looks straight up or down.
const PITCH_LIMIT: f32 = 1.45;
/// Walking and running speeds (m/s).
const WALK: f32 = 3.0;
const SPRINT: f32 = 5.2;
/// A bodycam rides on the chest, below the eyes, with a wide lens: 72° vertical is about 104°
/// horizontal at 16:9 (keep a first-person fovy within 60-80).
const CAMERA_HEIGHT: f32 = 1.42;
const FOVY: f32 = 72.0;
/// How far ahead the view model reaches from the camera (m); nearer a wall it pulls back.
pub const REACH: f32 = 0.55;
/// Where the player starts, and its health.
const SPAWN: Vec3 = vec3(0.0, 0.0, -8.0);
pub const HEALTH: f32 = 100.0;

/// The hall's boxes (min, max): floor, walls, pillars and cover. Each is drawn and is a fixed
/// collider, so the hitscan, the player and the enemy all meet what the picture shows.
const BOXES: [(Vec3, Vec3); 10] = [
    (vec3(-12.0, -0.5, -12.0), vec3(12.0, 0.0, 12.0)),
    (vec3(-12.5, 0.0, -12.5), vec3(12.5, 4.0, -12.0)),
    (vec3(-12.5, 0.0, 12.0), vec3(12.5, 4.0, 12.5)),
    (vec3(-12.5, 0.0, -12.0), vec3(-12.0, 4.0, 12.0)),
    (vec3(12.0, 0.0, -12.0), vec3(12.5, 4.0, 12.0)),
    (vec3(-4.4, 0.0, -0.4), vec3(-3.6, 4.0, 0.4)),
    (vec3(3.6, 0.0, -0.4), vec3(4.4, 4.0, 0.4)),
    (vec3(-1.5, 0.0, 3.0), vec3(1.5, 1.1, 3.6)),
    (vec3(-7.0, 0.0, -4.0), vec3(-5.5, 1.0, -3.0)),
    (vec3(5.0, 0.0, 5.5), vec3(6.2, 1.4, 6.5)),
];

/// What a shot hit this tick: the collider, where and the surface's normal there.
#[derive(Clone, Copy, Debug)]
pub struct Hit {
    pub collider: genex::physics::ColliderHandle,
    pub point: Vec3,
    pub normal: Vec3,
}

/// Everything the simulation owns. Every seed rebuilds it from `World::default()`.
#[derive(Default)]
pub struct World {
    /// Ticks since the seed.
    pub tick: u64,
    /// The player's capsule (made at reset).
    pub player: Option<Character>,
    /// Where the player looks: turn about +y (0 along +x) and tilt (up positive).
    pub yaw: f32,
    pub pitch: f32,
    /// This tick's turn (radians, yaw and pitch): the view model sways against it.
    pub turned: Vec2,
    /// The camera's motion: bob, roll, landings and recoil (display only, never probed).
    pub rig: FirstPersonRig,
    /// The planar speed (m/s).
    pub speed: f32,
    /// How far the view model pulls back from a wall in front of it (m).
    pub wall_pull: f32,
    /// The finger dragging the view, and where it was last tick.
    pub drag: Option<(u32, Vec2)>,
    pub health: f32,
    /// The weapon's kick (1 just fired, decaying to 0) and the tick it last fired.
    pub recoil: f32,
    pub fired_at: Option<u64>,
    /// What the weapon hit this tick, for the enemy to read (cleared every tick).
    pub hit: Option<Hit>,
}

impl World {
    /// The unit direction the player looks along.
    pub fn forward(&self) -> Vec3 {
        let (sp, cp) = math::sin_cos(self.pitch);
        let (sy, cy) = math::sin_cos(self.yaw);
        vec3(cy * cp, sp, sy * cp)
    }

    /// Where the chest camera is, before its bob: the hitscan starts here.
    pub fn eye(&self) -> Vec3 {
        self.player.as_ref().map_or(SPAWN, Character::feet) + Vec3::Y * CAMERA_HEIGHT
    }

    /// The camera: the eye moved by the rig, which reads the person's head-bob, screen-shake,
    /// reduced-motion and field of view settings here, in the camera hook.
    pub fn camera(&self) -> Camera {
        self.rig.camera(self.eye(), self.forward(), FOVY)
    }
}

/// The action map: keys and mouse, a pad, and touch controls shown on touch screens.
fn actions() -> ActionMap {
    let play = Context::new(PLAY, 0)
        .axis2(MOVE, &[Binding::WASD, Binding::Stick(Stick::Left), Binding::Touch(STICK)])
        .axis2(LOOK, &[Binding::Look])
        .axis2(TURN, &[Binding::Stick(Stick::Right)])
        .button(RUN, &[Key::ShiftLeft.into(), Binding::Pad(PadButton::LeftStickPress)])
        .button(JUMP, &[Key::Space.into(), Binding::Pad(PadButton::South)])
        .button(FIRE, &[Key::Mouse1.into(), Binding::Pad(PadButton::RightTrigger), Binding::Touch(SHOOT)])
        .button(RELOAD, &[Key::KeyR.into(), Binding::Pad(PadButton::West)]);
    ActionMap::new().context(play)
}

/// Register the entry owner's hooks.
pub fn wire(game: &mut Game<World>) {
    game.input(actions());
    game.touch_controls(
        TouchControls::new()
            .stick(STICK, Anchor::BottomLeft([150.0, 150.0]), 70.0, StickMode::Floating)
            .button(SHOOT, "Fire", Anchor::BottomRight([130.0, 150.0]), 52.0)
            .show(ShowWhen::Touch),
    );
    game.on_reset(|sim, _seed, _rng, _gfx| {
        let (world, physics) = sim.split();
        for (min, max) in BOXES {
            let half = (max - min) * 0.5;
            physics.insert(RigidBodyBuilder::fixed().translation(min + half), ColliderBuilder::cuboid(half.x, half.y, half.z));
        }
        world.player = Character::spawn(physics, SPAWN, CharacterParams::default()).ok();
        world.rig = FirstPersonRig::new().with_speeds(WALK, SPRINT);
        world.yaw = std::f32::consts::FRAC_PI_2;
        world.health = HEALTH;
    });
    game.on_update(update);
    game.on_draw(|_sim, frame, _camera| draw(frame));
    game.on_ui(|sim, ui, _ctx| hud(&sim.world, ui));
    game.camera(|sim| sim.world.camera());
    game.named_camera("hall", |_| Camera::look_at(vec3(-11.0, 6.0, -11.0), vec3(2.0, 0.0, 2.0)));
    game.player(|sim| {
        let at = sim.world.player.as_ref().map_or(SPAWN, Character::feet);
        json!({ "x": at.x, "z": at.z, "yaw": sim.world.yaw, "pitch": sim.world.pitch, "health": sim.world.health })
    });
    // The camera's motion per tick for a comfort check (bob, roll, cadence), outside the checksum.
    game.probe_volatile("camera", |sim| sim.world.rig.probe());
}

/// Turn from the mouse, a stick or a dragging finger; walk the capsule; measure the bob and the wall.
fn update(sim: &mut Sim<World>, ctx: &Ctx<'_>) {
    let (world, physics) = sim.split();
    world.tick = ctx.tick + 1;
    world.hit = None;
    let mut turn = ctx.actions.axis2(LOOK) * MOUSE_TURN + ctx.actions.axis2(TURN) * PAD_TURN * ctx.dt;
    turn += drag(world, ctx) * MOUSE_TURN;
    world.yaw += turn.x;
    world.pitch = (world.pitch - turn.y).clamp(-PITCH_LIMIT, PITCH_LIMIT);
    world.turned = turn;
    let Some(player) = world.player.as_mut() else { return };
    let forward = vec3(math::cos(world.yaw), 0.0, math::sin(world.yaw));
    let right = forward.cross(Vec3::Y);
    let walk = ctx.actions.axis2(MOVE).clamp_length_max(1.0);
    let pace = if ctx.actions.down(RUN) { SPRINT } else { WALK };
    let wish = (right * walk.x - forward * walk.y) * pace;
    let jump = ctx.actions.pressed(JUMP);
    let step = player.drive(physics, CharacterMotion::Velocity { wish, jump }, ctx.dt);
    let velocity = player.velocity();
    world.speed = vec2(velocity.x, velocity.z).length();
    // The rig eases the step up a stair, dips on a landing and leans into the turn.
    world.rig.update(ctx.dt, RigStep { velocity, turn: turn.x, ..RigStep::from(&step) });
    // The view model pulls back from a wall rather than poke through it (the near plane is 0.1 m).
    let exclude = player.body().map_or(QueryFilter::default(), |body| QueryFilter::default().exclude_rigid_body(body));
    let reach = physics.cast_ray(&Ray::new(world.eye(), world.forward()), REACH, true, exclude).map_or(REACH, |(_, toi)| toi);
    world.wall_pull = REACH - reach;
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

/// The greybox hall under a low sun. For surfaces, light, probes and decals that read as a real
/// room, build it the way `docs/examples/interior-room` does.
fn draw(frame: &mut Frame) {
    frame.clear(Color::rgb(120, 140, 160)).ambient(Color::rgb(170, 185, 210), 0.2);
    frame.sun(vec3(0.4, 0.8, 0.3), Color::WHITE, 2.8).environment(Environment::sky());
    frame.tag("hall");
    let concrete = Material::color(Color::rgb(150, 146, 138)).with_roughness(0.85);
    for (min, max) in BOXES {
        frame.cube_with(Transform::from_translation((min + max) * 0.5).with_scale(max - min), &concrete);
    }
}

/// A crosshair, health and the hint; the weapon facet draws the ammo.
fn hud(world: &World, ui: &mut egui::Ui) {
    let center = ui.max_rect().center();
    let ink = egui::Stroke::new(1.5, egui::Color32::from_rgba_unmultiplied(235, 235, 235, 200));
    for (dx, dy) in [(1.0, 0.0), (-1.0, 0.0), (0.0, 1.0), (0.0, -1.0)] {
        let dir = egui::vec2(dx, dy);
        ui.painter().line_segment([center + dir * 5.0, center + dir * 12.0], ink);
    }
    let health = format!("HEALTH {:.0}", world.health.max(0.0));
    ui.label(egui::RichText::new(health).color(egui::Color32::WHITE).size(18.0).strong());
}
