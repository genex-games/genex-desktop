//! A crowd on a nav mesh, distilled from the engine's nav-crowd example: 120 walkers wander a
//! walled market square between its stalls and its fountain, each a nav agent driving its own
//! character capsule, and 240 trees (`gfx.plant` oaks and maples) stand round the walls as retained
//! instance groups.
//!
//! Every tick runs the documented loop: `sim.nav.update(dt)` once, then per walker the agent's
//! desired velocity drives its capsule (`Character::drive`) and `nav.set_position` tells the nav
//! where it went; an arrival picks the least busy target. The capsules are sensors, so a jam at a
//! stall cannot stack them on each other's heads: the nav's avoidance keeps them apart. Things that
//! move every tick are ordinary draws (each under its own `frame.id`); things that never move, the
//! trees, are retained groups made once at reset.
//!
//! With `assets/characters/walker.glb` (clips `Idle` and `Walk`) every walker is an animated,
//! tinted rig whose walk plays at its ground speed; without it each is a coloured block. The `nav`
//! camera draws the nav mesh and every agent's path over the square.

use genex::animation::ClipId;
use genex::glam::Vec3Swizzles;
use genex::plants::{PlantSpec, Season, Species};
use genex::nav::{AgentId, NavAgent, NavArea, NavConfig, NavDebug, NavInput, NavMesh, NavStatus};
use genex::physics::ColliderBuilder;
use genex::prelude::*;
use genex::render::Environment;
use genex::{CharacterDraw, CharacterParams, FIXED_STEP_MS, InstanceGroup};

/// Walkers in the crowd (a nav holds at most 1024 agents).
pub const WALKERS: usize = 120;
/// The walker GLB under `assets/` and its two clips, and the ground speed its walk clip shows.
const WALKER_GLB: &str = "characters/walker.glb";
const CLIPS: [&str; 2] = ["Idle", "Walk"];
const WALK_CLIP_SPEED: f32 = 1.4;
/// The agents' preferred and top speeds (m/s), and how close counts as arrived (m).
const AGENT_SPEED: (f32, f32) = (1.4, 2.0);
const AGENT_REACH: f32 = 1.0;
/// A walker's next target is one within this distance of its last (m).
const NEXT_TARGET_RADIUS: f32 = 14.0;
/// Stuck: this many ticks in a row wanting to move and not moving.
const STALL_TICKS: u32 = 120;
/// An agent a few centimetres off the mesh's edge walks back onto it from up to this far (m).
const OFF_MESH_REACH: f32 = 1.5;
/// The square: the ground's half side, the wall's half side, height and thickness, a gate's half
/// width; the stalls' grid, half footprint and counter height; the fountain's half side.
const GROUND_HALF: f32 = 40.0;
const WALL_HALF: f32 = 20.0;
const WALL_HEIGHT: f32 = 2.2;
const WALL_THICK: f32 = 0.4;
const GATE_HALF: f32 = 2.5;
const STALL_GRID: [f32; 2] = [-10.0, 10.0];
const STALL_HALF: Vec2 = Vec2::new(2.0, 1.0);
const STALL_HEIGHT: f32 = 1.1;
const FOUNTAIN_HALF: f32 = 2.0;
/// Spawn points: a lattice this far apart, kept this far from every solid.
const SPAWN_STEP: f32 = 1.4;
const SPAWN_CLEARANCE: f32 = 0.8;
/// Trees round the walls: how many, and the band they stand in (m from the centre).
const TREES: usize = 240;
const TREE_BAND: (f32, f32) = (23.0, 36.0);
/// Draw ids: one key per walker that stays with it, so TAA follows it.
const WALKER_ID: u64 = 0x4352_4f57_0000;
const TINTS: [Color; 6] = [
    Color::rgb(70, 90, 160),
    Color::rgb(160, 70, 90),
    Color::rgb(70, 140, 120),
    Color::rgb(180, 160, 80),
    Color::rgb(120, 80, 160),
    Color::rgb(200, 200, 200),
];

/// One walker: its nav agent, its capsule, its rig (with the GLB) and what it has done.
struct Walker {
    agent: AgentId,
    body: Character,
    animator: Option<Animator>,
    target: usize,
    arrivals: u32,
    stalled: u32,
    longest_stall: u32,
}

/// Everything the simulation owns. Every seed rebuilds it from `World::default()`.
#[derive(Default)]
pub struct World {
    walkers: Vec<Walker>,
    targets: Vec<Vec3>,
    clips: Option<[ClipId; 2]>,
    trees: Vec<InstanceGroup>,
}

/// The `nav` camera: high over the square's corner, with the nav mesh and paths drawn.
pub fn nav_camera() -> Camera {
    Camera::look_at(vec3(16.0, 30.0, 22.0), vec3(0.0, 0.0, 0.0))
}

/// The walker the bake is for: the capsule's own climb and slope, 16 m tiles.
fn nav_config() -> NavConfig {
    let probe = Character::on_ground(Vec3::ZERO, CharacterParams::default()).expect("the default capsule is valid");
    probe.nav_config().with_tile(16.0)
}

/// Register every hook.
pub fn wire(game: &mut Game<World>) {
    game.navigation(nav_config());
    game.on_reset(reset);
    game.on_update(update);
    game.on_draw(draw);
    game.camera(|_| Camera::look_at(vec3(0.0, 26.0, 34.0), vec3(0.0, 0.0, 2.0)));
    game.named_camera("street", |_| Camera { fovy: 62.0, ..Camera::look_at(vec3(0.0, 1.7, 19.0), vec3(0.0, 1.2, 0.0)) });
    game.named_camera("nav", |_| nav_camera());
    game.probe("crowd", |sim| {
        let walkers = &sim.world.walkers;
        json!({
            "walkers": walkers.len(),
            "arrivals": walkers.iter().map(|w| w.arrivals).sum::<u32>(),
            "arrivedOnce": walkers.iter().filter(|w| w.arrivals > 0).count(),
            "longestStall": walkers.iter().map(|w| w.longest_stall).max().unwrap_or(0),
            "stuck": walkers.iter().filter(|w| w.longest_stall >= STALL_TICKS).count(),
            "animated": walkers.iter().filter(|w| w.animator.is_some()).count(),
        })
    });
    game.probe("nav", |sim| Value::from(&sim.nav.probe()));
    game.demo("half-minute", |d| {
        d.advance_ms(30_000);
        json!({ "arrivals": d.sim().world.walkers.iter().map(|w| w.arrivals).sum::<u32>() })
    });
}

/// The solids, as (centre, half extents): the wall's eight pieces, the stalls and the fountain.
fn solids() -> Vec<(Vec3, Vec3)> {
    let run = 0.5 * (WALL_HALF - GATE_HALF);
    let (mid, y) = (GATE_HALF + run, 0.5 * WALL_HEIGHT);
    let mut out = Vec::new();
    for side in [-1.0, 1.0] {
        for along in [-1.0, 1.0] {
            out.push((vec3(along * mid, y, side * WALL_HALF), vec3(run, y, 0.5 * WALL_THICK)));
            out.push((vec3(side * WALL_HALF, y, along * mid), vec3(0.5 * WALL_THICK, y, run)));
        }
    }
    for x in STALL_GRID {
        for z in STALL_GRID {
            out.push((vec3(x, 0.5 * STALL_HEIGHT, z), vec3(STALL_HALF.x, 0.5 * STALL_HEIGHT, STALL_HALF.y)));
        }
    }
    out.push((vec3(0.0, 0.4, 0.0), vec3(FOUNTAIN_HALF, 0.4, FOUNTAIN_HALF)));
    out
}

/// Where walkers go: in front of and behind every stall, and each side of the fountain.
fn targets() -> Vec<Vec3> {
    let stalls = STALL_GRID.iter().flat_map(|x| STALL_GRID.iter().map(move |z| vec3(*x, 0.0, *z)));
    let mut out: Vec<Vec3> = stalls.flat_map(|at| [at + Vec3::Z * 2.0, at - Vec3::Z * 2.0]).collect();
    out.extend([Vec3::X, -Vec3::X, Vec3::Z, -Vec3::Z].map(|side| side * (FOUNTAIN_HALF + 2.5)));
    out
}

fn reset(sim: &mut Sim<World>, _seed: u32, rng: &mut Pcg32, gfx: &Gfx) {
    sim.physics.insert_collider(ColliderBuilder::cuboid(GROUND_HALF, 0.5, GROUND_HALF).translation(vec3(0.0, -0.5, 0.0)), None);
    for (center, half) in solids() {
        sim.physics.insert_collider(ColliderBuilder::cuboid(half.x, half.y, half.z).translation(center), None);
    }
    let input = NavInput::new().with_static_colliders(&sim.physics, NavArea::WALK).expect("the square's colliders bake");
    sim.nav.add_mesh(&NavMesh::bake(&input, &nav_config()).expect("the square bakes")).expect("its tiles fit");
    // Islands stitch on an update: agents added after it stand on stitched tiles.
    sim.nav.update(FIXED_STEP_MS as f32 / 1000.0);
    let asset = gfx.character(WALKER_GLB).ok();
    let clips = asset.as_ref().and_then(|asset| Some([asset.clip(CLIPS[0])?, asset.clip(CLIPS[1])?]));
    sim.world = World { targets: targets(), clips, ..World::default() };
    for (index, at) in spawn_points().into_iter().enumerate() {
        let agent = sim.nav.add_agent(NavAgent::new(at).with_speed(AGENT_SPEED.0, AGENT_SPEED.1).with_reach(AGENT_REACH)).expect("under the agent cap");
        let body = Character::spawn(&mut sim.physics, at, CharacterParams::default()).expect("a capsule on the square");
        // A sensor: no capsule blocks or stands on another.
        if let Some(collider) = body.collider().and_then(|handle| sim.physics.colliders.get_mut(handle)) {
            collider.set_sensor(true);
        }
        let animator = asset.as_ref().zip(clips).and_then(|(asset, [idle, _])| {
            let mut animator = Animator::simple(asset).ok()?;
            animator.play(idle);
            Some(animator)
        });
        // Its first walk is to a target near the one nearest where it stands.
        let nearest = (0..sim.world.targets.len()).min_by(|a, b| sim.world.targets[*a].distance(at).total_cmp(&sim.world.targets[*b].distance(at))).unwrap_or(0);
        sim.world.walkers.push(Walker { agent, body, animator, target: nearest, arrivals: 0, stalled: 0, longest_stall: 0 });
        send_on(sim, index, rng.next_u32());
    }
    sim.world.trees = trees(rng, gfx);
}

/// [`WALKERS`] spawn points spread over the square, clear of every solid.
fn spawn_points() -> Vec<Vec3> {
    let solids = solids();
    let clear = |at: Vec3| solids.iter().all(|(c, h)| (at.xz() - c.xz()).abs().cmpgt(h.xz() + Vec2::splat(SPAWN_CLEARANCE)).any());
    let steps = (2.0 * (WALL_HALF - 1.0) / SPAWN_STEP) as i32;
    let start = -(WALL_HALF - 1.0);
    let lattice: Vec<Vec3> = (0..=steps)
        .flat_map(|row| (0..=steps).map(move |column| vec3(start + column as f32 * SPAWN_STEP, 0.0, start + row as f32 * SPAWN_STEP)))
        .filter(|at| clear(*at))
        .collect();
    (0..WALKERS).map(|index| lattice[index * lattice.len() / WALKERS]).collect()
}

/// The trees round the walls: grown plants (bark, leaf cards, levels, impostors and wind built in),
/// three variants dealt round the band from the reset's seed, each one retained group made once,
/// drawn every frame, its rows uploaded once.
fn trees(rng: &mut Pcg32, gfx: &Gfx) -> Vec<InstanceGroup> {
    let variants = [
        gfx.plant(&PlantSpec::new(Species::Oak, Season::Leafy).seed(1).height(12.0)),
        gfx.plant(&PlantSpec::new(Species::Maple, Season::Leafy).seed(2).height(11.0)),
        gfx.plant(&PlantSpec::new(Species::Oak, Season::Leafy).seed(3).height(13.0)),
    ];
    let mut placed: Vec<Vec<Transform>> = vec![Vec::new(); variants.len()];
    for index in 0..TREES {
        let (angle, radius) = (rng.range_f32(0.0, std::f32::consts::TAU), rng.range_f32(TREE_BAND.0, TREE_BAND.1));
        let at = vec3(radius * genex::math::cos(angle), 0.0, radius * genex::math::sin(angle));
        let turn = Quat::from_rotation_y(rng.range_f32(0.0, std::f32::consts::TAU));
        let copy = Transform::from_translation(at).with_rotation(turn).with_scale(Vec3::splat(rng.range_f32(0.75, 1.15)));
        placed[index % variants.len()].push(copy);
    }
    variants.iter().zip(placed).filter_map(|(model, copies)| InstanceGroup::models(model, copies).ok()).collect()
}

/// Send walker `index` to the least busy target within [`NEXT_TARGET_RADIUS`] of its last (ties by
/// `roll`), at a spot jittered from `roll` so a crowd at one stall spreads along its front. The
/// least busy, so the crowd spreads over the stalls instead of jamming one; a near one, so a walk
/// is a few seconds, not a trip across the square.
fn send_on(sim: &mut Sim<World>, index: usize, roll: u32) {
    let world = &mut sim.world;
    let here = world.walkers[index].target;
    let near = |target: usize| target != here && world.targets[target].distance(world.targets[here]) <= NEXT_TARGET_RADIUS;
    let busy = |target: usize| world.walkers.iter().filter(|w| w.target == target).count();
    let least = (0..world.targets.len()).filter(|t| near(*t)).map(busy).min().unwrap_or(0);
    let choices: Vec<usize> = (0..world.targets.len()).filter(|t| near(*t) && busy(*t) == least).collect();
    let target = choices[roll as usize % choices.len()];
    let jitter = vec3(((roll >> 8) % 360) as f32 / 100.0 - 1.8, 0.0, ((roll >> 16) % 120) as f32 / 100.0 - 0.6);
    world.walkers[index].target = target;
    sim.nav.move_to(world.walkers[index].agent, world.targets[target] + jitter);
}

fn update(sim: &mut Sim<World>, ctx: &Ctx<'_>) {
    sim.nav.update(ctx.dt);
    for index in 0..sim.world.walkers.len() {
        let agent = sim.world.walkers[index].agent;
        let status = sim.nav.status(agent);
        if matches!(status, Some(NavStatus::Arrived)) {
            sim.world.walkers[index].arrivals += 1;
        }
        if matches!(status, Some(NavStatus::Arrived | NavStatus::NoPath | NavStatus::TargetOffMesh | NavStatus::Idle)) {
            send_on(sim, index, ctx.rng.next_u32());
        }
        let wish = match sim.nav.status(agent) {
            Some(NavStatus::OffMesh) => back_onto_mesh(&sim.nav, sim.world.walkers[index].body.feet()),
            _ => sim.nav.desired_velocity(agent),
        };
        let clips = sim.world.clips;
        let walker = &mut sim.world.walkers[index];
        let step = walker.body.drive(&mut sim.physics, CharacterMotion::Velocity { wish, jump: false }, ctx.dt);
        sim.nav.set_position(agent, walker.body.feet(), walker.body.velocity());
        let stalled = wish.length() > 0.5 && step.moved.xz().length() < 1.0e-3;
        walker.stalled = if stalled { walker.stalled + 1 } else { 0 };
        walker.longest_stall = walker.longest_stall.max(walker.stalled);
        // The rig walks at its ground speed, so its feet do not slide.
        let (Some(animator), Some([idle, walk])) = (walker.animator.as_mut(), clips) else { continue };
        let speed = walker.body.velocity().xz().length();
        let walking = speed > 0.3;
        animator.crossfade(if walking { walk } else { idle }, 0.3);
        animator.speed(if walking { speed / WALK_CLIP_SPEED } else { 1.0 });
        animator.update(ctx.dt);
    }
}

/// A capsule can stand a few centimetres past the mesh's edge, where its agent wants nothing:
/// walk it back onto the nearest polygon.
fn back_onto_mesh(nav: &genex::nav::Nav, feet: Vec3) -> Vec3 {
    let Some(point) = nav.closest_point(feet, OFF_MESH_REACH) else { return Vec3::ZERO };
    vec3(point.position.x - feet.x, 0.0, point.position.z - feet.z).normalize_or_zero()
}

fn draw(sim: &Sim<World>, frame: &mut Frame, camera: &Camera) {
    let world = &sim.world;
    frame.clear(Color::rgb(150, 180, 215)).ambient(Color::rgb(170, 190, 220), 0.25);
    frame.sun(vec3(-0.5, 0.62, -0.6), Color::WHITE, 3.0).environment(Environment::sky());
    let box_at = |center: Vec3, half: Vec3| Transform::from_translation(center).with_scale(half * 2.0);
    frame.tag("square").cube_with(box_at(vec3(0.0, -0.5, 0.0), vec3(GROUND_HALF, 0.5, GROUND_HALF)), &Material::color(Color::rgb(150, 142, 128)).with_roughness(0.9));
    let wall = Material::color(Color::rgb(176, 160, 136)).with_roughness(0.9);
    for (center, half) in solids() {
        frame.cube_with(box_at(center, half), &wall);
    }
    frame.tag("trees");
    for group in &world.trees {
        frame.group(group);
    }
    frame.tag("crowd");
    for (index, walker) in world.walkers.iter().enumerate() {
        let tint = TINTS[index % TINTS.len()];
        let at: Transform = walker.body.transform().into();
        frame.id(WALKER_ID + index as u64);
        match &walker.animator {
            Some(animator) => frame.character_with(animator, at, &CharacterDraw::new().tint(tint)),
            None => frame.cube_with(box_at(at.translation + Vec3::Y * 0.9, vec3(0.3, 0.9, 0.2)).with_rotation(at.rotation), &Material::color(tint).with_roughness(0.6)),
        };
        frame.end_id();
    }
    if *camera == nav_camera() {
        frame.tag("nav-debug").nav_debug(&sim.nav, NavDebug::mesh().with_paths());
    }
}
