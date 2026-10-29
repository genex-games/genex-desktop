//! `genex::level`: the reachability check over a nav, as the harness reads it (`state().__level`).
//!
//! - every planned zone is reached from spawn along the nav, exits and dead ends are reported;
//! - a zone cut off from spawn, a missing exit and an open edge each show in the report;
//! - the report is the JSON shape the harness reads (version 1).

use genex::level::{Level, MIN_WALL_HEIGHT};
use genex::nav::{Nav, NavArea, NavConfig, NavInput, NavMesh};
use genex::prelude::*;
use serde_json::json;

fn walker() -> NavConfig {
    NavConfig::walker(0.4, 1.8).with_tile(16.0)
}

/// A floor rectangle `x0..x1` by `z0..z1`.
fn floor(input: NavInput, x0: f32, z0: f32, x1: f32, z1: f32) -> NavInput {
    let corners = [vec3(x0, 0.0, z0), vec3(x1, 0.0, z0), vec3(x1, 0.0, z1), vec3(x0, 0.0, z1)];
    input.with_triangles(&corners, &[0, 2, 1, 0, 3, 2], NavArea::WALK).expect("a floor")
}

fn nav(input: &NavInput) -> Nav {
    let mut nav = Nav::new(&walker());
    nav.add_mesh(&NavMesh::bake(input, &walker()).expect("a mesh")).expect("tiles");
    nav.update(1.0 / 60.0);
    nav
}

/// hall (0..8) - door strip - office (10..18), and a yard (30..38) with no way in.
fn three_rooms(joined_yard: bool) -> Nav {
    let mut input = NavInput::new();
    input = floor(input, 0.0, 0.0, 8.0, 8.0);
    input = floor(input, 8.0, 3.0, 10.0, 5.0);
    input = floor(input, 10.0, 0.0, 18.0, 8.0);
    input = floor(input, 30.0, 0.0, 38.0, 8.0);
    if joined_yard {
        input = floor(input, 18.0, 3.0, 30.0, 5.0);
    }
    nav(&input)
}

fn plan() -> Level {
    Level::new().zone("hall", vec3(4.0, 0.0, 4.0)).zone("office", vec3(14.0, 0.0, 4.0)).zone("yard", vec3(34.0, 0.0, 4.0)).spawn("hall")
}

fn walled(_edge: Vec3, _outward: Vec3) -> f32 {
    MIN_WALL_HEIGHT + 1.0
}

#[test]
fn a_zone_joined_by_floor_is_reachable_and_a_cut_off_one_is_not() {
    let level = plan().link("hall", "office").link("office", "yard").exit("yard", "gate");
    let joined = level.check(&three_rooms(true), &walled);
    assert!(joined.zones.iter().all(|zone| zone.reachable), "{:?}", joined.zones);
    let cut = level.check(&three_rooms(false), &walled);
    let reachable: Vec<(&str, bool)> = cut.zones.iter().map(|zone| (zone.id.as_str(), zone.reachable)).collect();
    assert_eq!(reachable, [("hall", true), ("office", true), ("yard", false)]);
}

#[test]
fn exits_are_counted_per_zone_and_listed_when_reachable() {
    let level = plan().link("hall", "office").link("office", "yard").exit("office", "door").exit("yard", "gate");
    let report = level.check(&three_rooms(true), &walled);
    assert_eq!(report.exits, ["office", "yard"]);
    assert_eq!(report.zones.iter().map(|zone| zone.exits).collect::<Vec<_>>(), [0, 1, 1]);
    let cut = level.check(&three_rooms(false), &walled);
    assert_eq!(cut.exits, ["office"], "an exit nobody can reach is not listed");
    assert!(plan().check(&three_rooms(true), &walled).exits.is_empty(), "no exit planned, none reported");
}

#[test]
fn a_zone_with_one_way_in_and_no_exit_is_a_dead_end() {
    let level = plan().link("hall", "office").link("office", "yard").exit("yard", "gate");
    let report = level.check(&three_rooms(true), &walled);
    assert!(report.dead_ends.is_empty(), "spawn, a corridor zone and the exit are not dead ends: {:?}", report.dead_ends);
    let trap = plan().link("hall", "office").link("hall", "yard").exit("yard", "gate").check(&three_rooms(true), &walled);
    let ids: Vec<&str> = trap.dead_ends.iter().map(|end| end.zone.as_str()).collect();
    assert_eq!(ids, ["office"]);
    assert_eq!(trap.dead_ends[0].at, [14.0, 0.0, 4.0]);
}

#[test]
fn an_open_edge_makes_the_level_unbounded_and_a_low_wall_does_too() {
    let level = plan().link("hall", "office").link("office", "yard").exit("yard", "gate");
    let nav = three_rooms(true);
    assert!(level.check(&nav, &walled).bounded);
    assert!(!level.check(&nav, &|_, _| 0.0).bounded, "nothing beyond the edge");
    assert!(!level.check(&nav, &|_, _| 1.0).bounded, "a 1 m wall is not a boundary");
}

#[test]
fn the_report_is_the_json_the_harness_reads() {
    let level = plan().link("hall", "office").link("office", "yard").exit("yard", "gate");
    let report = level.check(&three_rooms(false), &walled).to_json();
    assert_eq!(report["version"], 1);
    assert_eq!(report["spawn"], "hall");
    assert_eq!(report["zones"]["hall"], json!({ "reachable": true, "exits": 0 }));
    assert_eq!(report["zones"]["yard"], json!({ "reachable": false, "exits": 1 }));
    assert_eq!(report["exits"], json!([]));
    assert_eq!(report["deadEnds"], json!([]));
    assert_eq!(report["bounded"], true);
}

#[test]
fn a_spawn_off_the_nav_reaches_nothing() {
    let level = Level::new().zone("hall", vec3(400.0, 0.0, 400.0)).spawn("hall");
    let report = level.check(&three_rooms(true), &walled);
    assert!(!report.zones[0].reachable, "a zone centre off the mesh is not walkable");
}
