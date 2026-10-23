//! The Physics page (`docs/api/physics.md`, lane PH), run on the runtime: a yard of crates on a
//! fixed ground, a wrecking ball on a rope from a kinematic trolley, a hinged door, a blast, an
//! aimed shot, CCD for a fast one, every body drawn under its own draw id, and the save section
//! that keeps each body's pose and velocities. The page's snippets are this file's code.
//!
//! A game built without physics has no Rapier: this file is not compiled then.

#![cfg(feature = "physics")]

use genex::physics::{
    Ball, ColliderBuilder, Pose, QueryFilter, Ray, RevoluteJointBuilder, RigidBody, RigidBodyBuilder, RigidBodyHandle, RopeJointBuilder,
};
use genex::prelude::*;
use genex::saves::SaveConfig;
use genex::{FIXED_STEP_MS, Runtime, View, digest};

/// The rope's length from the trolley to the wrecking ball's centre, in metres.
const ROPE: f32 = 8.0;
/// The hinge's limit either way, in radians.
const HINGE_LIMIT: f32 = 1.57;
/// The slot the save rows use.
const SLOT: &str = "yard";

/// The yard: every body the game keeps, in the order it made them.
#[derive(Default, Serialize, Deserialize)]
#[serde(crate = "genex::serde")]
struct Yard {
    crates: Vec<RigidBodyHandle>,
    trolley: Option<RigidBodyHandle>,
    ball: Option<RigidBodyHandle>,
    door: Option<RigidBodyHandle>,
    blasts: u32,
    pushed: usize,
}

impl Yard {
    /// Every body that moves, in a fixed order: what the save section writes and reads.
    fn moving(&self) -> Vec<RigidBodyHandle> {
        let mut bodies = self.crates.clone();
        bodies.extend(self.trolley.iter().chain(&self.ball).chain(&self.door));
        bodies
    }
}

/// Push every dynamic body within `radius` of `at` away from it, harder the closer it is: a change
/// of velocity of up to `strength` m/s. Answers how many bodies it pushed.
fn explode(physics: &mut PhysicsWorld, at: Vec3, radius: f32, strength: f32) -> usize {
    let near: Vec<RigidBodyHandle> = physics
        .intersect_shape(Pose::from_translation(at), &Ball::new(radius), QueryFilter::only_dynamic())
        .filter_map(|(_, collider)| collider.parent())
        .collect();
    for handle in &near {
        let Some(body) = physics.bodies.get_mut(*handle) else { continue };
        let away = body.translation() - at;
        let falloff = 1.0 - (away.length() / radius).min(1.0);
        let push = (away.normalize_or_zero() + Vec3::Y * 0.5) * strength * falloff * body.mass();
        body.apply_impulse(push, true);
    }
    near.len()
}

/// A draw id that stays with one body: its handle's slot and generation.
fn body_id(handle: RigidBodyHandle) -> u64 {
    let (slot, generation) = handle.into_raw_parts();
    u64::from(slot) | (u64::from(generation) << 32)
}

/// One body's pose and velocities: a save keeps them as plain floats, and each comes back exact.
fn body_pose(body: &RigidBody) -> [f32; 13] {
    let (at, turn, linvel, angvel) = (body.translation(), *body.rotation(), body.linvel(), body.angvel());
    [at.x, at.y, at.z, turn.x, turn.y, turn.z, turn.w, linvel.x, linvel.y, linvel.z, angvel.x, angvel.y, angvel.z]
}

/// A digest of every moving body's bits: probed, it makes the bodies part of the checksum, so a
/// load's `checksumMatch` says each body came back exactly.
fn bodies_digest(sim: &Sim<Yard>) -> String {
    let bodies = sim.world.moving().into_iter().filter_map(|handle| sim.physics.bodies.get(handle)).filter(|body| body.is_dynamic());
    let bytes: Vec<u8> = bodies.flat_map(body_pose).map(f32::to_bits).flat_map(u32::to_le_bytes).collect();
    digest::hex64(digest::fnv1a64(&bytes))
}

/// Where the trolley runs at `tick`: back and forth along x over 20 s.
fn trolley_x(tick: u64) -> f32 {
    let phase = (tick % 1200) as f32 / 600.0;
    -8.0 + 16.0 * (1.0 - (phase - 1.0).abs())
}

/// The level: the ground, `crates` crates in a wall ten wide, the trolley and its ball, the door.
fn build(sim: &mut Sim<Yard>, crates: usize) {
    let (world, physics) = sim.split();
    // A fixed ground, its top at y = 0.
    let ground = ColliderBuilder::cuboid(40.0, 0.5, 40.0).friction(0.8);
    physics.insert(RigidBodyBuilder::fixed().translation(vec3(0.0, -0.5, 0.0)), ground);
    // A wall of 1 m crates of 20 kg, ten wide, ten high, then the next row behind.
    for i in 0..crates {
        let at = vec3((i % 10) as f32 - 4.5, 0.5 + (i / 10 % 10) as f32, -6.0 - (i / 100) as f32);
        let collider = ColliderBuilder::cuboid(0.5, 0.5, 0.5).mass(20.0).friction(0.7).restitution(0.05);
        let (body, _) = physics.insert(RigidBodyBuilder::dynamic().translation(at), collider);
        world.crates.push(body);
    }
    // A kinematic trolley the game moves; a 600 kg ball hangs from it on an 8 m rope.
    let trolley = physics.insert_body(RigidBodyBuilder::kinematic_position_based().translation(vec3(-8.0, 12.0, 0.0)));
    let wrecking = RigidBodyBuilder::dynamic().translation(vec3(-8.0, 4.5, 0.0)).linear_damping(0.05);
    let (ball, _) = physics.insert(wrecking, ColliderBuilder::ball(1.0).mass(600.0).restitution(0.1));
    physics.insert_impulse_joint(trolley, ball, RopeJointBuilder::new(ROPE));
    // A door on a hinge at its left edge: it swings about +Y, at most 90 degrees either way.
    let post = physics.insert_body(RigidBodyBuilder::fixed().translation(vec3(10.0, 1.05, 0.0)));
    let (door, _) = physics.insert(RigidBodyBuilder::dynamic().translation(vec3(10.5, 1.05, 0.0)), ColliderBuilder::cuboid(0.5, 1.0, 0.05).mass(30.0));
    let hinge = RevoluteJointBuilder::new(Vec3::Y).local_anchor2(vec3(-0.5, 0.0, 0.0)).limits([-HINGE_LIMIT, HINGE_LIMIT]);
    physics.insert_impulse_joint(post, door, hinge);
    (world.trolley, world.ball, world.door) = (Some(trolley), Some(ball), Some(door));
}

/// The yard game: `B` sets off a blast in front of the wall, `F` fires at it, `D` shoves the door,
/// `S` saves and `L` loads.
fn yard(crates: usize) -> Game<Yard> {
    let mut game = Game::new(Yard::default()).title("Yard").world_size(400, 300);
    game.saves(SaveConfig::schema(1));
    game.save_world();
    game.save_section("bodies", save_bodies, load_bodies);
    game.on_reset(move |sim, _seed, _rng, _gfx| build(sim, crates));
    game.on_update(|sim, ctx| {
        if let Some(body) = sim.world.trolley.and_then(|h| sim.physics.bodies.get_mut(h)) {
            body.set_next_kinematic_translation(vec3(trolley_x(ctx.tick), 12.0, 0.0));
        }
        if ctx.keys.pressed(Key::KeyB) {
            sim.world.pushed = explode(&mut sim.physics, vec3(0.0, 1.0, -4.5), 6.0, 12.0);
            sim.world.blasts += 1;
        }
        if ctx.keys.pressed(Key::KeyF) {
            shoot(&mut sim.physics, vec3(0.0, 0.5, 6.0), vec3(0.0, 0.0, -1.0));
        }
        if ctx.keys.pressed(Key::KeyD) {
            // Shove the door's free edge.
            if let Some(body) = sim.world.door.and_then(|h| sim.physics.bodies.get_mut(h)) {
                let edge = body.translation() + vec3(0.5, 0.0, 0.0);
                body.apply_impulse_at_point(vec3(0.0, 0.0, -600.0), edge, true);
            }
        }
        if ctx.keys.pressed(Key::KeyS) {
            ctx.slots().save(SLOT, "Yard").expect("the save is queued");
        }
        if ctx.keys.pressed(Key::KeyL) {
            ctx.slots().load(SLOT).expect("the load is queued");
        }
    });
    game.on_draw(|sim, frame, _camera| {
        frame.tag("crates");
        for handle in &sim.world.crates {
            let Some(body) = sim.physics.bodies.get(*handle) else { continue };
            let at = Transform::from_translation(body.translation()).with_rotation(*body.rotation());
            frame.id(body_id(*handle)).cube(at, Color::rgb(170, 120, 70));
        }
        frame.tag("ball");
        if let Some(body) = sim.world.ball.and_then(|h| sim.physics.bodies.get(h)) {
            frame.id("wrecking-ball").sphere(body.translation(), 1.0, Color::rgb(60, 60, 70));
        }
        frame.end_id();
    });
    game.probe("pile", |sim| {
        let fallen = sim.world.crates.iter().filter(|h| sim.physics.bodies.get(**h).is_some_and(|b| b.translation().y < 0.6)).count();
        json!({ "crates": sim.world.crates.len(), "fallen": fallen })
    });
    // A load wakes every body it puts back: how many are awake is display only.
    game.probe_volatile("awake", |sim| json!(sim.physics.active_bodies().count()));
    game.probe("bodies", |sim| json!(bodies_digest(sim)));
    game
}

/// Fire along `aim` from `eye`: the first collider the ray hits is pushed at the point it was hit.
fn shoot(physics: &mut PhysicsWorld, eye: Vec3, aim: Vec3) -> Option<RigidBodyHandle> {
    let ray = Ray::new(eye, aim);
    let (handle, toi) = physics.cast_ray(&ray, 100.0, true, QueryFilter::default())?;
    let hit = ray.point_at(toi);
    let parent = physics.colliders.get(handle).and_then(|collider| collider.parent())?;
    let body = physics.bodies.get_mut(parent)?;
    body.apply_impulse_at_point(aim * 400.0, hit, true);
    Some(parent)
}

/// The save section's writer: each moving body's pose, `null` for one the game removed.
fn save_bodies(sim: &Sim<Yard>) -> Value {
    let rows: Vec<Option<[f32; 13]>> = sim.world.moving().iter().map(|handle| sim.physics.bodies.get(*handle).map(body_pose)).collect();
    json!(rows)
}

/// The save section's reader: the reset rebuilt every body where it starts; put each where it was.
fn load_bodies(sim: &mut Sim<Yard>, value: &Value, _gfx: &Gfx) -> Result<(), String> {
    let rows = Vec::<Option<[f32; 13]>>::deserialize(value).map_err(|error| error.to_string())?;
    for (handle, row) in sim.world.moving().into_iter().zip(rows) {
        let Some(f) = row else {
            sim.physics.remove_body(handle);
            continue;
        };
        let Some(body) = sim.physics.bodies.get_mut(handle) else { continue };
        body.set_position(Pose::from_parts(vec3(f[0], f[1], f[2]), Quat::from_xyzw(f[3], f[4], f[5], f[6])), true);
        body.set_linvel(vec3(f[7], f[8], f[9]), true);
        body.set_angvel(vec3(f[10], f[11], f[12]), true);
    }
    Ok(())
}

fn state_dir(name: &str) -> String {
    let dir = std::env::temp_dir().join(format!("genex-physics-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("a temp folder");
    format!("{}/", dir.to_str().expect("a UTF-8 temp path"))
}

fn runtime(crates: usize, name: &str) -> Runtime<Yard> {
    let mut rt = Runtime::new(yard(crates)).expect("the yard installs");
    rt.use_studio_saves(&state_dir(name));
    rt.seed(1);
    rt
}

fn run_to(rt: &mut Runtime<Yard>, tick: u64) {
    while rt.tick() < tick {
        rt.step(FIXED_STEP_MS);
    }
}

fn press(rt: &mut Runtime<Yard>, key: Key) {
    rt.inject(Input::key_tap(key));
    rt.step(FIXED_STEP_MS);
}

fn position(rt: &Runtime<Yard>, handle: RigidBodyHandle) -> Vec3 {
    rt.sim().physics.bodies.get(handle).expect("the body").translation()
}

#[test]
fn a_settled_wall_sleeps_and_a_blast_pushes_the_crates_near_it_away() {
    let mut rt = runtime(100, "blast");
    run_to(&mut rt, 600);
    let pile = &rt.state()["pile"];
    assert_eq!(pile["fallen"], json!(10), "the wall stands: only its bottom row is on the ground");
    let crates = rt.sim().world.crates.clone();
    let asleep = crates.iter().filter(|h| rt.sim().physics.bodies.get(**h).is_some_and(|b| b.is_sleeping())).count();
    assert_eq!(asleep, 100, "a wall at rest sleeps");
    let before: Vec<Vec3> = crates.iter().map(|h| position(&rt, *h)).collect();
    press(&mut rt, Key::KeyB);
    assert!(rt.sim().world.pushed > 0 && rt.sim().world.pushed <= 100, "pushed {}", rt.sim().world.pushed);
    run_to(&mut rt, 640);
    let moved: Vec<f32> = crates.iter().zip(&before).map(|(h, at)| (position(&rt, *h) - *at).length()).collect();
    let (near, far) = (moved[4], moved[99]); // the bottom crate beside the blast, the top corner
    assert!(near > 0.5, "the crate next to the blast flew ({near} m)");
    assert!(far < near, "farther crates move less ({far} m against {near} m)");
    run_to(&mut rt, 1200);
    assert!(rt.state()["pile"]["fallen"].as_u64().unwrap_or(0) > 10, "the wall came down");
}

#[test]
fn the_wrecking_ball_hangs_on_its_rope_from_the_moving_trolley() {
    let mut rt = runtime(0, "rope");
    for tick in [60, 300, 900] {
        run_to(&mut rt, tick);
        let world = &rt.sim().world;
        let (trolley, ball) = (world.trolley.expect("a trolley"), world.ball.expect("a ball"));
        assert!((position(&rt, trolley).x - trolley_x(tick - 1)).abs() < 1e-4, "the trolley is where the game put it");
        let length = (position(&rt, ball) - position(&rt, trolley)).length();
        assert!(length <= ROPE + 0.05, "the rope holds the ball at {length} m at tick {tick}");
    }
}

#[test]
fn the_hinged_door_swings_within_its_limits() {
    let mut rt = runtime(0, "hinge");
    run_to(&mut rt, 30);
    let door = rt.sim().world.door.expect("a door");
    let mut swung = 0.0_f32;
    for _ in 0..4 {
        // Shove the free edge hard, again and again: the hinge stops it at its limit.
        press(&mut rt, Key::KeyD);
        let to = rt.tick() + 60;
        run_to(&mut rt, to);
        let turn = *rt.sim().physics.bodies.get(door).expect("the door").rotation();
        swung = swung.max(turn.to_axis_angle().1);
    }
    assert!(swung < HINGE_LIMIT + 0.2, "the door stays inside its limit ({swung} rad)");
}

#[test]
fn an_aimed_shot_pushes_the_first_crate_it_hits_at_the_point_it_hit() {
    let mut rt = runtime(10, "aim");
    run_to(&mut rt, 120);
    let first = rt.sim().world.crates[4]; // the bottom row's crate on the aim line (x = -0.5)
    let ray = Ray::new(vec3(-0.5, 0.5, 6.0), vec3(0.0, 0.0, -1.0));
    let (hit, _) = rt.sim().physics.cast_ray(&ray, 100.0, true, QueryFilter::default()).expect("the wall");
    assert_eq!(rt.sim().physics.colliders.get(hit).and_then(|collider| collider.parent()), Some(first));
}

#[test]
fn a_fast_small_shot_passes_a_thin_moving_plank_unless_it_has_ccd() {
    for ccd in [false, true] {
        let mut physics = PhysicsWorld::default();
        physics.integration_parameters.dt = FIXED_STEP_MS as f32 / 1000.0;
        physics.gravity = Vec3::ZERO;
        let (plank, _) = physics.insert(RigidBodyBuilder::dynamic(), ColliderBuilder::cuboid(5.0, 5.0, 0.05).mass(50.0));
        let shot = RigidBodyBuilder::dynamic().translation(vec3(0.0, 0.0, 2.25)).linvel(vec3(0.0, 0.0, -90.0)).ccd_enabled(ccd);
        physics.insert(shot, ColliderBuilder::ball(0.05).density(7800.0));
        // 1.5 m a tick: without CCD the shot is at z = 0.75 then -0.75, either side of the 10 cm plank.
        for _ in 0..3 {
            physics.step();
        }
        let hit = physics.bodies.get(plank).expect("the plank").linvel().z < 0.0;
        assert_eq!(hit, ccd, "with ccd {ccd} the plank was hit: {hit}");
    }
}

#[test]
fn a_fast_shot_stops_at_a_thin_fixed_wall_without_ccd() {
    let mut physics = PhysicsWorld::default();
    physics.integration_parameters.dt = FIXED_STEP_MS as f32 / 1000.0;
    physics.insert(RigidBodyBuilder::fixed(), ColliderBuilder::cuboid(5.0, 5.0, 0.05));
    let shot = RigidBodyBuilder::dynamic().translation(vec3(0.0, 0.0, 2.25)).linvel(vec3(0.0, 0.0, -90.0));
    let (shot, _) = physics.insert(shot, ColliderBuilder::ball(0.05).density(7800.0));
    for _ in 0..2 {
        physics.step();
    }
    let z = physics.bodies.get(shot).expect("the shot").translation().z;
    assert!(z > 0.0, "a fast body sweeps fixed colliders on its own: it ends at z = {z}");
}

#[test]
fn every_crate_is_drawn_under_its_own_draw_id() {
    let mut rt = runtime(200, "draw");
    run_to(&mut rt, 10);
    let frame = rt.frame(View::Game).expect("the game view");
    let ids: std::collections::BTreeSet<_> = frame.draws().iter().filter(|d| d.tag == "crates").map(|d| d.id).collect();
    assert_eq!(ids.len(), 200, "one id per crate");
    assert!(!ids.contains(&None));
}

#[test]
fn the_bodies_section_puts_every_body_back_exactly_and_two_loads_replay_equal() {
    let mut rt = runtime(100, "save");
    run_to(&mut rt, 600);
    press(&mut rt, Key::KeyB);
    run_to(&mut rt, 620);
    press(&mut rt, Key::KeyS); // saved at the end of this tick: the crates in mid-flight
    run_to(&mut rt, 900);
    let uninterrupted = rt.checksum();
    let mut replays = Vec::new();
    for _ in 0..2 {
        press(&mut rt, Key::KeyL);
        rt.step(FIXED_STEP_MS); // the load swaps in before this tick
        let last = &rt.state()["volatile"]["saves"]["lastLoad"];
        assert_eq!(last["checksumMatch"], json!(true), "the bodies probe came back to the bit: {last}");
        run_to(&mut rt, 900);
        replays.push(rt.checksum());
    }
    assert_eq!(replays[0], replays[1], "two loads of one slot replay equal");
    // Rapier's contacts and islands are not in the save, so the replay settles its own way.
    assert_ne!(replays[0], uninterrupted, "a loaded pile is not the run that never stopped");
}

/// The cost of a pile: Rapier's step while it settles, settled (asleep) and in the two seconds after
/// a blast that wakes it, and the draw hook, for 500, 1,000 and 2,000 crates on this machine. Run
/// by hand in release: `cargo test -p genex --release --test physics -- --ignored --nocapture`.
#[test]
#[ignore = "a timing, run by hand in release"]
#[allow(clippy::disallowed_types, reason = "the timing row reads the wall clock on purpose; no simulation sees it")]
fn crate_piles_timed() {
    use std::time::Instant;
    let timed = |rt: &mut Runtime<Yard>, ticks: u64, what: &str| {
        let start = Instant::now();
        let to = rt.tick() + ticks;
        run_to(rt, to);
        let step_ms = start.elapsed().as_secs_f64() * 1000.0 / ticks as f64;
        let start = Instant::now();
        let draws = rt.frame(View::Game).expect("the game view").draws().len();
        let draw_ms = start.elapsed().as_secs_f64() * 1000.0;
        let awake = rt.state()["volatile"]["awake"].clone();
        println!("  {what}: {step_ms:.2} ms a tick, {awake} awake; on_draw {draws} draws in {draw_ms:.2} ms");
    };
    for crates in [500, 1000, 2000] {
        println!("{crates} crates:");
        let mut rt = runtime(crates, "timed");
        timed(&mut rt, 120, "settling");
        timed(&mut rt, 600, "settled");
        press(&mut rt, Key::KeyB);
        timed(&mut rt, 120, "after a blast");
    }
}
