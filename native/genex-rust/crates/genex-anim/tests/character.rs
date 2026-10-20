//! AN-19: the character controller. Root motion into a wall stops at it and slides along a 45°
//! wall; a 50° slope with a 45° max slides the character while a 40° one holds it; with step 0.3
//! a 0.25 m stair climbs and a 0.35 m one blocks; 3,600 ticks replay bit for bit; a snapshot at
//! tick 1,800, restored into a fresh world and replayed, equals the uninterrupted run; the
//! physics-free `drive_on` walks the same flat path as `drive` within 1e-5; `left_ground` and
//! `landed` fire on the jump's ticks; hostile parameters and snapshots are refused
//! `character-shape-invalid` with the character unchanged.
//!
//! Every row is new behaviour (section 0 of the game systems plan): the module was a stub. The
//! rows that need a Rapier world are compiled with `physics` only; the `drive_on` rows run in both
//! builds (`cargo test -p genex-anim` and `--features physics`). That the physics calls do not
//! compile without `physics` is the module's `compile_fail` doc test.

use genex_anim::character::{Character, CharacterErrorCode, CharacterMotion, CharacterParams, CharacterStep};
use genex_anim::root_motion::RootMotion;
use genex_core::json::{self, Value};
use glam::Vec3;

/// One tick of a 60 Hz game.
const TICK: f32 = 1.0 / 60.0;

/// `sin` and `cos` through glam's libm (the platform's are not the same bits everywhere).
fn sin(x: f32) -> f32 {
    glam::Vec2::from_angle(x).y
}

fn cos(x: f32) -> f32 {
    glam::Vec2::from_angle(x).x
}

fn walk(wish: Vec3) -> CharacterMotion {
    CharacterMotion::Velocity { wish, jump: false }
}

fn jump_with(wish: Vec3) -> CharacterMotion {
    CharacterMotion::Velocity { wish, jump: true }
}

/// The tick (1-based, after the jump tick 1) a jump of `speed` under `gravity` first comes back
/// to its start height, by the controller's semi-implicit rule: the jump tick rises at `speed`,
/// every later tick first loses `gravity * dt` of speed, then moves.
fn landing_tick(speed: f32, gravity: f32, dt: f32) -> (u32, f32) {
    let mut height = speed * dt;
    let mut vertical = speed;
    let mut tick = 1;
    loop {
        tick += 1;
        vertical -= gravity * dt;
        let next = height + vertical * dt;
        if next <= 0.0 {
            return (tick, height);
        }
        height = next;
    }
}

#[test]
fn drive_on_jump_leaves_the_ground_and_lands_on_the_computed_ticks() {
    let params = CharacterParams::default();
    let (expected, last_height) = landing_tick(params.jump_speed, params.gravity, TICK);
    assert!(last_height > 1.0e-3, "the row's tick count is not borderline ({last_height} m)");
    let mut character = Character::on_ground(Vec3::ZERO, params).expect("default parameters");
    let mut left = Vec::new();
    let mut landed = Vec::new();
    for tick in 1..=120u32 {
        let motion = if tick == 1 { jump_with(Vec3::ZERO) } else { walk(Vec3::ZERO) };
        let step = character.drive_on(|_, _| 0.0, motion, TICK);
        if step.left_ground {
            left.push(tick);
        }
        if step.landed {
            landed.push(tick);
        }
    }
    assert_eq!(left, vec![1], "left the ground on the jump tick only");
    assert_eq!(landed, vec![expected], "landed on the tick its fall reaches the ground");
    assert_eq!(character.feet().y, 0.0, "stands on the ground again");
}

#[test]
fn drive_on_follows_flat_ground_by_the_motion_model() {
    let params = CharacterParams::default();
    let mut character = Character::on_ground(Vec3::new(1.0, 2.0, -3.0), params).expect("default parameters");
    let wish = Vec3::new(3.0, 0.0, 4.0);
    // The model by hand: the planar velocity reaches 5 m/s at accel 24 m/s², then holds.
    let mut speed = 0.0f32;
    let mut travelled = 0.0f32;
    for _ in 0..240 {
        let step = character.drive_on(|_, _| 2.0, walk(wish), TICK);
        assert!(step.grounded && !step.sliding && !step.landed && !step.left_ground);
        speed = (speed + params.accel * TICK).min(5.0);
        travelled += speed * TICK;
    }
    let expected = Vec3::new(1.0, 2.0, -3.0) + wish.normalize() * travelled;
    assert!((character.feet() - expected).abs().max_element() < 1.0e-4, "{} vs {expected}", character.feet());
    let facing = character.facing() * Vec3::Z;
    assert!((facing - wish.normalize()).length() < 1.0e-5, "turned to face its wish: {facing}");
}

#[test]
fn drive_on_climbs_a_step_blocks_a_tall_one_and_slides_down_steep_ground() {
    let params = CharacterParams::default();
    let stairs = |rise: f32| move |_: f32, z: f32| if z > 1.0 { rise } else { 0.0 };
    for (rise, climbs) in [(0.25, true), (0.35, false)] {
        let mut character = Character::on_ground(Vec3::ZERO, params).expect("default parameters");
        for _ in 0..120 {
            character.drive_on(stairs(rise), walk(Vec3::new(0.0, 0.0, 2.0)), TICK);
        }
        let feet = character.feet();
        if climbs {
            assert!(feet.z > 2.0 && feet.y == rise, "a {rise} m step climbs: {feet}");
        } else {
            assert!(feet.z <= 1.0 && feet.y == 0.0, "a {rise} m step blocks: {feet}");
        }
    }
    for (degrees, slides) in [(50.0f32, true), (40.0f32, false)] {
        let rise = sin(degrees.to_radians()) / cos(degrees.to_radians());
        let mut character = Character::on_ground(Vec3::new(0.0, 0.0, 0.0), params).expect("default parameters");
        let mut sliding = false;
        for _ in 0..60 {
            sliding |= character.drive_on(move |_, z| z * rise, walk(Vec3::ZERO), TICK).sliding;
        }
        let feet = character.feet();
        if slides {
            assert!(sliding && feet.z < -0.2, "a {degrees}° slope slides it: {feet}");
            assert!((feet.y - feet.z * rise).abs() < 1.0e-4, "stays on the slope: {feet}");
        } else {
            assert!(!sliding && feet == Vec3::ZERO, "a {degrees}° slope holds it: {feet}");
        }
    }
}

#[test]
fn hostile_parameters_are_refused_shape_invalid() {
    let base = CharacterParams::default();
    let rows: Vec<(&str, CharacterParams)> = vec![
        ("radius 0", CharacterParams { radius: 0.0, ..base }),
        ("radius NaN", CharacterParams { radius: f32::NAN, ..base }),
        ("radius above 100", CharacterParams { radius: 101.0, height: 300.0, ..base }),
        ("height below two radii", CharacterParams { height: 0.6, ..base }),
        ("height infinite", CharacterParams { height: f32::INFINITY, ..base }),
        ("slope 0", CharacterParams { max_slope_degrees: 0.0, ..base }),
        ("slope 90", CharacterParams { max_slope_degrees: 90.0, ..base }),
        ("step negative", CharacterParams { step_height: -0.1, ..base }),
        ("step 3 m", CharacterParams { step_height: 3.0, ..base }),
        ("snap negative", CharacterParams { snap_to_ground: -1.0, ..base }),
        ("gravity negative", CharacterParams { gravity: -9.0, ..base }),
        ("jump negative", CharacterParams { jump_speed: -1.0, ..base }),
        ("accel negative", CharacterParams { accel: -1.0, ..base }),
        ("decel NaN", CharacterParams { decel: f32::NAN, ..base }),
        ("turn negative", CharacterParams { turn_rate: -1.0, ..base }),
    ];
    for (name, params) in rows {
        let refused = Character::on_ground(Vec3::ZERO, params).expect_err(name);
        assert_eq!(refused.code, CharacterErrorCode::ShapeInvalid, "{name}");
        assert_eq!(refused.code.wire(), "character-shape-invalid");
    }
    let refused = Character::on_ground(Vec3::new(f32::NAN, 0.0, 0.0), base).expect_err("NaN feet");
    assert_eq!(refused.code, CharacterErrorCode::ShapeInvalid);
    assert_eq!(CharacterErrorCode::ALL.map(CharacterErrorCode::wire), ["character-shape-invalid"]);
}

#[test]
fn hostile_motion_moves_nothing_and_never_panics() {
    let mut character = Character::on_ground(Vec3::ZERO, CharacterParams::default()).expect("default parameters");
    let hostile = [
        walk(Vec3::new(f32::NAN, 0.0, 1.0)),
        walk(Vec3::splat(f32::INFINITY)),
        CharacterMotion::Root(RootMotion { translation: Vec3::splat(f32::NAN), yaw: f32::INFINITY }),
        CharacterMotion::Mixed { root: RootMotion::ZERO, wish: Vec3::ZERO, jump: false, root_share: f32::NAN },
    ];
    for motion in hostile {
        for dt in [TICK, 0.0, -1.0, f32::NAN] {
            let step = character.drive_on(|_, _| 0.0, motion, dt);
            assert_eq!(step.moved, Vec3::ZERO, "{motion:?} at dt {dt}");
        }
    }
    assert_eq!(character.feet(), Vec3::ZERO);
    assert!(character.yaw().is_finite());
}

#[test]
fn nav_fit_names_the_controllers_climb_and_slope() {
    let params = CharacterParams { radius: 0.4, height: 2.0, step_height: 0.25, max_slope_degrees: 40.0, ..CharacterParams::default() };
    let fit = Character::on_ground(Vec3::ZERO, params).expect("valid").nav_fit();
    assert_eq!((fit.radius, fit.height, fit.climb, fit.slope_degrees), (0.4, 2.0, 0.25, 40.0));
}

#[test]
fn snapshot_restores_through_json_and_refuses_damage_unchanged() {
    let params = CharacterParams::default();
    let mut character = Character::on_ground(Vec3::ZERO, params).expect("default parameters");
    for tick in 0..90 {
        character.drive_on(|x, _| 0.1 * x, if tick == 10 { jump_with(Vec3::X) } else { walk(Vec3::new(2.0, 0.0, 1.0)) }, TICK);
    }
    let snapshot = character.snapshot();
    let text = snapshot.dump();
    let parsed = json::parse(&text).expect("the snapshot's JSON reads back");
    let mut restored = Character::on_ground(Vec3::new(9.0, 9.0, 9.0), params).expect("default parameters");
    restored.restore(&parsed).expect("a snapshot of the same parameters restores");
    assert_eq!(restored.digest(), character.digest());
    for _ in 0..60 {
        character.drive_on(|x, _| 0.1 * x, walk(Vec3::Z), TICK);
        restored.drive_on(|x, _| 0.1 * x, walk(Vec3::Z), TICK);
        assert_eq!(restored.digest(), character.digest());
    }
    let mut damaged: Vec<(&str, Value)> = Vec::new();
    damaged.push(("not an object", Value::from(3u32)));
    let mut wrong_version = snapshot.clone();
    wrong_version.set("version", Value::from(99u32));
    damaged.push(("version", wrong_version));
    let mut short_state = snapshot.clone();
    short_state.set("state", Value::Array(vec![Value::from(0u32)]));
    damaged.push(("short state", short_state));
    let mut nan_state = snapshot.clone();
    nan_state.set("state", Value::Array(vec![Value::from(f32::NAN.to_bits()); 7]));
    damaged.push(("NaN state", nan_state));
    let mut fraction = snapshot.clone();
    fraction.set("state", Value::Array(vec![Value::from(0.5f64); 7]));
    damaged.push(("fractional bits", fraction));
    let mut missing = snapshot.clone();
    missing.set("grounded", Value::Null);
    damaged.push(("grounded missing", missing));
    let other = Character::on_ground(Vec3::ZERO, CharacterParams { radius: 0.3, ..params }).expect("valid").snapshot();
    damaged.push(("other parameters", other));
    for (name, value) in damaged {
        let before = restored.clone();
        let refused = restored.restore(&value).expect_err(name);
        assert_eq!(refused.code, CharacterErrorCode::ShapeInvalid, "{name}");
        assert_eq!(restored, before, "{name}: unchanged");
    }
}

#[test]
fn step_reports_are_consistent_with_the_state() {
    let mut character = Character::on_ground(Vec3::ZERO, CharacterParams::default()).expect("default parameters");
    let step: CharacterStep = character.drive_on(|_, _| 0.0, walk(Vec3::X), TICK);
    assert_eq!(step.grounded, character.grounded());
    assert_eq!(step.moved, character.feet());
}

#[cfg(feature = "physics")]
mod physics {
    //! The Rapier rows.

    use super::{TICK, cos, jump_with, landing_tick, sin, walk};
    use genex_anim::character::{CHARACTER_SKIN, Character, CharacterMotion, CharacterParams};
    use genex_anim::root_motion::RootMotion;
    use genex_core::json;
    use glam::{Quat, Vec3};
    use rapier3d::prelude::{ColliderBuilder, PhysicsWorld, Pose};

    /// A world with a 100 m ground slab whose top is at y = 0, stepped once so queries see it.
    fn ground_world() -> PhysicsWorld {
        let mut world = PhysicsWorld::default();
        world.insert_collider(ColliderBuilder::cuboid(50.0, 0.5, 50.0).translation(Vec3::new(0.0, -0.5, 0.0)), None);
        world.step();
        world
    }

    /// One game tick: drive, then the runtime's physics step.
    fn tick(world: &mut PhysicsWorld, character: &mut Character, motion: CharacterMotion) -> genex_anim::character::CharacterStep {
        let step = character.drive(world, motion, TICK);
        world.step();
        step
    }

    fn root_forward(metres: f32) -> CharacterMotion {
        CharacterMotion::Root(RootMotion { translation: Vec3::new(0.0, 0.0, metres), yaw: 0.0 })
    }

    #[test]
    fn a_character_spawned_with_its_level_stands_on_it_from_the_first_tick() {
        // No world step between building the level and the spawn, as in a game's on_reset.
        let mut world = PhysicsWorld::default();
        world.insert_collider(ColliderBuilder::cuboid(50.0, 0.5, 50.0).translation(Vec3::new(0.0, -0.5, 0.0)), None);
        let mut character = Character::spawn(&mut world, Vec3::ZERO, CharacterParams::default()).expect("default parameters");
        for n in 0..3 {
            let step = tick(&mut world, &mut character, walk(Vec3::X));
            assert!(step.grounded && !step.left_ground && !step.landed, "tick {n}: {step:?}");
            assert!(character.feet().y.abs() < 1.0e-5, "tick {n}: {}", character.feet());
        }
    }

    #[test]
    fn a_root_step_into_a_wall_stops_at_it_and_slides_along_a_45_degree_wall() {
        let params = CharacterParams::default();
        // A wall whose face is at z = 0.8, square on.
        let mut world = ground_world();
        world.insert_collider(ColliderBuilder::cuboid(5.0, 2.0, 0.5).translation(Vec3::new(0.0, 2.0, 1.3)), None);
        world.step();
        let mut character = Character::spawn(&mut world, Vec3::ZERO, params).expect("default parameters");
        tick(&mut world, &mut character, root_forward(1.0));
        let stop = 0.8 - params.radius - CHARACTER_SKIN;
        let feet = character.feet();
        assert!((feet.z - stop).abs() < 2.0e-3, "stopped at the wall: {feet} (wall stop {stop})");
        assert!(feet.x.abs() < 1.0e-4, "no sideways drift into a square wall: {feet}");

        // The same wall turned 45° about +Y: the step slides along it toward +x.
        let mut world = ground_world();
        let turned = Pose::from_parts(Vec3::new(0.0, 2.0, 1.3), Quat::from_rotation_y(std::f32::consts::FRAC_PI_4));
        world.insert_collider(ColliderBuilder::cuboid(5.0, 2.0, 0.5).position(turned), None);
        world.step();
        let mut character = Character::spawn(&mut world, Vec3::ZERO, params).expect("default parameters");
        tick(&mut world, &mut character, root_forward(1.0));
        let feet = character.feet();
        let normal = Quat::from_rotation_y(std::f32::consts::FRAC_PI_4) * Vec3::NEG_Z;
        let gap = (feet - Vec3::new(0.0, 0.0, 1.3)).dot(normal) - 0.5;
        assert!(gap >= params.radius, "never inside the wall: gap {gap}");
        assert!(feet.x.abs() > 0.15, "slid along the 45° wall: {feet}");
        assert!(feet.z < 1.0, "did not pass the wall: {feet}");
    }

    /// A ramp of `degrees` rising toward +z from z = 0, wide and long, with flat ground under it.
    fn ramp_world(degrees: f32) -> PhysicsWorld {
        let mut world = ground_world();
        let angle = degrees.to_radians();
        let half_length = 10.0;
        let pose = Pose::from_parts(Vec3::new(0.0, half_length * sin(angle) - 0.5 * cos(angle), half_length * cos(angle) + 0.5 * sin(angle)), Quat::from_rotation_x(-angle));
        world.insert_collider(ColliderBuilder::cuboid(5.0, 0.5, half_length).position(pose), None);
        world.step();
        world
    }

    #[test]
    fn a_50_degree_slope_slides_the_character_and_a_40_degree_one_holds_it() {
        let params = CharacterParams::default();
        for (degrees, slides) in [(50.0f32, true), (40.0f32, false)] {
            let mut world = ramp_world(degrees);
            // Feet just above the slope 2 m up it (a capsule on a slope stands r(1/cos - 1) high),
            // settled for 5 ticks before the row measures.
            let along = 2.0;
            let angle = degrees.to_radians();
            let clearance = params.radius * (1.0 / cos(angle) - 1.0) + 0.02;
            let spawn = Vec3::new(0.0, along * sin(angle) + clearance, along * cos(angle));
            let mut character = Character::spawn(&mut world, spawn, params).expect("default parameters");
            for _ in 0..5 {
                tick(&mut world, &mut character, walk(Vec3::ZERO));
            }
            let feet = character.feet();
            let mut sliding = character.sliding();
            for _ in 0..30 {
                sliding |= tick(&mut world, &mut character, walk(Vec3::ZERO)).sliding;
            }
            let moved = character.feet() - feet;
            if slides {
                assert!(sliding, "{degrees}°: sliding reported");
                assert!(moved.z < -0.1 && moved.y < -0.1, "{degrees}°: slid down: {moved}");
            } else {
                assert!(!sliding, "{degrees}°: not sliding");
                assert!(moved.abs().max_element() < 1.0e-5, "{degrees}°: held on the slope: {moved}");
                assert!(character.grounded(), "{degrees}°: stands on it");
            }
        }
    }

    /// A box stair of `rise` metres whose near face is at z = 1.
    fn stair_world(rise: f32) -> PhysicsWorld {
        let mut world = ground_world();
        world.insert_collider(ColliderBuilder::cuboid(5.0, rise * 0.5, 5.0).translation(Vec3::new(0.0, rise * 0.5, 6.0)), None);
        world.step();
        world
    }

    #[test]
    fn with_step_0_3_a_0_25_stair_climbs_and_a_0_35_stair_blocks() {
        let params = CharacterParams::default();
        assert_eq!(params.step_height, 0.3);
        for (rise, climbs) in [(0.25f32, true), (0.35f32, false)] {
            let mut world = stair_world(rise);
            let mut character = Character::spawn(&mut world, Vec3::ZERO, params).expect("default parameters");
            for _ in 0..120 {
                tick(&mut world, &mut character, walk(Vec3::new(0.0, 0.0, 2.0)));
            }
            let feet = character.feet();
            if climbs {
                assert!(feet.z > 2.0 && (feet.y - rise).abs() < 0.02, "a {rise} m stair climbs: {feet}");
                assert!(character.grounded(), "stands on the stair");
            } else {
                assert!(feet.z < 1.0 && feet.y.abs() < 0.02, "a {rise} m stair blocks: {feet}");
            }
        }
    }

    #[test]
    fn jump_leaves_the_ground_and_lands_on_the_computed_ticks() {
        let params = CharacterParams::default();
        let (expected, _) = landing_tick(params.jump_speed, params.gravity, TICK);
        let mut world = ground_world();
        let mut character = Character::spawn(&mut world, Vec3::ZERO, params).expect("default parameters");
        let mut left = Vec::new();
        let mut landed = Vec::new();
        for n in 1..=120u32 {
            let motion = if n == 1 { jump_with(Vec3::ZERO) } else { walk(Vec3::ZERO) };
            let step = tick(&mut world, &mut character, motion);
            if step.left_ground {
                left.push(n);
            }
            if step.landed {
                landed.push(n);
            }
        }
        assert_eq!(left, vec![1], "left the ground on the jump tick only");
        assert_eq!(landed, vec![expected], "landed on the tick its fall reaches the ground");
        assert!(character.feet().y.abs() < 2.0e-3, "back on the ground: {}", character.feet());
    }

    #[test]
    fn drive_on_walks_the_same_flat_path_as_drive_within_1e_5() {
        let params = CharacterParams::default();
        let mut world = ground_world();
        let mut physical = Character::spawn(&mut world, Vec3::ZERO, params).expect("default parameters");
        let mut flat = Character::on_ground(Vec3::ZERO, params).expect("default parameters");
        let mut worst = 0.0f32;
        for n in 0..600u32 {
            let angle = n as f32 * 0.01;
            let wish = Vec3::new(glam::Vec2::from_angle(angle).x, 0.0, glam::Vec2::from_angle(angle).y) * 3.0;
            tick(&mut world, &mut physical, walk(wish));
            flat.drive_on(|_, _| 0.0, walk(wish), TICK);
            worst = worst.max((physical.feet() - flat.feet()).abs().max_element());
        }
        assert!(worst <= 1.0e-5, "the paths part by {worst} m");
        assert_eq!(physical.yaw().to_bits(), flat.yaw().to_bits(), "the same heading");
    }

    /// The 3,600-tick course: walls, a stair, a ramp, jumps, root motion and mixed steering.
    fn course() -> PhysicsWorld {
        let mut world = ground_world();
        world.insert_collider(ColliderBuilder::cuboid(0.5, 2.0, 20.0).translation(Vec3::new(8.0, 2.0, 0.0)), None);
        world.insert_collider(ColliderBuilder::cuboid(0.5, 2.0, 20.0).translation(Vec3::new(-8.0, 2.0, 0.0)), None);
        world.insert_collider(ColliderBuilder::cuboid(3.0, 0.125, 3.0).translation(Vec3::new(0.0, 0.125, 6.0)), None);
        world.insert_collider(ColliderBuilder::cuboid(3.0, 0.5, 6.0).position(Pose::from_parts(Vec3::new(4.0, 0.5, -6.0), Quat::from_rotation_x(0.4))), None);
        world.step();
        world
    }

    fn scripted(n: u32) -> CharacterMotion {
        let angle = n as f32 * 0.013;
        let wish = Vec3::new(glam::Vec2::from_angle(angle).x, 0.0, glam::Vec2::from_angle(angle * 0.7).y) * 4.0;
        match n % 400 {
            0 => jump_with(wish),
            1..=80 => CharacterMotion::Root(RootMotion { translation: Vec3::new(0.0, 0.0, 0.05), yaw: 0.02 }),
            81..=160 => CharacterMotion::Mixed { root: RootMotion { translation: Vec3::new(0.01, 0.0, 0.04), yaw: -0.01 }, wish, jump: n.is_multiple_of(97), root_share: 0.5 },
            _ => walk(wish),
        }
    }

    fn run(ticks: std::ops::Range<u32>, world: &mut PhysicsWorld, character: &mut Character) -> Vec<u64> {
        ticks.map(|n| {
            tick(world, character, scripted(n));
            character.digest()
        })
        .collect()
    }

    #[test]
    fn three_thousand_six_hundred_ticks_replay_bit_exact() {
        let params = CharacterParams::default();
        let mut first_world = course();
        let mut first = Character::spawn(&mut first_world, Vec3::ZERO, params).expect("default parameters");
        let mut second_world = course();
        let mut second = Character::spawn(&mut second_world, Vec3::ZERO, params).expect("default parameters");
        let a = run(0..3600, &mut first_world, &mut first);
        let b = run(0..3600, &mut second_world, &mut second);
        assert_eq!(a, b, "two runs give the same state every tick");
        let distinct: std::collections::BTreeSet<u64> = a.iter().copied().collect();
        assert!(distinct.len() > 3000, "the course moves the character ({} distinct states)", distinct.len());
    }

    #[test]
    fn a_snapshot_at_1800_restored_into_a_fresh_world_replays_the_uninterrupted_run() {
        let params = CharacterParams::default();
        let mut world = course();
        let mut character = Character::spawn(&mut world, Vec3::ZERO, params).expect("default parameters");
        let mut whole = run(0..1800, &mut world, &mut character);
        let snapshot = json::parse(&character.snapshot().dump()).expect("the snapshot reads back");
        whole.extend(run(1800..3600, &mut world, &mut character));

        let mut fresh = course();
        let mut restored = Character::spawn(&mut fresh, Vec3::new(-3.0, 0.0, 2.0), params).expect("default parameters");
        restored.restore(&snapshot).expect("restores");
        let replay = run(1800..3600, &mut fresh, &mut restored);
        assert_eq!(&whole[1800..], &replay[..], "the restored run equals the uninterrupted one");
        let body = fresh.bodies.get(restored.body().expect("a body")).expect("in the world");
        assert!((body.translation() - world.bodies.get(character.body().expect("a body")).expect("in the world").translation()).length() == 0.0, "the bodies agree");
    }

    #[test]
    fn ground_ray_ignores_the_character_and_remove_takes_its_body_out() {
        let mut world = ground_world();
        let character = Character::spawn(&mut world, Vec3::ZERO, CharacterParams::default()).expect("default parameters");
        world.step();
        let hit = {
            let mut ray = character.ground_ray(&world);
            ray(Vec3::new(0.0, 1.0, 0.0), Vec3::new(0.0, -1.0, 0.0)).expect("the ground is under the character")
        };
        assert!(hit.point.y.abs() < 1.0e-5 && hit.normal.y > 0.999, "{hit:?}");
        let body = character.body().expect("a body");
        assert!(world.bodies.get(body).is_some());
        character.remove(&mut world);
        assert!(world.bodies.get(body).is_none(), "removed");
    }

    /// Advisory budget row (section 4.4): 100 characters drive on the course in at most 1.5 ms per
    /// tick on the M4 Max. Run in release: `cargo test --release ... -- --ignored --nocapture`.
    #[test]
    #[ignore = "timing row; advisory in lanes, gated on a quiet machine"]
    #[allow(clippy::disallowed_types, reason = "the budget row measures the wall clock on purpose")]
    fn budget_100_characters_per_tick() {
        let params = CharacterParams::default();
        // A level's 100 walkers 4 m apart, then a crowd 1.2 m apart that bumps all the time.
        for spacing in [4.0f32, 1.2] {
            let mut world = ground_world();
            world.insert_collider(ColliderBuilder::cuboid(0.5, 2.0, 40.0).translation(Vec3::new(30.0, 2.0, 0.0)), None);
            world.insert_collider(ColliderBuilder::cuboid(3.0, 0.125, 3.0).translation(Vec3::new(0.0, 0.125, 6.0)), None);
            world.step();
            let origin = -4.5 * spacing;
            let mut characters: Vec<Character> = (0..100)
                .map(|i| Character::spawn(&mut world, Vec3::new(origin + (i % 10) as f32 * spacing, 0.0, origin + (i / 10) as f32 * spacing), params).expect("valid"))
                .collect();
            world.step();
            let mut samples = Vec::new();
            for n in 0..600u32 {
                let started = std::time::Instant::now();
                for character in &mut characters {
                    character.drive(&mut world, scripted(n), TICK);
                }
                samples.push(started.elapsed().as_secs_f64() * 1000.0);
                world.step();
            }
            samples.sort_by(f64::total_cmp);
            let mean = samples.iter().sum::<f64>() / samples.len() as f64;
            let p95 = samples[samples.len() * 95 / 100];
            println!("BUDGET an19 drive x100 at {spacing} m: mean {mean:.3} ms, p95 {p95:.3} ms, per character {:.2} us", mean * 10.0);
        }
    }
}
