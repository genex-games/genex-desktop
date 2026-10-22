//! Vertex-animation-texture crowds (game systems AN-24): a skinned mesh's baked frames (genex-anim's
//! `vat` bake) in two rgba16f textures, read by a crowd instance's vertex at two frames and blended.
//! A VAT crowd has no palette, no skinning job and no skinned output: what it holds on the GPU is
//! the two textures, shared by every instance, and one instance row each ([`crowd_memory`]).
//!
//! The layout is [`VatImage`]'s: one texel per vertex per frame, frame-major (frame `f`'s vertex
//! `v` is texel `f * vertex_count + v`), wrapped into rows of [`VAT_ROW_TEXELS`], the 2D size
//! every destination's downlevel limits hold. Positions are stored relative to the bake's origin
//! (the centre of its bounds), so a half float keeps a far crowd's vertices within
//! [`VatImage::tolerance`]; normals are stored as they are. `shaders/vat.wgsl` reads them with
//! `textureLoad`, exact texels on every backend, and [`VatDecode`] writes them out so a check
//! holds the texture path to compute skinning.
//!
//! Not here yet: a VAT draw variant in the world pass, the prepass and the sun casters, and the
//! facade's crowd call. The distance at which a crowd switches to VAT is the LOD area's band.

use bytemuck::{Pod, Zeroable};
use wgpu::{BindGroup, BindGroupLayout, Buffer, ComputePipeline, Device, Queue, Texture, TextureFormat, TextureView};

use crate::compile::Compiled;
use crate::error::RenderError;
use crate::gpu::Gpu;
use crate::mesh::invalid;
use crate::post::tonemap::{f16_to_f32, f32_to_f16};

/// Vertex-animation-texture crowds: the sampling functions and the decode check's entry.
pub const VAT: &str = crate::shaders::minify::shipped_wgsl!(include_str!("../shaders/vat.wgsl"));
/// The decode check's entry point.
pub const DECODE_ENTRY: &str = "cs_vat_decode";
/// Both textures' format: half floats, filterable and storable on every destination.
pub const VAT_FORMAT: TextureFormat = TextureFormat::Rgba16Float;
/// Texels per texture row: the 2D size every destination's downlevel limits hold.
pub const VAT_ROW_TEXELS: u32 = 2048;
/// Rows one texture holds: with [`VAT_ROW_TEXELS`], genex-anim's 2 Mi vertex-frame cap.
pub const VAT_ROWS_MAX: u32 = 1024;
/// Invocations per decode workgroup (`VAT_DECODE_WORKGROUP` in vat.wgsl): one vertex each.
pub const VAT_DECODE_WORKGROUP: u32 = 64;
/// Bytes of one rgba16f texel.
const TEXEL_BYTES: u64 = 8;
/// Bytes of one crowd instance's row: its model matrix and its clip, time and speed
/// (`GpuVatInstance`).
pub const VAT_INSTANCE_BYTES: u64 = std::mem::size_of::<GpuVatInstance>() as u64;
/// Bytes of one vertex in the compute path's skinned output (`MeshVertex`, 12 floats).
const SKINNED_VERTEX_BYTES: u64 = 48;
/// The compute path keeps two skinned outputs (this frame's and last frame's, for motion).
const SKINNED_OUTPUTS: u64 = 2;
/// Half of one half-float step at 1.0: an f16 holds 10 mantissa bits.
const HALF_ULP_AT_ONE: f32 = 1.0 / 2048.0;

/// One crowd instance as a VAT draw reads it: where it stands and which frames it shows.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuVatInstance {
    /// Model matrix, column-major.
    pub model: [f32; 16],
    /// The clip's first frame and frame count, then its length and the agent's time offset in
    /// seconds as f32 bits.
    pub clip: [u32; 4],
}

impl GpuVatInstance {
    /// An agent at `model` playing the clip of `frames` frames from `first_frame`, `duration`
    /// seconds long, `offset` seconds ahead of the crowd's clock.
    pub fn new(model: [f32; 16], first_frame: u32, frames: u32, duration: f32, offset: f32) -> GpuVatInstance {
        GpuVatInstance { model, clip: [first_frame, frames, duration.to_bits(), offset.to_bits()] }
    }
}

/// The crowd draw's view (`VatCrowdView`): the camera and the light.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuVatCrowdView {
    /// View-projection matrix, column-major.
    pub view_proj: [f32; 16],
    /// The direction light travels (xyz) and the crowd's clock in seconds (w).
    pub sun: [f32; 4],
}

/// A bake's frames encoded as the two textures' texels.
#[derive(Clone, Debug, PartialEq)]
pub struct VatImage {
    vertex_count: u32,
    frames: u32,
    rows: u32,
    origin: [f32; 3],
    reach: f32,
    positions: Vec<[u16; 4]>,
    normals: Vec<[u16; 4]>,
}

impl VatImage {
    /// Encode `positions` and `normals`, frame-major, `vertex_count` per frame. Refused
    /// `mesh-invalid` for no vertex, rows of unequal lengths or not a whole number of frames, a
    /// value that is not finite, or more texels than [`VAT_ROW_TEXELS`] × [`VAT_ROWS_MAX`].
    pub fn encode(vertex_count: u32, positions: &[[f32; 3]], normals: &[[f32; 3]]) -> Result<VatImage, RenderError> {
        let count = vertex_count as usize;
        if count == 0 || positions.is_empty() || positions.len() != normals.len() || !positions.len().is_multiple_of(count) {
            return Err(invalid(format!("vertex-animation frames: {} positions, {} normals, {vertex_count} per frame", positions.len(), normals.len())));
        }
        let texels = positions.len() as u64;
        if texels > u64::from(VAT_ROW_TEXELS) * u64::from(VAT_ROWS_MAX) {
            return Err(invalid(format!("vertex-animation frames: {texels} texels; at most {VAT_ROW_TEXELS} x {VAT_ROWS_MAX}")));
        }
        let finite = |row: &[f32; 3]| row.iter().all(|value| value.is_finite());
        if !positions.iter().chain(normals).all(finite) {
            return Err(invalid("vertex-animation frames: a value that is not finite"));
        }
        let (origin, reach) = origin_and_reach(positions);
        let half = |row: [f32; 3], w: f32| [f32_to_f16(row[0]), f32_to_f16(row[1]), f32_to_f16(row[2]), f32_to_f16(w)];
        let relative = |p: &[f32; 3]| half([p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]], 1.0);
        Ok(VatImage {
            vertex_count,
            frames: (positions.len() / count) as u32,
            rows: texels.div_ceil(u64::from(VAT_ROW_TEXELS)) as u32,
            origin,
            reach,
            positions: positions.iter().map(relative).collect(),
            normals: normals.iter().map(|n| half(*n, 0.0)).collect(),
        })
    }

    /// Vertices per frame.
    pub fn vertex_count(&self) -> u32 {
        self.vertex_count
    }

    /// Frames.
    pub fn frames(&self) -> u32 {
        self.frames
    }

    /// The textures' size in texels: [`VAT_ROW_TEXELS`] wide (fewer for a bake under one row).
    pub fn size(&self) -> (u32, u32) {
        (self.row_texels(), self.rows)
    }

    fn row_texels(&self) -> u32 {
        VAT_ROW_TEXELS.min(self.positions.len() as u32)
    }

    /// The point every stored position is relative to.
    pub fn origin(&self) -> [f32; 3] {
        self.origin
    }

    /// The texel of `vertex` in `frame`.
    pub fn texel(&self, frame: u32, vertex: u32) -> (u32, u32) {
        let index = frame * self.vertex_count + vertex;
        (index % self.row_texels(), index / self.row_texels())
    }

    /// The position the textures give `vertex` in `frame` (the origin added back).
    pub fn decode_position(&self, frame: u32, vertex: u32) -> [f32; 3] {
        let texel = self.positions[(frame * self.vertex_count + vertex) as usize];
        [0, 1, 2].map(|axis| f16_to_f32(texel[axis]) + self.origin[axis])
    }

    /// The normal the textures give `vertex` in `frame`, as stored.
    pub fn decode_normal(&self, frame: u32, vertex: u32) -> [f32; 3] {
        let texel = self.normals[(frame * self.vertex_count + vertex) as usize];
        [0, 1, 2].map(|axis| f16_to_f32(texel[axis]))
    }

    /// The largest error a stored position can carry per axis: half a half-float step at the
    /// largest offset from the origin, plus the float error of adding the origin back.
    pub fn tolerance(&self) -> f32 {
        let step = HALF_ULP_AT_ONE * next_power_of_two(self.reach);
        let origin = self.origin.iter().fold(0.0_f32, |most, axis| most.max(axis.abs()));
        step + f32::EPSILON * (origin + self.reach)
    }

    /// Bytes both textures hold on the GPU.
    pub fn texture_bytes(&self) -> u64 {
        2 * TEXEL_BYTES * u64::from(self.row_texels()) * u64::from(self.rows)
    }

    /// The position texels, one row after another (the last row padded by [`VatTextures`]).
    pub fn position_texels(&self) -> &[[u16; 4]] {
        &self.positions
    }

    /// The normal texels.
    pub fn normal_texels(&self) -> &[[u16; 4]] {
        &self.normals
    }
}

/// The centre of the bounds of `positions` and the largest per-axis offset from it.
fn origin_and_reach(positions: &[[f32; 3]]) -> ([f32; 3], f32) {
    let (mut low, mut high) = (positions[0], positions[0]);
    for p in positions {
        for axis in 0..3 {
            low[axis] = low[axis].min(p[axis]);
            high[axis] = high[axis].max(p[axis]);
        }
    }
    let origin = [0, 1, 2].map(|axis| (low[axis] + high[axis]) * 0.5);
    let reach = (0..3).map(|axis| (high[axis] - origin[axis]).max(origin[axis] - low[axis])).fold(0.0_f32, f32::max);
    (origin, reach)
}

/// The smallest power of two at or above `value` (1 for anything at or below 1): the half-float
/// exponent range a value of that size falls in.
fn next_power_of_two(value: f32) -> f32 {
    let mut power = 1.0_f32;
    while power < value {
        power *= 2.0;
    }
    power
}

/// What a crowd holds on the GPU: the shared textures, one row per instance, and the skinned
/// output the compute path would hold for the same crowd (none on the VAT path).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VatMemory {
    /// Both textures, shared by every instance.
    pub textures: u64,
    /// One [`GpuVatInstance`] per instance.
    pub instances: u64,
    /// Skinned output bytes on this path: none, at any crowd size.
    pub skinned_output: u64,
    /// What compute skinning the same crowd at full rate would write (two outputs of every
    /// instance's vertices), for the budget row's comparison.
    pub compute_skinned_output: u64,
}

/// The GPU memory of `instances` crowd agents drawing from `image`.
pub fn crowd_memory(image: &VatImage, instances: u32) -> VatMemory {
    let instances = u64::from(instances);
    VatMemory {
        textures: image.texture_bytes(),
        instances: instances * VAT_INSTANCE_BYTES,
        skinned_output: 0,
        compute_skinned_output: instances * u64::from(image.vertex_count) * SKINNED_VERTEX_BYTES * SKINNED_OUTPUTS,
    }
}

/// The uniform `vat.wgsl` reads (`VatParams`).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuVatParams {
    /// The bake's origin, and its rate in frames per second (w).
    pub origin: [f32; 4],
    /// Row width in texels, vertices per frame, frames, unused.
    pub dims: [u32; 4],
}

/// A bake on the GPU: the two textures and the uniform, bound as `vat.wgsl`'s group 0 (the bind
/// group keeps them alive).
pub struct VatTextures {
    group: BindGroup,
    vertex_count: u32,
    texture_bytes: u64,
}

impl VatTextures {
    /// Upload `image`, baked at `fps` frames per second, under `layout` ([`vat_layout`]).
    pub fn upload(device: &Device, queue: &Queue, layout: &BindGroupLayout, image: &VatImage, fps: f32) -> Result<VatTextures, RenderError> {
        let (width, height) = image.size();
        let positions = texels_texture(device, queue, "vat positions", image.position_texels(), width, height);
        let normals = texels_texture(device, queue, "vat normals", image.normal_texels(), width, height);
        let params = GpuVatParams {
            origin: [image.origin[0], image.origin[1], image.origin[2], fps],
            dims: [width, image.vertex_count, image.frames, 0],
        };
        let params = uniform_buffer(device, queue, "vat params", bytemuck::bytes_of(&params))?;
        let view = |texture: &Texture| texture.create_view(&wgpu::TextureViewDescriptor::default());
        let (position_view, normal_view) = (view(&positions), view(&normals));
        let group = group_0(device, layout, &position_view, &normal_view, &params);
        Ok(VatTextures { group, vertex_count: image.vertex_count, texture_bytes: image.texture_bytes() })
    }

    /// The bind group `vat.wgsl`'s group 0 reads.
    pub fn group(&self) -> &BindGroup {
        &self.group
    }

    /// Bytes both textures hold.
    pub fn texture_bytes(&self) -> u64 {
        self.texture_bytes
    }
}

fn group_0(device: &Device, layout: &BindGroupLayout, positions: &TextureView, normals: &TextureView, params: &Buffer) -> BindGroup {
    device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("vat"),
        layout,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(positions) },
            wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(normals) },
            wgpu::BindGroupEntry { binding: 2, resource: params.as_entire_binding() },
        ],
    })
}

/// A texture of `texels`, `width` × `height`, the last row padded with zeros.
fn texels_texture(device: &Device, queue: &Queue, label: &str, texels: &[[u16; 4]], width: u32, height: u32) -> Texture {
    let size = wgpu::Extent3d { width, height, depth_or_array_layers: 1 };
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: VAT_FORMAT,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    let mut padded = texels.to_vec();
    padded.resize((width * height) as usize, [0; 4]);
    queue.write_texture(
        wgpu::TexelCopyTextureInfo { texture: &texture, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
        bytemuck::cast_slice(&padded),
        wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(width * TEXEL_BYTES as u32), rows_per_image: Some(height) },
        size,
    );
    texture
}

fn uniform_buffer(device: &Device, queue: &Queue, label: &str, bytes: &[u8]) -> Result<Buffer, RenderError> {
    let usage = wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST;
    let buffer = crate::tables::buffer(device, label, bytes.len() as u64, usage)?;
    queue.write_buffer(&buffer, 0, bytes);
    Ok(buffer)
}

/// `vat.wgsl`'s group 0 for the stages in `visibility`: the two textures and the uniform.
pub fn vat_layout(device: &Device, visibility: wgpu::ShaderStages) -> BindGroupLayout {
    let texture = |binding| wgpu::BindGroupLayoutEntry {
        binding,
        visibility,
        ty: wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Float { filterable: false },
            view_dimension: wgpu::TextureViewDimension::D2,
            multisampled: false,
        },
        count: None,
    };
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("vat"),
        entries: &[texture(0), texture(1), crate::tables::uniform(2, false, visibility)],
    })
}

/// The decode check's uniform (`VatDecode`).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
struct GpuVatDecode {
    frame0: u32,
    frame1: u32,
    blend: f32,
    pad: u32,
}

/// One vertex the decode check read back.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DecodedVertex {
    /// Model-space position.
    pub position: [f32; 3],
    /// Unit normal.
    pub normal: [f32; 3],
}

/// The decode check: every vertex of a bake between two frames, read back (native only).
pub struct VatDecode {
    textures_layout: BindGroupLayout,
    output_layout: BindGroupLayout,
    pipeline: Compiled<ComputePipeline>,
}

impl VatDecode {
    /// The decode pipeline.
    pub fn new(device: &Device) -> Result<VatDecode, RenderError> {
        use crate::tables::{compute_storage, compute_uniform};
        let textures_layout = vat_layout(device, wgpu::ShaderStages::COMPUTE);
        let output_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("vat decode"),
            entries: &[compute_uniform(0), compute_storage(1, false)],
        });
        let module = crate::shaders::module(device, "vat", VAT)?;
        let pipeline_layout = crate::tables::pipeline_layout(device, "vat decode", &[&textures_layout, &output_layout]);
        let pipeline = crate::compile::compute_pipeline(device, &wgpu::ComputePipelineDescriptor {
            label: Some("vat decode"),
            layout: Some(&pipeline_layout),
            module: &module,
            entry_point: Some(DECODE_ENTRY),
            compilation_options: Default::default(),
            cache: None,
        });
        Ok(VatDecode { textures_layout, output_layout, pipeline })
    }

    /// The layout [`VatTextures::upload`] takes for this pipeline.
    pub fn textures_layout(&self) -> &BindGroupLayout {
        &self.textures_layout
    }

    /// Every vertex `blend` of the way from `frame0` to `frame1`.
    pub fn decode(&self, gpu: &Gpu, textures: &VatTextures, frame0: u32, frame1: u32, blend: f32) -> Result<Vec<DecodedVertex>, RenderError> {
        let device = &gpu.device;
        let params = GpuVatDecode { frame0, frame1, blend, pad: 0 };
        let uniform = uniform_buffer(device, &gpu.queue, "vat decode", bytemuck::bytes_of(&params))?;
        let bytes = u64::from(textures.vertex_count) * 32;
        let usage = wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC;
        let output = crate::tables::buffer(device, "vat decoded", bytes, usage)?;
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("vat decode"),
            layout: &self.output_layout,
            entries: &[crate::tables::entry(0, &uniform), crate::tables::entry(1, &output)],
        });
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("vat decode") });
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("vat decode"), timestamp_writes: None });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, textures.group(), &[]);
            pass.set_bind_group(1, &group, &[]);
            pass.dispatch_workgroups(textures.vertex_count.div_ceil(VAT_DECODE_WORKGROUP), 1, 1);
        }
        gpu.queue.submit([encoder.finish()]);
        let staging = crate::readback::stage_buffer(gpu, &output, 0, bytes)?;
        let raw = crate::readback::map_read_blocking(gpu, &staging, bytes)?;
        let values: &[f32] = bytemuck::cast_slice(&raw);
        let rows = values.as_chunks::<8>().0;
        Ok(rows.iter().map(|row| DecodedVertex { position: [row[0], row[1], row[2]], normal: [row[4], row[5], row[6]] }).collect())
    }
}

/// The crowd draw's entry points (vertex, fragment).
pub const CROWD_ENTRIES: (&str, &str) = ("vs_vat_crowd", "fs_vat_crowd");

/// A standalone VAT crowd draw: every agent of one bake in one instanced, indexed draw, lit by one
/// light. The world pass, prepass and sun casters do not draw VAT instances yet; this pass is what
/// the crowd budget row times and what a capture shows.
pub struct VatCrowdPass {
    textures_layout: BindGroupLayout,
    crowd_layout: BindGroupLayout,
    pipeline: Compiled<wgpu::RenderPipeline>,
}

/// One crowd's per-draw state: the view, the instance rows and their bind group.
pub struct VatCrowd {
    group: BindGroup,
    instances: u32,
}

impl VatCrowdPass {
    /// The crowd pipeline drawing into `color` with a `depth` buffer.
    pub fn new(device: &Device, color: TextureFormat, depth: TextureFormat) -> Result<VatCrowdPass, RenderError> {
        let textures_layout = vat_layout(device, wgpu::ShaderStages::VERTEX);
        let crowd_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("vat crowd"),
            entries: &[
                crate::tables::uniform(2, false, wgpu::ShaderStages::VERTEX_FRAGMENT),
                crate::tables::storage(3, true, wgpu::ShaderStages::VERTEX),
            ],
        });
        let module = crate::shaders::module(device, "vat", VAT)?;
        let layout = crate::tables::pipeline_layout(device, "vat crowd", &[&textures_layout, &crowd_layout]);
        let pipeline = crate::compile::render_pipeline(device, &wgpu::RenderPipelineDescriptor {
            label: Some("vat crowd"),
            layout: Some(&layout),
            vertex: wgpu::VertexState { module: &module, entry_point: Some(CROWD_ENTRIES.0), compilation_options: Default::default(), buffers: &[] },
            primitive: wgpu::PrimitiveState { cull_mode: Some(wgpu::Face::Back), ..Default::default() },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: depth,
                depth_write_enabled: Some(true),
                depth_compare: Some(wgpu::CompareFunction::Less),
                stencil: wgpu::StencilState::default(),
                bias: wgpu::DepthBiasState::default(),
            }),
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some(CROWD_ENTRIES.1),
                compilation_options: Default::default(),
                targets: &[Some(color.into())],
            }),
            multiview_mask: None,
            cache: None,
        });
        Ok(VatCrowdPass { textures_layout, crowd_layout, pipeline })
    }

    /// The layout [`VatTextures::upload`] takes for this pipeline.
    pub fn textures_layout(&self) -> &BindGroupLayout {
        &self.textures_layout
    }

    /// A crowd of `instances` seen through `view`.
    pub fn crowd(&self, device: &Device, queue: &Queue, view: &GpuVatCrowdView, instances: &[GpuVatInstance]) -> Result<VatCrowd, RenderError> {
        let view = uniform_buffer(device, queue, "vat crowd view", bytemuck::bytes_of(view))?;
        let usage = wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST;
        let rows = crate::tables::buffer(device, "vat crowd instances", (std::mem::size_of_val(instances) as u64).max(VAT_INSTANCE_BYTES), usage)?;
        queue.write_buffer(&rows, 0, bytemuck::cast_slice(instances));
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("vat crowd"),
            layout: &self.crowd_layout,
            entries: &[crate::tables::entry(2, &view), crate::tables::entry(3, &rows)],
        });
        Ok(VatCrowd { group, instances: instances.len() as u32 })
    }

    /// Draw `crowd` from `textures`, its triangles in `indices` (`index_count` u32 indices of the
    /// baked mesh's vertices).
    pub fn draw(&self, pass: &mut wgpu::RenderPass<'_>, textures: &VatTextures, crowd: &VatCrowd, indices: &Buffer, index_count: u32) {
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, textures.group(), &[]);
        pass.set_bind_group(1, &crowd.group, &[]);
        pass.set_index_buffer(indices.slice(..), wgpu::IndexFormat::Uint32);
        pass.draw_indexed(0..index_count, 0, 0..crowd.instances);
    }
}

/// AN-24's GPU rows: a VAT instance at frame k against the compute-skinned golden. `#[ignore]`d;
/// every name contains `metal`:
///
///   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
///     --offline --locked --lib vat -- --include-ignored
#[cfg(test)]
mod tests {
    use glam::{Mat4, Vec3};

    use super::*;
    use crate::layout::{GpuSkinJob, GpuSkinVertex};
    use crate::mesh::{MeshData, Vertex};
    use crate::skin::{SkinBuffers, SkinPass, skin_vertices_cpu};

    const VERTICES: u32 = 40;
    const FRAMES: u32 = 8;
    const FPS: f32 = 30.0;
    /// Compute skinning against its CPU reference (`skin.rs`).
    const COMPUTE_TOLERANCE: f32 = 1e-5;
    /// A unit normal through two half floats and a renormalize.
    const NORMAL_TOLERANCE: f32 = 2e-3;

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

    /// A column of vertices 3 m tall on three joints, standing 40 m from the origin (a far crowd
    /// member), each vertex on two neighbouring joints.
    fn column() -> (MeshData, Vec<GpuSkinVertex>) {
        let mut vertices = Vec::new();
        let mut skin = Vec::new();
        for i in 0..VERTICES {
            let height = 3.0 * i as f32 / (VERTICES - 1) as f32;
            let side = if i % 2 == 0 { 0.2 } else { -0.2 };
            let lower = (height as u32).min(1);
            let share = (height - lower as f32).clamp(0.0, 1.0);
            vertices.push(Vertex {
                position: [40.0 + side, height, 12.0],
                normal: [if side > 0.0 { 1.0 } else { -1.0 }, 0.0, 0.0],
                uv: [0.0, height / 3.0],
                tangent: [0.0, 0.0, 1.0, 1.0],
            });
            skin.push(GpuSkinVertex { joints: [lower, lower + 1, 0, 0], weights: [1.0 - share, share, 0.0, 0.0] });
        }
        (MeshData { vertices, indices: Vec::new() }, skin)
    }

    /// Frame `k`'s palette: the lower joints bend about the column's knees, more each frame.
    fn palette(k: u32) -> Vec<[f32; 16]> {
        let bend = |height: f32, angle: f32| {
            let pivot = Vec3::new(40.0, height, 12.0);
            Mat4::from_translation(pivot) * Mat4::from_rotation_z(angle) * Mat4::from_translation(-pivot)
        };
        let angle = 0.15 * k as f32;
        let one = bend(1.0, angle);
        let two = one * bend(2.0, angle * 0.5);
        [Mat4::IDENTITY, one, two].map(|m| m.to_cols_array()).to_vec()
    }

    /// Every frame skinned on the CPU (the compute pass's reference), frame-major.
    fn frames(mesh: &MeshData, skin: &[GpuSkinVertex]) -> (Vec<[f32; 3]>, Vec<[f32; 3]>) {
        let mut out = (Vec::new(), Vec::new());
        for k in 0..FRAMES {
            for v in skin_vertices_cpu(mesh, skin, &palette(k)) {
                out.0.push(v.position);
                out.1.push(v.normal);
            }
        }
        out
    }

    fn storage(gpu: &Gpu, label: &str, bytes: &[u8]) -> Buffer {
        let usage = wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC;
        let buffer = crate::tables::buffer(&gpu.device, label, bytes.len().max(16) as u64, usage).expect("buffer");
        gpu.queue.write_buffer(&buffer, 0, bytes);
        buffer
    }

    /// The mesh skinned by frame `k`'s palette on the GPU's compute pass: (position, normal) rows.
    fn compute_skinned(gpu: &Gpu, mesh: &MeshData, skin: &[GpuSkinVertex], k: u32) -> Vec<DecodedVertex> {
        let source: Vec<[f32; 12]> = mesh
            .vertices
            .iter()
            .map(|v| {
                let [px, py, pz] = v.position;
                let [nx, ny, nz] = v.normal;
                let [tx, ty, tz, tw] = v.tangent;
                [px, py, pz, nx, ny, nz, v.uv[0], v.uv[1], tx, ty, tz, tw]
            })
            .collect();
        let job = GpuSkinJob { src_base: 0, count: VERTICES, dst_base: 0, joint_base: 0, skin_base: 0, slot: 0, pad: [0; 2] };
        let output_bytes = vec![0u8; VERTICES as usize * 48];
        let buffers = (
            storage(gpu, "source", bytemuck::cast_slice(&source)),
            storage(gpu, "skin", bytemuck::cast_slice(skin)),
            storage(gpu, "joints", bytemuck::cast_slice(&palette(k))),
            storage(gpu, "jobs", bytemuck::bytes_of(&job)),
            storage(gpu, "output", &output_bytes),
            storage(gpu, "slots", &vec![0u8; VERTICES as usize * 4]),
        );
        let pass = SkinPass::new(&gpu.device).expect("skin pass");
        let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("skin") });
        let refs = SkinBuffers { source: &buffers.0, skin: &buffers.1, joints: &buffers.2, jobs: &buffers.3, output: &buffers.4, output_slots: &buffers.5 };
        pass.encode(&gpu.device, &mut encoder, &refs, 1, VERTICES);
        gpu.queue.submit([encoder.finish()]);
        let bytes = output_bytes.len() as u64;
        let staging = crate::readback::stage_buffer(gpu, &buffers.4, 0, bytes).expect("stage");
        let raw = crate::readback::map_read_blocking(gpu, &staging, bytes).expect("read");
        let values: &[f32] = bytemuck::cast_slice(&raw);
        let rows = values.as_chunks::<12>().0;
        rows.iter().map(|row| DecodedVertex { position: [row[0], row[1], row[2]], normal: [row[3], row[4], row[5]] }).collect()
    }

    fn largest(pairs: impl Iterator<Item = ([f32; 3], [f32; 3])>) -> f32 {
        pairs.flat_map(|(a, b)| (0..3).map(move |axis| (a[axis] - b[axis]).abs())).fold(0.0, f32::max)
    }

    /// AN-24 red row: a VAT instance at frame k reads back the compute-skinned vertices of frame
    /// k's palette within the half-float tolerance (positions) and 2e-3 (normals), on the GPU.
    #[test]
    #[ignore = "needs a GPU: run with --ignored metal"]
    fn metal_a_vat_instance_at_frame_k_matches_the_compute_skinned_golden() {
        let Some(gpu) = gpu() else { return };
        let (mesh, skin) = column();
        let (positions, normals) = frames(&mesh, &skin);
        let image = VatImage::encode(VERTICES, &positions, &normals).expect("encodes");
        let decode = VatDecode::new(&gpu.device).expect("decode pipeline");
        let textures = VatTextures::upload(&gpu.device, &gpu.queue, decode.textures_layout(), &image, FPS).expect("uploads");
        let tolerance = image.tolerance() + COMPUTE_TOLERANCE;
        assert!(tolerance < 0.02, "a far crowd member stays within 2 cm: {tolerance}");
        for k in [0, 3, FRAMES - 1] {
            let golden = compute_skinned(&gpu, &mesh, &skin, k);
            let vat = decode.decode(&gpu, &textures, k, k, 0.0).expect("decodes");
            let position_error = largest(golden.iter().zip(&vat).map(|(g, v)| (g.position, v.position)));
            let normal_error = largest(golden.iter().zip(&vat).map(|(g, v)| (g.normal, v.normal)));
            eprintln!("frame {k}: position error {position_error:.6} (tolerance {tolerance:.6}), normal error {normal_error:.6}");
            assert!(position_error <= tolerance, "frame {k}: {position_error} > {tolerance}");
            assert!(normal_error <= NORMAL_TOLERANCE, "frame {k}: {normal_error}");
        }
        let (first, last) = (compute_skinned(&gpu, &mesh, &skin, 0), compute_skinned(&gpu, &mesh, &skin, FRAMES - 1));
        let moved = largest(first.iter().zip(&last).map(|(a, b)| (a.position, b.position)));
        assert!(moved > 0.5, "the frames differ by more than the tolerance: {moved}");
    }

    const CROWD: u32 = 500;
    const CROWD_WIDTH: u32 = 1280;
    const CROWD_HEIGHT: u32 = 720;
    const CROWD_FRAMES_TIMED: u32 = 60;

    /// A far-level crowd agent: a lathe 1.8 m tall of 40 rings by 24 segments (960 vertices, 1,872
    /// triangles) on three joints that sway it at the hips and the chest.
    fn agent() -> (MeshData, Vec<GpuSkinVertex>) {
        const RINGS: u32 = 40;
        const SEGMENTS: u32 = 24;
        let mut mesh = MeshData { vertices: Vec::new(), indices: Vec::new() };
        let mut skin = Vec::new();
        for ring in 0..RINGS {
            let height = 1.8 * ring as f32 / (RINGS - 1) as f32;
            let radius = 0.18 + 0.08 * libm::sinf(height * 2.4);
            let lower = ((height / 0.6) as u32).min(1);
            let share = ((height - 0.6 * lower as f32) / 0.6).clamp(0.0, 1.0);
            for segment in 0..SEGMENTS {
                let angle = std::f32::consts::TAU * segment as f32 / SEGMENTS as f32;
                let (sin, cos) = (libm::sinf(angle), libm::cosf(angle));
                mesh.vertices.push(Vertex { position: [radius * cos, height, radius * sin], normal: [cos, 0.0, sin], uv: [0.0; 2], tangent: [0.0, 0.0, 1.0, 1.0] });
                skin.push(GpuSkinVertex { joints: [lower, lower + 1, 0, 0], weights: [1.0 - share, share, 0.0, 0.0] });
            }
        }
        for ring in 0..RINGS - 1 {
            for segment in 0..SEGMENTS {
                let (a, b) = (ring * SEGMENTS + segment, ring * SEGMENTS + (segment + 1) % SEGMENTS);
                let (c, d) = (a + SEGMENTS, b + SEGMENTS);
                mesh.indices.extend([a, c, b, b, c, d]);
            }
        }
        (mesh, skin)
    }

    /// The agent's sway at frame `k` of a one-second loop.
    fn sway(k: u32) -> Vec<[f32; 16]> {
        let phase = std::f32::consts::TAU * k as f32 / FPS;
        let bend = |height: f32, angle: f32| {
            let pivot = Vec3::new(0.0, height, 0.0);
            Mat4::from_translation(pivot) * Mat4::from_rotation_x(angle) * Mat4::from_translation(-pivot)
        };
        let hips = bend(0.6, 0.35 * libm::sinf(phase));
        let chest = hips * bend(1.2, 0.3 * libm::cosf(phase));
        [Mat4::IDENTITY, hips, chest].map(|m| m.to_cols_array()).to_vec()
    }

    fn write_evidence(name: &str, bytes: &[u8]) {
        if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
            let path = std::path::PathBuf::from(dir).join(name);
            std::fs::write(&path, bytes).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        }
    }

    /// AN-24 budget row (recorded, advisory in a lane): 500 VAT crowd agents in one draw at 720p,
    /// timed by wall clock around each frame's submit and wait (an upper bound of the GPU time).
    /// The frame is written to `GENEX_RENDER_EVIDENCE_DIR` as raw RGBA.
    #[test]
    #[ignore = "needs a GPU: run with --ignored metal"]
    fn metal_500_vat_crowd_agents_draw_in_one_pass_and_are_timed() {
        let Some(gpu) = gpu() else { return };
        let (mesh, skin) = agent();
        let (mut positions, mut normals) = (Vec::new(), Vec::new());
        let frames = FPS as u32 + 1;
        for k in 0..frames {
            for v in skin_vertices_cpu(&mesh, &skin, &sway(k)) {
                positions.push(v.position);
                normals.push(v.normal);
            }
        }
        let image = VatImage::encode(mesh.vertices.len() as u32, &positions, &normals).expect("encodes");
        let (color, depth) = (TextureFormat::Rgba8Unorm, TextureFormat::Depth32Float);
        let pass = VatCrowdPass::new(&gpu.device, color, depth).expect("crowd pipeline");
        let textures = VatTextures::upload(&gpu.device, &gpu.queue, pass.textures_layout(), &image, FPS).expect("uploads");
        let instances: Vec<GpuVatInstance> = (0..CROWD)
            .map(|i| {
                let (x, z) = ((i % 25) as f32 * 1.4 - 17.0, (i / 25) as f32 * 1.4 - 14.0);
                GpuVatInstance::new(Mat4::from_translation(Vec3::new(x, 0.0, z)).to_cols_array(), 0, frames, 1.0, 0.037 * i as f32)
            })
            .collect();
        let aspect = CROWD_WIDTH as f32 / CROWD_HEIGHT as f32;
        let projection = glam::camera::rh::proj::directx::perspective(0.9, aspect, 0.1, 200.0);
        let view_proj = projection * glam::camera::rh::view::look_at_mat4(Vec3::new(0.0, 14.0, 30.0), Vec3::new(0.0, 0.0, -2.0), Vec3::Y);
        let view = GpuVatCrowdView { view_proj: view_proj.to_cols_array(), sun: [-0.4, -0.8, -0.45, 0.25] };
        let crowd = pass.crowd(&gpu.device, &gpu.queue, &view, &instances).expect("crowd");
        let index_usage = wgpu::BufferUsages::INDEX | wgpu::BufferUsages::COPY_DST;
        let index_buffer = crate::tables::buffer(&gpu.device, "vat indices", (mesh.indices.len() * 4) as u64, index_usage).expect("indices");
        gpu.queue.write_buffer(&index_buffer, 0, bytemuck::cast_slice(&mesh.indices));
        let target = |format, usage, label| {
            gpu.device.create_texture(&wgpu::TextureDescriptor {
                label: Some(label),
                size: wgpu::Extent3d { width: CROWD_WIDTH, height: CROWD_HEIGHT, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format,
                usage,
                view_formats: &[],
            })
        };
        let color_target = target(color, wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC, "crowd color");
        let depth_target = target(depth, wgpu::TextureUsages::RENDER_ATTACHMENT, "crowd depth");
        let (color_view, depth_view) = (color_target.create_view(&Default::default()), depth_target.create_view(&Default::default()));
        let frame = || {
            let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("crowd") });
            {
                let mut render = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("crowd"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &color_view,
                        depth_slice: None,
                        resolve_target: None,
                        ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color { r: 0.42, g: 0.55, b: 0.7, a: 1.0 }), store: wgpu::StoreOp::Store },
                    })],
                    depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                        view: &depth_view,
                        depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Discard }),
                        stencil_ops: None,
                    }),
                    timestamp_writes: None,
                    occlusion_query_set: None,
                    multiview_mask: None,
                });
                pass.draw(&mut render, &textures, &crowd, &index_buffer, mesh.indices.len() as u32);
            }
            gpu.queue.submit([encoder.finish()]);
            gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
        };
        for _ in 0..5 {
            frame();
        }
        #[allow(clippy::disallowed_types, reason = "a budget row measures the wall clock on purpose")]
        let start = std::time::Instant::now();
        for _ in 0..CROWD_FRAMES_TIMED {
            frame();
        }
        let per_frame_ms = start.elapsed().as_secs_f64() * 1000.0 / f64::from(CROWD_FRAMES_TIMED);
        let memory = crowd_memory(&image, CROWD);
        let triangles = u64::from(CROWD) * (mesh.indices.len() / 3) as u64;
        eprintln!("VAT crowd: {CROWD} agents, {triangles} triangles, {per_frame_ms:.3} ms per frame (wall clock, submit and wait), adapter {}", gpu.receipt().adapter);
        eprintln!("VAT crowd memory: {memory:?}");
        let row_bytes = CROWD_WIDTH * 4;
        let staging = crate::tables::buffer(&gpu.device, "crowd readback", u64::from(row_bytes * CROWD_HEIGHT), wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST).expect("staging");
        let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("crowd readback") });
        encoder.copy_texture_to_buffer(
            color_target.as_image_copy(),
            wgpu::TexelCopyBufferInfo { buffer: &staging, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(row_bytes), rows_per_image: Some(CROWD_HEIGHT) } },
            wgpu::Extent3d { width: CROWD_WIDTH, height: CROWD_HEIGHT, depth_or_array_layers: 1 },
        );
        gpu.queue.submit([encoder.finish()]);
        let rgba = crate::readback::map_read_blocking(&gpu, &staging, u64::from(row_bytes * CROWD_HEIGHT)).expect("read");
        write_evidence("vat-crowd-500-1280x720.rgba", &rgba);
        let sky = [107u8, 140, 178];
        let drawn = rgba.as_chunks::<4>().0.iter().filter(|px| (0..3).any(|c| px[c].abs_diff(sky[c]) > 8)).count();
        assert!(drawn > (CROWD_WIDTH * CROWD_HEIGHT / 20) as usize, "the crowd covers the frame: {drawn} pixels");
        assert_eq!(memory.skinned_output, 0);
    }

    /// Between two frames the texture path blends them as the CPU decode does.
    #[test]
    #[ignore = "needs a GPU: run with --ignored metal"]
    fn metal_a_vat_instance_between_frames_blends_them() {
        let Some(gpu) = gpu() else { return };
        let (mesh, skin) = column();
        let (positions, normals) = frames(&mesh, &skin);
        let image = VatImage::encode(VERTICES, &positions, &normals).expect("encodes");
        let decode = VatDecode::new(&gpu.device).expect("decode pipeline");
        let textures = VatTextures::upload(&gpu.device, &gpu.queue, decode.textures_layout(), &image, FPS).expect("uploads");
        let vat = decode.decode(&gpu, &textures, 4, 5, 0.25).expect("decodes");
        let cpu = (0..VERTICES).map(|v| {
            let (a, b) = (image.decode_position(4, v), image.decode_position(5, v));
            [0, 1, 2].map(|axis| a[axis] + (b[axis] - a[axis]) * 0.25)
        });
        let error = largest(cpu.zip(vat.iter().map(|row| row.position)));
        assert!(error <= 1e-4, "{error}");
    }
}
