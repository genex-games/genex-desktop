//! The showcase's named shots rendered on the host GPU (Metal on the Mac) the way the studio draws a
//! frame (the scene from the draw hook, the custom passes bound to the simulation), written as PNGs
//! for the renderer before/after comparison, plus a frame-time row per shot.
//!
//! The rows are `#[ignore]`d and named `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p showcase --release \
//!     --offline --locked --test shots -- --ignored metal --nocapture
//!
//! `GENEX_SHOWCASE_OUT` names the folder (default `.studio-dev/evidence/rust-renderer/captures/latest`;
//! the `captures/before` baseline only with `GENEX_SHOWCASE_WRITE_BEFORE=1`).
//! Every shot is taken at tick 600 (ten seconds after seed 1): wind, water, fireflies and the
//! animals are where they are at that tick; the scene has no history (no temporal effect). The
//! passes are custom-pass API v2 and draw on the scene the renderer gives them; none keeps a frame
//! LDR. The renderer-core rows hand the renderer no HDR scene format (the legacy LDR scene, the
//! before/after reference); the presenter rows take the captures the Studio takes (genex's
//! presenter with the game's look, AgX punchy with auto exposure, on the HDR scene:
//! `studio-<shot>.png`, and `studio-<shot>-<preset|class|hdr-off>.png` from the look row). The
//! final comparison row writes `<column>-<shot>-<high|ultra>.png` into `captures/final`. The scene
//! draws the fetched CC0 textures where the asset cache holds them (`GENEX_SHOWCASE_FETCHED=0`
//! draws its procedural fallback); the Studio-path digests keep a row for each.
#![allow(clippy::disallowed_types, reason = "the frame-time row reads the wall clock; the simulation never does")]

mod support;

use std::time::Instant;

use genex::{FIXED_STEP_MS, Runtime, View};
use genex_platform_web::{MeshCache, to_scene};
use genex_render::capture::Capture;
use genex_render::custom_pass::{CustomPasses, render_scene};
use genex_render::{CullPath, Gpu, Renderer};
use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
use genex_render::settings::QualityPreset;
use showcase_game::assets;
use showcase_game::world::{SHOTS, World};
use support::{SHOT_TICK, gpu, lakeside_at, lakeside_at_shot_tick, out_dir, percentile, write_png};

/// Low and high may differ in detail, never in look: mean luminance within this share of high's,
/// and the mean colour's hue within this many degrees.
const LOOK_LUMINANCE_SHARE: f64 = 0.06;
const LOOK_HUE_DEGREES: f64 = 4.0;

/// Frames the timing row warms up with, then measures.
const WARM_FRAMES: u32 = 10;
const TIMED_FRAMES: u32 = 120;

/// The lakeside's renderer, passes and meshes drawing one runtime's frames the way the studio
/// does: every stage of the passes runs, `post-hdr` (the grade) included.
struct Stage {
    renderer: Renderer,
    passes: CustomPasses,
    meshes: MeshCache,
}

impl Stage {
    fn new(gpu: &Gpu, runtime: &mut Runtime<World>) -> Stage {
        let [width, height] = runtime.world_size();
        let renderer = Renderer::new(gpu, width, height).expect("renderer");
        let mut passes = CustomPasses::new(gpu, &renderer, wgpu::Features::empty());
        let refusals = genex::gpu::host::install(runtime, &mut passes, gpu);
        assert!(refusals.is_empty(), "{refusals:?}");
        Stage { renderer, passes, meshes: MeshCache::default() }
    }

    fn draw(&mut self, gpu: &Gpu, runtime: &mut Runtime<World>, view: View<'_>) {
        let camera = runtime.camera(view).expect("camera");
        let frame = runtime.frame(view).expect("frame");
        let Stage { renderer, passes, meshes } = self;
        meshes.load(&frame, assets(), |mesh| renderer.add_mesh(gpu, mesh));
        let scene = to_scene(&frame, &camera, meshes);
        genex::gpu::host::with_passes(runtime, |list, tick| {
            let mut run = passes.frame(gpu, list, tick)?;
            render_scene(renderer, gpu, &scene, CullPath::Gpu, &mut run)
        })
        .expect("frame");
        assert!(passes.refusals().is_empty(), "{:?}", passes.refusals());
    }
}

fn shot(gpu: &Gpu, name: &str) -> Capture {
    let mut runtime = lakeside_at_shot_tick();
    let mut stage = Stage::new(gpu, &mut runtime);
    stage.draw(gpu, &mut runtime, View::Named(name));
    stage.renderer.capture(gpu).expect("capture")
}

/// A capture's mean linear colour (sRGB-decoded), the luminance of it and its hue in degrees.
fn mean_look(capture: &Capture) -> (f64, f64) {
    let decode = |c: u8| {
        let c = f64::from(c) / 255.0;
        if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
    };
    let mut sum = [0.0f64; 3];
    for pixel in capture.bgra().chunks(4) {
        for (channel, value) in [pixel[2], pixel[1], pixel[0]].into_iter().enumerate() {
            sum[channel] += decode(value);
        }
    }
    let count = (capture.bgra().len() / 4) as f64;
    let [r, g, b] = sum.map(|channel| channel / count);
    let luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    let hue = (3f64.sqrt() * (g - b)).atan2(2.0 * r - g - b).to_degrees();
    (luminance, hue)
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_no_showcase_pass_keeps_the_frame_on_the_ldr_scene() {
    let Some(gpu) = gpu() else { return };
    let mut runtime = lakeside_at_shot_tick();
    let renderer = genex_render::Renderer::new(&gpu, 64, 64).expect("renderer");
    let mut passes = CustomPasses::new(&gpu, &renderer, wgpu::Features::empty());
    assert!(genex::gpu::host::install(&mut runtime, &mut passes, &gpu).is_empty(), "every v2 pass is admitted");
    assert_eq!(passes.ldr_reason(), None, "no v1 pass draws in the world: degraded names no LDR reason");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_every_shot_renders_the_same_picture_twice_and_is_written_as_a_png() {
    let Some(gpu) = gpu() else { return };
    let dir = out_dir();
    let mut digests = Vec::new();
    for s in SHOTS {
        let capture = shot(&gpu, s.name);
        let again = shot(&gpu, s.name);
        assert_eq!(again.digest(), capture.digest(), "{}: two renders of one tick differ", s.name);
        write_png(&dir.join(format!("showcase-{}.png", s.name)), &capture);
        digests.push(format!("\"{}\": \"{:016x}\"", s.name, capture.digest()));
    }
    let record = format!("{{\"adapter\": {:?}, \"tick\": {SHOT_TICK}, \"digests\": {{{}}}}}\n", gpu.receipt().adapter, digests.join(", "));
    std::fs::write(dir.join("showcase-digests.json"), &record).expect("digests");
    println!("{record}");
}

/// Evidence: the wide shot at every dynamic-resolution step any class runs (desktop-low's table spans
/// them: 0.5 to 1), each rendered twice to one digest and written as `drs-wide-<scale>.png`.
/// How a Studio capture is drawn: with the game's own choices, at a `renderSettings` preset on
/// the reference class (desktop-high), emulating a device class, or with the HDR switch off (the
/// legacy LDR scene: the look reference).
#[derive(Clone, Copy, Debug)]
enum DrawnAs {
    Game,
    Preset(QualityPreset),
    Class(DeviceClass),
    HdrOff,
    /// A preset with the render scale locked at a step (the verb's lock reaches captures): FSR1's
    /// EASU and RCAS below scale 1.
    Locked(QualityPreset, f32),
}

impl DrawnAs {
    /// The `renderSettings {set}` change that draws it (None: the game's own choices).
    fn change(self) -> Option<genex::render::RenderChange> {
        use genex::render::{PresetChoice, RenderChange, RenderFeature};
        match self {
            DrawnAs::Game => None,
            DrawnAs::Preset(preset) => Some(RenderChange { preset: Some(Some(PresetChoice::Preset(preset))), ..RenderChange::default() }),
            DrawnAs::Class(class) => Some(RenderChange { device_class: Some(Some(class)), ..RenderChange::default() }),
            DrawnAs::HdrOff => Some(RenderChange { features: vec![(RenderFeature::Hdr, false)], ..RenderChange::default() }),
            DrawnAs::Locked(preset, scale) => {
                Some(RenderChange { preset: Some(Some(PresetChoice::Preset(preset))), render_scale_lock: Some(Some(scale)), ..RenderChange::default() })
            }
        }
    }

    /// Its file-name suffix.
    fn label(self) -> String {
        match self {
            DrawnAs::Game => String::from("game"),
            DrawnAs::Preset(preset) => String::from(preset.wire()),
            DrawnAs::Class(class) => class.wire(),
            DrawnAs::HdrOff => String::from("hdr-off"),
            DrawnAs::Locked(preset, scale) => format!("{}-{scale:.2}", preset.wire()),
        }
    }
}

/// `name` at tick 600 captured the way the Studio captures it: genex's presenter on its own device
/// with the game's render settings (the pinned capture profile, a settled capture).
fn studio_shot(name: &str) -> Option<(Capture, genex_render::renderer::ScenePath)> {
    studio_shot_as(name, DrawnAs::Game)
}

/// [`studio_shot`] drawn `drawn_as`: the change applies as the `renderSettings` verb applies it,
/// after a first capture attaches the game's settings.
fn studio_shot_as(name: &str, drawn_as: DrawnAs) -> Option<(Capture, genex_render::renderer::ScenePath)> {
    use genex::present::Presenter;
    let mut presenter = Presenter::open(showcase_game::showcase::WORLD_SIZE, showcase_game::assets()).ok()?;
    let mut runtime = lakeside_at_shot_tick();
    let refused = presenter.install_for(&mut runtime);
    assert!(refused.is_empty(), "{refused:?}");
    presenter.set_capturing(true);
    presenter.draw_view(&mut runtime, View::Named(name)).expect("a view").expect("drawn");
    if let Some(change) = drawn_as.change() {
        presenter.render_settings().expect("the game's settings attached").borrow_mut().apply(&change);
        presenter.draw_view(&mut runtime, View::Named(name)).expect("a view").expect("drawn");
    }
    let stopped = presenter.take_pass_refusals();
    assert!(stopped.is_empty(), "{name}: every pass draws on the HDR scene: {stopped:?}");
    // The terrain material (Level 2) is admitted: a refused one draws the checker.
    let extensions = runtime.state()["volatile"]["extensions"].clone();
    let refused: Vec<&genex::Value> = extensions.as_array().into_iter().flatten().filter(|row| !row["code"].is_null()).collect();
    assert!(refused.is_empty(), "{name}: every Level-2 source is admitted: {refused:?}");
    let path = presenter.resilient.renderer().renderer().last_scene().expect("a frame");
    Some((presenter.resilient.capture().expect("capture"), path))
}

/// What a picture looks like, in numbers: mean linear luminance, the mean colour's hue in degrees,
/// mean chroma of the encoded pixels (BT.709 `sqrt(U² + V²)` in 8-bit levels, as ffmpeg's
/// `signalstats` SATAVG) and the spread of encoded luma from the 10th to the 90th percentile (mid
/// contrast).
#[derive(Clone, Copy, Debug)]
struct LookStats {
    luminance: f64,
    hue: f64,
    chroma: f64,
    spread: f64,
}

impl LookStats {
    fn of(capture: &Capture) -> LookStats {
        let (luminance, hue) = mean_look(capture);
        let mut lumas = Vec::new();
        let mut chroma = 0.0;
        for pixel in capture.bgra().chunks(4) {
            let [r, g, b] = [pixel[2], pixel[1], pixel[0]].map(f64::from);
            let (u, v) = (-0.1146 * r - 0.3854 * g + 0.5 * b, 0.5 * r - 0.4542 * g - 0.0458 * b);
            chroma += u.hypot(v);
            lumas.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
        }
        lumas.sort_by(f64::total_cmp);
        let count = lumas.len() as f64;
        LookStats { luminance, hue, chroma: chroma / count, spread: percentile(&lumas, 0.9) - percentile(&lumas, 0.1) }
    }
}

/// How far a Studio capture's look may move from the LDR reference (the HDR path with the game's
/// curve and auto exposure against the clamped legacy scene): colour (chroma) and mid contrast stay;
/// plain AgX failed here (chroma 65-92%, contrast 56-85% of the reference). The LDR scene draws no
/// sky and no environment light, so its mean and hue are no reference for a scene lit by the
/// physical sky (RQ2 review: the luminance and hue checks against it were dropped).
const HDR_CHROMA_SHARE: f64 = 0.9;
const HDR_SPREAD_SHARE: f64 = 0.75;

/// The lakeside's art as remastered for the renderer (photoreal golden hour: AgX, the physical sky
/// with clouds, the PBR terrain and trees; Studio captures at `high` on the M4 Max with the fetched
/// textures): per shot, mean linear luminance and mid contrast (`LookStats`). Its procedural
/// fallback draws within these checks too (luminance within 2%, contrast within 4% of it). Before
/// the remaster this held the painted-sky art of RQ2.5, which the remaster replaced on purpose.
/// Re-recorded at the pass-1 gate's round 2: the fog's sun lobe, the particles' fog and the clouds
/// no longer redden the sun a second time (it reaches them already through the atmosphere) and the
/// grass takes the sun's shadows, so the haze is less orange (chroma 4-10% lower, hue 1-2.5 degrees
/// yellower) and the wide shot's sunlit meadow has more shade in it (contrast 6% lower).
/// Re-recorded at the gate's round 4: the lakeside's AO at 0.1 (owner decision 2026-10-12 (a))
/// lifts the shaded cabin walls and the trunks' and rocks' feet, so mid contrast is 1-5% lower
/// (cabin 118.4 -> 112.7) and the means and colours move by under 1%.
const ART_REFERENCE: [(&str, f64, f64); 5] =
    [("wide", 0.2159, 99.59), ("dock", 0.2241, 112.83), ("cabin", 0.2217, 112.72), ("forest", 0.2464, 144.51), ("closeup", 0.2288, 130.98)];
/// Mid contrast kept against [`ART_REFERENCE`], and the mean within this many EV of it.
const ART_SPREAD_SHARE: f64 = 0.9;
const ART_LUMINANCE_EV: f64 = 0.5;
/// The lakeside's golden-hour colour as remastered: per shot, mean chroma and the mean colour's hue
/// (`LookStats`) of the Studio captures at `high` (as [`ART_REFERENCE`]). A stored reference, so a
/// commit that changes the look cannot loosen it the way the LDR reference (a capture of the same
/// build) did: RX.3 lost 10-19% of the chroma on dock, forest and closeup and moved cabin's hue 8
/// degrees with every check green.
/// Re-recorded with [`ART_REFERENCE`] at the pass-1 gate's rounds 2 and 4.
const ART_COLOUR: [(&str, f64, f64); 5] =
    [("wide", 23.97, 34.8), ("dock", 24.05, 27.1), ("cabin", 22.29, 33.9), ("forest", 27.40, 29.1), ("closeup", 22.75, 35.2)];
/// Chroma kept against [`ART_COLOUR`], and the hue within this many degrees of it.
const ART_CHROMA_SHARE: f64 = 0.9;
const ART_HUE_DEGREES: f64 = 6.0;
/// Where the wide shot's far meadow edge meets the haze (RX review: the grass, fogged by its pass
/// with the SH9 irradiance where the terrain's fog reads the horizon's radiance, showed 432 olive
/// specks here at high; 20-34 at every preset before RX.3), and the luma (0..255) a speck stands out
/// from the patch's median by. Recorded per capture in studio-looks.json, not judged: with the fog's
/// in-scatter matched, the specks left are far blades darker than the ground under them (none at
/// low's distance is fully fogged), which no fog read can tell from a fog mismatch.
const MEADOW_EDGE: (std::ops::Range<u32>, std::ops::Range<u32>) = (1000..1160, 310..370);
const SPECK_LUMA: f64 = 40.0;

/// Pixels of `capture` inside [`MEADOW_EDGE`] whose luma stands [`SPECK_LUMA`] or more from the
/// patch's median: grass blades fogged unlike the terrain behind them.
fn meadow_edge_specks(capture: &Capture) -> usize {
    let width = capture.width();
    let (xs, ys) = MEADOW_EDGE;
    let luma: Vec<f64> = ys
        .flat_map(|y| xs.clone().map(move |x| (x, y)))
        .map(|(x, y)| {
            let i = ((y * width + x) * 4) as usize;
            let p = &capture.bgra()[i..i + 4];
            0.2126 * f64::from(p[2]) + 0.7152 * f64::from(p[1]) + 0.0722 * f64::from(p[0])
        })
        .collect();
    let mut sorted = luma.clone();
    sorted.sort_by(f64::total_cmp);
    let median = percentile(&sorted, 0.5);
    luma.iter().filter(|value| (*value - median).abs() >= SPECK_LUMA).count()
}
/// desktop-high's lowest dynamic-resolution step (its table's first, checked in the look row).
const DESKTOP_HIGH_LOWEST_STEP: f32 = 0.67;
/// The most high-frequency energy ([`grain`]) ultra and the upscaled steps may add over high's
/// TAA on one shot (RQ5 review: ultra's RCAS at 0.2 stops with no noise detection measured +20% to
/// +95% over its pre-TAA picture, a visible salt-and-pepper grain on foliage, haze and water).
const GRAIN_SHARE_MAX: f64 = 1.25;
/// The Gaussian a picture is blurred with before its high-frequency energy is read, in pixels.
const GRAIN_SIGMA_PX: f64 = 1.5;

/// High-frequency energy of `capture`: the mean absolute difference, in 8-bit levels, between each
/// pixel's encoded luma and its Gaussian blur (sigma [`GRAIN_SIGMA_PX`]): grain and sharpening raise
/// it, smoothing lowers it.
fn grain(capture: &Capture) -> f64 {
    let (w, h) = (capture.width() as usize, capture.height() as usize);
    let luma: Vec<f64> = capture.bgra().chunks(4).map(|p| 0.2126 * f64::from(p[2]) + 0.7152 * f64::from(p[1]) + 0.0722 * f64::from(p[0])).collect();
    let radius = (GRAIN_SIGMA_PX * 3.0).ceil() as isize;
    let weights: Vec<f64> = (-radius..=radius).map(|d| (-(d * d) as f64 / (2.0 * GRAIN_SIGMA_PX * GRAIN_SIGMA_PX)).exp()).collect();
    let total: f64 = weights.iter().sum();
    let blur = |source: &[f64], horizontal: bool| -> Vec<f64> {
        (0..h * w)
            .map(|at| {
                let (x, y) = ((at % w) as isize, (at / w) as isize);
                let tap = |d: isize| {
                    let (sx, sy) = if horizontal { ((x + d).clamp(0, w as isize - 1), y) } else { (x, (y + d).clamp(0, h as isize - 1)) };
                    source[sy as usize * w + sx as usize]
                };
                (-radius..=radius).zip(&weights).map(|(d, weight)| tap(d) * weight).sum::<f64>() / total
            })
            .collect()
    };
    let blurred = blur(&blur(&luma, true), false);
    luma.iter().zip(&blurred).map(|(a, b)| (a - b).abs()).sum::<f64>() / luma.len() as f64
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_studio_captures_keep_the_look_at_every_preset_and_phone_class() {
    if gpu().is_none() {
        return;
    }
    let dir = out_dir();
    // RQ5 review: mobile-high (a typical iPhone's class: medium at 0.75 with FSR1) and desktop-high's
    // high at its lowest dynamic-resolution step (TAA, then EASU and RCAS) are looked at too.
    let classes = [
        DeviceClass::new(FormFactor::Mobile, PerformanceTier::High),
        DeviceClass::new(FormFactor::Mobile, PerformanceTier::Mid),
        DeviceClass::new(FormFactor::Mobile, PerformanceTier::Low),
    ];
    let presets = [QualityPreset::Low, QualityPreset::Medium, QualityPreset::High, QualityPreset::Ultra];
    let mut rows = Vec::new();
    let mut failures = Vec::new();
    for s in SHOTS {
        let Some((reference, ldr)) = studio_shot_as(s.name, DrawnAs::HdrOff) else { return };
        assert!(!ldr.hdr, "{}: the reference is the legacy LDR scene", s.name);
        write_png(&dir.join(format!("studio-{}-hdr-off.png", s.name)), &reference);
        let base = LookStats::of(&reference);
        let &(_, art_luminance, art_spread) = ART_REFERENCE.iter().find(|(shot, _, _)| *shot == s.name).expect("every shot has an art reference");
        let &(_, art_chroma, art_hue) = ART_COLOUR.iter().find(|(shot, _, _)| *shot == s.name).expect("every shot has an art colour");
        let (high, _) = studio_shot_as(s.name, DrawnAs::Preset(QualityPreset::High)).expect("a presenter");
        let high_look = LookStats::of(&high);
        let high_grain = grain(&high);
        let drawn = presets.map(DrawnAs::Preset).into_iter().chain(classes.map(DrawnAs::Class)).chain([DrawnAs::Locked(QualityPreset::High, DESKTOP_HIGH_LOWEST_STEP)]);
        for drawn_as in drawn {
            let (capture, path) = studio_shot_as(s.name, drawn_as).expect("a presenter");
            assert!(path.hdr, "{} {drawn_as:?}: the HDR scene: {path:?}", s.name);
            write_png(&dir.join(format!("studio-{}-{}.png", s.name, drawn_as.label())), &capture);
            let look = LookStats::of(&capture);
            let grain = grain(&capture);
            let specks = if s.name == "wide" { meadow_edge_specks(&capture).to_string() } else { String::from("null") };
            rows.push(format!(
                "{{\"shot\": \"{}\", \"as\": \"{}\", \"look\": \"{look:?}\", \"grain\": {grain:.3}, \"meadowSpecks\": {specks}, \"ldr\": \"{base:?}\"}}",
                s.name,
                drawn_as.label()
            ));
            let at = format!("{} {}", s.name, drawn_as.label());
            // Against the LDR reference: colour and mid contrast kept; against the art before the
            // physical sky: contrast and exposure kept; against high: presets and classes differ in
            // detail, never in look.
            let checks = [
                (look.chroma >= base.chroma * HDR_CHROMA_SHARE, "chroma against LDR"),
                (look.spread >= base.spread * HDR_SPREAD_SHARE, "mid contrast against LDR"),
                (look.spread >= art_spread * ART_SPREAD_SHARE, "mid contrast against the art"),
                ((look.luminance / art_luminance).log2().abs() <= ART_LUMINANCE_EV, "luminance against the art"),
                (look.chroma >= art_chroma * ART_CHROMA_SHARE, "chroma against the art"),
                ((look.hue - art_hue).abs() <= ART_HUE_DEGREES, "hue against the art"),
                ((look.luminance - high_look.luminance).abs() <= high_look.luminance * LOOK_LUMINANCE_SHARE, "luminance against high"),
                ((look.hue - high_look.hue).abs() <= LOOK_HUE_DEGREES, "hue against high"),
            ];
            for (_, what) in checks.iter().filter(|(held, _)| !held) {
                failures.push(format!("{at}: {what}: {look:?}, LDR {base:?}, high {high_look:?}"));
            }
            // TAA's own sharpen and the upscale against high's TAA: no grain added.
            let sharpened = matches!(drawn_as, DrawnAs::Preset(QualityPreset::Ultra) | DrawnAs::Locked(..));
            if sharpened && grain > high_grain * GRAIN_SHARE_MAX {
                failures.push(format!("{at}: grain {grain:.3} against high's {high_grain:.3}"));
            }
        }
    }
    std::fs::write(dir.join("studio-looks.json"), format!("[{}]\n", rows.join(",\n"))).expect("looks");
    assert!(failures.is_empty(), "{} look checks failed:\n{}", failures.len(), failures.join("\n"));
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_every_studio_capture_draws_the_hdr_look_the_same_twice() {
    use genex_render::settings::Tonemapper;
    if gpu().is_none() {
        return;
    }
    let dir = out_dir();
    let mut digests = Vec::new();
    for s in SHOTS {
        let Some((capture, path)) = studio_shot(s.name) else { return };
        let (again, _) = studio_shot(s.name).expect("a second presenter");
        assert!(path.hdr && path.depth_reversed, "{}: the Studio draws the HDR scene: {path:?}", s.name);
        assert_eq!(path.tonemapper, Tonemapper::AgxPunchy, "{}: the showcase's look", s.name);
        if again.digest() != capture.digest() {
            // Both pictures, so the difference can be looked at (RX.R2).
            write_png(&dir.join(format!("studio-{}-first.png", s.name)), &capture);
            write_png(&dir.join(format!("studio-{}-second.png", s.name)), &again);
        }
        assert_eq!(again.digest(), capture.digest(), "{}: two settled captures of one tick differ", s.name);
        write_png(&dir.join(format!("studio-{}.png", s.name)), &capture);
        digests.push((s.name, format!("{:016x}", capture.digest())));
    }
    let listed: Vec<String> = digests.iter().map(|(name, digest)| format!("\"{name}\": \"{digest}\"")).collect();
    let record = format!("{{\"tick\": {SHOT_TICK}, \"path\": \"presenter capture\", \"digests\": {{{}}}}}\n", listed.join(", "));
    std::fs::write(dir.join("studio-digests.json"), &record).expect("digests");
    println!("{record}");
    check_studio_digests(&digests);
}

/// The committed per-adapter digests of the Studio-path shots: every change to the picture every
/// facade game draws is a visible, named golden update (`GENEX_RENDER_GOLDEN_UPDATE=1` rewrites
/// this adapter's row). An adapter with no row is reported and skipped.
fn check_studio_digests(digests: &[(&str, String)]) {
    let Some(adapter) = gpu().map(|gpu| gpu.receipt().adapter.clone()) else { return };
    // The scene draws its fetched CC0 textures where the asset cache holds them and its procedural
    // stand-ins where it does not: each is its own picture, with its own row.
    let fetched = showcase_game::assets().iter().any(|(name, _)| name.starts_with("fetched/"));
    let adapter = format!("{adapter} ({})", if fetched { "fetched" } else { "procedural" });
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/render-goldens/showcase/studio-digests.json");
    let read = std::fs::read_to_string(&path).ok().and_then(|text| text.parse::<genex::Value>().ok());
    let mut golden = read.unwrap_or_else(|| genex::json!({}));
    let mut shots = genex::json!({});
    for (name, digest) in digests {
        shots[*name] = genex::json!(digest);
    }
    if std::env::var("GENEX_RENDER_GOLDEN_UPDATE").is_ok_and(|v| v == "1") {
        golden[&adapter] = shots;
        std::fs::create_dir_all(path.parent().expect("a folder")).expect("goldens folder");
        std::fs::write(&path, format!("{golden:#}\n")).expect("golden written");
        return;
    }
    match golden.get(&adapter) {
        Some(expected) => assert_eq!(expected, &shots, "the Studio-path digests on {adapter} changed: name them and rewrite with GENEX_RENDER_GOLDEN_UPDATE=1"),
        None => eprintln!("skipped: no committed Studio-path digests for {adapter}"),
    }
}


#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_wide_shot_at_each_dynamic_resolution_step_is_written_as_a_png() {
    let Some(gpu) = gpu() else { return };
    let dir = out_dir();
    let class = genex::render::DeviceClass::new(genex::render::FormFactor::Desktop, genex::render::PerformanceTier::Low);
    let steps = genex_render::drs::ScaleSteps::table(genex_render::presets::class_defaults(class).drs_steps, 1.0);
    let mut digests = Vec::new();
    for scale in steps.steps() {
        let render = || {
            let mut runtime = lakeside_at_shot_tick();
            let mut stage = Stage::new(&gpu, &mut runtime);
            stage.renderer.set_render_scale(*scale);
            stage.draw(&gpu, &mut runtime, View::Named("wide"));
            stage.renderer.capture(&gpu).expect("capture")
        };
        let (capture, again) = (render(), render());
        assert_eq!(again.digest(), capture.digest(), "scale {scale}: two renders of one tick differ");
        write_png(&dir.join(format!("drs-wide-{scale:.5}.png")), &capture);
        digests.push(format!("\"{scale:.5}\": \"{:016x}\"", capture.digest()));
    }
    let record = format!("{{\"adapter\": {:?}, \"shot\": \"wide\", \"digests\": {{{}}}}}\n", gpu.receipt().adapter, digests.join(", "));
    std::fs::write(dir.join("drs-wide-digests.json"), &record).expect("digests");
    println!("{record}");
}

// RQ5 review: the legacy DRS row draws through the renderer-core `Stage` (no FSR1): its pictures
// were byte-identical before and after RQ5.6. This row takes desktop-high's steps through the
// presenter at the high preset, so TAA, then EASU and RCAS, draw on the lakeside.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_wide_shot_at_each_desktop_high_step_draws_fsr1_through_the_presenter() {
    if gpu().is_none() {
        return;
    }
    let dir = out_dir();
    let class = DeviceClass::new(FormFactor::Desktop, PerformanceTier::High);
    let steps = genex_render::presets::class_defaults(class).drs_steps;
    assert_eq!(steps[0], DESKTOP_HIGH_LOWEST_STEP, "the look row's lowest step is desktop-high's");
    let mut rows = Vec::new();
    for scale in steps {
        let (capture, path) = studio_shot_as("wide", DrawnAs::Locked(QualityPreset::High, *scale)).expect("a presenter");
        assert!(path.taa, "{scale}: high resolves TAA: {path:?}");
        assert_eq!(path.fsr.easu, *scale < 1.0, "{scale}: EASU runs below scale 1: {path:?}");
        write_png(&dir.join(format!("drs-wide-fsr-{scale:.2}.png")), &capture);
        rows.push(format!("{{\"scale\": {scale}, \"digest\": \"{:016x}\", \"grain\": {:.3}}}", capture.digest(), grain(&capture)));
    }
    let record = format!("{{\"shot\": \"wide\", \"preset\": \"high\", \"rows\": [{}]}}\n", rows.join(", "));
    std::fs::write(dir.join("drs-wide-fsr.json"), &record).expect("record");
    println!("{record}");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_frame_time_per_shot() {
    let Some(gpu) = gpu() else { return };
    let mut rows = Vec::new();
    for s in SHOTS {
        let mut runtime = lakeside_at_shot_tick();
        let mut stage = Stage::new(&gpu, &mut runtime);
        let mut times = Vec::new();
        for frame in 0..WARM_FRAMES + TIMED_FRAMES {
            runtime.step(FIXED_STEP_MS);
            let start = Instant::now();
            stage.draw(&gpu, &mut runtime, View::Named(s.name));
            gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("the frame finished");
            if frame >= WARM_FRAMES {
                times.push(start.elapsed().as_secs_f64() * 1000.0);
            }
        }
        times.sort_by(f64::total_cmp);
        rows.push(format!(
            "{{\"shot\": \"{}\", \"frames\": {TIMED_FRAMES}, \"p50Ms\": {:.3}, \"p95Ms\": {:.3}}}",
            s.name,
            percentile(&times, 0.5),
            percentile(&times, 0.95)
        ));
    }
    let [width, height] = showcase_game::showcase::WORLD_SIZE;
    let record = format!(
        "{{\"adapter\": {:?}, \"size\": [{width}, {height}], \"measures\": \"CPU frame build + submit + GPU completion (device poll), release build, MSAA 4x, no HUD\", \"rows\": [{}]}}\n",
        gpu.receipt().adapter,
        rows.join(", ")
    );
    std::fs::write(out_dir().join("showcase-perf.json"), &record).expect("perf");
    println!("{record}");
}

/// Live ticks drawn before the Live picture is compared with a settled capture.
const LIVE_TICKS: u32 = 24;
/// The largest mean difference (8-bit levels) between the Live picture and the settled capture:
/// edge noise and auto exposure's Live adaptation (measured 2.7 to 4.2 on the M4 Max).
const MEAN_LEVELS_MAX: f64 = 6.0;
/// The largest 25th-percentile difference of any 8 x 8 tile (measured 13 to 20 on the M4 Max, in
/// the grass a Level-3 pass sways): a trail fills its tiles far above it.
const TILE_QUARTILE_LEVELS_MAX: u8 = 32;

/// RQ5.6: Live frames under TAA keep the moving deer, the walking fisher and the swaying grass
/// without trails. Live is pinned to the reference class (high, TAA), as captures draw, and runs
/// [`LIVE_TICKS`] ticks up to the shot's; its last picture is then within a few levels of a settled
/// capture of that tick (one state re-rendered over a jitter cycle: nothing moves across its
/// history), and no blob of pixels departs from it as a trail would.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_live_taa_frames_leave_no_trails_against_a_settled_capture() {
    use genex::present::Presenter;
    use genex::render::RenderChange;
    if gpu().is_none() {
        return;
    }
    let dir = out_dir();
    let mut rows = Vec::new();
    let mut failures = Vec::new();
    for name in ["forest", "closeup", "wide"] {
        let Ok(mut presenter) = Presenter::open(showcase_game::showcase::WORLD_SIZE, showcase_game::assets()) else { return };
        let mut runtime = lakeside_at(SHOT_TICK - LIVE_TICKS);
        assert!(presenter.install_for(&mut runtime).is_empty());
        presenter.draw_view(&mut runtime, View::Named(name)).expect("a view").expect("drawn");
        let reference_class = DeviceClass::new(FormFactor::Desktop, PerformanceTier::High);
        let change = RenderChange { device_class: Some(Some(reference_class)), ..RenderChange::default() };
        presenter.render_settings().expect("the game's settings attached").borrow_mut().apply(&change);
        for _ in 0..LIVE_TICKS {
            runtime.step(FIXED_STEP_MS);
            presenter.draw_view(&mut runtime, View::Named(name)).expect("a view").expect("drawn");
        }
        let path = presenter.resilient.renderer().renderer().last_scene().expect("a frame");
        assert!(path.taa, "{name}: Live draws TAA on the reference class: {path:?}");
        let live = presenter.resilient.capture().expect("the Live picture");
        presenter.set_capturing(true);
        presenter.draw_view(&mut runtime, View::Named(name)).expect("a view").expect("drawn");
        let settled = presenter.resilient.capture().expect("the settled capture");
        write_png(&dir.join(format!("taa-live-{name}.png")), &live);
        write_png(&dir.join(format!("taa-settled-{name}.png")), &settled);
        let diffs: Vec<u8> = live.bgra().as_chunks::<4>().0.iter().zip(settled.bgra().as_chunks::<4>().0).map(|(a, b)| (0..3).map(|lane| a[lane].abs_diff(b[lane])).max().unwrap_or(0)).collect();
        let mean = diffs.iter().map(|d| f64::from(*d)).sum::<f64>() / diffs.len() as f64;
        let (w, h) = (live.width() as usize, live.height() as usize);
        // A trail is a filled blob: a tile most of whose pixels depart from the settled picture.
        // Edges differ sparsely (Live's longer history against the capture's one jitter cycle, the
        // grass a Level-3 pass sways with no motion of its own), so each 8 x 8 tile is read at its
        // 25th-percentile difference: a trail lifts it, a few edge pixels do not.
        let tile_quartile = |(tx, ty): (usize, usize)| {
            let mut tile: Vec<u8> = (0..8).flat_map(|y| (0..8).map(move |x| (x, y))).map(|(x, y)| diffs[(ty * 8 + y) * w + tx * 8 + x]).collect();
            tile.sort_unstable();
            tile[16]
        };
        let worst_tile = (0..h / 8).flat_map(|ty| (0..w / 8).map(move |tx| (tx, ty))).map(tile_quartile).max().unwrap_or(0);
        rows.push(format!("{{\"shot\": \"{name}\", \"meanLevels\": {mean:.3}, \"worstTileQuartileLevels\": {worst_tile}}}"));
        if mean > MEAN_LEVELS_MAX || worst_tile > TILE_QUARTILE_LEVELS_MAX {
            failures.push(format!("{name}: mean {mean:.2} levels, worst 8x8 tile's quartile {worst_tile}"));
        }
    }
    let record = format!("{{\"liveTicks\": {LIVE_TICKS}, \"rows\": [{}]}}\n", rows.join(", "));
    std::fs::write(dir.join("taa-live-vs-settled.json"), &record).expect("record");
    println!("{record}");
    assert!(failures.is_empty(), "Live TAA departs from the settled picture: {failures:?}");
}

/// The renderer follow-up's final comparison: every named shot as the Studio captures it at `high`
/// and `ultra`, written as `<column>-<shot>-<preset>.png` into `captures/final` (or
/// `GENEX_SHOWCASE_OUT`). `GENEX_SHOWCASE_COLUMN` names the column (`B`: the scene before its
/// remaster on the new renderer; `C`: the remastered scene); each capture is taken twice and must
/// draw one picture.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_final_column_shots_at_high_and_ultra() {
    if gpu().is_none() {
        return;
    }
    let column = std::env::var("GENEX_SHOWCASE_COLUMN").unwrap_or_else(|_| String::from("C"));
    let dir = std::env::var_os("GENEX_SHOWCASE_OUT").map_or_else(|| support::evidence_dir("captures/final"), std::path::PathBuf::from);
    std::fs::create_dir_all(&dir).expect("the final captures folder");
    let presets: Vec<QualityPreset> = match std::env::var("GENEX_SHOWCASE_PRESETS") {
        Ok(list) => list.split(',').map(|wire| match wire.trim() {
            "low" => QualityPreset::Low,
            "medium" => QualityPreset::Medium,
            "ultra" => QualityPreset::Ultra,
            _ => QualityPreset::High,
        }).collect(),
        Err(_) => vec![QualityPreset::High, QualityPreset::Ultra],
    };
    let shots: Vec<String> = std::env::var("GENEX_SHOWCASE_SHOTS").map_or_else(|_| SHOTS.iter().map(|s| String::from(s.name)).collect(), |list| list.split(',').map(String::from).collect());
    let mut rows = Vec::new();
    for name in &shots {
        for preset in &presets {
            let (capture, path) = studio_shot_as(name, DrawnAs::Preset(*preset)).expect("a presenter");
            assert!(path.hdr, "{name} {}: the HDR scene: {path:?}", preset.wire());
            write_png(&dir.join(format!("{column}-{name}-{}.png", preset.wire())), &capture);
            let look = LookStats::of(&capture);
            rows.push(format!("{{\"shot\": \"{name}\", \"preset\": \"{}\", \"digest\": \"{:016x}\", \"look\": \"{look:?}\", \"grain\": {:.3}}}", preset.wire(), capture.digest(), grain(&capture)));
        }
    }
    let scene = showcase_game::world::scene_probe();
    let record = format!("{{\"column\": \"{column}\", \"tick\": {SHOT_TICK}, \"scene\": {scene}, \"rows\": [{}]}}\n", rows.join(",\n"));
    std::fs::write(dir.join(format!("{column}-looks.json")), &record).expect("looks");
    println!("{record}");
}

/// The cabin shot's chimney smoke: the columns it rises through and the rows read (below the top
/// edge, beside the HUD card), and how far either side of a pixel the sky beside it is read.
const SMOKE_COLUMNS: std::ops::Range<u32> = 490..580;
const SMOKE_ROWS: [u32; 4] = [20, 40, 60, 100];
const SKY_BESIDE_PX: u32 = 45;
/// The most a smoke pixel may stand over the brighter of the sky either side of it on its row, in
/// luma levels. Smoke lit by the sky and the low sun sits in the sky's light: a thin wisp over a
/// deep-blue patch reads a little lighter than it (about 16 levels here), never as a light source
/// (gate finding 09: a white beam 53 levels over the sky at medium, high and ultra).
const SMOKE_OVER_SKY_MAX: f64 = 20.0;

/// The luma (0..255) of `capture` at (x, y).
fn luma_at(capture: &Capture, x: u32, y: u32) -> f64 {
    let i = ((y * capture.width() + x) * 4) as usize;
    let p = &capture.bgra()[i..i + 4];
    0.2126 * f64::from(p[2]) + 0.7152 * f64::from(p[1]) + 0.0722 * f64::from(p[0])
}

/// How far the smoke stands over the brighter of the sky beside it, worst pixel.
fn smoke_over_sky(capture: &Capture) -> f64 {
    let mut worst = f64::MIN;
    for y in SMOKE_ROWS {
        for x in SMOKE_COLUMNS {
            let beside = luma_at(capture, x - SKY_BESIDE_PX, y).max(luma_at(capture, x + SKY_BESIDE_PX, y));
            worst = worst.max(luma_at(capture, x, y) - beside);
        }
    }
    worst
}

/// Gate finding 09: the chimney smoke drew as an opaque, hard-edged white beam that read as a
/// spotlight. At every HDR preset the smoke stays about as bright as the sky it rises into.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_chimney_smoke_is_no_brighter_than_the_sky_it_rises_into() {
    if gpu().is_none() {
        return;
    }
    let dir = out_dir();
    let mut problems = Vec::new();
    for preset in [QualityPreset::Medium, QualityPreset::High, QualityPreset::Ultra] {
        let Some((capture, _)) = studio_shot_as("cabin", DrawnAs::Preset(preset)) else { return };
        write_png(&dir.join(format!("smoke-cabin-{}.png", preset.wire())), &capture);
        let over = smoke_over_sky(&capture);
        eprintln!("{}: the smoke stands {over:.1} levels over the sky", preset.wire());
        if over > SMOKE_OVER_SKY_MAX {
            problems.push(format!("{}: the smoke stands {over:.1} levels over the sky beside it", preset.wire()));
        }
    }
    assert!(problems.is_empty(), "{problems:#?}");
}

/// The cabin shot's front-left wall (the hero object in shade, lit by the sky), and how far its
/// mean luma at an AO preset may sit from `low`'s (no AO by design), as a share of `low`'s.
const CABIN_WALL: (std::ops::Range<u32>, std::ops::Range<u32>) = (380..540, 280..400);
const CABIN_WALL_SHARE_MAX: f64 = 0.15;

/// The mean luma (0..255) of `capture` over `region`.
fn mean_luma(capture: &Capture, region: &(std::ops::Range<u32>, std::ops::Range<u32>)) -> f64 {
    let (xs, ys) = region.clone();
    let count = (xs.len() * ys.len()) as f64;
    ys.flat_map(|y| xs.clone().map(move |x| (x, y))).map(|(x, y)| luma_at(capture, x, y)).sum::<f64>() / count
}

/// Gate finding 01 (owner decision 2026-10-12 (a)): the lakeside's AO crushed the shaded cabin walls
/// at medium, high and ultra (luma 52) against low's (91), so the hero object's exposure jumped
/// between presets. Low keeps AO off; every AO preset reads the wall within
/// [`CABIN_WALL_SHARE_MAX`] of it.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_cabin_wall_keeps_its_exposure_at_every_preset() {
    if gpu().is_none() {
        return;
    }
    let dir = out_dir();
    let Some((low, _)) = studio_shot_as("cabin", DrawnAs::Preset(QualityPreset::Low)) else { return };
    let low_wall = mean_luma(&low, &CABIN_WALL);
    let mut problems = Vec::new();
    for preset in [QualityPreset::Medium, QualityPreset::High, QualityPreset::Ultra] {
        let (capture, _) = studio_shot_as("cabin", DrawnAs::Preset(preset)).expect("a presenter");
        write_png(&dir.join(format!("cabin-wall-{}.png", preset.wire())), &capture);
        let wall = mean_luma(&capture, &CABIN_WALL);
        eprintln!("{}: the cabin wall reads {wall:.1} against low's {low_wall:.1}", preset.wire());
        if (wall - low_wall).abs() > low_wall * CABIN_WALL_SHARE_MAX {
            problems.push(format!("{}: the cabin wall reads {wall:.1} against low's {low_wall:.1}", preset.wire()));
        }
    }
    assert!(problems.is_empty(), "{problems:#?}");
}

/// The forest shot's meadow: the rows under the trees' trunks where the grass covers the ground.
const MEADOW_ROWS: std::ops::Range<u32> = 430..720;
/// A pixel counts as shadowed by the sun's cascades when switching them on darkens it below this
/// share of its luma without them.
const SHADOWED_RATIO: f64 = 0.7;
/// The least share of the meadow the cascades must shadow at high, at one fixed exposure. The
/// terrain between the blades and the blades' baked canopy shade darken 78% of it alone (gate
/// finding 02: the blades in the deer's and the trees' map shadows stayed sunlit); with the blades
/// reading the cascades it is 93%.
const MEADOW_SHADOWED_SHARE_MIN: f64 = 0.88;

/// Gate finding 02: the deer cast no shadow onto the grass, so they seemed to float. The grass
/// reads the sun's shadow cascades: switching sun shadows on darkens a fair share of the meadow.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_grass_takes_the_suns_shadows_in_the_forest_shot() {
    use genex::render::{PresetChoice, RenderChange, RenderFeature};
    if gpu().is_none() {
        return;
    }
    let dir = out_dir();
    let preset = Some(Some(PresetChoice::Preset(QualityPreset::High)));
    // One fixed exposure for both: auto exposure would brighten the shadowed picture back.
    let fixed = (RenderFeature::Exposure, false);
    let shadowed = studio_shot_with("forest", RenderChange { preset, features: vec![fixed], ..RenderChange::default() });
    let unshadowed = studio_shot_with("forest", RenderChange { preset, features: vec![fixed, (RenderFeature::Shadows, false)], ..RenderChange::default() });
    let (Some(shadowed), Some(unshadowed)) = (shadowed, unshadowed) else { return };
    write_png(&dir.join("grass-shadows-forest-high.png"), &shadowed);
    write_png(&dir.join("grass-shadows-forest-high-unshadowed.png"), &unshadowed);
    let width = shadowed.width();
    let (mut dark, mut total) = (0usize, 0usize);
    for y in MEADOW_ROWS {
        for x in 0..width {
            total += 1;
            dark += usize::from(luma_at(&shadowed, x, y) < SHADOWED_RATIO * luma_at(&unshadowed, x, y));
        }
    }
    let share = dark as f64 / total as f64;
    eprintln!("the sun's cascades shadow {:.1}% of the meadow", share * 100.0);
    assert!(share >= MEADOW_SHADOWED_SHARE_MIN, "the sun's cascades shadow only {:.1}% of the meadow", share * 100.0);
}

/// [`studio_shot`] after `change` (a `renderSettings` change, as the verb applies it).
fn studio_shot_with(name: &str, change: genex::render::RenderChange) -> Option<Capture> {
    use genex::present::Presenter;
    let mut presenter = Presenter::open(showcase_game::showcase::WORLD_SIZE, showcase_game::assets()).ok()?;
    let mut runtime = lakeside_at_shot_tick();
    assert!(presenter.install_for(&mut runtime).is_empty());
    presenter.set_capturing(true);
    presenter.draw_view(&mut runtime, View::Named(name)).expect("a view").expect("drawn");
    presenter.render_settings().expect("the game's settings attached").borrow_mut().apply(&change);
    presenter.draw_view(&mut runtime, View::Named(name)).expect("a view").expect("drawn");
    Some(presenter.resilient.capture().expect("capture"))
}

/// The wide shot's far forest (the pines and broadleaves on the far hill), and the luma (0..255) a
/// pixel there passes only as a specular glint blown to white.
const FAR_FOREST: (std::ops::Range<u32>, std::ops::Range<u32>) = (900..1160, 100..260);
const GLINT_LUMA: f64 = 230.0;
/// The most of the far forest that may be glints: none settle under TAA (0.18% at high before),
/// and a preset without TAA shades sub-pixel leaves once per pixel, where every glint stays (gate
/// findings 04 and 08: 1.2% at low, "frosted" foliage with white sparkles).
const FOREST_GLINT_SHARE_MAX: f64 = 0.003;

/// Gate findings 04 and 08: low, mobile-mid and mobile-low drew the far foliage frosted with white
/// specular sparkles. Leaves smaller than a pixel cannot be filtered by the renderer's specular
/// anti-aliasing (it widens a highlight by the shading normal's change across a pixel, and a leaf
/// is flat), so their gloss is the leaves' own: soft enough that no glint blows out to white.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_far_foliage_carries_no_white_glints_at_any_preset_or_phone_class() {
    if gpu().is_none() {
        return;
    }
    let dir = out_dir();
    let mobile = |tier| DeviceClass::new(FormFactor::Mobile, tier);
    let drawn = [
        DrawnAs::Preset(QualityPreset::Low),
        DrawnAs::Preset(QualityPreset::Medium),
        DrawnAs::Preset(QualityPreset::High),
        DrawnAs::Class(mobile(PerformanceTier::Mid)),
        DrawnAs::Class(mobile(PerformanceTier::Low)),
    ];
    let mut problems = Vec::new();
    for drawn_as in drawn {
        let Some((capture, _)) = studio_shot_as("wide", drawn_as) else { return };
        write_png(&dir.join(format!("foliage-wide-{}.png", drawn_as.label())), &capture);
        let (xs, ys) = FAR_FOREST;
        let total = (xs.len() * ys.len()) as f64;
        let glints = ys.flat_map(|y| xs.clone().map(move |x| (x, y))).filter(|(x, y)| luma_at(&capture, *x, *y) > GLINT_LUMA).count();
        let share = glints as f64 / total;
        eprintln!("{}: {:.2}% of the far forest is white glints", drawn_as.label(), share * 100.0);
        if share > FOREST_GLINT_SHARE_MAX {
            problems.push(format!("{}: {:.2}% of the far forest is white glints", drawn_as.label(), share * 100.0));
        }
    }
    assert!(problems.is_empty(), "{problems:#?}");
}

/// The dock shot's far deck: the planks' tops past the near posts, out to the fisherman.
const FAR_DECK: (std::ops::Range<u32>, std::ops::Range<u32>) = (620..860, 388..412);
/// How far a pixel's neighbours are read along each of the four directions, pixels.
const SPECK_REACH: u32 = 2;
/// A pixel is a speck when it sits this many levels (luma, 0..255) below the mean of its two
/// neighbours along every one of the four directions: a dot, darker than all around it. A plank's
/// seam is a line, so the neighbours along it are as dark and it does not count.
const SPECK_DEPTH: f64 = 20.0;
/// The most of the far deck that may be specks: the dot pattern was 3.4% of it (mobile-low drawing
/// no anti-aliasing); every preset and phone class with its anti-aliasing draws at most 0.43%
/// (seams broken into short dashes below scale 0.7 included).
const FAR_DECK_SPECK_SHARE_MAX: f64 = 0.01;

/// The share of `region` of `capture` that is specks ([`SPECK_DEPTH`]).
fn speck_share(capture: &Capture, region: &(std::ops::Range<u32>, std::ops::Range<u32>)) -> f64 {
    let (xs, ys) = region.clone();
    let total = (xs.len() * ys.len()) as f64;
    let r = SPECK_REACH;
    let directions: [(i64, i64); 4] = [(1, 0), (0, 1), (1, 1), (1, -1)];
    let at = |x: u32, y: u32, (dx, dy): (i64, i64), sign: i64| {
        let (x, y) = (i64::from(x) + sign * dx * i64::from(r), i64::from(y) + sign * dy * i64::from(r));
        luma_at(capture, x as u32, y as u32)
    };
    let specks = ys
        .flat_map(|y| xs.clone().map(move |x| (x, y)))
        .filter(|&(x, y)| {
            let here = luma_at(capture, x, y);
            directions.iter().all(|&d| here < 0.5 * (at(x, y, d, 1) + at(x, y, d, -1)) - SPECK_DEPTH)
        })
        .count();
    specks as f64 / total
}

/// Gate finding 02: the weakest phone class drew a regular dark dot pattern over the far dock
/// deck. It was no shadow (the pattern stayed with the sun's shadows off): the capture "as
/// mobile-low" had given up MSAA for memory a phone keeps in tile memory, so the seams aliased and
/// EASU enlarged them into dots. At every preset and phone class the deck draws without specks.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_far_dock_deck_draws_no_dot_pattern_at_any_preset_or_phone_class() {
    if gpu().is_none() {
        return;
    }
    let dir = out_dir();
    let mobile = |tier| DeviceClass::new(FormFactor::Mobile, tier);
    let presets = [QualityPreset::Low, QualityPreset::Medium, QualityPreset::High, QualityPreset::Ultra];
    let classes = [mobile(PerformanceTier::High), mobile(PerformanceTier::Mid), mobile(PerformanceTier::Low)];
    let mut problems = Vec::new();
    for drawn_as in presets.map(DrawnAs::Preset).into_iter().chain(classes.map(DrawnAs::Class)) {
        let Some((capture, _)) = studio_shot_as("dock", drawn_as) else { return };
        write_png(&dir.join(format!("dock-deck-{}.png", drawn_as.label())), &capture);
        let share = speck_share(&capture, &FAR_DECK);
        eprintln!("{}: {:.2}% of the far deck is specks", drawn_as.label(), share * 100.0);
        if share > FAR_DECK_SPECK_SHARE_MAX {
            problems.push(format!("{}: {:.2}% of the far deck is specks", drawn_as.label(), share * 100.0));
        }
    }
    assert!(problems.is_empty(), "{problems:#?}");
}
