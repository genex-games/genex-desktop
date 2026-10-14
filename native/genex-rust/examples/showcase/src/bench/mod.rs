//! Renderer bench scenes: what the renderer follow-up measures and captures before and after each
//! tier, beside the lakeside. They draw through genex-render's [`Scene`] directly, because the
//! facade has no per-draw materials, point lights or skinning yet (plan RQ1.4).
//!
//! - `materials`: spheres across metallic × roughness, three skinned walkers, glass, coloured
//!   point lights (emissive materials join in RQ6).
//! - `outdoor`: a 160 × 160-cell terrain, about 12,000 foliage instances, transparent water and an opaque
//!   banded sky dome as the placeholder for the physical sky (RQ2).
//! - `city`: about 64,000 instances of 28 meshes in twelve materials, the large-scene perf case.
//!
//! Every scene is a function of the frame index alone: its camera follows a closed path of
//! [`PATH_FRAMES`] frames, and whatever moves (the walkers) is posed from the same index.

mod character;
mod city;
pub mod geometry;
mod materials;
mod outdoor;

use genex::math::{self, Vec3};
use genex_render::RenderError;
use genex_render::mesh::MeshData;
use genex_render::scene::{CameraDesc, MeshId, MeshLibrary, Scene};
use genex_render::skin::{SkinId, SkinnedMeshData};

pub use character::{walk, walker};

/// Frames in one loop of every camera path (ten seconds at 60 frames per second).
pub const PATH_FRAMES: u32 = 600;
/// Frames per second of scene time (what the walkers' cycle is timed in).
pub const FRAMES_PER_SECOND: f32 = 60.0;

/// Where a scene's meshes go: a renderer's library, or a bare [`MeshLibrary`] for CPU tests.
pub trait Meshes {
    /// Add a mesh.
    fn add(&mut self, mesh: MeshData) -> Result<MeshId, RenderError>;
    /// Add a skinned mesh.
    fn add_skinned(&mut self, data: &SkinnedMeshData) -> Result<SkinId, RenderError>;
}

impl Meshes for MeshLibrary {
    fn add(&mut self, mesh: MeshData) -> Result<MeshId, RenderError> {
        MeshLibrary::add(self, mesh)
    }

    fn add_skinned(&mut self, data: &SkinnedMeshData) -> Result<SkinId, RenderError> {
        MeshLibrary::add_skinned(self, data)
    }
}

/// A loaded bench scene: what it draws at a frame of its path.
pub trait BenchScene {
    /// The scene's name.
    fn id(&self) -> SceneId;
    /// The frame to draw at `frame` (any index; the path loops every [`PATH_FRAMES`]).
    fn scene(&self, frame: u32) -> Scene;
}

/// The bench scenes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SceneId {
    /// Spheres across metallic × roughness, skinned walkers, glass and point lights.
    Materials,
    /// Terrain, foliage instances, water and a sky placeholder.
    Outdoor,
    /// About 64,000 instances of 28 meshes.
    City,
}

impl SceneId {
    /// Every scene, in report order.
    pub const ALL: [SceneId; 3] = [SceneId::Materials, SceneId::Outdoor, SceneId::City];

    /// Its name in file names and reports.
    pub const fn name(self) -> &'static str {
        match self {
            SceneId::Materials => "materials",
            SceneId::Outdoor => "outdoor",
            SceneId::City => "city",
        }
    }

    /// The scene named `name`.
    pub fn from_name(name: &str) -> Option<SceneId> {
        SceneId::ALL.into_iter().find(|id| id.name() == name)
    }
}

/// A named frame of a scene's path: what the capture rows render.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Shot {
    /// The scene.
    pub scene: SceneId,
    /// The shot's name.
    pub name: &'static str,
    /// The frame of the scene's path.
    pub frame: u32,
}

/// The captured shots, two per scene.
pub const SHOTS: [Shot; 6] = [
    Shot { scene: SceneId::Materials, name: "front", frame: 0 },
    Shot { scene: SceneId::Materials, name: "side", frame: 150 },
    Shot { scene: SceneId::Outdoor, name: "meadow", frame: 0 },
    Shot { scene: SceneId::Outdoor, name: "shore", frame: 420 },
    Shot { scene: SceneId::City, name: "street", frame: 0 },
    Shot { scene: SceneId::City, name: "aerial", frame: 300 },
];

/// Load scene `id`'s meshes into `meshes`.
pub fn load(id: SceneId, meshes: &mut dyn Meshes) -> Result<Box<dyn BenchScene>, RenderError> {
    Ok(match id {
        SceneId::Materials => Box::new(materials::Materials::load(meshes)?),
        SceneId::Outdoor => Box::new(outdoor::Outdoor::load(meshes)?),
        SceneId::City => Box::new(city::City::load(meshes)?),
    })
}

/// Where `frame` is along a looping path: 0..1.
fn path_fraction(frame: u32) -> f32 {
    (frame % PATH_FRAMES) as f32 / PATH_FRAMES as f32
}

/// The scene time of `frame`, in seconds (it does not loop).
fn seconds(frame: u32) -> f32 {
    frame as f32 / FRAMES_PER_SECOND
}

/// A perspective camera from `eye` to `target` with `fovy` degrees and a far plane at `far`.
fn camera(eye: Vec3, target: Vec3, fovy: f32, far: f32) -> CameraDesc {
    CameraDesc { fovy_degrees: fovy, far, ..CameraDesc::look_at(eye.to_array(), target.to_array()) }
}

/// A point on a circle of `radius` around the origin at `angle` radians (in the XZ plane).
fn on_circle(angle: f32, radius: f32) -> Vec3 {
    let (s, c) = math::sin_cos(angle);
    Vec3::new(c * radius, 0.0, s * radius)
}

/// The model matrix of a mesh at `position`, turned `yaw` radians about +Y and scaled by `scale`.
fn placed(position: Vec3, yaw: f32, scale: Vec3) -> [f32; 16] {
    math::Mat4::from_scale_rotation_translation(scale, math::Quat::from_rotation_y(yaw), position).to_cols_array()
}
