//! Light binning after Drobot (Call of Duty, "Improved Culling for Tiled and Clustered Rendering",
//! SIGGRAPH 2017): RQ6.0 contracts, RQ6.1 build. The CPU sorts the frame's local lights by view
//! depth (a total, deterministic order) and gives each sorted light a bounds row: the screen tiles
//! its sphere can touch (the sphere's exact perspective silhouette, grown by [`TILE_MARGIN_PX`])
//! and the z-bins its depth reaches. A compute pass (graph node 4) then gives every screen tile a
//! bitmask of the lights whose tile rectangle holds it, `ceil(lights / 32)` words per tile, with
//! no atomics: a rectangle is a column range times a row range, so one dispatch writes a mask word
//! per tile column and per tile row ([`LightGrid::axis_words`]) and the next writes each tile's
//! word as its column's AND its row's, every invocation writing only its own word (coalesced, and
//! the tests stay exactly the rectangle test). A third dispatch fills a 1D array of z-bins with,
//! per slice of view depth, the lowest and highest sorted index of a light touching that slice.
//! A fragment walks its tile's mask words intersected with its z-bin's index range in light-index
//! order ([`lights_at`] is that walk): no per-cluster cap, so no light is ever truncated. The
//! preset's light cap drops whole lights, farthest first, before binning ([`binned_order`]).
//!
//! Table (renderer pass 2 A.0, LG-16): one `light_bins` buffer holds a [`GpuLightBinParams`]
//! header of [`LIGHT_BIN_HEADER_WORDS`] words, then [`LIGHT_ZBINS`] packed z-bins per
//! clusterable kind, then the masks (tile-major) at [`LIGHT_TILES_OFFSET_WORDS`]. The forward
//! frame group binds it whole as `light_bins`; the Level-2 v2 material map binds its z-bins as
//! `light_zbins` and its masks as `light_tiles`, two slices of the one buffer, so the v2 map is
//! unchanged and the forward fragment stage spends one storage buffer on the bins, not two.
//!
//! One clusterable index space (LG-16, after Bevy's clusterable objects): lights, then decals,
//! then probes ([`ClusterKind`]), each kind a contiguous range of sorted indices
//! (`GpuLightBinParams::ranges`) sorted by its own view depth, with its own z-bins, sharing the
//! tile masks. A kind's walk is the lights' walk over its own range ([`clusterables_at`]), so
//! adding decals or probes changes no light's walk. The local light table the shading reads holds
//! the lights in binned order ([`LightBinFrame::sorted`]).
//!
//! Every value is integer or exact on the GPU side: the CPU computes the bounds rows once, so the
//! GPU masks and z-bins equal [`LightBinFrame::reference_masks`] and
//! [`LightBinFrame::reference_zbins`] bit for bit, on every run and destination.
//!
//! [`LANDED`]: the frame records node 4 on every binned frame (RQ6.7), so the masks and z-bins
//! the shading reads are the GPU's; the CPU reference stays the tests' oracle.

use crate::compile::Compiled;
use glam::{Mat4, Vec3};
use wgpu::{BindGroup, BindGroupLayout, Buffer, BufferUsages, ComputePipeline, Device, Queue};

use crate::error::{RenderCode, RenderError};
use crate::gpu::Gpu;
use crate::layout::{GpuLightBinParams, GpuLocalLight, LIGHT_KIND_SPOT, MAX_LOCAL_LIGHTS};
use crate::readback::{capture_failed, map_read_blocking};
use crate::scene::CameraDesc;
use crate::settings::LightQuality;
use crate::tables::{buffer, compute_storage, compute_uniform, entry, pipeline_layout};

/// Whether the light binning node encodes work in this build: the frame records it on every
/// binned frame and the shading reads what it builds (RQ6.7).
pub const LANDED: bool = true;

/// The light binning compute shader (graph node 4).
pub const LIGHT_BIN: &str = crate::shaders::minify::shipped_wgsl!(concat!(include_str!("../shaders/common.wgsl"), include_str!("../shaders/light_bin.wgsl")));
/// The axis-mask entry point: one invocation per mask word of each tile column and tile row.
pub const LIGHT_AXES_ENTRY: &str = "cs_light_axes";
/// The tile-mask entry point: one invocation per mask word of `light_tiles`.
pub const LIGHT_BIN_ENTRY: &str = "cs_light_bin";
/// The z-bin entry point: one workgroup per z-bin (a reduction over the lights); workgroup 0 also
/// writes the header.
pub const LIGHT_ZBIN_ENTRY: &str = "cs_light_zbins";
/// Invocations per binning workgroup.
pub const LIGHT_BIN_WORKGROUP: u32 = 64;
/// What a binned object is (LG-16): lights, decals and probes share one binned index space, each
/// kind a contiguous range of it, in this order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ClusterKind {
    /// A local light (point or spot): the lights' walk ([`lights_at`]).
    Light,
    /// A projected decal's box, bounded by its sphere (renderer pass 2 A.10).
    Decal,
    /// A reflection probe's or irradiance volume's influence, bounded by its sphere (A.3, A.4).
    Probe,
}

impl ClusterKind {
    /// Every kind, in index-space order.
    pub const ALL: [ClusterKind; CLUSTER_KINDS] = [ClusterKind::Light, ClusterKind::Decal, ClusterKind::Probe];

    /// The kind's position in the index space and in the z-bin table.
    pub const fn index(self) -> usize {
        match self {
            ClusterKind::Light => 0,
            ClusterKind::Decal => 1,
            ClusterKind::Probe => 2,
        }
    }
}

/// Clusterable kinds: each has its own z-bins in the table.
pub const CLUSTER_KINDS: usize = 3;
/// Decals binned at most (A.10 sizes its rows within this).
pub const MAX_BINNED_DECALS: usize = 1024;
/// Probes binned at most (A.3 reflection probes and A.4 irradiance volumes together).
pub const MAX_BINNED_PROBES: usize = 64;
/// Objects of every kind binned at most: the index space's size.
pub const MAX_CLUSTERABLES: usize = MAX_LOCAL_LIGHTS + MAX_BINNED_DECALS + MAX_BINNED_PROBES;
/// Mask words per tile at most (every clusterable binned).
pub const LIGHT_BIN_WORDS_MAX: u32 = (MAX_CLUSTERABLES as u32).div_ceil(32);

/// A decal's or probe's world-space bounding sphere: what binning reads of it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ClusterSphere {
    /// The centre.
    pub centre: [f32; 3],
    /// The radius (a sphere that is not a number, or not above 0, bins nothing; an infinite one
    /// covers the whole view).
    pub radius: f32,
}

/// The decals and probes a frame bins beside its lights (empty until A.10 and A.3/A.4 land).
#[derive(Clone, Copy, Debug, Default)]
pub struct ClusterInput<'a> {
    /// The decals' spheres, at most [`MAX_BINNED_DECALS`] (the rest are not binned).
    pub decals: &'a [ClusterSphere],
    /// The probes' spheres, at most [`MAX_BINNED_PROBES`].
    pub probes: &'a [ClusterSphere],
}

/// Slices of view depth the z-bins split the lit range into.
pub const LIGHT_ZBINS: u32 = 64;
/// Words of the [`GpuLightBinParams`] header at the start of `light_bins`.
pub const LIGHT_BIN_HEADER_WORDS: u32 = (size_of::<GpuLightBinParams>() / 4) as u32;
/// Where the tile masks start in `light_bins`, in words: after the header and every kind's
/// z-bins, at an offset every core device binds storage at (256 bytes), so the v2 map's
/// `light_tiles` is a slice of the table.
pub const LIGHT_TILES_OFFSET_WORDS: u32 = 256;
/// Bits of a packed z-bin each light index takes: the low half holds the lowest index, the high
/// half the highest.
pub const ZBIN_INDEX_BITS: u32 = 16;
/// A z-bin no light touches: lowest 0xFFFF above highest 0, so its range is empty.
pub const ZBIN_EMPTY: u32 = 0x0000_FFFF;
/// The bin header word a legacy-loop frame (no light binned: word 5, the light count, is 0) sets
/// to 1 when its light table holds a spot, so the loop reads the extension rows only then (a word
/// of the z-bin count, which no walk reads while no light is binned).
pub const LEGACY_SPOTS_WORD: usize = 4;

/// The narrowest binning tile a preset can ask for, in pixels (the grid stays within one
/// dispatch dimension and 16-bit tile coordinates at the largest core texture size).
pub const LIGHT_TILE_MIN_PX: u32 = 8;
/// The widest binning tile, in pixels.
pub const LIGHT_TILE_MAX_PX: u32 = 128;
/// Pixels a light's screen bounds grow by on each side: covers the TAA jitter (at most half a
/// pixel), MSAA sample positions and f32 rounding between this projection and the GPU's.
pub const TILE_MARGIN_PX: f32 = 1.0;
/// The fraction of a light's depth (plus [`DEPTH_MARGIN_MIN`]) its depth extent grows by on each
/// side: covers f32 rounding between the CPU z-bin edges and a fragment's view depth.
const DEPTH_MARGIN: f32 = 1.0e-4;
const DEPTH_MARGIN_MIN: f32 = 1.0e-4;
/// The nearest a camera's near plane is taken to be (a zero or hostile near plane).
const NEAR_MIN: f32 = 1.0e-4;
/// A bounds row's tile coordinates: x in the low 16 bits, y in the high.
const TILE_COORD_BITS: u32 = 16;
/// The bounds row of a light that touches no tile and no z-bin: tile minimum (0xFFFF, 0xFFFF)
/// above maximum (0, 0), and an empty z-bin range.
pub const BOUNDS_EMPTY: [u32; 4] = [0xFFFF_FFFF, 0, ZBIN_EMPTY, 0];

/// Depth slices of the froxel-list layout binning replaced (plan G14), kept only for the memory
/// record ([`froxel_list_bytes`]).
pub const FROXEL_SLICES: u32 = 24;
/// The per-froxel light cap of that layout: the cap that truncated lights.
pub const FROXEL_LIST_CAP: u32 = 64;
/// Bytes of one froxel's list header (offset and count).
const FROXEL_HEADER_BYTES: u64 = 8;

// Every index of the binned list fits a z-bin's half word.
const _: () = assert!(MAX_CLUSTERABLES < (1 << ZBIN_INDEX_BITS) - 1);
// The masks follow the z-bins at a 256-byte (core storage offset) boundary.
const _: () = assert!(LIGHT_TILES_OFFSET_WORDS as u64 * 4 >= zbin_bytes() && (LIGHT_TILES_OFFSET_WORDS * 4).is_multiple_of(256));
// The z-bin reduction halves the workgroup down to one invocation.
const _: () = assert!(LIGHT_BIN_WORKGROUP.is_power_of_two());

/// A z-bin covering sorted light indices `lowest..=highest`.
pub const fn pack_zbin(lowest: u32, highest: u32) -> u32 {
    (lowest & 0xFFFF) | (highest << ZBIN_INDEX_BITS)
}

/// The sorted light indices a packed z-bin covers, or `None` for an empty one.
pub const fn zbin_range(packed: u32) -> Option<(u32, u32)> {
    let (lowest, highest) = (packed & 0xFFFF, packed >> ZBIN_INDEX_BITS);
    if lowest > highest {
        return None;
    }
    Some((lowest, highest))
}

/// The z-bin a view depth falls in under `params`: `floor((depth - near) * per_depth)` clamped
/// to the bins, so a depth outside the lit range reads the nearest end bin. The shading computes
/// the same in WGSL: `min(u32(max((depth - near) * per_depth, 0.0)), bins - 1u)`.
pub fn zbin_of(params: &GpuLightBinParams, depth: f32) -> u32 {
    zbin_of_kind(params, ClusterKind::Light, depth)
}

/// The z-bins' depth mapping of `kind` under `params` as f32 bits: (where z-bin 0 starts, z-bins
/// per unit depth). Each kind bins over its own depth range, so adding decals or probes changes
/// no light's z-bin.
pub fn kind_depth(params: &GpuLightBinParams, kind: ClusterKind) -> (u32, u32) {
    match kind {
        ClusterKind::Light => (params.depth[2], params.depth[3]),
        ClusterKind::Decal => (params.kind_depth[0], params.kind_depth[1]),
        ClusterKind::Probe => (params.kind_depth[2], params.kind_depth[3]),
    }
}

/// [`zbin_of`] in `kind`'s own z-bins.
pub fn zbin_of_kind(params: &GpuLightBinParams, kind: ClusterKind, depth: f32) -> u32 {
    let bins = params.depth[0];
    let (near, per_depth) = kind_depth(params, kind);
    let slot = (depth - f32::from_bits(near)) * f32::from_bits(per_depth);
    if slot.is_nan() || slot <= 0.0 {
        return 0;
    }
    (slot as u32).min(bins.saturating_sub(1))
}

/// The screen-tile grid of one frame's binning.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LightGrid {
    /// Tiles across.
    pub tiles_x: u32,
    /// Tiles down.
    pub tiles_y: u32,
    /// Mask words per tile: `ceil(lights / 32)`, at least 1 so the table always binds.
    pub words_per_tile: u32,
    /// The tile's side in pixels.
    pub tile_px: u32,
}

impl LightGrid {
    /// The grid over a `render` size in pixels with `tile_px` tiles, for `lights` sorted lights.
    pub fn new(render: (u32, u32), tile_px: u32, lights: u32) -> LightGrid {
        let tile_px = tile_px.max(1);
        LightGrid {
            tiles_x: render.0.max(1).div_ceil(tile_px),
            tiles_y: render.1.max(1).div_ceil(tile_px),
            words_per_tile: lights.div_ceil(32).max(1),
            tile_px,
        }
    }

    /// Screen tiles.
    pub fn tiles(&self) -> u64 {
        u64::from(self.tiles_x) * u64::from(self.tiles_y)
    }

    /// Mask words of every tile.
    pub fn mask_words(&self) -> u64 {
        self.tiles() * u64::from(self.words_per_tile)
    }

    /// Bytes of `light_tiles`.
    pub fn mask_bytes(&self) -> u64 {
        self.mask_words() * 4
    }

    /// Words of the axis masks the build goes through: one per mask word for every tile column
    /// and every tile row (a tile's word is its column's AND its row's).
    pub fn axis_words(&self) -> u64 {
        (u64::from(self.tiles_x) + u64::from(self.tiles_y)) * u64::from(self.words_per_tile)
    }

    /// Bytes of the axis masks.
    pub fn axis_bytes(&self) -> u64 {
        self.axis_words() * 4
    }

    /// The header the dispatch reads and `light_bins` starts with, for `lights` lights and no
    /// other kind: z-bins split the view depths `near..far` evenly.
    pub fn params(&self, lights: u32, near: f32, far: f32) -> GpuLightBinParams {
        self.params_of([lights, lights, lights], [(near, far); CLUSTER_KINDS])
    }

    /// [`LightGrid::params`] of a frame whose kinds end at `ends` (lights, decals, probes), each
    /// kind's z-bins splitting its own `(near, far)` of `depths` evenly.
    pub fn params_of(&self, ends: [u32; CLUSTER_KINDS], depths: [(f32, f32); CLUSTER_KINDS]) -> GpuLightBinParams {
        let mapping = depths.map(|(near, far)| {
            let span = far - near;
            let per_depth = if span.is_finite() && span > 0.0 { LIGHT_ZBINS as f32 / span } else { 0.0 };
            (near.to_bits(), per_depth.to_bits())
        });
        let [(near, per_depth), decal, probe] = mapping;
        GpuLightBinParams {
            grid: [self.tiles_x, self.tiles_y, self.words_per_tile, self.tile_px],
            depth: [LIGHT_ZBINS, ends[0], near, per_depth],
            ranges: [ends[0], ends[1], ends[2], 0],
            kind_depth: [decal.0, decal.1, probe.0, probe.1],
        }
    }
}

/// Bytes of the bin header and every kind's z-bins: the start of `light_bins` (the v2 map's
/// `light_zbins`).
pub const fn zbin_bytes() -> u64 {
    (LIGHT_BIN_HEADER_WORDS as u64 + LIGHT_ZBINS as u64 * CLUSTER_KINDS as u64) * 4
}

/// Bytes of `light_bins` for `grid`: the header and z-bins, then the masks from
/// [`LIGHT_TILES_OFFSET_WORDS`].
pub fn bins_bytes(grid: &LightGrid) -> u64 {
    u64::from(LIGHT_TILES_OFFSET_WORDS) * 4 + grid.mask_bytes()
}

/// The index of z-bin `bin` of `kind` in `light_bins`' words.
pub const fn zbin_word(kind: ClusterKind, bin: u32) -> usize {
    LIGHT_BIN_HEADER_WORDS as usize + kind.index() * LIGHT_ZBINS as usize + bin as usize
}

/// Bytes the froxel-list layout binning replaced would take over the same screen tiles
/// ([`FROXEL_SLICES`] depth slices per tile, each an offset and count plus room for
/// `per_froxel` u16 light indices): the memory record's comparison. With `per_froxel` =
/// [`FROXEL_LIST_CAP`] it is the capped (truncating) list; with the light count, the list that
/// would hold every light without truncation.
pub fn froxel_list_bytes(render: (u32, u32), tile_px: u32, per_froxel: u32) -> u64 {
    let grid = LightGrid::new(render, tile_px, 0);
    grid.tiles() * u64::from(FROXEL_SLICES) * (FROXEL_HEADER_BYTES + u64::from(per_froxel) * 2)
}

/// The binning tile of `quality`, held within [`LIGHT_TILE_MIN_PX`]..=[`LIGHT_TILE_MAX_PX`].
pub fn tile_px(quality: &LightQuality) -> u32 {
    quality.tile_px.clamp(LIGHT_TILE_MIN_PX, LIGHT_TILE_MAX_PX)
}

/// The view depth of `light`'s centre from a camera at `camera_pos` looking along unit `forward`.
fn view_depth(light: &GpuLocalLight, camera_pos: [f32; 3], forward: [f32; 3]) -> f32 {
    let [x, y, z, _] = light.light.position_range;
    (x - camera_pos[0]) * forward[0] + (y - camera_pos[1]) * forward[1] + (z - camera_pos[2]) * forward[2]
}

/// The binning order: row indices of `lights` by view depth of their centres, nearest first, equal
/// depths in row order. A total order (`f32::total_cmp`), so the sorted list, and the picture, is
/// the same on every run and destination.
pub fn depth_order(lights: &[GpuLocalLight], camera_pos: [f32; 3], forward: [f32; 3]) -> Vec<u32> {
    let mut keyed: Vec<(f32, u32)> = lights.iter().enumerate().map(|(row, light)| (view_depth(light, camera_pos, forward), row as u32)).collect();
    keyed.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
    keyed.into_iter().map(|(_, row)| row).collect()
}

/// How far `light`'s sphere is from a camera at `camera_pos`: 0 when it reaches the camera, and
/// infinitely far when its row is not a number (so a hostile row is the first one dropped).
pub(crate) fn reach_distance(light: &GpuLocalLight, camera_pos: [f32; 3]) -> f32 {
    let [x, y, z, range] = light.light.position_range;
    let (dx, dy, dz) = (x - camera_pos[0], y - camera_pos[1], z - camera_pos[2]);
    let distance = (dx * dx + dy * dy + dz * dz).sqrt() - range;
    if distance.is_nan() { f32::INFINITY } else { distance.max(0.0) }
}

/// The binned list under a preset's light cap (`LightQuality::cap`): the `cap` lights whose
/// spheres come nearest the camera (equal distances in row order) are kept, so lights past the cap
/// are dropped farthest first, never truncated per tile, and the kept rows are binned in
/// [`depth_order`]. Under the cap it is [`depth_order`] itself. Deterministic: the same rows and
/// camera give the same list on every run and destination.
pub fn binned_order(lights: &[GpuLocalLight], camera_pos: [f32; 3], forward: [f32; 3], cap: usize) -> Vec<u32> {
    if lights.len() <= cap {
        return depth_order(lights, camera_pos, forward);
    }
    let mut nearest: Vec<(f32, u32)> = lights.iter().enumerate().map(|(row, light)| (reach_distance(light, camera_pos), row as u32)).collect();
    nearest.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
    // Kept in row order, so equal view depths keep [`depth_order`]'s row-order tie break.
    let mut rows: Vec<u32> = nearest.iter().take(cap).map(|(_, row)| *row).collect();
    rows.sort_unstable();
    let kept: Vec<GpuLocalLight> = rows.iter().map(|row| lights[*row as usize]).collect();
    depth_order(&kept, camera_pos, forward).into_iter().map(|at| rows[at as usize]).collect()
}

/// The share of a preset's light cap that fades out towards the cut ([`cap_fade`]): the last
/// tenth of the kept lights, at least one.
pub const CAP_FADE_SHARE: f32 = 0.1;

/// The fade of the lights a preset's cap is about to drop, as (row, weight) pairs for the rows
/// whose radiance is scaled (every other row keeps 1): with more than `cap` rows, the last
/// [`CAP_FADE_SHARE`] of the kept rows by [`binned_order`]'s nearness fade with a smoothstep from
/// 1 at the last whole row's distance to 0 at the first dropped row's, so a light crossing the
/// cap (the camera moving, a light moving) changes its contribution continuously instead of
/// popping. When the faded and dropped rows are at one distance (every one reaches the camera)
/// nothing fades. Deterministic, like the order.
pub fn cap_fade(lights: &[GpuLocalLight], camera_pos: [f32; 3], cap: usize) -> Vec<(u32, f32)> {
    if lights.len() <= cap || cap == 0 {
        return Vec::new();
    }
    let mut nearest: Vec<(f32, u32)> = lights.iter().enumerate().map(|(row, light)| (reach_distance(light, camera_pos), row as u32)).collect();
    nearest.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
    let band = ((cap as f32 * CAP_FADE_SHARE).ceil() as usize).clamp(1, cap);
    // From the last whole light's distance (the camera's when every kept light fades) to the
    // first dropped one's.
    let start = if cap > band { nearest[cap - band - 1].0 } else { 0.0 };
    let cut = nearest[cap].0;
    if cut <= start || !cut.is_finite() {
        return Vec::new();
    }
    nearest[cap - band..cap]
        .iter()
        .map(|(distance, row)| {
            let t = ((cut - distance) / (cut - start)).clamp(0.0, 1.0);
            (*row, t * t * (3.0 - 2.0 * t))
        })
        .collect()
}

/// The sphere holding everything `light` reaches, as (centre, radius): its range sphere, or for a
/// spot the smaller sphere around its cone (a sphere through the cone's rim and apex below 45
/// degrees, through the rim around the axis above). `None` when the row is not a light (a
/// position that is not finite, a range that is not a number or not above 0).
pub fn bounding_sphere(light: &GpuLocalLight) -> Option<(Vec3, f32)> {
    let [x, y, z, range] = light.light.position_range;
    let position = Vec3::new(x, y, z);
    if !position.is_finite() || range.is_nan() || range <= 0.0 {
        return None;
    }
    let [dx, dy, dz, cos_outer] = light.ext.spot;
    let axis = Vec3::new(dx, dy, dz);
    let is_cone = light.ext.params[1] == LIGHT_KIND_SPOT && range.is_finite() && axis.is_finite() && cos_outer > 0.0 && cos_outer <= 1.0;
    if !is_cone {
        return Some((position, range));
    }
    let axis = axis.normalize_or_zero();
    if axis == Vec3::ZERO {
        return Some((position, range));
    }
    // cos 45 degrees: the two cases meet there, where both spheres are the same.
    let wide = cos_outer <= core::f32::consts::FRAC_1_SQRT_2;
    let (offset, radius) = if wide {
        (range * cos_outer, range * (1.0 - cos_outer * cos_outer).max(0.0).sqrt())
    } else {
        let half = range / (2.0 * cos_outer);
        (half, half)
    };
    if radius >= range {
        return Some((position, range));
    }
    Some((position + axis * offset, radius))
}

/// One sorted light's sphere in view space, and its view-depth extent.
#[derive(Clone, Copy, Debug)]
struct Reach {
    /// The sphere's centre in view space (the camera looks along -z).
    centre: Vec3,
    radius: f32,
    /// The nearest and farthest view depth the sphere reaches.
    depths: (f32, f32),
}

/// The camera as binning sees it: the view, the projection's scale and the render size.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BinCamera {
    view: Mat4,
    eye: [f32; 3],
    forward: [f32; 3],
    /// The projection's x and y scale (clip x = scale.x * view x, over depth when perspective).
    scale: [f32; 2],
    ortho: bool,
    near: f32,
    far: f32,
    render: (u32, u32),
}

impl BinCamera {
    /// `camera` drawing a `render`-sized frame (its aspect is the render size's), with the
    /// projection [`CameraDesc::view_proj`] uses: depth-convention free, since binning reads view
    /// depth.
    pub fn new(camera: &CameraDesc, render: (u32, u32)) -> BinCamera {
        let render = (render.0.max(1), render.1.max(1));
        let aspect = render.0 as f32 / render.1 as f32;
        let (eye, target, up) = (Vec3::from(camera.eye), Vec3::from(camera.target), Vec3::from(camera.up));
        let scale = match camera.ortho_height {
            Some(height) => [2.0 / (height * aspect), 2.0 / height],
            None => {
                let focal = 1.0 / libm::tanf(camera.fovy_degrees.to_radians() * 0.5);
                [focal / aspect, focal]
            }
        };
        let near = if camera.near > NEAR_MIN { camera.near } else { NEAR_MIN };
        let far = if camera.far > near { camera.far } else { near };
        BinCamera {
            view: glam::camera::rh::view::look_at_mat4(eye, target, up),
            eye: camera.eye,
            forward: (target - eye).normalize_or_zero().to_array(),
            scale,
            ortho: camera.ortho_height.is_some(),
            near,
            far,
            render,
        }
    }

    /// The render size binned.
    pub fn render(&self) -> (u32, u32) {
        self.render
    }

    /// `light`'s sphere in view space, or `None` when it is not a light or lies wholly in front
    /// of the near plane or past the far plane.
    fn reach(&self, light: &GpuLocalLight) -> Option<Reach> {
        let (centre, radius) = bounding_sphere(light)?;
        self.reach_sphere(centre, radius)
    }

    /// A decal's or probe's sphere in view space, or `None` when it is not a sphere or lies
    /// wholly in front of the near plane or past the far plane.
    fn reach_of(&self, sphere: &ClusterSphere) -> Option<Reach> {
        let centre = Vec3::from(sphere.centre);
        if !centre.is_finite() || sphere.radius.is_nan() || sphere.radius <= 0.0 {
            return None;
        }
        self.reach_sphere(centre, sphere.radius)
    }

    /// The world sphere `centre`/`radius` in view space and its depth extent, when it is seen.
    fn reach_sphere(&self, centre: Vec3, radius: f32) -> Option<Reach> {
        let centre = self.view.transform_point3(centre);
        let depth = -centre.z;
        let depths = (depth - radius, depth + radius);
        let seen = depths.1 >= self.near && depths.0 <= self.far;
        seen.then_some(Reach { centre, radius, depths })
    }

    /// The view-space x or y range `(lowest, highest)` the sphere's points project to, as clip
    /// over depth (before the projection's scale): the sphere's tangent lines through the eye
    /// when it is wholly past the near plane (exact), else the corners of the box around its
    /// part past the near plane (conservative).
    fn lateral(&self, centre: f32, depth: f32, radius: f32) -> (f32, f32) {
        if self.ortho {
            return (centre - radius, centre + radius);
        }
        if depth - radius > self.near {
            let squared = (depth - radius) * (depth + radius);
            let root = (centre * centre + squared).sqrt();
            return ((centre * depth - radius * root) / squared, (centre * depth + radius * root) / squared);
        }
        let far = depth + radius;
        let corners = [(centre - radius) / self.near, (centre + radius) / self.near, (centre - radius) / far, (centre + radius) / far];
        corners.iter().fold((f32::INFINITY, f32::NEG_INFINITY), |(low, high), value| (low.min(*value), high.max(*value)))
    }

    /// The pixel rectangle `[x0, y0, x1, y1]` (y down) a sphere projects into, or `None` when it
    /// covers the whole frame (an infinite or unrepresentable sphere).
    fn pixels(&self, reach: &Reach) -> Option<[f32; 4]> {
        if !reach.radius.is_finite() {
            return None;
        }
        let depth = -reach.centre.z;
        let (x0, x1) = self.lateral(reach.centre.x, depth, reach.radius);
        let (y0, y1) = self.lateral(reach.centre.y, depth, reach.radius);
        let [sx, sy] = self.scale;
        let (width, height) = (self.render.0 as f32, self.render.1 as f32);
        let rect = [(sx * x0 + 1.0) * 0.5 * width, (1.0 - sy * y1) * 0.5 * height, (sx * x1 + 1.0) * 0.5 * width, (1.0 - sy * y0) * 0.5 * height];
        if rect.iter().any(|value| value.is_nan()) {
            return None;
        }
        Some(rect)
    }

    /// The tile rectangle `[x0, y0, x1, y1]` (inclusive) a sphere touches, grown by
    /// [`TILE_MARGIN_PX`], or `None` when it is off screen.
    fn tiles(&self, grid: &LightGrid, reach: &Reach) -> Option<[u32; 4]> {
        let whole = [0, 0, grid.tiles_x - 1, grid.tiles_y - 1];
        let Some([x0, y0, x1, y1]) = self.pixels(reach) else { return Some(whole) };
        let (x0, y0, x1, y1) = (x0 - TILE_MARGIN_PX, y0 - TILE_MARGIN_PX, x1 + TILE_MARGIN_PX, y1 + TILE_MARGIN_PX);
        let (width, height) = (self.render.0 as f32, self.render.1 as f32);
        let off_screen = x1 < 0.0 || y1 < 0.0 || x0 >= width || y0 >= height;
        if off_screen {
            return None;
        }
        let tile = grid.tile_px as f32;
        // `as u32` floors a non-negative value and saturates a huge one.
        let at = |pixel: f32, last: u32| ((pixel.max(0.0) / tile) as u32).min(last);
        Some([at(x0, whole[2]), at(y0, whole[3]), at(x1, whole[2]), at(y1, whole[3])])
    }

    /// The bounds row of one sorted object of `kind`: its tile rectangle and the range of its
    /// kind's z-bins under `params`.
    fn bounds_row(&self, grid: &LightGrid, params: &GpuLightBinParams, kind: ClusterKind, reach: &Reach) -> [u32; 4] {
        let Some([x0, y0, x1, y1]) = self.tiles(grid, reach) else { return BOUNDS_EMPTY };
        let depth = -reach.centre.z;
        let margin = DEPTH_MARGIN * (depth.abs() + reach.radius) + DEPTH_MARGIN_MIN;
        let first = zbin_of_kind(params, kind, reach.depths.0 - margin);
        let last = zbin_of_kind(params, kind, reach.depths.1 + margin).max(first);
        [x0 | (y0 << TILE_COORD_BITS), x1 | (y1 << TILE_COORD_BITS), pack_zbin(first, last), 0]
    }

    /// The view depths the z-bins split: the sorted lights' reach, within the camera's planes.
    fn depth_range(&self, reaches: &[Option<Reach>]) -> (f32, f32) {
        let (low, high) = reaches.iter().flatten().fold((f32::INFINITY, f32::NEG_INFINITY), |(low, high), reach| (low.min(reach.depths.0), high.max(reach.depths.1)));
        if low > high {
            return (self.near, self.near);
        }
        let near = low.max(self.near);
        (near, high.min(self.far).max(near))
    }
}

/// One frame's binning, prepared on the CPU: the binned order, the grid, the header and every
/// sorted object's bounds row. The GPU node turns it into masks and z-bins; the reference methods
/// compute the same on the CPU.
#[derive(Clone, Debug, PartialEq)]
pub struct LightBinFrame {
    /// Rows of the caller's light list in binned order: sorted index `i` is row `order[i]`.
    pub order: Vec<u32>,
    /// Rows of the caller's decal list in binned order (by view depth): sorted index
    /// `first_index(Decal) + i` is decal row `decals[i]`.
    pub decals: Vec<u32>,
    /// Rows of the caller's probe list in binned order, after the decals.
    pub probes: Vec<u32>,
    /// The tile grid.
    pub grid: LightGrid,
    /// The dispatch's uniform and `light_zbins`'s header.
    pub params: GpuLightBinParams,
    /// Per sorted object, lights then decals then probes (`light_bounds`, `vec4<u32>`): x the
    /// tile rectangle's minimum and y its maximum (tile x in the low 16 bits, y in the high), z
    /// the packed z-bin range of its kind's bins, w 0. [`BOUNDS_EMPTY`] for one that touches
    /// nothing on screen.
    pub bounds: Vec<[u32; 4]>,
}

/// Row indices of `spheres` (at most `cap`, the first rows) by view depth of their centres,
/// nearest first, equal depths (and spheres that are not numbers, last) in row order.
fn sphere_order(spheres: &[ClusterSphere], cap: usize, camera_pos: [f32; 3], forward: [f32; 3]) -> Vec<u32> {
    let depth = |sphere: &ClusterSphere| {
        let [x, y, z] = sphere.centre;
        let depth = (x - camera_pos[0]) * forward[0] + (y - camera_pos[1]) * forward[1] + (z - camera_pos[2]) * forward[2];
        if depth.is_nan() { f32::INFINITY } else { depth }
    };
    let mut keyed: Vec<(f32, u32)> = spheres.iter().take(cap).enumerate().map(|(row, sphere)| (depth(sphere), row as u32)).collect();
    keyed.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
    keyed.into_iter().map(|(_, row)| row).collect()
}

impl LightBinFrame {
    /// Bin `lights` (the local-light rows, `lights::local_lights`) for `camera` drawing a
    /// `render`-sized frame under `quality`: at most the preset's cap of lights (farthest dropped
    /// first), its tile size. Deterministic: the same rows, camera and quality give the same frame.
    pub fn prepare(lights: &[GpuLocalLight], camera: &CameraDesc, render: (u32, u32), quality: &LightQuality) -> LightBinFrame {
        LightBinFrame::prepare_clusterables(lights, &ClusterInput::default(), camera, render, quality)
    }

    /// [`LightBinFrame::prepare`] with `others`' decals and probes binned into the same index
    /// space after the lights (LG-16): each kind sorted by its own view depth (at most its cap,
    /// the first rows), with its own z-bins over one depth range, sharing the tile masks.
    pub fn prepare_clusterables(lights: &[GpuLocalLight], others: &ClusterInput<'_>, camera: &CameraDesc, render: (u32, u32), quality: &LightQuality) -> LightBinFrame {
        let view = BinCamera::new(camera, render);
        let cap = usize::try_from(quality.cap).unwrap_or(usize::MAX).min(MAX_LOCAL_LIGHTS);
        let order = binned_order(lights, view.eye, view.forward, cap);
        let decals = sphere_order(others.decals, MAX_BINNED_DECALS, view.eye, view.forward);
        let probes = sphere_order(others.probes, MAX_BINNED_PROBES, view.eye, view.forward);
        let kinds: [Vec<Option<Reach>>; CLUSTER_KINDS] = [
            order.iter().map(|row| view.reach(&lights[*row as usize])).collect(),
            decals.iter().map(|row| view.reach_of(&others.decals[*row as usize])).collect(),
            probes.iter().map(|row| view.reach_of(&others.probes[*row as usize])).collect(),
        ];
        let light_end = order.len() as u32;
        let decal_end = light_end + decals.len() as u32;
        let ends = [light_end, decal_end, decal_end + probes.len() as u32];
        let grid = LightGrid::new(view.render, tile_px(quality), ends[2]);
        let params = grid.params_of(ends, kinds.each_ref().map(|reaches| view.depth_range(reaches)));
        let rows = |kind: ClusterKind| {
            let view = &view;
            kinds[kind.index()].iter().map(move |reach| reach.map_or(BOUNDS_EMPTY, |reach| view.bounds_row(&grid, &params, kind, &reach)))
        };
        let bounds = ClusterKind::ALL.into_iter().flat_map(rows).collect();
        LightBinFrame { order, decals, probes, grid, params, bounds }
    }

    /// The local-light table the shading reads: `lights` in binned order.
    pub fn sorted(&self, lights: &[GpuLocalLight]) -> Vec<GpuLocalLight> {
        self.order.iter().map(|row| lights[*row as usize]).collect()
    }

    /// The first sorted index of `kind` (its range ends where the next kind's starts).
    pub fn first_index(&self, kind: ClusterKind) -> u32 {
        kind_range(&self.params, kind).0
    }

    /// Bytes the bins take: the bin table (header, z-bins, masks) and the axis-mask scratch.
    pub fn bytes(&self) -> u64 {
        bins_bytes(&self.grid) + self.grid.axis_bytes()
    }

    /// The masks the GPU writes, by brute force on the CPU: every tile's words, tile-major.
    pub fn reference_masks(&self) -> Vec<u32> {
        let grid = &self.grid;
        let words = grid.words_per_tile as usize;
        let mut masks = vec![0u32; grid.mask_words() as usize];
        for (index, row) in self.bounds.iter().enumerate() {
            let (x0, y0, x1, y1) = (row[0] & 0xFFFF, row[0] >> TILE_COORD_BITS, row[1] & 0xFFFF, row[1] >> TILE_COORD_BITS);
            for y in y0..=y1.min(grid.tiles_y.saturating_sub(1)) {
                for x in x0..=x1.min(grid.tiles_x.saturating_sub(1)) {
                    let tile = (y * grid.tiles_x + x) as usize;
                    masks[tile * words + index / 32] |= 1 << (index % 32);
                }
            }
        }
        masks
    }

    /// The start of `light_bins` as the GPU writes it, on the CPU: the header, then per kind each
    /// z-bin's lowest and highest sorted index of an object of that kind whose z-bin range holds
    /// it.
    pub fn reference_zbins(&self) -> Vec<u32> {
        let mut table: Vec<u32> = bytemuck::cast_slice(&[self.params]).to_vec();
        for kind in ClusterKind::ALL {
            let (start, end) = kind_range(&self.params, kind);
            let rows = &self.bounds[start as usize..(end as usize).min(self.bounds.len())];
            for bin in 0..LIGHT_ZBINS {
                let touching = rows.iter().enumerate().filter(|(_, row)| zbin_range(row[2]).is_some_and(|(first, last)| first <= bin && bin <= last));
                let fold = |(lowest, highest): (u32, u32), (at, _): (usize, &[u32; 4])| (lowest.min(start + at as u32), highest.max(start + at as u32));
                let (lowest, highest) = touching.fold((0xFFFF, 0), fold);
                table.push(pack_zbin(lowest, highest));
            }
        }
        table
    }
}

/// The sorted indices `kind` holds under `params`: from the previous kind's end to its own.
pub fn kind_range(params: &GpuLightBinParams, kind: ClusterKind) -> (u32, u32) {
    let ends = params.ranges;
    match kind {
        ClusterKind::Light => (0, ends[0]),
        ClusterKind::Decal => (ends[0], ends[1].max(ends[0])),
        ClusterKind::Probe => (ends[1], ends[2].max(ends[1])),
    }
}

/// The sorted light indices a fragment at `pixel` and view `depth` shades, in index order: the
/// walk the shading does over its tile's mask words intersected with its z-bin's range. `masks`
/// and `zbins` are the two parts of `light_bins` (the v2 map's `light_tiles` and `light_zbins`;
/// the header is read from `zbins`).
pub fn lights_at(masks: &[u32], zbins: &[u32], pixel: (u32, u32), depth: f32) -> Vec<u32> {
    clusterables_at(ClusterKind::Light, masks, zbins, pixel, depth)
}

/// [`lights_at`] for any clusterable `kind`: the sorted indices of that kind (its own range of the
/// index space) a fragment at `pixel` and view `depth` reaches, in index order.
pub fn clusterables_at(kind: ClusterKind, masks: &[u32], zbins: &[u32], pixel: (u32, u32), depth: f32) -> Vec<u32> {
    let mut params = GpuLightBinParams::default();
    bytemuck::cast_slice_mut::<GpuLightBinParams, u32>(std::slice::from_mut(&mut params)).copy_from_slice(&zbins[..LIGHT_BIN_HEADER_WORDS as usize]);
    let [tiles_x, tiles_y, words, tile_px] = params.grid;
    let tile = (pixel.1 / tile_px.max(1)).min(tiles_y.saturating_sub(1)) * tiles_x + (pixel.0 / tile_px.max(1)).min(tiles_x.saturating_sub(1));
    let bin = zbin_of_kind(&params, kind, depth);
    let Some((lowest, highest)) = zbins.get(zbin_word(kind, bin)).and_then(|packed| zbin_range(*packed)) else { return Vec::new() };
    let mut lit = Vec::new();
    for word in lowest / 32..=(highest / 32).min(words.saturating_sub(1)) {
        let mut bits = masks[(tile * words + word) as usize];
        while bits != 0 {
            let index = word * 32 + bits.trailing_zeros();
            bits &= bits - 1;
            if (lowest..=highest).contains(&index) {
                lit.push(index);
            }
        }
    }
    lit
}

// ---------------------------------------------------------------------------------------------
// The GPU build

/// The bind-group binding of each piece (shaders/light_bin.wgsl).
const PARAMS_BINDING: u32 = 0;
const BOUNDS_BINDING: u32 = 1;
const BINS_BINDING: u32 = 2;
const AXES_BINDING: u32 = 3;
/// Bytes of one bounds row.
const BOUNDS_ROW_BYTES: u64 = 16;
/// The axis-mask scratch a node starts with (a 1080p grid of 16-pixel tiles with every light
/// fits), in bytes.
const AXES_INITIAL_BYTES: u64 = 32 * 1024;
/// Builds one cost sample records back to back (their mean is the sample).
pub const COST_BUILDS_PER_SAMPLE: u32 = 64;

/// What one build reads and writes.
#[derive(Clone, Copy, Debug)]
pub struct LightBinInput<'a> {
    /// The frame's prepared binning.
    pub frame: &'a LightBinFrame,
    /// `light_bins`: a storage buffer of at least [`bins_bytes`] of the frame's grid.
    pub bins: &'a Buffer,
}

/// The workgroups `(x, y)` of one dispatch.
type Dispatch = (u32, u32);

/// The workgroups `(x, y)` of a dispatch of `invocations` (one per invocation, 64 per group),
/// split over two dimensions past `per_dimension`; `None` when even that does not hold them.
fn dispatch_of(invocations: u64, per_dimension: u32) -> Option<Dispatch> {
    let groups = invocations.div_ceil(u64::from(LIGHT_BIN_WORKGROUP)).max(1);
    let x = groups.min(u64::from(per_dimension.max(1)));
    let y = groups.div_ceil(x);
    Some((u32::try_from(x).ok()?, u32::try_from(y).ok().filter(|y| *y <= per_dimension)?))
}

/// The light binning (graph node 4): its three pipelines, its uniform, bounds rows and axis-mask
/// scratch, and the bind group of the current tables. Made once, recorded every frame with local
/// lights; one build per submission (its uniform and rows are queue writes).
pub struct LightBinNode {
    layout: BindGroupLayout,
    axes_pipeline: Compiled<ComputePipeline>,
    masks: Compiled<ComputePipeline>,
    zbins: Compiled<ComputePipeline>,
    params: Buffer,
    bounds: Buffer,
    axes: Buffer,
    cached: Option<(Buffer, BindGroup)>,
}

fn compute_pipeline(device: &Device, layout: &BindGroupLayout, module: &wgpu::ShaderModule, entry: &str) -> Compiled<ComputePipeline> {
    crate::compile::compute_pipeline(device, &wgpu::ComputePipelineDescriptor {
        label: Some(entry),
        layout: Some(&pipeline_layout(device, entry, &[layout])),
        module,
        entry_point: Some(entry),
        // A8.6: the z-bin kernel writes its workgroup arrays first; the others have none.
        compilation_options: crate::compile::written_first(),
        cache: None,
    })
}

/// The two dispatches of a frame the node can build into these tables, `(axes, masks)`; refused
/// `buffer-too-large` for more rows than the bounds buffer holds, a header that does not match
/// the rows, tables too small, a mask table over the device's storage binding limit or a grid
/// past its dispatch limit.
fn check_input(device: &Device, input: &LightBinInput<'_>) -> Result<[Dispatch; 2], RenderError> {
    let frame = input.frame;
    let rows = frame.bounds.len();
    let grid = &frame.grid;
    let [light_end, decal_end, probe_end, _] = frame.params.ranges;
    let ordered = light_end <= decal_end && decal_end <= probe_end && light_end as usize <= MAX_LOCAL_LIGHTS;
    let consistent = rows <= MAX_CLUSTERABLES
        && ordered
        && probe_end as usize == rows
        && frame.params.depth[1] == light_end
        && frame.params.grid == [grid.tiles_x, grid.tiles_y, grid.words_per_tile, grid.tile_px]
        && grid.words_per_tile >= (rows as u32).div_ceil(32)
        && grid.words_per_tile <= LIGHT_BIN_WORDS_MAX;
    if !consistent {
        return Err(RenderError::refused(RenderCode::BufferTooLarge, format!("light bins: {rows} bounds rows do not match the header {:?}", frame.params)));
    }
    let limits = device.limits();
    let wanted = grid.mask_bytes();
    let binding = limits.max_storage_buffer_binding_size;
    let per_dimension = limits.max_compute_workgroups_per_dimension;
    let dispatches = dispatch_of(grid.axis_words(), per_dimension).zip(dispatch_of(grid.mask_words(), per_dimension)).map(|(axes, masks)| [axes, masks]);
    let Some(dispatches) = dispatches.filter(|_| wanted <= binding && grid.axis_bytes() <= binding) else {
        return Err(RenderError::refused(RenderCode::BufferTooLarge, format!("light bins: {wanted} mask bytes over a {binding}-byte binding or its dispatch")));
    };
    if input.bins.size() < bins_bytes(grid) || bins_bytes(grid) > binding {
        let detail = format!("light bins: a table of {} bytes for {}", input.bins.size(), bins_bytes(grid));
        return Err(RenderError::refused(RenderCode::BufferTooLarge, detail));
    }
    Ok(dispatches)
}

fn axes_buffer(device: &Device, bytes: u64) -> Result<Buffer, RenderError> {
    buffer(device, "light axis masks", bytes.max(AXES_INITIAL_BYTES), BufferUsages::STORAGE)
}

impl LightBinNode {
    /// The build's pipelines, uniform, bounds rows (room for [`MAX_CLUSTERABLES`]) and axis-mask
    /// scratch (grown when a grid needs more).
    pub fn new(device: &Device) -> Result<LightBinNode, RenderError> {
        let module = crate::shaders::module(device, "light binning", LIGHT_BIN)?;
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("light binning"),
            entries: &[
                compute_uniform(PARAMS_BINDING),
                compute_storage(BOUNDS_BINDING, true),
                compute_storage(BINS_BINDING, false),
                compute_storage(AXES_BINDING, false),
            ],
        });
        let params = buffer(device, "light binning params", size_of::<GpuLightBinParams>() as u64, BufferUsages::UNIFORM | BufferUsages::COPY_DST)?;
        let bounds = buffer(device, "light bounds", MAX_CLUSTERABLES as u64 * BOUNDS_ROW_BYTES, BufferUsages::STORAGE | BufferUsages::COPY_DST)?;
        Ok(LightBinNode {
            axes_pipeline: compute_pipeline(device, &layout, &module, LIGHT_AXES_ENTRY),
            masks: compute_pipeline(device, &layout, &module, LIGHT_BIN_ENTRY),
            zbins: compute_pipeline(device, &layout, &module, LIGHT_ZBIN_ENTRY),
            layout,
            params,
            bounds,
            axes: axes_buffer(device, 0)?,
            cached: None,
        })
    }

    /// Record the build of `input`'s masks and z-bins: one compute pass of three dispatches (the
    /// axis masks, the tile masks, the z-bins). Refused `buffer-too-large` when the frame does not
    /// fit its tables.
    pub fn encode(&mut self, device: &Device, queue: &Queue, encoder: &mut wgpu::CommandEncoder, input: LightBinInput<'_>) -> Result<(), RenderError> {
        self.encode_timed(device, queue, encoder, input, None)
    }

    /// [`LightBinNode::encode`] with the pass's timestamp writes (a cost row).
    fn encode_timed(
        &mut self,
        device: &Device,
        queue: &Queue,
        encoder: &mut wgpu::CommandEncoder,
        input: LightBinInput<'_>,
        timestamp_writes: Option<wgpu::ComputePassTimestampWrites<'_>>,
    ) -> Result<(), RenderError> {
        let [axes, masks] = check_input(device, &input)?;
        let frame = input.frame;
        if self.axes.size() < frame.grid.axis_bytes() {
            self.axes = axes_buffer(device, frame.grid.axis_bytes())?;
            self.cached = None;
        }
        queue.write_buffer(&self.params, 0, bytemuck::bytes_of(&frame.params));
        if !frame.bounds.is_empty() {
            queue.write_buffer(&self.bounds, 0, bytemuck::cast_slice(&frame.bounds));
        }
        let group = self.group(device, input.bins);
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("light binning"), timestamp_writes });
        pass.set_bind_group(0, &group, &[]);
        // Each dispatch is its own usage scope: the axis masks are written before the tiles read them.
        pass.set_pipeline(&self.axes_pipeline);
        pass.dispatch_workgroups(axes.0, axes.1, 1);
        pass.set_pipeline(&self.masks);
        pass.dispatch_workgroups(masks.0, masks.1, 1);
        pass.set_pipeline(&self.zbins);
        pass.dispatch_workgroups(LIGHT_ZBINS, CLUSTER_KINDS as u32, 1);
        Ok(())
    }

    /// The node's own buffers: (label, bytes) of its uniform, bounds rows and axis scratch (LG-13).
    pub fn buffers(&self) -> [(&'static str, u64); 3] {
        [("light binning params", self.params.size()), ("light bounds", self.bounds.size()), ("light axis masks", self.axes.size())]
    }

    /// Drop the cached bind group (and the tables it holds).
    pub fn release(&mut self) {
        self.cached = None;
    }

    /// The bind group over `bins`, made when it is not the cached one.
    fn group(&mut self, device: &Device, bins: &Buffer) -> BindGroup {
        if let Some((held, group)) = &self.cached
            && held == bins
        {
            return group.clone();
        }
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("light binning"),
            layout: &self.layout,
            entries: &[
                entry(PARAMS_BINDING, &self.params),
                entry(BOUNDS_BINDING, &self.bounds),
                entry(BINS_BINDING, bins),
                entry(AXES_BINDING, &self.axes),
            ],
        });
        self.cached = Some((bins.clone(), group.clone()));
        group
    }
}

// ---------------------------------------------------------------------------------------------
// The build on supplied frames (tests, cost rows)

/// One GPU build read back: `light_bins`' masks and its header with the z-bins, word for word.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LightBinRead {
    /// The masks, tile-major (from [`LIGHT_TILES_OFFSET_WORDS`]).
    pub masks: Vec<u32>,
    /// The header, then every kind's z-bins.
    pub zbins: Vec<u32>,
}

/// A word the tables are filled with before a build, so a word the build skips shows.
const POISON_WORD: u32 = 0xA5A5_A5A5;

/// A readable table of `bytes`, every word [`POISON_WORD`].
fn poisoned_table(gpu: &Gpu, label: &str, bytes: u64) -> Result<Buffer, RenderError> {
    let table = buffer(&gpu.device, label, bytes.max(4), BufferUsages::STORAGE | BufferUsages::COPY_SRC | BufferUsages::COPY_DST)?;
    let words = vec![POISON_WORD; (bytes.max(4) / 4) as usize];
    gpu.queue.write_buffer(&table, 0, bytemuck::cast_slice(&words));
    Ok(table)
}

fn read_words(gpu: &Gpu, table: &Buffer, offset: u64, bytes: u64) -> Result<Vec<u32>, RenderError> {
    let staging = crate::readback::stage_buffer(gpu, table, offset, bytes)?;
    let data = map_read_blocking(gpu, &staging, bytes)?;
    Ok(bytemuck::pod_collect_to_vec(&data[..bytes as usize]))
}

/// The tables [`LightBinNode`] builds for `frames` in order, read back. One node builds them all
/// (a frame of the same table sizes reuses the cached bind group), into tables filled with a
/// poison word first. The way to check the build on the GPU without a frame.
pub fn light_bins_gpu(gpu: &Gpu, frames: &[LightBinFrame]) -> Result<Vec<LightBinRead>, RenderError> {
    let device = &gpu.device;
    let mut node = LightBinNode::new(device)?;
    let mut reads = Vec::with_capacity(frames.len());
    let mut held: Option<(u64, Buffer)> = None;
    for frame in frames {
        let bytes = bins_bytes(&frame.grid);
        if !held.as_ref().is_some_and(|(held, _)| *held == bytes) {
            held = Some((bytes, poisoned_table(gpu, "light bins", bytes)?));
        }
        let (_, bins) = held.as_ref().ok_or_else(|| capture_failed("light bins: no table"))?;
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("light binning") });
        node.encode(device, &gpu.queue, &mut encoder, LightBinInput { frame, bins })?;
        gpu.queue.submit([encoder.finish()]);
        let masks = read_words(gpu, bins, u64::from(LIGHT_TILES_OFFSET_WORDS) * 4, frame.grid.mask_bytes())?;
        reads.push(LightBinRead { masks, zbins: read_words(gpu, bins, 0, zbin_bytes())? });
    }
    Ok(reads)
}

/// The GPU milliseconds of one build of `frame`, one per sample of `samples`, from timestamps
/// around its passes; None without `TIMESTAMP_QUERY`. Each sample records
/// [`COST_BUILDS_PER_SAMPLE`] builds back to back in one submission and reports their mean. The
/// binning cost row (RQ6.1: 1024 lights at 1080p <= 0.2 ms).
pub fn light_bin_gpu_ms(gpu: &Gpu, frame: &LightBinFrame, samples: u32) -> Result<Option<Vec<f32>>, RenderError> {
    let device = &gpu.device;
    if !device.features().contains(wgpu::Features::TIMESTAMP_QUERY) {
        return Ok(None);
    }
    let bins = poisoned_table(gpu, "light bins", bins_bytes(&frame.grid))?;
    let mut node = LightBinNode::new(device)?;
    let query_set = device.create_query_set(&wgpu::QuerySetDescriptor { label: Some("light binning cost"), ty: wgpu::QueryType::Timestamp, count: 2 });
    let resolve = buffer(device, "light binning cost resolve", 16, BufferUsages::QUERY_RESOLVE | BufferUsages::COPY_SRC)?;
    let period = gpu.queue.get_timestamp_period();
    let mut costs = Vec::with_capacity(samples as usize);
    for _ in 0..samples {
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("light binning cost") });
        for build in 0..COST_BUILDS_PER_SAMPLE {
            let (first, last) = (build == 0, build + 1 == COST_BUILDS_PER_SAMPLE);
            let stamps = (first || last).then_some(wgpu::ComputePassTimestampWrites {
                query_set: &query_set,
                beginning_of_pass_write_index: first.then_some(0),
                end_of_pass_write_index: last.then_some(1),
            });
            node.encode_timed(device, &gpu.queue, &mut encoder, LightBinInput { frame, bins: &bins }, stamps)?;
        }
        gpu.queue.submit([encoder.finish()]);
        // Resolved in a later submission: Metal resolves counter samples without waiting for the
        // passes that write them (timing.rs).
        device.poll(wgpu::PollType::wait_indefinitely()).map_err(|error| capture_failed(format!("poll: {error}")))?;
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("light binning cost resolve") });
        encoder.resolve_query_set(&query_set, 0..2, &resolve, 0);
        gpu.queue.submit([encoder.finish()]);
        let ticks: Vec<u64> = {
            let staging = crate::readback::stage_buffer(gpu, &resolve, 0, 16)?;
            bytemuck::pod_collect_to_vec(&map_read_blocking(gpu, &staging, 16)?[..16])
        };
        if let Some(ms) = crate::timing::span_ms(ticks[0], ticks[1], period) {
            costs.push(ms / COST_BUILDS_PER_SAMPLE as f32);
        }
    }
    Ok(Some(costs))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::GpuLight;

    fn at(z: f32) -> GpuLocalLight {
        GpuLocalLight { light: GpuLight { position_range: [0.0, 0.0, z, 1.0], color: [1.0; 4] }, ..GpuLocalLight::default() }
    }

    #[test]
    fn zbins_pack_both_indices_and_the_empty_bin_has_no_range() {
        assert_eq!(zbin_range(pack_zbin(3, 900)), Some((3, 900)));
        assert_eq!(zbin_range(pack_zbin(0, 0)), Some((0, 0)));
        assert_eq!(zbin_range(ZBIN_EMPTY), None);
        assert_eq!(zbin_range(BOUNDS_EMPTY[2]), None);
        // Pass 2 A.0 (LG-16) flipped 8 -> 16 header words and (8 + 64) * 4 -> (16 + 3 * 64) * 4
        // bytes: the kinds' ranges and depth mappings, and z-bins per clusterable kind.
        assert_eq!(LIGHT_BIN_HEADER_WORDS, 16);
        assert_eq!(zbin_bytes(), (16 + 3 * 64) * 4);
    }

    #[test]
    fn the_grid_has_one_mask_word_per_32_lights_per_tile_and_never_caps_lights() {
        let grid = LightGrid::new((1920, 1080), 16, 1024);
        assert_eq!((grid.tiles_x, grid.tiles_y, grid.words_per_tile), (120, 68, 32));
        assert_eq!(grid.mask_bytes(), 120 * 68 * 32 * 4);
        assert_eq!(grid.axis_bytes(), (120 + 68) * 32 * 4);
        assert_eq!(LightGrid::new((1, 1), 0, 0), LightGrid { tiles_x: 1, tiles_y: 1, words_per_tile: 1, tile_px: 1 });
        assert_eq!(LightGrid::new((640, 360), 32, 33).words_per_tile, 2);
    }

    #[test]
    fn a_dispatch_past_one_dimension_splits_over_two_and_refuses_past_both() {
        assert_eq!(dispatch_of(0, 65535), Some((1, 1)));
        assert_eq!(dispatch_of(64 * 100, 65535), Some((100, 1)));
        assert_eq!(dispatch_of(64 * 70_000, 65535), Some((65535, 2)));
        assert_eq!(dispatch_of(64 * 70_000 + 1, 65535), Some((65535, 2)));
        assert_eq!(dispatch_of(64 * 9, 4), Some((4, 3)));
        assert_eq!(dispatch_of(64 * 17, 4), None, "more than 4 x 4 groups");
    }

    #[test]
    fn the_header_spells_the_grid_and_the_depth_mapping() {
        let grid = LightGrid::new((640, 360), 32, 40);
        let params = grid.params(40, 0.5, 64.5);
        assert_eq!(params.grid, [20, 12, 2, 32]);
        assert_eq!(params.depth[..2], [LIGHT_ZBINS, 40]);
        assert_eq!((f32::from_bits(params.depth[2]), f32::from_bits(params.depth[3])), (0.5, 1.0));
        assert_eq!(f32::from_bits(grid.params(0, 1.0, 1.0).depth[3]), 0.0, "an empty range maps every depth to bin 0");
    }

    #[test]
    fn a_depth_maps_to_its_slice_and_outside_the_range_to_the_nearest_end_bin() {
        let params = LightGrid::new((640, 360), 32, 40).params(40, 0.5, 64.5);
        assert_eq!([0.5, 1.49, 1.5, 64.4].map(|depth| zbin_of(&params, depth)), [0, 0, 1, 63]);
        assert_eq!([-3.0, 0.0, 99.0, f32::INFINITY, f32::NAN].map(|depth| zbin_of(&params, depth)), [0, 0, 63, 63, 0]);
        let flat = LightGrid::new((640, 360), 32, 40).params(40, 1.0, 1.0);
        assert_eq!([0.0, 1.0, f32::INFINITY].map(|depth| zbin_of(&flat, depth)), [0, 0, 0], "an empty range has one bin");
    }

    /// The radiance light `row` contributes after the cap's fade (0 when the cap drops it).
    fn kept_weight(lights: &[GpuLocalLight], eye: [f32; 3], cap: usize, row: u32) -> f32 {
        if !binned_order(lights, eye, [0.0, 0.0, -1.0], cap).contains(&row) {
            return 0.0;
        }
        cap_fade(lights, eye, cap).iter().find(|(faded, _)| *faded == row).map_or(1.0, |(_, weight)| *weight)
    }

    #[test]
    fn a_light_crossing_the_cap_fades_instead_of_popping() {
        // Twenty lights in a row along +x, 1 unit apart, range 0.25; the camera walks along x, so
        // light 0 goes from kept to dropped by a cap of 10.
        let lights: Vec<GpuLocalLight> = (0..20)
            .map(|i| GpuLocalLight { light: GpuLight { position_range: [i as f32, 0.0, 0.0, 0.25], color: [1.0; 4] }, ext: crate::layout::GpuLightExt::POINT })
            .collect();
        let mut last = kept_weight(&lights, [0.0, 0.0, 0.0], 10, 0);
        assert_eq!(last, 1.0, "the nearest light is whole");
        let mut steps = 0;
        for step in 1..=400 {
            let eye = [step as f32 * 0.025, 0.0, 0.0];
            let weight = kept_weight(&lights, eye, 10, 0);
            assert!((weight - last).abs() <= 0.25, "light 0's weight jumps {last} -> {weight} at x = {}", eye[0]);
            steps += usize::from(weight != last);
            last = weight;
        }
        assert_eq!(last, 0.0, "light 0 ends dropped");
        assert!(steps > 4, "it fades over several frames, not one");
        assert!(cap_fade(&lights, [0.0; 3], 20).is_empty(), "under the cap nothing fades");
    }

    #[test]
    fn the_depth_order_is_total_nearest_first_and_ties_keep_row_order() {
        let lights = [at(5.0), at(-1.0), at(5.0), at(f32::INFINITY), at(2.0)];
        let order = depth_order(&lights, [0.0; 3], [0.0, 0.0, 1.0]);
        assert_eq!(order, [1, 4, 0, 2, 3]);
        assert_eq!(depth_order(&lights, [0.0; 3], [0.0, 0.0, 1.0]), order, "the same order every run");
    }

    fn sphere(z: f32, range: f32) -> GpuLocalLight {
        GpuLocalLight { light: GpuLight { position_range: [0.0, 0.0, z, range], color: [1.0; 4] }, ..GpuLocalLight::default() }
    }

    #[test]
    fn the_preset_cap_drops_the_farthest_lights_and_bins_the_rest_in_depth_order() {
        // Distances from the camera to each light's sphere: 9, 1, 2, 5 (a wide light far away
        // reaches close), 2 (a tie with row 2, kept by row order).
        let lights = [sphere(10.0, 1.0), sphere(-2.0, 1.0), sphere(3.0, 1.0), sphere(50.0, 45.0), sphere(3.0, 1.0)];
        let forward = [0.0, 0.0, 1.0];
        assert_eq!(binned_order(&lights, [0.0; 3], forward, 3), [1, 2, 4]);
        assert_eq!(binned_order(&lights, [0.0; 3], forward, 4), [1, 2, 4, 3], "kept lights are binned in depth order");
        assert_eq!(binned_order(&lights, [0.0; 3], forward, 99), depth_order(&lights, [0.0; 3], forward), "under the cap nothing drops");
        assert!(binned_order(&lights, [0.0; 3], forward, 0).is_empty());
        assert_eq!(binned_order(&lights, [0.0; 3], forward, 3), binned_order(&lights, [0.0; 3], forward, 3), "the same lights every run");
    }

    #[test]
    fn hostile_light_rows_never_break_the_cap_order() {
        let lights = [sphere(f32::NAN, 1.0), sphere(1.0, f32::INFINITY), sphere(2.0, -4.0), sphere(f32::NEG_INFINITY, 1.0)];
        let kept = binned_order(&lights, [0.0; 3], [0.0, 0.0, 1.0], 2);
        assert_eq!(kept.len(), 2);
        assert_eq!(kept, binned_order(&lights, [0.0; 3], [0.0, 0.0, 1.0], 2));
        assert!(kept.contains(&1), "an infinite range reaches the camera: nearest");
    }

    #[test]
    fn a_narrow_spot_is_bounded_by_a_sphere_smaller_than_its_range_holding_apex_rim_and_tip() {
        use crate::layout::GpuLightExt;
        for cos_outer in [0.95f32, 0.8, core::f32::consts::FRAC_1_SQRT_2, 0.5, 0.05] {
            let ext = GpuLightExt { spot: [0.0, -2.0, 0.0, cos_outer], params: [1.0, LIGHT_KIND_SPOT, -1.0, 0.0] };
            let light = GpuLocalLight { light: GpuLight { position_range: [1.0, 5.0, 0.0, 4.0], color: [1.0; 4] }, ext };
            let (centre, radius) = bounding_sphere(&light).expect("a light");
            assert!(radius <= 4.0, "cos {cos_outer}: never wider than the range sphere");
            let sin = (1.0 - cos_outer * cos_outer).sqrt();
            let apex = Vec3::new(1.0, 5.0, 0.0);
            let points = [apex, apex + Vec3::new(0.0, -4.0, 0.0), apex + Vec3::new(4.0 * sin, -4.0 * cos_outer, 0.0), apex + Vec3::new(0.0, -4.0 * cos_outer, -4.0 * sin)];
            for point in points {
                assert!(point.distance(centre) <= radius * (1.0 + 1e-5), "cos {cos_outer}: {point} outside {centre} r {radius}");
            }
        }
        assert_eq!(bounding_sphere(&sphere(2.0, -4.0)), None);
        assert_eq!(bounding_sphere(&sphere(f32::NAN, 1.0)), None);
        assert_eq!(bounding_sphere(&sphere(1.0, f32::INFINITY)), Some((Vec3::new(0.0, 0.0, 1.0), f32::INFINITY)));
    }
}
