//! Release R-22: `animator.plant_feet(model, ground)` keeps a generated character's feet on the
//! ground. On a 20° slope, placing the character by its origin leaves the downhill foot floating
//! and the uphill one sunk; after `plant_feet` both ankles stand within 2 cm of their rest
//! clearance over the slope, and `socket`, `pose` and `palette` show the planted pose. A walk over
//! bumpy ground replays to the same pinned digest on every target (aarch64, x86_64 and wasm32),
//! and `snapshot` / `restore` carry the feet's locks so a restored walk continues bit for bit. A
//! rig without a humanoid's legs is left as it is.
//!
//! Every row is new behaviour (section 0 of the release plan): the facade had no `plant_feet`.

#[path = "../../genex-anim/tests/support/mod.rs"]
mod rigs;

use std::sync::LazyLock;

use genex::animation::{FootPlan, height_ground};
use genex::prelude::*;
use genex::{AssetTable, CharacterAsset, GroundHit, Runtime};
use genex_core::digest::{FNV_OFFSET_BASIS, fnv1a64_from};
use rigs::{ChannelInterpolation, ChannelPath, ChannelSpec, ClipSpec, RigSpec};

/// One tick of a 60 Hz game.
const TICK: f32 = 1.0 / 60.0;
/// The slope the red row stands on, degrees.
const SLOPE_DEGREES: f32 = 20.0;
/// How far a planted ankle may sit off its rest clearance over the ground, metres.
const PLANTED_TOLERANCE: f32 = 0.02;
/// Ticks of the scripted walk.
const WALK_TICKS: usize = 240;
/// The scripted walk's digest (pose, state and locks every tick), the same on every target.
const WALK_DIGEST: u64 = 0x0155_2e1c_d386_f337;

/// `sin` and `cos` through glam's libm (the platform's are not the same bits everywhere).
fn sin(x: f32) -> f32 {
    Vec2::from_angle(x).y
}

fn cos(x: f32) -> f32 {
    Vec2::from_angle(x).x
}

/// A UE-mannequin-like rig (knees bent, so a leg can reach further down), hips 0.12 m each side,
/// with a still "Idle" and a "Walk" that swings the thighs and lifts each foot in turn.
fn legs_spec() -> RigSpec {
    let mut spec = RigSpec::new("plant-feet");
    spec.mesh_node = spec.node("Body", None, [0.0; 3], Quat::IDENTITY, [1.0; 3]);
    let root = spec.joint("root", None, [0.0; 3], Quat::IDENTITY);
    let pelvis = spec.joint("pelvis", Some(root), [0.0, 0.95, 0.0], Quat::IDENTITY);
    let spine = spec.joint("spine_01", Some(pelvis), [0.0, 0.1, 0.0], Quat::IDENTITY);
    let spine2 = spec.joint("spine_02", Some(spine), [0.0, 0.12, 0.0], Quat::IDENTITY);
    let spine3 = spec.joint("spine_03", Some(spine2), [0.0, 0.12, 0.0], Quat::IDENTITY);
    let neck = spec.joint("neck_01", Some(spine3), [0.0, 0.15, 0.0], Quat::IDENTITY);
    spec.joint("head", Some(neck), [0.0, 0.1, 0.0], Quat::IDENTITY);
    for (side, x) in [("l", 1.0), ("r", -1.0)] {
        let clavicle = spec.joint(&format!("clavicle_{side}"), Some(spine3), [0.06 * x, 0.12, 0.0], Quat::IDENTITY);
        let upper = spec.joint(&format!("upperarm_{side}"), Some(clavicle), [0.12 * x, 0.0, 0.0], Quat::IDENTITY);
        let lower = spec.joint(&format!("lowerarm_{side}"), Some(upper), [0.26 * x, 0.0, 0.0], Quat::IDENTITY);
        spec.joint(&format!("hand_{side}"), Some(lower), [0.24 * x, 0.0, 0.0], Quat::IDENTITY);
    }
    let mut thighs = Vec::new();
    for (side, x) in [("l", 1.0), ("r", -1.0)] {
        let thigh = spec.joint(&format!("thigh_{side}"), Some(pelvis), [0.12 * x, -0.05, 0.0], Quat::from_rotation_x(-0.3));
        let calf = spec.joint(&format!("calf_{side}"), Some(thigh), [0.0, -0.42, 0.0], Quat::from_rotation_x(0.6));
        let foot = spec.joint(&format!("foot_{side}"), Some(calf), [0.0, -0.42, 0.0], Quat::from_rotation_x(-0.3));
        spec.joint(&format!("ball_{side}"), Some(foot), [0.0, -0.06, 0.12], Quat::IDENTITY);
        thighs.push(thigh);
    }
    let swing = |node: usize, angles: [f32; 3]| ChannelSpec {
        node,
        path: ChannelPath::Rotation,
        interpolation: ChannelInterpolation::Linear,
        times: vec![0.0, 0.5, 1.0],
        values: angles.iter().flat_map(|angle| Quat::from_rotation_x(*angle).to_array()).collect(),
    };
    spec.clips.push(ClipSpec { name: "Idle".to_owned(), channels: vec![swing(spine, [0.0, 0.02, 0.0])] });
    // Each thigh swings forward (lifting its foot) while the other stands at rest.
    spec.clips.push(ClipSpec { name: "Walk".to_owned(), channels: vec![swing(thighs[0], [-0.3, -0.7, -0.3]), swing(thighs[1], [-0.7, -0.3, -0.7])] });
    spec
}

static LEGS: LazyLock<&'static [u8]> = LazyLock::new(|| Box::leak(legs_spec().glb().into_boxed_slice()));
static CHAIN: LazyLock<&'static [u8]> = LazyLock::new(|| Box::leak(rigs::chain3().glb().into_boxed_slice()));

fn table() -> AssetTable {
    static TABLE: LazyLock<AssetTable> = LazyLock::new(|| Box::leak(vec![("legs.glb", *LEGS), ("chain.glb", *CHAIN)].into_boxed_slice()));
    *TABLE
}

/// The characters a reset loaded, for the rows to animate outside the runtime.
#[derive(Default)]
struct Loaded {
    legs: Option<CharacterAsset>,
    chain: Option<CharacterAsset>,
}

/// The legs and the chain, loaded through `gfx.character` as a game loads them.
fn characters() -> (CharacterAsset, CharacterAsset) {
    let mut game = Game::new(Loaded::default()).world_size(64, 64);
    game.on_reset(|sim, _, _, gfx| {
        sim.world = Loaded { legs: Some(gfx.character("legs.glb").expect("the legs load")), chain: Some(gfx.character("chain.glb").expect("the chain loads")) };
    });
    let runtime = Runtime::with_assets(game, Box::new(table())).expect("valid game");
    let world = &runtime.sim().world;
    (world.legs.clone().expect("legs"), world.chain.clone().expect("chain"))
}

/// A simple animator of `asset` playing `clip`.
fn playing(asset: &CharacterAsset, clip: &str) -> Animator {
    let mut animator = Animator::simple(asset).expect("a simple animator");
    assert!(animator.play(asset.clip(clip).expect("the clip")));
    animator
}

/// The 20° slope rising toward +X through the origin: its unit normal.
fn slope_normal() -> Vec3 {
    let angle = SLOPE_DEGREES.to_radians();
    Vec3::new(-sin(angle), cos(angle), 0.0)
}

/// The slope as a ground probe: where the segment from `from` to `to` meets it.
fn slope(from: Vec3, to: Vec3) -> Option<GroundHit> {
    let normal = slope_normal();
    let span = to - from;
    let along = span.dot(normal);
    if along.abs() <= f32::EPSILON {
        return None;
    }
    let t = -from.dot(normal) / along;
    (0.0..=1.0).contains(&t).then(|| GroundHit { point: from + span * t, normal })
}

/// Each ankle's world position for the animator drawn at `model`.
fn ankles(animator: &Animator, model: Mat4) -> [Vec3; 2] {
    let skeleton = animator.asset().skeleton();
    ["foot_l", "foot_r"].map(|name| animator.socket(skeleton.find(name).expect("a foot"), model).w_axis.truncate())
}

#[test]
fn on_a_20_degree_slope_both_ankles_stand_within_2_cm_of_their_clearance_after_plant_feet() {
    let (legs, _) = characters();
    let mut hero = playing(&legs, "Idle");
    hero.update(TICK);
    let model = Transform::IDENTITY;
    // The rest clearance: the ankle's height over the model's floor, standing on flat ground.
    let clearance = ankles(&hero, model.matrix()).map(|ankle| ankle.y);
    let gaps = |hero: &Animator| {
        let [left, right] = ankles(hero, model.matrix());
        [left.dot(slope_normal()) - clearance[0], right.dot(slope_normal()) - clearance[1]]
    };
    let floating = gaps(&hero);
    assert!(floating[1] > PLANTED_TOLERANCE, "placed by its origin, the downhill foot floats: {floating:?}");
    assert!(floating[0] < -PLANTED_TOLERANCE, "and the uphill foot sinks: {floating:?}");

    let plan = hero.plant_feet(model, slope);
    assert!(plan.feet.iter().all(Option::is_some), "both feet found the slope: {plan:?}");
    assert!(plan.pelvis.y < 0.0, "the pelvis drops for the downhill foot: {plan:?}");
    for (foot, gap) in ["left", "right"].iter().zip(gaps(&hero)) {
        assert!(gap.abs() <= PLANTED_TOLERANCE, "{foot}: the planted ankle is {gap} m off its clearance over the slope");
    }

    // The palette and the local pose are the planted pose's; the next update lets the feet go.
    let skeleton = legs.skeleton();
    let mut drawn = vec![Mat4::IDENTITY.to_cols_array(); skeleton.skin_order().len()];
    hero.palette(&mut drawn);
    let mut want = drawn.clone();
    skeleton.palette(hero.model_pose(), &mut want);
    assert_eq!(drawn, want);
    let planted = hero.pose_digest();
    hero.update(TICK);
    assert_ne!(hero.pose_digest(), planted, "an update shows the animation until the next plant");
    assert!(gaps(&hero)[1] > PLANTED_TOLERANCE, "unplanted, the downhill foot floats again");
}

#[test]
fn in_the_air_the_legs_stay_as_animated_and_a_low_hop_still_reaches_the_ground() {
    let (legs, _) = characters();
    let mut hero = playing(&legs, "Idle");
    hero.update(TICK);
    let animated = hero.pose_digest();
    // 0.6 m over the slope: the pelvis would drop past a third of the 0.95 m hips.
    let jumping = Transform { translation: vec3(0.0, 0.6, 0.0), ..Transform::IDENTITY };
    assert_eq!(hero.plant_feet(jumping, slope), FootPlan::NONE);
    assert_eq!(hero.pose_digest(), animated, "the legs stay as animated in the air");
    // 0.2 m over it the legs still reach down.
    let hop = Transform { translation: vec3(0.0, 0.2, 0.0), ..Transform::IDENTITY };
    let plan = hero.plant_feet(hop, slope);
    assert!(plan.feet.iter().all(Option::is_some) && plan.pelvis.y < -0.15, "a low hop plants: {plan:?}");
}

#[test]
fn a_rig_without_a_humanoids_legs_is_left_as_it_is() {
    let (_, chain) = characters();
    let mut g = chain.graph();
    let base = g.layer("base");
    g.state(base, "still", genex::animation::Motion::Empty);
    let mut animator = chain.animator(&g.build().expect("graph")).expect("animator");
    animator.update(TICK);
    let before = (animator.pose_digest(), animator.digest());
    assert_eq!(animator.plant_feet(Transform::IDENTITY, slope), FootPlan::NONE);
    assert_eq!(animator.pose_digest(), before.0, "the pose is unchanged");
}

/// Bumpy ground: a height function through glam's libm.
fn bumps(x: f32, z: f32) -> Option<f32> {
    Some(0.12 * sin(1.3 * x) + 0.08 * cos(0.9 * z) + 0.15 * z.min(4.0) / 4.0)
}

/// Walk `hero` from tick `from` to `to` up the bumpy ground (1.2 m/s along +Z), planting its feet
/// each tick: the digest of every tick's pose and state, and the ticks a foot held a lock.
fn walk(hero: &mut Animator, from: usize, to: usize) -> (u64, usize) {
    let mut hash = FNV_OFFSET_BASIS;
    let mut locked = 0;
    for tick in from..to {
        hero.update(TICK);
        let z = 1.2 * TICK * tick as f32;
        let y = bumps(0.0, z).unwrap_or(0.0);
        let plan = hero.plant_feet(Transform { translation: vec3(0.0, y, z), ..Transform::IDENTITY }, height_ground(bumps));
        locked += usize::from(plan.feet.iter().flatten().any(|goal| goal.locked));
        hash = fnv1a64_from(&[hero.pose_digest().to_le_bytes(), hero.digest().to_le_bytes()].concat(), hash);
    }
    (hash, locked)
}

#[test]
fn a_planted_walk_over_bumpy_ground_replays_to_the_pinned_digest_and_locks_feet_in_turn() {
    let (legs, _) = characters();
    let (digest, locked) = walk(&mut playing(&legs, "Walk"), 0, WALK_TICKS);
    assert!(locked > 0 && locked < WALK_TICKS, "a foot locks while it stands and lets go as it swings: {locked} of {WALK_TICKS} ticks");
    let (again, _) = walk(&mut playing(&legs, "Walk"), 0, WALK_TICKS);
    assert_eq!(digest, again, "the same script plants the same feet");
    assert_eq!(digest, WALK_DIGEST, "the walk's digest is the pinned one on this target ({digest:#x})");
}

#[test]
fn a_restored_animator_continues_the_planted_walk_bit_for_bit() {
    let (legs, _) = characters();
    let mut hero = playing(&legs, "Walk");
    walk(&mut hero, 0, 100);
    let snapshot = hero.snapshot();
    assert!(snapshot.get("feet").is_some(), "the snapshot carries the feet's locks");
    let mut restored = playing(&legs, "Walk");
    restored.restore(&snapshot).expect("the snapshot restores");
    assert_eq!(restored.digest(), hero.digest());
    assert_eq!(walk(&mut restored, 100, 160), walk(&mut hero, 100, 160));

    // A snapshot whose feet are not a foot snapshot is refused, the animator unchanged.
    let mut broken = snapshot.clone();
    broken.set("feet", genex_core::json::Value::from(7u32));
    let before = restored.digest();
    let refused = restored.restore(&broken).expect_err("bad feet refuse");
    assert_eq!(refused.code.wire(), "animation-asset-invalid");
    assert_eq!(restored.digest(), before);
}
