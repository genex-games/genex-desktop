//! `gfx.character(path)` on the web: a rig the page fetched and admitted before `studio_boot`
//! loads at reset from the web's asset source exactly as a desktop's asset folder and a compiled
//! table serve it (one skeleton, one checksum), and a streamed rig refuses the same way.

use genex::prelude::*;
use genex::{AssetFiles, AssetGroup, AssetGroups, AssetSource, AssetTable, CharacterAsset, Runtime};
use genex_core::digest::{fnv1a64, hex64};
use genex_platform_web::assets::WebAssets;
use genex_platform_web::studio::WebSource;

/// A three-joint chain (hips, spine, head) skinning one triangle: a GLB as an exporter writes it.
fn chain_glb() -> Vec<u8> {
    let mut bin: Vec<u8> = Vec::new();
    let positions = [0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
    positions.iter().for_each(|v| bin.extend(v.to_le_bytes()));
    [0u16, 1, 0, 0, 1, 2, 0, 0, 2, 0, 0, 0].iter().for_each(|v| bin.extend(v.to_le_bytes()));
    [0.75f32, 0.25, 0.0, 0.0].repeat(3).iter().for_each(|v| bin.extend(v.to_le_bytes()));
    [0u16, 1, 2, 0].iter().for_each(|v| bin.extend(v.to_le_bytes()));
    // Inverse binds of joints at y = 0, 1 and 2.
    for y in [0.0f32, -1.0, -2.0] {
        let matrix = [1.0f32, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, y, 0.0, 1.0];
        matrix.iter().for_each(|v| bin.extend(v.to_le_bytes()));
    }
    let json = format!(
        concat!(
            r#"{{"asset":{{"version":"2.0"}},"buffers":[{{"byteLength":{}}}],"#,
            r#""bufferViews":[{{"buffer":0,"byteOffset":0,"byteLength":36}},{{"buffer":0,"byteOffset":36,"byteLength":24}},{{"buffer":0,"byteOffset":60,"byteLength":48}},{{"buffer":0,"byteOffset":108,"byteLength":6}},{{"buffer":0,"byteOffset":116,"byteLength":192}}],"#,
            r#""accessors":[{{"bufferView":0,"componentType":5126,"count":3,"type":"VEC3","min":[0,0,0],"max":[1,1,0]}},{{"bufferView":1,"componentType":5123,"count":3,"type":"VEC4"}},{{"bufferView":2,"componentType":5126,"count":3,"type":"VEC4"}},{{"bufferView":3,"componentType":5123,"count":3,"type":"SCALAR"}},{{"bufferView":4,"componentType":5126,"count":3,"type":"MAT4"}}],"#,
            r#""meshes":[{{"primitives":[{{"attributes":{{"POSITION":0,"JOINTS_0":1,"WEIGHTS_0":2}},"indices":3}}]}}],"#,
            r#""skins":[{{"joints":[1,2,3],"inverseBindMatrices":4}}],"#,
            r#""nodes":[{{"name":"Body","mesh":0,"skin":0}},{{"name":"Hips","children":[2]}},{{"name":"Spine","translation":[0,1,0],"children":[3]}},{{"name":"Head","translation":[0,1,0]}}],"#,
            r#""scenes":[{{"nodes":[0,1]}}],"scene":0}}"#
        ),
        bin.len()
    );
    glb(&json, &bin)
}

/// GLB container bytes around a JSON chunk and a BIN chunk.
fn glb(json: &str, bin: &[u8]) -> Vec<u8> {
    let mut json = json.as_bytes().to_vec();
    json.resize(json.len().next_multiple_of(4), b' ');
    let mut bin = bin.to_vec();
    bin.resize(bin.len().next_multiple_of(4), 0);
    let mut out = b"glTF".to_vec();
    out.extend(2u32.to_le_bytes());
    out.extend(((12 + 8 + json.len() + 8 + bin.len()) as u32).to_le_bytes());
    out.extend((json.len() as u32).to_le_bytes());
    out.extend(b"JSON");
    out.extend(&json);
    out.extend((bin.len() as u32).to_le_bytes());
    out.extend(b"BIN\0");
    out.extend(&bin);
    out
}

/// The fetched set a page admits for `files`, by the build's asset map (version 1).
fn fetched(files: &[(&str, &[u8])]) -> WebAssets {
    let entries: Vec<String> =
        files.iter().map(|(path, bytes)| format!(r#"{{"path":"{path}","bytes":{},"fnv1a64":"{}"}}"#, bytes.len(), hex64(fnv1a64(bytes)))).collect();
    let map = format!(r#"{{"version":1,"files":[{}]}}"#, entries.join(","));
    let mut assets = WebAssets::plan(map.as_bytes()).expect("a well-formed map");
    for (path, bytes) in files {
        assets.admit(path, bytes.to_vec()).expect("admitted");
    }
    assets
}

#[derive(Default)]
struct World {
    hero: Option<CharacterAsset>,
    outcome: String,
    steps: u64,
}

fn hero_game() -> Game<World> {
    let mut game = Game::new(World::default()).world_size(64, 64);
    game.on_reset(|sim, _, _, gfx| match gfx.character("characters/hero.glb") {
        Ok(hero) => sim.world.hero = Some(hero),
        Err(error) => sim.world.outcome = error.code.wire().to_owned(),
    });
    game.on_update(|sim, ctx| sim.world.steps += u64::from(ctx.rng.below(4)));
    game.probe("joints", |sim| json!(sim.world.hero.as_ref().map(CharacterAsset::joint_count)));
    game.probe("steps", |sim| json!(sim.world.steps));
    game
}

fn run(source: Box<dyn AssetSource>) -> (Option<CharacterAsset>, String, String) {
    let mut runtime = Runtime::with_assets(hero_game(), source).expect("valid game");
    runtime.step(1000.0);
    let world = &runtime.sim().world;
    (world.hero.clone(), world.outcome.clone(), runtime.checksum())
}

#[test]
fn the_web_loads_the_same_rig_from_its_fetched_set() {
    let hero: &'static [u8] = Box::leak(chain_glb().into_boxed_slice());
    let table: AssetTable = Box::leak(vec![("characters/hero.glb", hero)].into_boxed_slice());
    let dir = std::env::temp_dir().join(format!("genex-web-character-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("assets/characters")).expect("assets folder");
    std::fs::write(dir.join("assets/characters/hero.glb"), hero).expect("hero");

    let web = run(Box::new(WebSource::new(&[], fetched(&[("characters/hero.glb", hero)]))));
    let compiled = run(Box::new(table));
    let desktop = run(Box::new(AssetFiles::new(&[], Some(dir.join("assets")))));
    let rig = web.0.as_ref().expect("the web loads the rig");
    assert_eq!(rig.joint_count(), 3);
    let names: Vec<&str> = rig.skeleton().joints().map(|joint| rig.skeleton().name(joint)).collect();
    assert_eq!(names, ["Hips", "Spine", "Head"]);
    assert_eq!(web, compiled, "the web's fetched set and the compiled table");
    assert_eq!(web, desktop, "the web and a desktop's asset folder");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_streamed_rig_refuses_on_the_web_as_on_a_desktop() {
    let hero: &'static [u8] = Box::leak(chain_glb().into_boxed_slice());
    let groups = AssetGroups::default().with("characters/hero.glb", AssetGroup::Stream);
    let web = WebSource::new(&[], fetched(&[("characters/hero.glb", hero)])).with_groups(groups.clone());
    let desktop = AssetFiles::new(Box::leak(vec![("characters/hero.glb", hero)].into_boxed_slice()), None).with_groups(groups);
    let (web_hero, web_outcome, _) = run(Box::new(web));
    let (desktop_hero, desktop_outcome, _) = run(Box::new(desktop));
    assert_eq!((web_hero, web_outcome.as_str()), (None, "animation-asset-invalid"));
    assert_eq!((desktop_hero, desktop_outcome.as_str()), (None, "animation-asset-invalid"));
}
