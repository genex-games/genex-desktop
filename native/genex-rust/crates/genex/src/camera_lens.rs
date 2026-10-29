//! The engine's camera lens (WP-9's post stack): vignette, film grain, chromatic aberration and
//! barrel or fisheye distortion over the finished frame, one `Post` pass a game installs with
//! `game.gpu_pass("camera-lens", PassStage::Post, CameraLens::bodycam())`, so a body-cam,
//! found-footage or cinematic look never needs a hand-written lens shader.
//!
//! - **Clean tier**: [`CameraLens::new`] draws nothing, and a settled capture (the checks' and the
//!   judges' stills) is left clean unless the lens asks to be captured ([`CameraLens::in_captures`]).
//! - **Preset tiers**: on a quality drawing TAA on the HDR scene (`high`, `ultra`) the distortion
//!   resamples with a Catmull-Rom filter (five bilinear taps a channel), so edges stay as sharp as
//!   the frame drew them; elsewhere (`low`, `medium`, phones) one bilinear tap a channel.
//! - **Resolution-independent**: grain size and fringe width are in pixels of a 1080-row frame and
//!   scale with the output, so a 4K or 8K frame shows the same look as a 1080p one.
//! - **Edge-aware**: the centre of the frame is never moved by the fringe and the grain follows the
//!   picture's own luminance (most in the mid-tones, none in clipped white or black).

use crate::gpu::{self, GpuError, GpuPass, GpuPassCtx, PassSetup};
use genex_render::settings::{AntiAliasing, Quality};

/// The rows a lens's look is measured at: grain cells and fringe widths are pixels of this many rows.
const REFERENCE_ROWS: f32 = 1080.0;
/// The widest fringe a full chromatic aberration draws at a corner, reference pixels.
const FRINGE_MAX_PX: f32 = 6.0;
/// The most a full grain moves a mid-tone, display units (0..1).
const GRAIN_MAX: f32 = 0.12;
/// The strongest barrel a full distortion draws (`k1` of `r' = r (1 + k1 r^2)`, `r` 1 at a corner).
const DISTORTION_MAX: f32 = 0.6;

/// One frame's lens row (the shader's `GxLens`, three `vec4<f32>`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct GpuLens {
    /// x vignette 0..1, y grain amplitude (display units), z fringe at a corner (output pixels),
    /// w distortion `k1`.
    pub amount: [f32; 4],
    /// x the grain cell (output pixels), y the frame the grain is keyed to, z 1 for the full tier
    /// (Catmull-Rom) else 0, w the vignette's roundness (1 a circle, 0 the frame's aspect).
    pub shape: [f32; 4],
    /// xy the output size in pixels, zw one over it.
    pub output: [f32; 4],
}

impl GpuLens {
    /// The row's 48 bytes as the shader reads them (little-endian `f32`s).
    pub fn bytes(&self) -> Vec<u8> {
        [self.amount, self.shape, self.output].iter().flatten().flat_map(|value| value.to_le_bytes()).collect()
    }
}

/// The amounts a lens draws with (held to their ranges by [`CameraLens`]'s builders).
#[derive(Clone, Copy, Debug, PartialEq)]
struct LensLook {
    vignette: f32,
    grain: f32,
    grain_size: f32,
    chromatic_aberration: f32,
    distortion: f32,
    roundness: f32,
    in_captures: bool,
}

/// The clean look: nothing drawn.
const CLEAN: LensLook = LensLook { vignette: 0.0, grain: 0.0, grain_size: 1.0, chromatic_aberration: 0.0, distortion: 0.0, roundness: 1.0, in_captures: false };

/// The engine camera lens: build it with a style and adjust any amount, then install it at
/// `PassStage::Post`. Every amount is `0..=1` (held there); zero is that effect off.
pub struct CameraLens {
    look: LensLook,
    resources: Option<LensResources>,
}

impl Default for CameraLens {
    fn default() -> CameraLens {
        CameraLens::new()
    }
}

impl CameraLens {
    /// The clean lens: every effect off, the frame untouched.
    pub const fn new() -> CameraLens {
        CameraLens::with(CLEAN)
    }

    const fn with(look: LensLook) -> CameraLens {
        CameraLens { look, resources: None }
    }

    /// A chest-mounted body camera: a wide barrel, a round vignette, a little fringe and sensor grain.
    pub const fn bodycam() -> CameraLens {
        CameraLens::with(LensLook { vignette: 0.45, grain: 0.35, grain_size: 1.25, chromatic_aberration: 0.35, distortion: 0.4, roundness: 1.0, ..CLEAN })
    }

    /// A consumer camcorder's found footage: heavier grain, a softer vignette, a mild barrel.
    pub const fn found_footage() -> CameraLens {
        CameraLens::with(LensLook { vignette: 0.3, grain: 0.55, grain_size: 1.6, chromatic_aberration: 0.25, distortion: 0.15, roundness: 0.6, ..CLEAN })
    }

    /// A cinema lens: a faint vignette along the frame's aspect and fine grain, nothing bent.
    pub const fn cinematic() -> CameraLens {
        CameraLens::with(LensLook { vignette: 0.2, grain: 0.15, grain_size: 1.0, chromatic_aberration: 0.1, distortion: 0.0, roundness: 0.0, ..CLEAN })
    }

    /// The lens with a vignette of `amount` (how much a corner darkens).
    pub fn vignette(mut self, amount: f32) -> CameraLens {
        self.look.vignette = unit(amount);
        self
    }

    /// The lens with film grain of `amount`, its cells `size` pixels of a 1080-row frame (held to 0.5..=4).
    pub fn grain(mut self, amount: f32, size: f32) -> CameraLens {
        self.look.grain = unit(amount);
        self.look.grain_size = if size.is_finite() { size.clamp(0.5, 4.0) } else { 1.0 };
        self
    }

    /// The lens with chromatic aberration of `amount` (1: a 6-pixel fringe at a 1080p corner).
    pub fn chromatic_aberration(mut self, amount: f32) -> CameraLens {
        self.look.chromatic_aberration = unit(amount);
        self
    }

    /// The lens with barrel distortion of `amount` (1: a fisheye's bend); the frame is zoomed so its
    /// corners stay filled. Widen the camera's field of view by [`CameraLens::fov_scale`] to keep
    /// what the centre shows.
    pub fn distortion(mut self, amount: f32) -> CameraLens {
        self.look.distortion = unit(amount);
        self
    }

    /// The lens with a vignette `roundness` of the frame's aspect (0) to a circle (1).
    pub fn roundness(mut self, roundness: f32) -> CameraLens {
        self.look.roundness = unit(roundness);
        self
    }

    /// The lens drawn in settled captures too (off by default: checks and judges see the clean frame).
    pub fn in_captures(mut self, on: bool) -> CameraLens {
        self.look.in_captures = on;
        self
    }

    /// How much to widen the camera's vertical field of view (its tangent) so the distortion's
    /// zoom leaves the centre showing what it showed: `1 + k1`.
    pub fn fov_scale(&self) -> f32 {
        1.0 + self.look.distortion * DISTORTION_MAX
    }

    /// Whether the lens draws anything at all.
    pub fn is_clean(&self) -> bool {
        let look = &self.look;
        look.vignette == 0.0 && look.grain == 0.0 && look.chromatic_aberration == 0.0 && look.distortion == 0.0
    }

    /// Whether this frame draws the lens: a lens with an effect, outside a settled capture unless
    /// it asks to be captured.
    pub fn draws(&self, settling: bool) -> bool {
        !self.is_clean() && (self.look.in_captures || !settling)
    }

    /// The frame's row at `output` pixels, frame `frame`, under `quality` (the full tier on TAA over
    /// the HDR scene).
    pub fn row(&self, output: (u32, u32), frame: u64, quality: &Quality) -> GpuLens {
        let (width, height) = (output.0.max(1) as f32, output.1.max(1) as f32);
        let scale = height / REFERENCE_ROWS;
        let full = quality.hdr && quality.anti_aliasing == AntiAliasing::Taa;
        let look = &self.look;
        GpuLens {
            amount: [look.vignette, look.grain * GRAIN_MAX, look.chromatic_aberration * FRINGE_MAX_PX * scale, look.distortion * DISTORTION_MAX],
            shape: [(look.grain_size * scale).max(1.0), (frame % 65_536) as f32, f32::from(u8::from(full)), look.roundness],
            output: [width, height, 1.0 / width, 1.0 / height],
        }
    }
}

/// `amount` held to 0..=1 (NaN: 0).
fn unit(amount: f32) -> f32 {
    if amount.is_nan() { 0.0 } else { amount.clamp(0.0, 1.0) }
}

/// The lens's GPU objects: the copy of the finished frame it reads, its row, its group, its pipeline.
struct LensResources {
    copy: gpu::Texture,
    params: gpu::Buffer,
    group: gpu::BindGroup,
    pipeline: gpu::RenderPipeline,
}

impl<W: 'static> GpuPass<W> for CameraLens {
    fn rebuild(&mut self, setup: &mut PassSetup<'_>) -> Result<(), GpuError> {
        let (width, height) = setup.world_size();
        let copy = setup.create_texture(&gpu::TextureDescriptor {
            label: Some("camera lens source"),
            size: gpu::Extent3d { width, height, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: gpu::TextureDimension::D2,
            format: setup.world_format(),
            usage: gpu::TextureUsages::TEXTURE_BINDING | gpu::TextureUsages::COPY_DST,
            view_formats: &[],
        })?;
        let params = setup.create_buffer(&gpu::BufferDescriptor {
            label: Some("camera lens"),
            size: std::mem::size_of::<GpuLens>() as u64,
            usage: gpu::BufferUsages::UNIFORM | gpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        })?;
        let module = setup.create_shader("camera lens", CAMERA_LENS_WGSL)?;
        let sampler = setup.create_sampler(&gpu::SamplerDescriptor {
            label: Some("camera lens"),
            mag_filter: gpu::FilterMode::Linear,
            min_filter: gpu::FilterMode::Linear,
            ..Default::default()
        });
        let entries = [
            gpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: gpu::ShaderStages::FRAGMENT,
                ty: gpu::BindingType::Texture { sample_type: gpu::TextureSampleType::Float { filterable: true }, view_dimension: gpu::TextureViewDimension::D2, multisampled: false },
                count: None,
            },
            gpu::BindGroupLayoutEntry { binding: 1, visibility: gpu::ShaderStages::FRAGMENT, ty: gpu::BindingType::Sampler(gpu::SamplerBindingType::Filtering), count: None },
            gpu::BindGroupLayoutEntry {
                binding: 2,
                visibility: gpu::ShaderStages::FRAGMENT,
                ty: gpu::BindingType::Buffer { ty: gpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
                count: None,
            },
        ];
        let layout = setup.create_bind_group_layout(&gpu::BindGroupLayoutDescriptor { label: Some("camera lens"), entries: &entries });
        let view = copy.create_view(&gpu::TextureViewDescriptor::default());
        let group = setup.create_bind_group(&gpu::BindGroupDescriptor {
            label: Some("camera lens"),
            layout: &layout,
            entries: &[
                gpu::BindGroupEntry { binding: 0, resource: gpu::BindingResource::TextureView(&view) },
                gpu::BindGroupEntry { binding: 1, resource: gpu::BindingResource::Sampler(&sampler) },
                gpu::BindGroupEntry { binding: 2, resource: params.as_entire_binding() },
            ],
        });
        let pipeline_layout = setup.create_pipeline_layout(&gpu::PipelineLayoutDescriptor { label: Some("camera lens"), bind_group_layouts: &[Some(&layout)], immediate_size: 0 });
        let targets = [Some(gpu::ColorTargetState { format: setup.world_format(), blend: None, write_mask: gpu::ColorWrites::ALL })];
        let pipeline = setup.create_render_pipeline(&gpu::RenderPipelineDescriptor {
            label: Some("camera lens"),
            layout: Some(&pipeline_layout),
            vertex: gpu::VertexState { module: &module, entry_point: Some("vs_lens"), compilation_options: Default::default(), buffers: &[] },
            primitive: gpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: gpu::MultisampleState::default(),
            fragment: Some(gpu::FragmentState { module: &module, entry_point: Some("fs_lens"), compilation_options: Default::default(), targets: &targets }),
            multiview_mask: None,
            cache: None,
        });
        self.resources = Some(LensResources { copy, params, group, pipeline });
        Ok(())
    }

    fn run(&mut self, ctx: &mut GpuPassCtx<'_, '_, W>) {
        if !self.draws(ctx.settle().is_some()) {
            return;
        }
        let row = self.row(ctx.world_size(), ctx.frame_index(), ctx.quality());
        let Some(resources) = &self.resources else { return };
        // 48 bytes a frame, far inside the upload budget; a refusal only skips this frame's lens.
        if ctx.write_buffer(&resources.params, 0, &row.bytes()).is_err() {
            return;
        }
        let (Some(world), Some(target)) = (ctx.world_texture().cloned(), ctx.world_view().cloned()) else { return };
        let Some(encoder) = ctx.encoder() else { return };
        encoder.copy_texture_to_texture(world.as_image_copy(), resources.copy.as_image_copy(), world.size());
        let mut pass = encoder.begin_render_pass(&gpu::RenderPassDescriptor {
            label: Some("camera lens"),
            color_attachments: &[Some(gpu::RenderPassColorAttachment {
                view: &target,
                depth_slice: None,
                resolve_target: None,
                ops: gpu::Operations { load: gpu::LoadOp::Load, store: gpu::StoreOp::Store },
            })],
            ..Default::default()
        });
        pass.set_pipeline(&resources.pipeline);
        pass.set_bind_group(0, &resources.group, &[]);
        pass.draw(0..3, 0..1);
    }
}

/// The lens's shader: one full-screen triangle over a copy of the finished frame.
pub const CAMERA_LENS_WGSL: &str = r#"
struct GxLens {
    // x vignette, y grain amplitude, z corner fringe (output px), w distortion k1.
    amount: vec4<f32>,
    // x grain cell (px), y grain frame, z full tier (1) or bilinear (0), w vignette roundness.
    shape: vec4<f32>,
    // xy output size, zw 1 / it.
    output: vec4<f32>,
}
@group(0) @binding(0) var gx_lens_source: texture_2d<f32>;
@group(0) @binding(1) var gx_lens_sampler: sampler;
@group(0) @binding(2) var<uniform> gx_lens: GxLens;

@vertex fn vs_lens(@builtin(vertex_index) vertex: u32) -> @builtin(position) vec4<f32> {
    let uv = vec2<f32>(f32((vertex << 1u) & 2u), f32(vertex & 2u));
    return vec4<f32>(uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), 0.0, 1.0);
}

// Catmull-Rom through five bilinear taps (the corners' weights are dropped, under 1% of the sum).
fn gx_lens_bicubic(uv: vec2<f32>) -> vec3<f32> {
    let size = gx_lens.output.xy;
    let at = uv * size - 0.5;
    let base = floor(at) + 0.5;
    let f = at - floor(at);
    let w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
    let w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
    let w2 = f * (0.5 + f * (2.0 - 1.5 * f));
    let w3 = f * f * (-0.5 + 0.5 * f);
    let w12 = w1 + w2;
    let mid = (base + w2 / w12) * gx_lens.output.zw;
    let lo = (base - 1.0) * gx_lens.output.zw;
    let hi = (base + 2.0) * gx_lens.output.zw;
    var sum = textureSampleLevel(gx_lens_source, gx_lens_sampler, vec2<f32>(mid.x, lo.y), 0.0).rgb * (w12.x * w0.y);
    sum += textureSampleLevel(gx_lens_source, gx_lens_sampler, vec2<f32>(lo.x, mid.y), 0.0).rgb * (w0.x * w12.y);
    sum += textureSampleLevel(gx_lens_source, gx_lens_sampler, mid, 0.0).rgb * (w12.x * w12.y);
    sum += textureSampleLevel(gx_lens_source, gx_lens_sampler, vec2<f32>(hi.x, mid.y), 0.0).rgb * (w3.x * w12.y);
    sum += textureSampleLevel(gx_lens_source, gx_lens_sampler, vec2<f32>(mid.x, hi.y), 0.0).rgb * (w12.x * w3.y);
    let weight = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
    return max(sum / weight, vec3<f32>(0.0));
}

fn gx_lens_tap(uv: vec2<f32>) -> vec3<f32> {
    if gx_lens.shape.z > 0.5 {
        return gx_lens_bicubic(uv);
    }
    return textureSampleLevel(gx_lens_source, gx_lens_sampler, uv, 0.0).rgb;
}

fn gx_lens_hash(p: vec3<u32>) -> f32 {
    var v = p * vec3<u32>(1664525u, 1013904223u, 2654435761u);
    v.x += v.y * v.z;
    v.y += v.z * v.x;
    v.z += v.x * v.y;
    v = v ^ (v >> vec3<u32>(16u));
    return f32(v.x ^ v.y ^ v.z) * (1.0 / 4294967296.0);
}

@fragment fn fs_lens(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let uv = position.xy * gx_lens.output.zw;
    let aspect = gx_lens.output.x * gx_lens.output.w;
    // Centred, aspect-corrected, a corner at radius 1.
    let centred = (uv - 0.5) * 2.0;
    let scaled = centred * vec2<f32>(aspect, 1.0) * inverseSqrt(aspect * aspect + 1.0);
    let r2 = dot(scaled, scaled);
    // Barrel: r' = r (1 + k r^2), zoomed by 1 / (1 + k) so the corners stay inside the frame.
    let k = gx_lens.amount.w;
    let bend = (1.0 + k * r2) / (1.0 + k);
    // The fringe grows with r^2: none at the centre, the full width at a corner.
    let fringe = gx_lens.amount.z * r2 * gx_lens.output.w * 2.0;
    let red = 0.5 + centred * 0.5 * (bend * (1.0 + fringe));
    let green = 0.5 + centred * 0.5 * bend;
    let blue = 0.5 + centred * 0.5 * (bend * (1.0 - fringe));
    var colour = gx_lens_tap(green);
    if gx_lens.amount.z > 0.0 {
        colour = vec3<f32>(gx_lens_tap(red).r, colour.g, gx_lens_tap(blue).b);
    }
    // Vignette: cos^4-like falloff over the frame's aspect (0) to a circle (1).
    let round = mix(dot(centred, centred) * 0.5, r2, gx_lens.shape.w);
    let falloff = 1.0 - gx_lens.amount.x * smoothstep(0.15, 1.0, round);
    colour *= falloff * falloff;
    // Grain on the display value, strongest in the mid-tones, keyed to the cell and the frame.
    if gx_lens.amount.y > 0.0 {
        let cell = vec2<u32>(position.xy / gx_lens.shape.x);
        let noise = gx_lens_hash(vec3<u32>(cell, u32(gx_lens.shape.y))) - 0.5;
        let display = sqrt(clamp(colour, vec3<f32>(0.0), vec3<f32>(1.0)));
        let luma = dot(display, vec3<f32>(0.2126, 0.7152, 0.0722));
        let amplitude = gx_lens.amount.y * 4.0 * luma * (1.0 - luma);
        let grained = clamp(display + vec3<f32>(noise * amplitude), vec3<f32>(0.0), vec3<f32>(1.0));
        colour = grained * grained;
    }
    return vec4<f32>(colour, 1.0);
}
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
    use genex_render::presets::preset_quality;
    use genex_render::settings::QualityPreset;

    fn quality(preset: QualityPreset) -> Quality {
        preset_quality(preset, DeviceClass::new(FormFactor::Desktop, PerformanceTier::Ultra))
    }

    #[test]
    fn the_clean_lens_never_draws_and_a_settled_capture_stays_clean_unless_asked() {
        assert!(CameraLens::new().is_clean());
        assert!(!CameraLens::new().draws(false));
        let bodycam = CameraLens::bodycam();
        assert!(bodycam.draws(false), "Live frames draw the lens");
        assert!(!bodycam.draws(true), "a settled capture is the clean frame");
        assert!(bodycam.in_captures(true).draws(true), "unless the lens asks to be captured");
    }

    #[test]
    fn the_look_is_measured_at_1080_rows_and_scales_with_the_output() {
        let lens = CameraLens::bodycam();
        let hd = lens.row((1920, 1080), 7, &quality(QualityPreset::Ultra));
        let uhd = lens.row((3840, 2160), 7, &quality(QualityPreset::Ultra));
        let eight = lens.row((7680, 4320), 7, &quality(QualityPreset::Ultra));
        assert!((uhd.amount[2] - 2.0 * hd.amount[2]).abs() < 1e-4, "the fringe doubles in pixels at 4K: the same share of the frame");
        assert!((eight.shape[0] - 4.0 * hd.shape[0]).abs() < 1e-4, "grain cells scale with the rows");
        assert_eq!(hd.amount[0], uhd.amount[0], "the vignette is a share of the frame");
        assert_eq!(hd.output, [1920.0, 1080.0, 1.0 / 1920.0, 1.0 / 1080.0]);
    }

    #[test]
    fn taa_presets_resample_with_catmull_rom_and_the_others_with_one_bilinear_tap() {
        let lens = CameraLens::bodycam();
        assert_eq!(lens.row((1920, 1080), 0, &quality(QualityPreset::Ultra)).shape[2], 1.0);
        assert_eq!(lens.row((1920, 1080), 0, &quality(QualityPreset::High)).shape[2], 1.0);
        assert_eq!(lens.row((1920, 1080), 0, &quality(QualityPreset::Low)).shape[2], 0.0, "MSAA presets take the cheap tier");
    }

    #[test]
    fn every_amount_is_held_to_its_range_and_the_fov_scale_follows_the_bend() {
        let wild = CameraLens::new().vignette(3.0).grain(f32::NAN, 99.0).chromatic_aberration(-1.0).distortion(2.0).roundness(-4.0);
        let look = wild.look;
        assert_eq!((look.vignette, look.grain, look.grain_size, look.chromatic_aberration, look.distortion, look.roundness), (1.0, 0.0, 4.0, 0.0, 1.0, 0.0));
        assert_eq!(CameraLens::new().fov_scale(), 1.0);
        assert!((CameraLens::new().distortion(1.0).fov_scale() - (1.0 + DISTORTION_MAX)).abs() < 1e-6);
        assert!(CameraLens::cinematic().look.distortion == 0.0 && CameraLens::found_footage().look.grain > CameraLens::bodycam().look.grain);
    }

    #[test]
    fn the_shader_validates_as_webgpu_core_wgsl() {
        let module = naga::front::wgsl::parse_str(CAMERA_LENS_WGSL).expect("the lens WGSL parses");
        naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::empty()).validate(&module).expect("the lens WGSL validates");
        assert_eq!(GpuLens::default().bytes().len(), 48, "three vec4 rows");
    }
}
