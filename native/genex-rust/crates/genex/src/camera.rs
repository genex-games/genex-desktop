//! Cameras: the game's own view, named observer cameras and player eyes all return a [`Camera`]
//! from a read hook, so placing one never changes the simulation.

use glam::Vec3;

/// How a camera projects the world.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Projection {
    /// Perspective with the camera's vertical field of view.
    #[default]
    Perspective,
    /// Orthographic; the field of view is the view height in world units.
    Orthographic,
}

/// A 3D camera, right-handed with +Y up.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Camera {
    /// Where the camera is.
    pub position: Vec3,
    /// The point it looks at.
    pub target: Vec3,
    /// Up direction.
    pub up: Vec3,
    /// Vertical field of view in degrees (perspective), or view height (orthographic).
    pub fovy: f32,
    /// Perspective or orthographic.
    pub projection: Projection,
}

impl Camera {
    /// The view a game gets when it registers no camera: from (0, 10, 20) toward the origin.
    pub const DEFAULT: Camera = Camera {
        position: Vec3::new(0.0, 10.0, 20.0),
        target: Vec3::ZERO,
        up: Vec3::Y,
        fovy: 45.0,
        projection: Projection::Perspective,
    };

    /// A perspective camera at `position` looking at `target`.
    pub fn look_at(position: Vec3, target: Vec3) -> Camera {
        Camera { position, target, ..Camera::DEFAULT }
    }
}

impl Default for Camera {
    fn default() -> Self {
        Camera::DEFAULT
    }
}
