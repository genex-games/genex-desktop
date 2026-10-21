//! Build-time nav bakes (game systems NAV-14): `game.nav_bake(name, |gfx| NavInput)` registers a
//! bake that the dev flavour's `bakeAssets {kind: nav, name}` runs (`Runtime::bake_nav`), with the
//! game's `game.navigation` config, reading assets as a reset does. Its bytes, loaded with
//! `NavMesh::from_bytes_for`, are the mesh `NavMesh::bake` makes of the same input at reset; a
//! changed input rebakes; an unknown name answers none; install refuses a name that is not a bake
//! name or is registered twice.
//!
//! New behaviour (section 0 of the game systems plan).

use genex::nav::{NavArea, NavConfig, NavInput, NavMesh, NavMeshSource};
use genex::Gfx;
use genex::prelude::*;
use genex::{AssetTable, InstallErrorCode, Runtime};

/// A level file a bake reads its floor's width from, as a reset reads it.
const TABLE: AssetTable = &[("levels/market.json", br#"{"width": 24}"#)];

#[derive(Default)]
struct World {
    /// The digest of the mesh the reset baked.
    reset_digest: u64,
}

fn walker() -> NavConfig {
    NavConfig::walker(0.4, 1.8).with_tile(8.0)
}

/// A floor `width` metres wide and 12 deep.
fn floor(width: f32) -> NavInput {
    let vertices = [vec3(0.0, 0.0, 0.0), vec3(width, 0.0, 0.0), vec3(width, 0.0, 12.0), vec3(0.0, 0.0, 12.0)];
    NavInput::new().with_triangles(&vertices, &[0, 2, 1, 0, 3, 2], NavArea::WALK).expect("the floor")
}

/// A market: its floor baked at reset (as a game without an offline bake does) and registered as
/// the bake `market`.
fn market() -> Game<World> {
    let mut game = Game::new(World::default()).title("Market");
    game.navigation(walker());
    game.nav_bake("market", |_gfx| floor(20.0));
    game.on_reset(|sim, _seed, _rng, _gfx| {
        sim.world.reset_digest = NavMesh::bake(&floor(20.0), &walker()).expect("the reset bake").digest();
    });
    game
}

#[test]
fn a_nav_bake_loaded_with_from_bytes_for_has_the_digest_of_the_reset_bake() {
    let mut rt = Runtime::new(market()).expect("the market installs");
    rt.seed(1);
    let bytes = rt.bake_nav("market").expect("a registered bake").expect("baked");
    let loaded = NavMesh::from_bytes_for(&floor(20.0), &walker(), &bytes).expect("the bytes load");
    assert_eq!(loaded.source(), NavMeshSource::Bytes, "the bytes were baked from this input");
    assert_eq!(loaded.digest(), rt.sim().world.reset_digest);
    assert_eq!(rt.bake_nav("market").expect("again").expect("baked"), bytes, "a bake is a pure function of its input");
    assert_eq!(rt.nav_bakes(), ["market"]);
}

#[test]
fn a_changed_input_rebakes() {
    let mut rt = Runtime::new(market()).expect("the market installs");
    rt.seed(1);
    let bytes = rt.bake_nav("market").expect("a registered bake").expect("baked");
    let wider = floor(28.0);
    let loaded = NavMesh::from_bytes_for(&wider, &walker(), &bytes).expect("a stale bake still loads");
    assert_eq!(loaded.source(), NavMeshSource::Rebaked, "the input digest differs");
    assert_eq!(loaded.digest(), NavMesh::bake(&wider, &walker()).expect("the wider floor").digest());
    let other_config = NavConfig::walker(0.5, 1.8).with_tile(8.0);
    let reconfigured = NavMesh::from_bytes_for(&floor(20.0), &other_config, &bytes).expect("loads");
    assert_eq!(reconfigured.source(), NavMeshSource::Rebaked, "the config digest differs");
}

#[test]
fn an_unknown_name_answers_none_and_a_game_without_navigation_refuses_its_config() {
    let mut rt = Runtime::new(market()).expect("the market installs");
    rt.seed(1);
    assert!(rt.bake_nav("cellar").is_none());
    assert!(rt.bake_nav("").is_none());
    let mut plain = Game::new(World::default());
    plain.nav_bake("market", |_gfx| floor(20.0));
    let mut rt = Runtime::new(plain).expect("installs");
    rt.seed(1);
    let refused = rt.bake_nav("market").expect("registered").expect_err("no game.navigation");
    assert_eq!(refused.code.wire(), "nav-config-invalid");
    let mut quiet = Runtime::new(Game::new(World::default())).expect("installs");
    assert!(quiet.nav_bakes().is_empty());
    assert!(quiet.bake_nav("market").is_none());
}

#[test]
fn install_refuses_a_bake_name_that_is_not_one_or_is_registered_twice() {
    for name in ["", "Market", "../market", "a/b", "market.navmesh", "-market", &"a".repeat(65)] {
        let mut game = Game::new(World::default());
        game.nav_bake(name, |_gfx| floor(20.0));
        let refused = Runtime::new(game).err().map(|error| error.code());
        assert_eq!(refused, Some(InstallErrorCode::InvalidName), "{name:?}");
    }
    let mut twice = Game::new(World::default());
    twice.nav_bake("market", |_gfx| floor(20.0)).nav_bake("market", |_gfx| floor(28.0));
    assert_eq!(Runtime::new(twice).err().map(|error| error.code()), Some(InstallErrorCode::InvalidName));
}

/// The floor `levels/market.json` names, read through `gfx` (a reset or a bake).
fn level_floor(gfx: &Gfx) -> NavInput {
    let level = gfx.assets().bytes("levels/market.json").expect("the level reads").json().expect("JSON");
    floor(level["width"].as_f64().expect("a width") as f32)
}

#[test]
fn a_bake_reads_its_assets_as_a_reset_does() {
    let mut game = Game::new(World::default());
    game.navigation(walker());
    game.nav_bake("market", level_floor);
    game.on_reset(|sim, _seed, _rng, gfx| {
        sim.world.reset_digest = NavMesh::bake(&level_floor(gfx), &walker()).expect("the reset bake").digest();
    });
    let mut rt = Runtime::with_assets(game, Box::new(TABLE)).expect("installs");
    rt.seed(1);
    let bytes = rt.bake_nav("market").expect("registered").expect("baked");
    let loaded = NavMesh::from_bytes_for(&floor(24.0), &walker(), &bytes).expect("loads");
    assert_eq!(loaded.source(), NavMeshSource::Bytes);
    assert_eq!(loaded.digest(), rt.sim().world.reset_digest);
}
