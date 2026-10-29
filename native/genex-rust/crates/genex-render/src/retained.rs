//! Retained static instance groups (renderer pass 2 A.0b, LG-07 step 2; owner decision D4: a
//! facade API). A game hands a static set of transforms over once ([`InstanceGroup::new`]) and
//! draws the group each frame ([`crate::scene::Scene::draw_group`]): the renderer computes the
//! group's instance-table rows once (and again only for the rows an update changed), never
//! regroups its instances by mesh per frame, and uploads its rows only when they changed or moved
//! in the instance table ([`RetainedSpan`], the renderer's dirty-range upload). Godot's MultiMesh
//! and Bevy's retained render world are the pattern (MIT, MIT OR Apache-2.0; pattern only).
//!
//! A group is a cheap handle (an `Arc`): cloning it, or drawing it into many frames' scenes,
//! shares its rows. [`InstanceGroup::update`] replaces a range of its transforms, copying the
//! rows first when a scene still holds them, and records the range, so the next upload writes
//! only the rows that changed.
//!
//! A group's LOD rows (game systems LOD-02, [`crate::lod_rows`]) are computed the same way: once
//! per version, bounds and [`DrawLod`], an update recomputing only its range, and uploaded over
//! the instance rows' dirty ranges.

use std::ops::Range;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use crate::error::{RenderCode, RenderError};
use crate::instance::instance_row;
use crate::layout::GpuInstance;
use crate::lod_rows::{DrawLod, GpuLodRow, lod_row};
use crate::pbr::Material;
use crate::scene::MeshId;

/// The most transforms one group holds: what one upload of its rows may carry
/// (`caps::UPLOAD_MAX_BYTES_PER_FRAME` over the 160-byte row).
pub const GROUP_MAX_INSTANCES: usize = (crate::caps::UPLOAD_MAX_BYTES_PER_FRAME / size_of::<GpuInstance>() as u64) as usize;
/// Updates a group remembers the ranges of: an upload more versions behind writes the whole group.
const CHANGES_KEPT: usize = 16;

static NEXT_GROUP: AtomicU64 = AtomicU64::new(1);

/// A retained static instance group: one mesh, one material, many transforms. Two groups are
/// equal when they draw the same mesh, material and transforms (what a frame shows).
#[derive(Clone)]
pub struct InstanceGroup {
    inner: Arc<GroupInner>,
}

impl std::fmt::Debug for InstanceGroup {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let inner = &self.inner;
        f.debug_struct("InstanceGroup").field("id", &inner.id).field("version", &inner.version).field("mesh", &inner.mesh).field("instances", &inner.models.len()).finish_non_exhaustive()
    }
}

struct GroupInner {
    id: u64,
    mesh: MeshId,
    material: Material,
    models: Vec<[f32; 16]>,
    /// Bumped by every update.
    version: u64,
    /// The last updates' versions and the transforms each replaced.
    changes: Vec<(u64, Range<u32>)>,
    /// The rows of `models` for the bounds they were computed with.
    rows: Mutex<Option<GroupRows>>,
    /// The LOD rows of `models` for the bounds and draw LOD they were computed with (LOD-02).
    lod_rows: Mutex<Option<GroupLodRows>>,
}

/// A group's computed LOD rows (game systems LOD-02).
#[derive(Clone, Debug)]
struct GroupLodRows {
    bounds: ([f32; 3], f32),
    lod: DrawLod,
    version: u64,
    rows: Arc<Vec<GpuLodRow>>,
}

/// A group's computed rows (material index 0; a plan writes the frame's own).
#[derive(Clone, Debug)]
struct GroupRows {
    bounds: ([f32; 3], f32),
    version: u64,
    rows: Arc<Vec<GpuInstance>>,
}

impl Clone for GroupInner {
    fn clone(&self) -> GroupInner {
        let rows = self.rows.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
        let lod_rows = self.lod_rows.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
        GroupInner {
            id: self.id,
            mesh: self.mesh,
            material: self.material,
            models: self.models.clone(),
            version: self.version,
            changes: self.changes.clone(),
            rows: Mutex::new(rows),
            lod_rows: Mutex::new(lod_rows),
        }
    }
}

impl PartialEq for InstanceGroup {
    fn eq(&self, other: &InstanceGroup) -> bool {
        let (a, b) = (&self.inner, &other.inner);
        Arc::ptr_eq(a, b) || (a.mesh == b.mesh && a.material == b.material && a.models == b.models)
    }
}

fn too_many(count: usize) -> RenderError {
    RenderError::refused(RenderCode::BufferTooLarge, format!("an instance group of {count} transforms, at most {GROUP_MAX_INSTANCES}"))
}

impl InstanceGroup {
    /// A group of `models` (column-major) drawing `mesh` with `material`. Refused
    /// `buffer-too-large` past [`GROUP_MAX_INSTANCES`].
    pub fn new(mesh: MeshId, material: Material, models: Vec<[f32; 16]>) -> Result<InstanceGroup, RenderError> {
        if models.len() > GROUP_MAX_INSTANCES {
            return Err(too_many(models.len()));
        }
        let id = NEXT_GROUP.fetch_add(1, Ordering::Relaxed);
        let inner = GroupInner { id, mesh, material, models, version: 0, changes: Vec::new(), rows: Mutex::new(None), lod_rows: Mutex::new(None) };
        Ok(InstanceGroup { inner: Arc::new(inner) })
    }

    /// Replace the transforms from `first` with `models`: the next frame uploads only these rows.
    /// Refused `buffer-too-large` when the range runs past the group.
    pub fn update(&mut self, first: usize, models: &[[f32; 16]]) -> Result<(), RenderError> {
        let end = first.checked_add(models.len()).filter(|end| *end <= self.inner.models.len());
        let Some(end) = end else {
            let detail = format!("transforms {first}..+{} of a group of {}", models.len(), self.inner.models.len());
            return Err(RenderError::refused(RenderCode::BufferTooLarge, detail));
        };
        if models.is_empty() {
            return Ok(());
        }
        let inner = Arc::make_mut(&mut self.inner);
        inner.models[first..end].copy_from_slice(models);
        inner.version += 1;
        inner.changes.push((inner.version, first as u32..end as u32));
        if inner.changes.len() > CHANGES_KEPT {
            inner.changes.remove(0);
        }
        Ok(())
    }

    /// The group's identity (stable across updates).
    pub fn id(&self) -> u64 {
        self.inner.id
    }

    /// Its version: 0 when made, one more per update.
    pub fn version(&self) -> u64 {
        self.inner.version
    }

    /// The mesh.
    pub fn mesh(&self) -> MeshId {
        self.inner.mesh
    }

    /// The material.
    pub fn material(&self) -> Material {
        self.inner.material
    }

    /// The transforms.
    pub fn models(&self) -> &[[f32; 16]] {
        &self.inner.models
    }

    /// Transforms in the group.
    pub fn len(&self) -> usize {
        self.inner.models.len()
    }

    /// Whether it holds no transform.
    pub fn is_empty(&self) -> bool {
        self.inner.models.is_empty()
    }

    /// The transforms the updates after `version` replaced, merged into one range, or `None` when
    /// they are not all remembered (the whole group is then new).
    pub fn changed_since(&self, version: u64) -> Option<Range<u32>> {
        if version == self.inner.version {
            return Some(0..0);
        }
        let first_kept = self.inner.changes.first().map_or(u64::MAX, |(at, _)| *at);
        if version >= self.inner.version || version + 1 < first_kept {
            return None;
        }
        let ranges = self.inner.changes.iter().filter(|(at, _)| *at > version).map(|(_, range)| range.clone());
        ranges.reduce(|a, b| a.start.min(b.start)..a.end.max(b.end))
    }

    /// The group's instance rows for a mesh whose model-space sphere is `center`/`radius`
    /// (material index 0), computed once per version and bounds; an update recomputes only the
    /// rows it changed when the previous rows are at hand.
    pub fn rows(&self, center: [f32; 3], radius: f32) -> Arc<Vec<GpuInstance>> {
        let mut cached = self.inner.rows.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let bounds = (center, radius);
        if let Some(held) = cached.as_ref().filter(|held| held.bounds == bounds && held.version == self.inner.version) {
            return held.rows.clone();
        }
        let row = |model: &[f32; 16]| instance_row(model, center, radius, 0);
        let changed = cached.as_ref().filter(|held| held.bounds == bounds).and_then(|held| Some((held, self.changed_since(held.version)?)));
        let rows = match changed {
            Some((held, range)) => {
                let mut rows = Arc::unwrap_or_clone(held.rows.clone());
                for at in range {
                    rows[at as usize] = row(&self.inner.models[at as usize]);
                }
                rows
            }
            None => self.inner.models.iter().map(row).collect(),
        };
        let rows = Arc::new(rows);
        *cached = Some(GroupRows { bounds, version: self.inner.version, rows: rows.clone() });
        rows
    }

    /// The group's LOD rows (game systems LOD-02) for a mesh whose model-space sphere is
    /// `center`/`radius`, drawn with `lod`: computed once per version, bounds and `lod`; an
    /// update recomputes only the rows it changed when the previous rows are at hand.
    pub fn lod_rows(&self, center: [f32; 3], radius: f32, lod: &DrawLod) -> Arc<Vec<GpuLodRow>> {
        let rows = self.rows(center, radius);
        let mut cached = self.inner.lod_rows.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let bounds = (center, radius);
        let same = |held: &&GroupLodRows| held.bounds == bounds && held.lod == *lod;
        if let Some(held) = cached.as_ref().filter(same).filter(|held| held.version == self.inner.version) {
            return held.rows.clone();
        }
        let row = |at: usize| lod_row(&self.inner.models[at], rows[at].bounds, lod);
        let changed = cached.as_ref().filter(same).and_then(|held| Some((held, self.changed_since(held.version)?)));
        let lod_rows = match changed {
            Some((held, range)) => {
                let mut lod_rows = Arc::unwrap_or_clone(held.rows.clone());
                for at in range {
                    lod_rows[at as usize] = row(at as usize);
                }
                lod_rows
            }
            None => (0..self.inner.models.len()).map(row).collect(),
        };
        let lod_rows = Arc::new(lod_rows);
        *cached = Some(GroupLodRows { bounds, lod: *lod, version: self.inner.version, rows: lod_rows.clone() });
        lod_rows
    }
}

/// Where a drawn group's rows landed in a frame's instance table: what the renderer compares with
/// the last upload to write only rows that changed (renderer pass 2 A.0b).
#[derive(Clone, Debug, PartialEq)]
pub struct RetainedSpan {
    /// The group as the frame drew it (its id and version).
    pub group: InstanceGroup,
    /// The first instance-table row.
    pub first_row: u32,
    /// Rows.
    pub rows: u32,
    /// The material-table row its rows carry.
    pub material: u32,
    /// The mesh's model-space sphere its rows' bounds were computed with.
    pub bounds: ([f32; 3], f32),
    /// The draw LOD its LOD rows were computed with (game systems LOD-02).
    pub lod: DrawLod,
    /// The wind words its rows carry (model wind; 0 for a group that does not sway).
    pub wind: [u32; 3],
}

impl RetainedSpan {
    /// The rows of this span that differ from `last`'s, the same group's span of the last upload
    /// (relative to the span's first row): none when it lies where it lay with the same material,
    /// bounds, draw LOD and version, the updates' range when only its group changed since, else
    /// all of it.
    pub fn changed_since(&self, last: &RetainedSpan) -> Range<u32> {
        let placed = self.group.id() == last.group.id() && self.first_row == last.first_row && self.rows == last.rows;
        let same = placed && self.material == last.material && self.bounds == last.bounds && self.lod == last.lod && self.wind == last.wind;
        if !same {
            return 0..self.rows;
        }
        self.group.changed_since(last.group.version()).unwrap_or(0..self.rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene::translation;

    fn models(count: usize) -> Vec<[f32; 16]> {
        (0..count).map(|i| translation(i as f32, 0.0, -(i as f32))).collect()
    }

    #[test]
    fn a_groups_rows_are_the_instance_rows_and_an_update_recomputes_only_its_range() {
        let mut group = InstanceGroup::new(MeshId::CUBE, Material::color([200; 4]), models(100)).expect("group");
        let rows = group.rows([0.0; 3], 0.9);
        assert_eq!(rows.len(), 100);
        for (row, model) in rows.iter().zip(group.models()) {
            assert_eq!(*row, instance_row(model, [0.0; 3], 0.9, 0));
        }
        assert!(Arc::ptr_eq(&rows, &group.rows([0.0; 3], 0.9)), "computed once per version");
        let held = group.clone();
        group.update(10, &models(3)).expect("update");
        assert_eq!((held.version(), group.version()), (0, 1), "the held handle keeps its rows");
        assert_eq!(group.changed_since(0), Some(10..13));
        let updated = group.rows([0.0; 3], 0.9);
        assert_eq!(updated[10], instance_row(&models(3)[0], [0.0; 3], 0.9, 0));
        assert_eq!(updated[50], rows[50]);
        assert_eq!(held.rows([0.0; 3], 0.9)[10], rows[10]);
        group.update(90, &models(2)).expect("update");
        assert_eq!(group.changed_since(0), Some(10..92), "two updates merge into one range");
        assert_eq!(group.changed_since(2), Some(0..0));
        assert_eq!(group.changed_since(5), None, "a version it never had");
    }

    #[test]
    fn hostile_group_ranges_are_refused_and_change_nothing() {
        let mut group = InstanceGroup::new(MeshId::CUBE, Material::color([200; 4]), models(4)).expect("group");
        for (first, count) in [(3, 2), (5, 0), (usize::MAX, 1)] {
            assert!(group.update(first, &models(count)).is_err(), "{first}+{count}");
        }
        assert_eq!((group.version(), group.models()), (0, models(4).as_slice()));
        assert!(InstanceGroup::new(MeshId::CUBE, Material::color([1; 4]), vec![[0.0; 16]; GROUP_MAX_INSTANCES + 1]).is_err());
        for _ in 0..CHANGES_KEPT + 2 {
            group.update(0, &models(1)).expect("update");
        }
        assert_eq!(group.changed_since(0), None, "an upload that far behind writes the whole group");
    }
}
