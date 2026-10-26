//! Shared builders for the integration tests.
#![allow(dead_code)]

use genex_physics::{BodyDesc, BodyFilter, BodyType, ColliderDesc, Pose, Shape, UpAxis, Vec3, World, WorldDesc};

/// A 60 Hz world with gravity along the caller's up axis.
pub fn world(up: UpAxis) -> World {
    let gravity = match up {
        UpAxis::Y => [0.0, -9.81, 0.0],
        UpAxis::Z => [0.0, 0.0, -9.81],
    };
    World::create(&WorldDesc::new(1.0 / 60.0, 1.0, gravity, up, 1.0)).expect("a valid world")
}

/// A one-collider body of `shape`.
pub fn body(key: &str, body_type: BodyType, p: Vec3, shape: Shape) -> BodyDesc {
    BodyDesc::new(key, body_type, Pose::at(p), vec![ColliderDesc::new("c", shape)])
}

/// A unit-ish box.
pub fn cube(half: f64) -> Shape {
    Shape::Box { half: [half; 3] }
}

/// A sphere.
pub fn ball(radius: f64) -> Shape {
    Shape::Sphere { radius }
}

/// Everything a caller can observe about a world, to assert a refused call changed nothing.
pub fn observe(world: &World) -> (u64, u64, String, u64, usize) {
    let bodies = world.bodies(&BodyFilter::default());
    (world.tick(), world.state_hash(), format!("{bodies:?}"), world.memory_bytes(), bodies.len())
}
