//! What a draw hook writes: a [`Frame`] of tagged, counted draws the renderer (M0a.4) consumes.
//! The tagged draw counter counts logical draws before any GPU culling, so `drawCalls` and
//! `__render.tags` never depend on the GPU. Level-2 draws (a mesh with a custom material, a post
//! pass) are kept beside the shapes and counted the same way: one logical draw each.
//!
//! A frame also declares its lights ([`Frame::sun`], [`Frame::ambient`], [`Frame::point_light`],
//! [`Frame::spot_light`]) and its environment ([`Frame::environment`]: the flat colour, the physical sky or an HDR map);
//! neither is a draw, and a frame that declares none is lit as every frame was before them.
//! A model or shape draw may name a metallic-roughness [`Material`], which may glow
//! ([`Material::emissive`]); one that names none keeps [`Material::default`] (a model keeps the
//! materials its GLB names).
//!
//! Temporal effects (TAA, motion vectors) need two more facts a frame states, neither of them a
//! draw: which later draws are the same object as last frame's ([`Frame::id`], scoped like
//! [`Frame::tag`] until [`Frame::end_id`]), and when the shot changes ([`Frame::camera_cut`]).

use std::sync::Arc;

use crate::Map;
use crate::extend::{CustomMaterial, PostPass};
use crate::gfx::Model;
use genex_render::motion::DrawId;
use genex_render::settings::Environment;
use glam::{Mat4, Quat, Vec3};

/// Metallic factor of [`Material::default`]: a dielectric.
pub const DEFAULT_METALLIC: f32 = 0.0;
/// Roughness of [`Material::default`]: the surface every draw had before materials.
pub const DEFAULT_ROUGHNESS: f32 = 0.55;

/// The half-angle, in degrees, inside which a spot light shines at full strength unless its cone is
/// set ([`SpotLight::with_cone_degrees`]).
pub const DEFAULT_SPOT_INNER_DEGREES: f32 = 20.0;
/// The half-angle, in degrees, past which a spot light is dark unless its cone is set.
pub const DEFAULT_SPOT_OUTER_DEGREES: f32 = 30.0;

/// The tag draws carry before a draw hook names one.
pub const DEFAULT_TAG: &str = "world";

/// An sRGB colour with straight alpha, 8 bits per channel.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Color {
    /// Red.
    pub r: u8,
    /// Green.
    pub g: u8,
    /// Blue.
    pub b: u8,
    /// Alpha (255 is opaque).
    pub a: u8,
}

impl Color {
    /// Opaque white.
    pub const WHITE: Color = Color::rgb(255, 255, 255);
    /// Opaque black.
    pub const BLACK: Color = Color::rgb(0, 0, 0);
    /// Opaque red.
    pub const RED: Color = Color::rgb(230, 41, 55);
    /// Opaque green.
    pub const GREEN: Color = Color::rgb(0, 228, 48);
    /// Opaque blue.
    pub const BLUE: Color = Color::rgb(0, 121, 241);
    /// The missing-asset magenta.
    pub const MAGENTA: Color = Color::rgb(255, 0, 255);
    /// The default background, as the C++ template's.
    pub const BACKGROUND: Color = Color::rgb(18, 20, 28);

    /// An opaque colour.
    pub const fn rgb(r: u8, g: u8, b: u8) -> Color {
        Color { r, g, b, a: 255 }
    }

    /// A colour with alpha.
    pub const fn rgba(r: u8, g: u8, b: u8, a: u8) -> Color {
        Color { r, g, b, a }
    }

    /// The channels as sRGB floats in `[0, 1]`, for a GPU-facing `[f32; 4]`.
    pub fn to_array(self) -> [f32; 4] {
        [self.r, self.g, self.b, self.a].map(|c| f32::from(c) / 255.0)
    }
}

/// Translation, rotation and scale.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Transform {
    /// Position.
    pub translation: Vec3,
    /// Orientation.
    pub rotation: Quat,
    /// Per-axis scale.
    pub scale: Vec3,
}

impl Transform {
    /// No translation, rotation or scale.
    pub const IDENTITY: Transform = Transform { translation: Vec3::ZERO, rotation: Quat::IDENTITY, scale: Vec3::ONE };

    /// A transform that only moves.
    pub const fn from_translation(translation: Vec3) -> Transform {
        Transform { translation, ..Transform::IDENTITY }
    }

    /// A transform that only moves, by components.
    pub const fn from_xyz(x: f32, y: f32, z: f32) -> Transform {
        Transform::from_translation(Vec3::new(x, y, z))
    }

    /// This transform with another rotation.
    pub const fn with_rotation(self, rotation: Quat) -> Transform {
        Transform { rotation, ..self }
    }

    /// This transform with another scale.
    pub const fn with_scale(self, scale: Vec3) -> Transform {
        Transform { scale, ..self }
    }

    /// The model matrix.
    pub fn matrix(&self) -> Mat4 {
        Mat4::from_scale_rotation_translation(self.scale, self.rotation, self.translation)
    }

    /// The model matrix as 16 column-major floats: the GPU-facing form (never a glam type, whose
    /// alignment the workspace's scalar-math feature changes).
    pub fn to_cols_array(&self) -> [f32; 16] {
        self.matrix().to_cols_array()
    }
}

impl Default for Transform {
    fn default() -> Self {
        Transform::IDENTITY
    }
}

/// A metallic-roughness surface for a model or shape draw (`frame.model_with`, `cube_with`,
/// `sphere_with`). Textures are named by their path under `assets/` (PNG or JPEG), each loaded
/// once; a missing, unsafe or unreadable one leaves its slot untextured, never the checker.
///
/// ```
/// use genex::prelude::*;
///
/// let bark = Material::color(Color::rgb(120, 80, 50)).with_roughness(0.9).with_base_texture("textures/bark.png");
/// let gold = Material::color(Color::rgb(255, 200, 80)).with_metallic(1.0).with_roughness(0.25);
/// let ember = Material::emissive(Color::rgb(255, 160, 64), 6.0);
/// let mut frame = Frame::default();
/// frame.cube_with(Transform::IDENTITY, &bark).sphere_with(Vec3::Y, 0.5, &gold).sphere_with(Vec3::X, 0.2, &ember);
/// ```
#[derive(Clone, Debug, PartialEq)]
pub struct Material {
    /// sRGB base colour; alpha below 255 draws it blended (sorted back to front).
    pub base_color: Color,
    /// 0 a dielectric, 1 a metal (times the metallic-roughness texture's blue channel).
    pub metallic: f32,
    /// 0 a mirror, 1 fully rough (times the metallic-roughness texture's green channel).
    pub roughness: f32,
    /// How strongly the normal texture tilts the normal.
    pub normal_scale: f32,
    /// sRGB colour it emits (black: none), times `emissive_strength` (and the emissive texture).
    pub emissive: Color,
    /// How bright the emission is, in the units of a light's intensity: white at 1 emits what a
    /// white surface lit to radiance 1 reflects; above 1 it blooms where the device draws bloom.
    pub emissive_strength: f32,
    base_texture: Option<Arc<str>>,
    normal_texture: Option<Arc<str>>,
    metal_rough_texture: Option<Arc<str>>,
    emissive_texture: Option<Arc<str>>,
    untextured_color: Option<Color>,
    subsurface: Option<crate::Subsurface>,
}

impl Default for Material {
    /// White, dielectric, roughness 0.55, untextured, emitting nothing: what every draw had before
    /// materials.
    fn default() -> Self {
        Material {
            base_color: Color::WHITE,
            metallic: DEFAULT_METALLIC,
            roughness: DEFAULT_ROUGHNESS,
            normal_scale: 1.0,
            emissive: Color::BLACK,
            emissive_strength: 1.0,
            base_texture: None,
            normal_texture: None,
            metal_rough_texture: None,
            emissive_texture: None,
            untextured_color: None,
            subsurface: None,
        }
    }
}

impl Material {
    /// [`Material::default`] in `base_color`.
    pub fn color(base_color: Color) -> Material {
        Material { base_color, ..Material::default() }
    }

    /// A surface of `color` that also glows in it at `strength` (a lantern's glass, a lit window, an
    /// ember): [`Material::color`] with [`Material::with_emissive`]. It emits light into the
    /// picture (exposure meters it, bloom spreads it), not onto other surfaces: pair it with a
    /// [`Frame::point_light`] or [`Frame::spot_light`] for that.
    pub fn emissive(color: Color, strength: f32) -> Material {
        Material::color(color).with_emissive(color, strength)
    }

    /// This material emitting `color` at `strength` (a light's intensity units; negative or not
    /// finite emits nothing).
    pub fn with_emissive(self, color: Color, strength: f32) -> Material {
        Material { emissive: color, emissive_strength: strength, ..self }
    }

    /// This material with an emissive texture (`assets/<path>`, sRGB) multiplying its emission
    /// (set it with [`Material::with_emissive`]: black emits nothing whatever the texture).
    pub fn with_emissive_texture(self, path: &str) -> Material {
        Material { emissive_texture: Some(Arc::from(path)), ..self }
    }

    /// This material letting light through (renderer pass 2 B.1): wax glowing past its shadow
    /// line ([`Subsurface::WAX`](crate::Subsurface::WAX)), skin scattering red
    /// ([`Subsurface::SKIN`](crate::Subsurface::SKIN)), a leaf shining with the sun behind it
    /// ([`Subsurface::LEAF`](crate::Subsurface::LEAF)). The light through is shadowed by what lies
    /// between the surface and the sun, so a leaf behind another leaf stays dark.
    pub fn with_subsurface(self, subsurface: crate::Subsurface) -> Material {
        Material { subsurface: Some(subsurface), ..self }
    }

    /// How it lets light through ([`Material::with_subsurface`]); `None` is opaque to light.
    pub fn subsurface(&self) -> Option<crate::Subsurface> {
        self.subsurface
    }

    /// This material with another metallic factor (0..1).
    pub fn with_metallic(self, metallic: f32) -> Material {
        Material { metallic, ..self }
    }

    /// This material with another roughness (0..1).
    pub fn with_roughness(self, roughness: f32) -> Material {
        Material { roughness, ..self }
    }

    /// This material with a base-colour texture (`assets/<path>`, sRGB), times `base_color`.
    pub fn with_base_texture(self, path: &str) -> Material {
        Material { base_texture: Some(Arc::from(path)), ..self }
    }

    /// This material drawing `color` instead of its base colour where its base texture is missing
    /// (not in the game's assets, an unsafe path or refused): a downloaded texture's procedural
    /// stand-in, so the game looks right with and without it. Where the texture loads, the base
    /// colour multiplies it as usual.
    pub fn with_untextured_color(self, color: Color) -> Material {
        Material { untextured_color: Some(color), ..self }
    }

    /// The colour drawn where the base texture is missing ([`Material::with_untextured_color`]).
    pub fn untextured_color(&self) -> Option<Color> {
        self.untextured_color
    }

    /// This material with a tangent-space normal texture (`assets/<path>`) tilting by `scale`.
    pub fn with_normal_texture(self, path: &str, scale: f32) -> Material {
        Material { normal_texture: Some(Arc::from(path)), normal_scale: scale, ..self }
    }

    /// This material with a glTF metallic-roughness texture (`assets/<path>`): green roughness,
    /// blue metallic.
    pub fn with_metal_rough_texture(self, path: &str) -> Material {
        Material { metal_rough_texture: Some(Arc::from(path)), ..self }
    }

    /// The base-colour texture's path.
    pub fn base_texture(&self) -> Option<&str> {
        self.base_texture.as_deref()
    }

    /// The normal texture's path.
    pub fn normal_texture(&self) -> Option<&str> {
        self.normal_texture.as_deref()
    }

    /// The metallic-roughness texture's path.
    pub fn metal_rough_texture(&self) -> Option<&str> {
        self.metal_rough_texture.as_deref()
    }

    /// The emissive texture's path.
    pub fn emissive_texture(&self) -> Option<&str> {
        self.emissive_texture.as_deref()
    }
}

/// The sun: one directional light that casts the frame's shadows.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sun {
    /// Direction towards the sun (any length).
    pub direction: Vec3,
    /// sRGB colour (alpha ignored).
    pub color: Color,
    /// Radiance multiplier (the default sun is 2.5; 0 turns it and its shadows off).
    pub intensity: f32,
}

/// Light from everywhere, so nothing is pitch black.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Ambient {
    /// sRGB colour (alpha ignored).
    pub color: Color,
    /// Multiplier (the default is 0.08).
    pub intensity: f32,
}

/// A light at a point, fading to nothing at its range.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PointLight {
    /// Where it is.
    pub position: Vec3,
    /// The distance at which it fades out.
    pub range: f32,
    /// sRGB colour (alpha ignored).
    pub color: Color,
    /// Radiance multiplier.
    pub intensity: f32,
}

/// A light at a point shining inside a cone (a torch, a street lamp, light through a window): full
/// strength within `inner_angle` of `direction`, fading to dark at `outer_angle`, and with distance
/// to nothing at `range`.
///
/// ```
/// use genex::prelude::*;
/// use genex::render::SpotLight;
///
/// let lamp = SpotLight::new(vec3(0.0, 4.0, 0.0), Vec3::NEG_Y, 8.0, Color::rgb(255, 214, 170), 6.0).with_cone_degrees(25.0, 40.0);
/// let mut frame = Frame::default();
/// frame.spot_light_with(&lamp);
/// assert_eq!(frame.draw_calls(), 0);
/// ```
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SpotLight {
    /// Where it is.
    pub position: Vec3,
    /// The direction it shines in (any length; zero points down).
    pub direction: Vec3,
    /// The distance at which it fades out.
    pub range: f32,
    /// sRGB colour (alpha ignored).
    pub color: Color,
    /// Radiance multiplier.
    pub intensity: f32,
    /// Half-angle in radians inside which it is at full strength (held within `outer_angle`).
    pub inner_angle: f32,
    /// Half-angle in radians past which it is dark (up to 89 degrees).
    pub outer_angle: f32,
    /// Whether it asks for a shadow map: the device's quality decides how many spots get one
    /// (none on low and medium), and a spot without one lights unshadowed.
    pub shadow: bool,
}

impl SpotLight {
    /// A spot at `position` shining along `direction`, fading out at `range`, with the default
    /// cone ([`DEFAULT_SPOT_INNER_DEGREES`] to [`DEFAULT_SPOT_OUTER_DEGREES`]) and no shadow map.
    pub fn new(position: Vec3, direction: Vec3, range: f32, color: Color, intensity: f32) -> SpotLight {
        SpotLight {
            position,
            direction,
            range,
            color,
            intensity,
            inner_angle: degrees(DEFAULT_SPOT_INNER_DEGREES),
            outer_angle: degrees(DEFAULT_SPOT_OUTER_DEGREES),
            shadow: false,
        }
    }

    /// This spot with its cone's half-angles in degrees: full strength within `inner`, dark past
    /// `outer`.
    pub fn with_cone_degrees(self, inner: f32, outer: f32) -> SpotLight {
        SpotLight { inner_angle: degrees(inner), outer_angle: degrees(outer), ..self }
    }

    /// This spot asking for a shadow map, or not.
    pub fn with_shadow(self, shadow: bool) -> SpotLight {
        SpotLight { shadow, ..self }
    }
}

/// `value` degrees in radians.
fn degrees(value: f32) -> f32 {
    value * (core::f32::consts::PI / 180.0)
}

/// The lights a frame declared; what it left out keeps the renderer's default.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Lights {
    /// The sun, when declared (default: from (0.4, 1, 0.3), white, 2.5).
    pub sun: Option<Sun>,
    /// The ambient light, when declared (default: white, 0.08).
    pub ambient: Option<Ambient>,
    /// Point lights in call order (the renderer lights with the first 256).
    pub points: Vec<PointLight>,
    /// Spot lights in call order (lit wherever the frame bins its lights, which every preset does;
    /// with the `clustered` feature switched off only the point lights light the scene). The
    /// preset caps how many local lights a frame lights, nearest first.
    pub spots: Vec<SpotLight>,
    /// Reflection probes in call order (renderer pass 2 A.3): the first the device's quality gives
    /// a cube to reflect their box's own surroundings; the rest reflect the sky.
    pub reflection_probes: Vec<ReflectionProbe>,
    /// Irradiance volumes in call order (renderer pass 2 A.4): the first the device's quality bakes
    /// light their box's surfaces with the scene's own bounced light; the rest take the sky's.
    pub irradiance_volumes: Vec<IrradianceVolume>,
}

/// An irradiance volume: an axis-aligned box of the world (a room, a courtyard, a stretch of
/// street) whose surfaces take their diffuse ambient light from a grid of cells baked in the scene
/// instead of the sky: a white floor beside a sunlit red wall turns pink, and a closed room is not
/// lit by the sky through its walls (a cell behind a wall lends a surface no light). The grid is
/// baked a few cells a frame (again when the sky changes or the box or its cells change), so a
/// volume suits a static room or street; a moving object is not seen in it until a rebake. It
/// lights only scenes the sky or an HDR map lights.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct IrradianceVolume {
    /// The box's least corner.
    pub min: Vec3,
    /// The box's greatest corner.
    pub max: Vec3,
    /// Cells along x, y and z (each 1 to 32, at most 4096 in all; their centres split the box
    /// evenly).
    pub cells: [u32; 3],
    /// How far past the box's faces its light fades into the sky's (0: a hard edge).
    pub blend: f32,
    /// The multiplier of its light (1: as baked).
    pub intensity: f32,
}

impl IrradianceVolume {
    /// A volume over the box `min..max` with a cell about every metre, fading out over a tenth of
    /// its smallest side, at full intensity.
    pub fn new(min: Vec3, max: Vec3) -> IrradianceVolume {
        let cells = genex_render::irradiance::IrradianceVolume::new(min.to_array(), max.to_array()).cells;
        let smallest = (max - min).abs().min_element();
        IrradianceVolume { min, max, cells, blend: 0.1 * smallest, intensity: 1.0 }
    }

    /// The volume with `cells` cells along x, y and z (finer cells follow smaller rooms and thinner
    /// walls; each cell costs six small captures of the scene to bake).
    pub fn with_cells(self, cells: [u32; 3]) -> IrradianceVolume {
        IrradianceVolume { cells, ..self }
    }

    /// The volume fading out over `blend` units past its faces.
    pub fn with_blend(self, blend: f32) -> IrradianceVolume {
        IrradianceVolume { blend, ..self }
    }

    /// The volume's light times `intensity`.
    pub fn with_intensity(self, intensity: f32) -> IrradianceVolume {
        IrradianceVolume { intensity, ..self }
    }
}

/// A reflection probe: an axis-aligned box of the world (a room's inside: its floor, walls and
/// ceiling are the box's faces) whose glossy surfaces reflect a cube captured inside it instead of
/// the sky, seen where the walls stand (box projection) and blended into the sky and the next probe
/// over `blend` units past its faces. The cube is captured from the scene once (again when the sky changes or the probe moves),
/// so a probe suits a static room or street; a moving object is not seen in it until a recapture.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ReflectionProbe {
    /// The box's least corner (the room's floor and walls).
    pub min: Vec3,
    /// The box's greatest corner (its ceiling and walls).
    pub max: Vec3,
    /// Where the cube is captured from (held inside the box).
    pub capture: Vec3,
    /// How far past the box's faces its reflection fades out (0: a hard edge).
    pub blend: f32,
    /// The multiplier of its reflection (1: as captured).
    pub intensity: f32,
}

impl ReflectionProbe {
    /// A probe over the box `min..max`, captured from its centre, fading out over a tenth of its
    /// smallest side, at full intensity.
    pub fn new(min: Vec3, max: Vec3) -> ReflectionProbe {
        let smallest = (max - min).abs().min_element();
        ReflectionProbe { min, max, capture: (min + max) * 0.5, blend: 0.1 * smallest, intensity: 1.0 }
    }

    /// The probe captured from `capture` (a point inside the box with a view of the room: eye
    /// height, away from the walls).
    pub fn with_capture(self, capture: Vec3) -> ReflectionProbe {
        ReflectionProbe { capture, ..self }
    }

    /// The probe fading out over `blend` units past its faces.
    pub fn with_blend(self, blend: f32) -> ReflectionProbe {
        ReflectionProbe { blend, ..self }
    }

    /// The probe's reflection times `intensity`.
    pub fn with_intensity(self, intensity: f32) -> ReflectionProbe {
        ReflectionProbe { intensity, ..self }
    }
}

/// One logical draw, as [`Frame::draws`] reads it back.
///
/// Later tiers add draws and fields, so the enum and each variant are `#[non_exhaustive]` (one
/// named break, RQ1 review): code outside this crate reads a draw with a wildcard arm and `..`,
/// and makes one through [`Frame`]'s builders:
///
/// ```
/// use genex::Shape;
/// fn is_cube(shape: &Shape) -> bool {
///     match shape {
///         Shape::Cube { .. } => true,
///         _ => false,
///     }
/// }
/// ```
#[non_exhaustive]
#[derive(Clone, Debug, PartialEq)]
pub enum Shape {
    /// A model from the game's assets (the magenta checker when it is missing).
    #[non_exhaustive]
    Model {
        /// The model handle.
        model: Model,
        /// Where it goes.
        transform: Transform,
        /// Multiplied into its base colour.
        tint: Color,
        /// Replaces the materials its GLB names; `None` keeps them.
        material: Option<Material>,
    },
    /// A unit cube under a transform.
    #[non_exhaustive]
    Cube {
        /// Where it goes.
        transform: Transform,
        /// Its surface (`frame.cube(.., color)` is [`Material::color`]).
        material: Material,
    },
    /// A sphere.
    #[non_exhaustive]
    Sphere {
        /// Its centre.
        center: Vec3,
        /// Its radius.
        radius: f32,
        /// Its surface (`frame.sphere(.., color)` is [`Material::color`]).
        material: Material,
    },
    /// A line segment.
    #[non_exhaustive]
    Line {
        /// Start.
        from: Vec3,
        /// End.
        to: Vec3,
        /// Its colour.
        color: Color,
    },
    /// A retained instance group: its shape at every transform (renderer pass 2 A.0b).
    #[non_exhaustive]
    Group {
        /// The group.
        group: crate::group::InstanceGroup,
    },
}

/// The mesh a custom material draws: a model from the game's assets, or a built-in shape.
#[derive(Clone, Debug, PartialEq)]
pub enum CustomMesh {
    /// A model (the magenta checker when it is missing).
    Model(Model),
    /// The unit cube.
    Cube,
    /// A sphere of radius 1 (scale the transform for another radius).
    Sphere,
}

impl From<Model> for CustomMesh {
    fn from(model: Model) -> CustomMesh {
        CustomMesh::Model(model)
    }
}

impl From<&Model> for CustomMesh {
    fn from(model: &Model) -> CustomMesh {
        CustomMesh::Model(model.clone())
    }
}

/// One mesh drawn with a custom material (`frame.custom`), under the tag current when drawn.
#[derive(Clone, Debug, PartialEq)]
pub struct CustomDraw {
    /// The tag it counts under.
    pub tag: String,
    /// The draw id current when drawn ([`Frame::id`]), if any.
    pub id: Option<DrawId>,
    /// What it draws.
    pub mesh: CustomMesh,
    /// Where it goes.
    pub transform: Transform,
    /// The material (a refused or missing one draws the checker).
    pub material: CustomMaterial,
    /// sRGB tint the material reads as `in.tint`.
    pub tint: Color,
}

/// One post pass run over the frame (`frame.post_pass`), under the tag current when run.
#[derive(Clone, Debug, PartialEq)]
pub struct PostDraw {
    /// The tag it counts under.
    pub tag: String,
    /// The pass (a refused one is skipped).
    pub pass: PostPass,
}

/// A draw and the tag it counts under.
#[derive(Clone, Debug, PartialEq)]
pub struct Draw {
    /// The tag current when it was drawn.
    pub tag: String,
    /// The draw id current when it was drawn ([`Frame::id`]), if any.
    pub id: Option<DrawId>,
    /// What to draw.
    pub shape: Shape,
}

/// The draws of one rendered frame, in order, with a per-tag count.
#[derive(Clone, Debug, PartialEq)]
pub struct Frame {
    tag: String,
    id: Option<DrawId>,
    camera_cut: bool,
    draws: Vec<Draw>,
    custom: Vec<CustomDraw>,
    posts: Vec<PostDraw>,
    tags: Map<String, u32>,
    clear: Color,
    lights: Lights,
    environment: Option<Environment>,
    terrain: Option<crate::terrain::Terrain>,
    water: Option<crate::water::Water>,
    decals: Vec<crate::decal::Decal>,
    particles: Vec<crate::particles::Particles>,
}

impl Default for Frame {
    fn default() -> Self {
        Frame {
            tag: DEFAULT_TAG.to_owned(),
            id: None,
            camera_cut: false,
            draws: Vec::new(),
            custom: Vec::new(),
            posts: Vec::new(),
            tags: Map::default(),
            clear: Color::BACKGROUND,
            lights: Lights::default(),
            environment: None,
            terrain: None,
            water: None,
            decals: Vec::new(),
            particles: Vec::new(),
        }
    }
}

impl Frame {
    /// A frame cleared to `clear`.
    pub fn new(clear: Color) -> Frame {
        Frame { clear, ..Frame::default() }
    }

    /// Count the following draws under `name` (`state().__render.tags`).
    pub fn tag(&mut self, name: &str) -> &mut Self {
        name.clone_into(&mut self.tag);
        self
    }

    /// Name the following draws `key` across frames until [`Frame::end_id`] or the next id, the
    /// way [`Frame::tag`] scopes tags: a string or an integer that stays the same for one object
    /// from frame to frame (an entity id, `"player"`). Under TAA, a moving object needs one so its
    /// pixels find where they were; unnamed draws fall back to their order within their mesh.
    /// Not a draw, and counted under no tag.
    pub fn id(&mut self, key: impl Into<DrawId>) -> &mut Self {
        self.id = Some(key.into());
        self
    }

    /// End the current [`Frame::id`]: the following draws are unnamed again.
    pub fn end_id(&mut self) -> &mut Self {
        self.id = None;
        self
    }

    /// Start every temporal history over at this frame (a new shot: TAA, auto exposure and AO
    /// forget the previous frames). A camera jump beyond the renderer's thresholds is a cut
    /// without asking. Not a draw.
    pub fn camera_cut(&mut self) -> &mut Self {
        self.camera_cut = true;
        self
    }

    /// Whether this frame asked for a camera cut.
    pub fn is_camera_cut(&self) -> bool {
        self.camera_cut
    }

    /// Draw a model with the materials its GLB names.
    pub fn model(&mut self, model: &Model, transform: Transform) -> &mut Self {
        self.model_tinted(model, transform, Color::WHITE)
    }

    /// Draw a model with a tint multiplied into its GLB's base colours.
    pub fn model_tinted(&mut self, model: &Model, transform: Transform, tint: Color) -> &mut Self {
        self.push(Shape::Model { model: model.clone(), transform, tint, material: None })
    }

    /// Draw a model with `material` instead of the materials its GLB names.
    pub fn model_with(&mut self, model: &Model, transform: Transform, material: &Material) -> &mut Self {
        self.push(Shape::Model { model: model.clone(), transform, tint: Color::WHITE, material: Some(material.clone()) })
    }

    /// Draw a unit cube under `transform`.
    pub fn cube(&mut self, transform: Transform, color: Color) -> &mut Self {
        self.push(Shape::Cube { transform, material: Material::color(color) })
    }

    /// Draw a unit cube under `transform` with `material`.
    pub fn cube_with(&mut self, transform: Transform, material: &Material) -> &mut Self {
        self.push(Shape::Cube { transform, material: material.clone() })
    }

    /// Draw a sphere.
    pub fn sphere(&mut self, center: Vec3, radius: f32, color: Color) -> &mut Self {
        self.push(Shape::Sphere { center, radius, material: Material::color(color) })
    }

    /// Draw a sphere with `material`.
    pub fn sphere_with(&mut self, center: Vec3, radius: f32, material: &Material) -> &mut Self {
        self.push(Shape::Sphere { center, radius, material: material.clone() })
    }

    /// Draw a retained instance group ([`crate::InstanceGroup`]): its shape at every transform,
    /// one logical draw. Its rows are computed and uploaded once, not every frame.
    pub fn group(&mut self, group: &crate::group::InstanceGroup) -> &mut Self {
        self.push(Shape::Group { group: group.clone() })
    }

    /// Light the frame with a sun shining from `direction` (towards the sun): it replaces the
    /// default sun and casts the shadows. Intensity 0 turns the sun off. Not a draw.
    pub fn sun(&mut self, direction: Vec3, color: Color, intensity: f32) -> &mut Self {
        self.lights.sun = Some(Sun { direction, color, intensity });
        self
    }

    /// Replace the default ambient light (white, 0.08). Not a draw.
    pub fn ambient(&mut self, color: Color, intensity: f32) -> &mut Self {
        self.lights.ambient = Some(Ambient { color, intensity });
        self
    }

    /// Add a point light at `position`, fading out at `range`. Not a draw.
    pub fn point_light(&mut self, position: Vec3, range: f32, color: Color, intensity: f32) -> &mut Self {
        self.lights.points.push(PointLight { position, range, color, intensity });
        self
    }

    /// Add a spot light at `position` shining along `direction`, fading out at `range`, with the
    /// default cone (20 degrees at full strength, dark past 30). Not a draw.
    pub fn spot_light(&mut self, position: Vec3, direction: Vec3, range: f32, color: Color, intensity: f32) -> &mut Self {
        self.spot_light_with(&SpotLight::new(position, direction, range, color, intensity))
    }

    /// Add a reflection probe (renderer pass 2 A.3): glossy surfaces inside its box reflect its
    /// surroundings instead of the sky. Not a draw.
    pub fn reflection_probe(&mut self, probe: &ReflectionProbe) -> &mut Self {
        self.lights.reflection_probes.push(*probe);
        self
    }

    /// Add an irradiance volume (renderer pass 2 A.4): surfaces inside its box take their diffuse
    /// ambient light from the scene around them instead of the sky. Not a draw.
    pub fn irradiance_volume(&mut self, volume: &IrradianceVolume) -> &mut Self {
        self.lights.irradiance_volumes.push(*volume);
        self
    }

    /// Add a projected decal (renderer pass 2 A.10, [`crate::Decal`]): every surface inside its box
    /// takes its texture before lighting. Not a draw; the device's quality draws the nearest 64
    /// (16 on phones), fading the farthest kept ones out.
    pub fn decal(&mut self, decal: &crate::decal::Decal) -> &mut Self {
        self.decals.push(decal.clone());
        self
    }

    /// The decals declared so far, in call order ([`Frame::decal`]).
    pub fn decals(&self) -> &[crate::decal::Decal] {
        &self.decals
    }

    /// Add `light`, a [`SpotLight`] with its own cone or a shadow map. Not a draw.
    pub fn spot_light_with(&mut self, light: &SpotLight) -> &mut Self {
        self.lights.spots.push(*light);
        self
    }

    /// The lights declared so far.
    pub fn lights(&self) -> &Lights {
        &self.lights
    }

    /// Light the frame by `environment` and draw it behind the scene (RQ2), the same on every
    /// device: [`Environment::sky`] (the physical sky, lit by this frame's sun as the light outside
    /// the atmosphere: the sky and the surfaces both see it through the air, so a low sun reddens
    /// both), [`Environment::hdri`] (an equirectangular `.hdr` under `assets/`; by default its sun
    /// is clamped out of its light and replaces this frame's [`Frame::sun`], so the map's sun casts
    /// the shadows and is not counted twice; [`HdriSun::Off`](crate::render::HdriSun::Off) keeps
    /// the map whole and the frame's sun as set) or [`Environment::Color`] (the flat ambient
    /// colour and the clear colour: what a frame that declares none draws). Where the device's
    /// quality turns image-based lighting on, the environment replaces the flat ambient light
    /// (built-in surfaces and `gx_shade_pbr` materials alike); where it turns the sky on, the sky
    /// or the map is drawn behind the scene instead of the clear colour. The last call wins. Not a
    /// draw.
    ///
    /// ```
    /// use genex::prelude::*;
    /// use genex::render::Environment;
    ///
    /// let mut frame = Frame::default();
    /// frame.sun(Vec3::new(0.3, 0.6, 0.2), Color::WHITE, 3.0).environment(Environment::sky());
    /// assert_eq!(frame.draw_calls(), 0);
    /// ```
    pub fn environment(&mut self, environment: Environment) -> &mut Self {
        self.environment = Some(environment);
        self
    }

    /// The environment this frame declared ([`Frame::environment`]); None draws the flat colour.
    pub fn declared_environment(&self) -> Option<&Environment> {
        self.environment.as_ref()
    }

    /// Draw `terrain` ([`crate::Terrain`]): one logical draw. A frame draws one terrain (a second
    /// call replaces the first).
    pub fn terrain(&mut self, terrain: &crate::terrain::Terrain) -> &mut Self {
        if self.terrain.is_none() {
            self.count();
        }
        self.terrain = Some(terrain.clone());
        self
    }

    /// The terrain this frame draws ([`Frame::terrain`]), if any.
    pub fn drawn_terrain(&self) -> Option<&crate::terrain::Terrain> {
        self.terrain.as_ref()
    }

    /// Draw `water` ([`crate::render::Water`], renderer pass 2 B.3) over the opaque scene: one
    /// logical draw. A frame draws one water (a second call replaces the first); a rectangle that
    /// cannot be drawn (a centre that is not finite, a half extent that is not a positive size) is
    /// ignored. Its ripples and foam run on the simulation's clock.
    pub fn water(&mut self, water: &crate::water::Water) -> &mut Self {
        if water.body().is_none() {
            return self;
        }
        if self.water.is_none() {
            self.count();
        }
        self.water = Some(*water);
        self
    }

    /// The water this frame draws ([`Frame::water`]), if any.
    pub fn drawn_water(&self) -> Option<&crate::water::Water> {
        self.water.as_ref()
    }

    /// Draw `particles` ([`crate::Particles`]) as they are at the tick this frame is drawn at:
    /// one logical draw. An emitter is drawn once a frame (a second call is ignored); emitters
    /// draw in call order after the transparent draws.
    pub fn particles(&mut self, particles: &crate::particles::Particles) -> &mut Self {
        if !self.particles.contains(particles) {
            self.count();
            self.particles.push(particles.clone());
        }
        self
    }

    /// The emitters this frame draws ([`Frame::particles`]), in call order.
    pub fn drawn_particles(&self) -> &[crate::particles::Particles] {
        &self.particles
    }

    /// Draw a line segment.
    pub fn line(&mut self, from: Vec3, to: Vec3, color: Color) -> &mut Self {
        self.push(Shape::Line { from, to, color })
    }

    /// Draw `mesh` (a [`Model`], [`CustomMesh::Cube`] or [`CustomMesh::Sphere`]) under
    /// `transform` with a custom material (`gfx.material`), tinted `tint`: one logical draw.
    pub fn custom(&mut self, mesh: impl Into<CustomMesh>, transform: Transform, material: &CustomMaterial, tint: Color) -> &mut Self {
        let tag = self.count();
        self.custom.push(CustomDraw { tag, id: self.id, mesh: mesh.into(), transform, material: material.clone(), tint });
        self
    }

    /// Run `pass` (`gfx.post_pass`) over the frame, after the 2D work and before the HUD and the
    /// Level-3 `post` passes, in call order: one logical draw.
    pub fn post_pass(&mut self, pass: &PostPass) -> &mut Self {
        let tag = self.count();
        self.posts.push(PostDraw { tag, pass: pass.clone() });
        self
    }

    /// Set the colour the world target clears to.
    pub fn clear(&mut self, color: Color) -> &mut Self {
        self.clear = color;
        self
    }

    /// The clear colour.
    pub fn clear_color(&self) -> Color {
        self.clear
    }

    /// Every draw, in order.
    pub fn draws(&self) -> &[Draw] {
        &self.draws
    }

    /// The meshes drawn with custom materials, in order.
    pub fn custom_draws(&self) -> &[CustomDraw] {
        &self.custom
    }

    /// The post passes, in run order.
    pub fn post_passes(&self) -> &[PostDraw] {
        &self.posts
    }

    /// How many logical draws this frame has (`drawCalls`).
    pub fn draw_calls(&self) -> u32 {
        self.tags.values().sum()
    }

    /// Draws per tag, in first-use order.
    pub fn tags(&self) -> &Map<String, u32> {
        &self.tags
    }

    fn push(&mut self, shape: Shape) -> &mut Self {
        let tag = self.count();
        self.draws.push(Draw { tag, id: self.id, shape });
        self
    }

    /// Count one logical draw under the current tag; answers the tag.
    fn count(&mut self) -> String {
        *self.tags.entry(self.tag.clone()).or_insert(0) += 1;
        self.tag.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use genex_render::motion::DrawId;

    #[test]
    fn an_id_scopes_the_later_draws_like_a_tag_until_it_ends() {
        let mut frame = Frame::default();
        frame.cube(Transform::IDENTITY, Color::WHITE);
        frame.id("fox").cube(Transform::from_xyz(1.0, 0.0, 0.0), Color::WHITE).sphere(Vec3::ZERO, 0.5, Color::WHITE);
        frame.id(7u64).line(Vec3::ZERO, Vec3::X, Color::WHITE);
        frame.end_id().cube(Transform::IDENTITY, Color::WHITE);
        let ids: Vec<Option<DrawId>> = frame.draws().iter().map(|draw| draw.id).collect();
        let fox = Some(DrawId::from("fox"));
        assert_eq!(ids, [None, fox, fox, Some(DrawId::from(7u64)), None]);
        assert_eq!(frame.draw_calls(), 5, "an id is not a draw and counts nothing");
        assert_eq!(frame.tags().get(DEFAULT_TAG), Some(&5), "ids leave the tags alone");
    }

    #[test]
    fn a_key_names_the_same_id_on_every_frame_and_every_destination() {
        assert_eq!(DrawId::from("fox"), DrawId::from(&"fox".to_owned()));
        assert_ne!(DrawId::from("fox"), DrawId::from("wolf"));
        // FNV-1a 64 of the key's UTF-8 bytes: no hasher seed, no platform word size.
        assert_eq!(DrawId::from("fox").get(), 0xdcb2_8218_fed9_eb8e);
        assert_eq!(DrawId::from(42u32), DrawId::from(42u64));
    }

    #[test]
    fn a_camera_cut_is_asked_for_by_the_frame_and_is_not_a_draw() {
        let mut frame = Frame::default();
        assert!(!frame.is_camera_cut(), "a frame continues the shot unless it says otherwise");
        frame.camera_cut().cube(Transform::IDENTITY, Color::WHITE);
        assert!(frame.is_camera_cut());
        assert_eq!(frame.draw_calls(), 1);
    }
}
