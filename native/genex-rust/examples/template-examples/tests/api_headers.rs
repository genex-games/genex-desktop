//! The `use` lines and signature lists that open the reference pages agents guessed wrong in the
//! Bodycam rerun (`docs/api/particles.md`, `characters.md`, `net.md`, `input.md`, `animation.md`,
//! `assets.md`), written out as code: each line here is one a page teaches, so a facade change
//! that moves a type or a call breaks this build before it misleads a game.

use genex::actions::{ActionId, Anchor, ContextId, ControlId, Device, Modifier, ShowWhen, StickMode, controls_panel, glyph_ui};
use genex::animation::{AnimatorStep, BodyPart, ClipId, EventId, FloatParam, Mask, Motion, TriggerParam};
use genex::net::{NetConfig, NetError, NetEvent, NetStatus, NetTicket, PlayerId};
use genex::physics::{ColliderHandle, RigidBodyHandle};
use genex::prelude::*;
use genex::{AnimationError, AssetBytes, AssetError, AssetInfo, CharacterAsset, CharacterDraw, ModelTriangles, Skeleton};
use genex::{CharacterError, CharacterParams, CharacterStep};
use genex::{HumanoidBone, Ragdoll, RagdollPart, RagdollProfile};
use genex::{Particles, ParticlesError};
use std::sync::Arc;

const PLAY: ContextId = ContextId::new("play");
const JUMP: ActionId = ActionId::new("jump");
const HOP: ControlId = ControlId::new("hop");

/// particles.md: the crate root's emitter and its builders.
fn particles(frame: &mut Frame) -> Result<Particles, ParticlesError> {
    let steam: Particles = Particles::steam(vec3(0.0, 0.0, 0.0));
    let _: Particles = Particles::rain(vec3(0.0, 9.0, 0.0), vec3(6.0, 0.0, 6.0));
    let _: Particles = Particles::snow(vec3(0.0, 9.0, 0.0), vec3(6.0, 0.0, 6.0));
    let _: Particles = Particles::dust(vec3(0.0, 1.5, 0.0), vec3(2.0, 1.5, 2.0));
    let _: Particles = Particles::fountain(Vec3::ZERO);
    let rain = steam.with_rate(60, 90)?.with_flipbook("fx/smoke.png", 4, 4, 16, 1.0, true)?;
    let shaped = rain
        .with_origin(Vec3::ZERO, Vec3::ONE)
        .with_motion(Vec3::Y, 0.2, Vec3::ZERO)
        .with_look(0.2, 2.0, Color::WHITE, Color::WHITE)
        .with_soft(0.5)
        .with_sorted(true)
        .with_collision(0.1, 30)
        .with_shape(2.0, 0.5, 0.1)
        .with_seed(7);
    frame.particles(&shaped);
    Ok(shaped)
}

/// characters.md: the controller, its parameters by field name, its step and handles.
fn characters(physics: &mut PhysicsWorld, wish: Vec3, dt: f32) -> Result<Character, CharacterError> {
    let params = CharacterParams { jump_speed: 8.0, ..CharacterParams::default() };
    let CharacterParams { radius: _, height: _, max_slope_degrees: _, step_height: _, snap_to_ground: _, gravity: _, jump_speed: _, accel: _, decel: _, turn_rate: _ } = params;
    let mut hero: Character = Character::spawn(physics, Vec3::ZERO, params)?;
    let step: CharacterStep = hero.drive(physics, CharacterMotion::Velocity { wish, jump: false }, dt);
    let CharacterStep { moved: _, grounded: _, sliding: _, landed: _, left_ground: _ } = step;
    let _: (Vec3, Quat, Vec3, bool) = (hero.feet(), hero.facing(), hero.velocity(), hero.grounded());
    let _: Transform = hero.transform().into();
    let _: (Option<RigidBodyHandle>, Option<ColliderHandle>) = (hero.body(), hero.collider());
    let mut off_physics: Character = Character::on_ground(Vec3::ZERO, params)?;
    let _: CharacterStep = off_physics.drive_on(|_x, _z| 0.0, CharacterMotion::Velocity { wish, jump: true }, dt);
    Ok(hero)
}

/// characters.md: a ragdoll over an animator.
fn ragdoll(physics: &mut PhysicsWorld, animator: &Animator, model: Mat4) -> Result<Ragdoll, AnimationError> {
    let mut ragdoll: Ragdoll = Ragdoll::build(physics, animator, model, &RagdollProfile::humanoid().with_mass(70.0))?;
    ragdoll.follow(physics, animator, model);
    ragdoll.go_limp(physics, RagdollPart::Limb(HumanoidBone::LeftUpperArm), Vec3::ZERO);
    ragdoll.power(physics, RagdollPart::Whole, 0.5);
    ragdoll.recover(physics, RagdollPart::Whole, 0.4);
    Ok(ragdoll)
}

/// net.md: the room's reads and writes and every event, matched with the wildcard it needs.
fn net(game: &mut Game<()>, sim: &mut Sim<()>) -> Result<NetTicket, NetError> {
    game.net(NetConfig::new().publish_hz(15).decimals(3).interp_delay_ticks(6));
    let _: NetStatus = sim.net.status();
    let _: Option<&PlayerId> = sim.net.me();
    for player in sim.net.remotes() {
        let _: (&PlayerId, &str, bool, &Value, &Value) = (player.id(), player.name(), player.is_me(), player.state(), player.state_raw());
    }
    let _: (usize, bool) = (sim.net.connected(), sim.net.is_host());
    sim.net.set_me(json!({ "x": 1.0 }))?;
    sim.net.send("hit", json!({}))?;
    for event in sim.net.events() {
        match event {
            NetEvent::Joined { player } | NetEvent::Left { player } => {
                let _: &str = player.as_str();
            }
            NetEvent::Message { from: _, kind: _, payload: _ } => {}
            _ => {}
        }
    }
    sim.net.claim("door")
}

/// input.md: the map, the reads, the device the player used last and the touch layout.
fn input(game: &mut Game<()>, ctx: &Ctx, ui: &mut egui::Ui) {
    game.input(ActionMap::new().context(
        Context::new(PLAY, 0)
            .button(JUMP, &[Key::Space.into(), Binding::Pad(PadButton::South), Binding::Touch(HOP)])
            .when(Condition::Press)
            .modify(Modifier::Negate { x: true, y: false }),
    ));
    game.touch_controls(
        TouchControls::new()
            .stick(ControlId::new("stick"), Anchor::BottomLeft([160.0, 160.0]), 70.0, StickMode::Floating)
            .button(HOP, "Jump", Anchor::BottomRight([120.0, 120.0]), 48.0)
            .show(ShowWhen::Touch),
    );
    let _: (bool, f32, Vec2, u32) = (ctx.actions.pressed(JUMP), ctx.actions.value(JUMP), ctx.actions.axis2(JUMP), ctx.actions.held_ticks(JUMP));
    match ctx.actions.device() {
        Device::KeyboardMouse | Device::Touch => {}
        Device::Pad(_family) => {}
    }
    glyph_ui(ui, &ctx.actions.glyph(JUMP));
    controls_panel(ui);
}

/// animation.md: the asset, the graph's handles and the animator's step.
fn animation(gfx: &Gfx, frame: &mut Frame) -> Option<(Animator, FloatParam, TriggerParam, EventId)> {
    let hero: Result<CharacterAsset, AnimationError> = gfx.character("characters/hero.glb");
    if let Err(error) = &hero {
        let _: (&str, &String) = (error.code.wire(), &error.detail);
    }
    let hero = hero.ok()?;
    let (_, _, _): (&str, usize, &Skeleton) = (hero.path(), hero.joint_count(), hero.skeleton());
    let walk: Option<ClipId> = hero.clip("Walk");
    let walk = walk?;
    let mut g = hero.graph();
    let speed: FloatParam = g.float("speed", 0.0);
    let attack: TriggerParam = g.trigger("attack");
    let base = g.layer("base");
    let idle = g.state(base, "idle", Motion::Empty);
    let walking = g.state(base, "walk", Motion::clip(walk));
    g.transition(idle, walking).when(speed.above(0.1));
    let upper = g.layer("upper");
    g.layer_mask(upper, Mask::Humanoid(BodyPart::UpperBody));
    let hit: EventId = g.event(walk, 0.3, "hit");
    let graph = g.build().ok()?;
    let mut animator: Animator = hero.animator(&graph).ok()?;
    let _: Result<Animator, AnimationError> = Animator::simple(&hero);
    let step: AnimatorStep = animator.update(1.0 / 60.0);
    let _ = (step.root_motion, step.events.iter().any(|event| event.event == hit));
    frame.character_with(&animator, Transform::IDENTITY, &CharacterDraw::new().tint(Color::RED));
    Some((animator, speed, attack, hit))
}

/// assets.md: a reset's reads and their refusal.
fn assets(gfx: &Gfx, model: &Model) -> Result<(), AssetError> {
    let read: Result<AssetBytes, AssetError> = gfx.assets().bytes("levels/one.json");
    if let Err(error) = &read {
        let _: (&str, &str) = (error.code().wire(), error.detail());
    }
    let bytes = read?;
    let _: (Value, Option<&str>, u64) = (bytes.json()?, bytes.as_str(), bytes.digest());
    let _: Arc<ModelTriangles> = gfx.assets().triangles(model)?;
    let _: Option<AssetInfo> = gfx.assets().info("levels/one.json");
    Ok(())
}

/// What each page's code reaches is named where the page says it is.
#[test]
fn the_reference_pages_name_real_paths_and_shapes() {
    let _ = (particles, characters, ragdoll, net, input, animation, assets);
    let jump = CharacterParams { jump_speed: 9.0, ..CharacterParams::default() };
    assert_eq!(jump.jump_speed, 9.0, "the jump is jump_speed");
    assert!(Particles::steam(Vec3::ZERO).with_rate(0, 60).is_err(), "with_rate refuses none alive");
    assert_eq!(Device::Pad(Default::default()).as_str(), "pad");
}
