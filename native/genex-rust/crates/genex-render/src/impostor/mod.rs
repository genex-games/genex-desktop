//! Octahedral impostors: the frame mapping, the atlas layout and the class table, the bake and the draw.
//!
//! A port of kansei's impostors (Siroko/kansei `impostors/{mod,bake}.rs` and `impostor*.wgsl`, MIT,
//! Felix Martinez 2024; cross-checked against the three.js octahedral impostors, MIT). An impostor
//! is an object baked orthographically from the N x N directions of an octahedral grid (the whole
//! sphere, [`ImpostorLayout::Sphere`]) or a hemi-octahedral one (the upper hemisphere at twice the
//! density, [`ImpostorLayout::Hemi`], for trees, bushes and buildings), into three RGBA8 atlases of
//! N x N frames, one array layer per species ([`bake`]); far away it draws as a camera-facing quad
//! that blends the three frames nearest the view direction ([`draw`]).
//!
//! This module is the CPU half both share: the grid mapping ([`encode`], [`decode`],
//! [`frame_direction`], [`frame_of`]), the bake cameras' axes ([`frame_axes`]), the per-class atlas
//! table ([`ImpostorClass`], design-LOD §3.6) and the species cap, which registers the admitted
//! species' atlases in the memory ledger as [`BudgetKind::Impostors`] and refuses the rest
//! ([`admit_species`]): a refused species keeps its coarsest mesh and is listed in `degraded` as
//! `budget`.
//!
//! The mapping is y up; a direction points from the object to the viewer.

pub mod bake;
pub mod draw;

use bytemuck::{Pod, Zeroable};
use glam::{Vec2, Vec3};

use crate::budget::{BudgetKind, BudgetLedger};
use crate::device_class::{DeviceClass, FormFactor, PerformanceTier};
use crate::settings::QualityPreset;

/// Bytes of an RGBA8 texel (every impostor atlas).
const ATLAS_TEXEL_BYTES: u64 = 4;
/// Atlases per species: base colour and coverage; normal, depth and roughness; occlusion, metallic,
/// transmission and class.
pub const ATLASES_PER_SPECIES: u64 = 3;
/// Above this |y| a frame's up reference is z (looking straight down or up has no y up).
const VERTICAL_DOT: f32 = 0.999;
/// The hemi layout's horizon guard: a direction at or below it divides by its own xz length.
const HEMI_FOLD_EPSILON: f32 = 1e-12;
/// The ledger label prefix of a species' atlases.
const LEDGER_PREFIX: &str = "impostor/";
/// The smallest radius a bake uses (a point object still gets a frame).
const RADIUS_MIN: f32 = 1e-6;

/// Which directions an impostor's frames are baked from.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum ImpostorLayout {
    /// The upper hemisphere only, at twice the frames' density there: for things seen from the
    /// side and above (trees, bushes, buildings). The default.
    #[default]
    Hemi,
    /// The whole sphere: for things seen from below too.
    Sphere,
}

impl ImpostorLayout {
    fn hemi(self) -> bool {
        self == ImpostorLayout::Hemi
    }
}

fn signs(v: Vec2) -> Vec2 {
    Vec2::new(if v.x >= 0.0 { 1.0 } else { -1.0 }, if v.y >= 0.0 { 1.0 } else { -1.0 })
}

/// The grid position ([-1, 1] squared) of direction `dir` (kansei `encode`). Under the hemi layout
/// a direction below the horizon lands on the horizon.
pub fn encode(dir: [f32; 3], layout: ImpostorLayout) -> [f32; 2] {
    let d = Vec3::from(dir);
    let v = d / (d.x.abs() + d.y.abs() + d.z.abs());
    if layout.hemi() {
        let fold = if v.y > 0.0 { 1.0 } else { HEMI_FOLD_EPSILON };
        let h = Vec2::new(v.x, v.z) / (v.x.abs() + v.z.abs()).max(fold);
        return [h.x + h.y, h.x - h.y];
    }
    if v.y >= 0.0 {
        return [v.x, v.z];
    }
    let folded = (Vec2::ONE - Vec2::new(v.z, v.x).abs()) * signs(Vec2::new(v.x, v.z));
    [folded.x, folded.y]
}

/// The unit direction at grid position `grid` (kansei `decode`).
pub fn decode(grid: [f32; 2], layout: ImpostorLayout) -> [f32; 3] {
    let g = Vec2::from(grid);
    if layout.hemi() {
        let (x, z) = ((g.x + g.y) * 0.5, (g.x - g.y) * 0.5);
        return Vec3::new(x, 1.0 - x.abs() - z.abs(), z).normalize().to_array();
    }
    let y = 1.0 - g.x.abs() - g.y.abs();
    if y < 0.0 {
        let xz = (Vec2::ONE - Vec2::new(g.y, g.x).abs()) * signs(g);
        return Vec3::new(xz.x, y, xz.y).normalize().to_array();
    }
    Vec3::new(g.x, y, g.y).normalize().to_array()
}

/// The direction frame (`column`, `row`) of a `frames` x `frames` grid is baked from: its cell's
/// centre, decoded.
pub fn frame_direction(frames: u32, layout: ImpostorLayout, column: u32, row: u32) -> [f32; 3] {
    let cell = (Vec2::new(column as f32, row as f32) + 0.5) / frames as f32 * 2.0 - 1.0;
    decode(cell.to_array(), layout)
}

/// The frame (`column`, `row`) whose cell holds direction `dir`.
pub fn frame_of(dir: [f32; 3], frames: u32, layout: ImpostorLayout) -> (u32, u32) {
    let g = encode(dir, layout);
    let last = frames.saturating_sub(1);
    let cell = |at: f32| (((at + 1.0) * 0.5 * frames as f32).floor().max(0.0) as u32).min(last);
    (cell(g[0]), cell(g[1]))
}

/// A bake camera's axes in object space: x `right`, y `up`, and `dir` towards the viewer
/// (`look_at_mat4` from `dir` with `up_reference` gives exactly these).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FrameAxes {
    /// The camera's x.
    pub right: [f32; 3],
    /// The camera's y.
    pub up: [f32; 3],
    /// The camera's z: from the object to the viewer.
    pub dir: [f32; 3],
    /// The up vector the camera is built with: y, or z looking straight down or up.
    pub up_reference: [f32; 3],
}

/// The axes of the frame baked from `dir` (kansei `up_reference` and `kansei_impostor_basis`).
pub fn frame_axes(dir: [f32; 3]) -> FrameAxes {
    let d = Vec3::from(dir);
    let reference = if d.y.abs() > VERTICAL_DOT { Vec3::Z } else { Vec3::Y };
    let right = reference.cross(d).normalize();
    let up = d.cross(right);
    FrameAxes { right: right.to_array(), up: up.to_array(), dir, up_reference: reference.to_array() }
}

/// An object's bounds, object space: the frames are baked round the sphere through the box's
/// corners (or round the farthest vertex), and the quad covers the box's outline.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ImpostorBounds {
    /// The box's centre.
    pub center: [f32; 3],
    /// The radius of the sphere the frames are baked round.
    pub radius: f32,
    /// The box's half size.
    pub extent: [f32; 3],
}

impl ImpostorBounds {
    /// The bounds round `points` (kansei `bounds`): the box's centre, the farthest point's distance
    /// from it and the box's half size; None without points.
    pub fn of_points(points: impl Iterator<Item = [f32; 3]> + Clone) -> Option<ImpostorBounds> {
        let (lo, hi) = points.clone().fold((Vec3::splat(f32::MAX), Vec3::splat(f32::MIN)), |(lo, hi), p| (lo.min(p.into()), hi.max(p.into())));
        if lo.x > hi.x {
            return None;
        }
        let center = (lo + hi) * 0.5;
        let radius = points.map(|p| Vec3::from(p).distance(center)).fold(0.0f32, f32::max);
        Some(ImpostorBounds { center: center.to_array(), radius: radius.max(RADIUS_MIN), extent: ((hi - lo) * 0.5).to_array() })
    }

    /// The bounds round `spheres` (centre, radius: the parts' bounding spheres): the box round
    /// them, and the sphere from its centre through the farthest of them; None without spheres.
    pub fn of_spheres(spheres: impl Iterator<Item = ([f32; 3], f32)> + Clone) -> Option<ImpostorBounds> {
        let (lo, hi) = spheres.clone().fold((Vec3::splat(f32::MAX), Vec3::splat(f32::MIN)), |(lo, hi), (c, r)| (lo.min(Vec3::from(c) - r), hi.max(Vec3::from(c) + r)));
        if lo.x > hi.x {
            return None;
        }
        let center = (lo + hi) * 0.5;
        let radius = spheres.map(|(c, r)| Vec3::from(c).distance(center) + r).fold(0.0f32, f32::max);
        Some(ImpostorBounds { center: center.to_array(), radius: radius.max(RADIUS_MIN), extent: ((hi - lo) * 0.5).to_array() })
    }
}

/// A row of the per-class atlas table (design-LOD §3.6): which bake sizes a device class takes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ImpostorClass {
    /// Desktop ultra: 12 x 12 frames of 96 px.
    Ultra,
    /// Desktop high: 10 x 10 of 64 px.
    High,
    /// Desktop mid and the web's medium: 8 x 8 of 64 px.
    Mid,
    /// Desktop low and mobile high: 8 x 8 of 48 px, no depth parallax.
    Low,
    /// Mobile mid and low: 8 x 8 of 32 px, no depth parallax.
    Mobile,
}

/// What an [`ImpostorClass`] bakes and holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ImpostorSpec {
    /// Frames per side of the atlases (N x N views).
    pub frames: u32,
    /// Texels per side of a frame.
    pub frame_px: u32,
    /// The default layout (a model may ask for the sphere).
    pub layout: ImpostorLayout,
    /// Whether the draw takes a parallax step from the depth (off on the phone sizes).
    pub depth_parallax: bool,
    /// Species whose atlases are held at once; past it a species keeps its coarsest mesh.
    pub species_cap: u32,
}

impl ImpostorSpec {
    /// The atlases' side in texels.
    pub const fn atlas_side(&self) -> u32 {
        self.frames * self.frame_px
    }

    /// The atlases' mip levels: halving while a frame's side stays even, so a 2 x 2 block never
    /// straddles two frames (down to a texel per frame for a power-of-two frame size).
    pub const fn mip_levels(&self) -> u32 {
        self.frame_px.trailing_zeros() + 1
    }

    /// One atlas's bytes for one species, its mips included.
    pub fn atlas_bytes(&self) -> u64 {
        let side = u64::from(self.atlas_side());
        (0..self.mip_levels()).map(|level| (side >> level) * (side >> level) * ATLAS_TEXEL_BYTES).sum()
    }

    /// A species' bytes: its three atlases.
    pub fn species_bytes(&self) -> u64 {
        ATLASES_PER_SPECIES * self.atlas_bytes()
    }

    /// The bytes held at the species cap.
    pub fn cap_bytes(&self) -> u64 {
        u64::from(self.species_cap) * self.species_bytes()
    }
}

impl ImpostorClass {
    /// Every row, largest first.
    pub const ALL: [ImpostorClass; 5] = [ImpostorClass::Ultra, ImpostorClass::High, ImpostorClass::Mid, ImpostorClass::Low, ImpostorClass::Mobile];

    /// The row's bake sizes and cap.
    pub const fn spec(self) -> ImpostorSpec {
        let (frames, frame_px, depth_parallax, species_cap) = match self {
            ImpostorClass::Ultra => (12, 96, true, 8),
            ImpostorClass::High => (10, 64, true, 12),
            ImpostorClass::Mid => (8, 64, true, 12),
            ImpostorClass::Low => (8, 48, false, 8),
            ImpostorClass::Mobile => (8, 32, false, 6),
        };
        ImpostorSpec { frames, frame_px, layout: ImpostorLayout::Hemi, depth_parallax, species_cap }
    }
}

/// The row of the atlas table `preset` takes on `class`: desktops by preset (ultra, high, medium as
/// mid, low); phones at the low row on a high or ultra tier from the medium preset up, else the
/// mobile row. The web takes its form factor's rows.
pub fn impostor_class(preset: QualityPreset, class: DeviceClass) -> ImpostorClass {
    if class.form == FormFactor::Mobile {
        let capable = matches!(class.tier, PerformanceTier::High | PerformanceTier::Ultra) && preset != QualityPreset::Low;
        return if capable { ImpostorClass::Low } else { ImpostorClass::Mobile };
    }
    match preset {
        QualityPreset::Ultra => ImpostorClass::Ultra,
        QualityPreset::High => ImpostorClass::High,
        QualityPreset::Medium => ImpostorClass::Mid,
        _ => ImpostorClass::Low,
    }
}

/// Why a species draws no impostor (listed in `degraded`).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ImpostorRefusal {
    /// Past the class's species cap: it keeps its coarsest mesh.
    Budget,
}

impl ImpostorRefusal {
    /// The wire spelling (the `degraded` reason).
    pub const fn wire(self) -> &'static str {
        match self {
            ImpostorRefusal::Budget => "budget",
        }
    }
}

/// Which species hold atlases, and which were refused and why.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ImpostorAdmission {
    /// Species with atlases, in declaration order.
    pub admitted: Vec<String>,
    /// Species without, in declaration order.
    pub refused: Vec<(String, ImpostorRefusal)>,
}

/// Admit `species` (in declaration order) up to `class`'s cap: each admitted species's atlases are
/// registered in `ledger` as [`BudgetKind::Impostors`] (`impostor/<name>`, replacing an earlier
/// entry of the same name); the rest are refused [`ImpostorRefusal::Budget`].
pub fn admit_species<S: AsRef<str>>(class: ImpostorClass, species: &[S], ledger: &mut BudgetLedger) -> ImpostorAdmission {
    let spec = class.spec();
    let held = (spec.species_cap as usize).min(species.len());
    let (admitted, refused) = species.split_at(held);
    for name in admitted {
        ledger.register(BudgetKind::Impostors, &format!("{LEDGER_PREFIX}{}", name.as_ref()), spec.species_bytes());
    }
    ImpostorAdmission {
        admitted: admitted.iter().map(|name| name.as_ref().to_owned()).collect(),
        refused: refused.iter().map(|name| (name.as_ref().to_owned(), ImpostorRefusal::Budget)).collect(),
    }
}

/// `GxImpostor` in the impostor shaders: one baked species, as the draw reads it (48 bytes).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuImpostor {
    /// The bounds' centre, object space.
    pub center: [f32; 3],
    /// The bake sphere's radius.
    pub radius: f32,
    /// The box's half size.
    pub extent: [f32; 3],
    /// Frames per side.
    pub frames: u32,
    /// 1 for the hemi layout.
    pub hemi: u32,
    /// Texels per frame side.
    pub frame_px: u32,
    /// The species' layer in the atlas arrays.
    pub layer: u32,
    /// The atlases' mip levels.
    pub mip_levels: u32,
}

impl GpuImpostor {
    /// The row of a species baked at `spec` with `layout` round `bounds` into array layer `layer`.
    pub fn new(spec: &ImpostorSpec, layout: ImpostorLayout, bounds: &ImpostorBounds, layer: u32) -> GpuImpostor {
        GpuImpostor {
            center: bounds.center,
            radius: bounds.radius,
            extent: bounds.extent,
            frames: spec.frames,
            hemi: u32::from(layout.hemi()),
            frame_px: spec.frame_px,
            layer,
            mip_levels: spec.mip_levels(),
        }
    }
}
