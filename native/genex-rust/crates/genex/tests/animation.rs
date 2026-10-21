//! The facade's animation surface (AN-15): `gfx.character` builds a graph and an animator, the
//! world advances it in `on_update` with `animator.update(ctx.dt)` (a read hook cannot: the
//! trybuild row `animator_update_in_draw`), and a draw hook draws it with `frame.character` (one
//! logical draw under its tag) or its bones with `frame.skeleton_debug` (one line batch). A scripted
//! seed gives the same probe and checksum on every run, and every animation refusal is reachable
//! from the facade, spelled as the vocabulary fixture spells it.

#[path = "../../genex-anim/tests/support/mod.rs"]
mod rigs;

use std::path::Path;
use std::sync::LazyLock;

use genex::animation::{AnimGraph, FloatParam, Motion, TriggerParam};
use genex::prelude::*;
use genex::{AnimationErrorCode, AssetTable, CharacterAsset, CharacterDraw, CharacterParams, Runtime, Shape, View};
use rigs::{ChannelInterpolation, ChannelPath, ChannelSpec, ClipSpec, RigSpec};

/// The ticks of the scripted seed.
const SCRIPT_TICKS: f64 = 120.0;
/// The tick the script sets the speed, and the one it fires the attack.
const SPEED_TICK: u32 = 10;
const ATTACK_TICK: u32 = 40;

/// genex-anim's 22-joint humanoid with an idle and a one-shot sword attack beside its walk.
fn hero_spec() -> RigSpec {
    let mut rig = rigs::humanoid22();
    let rotation = |node: usize, times: Vec<f32>, angles: &[f32]| ChannelSpec {
        node,
        path: ChannelPath::Rotation,
        interpolation: ChannelInterpolation::Linear,
        times,
        values: angles.iter().flat_map(|angle| Quat::from_rotation_x(*angle).to_array()).collect(),
    };
    let (spine, arm) = (rig.joints[1], rig.joints[10]);
    rig.clips.push(ClipSpec { name: "Idle".to_owned(), channels: vec![rotation(spine, vec![0.0, 1.0, 2.0], &[0.0, 0.05, 0.0])] });
    rig.clips.push(ClipSpec { name: "Sword_Attack".to_owned(), channels: vec![rotation(arm, vec![0.0, 0.3, 0.6], &[0.0, -1.2, 0.0])] });
    rig
}

static HERO: LazyLock<&'static [u8]> = LazyLock::new(|| Box::leak(hero_spec().glb().into_boxed_slice()));
static CHAIN: LazyLock<&'static [u8]> = LazyLock::new(|| Box::leak(rigs::chain3().glb().into_boxed_slice()));

fn table() -> AssetTable {
    static TABLE: LazyLock<AssetTable> = LazyLock::new(|| Box::leak(vec![("hero.glb", *HERO), ("chain.glb", *CHAIN)].into_boxed_slice()));
    *TABLE
}

/// The hero, its animator and the parameters the script drives.
#[derive(Default)]
struct World {
    hero: Option<Animator>,
    speed: Option<FloatParam>,
    attack: Option<TriggerParam>,
    ticks: u32,
    events: u32,
    travelled: f32,
}

/// A base layer (idle <-> walk on speed) and an upper-body layer the attack trigger plays once.
fn hero_animator(hero: &CharacterAsset) -> (Animator, FloatParam, TriggerParam) {
    let clip = |name: &str| hero.clip(name).unwrap_or_else(|| panic!("the hero has {name}"));
    let mut g = hero.graph();
    let speed = g.float("speed", 0.0);
    let attack = g.trigger("attack");
    let base = g.layer("base");
    let idle = g.state(base, "idle", Motion::clip(clip("Idle")));
    let walk = g.state(base, "walk", Motion::clip(clip("Walk")));
    g.transition(idle, walk).when(speed.above(0.1)).inertialize(0.15);
    g.transition(walk, idle).when(speed.below(0.1)).inertialize(0.2);
    let upper = g.layer("upper");
    g.layer_mask(upper, genex::animation::Mask::Humanoid(genex::animation::BodyPart::UpperBody));
    let none = g.state(upper, "none", Motion::Empty);
    let slash = g.state(upper, "slash", Motion::clip(clip("Sword_Attack")).once());
    g.transition(none, slash).when(attack.fired()).crossfade(0.08);
    g.transition(slash, none).at_end().crossfade(0.15);
    g.event(clip("Sword_Attack"), 0.3, "hit");
    let graph = g.build().expect("the graph builds");
    (hero.animator(&graph).expect("an animator of the hero"), speed, attack)
}

/// The scripted game: speed at tick 10, the attack at tick 40, the animator advanced by `ctx.dt`
/// every tick; the probe is the animator's, and its state digest is in the checksum's probes.
fn scripted_game(attacks: bool) -> Game<World> {
    let mut game = Game::new(World::default()).world_size(64, 64);
    game.on_reset(|sim, _, _, gfx| {
        let hero = gfx.character("hero.glb").expect("the hero loads");
        let (animator, speed, attack) = hero_animator(&hero);
        sim.world.hero = Some(animator);
        sim.world.speed = Some(speed);
        sim.world.attack = Some(attack);
    });
    game.on_update(move |sim, ctx| {
        let world = &mut sim.world;
        world.ticks += 1;
        let (Some(hero), Some(speed), Some(attack)) = (world.hero.as_mut(), world.speed, world.attack) else { return };
        if world.ticks == SPEED_TICK {
            hero.set_float(speed, 2.0);
        }
        if attacks && world.ticks == ATTACK_TICK {
            hero.fire(attack);
        }
        let step = hero.update(ctx.dt);
        world.events += step.events.len() as u32;
        world.travelled += step.root_motion.translation.length();
    });
    game.on_draw(|sim, frame, _| {
        let Some(hero) = &sim.world.hero else { return };
        frame.tag("hero").character(hero, Transform::IDENTITY);
        frame.tag("bones").skeleton_debug(hero, Transform::IDENTITY);
    });
    game.probe("hero", |sim| sim.world.hero.as_ref().map_or(Value::Null, Animator::probe));
    game.probe("digest", |sim| json!(sim.world.hero.as_ref().map(|hero| format!("{:016x}", hero.digest()))));
    game.probe("events", |sim| json!(sim.world.events));
    game
}

/// One scripted run: the probes and the checksum after 120 ticks.
fn scripted_run(attacks: bool) -> (serde_json::Map<String, Value>, String) {
    let mut runtime = Runtime::with_assets(scripted_game(attacks), Box::new(table())).expect("valid game");
    let ran = runtime.step(SCRIPT_TICKS * genex::FIXED_STEP_MS);
    assert_eq!(ran.ticks, SCRIPT_TICKS as u32, "{ran:?}");
    (runtime.probes(), runtime.checksum())
}

#[test]
fn a_scripted_seed_gives_a_stable_probe_and_checksum_across_two_runs() {
    let (first, checksum) = scripted_run(true);
    let (second, again) = scripted_run(true);
    assert_eq!(first, second, "the same script gives the same probes");
    assert_eq!(checksum, again, "and the same checksum");
    let layers = first["hero"]["layers"].as_array().expect("the probe lists the layers");
    assert_eq!(layers.len(), 2, "{}", first["hero"]);
    assert_eq!(layers[0]["state"], json!("walk"), "speed 2 walks: {}", first["hero"]);
    assert_eq!(layers[1]["state"], json!("none"), "the once-only attack played and ended: {}", first["hero"]);
    assert_eq!(first["events"], json!(1), "the attack's hit fired once");

    // The probe moves with the script: without the attack the checksum differs.
    let (quiet, other) = scripted_run(false);
    assert_eq!(quiet["events"], json!(0), "no attack, no hit");
    assert_ne!(other, checksum, "the animator's state is in the checksum");
}

#[test]
fn frame_character_counts_one_logical_draw_under_its_tag() {
    let mut runtime = Runtime::with_assets(scripted_game(true), Box::new(table())).expect("valid game");
    runtime.step(10.0 * genex::FIXED_STEP_MS);
    let before = runtime.sim().world.hero.as_ref().map(|hero| hero.digest());
    let frame = runtime.frame(View::Game).expect("the game view");
    assert_eq!(frame.tags()["hero"], 1, "frame.character is one logical draw");
    let characters: Vec<&Shape> = frame.draws().iter().filter(|draw| draw.tag == "hero").map(|draw| &draw.shape).collect();
    let [Shape::Character { animator, .. }] = characters.as_slice() else { panic!("one character shape: {characters:?}") };
    assert_eq!(Some(animator.digest()), before, "the frame holds the animator's state as drawn");
    assert_eq!(animator.asset().path(), "hero.glb");
    assert_eq!(runtime.sim().world.hero.as_ref().map(|hero| hero.digest()), before, "drawing never moves the animator");
    let state = runtime.state();
    assert_eq!(state["__render"]["tags"]["hero"]["drawCalls"], json!(1), "{}", state["__render"]);

    let hero = runtime.sim().world.hero.clone().expect("the hero");
    let mut frame = Frame::default();
    frame.tag("tinted").character_with(&hero, Transform::IDENTITY, &CharacterDraw::new().tint(Color::RED).material(&Material::color(Color::BLUE)));
    assert_eq!(frame.draw_calls(), 1);
    let Shape::Character { tint, material, .. } = &frame.draws()[0].shape else { panic!("a character") };
    assert_eq!((*tint, material.clone()), (Color::RED, Some(Material::color(Color::BLUE))));
}

#[test]
fn frame_skeleton_debug_draws_one_logical_line_batch_of_its_bones() {
    let mut runtime = Runtime::with_assets(scripted_game(true), Box::new(table())).expect("valid game");
    runtime.step(30.0 * genex::FIXED_STEP_MS);
    let frame = runtime.frame(View::Game).expect("the game view");
    assert_eq!(frame.tags()["bones"], 1, "the skeleton is one logical draw");
    let hero = runtime.sim().world.hero.clone().expect("the hero");
    let skeleton = hero.asset().skeleton();
    let bones = skeleton.joints().filter(|joint| skeleton.parent(*joint).is_some()).count();
    let lines: Vec<&Shape> = frame.draws().iter().filter(|draw| draw.tag == "bones").map(|draw| &draw.shape).collect();
    let [Shape::Lines { points, .. }] = lines.as_slice() else { panic!("one line batch: {lines:?}") };
    assert_eq!(points.len(), 2 * bones, "a segment per bone");

    // Each segment ends at its joint's socket for the placed character.
    let placed = Transform { translation: vec3(3.0, 0.0, -2.0), ..Transform::IDENTITY };
    let mut frame = Frame::default();
    frame.skeleton_debug(&hero, placed);
    let Shape::Lines { points, .. } = &frame.draws()[0].shape else { panic!("lines") };
    let ends: Vec<Vec3> = skeleton
        .joints()
        .filter(|joint| skeleton.parent(*joint).is_some())
        .map(|joint| hero.socket(joint, placed.matrix()).w_axis.truncate())
        .collect();
    let drawn: Vec<Vec3> = points.chunks(2).map(|pair| pair[1]).collect();
    assert_eq!(drawn, ends);
}

/// The fixture's animation refusals.
fn pinned_refusals() -> Vec<String> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/rust-facade-vocabulary.json");
    let fixture: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("the fixture")).expect("JSON");
    fixture["animation"]["refusals"].as_array().expect("a list").iter().map(|code| code.as_str().expect("a code").to_owned()).collect()
}

/// What a reset that tries each refusal records: each code's wire spelling, in fixture order.
#[derive(Default)]
struct Refusals {
    codes: Vec<String>,
}

fn refusing_game() -> Game<Refusals> {
    let mut game = Game::new(Refusals::default()).world_size(64, 64);
    game.on_reset(|sim, _, _, gfx| {
        let codes = &mut sim.world.codes;
        let missing = gfx.character("nobody.glb").expect_err("a missing file refuses");
        codes.push(missing.code.wire().to_owned());
        let hero = gfx.character("hero.glb").expect("the hero");
        let mut empty = hero.graph();
        empty.layer("base");
        let graph = empty.build().expect_err("a layer with no state refuses");
        codes.push(graph.code.wire().to_owned());
        let ragdoll = ragdoll_refusal(&mut sim.physics, gfx);
        let codes = &mut sim.world.codes;
        codes.push(ragdoll);
        let chain = gfx.character("chain.glb").expect("the chain");
        let unmapped = hero.with_retargeted_clips(&chain).expect_err("a chain is not a humanoid");
        codes.push(unmapped.code.wire().to_owned());
        let shape = Character::on_ground(vec3(f32::NAN, 0.0, 0.0), CharacterParams::default()).expect_err("feet that are not finite refuse");
        codes.push(shape.code.wire().to_owned());
    });
    game.probe("codes", |sim| json!(sim.world.codes));
    game
}

/// A humanoid ragdoll asked of a three-joint chain refuses `ragdoll-profile-invalid`.
#[cfg(feature = "physics")]
fn ragdoll_refusal(physics: &mut PhysicsWorld, gfx: &Gfx) -> String {
    let chain = gfx.character("chain.glb").expect("the chain");
    let mut g = chain.graph();
    let base = g.layer("base");
    g.state(base, "still", Motion::Empty);
    let animator = chain.animator(&g.build().expect("graph")).expect("animator");
    let refused = genex::Ragdoll::build(physics, &animator, Mat4::IDENTITY, &genex::RagdollProfile::humanoid()).expect_err("not a humanoid");
    refused.code.wire().to_owned()
}

/// Without physics there are no ragdolls: the code is still the error type's own.
#[cfg(not(feature = "physics"))]
fn ragdoll_refusal(_: &mut PhysicsWorld, _: &Gfx) -> String {
    AnimationErrorCode::RagdollProfileInvalid.wire().to_owned()
}

#[test]
fn every_animation_refusal_is_reachable_from_the_facade_and_spelled_as_the_fixture_spells_it() {
    let runtime = Runtime::with_assets(refusing_game(), Box::new(table())).expect("valid game");
    let codes: Vec<String> = serde_json::from_value(runtime.probes()["codes"].clone()).expect("codes");
    assert_eq!(codes, pinned_refusals());
    let typed: Vec<&str> = AnimationErrorCode::ALL.iter().map(|code| code.wire()).chain(genex::CharacterErrorCode::ALL.map(genex::CharacterErrorCode::wire)).collect();
    assert_eq!(codes, typed, "and as the typed codes spell it");
}

#[test]
fn a_graph_of_another_character_refuses_and_root_motion_is_opt_in() {
    let mut game = Game::new(World::default()).world_size(64, 64);
    game.on_reset(|sim, _, _, gfx| {
        let hero = gfx.character("hero.glb").expect("hero");
        let chain = gfx.character("chain.glb").expect("chain");
        let mut g = chain.graph();
        let base = g.layer("base");
        g.state(base, "still", Motion::Empty);
        let theirs: AnimGraph = g.build().expect("the chain's graph");
        let refused = hero.animator(&theirs).expect_err("another skeleton's graph");
        assert_eq!(refused.code, AnimationErrorCode::GraphInvalid);
        assert_eq!(hero.clip_names().collect::<Vec<_>>(), ["Walk", "Idle", "Sword_Attack"]);
        let moving = hero.with_root_motion(&genex::animation::MotionSettings::DEFAULT).expect("root motion");
        let (mut animator, speed, _) = hero_animator(&moving);
        animator.set_float(speed, 2.0);
        let travelled: f32 = (0..90).map(|_| animator.update(1.0 / 60.0).root_motion.translation.length()).sum();
        sim.world.travelled = travelled;
    });
    let runtime = Runtime::with_assets(game, Box::new(table())).expect("valid game");
    assert!(runtime.sim().world.travelled > 0.5, "the walk's root motion moves the character: {}", runtime.sim().world.travelled);
}
