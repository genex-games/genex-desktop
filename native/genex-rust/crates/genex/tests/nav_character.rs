//! NAV-13: the nav-to-character loop (new behaviour: there is no `NavDriver`; ANIM's `Character`
//! is the one controller owner). Each agent, in slice order, every `on_update`:
//!
//! 1. `sim.nav.update(dt)` (once, before the agents);
//! 2. `nav.desired_velocity(agent)` goes into the animator's parameters;
//! 3. `animator.update(dt)` gives the tick's root motion;
//! 4. `character.drive(physics, CharacterMotion::Mixed { .. }, dt)`;
//! 5. `nav.set_position(agent, character.feet(), character.velocity())`.
//!
//! The bake's `NavConfig` is `character.nav_config()` and the course is cut from the physics
//! colliders (NAV-5's `NavInput::with_static_colliders`). Rows:
//!
//! - an agent on a 200-waypoint course over steps of the controller's climb − 2 cm never stalls
//!   for 2 s (120 ticks with desired speed above 0.5 m/s and a move under 1 mm, or off the mesh),
//!   and the row fails when the bake climbs higher than the controller (the mismatch control);
//! - a character standing on the baked floor is on the mesh (the polygons sit above the ground by
//!   the bake's lift; red before nav sampled that far below the mesh);
//! - root motion moves the capsule while nav steers: with the whole move from the clip the agent
//!   still arrives, and an animator held in idle never moves it;
//! - the same agent slice in the documented order gives the same checksums, and so does the
//!   reversed slice (capsules move at the physics step, so no drive sees another's move this tick);
//! - the parity record (checksums every 60 ticks) is byte-identical across runs, and written to
//!   `GENEX_NAV_PARITY_OUT` for the cross-target comparison.

#![cfg(feature = "physics")]

#[path = "../../genex-anim/tests/support/mod.rs"]
mod rigs;

use std::sync::Arc;

use genex::nav::{NavAgent, NavArea, NavConfig, NavFilter, NavInput, NavMesh, NavStatus};
use genex::physics::ColliderBuilder;
use genex::prelude::*;
use genex::{CharacterParams, FIXED_STEP_MS, Runtime};
use genex_anim::animator::{AnimSet, Animator};
use genex_anim::clip::{Clip, Interpolation, Track, TrackValues};
use genex_anim::graph::{AnimGraph, Motion};
use genex_anim::import::{Rig, import_rig};
use genex_anim::params::FloatParam;
use genex_anim::root_motion::MotionSettings;
use genex_core::digest::{fnv1a64, hex64};
use genex_nav::AgentId;
use serde_json::json;

/// The stall rule: this many ticks in a row of wanting to move and not moving is a stall (2 s).
const STALL_TICKS: u32 = 120;
/// Wanting to move: a desired speed above this, metres per second.
const STALL_DESIRED_SPEED: f32 = 0.5;
/// Not moving: a tick's move under this, metres.
const STALL_MOVE: f32 = 1.0e-3;
/// Waypoints on the course.
const WAYPOINTS: usize = 200;
/// How far the next waypoint may be from the last, metres.
const WAYPOINT_RADIUS: f32 = 4.0;
/// The course's tick cap (the agent needs about 50,000).
const COURSE_TICKS: u64 = 80_000;
/// Steps are the climb less this, metres.
const STEP_SHORT_OF_CLIMB: f32 = 0.02;
/// Levels of the stepped pyramid the course crosses.
const LEVELS: usize = 3;
/// The agent's preferred and top speed, metres per second.
const AGENT_SPEED: (f32, f32) = (2.0, 3.0);
/// Ticks the crossing rows run (the walkers need about 2,500).
const CROSSING_TICKS: u64 = 3600;
/// Ticks between parity checkpoints.
const EVERY: u64 = 60;

/// The controller every row uses.
fn params() -> CharacterParams {
    CharacterParams::default()
}

/// The walker the bake uses: the controller's own (`character.nav_config()`), 8 m tiles.
fn matched_config() -> NavConfig {
    let probe = Character::on_ground(Vec3::ZERO, params()).expect("default parameters");
    probe.nav_config().with_tile(8.0)
}

/// A bake that climbs 0.15 m higher than the controller can: the mismatch control.
fn mismatched_config() -> NavConfig {
    let config = matched_config();
    let climb = config.climb() + 0.15;
    config.with_climb(climb)
}

// ---------------------------------------------------------------------------------------------
// The animator: genex-anim's humanoid fixture with an idle and a walk that travels 1.2 m/s.

fn rig() -> Rig {
    import_rig(&rigs::humanoid22().glb()).expect("the humanoid fixture imports")
}

fn swing(rig: &Rig, name: &str, seconds: f32, angles: &[f32]) -> Track {
    let joint = rig.skeleton().find(name).unwrap_or_else(|| panic!("joint {name}"));
    let last = (angles.len() - 1) as f32;
    let times = (0..angles.len()).map(|k| seconds * k as f32 / last).collect();
    let values = angles.iter().map(|angle| Quat::from_axis_angle(Vec3::X, *angle)).collect();
    Track::new(joint, Interpolation::Linear, times, TrackValues::Rotation(values)).expect("a swing")
}

fn travel(rig: &Rig, seconds: f32, metres: f32) -> Track {
    let hips = rig.skeleton().find("Hips").expect("hips");
    let values = vec![vec3(0.0, 1.0, 0.0), vec3(0.0, 1.0, metres)];
    Track::new(hips, Interpolation::Linear, vec![0.0, seconds], TrackValues::Translation(values)).expect("a travel")
}

/// The animator and its speed parameter: idle below 0.1 m/s, walk above.
fn walker_animator() -> (Animator, FloatParam) {
    let rig = rig();
    let clips = vec![
        Clip::new("Idle", vec![swing(&rig, "Spine", 1.0, &[0.0, 0.05, 0.0])]).expect("idle"),
        Clip::new("Walk", vec![travel(&rig, 0.8, 0.96), swing(&rig, "LeftUpLeg", 0.8, &[0.5, -0.5, 0.5])]).expect("walk"),
    ];
    let set = Arc::new(AnimSet::with_root_motion(rig.skeleton().clone(), clips, &MotionSettings::default()).expect("root motion"));
    let mut g = AnimGraph::builder(set.skeleton(), set.clips());
    let ids: Vec<_> = g.clips().map(|(id, _)| id).collect();
    let speed = g.float("speed", 0.0);
    let base = g.layer("base");
    let idle = g.state(base, "idle", Motion::clip(ids[0]));
    let walk = g.state(base, "walk", Motion::clip(ids[1]));
    g.transition(idle, walk).when(speed.above(0.1)).crossfade(0.15);
    g.transition(walk, idle).when(speed.below(0.1)).crossfade(0.15);
    let graph = g.build().expect("the graph builds");
    (Animator::new(set, &graph).expect("the animator builds"), speed)
}

// ---------------------------------------------------------------------------------------------
// The game.

/// One walker: its nav agent, its animator and its capsule.
struct Walker {
    agent: AgentId,
    animator: Animator,
    speed: FloatParam,
    character: Character,
    /// Ticks in a row it wanted to move and did not.
    stuck: u32,
    /// The longest such run.
    longest_stall: u32,
    /// Metres the capsule moved, and metres the clip asked for.
    moved: f32,
    rooted: f32,
    /// The highest the feet stood.
    highest: f32,
}

/// How a run is set up.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Setup {
    /// The bake climbs higher than the controller.
    mismatched: bool,
    /// The move's share from the clip (0.5 when `None`).
    root_share: Option<f32>,
    /// Hold every animator in idle (no root motion).
    hold_idle: bool,
    /// Walkers' start and end points (none: one walker on the waypoint course).
    crossing: bool,
    /// Visit the walkers in reverse slice order.
    reversed: bool,
}

#[derive(Default)]
struct World {
    setup: Setup,
    walkers: Vec<Walker>,
    rng: Option<Pcg32>,
    /// Waypoints reached on the course.
    reached: usize,
}

/// Rise of one step: the bake's climb less 2 cm.
fn step_rise(config: &NavConfig) -> f32 {
    config.climb() - STEP_SHORT_OF_CLIMB
}

/// A 30 m floor and a stepped pyramid of `LEVELS` 2.5 m treads, each `rise` higher.
fn build_course(physics: &mut PhysicsWorld, rise: f32) {
    physics.insert_collider(ColliderBuilder::cuboid(15.0, 0.5, 15.0).translation(vec3(0.0, -0.5, 0.0)), None);
    for level in 1..=LEVELS {
        let half = 9.0 - 2.5 * (level - 1) as f32;
        let top = rise * level as f32;
        physics.insert_collider(ColliderBuilder::cuboid(half, top * 0.5, half).translation(vec3(0.0, top * 0.5, 0.0)), None);
    }
}

fn walker(sim: &mut Sim<World>, start: Vec3) -> Walker {
    let agent = sim.nav.add_agent(NavAgent::new(start).with_speed(AGENT_SPEED.0, AGENT_SPEED.1).with_reach(0.4)).expect("an agent");
    let character = Character::spawn(&mut sim.physics, start, params()).expect("a capsule");
    let (animator, speed) = walker_animator();
    Walker { agent, animator, speed, character, stuck: 0, longest_stall: 0, moved: 0.0, rooted: 0.0, highest: start.y }
}

/// Crossing walkers: four corners of the pyramid's foot, each walking to the opposite corner.
const CROSSING: [(Vec3, Vec3); 4] = [
    (Vec3::new(-11.0, 0.0, -11.0), Vec3::new(11.0, 0.0, 11.0)),
    (Vec3::new(11.0, 0.0, 11.0), Vec3::new(-11.0, 0.0, -11.0)),
    (Vec3::new(-11.0, 0.0, 11.0), Vec3::new(11.0, 0.0, -11.0)),
    (Vec3::new(11.0, 0.0, -11.0), Vec3::new(-11.0, 0.0, 11.0)),
];

fn reset(sim: &mut Sim<World>, seed: u64) {
    let setup = sim.world.setup;
    let config = if setup.mismatched { mismatched_config() } else { matched_config() };
    build_course(&mut sim.physics, step_rise(&config));
    let input = NavInput::new().with_static_colliders(&sim.physics, NavArea::WALK).expect("the course");
    sim.nav.add_mesh(&NavMesh::bake(&input, &config).expect("the mesh")).expect("the tiles");
    // Islands stitch on an update; queries read stitched islands.
    sim.nav.update(FIXED_STEP_MS as f32 / 1000.0);
    sim.world.walkers.clear();
    sim.world.rng = Some(Pcg32::seeded(seed));
    if setup.crossing {
        for (start, end) in CROSSING {
            let walker = walker(sim, start);
            sim.nav.move_to(walker.agent, end);
            sim.world.walkers.push(walker);
        }
        return;
    }
    let walker = walker(sim, vec3(-12.0, 0.0, -12.0));
    sim.world.walkers.push(walker);
    next_waypoint(sim, 0);
}

/// Send walker `index` to a random reachable point near where it stands.
fn next_waypoint(sim: &mut Sim<World>, index: usize) {
    let agent = sim.world.walkers[index].agent;
    let here = sim.nav.position(agent).expect("an agent");
    let rng = sim.world.rng.as_mut().expect("seeded");
    let point = sim.nav.random_point(rng, here, WAYPOINT_RADIUS, &NavFilter::new()).expect("a reachable point");
    sim.nav.move_to(agent, point.position);
}

/// The documented loop, once per tick.
fn update(sim: &mut Sim<World>, ctx: &Ctx) {
    let setup = sim.world.setup;
    // 1. Nav first.
    sim.nav.update(ctx.dt);
    let mut order: Vec<usize> = (0..sim.world.walkers.len()).collect();
    if setup.reversed {
        order.reverse();
    }
    for index in order {
        let walker = &mut sim.world.walkers[index];
        // 2. The desired velocity into the animator's parameters.
        let wish = sim.nav.desired_velocity(walker.agent);
        let speed = if setup.hold_idle { 0.0 } else { wish.length() };
        walker.animator.set_float(walker.speed, speed);
        // 3. The animator gives the tick's root motion.
        let root = walker.animator.update(ctx.dt).root_motion;
        // 4. The character makes the move.
        let root_share = setup.root_share.unwrap_or(0.5);
        let step = walker.character.drive(&mut sim.physics, CharacterMotion::Mixed { root, wish, jump: false, root_share }, ctx.dt);
        // 5. Nav hears where the capsule went.
        sim.nav.set_position(walker.agent, walker.character.feet(), walker.character.velocity());
        let moved = vec2(step.moved.x, step.moved.z).length();
        walker.moved += moved;
        walker.highest = walker.highest.max(walker.character.feet().y);
        walker.rooted += vec2(root.translation.x, root.translation.z).length();
        // Off the mesh nav wants nothing, so it never moves again: that is a stall too.
        let off_mesh = sim.nav.status(walker.agent) == Some(NavStatus::OffMesh);
        let stalled = off_mesh || (wish.length() > STALL_DESIRED_SPEED && moved < STALL_MOVE);
        walker.stuck = if stalled { walker.stuck + 1 } else { 0 };
        walker.longest_stall = walker.longest_stall.max(walker.stuck);
    }
    if setup.crossing || sim.world.reached >= WAYPOINTS {
        return;
    }
    if sim.nav.status(sim.world.walkers[0].agent) == Some(NavStatus::Arrived) {
        sim.world.reached += 1;
        if sim.world.reached < WAYPOINTS {
            next_waypoint(sim, 0);
        }
    }
}

fn game(setup: Setup) -> Game<World> {
    let mut game = Game::new(World { setup, ..World::default() });
    game.navigation(if setup.mismatched { mismatched_config() } else { matched_config() });
    game.on_reset(move |sim, seed, _, _| {
        sim.world.setup = setup;
        reset(sim, u64::from(seed));
    });
    game.on_update(update);
    game.probe("walkers", |sim| {
        let walkers: Vec<_> = sim.world.walkers.iter().map(|w| json!({ "character": hex64(w.character.digest()), "animator": hex64(w.animator.digest()) })).collect();
        json!({ "walkers": walkers, "agents": hex64(sim.nav.agents_digest()), "reached": sim.world.reached })
    });
    game
}

fn runtime(setup: Setup) -> Runtime<World> {
    let mut runtime = Runtime::new(game(setup)).expect("installs");
    assert!(runtime.start());
    runtime.seed(1);
    runtime
}

/// Run the course until every waypoint is reached or the cap; the reached count and the longest stall.
fn course(setup: Setup) -> (usize, u32, u64, f32) {
    let mut runtime = runtime(setup);
    let mut ticks = 0;
    while runtime.sim().world.reached < WAYPOINTS && ticks < COURSE_TICKS {
        runtime.step(FIXED_STEP_MS);
        ticks += 1;
    }
    let sim = runtime.sim();
    let first = &sim.world.walkers[0];
    println!(
        "course {setup:?}: {:?} at {:?} (feet {}) toward {:?}, wish {}, corner {:?}",
        sim.nav.status(first.agent),
        sim.nav.position(first.agent),
        first.character.feet(),
        sim.nav.target(first.agent),
        sim.nav.desired_velocity(first.agent),
        sim.nav.next_corner(first.agent)
    );

    let world = &sim.world;
    (world.reached, world.walkers[0].longest_stall, ticks, world.walkers[0].highest)
}

#[test]
fn an_agent_on_a_stepped_200_waypoint_course_never_stalls() {
    let config = matched_config();
    assert_eq!(config.climb(), params().step_height, "the bake climbs what the controller climbs");
    assert_eq!(config.slope(), params().max_slope_degrees, "and stands on what it stands on");
    let (reached, longest_stall, ticks, highest) = course(Setup::default());
    println!("matched: reached {reached} of {WAYPOINTS} in {ticks} ticks, longest stall {longest_stall} ticks, highest feet {highest} m");
    let top = step_rise(&config) * LEVELS as f32;
    assert!(highest > top - 0.01, "the course climbed every step to the top ({highest} m of {top} m)");
    assert!(longest_stall < STALL_TICKS, "stalled {longest_stall} ticks in a row");
    assert_eq!(reached, WAYPOINTS, "every waypoint within {COURSE_TICKS} ticks (took {ticks})");
}

#[test]
fn a_bake_that_climbs_higher_than_the_controller_stalls() {
    let (reached, longest_stall, ticks, highest) = course(Setup { mismatched: true, ..Setup::default() });
    println!("mismatched: reached {reached} of {WAYPOINTS} in {ticks} ticks, longest stall {longest_stall} ticks, highest feet {highest} m");
    assert!(longest_stall >= STALL_TICKS, "the stall rule catches the mismatch (longest {longest_stall})");
}

/// One walker's totals after a crossing: metres moved, metres the clip asked for, its status.
type Totals = (f32, f32, Option<NavStatus>);

/// Crossing walkers for `ticks`; checksums every `EVERY` ticks and the walkers' totals.
fn crossing(setup: Setup, ticks: u64) -> (Vec<String>, Vec<Totals>) {
    let mut runtime = runtime(Setup { crossing: true, ..setup });
    let mut checksums = Vec::new();
    for tick in 1..=ticks {
        runtime.step(FIXED_STEP_MS);
        if tick % EVERY == 0 {
            checksums.push(runtime.checksum());
        }
    }
    let sim = runtime.sim();
    let totals = sim.world.walkers.iter().map(|w| (w.moved, w.rooted, sim.nav.status(w.agent))).collect();
    (checksums, totals)
}

#[test]
fn root_motion_moves_the_capsule_while_nav_steers() {
    let (_, rooted) = crossing(Setup { root_share: Some(1.0), ..Setup::default() }, CROSSING_TICKS);
    for (index, (moved, clip, status)) in rooted.iter().enumerate() {
        assert_eq!(*status, Some(NavStatus::Arrived), "walker {index} arrives steered by nav, moved by the clip");
        assert!(*moved > 25.0, "walker {index} crossed the course ({moved} m)");
        assert!(*moved <= *clip + 1.0e-3, "walker {index}: the capsule moved {moved} m, the clip asked {clip} m");
    }
    let (_, held) = crossing(Setup { root_share: Some(1.0), hold_idle: true, ..Setup::default() }, 600);
    for (index, (moved, clip, _)) in held.iter().enumerate() {
        assert!(*clip < 1.0e-3 && *moved < 1.0e-3, "walker {index}: an idle clip gives no root motion, so no move ({moved} m)");
    }
}

#[test]
fn the_same_agent_slice_gives_the_same_result_in_the_documented_order() {
    let (first, totals) = crossing(Setup::default(), CROSSING_TICKS);
    let (second, _) = crossing(Setup::default(), CROSSING_TICKS);
    assert_eq!(first, second, "the same slice in the documented order replays");
    for (index, (_, _, status)) in totals.iter().enumerate() {
        assert_eq!(*status, Some(NavStatus::Arrived), "walker {index} arrives");
    }
    let (reversed, _) = crossing(Setup { reversed: true, ..Setup::default() }, CROSSING_TICKS);
    let (reversed_again, _) = crossing(Setup { reversed: true, ..Setup::default() }, CROSSING_TICKS);
    assert_eq!(reversed, reversed_again, "another slice order replays too");
    // Every capsule's body moves at the runtime's physics step, after `on_update`, so no drive in
    // a tick sees another's move from the same tick: the slice order cannot change the result.
    assert_eq!(first, reversed, "the slice order does not change the result");
}

#[test]
fn the_parity_record_is_byte_identical_twice() {
    let record = || {
        let (checksums, totals) = crossing(Setup::default(), 1200);
        let bits: Vec<_> = totals.iter().map(|(moved, rooted, _)| json!([moved.to_bits(), rooted.to_bits()])).collect();
        json!({ "format": "genex-nav-character-parity/1", "checksums": checksums, "totals_bits": bits }).to_string()
    };
    let first = record();
    assert_eq!(first, record(), "two runs give the same bytes");
    println!("parity digest {}", hex64(fnv1a64(first.as_bytes())));
    if let Some(path) = std::env::var_os("GENEX_NAV_PARITY_OUT") {
        std::fs::write(path, &first).expect("the parity record writes");
    }
}

#[test]
fn a_character_standing_on_the_baked_floor_is_on_the_mesh() {
    // Recast's polygons sit up to the climb above the ground they were cut from (heights round up
    // to whole cells); feet on that ground are on the mesh, not off it.
    let mut runtime = runtime(Setup { crossing: true, hold_idle: true, ..Setup::default() });
    for _ in 0..3 {
        runtime.step(FIXED_STEP_MS);
    }
    let sim = runtime.sim();
    for (index, walker) in sim.world.walkers.iter().enumerate() {
        let ground = sim.nav.closest_point(walker.character.feet(), 1.0).expect("the mesh is near").position;
        assert!(ground.y > walker.character.feet().y, "walker {index}: the polygons sit above the feet ({} over {})", ground.y, walker.character.feet().y);
        assert_eq!(sim.nav.status(walker.agent), Some(NavStatus::Moving), "walker {index} stands on the mesh and walks");
    }
}
