//! AN-24: vertex-animation bakes for crowds. A bake's frame is the simulation's own skinning of
//! its clip at that frame's time, bit for bit; frames sit at `k / fps` with the last one at the
//! clip's end; the frame pick loops and clamps as sampling does; the same inputs bake the same
//! bits; hostile inputs are refused `animation-asset-invalid` without a panic. (New behaviour:
//! the module was a stub.)

mod support;

use genex_anim::AnimationErrorCode;
use genex_anim::clip::{Clip, import_clips};
use genex_anim::import::{Rig, import_rig};
use genex_anim::math::Trs;
use genex_anim::sample::{SampleCursor, Wrap, sample};
use genex_anim::vat::{VAT_FPS_MAX, VAT_TEXELS_MAX, VAT_VERTICES_MAX, VatBake, VatSkin};
use glam::{Mat4, Vec3, Vec4};

const FPS: f32 = 30.0;

fn chain() -> (Rig, Vec<Clip>) {
    let spec = support::chain3();
    let glb = spec.glb();
    let rig = import_rig(&glb).expect("chain3 imports");
    let clips = import_clips(&glb, &rig).expect("chain3 clips");
    (rig, clips)
}

/// A column of `count` vertices up the chain, each on two neighbouring joints.
struct Mesh {
    positions: Vec<[f32; 3]>,
    normals: Vec<[f32; 3]>,
    joints: Vec<[u32; 4]>,
    weights: Vec<[f32; 4]>,
}

impl Mesh {
    fn column(count: usize) -> Mesh {
        let mut mesh = Mesh { positions: Vec::new(), normals: Vec::new(), joints: Vec::new(), weights: Vec::new() };
        for i in 0..count {
            let height = 2.1 * i as f32 / (count - 1).max(1) as f32;
            let side = if i % 2 == 0 { 0.1 } else { -0.1 };
            let lower = (height as u32).min(1);
            let share = (height - lower as f32).clamp(0.0, 1.0);
            mesh.positions.push([0.5 + side, height, -0.25]);
            mesh.normals.push([if side > 0.0 { 1.0 } else { -1.0 }, 0.0, 0.0]);
            mesh.joints.push([lower, lower + 1, 0, 0]);
            mesh.weights.push([1.0 - share, share, 0.0, 0.0]);
        }
        mesh
    }

    fn skin(&self) -> VatSkin<'_> {
        VatSkin { positions: &self.positions, normals: &self.normals, joints: &self.joints, weights: &self.weights }
    }
}

/// The palette of `clip` at `time`, from the rest pose with a fresh cursor.
fn palette_at(rig: &Rig, clip: &Clip, time: f32) -> Vec<Mat4> {
    let skeleton = rig.skeleton();
    let mut pose: Vec<Trs> = skeleton.rest_pose().to_vec();
    sample(clip, time, Wrap::Clamp, &mut SampleCursor::new(), &mut pose);
    let mut model = vec![Mat4::IDENTITY; skeleton.joint_count()];
    let mut palette = vec![[0.0; 16]; skeleton.skin_joint_count()];
    skeleton.local_to_model(&pose, &mut model);
    skeleton.palette(&model, &mut palette);
    palette.iter().map(Mat4::from_cols_array).collect()
}

/// The mesh skinned by `palette`, written out longhand: the four slots summed in order.
fn skinned(mesh: &Mesh, palette: &[Mat4]) -> (Vec<[f32; 3]>, Vec<[f32; 3]>) {
    let mut out = (Vec::new(), Vec::new());
    for i in 0..mesh.positions.len() {
        let mut m = Mat4::ZERO;
        for k in 0..4 {
            m += palette.get(mesh.joints[i][k] as usize).copied().unwrap_or(Mat4::IDENTITY) * mesh.weights[i][k];
        }
        out.0.push((m * Vec4::from((Vec3::from(mesh.positions[i]), 1.0))).truncate().to_array());
        out.1.push((m * Vec4::from((Vec3::from(mesh.normals[i]), 0.0))).truncate().normalize_or(Vec3::Y).to_array());
    }
    out
}

fn bits(rows: &[[f32; 3]]) -> Vec<u32> {
    rows.iter().flatten().map(|value| value.to_bits()).collect()
}

/// Every frame of every clip is the mesh skinned by that clip's palette at `k / fps` (the last
/// frame at the clip's end), bit for bit.
#[test]
fn each_frame_is_the_clip_skinned_at_its_time() {
    let (rig, clips) = chain();
    let mesh = Mesh::column(9);
    let bake = VatBake::bake(rig.skeleton(), &clips, &mesh.skin(), FPS).expect("bakes");
    assert_eq!(bake.vertex_count(), 9);
    for (clip, row) in clips.iter().zip(bake.clips()) {
        assert_eq!(row.name, clip.name());
        for k in 0..row.frames {
            let time = (k as f32 / FPS).min(clip.duration());
            let (positions, normals) = skinned(&mesh, &palette_at(&rig, clip, time));
            let frame = row.first_frame + k;
            assert_eq!(bits(bake.frame_positions(frame)), bits(&positions), "{} frame {k}", row.name);
            assert_eq!(bits(bake.frame_normals(frame)), bits(&normals), "{} frame {k}", row.name);
        }
    }
    let moved = bake.frame_positions(0).iter().zip(bake.frame_positions(15)).any(|(a, b)| a != b);
    assert!(moved, "the wave moves the column between frames 0 and 15");
}

/// A clip of `d` seconds takes `ceil(d * fps) + 1` frames, clips follow each other, and the frame
/// table covers the whole bake.
#[test]
fn the_clip_table_lays_clips_end_to_end() {
    let (rig, clips) = chain();
    let mesh = Mesh::column(4);
    let bake = VatBake::bake(rig.skeleton(), &clips, &mesh.skin(), FPS).expect("bakes");
    let mut first = 0;
    for (clip, row) in clips.iter().zip(bake.clips()) {
        assert_eq!(row.first_frame, first);
        assert_eq!(row.frames, (clip.duration() * FPS).ceil() as u32 + 1, "{}", row.name);
        assert_eq!(row.duration, clip.duration());
        first += row.frames;
    }
    assert_eq!(bake.frame_count(), first as usize);
    assert_eq!(bake.positions().len(), first as usize * 4);
    assert!(bake.frame_positions(first).is_empty(), "past the last frame");
}

/// The frame pick: on a frame it is that frame, halfway it blends half, a looping time past the
/// end wraps to the start, and a clamped one holds the last frame.
#[test]
fn the_frame_pick_blends_loops_and_clamps() {
    let (rig, clips) = chain();
    let mesh = Mesh::column(4);
    let bake = VatBake::bake(rig.skeleton(), &clips, &mesh.skin(), FPS).expect("bakes");
    let wave = &bake.clips()[0];
    let on = bake.sample_at(0, 3.0 / FPS, Wrap::Loop).expect("clip 0");
    assert_eq!((on.frame0, on.frame1), (wave.first_frame + 3, wave.first_frame + 4));
    assert!(on.blend.abs() < 1e-4, "{on:?}");
    let half = bake.sample_at(0, 3.5 / FPS, Wrap::Loop).expect("clip 0");
    assert!((half.blend - 0.5).abs() < 1e-3, "{half:?}");
    let wrapped = bake.sample_at(0, wave.duration + 1.5 / FPS, Wrap::Loop).expect("clip 0");
    assert_eq!(wrapped.frame0, wave.first_frame + 1, "{wrapped:?}");
    assert!((wrapped.blend - 0.5).abs() < 1e-2, "{wrapped:?}");
    let last = wave.first_frame + wave.frames - 1;
    let held = bake.sample_at(0, wave.duration + 5.0, Wrap::Clamp).expect("clip 0");
    assert_eq!((held.frame0, held.frame1, held.blend), (last, last, 0.0));
    let second = bake.sample_at(1, 0.0, Wrap::Loop).expect("clip 1");
    assert_eq!(second.frame0, bake.clips()[1].first_frame);
    assert_eq!(bake.sample_at(bake.clips().len(), 0.0, Wrap::Loop), None);
}

/// The same inputs bake the same bits.
#[test]
fn a_bake_is_deterministic() {
    let (rig, clips) = chain();
    let mesh = Mesh::column(17);
    let one = VatBake::bake(rig.skeleton(), &clips, &mesh.skin(), FPS).expect("bakes");
    let two = VatBake::bake(rig.skeleton(), &clips, &mesh.skin(), FPS).expect("bakes");
    assert_eq!(bits(one.positions()), bits(two.positions()));
    assert_eq!(bits(one.normals()), bits(two.normals()));
}

/// Hostile inputs are refused `animation-asset-invalid`, never a panic.
#[test]
fn hostile_bakes_are_refused_asset_invalid() {
    let (rig, clips) = chain();
    let mesh = Mesh::column(4);
    let refused = |clips: &[Clip], skin: VatSkin<'_>, fps: f32| {
        VatBake::bake(rig.skeleton(), clips, &skin, fps).expect_err("refused").code
    };
    let skin = mesh.skin();
    let rows: Vec<(&str, AnimationErrorCode)> = vec![
        ("no clip", refused(&[], skin, FPS)),
        ("fps 0", refused(&clips, skin, 0.0)),
        ("fps NaN", refused(&clips, skin, f32::NAN)),
        ("fps infinite", refused(&clips, skin, f32::INFINITY)),
        ("fps past the cap", refused(&clips, skin, VAT_FPS_MAX * 2.0)),
        ("short normals", refused(&clips, VatSkin { normals: &mesh.normals[..3], ..skin }, FPS)),
        ("short weights", refused(&clips, VatSkin { weights: &mesh.weights[..1], ..skin }, FPS)),
        ("no vertex", refused(&clips, VatSkin { positions: &[], normals: &[], joints: &[], weights: &[] }, FPS)),
    ];
    for (name, code) in rows {
        assert_eq!(code, AnimationErrorCode::AssetInvalid, "{name}");
    }
    let mut bad = Mesh::column(4);
    bad.positions[2][1] = f32::NAN;
    assert_eq!(refused(&clips, bad.skin(), FPS), AnimationErrorCode::AssetInvalid, "a NaN position");
    let big = Mesh::column(VAT_VERTICES_MAX + 1);
    assert_eq!(refused(&clips, big.skin(), FPS), AnimationErrorCode::AssetInvalid, "too many vertices");
    let wide = Mesh::column(VAT_TEXELS_MAX / 30);
    assert_eq!(refused(&clips, wide.skin(), FPS), AnimationErrorCode::AssetInvalid, "too many vertex-frames");
}
