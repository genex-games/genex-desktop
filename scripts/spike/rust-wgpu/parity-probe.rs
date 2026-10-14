//! M0a.9 parity probe for the pond (spike only; M2.12c moves the rows into the lane's tests).
//! `parity.sh` compiles this file with rustc against the pond's release build for each target it
//! checks (the dependency rlibs Cargo reported), the way `measure.ts` builds `pond-bench.rs`.
//!
//!   parity-probe <ticks> [--seed <n>] [--demo <name>]
//!   parity-probe --bench <ticks> [--seed <n>] [--demo <name>]
//!
//! It opens no GPU. The record mode runs the self-test sequence of `genex-platform-web` (seed, the
//! named demo, `<ticks>` ticks, checkpoints every 200 ticks) through the facade runtime and prints
//! one `genex-parity/1` JSON record: the probe fields and checksum the self-test record carries,
//! every rigid body's pose and velocities (insertion order) as named fields, and at each
//! checkpoint a postcard snapshot of the whole Rapier `PhysicsWorld` (its length and FNV-1a 64).
//! Nothing in it comes from the wall clock, so two runs of one build give identical bytes; the
//! cross-target comparison reads the named fields within 1e-3 and reports the digests.
//!
//! The bench mode runs the same sequence and prints one JSON line of CPU timings in the pond
//! scene as the lane builds it (scalar libm glam, Rapier `enhanced-determinism`): the sim tick
//! (`step` of one fixed tick) and the frame build (`frame()` plus `to_scene`, the per-draw glam
//! work), with the draw count, for `glam-cost.rs` to size its scalar-against-SIMD comparison.

use genex::{FIXED_STEP_MS, Runtime, Value, json};
use genex_core::digest::{fnv1a64, hex64};
use genex_platform_web::selftest::{self, SelfTestPlan};
use genex_platform_web::{GameHandle, MeshCache, to_scene};
use std::time::Instant;

const PARITY_FORMAT: &str = "genex-parity/1";
const BENCH_FORMAT: &str = "genex-parity-bench/1";
const EXIT_REFUSED: i32 = 1;
const EXIT_USAGE: i32 = 2;
const USAGE: &str = "usage: parity-probe [--bench] <ticks> [--seed <n>] [--demo <name>]";

struct Options {
    plan: SelfTestPlan,
    bench: bool,
}

fn parse(args: &[String]) -> Result<Options, String> {
    let mut plan = SelfTestPlan {
        game: pond_game::NAME.to_owned(),
        seed: genex::DEFAULT_SEED,
        demo: pond_game::DEFAULT_DEMO.to_owned(),
        ticks: 0,
    };
    let mut bench = false;
    let mut ticks = None;
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--bench" => bench = true,
            "--seed" | "--demo" => {
                let value = rest.next().ok_or_else(|| format!("{arg} needs a value"))?;
                if arg == "--seed" {
                    plan.seed = value.parse().map_err(|_| format!("--seed needs a whole number, not {value:?}"))?;
                } else {
                    value.clone_into(&mut plan.demo);
                }
            }
            number => ticks = Some(number.parse::<u32>().map_err(|_| format!("unknown argument {number:?}"))?),
        }
    }
    plan.ticks = ticks.ok_or("<ticks> is required")?;
    Ok(Options { plan, bench })
}

/// A postcard snapshot of the whole physics world.
fn snapshot(runtime: &Runtime<pond_game::World>) -> Result<Value, String> {
    let bytes = postcard::to_allocvec(&runtime.sim().physics).map_err(|e| format!("postcard: {e}"))?;
    Ok(json!({ "tick": runtime.tick(), "bytes": bytes.len(), "digest": hex64(fnv1a64(&bytes)) }))
}

/// Every rigid body's pose and velocities, in the body set's (insertion) order.
fn bodies(runtime: &Runtime<pond_game::World>) -> Vec<Value> {
    runtime
        .sim()
        .physics
        .bodies
        .iter()
        .map(|(_, body)| {
            json!({
                "translation": body.translation().to_array(),
                "rotation": body.rotation().to_array(),
                "linvel": body.linvel().to_array(),
                "angvel": body.angvel().to_array(),
            })
        })
        .collect()
}

fn record(runtime: &mut Runtime<pond_game::World>, plan: &SelfTestPlan) -> Result<String, String> {
    let demo_result = selftest::begin(runtime, plan).map_err(|e| e.to_string())?;
    let mut snapshots = Vec::new();
    let mut done = 0;
    for point in plan.checkpoints() {
        selftest::advance(runtime, done, point);
        done = point;
        snapshots.push(snapshot(runtime)?);
    }
    let record = json!({
        "format": PARITY_FORMAT,
        "game": plan.game,
        "seed": plan.seed,
        "demo": plan.demo,
        "demoResult": demo_result,
        "ticks": plan.ticks.min(selftest::SELF_TEST_MAX_TICKS),
        "frame": runtime.tick(),
        "checksum": runtime.checksum(),
        "probes": runtime.probes(),
        "bodies": bodies(runtime),
        "snapshots": snapshots,
    });
    let mut text = serde_json::to_string_pretty(&record).map_err(|e| e.to_string())?;
    text.push('\n');
    Ok(text)
}

/// `[p50, p95, mean]` of `samples` in microseconds.
fn summary(mut samples: Vec<f64>) -> Value {
    if samples.is_empty() {
        return json!({ "p50": 0.0, "p95": 0.0, "mean": 0.0 });
    }
    samples.sort_by(f64::total_cmp);
    let at = |p: f64| samples[((p / 100.0) * (samples.len() - 1) as f64).round() as usize];
    let mean = samples.iter().sum::<f64>() / samples.len() as f64;
    json!({ "p50": at(50.0), "p95": at(95.0), "mean": mean })
}

fn bench(runtime: &mut Runtime<pond_game::World>, plan: &SelfTestPlan) -> Result<String, String> {
    selftest::begin(runtime, plan).map_err(|e| e.to_string())?;
    let meshes = MeshCache::default();
    let (mut ticks, mut frames, mut draws) = (Vec::new(), Vec::new(), 0);
    for _ in 0..plan.ticks {
        let started = Instant::now();
        GameHandle::step(runtime, FIXED_STEP_MS);
        ticks.push(started.elapsed().as_secs_f64() * 1.0e6);
        let started = Instant::now();
        let (frame, camera) = GameHandle::frame(runtime);
        let scene = to_scene(&frame, &camera, &meshes);
        frames.push(started.elapsed().as_secs_f64() * 1.0e6);
        draws = draws.max(frame.draws().len());
        std::hint::black_box(scene);
    }
    let line = json!({
        "format": BENCH_FORMAT,
        "target": format!("{}-{}", std::env::consts::ARCH, std::env::consts::OS),
        "ticks": plan.ticks,
        "draws": draws,
        "bodies": runtime.sim().physics.bodies.len(),
        "tickUs": summary(ticks),
        "frameBuildUs": summary(frames),
    });
    Ok(format!("{line}\n"))
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let options = match parse(&args) {
        Ok(options) => options,
        Err(problem) => {
            eprintln!("parity-probe: {problem}\n{USAGE}");
            std::process::exit(EXIT_USAGE);
        }
    };
    let mut runtime = match Runtime::new(pond_game::game()) {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("parity-probe: {}", json!({ "code": error.code().as_str(), "detail": error.to_string() }));
            std::process::exit(EXIT_REFUSED);
        }
    };
    let out = if options.bench { bench(&mut runtime, &options.plan) } else { record(&mut runtime, &options.plan) };
    match out {
        Ok(text) => print!("{text}"),
        Err(detail) => {
            eprintln!("parity-probe: {}", json!({ "code": "probe-failed", "detail": detail }));
            std::process::exit(EXIT_REFUSED);
        }
    }
}
