//! spawn and remove (§6.1, §6.2, §6.3, §7): every shape and option, the hostile table (each refusal
//! changes nothing), limits, memory and key order.

mod common;

use common::{ball, body, cube, observe, world};
use genex_physics::{
    Axis, BodyDesc, BodyFilter, BodyType, ColliderDesc, Groups, PhysicsError, Pose, Shape, UpAxis, World, WorldDesc,
};

const TETRA: [[f64; 3]; 4] = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];

fn hull(points: &[[f64; 3]]) -> Shape {
    Shape::Hull { points: points.to_vec() }
}

fn quad_mesh() -> Shape {
    Shape::Trimesh {
        vertices: vec![[-5.0, 0.0, -5.0], [5.0, 0.0, -5.0], [5.0, 0.0, 5.0], [-5.0, 0.0, 5.0]],
        indices: vec![[0.0, 2.0, 1.0], [0.0, 3.0, 2.0]],
    }
}

fn grid(rows: usize, cols: usize, size: [f64; 3]) -> Shape {
    Shape::Heightfield { rows: rows as f64, cols: cols as f64, heights: vec![0.0; rows * cols], size }
}

fn every_option() -> BodyDesc {
    let mut collider = ColliderDesc::new("main", Shape::Capsule { half_height: 0.5, radius: 0.25, axis: Axis::Z });
    collider.offset = Some(Pose { p: [0.0, 0.1, 0.0], q: [0.0, 0.0, 0.6, 0.8] });
    collider.mass = Some(3.0);
    collider.friction = Some(0.9);
    collider.restitution = Some(0.2);
    collider.groups = Some(Groups { member: 1.0, collides: 65_535.0 });
    collider.events = true;
    let mut sensor = ColliderDesc::new("zone", ball(1.0));
    sensor.sensor = true;
    sensor.density = Some(0.0);
    let mut desc = BodyDesc::new("player.1", BodyType::Dynamic, Pose::at([0.0, 2.0, 0.0]), vec![collider, sensor]);
    desc.linvel = Some([1.0, 0.0, 0.0]);
    desc.angvel = Some([0.0, 0.5, 0.0]);
    desc.linear_damping = Some(0.1);
    desc.angular_damping = Some(0.2);
    desc.gravity_scale = Some(0.5);
    desc.lock_rotation = [true, false, true];
    desc.ccd = true;
    desc.can_sleep = false;
    desc.kind = Some("player".to_string());
    desc
}

#[test]
fn every_shape_and_body_type_spawns() {
    for up in [UpAxis::Y, UpAxis::Z] {
        let mut w = world(up);
        let rows = [
            body("box", BodyType::Dynamic, [0.0, 0.0, 5.0], cube(0.5)),
            body("sphere", BodyType::Dynamic, [3.0, 0.0, 5.0], ball(0.5)),
            body("capsule.x", BodyType::Kinematic, [6.0, 0.0, 5.0], Shape::Capsule { half_height: 1.0, radius: 0.2, axis: Axis::X }),
            body("capsule.y", BodyType::Dynamic, [9.0, 0.0, 5.0], Shape::Capsule { half_height: 0.0, radius: 0.2, axis: Axis::Y }),
            body("hull", BodyType::Dynamic, [12.0, 0.0, 5.0], hull(&TETRA)),
            body("mesh", BodyType::Fixed, [0.0, 0.0, -20.0], quad_mesh()),
            body("terrain", BodyType::Fixed, [0.0, 0.0, -40.0], grid(3, 4, [10.0, 10.0, 1.0])),
            every_option(),
        ];
        for desc in &rows {
            w.spawn(desc).unwrap_or_else(|f| panic!("{} in {up:?}: {f}", desc.key));
        }
        assert_eq!(w.bodies(&BodyFilter::default()).len(), rows.len());
        let player = w.body("player.1").expect("spawned");
        assert_eq!(player.kind.as_deref(), Some("player"));
        assert_eq!(player.linvel, [1.0, 0.0, 0.0]);
        assert_eq!(player.angvel, [0.0, 0.5, 0.0]);
        for _ in 0..3 {
            w.step().expect("steps");
        }
    }
}

#[test]
fn a_spawned_pose_reads_back_bit_for_bit_in_either_frame() {
    for up in [UpAxis::Y, UpAxis::Z] {
        let mut w = world(up);
        let pose = Pose { p: [1.5, -2.25, 3.0e-3], q: [0.0, 0.6, 0.0, 0.8] };
        w.spawn(&BodyDesc::new("post", BodyType::Fixed, pose, vec![ColliderDesc::new("c", cube(0.5))]))
            .expect("spawns");
        for _ in 0..2 {
            let state = w.body("post").expect("there");
            assert_eq!(state.pose.p.map(|v| (v as f32).to_bits()), pose.p.map(|v| (v as f32).to_bits()), "{up:?}");
            assert_eq!(state.pose.q.map(|v| (v as f32).to_bits()), pose.q.map(|v| (v as f32).to_bits()), "{up:?}");
            assert!(state.sleeping, "fixed bodies report asleep");
            w.step().expect("steps");
        }
    }
}

#[test]
fn spawn_renormalises_a_nearly_unit_rotation() {
    let mut w = world(UpAxis::Y);
    let pose = Pose { p: [0.0, 0.0, 0.0], q: [0.0, 0.0, 0.0, 1.000_05] };
    w.spawn(&BodyDesc::new("a", BodyType::Fixed, pose, vec![ColliderDesc::new("c", cube(0.5))])).expect("within 1e-4");
    assert_eq!(w.body("a").expect("there").pose.q, [0.0, 0.0, 0.0, 1.0]);
}

/// A dynamic box with one edit applied.
fn edited(edit: impl Fn(&mut BodyDesc)) -> BodyDesc {
    let mut desc = body("crate", BodyType::Dynamic, [0.0, 5.0, 0.0], cube(0.5));
    edit(&mut desc);
    desc
}

fn shaped(body_type: BodyType, shape: Shape) -> BodyDesc {
    body("crate", body_type, [0.0, 5.0, 0.0], shape)
}

fn collider(edit: impl Fn(&mut ColliderDesc)) -> BodyDesc {
    edited(|d| edit(&mut d.colliders[0]))
}

fn hostile_rows() -> Vec<(&'static str, BodyDesc, PhysicsError)> {
    let nan = f64::NAN;
    vec![
        ("p NaN", edited(|d| d.pose.p = [nan, 0.0, 0.0]), PhysicsError::NonFinite),
        ("p 1e39", edited(|d| d.pose.p = [0.0, 1e39, 0.0]), PhysicsError::NonFinite),
        ("p past worldExtent", edited(|d| d.pose.p = [0.0, 0.0, 100_001.0]), PhysicsError::OutOfRange),
        ("q not unit", edited(|d| d.pose.q = [0.0, 0.0, 0.0, 2.0]), PhysicsError::OutOfRange),
        ("q zero", edited(|d| d.pose.q = [0.0; 4]), PhysicsError::OutOfRange),
        ("q NaN", edited(|d| d.pose.q = [nan, 0.0, 0.0, 1.0]), PhysicsError::NonFinite),
        ("linvel on fixed", edited(|d| {
            d.body_type = BodyType::Fixed;
            d.linvel = Some([1.0, 0.0, 0.0]);
        }), PhysicsError::OutOfRange),
        ("angvel on kinematic", edited(|d| {
            d.body_type = BodyType::Kinematic;
            d.angvel = Some([1.0, 0.0, 0.0]);
        }), PhysicsError::OutOfRange),
        ("linvel past maxSpeed", edited(|d| d.linvel = Some([800.0, 800.0, 0.0])), PhysicsError::OutOfRange),
        ("angvel past maxAngularSpeed", edited(|d| d.angvel = Some([0.0, 1_001.0, 0.0])), PhysicsError::OutOfRange),
        ("linvel NaN", edited(|d| d.linvel = Some([nan, 0.0, 0.0])), PhysicsError::NonFinite),
        ("negative damping", edited(|d| d.linear_damping = Some(-1.0)), PhysicsError::OutOfRange),
        ("NaN angular damping", edited(|d| d.angular_damping = Some(nan)), PhysicsError::NonFinite),
        ("NaN gravityScale", edited(|d| d.gravity_scale = Some(nan)), PhysicsError::NonFinite),
        ("no colliders", edited(|d| d.colliders.clear()), PhysicsError::OutOfRange),
        ("box zero", shaped(BodyType::Dynamic, Shape::Box { half: [0.5, 0.0, 0.5] }), PhysicsError::BadShape),
        ("box negative", shaped(BodyType::Dynamic, Shape::Box { half: [0.5, -1.0, 0.5] }), PhysicsError::OutOfRange),
        ("sphere zero", shaped(BodyType::Dynamic, ball(0.0)), PhysicsError::BadShape),
        ("sphere NaN", shaped(BodyType::Dynamic, ball(nan)), PhysicsError::NonFinite),
        ("capsule zero radius", shaped(BodyType::Dynamic, Shape::Capsule { half_height: 1.0, radius: 0.0, axis: Axis::Y }), PhysicsError::BadShape),
        ("capsule negative", shaped(BodyType::Dynamic, Shape::Capsule { half_height: -1.0, radius: 0.5, axis: Axis::Y }), PhysicsError::OutOfRange),
        ("hull of three", shaped(BodyType::Dynamic, hull(&TETRA[..3])), PhysicsError::BadShape),
        ("flat hull", shaped(BodyType::Dynamic, hull(&[[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 0.0, 1.0], [0.0, 0.0, 1.0]])), PhysicsError::BadShape),
        ("hull NaN", shaped(BodyType::Dynamic, hull(&[[nan, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]])), PhysicsError::NonFinite),
        ("trimesh dynamic", shaped(BodyType::Dynamic, quad_mesh()), PhysicsError::DynamicMesh),
        ("heightfield kinematic", shaped(BodyType::Kinematic, grid(2, 2, [1.0, 1.0, 1.0])), PhysicsError::DynamicMesh),
        ("trimesh no triangles", shaped(BodyType::Fixed, Shape::Trimesh { vertices: vec![[0.0; 3]], indices: vec![] }), PhysicsError::BadShape),
        ("trimesh index past end", shaped(BodyType::Fixed, Shape::Trimesh { vertices: vec![[0.0; 3]; 3], indices: vec![[0.0, 1.0, 3.0]] }), PhysicsError::OutOfRange),
        ("trimesh no vertices", shaped(BodyType::Fixed, Shape::Trimesh { vertices: vec![], indices: vec![[0.0, 0.0, 0.0]] }), PhysicsError::OutOfRange),
        ("trimesh index 1.5", shaped(BodyType::Fixed, Shape::Trimesh { vertices: vec![[0.0; 3]; 3], indices: vec![[0.0, 1.5, 2.0]] }), PhysicsError::OutOfRange),
        ("heightfield one row", shaped(BodyType::Fixed, grid(1, 4, [1.0, 1.0, 1.0])), PhysicsError::OutOfRange),
        ("heightfield rows 2.5", shaped(BodyType::Fixed, Shape::Heightfield { rows: 2.5, cols: 2.0, heights: vec![0.0; 4], size: [1.0; 3] }), PhysicsError::OutOfRange),
        ("heightfield short", shaped(BodyType::Fixed, Shape::Heightfield { rows: 2.0, cols: 2.0, heights: vec![0.0; 3], size: [1.0; 3] }), PhysicsError::OutOfRange),
        ("heightfield NaN height", shaped(BodyType::Fixed, Shape::Heightfield { rows: 2.0, cols: 2.0, heights: vec![0.0, nan, 0.0, 0.0], size: [1.0; 3] }), PhysicsError::NonFinite),
        ("heightfield zero size", shaped(BodyType::Fixed, grid(2, 2, [1.0, 0.0, 1.0])), PhysicsError::BadShape),
        ("density and mass", collider(|c| {
            c.density = Some(1.0);
            c.mass = Some(1.0);
        }), PhysicsError::OutOfRange),
        ("negative density", collider(|c| c.density = Some(-1.0)), PhysicsError::OutOfRange),
        ("negative mass", collider(|c| c.mass = Some(-1.0)), PhysicsError::OutOfRange),
        ("negative friction", collider(|c| c.friction = Some(-0.1)), PhysicsError::OutOfRange),
        ("NaN restitution", collider(|c| c.restitution = Some(nan)), PhysicsError::NonFinite),
        ("group past 16 bits", collider(|c| c.groups = Some(Groups { member: 65_536.0, collides: 1.0 })), PhysicsError::OutOfRange),
        ("group 1.5", collider(|c| c.groups = Some(Groups { member: 1.0, collides: 1.5 })), PhysicsError::OutOfRange),
        ("negative group", collider(|c| c.groups = Some(Groups { member: -1.0, collides: 1.0 })), PhysicsError::OutOfRange),
        ("offset q", collider(|c| c.offset = Some(Pose { p: [0.0; 3], q: [0.0, 0.0, 0.0, 0.5] })), PhysicsError::OutOfRange),
        ("offset NaN", collider(|c| c.offset = Some(Pose { p: [nan, 0.0, 0.0], q: [0.0, 0.0, 0.0, 1.0] })), PhysicsError::NonFinite),
        ("two colliders, one key", edited(|d| d.colliders.push(ColliderDesc::new("c", ball(0.2)))), PhysicsError::DuplicateKey),
        ("the ground's key", edited(|d| d.key = "ground".to_string()), PhysicsError::DuplicateKey),
    ]
}

#[test]
fn hostile_spawns_are_refused_with_their_code_and_change_nothing() {
    for up in [UpAxis::Y, UpAxis::Z] {
        let mut w = world(up);
        w.spawn(&body("ground", BodyType::Fixed, [0.0, 0.0, 0.0], cube(5.0))).expect("ground");
        w.spawn(&body("ball", BodyType::Dynamic, [0.0, 0.0, 9.0], ball(0.5))).expect("ball");
        w.step().expect("steps");
        let before = observe(&w);
        for (name, desc, expected) in hostile_rows() {
            let refused = w.spawn(&desc).err().map(|f| f.code);
            assert_eq!(refused, Some(expected), "{name} in {up:?}");
            assert_eq!(observe(&w), before, "{name} changed the world");
        }
    }
}

fn limited_world(edit: impl Fn(&mut WorldDesc)) -> World {
    let mut desc = WorldDesc::new(1.0 / 60.0, 1.0, [0.0, -9.81, 0.0], UpAxis::Y, 1.0);
    edit(&mut desc);
    World::create(&desc).expect("valid world")
}

#[test]
fn each_limit_refuses_with_its_code_and_changes_nothing() {
    let mut w = limited_world(|d| {
        d.limits.bodies = Some(2.0);
        d.limits.colliders_per_body = Some(2.0);
        d.limits.hull_vertices = Some(4.0);
        d.limits.triangles = Some(1.0);
        d.limits.ccd_bodies = Some(0.0);
        d.limits.heightfield_samples = Some(4.0);
    });
    w.spawn(&body("ground", BodyType::Fixed, [0.0, -1.0, 0.0], cube(5.0))).expect("ground");
    let before = observe(&w);
    let pentahedron = [TETRA[0], TETRA[1], TETRA[2], TETRA[3], [1.0, 1.0, 1.0]];
    let rows = [
        ("three colliders", edited(|d| {
            d.colliders.push(ColliderDesc::new("c2", ball(0.1)));
            d.colliders.push(ColliderDesc::new("c3", ball(0.1)));
        }), PhysicsError::LimitColliders),
        ("five hull points", shaped(BodyType::Dynamic, hull(&pentahedron)), PhysicsError::LimitHullVertices),
        ("two triangles", shaped(BodyType::Fixed, quad_mesh()), PhysicsError::LimitTriangles),
        ("ccd", edited(|d| d.ccd = true), PhysicsError::LimitCcd),
        ("nine samples", shaped(BodyType::Fixed, grid(3, 3, [1.0; 3])), PhysicsError::OutOfRange),
    ];
    for (name, desc, expected) in rows {
        assert_eq!(w.spawn(&desc).err().map(|f| f.code), Some(expected), "{name}");
        assert_eq!(observe(&w), before, "{name} changed the world");
    }
    w.spawn(&shaped(BodyType::Dynamic, hull(&TETRA))).expect("second body, four points");
    let full = observe(&w);
    let refused = w.spawn(&body("third", BodyType::Dynamic, [3.0, 5.0, 0.0], ball(0.5))).err().map(|f| f.code);
    assert_eq!(refused, Some(PhysicsError::LimitBodies));
    assert_eq!(observe(&w), full);
}

#[test]
fn a_spawn_past_memory_bytes_gives_limit_memory_and_changes_nothing() {
    let probe = limited_world(|_| {});
    let empty = probe.memory_bytes();
    let mut w = limited_world(|d| d.limits.memory_bytes = Some((empty + 4_000) as f64));
    w.spawn(&body("small", BodyType::Dynamic, [0.0, 5.0, 0.0], ball(0.5))).expect("fits");
    assert!(w.memory_bytes() > empty);
    let before = observe(&w);
    let terrain = shaped(BodyType::Fixed, grid(32, 32, [10.0, 1.0, 10.0]));
    assert_eq!(w.spawn(&terrain).err().map(|f| f.code), Some(PhysicsError::LimitMemory));
    assert_eq!(observe(&w), before);
}

#[test]
fn remove_frees_the_key_and_its_accounting() {
    let mut w = limited_world(|d| {
        d.limits.bodies = Some(1.0);
        d.limits.ccd_bodies = Some(1.0);
        d.limits.triangles = Some(2.0);
    });
    let empty = w.memory_bytes();
    let mut mesh = shaped(BodyType::Fixed, quad_mesh());
    mesh.ccd = true;
    w.spawn(&mesh).expect("spawns");
    w.remove("crate").expect("removes");
    assert_eq!(w.memory_bytes(), empty);
    assert_eq!(w.body("crate"), None);
    w.spawn(&mesh).expect("the key, the body slot, the ccd slot and the triangles are free again");
}

#[test]
fn remove_refuses_unknown_and_malformed_keys_and_changes_nothing() {
    let mut w = world(UpAxis::Y);
    w.spawn(&body("a", BodyType::Dynamic, [0.0, 1.0, 0.0], ball(0.5))).expect("spawns");
    let before = observe(&w);
    let rows = [
        ("b", PhysicsError::UnknownKey),
        ("static:box:0000", PhysicsError::UnknownKey),
        ("", PhysicsError::InvalidKey),
        ("a b", PhysicsError::InvalidKey),
        ("constructor", PhysicsError::InvalidKey),
    ];
    for (key, expected) in rows {
        assert_eq!(w.remove(key).err().map(|f| f.code), Some(expected), "{key:?}");
        assert_eq!(observe(&w), before);
    }
}

#[test]
fn bodies_are_listed_in_byte_order_of_their_keys() {
    let mut w = world(UpAxis::Y);
    for (i, key) in ["b", "a", "c", "B", "a.1", "_", "9"].iter().enumerate() {
        w.spawn(&body(key, BodyType::Dynamic, [i as f64 * 3.0, 1.0, 0.0], ball(0.5))).expect("spawns");
    }
    let keys: Vec<String> = w.bodies(&BodyFilter::default()).into_iter().map(|b| b.key).collect();
    assert_eq!(keys, ["9", "B", "_", "a", "a.1", "b", "c"]);
}

/// A 5 × 5 heightfield whose two highest-ground2 rows are a plateau at height 2 (caller rows 3, 4).
fn plateau(up: UpAxis) -> BodyDesc {
    let heights: Vec<f64> = (0..5).flat_map(|row| [if row >= 3 { 2.0 } else { 0.0 }; 5]).collect();
    let size = match up {
        UpAxis::Y => [8.0, 1.0, 8.0],
        UpAxis::Z => [8.0, 8.0, 1.0],
    };
    let shape = Shape::Heightfield { rows: 5.0, cols: 5.0, heights, size };
    body("terrain", BodyType::Fixed, [0.0, 0.0, 0.0], shape)
}

/// Where a ball dropped over ground point (x, g) comes to rest, as its height along the caller's up.
fn rest_height(up: UpAxis, x: f64, g: f64) -> f64 {
    let mut w = world(up);
    w.spawn(&plateau(up)).expect("terrain");
    let start = match up {
        UpAxis::Y => [x, 4.0, g],
        UpAxis::Z => [x, g, 4.0],
    };
    w.spawn(&body("ball", BodyType::Dynamic, start, ball(0.25))).expect("ball");
    for _ in 0..180 {
        w.step().expect("steps");
    }
    let p = w.body("ball").expect("there").pose.p;
    match up {
        UpAxis::Y => p[1],
        UpAxis::Z => p[2],
    }
}

#[test]
fn heightfield_rows_lie_along_the_callers_second_ground_axis_in_both_frames() {
    for up in [UpAxis::Y, UpAxis::Z] {
        let high = rest_height(up, 0.5, 3.0);
        let low = rest_height(up, 0.5, -3.0);
        assert!((high - 2.25).abs() < 0.05, "{up:?}: the plateau side rests at {high}");
        assert!((low - 0.25).abs() < 0.05, "{up:?}: the low side rests at {low}");
    }
}
