//! GREYBOX: replace before done with the arms kit (`docs/examples/fps-arms/`) or a generated model.
//!
//! The view model: two forearms in jacket sleeves, two gloved hands and a pistol, built from
//! boxes in the camera's frame and drawn under the `hands` tag. Nothing here is a model file, so
//! it reads at every preset and never comes out as a dark slab; swap any part for a GLB later
//! (`frame.model` at the same transform). It moves only from simulation state: sway against the
//! turn, bob from the stride, kick and a slide that cycles from the recoil, and a pull-back from
//! the wall in front. All of it stays further out than the camera's near plane (0.1 m).

use genex::math::{self, Mat3, Quat, Vec3, vec3};
use genex::prelude::*;

use super::World;

/// One draw id for the whole view model, so TAA follows it with the camera instead of smearing it.
const VIEW_MODEL_ID: u64 = 0x5649_4557;
/// Where the pistol's grip sits in the camera's frame (x right, y up, -z ahead), in metres.
const GRIP: Vec3 = vec3(0.08, -0.17, -0.42);
/// How far the turn swings the gun (m per radian) and how quickly the sway catches up (per tick).
const SWAY: f32 = 0.35;
const SWAY_MAX: f32 = 0.04;
const SWAY_FOLLOW: f32 = 0.2;
/// The kick: back along the barrel (m) and up about the grip (radians) at full recoil.
const KICK_BACK: f32 = 0.06;
const KICK_UP: f32 = 0.22;
/// The muzzle flash lasts this many ticks after a shot.
const FLASH_TICKS: u64 = 2;

/// The sway's lagging offset, in the camera's x and y.
#[derive(Default)]
pub struct Sway(Vec2);

/// The view model's surfaces.
struct Look {
    glove: Material,
    sleeve: Material,
    polymer: Material,
    steel: Material,
}

impl Look {
    fn new() -> Look {
        Look {
            // Mid-tone gloves and sleeves: near-black ones read as one dark slab in a capture.
            glove: Material::color(Color::rgb(96, 82, 62)).with_roughness(0.7),
            sleeve: Material::color(Color::rgb(68, 74, 58)).with_roughness(0.92),
            polymer: Material::color(Color::rgb(30, 30, 32)).with_roughness(0.6),
            steel: Material::color(Color::rgb(70, 72, 76)).with_metallic(0.85).with_roughness(0.35),
        }
    }
}

/// Register the sway and the draw.
pub fn wire(game: &mut Game<World>) {
    game.facet_state::<Sway>();
    game.on_update(|sim, _ctx| {
        let turned = sim.world.turned;
        let sway = sim.facets.get_mut::<Sway>();
        let wish = (vec2(-turned.x, turned.y) * SWAY).clamp_length_max(SWAY_MAX);
        sway.0 += (wish - sway.0) * SWAY_FOLLOW;
    });
    game.on_draw(|sim, frame, camera| {
        draw(&sim.world, sim.facets.get::<Sway>().0, frame, camera);
    });
}

/// The camera's turn: its local x right, y up and z back, in the world.
fn view_turn(camera: &Camera) -> Quat {
    let back = (camera.position - camera.target).normalize_or(Vec3::Z);
    let right = camera.up.cross(back).normalize_or(Vec3::X);
    Quat::from_mat3(&Mat3::from_cols(right, back.cross(right), back))
}

/// Where the gun is in the camera's frame this tick, and its turn there.
fn gun_pose(world: &World, sway: Vec2) -> (Vec3, Quat) {
    let phase = world.stride / 0.75 * std::f32::consts::PI;
    let size = (world.speed / 3.0).min(1.5);
    let bob = vec3(math::sin(phase) * 0.006, -math::cos(phase * 2.0).abs() * 0.008, 0.0) * size;
    let pull = vec3(0.0, -world.wall_pull * 0.4, world.wall_pull);
    let at = GRIP + vec3(sway.x, sway.y, 0.0) + bob + pull + Vec3::Z * KICK_BACK * world.recoil;
    let turn = Quat::from_rotation_x(KICK_UP * world.recoil) * Quat::from_rotation_y(-0.04);
    (at, turn)
}

/// The muzzle, in the world: where the flash and its light go.
fn muzzle(world: &World, sway: Vec2, camera: &Camera) -> Vec3 {
    let (at, turn) = gun_pose(world, sway);
    camera.position + view_turn(camera) * (at + turn * vec3(0.0, 0.035, -0.19))
}

fn draw(world: &World, sway: Vec2, frame: &mut Frame, camera: &Camera) {
    let look = Look::new();
    let view = view_turn(camera);
    let (at, turn) = gun_pose(world, sway);
    // A part: its centre and size in the gun's frame, turned by `tilt` about its own centre.
    let part = |frame: &mut Frame, center: Vec3, size: Vec3, tilt: Quat, material: &Material| {
        let local = at + turn * center;
        let transform = Transform::from_translation(camera.position + view * local).with_rotation(view * turn * tilt).with_scale(size);
        frame.cube_with(transform, material);
    };
    frame.tag("hands").id(VIEW_MODEL_ID);
    // The pistol: frame, slide (cycling back with the recoil), grip raked back, guard and sights.
    let slide = Vec3::Z * 0.03 * (world.recoil * 2.0).min(1.0);
    part(frame, vec3(0.0, 0.012, -0.06), vec3(0.028, 0.022, 0.17), Quat::IDENTITY, &look.polymer);
    part(frame, vec3(0.0, 0.036, -0.075) + slide, vec3(0.03, 0.03, 0.19), Quat::IDENTITY, &look.steel);
    part(frame, vec3(0.0, -0.045, 0.0), vec3(0.03, 0.1, 0.048), Quat::from_rotation_x(0.28), &look.polymer);
    part(frame, vec3(0.0, -0.012, -0.045), vec3(0.008, 0.006, 0.05), Quat::IDENTITY, &look.polymer);
    part(frame, vec3(0.0, 0.055, -0.16) + slide, vec3(0.005, 0.009, 0.006), Quat::IDENTITY, &look.steel);
    part(frame, vec3(0.0, 0.055, 0.0) + slide, vec3(0.026, 0.009, 0.007), Quat::IDENTITY, &look.steel);
    // The right hand round the grip: palm, three fingers over the front strap, the index finger
    // along the frame and the thumb down the far side.
    part(frame, vec3(0.012, -0.05, 0.025), vec3(0.05, 0.095, 0.06), Quat::from_rotation_x(0.28), &look.glove);
    for i in 0..3 {
        part(frame, vec3(0.004, -0.03 - i as f32 * 0.024, -0.03), vec3(0.068, 0.02, 0.028), Quat::IDENTITY, &look.glove);
    }
    part(frame, vec3(0.021, 0.0, -0.05), vec3(0.013, 0.015, 0.055), Quat::IDENTITY, &look.glove);
    part(frame, vec3(-0.021, 0.004, -0.025), vec3(0.013, 0.016, 0.06), Quat::IDENTITY, &look.glove);
    // The support hand cupped from the left: its palm on the grip's side, its fingers over the
    // right hand's, its thumb forward along the frame.
    part(frame, vec3(-0.036, -0.05, -0.005), vec3(0.026, 0.09, 0.075), Quat::from_rotation_y(0.2), &look.glove);
    part(frame, vec3(0.0, -0.06, -0.052), vec3(0.08, 0.055, 0.02), Quat::from_rotation_x(0.28), &look.glove);
    part(frame, vec3(-0.024, 0.008, -0.07), vec3(0.013, 0.015, 0.05), Quat::IDENTITY, &look.glove);
    // The forearms rise from below the chest camera to the wrists, a cuff at each wrist.
    for (wrist, elbow) in [(vec3(0.02, -0.08, 0.07), vec3(0.12, -0.34, 0.3)), (vec3(-0.05, -0.08, 0.04), vec3(-0.18, -0.34, 0.28))] {
        let along = (elbow - wrist).normalize();
        let tilt = Quat::from_rotation_arc(Vec3::NEG_Z, along);
        part(frame, (wrist + elbow) * 0.5, vec3(0.07, 0.065, (elbow - wrist).length()), tilt, &look.sleeve);
        part(frame, wrist + along * 0.03, vec3(0.08, 0.075, 0.05), tilt, &look.glove);
    }
    frame.end_id();
    if world.fired_at.is_some_and(|tick| world.tick - tick < FLASH_TICKS) {
        let at = muzzle(world, sway, camera);
        frame.tag("muzzle-flash").sphere_with(at, 0.012, &Material::emissive(Color::rgb(255, 190, 110), 30.0));
        frame.point_light(at, 5.0, Color::rgb(255, 180, 100), 6.0);
    }
}
