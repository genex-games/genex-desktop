//! NAV-8: off-mesh links and area filters.
//!
//! - A ladder between two floors: the path climbs it; the agent says `ReachedAnimationLink`
//!   (`at-link`), then `UsingAnimationLink` (`on-link`) after `take_link`, then `Moving` after
//!   `finish_link`.
//! - A door shut mid-walk: on the next update every agent whose corridor crossed it has searched
//!   again (a detour) or says `NoPath`. A cost change alone (upstream's only lever) leaves the old
//!   corridors in place, which is the bug P14 fixes.
//! - A link whose end tile streams out drops off and comes back with the same id.
//! - A link end far from every mesh is refused `nav-link-invalid`, and nothing is added.

use std::sync::Arc;

use genex_nav::error::NavErrorCode;
use genex_nav::filter::NavFilter;
use genex_nav::input::NavArea;
use genex_nav::links::{NavLink, NavLinkKind, add_link, finish_link, take_link};
use genex_nav::runtime::agent::{Agent, AgentId, AgentState};
use genex_nav::runtime::archipelago::{Archipelago, ArchipelagoOptions};
use genex_nav::runtime::coords::{FromAgentRadius, GenexCoords, PointSampleDistance3d};
use genex_nav::runtime::island::{Island, IslandId};
use genex_nav::runtime::nav_mesh::NavigationMesh;
use genex_nav::runtime::query::{FindPathError, PathStep};
use genex_nav::runtime::util::Transform;
use glam::Vec3;

const DT: f32 = 1.0 / 60.0;
const RADIUS: f32 = 0.25;
const DOOR: usize = NavArea::DOOR.raw() as usize;

/// A `cols` × `rows` grid of 1 m squares from (`x0`, `y`, `z0`) toward +x and −z (genex Y-up,
/// counter-clockwise from above); `kind(i, j)` is a cell's type index, or `None` for a hole.
fn grid(x0: f32, y: f32, z0: f32, cols: usize, rows: usize, kind: impl Fn(usize, usize) -> Option<usize>) -> Island<GenexCoords> {
    let mut vertices = Vec::new();
    for j in 0..=rows {
        for i in 0..=cols {
            vertices.push(Vec3::new(x0 + i as f32, y, z0 - j as f32));
        }
    }
    let at = |i: usize, j: usize| j * (cols + 1) + i;
    let (mut polygons, mut polygon_type_indices) = (Vec::new(), Vec::new());
    for j in 0..rows {
        for i in 0..cols {
            if let Some(type_index) = kind(i, j) {
                polygons.push(vec![at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)]);
                polygon_type_indices.push(type_index);
            }
        }
    }
    let mesh = NavigationMesh::<GenexCoords> { vertices, polygons, polygon_type_indices, height_mesh: None };
    Island::new(Transform::default(), Arc::new(mesh.validate().expect("a valid grid")))
}

fn archipelago() -> Archipelago<GenexCoords> {
    Archipelago::new(ArchipelagoOptions::from_agent_radius(RADIUS))
}

fn agent_to(archipelago: &mut Archipelago<GenexCoords>, from: Vec3, to: Vec3) -> AgentId {
    let mut agent = Agent::create(from, Vec3::ZERO, RADIUS, 1.4, 2.0);
    agent.current_target = Some(to);
    archipelago.add_agent(agent)
}

/// One tick: update, then move every agent that is not crossing a link by its desired velocity.
fn tick(archipelago: &mut Archipelago<GenexCoords>) {
    archipelago.update(DT);
    let ids: Vec<AgentId> = archipelago.get_agent_ids().collect();
    for id in ids {
        let agent = archipelago.get_agent_mut(id).expect("a live agent");
        if agent.is_using_animation_link() {
            continue;
        }
        let velocity = *agent.get_desired_velocity();
        agent.velocity = velocity;
        agent.position += velocity * DT;
    }
}

fn state(archipelago: &Archipelago<GenexCoords>, agent: AgentId) -> AgentState {
    archipelago.get_agent(agent).expect("a live agent").state()
}

/// The lower floor (y 0, 6 × 6 m) and the upper floor (y 3, 6 × 6 m, 2 m further along −z), and a
/// ladder from the lower floor's far side up to the upper floor's near side.
fn two_floors() -> (Archipelago<GenexCoords>, IslandId, IslandId, NavLink) {
    let mut archipelago = archipelago();
    let lower = archipelago.add_island(grid(0.0, 0.0, 0.0, 6, 6, |_, _| Some(0)));
    let upper = archipelago.add_island(grid(0.0, 3.0, -8.0, 6, 6, |_, _| Some(0)));
    let ladder = NavLink::between(Vec3::new(3.0, 0.0, -5.5), Vec3::new(3.0, 3.0, -8.5), NavLinkKind::Ladder);
    (archipelago, lower, upper, ladder)
}

#[test]
fn a_ladder_is_reached_taken_and_finished() {
    let (mut archipelago, _, _, ladder) = two_floors();
    let link = add_link(&mut archipelago, &ladder).expect("the ladder attaches");
    let agent = agent_to(&mut archipelago, Vec3::new(3.0, 0.0, -1.0), Vec3::new(3.0, 3.0, -12.0));

    let mut states = Vec::new();
    for _ in 0..600 {
        tick(&mut archipelago);
        states.push(state(&archipelago, agent));
        if state(&archipelago, agent) == AgentState::ReachedAnimationLink {
            break;
        }
    }
    assert_eq!(state(&archipelago, agent), AgentState::ReachedAnimationLink, "the agent walked to the ladder ({states:?})");
    assert!(states[..states.len() - 1].iter().all(|state| *state == AgentState::Moving));

    let reached = take_link(&mut archipelago, agent).expect("the agent stands at the ladder");
    assert_eq!(reached.link_id, link);
    assert!((reached.end_point - Vec3::new(3.0, 3.0, -8.5)).length() < 1e-4, "lands at the top ({:?})", reached.end_point);
    tick(&mut archipelago);
    assert_eq!(state(&archipelago, agent), AgentState::UsingAnimationLink);
    assert_eq!(*archipelago.get_agent(agent).expect("live").get_desired_velocity(), Vec3::ZERO);
    assert!(take_link(&mut archipelago, agent).is_none(), "a crossing agent has no link to take");

    // The game plays the climb and puts the body at the top.
    archipelago.get_agent_mut(agent).expect("live").position = reached.end_point;
    assert!(finish_link(&mut archipelago, agent));
    assert!(!finish_link(&mut archipelago, agent), "finishing twice changes nothing");
    tick(&mut archipelago);
    assert_eq!(state(&archipelago, agent), AgentState::Moving);
    assert!(archipelago.get_pathing_results().is_empty(), "the old path still leads on from the top");
    for _ in 0..600 {
        tick(&mut archipelago);
    }
    assert_eq!(state(&archipelago, agent), AgentState::ReachedTarget);
}

#[test]
fn a_query_takes_the_ladder_unless_the_filter_forbids_it() {
    let (mut archipelago, _, _, ladder) = two_floors();
    let link = add_link(&mut archipelago, &ladder).expect("the ladder attaches");
    archipelago.update(DT);
    let distance = PointSampleDistance3d::from_agent_radius(RADIUS);
    let start = archipelago.sample_point(Vec3::new(3.0, 0.0, -1.0), &distance).expect("on the lower floor");
    let end = archipelago.sample_point(Vec3::new(3.0, 3.0, -12.0), &distance).expect("on the upper floor");
    let found = archipelago.find_path(&start, &end, &NavFilter::new()).expect("a path up the ladder");
    assert!(!found.partial);
    let links: Vec<_> = found.steps.iter().filter_map(|step| if let PathStep::AnimationLink { link_id, .. } = step { Some(*link_id) } else { None }).collect();
    assert_eq!(links, [link]);
    let no_ladders = NavFilter::new().with_links(&[NavLinkKind::Jump, NavLinkKind::Door]);
    assert_eq!(archipelago.find_path(&start, &end, &no_ladders).err(), Some(FindPathError::NoPathFound));
}

/// A 9 × 7 room split by a wall at row 3 with a door at column 1 and a gap at column 8 (the long
/// way round). Agents walk from the bottom left to the top left.
fn room_with_door(gap: bool) -> Archipelago<GenexCoords> {
    let mut archipelago = archipelago();
    archipelago.add_island(grid(0.0, 0.0, 0.0, 9, 7, |i, j| match (i, j) {
        (1, 3) => Some(DOOR),
        (8, 3) if gap => Some(0),
        (_, 3) => None,
        _ => Some(0),
    }));
    archipelago
}

/// The door's polygon: rows 0-2 hold 27 cells, and the door is row 3's first cell (column 0 is a
/// hole).
const DOOR_POLYGON: usize = 27;

fn crosses_door(archipelago: &Archipelago<GenexCoords>, agent: AgentId) -> bool {
    let Some(path) = archipelago.get_agent(agent).expect("live").path() else {
        return false;
    };
    path.nodes().any(|node| node.polygon_index == DOOR_POLYGON)
}

#[test]
fn shutting_a_door_mid_walk_repaths_every_agent_through_it_on_the_next_update() {
    let mut archipelago = room_with_door(true);
    let walkers: Vec<AgentId> = (0..4).map(|k| agent_to(&mut archipelago, Vec3::new(0.5 + k as f32 * 0.6, 0.0, -6.5), Vec3::new(1.5, 0.0, -0.5))).collect();
    let bystander = agent_to(&mut archipelago, Vec3::new(5.5, 0.0, -5.5), Vec3::new(6.5, 0.0, -6.5));
    for _ in 0..30 {
        tick(&mut archipelago);
    }
    assert!(walkers.iter().all(|&agent| crosses_door(&archipelago, agent)), "the short way is through the door");

    assert!(archipelago.gates_mut().set_area_open(DOOR, false));
    tick(&mut archipelago);
    let searched: Vec<AgentId> = archipelago.get_pathing_results().iter().map(|result| result.agent).collect();
    assert_eq!(searched, walkers, "exactly the agents whose corridor crossed the door searched again");
    for &agent in &walkers {
        assert!(!crosses_door(&archipelago, agent), "no corridor still crosses the shut door");
        assert_eq!(state(&archipelago, agent), AgentState::Moving, "a detour through the gap");
    }
    assert_ne!(state(&archipelago, bystander), AgentState::NoPath);

    // Opening the door again breaks nothing: the detours stand until a repath.
    assert!(archipelago.gates_mut().set_area_open(DOOR, true));
    tick(&mut archipelago);
    assert!(archipelago.get_pathing_results().is_empty());
}

#[test]
fn shutting_the_only_door_leaves_no_path() {
    let mut archipelago = room_with_door(false);
    let walker = agent_to(&mut archipelago, Vec3::new(0.5, 0.0, -6.5), Vec3::new(1.5, 0.0, -0.5));
    for _ in 0..30 {
        tick(&mut archipelago);
    }
    assert!(crosses_door(&archipelago, walker));
    archipelago.gates_mut().set_area_open(DOOR, false);
    tick(&mut archipelago);
    assert_eq!(state(&archipelago, walker), AgentState::NoPath);
    assert!(!archipelago.get_agent(walker).expect("live").has_path());
}

#[test]
fn a_cost_change_alone_keeps_the_old_corridor_which_is_why_gates_exist() {
    // Upstream's only lever: an infinite type cost. The agent keeps walking its corridor through
    // the "shut" door, because nothing invalidates a path when a cost changes.
    let mut archipelago = room_with_door(true);
    let walker = agent_to(&mut archipelago, Vec3::new(0.5, 0.0, -6.5), Vec3::new(1.5, 0.0, -0.5));
    for _ in 0..30 {
        tick(&mut archipelago);
    }
    archipelago.set_type_index_cost(DOOR, f32::INFINITY).expect("an infinite cost");
    tick(&mut archipelago);
    assert!(archipelago.get_pathing_results().is_empty());
    assert!(crosses_door(&archipelago, walker), "the old corridor still crosses the door");
}

#[test]
fn closing_a_link_repaths_agents_that_would_take_it() {
    let (mut archipelago, _, _, ladder) = two_floors();
    let link = add_link(&mut archipelago, &ladder).expect("the ladder attaches");
    let agent = agent_to(&mut archipelago, Vec3::new(3.0, 0.0, -1.0), Vec3::new(3.0, 3.0, -12.0));
    tick(&mut archipelago);
    assert_eq!(state(&archipelago, agent), AgentState::Moving);
    assert!(archipelago.gates_mut().set_link_open(link, false));
    tick(&mut archipelago);
    assert_eq!(archipelago.get_pathing_results().len(), 1);
    assert_eq!(state(&archipelago, agent), AgentState::NoPath, "the ladder was the only way up");
}

#[test]
fn a_link_detaches_when_its_end_tile_streams_out_and_returns_with_the_same_id() {
    let (mut archipelago, _, upper, ladder) = two_floors();
    let link = add_link(&mut archipelago, &ladder).expect("the ladder attaches");
    archipelago.update(DT);
    assert!(archipelago.is_animation_link_attached(link));

    assert!(archipelago.remove_island(upper));
    archipelago.update(DT);
    assert!(!archipelago.is_animation_link_attached(link), "no landing, no link");
    assert_eq!(archipelago.get_animation_link_ids().collect::<Vec<_>>(), [link], "the link itself stays");

    let upper_again = archipelago.add_island(grid(0.0, 3.0, -8.0, 6, 6, |_, _| Some(0)));
    assert_ne!(upper_again, upper, "a re-added tile is a new island");
    archipelago.update(DT);
    assert!(archipelago.is_animation_link_attached(link), "the same link id attaches again");
    let agent = agent_to(&mut archipelago, Vec3::new(3.0, 0.0, -1.0), Vec3::new(3.0, 3.0, -12.0));
    tick(&mut archipelago);
    assert_eq!(state(&archipelago, agent), AgentState::Moving, "a path climbs the returned ladder");
}

#[test]
fn a_link_end_far_from_every_mesh_is_refused_and_nothing_is_added() {
    let (mut archipelago, _, _, _) = two_floors();
    let refusals = [
        // 1 m above the upper floor: past animation_link_max_vertical_distance (0.125 m).
        NavLink::between(Vec3::new(3.0, 0.0, -5.5), Vec3::new(3.0, 4.0, -8.5), NavLinkKind::Jump),
        // Beside every floor.
        NavLink::between(Vec3::new(30.0, 0.0, -5.5), Vec3::new(3.0, 3.0, -8.5), NavLinkKind::Drop),
        NavLink::edges([Vec3::new(1.0, 0.0, -5.5), Vec3::new(f32::NAN, 0.0, -5.5)], [Vec3::new(1.0, 3.0, -8.5); 2], NavLinkKind::Teleport),
        NavLink::between(Vec3::new(3.0, 0.0, -5.5), Vec3::new(3.0, 3.0, -8.5), NavLinkKind::Ladder).with_cost(-1.0),
        NavLink::between(Vec3::new(3.0, 0.0, -5.5), Vec3::new(3.0, 3.0, -8.5), NavLinkKind::Ladder).with_cost(f32::INFINITY),
    ];
    for link in &refusals {
        let refusal = add_link(&mut archipelago, link).expect_err("refused");
        assert_eq!(refusal.code, NavErrorCode::LinkInvalid, "{link:?}");
        assert_eq!(refusal.code.wire(), "nav-link-invalid");
    }
    assert_eq!(archipelago.get_animation_link_ids().count(), 0, "nothing was added");
}

#[test]
fn link_kinds_have_stable_codes_and_wire_spellings() {
    for kind in NavLinkKind::BUILT_IN.into_iter().chain([NavLinkKind::Custom(0), NavLinkKind::Custom(255)]) {
        assert_eq!(NavLinkKind::from_code(kind.code()), Some(kind));
    }
    let wires: Vec<&str> = NavLinkKind::BUILT_IN.iter().map(|kind| kind.wire()).collect();
    assert_eq!(wires, ["jump", "drop", "ladder", "door", "teleport"]);
    assert_eq!(NavLinkKind::Custom(3).wire(), "custom");
    assert_eq!(NavLinkKind::from_code(16 + 256), None);
}
