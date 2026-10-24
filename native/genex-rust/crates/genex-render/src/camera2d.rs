//! The 2D camera the immediate 2D primitives (rects, sprites, 2D lines) are drawn through: raylib's
//! `Camera2D` semantics, so a C++ · raylib game's 2D layer reads the same. World units are world
//! pixels with y pointing down; `target` lands on `offset` on screen, rotated about it by
//! `rotation_degrees` and scaled by `zoom`. [`Camera2d::SCREEN`] draws in world pixels directly.

use glam::{Mat4, Vec2, Vec3};

/// A 2D camera.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Camera2d {
    /// The world point the camera looks at.
    pub target: [f32; 2],
    /// Where `target` lands on the world target, in pixels from the top-left.
    pub offset: [f32; 2],
    /// Rotation about `offset`, in degrees (clockwise on screen, as raylib's).
    pub rotation_degrees: f32,
    /// Scale; 1 draws one world unit per pixel.
    pub zoom: f32,
}

impl Default for Camera2d {
    fn default() -> Self {
        Camera2d::SCREEN
    }
}

impl Camera2d {
    /// World units are world-target pixels: no offset, rotation or zoom.
    pub const SCREEN: Camera2d = Camera2d { target: [0.0, 0.0], offset: [0.0, 0.0], rotation_degrees: 0.0, zoom: 1.0 };

    fn rotation(&self) -> (f32, f32) {
        let radians = self.rotation_degrees.to_radians();
        (libm::sinf(radians), libm::cosf(radians))
    }

    /// World → world-target pixels.
    pub fn world_to_screen(&self, point: [f32; 2]) -> [f32; 2] {
        let (sin, cos) = self.rotation();
        let local = (Vec2::from(point) - Vec2::from(self.target)) * self.zoom;
        let rotated = Vec2::new(local.x * cos - local.y * sin, local.x * sin + local.y * cos);
        (rotated + Vec2::from(self.offset)).to_array()
    }

    /// World-target pixels → world (the inverse of [`Camera2d::world_to_screen`]; a zoom of 0 maps
    /// everything to `target`).
    pub fn screen_to_world(&self, point: [f32; 2]) -> [f32; 2] {
        if self.zoom == 0.0 {
            return self.target;
        }
        let (sin, cos) = self.rotation();
        let local = Vec2::from(point) - Vec2::from(self.offset);
        let unrotated = Vec2::new(local.x * cos + local.y * sin, -local.x * sin + local.y * cos);
        (unrotated / self.zoom + Vec2::from(self.target)).to_array()
    }

    /// The camera's matrix (world → pixels).
    fn view(&self) -> Mat4 {
        Mat4::from_translation(Vec3::new(self.offset[0], self.offset[1], 0.0))
            * Mat4::from_rotation_z(self.rotation_degrees.to_radians())
            * Mat4::from_scale(Vec3::new(self.zoom, self.zoom, 1.0))
            * Mat4::from_translation(Vec3::new(-self.target[0], -self.target[1], 0.0))
    }

    /// World → clip space for a world target of `size` pixels: the top-left pixel corner is NDC
    /// (-1, 1), the bottom-right (1, -1); depth 0. Column-major.
    pub fn view_proj(&self, size: (u32, u32)) -> [f32; 16] {
        self.view_proj_over([0.0, 0.0, size.0.max(1) as f32, size.1.max(1) as f32])
    }

    /// World → clip space for a frame showing `view` (x, y, width, height in world-target pixels;
    /// [`crate::letterbox::view_rect`]): its top-left corner is NDC (-1, 1), its bottom-right
    /// (1, -1). Over `[0, 0, width, height]` it is [`Camera2d::view_proj`].
    pub fn view_proj_over(&self, view: [f32; 4]) -> [f32; 16] {
        let [x, y, width, height] = view;
        let projection = glam::camera::rh::proj::directx::orthographic(x, x + width, y + height, y, -1.0, 1.0);
        (projection * self.view()).to_cols_array()
    }
}
