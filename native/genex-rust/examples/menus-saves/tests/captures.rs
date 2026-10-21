//! menus-saves's settled captures on the host GPU (Metal on the Mac), drawn as the Studio draws a
//! frame (genex's presenter), each reached by pad alone: the title in English, the pause menu,
//! the Language & Accessibility tab and the inventory under `xx-pseudo` (overflow shows as cut
//! text), the pause menu and inventory at 4K, and a portrait phone (390 x 844 world, captured at
//! 1170 x 2532) with a notch and home indicator emulated through the session's safe area. Two
//! settled captures of one tick are equal.
//!
//! The row is `#[ignore]`d and named `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p menus-saves \
//!     --release --offline --test captures -- --ignored metal --nocapture
//!
//! It writes `menus-saves-<shot>.png` and `menus-saves-digests.json` to `GENEX_MENUS_SAVES_OUT`
//! (default `.studio-dev/evidence/rust-renderer/captures/menus-saves`).

use std::path::PathBuf;

use genex::present::Presenter;
use genex::ui::UiSession;
use genex::{FIXED_STEP_MS, Input, Runtime, View};
use menus_saves_game::{ASSETS, PORTRAIT_SIZE, WORLD_SIZE, World, game_sized};

const PAD_A: usize = 0;
const PAD_RB: usize = 5;
const PAD_START: usize = 9;
const PAD_DOWN: usize = 13;
const PAD_RIGHT: usize = 15;
const PAD_BUTTONS: usize = 17;
const WALK_MAX: usize = 8;
const SEED: u32 = 3;
const SIZE_4K: (u32, u32) = (3840, 2160);
/// A phone's portrait screen in pixels (three pixels per world pixel).
const PHONE_PIXELS: (u32, u32) = (1170, 2532);
/// A phone's notch and home indicator, `[left, top, right, bottom]` in world pixels.
const PHONE_SAFE_AREA: [f32; 4] = [0.0, 47.0, 0.0, 34.0];
const PSEUDO: &str = "xx-pseudo";

/// Where a shot stops, reached by pad from a fresh seed.
#[derive(Clone, Copy)]
enum Stop {
    Title,
    Pause,
    AccessibilityTab,
    Inventory,
}

/// One capture: its name, the world, the capture size, the locale and safe area, and the stop.
struct Shot {
    name: &'static str,
    world: [u32; 2],
    size: Option<(u32, u32)>,
    locale: Option<&'static str>,
    safe: Option<[f32; 4]>,
    stop: Stop,
}

const fn shot(name: &'static str, world: [u32; 2], size: Option<(u32, u32)>, locale: Option<&'static str>, stop: Stop) -> Shot {
    Shot { name, world, size, locale, safe: None, stop }
}

fn shots() -> Vec<Shot> {
    vec![
        shot("title-en", WORLD_SIZE, None, None, Stop::Title),
        shot("pause-pseudo", WORLD_SIZE, None, Some(PSEUDO), Stop::Pause),
        shot("settings-accessibility-pseudo", WORLD_SIZE, None, Some(PSEUDO), Stop::AccessibilityTab),
        shot("inventory-pseudo", WORLD_SIZE, None, Some(PSEUDO), Stop::Inventory),
        shot("pause-4k", WORLD_SIZE, Some(SIZE_4K), None, Stop::Pause),
        shot("inventory-4k", WORLD_SIZE, Some(SIZE_4K), None, Stop::Inventory),
        Shot { safe: Some(PHONE_SAFE_AREA), ..shot("phone-portrait-title", PORTRAIT_SIZE, Some(PHONE_PIXELS), None, Stop::Title) },
        Shot { safe: Some(PHONE_SAFE_AREA), ..shot("phone-portrait-pause-pseudo", PORTRAIT_SIZE, Some(PHONE_PIXELS), Some(PSEUDO), Stop::Pause) },
        Shot { safe: Some(PHONE_SAFE_AREA), ..shot("phone-portrait-inventory", PORTRAIT_SIZE, Some(PHONE_PIXELS), None, Stop::Inventory) },
        Shot { safe: Some(PHONE_SAFE_AREA), ..shot("phone-portrait-hud", PORTRAIT_SIZE, Some(PHONE_PIXELS), None, Stop::Pause) },
    ]
}

fn out_dir() -> PathBuf {
    let evidence = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../.studio-dev/evidence/rust-renderer/captures/menus-saves");
    let dir = std::env::var_os("GENEX_MENUS_SAVES_OUT").map_or(evidence, PathBuf::from);
    std::fs::create_dir_all(&dir).expect("the captures folder");
    dir
}

/// Write a BGRA capture as an opaque RGBA PNG.
fn write_png(path: &PathBuf, bgra: &[u8], size: [u32; 2]) {
    let rgba: Vec<u8> = bgra.chunks(4).flat_map(|p| [p[2], p[1], p[0], 255]).collect();
    image::save_buffer(path, &rgba, size[0], size[1], image::ExtendedColorType::Rgba8).expect("png written");
}

fn pad(button: usize, value: f32) -> Input {
    let mut buttons = vec!["0".to_owned(); PAD_BUTTONS];
    buttons[button] = value.to_string();
    let text = format!(r#"{{"pads":[{{"index":0,"buttons":[{}]}}]}}"#, buttons.join(","));
    let arg = genex_core::json::parse(text.as_bytes()).expect("JSON");
    Input::from_injection(genex_core::input::parse_injection(&arg))
}

fn tap(rt: &mut Runtime<World>, button: usize) {
    rt.inject(pad(button, 1.0));
    rt.step(FIXED_STEP_MS);
    rt.inject(pad(button, 0.0));
    rt.step(FIXED_STEP_MS);
}

fn pick(rt: &mut Runtime<World>, key: &str) {
    for _ in 0..WALK_MAX {
        if rt.state()["hud"]["focus"] == genex::json!(key) {
            break;
        }
        tap(rt, PAD_DOWN);
    }
    assert_eq!(rt.state()["hud"]["focus"], genex::json!(key), "never reached {key}");
    tap(rt, PAD_A);
    rt.step(FIXED_STEP_MS);
}

/// A fresh, empty folder standing in for a Studio run's `state/`.
fn state_dir(name: &str) -> String {
    let dir = std::env::temp_dir().join(format!("menus-saves-capture-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("a temp folder");
    let mut text = dir.to_str().expect("a UTF-8 temp path").to_owned();
    text.push('/');
    text
}

/// The runtime at `shot`'s stop.
fn settled(shot: &Shot) -> Runtime<World> {
    let mut rt = Runtime::with_assets(game_sized(shot.world), Box::new(ASSETS)).expect("installs");
    rt.use_studio_saves(&state_dir(shot.name));
    rt.ui_session(UiSession { locale: shot.locale.map(str::to_owned), safe_area: shot.safe, ..UiSession::default() }).expect("the session applies");
    rt.seed(SEED);
    rt.step(FIXED_STEP_MS * 2.0);
    match shot.stop {
        Stop::Title => {}
        Stop::AccessibilityTab => {
            pick(&mut rt, "title.settings");
            tap(&mut rt, PAD_RB);
            tap(&mut rt, PAD_RB);
        }
        Stop::Pause | Stop::Inventory => {
            pick(&mut rt, "title.new");
            for _ in 0..3 {
                tap(&mut rt, PAD_RIGHT);
            }
            if shot.name.ends_with("hud") {
                return rt;
            }
            tap(&mut rt, PAD_START);
            rt.step(FIXED_STEP_MS);
            if matches!(shot.stop, Stop::Inventory) {
                pick(&mut rt, "pause.inventory");
            }
        }
    }
    rt.step(FIXED_STEP_MS);
    rt
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_settled_captures_of_the_menus_by_pad() {
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    let dir = out_dir();
    let mut digests = genex::json!({});
    for world in [WORLD_SIZE, PORTRAIT_SIZE] {
        let mut presenter = match Presenter::open(world, ASSETS) {
            Ok(presenter) => presenter,
            Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
            Err(error) => return eprintln!("skipped: no WebGPU-core adapter ({error})"),
        };
        for shot in shots().iter().filter(|shot| shot.world == world) {
            let mut rt = settled(shot);
            assert!(presenter.install_for(&mut rt).is_empty());
            presenter.set_capturing(true);
            presenter.set_capture_size(shot.size);
            let mut shoot = || {
                presenter.draw_view(&mut rt, View::Game).expect("a view").expect("drawn");
                presenter.resilient.capture().expect("capture")
            };
            let (capture, again) = (shoot(), shoot());
            assert_eq!(capture.digest(), again.digest(), "{}: two settled captures of one tick differ", shot.name);
            let size = [capture.width(), capture.height()];
            if let Some((w, h)) = shot.size {
                assert_eq!(size, [w, h], "{}: captured at the asked size", shot.name);
            }
            write_png(&dir.join(format!("menus-saves-{}.png", shot.name)), capture.bgra(), size);
            digests[shot.name] = genex::json!(format!("{:016x}", capture.digest()));
            println!("{}: {}x{} {:016x}", shot.name, size[0], size[1], capture.digest());
        }
    }
    std::fs::write(dir.join("menus-saves-digests.json"), digests.to_string()).expect("the digests write");
}
