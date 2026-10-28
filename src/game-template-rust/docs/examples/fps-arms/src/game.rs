//! The arms kit's entry owner: the action map, the player (a character capsule moved by the keys,
//! a pad or a touch stick), mouse look, an eye-height camera that narrows while aiming, a greybox
//! firing range whose boxes are both drawn and Rapier colliders, and the HUD. The facets add the
//! rest: `rifle.rs` (the rifle's rules: rounds, automatic fire, reload, hitscan) and
//! `viewmodel.rs` (the kit's arms and rifle, animated from the rules' state).
//!
//! The pointer is locked by the host, never by the game: Live locks it on a click when
//! `studio.json` declares `game.mouseLook`. Apply `ctx.look` every tick without asking about the
//! lock, or the checks' injected look cannot turn the camera.

use genex::actions::{ActionId, Anchor, ContextId, ControlId, ShowWhen, StickMode};
use genex::camera::{Comfort, FirstPersonRig, RigStep};
use genex::math::{self, Vec3, vec3};
use genex::physics::{ColliderBuilder, QueryFilter, Ray, RigidBodyBuilder};
use genex::prelude::*;
use genex::render::Environment;
use genex::CharacterParams;

const PLAY: ContextId = ContextId::new("play");
/// The actions every facet reads.
pub const MOVE: ActionId = ActionId::new("move");
pub const LOOK: ActionId = ActionId::new("look");
pub const TURN: ActionId = ActionId::new("turn");
pub const RUN: ActionId = ActionId::new("run");
pub const FIRE: ActionId = ActionId::new("fire");
pub const AIM: ActionId = ActionId::new("aim");
pub const RELOAD: ActionId = ActionId::new("reload");
pub const INSPECT: ActionId = ActionId::new("inspect");
const STICK: ControlId = ControlId::new("stick");
const SHOOT: ControlId = ControlId::new("shoot");
const SIGHTS: ControlId = ControlId::new("sights");
const MAGAZINE: ControlId = ControlId::new("magazine");

/// Radians per pixel of mouse (or finger) movement, and per second of full stick.
const MOUSE_TURN: f32 = 0.0022;
const PAD_TURN: f32 = 2.6;
const PITCH_LIMIT: f32 = 1.45;
/// Walking and sprinting speeds (m/s); aiming slows the walk.
const WALK: f32 = 3.0;
const SPRINT: f32 = 5.6;
const AIM_WALK: f32 = 1.6;
/// The eye's height, the lens at the hip and down the sights, and how fast it narrows (per tick).
const EYE_HEIGHT: f32 = 1.62;
const FOVY: f32 = 70.0;
const FOVY_AIMED: f32 = 52.0;
const AIM_FOLLOW: f32 = 0.25;
/// How far ahead the rifle reaches from the eye (m); nearer a wall it pulls back.
pub const REACH: f32 = 0.9;
const SPAWN: Vec3 = vec3(0.0, 0.0, -10.0);

/// The range's boxes (min, max): floor, walls, a back berm, cover and three target stands. Each is
/// drawn and is a fixed collider, so the hitscan and the player meet what the picture shows.
const BOXES: [(Vec3, Vec3); 9] = [
    (vec3(-8.0, -0.5, -14.0), vec3(8.0, 0.0, 34.0)),
    (vec3(-8.5, 0.0, -14.0), vec3(-8.0, 3.5, 34.0)),
    (vec3(8.0, 0.0, -14.0), vec3(8.5, 3.5, 34.0)),
    (vec3(-8.0, 0.0, 33.0), vec3(8.0, 5.0, 34.0)),
    (vec3(-2.5, 0.0, -2.0), vec3(-0.8, 1.1, -1.6)),
    (vec3(1.2, 0.0, -2.0), vec3(3.0, 1.1, -1.6)),
    (vec3(-3.4, 0.0, 8.0), vec3(-2.6, 1.8, 8.2)),
    (vec3(0.6, 0.0, 15.0), vec3(1.4, 1.8, 15.2)),
    (vec3(3.6, 0.0, 24.0), vec3(4.4, 1.8, 24.2)),
];

/// Everything the simulation owns. Every seed rebuilds it from `World::default()`.
#[derive(Default)]
pub struct World {
    /// Ticks since the seed.
    pub tick: u64,
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
    /// Holding the aim, and how far down the sights the view is (0 at the hip, 1 aimed).
    pub aiming: bool,
    pub aim: f32,
    /// Sprinting this tick (running forward, not aiming or firing).
    pub sprinting: bool,
    /// How far the rifle pulls back from a wall in front of it (m).
    pub wall_pull: f32,
    pub drag: Option<(u32, Vec2)>,
    /// The rifle's state, which `rifle.rs` rules and `viewmodel.rs` shows: rounds in the
    /// magazine, the kick (1 just fired, decaying to 0), and the ticks a shot, a dry trigger, a
    /// reload and an inspect began.
    pub rounds: u32,
    pub recoil: f32,
    pub fired_at: Option<u64>,
    pub dry_at: Option<u64>,
    pub reload_at: Option<u64>,
    pub inspect_at: Option<u64>,
    /// Where the latest shot ended (what it hit, or its full range): the tracer's far end.
    pub impact: Option<Vec3>,
}

impl World {
    /// The unit direction the player looks along.
    pub fn forward(&self) -> Vec3 {
        let (sp, cp) = math::sin_cos(self.pitch);
        let (sy, cy) = math::sin_cos(self.yaw);
        vec3(cy * cp, sp, sy * cp)
    }

    /// Where the eye is, before its bob: the hitscan starts here.
    pub fn eye(&self) -> Vec3 {
        self.player.as_ref().map_or(SPAWN, Character::feet) + Vec3::Y * EYE_HEIGHT
    }

    /// The camera: the eye moved by the rig under the person's comfort settings, with no walk bob
    /// down the sights, the lens narrowing as it aims.
    pub fn camera(&self) -> Camera {
        let comfort = Comfort::current();
        let aimed = Comfort { head_bob: comfort.head_bob * (1.0 - self.aim), ..comfort };
        self.rig.camera_with(self.eye(), self.forward(), FOVY + (FOVY_AIMED - FOVY) * self.aim, &aimed)
    }
}

/// The action map: keys and mouse, a pad, and touch controls shown on touch screens.
fn actions() -> ActionMap {
    let play = Context::new(PLAY, 0)
        .axis2(MOVE, &[Binding::WASD, Binding::Stick(Stick::Left), Binding::Touch(STICK)])
        .axis2(LOOK, &[Binding::Look])
        .axis2(TURN, &[Binding::Stick(Stick::Right)])
        .button(RUN, &[Key::ShiftLeft.into(), Binding::Pad(PadButton::LeftStickPress)])
        .button(FIRE, &[Key::Mouse1.into(), Binding::Pad(PadButton::RightTrigger), Binding::Touch(SHOOT)])
        .button(AIM, &[Key::Mouse2.into(), Binding::Pad(PadButton::LeftTrigger), Binding::Touch(SIGHTS)])
        .button(RELOAD, &[Key::KeyR.into(), Binding::Pad(PadButton::West), Binding::Touch(MAGAZINE)])
        .button(INSPECT, &[Key::KeyF.into(), Binding::Pad(PadButton::North)]);
    ActionMap::new().context(play)
}

/// Register the entry owner's hooks.
pub fn wire(game: &mut Game<World>) {
    game.input(actions());
    game.touch_controls(
        TouchControls::new()
            .stick(STICK, Anchor::BottomLeft([150.0, 150.0]), 70.0, StickMode::Floating)
            .button(SHOOT, "Fire", Anchor::BottomRight([130.0, 150.0]), 52.0)
            .button(SIGHTS, "Aim", Anchor::BottomRight([250.0, 120.0]), 40.0)
            .button(MAGAZINE, "Reload", Anchor::BottomRight([130.0, 270.0]), 36.0)
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
    });
    game.on_update(update);
    game.on_draw(|_sim, frame, _camera| draw(frame));
    game.on_ui(|sim, ui, _ctx| hud(&sim.world, ui));
    game.camera(|sim| sim.world.camera());
    game.named_camera("range", |_| Camera::look_at(vec3(-7.0, 5.0, -13.0), vec3(2.0, 0.0, 10.0)));
    game.player(|sim| {
        let at = sim.world.player.as_ref().map_or(SPAWN, Character::feet);
        json!({ "x": at.x, "z": at.z, "yaw": sim.world.yaw, "pitch": sim.world.pitch, "aim": sim.world.aim, "sprinting": sim.world.sprinting })
    });
    // The camera's motion per tick for a comfort check (bob, roll, cadence), outside the checksum.
    game.probe_volatile("camera", |sim| sim.world.rig.probe());
}

/// Turn, walk or sprint the capsule, ease the aim, and measure the wall in front of the rifle.
fn update(sim: &mut Sim<World>, ctx: &Ctx<'_>) {
    let (world, physics) = sim.split();
    world.tick = ctx.tick + 1;
    let mut turn = ctx.actions.axis2(LOOK) * MOUSE_TURN + ctx.actions.axis2(TURN) * PAD_TURN * ctx.dt;
    turn += drag(world, ctx) * MOUSE_TURN;
    world.yaw += turn.x;
    world.pitch = (world.pitch - turn.y).clamp(-PITCH_LIMIT, PITCH_LIMIT);
    world.turned = turn;
    // The move action's y is down the screen: W is -1, so ahead is its negation.
    let walk = ctx.actions.axis2(MOVE).clamp_length_max(1.0);
    let ahead = -walk.y;
    world.aiming = ctx.actions.down(AIM);
    world.sprinting = ctx.actions.down(RUN) && ahead > 0.5 && !world.aiming && !ctx.actions.down(FIRE);
    world.aim += (f32::from(u8::from(world.aiming)) - world.aim) * AIM_FOLLOW;
    let Some(player) = world.player.as_mut() else { return };
    let forward = vec3(math::cos(world.yaw), 0.0, math::sin(world.yaw));
    let right = forward.cross(Vec3::Y);
    let pace = if world.sprinting { SPRINT } else if world.aiming { AIM_WALK } else { WALK };
    let wish = (right * walk.x + forward * ahead) * pace;
    let step = player.drive(physics, CharacterMotion::Velocity { wish, jump: false }, ctx.dt);
    let velocity = player.velocity();
    world.speed = vec2(velocity.x, velocity.z).length();
    world.rig.update(ctx.dt, RigStep { velocity, turn: turn.x, ..RigStep::from(&step) });
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

/// The greybox range under a low sun: build its surfaces the way `docs/examples/interior-room` does.
fn draw(frame: &mut Frame) {
    frame.clear(Color::rgb(120, 140, 160)).ambient(Color::rgb(170, 185, 210), 0.2);
    frame.sun(vec3(0.5, 0.7, -0.4), Color::WHITE, 3.0).environment(Environment::sky());
    frame.tag("range");
    let concrete = Material::color(Color::rgb(150, 146, 138)).with_roughness(0.85);
    let target = Material::color(Color::rgb(200, 190, 160)).with_roughness(0.7);
    for (index, (min, max)) in BOXES.into_iter().enumerate() {
        let surface = if index >= 6 { &target } else { &concrete };
        frame.cube_with(Transform::from_translation((min + max) * 0.5).with_scale(max - min), surface);
    }
}

/// A crosshair at the hip (the sights replace it when aiming) and the rounds left.
fn hud(world: &World, ui: &mut egui::Ui) {
    if world.aim < 0.5 {
        let center = ui.max_rect().center();
        let ink = egui::Stroke::new(1.5, egui::Color32::from_rgba_unmultiplied(235, 235, 235, 200));
        for (dx, dy) in [(1.0, 0.0), (-1.0, 0.0), (0.0, 1.0), (0.0, -1.0)] {
            let dir = egui::vec2(dx, dy);
            ui.painter().line_segment([center + dir * 6.0, center + dir * 14.0], ink);
        }
    }
    let text = if world.reload_at.is_some() { "RELOADING".to_owned() } else { format!("{} / 30", world.rounds) };
    ui.label(egui::RichText::new(text).color(egui::Color32::WHITE).size(18.0).strong());
}
