//! Light binning (RQ6.1, `genex_render::cluster`). The rows check what the binned shading relies
//! on: every point a light reaches, seen through the camera's real projection, finds that light in
//! its tile's mask and its z-bin's range (conservative, so no light is lost and none truncated);
//! the GPU build writes exactly the CPU reference's masks and z-bins, every word, on every run;
//! the preset's tile size and cap are the ones binned; and the bins take less memory than the
//! froxel lists they replaced. CPU rows run everywhere; real-GPU rows are `#[ignore]`d and every
//! name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked -- --ignored metal
//!
//! With `GENEX_LIGHT_BIN_CAPTURE_DIR` set, the GPU row writes a lights-per-tile heat map there as
//! `.ppm` evidence; with `GENEX_PERF_OUT` (a folder), the cost and memory rows write their JSON.

use std::path::PathBuf;
use std::sync::Mutex;

use genex_render::Gpu;
use genex_render::budget::{BudgetInput, BudgetKind, ledger};
use genex_render::cluster::{self, BOUNDS_EMPTY, ClusterInput, ClusterKind, ClusterSphere, LightBinFrame, LightBinRead, clusterables_at, lights_at};
use genex_render::device_class::DeviceClass;
use genex_render::layout::{GpuLight, GpuLightExt, GpuLocalLight, LIGHT_KIND_SPOT, MAX_LOCAL_LIGHTS};
use genex_render::presets::{preset_quality, reference_resolution};
use genex_render::scene::CameraDesc;
use genex_render::settings::{LightQuality, Quality, QualityPreset, SceneFormat};

/// The work package's scene: 1024 lights from a fixed seed.
const LIGHTS: usize = 1024;
const SEED: u32 = 0x5EED_0161;
/// The three tile sizes the GPU must match the reference at (the presets use 16 and 32).
const TILE_SIZES: [u32; 3] = [8, 16, 32];
const FULL_HD: (u32, u32) = (1920, 1080);
/// An odd render size: partial tiles on both edges.
const ODD: (u32, u32) = (1366, 771);
/// Points sampled inside each light's reach for the conservativeness rows.
const SAMPLES_PER_LIGHT: u32 = 24;
/// The plan's light binning budget at 1080p with 1024 lights (RQ6.1 acceptance).
const BUDGET_MS: f32 = 0.2;
const COST_SAMPLES: u32 = 60;

/// A deterministic xorshift stream of floats in 0..1.
struct Stream(u32);

impl Stream {
    fn next(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        (self.0 >> 8) as f32 / (1u32 << 24) as f32
    }

    fn range(&mut self, low: f32, high: f32) -> f32 {
        low + (high - low) * self.next()
    }
}

fn camera() -> CameraDesc {
    CameraDesc::look_at([2.0, 6.0, 18.0], [0.0, 1.0, -4.0])
}

fn light(position: [f32; 3], range: f32, ext: GpuLightExt) -> GpuLocalLight {
    let [x, y, z] = position;
    GpuLocalLight { light: GpuLight { position_range: [x, y, z, range], color: [1.0; 4] }, ext }
}

/// A spot's extension row pointing along `direction` (normalized here) with outer half-angle cosine.
fn spot_ext(direction: [f32; 3], cos_outer: f32) -> GpuLightExt {
    let length = direction.iter().map(|v| v * v).sum::<f32>().sqrt();
    let [x, y, z] = direction.map(|v| v / length);
    GpuLightExt { spot: [x, y, z, cos_outer], params: [1.0, LIGHT_KIND_SPOT, -1.0, 0.0] }
}

/// 1024 lights around the camera's view: most in front, some behind the eye, some through the
/// near plane, a quarter spots, ranges 0.3 to 8.
fn random_lights(seed: u32) -> Vec<GpuLocalLight> {
    let mut stream = Stream(seed);
    (0..LIGHTS)
        .map(|index| {
            let position = [stream.range(-30.0, 30.0), stream.range(-1.0, 9.0), stream.range(-60.0, 24.0)];
            let range = stream.range(0.3, 8.0);
            if index % 4 != 3 {
                return light(position, range, GpuLightExt::POINT);
            }
            let direction = [stream.range(-1.0, 1.0), stream.range(-1.0, 0.2), stream.range(-1.0, 1.0)];
            light(position, range, spot_ext(direction, stream.range(0.1, 0.98)))
        })
        .collect()
}

fn lights_quality(tile_px: u32) -> LightQuality {
    let mut quality = preset_quality(QualityPreset::Ultra, desktop_ultra()).lights;
    quality.tile_px = tile_px;
    quality.cap = MAX_LOCAL_LIGHTS as u32;
    quality
}

fn desktop_ultra() -> DeviceClass {
    DeviceClass::from_wire("desktop-ultra").expect("a class")
}

/// A point inside what `light` reaches (its range sphere, inside the cone for a spot), uniformly.
fn point_in_reach(light: &GpuLocalLight, stream: &mut Stream) -> Option<[f32; 3]> {
    let [x, y, z, range] = light.light.position_range;
    for _ in 0..64 {
        let offset = [stream.range(-1.0, 1.0), stream.range(-1.0, 1.0), stream.range(-1.0, 1.0)];
        let length = offset.iter().map(|v| v * v).sum::<f32>().sqrt();
        if length > 1.0 || length == 0.0 {
            continue;
        }
        let is_spot = light.ext.params[1] == LIGHT_KIND_SPOT;
        let along = offset[0] * light.ext.spot[0] + offset[1] * light.ext.spot[1] + offset[2] * light.ext.spot[2];
        if is_spot && along < light.ext.spot[3] * length {
            continue;
        }
        return Some([x + offset[0] * range, y + offset[1] * range, z + offset[2] * range]);
    }
    None
}

/// Where `point` lands through `camera`'s own view-projection on a `render` frame: its pixel and
/// view depth, or `None` when it is outside the view.
fn seen_at(camera: &CameraDesc, render: (u32, u32), point: [f32; 3]) -> Option<((u32, u32), f32)> {
    let clip = camera.view_proj(render.0 as f32 / render.1 as f32) * glam::Vec4::new(point[0], point[1], point[2], 1.0);
    if clip.w <= 0.0 {
        return None;
    }
    let ndc = clip.truncate() / clip.w;
    let inside = ndc.x.abs() <= 1.0 && ndc.y.abs() <= 1.0 && (0.0..=1.0).contains(&ndc.z);
    if !inside {
        return None;
    }
    let pixel_x = (((ndc.x + 1.0) * 0.5 * render.0 as f32) as u32).min(render.0 - 1);
    let pixel_y = (((1.0 - ndc.y) * 0.5 * render.1 as f32) as u32).min(render.1 - 1);
    let eye = glam::Vec3::from(camera.eye);
    let forward = (glam::Vec3::from(camera.target) - eye).normalize();
    Some(((pixel_x, pixel_y), (glam::Vec3::from(point) - eye).dot(forward)))
}

/// Every sampled point every binned light reaches finds that light in the walk over `bins`.
fn assert_conservative(what: &str, lights: &[GpuLocalLight], frame: &LightBinFrame, bins: &LightBinRead, render: (u32, u32)) -> usize {
    let camera = camera();
    let mut stream = Stream(SEED ^ 0xC0FFEE);
    let mut checked = 0;
    for (index, row) in frame.order.iter().enumerate() {
        let light = &lights[*row as usize];
        for _ in 0..SAMPLES_PER_LIGHT {
            let Some((pixel, depth)) = point_in_reach(light, &mut stream).and_then(|point| seen_at(&camera, render, point)) else { continue };
            let lit = lights_at(&bins.masks, &bins.zbins, pixel, depth);
            assert!(lit.contains(&(index as u32)), "{what}: sorted light {index} (row {row}) reaches pixel {pixel:?} at depth {depth} but is not binned there");
            checked += 1;
        }
    }
    checked
}

fn reference(frame: &LightBinFrame) -> LightBinRead {
    LightBinRead { masks: frame.reference_masks(), zbins: frame.reference_zbins() }
}

/// `got` equals `want` word for word; the message names the first word that differs.
fn assert_bins(what: &str, got: &LightBinRead, want: &LightBinRead, frame: &LightBinFrame) {
    assert_eq!(got.zbins, want.zbins, "{what}: z-bins (header then bins)");
    assert_eq!(got.masks.len(), want.masks.len(), "{what}: mask words");
    if let Some(at) = got.masks.iter().zip(&want.masks).position(|(a, b)| a != b) {
        let words = frame.grid.words_per_tile as usize;
        let tile = at / words;
        let (x, y) = (tile as u32 % frame.grid.tiles_x, tile as u32 / frame.grid.tiles_x);
        panic!("{what}: tile ({x}, {y}) word {} holds {:#010x}, the reference {:#010x}", at % words, got.masks[at], want.masks[at]);
    }
}

// --- CPU rows ---

/// `count` decal or probe spheres around the camera's view (radius 0.2 to `max_radius`), a few
/// hostile ones among them (not a number, a negative radius, an infinite radius).
fn random_spheres(seed: u32, count: usize, max_radius: f32) -> Vec<ClusterSphere> {
    let mut stream = Stream(seed);
    (0..count)
        .map(|index| {
            let centre = [stream.range(-30.0, 30.0), stream.range(-1.0, 9.0), stream.range(-60.0, 24.0)];
            let radius = stream.range(0.2, max_radius);
            match index % 97 {
                13 => ClusterSphere { centre: [f32::NAN, 0.0, 0.0], radius },
                29 => ClusterSphere { centre, radius: -1.0 },
                61 => ClusterSphere { centre, radius: f32::INFINITY },
                _ => ClusterSphere { centre, radius },
            }
        })
        .collect()
}

/// A point inside `sphere`, uniformly.
fn point_in_sphere(sphere: &ClusterSphere, stream: &mut Stream) -> Option<[f32; 3]> {
    if !sphere.radius.is_finite() || sphere.radius <= 0.0 || sphere.centre.iter().any(|v| !v.is_finite()) {
        return None;
    }
    let light = light(sphere.centre, sphere.radius, GpuLightExt::POINT);
    point_in_reach(&light, stream)
}

/// 200 lights, 300 decals and 40 probes in one binned index space.
fn mixed_frame(render: (u32, u32), tile_px: u32) -> (Vec<GpuLocalLight>, Vec<ClusterSphere>, Vec<ClusterSphere>, LightBinFrame) {
    let lights = random_lights(SEED)[..200].to_vec();
    let decals = random_spheres(SEED ^ 0xDEC0, 300, 2.0);
    let probes = random_spheres(SEED ^ 0x9B0B, 40, 12.0);
    let frame = LightBinFrame::prepare_clusterables(&lights, &ClusterInput { decals: &decals, probes: &probes }, &camera(), render, &lights_quality(tile_px));
    (lights, decals, probes, frame)
}

#[test]
fn decals_and_probes_share_the_lights_index_space_and_each_kind_walks_only_its_own_range() {
    // Renderer pass 2 A.0 (LG-16): lights, decals and probes are binned into one table, each kind
    // a contiguous index range with its own z-bins, so a kind's walk is the lights' walk over its
    // own range and adding decals or probes changes no light's walk.
    let (lights, decals, probes, frame) = mixed_frame(FULL_HD, 16);
    assert_eq!(frame.params.ranges, [200, 500, 540, 0], "lights, then decals, then probes");
    assert_eq!((frame.order.len(), frame.decals.len(), frame.probes.len()), (200, 300, 40));
    assert_eq!(frame.grid.words_per_tile, 540u32.div_ceil(32));
    let read = reference(&frame);
    let alone = LightBinFrame::prepare(&lights, &camera(), FULL_HD, &lights_quality(16));
    let alone_read = reference(&alone);
    assert_eq!(alone.order, frame.order, "the lights' order is their own");
    let mut stream = Stream(SEED ^ 0xBEEF);
    let mut checked = 0;
    for (kind, rows, spheres) in [(ClusterKind::Decal, &frame.decals, &decals), (ClusterKind::Probe, &frame.probes, &probes)] {
        let first = frame.first_index(kind);
        for (at, row) in rows.iter().enumerate() {
            for _ in 0..SAMPLES_PER_LIGHT {
                let Some((pixel, depth)) = point_in_sphere(&spheres[*row as usize], &mut stream).and_then(|point| seen_at(&camera(), FULL_HD, point)) else { continue };
                let found = clusterables_at(kind, &read.masks, &read.zbins, pixel, depth);
                assert!(found.contains(&(first + at as u32)), "{kind:?} {at} (row {row}) reaches {pixel:?} at {depth} but is not binned there");
                assert!(found.iter().all(|index| (first..first + rows.len() as u32).contains(index)), "{kind:?}'s walk stays in its range: {found:?}");
                let lit = lights_at(&read.masks, &read.zbins, pixel, depth);
                assert!(lit.iter().all(|index| *index < 200), "the light walk never reaches a decal or probe: {lit:?}");
                assert_eq!(lit, lights_at(&alone_read.masks, &alone_read.zbins, pixel, depth), "sharing the table changes no light's walk");
                checked += 1;
            }
        }
    }
    assert!(checked > 2000, "only {checked} sampled points were in view");
    for (index, sphere) in decals.iter().enumerate() {
        let at = frame.decals.iter().position(|row| *row as usize == index).expect("every decal row is binned") + frame.first_index(ClusterKind::Decal) as usize;
        let hostile = sphere.centre.iter().any(|v| v.is_nan()) || sphere.radius.is_nan() || sphere.radius <= 0.0;
        if hostile {
            assert_eq!(frame.bounds[at], BOUNDS_EMPTY, "decal row {index} is not a sphere");
        }
    }
    assert_eq!(LightBinFrame::prepare_clusterables(&lights, &ClusterInput { decals: &decals, probes: &probes }, &camera(), FULL_HD, &lights_quality(16)), frame, "the same every run");
}

#[test]
fn the_bin_table_holds_the_zbins_then_the_tiles_at_a_storage_binding_offset() {
    // LG-16: the forward pass binds one table; the v2 map binds its z-bins and tiles as two slices
    // of it, so the tiles start at an offset every core device can bind storage at.
    let offset = u64::from(cluster::LIGHT_TILES_OFFSET_WORDS) * 4;
    assert!(offset >= cluster::zbin_bytes(), "the tiles follow the z-bins");
    assert_eq!(offset % u64::from(wgpu::Limits::defaults().min_storage_buffer_offset_alignment), 0);
    assert_eq!(cluster::zbin_bytes(), u64::from(cluster::LIGHT_BIN_HEADER_WORDS + cluster::LIGHT_ZBINS * cluster::CLUSTER_KINDS as u32) * 4);
    let frame = LightBinFrame::prepare(&random_lights(SEED), &camera(), FULL_HD, &lights_quality(16));
    assert_eq!(cluster::bins_bytes(&frame.grid), offset + frame.grid.mask_bytes());
}

#[test]
fn every_point_a_light_reaches_finds_it_in_its_tile_and_zbin_at_three_tile_sizes() {
    let lights = random_lights(SEED);
    for (tile_px, render) in TILE_SIZES.into_iter().map(|tile| (tile, FULL_HD)).chain([(16, ODD)]) {
        let frame = LightBinFrame::prepare(&lights, &camera(), render, &lights_quality(tile_px));
        let what = format!("tile {tile_px} at {}x{}", render.0, render.1);
        assert_eq!(frame.order.len(), LIGHTS, "{what}: 1024 lights under a 1024 cap, none dropped");
        let checked = assert_conservative(&what, &lights, &frame, &reference(&frame), render);
        assert!(checked > LIGHTS * 4, "{what}: only {checked} sampled points were in view");
    }
}

#[test]
fn the_reference_binning_is_the_same_on_every_run() {
    let lights = random_lights(SEED);
    let first = LightBinFrame::prepare(&lights, &camera(), FULL_HD, &lights_quality(16));
    let again = LightBinFrame::prepare(&lights, &camera(), FULL_HD, &lights_quality(16));
    assert_eq!(first, again);
    assert_eq!(reference(&first), reference(&again));
}

#[test]
fn a_small_light_in_front_touches_only_its_tiles_and_one_off_screen_or_behind_touches_none() {
    let camera = CameraDesc::look_at([0.0, 0.0, 10.0], [0.0, 0.0, 0.0]);
    let quality = lights_quality(16);
    let lights = [
        light([0.0, 0.0, 0.0], 0.05, GpuLightExt::POINT),
        light([0.0, 0.0, 30.0], 2.0, GpuLightExt::POINT),
        light([500.0, 0.0, 0.0], 2.0, GpuLightExt::POINT),
        light([0.0, 0.0, -2000.0], 1.0, GpuLightExt::POINT),
    ];
    let frame = LightBinFrame::prepare(&lights, &camera, (640, 480), &quality);
    let index_of = |row: u32| frame.order.iter().position(|r| *r == row).expect("binned");
    let masks = frame.reference_masks();
    let tiles_with = |index: usize| (0..frame.grid.tiles()).filter(|tile| masks[*tile as usize * frame.grid.words_per_tile as usize] & (1 << index) != 0).count();
    let small = tiles_with(index_of(0));
    assert!((1..=4).contains(&small), "a 5 cm light 10 m away covers a few pixels: {small} tiles");
    for row in [1, 2, 3] {
        assert_eq!(frame.bounds[index_of(row)], BOUNDS_EMPTY, "row {row}: behind the eye, off to the side, past the far plane");
    }
}

#[test]
fn a_light_through_the_near_plane_or_infinite_covers_its_whole_view() {
    let camera = CameraDesc::look_at([0.0, 0.0, 10.0], [0.0, 0.0, 0.0]);
    let lights = [light([0.0, 0.0, 10.0], 3.0, GpuLightExt::POINT), light([0.0, 0.0, 0.0], f32::INFINITY, GpuLightExt::POINT)];
    let frame = LightBinFrame::prepare(&lights, &camera, (640, 480), &lights_quality(32));
    let read = reference(&frame);
    for pixel in [(0, 0), (639, 479), (320, 240), (0, 479)] {
        for depth in [0.1, 1.0, 2.9] {
            assert_eq!(lights_at(&read.masks, &read.zbins, pixel, depth).len(), 2, "pixel {pixel:?} depth {depth}");
        }
    }
}

#[test]
fn hostile_rows_bin_nothing_and_never_break_the_frame() {
    let lights = [
        light([f32::NAN, 0.0, 0.0], 1.0, GpuLightExt::POINT),
        light([0.0, 0.0, 0.0], -1.0, GpuLightExt::POINT),
        light([0.0, f32::INFINITY, 0.0], 1.0, GpuLightExt::POINT),
        light([0.0, 0.0, 0.0], f32::NAN, GpuLightExt::POINT),
        light([1.0, 1.0, 1.0], 2.0, spot_ext([0.0, -1.0, 0.0], f32::NAN)),
    ];
    let frame = LightBinFrame::prepare(&lights, &camera(), (320, 200), &lights_quality(16));
    assert_eq!(frame.order.len(), lights.len());
    for (index, row) in frame.order.iter().enumerate() {
        if *row < 4 {
            assert_eq!(frame.bounds[index], BOUNDS_EMPTY, "row {row} is not a light");
        }
    }
    let spot = frame.order.iter().position(|row| *row == 4).expect("binned");
    assert_ne!(frame.bounds[spot], BOUNDS_EMPTY, "a spot with a broken cone is binned as its range sphere");
    let empty = LightBinFrame::prepare(&[], &camera(), (320, 200), &lights_quality(16));
    assert_eq!((empty.order.len(), empty.grid.words_per_tile), (0, 1));
    assert!(reference(&empty).masks.iter().all(|word| *word == 0));
}

#[test]
fn each_preset_bins_with_its_own_tile_and_cap_dropping_the_farthest_lights() {
    let lights = random_lights(SEED);
    for class in DeviceClass::ALL {
        for preset in QualityPreset::ALL {
            let quality = preset_quality(preset, class).lights;
            let frame = LightBinFrame::prepare(&lights, &camera(), reference_resolution(class), &quality);
            let what = format!("{} {}", class.wire(), preset.wire());
            assert_eq!(frame.grid.tile_px, cluster::tile_px(&quality), "{what}");
            assert_eq!(frame.order.len(), (quality.cap as usize).min(LIGHTS), "{what}: the cap drops whole lights");
            let eye = camera().eye;
            let distance = |row: u32| {
                let [x, y, z, range] = lights[row as usize].light.position_range;
                let (dx, dy, dz) = (x - eye[0], y - eye[1], z - eye[2]);
                ((dx * dx + dy * dy + dz * dz).sqrt() - range).max(0.0)
            };
            let kept_farthest = frame.order.iter().map(|row| distance(*row)).fold(0.0f32, f32::max);
            let dropped_nearest = (0..LIGHTS as u32).filter(|row| !frame.order.contains(row)).map(distance).fold(f32::INFINITY, f32::min);
            assert!(kept_farthest <= dropped_nearest, "{what}: a dropped light ({dropped_nearest}) is nearer than a kept one ({kept_farthest})");
        }
    }
    assert_eq!(cluster::tile_px(&Quality::off().lights), cluster::LIGHT_TILE_MIN_PX, "the off quality's 0 tile is held to the minimum");
}

#[test]
fn the_bins_take_less_memory_than_the_froxel_lists_they_replaced_at_every_class() {
    let mut rows = Vec::new();
    for class in DeviceClass::ALL {
        for preset in QualityPreset::ALL {
            let quality = preset_quality(preset, class);
            if !quality.lights.clustered {
                continue;
            }
            let render = reference_resolution(class);
            let input = BudgetInput::new(render, 1.0, SceneFormat::Rgba16Float, false);
            let ledgered: u64 = ledger(&quality, &input).entries().iter().filter(|e| e.kind == BudgetKind::Target && e.label == "light-bins").map(|e| e.bytes).sum();
            let lights = quality.lights.cap.min(MAX_LOCAL_LIGHTS as u32);
            let grid = cluster::LightGrid::new(render, cluster::tile_px(&quality.lights), lights);
            let capped = cluster::froxel_list_bytes(render, quality.lights.tile_px, cluster::FROXEL_LIST_CAP);
            let uncapped = cluster::froxel_list_bytes(render, quality.lights.tile_px, lights);
            let bins = grid.mask_bytes() + cluster::zbin_bytes() + grid.axis_bytes();
            assert!(grid.mask_bytes() <= ledgered, "{} {}: the ledger holds the masks", class.wire(), preset.wire());
            assert!(bins < capped && capped <= uncapped, "{} {}: bins {bins}, capped froxel lists {capped}", class.wire(), preset.wire());
            rows.push(serde_json::json!({
                "class": class.wire(), "preset": preset.wire(), "render": [render.0, render.1], "tile_px": grid.tile_px, "lights": lights,
                "bins_bytes": bins, "mask_bytes": grid.mask_bytes(), "axis_bytes": grid.axis_bytes(), "ledger_bytes": ledgered, "froxel_capped_bytes": capped, "froxel_uncapped_bytes": uncapped,
                "saving_vs_capped": 1.0 - bins as f64 / capped as f64,
            }));
        }
    }
    assert!(!rows.is_empty());
    write_perf("RQ6.1-light-bin-memory.json", &serde_json::json!({
        "row": "light-bin-memory",
        "froxel_layout": { "slices": cluster::FROXEL_SLICES, "cap": cluster::FROXEL_LIST_CAP, "header_bytes": 8, "index_bytes": 2 },
        "rows": rows,
    }));
}

fn write_perf(name: &str, report: &serde_json::Value) {
    let Ok(dir) = std::env::var("GENEX_PERF_OUT") else { return };
    let dir = PathBuf::from(dir);
    std::fs::create_dir_all(&dir).expect("perf folder");
    std::fs::write(dir.join(name), serde_json::to_string_pretty(report).expect("json")).expect("perf written");
}

// --- GPU rows ---

/// Held by every GPU row: the cost row never shares the GPU with this file's other builds.
static GPU_ROWS: Mutex<()> = Mutex::new(());

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

/// Lights per tile as a heat map `.ppm` (black none, red to yellow to white more), one pixel per
/// render pixel.
fn write_capture(name: &str, frame: &LightBinFrame, read: &LightBinRead, render: (u32, u32)) {
    let Ok(dir) = std::env::var("GENEX_LIGHT_BIN_CAPTURE_DIR") else { return };
    let dir = PathBuf::from(dir);
    std::fs::create_dir_all(&dir).expect("capture folder");
    let words = frame.grid.words_per_tile as usize;
    let counts: Vec<u32> = read.masks.chunks(words).map(|tile| tile.iter().map(|word| word.count_ones()).sum()).collect();
    let most = counts.iter().copied().max().unwrap_or(0).max(1) as f32;
    let mut bytes = format!("P6\n{} {}\n255\n", render.0, render.1).into_bytes();
    for y in 0..render.1 {
        for x in 0..render.0 {
            let tile = (y / frame.grid.tile_px) * frame.grid.tiles_x + x / frame.grid.tile_px;
            let heat = (counts[tile as usize] as f32 / most).sqrt();
            let channel = |offset: f32| ((heat * 3.0 - offset).clamp(0.0, 1.0) * 255.0) as u8;
            bytes.extend([channel(0.0), channel(1.0), channel(2.0)]);
        }
    }
    std::fs::write(dir.join(format!("{name}.ppm")), bytes).expect("capture written");
}

/// The lights a ground plane (y = 0) shades per pixel through the walk, as a heat map `.ppm` (the
/// sky black), and the mean lights per lit pixel and per tile mask: what the binned shading costs.
fn write_ground_capture(name: &str, frame: &LightBinFrame, read: &LightBinRead, render: (u32, u32)) -> Option<(f64, f64)> {
    let dir = PathBuf::from(std::env::var("GENEX_LIGHT_BIN_CAPTURE_DIR").ok()?);
    std::fs::create_dir_all(&dir).expect("capture folder");
    let camera = camera();
    let inverse = camera.view_proj(render.0 as f32 / render.1 as f32).inverse();
    let eye = glam::Vec3::from(camera.eye);
    let forward = (glam::Vec3::from(camera.target) - eye).normalize();
    let counts: Vec<Option<usize>> = (0..render.0 * render.1)
        .map(|at| {
            let (x, y) = (at % render.0, at / render.0);
            let ndc = glam::Vec2::new((x as f32 + 0.5) / render.0 as f32 * 2.0 - 1.0, 1.0 - (y as f32 + 0.5) / render.1 as f32 * 2.0);
            let far = inverse.project_point3(ndc.extend(1.0));
            let direction = (far - eye).normalize();
            let distance = -eye.y / direction.y;
            (distance > 0.0).then(|| lights_at(&read.masks, &read.zbins, (x, y), (direction * distance).dot(forward)).len())
        })
        .collect();
    let most = counts.iter().flatten().copied().max().unwrap_or(0).max(1) as f32;
    let mut bytes = format!("P6\n{} {}\n255\n", render.0, render.1).into_bytes();
    for count in &counts {
        let heat = count.map_or(0.0, |count| (count as f32 / most).sqrt());
        let channel = |offset: f32| ((heat * 3.0 - offset).clamp(0.0, 1.0) * 255.0) as u8;
        bytes.extend([channel(0.0), channel(1.0), channel(2.0)]);
    }
    std::fs::write(dir.join(format!("{name}.ppm")), bytes).expect("capture written");
    let lit: Vec<usize> = counts.iter().flatten().copied().collect();
    let per_pixel = lit.iter().sum::<usize>() as f64 / lit.len().max(1) as f64;
    let per_tile = read.masks.iter().map(|word| u64::from(word.count_ones())).sum::<u64>() as f64 / frame.grid.tiles() as f64;
    Some((per_pixel, per_tile))
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_gpu_masks_and_zbins_equal_the_cpu_reference_for_1024_random_lights_at_three_tile_sizes() {
    let _gpu_rows = GPU_ROWS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let Some(gpu) = gpu() else { return };
    let lights = random_lights(SEED);
    let mut frames: Vec<(String, (u32, u32), LightBinFrame)> = TILE_SIZES
        .into_iter()
        .map(|tile| (format!("tile {tile} 1080p"), FULL_HD, LightBinFrame::prepare(&lights, &camera(), FULL_HD, &lights_quality(tile))))
        .collect();
    frames.push(("tile 16 odd".to_owned(), ODD, LightBinFrame::prepare(&lights, &camera(), ODD, &lights_quality(16))));
    // 33 lights (two mask words, the second nearly empty), and none at all.
    frames.push(("33 lights".to_owned(), (320, 200), LightBinFrame::prepare(&lights[..33], &camera(), (320, 200), &lights_quality(16))));
    frames.push(("no lights".to_owned(), (320, 200), LightBinFrame::prepare(&[], &camera(), (320, 200), &lights_quality(16))));
    // The first frame again: the cached bind group, and the second run of the same input.
    frames.push(("tile 8 1080p again".to_owned(), FULL_HD, frames[0].2.clone()));
    let only: Vec<LightBinFrame> = frames.iter().map(|(_, _, frame)| frame.clone()).collect();
    let reads = cluster::light_bins_gpu(&gpu, &only).expect("bins");
    assert_eq!(reads.len(), frames.len());
    for ((what, render, frame), read) in frames.iter().zip(&reads) {
        assert_bins(&format!("GPU {what}"), read, &reference(frame), frame);
        if frame.order.len() == LIGHTS {
            assert_conservative(&format!("GPU {what}"), &lights, frame, read, *render);
        }
    }
    assert_eq!(reads[0], reads[frames.len() - 1], "two runs of one frame are byte-identical");
    let rerun = cluster::light_bins_gpu(&gpu, &only[..1]).expect("bins");
    assert_eq!(rerun[0], reads[0], "a fresh node and fresh tables give the same bytes");
    write_capture("light-bin-1024-tile16-1080p-masks", &frames[1].2, &reads[1], FULL_HD);
    if let Some((per_pixel, per_tile)) = write_ground_capture("light-bin-1024-tile16-1080p-ground", &frames[1].2, &reads[1], FULL_HD) {
        eprintln!("1024 lights, 16-px tiles: {per_tile:.1} lights per tile mask, {per_pixel:.1} per ground pixel after the z-bins");
        write_perf("RQ6.1-light-bin-walk-1080p.json", &serde_json::json!({
            "row": "light-bin-walk", "lights": LIGHTS, "tile_px": 16, "render": [FULL_HD.0, FULL_HD.1],
            "mean_lights_per_tile_mask": per_tile, "mean_lights_per_ground_pixel": per_pixel,
        }));
    }
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_gpu_bins_of_lights_decals_and_probes_equal_the_cpu_reference() {
    let _gpu_rows = GPU_ROWS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let Some(gpu) = gpu() else { return };
    let frames: Vec<LightBinFrame> = [(FULL_HD, 16), (ODD, 8), ((320, 200), 32)].into_iter().map(|(render, tile)| mixed_frame(render, tile).3).collect();
    let reads = cluster::light_bins_gpu(&gpu, &frames).expect("bins");
    for (frame, read) in frames.iter().zip(&reads) {
        assert_bins("GPU lights, decals and probes", read, &reference(frame), frame);
    }
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_1024_lights_over_one_tile_are_all_shaded_without_truncation() {
    let _gpu_rows = GPU_ROWS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let Some(gpu) = gpu() else { return };
    // 1024 small lights 10 m in front of the eye, all within a few centimetres of the view axis:
    // every one covers the centre tile, at the same depths.
    let camera = CameraDesc::look_at([0.0, 0.0, 10.0], [0.0, 0.0, 0.0]);
    let mut stream = Stream(SEED);
    let lights: Vec<GpuLocalLight> =
        (0..LIGHTS).map(|_| light([stream.range(-0.02, 0.02), stream.range(-0.02, 0.02), stream.range(-0.05, 0.05)], 0.5, GpuLightExt::POINT)).collect();
    let render = FULL_HD;
    let frame = LightBinFrame::prepare(&lights, &camera, render, &lights_quality(16));
    assert_eq!(frame.order.len(), LIGHTS);
    let read = cluster::light_bins_gpu(&gpu, std::slice::from_ref(&frame)).expect("bins").remove(0);
    assert_bins("GPU one tile", &read, &reference(&frame), &frame);
    let centre = (render.0 / 2, render.1 / 2);
    let lit = lights_at(&read.masks, &read.zbins, centre, 10.0);
    assert_eq!(lit, (0..LIGHTS as u32).collect::<Vec<_>>(), "every light on the centre tile is shaded, in index order");
    write_capture("light-bin-1024-one-tile", &frame, &read, render);
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_light_binning_of_1024_lights_costs_within_its_budget_at_1080p() {
    let _gpu_rows = GPU_ROWS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let Some(gpu) = gpu() else { return };
    let lights = random_lights(SEED);
    let mut rows = Vec::new();
    for tile in TILE_SIZES {
        let frame = LightBinFrame::prepare(&lights, &camera(), FULL_HD, &lights_quality(tile));
        let Some(mut costs) = cluster::light_bin_gpu_ms(&gpu, &frame, COST_SAMPLES).expect("cost") else {
            eprintln!("skipped: no TIMESTAMP_QUERY");
            return;
        };
        assert!(!costs.is_empty(), "every sample resolved");
        costs.sort_by(f32::total_cmp);
        let p50 = costs[costs.len() / 2];
        let p95 = costs[(costs.len() * 95 / 100).min(costs.len() - 1)];
        eprintln!("light binning 1080p tile {tile}: p50 {p50:.4} ms, p95 {p95:.4} ms (budget {BUDGET_MS} ms)");
        rows.push((tile, p50, p95));
    }
    write_perf("RQ6.1-light-bin-cost-1080p.json", &serde_json::json!({
        "row": "light-bin-cost", "adapter": gpu.receipt().adapter, "backend": gpu.receipt().backend, "samples": COST_SAMPLES,
        "builds_per_sample": cluster::COST_BUILDS_PER_SAMPLE, "render": [FULL_HD.0, FULL_HD.1], "lights": LIGHTS, "budget_ms": BUDGET_MS,
        "tiles": rows.iter().map(|(tile, p50, p95)| serde_json::json!({ "tile_px": tile, "p50_ms": p50, "p95_ms": p95, "within_budget": *p95 <= BUDGET_MS })).collect::<Vec<_>>(),
    }));
    for (tile, _, p95) in rows {
        assert!(p95 <= BUDGET_MS, "binning 1024 lights at 1080p with {tile}-px tiles costs {p95} ms (p95), over {BUDGET_MS} ms");
    }
}
