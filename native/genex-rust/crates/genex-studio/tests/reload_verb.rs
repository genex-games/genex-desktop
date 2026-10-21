//! The dev-only `reloadAssets` verb (game systems C-18): the studio checks the argument (at most
//! [`RELOAD_FILES_MAX`] files, each a path and a 16-hex-digit FNV-1a 64), refuses every path
//! outside the asset-path rule `unsafe-path` itself, so the game never reads one, and hands the
//! rest to the game ([`StudioGame::reload_assets`]), which answers what it swapped, what it
//! refused and how many reloads are still pending. A game that does not serve it answers
//! `unavailable`; the web flavour, which an export serves too, answers `unknown-op`.

use genex_core::json::{self, Value};
use genex_core::session::StepResult;
use genex_studio::verbs::{RELOAD_FILES_MAX, ReloadFile, ReloadOutcome, ReloadRefusal, parse_reload};
use genex_studio::wire::{self, Receipt};
use genex_studio::{CaptureFault, Injection, Op, Pixels, Studio, StudioGame, VerbRefusal};

/// A digest the doubles never read: any 16 lowercase hex digits.
const DIGEST: &str = "00000000000000aa";

/// A game that records the files the studio handed it and answers each as `answer` says.
#[derive(Default)]
struct Double {
    handed: Vec<Vec<ReloadFile>>,
    /// Paths answered `missing` (no such file), and the pending count it answers.
    missing: Vec<&'static str>,
    pending: u32,
    busy: bool,
}

impl StudioGame for Double {
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
    fn reload_assets(&mut self, files: &[ReloadFile]) -> Result<ReloadOutcome, &'static str> {
        self.handed.push(files.to_vec());
        let mut outcome = ReloadOutcome { pending: self.pending, ..ReloadOutcome::default() };
        for file in files {
            if self.missing.contains(&file.path.as_str()) {
                outcome.refused.push((file.path.clone(), ReloadRefusal::Missing));
            } else {
                outcome.reloaded.push(file.path.clone());
            }
        }
        Ok(outcome)
    }
}

fn native() -> Studio {
    let mut studio = Studio::native("");
    studio.mark_ready();
    studio
}

fn reply<G: StudioGame>(studio: &mut Studio, game: &mut G, arg: &str) -> Value {
    let line = format!(r#"{{"id":1,"op":"reloadAssets","arg":{arg}}}"#);
    json::parse(&studio.handle(game, line.as_bytes())).expect("a reply is JSON")
}

fn refusal<G: StudioGame>(studio: &mut Studio, game: &mut G, arg: &str) -> String {
    let reply = reply(studio, game, arg);
    assert_eq!(reply["ok"], Value::Bool(false), "{arg}: {}", String::from_utf8_lossy(&reply.dump()));
    reply["error"].as_str().to_owned()
}

fn files(paths: &[&str]) -> String {
    let entries: Vec<String> = paths.iter().map(|path| format!(r#"{{"path":{},"digest":"{DIGEST}"}}"#, Value::from(*path).dump_string())).collect();
    format!(r#"{{"files":[{}]}}"#, entries.join(","))
}

trait DumpString {
    fn dump_string(&self) -> String;
}

impl DumpString for Value {
    fn dump_string(&self) -> String {
        String::from_utf8(self.dump()).expect("utf-8")
    }
}

#[test]
fn reloaded_and_refused_files_are_answered_with_the_pending_count() {
    let mut studio = native();
    let mut game = Double { missing: vec!["textures/gone.png"], pending: 0, ..Double::default() };
    let reply = reply(&mut studio, &mut game, &files(&["textures/bark.png", "textures/gone.png"]));
    assert_eq!(reply["ok"], Value::Bool(true), "{}", reply.dump_string());
    let result = &reply["result"];
    let reloaded: Vec<&str> = result["reloaded"].items().iter().map(Value::as_str).collect();
    assert_eq!(reloaded, ["textures/bark.png"]);
    let refused: Vec<(&str, &str)> = result["refused"].items().iter().map(|r| (r["path"].as_str(), r["code"].as_str())).collect();
    assert_eq!(refused, [("textures/gone.png", "missing")]);
    assert_eq!(result["pending"].as_f64(), 0.0);
    assert_eq!(game.handed.len(), 1);
    assert_eq!(game.handed[0][0], ReloadFile { path: "textures/bark.png".to_owned(), digest: 0xaa });
}

#[test]
fn a_hostile_path_is_refused_unsafe_path_by_the_studio_and_never_reaches_the_game() {
    let hostile = ["/etc/passwd", "../secrets.png", "textures/../../x.png", "", "textures\\bark.png", "C:/x.png", "a//b.png", "./x.png"];
    let mut studio = native();
    let mut game = Double::default();
    let reply = reply(&mut studio, &mut game, &files(&hostile));
    assert_eq!(reply["ok"], Value::Bool(true), "{}", reply.dump_string());
    let refused: Vec<(&str, &str)> = reply["result"]["refused"].items().iter().map(|r| (r["path"].as_str(), r["code"].as_str())).collect();
    let expected: Vec<(&str, &str)> = hostile.iter().map(|path| (*path, "unsafe-path")).collect();
    assert_eq!(refused, expected);
    assert!(reply["result"]["reloaded"].items().is_empty());
    assert!(game.handed.iter().all(Vec::is_empty), "no unsafe path was handed to the game: {:?}", game.handed);
}

#[test]
fn an_argument_outside_its_shape_answers_bad_argument_and_never_reaches_the_game() {
    let too_many = files(&vec!["textures/a.png"; RELOAD_FILES_MAX + 1]);
    let hostile = [
        "null".to_owned(),
        "7".to_owned(),
        "{}".to_owned(),
        r#"{"files":{}}"#.to_owned(),
        r#"{"files":["textures/a.png"]}"#.to_owned(),
        r#"{"files":[{"path":"textures/a.png"}]}"#.to_owned(),
        r#"{"files":[{"digest":"00000000000000aa"}]}"#.to_owned(),
        r#"{"files":[{"path":7,"digest":"00000000000000aa"}]}"#.to_owned(),
        r#"{"files":[{"path":"textures/a.png","digest":"AA"}]}"#.to_owned(),
        r#"{"files":[{"path":"textures/a.png","digest":"00000000000000AA"}]}"#.to_owned(),
        r#"{"files":[{"path":"textures/a.png","digest":"00000000000000a"}]}"#.to_owned(),
        r#"{"files":[{"path":"textures/a.png","digest":"000000000000000g0"}]}"#.to_owned(),
        too_many,
    ];
    let mut studio = native();
    let mut game = Double::default();
    for arg in &hostile {
        assert_eq!(refusal(&mut studio, &mut game, arg), VerbRefusal::BAD_ARGUMENT, "{arg}");
    }
    assert!(game.handed.is_empty(), "no refused request reached the game");
    // At the cap exactly, the request is taken.
    let at_cap = files(&vec!["textures/a.png"; RELOAD_FILES_MAX]);
    assert_eq!(reply(&mut studio, &mut game, &at_cap)["ok"], Value::Bool(true));
    assert_eq!(RELOAD_FILES_MAX, 256, "NATIVE_RELOAD_FILES_MAX");
}

#[test]
fn a_game_inside_a_tick_answers_busy() {
    let mut studio = native();
    let mut game = Double { busy: true, ..Double::default() };
    assert_eq!(refusal(&mut studio, &mut game, &files(&["textures/a.png"])), VerbRefusal::BUSY);
    assert!(game.handed.is_empty());
}

#[test]
fn the_web_flavour_which_an_export_serves_answers_unknown_op_and_never_lists_it() {
    let mut web = Studio::web();
    web.mark_ready();
    let mut game = Double::default();
    let reply = reply(&mut web, &mut game, &files(&["textures/a.png"]));
    assert_eq!(reply["error"].as_str(), "unknown-op");
    assert!(!reply["available"].items().iter().any(|op| op.as_str() == Op::RELOAD_ASSETS));
    assert!(game.handed.is_empty());
}

#[test]
fn the_parse_keeps_the_request_order_and_the_refusal_spellings_are_the_host_s() {
    let arg = json::parse(br#"{"files":[{"path":"b.png","digest":"0123456789abcdef"},{"path":"a.png","digest":"ffffffffffffffff"}]}"#).expect("json");
    let parsed = parse_reload(&arg).expect("well formed");
    assert_eq!(parsed, [ReloadFile { path: "b.png".to_owned(), digest: 0x0123_4567_89ab_cdef }, ReloadFile { path: "a.png".to_owned(), digest: u64::MAX }]);
    let spelled: Vec<&str> = ReloadRefusal::ALL.iter().map(|code| code.wire()).collect();
    assert_eq!(spelled, ["unsafe-path", "digest-mismatch", "missing"], "native-contract.ts ReloadRefusal");
}

#[test]
fn the_receipt_advertises_reload_assets_only_when_the_game_serves_it() {
    let mut receipt = Receipt::new(wire::Backend::Metal, "Apple M4 Max", Vec::new());
    assert!(receipt.to_value().get("reloadAssetsApi").is_none(), "an older build's receipt has no member");
    receipt.reload_assets_api = Some(wire::RELOAD_ASSETS_API_VERSION);
    let value = receipt.to_value();
    assert_eq!(value["reloadAssetsApi"].as_f64(), 1.0);
    assert_eq!(Receipt::from_value(&value).expect("parses").reload_assets_api, Some(1));
}

#[test]
fn the_verb_s_names_caps_and_answer_shape_are_the_wire_fixture_s() {
    let fixture = json::parse(include_bytes!("../../../../../tests/fixtures/native-wire-v2.json")).expect("the fixture is JSON");
    let block = &fixture["reloadAssets"];
    assert_eq!(block["op"].as_str(), Op::RELOAD_ASSETS);
    assert_eq!(block["filesMax"].as_f64(), RELOAD_FILES_MAX as f64);
    let spelled: Vec<&str> = ReloadRefusal::ALL.iter().map(|code| code.wire()).collect();
    let fixture_codes: Vec<&str> = block["refusals"].items().iter().map(Value::as_str).collect();
    assert_eq!(spelled, fixture_codes);
    assert_eq!(block["apiVersion"].as_f64(), f64::from(wire::RELOAD_ASSETS_API_VERSION));
    let mut receipt = Receipt::new(wire::Backend::Metal, "Apple M4 Max", Vec::new());
    receipt.reload_assets_api = Some(wire::RELOAD_ASSETS_API_VERSION);
    assert!(receipt.to_value().get(block["receiptKey"].as_str()).is_some());
    let mut studio = native();
    let mut game = Double::default();
    let reply = reply(&mut studio, &mut game, &files(&["textures/bark.png", "../bark.png"]));
    assert_eq!(reply["result"], block["answer"], "{}", reply.dump_string());
}
