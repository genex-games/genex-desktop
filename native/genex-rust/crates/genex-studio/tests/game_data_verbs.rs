//! The dev-only `saves` and `uiSettings` verbs (G6 UIS-16): the studio checks each argument as the
//! host does (`shared/game-saves.ts`: `checkSavesArg`, `checkUiSettingsArg`) and hands the game a
//! typed request; anything out of shape refuses `bad-argument` and the game is never asked; a game
//! that serves neither answers `unavailable`; the web flavour, which an export serves too, answers
//! `unknown-op`.

use genex_core::json::{self, Value};
use genex_core::session::StepResult;
use genex_studio::verbs::{SAVES_ENVELOPE_MAX_BYTES, SavesRequest, UiMember, UiSettingsChange};
use genex_studio::{CaptureFault, Injection, Op, Pixels, Studio, StudioGame, VerbRefusal};

/// A game that records what the studio handed it.
#[derive(Default)]
struct Double {
    serves: bool,
    busy: bool,
    saves: Vec<SavesRequest>,
    ui: Vec<UiSettingsChange>,
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
    fn busy(&self) -> bool {
        self.busy
    }
    fn saves(&mut self, request: &SavesRequest) -> Result<Value, &'static str> {
        if !self.serves {
            return Err(VerbRefusal::UNAVAILABLE);
        }
        self.saves.push(request.clone());
        Ok(Value::object())
    }
    fn ui_settings(&mut self, change: &UiSettingsChange) -> Result<Value, &'static str> {
        if !self.serves {
            return Err(VerbRefusal::UNAVAILABLE);
        }
        self.ui.push(change.clone());
        Ok(Value::object())
    }
}

fn native() -> Studio {
    let mut studio = Studio::native("");
    studio.mark_ready();
    studio
}

fn reply(studio: &mut Studio, game: &mut Double, op: &str, arg: &str) -> Value {
    let line = format!(r#"{{"id":1,"op":"{op}","arg":{arg}}}"#);
    json::parse(&studio.handle(game, line.as_bytes())).expect("a reply is JSON")
}

fn error(studio: &mut Studio, game: &mut Double, op: &str, arg: &str) -> String {
    let reply = reply(studio, game, op, arg);
    assert_eq!(reply["ok"], Value::Bool(false), "{op} {arg}: {}", String::from_utf8_lossy(&reply.dump()));
    reply["error"].as_str().to_owned()
}

#[test]
fn hostile_saves_arguments_refuse_bad_argument_and_never_reach_the_game() {
    // New behaviour (UIS-16): no `saves` verb existed (unknown-op).
    let long_slot = "a".repeat(33);
    let long_label = "é".repeat(65);
    let huge = format!(r#"{{"op":"write","slot":"big","envelope":{{"blob":"{}"}}}}"#, "x".repeat(SAVES_ENVELOPE_MAX_BYTES));
    let hostile: Vec<String> = vec![
        "null".into(),
        "[]".into(),
        "{}".into(),
        r#"{"op":"format"}"#.into(),
        r#"{"op":3}"#.into(),
        r#"{"op":"read"}"#.into(),
        r#"{"op":"read","slot":"../escape"}"#.into(),
        r#"{"op":"load","slot":"Upper"}"#.into(),
        r#"{"op":"load","slot":"-dash"}"#.into(),
        r#"{"op":"delete","slot":""}"#.into(),
        r#"{"op":"delete","slot":7}"#.into(),
        format!(r#"{{"op":"load","slot":"{long_slot}"}}"#),
        format!(r#"{{"op":"save","slot":"a","label":"{long_label}"}}"#),
        r#"{"op":"save","slot":"a","label":5}"#.into(),
        r#"{"op":"write","slot":"a"}"#.into(),
        r#"{"op":"write","slot":"a","envelope":[1]}"#.into(),
        r#"{"op":"write","slot":"a/b","envelope":{}}"#.into(),
        huge,
    ];
    let mut studio = native();
    let mut game = Double { serves: true, ..Double::default() };
    for arg in &hostile {
        assert_eq!(error(&mut studio, &mut game, Op::SAVES, arg), VerbRefusal::BAD_ARGUMENT, "{}", &arg[..arg.len().min(80)]);
    }
    assert!(game.saves.is_empty(), "the game was never asked: {:?}", game.saves);
}

#[test]
fn checked_saves_arguments_reach_the_game_typed() {
    let mut studio = native();
    let mut game = Double { serves: true, ..Double::default() };
    for arg in [
        r#"{"op":"list","slot":"ignored"}"#,
        r#"{"op":"read","slot":"slot-1"}"#,
        r#"{"op":"save","slot":"a"}"#,
        r#"{"op":"save","slot":"a","label":"Before the boss"}"#,
        r#"{"op":"load","slot":"autosave-0"}"#,
        r#"{"op":"delete","slot":"a"}"#,
        r#"{"op":"write","slot":"seeded","envelope":{"genex":"save","format":1}}"#,
    ] {
        assert_eq!(reply(&mut studio, &mut game, Op::SAVES, arg)["ok"], Value::Bool(true), "{arg}");
    }
    let expected = vec![
        SavesRequest::List,
        SavesRequest::Read("slot-1".into()),
        SavesRequest::Save("a".into(), String::new()),
        SavesRequest::Save("a".into(), "Before the boss".into()),
        SavesRequest::Load("autosave-0".into()),
        SavesRequest::Delete("a".into()),
        SavesRequest::Write("seeded".into(), br#"{"genex":"save","format":1}"#.to_vec()),
    ];
    assert_eq!(game.saves, expected);
    game.busy = true;
    assert_eq!(error(&mut studio, &mut game, Op::SAVES, r#"{"op":"list"}"#), VerbRefusal::BUSY);
}

#[test]
fn hostile_ui_settings_refuse_bad_argument_and_nulls_give_the_game_its_own_back() {
    // New behaviour (UIS-16).
    let mut studio = native();
    let mut game = Double { serves: true, ..Double::default() };
    let long_tag = format!("en-{}", "a".repeat(33));
    let hostile: Vec<String> = vec![
        "[]".into(),
        r#""fr""#.into(),
        r#"{"scale":0.49}"#.into(),
        r#"{"scale":3.01}"#.into(),
        r#"{"scale":"2"}"#.into(),
        r#"{"textSize":0}"#.into(),
        r#"{"safeArea":[0,0,0]}"#.into(),
        r#"{"safeArea":[0,0,0,-1]}"#.into(),
        r#"{"safeArea":[0,0,0,4097]}"#.into(),
        r#"{"safeArea":{"left":0}}"#.into(),
        r#"{"locale":"x"}"#.into(),
        r#"{"locale":"en US"}"#.into(),
        r#"{"locale":"en--us"}"#.into(),
        r#"{"locale":7}"#.into(),
        format!(r#"{{"locale":"{long_tag}"}}"#),
    ];
    for arg in &hostile {
        assert_eq!(error(&mut studio, &mut game, Op::UI_SETTINGS, arg), VerbRefusal::BAD_ARGUMENT, "{arg}");
    }
    assert!(game.ui.is_empty(), "{:?}", game.ui);
    for arg in ["null", "{}", r#"{"locale":"xx-pseudo","scale":1.5}"#, r#"{"locale":null,"safeArea":[0,20,0,34],"textSize":2}"#] {
        assert_eq!(reply(&mut studio, &mut game, Op::UI_SETTINGS, arg)["ok"], Value::Bool(true), "{arg}");
    }
    let set = UiSettingsChange { locale: UiMember::Set("xx-pseudo".into()), scale: UiMember::Set(1.5), ..UiSettingsChange::default() };
    let reset = UiSettingsChange {
        locale: UiMember::Reset,
        safe_area: UiMember::Set([0.0, 20.0, 0.0, 34.0]),
        text_size: UiMember::Set(2.0),
        ..UiSettingsChange::default()
    };
    assert_eq!(game.ui, vec![UiSettingsChange::default(), UiSettingsChange::default(), set, reset]);
}

#[test]
fn a_game_without_them_answers_unavailable_and_the_web_answers_unknown_op() {
    let mut studio = native();
    let mut game = Double::default();
    assert_eq!(error(&mut studio, &mut game, Op::SAVES, r#"{"op":"list"}"#), VerbRefusal::UNAVAILABLE);
    assert_eq!(error(&mut studio, &mut game, Op::UI_SETTINGS, "{}"), VerbRefusal::UNAVAILABLE);
    let mut web = Studio::web();
    web.mark_ready();
    for op in Op::GAME_DATA {
        let reply = reply(&mut web, &mut game, op, "{}");
        assert_eq!(reply["error"].as_str(), "unknown-op", "{op}");
        assert!(!reply["available"].items().iter().any(|listed| listed.as_str() == op), "the web never lists {op}");
    }
}
