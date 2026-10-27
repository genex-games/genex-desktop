//! Queries (§13): each argument checked in order (numbers and bounds as a command's, §4.1), then the
//! quota of `limits.queriesPerStep` counted since the last step, then the backend's candidates,
//! from which the core picks the answer by distance, then body key, then collider key.
//!
//! A query's origin or pose lies within `limits.worldExtent`, as every position a command sets;
//! its direction is normalised in f32 in the caller frame and refused when zero; `maxDist` is
//! finite and at least 0. Only box, sphere, capsule and hull shapes are swept or overlapped; a
//! trimesh or heightfield gives `OutOfRange`. An excluded key must be well formed; one naming
//! nothing is ignored.

use std::collections::BTreeSet;

use super::Core;
use crate::axes::{quat_in, vec_in, vec_out};
use crate::backend::{Backend, RawHit, RawQueryFilter, ShapeAt, ShapeSpec};
use crate::body::{Shape, body_pose, group};
use crate::error::{PhysicsError, PhysicsFailure, fail};
use crate::key::check_key;
use crate::num::{finite_vec, length_squared, non_negative, out, out_vec, unsigned_zero};
use crate::query::{EXCLUDE_BODIES_MAX, Hit, QueryFilter};
use crate::shape::{ShapeFacts, validate_shape};
use crate::types::{Pose, Vec3};

/// A query shape checked and in the core's frame, with its pose.
struct QueryShape {
    spec: ShapeSpec,
    translation: [f32; 3],
    rotation: [f32; 4],
}

impl QueryShape {
    fn at(&self) -> ShapeAt<'_> {
        ShapeAt { shape: &self.spec, translation: self.translation, rotation: self.rotation }
    }
}

/// `dir` rounded to f32 and normalised in f32 (its length taken in f64, where each f32 square is
/// exact); a zero direction gives `OutOfRange`.
fn unit_dir(dir: Vec3) -> Result<[f32; 3], PhysicsFailure> {
    let dir = finite_vec(dir, "dir")?;
    let length = length_squared(dir).sqrt();
    if length == 0.0 {
        return fail(PhysicsError::OutOfRange, "dir must not be zero");
    }
    Ok(dir.map(|c| (f64::from(c) / length) as f32))
}

fn backend_shape<T>(result: Result<T, crate::backend::BackendRefusal>) -> Result<T, PhysicsFailure> {
    result.map_err(|_| PhysicsFailure::new(PhysicsError::BadShape, "the backend could not build the shape"))
}

impl<B: Backend> Core<B> {
    /// The nearest hit along a ray (§13).
    pub(crate) fn ray(&mut self, origin: Vec3, dir: Vec3, max_dist: f64, filter: &QueryFilter) -> Result<Option<Hit>, PhysicsFailure> {
        let origin = self.query_point(origin)?;
        let dir = unit_dir(dir)?;
        let max_dist = non_negative(max_dist, "maxDist")?;
        let filter = self.query_filter(filter)?;
        self.check_quota()?;
        let up = self.desc.up_axis;
        let hits = self.backend.ray(vec_in(up, origin), vec_in(up, dir), max_dist, &filter);
        self.queries_this_step += 1;
        Ok(self.nearest(&hits))
    }

    /// The first hit of a swept box, sphere, capsule or hull (§13).
    pub(crate) fn shape_cast(
        &mut self,
        shape: &Shape,
        pose: &Pose,
        dir: Vec3,
        max_dist: f64,
        filter: &QueryFilter,
    ) -> Result<Option<Hit>, PhysicsFailure> {
        let shape = self.query_shape(shape, pose)?;
        let dir = unit_dir(dir)?;
        let max_dist = non_negative(max_dist, "maxDist")?;
        let filter = self.query_filter(filter)?;
        self.check_quota()?;
        let dir = vec_in(self.desc.up_axis, dir);
        let hits = backend_shape(self.backend.shape_cast(shape.at(), dir, max_dist, &filter))?;
        self.queries_this_step += 1;
        Ok(self.nearest(&hits))
    }

    /// The bodies a box, sphere, capsule or hull overlaps, in key order, each once (§13).
    pub(crate) fn overlap(&mut self, shape: &Shape, pose: &Pose, filter: &QueryFilter) -> Result<Vec<String>, PhysicsFailure> {
        let shape = self.query_shape(shape, pose)?;
        let filter = self.query_filter(filter)?;
        self.check_quota()?;
        let ids = backend_shape(self.backend.overlap(shape.at(), &filter))?;
        self.queries_this_step += 1;
        let keys: BTreeSet<&str> = ids.iter().filter_map(|id| self.collider_name(*id)).map(|(body, _, _)| body).collect();
        Ok(keys.into_iter().map(str::to_string).collect())
    }

    /// Refuses `LimitQueries` once this step's quota is used; a query that then succeeds counts.
    fn check_quota(&self) -> Result<(), PhysicsFailure> {
        if self.queries_this_step >= self.desc.limits.queries_per_step {
            return fail(PhysicsError::LimitQueries, "limits.queriesPerStep reached since the last step");
        }
        Ok(())
    }

    /// A point within `worldExtent` per axis (§4.1).
    fn query_point(&self, point: Vec3) -> Result<[f32; 3], PhysicsFailure> {
        let point = finite_vec(point, "origin")?;
        if point.iter().any(|c| c.abs() > self.desc.limits.world_extent) {
            return fail(PhysicsError::OutOfRange, "origin lies outside limits.worldExtent");
        }
        Ok(point)
    }

    fn query_shape(&self, shape: &Shape, pose: &Pose) -> Result<QueryShape, PhysicsFailure> {
        if matches!(shape, Shape::Trimesh { .. } | Shape::Heightfield { .. }) {
            return fail(PhysicsError::OutOfRange, "queries take box, sphere, capsule and hull shapes only");
        }
        let (up, limits) = (self.desc.up_axis, self.desc.limits);
        let mut facts = ShapeFacts::default();
        let spec = validate_shape(shape, up, &limits, &mut facts)?;
        if facts.hull_points_max > limits.hull_vertices as usize {
            return fail(PhysicsError::LimitHullVertices, "the hull has more points than limits.hullVertices");
        }
        let (p, q) = body_pose(pose, &limits)?;
        Ok(QueryShape { spec, translation: vec_in(up, p), rotation: quat_in(up, q) })
    }

    fn query_filter(&self, filter: &QueryFilter) -> Result<RawQueryFilter, PhysicsFailure> {
        let member = group(filter.groups.map(|g| g.member), "groups.member")?;
        let collides = group(filter.groups.map(|g| g.collides), "groups.collides")?;
        if filter.exclude_bodies.len() > EXCLUDE_BODIES_MAX {
            return fail(PhysicsError::OutOfRange, "excludeBodies holds at most 64 keys");
        }
        filter.exclude_bodies.iter().try_for_each(|key| check_key(key))?;
        let mut exclude: Vec<u64> = filter.exclude_bodies.iter().filter_map(|key| self.tag_of(key)).collect();
        exclude.sort_unstable();
        exclude.dedup();
        Ok(RawQueryFilter { member, collides, exclude, include_sensors: filter.include_sensors })
    }

    /// The hit with the least distance (to the bit), then the least body key, then collider key.
    fn nearest(&self, hits: &[RawHit]) -> Option<Hit> {
        let named = hits.iter().filter_map(|hit| {
            let (body, collider, _) = self.collider_name(hit.id)?;
            Some((unsigned_zero(hit.dist), body, collider, hit))
        });
        let best = named.min_by(|x, y| x.0.total_cmp(&y.0).then_with(|| (x.1, x.2).cmp(&(y.1, y.2))))?;
        let up = self.desc.up_axis;
        let (dist, body, collider, hit) = best;
        Some(Hit {
            body: body.to_string(),
            collider: collider.to_string(),
            dist: out(dist),
            point: out_vec(vec_out(up, hit.point)),
            normal: out_vec(vec_out(up, hit.normal)),
        })
    }
}
