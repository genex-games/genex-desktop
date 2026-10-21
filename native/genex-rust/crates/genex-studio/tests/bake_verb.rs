//! The dev-only `bakeAssets` verb (game systems NAV-14): the studio checks the argument (`{kind,
//! name}`, kind `nav` or `impostor`, a name of lowercase letters, digits, `-` and `_`, at most 64,
//! never a dot), hands the game a typed request ([`StudioGame::bake_assets`]) and writes the bytes
//! it answers into the run's `state/bakes/<kind>/<name>` (through a staging file and a rename),
//! answering `{kind, name, bytes, digest}`. A game that serves no bakes answers `unavailable`, a
//! name it does not have `unknown-bake`; the web flavour, which an export serves too, answers
//! `unknown-op`. Every refused request leaves the state folder untouched.
//!
//! New behaviour (section 0 of the game systems plan).

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

use genex_core::digest::{fnv1a64, hex64};
use genex_core::json::{self, Value};
use genex_core::session::StepResult;
use genex_studio::verbs::{BAKE_NAME_MAX, BakeRequest, parse_bake};
use genex_studio::wire::{self, BakeKind, Receipt};
use genex_studio::{CaptureFault, Injection, Op, Pixels, Studio, StudioGame, VerbRefusal};

/// A game with one nav bake, `main`, whose output is `BYTES`.
#[derive(Default)]
struct Baker {
    asked: Vec<BakeRequest>,
    busy: bool,
}

const BYTES: &[u8] = b"GNAV-test-bytes";

impl StudioGame for Baker {
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
    fn busy(&self) -> bool {
        self.busy
    }
    fn bake_assets(&mut self, request: &BakeRequest) -> Result<Vec<u8>, &'static str> {
        self.asked.push(request.clone());
        match (request.kind, request.name.as_str()) {
            (BakeKind::Nav, "main") => Ok(BYTES.to_vec()),
            (BakeKind::Nav, _) => Err(VerbRefusal::UNKNOWN_BAKE),
            (BakeKind::Impostor, _) => Err(VerbRefusal::UNAVAILABLE),
        }
    }
}

/// A game that serves no bakes (the trait's default).
#[derive(Default)]
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

/// A fresh, empty state folder, as the host makes `state/`.
struct StateDir(PathBuf);

impl StateDir {
    fn new() -> StateDir {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("genex-studio-bake-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("state folder");
        StateDir(dir.canonicalize().expect("canonical state folder"))
    }

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

fn native(root: &str) -> Studio {
    let mut studio = Studio::native(root);
    studio.mark_ready();
    studio
}

fn reply<G: StudioGame>(studio: &mut Studio, game: &mut G, arg: &str) -> Value {
    let line = format!(r#"{{"id":1,"op":"bakeAssets","arg":{arg}}}"#);
    json::parse(&studio.handle(game, line.as_bytes())).expect("a reply is JSON")
}

fn refusal<G: StudioGame>(studio: &mut Studio, game: &mut G, arg: &str) -> String {
    let reply = reply(studio, game, arg);
    assert_eq!(reply["ok"], Value::Bool(false), "{arg}: {}", String::from_utf8_lossy(&reply.dump()));
    reply["error"].as_str().to_owned()
}

#[test]
fn a_registered_bake_is_written_into_state_bakes_and_answered_with_its_size_and_digest() {
    let state = StateDir::new();
    let mut studio = native(&state.root());
    let mut game = Baker::default();
    let reply = reply(&mut studio, &mut game, r#"{"kind":"nav","name":"main"}"#);
    assert_eq!(reply["ok"], Value::Bool(true), "{}", String::from_utf8_lossy(&reply.dump()));
    let result = &reply["result"];
    assert_eq!(result["kind"].as_str(), "nav");
    assert_eq!(result["name"].as_str(), "main");
    assert_eq!(result["bytes"].as_f64(), BYTES.len() as f64);
    assert_eq!(result["digest"].as_str(), hex64(fnv1a64(BYTES)));
    assert_eq!(fs::read(state.0.join("bakes/nav/main")).expect("the bake file"), BYTES);
    assert_eq!(state.entries(), ["bakes", "bakes/nav", "bakes/nav/main"], "no staging file is left");
    assert_eq!(game.asked, [BakeRequest { kind: BakeKind::Nav, name: "main".to_owned() }]);
    // A second bake of the same name replaces the file.
    let again = self::reply(&mut studio, &mut game, r#"{"kind":"nav","name":"main"}"#);
    assert_eq!(again["result"]["digest"], result["digest"]);
    assert_eq!(state.entries(), ["bakes", "bakes/nav", "bakes/nav/main"]);
}

#[test]
fn an_unknown_name_refuses_and_writes_nothing() {
    let state = StateDir::new();
    let mut studio = native(&state.root());
    let mut game = Baker::default();
    assert_eq!(refusal(&mut studio, &mut game, r#"{"kind":"nav","name":"cellar"}"#), VerbRefusal::UNKNOWN_BAKE);
    assert_eq!(refusal(&mut studio, &mut game, r#"{"kind":"impostor","name":"main"}"#), VerbRefusal::UNAVAILABLE);
    assert!(state.entries().is_empty(), "{:?}", state.entries());
}

#[test]
fn a_hostile_argument_answers_bad_argument_never_reaches_the_game_and_writes_nothing() {
    let long = "a".repeat(BAKE_NAME_MAX + 1);
    let hostile = [
        "null".to_owned(),
        "{}".to_owned(),
        r#"{"kind":"nav"}"#.to_owned(),
        r#"{"name":"main"}"#.to_owned(),
        r#"{"kind":"mesh","name":"main"}"#.to_owned(),
        r#"{"kind":"NAV","name":"main"}"#.to_owned(),
        r#"{"kind":"nav","name":7}"#.to_owned(),
        r#"{"kind":"nav","name":""}"#.to_owned(),
        r#"{"kind":"nav","name":".."}"#.to_owned(),
        r#"{"kind":"nav","name":"../main"}"#.to_owned(),
        r#"{"kind":"nav","name":"/etc/passwd"}"#.to_owned(),
        r#"{"kind":"nav","name":"a/b"}"#.to_owned(),
        r#"{"kind":"nav","name":"a\\b"}"#.to_owned(),
        r#"{"kind":"nav","name":"main.navmesh"}"#.to_owned(),
        r#"{"kind":"nav","name":"Main"}"#.to_owned(),
        r#"{"kind":"nav","name":"-main"}"#.to_owned(),
        r#"{"kind":"nav","name":"ma\u0000in"}"#.to_owned(),
        format!(r#"{{"kind":"nav","name":"{long}"}}"#),
    ];
    let state = StateDir::new();
    let mut studio = native(&state.root());
    let mut game = Baker::default();
    for arg in &hostile {
        assert_eq!(refusal(&mut studio, &mut game, arg), VerbRefusal::BAD_ARGUMENT, "{arg}");
    }
    assert!(game.asked.is_empty(), "no refused request reached the game");
    assert!(state.entries().is_empty());
    let at_cap = "a".repeat(BAKE_NAME_MAX);
    assert!(parse_bake(&json::parse(format!(r#"{{"kind":"nav","name":"{at_cap}"}}"#).as_bytes()).expect("json")).is_ok());
}

#[test]
fn a_game_inside_a_tick_answers_busy_and_one_without_bakes_unavailable() {
    let state = StateDir::new();
    let mut studio = native(&state.root());
    let mut game = Baker { busy: true, ..Baker::default() };
    assert_eq!(refusal(&mut studio, &mut game, r#"{"kind":"nav","name":"main"}"#), VerbRefusal::BUSY);
    assert!(game.asked.is_empty());
    assert_eq!(refusal(&mut studio, &mut Plain, r#"{"kind":"nav","name":"main"}"#), VerbRefusal::UNAVAILABLE);
    assert!(state.entries().is_empty());
}

#[test]
fn a_run_without_a_state_folder_answers_no_state_dir() {
    let mut studio = native("");
    let mut game = Baker::default();
    assert_eq!(refusal(&mut studio, &mut game, r#"{"kind":"nav","name":"main"}"#), VerbRefusal::NO_STATE_DIR);
}

#[test]
fn the_web_flavour_which_an_export_serves_answers_unknown_op_and_never_lists_it() {
    let mut web = Studio::web();
    web.mark_ready();
    let mut game = Baker::default();
    let reply = reply(&mut web, &mut game, r#"{"kind":"nav","name":"main"}"#);
    assert_eq!(reply["error"].as_str(), "unknown-op");
    assert!(!reply["available"].items().iter().any(|op| op.as_str() == Op::BAKE_ASSETS));
    assert!(game.asked.is_empty());
}

#[test]
fn the_receipt_advertises_the_bakes_a_game_registered() {
    let mut receipt = Receipt::new(wire::Backend::Metal, "Apple M4 Max", Vec::new());
    assert!(receipt.to_value().get("bakes").is_none(), "a game without bakes advertises none");
    receipt.bakes = vec![(BakeKind::Nav, "main".to_owned()), (BakeKind::Nav, "cellar".to_owned())];
    let bakes = &receipt.to_value()["bakes"];
    let listed: Vec<(&str, &str)> = bakes.items().iter().map(|bake| (bake["kind"].as_str(), bake["name"].as_str())).collect();
    assert_eq!(listed, [("nav", "main"), ("nav", "cellar")]);
    let spelled: Vec<&str> = BakeKind::ALL.iter().map(|kind| kind.wire()).collect();
    assert_eq!(spelled, ["nav", "impostor"], "native-contract.ts BakeKind");
}
