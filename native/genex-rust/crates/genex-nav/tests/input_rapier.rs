//! NAV-5: a physics world's colliders as bake input (new behaviour: `input_rapier` was a stub).
//!
//! - ball, capsule, cuboid, heightfield and compound colliders give triangles whose bounds are
//!   the collider's own bounds within 1e-4, posed and rotated;
//! - by default sensors, disabled colliders and dynamic or kinematic bodies give nothing, while a
//!   game's own pick may take a body's collider (never a sensor);
//! - the same insert and remove sequence gives the same input and bake digest, and a refused add
//!   leaves the input unchanged.

#![cfg(feature = "physics")]

use genex_nav::input_rapier::{ColliderView, collider_triangles};
use genex_nav::{NavArea, NavConfig, NavErrorCode, NavInput, NavMesh};
use glam::{Quat, Vec3, vec3};
use rapier3d::parry::utils::Array2;
use rapier3d::prelude::{ColliderBuilder, PhysicsWorld, RigidBodyBuilder, SharedShape};

/// How far the triangles' bounds may sit from the collider's bounds, metres.
const BOUNDS_TOLERANCE: f32 = 1.0e-4;

/// A pose that is neither axis-aligned nor at the origin.
fn tilted() -> (Vec3, Quat) {
    (vec3(3.0, 1.25, -2.0), Quat::from_euler(glam::EulerRot::YXZ, 0.7, 0.3, -0.2))
}

/// The bounds of every vertex the indices use.
fn triangle_bounds(vertices: &[Vec3], indices: &[u32]) -> (Vec3, Vec3) {
    indices.iter().map(|&i| vertices[i as usize]).fold((Vec3::INFINITY, Vec3::NEG_INFINITY), |(min, max), v| (min.min(v), max.max(v)))
}

fn assert_bounds_match(name: &str, builder: ColliderBuilder) {
    let mut physics = PhysicsWorld::new();
    let handle = physics.insert_collider(builder, None);
    let collider = &physics.colliders[handle];
    let (vertices, indices) = collider_triangles(collider).unwrap_or_else(|| panic!("{name} gives triangles"));
    assert_eq!(indices.len() % 3, 0, "{name}: three indices per triangle");
    let (min, max) = triangle_bounds(&vertices, &indices);
    let aabb = collider.compute_aabb();
    let off = (min - aabb.mins).abs().max((max - aabb.maxs).abs()).max_element();
    assert!(off <= BOUNDS_TOLERANCE, "{name}: triangle bounds {min}..{max} vs collider {}..{} ({off} m off)", aabb.mins, aabb.maxs);
}

#[test]
fn each_shape_s_triangles_span_the_collider_s_bounds() {
    let (at, turn) = tilted();
    // A turned capsule's collider bounds are its true extents, but its tessellated rings miss
    // them, so the curved shapes are placed upright (moved only) and the flat ones turned.
    assert_bounds_match("ball", ColliderBuilder::ball(0.75).translation(at));
    assert_bounds_match("capsule", ColliderBuilder::capsule_y(0.6, 0.35).translation(at));
    assert_bounds_match("turned cuboid", ColliderBuilder::cuboid(1.5, 0.25, 0.8).translation(at).rotation(turn.to_scaled_axis()));
    let heights = Array2::new(4, 5, (0..20).map(|k| ((k * 7) % 5) as f32 * 0.3).collect());
    assert_bounds_match("heightfield", ColliderBuilder::heightfield(heights, vec3(12.0, 2.0, 9.0)).translation(at));
    let parts = vec![
        (rapier3d::math::Pose::from_translation(vec3(-1.0, 0.0, 0.0)), SharedShape::cuboid(0.5, 0.5, 0.5)),
        (rapier3d::math::Pose::from_parts(vec3(1.5, 0.5, 0.25), Quat::from_rotation_y(0.4)), SharedShape::cuboid(0.25, 1.0, 0.75)),
        (rapier3d::math::Pose::from_translation(vec3(0.0, 2.0, 0.0)), SharedShape::ball(0.5)),
    ];
    // A turned compound's bounds are its local bounds turned (loose), so the parts turn instead.
    assert_bounds_match("compound", ColliderBuilder::compound(parts).translation(at));
}

#[test]
fn shapes_with_no_inside_give_nothing() {
    let mut physics = PhysicsWorld::new();
    let segment = physics.insert_collider(ColliderBuilder::segment(Vec3::ZERO, Vec3::X), None);
    let half_space = physics.insert_collider(ColliderBuilder::halfspace(rapier3d::na::Unit::new_unchecked(Vec3::Y)), None);
    assert!(collider_triangles(&physics.colliders[segment]).is_none());
    assert!(collider_triangles(&physics.colliders[half_space]).is_none());
    let input = NavInput::new().with_static_colliders(&physics, NavArea::WALK).expect("nothing to add is fine");
    assert_eq!(input.triangle_count(), 0);
}

/// A floor slab, then a sensor, a dynamic crate, a kinematic capsule and a disabled wall.
fn mixed_world() -> PhysicsWorld {
    let mut physics = PhysicsWorld::new();
    physics.insert_collider(ColliderBuilder::cuboid(10.0, 0.5, 10.0).translation(vec3(0.0, -0.5, 0.0)), None);
    physics.insert_collider(ColliderBuilder::cuboid(2.0, 2.0, 2.0).sensor(true).translation(vec3(4.0, 2.0, 0.0)), None);
    physics.insert(RigidBodyBuilder::dynamic().translation(vec3(-3.0, 1.0, 0.0)), ColliderBuilder::cuboid(0.5, 0.5, 0.5));
    physics.insert(RigidBodyBuilder::kinematic_position_based().translation(vec3(0.0, 1.0, 3.0)), ColliderBuilder::capsule_y(0.55, 0.35));
    physics.insert_collider(ColliderBuilder::cuboid(0.5, 2.0, 5.0).enabled(false).translation(vec3(-6.0, 2.0, 0.0)), None);
    physics.insert(RigidBodyBuilder::fixed().translation(vec3(6.0, 0.25, 6.0)), ColliderBuilder::cuboid(1.0, 0.25, 1.0));
    physics
}

#[test]
fn sensors_moving_bodies_and_disabled_colliders_give_nothing_by_default() {
    let physics = mixed_world();
    let input = NavInput::new().with_static_colliders(&physics, NavArea::WALK).expect("the static colliders");
    // The floor slab and the fixed body's step: two cuboids, 12 triangles each.
    assert_eq!(input.triangle_count(), 24);
    let (min, max) = input.bounds().expect("bounds");
    assert_eq!((min, max), (vec3(-10.0, -1.0, -10.0), vec3(10.0, 0.5, 10.0)), "only the slab and the step");

    // A game's own pick may take every body's colliders; sensors and disabled ones still never count.
    let everything = NavInput::new().with_colliders(&physics, |_: &ColliderView<'_>| Some(NavArea::WALK)).expect("every collider");
    let capsule = collider_triangles(physics.colliders.iter().find(|(_, c)| c.shape().as_capsule().is_some()).expect("the capsule").1).expect("capsule triangles").1.len() / 3;
    assert_eq!(everything.triangle_count(), 24 + 12 + capsule, "the slab, the step, the dynamic crate and the capsule");
}

/// The same sequence of inserts and removes, then an input and its bake.
fn sequence_world(order: &[usize]) -> PhysicsWorld {
    let boxes = [
        ColliderBuilder::cuboid(8.0, 0.5, 8.0).translation(vec3(0.0, -0.5, 0.0)),
        ColliderBuilder::cuboid(1.0, 0.15, 1.0).translation(vec3(2.0, 0.15, 2.0)),
        ColliderBuilder::cuboid(0.5, 1.0, 3.0).translation(vec3(-3.0, 1.0, 0.0)),
        ColliderBuilder::cuboid(1.5, 0.3, 0.5).translation(vec3(3.0, 0.3, -3.0)),
    ];
    let mut physics = PhysicsWorld::new();
    let mut handles = Vec::new();
    for &k in order {
        handles.push(physics.insert_collider(boxes[k].clone(), None));
    }
    // Remove the second, then add a ramp: the freed slot is reused.
    physics.remove_collider(handles[1]);
    physics.insert_collider(ColliderBuilder::cuboid(2.0, 0.1, 1.0).translation(vec3(-1.0, 0.4, 4.0)).rotation(Vec3::X * 0.2), None);
    physics
}

fn bake_digests(physics: &PhysicsWorld) -> (u64, u64) {
    let input = NavInput::new().with_static_colliders(physics, NavArea::WALK).expect("the colliders");
    let config = NavConfig::walker(0.4, 1.8).with_tile(8.0);
    let mesh = NavMesh::bake(&input, &config).expect("a mesh");
    assert!(!mesh.tiles().is_empty(), "the slab bakes ground");
    (input.digest(), mesh.digest())
}

#[test]
fn the_same_insert_sequence_gives_the_same_bake_digest() {
    let first = bake_digests(&sequence_world(&[0, 1, 2, 3]));
    let second = bake_digests(&sequence_world(&[0, 1, 2, 3]));
    assert_eq!(first, second, "the same inserts and removes give the same input and bake");
    let other = bake_digests(&sequence_world(&[0, 2, 1, 3]));
    assert_ne!(first.0, other.0, "another sequence is another input (handle order is the input order)");
}

#[test]
fn a_refused_collider_leaves_the_input_unchanged() {
    let mut physics = PhysicsWorld::new();
    physics.insert_collider(ColliderBuilder::cuboid(4.0, 0.5, 4.0), None);
    // Straight into the set: a broad phase would refuse a collider that is not finite.
    physics.colliders.insert(ColliderBuilder::cuboid(1.0, 1.0, 1.0).translation(vec3(f32::NAN, 0.0, 0.0)));
    let mut input = NavInput::new().with_triangles(&[Vec3::ZERO, Vec3::X, Vec3::Z], &[0, 2, 1], NavArea::ROAD).expect("a triangle");
    let before = input.digest();
    let refused = input.add_static_colliders(&physics, NavArea::WALK).expect_err("a collider that is not finite");
    assert_eq!(refused.code, NavErrorCode::InputInvalid);
    assert_eq!(input.digest(), before, "nothing was added, not even the good slab");
    assert_eq!(input.triangle_count(), 1);
}
