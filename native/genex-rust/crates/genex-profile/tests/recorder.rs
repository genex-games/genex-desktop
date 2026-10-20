//! The recorder's rows (PROF-1a): synthetic frames timed by a fake clock give hand-computed
//! percentiles; the kept frames stay within the caps over 10,000 frames; the 257th game scope
//! name is dropped and counted; the summary stays within 4 KiB; a bad scope name does not build.
//! Each test runs on its own thread with its own profiler and its own fake clock.

use std::cell::Cell;

use genex_profile::caps::{
    PROFILE_COUNTERS_MAX, PROFILE_GAME_SCOPES_MAX, PROFILE_MEMORY_MAX_BYTES, PROFILE_MEMORY_MAX_BYTES_SMALL,
    PROFILE_SUMMARY_MAX_BYTES, SUMMARY_WINDOW_FRAMES,
};
use genex_profile::scope::Site;
use genex_profile::{CapsClass, EngineScope, ProfileCaps, Profiler, ProfilerConfig, ScopeKey, ScopeName, scope};

const NS_PER_MS: i64 = 1_000_000;
const NS_PER_US: i64 = 1_000;

thread_local! {
    static NOW: Cell<i64> = const { Cell::new(0) };
}

/// This thread's fake clock.
fn fake_clock() -> i64 {
    NOW.with(Cell::get)
}

fn advance(ns: i64) {
    NOW.with(|now| now.set(now.get() + ns));
}

fn profiler(class: CapsClass) -> Profiler {
    Profiler::new(ProfilerConfig::new(class).with_clock(fake_clock))
}

/// A game scope site named `name` at run time (the tests need more distinct names than literals).
fn site(name: String) -> &'static Site {
    let name = ScopeName::try_new(Box::leak(name.into_boxed_str())).expect("a valid scope name");
    Box::leak(Box::new(Site::new(name)))
}

#[test]
fn synthetic_frames_give_hand_computed_percentiles() {
    let mut profiler = profiler(CapsClass::Desktop);
    // Frame i (1..=20): physics takes i ms; enemy_ai takes 0.5 ms on even frames only.
    for i in 1..=20 {
        {
            let _frame = scope(EngineScope::Frame);
            {
                let _physics = scope(EngineScope::Physics);
                advance(i * NS_PER_MS);
            }
            if i % 2 == 0 {
                genex_profile::profile_scope!("enemy_ai");
                advance(NS_PER_MS / 2);
            }
        }
        profiler.new_frame();
    }
    let summary = profiler.summary();
    assert_eq!(summary.frames, 20);
    // CPU: 1, 2.5, 3, 4.5, …, 19, 20.5 ms. Nearest rank: p50 is the 10th (10.5), p95 the 19th (19).
    assert_eq!((summary.cpu.p50, summary.cpu.p95), (10.5, 19.0));
    // physics: 1..=20 ms, so the 10th is 10 and the 19th 19; enemy_ai: ten 0s and ten 0.5s.
    let top: Vec<(&str, bool, f64)> = summary.top.iter().map(|row| (row.scope, row.game, row.p95)).collect();
    assert_eq!(top, vec![("physics", false, 19.0), ("enemy_ai", true, 0.5)], "frame is the CPU number, not a top row");
    assert!(summary.on);
    assert!(summary.gpu.is_none());
    assert_eq!(summary.dropped, Default::default());
}

#[test]
fn the_window_holds_the_last_120_frames() {
    let mut profiler = profiler(CapsClass::Desktop);
    for i in 0..200 {
        {
            let _frame = scope(EngineScope::Frame);
            advance(i * NS_PER_US);
        }
        profiler.new_frame();
    }
    let summary = profiler.summary();
    assert_eq!(summary.frames, SUMMARY_WINDOW_FRAMES);
    // The last 120 frames took 80..=199 µs: nearest-rank p50 is the 60th, 139 µs.
    assert_eq!(summary.cpu.p50, 0.139);
    assert_eq!(profiler.window().next().map(|frame| frame.index), Some(80));
}

#[test]
fn ten_thousand_frames_stay_within_the_frame_and_byte_caps() {
    let mut profiler = profiler(CapsClass::Desktop);
    let caps = ProfileCaps::for_class(CapsClass::Desktop);
    for i in 0..10_000 {
        {
            let _frame = scope(EngineScope::Frame);
            let _tick = scope(EngineScope::Tick);
            // Durations wander so the slow set keeps changing.
            advance(((i * 7919) % 5_000 + 100) * NS_PER_US);
        }
        profiler.new_frame();
        assert!(profiler.frames_kept() <= caps.frames_max(), "frame {i} keeps {} frames", profiler.frames_kept());
    }
    assert!(profiler.bytes_kept() <= PROFILE_MEMORY_MAX_BYTES);
    assert_eq!(profiler.recent_frames().count(), caps.recent_frames);
    assert_eq!(profiler.slowest_frames().len(), caps.slow_frames);
    assert_eq!(profiler.frame_index(), 10_000);
}

#[test]
fn heavy_frames_on_a_phone_class_stay_within_its_byte_cap() {
    let mut profiler = profiler(CapsClass::Phone);
    let caps = ProfileCaps::for_class(CapsClass::Phone);
    for _ in 0..600 {
        {
            let _frame = scope(EngineScope::Frame);
            for _ in 0..1_000 {
                let _anim = scope(EngineScope::Anim);
                advance(NS_PER_US);
            }
        }
        profiler.new_frame();
        assert!(profiler.bytes_kept() <= PROFILE_MEMORY_MAX_BYTES_SMALL, "{} bytes kept", profiler.bytes_kept());
        assert!(profiler.frames_kept() <= caps.frames_max());
    }
    // About 30 KB a frame: the byte cap, not the frame cap, decides here.
    assert!(profiler.frames_kept() < caps.recent_frames, "{} frames kept", profiler.frames_kept());
}

#[test]
fn the_257th_game_scope_name_is_dropped_and_counted() {
    let mut profiler = profiler(CapsClass::Desktop);
    let sites: Vec<&'static Site> = (0..=PROFILE_GAME_SCOPES_MAX).map(|n| site(format!("cap_site_{n}"))).collect();
    for _ in 0..2 {
        {
            let _frame = scope(EngineScope::Frame);
            for site in &sites {
                let _scope = site.enter();
                advance(NS_PER_US);
            }
        }
        profiler.new_frame();
    }
    let summary = profiler.summary();
    assert_eq!(summary.dropped.scopes, 2, "the 257th name, once per frame");
    let last = profiler.window().last().expect("a frame");
    let game: Vec<&str> = last
        .scopes
        .iter()
        .filter_map(|(key, _)| match key {
            ScopeKey::Game(name) => Some(name.as_str()),
            ScopeKey::Engine(_) => None,
        })
        .collect();
    assert_eq!(game.len(), PROFILE_GAME_SCOPES_MAX);
    assert!(!game.contains(&"cap_site_256"));
}

#[test]
fn the_summary_stays_within_4_kib_with_256_scopes_and_full_counters() {
    let mut profiler = profiler(CapsClass::Desktop);
    let long = |n: usize| format!("{n:03}_{}", "x".repeat(44));
    let sites: Vec<&'static Site> = (0..PROFILE_GAME_SCOPES_MAX).map(|n| site(long(n))).collect();
    for n in 0..PROFILE_COUNTERS_MAX {
        let name = ScopeName::try_new(Box::leak(long(n).into_boxed_str())).expect("a valid name");
        profiler.counter(name, 1_234_567.891);
    }
    for _ in 0..3 {
        for (n, site) in sites.iter().enumerate() {
            let _scope = site.enter();
            advance((n as i64 + 1) * NS_PER_US);
        }
        profiler.new_frame();
    }
    let summary = profiler.summary();
    assert_eq!(summary.counters.len(), PROFILE_COUNTERS_MAX);
    let json = summary.to_json();
    assert!(json.len() <= PROFILE_SUMMARY_MAX_BYTES, "{} bytes", json.len());
    let parsed: serde_json::Value = serde_json::from_slice(&json).expect("valid JSON");
    assert_eq!(parsed["v"], 1);
    assert_eq!(parsed["top"].as_array().map(Vec::len), Some(8));
    let kept = parsed["counters"].as_object().map_or(0, serde_json::Map::len);
    assert!(kept < PROFILE_COUNTERS_MAX, "counters gave way");
    assert_eq!(parsed["dropped"]["counters"], (PROFILE_COUNTERS_MAX - kept) as u64, "each cut counter is counted");
}

#[test]
fn counters_past_the_cap_or_not_finite_are_dropped_and_counted() {
    let mut profiler = profiler(CapsClass::Desktop);
    for n in 0..=PROFILE_COUNTERS_MAX {
        let name = ScopeName::try_new(Box::leak(format!("counter_{n}").into_boxed_str())).expect("valid");
        genex_profile::counter(name, n as f64);
    }
    profiler.counter(ScopeName::new("counter_0"), f64::NAN);
    profiler.counter(ScopeName::new("counter_1"), 41.5);
    profiler.new_frame();
    let summary = profiler.summary();
    assert_eq!(summary.counters.len(), PROFILE_COUNTERS_MAX);
    assert_eq!(summary.counters.get("counter_1"), Some(&41.5));
    assert_eq!(summary.counters.get("counter_0"), Some(&0.0), "NaN left the last value alone");
    assert_eq!(summary.dropped.counters, 2, "the 65th name and the NaN");
}

#[test]
fn scopes_off_record_nothing_and_say_so() {
    let mut profiler = profiler(CapsClass::Desktop);
    profiler.set_on(false);
    {
        let frame = scope(EngineScope::Frame);
        assert!(!frame.is_recording());
        advance(NS_PER_MS);
    }
    profiler.new_frame();
    let summary = profiler.summary();
    assert!(!summary.on);
    assert_eq!(summary.frames, 0);
    assert_eq!(profiler.frames_kept(), 0);
}

#[test]
fn a_thread_that_is_not_attached_records_nothing() {
    let worker = std::thread::Builder::new()
        .spawn(|| scope(EngineScope::Physics).is_recording())
        .expect("the thread starts")
        .join()
        .expect("the thread ends");
    assert!(!worker);
}

#[test]
fn worker_scopes_join_the_frame_but_not_its_cpu_time() {
    let mut profiler = profiler(CapsClass::Desktop);
    let lane = profiler.worker();
    std::thread::Builder::new()
        .spawn(move || {
            lane.attach();
            let _nav = scope(EngineScope::Nav);
            advance(3 * NS_PER_MS);
        })
        .expect("the worker starts")
        .join()
        .expect("the worker ends");
    {
        let _frame = scope(EngineScope::Frame);
        advance(NS_PER_MS);
    }
    profiler.new_frame();
    let summary = profiler.summary();
    assert_eq!(summary.cpu.p50, 1.0, "only the main thread's top-level scopes");
    assert_eq!(summary.top.first().map(|row| (row.scope, row.p95)), Some(("nav", 3.0)));
}

#[test]
fn engine_scope_wire_spellings_round_trip() {
    for scope in EngineScope::ALL {
        assert_eq!(EngineScope::from_wire(scope.wire()), Some(*scope));
        assert!(genex_profile::scope::is_scope_name(scope.wire()), "{} is a valid name on the wire", scope.wire());
    }
    assert_eq!(EngineScope::from_wire("Frame"), None);
}

#[test]
fn scope_names_are_checked() {
    for good in ["a", "enemy_ai", "net.pump", "stream-commit", &"x".repeat(48)] {
        assert!(genex_profile::scope::is_scope_name(good), "{good}");
    }
    for bad in ["", "Bad Name", "enemy ai", "ÿ", "a/b", &"x".repeat(49)] {
        assert!(!genex_profile::scope::is_scope_name(bad), "{bad}");
    }
}

#[test]
fn a_bad_scope_name_does_not_build() {
    let cases = trybuild::TestCases::new();
    cases.compile_fail("tests/ui/*.rs");
}
