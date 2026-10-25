//! A dev build's measured window run (`GENEX_BENCH`): the person's real window, fullscreen at the
//! monitor's own pixels if asked, driven to a scene and timed, so a frame rate is measured on a
//! real surface (Studio's runs draw headless). The variable holds one JSON object:
//!
//! ```json
//! { "seed": 7, "demo": "genex-clip", "camera": "horde", "fullscreen": "native",
//!   "renderScaleLock": 1.0, "nativeOutput": true, "features": { "shadows": true },
//!   "nodes": true, "seconds": 60, "out": "/path/to/bench.json" }
//! ```
//!
//! Once the loading screen is done the run is seeded (`seed`), the demo runs (`demo`), live play
//! starts and every frame draws the named camera (`camera`, else the game's own). `renderScaleLock`
//! holds the render scale (the `renderSettings` verb's lock; absent: dynamic resolution moves it),
//! `deviceClass` runs as that class (the verb's emulated class; absent: the probed one),
//! `features` switches render features as the verb does, and `nativeOutput` lifts Live's cap at the
//! class's reference resolution, so the frame draws the window's own pixels. `nodes` keeps per-node
//! GPU timing armed (the profile reports then carry each frame-graph node's GPU time; the brackets
//! cost a little themselves). The run opens no audio
//! device unless `"audio": true`. After `seconds` the run
//! writes `out` (every frame's wall time, shell interval, ticks and whether it drew; the window, output
//! and render sizes; the profile reports of the run) and exits. Only the dev flavour (`studio`) reads
//! it: an export never does.

#![allow(clippy::disallowed_types, clippy::disallowed_methods, reason = "host glue: a measured run times frames by the wall clock; the simulation never sees it")]

use std::path::PathBuf;
use std::time::Instant;

use serde_json::{Map, Value, json};

/// The environment variable that holds a measured run's plan.
pub(crate) const BENCH_ENV: &str = "GENEX_BENCH";
/// A profile report is taken every this many frames: under the report's 240-frame window, so the
/// reports cover every frame of the run.
const REPORT_EVERY_FRAMES: u64 = 200;
/// Frames a report covers (the profile report's most).
const REPORT_FRAMES: usize = genex_profile::report::PROFILE_REPORT_FRAMES_MAX;
/// The longest measured run, in seconds.
const BENCH_SECONDS_MAX: f64 = 3600.0;

/// What a measured run does ([`BenchPlan::parse`]).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct BenchPlan {
    pub(crate) seed: Option<u32>,
    pub(crate) demo: Option<String>,
    pub(crate) camera: Option<String>,
    /// How the window fills the monitor: `true` or `"borderless"`, or `"native"` (exclusive at
    /// the panel's own pixels).
    pub(crate) fullscreen: genex_platform_desktop::Fullscreen,
    /// A device class to run as (the `renderSettings` verb's emulated class), else the probed one.
    pub(crate) device_class: Option<String>,
    pub(crate) scale_lock: Option<f64>,
    pub(crate) native_output: bool,
    pub(crate) features: Vec<(String, bool)>,
    /// Whether per-node GPU timing stays armed through the run.
    pub(crate) nodes: bool,
    /// Whether the run opens the audio device (off unless asked: a measured run is silent).
    pub(crate) audio: bool,
    pub(crate) seconds: f64,
    pub(crate) out: PathBuf,
}

/// Why a plan was refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct BenchRefusal(pub(crate) String);

impl BenchPlan {
    /// The plan `text` spells: a JSON object of the keys above, `seconds` (0 < s <= an hour) and an
    /// absolute `out` required; an unknown key, a wrong type or a value out of range is refused.
    pub(crate) fn parse(text: &str) -> Result<BenchPlan, BenchRefusal> {
        let refuse = |what: &str| Err(BenchRefusal(what.to_owned()));
        let Ok(Value::Object(plan)) = serde_json::from_str::<Value>(text) else { return refuse("not a JSON object") };
        const KEYS: [&str; 12] = ["seed", "demo", "camera", "fullscreen", "deviceClass", "renderScaleLock", "nativeOutput", "features", "nodes", "audio", "seconds", "out"];
        if let Some(key) = plan.keys().find(|key| !KEYS.contains(&key.as_str())) {
            return refuse(&format!("unknown key {key}"));
        }
        let text_of = |key: &str| plan.get(key).map(|value| value.as_str().map(str::to_owned).ok_or(BenchRefusal(format!("{key} is not a string")))).transpose();
        let flag = |key: &str| plan.get(key).map_or(Ok(false), |value| value.as_bool().ok_or(BenchRefusal(format!("{key} is not a boolean"))));
        let seed = match plan.get("seed") {
            None => None,
            Some(value) => Some(value.as_u64().and_then(|seed| u32::try_from(seed).ok()).ok_or(BenchRefusal("seed is not a u32".into()))?),
        };
        let scale_lock = match plan.get("renderScaleLock") {
            None | Some(Value::Null) => None,
            Some(value) => Some(value.as_f64().filter(|scale| *scale > 0.0 && *scale <= 1.0).ok_or(BenchRefusal("renderScaleLock is not in (0, 1]".into()))?),
        };
        let features = match plan.get("features") {
            None => Vec::new(),
            Some(Value::Object(features)) => features_of(features)?,
            Some(_) => return refuse("features is not an object"),
        };
        let seconds = plan.get("seconds").and_then(Value::as_f64).filter(|seconds| *seconds > 0.0 && *seconds <= BENCH_SECONDS_MAX);
        let Some(seconds) = seconds else { return refuse("seconds is not in (0, 3600]") };
        let out = text_of("out")?.map(PathBuf::from).filter(|out| out.is_absolute());
        let Some(out) = out else { return refuse("out is not an absolute path") };
        Ok(BenchPlan {
            seed,
            demo: text_of("demo")?,
            camera: text_of("camera")?,
            fullscreen: fullscreen_of(plan.get("fullscreen"))?,
            device_class: text_of("deviceClass")?,
            scale_lock,
            native_output: flag("nativeOutput")?,
            features,
            nodes: flag("nodes")?,
            audio: flag("audio")?,
            seconds,
            out,
        })
    }

    /// This process's plan, when [`BENCH_ENV`] holds one; a refused plan is logged and ignored.
    pub(crate) fn from_process() -> Option<BenchPlan> {
        let text = std::env::var(BENCH_ENV).ok()?;
        BenchPlan::parse(&text).map_err(|refusal| eprintln!("genex: {BENCH_ENV} refused: {}", refusal.0)).ok()
    }
}

/// The plan's `fullscreen`: absent or `false` none, `true` or `"borderless"` borderless, `"native"`
/// exclusive at the monitor's own pixels.
fn fullscreen_of(value: Option<&Value>) -> Result<genex_platform_desktop::Fullscreen, BenchRefusal> {
    use genex_platform_desktop::Fullscreen;
    match value {
        None | Some(Value::Bool(false)) => Ok(Fullscreen::Off),
        Some(Value::Bool(true)) => Ok(Fullscreen::Borderless),
        Some(Value::String(mode)) if mode == "borderless" => Ok(Fullscreen::Borderless),
        Some(Value::String(mode)) if mode == "native" => Ok(Fullscreen::Native),
        Some(_) => Err(BenchRefusal("fullscreen is not true, false, \"borderless\" or \"native\"".into())),
    }
}

/// `features`' switches in key order, each a boolean.
fn features_of(features: &Map<String, Value>) -> Result<Vec<(String, bool)>, BenchRefusal> {
    features.iter().map(|(name, on)| on.as_bool().map(|on| (name.clone(), on)).ok_or(BenchRefusal(format!("feature {name} is not a boolean")))).collect()
}

/// One shell frame of a measured run.
#[derive(Clone, Copy, Debug)]
struct FrameRecord {
    /// Since the run began, milliseconds.
    at_ms: f64,
    /// The shell's frame interval.
    shell_ms: f64,
    /// The frame's own work (ticks, draw and present), wall milliseconds.
    work_ms: f64,
    ticks: u32,
    drew: bool,
}

/// A measured run in progress.
pub(crate) struct Bench {
    pub(crate) plan: BenchPlan,
    started: Option<Instant>,
    frames: Vec<FrameRecord>,
    reports: Vec<Value>,
    /// The window's surface size at the last frame.
    pub(crate) surface: [u32; 2],
    pub(crate) scale_factor: f64,
}

impl Bench {
    /// A run of `plan`, not begun.
    pub(crate) fn new(plan: BenchPlan) -> Bench {
        Bench { plan, started: None, frames: Vec::new(), reports: Vec::new(), surface: [0, 0], scale_factor: 1.0 }
    }

    /// Whether the scene was set up and the clock started.
    pub(crate) fn begun(&self) -> bool {
        self.started.is_some()
    }

    /// Start the clock (after the scene was set up).
    pub(crate) fn begin(&mut self) {
        self.started = Some(Instant::now());
    }

    /// Note one frame; answers whether the run is over.
    pub(crate) fn frame(&mut self, shell_ms: f64, work_ms: f64, ticks: u32, drew: bool) -> bool {
        let Some(started) = self.started else { return false };
        let at_ms = started.elapsed().as_secs_f64() * 1000.0;
        self.frames.push(FrameRecord { at_ms, shell_ms, work_ms, ticks, drew });
        at_ms >= self.plan.seconds * 1000.0
    }

    /// Whether a profile report is due after this frame.
    pub(crate) fn report_due(&self) -> bool {
        (self.frames.len() as u64).is_multiple_of(REPORT_EVERY_FRAMES) && !self.frames.is_empty()
    }

    /// Keep a profile report (its JSON bytes).
    pub(crate) fn keep_report(&mut self, json: Option<Vec<u8>>) {
        if let Some(report) = json.and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok()) {
            self.reports.push(report);
        }
    }

    /// The frames a report covers.
    pub(crate) const fn report_frames() -> usize {
        REPORT_FRAMES
    }

    /// Write the run's record to the plan's `out`, with `render` (the render status and sizes).
    pub(crate) fn write(&self, render: Value) {
        let frames: Vec<Value> = self
            .frames
            .iter()
            .map(|frame| json!([round(frame.at_ms), round(frame.shell_ms), round(frame.work_ms), frame.ticks, u8::from(frame.drew)]))
            .collect();
        let record = json!({
            "plan": {
                "seed": self.plan.seed, "demo": self.plan.demo, "camera": self.plan.camera, "fullscreen": format!("{:?}", self.plan.fullscreen),
                "deviceClass": self.plan.device_class, "renderScaleLock": self.plan.scale_lock, "nativeOutput": self.plan.native_output, "nodes": self.plan.nodes, "seconds": self.plan.seconds,
            },
            "surface": self.surface,
            "scaleFactor": self.scale_factor,
            "render": render,
            "frameColumns": ["atMs", "shellMs", "workMs", "ticks", "drew"],
            "frames": frames,
            "reports": self.reports,
        });
        let bytes = serde_json::to_vec(&record).unwrap_or_default();
        if let Err(error) = std::fs::write(&self.plan.out, bytes) {
            eprintln!("genex: the bench record was not written to {}: {error}", self.plan.out.display());
        }
    }
}

/// `ms` to whole microseconds.
fn round(ms: f64) -> f64 {
    (ms * 1000.0).round() / 1000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plan_spells_its_scene_and_its_measurement() {
        let plan = BenchPlan::parse(
            r#"{"seed":7,"demo":"genex-clip","camera":"horde","fullscreen":true,"renderScaleLock":1.0,"nativeOutput":true,"features":{"shadows":false},"nodes":true,"seconds":60,"out":"/tmp/b.json"}"#,
        )
        .expect("a whole plan");
        assert_eq!(plan.seed, Some(7));
        assert_eq!(plan.demo.as_deref(), Some("genex-clip"));
        assert_eq!(plan.camera.as_deref(), Some("horde"));
        assert!(plan.fullscreen == genex_platform_desktop::Fullscreen::Borderless && plan.native_output);
        let native = BenchPlan::parse(r#"{"fullscreen":"native","seconds":1,"out":"/tmp/b.json"}"#).expect("native");
        assert_eq!(native.fullscreen, genex_platform_desktop::Fullscreen::Native);
        assert_eq!(plan.scale_lock, Some(1.0));
        assert_eq!(plan.features, vec![("shadows".to_owned(), false)]);
        assert!(plan.nodes, "per-node GPU timing stays armed");
        assert_eq!(plan.seconds, 60.0);
        let least = BenchPlan::parse(r#"{"seconds":1,"out":"/tmp/b.json"}"#).expect("the least plan");
        assert_eq!((least.seed, least.scale_lock, least.fullscreen, least.native_output, least.nodes), (None, None, genex_platform_desktop::Fullscreen::Off, false, false));
    }

    /// Hostile plans: each is refused whole, so a run never half-applies one.
    #[test]
    fn a_wrong_plan_is_refused() {
        let rows = [
            "",
            "[]",
            r#"{"seconds":1}"#,
            r#"{"seconds":1,"out":"relative.json"}"#,
            r#"{"seconds":0,"out":"/tmp/b.json"}"#,
            r#"{"seconds":99999,"out":"/tmp/b.json"}"#,
            r#"{"seconds":1,"out":"/tmp/b.json","seed":-1}"#,
            r#"{"seconds":1,"out":"/tmp/b.json","seed":4294967296}"#,
            r#"{"seconds":1,"out":"/tmp/b.json","renderScaleLock":0}"#,
            r#"{"seconds":1,"out":"/tmp/b.json","renderScaleLock":1.5}"#,
            r#"{"seconds":1,"out":"/tmp/b.json","features":{"shadows":"off"}}"#,
            r#"{"seconds":1,"out":"/tmp/b.json","fullscreen":1}"#,
            r#"{"seconds":1,"out":"/tmp/b.json","fullscreen":"exclusive"}"#,
            r#"{"seconds":1,"out":"/tmp/b.json","demo":3}"#,
            r#"{"seconds":1,"out":"/tmp/b.json","nodes":"yes"}"#,
            r#"{"seconds":1,"out":"/tmp/b.json","window":"big"}"#,
        ];
        for row in rows {
            assert!(BenchPlan::parse(row).is_err(), "{row}");
        }
    }

    #[test]
    fn a_run_ends_after_its_seconds_and_reports_each_window() {
        let mut bench = Bench::new(BenchPlan::parse(r#"{"seconds":0.001,"out":"/tmp/b.json"}"#).expect("plan"));
        assert!(!bench.frame(16.0, 1.0, 1, true), "nothing counts before the run begins");
        bench.begin();
        for _ in 1..REPORT_EVERY_FRAMES {
            bench.frame(16.0, 1.0, 1, true);
            assert!(!bench.report_due());
        }
        std::thread::sleep(std::time::Duration::from_millis(2));
        assert!(bench.frame(16.0, 1.0, 1, true), "past its seconds");
        assert!(bench.report_due());
    }
}
