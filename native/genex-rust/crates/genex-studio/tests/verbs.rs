//! The verb dispatcher against a recording game double: the envelope answers what genex-core's
//! golden-checked `Dispatcher` answers, every verb keeps `studio.cpp`'s semantics (the JS `>>> 0`
//! seed, the busy guard, demos that end paused, cameras by name), and every hostile request is
//! refused with its v1 typed code and leaves the game and the state folder untouched.

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

use genex_core::json::{self, Value};
use genex_core::protocol::{Answer, Dispatcher};
use genex_core::session::StepResult;
use genex_studio::{
    CAPTURE_MAX_PX, CAPTURES_KEPT, CaptureFault, CaptureLens, Injection, Op, Pixels, Studio, StudioGame, VerbRefusal,
};

/// A game that records what the studio asked of it.
#[derive(Default)]
struct Double {
    seeds: Vec<u32>,
    steps: Vec<f64>,
    renders: u32,
    running: bool,
    busy: bool,
    view: Option<String>,
    demo_runs: Vec<String>,
    /// What `capture` hands back: (width, height, bytes); None answers a readback failure.
    pixels: Option<(u32, u32, usize)>,
    injected: Vec<Injection>,
    muted: Option<bool>,
    quits: u32,
    /// Whether the game draws captures at a size asked for (a Rust game), and what it was asked.
    sizes_taken: bool,
    capture_sizes: Vec<Option<[u32; 2]>>,
    /// Whether the game draws the look's lens on a capture that asks (a Rust game with render
    /// settings), and what each capture asked.
    lenses_taken: bool,
    capture_lenses: Vec<CaptureLens>,
}

impl Double {
    fn with_pixels(width: u32, height: u32) -> Double {
        let bytes = width as usize * height as usize * 4;
        Double { pixels: Some((width, height, bytes)), ..Double::default() }
    }

    /// Whether the studio asked for anything that changes the game.
    fn untouched(&self) -> bool {
        self.seeds.is_empty() && self.steps.is_empty() && self.demo_runs.is_empty() && self.injected.is_empty()
    }
}

impl StudioGame for Double {
    fn seed(&mut self, seed: u32) {
        self.seeds.push(seed);
        self.running = false;
    }
    fn start(&mut self) -> bool {
        self.running = true;
        true
    }
    fn pause(&mut self) -> bool {
        self.running = false;
        false
    }
    fn step(&mut self, ms: f64) -> StepResult {
        self.steps.push(ms);
        StepResult { ticks: 3, frame: 3, simulated_ms: 50.0 }
    }
    fn state(&mut self, camera: &str) -> Value {
        let mut state = Value::object();
        state.set("camera", Value::from(camera));
        state.set("running", Value::from(self.running));
        state
    }
    fn inject(&mut self, injection: &Injection) -> Vec<String> {
        self.injected.push(injection.clone());
        injection.down.clone()
    }
    fn view(&mut self, name: Option<&str>) -> bool {
        match name {
            None => {
                self.view = None;
                true
            }
            Some(name @ ("top" | "eye:spawn")) => {
                self.view = Some(name.to_owned());
                true
            }
            Some(_) => false,
        }
    }
    fn cameras(&self) -> Vec<String> {
        vec!["top".to_owned()]
    }
    fn eyes(&self) -> Vec<String> {
        vec!["eye:spawn".to_owned()]
    }
    fn demos(&self) -> Vec<String> {
        vec!["walk".to_owned()]
    }
    fn run_demo(&mut self, name: &str) -> Value {
        self.demo_runs.push(name.to_owned());
        // A demo that leaves the game running still ends paused.
        self.running = true;
        let mut out = Value::object();
        out.set("walked", Value::from(true));
        out
    }
    fn render(&mut self) {
        self.renders += 1;
    }
    fn draw_calls(&self) -> u32 {
        2
    }
    fn world_size(&self) -> [u32; 2] {
        [4, 2]
    }
    fn capture(&mut self) -> Result<Pixels, CaptureFault> {
        let (width, height, bytes) = self.pixels.ok_or(CaptureFault::Readback)?;
        let bgra = (0..bytes).map(|i| (i % 251) as u8).collect();
        Ok(Pixels { width, height, bgra })
    }
    fn busy(&self) -> bool {
        self.busy
    }
    fn set_muted(&mut self, muted: bool) {
        self.muted = Some(muted);
    }
    fn request_quit(&mut self) {
        self.quits += 1;
    }
    fn set_capture_size(&mut self, size: Option<[u32; 2]>) -> bool {
        self.capture_sizes.push(size);
        self.sizes_taken || size.is_none()
    }
    fn set_capture_lens(&mut self, lens: CaptureLens) -> bool {
        self.capture_lenses.push(lens);
        self.lenses_taken || lens == CaptureLens::default()
    }
}

/// A fresh, empty state folder (`<tmp>/genex-studio-verbs-<pid>-<n>/`), as the host makes `state/`.
struct StateDir(PathBuf);

impl StateDir {
    fn new() -> StateDir {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("genex-studio-verbs-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("state folder");
        StateDir(dir.canonicalize().expect("canonical state folder"))
    }

    /// The save root as genex-core spells it: the folder with its separator.
    fn root(&self) -> String {
        format!("{}/", self.0.display())
    }

    fn captures(&self) -> Vec<String> {
        let Ok(entries) = fs::read_dir(self.0.join("captures")) else { return Vec::new() };
        let mut names: Vec<String> =
            entries.map(|e| e.expect("entry").file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    }
}

impl Drop for StateDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn ready_studio(root: &str) -> Studio {
    let mut studio = Studio::native(root);
    studio.mark_ready();
    studio
}

fn reply(studio: &mut Studio, game: &mut Double, line: &str) -> Value {
    let text = studio.handle(game, line.as_bytes());
    json::parse(&text).expect("a reply is JSON")
}

fn result(studio: &mut Studio, game: &mut Double, line: &str) -> Value {
    let reply = reply(studio, game, line);
    assert_eq!(reply["ok"], Value::Bool(true), "{}", String::from_utf8_lossy(&reply.dump()));
    reply["result"].clone()
}

fn refusal(studio: &mut Studio, game: &mut Double, line: &str) -> String {
    let reply = reply(studio, game, line);
    assert_eq!(reply["ok"], Value::Bool(false), "{}", String::from_utf8_lossy(&reply.dump()));
    reply["error"].as_str().to_owned()
}

fn names(value: &Value) -> Vec<String> {
    value.items().iter().map(|v| v.as_str().to_owned()).collect()
}

/// genex-core's dispatcher with every op this studio answers, each answering `{}`.
fn core_dispatcher() -> Dispatcher {
    let mut calls = Dispatcher::default();
    for op in Op::ALL.iter().chain(&Op::DEV_TOOLS).chain(&Op::GAME_DATA) {
        calls.on(op, |_| Answer::Result(Value::object()));
    }
    calls
}

#[test]
fn the_envelope_answers_hostile_lines_byte_for_byte_as_genex_core_does() {
    let deep = format!(r#"{{"id":1,"op":"state","arg":{}1{}}}"#, "[".repeat(40), "]".repeat(40));
    let hostile: [&[u8]; 9] = [
        b"not json",
        b"[1,2]",
        b"\"text\"",
        b"{\"op\":\"state\"}",
        b"{\"id\":true,\"op\":\"state\"}",
        b"{\"id\":7,\"op\":\"nope\"}",
        b"{\"id\":\"x\",\"op\":42}",
        deep.as_bytes(),
        b"{\"id\":1,\"op\":\"st\\u0000ate\"}",
    ];
    let core = core_dispatcher();
    let state = StateDir::new();
    let mut studio = ready_studio(&state.root());
    let mut game = Double::default();
    for line in hostile {
        let ours = studio.handle(&mut game, line);
        assert_eq!(
            String::from_utf8_lossy(&ours),
            String::from_utf8_lossy(&core.handle(line)),
            "{}",
            String::from_utf8_lossy(line)
        );
    }
    assert_eq!(studio.line_too_long(), core.line_too_long());
    assert!(game.untouched());
    assert!(state.captures().is_empty());
}

#[test]
fn an_unknown_op_names_every_op_sorted() {
    let mut studio = ready_studio("");
    let mut game = Double::default();
    let reply = reply(&mut studio, &mut game, r#"{"id":3,"op":"surface"}"#);
    assert_eq!(reply["error"].as_str(), "unknown-op");
    // Game systems GF flipped: a native (dev) run also lists the asset tools it knows; I1 PROF-4
    // flipped it again: and `profile`; I4 UIS-16 flipped it again: and `saves`, `uiSettings`.
    let mut sorted: Vec<String> = Op::ALL.iter().chain(&Op::DEV_TOOLS).chain(&Op::GAME_DATA).map(|op| (*op).to_owned()).collect();
    sorted.sort();
    assert_eq!(names(&reply["available"]), sorted);
}

#[test]
fn a_native_run_knows_the_asset_tools_and_answers_them_unavailable_until_their_runtime_lands() {
    let mut studio = ready_studio("");
    let mut game = Double::default();
    for (op, arg) in [(Op::BAKE_ASSETS, r#"{"kind":"nav","name":"main"}"#), (Op::RELOAD_ASSETS, r#"{"files":[]}"#)] {
        let line = format!(r#"{{"id":8,"op":"{op}","arg":{arg}}}"#);
        assert_eq!(refusal(&mut studio, &mut game, &line), "unavailable", "{op}");
        // The web flavour serves an export too, which answers them unknown-op (CONTRACT.md).
        let mut web = Studio::web();
        web.mark_ready();
        assert_eq!(refusal(&mut web, &mut game, &line), "unknown-op", "{op} on the web");
    }
    assert!(game.untouched());
}

#[test]
fn a_call_before_the_game_began_is_answered_as_webcall_does_and_changes_nothing() {
    // v1's web build answers `{id:null, ok:false, op:null, error:"starting"}` before `begun`,
    // without parsing the call; a native run never gets here (`serve` leaves the lines queued).
    for mut studio in [Studio::web(), Studio::native("")] {
        let mut game = Double::with_pixels(4, 2);
        for (op, arg) in [
            (Op::SEED, r#"{"seed":9}"#),
            (Op::STEP, r#"{"ms":1000}"#),
            (Op::DEMO, r#"{"name":"walk"}"#),
            (Op::INPUT, r#"{"down":["KeyW"]}"#),
            (Op::CAPTURE, "{}"),
            (Op::QUIT, "null"),
        ] {
            let line = format!(r#"{{"id":5,"op":"{op}","arg":{arg}}}"#);
            assert_eq!(
                studio.handle(&mut game, line.as_bytes()),
                br#"{"id":null,"ok":false,"op":null,"error":"starting"}"#.to_vec(),
                "{op}"
            );
        }
        assert!(game.untouched());
        assert_eq!(game.renders, 0);
        assert_eq!(game.quits, 0);
        assert!(!studio.closing());
        studio.mark_ready();
        assert_eq!(result(&mut studio, &mut game, r#"{"id":6,"op":"seed","arg":{"seed":9}}"#)["seed"], Value::from(9));
    }
}

#[test]
fn the_web_flavour_serves_only_the_shared_ops_as_the_cpp_web_build_registers_them() {
    let mut web = Studio::web();
    web.mark_ready();
    assert_eq!(web.ops(), Op::SHARED);
    assert_eq!(Studio::native("").ops(), Op::ALL);
    assert_eq!(&Op::ALL[..Op::SHARED.len()], Op::SHARED, "native serves the shared ops, then its own");
    let mut game = Double::default();
    for native_only in [Op::AUDIO_LEVEL, Op::TIMING, Op::QUIT, Op::FRONT, Op::VISIBLE] {
        let line = format!(r#"{{"id":4,"op":"{native_only}"}}"#);
        let answer = reply(&mut web, &mut game, &line);
        assert_eq!(answer["error"].as_str(), "unknown-op", "{native_only}");
        let mut shared: Vec<String> = Op::SHARED.iter().map(|op| (*op).to_owned()).collect();
        shared.sort();
        assert_eq!(names(&answer["available"]), shared, "{native_only}");
    }
    assert_eq!(game.quits, 0);
    assert!(!web.closing(), "the web studio never quits");
    assert!(game.untouched());
}

#[test]
fn seed_reads_its_argument_as_javascript_unsigned_shift_does() {
    let mut studio = ready_studio("");
    let mut game = Double::default();
    let cases: [(&str, u32); 8] = [
        (r#"{"seed":7}"#, 7),
        ("7", 7),
        (r#"{"seed":-1}"#, 4_294_967_295),
        (r#"{"seed":4294967301}"#, 5),
        (r#"{"seed":3.9}"#, 3),
        (r#"{"seed":-3.9}"#, 4_294_967_293),
        (r#"{"seed":"12"}"#, 0),
        ("null", 0),
    ];
    for (arg, seed) in cases {
        let line = format!(r#"{{"id":1,"op":"seed","arg":{arg}}}"#);
        let answer = result(&mut studio, &mut game, &line);
        assert_eq!(answer["seed"], Value::from(seed), "{arg}");
        assert_eq!(answer["paused"], Value::Bool(true));
    }
    assert_eq!(game.seeds, cases.map(|(_, seed)| seed).to_vec());
    assert_eq!(game.renders, cases.len() as u32, "each seed draws the frame now");
}

#[test]
fn seed_and_step_are_refused_busy_while_the_game_ticks_or_draws() {
    let mut studio = ready_studio("");
    let mut game = Double { busy: true, ..Double::default() };
    assert_eq!(refusal(&mut studio, &mut game, r#"{"id":1,"op":"seed","arg":{"seed":2}}"#), VerbRefusal::BUSY);
    assert_eq!(refusal(&mut studio, &mut game, r#"{"id":2,"op":"step","arg":{"ms":100}}"#), VerbRefusal::BUSY);
    assert!(game.untouched());
    assert_eq!(game.renders, 0);
}

#[test]
fn step_defaults_to_one_tick_and_reports_the_frame() {
    let mut studio = ready_studio("");
    let mut game = Double::default();
    let answer = result(&mut studio, &mut game, r#"{"id":1,"op":"step"}"#);
    assert_eq!(game.steps, vec![genex_core::clock::FIXED_STEP_MS]);
    assert_eq!(answer.dump(), br#"{"frame":3,"simulatedMs":50,"steppedFrames":3,"drawCalls":2}"#.to_vec());
    result(&mut studio, &mut game, r#"{"id":2,"op":"step","arg":{"ms":1000}}"#);
    assert_eq!(game.steps[1], 1000.0);
    assert_eq!(game.renders, 2);
}

#[test]
fn a_demo_runs_paused_and_ends_paused_and_an_unknown_one_names_the_rest() {
    let mut studio = ready_studio("");
    let mut game = Double::default();
    result(&mut studio, &mut game, r#"{"id":1,"op":"start"}"#);
    let unknown = result(&mut studio, &mut game, r#"{"id":2,"op":"demo","arg":{"name":"fly"}}"#);
    assert_eq!(unknown.dump(), br#"{"ok":false,"available":["walk"]}"#.to_vec());
    assert!(game.demo_runs.is_empty());
    assert!(game.running, "an unknown demo leaves the clock alone");
    let ran = result(&mut studio, &mut game, r#"{"id":3,"op":"demo","arg":{"name":"walk"}}"#);
    assert_eq!(ran.dump(), br#"{"ok":true,"demo":"walk","result":{"walked":true}}"#.to_vec());
    assert!(!game.running, "a demo ends paused, whatever it did");
    assert_eq!(game.renders, 1);
    let listed = result(&mut studio, &mut game, r#"{"id":4,"op":"demos"}"#);
    assert_eq!(names(&listed["demos"]), ["walk"]);
}

#[test]
fn cameras_and_eyes_are_placed_by_name_and_default_gives_the_view_back() {
    let mut studio = ready_studio("");
    let mut game = Double::default();
    assert_eq!(names(&result(&mut studio, &mut game, r#"{"id":1,"op":"cameras"}"#)["cameras"]), ["default", "top"]);
    assert_eq!(names(&result(&mut studio, &mut game, r#"{"id":2,"op":"eyes"}"#)["eyes"]), ["eye:spawn"]);
    let unknown = result(&mut studio, &mut game, r#"{"id":3,"op":"debugCamera","arg":{"camera":"sky"}}"#);
    assert_eq!(unknown.dump(), br#"{"ok":false,"available":["default","top"]}"#.to_vec());
    assert_eq!(game.renders, 0);
    let placed = result(&mut studio, &mut game, r#"{"id":4,"op":"debugCamera","arg":{"camera":"eye:spawn"}}"#);
    assert_eq!(placed.dump(), br#"{"ok":true,"camera":"eye:spawn"}"#.to_vec());
    assert_eq!(game.view.as_deref(), Some("eye:spawn"));
    assert_eq!(result(&mut studio, &mut game, r#"{"id":5,"op":"state"}"#)["camera"].as_str(), "eye:spawn");
    let back = result(&mut studio, &mut game, r#"{"id":6,"op":"debugCamera","arg":{"camera":null}}"#);
    assert_eq!(back.dump(), br#"{"ok":true,"camera":"default"}"#.to_vec());
    assert_eq!(game.view, None);
}

#[test]
fn input_hands_the_parsed_injection_to_the_game_and_answers_what_is_held() {
    let mut studio = ready_studio("");
    let mut game = Double::default();
    let line = r#"{"id":1,"op":"input","arg":{"actions":[{"type":"down","keys":["KeyD"]},{"type":"hold","ms":5}]}}"#;
    let answer = result(&mut studio, &mut game, line);
    assert_eq!(names(&answer["held"]), ["KeyD"]);
    assert_eq!(answer["ignored"], Value::from(1));
    assert_eq!(game.injected.len(), 1);
}

#[test]
fn audio_quit_and_the_native_meters_answer_their_shapes() {
    let mut studio = ready_studio("");
    let mut game = Double::default();
    let muted = result(&mut studio, &mut game, r#"{"id":1,"op":"audio","arg":{"muted":true}}"#);
    assert_eq!(muted.dump(), br#"{"muted":true}"#);
    assert_eq!(game.muted, Some(true));
    assert_eq!(result(&mut studio, &mut game, r#"{"id":2,"op":"audio"}"#).dump(), br#"{"muted":true}"#);
    assert_eq!(result(&mut studio, &mut game, r#"{"id":3,"op":"audioLevel"}"#).dump(), br#"{"rms":0,"centroid":0}"#);
    let timing = result(&mut studio, &mut game, r#"{"id":4,"op":"timing"}"#);
    assert_eq!(timing.dump(), br#"{"frameMs":0,"updateMs":0,"drawMs":0,"frames":0}"#);
    assert_eq!(result(&mut studio, &mut game, r#"{"id":5,"op":"front"}"#).dump(), br#"{"fronted":false}"#);
    assert!(!studio.closing());
    assert_eq!(result(&mut studio, &mut game, r#"{"id":6,"op":"quit"}"#).dump(), br#"{"quitting":true}"#);
    assert!(studio.closing());
    assert_eq!(game.quits, 1);
}

/// FNV-1a 64 as the host recomputes it (`fnv1a64Hex`).
fn fnv_hex(bytes: &[u8]) -> String {
    let hash = bytes.iter().fold(0xcbf2_9ce4_8422_2325_u64, |h, b| (h ^ u64::from(*b)).wrapping_mul(0x0100_0000_01b3));
    format!("{hash:016x}")
}

fn capture_file(state: &StateDir, seq: u32) -> Vec<u8> {
    fs::read(state.0.join("captures").join(format!("{seq}.bgra"))).expect("capture file")
}

#[test]
fn a_capture_writes_its_file_and_declares_its_size_format_and_digest() {
    let state = StateDir::new();
    let mut studio = ready_studio(&state.root());
    let mut game = Double::with_pixels(4, 2);
    let answer = result(&mut studio, &mut game, r#"{"id":1,"op":"capture","arg":{}}"#);
    let bytes = capture_file(&state, 1);
    assert_eq!(bytes.len(), 4 * 2 * 4);
    assert_eq!(answer["seq"], Value::from(1));
    assert_eq!(answer["width"], Value::from(4));
    assert_eq!(answer["height"], Value::from(2));
    assert_eq!(answer["format"].as_str(), "bgra8");
    assert_eq!(answer["camera"].as_str(), "default");
    assert_eq!(answer["drawCalls"], Value::from(2));
    assert_eq!(answer["digest"].as_str(), fnv_hex(&bytes));
    assert_eq!(game.renders, 1, "the frame is drawn before it is read back");
}

#[test]
fn the_capture_folder_keeps_the_last_eight() {
    let state = StateDir::new();
    let mut studio = ready_studio(&state.root());
    let mut game = Double::with_pixels(4, 2);
    for id in 1..=CAPTURES_KEPT + 2 {
        let answer = result(&mut studio, &mut game, &format!(r#"{{"id":{id},"op":"capture"}}"#));
        assert_eq!(answer["seq"], Value::from(id));
    }
    let mut kept: Vec<String> = (3..=CAPTURES_KEPT + 2).map(|seq| format!("{seq}.bgra")).collect();
    kept.sort();
    assert_eq!(state.captures(), kept);
}

/// One hostile capture: the state root it runs on, what the game reads back, the request and the refusal.
struct CaptureRow {
    name: &'static str,
    root: fn(&StateDir) -> String,
    pixels: Option<(u32, u32, usize)>,
    line: &'static str,
    code: &'static str,
}

fn capture_rows() -> Vec<CaptureRow> {
    let edge = CAPTURE_MAX_PX + 1;
    let plain = r#"{"id":1,"op":"capture"}"#;
    vec![
        CaptureRow {
            name: "wider than the capture cap",
            root: StateDir::root,
            pixels: Some((edge, 1, edge as usize * 4)),
            line: plain,
            code: VerbRefusal::CAPTURE_TOO_LARGE,
        },
        CaptureRow {
            name: "taller than the capture cap",
            root: StateDir::root,
            pixels: Some((1, edge, edge as usize * 4)),
            line: plain,
            code: VerbRefusal::CAPTURE_TOO_LARGE,
        },
        CaptureRow {
            name: "fewer bytes than declared",
            root: StateDir::root,
            pixels: Some((4, 2, 31)),
            line: plain,
            code: VerbRefusal::CAPTURE_FAILED,
        },
        CaptureRow {
            name: "an empty frame",
            root: StateDir::root,
            pixels: Some((0, 2, 0)),
            line: plain,
            code: VerbRefusal::CAPTURE_FAILED,
        },
        CaptureRow { name: "a failed readback", root: StateDir::root, pixels: None, line: plain, code: VerbRefusal::CAPTURE_FAILED },
        CaptureRow {
            name: "an unknown camera",
            root: StateDir::root,
            pixels: Some((4, 2, 32)),
            line: r#"{"id":1,"op":"capture","arg":{"camera":"sky"}}"#,
            code: VerbRefusal::UNKNOWN_CAMERA,
        },
        CaptureRow { name: "no state folder", root: |_| String::new(), pixels: Some((4, 2, 32)), line: plain, code: VerbRefusal::NO_STATE_DIR },
        CaptureRow {
            name: "a relative state folder",
            root: |_| "state/".to_owned(),
            pixels: Some((4, 2, 32)),
            line: plain,
            code: VerbRefusal::NO_STATE_DIR,
        },
        CaptureRow {
            name: "a climbing state folder",
            root: |state| format!("{}../", state.root()),
            pixels: Some((4, 2, 32)),
            line: plain,
            code: VerbRefusal::NO_STATE_DIR,
        },
    ]
}

#[test]
fn hostile_captures_are_refused_with_typed_codes_and_write_nothing() {
    for row in capture_rows() {
        let state = StateDir::new();
        let mut studio = ready_studio(&(row.root)(&state));
        let mut game = Double { pixels: row.pixels, ..Double::default() };
        assert_eq!(refusal(&mut studio, &mut game, row.line), row.code, "{}", row.name);
        assert!(state.captures().is_empty(), "{}: nothing written", row.name);
        assert!(game.untouched(), "{}", row.name);
        if row.code == VerbRefusal::NO_STATE_DIR {
            assert!(!state.0.join("captures").exists(), "{}: no folder made", row.name);
            continue;
        }
        // The refused capture took no sequence number: the next good one is 1.
        game.pixels = Some((4, 2, 32));
        let good = result(&mut studio, &mut game, r#"{"id":2,"op":"capture"}"#);
        assert_eq!(good["seq"], Value::from(1), "{}", row.name);
    }
}

#[test]
fn a_web_studio_describes_the_capture_without_writing_a_file() {
    let mut studio = Studio::web();
    studio.mark_ready();
    let mut game = Double::with_pixels(4, 2);
    let answer = result(&mut studio, &mut game, r#"{"id":1,"op":"capture"}"#);
    assert_eq!(answer.dump(), br#"{"width":4,"height":2,"camera":"default","drawCalls":2}"#.to_vec());
}

#[test]
fn the_web_call_answers_as_genex_core_dispatcher_call_does() {
    let mut web = Studio::web();
    let mut game = Double::with_pixels(4, 2);
    assert_eq!(
        web.call(&mut game, Op::SEED, &Value::from(9)),
        br#"{"id":null,"ok":false,"op":null,"error":"starting"}"#.to_vec(),
        "before the game began"
    );
    web.mark_ready();
    let mut core = Dispatcher::default();
    for op in Op::SHARED {
        core.on(op, |_| Answer::Result(Value::object()));
    }
    for unknown in ["quit", "surface", ""] {
        assert_eq!(web.call(&mut game, unknown, &Value::Null), core.call(unknown, &Value::Null), "{unknown}");
    }
    let mut arg = Value::object();
    arg.set("seed", Value::from(9));
    assert_eq!(
        web.call(&mut game, Op::SEED, &arg),
        br#"{"id":null,"ok":true,"op":"seed","result":{"seed":9,"paused":true}}"#.to_vec()
    );
    assert_eq!(game.seeds, [9]);
}


#[test]
fn render_settings_is_served_everywhere_and_answers_a_typed_unavailable_until_a_game_serves_it() {
    let mut game = Double::default();
    for mut studio in [ready_studio(""), {
        let mut web = Studio::web();
        web.mark_ready();
        web
    }] {
        assert!(studio.ops().contains(&Op::RENDER_SETTINGS));
        let line = format!(r#"{{"id":5,"op":"{}"}}"#, Op::RENDER_SETTINGS);
        assert_eq!(refusal(&mut studio, &mut game, &line), "unavailable", "never unknown-op");
        let set = format!(r#"{{"id":6,"op":"{}","arg":{{"set":{{"preset":"low"}}}}}}"#, Op::RENDER_SETTINGS);
        assert_eq!(refusal(&mut studio, &mut game, &set), "unavailable");
        let hostile = format!(r#"{{"id":7,"op":"{}","arg":{{"set":{{"preset":"insane"}}}}}}"#, Op::RENDER_SETTINGS);
        assert_eq!(refusal(&mut studio, &mut game, &hostile), "unknown-preset", "the argument is checked first");
        let shapeless = format!(r#"{{"id":8,"op":"{}","arg":{{"set":"low"}}}}"#, Op::RENDER_SETTINGS);
        assert_eq!(refusal(&mut studio, &mut game, &shapeless), "bad-argument");
    }
    assert!(game.untouched());
}

/// Renderer pass 2, P2-0.9 step B (`capture --size`, the 4K/1440p plan): the game draws the capture
/// at the size asked for, the reply carries the size it read back, and the next capture is at the
/// world size again.
#[test]
fn a_capture_at_a_size_asks_the_game_for_it_and_gives_the_world_size_back() {
    let state = StateDir::new();
    let mut studio = ready_studio(&state.root());
    let mut game = Double { sizes_taken: true, ..Double::with_pixels(64, 64) };
    let answer = result(&mut studio, &mut game, r#"{"id":1,"op":"capture","arg":{"size":{"width":2560,"height":1440}}}"#);
    assert_eq!(game.capture_sizes, vec![Some([2560, 1440]), None], "asked, then given back");
    assert_eq!((answer["width"].as_f64(), answer["height"].as_f64()), (64.0, 64.0), "the size read back, not the size asked");
    assert_eq!(game.renders, 1);
    let named = result(&mut studio, &mut game, r#"{"id":2,"op":"capture","arg":{"camera":"top","size":null}}"#);
    assert_eq!(named["camera"].as_str(), "top");
    assert_eq!(game.capture_sizes[2..], [None, None], "a null size is the world size");
}

/// Renderer pass 2 A.9 (`capture`'s `lens`): a capture asks the game for the look's depth of field
/// and motion blur, and the next capture asks for neither again.
#[test]
fn a_capture_asking_for_the_lens_hands_it_to_the_game_and_takes_it_back() {
    let state = StateDir::new();
    let mut studio = ready_studio(&state.root());
    let mut game = Double { lenses_taken: true, ..Double::with_pixels(4, 2) };
    result(&mut studio, &mut game, r#"{"id":1,"op":"capture","arg":{"lens":{"depthOfField":true,"motionBlur":false}}}"#);
    let asked = CaptureLens { depth_of_field: true, motion_blur: false };
    assert_eq!(game.capture_lenses, vec![asked, CaptureLens::default()], "asked, then given back");
    result(&mut studio, &mut game, r#"{"id":2,"op":"capture","arg":{"lens":{"motionBlur":true}}}"#);
    assert_eq!(game.capture_lenses[2], CaptureLens { depth_of_field: false, motion_blur: true }, "a missing switch is off");
    result(&mut studio, &mut game, r#"{"id":3,"op":"capture","arg":{"lens":null}}"#);
    assert_eq!(game.capture_lenses[4], CaptureLens::default(), "a null lens asks for neither");
    assert_eq!(game.renders, 3);
}

/// A `lens` outside its shape, or one a game without render settings is asked for, is refused
/// `bad-argument`: nothing is drawn or written and no sequence number is taken.
#[test]
fn hostile_capture_lenses_are_refused_and_draw_nothing() {
    let rows = [
        ("a string", r#""dof""#, true),
        ("a boolean", r#"true"#, true),
        ("an array", r#"["depthOfField"]"#, true),
        ("a switch as a string", r#"{"depthOfField":"true"}"#, true),
        ("a switch as a number", r#"{"motionBlur":1}"#, true),
        ("a game without render settings", r#"{"depthOfField":true}"#, false),
    ];
    for (name, lens, taken) in rows {
        let state = StateDir::new();
        let mut studio = ready_studio(&state.root());
        let mut game = Double { lenses_taken: taken, ..Double::with_pixels(4, 2) };
        let line = format!(r#"{{"id":1,"op":"capture","arg":{{"lens":{lens}}}}}"#);
        assert_eq!(refusal(&mut studio, &mut game, &line), VerbRefusal::BAD_ARGUMENT, "{name}");
        assert_eq!(game.renders, 0, "{name}: nothing drawn");
        assert!(state.captures().is_empty(), "{name}: nothing written");
        let good = result(&mut studio, &mut game, r#"{"id":2,"op":"capture"}"#);
        assert_eq!(good["seq"], Value::from(1), "{name}: the refusal took no sequence number");
    }
}

/// A `size` outside its shape, or one a game that draws its world size only is asked for, is
/// refused `bad-argument`: nothing is drawn or written and no sequence number is taken.
#[test]
fn hostile_capture_sizes_are_refused_and_draw_nothing() {
    let rows = [
        ("a string", r#"{"width":"2560","height":1440}"#, true),
        ("a fraction", r#"{"width":2560.5,"height":1440}"#, true),
        ("under the smallest target", r#"{"width":63,"height":1440}"#, true),
        // WP-9 flipped 4097 -> 8193: a native capture side reaches 8192.
        ("over the capture cap", r#"{"width":8193,"height":1440}"#, true),
        ("negative", r#"{"width":-2560,"height":1440}"#, true),
        ("a missing side", r#"{"width":2560}"#, true),
        ("an array", r#"[2560,1440]"#, true),
        ("a WxH string", r#""2560x1440""#, true),
        ("infinite", r#"{"width":1e999,"height":1440}"#, true),
        ("a world-size-only game", r#"{"width":2560,"height":1440}"#, false),
    ];
    for (name, size, taken) in rows {
        let state = StateDir::new();
        let mut studio = ready_studio(&state.root());
        let mut game = Double { sizes_taken: taken, ..Double::with_pixels(4, 2) };
        let line = format!(r#"{{"id":1,"op":"capture","arg":{{"size":{size}}}}}"#);
        assert_eq!(refusal(&mut studio, &mut game, &line), VerbRefusal::BAD_ARGUMENT, "{name}");
        assert_eq!(game.renders, 0, "{name}: nothing drawn");
        assert!(state.captures().is_empty(), "{name}: nothing written");
        let good = result(&mut studio, &mut game, r#"{"id":2,"op":"capture"}"#);
        assert_eq!(good["seq"], Value::from(1), "{name}: the refusal took no sequence number");
    }
}
