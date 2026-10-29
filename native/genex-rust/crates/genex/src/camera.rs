//! Cameras: the game's own view, named observer cameras and player eyes all return a [`Camera`]
//! from a read hook, so placing one never changes the simulation. [`FirstPersonRig`] adds a
//! first-person view's walk, landing, recoil and shake motion under hard comfort caps, scaled by
//! the person's settings in the camera hook.

use glam::Vec3;

mod rig;

pub use rig::{
    BOB_PEAK_TO_PEAK_MAX, BOB_ROLL_MAX_DEG, CADENCE_MAX_HZ, Comfort, FOV_KICK_MAX_DEG, FirstPersonRig, NOISE_MAX_HZ, REDUCED_MOTION_SHARE, ROLL_TOTAL_MAX_DEG,
    RigPose, RigStep,
};

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

    /// This camera as an `output`-sized frame of a `world`-sized game draws it under `fit`: under
    /// [`Fit::Expand`](crate::Fit) an output taller than the world widens the vertical field of
    /// view (or the orthographic height) by the aspect ratio, so the world's width stays in view
    /// (Vert+); a wider one keeps it and shows more at the sides (Hor+, the output's aspect does
    /// that). Any other case is this camera, unchanged.
    pub(crate) fn for_output(self, world: [u32; 2], output: (u32, u32), fit: crate::Fit) -> Camera {
        let (cross_output, cross_world) = (u64::from(output.0) * u64::from(world[1]), u64::from(output.1) * u64::from(world[0]));
        let taller = cross_output < cross_world && output.0 > 0 && world[1] > 0;
        if fit != crate::Fit::Expand || !taller {
            return self;
        }
        let grow = (world[0] as f32 / world[1] as f32) / (output.0 as f32 / output.1 as f32);
        let fovy = match self.projection {
            Projection::Orthographic => self.fovy * grow,
            Projection::Perspective => 2.0 * libm::atanf(libm::tanf(self.fovy.to_radians() * 0.5) * grow).to_degrees(),
        };
        Camera { fovy, ..self }
    }
}

impl Default for Camera {
    fn default() -> Self {
        Camera::DEFAULT
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Fit;

    const WORLD: [u32; 2] = [960, 540];

    fn tan_half(fovy: f32) -> f32 {
        libm::tanf(fovy.to_radians() * 0.5)
    }

    /// Lane EF: under expand a wider output keeps the vertical field of view (Hor+: more at the
    /// sides) and a taller one widens it so the world's width stays in view (Vert+); letterbox and
    /// an output of the world's aspect leave the camera as the game made it, bit for bit.
    #[test]
    fn expand_keeps_the_world_s_frame_in_view_at_any_aspect() {
        let camera = Camera::look_at(Vec3::new(0.0, 2.0, 5.0), Vec3::ZERO);
        assert_eq!(camera.for_output(WORLD, (2520, 1080), Fit::Expand), camera, "wider: Hor+, the same camera");
        assert_eq!(camera.for_output(WORLD, (1920, 1080), Fit::Expand), camera, "the world's aspect: the same camera");
        assert_eq!(camera.for_output(WORLD, (1440, 1080), Fit::Letterbox), camera, "letterbox: the same camera");
        let tall = camera.for_output(WORLD, (1440, 1080), Fit::Expand);
        let widened = tan_half(tall.fovy) / tan_half(camera.fovy);
        assert!((widened - (16.0 / 9.0) / (4.0 / 3.0)).abs() < 1e-4, "4:3: the half-height grows by the aspect ratio, {widened}");
        let ortho = Camera { projection: Projection::Orthographic, fovy: 10.0, ..camera };
        let tall_ortho = ortho.for_output(WORLD, (1440, 1080), Fit::Expand);
        assert!((tall_ortho.fovy - 10.0 * (16.0 / 9.0) / (4.0 / 3.0)).abs() < 1e-4, "{}", tall_ortho.fovy);
        assert_eq!(ortho.for_output(WORLD, (2520, 1080), Fit::Expand), ortho, "orthographic, wider: the same height");
        assert_eq!(camera.for_output(WORLD, (0, 0), Fit::Expand), camera, "no output: the same camera");
    }
}
