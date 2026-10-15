//! A.2 grading: the look's parametric grading (Bevy's sectional knobs with contrast in log space
//! about middle grey and Filament's vibrance, before the curve) and its display-referred 3D LUT
//! (an Adobe `.cube`, tetrahedral, after the curve and the sRGB encode, before the dither), both in
//! the tonemap (graph node 21).
//!
//! The CPU rows run everywhere. The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test grading -- --ignored metal
//!
//! Goldens live in `tests/fixtures/render-goldens/grading/<name>.bgra` (raw BGRA, 128x72);
//! `GENEX_RENDER_GOLDEN_UPDATE=1` rewrites them. `GENEX_RENDER_EVIDENCE_DIR` also writes each
//! compared frame there (and the 1440p capture row); `GENEX_PERF_OUT` receives the cost row.

use std::path::{Path, PathBuf};

use genex_render::budget::{BudgetInput, BudgetKind, BudgetLedger, GRADING_LUT_LABEL, ledger};
use genex_render::capture::Capture;
use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
use genex_render::post::grading::{
    Grading, GradingLut, GradingLutError, GradingSection, LUT_SIDE_MAX, LUT_SIDE_MIN, MIDDLE_GREY, ShaderGrading, lut_side_max,
};
use genex_render::post::tonemap::{TonemapSource, encode_srgb, grade_image, tonemap_cpu};
use genex_render::scene::{CameraDesc, Material, MeshId, PointLight, Scene, scaled, translation};
use genex_render::settings::{ExposureMode, Look, Quality, QualityPreset, SceneFormat, Tonemapper};
use genex_render::{CullPath, Gpu, Renderer};

const WIDTH: u32 = 128;
const HEIGHT: u32 = 72;
/// A golden pixel may differ by this much per channel (another Apple GPU family rounds differently).
const GOLDEN_CHANNEL_TOLERANCE: u8 = 2;
/// Pixels allowed beyond the channel tolerance, of 9216.
const GOLDEN_OUTLIER_PIXELS: usize = 46;
/// The GPU grading may differ from its CPU twin by one 8-bit level (the plan's `.cube` round trip).
const LEVELS: u8 = 1;
/// What grading (a 33³ LUT, contrast and vibrance) may add to the tonemap pass at 1080p, the cost
/// rows' resolution (A.2's acceptance: at most 0.1 ms).
const GRADING_MS_MAX: f32 = 0.1;

// ---------------------------------------------------------------------------------------------
// CPU rows: the .cube reader

/// A 2³ `.cube` that swaps red and blue, red varying fastest (the Adobe spec's order).
const SWAP_CUBE: &str = "# swap red and blue\nTITLE \"swap\"\nLUT_3D_SIZE 2\n\n\
0 0 0\n0 0 1\n0 1 0\n0 1 1\n1 0 0\n1 0 1\n1 1 0\n1 1 1\n";

#[test]
fn a_cube_file_parses_its_size_domain_and_rows_with_red_varying_fastest() {
    let lut = GradingLut::parse_cube(SWAP_CUBE).expect("a valid .cube");
    assert_eq!(lut.side(), 2);
    assert_eq!(lut.domain(), ([0.0; 3], [1.0; 3]));
    assert_eq!(lut.rows().len(), 8);
    // Index (r=1, g=0, b=0) is row 1: red varies fastest.
    assert_eq!(lut.rows()[1], [0.0, 0.0, 1.0]);
    assert_eq!(lut.sample([1.0, 0.0, 0.0]), [0.0, 0.0, 1.0], "red maps to blue");
    assert_eq!(lut.sample([0.0, 0.0, 1.0]), [1.0, 0.0, 0.0], "blue maps to red");
    let mid = lut.sample([0.25, 0.5, 0.75]);
    assert!(mid.iter().zip([0.75, 0.5, 0.25]).all(|(a, b)| (a - b).abs() < 1e-6), "a linear LUT interpolates exactly: {mid:?}");
}

#[test]
fn a_signed_domain_and_unknown_header_keywords_are_read() {
    // three.js' DOMAIN regex rejects a negative value; the spec allows it.
    let text = "LUT_3D_SIZE 2\nDOMAIN_MIN -0.5 -0.5 -0.5\nDOMAIN_MAX 1.5 1.5 1.5\nLUT_IN_VIDEO_RANGE\n\
0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n";
    let lut = GradingLut::parse_cube(text).expect("a signed domain");
    assert_eq!(lut.domain(), ([-0.5; 3], [1.5; 3]));
    // 0.5 sits mid-domain: the identity table returns the grid's middle, 0.5.
    let mid = lut.sample([0.5, 0.5, 0.5]);
    assert!(mid.iter().all(|c| (c - 0.5).abs() < 1e-6), "{mid:?}");
    let resampled = lut.resampled(2);
    assert_eq!(resampled.domain(), ([0.0; 3], [1.0; 3]), "the upload is on the encoded colour's domain");
    // On [0, 1] the 2-wide identity over [-0.5, 1.5] reads 0.25..0.75.
    assert!((resampled.rows()[0][0] - 0.25).abs() < 1e-6 && (resampled.rows()[7][2] - 0.75).abs() < 1e-6);
}

/// A hostile `.cube`: its name, its text and the error it must be refused with.
type HostileCube = (&'static str, String, fn(&GradingLutError) -> bool);

/// Hostile `.cube` text: each refused with its typed error, and no LUT made.
#[test]
fn hostile_cube_files_are_refused_with_a_typed_error() {
    let rows = |count: usize| "0 0 0\n".repeat(count);
    let huge = format!("LUT_3D_SIZE 2\n{}", "0 0 0 ".repeat(4 << 20));
    let cases: Vec<HostileCube> = vec![
        ("empty", String::new(), |e| matches!(e, GradingLutError::MissingSize)),
        ("rows without a size", rows(8), |e| matches!(e, GradingLutError::MissingSize)),
        ("size 1", format!("LUT_3D_SIZE 1\n{}", rows(1)), |e| matches!(e, GradingLutError::SizeOutOfRange { .. })),
        ("size past the cap", format!("LUT_3D_SIZE {}\n", LUT_SIDE_MAX + 1), |e| matches!(e, GradingLutError::SizeOutOfRange { .. })),
        ("a huge size", "LUT_3D_SIZE 4294967295\n".to_owned(), |e| matches!(e, GradingLutError::SizeOutOfRange { .. })),
        ("a negative size", "LUT_3D_SIZE -2\n".to_owned(), |e| matches!(e, GradingLutError::Keyword { .. })),
        ("a 1D LUT", format!("LUT_1D_SIZE 2\n{}", rows(2)), |e| matches!(e, GradingLutError::OneDimensional)),
        ("too few rows", format!("LUT_3D_SIZE 2\n{}", rows(7)), |e| matches!(e, GradingLutError::RowCount { expected: 8, found: 7 })),
        ("too many rows", format!("LUT_3D_SIZE 2\n{}", rows(9)), |e| matches!(e, GradingLutError::RowCount { expected: 8, found: 9 })),
        ("two numbers", format!("LUT_3D_SIZE 2\n0 0\n{}", rows(7)), |e| matches!(e, GradingLutError::Row { line: 2 })),
        ("four numbers", format!("LUT_3D_SIZE 2\n0 0 0 0\n{}", rows(7)), |e| matches!(e, GradingLutError::Row { line: 2 })),
        ("a word in a row", format!("LUT_3D_SIZE 2\n{}0 x 0\n", rows(7)), |e| matches!(e, GradingLutError::Row { line: 9 })),
        ("NaN", format!("LUT_3D_SIZE 2\nNaN 0 0\n{}", rows(7)), |e| matches!(e, GradingLutError::NotFinite { line: 2 })),
        ("infinity", format!("LUT_3D_SIZE 2\ninf 0 0\n{}", rows(7)), |e| matches!(e, GradingLutError::NotFinite { line: 2 })),
        ("an overflow", format!("LUT_3D_SIZE 2\n1e999 0 0\n{}", rows(7)), |e| matches!(e, GradingLutError::NotFinite { line: 2 })),
        ("an empty domain", format!("LUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 0 1\n{}", rows(8)), |e| matches!(e, GradingLutError::Domain)),
        ("a NaN domain", format!("LUT_3D_SIZE 2\nDOMAIN_MIN 0 NaN 0\n{}", rows(8)), |e| matches!(e, GradingLutError::NotFinite { line: 2 })),
        ("a second size", format!("LUT_3D_SIZE 2\nLUT_3D_SIZE 3\n{}", rows(8)), |e| matches!(e, GradingLutError::Keyword { line: 2 })),
        ("a keyword after the rows", format!("LUT_3D_SIZE 2\n{}DOMAIN_MIN 0 0 0\n", rows(8)), |e| matches!(e, GradingLutError::Keyword { line: 10 })),
        ("past the text cap", huge, |e| matches!(e, GradingLutError::TooLarge { .. })),
    ];
    for (name, text, expected) in cases {
        match GradingLut::parse_cube(&text) {
            Ok(lut) => panic!("{name}: read as a {}³ LUT", lut.side()),
            Err(error) => assert!(expected(&error), "{name}: refused with {error:?}"),
        }
    }
}

/// A teal-and-orange display look: shadows towards teal, highlights towards orange, more contrast.
fn teal_orange(rgb: [f32; 3]) -> [f32; 3] {
    let luma = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    let s = luma * luma * (3.0 - 2.0 * luma);
    let push = [0.05 * (s - 0.5), 0.01 * (s - 0.5), -0.05 * (s - 0.5)];
    // Unclamped: a LUT may hold values past [0, 1] (the target clamps them), and a clamp's kink
    // inside a cell is not what the interpolation is measured on.
    std::array::from_fn(|i| rgb[i] + (s - luma) * 0.3 + push[i])
}

#[test]
fn a_cube_written_and_read_back_is_the_same_lut() {
    let lut = GradingLut::from_fn(17, teal_orange).expect("a 17³ LUT");
    let text = lut.to_cube("teal orange");
    let back = GradingLut::parse_cube(&text).expect("its own .cube");
    assert_eq!(back.side(), 17);
    assert_eq!(back.rows(), lut.rows(), "the writer prints each value so it reads back to the same float");
}

#[test]
fn tetrahedral_interpolation_follows_the_look_between_grid_points() {
    let lut = GradingLut::from_fn(33, teal_orange).expect("a 33³ LUT");
    let mut worst = 0.0f32;
    for i in 0..=40 {
        for j in [0.03f32, 0.37, 0.81] {
            let rgb = [i as f32 / 40.0, j, 1.0 - j * 0.5];
            let (got, want) = (lut.sample(rgb), teal_orange(rgb));
            worst = worst.max(got.iter().zip(want).map(|(a, b)| (a - b).abs()).fold(0.0, f32::max));
        }
    }
    assert!(worst * 255.0 < 0.5, "a 33³ LUT holds the look within half a level between grid points: {worst}");
}

#[test]
fn the_lut_side_is_capped_per_class_and_mobile_low_draws_16() {
    let class = |form, tier| lut_side_max(DeviceClass::new(form, tier));
    assert_eq!(class(FormFactor::Mobile, PerformanceTier::Low), 16);
    assert!(class(FormFactor::Mobile, PerformanceTier::Mid) <= 33);
    assert!(class(FormFactor::Mobile, PerformanceTier::High) <= 33);
    for tier in PerformanceTier::ALL {
        assert_eq!(class(FormFactor::Desktop, tier), LUT_SIDE_MAX, "{tier:?}: a desktop keeps every .cube's own size");
    }
    let lut = GradingLut::from_fn(33, teal_orange).expect("a 33³ LUT");
    let upload = lut.upload(16);
    assert_eq!(upload.side(), 16, "mobile-low resamples a 33³ LUT to 16³");
    assert_eq!(upload.bytes(), 16 * 16 * 16 * 8, "rgba16float texels");
    assert_eq!(lut.upload(64).side(), 33, "a LUT under the cap keeps its size");
    assert_eq!(LUT_SIDE_MIN, 2);
}

#[test]
fn an_identity_lut_uploads_zero_deltas_so_it_changes_nothing() {
    for side in [2, 16, 33, 65] {
        let upload = GradingLut::identity(side).expect("identity").upload(LUT_SIDE_MAX);
        assert!(upload.deltas().iter().all(|delta| *delta == [0.0; 3]), "{side}³: the identity stores no change");
        for rgb in [[0.0, 0.0, 0.0], [1.0, 1.0, 1.0], [0.2, 0.5, 0.9], [0.999, 0.001, 0.5]] {
            assert_eq!(upload.apply(rgb, 1.0), rgb, "{side}³ at {rgb:?}");
        }
    }
}

// ---------------------------------------------------------------------------------------------
// CPU rows: parametric grading

fn luma(rgb: [f32; 3]) -> f32 {
    0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
}

/// Whether `a` and `b` agree to a relative 1e-5 (the log-space contrast rounds an ulp or two).
fn close(a: [f32; 3], b: [f32; 3]) -> bool {
    a.iter().zip(b).all(|(x, y)| (x - y).abs() <= y.abs() * 1e-5 + 1e-7)
}

#[test]
fn the_neutral_grading_draws_no_grading_pass() {
    assert_eq!(Grading::NEUTRAL.shader(), ShaderGrading::NONE);
    assert_eq!(Look::default().grading, Grading::NEUTRAL, "the default look grades nothing");
    assert!(Grading::NEUTRAL.with_contrast(1.2).shader().parametric());
    assert!(!Grading::NEUTRAL.with_contrast(1.2).shader().lut());
    let lut = GradingLut::identity(2).expect("identity").intern().expect("interned");
    assert!(Grading::NEUTRAL.with_lut(lut, 1.0).shader().lut());
    assert_eq!(Grading::NEUTRAL.with_lut(lut, 0.0).shader(), ShaderGrading::NONE, "a LUT at intensity 0 draws nothing");
}

#[test]
fn contrast_turns_about_middle_grey_so_grading_never_shifts_the_exposure() {
    // C12: Bevy's contrast pivots at linear 0.5, so contrast 1.2 pulls grey 0.18 to 0.116 (-0.6 EV).
    for contrast in [0.6, 1.2, 1.6] {
        let grading = Grading::NEUTRAL.with_contrast(contrast);
        let grey = grading.grade([MIDDLE_GREY; 3]);
        assert!(grey.iter().all(|c| (c - MIDDLE_GREY).abs() < 1e-4), "contrast {contrast}: grey stays {MIDDLE_GREY}: {grey:?}");
        let (dark, bright) = (grading.grade([0.02; 3])[0], grading.grade([2.0; 3])[0]);
        if contrast > 1.0 {
            assert!(dark < 0.02 && bright > 2.0, "contrast {contrast} spreads the stops: {dark} {bright}");
        } else {
            assert!(dark > 0.02 && bright < 2.0, "contrast {contrast} gathers the stops: {dark} {bright}");
        }
        // One stop above grey moves by `contrast` stops.
        let stop = libm::log2f(grading.grade([2.0 * MIDDLE_GREY; 3])[0] / MIDDLE_GREY);
        assert!((stop - contrast).abs() < 1e-3, "contrast {contrast}: {stop} stops");
    }
}

#[test]
fn saturation_and_vibrance_keep_greys_grey_and_luminance_close() {
    for grading in [Grading::NEUTRAL.with_saturation(1.5), Grading::NEUTRAL.with_vibrance(1.6), Grading::NEUTRAL.with_saturation(0.0)] {
        for level in [0.01, 0.18, 1.0, 8.0] {
            let grey = grading.grade([level; 3]);
            assert!(grey.iter().all(|c| (c - level).abs() <= level * 1e-5), "{grading:?}: grey {level} stays grey: {grey:?}");
        }
    }
    let colour = [0.30, 0.18, 0.08];
    let saturated = Grading::NEUTRAL.with_saturation(1.5).grade(colour);
    assert!((luma(saturated) - luma(colour)).abs() < 1e-5, "saturation keeps Rec. 709 luminance");
    assert!(saturated[0] - saturated[2] > colour[0] - colour[2], "and widens the channels");
    let desaturated = Grading::NEUTRAL.with_saturation(0.0).grade(colour);
    assert!((desaturated[0] - desaturated[2]).abs() < 1e-6, "saturation 0 is grey: {desaturated:?}");
    // Filament's vibrance: a muted colour gains, by at most the knob.
    let vibrant = Grading::NEUTRAL.with_vibrance(1.6).grade(colour);
    assert!(vibrant[0] - vibrant[2] > colour[0] - colour[2]);
    assert!(vibrant[0] - vibrant[2] <= 1.6 * (colour[0] - colour[2]) + 1e-5);
}

#[test]
fn sections_grade_shadows_midtones_and_highlights_apart_and_blend_between_them() {
    let warm_shadows = Grading { shadows: GradingSection { gain: 1.5, ..GradingSection::NEUTRAL }, ..Grading::NEUTRAL };
    assert!((warm_shadows.grade([0.05; 3])[0] - 0.075).abs() < 1e-5, "a shadow takes the shadows' gain");
    assert!(close(warm_shadows.grade([0.45; 3]), [0.45; 3]), "a midtone keeps its value");
    assert!(close(warm_shadows.grade([4.0; 3]), [4.0; 3]), "a highlight keeps its value");
    // Bevy blends the shadows' margin into the highlights' (levels.z); the blend is between the
    // two sections the level sits between, so it reaches neither a highlight's knob nor a jump.
    let hot = Grading { highlights: GradingSection { gain: 3.0, ..GradingSection::NEUTRAL }, ..Grading::NEUTRAL };
    assert!(close(hot.grade([0.2; 3]), [0.2; 3]), "a level at the shadows' edge takes no highlight gain");
    let mut last = 0.0;
    for step in 0..=200 {
        let level = step as f32 * 0.01;
        let graded = warm_shadows.grade([level; 3])[0];
        assert!(graded >= last - 1e-6, "the sections' blend is monotone at {level}: {graded} after {last}");
        last = graded;
    }
}

#[test]
fn grading_holds_its_knobs_to_their_ranges() {
    let wild = Grading::NEUTRAL.with_contrast(f32::NAN).with_saturation(100.0).with_vibrance(-3.0);
    assert_eq!(wild.contrast, 1.0, "NaN is the neutral value");
    assert_eq!(wild.saturation, 2.0);
    assert_eq!(wild.vibrance, 0.0);
    let section = GradingSection { gamma: 0.0, gain: f32::INFINITY, lift: -9.0, ..GradingSection::NEUTRAL }.held();
    assert!(section.gamma > 0.0, "gamma is never 0 (the shader divides by it)");
    assert!(section.gain.is_finite() && section.lift >= -1.0);
    let held = Look::default().with_grading(Grading { shadows: GradingSection { gamma: 0.0, ..GradingSection::NEUTRAL }, ..Grading::NEUTRAL });
    assert!(held.grading.shadows.gamma > 0.0, "the look holds a grading it is handed");
    let graded = Grading::NEUTRAL.with_contrast(2.0).with_saturation(2.0).grade([64512.0, 0.0, 1.0e-9]);
    assert!(graded.iter().all(|c| c.is_finite() && *c >= 0.0), "{graded:?}");
}

#[test]
fn an_interned_lut_is_shared_by_content() {
    let a = GradingLut::from_fn(5, teal_orange).expect("lut").intern().expect("interned");
    let b = GradingLut::from_fn(5, teal_orange).expect("lut").intern().expect("interned");
    assert!(std::ptr::eq(a, b), "the same table interns once");
    assert_eq!(Grading::NEUTRAL.with_lut(a, 1.0), Grading::NEUTRAL.with_lut(b, 1.0));
}

// ---------------------------------------------------------------------------------------------
// GPU fixtures

fn gpu() -> Option<Gpu> {
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    match Gpu::headless() {
        Ok(gpu) => {
            if require {
                assert_eq!(gpu.receipt().backend, "metal", "GENEX_REQUIRE_METAL=1 but the adapter is not Metal");
            }
            Some(gpu)
        }
        Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
        Err(error) => {
            eprintln!("skipped: no WebGPU-core adapter ({error})");
            None
        }
    }
}

fn goldens_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/render-goldens/grading")
}

fn write_evidence(name: &str, capture: &Capture) {
    if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        let dir = PathBuf::from(dir);
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join(format!("{name}-{}x{}.bgra", capture.width(), capture.height())), capture.bgra()).expect("evidence");
    }
}

fn check_golden(name: &str, capture: &Capture) {
    assert_eq!((capture.width(), capture.height()), (WIDTH, HEIGHT));
    write_evidence(name, capture);
    let path = goldens_dir().join(format!("{name}.bgra"));
    if std::env::var("GENEX_RENDER_GOLDEN_UPDATE").is_ok_and(|v| v == "1") {
        std::fs::create_dir_all(goldens_dir()).expect("goldens folder");
        std::fs::write(&path, capture.bgra()).expect("golden written");
        return;
    }
    let golden = std::fs::read(&path).unwrap_or_else(|error| panic!("golden {path:?} missing ({error}); render it with GENEX_RENDER_GOLDEN_UPDATE=1"));
    let outliers = golden
        .chunks(4)
        .zip(capture.bgra().chunks(4))
        .filter(|(a, b)| a.iter().zip(b.iter()).any(|(p, q)| p.abs_diff(*q) > GOLDEN_CHANNEL_TOLERANCE))
        .count();
    assert!(outliers <= GOLDEN_OUTLIER_PIXELS, "{name}: {outliers} pixels differ from the golden");
}

/// A 64x48 ramp of pre-exposed radiance: hue across, brightness down (deep shadow to past white).
fn ramp() -> ((u32, u32), Vec<[f32; 4]>) {
    let (width, height) = (64u32, 48u32);
    let texels = (0..height)
        .flat_map(|y| {
            (0..width).map(move |x| {
                let level = libm::exp2f(-8.0 + 12.0 * y as f32 / (height - 1) as f32);
                let hue = x as f32 / width as f32 * 6.0;
                let channel = |offset: f32| (1.0 - ((hue + offset) % 6.0 - 3.0).abs().min(1.0)).mul_add(0.8, 0.2);
                [level * channel(0.0), level * channel(4.0), level * channel(2.0), 1.0]
            })
        })
        .collect();
    ((width, height), texels)
}

fn desktop() -> DeviceClass {
    DeviceClass::new(FormFactor::Desktop, PerformanceTier::High)
}

/// The CPU twin of the tonemap with `grading`, one texel: grade, curve, encode, LUT; as 8-bit.
fn cpu_levels(tonemapper: Tonemapper, grading: &Grading, class: DeviceClass, texel: [f32; 4]) -> [u8; 3] {
    let rgb = [texel[0], texel[1], texel[2]].map(|c| genex_render::post::tonemap::f16_to_f32(genex_render::post::tonemap::f32_to_f16(c)));
    let graded = if grading.shader().parametric() { grading.grade(rgb) } else { rgb };
    let encoded = tonemap_cpu(tonemapper, graded).map(encode_srgb);
    let looked = match grading.lut.filter(|_| grading.shader().lut()) {
        Some(lut) => lut.upload(lut_side_max(class)).apply(encoded, grading.lut_intensity),
        None => encoded,
    };
    looked.map(|c| (c.clamp(0.0, 1.0) * 255.0).round() as u8)
}

/// The worst channel difference between `capture` (BGRA) and the CPU twin over `texels`.
fn worst_against_cpu(capture: &Capture, texels: &[[f32; 4]], tonemapper: Tonemapper, grading: &Grading, class: DeviceClass) -> u8 {
    capture
        .bgra()
        .chunks(4)
        .zip(texels)
        .map(|(bgra, texel)| {
            let [r, g, b] = cpu_levels(tonemapper, grading, class, *texel);
            [bgra[2].abs_diff(r), bgra[1].abs_diff(g), bgra[0].abs_diff(b)].into_iter().max().unwrap_or(0)
        })
        .max()
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------------------------
// GPU rows: the tonemap node

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_an_identity_lut_draws_the_ungraded_picture_byte_for_byte() {
    let Some(gpu) = gpu() else { return };
    let (size, texels) = ramp();
    let identity = Grading::NEUTRAL.with_lut(GradingLut::identity(33).expect("identity").intern().expect("interned"), 1.0);
    assert!(identity.shader().lut(), "the identity LUT goes through the LUT pipeline (no shortcut)");
    for tonemapper in [Tonemapper::KhronosNeutral, Tonemapper::AgxPunchy] {
        for (source, target) in [(TonemapSource::Scene, size), (TonemapSource::Bilinear, (100, 75)), (TonemapSource::Sharpen, (100, 75))] {
            for dither in [false, true] {
                let plain = grade_image(&gpu, tonemapper, source, (size, &texels), target, &Grading::NEUTRAL, desktop(), dither).expect("plain");
                let graded = grade_image(&gpu, tonemapper, source, (size, &texels), target, &identity, desktop(), dither).expect("graded");
                assert!(plain.bgra() == graded.bgra(), "{tonemapper:?} {source:?} dither {dither}: the identity LUT changed the picture");
            }
        }
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_cube_lut_matches_its_cpu_twin_within_one_level() {
    let Some(gpu) = gpu() else { return };
    let (size, texels) = ramp();
    // The .cube round trip: written as text, read back, drawn on the GPU, against the CPU twin.
    let text = GradingLut::from_fn(33, teal_orange).expect("lut").to_cube("teal orange");
    let lut = GradingLut::parse_cube(&text).expect("its .cube").intern().expect("interned");
    let mobile_low = DeviceClass::new(FormFactor::Mobile, PerformanceTier::Low);
    for (class, intensity) in [(desktop(), 1.0), (desktop(), 0.5), (mobile_low, 1.0)] {
        let grading = Grading::NEUTRAL.with_lut(lut, intensity);
        let capture = grade_image(&gpu, Tonemapper::AgxPunchy, TonemapSource::Scene, (size, &texels), size, &grading, class, false).expect("graded");
        let worst = worst_against_cpu(&capture, &texels, Tonemapper::AgxPunchy, &grading, class);
        assert!(worst <= LEVELS, "{class:?} at {intensity}: {worst} levels from the CPU twin");
    }
    // And the LUT is the look it was made from, within a level (the 33³ grid and the f16 deltas).
    let capture = grade_image(&gpu, Tonemapper::AgxPunchy, TonemapSource::Scene, (size, &texels), size, &Grading::NEUTRAL.with_lut(lut, 1.0), desktop(), false).expect("graded");
    let worst = capture
        .bgra()
        .chunks(4)
        .zip(&texels)
        .map(|(bgra, texel)| {
            let rgb = [texel[0], texel[1], texel[2]].map(|c| genex_render::post::tonemap::f16_to_f32(genex_render::post::tonemap::f32_to_f16(c)));
            let want = teal_orange(tonemap_cpu(Tonemapper::AgxPunchy, rgb).map(encode_srgb)).map(|c| (c * 255.0).round() as u8);
            [bgra[2].abs_diff(want[0]), bgra[1].abs_diff(want[1]), bgra[0].abs_diff(want[2])].into_iter().max().unwrap_or(0)
        })
        .max()
        .unwrap_or(0);
    assert!(worst <= LEVELS, "the drawn LUT is the look it was written from: {worst} levels");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_parametric_grading_matches_its_cpu_twin_within_one_level() {
    let Some(gpu) = gpu() else { return };
    let (size, texels) = ramp();
    let sections = Grading {
        shadows: GradingSection { saturation: 0.8, lift: 0.004, gain: 1.05, ..GradingSection::NEUTRAL },
        midtones: GradingSection { gamma: 1.1, contrast: 1.05, ..GradingSection::NEUTRAL },
        highlights: GradingSection { saturation: 1.2, gain: 0.9, ..GradingSection::NEUTRAL },
        ..Grading::NEUTRAL
    };
    for grading in [Grading::NEUTRAL.with_contrast(1.3), Grading::NEUTRAL.with_saturation(1.4).with_vibrance(1.3), sections] {
        for tonemapper in [Tonemapper::KhronosNeutral, Tonemapper::AgxPunchy] {
            let capture = grade_image(&gpu, tonemapper, TonemapSource::Scene, (size, &texels), size, &grading, desktop(), false).expect("graded");
            let worst = worst_against_cpu(&capture, &texels, tonemapper, &grading, desktop());
            assert!(worst <= LEVELS, "{tonemapper:?} {grading:?}: {worst} levels from the CPU twin");
        }
    }
}

// ---------------------------------------------------------------------------------------------
// GPU rows: the renderer (the look's grading reaches the frame)

fn quality() -> Quality {
    genex_render::presets::preset_quality(QualityPreset::Medium, desktop())
}

fn look(grading: Grading) -> Look {
    let mut look = Look::default().with_grading(grading);
    look.tonemapper = Tonemapper::AgxPunchy;
    look.exposure = ExposureMode::Manual;
    look
}

fn scene() -> Scene {
    scene_panned(0.0)
}

/// [`scene`] with the camera moved `pan` world units sideways (its target with it).
fn scene_panned(pan: f32) -> Scene {
    let mut scene = Scene::new(CameraDesc::look_at([pan, 4.0, 9.0], [pan, 0.0, 0.0]), [30, 40, 60, 255]);
    scene.lighting.sun_intensity = 4.0;
    scene.lighting.points.push(PointLight { position: [-2.5, 1.2, 1.0], range: 6.0, color: [255, 200, 140], intensity: 8.0 });
    scene.draw(MeshId::CUBE, translation(1.5, 0.5, 0.0), Material::color([220, 40, 50, 255]));
    scene.draw(MeshId::SPHERE, translation(-1.0, 0.8, 1.5), Material::color([90, 200, 120, 255]).with_pbr(0.0, 0.3));
    scene.draw(MeshId::CUBE, scaled([0.0, -0.1, 0.0], [14.0, 0.2, 10.0]), Material::color([235, 235, 235, 255]));
    scene
}

fn renderer(gpu: &Gpu, size: (u32, u32), grading: Grading) -> Renderer {
    let mut renderer = Renderer::new(gpu, size.0, size.1).expect("renderer");
    renderer.set_device_class(desktop());
    renderer.set_scene_format(SceneFormat::Rgba16Float);
    renderer.set_quality(&quality());
    renderer.set_look(look(grading));
    renderer
}

/// The frame after `frames` frames of a still camera (a settled TAA history).
fn settled(gpu: &Gpu, renderer: &mut Renderer, scene: &Scene, frames: u64) -> Capture {
    for frame in 0..frames {
        renderer.set_frame_index(frame);
        renderer.render(gpu, scene, CullPath::Gpu).expect("frame");
    }
    renderer.capture(gpu).expect("capture")
}

/// The showcase-style grade the renderer rows draw: a teal-orange LUT over a little more contrast.
fn showcase_grading() -> Grading {
    let lut = GradingLut::from_fn(33, teal_orange).expect("lut").intern().expect("interned");
    Grading::NEUTRAL.with_contrast(1.15).with_vibrance(1.2).with_lut(lut, 0.8)
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_looks_grading_reaches_the_frame_and_neutral_draws_the_plain_frame() {
    let Some(gpu) = gpu() else { return };
    let scene = scene();
    let plain = settled(&gpu, &mut renderer(&gpu, (WIDTH, HEIGHT), Grading::NEUTRAL), &scene, 24);
    let identity = Grading::NEUTRAL.with_lut(GradingLut::identity(17).expect("identity").intern().expect("interned"), 1.0);
    let through_identity = settled(&gpu, &mut renderer(&gpu, (WIDTH, HEIGHT), identity), &scene, 24);
    assert!(plain.bgra() == through_identity.bgra(), "an identity LUT draws the ungraded frame byte for byte");
    let graded = settled(&gpu, &mut renderer(&gpu, (WIDTH, HEIGHT), showcase_grading()), &scene, 24);
    let changed = plain.bgra().chunks(4).zip(graded.bgra().chunks(4)).filter(|(a, b)| a != b).count();
    assert!(changed > (WIDTH * HEIGHT / 2) as usize, "the look's grading reaches the frame: {changed} pixels changed");
    check_golden("graded-medium", &graded);
}

/// The grading LUT's entry in `ledger`, if it has one.
fn grading_lut_entry(ledger: &BudgetLedger) -> Option<(BudgetKind, u64)> {
    ledger.entries().iter().find(|entry| entry.label == GRADING_LUT_LABEL).map(|entry| (entry.kind, entry.bytes))
}

// A.2 cross-lane: the 3D LUT the tonemap uploads (up to 65³ rgba16f, 2.2 MB, on desktop) was in no
// ledger, so the class's budget fit never saw it.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_grading_lut_the_tonemap_holds_is_in_the_budget_ledger() {
    let Some(gpu) = gpu() else { return };
    let mut plain = renderer(&gpu, (WIDTH, HEIGHT), Grading::NEUTRAL);
    settled(&gpu, &mut plain, &scene(), 1);
    assert_eq!(grading_lut_entry(&plain.buffer_ledger()), None, "a look without a LUT holds none");
    let mut graded = renderer(&gpu, (WIDTH, HEIGHT), showcase_grading());
    settled(&gpu, &mut graded, &scene(), 1);
    let held = graded.buffer_ledger();
    let bytes = 33u64.pow(3) * 8;
    assert_eq!(grading_lut_entry(&held), Some((BudgetKind::Ibl, bytes)), "the 33³ rgba16f LUT, held");
    let input = BudgetInput::new((WIDTH, HEIGHT), 1.0, SceneFormat::Rgba16Float, false).with_buffers(&held);
    assert_eq!(grading_lut_entry(&ledger(&quality(), &input)), Some((BudgetKind::Ibl, bytes)), "and in the fit's ledger");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_graded_still_frame_flickers_no_more_than_the_plain_one() {
    let Some(gpu) = gpu() else { return };
    let scene = scene();
    // Frame-to-frame changes of a still camera after the history settles: the dither and TAA's
    // jitter are all that moves, and grading must not amplify them past a level.
    let flicker = |grading: Grading| {
        let mut renderer = renderer(&gpu, (WIDTH, HEIGHT), grading);
        let mut last = settled(&gpu, &mut renderer, &scene, 24);
        let mut worst = 0usize;
        for frame in 24..40 {
            renderer.set_frame_index(frame);
            renderer.render(&gpu, &scene, CullPath::Gpu).expect("frame");
            let next = renderer.capture(&gpu).expect("capture");
            let moved = last.bgra().chunks(4).zip(next.bgra().chunks(4)).filter(|(a, b)| a.iter().zip(b.iter()).any(|(p, q)| p.abs_diff(*q) > 2)).count();
            worst = worst.max(moved);
            last = next;
        }
        worst
    };
    let (plain, graded) = (flicker(Grading::NEUTRAL), flicker(showcase_grading()));
    println!("{{\"row\":\"grading-still-flicker\",\"plainPixels\":{plain},\"gradedPixels\":{graded}}}");
    assert!(graded <= plain + 4, "grading flickers {graded} pixels a frame by more than 2 levels against {plain}");
}

/// Levels a pixel's luma may move past its neighbourhood's in the frame before (the still row's 2).
const FLICKER_LEVELS: f32 = 2.0;
/// Frames of the pan row and its sideways step a frame (a quarter of a pixel at 128x72).
const PAN_FRAMES: u64 = 40;
const PAN_STEP: f32 = 0.02;

fn luma_levels(capture: &Capture) -> Vec<f32> {
    capture.bgra().chunks(4).map(|p| 0.0722 * f32::from(p[0]) + 0.7152 * f32::from(p[1]) + 0.2126 * f32::from(p[2])).collect()
}

/// Pixels of `next` whose luma leaves the 3x3 neighbourhood's range in `before` by more than
/// [`FLICKER_LEVELS`]: a slow pan moves a value less than a pixel a frame, so the frame before
/// holds it nearby; one it does not hold flickered (the motion rows' envelope, radius 1).
fn pan_flickers(before: &[f32], next: &[f32]) -> usize {
    let (w, h) = (WIDTH as usize, HEIGHT as usize);
    (0..w * h)
        .filter(|i| {
            let (x, y) = (i % w, i / w);
            let (mut low, mut high) = (f32::MAX, f32::MIN);
            for ny in y.saturating_sub(1)..=(y + 1).min(h - 1) {
                for nx in x.saturating_sub(1)..=(x + 1).min(w - 1) {
                    let v = before[ny * w + nx];
                    (low, high) = (low.min(v), high.max(v));
                }
            }
            next[*i] < low - FLICKER_LEVELS || next[*i] > high + FLICKER_LEVELS
        })
        .count()
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_graded_pan_flickers_no_more_than_the_plain_one() {
    let Some(gpu) = gpu() else { return };
    // A slow sideways pan after the history settles: grading is a function of each pixel (its
    // contrast and LUT steepen some values' steps), so it may scale a pixel's flicker by its slope
    // but never adds a flickering pixel of its own.
    let flicker = |grading: Grading| {
        let mut renderer = renderer(&gpu, (WIDTH, HEIGHT), grading);
        let mut last = luma_levels(&settled(&gpu, &mut renderer, &scene(), 24));
        let mut worst = 0usize;
        for frame in 0..PAN_FRAMES {
            renderer.set_frame_index(24 + frame);
            renderer.render(&gpu, &scene_panned(PAN_STEP * (frame + 1) as f32), CullPath::Gpu).expect("frame");
            let next = luma_levels(&renderer.capture(&gpu).expect("capture"));
            worst = worst.max(pan_flickers(&last, &next));
            last = next;
        }
        worst
    };
    let (plain, graded) = (flicker(Grading::NEUTRAL), flicker(showcase_grading()));
    println!("{{\"row\":\"grading-pan-flicker\",\"frames\":{PAN_FRAMES},\"plainPixels\":{plain},\"gradedPixels\":{graded}}}");
    // The showcase grade steepens mid-tones by at most about 1.3 (contrast 1.15, the LUT's
    // teal-orange): a pixel just under the plain run's threshold may cross it graded.
    assert!(graded as f32 <= plain as f32 * 1.3 + 4.0, "grading flickers {graded} pixels a pan frame against {plain}");
}

/// A `size` image of pre-exposed radiance for the cost row: brightness down, hues across.
fn timing_image((width, height): (u32, u32)) -> Vec<[f32; 4]> {
    (0..height)
        .flat_map(|y| {
            (0..width).map(move |x| {
                let level = libm::exp2f(-8.0 + 12.0 * y as f32 / (height - 1) as f32);
                let (u, v) = (x as f32 / width as f32, (x ^ y) as f32 % 7.0 / 7.0);
                [level * u, level * (1.0 - u), level * v, 1.0]
            })
        })
        .collect()
}

fn median(values: &mut [f32]) -> f32 {
    values.sort_by(f32::total_cmp);
    values[(values.len() - 1) / 2]
}

/// Passes a timed batch holds and batch pairs timed per variant.
const BATCH_PASSES: u32 = 64;
const BATCH_PAIRS: u32 = 24;

/// The tonemap pass's grading cost at `size` per variant (parametric, LUT, both) as JSON, and
/// both's cost: the median over batch pairs of the graded batch's time a pass less the plain
/// one's (each pair adjacent, so the machine's load lands on both alike), recorded beside each
/// side's fastest batch. None without timestamp queries.
fn pass_costs(gpu: &Gpu, size: (u32, u32)) -> Option<(String, f32)> {
    let texels = timing_image(size);
    let lut = showcase_grading().lut.expect("the showcase grade has a LUT");
    let variants = [
        ("parametric", Grading::NEUTRAL.with_contrast(1.15).with_vibrance(1.2)),
        ("lut", Grading::NEUTRAL.with_lut(lut, 0.8)),
        ("both", showcase_grading()),
    ];
    let mut rows = Vec::new();
    let mut both = 0.0;
    for (name, grading) in variants {
        let batches = genex_render::post::tonemap::grading_pass_ms(gpu, (size, &texels), (&grading, desktop()), (BATCH_PASSES, BATCH_PAIRS)).expect("timed")?;
        // The first pairs warm the pipelines and the LUT's cache lines.
        let batches = &batches[2..];
        let fastest = |k: usize| batches.iter().map(|pair| pair[k]).fold(f32::MAX, f32::min);
        let cost = median(&mut batches.iter().map(|pair| pair[1] - pair[0]).collect::<Vec<_>>());
        let plain = median(&mut batches.iter().map(|pair| pair[0]).collect::<Vec<_>>());
        rows.push(format!(
            "\"{name}\":{{\"costMs\":{cost:.4},\"plainMedianMs\":{plain:.4},\"plainFastestMs\":{:.4},\"gradedFastestMs\":{:.4}}}",
            fastest(0),
            fastest(1)
        ));
        both = cost;
    }
    Some((format!("\"{}x{}\":{{{}}}", size.0, size.1, rows.join(",")), both))
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_grading_costs_at_most_a_tenth_of_a_millisecond_at_1080p() {
    let Some(gpu) = gpu() else { return };
    // The tonemap pass alone, timed in adjacent batches: whole-frame times on a shared GPU move
    // by more than the 0.1 ms measured (three whole-frame runs at 1440p read -0.24, +0.49 and
    // -0.24 ms), and a single pass's own stamps overlap its neighbours' on Metal (0 to 2.2 ms).
    // 1080p is the feature budgets' resolution (`tests/fixtures/render-perf/budgets.json`);
    // 1440p is recorded.
    let Some((at_1080p, cost)) = pass_costs(&gpu, (1920, 1080)) else {
        eprintln!("skipped: no timestamp queries");
        return;
    };
    let (at_1440p, cost_1440p) = pass_costs(&gpu, (2560, 1440)).expect("timestamps");
    let row = format!("{{\"row\":\"grading-tonemap-pass\",\"adapter\":\"{}\",\"batchPasses\":{BATCH_PASSES},\"batchPairs\":{BATCH_PAIRS},{at_1080p},{at_1440p}}}", gpu.receipt().adapter);
    println!("{row}");
    if let Ok(path) = std::env::var("GENEX_PERF_OUT") {
        std::fs::write(path, format!("{row}\n")).expect("perf row");
    }
    // The 1440p capture row (plan section 7): the medium preset, settled, plain and graded.
    let scene = scene();
    for (name, grading) in [("plain", Grading::NEUTRAL), ("graded", showcase_grading())] {
        let capture = settled(&gpu, &mut renderer(&gpu, (2560, 1440), grading), &scene, 24);
        write_evidence(&format!("{name}-medium"), &capture);
    }
    println!("grading at 1440p: {cost_1440p:.4} ms");
    assert!(cost <= GRADING_MS_MAX, "grading (both) costs {cost} ms a pass at 1080p: {row}");
}
