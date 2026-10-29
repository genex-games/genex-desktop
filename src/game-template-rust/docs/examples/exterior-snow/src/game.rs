//! A snowy yard: a Terrain ground of packed snow and slush layers (base colour with height, and
//! normal, roughness and occlusion), props snowed by their materials (a bench, a shed whose roof
//! holds snow and whose walls do not, a fence, a dumpster, rocks, a clear-coated car, lamp posts),
//! and heavy snow falling around the camera in two lit layers with gusts, its cover laid on every
//! draw as it falls.
//!
//! What it teaches:
//! - **The ground is one Terrain**, never a scaled cube: its layers come from CC0 scans packed by
//!   `cc0__terrain-layer` (`terrain/<name>_albedo.png` and `terrain/<name>_data.png`). Without the
//!   packs each layer draws its fallback colour.
//! - **Snow is a material cover**, never a white slab: `frame.weather(&snow, seconds)` lays the
//!   weather's cover on every draw (`Frame::cover_world`), a material's own `with_cover` wins, and
//!   `Cover::none()` keeps one bare (the shed's window). It lies by slope: the roof and the bench's
//!   slats take it, the walls and the fence's faces stay their own colour.
//! - **Weather is two particle layers that follow the camera**: `Weather::heavy_snow()` draws 31
//!   flakes per m³ in the 8 m around the camera and 0.34 in the 48 m beyond, lit by the sun through
//!   its shadows and the sky, carried by gusts; draw it every frame.

use genex::math::{cos, exp, sin};
use genex::prelude::*;
use genex::render::{Environment, Fog, RenderConfig, SkyParams};
use genex::{Cover, Terrain, TerrainLayer, TerrainTexel, Weather};

/// The yard's ground: samples a side, their spacing (m) and the corner's place.
const GROUND_SAMPLES: u32 = 97;
const GROUND_SPACING: f32 = 1.0;
const GROUND_ORIGIN: Vec2 = vec2(-48.0, -48.0);
/// The trodden path: its half width (m) and the band it fades into the snow over.
const PATH_HALF: f32 = 1.4;
const PATH_FADE: f32 = 1.2;
/// The packed Terrain layers (`cc0__terrain-layer` output) and how many metres one tile covers.
const SNOW_PACK: (&str, &str) = ("terrain/snow_albedo.png", "terrain/snow_data.png");
const SLUSH_PACK: (&str, &str) = ("terrain/slush_albedo.png", "terrain/slush_data.png");
const SNOW_TILE: f32 = 3.0;
const SLUSH_TILE: f32 = 2.0;
/// How long the snow had fallen when the game starts: its cover is whole.
const SNOW_SECONDS: f32 = 600.0;
/// The bench's own cover (it wins over the weather's): fresh, a little patchier.
const BENCH_SNOW: (f32, f32, f32) = (0.9, 45.0, 0.35);
/// The overcast day: a dim sun behind the cloud, the sky's light filling the shade.
const SUN_TOWARDS: Vec3 = vec3(-0.4, 0.45, -0.6);
const SUN_INTENSITY: f32 = 1.2;
/// Snow haze: thin fog, thicker near the ground.
const FOG_DENSITY: f32 = 0.018;
const FOG_FALLOFF: f32 = 0.08;
/// The lamps: where they stand, their warm colour and light.
const LAMPS: [Vec3; 2] = [vec3(-3.2, 0.0, -4.0), vec3(3.4, 0.0, -14.0)];
const LAMP_COLOR: Color = Color::rgb(255, 196, 130);
const LAMP_GLOW: f32 = 8.0;
const LAMP_LIGHT: f32 = 3.0;
const LAMP_RANGE: f32 = 9.0;
/// The eye: standing on the path, looking along it.
const EYE: Vec3 = vec3(0.6, 1.7, 6.0);
const LOOK_AT: Vec3 = vec3(-0.5, 1.0, -6.0);

/// Everything the simulation owns. Every seed rebuilds it from `World::default()`.
#[derive(Default)]
pub struct World {
    tick: u64,
    ground: Option<Terrain>,
    snow: Option<Weather>,
}

/// The look in code on top of `genex.toml`'s `[render]` (pass `RenderConfig::from_build()`): snow
/// haze over the yard.
pub fn look(base: RenderConfig) -> RenderConfig {
    base.fog(Fog::default().with_density(FOG_DENSITY).with_height(FOG_FALLOFF, 0.0))
}

/// Register the yard's hooks.
pub fn wire(game: &mut Game<World>) {
    game.render_settings(look(RenderConfig::from_build()));
    game.on_reset(|sim, _seed, _rng, _gfx| {
        sim.world.ground = Some(ground());
        sim.world.snow = Some(Weather::heavy_snow());
    });
    game.on_update(|sim, _ctx| sim.world.tick += 1);
    game.on_draw(|sim, frame, _camera| draw(&sim.world, frame));
    game.camera(|_sim| Camera { fovy: 60.0, ..Camera::look_at(EYE, LOOK_AT) });
    game.named_camera("bench", |_sim| Camera { fovy: 50.0, ..Camera::look_at(vec3(-1.6, 1.4, 0.2), vec3(-3.6, 0.5, -2.2)) });
    game.named_camera("overview", |_sim| Camera { fovy: 55.0, ..Camera::look_at(vec3(10.0, 9.0, 12.0), vec3(-1.0, 0.0, -6.0)) });
    game.probe("yard", |sim| {
        let cover = sim.world.snow.as_ref().and_then(|snow| snow.cover_after(seconds(sim.world.tick)));
        json!({ "tick": sim.world.tick, "cover": cover.map(|c| c.amount()), "terrain": sim.world.ground.is_some() })
    });
}

/// Seconds the snow has fallen at `tick` (60 ticks a second).
fn seconds(tick: u64) -> f32 {
    SNOW_SECONDS + tick as f32 / 60.0
}

/// The ground's height at (`x`, `z`): a gentle rise and fall, and drifts heaped against the shed
/// and the fence.
fn height(x: f32, z: f32) -> f32 {
    let rolling = 0.35 * sin(x * 0.08) * cos(z * 0.06) + 0.2 * sin(x * 0.21 + z * 0.13);
    let drift = |cx: f32, cz: f32, rx: f32, rz: f32, h: f32| {
        let (dx, dz) = ((x - cx) / rx, (z - cz) / rz);
        h * exp(-(dx * dx + dz * dz))
    };
    rolling + drift(-6.2, -9.0, 3.0, 1.2, 0.45) + drift(5.5, -3.0, 0.8, 6.0, 0.35)
}

/// How much of the trodden slush shows at `x`, `z`: the path wanders down the yard.
fn path_share(x: f32, z: f32) -> f32 {
    let centre = 0.9 * sin(z * 0.11);
    let off = (x - centre).abs() - PATH_HALF;
    (1.0 - off / PATH_FADE).clamp(0.0, 1.0)
}

/// The Terrain: snow everywhere, slush down the path, each a packed CC0 scan.
fn ground() -> Terrain {
    let snow = TerrainLayer::textured(SNOW_PACK.0, SNOW_PACK.1, SNOW_TILE).with_fallback(Color::rgb(226, 231, 238));
    let slush = TerrainLayer::textured(SLUSH_PACK.0, SLUSH_PACK.1, SLUSH_TILE).with_fallback(Color::rgb(108, 104, 98)).with_roughness(0.7);
    let terrain = Terrain::from_fn([GROUND_SAMPLES; 2], GROUND_ORIGIN, GROUND_SPACING, height).expect("the yard's heights");
    let texels: Vec<TerrainTexel> = (0..GROUND_SAMPLES * GROUND_SAMPLES)
        .map(|at| {
            let (i, j) = (at % GROUND_SAMPLES, at / GROUND_SAMPLES);
            let (x, z) = (GROUND_ORIGIN.x + i as f32 * GROUND_SPACING, GROUND_ORIGIN.y + j as f32 * GROUND_SPACING);
            TerrainTexel::blend(0, 1, path_share(x, z)).with_wetness(0.5 * path_share(x, z))
        })
        .collect();
    terrain.with_layers(vec![snow, slush]).and_then(|t| t.with_control(&texels)).expect("the yard's layers")
}

/// A box from `min` to `max` (world corners).
fn block(min: Vec3, max: Vec3) -> Transform {
    Transform::from_translation((min + max) * 0.5).with_scale(max - min)
}

/// The props' surfaces: plain colours here; a game gives them CC0 scans as the interior-room
/// example does, and the cover lies over the scans the same way.
struct Surfaces {
    wood: Material,
    iron: Material,
    planks: Material,
    roof: Material,
    glass: Material,
    green_metal: Material,
    stone: Material,
    paint: Material,
    tyre: Material,
    lamp: Material,
}

fn surfaces() -> Surfaces {
    Surfaces {
        wood: Material::color(Color::rgb(112, 78, 52)).with_roughness(0.75),
        iron: Material::color(Color::rgb(40, 42, 46)).with_metallic(1.0).with_roughness(0.55),
        planks: Material::color(Color::rgb(150, 70, 52)).with_roughness(0.8),
        roof: Material::color(Color::rgb(70, 74, 80)).with_metallic(0.6).with_roughness(0.5),
        // The window keeps the weather off: a pane lets the light through and holds no snow.
        glass: Material::color(Color::rgb(200, 215, 225)).with_roughness(0.05).with_transmission(0.9).with_cover(Cover::none()),
        green_metal: Material::color(Color::rgb(40, 92, 60)).with_metallic(0.8).with_roughness(0.45),
        stone: Material::color(Color::rgb(108, 104, 98)).with_roughness(0.9),
        // Car paint: a red base under a clear coat.
        paint: Material::color(Color::rgb(140, 18, 20)).with_metallic(0.3).with_roughness(0.45).with_clearcoat(1.0, 0.05),
        tyre: Material::color(Color::rgb(22, 22, 24)).with_roughness(0.9),
        lamp: Material::emissive(LAMP_COLOR, LAMP_GLOW),
    }
}

fn draw(world: &World, frame: &mut Frame) {
    frame.clear(Color::rgb(190, 196, 204)).ambient(Color::rgb(190, 200, 215), 0.3).sun(SUN_TOWARDS, Color::rgb(255, 248, 240), SUN_INTENSITY);
    frame.environment(Environment::Sky(SkyParams::overcast()));
    if let Some(ground) = &world.ground {
        frame.tag("ground").terrain(ground);
    }
    // The weather first: both of its layers, and the cover it has laid on everything drawn.
    if let Some(snow) = &world.snow {
        frame.tag("weather").weather(snow, seconds(world.tick));
    }
    let s = surfaces();
    frame.tag("props");
    bench(frame, &s, vec3(-3.6, 0.0, -2.2));
    shed(frame, &s, vec3(-6.5, 0.0, -11.0));
    fence(frame, &s);
    dumpster(frame, &s, vec3(4.6, 0.0, -6.5));
    car(frame, &s, vec3(5.2, 0.0, -11.5));
    for (at, r) in [(vec3(-1.8, 0.0, -7.5), 0.55), (vec3(2.4, 0.0, -1.2), 0.4), (vec3(-4.6, 0.0, 1.5), 0.7)] {
        frame.sphere_with(at + vec3(0.0, height(at.x, at.z) + 0.3 * r, 0.0), r, &s.stone);
    }
    frame.tag("lamps");
    for at in LAMPS {
        let foot = at + vec3(0.0, height(at.x, at.z), 0.0);
        frame.cube_with(block(foot - vec3(0.06, 0.0, 0.06), foot + vec3(0.06, 3.4, 0.06)), &s.iron);
        frame.cube_with(block(foot + vec3(-0.2, 3.4, -0.2), foot + vec3(0.2, 3.55, 0.2)), &s.iron);
        frame.cube_with(block(foot + vec3(-0.14, 3.2, -0.14), foot + vec3(0.14, 3.4, 0.14)), &s.lamp);
        frame.point_light(foot + vec3(0.0, 3.1, 0.0), LAMP_RANGE, LAMP_COLOR, LAMP_LIGHT);
    }
}

/// A park bench at `at`: wooden slats on iron ends, snowed by its own cover.
fn bench(frame: &mut Frame, s: &Surfaces, at: Vec3) {
    let base = at + vec3(0.0, height(at.x, at.z), 0.0);
    let (amount, slope, noise) = BENCH_SNOW;
    let wood = s.wood.clone().with_cover(Cover::snow(amount, slope, noise));
    for side in [-0.85, 0.85] {
        frame.cube_with(block(base + vec3(side - 0.04, 0.0, -0.25), base + vec3(side + 0.04, 0.45, 0.25)), &s.iron);
        frame.cube_with(block(base + vec3(side - 0.04, 0.45, 0.18), base + vec3(side + 0.04, 0.9, 0.24)), &s.iron);
    }
    for k in 0..4 {
        let z = -0.22 + k as f32 * 0.12;
        frame.cube_with(block(base + vec3(-1.0, 0.43, z), base + vec3(1.0, 0.47, z + 0.09)), &wood);
    }
    for k in 0..2 {
        let y = 0.6 + k as f32 * 0.14;
        frame.cube_with(block(base + vec3(-1.0, y, 0.2), base + vec3(1.0, y + 0.1, 0.24)), &wood);
    }
}

/// A shed at `at`: plank walls, a window, and a pitched roof whose slopes hold the snow.
fn shed(frame: &mut Frame, s: &Surfaces, at: Vec3) {
    let base = at + vec3(0.0, height(at.x, at.z) - 0.1, 0.0);
    frame.cube_with(block(base + vec3(-1.8, 0.0, -1.4), base + vec3(1.8, 2.3, 1.4)), &s.planks);
    frame.cube_with(block(base + vec3(-0.5, 1.0, 1.39), base + vec3(0.5, 1.7, 1.43)), &s.glass);
    for side in [-1.0f32, 1.0] {
        let tilt = Quat::from_rotation_x(side * 0.42);
        let slope = Transform::from_translation(base + vec3(0.0, 2.62, side * 0.78)).with_rotation(tilt).with_scale(vec3(4.0, 0.08, 1.9));
        frame.cube_with(slope, &s.roof);
    }
}

/// A fence along the yard's west side: posts and two rails.
fn fence(frame: &mut Frame, s: &Surfaces) {
    for k in 0..9 {
        let z = 2.0 - k as f32 * 2.2;
        let x = -8.5;
        let y = height(x, z);
        frame.cube_with(block(vec3(x - 0.06, y - 0.1, z - 0.06), vec3(x + 0.06, y + 1.2, z + 0.06)), &s.wood);
    }
    for rail in [0.45, 0.95] {
        let y = height(-8.5, -7.0) + rail;
        frame.cube_with(block(vec3(-8.54, y, -15.7), vec3(-8.46, y + 0.1, 2.0)), &s.wood);
    }
}

/// A dumpster at `at`: a green metal bin with a lid.
fn dumpster(frame: &mut Frame, s: &Surfaces, at: Vec3) {
    let base = at + vec3(0.0, height(at.x, at.z), 0.0);
    frame.cube_with(block(base + vec3(-0.9, 0.15, -0.6), base + vec3(0.9, 1.25, 0.6)), &s.green_metal);
    frame.cube_with(block(base + vec3(-0.95, 1.25, -0.65), base + vec3(0.95, 1.3, 0.65)), &s.green_metal);
    for x in [-0.7, 0.7] {
        frame.sphere_with(base + vec3(x, 0.12, 0.45), 0.12, &s.tyre);
    }
}

/// A parked car at `at`: a clear-coated body and cabin on four wheels; the coat shows under the
/// snow on its bonnet and roof.
fn car(frame: &mut Frame, s: &Surfaces, at: Vec3) {
    let base = at + vec3(0.0, height(at.x, at.z), 0.0);
    frame.cube_with(block(base + vec3(-0.85, 0.3, -2.1), base + vec3(0.85, 0.95, 2.1)), &s.paint);
    frame.cube_with(block(base + vec3(-0.75, 0.95, -1.0), base + vec3(0.75, 1.45, 0.9)), &s.paint);
    for (x, z) in [(-0.85, -1.4), (0.85, -1.4), (-0.85, 1.4), (0.85, 1.4)] {
        frame.sphere_with(base + vec3(x, 0.32, z), 0.32, &s.tyre);
    }
}
