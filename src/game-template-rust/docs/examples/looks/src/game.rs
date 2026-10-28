//! GREYBOX: replace every box here before done. This is a light-test stage, not a level: a room
//! with two windows on a street, a facade across it, lamp posts and a terrain for the ground, so
//! each recipe in `looks.rs` can be captured on one set. Copy the recipe of your scene type from
//! `looks.rs`; build your own level as `docs/examples/interior-kit/` and
//! `docs/examples/rooms-and-buildings.md` say (kit pieces, CC0 scans with normal and ORM maps, real
//! props), never from these boxes.
//!
//! The scene type is chosen when the game is wired (`wire(game, Scene::NightStreet)`), so a seed
//! keeps it: `World::default()` never holds it.

use genex::prelude::*;
use genex::render::{IrradianceVolume, ReflectionProbe};
use genex::{Particles, Terrain, TerrainLayer};

use crate::looks::Scene;

/// The room: 8 m by 6 m, a 3.2 m ceiling, its windows in the south wall (+z) onto the street.
const ROOM_MIN: Vec3 = vec3(-4.0, 0.0, -3.0);
const ROOM_MAX: Vec3 = vec3(4.0, 3.2, 3.0);
const WALL: f32 = 0.25;
const WINDOWS: [(f32, f32); 2] = [(-2.9, -1.1), (1.1, 2.9)];
const SILL: f32 = 0.9;
const HEAD: f32 = 2.5;
/// The street runs along x south of the room; the facade across it, and its lamp posts.
const STREET_Z: f32 = 9.0;
const FACADE_Z: f32 = 16.0;
const LAMPS: [f32; 4] = [-12.0, -4.0, 4.0, 12.0];
const LAMP_HEIGHT: f32 = 5.0;
/// Warm sodium-like street lamps and cool fluorescent tubes: colour, glow and light (scene units).
const LAMP: Color = Color::rgb(255, 196, 130);
const LAMP_GLOW: f32 = 8.0;
const LAMP_LIGHT: f32 = 4.0;
const LAMP_RANGE: f32 = 12.0;
const TUBE: Color = Color::rgb(220, 235, 255);
const TUBE_GLOW: f32 = 6.0;
const TUBE_LIGHT: f32 = 2.2;
const TUBE_RANGE: f32 = 6.0;
/// The terrain: 1 m samples over 128 m, flat round the buildings and rising gently past them.
const GROUND_SAMPLES: [u32; 2] = [129, 129];
const GROUND_ORIGIN: Vec2 = vec2(-64.0, -64.0);

/// The stage's state: the ground and the weather, made on every seed.
#[derive(Default)]
pub struct World {
    /// Ticks since the seed: the weather falls by it.
    pub tick: u64,
    /// The ground, one terrain coloured for the scene.
    pub ground: Option<Terrain>,
    /// Snow or rain over the street, when the scene has weather.
    pub weather: Option<Particles>,
}

/// Register the stage's hooks for `scene`.
pub fn wire(game: &mut Game<World>, scene: Scene) {
    game.on_reset(move |sim, _seed, _rng, _gfx| {
        sim.world.ground = Some(ground(scene));
        sim.world.weather = weather(scene);
    });
    game.on_update(|sim, _ctx| sim.world.tick += 1);
    game.on_draw(move |sim, frame, _camera| draw(&sim.world, frame, scene));
    game.camera(move |_sim| main_camera(scene));
    game.named_camera("room", |_sim| Camera { fovy: 62.0, ..Camera::look_at(vec3(-3.2, 1.6, -2.4), vec3(1.0, 1.2, 3.0)) });
    game.named_camera("street", |_sim| Camera { fovy: 60.0, ..Camera::look_at(vec3(-14.0, 1.7, STREET_Z), vec3(4.0, 2.0, 12.0)) });
    game.probe("look", move |sim| json!({ "scene": scene.name(), "weather": sim.world.weather.is_some(), "night": scene.night() }));
}

/// Where a scene is judged from: inside the room for an interior, down the street outside.
fn main_camera(scene: Scene) -> Camera {
    if scene.indoors() {
        return Camera { fovy: 62.0, ..Camera::look_at(vec3(-3.2, 1.6, -2.4), vec3(1.0, 1.2, 3.0)) };
    }
    Camera { fovy: 60.0, ..Camera::look_at(vec3(-14.0, 1.7, STREET_Z), vec3(4.0, 2.0, 12.0)) }
}

/// The ground's colour for the scene: snow, sand, grass or asphalt.
fn ground_color(scene: Scene) -> Color {
    match scene {
        Scene::OvercastSnow => Color::rgb(232, 236, 242),
        Scene::Desert => Color::rgb(196, 160, 110),
        Scene::Forest => Color::rgb(60, 82, 40),
        Scene::Rain => Color::rgb(46, 48, 52),
        _ => Color::rgb(92, 92, 90),
    }
}

/// The ground as one terrain: flat inside 30 m, a gentle rise past it.
fn ground(scene: Scene) -> Terrain {
    let rise = |x: f32, z: f32| (x.abs().max(z.abs()) - 30.0).max(0.0) * 0.12;
    Terrain::from_fn(GROUND_SAMPLES, GROUND_ORIGIN, 1.0, rise)
        .expect("the stage's heights")
        .with_layers(vec![TerrainLayer::flat(ground_color(scene))])
        .expect("one flat layer")
}

/// Snow or rain over the street and the room's windows, for the scenes that have weather.
fn weather(scene: Scene) -> Option<Particles> {
    match scene {
        Scene::OvercastSnow => Some(Particles::snow(vec3(0.0, 9.0, STREET_Z), vec3(16.0, 0.0, 8.0))),
        Scene::Rain => Some(Particles::rain(vec3(0.0, 9.0, STREET_Z), vec3(16.0, 0.0, 8.0))),
        _ => None,
    }
}

fn draw(world: &World, frame: &mut Frame, scene: Scene) {
    scene.light(frame);
    frame.tag("ground");
    if let Some(ground) = &world.ground {
        frame.terrain(ground);
    }
    room(frame, scene);
    street(frame, scene);
    if let Some(weather) = &world.weather {
        frame.tag("weather");
        frame.particles(weather);
    }
    // The room gets its own probe and volume on one box, every frame.
    let eye = vec3(0.0, 1.6, 0.0);
    frame.reflection_probe(&ReflectionProbe::new(ROOM_MIN, ROOM_MAX).with_capture(eye).with_blend(WALL));
    frame.irradiance_volume(&IrradianceVolume::new(ROOM_MIN, ROOM_MAX).with_blend(WALL));
}

/// Wet asphalt and paint read darker and glossier in the rain.
fn wet(scene: Scene, roughness: f32) -> f32 {
    if scene == Scene::Rain { roughness * 0.3 } else { roughness }
}

/// The room's shell, its windows' frames and two rows of desks, with tubes lit by night.
fn room(frame: &mut Frame, scene: Scene) {
    frame.tag("room");
    let plaster = Material::color(Color::rgb(196, 190, 176)).with_roughness(0.85);
    let floor = Material::color(Color::rgb(120, 86, 58)).with_roughness(0.55);
    let steel = Material::color(Color::rgb(70, 74, 78)).with_metallic(0.8).with_roughness(0.4);
    let (lo, hi) = (ROOM_MIN, ROOM_MAX);
    block(frame, vec3(lo.x, 0.0, lo.z), vec3(hi.x, 0.03, hi.z), &floor); // above the terrain, never level with it
    block(frame, vec3(lo.x - WALL, hi.y, lo.z - WALL), vec3(hi.x + WALL, hi.y + 0.2, hi.z + WALL), &plaster);
    block(frame, vec3(lo.x - WALL, 0.0, lo.z - WALL), vec3(hi.x + WALL, hi.y, lo.z), &plaster);
    block(frame, vec3(lo.x - WALL, 0.0, lo.z), vec3(lo.x, hi.y, hi.z), &plaster);
    block(frame, vec3(hi.x, 0.0, lo.z), vec3(hi.x + WALL, hi.y, hi.z), &plaster);
    south_wall(frame, &plaster, &steel);
    for z in [-0.8_f32, 1.0] {
        for x in [-2.4_f32, 0.0, 2.4] {
            block(frame, vec3(x - 0.6, 0.72, z - 0.3), vec3(x + 0.6, 0.75, z + 0.3), &floor);
        }
    }
    let glow = if scene.night() { TUBE_GLOW } else { 0.0 };
    for x in [-1.8_f32, 1.8] {
        block(frame, vec3(x - 0.6, hi.y - 0.06, -0.05), vec3(x + 0.6, hi.y - 0.02, 0.05), &Material::emissive(TUBE, glow));
        if scene.night() {
            frame.point_light(vec3(x, hi.y - 0.2, 0.0), TUBE_RANGE, TUBE, TUBE_LIGHT);
        }
    }
}

/// The south wall round its two windows, each window's frame and sill.
fn south_wall(frame: &mut Frame, plaster: &Material, steel: &Material) {
    let (lo, hi) = (ROOM_MIN, ROOM_MAX);
    let (z0, z1) = (hi.z, hi.z + WALL);
    let mut x = lo.x - WALL;
    for (from, to) in WINDOWS {
        block(frame, vec3(x, 0.0, z0), vec3(from, hi.y, z1), plaster);
        block(frame, vec3(from, 0.0, z0), vec3(to, SILL, z1), plaster);
        block(frame, vec3(from, HEAD, z0), vec3(to, hi.y, z1), plaster);
        let mid = z0 + WALL * 0.5;
        for bar in [from, (from + to) * 0.5 - 0.025, to - 0.05] {
            block(frame, vec3(bar, SILL, mid - 0.03), vec3(bar + 0.05, HEAD, mid + 0.03), steel);
        }
        x = to;
    }
    block(frame, vec3(x, 0.0, z0), vec3(hi.x + WALL, hi.y, z1), plaster);
}

/// The street: a kerb, the facade across it and the lamp posts, lit by night.
fn street(frame: &mut Frame, scene: Scene) {
    frame.tag("street");
    let kerb = Material::color(Color::rgb(120, 118, 112)).with_roughness(wet(scene, 0.8));
    let facade = Material::color(Color::rgb(150, 120, 100)).with_roughness(wet(scene, 0.9));
    let pole = Material::color(Color::rgb(40, 42, 44)).with_metallic(0.9).with_roughness(wet(scene, 0.5));
    block(frame, vec3(-30.0, 0.0, STREET_Z - 4.2), vec3(30.0, 0.15, STREET_Z - 4.0), &kerb);
    block(frame, vec3(-30.0, 0.0, FACADE_Z), vec3(30.0, 12.0, FACADE_Z + 4.0), &facade);
    let glow = if scene.night() { LAMP_GLOW } else { 0.0 };
    for x in LAMPS {
        let head = vec3(x, LAMP_HEIGHT, STREET_Z + 4.0);
        block(frame, vec3(x - 0.08, 0.0, head.z - 0.08), vec3(x + 0.08, LAMP_HEIGHT, head.z + 0.08), &pole);
        frame.sphere_with(head, 0.25, &Material::emissive(LAMP, glow));
        if scene.night() {
            frame.spot_light(head - Vec3::Y * 0.3, -Vec3::Y, LAMP_RANGE, LAMP, LAMP_LIGHT);
        }
    }
}

fn block(frame: &mut Frame, min: Vec3, max: Vec3, material: &Material) {
    frame.cube_with(Transform::from_translation((min + max) * 0.5).with_scale(max - min), material);
}
