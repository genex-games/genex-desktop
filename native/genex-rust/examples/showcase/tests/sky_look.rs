//! Look-integration lane SKY (renderer pass 2, after GB): the clouds and the sky on the showcase
//! frame.
//!
//! Metal rows (`--ignored metal`), one at a time:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p showcase --release \
//!     --offline --locked --test sky_look -- --ignored metal --test-threads=1 --nocapture

mod support;

use genex::present::Presenter;
use genex::render::{Environment, PresetChoice, RenderChange};
use genex::{FIXED_STEP_MS, Input, Key, Runtime, View};
use genex_render::capture::Capture;
use genex_render::settings::QualityPreset;
use support::{SHOT_TICK, gpu, out_dir, write_png};

/// A settled capture of `shot` at `preset` and `size`, the way the Studio captures it.
fn settled<W: Default + 'static>(mut presenter: Presenter, mut runtime: Runtime<W>, shot: &str, preset: QualityPreset, size: (u32, u32)) -> Capture {
    assert!(presenter.install_for(&mut runtime).is_empty(), "every pass installs");
    presenter.set_capturing(true);
    presenter.set_capture_size(Some(size));
    presenter.draw_view(&mut runtime, View::Named(shot)).expect("a view").expect("drawn");
    let change = RenderChange { preset: Some(Some(PresetChoice::Preset(preset))), ..RenderChange::default() };
    presenter.render_settings().expect("the game's settings attached").borrow_mut().apply(&change);
    presenter.draw_view(&mut runtime, View::Named(shot)).expect("a view").expect("drawn");
    presenter.resilient.capture().expect("capture")
}

/// The scene's declared environment at each time of day (N steps dusk, night, day).
fn environments<W: Default + 'static>(mut runtime: Runtime<W>) -> Vec<Option<Environment>> {
    runtime.seed(1);
    runtime.start();
    let mut seen = Vec::new();
    for _ in 0..3 {
        runtime.step(2.0 * FIXED_STEP_MS);
        seen.push(runtime.frame(View::Game).expect("a frame").declared_environment().cloned());
        runtime.inject(Input::key_tap(Key::KeyN));
    }
    seen
}

/// Look lane SKY: the B.5 cloud panorama is on by default in both showcase scenes (the renderer
/// draws it from desktop medium up; phones and low draw none, D16), at every time of day: their
/// physical sky declares a layer of clouds.
#[test]
fn both_showcase_skies_declare_the_cloud_layer_at_every_time_of_day() {
    let _ = showcase_game::assets();
    let _ = showcase_game::harbour_assets();
    let lakeside = environments(Runtime::new(showcase_game::game()).expect("the lakeside installs"));
    let harbour = environments(Runtime::new(showcase_game::harbour_game()).expect("Harbour Street installs"));
    for (scene, seen) in [("lakeside", lakeside), ("harbour-street", harbour)] {
        for (time, environment) in ["dusk", "night", "day"].into_iter().zip(seen) {
            let clouds = match environment {
                Some(Environment::Sky(sky)) => sky.clouds,
                other => panic!("{scene} {time}: the physical sky, not {other:?}"),
            };
            assert!(clouds.is_some_and(|c| c.coverage > 0.0), "{scene} {time}: the sky declares a layer of clouds ({clouds:?})");
        }
    }
}

/// Where the renderer's panorama draws (desktop high and ultra, and medium), the lakeside's own flat
/// cloud layer stands aside, so the sky never shows two layers; on a phone (none marched, D16) the
/// flat layer still draws, and so does it behind an HDR map.
#[test]
fn the_lakesides_flat_clouds_stand_aside_where_the_panorama_draws() {
    use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
    use showcase_game::passes::renderer_draws_clouds;
    use showcase_game::world::Backdrop;
    let quality = |preset, form| genex_render::presets::preset_quality(preset, DeviceClass::new(form, PerformanceTier::High)).environment;
    for preset in [QualityPreset::Medium, QualityPreset::High, QualityPreset::Ultra] {
        assert!(renderer_draws_clouds(Backdrop::Sky, &quality(preset, FormFactor::Desktop)), "desktop {preset:?}: the panorama draws");
        assert!(!renderer_draws_clouds(Backdrop::Map, &quality(preset, FormFactor::Desktop)), "desktop {preset:?} behind an HDR map: the flat layer");
    }
    for preset in [QualityPreset::Low, QualityPreset::Medium, QualityPreset::High, QualityPreset::Ultra] {
        assert!(!renderer_draws_clouds(Backdrop::Sky, &quality(preset, FormFactor::Mobile)), "phone {preset:?}: the flat layer (D16)");
    }
}

/// The roof panels' half thickness the room's volume keeps clear of (a generous plank).
const ROOF_HALF_THICKNESS: f32 = 0.06;

/// The golden-wide roof's dark zigzag (look lane SKY): the cabin room's irradiance volume reached
/// above the roof's slopes, so the cells of its top layer near the side walls stood outside, over
/// the roof. Leak control rightly let them light the roof they see, but at the room's dim bounce
/// (`ROOM_BOUNCE`), and their one-metre grid drew a staircase of shade across the sunlit slope.
/// The volume's box keeps under the roof wherever it reaches: the box bounds the yawed room on the
/// world's axes, so its corners pass the walls under the eaves, and its top stays under the roof's
/// underside at the eaves' edge, the lowest the roof comes.
#[test]
fn the_cabin_rooms_volume_stays_under_its_roof() {
    use showcase_game::draw::{RIDGE_RISE, WALL_HEIGHT, roof_run_drop};
    let (_, drop) = roof_run_drop();
    // The roof panels' mid-plane (`draw::roof`): the ridge line, falling `drop` to the eaves' edge.
    let ridge = WALL_HEIGHT + RIDGE_RISE + 0.12;
    let underside = ridge - drop - ROOF_HALF_THICKNESS;
    let (_, max) = showcase_game::interior::volume_box();
    let top = max.y - showcase_game::layout::CABIN_FLOOR;
    assert!(top <= underside, "the room's volume reaches {top:.2} m over the floor, above the roof's underside at the eaves ({underside:.2} m)");
}

/// Harbour Street at tick 600 from seed 1, its HUD hidden, N tapped `n_taps` times, `edit`ed first.
fn harbour(n_taps: u32, edit: impl FnOnce(&mut showcase_game::harbour::World)) -> Runtime<showcase_game::harbour::World> {
    let _ = showcase_game::harbour_assets();
    let mut runtime = Runtime::new(showcase_game::harbour_game()).expect("Harbour Street installs");
    runtime.seed(1);
    runtime.start();
    edit(&mut runtime.sim_mut().world);
    runtime.inject(Input::key_tap(Key::KeyH));
    for _ in 0..n_taps {
        runtime.inject(Input::key_tap(Key::KeyN));
        runtime.step(FIXED_STEP_MS);
    }
    runtime.step(f64::from(SHOT_TICK - n_taps) * FIXED_STEP_MS);
    runtime
}

/// The mean Rec. 709 luma (levels) of `capture` in the box `x0..x1`, `y0..y1`.
fn box_luma(capture: &Capture, (x0, y0, x1, y1): (usize, usize, usize, usize)) -> f64 {
    let width = capture.width() as usize;
    let pixels = capture.bgra().as_chunks::<4>().0;
    let mut sum = 0.0;
    for y in y0..y1 {
        for p in &pixels[y * width + x0..y * width + x1] {
            sum += 0.0722 * f64::from(p[0]) + 0.7152 * f64::from(p[1]) + 0.2126 * f64::from(p[2]);
        }
    }
    sum / ((x1 - x0) * (y1 - y0)) as f64
}

/// The night street-wide shot's steam column, in 1280x720 pixels: the plume over the near manhole.
const STEAM_BOX: (usize, usize, usize, usize) = (550, 440, 650, 580);
/// The least and the most the night's steam may lift its column (luma levels): a faint wisp over
/// the dark road, still there.
const NIGHT_STEAM_LIFT_MIN: f64 = 0.5;
const NIGHT_STEAM_LIFT_MAX: f64 = 10.0;

/// Look lane SKY: Harbour Street's night steam is a faint wisp over the dark street, not a bright
/// opaque column (GB look review). The steam's colour is the light the picture shows, unlit, so
/// over the night's dark road its puffs stacked into a pale grey glow; the row compares the night
/// street-wide shot with and without the steam over the plume's box.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_night_steam_is_a_faint_wisp_not_a_bright_column() {
    if gpu().is_none() {
        return;
    }
    let shoot = |runtime| {
        let presenter = Presenter::open(showcase_game::harbour::WORLD_SIZE, showcase_game::harbour_assets()).expect("presenter");
        settled(presenter, runtime, "street-wide", QualityPreset::Ultra, (1280, 720))
    };
    let steam = shoot(harbour(1, |_| {}));
    let clear = shoot(harbour(1, |world| world.night_weather.0.steam.clear()));
    let dir = out_dir();
    write_png(&dir.join("night-steam-street-wide.png"), &steam);
    write_png(&dir.join("night-steam-street-wide-without.png"), &clear);
    let lift = box_luma(&steam, STEAM_BOX) - box_luma(&clear, STEAM_BOX);
    eprintln!("night steam: the plume's box {:.1} levels with it, {:.1} without, lift {lift:.1}", box_luma(&steam, STEAM_BOX), box_luma(&clear, STEAM_BOX));
    assert!(lift >= NIGHT_STEAM_LIFT_MIN, "the steam still shows as a wisp, lighter than the road, never a dark smudge (lift {lift:.1})");
    assert!(lift <= NIGHT_STEAM_LIFT_MAX, "the night's steam lifts its column {lift:.1} levels (at most {NIGHT_STEAM_LIFT_MAX})");
}

/// The Lakeside's shore shot at 1440p (dusk, ultra): the chimney's smoke column, rows read up it
/// (pixels; below them the treetops reach the sky beside it) and the columns it rises through, and
/// the sky either side of it (columns).
const SMOKE_ROWS: std::ops::Range<usize> = 220..380;
const SMOKE_COLUMNS: std::ops::Range<usize> = 960..1120;
const SKY_LEFT: std::ops::Range<usize> = 900..940;
const SKY_RIGHT: std::ops::Range<usize> = 1140..1180;
/// The most the smoke may darken the sky beside it (levels, the darkest pixel on a row against the
/// sky's mean on that row): wood smoke the low sun and the sky light is pale and translucent.
const SMOKE_DARKER_MAX: f64 = 12.0;
/// The least it must show (the largest step from the sky on any row, either way).
const SMOKE_SHOWS_MIN: f64 = 3.0;

/// The luma (0..255) of `capture` at (x, y).
fn luma_at(capture: &Capture, x: usize, y: usize) -> f64 {
    let i = (y * capture.width() as usize + x) * 4;
    let p = &capture.bgra()[i..i + 4];
    0.2126 * f64::from(p[2]) + 0.7152 * f64::from(p[1]) + 0.0722 * f64::from(p[0])
}

/// Look fix lane SKY (after the final shots): the cabin's chimney smoke drew as a dark grey column
/// against the blue dusk sky on the shore shot (it had hidden in GB's bright cirrus), its
/// reflection a dark streak in the lake. Smoke is lit by the sun through it and by the sky: on
/// every row of its column it darkens the sky beside it by at most [`SMOKE_DARKER_MAX`] levels,
/// and it still shows ([`SMOKE_SHOWS_MIN`]).
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_chimney_smoke_is_pale_not_a_dark_column_against_the_dusk_sky() {
    if gpu().is_none() {
        return;
    }
    let mut runtime = Runtime::new(showcase_game::game()).expect("the lakeside installs");
    runtime.seed(1);
    runtime.start();
    runtime.inject(Input::key_tap(Key::KeyH));
    runtime.step(f64::from(SHOT_TICK) * FIXED_STEP_MS);
    let presenter = Presenter::open(showcase_game::showcase::WORLD_SIZE, showcase_game::assets()).expect("presenter");
    let capture = settled(presenter, runtime, "shore", QualityPreset::Ultra, (2560, 1440));
    write_png(&out_dir().join("smoke-shore-ultra-2560x1440.png"), &capture);
    let (mut darker, mut shows) = (f64::MIN, 0.0f64);
    for y in SMOKE_ROWS.step_by(10) {
        let beside: Vec<f64> = SKY_LEFT.chain(SKY_RIGHT).map(|x| luma_at(&capture, x, y)).collect();
        let sky = beside.iter().sum::<f64>() / beside.len() as f64;
        let column: Vec<f64> = SMOKE_COLUMNS.map(|x| luma_at(&capture, x, y) - sky).collect();
        let (low, high) = column.iter().fold((f64::MAX, f64::MIN), |(lo, hi), d| (lo.min(*d), hi.max(*d)));
        darker = darker.max(-low);
        shows = shows.max(-low).max(high);
    }
    eprintln!("chimney smoke on the shore shot: darkens the sky by {darker:.1} levels at most, shows by {shows:.1}");
    assert!(darker <= SMOKE_DARKER_MAX, "the smoke darkens the dusk sky by {darker:.1} levels (at most {SMOKE_DARKER_MAX})");
    assert!(shows >= SMOKE_SHOWS_MIN, "the smoke still shows ({shows:.1} levels)");
}
