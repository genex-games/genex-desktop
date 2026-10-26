//! The Physics page (`docs/api/physics.md`, shared physics P4) on the runtime: `sim.physics` is a
//! Genex Physics world. A yard of keyed crates on a fixed ground, a wrecking ball on a rope from a
//! kinematic trolley, a hinged door, a blast (`area_push`), an aimed shot (`ray` + `impulse`), a
//! bomb that goes off on a contact event, every body drawn under its own draw id, and the save
//! section of `export_row` / `import_row` rows. The page's snippets are this file's code.
//!
//! Also: `game.physics_world` and its install refusals, the default world, and (with the
//! deprecated `physics-raw`) a raw Rapier body beside the Genex world, each stepped once a tick.
//!
//! The GPU row is `#[ignore]`d and its name contains `metal`, one GPU row at a time:
//!
//!     node scripts/toolchains/rust-env.ts -- cargo test -p genex --test physics_api -- --ignored metal

#![cfg(feature = "physics")]

use genex::phys::{self, BodyDesc, BodyType, ColliderDesc, JointDesc, JointType, LimitsDesc, PhysicsEvent, QueryFilter, SetPoseOptions, WorldDesc};
use genex::prelude::*;
use genex::saves::SaveConfig;
use genex::{FIXED_STEP_MS, InstallErrorCode, Runtime, View, digest};

/// The rope's length from the trolley to the wrecking ball's centre, in metres.
const ROPE: f64 = 8.0;
/// The hinge's limit either way, in radians.
const HINGE_LIMIT: f64 = 1.57;
/// The slot the save rows use.
const SLOT: &str = "yard";

/// The yard: the keys of every body the game keeps, in the order it made them.
#[derive(Default, Serialize, Deserialize)]
#[serde(crate = "genex::serde")]
struct Yard {
    crates: Vec<String>,
    blasts: u32,
    pushed: usize,
    bomb_went_off: bool,
}

impl Yard {
    /// Every body that moves, in a fixed order: what the save section writes and reads.
    fn moving(&self) -> Vec<String> {
        let mut keys = self.crates.clone();
        keys.extend(["trolley", "ball", "door"].map(str::to_owned));
        keys
    }
}

/// A body with one collider of `shape` (its key "shape").
fn body(key: &str, body_type: BodyType, at: Vec3, collider: ColliderDesc) -> BodyDesc {
    BodyDesc::new(key, body_type, phys::pose(at, Quat::IDENTITY), vec![collider])
}

/// A 1 m crate of 20 kg.
fn crate_collider() -> ColliderDesc {
    ColliderDesc { mass: Some(20.0), friction: Some(0.7), restitution: Some(0.05), ..ColliderDesc::new("box", phys::cuboid(Vec3::splat(0.5))) }
}

/// Where the trolley runs at `tick`: back and forth along x over 20 s.
fn trolley_x(tick: u64) -> f32 {
    let phase = (tick % 1200) as f32 / 600.0;
    -8.0 + 16.0 * (1.0 - (phase - 1.0).abs())
}

/// Every refusal here is a bug in the level: fail loudly.
fn must(result: Result<(), phys::PhysicsFailure>) {
    if let Err(failure) = result {
        panic!("the yard was refused: {failure}");
    }
}

/// The level: the ground, `crates` crates in a wall ten wide, the trolley and its ball, the door,
/// and a bomb on the ground that goes off when anything hits it.
fn build(sim: &mut Sim<Yard>, crates: usize) {
    let (world, physics) = sim.split();
    let ground = ColliderDesc { friction: Some(0.8), ..ColliderDesc::new("slab", phys::cuboid(vec3(40.0, 0.5, 40.0))) };
    must(physics.spawn(&body("ground", BodyType::Fixed, vec3(0.0, -0.5, 0.0), ground)));
    for i in 0..crates {
        let at = vec3((i % 10) as f32 - 4.5, 0.5 + (i / 10 % 10) as f32, -6.0 - (i / 100) as f32);
        let key = format!("crate.{i:04}");
        must(physics.spawn(&body(&key, BodyType::Dynamic, at, crate_collider())));
        world.crates.push(key);
    }
    // A kinematic trolley the game moves; a 600 kg ball hangs from it on an 8 m rope.
    let hook = ColliderDesc { sensor: true, ..ColliderDesc::new("hook", phys::ball(0.2)) };
    must(physics.spawn(&body("trolley", BodyType::Kinematic, vec3(-8.0, 12.0, 0.0), hook)));
    let wrecking = ColliderDesc { mass: Some(600.0), restitution: Some(0.1), ..ColliderDesc::new("ball", phys::ball(1.0)) };
    must(physics.spawn(&BodyDesc { linear_damping: Some(0.05), ..body("ball", BodyType::Dynamic, vec3(-8.0, 4.5, 0.0), wrecking) }));
    let rope = JointDesc { limits: Some([0.0, ROPE]), ..JointDesc::new("rope", "ball", Some("trolley"), JointType::Rope, [0.0; 3], [0.0; 3]) };
    must(physics.add_joint(&rope));
    // A door on a hinge at its left edge: it swings about +Y, at most 90 degrees either way.
    must(physics.spawn(&body("post", BodyType::Fixed, vec3(10.0, 1.05, 0.0), ColliderDesc::new("pin", phys::ball(0.05)))));
    let panel = ColliderDesc { mass: Some(30.0), ..ColliderDesc::new("panel", phys::cuboid(vec3(0.5, 1.0, 0.05))) };
    must(physics.spawn(&body("door", BodyType::Dynamic, vec3(10.5, 1.05, 0.0), panel)));
    let hinge = JointDesc {
        axis: Some([0.0, 1.0, 0.0]),
        limits: Some([-HINGE_LIMIT, HINGE_LIMIT]),
        ..JointDesc::new("hinge", "door", Some("post"), JointType::Hinge, [-0.5, 0.0, 0.0], [0.0; 3])
    };
    must(physics.add_joint(&hinge));
    // A bomb that reports its contacts (`events: true`): the game sets it off on the first one.
    let charge = ColliderDesc { events: true, mass: Some(5.0), ..ColliderDesc::new("charge", phys::cuboid(Vec3::splat(0.25))) };
    must(physics.spawn(&BodyDesc { kind: Some("bomb".to_owned()), ..body("bomb", BodyType::Dynamic, vec3(-3.0, 0.25, 4.0), charge) }));
}

/// Whether the last step began a contact between the bomb and anything but the ground it rests on.
fn bomb_struck(events: &[PhysicsEvent]) -> bool {
    events.iter().any(|event| match event {
        PhysicsEvent::ContactBegin { a, b, .. } => (a == "bomb" && b != "ground") || (b == "bomb" && a != "ground"),
        _ => false,
    })
}

/// Push every dynamic body within `radius` of `at` away from it: the core's `area_push`.
fn explode(physics: &mut Physics, at: Vec3, radius: f32, strength: f32) -> usize {
    let near = physics.overlap(&phys::ball(radius), phys::pose(at, Quat::IDENTITY), &QueryFilter::default()).unwrap_or_default();
    let pushed = near.iter().filter(|key| physics.body(key).is_some_and(|body| body.body_type == BodyType::Dynamic)).count();
    must(physics.area_push(phys::xyz(at), f64::from(radius), f64::from(strength), 1.0, None));
    pushed
}

/// Fire along `aim` from `eye`: the first body the ray hits is pushed at the point it was hit.
fn shoot(physics: &mut Physics, eye: Vec3, aim: Vec3) -> Option<String> {
    let hit = physics.ray(phys::xyz(eye), phys::xyz(aim), 100.0, &QueryFilter::default()).ok()??;
    let push = phys::xyz(aim * 400.0);
    physics.impulse(&hit.body, push, Some(hit.point)).ok()?;
    Some(hit.body)
}

/// The yard game: `B` sets off a blast in front of the wall, `F` fires at it, `D` shoves the door,
/// `S` saves and `L` loads.
fn yard(crates: usize) -> Game<Yard> {
    let mut game = Game::new(Yard::default()).title("Yard").world_size(400, 300);
    game.camera(|_| Camera::look_at(vec3(0.0, 6.0, 14.0), vec3(0.0, 3.0, -6.0)));
    game.saves(SaveConfig::schema(1));
    game.save_world();
    game.save_section("bodies", save_bodies, load_bodies);
    game.on_reset(move |sim, _seed, _rng, _gfx| build(sim, crates));
    game.on_update(|sim, ctx| {
        let trolley = phys::pose(vec3(trolley_x(ctx.tick), 12.0, 0.0), Quat::IDENTITY);
        must(sim.physics.set_next_kinematic_pose("trolley", trolley));
        if bomb_struck(sim.physics.events()) && !sim.world.bomb_went_off {
            sim.world.bomb_went_off = true;
            must(sim.physics.remove("bomb"));
        }
        if ctx.keys.pressed(Key::KeyB) {
            sim.world.pushed = explode(&mut sim.physics, vec3(0.0, 1.0, -4.5), 6.0, 240.0);
            sim.world.blasts += 1;
        }
        if ctx.keys.pressed(Key::KeyF) {
            shoot(&mut sim.physics, vec3(0.0, 0.5, 6.0), vec3(0.0, 0.0, -1.0));
        }
        if ctx.keys.pressed(Key::KeyD) {
            // Shove the door's free edge.
            if let Some(door) = sim.physics.body("door") {
                let edge = phys::vec3_of(door.pose.p) + vec3(0.5, 0.0, 0.0);
                must(sim.physics.impulse("door", [0.0, 0.0, -600.0], Some(phys::xyz(edge))));
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
        for key in &sim.world.crates {
            let Some(body) = sim.physics.body(key) else { continue };
            let at = Transform::from_translation(phys::vec3_of(body.pose.p)).with_rotation(phys::quat_of(body.pose.q));
            frame.id(key).cube(at, Color::rgb(170, 120, 70));
        }
        frame.tag("ball");
        if let Some(ball) = sim.physics.body("ball") {
            frame.id("wrecking-ball").sphere(phys::vec3_of(ball.pose.p), 1.0, Color::rgb(60, 60, 70));
        }
        frame.end_id();
    });
    game.probe("pile", |sim| {
        let fallen = sim.world.crates.iter().filter(|key| sim.physics.body(key).is_some_and(|b| b.pose.p[1] < 0.6)).count();
        json!({ "crates": sim.world.crates.len(), "fallen": fallen })
    });
    // A load wakes every body it puts back: how many are awake is display only.
    game.probe_volatile("awake", |sim| json!(sim.physics.stats().awake));
    game.probe("bodies", |sim| json!(bodies_digest(sim)));
    game
}

/// A digest of every crate's position and velocity bits: equal only when each came back exactly.
/// The rotation is left out: a load renormalises it (`import_body_state`), which can move its last
/// bit.
fn bodies_digest(sim: &Sim<Yard>) -> String {
    let mut numbers: Vec<f32> = Vec::new();
    for row in sim.world.crates.iter().filter_map(|key| sim.physics.export_row(key)) {
        numbers.extend(&row[..3]);
        numbers.extend(&row[7..]);
    }
    let bytes: Vec<u8> = numbers.into_iter().map(f32::to_bits).flat_map(u32::to_le_bytes).collect();
    digest::hex64(digest::fnv1a64(&bytes))
}

/// The save section's writer: each moving body's row, `null` for one the game removed.
fn save_bodies(sim: &Sim<Yard>) -> Value {
    let rows: Vec<Option<[f32; phys::BODY_ROW_LEN]>> = sim.world.moving().iter().map(|key| sim.physics.export_row(key)).collect();
    json!(rows)
}

/// The save section's reader: the reset rebuilt every body where it starts; put each where it was.
fn load_bodies(sim: &mut Sim<Yard>, value: &Value, _gfx: &Gfx) -> Result<(), String> {
    let rows = Vec::<Option<[f32; phys::BODY_ROW_LEN]>>::deserialize(value).map_err(|error| error.to_string())?;
    for (key, row) in sim.world.moving().into_iter().zip(rows) {
        let Some(row) = row else {
            let _ = sim.physics.remove(&key); // gone when it was saved
            continue;
        };
        sim.physics.import_row(&key, &row).map_err(|failure| failure.to_string())?;
    }
    Ok(())
}

fn state_dir(name: &str) -> String {
    let dir = std::env::temp_dir().join(format!("genex-physics-api-{name}-{}", std::process::id()));
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

fn position(rt: &Runtime<Yard>, key: &str) -> Vec3 {
    phys::vec3_of(rt.sim().physics.body(key).expect("the body").pose.p)
}

#[test]
fn a_settled_wall_sleeps_and_a_blast_pushes_the_crates_near_it_away() {
    let mut rt = runtime(100, "blast");
    run_to(&mut rt, 600);
    assert_eq!(rt.state()["pile"]["fallen"], json!(10), "the wall stands: only its bottom row is on the ground");
    let crates = rt.sim().world.crates.clone();
    let asleep = crates.iter().filter(|key| rt.sim().physics.body(key).is_some_and(|b| b.sleeping)).count();
    assert_eq!(asleep, 100, "a wall at rest sleeps");
    let before: Vec<Vec3> = crates.iter().map(|key| position(&rt, key)).collect();
    press(&mut rt, Key::KeyB);
    assert!(rt.sim().world.pushed > 0 && rt.sim().world.pushed <= 100, "pushed {}", rt.sim().world.pushed);
    run_to(&mut rt, 640);
    let moved: Vec<f32> = crates.iter().zip(&before).map(|(key, at)| (position(&rt, key) - *at).length()).collect();
    let (near, far) = (moved[4], moved[99]); // the bottom crate beside the blast, the top corner
    assert!(near > 0.5, "the crate next to the blast flew ({near} m)");
    assert!(far < near, "farther crates move less ({far} m against {near} m)");
}

#[test]
fn the_wrecking_ball_hangs_on_its_rope_from_the_moving_trolley() {
    let mut rt = runtime(0, "rope");
    for tick in [60, 300, 900] {
        run_to(&mut rt, tick);
        assert!((position(&rt, "trolley").x - trolley_x(tick - 1)).abs() < 1e-4, "the trolley is where the game put it");
        let length = (position(&rt, "ball") - position(&rt, "trolley")).length();
        assert!(f64::from(length) <= ROPE + 0.05, "the rope holds the ball at {length} m at tick {tick}");
    }
}

#[test]
fn the_hinged_door_swings_within_its_limits() {
    let mut rt = runtime(0, "hinge");
    run_to(&mut rt, 30);
    let mut swung = 0.0_f32;
    for _ in 0..4 {
        press(&mut rt, Key::KeyD);
        let to = rt.tick() + 60;
        run_to(&mut rt, to);
        let turn = phys::quat_of(rt.sim().physics.body("door").expect("the door").pose.q);
        swung = swung.max(turn.to_axis_angle().1);
    }
    assert!(swung > 0.1, "the shove swung the door ({swung} rad)");
    assert!(f64::from(swung) < HINGE_LIMIT + 0.2, "the door stays inside its limit ({swung} rad)");
}

#[test]
fn an_aimed_shot_hits_the_first_crate_on_its_line() {
    let mut rt = runtime(10, "aim");
    run_to(&mut rt, 120);
    let hit = rt.sim_mut().physics.ray([-0.5, 0.5, 6.0], [0.0, 0.0, -1.0], 100.0, &QueryFilter::default()).expect("a query").expect("the wall");
    assert_eq!(hit.body, "crate.0004", "the bottom row's crate on the aim line (x = -0.5)");
}

#[test]
fn a_contact_event_sets_the_bomb_off() {
    let mut rt = runtime(0, "bomb");
    run_to(&mut rt, 30);
    assert!(!rt.sim().world.bomb_went_off, "a bomb resting on the ground stays");
    let rock = body("rock", BodyType::Dynamic, vec3(-3.0, 3.0, 4.0), ColliderDesc::new("stone", phys::ball(0.3)));
    rt.sim_mut().physics.spawn(&rock).expect("a rock above the bomb");
    run_to(&mut rt, 120);
    assert!(rt.sim().world.bomb_went_off, "the falling rock's contact with the bomb set it off");
    assert!(rt.sim().physics.body("bomb").is_none(), "the bomb is gone");
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
}

#[test]
fn two_runs_of_one_seed_hash_equal_every_step() {
    let mut a = runtime(30, "det-a");
    let mut b = runtime(30, "det-b");
    for tick in [1, 60, 240] {
        run_to(&mut a, tick);
        run_to(&mut b, tick);
        assert_eq!(a.sim().physics.state_hash_hex(), b.sim().physics.state_hash_hex(), "tick {tick}");
        assert_eq!(a.sim().physics.tick(), tick, "one physics step a tick");
    }
}

#[test]
fn a_seed_starts_from_an_empty_default_world() {
    let mut rt = runtime(3, "seed");
    run_to(&mut rt, 10);
    rt.seed(2);
    let stats = rt.sim().physics.stats();
    assert_eq!(stats.tick, 0);
    let desc = rt.sim().physics.desc();
    assert_eq!((desc.dt, desc.substeps), ((FIXED_STEP_MS / 1000.0) as f32, 1), "the fixed tick, one sub-step");
    assert_eq!(desc.gravity, [0.0, -9.81, 0.0], "y-up gravity");
    assert_eq!(stats.bodies, 3 + 6, "the reset rebuilt the yard: 3 crates, ground, trolley, ball, post, door, bomb, and nothing else");
}

#[test]
fn physics_world_sets_the_limits_and_gravity_every_seed_starts_from() {
    let mut game = yard(0);
    let desc = WorldDesc {
        limits: LimitsDesc { joints: Some(256.0), ..LimitsDesc::default() },
        ..WorldDesc::new(FIXED_STEP_MS / 1000.0, 2.0, [0.0, -20.0, 0.0], phys::UpAxis::Y, 1.0)
    };
    game.physics_world(desc);
    let mut rt = Runtime::new(game).expect("installs");
    rt.seed(1);
    let resolved = rt.sim().physics.desc();
    assert_eq!((resolved.substeps, resolved.gravity[1], resolved.limits.joints), (2, -20.0, 256));
}

#[test]
fn physics_world_is_refused_twice_or_at_another_tick_or_out_of_range() {
    let fixed = || WorldDesc::new(FIXED_STEP_MS / 1000.0, 1.0, [0.0, -9.81, 0.0], phys::UpAxis::Y, 1.0);
    let cases: [(&str, Vec<WorldDesc>, InstallErrorCode); 3] = [
        ("twice", vec![fixed(), fixed()], InstallErrorCode::DuplicatePhysicsWorld),
        ("30 Hz", vec![WorldDesc { dt: 1.0 / 30.0, ..fixed() }], InstallErrorCode::PhysicsWorldInvalid),
        ("joints past the ceiling", vec![WorldDesc { limits: LimitsDesc { joints: Some(1.0e6), ..LimitsDesc::default() }, ..fixed() }], InstallErrorCode::PhysicsWorldInvalid),
    ];
    for (name, descs, code) in cases {
        let mut game = yard(0);
        for desc in descs {
            game.physics_world(desc);
        }
        let error = Runtime::new(game).err().unwrap_or_else(|| panic!("{name}: expected {code:?}"));
        assert_eq!(error.code(), code, "{name}");
        assert_eq!(error.code().as_str(), code.as_str());
    }
}

#[test]
fn a_refused_command_changes_nothing_and_says_why() {
    let mut rt = runtime(1, "refused");
    let before = rt.sim().physics.state_hash();
    let physics = &mut rt.sim_mut().physics;
    let twice = physics.spawn(&body("crate.0000", BodyType::Dynamic, Vec3::ZERO, crate_collider())).expect_err("a key is unique");
    assert_eq!(twice.code, phys::PhysicsError::DuplicateKey);
    let unknown = physics.impulse("nobody", [0.0, 1.0, 0.0], None).expect_err("no such body");
    assert_eq!(unknown.code, phys::PhysicsError::UnknownKey);
    let fixed = physics.set_velocity("ground", Some([1.0, 0.0, 0.0]), None).expect_err("a fixed body has no velocity");
    assert_eq!(fixed.code, phys::PhysicsError::WrongBodyType);
    let nan = physics.set_pose("crate.0000", phys::Pose::at([f64::NAN, 0.0, 0.0]), SetPoseOptions::default()).expect_err("a NaN pose");
    assert_eq!(nan.code, phys::PhysicsError::NonFinite);
    assert_eq!(rt.sim().physics.state_hash(), before, "nothing changed");
}

/// The deprecated raw world beside the Genex one: a game written against Rapier keeps compiling
/// and its body falls, while the Genex world steps on its own; neither sees the other.
#[cfg(feature = "physics-raw")]
#[test]
fn a_raw_rapier_body_still_steps_beside_the_genex_world() {
    use genex::physics::{ColliderBuilder, RigidBodyBuilder};
    let mut game = Game::new(Yard::default());
    game.on_reset(|sim, _, _, _| {
        let (_, physics) = sim.split();
        physics.insert(RigidBodyBuilder::dynamic().translation(vec3(0.0, 10.0, 0.0)), ColliderBuilder::ball(0.5));
        must(physics.spawn(&body("api", BodyType::Dynamic, vec3(0.0, 10.0, 0.0), ColliderDesc::new("b", phys::ball(0.5)))));
    });
    let mut rt = Runtime::new(game).expect("installs");
    rt.seed(1);
    run_to_any(&mut rt, 30);
    let raw: &genex::PhysicsWorld = &rt.sim().physics;
    let (_, falling) = raw.bodies.iter().next().expect("the raw body");
    let api = rt.sim().physics.body("api").expect("the Genex body");
    assert!(falling.translation().y < 9.0, "the raw body fell: {}", falling.translation().y);
    assert!(api.pose.p[1] < 9.0, "the Genex body fell: {}", api.pose.p[1]);
    assert_eq!(rt.sim().physics.stats().bodies, 1, "the raw body is not in the Genex world");
}

#[cfg(feature = "physics-raw")]
fn run_to_any<W>(rt: &mut Runtime<W>, tick: u64) {
    while rt.tick() < tick {
        rt.step(FIXED_STEP_MS);
    }
}

/// A capture of the game view, BGRA.
fn capture(presenter: &mut genex::present::Presenter, rt: &mut Runtime<Yard>) -> Vec<u8> {
    presenter.set_capturing(true);
    presenter.draw_view(rt, View::Game).expect("a view").expect("drawn");
    assert_eq!(presenter.failure(), None);
    presenter.resilient.capture().expect("a capture").bgra().to_vec()
}

/// How many pixels of two captures differ by more than a few levels in any channel.
fn differing(a: &[u8], b: &[u8]) -> usize {
    a.chunks(4).zip(b.chunks(4)).filter(|(x, y)| x.iter().zip(y.iter()).any(|(p, q)| p.abs_diff(*q) > 8)).count()
}

/// The GPU row: the real renderer, headless, draws the crates where Genex Physics put them: a wall
/// of crates covers much of the view an empty yard leaves open, and a blast moves what is drawn.
#[test]
#[ignore = "a metal row: cargo test -p genex --test physics_api -- --ignored metal"]
fn metal_the_renderer_draws_the_crates_where_the_physics_put_them() {
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|value| value == "1");
    let mut presenter = match genex::present::Presenter::open([400, 300], &[]) {
        Ok(presenter) => presenter,
        Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
        Err(error) => {
            eprintln!("skipped: no WebGPU-core adapter ({error})");
            return;
        }
    };
    let mut empty = runtime(0, "metal-empty");
    run_to(&mut empty, 120);
    let mut wall = runtime(100, "metal-wall");
    run_to(&mut wall, 120);
    let (open, standing) = (capture(&mut presenter, &mut empty), capture(&mut presenter, &mut wall));
    let pixels = open.len() / 4;
    let covered = differing(&open, &standing);
    assert!(covered > pixels / 20, "the wall covers {covered} of {pixels} pixels");
    press(&mut wall, Key::KeyB);
    run_to(&mut wall, 180);
    let blown = capture(&mut presenter, &mut wall);
    let moved = differing(&standing, &blown);
    assert!(moved > pixels / 100, "the blast moved {moved} drawn pixels");
}
