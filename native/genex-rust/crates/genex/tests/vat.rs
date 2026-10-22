//! AN-24 across the crates: genex-anim's vertex-animation bake of an imported humanoid's walk is
//! genex-render's skinning reference of the same GLB (`skin_vertices_cpu`, which the compute pass
//! is held to within 1e-5) at each frame's time, and the VAT textures give it back within their
//! half-float tolerance. The texture path's GPU rows against compute skinning are genex-render's
//! `vat::tests::metal_*`. (New behaviour: both modules were stubs.)

#[path = "../../genex-anim/tests/support/mod.rs"]
mod rigs;

use genex_anim::clip::import_clips;
use genex_anim::import::import_rig;
use genex_anim::vat::{VAT_FPS_DEFAULT, VatBake, VatSkin};
use genex_render::skin::{SkinnedModel, skin_vertices_cpu};
use genex_render::vat::{VatImage, crowd_memory};

/// genex-anim's sampler against genex-render's for Linear keys (`genex-anim/tests/sample.rs`'s
/// oracle bound), carried through a 22-joint palette and a blend of four joints.
const SAMPLER_TOLERANCE: f32 = 1e-4;

#[test]
fn a_baked_walk_is_the_renderers_skinning_of_the_same_glb_frame_by_frame() {
    let glb = rigs::humanoid22().glb();
    let model = SkinnedModel::from_glb(&glb).expect("the humanoid loads in the renderer");
    let data = &model.data;
    let rig = import_rig(&glb).expect("the humanoid imports");
    let clips = import_clips(&glb, &rig).expect("its clips import");
    let positions: Vec<[f32; 3]> = data.mesh.vertices.iter().map(|v| v.position).collect();
    let normals: Vec<[f32; 3]> = data.mesh.vertices.iter().map(|v| v.normal).collect();
    let joints: Vec<[u32; 4]> = data.skin.iter().map(|row| row.joints).collect();
    let weights: Vec<[f32; 4]> = data.skin.iter().map(|row| row.weights).collect();
    let skin = VatSkin { positions: &positions, normals: &normals, joints: &joints, weights: &weights };
    let bake = VatBake::bake(rig.skeleton(), &clips[..1], &skin, VAT_FPS_DEFAULT).expect("bakes");
    let walk = &bake.clips()[0];
    let animation = &data.animations[0];
    assert!(walk.frames > 2, "{walk:?}");
    let image = VatImage::encode(bake.vertex_count() as u32, bake.positions(), bake.normals()).expect("encodes");
    let tolerance = image.tolerance() + SAMPLER_TOLERANCE;
    let mut moved = 0.0_f32;
    for k in 0..walk.frames {
        let time = (k as f32 / VAT_FPS_DEFAULT).min(animation.duration);
        let palette = data.skeleton.joint_matrices(&animation.sample(&data.skeleton, time));
        let reference = skin_vertices_cpu(&data.mesh, &data.skin, &palette);
        for (v, want) in reference.iter().enumerate() {
            let baked = bake.frame_positions(k)[v];
            let decoded = image.decode_position(k, v as u32);
            for axis in 0..3 {
                let (baked_error, decoded_error) = ((baked[axis] - want.position[axis]).abs(), (decoded[axis] - want.position[axis]).abs());
                assert!(baked_error <= SAMPLER_TOLERANCE, "frame {k} vertex {v}: bake {baked:?} vs {:?}", want.position);
                assert!(decoded_error <= tolerance, "frame {k} vertex {v}: texture {decoded:?} vs {:?}", want.position);
            }
            moved = moved.max((baked[2] - bake.frame_positions(0)[v][2]).abs());
        }
    }
    assert!(moved > 0.5, "the walk carries the hips forward: {moved}");
    let memory = crowd_memory(&image, 1000);
    assert_eq!(memory.skinned_output, 0, "1,000 baked walkers hold no skinned output");
}
