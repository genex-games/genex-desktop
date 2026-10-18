//! The grass's GPU side (renderer pass 2 A.8): the grass row, the generation's buffers and compute
//! passes, and the draw group. The renderer's pipelines and draws are `renderer/grass_draw.rs`.
//!
//! - The generation (`shaders/foliage/grass_gen.wgsl`) binds its own group 0 (the row, the tiles'
//!   regions, the tile counts and offsets, the indirect arguments, the drawn order), an empty group
//!   1 and the terrain's group 2 (its row and maps: the heights and the control map).
//! - The draw group (group 2 of every grass pipeline, `grass_core.wgsl`): binding 0 the
//!   [`GpuGrass`] row (uniform, vertex and fragment), 1 the regions and 2 the drawn order (storage,
//!   vertex only). It adds no sampled texture and no fragment storage buffer to the forward stage
//!   (tests/grass.rs).

use bytemuck::{Pod, Zeroable};
use wgpu::{BindGroup, BindGroupLayout, BindGroupLayoutEntry, Buffer, BufferUsages, ComputePipeline, Device, Queue, ShaderStages};

use super::{GRASS_TILE_CELLS, GrassGrid, GrassLayer, GrassQuality, grid};
use crate::compile::Compiled;
use crate::error::RenderError;
use crate::tables::{buffer, compute_storage, compute_uniform, entry, pipeline_layout, storage, uniform};
use crate::terrain::{MAX_TERRAIN_LAYERS, TerrainDesc};

/// The grass's world, prepass and motion entry points: the forward module's sources (the list of
/// `shaders::FORWARD`), then the wind and the grass's (so a blade shades through the same chunks
/// and bindings as a built-in surface; decals do not project onto blades).
pub const GRASS: &str = crate::shaders::minify::shipped_wgsl!(concat!(
    include_str!("../../shaders/common.wgsl"),
    include_str!("../../shaders/clip_position.wgsl"),
    include_str!("../../shaders/effects.wgsl"),
    include_str!("../../shaders/forward_env.wgsl"),
    include_str!("../../shaders/pbr.wgsl"),
    include_str!("../../shaders/lighting/surface.wgsl"),
    include_str!("../../shaders/lighting/decals.wgsl"),
    include_str!("../../shaders/screen/ssr_apply.wgsl"),
    include_str!("../../shaders/lighting/ambient.wgsl"),
    include_str!("../../shaders/lighting/sun.wgsl"),
    include_str!("../../shaders/lighting/subsurface.wgsl"),
    include_str!("../../shaders/lighting/local_lights.wgsl"),
    include_str!("../../shaders/lighting/fog.wgsl"),
    include_str!("../../shaders/lighting/output.wgsl"),
    include_str!("../../shaders/forward_effects.wgsl"),
    include_str!("../../shaders/alpha_mask.wgsl"),
    include_str!("../../shaders/forward.wgsl"),
    include_str!("../../shaders/wind.wgsl"),
    include_str!("../../shaders/foliage/grass_types.wgsl"),
    include_str!("../../shaders/foliage/grass_core.wgsl"),
    include_str!("../../shaders/foliage/grass.wgsl")
));

/// The grass's sun casters.
pub const GRASS_SHADOW: &str = crate::shaders::minify::shipped_wgsl!(concat!(
    include_str!("../../shaders/common.wgsl"),
    include_str!("../../shaders/shadow_caster.wgsl"),
    include_str!("../../shaders/wind.wgsl"),
    include_str!("../../shaders/foliage/grass_types.wgsl"),
    include_str!("../../shaders/foliage/grass_core.wgsl"),
    include_str!("../../shaders/foliage/grass_shadow.wgsl")
));

/// The grass's generation (three compute passes).
pub const GRASS_GEN: &str = crate::shaders::minify::shipped_wgsl!(concat!(
    include_str!("../../shaders/foliage/grass_types.wgsl"),
    include_str!("../../shaders/terrain/terrain_core.wgsl"),
    include_str!("../../shaders/foliage/grass_gen.wgsl")
));

/// The world pass's entry points.
pub const FORWARD_ENTRIES: (&str, &str) = ("vs_grass", "fs_grass");
/// The prepass's entry points.
pub const PREPASS_ENTRIES: (&str, &str) = ("vs_grass", "fs_grass_prepass");
/// The motion prepass's entry points.
pub const MOTION_ENTRIES: (&str, &str) = ("vs_grass_motion", "fs_grass_motion");
/// The sun casters' vertex entry point.
pub const SHADOW_VERTEX_ENTRY: &str = "vs_grass_shadow";
/// The generation's entry points: the tiles, the scan, the pack.
pub const GEN_ENTRIES: [&str; 3] = ["cs_grass_tiles", "cs_grass_scan", "cs_grass_pack"];
/// The draw group's index in every grass pipeline.
pub const GRASS_GROUP: u32 = 2;
/// The motion node's group's index in the grass's motion prepass.
pub const GRASS_MOTION_GROUP: u32 = 3;

/// One layer's grass (`GxGrassLayer`).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuGrassLayer {
    /// x: blades per square metre; y, z: shortest and tallest blade; w: transmission.
    pub shape: [f32; 4],
    /// x, y: narrowest and widest root; z: dry share; w: flower share.
    pub width: [f32; 4],
    /// rgb: the foot's colour.
    pub root: [f32; 4],
    /// rgb: the tip's colour.
    pub tip: [f32; 4],
    /// rgb: a dry tip's colour.
    pub dry: [f32; 4],
    /// rgb: a flower's colour.
    pub flower: [f32; 4],
}

impl GpuGrassLayer {
    /// The row of `grass` (zero: bare).
    pub fn of(grass: Option<&GrassLayer>) -> GpuGrassLayer {
        let Some(g) = grass else { return GpuGrassLayer::default() };
        let rgb = |c: [f32; 3]| [c[0], c[1], c[2], 0.0];
        GpuGrassLayer {
            shape: [g.density, g.height[0], g.height[1], g.transmission],
            width: [g.width[0], g.width[1], g.dry_share, g.flower_share],
            root: rgb(g.root),
            tip: rgb(g.tip),
            dry: rgb(g.dry),
            flower: rgb(g.flower),
        }
    }
}

/// The frame's grass row (`GxGrass`).
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Pod, Zeroable)]
pub struct GpuGrass {
    /// xyz: the camera; w: the radius.
    pub camera: [f32; 4],
    /// The camera's frustum planes (inward).
    pub planes: [[f32; 4]; 6],
    /// x, y: the square's first cell; z: tiles a side; w: vertices a blade.
    pub grid: [i32; 4],
    /// x: the cell side; y: the quality's density share; z, w: the terrain's lowest and highest height.
    pub cell: [f32; 4],
    /// x: this frame's simulated seconds; y: last frame's; z: segments; w: one render pixel's size
    /// at a clip w of 1 (metres per metre of view depth; [`GrassFrameInput::pixel`]).
    pub time: [f32; 4],
    /// The layers' grass.
    pub layers: [GpuGrassLayer; MAX_TERRAIN_LAYERS],
}

/// What a frame's grass is generated from.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GrassFrameInput {
    /// The camera.
    pub camera: [f32; 3],
    /// The camera's frustum planes (inward).
    pub planes: [[f32; 4]; 6],
    /// This frame's simulated seconds and last frame's.
    pub seconds: [f32; 2],
    /// One render pixel's size at a clip w of 1, `2 / (P11 · render height)` (a perspective
    /// camera's metres per metre of view depth; an orthographic camera's metres): a fragment's
    /// footprint on a blade is its clip w times it, never a screen derivative (GA1 wave 4: across
    /// a quad of sub-pixel blades a derivative came out differently from one run to the next on
    /// Apple GPUs, and a settled capture with it).
    pub pixel: f32,
}

/// One render pixel's size at a clip w of 1 for a frame drawn through `view_proj` (column-major)
/// at render `height` ([`GrassFrameInput::pixel`]): clip y's row is the projection's y scale times
/// the view's unit up axis, so its length is that scale whatever the view.
pub fn pixel_at_unit_depth(view_proj: &[f32; 16], height: u32) -> f32 {
    let scale = (view_proj[1] * view_proj[1] + view_proj[5] * view_proj[5] + view_proj[9] * view_proj[9]).sqrt();
    2.0 / (scale * height.max(1) as f32).max(f32::MIN_POSITIVE)
}

/// What a terrain's grass is made of, kept with the grass: each layer's row, the terrain's height
/// range and the densest layer's blades per square metre.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GrassBase {
    /// Each layer's grass row (zero: bare).
    pub layers: [GpuGrassLayer; MAX_TERRAIN_LAYERS],
    /// The terrain's lowest and highest height.
    pub heights: [f32; 2],
    /// The densest layer's blades per square metre (0: no grass).
    pub densest: f32,
}

impl GrassBase {
    /// The grass of `desc`.
    pub fn of(desc: &TerrainDesc) -> GrassBase {
        let (min, step) = desc.heights.quantization();
        let mut layers = [GpuGrassLayer::default(); MAX_TERRAIN_LAYERS];
        for (row, layer) in layers.iter_mut().zip(&desc.layers) {
            *row = GpuGrassLayer::of(layer.grass.as_ref());
        }
        GrassBase { layers, heights: [min, min + 65535.0 * step], densest: super::densest(desc) }
    }
}

/// The grass row of `base` at `quality` on `grid` for `input`.
pub fn grass_row(base: &GrassBase, quality: &GrassQuality, grid: &GrassGrid, input: &GrassFrameInput) -> GpuGrass {
    let [x, y, z] = input.camera;
    GpuGrass {
        camera: [x, y, z, quality.radius],
        planes: input.planes,
        grid: [grid.origin[0], grid.origin[1], grid.tiles as i32, quality.blade_vertices() as i32],
        cell: [grid.cell(), quality.density, base.heights[0], base.heights[1]],
        time: [input.seconds[0], input.seconds[1], quality.segments.min(super::GRASS_SEGMENTS_MAX) as f32, input.pixel],
        layers: base.layers,
    }
}

/// The draw group's layout entries.
pub fn layout_entries() -> [BindGroupLayoutEntry; 3] {
    [uniform(0, false, ShaderStages::VERTEX_FRAGMENT), storage(1, true, ShaderStages::VERTEX), storage(2, true, ShaderStages::VERTEX)]
}

/// The generation group's layout entries.
pub fn gen_layout_entries() -> [BindGroupLayoutEntry; 5] {
    [compute_uniform(0), compute_storage(1, false), compute_storage(2, false), compute_storage(3, false), compute_storage(4, false)]
}

/// The bytes of a blade record.
const RECORD_BYTES: u64 = 16;

/// The buffers one size of square needs.
struct GrassBuffers {
    tiles: u32,
    regions: Buffer,
    counts: Buffer,
    args: Buffer,
    order: Buffer,
    gen_group: BindGroup,
    draw_group: BindGroup,
}

/// The grass on the GPU: its row, its buffers (sized for the square's tiles), its compute
/// pipelines and groups. Made with the terrain; the buffers grow with a quality's square.
pub struct GrassGpu {
    row: Buffer,
    layout: BindGroupLayout,
    gen_layout: BindGroupLayout,
    empty_group: BindGroup,
    passes: [Compiled<ComputePipeline>; 3],
    buffers: Option<GrassBuffers>,
    base: GrassBase,
    /// The grid and row of the last frame prepared (None: no grass this frame).
    frame: Option<(GrassGrid, GpuGrass)>,
}

impl GrassGpu {
    /// The grass of `desc`, its generation reading the terrain's group (`terrain_layout`).
    pub fn new(device: &Device, desc: &TerrainDesc, terrain_layout: &BindGroupLayout) -> Result<GrassGpu, RenderError> {
        let row = buffer(device, "grass row", size_of::<GpuGrass>() as u64, BufferUsages::UNIFORM | BufferUsages::COPY_DST)?;
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("grass"), entries: &layout_entries() });
        let gen_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("grass generation"), entries: &gen_layout_entries() });
        let empty_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("grass empty"), entries: &[] });
        let empty_group = device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("grass empty"), layout: &empty_layout, entries: &[] });
        let module = crate::shaders::module(device, "grass generation", GRASS_GEN)?;
        let pipeline_layout = pipeline_layout(device, "grass generation", &[&gen_layout, &empty_layout, terrain_layout]);
        let pass = |entry: &str| {
            crate::compile::compute_pipeline(device, &wgpu::ComputePipelineDescriptor {
                label: Some(entry),
                layout: Some(&pipeline_layout),
                module: &module,
                entry_point: Some(entry),
                compilation_options: crate::compile::written_first(),
                cache: None,
            })
        };
        let passes = GEN_ENTRIES.map(pass);
        Ok(GrassGpu { row, layout, gen_layout, empty_group, passes, buffers: None, base: GrassBase::of(desc), frame: None })
    }

    /// The draw group's layout (every grass pipeline's group 2).
    pub fn layout(&self) -> &BindGroupLayout {
        &self.layout
    }

    /// What the grass is made of.
    pub fn base(&self) -> &GrassBase {
        &self.base
    }

    /// This frame's grid and row (None: no grass this frame).
    pub fn frame(&self) -> Option<&(GrassGrid, GpuGrass)> {
        self.frame.as_ref()
    }

    /// Prepare a frame of grass at `quality` for `input` (none when the quality draws none or no
    /// layer grows any): the row written and the buffers sized for its square.
    pub fn prepare(&mut self, device: &Device, queue: &Queue, quality: &GrassQuality, input: &GrassFrameInput) -> Result<(), RenderError> {
        self.frame = None;
        if !quality.drawn() || self.base.densest <= 0.0 {
            return Ok(());
        }
        let grid = grid(self.base.densest, quality, input.camera);
        let row = grass_row(&self.base, quality, &grid, input);
        if self.buffers.as_ref().is_none_or(|held| held.tiles < grid.tile_count()) {
            self.buffers = Some(self.make_buffers(device, grid.tile_count())?);
        }
        queue.write_buffer(&self.row, 0, bytemuck::bytes_of(&row));
        self.frame = Some((grid, row));
        Ok(())
    }

    fn make_buffers(&self, device: &Device, tiles: u32) -> Result<GrassBuffers, RenderError> {
        let blades = u64::from(tiles) * u64::from(GRASS_TILE_CELLS);
        let regions = buffer(device, "grass regions", blades * RECORD_BYTES, BufferUsages::STORAGE | BufferUsages::COPY_SRC)?;
        let counts = buffer(device, "grass tiles", u64::from(tiles) * 8, BufferUsages::STORAGE)?;
        let args = buffer(device, "grass args", 16, BufferUsages::STORAGE | BufferUsages::INDIRECT | BufferUsages::COPY_SRC)?;
        let order = buffer(device, "grass order", blades * 4, BufferUsages::STORAGE | BufferUsages::COPY_SRC)?;
        let gen_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("grass generation"),
            layout: &self.gen_layout,
            entries: &[entry(0, &self.row), entry(1, &regions), entry(2, &counts), entry(3, &args), entry(4, &order)],
        });
        let draw_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("grass"),
            layout: &self.layout,
            entries: &[entry(0, &self.row), entry(1, &regions), entry(2, &order)],
        });
        Ok(GrassBuffers { tiles, regions, counts, args, order, gen_group, draw_group })
    }

    /// Record this frame's generation into `encoder` (the terrain's group `terrain` bound as group
    /// 2). Returns the compute passes recorded (0 without grass this frame).
    pub fn encode(&self, encoder: &mut wgpu::CommandEncoder, terrain: &BindGroup) -> u32 {
        let (Some((grid, _)), Some(buffers)) = (self.frame.as_ref(), self.buffers.as_ref()) else { return 0 };
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("grass"), timestamp_writes: None });
        pass.set_bind_group(0, &buffers.gen_group, &[]);
        pass.set_bind_group(1, &self.empty_group, &[]);
        pass.set_bind_group(2, terrain, &[]);
        let [tiles, scan, pack] = &self.passes;
        pass.set_pipeline(tiles);
        pass.dispatch_workgroups(grid.tiles, grid.tiles, 1);
        pass.set_pipeline(scan);
        pass.dispatch_workgroups(1, 1, 1);
        pass.set_pipeline(pack);
        pass.dispatch_workgroups(grid.tiles, grid.tiles, 1);
        1
    }

    /// Draw this frame's blades into `pass` (the pipeline and groups 0 and 1 set by the caller,
    /// group 2 set here). Returns the draws recorded.
    pub fn draw(&self, pass: &mut wgpu::RenderPass<'_>) -> u32 {
        let (Some(_), Some(buffers)) = (self.frame.as_ref(), self.buffers.as_ref()) else { return 0 };
        pass.set_bind_group(GRASS_GROUP, &buffers.draw_group, &[]);
        pass.draw_indirect(&buffers.args, 0);
        1
    }

    /// Whether this frame draws grass.
    pub fn drawn(&self) -> bool {
        self.frame.is_some() && self.buffers.is_some()
    }

    /// The bytes it holds on the GPU (the budget ledger's row).
    pub fn bytes(&self) -> u64 {
        let buffers = self.buffers.as_ref().map_or(0, |b| b.regions.size() + b.counts.size() + b.args.size() + b.order.size());
        self.row.size() + buffers
    }

    /// The indirect arguments and the drawn order (tests read the blades back), when made.
    pub fn readback_buffers(&self) -> Option<(&Buffer, &Buffer, &Buffer)> {
        self.buffers.as_ref().map(|b| (&b.args, &b.order, &b.regions))
    }
}
