//! The lab: a ring of movers swept around the floor, timed with game scopes (`lab.update`,
//! `lab.sweep`) and reported with counters (`lab.movers`, `lab.charge`), plus the forced panic: at
//! tick [`PANIC_TICK`], with Overload held, the update hook panics on purpose. Holding Overload
//! also charges the lab (more movers) so the held key changes what the run computes, and a replay
//! that drops the key would not reach the panic.

use genex::actions::{ActionId, ActionMap, Context, ContextId};
use genex::prelude::*;
use genex::profile::{ScopeName, counter};

/// The only context: always on.
pub const LAB: ContextId = ContextId::new("lab");
/// Hold to charge the lab; still held at tick [`PANIC_TICK`], the update hook panics.
pub const OVERLOAD: ActionId = ActionId::new("overload");
/// The key Overload is bound to.
pub const OVERLOAD_KEY: Key = Key::KeyF;

/// The tick the forced panic happens on (ticks since the seed, before this one: `ctx.tick`).
pub const PANIC_TICK: u64 = 300;
/// What the forced panic says (a record's `message`).
pub const PANIC_MESSAGE: &str = "crash-lab: forced panic at tick 300 while Overload is held";

/// The game scope around the whole update hook.
pub const SCOPE_UPDATE: &str = "lab.update";
/// The game scope around the movers' sweep.
pub const SCOPE_SWEEP: &str = "lab.sweep";
/// The counter of movers alive.
pub const MOVERS: ScopeName = ScopeName::new("lab.movers");
/// The counter of the lab's charge.
pub const CHARGE: ScopeName = ScopeName::new("lab.charge");

/// Movers at the start of a run, and the most the charge adds.
const MOVERS_START: usize = 12;
const MOVERS_MAX: usize = 96;
/// Ticks of Overload per extra mover.
const CHARGE_PER_MOVER: u32 = 10;
/// Ring radius and the angle a mover sweeps per tick (radians).
const RING_RADIUS: f32 = 3.0;
const SWEEP_PER_TICK: f32 = 0.02;
/// Work per mover per tick in the sweep (makes the scope measurable, changes nothing it draws).
const SWEEP_WORK: u32 = 64;
/// Camera.
const CAMERA_EYE: [f32; 3] = [0.0, 7.0, 7.5];
const CAMERA_TARGET: [f32; 3] = [0.0, 0.0, 0.0];
/// Colours.
const FLOOR: Color = Color::rgb(52, 58, 70);
const MOVER: Color = Color::rgb(110, 200, 255);
const MOVER_CHARGED: Color = Color::rgb(255, 170, 80);

/// The lab's state (checksummed).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct World {
    /// Each mover's angle on the ring (radians).
    pub movers: Vec<f32>,
    /// Ticks Overload was held.
    pub charge: u32,
    /// Ticks played.
    pub ticks: u64,
    /// The sweep's running sum (the scope's work; a checksum input so it is never optimized out).
    pub sweep: u32,
}

impl World {
    /// A fresh lab: the starting movers spread evenly on the ring.
    pub fn fresh() -> World {
        let movers = (0..MOVERS_START).map(|at| at as f32 * std::f32::consts::TAU / MOVERS_START as f32).collect();
        World { movers, ..World::default() }
    }
}

/// The action map: Overload on F.
pub fn action_map() -> ActionMap {
    ActionMap::new().context(Context::new(LAB, 0).button(OVERLOAD, &[OVERLOAD_KEY.into()]))
}

/// The reset hook: a fresh lab.
pub fn reset(sim: &mut Sim<World>, _seed: u32, _rng: &mut Pcg32, _gfx: &Gfx) {
    sim.world = World::fresh();
}

/// The update hook: charge while Overload is held, sweep the movers, report the counters, and
/// panic on purpose at [`PANIC_TICK`] with Overload held.
pub fn update(sim: &mut Sim<World>, ctx: &Ctx) {
    genex::profile_scope!("lab.update");
    let world = &mut sim.world;
    let overload = ctx.actions.down(OVERLOAD);
    if overload && ctx.tick == PANIC_TICK {
        panic!("{PANIC_MESSAGE}");
    }
    if overload {
        world.charge += 1;
    }
    let wanted = (MOVERS_START + (world.charge / CHARGE_PER_MOVER) as usize).min(MOVERS_MAX);
    while world.movers.len() < wanted {
        let at = world.movers.len() as f32 * 0.61;
        world.movers.push(at);
    }
    sweep(world);
    world.ticks += 1;
    counter(MOVERS, world.movers.len() as f64);
    counter(CHARGE, f64::from(world.charge));
}

/// Move every mover along the ring, with a little integer work per mover under its own scope.
fn sweep(world: &mut World) {
    genex::profile_scope!("lab.sweep");
    let mut sum = world.sweep;
    for angle in &mut world.movers {
        *angle = (*angle + SWEEP_PER_TICK) % std::f32::consts::TAU;
        for step in 0..SWEEP_WORK {
            sum = sum.wrapping_mul(31).wrapping_add(step ^ angle.to_bits());
        }
    }
    world.sweep = sum;
}

/// The draw hook: the floor and the movers (charged movers past the start are orange).
pub fn draw(sim: &Sim<World>, frame: &mut Frame, _camera: &Camera) {
    let world = &sim.world;
    frame.tag("floor").cube(Transform::from_xyz(0.0, -0.1, 0.0).with_scale(Vec3::new(9.0, 0.2, 9.0)), FLOOR);
    frame.tag("movers");
    for (index, angle) in world.movers.iter().enumerate() {
        let (sin, cos) = genex::math::sin_cos(*angle);
        let at = Vec3::new(cos * RING_RADIUS, 0.3, sin * RING_RADIUS);
        let color = if index < MOVERS_START { MOVER } else { MOVER_CHARGED };
        frame.sphere(at, 0.25, color);
    }
}

/// The camera: above and in front of the ring.
pub fn camera() -> Camera {
    Camera::look_at(Vec3::from_array(CAMERA_EYE), Vec3::from_array(CAMERA_TARGET))
}

/// The `lab` probe: what a check reads (movers, charge, ticks).
pub fn lab_probe(sim: &Sim<World>) -> Value {
    let world = &sim.world;
    json!({ "movers": world.movers.len(), "charge": world.charge, "ticks": world.ticks, "sweep": world.sweep })
}
