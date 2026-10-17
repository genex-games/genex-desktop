//! Lakeside v2 for Tier A (renderer pass 2, plan section 6): the scene's new shots (a wide golden
//! hour, a shore close-up, the forest floor and the cabin's interior) are named cameras after
//! pass 1's five, and the cabin is a room: an open door, a plank floor, a hearth and a table lamp,
//! lit inside by a reflection probe (A.3) and an irradiance volume (A.4) over the room.
//!
//! Metal rows (`--ignored metal`), one at a time:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p showcase \
//!     --release --offline --locked --test lakeside_v2 -- --ignored metal --test-threads=1

mod support;

use genex::math::{Vec3, vec3};
use genex::present::Presenter;
use genex::render::{PresetChoice, RenderChange};
use genex::{FIXED_STEP_MS, Input, Key, Runtime, View};
use genex_render::capture::Capture;
use genex_render::settings::QualityPreset;
use showcase_game::world::World;
use showcase_game::{assets, game};
use support::{SHOT_TICK, gpu};

/// Pass 1's five shots, kept for continuity, then Lakeside v2's.
const PASS1_SHOTS: [&str; 5] = ["wide", "dock", "cabin", "forest", "closeup"];
const V2_SHOTS: [&str; 4] = ["golden-wide", "shore", "forest-floor", "cabin-interior"];
/// The cabin's room in the world: its centre at chest height and the floor's height.
const ROOM_CENTRE: Vec3 = vec3(-9.0, 2.9, -21.0);
const FLOOR: f32 = 1.7;
/// The size the Metal rows capture at.
const SIZE: (u32, u32) = (960, 540);

fn runtime() -> Runtime<World> {
    let _ = assets();
    let mut runtime = Runtime::new(game()).expect("the showcase's registrations are valid");
    runtime.seed(1);
    runtime.start();
    runtime
}

#[test]
fn the_v2_shots_are_named_cameras_after_pass_one_s_five() {
    let runtime = runtime();
    let expected: Vec<String> = PASS1_SHOTS.iter().chain(V2_SHOTS.iter()).map(|name| (*name).to_owned()).collect();
    assert_eq!(runtime.cameras(), expected);
}

#[test]
fn the_cabin_interior_shot_stands_inside_the_room_at_eye_height() {
    let mut runtime = runtime();
    runtime.step(60.0 * FIXED_STEP_MS);
    let camera = runtime.camera(View::Named("cabin-interior")).expect("the interior shot");
    let local = genex::math::Quat::from_rotation_y(-showcase_game::layout::CABIN_YAW) * (camera.position - ROOM_CENTRE);
    assert!(local.x.abs() < 2.9 && local.z.abs() < 2.4, "inside the walls: {:?} (cabin frame {local:?})", camera.position);
    let eye_height = camera.position.y - FLOOR;
    assert!((1.3..=1.8).contains(&eye_height), "eye height {eye_height}");
}

#[test]
fn the_cabin_s_room_has_a_probe_a_volume_and_lamplight_inside() {
    let mut runtime = runtime();
    runtime.step(60.0 * FIXED_STEP_MS);
    let frame = runtime.frame(View::Game).expect("a frame");
    let lights = frame.lights();
    let holds = |min: Vec3, max: Vec3| ROOM_CENTRE.cmpge(min).all() && ROOM_CENTRE.cmple(max).all() && min.y >= FLOOR - 0.5 && max.y <= FLOOR + 4.6;
    let probe = lights.reflection_probes.first().expect("a reflection probe (A.3)");
    assert!(holds(probe.min, probe.max), "the probe's box holds the room: {probe:?}");
    assert!(probe.capture.cmpge(probe.min).all() && probe.capture.cmple(probe.max).all(), "captured inside its box");
    let volume = lights.irradiance_volumes.first().expect("an irradiance volume (A.4)");
    assert!(holds(volume.min, volume.max), "the volume's box holds the room: {volume:?}");
    let inside = lights.points.iter().filter(|light| (light.position - ROOM_CENTRE).length() < 3.2).count();
    assert!(inside >= 2, "the hearth and the table lamp: {inside} point lights in the room");
}

/// The draws of `frame` under `tag` that are boxes: their transforms.
fn cubes_tagged(frame: &genex::Frame, tag: &str) -> Vec<genex::Transform> {
    frame
        .draws()
        .iter()
        .filter(|draw| draw.tag == tag)
        .filter_map(|draw| match &draw.shape {
            genex::Shape::Cube { transform, .. } => Some(*transform),
            _ => None,
        })
        .collect()
}

/// Whether the world point `p` lies inside the unit box `transform` places.
fn inside(transform: &genex::Transform, p: Vec3) -> bool {
    let local = transform.rotation.inverse() * (p - transform.translation) / transform.scale;
    local.abs().cmple(Vec3::splat(0.5)).all()
}

/// The round logs leave a lens-shaped gap between courses; a cabin fills it with chinking, so the
/// room's walls read as walls, not as stripes of the yard (GA look review of the first interior
/// capture: dark diamonds down the walls). Every wall's mid-plane is chinked between the corners,
/// except the doorway, which stays open to the yard.
#[test]
fn the_room_s_log_walls_are_chinked_except_the_doorway() {
    use showcase_game::draw::{CABIN_DEPTH, CABIN_WIDTH, DOOR_HALF_WIDTH, DOOR_HEIGHT};
    use showcase_game::layout::{CABIN, CABIN_FLOOR, CABIN_YAW};
    let mut runtime = runtime();
    runtime.step(60.0 * FIXED_STEP_MS);
    let frame = runtime.frame(View::Game).expect("a frame");
    let chinking = cubes_tagged(&frame, "chinking");
    // The cabin's frame (`draw::cabin_frame`): its floor at the yard, its front (+z) yawed.
    let to_world = |p: Vec3| vec3(CABIN.x, CABIN_FLOOR, CABIN.y) + genex::math::Quat::from_rotation_y(CABIN_YAW) * p;
    let (hw, hd) = (CABIN_WIDTH * 0.5, CABIN_DEPTH * 0.5);
    let chinked = |p: Vec3| chinking.iter().any(|box_| inside(box_, to_world(p)));
    // Points on each wall's mid-plane between two courses, at chest height and under the eaves.
    for y in [1.0_f32, 2.4] {
        for p in [vec3(-1.8, y, hd), vec3(1.8, y, hd), vec3(0.0, y, -hd), vec3(-2.4, y, -hd), vec3(-hw + 0.1, y, 0.8), vec3(hw - 0.1, y, -1.2)] {
            assert!(chinked(p), "the wall at {p:?} (cabin frame) is chinked");
        }
    }
    for p in [vec3(0.0, 0.3, hd), vec3(0.0, 1.0, hd), vec3(DOOR_HALF_WIDTH - 0.1, DOOR_HEIGHT - 0.2, hd)] {
        assert!(!chinked(p), "the doorway at {p:?} stays open");
    }
}

/// Lakeside v2's scatter (A.8's `Terrain::scatter`, drawn as retained instance groups, D4):
/// pebbles on the beach and stones along the path and the yard, placed by the terrain's own
/// layers, each sitting on the ground, the same every frame.
#[test]
fn the_beach_and_the_path_are_scattered_with_stones_on_their_layers() {
    use showcase_game::layout::{height, splat_weights};
    let mut runtime = runtime();
    runtime.step(60.0 * FIXED_STEP_MS);
    let frame = runtime.frame(View::Game).expect("a frame");
    let stones: Vec<genex::Transform> = frame
        .draws()
        .iter()
        .filter(|draw| draw.tag == "stones")
        .flat_map(|draw| match &draw.shape {
            genex::Shape::Group { group, .. } => group.transforms().to_vec(),
            _ => Vec::new(),
        })
        .collect();
    assert!((150..=700).contains(&stones.len()), "{} stones", stones.len());
    // The scatter reads the control map's blended pairs, so a stone may sit where the beach or
    // the path fades into the meadow; most lie well inside them and none on bare meadow or rock.
    let mut inside = 0;
    for stone in &stones {
        let p = stone.translation;
        let [soil, sand, ..] = splat_weights(p.x, p.z);
        assert!(soil + sand > 0.01, "a stone at {p:?} lies on the beach or the path (soil {soil}, sand {sand})");
        inside += usize::from(soil + sand > 0.25);
        assert!((p.y - height(p.x, p.z)).abs() < 0.25, "a stone at {p:?} sits on the ground ({})", height(p.x, p.z));
        assert!(stone.scale.max_element() <= 0.35, "a stone, not a boulder: {:?}", stone.scale);
    }
    assert!(inside * 100 >= stones.len() * 85, "{inside} of {} stones well inside the beach or the path", stones.len());
    let again = runtime.frame(View::Game).expect("a frame");
    assert_eq!(again.tags().get("stones"), frame.tags().get("stones"), "the same stones every frame");
}

/// The shore shot stands on the beach at the waterline, not over the lake: the lake fills less of
/// the frame than the bank (GA look review of the first capture: three fifths flat water).
#[test]
fn the_shore_shot_stands_on_the_beach() {
    use showcase_game::layout::{WATER_LEVEL, height};
    let runtime = runtime();
    let camera = runtime.camera(View::Named("shore")).expect("the shore shot");
    let ground = height(camera.position.x, camera.position.z);
    assert!(ground > WATER_LEVEL + 0.05, "on dry ground: {ground} at {:?}", camera.position);
    assert!((0.3..=1.8).contains(&(camera.position.y - ground)), "a crouch to eye height: {}", camera.position.y - ground);
}

/// The lakeside at tick [`SHOT_TICK`] with its HUD hidden (H), captured settled at `preset` and
/// [`SIZE`] from the named shot `shot`, the way the Studio captures it.
fn settled(shot: &str, preset: QualityPreset) -> Option<Capture> {
    let mut presenter = Presenter::open(showcase_game::showcase::WORLD_SIZE, assets()).ok()?;
    let mut runtime = Runtime::new(game()).expect("installs");
    runtime.seed(1);
    runtime.start();
    runtime.inject(Input::key_tap(Key::KeyH));
    runtime.step(f64::from(SHOT_TICK) * FIXED_STEP_MS);
    assert!(presenter.install_for(&mut runtime).is_empty(), "every pass installs");
    presenter.set_capturing(true);
    presenter.set_capture_size(Some(SIZE));
    presenter.draw_view(&mut runtime, View::Named(shot)).expect("a view").expect("drawn");
    let change = RenderChange { preset: Some(Some(PresetChoice::Preset(preset))), ..RenderChange::default() };
    presenter.render_settings().expect("the game's settings attached").borrow_mut().apply(&change);
    presenter.draw_view(&mut runtime, View::Named(shot)).expect("a view").expect("drawn");
    assert!(presenter.take_pass_refusals().is_empty(), "{shot}: every pass draws");
    Some(presenter.resilient.capture().expect("capture"))
}

/// Rec. 709 luma of every pixel (display-encoded, 0..255).
fn lumas(capture: &Capture) -> Vec<f64> {
    capture.bgra().chunks(4).map(|p| 0.0722 * f64::from(p[0]) + 0.7152 * f64::from(p[1]) + 0.2126 * f64::from(p[2])).collect()
}

/// The interior shot is a lit room, not a dark box: its mean luma is a lamplit room's, a share of
/// it is lit warm (the hearth, the lamp and the sun through the door) and the room is not blown
/// out by auto exposure metering the dark.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_cabin_interior_is_a_lit_room() {
    if gpu().is_none() {
        return;
    }
    for preset in [QualityPreset::High, QualityPreset::Medium] {
        let capture = settled("cabin-interior", preset).expect("a presenter");
        if let Some(dir) = std::env::var_os("GENEX_LAKESIDE_V2_OUT").map(std::path::PathBuf::from) {
            std::fs::create_dir_all(&dir).expect("the out folder");
            support::write_png(&dir.join(format!("cabin-interior-{}.png", preset.wire())), &capture);
        }
        let luma = lumas(&capture);
        let mean = luma.iter().sum::<f64>() / luma.len() as f64;
        let warm = capture.bgra().chunks(4).filter(|p| p[2] > 150 && p[2] > p[0].saturating_add(40)).count() as f64 / luma.len() as f64;
        let blown = luma.iter().filter(|l| **l > 250.0).count() as f64 / luma.len() as f64;
        eprintln!("cabin-interior {}: mean luma {mean:.1}, warm {:.2}%, blown {:.2}%", preset.wire(), warm * 100.0, blown * 100.0);
        assert!((45.0..=150.0).contains(&mean), "{}: mean luma {mean:.1}", preset.wire());
        assert!(warm > 0.03, "{}: warm-lit share {:.2}%", preset.wire(), warm * 100.0);
        assert!(blown < 0.06, "{}: blown share {:.2}%", preset.wire(), blown * 100.0);
    }
}
