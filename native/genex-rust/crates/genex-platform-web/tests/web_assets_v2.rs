//! The web asset map v2 (game systems SF-2): groups, byte ranges and per-family texture entries,
//! admitted by the module under the v1 rules (asset-path rule, caps, exact length and FNV-1a 64)
//! applied per range. A v1 map plans and admits exactly as before. Every refusal leaves the set as
//! it was: nothing planned, queued or loaded changes.

use genex::{AssetGroup, AssetGroups};
use genex_core::digest::{fnv1a64, hex64};
use genex_platform_web::assets::{AssetRefusal, Fetch, MAX_RANGES_PER_FILE, WebAssets};
use genex_render::texture::TextureFamily;
use serde_json::{Value, json};

/// A file of `length` bytes whose content is its position, so every range has its own digest.
fn file(length: usize) -> Vec<u8> {
    (0..length).map(|at| (at % 251) as u8).collect()
}

fn digest(bytes: &[u8]) -> String {
    hex64(fnv1a64(bytes))
}

/// A v2 entry for `bytes` at `path` in `group`.
fn entry(path: &str, bytes: &[u8], group: &str) -> Value {
    json!({"path": path, "bytes": bytes.len(), "fnv1a64": digest(bytes), "group": group})
}

/// The range `[offset, offset + length)` of `bytes`, as the map records it.
fn range(bytes: &[u8], offset: usize, length: usize) -> Value {
    json!({"offset": offset, "bytes": length, "fnv1a64": digest(&bytes[offset..offset + length])})
}

fn map(version: u64, files: Vec<Value>) -> Vec<u8> {
    serde_json::to_vec(&json!({"version": version, "files": files})).expect("JSON")
}

/// Everything a refusal must leave alone: what is planned, preloaded, queued and loaded.
fn state(assets: &WebAssets) -> String {
    format!("{:?}", assets)
}

/// A cell pack streamed by two ranges, a level in the sim group, and the boot sphere.
fn streamed_set() -> (Vec<u8>, Vec<u8>) {
    let pack = file(1000);
    let level = file(40);
    let files = vec![
        entry("levels/one.json", &level, "sim"),
        json!({"path": "cells/0_0.pack", "bytes": 1000, "fnv1a64": digest(&pack), "group": "stream",
               "ranges": [range(&pack, 0, 64), range(&pack, 64, 936)]}),
    ];
    (map(2, files), pack)
}

#[test]
fn a_v1_map_preloads_every_entry_in_the_sim_group_and_admits_as_before() {
    let level = file(40);
    let v1 = map(1, vec![json!({"path": "levels/one.json", "bytes": 40, "fnv1a64": digest(&level)})]);
    let mut assets = WebAssets::plan(&v1).expect("a v1 map");
    let preload: Vec<&str> = assets.preload().map(|asset| asset.path.as_str()).collect();
    assert_eq!(preload, ["levels/one.json"], "a v1 map has no streamed group: the shell fetches everything first");
    assert_eq!(assets.groups().of("levels/one.json"), AssetGroup::Sim);
    assets.admit("levels/one.json", level.clone()).expect("admitted as before");
    assert_eq!(assets.get("levels/one.json"), Some(level.as_slice()));
}

#[test]
fn a_v2_map_preloads_boot_and_sim_and_records_every_group() {
    let (map, _) = streamed_set();
    let mut files: Value = serde_json::from_slice(&map).expect("JSON");
    let sphere = file(80);
    let forest = file(30);
    let list = files["files"].as_array_mut().expect("files");
    list.push(entry("sphere.glb", &sphere, "boot"));
    list.push(json!({"path": "forest/tree.glb", "bytes": 30, "fnv1a64": digest(&forest), "group": "named", "name": "forest"}));
    list.push(json!({"path": "defaults.json", "bytes": 40, "fnv1a64": digest(&file(40))}));
    let assets = WebAssets::plan(&serde_json::to_vec(&files).expect("JSON")).expect("a v2 map");
    let preload: Vec<&str> = assets.preload().map(|asset| asset.path.as_str()).collect();
    assert_eq!(preload, ["levels/one.json", "sphere.glb", "defaults.json"], "boot and sim (the default) only, in map order");
    let groups = assets.groups();
    let expected = AssetGroups::default()
        .with("cells/0_0.pack", AssetGroup::Stream)
        .with("sphere.glb", AssetGroup::Boot)
        .with("forest/tree.glb", AssetGroup::Named);
    for path in ["levels/one.json", "cells/0_0.pack", "sphere.glb", "forest/tree.glb", "defaults.json"] {
        assert_eq!(groups.of(path), expected.of(path), "{path}");
    }
    assert_eq!(assets.planned().iter().find(|asset| asset.path == "forest/tree.glb").and_then(|asset| asset.name.as_deref()), Some("forest"));
}

#[test]
fn a_streamed_file_is_wanted_range_by_range_and_each_range_is_admitted_by_its_own_digest() {
    let (map, pack) = streamed_set();
    let mut assets = WebAssets::plan(&map).expect("map");
    assert!(assets.take_wanted().is_empty(), "nothing streamed is wanted before the game asks");
    assets.want("cells/0_0.pack").expect("a planned stream entry");
    assets.want("cells/0_0.pack").expect("wanting twice queues once");
    let wanted = assets.take_wanted();
    assert_eq!(wanted, [Fetch { path: "cells/0_0.pack".to_owned(), offset: 0, bytes: 64 }, Fetch { path: "cells/0_0.pack".to_owned(), offset: 64, bytes: 936 }]);
    assets.arrived("cells/0_0.pack", 64, pack[64..].to_vec()).expect("the second range");
    assert_eq!(assets.range("cells/0_0.pack", 64), Some(&pack[64..]));
    assert_eq!(assets.range("cells/0_0.pack", 0), None, "the first has not arrived");
    assets.want("cells/0_0.pack").expect("want again");
    assert_eq!(assets.take_wanted(), [Fetch { path: "cells/0_0.pack".to_owned(), offset: 0, bytes: 64 }], "only the missing range");
    assets.arrived("cells/0_0.pack", 0, pack[..64].to_vec()).expect("the first range");
    assets.release("cells/0_0.pack").expect("a streamed file can be released");
    assert_eq!(assets.range("cells/0_0.pack", 0), None, "released bytes are gone");
    assets.want("cells/0_0.pack").expect("and wanted again");
    assert_eq!(assets.take_wanted().len(), 2);
}

/// One hostile v2 case: the map, then an optional arrival, and the code it is refused with.
struct Hostile {
    name: &'static str,
    map: Vec<u8>,
    arrival: Option<(&'static str, u64, Vec<u8>)>,
    refusal: AssetRefusal,
}

fn hostile() -> Vec<Hostile> {
    let pack = file(1000);
    let ranged = |ranges: Value, group: &str| {
        map(2, vec![json!({"path": "cells/a.pack", "bytes": 1000, "fnv1a64": digest(&pack), "group": group, "ranges": ranges})])
    };
    let good = ranged(json!([range(&pack, 0, 64), range(&pack, 64, 936)]), "stream");
    let mut flipped = pack[..64].to_vec();
    flipped[3] ^= 0xff;
    vec![
        Hostile { name: "a range past the end of the file", map: ranged(json!([range(&pack, 0, 64), {"offset": 900, "bytes": 200, "fnv1a64": digest(&pack[900..])}]), "stream"), arrival: None, refusal: AssetRefusal::RangeInvalid },
        Hostile { name: "a range whose end overflows", map: ranged(json!([{"offset": u64::MAX, "bytes": 2, "fnv1a64": "0000000000000000"}]), "stream"), arrival: None, refusal: AssetRefusal::RangeInvalid },
        Hostile { name: "overlapping ranges", map: ranged(json!([range(&pack, 0, 64), range(&pack, 60, 100)]), "stream"), arrival: None, refusal: AssetRefusal::RangeInvalid },
        Hostile { name: "an empty range", map: ranged(json!([{"offset": 0, "bytes": 0, "fnv1a64": digest(&[])}]), "stream"), arrival: None, refusal: AssetRefusal::RangeInvalid },
        Hostile { name: "a range with no digest", map: ranged(json!([{"offset": 0, "bytes": 64}]), "stream"), arrival: None, refusal: AssetRefusal::RangeInvalid },
        Hostile { name: "too many ranges", map: ranged(Value::Array((0..=MAX_RANGES_PER_FILE).map(|n| range(&pack, n, 1)).collect()), "stream"), arrival: None, refusal: AssetRefusal::RangeInvalid },
        Hostile { name: "a streamed (ranged) entry claiming the boot group", map: ranged(json!([range(&pack, 0, 64)]), "boot"), arrival: None, refusal: AssetRefusal::GroupInvalid },
        Hostile { name: "a ranged entry claiming the sim group", map: ranged(json!([range(&pack, 0, 64)]), "sim"), arrival: None, refusal: AssetRefusal::GroupInvalid },
        Hostile { name: "a group the map format does not have", map: map(2, vec![entry("a.json", &pack, "lobby")]), arrival: None, refusal: AssetRefusal::GroupInvalid },
        Hostile { name: "a named group with no name", map: map(2, vec![entry("a.json", &pack, "named")]), arrival: None, refusal: AssetRefusal::GroupInvalid },
        Hostile { name: "bytes for an unplanned range", map: good.clone(), arrival: Some(("cells/a.pack", 32, pack[32..96].to_vec())), refusal: AssetRefusal::NotPlanned },
        Hostile { name: "the whole file for a ranged entry", map: good.clone(), arrival: Some(("cells/a.pack", 0, pack.clone())), refusal: AssetRefusal::SizeMismatch },
        Hostile { name: "a per-range digest mismatch", map: good.clone(), arrival: Some(("cells/a.pack", 0, flipped)), refusal: AssetRefusal::DigestMismatch },
        Hostile { name: "a range shorter than planned", map: good.clone(), arrival: Some(("cells/a.pack", 64, pack[64..900].to_vec())), refusal: AssetRefusal::SizeMismatch },
        Hostile { name: "bytes at an offset of an unranged entry", map: map(2, vec![entry("a.json", &pack, "stream")]), arrival: Some(("a.json", 8, pack[8..].to_vec())), refusal: AssetRefusal::NotPlanned },
    ]
}

#[test]
fn each_hostile_v2_entry_or_arrival_is_refused_with_no_side_effect() {
    for row in hostile() {
        let mut assets = WebAssets::plan(&row.map).expect("the map itself is well formed");
        match row.arrival {
            None => {
                assert!(assets.planned().is_empty(), "{}: nothing is planned", row.name);
                assert!(assets.preload().next().is_none(), "{}: nothing is fetched", row.name);
                assert_eq!(assets.skipped().first().map(|(_, why)| *why), Some(row.refusal), "{}", row.name);
                let path = assets.skipped()[0].0.clone();
                let before = state(&assets);
                assert_eq!(assets.want(&path).expect_err(row.name).code(), AssetRefusal::NotPlanned, "{}", row.name);
                assert_eq!(assets.arrived(&path, 0, file(64)).expect_err(row.name).code(), AssetRefusal::NotPlanned, "{}", row.name);
                assert_eq!(state(&assets), before, "{}: no side effect", row.name);
            }
            Some((path, offset, bytes)) => {
                assets.want(path).expect("planned");
                let before = state(&assets);
                assert_eq!(assets.arrived(path, offset, bytes).expect_err(row.name).code(), row.refusal, "{}", row.name);
                assert_eq!(state(&assets), before, "{}: no side effect", row.name);
            }
        }
    }
}

#[test]
fn an_arrived_range_cannot_arrive_twice_and_a_boot_asset_cannot_be_released() {
    let (map, pack) = streamed_set();
    let mut assets = WebAssets::plan(&map).expect("map");
    assets.arrived("cells/0_0.pack", 0, pack[..64].to_vec()).expect("first");
    let before = state(&assets);
    assert_eq!(assets.arrived("cells/0_0.pack", 0, pack[..64].to_vec()).expect_err("twice").code(), AssetRefusal::NotPlanned);
    assert_eq!(assets.release("levels/one.json").expect_err("a sim asset stays resident").code(), AssetRefusal::GroupInvalid);
    assert_eq!(assets.release("nope.json").expect_err("unplanned").code(), AssetRefusal::NotPlanned);
    assert_eq!(state(&assets), before, "no side effect");
}

/// A texture shipped as BC, ASTC and ETC2 family files plus its source image.
fn families_map() -> (Vec<u8>, Vec<(&'static str, Vec<u8>)>) {
    let files: Vec<(&str, &str, Vec<u8>)> = vec![
        ("textures/rock.bc.ktx2", "bc", file(100)),
        ("textures/rock.astc.ktx2", "astc", file(101)),
        ("textures/rock.etc2.ktx2", "etc2", file(102)),
        ("textures/rock.png", "source", file(103)),
    ];
    let entries = files
        .iter()
        .map(|(path, family, bytes)| json!({"path": path, "bytes": bytes.len(), "fnv1a64": digest(bytes), "group": "boot", "of": "textures/rock.png", "family": family}))
        .chain([entry("levels/one.json", &file(40), "sim")])
        .collect();
    (map(2, entries), files.into_iter().map(|(path, _, bytes)| (path, bytes)).collect())
}

#[test]
fn per_family_entries_plan_only_the_adapters_family_and_admit_only_it() {
    let (map, files) = families_map();
    let rows: [(&str, &[TextureFamily], &str); 4] = [
        ("a BC adapter", &[TextureFamily::Bc7], "textures/rock.bc.ktx2"),
        ("a phone with ASTC and ETC2", &[TextureFamily::Astc4x4, TextureFamily::Etc2Rgba8], "textures/rock.astc.ktx2"),
        ("an ETC2-only adapter", &[TextureFamily::Etc2Rgba8], "textures/rock.etc2.ktx2"),
        ("no compressed feature", &[], "textures/rock.png"),
    ];
    for (name, usable, picked) in rows {
        let mut assets = WebAssets::plan_for(&map, usable).expect("map");
        let preload: Vec<&str> = assets.preload().map(|asset| asset.path.as_str()).collect();
        assert_eq!(preload, [picked, "levels/one.json"], "{name}: one of four files for the texture");
        for (path, bytes) in &files {
            let answer = assets.admit(path, bytes.clone());
            if *path == picked {
                answer.unwrap_or_else(|error| panic!("{name}: {error}"));
            } else {
                assert_eq!(answer.expect_err(name).code(), AssetRefusal::NotPlanned, "{name}: {path}");
            }
        }
    }
}

#[test]
fn a_family_entry_without_its_texture_or_with_an_unknown_family_is_left_out() {
    let bytes = file(10);
    let rows = [
        ("no of", json!({"path": "a.bc.ktx2", "bytes": 10, "fnv1a64": digest(&bytes), "family": "bc"})),
        ("an unknown family", json!({"path": "a.pvrtc.ktx2", "bytes": 10, "fnv1a64": digest(&bytes), "family": "pvrtc", "of": "a.png"})),
    ];
    for (name, row) in rows {
        let assets = WebAssets::plan(&map(2, vec![row])).expect("map");
        assert!(assets.planned().is_empty(), "{name}");
        assert_eq!(assets.skipped()[0].1, AssetRefusal::MapInvalid, "{name}");
    }
}

#[test]
fn after_boot_the_streaming_part_keeps_only_streamed_entries() {
    let (map, pack) = streamed_set();
    let mut assets = WebAssets::plan(&map).expect("map");
    assets.admit("levels/one.json", file(40)).expect("preloaded");
    let mut streaming = assets.streaming_part();
    assert_eq!(streaming.get("levels/one.json"), None, "the preloaded bytes moved to the game's source");
    assert_eq!(streaming.arrived("levels/one.json", 0, file(40)).expect_err("preloaded already").code(), AssetRefusal::NotPlanned);
    streaming.want("cells/0_0.pack").expect("streamed");
    streaming.arrived("cells/0_0.pack", 0, pack[..64].to_vec()).expect("a range after boot");
}

#[test]
fn the_new_codes_keep_their_wire_spellings() {
    assert_eq!(AssetRefusal::RangeInvalid.wire(), "asset-range-invalid");
    assert_eq!(AssetRefusal::GroupInvalid.wire(), "asset-group-invalid");
}

#[derive(Default)]
struct World {
    outcome: Vec<String>,
}

/// What `studio_boot` builds: the preloaded files, with the map's groups, behind the sim's reads.
/// A reset reads the sim-group level and is refused the streamed pack `not-preloaded`, as natively.
#[test]
fn the_maps_groups_reach_the_sims_reads_as_studio_boot_wires_them() {
    let (map, _) = streamed_set();
    let mut assets = WebAssets::plan(&map).expect("map");
    assets.admit("levels/one.json", file(40)).expect("preloaded");
    let groups = assets.groups();
    let source = genex_platform_web::studio::WebSource::new(&[], assets).with_groups(groups);
    let mut game = genex::Game::new(World::default()).world_size(64, 64);
    game.on_reset(|sim, _, _, gfx| {
        for path in ["levels/one.json", "cells/0_0.pack"] {
            let answer = gfx.assets().bytes(path);
            sim.world.outcome.push(answer.map_or_else(|error| error.code().wire().to_owned(), |_| "ok".to_owned()));
        }
    });
    let runtime = genex::Runtime::with_assets(game, Box::new(source)).expect("valid game");
    assert_eq!(runtime.sim().world.outcome, ["ok", "not-preloaded"]);
}
