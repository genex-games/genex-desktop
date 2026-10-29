//! A yard dressed entirely from the Content Library (`docs/api/library.md`): an asphalt yard with a
//! snow-covered strip, a brick wall, a bench, a barrel and a crate under an HDRI sky. Nothing is
//! modelled or imported by hand: each entry was added with `library__add` and is read here in
//! `on_reset` with `gfx.assets().library(id)`, which hands out a material at its real size, a model
//! in metres with its levels, and the sky's environment.
//!
//! Add the entries to a game with:
//!   library__add material/asphalt_01, material/red_brick, material/snow_02,
//!   model/painted_wooden_bench, model/barrel_01, model/wooden_crate_01,
//!   sky/kloofendal_48d_partly_cloudy_puresky
//! An entry that was not added refuses `missing`: the yard then draws its stand-in colour (a
//! material), the checker (a model) or the physical sky, and `state().library.missing` names it.

use genex::prelude::*;
use genex::render::Environment;

/// The library entries the yard draws.
pub const ASPHALT: &str = "material/asphalt_01";
pub const BRICK: &str = "material/red_brick";
pub const SNOW: &str = "material/snow_02";
pub const BENCH: &str = "model/painted_wooden_bench";
pub const BARREL: &str = "model/barrel_01";
pub const CRATE: &str = "model/wooden_crate_01";
pub const SKY: &str = "sky/kloofendal_48d_partly_cloudy_puresky";

/// The yard's ground (x and z from, to), a strip of snow across it, and the wall behind.
const GROUND: (Vec3, Vec3) = (vec3(-12.0, -0.2, -12.0), vec3(12.0, 0.0, 12.0));
const SNOW_STRIP: (Vec3, Vec3) = (vec3(-12.0, 0.0, 2.0), vec3(12.0, 0.03, 6.0));
const WALL: (Vec3, Vec3) = (vec3(-8.0, 0.0, 6.0), vec3(8.0, 2.6, 6.4));
/// Where the props stand (metres) and which way they face (degrees about +y).
const BENCH_AT: Vec3 = vec3(-1.4, 0.0, 4.6);
const BARREL_AT: Vec3 = vec3(1.2, 0.0, 5.2);
const CRATE_AT: Vec3 = vec3(3.6, 0.0, 3.4);
/// Towards the sun: about 35 degrees up, from the camera's left.
const SUN_TOWARDS: Vec3 = vec3(-0.6, 0.7, -0.4);
const SUN_INTENSITY: f32 = 3.0;
/// The camera: a person's eye height, looking at the bench past the crate.
const EYE: Vec3 = vec3(1.5, 1.6, -3.5);
const LOOK_AT: Vec3 = vec3(0.0, 0.9, 4.8);

/// What the yard read from the library at reset.
#[derive(Default)]
pub struct World {
    pub asphalt: Material,
    pub brick: Material,
    pub snow: Material,
    pub bench: Model,
    pub barrel: Model,
    pub crate_box: Model,
    pub sky: Option<Environment>,
    /// The entries this game has not added (each refused `missing`).
    pub missing: Vec<&'static str>,
}

/// Read every entry from the library: what was added draws, what was not is noted.
fn read_library(world: &mut World, assets: &Assets) {
    let mut read = |id: &'static str| match assets.library(id) {
        Ok(asset) => Some(asset),
        Err(_) => {
            world.missing.push(id);
            None
        }
    };
    let asphalt = read(ASPHALT).map(|asset| asset.material());
    let brick = read(BRICK).map(|asset| asset.material());
    let snow = read(SNOW).map(|asset| asset.material());
    let bench = read(BENCH).map(|asset| asset.model());
    let barrel = read(BARREL).map(|asset| asset.model());
    let crate_box = read(CRATE).map(|asset| asset.model());
    let sky = read(SKY).map(|asset| asset.environment());
    world.asphalt = asphalt.unwrap_or_else(|| Material::color(Color::rgb(70, 70, 72)));
    world.brick = brick.unwrap_or_else(|| Material::color(Color::rgb(140, 70, 55)));
    world.snow = snow.unwrap_or_else(|| Material::color(Color::rgb(230, 235, 240)));
    world.bench = bench.unwrap_or_default();
    world.barrel = barrel.unwrap_or_default();
    world.crate_box = crate_box.unwrap_or_default();
    world.sky = sky;
}

/// Register the yard's hooks.
pub fn wire(game: &mut Game<World>) {
    game.on_reset(|sim, _seed, _rng, gfx| {
        sim.world = World::default();
        read_library(&mut sim.world, gfx.assets());
    });
    game.on_draw(|sim, frame, _camera| draw(&sim.world, frame));
    game.camera(|_sim| Camera { fovy: 60.0, ..Camera::look_at(EYE, LOOK_AT) });
    game.probe("library", |sim| json!({ "missing": sim.world.missing }));
}

fn block(frame: &mut Frame, (min, max): (Vec3, Vec3), material: &Material) {
    frame.cube_with(Transform::from_translation((min + max) * 0.5).with_scale(max - min), material);
}

fn standing(at: Vec3, degrees: f32) -> Transform {
    Transform::from_translation(at).with_rotation(Quat::from_rotation_y(degrees.to_radians()))
}

fn draw(world: &World, frame: &mut Frame) {
    frame.sun(SUN_TOWARDS, Color::WHITE, SUN_INTENSITY);
    frame.environment(world.sky.clone().unwrap_or_else(Environment::sky));
    frame.tag("ground");
    block(frame, GROUND, &world.asphalt);
    block(frame, SNOW_STRIP, &world.snow);
    frame.tag("wall");
    block(frame, WALL, &world.brick);
    frame.tag("props");
    frame.model(&world.bench, standing(BENCH_AT, 180.0));
    frame.model(&world.barrel, standing(BARREL_AT, 20.0));
    frame.model(&world.crate_box, standing(CRATE_AT, -35.0));
}
