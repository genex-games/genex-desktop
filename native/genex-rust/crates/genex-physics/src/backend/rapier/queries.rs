//! Scene queries (§13) against the world as it stands now.
//!
//! Rapier's broad-phase tree and its colliders' world poses are brought up to date by its step. A
//! body a command moved, inserted or froze since (a "stale" body) is not there yet, so its
//! colliders are skipped in the tree and tested directly at the pose its body holds now. Every
//! collider the query reaches is returned; the core picks the answer by distance, then key.

use rapier3d::geometry::{Collider, ColliderHandle};
use rapier3d::math::{Pose, Vector};
use rapier3d::parry::bounding_volume::{Aabb, BoundingVolume};
use rapier3d::parry::query::{Ray, ShapeCastOptions, cast_shapes, intersection_test};
use rapier3d::pipeline::QueryFilter;

use super::super::{BackendRefusal, ColliderId, RawHit, RawQueryFilter, ShapeAt};
use super::events::collider_id;
use super::{RapierBackend, pose, shape_builder, vector};

/// Whether `filter` lets a query see `collider` (§13, groups by §6.2's rule).
fn passes(collider: &Collider, filter: &RawQueryFilter) -> bool {
    if collider.is_sensor() && !filter.include_sensors {
        return false;
    }
    let groups = collider.collision_groups();
    let (member, collides) = (groups.memberships.bits() as u16, groups.filter.bits() as u16);
    let groups_meet = member & filter.collides != 0 && filter.member & collides != 0;
    groups_meet && filter.exclude.binary_search(&collider_id(collider).tag).is_err()
}

impl RapierBackend {
    fn is_stale(&self, collider: &Collider) -> bool {
        collider.parent().is_some_and(|body| self.stale.contains(&body))
    }

    /// The colliders of stale bodies that `filter` passes, each at its body's current pose.
    fn stale_colliders(&self, filter: &RawQueryFilter) -> Vec<(&Collider, Pose)> {
        let mut out = Vec::new();
        for body in &self.stale {
            let Some(rb) = self.world.bodies.get(*body) else { continue };
            for handle in rb.colliders() {
                let Some(collider) = self.world.colliders.get(*handle) else { continue };
                if passes(collider, filter) {
                    let local = collider.position_wrt_parent().copied().unwrap_or(Pose::IDENTITY);
                    out.push((collider, *rb.position() * local));
                }
            }
        }
        out
    }

    /// Every up-to-date collider `filter` passes whose tree box meets `aabb`, at its pose.
    fn fresh_colliders<'a>(&'a self, aabb: Aabb, filter: &RawQueryFilter) -> Vec<(&'a Collider, Pose)> {
        let predicate = |_: ColliderHandle, collider: &Collider| passes(collider, filter) && !self.is_stale(collider);
        let pipeline = self.world.query_pipeline_with_filter(QueryFilter::default().predicate(&predicate));
        let handles: Vec<ColliderHandle> = pipeline.intersect_aabb_conservative(aabb).map(|(handle, _)| handle).collect();
        let colliders = handles.into_iter().filter_map(|handle| self.world.colliders.get(handle));
        colliders.map(|collider| (collider, *collider.position())).collect()
    }

    pub(super) fn query_ray(&self, origin: [f32; 3], dir: [f32; 3], max_dist: f32, filter: &RawQueryFilter) -> Vec<RawHit> {
        let ray = Ray::new(vector(origin), vector(dir));
        let hit_of = |collider: &Collider, toi: f32, normal: Vector| RawHit {
            id: collider_id(collider),
            dist: toi,
            point: ray.point_at(toi).to_array(),
            normal: normal.to_array(),
        };
        let predicate = |_: ColliderHandle, collider: &Collider| passes(collider, filter) && !self.is_stale(collider);
        let pipeline = self.world.query_pipeline_with_filter(QueryFilter::default().predicate(&predicate));
        let fresh = pipeline.intersect_ray(ray, max_dist, true).map(|(_, c, hit)| hit_of(c, hit.time_of_impact, hit.normal));
        let mut hits: Vec<RawHit> = fresh.collect();
        for (collider, at) in self.stale_colliders(filter) {
            if let Some(hit) = collider.shape().cast_ray_and_get_normal(&at, &ray, max_dist, true) {
                hits.push(hit_of(collider, hit.time_of_impact, hit.normal));
            }
        }
        hits
    }

    pub(super) fn query_cast(
        &self,
        at: ShapeAt<'_>,
        dir: [f32; 3],
        max_dist: f32,
        filter: &RawQueryFilter,
    ) -> Result<Vec<RawHit>, BackendRefusal> {
        let shape = shape_builder(at.shape).ok_or(BackendRefusal::BadShape)?.shape;
        let start = pose(at.translation, at.rotation);
        let velocity = vector(dir);
        let end = Pose::from_parts(start.translation + velocity * max_dist, start.rotation);
        let swept = shape.compute_aabb(&start).merged(&shape.compute_aabb(&end));
        let mut candidates = self.fresh_colliders(swept, filter);
        candidates.extend(self.stale_colliders(filter));
        let options = ShapeCastOptions {
            max_time_of_impact: max_dist,
            target_distance: 0.0,
            stop_at_penetration: true,
            compute_impact_geometry_on_penetration: true,
        };
        let mut hits = Vec::new();
        for (collider, place) in candidates {
            let cast = cast_shapes(&start, velocity, &*shape, &place, Vector::ZERO, collider.shape(), options);
            let Ok(Some(hit)) = cast else { continue };
            let point = (place * hit.witness2).to_array();
            let normal = (place.rotation * hit.normal2).to_array();
            hits.push(RawHit { id: collider_id(collider), dist: hit.time_of_impact, point, normal });
        }
        Ok(hits)
    }

    pub(super) fn query_overlap(&self, at: ShapeAt<'_>, filter: &RawQueryFilter) -> Result<Vec<ColliderId>, BackendRefusal> {
        let shape = shape_builder(at.shape).ok_or(BackendRefusal::BadShape)?.shape;
        let place = pose(at.translation, at.rotation);
        let mut candidates = self.fresh_colliders(shape.compute_aabb(&place), filter);
        candidates.extend(self.stale_colliders(filter));
        let touching = |(collider, other): &(&Collider, Pose)| {
            intersection_test(&place, &*shape, other, collider.shape()).is_ok_and(|hit| hit.intersecting)
        };
        Ok(candidates.iter().filter(|candidate| touching(candidate)).map(|(collider, _)| collider_id(collider)).collect())
    }
}
