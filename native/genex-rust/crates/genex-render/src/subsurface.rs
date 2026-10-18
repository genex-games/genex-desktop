//! Per-pixel subsurface scattering and diffuse transmission (renderer pass 2 B.1, prior-art B4a): the
//! light a translucent surface lets through. Wax glows past its terminator, skin scatters red into
//! its shadow side, a thin leaf shines when the sun is behind it.
//!
//! A material carries a [`Subsurface`] ([`crate::pbr::Material::with_subsurface`]). Its parameters
//! ride in the material-extension row next to the emission (`GxMaterialExt.subsurface` and
//! `.transmission`, [`Subsurface::rows`]), so the chunk adds no binding. The shading is the
//! lighting chunk `shaders/lighting/subsurface.wgsl`, after the sun's direct light:
//!
//! - **Scattering** after Filament v1.77.3 `surface_shading_model_subsurface.fs` (Apache-2.0): a
//!   wrapped back-scatter lobe (`saturate(N.L t + 1 - t) / 2`) mixed toward a forward-scatter lobe
//!   about the view-to-light axis (`exp2(V.-L p - p)`), times `1 - t`, in the subsurface colour.
//! - **Diffuse transmission** after Bevy v0.20 `pbr_functions.wesl` (MIT OR Apache-2.0): a second
//!   Lambert lobe about the back of the surface, in the base colour.
//! - **One shadow fetch**: both lobes are lit by the light that reaches the surface *through* the
//!   material, not by the front face's shadow test (which a back-lit face always fails). One
//!   point-sampled gather of the sun's cascade at the fragment gives how far, along the light, the
//!   nearest caster lies in front of it; that distance through the material is attenuated as
//!   `exp(-distance / depth)` (a translucent shadow map's thickness). A thin leaf lets its whole
//!   back-light through; a thick candle only the rim near its terminator; another leaf in front
//!   (a real caster farther away) darkens it.
//!
//! The chunk runs only for a material whose row has [`crate::layout::MATERIAL_EXT_FLAG_SUBSURFACE`]
//! (a draw-uniform branch); every other material shades exactly as before, byte for byte.

/// How a material lets light through. Every field is held finite and in range when it is written
/// into the extension row ([`Subsurface::rows`]).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Subsurface {
    /// The colour of the light scattered inside it, linear rgb `0..=1` (Filament's
    /// `subsurfaceColor`): warm orange for wax, deep red for skin. Black scatters nothing.
    pub color: [f32; 3],
    /// How thick it is to the scattered light, `0..=1` (Filament's `thickness`): 0 scatters the
    /// most and wraps light all the way round, 1 scatters nothing.
    pub thickness: f32,
    /// How tightly the forward scatter gathers about the line toward the light (Filament's
    /// `subsurfacePower`, 12.234 by default): higher is a smaller, brighter halo.
    pub power: f32,
    /// The share of the base colour's diffuse light let through to the far side, `0..=1`
    /// (`KHR_materials_diffuse_transmission`'s factor; Bevy's `diffuse_transmission`): leaves 0.5
    /// to 0.8, wax and skin about 0.
    pub transmission: f32,
    /// How far light travels through it before falling to 1/e, world units (> 0): the scale the
    /// shadow fetch's distance through the material is measured in. A leaf's few millimetres,
    /// a candle's centimetre.
    pub depth: f32,
}

/// Filament's default `subsurfacePower`.
pub const DEFAULT_SUBSURFACE_POWER: f32 = 12.234;
/// The least scattering depth a row holds, world units (a zero would divide by zero).
pub const MIN_SUBSURFACE_DEPTH: f32 = 1e-4;
/// The largest forward-scatter power a row holds (`exp2` stays finite and the lobe a pixel wide).
pub const MAX_SUBSURFACE_POWER: f32 = 64.0;

impl Subsurface {
    /// Candle wax: warm orange scatter, a soft terminator, a centimetre of depth.
    pub const WAX: Subsurface = Subsurface { color: [0.85, 0.45, 0.16], thickness: 0.35, power: 6.0, transmission: 0.0, depth: 0.012 };
    /// Skin: deep red scatter close under the surface.
    pub const SKIN: Subsurface = Subsurface { color: [0.55, 0.12, 0.06], thickness: 0.6, power: 8.0, transmission: 0.0, depth: 0.004 };
    /// A thin leaf: most of its diffuse light passes through, gathered toward the sun.
    pub const LEAF: Subsurface = Subsurface { color: [0.18, 0.32, 0.04], thickness: 0.15, power: DEFAULT_SUBSURFACE_POWER, transmission: 0.6, depth: 0.003 };

    /// Scattering of `color` (linear rgb) at `thickness`, Filament's default power, no diffuse
    /// transmission, a centimetre of depth.
    pub fn new(color: [f32; 3], thickness: f32) -> Subsurface {
        Subsurface { color, thickness, power: DEFAULT_SUBSURFACE_POWER, transmission: 0.0, depth: 0.01 }
    }

    /// This scattering with `share` of the diffuse light let through to the far side.
    pub fn with_transmission(self, share: f32) -> Subsurface {
        Subsurface { transmission: share, ..self }
    }

    /// This scattering with another forward-scatter power.
    pub fn with_power(self, power: f32) -> Subsurface {
        Subsurface { power, ..self }
    }

    /// This scattering measured over another depth (world units).
    pub fn with_depth(self, depth: f32) -> Subsurface {
        Subsurface { depth, ..self }
    }

    /// Its parameters held finite and in range: colour and shares `0..=1` (not finite: 0),
    /// thickness `0..=1` (not finite: 1, scattering nothing), power `0..=MAX_SUBSURFACE_POWER`
    /// (not finite: the default), depth at least [`MIN_SUBSURFACE_DEPTH`] (not finite: the least).
    pub fn sanitized(self) -> Subsurface {
        let unit = |value: f32, otherwise: f32| if value.is_finite() { value.clamp(0.0, 1.0) } else { otherwise };
        Subsurface {
            color: self.color.map(|channel| unit(channel, 0.0)),
            thickness: unit(self.thickness, 1.0),
            power: if self.power.is_finite() { self.power.clamp(0.0, MAX_SUBSURFACE_POWER) } else { DEFAULT_SUBSURFACE_POWER },
            transmission: unit(self.transmission, 0.0),
            depth: if self.depth.is_finite() { self.depth.max(MIN_SUBSURFACE_DEPTH) } else { MIN_SUBSURFACE_DEPTH },
        }
    }

    /// Whether it lets any light through once sanitized: some scatter colour below full thickness,
    /// or some diffuse transmission.
    pub fn is_visible(self) -> bool {
        let s = self.sanitized();
        let scatters = s.thickness < 1.0 && s.color.iter().any(|channel| *channel > 0.0);
        scatters || s.transmission > 0.0
    }

    /// The extension row's two vectors, sanitized: `subsurface` (rgb the scatter colour, a the
    /// thickness) and `transmission` (x the power, y the diffuse transmission, z the depth, w 0).
    pub fn rows(self) -> ([f32; 4], [f32; 4]) {
        let s = self.sanitized();
        let [r, g, b] = s.color;
        ([r, g, b, s.thickness], [s.power, s.transmission, s.depth, 0.0])
    }

    /// The bits that tell two scatterings apart (the material-table key).
    pub(crate) fn key(self) -> [u32; 7] {
        let s = self.sanitized();
        let [r, g, b] = s.color.map(f32::to_bits);
        [r, g, b, s.thickness.to_bits(), s.power.to_bits(), s.transmission.to_bits(), s.depth.to_bits()]
    }
}
