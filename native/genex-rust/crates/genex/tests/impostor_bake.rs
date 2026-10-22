//! Build-time impostor atlases (game systems LOD-23): `game.impostor_bake` registers a model, the
//! dev build's headless session bakes its atlas at every class row (`bakeAssets` kind `impostor`,
//! `Presenter::bake_impostor_atlas`) as an RGBA8 KTX2 file, and a later launch whose assets hold
//! it under `baked/impostor/<name>` loads it instead of baking on the GPU. A changed model misses
//! and bakes at runtime; a streamed model never bakes mid-game and is refused `impostor-not-baked`.
//!
//! The GPU rows skip without a WebGPU-core adapter unless `GENEX_REQUIRE_METAL=1`; with
//! `GENEX_RENDER_EVIDENCE_DIR` set they write their captures there as PNGs (`lod-23/`).
//!
//!   node scripts/toolchains/rust-env.ts -- cargo test -p genex --test impostor_bake --offline --locked
#![allow(clippy::disallowed_types, reason = "the build-time bakes are timed for the receipt evidence; no simulation reads the clock")]

use std::path::{Path, PathBuf};
use std::time::Instant;

use genex::present::{BAKED_IMPOSTOR_FOLDER, Presenter, impostor_bake_name};
use genex::prelude::*;
use genex::{Impostor, LodRefusalCode, Runtime, View};
use genex_render::impostor::bake::{BAKED_ATLAS_KEY, BakedAtlas, baked_atlas_digest, class_from_wire, class_wire};
use genex_render::impostor::{ImpostorClass, ImpostorLayout};
use serde_json::{Value, json};

/// The world the GPU rows draw at.
const WORLD: [u32; 2] = [320, 240];
/// How far the tree stands: well past the impostor switch, well inside the far plane.
const FAR_M: f32 = 90.0;
/// The tag the streamed view set draws under (`present_stream::STREAM_TAG`).
const STREAM_TAG: &str = "stream";

// ---------------------------------------------------------------------------------------------
// Fixtures.

fn cuboid(min: [f32; 3], max: [f32; 3]) -> Vec<[f32; 3]> {
    let [x0, y0, z0] = min;
    let [x1, y1, z1] = max;
    let quad = |a: [f32; 3], b: [f32; 3], c: [f32; 3], d: [f32; 3]| [a, b, c, a, c, d];
    [
        quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]),
        quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]),
        quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]),
        quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]),
        quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]),
        quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]),
    ]
    .concat()
}

fn glb_of(parts: &[(Vec<[f32; 3]>, [f32; 4])]) -> Vec<u8> {
    let mut bin: Vec<u8> = Vec::new();
    let (mut views, mut accessors, mut primitives, mut materials) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for (at, (positions, color)) in parts.iter().enumerate() {
        let floats: Vec<u8> = positions.iter().flatten().flat_map(|f| f.to_le_bytes()).collect();
        let indices: Vec<u8> = (0..positions.len() as u32).flat_map(u32::to_le_bytes).collect();
        let min: Vec<f32> = (0..3).map(|i| positions.iter().map(|p| p[i]).fold(f32::INFINITY, f32::min)).collect();
        let max: Vec<f32> = (0..3).map(|i| positions.iter().map(|p| p[i]).fold(f32::NEG_INFINITY, f32::max)).collect();
        views.push(json!({ "buffer": 0, "byteOffset": bin.len(), "byteLength": floats.len() }));
        bin.extend(&floats);
        views.push(json!({ "buffer": 0, "byteOffset": bin.len(), "byteLength": indices.len() }));
        bin.extend(&indices);
        accessors.push(json!({ "bufferView": 2 * at, "componentType": 5126, "count": positions.len(), "type": "VEC3", "min": min, "max": max }));
        accessors.push(json!({ "bufferView": 2 * at + 1, "componentType": 5125, "count": positions.len(), "type": "SCALAR" }));
        primitives.push(json!({ "attributes": { "POSITION": 2 * at }, "indices": 2 * at + 1, "material": at }));
        materials.push(json!({ "pbrMetallicRoughness": { "baseColorFactor": color, "metallicFactor": 0.0, "roughnessFactor": 0.9 } }));
    }
    let gltf = json!({
        "asset": { "version": "2.0" },
        "buffers": [{ "byteLength": bin.len() }],
        "bufferViews": views,
        "accessors": accessors,
        "materials": materials,
        "meshes": [{ "primitives": primitives }],
        "nodes": [{ "mesh": 0 }], "scenes": [{ "nodes": [0] }], "scene": 0,
    });
    glb(&gltf, bin)
}

fn glb(gltf: &Value, mut bin: Vec<u8>) -> Vec<u8> {
    let mut json = serde_json::to_vec(gltf).expect("json");
    while !json.len().is_multiple_of(4) {
        json.push(b' ');
    }
    while !bin.len().is_multiple_of(4) {
        bin.push(0);
    }
    let mut out = Vec::new();
    out.extend(b"glTF");
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

/// A tree stand-in: a trunk and a crown of `crown` colour, 10 m tall.
fn tree_glb(crown: [f32; 4]) -> Vec<u8> {
    glb_of(&[(cuboid([-0.4, 0.0, -0.4], [0.4, 5.0, 0.4]), [0.35, 0.2, 0.1, 1.0]), (cuboid([-2.5, 4.0, -2.5], [2.5, 10.0, 2.5]), crown)])
}

const GREEN: [f32; 4] = [0.1, 0.5, 0.15, 1.0];
const AUTUMN: [f32; 4] = [0.7, 0.35, 0.05, 1.0];

/// A folder of its own under the system's temporary folder holding `tree.glb`.
fn folder(label: &str, crown: [f32; 4]) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("genex-impostor-bake-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("folder");
    std::fs::write(dir.join("tree.glb"), tree_glb(crown)).expect("written");
    dir
}

fn open_presenter(root: &Path) -> Option<Presenter> {
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    match Presenter::open_with_root(WORLD, &[], Some(root.to_owned())) {
        Ok(presenter) => Some(presenter),
        Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
        Err(_) => None,
    }
}

#[derive(Default)]
struct World {
    tree: Model,
}

/// A game drawing one tree with an impostor `FAR_M` away, registered for a build-time bake;
/// `streamed` draws it under the view set's tag, as a streamed cell's model is drawn.
fn runtime(streamed: bool) -> Runtime<World> {
    let mut game = Game::new(World::default()).title("Impostor bake").world_size(WORLD[0], WORLD[1]);
    game.camera(|_| Camera::look_at(vec3(0.0, 5.0, FAR_M), vec3(0.0, 5.0, 0.0)));
    game.impostor_bake(|gfx| gfx.assets().model("tree.glb").with_impostor(Impostor::hemi()));
    game.on_reset(|sim, _, _, gfx| sim.world.tree = gfx.assets().model("tree.glb").with_impostor(Impostor::hemi()));
    game.on_draw(move |sim, frame, _| {
        frame.sun(vec3(0.6, 0.8, 0.5), Color::WHITE, 3.0);
        frame.ambient(Color::WHITE, 0.4);
        if streamed {
            frame.tag(STREAM_TAG);
        }
        frame.model(&sim.world.tree, Transform::IDENTITY);
    });
    let mut runtime = Runtime::new(game).expect("valid registrations");
    runtime.seed(1);
    runtime.start();
    runtime.step(genex::FIXED_STEP_MS);
    runtime
}

/// The dev build's bake step in-process: every advertised impostor bake baked by a presenter on
/// `root` and written where the stage serves it (`assets/baked/impostor/<name>`). Answers each
/// bake's (name, bytes, milliseconds).
fn bake_at_build(root: &Path) -> Option<Vec<(String, usize, f64)>> {
    let mut presenter = open_presenter(root)?;
    let rt = runtime(false);
    let folder = root.join(BAKED_IMPOSTOR_FOLDER);
    std::fs::create_dir_all(&folder).expect("baked folder");
    let mut rows = Vec::new();
    for (name, model, class) in rt.impostor_bakes() {
        let started = Instant::now();
        let bytes = presenter.bake_impostor_atlas(&model, class).expect("baked");
        let ms = started.elapsed().as_secs_f64() * 1000.0;
        std::fs::write(folder.join(&name), &bytes).expect("written");
        rows.push((name, bytes.len(), ms));
    }
    Some(rows)
}

/// One settled capture (written as `lod-23/<name>/` when an evidence folder is set).
fn capture(presenter: &mut Presenter, runtime: &mut Runtime<World>, name: &str) -> Vec<u8> {
    presenter.set_capturing(true);
    presenter.draw_view(runtime, View::Game).expect("game view").expect("drawn");
    assert_eq!(presenter.failure(), None);
    let capture = presenter.resilient.capture().expect("capture");
    if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        let root = Path::new(&dir).join("lod-23").join(name);
        let mut files = genex_render::capture::CaptureFiles::new(&root).expect("evidence folder");
        files.write(&capture).expect("evidence");
    }
    capture.bgra().to_vec()
}

fn impostors_drawn(presenter: &Presenter) -> usize {
    presenter.resilient.renderer().renderer().impostor_draw().map_or(0, |draw| draw.rows().len())
}

fn share_past(a: &[u8], b: &[u8], step: u8) -> f64 {
    let past = a.as_chunks::<4>().0.iter().zip(b.as_chunks::<4>().0).filter(|(p, q)| (0..3).any(|c| p[c].abs_diff(q[c]) > step)).count();
    past as f64 / (a.len() / 4) as f64
}

/// `state()` as JSON text.
fn state_text(runtime: &Runtime<World>) -> String {
    runtime.state().to_string()
}

fn evidence(name: &str, value: &Value) {
    if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        let path = Path::new(&dir).join("lod-23");
        std::fs::create_dir_all(&path).expect("evidence folder");
        std::fs::write(path.join(name), serde_json::to_string_pretty(value).expect("json")).expect("evidence");
    }
}

// ---------------------------------------------------------------------------------------------
// GPU rows.

/// Red first (LOD-23): a second launch with the same model runs 0 runtime bakes. Before LOD-23
/// every launch baked once (`impostors::a_capture_waits_for_bakes_and_is_repeatable` asserts one
/// bake per presenter); now the build bakes and the launch loads the atlas, draws the far tree
/// as its impostor, and its capture is the runtime-baked one to the bit.
#[test]
fn a_launch_with_build_time_atlases_runs_no_runtime_bake() {
    let baked_root = folder("loads", GREEN);
    let Some(rows) = bake_at_build(&baked_root) else { return };
    assert_eq!(rows.len(), ImpostorClass::ALL.len(), "one atlas per class row: {rows:?}");
    let mut launch = open_presenter(&baked_root).expect("a second presenter");
    let mut rt = runtime(false);
    let loaded = capture(&mut launch, &mut rt, "build-time");
    assert_eq!(launch.impostor_bakes(), 0, "no runtime bake");
    assert_eq!(launch.impostor_loads(), 1, "the build-time atlas loaded");
    assert_eq!(impostors_drawn(&launch), 1, "the far tree draws as its impostor");
    let lod = launch.render_settings().expect("attached").borrow().status().lod;
    assert!(lod.impostors[0].prebaked && lod.impostors[0].bake_ms == 0.0, "{:?}", lod.impostors);
    // Against a launch that bakes at runtime (no baked folder).
    let plain_root = folder("runtime", GREEN);
    let mut runtime_bake = open_presenter(&plain_root).expect("a third presenter");
    let baked = capture(&mut runtime_bake, &mut runtime(false), "runtime-bake");
    assert_eq!((runtime_bake.impostor_bakes(), runtime_bake.impostor_loads()), (1, 0));
    assert_eq!(share_past(&loaded, &baked, 0), 0.0, "the loaded atlas draws the baked picture to the bit");
    // A Live launch loads too: the first frame already draws the impostor, with no bake.
    let mut live = open_presenter(&baked_root).expect("a Live presenter");
    live.draw_view(&mut runtime(false), View::Game).expect("game view").expect("drawn");
    assert_eq!((live.impostor_bakes(), live.impostor_loads(), impostors_drawn(&live)), (0, 1, 1));
    // The cold first Live frame with the atlas against one that bakes it, interleaved (advisory).
    let first_frame = |root: &Path| {
        let mut presenter = open_presenter(root).expect("a presenter");
        let mut rt = runtime(false);
        let started = Instant::now();
        presenter.draw_view(&mut rt, View::Game).expect("game view").expect("drawn");
        started.elapsed().as_secs_f64() * 1000.0
    };
    let (mut loaded_ms, mut baked_ms) = (Vec::new(), Vec::new());
    for _ in 0..5 {
        loaded_ms.push(first_frame(&baked_root));
        baked_ms.push(first_frame(&plain_root));
    }
    let median = |mut ms: Vec<f64>| {
        ms.sort_by(f64::total_cmp);
        ms[ms.len() / 2]
    };
    let first_frame_ms = json!({ "prebakedMedianMs": median(loaded_ms.clone()), "runtimeBakeMedianMs": median(baked_ms.clone()), "prebaked": loaded_ms, "runtimeBake": baked_ms });
    let receipt: Vec<Value> = rows
        .iter()
        .map(|(name, bytes, ms)| {
            let class = name.rsplit_once('-').map(|(_, class)| class).unwrap_or_default();
            json!({ "name": name, "class": class, "bytes": bytes, "bakeMs": ms })
        })
        .collect();
    let phone: usize = rows.iter().filter(|(name, _, _)| name.ends_with("-low") || name.ends_with("-mobile")).map(|(_, bytes, _)| bytes).sum();
    let desktop: usize = rows.iter().filter(|(name, _, _)| !name.ends_with("-mobile")).map(|(_, bytes, _)| bytes).sum();
    evidence("receipt.json", &json!({ "species": 1, "atlases": receipt, "phoneBytesPerSpecies": phone, "desktopBytesPerSpecies": desktop, "firstLiveFrame": first_frame_ms }));
    let _ = std::fs::remove_dir_all(&baked_root);
    let _ = std::fs::remove_dir_all(&plain_root);
}

/// Red first (LOD-23): a changed model's atlas from the earlier build is a miss: the launch bakes
/// it at runtime once (the build's next bake step rebakes it, `rust-bake.ts` keys its cache by the
/// stage's input digest) and never draws the stale atlas.
#[test]
fn a_changed_model_misses_its_stale_atlas_and_bakes_at_runtime() {
    let root = folder("changed", GREEN);
    if bake_at_build(&root).is_none() {
        return;
    }
    std::fs::write(root.join("tree.glb"), tree_glb(AUTUMN)).expect("the model changed");
    let mut launch = open_presenter(&root).expect("a second presenter");
    let changed = capture(&mut launch, &mut runtime(false), "changed");
    assert_eq!((launch.impostor_bakes(), launch.impostor_loads()), (1, 0), "the stale atlas is not loaded");
    assert_eq!(impostors_drawn(&launch), 1);
    let orange = changed.as_chunks::<4>().0.iter().filter(|p| p[2] > p[1] + 20).count();
    assert!(orange > 50, "the new autumn crown is drawn, not the stale green one: {orange} px");
    let _ = std::fs::remove_dir_all(&root);
}

/// Red first (LOD-23): a streamed model without a build-time atlas never bakes mid-game: it keeps
/// its coarsest mesh and `lodRefused` names it `impostor-not-baked`; with the atlas it loads.
#[test]
fn a_streamed_species_never_bakes_mid_game() {
    let root = folder("streamed", GREEN);
    let Some(mut presenter) = open_presenter(&root) else { return };
    let mut rt = runtime(true);
    let mesh = capture(&mut presenter, &mut rt, "streamed-not-baked");
    assert_eq!((presenter.impostor_bakes(), presenter.impostor_loads(), impostors_drawn(&presenter)), (0, 0, 0), "no bake mid-game");
    let state = state_text(&rt);
    assert!(state.contains(LodRefusalCode::ImpostorNotBaked.wire()), "lodRefused names it: {state}");
    let covered = mesh.as_chunks::<4>().0.iter().filter(|p| p[1] > p[0] + 20).count();
    assert!(covered > 50, "the coarsest mesh still draws the crown: {covered} px");
    drop(presenter);
    if bake_at_build(&root).is_none() {
        return;
    }
    let mut launch = open_presenter(&root).expect("a presenter");
    let mut rt = runtime(true);
    capture(&mut launch, &mut rt, "streamed-baked");
    assert_eq!((launch.impostor_bakes(), launch.impostor_loads(), impostors_drawn(&launch)), (0, 1, 1));
    assert!(!state_text(&rt).contains(LodRefusalCode::ImpostorNotBaked.wire()));
    let _ = std::fs::remove_dir_all(&root);
}

// ---------------------------------------------------------------------------------------------
// CPU rows.

/// A small atlas of `class` whose texels count up, so a misplaced byte shows.
fn atlas(class: ImpostorClass) -> BakedAtlas {
    let spec = class.spec();
    let levels = (0..spec.mip_levels())
        .map(|level| {
            let side = (spec.atlas_side() >> level).max(1) as usize;
            (0..side * side * 4 * 3).map(|at| (at % 251) as u8 ^ level as u8).collect()
        })
        .collect();
    BakedAtlas { class, layout: ImpostorLayout::Sphere, digest: 0x0123_4567_89ab_cdef, levels }
}

/// New behaviour (LOD-23): an atlas round-trips through its KTX2 file, which a KTX2 reader takes
/// as RGBA8, three layers, the class's levels stored smallest first, and the identity entry.
#[test]
fn a_baked_atlas_round_trips_through_rgba8_ktx2() {
    for class in [ImpostorClass::Mobile, ImpostorClass::Low] {
        let atlas = atlas(class);
        let bytes = atlas.to_ktx2();
        assert_eq!(BakedAtlas::from_ktx2(&bytes).expect("read"), atlas);
        let word = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().expect("word"));
        assert_eq!(&bytes[..12], &[0xAB, b'K', b'T', b'X', b' ', b'2', b'0', 0xBB, b'\r', b'\n', 0x1A, b'\n']);
        assert_eq!(word(12), 37, "VK_FORMAT_R8G8B8A8_UNORM");
        assert_eq!((word(20), word(24)), (class.spec().atlas_side(), class.spec().atlas_side()));
        assert_eq!((word(32), word(36), word(40), word(44)), (3, 1, class.spec().mip_levels(), 0), "layers, faces, levels, no supercompression");
        let offsets: Vec<u64> = (0..class.spec().mip_levels() as usize).map(|level| u64::from_le_bytes(bytes[80 + level * 24..88 + level * 24].try_into().expect("row"))).collect();
        assert!(offsets.windows(2).all(|pair| pair[0] > pair[1]), "smallest level first in the file: {offsets:?}");
        let (kvd_at, kvd_len) = (word(56) as usize, word(60) as usize);
        let kvd = &bytes[kvd_at..kvd_at + kvd_len];
        let entry = &kvd[4..4 + u32::from_le_bytes(kvd[..4].try_into().expect("length")) as usize];
        let split = entry.iter().position(|&b| b == 0).expect("a key");
        assert_eq!(&entry[..split], BAKED_ATLAS_KEY.as_bytes());
        let identity: [(&str, &[u8]); 1] = [(BAKED_ATLAS_KEY, &entry[split + 1..])];
        let text = String::from_utf8_lossy(identity[0].1);
        assert!(text.starts_with(&format!("format=1;class={};layout=sphere;digest=0123456789abcdef", class_wire(class))), "{text}");
    }
}

/// Hostile files are refused `texture-invalid` with nothing loaded, never a panic or a hang.
#[test]
fn a_hostile_atlas_file_is_refused() {
    let good = atlas(ImpostorClass::Mobile).to_ktx2();
    let replace = |from: &str, to: &str| {
        let text = String::from_utf8_lossy(&good).into_owned();
        assert!(text.contains(from));
        let at = good.windows(from.len()).position(|w| w == from.as_bytes()).expect("found");
        let mut bytes = good.clone();
        bytes[at..at + from.len()].copy_from_slice(to.as_bytes());
        bytes
    };
    let mut wrong_layers = good.clone();
    wrong_layers[32..36].copy_from_slice(&2u32.to_le_bytes());
    let mut wrong_format = good.clone();
    wrong_format[12..16].copy_from_slice(&43u32.to_le_bytes());
    let mut huge_kvd = good.clone();
    huge_kvd[60..64].copy_from_slice(&u32::MAX.to_le_bytes());
    let hostile: Vec<(&str, Vec<u8>)> = vec![
        ("empty", Vec::new()),
        ("truncated", good[..good.len() / 2].to_vec()),
        ("not ktx2", b"glTF and more bytes than a header holds, glTF and more".to_vec()),
        ("another class's size", replace("class=mobile", "class=low;x=")),
        ("unknown class", replace("class=mobile", "class=mobilx")),
        ("another format version", replace("format=1", "format=2")),
        ("short digest", replace("digest=0123456789abcdef", "digest=0123456789abcde;")),
        ("foreign key", replace(BAKED_ATLAS_KEY, "genex.imposter")),
        ("two layers", wrong_layers),
        ("another vkFormat", wrong_format),
        ("a key/value length past the file", huge_kvd),
    ];
    for (label, bytes) in hostile {
        let refused = BakedAtlas::from_ktx2(&bytes);
        assert_eq!(refused.as_ref().map_err(|error| error.code().wire()).err(), Some("texture-invalid"), "{label}");
    }
}

/// The bake names are bake names (`isBakeName`), one per class row, stable per key; the digest
/// moves with the model, the class and the layout.
#[test]
fn bake_names_and_digests() {
    let bake_name = |name: &str| {
        let first = name.chars().next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
        first && name.len() <= 64 && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
    };
    let names: Vec<String> = ImpostorClass::ALL.iter().map(|class| impostor_bake_name("trees/oak.glb", *class)).collect();
    assert!(names.iter().all(|name| bake_name(name)), "{names:?}");
    assert_eq!(names.iter().collect::<std::collections::BTreeSet<_>>().len(), names.len());
    assert_eq!(impostor_bake_name("trees/oak.glb", ImpostorClass::High), names[1]);
    assert_ne!(impostor_bake_name("trees/elm.glb", ImpostorClass::High), names[1]);
    for class in ImpostorClass::ALL {
        assert_eq!(class_from_wire(class_wire(class)), Some(class));
    }
    let base = baked_atlas_digest(7, ImpostorClass::High, ImpostorLayout::Hemi);
    assert_ne!(base, baked_atlas_digest(8, ImpostorClass::High, ImpostorLayout::Hemi), "the model");
    assert_ne!(base, baked_atlas_digest(7, ImpostorClass::Mid, ImpostorLayout::Hemi), "the class");
    assert_ne!(base, baked_atlas_digest(7, ImpostorClass::High, ImpostorLayout::Sphere), "the layout");
    assert_eq!(LodRefusalCode::ImpostorNotBaked.wire(), "impostor-not-baked");
}

/// A registered model with no impostor, or registered twice, is advertised once or not at all.
#[test]
fn only_models_with_an_impostor_are_advertised_once_per_row() {
    let mut game = Game::new(World::default()).world_size(WORLD[0], WORLD[1]);
    game.impostor_bake(|gfx| gfx.assets().model("tree.glb").with_impostor(Impostor::hemi()));
    game.impostor_bake(|gfx| gfx.assets().model("tree.glb").with_impostor(Impostor::hemi()));
    game.impostor_bake(|gfx| gfx.assets().model("rock.glb"));
    game.impostor_bake(|_| Model::default().with_impostor(Impostor::hemi()));
    let rt = Runtime::new(game).expect("valid registrations");
    let bakes = rt.impostor_bakes();
    let names: Vec<&str> = bakes.iter().map(|(name, _, _)| name.as_str()).collect();
    let expected: Vec<String> = ImpostorClass::ALL.iter().map(|class| impostor_bake_name("tree.glb", *class)).collect();
    assert_eq!(names, expected);
}
