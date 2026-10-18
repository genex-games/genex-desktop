//! Renderer pass 2 B.1: per-pixel subsurface scattering and diffuse transmission. A material's
//! [`Subsurface`] rides in its material-extension row (no binding) and the forward pass's
//! subsurface chunk lights it through the material: Filament's wrapped and forward scatter in the
//! scatter colour, Bevy's back Lambert lobe in the base colour, both through one shadow fetch that
//! measures how much material the light crossed.
//!
//! The CPU rows run everywhere. The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test subsurface -- --ignored metal
//!
//! `GENEX_RENDER_EVIDENCE_DIR` writes each fixture's tonemapped frame there (raw BGRA, 128x72).

use std::path::PathBuf;

use genex_render::capture::Capture;
use genex_render::layout::{MATERIAL_EXT_FLAG_EMISSIVE, MATERIAL_EXT_FLAG_SUBSURFACE, MATERIAL_EXT_NONE};
use genex_render::scene::{CameraDesc, Material, MeshId, Scene, scaled};
use genex_render::settings::{Look, Quality, SceneFormat, Tonemapper};
use genex_render::subsurface::{DEFAULT_SUBSURFACE_POWER, MIN_SUBSURFACE_DEPTH, Subsurface};
use genex_render::{CullPath, Gpu, RenderOptions, Renderer};

const WIDTH: u32 = 128;
const HEIGHT: u32 = 72;

// ---------------------------------------------------------------------------------------------
// CPU rows: the extension row

#[test]
fn a_subsurface_material_writes_its_scatter_and_transmission_into_its_extension_row() {
    let ext = Material::color([200, 200, 200, 255]).with_subsurface(Subsurface::WAX).to_gpu_ext();
    let [r, g, b] = Subsurface::WAX.color;
    assert_eq!(ext.subsurface, [r, g, b, Subsurface::WAX.thickness]);
    assert_eq!(ext.transmission, [Subsurface::WAX.power, Subsurface::WAX.transmission, Subsurface::WAX.depth, 0.0]);
    assert_eq!(ext.params[2] as u32, MATERIAL_EXT_FLAG_SUBSURFACE, "the flag runs the chunk");
    // With emission too, both flags are set and the emissive part is unchanged.
    let both = Material::color([200, 200, 200, 255]).with_emissive([255, 128, 0], 2.0).with_subsurface(Subsurface::LEAF).to_gpu_ext();
    assert_eq!(both.params[2] as u32, MATERIAL_EXT_FLAG_EMISSIVE | MATERIAL_EXT_FLAG_SUBSURFACE);
    assert_eq!(both.emissive, Material::color([200, 200, 200, 255]).with_emissive([255, 128, 0], 2.0).to_gpu_ext().emissive);
    assert_eq!(both.transmission[1], Subsurface::LEAF.transmission);
}

#[test]
fn a_material_that_lets_no_light_through_keeps_the_none_rows() {
    let opaque = [
        Material::color([90, 90, 90, 255]),
        Material::color([90, 90, 90, 255]).with_subsurface(Subsurface::new([0.8, 0.3, 0.1], 1.0)),
        Material::color([90, 90, 90, 255]).with_subsurface(Subsurface::new([0.0; 3], 0.0)),
    ];
    for (i, material) in opaque.into_iter().enumerate() {
        let ext = material.to_gpu_ext();
        assert_eq!((ext.subsurface, ext.transmission), (MATERIAL_EXT_NONE.subsurface, MATERIAL_EXT_NONE.transmission), "row {i}");
        assert_eq!(ext, MATERIAL_EXT_NONE, "row {i}: no flag, nothing to shade");
    }
}

#[test]
fn materials_that_scatter_differently_get_rows_of_their_own() {
    let base = Material::color([120, 160, 90, 255]);
    let rows = [base, base.with_subsurface(Subsurface::LEAF), base.with_subsurface(Subsurface::LEAF.with_transmission(0.3)), base.with_subsurface(Subsurface::SKIN)];
    for (i, a) in rows.iter().enumerate() {
        for b in &rows[i + 1..] {
            assert_ne!(a.to_gpu_ext(), b.to_gpu_ext(), "{a:?} and {b:?}");
        }
    }
    // Invisible scattering is the plain material's row.
    assert_eq!(base.with_subsurface(Subsurface::new([0.5; 3], 1.0)).to_gpu_ext(), base.to_gpu_ext());
}

#[test]
fn hostile_subsurface_inputs_write_finite_rows_in_range() {
    let hostile = [f32::NAN, f32::INFINITY, f32::NEG_INFINITY, -1.0, 0.0, 1e30];
    for value in hostile {
        let s = Subsurface { color: [value; 3], thickness: value, power: value, transmission: value, depth: value };
        let ext = Material::color([255; 4]).with_subsurface(s).to_gpu_ext();
        for v in ext.subsurface.iter().chain(&ext.transmission) {
            assert!(v.is_finite(), "{value}: {ext:?}");
        }
        assert!(ext.subsurface[..3].iter().all(|c| (0.0..=1.0).contains(c)), "{value}: colour {ext:?}");
        assert!((0.0..=1.0).contains(&ext.subsurface[3]), "{value}: thickness");
        assert!((0.0..=64.0).contains(&ext.transmission[0]), "{value}: power");
        assert!((0.0..=1.0).contains(&ext.transmission[1]), "{value}: transmission");
        let flagged = ext.params[2] as u32 & MATERIAL_EXT_FLAG_SUBSURFACE != 0;
        assert!(!flagged || ext.transmission[2] >= MIN_SUBSURFACE_DEPTH, "{value}: depth");
    }
    let nan = Subsurface { color: [0.5; 3], thickness: 0.2, power: f32::NAN, transmission: 0.0, depth: 0.01 }.sanitized();
    assert_eq!(nan.power, DEFAULT_SUBSURFACE_POWER);
}

// ---------------------------------------------------------------------------------------------
// GPU rows: the wax, skin and leaf fixtures

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

/// A single-sampled renderer on the `rgba16float` HDR scene at EV 0 (the scene reads back the
/// radiance), the AgX tonemap for the evidence frames.
fn renderer(gpu: &Gpu) -> Renderer {
    renderer_with(gpu, false)
}

/// [`renderer`] with the local lights binned (`clustered`) or walked in the legacy loop.
fn renderer_with(gpu: &Gpu, clustered: bool) -> Renderer {
    let mut renderer = Renderer::with_options(gpu, WIDTH, HEIGHT, RenderOptions { msaa: false }).expect("renderer");
    let mut quality = Quality::off();
    if clustered {
        quality.lights.clustered = true;
        quality.lights.cap = genex_render::layout::MAX_LOCAL_LIGHTS as u32;
        quality.lights.tile_px = 16;
    }
    quality.hdr = true;
    quality.tonemap = true;
    renderer.set_quality(&quality);
    renderer.set_scene_format(SceneFormat::Rgba16Float);
    let mut look = Look::default();
    look.tonemapper = Tonemapper::Agx;
    look.ev_compensation = 0.0;
    renderer.set_look(look);
    renderer
}

/// The scene's radiance (rgb per pixel, top row first) and its tonemapped frame, written as
/// evidence under `name`.
fn radiance(gpu: &Gpu, scene: &Scene, name: &str) -> Vec<[f32; 3]> {
    radiance_with(gpu, renderer(gpu), scene, name)
}

/// [`radiance`] through `renderer`.
fn radiance_with(gpu: &Gpu, mut renderer: Renderer, scene: &Scene, name: &str) -> Vec<[f32; 3]> {
    renderer.render(gpu, scene, CullPath::Gpu).expect("frame");
    assert!(renderer.last_scene().is_some_and(|path| path.hdr), "drawn on the HDR scene");
    let texels = renderer.read_scene(gpu).expect("the HDR scene reads back");
    let capture = renderer.capture(gpu).expect("capture");
    write_evidence(name, &capture);
    texels.iter().map(|t| [t[0], t[1], t[2]]).collect()
}

fn write_evidence(name: &str, capture: &Capture) {
    if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        let dir = PathBuf::from(dir);
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join(format!("subsurface-{name}.bgra")), capture.bgra()).expect("evidence");
    }
}

/// A dark scene (no ambient, black background) seen from +z, lit only by the sun from `toward_sun`.
fn sunlit(toward_sun: [f32; 3]) -> Scene {
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 0.0, 4.0], [0.0, 0.0, 0.0]), [0, 0, 0, 255]);
    scene.lighting.ambient_intensity = 0.0;
    scene.lighting.sun_dir = toward_sun;
    scene.lighting.sun_intensity = 3.0;
    scene.lighting.sun_color = [255, 255, 255];
    scene
}

/// The mean of `pick`ed pixels' radiance (rgb) over the pixels `keep` admits by (x, y).
fn mean(texels: &[[f32; 3]], keep: impl Fn(u32, u32) -> bool) -> [f32; 3] {
    let (mut sum, mut n) = ([0.0f32; 3], 0u32);
    for (i, t) in texels.iter().enumerate() {
        let (x, y) = (i as u32 % WIDTH, i as u32 / WIDTH);
        if keep(x, y) {
            for c in 0..3 {
                sum[c] += t[c];
            }
            n += 1;
        }
    }
    assert!(n > 0, "the region holds pixels");
    sum.map(|c| c / n as f32)
}

fn luminance(c: [f32; 3]) -> f32 {
    0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

/// A thin square leaf (2 x 2, 4 mm thick) facing the camera at the origin.
fn leaf_scene(material: Material, sun_behind: bool, blocker: bool) -> Scene {
    // From behind the leaf and a little above: the camera sees the face the sun does not light.
    let toward_sun = if sun_behind { [0.15, 0.25, -1.0] } else { [0.15, 0.25, 1.0] };
    let mut scene = sunlit(toward_sun);
    scene.draw(MeshId::CUBE, scaled([0.0; 3], [2.0, 2.0, 0.004]), material);
    if blocker {
        // An opaque card between the sun and the leaf's middle, hidden from the camera behind it.
        let l = glam::Vec3::from(toward_sun).normalize() * 0.8;
        scene.draw(MeshId::CUBE, scaled(l.to_array(), [0.7, 0.7, 0.02]), Material::color([60, 60, 60, 255]));
    }
    scene
}

/// The leaf's middle on screen (the blocker's shadow falls here).
fn leaf_middle(x: u32, y: u32) -> bool {
    x.abs_diff(WIDTH / 2) <= 3 && y.abs_diff(HEIGHT / 2) <= 3
}

/// A ring of the leaf away from its middle (out of the blocker's shadow), inside its silhouette.
fn leaf_rim(x: u32, y: u32) -> bool {
    let (dx, dy) = (x.abs_diff(WIDTH / 2), y.abs_diff(HEIGHT / 2));
    (9..=13).contains(&dx.max(dy))
}

fn leaf() -> Material {
    Material::color([90, 150, 50, 255]).with_pbr(0.0, 0.7).with_double_sided(true)
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_a_back_lit_leaf_shines_through_its_unlit_face() {
    let Some(gpu) = gpu() else { return };
    let plain = radiance(&gpu, &leaf_scene(leaf(), true, false), "leaf-plain");
    let lit = radiance(&gpu, &leaf_scene(leaf().with_subsurface(Subsurface::LEAF), true, false), "leaf-backlit");
    let (dark, glow) = (luminance(mean(&plain, leaf_rim)), luminance(mean(&lit, leaf_rim)));
    assert!(dark < 0.01, "an opaque leaf's unlit face is black without ambient ({dark})");
    assert!(glow > 0.05, "the leaf lets the sun through to the face the camera sees ({glow} vs {dark})");
    let through = mean(&lit, leaf_rim);
    assert!(through[1] > through[0] && through[1] > through[2], "the light through is the leaf's green: {through:?}");
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_a_caster_between_the_sun_and_a_leaf_shadows_the_light_through_it() {
    let Some(gpu) = gpu() else { return };
    let material = leaf().with_subsurface(Subsurface::LEAF);
    let open = radiance(&gpu, &leaf_scene(material, true, false), "leaf-open");
    let shaded = radiance(&gpu, &leaf_scene(material, true, true), "leaf-blocked");
    let (open_mid, shaded_mid) = (luminance(mean(&open, leaf_middle)), luminance(mean(&shaded, leaf_middle)));
    let (open_rim, shaded_rim) = (luminance(mean(&open, leaf_rim)), luminance(mean(&shaded, leaf_rim)));
    assert!(open_mid > 0.05, "the middle shines through without the caster ({open_mid})");
    assert!(shaded_mid < open_mid * 0.25, "the caster's shadow darkens the light through the middle ({shaded_mid} vs {open_mid})");
    assert!(shaded_rim > open_rim * 0.8, "the rim outside its shadow keeps its light ({shaded_rim} vs {open_rim})");
}

/// A glTF leaf's `KHR_materials_diffuse_transmission` (imported by `GlbMaterialExt::subsurface`:
/// the back Lambert lobe alone, no Filament scatter) shines through its unlit face in its green.
#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_a_glb_leaf_with_diffuse_transmission_shines_through_its_unlit_face() {
    use genex_render::mesh::{DEFAULT_IOR, GlbDiffuseTransmission, GlbMaterialExt};
    let Some(gpu) = gpu() else { return };
    let transmission = GlbDiffuseTransmission { factor: 0.6, texture: None, color: [1.0; 3], color_texture: None };
    let ext = GlbMaterialExt { ior: DEFAULT_IOR, specular: None, clearcoat: None, sheen: None, transmission: None, volume: None, anisotropy: None, diffuse_transmission: Some(transmission) };
    let imported = ext.subsurface().expect("diffuse transmission above 0 lets light through");
    let plain = radiance(&gpu, &leaf_scene(leaf(), true, false), "glb-leaf-plain");
    let lit = radiance(&gpu, &leaf_scene(leaf().with_subsurface(imported), true, false), "glb-leaf-backlit");
    let (dark, glow) = (luminance(mean(&plain, leaf_rim)), luminance(mean(&lit, leaf_rim)));
    assert!(glow > 0.05 && glow > dark * 10.0, "the imported leaf lets the sun through ({glow} vs {dark})");
    let through = mean(&lit, leaf_rim);
    assert!(through[1] > through[0] && through[1] > through[2], "in the base colour's green: {through:?}");
}

/// A sphere of radius 0.5 at the origin lit from +x: its left half is the shadow side.
fn sphere_scene(material: Material) -> Scene {
    let mut scene = sunlit([1.0, 0.0, 0.15]);
    scene.draw(MeshId::SPHERE, scaled([0.0; 3], [0.5; 3]), material);
    scene
}

/// A vertical band on the sphere's shadow side just past its terminator (the screen's centre
/// column is near N.L = 0.15; the band holds N.L about -0.1 to -0.35).
fn past_terminator(x: u32, y: u32) -> bool {
    (WIDTH / 2 - 7..=WIDTH / 2 - 2).contains(&x) && y.abs_diff(HEIGHT / 2) <= 6
}

/// The sphere's lit side (N.L well above 0).
fn lit_side(x: u32, y: u32) -> bool {
    (WIDTH / 2 + 4..=WIDTH / 2 + 9).contains(&x) && y.abs_diff(HEIGHT / 2) <= 6
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_wax_glows_past_its_terminator_and_stays_dark_through_its_thick_middle() {
    let Some(gpu) = gpu() else { return };
    let base = Material::color([235, 225, 205, 255]).with_pbr(0.0, 0.45);
    let plain = radiance(&gpu, &sphere_scene(base), "wax-plain");
    let wax = radiance(&gpu, &sphere_scene(base.with_subsurface(Subsurface::WAX)), "wax");
    let (dark, glow) = (mean(&plain, past_terminator), mean(&wax, past_terminator));
    assert!(luminance(dark) < 0.005, "an opaque sphere is black past its terminator ({dark:?})");
    assert!(luminance(glow) > 0.02, "wax carries light past its terminator ({glow:?})");
    assert!(glow[0] > glow[2] * 1.5, "in its warm scatter colour ({glow:?})");
    // Far round the back, the light would cross most of the sphere: the wax stays dark there.
    let far_back = mean(&wax, |x, y| (WIDTH / 2 - 22..=WIDTH / 2 - 18).contains(&x) && y.abs_diff(HEIGHT / 2) <= 3);
    assert!(luminance(far_back) < luminance(glow) * 0.5, "the thick middle lets less through ({far_back:?} vs {glow:?})");
    // The lit side keeps its direct light and gains only the soft scatter.
    let (lit_plain, lit_wax) = (luminance(mean(&plain, lit_side)), luminance(mean(&wax, lit_side)));
    assert!(lit_wax >= lit_plain && lit_wax < lit_plain * 1.6, "lit side {lit_wax} vs {lit_plain}");
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_skin_scatters_red_into_its_shadow_side() {
    let Some(gpu) = gpu() else { return };
    let base = Material::color([224, 172, 140, 255]).with_pbr(0.0, 0.5);
    let plain = radiance(&gpu, &sphere_scene(base), "skin-plain");
    let skin = radiance(&gpu, &sphere_scene(base.with_subsurface(Subsurface::SKIN)), "skin");
    let (dark, band) = (mean(&plain, past_terminator), mean(&skin, past_terminator));
    assert!(luminance(dark) < 0.005, "an opaque sphere is black past its terminator ({dark:?})");
    assert!(luminance(band) > 0.004, "skin scatters light past its terminator ({band:?})");
    assert!(band[0] > band[1] * 2.0, "the scattered light is red ({band:?})");
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_invisible_scattering_draws_the_plain_picture_byte_for_byte() {
    let Some(gpu) = gpu() else { return };
    let base = Material::color([200, 120, 90, 255]).with_pbr(0.0, 0.5);
    let plain = radiance(&gpu, &sphere_scene(base), "plain");
    let invisible = radiance(&gpu, &sphere_scene(base.with_subsurface(Subsurface::new([0.9, 0.2, 0.1], 1.0))), "invisible");
    assert_eq!(plain, invisible, "a thickness-1, no-transmission material shades exactly as before");
}

// ---------------------------------------------------------------------------------------------
// Timing: the chunk's cost at 1080p (renderer pass 2 plan section 5: <= +0.1 ms)

/// The plan's B.1 budget: what a screen full of a translucent material may add to a frame.
const SUBSURFACE_BUDGET_MS: f32 = 0.1;
/// Frames per block of the interleaved A/B, and the blocks of each side.
const COST_BLOCK_FRAMES: usize = 24;
const COST_BLOCKS: usize = 12;
/// Frames at the start of a block whose timings may still be the other side's (the timer lands a
/// frame's time a few frames later).
const COST_SETTLE_FRAMES: usize = 6;

/// A 1080p frame filled edge to edge by `material` (a wall of slabs and a row of spheres in front
/// of it, the sun grazing from behind and to the side so every lobe runs), desktop-high quality.
fn cost_scene(material: Material) -> Scene {
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 0.0, 4.0], [0.0, 0.0, 0.0]), [120, 160, 210, 255]);
    scene.lighting.sun_dir = [0.5, 0.4, -0.6];
    scene.draw(MeshId::CUBE, scaled([0.0, 0.0, -1.0], [12.0, 8.0, 0.01]), material);
    for i in 0..7 {
        scene.draw(MeshId::SPHERE, scaled([i as f32 - 3.0, 0.0, 0.5], [0.45; 3]), material);
    }
    scene
}

/// The median GPU frame time of each side over interleaved blocks of `scenes`, and the median of
/// the blocks' paired differences of their fastest frames (second minus first). Another process's
/// GPU work only ever adds time to a frame, so a block's fastest frame is its least disturbed and
/// neighbouring blocks share the conditions: the paired difference holds on a busy GPU where the
/// two medians do not.
fn interleaved_costs(gpu: &Gpu, renderer: &mut Renderer, scenes: [&Scene; 2]) -> Option<[f32; 3]> {
    let median = |mut c: Vec<f32>| -> f32 {
        c.sort_by(f32::total_cmp);
        c[c.len() / 2]
    };
    let mut blocks: [Vec<f32>; 2] = [Vec::new(), Vec::new()];
    let mut all: [Vec<f32>; 2] = [Vec::new(), Vec::new()];
    renderer.arm_frame_timer(&gpu.queue)?;
    renderer.finish_frame_timer();
    for block in 0..COST_BLOCKS * 2 {
        let side = block % 2;
        let mut costs = Vec::new();
        for frame in 0..COST_BLOCK_FRAMES {
            let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
            let landed = renderer.arm_frame_timer(&gpu.queue)?;
            if frame >= COST_SETTLE_FRAMES {
                costs.extend(landed);
            }
            renderer.render(gpu, scenes[side], CullPath::Gpu).expect("frame");
            renderer.finish_frame_timer();
        }
        all[side].extend(&costs);
        blocks[side].push(costs.iter().copied().fold(f32::INFINITY, f32::min));
    }
    let pairs: Vec<f32> = blocks[1].iter().zip(&blocks[0]).map(|(b, a)| b - a).collect();
    let [a, b] = all.map(median);
    Some([a, b, median(pairs)])
}

#[test]
#[ignore = "GPU timing: run alone with -- --ignored metal_subsurface_costs"]
fn metal_subsurface_costs_at_most_0_1_ms_over_a_full_1080p_screen() {
    use genex_render::device_class::DeviceClass;
    use genex_render::presets::preset_quality;
    use genex_render::settings::QualityPreset;
    let Some(gpu) = gpu() else { return };
    let mut renderer = Renderer::new(&gpu, 1920, 1080).expect("renderer");
    renderer.set_scene_format(SceneFormat::Rgba16Float);
    renderer.set_quality(&preset_quality(QualityPreset::High, DeviceClass::ALL[1]));
    let base = Material::color([150, 170, 110, 255]).with_pbr(0.0, 0.6);
    let (plain, translucent) = (cost_scene(base), cost_scene(base.with_subsurface(Subsurface::LEAF)));
    let Some([a, b, delta]) = interleaved_costs(&gpu, &mut renderer, [&plain, &translucent]) else {
        eprintln!("skipped: no TIMESTAMP_QUERY");
        return;
    };
    if let Ok(path) = std::env::var("GENEX_PERF_OUT") {
        let row = format!(
            "{{\"row\":\"subsurface\",\"render\":[1920,1080],\"class\":\"desktop-high\",\"plainP50Ms\":{a:.4},\"subsurfaceP50Ms\":{b:.4},\"pairedDeltaMs\":{delta:.4},\"budgetMs\":{SUBSURFACE_BUDGET_MS},\"adapter\":\"{}\"}}\n",
            gpu.receipt().adapter
        );
        std::fs::write(path, row).expect("perf row");
    }
    eprintln!("subsurface: plain {a:.3} ms, translucent {b:.3} ms, delta {delta:.3} ms");
    assert!(delta <= SUBSURFACE_BUDGET_MS, "a full screen of subsurface adds {delta:.3} ms at 1080p (budget {SUBSURFACE_BUDGET_MS})");
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_wax_glows_past_its_terminator_under_a_point_light_too() {
    use genex_render::scene::PointLight;
    let Some(gpu) = gpu() else { return };
    // A candle-lit sphere: no sun, a point light to its right.
    let scene = |material: Material| {
        let mut scene = sunlit([1.0, 0.0, 0.15]);
        scene.lighting.sun_intensity = 0.0;
        scene.lighting.points.push(PointLight { position: [2.0, 0.0, 0.3], color: [255, 200, 140], intensity: 6.0, range: 8.0 });
        scene.draw(MeshId::SPHERE, scaled([0.0; 3], [0.5; 3]), material);
        scene
    };
    let base = Material::color([235, 225, 205, 255]).with_pbr(0.0, 0.45);
    // The legacy loop (lights not binned) and the binned walk alike.
    for clustered in [false, true] {
        let name = |what: &str| format!("{what}-{}", if clustered { "binned" } else { "legacy" });
        let plain = radiance_with(&gpu, renderer_with(&gpu, clustered), &scene(base), &name("wax-point-plain"));
        let wax = radiance_with(&gpu, renderer_with(&gpu, clustered), &scene(base.with_subsurface(Subsurface::WAX)), &name("wax-point"));
        let (dark, glow) = (mean(&plain, past_terminator), mean(&wax, past_terminator));
        assert!(luminance(dark) < 0.005, "clustered {clustered}: an opaque sphere is black past the light's terminator ({dark:?})");
        assert!(luminance(glow) > 0.01, "clustered {clustered}: wax carries the point light past its terminator ({glow:?})");
    }
}
