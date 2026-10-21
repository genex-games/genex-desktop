//! Retained instance groups (renderer pass 2 A.0b; owner decision D4): a static set of
//! transforms a game hands over once and draws every frame with `frame.group(&group)`. The
//! renderer computes the group's instance rows once and uploads them once; an update replaces a
//! range of transforms and only those rows are computed and uploaded again. What a frame shows is
//! what drawing every transform with `frame.cube`, `frame.sphere` or `frame.model` shows.
//!
//! A group is a cheap handle: keep it in the world (made in `on_reset`, updated in `on_update`)
//! and draw it from `on_draw`. Cloning it shares its transforms until one clone is updated.
//!
//! A far field (game systems LOD-19, [`InstanceGroup::with_far`]) thins a group far from the camera
//! on the renderer: past `Far::thin(start, end)`'s start fewer, larger copies, a quarter of them at
//! its end, then none over a fade. Which copies stay is a hash of where each stands, so a moving
//! camera never pops one and a scatter thins evenly. The device class's `far_density` quality
//! keeps a share of that on every group (half on `low` and the high phones).

use std::sync::{Arc, Mutex, PoisonError};

use genex_render::lod_rows::{GpuFarRule, far_rule_usable};
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
    /// A far field whose numbers are out of range ([`InstanceGroup::with_far`]).
    FarInvalid,
}

impl InstanceGroupErrorCode {
    /// The code's wire spelling (`too-many-instances`, `range-out-of-group`, `far-invalid`).
    pub const fn wire(self) -> &'static str {
        match self {
            InstanceGroupErrorCode::TooManyInstances => "too-many-instances",
            InstanceGroupErrorCode::RangeOutOfGroup => "range-out-of-group",
            InstanceGroupErrorCode::FarInvalid => "far-invalid",
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
/// The share of a far field's copies kept at its end (`Far::thin`); the survivors grow to twice
/// their size so the cover holds.
pub const FAR_KEEP: f32 = 0.25;
/// The smallest share a far field may keep at its end.
pub const FAR_KEEP_MIN: f32 = 0.05;
/// How far past its end `Far::thin`'s last copies fade out, as a share of the end distance.
const FAR_FADE_SHARE: f32 = 0.1;

/// A far field (game systems LOD-19, [`InstanceGroup::with_far`]): from `start_m` to `end_m` from
/// the camera the copies thin to `keep` of them (survivors grow to hold the cover), then fade out
/// over `fade_out_m` (0 keeps them to the horizon).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Far {
    /// Where thinning starts, metres from the camera.
    pub start_m: f32,
    /// Where it reaches `keep`.
    pub end_m: f32,
    /// The share kept at `end_m` ([`FAR_KEEP_MIN`]..=1).
    pub keep: f32,
    /// How far past `end_m` the last copies fade out (0: kept to the horizon).
    pub fade_out_m: f32,
}

impl Far {
    /// From `start_m` to `end_m` the copies thin to a quarter ([`FAR_KEEP`]); past `end_m` they
    /// fade out over a tenth of it.
    pub fn thin(start_m: f32, end_m: f32) -> Far {
        Far { start_m, end_m, keep: FAR_KEEP, fade_out_m: end_m * FAR_FADE_SHARE }
    }

    /// How far past `end_m` the last copies fade out (0 keeps them to the horizon).
    pub fn fading_out(self, metres: f32) -> Far {
        Far { fade_out_m: metres, ..self }
    }

    /// Whether the renderer can apply it: finite, `0 <= start < end`, `keep` in
    /// [`FAR_KEEP_MIN`]..=1, a fade of at least 0.
    pub fn is_valid(self) -> bool {
        far_rule_usable(&self.rule()) && self.keep >= FAR_KEEP_MIN
    }

    /// The renderer's rule (genex-render's far field, LOD-18).
    pub(crate) fn rule(self) -> GpuFarRule {
        GpuFarRule { start: self.start_m, end: self.end_m, keep: self.keep, fade_out: self.fade_out_m }
    }
}

/// A retained static instance group: one shape, one material, many transforms.
#[derive(Clone)]
pub struct InstanceGroup {
    inner: Arc<GroupInner>,
}

impl std::fmt::Debug for InstanceGroup {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let inner = &self.inner;
        f.debug_struct("InstanceGroup")
            .field("shape", &inner.shape)
            .field("material", &inner.material)
            .field("instances", &inner.transforms.len())
            .field("far", &inner.far)
            .finish_non_exhaustive()
    }
}

struct GroupInner {
    shape: GroupShape,
    /// `None`: a model's own GLB materials.
    material: Option<Material>,
    transforms: Vec<Transform>,
    /// Its far field, if any (LOD-19).
    far: Option<Far>,
    /// The renderer's groups made so far, one per mesh drawn (a model's parts).
    parts: Mutex<Vec<RenderGroup>>,
}

impl Clone for GroupInner {
    fn clone(&self) -> GroupInner {
        let parts = self.parts.lock().unwrap_or_else(PoisonError::into_inner).clone();
        GroupInner { shape: self.shape.clone(), material: self.material.clone(), transforms: self.transforms.clone(), far: self.far, parts: Mutex::new(parts) }
    }
}

impl PartialEq for InstanceGroup {
    fn eq(&self, other: &InstanceGroup) -> bool {
        let (a, b) = (&self.inner, &other.inner);
        Arc::ptr_eq(a, b) || (a.shape == b.shape && a.material == b.material && a.far == b.far && a.transforms == b.transforms)
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
        Ok(InstanceGroup { inner: Arc::new(GroupInner { shape, material, transforms, far: None, parts: Mutex::new(Vec::new()) }) })
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

    /// This group thinned far from the camera by `far` (LOD-19): renderer-side, stateless and
    /// deterministic (a copy is kept by a hash of where it stands); the sim sees every transform.
    /// Answers a new handle sharing the transforms. Refused `far-invalid` when the numbers are out
    /// of range ([`Far::is_valid`]): this group is unchanged either way.
    pub fn with_far(&self, far: Far) -> Result<InstanceGroup, InstanceGroupError> {
        if !far.is_valid() {
            let Far { start_m, end_m, keep, fade_out_m } = far;
            let detail = format!("start {start_m} m, end {end_m} m, keep {keep}, fade out {fade_out_m} m: 0 <= start < end, keep {FAR_KEEP_MIN}..=1, fade out >= 0, all finite");
            return Err(refused(InstanceGroupErrorCode::FarInvalid, detail));
        }
        let mut group = self.clone();
        Arc::make_mut(&mut group.inner).far = Some(far);
        Ok(group)
    }

    /// Its far field, if any.
    pub fn far(&self) -> Option<Far> {
        self.inner.far
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

    // Far fields (game systems LOD-19): new behaviour, the call did not exist.

    use crate::camera::Camera;
    use crate::math::{Vec3, vec2, vec3};
    use crate::present::{AssetCache, to_scene};
    use genex_render::lod_rows::{FAR_RULE_NONE, far_field};
    use genex_render::scene::{FramePlan, MeshLibrary, Scene};

    /// The frame of `groups` seen from `eye` looking down -z, as the renderer takes it.
    fn scene_of(groups: &[&InstanceGroup], eye: Vec3) -> Scene {
        let mut frame = crate::frame::Frame::default();
        for group in groups {
            frame.group(group);
        }
        to_scene(&frame, &Camera::look_at(eye, eye + vec3(0.0, 0.0, -1.0)), &AssetCache::default())
    }

    fn plan_of(scene: &Scene) -> FramePlan {
        FramePlan::build(scene, &MeshLibrary::new(), 16.0 / 9.0).expect("plan")
    }

    #[test]
    fn far_invalid_changes_nothing() {
        let group = InstanceGroup::cubes(row(64), &Material::color(Color::WHITE)).expect("group");
        let thin = Far::thin(20.0, 200.0);
        let hostile = [
            Far::thin(f32::NAN, 200.0),
            Far::thin(200.0, 200.0),
            Far::thin(300.0, 200.0),
            Far::thin(-1.0, 200.0),
            Far::thin(20.0, f32::INFINITY),
            thin.fading_out(-1.0),
            thin.fading_out(f32::NAN),
            thin.fading_out(f32::INFINITY),
            Far { keep: 0.0, ..thin },
            Far { keep: 0.01, ..thin },
            Far { keep: 1.5, ..thin },
            Far { keep: f32::NAN, ..thin },
        ];
        let before = plan_of(&scene_of(&[&group], Vec3::ZERO));
        for far in hostile {
            let refusal = group.with_far(far).expect_err("refused");
            assert_eq!(refusal.code.wire(), "far-invalid", "{far:?}");
        }
        assert_eq!(group.far(), None, "the group keeps no far field");
        let scene = scene_of(&[&group], Vec3::ZERO);
        assert!(scene.far_rules.is_empty(), "the frame names no far rule");
        let after = plan_of(&scene);
        assert_eq!(after.lod_rows, before.lod_rows, "the same rows, none thinned");
        assert!(after.lod_rows.iter().all(|row| row.far_rule == FAR_RULE_NONE));
        assert!(thin.is_valid() && thin.fading_out(0.0).is_valid() && Far { keep: FAR_KEEP_MIN, ..thin }.is_valid());
    }

    #[test]
    fn far_density_quality_scales_every_group() {
        use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
        use genex_render::presets::preset_quality;
        use genex_render::settings::QualityPreset;
        let white = Material::color(Color::WHITE);
        let (near, far) = (Far::thin(20.0, 200.0), Far::thin(40.0, 400.0).fading_out(0.0));
        let plain = InstanceGroup::spheres(row(16), &white).expect("group");
        let a = InstanceGroup::cubes(row(16), &white).expect("group").with_far(near).expect("a far field");
        let b = InstanceGroup::spheres(row(16), &white).expect("group").with_far(far).expect("a far field");
        let shared = InstanceGroup::cubes(row(8), &white).expect("group").with_far(near).expect("the same field");
        let scene = scene_of(&[&a, &plain, &b, &shared], Vec3::ZERO);
        assert_eq!(scene.far_rules.len(), 2, "two fields, one rule each (an equal field shares its rule)");
        let plan = plan_of(&scene);
        // The plan orders rows by mesh: count the copies under each rule.
        let under = |rule: u32| plan.lod_rows.iter().filter(|row| row.far_rule == rule).count();
        assert_eq!((under(1), under(FAR_RULE_NONE), under(2)), (24, 16, 16), "each copy names its group's rule");
        let rows = [
            (DeviceClass::new(FormFactor::Desktop, PerformanceTier::High), QualityPreset::High, 1.0),
            (DeviceClass::new(FormFactor::Desktop, PerformanceTier::High), QualityPreset::Medium, 0.75),
            (DeviceClass::new(FormFactor::Desktop, PerformanceTier::Low), QualityPreset::Low, 0.5),
            (DeviceClass::new(FormFactor::Mobile, PerformanceTier::Mid), QualityPreset::Low, 0.35),
        ];
        for (class, preset, density) in rows {
            let quality = preset_quality(preset, class);
            assert_eq!(quality.lod.far_density, density, "{} {preset:?}", class.wire());
            let mut plan = plan_of(&scene);
            plan.thin_far_rules(quality.lod.far_density);
            for (rule, field) in plan.far_rules.iter().zip([near, far]) {
                assert_eq!((rule.start, rule.end, rule.fade_out), (field.start_m, field.end_m, field.fade_out_m));
                assert_eq!(rule.keep, field.keep * density, "{} {preset:?}: every group keeps {density} of its share", class.wire());
            }
        }
    }

    #[test]
    fn past_the_frames_far_rules_a_group_draws_unthinned() {
        use genex_render::lod_rows::FAR_RULES_MAX;
        let white = Material::color(Color::WHITE);
        let groups: Vec<InstanceGroup> =
            (0..=FAR_RULES_MAX).map(|k| InstanceGroup::cubes(row(2), &white).expect("group").with_far(Far::thin(10.0 + k as f32, 300.0)).expect("a far field")).collect();
        let scene = scene_of(&groups.iter().collect::<Vec<_>>(), Vec3::ZERO);
        assert_eq!(scene.far_rules.len(), FAR_RULES_MAX);
        let rules: Vec<u32> = plan_of(&scene).lod_rows.iter().map(|row| row.far_rule).collect();
        let expected: Vec<u32> = (1..=FAR_RULES_MAX as u32).chain([FAR_RULE_NONE]).flat_map(|rule| [rule; 2]).collect();
        assert_eq!(rules, expected, "the 17th field's copies are left whole, never put under another rule");
    }

    #[test]
    fn a_scatter_group_with_far_thins_evenly() {
        use crate::terrain::{Scatter, Terrain};
        let terrain = Terrain::from_fn([257, 257], vec2(-256.0, -256.0), 2.0, |_, _| 0.0).expect("terrain");
        let placed = terrain.scatter(&Scatter::new(0.05, &[0]).with_seed(7), vec2(-256.0, -256.0), vec2(256.0, 256.0));
        assert!(placed.len() > 10_000, "{} placed", placed.len());
        let field = Far::thin(20.0, 200.0).fading_out(0.0);
        let group = InstanceGroup::cubes(placed, &Material::color(Color::WHITE)).expect("group").with_far(field).expect("a far field");
        let eye = vec3(0.0, 2.0, 0.0);
        let plan = plan_of(&scene_of(&[&group], eye));
        let rule = plan.far_rules[0];
        // Past the end every copy keeps a quarter in expectation: in each of 8 sectors of the ring
        // from 210 m to 250 m the drawn share is near a quarter, and the cover (share x grow^2)
        // near one.
        let mut sectors = [(0.0f64, 0.0f64, 0u32); 8];
        for lod in &plan.lod_rows {
            let [x, _, z, _] = lod.origin;
            let distance = (x * x + z * z).sqrt();
            if !(210.0..250.0).contains(&distance) {
                continue;
            }
            let thinned = far_field(&rule, lod.origin, eye.to_array());
            let angle = libm::atan2f(z, x) + std::f32::consts::PI;
            let sector = ((angle / std::f32::consts::TAU * 8.0) as usize).min(7);
            let (share, cover, count) = &mut sectors[sector];
            *share += f64::from(thinned.share);
            *cover += f64::from(thinned.share * thinned.grow * thinned.grow);
            *count += 1;
        }
        for (at, (share, cover, count)) in sectors.iter().enumerate() {
            let n = f64::from(*count);
            assert!(*count > 200, "sector {at}: {count} copies");
            assert!((share / n - f64::from(field.keep)).abs() < 0.07, "sector {at}: drawn share {:.3}", share / n);
            assert!((cover / n - 1.0).abs() < 0.28, "sector {at}: cover {:.3}", cover / n);
        }
        // Nearer than the start nothing thins.
        let near = plan.lod_rows.iter().filter(|lod| (lod.origin[0] * lod.origin[0] + lod.origin[2] * lod.origin[2]).sqrt() < 15.0);
        assert!(near.map(|lod| far_field(&rule, lod.origin, eye.to_array())).all(|thinned| !thinned.thinned && thinned.share == 1.0));
    }
}
