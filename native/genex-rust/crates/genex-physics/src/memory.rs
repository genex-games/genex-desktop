//! Memory accounting per world (CONTRACT.md §11.1).
//!
//! The core charges every object a world holds by a fixed model of what the backend stores for it,
//! not by what an allocator happened to return. That makes a refusal (`LimitMemory`) the same on
//! every target, which a pointer-width-dependent byte count could not, and lets a command be judged
//! before it allocates anything. The model's rates are below; `stats().memoryBytes` reports it.

use crate::shape::ShapeFacts;

/// What an empty world holds: the backend's pipelines, sets and parameters.
pub const WORLD_BASE_BYTES: u64 = 16 * 1024;
/// One body: the backend's rigid body, its island slot, and the core's entry.
pub const BODY_BYTES: u64 = 1024;
/// One collider: the backend's collider, its broad-phase leaf and the core's key.
pub const COLLIDER_BYTES: u64 = 512;
/// One hull point: the point, its share of faces and adjacency.
pub const HULL_POINT_BYTES: u64 = 48;
/// One trimesh vertex: the vertex and its pseudo-normal.
pub const TRIMESH_VERTEX_BYTES: u64 = 24;
/// One trimesh triangle: its indices and its share of the BVH.
pub const TRIMESH_TRIANGLE_BYTES: u64 = 64;
/// One heightfield sample: the height and its cell status.
pub const HEIGHTFIELD_SAMPLE_BYTES: u64 = 8;
/// One joint: the backend's joint, its solver rows and the core's entry.
pub const JOINT_BYTES: u64 = 512;
/// One contact pair: the narrow phase's pair, its manifold and solver contact.
pub const CONTACT_PAIR_BYTES: u64 = 768;

/// The modelled bytes of one body with `colliders` colliders, keys of `key_bytes` in all, and
/// shapes adding up to `facts`.
pub(crate) fn body_bytes(colliders: usize, key_bytes: usize, facts: &ShapeFacts) -> u64 {
    let count = |n: usize| n as u64;
    BODY_BYTES
        + COLLIDER_BYTES * count(colliders)
        + count(key_bytes)
        + HULL_POINT_BYTES * count(facts.hull_points)
        + TRIMESH_VERTEX_BYTES * count(facts.trimesh_vertices)
        + TRIMESH_TRIANGLE_BYTES * count(facts.triangles)
        + HEIGHTFIELD_SAMPLE_BYTES * count(facts.heightfield_samples)
}

/// The modelled bytes of `pairs` contact pairs.
pub(crate) fn contact_bytes(pairs: usize) -> u64 {
    CONTACT_PAIR_BYTES * pairs as u64
}

/// The modelled bytes of one joint with a key of `key_bytes`.
pub(crate) fn joint_bytes(key_bytes: usize) -> u64 {
    JOINT_BYTES + key_bytes as u64
}
