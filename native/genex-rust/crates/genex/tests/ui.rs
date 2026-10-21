//! Gameplay UI wiring in the facade (G6 UIS-10): `game.ui`, `tr`, the default navigation source
//! and its seam, pad gating while a menu holds focus, `state().hud.widgets` / `hud.focus`,
//! `state().volatile.ui`, the person layer a Genex run ignores, and the Studio session layer.
//!
//! The Metal row (`--ignored metal`) captures the pause menu after a pad-only script and checks
//! the focus ring is on `settings`; with `GENEX_UI_EVIDENCE_DIR` set to an absolute folder it
//! writes the capture there as raw BGRA (`ui-pause-focus-<w>x<h>.bgra`).

use genex::prelude::*;
use genex::ui::{Menu, NavButton, NavButtons, UiSession, UiSessionCode, tr};
use genex::{FIXED_STEP_MS, InstallErrorCode, Runtime};

/// Standard-mapping pad buttons the script presses.
const PAD_A: usize = 0;
const PAD_Y: usize = 3;
const PAD_START: usize = 9;
const PAD_UP: usize = 12;
const PAD_DOWN: usize = 13;
const PAD_BUTTONS: usize = 17;
const WORLD: [u32; 2] = [480, 270];
const EN: &[u8] = b"greet = Hello\nresume = Resume\nsettings = Settings\nquit = Quit\n";
const FR: &[u8] = b"greet = Bonjour\nresume = Reprendre\nsettings = Options\nquit = Quitter\n";
const ASSETS: genex::AssetTable = &[("lang/en.ftl", EN), ("lang/fr.ftl", FR)];
const EVIDENCE_ENV: &str = "GENEX_UI_EVIDENCE_DIR";
const REQUIRE_METAL_ENV: &str = "GENEX_REQUIRE_METAL";

#[derive(Default)]
struct World {
    paused: bool,
    picked: Vec<String>,
    /// Ticks on which an update hook read d-pad up held, and whether the menu was open then.
    up_reads: Vec<(u64, bool)>,
    ticks: u64,
}

/// A game whose Start opens a pause menu (resume / settings / quit, text from `tr`).
fn pause_game() -> Game<World> {
    let mut game = Game::new(World::default()).world_size(WORLD[0], WORLD[1]).background(Color::rgb(20, 24, 32));
    game.ui(UiConfig::new().locales(&["en", "fr"]));
    game.camera(|_| Camera::look_at(vec3(0.0, 2.0, 6.0), Vec3::ZERO));
    game.on_update(|sim, ctx| {
        sim.world.ticks += 1;
        if ctx.pads.down(0, PAD_UP) {
            sim.world.up_reads.push((ctx.tick, sim.world.paused));
        }
        if ctx.pads.pressed(0, PAD_START) {
            sim.world.paused = !sim.world.paused;
        }
    });
    game.on_ui(|sim, ui, _| {
        ui.label(tr("greet"));
        if !sim.world.paused {
            return;
        }
        let (resume, settings, quit) = (tr("resume"), tr("settings"), tr("quit"));
        let menu = Menu::new("pause").item("resume", &resume).item("settings", &settings).item("quit", &quit).back("resume");
        if let Some(picked) = menu.show(ui) {
            sim.world.picked.push(picked.to_owned());
        }
    });
    game
}

fn runtime(game: Game<World>) -> Runtime<World> {
    Runtime::with_assets(game, Box::new(ASSETS)).expect("installs")
}

/// One injected standard pad at index 0 with `button` at `value` (the `input` verb's JSON).
fn pad(button: usize, value: f32) -> Input {
    let mut buttons = vec!["0".to_owned(); PAD_BUTTONS];
    buttons[button] = value.to_string();
    let text = format!(r#"{{"pads":[{{"index":0,"buttons":[{}]}}]}}"#, buttons.join(","));
    let arg = genex_core::json::parse(text.as_bytes()).expect("JSON");
    Input::from_injection(genex_core::input::parse_injection(&arg))
}

/// Press `button` for one tick and release it for one.
fn tap(rt: &mut Runtime<World>, button: usize) {
    rt.inject(pad(button, 1.0));
    rt.step(FIXED_STEP_MS);
    rt.inject(pad(button, 0.0));
    rt.step(FIXED_STEP_MS);
}

/// The pad-only script: Start opens the menu, d-pad down walks from `resume` to `settings`.
fn walk_to_settings(rt: &mut Runtime<World>) {
    rt.step(FIXED_STEP_MS * 2.0);
    tap(rt, PAD_START);
    rt.step(FIXED_STEP_MS * 2.0);
    assert_eq!(rt.state()["hud"]["focus"], json!("pause.resume"), "the menu focuses its first item on opening");
    tap(rt, PAD_DOWN);
}

fn hud_items(rt: &Runtime<World>) -> Vec<String> {
    rt.state()["hud"]["items"].as_array().expect("items").iter().map(|item| item.as_str().expect("a name").to_owned()).collect()
}

#[test]
fn a_pad_only_script_opens_the_pause_menu_and_walks_to_settings_by_key() {
    let mut rt = runtime(pause_game());
    walk_to_settings(&mut rt);
    let state = rt.state();
    assert_eq!(state["hud"]["focus"], json!("pause.settings"));
    let keys: Vec<&str> = state["hud"]["widgets"].as_array().expect("widgets").iter().filter_map(|w| w["key"].as_str()).collect();
    assert_eq!(keys, ["pause.resume", "pause.settings", "pause.quit"]);
    tap(&mut rt, PAD_A);
    assert_eq!(rt.sim().world.picked, ["settings"], "A picks the focused item");
}

#[test]
fn while_a_menu_holds_focus_the_dpad_reads_neutral_in_update_hooks() {
    let mut rt = runtime(pause_game());
    rt.inject(pad(PAD_UP, 1.0));
    rt.step(FIXED_STEP_MS * 3.0);
    assert!(rt.sim().world.up_reads.iter().all(|(_, paused)| !paused) && !rt.sim().world.up_reads.is_empty(), "no menu: the game reads up");
    rt.inject(pad(PAD_UP, 0.0));
    rt.step(FIXED_STEP_MS);
    tap(&mut rt, PAD_START);
    rt.step(FIXED_STEP_MS * 2.0);
    let before = rt.sim().world.up_reads.len();
    rt.inject(pad(PAD_UP, 1.0));
    rt.step(FIXED_STEP_MS * 6.0);
    assert_eq!(rt.sim().world.up_reads.len(), before, "a focused menu takes d-pad up from ctx.pads: {:?}", rt.sim().world.up_reads);
    assert_ne!(rt.state()["hud"]["focus"], json!("pause.resume"), "up still moved the menu's focus (it wraps)");
}

#[test]
fn hud_widgets_carry_role_key_rect_and_focus_and_hud_items_are_unchanged() {
    // Characterization: a game without game.ui lists the same items as before UIS-10.
    let mut game = Game::new(World::default()).world_size(WORLD[0], WORLD[1]);
    game.on_ui(|_, ui, _| {
        ui.label("Score 3");
        let _ = ui.button("Play");
    });
    let mut rt = runtime(game);
    rt.step(FIXED_STEP_MS);
    assert_eq!(hud_items(&rt), ["Score 3", "Play"]);
    let state = rt.state();
    let widgets = state["hud"]["widgets"].as_array().expect("widgets");
    assert_eq!(widgets.len(), 2);
    assert_eq!(widgets[1]["role"], json!("button"));
    assert_eq!(widgets[1]["label"], json!("Play"));
    assert_eq!(widgets[1]["key"], Value::Null);
    assert_eq!(widgets[1]["focused"], json!(false));
    assert_eq!(widgets[1]["rect"].as_array().map(Vec::len), Some(4));
    assert_eq!(state["hud"]["focus"], Value::Null);
    assert!(state["volatile"].get("ui").is_none(), "volatile.ui only with game.ui");
}

#[test]
fn a_tr_miss_gives_a_text_missing_asset_issue_and_draws_the_key() {
    let mut game = Game::new(World::default()).world_size(WORLD[0], WORLD[1]);
    game.ui(UiConfig::new().locales(&["en"]));
    game.on_ui(|_, ui, _| {
        ui.label(tr("greet"));
        ui.label(tr("no-such-key"));
    });
    let mut rt = runtime(game);
    rt.step(FIXED_STEP_MS);
    assert_eq!(hud_items(&rt), ["Hello", "no-such-key"]);
    let state = rt.state();
    let issues = state["__render"]["assetIssues"].as_array().expect("asset issues");
    assert!(issues.contains(&json!({"path": "lang/en.ftl", "code": "text-missing"})), "{issues:?}");
    let ui = &state["volatile"]["ui"];
    assert!(ui["issues"].as_array().expect("issues").contains(&json!({"code": "text-missing", "subject": "no-such-key"})), "{ui}");
    assert_eq!(ui["locale"], json!("en"));
    assert_eq!(ui["scale"], json!(1));
    assert_eq!(ui["safeArea"], json!([0, 0, 0, 0]));
}

#[test]
fn outside_the_hooks_and_without_game_ui_tr_answers_the_key() {
    assert_eq!(tr("greet"), "greet");
    let mut game = Game::new(World::default()).world_size(WORLD[0], WORLD[1]);
    game.on_ui(|_, ui, _| {
        ui.label(tr("greet"));
    });
    let mut rt = runtime(game);
    rt.step(FIXED_STEP_MS);
    assert_eq!(hud_items(&rt), ["greet"]);
}

fn temp_dir(name: &str) -> String {
    let dir = std::env::temp_dir().join(format!("genex-ui-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("a temp folder");
    let mut text = dir.to_str().expect("a UTF-8 temp path").to_owned();
    text.push('/');
    text
}

// A whole format-1 file (UIS-11: the settings store reads it, and refuses one without `presets`).
const PERSON_FR: &[u8] = br#"{"format":1,"presets":{},"values":{"ui.language":"fr"}}"#;

#[test]
fn in_a_genex_run_the_persons_saved_locale_is_ignored() {
    let dir = temp_dir("genex-run");
    let mut rt = runtime(pause_game());
    rt.use_studio_saves(&dir);
    assert!(rt.saves().save("genex-settings.json", PERSON_FR));
    rt.use_studio_saves(&dir);
    rt.step(FIXED_STEP_MS);
    assert_eq!(hud_items(&rt), ["Hello"]);
    assert_eq!(rt.state()["volatile"]["ui"]["locale"], json!("en"));
    rt.set_os_locale(Some("fr-FR"));
    rt.step(FIXED_STEP_MS);
    assert_eq!(hud_items(&rt), ["Hello"], "a Genex run ignores the OS locale too");
}

#[test]
fn outside_a_genex_run_the_persons_saved_locale_applies() {
    let dir = temp_dir("export");
    let mut rt = runtime(pause_game());
    rt.use_android_data(&dir);
    assert!(rt.saves().save("genex-settings.json", PERSON_FR));
    rt.use_android_data(&dir);
    rt.step(FIXED_STEP_MS);
    assert_eq!(hud_items(&rt), ["Bonjour"]);
    assert_eq!(rt.state()["volatile"]["ui"]["locale"], json!("fr"));
}

#[test]
fn a_session_override_applies_at_the_next_tick_and_outlives_a_seed() {
    let mut rt = runtime(pause_game());
    rt.step(FIXED_STEP_MS);
    let session = UiSession { locale: Some("fr".to_owned()), scale: Some(2.0), safe_area: Some([0.0, 24.0, 0.0, 0.0]), ..UiSession::default() };
    rt.ui_session(session).expect("an offered locale and a scale in range");
    assert_eq!(rt.state()["volatile"]["ui"]["locale"], json!("en"), "not before the tick boundary");
    rt.step(FIXED_STEP_MS);
    assert_eq!(hud_items(&rt), ["Bonjour"]);
    let ui = &rt.state()["volatile"]["ui"];
    assert_eq!((ui["locale"].clone(), ui["scale"].clone(), ui["safeArea"].clone()), (json!("fr"), json!(2), json!([0, 24, 0, 0])));
    rt.seed(7);
    rt.step(FIXED_STEP_MS);
    assert_eq!(hud_items(&rt), ["Bonjour"], "the session layer is kept across seeds");
}

#[test]
fn a_session_layer_is_refused_for_an_unoffered_locale_a_bad_scale_or_no_game_ui() {
    let mut rt = runtime(pause_game());
    let refused = |rt: &mut Runtime<World>, session| rt.ui_session(session).map_err(UiSessionCode::wire);
    assert_eq!(refused(&mut rt, UiSession { locale: Some("de".to_owned()), ..UiSession::default() }), Err("text-locale-unknown"));
    assert_eq!(refused(&mut rt, UiSession { scale: Some(9.0), ..UiSession::default() }), Err("bad-argument"));
    assert_eq!(refused(&mut rt, UiSession { scale: Some(f32::NAN), ..UiSession::default() }), Err("bad-argument"));
    assert_eq!(refused(&mut rt, UiSession { safe_area: Some([-1.0, 0.0, 0.0, 0.0]), ..UiSession::default() }), Err("bad-argument"));
    let mut plain = runtime(Game::new(World::default()));
    assert_eq!(refused(&mut plain, UiSession::default()), Err("bad-argument"));
}

/// A navigation source that walks down on Y only (what INPUT's `ui_*` actions plug into).
fn y_walks_down(pad: &genex_core::input::PadState, _keys: &[String]) -> NavButtons {
    NavButtons::NONE.with(NavButton::Down, pad.connected && pad.buttons[PAD_Y] > 0.5)
}

#[test]
fn the_navigation_source_is_a_function_pointer_a_game_system_replaces() {
    let mut rt = runtime(pause_game());
    rt.set_ui_nav_source(y_walks_down);
    rt.step(FIXED_STEP_MS * 2.0);
    tap(&mut rt, PAD_START);
    rt.step(FIXED_STEP_MS * 2.0);
    tap(&mut rt, PAD_DOWN);
    assert_eq!(rt.state()["hud"]["focus"], json!("pause.resume"), "the d-pad is not this source's");
    tap(&mut rt, PAD_Y);
    assert_eq!(rt.state()["hud"]["focus"], json!("pause.settings"));
}

#[test]
fn install_refuses_a_second_game_ui_and_an_invalid_locale() {
    let refusal = |game: Game<World>| Runtime::new(game).err().map(|error| error.code());
    let mut twice = Game::new(World::default());
    twice.ui(UiConfig::new()).ui(UiConfig::new());
    assert_eq!(refusal(twice), Some(InstallErrorCode::DuplicateUi));
    let mut invalid = Game::new(World::default());
    invalid.ui(UiConfig::new().locales(&["en", "?!"]));
    assert_eq!(refusal(invalid), Some(InstallErrorCode::UiLocaleInvalid));
}

#[test]
fn a_missing_text_file_is_an_asset_issue_and_every_key_draws_as_itself() {
    let mut game = Game::new(World::default()).world_size(WORLD[0], WORLD[1]);
    game.ui(UiConfig::new().locales(&["ja"]));
    game.on_ui(|_, ui, _| {
        ui.label(tr("greet"));
    });
    let mut rt = runtime(game);
    rt.step(FIXED_STEP_MS);
    assert_eq!(hud_items(&rt), ["greet"]);
    let issues = rt.state()["__render"]["assetIssues"].clone();
    assert!(issues.as_array().expect("issues").contains(&json!({"path": "lang/ja.ftl", "code": "text-missing"})), "{issues}");
}

/// The checksum after `ticks` of a game that counts ticks and toggles pause on Start, with and
/// without `game.ui` and a menu.
fn checksum_after(with_ui: bool, ticks: u32) -> String {
    let mut game = pause_game();
    if !with_ui {
        game = Game::new(World::default()).world_size(WORLD[0], WORLD[1]);
        game.on_update(|sim, ctx| {
            sim.world.ticks += 1;
            if ctx.pads.pressed(0, PAD_START) {
                sim.world.paused = !sim.world.paused;
            }
        });
    }
    game.probe("ticks", |sim| json!(sim.world.ticks));
    game.probe("paused", |sim| json!(sim.world.paused));
    let mut rt = runtime(game);
    tap(&mut rt, PAD_START);
    rt.step(FIXED_STEP_MS * f64::from(ticks));
    rt.checksum()
}

#[test]
fn game_ui_moves_no_checksum() {
    assert_eq!(checksum_after(true, 120), checksum_after(false, 120));
}

/// The capture of `rt` on a fresh presenter, or None when the host has no GPU (unless required).
fn capture(rt: &mut Runtime<World>) -> Option<Vec<u8>> {
    let mut presenter = match genex::present::Presenter::open(WORLD, &[]) {
        Ok(presenter) => presenter,
        Err(error) if std::env::var(REQUIRE_METAL_ENV).is_ok_and(|v| v == "1") => panic!("{REQUIRE_METAL_ENV}=1 but no GPU: {error}"),
        Err(error) => {
            eprintln!("skipped: no WebGPU-core adapter ({error})");
            return None;
        }
    };
    presenter.set_capturing(true);
    presenter.draw_view(rt, genex::View::Game).expect("a view").expect("a capture");
    Some(presenter.resilient.capture().expect("capture").bgra().to_vec())
}

/// The mean [r, g, b] of a capture inside a widget's world-pixel rect.
fn mean_rgb(bgra: &[u8], rect: [f32; 4]) -> [f64; 3] {
    let [x0, y0, x1, y1] = rect.map(|side| side.round() as u32);
    let mut sum = [0.0; 3];
    let mut count: f64 = 0.0;
    for y in y0..y1.min(WORLD[1]) {
        for x in x0..x1.min(WORLD[0]) {
            let i = ((y * WORLD[0] + x) * 4) as usize;
            sum[0] += f64::from(bgra[i + 2]);
            sum[1] += f64::from(bgra[i + 1]);
            sum[2] += f64::from(bgra[i]);
            count += 1.0;
        }
    }
    sum.map(|channel| channel / count.max(1.0))
}

#[test]
#[ignore = "Metal row: run with --ignored metal"]
fn metal_the_capture_after_the_pad_script_shows_the_focus_ring_on_settings() {
    let mut rt = runtime(pause_game());
    walk_to_settings(&mut rt);
    let Some(bgra) = capture(&mut rt) else { return };
    if let Some(dir) = std::env::var_os(EVIDENCE_ENV) {
        let file = std::path::Path::new(&dir).join(format!("ui-pause-focus-{}x{}.bgra", WORLD[0], WORLD[1]));
        std::fs::write(&file, &bgra).expect("write the evidence");
        eprintln!("evidence: {}", file.display());
    }
    let widgets = rt.hud_widgets();
    let rect_of = |key: &str| widgets.iter().find(|w| w.key.as_deref() == Some(key)).map(|w| w.rect).expect("the item");
    let (settings, resume, quit) = (mean_rgb(&bgra, rect_of("pause.settings")), mean_rgb(&bgra, rect_of("pause.resume")), mean_rgb(&bgra, rect_of("pause.quit")));
    let distance = |a: [f64; 3], b: [f64; 3]| a.iter().zip(b).map(|(x, y)| (x - y).abs()).sum::<f64>();
    eprintln!("mean rgb: resume {resume:?}, settings {settings:?}, quit {quit:?}");
    assert!(distance(resume, quit) < 4.0, "the unfocused items look alike: {resume:?} vs {quit:?}");
    assert!(distance(settings, quit) > 12.0, "the focused item is drawn differently (its focus ring): {settings:?} vs {quit:?}");
}

/// The fixture's `ui` block (`tests/fixtures/rust-facade-vocabulary.json`, which the template docs
/// test holds the docs to): genex-ui's text codes and UI issue codes, in declaration order.
#[test]
fn the_ui_block_is_the_fixtures() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/rust-facade-vocabulary.json");
    let fixture: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).expect("the fixture")).expect("JSON");
    let names = |value: &Value| -> Vec<String> { value.as_array().expect("a list").iter().map(|v| v.as_str().expect("a name").to_owned()).collect() };
    let codes: Vec<&str> = genex::ui::TextErrorCode::ALL.iter().map(|code| code.wire()).collect();
    assert_eq!(names(&fixture["ui"]["refusals"]), codes);
    let issues = [genex::ui::UiIssueCode::KeyInvalid, genex::ui::UiIssueCode::KeyDuplicate].map(genex::ui::UiIssueCode::wire);
    assert_eq!(names(&fixture["ui"]["issues"]), issues);
}
