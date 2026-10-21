//! The dev-only `profile` verb (game systems PROF-4): the studio checks the argument (the action,
//! the report's frames clamped to the wire's cap, the arm's mode) and hands the game a typed
//! request; a game without profiles answers `unavailable`; a trace is written by the studio into
//! the run's `state/profile/` with its size and digest; the web flavour, which an export serves
//! too, answers `unknown-op`. Every refused request leaves the game and the state folder untouched.

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

use genex_core::digest::{fnv1a64, hex64};
use genex_core::json::{self, Value};
use genex_core::session::StepResult;
use genex_studio::verbs::ProfileAnswer;
use genex_studio::wire::{GpuTimingMode, PROFILE_REPORT_FRAMES_DEFAULT, PROFILE_REPORT_FRAMES_MAX, ProfileAction, ProfileRequest};
use genex_studio::{CaptureFault, Injection, Op, Pixels, Studio, StudioGame, VerbRefusal};

/// What a profiling double answers each request with.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Serves {
    /// The trait's default: no profiles (`unavailable`).
    Nothing,
    /// Every action answered: the summary, a report, the arm's mode, a trace's bytes.
    Everything,
    /// Every action refused with this code.
    Refuses(&'static str),
}

/// A game that records the profile requests the studio handed it.
struct Double {
    serves: Serves,
    requests: Vec<ProfileRequest>,
    seeds: u32,
}

impl Double {
    fn new(serves: Serves) -> Double {
        Double { serves, requests: Vec::new(), seeds: 0 }
    }
}

/// The trace a serving double hands back for `frames`.
fn trace_bytes(frames: u32) -> Vec<u8> {
    format!(r#"{{"traceEvents":[],"frames":{frames}}}"#).into_bytes()
}

impl StudioGame for Double {
    fn seed(&mut self, _seed: u32) {
        self.seeds += 1;
    }
    fn start(&mut self) -> bool {
        true
    }
    fn pause(&mut self) -> bool {
        false
    }
    fn step(&mut self, _ms: f64) -> StepResult {
        StepResult { ticks: 1, frame: 1, simulated_ms: 16.0 }
    }
    fn state(&mut self, _camera: &str) -> Value {
        Value::object()
    }
    fn inject(&mut self, _injection: &Injection) -> Vec<String> {
        Vec::new()
    }
    fn view(&mut self, _name: Option<&str>) -> bool {
        true
    }
    fn render(&mut self) {}
    fn world_size(&self) -> [u32; 2] {
        [4, 2]
    }
    fn capture(&mut self) -> Result<Pixels, CaptureFault> {
        Err(CaptureFault::Readback)
    }
    fn profile(&mut self, request: &ProfileRequest) -> Result<ProfileAnswer, &'static str> {
        match self.serves {
            Serves::Nothing => return Err(VerbRefusal::UNAVAILABLE),
            Serves::Refuses(code) => return Err(code),
            Serves::Everything => {}
        }
        self.requests.push(*request);
        let mut answer = Value::object();
        match request.action {
            ProfileAction::Summary => {
                answer.set("v", Value::from(1));
                answer.set("on", Value::Bool(true));
            }
            ProfileAction::Report => {
                answer.set("v", Value::from(2));
                answer.set("frames", Value::array());
                answer.set("truncated", Value::Bool(false));
            }
            ProfileAction::Arm => {
                let mode = request.mode.map_or("none", GpuTimingMode::wire);
                answer.set("mode", Value::from(mode));
            }
            ProfileAction::Trace => return Ok(ProfileAnswer::Trace(trace_bytes(request.frames))),
        }
        Ok(ProfileAnswer::Value(answer))
    }
}

/// A game that never overrides `profile`: the trait's default answers.
struct Plain;

impl StudioGame for Plain {
    fn seed(&mut self, _seed: u32) {}
    fn start(&mut self) -> bool {
        true
    }
    fn pause(&mut self) -> bool {
        false
    }
    fn step(&mut self, _ms: f64) -> StepResult {
        StepResult::default()
    }
    fn state(&mut self, _camera: &str) -> Value {
        Value::object()
    }
    fn inject(&mut self, _injection: &Injection) -> Vec<String> {
        Vec::new()
    }
    fn view(&mut self, _name: Option<&str>) -> bool {
        true
    }
    fn render(&mut self) {}
    fn world_size(&self) -> [u32; 2] {
        [4, 2]
    }
    fn capture(&mut self) -> Result<Pixels, CaptureFault> {
        Err(CaptureFault::Readback)
    }
}

/// A fresh, empty state folder (`<tmp>/genex-studio-profile-<pid>-<n>/`), as the host makes `state/`.
struct StateDir(PathBuf);

impl StateDir {
    fn new() -> StateDir {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("genex-studio-profile-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("state folder");
        StateDir(dir.canonicalize().expect("canonical state folder"))
    }

    /// The save root as genex-core spells it: the folder with its separator.
    fn root(&self) -> String {
        format!("{}/", self.0.display())
    }

    /// Every entry of the state folder, recursively, sorted.
    fn entries(&self) -> Vec<String> {
        let mut found = Vec::new();
        let mut folders = vec![self.0.clone()];
        while let Some(folder) = folders.pop() {
            for entry in fs::read_dir(&folder).expect("readable").map(|e| e.expect("entry")) {
                let path = entry.path();
                found.push(path.strip_prefix(&self.0).expect("inside").display().to_string());
                if path.is_dir() {
                    folders.push(path);
                }
            }
        }
        found.sort();
        found
    }
}

impl Drop for StateDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn ready(mut studio: Studio) -> Studio {
    studio.mark_ready();
    studio
}

fn reply<G: StudioGame>(studio: &mut Studio, game: &mut G, arg: &str) -> Value {
    let line = format!(r#"{{"id":1,"op":"profile","arg":{arg}}}"#);
    json::parse(&studio.handle(game, line.as_bytes())).expect("a reply is JSON")
}

fn result<G: StudioGame>(studio: &mut Studio, game: &mut G, arg: &str) -> Value {
    let reply = reply(studio, game, arg);
    assert_eq!(reply["ok"], Value::Bool(true), "{arg}: {}", String::from_utf8_lossy(&reply.dump()));
    reply["result"].clone()
}

fn refusal<G: StudioGame>(studio: &mut Studio, game: &mut G, arg: &str) -> String {
    let reply = reply(studio, game, arg);
    assert_eq!(reply["ok"], Value::Bool(false), "{arg}: {}", String::from_utf8_lossy(&reply.dump()));
    reply["error"].as_str().to_owned()
}

#[test]
fn a_game_without_profiles_answers_unavailable() {
    let state = StateDir::new();
    let mut studio = ready(Studio::native(&state.root()));
    for arg in [r#"{"action":"summary"}"#, r#"{"action":"report"}"#, r#"{"action":"arm","mode":"nodes"}"#, r#"{"action":"trace"}"#] {
        assert_eq!(refusal(&mut studio, &mut Plain, arg), VerbRefusal::UNAVAILABLE, "{arg}");
    }
    let mut game = Double::new(Serves::Nothing);
    assert_eq!(refusal(&mut studio, &mut game, r#"{"action":"summary"}"#), VerbRefusal::UNAVAILABLE);
    assert!(game.requests.is_empty());
    assert!(state.entries().is_empty(), "nothing written: {:?}", state.entries());
}

#[test]
fn an_argument_outside_its_shape_answers_bad_argument_and_never_reaches_the_game() {
    let state = StateDir::new();
    let mut studio = ready(Studio::native(&state.root()));
    let mut game = Double::new(Serves::Everything);
    let hostile = [
        "null",
        "7",
        r#""summary""#,
        "{}",
        r#"{"action":"frames"}"#,
        r#"{"action":"Summary"}"#,
        r#"{"action":7}"#,
        r#"{"action":null}"#,
        r#"{"action":"report","frames":0}"#,
        r#"{"action":"report","frames":-3}"#,
        r#"{"action":"report","frames":1.5}"#,
        r#"{"action":"report","frames":"120"}"#,
        r#"{"action":"report","frames":null}"#,
        r#"{"action":"arm"}"#,
        r#"{"action":"arm","mode":"all"}"#,
        r#"{"action":"arm","mode":true}"#,
        r#"{"action":"summary","mode":"gpu"}"#,
    ];
    for arg in hostile {
        assert_eq!(refusal(&mut studio, &mut game, arg), VerbRefusal::BAD_ARGUMENT, "{arg}");
    }
    assert!(game.requests.is_empty(), "no refused request reached the game");
    assert_eq!(game.seeds, 0);
    assert!(state.entries().is_empty(), "nothing written: {:?}", state.entries());
}

#[test]
fn a_report_s_frames_default_to_120_and_are_clamped_to_240() {
    let mut studio = ready(Studio::native(""));
    let mut game = Double::new(Serves::Everything);
    let report = result(&mut studio, &mut game, r#"{"action":"report"}"#);
    assert_eq!(report["v"].as_f64(), 2.0);
    for arg in [r#"{"action":"report","frames":10000}"#, r#"{"action":"report","frames":240}"#, r#"{"action":"report","frames":1}"#] {
        result(&mut studio, &mut game, arg);
    }
    let frames: Vec<u32> = game.requests.iter().map(|request| request.frames).collect();
    assert_eq!(frames, [PROFILE_REPORT_FRAMES_DEFAULT, PROFILE_REPORT_FRAMES_MAX, 240, 1]);
    assert_eq!((PROFILE_REPORT_FRAMES_DEFAULT, PROFILE_REPORT_FRAMES_MAX), (120, 240), "frame-profile.ts's caps");
    assert!(game.requests.iter().all(|request| request.action == ProfileAction::Report && request.mode.is_none()));
}

#[test]
fn summary_and_arm_hand_the_game_s_answer_through() {
    let mut studio = ready(Studio::native(""));
    let mut game = Double::new(Serves::Everything);
    let summary = result(&mut studio, &mut game, r#"{"action":"summary"}"#);
    assert_eq!(summary["on"], Value::Bool(true));
    let armed = result(&mut studio, &mut game, r#"{"action":"arm","mode":"nodes"}"#);
    assert_eq!(armed["mode"].as_str(), "nodes");
    let disarmed = result(&mut studio, &mut game, r#"{"action":"arm","mode":"frame"}"#);
    assert_eq!(disarmed["mode"].as_str(), "frame");
    let modes: Vec<Option<GpuTimingMode>> = game.requests.iter().map(|request| request.mode).collect();
    assert_eq!(modes, [None, Some(GpuTimingMode::Nodes), Some(GpuTimingMode::Frame)]);
}

#[test]
fn a_game_s_refusal_is_answered_with_its_code() {
    let mut studio = ready(Studio::native(""));
    let mut game = Double::new(Serves::Refuses(VerbRefusal::BUSY));
    assert_eq!(refusal(&mut studio, &mut game, r#"{"action":"report"}"#), VerbRefusal::BUSY);
}

#[test]
fn a_trace_is_written_under_state_profile_with_its_size_and_digest() {
    let state = StateDir::new();
    let mut studio = ready(Studio::native(&state.root()));
    let mut game = Double::new(Serves::Everything);
    for (seq, frames) in [(1, PROFILE_REPORT_FRAMES_DEFAULT), (2, 30)] {
        let arg = if seq == 1 { r#"{"action":"trace"}"#.to_owned() } else { format!(r#"{{"action":"trace","frames":{frames}}}"#) };
        let answer = result(&mut studio, &mut game, &arg);
        let written = fs::read(state.0.join(format!("profile/trace-{seq}.json"))).expect("trace file");
        assert_eq!(written, trace_bytes(frames));
        assert_eq!(answer["bytes"].as_f64(), written.len() as f64);
        assert_eq!(answer["digest"].as_str(), hex64(fnv1a64(&written)));
        assert_eq!(answer["seq"].as_f64(), f64::from(seq));
    }
    assert_eq!(state.entries(), ["profile", "profile/trace-1.json", "profile/trace-2.json"]);
}

#[test]
fn a_trace_without_a_trustworthy_state_folder_writes_nothing() {
    for root in ["", "relative/state/", "/tmp/../escape/"] {
        let mut studio = ready(Studio::native(root));
        let mut game = Double::new(Serves::Everything);
        assert_eq!(refusal(&mut studio, &mut game, r#"{"action":"trace"}"#), VerbRefusal::NO_STATE_DIR, "{root:?}");
        assert!(game.requests.is_empty(), "{root:?}: the game draws no trace that has nowhere to go");
    }
    assert!(!PathBuf::from("relative/state/profile").exists());
}

#[test]
fn a_native_dev_run_lists_profile_and_the_web_flavour_answers_unknown_op() {
    let mut native = ready(Studio::native(""));
    let mut game = Double::new(Serves::Everything);
    let unknown = json::parse(&native.handle(&mut game, br#"{"id":2,"op":"nope"}"#)).expect("JSON");
    let offered: Vec<String> = unknown["available"].items().iter().map(|op| op.as_str().to_owned()).collect();
    assert!(offered.iter().any(|op| op == Op::PROFILE), "native dev runs serve profile: {offered:?}");
    let mut web = ready(Studio::web());
    let answer = reply(&mut web, &mut game, r#"{"action":"summary"}"#);
    assert_eq!(answer["error"].as_str(), "unknown-op", "the web flavour serves an export too (CONTRACT.md)");
    let listed: Vec<String> = answer["available"].items().iter().map(|op| op.as_str().to_owned()).collect();
    assert!(!listed.iter().any(|op| op == Op::PROFILE), "{listed:?}");
    assert_eq!(Op::PROFILE, "profile");
    assert!(game.requests.iter().all(|request| request.action == ProfileAction::Summary));
}
