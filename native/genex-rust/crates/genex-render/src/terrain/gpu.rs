//! The terrain's GPU side (renderer pass 2 A.7): its group (the terrain row, the drawn rows and
//! the maps), the shared grid's indices, and each frame's rows per view. The renderer's pipelines
//! and draws are `renderer/terrain_draw.rs`.
//!
//! The terrain group is group 2 of every terrain pipeline (`shaders/terrain/terrain_core.wgsl`):
//! binding 0 the [`GpuTerrain`] row (uniform, vertex and fragment), 1 the frame's rows (storage,
//! vertex), 2 the maps (storage, vertex and fragment: heights, control words, normal pyramid). It adds no
//! sampled texture to any stage (the layers come from the forward frame group's material arrays),
//! and one fragment storage buffer to the forward stage's (7 of 8 with the frame group's 6),
//! held by tests/terrain.rs.

use bytemuck::{Pod, Zeroable};
use wgpu::{BindGroup, BindGroupLayout, BindGroupLayoutEntry, Buffer, BufferUsages, Device, Queue, ShaderStages};

use super::{MAX_NORMAL_LEVELS, MAX_TERRAIN_LAYERS, MAX_TERRAIN_LODS, TERRAIN_GRID, TerrainDesc, TerrainFrame, TerrainLod, TerrainQuality, TerrainTree, grid_indices};
use crate::error::RenderError;
use crate::layout::NO_TEXTURE;
use crate::tables::{buffer, entry, storage, uniform};

/// The terrain's forward, prepass and motion entry points: the forward module's sources, then the
/// terrain's (so the terrain shades through the same chunks and bindings as a built-in surface).
pub const TERRAIN: &str = crate::shaders::minify::shipped_wgsl!(concat!(
    include_str!("../../shaders/common.wgsl"),
    include_str!("../../shaders/clip_position.wgsl"),
    include_str!("../../shaders/effects.wgsl"),
    include_str!("../../shaders/forward_env.wgsl"),
    include_str!("../../shaders/pbr.wgsl"),
    include_str!("../../shaders/lighting/surface.wgsl"),
    include_str!("../../shaders/lighting/ambient.wgsl"),
    include_str!("../../shaders/lighting/sun.wgsl"),
    include_str!("../../shaders/lighting/local_lights.wgsl"),
    include_str!("../../shaders/lighting/fog.wgsl"),
    include_str!("../../shaders/lighting/output.wgsl"),
    include_str!("../../shaders/forward_effects.wgsl"),
    include_str!("../../shaders/alpha_mask.wgsl"),
    include_str!("../../shaders/forward.wgsl"),
    include_str!("../../shaders/terrain/terrain_core.wgsl"),
    include_str!("../../shaders/terrain/hextile.wgsl"),
    include_str!("../../shaders/terrain/terrain.wgsl")
));

/// The terrain's sun casters.
pub const TERRAIN_SHADOW: &str = crate::shaders::minify::shipped_wgsl!(concat!(
    include_str!("../../shaders/common.wgsl"),
    include_str!("../../shaders/shadow_caster.wgsl"),
    include_str!("../../shaders/terrain/terrain_core.wgsl"),
    include_str!("../../shaders/terrain/terrain_shadow.wgsl")
));

/// The world pass's entry points.
pub const FORWARD_ENTRIES: (&str, &str) = ("vs_terrain", "fs_terrain");
/// The prepass's entry points.
pub const PREPASS_ENTRIES: (&str, &str) = ("vs_terrain", "fs_terrain_prepass");
/// The motion prepass's entry points.
pub const MOTION_ENTRIES: (&str, &str) = ("vs_terrain_motion", "fs_terrain_motion");
/// The sun casters' vertex entry point.
pub const SHADOW_VERTEX_ENTRY: &str = "vs_terrain_shadow";
/// The terrain group's index in every terrain pipeline.
pub const TERRAIN_GROUP: u32 = 2;
/// The motion node's group's index in the terrain's motion prepass.
pub const TERRAIN_MOTION_GROUP: u32 = 3;
/// The hex-tiling switch (`GX_TERRAIN_DETILE`).
pub const DETILE_CONSTANT: &str = "GX_TERRAIN_DETILE";

/// One layer's row (`GxTerrainLayer`).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuTerrainLayer {
    /// x: the base colour texture, y: the data texture (`NO_TEXTURE`: none); z, w: 0.
    pub textures: [u32; 4],
    /// rgb: the tint; w: tiles per metre.
    pub tint_scale: [f32; 4],
    /// x: the roughness, y: the normal strength; z, w: 0.
    pub params: [f32; 4],
}

/// The terrain row (`GxTerrain`).
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Pod, Zeroable)]
pub struct GpuTerrain {
    /// xy: world x, z of sample (0, 0); z: metres between samples; w: samples per metre.
    pub origin: [f32; 4],
    /// x: the lowest height; y: one quantization step.
    pub heights: [f32; 4],
    /// x, y: samples across and down; z: the control words' first word; w: the normal pyramid's
    /// levels.
    pub size: [u32; 4],
    /// x: layers.
    pub counts: [u32; 4],
    /// x: macro variation, y: 1 / its feature size, z: wet darkening, w: wet roughness.
    pub look: [f32; 4],
    /// x: the height blend's depth.
    pub blend: [f32; 4],
    /// Each level's morph constants.
    pub morph: [[f32; 4]; MAX_TERRAIN_LODS],
    /// Each normal pyramid level's first word, four a row.
    pub normal_levels: [[u32; 4]; MAX_NORMAL_LEVELS / 4],
    /// The layers.
    pub layers: [GpuTerrainLayer; MAX_TERRAIN_LAYERS],
}

/// The terrain row of `desc` under `lod`.
pub fn terrain_row(desc: &TerrainDesc, lod: &TerrainLod) -> GpuTerrain {
    let heights = &desc.heights;
    let (w, d) = heights.samples();
    let (min, step) = heights.quantization();
    let control = control_offset(w, d);
    let offsets = super::normal_level_offsets((w, d));
    let mut normal_levels = [[0u32; 4]; MAX_NORMAL_LEVELS / 4];
    for (k, offset) in offsets.iter().enumerate() {
        normal_levels[k / 4][k % 4] = normals_offset(w, d) + offset;
    }
    let mut morph = [[0.0; 4]; MAX_TERRAIN_LODS];
    for (l, row) in morph.iter_mut().enumerate() {
        let c = lod.morph_constants(l as u32);
        *row = [c[0], c[1], 0.0, 0.0];
    }
    let mut layers = [GpuTerrainLayer::default(); MAX_TERRAIN_LAYERS];
    for (row, layer) in layers.iter_mut().zip(&desc.layers) {
        let reference = |texture: Option<crate::texture::TextureId>| texture.map_or(NO_TEXTURE, |id| id.reference());
        *row = GpuTerrainLayer {
            textures: [reference(layer.albedo), reference(layer.data), 0, 0],
            tint_scale: [layer.tint[0], layer.tint[1], layer.tint[2], 1.0 / layer.tile],
            params: [layer.roughness, layer.normal_strength, 0.0, 0.0],
        };
    }
    let look = desc.look;
    GpuTerrain {
        origin: [heights.origin()[0], heights.origin()[1], heights.spacing(), 1.0 / heights.spacing()],
        heights: [min, step, 0.0, 0.0],
        size: [w, d, control, offsets.len() as u32],
        counts: [desc.layers.len() as u32, 0, 0, 0],
        look: [look.macro_variation, 1.0 / look.macro_scale.max(1e-3), look.wet_darkening, look.wet_roughness],
        blend: [look.blend_depth.max(1e-3), 0.0, 0.0, 0.0],
        morph,
        normal_levels,
        layers,
    }
}

/// Where the control words start in the maps (words), for `w` x `d` samples: after the heights.
pub const fn control_offset(w: u32, d: u32) -> u32 {
    (w * d).div_ceil(2)
}

/// Where the normal pyramid starts in the maps (words): after the control words.
pub const fn normals_offset(w: u32, d: u32) -> u32 {
    control_offset(w, d) + w * d
}

/// The maps the GPU reads: the packed heights, the control words, the normal pyramid.
pub fn maps(desc: &TerrainDesc) -> Vec<u32> {
    let mut words = desc.heights.packed_heights();
    words.extend(desc.control_words());
    words.extend(desc.heights.packed_normals());
    words
}

/// The terrain group's layout entries.
pub fn layout_entries() -> [BindGroupLayoutEntry; 3] {
    let both = ShaderStages::VERTEX_FRAGMENT;
    [uniform(0, false, both), storage(1, true, ShaderStages::VERTEX), storage(2, true, both)]
}

/// The bytes of a row in the rows table.
const ROW_BYTES: u64 = 16;

/// A terrain on the GPU: its tree and levels, its group, its grid and the current frame's rows.
pub struct TerrainGpu {
    tree: TerrainTree,
    lod: TerrainLod,
    quality: TerrainQuality,
    desc_row: GpuTerrain,
    layout: BindGroupLayout,
    row: Buffer,
    maps: Buffer,
    rows: Buffer,
    rows_capacity: u64,
    group: BindGroup,
    indices: Buffer,
    /// The full grid's indices, then the quarter's.
    index_counts: (u32, u32),
    frame: TerrainFrame,
    version: u64,
}

impl TerrainGpu {
    /// `desc` on the GPU at `quality` (checked first: `mesh-invalid`; buffers past the caps:
    /// `buffer-too-large`).
    pub fn new(device: &Device, queue: &Queue, desc: &TerrainDesc, quality: TerrainQuality, version: u64) -> Result<TerrainGpu, RenderError> {
        desc.check()?;
        let tree = TerrainTree::new(&desc.heights);
        let lod = TerrainLod::new(&tree, quality.detail);
        let desc_row = terrain_row(desc, &lod);
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("terrain"), entries: &layout_entries() });
        let row = buffer(device, "terrain row", size_of::<GpuTerrain>() as u64, BufferUsages::UNIFORM | BufferUsages::COPY_DST)?;
        queue.write_buffer(&row, 0, bytemuck::bytes_of(&desc_row));
        let words = maps(desc);
        let maps = buffer(device, "terrain maps", words.len() as u64 * 4, BufferUsages::STORAGE | BufferUsages::COPY_DST)?;
        queue.write_buffer(&maps, 0, bytemuck::cast_slice(&words));
        let full = grid_indices(TERRAIN_GRID);
        let quarter = grid_indices(TERRAIN_GRID / 2);
        let index_counts = (full.len() as u32, quarter.len() as u32);
        let all: Vec<u32> = full.into_iter().chain(quarter).collect();
        let indices = buffer(device, "terrain grid", all.len() as u64 * 4, BufferUsages::INDEX | BufferUsages::COPY_DST)?;
        queue.write_buffer(&indices, 0, bytemuck::cast_slice(&all));
        let rows_capacity = 256;
        let rows = buffer(device, "terrain rows", rows_capacity * ROW_BYTES, BufferUsages::STORAGE | BufferUsages::COPY_DST)?;
        let group = Self::make_group(device, &layout, [&row, &rows, &maps]);
        Ok(TerrainGpu { tree, lod, quality, desc_row, layout, row, maps, rows, rows_capacity, group, indices, index_counts, frame: TerrainFrame::default(), version })
    }

    fn make_group(device: &Device, layout: &BindGroupLayout, [row, rows, maps]: [&Buffer; 3]) -> BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("terrain"), layout, entries: &[entry(0, row), entry(1, rows), entry(2, maps)] })
    }

    /// Draw at `quality` from now on: new ranges (the row again) when its detail changed.
    pub fn set_quality(&mut self, queue: &Queue, quality: TerrainQuality) {
        if quality.detail != self.quality.detail {
            self.lod = TerrainLod::new(&self.tree, quality.detail);
            for (l, row) in self.desc_row.morph.iter_mut().enumerate() {
                let c = self.lod.morph_constants(l as u32);
                *row = [c[0], c[1], 0.0, 0.0];
            }
            queue.write_buffer(&self.row, 0, bytemuck::bytes_of(&self.desc_row));
        }
        self.quality = quality;
    }

    /// This frame's rows for a camera at `camera`, culled by each of `views` (the camera's, then
    /// each drawn cascade's frustum), uploaded (the rows table grows to fit).
    pub fn prepare(&mut self, device: &Device, queue: &Queue, camera: [f32; 3], views: &[[[f32; 4]; 6]]) -> Result<(), RenderError> {
        self.frame = TerrainFrame::plan(&self.tree, &self.lod, camera, views);
        let needed = self.frame.rows.len().max(1) as u64;
        if needed > self.rows_capacity {
            self.rows_capacity = needed.next_power_of_two();
            self.rows = buffer(device, "terrain rows", self.rows_capacity * ROW_BYTES, BufferUsages::STORAGE | BufferUsages::COPY_DST)?;
            self.group = Self::make_group(device, &self.layout, [&self.row, &self.rows, &self.maps]);
        }
        let words: Vec<[u32; 4]> = self.frame.rows.iter().map(|row| row.gpu()).collect();
        if !words.is_empty() {
            queue.write_buffer(&self.rows, 0, bytemuck::cast_slice(&words));
        }
        Ok(())
    }

    /// The group's layout (every terrain pipeline's group 2).
    pub fn layout(&self) -> &BindGroupLayout {
        &self.layout
    }

    /// The quality it draws at.
    pub fn quality(&self) -> TerrainQuality {
        self.quality
    }

    /// Its levels.
    pub fn lod(&self) -> &TerrainLod {
        &self.lod
    }

    /// Its tree.
    pub fn tree(&self) -> &TerrainTree {
        &self.tree
    }

    /// The version [`TerrainGpu::new`] was given (the caller's identity for the terrain it drew).
    pub fn version(&self) -> u64 {
        self.version
    }

    /// This frame's rows.
    pub fn frame(&self) -> &TerrainFrame {
        &self.frame
    }

    /// The bytes it holds on the GPU (the budget ledger's row).
    pub fn bytes(&self) -> u64 {
        self.row.size() + self.maps.size() + self.rows.size() + self.indices.size()
    }

    /// Draw view `view`'s rows into `pass` (the pipeline and groups 0 and 1 set by the caller;
    /// group 2 and the grid's index buffer set here): its full nodes, then its quarters. Returns
    /// the draws recorded.
    pub fn draw(&self, pass: &mut wgpu::RenderPass<'_>, view: usize) -> u32 {
        let Some(&[first, full, quarters_first, quarters]) = self.frame.views.get(view) else { return 0 };
        if full + quarters == 0 {
            return 0;
        }
        pass.set_bind_group(TERRAIN_GROUP, &self.group, &[]);
        pass.set_index_buffer(self.indices.slice(..), wgpu::IndexFormat::Uint32);
        let (full_indices, quarter_indices) = self.index_counts;
        let mut draws = 0;
        if full > 0 {
            pass.draw_indexed(0..full_indices, 0, first..first + full);
            draws += 1;
        }
        if quarters > 0 {
            pass.draw_indexed(full_indices..full_indices + quarter_indices, 0, quarters_first..quarters_first + quarters);
            draws += 1;
        }
        draws
    }
}
