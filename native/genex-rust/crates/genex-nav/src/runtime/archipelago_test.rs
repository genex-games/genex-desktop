//! landmass 0.9.3's `src/lib_test.rs` (MIT OR Apache-2.0, used under Apache 2.0), converted from
//! googletest to plain asserts: the custom `Path` and `ReachedAnimationLink` matchers are the
//! helpers below. Changed: std maps are `Map`; `find_path` is a shim with upstream's arguments
//! over the port's `NavFilter` query; removing a dead id returns false instead of panicking.

use core::f32::consts::PI;
use core::fmt::Debug;
use std::sync::Arc;

use genex_core::map::Map;
use glam::{Vec2, Vec3};

use super::super::agent::{Agent, AgentId, AgentState, ReachedAnimationLink};
use super::super::character::{Character, CharacterId};
use super::super::coords::{CoordinateSystem, FromAgentRadius, PointSampleDistance3d, XY, XYZ};
use super::super::island::{Island, IslandId};
use super::super::link::{AnimationLink, PermittedAnimationLinks};
use super::super::nav_data::NodeRef;
use super::super::nav_mesh::{NavigationMesh, ValidNavigationMesh};
use super::super::path::Path;
use super::super::query::{FindPathError, PathStep, SampledPoint};
use super::super::util::Transform;
use super::{Archipelago, ArchipelagoOptions};
use crate::filter::NavFilter;

/// Upstream's `Archipelago::find_path` arguments over the port's filter.
fn find_path<'a, CS: CoordinateSystem>(
    archipelago: &'a Archipelago<CS>,
    start_point: &SampledPoint<'a, CS>,
    end_point: &SampledPoint<'a, CS>,
    override_type_index_costs: &Map<usize, f32>,
    permitted_animation_links: PermittedAnimationLinks,
) -> Result<Vec<PathStep<CS>>, FindPathError> {
    let filter = NavFilter::from_parts(override_type_index_costs.clone(), permitted_animation_links);
    archipelago.find_path(start_point, end_point, &filter).map(|found| found.steps)
}

/// A path's first and last node (upstream's `path_start_and_end` matcher).
fn path_ends(path: &Option<Path>) -> Option<(NodeRef, NodeRef)> {
    let path = path.as_ref()?;
    let first = &path.island_segments[0];
    let last = path.island_segments.last()?;
    Some((
        NodeRef { island_id: first.island_id, polygon_index: first.corridor[0] },
        NodeRef { island_id: last.island_id, polygon_index: *last.corridor.last()? },
    ))
}

/// `actual` is `expected` (upstream's `eq_reached_animation_link` matcher).
#[track_caller]
fn assert_reached<CS: CoordinateSystem<Coordinate: PartialEq + Debug>>(actual: Option<&ReachedAnimationLink<CS>>, expected: ReachedAnimationLink<CS>) {
    let actual = actual.expect("a reached animation link");
    assert_eq!(actual.link_id, expected.link_id);
    assert_eq!(actual.start_point, expected.start_point);
    assert_eq!(actual.end_point, expected.end_point);
}

#[test]
fn add_and_remove_agents() {
    let mut archipelago =
        Archipelago::<XYZ>::new(ArchipelagoOptions::from_agent_radius(0.5));

    let agent_1 = archipelago.add_agent(Agent::create(
        /* position= */ Vec3::ZERO,
        /* velocity= */ Vec3::ZERO,
        /* radius= */ 1.0,
        /* desired_speed= */ 0.0,
        /* max_speed= */ 0.0,
    ));

    let agent_2 = archipelago.add_agent(Agent::create(
        /* position= */ Vec3::ZERO,
        /* velocity= */ Vec3::ZERO,
        /* radius= */ 2.0,
        /* desired_speed= */ 0.0,
        /* max_speed= */ 0.0,
    ));

    let agent_3 = archipelago.add_agent(Agent::create(
        /* position= */ Vec3::ZERO,
        /* velocity= */ Vec3::ZERO,
        /* radius= */ 3.0,
        /* desired_speed= */ 0.0,
        /* max_speed= */ 0.0,
    ));

    fn sorted(mut v: Vec<AgentId>) -> Vec<AgentId> {
        v.sort();
        v
    }

    assert_eq!(
        sorted(archipelago.get_agent_ids().collect::<Vec<_>>()),
        sorted(vec![agent_1, agent_2, agent_3]),
    );
    assert_eq!(
        [
            archipelago.get_agent(agent_1).unwrap().radius,
            archipelago.get_agent(agent_2).unwrap().radius,
            archipelago.get_agent(agent_3).unwrap().radius,
        ],
        [1.0, 2.0, 3.0],
    );

    archipelago.remove_agent(agent_2);

    assert_eq!(
        sorted(archipelago.get_agent_ids().collect::<Vec<_>>()),
        sorted(vec![agent_1, agent_3]),
    );
    assert_eq!(
        [
            archipelago.get_agent(agent_1).unwrap().radius,
            archipelago.get_agent(agent_3).unwrap().radius,
        ],
        [1.0, 3.0],
    );

    archipelago.remove_agent(agent_3);

    assert_eq!(
        sorted(archipelago.get_agent_ids().collect::<Vec<_>>()),
        sorted(vec![agent_1]),
    );
    assert_eq!([archipelago.get_agent(agent_1).unwrap().radius], [1.0]);

    archipelago.remove_agent(agent_1);

    assert_eq!(archipelago.get_agent_ids().collect::<Vec<_>>(), []);
}

#[test]
fn add_and_remove_characters() {
    let mut archipelago =
        Archipelago::<XYZ>::new(ArchipelagoOptions::from_agent_radius(0.5));

    let character_1 =
        archipelago.add_character(Character { radius: 1.0, ..Default::default() });

    let character_2 =
        archipelago.add_character(Character { radius: 2.0, ..Default::default() });

    let character_3 =
        archipelago.add_character(Character { radius: 3.0, ..Default::default() });

    fn sorted(mut v: Vec<CharacterId>) -> Vec<CharacterId> {
        v.sort();
        v
    }

    assert_eq!(
        sorted(archipelago.get_character_ids().collect::<Vec<_>>()),
        sorted(vec![character_1, character_2, character_3]),
    );
    assert_eq!(
        [
            archipelago.get_character(character_1).unwrap().radius,
            archipelago.get_character(character_2).unwrap().radius,
            archipelago.get_character(character_3).unwrap().radius,
        ],
        [1.0, 2.0, 3.0],
    );

    archipelago.remove_character(character_2);

    assert_eq!(
        sorted(archipelago.get_character_ids().collect::<Vec<_>>()),
        sorted(vec![character_1, character_3]),
    );
    assert_eq!(
        [
            archipelago.get_character(character_1).unwrap().radius,
            archipelago.get_character(character_3).unwrap().radius,
        ],
        [1.0, 3.0],
    );

    archipelago.remove_character(character_3);

    assert_eq!(
        sorted(archipelago.get_character_ids().collect::<Vec<_>>()),
        sorted(vec![character_1]),
    );
    assert_eq!([archipelago.get_character(character_1).unwrap().radius], [1.0]);

    archipelago.remove_character(character_1);

    assert_eq!(archipelago.get_character_ids().collect::<Vec<_>>(), []);
}

#[test]
fn computes_and_follows_path() {
    let mut archipelago = Archipelago::<XYZ>::new(ArchipelagoOptions {
        point_sample_distance: PointSampleDistance3d {
            horizontal_distance: 0.1,
            distance_above: 0.1,
            distance_below: 0.1,
            vertical_preference_ratio: 1.0,
            animation_link_max_vertical_distance: 1.0,
        },
        ..ArchipelagoOptions::from_agent_radius(0.5)
    });
    let nav_mesh = NavigationMesh {
        vertices: vec![
            Vec3::new(1.0, 1.0, 1.0),
            Vec3::new(2.0, 1.0, 1.0),
            Vec3::new(3.0, 1.0, 1.0),
            Vec3::new(4.0, 1.0, 1.0),
            Vec3::new(4.0, 2.0, 1.0),
            Vec3::new(4.0, 3.0, 1.0),
            Vec3::new(4.0, 4.0, 1.0),
            Vec3::new(3.0, 4.0, 1.0),
            Vec3::new(3.0, 3.0, 1.0),
            Vec3::new(3.0, 2.0, 1.0),
            Vec3::new(2.0, 2.0, 1.0),
            Vec3::new(1.0, 2.0, 1.0),
        ],
        polygons: vec![
            vec![0, 1, 10, 11],
            vec![1, 2, 9, 10],
            vec![2, 3, 4, 9],
            vec![4, 5, 8, 9],
            vec![5, 6, 7, 8],
        ],
        polygon_type_indices: vec![0, 0, 0, 0, 0],
        height_mesh: None,
    }
    .validate()
    .expect("is valid");

    archipelago.add_island(Island::new(
        Transform { translation: Vec3::ZERO, rotation: 0.0 },
        Arc::new(nav_mesh),
    ));

    archipelago.archipelago_options.neighbourhood = 0.0;
    archipelago.archipelago_options.obstacle_avoidance_time_horizon = 0.01;

    let agent_1 = archipelago.add_agent(Agent::create(
        /* position= */ Vec3::new(1.5, 1.5, 1.09),
        /* velocity= */ Vec3::ZERO,
        /* radius= */ 0.5,
        /* desired_speed= */ 2.0,
        /* max_speed= */ 2.0,
    ));
    let agent_2 = archipelago.add_agent(Agent::create(
        /* position= */ Vec3::new(3.5, 3.5, 0.95),
        /* velocity= */ Vec3::ZERO,
        /* radius= */ 0.5,
        /* desired_speed= */ 2.0,
        /* max_speed= */ 2.0,
    ));
    let agent_off_mesh = archipelago.add_agent(Agent::create(
        /* position= */ Vec3::new(1.5, 2.5, 1.0),
        /* velocity= */ Vec3::ZERO,
        /* radius= */ 0.5,
        /* desired_speed= */ 2.0,
        /* max_speed= */ 2.0,
    ));
    let agent_too_high_above_mesh = archipelago.add_agent(Agent::create(
        /* position= */ Vec3::new(1.5, 1.5, 1.11),
        /* velocity= */ Vec3::ZERO,
        /* radius= */ 0.5,
        /* desired_speed= */ 2.0,
        /* max_speed= */ 2.0,
    ));

    archipelago.get_agent_mut(agent_1).unwrap().current_target =
        Some(Vec3::new(3.5, 3.5, 0.95));
    archipelago.get_agent_mut(agent_off_mesh).unwrap().current_target =
        Some(Vec3::new(3.5, 3.5, 0.95));
    archipelago
        .get_agent_mut(agent_too_high_above_mesh)
        .unwrap()
        .current_target = Some(Vec3::new(3.5, 3.5, 0.95));
    archipelago.get_agent_mut(agent_2).unwrap().current_target =
        Some(Vec3::new(1.5, 1.5, 1.09));

    // Nothing has happened yet.
    assert_eq!(archipelago.get_agent(agent_1).unwrap().state(), AgentState::Idle);
    assert_eq!(archipelago.get_agent(agent_2).unwrap().state(), AgentState::Idle);
    assert_eq!(
        archipelago.get_agent(agent_off_mesh).unwrap().state(),
        AgentState::Idle
    );
    assert_eq!(
        archipelago.get_agent(agent_too_high_above_mesh).unwrap().state(),
        AgentState::Idle
    );

    assert_eq!(
        *archipelago.get_agent(agent_1).unwrap().get_desired_velocity(),
        Vec3::ZERO
    );
    assert_eq!(
        *archipelago.get_agent(agent_2).unwrap().get_desired_velocity(),
        Vec3::ZERO
    );
    assert_eq!(
        *archipelago.get_agent(agent_off_mesh).unwrap().get_desired_velocity(),
        Vec3::ZERO
    );
    assert_eq!(
        *archipelago
            .get_agent(agent_too_high_above_mesh)
            .unwrap()
            .get_desired_velocity(),
        Vec3::ZERO
    );

    archipelago.update(/* delta_time= */ 0.01);

    // These agents found a path and started following it.
    assert_eq!(
        archipelago.get_agent(agent_1).unwrap().state(),
        AgentState::Moving
    );
    assert_eq!(
        archipelago.get_agent(agent_2).unwrap().state(),
        AgentState::Moving
    );
    assert!(
        archipelago
            .get_agent(agent_1)
            .unwrap()
            .get_desired_velocity()
            .abs_diff_eq(Vec3::new(1.5, 0.5, 0.0).normalize() * 2.0, 1e-2)
    );
    assert!(
        archipelago
            .get_agent(agent_2)
            .unwrap()
            .get_desired_velocity()
            .abs_diff_eq(Vec3::new(-0.5, -1.5, 0.0).normalize() * 2.0, 1e-2)
    );
    // These agents are not on the nav mesh, so they don't do anything.
    assert_eq!(
        archipelago.get_agent(agent_off_mesh).unwrap().state(),
        AgentState::AgentNotOnNavMesh
    );
    assert_eq!(
        archipelago.get_agent(agent_too_high_above_mesh).unwrap().state(),
        AgentState::AgentNotOnNavMesh
    );
    assert_eq!(
        *archipelago.get_agent(agent_off_mesh).unwrap().get_desired_velocity(),
        Vec3::ZERO
    );
    assert_eq!(
        *archipelago
            .get_agent(agent_too_high_above_mesh)
            .unwrap()
            .get_desired_velocity(),
        Vec3::ZERO
    );

    assert_eq!(archipelago.get_pathing_results().len(), 2);
    let path_result_1 = archipelago.get_pathing_results()[0];
    let path_result_2 = archipelago.get_pathing_results()[1];
    assert!(path_result_1.success);
    assert!(path_result_2.success);
    assert!(path_result_1.explored_nodes > 0);
    assert!(path_result_2.explored_nodes > 0);

    // Move agent_1 forward.
    archipelago.get_agent_mut(agent_1).unwrap().position =
        Vec3::new(2.5, 1.5, 1.0);
    archipelago.update(/* delta_time= */ 0.01);

    assert!(
        archipelago
            .get_agent(agent_1)
            .unwrap()
            .get_desired_velocity()
            .abs_diff_eq(Vec3::new(0.5, 0.5, 0.0).normalize() * 2.0, 1e-7)
    );
    // These agents don't change.
    assert!(
        archipelago
            .get_agent(agent_2)
            .unwrap()
            .get_desired_velocity()
            .abs_diff_eq(Vec3::new(-0.5, -1.5, 0.0).normalize() * 2.0, 1e-2)
    );
    assert_eq!(
        *archipelago.get_agent(agent_off_mesh).unwrap().get_desired_velocity(),
        Vec3::ZERO
    );
    assert_eq!(
        *archipelago
            .get_agent(agent_too_high_above_mesh)
            .unwrap()
            .get_desired_velocity(),
        Vec3::ZERO
    );
    assert_eq!(
        archipelago.get_agent(agent_1).unwrap().state(),
        AgentState::Moving
    );
    assert_eq!(
        archipelago.get_agent(agent_2).unwrap().state(),
        AgentState::Moving
    );
    assert_eq!(
        archipelago.get_agent(agent_off_mesh).unwrap().state(),
        AgentState::AgentNotOnNavMesh
    );
    assert_eq!(
        archipelago.get_agent(agent_too_high_above_mesh).unwrap().state(),
        AgentState::AgentNotOnNavMesh
    );

    // Move agent_1 close enough to destination and agent_2 forward.
    archipelago.get_agent_mut(agent_1).unwrap().position =
        Vec3::new(3.4, 3.4, 1.0);
    archipelago.get_agent_mut(agent_2).unwrap().position =
        Vec3::new(3.5, 2.5, 1.0);
    archipelago.update(/* delta_time= */ 0.01);

    assert_eq!(
        archipelago.get_agent(agent_1).unwrap().state(),
        AgentState::ReachedTarget
    );
    assert_eq!(
        archipelago.get_agent(agent_2).unwrap().state(),
        AgentState::Moving
    );
    assert_eq!(
        *archipelago.get_agent(agent_1).unwrap().get_desired_velocity(),
        Vec3::ZERO
    );
    assert!(
        archipelago
            .get_agent(agent_2)
            .unwrap()
            .get_desired_velocity()
            .abs_diff_eq(Vec3::new(-0.5, -0.5, 0.0).normalize() * 2.0, 1e-2)
    );
    // These agents don't change.
    assert_eq!(
        *archipelago.get_agent(agent_off_mesh).unwrap().get_desired_velocity(),
        Vec3::ZERO
    );
    assert_eq!(
        *archipelago
            .get_agent(agent_too_high_above_mesh)
            .unwrap()
            .get_desired_velocity(),
        Vec3::ZERO
    );
    assert_eq!(
        archipelago.get_agent(agent_off_mesh).unwrap().state(),
        AgentState::AgentNotOnNavMesh
    );
    assert_eq!(
        archipelago.get_agent(agent_too_high_above_mesh).unwrap().state(),
        AgentState::AgentNotOnNavMesh
    );
}

#[test]
fn agent_speeds_up_to_avoid_character() {
    let mut archipelago =
        Archipelago::<XY>::new(ArchipelagoOptions::from_agent_radius(0.5));

    archipelago.archipelago_options.avoidance_time_horizon = 100.0;
    archipelago.archipelago_options.neighbourhood = 10.0;

    let nav_mesh = Arc::new(
        NavigationMesh {
            vertices: vec![
                Vec2::new(-10.0, -10.0),
                Vec2::new(10.0, -10.0),
                Vec2::new(10.0, 10.0),
                Vec2::new(-10.0, 10.0),
            ],
            polygons: vec![vec![0, 1, 2, 3]],
            polygon_type_indices: vec![0],
            height_mesh: None,
        }
        .validate()
        .expect("Validation succeeded."),
    );

    archipelago.add_island(Island::new(Transform::default(), nav_mesh));

    let agent_id = archipelago.add_agent({
        let mut agent = Agent::create(
            /* position= */ Vec2::new(5.0, 0.0),
            /* velocity= */ Vec2::new(-1.0, 0.0),
            /* radius= */ 0.5,
            /* desired_speed= */ 1.0,
            /* max_speed= */ 2.0,
        );
        agent.current_target = Some(Vec2::new(-5.0, 0.0));
        agent
    });

    archipelago.update(0.01);
    // The agent will move at its desired speed normally.
    assert_eq!(
        *archipelago.get_agent(agent_id).unwrap().get_desired_velocity(),
        Vec2::new(-1.0, 0.0)
    );

    archipelago.add_character(Character {
        position: Vec2::new(0.0, 5.0),
        velocity: Vec2::new(0.0, -1.0),
        radius: 0.5,
    });

    archipelago.update(0.01);

    let agent_desired_velocity =
        *archipelago.get_agent(agent_id).unwrap().get_desired_velocity();
    // The agent speeds up to avoid the character.
    assert!(
        agent_desired_velocity.length() > 1.1,
        "actual={agent_desired_velocity} actual_length={} expected=greater than 1.0",
        agent_desired_velocity.length(),
    );
}

#[test]
fn add_and_remove_islands() {
    let mut archipelago =
        Archipelago::<XYZ>::new(ArchipelagoOptions::from_agent_radius(0.5));
    let nav_mesh = Arc::new(
        NavigationMesh {
            vertices: vec![],
            polygons: vec![],
            polygon_type_indices: vec![],
            height_mesh: None,
        }
        .validate()
        .unwrap(),
    );

    let island_id_1 =
        archipelago.add_island(Island::new(Transform::default(), nav_mesh.clone()));
    let island_id_2 =
        archipelago.add_island(Island::new(Transform::default(), nav_mesh.clone()));
    let island_id_3 =
        archipelago.add_island(Island::new(Transform::default(), nav_mesh.clone()));

    fn sorted(mut v: Vec<IslandId>) -> Vec<IslandId> {
        v.sort();
        v
    }

    assert_eq!(
        sorted(archipelago.get_island_ids().collect()),
        sorted(vec![island_id_1, island_id_2, island_id_3])
    );

    archipelago.remove_island(island_id_2);

    assert_eq!(
        sorted(archipelago.get_island_ids().collect()),
        sorted(vec![island_id_1, island_id_3])
    );
}

#[test]
fn changed_island_is_not_dirty_after_update() {
    let mut archipelago =
        Archipelago::<XYZ>::new(ArchipelagoOptions::from_agent_radius(0.5));

    let island_id = archipelago.add_island(Island::new(
        Transform::default(),
        Arc::new(
            NavigationMesh {
                vertices: vec![],
                polygons: vec![],
                polygon_type_indices: vec![],
                height_mesh: None,
            }
            .validate()
            .unwrap(),
        ),
    ));

    assert!(archipelago.get_island(island_id).unwrap().dirty);

    archipelago.update(/* delta_time= */ 0.01);
    assert!(!archipelago.get_island(island_id).unwrap().dirty);

    // Change the island (even though there isn't really a change).
    archipelago
        .get_island_mut(island_id)
        .unwrap()
        .set_transform(Transform::default());

    assert!(archipelago.get_island(island_id).unwrap().dirty);

    archipelago.update(/* delta_time= */ 0.01);

    assert!(!archipelago.get_island(island_id).unwrap().dirty);
}

fn simple_one_node_nav_mesh() -> Arc<ValidNavigationMesh<XY>> {
    Arc::new(
        NavigationMesh {
            vertices: vec![
                Vec2::new(0.0, 0.0),
                Vec2::new(1.0, 0.0),
                Vec2::new(1.0, 1.0),
                Vec2::new(0.0, 1.0),
            ],
            polygons: vec![vec![0, 1, 2, 3]],
            polygon_type_indices: vec![0],
            height_mesh: None,
        }
        .validate()
        .expect("nav mesh is valid"),
    )
}

#[test]
fn samples_point() {
    let mut archipelago =
        Archipelago::<XY>::new(ArchipelagoOptions::from_agent_radius(0.5));

    let nav_mesh = simple_one_node_nav_mesh();

    let offset = Vec2::new(10.0, 10.0);
    archipelago.add_island(Island::new(
        Transform { translation: offset, rotation: 0.0 },
        nav_mesh,
    ));
    archipelago.update(1.0);

    assert_eq!(
        archipelago
            .sample_point(
                /* point= */ offset + Vec2::new(-0.5, 0.5),
                /* distance_to_node= */ &0.6
            )
            .map(|p| p.point()),
        Ok(offset + Vec2::new(0.0, 0.5))
    );
    assert_eq!(
        archipelago
            .sample_point(
                /* point= */ offset + Vec2::new(0.5, 0.5),
                /* distance_to_node= */ &0.6
            )
            .map(|p| p.point()),
        Ok(offset + Vec2::new(0.5, 0.5))
    );
    assert_eq!(
        archipelago
            .sample_point(
                /* point= */ offset + Vec2::new(1.2, 1.2),
                /* distance_to_node= */ &0.6
            )
            .map(|p| p.point()),
        Ok(offset + Vec2::new(1.0, 1.0))
    );
}

#[test]
fn finds_path() {
    let mut archipelago =
        Archipelago::<XY>::new(ArchipelagoOptions::from_agent_radius(0.5));

    let nav_mesh = simple_one_node_nav_mesh();

    let offset = Vec2::new(10.0, 10.0);
    archipelago.add_island(Island::new(
        Transform { translation: offset, rotation: 0.0 },
        nav_mesh.clone(),
    ));
    archipelago.add_island(Island::new(
        Transform { translation: offset + Vec2::new(1.0, 0.0), rotation: 0.0 },
        nav_mesh.clone(),
    ));
    archipelago.add_island(Island::new(
        Transform { translation: offset + Vec2::new(2.0, 0.5), rotation: 0.0 },
        nav_mesh,
    ));
    archipelago.update(1.0);

    let start_point = archipelago
        .sample_point(offset + Vec2::new(0.5, 0.5), &1e-5)
        .expect("point is on nav mesh.");
    let end_point = archipelago
        .sample_point(offset + Vec2::new(2.5, 1.25), &1e-5)
        .expect("point is on nav mesh.");
    assert_eq!(
        find_path(&archipelago, 
            &start_point,
            &end_point,
            &Map::default(),
            PermittedAnimationLinks::All,
        ),
        Ok(vec![
            PathStep::Waypoint(offset + Vec2::new(0.5, 0.5)),
            PathStep::Waypoint(offset + Vec2::new(2.0, 1.0)),
            PathStep::Waypoint(offset + Vec2::new(2.5, 1.25))
        ])
    );
}

#[test]
fn agent_overrides_node_costs() {
    let mut archipelago =
        Archipelago::<XY>::new(ArchipelagoOptions::from_agent_radius(0.5));

    let nav_mesh = Arc::new(
        NavigationMesh {
            vertices: vec![
                Vec2::new(0.0, 0.0),
                Vec2::new(1.0, 0.0),
                Vec2::new(1.0, 1.0),
                Vec2::new(0.0, 1.0),
                //
                Vec2::new(2.0, 0.0),
                Vec2::new(2.0, 1.0),
                //
                Vec2::new(3.0, 0.0),
                Vec2::new(3.0, 1.0),
                //
                Vec2::new(2.0, 11.0),
                Vec2::new(3.0, 11.0),
                //
                Vec2::new(2.0, 12.0),
                Vec2::new(3.0, 12.0),
                //
                Vec2::new(1.0, 12.0),
                Vec2::new(1.0, 11.0),
                //
                Vec2::new(0.0, 12.0),
                Vec2::new(0.0, 11.0),
            ],
            polygons: vec![
                vec![0, 1, 2, 3],
                vec![2, 1, 4, 5],
                vec![5, 4, 6, 7],
                //
                vec![5, 7, 9, 8],
                vec![8, 9, 11, 10],
                //
                vec![8, 10, 12, 13],
                vec![13, 12, 14, 15],
                //
                vec![3, 2, 13, 15],
            ],
            polygon_type_indices: vec![0, 0, 0, 0, 0, 0, 0, 1],
            height_mesh: None,
        }
        .validate()
        .expect("nav mesh is valid"),
    );

    archipelago.set_type_index_cost(1, 1.0).unwrap();

    archipelago.add_island(Island::new(Transform::default(), nav_mesh));

    let agent_id = archipelago.add_agent({
        let mut agent = Agent::create(
            /* position= */ Vec2::new(0.5, 0.5),
            /* velocity= */ Vec2::ZERO,
            /* radius= */ 0.5,
            /* desired_speed= */ 1.0,
            /* max_speed= */ 1.0,
        );
        assert!(agent.override_type_index_cost(1, 10.0));
        agent.current_target = Some(Vec2::new(0.5, 11.5));
        agent
    });

    archipelago.update(1.0);

    // The agent **could** go directly up, but due to its overridden node cost, it
    // is better to take the detour to the right.
    assert_eq!(
        *archipelago.get_agent(agent_id).unwrap().get_desired_velocity(),
        Vec2::new(1.5, 0.5).normalize(),
    );
}



#[test]
fn paused_agent_does_not_repath() {
    let mut archipelago =
        Archipelago::<XY>::new(ArchipelagoOptions::from_agent_radius(0.5));

    let nav_mesh = Arc::new(
        NavigationMesh {
            vertices: vec![
                Vec2::new(0.0, 0.0),
                Vec2::new(1.0, 0.0),
                Vec2::new(1.0, 1.0),
                Vec2::new(0.0, 1.0),
                Vec2::new(1.0, 2.0),
                Vec2::new(0.0, 2.0),
                Vec2::new(1.0, 3.0),
                Vec2::new(0.0, 3.0),
            ],
            polygons: vec![vec![0, 1, 2, 3], vec![3, 2, 4, 5], vec![5, 4, 6, 7]],
            polygon_type_indices: vec![0; 3],
            height_mesh: None,
        }
        .validate()
        .expect("nav mesh is valid"),
    );

    let island_id =
        archipelago.add_island(Island::new(Transform::default(), nav_mesh));
    let agent = archipelago.add_agent({
        let mut agent =
            Agent::create(Vec2::new(0.5, 0.5), Vec2::ZERO, 0.5, 1.0, 1.0);
        agent.current_target = Some(Vec2::new(0.5, 1.5));
        agent
    });

    archipelago.update(1.0);

    let agent_mut = archipelago.get_agent_mut(agent).unwrap();
    assert_eq!(path_ends(&agent_mut.current_path), Some((
            NodeRef { island_id, polygon_index: 0 },
            NodeRef { island_id, polygon_index: 1 }
        )));

    // Now pause the agent and move it around. Even move its target around!
    agent_mut.paused = true;
    agent_mut.position = Vec2::new(0.5, 1.5);
    agent_mut.current_target = Some(Vec2::new(0.5, 2.5));

    archipelago.update(1.0);

    // The path has not changed.
    let agent_mut = archipelago.get_agent_mut(agent).unwrap();
    assert_eq!(path_ends(&agent_mut.current_path), Some((
            NodeRef { island_id, polygon_index: 0 },
            NodeRef { island_id, polygon_index: 1 }
        )));
    assert_eq!(agent_mut.state(), AgentState::Paused);

    // Move the agent and its target completely off the nav mesh.
    agent_mut.position = Vec2::new(3.5, 1.5);
    agent_mut.current_target = Some(Vec2::new(3.5, 2.5));

    archipelago.update(1.0);

    // The path has not changed.
    let agent_mut = archipelago.get_agent_mut(agent).unwrap();
    assert_eq!(path_ends(&agent_mut.current_path), Some((
            NodeRef { island_id, polygon_index: 0 },
            NodeRef { island_id, polygon_index: 1 }
        )));

    // Move the agent and target back onto the path and unpause the agent.
    agent_mut.position = Vec2::new(0.5, 0.5);
    agent_mut.current_target = Some(Vec2::new(0.5, 1.5));
    agent_mut.paused = false;

    archipelago.update(1.0);

    // The path has not changed.
    let agent_mut = archipelago.get_agent_mut(agent).unwrap();
    assert_eq!(path_ends(&agent_mut.current_path), Some((
            NodeRef { island_id, polygon_index: 0 },
            NodeRef { island_id, polygon_index: 1 }
        )));
    assert_eq!(agent_mut.state(), AgentState::Moving);

    // Pause the agent and move it to somewhere off the path.
    agent_mut.position = Vec2::new(0.5, 1.5);
    agent_mut.current_target = Some(Vec2::new(0.5, 2.5));
    agent_mut.paused = true;

    archipelago.update(1.0);

    // The path has not changed.
    let agent_mut = archipelago.get_agent_mut(agent).unwrap();
    assert_eq!(path_ends(&agent_mut.current_path), Some((
            NodeRef { island_id, polygon_index: 0 },
            NodeRef { island_id, polygon_index: 1 }
        )));
    assert_eq!(agent_mut.state(), AgentState::Paused);

    // Unpause the agent.
    agent_mut.paused = false;

    archipelago.update(1.0);

    // The path has finally changed!
    let agent_mut = archipelago.get_agent_mut(agent).unwrap();
    assert_eq!(path_ends(&agent_mut.current_path), Some((
            NodeRef { island_id, polygon_index: 1 },
            NodeRef { island_id, polygon_index: 2 }
        )));
    assert_eq!(agent_mut.state(), AgentState::Moving);
}

#[test]
fn paused_agent_path_is_removed_when_invalid() {
    let mut archipelago =
        Archipelago::<XY>::new(ArchipelagoOptions::from_agent_radius(0.5));
    let nav_mesh = simple_one_node_nav_mesh();

    let island_1 =
        archipelago.add_island(Island::new(Transform::default(), nav_mesh.clone()));
    let island_2 = archipelago.add_island(Island::new(
        Transform { translation: Vec2::new(0.0, 1.0), rotation: 0.0 },
        nav_mesh.clone(),
    ));
    archipelago.add_island(Island::new(
        Transform { translation: Vec2::new(1.0, 0.0), rotation: 0.0 },
        nav_mesh,
    ));

    let agent = archipelago.add_agent({
        let mut agent =
            Agent::create(Vec2::new(0.5, 0.5), Vec2::ZERO, 0.5, 1.0, 1.0);
        agent.current_target = Some(Vec2::new(0.5, 1.5));
        agent
    });

    archipelago.update(1.0);

    let agent_mut = archipelago.get_agent_mut(agent).unwrap();
    assert_eq!(path_ends(&agent_mut.current_path), Some((
            NodeRef { island_id: island_1, polygon_index: 0 },
            NodeRef { island_id: island_2, polygon_index: 0 }
        )));
    assert_eq!(agent_mut.state(), AgentState::Moving);

    // Move the agent to somewhere else to show we don't update the path.
    agent_mut.paused = true;
    agent_mut.position = Vec2::new(1.5, 0.5);

    archipelago.update(1.0);

    // The path didn't change.
    let agent_ref = archipelago.get_agent_mut(agent).unwrap();
    assert_eq!(path_ends(&agent_ref.current_path), Some((
            NodeRef { island_id: island_1, polygon_index: 0 },
            NodeRef { island_id: island_2, polygon_index: 0 }
        )));
    assert_eq!(agent_ref.state(), AgentState::Paused);

    // Despite the agent still being paused, making the path invalid should remove
    // the path.
    archipelago.remove_island(island_2);
    archipelago.update(1.0);

    let agent_ref = archipelago.get_agent(agent).unwrap();
    assert!(agent_ref.current_path.is_none());
    assert_eq!(agent_ref.state(), AgentState::Paused);
}



#[test]
fn agent_can_use_animation_link() {
    let mut archipelago =
        Archipelago::<XY>::new(ArchipelagoOptions::from_agent_radius(0.5));
    let nav_mesh = Arc::new(
        NavigationMesh {
            vertices: vec![
                Vec2::new(0.0, 0.0),
                Vec2::new(1.0, 0.0),
                Vec2::new(1.0, 1.0),
                Vec2::new(0.0, 1.0),
                Vec2::new(2.0, 1.0),
                Vec2::new(2.0, 2.0),
                Vec2::new(1.0, 2.0),
            ],
            polygons: vec![vec![0, 1, 2, 3], vec![2, 1, 4], vec![2, 4, 5, 6]],
            polygon_type_indices: vec![0; 3],
            height_mesh: None,
        }
        .validate()
        .expect("nav mesh is valid"),
    );

    archipelago.add_island(Island::new(Transform::default(), nav_mesh.clone()));
    archipelago.add_island(Island::new(
        Transform { translation: Vec2::new(3.0, 5.0), rotation: PI },
        nav_mesh.clone(),
    ));
    let link_id = archipelago.add_animation_link(AnimationLink {
        start_edge: (Vec2::new(1.0, 1.9), Vec2::new(2.0, 1.9)),
        end_edge: (Vec2::new(1.0, 3.1), Vec2::new(2.0, 3.1)),
        cost: 1.0,
        kind: 0,
        bidirectional: false,
    });

    let agent_id = archipelago.add_agent({
        let mut agent = Agent::create(
            /* position= */ Vec2::new(0.25, 0.75),
            /* velocity= */ Vec2::ZERO,
            /* radius= */ 0.5,
            /* desired_speed= */ 1.0,
            /* max_speed= */ 2.0,
        );
        agent.current_target = Some(Vec2::new(2.75, 4.25));
        agent
    });

    archipelago.update(1.0);

    let agent = archipelago.get_agent_mut(agent_id).unwrap();
    assert_eq!(agent.state(), AgentState::Moving);
    assert_eq!(
        *agent.get_desired_velocity(),
        (Vec2::new(1.0, 1.0) - Vec2::new(0.25, 0.75)).normalize()
    );
    assert!(!agent.is_using_animation_link());
    assert!(agent.reached_animation_link().is_none());

    // Move the agent forward.
    agent.position = Vec2::new(1.25, 0.75);
    archipelago.update(1.0);

    let agent = archipelago.get_agent_mut(agent_id).unwrap();
    assert_eq!(agent.state(), AgentState::Moving);
    assert_eq!(*agent.get_desired_velocity(), Vec2::new(0.0, 1.0));
    assert!(!agent.is_using_animation_link());
    assert!(agent.reached_animation_link().is_none());

    // Move the agent to be touching the animation link.
    agent.position = Vec2::new(1.25, 1.5);
    archipelago.update(1.0);

    let agent = archipelago.get_agent_mut(agent_id).unwrap();
    assert_eq!(agent.state(), AgentState::ReachedAnimationLink);
    assert_eq!(*agent.get_desired_velocity(), Vec2::new(0.0, 1.0));
    assert!(!agent.is_using_animation_link());
    assert_reached(agent.reached_animation_link(), ReachedAnimationLink {
            start_point: Vec2::new(1.25, 1.9),
            end_point: Vec2::new(1.25, 3.1),
            link_id,
        });

    assert_eq!(agent.start_animation_link(), Ok(()));

    // Pretend the agent does some random stuff. Nothing should get out of sync.
    agent.position = Vec2::new(100.0, 200.0);
    archipelago.update(1.0);

    let agent = archipelago.get_agent_mut(agent_id).unwrap();
    assert_eq!(agent.state(), AgentState::UsingAnimationLink);
    assert!(agent.is_using_animation_link());
    assert!(agent.reached_animation_link().is_none());

    assert_eq!(agent.end_animation_link(), Ok(()));
    // We ended at a different point than expected, but that's ok.
    agent.position = Vec2::new(1.75, 3.1);
    archipelago.update(1.0);

    let agent = archipelago.get_agent_mut(agent_id).unwrap();
    assert_eq!(agent.state(), AgentState::Moving);
    assert_eq!(
        *agent.get_desired_velocity(),
        (Vec2::new(2.0, 4.0) - Vec2::new(1.75, 3.1)).normalize()
    );
    assert!(!agent.is_using_animation_link());
    assert!(agent.reached_animation_link().is_none());
}

fn simple_two_node_nav_mesh() -> Arc<ValidNavigationMesh<XY>> {
    Arc::new(
        NavigationMesh {
            vertices: vec![
                Vec2::new(0.0, 0.0),
                Vec2::new(1.0, 0.0),
                Vec2::new(1.0, 1.0),
                Vec2::new(0.0, 1.0),
                Vec2::new(1.0, 2.0),
                Vec2::new(0.0, 2.0),
            ],
            polygons: vec![vec![0, 1, 2, 3], vec![3, 2, 4, 5]],
            polygon_type_indices: vec![0; 2],
            height_mesh: None,
        }
        .validate()
        .expect("nav mesh is valid"),
    )
}

#[test]
fn agent_path_cleared_when_clearing_target() {
    let mut archipelago =
        Archipelago::<XY>::new(ArchipelagoOptions::from_agent_radius(0.5));
    let nav_mesh = simple_two_node_nav_mesh();

    archipelago.add_island(Island::new(Transform::default(), nav_mesh));
    let agent_id = archipelago.add_agent({
        let mut agent =
            Agent::create(Vec2::new(0.5, 0.5), Vec2::ZERO, 0.5, 1.0, 2.0);
        agent.current_target = Some(Vec2::new(0.5, 1.5));
        agent
    });

    archipelago.update(1.0);

    let agent = archipelago.get_agent_mut(agent_id).unwrap();
    assert!(agent.current_path.is_some());
    assert_eq!(agent.state(), AgentState::Moving);

    agent.current_target = None;

    archipelago.update(1.0);

    let agent = archipelago.get_agent_mut(agent_id).unwrap();
    assert!(agent.current_path.is_none());
    assert_eq!(agent.state(), AgentState::Idle);
}

#[test]
fn agent_path_cleared_on_bad_target() {
    let mut archipelago =
        Archipelago::<XY>::new(ArchipelagoOptions::from_agent_radius(0.5));
    let nav_mesh = simple_two_node_nav_mesh();

    archipelago.add_island(Island::new(Transform::default(), nav_mesh));
    let agent_id = archipelago.add_agent({
        let mut agent =
            Agent::create(Vec2::new(0.5, 0.5), Vec2::ZERO, 0.5, 1.0, 2.0);
        agent.current_target = Some(Vec2::new(0.5, 1.5));
        agent
    });

    archipelago.update(1.0);

    let agent = archipelago.get_agent_mut(agent_id).unwrap();
    assert!(agent.current_path.is_some());
    assert_eq!(agent.state(), AgentState::Moving);

    // This target is off the nav mesh, so the path should be cleared and the
    // appropriate state set.
    agent.current_target = Some(Vec2::new(1.5, 1.5));

    archipelago.update(1.0);

    let agent = archipelago.get_agent_mut(agent_id).unwrap();
    assert!(agent.current_path.is_none());
    assert_eq!(agent.state(), AgentState::TargetNotOnNavMesh);
}

#[test]
fn agent_could_not_find_path() {
    let mut archipelago =
        Archipelago::<XY>::new(ArchipelagoOptions::from_agent_radius(0.5));
    let nav_mesh = simple_one_node_nav_mesh();

    archipelago.add_island(Island::new(Transform::default(), nav_mesh.clone()));
    archipelago.add_island(Island::new(
        Transform { translation: Vec2::new(2.0, 0.0), rotation: 0.0 },
        nav_mesh,
    ));
    let agent_id = archipelago.add_agent({
        let mut agent =
            Agent::create(Vec2::new(0.5, 0.5), Vec2::ZERO, 0.5, 1.0, 2.0);
        // This target isn't connected to the agent, so we shouldn't find a path!
        agent.current_target = Some(Vec2::new(2.5, 0.5));
        agent
    });

    archipelago.update(1.0);

    let agent = archipelago.get_agent_mut(agent_id).unwrap();
    assert!(agent.current_path.is_none());
    assert_eq!(agent.state(), AgentState::NoPath);
}
