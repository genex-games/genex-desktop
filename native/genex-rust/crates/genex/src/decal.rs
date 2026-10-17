//! Projected decals (renderer pass 2 A.10): a box of the world that lays a texture onto every
//! surface inside it, before lighting (a poster on a wall, a puddle on the road, grime along a
//! kerb). Declared with [`crate::Frame::decal`]; not a draw.

use std::sync::Arc;

use glam::{Mat3, Quat, Vec3};

use crate::frame::{Color, Transform};

/// How deep a wall decal's box reaches into and out of the wall, in world units, unless set
/// ([`Decal::with_depth`]): enough to cover a rough wall, shallow enough to miss what stands in
/// front of it.
pub const DEFAULT_WALL_DEPTH: f32 = 0.2;
/// How deep a ground decal's box reaches above and below the ground, unless set.
pub const DEFAULT_GROUND_DEPTH: f32 = 0.5;

/// A projected decal. Its box is the unit cube under [`Decal::transform`] (its scale is the box's
/// size): the decal looks out of the box's local +y face and projects along -y onto every surface
/// in the box, its image's right along local +x and its image's up along local -z. Build one with
/// [`Decal::on_wall`] or [`Decal::on_ground`], textures by asset path.
#[derive(Clone, Debug, PartialEq)]
pub struct Decal {
    /// The box.
    pub transform: Transform,
    /// The sRGB tint of the base colour (its alpha times the opacity).
    pub color: Color,
    /// The decal's opacity, 0..1.
    pub opacity: f32,
    /// How much of the surface's colour it replaces, 0..1 (0: only its normal, roughness or
    /// metallic change the surface, a puddle).
    pub albedo_mix: f32,
    /// How strongly its normal texture tilts the surface.
    pub normal_strength: f32,
    /// How far it smooths the surface's own bumps away, 0..1 (1: a puddle's flat film over the
    /// road's texture; 0: a poster follows the wall's).
    pub flatten: f32,
    /// The roughness it gives the surface (times its ORM texture's green); `None`: the surface's.
    pub roughness: Option<f32>,
    /// The metallic it gives the surface (times its ORM texture's blue); `None`: the surface's.
    pub metallic: Option<f32>,
    /// How strongly its ORM texture's red darkens the surface's ambient light, 0..1.
    pub occlusion: f32,
    /// The share of the box's half-depth over which it fades towards the box's front and back
    /// faces, 0..1.
    pub depth_fade: f32,
    /// The angles, in degrees, between a surface and the decal's face at which it starts to fade
    /// and has faded out (default 60 and 80: no streaks down a wall from a floor decal).
    pub angle_fade: [f32; 2],
    base_texture: Option<Arc<str>>,
    normal_texture: Option<Arc<str>>,
    orm_texture: Option<Arc<str>>,
}

impl Decal {
    /// A decal over the box `transform`, whole, replacing the surface's colour with white until
    /// given a colour or a texture.
    pub fn new(transform: Transform) -> Decal {
        let defaults = genex_render::decals::Decal::new(glam::Mat4::IDENTITY.to_cols_array());
        Decal {
            transform,
            color: Color::WHITE,
            opacity: defaults.opacity,
            albedo_mix: defaults.albedo_mix,
            normal_strength: defaults.normal_strength,
            flatten: defaults.flatten,
            roughness: None,
            metallic: None,
            occlusion: defaults.occlusion,
            depth_fade: defaults.depth_fade,
            angle_fade: defaults.angle_fade,
            base_texture: None,
            normal_texture: None,
            orm_texture: None,
        }
    }

    /// A decal on a wall: `width` by `height`, centred at `center` on the wall's face, looking out
    /// along `facing` (the wall's outward normal), upright (its image's up is the world's up; on a
    /// floor or ceiling, `facing` straight up or down, its image's up is -z), reaching
    /// [`DEFAULT_WALL_DEPTH`] into and out of the wall.
    pub fn on_wall(center: Vec3, facing: Vec3, width: f32, height: f32) -> Decal {
        let out = facing.try_normalize().unwrap_or(Vec3::Z);
        // The image's up is the box's local -z: the world's up laid onto the wall.
        let along_up = Vec3::Y - out * out.dot(Vec3::Y);
        let up = along_up.try_normalize().unwrap_or(Vec3::NEG_Z);
        let z = -up;
        let x = out.cross(z);
        let rotation = Quat::from_mat3(&Mat3::from_cols(x, out, z));
        Decal::new(Transform { translation: center, rotation, scale: Vec3::new(width, DEFAULT_WALL_DEPTH, height) })
    }

    /// A decal on the ground: `width` along x by `length` along z, centred at `center`, looking up
    /// (its image's up is -z), reaching [`DEFAULT_GROUND_DEPTH`] above and below the ground.
    pub fn on_ground(center: Vec3, width: f32, length: f32) -> Decal {
        Decal::new(Transform { translation: center, rotation: Quat::IDENTITY, scale: Vec3::new(width, DEFAULT_GROUND_DEPTH, length) })
    }

    /// The decal turned by `radians` about its face's normal (counter-clockwise as seen from it).
    pub fn rotated(self, radians: f32) -> Decal {
        let rotation = self.transform.rotation * Quat::from_rotation_y(radians);
        Decal { transform: Transform { rotation, ..self.transform }, ..self }
    }

    /// The decal's box `depth` deep (into and out of its surface together).
    pub fn with_depth(self, depth: f32) -> Decal {
        let scale = Vec3::new(self.transform.scale.x, depth, self.transform.scale.z);
        Decal { transform: Transform { scale, ..self.transform }, ..self }
    }

    /// The decal with a base-colour texture (`assets/<path>`, sRGB) times its colour; the
    /// texture's alpha is the decal's shape. Until the texture loads (or when it is missing) the
    /// decal is not drawn.
    pub fn with_base_texture(self, path: &str) -> Decal {
        Decal { base_texture: Some(Arc::from(path)), ..self }
    }

    /// The decal with a tangent-space normal texture (`assets/<path>`, green up in the image)
    /// tilting the surface by `strength`.
    pub fn with_normal_texture(self, path: &str, strength: f32) -> Decal {
        Decal { normal_texture: Some(Arc::from(path)), normal_strength: strength, ..self }
    }

    /// The decal with a glTF occlusion-roughness-metallic texture (`assets/<path>`): red ambient
    /// occlusion (see [`Decal::with_occlusion`]), green roughness, blue metallic.
    pub fn with_orm_texture(self, path: &str) -> Decal {
        Decal { orm_texture: Some(Arc::from(path)), ..self }
    }

    /// The decal tinted `color` (its alpha times the opacity).
    pub fn with_color(self, color: Color) -> Decal {
        Decal { color, ..self }
    }

    /// The decal at `opacity`, 0..1.
    pub fn with_opacity(self, opacity: f32) -> Decal {
        Decal { opacity, ..self }
    }

    /// The decal replacing `mix` of the surface's colour, 0..1.
    pub fn with_albedo_mix(self, mix: f32) -> Decal {
        Decal { albedo_mix: mix, ..self }
    }

    /// The decal smoothing `share` of the surface's own bumps away, 0..1 (a puddle's 1).
    pub fn with_flatten(self, share: f32) -> Decal {
        Decal { flatten: share, ..self }
    }

    /// The decal giving the surface `roughness` (a puddle's 0.05).
    pub fn with_roughness(self, roughness: f32) -> Decal {
        Decal { roughness: Some(roughness), ..self }
    }

    /// The decal giving the surface `metallic`.
    pub fn with_metallic(self, metallic: f32) -> Decal {
        Decal { metallic: Some(metallic), ..self }
    }

    /// The decal darkening the surface's ambient light by its ORM texture's red at `strength`.
    pub fn with_occlusion(self, strength: f32) -> Decal {
        Decal { occlusion: strength, ..self }
    }

    /// The decal fading out over `share` of its box's half-depth towards its front and back faces.
    pub fn with_depth_fade(self, share: f32) -> Decal {
        Decal { depth_fade: share, ..self }
    }

    /// The decal fading on surfaces turned `full` to `none` degrees from its face.
    pub fn with_angle_fade(self, full: f32, none: f32) -> Decal {
        Decal { angle_fade: [full, none], ..self }
    }

    /// The base-colour texture's path.
    pub fn base_texture(&self) -> Option<&str> {
        self.base_texture.as_deref()
    }

    /// The normal texture's path.
    pub fn normal_texture(&self) -> Option<&str> {
        self.normal_texture.as_deref()
    }

    /// The ORM texture's path.
    pub fn orm_texture(&self) -> Option<&str> {
        self.orm_texture.as_deref()
    }
}
