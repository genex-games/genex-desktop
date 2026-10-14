//! The spike-only self-test (M0a.7): seed, run a named demo, then run a fixed number of ticks,
//! capturing the world target at fixed checkpoints, and write one JSON record of the probe fields
//! and capture digests. The native `--self-test <ticks>` mode and the web export run this same
//! sequence, so M0a.11/M0a.12 (device records pulled by the person) and M0a.15 (the Mac golden)
//! compare like with like. The record holds nothing from the wall clock or the adapter, so two
//! runs of one build on one machine give identical bytes.

use crate::handle::GameHandle;
use genex::{FIXED_STEP_MS, MAX_STEP_TICKS, UnknownName, Value, json};
use std::fmt;

/// The record's `format` field.
pub const SELF_TEST_FORMAT: &str = "genex-self-test/1";
/// Ticks between two checkpoint captures after the demo.
pub const SELF_TEST_CAPTURE_EVERY_TICKS: u32 = 200;
/// The most ticks a self-test runs: one `step` verb's worth.
pub const SELF_TEST_MAX_TICKS: u32 = MAX_STEP_TICKS;

/// What a self-test runs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SelfTestPlan {
    /// The game's name, copied into the record.
    pub game: String,
    /// The seed.
    pub seed: u32,
    /// The demo run right after the seed.
    pub demo: String,
    /// Ticks run after the demo (at most [`SELF_TEST_MAX_TICKS`]).
    pub ticks: u32,
}

impl SelfTestPlan {
    /// Ticks after the demo at which the world target is captured: right after the demo, every
    /// [`SELF_TEST_CAPTURE_EVERY_TICKS`], and at the end.
    pub fn checkpoints(&self) -> Vec<u32> {
        let ticks = self.ticks.min(SELF_TEST_MAX_TICKS);
        let mut points: Vec<u32> = (0..ticks).step_by(SELF_TEST_CAPTURE_EVERY_TICKS as usize).collect();
        points.push(ticks);
        points.dedup();
        points
    }
}

/// One checkpoint capture: the tick it shows and its pixels' digest.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CaptureDigest {
    /// `state().frame` when it was taken.
    pub tick: u64,
    /// Width in pixels.
    pub width: u32,
    /// Height in pixels.
    pub height: u32,
    /// FNV-1a 64 of the top-down BGRA pixels, 16 hex digits.
    pub digest: String,
}

/// Why a self-test stopped.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SelfTestError {
    /// The game has no demo of that name.
    UnknownDemo(UnknownName),
    /// A checkpoint capture failed (its renderer's typed code and detail).
    Capture(String),
}

impl SelfTestError {
    /// The typed code's wire spelling.
    pub const fn code(&self) -> &'static str {
        match self {
            SelfTestError::UnknownDemo(_) => "unknown-demo",
            SelfTestError::Capture(_) => "capture-failed",
        }
    }
}

impl fmt::Display for SelfTestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SelfTestError::UnknownDemo(unknown) => write!(f, "{}: {unknown}", self.code()),
            SelfTestError::Capture(detail) => write!(f, "{}: {detail}", self.code()),
        }
    }
}

impl std::error::Error for SelfTestError {}

/// Seed and run the plan's demo; answers the demo's result.
pub fn begin(game: &mut dyn GameHandle, plan: &SelfTestPlan) -> Result<Value, SelfTestError> {
    game.seed(plan.seed);
    game.demo(&plan.demo).map_err(SelfTestError::UnknownDemo)
}

/// Run the ticks between two checkpoints (`from` and `to` count ticks after the demo).
pub fn advance(game: &mut dyn GameHandle, from: u32, to: u32) {
    if to > from {
        game.step(f64::from(to - from) * FIXED_STEP_MS);
    }
}

/// The record, pretty-printed with a trailing newline.
pub fn record(plan: &SelfTestPlan, game: &dyn GameHandle, demo_result: &Value, captures: &[CaptureDigest]) -> String {
    let captures: Vec<Value> = captures
        .iter()
        .map(|c| json!({ "tick": c.tick, "width": c.width, "height": c.height, "digest": c.digest }))
        .collect();
    let record = json!({
        "format": SELF_TEST_FORMAT,
        "game": plan.game,
        "seed": plan.seed,
        "demo": plan.demo,
        "demoResult": demo_result,
        "ticks": plan.ticks.min(SELF_TEST_MAX_TICKS),
        "frame": game.tick(),
        "checksum": game.checksum(),
        "probes": game.probes(),
        "captures": captures,
    });
    let mut text = serde_json::to_string_pretty(&record).unwrap_or_default();
    text.push('\n');
    text
}

/// The whole sequence with a blocking capture (the native build).
pub fn run(
    game: &mut dyn GameHandle,
    plan: &SelfTestPlan,
    mut capture: impl FnMut(&mut dyn GameHandle) -> Result<CaptureDigest, String>,
) -> Result<String, SelfTestError> {
    let demo_result = begin(game, plan)?;
    let mut captures = Vec::new();
    let mut done = 0;
    for point in plan.checkpoints() {
        advance(game, done, point);
        done = point;
        captures.push(capture(game).map_err(SelfTestError::Capture)?);
    }
    Ok(record(plan, game, &demo_result, &captures))
}

#[cfg(test)]
mod tests {
    use super::*;
    use genex::{Game, Input, Key, Runtime};

    #[derive(Default)]
    struct World {
        presses: u32,
    }

    fn runtime() -> Runtime<World> {
        let mut game = Game::new(World::default()).world_size(64, 64);
        game.on_update(|sim, ctx| {
            if ctx.keys.pressed(Key::Space) {
                sim.world.presses += 1;
            }
        });
        game.probe("presses", |sim| json!(sim.world.presses));
        game.demo("press", |d| {
            d.inject(Input::key_tap(Key::Space));
            d.advance_ms(100);
            json!({ "pressed": 1 })
        });
        Runtime::new(game).expect("valid game")
    }

    fn plan(ticks: u32) -> SelfTestPlan {
        SelfTestPlan { game: "test".to_owned(), seed: 7, demo: "press".to_owned(), ticks }
    }

    fn fake_capture(game: &mut dyn GameHandle) -> Result<CaptureDigest, String> {
        Ok(CaptureDigest { tick: game.tick(), width: 64, height: 64, digest: format!("{:016x}", game.tick()) })
    }

    #[test]
    fn checkpoints_cover_the_demo_end_every_interval_and_the_last_tick() {
        assert_eq!(plan(600).checkpoints(), [0, 200, 400, 600]);
        assert_eq!(plan(450).checkpoints(), [0, 200, 400, 450]);
        assert_eq!(plan(0).checkpoints(), [0]);
        assert_eq!(*plan(u32::MAX).checkpoints().last().expect("one point"), SELF_TEST_MAX_TICKS);
    }

    #[test]
    fn a_run_steps_exactly_the_planned_ticks_and_records_every_checkpoint() {
        let mut game = runtime();
        let text = run(&mut game, &plan(450), fake_capture).expect("runs");
        let record: Value = serde_json::from_str(&text).expect("json");
        let demo_ticks = 6;
        assert_eq!(record["frame"], json!(demo_ticks + 450));
        assert_eq!(record["probes"], json!({ "presses": 1 }));
        assert_eq!(record["demoResult"], json!({ "pressed": 1 }));
        let ticks: Vec<u64> = record["captures"].as_array().expect("captures").iter().map(|c| c["tick"].as_u64().unwrap_or(0)).collect();
        assert_eq!(ticks, [demo_ticks, demo_ticks + 200, demo_ticks + 400, demo_ticks + 450]);
        assert_eq!(record["format"], json!(SELF_TEST_FORMAT));
    }

    #[test]
    fn two_runs_of_one_plan_give_identical_bytes() {
        let first = run(&mut runtime(), &plan(300), fake_capture).expect("runs");
        let mut reused = runtime();
        reused.step(5000.0);
        let second = run(&mut reused, &plan(300), fake_capture).expect("runs");
        assert_eq!(first, second, "the seed rebuilds everything the record reads");
    }

    #[test]
    fn an_unknown_demo_or_a_failed_capture_is_refused_with_its_code() {
        let unknown = SelfTestPlan { demo: "nope".to_owned(), ..plan(10) };
        let error = run(&mut runtime(), &unknown, fake_capture).expect_err("refused");
        assert_eq!(error.code(), "unknown-demo");
        let error = run(&mut runtime(), &plan(10), |_| Err("capture-failed: lost".to_owned())).expect_err("refused");
        assert_eq!(error.code(), "capture-failed");
    }
}
