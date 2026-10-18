//! Harbour Street's steam and drizzle (renderer pass 2 A.11): steam rising from its manholes, soft
//! and sorted, and a drizzle whose streaks stop on what the camera sees. The CPU rows hold what
//! every shot draws and that a reset draws the same emitters; the GPU rows draw the shots the way
//! the Studio captures them, twice to one digest (the sort's order and the particles are the same
//! every run), and hold that the steam meets the road without the hard line it cuts drawn hard.
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p showcase --release \
//!     --offline --locked --test harbour_weather -- --include-ignored metal --nocapture

mod support;

use genex::{FIXED_STEP_MS, Particles, Runtime, View};
use genex_render::capture::Capture;
use showcase_game::harbour::{SHOTS, WORLD_SIZE, World};
use showcase_game::{harbour_assets, harbour_game};
use support::{SHOT_TICK, gpu, out_dir, write_png};

fn runtime(seed: u32) -> Runtime<World> {
    let mut runtime = Runtime::new(harbour_game()).expect("installs");
    runtime.seed(seed);
    runtime.start();
    runtime.step(f64::from(SHOT_TICK) * FIXED_STEP_MS);
    runtime
}

#[test]
fn every_shot_draws_the_steam_and_the_drizzle() {
    let mut runtime = runtime(1);
    for shot in SHOTS {
        let frame = runtime.frame(View::Named(shot.name)).expect("its frame");
        let drawn = frame.drawn_particles();
        let steam: Vec<&Particles> = drawn.iter().filter(|p| p.desc().sorted).collect();
        let rain: Vec<&Particles> = drawn.iter().filter(|p| p.desc().collides()).collect();
        assert_eq!((steam.len(), rain.len()), (3, 3), "{}: a plume a manhole and the drizzle over each half and the alley", shot.name);
        assert!(steam.iter().all(|p| p.desc().soft_distance > 0.0), "{}: the steam is soft", shot.name);
        assert!(rain.iter().all(|p| p.desc().stretch > 0.0 && p.desc().soft_distance > 0.0), "{}: the drizzle is soft streaks", shot.name);
        let alive: u32 = drawn.iter().map(Particles::alive).sum();
        assert!(alive <= genex_render::particles::particle_cap(genex_render::device_class::DeviceClass::from_wire("desktop-high").expect("class")));
    }
}

#[test]
fn a_reset_draws_the_same_emitters() {
    let versions = |seed| {
        let mut runtime = runtime(seed);
        let frame = runtime.frame(View::Named("street-wide")).expect("a frame");
        frame.drawn_particles().iter().map(Particles::version).collect::<Vec<_>>()
    };
    assert_eq!(versions(1), versions(2), "a new seed rebuilds the world with the emitters the renderer holds");
}

/// `name` at tick 600 of seed 1 captured the way the Studio captures it, the world's weather first
/// changed by `weather` (None without a GPU).
fn studio_shot(name: &str, weather: &dyn Fn(&mut World)) -> Option<Capture> {
    use genex::present::Presenter;
    let mut presenter = Presenter::open(WORLD_SIZE, harbour_assets()).ok()?;
    let mut runtime = runtime(1);
    weather(&mut runtime.sim_mut().world);
    let refused = presenter.install_for(&mut runtime);
    assert!(refused.is_empty(), "{refused:?}");
    presenter.set_capturing(true);
    presenter.draw_view(&mut runtime, View::Named(name)).expect("a view").expect("drawn");
    Some(presenter.resilient.capture().expect("capture"))
}

fn as_drawn(_: &mut World) {}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_weather_is_drawn_the_same_twice() {
    if gpu().is_none() {
        return;
    }
    for name in ["street-wide", "puddle", "neon-alley"] {
        let (Some(first), Some(again)) = (studio_shot(name, &as_drawn), studio_shot(name, &as_drawn)) else { return };
        write_png(&out_dir().join(format!("harbour-{name}-weather.png")), &first);
        assert_eq!(first.digest(), again.digest(), "{name}: two settled captures of the weather differ");
    }
}

/// Per row of column `x`: the largest channel difference between `a` and `b`.
fn column_difference(a: &Capture, b: &Capture, x: u32) -> Vec<u8> {
    (0..a.height())
        .map(|y| {
            let at = ((y * a.width() + x) * 4) as usize;
            (0..3).map(|c| a.bgra()[at + c].abs_diff(b.bgra()[at + c])).max().unwrap_or(0)
        })
        .collect()
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_steam_meets_the_road_without_a_hard_line() {
    // The street-wide shot looks down the street past the west manhole's plume. Drawn hard, the
    // plume's lowest puffs cut a line where they go into the road; soft, they fade into it over rows.
    if gpu().is_none() {
        return;
    }
    let no_steam = |world: &mut World| world.weather.steam.clear();
    let hard = |world: &mut World| world.weather.steam = world.weather.steam.iter().map(|p| p.with_soft(0.0)).collect();
    let (Some(plain), Some(soft), Some(hard)) = (studio_shot("street-wide", &no_steam), studio_shot("street-wide", &as_drawn), studio_shot("street-wide", &hard)) else { return };
    write_png(&out_dir().join("harbour-street-wide-steam-soft.png"), &soft);
    write_png(&out_dir().join("harbour-street-wide-steam-hard.png"), &hard);
    let runtime = runtime(1);
    let camera = runtime.camera(View::Named("street-wide")).expect("the camera");
    let view_proj = genex::present::camera_desc(&camera).view_proj(WORLD_SIZE[0] as f32 / WORLD_SIZE[1] as f32);
    let manhole = genex::math::vec3(-20.0, 0.0, -1.6);
    let clip = view_proj * manhole.extend(1.0);
    let (x, line) = (((clip.x / clip.w * 0.5 + 0.5) * WORLD_SIZE[0] as f32) as i64, ((0.5 - clip.y / clip.w * 0.5) * WORLD_SIZE[1] as f32) as i64);
    assert!((8..i64::from(WORLD_SIZE[0]) - 8).contains(&x) && (24..i64::from(WORLD_SIZE[1]) - 8).contains(&line), "the manhole is in the shot at ({x}, {line})");
    // Over the columns across the plume's foot: the largest one-row step of the steam's difference
    // from 10 rows above the manhole's centre to 6 below it (the grate's far edge, 12 rows up, is
    // the background's own step under the steam's veil, not the steam's).
    let rows = |capture: &Capture, column: i64| column_difference(capture, &plain, column as u32)[(line - 10) as usize..(line + 6) as usize].to_vec();
    let step = |capture: &Capture| (x - 6..=x + 6).map(|column| rows(capture, column).windows(2).map(|w| w[0].abs_diff(w[1])).max().unwrap_or(0)).max().unwrap_or(0);
    for column in [x - 4, x, x + 4] {
        println!("column {column}: soft {:?}\n           hard {:?}", rows(&soft, column), rows(&hard, column));
    }
    let (soft_step, hard_step) = (step(&soft), step(&hard));
    println!("street-wide steam at the road line (row {line}, columns {}..{}): soft step {soft_step}, hard step {hard_step}", x - 6, x + 6);
    assert!(hard_step >= 16, "drawn hard, the plume cuts a line into the road ({hard_step} levels in a row)");
    assert!(soft_step * 2 <= hard_step, "soft, the plume fades into the road: step {soft_step} against {hard_step} hard");
}
