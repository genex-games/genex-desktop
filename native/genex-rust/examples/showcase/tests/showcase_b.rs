//! Renderer pass 2 B.12, the showcase's Tier B content: each scene's time of day (N steps from its
//! own dusk to a moonlit night and a clear day), the moonlit Lakeside, Harbour Street at night with
//! its wet street holding its lights, and the café's lamplit room at night.
//!
//! The headless rows run with `cargo test -p showcase --test showcase_b`. The Metal rows are
//! `#[ignore]`d and named `metal`, one at a time:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p showcase --release \
//!     --offline --locked --test showcase_b -- --ignored metal --test-threads=1 --nocapture
//!
//! They write `b12-<scene>-<shot>-<time>.png` into `GENEX_SHOWCASE_OUT` (default
//! `.studio-dev/evidence/rust-renderer/captures/latest`).

mod support;

use genex::math::Vec3;
use genex::present::Presenter;
use genex::render::{Environment, PresetChoice, RenderChange};
use genex::{Camera, FIXED_STEP_MS, Input, Key, Runtime, View, json};
use genex_render::capture::Capture;
use genex_render::settings::QualityPreset;
use support::{SHOT_TICK, gpu, out_dir, write_png};

/// The world target's aspect (both scenes draw 1280x720).
const ASPECT: f32 = 16.0 / 9.0;

fn lakeside() -> Runtime<showcase_game::world::World> {
    let _ = showcase_game::assets();
    Runtime::new(showcase_game::game()).expect("the lakeside installs")
}

fn harbour() -> Runtime<showcase_game::harbour::World> {
    let _ = showcase_game::harbour_assets();
    Runtime::new(showcase_game::harbour_game()).expect("Harbour Street installs")
}

/// The game view's sun direction and declared environment after one tick more with `key` tapped.
fn after_tap<W: Default + 'static>(runtime: &mut Runtime<W>, key: Option<Key>) -> (Vec3, Option<Environment>) {
    if let Some(key) = key {
        runtime.inject(Input::key_tap(key));
    }
    runtime.step(2.0 * FIXED_STEP_MS);
    let frame = runtime.frame(View::Game).expect("a frame");
    let sun = frame.lights().sun.as_ref().expect("the scene lights its own sun").direction;
    (sun, frame.declared_environment().cloned())
}

/// The moon and the stars of a sky environment (None for any other).
fn night_of(environment: Option<&Environment>) -> Option<(Option<[f32; 3]>, f32)> {
    match environment? {
        Environment::Sky(sky) => Some((sky.moon.map(|moon| moon.direction), sky.stars)),
        _ => None,
    }
}

/// N steps a scene from its dusk to the night (the sun under the horizon, the sky with a moon and
/// stars), then to a clear day (the sun high, no moon), then back to its dusk exactly as before.
fn n_steps_dusk_night_day<W: Default + 'static>(mut runtime: Runtime<W>, dusk_sun: Vec3, dusk_environment: &Environment) {
    runtime.seed(1);
    runtime.start();
    let (sun, environment) = after_tap(&mut runtime, None);
    assert_eq!(runtime.probes()["view"]["time"], json!("dusk"), "the scene's own time is its dusk");
    assert_eq!((sun, environment.as_ref()), (dusk_sun, Some(dusk_environment)), "the dusk is the scene as it was");

    let (sun, environment) = after_tap(&mut runtime, Some(Key::KeyN));
    assert_eq!(runtime.probes()["view"]["time"], json!("night"));
    assert!(sun.y < -0.1, "the night's sun is under the horizon: {sun:?}");
    let (moon, stars) = night_of(environment.as_ref()).expect("the night is the physical sky");
    let moon = moon.expect("the night sky has a moon");
    assert!(moon[1] > 0.1, "the moon is up: {moon:?}");
    assert!(Vec3::from(moon).dot(-sun) > 0.99, "the sun stands opposite the moon (a full moon): {moon:?} against {sun:?}");
    assert!(stars > 0.0, "the night sky has stars");

    let (sun, environment) = after_tap(&mut runtime, Some(Key::KeyN));
    assert_eq!(runtime.probes()["view"]["time"], json!("day"));
    assert!(sun.y > 0.7, "the day's sun is high: {sun:?}");
    assert_eq!(night_of(environment.as_ref()).and_then(|(moon, _)| moon), None, "no moon by day");

    let (sun, environment) = after_tap(&mut runtime, Some(Key::KeyN));
    assert_eq!(runtime.probes()["view"]["time"], json!("dusk"));
    assert_eq!((sun, environment.as_ref()), (dusk_sun, Some(dusk_environment)), "back at the dusk");
}

#[test]
fn n_steps_the_lakeside_from_its_golden_hour_to_a_moonlit_night_and_a_clear_day() {
    use showcase_game::world::Backdrop;
    n_steps_dusk_night_day(lakeside(), showcase_game::layout::SUN_DIR, &Backdrop::Sky.environment());
}

#[test]
fn n_steps_harbour_street_from_its_dusk_to_the_night_and_a_clear_day() {
    use showcase_game::harbour::Backdrop;
    n_steps_dusk_night_day(harbour(), showcase_game::street::SUN_DIR, &Backdrop::Sky.environment());
}

/// Where direction `dir` lands on `camera`'s picture (0..1 across, 0..1 down), or None behind it.
fn on_picture(camera: &Camera, dir: Vec3) -> Option<(f32, f32)> {
    let forward = (camera.target - camera.position).normalize();
    let right = forward.cross(Vec3::Y).normalize();
    let up = right.cross(forward);
    let depth = dir.dot(forward);
    if depth <= 0.0 {
        return None;
    }
    let half = genex::math::tan(camera.fovy.to_radians() * 0.5);
    let (x, y) = (dir.dot(right) / depth / (half * ASPECT), dir.dot(up) / depth / half);
    Some(((x + 1.0) * 0.5, (1.0 - y) * 0.5))
}

/// The night's moon stands inside the shot's picture, clear of its edges by `margin` of it.
fn moon_in_shot(camera: &Camera, moon: Vec3, margin: f32) -> bool {
    on_picture(camera, moon).is_some_and(|(x, y)| (margin..=1.0 - margin).contains(&x) && (margin..=1.0 - margin).contains(&y))
}

#[test]
fn the_moon_rises_in_the_wide_shots_of_both_scenes() {
    use showcase_game::{daylight, nightfall};
    for name in ["wide", "golden-wide"] {
        let shot = showcase_game::world::named_shots().find(|shot| shot.name == name).expect("a lakeside shot");
        assert!(moon_in_shot(&shot.camera(), daylight::MOON_DIR, 0.04), "{name}: the moon at {:?}", on_picture(&shot.camera(), daylight::MOON_DIR));
    }
    let street = showcase_game::harbour::SHOTS.iter().find(|shot| shot.name == "street-wide").expect("the street-wide shot");
    assert!(moon_in_shot(&street.camera(), nightfall::MOON_DIR, 0.04), "street-wide: the moon at {:?}", on_picture(&street.camera(), nightfall::MOON_DIR));
}

/// A scene's settled capture of `shot` at tick 600 at `time` (N tapped that often), HUD hidden,
/// at `high` on the world target's size, as the Studio captures it.
fn settled<W: Default + 'static>(mut presenter: Presenter, mut runtime: Runtime<W>, shot: &str, n_taps: u32) -> Capture {
    runtime.seed(1);
    runtime.start();
    runtime.inject(Input::key_tap(Key::KeyH));
    for _ in 0..n_taps {
        runtime.inject(Input::key_tap(Key::KeyN));
        runtime.step(FIXED_STEP_MS);
    }
    runtime.step(f64::from(SHOT_TICK - n_taps) * FIXED_STEP_MS);
    assert!(presenter.install_for(&mut runtime).is_empty(), "every pass installs");
    presenter.set_capturing(true);
    presenter.draw_view(&mut runtime, View::Named(shot)).expect("a view").expect("drawn");
    let change = RenderChange { preset: Some(Some(PresetChoice::Preset(QualityPreset::High))), ..RenderChange::default() };
    presenter.render_settings().expect("the game's settings attached").borrow_mut().apply(&change);
    presenter.draw_view(&mut runtime, View::Named(shot)).expect("a view").expect("drawn");
    presenter.resilient.capture().expect("capture")
}

fn lakeside_shot(shot: &str, n_taps: u32) -> Option<Capture> {
    let presenter = Presenter::open(showcase_game::showcase::WORLD_SIZE, showcase_game::assets()).ok()?;
    Some(settled(presenter, lakeside(), shot, n_taps))
}

fn harbour_shot(shot: &str, n_taps: u32) -> Option<Capture> {
    let presenter = Presenter::open(showcase_game::harbour::WORLD_SIZE, showcase_game::harbour_assets()).ok()?;
    Some(settled(presenter, harbour(), shot, n_taps))
}

/// N taps to the night from a scene's dusk.
const TO_NIGHT: u32 = 1;

/// Encoded BT.709 luma (0..255) of a BGRA pixel.
fn luma(p: &[u8]) -> f64 {
    0.2126 * f64::from(p[2]) + 0.7152 * f64::from(p[1]) + 0.0722 * f64::from(p[0])
}

/// Mean luma of the rows `rows` (0..1 of the height) of `capture`.
fn mean_luma(capture: &Capture, rows: std::ops::Range<f32>) -> f64 {
    let (w, h) = (capture.width() as usize, capture.height() as usize);
    let (y0, y1) = ((rows.start * h as f32) as usize, (rows.end * h as f32) as usize);
    let pixels = &capture.bgra()[y0 * w * 4..y1 * w * 4];
    pixels.chunks(4).map(luma).sum::<f64>() / (pixels.len() / 4) as f64
}

/// The brightest luma within `radius` pixels of where `dir` lands on `camera`'s picture.
fn brightest_near(capture: &Capture, camera: &Camera, dir: Vec3, radius: i64) -> f64 {
    let Some((u, v)) = on_picture(camera, dir) else { return 0.0 };
    let (w, h) = (i64::from(capture.width()), i64::from(capture.height()));
    let (cx, cy) = ((u * w as f32) as i64, (v * h as f32) as i64);
    let mut best = 0.0_f64;
    for y in (cy - radius).max(0)..(cy + radius + 1).min(h) {
        for x in (cx - radius).max(0)..(cx + radius + 1).min(w) {
            let at = ((y * w + x) * 4) as usize;
            best = best.max(luma(&capture.bgra()[at..at + 4]));
        }
    }
    best
}

/// A night is darker than the dusk by at least this share of the dusk's mean luma, and brighter
/// than this mean luma (a night, not a black frame).
const NIGHT_UNDER_DUSK: f64 = 0.7;
const NIGHT_MEAN_LUMA_MIN: f64 = 12.0;
/// The moon's disk is this bright where it stands on the picture (within a few pixels: the disk is
/// about 9 pixels across at 720p), and this many times the night's mean (the street's damp air
/// veils it a little).
const MOON_LUMA_MIN: f64 = 160.0;
const MOON_OVER_MEAN_MIN: f64 = 3.0;
const MOON_SEARCH_PX: i64 = 6;
/// The moonlit ground (the lower half of the wide shot) stays readable: this mean luma at least.
const MOONLIT_GROUND_LUMA_MIN: f64 = 10.0;

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_moonlit_lakeside_is_a_night_with_the_moon_over_the_lake_and_its_ground_lit() {
    if gpu().is_none() {
        return;
    }
    let shot = "golden-wide";
    let camera = showcase_game::world::named_shots().find(|s| s.name == shot).expect("the shot").camera();
    let Some(dusk) = lakeside_shot(shot, 0) else { return };
    let night = lakeside_shot(shot, TO_NIGHT).expect("a second presenter");
    let dir = out_dir();
    write_png(&dir.join(format!("b12-lakeside-{shot}-dusk.png")), &dusk);
    write_png(&dir.join(format!("b12-lakeside-{shot}-night.png")), &night);
    let (dusk_mean, night_mean) = (mean_luma(&dusk, 0.0..1.0), mean_luma(&night, 0.0..1.0));
    let ground = mean_luma(&night, 0.5..1.0);
    let moon = brightest_near(&night, &camera, showcase_game::daylight::MOON_DIR, MOON_SEARCH_PX);
    println!("lakeside {shot}: dusk mean {dusk_mean:.1}, night mean {night_mean:.1}, night ground {ground:.1}, moon {moon:.1}");
    assert!(night_mean < NIGHT_UNDER_DUSK * dusk_mean, "the night ({night_mean:.1}) is not darker than the dusk ({dusk_mean:.1})");
    assert!(night_mean > NIGHT_MEAN_LUMA_MIN, "the night is black: {night_mean:.1}");
    assert!(moon >= MOON_LUMA_MIN.max(MOON_OVER_MEAN_MIN * night_mean), "no moon over the lake: brightest {moon:.1} where it stands");
    assert!(ground >= MOONLIT_GROUND_LUMA_MIN, "the moonlit ground is black: {ground:.1}");
}

/// Harbour Street at night: the wet street (the picture's lower third) holds its lights: at least
/// this share of its pixels is lit at least this luma, the neon's, lamps' and windows' light on the
/// wet asphalt and the puddles.
const LIT_STREET_LUMA: f64 = 60.0;
const LIT_STREET_SHARE_MIN: f64 = 0.03;

/// The share of the lower third's pixels at least `luma_min` bright.
fn lit_share(capture: &Capture, luma_min: f64) -> f64 {
    let (w, h) = (capture.width() as usize, capture.height() as usize);
    let pixels = &capture.bgra()[(2 * h / 3) * w * 4..];
    pixels.chunks(4).filter(|p| luma(p) >= luma_min).count() as f64 / (pixels.len() / 4) as f64
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_harbour_street_at_night_is_dark_between_its_lights_and_the_wet_street_holds_them() {
    if gpu().is_none() {
        return;
    }
    let shot = "street-wide";
    let camera = showcase_game::harbour::SHOTS.iter().find(|s| s.name == shot).expect("the shot").camera();
    let Some(dusk) = harbour_shot(shot, 0) else { return };
    let night = harbour_shot(shot, TO_NIGHT).expect("a second presenter");
    let dir = out_dir();
    write_png(&dir.join(format!("b12-harbour-{shot}-dusk.png")), &dusk);
    write_png(&dir.join(format!("b12-harbour-{shot}-night.png")), &night);
    let (dusk_mean, night_mean) = (mean_luma(&dusk, 0.0..1.0), mean_luma(&night, 0.0..1.0));
    let lit = lit_share(&night, LIT_STREET_LUMA);
    let moon = brightest_near(&night, &camera, showcase_game::nightfall::MOON_DIR, MOON_SEARCH_PX);
    println!("harbour {shot}: dusk mean {dusk_mean:.1}, night mean {night_mean:.1}, lit street {:.2}%, moon {moon:.1}", lit * 100.0);
    assert!(night_mean < NIGHT_UNDER_DUSK * dusk_mean, "the night ({night_mean:.1}) is not darker than the dusk ({dusk_mean:.1})");
    assert!(night_mean > NIGHT_MEAN_LUMA_MIN, "the night is black: {night_mean:.1}");
    assert!(lit >= LIT_STREET_SHARE_MIN, "the wet street holds no light: {:.2}% of it at luma {LIT_STREET_LUMA}", lit * 100.0);
    assert!(moon >= MOON_LUMA_MIN.max(MOON_OVER_MEAN_MIN * night_mean), "no moon over the street: brightest {moon:.1} where it stands");
}

/// Frames each time of day draws before the timed ones, the timed frames, and the rounds the
/// three times are interleaved over (a shared GPU drifts; interleaving keeps the deltas honest).
const WARM_FRAMES: usize = 20;
const TIMED_FRAMES: usize = 30;
const ROUNDS: usize = 3;

/// One scene's presenter and runtime at a time of day, drawing Live frames of `shot` at `high`.
struct Timed<W: Default + 'static> {
    presenter: Presenter,
    runtime: Runtime<W>,
    shot: &'static str,
}

impl<W: Default + 'static> Timed<W> {
    fn new(mut presenter: Presenter, mut runtime: Runtime<W>, shot: &'static str, n_taps: u32) -> Timed<W> {
        runtime.seed(1);
        runtime.start();
        runtime.inject(Input::key_tap(Key::KeyH));
        for _ in 0..n_taps {
            runtime.inject(Input::key_tap(Key::KeyN));
            runtime.step(FIXED_STEP_MS);
        }
        assert!(presenter.install_for(&mut runtime).is_empty(), "every pass installs");
        presenter.draw_view(&mut runtime, View::Named(shot)).expect("a view").expect("drawn");
        let change = RenderChange { preset: Some(Some(PresetChoice::Preset(QualityPreset::High))), ..RenderChange::default() };
        presenter.render_settings().expect("the game's settings attached").borrow_mut().apply(&change);
        Timed { presenter, runtime, shot }
    }

    /// One frame: a tick, a Live draw and the read back that waits for the GPU (milliseconds).
    #[allow(clippy::disallowed_types, reason = "the frame-cost row reads the wall clock; the simulation never does")]
    fn frame(&mut self) -> f64 {
        self.runtime.step(FIXED_STEP_MS);
        let start = std::time::Instant::now();
        self.presenter.draw_view(&mut self.runtime, View::Named(self.shot)).expect("a view").expect("drawn");
        let _ = self.presenter.resilient.capture().expect("the frame read back");
        start.elapsed().as_secs_f64() * 1000.0
    }
}

/// The p50 of `times` (sorted in place).
fn median(times: &mut [f64]) -> f64 {
    times.sort_by(f64::total_cmp);
    support::percentile(times, 0.5)
}

/// Informational (no budget of its own): a frame's wall time at each time of day, interleaved, on
/// the wide shots at `high` and the world size, a Live draw plus the read back that waits for the
/// GPU, so the night's sky (stars, the moon and its LUT) and lights show as a delta on the dusk.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_each_time_of_day_s_frame_cost_is_recorded() {
    if gpu().is_none() {
        return;
    }
    let mut rows = Vec::new();
    let lakeside_open = || Presenter::open(showcase_game::showcase::WORLD_SIZE, showcase_game::assets()).expect("a presenter");
    let harbour_open = || Presenter::open(showcase_game::harbour::WORLD_SIZE, showcase_game::harbour_assets()).expect("a presenter");
    let mut lake: Vec<Timed<showcase_game::world::World>> = (0..3).map(|taps| Timed::new(lakeside_open(), lakeside(), "golden-wide", taps)).collect();
    let mut street: Vec<Timed<showcase_game::harbour::World>> = (0..3).map(|taps| Timed::new(harbour_open(), harbour(), "street-wide", taps)).collect();
    let mut lake_times = vec![Vec::new(); 3];
    let mut street_times = vec![Vec::new(); 3];
    for _ in 0..ROUNDS {
        for (timed, times) in lake.iter_mut().zip(&mut lake_times) {
            (0..WARM_FRAMES).for_each(|_| _ = timed.frame());
            times.extend((0..TIMED_FRAMES).map(|_| timed.frame()));
        }
        for (timed, times) in street.iter_mut().zip(&mut street_times) {
            (0..WARM_FRAMES).for_each(|_| _ = timed.frame());
            times.extend((0..TIMED_FRAMES).map(|_| timed.frame()));
        }
    }
    for (scene, shot, times) in [("lakeside", "golden-wide", &mut lake_times), ("harbour-street", "street-wide", &mut street_times)] {
        let p50: Vec<f64> = times.iter_mut().map(|t| median(t)).collect();
        rows.push(format!(
            "{{\"scene\": \"{scene}\", \"shot\": \"{shot}\", \"duskP50Ms\": {:.3}, \"nightP50Ms\": {:.3}, \"dayP50Ms\": {:.3}, \"nightDeltaMs\": {:.3}, \"dayDeltaMs\": {:.3}}}",
            p50[0],
            p50[1],
            p50[2],
            p50[1] - p50[0],
            p50[2] - p50[0]
        ));
    }
    let record =
        format!("{{\"measures\": \"Live draw + read back wall time, high, 1280x720, release, {ROUNDS} interleaved rounds of {TIMED_FRAMES}\", \"rows\": [{}]}}\n", rows.join(", "));
    std::fs::write(out_dir().join("b12-time-of-day-cost.json"), &record).expect("record");
    println!("{record}");
}
