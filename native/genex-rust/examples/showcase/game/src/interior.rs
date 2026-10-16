//! The cabin's room (Lakeside v2, renderer pass 2 plan section 6): a plank floor on the stone
//! footing, a hearth burning at the chimney's foot, a table with an oil lamp and two chairs, a bed
//! under a wool blanket, a shelf of jars and a rug. The front door stands open, so the low sun
//! lays a long patch of light across the floor. A reflection probe (A.3) gives the varnished table
//! and the floor the room's own reflection instead of the sky's, and an irradiance volume (A.4)
//! lights the room with its own bounced light (the hearth's glow off the stone and the logs), while
//! the sky stays outside its walls. Every flicker derives from the world's tick.

use genex::math::{self, Quat, Vec3, vec3};
use genex::prelude::*;
use genex::render::{IrradianceVolume, ReflectionProbe};

use crate::draw::{CABIN_DEPTH, CABIN_WIDTH, DOOR_HALF_WIDTH, DOOR_HEIGHT, LOG_RADIUS, Local, RIDGE_RISE, WALL_HEIGHT, cabin_frame, roof_run_drop};
use crate::world::World;

/// The room's inside faces in the cabin's frame: the side logs' and the front and back logs' inner
/// faces, the floor and the ridge.
const ROOM_HALF_WIDTH: f32 = CABIN_WIDTH * 0.5 - 0.1 - LOG_RADIUS;
const ROOM_HALF_DEPTH: f32 = CABIN_DEPTH * 0.5 - LOG_RADIUS;
/// How far up the probe's and the volume's box reaches: under the ridge.
const ROOM_TOP: f32 = WALL_HEIGHT + 1.2;
/// How far past the box's faces the probe and the volume fade out: about the logs' thickness, so
/// the yard outside keeps the sky's light.
const ROOM_BLEND: f32 = 0.35;
/// The volume's bounced light, under what it bakes: the room keeps dark corners between the
/// hearth, the lamp and the doorway's sun (at 1 the bounce lit the room evenly and auto exposure
/// flattened it).
const ROOM_BOUNCE: f32 = 0.35;
/// Where the probe's cube is captured from (cabin frame): eye height, near the room's middle.
const PROBE_CAPTURE: Vec3 = vec3(0.3, 1.5, 0.0);

/// The hearth's fire: its colour, its light (scene units, like a lantern's) and reach, and its glow.
const FIRE: Color = Color::rgb(255, 150, 76);
const FIRE_INTENSITY: f32 = 1.6;
const FIRE_RANGE: f32 = 4.5;
const EMBER_GLOW: f32 = 6.0;
/// The table lamp's flame, its light and reach, and its chimney glass's glow.
const LAMP: Color = Color::rgb(255, 196, 136);
const LAMP_INTENSITY: f32 = 0.9;
const LAMP_RANGE: f32 = 3.5;
const LAMP_GLOW: f32 = 2.4;

/// The room's colours (sRGB): soot in the firebox, the varnished table and chairs, the wool
/// blanket, the linen, the rug and the jars.
const SOOT: Color = Color::rgb(8, 6, 5);
const VARNISH: Color = Color::rgb(92, 62, 40);
const BLANKET: Color = Color::rgb(138, 38, 32);
const LINEN: Color = Color::rgb(222, 214, 196);
const RUG: Color = Color::rgb(86, 54, 42);
const JARS: [Color; 3] = [Color::rgb(92, 120, 70), Color::rgb(176, 120, 52), Color::rgb(196, 190, 170)];

/// The chinking between the log courses: lime mortar, and how thick its band is about each
/// wall's mid-plane (the logs touch there; 0.22 m fills the grooves to an 8 cm strip of mortar).
const CHINKING: Color = Color::rgb(170, 160, 140);
const CHINKING_THICKNESS: f32 = 0.16;
/// The side walls' mid-planes (`draw::log_walls` lays the side logs there).
const SIDE_WALL: f32 = CABIN_WIDTH * 0.5 - 0.1;

/// Where the table stands (cabin frame, on the floor) and its top's height.
const TABLE: Vec3 = vec3(0.7, 0.0, -0.5);
const TABLE_TOP: f32 = 0.76;
/// The chimney stack's room-facing side (x) and its centre along z (`draw::cabin` places it).
const HEARTH_FACE: f32 = -CABIN_WIDTH * 0.5 + 0.9 + 0.475;
const HEARTH_Z: f32 = -0.9;

/// The room's box in the world: the cabin's yawed room bounded on the world's axes (the probe and
/// the volume are axis-aligned boxes), from the floor to under the ridge.
pub fn room_box() -> (Vec3, Vec3) {
    let c = cabin_frame();
    let corners = [(-1.0, -1.0), (1.0, -1.0), (-1.0, 1.0), (1.0, 1.0)].map(|(sx, sz)| c.point(vec3(sx * ROOM_HALF_WIDTH, 0.0, sz * ROOM_HALF_DEPTH)));
    let min = corners.iter().fold(Vec3::splat(f32::MAX), |least, p| least.min(*p));
    let max = corners.iter().fold(Vec3::splat(f32::MIN), |most, p| most.max(*p));
    (vec3(min.x, c.origin.y, min.z), vec3(max.x, c.origin.y + ROOM_TOP, max.z))
}

/// How bright the hearth burns at `t` (about 1): two slow swells and a quick lick.
pub fn fire_flicker(t: f32) -> f32 {
    0.86 + 0.08 * math::sin(t * 3.1) + 0.04 * math::sin(t * 7.7 + 1.3) + 0.02 * math::sin(t * 17.0)
}

/// The room: the probe and the volume over it, its floor, the hearth, the furniture and the lamp.
pub fn room(world: &World, frame: &mut Frame, t: f32) {
    frame.tag("cabin-inside");
    let c = cabin_frame();
    let (min, max) = room_box();
    frame.reflection_probe(&ReflectionProbe::new(min, max).with_capture(c.point(PROBE_CAPTURE)).with_blend(ROOM_BLEND));
    frame.irradiance_volume(&IrradianceVolume::new(min, max).with_blend(ROOM_BLEND).with_intensity(ROOM_BOUNCE));
    let surfaces = &world.models.surfaces;
    c.model(frame, &world.models.parts.floor, vec3(0.0, 0.02, 0.0), Quat::IDENTITY, Vec3::ONE, &surfaces.floor);
    ceiling(world, frame, &c);
    hearth(world, frame, &c, t);
    furniture(world, frame, &c);
    lamp(world, frame, &c, t);
    chinking(frame, &c);
}

/// The mortar in the log walls' grooves: a band along each wall's mid-plane from corner to
/// corner, the front's left and right of the doorway and over its head (the doorway stays open).
fn chinking(frame: &mut Frame, c: &Local) {
    frame.tag("chinking");
    let mortar = Material::color(CHINKING).with_roughness(0.95);
    let half_depth = CABIN_DEPTH * 0.5;
    let wall = |frame: &mut Frame, from: f32, to: f32, bottom: f32, z: f32| {
        c.cube_with(frame, vec3((from + to) * 0.5, (bottom + WALL_HEIGHT) * 0.5, z), vec3(to - from, WALL_HEIGHT - bottom, CHINKING_THICKNESS), &mortar);
    };
    wall(frame, -SIDE_WALL, SIDE_WALL, 0.0, -half_depth);
    wall(frame, -SIDE_WALL, -DOOR_HALF_WIDTH, 0.0, half_depth);
    wall(frame, DOOR_HALF_WIDTH, SIDE_WALL, 0.0, half_depth);
    wall(frame, -DOOR_HALF_WIDTH, DOOR_HALF_WIDTH, DOOR_HEIGHT + 0.05, half_depth);
    for x in [-SIDE_WALL, SIDE_WALL] {
        c.cube_with(frame, vec3(x, WALL_HEIGHT * 0.5, 0.0), vec3(CHINKING_THICKNESS, WALL_HEIGHT, CABIN_DEPTH), &mortar);
    }
}

/// The boards under the roof's two panels, from the ridge to the walls' top (inside, the room
/// sees planks, not the slates).
fn ceiling(world: &World, frame: &mut Frame, c: &Local) {
    let (run, drop) = roof_run_drop();
    let pitch = math::atan2(drop, run);
    let slope = math::hypot(run, drop) + 0.1;
    let inside = CABIN_DEPTH * 0.5 / math::cos(pitch);
    let scale = vec3(2.0 * ROOM_HALF_WIDTH / (CABIN_WIDTH + 1.3), 0.2, inside / slope);
    for side in [-1.0_f32, 1.0] {
        let along = CABIN_DEPTH * 0.25;
        // The panel's mid-line height at `along` from the ridge, less half its thickness and the board's.
        let y = WALL_HEIGHT + RIDGE_RISE + 0.12 - drop * 0.5 + (run * 0.5 - along) * drop / run - 0.1 / math::cos(pitch);
        let tilt = Quat::from_rotation_x(side * pitch);
        c.model(frame, &world.models.parts.roof, vec3(0.0, y, side * along), tilt, scale, &world.models.surfaces.planks);
    }
}

/// The hearth at the chimney's foot: a sooty firebox, a stone slab before it, three burning logs
/// and the fire's light.
fn hearth(world: &World, frame: &mut Frame, c: &Local, t: f32) {
    let surfaces = &world.models.surfaces;
    let flicker = fire_flicker(t);
    c.cube_with(frame, vec3(HEARTH_FACE + 0.02, 0.4, HEARTH_Z), vec3(0.06, 0.66, 0.7), &Material::color(SOOT).with_roughness(1.0));
    c.cube_with(frame, vec3(HEARTH_FACE + 0.3, 0.04, HEARTH_Z), vec3(0.6, 0.06, 1.1), &surfaces.stone);
    let embers = Material::emissive(FIRE, EMBER_GLOW * flicker);
    // Three logs (a unit cylinder laid along z from its start): two crossed, one on top.
    for (dz, y, tilt) in [(-0.12_f32, 0.13_f32, 0.25_f32), (0.1, 0.13, -0.2), (0.0, 0.21, 0.0)] {
        let at = vec3(HEARTH_FACE + 0.16, y, HEARTH_Z + dz - 0.21);
        c.model(frame, &world.models.cylinder, at, Quat::from_rotation_y(tilt) * Quat::from_rotation_x(math::FRAC_PI_2), vec3(0.09, 0.42, 0.09), &embers);
    }
    frame.point_light(c.point(vec3(HEARTH_FACE + 0.45, 0.5, HEARTH_Z)), FIRE_RANGE, FIRE, FIRE_INTENSITY * flicker);
}

/// The table and its chairs, the bed, the shelf of jars and the rug.
fn furniture(world: &World, frame: &mut Frame, c: &Local) {
    let surfaces = &world.models.surfaces;
    let varnish = surfaces.planks.clone().with_untextured_color(VARNISH).with_roughness(0.55);
    c.cube_with(frame, TABLE + vec3(0.0, TABLE_TOP, 0.0), vec3(1.4, 0.05, 0.82), &varnish);
    for (x, z) in [(-0.62, -0.34), (0.62, -0.34), (-0.62, 0.34), (0.62, 0.34)] {
        c.cube_with(frame, TABLE + vec3(x, TABLE_TOP * 0.5, z), vec3(0.07, TABLE_TOP, 0.07), &varnish);
    }
    for side in [-1.0_f32, 1.0] {
        chair(frame, c, TABLE + vec3(0.25 * side, 0.0, side * 0.72), side, &varnish);
    }
    // The bed in the back corner, along the side wall.
    let bed = vec3(ROOM_HALF_WIDTH - 0.55, 0.0, -ROOM_HALF_DEPTH + 1.1);
    c.cube_with(frame, bed + vec3(0.0, 0.2, 0.0), vec3(1.0, 0.4, 2.0), &surfaces.planks);
    c.cube_with(frame, bed + vec3(0.0, 0.45, 0.1), vec3(0.96, 0.12, 1.8), &Material::color(BLANKET).with_roughness(0.95));
    c.cube_with(frame, bed + vec3(0.0, 0.5, -0.82), vec3(0.7, 0.12, 0.3), &Material::color(LINEN).with_roughness(0.9));
    // The shelf on the back wall and its jars.
    let shelf_z = -ROOM_HALF_DEPTH + 0.14;
    for y in [1.35, 1.75] {
        c.cube_with(frame, vec3(-0.4, y, shelf_z), vec3(1.5, 0.04, 0.26), &surfaces.planks);
    }
    for (k, x) in [-0.95_f32, -0.65, -0.3, 0.05, 0.3].into_iter().enumerate() {
        let y = if k % 2 == 0 { 1.37 } else { 1.77 };
        let jar = Material::color(JARS[k % JARS.len()]).with_roughness(0.25);
        c.model(frame, &world.models.cylinder, vec3(x, y, shelf_z), Quat::IDENTITY, vec3(0.13, 0.2, 0.13), &jar);
    }
    c.cube_with(frame, vec3(0.2, 0.045, 0.4), vec3(2.2, 0.01, 1.5), &Material::color(RUG).with_roughness(1.0));
}

/// A chair facing the table from `side` (its back away from the table).
fn chair(frame: &mut Frame, c: &Local, at: Vec3, side: f32, material: &Material) {
    c.cube_with(frame, at + vec3(0.0, 0.46, 0.0), vec3(0.44, 0.04, 0.42), material);
    for (x, z) in [(-0.19, -0.18), (0.19, -0.18), (-0.19, 0.18), (0.19, 0.18)] {
        c.cube_with(frame, at + vec3(x, 0.23, z), vec3(0.04, 0.46, 0.04), material);
    }
    c.cube_with(frame, at + vec3(0.0, 0.74, side * 0.19), vec3(0.44, 0.5, 0.04), material);
}

/// The oil lamp on the table: a brass foot, its glowing chimney glass and the flame's light.
fn lamp(world: &World, frame: &mut Frame, c: &Local, t: f32) {
    let surfaces = &world.models.surfaces;
    let flicker = 0.95 + 0.05 * math::sin(t * 11.0 + 0.4);
    let foot = TABLE + vec3(-0.25, TABLE_TOP + 0.025, 0.05);
    c.model(frame, &world.models.cylinder, foot, Quat::IDENTITY, vec3(0.14, 0.08, 0.14), &surfaces.iron);
    c.model(frame, &world.models.cylinder, foot + vec3(0.0, 0.08, 0.0), Quat::IDENTITY, vec3(0.08, 0.18, 0.08), &Material::emissive(LAMP, LAMP_GLOW * flicker));
    frame.point_light(c.point(foot + vec3(0.0, 0.2, 0.0)), LAMP_RANGE, LAMP, LAMP_INTENSITY * flicker);
}
