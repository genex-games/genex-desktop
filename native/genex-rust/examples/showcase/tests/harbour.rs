//! Harbour Street's rules headless (no GPU), renderer pass 2 A.13's blockout: its five fixed shots
//! are named cameras in the plan's order, it replays from a seed, it is built from the renderer's
//! existing features only (no custom pass, no Level-2 material, no post pass), the street shots
//! stand in the open and the café shots inside the café, a walk from the pavement through the
//! café's door meets no wall, the street is lit by more than 200 binned local lights within the
//! renderer's light table, the `where` probe follows the camera through the door, every fetched texture and sky map it asks for is a row of its fetch
//! manifest (and every row is used), and its look is keyed low for dusk with no +EV patch (owner
//! decision D2). The A.13 detail pass: the furniture, the kerbs and the drains are scanned wood,
//! marble, metal, granite and grate, and the crossing and the street carry their road markings.

use genex::math::Vec3;
use genex::render::{Environment, ExposureMode, Tonemap};
use genex::{FIXED_STEP_MS, Frame, Input, Key, Material, Runtime, Shape, Transform, View, json};
use showcase_game::harbour::{SHOT_HOLD_TICKS, SHOTS, World};
use showcase_game::street::{CAFE_DOOR, CAFE_INSIDE, DOOR_WALK, outdoors};
use showcase_game::{HARBOUR_GAME_DIR, harbour_assets, harbour_game};

/// The shots the plan names for the blockout, in order (section 6; the night street waits for the
/// day and night toggle, B.2).
const PLANNED_SHOTS: [&str; 5] = ["street-wide", "puddle", "neon-alley", "cafe", "window-shafts"];
/// The plan's exterior: 200+ binned local lights.
const STREET_LIGHTS_MIN: usize = 200;
/// The scans the A.13 detail pass dresses the blockout's furniture, kerbs and drains in.
const DETAIL_SCANS: [&str; 5] = ["wood", "marble", "metal", "granite", "grate"];
/// The road markings at least: two zebra crossings of six stripes, their stop lines and the centre
/// line's dashes.
const MARKINGS_MIN: usize = 24;
/// How far a road marking or a drain's top stands proud of the asphalt (metres), at most: paint
/// and a grate lie on the road, they are not kerbs.
const ON_THE_ROAD: f32 = 0.01;

fn runtime() -> Runtime<World> {
    let _ = harbour_assets();
    Runtime::new(harbour_game()).expect("Harbour Street's registrations are valid")
}

fn run(runtime: &mut Runtime<World>, ticks: u32) {
    runtime.seed(1);
    runtime.start();
    runtime.step(f64::from(ticks) * FIXED_STEP_MS);
}

/// Whether the unit cube under `transform` holds `point` (its scale may be negative-free only).
fn cube_holds(transform: &Transform, point: Vec3) -> bool {
    let local = transform.rotation.inverse() * (point - transform.translation);
    let half = transform.scale.abs() * 0.5;
    local.x.abs() <= half.x && local.y.abs() <= half.y && local.z.abs() <= half.z
}

/// The opaque boxes of `frame` (glass, drawn blended, is left out: it is see-through).
fn solid_cubes(frame: &Frame) -> Vec<Transform> {
    let opaque = |material: &Material| material.base_color.a == u8::MAX;
    frame
        .draws()
        .iter()
        .filter_map(|draw| match &draw.shape {
            Shape::Cube { transform, material, .. } if opaque(material) => Some(*transform),
            _ => None,
        })
        .collect()
}

/// Every texture path a draw of `frame` names.
fn textures(frame: &Frame) -> Vec<String> {
    let mut paths = Vec::new();
    for draw in frame.draws() {
        let material = match &draw.shape {
            Shape::Cube { material, .. } | Shape::Sphere { material, .. } => material,
            Shape::Model { material: Some(material), .. } => material,
            _ => continue,
        };
        let named = [material.base_texture(), material.normal_texture(), material.metal_rough_texture(), material.emissive_texture()];
        paths.extend(named.into_iter().flatten().map(str::to_owned));
    }
    paths.sort();
    paths.dedup();
    paths
}

/// The cubes of `frame` drawn under `tag`.
fn tagged_cubes(frame: &Frame, tag: &str) -> Vec<Transform> {
    frame
        .draws()
        .iter()
        .filter(|draw| draw.tag == tag)
        .filter_map(|draw| match &draw.shape {
            Shape::Cube { transform, .. } => Some(*transform),
            _ => None,
        })
        .collect()
}

#[test]
fn the_five_fixed_shots_are_named_cameras_in_the_plans_order_and_draw_the_street() {
    let mut runtime = runtime();
    run(&mut runtime, 60);
    assert_eq!(runtime.cameras(), PLANNED_SHOTS.map(str::to_owned).to_vec());
    for shot in SHOTS {
        let camera = runtime.camera(View::Named(shot.name)).expect("the shot");
        assert_eq!((camera.position, camera.target, camera.fovy), (shot.eye, shot.target, shot.fovy), "{}", shot.name);
        let frame = runtime.frame(View::Named(shot.name)).expect("its frame");
        assert!(frame.draw_calls() > 400, "{}: {} draws", shot.name, frame.draw_calls());
    }
}

#[test]
fn ten_seconds_replay_to_the_same_checksum_and_probes() {
    let (mut a, mut b) = (runtime(), runtime());
    for r in [&mut a, &mut b] {
        run(r, 300);
        r.inject(Input::key_tap(Key::KeyF));
        r.step(300.0 * FIXED_STEP_MS);
    }
    assert_eq!(a.checksum(), b.checksum());
    assert_eq!(a.probes(), b.probes());
    assert_eq!(a.probes()["view"]["mode"], json!("free"));
}

#[test]
fn the_blockout_draws_with_the_renderers_existing_features_only() {
    let mut runtime = runtime();
    run(&mut runtime, 10);
    assert!(runtime.gpu_passes().is_empty(), "no custom pass: {:?}", runtime.gpu_passes());
    let manifest = std::fs::read_to_string(format!("{HARBOUR_GAME_DIR}/genex.toml")).expect("the game folder's manifest");
    assert!(!manifest.contains("[[wgsl]]"), "the game folder declares no WGSL source");
    for shot in SHOTS {
        let frame = runtime.frame(View::Named(shot.name)).expect("its frame");
        assert!(frame.custom_draws().is_empty(), "{}: no Level-2 material", shot.name);
        assert!(frame.post_passes().is_empty(), "{}: no post pass", shot.name);
    }
}

#[test]
fn the_street_shots_stand_in_the_open_and_the_cafe_shots_inside_the_cafe() {
    let mut runtime = runtime();
    run(&mut runtime, 10);
    let frame = runtime.frame(View::Game).expect("a frame");
    let cubes = solid_cubes(&frame);
    for shot in SHOTS {
        let inside = matches!(shot.name, "cafe" | "window-shafts");
        assert_eq!(CAFE_INSIDE.contains(shot.eye), inside, "{}: in the café", shot.name);
        assert_eq!(outdoors(shot.eye), !inside, "{}: in the street", shot.name);
        assert!(cubes.iter().all(|cube| !cube_holds(cube, shot.eye)), "{}: the eye is inside a box", shot.name);
    }
}

#[test]
fn a_walk_from_the_pavement_through_the_cafe_door_meets_no_wall() {
    let mut runtime = runtime();
    run(&mut runtime, 10);
    let frame = runtime.frame(View::Game).expect("a frame");
    let cubes = solid_cubes(&frame);
    let [from, to] = DOOR_WALK;
    assert!(outdoors(from) && CAFE_INSIDE.contains(to), "the walk starts on the pavement and ends in the café");
    let steps = 200;
    let mut through_door = false;
    for i in 0..=steps {
        let at = from.lerp(to, i as f32 / steps as f32);
        through_door |= CAFE_DOOR.contains(at);
        let blocked: Vec<&Transform> = cubes.iter().filter(|cube| cube_holds(cube, at)).collect();
        assert!(blocked.is_empty(), "{at:?} is inside {blocked:?}");
    }
    assert!(through_door, "the walk passes through the doorway");
}

#[test]
fn the_where_probe_follows_the_camera_from_the_street_through_the_door_into_the_cafe() {
    let mut runtime = runtime();
    run(&mut runtime, 10);
    let place = |runtime: &Runtime<World>| runtime.probes()["where"].clone();
    assert_eq!(place(&runtime), json!({ "outdoors": true, "inDoorway": false, "inCafe": false }), "the tour opens in the street");
    runtime.inject(Input::key_tap(Key::Digit4));
    runtime.step(2.0 * FIXED_STEP_MS);
    assert_eq!(place(&runtime), json!({ "outdoors": false, "inDoorway": false, "inCafe": true }), "the café shot");
    let walk = runtime.probes()["scene"]["doorWalk"].clone();
    let [from, to] = DOOR_WALK.map(|p| json!([p.x, p.y, p.z]));
    assert_eq!(walk, json!({ "from": from, "to": to }), "the door transition's path is published for the motion rows");
}

#[test]
fn the_street_is_lit_by_over_200_local_lights_within_the_light_table() {
    use genex_render::layout::{MAX_LIGHTS, MAX_SHADOWED_SPOTS};
    let mut runtime = runtime();
    run(&mut runtime, 10);
    let frame = runtime.frame(View::Named("street-wide")).expect("its frame");
    let lights = frame.lights();
    let local = lights.points.len() + lights.spots.len();
    assert!(local > STREET_LIGHTS_MIN, "{local} local lights");
    assert!(lights.points.len() <= MAX_LIGHTS, "{} point lights: the table lights only the first {MAX_LIGHTS}", lights.points.len());
    let shadowed = lights.spots.iter().filter(|spot| spot.shadow).count();
    assert!((1..=MAX_SHADOWED_SPOTS).contains(&shadowed), "{shadowed} spots ask for a shadow map");
    assert!(lights.sun.is_some_and(|sun| sun.intensity > 0.0), "the low sun shines down the side street");
}

#[test]
fn every_fetched_file_the_scene_asks_for_is_a_manifest_row_and_every_row_is_used() {
    let text = std::fs::read_to_string(format!("{HARBOUR_GAME_DIR}/assets-manifest.json")).expect("the fetch manifest");
    let manifest: genex::Value = text.parse().expect("JSON");
    let mut offered = Vec::new();
    for asset in manifest["assets"].as_array().expect("assets") {
        assert_eq!(asset["licence"], json!("CC0-1.0"), "{}: CC0 only (D6)", asset["id"]);
        let output = asset["output"].as_str().expect("an output name");
        for file in asset["files"].as_array().expect("files") {
            let name = match file["map"].as_str().expect("a map") {
                "diff" => format!("fetched/{output}-albedo.jpg"),
                "nor_gl" => format!("fetched/{output}-normal.jpg"),
                "arm" => format!("fetched/{output}-orm.jpg"),
                "hdr" => format!("fetched/{output}.hdr"),
                other => panic!("{output}: an unknown map {other}"),
            };
            offered.push(name);
        }
    }
    let mut runtime = runtime();
    run(&mut runtime, 10);
    let mut asked = Vec::new();
    for shot in SHOTS {
        asked.extend(textures(&runtime.frame(View::Named(shot.name)).expect("its frame")));
    }
    runtime.inject(Input::key_tap(Key::KeyB));
    runtime.step(2.0 * FIXED_STEP_MS);
    match runtime.frame(View::Game).expect("a frame").declared_environment() {
        Some(Environment::Hdri(map)) => asked.push(map.path.clone()),
        other => panic!("B switches to the fetched dusk map: {other:?}"),
    }
    asked.sort();
    asked.dedup();
    for path in &asked {
        assert!(offered.contains(path), "{path} is asked for but no manifest row fetches it");
    }
    for path in &offered {
        assert!(asked.contains(path), "{path} is fetched but the scene never asks for it");
    }
}

/// G0 look (2026-10-15) flipped "no compensation at all" to "keyed low, never a + patch": decision
/// D2 removed the +EV patches that made up for pass 1's darker punchy curve; dusk is keyed under
/// middle grey (at middle grey every shot read as daylight).
#[test]
fn the_look_is_agx_punchy_with_auto_exposure_keyed_low_for_dusk_and_no_exposure_patch() {
    let runtime = runtime();
    let look = runtime.render().borrow().look();
    assert_eq!((look.tonemapper, look.exposure), (Tonemap::AgxPunchy, ExposureMode::Auto));
    assert!(look.ev_compensation < 0.0, "dusk is keyed under middle grey, never a +EV patch (decision D2): {}", look.ev_compensation);
    assert!(look.fog.is_on(), "the damp air after the rain");
}

#[test]
fn the_tour_holds_each_shot_and_cuts_to_the_next_and_a_digit_holds_one() {
    let mut runtime = runtime();
    run(&mut runtime, 10);
    assert_eq!(runtime.camera(View::Game).expect("camera").position, SHOTS[0].eye, "the tour opens on the first shot");
    runtime.step((SHOT_HOLD_TICKS - 11) as f64 * FIXED_STEP_MS);
    assert!(!runtime.frame(View::Game).expect("a frame").is_camera_cut(), "the shot holds");
    runtime.step(FIXED_STEP_MS);
    assert_eq!(runtime.camera(View::Game).expect("camera").position, SHOTS[1].eye, "then the second");
    assert!(runtime.frame(View::Game).expect("a frame").is_camera_cut(), "a cut, so TAA and exposure start over");
    runtime.inject(Input::key_tap(Key::Digit4));
    runtime.step(2.0 * FIXED_STEP_MS);
    assert_eq!(runtime.probes()["view"]["mode"], json!("cafe"));
    runtime.step(f64::from(u32::try_from(SHOT_HOLD_TICKS).expect("small")) * FIXED_STEP_MS);
    assert_eq!(runtime.camera(View::Game).expect("camera").position, SHOTS[3].eye, "a held shot stays");
}

// A.13 detail pass (renderer pass 2): the blockout drew its furniture, kerbs, lamp posts and frames
// in flat colours and its streets bare of paint.
#[test]
fn the_furniture_kerbs_and_drains_are_scanned_wood_marble_metal_granite_and_grate() {
    let mut runtime = runtime();
    run(&mut runtime, 10);
    let mut asked = Vec::new();
    for shot in SHOTS {
        asked.extend(textures(&runtime.frame(View::Named(shot.name)).expect("its frame")));
    }
    for scan in DETAIL_SCANS {
        for map in ["albedo", "normal", "orm"] {
            let path = format!("fetched/{scan}-{map}.jpg");
            assert!(asked.contains(&path), "{path}: the detail pass dresses the blockout in it");
        }
    }
}

#[test]
fn the_crossing_and_the_street_carry_road_markings_and_drains_lying_on_the_asphalt() {
    let mut runtime = runtime();
    run(&mut runtime, 10);
    let frame = runtime.frame(View::Game).expect("a frame");
    let markings = tagged_cubes(&frame, "markings");
    assert!(markings.len() >= MARKINGS_MIN, "{} road markings", markings.len());
    let drains = tagged_cubes(&frame, "drains");
    assert!(!drains.is_empty(), "drains along the kerbs");
    for cube in markings.iter().chain(&drains) {
        let top = cube.translation.y + cube.scale.y * 0.5;
        assert!((0.0..=ON_THE_ROAD).contains(&top), "{cube:?}: its top {top} lies on the asphalt");
        assert!(outdoors(cube.translation + Vec3::Y * 0.5), "{cube:?}: in the street");
    }
}
