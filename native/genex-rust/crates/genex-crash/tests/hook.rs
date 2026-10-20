//! The panic hook's rows (CRASH-1b). A panic hook is process-wide and installs once, so each case
//! runs in a child process: the test binary runs itself with one `child_*` test selected and
//! `GENEX_CRASH_HOOK_CHILD` naming it, and the parent reads what the child printed. Every line a
//! child prints starts with a tag (`RECORD`, `PREVIOUS`, `SITE`, ...), on stdout only, so their
//! order is the order they happened in.
//!
//! Rows: a panic gives exactly one record (message, location, thread, at least one frame, the
//! anchor, the context as set) and the previous hook still runs after it; `catching` marks a
//! caught panic handled and not fatal; a panicking sink causes no second record and no abort, and
//! the previous hook still runs; `note_gpu_error` types the next panic on that thread
//! `gpu-validation` with its class; a busy replay source gives `complete: false` without waiting;
//! installing twice installs once. Host only: wasm32 has no child processes (its build is checked
//! by clippy, and the record without frames by the hook's unit test).
#![cfg(not(target_arch = "wasm32"))]
// The hook's cost and a busy source's wait are measured on the wall clock: test code, never a tick.
#![allow(clippy::disallowed_types, reason = "the timing rows read the wall clock (std::time::Instant)")]

use std::io::Write;
use std::panic::PanicHookInfo;
use std::process::{Command, Output};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use genex_crash::{
    CrashFlavour, CrashFrame, CrashIdentity, CrashKind, CrashRecord, CrashSource, FnSink, GpuErrorClass, Installed,
    RecordContext, ReplaySource, ReplayTail, anchor, catching, context, install, note_gpu_error, record_device_lost,
    replay, set_replay_source,
};

/// The variable naming the child case a run of this binary is.
const CHILD_ENV: &str = "GENEX_CRASH_HOOK_CHILD";
/// The exit code of a test binary whose test failed (a panic that unwound): not an abort.
const TEST_FAILED_EXIT: i32 = 101;
/// The most a busy replay source may hold the hook up.
const BUSY_SOURCE_MAX: Duration = Duration::from_millis(1);
/// The most frames of std's panic machinery (the hook call, `panic_with_hook`, the handler,
/// `rust_begin_unwind`, `panic_fmt`) that may sit above the panic site in a record.
const PANIC_MACHINERY_FRAMES_MAX: usize = 6;

// ---- the child side ----------------------------------------------------------------------------

/// Whether this run is the child for `case`.
fn is_child(case: &str) -> bool {
    std::env::var(CHILD_ENV).as_deref() == Ok(case)
}

/// Print one tagged line on stdout, flushed (the delivery thread and the hook share it). It starts
/// with a line break: the test harness prints `test <name> ... ` with no line end before it.
fn emit(tag: &str, text: &str) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "\n{tag} {text}");
    let _ = out.flush();
}

/// A previous hook that says it ran and with which message.
fn previous_hook() {
    std::panic::set_hook(Box::new(|info: &PanicHookInfo<'_>| emit("PREVIOUS", &panic_text(info))));
}

fn panic_text(info: &PanicHookInfo<'_>) -> String {
    info.payload_as_str().unwrap_or("<no text>").to_string()
}

/// A sink printing the record's JSON, tagged.
fn printing_sink(tag: &'static str) -> Box<dyn genex_crash::CrashSink> {
    Box::new(FnSink(move |_record: &CrashRecord, json: &[u8]| emit(tag, &String::from_utf8_lossy(json))))
}

/// A sink printing the record and the names its frames resolve to in this process.
fn symbolizing_sink() -> Box<dyn genex_crash::CrashSink> {
    Box::new(FnSink(|record: &CrashRecord, json: &[u8]| {
        emit("RECORD", &String::from_utf8_lossy(json));
        for frame in &record.frames {
            let CrashFrame::Ip(ip) = *frame else { continue };
            let mut name = String::from("?");
            backtrace::resolve(ip as usize as *mut std::ffi::c_void, |symbol| {
                if let Some(found) = symbol.name() {
                    name = found.to_string();
                }
            });
            emit("SYMBOL", &name);
        }
    }))
}

/// The panic site the record's frames must contain.
#[inline(never)]
fn panic_site() {
    emit("SITE", &(line!() + 1).to_string());
    panic!("boom {}", 42);
}

fn set_full_context() {
    let ctx = context();
    ctx.set_identity(CrashIdentity {
        destination: "mac".into(),
        flavour: CrashFlavour::Dev,
        build: "build-7".into(),
        contract: 2,
        genex: "0.1.0".into(),
    });
    ctx.set_seed(7);
    ctx.set_tick(300, 5000.0, true);
    ctx.set_frame(312);
}

#[test]
fn child_panic_once() {
    if !is_child("child_panic_once") {
        return;
    }
    previous_hook();
    assert_eq!(install(vec![symbolizing_sink()]), Installed::Now);
    set_full_context();
    emit("ANCHOR", &format!("{:#x}", anchor()));
    panic_site();
}

#[test]
fn child_catching() {
    if !is_child("child_catching") {
        return;
    }
    previous_hook();
    install(vec![printing_sink("RECORD")]);
    let started = Instant::now();
    let caught = catching(|| panic!("caught here"));
    emit("HOOK-MICROS", &started.elapsed().as_micros().to_string());
    emit("CAUGHT", &caught.is_err().to_string());
    let fine = catching(|| 5);
    emit("FINE", &format!("{fine:?}"));
}

#[test]
fn child_sink_panics() {
    if !is_child("child_sink_panics") {
        return;
    }
    previous_hook();
    let broken: Box<dyn genex_crash::CrashSink> =
        Box::new(FnSink(|_record: &CrashRecord, _json: &[u8]| panic!("the sink broke")));
    install(vec![broken, printing_sink("RECORD")]);
    panic!("the outer panic");
}

#[test]
fn child_gpu_error() {
    if !is_child("child_gpu_error") {
        return;
    }
    previous_hook();
    install(vec![printing_sink("RECORD")]);
    context().set_gpu_adapter("metal", "Apple M2");
    note_gpu_error(GpuErrorClass::Validation, "bind group 0 does not match its layout");
    let _ = catching(|| panic!("wgpu error: validation error"));
    // The pending cause is consumed by the panic it typed: the next one is a plain panic.
    let _ = catching(|| panic!("a later panic"));
    // A cause noted on another thread never types this thread's panic.
    let noting = std::thread::Builder::new().spawn(|| note_gpu_error(GpuErrorClass::Internal, "elsewhere"));
    noting.expect("the noting thread").join().expect("the noting thread ran");
    let _ = catching(|| panic!("after a cause on another thread"));
    record_device_lost("destroyed", "the device was lost");
}

/// A replay source whose lock another party may hold.
struct LockedSource(Arc<Mutex<ReplayTail>>);

impl ReplaySource for LockedSource {
    fn tail(&self, _max_bytes: usize) -> Option<ReplayTail> {
        self.0.try_lock().ok().map(|tail| tail.clone())
    }
}

fn sample_tail() -> ReplayTail {
    ReplayTail { seed: 9, from_tick: 100, to_tick: 120, complete: true, track: vec![1, 2, 3, 4] }
}

#[test]
fn child_replay_source() {
    if !is_child("child_replay_source") {
        return;
    }
    previous_hook();
    install(vec![printing_sink("RECORD")]);
    context().set_seed(9);
    context().set_tick(120, 2000.0, true);
    let ring = Arc::new(Mutex::new(sample_tail()));
    set_replay_source(Box::new(LockedSource(Arc::clone(&ring))));
    let _ = catching(|| panic!("with the ring free"));
    let held = ring.lock().expect("the ring");
    let _ = catching(|| panic!("with the ring busy"));
    drop(held);
}

#[test]
fn child_install_twice() {
    if !is_child("child_install_twice") {
        return;
    }
    previous_hook();
    let first = install(vec![printing_sink("RECORD-A")]);
    let second = install(vec![printing_sink("RECORD-B")]);
    emit("INSTALLS", &format!("{first:?} {second:?}"));
    let _ = catching(|| panic!("one panic"));
}

// ---- the parent side ---------------------------------------------------------------------------

/// What a child printed, line by line, and how it ended.
struct Child {
    lines: Vec<(String, String)>,
    output: Output,
}

impl Child {
    fn tagged(&self, tag: &str) -> Vec<&str> {
        self.lines.iter().filter(|(t, _)| t == tag).map(|(_, text)| text.as_str()).collect()
    }

    fn records(&self, tag: &str) -> Vec<CrashRecord> {
        self.tagged(tag)
            .into_iter()
            .map(|json| CrashRecord::from_json(json.as_bytes()).expect("the hook writes a record the host parses"))
            .collect()
    }

    fn position(&self, tag: &str, text_contains: &str) -> Option<usize> {
        self.lines.iter().position(|(t, text)| t == tag && text.contains(text_contains))
    }

    fn describe(&self) -> String {
        format!(
            "status {:?}\nstdout:\n{}\nstderr:\n{}",
            self.output.status,
            String::from_utf8_lossy(&self.output.stdout),
            String::from_utf8_lossy(&self.output.stderr)
        )
    }
}

/// Run this test binary with only `case` selected, as that case's child.
fn run_child(case: &str) -> Child {
    let exe = std::env::current_exe().expect("the test binary");
    let output = Command::new(exe)
        .args([case, "--exact", "--nocapture", "--test-threads=1"])
        .env(CHILD_ENV, case)
        .env("RUST_BACKTRACE", "0")
        .output()
        .expect("the child runs");
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let lines = stdout
        .lines()
        .filter_map(|line| line.split_once(' '))
        .filter(|(tag, _)| tag.chars().all(|c| c.is_ascii_uppercase() || c == '-'))
        .map(|(tag, text)| (tag.to_string(), text.to_string()))
        .collect();
    Child { lines, output }
}

#[test]
fn a_panic_gives_one_record_and_the_previous_hook_still_runs() {
    let child = run_child("child_panic_once");
    let records = child.records("RECORD");
    assert_eq!(records.len(), 1, "exactly one record\n{}", child.describe());
    let record = &records[0];
    let shape = (record.kind, record.source, record.fatal, record.handled);
    assert_eq!(shape, (CrashKind::Panic, CrashSource::Game, true, false));
    assert_eq!(record.message, "boom 42");
    let location = record.location.as_ref().expect("a location");
    assert!(location.file.ends_with("tests/hook.rs"), "{location:?}");
    let site: u64 = child.tagged("SITE")[0].parse().expect("the site line");
    assert_eq!(location.line, site);
    let thread = record.thread.as_ref().expect("a thread");
    assert_eq!((thread.name.as_str(), thread.main), ("child_panic_once", true));
    assert!(!record.frames.is_empty(), "at least one frame");
    assert_eq!(record.anchor.map(|ip| format!("{ip:#x}")).as_deref(), Some(child.tagged("ANCHOR")[0]));
    let expected_context = RecordContext {
        seed: Some(7),
        tick: Some(300),
        frame: Some(312),
        simulated_ms: Some(5000.0),
        running: Some(true),
        destination: Some("mac".into()),
        flavour: Some(CrashFlavour::Dev),
        build: Some("build-7".into()),
        contract: Some(2),
        genex: Some("0.1.0".into()),
    };
    assert_eq!(record.context, expected_context);
    assert_eq!(record.replay, None, "no replay source was set");

    // The frames are this process's real return addresses: they resolve to the panic site, and the
    // hook's own frames were skipped.
    let symbols = child.tagged("SYMBOL");
    let site_at = symbols.iter().position(|name| name.contains("panic_site")).expect("the site's frame");
    let hook_frames = |name: &&str| name.contains("genex_crash") || name.starts_with("backtrace");
    assert!(!symbols.iter().any(hook_frames), "the stack walk's and the hook's frames are skipped: {symbols:?}");
    assert!(site_at <= PANIC_MACHINERY_FRAMES_MAX, "only std's panic frames sit above the site: {symbols:?}");

    let record_at = child.position("RECORD", "boom 42").expect("the record line");
    let previous_at = child.position("PREVIOUS", "boom 42").expect("the previous hook ran");
    assert!(record_at < previous_at, "the record is written before the previous hook runs");
    assert_eq!(child.output.status.code(), Some(TEST_FAILED_EXIT), "{}", child.describe());
}

#[test]
fn catching_marks_a_caught_panic_handled_and_not_fatal() {
    let child = run_child("child_catching");
    let records = child.records("RECORD");
    assert_eq!(records.len(), 1, "{}", child.describe());
    assert_eq!((records[0].handled, records[0].fatal), (true, false));
    assert_eq!(records[0].message, "caught here");
    assert_eq!(child.tagged("CAUGHT"), ["true"]);
    assert_eq!(child.tagged("FINE"), ["Ok(5)"]);
    // The hook's cost with its record, delivery thread and both hooks (budget 5 ms, advisory).
    eprintln!("hook took {} us", child.tagged("HOOK-MICROS")[0]);
    assert!(child.position("PREVIOUS", "caught here").is_some(), "{}", child.describe());
    assert!(child.output.status.success(), "{}", child.describe());
}

#[test]
fn a_panicking_sink_gives_no_second_record_and_the_previous_hook_still_runs() {
    let child = run_child("child_sink_panics");
    let records = child.records("RECORD");
    assert_eq!(records.len(), 1, "no record of the sink's own panic\n{}", child.describe());
    assert_eq!(records[0].message, "the outer panic");
    assert!(child.position("PREVIOUS", "the outer panic").is_some(), "{}", child.describe());
    // The process unwound as a failed test; a panic inside the panic hook would have aborted it.
    assert_eq!(child.output.status.code(), Some(TEST_FAILED_EXIT), "{}", child.describe());
}

#[test]
fn a_noted_gpu_error_types_the_next_panic_on_its_thread() {
    let child = run_child("child_gpu_error");
    let records = child.records("RECORD");
    assert_eq!(records.len(), 4, "{}", child.describe());
    let typed = &records[0];
    assert_eq!(typed.kind, CrashKind::GpuValidation);
    let gpu = typed.gpu.as_ref().expect("the gpu side");
    assert_eq!(gpu.class, Some(GpuErrorClass::Validation));
    assert_eq!(gpu.description, "bind group 0 does not match its layout");
    assert_eq!((gpu.backend.as_deref(), gpu.adapter.as_deref()), (Some("metal"), Some("Apple M2")));
    assert_eq!(typed.message, "wgpu error: validation error");
    assert_eq!((records[1].kind, records[1].gpu.as_ref()), (CrashKind::Panic, None), "the cause was consumed");
    assert_eq!((records[2].kind, records[2].gpu.as_ref()), (CrashKind::Panic, None), "another thread's cause");

    let lost = &records[3];
    assert_eq!((lost.kind, lost.fatal, lost.handled), (CrashKind::DeviceLost, false, false));
    let gpu = lost.gpu.as_ref().expect("the lost device");
    assert_eq!((gpu.reason.as_deref(), gpu.description.as_str()), (Some("destroyed"), "the device was lost"));
    assert!(child.output.status.success(), "{}", child.describe());
}

#[test]
fn a_busy_replay_source_gives_an_incomplete_replay() {
    let child = run_child("child_replay_source");
    let records = child.records("RECORD");
    assert_eq!(records.len(), 2, "{}", child.describe());
    let free = records[0].replay.as_ref().expect("a replay with the ring free");
    assert_eq!((free.seed, free.from_tick, free.to_tick, free.complete), (9, 100, 120, true));
    assert_eq!(free.track, [1, 2, 3, 4]);
    let busy = records[1].replay.as_ref().expect("a replay with the ring busy");
    assert_eq!((busy.seed, busy.from_tick, busy.to_tick, busy.complete), (9, 120, 120, false));
    assert!(busy.track.is_empty());
    assert!(child.output.status.success(), "{}", child.describe());
}

#[test]
fn a_busy_replay_source_answers_within_a_millisecond() {
    // The hook's replay read on its own (the child rows above prove the hook uses it): a source
    // that never answers its lock costs no wait.
    let ring = Arc::new(Mutex::new(sample_tail()));
    let source = LockedSource(Arc::clone(&ring));
    let _held = ring.lock().expect("the ring");
    let at = RecordContext { seed: Some(3), tick: Some(40), ..RecordContext::default() };
    let started = Instant::now();
    let answer = replay::tail_from(&source, &at);
    let took = started.elapsed();
    assert_eq!(answer.as_ref().map(|replay| (replay.complete, replay.from_tick, replay.seed)), Some((false, 40, 3)));
    assert!(took < BUSY_SOURCE_MAX, "took {took:?}");
}

#[test]
fn installing_twice_installs_once() {
    let child = run_child("child_install_twice");
    assert_eq!(child.tagged("INSTALLS"), ["Now Already"]);
    assert_eq!(child.records("RECORD-A").len(), 1, "{}", child.describe());
    assert!(child.records("RECORD-B").is_empty(), "the second install's sinks are not added");
    assert_eq!(child.tagged("PREVIOUS").len(), 1, "the previous hook is chained once");
}

#[test]
fn context_values_read_back_as_set() {
    let ctx = genex_crash::CrashContext::new();
    assert_eq!(ctx.snapshot(), RecordContext::default(), "a fresh context knows nothing");
    ctx.set_identity(CrashIdentity {
        destination: "web".into(),
        flavour: CrashFlavour::Export,
        build: "b".into(),
        contract: 3,
        genex: "0.2.0".into(),
    });
    // Set once: a second identity is ignored.
    ctx.set_identity(CrashIdentity {
        destination: "ios".into(),
        flavour: CrashFlavour::Dev,
        build: "x".into(),
        contract: 9,
        genex: "9".into(),
    });
    ctx.set_seed(u32::MAX);
    ctx.set_tick(u64::MAX - 1, 16.5, false);
    ctx.set_frame(0);
    let snapshot = ctx.snapshot();
    assert_eq!(snapshot.destination.as_deref(), Some("web"));
    assert_eq!((snapshot.flavour, snapshot.contract), (Some(CrashFlavour::Export), Some(3)));
    assert_eq!((snapshot.seed, snapshot.tick, snapshot.frame), (Some(u32::MAX), Some(u64::MAX - 1), Some(0)));
    assert_eq!((snapshot.simulated_ms, snapshot.running), (Some(16.5), Some(false)));

    ctx.set_profile_summary(br#"{"v":1,"on":true}"#);
    assert_eq!(ctx.profile_summary(), Some(serde_json::json!({"v": 1, "on": true})));
    ctx.set_profile_summary(b"not json");
    assert_eq!(ctx.profile_summary(), None, "a summary that is not a JSON object is dropped");
    let over_cap = format!(r#"{{"pad":"{}"}}"#, "x".repeat(genex_crash::caps::CRASH_PROFILE_MAX_BYTES));
    ctx.set_profile_summary(over_cap.as_bytes());
    assert_eq!(ctx.profile_summary(), None, "a summary over its cap is dropped");
}
