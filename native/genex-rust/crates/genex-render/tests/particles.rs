//! GPU particles, renderer pass 2 A.11: soft billboards against the opaque scene, flipbooks,
//! back-to-front sorting (AMD's bitonic sort as Godot carries it) that gives the same order every
//! run, depth-buffer collision, and the cost of 64k particles. The CPU rows hold the sort's plan,
//! the per-class cap and the refusals; the `metal` rows draw.
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --release --test particles --offline --locked -- --include-ignored

use genex_render::capture::Capture;
use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
use genex_render::immediate::ImmediateFrame;
use genex_render::particles::{EmitterDesc, Flipbook, ParticleAtlas, SORT_BLOCK, SortDispatch, draw_stride, particle_cap, sort_pairs_on_gpu, sort_plan};
use genex_render::scene::{CameraDesc, Material, MeshId, scaled};
use genex_render::settings::{QualityPreset, SceneFormat};
use genex_render::texture::TextureData;
use genex_render::{CullPath, FrameRenderer, Gpu, Quality, RenderCode, RenderOptions};

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

/// An emitter of one particle a tick living `lifetime` ticks, standing still where it was born.
fn still(origin: [f32; 3], size: f32, color: [u8; 4], lifetime: u32) -> EmitterDesc {
    EmitterDesc {
        velocity: [0.0; 3],
        speed_jitter: 0.0,
        spread: 0.0,
        gravity: [0.0; 3],
        size,
        size_end: 1.0,
        color_start: color,
        color_end: color,
        rate_per_tick: 1,
        lifetime_ticks: lifetime,
        ..EmitterDesc::fountain(origin, 1)
    }
}

/// A renderer on the HDR path whose quality lets the depth prepass run (its consumers decide).
fn renderer(gpu: &Gpu, size: (u32, u32)) -> FrameRenderer {
    let mut renderer = FrameRenderer::new(gpu, size.0, size.1, RenderOptions::default()).expect("renderer");
    let mut quality = Quality::off();
    quality.hdr = true;
    quality.tonemap = true;
    quality.prepass = true;
    renderer.renderer_mut().set_quality(&quality);
    renderer.renderer_mut().set_scene_format(SceneFormat::Rgba16Float);
    renderer
}

fn draw(gpu: &Gpu, renderer: &mut FrameRenderer, frame: &ImmediateFrame) -> Capture {
    renderer.render(gpu, frame, CullPath::Gpu, None).expect("frame");
    renderer.capture(gpu).expect("capture")
}

/// A frame over a grey ground whose top is y = 0.
fn ground(camera: CameraDesc) -> ImmediateFrame {
    let mut frame = ImmediateFrame::new(camera, [12, 14, 20, 255]);
    frame.mesh(MeshId::CUBE, scaled([0.0, -0.05, 0.0], [40.0, 0.1, 40.0]), Material::color([90, 92, 96, 255]));
    frame
}

/// Where `world` lands in a `size` capture of `camera` (pixels, top-left origin).
fn pixel_of(camera: &CameraDesc, size: (u32, u32), world: [f32; 3]) -> (i32, i32) {
    let clip = camera.view_proj(size.0 as f32 / size.1 as f32) * glam::Vec4::new(world[0], world[1], world[2], 1.0);
    let (x, y) = (clip.x / clip.w, clip.y / clip.w);
    (((x * 0.5 + 0.5) * size.0 as f32) as i32, ((0.5 - y * 0.5) * size.1 as f32) as i32)
}

fn texel(capture: &Capture, (x, y): (i32, i32)) -> [u8; 3] {
    let at = (y as usize * capture.width() as usize + x as usize) * 4;
    let bgra = &capture.bgra()[at..at + 4];
    [bgra[2], bgra[1], bgra[0]]
}

/// Per row of column `x`: the largest channel difference between `a` and `b`.
fn column_difference(a: &Capture, b: &Capture, x: i32) -> Vec<u8> {
    (0..a.height() as i32).map(|y| (0..3).map(|c| texel(a, (x, y))[c].abs_diff(texel(b, (x, y))[c])).max().unwrap_or(0)).collect()
}

// ---------------------------------------------------------------------------------------------
// CPU rows

#[test]
fn the_sort_plan_is_a_block_sort_then_each_merge_s_global_steps_and_inner_rest() {
    assert_eq!(sort_plan(0), vec![]);
    assert_eq!(sort_plan(1), vec![]);
    assert_eq!(sort_plan(SORT_BLOCK), vec![SortDispatch::Block], "one block sorts in workgroup memory alone");
    assert_eq!(sort_plan(SORT_BLOCK + 1), vec![SortDispatch::Block, SortDispatch::Step(0), SortDispatch::Inner]);
    let full = sort_plan(16_384);
    let steps = full.iter().filter(|d| matches!(d, SortDispatch::Step(_))).count();
    let inner = full.iter().filter(|d| matches!(d, SortDispatch::Inner)).count();
    // Blocks of 2048: merges of 4096 to 16384, 1 + 2 + 3 global steps, one inner rest each; ten
    // dispatches for a full emitter (Godot's 512-pair blocks took 21).
    assert_eq!(SORT_BLOCK, 2048);
    assert_eq!((steps, inner, full.len()), (6, 3, 10));
    // Rows are taken in order, so every count's steps are a prefix of the shared table.
    let rows: Vec<usize> = full.iter().filter_map(|d| if let SortDispatch::Step(row) = d { Some(*row) } else { None }).collect();
    assert_eq!(rows, (0..6).collect::<Vec<_>>());
    assert_eq!(genex_render::particles::sort_steps().len(), 6);
}

#[test]
fn past_its_class_s_cap_a_frame_draws_every_n_th_slot() {
    let desktop = DeviceClass::new(FormFactor::Desktop, PerformanceTier::High);
    let phone = DeviceClass::new(FormFactor::Mobile, PerformanceTier::High);
    let low_phone = DeviceClass::new(FormFactor::Mobile, PerformanceTier::Low);
    assert!(particle_cap(desktop) >= 65_536, "desktop draws the 64k budget row whole");
    assert!(particle_cap(phone) < particle_cap(desktop) && particle_cap(low_phone) < particle_cap(phone));
    assert_eq!(draw_stride(65_536, particle_cap(desktop)), 1);
    assert_eq!(draw_stride(65_536, particle_cap(phone)), 2);
    assert_eq!(draw_stride(65_537, 32_768), 3);
    assert_eq!(draw_stride(0, 8_192), 1);
}

#[test]
fn a_flipbook_of_no_frames_or_an_atlas_of_no_cells_is_refused() {
    let atlas = |columns, rows| ParticleAtlas { image: TextureData::rgba8(64, 64, vec![255; 64 * 64 * 4]).expect("image"), columns, rows };
    assert!(atlas(4, 4).check().is_ok());
    assert_eq!(atlas(0, 4).check().expect_err("no columns").code(), RenderCode::TextureInvalid);
    assert_eq!(atlas(4, 17).check().expect_err("too many rows").code(), RenderCode::TextureInvalid);
    assert_eq!(atlas(4, 4).mip_levels(), 3, "16-texel cells keep mips down to 4 texels");
    let book = Flipbook { atlas: genex_render::particles::ParticleAtlasId::from_raw(0), frames: 0, cycles: 1.0, blend: false };
    let desc = EmitterDesc { flipbook: Some(book), ..EmitterDesc::fountain([0.0; 3], 1) };
    assert_eq!(desc.check().expect_err("no frames").code(), RenderCode::TextureInvalid);
}

#[test]
fn the_fountain_keeps_its_look_and_the_presets_opt_in() {
    let fountain = EmitterDesc::fountain([0.0; 3], 7);
    assert!(!fountain.sorted && !fountain.reads_depth() && fountain.flipbook.is_none(), "the fountain draws as before A.11");
    let gpu = fountain.to_gpu(30);
    assert_eq!(gpu.shape, [0.5, 0.0, 0.0, 0.0]);
    assert_eq!(gpu.flags, [0, 1, 0, 0]);
    assert!(EmitterDesc::steam([0.0; 3], 1).sorted && EmitterDesc::steam([0.0; 3], 1).reads_depth());
    assert!(EmitterDesc::rain([0.0; 3], [1.0; 3], 1).collision.is_some());
}

// ---------------------------------------------------------------------------------------------
// GPU rows

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_bitonic_sort_orders_by_key_then_slot_the_same_way_every_run() {
    let Some(gpu) = gpu() else { return };
    for count in [2u32, 7, 511, 512, 513, 1000, 2047, 2048, 2049, 4096, 5000, 9000, 16_383, 16_384] {
        // Many equal keys: the slot breaks every tie.
        let pairs: Vec<[u32; 2]> = (0..count).map(|slot| [slot.wrapping_mul(2_654_435_761) % 61, slot]).collect();
        let mut expected = pairs.clone();
        expected.sort_unstable();
        let first = sort_pairs_on_gpu(&gpu, &pairs).expect("sort");
        assert_eq!(first, expected, "{count} pairs sort by key then slot");
        let again = sort_pairs_on_gpu(&gpu, &pairs).expect("sort");
        assert_eq!(again, first, "{count} pairs: the same order again");
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_soft_particles_fade_where_they_meet_the_ground_instead_of_cutting_a_hard_line() {
    let Some(gpu) = gpu() else { return };
    let size = (256, 144);
    let camera = CameraDesc::look_at([0.0, 1.2, 6.0], [0.0, 0.3, 0.0]);
    let mut renderer = renderer(&gpu, size);
    // A big white puff standing half in the ground.
    let hard = renderer.add_emitter(&gpu, still([0.0, 0.0, 0.0], 3.0, [255, 255, 255, 255], 1)).expect("hard");
    let soft = renderer.add_emitter(&gpu, EmitterDesc { soft_distance: 2.0, ..still([0.0, 0.0, 0.0], 3.0, [255, 255, 255, 255], 1) }).expect("soft");
    let plain = draw(&gpu, &mut renderer, &ground(camera));
    let with = |emitter| {
        let mut frame = ground(camera);
        frame.particles(emitter, 0);
        frame
    };
    let hard_capture = draw(&gpu, &mut renderer, &with(hard));
    let soft_capture = draw(&gpu, &mut renderer, &with(soft));
    let x = size.0 as i32 / 2;
    let line = pixel_of(&camera, size, [0.0, 0.0, 0.0]).1;
    // Down the column to the ground line: the largest one-row step, the puff's level well above
    // the line and the rows on the way down at 15-85% of that level.
    let steps = |capture: &Capture| {
        let diff = column_difference(capture, &plain, x);
        let near: Vec<u8> = diff[(line - 16) as usize..(line + 4) as usize].to_vec();
        let step = near.windows(2).map(|w| w[0].abs_diff(w[1])).max().unwrap_or(0);
        let above = diff[(line - 30) as usize];
        let between = near.iter().filter(|&&v| u32::from(v) * 100 > u32::from(above) * 15 && u32::from(v) * 100 < u32::from(above) * 85).count();
        (step, above, between, near)
    };
    let (hard_step, hard_above, hard_between, hard_near) = steps(&hard_capture);
    let (soft_step, soft_above, soft_between, soft_near) = steps(&soft_capture);
    eprintln!("ground line at row {line}: hard step {hard_step}, {hard_between} rows between (puff {hard_above}) {hard_near:?}; soft step {soft_step}, {soft_between} rows between (puff {soft_above}) {soft_near:?}");
    assert!(hard_step >= 40 && hard_between <= 1, "the hard puff cuts a line into the ground ({hard_step} levels in one row, {hard_between} rows between)");
    assert!(soft_above >= 40, "the soft puff still draws above the ground ({soft_above})");
    assert!(soft_between >= 3 && soft_step * 2 <= hard_step, "the soft puff fades into the ground over rows ({soft_between} rows between, largest step {soft_step}: {soft_near:?})");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_sorted_emitter_draws_its_nearer_particle_over_the_farther() {
    let Some(gpu) = gpu() else { return };
    let size = (128, 72);
    let camera = CameraDesc::look_at([0.0, 0.0, 6.0], [0.0, 0.0, 0.0]);
    let mut renderer = renderer(&gpu, size);
    // Two particles: the newest (red) at the origin, the one before it (blue, half its life) a
    // metre nearer the camera. At tick 1 the nearer one holds slot 0, so slot order draws the
    // farther one over it.
    let pair = EmitterDesc {
        velocity: [0.0, 0.0, 1.0],
        color_start: [255, 0, 0, 255],
        color_end: [0, 0, 255, 255],
        ..still([0.0, 0.0, 0.0], 0.8, [255, 0, 0, 255], 2)
    };
    let unsorted = renderer.add_emitter(&gpu, pair).expect("unsorted");
    let sorted = renderer.add_emitter(&gpu, EmitterDesc { sorted: true, ..pair }).expect("sorted");
    let shot = |renderer: &mut FrameRenderer, emitter| {
        let mut frame = ImmediateFrame::new(camera, [0, 0, 0, 255]);
        frame.particles(emitter, 1);
        draw(&gpu, renderer, &frame)
    };
    let centre = pixel_of(&camera, size, [0.0, 0.0, 0.5]);
    let slot_order = texel(&shot(&mut renderer, unsorted), centre);
    let back_to_front = texel(&shot(&mut renderer, sorted), centre);
    let again = texel(&shot(&mut renderer, sorted), centre);
    eprintln!("slot order {slot_order:?}, sorted {back_to_front:?}");
    assert!(slot_order[0] > slot_order[2], "slot order draws the farther red one last: {slot_order:?}");
    // The nearer one is half way from red to blue: purple.
    let purple = back_to_front[2] >= 100 && back_to_front[0] + 80 <= slot_order[0];
    assert!(purple, "sorted, the nearer purple one covers the farther red one: {back_to_front:?} (slot order {slot_order:?})");
    // The same order on the next frame (within the frame-keyed output dither).
    assert!((0..3).all(|c| again[c].abs_diff(back_to_front[c]) <= 2), "the same order on the next frame: {again:?} against {back_to_front:?}");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_flipbook_plays_its_frames_over_a_particle_s_life() {
    let Some(gpu) = gpu() else { return };
    let size = (192, 64);
    let camera = CameraDesc::look_at([0.9, 0.0, 4.0], [0.9, 0.0, 0.0]);
    let mut renderer = renderer(&gpu, size);
    // A 2 x 2 atlas: red, green, blue, white cells of 16 texels.
    let cells: [[u8; 4]; 4] = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 255, 255]];
    let mut rgba = Vec::with_capacity(32 * 32 * 4);
    for y in 0..32 {
        for x in 0..32 {
            rgba.extend(cells[(y / 16) * 2 + x / 16]);
        }
    }
    let atlas = renderer.add_particle_atlas(&gpu, &ParticleAtlas { image: TextureData::rgba8(32, 32, rgba).expect("atlas"), columns: 2, rows: 2 }).expect("atlas");
    let book = Flipbook { atlas, frames: 4, cycles: 1.0, blend: false };
    // One particle a tick living 4 ticks, each moving 0.6 to the right a tick: at tick 3 they
    // stand at x 0, 0.6, 1.2 and 1.8 at ages 0..3, a quarter of their life apart.
    let row = EmitterDesc { velocity: [0.6, 0.0, 0.0], flipbook: Some(book), ..still([0.0, 0.0, 0.0], 0.45, [255, 255, 255, 255], 4) };
    let emitter = renderer.add_emitter(&gpu, row).expect("emitter");
    let mut frame = ImmediateFrame::new(camera, [0, 0, 0, 255]);
    frame.particles(emitter, 3);
    let capture = draw(&gpu, &mut renderer, &frame);
    let seen: Vec<[u8; 3]> = (0..4).map(|age| texel(&capture, pixel_of(&camera, size, [0.6 * age as f32, 0.0, 0.0]))).collect();
    eprintln!("frames by age: {seen:?}");
    let dominant = |c: [u8; 3]| if c[0] > 120 && c[1] > 120 && c[2] > 120 { 3 } else { (0..3).max_by_key(|&i| c[i]).unwrap_or(0) };
    assert_eq!(seen.iter().map(|c| dominant(*c)).collect::<Vec<_>>(), vec![0, 1, 2, 3], "ages 0..3 show the red, green, blue and white frames: {seen:?}");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_rain_stops_on_the_awning_it_falls_onto() {
    let Some(gpu) = gpu() else { return };
    let size = (192, 160);
    let camera = CameraDesc::look_at([0.0, 3.0, 5.0], [0.0, 0.6, 0.0]);
    let mut renderer = renderer(&gpu, size);
    // Rain over a 1.6 m square falling 0.1 a tick from 2.5 m: an awning 1 m up spans it.
    let rain = EmitterDesc { velocity: [0.0, -0.1, 0.0], speed_jitter: 0.0, lifetime_ticks: 40, rate_per_tick: 40, ..EmitterDesc::rain([0.0, 2.5, 0.0], [0.8, 0.0, 0.8], 3) };
    let falling = renderer.add_emitter(&gpu, EmitterDesc { collision: None, soft_distance: 0.0, color_start: [255; 4], color_end: [255; 4], ..rain }).expect("falling");
    let stopped = renderer.add_emitter(&gpu, EmitterDesc { soft_distance: 0.0, color_start: [255; 4], color_end: [255; 4], ..rain }).expect("stopped");
    let scene = || {
        let mut frame = ground(camera);
        frame.mesh(MeshId::CUBE, scaled([0.0, 0.95, 0.0], [2.0, 0.1, 2.0]), Material::color([60, 40, 40, 255]));
        frame
    };
    let plain = draw(&gpu, &mut renderer, &scene());
    let with = |renderer: &mut FrameRenderer, emitter| {
        let mut frame = scene();
        frame.particles(emitter, 120);
        draw(&gpu, renderer, &frame)
    };
    // Rows below the awning's front edge, where only rain that went through it can be.
    let below = pixel_of(&camera, size, [0.0, 0.9, 1.0]).1 + 3;
    let changed = |capture: &Capture| {
        let mut n = 0;
        for y in below.max(0)..size.1 as i32 {
            for x in 0..size.0 as i32 {
                let (a, b) = (texel(capture, (x, y)), texel(&plain, (x, y)));
                n += usize::from((0..3).any(|c| a[c].abs_diff(b[c]) > 12));
            }
        }
        n
    };
    let through = changed(&with(&mut renderer, falling));
    let collided = changed(&with(&mut renderer, stopped));
    eprintln!("rain below the awning: {through} pixels falling through, {collided} with collision (rows from {below})");
    assert!(through > 40, "without collision the rain falls through the awning ({through} pixels)");
    assert!(collided * 10 <= through, "with collision the rain stops on the awning ({collided} pixels against {through})");
}

/// GA (renderer pass 2): a rain streak passing just in front of the camera fades out instead of
/// drawing a wide streak across the lens for one frame. On Harbour Street a drop 0.6 m from the
/// camera drew a 9-pixel-wide streak over the shadowed street for exactly one frame (the
/// `metal_harbour_street_shadows_add_no_one_frame_pops_on_a_pan_or_a_creep` row's 43-pixel pop and
/// its 0.33-0.53% step), as engines' rain fades near the camera.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_rain_drop_just_in_front_of_the_camera_fades_out_while_a_far_one_draws() {
    let Some(gpu) = gpu() else { return };
    let size = (256, 144);
    let camera = CameraDesc::look_at([0.0, 1.5, 6.0], [0.0, 1.5, 0.0]);
    let mut renderer = renderer(&gpu, size);
    // One still drop of the rain preset's look, without the depth collision, at `distance` metres
    // in front of the camera; its size scaled with the distance so both cover the same pixels.
    let drop = |distance: f32| EmitterDesc {
        extent: [0.0; 3],
        velocity: [0.0; 3],
        speed_jitter: 0.0,
        spread: 0.0,
        size: 0.012 * distance / 0.5,
        rate_per_tick: 1,
        lifetime_ticks: 1,
        collision: None,
        soft_distance: 0.0,
        color_start: [255; 4],
        color_end: [255; 4],
        ..EmitterDesc::rain([0.0, 1.5, 6.0 - distance], [0.0; 3], 1)
    };
    let near = renderer.add_emitter(&gpu, drop(0.5)).expect("near");
    let far = renderer.add_emitter(&gpu, drop(6.0)).expect("far");
    let plain = draw(&gpu, &mut renderer, &ground(camera));
    let with = |renderer: &mut FrameRenderer, emitter| {
        let mut frame = ground(camera);
        frame.particles(emitter, 0);
        draw(&gpu, renderer, &frame)
    };
    let centre = (size.0 as i32 / 2, size.1 as i32 / 2);
    let lift = |capture: &Capture| (0..3).map(|c| texel(capture, centre)[c].abs_diff(texel(&plain, centre)[c])).max().unwrap_or(0);
    let (near_lift, far_lift) = (lift(&with(&mut renderer, near)), lift(&with(&mut renderer, far)));
    eprintln!("a white rain drop at the centre: {near_lift} levels at 0.5 m, {far_lift} at 6 m");
    assert!(far_lift >= 60, "a drop 6 m away draws ({far_lift} levels)");
    assert!(u32::from(near_lift) * 4 <= u32::from(far_lift), "a drop 0.5 m from the camera fades out ({near_lift} levels against {far_lift} at 6 m)");
}

/// The particles' budget (TIER-AB plan A.11): at most this many milliseconds of GPU time for 64k
/// particles.
const PARTICLES_64K_MS_MAX: f32 = 0.5;

/// GPU milliseconds `emitters` add to a bare 2560 x 1440 high frame over a ground (the median of
/// six rounds' median frame deltas), the particles drawn, and the rounds.
fn cost_over_bare_frame(gpu: &Gpu, emitters: &[EmitterDesc]) -> Option<(u32, f32, Vec<f32>)> {
    let size = (2560, 1440);
    let camera = CameraDesc::look_at([0.0, 1.7, 7.0], [0.0, 1.2, 0.0]);
    let quality = genex_render::presets::preset_quality(QualityPreset::High, DeviceClass::new(FormFactor::Desktop, PerformanceTier::High));
    let make = || {
        let mut renderer = FrameRenderer::new(gpu, size.0, size.1, RenderOptions::default()).expect("renderer");
        renderer.renderer_mut().set_quality(&quality);
        renderer.renderer_mut().set_scene_format(SceneFormat::Rgba16Float);
        renderer
    };
    let (mut bare, mut busy) = (make(), make());
    let ids: Vec<_> = emitters.iter().map(|desc| busy.add_emitter(gpu, *desc).expect("emitter")).collect();
    let slots: u32 = emitters.iter().map(EmitterDesc::slots).sum();
    let median = |values: &mut Vec<f32>| {
        values.sort_by(f32::total_cmp);
        values[values.len() / 2]
    };
    let mut deltas = Vec::new();
    for round in 0..7 {
        let mut times = [Vec::new(), Vec::new()];
        for tick in 0..48u64 {
            for (k, renderer) in [&mut bare, &mut busy].into_iter().enumerate() {
                let mut frame = ground(camera);
                if k == 1 {
                    for id in &ids {
                        frame.particles(*id, 400 + tick);
                    }
                }
                let landed = renderer.renderer_mut().arm_frame_timer(&gpu.queue)?;
                times[k].extend(landed);
                renderer.render(gpu, &frame, CullPath::Gpu, None).expect("frame");
                renderer.renderer_mut().finish_frame_timer();
                let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
            }
        }
        let [mut a, mut b] = times.map(|mut landed| {
            landed.drain(..8.min(landed.len()));
            landed
        });
        if round > 0 && !a.is_empty() && !b.is_empty() {
            deltas.push(median(&mut b) - median(&mut a));
        }
    }
    Some((slots, median(&mut deltas), deltas))
}

/// Four emitters of 16380 rain streaks over a 24 m by 40 m street seen from head height, sorted,
/// soft and colliding: every pass A.11 adds (the view depth, the path march, the sort, the gather
/// and the soft draw).
fn street_rain() -> Vec<EmitterDesc> {
    [-9.0f32, -3.0, 3.0, 9.0]
        .into_iter()
        .enumerate()
        .map(|(k, x)| EmitterDesc { rate_per_tick: 273, lifetime_ticks: 60, sorted: true, ..EmitterDesc::rain([x, 8.0, -14.0], [3.0, 0.0, 20.0], k as u32) })
        .collect()
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_64k_sorted_soft_colliding_rain_particles_cost_at_most_0_5_ms_at_1440p() {
    let Some(gpu) = gpu() else { return };
    if !gpu.device.features().contains(wgpu::Features::TIMESTAMP_QUERY) {
        eprintln!("skipped: no timestamp queries");
        return;
    }
    // The fill a frame pays for its particles' pixels grows with their size on screen like any
    // transparent's; here the streaks are rain's own.
    let Some((slots, cost, deltas)) = cost_over_bare_frame(&gpu, &street_rain()) else {
        eprintln!("skipped: no frame timer");
        return;
    };
    let row = format!("{slots} rain particles (4 emitters, sorted, soft, colliding) at 2560x1440 high: {cost:.3} ms over the bare frame (budget {PARTICLES_64K_MS_MAX}; rounds {deltas:?})");
    eprintln!("{row}");
    if let Some(path) = std::env::var_os("GENEX_PERF_OUT") {
        let line = format!("{}\n", serde_json::json!({ "row": "particles-64k-1440p", "detail": row, "ms": cost }));
        let mut file = std::fs::OpenOptions::new().create(true).append(true).open(path).expect("perf out");
        std::io::Write::write_all(&mut file, line.as_bytes()).expect("perf row");
    }
    assert!(slots >= 65_000, "the row draws 64k particles ({slots})");
    assert!(cost <= PARTICLES_64K_MS_MAX, "{row}");
}
