//! B.9 follow-up on B.3's lake: where the water's reflection comes from. The probes over the water
//! (the fallback everywhere the screen misses, and the only reflection on phones), and on desktop
//! high and ultra the screen's reflection read from last frame's colour pyramid at the hit's
//! reprojected point and re-exposed (`water::reflect`).
//!
//! The CPU rows run everywhere. The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --release --offline --locked --test water_reflect -- --ignored metal --test-threads=1
//!
//! The pictures are drawn into an `rgba16float` target over a cleared (sky) scene depth, with no
//! in-scattering, foam, ripples or sun, so a water pixel is exactly its reflection times Fresnel.

use genex_render::Gpu;
use genex_render::layout::GpuFrame;
use genex_render::probes::GpuProbeRow;
use genex_render::water::reflect::{
    GpuWaterReflect, MAX_WATER_PROBES, RIPPLE_FREQUENCIES, WaterReflectFrame, coverage, environment, probes_for, reproject, ripple_roughness, ripple_weight, screen_mip,
};
use genex_render::water::{GpuWater, ReflectionSource, WATER, WaterBody, WaterFormats, WaterFrame, WaterInput, WaterMaterial, WaterNode, WaterPath, fresnel};
use glam::{Mat4, Vec2, Vec3, Vec4};

fn probe_row(min: [f32; 3], max: [f32; 3], blend: f32, capture: [f32; 3], layer: u32) -> GpuProbeRow {
    GpuProbeRow { min_blend: [min[0], min[1], min[2], blend], max_layer: [max[0], max[1], max[2], layer as f32], capture_intensity: [capture[0], capture[1], capture[2], 1.0] }
}

fn lake() -> WaterBody {
    WaterBody { centre: [0.0, 0.0, 20.0], half_extent: [30.0, 30.0], material: WaterMaterial { scatter: [0.0; 3], foam_width: 0.0, refraction: 0.0, roughness: 0.0, ripple: 0.0, ..WaterMaterial::LAKE } }
}

/// The boathouse probe: its box over the lake's left half (x < 0), from just under the water to
/// the roof.
fn boathouse(layer: u32) -> GpuProbeRow {
    probe_row([-40.0, -1.0, -20.0], [0.0, 8.0, 60.0], 2.0, [-10.0, 2.0, 20.0], layer)
}

// ---------------------------------------------------------------------------------------------
// CPU rows

#[test]
fn the_water_blends_the_captured_probes_covering_it_most_at_most_four_in_their_order() {
    let body = lake();
    let far = probe_row([100.0, -1.0, 0.0], [120.0, 5.0, 10.0], 1.0, [110.0, 1.0, 5.0], 2);
    let above = probe_row([-5.0, 3.0, 0.0], [5.0, 9.0, 10.0], 1.0, [0.0, 5.0, 5.0], 3);
    let uncaptured = boathouse(0);
    let small = |x: f32, layer: u32| probe_row([x, -1.0, 10.0], [x + 2.0, 4.0, 12.0], 0.5, [x + 1.0, 1.0, 11.0], layer);
    assert_eq!(coverage(&body, &far), 0.0, "a probe beside the lake does not reach it");
    assert_eq!(coverage(&body, &above), 0.0, "a probe whose influence ends above the water level does not");
    assert!(coverage(&body, &boathouse(1)) > 30.0 * 60.0, "the boathouse covers the lake's left half");
    assert!(probes_for(&body, &[uncaptured]).is_empty(), "a probe not captured yet weighs nothing");
    // The frame's rows (`ProbeMaps::frame_rows`) carry the irradiance volumes' too, at a negative layer.
    let volume = GpuProbeRow { max_layer: [0.0, 8.0, 60.0, -1.0], ..boathouse(1) };
    assert!(probes_for(&body, &[volume]).is_empty(), "an irradiance volume's row is no reflection probe");
    let rows = [small(-20.0, 4), far, boathouse(1), small(0.0, 5), small(10.0, 6), uncaptured, small(20.0, 7), above];
    let picked = probes_for(&body, &rows);
    assert_eq!(picked.len(), MAX_WATER_PROBES);
    let layers: Vec<u32> = picked.iter().map(|row| row.max_layer[3] as u32).collect();
    assert_eq!(layers, [4, 1, 5, 6], "the four covering most, in their given order (the last small one dropped: equal cover, later row)");
}

#[test]
fn the_reflection_row_is_the_wgsl_struct_and_a_still_frame_reprojects_to_itself() {
    let module = naga::front::wgsl::parse_str(WATER).expect("the water's WGSL parses");
    let row = module.types.iter().find(|(_, ty)| ty.name.as_deref() == Some("WaterReflect")).expect("the water reads its reflection row (struct WaterReflect)");
    let mut layouter = naga::proc::Layouter::default();
    layouter.update(module.to_ctx()).expect("layout");
    assert_eq!(layouter[row.0].size as usize, size_of::<GpuWaterReflect>(), "GpuWaterReflect mirrors `WaterReflect`");
    let (eye, _) = camera(Vec3::new(0.0, 6.0, -14.0));
    let body = lake();
    let still = GpuWaterReflect::new(&WaterReflectFrame { body: &body, view_proj: eye, prev_view_proj: eye, radiance_scale: 1.0, probes: &[] });
    let uv = Vec2::new(0.3, 0.7);
    assert!((reproject(Mat4::from_cols_array(&still.reprojection), uv, 0.01) - uv).length() < 1e-5);
    assert_eq!(still.screen[0], 1.0);
    assert_eq!(GpuWaterReflect::NONE.screen[0], 1.0, "a node never given a row reads the pyramid as it is");
    let unset = GpuWaterReflect::new(&WaterReflectFrame { body: &body, view_proj: eye, prev_view_proj: eye, radiance_scale: f32::NAN, probes: &[] });
    assert_eq!(unset.screen[0], 1.0, "an unknown exposure ratio reads the pyramid as it is");
}

#[test]
fn the_environment_twin_is_the_sky_off_the_probes_and_the_probe_inside_its_box() {
    let rows = [boathouse(1)];
    let sky = |_: Vec3| Vec3::new(0.3, 0.5, 0.8);
    let probe = |_: u32, _: Vec3| Vec3::new(0.9, 0.4, 0.1);
    let up = [0.0, 1.0, 0.0];
    assert_eq!(environment(&rows, [10.0, 0.0, 20.0], up, sky, probe), sky(Vec3::Y), "right of the box: the sky");
    assert_eq!(environment(&rows, [-20.0, 0.0, 20.0], up, sky, probe), probe(1, Vec3::Y), "inside: the probe");
    let edge = environment(&rows, [1.0, 0.0, 20.0], up, sky, probe);
    assert!(edge.x > 0.3 && edge.x < 0.9, "in the fade: between them, {edge}");
}

#[test]
fn the_glint_widens_with_the_roughness_and_keeps_a_still_lakes_power() {
    use genex_render::water::reflect::{GLINT_POWER_MAX, glint_power};
    assert_eq!(glint_power(WaterMaterial::LAKE.roughness), GLINT_POWER_MAX, "a smooth lake's glint stays sharp");
    let (near, far) = (glint_power(0.3), glint_power(0.45));
    assert!(near < GLINT_POWER_MAX && far < near && far > 1.0, "{near} {far}");
}

#[test]
fn the_screen_mip_follows_the_roughness_cone() {
    assert_eq!(screen_mip(0.0, 0.4, (960, 540), 5.0), 0.0, "a mirror reads mip 0");
    let smooth = screen_mip(0.08, 0.3, (960, 540), 5.0);
    let rough = screen_mip(0.3, 0.3, (960, 540), 5.0);
    assert!(smooth > 0.0 && rough > smooth && rough <= 5.0, "{smooth} {rough}");
}

#[test]
fn a_ripple_finer_than_the_pixel_fades_out_of_the_normal_into_the_roughness() {
    let finest = RIPPLE_FREQUENCIES[3];
    let wavelength = std::f32::consts::TAU / finest;
    assert_eq!(ripple_weight(finest, 0.1), 1.0, "a close pixel keeps every ripple");
    assert_eq!(ripple_weight(finest, wavelength * 0.5), 0.0, "past Nyquist a ripple is gone");
    let half_way = ripple_weight(finest, wavelength * 0.375);
    assert!(half_way > 0.4 && half_way < 0.6, "{half_way}");
    let ripple = WaterMaterial::LAKE.ripple;
    let roughness = WaterMaterial::LAKE.roughness;
    assert!((ripple_roughness(roughness, ripple, 0.05) - roughness).abs() < 1e-6, "nothing lost close up");
    assert!((ripple_roughness(roughness, 0.0, 10.0) - roughness).abs() < 1e-6, "a still lake keeps its roughness at any distance");
    let (mid, far) = (ripple_roughness(roughness, ripple, 0.8), ripple_roughness(roughness, ripple, 5.0));
    assert!(mid > roughness && far > mid && far < 0.5, "the lost slopes widen the reflection: {mid} {far}");
}

// ---------------------------------------------------------------------------------------------
// GPU rows

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

const SIZE: (u32, u32) = (320, 192);
const COLOUR: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;
const DEPTH: wgpu::TextureFormat = wgpu::TextureFormat::Depth32Float;
const SKY: Vec3 = Vec3::new(0.3, 0.5, 0.8);
/// The sun's radiance in the glint rows (linear, each channel).
const SUN_RADIANCE: f32 = 4.0;
/// The probe cube's faces (+X, -X, +Y, -Y, +Z, -Z): six colours, so a wrong box projection
/// shows as the wrong face.
const FACES: [Vec3; 6] = [Vec3::new(0.9, 0.2, 0.1), Vec3::new(0.1, 0.8, 0.2), Vec3::new(0.9, 0.7, 0.2), Vec3::new(0.2, 0.2, 0.2), Vec3::new(0.6, 0.1, 0.7), Vec3::new(0.1, 0.6, 0.8)];
/// The environment cube's face side: a texel well inside a face samples that face alone.
const FACE_SIDE: u32 = 16;
/// The wall the screen reflection shows: z, and its x and y extents.
const WALL_Z: f32 = 50.0;
const WALL_X: (f32, f32) = (-30.0, 30.0);
const WALL_Y: (f32, f32) = (0.0, 12.0);

fn camera(eye: Vec3) -> (Mat4, Mat4) {
    camera_sized(eye, SIZE)
}

/// The camera from `eye` (view-projection and projection) for a `size` frame.
fn camera_sized(eye: Vec3, size: (u32, u32)) -> (Mat4, Mat4) {
    let proj = glam::camera::rh::proj::directx::perspective_infinite_reverse(50f32.to_radians(), size.0 as f32 / size.1 as f32, 0.1);
    let view = glam::camera::rh::view::look_at_mat4(eye, Vec3::new(eye.x, 0.0, 20.0), Vec3::Y);
    (proj * view, proj)
}

fn frame_row(view_proj: Mat4, eye: Vec3, jitter: Vec2, sun: Option<Vec3>) -> GpuFrame {
    let forward = (Vec3::new(eye.x, 0.0, 20.0) - eye).normalize();
    let mut frame = GpuFrame { view_proj: view_proj.to_cols_array(), ..GpuFrame::default() };
    frame.camera_pos = [eye.x, eye.y, eye.z, 1.0];
    frame.camera_forward = [forward.x, forward.y, forward.z, 0.0];
    frame.sun_dir = [0.0, 1.0, 0.0, 0.0];
    if let Some(dir) = sun {
        let dir = dir.normalize();
        frame.sun_dir = [dir.x, dir.y, dir.z, 0.0];
        frame.sun_color = [SUN_RADIANCE, SUN_RADIANCE, SUN_RADIANCE, 1.0];
    }
    frame.cascade_splits = [0.0, 0.0, 1.0, 0.0];
    frame.jitter = [jitter.x, jitter.y, jitter.x, jitter.y];
    frame
}

fn texture(gpu: &Gpu, size: (u32, u32), layers: u32, format: wgpu::TextureFormat, usage: wgpu::TextureUsages) -> wgpu::Texture {
    gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: None,
        size: wgpu::Extent3d { width: size.0, height: size.1, depth_or_array_layers: layers },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage,
        view_formats: &[],
    })
}

fn half(c: Vec3) -> [u16; 4] {
    let h = genex_render::post::tonemap::f32_to_f16;
    [h(c.x), h(c.y), h(c.z), h(1.0)]
}

/// The environment: layer 0 the sky on every face, layer 1 the probe's six face colours.
fn environment_cube(gpu: &Gpu) -> wgpu::TextureView {
    let texture = texture(gpu, (FACE_SIDE, FACE_SIDE), 12, COLOUR, wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST);
    let texels = (FACE_SIDE * FACE_SIDE) as usize;
    let faces: Vec<u16> = (0..12).flat_map(|layer| std::iter::repeat_n(half(if layer < 6 { SKY } else { FACES[layer - 6] }), texels).flatten()).collect();
    gpu.queue.write_texture(
        texture.as_image_copy(),
        bytemuck::cast_slice(&faces),
        wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(FACE_SIDE * 8), rows_per_image: Some(FACE_SIDE) },
        wgpu::Extent3d { width: FACE_SIDE, height: FACE_SIDE, depth_or_array_layers: 12 },
    );
    texture.create_view(&wgpu::TextureViewDescriptor { dimension: Some(wgpu::TextureViewDimension::CubeArray), ..Default::default() })
}

/// The face `dir` looks at, or None within a texel and a half of a face's edge (filtered there).
fn face_of(dir: Vec3) -> Option<usize> {
    let a = dir.abs();
    let (major, axis) = if a.x >= a.y && a.x >= a.z { (a.x, 0) } else if a.y >= a.z { (a.y, 1) } else { (a.z, 2) };
    let minor = [a.x, a.y, a.z].iter().enumerate().filter(|(i, _)| *i != axis).map(|(_, v)| *v).fold(0.0f32, f32::max);
    if minor / major > 1.0 - 3.0 / FACE_SIDE as f32 {
        return None;
    }
    Some(axis * 2 + usize::from(dir[axis] < 0.0))
}

/// The wall drawn into `depth` (reverse-Z, cleared to 0) through `view_proj`; `None` leaves it
/// cleared (the sky behind everything).
fn draw_depth(gpu: &Gpu, view_proj: Mat4, depth: &wgpu::TextureView, wall: bool) {
    use wgpu::util::DeviceExt;
    let source = format!(
        "@group(0) @binding(0) var<uniform> view_proj: mat4x4<f32>;\n\
         @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {{\n\
           var c = array<vec2<f32>, 6>(vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(1.0, 1.0), vec2(0.0, 0.0), vec2(1.0, 1.0), vec2(0.0, 1.0));\n\
           let x = mix({:?}, {:?}, c[i].x);\n\
           let y = mix({:?}, {:?}, c[i].y);\n\
           return view_proj * vec4<f32>(x, y, {WALL_Z:?}, 1.0);\n\
         }}\n",
        WALL_X.0, WALL_X.1, WALL_Y.0, WALL_Y.1
    );
    let module = gpu.device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("wall"), source: wgpu::ShaderSource::Wgsl(source.into()) });
    let pipeline = gpu.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("wall"),
        layout: None,
        vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &[] },
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: Some(wgpu::DepthStencilState {
            format: DEPTH,
            depth_write_enabled: Some(true),
            depth_compare: Some(wgpu::CompareFunction::Greater),
            stencil: Default::default(),
            bias: Default::default(),
        }),
        multisample: Default::default(),
        fragment: None,
        multiview_mask: None,
        cache: None,
    });
    let uniform = gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: None, contents: bytemuck::cast_slice(&view_proj.to_cols_array()), usage: wgpu::BufferUsages::UNIFORM });
    let group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None,
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() }],
    });
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("wall"),
            color_attachments: &[],
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                view: depth,
                depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(0.0), store: wgpu::StoreOp::Store }),
                stencil_ops: None,
            }),
            ..Default::default()
        });
        if wall {
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.draw(0..6, 0..1);
        }
    }
    gpu.queue.submit([encoder.finish()]);
}

/// The world ray from `eye` through pixel (x, y) of a frame drawn with `view_proj`.
fn pixel_ray(view_proj: Mat4, eye: Vec3, x: u32, y: u32) -> Vec3 {
    let ndc = Vec4::new((x as f32 + 0.5) / SIZE.0 as f32 * 2.0 - 1.0, 1.0 - (y as f32 + 0.5) / SIZE.1 as f32 * 2.0, 0.5, 1.0);
    let far = view_proj.inverse() * ndc;
    (far.truncate() / far.w - eye).normalize()
}

/// The wall's code at world point `q` (red x, green y across the wall, blue a half): the colour
/// the history pyramid holds where it sees the wall.
fn wall_code(q: Vec3) -> Vec3 {
    Vec3::new((q.x - WALL_X.0) / (WALL_X.1 - WALL_X.0), (q.y - WALL_Y.0) / (WALL_Y.1 - WALL_Y.0), 0.5)
}

/// The bricks' size, m (a few pixels each at the wall's distance), and their mortar's width.
const BRICK: Vec2 = Vec2::new(3.0, 1.5);
const MORTAR_M: f32 = 0.3;

/// A brick pattern's shade at wall point `q` (dark mortar between bright bricks): the detail a
/// rippled reflection breaks up.
fn brick(q: Vec3) -> f32 {
    let row = (q.y / BRICK.y).floor();
    let x = q.x / BRICK.x + row * 0.5;
    let mortar = (x - x.floor()) * BRICK.x < MORTAR_M || (q.y / BRICK.y - row) * BRICK.y < MORTAR_M;
    if mortar { 0.25 } else { 1.0 }
}

/// Whether wall point `q` lies inside a brick, `margin` metres from its mortar.
fn inside_brick(q: Vec3, margin: f32) -> bool {
    let row = (q.y / BRICK.y).floor();
    let x = (q.x / BRICK.x + row * 0.5).fract() * BRICK.x;
    let y = (q.y / BRICK.y - row) * BRICK.y;
    x > MORTAR_M + margin && x < BRICK.x - margin && y > MORTAR_M + margin && y < BRICK.y - margin
}

/// Where `dir` from `origin` meets the wall, inside it by `inset` metres.
fn wall_hit(origin: Vec3, dir: Vec3, inset: f32) -> Option<Vec3> {
    if dir.z <= 1e-4 {
        return None;
    }
    let q = origin + dir * ((WALL_Z - origin.z) / dir.z);
    let inside = q.x > WALL_X.0 + inset && q.x < WALL_X.1 - inset && q.y > WALL_Y.0 + inset && q.y < WALL_Y.1 - inset;
    inside.then_some(q)
}

/// Sub-samples per axis of a pyramid texel's box filter (the base mip's).
const HISTORY_SUBSAMPLES: u32 = 4;
/// The colour pyramid's mips (A.6: half the render size down).
const HISTORY_MIPS: u32 = 5;

/// Last frame's picture seen from `eye` as A.6's colour pyramid: half the render size, each base
/// texel the mean of a 4 x 4 grid of rays (the wall's code, times its bricks with `bricks`; black
/// sky elsewhere), each further mip the mean of four texels of the one before.
fn history(gpu: &Gpu, eye: Vec3, bricks: bool) -> wgpu::TextureView {
    let (view_proj, _) = camera(eye);
    let base = (SIZE.0 / 2, SIZE.1 / 2);
    let n = HISTORY_SUBSAMPLES;
    let seen = |x: u32, y: u32| {
        let mut sum = Vec3::ZERO;
        for sy in 0..n {
            for sx in 0..n {
                let uv = Vec2::new((x as f32 + (sx as f32 + 0.5) / n as f32) / base.0 as f32, (y as f32 + (sy as f32 + 0.5) / n as f32) / base.1 as f32);
                let ndc = Vec4::new(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.5, 1.0);
                let far = view_proj.inverse() * ndc;
                let dir = (far.truncate() / far.w - eye).normalize();
                sum += wall_hit(eye, dir, 0.0).map_or(Vec3::ZERO, |q| wall_code(q) * if bricks { brick(q) } else { 1.0 });
            }
        }
        sum / (n * n) as f32
    };
    let mut mips = vec![(base, (0..base.1).flat_map(|y| (0..base.0).map(move |x| (x, y))).map(|(x, y)| seen(x, y)).collect::<Vec<Vec3>>())];
    for _ in 1..HISTORY_MIPS {
        let ((w, h), texels) = mips.last().expect("a mip");
        let (w, h, texels) = (*w, *h, texels.clone());
        let size = ((w / 2).max(1), (h / 2).max(1));
        let at = |x: u32, y: u32| texels[(y.min(h - 1) * w + x.min(w - 1)) as usize];
        let next = (0..size.1).flat_map(|y| (0..size.0).map(move |x| (x, y))).map(|(x, y)| (at(2 * x, 2 * y) + at(2 * x + 1, 2 * y) + at(2 * x, 2 * y + 1) + at(2 * x + 1, 2 * y + 1)) * 0.25).collect();
        mips.push((size, next));
    }
    let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("history pyramid"),
        size: wgpu::Extent3d { width: base.0, height: base.1, depth_or_array_layers: 1 },
        mip_level_count: HISTORY_MIPS,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: genex_render::screen_inputs::PYRAMID_FORMAT,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    for (mip, ((w, h), texels)) in mips.iter().enumerate() {
        let halves: Vec<u16> = texels.iter().flat_map(|c| half(*c)).collect();
        gpu.queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture: &texture, mip_level: mip as u32, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            bytemuck::cast_slice(&halves),
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(w * 8), rows_per_image: Some(*h) },
            wgpu::Extent3d { width: *w, height: *h, depth_or_array_layers: 1 },
        );
    }
    texture.create_view(&Default::default())
}

struct Shot<'a> {
    eye: Vec3,
    /// TAA's offset this frame, NDC (the water and the scene depth are drawn with it).
    jitter: Vec2,
    /// The sun's direction (towards it), lighting the glint at [`SUN_RADIANCE`]; None: no sun.
    sun: Option<Vec3>,
    material: WaterMaterial,
    reflection: ReflectionSource,
    wall: bool,
    history: Option<&'a wgpu::TextureView>,
    reflect: GpuWaterReflect,
}

/// A water node prepared for `shot` at `size`, with the targets it draws into.
struct Staged {
    node: WaterNode,
    colour: wgpu::Texture,
    world: wgpu::TextureView,
    _inputs: (wgpu::Buffer, wgpu::TextureView, wgpu::TextureView),
}

fn stage(gpu: &Gpu, shot: &Shot<'_>, size: (u32, u32)) -> Staged {
    use wgpu::util::DeviceExt;
    let device = &gpu.device;
    let (view_proj, proj) = camera_sized(shot.eye, size);
    let jittered = Mat4::from_translation(shot.jitter.extend(0.0)) * view_proj;
    let depth_usage = wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING;
    let sampled = texture(gpu, size, 1, DEPTH, depth_usage).create_view(&Default::default());
    let world = texture(gpu, size, 1, DEPTH, depth_usage).create_view(&Default::default());
    draw_depth(gpu, jittered, &sampled, shot.wall);
    draw_depth(gpu, jittered, &world, shot.wall);
    let colour = texture(gpu, size, 1, COLOUR, wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC);
    let env = environment_cube(gpu);
    let frame = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("frame"), contents: bytemuck::bytes_of(&frame_row(view_proj, shot.eye, shot.jitter, shot.sun)), usage: wgpu::BufferUsages::UNIFORM });
    let formats = WaterFormats { colour: COLOUR, depth: DEPTH, depth_reversed: true, colour_writes_depth: false };
    let mut node = WaterNode::new(device, formats).expect("the water node");
    let body = WaterBody { material: shot.material, ..lake() };
    let row = GpuWater::new(&WaterFrame { body, proj, prev_view_proj: view_proj, render: size, time: 0.0, env_mips: 1, path: WaterPath::Blended, reflection: shot.reflection, depth_reversed: true, fog: genex_render::fog::GpuFog::default() });
    node.set_reflection(&gpu.queue, &shot.reflect);
    node.prepare(device, &gpu.queue, &row, &WaterInput { frame: &frame, opaque: None, depth: &sampled, env: &env, history: shot.history });
    Staged { node, colour, world, _inputs: (frame, env, sampled) }
}

fn water_pass<'a>(encoder: &'a mut wgpu::CommandEncoder, colour: &'a wgpu::TextureView, world: &'a wgpu::TextureView, stamps: Option<&'a wgpu::QuerySet>) -> wgpu::RenderPass<'a> {
    encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("water"),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: colour, depth_slice: None, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store } })],
        depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment { view: world, depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store }), stencil_ops: None }),
        timestamp_writes: stamps.map(|set| wgpu::RenderPassTimestampWrites { query_set: set, beginning_of_pass_write_index: Some(0), end_of_pass_write_index: Some(1) }),
        ..Default::default()
    })
}

/// One water picture, rgba per pixel.
fn draw(gpu: &Gpu, shot: &Shot<'_>) -> Vec<Vec4> {
    let staged = stage(gpu, shot, SIZE);
    let view = staged.colour.create_view(&Default::default());
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    {
        let mut pass = water_pass(&mut encoder, &view, &staged.world, None);
        staged.node.draw_colour(&mut pass);
    }
    gpu.queue.submit([encoder.finish()]);
    read_rgba16f(gpu, &staged.colour)
}

/// The GPU milliseconds of one water draw of `shot` at `size`: the median of 15 samples (after 5
/// warm-up), each the mean of 8 draws in one pass; None without timestamps.
fn water_ms(gpu: &Gpu, shot: &Shot<'_>, size: (u32, u32)) -> Option<f32> {
    const DRAWS: u32 = 8;
    const SAMPLES: usize = 15;
    const WARM_UP: usize = 5;
    if !gpu.device.features().contains(wgpu::Features::TIMESTAMP_QUERY) {
        return None;
    }
    let staged = stage(gpu, shot, size);
    let view = staged.colour.create_view(&Default::default());
    let set = gpu.device.create_query_set(&wgpu::QuerySetDescriptor { label: Some("water cost"), ty: wgpu::QueryType::Timestamp, count: 2 });
    let resolve = gpu.device.create_buffer(&wgpu::BufferDescriptor { label: None, size: 16, usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false });
    let mut times = Vec::new();
    for run in 0..WARM_UP + SAMPLES {
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        {
            let mut pass = water_pass(&mut encoder, &view, &staged.world, Some(&set));
            for _ in 0..DRAWS {
                staged.node.draw_colour(&mut pass);
            }
        }
        encoder.resolve_query_set(&set, 0..2, &resolve, 0);
        let staging = gpu.device.create_buffer(&wgpu::BufferDescriptor { label: None, size: 16, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
        encoder.copy_buffer_to_buffer(&resolve, 0, &staging, 0, 16);
        gpu.queue.submit([encoder.finish()]);
        let slice = staging.slice(..);
        slice.map_async(wgpu::MapMode::Read, |result| result.expect("map"));
        gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
        let ticks: Vec<u64> = {
            let data = slice.get_mapped_range().expect("mapped");
            (0..2).map(|i| u64::from_le_bytes(data[i * 8..i * 8 + 8].try_into().expect("8 bytes"))).collect()
        };
        if let (true, Some(ms)) = (run >= WARM_UP, genex_render::timing::span_ms(ticks[0], ticks[1], gpu.queue.get_timestamp_period())) {
            times.push(ms / DRAWS as f32);
        }
    }
    times.sort_by(f32::total_cmp);
    times.get(times.len() / 2).copied()
}

fn read_rgba16f(gpu: &Gpu, texture: &wgpu::Texture) -> Vec<Vec4> {
    let (w, h) = (texture.width(), texture.height());
    let row = (w * 8).div_ceil(256) * 256;
    let staging = gpu.device.create_buffer(&wgpu::BufferDescriptor { label: None, size: u64::from(row * h), usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    encoder.copy_texture_to_buffer(
        texture.as_image_copy(),
        wgpu::TexelCopyBufferInfo { buffer: &staging, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(row), rows_per_image: Some(h) } },
        wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
    );
    gpu.queue.submit([encoder.finish()]);
    let slice = staging.slice(..);
    slice.map_async(wgpu::MapMode::Read, |result| result.expect("map"));
    gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
    let data = slice.get_mapped_range().expect("mapped");
    let f = |at: usize| genex_render::post::tonemap::f16_to_f32(u16::from_le_bytes([data[at], data[at + 1]]));
    (0..h).flat_map(|y| (0..w).map(move |x| (y * row + x * 8) as usize)).map(|at| Vec4::new(f(at), f(at + 2), f(at + 4), f(at + 6))).collect()
}

/// `rgba` as a binary PPM named `name` in `GENEX_WATER_OUT` when it is set (evidence to look at):
/// each water pixel's reflection (its colour over Fresnel), clamped to 1.
fn write_reflection(name: &str, rgba: &[Vec4], eye: Vec3) {
    let Ok(dir) = std::env::var("GENEX_WATER_OUT") else { return };
    let (view_proj, _) = camera(eye);
    let mut bytes = format!("P6\n{} {}\n255\n", SIZE.0, SIZE.1).into_bytes();
    for y in 0..SIZE.1 {
        for x in 0..SIZE.0 {
            let colour = water_point(view_proj, eye, x, y).map_or(Vec3::ZERO, |(_, _, f)| rgba[(y * SIZE.0 + x) as usize].truncate() / f);
            bytes.extend(colour.to_array().map(|c| (c.clamp(0.0, 1.0) * 255.0).round() as u8));
        }
    }
    std::fs::write(std::path::Path::new(&dir).join(format!("{name}.ppm")), bytes).expect("write the picture");
}

/// A water pixel's view: where its ray meets the lake and the reflected direction, or None off
/// the lake.
fn water_point(view_proj: Mat4, eye: Vec3, x: u32, y: u32) -> Option<(Vec3, Vec3, f32)> {
    let dir = pixel_ray(view_proj, eye, x, y);
    if dir.y >= -1e-4 {
        return None;
    }
    let p = eye + dir * (-eye.y / dir.y);
    let body = lake();
    let inside = (p.x - body.centre[0]).abs() < body.half_extent[0] - 0.5 && (p.z - body.centre[2]).abs() < body.half_extent[1] - 0.5;
    inside.then(|| (p, Vec3::new(dir.x, -dir.y, dir.z), fresnel(-dir.y)))
}

/// Phones (and every miss of the screen's march): the lake reflects the boathouse probe over its
/// left half, box-projected, and the sky past the probe's fade, as the forward pass would. Before
/// this the water read the sky layer alone everywhere.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_lake_reflects_the_probe_over_it_and_the_sky_past_it() {
    let Some(gpu) = gpu() else { return };
    let eye = Vec3::new(0.0, 6.0, -14.0);
    let (view_proj, _) = camera(eye);
    let rows = [boathouse(1)];
    let body = lake();
    let reflect = GpuWaterReflect::new(&WaterReflectFrame { body: &body, view_proj, prev_view_proj: view_proj, radiance_scale: 1.0, probes: &rows });
    let drawn = draw(&gpu, &Shot { eye, jitter: Vec2::ZERO, sun: None, material: lake().material, reflection: ReflectionSource::Environment, wall: false, history: None, reflect });
    write_reflection("probe-fallback", &drawn, eye);
    let (mut compared, mut in_probe, mut worst) = (0, 0, 0.0f32);
    for y in 0..SIZE.1 {
        for x in 0..SIZE.0 {
            let Some((p, r, f)) = water_point(view_proj, eye, x, y) else { continue };
            let on_an_edge = std::cell::Cell::new(false);
            let face = |_: u32, lookup: Vec3| {
                face_of(lookup).map_or_else(
                    || {
                        on_an_edge.set(true);
                        Vec3::ZERO
                    },
                    |face| FACES[face],
                )
            };
            let want = environment(&rows, p.to_array(), r.to_array(), |_| SKY, face);
            if on_an_edge.get() {
                continue;
            }
            let got = drawn[(y * SIZE.0 + x) as usize].truncate() / f;
            let off = ((got - want).abs() / want.max(Vec3::splat(0.05))).max_element();
            worst = worst.max(off);
            compared += 1;
            in_probe += usize::from(genex_render::probes::influence(&rows[0], p.to_array()) > 0.5);
        }
    }
    eprintln!("{compared} water pixels ({in_probe} under the probe), worst relative {worst:.4}");
    assert!(compared > 10_000 && in_probe > 4_000, "{compared} compared, {in_probe} under the probe");
    assert!(worst <= 0.03, "a water pixel's reflection is {worst} off its twin");
}

/// Desktop high and ultra: the screen's reflection is last frame's picture at the hit's
/// reprojected point, re-exposed. The camera moved 1.5 m sideways since the pyramid was written
/// (a pan) and the exposure halved: the reflected wall must still read the wall point the mirror
/// ray meets, at half the pyramid's radiance. Before this the water read the pyramid at this
/// frame's uv, so the reflection slid by the pan, and at the pyramid's exposure.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_screen_reflection_is_last_frames_picture_reprojected_and_re_exposed() {
    let Some(gpu) = gpu() else { return };
    let eye = Vec3::new(0.0, 6.0, -14.0);
    let before = eye - Vec3::new(1.5, 0.0, 0.0);
    let (view_proj, _) = camera(eye);
    let (prev_view_proj, _) = camera(before);
    let pyramid = history(&gpu, before, false);
    let body = lake();
    let scale = 0.5;
    let reflect = GpuWaterReflect::new(&WaterReflectFrame { body: &body, view_proj, prev_view_proj, radiance_scale: scale, probes: &[] });
    let drawn = draw(&gpu, &Shot { eye, jitter: Vec2::ZERO, sun: None, material: lake().material, reflection: ReflectionSource::ScreenThenEnvironment, wall: true, history: Some(&pyramid), reflect });
    let screen_uv = |vp: Mat4, q: Vec3| {
        let c = vp * q.extend(1.0);
        Vec2::new(c.x / c.w * 0.5 + 0.5, 0.5 - c.y / c.w * 0.5)
    };
    let central = |uv: Vec2| uv.cmpge(Vec2::splat(0.1)).all() && uv.cmple(Vec2::splat(0.9)).all();
    let (mut errors, mut exposure) = (Vec::new(), Vec::new());
    for y in 0..SIZE.1 {
        for x in 0..SIZE.0 {
            let Some((p, r, f)) = water_point(view_proj, eye, x, y) else { continue };
            let Some(q) = wall_hit(p, r, 1.0) else { continue };
            if !(central(screen_uv(view_proj, q)) && central(screen_uv(prev_view_proj, q))) {
                continue;
            }
            let got = drawn[(y * SIZE.0 + x) as usize].truncate() / f;
            // The pyramid's half blue, re-exposed: the share of radiance the frame should read.
            exposure.push((got.z - 0.5 * scale).abs() / (0.5 * scale));
            let code = got / scale;
            let seen = Vec2::new(WALL_X.0 + code.x * (WALL_X.1 - WALL_X.0), WALL_Y.0 + code.y * (WALL_Y.1 - WALL_Y.0));
            errors.push((seen - q.truncate()).length());
        }
    }
    let quantile = |values: &mut Vec<f32>, q: usize| {
        values.sort_by(f32::total_cmp);
        values.get(values.len() * q / 100).copied().unwrap_or(f32::MAX)
    };
    let (median, p95) = (quantile(&mut errors, 50), quantile(&mut errors, 95));
    let (exposure_median, exposure_p95) = (quantile(&mut exposure, 50), quantile(&mut exposure, 95));
    let misses = exposure.iter().filter(|e| **e > 0.5).count();
    eprintln!(
        "{} reflecting pixels: wall point off by median {median:.3} m, p95 {p95:.3} m; radiance off this frame's exposure by median {exposure_median:.4}, p95 {exposure_p95:.4}; {misses} show the environment (the march missed)",
        errors.len()
    );
    assert!(errors.len() > 2_000, "{} water pixels mirror the wall", errors.len());
    assert!(exposure_median <= 0.01 && exposure_p95 <= 0.05, "the reflection is off this frame's exposure: median {exposure_median}, p95 {exposure_p95}");
    assert!(median <= 0.15 && p95 <= 0.5, "the reflected wall slid: median {median} m, p95 {p95} m");
}

/// How many times the mirror lake's swing a rippled lake's reflection may swing over the jitter
/// cycle (p90, relative luminance; at least `RIPPLED_SWING_FLOOR`). The mirror lake's is the
/// colour pyramid's own (a half-size image read between texels); what the ripples add past it is
/// the sparkle TAA sees. Measured on this bench: 3.8x without the footprint filter, 2.2x with it.
const RIPPLED_SWING_RATIO_MAX: f32 = 2.5;
const RIPPLED_SWING_FLOOR: f32 = 0.1;

/// The lake's reflection of a brick wall over TAA's eight jitter offsets (a still camera): the
/// luminance swing per pixel, relative, at its 50th, 90th and 99th percentiles, over the pixels
/// that mirror the wall's interior in every frame.
fn jitter_swing(gpu: &Gpu, material: WaterMaterial) -> (usize, [f32; 3]) {
    let eye = Vec3::new(0.0, 6.0, -14.0);
    let (view_proj, _) = camera(eye);
    let pyramid = history(gpu, eye, true);
    let body = lake();
    let reflect = GpuWaterReflect::new(&WaterReflectFrame { body: &body, view_proj, prev_view_proj: view_proj, radiance_scale: 1.0, probes: &[] });
    let cycle = genex_render::settings::JitterCycle::Eight;
    let frames: Vec<Vec<Vec4>> = (0..u64::from(cycle.frames()))
        .map(|index| {
            let jitter = Vec2::from(genex_render::jitter::offset_ndc(genex_render::jitter::offset_px(index, cycle), SIZE));
            draw(gpu, &Shot { eye, jitter, sun: None, material, reflection: ReflectionSource::ScreenThenEnvironment, wall: true, history: Some(&pyramid), reflect })
        })
        .collect();
    let name = if material.ripple > 0.0 { "jitter-rippled" } else { "jitter-mirror" };
    write_reflection(name, &frames[0], eye);
    let mut swings = Vec::new();
    for y in 0..SIZE.1 {
        for x in 0..SIZE.0 {
            let Some((p, r, _)) = water_point(view_proj, eye, x, y) else { continue };
            // The pixels whose still mirror image lies well inside a brick.
            if !wall_hit(p, r, 2.0).is_some_and(|q| inside_brick(q, 0.35)) {
                continue;
            }
            let lumas: Vec<f32> = frames.iter().map(|frame| frame[(y * SIZE.0 + x) as usize].truncate().dot(Vec3::new(0.2126, 0.7152, 0.0722))).collect();
            let (low, high) = lumas.iter().fold((f32::MAX, f32::MIN), |(lo, hi), l| (lo.min(*l), hi.max(*l)));
            swings.push((high - low) / high.max(1e-4));
        }
    }
    swings.sort_by(f32::total_cmp);
    let at = |q: usize| swings.get(swings.len() * q / 100).copied().unwrap_or(f32::MAX);
    (swings.len(), [at(50), at(90), at(99)])
}

/// B.9 follow-up: the lake's screen reflection under TAA's jitter (a still camera, still ripples).
/// A mirror lake's reflection of a brick wall moves only as the pyramid's texels interpolate; a
/// rippled lake fades the ripples its pixel cannot hold and widens its roughness by the ripples'
/// spread over the pixel (`gx_water_surface`), so a sub-pixel move no longer swings the reflected
/// ray across metres of wall.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_lake_reflection_holds_still_under_taa_jitter() {
    let Some(gpu) = gpu() else { return };
    let mirror = WaterMaterial { ripple: 0.0, roughness: 0.0, ..lake().material };
    let rippled = WaterMaterial { ripple: WaterMaterial::LAKE.ripple, roughness: WaterMaterial::LAKE.roughness, ..lake().material };
    let (count, still) = jitter_swing(&gpu, mirror);
    let (rippled_count, moving) = jitter_swing(&gpu, rippled);
    eprintln!("mirror lake: {count} pixels, luminance swing p50 {:.4} p90 {:.4} p99 {:.4}", still[0], still[1], still[2]);
    eprintln!("rippled lake: {rippled_count} pixels, luminance swing p50 {:.4} p90 {:.4} p99 {:.4}", moving[0], moving[1], moving[2]);
    assert!(count > 400 && rippled_count == count, "{count} pixels mirror a brick's interior");
    let bound = (RIPPLED_SWING_RATIO_MAX * still[1]).max(RIPPLED_SWING_FLOOR);
    assert!(moving[1] <= bound, "the rippled lake's reflection swings by {} (p90) over the jitter cycle, the mirror lake's by {}", moving[1], still[1]);
}

/// The phone path's probe fallback costs little: the lake at 1080p drawn as a phone draws it
/// (blended, the environment's reflection) under four probes covering it, against none, within
/// the water's budget (`WATER_MS_MAX`, plan B.3).
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_probe_fallback_costs_little_on_the_phone_path() {
    let Some(gpu) = gpu() else { return };
    let size = (1920, 1080);
    let eye = Vec3::new(0.0, 6.0, -14.0);
    let (view_proj, _) = camera_sized(eye, size);
    let body = lake();
    let rows: Vec<GpuProbeRow> = (0..4).map(|i| probe_row([-40.0 + 15.0 * i as f32, -1.0, -20.0], [-10.0 + 15.0 * i as f32, 8.0, 60.0], 2.0, [-25.0 + 15.0 * i as f32, 2.0, 20.0], 1)).collect();
    let mut costs = Vec::new();
    for probes in [&rows[..0], &rows[..]] {
        let reflect = GpuWaterReflect::new(&WaterReflectFrame { body: &body, view_proj, prev_view_proj: view_proj, radiance_scale: 1.0, probes });
        assert_eq!(reflect.counts[0] as usize, probes.len());
        let shot = Shot { eye, jitter: Vec2::ZERO, sun: None, material: WaterMaterial::LAKE, reflection: ReflectionSource::Environment, wall: false, history: None, reflect };
        let Some(ms) = water_ms(&gpu, &shot, size) else {
            eprintln!("skipped: no timestamps");
            return;
        };
        costs.push(ms);
    }
    let row = format!("{{\"row\":\"water-probe-fallback-1080p\",\"no_probes_ms\":{:.4},\"four_probes_ms\":{:.4},\"budget_ms\":{}}}", costs[0], costs[1], genex_render::water::WATER_MS_MAX);
    println!("{row}");
    if let Ok(path) = std::env::var("GENEX_PERF_OUT") {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new().create(true).append(true).open(path).expect("perf out");
        writeln!(file, "{row}").expect("perf row");
    }
    assert!(costs[1] <= genex_render::water::WATER_MS_MAX, "the phone path's lake under four probes costs {} ms", costs[1]);
}

/// The most the rippled lake's luminance may swing over the jitter cycle, summed over its pixels,
/// relative to its summed light (the noise TAA must average away; a moving ripple leaves it no
/// still history to do so). Measured here: 1.06 without the footprint filter, 0.32 with it.
const GLINT_NOISE_MAX: f32 = 0.5;

/// The sun glint over TAA's eight jitter offsets on the rippled lake under a low sun ahead: the
/// share of water pixels whose luminance swings by more than the sky's whole reflection, the
/// largest swing, and the summed swings over the summed mean luminance (the temporal noise TAA
/// has to average, relative to the light).
fn glint_swing(gpu: &Gpu) -> (usize, f32, f32, f32) {
    let eye = Vec3::new(0.0, 6.0, -14.0);
    let (view_proj, _) = camera(eye);
    let body = lake();
    let reflect = GpuWaterReflect::new(&WaterReflectFrame { body: &body, view_proj, prev_view_proj: view_proj, radiance_scale: 1.0, probes: &[] });
    let sun = Some(Vec3::new(0.0, 0.12, 1.0));
    let cycle = genex_render::settings::JitterCycle::Eight;
    let frames: Vec<Vec<Vec4>> = (0..u64::from(cycle.frames()))
        .map(|index| {
            let jitter = Vec2::from(genex_render::jitter::offset_ndc(genex_render::jitter::offset_px(index, cycle), SIZE));
            draw(gpu, &Shot { eye, jitter, sun, material: WaterMaterial::LAKE, reflection: ReflectionSource::Environment, wall: false, history: None, reflect })
        })
        .collect();
    write_reflection("glint", &frames[0], eye);
    let luma = Vec3::new(0.2126, 0.7152, 0.0722);
    let (mut water, mut flicker, mut worst, mut swings, mut light) = (0usize, 0usize, 0.0f32, 0.0f64, 0.0f64);
    for y in 0..SIZE.1 {
        for x in 0..SIZE.0 {
            if water_point(view_proj, eye, x, y).is_none() {
                continue;
            }
            let lumas: Vec<f32> = frames.iter().map(|frame| frame[(y * SIZE.0 + x) as usize].truncate().dot(luma)).collect();
            let (low, high) = lumas.iter().fold((f32::MAX, f32::MIN), |(lo, hi), l| (lo.min(*l), hi.max(*l)));
            water += 1;
            worst = worst.max(high - low);
            swings += f64::from(high - low);
            light += f64::from(lumas.iter().sum::<f32>() / lumas.len() as f32);
            flicker += usize::from(high - low > SKY.dot(luma));
        }
    }
    (water, flicker as f32 / water.max(1) as f32, worst, (swings / light.max(1e-9)) as f32)
}

/// The sun's glint on the rippled lake under TAA's jitter: a ripple too fine for the pixel no
/// longer flashes the sun into one jittered sample and not the next.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_sun_glint_does_not_sparkle_under_taa_jitter() {
    let Some(gpu) = gpu() else { return };
    let (water, share, worst, noise) = glint_swing(&gpu);
    eprintln!("glint: {water} water pixels, {:.3}% swing past the sky's reflection, worst swing {worst:.3}, relative noise {noise:.4}", share * 100.0);
    assert!(water > 10_000, "{water} water pixels");
    assert!(noise <= GLINT_NOISE_MAX, "the rippled lake's light swings by {noise} of itself over the jitter cycle");
}
