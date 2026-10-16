//! Harbour Street's decals (renderer pass 2 A.10): posters on its walls, grime, puddles and oil on
//! its asphalt are projected decals, within a desktop's cap, their textures the scene's own assets,
//! and its puddles no longer boxes over the asphalt (no depth to fight). The GPU row draws the
//! puddle and street shots the way the Studio captures them, as evidence and to hold that they are
//! drawn the same twice.
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p showcase --release \
//!     --offline --locked --test harbour_decals -- --include-ignored metal --nocapture

mod support;

use genex::{FIXED_STEP_MS, Runtime, Shape, View};
use showcase_game::harbour::{SHOTS, World};
use showcase_game::{harbour_assets, harbour_game};

fn runtime() -> Runtime<World> {
    let mut runtime = Runtime::new(harbour_game()).expect("installs");
    runtime.seed(1);
    runtime.start();
    runtime.step(60.0 * FIXED_STEP_MS);
    runtime
}

#[test]
fn every_shot_declares_its_decals_within_a_desktops_cap_with_textures_the_scene_ships() {
    let mut runtime = runtime();
    let assets: Vec<&str> = harbour_assets().iter().map(|(name, _)| *name).collect();
    for shot in SHOTS {
        let frame = runtime.frame(View::Named(shot.name)).expect("its frame");
        let decals = frame.decals();
        assert!(decals.len() >= 30, "{}: posters, grime, puddles and oil: {}", shot.name, decals.len());
        assert!(decals.len() as u32 <= genex_render::decals::DESKTOP_DECALS, "{}: {} decals over the desktop cap", shot.name, decals.len());
        for decal in decals {
            let texture = decal.base_texture().expect("every street decal is shaped by its texture");
            assert!(assets.contains(&texture), "{texture} is one of the scene's assets");
        }
    }
}

#[test]
fn the_puddles_are_decals_not_boxes_over_the_asphalt() {
    // The blockout's puddles were three overlapping turned boxes a centimetre tall each, their tops
    // coplanar: a depth fight where they overlapped. They are decals now: no thin box lies on the
    // asphalt outside the road paint (4 mm).
    let mut runtime = runtime();
    let frame = runtime.frame(View::Named("puddle")).expect("the puddle shot");
    let films = frame
        .draws()
        .iter()
        .filter(|draw| draw.tag == "street")
        .filter_map(|draw| match &draw.shape {
            Shape::Cube { transform, .. } => Some(*transform),
            _ => None,
        })
        .filter(|transform| transform.translation.y.abs() < 1e-4 && transform.scale.y <= 0.011)
        .count();
    assert_eq!(films, 0, "no film box lies on the asphalt");
    let puddles = frame.decals().iter().filter(|decal| decal.base_texture() == Some("decals/puddle.png")).count();
    assert_eq!(puddles, 7);
}

#[test]
#[ignore = "real GPU: run with --include-ignored metal"]
fn metal_the_puddle_and_street_shots_draw_their_decals_the_same_twice() {
    // No z-fight and no swim: a settled capture of a shot is the same twice (a depth fight's
    // pixels change with the draw order), written as evidence (`harbour-<shot>-decals.png`).
    use genex::present::Presenter;
    let Some(_gpu) = support::gpu() else { return };
    let shot = |name: &str| {
        let mut presenter = Presenter::open(showcase_game::harbour::WORLD_SIZE, harbour_assets()).ok()?;
        let mut runtime = runtime();
        runtime.step(540.0 * FIXED_STEP_MS);
        let refused = presenter.install_for(&mut runtime);
        assert!(refused.is_empty(), "{refused:?}");
        presenter.set_capturing(true);
        presenter.draw_view(&mut runtime, View::Named(name)).expect("a view").expect("drawn");
        presenter.resilient.capture().ok()
    };
    for name in ["puddle", "street-wide"] {
        let (Some(first), Some(again)) = (shot(name), shot(name)) else {
            eprintln!("skipped: no presenter");
            return;
        };
        support::write_png(&support::out_dir().join(format!("harbour-{name}-decals.png")), &first);
        assert_eq!(first.digest(), again.digest(), "{name}: two settled captures differ");
    }
}
