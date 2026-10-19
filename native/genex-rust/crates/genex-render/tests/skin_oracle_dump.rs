//! The skinning oracle genex-anim is held to (game systems AN-1, AN-2): for every synthetic rig
//! of genex-anim's test support, the joint palettes genex-render's `skin.rs` computes at rest,
//! in a scripted pose, and at fixed times of each clip, recorded in
//! `crates/genex-anim/tests/fixtures/oracle/<rig>.json`. genex-anim keeps no dev-dependency on
//! the renderer: its tests read these files, and this test holds them equal to what the renderer
//! computes today. `GENEX_ANIM_ORACLE_UPDATE=1` rewrites them instead (review the diff).

#[path = "../../genex-anim/tests/support/mod.rs"]
mod support;

use std::path::PathBuf;

use genex_render::skin::{SkinnedMeshData, Trs};
use serde_json::{Value, json};

fn oracle_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../genex-anim/tests/fixtures/oracle")
}

fn palette(matrices: &[[f32; 16]]) -> Value {
    Value::Array(matrices.iter().map(|m| json!(m.to_vec())).collect())
}

/// The renderer's palettes for one rig, as the oracle file holds them.
fn dump(rig: &support::RigSpec) -> Value {
    let skinned = SkinnedMeshData::from_glb(&rig.glb()).unwrap_or_else(|error| panic!("{}: the renderer loads the rig: {error}", rig.name));
    let skeleton = &skinned.skeleton;
    let rest = skeleton.joint_matrices(&skeleton.rest_pose());
    let mut posed = skeleton.rest_pose();
    for node in rig.posable() {
        let (translation, rotation, scale) = support::scripted_local(&rig.nodes[node], node);
        posed[node] = Trs { translation, rotation, scale };
    }
    let clips: Vec<Value> = skinned
        .animations
        .iter()
        .map(|clip| {
            let samples: Vec<Value> = support::ORACLE_TIMES
                .iter()
                .map(|&time| json!({ "time": time, "palette": palette(&skeleton.joint_matrices(&clip.sample(skeleton, time))) }))
                .collect();
            json!({ "name": clip.name, "duration": clip.duration, "samples": samples })
        })
        .collect();
    json!({
        "about": "genex-render skin.rs palettes for genex-anim's synthetic rig (tests/support/mod.rs); written by crates/genex-render/tests/skin_oracle_dump.rs. Cubic-spline clips are sampled as skin.rs samples them today: linear on the key values.",
        "rig": rig.name,
        "skinJoints": rig.joints.len(),
        "posable": rig.posable(),
        "rest": palette(&rest),
        "posed": palette(&skeleton.joint_matrices(&posed)),
        "clips": clips,
    })
}

#[test]
fn the_oracle_files_are_the_renderers_palettes() {
    let update = std::env::var("GENEX_ANIM_ORACLE_UPDATE").is_ok_and(|v| v == "1");
    let dir = oracle_dir();
    for rig in support::oracle_rigs() {
        let text = format!("{}\n", serde_json::to_string(&dump(&rig)).expect("the dump serializes"));
        let path = dir.join(format!("{}.json", rig.name));
        if update {
            std::fs::create_dir_all(&dir).expect("the oracle folder");
            std::fs::write(&path, &text).expect("the oracle file writes");
            continue;
        }
        let recorded = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("oracle {path:?} missing ({error}); write it with GENEX_ANIM_ORACLE_UPDATE=1"));
        assert_eq!(recorded, text, "{}: the renderer's palettes moved; rewrite with GENEX_ANIM_ORACLE_UPDATE=1 and review", rig.name);
    }
}
