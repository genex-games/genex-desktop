//! The impostor bake (game systems LOD-13): a port of kansei's `bake_impostor` with its pack and
//! mip computes (Siroko/kansei, MIT) from wgpu 24 to wgpu 30, run at build time (LOD-23) or, as the
//! fallback, in the renderer's pipelines stage.
//!
//! For each of the class's N x N frame directions ([`super::frame_direction`]) the object's parts
//! are drawn orthographically round their bake sphere into three render targets
//! ([`IMPOSTOR_BAKE`]: the forward pass's own material evaluation, `gx_surface` and
//! `gx_mask_alpha`, writing surface attributes, not lit colour), `BAKE_SUPERSAMPLE` render texels
//! per atlas texel side; [`IMPOSTOR_PACK`] folds them into that frame of the species' layer of
//! three RGBA8 atlas arrays ([`ImpostorAtlases`]); [`IMPOSTOR_MIP`] then builds the mip chain,
//! keeping each frame's coverage above the draw's cutoff (Castano's rule, which kansei's plain
//! average does not). Every storage write is `rgba8unorm` (WebGPU core); there is no workgroup
//! memory and no CPU thread, so the web bakes the same way.
//!
//! The atlas arrays are registered in the ledger as `BudgetKind::Impostors` by
//! [`super::admit_species`]; [`ImpostorAtlases::bytes`] equals that ledger. After a device loss
//! the species are baked again from the same parts on the new device ([`ImpostorBaker::new`] and
//! [`ImpostorBaker::bake`] hold no state of the old one).

use bytemuck::{Pod, Zeroable};
use glam::{Mat4, Vec3};
use wgpu::util::DeviceExt;
use wgpu::{BindGroupLayout, Buffer, ComputePipeline, Device, Queue, RenderPipeline, Sampler, Texture, TextureFormat, TextureView};

use super::{GpuImpostor, ImpostorBounds, ImpostorClass, ImpostorLayout, ImpostorSpec, frame_axes, frame_direction};
use crate::error::RenderError;

/// The bake's G-buffer pass: the common structs, the forward surface chunk and alpha testing, then
/// the bake's own bindings and entry points.
pub const IMPOSTOR_BAKE: &str = crate::shaders::minify::shipped_wgsl!(concat!(
    include_str!("../../shaders/common.wgsl"),
    include_str!("../../shaders/lighting/surface.wgsl"),
    include_str!("../../shaders/alpha_mask.wgsl"),
    include_str!("../../shaders/impostor/bake.wgsl")
));
/// The atlas pack: one frame's render into its atlas texels, mip 0.
pub const IMPOSTOR_PACK: &str = crate::shaders::minify::shipped_wgsl!(include_str!("../../shaders/impostor/pack.wgsl"));
/// The atlas mips: one level from the one before, coverage kept.
pub const IMPOSTOR_MIP: &str = crate::shaders::minify::shipped_wgsl!(include_str!("../../shaders/impostor/mip.wgsl"));

/// The atlases' format (base colour and coverage; normal, depth and roughness; occlusion, metallic,
/// transmission and class).
pub const ATLAS_FORMAT: TextureFormat = TextureFormat::Rgba8Unorm;
/// Render texels per atlas texel side (kansei's default): antialiasing and softer coverage.
pub const BAKE_SUPERSAMPLE: u32 = 2;
/// The alpha the draw keeps a texel at: the mips hold each frame's share of texels at or above it.
pub const IMPOSTOR_COVERAGE_CUTOFF: f32 = 0.5;
/// The bake's render targets: base colour and alpha; the object normal and roughness (signed, so
/// half floats); occlusion, metallic, transmission and class.
pub const BAKE_TARGET_FORMATS: [TextureFormat; 3] = [TextureFormat::Rgba8Unorm, TextureFormat::Rgba16Float, TextureFormat::Rgba8Unorm];
/// The bake's depth (standard: cleared to 1, nearer is smaller).
pub const BAKE_DEPTH_FORMAT: TextureFormat = TextureFormat::Depth32Float;
/// Bytes between per-frame uniform rows: a multiple of every device's uniform offset alignment.
const UNIFORM_SLOT: u64 = 256;
/// The pack's and the mips' workgroup sides.
const PACK_WORKGROUP: u32 = 8;
/// Counters per frame in the mips' storage buffer.
const MIP_COUNTERS_PER_FRAME: u64 = 2;
/// Stride of a library vertex (`mesh::Vertex`: position, normal, uv, tangent).
const VERTEX_STRIDE: u64 = 48;
const VERTEX_ATTRIBUTES: [wgpu::VertexAttribute; 4] = wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3, 2 => Float32x2, 3 => Float32x4];
const MATERIAL_ATTRIBUTES: [wgpu::VertexAttribute; 1] = wgpu::vertex_attr_array![4 => Uint32];
/// The material-texture arrays the bake binds, in binding order from 3: colour then data per size
/// class, smallest class first.
pub const BAKE_TEXTURE_ARRAYS: usize = 8;

/// How the mips treat coverage.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum MipRule {
    /// Each frame keeps its mip-0 share of texels at or above the cutoff (the bake's rule).
    #[default]
    CoveragePreserving,
    /// kansei's plain average: coverage thins at a distance (kept for the comparison row).
    PlainAverage,
}

impl MipRule {
    const fn code(self) -> u32 {
        match self {
            MipRule::CoveragePreserving => 0,
            MipRule::PlainAverage => 1,
        }
    }
}

/// One species' worth of atlases per layer: three RGBA8 2D arrays with the class's mip chain.
pub struct ImpostorAtlases {
    /// The class the arrays are sized for.
    pub spec: ImpostorSpec,
    /// Layers (species) each array holds.
    pub layers: u32,
    /// Atlas A (base colour, coverage), B (normal, depth, roughness) and C (occlusion, metallic,
    /// transmission, class).
    pub textures: [Texture; 3],
}

impl ImpostorAtlases {
    /// Arrays of `layers` species at `spec`'s size.
    pub fn new(device: &Device, spec: ImpostorSpec, layers: u32) -> ImpostorAtlases {
        let side = spec.atlas_side();
        let make = |label| {
            device.create_texture(&wgpu::TextureDescriptor {
                label: Some(label),
                size: wgpu::Extent3d { width: side, height: side, depth_or_array_layers: layers.max(1) },
                mip_level_count: spec.mip_levels(),
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: ATLAS_FORMAT,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            })
        };
        ImpostorAtlases { spec, layers: layers.max(1), textures: [make("impostor-atlas-a"), make("impostor-atlas-b"), make("impostor-atlas-c")] }
    }

    /// The arrays' bytes, from their descriptors (every layer and level).
    pub fn bytes(&self) -> u64 {
        self.textures
            .iter()
            .map(|texture| {
                let layers = u64::from(texture.depth_or_array_layers());
                (0..texture.mip_level_count())
                    .map(|level| {
                        let size = texture.size().mip_level_size(level, texture.dimension());
                        u64::from(size.width) * u64::from(size.height) * layers * ATLAS_FORMAT.block_copy_size(None).map_or(0, u64::from)
                    })
                    .sum::<u64>()
            })
            .sum()
    }

    /// A 2D view of one layer and one level of atlas `atlas` (0 A, 1 B, 2 C).
    pub fn level_view(&self, atlas: usize, layer: u32, level: u32) -> TextureView {
        self.textures[atlas].create_view(&wgpu::TextureViewDescriptor {
            label: Some("impostor-atlas-level"),
            dimension: Some(wgpu::TextureViewDimension::D2),
            base_mip_level: level,
            mip_level_count: Some(1),
            base_array_layer: layer,
            array_layer_count: Some(1),
            ..Default::default()
        })
    }
}

/// The material table and texture arrays the bake samples (the renderer's own, so a part bakes
/// exactly as it shades): `materials` and `material_ext` as the forward pass binds them, and the
/// colour and data arrays of each size class, smallest first ([`BAKE_TEXTURE_ARRAYS`]).
pub struct BakeMaterials<'a> {
    /// `Material` rows.
    pub materials: &'a Buffer,
    /// `GxMaterialExt` rows, parallel to `materials`.
    pub material_ext: &'a Buffer,
    /// Colour 256, data 256, colour 512, data 512, colour 1024, data 1024, colour 2048, data 2048.
    pub arrays: [&'a TextureView; BAKE_TEXTURE_ARRAYS],
    /// The material sampler.
    pub sampler: &'a Sampler,
}

/// One part of the object: an index range of the vertex and index buffers, and its material row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BakePart {
    /// The part's first index.
    pub first_index: u32,
    /// Its indices.
    pub index_count: u32,
    /// Added to every index.
    pub base_vertex: i32,
    /// Its material row.
    pub material: u32,
}

/// The object a species bakes from: library-layout vertices (`mesh::Vertex`), `u32` indices and
/// its parts, all in the object's own space.
pub struct BakeMesh<'a> {
    /// The vertex buffer.
    pub vertices: &'a Buffer,
    /// The index buffer.
    pub indices: &'a Buffer,
    /// The parts drawn together.
    pub parts: &'a [BakePart],
}

/// `GxImpostorBake` in bake.wgsl.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct BakeUniform {
    view_proj: [f32; 16],
}

/// `GxImpostorPack` in pack.wgsl: one frame.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct PackUniform {
    right: [f32; 3],
    radius: f32,
    up: [f32; 3],
    frame_px: u32,
    dir: [f32; 3],
    supersample: u32,
    frame: [u32; 2],
    pad: [u32; 2],
}

/// `GxImpostorMip` in mip.wgsl: one level.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct MipUniform {
    frame_px: u32,
    base_px: u32,
    rule: u32,
    frames: u32,
    cutoff: f32,
    pad: [f32; 3],
}

/// The bake's pipelines (made once per device; the pipelines stage counts them).
pub struct ImpostorBaker {
    bake: RenderPipeline,
    bake_layout: BindGroupLayout,
    pack: ComputePipeline,
    pack_layout: BindGroupLayout,
    mip: ComputePipeline,
    mip_layout: BindGroupLayout,
}

/// The render targets of one bake (a frame's size times the supersampling).
struct BakeTargets {
    colors: Vec<TextureView>,
    depth: TextureView,
}

fn bake_targets(device: &Device, side: u32) -> BakeTargets {
    let target = |label, format| {
        device
            .create_texture(&wgpu::TextureDescriptor {
                label: Some(label),
                size: wgpu::Extent3d { width: side, height: side, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            })
            .create_view(&wgpu::TextureViewDescriptor::default())
    };
    BakeTargets { colors: BAKE_TARGET_FORMATS.iter().map(|format| target("impostor-bake-target", *format)).collect(), depth: target("impostor-bake-depth", BAKE_DEPTH_FORMAT) }
}

/// A frame's orthographic camera: on the bake sphere looking at its centre, depth [0, 1] over its
/// diameter.
fn frame_view_proj(bounds: &ImpostorBounds, dir: [f32; 3]) -> Mat4 {
    let r = bounds.radius;
    let center = Vec3::from(bounds.center);
    let axes = frame_axes(dir);
    let proj = glam::camera::rh::proj::directx::orthographic(-r, r, -r, r, 0.0, 2.0 * r);
    let view = glam::camera::rh::view::look_at_mat4(center + Vec3::from(dir) * r, center, Vec3::from(axes.up_reference));
    proj * view
}

fn uniform_rows<T: Pod>(device: &Device, label: &str, rows: &[T]) -> Buffer {
    let mut bytes = vec![0u8; rows.len() * UNIFORM_SLOT as usize];
    for (at, row) in rows.iter().enumerate() {
        bytes[at * UNIFORM_SLOT as usize..][..size_of::<T>()].copy_from_slice(bytemuck::bytes_of(row));
    }
    device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some(label), contents: &bytes, usage: wgpu::BufferUsages::UNIFORM })
}

fn uniform_row(buffer: &Buffer, row: u64, size: usize) -> wgpu::BindingResource<'_> {
    wgpu::BindingResource::Buffer(wgpu::BufferBinding { buffer, offset: row * UNIFORM_SLOT, size: wgpu::BufferSize::new(size as u64) })
}

fn view_entry(binding: u32, view: &TextureView) -> wgpu::BindGroupEntry<'_> {
    wgpu::BindGroupEntry { binding, resource: wgpu::BindingResource::TextureView(view) }
}

impl ImpostorBaker {
    /// The bake's pipelines on `device`.
    pub fn new(device: &Device) -> Result<ImpostorBaker, RenderError> {
        let bake_module = crate::shaders::module(device, "impostor-bake", IMPOSTOR_BAKE)?;
        let pack_module = crate::shaders::module(device, "impostor-pack", IMPOSTOR_PACK)?;
        let mip_module = crate::shaders::module(device, "impostor-mip", IMPOSTOR_MIP)?;
        let targets: Vec<Option<wgpu::ColorTargetState>> = BAKE_TARGET_FORMATS.iter().map(|format| Some((*format).into())).collect();
        let buffers = [
            Some(wgpu::VertexBufferLayout { array_stride: VERTEX_STRIDE, step_mode: wgpu::VertexStepMode::Vertex, attributes: &VERTEX_ATTRIBUTES }),
            Some(wgpu::VertexBufferLayout { array_stride: 4, step_mode: wgpu::VertexStepMode::Instance, attributes: &MATERIAL_ATTRIBUTES }),
        ];
        // The material arrays are sampled by size class: one gradient fetch from the class's array.
        let constants = [("GX_TEXTURE_CLASSES", 1.0)];
        let bake = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("impostor-bake"),
            layout: None,
            vertex: wgpu::VertexState {
                module: &bake_module,
                entry_point: Some("vs_impostor_bake"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                buffers: &buffers,
            },
            primitive: wgpu::PrimitiveState { cull_mode: None, ..Default::default() },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: BAKE_DEPTH_FORMAT,
                depth_write_enabled: Some(true),
                depth_compare: Some(wgpu::CompareFunction::Less),
                stencil: wgpu::StencilState::default(),
                bias: wgpu::DepthBiasState::default(),
            }),
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &bake_module,
                entry_point: Some("fs_impostor_bake"),
                compilation_options: wgpu::PipelineCompilationOptions { constants: &constants, ..Default::default() },
                targets: &targets,
            }),
            multiview_mask: None,
            cache: None,
        });
        let compute = |label, module| {
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(label),
                layout: None,
                module,
                entry_point: None,
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                cache: None,
            })
        };
        let pack = compute("impostor-pack", &pack_module);
        let mip = compute("impostor-mip", &mip_module);
        Ok(ImpostorBaker {
            bake_layout: bake.get_bind_group_layout(0),
            bake,
            pack_layout: pack.get_bind_group_layout(0),
            pack,
            mip_layout: mip.get_bind_group_layout(0),
            mip,
        })
    }

    /// Bake `mesh` (round `bounds`, with `layout`'s directions) into layer `layer` of `atlases`,
    /// mips included, sampling `materials`; returns the species' draw row. The work is submitted
    /// on `queue` (the caller polls when it needs the atlases on the CPU).
    #[allow(clippy::too_many_arguments)]
    pub fn bake(
        &self,
        device: &Device,
        queue: &Queue,
        mesh: &BakeMesh<'_>,
        materials: &BakeMaterials<'_>,
        bounds: &ImpostorBounds,
        layout: ImpostorLayout,
        atlases: &ImpostorAtlases,
        layer: u32,
    ) -> GpuImpostor {
        let spec = atlases.spec;
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("impostor-bake") });
        self.encode_frames(device, &mut encoder, mesh, materials, bounds, layout, atlases, layer);
        self.encode_mips(device, &mut encoder, atlases, layer, MipRule::CoveragePreserving);
        queue.submit(Some(encoder.finish()));
        GpuImpostor::new(&spec, layout, bounds, layer)
    }

    /// Build the mips of layer `layer` of `atlases` from its mip 0 by `rule`.
    pub fn build_mips(&self, device: &Device, queue: &Queue, atlases: &ImpostorAtlases, layer: u32, rule: MipRule) {
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("impostor-mips") });
        self.encode_mips(device, &mut encoder, atlases, layer, rule);
        queue.submit(Some(encoder.finish()));
    }

    #[allow(clippy::too_many_arguments)]
    fn encode_frames(
        &self,
        device: &Device,
        encoder: &mut wgpu::CommandEncoder,
        mesh: &BakeMesh<'_>,
        materials: &BakeMaterials<'_>,
        bounds: &ImpostorBounds,
        layout: ImpostorLayout,
        atlases: &ImpostorAtlases,
        layer: u32,
    ) {
        let spec = atlases.spec;
        let n = spec.frames;
        let frames: Vec<(u32, u32, [f32; 3])> = (0..n * n).map(|k| (k % n, k / n, frame_direction(n, layout, k % n, k / n))).collect();
        let cameras: Vec<BakeUniform> = frames.iter().map(|(_, _, dir)| BakeUniform { view_proj: frame_view_proj(bounds, *dir).to_cols_array() }).collect();
        let packs: Vec<PackUniform> = frames
            .iter()
            .map(|(column, row, dir)| {
                let axes = frame_axes(*dir);
                PackUniform {
                    right: axes.right,
                    radius: bounds.radius,
                    up: axes.up,
                    frame_px: spec.frame_px,
                    dir: *dir,
                    supersample: BAKE_SUPERSAMPLE,
                    frame: [*column, *row],
                    pad: [0; 2],
                }
            })
            .collect();
        let cameras = uniform_rows(device, "impostor-bake-cameras", &cameras);
        let packs = uniform_rows(device, "impostor-pack-frames", &packs);
        let part_materials: Vec<u32> = mesh.parts.iter().map(|part| part.material).collect();
        let part_materials = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("impostor-bake-materials"),
            contents: bytemuck::cast_slice(&part_materials),
            usage: wgpu::BufferUsages::VERTEX,
        });
        let targets = bake_targets(device, spec.frame_px * BAKE_SUPERSAMPLE);
        let atlas_views: Vec<TextureView> = (0..3).map(|atlas| atlases.level_view(atlas, layer, 0)).collect();
        for (k, _) in frames.iter().enumerate() {
            let group = self.bake_group(device, materials, &cameras, k as u64);
            {
                let colors: Vec<Option<wgpu::RenderPassColorAttachment<'_>>> = targets
                    .colors
                    .iter()
                    .map(|view| {
                        Some(wgpu::RenderPassColorAttachment {
                            view,
                            depth_slice: None,
                            resolve_target: None,
                            ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store },
                        })
                    })
                    .collect();
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("impostor-bake-frame"),
                    color_attachments: &colors,
                    depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                        view: &targets.depth,
                        depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Store }),
                        stencil_ops: None,
                    }),
                    timestamp_writes: None,
                    occlusion_query_set: None,
                    multiview_mask: None,
                });
                pass.set_pipeline(&self.bake);
                pass.set_bind_group(0, &group, &[]);
                pass.set_vertex_buffer(0, mesh.vertices.slice(..));
                pass.set_vertex_buffer(1, part_materials.slice(..));
                pass.set_index_buffer(mesh.indices.slice(..), wgpu::IndexFormat::Uint32);
                for (at, part) in mesh.parts.iter().enumerate() {
                    let instance = at as u32;
                    pass.draw_indexed(part.first_index..part.first_index + part.index_count, part.base_vertex, instance..instance + 1);
                }
            }
            let pack_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("impostor-pack"),
                layout: &self.pack_layout,
                entries: &[
                    view_entry(0, &targets.colors[0]),
                    view_entry(1, &targets.colors[1]),
                    view_entry(2, &targets.colors[2]),
                    view_entry(3, &targets.depth),
                    view_entry(4, &atlas_views[0]),
                    view_entry(5, &atlas_views[1]),
                    view_entry(6, &atlas_views[2]),
                    wgpu::BindGroupEntry { binding: 7, resource: uniform_row(&packs, k as u64, size_of::<PackUniform>()) },
                ],
            });
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("impostor-pack"), timestamp_writes: None });
            pass.set_pipeline(&self.pack);
            pass.set_bind_group(0, &pack_group, &[]);
            pass.dispatch_workgroups(spec.frame_px.div_ceil(PACK_WORKGROUP), spec.frame_px.div_ceil(PACK_WORKGROUP), 1);
        }
    }

    fn bake_group(&self, device: &Device, materials: &BakeMaterials<'_>, cameras: &Buffer, frame: u64) -> wgpu::BindGroup {
        let mut entries = vec![
            wgpu::BindGroupEntry { binding: 0, resource: uniform_row(cameras, frame, size_of::<BakeUniform>()) },
            wgpu::BindGroupEntry { binding: 1, resource: materials.materials.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 2, resource: materials.material_ext.as_entire_binding() },
        ];
        entries.extend(materials.arrays.iter().enumerate().map(|(at, view)| view_entry(3 + at as u32, view)));
        entries.push(wgpu::BindGroupEntry { binding: 3 + BAKE_TEXTURE_ARRAYS as u32, resource: wgpu::BindingResource::Sampler(materials.sampler) });
        device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("impostor-bake"), layout: &self.bake_layout, entries: &entries })
    }

    fn encode_mips(&self, device: &Device, encoder: &mut wgpu::CommandEncoder, atlases: &ImpostorAtlases, layer: u32, rule: MipRule) {
        let spec = atlases.spec;
        let levels = spec.mip_levels();
        if levels < 2 {
            return;
        }
        let rows: Vec<MipUniform> = (1..levels)
            .map(|level| MipUniform {
                frame_px: spec.frame_px >> level,
                base_px: spec.frame_px,
                rule: rule.code(),
                frames: spec.frames,
                cutoff: IMPOSTOR_COVERAGE_CUTOFF,
                pad: [0.0; 3],
            })
            .collect();
        let rows = uniform_rows(device, "impostor-mip-levels", &rows);
        let counters = u64::from(spec.frames * spec.frames) * MIP_COUNTERS_PER_FRAME * 4;
        let counts = device.create_buffer(&wgpu::BufferDescriptor { label: Some("impostor-mip-counts"), size: counters, usage: wgpu::BufferUsages::STORAGE, mapped_at_creation: false });
        let base = atlases.level_view(0, layer, 0);
        for level in 1..levels {
            let inputs: Vec<TextureView> = (0..3).map(|atlas| atlases.level_view(atlas, layer, level - 1)).collect();
            let outputs: Vec<TextureView> = (0..3).map(|atlas| atlases.level_view(atlas, layer, level)).collect();
            let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("impostor-mip"),
                layout: &self.mip_layout,
                entries: &[
                    view_entry(0, &inputs[0]),
                    view_entry(1, &inputs[1]),
                    view_entry(2, &inputs[2]),
                    view_entry(3, &base),
                    view_entry(4, &outputs[0]),
                    view_entry(5, &outputs[1]),
                    view_entry(6, &outputs[2]),
                    wgpu::BindGroupEntry { binding: 7, resource: uniform_row(&rows, u64::from(level - 1), size_of::<MipUniform>()) },
                    wgpu::BindGroupEntry { binding: 8, resource: counts.as_entire_binding() },
                ],
            });
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("impostor-mip"), timestamp_writes: None });
            pass.set_pipeline(&self.mip);
            pass.set_bind_group(0, &group, &[]);
            pass.dispatch_workgroups(spec.frames, spec.frames, 1);
        }
    }
}

/// The renderer's impostors (its pipelines stage bakes them): the baker, made on the first bake;
/// the atlas arrays of one class, as many layers as [`ImpostorStage::reserve`] admitted (the cap
/// when nothing was reserved), made again when the class changes (which drops the species baked
/// before: they bake again); and each layer's row.
#[derive(Default)]
pub struct ImpostorStage {
    baker: Option<ImpostorBaker>,
    atlases: Option<ImpostorAtlases>,
    species: Vec<GpuImpostor>,
}

impl ImpostorStage {
    /// Make `class`'s arrays for `species` species, at most its cap (the layers the ledger admits,
    /// `super::admit_species`), dropping any species baked before.
    pub fn reserve(&mut self, device: &Device, class: ImpostorClass, species: u32) {
        let spec = class.spec();
        self.atlases = Some(ImpostorAtlases::new(device, spec, species.clamp(1, spec.species_cap)));
        self.species.clear();
    }

    /// Bake `mesh` into the next layer of `class`'s arrays: its row, or None past the layers
    /// reserved (the species keeps its coarsest mesh; `degraded` lists it as `budget`).
    #[allow(clippy::too_many_arguments)]
    pub fn bake(
        &mut self,
        device: &Device,
        queue: &Queue,
        class: ImpostorClass,
        mesh: &BakeMesh<'_>,
        materials: &BakeMaterials<'_>,
        bounds: &ImpostorBounds,
        layout: ImpostorLayout,
    ) -> Result<Option<GpuImpostor>, RenderError> {
        let spec = class.spec();
        if self.atlases.as_ref().is_none_or(|atlases| atlases.spec != spec) {
            self.atlases = Some(ImpostorAtlases::new(device, spec, spec.species_cap));
            self.species.clear();
        }
        let layer = self.species.len() as u32;
        if self.atlases.as_ref().is_none_or(|atlases| layer >= atlases.layers) {
            return Ok(None);
        }
        if self.baker.is_none() {
            self.baker = Some(ImpostorBaker::new(device)?);
        }
        let (Some(baker), Some(atlases)) = (self.baker.as_ref(), self.atlases.as_ref()) else { return Ok(None) };
        let row = baker.bake(device, queue, mesh, materials, bounds, layout, atlases, layer);
        self.species.push(row);
        Ok(Some(row))
    }

    /// The atlas arrays, once a species was baked.
    pub fn atlases(&self) -> Option<&ImpostorAtlases> {
        self.atlases.as_ref()
    }

    /// The baked species' rows, by layer.
    pub fn species(&self) -> &[GpuImpostor] {
        &self.species
    }

    /// The arrays' bytes (the ledger's `BudgetKind::Impostors` at the cap).
    pub fn bytes(&self) -> u64 {
        self.atlases.as_ref().map_or(0, ImpostorAtlases::bytes)
    }
}
