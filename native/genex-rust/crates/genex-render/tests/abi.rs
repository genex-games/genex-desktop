//! The published GPU ABI is frozen: v1 custom passes bind a `GxFrameV1` compat buffer instead of
//! the renderer's own frame uniforms, so `GpuFrame` may change from RQ1 on while every v1 pass
//! keeps reading today's bytes. The instance and material rows stay byte-identical forever.

use genex_render::abi::{GX_FRAME_V1_BYTES, GX_INSTANCE_V1_BYTES, GX_MATERIAL_V1_BYTES, GxFrameV1, GxInstanceV1, GxMaterialV1, RenderInputs};
use genex_render::layout::{GpuFrame, GpuInstance, GpuMaterial};
use genex_render::scene::{CameraDesc, FramePlan, Material, MeshId, MeshLibrary, PointLight, Scene, scaled, translation};

/// A fixed scene with sun shadows (both cascades), a point light and several materials.
fn fixed_scene() -> Scene {
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 3.0, 8.0], [0.0, 0.0, -4.0]), [120, 160, 210, 255]);
    scene.lighting.sun_dir = [0.5, 1.0, 0.35];
    scene.lighting.points.push(PointLight { position: [1.0, 2.0, 0.5], color: [255, 200, 120], intensity: 3.0, range: 6.0 });
    scene.draw(MeshId::CUBE, scaled([0.0, -0.6, -10.0], [16.0, 0.2, 30.0]), Material::color([210, 210, 200, 255]));
    scene.draw(MeshId::CUBE, translation(-1.0, 0.0, 1.0), Material::color([200, 60, 50, 255]));
    scene.draw(MeshId::SPHERE, scaled([1.4, 0.4, 0.0], [0.6; 3]), Material::color([60, 180, 80, 255]));
    scene
}

fn fixed_plan() -> FramePlan {
    FramePlan::build(&fixed_scene(), &MeshLibrary::new(), 16.0 / 9.0).expect("the fixed scene plans")
}

/// FNV-1a over `bytes` (a pinned digest of frozen bytes).
fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |hash, byte| (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3))
}

/// The digest of the fixed scene's v1 frame bytes as v1 passes read them before RQ1: the legacy
/// fit, bit for bit, with the lanes v1 documents as unused (`sun_dir.w`, `cascade_splits.z`) at 0.
const FIXED_V1_FRAME_DIGEST: u64 = 3_525_232_799_821_170_918;

#[test]
fn gx_frame_v1_bytes_for_a_fixed_scene_are_the_pinned_v1_bytes() {
    let plan = fixed_plan();
    assert_ne!(plan.frame, GpuFrame::default(), "the scene fills the frame uniforms");
    let v1 = GxFrameV1::from_frame(&plan.frame);
    assert_eq!(v1.as_bytes().len() as u64, GX_FRAME_V1_BYTES);
    assert_eq!(fnv1a(v1.as_bytes()), FIXED_V1_FRAME_DIGEST, "a v1 pass reads the bytes it read before RQ1");
    // Every member but the two grown lanes is the frame's own prefix.
    let mut prefix = plan.frame;
    prefix.sun_dir[3] = 0.0;
    prefix.cascade_splits[2] = 0.0;
    assert_eq!(v1.as_bytes(), &bytemuck::bytes_of(&prefix)[..GX_FRAME_V1_BYTES as usize], "a v1 pass reads the frame's v1 prefix");
}

#[test]
fn a_v1_frame_reads_no_sun_radius_while_the_renderer_frame_and_v2_carry_it() {
    // RQ3 writes the sun's angular radius into `sun_dir.w`, which v1 documents as unused.
    let mut frame = fixed_plan().frame;
    frame.sun_dir[3] = 0.0047;
    assert_eq!(GxFrameV1::from_frame(&frame).sun_dir, [frame.sun_dir[0], frame.sun_dir[1], frame.sun_dir[2], 0.0]);
    assert_eq!(genex_render::abi::GxFrameV2::from_frame(&frame).sun_dir, frame.sun_dir, "v2 documents w as the radius");
}

#[test]
fn a_v2_frame_of_a_four_cascade_plan_carries_every_cascade() {
    use genex_render::scene::PlanOptions;
    use genex_render::settings::{Quality, ShadowSettings, SkyParams};
    let mut quality = Quality::off().shadows;
    quality.cascades = 4;
    quality.map_size = 2048;
    let shadows = ShadowSettings::from_quality(&quality, 40.0, SkyParams::default().sun_angular_radius);
    let options = PlanOptions { shadows: Some(shadows), depth_reversed: false, sun: None };
    let plan = FramePlan::build_with(&fixed_scene(), &MeshLibrary::new(), 16.0 / 9.0, &options).expect("plan");
    assert_eq!(plan.cascades_drawn(), 4);
    let v2 = genex_render::abi::GxFrameV2::from_frame(&plan.frame);
    assert_eq!(v2.counts[1], 4, "cascades drawn");
    assert_eq!(v2.cascade_ends, plan.frame.cascade_ends);
    assert!(v2.cascade_ends.iter().all(|end| *end > 0.0), "four ends: {:?}", v2.cascade_ends);
    assert_eq!(v2.cascade_offsets, plan.frame.cascade_offsets);
    assert_eq!(v2.cascade_view_proj, plan.frame.cascade_matrices, "every cascade's matrix");
    // An unshadowed frame draws none and keeps identity rows.
    let plain = FramePlan::build_with(&fixed_scene(), &MeshLibrary::new(), 16.0 / 9.0, &PlanOptions { shadows: None, depth_reversed: false, sun: None }).expect("plan");
    let v2 = genex_render::abi::GxFrameV2::from_frame(&plain.frame);
    assert_eq!((v2.counts[1], v2.cascade_ends), (0, [0.0; 4]));
    assert_eq!(v2.cascade_view_proj[3], glam::Mat4::IDENTITY.to_cols_array());
}

#[test]
fn a_v1_frame_of_an_hdr_frame_reads_no_pre_exposure_in_the_unused_lane() {
    // The renderer keeps the HDR scene's pre-exposure in `cascade_splits.z`, which v1 documents
    // as unused: v1 sources keep reading 0 there, as before RQ1.
    let mut hdr = fixed_plan().frame;
    hdr.cascade_splits[2] = 2.0;
    let v1 = GxFrameV1::from_frame(&hdr);
    assert_eq!(v1.cascade_splits[2], 0.0, "the lane is 0 for v1");
    assert_eq!(v1.cascade_splits[..2], hdr.cascade_splits[..2]);
    assert_eq!(v1.cascade_splits[3], hdr.cascade_splits[3]);
}

#[test]
fn the_frozen_rows_keep_their_sizes_and_are_the_renderer_rows() {
    assert_eq!(GX_FRAME_V1_BYTES, 416);
    assert_eq!(GX_INSTANCE_V1_BYTES, 160);
    assert_eq!(GX_MATERIAL_V1_BYTES, 48);
    assert_eq!(size_of::<GxInstanceV1>() as u64, GX_INSTANCE_V1_BYTES);
    assert_eq!(size_of::<GxMaterialV1>() as u64, GX_MATERIAL_V1_BYTES);
    let plan = fixed_plan();
    let instance: GpuInstance = plan.instances[0];
    let material: GpuMaterial = plan.materials[0];
    let row: GxInstanceV1 = instance;
    let mat: GxMaterialV1 = material;
    assert_eq!(bytemuck::bytes_of(&row), bytemuck::bytes_of(&instance));
    assert_eq!(bytemuck::bytes_of(&mat), bytemuck::bytes_of(&material));
}

#[test]
fn render_inputs_combine_and_default_to_none() {
    assert!(RenderInputs::default().is_empty());
    let wanted = RenderInputs::DEPTH | RenderInputs::NORMALS;
    assert!(wanted.contains(RenderInputs::DEPTH));
    assert!(wanted.contains(RenderInputs::NORMALS));
    assert!(!wanted.contains(RenderInputs::MOTION));
    assert!(!wanted.contains(RenderInputs::DEPTH | RenderInputs::HDR_SCENE));
    let all = RenderInputs::DEPTH | RenderInputs::NORMALS | RenderInputs::MOTION | RenderInputs::ENVIRONMENT | RenderInputs::HDR_SCENE;
    assert_eq!(all, RenderInputs::ALL);
    let wires: Vec<&str> = all.iter().map(|input| input.wire()).collect();
    assert_eq!(wires, vec!["depth", "normals", "motion", "environment", "hdr-scene"]);
}

/// The byte offset and size of each member of `name` in `module`.
fn members(module: &naga::Module, name: &str) -> Vec<(String, u32, u32)> {
    let (_, ty) = module.types.iter().find(|(_, ty)| ty.name.as_deref() == Some(name)).unwrap_or_else(|| panic!("struct {name}"));
    let naga::TypeInner::Struct { members, .. } = &ty.inner else { panic!("{name} is a struct") };
    let mut layouter = naga::proc::Layouter::default();
    layouter.update(module.to_ctx()).expect("layouts");
    members.iter().map(|member| (member.name.clone().unwrap_or_default(), member.offset, layouter[member.ty].size)).collect()
}

#[test]
fn the_level_2_material_frame_is_a_prefix_of_the_frozen_v1_frame() {
    use genex_render::shaders::MATERIAL_PRELUDE;
    let source = format!("{MATERIAL_PRELUDE}\n@fragment fn fs_material(in: GxMaterialIn) -> @location(0) vec4<f32> {{ return in.tint; }}\n");
    let module = naga::front::wgsl::parse_str(&source).expect("the material prelude parses");
    let frame = members(&module, "GxFrame");
    // GxFrameV1's own leading members, by byte offset and size (repr(C), no padding before them).
    let v1 = [("view_proj", 0, 64), ("camera_pos", 64, 16), ("camera_forward", 80, 16), ("sun_dir", 96, 16), ("sun_color", 112, 16), ("ambient", 128, 16)];
    let expected: Vec<(String, u32, u32)> = v1.iter().map(|(name, offset, size)| ((*name).to_owned(), *offset, *size)).collect();
    assert_eq!(frame, expected, "every member a v1 material reads sits where GxFrameV1 puts it");
    let reference = GxFrameV1::from_frame(&fixed_plan().frame);
    let bytes = reference.as_bytes();
    assert_eq!(&bytes[128..144], bytemuck::cast_slice::<f32, u8>(&reference.ambient), "ambient is GxFrameV1's at byte 128");
    assert!(frame.iter().all(|(_, offset, size)| u64::from(offset + size) <= GX_FRAME_V1_BYTES));
}
