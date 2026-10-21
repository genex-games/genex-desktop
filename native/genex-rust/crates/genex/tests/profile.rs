//! Profiling through the facade (game systems PROF-5): a game times its own blocks with
//! `genex::profile_scope!` and reports numbers with `genex::profile::counter`; the runtime times
//! each tick, and a shell that profiles (`Runtime::profiling`) closes one frame per Live frame.
//! `state().volatile.profile` then summarizes the last frames. Profiling is write-only: the
//! checksums are the same with scopes on, off or never started, and a run that never started the
//! profiler has no `volatile.profile` at all (its `state()` is unchanged).

use genex::prelude::*;
use genex::profile::{EngineScope, ScopeName};
use genex::{FIXED_STEP_MS, Runtime};

/// Ticks of the checksum rows: a minute of play.
const TICKS: u32 = 3_600;
const ENEMIES: ScopeName = ScopeName::new("enemies");

#[derive(Default)]
struct World {
    x: f32,
    hits: u32,
}

/// A game that spends a little time in a named scope each update and counts its enemies.
fn game() -> Game<World> {
    let mut game = Game::new(World::default()).title("Profiled").world_size(96, 64);
    game.on_update(|sim, ctx| {
        genex::profile_scope!("enemy_ai");
        let mut acc = 0u64;
        for i in 0..2_000u64 {
            acc = acc.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(i);
        }
        sim.world.x += ctx.rng.range_f32(-1.0, 1.0);
        sim.world.hits = sim.world.hits.wrapping_add((acc & 1) as u32);
        genex::profile::counter(ENEMIES, f64::from(sim.world.hits % 50));
    });
    game.probe("x", |sim| sim.world.x.into());
    game.probe("hits", |sim| sim.world.hits.into());
    game
}

fn running(game: Game<World>) -> Runtime<World> {
    let mut runtime = Runtime::new(game).expect("valid registrations");
    runtime.seed(1);
    runtime.start();
    runtime
}

/// One shell frame: the frame's scope around one tick, then the frame closed.
fn frame(runtime: &mut Runtime<World>) {
    {
        let _frame = genex::profile::engine_scope(EngineScope::Frame);
        runtime.step(FIXED_STEP_MS);
    }
    runtime.profiling().new_frame(FIXED_STEP_MS, None);
}

#[test]
fn volatile_profile_has_on_cpu_and_the_slowest_scopes_after_130_frames() {
    let mut runtime = running(game());
    runtime.profiling().start(true);
    for _ in 0..130 {
        frame(&mut runtime);
    }
    let state = runtime.state();
    let profile = &state["volatile"]["profile"];
    assert_eq!(profile["v"], 1, "{profile}");
    assert_eq!(profile["on"], true, "{profile}");
    assert!(profile["frames"].as_u64().is_some_and(|frames| frames >= 100), "{profile}");
    assert!(profile["cpu"]["p50"].as_f64().is_some_and(|ms| ms > 0.0), "{profile}");
    let top: Vec<(&str, bool)> = profile["top"]
        .as_array()
        .expect("top")
        .iter()
        .map(|row| (row["scope"].as_str().unwrap_or_default(), row["game"].as_bool().unwrap_or_default()))
        .collect();
    assert!(top.contains(&("enemy_ai", true)), "the game's scope: {top:?}");
    assert!(top.contains(&("tick", false)), "the runtime's tick: {top:?}");
    assert!(top.len() <= 8, "PROFILE_TOP_SCOPES");
    assert!(profile["counters"]["enemies"].as_f64().is_some(), "{profile}");
    assert!(serde_json::to_vec(profile).expect("json").len() <= 4 * 1024, "PROFILE_SUMMARY_MAX_BYTES");
    let keys: Vec<&str> = profile.as_object().expect("an object").keys().map(String::as_str).collect();
    let mut fields = genex::profile::SUMMARY_FIELDS.to_vec();
    let mut sorted = keys.clone();
    sorted.sort_unstable();
    fields.sort_unstable();
    assert_eq!(sorted, fields, "the summary's members are SUMMARY_FIELDS");
}

#[test]
fn a_run_that_never_profiles_has_no_volatile_profile() {
    let mut runtime = running(game());
    for _ in 0..10 {
        runtime.step(FIXED_STEP_MS);
    }
    let state = runtime.state();
    assert!(state["volatile"].get("profile").is_none(), "state() is unchanged without a profiler: {}", state["volatile"]);
}

#[test]
fn scopes_off_still_answer_with_on_false() {
    let mut runtime = running(game());
    runtime.profiling().start(false);
    for _ in 0..40 {
        frame(&mut runtime);
    }
    let profile = runtime.state()["volatile"]["profile"].clone();
    assert_eq!(profile["on"], false, "{profile}");
    assert!(profile["top"].as_array().is_none_or(Vec::is_empty), "nothing recorded with scopes off: {profile}");
}

/// The checksum after each of `TICKS` ticks, with the profiler as `profiled` says.
fn checksums(profiled: Option<bool>) -> Vec<String> {
    let mut runtime = running(game());
    if let Some(on) = profiled {
        runtime.profiling().start(on);
    }
    let mut sums = Vec::with_capacity(TICKS as usize);
    for _ in 0..TICKS {
        if profiled.is_some() {
            frame(&mut runtime);
        } else {
            runtime.step(FIXED_STEP_MS);
        }
        sums.push(runtime.checksum());
    }
    sums
}

#[test]
fn checksums_over_3600_ticks_are_equal_with_scopes_on_off_and_never_started() {
    let never = checksums(None);
    assert_eq!(checksums(Some(true)), never, "scopes on");
    assert_eq!(checksums(Some(false)), never, "scopes off");
}
