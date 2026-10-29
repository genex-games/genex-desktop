//! R-19 (NAV-18's update and search budgets): the faster border walk, avoidance step and A* keep
//! every bit. A crowd crossing a pillar field (border obstacles on every side, tile boundary links,
//! repaths) and one long search are pinned to the digests recorded before R-19 changed them.

use std::sync::Arc;

use genex_core::digest::fnv1a64_from;
use genex_nav::input::HeightGrid;
use genex_nav::world::NavMesh;
use genex_nav::{Nav, NavAgent, NavArea, NavConfig, NavFilter, NavInput};
use glam::{Mat4, Quat, Vec3};

/// The digest of every agent's desired-velocity bits over [`TICKS`] ticks, before R-19.
const CROWD_DIGEST: u64 = 0xa600_7226_a579_e84b;
/// The digest of the corner-to-corner path's debug text, before R-19.
const PATH_DIGEST: u64 = 0xe1dc_b8e2_3c63_7759;

const AGENTS: usize = 48;
const TICKS: usize = 240;
const FIELD_HALF: f32 = 32.0;
const PILLAR_STEP: f32 = 5.5;
const PILLAR_HALF: f32 = 0.6;
const DT: f32 = 1.0 / 60.0;
/// FNV-1a 64's offset basis.
const FNV_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;

fn config() -> NavConfig {
    NavConfig::walker(0.4, 1.8).with_tile(16.0)
}

/// A flat field with a pillar every [`PILLAR_STEP`] metres, in 16 m tiles.
fn pillar_field() -> NavInput {
    let samples = (FIELD_HALF * 2.0) as u32 + 1;
    let grid = Arc::new(HeightGrid::from_fn((samples, samples), [-FIELD_HALF, -FIELD_HALF], 1.0, |_, _| 0.0).expect("a flat grid"));
    let mut input = NavInput::new().with_terrain(grid, NavArea::WALK).expect("terrain");
    let count = (FIELD_HALF * 2.0 / PILLAR_STEP) as i32;
    for i in 1..count {
        for j in 1..count {
            let (x, z) = (-FIELD_HALF + i as f32 * PILLAR_STEP, -FIELD_HALF + j as f32 * PILLAR_STEP);
            let pillar = Mat4::from_scale_rotation_translation(Vec3::new(PILLAR_HALF, 1.5, PILLAR_HALF) * 2.0, Quat::IDENTITY, Vec3::new(x, 1.5, z));
            input.add_box(pillar, NavArea::NONE).expect("a pillar");
        }
    }
    input
}

/// Agent `i`'s start (or, `far`, its target across the field).
fn spot(i: usize, far: bool) -> Vec3 {
    let turn = i as f32 / AGENTS as f32 * std::f32::consts::TAU + if far { std::f32::consts::PI } else { 0.0 };
    let radius = FIELD_HALF - 4.0 - (i % 4) as f32 * 3.0;
    // glam's libm sine and cosine: the same bits on every destination.
    let direction = glam::Vec2::from_angle(turn);
    Vec3::new(radius * direction.x + PILLAR_STEP * 0.5, 0.0, radius * direction.y + PILLAR_STEP * 0.5)
}

#[test]
fn a_crowd_and_a_search_keep_the_bits_they_had_before_r19() {
    let mesh = NavMesh::bake(&pillar_field(), &config()).expect("bakes");
    let mut nav = Nav::new(&config());
    nav.add_mesh(&mesh).expect("the mesh goes in");
    let agents: Vec<_> = (0..AGENTS)
        .map(|i| {
            let agent = nav.add_agent(NavAgent::new(spot(i, false)).with_speed(2.4, 3.2)).expect("an agent");
            nav.move_to(agent, spot(i, true));
            agent
        })
        .collect();
    let mut crowd = FNV_OFFSET_BASIS;
    for _ in 0..TICKS {
        nav.update(DT);
        for agent in &agents {
            let velocity = nav.desired_velocity(*agent);
            for component in [velocity.x, velocity.y, velocity.z] {
                crowd = fnv1a64_from(&component.to_bits().to_le_bytes(), crowd);
            }
            let at = nav.position(*agent).unwrap_or_default();
            nav.set_position(*agent, at + velocity * DT, velocity);
        }
    }
    let (from, to) = (Vec3::new(-FIELD_HALF + 2.0, 0.0, -FIELD_HALF + 2.0), Vec3::new(FIELD_HALF - 2.0, 0.0, FIELD_HALF - 2.0));
    let path = nav.path(from, to, &NavFilter::new()).expect("a path corner to corner");
    let path_digest = fnv1a64_from(format!("{path:?}").as_bytes(), FNV_OFFSET_BASIS);
    println!("crowd {crowd:#018x} path {path_digest:#018x}");
    assert_eq!((crowd, path_digest), (CROWD_DIGEST, PATH_DIGEST), "the crowd's and the path's bits are the ones before R-19");
}
