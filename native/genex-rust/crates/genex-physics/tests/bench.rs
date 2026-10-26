//! The worst case at default limits (§11.2), a measurement and not a check, so `#[ignore]`d: run it
//! with the release profile and `--ignored --nocapture`. It prints the mean, p99 and worst wall time
//! per `step()` and per tick (the tick's commands, its 64 queries and the step), at `dt 1/60,
//! substeps 1` and `dt 1/20, substeps 3`, and holds them against the owner's meter (§11.4, option
//! (a)): a mean of at most 1 ms per 1/60 s of simulated time, and at most 8 ms per 1/60 s in any
//! one tick.
//!
//! The scene: a z-up world at default limits on a static floor; 512 bodies in one dense heap
//! (boxes, balls, hulls and capsules, every fifth with contact events), 64 of them paired by ball
//! joints, 16 of them CCD balls fired into the heap every second, a push every half second that
//! keeps the heap awake, and 64 queries per tick (32 rays, 16 sphere casts, 16 overlaps).

// A benchmark reads the wall clock by definition; the simulation it measures never does.
#![allow(clippy::disallowed_types)]

mod common;

use std::time::Instant;

use common::{ball, body, heap_body};
use genex_physics::{BodyType, Command, JointDesc, JointType, Pose, QueryFilter, StaticWorld, UpAxis, World, WorldDesc};

const BODIES: usize = 512;
const JOINTS: usize = 64;
const CCD: usize = 16;
const RAYS: usize = 32;
const CASTS: usize = 16;
const OVERLAPS: usize = 16;
const WARMUP_SECONDS: f64 = 1.0;
const MEASURED_SECONDS: f64 = 10.0;
/// The meter (§11.4): ms per 1/60 s of simulated time.
const METER_MEAN_MS: f64 = 1.0;
const METER_TICK_MS: f64 = 8.0;

fn ccd_key(i: usize) -> String {
    format!("ccd.{i:02}")
}

fn scene(dt: f64, substeps: f64) -> World {
    let up = UpAxis::Z;
    let mut w = World::create(&WorldDesc::new(dt, substeps, [0.0, 0.0, -9.81], up, 1.0)).expect("world");
    let floor = StaticWorld {
        boxes: vec![vec![-60.0, -60.0, -1.0, 60.0, 60.0, 0.0], vec![-8.0, 12.0, 0.0, 8.0, 13.0, 3.0]],
        ramps: vec![vec![8.0, -8.0, 0.0, 14.0, 8.0, 2.0, 0.0, 2.0, 0.0]],
    };
    w.add_static_world(&floor).expect("floor");
    for i in 0..BODIES - CCD {
        w.spawn(&heap_body(up, i, 0.85)).expect("heap body");
    }
    for i in 0..CCD {
        let mut desc = body(&ccd_key(i), BodyType::Dynamic, [-30.0, (i as f64 - 7.5) * 0.8, 1.0], ball(0.12));
        desc.ccd = true;
        desc.colliders[0].events = true;
        w.spawn(&desc).expect("ccd ball");
    }
    for j in 0..JOINTS {
        let (a, b) = (format!("heap.{:03}", 2 * j), format!("heap.{:03}", 2 * j + 1));
        let joint = JointDesc::new(format!("joint.{j:02}"), a, Some(&b), JointType::Ball, [0.42, 0.0, 0.0], [-0.42, 0.0, 0.0]);
        w.add_joint(&joint).expect("joint");
    }
    w
}

/// The tick's commands: every second the CCD balls are fired at the heap again, every half second
/// a push at its centre.
fn commands(tick: u64, ticks_per_second: u64) -> Vec<Command> {
    let mut out = Vec::new();
    if tick.is_multiple_of(ticks_per_second) {
        for i in 0..CCD {
            let key = ccd_key(i);
            let pose = Pose::at([-30.0, (i as f64 - 7.5) * 0.8, 1.0 + (i % 4) as f64]);
            out.push(Command::SetPose { key: key.clone(), pose, options: genex_physics::SetPoseOptions { reset_velocity: true, wake: true } });
            out.push(Command::SetVelocity { key, linvel: Some([120.0, 0.0, 0.0]), angvel: None });
        }
    }
    if tick.is_multiple_of((ticks_per_second / 2).max(1)) {
        out.push(Command::AreaPush { center: [0.0, 0.0, -0.5], radius: 8.0, strength: 6.0, falloff: 1.0, groups: None });
    }
    out
}

fn queries(w: &mut World, tick: u64) {
    let filter = QueryFilter::default();
    let t = (tick % 64) as f64 * 0.1;
    for i in 0..RAYS {
        let x = (i as f64 - 15.5) * 0.25;
        w.ray([x, -10.0, 1.0 + t * 0.2], [0.0, 1.0, -0.05], 30.0, &filter).expect("ray");
    }
    for i in 0..CASTS {
        let y = (i as f64 - 7.5) * 0.5;
        w.shape_cast(&ball(0.3), Pose::at([-10.0, y, 1.5]), [1.0, 0.0, 0.0], 25.0, &filter).expect("cast");
    }
    for i in 0..OVERLAPS {
        let x = (i % 4) as f64 * 1.5 - 2.25;
        let y = (i / 4) as f64 * 1.5 - 2.25;
        w.overlap(&ball(0.8), Pose::at([x, y, 1.0 + t * 0.1]), &filter).expect("overlap");
    }
}

/// Sorted samples' mean, p99 and worst, in ms.
fn summary(mut samples: Vec<f64>) -> (f64, f64, f64) {
    samples.sort_by(f64::total_cmp);
    let mean = samples.iter().sum::<f64>() / samples.len() as f64;
    let p99 = samples[((samples.len() as f64 * 0.99).ceil() as usize).saturating_sub(1)];
    (mean, p99, samples[samples.len() - 1])
}

fn run(dt: f64, substeps: f64) {
    let ticks_per_second = (1.0 / dt).round() as u64;
    let mut w = scene(dt, substeps);
    let warmup = (WARMUP_SECONDS / dt).round() as u64;
    let measured = (MEASURED_SECONDS / dt).round() as u64;
    let (mut steps, mut ticks) = (Vec::new(), Vec::new());
    let mut awake = 0;
    let mut pairs = 0;
    for tick in 0..warmup + measured {
        let start = Instant::now();
        for outcome in w.apply_each(&commands(tick, ticks_per_second)) {
            outcome.expect("command");
        }
        queries(&mut w, tick);
        let before_step = Instant::now();
        w.step().expect("steps");
        let end = Instant::now();
        if tick < warmup {
            continue;
        }
        steps.push((end - before_step).as_secs_f64() * 1e3);
        ticks.push((end - start).as_secs_f64() * 1e3);
        let stats = w.stats();
        awake += stats.awake;
        pairs += stats.contact_pairs;
    }
    let per_sixtieth = 1.0 / 60.0 / dt;
    let (s_mean, s_p99, s_max) = summary(steps);
    let (t_mean, t_p99, t_max) = summary(ticks);
    let stats = w.stats();
    println!("worst case at default limits, dt 1/{ticks_per_second} x{substeps}, {measured} ticks after {warmup}:");
    println!(
        "  bodies {} joints {} awake {:.0} contact pairs {:.0} (means), memory {} B",
        stats.bodies,
        stats.joints,
        awake as f64 / measured as f64,
        pairs as f64 / measured as f64,
        stats.memory_bytes
    );
    println!("  per step: mean {s_mean:.3} ms, p99 {s_p99:.3} ms, worst {s_max:.3} ms");
    println!("  per tick: mean {t_mean:.3} ms, p99 {t_p99:.3} ms, worst {t_max:.3} ms");
    let (mean_meter, worst_meter) = (t_mean * per_sixtieth, t_max * per_sixtieth);
    let verdict = |ok: bool| if ok { "within" } else { "OVER" };
    println!(
        "  meter per 1/60 s of simulated time: mean {mean_meter:.3} ms ({} {METER_MEAN_MS} ms), worst tick {worst_meter:.3} ms ({} {METER_TICK_MS} ms)",
        verdict(mean_meter <= METER_MEAN_MS),
        verdict(worst_meter <= METER_TICK_MS)
    );
}

#[test]
#[ignore = "a measurement: cargo test --release --test bench -- --ignored --nocapture"]
fn worst_case_at_default_limits() {
    println!("target {}", genex_physics::build_id());
    run(1.0 / 60.0, 1.0);
    run(1.0 / 20.0, 3.0);
}
