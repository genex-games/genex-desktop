//! Irradiance volumes (renderer pass 2 A.4; prior art A2.1): boxes of the world whose diffuse
//! environment light comes from a grid of cells baked in the scene instead of the sky's SH9, so a
//! white floor beside a sunlit red wall turns pink and a room's inside is not lit by the sky through
//! its walls.
//!
//! - **What a game declares** ([`IrradianceVolume`], `Lighting::irradiance_volumes`): an
//!   axis-aligned box, its cells along each axis (about one per metre by default), how far past its
//!   faces it fades out and a multiplier. Hostile values are held or dropped
//!   ([`IrradianceVolume::held`]). The first [`EnvironmentQuality::irradiance_volumes`] a frame
//!   declares are baked.
//! - **What a cell holds** (an ambient cube, Valve 2006, in Bevy v0.20's `IrradianceVolume` packing,
//!   MIT OR Apache-2.0): six `rgba16float` texels, one per axis direction, rgb the cosine-weighted
//!   mean radiance of the hemisphere around it (irradiance over pi, the SH9 term's units) and a the
//!   cell's two reaches along the texel's axis (how far it sees before a surface, both ways; 5-bit
//!   codes, [`pack_reaches`]), so the three texels a lookup reads toward the normal also give all
//!   six reaches. A volume of `X x Y x Z` cells is a
//!   block of `X x 2Y x 3Z` texels: the negative directions in the upper half of y, the axes in
//!   thirds of z ([`atlas_texel`]). Every baked volume's block sits side by side along x in one 3D
//!   atlas ([`AtlasLayout`]), bound to the forward pass at binding 32 ([`ENV_IRRADIANCE`]; plan
//!   section 2: the forward stage's 15th sampled texture of 16 under owner decision D1 - binding 18
//!   went to the PCSS point sampler in P2-0.3, binding 31 is the LOD crossfade's reserve).
//! - **Rows and binning**: a volume is binned with the reflection probes (`cluster::ClusterKind::Probe`)
//!   and its row ([`volume_row`], a `probes::GpuProbeRow` whose layer is negative) shares their table
//!   at binding 22, so the volumes take no storage buffer.
//! - **Shading** (`shaders/forward_env.wgsl`, `gx_env_light`): the fragment walks the volumes of
//!   its tile and z-bin, weighs each by its fade past the box (`probes::influence`) and how far it
//!   has faded in, and fills what they leave of the unit weight with the sky's SH9 ([`blend`]). A
//!   volume's lookup ([`grid_irradiance`]) offsets the point along its normal by
//!   [`NORMAL_BIAS_SPACING`] of a cell and either reads the three faces of the ambient cube through
//!   the sampler's trilinear filter (three fetches); with leak control (desktop and web medium and
//!   up) the position is first moved along each axis toward the side whose cell sees the point
//!   ([`visible_share`]: the cell's reach on that side of the axis against the point's distance,
//!   within [`REACH_TOLERANCE`] of a cell; six more loads), so a cell behind a 20 cm wall lends
//!   nothing.
//! - **Bake** (graph node 11, before the reflection probes' captures): a cell is six faces of a
//!   [`CAPTURE_SIDE`]-texel cube drawn from its centre with the probes' capture (the forward shading,
//!   lit by the sun through a shadow map of the volume's box, both sides of every triangle drawn so a
//!   cell inside a wall sees the wall close by in every direction and is hidden from everything), then
//!   reduced into its ambient cube (`shaders/ibl/irradiance.wgsl`) in a staging block that is copied
//!   into the volume's atlas block whole once every cell is baked (no frame reads a block mixing two
//!   bakes). [`GridSchedule`]: a volume never baked is baked [`CELLS_PER_FRAME`] cells a frame and
//!   fades in over [`FADE_IN_FRAMES`] once published; a stale one (the sky rebaked) is rebaked the same
//!   way on the quality's cadence while its last bake stays bound; a settled capture bakes whatever
//!   differs whole, in batches of [`BATCH_CELLS`] cells.
//!
//! The three.js r186 `LightProbeGrid` bake (MIT) is the idea behind the GPU bake: cells captured
//! in the scene and projected on the GPU, time-sliced; no code is ported from it.

use bytemuck::{Pod, Zeroable};
use glam::{Mat4, Vec3};
use wgpu::{
    BindGroup, BindGroupLayout, BindGroupLayoutEntry, BindingResource, Buffer, BufferUsages, ComputePipeline, Device, Queue, Sampler, Texture, TextureFormat,
    TextureUsages, TextureView, TextureViewDimension,
};

use crate::cluster::ClusterSphere;
use crate::compile::Compiled;
use crate::error::RenderError;
use crate::probes::{CaptureStore, GpuProbeRow, ReflectionProbe};
use crate::settings::EnvironmentQuality;

/// Whether the renderer bakes volumes and the forward pass reads them.
pub const LANDED: bool = true;

/// Volumes binned and baked at most (they share the probes' binning cap,
/// `cluster::MAX_BINNED_PROBES`, with the reflection probes).
pub const MAX_VOLUMES: usize = 8;
/// The most cells along one axis of a volume (6 bits of its row).
pub const CELLS_PER_AXIS_MAX: u32 = 32;
/// The most cells one volume holds (a larger request is cut along its longest axes).
pub const CELLS_MAX: u32 = 4096;
/// A new volume's cell side, in world units: about one cell per metre.
pub const DEFAULT_SPACING: f32 = 1.0;
/// The smallest box side, in world units (a thinner box is dropped).
pub const VOLUME_EXTENT_MIN: f32 = 0.05;
/// The largest box side, in world units (a bigger box is dropped).
pub const VOLUME_EXTENT_MAX: f32 = 4096.0;
/// The largest irradiance multiplier a volume keeps.
pub const VOLUME_INTENSITY_MAX: f32 = 64.0;
/// The side of a cell's capture faces, in texels.
pub const CAPTURE_SIDE: u32 = 16;
/// Cells one Live frame bakes (the bake's time slice).
pub const CELLS_PER_FRAME: usize = 2;
/// Frames between two batches of a relight (dynamic GI, AAA review WP-12): a relight runs for as
/// long as a volume is held, so it pays a quarter of a slice's cost a frame; a first or stale bake
/// keeps the full slice.
pub const RELIGHT_CADENCE: u64 = 4;
/// Cells one batch of a settled capture's bake draws before its commands are submitted (the
/// capture targets and per-face rows hold this many cells).
pub const BATCH_CELLS: usize = 8;
/// Frames a volume takes to fade in once its first bake is published (Live; a settled capture
/// shows it whole).
pub const FADE_IN_FRAMES: u32 = 30;
/// How far a lookup is offset along the surface's normal, as a share of the volume's smallest cell
/// side (so a surface reads the cells in front of it, not the ones its own wall hides).
pub const NORMAL_BIAS_SPACING: f32 = 0.3;
/// How far past a cell's reach a point may lie and still take its light, as a share of the
/// volume's smallest cell side (`GX_VOLUME_REACH_TOLERANCE`).
pub const REACH_TOLERANCE: f32 = 0.15;
/// The least weight a cell the point is hidden from keeps (`GX_VOLUME_HIDDEN_WEIGHT`).
pub const HIDDEN_WEIGHT: f32 = 1.0e-4;
/// The farthest reach a cell records, in cell diagonals (farther surfaces never decide a lookup:
/// a shaded point is at most a diagonal from the cells it reads).
pub const REACH_DIAGONALS: f32 = 2.0;
/// The level of the sky's prefiltered cube the texels no geometry covers read (a little blurred:
/// a capture face's texel spans about 6 degrees).
pub const SKY_LEVEL: f32 = 2.0;
/// The atlas's and the staging block's format.
pub const ATLAS_FORMAT: TextureFormat = TextureFormat::Rgba16Float;
/// The forward frame group's name for the atlas.
pub const ENV_IRRADIANCE: &str = "env_irradiance";
/// The forward frame group's irradiance binding, as (binding, WGSL name): binding 32, a
/// filterable `texture_3d<f32>` (plan section 2 under D1: binding 18 is the PCSS point sampler
/// since P2-0.3 and binding 31 the LOD crossfade's reserved instance fade table).
pub const FRAME_IRRADIANCE_BINDINGS: [(u32, &str); 1] = [(32, ENV_IRRADIANCE)];
/// The compute pass that reduces a cell's faces into its ambient cube.
pub const IRRADIANCE_PASSES: &str = crate::shaders::minify::shipped_wgsl!(include_str!("../shaders/ibl/irradiance.wgsl"));
/// The reduce's entry point.
pub const REDUCE_ENTRY: &str = "cs_irradiance_reduce";
/// The ambient cube's directions, in texel order: +x, -x, +y, -y, +z, -z.
pub const AXIS_DIRECTIONS: usize = 6;
/// Bits per axis of a row's packed cell counts.
const CELL_BITS: u32 = 6;
/// The bit of a row's packed word that turns its leak control on.
const LEAK_BIT: u32 = 18;
/// Bytes of an `rgba16float` texel.
const TEXEL_BYTES: u64 = 8;
/// Bytes of a `depth32float` texel.
const DEPTH_BYTES: u64 = 4;
/// Cube faces.
const FACES: u32 = 6;

/// An irradiance volume: an axis-aligned box of the world whose diffuse environment light comes
/// from a grid of cells baked in the scene.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct IrradianceVolume {
    /// The box's least corner (world units).
    pub min: [f32; 3],
    /// The box's greatest corner.
    pub max: [f32; 3],
    /// Cells along x, y and z (each held to `1..=`[`CELLS_PER_AXIS_MAX`], at most [`CELLS_MAX`] in
    /// all); their centres split the box evenly.
    pub cells: [u32; 3],
    /// How far past the box's faces its light fades out, in world units (0: a hard edge; held to
    /// half the box's smallest side).
    pub blend: f32,
    /// The multiplier of its irradiance (1: as baked).
    pub intensity: f32,
    /// The room's albedo its bake assumes for the bounces after the first (AAA push P3,
    /// [`bounce_gain`]): `0..=`[`BOUNCE_MAX`], [`DEFAULT_BOUNCE`] by default; 0 bakes the first
    /// bounce alone (a ceiling the sun never reaches stays black).
    pub bounce: f32,
}

/// The room albedo a volume's bake assumes by default for the bounces after the first: about a
/// lived-in room's (plaster, concrete, tiles and furniture).
pub const DEFAULT_BOUNCE: f32 = 0.45;
/// The largest albedo a volume's bake assumes (the bounces' sum grows without bound towards 1).
pub const BOUNCE_MAX: f32 = 0.8;

/// The gain of the bounces after the first for a room of albedo `bounce`: each bounce is `bounce`
/// times the one before, so they sum to `bounce / (1 - bounce)` times the light the first bounce
/// leaves around a cell (the reduce's `grid_bake.sky.y`).
pub fn bounce_gain(bounce: f32) -> f32 {
    let bounce = bounce.clamp(0.0, BOUNCE_MAX);
    bounce / (1.0 - bounce)
}

impl IrradianceVolume {
    /// A volume over the box `min..max` with a cell about every [`DEFAULT_SPACING`] units, fading
    /// out over a tenth of its smallest side, at full intensity.
    pub fn new(min: [f32; 3], max: [f32; 3]) -> IrradianceVolume {
        let (a, b) = (Vec3::from(min), Vec3::from(max));
        let extent = (b - a).abs();
        let cells = extent.to_array().map(|side| cells_for(side / DEFAULT_SPACING));
        IrradianceVolume { min, max, cells, blend: 0.1 * extent.min_element(), intensity: 1.0, bounce: DEFAULT_BOUNCE }
    }

    /// The volume with `cells` cells along x, y and z.
    pub fn with_cells(self, cells: [u32; 3]) -> IrradianceVolume {
        IrradianceVolume { cells, ..self }
    }

    /// The volume fading out over `blend` units past its faces.
    pub fn with_blend(self, blend: f32) -> IrradianceVolume {
        IrradianceVolume { blend, ..self }
    }

    /// The volume's irradiance times `intensity`.
    pub fn with_intensity(self, intensity: f32) -> IrradianceVolume {
        IrradianceVolume { intensity, ..self }
    }

    /// The volume baked for a room of albedo `bounce` (0: the first bounce alone).
    pub fn with_bounce(self, bounce: f32) -> IrradianceVolume {
        IrradianceVolume { bounce, ..self }
    }

    /// The volume as the renderer keeps it, or None when it cannot be baked: a corner that is not
    /// finite, or a box side below [`VOLUME_EXTENT_MIN`] or above [`VOLUME_EXTENT_MAX`] (corners in
    /// either order are sorted). Cells are held to `1..=`[`CELLS_PER_AXIS_MAX`] per axis and cut
    /// along the longest axes to at most [`CELLS_MAX`]; the fade to `0..=` half the smallest side
    /// (0 when not finite); the multiplier to `0..=`[`VOLUME_INTENSITY_MAX`] (1 when not finite); the
    /// bounce albedo to `0..=`[`BOUNCE_MAX`] ([`DEFAULT_BOUNCE`] when not finite).
    pub fn held(&self) -> Option<IrradianceVolume> {
        let finite = |v: &[f32; 3]| v.iter().all(|c| c.is_finite());
        if !finite(&self.min) || !finite(&self.max) {
            return None;
        }
        let (a, b) = (Vec3::from(self.min), Vec3::from(self.max));
        let (min, max) = (a.min(b), a.max(b));
        let extent = max - min;
        if extent.min_element() < VOLUME_EXTENT_MIN || extent.max_element() > VOLUME_EXTENT_MAX {
            return None;
        }
        let mut cells = self.cells.map(|count| count.clamp(1, CELLS_PER_AXIS_MAX));
        while cells.iter().product::<u32>() > CELLS_MAX {
            let longest = (0..3).max_by_key(|axis| cells[*axis]).unwrap_or(0);
            cells[longest] -= 1;
        }
        let blend = if self.blend.is_finite() { self.blend.clamp(0.0, 0.5 * extent.min_element()) } else { 0.0 };
        let intensity = if self.intensity.is_finite() { self.intensity.clamp(0.0, VOLUME_INTENSITY_MAX) } else { 1.0 };
        let bounce = if self.bounce.is_finite() { self.bounce.clamp(0.0, BOUNCE_MAX) } else { DEFAULT_BOUNCE };
        Some(IrradianceVolume { min: min.to_array(), max: max.to_array(), cells, blend, intensity, bounce })
    }

    /// The sphere around its influence (the box grown by the fade): what the binning reads.
    pub fn sphere(&self) -> ClusterSphere {
        let (a, b) = (Vec3::from(self.min), Vec3::from(self.max));
        ClusterSphere { centre: ((a + b) * 0.5).to_array(), radius: 0.5 * (b - a).length() + self.blend * 3.0_f32.sqrt() }
    }

    /// What identifies the volume's bake across frames: its box, cells and bounce albedo, bit for
    /// bit (the fade and the multiplier change only its row).
    pub fn bake_key(&self) -> [u32; 10] {
        let mut key = [0; 10];
        for (slot, value) in key.iter_mut().zip(self.min.iter().chain(&self.max)) {
            *slot = value.to_bits();
        }
        key[6..9].copy_from_slice(&self.cells);
        key[9] = self.bounce.to_bits();
        key
    }

    /// The side of a cell along each axis.
    pub fn spacing(&self) -> Vec3 {
        (Vec3::from(self.max) - Vec3::from(self.min)) / Vec3::new(self.cells[0] as f32, self.cells[1] as f32, self.cells[2] as f32)
    }

    /// The centre of cell `cell`.
    pub fn cell_centre(&self, cell: [u32; 3]) -> Vec3 {
        Vec3::from(self.min) + (Vec3::new(cell[0] as f32, cell[1] as f32, cell[2] as f32) + 0.5) * self.spacing()
    }

    /// Cells in all.
    pub fn cell_count(&self) -> u32 {
        self.cells.iter().product()
    }

    /// Cell `index` in bake order (x fastest, then y, then z).
    pub fn cell_at(&self, index: u32) -> [u32; 3] {
        let [x, y, _] = self.cells;
        [index % x, (index / x) % y, index / (x * y)]
    }

    /// How far a lookup is offset along the surface's normal ([`NORMAL_BIAS_SPACING`] of the
    /// smallest cell side).
    pub fn normal_bias(&self) -> f32 {
        NORMAL_BIAS_SPACING * self.spacing().min_element()
    }

    /// The farthest reach a cell records ([`REACH_DIAGONALS`] cell diagonals).
    pub fn reach_max(&self) -> f32 {
        REACH_DIAGONALS * self.spacing().length()
    }

    /// The probe a cell's capture is drawn as (`probes::face_view_proj`, the sun's map of the box):
    /// the volume's box, captured from the cell's centre.
    pub fn capture_probe(&self, cell: [u32; 3]) -> ReflectionProbe {
        ReflectionProbe { min: self.min, max: self.max, capture: self.cell_centre(cell).to_array(), blend: 0.0, intensity: 1.0 }
    }

    /// The block's size in the atlas: `X x 2Y x 3Z` texels.
    pub fn block(&self) -> [u32; 3] {
        let [x, y, z] = self.cells;
        [x, 2 * y, 3 * z]
    }
}

/// Cells for a side of `units` cell sides (rounded up, held to `1..=`[`CELLS_PER_AXIS_MAX`]).
fn cells_for(units: f32) -> u32 {
    if !units.is_finite() || units <= 1.0 {
        return 1;
    }
    (libm::ceilf(units) as u32).min(CELLS_PER_AXIS_MAX)
}

/// `volumes` as the renderer keeps them, in declaration order: [`IrradianceVolume::held`] of
/// each, the dropped ones left out, at most [`MAX_VOLUMES`].
pub fn held_volumes(volumes: &[IrradianceVolume]) -> Vec<IrradianceVolume> {
    volumes.iter().filter_map(IrradianceVolume::held).take(MAX_VOLUMES).collect()
}

// --- Rows ---

/// The row of `volume` in the probes' table (`GxProbeRow`): its box and fade; its layer
/// `-(1 + origin)` for a block published at atlas x `origin`, or 0 (no weight) while it has none;
/// its cells and `leak_control` packed into one exact float, how far it has faded in
/// (`presence`, 0..1), its normal offset and its multiplier.
pub fn volume_row(volume: &IrradianceVolume, origin: Option<u32>, presence: f32, leak_control: bool) -> GpuProbeRow {
    let [x0, y0, z0] = volume.min;
    let [x1, y1, z1] = volume.max;
    let [cx, cy, cz] = volume.cells;
    let packed = cx | (cy << CELL_BITS) | (cz << (2 * CELL_BITS)) | (u32::from(leak_control) << LEAK_BIT);
    let presence = presence.clamp(0.0, 1.0);
    let layer = match origin {
        Some(origin) if presence > 0.0 => -(1.0 + origin as f32),
        _ => 0.0,
    };
    GpuProbeRow {
        min_blend: [x0, y0, z0, volume.blend],
        max_layer: [x1, y1, z1, layer],
        capture_intensity: [packed as f32, presence, volume.normal_bias(), volume.intensity],
    }
}

/// Whether `row` is an irradiance volume's with a published bake (its layer negative).
pub fn is_volume_row(row: &GpuProbeRow) -> bool {
    row.max_layer[3] < 0.0
}

/// The atlas x a published volume row's block starts at.
pub fn row_origin(row: &GpuProbeRow) -> Option<u32> {
    is_volume_row(row).then(|| (-row.max_layer[3] - 1.0) as u32)
}

/// A volume row's cells along x, y and z and its leak control.
pub fn row_cells(row: &GpuProbeRow) -> ([u32; 3], bool) {
    let packed = row.capture_intensity[0] as u32;
    let mask = (1 << CELL_BITS) - 1;
    ([packed & mask, (packed >> CELL_BITS) & mask, (packed >> (2 * CELL_BITS)) & mask], (packed >> LEAK_BIT) & 1 == 1)
}

// --- The ambient cube and its CPU twins of the shading ---

/// One cell's six texels as baked: per direction (+x, -x, +y, -y, +z, -z) rgb the irradiance over
/// pi, a both reaches of the direction's axis as [`pack_reaches`] codes them (the two texels of an
/// axis hold the same alpha, so the three a lookup reads give all six reaches).
pub type AmbientCube = [[f32; 4]; AXIS_DIRECTIONS];

/// Bits of a reach's code.
pub const REACH_BITS: u32 = 5;
/// The largest reach code (the reach clamp).
pub const REACH_CODE_MAX: u32 = (1 << REACH_BITS) - 1;

/// The code of a reach of `distance` for a volume whose reaches clamp at `reach_max`
/// (`grid_reach_code`): steps of `reach_max /` [`REACH_CODE_MAX`] (about 0.11 of a cell's
/// diagonal, within the leak test's [`REACH_TOLERANCE`]), rounded to the nearest step.
pub fn reach_code(distance: f32, reach_max: f32) -> u32 {
    (distance / reach_max * REACH_CODE_MAX as f32).round().clamp(0.0, REACH_CODE_MAX as f32) as u32
}

/// The reach code `code` stands for (`gx_volume_axis`).
pub fn reach_of(code: u32, reach_max: f32) -> f32 {
    code.min(REACH_CODE_MAX) as f32 * (reach_max / REACH_CODE_MAX as f32)
}

/// An axis's two reaches, `plus` and `minus`, as one exact float (a texel's alpha): the `plus`
/// code in the high [`REACH_BITS`] bits.
pub fn pack_reaches(plus: f32, minus: f32, reach_max: f32) -> f32 {
    ((reach_code(plus, reach_max) << REACH_BITS) | reach_code(minus, reach_max)) as f32
}

/// The six reaches `cube` holds (+x, -x, +y, -y, +z, -z), decoded.
pub fn ambient_reaches(cube: &AmbientCube, reach_max: f32) -> [f32; AXIS_DIRECTIONS] {
    std::array::from_fn(|face| {
        let packed = cube[face & !1][3] as u32;
        let code = if face & 1 == 0 { packed >> REACH_BITS } else { packed & REACH_CODE_MAX };
        reach_of(code, reach_max)
    })
}

/// `light` (rgb per direction) and `reaches` (per direction) as the cube the atlas holds.
pub fn ambient_cube(light: [[f32; 3]; AXIS_DIRECTIONS], reaches: [f32; AXIS_DIRECTIONS], reach_max: f32) -> AmbientCube {
    std::array::from_fn(|face| {
        let axis = face & !1;
        let [r, g, b] = light[face];
        [r, g, b, pack_reaches(reaches[axis], reaches[axis + 1], reach_max)]
    })
}

/// The atlas texel of direction `face` (0..6) of cell `cell` of a volume of `cells` whose block
/// starts at x `origin` (`gx_volume_texel`).
pub fn atlas_texel(origin: u32, cells: [u32; 3], cell: [u32; 3], face: usize) -> [u32; 3] {
    let negative = (face & 1) as u32;
    let axis = (face >> 1) as u32;
    [origin + cell[0], cell[1] + negative * cells[1], cell[2] + axis * cells[2]]
}

/// The texel index (0..6) of the face of an ambient cube toward axis `axis` (0..3) on the side of
/// `component`'s sign.
fn face_toward(axis: usize, component: f32) -> usize {
    2 * axis + usize::from(component < 0.0)
}

/// The irradiance (over pi) `cube` holds for unit normal `n` (`gx_volume_cell`'s rgb): its three
/// faces toward `n`, weighted by the normal's squared components.
pub fn ambient_irradiance(cube: &AmbientCube, n: [f32; 3]) -> [f32; 3] {
    let mut sum = [0.0; 3];
    for (axis, component) in n.iter().enumerate() {
        let texel = cube[face_toward(axis, *component)];
        for (out, value) in sum.iter_mut().zip(texel) {
            *out += value * component * component;
        }
    }
    sum
}

/// Whether a cell whose ambient cube is `cube` sees a point `offset` from its centre along axis
/// `axis` (`gx_volume_sees`): its reach on that side of the axis against the offset, 1 within it,
/// 0 past it by `tolerance` or more (a wall across the axis between them stops the reach short).
pub fn sees(cube: &AmbientCube, axis: usize, offset: f32, reach_max: f32, tolerance: f32) -> f32 {
    let reach = ambient_reaches(cube, reach_max)[2 * axis + usize::from(offset < 0.0)];
    ((reach + tolerance - offset.abs()) / tolerance).clamp(0.0, 1.0)
}

/// The trilinear position along `axis` of a point between the cells at `lower` and one past it
/// along the axis, at `t`, moved toward the side whose cell sees it (`gx_volume_visible_share`):
/// each side's share weighed by whether its cell sees the point (`offset` the point's distance
/// past `lower`'s centre, `spacing` the cell side along the axis), at least [`HIDDEN_WEIGHT`].
pub fn visible_share(cube_at: &dyn Fn([u32; 3]) -> AmbientCube, lower: [u32; 3], axis: usize, t: f32, offset: f32, (spacing, reach_max, tolerance): (f32, f32, f32)) -> f32 {
    let mut upper = lower;
    upper[axis] += 1;
    let low = (1.0 - t) * sees(&cube_at(lower), axis, offset, reach_max, tolerance).max(HIDDEN_WEIGHT);
    let high = t * sees(&cube_at(upper), axis, offset - spacing, reach_max, tolerance).max(HIDDEN_WEIGHT);
    high / (low + high).max(1.0e-12)
}

/// Where a lookup of `row` at `p` with normal `n` lands among its cells (`gx_volume_irradiance`):
/// the point offset along its normal and placed among the cell centres.
struct GridPoint {
    cells: [u32; 3],
    leak_control: bool,
    spacing: Vec3,
    /// The lower corner cell of the eight around the point.
    base: [u32; 3],
    /// The point's trilinear position past `base` (0..1 along each axis).
    t: [f32; 3],
    /// The cell nearest the point.
    near: [u32; 3],
    /// The point's distance past `base`'s centre along each axis.
    offset: Vec3,
    /// The reach decode's `reach_max` and the visibility's tolerance.
    scale: (f32, f32),
}

impl GridPoint {
    fn of(row: &GpuProbeRow, p: [f32; 3], n: [f32; 3]) -> GridPoint {
        let (cells, leak_control) = row_cells(row);
        let lo = Vec3::new(row.min_blend[0], row.min_blend[1], row.min_blend[2]);
        let hi = Vec3::new(row.max_layer[0], row.max_layer[1], row.max_layer[2]);
        let counts = Vec3::new(cells[0] as f32, cells[1] as f32, cells[2] as f32);
        let spacing = (hi - lo) / counts;
        let at = Vec3::from(p) + Vec3::from(n) * row.capture_intensity[2];
        let grid = ((at - lo) / spacing - 0.5).clamp(Vec3::ZERO, counts - 1.0);
        let base: [u32; 3] = std::array::from_fn(|axis| (grid[axis].floor() as u32).min(cells[axis].saturating_sub(2)));
        let t: [f32; 3] = std::array::from_fn(|axis| grid[axis] - base[axis] as f32);
        let near: [u32; 3] = std::array::from_fn(|axis| base[axis] + u32::from(t[axis] > 0.5));
        let offset = at - (lo + (Vec3::new(base[0] as f32, base[1] as f32, base[2] as f32) + 0.5) * spacing);
        let scale = (REACH_DIAGONALS * spacing.length(), REACH_TOLERANCE * spacing.min_element());
        GridPoint { cells, leak_control, spacing, base, t, near, offset, scale }
    }

    /// The cell `near` with `base`'s index along `axis`: the lower of the two around the point.
    fn lower(&self, axis: usize) -> [u32; 3] {
        let mut lower = self.near;
        lower[axis] = self.base[axis];
        lower
    }

    /// Whether the two cells around the point along `axis` see it (`gx_volume_axis_sees`): the
    /// lower one and the next (the same one when the volume has one cell along the axis).
    fn axis_sees(&self, cube_at: &dyn Fn([u32; 3]) -> AmbientCube, axis: usize) -> (f32, f32) {
        let lower = self.lower(axis);
        let lower_sees = sees(&cube_at(lower), axis, self.offset[axis], self.scale.0, self.scale.1);
        if self.cells[axis] < 2 {
            return (lower_sees, lower_sees);
        }
        let mut upper = lower;
        upper[axis] += 1;
        (lower_sees, sees(&cube_at(upper), axis, self.offset[axis] - self.spacing[axis], self.scale.0, self.scale.1))
    }
}

/// A volume's irradiance (over pi) at `p` for unit normal `n` (`gx_volume_irradiance`), its cells'
/// ambient cubes read through `cube_at`: the point offset along its normal, placed among the cell
/// centres, and with the row's leak control moved along each axis toward the side whose cell
/// (the one nearest it across the other axes) sees it ([`visible_share`]); then the trilinear blend
/// of the eight cells around it (what the sampler's filter returns for each face).
pub fn grid_irradiance(row: &GpuProbeRow, cube_at: &dyn Fn([u32; 3]) -> AmbientCube, p: [f32; 3], n: [f32; 3]) -> [f32; 3] {
    let point = GridPoint::of(row, p, n);
    let (cells, base) = (point.cells, point.base);
    let last = cells.map(|count| count.saturating_sub(1));
    let mut t = point.t;
    if point.leak_control {
        t = std::array::from_fn(|axis| {
            if cells[axis] < 2 {
                return t[axis];
            }
            visible_share(cube_at, point.lower(axis), axis, t[axis], point.offset[axis], (point.spacing[axis], point.scale.0, point.scale.1))
        });
    }
    let mut sum = [0.0_f32; 3];
    for corner in 0..8u32 {
        let offset = [corner & 1, (corner >> 1) & 1, (corner >> 2) & 1];
        let cell: [u32; 3] = std::array::from_fn(|axis| (base[axis] + offset[axis]).min(last[axis]));
        let weight: f32 = (0..3).map(|axis| if offset[axis] == 1 { t[axis] } else { 1.0 - t[axis] }).product();
        for (out, value) in sum.iter_mut().zip(ambient_irradiance(&cube_at(cell), n)) {
            *out += value * weight;
        }
    }
    sum
}

/// How far a volume's cells see `p` (`gx_volume_irradiance`'s alpha), which scales the volume's
/// weight there: with the row's leak control, along each axis the better of the two cells around
/// the point, the least over the axes; 1 without. A point past the wall every cell stops at (a
/// room's outside wall inside the volume's fade band) takes none of the volume (GA round 2: the
/// Lakeside cabin's sunless front wall read its dark room, 67 levels against 90 without the volume).
pub fn grid_seen(row: &GpuProbeRow, cube_at: &dyn Fn([u32; 3]) -> AmbientCube, p: [f32; 3], n: [f32; 3]) -> f32 {
    let point = GridPoint::of(row, p, n);
    if !point.leak_control {
        return 1.0;
    }
    (0..3).map(|axis| point.axis_sees(cube_at, axis)).map(|(lower, upper)| lower.max(upper)).fold(1.0, f32::min)
}

/// How the volumes at a point share its diffuse light (`gx_env_light`'s diffuse weights): each published
/// row's `probes::influence` times how far it has faded in (the shader also times how far its cells
/// see the point, [`grid_seen`]; any other row weighs nothing), divided
/// by their sum when it passes 1, and the sky's SH9 what is left of 1. Returns the volumes' weights
/// in row order and the sky's.
pub fn blend(rows: &[GpuProbeRow], p: [f32; 3]) -> (Vec<f32>, f32) {
    let mut weights: Vec<f32> = rows.iter().map(|row| if is_volume_row(row) { crate::probes::influence(row, p) * row.capture_intensity[1] } else { 0.0 }).collect();
    let total: f32 = weights.iter().sum();
    if total > 1.0 {
        for weight in &mut weights {
            *weight /= total;
        }
    }
    (weights, (1.0 - total).max(0.0))
}

/// The ambient cube of a cell from what it sees (`cs_irradiance_reduce`'s CPU twin): `sees(dir)`
/// answers the radiance along `dir` and the distance to the surface it comes from (None: no
/// surface, the reach clamp), integrated over the six faces of a `side`-texel cube, each
/// direction's irradiance normalized by its discrete cosine weight (a constant environment bakes
/// exactly its radiance), each reach the cos^4-weighted mean of the distance along its axis
/// (a wall across the axis at h gives h from every texel that sees it), clamped to `reach_max`,
/// packed by axis ([`ambient_cube`]). The later bounces add `gain` ([`bounce_gain`]) times the
/// mean radiance over the whole sphere to each direction, in proportion to the cosine weight of
/// the texels a surface covers in its hemisphere (0: the first bounce alone).
pub fn ambient_cube_of(sees: &dyn Fn([f32; 3]) -> ([f32; 3], Option<f32>), side: u32, reach_max: f32, gain: f32) -> AmbientCube {
    let mut light = [[0.0_f64; 4]; AXIS_DIRECTIONS];
    let mut reach = [[0.0_f64; 2]; AXIS_DIRECTIONS];
    let mut surface = [0.0_f64; AXIS_DIRECTIONS];
    let mut sphere = [0.0_f64; 4];
    for face in 0..FACES {
        for y in 0..side {
            for x in 0..side {
                let uv = ((x as f32 + 0.5) / side as f32, (y as f32 + 0.5) / side as f32);
                let dir = crate::ibl::cube_direction(face, uv.0, uv.1);
                let solid = crate::ibl::texel_solid_angle(side, x, y);
                let (radiance, distance) = sees(dir);
                let (distance, reach_max) = (distance.map(f64::from), f64::from(reach_max));
                for (out, value) in sphere.iter_mut().zip(radiance) {
                    *out += f64::from(value) * solid;
                }
                sphere[3] += solid;
                for (a, (sum, focus)) in light.iter_mut().zip(reach.iter_mut()).enumerate() {
                    let axis = a / 2;
                    let sign = if a & 1 == 1 { -1.0 } else { 1.0 };
                    let c = f64::from(dir[axis] * sign);
                    if c > 0.0 {
                        let w = c * solid;
                        for (out, value) in sum.iter_mut().zip(radiance) {
                            *out += f64::from(value) * w;
                        }
                        sum[3] += w;
                        if distance.is_some() {
                            surface[a] += w;
                        }
                        let f = c * c * c * c * solid;
                        // A texel no surface covers reaches the clamp along every axis.
                        focus[0] += distance.map_or(reach_max, |d| (d * c).min(reach_max)) * f;
                        focus[1] += f;
                    }
                }
            }
        }
    }
    let whole = sphere[3].max(1.0e-12);
    let mean = [sphere[0] / whole, sphere[1] / whole, sphere[2] / whole];
    let rgb = std::array::from_fn(|a| {
        let [r, g, b, w] = light[a];
        let w = w.max(1.0e-12);
        let later = f64::from(gain) * surface[a] / w;
        [(r / w + later * mean[0]) as f32, (g / w + later * mean[1]) as f32, (b / w + later * mean[2]) as f32]
    });
    let reaches = std::array::from_fn(|a| if reach[a][1] > 0.0 { (reach[a][0] / reach[a][1]) as f32 } else { reach_max });
    ambient_cube(rgb, reaches, reach_max)
}

// --- The atlas ---

/// Where each held volume's block sits in the atlas: side by side along x in declaration order.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AtlasLayout {
    /// Each volume's block's x in the atlas.
    pub origins: Vec<u32>,
    /// The atlas's size: the blocks' widths summed, their tallest height and deepest depth.
    pub extent: [u32; 3],
    /// The staging block's size: the widest, tallest and deepest block.
    pub staging: [u32; 3],
}

impl AtlasLayout {
    /// The layout of `volumes` (held).
    pub fn of(volumes: &[IrradianceVolume]) -> AtlasLayout {
        let mut origins = Vec::with_capacity(volumes.len());
        let mut extent = [0, 1, 1];
        let mut staging = [1, 1, 1];
        for volume in volumes {
            let block = volume.block();
            origins.push(extent[0]);
            extent[0] += block[0];
            extent[1] = extent[1].max(block[1]);
            extent[2] = extent[2].max(block[2]);
            for (held, side) in staging.iter_mut().zip(block) {
                *held = (*held).max(side);
            }
        }
        extent[0] = extent[0].max(1);
        AtlasLayout { origins, extent, staging }
    }

    /// Bytes of the atlas and the staging block.
    pub fn bytes(&self) -> u64 {
        let texels = |size: [u32; 3]| size.iter().map(|side| u64::from(*side)).product::<u64>();
        (texels(self.extent) + texels(self.staging)) * TEXEL_BYTES
    }
}

/// Bytes the bake's capture targets hold: [`BATCH_CELLS`] cells' six faces of colour and depth,
/// and the sun's shadow map of the box.
pub fn capture_bytes() -> u64 {
    let faces = u64::from(FACES) * BATCH_CELLS as u64 * u64::from(CAPTURE_SIDE) * u64::from(CAPTURE_SIDE);
    let shadow = u64::from(crate::probes::CAPTURE_SHADOW_PX).pow(2) * DEPTH_BYTES;
    faces * (TEXEL_BYTES + DEPTH_BYTES) + shadow
}

/// Bytes the volumes hold for `volumes` (held; 0 without any): the atlas, the staging block and
/// the capture targets.
pub fn volume_bytes(volumes: &[IrradianceVolume]) -> u64 {
    if volumes.is_empty() {
        return 0;
    }
    AtlasLayout::of(volumes).bytes() + capture_bytes()
}

/// Texels one cell's bake writes or reads (the bake's work model): its six faces drawn, then read
/// by the reduce.
pub fn cell_work() -> u64 {
    2 * u64::from(FACES) * u64::from(CAPTURE_SIDE) * u64::from(CAPTURE_SIDE)
}

// --- Rooms the renderer adds (AAA review WP-12) ---

/// The rooms the renderer lights without the game declaring them, so an agent never fakes bounce
/// with spot lights or leaves a room on the sky's light: `paired` gives each declared reflection
/// probe that no declared volume covers a volume over its box, and each declared volume that no
/// probe covers a probe over its; `camera` adds a volume around the camera
/// ([`CAMERA_VOLUME_EXTENT`], snapped to [`CAMERA_VOLUME_SNAP`]) wherever no room (declared or
/// paired) holds it. The added ones come after the declared ones, so a quality's cap keeps the
/// game's own first.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct AutoRooms {
    /// Pair declared probes and volumes.
    pub paired: bool,
    /// Add the camera's own volume where no room holds it.
    pub camera: bool,
}

impl AutoRooms {
    /// None added (low, and every quality before AAA review WP-12).
    pub const OFF: AutoRooms = AutoRooms { paired: false, camera: false };
    /// Declared rooms paired (desktop `medium`, phones).
    pub const PAIRED: AutoRooms = AutoRooms { paired: true, camera: false };
    /// Paired, and the camera's own volume (desktop `high` and `ultra`).
    pub const ALL: AutoRooms = AutoRooms { paired: true, camera: true };
}

/// The camera volume's box size, world units: a floor and the rooms or street around it.
pub const CAMERA_VOLUME_EXTENT: [f32; 3] = [24.0, 8.0, 24.0];
/// Its cells (two metres apart): 576, a few seconds of Live bake at the high slice.
pub const CAMERA_VOLUME_CELLS: [u32; 3] = [12, 4, 12];
/// Its centre snaps to this grid across x and z (the camera is always at least this far inside its
/// sides), and its floor to [`CAMERA_VOLUME_FLOOR_SNAP`] below the eye: the same camera gives the
/// same box in every frame and capture, and walking moves it a few times a minute.
pub const CAMERA_VOLUME_SNAP: f32 = 8.0;
/// How far below the eye the camera volume's floor sits, at least.
pub const CAMERA_VOLUME_BELOW: f32 = 2.0;
/// The grid its floor snaps to, world units.
pub const CAMERA_VOLUME_FLOOR_SNAP: f32 = 2.0;
/// How far past its faces the camera volume fades into the sky's light.
pub const CAMERA_VOLUME_BLEND: f32 = 4.0;
/// A declared probe and volume are one room when their boxes share at least this much of the
/// smaller one.
pub const PAIRED_OVERLAP_SHARE: f32 = 0.5;
/// Eye height a paired probe captures from, above its box's floor (held inside the box).
pub const PAIRED_PROBE_EYE: f32 = 1.6;

/// The box of the camera volume around `eye`.
pub fn camera_volume(eye: [f32; 3]) -> IrradianceVolume {
    let snap = |value: f32, grid: f32| libm::floorf(value / grid + 0.5) * grid;
    let centre = [snap(eye[0], CAMERA_VOLUME_SNAP), 0.0, snap(eye[2], CAMERA_VOLUME_SNAP)];
    let floor = libm::floorf((eye[1] - CAMERA_VOLUME_BELOW) / CAMERA_VOLUME_FLOOR_SNAP) * CAMERA_VOLUME_FLOOR_SNAP;
    let half = [CAMERA_VOLUME_EXTENT[0] * 0.5, 0.0, CAMERA_VOLUME_EXTENT[2] * 0.5];
    let min = [centre[0] - half[0], floor, centre[2] - half[2]];
    let max = [centre[0] + half[0], floor + CAMERA_VOLUME_EXTENT[1], centre[2] + half[2]];
    IrradianceVolume::new(min, max).with_cells(CAMERA_VOLUME_CELLS).with_blend(CAMERA_VOLUME_BLEND)
}

/// The share of the smaller of two boxes the two share (0 when apart).
fn overlap_share(a: ([f32; 3], [f32; 3]), b: ([f32; 3], [f32; 3])) -> f32 {
    let size = |(min, max): ([f32; 3], [f32; 3])| (0..3).map(|axis| (max[axis] - min[axis]).max(0.0)).product::<f32>();
    let shared = (0..3).map(|axis| (a.1[axis].min(b.1[axis]) - a.0[axis].max(b.0[axis])).max(0.0)).product::<f32>();
    let smaller = size(a).min(size(b));
    if smaller > 0.0 { shared / smaller } else { 0.0 }
}

fn contains(volume: &IrradianceVolume, eye: [f32; 3]) -> bool {
    (0..3).all(|axis| eye[axis] >= volume.min[axis] && eye[axis] <= volume.max[axis])
}

/// The volumes and probes a frame lights with under `rooms`: the declared ones (held) and, after
/// them, the ones [`AutoRooms`] adds for the camera at `eye`.
pub fn auto_rooms(volumes: &[IrradianceVolume], probes: &[ReflectionProbe], eye: [f32; 3], rooms: AutoRooms) -> (Vec<IrradianceVolume>, Vec<ReflectionProbe>) {
    let mut held_v = held_volumes(volumes);
    let mut held_p = crate::probes::held_probes(probes);
    if rooms.paired {
        let declared_v = held_v.clone();
        let declared_p = held_p.clone();
        let paired = |a: ([f32; 3], [f32; 3]), b: ([f32; 3], [f32; 3])| overlap_share(a, b) >= PAIRED_OVERLAP_SHARE;
        for probe in declared_p.iter().filter(|probe| !declared_v.iter().any(|volume| paired((probe.min, probe.max), (volume.min, volume.max)))) {
            held_v.extend(IrradianceVolume::new(probe.min, probe.max).with_blend(probe.blend).held());
        }
        for volume in declared_v.iter().filter(|volume| !declared_p.iter().any(|probe| paired((probe.min, probe.max), (volume.min, volume.max)))) {
            let eye_height = (volume.min[1] + PAIRED_PROBE_EYE).min(volume.max[1]);
            let capture = [(volume.min[0] + volume.max[0]) * 0.5, eye_height, (volume.min[2] + volume.max[2]) * 0.5];
            held_p.extend(ReflectionProbe::new(volume.min, volume.max).with_capture(capture).with_blend(volume.blend).held());
        }
    }
    if rooms.camera && !held_v.iter().any(|volume| contains(volume, eye)) {
        held_v.extend(camera_volume(eye).held());
    }
    (held_v, held_p)
}

/// `lighting` with the rooms `quality` adds for the camera at `eye`; borrowed as it is when it adds
/// none (no environment light, no volumes baked, or nothing to add).
pub fn with_auto_rooms<'a>(lighting: &'a crate::lights::Lighting, quality: &EnvironmentQuality, eye: [f32; 3]) -> std::borrow::Cow<'a, crate::lights::Lighting> {
    let rooms = quality.auto_rooms;
    let off = rooms == AutoRooms::OFF || !quality.ibl || quality.irradiance_volumes == 0;
    if off {
        return std::borrow::Cow::Borrowed(lighting);
    }
    let (volumes, probes) = auto_rooms(&lighting.irradiance_volumes, &lighting.reflection_probes, eye, rooms);
    let unchanged = volumes.len() == lighting.irradiance_volumes.len() && probes.len() == lighting.reflection_probes.len();
    if unchanged {
        return std::borrow::Cow::Borrowed(lighting);
    }
    let mut owned = lighting.clone();
    owned.irradiance_volumes = volumes;
    owned.reflection_probes = probes;
    std::borrow::Cow::Owned(owned)
}

// --- The bake schedule ---

/// One held volume's bake state.
#[derive(Clone, Debug, PartialEq)]
struct VolumeSlot {
    volume: IrradianceVolume,
    /// The box and cells its published bake was drawn for: a volume that moves keeps showing its
    /// last bake where it was baked until the bake at its new place is published.
    baked: IrradianceVolume,
    /// Whether the bake in progress is a relight of a current bake (dynamic GI), not a first bake
    /// or a stale one's.
    relighting: bool,
    /// Whether its atlas block holds a published bake (the row weighs it).
    published: bool,
    /// Whether the published bake no longer matches what a bake would draw now.
    stale: bool,
    /// The next cell the bake in progress draws.
    next: u32,
    /// Frames since the first publish (the fade-in), at most [`FADE_IN_FRAMES`].
    shown: u32,
}

/// Cells of one held volume baked together, and whether their reduce completes the volume's bake
/// (its staging block is then published into its atlas block).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GridBatch {
    /// The held volume (declaration order).
    pub slot: usize,
    /// The cells, in bake order (at most [`BATCH_CELLS`]).
    pub cells: Vec<[u32; 3]>,
    /// Whether the batch's reduce is followed by the publish.
    pub publish: bool,
}

/// What the bake does on one frame, in encode order.
pub type GridWork = Vec<GridBatch>;

/// What one frame asks of the bake schedule.
#[derive(Clone, Copy, Debug)]
pub struct GridFrame<'a> {
    /// The volumes the frame bakes (held, at most the quality's count), in declaration order.
    pub volumes: &'a [IrradianceVolume],
    /// What lights the bake (the sky bake's generation): a change makes every bake stale.
    pub lit_by: u64,
    /// The frame index (the rebake cadence's key).
    pub frame_index: u64,
    /// A refresh runs every this many frames (0 and 1: every frame).
    pub cadence: u8,
    /// A settled capture's frame: bake whole whatever differs.
    pub settle: bool,
    /// Cells a Live frame bakes (`EnvironmentQuality::irradiance_cells_per_frame`, at most
    /// [`BATCH_CELLS`]).
    pub cells_per_frame: usize,
    /// Whether current bakes are baked again, one volume after another
    /// (`EnvironmentQuality::irradiance_relight`).
    pub relight: bool,
}

/// The volumes' bake schedule: which volumes are published, which are stale, the bake in progress
/// and the fade-in. Pure state, no GPU ([`IrradianceMaps`] encodes what it says).
#[derive(Clone, Debug, Default)]
pub struct GridSchedule {
    slots: Vec<VolumeSlot>,
    keys: Vec<[u32; 10]>,
    lit_by: u64,
    /// The volume whose bake is in progress (its staging block holds its cells so far).
    job: Option<usize>,
    /// The volume the next relight bakes (round robin).
    relight_next: usize,
}

impl GridSchedule {
    /// Whether every held volume has a published, current bake.
    pub fn settled(&self) -> bool {
        let relight_only = self.job.is_none_or(|job| self.slots.get(job).is_some_and(|slot| slot.relighting));
        relight_only && self.slots.iter().all(|slot| slot.published && !slot.stale)
    }

    /// Whether volume `slot` has a published bake.
    pub fn published(&self, slot: usize) -> bool {
        self.slots.get(slot).is_some_and(|slot| slot.published)
    }

    /// How far volume `slot` has faded in (0..1; 0 before its first publish, a step of
    /// [`FADE_IN_FRAMES`] on the frame it is published).
    pub fn presence(&self, slot: usize) -> f32 {
        self.slots.get(slot).filter(|slot| slot.published).map_or(0.0, |slot| (slot.shown + 1).min(FADE_IN_FRAMES) as f32 / FADE_IN_FRAMES as f32)
    }

    /// Advance to `frame`: a volume added or removed starts every slot over; a volume whose box or
    /// cells changed is baked again at its new place while its last bake stays shown where it was
    /// baked; a new light makes every bake stale (a bake in progress starts again). Returns the
    /// batches due this frame in encode order.
    pub fn advance(&mut self, frame: &GridFrame<'_>) -> GridWork {
        let keys: Vec<[u32; 10]> = frame.volumes.iter().map(IrradianceVolume::bake_key).collect();
        if keys.len() != self.keys.len() {
            self.slots = frame
                .volumes
                .iter()
                .map(|volume| VolumeSlot { volume: *volume, baked: *volume, relighting: false, published: false, stale: true, next: 0, shown: 0 })
                .collect();
            self.job = None;
        } else if keys != self.keys {
            for (index, slot) in self.slots.iter_mut().enumerate().filter(|(index, _)| keys[*index] != self.keys[*index]) {
                *slot = VolumeSlot { stale: true, next: 0, relighting: false, ..slot.clone() };
                if self.job == Some(index) {
                    self.job = None;
                }
            }
        }
        self.keys = keys;
        for (slot, volume) in self.slots.iter_mut().zip(frame.volumes) {
            // Same bake; its fade and multiplier may change freely.
            slot.volume = *volume;
        }
        if self.lit_by != frame.lit_by {
            self.lit_by = frame.lit_by;
            for slot in &mut self.slots {
                slot.stale = true;
                slot.next = 0;
            }
        }
        for slot in self.slots.iter_mut().filter(|slot| slot.published) {
            slot.shown = (slot.shown + 1).min(FADE_IN_FRAMES);
        }
        if frame.settle {
            return self.bake_whole();
        }
        self.bake_slice(frame)
    }

    /// A settled capture's bake: every volume that differs, whole, in batches of [`BATCH_CELLS`];
    /// each shown whole at once.
    fn bake_whole(&mut self) -> GridWork {
        self.job = None;
        let mut work = GridWork::new();
        for (index, slot) in self.slots.iter_mut().enumerate() {
            if slot.published && !slot.stale {
                slot.shown = FADE_IN_FRAMES;
                continue;
            }
            let cells: Vec<[u32; 3]> = (0..slot.volume.cell_count()).map(|cell| slot.volume.cell_at(cell)).collect();
            let batches = cells.len().div_ceil(BATCH_CELLS);
            work.extend(cells.chunks(BATCH_CELLS).enumerate().map(|(batch, chunk)| GridBatch { slot: index, cells: chunk.to_vec(), publish: batch + 1 == batches }));
            *slot = VolumeSlot { baked: slot.volume, relighting: false, published: true, stale: false, next: 0, shown: FADE_IN_FRAMES, ..*slot };
        }
        work
    }

    /// A Live frame's slice: the frame's `cells_per_frame` cells of the bake in progress, or of
    /// the first volume never published (every frame), or of the first stale one (on the
    /// cadence), or with relight on of the next current one (round robin, on the cadence).
    fn bake_slice(&mut self, frame: &GridFrame<'_>) -> GridWork {
        if self.job.is_none() {
            self.job = self.slots.iter().position(|slot| !slot.published).or_else(|| self.slots.iter().position(|slot| slot.stale));
        }
        if self.job.is_none() && frame.relight && !self.slots.is_empty() {
            let index = self.relight_next % self.slots.len();
            self.relight_next = index + 1;
            self.slots[index].relighting = true;
            self.slots[index].next = 0;
            self.job = Some(index);
        }
        let Some(index) = self.job else { return GridWork::new() };
        let slot = &mut self.slots[index];
        if slot.published && !crate::sky::lut_due(frame.frame_index, frame.cadence) {
            return GridWork::new();
        }
        if slot.relighting && frame.frame_index % RELIGHT_CADENCE != 0 {
            return GridWork::new();
        }
        let count = slot.volume.cell_count();
        let slice = frame.cells_per_frame.clamp(1, BATCH_CELLS) as u32;
        let end = (slot.next + slice).min(count);
        let cells: Vec<[u32; 3]> = (slot.next..end).map(|cell| slot.volume.cell_at(cell)).collect();
        let publish = end == count;
        slot.next = end;
        if publish {
            if !slot.published {
                slot.shown = 0;
            }
            slot.published = true;
            slot.stale = false;
            slot.relighting = false;
            slot.baked = slot.volume;
            slot.next = 0;
            self.job = None;
        }
        vec![GridBatch { slot: index, cells, publish }]
    }

    /// The volume slot `slot` holds.
    pub fn volume(&self, slot: usize) -> Option<&IrradianceVolume> {
        self.slots.get(slot).map(|slot| &slot.volume)
    }

    /// The rows of the held volumes (declaration order) for `layout`'s blocks, with
    /// `leak_control`: each published one reading its block and faded in as far as it is,
    /// inactive while it has no published bake.
    pub fn rows(&self, layout: &AtlasLayout, leak_control: bool) -> Vec<GpuProbeRow> {
        self.slots
            .iter()
            .enumerate()
            .map(|(index, slot)| {
                let origin = layout.origins.get(index).copied().filter(|_| slot.published);
                // The published bake where it was baked; its fade and multiplier as declared now.
                let shown = IrradianceVolume { min: slot.baked.min, max: slot.baked.max, cells: slot.baked.cells, ..slot.volume };
                volume_row(&shown, origin, self.presence(index), leak_control)
            })
            .collect()
    }
}

// --- The forward pass's binding ---

/// The forward frame layout's entry of the atlas `name` at `binding` (fragment stage): a
/// filterable `texture_3d<f32>`; None for another name.
pub fn frame_env_entry(binding: u32, name: &str) -> Option<BindGroupLayoutEntry> {
    (name == ENV_IRRADIANCE).then_some(BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: TextureViewDimension::D3, multisampled: false },
        count: None,
    })
}

// --- GPU state ---

/// The reduce's uniform (`GxGridBake` in `shaders/ibl/irradiance.wgsl`).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuGridBake {
    /// Each batch cell: xyz its coordinates, w its first capture layer.
    pub cells: [[u32; 4]; BATCH_CELLS],
    /// x: cells in the batch; y, z: the volume's cells along y and z; w: the capture's side.
    pub shape: [u32; 4],
    /// x: the depth a face is cleared to; y, z: the face projection's depth terms; w: the reach
    /// clamp.
    pub depth: [f32; 4],
    /// x: the sky cube's level; y, z, w: reserved.
    pub sky: [f32; 4],
}

/// What [`IrradianceMaps::prepare`] reads of a frame.
#[derive(Clone, Copy, Debug)]
pub struct GridPrep<'a> {
    /// The volumes the scene declares (held here, [`held_volumes`]).
    pub declared: &'a [IrradianceVolume],
    /// The quality's environment knobs.
    pub quality: &'a EnvironmentQuality,
    /// What lights the bake (the sky's bake generation), or None while nothing is baked or the
    /// environment does not light the scene (the volumes are released).
    pub lit_by: Option<u64>,
    /// The frame index.
    pub frame_index: u64,
    /// A settled capture's frame.
    pub settle: bool,
}

/// One face a cell's bake draws: where in the capture targets, and the probe it is drawn as.
#[derive(Clone, Debug)]
pub struct CellFace {
    /// The volume's box, captured from the cell's centre.
    pub probe: ReflectionProbe,
    /// The face (0..6).
    pub face: u32,
    /// The colour attachment (one capture layer).
    pub color: TextureView,
    /// The depth attachment (one capture layer).
    pub depth: TextureView,
    /// The sun's shadow map of the volume's box: its attachment...
    pub shadow: TextureView,
    /// ... and the same map as a one-layer array.
    pub shadow_array: TextureView,
}

/// The irradiance volumes' GPU state and schedule, held by the environment
/// (`ibl::EnvironmentMaps::irradiance`): the atlas the forward pass binds, the bake's targets and
/// the rows the probes' table carries for them.
pub struct IrradianceMaps {
    schedule: GridSchedule,
    /// The held volumes (at most the quality's count), declaration order.
    volumes: Vec<IrradianceVolume>,
    layout: AtlasLayout,
    rows: Vec<GpuProbeRow>,
    /// A 1-texel black volume: what binds while no volume is held.
    neutral: TextureView,
    gpu: Option<GridGpu>,
    /// Bumped whenever the bound atlas is replaced: the frame group is rebuilt.
    generation: u64,
    work: GridWork,
    /// What the renderer's capture draws keep between frames.
    store: CaptureStore,
    /// The volume (slot) and sun (bits) the bake's shadow map holds the casters of, for the Live
    /// frames that bake a slice after it was drawn (None: draw it with the next batch).
    shadow_held: Option<(usize, [u32; 3])>,
}

/// The atlas, the staging block and the bake's targets at one layout.
struct GridGpu {
    atlas: Texture,
    atlas_view: TextureView,
    staging: Texture,
    staging_view: TextureView,
    color_layers: Vec<TextureView>,
    color_view: TextureView,
    depth_layers: Vec<TextureView>,
    depth_view: TextureView,
    shadow_attachment: TextureView,
    shadow_array: TextureView,
    reduce: Compiled<ComputePipeline>,
    reduce_layout: BindGroupLayout,
    uniforms: Buffer,
    sky_sampler: Sampler,
    /// The reduce's group over the sky cube it was made for (its bake generation).
    group: Option<(u64, BindGroup)>,
}

impl IrradianceMaps {
    /// No volumes: a black neutral atlas, no rows.
    pub fn new(device: &Device, queue: &Queue) -> IrradianceMaps {
        let neutral = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("env irradiance neutral"),
            size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D3,
            format: ATLAS_FORMAT,
            usage: TextureUsages::TEXTURE_BINDING | TextureUsages::COPY_DST,
            view_formats: &[],
        });
        // Zero-initialized by WebGPU: black. Written once so every backend agrees.
        queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture: &neutral, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            &[0u8; 8],
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(8), rows_per_image: Some(1) },
            neutral.size(),
        );
        let neutral = neutral.create_view(&wgpu::TextureViewDescriptor::default());
        IrradianceMaps {
            schedule: GridSchedule::default(),
            volumes: Vec::new(),
            layout: AtlasLayout::default(),
            rows: Vec::new(),
            neutral,
            gpu: None,
            generation: 0,
            work: GridWork::new(),
            store: CaptureStore::default(),
            shadow_held: None,
        }
    }

    /// Whether the bake's shadow map already holds volume `slot`'s casters for the sun toward
    /// `sun` (a Live slice reuses the map an earlier slice drew; a settled capture draws it again).
    pub fn shadow_held(&self, slot: usize, sun: [f32; 3]) -> bool {
        self.shadow_held == Some((slot, sun.map(f32::to_bits)))
    }

    /// The bake's shadow map now holds volume `slot`'s casters for the sun toward `sun`.
    pub fn hold_shadow(&mut self, slot: usize, sun: [f32; 3]) {
        self.shadow_held = Some((slot, sun.map(f32::to_bits)));
    }

    /// What the renderer's capture draws keep between frames.
    pub fn store(&mut self) -> &mut CaptureStore {
        &mut self.store
    }

    /// Which resources the volumes bind: a new value means rebuild the frame group.
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// The forward pass's binding 32: the atlas once volumes are held, else the neutral volume.
    pub fn view(&self) -> &TextureView {
        self.gpu.as_ref().map_or(&self.neutral, |gpu| &gpu.atlas_view)
    }

    /// The atlas, once volumes are held.
    pub fn atlas(&self) -> Option<&Texture> {
        self.gpu.as_ref().map(|gpu| &gpu.atlas)
    }

    /// The held volumes' rows (declaration order): what the probes' table carries after the
    /// reflection probes' rows.
    pub fn rows(&self) -> &[GpuProbeRow] {
        &self.rows
    }

    /// The atlas layout of the held volumes.
    pub fn layout(&self) -> &AtlasLayout {
        &self.layout
    }

    /// The schedule.
    pub fn schedule(&self) -> &GridSchedule {
        &self.schedule
    }

    /// The bake work the last [`IrradianceMaps::prepare`] scheduled.
    pub fn last_work(&self) -> &GridWork {
        &self.work
    }

    /// The bytes the volumes hold on the GPU now (the ledger's `irradiance-volumes`).
    pub fn bytes(&self) -> u64 {
        if self.gpu.is_none() {
            return self.store.bytes();
        }
        self.layout.bytes() + capture_bytes() + self.store.bytes()
    }

    /// Release every volume resource but the neutral atlas (no volumes, nothing baked, IBL off).
    pub fn release(&mut self) {
        if self.gpu.take().is_some() {
            self.generation += 1;
        }
        self.store = CaptureStore::default();
        self.schedule = GridSchedule::default();
        self.volumes.clear();
        self.layout = AtlasLayout::default();
        self.rows.clear();
        self.work.clear();
        self.shadow_held = None;
    }

    /// Graph node 11's volume part, before the bake is drawn: hold `prep`'s volumes, make the atlas
    /// and the bake's targets for their layout (or release them: no volumes, nothing lights the
    /// bake), advance the schedule and make the rows. Returns the batches due this frame, in order
    /// (the renderer draws each cell's faces through [`IrradianceMaps::cell_face`], then encodes
    /// the batch's reduce and publish with [`IrradianceMaps::encode_batch`]).
    pub fn prepare(&mut self, device: &Device, prep: &GridPrep<'_>) -> Result<GridWork, RenderError> {
        self.work.clear();
        let cap = usize::from(prep.quality.irradiance_volumes).min(MAX_VOLUMES);
        let volumes: Vec<IrradianceVolume> = held_volumes(prep.declared).into_iter().take(cap).collect();
        let Some(lit_by) = prep.lit_by.filter(|_| !volumes.is_empty() && prep.quality.ibl) else {
            self.release();
            return Ok(GridWork::new());
        };
        let layout = AtlasLayout::of(&volumes);
        if self.gpu.is_none() || layout != self.layout {
            self.gpu = Some(GridGpu::new(device, &layout)?);
            self.layout = layout;
            self.schedule = GridSchedule::default();
            self.shadow_held = None;
            self.generation += 1;
        }
        self.volumes = volumes;
        let frame = GridFrame {
            volumes: &self.volumes,
            lit_by,
            frame_index: prep.frame_index,
            cadence: prep.quality.rebake_cadence,
            settle: prep.settle,
            cells_per_frame: usize::from(prep.quality.irradiance_cells_per_frame),
            relight: prep.quality.irradiance_relight,
        };
        self.work = self.schedule.advance(&frame);
        self.rows = self.schedule.rows(&self.layout, prep.quality.irradiance_leak_control);
        Ok(self.work.clone())
    }

    /// Face `face` of the cell at `index` of a batch of volume `slot` (None without the volume or
    /// the targets).
    pub fn cell_face(&self, slot: usize, index: usize, cell: [u32; 3], face: u32) -> Option<CellFace> {
        let (Some(gpu), Some(volume)) = (&self.gpu, self.schedule.volume(slot)) else { return None };
        let layer = index * FACES as usize + face as usize;
        Some(CellFace {
            probe: volume.capture_probe(cell),
            face,
            color: gpu.color_layers.get(layer)?.clone(),
            depth: gpu.depth_layers.get(layer)?.clone(),
            shadow: gpu.shadow_attachment.clone(),
            shadow_array: gpu.shadow_array.clone(),
        })
    }

    /// Encode batch `batch`'s reduce over its drawn faces (`sky` the sky's prefiltered cube view and
    /// its bake generation; `depth_reversed` the capture's depth), then its publish when it
    /// completes the volume. The compute passes it opened.
    pub fn encode_batch(&mut self, device: &Device, queue: &Queue, encoder: &mut wgpu::CommandEncoder, batch: &GridBatch, sky: (&TextureView, u64), depth_reversed: bool) -> u32 {
        let (Some(volume), Some(origin)) = (self.schedule.volume(batch.slot).copied(), self.layout.origins.get(batch.slot).copied()) else { return 0 };
        let Some(gpu) = self.gpu.as_mut() else { return 0 };
        gpu.write_bake(queue, &volume, batch, depth_reversed);
        gpu.encode_reduce(device, encoder, batch.cells.len() as u32, sky);
        if batch.publish {
            gpu.publish(encoder, &volume, origin);
        }
        1
    }
}

/// The face projection's depth terms (`GxGridBake::depth.yz`): with `z_scale` and `z_offset` the
/// projection's third column's z and fourth column's z, a face's view distance along its axis is
/// `z_offset / (depth + z_scale)`.
pub fn capture_depth_terms(probe: &ReflectionProbe, reversed: bool) -> (f32, f32) {
    let far = crate::probes::capture_far(probe);
    let near = crate::probes::CAPTURE_NEAR;
    let projection: Mat4 = if reversed {
        glam::camera::rh::proj::directx::perspective(core::f32::consts::FRAC_PI_2, 1.0, far, near)
    } else {
        glam::camera::rh::proj::directx::perspective(core::f32::consts::FRAC_PI_2, 1.0, near, far)
    };
    (projection.z_axis.z, projection.w_axis.z)
}

/// `texture`'s layer `layer` as a 2D attachment view.
fn layer_view(texture: &Texture, layer: u32) -> TextureView {
    texture.create_view(&wgpu::TextureViewDescriptor {
        dimension: Some(TextureViewDimension::D2),
        base_mip_level: 0,
        mip_level_count: Some(1),
        base_array_layer: layer,
        array_layer_count: Some(1),
        ..Default::default()
    })
}

fn texture_3d(device: &Device, label: &str, size: [u32; 3], usage: TextureUsages) -> Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d { width: size[0], height: size[1], depth_or_array_layers: size[2] },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D3,
        format: ATLAS_FORMAT,
        usage,
        view_formats: &[],
    })
}

fn layers_2d(device: &Device, label: &str, side: u32, layers: u32, format: TextureFormat, usage: TextureUsages) -> Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d { width: side, height: side, depth_or_array_layers: layers },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage,
        view_formats: &[],
    })
}

impl GridGpu {
    fn new(device: &Device, layout: &AtlasLayout) -> Result<GridGpu, RenderError> {
        use crate::ibl::{compute_with, sampler_entry, texture_entry};
        use TextureViewDimension::{Cube, D2Array};
        let atlas = texture_3d(device, "env irradiance", layout.extent, TextureUsages::TEXTURE_BINDING | TextureUsages::COPY_DST | TextureUsages::COPY_SRC);
        let atlas_view = atlas.create_view(&wgpu::TextureViewDescriptor::default());
        let staging = texture_3d(device, "irradiance staging", layout.staging, TextureUsages::STORAGE_BINDING | TextureUsages::COPY_SRC);
        let staging_view = staging.create_view(&wgpu::TextureViewDescriptor::default());
        let layers = FACES * BATCH_CELLS as u32;
        let attachment = TextureUsages::RENDER_ATTACHMENT | TextureUsages::TEXTURE_BINDING;
        let color = layers_2d(device, "irradiance capture", CAPTURE_SIDE, layers, crate::probes::CAPTURE_COLOR_FORMAT, attachment);
        let depth = layers_2d(device, "irradiance capture depth", CAPTURE_SIDE, layers, crate::probes::CAPTURE_DEPTH_FORMAT, attachment);
        let shadow = layers_2d(device, "irradiance capture shadow", crate::probes::CAPTURE_SHADOW_PX, 1, crate::shadow::SHADOW_FORMAT, attachment);
        let array = |texture: &Texture| texture.create_view(&wgpu::TextureViewDescriptor { dimension: Some(D2Array), ..Default::default() });
        let depth_entry = BindGroupLayoutEntry {
            binding: 2,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Depth, view_dimension: D2Array, multisampled: false },
            count: None,
        };
        let staging_entry = BindGroupLayoutEntry {
            binding: 5,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::StorageTexture { access: wgpu::StorageTextureAccess::WriteOnly, format: ATLAS_FORMAT, view_dimension: TextureViewDimension::D3 },
            count: None,
        };
        let reduce_layout = crate::ibl::layout(device, "irradiance reduce", &[
            crate::tables::compute_uniform(0),
            texture_entry(1, false, D2Array),
            depth_entry,
            texture_entry(3, true, Cube),
            sampler_entry(4),
            staging_entry,
        ]);
        Ok(GridGpu {
            // Audited in `compile::WORKGROUP_AUDIT`: every lane writes its slots before the first barrier.
            reduce: compute_with(device, ("irradiance reduce", IRRADIANCE_PASSES, REDUCE_ENTRY), &reduce_layout, false)?,
            uniforms: crate::tables::buffer(device, "irradiance reduce", size_of::<GpuGridBake>() as u64, BufferUsages::UNIFORM | BufferUsages::COPY_DST)?,
            sky_sampler: crate::ibl::sampler(device, "irradiance sky", wgpu::AddressMode::ClampToEdge),
            color_layers: (0..layers).map(|layer| layer_view(&color, layer)).collect(),
            color_view: array(&color),
            depth_layers: (0..layers).map(|layer| layer_view(&depth, layer)).collect(),
            depth_view: array(&depth),
            shadow_attachment: shadow.create_view(&wgpu::TextureViewDescriptor { dimension: Some(TextureViewDimension::D2), ..Default::default() }),
            shadow_array: array(&shadow),
            reduce_layout,
            atlas,
            atlas_view,
            staging,
            staging_view,
            group: None,
        })
    }

    /// The reduce's uniform for `batch` of `volume`.
    fn write_bake(&self, queue: &Queue, volume: &IrradianceVolume, batch: &GridBatch, reversed: bool) {
        let mut cells = [[0u32; 4]; BATCH_CELLS];
        for (index, (slot, cell)) in cells.iter_mut().zip(&batch.cells).enumerate() {
            *slot = [cell[0], cell[1], cell[2], index as u32 * FACES];
        }
        let (z_scale, z_offset) = capture_depth_terms(&volume.capture_probe([0; 3]), reversed);
        let bake = GpuGridBake {
            cells,
            shape: [batch.cells.len().min(BATCH_CELLS) as u32, volume.cells[1], volume.cells[2], CAPTURE_SIDE],
            depth: [if reversed { 0.0 } else { 1.0 }, z_scale, z_offset, volume.reach_max()],
            sky: [SKY_LEVEL, bounce_gain(volume.bounce), 0.0, 0.0],
        };
        queue.write_buffer(&self.uniforms, 0, bytemuck::bytes_of(&bake));
    }

    /// The reduce of `cells` cells over the sky cube `sky` (its bake generation).
    fn encode_reduce(&mut self, device: &Device, encoder: &mut wgpu::CommandEncoder, cells: u32, (sky, generation): (&TextureView, u64)) {
        if self.group.as_ref().is_none_or(|(held, _)| *held != generation) {
            let entries = [
                wgpu::BindGroupEntry { binding: 0, resource: self.uniforms.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: BindingResource::TextureView(&self.color_view) },
                wgpu::BindGroupEntry { binding: 2, resource: BindingResource::TextureView(&self.depth_view) },
                wgpu::BindGroupEntry { binding: 3, resource: BindingResource::TextureView(sky) },
                wgpu::BindGroupEntry { binding: 4, resource: BindingResource::Sampler(&self.sky_sampler) },
                wgpu::BindGroupEntry { binding: 5, resource: BindingResource::TextureView(&self.staging_view) },
            ];
            let group = device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("irradiance reduce"), layout: &self.reduce_layout, entries: &entries });
            self.group = Some((generation, group));
        }
        let Some((_, group)) = &self.group else { return };
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("irradiance reduce"), timestamp_writes: None });
        pass.set_pipeline(&self.reduce);
        pass.set_bind_group(0, group, &[]);
        pass.dispatch_workgroups(cells.clamp(1, BATCH_CELLS as u32), 1, 1);
    }

    /// The staging block of `volume` into its atlas block at x `origin`, whole.
    fn publish(&self, encoder: &mut wgpu::CommandEncoder, volume: &IrradianceVolume, origin: u32) {
        let [width, height, depth] = volume.block();
        encoder.copy_texture_to_texture(
            wgpu::TexelCopyTextureInfo { texture: &self.staging, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            wgpu::TexelCopyTextureInfo { texture: &self.atlas, mip_level: 0, origin: wgpu::Origin3d { x: origin, y: 0, z: 0 }, aspect: wgpu::TextureAspect::All },
            wgpu::Extent3d { width, height, depth_or_array_layers: depth },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn room() -> IrradianceVolume {
        IrradianceVolume::new([-4.0, 0.0, -4.0], [4.0, 3.0, 4.0])
    }

    #[test]
    fn hostile_volumes_are_held_or_dropped() {
        let nan = f32::NAN;
        let dropped = [
            IrradianceVolume::new([nan, 0.0, 0.0], [1.0; 3]),
            IrradianceVolume::new([0.0; 3], [f32::INFINITY, 1.0, 1.0]),
            IrradianceVolume::new([0.0; 3], [1.0, 1.0, 0.0]),
            IrradianceVolume::new([0.0; 3], [VOLUME_EXTENT_MAX * 2.0, 1.0, 1.0]),
        ];
        for volume in dropped {
            assert_eq!(volume.held(), None, "{volume:?}");
        }
        let flipped = IrradianceVolume { min: [2.0, 2.0, 2.0], max: [0.0, 0.0, 0.0], cells: [0, 999, u32::MAX], blend: 99.0, intensity: f32::INFINITY, bounce: f32::NAN };
        let held = flipped.held().expect("held");
        assert_eq!((held.min, held.max), ([0.0; 3], [2.0; 3]), "corners sorted");
        assert!(held.cells.iter().all(|count| (1..=CELLS_PER_AXIS_MAX).contains(count)), "{:?}", held.cells);
        assert!(held.cell_count() <= CELLS_MAX, "{:?}", held.cells);
        assert_eq!((held.blend, held.intensity), (1.0, 1.0), "fade held to half the side, multiplier default");
        assert_eq!(held.bounce, DEFAULT_BOUNCE, "a bounce albedo that is not finite is the default");
        assert_eq!(room().with_bounce(2.0).held().map(|volume| volume.bounce), Some(BOUNCE_MAX));
        let negative = room().with_intensity(-2.0).with_blend(nan).held().expect("held");
        assert_eq!((negative.intensity, negative.blend), (0.0, 0.0));
        let many: Vec<IrradianceVolume> = (0..MAX_VOLUMES + 3).map(|i| IrradianceVolume::new([i as f32, 0.0, 0.0], [i as f32 + 1.0, 1.0, 1.0])).collect();
        assert_eq!(held_volumes(&many).len(), MAX_VOLUMES);
    }

    #[test]
    fn the_later_bounces_sum_as_a_geometric_series_and_change_the_bake() {
        assert_eq!(bounce_gain(0.0), 0.0, "albedo 0: the first bounce alone");
        assert!((bounce_gain(0.5) - 1.0).abs() < 1e-6, "albedo 0.5 doubles the first bounce");
        assert!((bounce_gain(1.0) - BOUNCE_MAX / (1.0 - BOUNCE_MAX)).abs() < 1e-6, "held below 1");
        assert_ne!(room().bake_key(), room().with_bounce(0.0).bake_key(), "a new albedo is a new bake");
        assert_eq!(room().bake_key(), room().with_intensity(3.0).bake_key(), "the multiplier is only the row's");
    }

    #[test]
    fn a_new_volume_takes_a_cell_about_every_metre() {
        assert_eq!(room().cells, [8, 3, 8]);
        assert_eq!(IrradianceVolume::new([0.0; 3], [0.4, 100.0, 2.5]).cells, [1, CELLS_PER_AXIS_MAX, 3]);
        let volume = room();
        assert_eq!(volume.cell_centre([0, 0, 0]).to_array(), [-3.5, 0.5, -3.5]);
        assert_eq!(volume.cell_at(volume.cell_count() - 1), [7, 2, 7]);
        assert!((volume.normal_bias() - 0.3).abs() < 1e-6);
    }

    #[test]
    fn a_row_packs_its_volume_exactly_and_never_reflects() {
        let volume = IrradianceVolume::new([-1.0, 0.0, 2.0], [7.0, 3.0, 6.0]).with_cells([32, 31, 30]).with_intensity(2.0);
        for leak in [false, true] {
            let row = volume_row(&volume, Some(40), 0.5, leak);
            assert_eq!(row_cells(&row), ([32, 31, 30], leak));
            assert_eq!(row_origin(&row), Some(40));
            assert!(!row.active(), "a volume row is no reflection probe");
            assert_eq!(row.capture_intensity[1..], [0.5, volume.normal_bias(), 2.0]);
        }
        assert_eq!(row_origin(&volume_row(&volume, None, 1.0, true)), None, "not baked: no weight");
        assert_eq!(row_origin(&volume_row(&volume, Some(3), 0.0, true)), None, "not faded in: no weight");
    }

    /// A constant environment of radiance `l` reaching nothing.
    fn open(l: [f32; 3]) -> impl Fn([f32; 3]) -> ([f32; 3], Option<f32>) {
        move |_| (l, None)
    }

    #[test]
    fn reach_codes_round_trip_within_a_step_and_pack_exactly() {
        let reach_max = 3.3;
        for distance in [0.0_f32, 0.02, 0.1, 0.3, 0.55, 1.0, 2.5, 3.3, 9.0] {
            let back = reach_of(reach_code(distance, reach_max), reach_max);
            assert!((back - distance.min(reach_max)).abs() <= 0.5 * reach_max / REACH_CODE_MAX as f32 + 1e-6, "{distance} -> {back}");
        }
        let packed = pack_reaches(0.3, 3.3, reach_max);
        assert_eq!(packed, packed.round(), "an exact integer");
        assert!(packed < 2048.0, "exact in f16: {packed}");
        assert_eq!(packed as u32 & REACH_CODE_MAX, REACH_CODE_MAX, "minus: the clamp");
    }

    #[test]
    fn a_constant_environment_bakes_exactly_its_radiance() {
        let cube = ambient_cube_of(&open([0.25, 0.5, 2.0]), CAPTURE_SIDE, 3.0, 0.0);
        for texel in cube {
            for (value, want) in texel.iter().zip([0.25, 0.5, 2.0]) {
                assert!((value - want).abs() < 1e-5, "{texel:?}");
            }
        }
        assert_eq!(ambient_reaches(&cube, 3.0), [3.0; AXIS_DIRECTIONS], "nothing seen: every reach is the clamp");
        for n in [[1.0, 0.0, 0.0], [0.0, -1.0, 0.0], Vec3::new(0.3, -0.5, 0.8).normalize().to_array()] {
            let e = ambient_irradiance(&cube, n);
            assert!((e[2] - 2.0).abs() < 1e-4, "{n:?}: {e:?}");
        }
    }

    #[test]
    fn the_ambient_cube_holds_light_from_its_side() {
        // A red wall fills the +x half of the sphere at 1 unit, the sky the rest.
        let sees = |d: [f32; 3]| if d[0] > 0.0 { ([1.0, 0.0, 0.0], Some(1.0 / d[0])) } else { ([0.0, 0.0, 1.0], None) };
        let cube = ambient_cube_of(&sees, CAPTURE_SIDE, 4.0, 0.0);
        assert!(cube[0][0] > 0.99 && cube[0][2] < 0.01, "+x sees the wall: {:?}", cube[0]);
        assert!(cube[1][2] > 0.99 && cube[1][0] < 0.01, "-x sees the sky: {:?}", cube[1]);
        assert!((cube[2][0] - 0.5).abs() < 0.05, "+y sees half of each: {:?}", cube[2]);
        let reaches = ambient_reaches(&cube, 4.0);
        assert!((reaches[0] - 1.0).abs() < 0.11, "+x reaches the wall's plane: {}", reaches[0]);
        assert!((reaches[1] - 4.0).abs() < 1e-5, "-x reaches the clamp: {}", reaches[1]);
        assert_eq!(super::sees(&cube, 0, 0.5, 4.0, 0.15), 1.0, "a point before the wall is seen");
        assert_eq!(super::sees(&cube, 0, 1.5, 4.0, 0.15), 0.0, "a point past it is not");
        assert_eq!(super::sees(&cube, 0, -3.0, 4.0, 0.15), 1.0, "nor is the other side blocked");
    }

    /// A row of `volume` at origin 0 and a lookup of cell `cell`'s cube from `cubes`.
    fn lookup(volume: &IrradianceVolume, leak: bool) -> GpuProbeRow {
        volume_row(volume, Some(0), 1.0, leak)
    }

    #[test]
    fn leak_control_hides_the_cells_behind_a_wall() {
        // Two cells along x with centres at 0.5 and 1.5, a 20 cm wall between them at x 1.2..1.4:
        // the left cell is in a dark room (black, reaching the wall's inner face 0.7 away toward
        // +x), the right one outside in the sun (reaching the wall's outer face 0.1 away toward -x).
        let volume = IrradianceVolume::new([0.0, 0.0, 0.0], [2.0, 1.0, 1.0]).with_cells([2, 1, 1]).with_blend(0.0);
        let reach_max = volume.reach_max();
        let dark = ambient_cube([[0.0; 3]; AXIS_DIRECTIONS], [0.7, 0.5, 0.5, 0.5, 0.5, 0.5], reach_max);
        let lit = ambient_cube([[4.0; 3]; AXIS_DIRECTIONS], [3.0, 0.1, 3.0, 3.0, 3.0, 3.0], reach_max);
        let cubes = |cell: [u32; 3]| if cell[0] == 0 { dark } else { lit };
        // A point on the wall's inner face, its normal facing into the room (-x): offset along it,
        // it reads 38% of the outside cell through plain trilinear.
        let inside = [1.18, 0.5, 0.5];
        let into_room = [-1.0, 0.0, 0.0];
        let leaky = grid_irradiance(&lookup(&volume, false), &cubes, inside, into_room);
        let held = grid_irradiance(&lookup(&volume, true), &cubes, inside, into_room);
        assert!(leaky[0] > 1.0, "trilinear lends the room the sun's light: {leaky:?}");
        assert!(held[0] < 0.01, "leak control keeps the room dark: {held:?}");
        // Outside, facing away from the wall: the sun-lit cell alone.
        let outside = [1.6, 0.5, 0.5];
        let e = grid_irradiance(&lookup(&volume, true), &cubes, outside, [1.0, 0.0, 0.0]);
        assert!(e[0] > 3.9, "{e:?}");
    }

    #[test]
    fn a_uniform_grid_reads_its_value_everywhere_with_or_without_leak_control() {
        let volume = room();
        let cube = ambient_cube([[0.7, 0.2, 0.1]; AXIS_DIRECTIONS], [volume.reach_max(); AXIS_DIRECTIONS], volume.reach_max());
        for leak in [false, true] {
            for p in [[-3.9, 0.1, 3.9], [0.0, 1.5, 0.0], [5.0, 9.0, -5.0]] {
                let e = grid_irradiance(&lookup(&volume, leak), &|_| cube, p, [0.0, 1.0, 0.0]);
                assert!((e[0] - 0.7).abs() < 1e-5 && (e[2] - 0.1).abs() < 1e-5, "{leak} {p:?}: {e:?}");
            }
        }
    }

    #[test]
    fn volume_weights_are_continuous_and_fill_with_the_sky() {
        let rows = [lookup(&IrradianceVolume::new([-4.0, 0.0, -2.0], [0.0, 3.0, 2.0]).with_blend(1.0), true), lookup(&IrradianceVolume::new([0.0, 0.0, -2.0], [4.0, 3.0, 2.0]).with_blend(1.0), true)];
        let mut previous: Option<(Vec<f32>, f32)> = None;
        let mut x = -6.0;
        while x <= 6.0 {
            let (weights, sky) = blend(&rows, [x, 1.5, 0.0]);
            assert!((weights.iter().sum::<f32>() + sky - 1.0).abs() < 1e-5);
            if let Some((was, was_sky)) = &previous {
                let jump = weights.iter().zip(was).map(|(a, b)| (a - b).abs()).fold((sky - was_sky).abs(), f32::max);
                assert!(jump < 0.03, "x {x}: {jump}");
            }
            previous = Some((weights, sky));
            x += 0.001;
        }
        let probe = GpuProbeRow::of(&ReflectionProbe::new([-1.0; 3], [1.0; 3]), 1);
        assert_eq!(blend(&[probe], [0.0; 3]), (vec![0.0], 1.0), "a reflection probe's row lends no diffuse light");
    }

    /// AAA review WP-12: a declared probe without a volume gets one over its box, a declared volume
    /// without a probe gets one, the camera gets its own volume where no room holds it, and the
    /// same camera always gets the same box.
    #[test]
    fn auto_rooms_pair_declared_rooms_and_follow_the_camera_outside_them() {
        let classroom = ReflectionProbe::new([0.0, 0.0, 0.0], [8.0, 3.0, 6.0]);
        let corridor = IrradianceVolume::new([8.0, 0.0, 0.0], [10.0, 3.0, 20.0]);
        let (volumes, probes) = auto_rooms(&[corridor], &[classroom], [4.0, 1.6, 3.0], AutoRooms::ALL);
        assert_eq!(volumes.len(), 2, "the corridor, then the classroom's own; the camera is in a room");
        assert_eq!((volumes[1].min, volumes[1].max), (classroom.min, classroom.max));
        assert_eq!(probes.len(), 2);
        assert_eq!((probes[1].min, probes[1].max, probes[1].capture), (corridor.min, corridor.max, [9.0, 1.6, 10.0]));
        let (paired_only, _) = auto_rooms(&[corridor], &[classroom], [40.0, 1.6, 3.0], AutoRooms::PAIRED);
        assert_eq!(paired_only.len(), 2, "no camera volume without `camera`");
        let (outside, _) = auto_rooms(&[corridor], &[classroom], [40.0, 1.6, 3.0], AutoRooms::ALL);
        assert_eq!(outside.len(), 3);
        let own = outside[2];
        assert_eq!((own.min, own.max, own.cells), ([28.0, -2.0, -12.0], [52.0, 6.0, 12.0], CAMERA_VOLUME_CELLS));
        assert_eq!(camera_volume([41.0, 1.7, 3.5]), camera_volume([40.0, 1.6, 3.0]), "a step keeps the box");
        assert!(contains(&camera_volume([43.9, 1.6, 3.0]), [43.9, 1.6, 3.0]));
        let same_room = IrradianceVolume::new([0.5, 0.0, 0.0], [8.0, 3.0, 6.0]);
        let (none_added, probes) = auto_rooms(&[same_room], &[classroom], [4.0, 1.6, 3.0], AutoRooms::ALL);
        assert_eq!((none_added.len(), probes.len()), (1, 1), "a probe and a volume over one room pair");
        assert_eq!(auto_rooms(&[], &[], [0.0; 3], AutoRooms::OFF), (Vec::new(), Vec::new()));
    }

    fn frame(volumes: &[IrradianceVolume], frame_index: u64, lit_by: u64, settle: bool) -> GridFrame<'_> {
        GridFrame { volumes, lit_by, frame_index, cadence: 1, settle, cells_per_frame: CELLS_PER_FRAME, relight: false }
    }

    #[test]
    fn the_schedule_bakes_a_slice_a_frame_publishes_whole_and_fades_in() {
        let small = IrradianceVolume::new([0.0; 3], [2.0, 1.0, 2.0]);
        let volumes = [small, room()];
        assert_eq!(small.cell_count(), 4);
        let mut schedule = GridSchedule::default();
        let first = schedule.advance(&frame(&volumes, 0, 1, false));
        assert_eq!(first, [GridBatch { slot: 0, cells: vec![[0, 0, 0], [1, 0, 0]], publish: false }]);
        let second = schedule.advance(&frame(&volumes, 1, 1, false));
        assert_eq!(second, [GridBatch { slot: 0, cells: vec![[0, 0, 1], [1, 0, 1]], publish: true }]);
        assert!(schedule.published(0) && !schedule.published(1));
        let layout = AtlasLayout::of(&volumes);
        assert_eq!(layout.origins, [0, 2]);
        let mut frames = 2;
        while !schedule.settled() {
            schedule.advance(&frame(&volumes, frames, 1, false));
            frames += 1;
        }
        assert_eq!(frames, 2 + u64::from(room().cell_count()).div_ceil(CELLS_PER_FRAME as u64));
        let rows = schedule.rows(&layout, true);
        assert_eq!((row_origin(&rows[0]), row_origin(&rows[1])), (Some(0), Some(2)));
        assert!(schedule.presence(0) > schedule.presence(1), "the first fades in first");
        for index in 0..FADE_IN_FRAMES {
            schedule.advance(&frame(&volumes, frames + u64::from(index), 1, false));
        }
        assert_eq!((schedule.presence(0), schedule.presence(1)), (1.0, 1.0));
        // The sky rebaked: stale bakes are redone while the old ones stay bound.
        let work = schedule.advance(&frame(&volumes, 500, 2, false));
        assert_eq!(work[0].slot, 0);
        assert!(schedule.published(0) && schedule.presence(0) == 1.0, "the old bake stays bound and shown");
        // A settled capture bakes whatever differs whole, shown at once.
        let settle = schedule.advance(&frame(&volumes, 501, 3, true));
        let cells: usize = settle.iter().map(|batch| batch.cells.len()).sum();
        assert_eq!(cells, (small.cell_count() + room().cell_count()) as usize);
        assert!(settle.iter().all(|batch| batch.cells.len() <= BATCH_CELLS));
        assert_eq!(settle.iter().filter(|batch| batch.publish).count(), 2);
        assert!(schedule.settled());
        assert!(schedule.advance(&frame(&volumes, 502, 3, true)).is_empty(), "and nothing after");
        // A moved volume (AAA review WP-12: the camera's own) is baked again at its new place
        // while its last bake stays shown where it was baked; its neighbour is untouched. Flipped
        // from "a moved volume starts over", which sent every volume back to the sky's light.
        let moved_room = IrradianceVolume { min: [8.0, 0.0, 0.0], max: [16.0, 3.0, 8.0], ..room() };
        let moved = [small, moved_room];
        let work = schedule.advance(&frame(&moved, 503, 3, false));
        assert!(schedule.published(0) && schedule.published(1), "both still shown");
        assert_eq!(work.first().map(|batch| batch.slot), Some(1), "the moved one bakes");
        let rows = schedule.rows(&layout, true);
        assert_eq!(rows[1].min_blend[0], room().min[0], "shown where it was baked until its new bake publishes");
        let mut frames = 504;
        while !schedule.settled() {
            schedule.advance(&frame(&moved, frames, 3, false));
            frames += 1;
        }
        assert_eq!(schedule.rows(&layout, true)[1].min_blend[0], 8.0, "then at its new place");
        // A volume added starts every slot over.
        schedule.advance(&frame(&[small, moved_room, room()], frames, 3, false));
        assert!(!schedule.published(0) && !schedule.published(1));
    }

    /// Dynamic probe GI (AAA review WP-12): with relight on, current volumes are baked again one
    /// after another for as long as they are held, at the quality's slice, while the schedule
    /// still reads as settled (a capture compared with Live does not wait forever).
    #[test]
    fn relight_bakes_current_volumes_again_round_robin_at_the_quality_slice() {
        let small = IrradianceVolume::new([0.0; 3], [2.0, 1.0, 2.0]);
        let volumes = [small, room()];
        let relit = |index: u64| GridFrame { cells_per_frame: 4, relight: true, ..frame(&volumes, index, 1, false) };
        let mut schedule = GridSchedule::default();
        let first = schedule.advance(&relit(0));
        assert_eq!(first[0].cells.len(), 4, "the quality's slice");
        let mut index = 1;
        while !schedule.settled() {
            schedule.advance(&relit(index));
            index += 1;
        }
        assert_eq!(index, 1 + u64::from(room().cell_count()).div_ceil(4));
        let mut relit_slots = Vec::new();
        let mut batches = 0;
        let relight_frames = RELIGHT_CADENCE * u64::from(small.cell_count() + room().cell_count());
        for _ in 0..relight_frames {
            let work = schedule.advance(&relit(index));
            assert!(work.is_empty() || index % RELIGHT_CADENCE == 0, "a relight batch only every {RELIGHT_CADENCE} frames");
            index += 1;
            batches += work.len();
            relit_slots.extend(work.iter().filter(|batch| batch.publish).map(|batch| batch.slot));
            assert!(schedule.settled(), "a relight never reads as unsettled");
            assert!(schedule.published(0) && schedule.published(1));
        }
        assert!(batches > 0 && batches as u64 <= relight_frames / RELIGHT_CADENCE + 1);
        assert_eq!(&relit_slots[..2], [0, 1], "round robin");
        let still = GridFrame { relight: false, ..relit(index) };
        let mut idle = GridSchedule::default();
        idle.advance(&GridFrame { settle: true, ..still });
        assert!(idle.advance(&still).is_empty(), "without relight a current bake is left alone");
    }

    #[test]
    fn the_atlas_lays_blocks_side_by_side_and_the_memory_follows() {
        let volumes = [room(), IrradianceVolume::new([0.0; 3], [2.0, 5.0, 1.0])];
        let layout = AtlasLayout::of(&volumes);
        assert_eq!(layout.extent, [8 + 2, 2 * 5, 3 * 8]);
        assert_eq!(layout.staging, [8, 10, 24]);
        assert_eq!(atlas_texel(2, [8, 3, 8], [1, 2, 3], 3), [3, 2 + 3, 3 + 8], "-y: upper half, the y third");
        assert_eq!(volume_bytes(&[]), 0);
        assert!(volume_bytes(&volumes) > layout.bytes());
        assert!(volume_bytes(&[room()]) < 8 << 20, "a room's volume is a few MB at most: {}", volume_bytes(&[room()]));
    }

    #[test]
    fn the_depth_terms_recover_the_view_distance() {
        let probe = room().capture_probe([2, 1, 2]);
        for reversed in [false, true] {
            let (z_scale, z_offset) = capture_depth_terms(&probe, reversed);
            for distance in [0.1_f32, 1.0, 7.5] {
                let point = Vec3::from(probe.capture) + Vec3::X * distance;
                let clip = crate::probes::face_view_proj(&probe, 0, reversed) * point.extend(1.0);
                let depth = clip.z / clip.w;
                let back = z_offset / (depth + z_scale);
                assert!((back.abs() - distance).abs() < distance * 1e-3, "{reversed} {distance}: {back}");
            }
        }
    }
}
