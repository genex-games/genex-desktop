//! AN-19 through the facade (new behaviour: the facade's `character` module was a stub). A game
//! spawns a character into `sim.physics` in `on_reset` and drives it in `on_update` before the
//! runtime's physics step:
//!
//! - two runtimes give the same checksum every 60 ticks over 600 ticks (the character's digest is a
//!   game probe, so it is in the checksum);
//! - `seed(2)` then `seed(1)` equals a fresh `seed(1)` (game systems plan 4.4, row 4);
//! - `character.nav_config()` (the prelude's `CharacterNav`) bakes a walker with the controller's
//!   climb and slope, and a character's transform converts into a facade `Transform`;
//! - `character-shape-invalid` is the refusal a game sees.
//!
//! genex-anim's own rows (`crates/genex-anim/tests/character.rs`) cover the controller's
//! behaviour; this file proves the facade path.

#![cfg(feature = "physics")]

use genex::physics::ColliderBuilder;
use genex::prelude::*;
use genex::{CharacterErrorCode, CharacterParams, Runtime};
use genex_core::digest::hex64;
use serde_json::json;

const TICKS: u64 = 600;
/// Ticks between checksum comparisons.
const EVERY: u64 = 60;

#[derive(Default)]
struct World {
    hero: Option<Character>,
    landings: u32,
}

/// A ground slab, a 0.25 m stair and a wall, then the hero, placed by the seed.
fn character_game() -> Game<World> {
    let mut game = Game::new(World::default());
    game.on_reset(|sim, seed, _, _| {
        sim.physics.insert_collider(ColliderBuilder::cuboid(40.0, 0.5, 40.0).translation(vec3(0.0, -0.5, 0.0)), None);
        sim.physics.insert_collider(ColliderBuilder::cuboid(3.0, 0.125, 3.0).translation(vec3(0.0, 0.125, 5.0)), None);
        sim.physics.insert_collider(ColliderBuilder::cuboid(0.5, 2.0, 10.0).translation(vec3(6.0, 2.0, 0.0)), None);
        let feet = vec3((seed % 5) as f32 - 2.0, 0.0, -2.0);
        sim.world.hero = Some(Character::spawn(&mut sim.physics, feet, CharacterParams::default()).expect("default parameters"));
    });
    game.on_update(|sim, ctx| {
        let angle = ctx.tick as f32 * 0.02;
        let wish = vec3(Vec2::from_angle(angle).x, 0.0, Vec2::from_angle(angle).y) * 3.0;
        let jump = ctx.tick % 120 == 60;
        let (world, physics) = sim.split();
        let Some(hero) = world.hero.as_mut() else { return };
        let step = hero.drive(physics, CharacterMotion::Velocity { wish, jump }, ctx.dt);
        if step.landed {
            world.landings += 1;
        }
    });
    game.probe("hero", |sim| {
        let Some(hero) = sim.world.hero.as_ref() else { return json!(null) };
        json!({ "digest": hex64(hero.digest()), "grounded": hero.grounded(), "landings": sim.world.landings })
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
fn two_runtimes_drive_the_character_to_the_same_checksums() {
    let mut first = Runtime::new(character_game()).expect("installs");
    first.start();
    let mut second = Runtime::new(character_game()).expect("installs");
    second.start();
    let a = checksums(&mut first);
    let b = checksums(&mut second);
    assert_eq!(a, b);
    let probes = first.probes();
    assert!(probes["hero"]["landings"].as_u64().unwrap_or(0) >= 3, "the hero jumped and landed: {}", probes["hero"]);
}

#[test]
fn reseeding_gives_the_fresh_seeds_run() {
    let mut fresh = Runtime::new(character_game()).expect("installs");
    fresh.seed(1);
    fresh.start();
    let expected = checksums(&mut fresh);

    let mut reseeded = Runtime::new(character_game()).expect("installs");
    reseeded.seed(2);
    reseeded.start();
    let other = checksums(&mut reseeded);
    reseeded.seed(1);
    reseeded.start();
    let again = checksums(&mut reseeded);
    assert_ne!(other, expected, "seed 2 places the hero elsewhere");
    assert_eq!(again, expected, "seed 1 after seed 2 replays a fresh seed 1");
}

#[test]
fn nav_config_matches_the_controller_and_the_transform_converts() {
    let params = CharacterParams { step_height: 0.25, max_slope_degrees: 40.0, ..CharacterParams::default() };
    let mut world = PhysicsWorld::default();
    let character = Character::spawn(&mut world, vec3(1.0, 2.0, 3.0), params).expect("valid");
    let config = character.nav_config();
    assert_eq!((config.climb(), config.slope()), (0.25, 40.0));
    let transform: Transform = character.transform().into();
    assert_eq!(transform.translation, vec3(1.0, 2.0, 3.0));
    assert_eq!(transform.rotation, Quat::IDENTITY);
    let refused = Character::spawn(&mut world, Vec3::ZERO, CharacterParams { radius: -1.0, ..params }).expect_err("a negative radius");
    assert_eq!(refused.code, CharacterErrorCode::ShapeInvalid);
    assert_eq!(refused.code.wire(), "character-shape-invalid");
}
