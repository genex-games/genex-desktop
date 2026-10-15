//! Retained instance groups through the facade (renderer pass 2 A.0b; owner decision D4): what
//! `frame.group(&group)` draws reaches the renderer's scene as one retained group per mesh, and
//! plans the instance rows that drawing every transform one by one plans; a missing model draws
//! the checker at every transform; an update reaches the renderer's group.

use genex::present::{AssetCache, to_scene};
use genex::{Camera, Color, Frame, InstanceGroup, Material, Model, Transform};
use genex_render::scene::{FramePlan, MeshId, MeshLibrary};

fn ring(count: usize) -> Vec<Transform> {
    (0..count).map(|i| Transform::from_xyz((i % 40) as f32 - 20.0, 0.5, -((i / 40) as f32))).collect()
}

fn plan_of(frame: &Frame) -> FramePlan {
    let scene = to_scene(frame, &Camera::DEFAULT, &AssetCache::default());
    FramePlan::build(&scene, &MeshLibrary::new(), 16.0 / 9.0).expect("plan")
}

#[test]
fn a_group_plans_the_rows_its_transforms_drawn_one_by_one_plan() {
    let material = Material::color(Color::rgb(180, 120, 90));
    let transforms = ring(400);
    let group = InstanceGroup::cubes(transforms.clone(), &material).expect("group");
    let mut grouped = Frame::default();
    grouped.group(&group);
    grouped.sphere(genex::glam::Vec3::new(0.0, 2.0, 0.0), 0.5, Color::WHITE);
    let mut loose = Frame::default();
    for transform in &transforms {
        loose.cube_with(*transform, &material);
    }
    loose.sphere(genex::glam::Vec3::new(0.0, 2.0, 0.0), 0.5, Color::WHITE);
    let (retained, single) = (plan_of(&grouped), plan_of(&loose));
    assert_eq!(retained.instances, single.instances);
    assert_eq!((retained.batches.clone(), retained.materials.clone()), (single.batches.clone(), single.materials.clone()));
    assert_eq!(retained.retained.len(), 1, "one retained span");
    assert_eq!(grouped.draw_calls(), 2, "a group is one logical draw");
    let scene = to_scene(&grouped, &Camera::DEFAULT, &AssetCache::default());
    assert_eq!(scene.groups.len(), 1);
    assert_eq!(scene.groups[0].group.mesh(), MeshId::CUBE);
}

#[test]
fn a_missing_model_group_draws_the_checker_at_every_transform() {
    let group = InstanceGroup::models(&Model::default(), ring(30)).expect("group");
    let mut frame = Frame::default();
    frame.group(&group);
    let scene = to_scene(&frame, &Camera::DEFAULT, &AssetCache::default());
    assert_eq!(scene.groups.len(), 1);
    assert_eq!((scene.groups[0].group.mesh(), scene.groups[0].group.len()), (MeshId::CUBE, 30));
    assert_eq!(scene.groups[0].material, genex_render::scene::Material::missing());
}

#[test]
fn an_update_reaches_the_renderers_group_and_only_its_rows_change() {
    let mut group = InstanceGroup::spheres(ring(100), &Material::color(Color::WHITE)).expect("group");
    let mut frame = Frame::default();
    frame.group(&group);
    let before = to_scene(&frame, &Camera::DEFAULT, &AssetCache::default()).groups[0].group.clone();
    group.update(10, &[Transform::from_xyz(5.0, 5.0, 5.0)]).expect("update");
    let mut frame = Frame::default();
    frame.group(&group);
    let after = to_scene(&frame, &Camera::DEFAULT, &AssetCache::default()).groups[0].group.clone();
    assert_eq!(after.id(), before.id(), "the same retained group");
    assert_eq!(after.changed_since(before.version()), Some(10..11));
    assert_eq!(after.models()[10], Transform::from_xyz(5.0, 5.0, 5.0).to_cols_array());
    let refusal = group.update(99, &ring(2)).expect_err("refused");
    assert_eq!(refusal.code.wire(), "range-out-of-group");
}
