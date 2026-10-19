//! A Rust game's staged assets on the web: the shell fetches `assets/` by the build's asset map
//! (`assets.json`, written by the host's lane) and hands each file to the module before the first
//! frame; the module admits a file only when the map named it under the asset-path rule, within
//! the size caps, and its bytes are exactly the length and FNV-1a 64 the map recorded. Before this,
//! a web build drew every model as the magenta missing-asset checker (an empty asset table).

use genex::{Assets, Camera, Color, Frame, Transform};
use genex_core::digest::{fnv1a64, hex64};
use genex_platform_web::assets::{
    AssetRefusal, Layered, MAX_ASSET_BYTES, MAX_ASSET_FILES, MAX_ASSETS_TOTAL_BYTES, WebAssets,
};
use genex_platform_web::{AssetTable, MeshCache, to_scene};
use genex_render::scene::MeshId;

/// A real GLB from the showcase game's staged assets.
const SPHERE: &[u8] = include_bytes!("../../../examples/showcase/game/assets/sphere.glb");

fn entry(path: &str, bytes: u64, digest: &str) -> String {
    format!(r#"{{"path":{},"bytes":{bytes},"fnv1a64":"{digest}"}}"#, serde_json::json!(path))
}

fn map_of(entries: &[String]) -> Vec<u8> {
    format!(r#"{{"version":1,"files":[{}]}}"#, entries.join(",")).into_bytes()
}

fn sphere_entry(path: &str) -> String {
    entry(path, SPHERE.len() as u64, &hex64(fnv1a64(SPHERE)))
}

fn frame_drawing(path: &str) -> Frame {
    let assets = Assets::default();
    let mut frame = Frame::new(Color::rgb(0, 0, 0));
    frame.model(&assets.model(path), Transform::IDENTITY);
    frame
}

/// The meshes `frame` would load from `source`: how many reached the renderer, and whether the
/// first draw is the missing-asset checker.
fn draws(source: &impl genex_platform_web::AssetSource, path: &str) -> (u32, bool) {
    let frame = frame_drawing(path);
    let mut meshes = MeshCache::default();
    let mut added = 0;
    meshes.load(&frame, source, |_mesh| {
        added += 1;
        Ok(MeshId::from_raw(7))
    });
    let scene = to_scene(&frame, &Camera::DEFAULT, &meshes);
    (added, scene.draws[0].material.checker)
}

#[test]
fn a_staged_glb_named_by_the_map_reaches_the_table_and_draws_its_mesh() {
    let mut assets = WebAssets::plan(&map_of(&[sphere_entry("models/sphere.glb")])).expect("a well-formed map");
    let planned: Vec<(&str, u64)> = assets.planned().iter().map(|p| (p.path.as_str(), p.bytes)).collect();
    assert_eq!(planned, [("models/sphere.glb", SPHERE.len() as u64)], "the shell fetches exactly what the map names");
    assert_eq!(draws(&assets, "models/sphere.glb"), (0, true), "nothing loads before the bytes arrive");

    assets.admit("models/sphere.glb", SPHERE.to_vec()).expect("the fetched bytes match the map");
    assert_eq!(assets.get("models/sphere.glb"), Some(SPHERE));
    assert_eq!(draws(&assets, "models/sphere.glb"), (1, false), "the GLB is a mesh, not the magenta checker");
}

#[test]
fn a_compiled_asset_is_found_first_and_a_fetched_one_after_it() {
    const COMPILED: AssetTable = &[("compiled.glb", SPHERE)];
    let mut fetched = WebAssets::plan(&map_of(&[sphere_entry("fetched.glb")])).expect("map");
    fetched.admit("fetched.glb", SPHERE.to_vec()).expect("admitted");
    let layered = Layered { compiled: COMPILED, fetched: &fetched };
    assert_eq!(draws(&layered, "compiled.glb"), (1, false));
    assert_eq!(draws(&layered, "fetched.glb"), (1, false));
    assert_eq!(draws(&layered, "absent.glb"), (0, true));
}

#[test]
fn an_empty_map_plans_nothing_and_a_malformed_one_is_refused() {
    assert!(WebAssets::plan(br#"{"version":1,"files":[]}"#).expect("empty").planned().is_empty());
    let malformed: [&[u8]; 6] = [
        b"",
        b"not json",
        br#"{"files":[]}"#,
        // Flipped by SF-2: version 2 is the map format with groups and ranges; 3 is not one yet.
        br#"{"version":3,"files":[]}"#,
        br#"{"version":1,"files":{}}"#,
        br#"[]"#,
    ];
    for map in malformed {
        let refused = WebAssets::plan(map).expect_err("a malformed map boots nothing");
        assert_eq!(refused.code(), AssetRefusal::MapInvalid, "{:?}", String::from_utf8_lossy(map));
    }
}

/// One hostile map entry: what the map says, and why it is never fetched.
struct Hostile {
    name: &'static str,
    entry: String,
    path: &'static str,
    refusal: AssetRefusal,
}

fn hostile_entries() -> Vec<Hostile> {
    let digest = hex64(fnv1a64(SPHERE));
    let size = SPHERE.len() as u64;
    let row = |name, path: &'static str, bytes: u64, refusal| Hostile {
        name,
        entry: entry(path, bytes, &digest),
        path,
        refusal,
    };
    vec![
        row("a climbing path", "../escape.glb", size, AssetRefusal::UnsafePath),
        row("a climbing segment", "models/../../escape.glb", size, AssetRefusal::UnsafePath),
        row("an absolute path", "/etc/passwd.glb", size, AssetRefusal::UnsafePath),
        row("a backslash", "models\\sphere.glb", size, AssetRefusal::UnsafePath),
        row("a drive letter", "C:/sphere.glb", size, AssetRefusal::UnsafePath),
        row("a device name", "con.glb", size, AssetRefusal::UnsafePath),
        row("an empty segment", "models//sphere.glb", size, AssetRefusal::UnsafePath),
        row("a URL", "https://example.com/x.glb", size, AssetRefusal::UnsafePath),
        row("an oversized file", "huge.glb", MAX_ASSET_BYTES + 1, AssetRefusal::TooLarge),
    ]
}

#[test]
fn a_hostile_map_entry_is_never_fetched_and_its_bytes_never_load() {
    for row in hostile_entries() {
        let mut assets = WebAssets::plan(&map_of(std::slice::from_ref(&row.entry))).expect("the map itself is well formed");
        assert!(assets.planned().is_empty(), "{}: nothing is fetched", row.name);
        assert_eq!(assets.skipped().first().map(|(_, why)| *why), Some(row.refusal), "{}", row.name);
        let refused = assets.admit(row.path, SPHERE.to_vec()).expect_err(row.name);
        assert_eq!(refused.code(), AssetRefusal::NotPlanned, "{}: bytes for it are refused", row.name);
        assert_eq!(assets.get(row.path), None, "{}", row.name);
        assert_eq!(draws(&assets, row.path), (0, true), "{}: the checker, never the bytes", row.name);
    }
}

#[test]
fn bytes_that_are_not_what_the_map_recorded_never_load() {
    let digest = hex64(fnv1a64(SPHERE));
    let mut longer = SPHERE.to_vec();
    longer.push(0);
    let mut flipped = SPHERE.to_vec();
    flipped[100] ^= 0xff;
    let rows: [(&str, Vec<u8>, AssetRefusal); 4] = [
        ("longer than recorded (an oversized or symlinked swap)", longer, AssetRefusal::SizeMismatch),
        ("shorter than recorded", SPHERE[..SPHERE.len() - 1].to_vec(), AssetRefusal::SizeMismatch),
        ("another file of the same length", flipped, AssetRefusal::DigestMismatch),
        ("nothing at all", Vec::new(), AssetRefusal::SizeMismatch),
    ];
    for (name, bytes, refusal) in rows {
        let mut assets = WebAssets::plan(&map_of(&[entry("sphere.glb", SPHERE.len() as u64, &digest)])).expect("map");
        let refused = assets.admit("sphere.glb", bytes).expect_err(name);
        assert_eq!(refused.code(), refusal, "{name}");
        assert_eq!(assets.get("sphere.glb"), None, "{name}");
        assert_eq!(draws(&assets, "sphere.glb"), (0, true), "{name}");
    }
}

#[test]
fn a_duplicate_entry_a_bad_digest_and_the_caps_are_refused() {
    let map = map_of(&[sphere_entry("a.glb"), sphere_entry("a.glb"), entry("b.glb", 4, "not-hex")]);
    let assets = WebAssets::plan(&map).expect("map");
    let planned: Vec<&str> = assets.planned().iter().map(|p| p.path.as_str()).collect();
    assert_eq!(planned, ["a.glb"]);
    let skipped: Vec<AssetRefusal> = assets.skipped().iter().map(|(_, why)| *why).collect();
    assert_eq!(skipped, [AssetRefusal::Duplicate, AssetRefusal::MapInvalid]);

    let half = MAX_ASSETS_TOTAL_BYTES / 2 + 1;
    let over_total = map_of(&[entry("one.glb", half.min(MAX_ASSET_BYTES), "0000000000000000"); 1]
        .into_iter()
        .chain((0..4).map(|i| entry(&format!("more-{i}.glb"), MAX_ASSET_BYTES, "0000000000000000")))
        .collect::<Vec<_>>());
    let capped = WebAssets::plan(&over_total).expect("map");
    let total: u64 = capped.planned().iter().map(|p| p.bytes).sum();
    assert!(total <= MAX_ASSETS_TOTAL_BYTES, "the planned total stays within the cap ({total})");
    assert!(capped.skipped().iter().all(|(_, why)| *why == AssetRefusal::OverBudget));
    assert!(!capped.skipped().is_empty());

    let many: Vec<String> = (0..=MAX_ASSET_FILES).map(|i| entry(&format!("f{i}.glb"), 1, "0000000000000000")).collect();
    let counted = WebAssets::plan(&map_of(&many)).expect("map");
    assert_eq!(counted.planned().len(), MAX_ASSET_FILES);
    assert_eq!(counted.skipped().len(), 1);
}
