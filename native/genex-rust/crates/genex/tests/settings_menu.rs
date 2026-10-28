//! The facade settings menu (G6 UIS-11, D19): `genex::settings::menu` draws the tabs Graphics
//! (today's render panel), Audio (the buses), Controls (INPUT's panel), Language & Accessibility
//! and Game (the game's own options), each with presets plus per-option control; a change routes
//! outside the simulation (`audio.*` to the mixer's person volumes, `ui.*` to the UI scope from
//! the next tick) and is saved as `genex-settings.json`; a Genex run ignores the saved file.
//!
//! Every row is new behaviour (the settings module was a stub before UIS-11), except the Graphics
//! row, which characterizes today's panel: the tab draws exactly what `render::settings_panel` does.

use genex::actions::{ActionId, ActionMap, Context, ContextId, controls_panel};
use genex::prelude::*;
use genex::settings::{SettingDef, SettingValue, SettingsConfig, SettingsTab};
use genex::ui::{UiSession, reduced_motion};
use genex::{FIXED_STEP_MS, InstallErrorCode, Runtime};

/// Standard-mapping pad buttons the scripts press.
const PAD_A: usize = 0;
const PAD_RB: usize = 5;
const PAD_UP: usize = 12;
const PAD_DOWN: usize = 13;
const PAD_LEFT: usize = 14;
const PAD_RIGHT: usize = 15;
const PAD_BUTTONS: usize = 17;
const WORLD: [u32; 2] = [640, 480];
const SETTINGS_FILE: &str = "genex-settings.json";
const PLAY: ContextId = ContextId::new("play");
const JUMP: ActionId = ActionId::new("jump");

#[derive(Default)]
struct World {
    ticks: u64,
    /// Whether the update hook read reduced motion, per tick.
    calm: Vec<bool>,
    /// What the update hook read for the game's own option.
    hints: Vec<f32>,
}

/// A game that always shows the settings menu, with `game.ui` (pad navigation) and an update hook
/// that never reads input, so only the menu reacts to the pads.
fn menu_game() -> Game<World> {
    let mut game = Game::new(World::default()).world_size(WORLD[0], WORLD[1]).background(Color::rgb(20, 24, 32));
    game.ui(UiConfig::new().locales(&["en", "fr"]));
    game.camera(|_| Camera::look_at(vec3(0.0, 2.0, 6.0), Vec3::ZERO));
    game.on_update(|sim, _| {
        sim.world.ticks += 1;
        sim.world.calm.push(reduced_motion());
        sim.world.hints.push(genex::settings::number("hint_level"));
    });
    game.on_ui(|_, ui, _| {
        genex::settings::menu(ui);
    });
    game
}

/// The menu game with an option and a preset of its own on the Game tab.
fn game_with_options() -> Game<World> {
    let mut game = menu_game();
    let options = SettingsConfig::new()
        .option(SettingsTab::Game, SettingDef::slider("hint_level", "settings-hints", 0.0, 3.0, 1.0, 1.0))
        .preset(SettingsTab::Game, "veteran", &[("hint_level", SettingValue::Number(0.0))]);
    game.settings(options);
    game
}

fn runtime(game: Game<World>) -> Runtime<World> {
    Runtime::new(game).expect("installs")
}

/// A fresh folder for a person's saves (absolute, ending in its separator).
fn temp_dir(name: &str) -> String {
    let dir = std::env::temp_dir().join(format!("genex-settings-menu-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("a temp folder");
    let mut text = dir.to_str().expect("a UTF-8 temp path").to_owned();
    text.push('/');
    text
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

fn focus(rt: &Runtime<World>) -> serde_json::Value {
    rt.state()["hud"]["focus"].clone()
}

fn hud_items(rt: &Runtime<World>) -> Vec<String> {
    rt.state()["hud"]["items"].as_array().expect("items").iter().map(|item| item.as_str().expect("a name").to_owned()).collect()
}

fn widget_keys(rt: &Runtime<World>) -> Vec<String> {
    let state = rt.state();
    state["hud"]["widgets"].as_array().expect("widgets").iter().filter_map(|widget| widget["key"].as_str().map(str::to_owned)).collect()
}

/// The saved settings file as JSON (None when nothing was written).
fn saved(rt: &Runtime<World>) -> Option<serde_json::Value> {
    rt.saves().load(SETTINGS_FILE).map(|bytes| serde_json::from_slice(&bytes).expect("the settings file is JSON"))
}

/// Open the menu and switch to the Audio tab with RB: focus lands on its preset row.
fn open_audio_tab(rt: &mut Runtime<World>) {
    rt.step(FIXED_STEP_MS * 2.0);
    tap(rt, PAD_RB);
    rt.step(FIXED_STEP_MS);
    assert_eq!(focus(rt), json!("settings.audio.preset"), "the Audio tab focuses its preset row on opening: {:?}", widget_keys(rt));
}

#[test]
fn the_audio_music_slider_at_half_reaches_the_bus_at_the_next_tick_and_persists() {
    let dir = temp_dir("music");
    let mut rt = runtime(menu_game());
    rt.use_android_data(&dir);
    open_audio_tab(&mut rt);
    tap(&mut rt, PAD_DOWN);
    tap(&mut rt, PAD_DOWN);
    assert_eq!(focus(&rt), json!("settings.opt.audio.music"));
    assert_eq!(rt.audio_settings().music, 1.0);
    tap(&mut rt, PAD_LEFT);
    assert_eq!(rt.audio_settings().music, 0.95, "one step left reaches the music bus by the end of its tick");
    for _ in 0..9 {
        tap(&mut rt, PAD_LEFT);
    }
    let settings = rt.audio_settings();
    assert_eq!((settings.music, settings.master, settings.sfx), (0.5, 1.0, 1.0), "only the music bus moved");
    let file = saved(&rt).expect("the change is saved");
    assert_eq!(file["format"], json!(1));
    assert_eq!(file["values"], json!({"audio.music": 0.5}), "the file holds only what the person moved");
    // A new run on the same saves starts with the person's volume.
    let mut again = runtime(menu_game());
    again.use_android_data(&dir);
    assert_eq!(again.audio_settings().music, 0.5);
}

#[test]
fn an_audio_preset_then_one_option_is_saved_as_the_preset_plus_a_delta() {
    let dir = temp_dir("preset");
    let mut rt = runtime(menu_game());
    rt.use_android_data(&dir);
    open_audio_tab(&mut rt);
    assert!(hud_items(&rt).contains(&"Preset: Default".to_owned()), "a tab at its defaults shows its default preset, not Custom");
    // default -> quiet
    tap(&mut rt, PAD_RIGHT);
    let quiet = rt.audio_settings();
    assert!(quiet.master < 1.0 && quiet.music < 1.0, "the quiet preset lowers the buses: {quiet:?}");
    tap(&mut rt, PAD_DOWN);
    tap(&mut rt, PAD_RIGHT);
    let file = saved(&rt).expect("saved");
    assert_eq!(file["presets"]["audio"], json!("quiet"));
    let values = file["values"].as_object().expect("values");
    assert_eq!(values.keys().collect::<Vec<_>>(), ["audio.master"], "only the moved option is a delta over the preset: {file}");
}

#[test]
fn the_graphics_tab_draws_todays_render_settings_panel() {
    let mut menu = runtime(menu_game());
    let mut panel_game = Game::new(World::default()).world_size(WORLD[0], WORLD[1]);
    panel_game.ui(UiConfig::new().locales(&["en", "fr"]));
    panel_game.on_ui(|_, ui, _| {
        genex::render::settings_panel(ui);
    });
    let mut panel = runtime(panel_game);
    menu.step(FIXED_STEP_MS * 2.0);
    panel.step(FIXED_STEP_MS * 2.0);
    let tabs = ["Graphics", "Audio", "Language & Accessibility"];
    let items = hud_items(&menu);
    assert_eq!(&items[..tabs.len()], tabs, "the tab row comes first and opens on Graphics: {items:?}");
    // Flipped on purpose (WP-14): the tab was the render panel alone; the person's display rows
    // (field of view, brightness, motion blur) and their Reset now sit above it.
    let rows = ["Field of view: 0", "Brightness: 0", "Motion blur: On", "Reset"];
    assert_eq!(&items[tabs.len()..tabs.len() + rows.len()], rows, "the display rows: {items:?}");
    assert_eq!(items[tabs.len() + rows.len()..], hud_items(&panel)[..], "then today's panel, item for item");
}

/// LOC-3: settings read 0 in the camera hook, so a game could not obey the person's screen shake,
/// head bob or field of view where the camera is made. The read hooks now see the settings as
/// routed, and nothing the person picked moves the checksum.
#[test]
fn the_camera_hook_reads_the_persons_comfort_settings_outside_the_checksum() {
    let game = || {
        let mut game = Game::new(World::default()).world_size(WORLD[0], WORLD[1]);
        game.on_update(|sim, _| sim.world.ticks += 1);
        game.camera(|_| {
            let comfort = genex::camera::Comfort::current();
            let shake = if comfort.reduced_motion { 0.0 } else { comfort.screen_shake };
            Camera { fovy: 60.0 + comfort.fov_offset + shake, ..Camera::look_at(vec3(0.0, 2.0, 6.0), Vec3::ZERO) }
        });
        game
    };
    let mut defaults = runtime(game());
    defaults.step(FIXED_STEP_MS);
    assert_eq!(defaults.camera(View::Game).expect("a camera").fovy, 61.0, "the defaults: no offset, full shake");

    let dir = temp_dir("comfort");
    let mut person = runtime(game());
    person.use_android_data(&dir);
    let comfort = br#"{"format":1,"presets":{},"values":{"graphics.fov_offset":10,"ui.screen_shake":0.5,"ui.head_bob":false}}"#;
    assert!(person.saves().save(SETTINGS_FILE, comfort));
    person.use_android_data(&dir);
    person.step(FIXED_STEP_MS);
    assert_eq!(person.camera(View::Game).expect("a camera").fovy, 70.5, "the camera hook reads the person's offset and shake");
    assert_eq!(genex::settings::comfort().head_bob, 0.0, "and the head bob toggle");
    assert_eq!(person.checksum(), defaults.checksum(), "the person's comfort never reaches the checksum");
}

const BIG_TEXT: &[u8] = br#"{"format":1,"presets":{},"values":{"ui.text_size":"text-size-200"}}"#;

/// R-25: the text size was recorded but not applied; at 200% the menu's words are twice as tall.
#[test]
fn the_text_size_the_person_chose_scales_the_menu_text() {
    let tab_height = |rt: &Runtime<World>| {
        let tab = rt.hud_widgets().into_iter().find(|widget| widget.label == "Audio").expect("the Audio tab");
        tab.rect[3] - tab.rect[1]
    };
    let mut plain = runtime(menu_game());
    plain.use_android_data(&temp_dir("text-plain"));
    plain.step(FIXED_STEP_MS * 2.0);
    let mut big = runtime(menu_game());
    let dir = temp_dir("text-big");
    big.use_android_data(&dir);
    assert!(big.saves().save(SETTINGS_FILE, BIG_TEXT));
    big.use_android_data(&dir);
    big.step(FIXED_STEP_MS * 2.0);
    let (small, large) = (tab_height(&plain), tab_height(&big));
    assert!(large > small * 1.6, "the tab's text grows with the text size: {small} -> {large}");
    assert_eq!(plain.checksum(), big.checksum(), "text size is display only");
}

const EVIDENCE_ENV: &str = "GENEX_SETTINGS_EVIDENCE_DIR";
const REQUIRE_METAL_ENV: &str = "GENEX_REQUIRE_METAL";

/// A capturing presenter (None without a WebGPU-core adapter, unless Metal is required). One
/// presenter serves every capture of a run: the HUD hands its font atlas to one painter.
fn presenter() -> Option<genex::present::Presenter> {
    match genex::present::Presenter::open(WORLD, &[]) {
        Ok(mut presenter) => {
            presenter.set_capturing(true);
            Some(presenter)
        }
        Err(error) if std::env::var(REQUIRE_METAL_ENV).is_ok_and(|v| v == "1") => panic!("{REQUIRE_METAL_ENV}=1 but no GPU: {error}"),
        Err(error) => {
            eprintln!("skipped: no WebGPU-core adapter ({error})");
            None
        }
    }
}

/// The game view as BGRA.
fn capture(presenter: &mut genex::present::Presenter, rt: &mut Runtime<World>) -> Vec<u8> {
    presenter.draw_view(rt, genex::View::Game).expect("a view").expect("a capture");
    presenter.resilient.capture().expect("capture").bgra().to_vec()
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

/// Write `bgra` as `<name>-<w>x<h>.bgra` into the evidence folder, when one is set.
fn keep(name: &str, bgra: &[u8]) {
    let Some(dir) = std::env::var_os(EVIDENCE_ENV) else { return };
    let file = std::path::Path::new(&dir).join(format!("{name}-{}x{}.bgra", WORLD[0], WORLD[1]));
    std::fs::write(&file, bgra).expect("write the evidence");
    eprintln!("evidence: {}", file.display());
}

#[test]
#[ignore = "Metal row: run with --ignored metal"]
fn metal_the_audio_and_accessibility_tabs_draw_their_rows_with_the_focus_ring() {
    let mut rt = runtime(game_with_options());
    rt.step(FIXED_STEP_MS * 2.0);
    let Some(mut presenter) = presenter() else { return };
    let graphics = capture(&mut presenter, &mut rt);
    keep("settings-graphics", &graphics);
    open_audio_tab_again(&mut rt);
    tap(&mut rt, PAD_DOWN);
    tap(&mut rt, PAD_DOWN);
    tap(&mut rt, PAD_LEFT);
    let audio = capture(&mut presenter, &mut rt);
    keep("settings-audio", &audio);
    let widgets = rt.hud_widgets();
    let rect_of = |key: &str| widgets.iter().find(|w| w.key.as_deref() == Some(key)).map(|w| w.rect).expect("the row");
    let (music, master, sfx) =
        (mean_rgb(&audio, rect_of("settings.opt.audio.music")), mean_rgb(&audio, rect_of("settings.opt.audio.master")), mean_rgb(&audio, rect_of("settings.opt.audio.sfx")));
    let distance = |a: [f64; 3], b: [f64; 3]| a.iter().zip(b).map(|(x, y)| (x - y).abs()).sum::<f64>();
    eprintln!("mean rgb: master {master:?}, music {music:?}, sfx {sfx:?}");
    assert!(distance(master, sfx) < 6.0, "unfocused rows look alike: {master:?} vs {sfx:?}");
    assert!(distance(music, sfx) > 12.0, "the focused row is drawn differently (its focus ring): {music:?} vs {sfx:?}");
    tap(&mut rt, PAD_RB);
    rt.step(FIXED_STEP_MS);
    let accessibility = capture(&mut presenter, &mut rt);
    keep("settings-accessibility", &accessibility);
    tap(&mut rt, PAD_RB);
    rt.step(FIXED_STEP_MS);
    let game = capture(&mut presenter, &mut rt);
    keep("settings-game", &game);
}

/// Switch from Graphics to the Audio tab (the menu is already open).
fn open_audio_tab_again(rt: &mut Runtime<World>) {
    tap(rt, PAD_RB);
    rt.step(FIXED_STEP_MS);
    assert_eq!(focus(rt), json!("settings.audio.preset"));
}

/// R-25 look row: the menu at 200% text on the Accessibility tab, kept for a person to look at.
#[test]
#[ignore = "Metal row: run with --ignored metal"]
fn metal_the_menu_at_200_percent_text() {
    let mut rt = runtime(game_with_options());
    let dir = temp_dir("text-200-capture");
    rt.use_android_data(&dir);
    assert!(rt.saves().save(SETTINGS_FILE, BIG_TEXT));
    rt.use_android_data(&dir);
    rt.step(FIXED_STEP_MS * 2.0);
    tap(&mut rt, PAD_RB);
    tap(&mut rt, PAD_RB);
    rt.step(FIXED_STEP_MS);
    let Some(mut presenter) = presenter() else { return };
    let accessibility = capture(&mut presenter, &mut rt);
    keep("settings-text-200-accessibility", &accessibility);
}

/// R-25 look row (GI visual row 1, "no Controls tab"): a game with `game.input` shows the Controls
/// tab between Audio and Language & Accessibility; kept for a person to look at.
#[test]
#[ignore = "Metal row: run with --ignored metal"]
fn metal_the_controls_tab_with_game_input() {
    let mut game = menu_game();
    game.input(ActionMap::new().context(Context::new(PLAY, 0).button(JUMP, &[Key::KeyJ.into()])));
    let mut rt = runtime(game);
    rt.step(FIXED_STEP_MS * 2.0);
    tap(&mut rt, PAD_RB);
    tap(&mut rt, PAD_RB);
    rt.step(FIXED_STEP_MS);
    assert!(hud_items(&rt).iter().any(|item| item == "Rebind Jump"), "the Controls tab is open: {:?}", hud_items(&rt));
    let Some(mut presenter) = presenter() else { return };
    let controls = capture(&mut presenter, &mut rt);
    keep("settings-controls", &controls);
}
