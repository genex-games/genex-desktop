//! The asset-import fixtures drawn by the presenter (GF round 2, visual): the C-8 tangent sphere and
//! the LOD sphere face out (lit from the camera's side their middle is brighter than lit from behind
//! them, and lit from above their upper part is brighter than lit from below), and the tangent
//! sphere's normal map decodes and is bound. Before the round-2 fix both spheres
//! were wound inward (drawn inside out) and the normal map's PNG failed its CRC, so the runtime
//! refused it.
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex \
//!     --test imported_fixtures -- --ignored metal
//!
//! `GENEX_ASSET_FIXTURES` points the rows at another folder holding the same files (an older
//! import's output); `GENEX_RENDER_EVIDENCE_DIR` keeps each capture as raw BGRA.

use std::path::PathBuf;

use genex::prelude::*;
use genex::present::Presenter;
use genex::{FIXED_STEP_MS, Model, Runtime, View};

const WORLD: [u32; 2] = [320, 180];
/// The fixture spheres: the import step's tangent output and its LOD output.
const MIRRORED: &str = "tangents-mirrored.imported.glb";
const LODS: &str = "lods-sphere.glb";
/// Towards the sun: from the camera's side, from behind the sphere, from above and from below.
const FRONT_SUN: Vec3 = Vec3::new(0.2, 0.3, 1.0);
const BACK_SUN: Vec3 = Vec3::new(0.2, 0.3, -1.0);
const ABOVE_SUN: Vec3 = Vec3::new(0.2, 1.0, 0.6);
const BELOW_SUN: Vec3 = Vec3::new(0.2, -1.0, 0.6);
/// Half the side of the squares measured, in pixels.
const SQUARE_HALF: usize = 16;
/// How far above the frame's middle the upper square sits (inside the sphere), in pixels.
const UPPER_OFFSET: usize = 50;

#[derive(Default)]
struct World {
    model: Model,
}

/// The repository's `tests/fixtures/asset-import`, or `GENEX_ASSET_FIXTURES`.
fn fixtures() -> PathBuf {
    std::env::var_os("GENEX_ASSET_FIXTURES")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/asset-import"))
}

/// A game drawing `file` at the origin under a sun towards `sun`, seen from +z.
fn runtime(file: &'static str, sun: Vec3) -> Runtime<World> {
    let mut game = Game::new(World::default()).title("Imported fixtures").world_size(WORLD[0], WORLD[1]);
    game.camera(|_| Camera::look_at(vec3(0.0, 0.0, 3.0), Vec3::ZERO));
    game.on_reset(move |sim, _, _, gfx| sim.world.model = gfx.assets().model(file));
    game.on_draw(move |sim, frame, _| {
        frame.sun(sun, Color::WHITE, 3.0);
        frame.model(&sim.world.model, Transform::IDENTITY);
    });
    let mut runtime = Runtime::new(game).expect("valid registrations");
    runtime.seed(1);
    runtime.start();
    runtime.step(FIXED_STEP_MS);
    runtime
}

fn presenter() -> Option<Presenter> {
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    match Presenter::open_with_root(WORLD, &[], Some(fixtures())) {
        Ok(presenter) => Some(presenter),
        Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
        Err(_) => None,
    }
}

/// The settled capture of `runtime` (a few frames, so the uploads land): its mean luminance over
/// the middle square and over the upper one.
fn luminance(presenter: &mut Presenter, runtime: &mut Runtime<World>, name: &str) -> (f64, f64) {
    presenter.set_capturing(true);
    for _ in 0..4 {
        presenter.draw_view(runtime, View::Game).expect("game view").expect("drawn");
    }
    let capture = presenter.resilient.capture().expect("capture");
    if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(std::path::Path::new(&dir).join(format!("{name}-{}x{}.bgra", WORLD[0], WORLD[1])), capture.bgra()).expect("evidence");
    }
    let (width, height) = (WORLD[0] as usize, WORLD[1] as usize);
    let square = |cx: usize, cy: usize| {
        let mut sum = 0.0;
        for y in cy - SQUARE_HALF..cy + SQUARE_HALF {
            for x in cx - SQUARE_HALF..cx + SQUARE_HALF {
                let at = (y * width + x) * 4;
                let [b, g, r] = [capture.bgra()[at], capture.bgra()[at + 1], capture.bgra()[at + 2]].map(f64::from);
                sum += 0.0722 * b + 0.7152 * g + 0.2126 * r;
            }
        }
        sum / (4 * SQUARE_HALF * SQUARE_HALF) as f64
    };
    (square(width / 2, height / 2), square(width / 2, height / 2 - UPPER_OFFSET))
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_fixture_spheres_face_out_and_the_tangent_spheres_normal_map_is_bound() {
    let mut problems = Vec::new();
    for file in [MIRRORED, LODS] {
        let Some(mut presenter) = presenter() else { return };
        let mut front = runtime(file, FRONT_SUN);
        let (lit, _) = luminance(&mut presenter, &mut front, &format!("{file}-front-sun"));
        let textures = front.state()["__render"]["textures"].clone();
        let (unlit, _) = luminance(&mut presenter, &mut runtime(file, BACK_SUN), &format!("{file}-back-sun"));
        let (_, top_lit) = luminance(&mut presenter, &mut runtime(file, ABOVE_SUN), &format!("{file}-above-sun"));
        let (_, top_unlit) = luminance(&mut presenter, &mut runtime(file, BELOW_SUN), &format!("{file}-below-sun"));
        eprintln!("{file}: middle {lit:.1} lit from the camera's side, {unlit:.1} from behind; top {top_lit:.1} lit from above, {top_unlit:.1} from below; textures {textures}");
        if lit <= unlit {
            problems.push(format!("{file} draws inside out: its middle is {lit:.1} lit from the camera's side against {unlit:.1} from behind"));
        }
        if top_lit <= top_unlit {
            problems.push(format!("{file} draws inside out: its top is {top_lit:.1} lit from above against {top_unlit:.1} from below"));
        }
        if let Some(failure) = presenter.failure() {
            problems.push(format!("{file}: {failure}"));
        }
        if file == MIRRORED && textures.get(format!("{MIRRORED}#0")).is_none() {
            problems.push(format!("{MIRRORED}'s normal map is not bound: {textures}"));
        }
    }
    assert!(problems.is_empty(), "{problems:#?}");
}
