//! Collider input (NAV-5): a physics world's colliders as bake triangles, through parry's
//! `to_trimesh` (Apache-2.0, vendored with Rapier).
//!
//! Behind the `physics` feature, so a game built without physics links no Rapier through nav.
//! The shape table follows avian_rerecast's `collider_to_trimesh.rs` (MIT OR Apache-2.0; the
//! table, no code copied): a compound recurses into its parts with their poses, a rounded shape
//! gives its inner shape's triangles, and the shapes with no inside (half-space, segment,
//! polyline) give nothing. oxidized_navigation's rule picks the colliders by default: static
//! colliders only (no body or a fixed body), never a sensor, never a disabled collider.
//!
//! Colliders are visited in handle order (the `ColliderSet`'s slot order), so the same insert and
//! remove sequence always gives the same input, and so the same bake digest. Every curved shape
//! is cut with fixed subdivisions whose rings pass through the shape's extreme points, so the
//! triangles' bounds are the collider's bounds.

use glam::Vec3;
use rapier3d::geometry::{Collider, ColliderHandle};
use rapier3d::math::Pose;
use rapier3d::parry::shape::{Shape, TypedShape};
use rapier3d::pipeline::PhysicsWorld;
use rapier3d::prelude::RigidBody;

use crate::error::NavError;
use crate::input::{NavArea, NavInput};

/// Rings around a ball's or capsule's axis (a multiple of 4, so the ring passes through ±x and ±z).
const ROUND_THETA_SUBDIVISIONS: u32 = 16;
/// Rings from pole to pole of a ball or a capsule's caps (even, so one ring is the equator).
const ROUND_PHI_SUBDIVISIONS: u32 = 8;
/// Sides of a cylinder's or a cone's circle (a multiple of 4, as for a ball).
const CIRCLE_SUBDIVISIONS: u32 = 16;

/// One collider as a pick sees it: the collider, its handle and its parent body, if any.
#[derive(Clone, Copy)]
pub struct ColliderView<'a> {
    /// The collider's handle in the physics world.
    pub handle: ColliderHandle,
    /// The collider.
    pub collider: &'a Collider,
    /// The body it is attached to (`None` for a collider on its own).
    pub body: Option<&'a RigidBody>,
}

impl ColliderView<'_> {
    /// The default rule: an enabled collider that is not a sensor, on no body or a fixed body.
    /// Dynamic and kinematic bodies (characters' capsules among them) move, so they never bake.
    pub fn is_static(&self) -> bool {
        let fixed_or_none = self.body.is_none_or(RigidBody::is_fixed);
        fixed_or_none && self.collider.is_enabled() && !self.collider.is_sensor()
    }
}

/// The triangles of `collider` in world space: vertices and indices (three per triangle), or
/// `None` for a shape with no inside (half-space, segment, polyline) or nothing to cut.
pub fn collider_triangles(collider: &Collider) -> Option<(Vec<Vec3>, Vec<u32>)> {
    let mut vertices = Vec::new();
    let mut indices = Vec::new();
    shape_triangles(collider.shape(), collider.position(), &mut vertices, &mut indices);
    (!indices.is_empty()).then_some((vertices, indices))
}

/// Append `shape`'s triangles placed by `pose` (compounds recurse with each part's pose).
fn shape_triangles(shape: &dyn Shape, pose: &Pose, vertices: &mut Vec<Vec3>, indices: &mut Vec<u32>) {
    let local = match shape.as_typed_shape() {
        TypedShape::Compound(compound) => {
            for (part_pose, part) in compound.shapes() {
                shape_triangles(part.as_ref(), &(*pose * *part_pose), vertices, indices);
            }
            return;
        }
        TypedShape::Ball(ball) => ball.to_trimesh(ROUND_THETA_SUBDIVISIONS, ROUND_PHI_SUBDIVISIONS),
        TypedShape::Capsule(capsule) => capsule.to_trimesh(ROUND_THETA_SUBDIVISIONS, ROUND_PHI_SUBDIVISIONS),
        TypedShape::Cuboid(cuboid) => cuboid.to_trimesh(),
        TypedShape::RoundCuboid(round) => round.inner_shape.to_trimesh(),
        TypedShape::Cylinder(cylinder) => cylinder.to_trimesh(CIRCLE_SUBDIVISIONS),
        TypedShape::RoundCylinder(round) => round.inner_shape.to_trimesh(CIRCLE_SUBDIVISIONS),
        TypedShape::Cone(cone) => cone.to_trimesh(CIRCLE_SUBDIVISIONS),
        TypedShape::RoundCone(round) => round.inner_shape.to_trimesh(CIRCLE_SUBDIVISIONS),
        TypedShape::ConvexPolyhedron(convex) => convex.to_trimesh(),
        TypedShape::RoundConvexPolyhedron(round) => round.inner_shape.to_trimesh(),
        TypedShape::Triangle(triangle) => (vec![triangle.a, triangle.b, triangle.c], vec![[0, 1, 2]]),
        TypedShape::RoundTriangle(round) => (vec![round.inner_shape.a, round.inner_shape.b, round.inner_shape.c], vec![[0, 1, 2]]),
        TypedShape::TriMesh(mesh) => (mesh.vertices().to_vec(), mesh.indices().to_vec()),
        TypedShape::HeightField(heightfield) => heightfield.to_trimesh(),
        TypedShape::Voxels(voxels) => voxels.to_trimesh(),
        _ => return,
    };
    append_placed(local, pose, vertices, indices);
}

/// Append one shape's local triangles, moved into the world by `pose`.
fn append_placed((local_vertices, local_indices): (Vec<Vec3>, Vec<[u32; 3]>), pose: &Pose, vertices: &mut Vec<Vec3>, indices: &mut Vec<u32>) {
    let Ok(base) = u32::try_from(vertices.len()) else { return };
    vertices.extend(local_vertices.into_iter().map(|vertex| pose.transform_point(vertex)));
    indices.extend(local_indices.into_iter().flatten().map(|index| base.saturating_add(index)));
}

impl NavInput {
    /// Add every collider of `physics` that `pick` answers an area for, in handle order. Sensors
    /// and disabled colliders never count, whatever `pick` says. Atomic: refused as
    /// [`NavInput::add_triangles`] refuses (`nav-too-large` past the triangle cap,
    /// `nav-input-invalid` for a non-finite placement) with the input unchanged.
    pub fn add_colliders(&mut self, physics: &PhysicsWorld, pick: impl Fn(&ColliderView<'_>) -> Option<NavArea>) -> Result<(), NavError> {
        let mut next = self.clone();
        for (handle, collider) in physics.colliders.iter() {
            let view = ColliderView { handle, collider, body: collider.parent().and_then(|parent| physics.bodies.get(parent)) };
            if collider.is_sensor() || !collider.is_enabled() {
                continue;
            }
            let Some(area) = pick(&view) else { continue };
            let Some((vertices, indices)) = collider_triangles(collider) else { continue };
            next.add_triangles(&vertices, &indices, area)?;
        }
        *self = next;
        Ok(())
    }

    /// Add the static colliders of `physics` ([`ColliderView::is_static`]) as `area`: the
    /// default rule. Refused as [`NavInput::add_colliders`].
    pub fn add_static_colliders(&mut self, physics: &PhysicsWorld, area: NavArea) -> Result<(), NavError> {
        self.add_colliders(physics, |view| view.is_static().then_some(area))
    }

    /// [`NavInput::add_colliders`] in a builder chain.
    pub fn with_colliders(mut self, physics: &PhysicsWorld, pick: impl Fn(&ColliderView<'_>) -> Option<NavArea>) -> Result<NavInput, NavError> {
        self.add_colliders(physics, pick).map(|()| self)
    }

    /// [`NavInput::add_static_colliders`] in a builder chain.
    pub fn with_static_colliders(mut self, physics: &PhysicsWorld, area: NavArea) -> Result<NavInput, NavError> {
        self.add_static_colliders(physics, area).map(|()| self)
    }
}
