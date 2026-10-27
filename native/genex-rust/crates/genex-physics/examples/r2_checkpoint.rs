//! R2-0b, the checkpoint experiment (plan Track C, "Prediction model"): what `canonicalize` costs
//! and changes, and whether a client rebuilt from the server's keyframe steps on bit for bit.
//!
//! Run it with the release profile through the env helper:
//!
//! ```text
//! node scripts/toolchains/rust-env.ts -- cargo run --release --offline --locked -p genex-physics --example r2_checkpoint
//! ```
//!
//! It prints Markdown tables (the source of `RESULTS-r2-0.md`). Every scene is z-up, lengthUnit 1,
//! on a static floor, at 20, 30 and 60 Hz with one inner step per 1/60 s (3, 2 and 1 substeps).
//! The keyframe interval K is `tickHz / patchHz`: patchHz 20 at 20 and 60 Hz (K 1 and 3), 15 at
//! 30 Hz (K 2, since 30/20 is not whole).
//!
//! Modes, applied by the server after the step of every K-th tick:
//! - `off`: never canonicalized (the reference run);
//! - `canon`: `canonicalize({})`;
//! - `canonQ`: `canonicalize({ quantize: true })`, the plan's recommended regime;
//! - `ws0`: `canonicalize({})` every tick, the stand-in for warmstart = 0 (the core has no solver
//!   option for it; inner substeps still warm-start each other at 20 and 30 Hz);
//! - `canonQ+clamp` (the CCD scene only): `canonQ` with the host clamping every body's linear and
//!   angular speed to the wire's 64 after each step, the plan's speed-clamp question.
//!
//! Measures: drift against `off` (body positions, metres), jitter (mean per-tick displacement over
//! the last 2 s, resting scenes), the tick every body is first asleep, wall time of `step()` and
//! `canonicalize()`, the exact-rebuild row (a client with its own history adopts each keyframe,
//! steps K ticks with the same commands and is compared bit for bit before the next keyframe), the
//! subset-rebuild row (the client holds only the 100 bodies nearest a viewer) and the server's CPU
//! for 128 crates kept awake. Section `g0` adds Gate G0's stacking rows (stacks of 5 to 20, the
//! pile and the yard's towers at 4 and 8 solver iterations, canonQ at the decided K).

// A benchmark reads the wall clock by definition; the simulation it measures never does.
#![allow(clippy::disallowed_types)]

use std::collections::BTreeSet;
use std::time::Instant;

use genex_physics::wire::{WIRE_ORIENTATION, WIRE_VELOCITY, quantize, rest_steps};
use genex_physics::{
    BodyDesc, BodyFilter, BodyType, CanonicalizeOptions, ColliderDesc, Command, JointDesc, JointType, Motor, NetBodyState, Pose,
    SetPoseOptions, Shape, StaticWorld, UpAxis, Vec3, World, WorldDesc,
};
use serde_json::{Value, json};

/// Simulated seconds per run.
const SECONDS: u64 = 20;
/// The inner step every rate shares: substeps = INNER_HZ / tickHz.
const INNER_HZ: u32 = 60;
const RATES: [u32; 3] = [20, 30, 60];
const GRAVITY: Vec3 = [0.0, 0.0, -9.81];
/// The wire's velocity range (PROTOCOL §17.10), m/s and rad/s at lengthUnit 1.
const WIRE_SPEED: f64 = 64.0;
/// What the clamp holds a speed to: under the range, so f32 rounding never crosses it.
const CLAMP_SPEED: f64 = 63.99;
/// The client's view (plan: 100 full-rate view bodies).
const VIEW_BODIES: usize = 100;
/// A view body is "pure" when every body outside the view is this much farther than their
/// bounding spheres at the keyframe.
const PURE_MARGIN: f64 = 0.5;
/// Steps a client takes on its own before its first adoption (another history).
const CLIENT_OWN_STEPS: usize = 5;
/// The window jitter is measured over, seconds.
const JITTER_SECONDS: u64 = 2;
/// The CCD wall's near face and thickness.
const WALL_X: f64 = 10.0;
const WALL_THICKNESS: f64 = 0.25;
const CCD_BALLS: usize = 16;
const CCD_RADIUS: f64 = 0.05;
/// The core's default solver iterations (contract §6), and the counts the mitigation sweep tries.
const DEFAULT_ITERATIONS: u32 = 4;
const ITERATION_SWEEP: [u32; 3] = [4, 8, 16];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Scene {
    Stack5,
    Stack8,
    Stack10,
    Stack15,
    Stack20,
    Stack5Drop,
    Stack8Awake,
    Stack10Awake,
    Stack15Awake,
    Stack20Awake,
    Pile,
    Chain,
    Doors,
    Ccd,
    Crates128,
    Yard,
}

const MAIN_SCENES: [Scene; 11] = [
    Scene::Stack5,
    Scene::Stack10,
    Scene::Stack20,
    Scene::Stack5Drop,
    Scene::Stack10Awake,
    Scene::Stack20Awake,
    Scene::Pile,
    Scene::Chain,
    Scene::Doors,
    Scene::Ccd,
    Scene::Crates128,
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Off,
    Canon,
    CanonQ,
    Ws0,
    CanonQClamp,
}

/// What a scene is built from, so a client can spawn the same bodies from their canonical forms.
struct Plan {
    desc: WorldDesc,
    statics: StaticWorld,
    bodies: Vec<BodyDesc>,
    joints: Vec<JointDesc>,
}

#[derive(Clone, Copy, Default)]
struct Summary {
    mean: f64,
    p99: f64,
}

/// One server run's numbers.
struct Measure {
    positions: Vec<Vec<Vec3>>,
    asleep_at: Option<u64>,
    step_us: Summary,
    canon_us: Summary,
    canon_calls: usize,
    tunnels: usize,
    clipped_keyframes: usize,
    /// Ticks after the first all-asleep tick with some body awake.
    awake_after_sleep: usize,
}

/// One exact-rebuild run's numbers.
#[derive(Default)]
struct Rebuild {
    windows: usize,
    windows_mismatched: usize,
    bodies: usize,
    bodies_mismatched: usize,
    adopt_us: Summary,
}

/// One subset-rebuild run's numbers.
#[derive(Default)]
struct Subset {
    windows: usize,
    pure: usize,
    pure_mismatched: usize,
    boundary: usize,
    boundary_mismatched: usize,
    error_p99: f64,
    error_max: f64,
}

impl Scene {
    fn name(self) -> &'static str {
        match self {
            Scene::Stack5 => "stack-5",
            Scene::Stack8 => "stack-8",
            Scene::Stack10 => "stack-10",
            Scene::Stack15 => "stack-15",
            Scene::Stack20 => "stack-20",
            Scene::Stack5Drop => "stack-5 dropped 4 m",
            Scene::Stack8Awake => "stack-8 never sleeping",
            Scene::Stack10Awake => "stack-10 never sleeping",
            Scene::Stack15Awake => "stack-15 never sleeping",
            Scene::Stack20Awake => "stack-20 never sleeping",
            Scene::Pile => "pile (128, pushed 0-5 s)",
            Scene::Chain => "chain (12 links)",
            Scene::Doors => "doors (4 motorised + 8 crates)",
            Scene::Ccd => "CCD (16 balls, 40 and 110 m/s)",
            Scene::Crates128 => "crates-128 (pushed all run)",
            Scene::Yard => "yard (256 in 16 towers)",
        }
    }

    /// Whether the scene is meant to come to rest (jitter and sleep are its numbers).
    fn rests(self) -> bool {
        matches!(
            self,
            Scene::Stack5
                | Scene::Stack8
                | Scene::Stack10
                | Scene::Stack15
                | Scene::Stack20
                | Scene::Stack5Drop
                | Scene::Stack8Awake
                | Scene::Stack10Awake
                | Scene::Stack15Awake
                | Scene::Stack20Awake
                | Scene::Pile
        )
    }

    fn plan(self, hz: u32) -> Plan {
        self.plan_with(hz, DEFAULT_ITERATIONS)
    }

    /// The scene with `iterations` solver iterations.
    fn plan_with(self, hz: u32, iterations: u32) -> Plan {
        let mut desc = WorldDesc::new(1.0 / f64::from(hz), f64::from(INNER_HZ / hz), GRAVITY, UpAxis::Z, 1.0);
        desc.solver.iterations = Some(f64::from(iterations));
        let mut boxes = vec![vec![-60.0, -60.0, -1.0, 60.0, 60.0, 0.0]];
        if self == Scene::Ccd {
            boxes.push(vec![WALL_X, -12.0, 0.0, WALL_X + WALL_THICKNESS, 12.0, 8.0]);
        }
        let statics = StaticWorld { boxes, ramps: Vec::new() };
        let (bodies, joints) = match self {
            Scene::Stack5 => (stack(5, 0.0), Vec::new()),
            Scene::Stack8 => (stack(8, 0.0), Vec::new()),
            Scene::Stack10 => (stack(10, 0.0), Vec::new()),
            Scene::Stack15 => (stack(15, 0.0), Vec::new()),
            Scene::Stack20 => (stack(20, 0.0), Vec::new()),
            Scene::Stack5Drop => (stack(5, 4.0), Vec::new()),
            Scene::Stack8Awake => (never_sleeping(stack(8, 0.0)), Vec::new()),
            Scene::Stack10Awake => (never_sleeping(stack(10, 0.0)), Vec::new()),
            Scene::Stack15Awake => (never_sleeping(stack(15, 0.0)), Vec::new()),
            Scene::Stack20Awake => (never_sleeping(stack(20, 0.0)), Vec::new()),
            Scene::Pile | Scene::Crates128 => (heap(), Vec::new()),
            Scene::Chain => chain(),
            Scene::Doors => doors(),
            Scene::Ccd => (ccd_balls(), Vec::new()),
            Scene::Yard => (yard(), Vec::new()),
        };
        Plan { desc, statics, bodies, joints }
    }

    /// The commands before the step that starts at tick `t` (0-based).
    fn commands(self, t: u64, hz: u32) -> Vec<Command> {
        let hz = u64::from(hz);
        let second = t / hz;
        let on_second = t.is_multiple_of(hz);
        let on_half = t.is_multiple_of(hz / 2);
        match self {
            Scene::Pile if on_second && second < 5 => vec![impulse(&crate_key((second * 37) as usize % 128), [0.8, 0.3, 1.5])],
            Scene::Crates128 if on_half => (0..4).map(|i| impulse(&crate_key(((t / (hz / 2)) * 29 + i * 31) as usize % 128), [0.8, -0.4, 1.5])).collect(),
            Scene::Yard if on_second => vec![impulse(&format!("yard.{:03}", (second * 53) as usize % 256), [1.2, 0.6, 0.5])],
            Scene::Ccd if on_second => (0..CCD_BALLS).flat_map(fire).collect(),
            _ => Vec::new(),
        }
    }
}

impl Mode {
    fn name(self) -> &'static str {
        match self {
            Mode::Off => "off",
            Mode::Canon => "canon",
            Mode::CanonQ => "canonQ",
            Mode::Ws0 => "ws0",
            Mode::CanonQClamp => "canonQ+clamp",
        }
    }

    /// The canonicalize interval at keyframe interval `k`; none for `off`.
    fn interval(self, k: u64) -> Option<u64> {
        match self {
            Mode::Off => None,
            Mode::Ws0 => Some(1),
            Mode::Canon | Mode::CanonQ | Mode::CanonQClamp => Some(k),
        }
    }

    fn quantizes(self) -> bool {
        matches!(self, Mode::CanonQ | Mode::CanonQClamp)
    }

    fn clamps(self) -> bool {
        self == Mode::CanonQClamp
    }

    fn modes_for(scene: Scene) -> Vec<Mode> {
        let mut modes = vec![Mode::Off, Mode::Canon, Mode::CanonQ, Mode::Ws0];
        if scene == Scene::Ccd {
            modes.push(Mode::CanonQClamp);
        }
        modes
    }
}

/// The keyframe interval at `hz` (patchHz 20, or 15 at 30 Hz).
fn keyframe_interval(hz: u32) -> u64 {
    match hz {
        30 => 2,
        _ => u64::from(hz / 20),
    }
}

// ---- Scenes -------------------------------------------------------------------------------------

fn one(key: String, p: Vec3, shape: Shape) -> BodyDesc {
    BodyDesc::new(key, BodyType::Dynamic, Pose::at(p), vec![ColliderDesc::new("c", shape)])
}

fn cube(half: f64) -> Shape {
    Shape::Box { half: [half; 3] }
}

/// `n` unit boxes, 1 cm apart with a centimetre of sideways offset, or dropped from `drop` above.
fn stack(n: usize, drop: f64) -> Vec<BodyDesc> {
    (0..n)
        .map(|i| {
            let f = i as f64;
            let z = 0.5 + drop + f * (1.01 + drop / 4.0);
            one(format!("box.{i:02}"), [0.01 * (f * 1.7).sin(), 0.01 * (f * 2.3).cos(), z], cube(0.5))
        })
        .collect()
}

/// The same bodies with `canSleep: false`: a stack that stays awake isolates what dropping the
/// warm starts does from what a rebuild does to sleeping bodies.
fn never_sleeping(mut bodies: Vec<BodyDesc>) -> Vec<BodyDesc> {
    for body in &mut bodies {
        body.can_sleep = false;
    }
    bodies
}

fn crate_key(i: usize) -> String {
    format!("crate.{i:03}")
}

/// 128 crates, 4 × 4 × 8, dropped into a heap.
fn heap() -> Vec<BodyDesc> {
    (0..128)
        .map(|i| {
            let (x, y, layer) = ((i % 4) as f64, ((i / 4) % 4) as f64, (i / 16) as f64);
            let p = [(x - 1.5) * 0.85 + layer * 0.07, (y - 1.5) * 0.85 - layer * 0.05, 1.0 + layer * 0.85];
            one(crate_key(i), p, cube(0.4))
        })
        .collect()
}

/// 256 crates in 16 towers of 2 × 2 × 4 on a 4 × 4 grid 8 m apart.
fn yard() -> Vec<BodyDesc> {
    (0..256)
        .map(|i| {
            let tower = i / 16;
            let (tx, ty) = ((tower % 4) as f64 * 8.0 - 12.0, (tower / 4) as f64 * 8.0 - 12.0);
            let j = i % 16;
            let (x, y, layer) = ((j % 2) as f64, ((j / 2) % 2) as f64, (j / 4) as f64);
            one(format!("yard.{i:03}"), [tx + x * 0.82, ty + y * 0.82, 0.41 + layer * 0.81], cube(0.4))
        })
        .collect()
}

/// 12 balls on ball joints, held at one end and released horizontal.
fn chain() -> (Vec<BodyDesc>, Vec<JointDesc>) {
    let mut bodies = Vec::new();
    let mut joints = Vec::new();
    for i in 0..12 {
        let key = format!("link.{i:02}");
        bodies.push(one(key.clone(), [0.35 * (i as f64 + 1.0), 0.0, 8.0], Shape::Sphere { radius: 0.15 }));
        let previous = (i > 0).then(|| format!("link.{:02}", i - 1));
        let anchor_b = match previous {
            Some(_) => [0.175, 0.0, 0.0],
            None => [0.175, 0.0, 8.0],
        };
        joints.push(JointDesc::new(format!("j.{i:02}"), key, previous.as_deref(), JointType::Ball, [-0.175, 0.0, 0.0], anchor_b));
    }
    (bodies, joints)
}

/// Four hinged doors driven by motors into two crates each.
fn doors() -> (Vec<BodyDesc>, Vec<JointDesc>) {
    let mut bodies = Vec::new();
    let mut joints = Vec::new();
    for i in 0..4u32 {
        let cx = -6.0 + 4.0 * i as f64;
        let key = format!("door.{i}");
        bodies.push(one(key.clone(), [cx, 0.0, 1.0], Shape::Box { half: [0.6, 0.05, 1.0] }));
        let mut hinge = JointDesc::new(format!("hinge.{i}"), key, None, JointType::Hinge, [-0.6, 0.0, 0.0], [cx - 0.6, 0.0, 1.0]);
        hinge.axis = Some([0.0, 0.0, 1.0]);
        hinge.limits = Some([-1.3, 1.3]);
        let direction = if i.is_multiple_of(2) { 1.0 } else { -1.0 };
        hinge.motor = Some(Motor { target_vel: Some(direction), damping: Some(5.0), max_force: Some(30.0), ..Motor::default() });
        joints.push(hinge);
        for (side, y) in [(0, 0.8), (1, -0.8)] {
            bodies.push(one(format!("crate.{i}.{side}"), [cx + 0.2, y, 0.3], cube(0.3)));
        }
    }
    (bodies, joints)
}

fn ccd_key(i: usize) -> String {
    format!("ccd.{i:02}")
}

fn ccd_start(i: usize) -> Vec3 {
    [-20.0, (i as f64 - 7.5) * 1.2, 3.0 + (i % 4) as f64]
}

fn ccd_balls() -> Vec<BodyDesc> {
    (0..CCD_BALLS)
        .map(|i| {
            let mut desc = one(ccd_key(i), ccd_start(i), Shape::Sphere { radius: CCD_RADIUS });
            desc.ccd = true;
            desc
        })
        .collect()
}

/// A CCD ball's shot: back to its start, then 40 m/s (even) or 110 m/s (odd) at the wall.
fn fire(i: usize) -> Vec<Command> {
    let speed = if i.is_multiple_of(2) { 40.0 } else { 110.0 };
    let key = ccd_key(i);
    let options = SetPoseOptions { reset_velocity: true, wake: true };
    vec![
        Command::SetPose { key: key.clone(), pose: Pose::at(ccd_start(i)), options },
        Command::SetVelocity { key, linvel: Some([speed, 0.0, 0.0]), angvel: None },
    ]
}

fn impulse(key: &str, j: Vec3) -> Command {
    Command::Impulse { key: key.to_string(), j, at: None }
}

fn command_key(command: &Command) -> Option<&str> {
    match command {
        Command::Impulse { key, .. } | Command::SetVelocity { key, .. } | Command::SetPose { key, .. } => Some(key),
        _ => None,
    }
}

// ---- Worlds -------------------------------------------------------------------------------------

fn bare(plan: &Plan) -> World {
    let mut world = World::create(&plan.desc).expect("a valid world");
    world.add_static_world(&plan.statics).expect("the static world");
    world
}

fn open(plan: &Plan) -> World {
    let mut world = bare(plan);
    for body in &plan.bodies {
        world.spawn(body).expect("spawns");
    }
    for joint in &plan.joints {
        world.add_joint(joint).expect("joins");
    }
    world
}

fn spawn_canonical(client: &mut World, server: &World, desc: &BodyDesc) {
    let text = server.body_desc_canonical(desc).expect("the server's own descriptor");
    let value: Value = serde_json::from_str(&text).expect("canonical JSON");
    client.apply_json_atomic(&json!([{ "spawn": value }])).expect("the client spawns it");
}

/// A client with another history: the plan's bodies (those in `view`, or all) spawned from their
/// canonical descriptors in reverse key order, its joints likewise, then a few steps on its own.
fn client_of(plan: &Plan, server: &World, view: Option<&BTreeSet<String>>) -> World {
    let mut client = bare(plan);
    for desc in plan.bodies.iter().rev().filter(|d| view.is_none_or(|v| v.contains(&d.key))) {
        spawn_canonical(&mut client, server, desc);
    }
    for joint in plan.joints.iter().rev() {
        let text = server.joint_desc_canonical(joint).expect("the server's own joint");
        let value: Value = serde_json::from_str(&text).expect("canonical JSON");
        client.apply_json_atomic(&json!([{ "addJoint": value }])).expect("the client adds it");
    }
    for _ in 0..CLIENT_OWN_STEPS {
        client.step().expect("steps on its own");
    }
    client
}

fn dynamic_keys(plan: &Plan) -> Vec<String> {
    plan.bodies.iter().filter(|b| b.body_type == BodyType::Dynamic).map(|b| b.key.clone()).collect()
}

fn net(world: &World, key: &str) -> NetBodyState {
    world.export_body_state(key).expect("a live body")
}

/// The flat export with the timer (15 f32 per body) of `keys`.
fn flat_rows(world: &World, keys: &[String]) -> Vec<f32> {
    let mut data = Vec::with_capacity(keys.len() * 15);
    for key in keys {
        let s = net(world, key);
        data.extend(s.p.iter().chain(&s.q).chain(&s.v).chain(&s.w).map(|v| *v as f32));
        data.push(f32::from(u8::from(s.sleeping)));
        data.push(s.rest.expect("an export gives the timer") as f32);
    }
    data
}

/// The host's wire rows of `keys` (PROTOCOL §17.10, as `tests/canonical.rs` writes them).
fn wire_rows(world: &World, keys: &[String]) -> Vec<f32> {
    let inner_dt = world.desc().inner_dt();
    let mut data = Vec::with_capacity(keys.len() * 15);
    for key in keys {
        let s = net(world, key);
        let unsigned = |v: f64| if v == 0.0 { 0.0 } else { v as f32 };
        data.extend(s.p.map(unsigned));
        data.extend(s.q.map(|c| quantize(c, WIRE_ORIENTATION) as f32));
        data.extend(s.v.map(|c| quantize(c, WIRE_VELOCITY) as f32));
        data.extend(s.w.map(|c| quantize(c, WIRE_VELOCITY) as f32));
        data.push(f32::from(u8::from(s.sleeping)));
        data.push(rest_steps(s.rest.expect("the timer") as f32, inner_dt) as f32);
    }
    data
}

/// The client takes the server's keyframe of `keys` and canonicalizes.
fn adopt(client: &mut World, server: &World, keys: &[String], quantized: bool) {
    match quantized {
        true => client.import_wire(keys, &wire_rows(server, keys)).expect("imports the rows"),
        false => client.import_states_rest(keys, &flat_rows(server, keys)).expect("imports the state"),
    }
    client.canonicalize(CanonicalizeOptions::default()).expect("canonicalizes");
}

/// A body's replicated fields and timer as bits.
fn bits(world: &World, key: &str) -> (Vec<u64>, bool) {
    let s = net(world, key);
    let numbers = s.p.iter().chain(&s.q).chain(&s.v).chain(&s.w).chain(s.rest.iter());
    (numbers.map(|v| v.to_bits()).collect(), s.sleeping)
}

fn distance(a: Vec3, b: Vec3) -> f64 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
}

fn length(v: Vec3) -> f64 {
    distance(v, [0.0; 3])
}

/// The host's speed clamp: every awake body's linear and angular speed at most the wire's range.
fn clamp_speeds(world: &mut World, keys: &[String]) {
    for key in keys {
        let s = net(world, key);
        let (lin, ang) = (length(s.v), length(s.w));
        let scaled = |v: Vec3, speed: f64| (speed > CLAMP_SPEED).then(|| v.map(|c| c * CLAMP_SPEED / speed));
        let (linvel, angvel) = (scaled(s.v, lin), scaled(s.w, ang));
        if linvel.is_some() || angvel.is_some() {
            world.set_velocity(key, linvel, angvel).expect("clamps");
        }
    }
}

/// Whether any body's velocity leaves the wire's range (the row would clip it).
fn clips(world: &World, keys: &[String]) -> bool {
    keys.iter().any(|key| {
        let s = net(world, key);
        s.v.iter().chain(&s.w).any(|c| c.abs() > WIRE_SPEED)
    })
}

fn apply(world: &mut World, commands: &[Command], view: Option<&BTreeSet<String>>) {
    let kept: Vec<Command> = commands.iter().filter(|c| view.is_none_or(|v| command_key(c).is_none_or(|k| v.contains(k)))).cloned().collect();
    for outcome in world.apply_each(&kept) {
        outcome.expect("a command");
    }
}

fn summary(mut samples: Vec<f64>) -> Summary {
    if samples.is_empty() {
        return Summary::default();
    }
    samples.sort_by(f64::total_cmp);
    let mean = samples.iter().sum::<f64>() / samples.len() as f64;
    let at = ((samples.len() as f64 * 0.99).ceil() as usize).clamp(1, samples.len()) - 1;
    Summary { mean, p99: samples[at] }
}

fn micros(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1e6
}

// ---- Runs ---------------------------------------------------------------------------------------

/// The server alone: timing, positions per tick, sleep, CCD tunnels.
fn measure(scene: Scene, hz: u32, mode: Mode, k: u64) -> Measure {
    measure_with(scene, hz, mode, k, DEFAULT_ITERATIONS)
}

/// [`measure`] with `iterations` solver iterations.
fn measure_with(scene: Scene, hz: u32, mode: Mode, k: u64, iterations: u32) -> Measure {
    let plan = scene.plan_with(hz, iterations);
    let keys = dynamic_keys(&plan);
    let mut world = open(&plan);
    let interval = mode.interval(k);
    let ticks = SECONDS * u64::from(hz);
    let (mut steps, mut canons) = (Vec::new(), Vec::new());
    let mut positions = Vec::new();
    let mut asleep_at = None;
    let mut tunnelled = BTreeSet::new();
    let mut clipped_keyframes = 0;
    let mut awake_after_sleep = 0;
    for t in 0..ticks {
        apply(&mut world, &scene.commands(t, hz), None);
        let start = Instant::now();
        world.step().expect("steps");
        steps.push(micros(start));
        if mode.clamps() {
            clamp_speeds(&mut world, &keys);
        }
        let tick = world.tick();
        if interval.is_some_and(|every| tick.is_multiple_of(every)) {
            clipped_keyframes += usize::from(mode.quantizes() && clips(&world, &keys));
            let start = Instant::now();
            world.canonicalize(CanonicalizeOptions { quantize: mode.quantizes() }).expect("canonicalizes");
            canons.push(micros(start));
        }
        let now: Vec<Vec3> = keys.iter().map(|k| net(&world, k).p).collect();
        if scene == Scene::Ccd {
            let fire = tick / u64::from(hz);
            for (i, p) in now.iter().enumerate() {
                if p[0] > WALL_X + WALL_THICKNESS + CCD_RADIUS {
                    tunnelled.insert((i, fire));
                }
            }
        }
        positions.push(now);
        let awake = world.bodies(&BodyFilter { awake_only: true, ..BodyFilter::default() });
        if asleep_at.is_none() && awake.is_empty() {
            asleep_at = Some(tick);
        }
        awake_after_sleep += usize::from(asleep_at.is_some() && !awake.is_empty());
    }
    let canon_calls = canons.len();
    Measure { positions, asleep_at, step_us: summary(steps), canon_us: summary(canons), canon_calls, tunnels: tunnelled.len(), clipped_keyframes, awake_after_sleep }
}

/// Drift against the reference: the mean over bodies at the end and the worst over the run.
fn drift(run: &Measure, reference: &Measure) -> (f64, f64) {
    let mut worst: f64 = 0.0;
    for (a, b) in run.positions.iter().zip(&reference.positions) {
        for (p, q) in a.iter().zip(b) {
            worst = worst.max(distance(*p, *q));
        }
    }
    let (end, end_ref) = (run.positions.last().expect("ticks"), reference.positions.last().expect("ticks"));
    let mean = end.iter().zip(end_ref).map(|(p, q)| distance(*p, *q)).sum::<f64>() / end.len().max(1) as f64;
    (mean, worst)
}

/// Mean displacement per tick per body over the last 2 s, micrometres.
fn jitter(run: &Measure, hz: u32) -> f64 {
    let window = (JITTER_SECONDS * u64::from(hz)) as usize;
    let tail = &run.positions[run.positions.len() - window - 1..];
    let mut total = 0.0;
    let mut count = 0usize;
    for pair in tail.windows(2) {
        for (p, q) in pair[0].iter().zip(&pair[1]) {
            total += distance(*p, *q);
            count += 1;
        }
    }
    total / count.max(1) as f64 * 1e6
}

/// The exact-rebuild row: a client adopts every keyframe (every K ticks, the server canonicalized
/// as `mode` says; `off` is the control), steps K ticks with the same commands, and is compared
/// with the server bit for bit before the next keyframe.
fn exact_rebuild(scene: Scene, hz: u32, mode: Mode, k: u64) -> Rebuild {
    let plan = scene.plan(hz);
    let keys = dynamic_keys(&plan);
    let mut server = open(&plan);
    let mut client = client_of(&plan, &server, None);
    let mut out = Rebuild::default();
    let mut adopts = Vec::new();
    let mut adopted = false;
    for t in 0..SECONDS * u64::from(hz) {
        let commands = scene.commands(t, hz);
        apply(&mut server, &commands, None);
        server.step().expect("steps");
        apply(&mut client, &commands, None);
        client.step().expect("steps");
        if mode.clamps() {
            clamp_speeds(&mut server, &keys);
            clamp_speeds(&mut client, &keys);
        }
        if !server.tick().is_multiple_of(k) {
            continue;
        }
        if adopted {
            let differing = keys.iter().filter(|key| bits(&client, key) != bits(&server, key)).count();
            out.windows += 1;
            out.windows_mismatched += usize::from(differing > 0);
            out.bodies += keys.len();
            out.bodies_mismatched += differing;
        }
        if mode != Mode::Off {
            server.canonicalize(CanonicalizeOptions { quantize: mode.quantizes() }).expect("canonicalizes");
        }
        let start = Instant::now();
        adopt(&mut client, &server, &keys, mode.quantizes());
        adopts.push(micros(start));
        adopted = true;
    }
    out.adopt_us = summary(adopts);
    out
}

/// The 100 dynamic bodies nearest `viewer`, by distance then key.
fn nearest(world: &World, keys: &[String], viewer: Vec3) -> Vec<String> {
    let mut by_distance: Vec<(f64, &String)> = keys.iter().map(|k| (distance(net(world, k).p, viewer), k)).collect();
    by_distance.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(b.1)));
    let mut view: Vec<String> = by_distance.into_iter().take(VIEW_BODIES).map(|(_, k)| k.clone()).collect();
    view.sort();
    view
}

/// The subset-rebuild row: the client holds only the 100 bodies nearest a viewer (`canonQ` on the
/// server), adopts their wire rows each keyframe and is compared on them K ticks later. A body is
/// pure when no body outside the view was within reach of it at the keyframe.
fn subset_rebuild(scene: Scene, hz: u32, k: u64, viewer: Vec3) -> Subset {
    let plan = scene.plan(hz);
    let keys = dynamic_keys(&plan);
    let radius = |key: &str| {
        let body = plan.bodies.iter().find(|b| b.key == key).expect("planned");
        match body.colliders[0].shape {
            Shape::Box { half } => length(half),
            Shape::Sphere { radius } => radius,
            _ => 1.0,
        }
    };
    let mut server = open(&plan);
    let mut view: Vec<String> = nearest(&server, &keys, viewer);
    let mut in_view: BTreeSet<String> = view.iter().cloned().collect();
    let mut client = client_of(&plan, &server, Some(&in_view));
    let mut pure = BTreeSet::new();
    let mut out = Subset::default();
    let mut errors = Vec::new();
    let mut adopted = false;
    for t in 0..SECONDS * u64::from(hz) {
        let commands = scene.commands(t, hz);
        apply(&mut server, &commands, None);
        server.step().expect("steps");
        apply(&mut client, &commands, Some(&in_view));
        client.step().expect("steps");
        if !server.tick().is_multiple_of(k) {
            continue;
        }
        if adopted {
            out.windows += 1;
            for key in &view {
                let differs = bits(&client, key) != bits(&server, key);
                if differs {
                    errors.push(distance(net(&client, key).p, net(&server, key).p));
                }
                let is_pure = pure.contains(key);
                out.pure += usize::from(is_pure);
                out.pure_mismatched += usize::from(is_pure && differs);
                out.boundary += usize::from(!is_pure);
                out.boundary_mismatched += usize::from(!is_pure && differs);
            }
        }
        server.canonicalize(CanonicalizeOptions { quantize: true }).expect("canonicalizes");
        let next = nearest(&server, &keys, viewer);
        let next_set: BTreeSet<String> = next.iter().cloned().collect();
        for gone in in_view.difference(&next_set) {
            client.remove(gone).expect("leaves the view");
        }
        for desc in plan.bodies.iter().filter(|d| next_set.contains(&d.key) && !in_view.contains(&d.key)) {
            spawn_canonical(&mut client, &server, desc);
        }
        (view, in_view) = (next, next_set);
        adopt(&mut client, &server, &view, true);
        adopted = true;
        let outside: Vec<(Vec3, f64)> = keys.iter().filter(|k| !in_view.contains(*k)).map(|k| (net(&server, k).p, radius(k))).collect();
        pure = view
            .iter()
            .filter(|key| {
                let (p, r) = (net(&server, key).p, radius(key));
                outside.iter().all(|(q, s)| distance(p, *q) > r + s + PURE_MARGIN)
            })
            .cloned()
            .collect();
    }
    let error = summary(errors.clone());
    out.error_p99 = error.p99;
    out.error_max = errors.iter().copied().fold(0.0, f64::max);
    out
}

// ---- Report -------------------------------------------------------------------------------------

fn seconds(tick: Option<u64>, hz: u32) -> String {
    match tick {
        Some(t) => format!("{:.2} s ({t})", t as f64 / f64::from(hz)),
        None => "never".to_string(),
    }
}

fn ratio(part: usize, whole: usize) -> String {
    match whole {
        0 => "—".to_string(),
        _ => format!("{part}/{whole} ({:.1}%)", 100.0 * part as f64 / whole as f64),
    }
}

fn main_matrix() {
    println!("## Main matrix\n");
    println!("| Scene | Hz | K | Mode | Drift end mean (m) | Drift max (m) | Jitter (µm/tick) | All asleep | step µs mean / p99 | canonicalize µs mean / p99 | canonicalize µs per tick | Exact rebuild: windows mismatched | bodies mismatched | client adopt µs mean |");
    println!("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    for scene in MAIN_SCENES {
        for hz in RATES {
            let k = keyframe_interval(hz);
            let reference = measure(scene, hz, Mode::Off, k);
            for mode in Mode::modes_for(scene) {
                let run = match mode {
                    Mode::Off => None,
                    _ => Some(measure(scene, hz, mode, k)),
                };
                let run_ref = run.as_ref().unwrap_or(&reference);
                let (drift_end, drift_max) = drift(run_ref, &reference);
                let jitter_text = match scene.rests() {
                    true => format!("{:.2}", jitter(run_ref, hz)),
                    false => "—".to_string(),
                };
                let per_tick = run_ref.canon_us.mean * run_ref.canon_calls as f64 / run_ref.positions.len() as f64;
                let rebuild = exact_rebuild(scene, hz, mode, k);
                let extra = match scene {
                    Scene::Ccd => format!(" (tunnels {}, clipped keyframes {})", run_ref.tunnels, run_ref.clipped_keyframes),
                    _ => String::new(),
                };
                println!(
                    "| {}{extra} | {hz} | {k} | {} | {drift_end:.2e} | {drift_max:.2e} | {jitter_text} | {} | {:.1} / {:.1} | {:.1} / {:.1} | {per_tick:.1} | {} | {} | {:.1} |",
                    scene.name(),
                    mode.name(),
                    seconds(run_ref.asleep_at, hz),
                    run_ref.step_us.mean,
                    run_ref.step_us.p99,
                    run_ref.canon_us.mean,
                    run_ref.canon_us.p99,
                    ratio(rebuild.windows_mismatched, rebuild.windows),
                    ratio(rebuild.bodies_mismatched, rebuild.bodies),
                    rebuild.adopt_us.mean,
                );
            }
        }
    }
    println!();
}

fn k_sweep() {
    println!("## Keyframe interval sweep, 60 Hz, canonQ\n");
    println!("| Scene | K (patchHz) | Drift end mean (m) | Drift max (m) | Jitter (µm/tick) | All asleep | canonicalize µs per tick | Exact rebuild: windows mismatched |");
    println!("|---|---|---|---|---|---|---|---|");
    let hz = 60;
    for scene in [Scene::Stack5, Scene::Stack20, Scene::Stack5Drop, Scene::Stack10Awake, Scene::Stack20Awake, Scene::Pile, Scene::Crates128] {
        let reference = measure(scene, hz, Mode::Off, 1);
        println!("| {} | off | — | — | {:.2} | {} | — | — |", scene.name(), jitter(&reference, hz), seconds(reference.asleep_at, hz));
        for k in [1, 2, 3, 4, 6] {
            let run = measure(scene, hz, Mode::CanonQ, k);
            let (drift_end, drift_max) = drift(&run, &reference);
            let per_tick = run.canon_us.mean * run.canon_calls as f64 / run.positions.len() as f64;
            let rebuild = exact_rebuild(scene, hz, Mode::CanonQ, k);
            println!(
                "| {} | {k} ({}) | {drift_end:.2e} | {drift_max:.2e} | {:.2} | {} | {per_tick:.1} | {} |",
                scene.name(),
                60 / k,
                jitter(&run, hz),
                seconds(run.asleep_at, hz),
                ratio(rebuild.windows_mismatched, rebuild.windows)
            );
        }
    }
    println!();
}

fn iteration_sweep() {
    println!("## Solver iterations against dropped warm starts, 60 Hz, K 3, canonQ\n");
    println!("| Scene | Iterations | off: all asleep / jitter (µm/tick) / step µs | canonQ: drift end mean (m) / drift max (m) | canonQ: jitter (µm/tick) | canonQ: all asleep | canonQ: step µs + canonicalize µs per tick |");
    println!("|---|---|---|---|---|---|---|");
    let (hz, k) = (60, 3);
    for scene in [Scene::Stack10Awake, Scene::Stack20Awake, Scene::Stack20, Scene::Crates128] {
        for iterations in ITERATION_SWEEP {
            let reference = measure_with(scene, hz, Mode::Off, k, iterations);
            let run = measure_with(scene, hz, Mode::CanonQ, k, iterations);
            let (drift_end, drift_max) = drift(&run, &reference);
            let per_tick = run.canon_us.mean * run.canon_calls as f64 / run.positions.len() as f64;
            println!(
                "| {} | {iterations} | {} / {:.2} / {:.1} | {drift_end:.2e} / {drift_max:.2e} | {:.2} | {} | {:.1} + {per_tick:.1} |",
                scene.name(),
                seconds(reference.asleep_at, hz),
                jitter(&reference, hz),
                reference.step_us.mean,
                jitter(&run, hz),
                seconds(run.asleep_at, hz),
                run.step_us.mean
            );
        }
    }
    println!();
}

/// What a stack ends as: standing (mean end drift under this from `off`, metres).
const STANDS_WITHIN: f64 = 0.1;

/// Gate G0's stacking rows: the decided regime (canonQ at patchHz 20, or 15 at 30 Hz) against
/// `off`, stacks of 5 to 20 at rest and kept awake, the pile and the yard's towers, at 4 and 8
/// solver iterations.
fn g0_stacking() {
    println!("## G0 stacking, canonQ at the decided K, solver iterations 4 and 8\n");
    println!("| Scene | Iterations | Hz | K | off: all asleep / step µs | canonQ: all asleep | canonQ: ticks awake after first sleep | drift end mean / max (m) | stands | jitter (µm/tick) | canonQ: step µs + canonicalize µs per tick |");
    println!("|---|---|---|---|---|---|---|---|---|---|---|");
    let scenes = [
        Scene::Stack5,
        Scene::Stack8,
        Scene::Stack10,
        Scene::Stack15,
        Scene::Stack20,
        Scene::Stack5Drop,
        Scene::Stack8Awake,
        Scene::Stack10Awake,
        Scene::Stack15Awake,
        Scene::Stack20Awake,
        Scene::Pile,
        Scene::Yard,
    ];
    for scene in scenes {
        for iterations in [DEFAULT_ITERATIONS, 8] {
            for hz in RATES {
                let k = keyframe_interval(hz);
                let reference = measure_with(scene, hz, Mode::Off, k, iterations);
                let run = measure_with(scene, hz, Mode::CanonQ, k, iterations);
                let (drift_end, drift_max) = drift(&run, &reference);
                let stands = if drift_end < STANDS_WITHIN { "yes" } else { "**no**" };
                let per_tick = run.canon_us.mean * run.canon_calls as f64 / run.positions.len() as f64;
                println!(
                    "| {} | {iterations} | {hz} | {k} | {} / {:.1} | {} | {} | {drift_end:.2e} / {drift_max:.2e} | {stands} | {:.2} | {:.1} + {per_tick:.1} |",
                    scene.name(),
                    seconds(reference.asleep_at, hz),
                    reference.step_us.mean,
                    seconds(run.asleep_at, hz),
                    run.awake_after_sleep,
                    jitter(&run, hz),
                    run.step_us.mean
                );
            }
        }
    }
    println!();
}

fn subset_rows() {
    println!("## Subset rebuild (100 bodies nearest the viewer, canonQ)\n");
    println!("| Scene | Hz | K | Windows | Pure body-windows mismatched | Boundary body-windows mismatched | Position error at a mismatch p99 / max (m) |");
    println!("|---|---|---|---|---|---|---|");
    for (scene, viewer) in [(Scene::Pile, [-6.0, -6.0, 1.0]), (Scene::Crates128, [-6.0, -6.0, 1.0]), (Scene::Yard, [-16.0, -16.0, 1.0])] {
        for hz in RATES {
            let k = keyframe_interval(hz);
            let s = subset_rebuild(scene, hz, k, viewer);
            println!(
                "| {} | {hz} | {k} | {} | {} | {} | {:.2e} / {:.2e} |",
                scene.name(),
                s.windows,
                ratio(s.pure_mismatched, s.pure),
                ratio(s.boundary_mismatched, s.boundary),
                s.error_p99,
                s.error_max
            );
        }
    }
    println!();
}

fn server_cpu() {
    println!("## Server CPU, 128 crates kept awake\n");
    println!("| Hz | K | Mode | step µs mean / p99 | canonicalize µs mean / p99 | CPU ms per simulated second | of one core |");
    println!("|---|---|---|---|---|---|---|");
    for hz in RATES {
        let k = keyframe_interval(hz);
        for mode in [Mode::Off, Mode::CanonQ, Mode::Ws0] {
            let run = measure(Scene::Crates128, hz, mode, k);
            let ms = (run.step_us.mean * run.positions.len() as f64 + run.canon_us.mean * run.canon_calls as f64) / 1e3 / SECONDS as f64;
            println!(
                "| {hz} | {k} | {} | {:.1} / {:.1} | {:.1} / {:.1} | {ms:.2} | {:.2}% |",
                mode.name(),
                run.step_us.mean,
                run.step_us.p99,
                run.canon_us.mean,
                run.canon_us.p99,
                ms / 10.0
            );
        }
    }
    println!();
}

/// A trace of one run for reading by eye: per tick, the awake count and the top body's state.
fn trace(scene: Scene, hz: u32, mode: Mode, k: u64, ticks: u64) {
    let plan = scene.plan(hz);
    let keys = dynamic_keys(&plan);
    let top = keys.last().expect("a body").clone();
    let mut world = open(&plan);
    for t in 0..ticks {
        apply(&mut world, &scene.commands(t, hz), None);
        world.step().expect("steps");
        let tick = world.tick();
        let before = net(&world, &top);
        let keyframe = mode.interval(k).is_some_and(|every| tick.is_multiple_of(every));
        if keyframe {
            world.canonicalize(CanonicalizeOptions { quantize: mode.quantizes() }).expect("canonicalizes");
        }
        let after = net(&world, &top);
        let awake = world.bodies(&BodyFilter { awake_only: true, ..BodyFilter::default() }).len();
        println!(
            "{tick} kf={keyframe} awake={awake} {top} p={:?} v={:?} w={:?} sleeping={} rest={:?} | after: sleeping={} rest={:?} v={:?}",
            before.p, before.v, before.w, before.sleeping, before.rest, after.sleeping, after.rest, after.v
        );
    }
}

fn main() {
    let only = std::env::args().nth(1).unwrap_or_default();
    let wants = |name: &str| only.is_empty() || only == name;
    println!("# R2-0b checkpoint experiment ({}; {SECONDS} s simulated per run)\n", genex_physics::build_id());
    if only == "trace" {
        trace(Scene::Stack5, 60, Mode::Canon, 3, 90);
        return;
    }
    if wants("cpu") {
        server_cpu();
    }
    if wants("subset") {
        subset_rows();
    }
    if wants("iterations") {
        iteration_sweep();
    }
    if wants("sweep") {
        k_sweep();
    }
    if wants("main") {
        main_matrix();
    }
    if wants("g0") {
        g0_stacking();
    }
}
