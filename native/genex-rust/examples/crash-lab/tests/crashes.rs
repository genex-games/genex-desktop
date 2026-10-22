//! crash-lab's forced-crash rows on the host (PROF-9): with the crash hook installed (as a shell
//! installs it, here with a sink that keeps every record), each forced case gives exactly one typed
//! record with the right `kind`, `fatal` and `handled`, and the record of the tick-300 panic names
//! the seed, the tick and the game's file and line. The input journal's tail (what a record's
//! `replay.track` carries) replayed on a fresh runtime from that seed reproduces the panic: the same
//! kind, location and tick. Game scopes and counters reach `state().volatile.profile`, and the
//! checksum is the same with scopes on and never started.
//!
//! The hook and the crash context are the process's, so every row holds [`serial`] and picks its
//! own records out by message. The GPU rows need the host GPU (`--ignored metal`).
//!
//! `GENEX_CRASH_LAB_EVIDENCE=<dir>` writes each row's record JSON and the hook's timings there.

#![allow(clippy::disallowed_types, reason = "the hook budget row measures the wall clock on purpose; no simulation reads it")]

use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use crash_lab_game::{DEMOS, PANIC_MESSAGE, PANIC_TICK, World, game};
use genex::actions::InputTrack;
use genex::{Runtime, Value};
use genex_crash::caps::CRASH_REPLAY_MAX_BYTES;
use genex_crash::{CRASH_RECORD_MAX_BYTES, CrashKind, CrashRecord, FnSink, GpuErrorClass, install};
use genex_render::Gpu;
use genex_render::device_loss::DeviceWatch;
use genex_render::jobs::{JobError, Pool, Priority};

/// The seed every row runs.
const SEED: u32 = 11;
/// The file the forced panic is raised in.
const LAB_FILE: &str = "src/lab.rs";
/// Section 8.4: a record is built within this natively (raw ips only).
const HOOK_BUDGET: Duration = Duration::from_millis(5);
/// Panics timed for the hook budget.
const HOOK_SAMPLES: usize = 21;
/// Live frames closed for the scopes row (a demo step is three ticks).
const PROFILE_FRAMES: u32 = 90;
/// A Live frame's interval, for the profiler (milliseconds).
const FRAME_MS: f64 = 1000.0 / 60.0;

/// One delivered record: the record, its JSON size and when the sink got it.
#[derive(Clone)]
struct Delivered {
    record: CrashRecord,
    json: Vec<u8>,
    at: Instant,
}

/// Every record the hook delivered in this process (installs the hook on first use).
fn delivered() -> &'static Mutex<Vec<Delivered>> {
    static RECORDS: OnceLock<Arc<Mutex<Vec<Delivered>>>> = OnceLock::new();
    RECORDS.get_or_init(|| {
        let records = Arc::new(Mutex::new(Vec::new()));
        let kept = Arc::clone(&records);
        install(vec![Box::new(FnSink(move |record: &CrashRecord, json: &[u8]| {
            let row = Delivered { record: record.clone(), json: json.to_vec(), at: Instant::now() };
            kept.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(row);
        }))]);
        records
    })
}

/// One row at a time: the hook, its records and the crash context are the process's.
fn serial() -> MutexGuard<'static, ()> {
    static SERIAL: Mutex<()> = Mutex::new(());
    let guard = SERIAL.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    delivered();
    guard
}

/// The records whose message contains `needle`.
fn records_with(needle: &str) -> Vec<Delivered> {
    let all = delivered().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    all.iter().filter(|row| row.record.message.contains(needle)).cloned().collect()
}

/// The records of `kind`.
fn records_of(kind: CrashKind) -> Vec<Delivered> {
    let all = delivered().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    all.iter().filter(|row| row.record.kind == kind).cloned().collect()
}

/// Where evidence goes, when asked for.
fn evidence_dir() -> Option<PathBuf> {
    let dir = PathBuf::from(std::env::var_os("GENEX_CRASH_LAB_EVIDENCE")?);
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// Write `bytes` as `name` in the evidence folder, when asked for.
fn evidence(name: &str, bytes: &[u8]) {
    if let Some(dir) = evidence_dir() {
        std::fs::write(dir.join(name), bytes).expect("evidence written");
    }
}

/// A fresh temporary save folder for one runtime.
fn saves_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("genex-crash-lab-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("a temp folder");
    dir
}

/// crash-lab seeded with [`SEED`], saving into its own temporary folder.
fn runtime(name: &str) -> Runtime<World> {
    let dir = saves_dir(name);
    let mut runtime = Runtime::new(game()).expect("crash-lab installs");
    runtime.use_studio_saves(&format!("{}/", dir.display()));
    runtime.seed(SEED);
    runtime
}

/// Run `demo` on `runtime`, catching its panic: the panic's text, or None when it answered.
fn demo_panics(runtime: &mut Runtime<World>, demo: &str) -> Option<String> {
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| runtime.demo(demo)));
    let payload = outcome.err()?;
    let text = payload.downcast_ref::<String>().cloned().or_else(|| payload.downcast_ref::<&str>().map(|text| (*text).to_owned()));
    Some(text.unwrap_or_default())
}

/// The one record of the forced panic delivered after `before` records with its message.
fn one_panic_record(before: usize) -> CrashRecord {
    let found = records_with(PANIC_MESSAGE);
    assert_eq!(found.len(), before + 1, "exactly one record for the forced panic: {:?}", found.iter().map(|row| &row.record).collect::<Vec<_>>());
    found.last().expect("the record").record.clone()
}

#[test]
fn the_demos_are_play_panic_at_300_and_wasm_trap() {
    assert_eq!(DEMOS, ["play", "panic_at_300", "wasm_trap"]);
    let _serial = serial();
    let mut lab = runtime("demos");
    let played = lab.demo("play").expect("the demo exists");
    assert!(played["movers"].as_u64().unwrap_or(0) > 12, "holding Overload charged movers: {played}");
    let mut trap = runtime("trap");
    let answer = trap.demo("wasm_trap").expect("the demo exists");
    assert_eq!(answer["trapped"], Value::Bool(false), "off the web the trap demo does nothing: {answer}");
}

#[test]
fn the_forced_panic_at_tick_300_is_one_fatal_unhandled_panic_record_naming_seed_tick_and_line() {
    let _serial = serial();
    let before = records_with(PANIC_MESSAGE).len();
    let mut lab = runtime("panic");
    let text = demo_panics(&mut lab, "panic_at_300").expect("the demo panics");
    assert_eq!(text, PANIC_MESSAGE);
    let record = one_panic_record(before);
    assert_eq!((record.kind, record.fatal, record.handled), (CrashKind::Panic, true, false));
    let location = record.location.as_ref().expect("the panic's location");
    assert!(location.file.ends_with(LAB_FILE), "raised in the game's lab: {location:?}");
    assert!(location.line > 0);
    assert_eq!(record.context.seed, Some(SEED), "the record names the seed");
    assert_eq!(record.context.tick, Some(PANIC_TICK), "the record names the tick");
    assert!(!record.frames.is_empty() && record.anchor.is_some(), "raw frames and the slide anchor");
    let json = record.to_json();
    assert!(json.len() <= CRASH_RECORD_MAX_BYTES, "{} bytes", json.len());
    let parsed = CrashRecord::from_json(&json).expect("the record reads back");
    assert_eq!(parsed.kind, CrashKind::Panic);
    evidence("panic-at-300.json", &json);
}

#[test]
fn replaying_the_journal_tail_from_the_records_seed_reproduces_kind_location_and_tick() {
    let _serial = serial();
    let before = records_with(PANIC_MESSAGE).len();
    let mut lab = runtime("replay-run");
    demo_panics(&mut lab, "panic_at_300").expect("the demo panics");
    let original = one_panic_record(before);
    // The tail a record carries: the newest journal ticks within the record's replay cap.
    let tail = lab.journal().track_within(CRASH_REPLAY_MAX_BYTES).expect("game.input keeps a journal");
    let bytes = tail.encode();
    assert!(bytes.len() <= CRASH_REPLAY_MAX_BYTES, "{} bytes", bytes.len());
    evidence("panic-at-300.track", &bytes);
    let track = InputTrack::decode(&bytes).expect("the tail decodes");
    assert_eq!(original.context.seed, Some(track.header().seed), "the tail starts from the record's seed");
    // A fresh runtime on another seed: the replay seeds itself from the track.
    let mut fresh = Runtime::new(game()).expect("crash-lab installs");
    fresh.use_studio_saves(&format!("{}/", saves_dir("replay-fresh").display()));
    fresh.seed(SEED + 1);
    let replayed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| fresh.replay(&track)));
    assert!(replayed.is_err(), "the replay reaches the same panic");
    let again = one_panic_record(before + 1);
    assert_eq!(again.kind, original.kind);
    assert_eq!(again.location, original.location, "the same file, line and column");
    assert_eq!(again.context.tick, original.context.tick, "the same tick");
    assert_eq!(again.context.seed, original.context.seed);
}

#[test]
#[ignore = "RED (PROF-9 cross-lane): the facade registers no ReplaySource over the input journal, so a record's replay is null"]
fn the_tick_300_record_carries_the_journal_tail_as_its_replay() {
    let _serial = serial();
    let before = records_with(PANIC_MESSAGE).len();
    let mut lab = runtime("replay-field");
    demo_panics(&mut lab, "panic_at_300").expect("the demo panics");
    let record = one_panic_record(before);
    let replay = record.replay.expect("the record carries the replay");
    assert_eq!((replay.seed, replay.to_tick, replay.complete), (u64::from(SEED), PANIC_TICK, true));
    let track = InputTrack::decode(&replay.track).expect("the replay track decodes");
    let mut fresh = Runtime::new(game()).expect("crash-lab installs");
    let replayed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| fresh.replay(&track)));
    assert!(replayed.is_err(), "the record's own track reaches the panic");
}

#[test]
fn a_panicking_job_beside_the_lab_is_one_handled_record_that_is_not_fatal() {
    let _serial = serial();
    let mut lab = runtime("job");
    lab.demo("play").expect("the demo exists");
    let pool = Pool::new(2);
    let failed = pool.spawn(Priority::Sim, || -> u32 { panic!("crash-lab job panic") });
    assert_eq!(failed.wait(), Err(JobError::Panicked("crash-lab job panic".to_owned())));
    assert_eq!(pool.spawn(Priority::Sim, || 3_u8).into_result(), Ok(3), "the pool keeps running");
    let found = records_with("crash-lab job panic");
    assert_eq!(found.len(), 1, "one record");
    let record = &found[0].record;
    assert_eq!((record.kind, record.fatal, record.handled), (CrashKind::Panic, false, true));
    assert_eq!(record.context.seed, Some(SEED), "the record names the lab's seed");
    assert!(record.thread.as_ref().is_some_and(|thread| !thread.main), "raised on a pool thread");
    evidence("job-panic.json", &record.to_json());
}

#[test]
fn a_record_is_built_and_delivered_within_the_hook_budget() {
    let _serial = serial();
    let mut micros: Vec<u128> = Vec::with_capacity(HOOK_SAMPLES);
    let mut sizes: Vec<usize> = Vec::with_capacity(HOOK_SAMPLES);
    for sample in 0..HOOK_SAMPLES {
        let needle = format!("crash-lab hook budget {sample}");
        let started = Instant::now();
        let caught = std::panic::catch_unwind(|| panic!("{needle}"));
        assert!(caught.is_err());
        let found = records_with(&needle);
        assert_eq!(found.len(), 1, "one record per panic");
        micros.push(found[0].at.duration_since(started).as_micros());
        sizes.push(found[0].json.len());
    }
    let first = micros[0];
    let mut sorted = micros.clone();
    sorted.sort_unstable();
    let median = sorted[HOOK_SAMPLES / 2];
    let worst = sorted[HOOK_SAMPLES - 1];
    let summary = format!(
        "{{\"samples\":{HOOK_SAMPLES},\"firstUs\":{first},\"medianUs\":{median},\"maxUs\":{worst},\"budgetUs\":{},\"recordBytesMax\":{}}}\n",
        HOOK_BUDGET.as_micros(),
        sizes.iter().max().copied().unwrap_or(0)
    );
    eprintln!("crash hook timing: {summary}");
    evidence("hook-budget.json", summary.as_bytes());
    assert!(Duration::from_micros(median as u64) <= HOOK_BUDGET, "median {median} us over the 5 ms budget: {micros:?}");
}

#[test]
fn game_scopes_and_counters_reach_volatile_profile_and_never_change_the_checksum() {
    let _serial = serial();
    let mut profiled = runtime("profiled");
    profiled.profiling().start(true);
    let mut plain = runtime("plain");
    profiled.inject(genex::Input::key_down(crash_lab_game::OVERLOAD_KEY));
    plain.inject(genex::Input::key_down(crash_lab_game::OVERLOAD_KEY));
    for _ in 0..PROFILE_FRAMES {
        profiled.step(FRAME_MS);
        profiled.profiling().new_frame(FRAME_MS, None);
        plain.step(FRAME_MS);
    }
    let state = profiled.state();
    let profile = &state["volatile"]["profile"];
    assert_eq!(profile["on"], Value::Bool(true), "{profile}");
    let counters = &profile["counters"];
    assert!(counters["lab.movers"].as_f64().unwrap_or(0.0) > 12.0, "the movers counter: {counters}");
    assert!(counters["lab.charge"].as_f64().unwrap_or(0.0) > 0.0, "the charge counter: {counters}");
    let top = profile["top"].as_array().cloned().unwrap_or_default();
    let game_scopes: Vec<&str> = top.iter().filter(|row| row["game"] == Value::Bool(true)).filter_map(|row| row["scope"].as_str()).collect();
    assert!(game_scopes.contains(&crash_lab_game::SCOPE_UPDATE) || game_scopes.contains(&crash_lab_game::SCOPE_SWEEP), "a game scope in top: {top:?}");
    evidence("volatile-profile.json", profile.to_string().as_bytes());
    assert_eq!(profiled.checksum(), plain.checksum(), "scopes on and never started: the same checksum");
    assert!(plain.state()["volatile"].get("profile").is_none(), "no recorder, no volatile.profile");
}

/// The host GPU, or None (skipped) without one.
fn gpu() -> Option<Gpu> {
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    match Gpu::headless() {
        Ok(gpu) => {
            if require {
                assert_eq!(gpu.receipt().backend, "metal", "GENEX_REQUIRE_METAL=1 but the adapter is not Metal");
            }
            Some(gpu)
        }
        Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
        Err(error) => {
            eprintln!("skipped: no WebGPU-core adapter ({error})");
            None
        }
    }
}

#[test]
#[ignore = "needs the host GPU: run with --ignored metal"]
fn metal_a_gpu_validation_error_beside_the_lab_is_one_fatal_gpu_validation_record() {
    let _serial = serial();
    let Some(gpu) = gpu() else { return };
    let mut lab = runtime("gpu-validation");
    lab.demo("play").expect("the demo exists");
    let _watch = DeviceWatch::attach(&gpu);
    // MAP_READ with STORAGE is a validation error without MAPPABLE_PRIMARY_BUFFERS.
    let failed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("crash-lab invalid buffer"),
            size: 256,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::STORAGE,
            mapped_at_creation: false,
        })
    }));
    assert!(failed.is_err(), "an uncaptured error on a live device panics");
    let found = records_with("crash-lab invalid buffer");
    assert_eq!(found.len(), 1, "one record");
    let record = &found[0].record;
    assert_eq!((record.kind, record.fatal, record.handled), (CrashKind::GpuValidation, true, false));
    assert_eq!(record.gpu.as_ref().and_then(|row| row.class), Some(GpuErrorClass::Validation));
    assert_eq!(record.context.seed, Some(SEED), "the record names the lab's seed");
    evidence("gpu-validation.json", &record.to_json());
}

#[test]
#[ignore = "needs the host GPU: run with --ignored metal"]
fn metal_a_forced_device_loss_beside_the_lab_is_one_device_lost_record_that_is_not_fatal() {
    let _serial = serial();
    let Some(gpu) = gpu() else { return };
    let mut lab = runtime("device-lost");
    lab.demo("play").expect("the demo exists");
    let before = records_of(CrashKind::DeviceLost).len();
    let watch = DeviceWatch::attach(&gpu);
    watch.force_loss(&gpu);
    let _ = gpu.device.poll(wgpu::PollType::Poll);
    assert!(watch.is_lost());
    let lost = records_of(CrashKind::DeviceLost);
    assert_eq!(lost.len(), before + 1, "one device-lost record");
    let record = &lost.last().expect("the record").record;
    assert_eq!((record.fatal, record.handled), (false, false));
    assert!(record.gpu.as_ref().and_then(|row| row.reason.as_deref()).is_some_and(|reason| !reason.is_empty()));
    assert_eq!(record.context.seed, Some(SEED), "the record names the lab's seed");
    evidence("device-lost.json", &record.to_json());
}
