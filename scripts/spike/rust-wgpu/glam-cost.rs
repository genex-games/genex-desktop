//! M0a.9 cost of the determinism configuration in the pond scene (spike only). `parity.sh cost`
//! builds this file twice in a throwaway Cargo package against the vendored crates:
//!
//! - `deterministic`: Rapier `enhanced-determinism` plus glam `scalar-math` and `libm`, the lane's
//!   configuration (every glam 0.33 user runs scalar libm math by feature unification);
//! - `simd`: the same crates with default features (glam's NEON/SSE2 paths, Rapier's default math).
//!
//!   glam-cost <ticks> <draws> [repeats]
//!
//! The workload is the pond scene's CPU work per tick, rebuilt from `examples/pond`: a Rapier world
//! with the pond bed and six buoyant floaters plus a bobber (the same shapes, densities, damping and
//! the buoyancy and drag forces the pond applies each tick), stepped at 1/60 s; then the frame
//! build's glam work for `<draws>` draws (the count the parity probe measured in the real pond):
//! model matrix from scale/rotation/translation, normal matrix (inverse transpose), view-projection
//! product and the six-plane frustum test the CPU-culled reference runs. It prints one JSON line:
//! the build's glam layout (Vec4 alignment 16 = SIMD, 4 = scalar), and p50/mean microseconds for
//! the physics tick and the frame build over `repeats` runs of `<ticks>` ticks.

use glam::{Mat4, Quat, Vec3, Vec4};
use rapier3d::prelude::{ColliderBuilder, PhysicsWorld, RigidBodyBuilder, RigidBodyHandle, Vector};
use std::hint::black_box;
use std::time::Instant;

const FLOATERS: usize = 6;
const FLOATER_RADIUS: f32 = 0.35;
const BOBBER_RADIUS: f32 = 0.2;
const BUOYANCY: f32 = 2.2;
const WATER_DRAG: f32 = 2.5;
const GRAVITY: f32 = 9.81;
const WATER_LEVEL: f32 = 0.0;
const CAMERA_EYE: Vec3 = Vec3::new(0.0, 9.0, 14.0);
const ASPECT: f32 = 16.0 / 9.0;
const FOVY_DEGREES: f32 = 45.0;
const DEFAULT_REPEATS: usize = 5;

#[cfg(feature = "deterministic")]
const CONFIGURATION: &str = "deterministic";
#[cfg(not(feature = "deterministic"))]
const CONFIGURATION: &str = "simd";

fn pond_world() -> (PhysicsWorld, Vec<(RigidBodyHandle, f32)>) {
    let mut world = PhysicsWorld::default();
    world.insert_collider(ColliderBuilder::cuboid(8.0, 0.5, 8.0).translation(Vector::new(0.0, -2.5, 0.0)), None);
    let mut floating = Vec::new();
    for i in 0..FLOATERS {
        // Fixed placements in the pond's spawn ranges (angle step, distance 1.5..4, height 1..3).
        let angle = core::f32::consts::TAU * i as f32 / FLOATERS as f32;
        let distance = 1.5 + 0.4 * i as f32;
        let at = Vector::new(libm::cosf(angle) * distance, 1.0 + 0.3 * i as f32, libm::sinf(angle) * distance);
        let body = RigidBodyBuilder::dynamic().translation(at).angular_damping(1.0);
        let (handle, _) = world.insert(body, ColliderBuilder::ball(FLOATER_RADIUS).density(0.6).restitution(0.1));
        floating.push((handle, FLOATER_RADIUS));
    }
    let bobber = RigidBodyBuilder::dynamic().translation(Vector::new(0.4, 1.5, 2.5)).angular_damping(1.0);
    let (handle, _) = world.insert(bobber, ColliderBuilder::ball(BOBBER_RADIUS).density(0.4));
    floating.push((handle, BOBBER_RADIUS));
    (world, floating)
}

/// The pond's `float`: lift by the submerged fraction, drag by velocity.
fn float(world: &mut PhysicsWorld, handle: RigidBodyHandle, radius: f32) {
    let Some(body) = world.bodies.get_mut(handle) else { return };
    let bottom = body.translation().y - radius;
    let submerged = ((WATER_LEVEL - bottom) / (2.0 * radius)).clamp(0.0, 1.0);
    body.reset_forces(false);
    if submerged > 0.0 {
        let mass = body.mass();
        let lift = Vector::new(0.0, mass * GRAVITY * BUOYANCY * submerged, 0.0);
        let drag = -body.linvel() * (mass * WATER_DRAG * submerged);
        body.add_force(lift + drag, true);
    }
}

fn frustum_planes(view_proj: Mat4) -> [Vec4; 6] {
    let rows = [view_proj.row(0), view_proj.row(1), view_proj.row(2), view_proj.row(3)];
    let planes = [rows[3] + rows[0], rows[3] - rows[0], rows[3] + rows[1], rows[3] - rows[1], rows[2], rows[3] - rows[2]];
    planes.map(|p| p / p.truncate().length())
}

/// The frame build's glam work for `draws` draws; answers the number of visible draws.
fn build_frame(world: &PhysicsWorld, floating: &[(RigidBodyHandle, f32)], draws: usize) -> usize {
    let proj = Mat4::perspective_rh(FOVY_DEGREES.to_radians(), ASPECT, 0.1, 1000.0);
    let view_proj = proj * Mat4::look_at_rh(CAMERA_EYE, Vec3::ZERO, Vec3::Y);
    let planes = frustum_planes(view_proj);
    let mut visible = 0;
    for i in 0..draws {
        let (translation, rotation, scale) = match floating.get(i % floating.len()).and_then(|(h, _)| world.bodies.get(*h)) {
            Some(body) => (body.translation(), *body.rotation(), Vec3::splat(1.0 + i as f32 * 1.0e-3)),
            None => (Vec3::ZERO, Quat::IDENTITY, Vec3::ONE),
        };
        let model = Mat4::from_scale_rotation_translation(scale, rotation, translation);
        let normal = if model.determinant() == 0.0 { Mat4::IDENTITY } else { model.inverse().transpose() };
        let clip = view_proj * model;
        let center = model.transform_point3(Vec3::ZERO).extend(1.0);
        let radius = scale.max_element();
        if planes.iter().all(|p| p.dot(center) >= -radius) {
            visible += 1;
        }
        black_box((normal, clip));
    }
    visible
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    sorted[((p / 100.0) * (sorted.len().saturating_sub(1)) as f64).round() as usize]
}

fn stats(mut samples: Vec<f64>) -> String {
    samples.sort_by(f64::total_cmp);
    let mean = samples.iter().sum::<f64>() / samples.len().max(1) as f64;
    format!("{{\"p50\":{:.3},\"p95\":{:.3},\"mean\":{:.3}}}", percentile(&samples, 50.0), percentile(&samples, 95.0), mean)
}

fn main() {
    let args: Vec<usize> = std::env::args().skip(1).filter_map(|a| a.parse().ok()).collect();
    let (Some(&ticks), Some(&draws)) = (args.first(), args.get(1)) else {
        eprintln!("usage: glam-cost <ticks> <draws> [repeats]");
        std::process::exit(2);
    };
    let repeats = args.get(2).copied().unwrap_or(DEFAULT_REPEATS).max(1);
    let (mut tick_us, mut frame_us, mut visible) = (Vec::new(), Vec::new(), 0);
    for _ in 0..repeats {
        let (mut world, floating) = pond_world();
        for _ in 0..ticks {
            let started = Instant::now();
            for (handle, radius) in &floating {
                float(&mut world, *handle, *radius);
            }
            world.step();
            tick_us.push(started.elapsed().as_secs_f64() * 1.0e6);
            let started = Instant::now();
            visible = build_frame(&world, &floating, draws);
            frame_us.push(started.elapsed().as_secs_f64() * 1.0e6);
        }
    }
    println!(
        "{{\"format\":\"genex-glam-cost/1\",\"configuration\":\"{CONFIGURATION}\",\"vec4Align\":{},\"mat4Align\":{},\"ticks\":{ticks},\"repeats\":{repeats},\"draws\":{draws},\"visible\":{visible},\"tickUs\":{},\"frameBuildUs\":{}}}",
        core::mem::align_of::<Vec4>(),
        core::mem::align_of::<Mat4>(),
        stats(tick_us),
        stats(frame_us),
    );
}
