//! Lakeside's golden-hour air on the Studio path (renderer pass 2 A.5 and owner decision D13): the
//! wide shot's sun-side meadow keeps its green and its texture under the fog's sun lobe, while the
//! wide shot's left side and the forest shot keep their look. Each region is measured against the
//! numbers the same capture gave before D13 (the lobe at half the sun's radiance and the sun's own
//! colour), recorded below. With the sky's clouds on, owner decision D20 keeps only the sun-side
//! check: the clouds' sky light may warm the other regions.
//!
//! The rows are `#[ignore]`d and named `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p showcase --release \
//!     --offline --locked --test froxel_shots -- --ignored metal --nocapture
//!
//! `GENEX_SHOWCASE_OUT` receives the shots and the sun-side meadow's 1:1 crop as PNGs.

mod support;

use genex::View;
use genex_render::capture::Capture;
use support::{gpu, lakeside_at_shot_tick, out_dir, write_png};

/// A region of a capture: columns and rows, in pixels of the 1280 x 720 world.
type Region = (std::ops::Range<u32>, std::ops::Range<u32>);

/// The wide shot's sun-side meadow: the near grass on the right, under the sun's lobe.
const SUN_SIDE_MEADOW: Region = (1060..1270, 420..710);
/// The wide shot's left side: the path, the cabin's lamps and the grass, below the HUD.
const WIDE_LEFT: Region = (0..560, 170..710);
/// The forest shot, below the HUD.
const FOREST: Region = (0..1280, 170..710);

/// What a region looks like, in numbers: the mean encoded colour (8-bit sRGB), its hue in
/// degrees, its chroma (BT.709 `sqrt(U² + V²)` in 8-bit levels) and its texture (the mean absolute
/// difference, in 8-bit levels, between each pixel's luma and the mean of its 5 x 5 neighbourhood).
#[derive(Clone, Copy, Debug, PartialEq)]
struct RegionStats {
    mean: [f64; 3],
    hue: f64,
    chroma: f64,
    texture: f64,
}

/// The measures of the regions before D13 (`studio` at tick 600, the game's own preset, desktop
/// high on the M4 Max, fetched assets; the fog's sun lobe at half the sun's radiance in the sun's
/// own colour, the sky read at the horizon whatever the ray's slope): sun-side meadow, wide left,
/// forest.
const BEFORE_D13: [(&str, RegionStats); 3] = [
    ("sun-side meadow", RegionStats { mean: [142.96, 109.77, 45.17], hue: 39.64, chroma: 41.15, texture: 1.926 }),
    ("wide left", RegionStats { mean: [110.81, 103.71, 67.66], hue: 50.13, chroma: 21.38, texture: 3.654 }),
    ("forest", RegionStats { mean: [126.44, 107.30, 63.80], hue: 41.66, chroma: 27.34, texture: 4.922 }),
];
/// The sun-side meadow's veil before D13: the linear luminance the fog adds over the meadow
/// ([`veil`]).
const BEFORE_D13_MEADOW_VEIL: f64 = 0.089_02;

/// D13 cuts the haze by about a third: the sun-side meadow's veil is at most this share of
/// before, and its texture grows by at least this share.
const MEADOW_VEIL_SHARE_MAX: f64 = 0.8;
const MEADOW_TEXTURE_GAIN_MIN: f64 = 1.10;
/// D13: the regions that already looked right do not change visibly: each channel of the mean
/// colour within this many 8-bit levels, the hue within this many degrees and the texture within
/// this share of before.
const KEPT_LEVELS: f64 = 3.5;
const KEPT_HUE_DEGREES: f64 = 1.5;
const KEPT_TEXTURE_SHARE: f64 = 0.05;

/// An 8-bit sRGB level as linear light.
fn linear(level: f64) -> f64 {
    let v = level / 255.0;
    if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }
}

/// The veil over a region: the linear luminance of its mean colour less that of the same region
/// with the fog off (`clear`), so what the fog's in-scatter adds there.
fn veil(fogged: &RegionStats, clear: &RegionStats) -> f64 {
    let luminance = |s: &RegionStats| 0.2126 * linear(s.mean[0]) + 0.7152 * linear(s.mean[1]) + 0.0722 * linear(s.mean[2]);
    luminance(fogged) - luminance(clear)
}

fn luma(p: &[u8]) -> f64 {
    0.2126 * f64::from(p[2]) + 0.7152 * f64::from(p[1]) + 0.0722 * f64::from(p[0])
}

/// The hue, in degrees, of an encoded rgb colour (HSV's).
fn hue([r, g, b]: [f64; 3]) -> f64 {
    let (max, min) = (r.max(g).max(b), r.min(g).min(b));
    if max - min < 1e-9 {
        return 0.0;
    }
    let sector = if max == r {
        ((g - b) / (max - min)).rem_euclid(6.0)
    } else if max == g {
        (b - r) / (max - min) + 2.0
    } else {
        (r - g) / (max - min) + 4.0
    };
    60.0 * sector
}

fn stats(capture: &Capture, (xs, ys): &Region) -> RegionStats {
    let width = capture.width();
    let pixel = |x: u32, y: u32| {
        let i = ((y * width + x) * 4) as usize;
        &capture.bgra()[i..i + 4]
    };
    let (mut sum, mut chroma, mut texture, mut n) = ([0.0_f64; 3], 0.0, 0.0, 0.0);
    for y in ys.clone() {
        for x in xs.clone() {
            let p = pixel(x, y);
            let rgb = [f64::from(p[2]), f64::from(p[1]), f64::from(p[0])];
            for c in 0..3 {
                sum[c] += rgb[c];
            }
            let y709 = luma(p);
            let (u, v) = (0.5389 * (rgb[2] - y709), 0.6350 * (rgb[0] - y709));
            chroma += (u * u + v * v).sqrt();
            let (mut around, mut count) = (0.0, 0.0);
            for dy in -2_i32..=2 {
                for dx in -2_i32..=2 {
                    let (nx, ny) = (x as i32 + dx, y as i32 + dy);
                    if nx >= 0 && ny >= 0 && (nx as u32) < width && (ny as u32) < capture.height() {
                        around += luma(pixel(nx as u32, ny as u32));
                        count += 1.0;
                    }
                }
            }
            texture += (y709 - around / count).abs();
            n += 1.0;
        }
    }
    let mean = sum.map(|c| c / n);
    RegionStats { mean, hue: hue(mean), chroma: chroma / n, texture: texture / n }
}

/// The Studio's capture of the lakeside's shot `name` at the shot tick: genex's presenter with the
/// game's look and its own preset, with the fog switched off by the `renderSettings` change where
/// `fog` is false.
fn studio(name: &str, fog: bool) -> Capture {
    use genex::present::Presenter;
    use genex::render::{RenderChange, RenderFeature};
    let mut presenter = Presenter::open(showcase_game::showcase::WORLD_SIZE, showcase_game::assets()).expect("presenter");
    let mut runtime = lakeside_at_shot_tick();
    let refused = presenter.install_for(&mut runtime);
    assert!(refused.is_empty(), "{refused:?}");
    presenter.set_capturing(true);
    presenter.draw_view(&mut runtime, View::Named(name)).expect("a view").expect("drawn");
    if !fog {
        let change = RenderChange { features: vec![(RenderFeature::Fog, false)], ..RenderChange::default() };
        presenter.render_settings().expect("the game's settings attached").borrow_mut().apply(&change);
        presenter.draw_view(&mut runtime, View::Named(name)).expect("a view").expect("drawn");
    }
    presenter.resilient.capture().expect("capture")
}

/// Write `region` of `capture` at 1:1 as a PNG.
fn write_crop(path: &std::path::Path, capture: &Capture, (xs, ys): &Region) {
    let width = capture.width();
    let rgba: Vec<u8> = ys
        .clone()
        .flat_map(|y| xs.clone().map(move |x| (x, y)))
        .flat_map(|(x, y)| {
            let i = ((y * width + x) * 4) as usize;
            let p = &capture.bgra()[i..i + 4];
            [p[2], p[1], p[0], 255]
        })
        .collect();
    image::save_buffer(path, &rgba, xs.len() as u32, ys.len() as u32, image::ExtendedColorType::Rgba8).expect("png written");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_sun_side_meadow_keeps_its_green_and_texture_under_the_golden_hour_haze() {
    if gpu().is_none() {
        return;
    }
    let dir = out_dir();
    let (wide, clear, forest) = (studio("wide", true), studio("wide", false), studio("forest", true));
    write_png(&dir.join("studio-wide.png"), &wide);
    write_png(&dir.join("studio-wide-fog-off.png"), &clear);
    write_png(&dir.join("studio-forest.png"), &forest);
    write_crop(&dir.join("studio-wide-sun-side-meadow.png"), &wide, &SUN_SIDE_MEADOW);
    let now = [("sun-side meadow", stats(&wide, &SUN_SIDE_MEADOW)), ("wide left", stats(&wide, &WIDE_LEFT)), ("forest", stats(&forest, &FOREST))];
    let meadow_veil = veil(&now[0].1, &stats(&clear, &SUN_SIDE_MEADOW));
    for (name, row) in &now {
        println!("{name}: {row:?}");
    }
    println!(
        "{{\"row\":\"lakeside-golden-haze\",\"meadowVeil\":{meadow_veil:.5},\"regions\":{{{}}}}}",
        now.iter()
            .map(|(name, s)| format!("{name:?}:{{\"mean\":[{:.2},{:.2},{:.2}],\"hue\":{:.2},\"chroma\":{:.2},\"texture\":{:.3}}}", s.mean[0], s.mean[1], s.mean[2], s.hue, s.chroma, s.texture))
            .collect::<Vec<_>>()
            .join(",")
    );
    let mut failures = Vec::new();
    if meadow_veil > MEADOW_VEIL_SHARE_MAX * BEFORE_D13_MEADOW_VEIL {
        failures.push(format!("sun-side meadow: veil {meadow_veil:.5} from {BEFORE_D13_MEADOW_VEIL}, wanted at most x{MEADOW_VEIL_SHARE_MAX}"));
    }
    // D20: the clouds' sky light warms the regions D13 kept, and the owner keeps that look.
    let clouds_on = showcase_game::world::sky_clouds().coverage > 0.0;
    for ((name, after), (_, before)) in now.iter().zip(BEFORE_D13) {
        if *name == "sun-side meadow" {
            if after.texture < MEADOW_TEXTURE_GAIN_MIN * before.texture {
                failures.push(format!("{name}: texture {:.3} from {:.3}, wanted x{MEADOW_TEXTURE_GAIN_MIN}", after.texture, before.texture));
            }
            continue;
        }
        if clouds_on {
            continue;
        }
        let moved = (0..3).map(|c| (after.mean[c] - before.mean[c]).abs()).fold(0.0, f64::max);
        let kept = moved <= KEPT_LEVELS && (after.hue - before.hue).abs() <= KEPT_HUE_DEGREES && (after.texture / before.texture - 1.0).abs() <= KEPT_TEXTURE_SHARE;
        if !kept {
            failures.push(format!("{name}: {after:?} against {before:?} (mean moved {moved:.2} levels)"));
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

/// A game runtime at the shot tick (seed 1), its look's fog `volumetric` or the analytic fog.
fn at_shot_tick<W: Default + 'static>(game: genex::Game<W>) -> genex::Runtime<W> {
    let mut runtime = genex::Runtime::new(game).expect("registrations");
    runtime.seed(1);
    runtime.start();
    runtime.step(f64::from(support::SHOT_TICK) * genex::FIXED_STEP_MS);
    runtime
}

/// The lakeside with its look's fog drawn as a volume (`volumetric`) or analytically.
fn lakeside(volumetric: bool) -> genex::Runtime<showcase_game::world::World> {
    use showcase_game::showcase;
    let mut game = showcase::new_game();
    game.render_settings(showcase::render_config().fog(showcase::look_fog().with_volumetric(volumetric)));
    game.wgsl_root(std::path::Path::new(showcase_game::GAME_DIR));
    showcase::wire(&mut game);
    at_shot_tick(game)
}

/// Harbour Street with its look's fog drawn as a volume (`volumetric`) or analytically.
fn harbour(volumetric: bool) -> genex::Runtime<showcase_game::harbour::World> {
    use showcase_game::harbour;
    let mut game = harbour::new_game();
    game.render_settings(harbour::render_config().fog(harbour::look_fog().with_volumetric(volumetric)));
    harbour::wire(&mut game);
    at_shot_tick(game)
}

/// `runtime`'s shot `name` captured as the Studio captures it at the game's own preset.
fn presented<W: Default + 'static>(runtime: &mut genex::Runtime<W>, size: [u32; 2], assets: genex::AssetTable, name: &str) -> Capture {
    use genex::present::Presenter;
    let mut presenter = Presenter::open(size, assets).expect("presenter");
    let refused = presenter.install_for(runtime);
    assert!(refused.is_empty(), "{refused:?}");
    presenter.set_capturing(true);
    presenter.draw_view(runtime, View::Named(name)).expect("a view").expect("drawn");
    let path = presenter.resilient.renderer().renderer().last_scene().expect("a frame");
    assert!(path.hdr, "{name}: the Studio draws the HDR scene");
    presenter.resilient.capture().expect("capture")
}

/// Per-pixel encoded luma.
fn lumas(capture: &Capture) -> Vec<f64> {
    capture.bgra().chunks(4).map(luma).collect()
}

/// Plan A.5: sun shafts through the Lakeside canopy and Harbour Street's windows. The froxel fog
/// takes the sun's lobe out of the air the canopy and the walls shadow, so against the analytic fog
/// (the same look and preset, the fog not volumetric) the shot's air is darkened in streaks, not
/// uniformly: the luma difference's spread across the frame is at least [`SHAFT_SPREAD_MIN`]
/// levels, and some pixels keep the analytic fog's light (sunlit air) while others lose at least
/// [`SHAFT_DARKER_LEVELS`] (shadowed air).
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_sun_shafts_through_the_lakeside_canopy_and_the_harbour_windows() {
    if gpu().is_none() {
        return;
    }
    let dir = out_dir();
    let lakeside_size = showcase_game::showcase::WORLD_SIZE;
    let harbour_size = showcase_game::harbour::WORLD_SIZE;
    let shots: [(&str, Capture, Capture); 2] = [
        (
            "lakeside-forest-floor",
            presented(&mut lakeside(true), lakeside_size, showcase_game::assets(), "forest-floor"),
            presented(&mut lakeside(false), lakeside_size, showcase_game::assets(), "forest-floor"),
        ),
        (
            "harbour-window-shafts",
            presented(&mut harbour(true), harbour_size, showcase_game::harbour_assets(), "window-shafts"),
            presented(&mut harbour(false), harbour_size, showcase_game::harbour_assets(), "window-shafts"),
        ),
    ];
    let mut failures = Vec::new();
    for (name, volume, analytic) in &shots {
        write_png(&dir.join(format!("{name}-froxel.png")), volume);
        write_png(&dir.join(format!("{name}-analytic.png")), analytic);
        let difference: Vec<f64> = lumas(volume).iter().zip(lumas(analytic)).map(|(v, a)| v - a).collect();
        let n = difference.len() as f64;
        let mean = difference.iter().sum::<f64>() / n;
        let spread = (difference.iter().map(|d| (d - mean) * (d - mean)).sum::<f64>() / n).sqrt();
        let darker = difference.iter().filter(|d| **d <= -SHAFT_DARKER_LEVELS).count() as f64 / n;
        let kept = difference.iter().filter(|d| d.abs() <= SHAFT_KEPT_LEVELS).count() as f64 / n;
        println!("{{\"row\":\"froxel-shafts-studio\",\"shot\":{name:?},\"meanDifference\":{mean:.2},\"spread\":{spread:.2},\"darkerShare\":{darker:.4},\"keptShare\":{kept:.4}}}");
        let streaked = spread >= SHAFT_SPREAD_MIN && darker >= SHAFT_SHARE_MIN && kept >= SHAFT_SHARE_MIN;
        if !streaked {
            failures.push(format!("{name}: spread {spread:.2}, darker {darker:.4}, kept {kept:.4}"));
        }
    }
    assert!(failures.is_empty(), "no shafts: {failures:#?}");
}

/// The froxel fog's shafts: the luma difference against the analytic fog spreads by at least this
/// many levels, at least [`SHAFT_SHARE_MIN`] of the pixels are [`SHAFT_DARKER_LEVELS`] darker and
/// as many within [`SHAFT_KEPT_LEVELS`] of the analytic fog.
const SHAFT_SPREAD_MIN: f64 = 2.0;
const SHAFT_DARKER_LEVELS: f64 = 4.0;
const SHAFT_KEPT_LEVELS: f64 = 1.5;
const SHAFT_SHARE_MIN: f64 = 0.05;
