//! The interior-kit example (`src/game-template-rust/docs/examples/interior-kit`) as a game gets it:
//! its shipped `assets/kit/` (the GLBs, sheets and decals `interior_kit.py` and `kit/build_kit.py`
//! make, and the hero models `kit/hero.py` fits), its genex.toml admitted, a probe and a volume per
//! room, colliders where the walls are solid and none in their openings, and (on the host GPU) a
//! capture of the corridor and the classroom per preset:
//!
//!   GENEX_REQUIRE_METAL=1 GENEX_EXAMPLES_ASSETS=<scans> node scripts/toolchains/rust-env.ts -- \
//!     cargo test -p template-examples --release --offline --locked --test interior_kit -- --ignored metal --nocapture

#[path = "../../../../../src/game-template-rust/docs/examples/interior-kit/src/game.rs"]
mod game;
mod support;

use std::path::Path;

use genex::physics::{QueryFilter, Ray};
use genex::prelude::*;
use genex::render::{QualityPreset, RenderConfig};
use genex::{FIXED_STEP_MS, Runtime, View};

use game::World;

const GENEX_TOML: &str = include_str!("../../../../../src/game-template-rust/docs/examples/interior-kit/genex.toml");
const KIT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../src/game-template-rust/docs/examples/interior-kit/assets");
const WORLD_SIZE: [u32; 2] = [1280, 720];
/// The decals a desktop preset draws at most: every one of the level's is drawn.
const DESKTOP_DECALS: usize = 64;

/// The example as its `main.rs` builds it, with its genex.toml's `[render]` as a lane build reads it.
fn level() -> Game<World> {
    let mut game = Game::new(World::default()).title("Interior kit").world_size(WORLD_SIZE[0], WORLD_SIZE[1]);
    game::wire(&mut game);
    game.render_settings(game::look(RenderConfig::from_toml(GENEX_TOML).expect("the example's [render] is admitted")));
    game
}

/// The shipped kit, plus the CC0 scans from `GENEX_EXAMPLES_ASSETS` when it is set.
fn assets() -> genex::AssetTable {
    support::assets(&support::folder(Path::new(KIT)))
}

fn started() -> Runtime<World> {
    let mut runtime = Runtime::with_assets(level(), Box::new(assets())).expect("the example installs");
    runtime.seed(1);
    runtime.start();
    runtime.step(FIXED_STEP_MS * 30.0);
    runtime
}

#[test]
fn the_level_draws_every_part_from_the_kit_with_a_probe_and_volume_per_room() {
    let mut runtime = started();
    assert_eq!(runtime.state()["kit"]["pieces"], 37, "every piece the level names is loaded");
    let frame = runtime.frame(View::Game).expect("a frame");
    let tags: Vec<&str> = frame.draws().iter().map(|draw| draw.tag.as_str()).collect();
    for tag in ["outside", "shell", "windows", "props", "lamps"] {
        assert!(tags.contains(&tag), "the level draws {tag}");
    }
    let shapes: Vec<String> = frame.draws().iter().map(|draw| format!("{:?}", draw.shape)).collect();
    for piece in ["kit/wall-window.glb", "kit/window-grille-sunburst.glb", "kit/desk.glb", "kit/hero/lockers.glb", "kit/hero/car-shell.glb", "kit/debris-pile.glb"] {
        assert!(shapes.iter().any(|shape| shape.contains(piece)), "the level draws {piece}");
    }
    assert_eq!(frame.lights().reflection_probes.len(), 2, "a probe for the corridor and one for the classroom");
}

#[test]
fn the_wear_is_the_kits_decals_and_every_one_is_drawn() {
    let mut runtime = started();
    let frame = runtime.frame(View::Game).expect("a frame");
    let decals = frame.decals();
    assert!((30..=DESKTOP_DECALS).contains(&decals.len()), "enough wear to read, within what a desktop draws: {}", decals.len());
    let textures: Vec<String> = decals.iter().map(|decal| format!("{decal:?}")).collect();
    for name in ["grime_base", "peel_edge", "leak", "peel_patch", "ceiling_stain", "chalk", "poster_space", "poster_study", "poster_table", "poster_defence"] {
        assert!(textures.iter().any(|decal| decal.contains(&format!("kit/decals/{name}.png"))), "the wear includes {name}");
    }
    let again = runtime.frame(View::Game).expect("a frame").decals().to_vec();
    assert_eq!(decals.to_vec(), again, "the wear comes from the layout seed, not the frame");
}

#[test]
fn the_walls_stop_a_ray_where_they_are_solid_and_let_it_through_their_openings() {
    let runtime = started();
    let physics = &runtime.sim().physics;
    let hit = |from: Vec3, towards: Vec3| physics.cast_ray(&Ray::new(from, towards), 30.0, true, QueryFilter::default()).map(|(_, toi)| toi);
    // A plain module at x = 1: the corridor's face is FACE from its line at z = 0.
    let plain = hit(vec3(1.0, 1.6, 2.0), Vec3::NEG_Z).expect("the plain wall stops it");
    assert!((plain - (2.0 - 0.125)).abs() < 1e-3, "at the wall's face: {plain}");
    // The window at x = 3 at eye height, and the classroom door at x = 5 below its head.
    assert!(hit(vec3(3.0, 1.6, 2.0), Vec3::NEG_Z).is_none(), "the window's opening lets it out");
    assert!(hit(vec3(3.0, 0.5, 2.0), Vec3::NEG_Z).is_some(), "the wall under the sill stops it");
    // Below the sill of the classroom's window opposite, so the ray meets that wall, not the yard.
    let door = hit(vec3(5.0, 0.6, 2.0), Vec3::Z).expect("past the door, the classroom's far wall");
    assert!((door - (8.0 - 0.125)).abs() < 1e-3, "through the door to the classroom's window wall: {door}");
    assert!(hit(vec3(5.0, 2.5, 2.0), Vec3::Z).is_some_and(|toi| toi < 2.0), "the wall over the door stops it");
}

/// Two faces meeting convexly at more than this read as a knife edge (a 2-segment bevel turns a
/// right angle in steps of 30).
const HARD_DEGREES: f32 = 60.0;
/// A hard edge shorter than this is a corner notch where two bevels meet: 2 px from 5 m at 1080p.
const HARD_EDGE_MIN: f32 = 0.02;
/// Where a piece meets its neighbours (axis, value): module joints, floor, ceiling, wall faces.
const SEAMS: [(usize, f32); 6] = [(0, -1.0), (0, 1.0), (1, 0.0), (1, 3.2), (2, 0.125), (2, -0.125)];

/// A GLB's triangles as positions (every primitive, node transforms ignored: kit pieces have none).
fn glb_triangles(bytes: &[u8]) -> Vec<[Vec3; 3]> {
    let word = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().expect("four bytes")) as usize;
    let json_len = word(12);
    let gltf: genex::Value = std::str::from_utf8(&bytes[20..20 + json_len]).expect("utf-8").parse().expect("glTF JSON");
    let bin = &bytes[20 + json_len + 8..];
    let read = |accessor: usize| -> Vec<u32> {
        let a = &gltf["accessors"][accessor];
        let view = &gltf["bufferViews"][a["bufferView"].as_u64().expect("a view") as usize];
        let start = view["byteOffset"].as_u64().unwrap_or(0) as usize + a["byteOffset"].as_u64().unwrap_or(0) as usize;
        let width = match a["type"].as_str() {
            Some("VEC3") => 3,
            _ => 1,
        };
        let count = a["count"].as_u64().expect("a count") as usize * width;
        match a["componentType"].as_u64() {
            Some(5123) => (0..count).map(|k| u32::from(u16::from_le_bytes([bin[start + 2 * k], bin[start + 2 * k + 1]]))).collect(),
            _ => (0..count).map(|k| u32::from_le_bytes(bin[start + 4 * k..start + 4 * k + 4].try_into().expect("four bytes"))).collect(),
        }
    };
    let mut out = Vec::new();
    for mesh in gltf["meshes"].as_array().into_iter().flatten() {
        for primitive in mesh["primitives"].as_array().into_iter().flatten() {
            let floats = read(primitive["attributes"]["POSITION"].as_u64().expect("positions") as usize);
            let at = |i: u32| Vec3::from_slice(&floats[i as usize * 3..i as usize * 3 + 3].iter().map(|b| f32::from_bits(*b)).collect::<Vec<_>>());
            for t in read(primitive["indices"].as_u64().expect("indices") as usize).chunks(3) {
                out.push([at(t[0]), at(t[1]), at(t[2])]);
            }
        }
    }
    out
}

/// The convex edges sharper than `HARD_DEGREES` and longer than `HARD_EDGE_MIN`, off the seams.
fn hard_edges(triangles: &[[Vec3; 3]], seams: &[(usize, f32)]) -> Vec<(Vec3, Vec3)> {
    let key = |p: Vec3| (p * 1.0e5).round().as_ivec3().to_array();
    let mut by_edge: std::collections::BTreeMap<([i32; 3], [i32; 3]), Vec<usize>> = std::collections::BTreeMap::new();
    for (face, t) in triangles.iter().enumerate() {
        for (a, b) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
            let (ka, kb) = (key(a), key(b));
            by_edge.entry((ka.min(kb), ka.max(kb))).or_default().push(face);
        }
    }
    let normal = |t: &[Vec3; 3]| (t[1] - t[0]).cross(t[2] - t[0]).normalize_or_zero();
    let mut out = Vec::new();
    for ((ka, kb), faces) in by_edge {
        let [f0, f1] = faces[..] else { continue };
        let (n0, n1) = (normal(&triangles[f0]), normal(&triangles[f1]));
        let far = (triangles[f1][0] + triangles[f1][1] + triangles[f1][2]) / 3.0 - triangles[f0][0];
        let (a, b) = (Vec3::from_array(ka.map(|v| v as f32 * 1.0e-5)), Vec3::from_array(kb.map(|v| v as f32 * 1.0e-5)));
        let convex = n0 != Vec3::ZERO && n1 != Vec3::ZERO && far.dot(n0) <= 1.0e-6;
        let on_seam = seams.iter().any(|(axis, value)| (a[*axis] - value).abs() < 1.0e-4 && (b[*axis] - value).abs() < 1.0e-4);
        let sharp = genex::math::acos(n0.dot(n1).clamp(-1.0, 1.0)).to_degrees() > HARD_DEGREES;
        if convex && sharp && !on_seam && a.distance(b) > HARD_EDGE_MIN {
            out.push((a, b));
        }
    }
    out
}

#[test]
fn no_kit_piece_shows_a_knife_edge() {
    let folder = Path::new(KIT).join("kit");
    let mut pieces = 0;
    for entry in std::fs::read_dir(&folder).expect("the kit") {
        let path = entry.expect("an entry").path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_owned();
        // Glass is a pane, not a solid: its 4 mm edges are the pane's.
        if !name.ends_with(".glb") || name.starts_with("window-glass") {
            continue;
        }
        let mut seams = SEAMS.to_vec();
        if name == "wall-corner.glb" {
            seams.extend([(0, 0.0), (2, 0.0)]);
        }
        let hard = hard_edges(&glb_triangles(&std::fs::read(&path).expect("a GLB")), &seams);
        assert!(hard.is_empty(), "{name}: {} hard edges, the first {:?}", hard.len(), hard.first());
        pieces += 1;
    }
    assert!(pieces >= 38, "every solid piece checked: {pieces}");
}

#[test]
fn the_flickering_tube_drops_out_and_comes_back() {
    let mut runtime = started();
    let mut lights = std::collections::BTreeSet::new();
    for _ in 0..200 {
        runtime.step(FIXED_STEP_MS);
        lights.insert(runtime.frame(View::Game).expect("a frame").lights().spots.len());
    }
    assert_eq!(lights.len(), 2, "one fitting goes dark and lights again over 200 ticks: {lights:?}");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_corridor_and_classroom_capture_at_low_and_high() {
    let Some(mut presenter) = support::presenter(WORLD_SIZE, assets()) else { return };
    let mut runtime = started();
    assert!(presenter.install_for(&mut runtime).is_empty());
    for (view, name) in [(View::Named("corridor"), "interior-kit-corridor"), (View::Named("classroom"), "interior-kit-classroom")] {
        for preset in [QualityPreset::Low, QualityPreset::High] {
            let luma = support::shoot(&mut presenter, &mut runtime, view, preset, name);
            eprintln!("{name} {}: mean luma {luma:.1}", preset.wire());
            assert!((20.0..235.0).contains(&luma), "{name} at {} is neither black nor blown out: {luma}", preset.wire());
        }
    }
    let state = runtime.state();
    assert!(state["__render"].get("missingModels").is_none(), "every kit GLB loads: {:?}", state["__render"]);
    // The scans and the heroes' textures arrive here as raw JPEGs, which Studio's import compresses;
    // nothing else may complain.
    let issues = state["__render"]["assetIssues"].as_array().cloned().unwrap_or_default();
    let refused: Vec<_> = issues.iter().filter(|issue| issue["code"] != "texture-uncompressed").collect();
    assert!(refused.is_empty(), "every sheet and decal loads: {refused:?}");
    let bound = state["__render"]["textures"].as_object().cloned().unwrap_or_default();
    let scans = ["cc0/0f2152c5-2349-0ec7-e27b-29a825486708/preconcrete_wall_001_diff_2k.jpg", "cc0/f282de59-61cb-5c95-7311-db397ff43586/dirty_tiles_diff_2k.jpg"];
    for sheet in ["kit/trim_color.jpg", "kit/props_color.jpg", "kit/decals/peel_edge.png", "kit/decals/chalk.png", "kit/decals/poster_space.png"].into_iter().chain(scans) {
        assert!(bound.contains_key(sheet), "{sheet} is bound: {:?}", bound.keys().collect::<Vec<_>>());
    }
}
