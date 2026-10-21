//! AN-1: the joint-only skeleton and its GLB import. The palette is held to genex-render's
//! `skin.rs` through the oracle files its dump test records (`tests/fixtures/oracle/*.json`, from
//! the same synthetic rigs in `tests/support/mod.rs`); hostile rigs are refused
//! `animation-asset-invalid` without a panic and without building a skeleton; local-to-model is
//! allocation-free after warm-up.

// The counting allocator below implements `GlobalAlloc`, which is an unsafe trait; it only
// forwards to the system allocator and counts on the calling thread.
#![allow(unsafe_code)]

mod support;

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;

use genex_anim::AnimationErrorCode;
use genex_anim::import::{Rig, import_rig};
use genex_anim::math::Trs;
use genex_anim::skeleton::MAX_JOINTS;
use glam::{Mat4, Quat, Vec3};

/// Allocations and bytes, per thread, so parallel tests do not count each other.
struct Counting;

thread_local! {
    static ALLOCATIONS: Cell<u64> = const { Cell::new(0) };
    static BYTES: Cell<u64> = const { Cell::new(0) };
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let _ = ALLOCATIONS.try_with(|c| c.set(c.get() + 1));
        let _ = BYTES.try_with(|c| c.set(c.get() + layout.size() as u64));
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let _ = ALLOCATIONS.try_with(|c| c.set(c.get() + 1));
        let _ = BYTES.try_with(|c| c.set(c.get() + new_size as u64));
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static COUNTING: Counting = Counting;

/// (allocations, bytes) made on this thread while `run` runs.
fn counted<T>(run: impl FnOnce() -> T) -> (T, u64, u64) {
    let (a0, b0) = (ALLOCATIONS.with(Cell::get), BYTES.with(Cell::get));
    let out = run();
    (out, ALLOCATIONS.with(Cell::get) - a0, BYTES.with(Cell::get) - b0)
}

/// The palette agrees with the oracle to this much per matrix element.
const PALETTE_TOLERANCE: f32 = 1e-6;
/// Local-to-model for a 60-joint rig, desktop (advisory in a lane; AN-23 gates it).
const LOCAL_TO_MODEL_60_BUDGET_NS: f64 = 1_000.0;

fn oracle(name: &str) -> genex_core::json::Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/oracle").join(format!("{name}.json"));
    let text = std::fs::read(&path).unwrap_or_else(|error| panic!("{path:?}: {error}; genex-render's skin_oracle_dump test writes it"));
    genex_core::json::parse_with_depth(&text, 8).expect("the oracle parses")
}

fn matrices(value: &genex_core::json::Value) -> Vec<[f32; 16]> {
    value.items().iter().map(|m| std::array::from_fn(|k| m.items()[k].as_f64() as f32)).collect()
}

fn import(spec: &support::RigSpec) -> Rig {
    import_rig(&spec.glb()).unwrap_or_else(|error| panic!("{}: {error}", spec.name))
}

/// The palette of `locals` in skin order.
fn palette_of(rig: &Rig, locals: &[Trs]) -> Vec<[f32; 16]> {
    let skeleton = rig.skeleton();
    let mut model = vec![Mat4::IDENTITY; skeleton.joint_count()];
    let mut palette = vec![[0.0; 16]; skeleton.skin_joint_count()];
    skeleton.local_to_model(locals, &mut model);
    skeleton.palette(&model, &mut palette);
    palette
}

fn assert_palettes_close(rig: &str, what: &str, got: &[[f32; 16]], want: &[[f32; 16]]) {
    assert_eq!(got.len(), want.len(), "{rig} {what}: palette length");
    for (slot, (g, w)) in got.iter().zip(want).enumerate() {
        for k in 0..16 {
            let delta = (g[k] - w[k]).abs();
            assert!(delta <= PALETTE_TOLERANCE, "{rig} {what}: slot {slot} element {k}: {} vs oracle {} (|Δ| {delta:e})", g[k], w[k]);
        }
    }
}

/// The scripted pose of the oracle: every posable node turned, through the rig's node map.
fn scripted_pose(spec: &support::RigSpec, rig: &Rig) -> Vec<Trs> {
    let mut locals = rig.skeleton().rest_pose().to_vec();
    for node in spec.posable() {
        let joint = rig.joint_of_node(node).unwrap_or_else(|| panic!("{}: posable node {node} is a skeleton joint", spec.name));
        let (translation, rotation, scale) = support::scripted_local(&spec.nodes[node], node);
        locals[usize::from(joint.raw())] = Trs::from_arrays(translation, rotation, scale);
    }
    locals
}

#[test]
fn the_palette_equals_the_renderers_on_every_fixture_rig_at_rest_and_posed() {
    for spec in support::oracle_rigs() {
        let rig = import(&spec);
        let recorded = oracle(spec.name);
        assert_eq!(rig.skeleton().skin_joint_count(), spec.joints.len(), "{}: skin joints", spec.name);
        let rest = palette_of(&rig, rig.skeleton().rest_pose());
        assert_palettes_close(spec.name, "rest", &rest, &matrices(&recorded["rest"]));
        let posed = palette_of(&rig, &scripted_pose(&spec, &rig));
        assert_palettes_close(spec.name, "posed", &posed, &matrices(&recorded["posed"]));
    }
}

#[test]
fn joints_are_parent_first_and_the_skin_order_maps_back_to_the_files_joints() {
    for spec in support::oracle_rigs() {
        let rig = import(&spec);
        let skeleton = rig.skeleton();
        for joint in skeleton.joints() {
            if let Some(parent) = skeleton.parent(joint) {
                assert!(parent.raw() < joint.raw(), "{}: {} sits before its parent", spec.name, skeleton.name(joint));
            }
        }
        let files: Vec<usize> = skeleton.skin_order().iter().map(|&joint| rig.node_of_joint(joint)).collect();
        assert_eq!(files, spec.joints, "{}: skin slot k is the file's k-th joint", spec.name);
        assert_eq!(skeleton.joint_count(), spec.posable().len(), "{}: joints and the nodes between them", spec.name);
    }
}

#[test]
fn a_skin_listed_child_first_imports_parent_first_and_still_matches() {
    let spec = support::unordered();
    let rig = import(&spec);
    let names: Vec<&str> = rig.skeleton().joints().map(|j| rig.skeleton().name(j)).collect();
    assert_eq!(names, ["root", "mid", "tip"]);
    let order: Vec<&str> = rig.skeleton().skin_order().iter().map(|&j| rig.skeleton().name(j)).collect();
    assert_eq!(order, ["tip", "root", "mid"], "the palette is written in the file's skin order");
}

#[test]
fn the_mixamo_armature_folds_into_the_root_and_names_resolve_without_the_prefix() {
    let spec = support::mixamo();
    let rig = import(&spec);
    let skeleton = rig.skeleton();
    assert_eq!(skeleton.joint_count(), 22, "the Armature node is not a joint");
    let hips = skeleton.find("mixamorig:Hips").expect("exact name");
    assert_eq!(skeleton.find("hips"), Some(hips), "after the last ':' ignoring ASCII case");
    assert_eq!(skeleton.find("Armature|mixamorig:LeftArm"), None, "a lookup name is matched, not split");
    assert_eq!(skeleton.parent(hips), None, "the root's non-joint ancestors are a fixed frame");
    assert_eq!(skeleton.find("nobody"), None);
}

#[test]
fn a_rig_over_256_joints_is_refused_and_256_imports() {
    assert_eq!(MAX_JOINTS, 256);
    let fits = support::tree("tree256", 256);
    assert_eq!(import(&fits).skeleton().joint_count(), 256);
    let over = support::tree("tree257", 257);
    let error = import_rig(&over.glb()).expect_err("257 joints");
    assert_eq!(error.code, AnimationErrorCode::AssetInvalid);
    assert_eq!(error.code.wire(), "animation-asset-invalid");
}

/// Bytes the reader's two parses allocate for `glb`, genex-core's GLB guard (SF-1b, in front of
/// `gltf` since the F5 integrate) and then `gltf` itself: what a refusal may cost at most, plus slack.
fn parse_bytes(glb: &[u8]) -> u64 {
    let (_, _, guard) = counted(|| genex_core::glb_guard::check_glb(glb).is_ok());
    let (_, _, bytes) = counted(|| gltf::Gltf::from_slice(glb).is_ok());
    guard + bytes
}

/// Slack over the parse for a refusal: the parent table, its walk and the message.
fn refusal_slack(nodes: usize) -> u64 {
    32 * nodes as u64 + 1024
}

fn assert_refused_lean(name: &str, glb: &[u8], nodes: usize) {
    let parse = parse_bytes(glb);
    let (result, _, bytes) = counted(|| import_rig(glb));
    let error = result.expect_err(name);
    assert_eq!(error.code, AnimationErrorCode::AssetInvalid, "{name}: {error}");
    assert!(bytes <= parse + refusal_slack(nodes), "{name}: a refusal allocated {bytes} B, the parse alone {parse} B");
}

#[test]
fn two_parents_a_cycle_and_a_joint_outside_the_scene_are_refused_without_building_a_skeleton() {
    let mut two_parents = support::chain3();
    two_parents.extra_children.push((1, 3)); // root also lists tip
    assert_refused_lean("two parents", &two_parents.glb(), two_parents.nodes.len());

    let mut cycle = support::chain3();
    cycle.extra_children.push((3, 1)); // tip lists root: root → mid → tip → root
    cycle.scene_roots.retain(|&n| n != 1);
    assert_refused_lean("a cycle", &cycle.glb(), cycle.nodes.len());

    let mut outside = support::chain3();
    let stray = outside.joint("stray", None, [0.0; 3], Quat::IDENTITY);
    outside.scene_roots.retain(|&n| n != stray);
    assert_refused_lean("a joint outside the scene", &outside.glb(), outside.nodes.len());

    let mut big = support::tree("tree200", 200);
    big.extra_children.push((5, 9));
    assert_refused_lean("two parents in a 200-joint rig", &big.glb(), big.nodes.len());
}

/// `import_rig(glb)`, refused `animation-asset-invalid` and not panicking.
fn assert_refused(name: &str, glb: &[u8]) {
    let result = catch_unwind(AssertUnwindSafe(|| import_rig(glb))).unwrap_or_else(|_| panic!("{name}: import panicked"));
    let error = result.expect_err(name);
    assert_eq!(error.code, AnimationErrorCode::AssetInvalid, "{name}: {error}");
}

fn with_json(spec: &support::RigSpec, edit: impl FnOnce(String) -> String) -> Vec<u8> {
    let (json, bin) = spec.json_and_bin();
    support::glb(&edit(json), &bin)
}

#[test]
fn hostile_glbs_are_refused_without_a_panic() {
    let spec = support::chain3();
    let (json, bin) = spec.json_and_bin();

    // The BIN chunk ends before the buffer's declared length (container lengths consistent).
    assert_refused("truncated bin", &support::glb(&json, &bin[..bin.len() - 64]));
    // The gltf-rs #478 shape: the skin names an accessor past the list.
    assert_refused("accessor out of range", &with_json(&spec, |j| j.replace(r#""inverseBindMatrices":"#, r#""inverseBindMatrices":99,"x":"#)));
    // The inverse bind matrices' accessor claims more matrices than its view holds.
    let ibm = spec.joints.len();
    assert_refused(
        "accessor past its view",
        &with_json(&spec, |j| j.replace(&format!(r#""count":{ibm},"type":"MAT4""#), &format!(r#""count":{},"type":"MAT4""#, ibm + 40))),
    );
    // A NaN in an inverse bind matrix.
    let mut nan = support::chain3();
    let mut matrices = nan.inverse_bind();
    matrices[1][5] = f32::NAN;
    nan.inverse_bind_override = Some(matrices);
    assert_refused("NaN inverse bind", &nan.glb());
    // Inverse bind matrices of the wrong element type.
    assert_refused("inverse binds as VEC4", &with_json(&spec, |j| j.replace(r#""type":"MAT4""#, r#""type":"VEC4""#)));
    // A mesh node that cannot be inverted (scale 0).
    let mut flat = support::chain3();
    flat.nodes[flat.mesh_node].scale = [1.0, 0.0, 1.0];
    assert_refused("mesh node of scale 0", &flat.glb());
    // No skinned node at all.
    assert_refused("no skin", &with_json(&spec, |j| j.replace(r#","skin":0"#, "")));
    // Container header lies.
    let mut short_header = spec.glb();
    short_header[8..12].copy_from_slice(&4u32.to_le_bytes());
    assert_refused("header length 4", &short_header);
    assert_refused("empty", &[]);
    assert_refused("not a GLB", b"{\"asset\":{\"version\":\"2.0\"}}");
}

#[test]
fn every_truncation_and_bit_flip_of_a_fixture_glb_refuses_or_imports_without_a_panic() {
    let glb = support::chain3().glb();
    let mut panics = 0;
    for cut in 0..glb.len() {
        if catch_unwind(AssertUnwindSafe(|| import_rig(&glb[..cut]))).is_err() {
            panics += 1;
        }
    }
    let mut state: u64 = 0x9E37_79B9_7F4A_7C15;
    for _ in 0..4000 {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        let mut flipped = glb.clone();
        let at = (state % glb.len() as u64) as usize;
        flipped[at] ^= 1 << ((state >> 32) % 8);
        if catch_unwind(AssertUnwindSafe(|| import_rig(&flipped))).is_err() {
            panics += 1;
        }
    }
    assert_eq!(panics, 0, "panics over every truncation and 4000 bit flips");
}

// The advisory cost row reads the wall clock; the crate's simulation code never does.
#[allow(clippy::disallowed_types)]
#[test]
fn local_to_model_for_60_joints_allocates_nothing_after_warm_up() {
    let spec = support::tree("tree60", 60);
    let rig = import(&spec);
    let skeleton = rig.skeleton();
    let locals = scripted_pose(&spec, &rig);
    let mut model = vec![Mat4::IDENTITY; skeleton.joint_count()];
    let mut palette = vec![[0.0; 16]; skeleton.skin_joint_count()];
    skeleton.local_to_model(&locals, &mut model);
    let (_, allocations, _) = counted(|| {
        for _ in 0..100 {
            skeleton.local_to_model(&locals, &mut model);
            skeleton.palette(&model, &mut palette);
        }
    });
    assert_eq!(allocations, 0, "local-to-model and the palette after warm-up");

    // Advisory cost row (lane timings are not gated): ns per local-to-model.
    let rounds: u32 = 20_000;
    let start = std::time::Instant::now();
    for k in 0..rounds {
        skeleton.local_to_model(std::hint::black_box(&locals), &mut model);
        std::hint::black_box(&model[k as usize % model.len()]);
    }
    let ns = start.elapsed().as_nanos() as f64 / f64::from(rounds);
    println!("local_to_model 60 joints: {ns:.0} ns (budget {LOCAL_TO_MODEL_60_BUDGET_NS:.0} ns, advisory)");
}

#[test]
fn local_to_model_is_the_parent_chain_product() {
    let spec = support::chain3();
    let rig = import(&spec);
    let skeleton = rig.skeleton();
    let locals = scripted_pose(&spec, &rig);
    let mut model = vec![Mat4::IDENTITY; skeleton.joint_count()];
    skeleton.local_to_model(&locals, &mut model);
    let root = skeleton.find("root").expect("root");
    let tip = skeleton.find("tip").expect("tip");
    let mid = skeleton.find("mid").expect("mid");
    let chain = locals[usize::from(root.raw())].matrix() * locals[usize::from(mid.raw())].matrix() * locals[usize::from(tip.raw())].matrix();
    let got = model[usize::from(tip.raw())].transform_point3(Vec3::ZERO);
    let want = chain.transform_point3(Vec3::ZERO);
    assert!((got - want).length() < 1e-6, "{got} vs {want}");
}

#[test]
fn the_asset_refusal_has_its_wire_spelling() {
    assert_eq!(AnimationErrorCode::ALL.map(AnimationErrorCode::wire), ["animation-asset-invalid", "animation-graph-invalid", "ragdoll-profile-invalid", "animation-retarget-unmapped"]);
}
