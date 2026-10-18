//! Retained instance groups (renderer pass 2 A.0b; owner decision D4): a static set of
//! transforms a game hands over once and draws every frame with `frame.group(&group)`. The
//! renderer computes the group's instance rows once and uploads them once; an update replaces a
//! range of transforms and only those rows are computed and uploaded again. What a frame shows is
//! what drawing every transform with `frame.cube`, `frame.sphere` or `frame.model` shows.
//!
//! A group is a cheap handle: keep it in the world (made in `on_reset`, updated in `on_update`)
//! and draw it from `on_draw`. Cloning it shares its transforms until one clone is updated.

use std::sync::{Arc, Mutex, PoisonError};

use genex_render::retained::{GROUP_MAX_INSTANCES, InstanceGroup as RenderGroup};
use genex_render::scene::MeshId;

use crate::frame::{Material, Transform};
use crate::gfx::Model;

/// What an instance group draws at each transform.
#[derive(Clone, Debug, PartialEq)]
pub enum GroupShape {
    /// A model from the game's assets (the magenta checker when it is missing).
    Model(Model),
    /// The unit cube.
    Cube,
    /// A sphere of radius 1 (the transform's scale gives another radius).
    Sphere,
}

/// Why an instance group call was refused (nothing changed).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InstanceGroupErrorCode {
    /// More transforms than one group holds ([`INSTANCE_GROUP_MAX`]).
    TooManyInstances,
    /// An update's range runs past the group's transforms.
    RangeOutOfGroup,
}

impl InstanceGroupErrorCode {
    /// The code's wire spelling (`too-many-instances`, `range-out-of-group`).
    pub const fn wire(self) -> &'static str {
        match self {
            InstanceGroupErrorCode::TooManyInstances => "too-many-instances",
            InstanceGroupErrorCode::RangeOutOfGroup => "range-out-of-group",
        }
    }
}

/// A refused instance group call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstanceGroupError {
    /// What was refused.
    pub code: InstanceGroupErrorCode,
    /// The numbers involved.
    pub detail: String,
}

impl std::fmt::Display for InstanceGroupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code.wire(), self.detail)
    }
}

impl std::error::Error for InstanceGroupError {}

/// The most transforms one group holds (one upload's worth of rows).
pub const INSTANCE_GROUP_MAX: usize = GROUP_MAX_INSTANCES;

/// A retained static instance group: one shape, one material, many transforms.
#[derive(Clone)]
pub struct InstanceGroup {
    inner: Arc<GroupInner>,
}

impl std::fmt::Debug for InstanceGroup {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let inner = &self.inner;
        f.debug_struct("InstanceGroup").field("shape", &inner.shape).field("material", &inner.material).field("instances", &inner.transforms.len()).finish_non_exhaustive()
    }
}

struct GroupInner {
    shape: GroupShape,
    /// `None`: a model's own GLB materials.
    material: Option<Material>,
    transforms: Vec<Transform>,
    /// The renderer's groups made so far, one per mesh drawn (a model's parts).
    parts: Mutex<Vec<RenderGroup>>,
}

impl Clone for GroupInner {
    fn clone(&self) -> GroupInner {
        let parts = self.parts.lock().unwrap_or_else(PoisonError::into_inner).clone();
        GroupInner { shape: self.shape.clone(), material: self.material.clone(), transforms: self.transforms.clone(), parts: Mutex::new(parts) }
    }
}

impl PartialEq for InstanceGroup {
    fn eq(&self, other: &InstanceGroup) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner) || (self.inner.shape == other.inner.shape && self.inner.material == other.inner.material && self.inner.transforms == other.inner.transforms)
    }
}

fn refused(code: InstanceGroupErrorCode, detail: String) -> InstanceGroupError {
    InstanceGroupError { code, detail }
}

impl InstanceGroup {
    fn new(shape: GroupShape, material: Option<Material>, transforms: Vec<Transform>) -> Result<InstanceGroup, InstanceGroupError> {
        if transforms.len() > INSTANCE_GROUP_MAX {
            return Err(refused(InstanceGroupErrorCode::TooManyInstances, format!("{} transforms, at most {INSTANCE_GROUP_MAX}", transforms.len())));
        }
        Ok(InstanceGroup { inner: Arc::new(GroupInner { shape, material, transforms, parts: Mutex::new(Vec::new()) }) })
    }

    /// Unit cubes at `transforms`, drawn with `material`.
    pub fn cubes(transforms: Vec<Transform>, material: &Material) -> Result<InstanceGroup, InstanceGroupError> {
        InstanceGroup::new(GroupShape::Cube, Some(material.clone()), transforms)
    }

    /// Spheres of radius 1 at `transforms` (scale them for another radius), drawn with `material`.
    pub fn spheres(transforms: Vec<Transform>, material: &Material) -> Result<InstanceGroup, InstanceGroupError> {
        InstanceGroup::new(GroupShape::Sphere, Some(material.clone()), transforms)
    }

    /// `model` at `transforms`, with the materials its GLB names.
    pub fn models(model: &Model, transforms: Vec<Transform>) -> Result<InstanceGroup, InstanceGroupError> {
        InstanceGroup::new(GroupShape::Model(model.clone()), None, transforms)
    }

    /// `model` at `transforms`, with `material` instead of its GLB's.
    pub fn models_with(model: &Model, transforms: Vec<Transform>, material: &Material) -> Result<InstanceGroup, InstanceGroupError> {
        InstanceGroup::new(GroupShape::Model(model.clone()), Some(material.clone()), transforms)
    }

    /// Replace the transforms from `first` with `transforms`: the next frame computes and uploads
    /// only these. Refused `range-out-of-group` when the range runs past the group.
    pub fn update(&mut self, first: usize, transforms: &[Transform]) -> Result<(), InstanceGroupError> {
        let end = first.checked_add(transforms.len()).filter(|end| *end <= self.inner.transforms.len());
        let Some(end) = end else {
            let detail = format!("transforms {first}..+{} of a group of {}", transforms.len(), self.inner.transforms.len());
            return Err(refused(InstanceGroupErrorCode::RangeOutOfGroup, detail));
        };
        let inner = Arc::make_mut(&mut self.inner);
        inner.transforms[first..end].copy_from_slice(transforms);
        let models: Vec<[f32; 16]> = transforms.iter().map(Transform::to_cols_array).collect();
        for part in inner.parts.get_mut().unwrap_or_else(PoisonError::into_inner) {
            // In range by the check above, so the renderer's group accepts it.
            let _ = part.update(first, &models);
        }
        Ok(())
    }

    /// What it draws.
    pub fn shape(&self) -> &GroupShape {
        &self.inner.shape
    }

    /// Its material (`None`: a model's own).
    pub fn material(&self) -> Option<&Material> {
        self.inner.material.as_ref()
    }

    /// Its transforms.
    pub fn transforms(&self) -> &[Transform] {
        &self.inner.transforms
    }

    /// Transforms in the group.
    pub fn len(&self) -> usize {
        self.inner.transforms.len()
    }

    /// Whether it holds no transform.
    pub fn is_empty(&self) -> bool {
        self.inner.transforms.is_empty()
    }

    /// The renderer's group of this group's transforms drawing `mesh` (made on first use, kept
    /// for the next frames: its rows are computed once).
    pub(crate) fn render_group(&self, mesh: MeshId) -> RenderGroup {
        let mut parts = self.inner.parts.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(part) = parts.iter().find(|part| part.mesh() == mesh) {
            return part.clone();
        }
        let models = self.inner.transforms.iter().map(Transform::to_cols_array).collect();
        // Within GROUP_MAX_INSTANCES by construction, so the renderer's group is never refused.
        let material = genex_render::scene::Material::color([255; 4]);
        let Ok(part) = RenderGroup::new(mesh, material, models) else { unreachable!("an instance group within its cap") };
        parts.push(part.clone());
        part
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::Color;

    fn row(count: usize) -> Vec<Transform> {
        (0..count).map(|i| Transform::from_xyz(i as f32, 0.0, 0.0)).collect()
    }

    #[test]
    fn an_update_reaches_the_renderers_group_and_a_held_clone_keeps_its_transforms() {
        let mut group = InstanceGroup::cubes(row(10), &Material::color(Color::WHITE)).expect("group");
        let part = group.render_group(MeshId::CUBE);
        let held = group.clone();
        group.update(2, &row(3)[1..]).expect("update");
        assert_eq!(group.transforms()[2], Transform::from_xyz(1.0, 0.0, 0.0));
        assert_eq!(held.transforms()[2], Transform::from_xyz(2.0, 0.0, 0.0), "the clone keeps its own");
        let updated = group.render_group(MeshId::CUBE);
        assert_eq!((part.version(), updated.version()), (0, 1));
        assert_eq!(updated.changed_since(0), Some(2..4));
        assert_eq!(updated.models()[2], Transform::from_xyz(1.0, 0.0, 0.0).to_cols_array());
    }

    #[test]
    fn hostile_group_calls_are_refused_with_their_codes_and_change_nothing() {
        let mut group = InstanceGroup::spheres(row(4), &Material::color(Color::WHITE)).expect("group");
        for (first, count) in [(3, 2), (5, 0), (usize::MAX, 1)] {
            let refusal = group.update(first, &row(count)).expect_err("refused");
            assert_eq!(refusal.code.wire(), "range-out-of-group");
        }
        assert_eq!(group.transforms(), row(4).as_slice());
        let too_many = InstanceGroup::cubes(vec![Transform::IDENTITY; INSTANCE_GROUP_MAX + 1], &Material::color(Color::WHITE)).expect_err("refused");
        assert_eq!(too_many.code.wire(), "too-many-instances");
    }
}
