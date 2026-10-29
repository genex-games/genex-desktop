//! The blockout (`src/game-template-rust/docs/examples/blockout`) as a game gets it: the whole
//! level from its plan, walkable from the spawn to every zone and the exit, a tag and a hero camera
//! per zone and a top-down `map:top` camera; and a plan whose door, exit or fence is missing, or a
//! door off its wall, shows in its `state().__level` report instead of in a walkthrough. On the
//! host GPU it writes the map and the player's view:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- \
//!     cargo test -p template-examples --release --offline --locked --test blockout -- --ignored metal --nocapture

#[path = "../../../../../src/game-template-rust/docs/examples/blockout/src/game.rs"]
mod game;
#[path = "../../../../../src/game-template-rust/docs/examples/blockout/src/plan.rs"]
mod plan;
mod support;

use genex::prelude::{Value, json, vec2};
use genex::render::QualityPreset;
use genex::{FIXED_STEP_MS, Game, Runtime, View};

use game::World;
use plan::{Boundary, Exit, Link, PLAN, Plan};

const WORLD_SIZE: [u32; 2] = [1280, 720];

fn started(plan: &'static Plan) -> Runtime<World> {
    let mut game = Game::new(World).title("Blockout").world_size(WORLD_SIZE[0], WORLD_SIZE[1]);
    game::wire(&mut game, plan);
    let mut runtime = Runtime::with_assets(game, Box::new(support::assets(&[]))).expect("the example installs");
    runtime.seed(1);
    runtime.start();
    runtime.step(FIXED_STEP_MS * 5.0);
    runtime
}

fn level(plan: &'static Plan) -> Value {
    started(plan).state()["__level"].clone()
}

/// `PLAN` with its links replaced.
fn with_links(links: Vec<Link>) -> &'static Plan {
    Box::leak(Box::new(Plan { links: links.leak(), ..PLAN }))
}

fn without_link(from: &str, to: &str) -> &'static Plan {
    with_links(PLAN.links.iter().filter(|link| !(link.from == from && link.to == to)).copied().collect())
}

/// The zones the report says the spawn cannot walk to.
fn unreachable(level: &Value) -> Vec<String> {
    let zones = level["zones"].as_object().expect("zones by id");
    PLAN.zones.iter().map(|zone| zone.id).filter(|id| zones[*id]["reachable"] == false).map(str::to_owned).collect()
}

#[test]
fn the_plan_is_walkable_from_the_spawn_with_a_tag_and_a_hero_camera_per_zone() {
    let mut runtime = started(&PLAN);
    let level = runtime.state()["__level"].clone();
    assert_eq!(level["version"], 1);
    assert_eq!(unreachable(&level), Vec::<String>::new(), "every zone is reached: {level:#}");
    assert_eq!(level["exits"], json!(["back-yard"]), "and the exit");
    assert_eq!(level["spawn"], "front-yard");
    assert_eq!(level["deadEnds"], json!([]), "the office is a dead end the plan means");
    assert_eq!(level["zones"]["hall"]["exits"], 4, "the hall's four ways on");
    assert_eq!(level["bounded"], true, "fences, walls and the gate hold the player in");
    let cameras = runtime.cameras();
    assert!(cameras.iter().any(|name| name == "map:top"), "a top-down map camera: {cameras:?}");
    let frame = runtime.frame(View::Game).expect("a frame");
    for zone in PLAN.zones {
        assert!(cameras.contains(&format!("hero:{}", zone.id)), "a hero camera for {}", zone.id);
        let tag = format!("zone:{}", zone.id);
        assert!(frame.draws().iter().any(|draw| draw.tag == tag), "{tag} is drawn under its tag");
    }
}

#[test]
fn a_missing_door_exit_or_fence_or_a_door_off_its_wall_shows_in_the_level_report() {
    let office = PLAN.links.iter().position(|link| link.to == "office").expect("the office door");
    let mut off_wall = PLAN.links.to_vec();
    off_wall[office].at = vec2(9.0, 4.5);
    let far_exit = Box::leak(Box::new(Plan { exits: Box::leak(Box::new([Exit { at: vec2(0.0, -30.0), ..PLAN.exits[0] }])), ..PLAN }));
    let east_fence = |edge: &&Boundary| !(edge.zone == "front-yard" && edge.from.x == 12.0);
    let open_side = Box::leak(Box::new(Plan { boundary: PLAN.boundary.iter().filter(east_fence).copied().collect::<Vec<_>>().leak(), ..PLAN }));
    // (case, plan, unreachable zones, exit zones, unplanned dead ends, bounded)
    let cases: [(&str, &'static Plan, Vec<&str>, Value, Value, bool); 6] = [
        ("no back door", without_link("hall", "back-yard"), vec!["back-yard"], json!([]), json!([]), true),
        ("no front door", without_link("front-yard", "lobby"), vec!["lobby", "workshop", "office", "hall", "back-yard"], json!([]), json!([]), true),
        ("an exit off the floor, its gate a hole", far_exit, vec![], json!([]), json!([]), false),
        ("a door off its wall line", with_links(off_wall), vec!["office"], json!(["back-yard"]), json!([]), true),
        ("no lobby door to the workshop", without_link("lobby", "workshop"), vec![], json!(["back-yard"]), json!([{ "zone": "workshop", "at": [-9.0, 0.0, 7.0] }]), true),
        ("no fence on the front yard's east side", open_side, vec![], json!(["back-yard"]), json!([]), false),
    ];
    for (name, plan, gone, exits, dead_ends, bounded) in cases {
        let level = level(plan);
        assert_eq!(unreachable(&level), gone, "{name}: {level:#}");
        assert_eq!(level["exits"], exits, "{name}: the exits");
        assert_eq!(level["deadEnds"], dead_ends, "{name}: the dead ends");
        assert_eq!(level["bounded"], bounded, "{name}: the boundary");
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_map_camera_shows_the_whole_level_and_the_player_view_reads() {
    let Some(mut presenter) = support::presenter(WORLD_SIZE, support::assets(&[])) else { return };
    let mut runtime = started(&PLAN);
    assert!(presenter.install_for(&mut runtime).is_empty());
    for (name, view) in [("blockout-map", View::Named("map:top")), ("blockout-player", View::Game)] {
        let luma = support::shoot(&mut presenter, &mut runtime, view, QualityPreset::Ultra, name);
        eprintln!("{name} ultra {luma:.1}");
        assert!((40.0..=200.0).contains(&luma), "{name} reads: {luma:.1}");
    }
}
