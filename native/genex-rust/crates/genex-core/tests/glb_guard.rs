//! The GLB guard (game systems SF-1b): what it refuses, with which fault, and that every GLB the
//! repository ships passes it. genex-render's `tests/glb_guard.rs` runs the same hostile table
//! and a fuzz table through the runtime loaders, which call the guard before `gltf` parses.

mod support;

use genex_core::glb_guard::{GLB_MAX_NODE_DEPTH, GlbFault, check_glb};
use serde_json::{Value, json};
use support::glb::{self, triangle};

/// The fault each row of the shared hostile table is refused with.
fn expected_fault(name: &str) -> GlbFault {
    let table = [
        ("#478", GlbFault::Reference),
        ("truncated BIN", GlbFault::Container),
        ("buffer longer than the BIN", GlbFault::Range),
        ("view past the buffer", GlbFault::Range),
        ("offset that overflows", GlbFault::Range),
        ("2^31 count", GlbFault::Range),
        ("2^62 count", GlbFault::Range),
        ("count of 0", GlbFault::Range),
        ("stride shorter", GlbFault::Layout),
        ("index past the vertices", GlbFault::Index),
        ("float indices", GlbFault::Layout),
        ("header length of 4", GlbFault::Container),
        ("its own ancestor", GlbFault::Tree),
        ("listed twice as a child", GlbFault::Tree),
        ("buffer view 9", GlbFault::Reference),
        ("buffer 3", GlbFault::Reference),
        ("joint is node 50", GlbFault::Reference),
        ("accessor 40", GlbFault::Reference),
        ("not a GLB and not JSON", GlbFault::Json),
        ("empty", GlbFault::Json),
    ];
    table.iter().find(|(key, _)| name.contains(key)).map(|(_, fault)| *fault).unwrap_or_else(|| panic!("no fault listed for {name:?}"))
}

#[test]
fn the_valid_triangle_passes() {
    check_glb(&triangle().bytes()).expect("a valid GLB");
}

#[test]
fn each_hostile_glb_is_refused_with_its_fault() {
    for (name, bytes) in glb::hostile() {
        let refusal = check_glb(&bytes).expect_err(name);
        assert_eq!(refusal.fault(), expected_fault(name), "{name}: {refusal}");
        assert!(!refusal.detail().is_empty(), "{name}");
    }
}

#[test]
fn fault_wire_spellings_are_distinct_and_prefixed() {
    let wires: Vec<&str> = GlbFault::ALL.iter().map(|fault| fault.wire()).collect();
    assert_eq!(wires, ["glb-container", "glb-json", "glb-reference", "glb-range", "glb-layout", "glb-index", "glb-tree"]);
}

#[test]
fn a_node_chain_deeper_than_the_cap_is_refused_and_one_at_the_cap_passes() {
    let chain = |depth: usize| {
        let nodes: Vec<Value> = (0..depth).map(|n| if n + 1 < depth { json!({"children": [n + 1]}) } else { json!({"mesh": 0}) }).collect();
        triangle().set("/nodes", Value::Array(nodes)).bytes()
    };
    check_glb(&chain(GLB_MAX_NODE_DEPTH)).expect("a chain at the cap");
    assert_eq!(check_glb(&chain(GLB_MAX_NODE_DEPTH + 1)).expect_err("past the cap").fault(), GlbFault::Tree);
}

#[test]
fn a_gltf_text_document_is_checked_as_json_with_no_bin() {
    let embedded = serde_json::to_vec(&triangle().json).expect("JSON");
    assert_eq!(check_glb(&embedded).expect_err("a buffer with no BIN").fault(), GlbFault::Range);
    let external = triangle().set("/buffers/0", json!({"byteLength": 44, "uri": "triangle.bin"}));
    check_glb(&serde_json::to_vec(&external.json).expect("JSON")).expect("an external buffer's views are bounded by its declared length");
    let past = external.set("/bufferViews/0/byteLength", json!(400));
    assert_eq!(check_glb(&serde_json::to_vec(&past.json).expect("JSON")).expect_err("past").fault(), GlbFault::Range);
}

#[test]
fn spec_layouts_pass_and_reader_breaking_layouts_are_refused() {
    let uv = |component: u64, normalized: bool| {
        let accessor = json!({"bufferView": 0, "componentType": component, "normalized": normalized, "count": 3, "type": "VEC2"});
        let mut glb = triangle();
        glb.json["accessors"].as_array_mut().expect("accessors").push(accessor);
        glb.json["meshes"][0]["primitives"][0]["attributes"]["TEXCOORD_0"] = json!(2);
        glb.bytes()
    };
    check_glb(&uv(5126, false)).expect("float UVs");
    check_glb(&uv(5123, true)).expect("normalized u16 UVs");
    assert_eq!(check_glb(&uv(5122, true)).expect_err("i16 UVs: the gltf reader has no arm for them").fault(), GlbFault::Layout);
    let quantized = |used: bool| {
        let glb = triangle().set("/accessors/0/componentType", json!(5123)).set("/accessors/0/min", json!([0, 0, 0])).set("/accessors/0/max", json!([1, 1, 0]));
        if used { glb.bytes_with("extensionsUsed", json!(["KHR_mesh_quantization"])) } else { glb.bytes() }
    };
    check_glb(&quantized(true)).expect("KHR_mesh_quantization positions pass; the renderer refuses them itself");
    assert_eq!(check_glb(&quantized(false)).expect_err("u16 positions without the extension").fault(), GlbFault::Layout);
}

#[test]
fn attribute_counts_must_match_position() {
    let mut glb = triangle();
    glb.json["accessors"].as_array_mut().expect("accessors").push(json!({"bufferView": 0, "componentType": 5126, "count": 2, "type": "VEC3"}));
    glb.json["meshes"][0]["primitives"][0]["attributes"]["NORMAL"] = json!(2);
    assert_eq!(check_glb(&glb.bytes()).expect_err("2 normals for 3 positions").fault(), GlbFault::Range);
}

#[test]
fn sparse_accessors_are_bounded_by_their_views() {
    let sparse = |values_offset: u64| {
        let accessor = json!({"componentType": 5126, "count": 3, "type": "VEC3",
            "sparse": {"count": 1, "indices": {"bufferView": 1, "componentType": 5123}, "values": {"bufferView": 0, "byteOffset": values_offset}}});
        let mut glb = triangle();
        glb.json["accessors"].as_array_mut().expect("accessors").push(accessor);
        glb.json["meshes"][0]["primitives"][0]["targets"] = json!([{"POSITION": 2}]);
        glb.bytes()
    };
    check_glb(&sparse(0)).expect("a sparse morph target inside its views");
    assert_eq!(check_glb(&sparse(30)).expect_err("values past their view").fault(), GlbFault::Range);
}

#[test]
fn every_glb_the_repository_ships_passes_the_guard() {
    let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..");
    let folders = ["native/genex-rust/examples/showcase/game/assets", "native/genex-rust/examples/pond/assets", "tests/fixtures/asset-import", "tests/fixtures/asset-previews"];
    let mut checked = 0;
    for folder in folders {
        for entry in std::fs::read_dir(repo.join(folder)).unwrap_or_else(|error| panic!("{folder}: {error}")) {
            let path = entry.expect("an entry").path();
            if !path.extension().is_some_and(|ext| ext == "glb" || ext == "gltf") {
                continue;
            }
            let bytes = std::fs::read(&path).expect("the fixture reads");
            let answer = check_glb(&bytes);
            if path.file_name().is_some_and(|name| name == "broken.glb") {
                assert!(answer.is_err(), "broken.glb is a damaged container");
                continue;
            }
            answer.unwrap_or_else(|refusal| panic!("{}: {refusal}", path.display()));
            checked += 1;
        }
    }
    assert!(checked >= 60, "{checked} fixtures");
}

#[test]
fn an_accessor_with_no_view_may_expand_to_at_most_the_cap_times_the_file() {
    let viewless = |count: u64| {
        let mut glb = triangle();
        glb.json["accessors"].as_array_mut().expect("accessors").push(json!({"componentType": 5126, "count": count, "type": "VEC3"}));
        glb.bytes()
    };
    let file = viewless(1).len() as u64;
    let fits = file * genex_core::glb_guard::GLB_VIEWLESS_EXPANSION / 12;
    check_glb(&viewless(fits)).expect("zeros within the cap");
    assert_eq!(check_glb(&viewless(1 << 40)).expect_err("a terabyte of zeros").fault(), GlbFault::Range);
}
