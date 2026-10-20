//! NAV-12: agents, links, bodies, obstacles, queries, the probe and saves on `Nav` (new
//! behaviour: `agents_api.rs` was a stub).
//!
//! - A 600-tick crowd (32 agents, a ladder, a door shut and opened, a carved crate, a rolling
//!   barrel and a player body) replayed twice, and again after another seed, gives equal agent
//!   digests and probes every 60 ticks.
//! - A snapshot at tick 300, written as JSON text, read back and restored onto a nav rebuilt from
//!   the same inputs, replays ticks 300-600 exactly as the uninterrupted run.
//! - An unknown or removed id answers `false` or `None` from every call, never a panic.
//! - `random_point` draws one `unit()` per polygon its search visits and two for the point.
//! - The probe stays under 512 bytes of JSON for 1,024 agents; the 1,025th is refused.
//! - A hostile snapshot is refused `nav-input-invalid` with the nav unchanged.

use genex_core::json::{self, Value};
use genex_core::rng::{GameRng, Pcg32};
use genex_nav::agents_api::{NAV_AGENTS_MAX, NavAgent, NavBody, NavStatus, NavStep};
use genex_nav::error::NavErrorCode;
use genex_nav::filter::NavFilter;
use genex_nav::links::{NavLink, NavLinkKind};
use genex_nav::{AgentId, Nav, NavArea, NavConfig, NavInput, NavMesh, NavObstacle};
use glam::{Mat4, Quat, Vec3, vec3};

const DT: f32 = 1.0 / 60.0;
const AGENTS: usize = 32;
const TICKS: u32 = 600;
const SAVE_TICK: u32 = 300;
const LADDER_FOOT: Vec3 = vec3(6.0, 0.0, 15.0);
const LADDER_TOP: Vec3 = vec3(6.0, 3.0, 21.0);

fn walker() -> NavConfig {
    NavConfig::walker(0.4, 1.8).with_tile(8.0)
}

/// A flat quad from (x0, z0) to (x1, z1) at height y, facing up.
fn quad(input: NavInput, (x0, z0, x1, z1): (f32, f32, f32, f32), y: f32, area: NavArea) -> NavInput {
    let vertices = [vec3(x0, y, z0), vec3(x1, y, z0), vec3(x1, y, z1), vec3(x0, y, z1)];
    input.with_triangles(&vertices, &[0, 2, 1, 0, 3, 2], area).expect("a quad")
}

/// Room A and room B joined by a doorway of the DOOR area, and a deck 3 m up over room A's far
/// side, reached by a ladder.
fn scene_input() -> NavInput {
    let input = quad(NavInput::new(), (0.0, 0.0, 16.0, 16.0), 0.0, NavArea::WALK);
    let input = quad(input, (16.0, 6.0, 18.0, 10.0), 0.0, NavArea::DOOR);
    let input = quad(input, (18.0, 0.0, 34.0, 16.0), 0.0, NavArea::WALK);
    quad(input, (2.0, 20.0, 10.0, 26.0), 3.0, NavArea::WALK)
}

/// A nav over the scene with its ladder: what a reset builds, and what a restore rebuilds first.
fn scene_nav() -> Nav {
    let mesh = NavMesh::bake(&scene_input(), &walker()).expect("the scene bakes");
    let mut nav = Nav::new(&walker());
    nav.add_mesh(&mesh).expect("the tiles");
    nav.update(DT);
    // The ends go onto the mesh as baked (heights come in cell-height steps).
    let foot = nav.closest_point(LADDER_FOOT, 1.0).expect("room A under the ladder").position;
    let top = nav.closest_point(LADDER_TOP, 1.0).expect("the deck at the ladder").position;
    nav.add_link(NavLink::between(foot, top, NavLinkKind::Ladder).both_ways()).expect("the ladder");
    // Queries read the mesh as of the last update.
    nav.update(DT);
    nav
}

/// The game state the crowd keeps beside the nav.
#[derive(Clone)]
struct Crowd {
    rng: Pcg32,
    agents: Vec<AgentId>,
    climbing: Vec<Option<(Vec3, u32)>>,
    player: genex_nav::NavBodyId,
    barrel: genex_nav::NavObstacleId,
}

fn random_target(nav: &Nav, rng: &mut Pcg32) -> Vec3 {
    let around = if rng.below(4) == 0 { vec3(6.0, 3.0, 23.0) } else { vec3(17.0, 0.0, 8.0) };
    nav.random_point(rng, around, 30.0, &NavFilter::new()).map_or(around, |point| point.position)
}

fn start_crowd(nav: &mut Nav, seed: u64) -> Crowd {
    let mut rng = Pcg32::new(seed, 54);
    let mut agents = Vec::with_capacity(AGENTS);
    for _ in 0..AGENTS {
        let start = nav.random_point(&mut rng, vec3(17.0, 0.0, 8.0), 30.0, &NavFilter::new()).expect("a start").position;
        let agent = nav.add_agent(NavAgent::new(start).with_speed(1.4 + rng.unit() * 0.4, 2.4)).expect("an agent");
        let target = random_target(nav, &mut rng);
        nav.move_to(agent, target);
        agents.push(agent);
    }
    let player = nav.add_body(NavBody { position: vec3(8.0, 0.0, 8.0), velocity: Vec3::ZERO, radius: 0.5 }).expect("the player");
    let barrel = nav.add_obstacle(NavObstacle::Avoid { position: vec3(26.0, 0.0, 2.0), radius: 0.6 }).expect("the barrel");
    Crowd { rng, agents, climbing: vec![None; AGENTS], player, barrel }
}

/// One tick of the crowd's game: scripted events, then the nav, then the movers.
fn tick(nav: &mut Nav, crowd: &mut Crowd, tick: u32) {
    match tick {
        100 => {
            let crate_box = Mat4::from_scale_rotation_translation(vec3(2.0, 1.0, 2.0), Quat::IDENTITY, vec3(26.0, 0.5, 8.0));
            nav.add_obstacle(NavObstacle::CarveBox { transform: crate_box }).expect("the crate");
        }
        200 => assert!(nav.set_area_open(NavArea::DOOR, false), "the door shuts"),
        400 => assert!(nav.set_area_open(NavArea::DOOR, true), "the door opens"),
        _ => {}
    }
    let sweep = ((tick % 240) as f32 / 30.0 - 4.0).abs();
    let player = vec3(4.0 + sweep * 2.0, 0.0, 8.0);
    nav.set_body(crowd.player, player, Vec3::ZERO);
    nav.move_obstacle(crowd.barrel, NavObstacle::Avoid { position: vec3(26.0, 0.0, 2.0 + (tick % 240) as f32 * 0.05), radius: 0.6 });
    nav.update(DT);
    for index in 0..crowd.agents.len() {
        move_agent(nav, crowd, index, tick);
    }
}

fn move_agent(nav: &mut Nav, crowd: &mut Crowd, index: usize, tick: u32) {
    let agent = crowd.agents[index];
    if let Some((end, done)) = crowd.climbing[index] {
        if tick >= done {
            nav.set_position(agent, end, Vec3::ZERO);
            assert!(nav.finish_link(agent), "the climb ends");
            crowd.climbing[index] = None;
        }
        return;
    }
    match nav.status(agent).expect("a live agent") {
        NavStatus::AtLink => {
            let link = nav.take_link(agent).expect("the link it reached");
            assert_eq!(link.kind, NavLinkKind::Ladder);
            crowd.climbing[index] = Some((link.end, tick + 45));
        }
        NavStatus::Arrived | NavStatus::NoPath | NavStatus::TargetOffMesh | NavStatus::Idle => {
            let target = random_target(nav, &mut crowd.rng);
            nav.move_to(agent, target);
        }
        _ => {
            let velocity = nav.desired_velocity(agent);
            let position = nav.position(agent).expect("a live agent") + velocity * DT;
            nav.set_position(agent, position, velocity);
        }
    }
}

/// (tick, agents digest, probe text) every 60 ticks.
type Trace = Vec<(u32, u64, String)>;

fn record(nav: &Nav, tick: u32, trace: &mut Trace) {
    if tick.is_multiple_of(60) {
        trace.push((tick, nav.agents_digest(), String::from_utf8(nav.probe().dump()).expect("utf-8")));
    }
}

fn run(seed: u64) -> Trace {
    let mut nav = scene_nav();
    let mut crowd = start_crowd(&mut nav, seed);
    let mut trace = Trace::new();
    for t in 1..=TICKS {
        tick(&mut nav, &mut crowd, t);
        record(&nav, t, &mut trace);
    }
    trace
}

#[test]
fn the_crowd_replays_bit_for_bit_and_after_another_seed() {
    let first = run(1);
    let probe_at_end: Value = json::parse(first.last().expect("a trace").2.as_bytes()).expect("json");
    assert_eq!(probe_at_end.get("agents").map(Value::as_f64), Some(AGENTS as f64));
    assert_eq!(probe_at_end.get("obstacles").map(Value::as_f64), Some(2.0), "{probe_at_end:?}");
    assert_eq!(probe_at_end.get("pending").map(Value::as_f64), Some(0.0), "the crate settled");
    let distinct: std::collections::BTreeSet<u64> = first.iter().map(|(_, digest, _)| *digest).collect();
    assert!(distinct.len() > 5, "the agents moved: {distinct:?}");
    assert_eq!(run(1), first, "seed 1 twice");
    assert_ne!(run(2), first, "seed 2 is another crowd");
    assert_eq!(run(1), first, "seed 1 after seed 2");
}

#[test]
fn some_agents_climb_the_ladder_and_the_door_reroutes_or_stops_them() {
    let mut nav = scene_nav();
    let mut crowd = start_crowd(&mut nav, 1);
    let in_door = |nav: &Nav, agent: AgentId| nav.position(agent).is_some_and(|p| (16.0..18.0).contains(&p.x) && (6.0..10.0).contains(&p.z));
    let (mut climbs, mut entered_shut_door, mut entered_open_door) = (0, 0, 0);
    for t in 1..=TICKS {
        let before: Vec<bool> = crowd.agents.iter().map(|agent| in_door(&nav, *agent)).collect();
        tick(&mut nav, &mut crowd, t);
        climbs += crowd.climbing.iter().filter(|climb| climb.is_some_and(|(_, done)| done == t + 45)).count();
        let entered = crowd.agents.iter().zip(before).filter(|(agent, was)| !was && in_door(&nav, **agent)).count();
        // The tick the door shuts, agents already heading in search again at that update.
        if (202..400).contains(&t) {
            entered_shut_door += entered;
        } else {
            entered_open_door += entered;
        }
    }
    assert!(climbs > 0, "an agent took the ladder");
    assert!(entered_open_door > 0, "agents walk through the open door");
    assert_eq!(entered_shut_door, 0, "nobody steps into the shut door");
}

#[test]
fn a_snapshot_restored_onto_a_rebuilt_nav_replays_the_uninterrupted_run() {
    let uninterrupted = run(1);
    let mut nav = scene_nav();
    let mut crowd = start_crowd(&mut nav, 1);
    let mut trace = Trace::new();
    for t in 1..=SAVE_TICK {
        tick(&mut nav, &mut crowd, t);
        record(&nav, t, &mut trace);
    }
    let text = nav.snapshot().dump();
    let snapshot = json::parse(&text).expect("the snapshot reads back as JSON");
    let mut restored = scene_nav();
    restored.restore(&snapshot).expect("restores onto the rebuilt nav");
    assert_eq!(restored.agents_digest(), nav.agents_digest(), "the agents are back bit for bit");
    assert_eq!(restored.snapshot().dump(), text, "and snapshot the same");
    drop(nav);
    for t in SAVE_TICK + 1..=TICKS {
        tick(&mut restored, &mut crowd, t);
        record(&restored, t, &mut trace);
    }
    assert_eq!(trace, uninterrupted, "restore then replay equals the uninterrupted run");
}

#[test]
fn a_hostile_snapshot_is_refused_with_the_nav_unchanged() {
    let mut nav = scene_nav();
    let crowd = start_crowd(&mut nav, 3);
    nav.update(DT);
    let good = nav.snapshot();
    let before = nav.snapshot().dump();
    let mut other_version = good.clone();
    other_version.set("version", Value::from(99u32));
    let mut no_agents = good.clone();
    no_agents.set("agents", Value::Null);
    let mut bad_float = good.clone();
    bad_float.set("bodies", json::parse(br#"{"generations":[0],"free":[],"live":[["0000000000000000",[0,0,0,0,0,0,2143289344]]]}"#).expect("json"));
    let mut bad_layout = good.clone();
    bad_layout.set("bodies", json::parse(br#"{"generations":[0],"free":[0],"live":[["0000000000000000",[0,0,0,0,0,0,1065353216]]]}"#).expect("json"));
    let mut bad_queue = good.clone();
    bad_queue.set("queue", json::parse(br#"["00000000ffffffff"]"#).expect("json"));
    let mut bad_obstacle = good.clone();
    bad_obstacle.set("obstacles", json::parse(br#"[{"id":"0000000000000000","kind":"avoid","shape":[0,0,0,3212836864]}]"#).expect("json"));
    let empty = Nav::new(&walker()).snapshot();
    for (name, hostile) in [
        ("a number", Value::from(1u32)),
        ("another version", other_version),
        ("no agents", no_agents),
        ("a NaN radius", bad_float),
        ("a slot both live and free", bad_layout),
        ("a queue of a dead agent", bad_queue),
        ("a negative obstacle radius", bad_obstacle),
        ("another nav's tiles", empty),
    ] {
        let refused = nav.restore(&hostile).expect_err(name);
        assert_eq!(refused.code, NavErrorCode::InputInvalid, "{name}: {refused:?}");
        assert_eq!(nav.snapshot().dump(), before, "{name}: nothing changed");
    }
    assert_eq!(nav.agent_count(), crowd.agents.len());
}

#[test]
fn an_unknown_or_removed_id_answers_false_or_none_everywhere() {
    let mut nav = scene_nav();
    let crowd = start_crowd(&mut nav, 1);
    let removed = crowd.agents[3];
    assert!(nav.remove_agent(removed));
    let mut other = scene_nav();
    let other_crowd = start_crowd(&mut other, 1);
    let link = other.links().next().expect("a link");
    assert!(other.remove_link(link));
    let stranger = nav.add_agent(NavAgent::new(vec3(4.0, 0.0, 4.0))).expect("an agent");
    // An id another nav handed out past every slot this one has.
    let mut unknown = other_crowd.agents[0];
    for _ in 0..8 {
        unknown = other.add_agent(NavAgent::new(vec3(4.0, 0.0, 4.0))).expect("an agent");
    }
    nav.update(DT);
    for id in [removed, unknown] {
        assert!(!nav.remove_agent(id));
        assert!(!nav.move_to(id, Vec3::ONE));
        assert!(!nav.stop(id));
        assert!(!nav.set_position(id, Vec3::ONE, Vec3::ZERO));
        assert_eq!(nav.desired_velocity(id), Vec3::ZERO);
        assert_eq!((nav.position(id), nav.target(id), nav.status(id), nav.next_corner(id)), (None, None, None, None));
        assert_eq!(nav.take_link(id), None);
        assert!(!nav.finish_link(id));
    }
    assert_ne!(stranger, removed, "a removed id stays dead: its slot comes back with a new generation");
    let dead_link = nav.links().next().expect("the ladder");
    assert!(nav.remove_link(dead_link));
    let foot = nav.closest_point(LADDER_FOOT, 1.0).expect("room A").position;
    let top = nav.closest_point(LADDER_TOP, 1.0).expect("the deck").position;
    let again = nav.add_link(NavLink::between(foot, top, NavLinkKind::Ladder)).expect("the ladder again");
    assert_ne!(again, dead_link, "a removed link id stays dead");
    assert_eq!(nav.link_open(again), Some(true));
    assert!(!nav.remove_link(dead_link));
    assert!(!nav.set_link_open(dead_link, false));
    assert_eq!(nav.link_open(dead_link), None);
    assert!(nav.remove_body(crowd.player));
    assert!(!nav.remove_body(crowd.player));
    assert!(!nav.set_body(crowd.player, Vec3::ONE, Vec3::ZERO));
    assert_eq!(nav.body(crowd.player), None);
    assert!(nav.remove_obstacle(crowd.barrel));
    assert!(!nav.remove_obstacle(crowd.barrel));
    assert!(!nav.move_obstacle(crowd.barrel, NavObstacle::Avoid { position: Vec3::ZERO, radius: 1.0 }));
    // Hostile values on live ids change nothing.
    let live = crowd.agents[0];
    let at = nav.position(live);
    assert!(!nav.set_position(live, Vec3::NAN, Vec3::ZERO));
    assert!(!nav.move_to(live, vec3(f32::INFINITY, 0.0, 0.0)));
    assert_eq!(nav.position(live), at);
}

/// A rng that counts its draws.
struct Counting(Pcg32, u32);

impl GameRng for Counting {
    fn next_u32(&mut self) -> u32 {
        self.1 += 1;
        self.0.next_u32()
    }
    fn below(&mut self, bound: u32) -> u32 {
        self.1 += 1;
        self.0.below(bound)
    }
    fn unit(&mut self) -> f32 {
        self.1 += 1;
        self.0.unit()
    }
    fn range_f32(&mut self, lo: f32, hi: f32) -> f32 {
        self.1 += 1;
        self.0.range_f32(lo, hi)
    }
}

#[test]
fn random_point_draws_one_per_visited_polygon_and_two_for_the_point() {
    let nav = scene_nav();
    for (around, radius) in [(vec3(4.0, 0.0, 4.0), 2.0), (vec3(8.0, 0.0, 8.0), 6.0), (vec3(17.0, 0.0, 8.0), 30.0)] {
        let mut counting = Counting(Pcg32::new(7, 54), 0);
        let point = nav.random_point(&mut counting, around, radius, &NavFilter::new()).expect("a point");
        let visited = nav.archipelago().random_point(&mut Pcg32::new(7, 54), around, radius, 1.8, &NavFilter::new()).expect("a point").visited;
        assert_eq!(counting.1 as usize, visited + 2, "around {around} r {radius}");
        assert_ne!(point.area, NavArea::NONE);
        assert!(nav.closest_point(point.position, 0.1).is_some(), "{point:?} is on the mesh");
    }
    let mut counting = Counting(Pcg32::new(7, 54), 0);
    assert_eq!(nav.random_point(&mut counting, vec3(100.0, 0.0, 100.0), 5.0, &NavFilter::new()), None);
    assert_eq!(counting.1, 0, "off the mesh: no draw");
    let mut pcg = Pcg32::new(9, 54);
    let first = nav.random_point(&mut pcg, vec3(8.0, 0.0, 8.0), 6.0, &NavFilter::new());
    let mut pcg = Pcg32::new(9, 54);
    assert_eq!(nav.random_point(&mut pcg, vec3(8.0, 0.0, 8.0), 6.0, &NavFilter::new()), first, "the same draws give the same point");
}

#[test]
fn queries_answer_on_the_scene() {
    let mut nav = scene_nav();
    let deck = nav.closest_point(vec3(6.0, 3.0, 23.0), 1.0).expect("the deck").position;
    let floor = nav.closest_point(vec3(4.0, 0.0, 4.0), 1.0).expect("room A").position;
    let path = nav.path(floor, deck, &NavFilter::new()).expect("a path up the ladder");
    assert!(path.steps.iter().any(|step| matches!(step, NavStep::Link(link) if link.kind == NavLinkKind::Ladder)), "{path:?}");
    let no_ladder = NavFilter::new().with_links(&[NavLinkKind::Jump]);
    let blocked = nav.path(floor, deck, &no_ladder);
    assert!(blocked.as_ref().is_none_or(|path| path.partial), "{blocked:?}");
    let across = nav.path(vec3(4.0, 0.0, 8.0), vec3(30.0, 0.0, 8.0), &NavFilter::new()).expect("through the door");
    assert!(across.length >= 26.0 && !across.partial, "{across:?}");
    nav.set_area_open(NavArea::DOOR, false);
    nav.update(DT);
    let shut = nav.path(vec3(4.0, 0.0, 8.0), vec3(30.0, 0.0, 8.0), &NavFilter::new());
    assert!(shut.as_ref().is_none_or(|path| path.partial), "the shut door parts the rooms: {shut:?}");
    let ray = nav.raycast(vec3(4.0, 0.0, 8.0), vec3(4.0, 0.0, -10.0), &NavFilter::new()).expect("a ray");
    assert!(ray.blocked && ray.fraction < 1.0, "the room's wall stops it: {ray:?}");
    let slid = nav.move_along(vec3(4.0, 0.0, 8.0), vec3(4.0, 0.0, -10.0), &NavFilter::new()).expect("a slide");
    assert!(slid.position.z >= 0.0, "kept on the mesh: {slid:?}");
    let wall = nav.distance_to_wall(vec3(1.0, 0.0, 8.0), 3.0).expect("a wall near the edge");
    assert!(wall < 1.0, "{wall}");
    assert_eq!(nav.distance_to_wall(vec3(8.0, 0.0, 8.0), 1.0), None, "no wall within a metre of the middle");
    assert_eq!(nav.closest_point(vec3(100.0, 0.0, 100.0), 1.0), None);
}

#[test]
fn next_corner_status_and_freeze_off_the_mesh() {
    let mut nav = scene_nav();
    let agent = nav.add_agent(NavAgent::new(vec3(4.0, 0.0, 4.0))).expect("an agent");
    assert_eq!(nav.status(agent), Some(NavStatus::Idle));
    nav.move_to(agent, vec3(30.0, 0.0, 8.0));
    nav.update(DT);
    assert_eq!(nav.status(agent), Some(NavStatus::Moving));
    let corner = nav.next_corner(agent).expect("a corner");
    assert!(corner.x > 4.0, "{corner}");
    assert!(nav.desired_velocity(agent).length() > 1.0);
    nav.set_position(agent, vec3(100.0, 0.0, 100.0), Vec3::ZERO);
    nav.update(DT);
    assert_eq!(nav.status(agent), Some(NavStatus::OffMesh));
    assert_eq!(nav.desired_velocity(agent), Vec3::ZERO, "frozen off the mesh");
    nav.set_position(agent, vec3(4.0, 0.0, 4.0), Vec3::ZERO);
    nav.update(DT);
    assert_eq!(nav.status(agent), Some(NavStatus::Moving), "back on the mesh it walks on");
}

#[test]
fn the_probe_stays_small_for_a_full_nav_and_the_next_agent_is_refused() {
    let mut nav = scene_nav();
    for index in 0..NAV_AGENTS_MAX {
        let x = 1.0 + (index % 32) as f32 * 0.45;
        let z = 1.0 + (index / 32) as f32 * 0.45;
        nav.add_agent(NavAgent::new(vec3(x, 0.0, z))).expect("room for the agent");
    }
    nav.update(DT);
    let refused = nav.add_agent(NavAgent::new(vec3(4.0, 0.0, 4.0))).expect_err("past the cap");
    assert_eq!(refused.code, NavErrorCode::TooLarge);
    let probe = nav.probe().dump();
    assert!(probe.len() < 512, "{} bytes: {}", probe.len(), String::from_utf8_lossy(&probe));
    for (agent, code) in [
        (NavAgent::new(Vec3::NAN), NavErrorCode::InputInvalid),
        (NavAgent::new(Vec3::ZERO).with_speed(3.0, 2.0), NavErrorCode::InputInvalid),
        (NavAgent::new(Vec3::ZERO).with_radius(0.0), NavErrorCode::InputInvalid),
        (NavAgent::new(Vec3::ZERO).with_area_cost(NavArea::WATER, -1.0), NavErrorCode::CostInvalid),
    ] {
        let mut small = Nav::new(&walker());
        assert_eq!(small.add_agent(agent).expect_err("hostile").code, code);
        assert_eq!(small.agent_count(), 0);
    }
}
