//! A lit interior room, distilled from the engine team's café showcase: a classroom with two
//! window openings in its sunlit wall and a door into a dark corridor. Every surface is a CC0 scan
//! kept at its real size, each room has its own reflection probe and irradiance volume, grime and
//! a poster are decals, the low sun cuts shafts through the look's fog, and the grade comes last.
//!
//! The order matters more than any number here: shell, then surfaces, then sun and sky, then the
//! lamps, then a probe and a volume per room, then decals, then fog, and the grade last. Look at a
//! capture after each step. Copy the helpers (`Scan`, `wall`, `tiled`) into your own game.
//!
//! Boxes are fine for this greybox-plus shell. A finished level builds the shell as a GLB kit in
//! Local Blender instead (walls with real reveals, frames, sills, radiators, world-scale UVs) and
//! keeps the light, probes, volumes and decals below unchanged.

use genex::prelude::*;
use genex::render::{Decal, Environment, Fog, Grading, IrradianceVolume, ReflectionProbe, RenderConfig, SpotLight};

/// The room's floor and ceiling heights and its inner faces (metres); walls are `WALL` thick.
const CEILING: f32 = 3.2;
const ROOM_MIN: Vec3 = vec3(-4.0, 0.0, -3.0);
const ROOM_MAX: Vec3 = vec3(4.0, CEILING, 3.0);
const WALL: f32 = 0.25;
/// The corridor east of the room's door, beyond the room's east wall.
const HALL_MIN: Vec3 = vec3(4.0 + WALL, 0.0, -6.0);
const HALL_MAX: Vec3 = vec3(6.5, CEILING, 3.0);
/// The window openings in the north wall (x from, x to), their sill and head heights.
const WINDOWS: [(f32, f32); 2] = [(-2.9, -1.1), (1.1, 2.9)];
const SILL: f32 = 0.9;
const HEAD: f32 = 2.5;
/// The door in the east wall (z from, z to) and its head.
const DOOR: (f32, f32) = (-2.4, -1.3);
const DOOR_HEAD: f32 = 2.1;
/// How far past a room's faces its probe and volume fade out: the wall's thickness, so the street
/// outside the windows keeps the sky's light.
const PROBE_BLEND: f32 = WALL;
/// Towards the sun: about 17 degrees up, in front of the window wall, so it falls in at a slant.
const SUN_TOWARDS: Vec3 = vec3(0.35, 0.32, 1.0);
const SUN_INTENSITY: f32 = 3.0;
/// The fluorescent fittings (x, z), their glow, light and cone; the second one flickers.
const FITTINGS: [(f32, f32); 2] = [(-1.8, 0.0), (1.8, 0.0)];
const TUBE: Color = Color::rgb(220, 235, 255);
const TUBE_GLOW: f32 = 6.0;
const TUBE_LIGHT: f32 = 2.2;
const TUBE_RANGE: f32 = 6.0;
/// The corridor's one dim bulb.
const BULB: Color = Color::rgb(255, 190, 120);
/// The look's air: thin. Fog takes its light from the sky, so indoors a dense fog glows milky in
/// every corner; this much still shows the sun's shafts at `high` and `ultra`.
const FOG_DENSITY: f32 = 0.012;
const FOG_FALLOFF: f32 = 0.05;
/// Where the camera stands and looks: from the back corner, past the desks to the windows.
const EYE: Vec3 = vec3(-3.3, 1.6, -2.4);
const LOOK_AT: Vec3 = vec3(1.2, 1.1, 2.4);

/// A CC0 scan as `cc0__fetch` delivers it: its folder under `assets/`, its id, the size in metres
/// one copy of it covers, whether it came with an `arm` (occlusion-roughness-metal) map, and the
/// colour drawn until its maps load (or when they are missing).
struct Scan {
    folder: &'static str,
    id: &'static str,
    tile: f32,
    arm: bool,
    stand_in: Color,
}

// `cc0__fetch {source: "polyhaven", id, resolution: "1k"}` lands each scan in exactly these
// folders; if a fetch answers another path, use the path it answered.
const PLASTER: Scan = Scan { folder: "cc0/aeaef6d7-72f1-a42b-cd06-d4d2de83a72a", id: "peeling_painted_wall", tile: 2.0, arm: true, stand_in: Color::rgb(150, 160, 140) };
const TILES: Scan = Scan { folder: "cc0/e6657b6b-b54c-49ce-7af8-709354a34ed0", id: "floor_tiles_06", tile: 2.0, arm: true, stand_in: Color::rgb(120, 100, 90) };
const CONCRETE: Scan = Scan { folder: "cc0/69d58cd7-d02f-5f73-c20b-748197b36df8", id: "concrete_wall_003", tile: 2.5, arm: true, stand_in: Color::rgb(140, 138, 132) };
const WOOD: Scan = Scan { folder: "cc0/e1301015-c73e-179e-3826-3d51565ca96f", id: "wood_table_worn", tile: 1.2, arm: false, stand_in: Color::rgb(110, 80, 55) };
const RUST: Scan = Scan { folder: "cc0/9356d36e-45b6-0825-4b29-fa582aa2f82a", id: "rusty_metal_02", tile: 1.0, arm: false, stand_in: Color::rgb(90, 70, 60) };

impl Scan {
    /// The scan as a PBR surface; `roughness` scales the scan's own (1 keeps it).
    fn material(&self, roughness: f32) -> Material {
        let map = |kind: &str| format!("{}/{}_{kind}_1k.jpg", self.folder, self.id);
        let surface = Material::color(Color::WHITE)
            .with_untextured_color(self.stand_in)
            .with_roughness(roughness)
            .with_base_texture(&map("diff"))
            .with_normal_texture(&map("nor_gl"), 1.0);
        if self.arm { surface.with_metal_rough_texture(&map("arm")) } else { surface }
    }
}

/// Every surface, made once per seed.
pub struct Surfaces {
    plaster: Material,
    tiles: Material,
    concrete: Material,
    wood: Material,
    radiator: Material,
    steel: Material,
    ground: Material,
}

impl Default for Surfaces {
    fn default() -> Surfaces {
        Surfaces {
            plaster: PLASTER.material(1.0),
            // Old terrazzo polished by feet: lower roughness so the probe's reflection shows.
            tiles: TILES.material(0.6),
            concrete: CONCRETE.material(1.0),
            wood: WOOD.material(0.8),
            radiator: RUST.material(1.0),
            steel: Material::color(Color::rgb(60, 62, 64)).with_metallic(1.0).with_roughness(0.45),
            ground: Material::color(Color::rgb(70, 72, 58)).with_roughness(0.95),
        }
    }
}

/// Everything the simulation owns. Every seed rebuilds it from `World::default()`.
#[derive(Default)]
pub struct World {
    /// Ticks since the seed: the flicker reads it.
    pub tick: u64,
    /// The surfaces the draw hook uses.
    pub surfaces: Surfaces,
}

/// The look in code on top of `genex.toml`'s `[render]` (pass `RenderConfig::from_build()`): the
/// room's air, then a cold, slightly desaturated grade.
pub fn look(base: RenderConfig) -> RenderConfig {
    base.fog(Fog::default().with_density(FOG_DENSITY).with_height(FOG_FALLOFF, 0.0))
        .grading(Grading::NEUTRAL.with_contrast(1.08).with_saturation(0.88))
        .temperature(-0.12, 0.0)
}

/// Register the room's hooks.
pub fn wire(game: &mut Game<World>) {
    game.render_settings(look(RenderConfig::from_build()));
    game.on_update(|sim, _ctx| sim.world.tick += 1);
    game.on_draw(|sim, frame, _camera| draw(&sim.world, frame));
    game.camera(|_sim| Camera { fovy: 62.0, ..Camera::look_at(EYE, LOOK_AT) });
    game.named_camera("windows", |_sim| Camera { fovy: 55.0, ..Camera::look_at(vec3(0.0, 1.5, -2.6), vec3(0.0, 1.2, 3.0)) });
    game.named_camera("door", |_sim| Camera { fovy: 60.0, ..Camera::look_at(vec3(-2.0, 1.6, 1.8), vec3(4.5, 1.2, -1.9)) });
    game.probe("room", |sim| json!({ "tick": sim.world.tick, "flicker": flicker_off(sim.world.tick) }));
}

/// Whether the flickering tube is dark this tick: a few short drop-outs, a pure function of time.
fn flicker_off(tick: u64) -> bool {
    matches!((tick / 4) % 37, 3 | 5 | 21)
}

fn draw(world: &World, frame: &mut Frame) {
    let s = &world.surfaces;
    frame.clear(Color::rgb(120, 140, 160)).ambient(Color::rgb(170, 185, 210), 0.15).sun(SUN_TOWARDS, Color::WHITE, SUN_INTENSITY);
    frame.environment(Environment::sky());
    outside(frame, s);
    shell(frame, s);
    furniture(frame, s);
    lamps(frame, s, world.tick);
    // Each room gets its own probe and volume on the same box, every frame.
    for (min, max) in [(ROOM_MIN, ROOM_MAX), (HALL_MIN, HALL_MAX)] {
        let eye = vec3((min.x + max.x) * 0.5, 1.6, (min.z + max.z) * 0.5);
        frame.reflection_probe(&ReflectionProbe::new(min, max).with_capture(eye).with_blend(PROBE_BLEND));
        frame.irradiance_volume(&IrradianceVolume::new(min, max).with_blend(PROBE_BLEND));
    }
    decals(frame);
}

/// The ground outside and a block across the yard, so the windows look onto something.
fn outside(frame: &mut Frame, s: &Surfaces) {
    frame.tag("outside");
    block(frame, vec3(-60.0, -0.3, ROOM_MAX.z + WALL), vec3(60.0, -0.02, 60.0), &s.ground);
    // Low and far enough that the sun (17 degrees up) clears it and falls in through the windows.
    tiled(frame, vec3(-20.0, 0.0, 40.0), vec3(20.0, 8.0, 41.0), CONCRETE.tile * 2.0, &s.concrete);
}

/// The walls, floors and ceilings of both rooms, the window frames and sills.
fn shell(frame: &mut Frame, s: &Surfaces) {
    frame.tag("shell");
    let (lo, hi) = (ROOM_MIN, ROOM_MAX);
    tiled(frame, vec3(lo.x, -0.2, lo.z), vec3(hi.x, 0.0, hi.z), TILES.tile, &s.tiles);
    tiled(frame, vec3(lo.x, CEILING, lo.z), vec3(HALL_MAX.x, CEILING + 0.2, HALL_MAX.z), CONCRETE.tile, &s.concrete);
    tiled(frame, vec3(HALL_MIN.x, -0.2, HALL_MIN.z), vec3(HALL_MAX.x, 0.0, HALL_MAX.z), CONCRETE.tile, &s.concrete);
    let windows: Vec<Opening> = WINDOWS.iter().map(|&(from, to)| Opening { from, to, sill: SILL, head: HEAD }).collect();
    wall(frame, Side::AlongX(hi.z, hi.z + WALL), (lo.x - WALL, hi.x + WALL), &windows, &s.plaster);
    wall(frame, Side::AlongX(lo.z - WALL, lo.z), (lo.x - WALL, hi.x + WALL), &[], &s.plaster);
    wall(frame, Side::AlongZ(lo.x - WALL, lo.x), (lo.z, hi.z), &[], &s.plaster);
    let door = Opening { from: DOOR.0, to: DOOR.1, sill: 0.0, head: DOOR_HEAD };
    wall(frame, Side::AlongZ(hi.x, hi.x + WALL), (HALL_MIN.z, HALL_MAX.z), &[door], &s.plaster);
    wall(frame, Side::AlongZ(HALL_MAX.x, HALL_MAX.x + WALL), (HALL_MIN.z, HALL_MAX.z), &[], &s.concrete);
    wall(frame, Side::AlongX(HALL_MIN.z - WALL, HALL_MIN.z), (HALL_MIN.x, HALL_MAX.x), &[], &s.concrete);
    wall(frame, Side::AlongX(HALL_MAX.z, HALL_MAX.z + WALL), (HALL_MIN.x, HALL_MAX.x), &[], &s.concrete);
    // Each window: a steel frame with a mullion and a transom (its glass long gone, so the sun's
    // shafts reach the floor), and a concrete sill standing proud of the wall inside.
    let mid = hi.z + WALL * 0.5;
    for (x0, x1) in WINDOWS {
        for x in [x0, (x0 + x1) * 0.5 - 0.025, x1 - 0.05] {
            block(frame, vec3(x, SILL, mid - 0.03), vec3(x + 0.05, HEAD, mid + 0.03), &s.steel);
        }
        for y in [SILL, 1.9, HEAD - 0.05] {
            block(frame, vec3(x0, y, mid - 0.03), vec3(x1, y + 0.05, mid + 0.03), &s.steel);
        }
        block(frame, vec3(x0 - 0.08, SILL - 0.05, hi.z - 0.08), vec3(x1 + 0.08, SILL, hi.z + 0.02), &s.concrete);
    }
}

/// A radiator under each window and two rows of desks with their chairs.
fn furniture(frame: &mut Frame, s: &Surfaces) {
    frame.tag("furniture");
    for (x0, x1) in WINDOWS {
        let z = ROOM_MAX.z - 0.12;
        for i in 0..14 {
            let x = x0 + 0.15 + i as f32 * (x1 - x0 - 0.3) / 13.0;
            block(frame, vec3(x - 0.025, 0.18, z - 0.05), vec3(x + 0.025, 0.78, z + 0.05), &s.radiator);
        }
        for y in [0.2, 0.74] {
            block(frame, vec3(x0 + 0.1, y, z - 0.02), vec3(x1 - 0.1, y + 0.04, z + 0.02), &s.radiator);
        }
    }
    for (row, z) in [-0.6_f32, 1.2].into_iter().enumerate() {
        for (col, x) in [-2.4_f32, 0.0, 2.4].into_iter().enumerate() {
            // A pushed-back chair here and there: rooms people left are never in rows.
            let shove = if (row + col) % 3 == 1 { 0.35 } else { 0.0 };
            desk(frame, s, vec3(x, 0.0, z));
            chair(frame, s, vec3(x + shove * 0.3, 0.0, z - 0.55 - shove));
        }
    }
}

fn desk(frame: &mut Frame, s: &Surfaces, at: Vec3) {
    block(frame, at + vec3(-0.6, 0.72, -0.3), at + vec3(0.6, 0.75, 0.3), &s.wood);
    for (dx, dz) in [(-0.55, -0.25), (-0.55, 0.25), (0.55, -0.25), (0.55, 0.25)] {
        block(frame, at + vec3(dx - 0.02, 0.0, dz - 0.02), at + vec3(dx + 0.02, 0.72, dz + 0.02), &s.steel);
    }
}

fn chair(frame: &mut Frame, s: &Surfaces, at: Vec3) {
    block(frame, at + vec3(-0.21, 0.44, -0.2), at + vec3(0.21, 0.47, 0.2), &s.wood);
    block(frame, at + vec3(-0.21, 0.6, -0.22), at + vec3(0.21, 0.85, -0.2), &s.wood);
    for (dx, dz) in [(-0.18, -0.18), (-0.18, 0.18), (0.18, -0.18), (0.18, 0.18)] {
        let top = if dz < 0.0 { 0.85 } else { 0.44 };
        block(frame, at + vec3(dx - 0.012, 0.0, dz - 0.012), at + vec3(dx + 0.012, top, dz + 0.012), &s.steel);
    }
}

/// The fluorescent fittings (each glowing tube paired with a light, which is what lights the
/// room) and the corridor's bulb.
fn lamps(frame: &mut Frame, s: &Surfaces, tick: u64) {
    frame.tag("lamps");
    for (i, (x, z)) in FITTINGS.into_iter().enumerate() {
        let on = i == 0 || !flicker_off(tick);
        block(frame, vec3(x - 0.09, CEILING - 0.08, z - 0.65), vec3(x + 0.09, CEILING, z + 0.65), &s.steel);
        let glow = if on { TUBE_GLOW } else { 0.05 };
        block(frame, vec3(x - 0.04, CEILING - 0.11, z - 0.6), vec3(x + 0.04, CEILING - 0.08, z + 0.6), &Material::emissive(TUBE, glow));
        if on {
            let spot = SpotLight::new(vec3(x, CEILING - 0.15, z), Vec3::NEG_Y, TUBE_RANGE, TUBE, TUBE_LIGHT);
            frame.spot_light_with(&spot.with_cone_degrees(55.0, 80.0));
        }
    }
    let bulb = vec3(5.4, CEILING - 0.4, -4.0);
    frame.sphere_with(bulb, 0.05, &Material::emissive(BULB, 8.0));
    frame.point_light(bulb, 5.0, BULB, 0.9);
}

/// Grime run down from each sill, a poster on the west wall, a puddle by the windows and a stain in
/// the corridor. Each decal's texture is an RGBA image under `assets/decals/`; until it
/// loads (or when it is missing) the decal is simply not drawn.
fn decals(frame: &mut Frame) {
    for (x0, x1) in WINDOWS {
        let below_sill = vec3((x0 + x1) * 0.5, SILL * 0.5, ROOM_MAX.z);
        frame.decal(&Decal::on_wall(below_sill, Vec3::NEG_Z, x1 - x0, SILL).with_base_texture("decals/grime-streaks.png").with_opacity(0.8));
    }
    let poster = Decal::on_wall(vec3(ROOM_MIN.x, 1.7, 0.6), Vec3::X, 0.6, 0.85).rotated(0.04);
    frame.decal(&poster.with_base_texture("decals/poster.png").with_roughness(0.7));
    // Water that came in at the windows and pooled: dark, glossy and flat over the tiles' grout.
    let puddle = Decal::on_ground(vec3(1.0, 0.0, 2.2), 1.6, 1.1).rotated(0.4).with_base_texture("decals/stain.png");
    frame.decal(&puddle.with_color(Color::rgb(40, 38, 34)).with_roughness(0.08).with_flatten(1.0));
    frame.decal(&Decal::on_ground(vec3(5.4, 0.0, -3.5), 1.4, 2.6).with_base_texture("decals/stain.png").with_opacity(0.7));
}

/// A wall's footprint: along x between two z planes, or along z between two x planes.
#[derive(Clone, Copy)]
enum Side {
    AlongX(f32, f32),
    AlongZ(f32, f32),
}

/// A hole through a wall: where it runs along the wall, its sill and its head (a door's sill is 0).
#[derive(Clone, Copy)]
struct Opening {
    from: f32,
    to: f32,
    sill: f32,
    head: f32,
}

/// A wall `span` long from floor to ceiling, with `openings` cut through it, as panels: a full
/// pier between openings, and under and over each opening. Each panel is tiled to the scan's size.
// TODO(runtime mesh): once the facade builds a mesh from vertices, make each wall one mesh with
// its openings and world-scale UVs here, as `docs/examples/room-kit/room_kit.py` does in Blender.
fn wall(frame: &mut Frame, side: Side, span: (f32, f32), openings: &[Opening], material: &Material) {
    let panel = |frame: &mut Frame, along: (f32, f32), up: (f32, f32)| {
        if along.1 - along.0 < 0.01 || up.1 - up.0 < 0.01 {
            return;
        }
        let (min, max) = match side {
            Side::AlongX(z0, z1) => (vec3(along.0, up.0, z0), vec3(along.1, up.1, z1)),
            Side::AlongZ(x0, x1) => (vec3(x0, up.0, along.0), vec3(x1, up.1, along.1)),
        };
        tiled(frame, min, max, PLASTER.tile, material);
    };
    let mut from = span.0;
    for hole in openings {
        panel(frame, (from, hole.from), (0.0, CEILING));
        panel(frame, (hole.from, hole.to), (0.0, hole.sill));
        panel(frame, (hole.from, hole.to), (hole.head, CEILING));
        from = hole.to;
    }
    panel(frame, (from, span.1), (0.0, CEILING));
}

/// A box from `min` to `max` cut into pieces about `tile` across on its two largest sides, so a
/// scan keeps its real size instead of stretching over the whole box.
// TODO(Material UV scale): once `Material` takes a UV scale or world-space mapping, draw one box
// with the scan's size and drop the cutting.
fn tiled(frame: &mut Frame, min: Vec3, max: Vec3, tile: f32, material: &Material) {
    let size = max - min;
    let count = |length: f32| (length / tile).ceil().max(1.0) as u32;
    let thin = size.min_element();
    let n = [size.x, size.y, size.z].map(|length| if length == thin { 1 } else { count(length) });
    let step = size / vec3(n[0] as f32, n[1] as f32, n[2] as f32);
    for i in 0..n[0] {
        for j in 0..n[1] {
            for k in 0..n[2] {
                let lo = min + step * vec3(i as f32, j as f32, k as f32);
                block(frame, lo, lo + step, material);
            }
        }
    }
}

/// One box from `min` to `max`.
fn block(frame: &mut Frame, min: Vec3, max: Vec3, material: &Material) {
    frame.cube_with(Transform::from_translation((min + max) * 0.5).with_scale(max - min), material);
}
