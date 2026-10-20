//! AN-20 through the facade (new behaviour: the facade's `ragdoll` module was a stub). A game
//! builds a humanoid ragdoll into `sim.physics` in `on_reset` (over a genex-anim animator, until
//! AN-15 puts the animator on the facade), follows the animation and goes limp at tick 30 in
//! `on_update`, before the runtime's physics step:
//!
//! - two runtimes give the same checksum every 60 ticks over 300 ticks (the ragdoll's physics
//!   digest is a game probe, so it is in the checksum);
//! - `seed(2)` then `seed(1)` equals a fresh `seed(1)`;
//! - `ragdoll-profile-invalid` is the refusal a game sees.
//!
//! genex-anim's own rows (`crates/genex-anim/tests/ragdoll.rs`) cover the ragdoll's behaviour.

#![cfg(feature = "physics")]

#[path = "../../genex-anim/tests/support/mod.rs"]
mod rigs;

use std::sync::Arc;

use genex::physics::ColliderBuilder;
use genex::prelude::*;
use genex::{AnimationErrorCode, HumanoidBone, Ragdoll, RagdollMode, RagdollPart, RagdollProfile, Runtime};
use genex_anim::animator::{AnimSet, Animator};
use genex_anim::graph::{AnimGraph, Motion};
use genex_anim::import::import_rig;
use genex_core::digest::hex64;
use serde_json::json;

const TICKS: u64 = 300;
/// Ticks between checksum comparisons.
const EVERY: u64 = 60;

/// genex-anim's humanoid fixture with no clip: the animator holds the rest pose.
fn humanoid_animator() -> Animator {
    let rig = import_rig(&rigs::humanoid22().glb()).expect("genex-anim imports the fixture");
    let set = Arc::new(AnimSet::new(rig.skeleton().clone(), Vec::new()));
    let mut g = AnimGraph::builder(set.skeleton(), set.clips());
    let base = g.layer("base");
    g.state(base, "rest", Motion::Empty);
    let graph = g.build().expect("a graph");
    Animator::new(set, &graph).expect("an animator")
}

#[derive(Default)]
struct World {
    animator: Option<Animator>,
    ragdoll: Option<Ragdoll>,
}

fn ragdoll_game() -> Game<World> {
    let mut game = Game::new(World::default());
    game.on_reset(|sim, seed, _, _| {
        sim.physics.insert_collider(ColliderBuilder::cuboid(40.0, 0.5, 40.0).translation(vec3(0.0, -0.5, 0.0)), None);
        let animator = humanoid_animator();
        let model = Mat4::from_translation(vec3(seed as f32 * 0.5, 0.05, 0.0));
        sim.world.ragdoll = Some(Ragdoll::build(&mut sim.physics, &animator, model, &RagdollProfile::humanoid()).expect("the humanoid builds"));
        sim.world.animator = Some(animator);
    });
    game.on_update(|sim, ctx| {
        let (world, physics) = sim.split();
        let (Some(animator), Some(ragdoll)) = (world.animator.as_mut(), world.ragdoll.as_mut()) else { return };
        animator.update(ctx.dt);
        ragdoll.follow(physics, animator, Mat4::IDENTITY);
        if ctx.tick == 30 {
            ragdoll.go_limp(physics, RagdollPart::Whole, vec3(0.0, 0.5, 2.0));
        }
    });
    game.probe("ragdoll", |sim| {
        let Some(ragdoll) = sim.world.ragdoll.as_ref() else { return json!(null) };
        let limp = ragdoll.mode(HumanoidBone::Hips) == Some(RagdollMode::Limp);
        json!({ "digest": hex64(ragdoll.digest(&sim.physics)), "limp": limp })
    });
    game
}

fn checksums(runtime: &mut Runtime<World>) -> Vec<String> {
    (0..TICKS / EVERY)
        .map(|_| {
            for _ in 0..EVERY {
                runtime.step(genex::FIXED_STEP_MS);
            }
            runtime.checksum()
        })
        .collect()
}

#[test]
fn two_runtimes_give_the_same_ragdoll_checksums() {
    let mut first = Runtime::new(ragdoll_game()).expect("installs");
    first.start();
    let mut second = Runtime::new(ragdoll_game()).expect("installs");
    second.start();
    assert_eq!(checksums(&mut first), checksums(&mut second));
    assert_eq!(first.probes()["ragdoll"]["limp"], json!(true), "the ragdoll went limp");
}

#[test]
fn reseeding_gives_the_fresh_seeds_ragdoll() {
    let mut fresh = Runtime::new(ragdoll_game()).expect("installs");
    fresh.seed(1);
    fresh.start();
    let expected = checksums(&mut fresh);
    let mut reseeded = Runtime::new(ragdoll_game()).expect("installs");
    reseeded.seed(2);
    reseeded.start();
    let other = checksums(&mut reseeded);
    reseeded.seed(1);
    reseeded.start();
    assert_ne!(other, expected, "seed 2 builds the ragdoll elsewhere");
    assert_eq!(checksums(&mut reseeded), expected, "seed 1 after seed 2 replays a fresh seed 1");
}

#[test]
fn a_hostile_profile_is_refused_ragdoll_profile_invalid() {
    let animator = humanoid_animator();
    let mut world = PhysicsWorld::default();
    let refused = Ragdoll::build(&mut world, &animator, Mat4::IDENTITY, &RagdollProfile::humanoid().with_mass(-1.0)).expect_err("a negative mass");
    assert_eq!(refused.code, AnimationErrorCode::RagdollProfileInvalid);
    assert_eq!(refused.code.wire(), "ragdoll-profile-invalid");
}
