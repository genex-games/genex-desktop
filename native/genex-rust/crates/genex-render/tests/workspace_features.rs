//! The WebGPU minimum has no GL tier: the whole workspace, on every target platform, resolves wgpu
//! without a GL cargo feature and holds no GL crate. Read from `cargo metadata` (offline, locked),
//! which resolves features for all members and all platforms at once.

use std::path::Path;
use std::process::Command;

/// wgpu and wgpu-core features that would build a GL or WebGL backend.
const GL_FEATURES: [&str; 3] = ["gles", "webgl", "angle"];
/// Crates only a GL backend pulls in.
const GL_CRATES: [&str; 3] = ["glow", "khronos-egl", "glutin_wgl_sys"];

#[test]
fn the_workspace_resolves_no_wgpu_gl_feature_and_no_gl_crate() {
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| env!("CARGO").to_owned());
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../Cargo.toml");
    let output = Command::new(cargo)
        .args(["metadata", "--format-version", "1", "--offline", "--locked", "--manifest-path"])
        .arg(&manifest)
        .output()
        .expect("cargo metadata runs");
    assert!(output.status.success(), "cargo metadata: {}", String::from_utf8_lossy(&output.stderr));
    let metadata: serde_json::Value = serde_json::from_slice(&output.stdout).expect("metadata JSON");
    let packages = metadata["packages"].as_array().expect("packages");
    let name_of = |id: &str| {
        packages.iter().find(|p| p["id"] == id).and_then(|p| p["name"].as_str()).unwrap_or_default().to_owned()
    };
    let nodes = metadata["resolve"]["nodes"].as_array().expect("resolve nodes");
    let mut wgpu_seen = false;
    for node in nodes {
        let name = name_of(node["id"].as_str().expect("id"));
        assert!(!GL_CRATES.contains(&name.as_str()), "{name} is resolved: a GL backend is in the graph");
        if name == "wgpu" || name == "wgpu-core" || name == "wgpu-hal" {
            wgpu_seen |= name == "wgpu";
            let features: Vec<&str> = node["features"].as_array().expect("features").iter().filter_map(|f| f.as_str()).collect();
            for gl in GL_FEATURES {
                assert!(!features.contains(&gl), "{name} resolves the {gl} feature: {features:?}");
            }
        }
    }
    assert!(wgpu_seen, "wgpu is in the workspace graph");
}
