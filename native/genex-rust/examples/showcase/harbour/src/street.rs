//! Harbour Street's blockout and its draw hook. The main street runs along x, the side street leaves
//! the crossing to the south (−z) and the low sun shines down it, onto the café's front and through
//! its windows. North of the crossing is the café (reached through its door), east of it a narrow
//! alley full of neon. Everything is the facade's boxes and spheres: surfaces are boxes one texture
//! tile wide, so the fetched scans (`fetched/<name>-{albedo,normal,orm}.jpg`) keep their real size,
//! each with an untextured colour standing in where the asset cache holds none. Lights are real:
//! festoon bulbs over the street, neon signs, street lamps (two with spot shadow maps) and the café's
//! pendant lamps, every one a binned local light. Glass is blended (it casts no shadow, so the sun
//! reaches the café's floor). Every animation derives from the world's tick, never a clock. The A.13
//! detail pass dresses the blockout: scanned wood, marble, metal, granite and iron on the furniture,
//! the kerbs and the drains, road markings at the crossing, awnings over the lit shops, panelled
//! counter and bottled shelves in the café, slatted chairs and bench, and the café's menu board.
//! Steam rises from the manholes and a drizzle falls over the street and the alley ([`Weather`],
//! GPU particles).

use genex::math::{self, FRAC_PI_2, Quat, Vec3, vec3};
use genex::prelude::*;
use genex::Particles;
use genex::render::{Decal, IrradianceVolume, ReflectionProbe, SpotLight};

use crate::harbour::World;

/// The colour the world target clears to where the device's quality draws no sky.
pub const DUSK: Color = Color::rgb(64, 72, 98);

/// The pavements' top above the street (the kerb's height).
pub const KERB: f32 = 0.15;
/// Half the width of the main street (along x) and of the side street (along z).
pub const STREET_HALF: f32 = 4.5;
/// The pavement's width, so the facades stand at ±[`FACADE`].
pub const PAVEMENT: f32 = 3.0;
/// Where the facades stand across both streets.
pub const FACADE: f32 = STREET_HALF + PAVEMENT;
/// How far the main street runs either way of the crossing and the side street south of it.
pub const EXTENT: f32 = 31.5;
/// The neon alley, north of the street: its walls' x and its end wall's z.
pub const ALLEY_WEST: f32 = 13.5;
/// The alley's east wall.
pub const ALLEY_EAST: f32 = 16.5;
/// The alley's end wall.
pub const ALLEY_END: f32 = 31.5;
/// The buildings' heights: north of the street, the south-west block and the south-east block.
const NORTH_HEIGHT: f32 = 12.0;
const SOUTH_WEST_HEIGHT: f32 = 10.0;
const SOUTH_EAST_HEIGHT: f32 = 14.0;
/// How far the street's surfaces reach below their top (the slabs' thickness).
const SLAB: f32 = 0.3;

/// The café: its west and east walls' inner faces, its front wall (outer face and inner face), its
/// back wall, its ceiling and the floor of the storey above.
pub const CAFE_WEST: f32 = -6.0;
/// The café's east wall's inner face.
pub const CAFE_EAST: f32 = 6.0;
/// The café front wall's inner face (its outer face is the street's facade).
pub const CAFE_FRONT: f32 = FACADE + 0.3;
/// The café's back wall's inner face.
pub const CAFE_BACK: f32 = 15.8;
/// The café's ceiling.
pub const CAFE_CEILING: f32 = 3.6;
/// The top of the café's storey (the facade above is the building's).
const CAFE_STOREY: f32 = 3.75;
/// The café's two windows (x from, x to) and their sill and head.
const WINDOWS: [(f32, f32); 2] = [(-5.2, -1.2), (-0.4, 2.0)];
const SILL: f32 = 0.75;
const HEAD: f32 = 3.0;
/// The café's door (x from, x to) and its head.
const DOOR: (f32, f32) = (2.8, 4.0);
const DOOR_HEAD: f32 = 2.45;

/// An axis-aligned box of the world.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Bounds {
    /// Its least corner.
    pub min: Vec3,
    /// Its greatest corner.
    pub max: Vec3,
}

impl Bounds {
    /// Whether `p` lies inside (its faces included).
    pub fn contains(&self, p: Vec3) -> bool {
        p.cmpge(self.min).all() && p.cmple(self.max).all()
    }
}

/// The café's room: between its walls, above its floor and under its ceiling.
pub const CAFE_INSIDE: Bounds = Bounds { min: vec3(CAFE_WEST, KERB, CAFE_FRONT), max: vec3(CAFE_EAST, CAFE_CEILING, CAFE_BACK) };
/// The doorway through the café's front wall.
pub const CAFE_DOOR: Bounds = Bounds { min: vec3(DOOR.0, KERB, FACADE), max: vec3(DOOR.1, DOOR_HEAD, CAFE_FRONT) };
/// A walk from the pavement in front of the café, through its door, to the middle of the room (at
/// eye height): the door transition's path.
pub const DOOR_WALK: [Vec3; 2] = [vec3(3.4, 1.6, 5.4), vec3(3.4, 1.6, 11.5)];
/// Where the café's reflection probe (renderer pass 2 A.3, its box the room's inside) captures its
/// cube: the middle of the room at eye height.
pub const CAFE_PROBE_CAPTURE: Vec3 = vec3(0.0, 1.6, 0.5 * (CAFE_FRONT + CAFE_BACK));
/// How far past the room's faces the café's reflection fades out: the front wall's thickness, so
/// the pavement outside reflects the sky.
const CAFE_PROBE_BLEND: f32 = 0.3;
/// The white rug by the café's red wall: the floor whose colour bleed the irradiance rows measure.
pub const BLEED_FLOOR: Bounds = Bounds { min: vec3(CAFE_WEST + 0.1, KERB, 11.0), max: vec3(CAFE_WEST + 2.5, KERB + 0.01, 14.5) };

/// Whether `p` is in the open air of the streets or the alley (below the lowest roofs).
pub fn outdoors(p: Vec3) -> bool {
    let air = p.y > 0.0 && p.y < SOUTH_WEST_HEIGHT;
    let main = p.x.abs() < EXTENT && p.z.abs() < FACADE;
    let side = p.x.abs() < FACADE && p.z > -EXTENT && p.z <= -FACADE;
    let alley = p.x > ALLEY_WEST && p.x < ALLEY_EAST && p.z >= FACADE && p.z < ALLEY_END;
    air && (main || side || alley)
}

/// The low sun, towards it: down the side street from the south, under 10 degrees up, where the
/// physical sky reddens it and deepens the zenith (G0 look: at 18 degrees the street read as
/// daylight under a midday-blue sky).
pub const SUN_DIR: Vec3 = vec3(0.1, 0.17, -1.0);
const SUN_COLOR: Color = Color::rgb(255, 255, 255);
const SUN_INTENSITY: f32 = 3.2;
/// The dusk sky's fill where the device's quality turns image-based lighting off.
const AMBIENT_COLOR: Color = Color::rgb(150, 168, 214);
const AMBIENT_INTENSITY: f32 = 0.12;

/// The festoon strings over the main street (their x), the bulbs on each and how far a string sags.
const FESTOON_X: [f32; 7] = [-28.0, -19.0, -10.0, -1.0, 8.0, 17.0, 26.0];
/// Bulbs on each festoon string.
pub const BULBS_PER_STRING: usize = 30;
const FESTOON_HIGH: f32 = 5.6;
const FESTOON_SAG: f32 = 0.6;
const BULB_RADIUS: f32 = 0.05;
const BULB: Color = Color::rgb(255, 190, 116);
const BULB_GLOW: f32 = 5.0;
const BULB_LIGHT: f32 = 0.45;
const BULB_RANGE: f32 = 3.2;
const WIRE: Color = Color::rgb(20, 20, 22);

/// Neon colours and their glow, and how bright and far a sign's light reaches.
const MAGENTA: Color = Color::rgb(255, 40, 170);
const CYAN: Color = Color::rgb(40, 220, 255);
const AMBER: Color = Color::rgb(255, 150, 40);
const NEON_GLOW: f32 = 4.0;
const NEON_LIGHT: f32 = 2.4;
const NEON_RANGE: f32 = 7.0;

/// A street lamp's head glow, its light (intensity, reach, cone half-angles in degrees) and its post.
const LAMP: Color = Color::rgb(255, 214, 170);
const LAMP_GLOW: f32 = 3.0;
const LAMP_LIGHT: f32 = 7.0;
const LAMP_RANGE: f32 = 12.0;
const LAMP_CONE_DEGREES: (f32, f32) = (35.0, 60.0);
const LAMP_HEIGHT: f32 = 5.3;
/// The street lamps (x, z, and whether its spot asks for a shadow map): the two at the crossing do.
const LAMPS: [(f32, f32, bool); 4] = [(-20.0, 6.4, false), (-6.0, -6.4, true), (6.6, 6.4, true), (20.0, -6.4, false)];

/// The café's pendant lamps over its tables (x, z), their glow and light.
const PENDANTS: [(f32, f32); 3] = [(-3.9, 9.6), (-3.9, 12.4), (-1.2, 11.0)];
const PENDANT: Color = Color::rgb(255, 205, 150);
const PENDANT_GLOW: f32 = 4.0;
const PENDANT_LIGHT: f32 = 1.8;
const PENDANT_RANGE: f32 = 5.5;
const PENDANT_HEIGHT: f32 = 2.6;

/// The lit shop windows (facade, span) and their glow and light.
const SHOP_GLOW: f32 = 0.45;
const SHOP: Color = Color::rgb(255, 222, 180);
const SHOP_LIGHT: f32 = 1.6;
const SHOP_RANGE: f32 = 6.0;

/// A skin's thickness and how far its visible face stands in front of the wall it covers.
const SKIN: f32 = 0.06;
const SKIN_OUT: f32 = 0.02;

/// The untextured stand-ins of the fetched scans (sRGB) and the plain surfaces.
const ASPHALT: Color = Color::rgb(52, 52, 55);
const PAVING: Color = Color::rgb(128, 124, 118);
const BRICK: Color = Color::rgb(122, 72, 56);
const PLASTER: Color = Color::rgb(214, 208, 196);
const RED_BRICK: Color = Color::rgb(150, 48, 38);
const PARQUET: Color = Color::rgb(150, 98, 60);
const SHUTTER: Color = Color::rgb(92, 104, 110);
const GRANITE: Color = Color::rgb(108, 108, 112);
const MASS: Color = Color::rgb(70, 66, 64);
const METAL: Color = Color::rgb(34, 36, 40);
/// The dark paint over the metal scan: the street furniture and frames read as painted steel.
const METAL_PAINT: Color = Color::rgb(140, 150, 165);
const CHROME: Color = Color::rgb(196, 198, 202);
const WOOD: Color = Color::rgb(96, 62, 40);
const MARBLE: Color = Color::rgb(226, 224, 218);
const RUG: Color = Color::rgb(236, 233, 226);
const LEAVES: Color = Color::rgb(48, 92, 40);
const TERRACOTTA: Color = Color::rgb(170, 92, 60);
const PUDDLE: Color = Color::rgb(26, 28, 32);
const GLASS: Color = Color::rgba(190, 210, 220, 36);
const CAR_PAINT: [Color; 2] = [Color::rgb(150, 24, 28), Color::rgb(30, 52, 92)];
const TYRE: Color = Color::rgb(22, 22, 24);
const TAIL_LIGHT: Color = Color::rgb(255, 30, 20);
const HEAD_LIGHT: Color = Color::rgb(255, 236, 210);
/// The drains' and manhole covers' stand-in: rusty iron.
const IRON: Color = Color::rgb(78, 52, 36);
/// White road paint, worn a little; the awnings' canvases; the menu board's slate; the bottles'
/// glass on the café's shelves.
const ROAD_PAINT: Color = Color::rgb(208, 206, 198);
const CANVAS: [Color; 2] = [Color::rgb(28, 72, 50), Color::rgb(110, 26, 34)];
const SLATE: Color = Color::rgb(30, 32, 34);
const BOTTLE_GLASS: [Color; 3] = [Color::rgb(34, 84, 44), Color::rgb(124, 66, 18), Color::rgb(168, 178, 172)];

/// A textured PBR surface from the fetched maps `fetched/<name>-{albedo,normal,orm}.jpg`, drawing
/// `untextured` in their place where they are missing; `roughness` scales the scan's own.
fn scanned(name: &str, untextured: Color, roughness: f32) -> Material {
    scanned_tinted(name, Color::WHITE, untextured, roughness)
}

/// [`scanned`] with the scan's colour multiplied by `tint` (the street furniture's paint over the
/// metal scan).
fn scanned_tinted(name: &str, tint: Color, untextured: Color, roughness: f32) -> Material {
    Material::color(tint)
        .with_untextured_color(untextured)
        .with_roughness(roughness)
        .with_base_texture(&format!("fetched/{name}-albedo.jpg"))
        .with_normal_texture(&format!("fetched/{name}-normal.jpg"), 1.0)
        .with_metal_rough_texture(&format!("fetched/{name}-orm.jpg"))
}

/// Every surface the draw hook uses, made once per seed.
#[derive(Clone, Debug)]
pub struct Surfaces {
    grate: Material,
    paint: Material,
    canvas: [Material; 2],
    slate: Material,
    bottles: [Material; 3],
    asphalt: Material,
    paving: Material,
    brick: Material,
    plaster: Material,
    red_brick: Material,
    parquet: Material,
    shutter: Material,
    granite: Material,
    mass: Material,
    metal: Material,
    chrome: Material,
    wood: Material,
    marble: Material,
    rug: Material,
    leaves: Material,
    terracotta: Material,
    glass: Material,
    cars: [Material; 2],
    tyre: Material,
}

impl Default for Surfaces {
    fn default() -> Surfaces {
        Surfaces::new()
    }
}

/// The street's surface wet after the rain: the scan's roughness lowered.
const WET: f32 = 0.55;
/// The café's polished parquet.
const POLISHED: f32 = 0.4;
/// The café's lacquered furniture and its honed marble: the scans' roughness lowered.
const LACQUERED: f32 = 0.7;
const HONED: f32 = 0.5;

impl Surfaces {
    /// The surfaces.
    pub fn new() -> Surfaces {
        Surfaces {
            asphalt: scanned("asphalt", ASPHALT, WET),
            paving: scanned("pavement", PAVING, 0.8),
            brick: scanned("brick", BRICK, 1.0),
            plaster: scanned("plaster", PLASTER, 1.0),
            red_brick: scanned("red-brick", RED_BRICK, 1.0),
            parquet: scanned("parquet", PARQUET, POLISHED),
            shutter: scanned("shutter", SHUTTER, 1.0),
            granite: scanned("granite", GRANITE, 1.0),
            mass: Material::color(MASS).with_roughness(0.9),
            metal: scanned_tinted("metal", METAL_PAINT, METAL, 1.0),
            chrome: Material::color(CHROME).with_metallic(1.0).with_roughness(0.2),
            wood: scanned("wood", WOOD, LACQUERED),
            marble: scanned("marble", MARBLE, HONED),
            rug: Material::color(RUG).with_roughness(0.95),
            leaves: Material::color(LEAVES).with_roughness(0.8),
            terracotta: Material::color(TERRACOTTA).with_roughness(0.85),
            glass: Material::color(GLASS).with_roughness(0.04),
            cars: CAR_PAINT.map(|paint| Material::color(paint).with_metallic(0.6).with_roughness(0.3)),
            tyre: Material::color(TYRE).with_roughness(0.9),
            grate: scanned("grate", IRON, 1.0),
            paint: Material::color(ROAD_PAINT).with_roughness(0.6),
            canvas: CANVAS.map(|cloth| Material::color(cloth).with_roughness(0.9)),
            slate: Material::color(SLATE).with_roughness(0.7),
            bottles: BOTTLE_GLASS.map(|glass| Material::color(glass).with_roughness(0.08)),
        }
    }
}

/// How many tiles of about `tile` cover `length` (at least one; the last is never a sliver).
fn tiles_along(length: f32, tile: f32) -> u32 {
    (length / tile).ceil().max(1.0) as u32
}

/// A box from `min` to `max`.
fn block(frame: &mut Frame, min: Vec3, max: Vec3, material: &Material) {
    frame.cube_with(Transform { translation: (min + max) * 0.5, rotation: Quat::IDENTITY, scale: max - min }, material);
}

/// A long box from `min` to `max` (a kerb) cut along its longer horizontal side into stones about
/// `tile` long, so a scan keeps its size along it.
fn stones(frame: &mut Frame, min: Vec3, max: Vec3, tile: f32, material: &Material) {
    let size = max - min;
    let along_x = size.x >= size.z;
    let length = if along_x { size.x } else { size.z };
    let count = tiles_along(length, tile);
    let step = length / count as f32;
    for i in 0..count {
        let (from, to) = (i as f32 * step, (i + 1) as f32 * step);
        let (lo, hi) = if along_x { (vec3(min.x + from, min.y, min.z), vec3(min.x + to, max.y, max.z)) } else { (vec3(min.x, min.y, min.z + from), vec3(max.x, max.y, min.z + to)) };
        block(frame, lo, hi, material);
    }
}

/// A horizontal surface over x `x` and z `z`, its top at `top`, of boxes one `tile` wide.
fn floor(frame: &mut Frame, x: (f32, f32), z: (f32, f32), top: f32, tile: f32, material: &Material) {
    let (nx, nz) = (tiles_along(x.1 - x.0, tile), tiles_along(z.1 - z.0, tile));
    let (w, d) = ((x.1 - x.0) / nx as f32, (z.1 - z.0) / nz as f32);
    for i in 0..nx {
        for k in 0..nz {
            let at = vec3(x.0 + (i as f32 + 0.5) * w, top - SLAB * 0.5, z.0 + (k as f32 + 0.5) * d);
            frame.cube_with(Transform { translation: at, rotation: Quat::IDENTITY, scale: vec3(w, SLAB, d) }, material);
        }
    }
}

/// A wall's face: along x (facing ±z, at z = `at`) or along z (facing ±x, at x = `at`), its outward
/// side `out` (±1), over `span` along it and `rise` up it.
#[derive(Clone, Copy, Debug)]
struct Face {
    along_x: bool,
    at: f32,
    out: f32,
    span: (f32, f32),
    rise: (f32, f32),
}

impl Face {
    fn x(at: f32, out: f32, span: (f32, f32), rise: (f32, f32)) -> Face {
        Face { along_x: true, at, out, span, rise }
    }

    fn z(at: f32, out: f32, span: (f32, f32), rise: (f32, f32)) -> Face {
        Face { along_x: false, at, out, span, rise }
    }

    /// The point `s` along it and `y` up it, `lift` in front of its face.
    fn point(&self, s: f32, y: f32, lift: f32) -> Vec3 {
        let across = self.at + self.out * lift;
        if self.along_x { vec3(s, y, across) } else { vec3(across, y, s) }
    }

    /// Which way along it a person facing it reads left to right: +1 along +x or +z, −1 against.
    fn reading(&self) -> f32 {
        if self.along_x { self.out } else { -self.out }
    }

    /// The unit normal it faces out along.
    fn normal(&self) -> Vec3 {
        if self.along_x { vec3(0.0, 0.0, self.out) } else { vec3(self.out, 0.0, 0.0) }
    }

    /// A turn that lays a box made facing ±z to face this face's way.
    fn turn(&self) -> Quat {
        if self.along_x { Quat::IDENTITY } else { Quat::from_rotation_y(FRAC_PI_2) }
    }
}

/// Cover `face` with boxes one `tile` wide (so a scan keeps its size and its rows stay level),
/// `lift` further out than a plain skin (an overlay: a shutter or a shop window on the brick).
fn skin(frame: &mut Frame, face: Face, tile: f32, lift: f32, material: &Material) {
    let (ns, ny) = (tiles_along(face.span.1 - face.span.0, tile), tiles_along(face.rise.1 - face.rise.0, tile));
    let (w, h) = ((face.span.1 - face.span.0) / ns as f32, (face.rise.1 - face.rise.0) / ny as f32);
    for i in 0..ns {
        for j in 0..ny {
            let at = face.point(face.span.0 + (i as f32 + 0.5) * w, face.rise.0 + (j as f32 + 0.5) * h, SKIN_OUT + lift);
            frame.cube_with(Transform { translation: at, rotation: face.turn(), scale: vec3(w, h, SKIN) }, material);
        }
    }
}

/// The scans' real sizes in metres (assets-manifest.json `worldSizeMetres`).
const ASPHALT_TILE: f32 = 3.0;
const PAVING_TILE: f32 = 1.8;
const BRICK_TILE: f32 = 3.0;
const PLASTER_TILE: f32 = 2.0;
const RED_BRICK_TILE: f32 = 2.0;
const PARQUET_TILE: f32 = 3.4;
const SHUTTER_TILE: f32 = 2.0;
const GRANITE_TILE: f32 = 2.3;

/// Draw Harbour Street.
pub fn draw(world: &World, frame: &mut Frame) {
    if world.is_cut() {
        frame.camera_cut();
    }
    let t = world.seconds();
    frame.clear(DUSK);
    frame.sun(SUN_DIR, SUN_COLOR, SUN_INTENSITY).ambient(AMBIENT_COLOR, AMBIENT_INTENSITY);
    frame.environment(world.backdrop.environment());
    let s = &world.surfaces;
    ground(frame, s);
    buildings(frame, s);
    shops(frame, s);
    cafe(frame, s);
    cafe_inside(frame, s);
    lamps(frame, s);
    neon(frame, s, t);
    festoons(frame, t);
    street_things(frame, s);
    decals(frame);
    markings(frame, s);
    drains(frame, s);
    awnings(frame, s);
    alley(frame, s);
    weather(frame, &world.weather);
}

fn ground(frame: &mut Frame, s: &Surfaces) {
    frame.tag("ground");
    let (e, h, f) = (EXTENT, STREET_HALF, FACADE);
    // The asphalt: the main street, then the side street south of the crossing.
    floor(frame, (-e, e), (-h, h), 0.0, ASPHALT_TILE, &s.asphalt);
    floor(frame, (-h, h), (-e, -h), 0.0, ASPHALT_TILE, &s.asphalt);
    // Kerb stones along every pavement's street edge, and the pavements behind them: north of the
    // main street, then either side of the side street (each with its corner).
    let k = 0.2;
    stones(frame, vec3(-e, -SLAB, h), vec3(e, KERB, h + k), GRANITE_TILE, &s.granite);
    floor(frame, (-e, e), (h + k, f), KERB, PAVING_TILE, &s.paving);
    let span = |a: f32, b: f32| (a.min(b), a.max(b));
    for side in [-1.0_f32, 1.0] {
        let (along, kerb_line) = (span(side * e, side * h), span(side * h, side * (h + k)));
        stones(frame, vec3(along.0, -SLAB, -h - k), vec3(along.1, KERB, -h), GRANITE_TILE, &s.granite);
        stones(frame, vec3(kerb_line.0, -SLAB, -e), vec3(kerb_line.1, KERB, -h - k), GRANITE_TILE, &s.granite);
        floor(frame, span(side * e, side * (h + k)), (-f, -h - k), KERB, PAVING_TILE, &s.paving);
        floor(frame, span(side * f, side * (h + k)), (-e, -f), KERB, PAVING_TILE, &s.paving);
    }
    // The alley's paving, up to its end wall.
    floor(frame, (ALLEY_WEST, ALLEY_EAST), (f, ALLEY_END), KERB, PAVING_TILE, &s.paving);
}

/// The buildings: plain masses, each street face covered in brick.
fn buildings(frame: &mut Frame, s: &Surfaces) {
    frame.tag("buildings");
    let (e, f) = (EXTENT, FACADE);
    let deep = ALLEY_END;
    // North of the street: west of the café, over and behind it, between it and the alley, east of
    // the alley, and the alley's end.
    block(frame, vec3(-e, 0.0, f), vec3(CAFE_WEST, NORTH_HEIGHT, deep), &s.mass);
    block(frame, vec3(CAFE_WEST, CAFE_STOREY, f), vec3(CAFE_EAST, NORTH_HEIGHT, deep), &s.mass);
    block(frame, vec3(CAFE_WEST, 0.0, CAFE_BACK), vec3(CAFE_EAST, CAFE_STOREY, deep), &s.mass);
    block(frame, vec3(CAFE_EAST, 0.0, f), vec3(ALLEY_WEST, NORTH_HEIGHT, deep), &s.mass);
    block(frame, vec3(ALLEY_EAST, 0.0, f), vec3(e, NORTH_HEIGHT, deep), &s.mass);
    block(frame, vec3(ALLEY_WEST, 0.0, ALLEY_END), vec3(ALLEY_EAST, NORTH_HEIGHT, ALLEY_END + 1.5), &s.mass);
    // South of the street: the two blocks either side of the side street.
    block(frame, vec3(-e, 0.0, -e), vec3(-f, SOUTH_WEST_HEIGHT, -f), &s.mass);
    block(frame, vec3(f, 0.0, -e), vec3(e, SOUTH_EAST_HEIGHT, -f), &s.mass);
    let faces = [
        Face::x(f, -1.0, (-e, CAFE_WEST), (0.0, NORTH_HEIGHT)),
        Face::x(f, -1.0, (CAFE_WEST, CAFE_EAST), (CAFE_STOREY, NORTH_HEIGHT)),
        Face::x(f, -1.0, (CAFE_EAST, ALLEY_WEST), (0.0, NORTH_HEIGHT)),
        Face::x(f, -1.0, (ALLEY_EAST, e), (0.0, NORTH_HEIGHT)),
        Face::z(ALLEY_WEST, 1.0, (f, ALLEY_END), (0.0, NORTH_HEIGHT)),
        Face::z(ALLEY_EAST, -1.0, (f, ALLEY_END), (0.0, NORTH_HEIGHT)),
        Face::x(ALLEY_END, -1.0, (ALLEY_WEST, ALLEY_EAST), (0.0, NORTH_HEIGHT)),
        Face::x(-f, 1.0, (-e, -f), (0.0, SOUTH_WEST_HEIGHT)),
        Face::z(-f, 1.0, (-e, -f), (0.0, SOUTH_WEST_HEIGHT)),
        Face::x(-f, 1.0, (f, e), (0.0, SOUTH_EAST_HEIGHT)),
        Face::z(f, -1.0, (-e, -f), (0.0, SOUTH_EAST_HEIGHT)),
    ];
    for face in faces {
        skin(frame, face, BRICK_TILE, 0.0, &s.brick);
    }
}

/// The ground-floor shops: closed shutters, and lit windows with their light spilling out.
fn shops(frame: &mut Frame, s: &Surfaces) {
    frame.tag("shops");
    let f = FACADE;
    let door = (KERB, 3.2);
    let shutters = [
        Face::x(f, -1.0, (-16.0, -10.0), door),
        Face::x(f, -1.0, (7.0, 12.0), door),
        Face::x(-f, 1.0, (-28.0, -22.0), door),
        Face::x(-f, 1.0, (20.0, 26.0), door),
        Face::z(-f, 1.0, (-20.0, -14.0), door),
        Face::z(f, -1.0, (-24.0, -18.0), door),
    ];
    for face in shutters {
        skin(frame, face, SHUTTER_TILE, 0.02, &s.shutter);
    }
    let lit = [Face::x(f, -1.0, (-26.0, -20.0), (0.6, 3.0)), Face::x(-f, 1.0, (-18.0, -12.0), (0.6, 3.0)), Face::x(-f, 1.0, (10.0, 16.0), (0.6, 3.0))];
    let display = Material::emissive(SHOP, SHOP_GLOW);
    for face in lit {
        let middle = (face.span.0 + face.span.1) * 0.5;
        let size = vec3(face.span.1 - face.span.0, face.rise.1 - face.rise.0, SKIN);
        let rise = (face.rise.0 + face.rise.1) * 0.5;
        frame.cube_with(Transform { translation: face.point(middle, rise, 0.04), rotation: face.turn(), scale: size }, &display);
        frame.cube_with(Transform { translation: face.point(middle, rise, 0.12), rotation: face.turn(), scale: vec3(size.x, size.y, 0.02) }, &s.glass);
        frame.cube_with(Transform { translation: face.point(middle, face.rise.1 + 0.06, 0.1), rotation: face.turn(), scale: vec3(size.x + 0.2, 0.12, 0.16) }, &s.metal);
        frame.point_light(face.point(middle, 1.8, 0.9), SHOP_RANGE, SHOP, SHOP_LIGHT);
    }
}

/// The café's front: plaster piers, sills and heads around two big windows and its door, glass in
/// the windows, dark metal frames, a stone threshold and the door standing open into the room.
fn cafe(frame: &mut Frame, s: &Surfaces) {
    frame.tag("cafe");
    let (front, inner) = (FACADE, CAFE_FRONT);
    let [(a0, a1), (b0, b1)] = WINDOWS;
    let piers = [(CAFE_WEST, a0), (a1, b0), (b1, DOOR.0), (DOOR.1, CAFE_EAST)];
    for (x0, x1) in piers {
        block(frame, vec3(x0, 0.0, front), vec3(x1, CAFE_STOREY, inner), &s.plaster);
    }
    for (x0, x1) in WINDOWS {
        block(frame, vec3(x0, 0.0, front), vec3(x1, SILL, inner), &s.plaster);
        block(frame, vec3(x0, HEAD, front), vec3(x1, CAFE_STOREY, inner), &s.plaster);
        let middle = (front + inner) * 0.5;
        block(frame, vec3(x0, SILL, middle - 0.01), vec3(x1, HEAD, middle + 0.01), &s.glass);
        // The frame: sill, head and jambs, and a mullion in the wide window.
        block(frame, vec3(x0, SILL, middle - 0.04), vec3(x1, SILL + 0.06, middle + 0.04), &s.metal);
        block(frame, vec3(x0, HEAD - 0.06, middle - 0.04), vec3(x1, HEAD, middle + 0.04), &s.metal);
        for x in [x0, x1 - 0.06] {
            block(frame, vec3(x, SILL, middle - 0.04), vec3(x + 0.06, HEAD, middle + 0.04), &s.metal);
        }
        if x1 - x0 > 3.0 {
            let mid = (x0 + x1) * 0.5;
            block(frame, vec3(mid - 0.03, SILL, middle - 0.04), vec3(mid + 0.03, HEAD, middle + 0.04), &s.metal);
        }
    }
    block(frame, vec3(DOOR.0, DOOR_HEAD, front), vec3(DOOR.1, CAFE_STOREY, inner), &s.plaster);
    block(frame, vec3(DOOR.0, -SLAB, front), vec3(DOOR.1, KERB, inner), &s.granite);
    // The door, open: hinged at the east jamb, swung into the room against the wall.
    block(frame, vec3(DOOR.1 - 0.06, KERB, inner), vec3(DOOR.1, DOOR_HEAD - 0.05, inner + DOOR.1 - DOOR.0 - 0.05), &s.wood);
}

/// The café's room: the parquet, the red brick wall (west), plaster elsewhere, the ceiling, the
/// counter with its marble top and panelled front, the shelves of bottles behind it, three tables
/// with chairs under pendant lamps, the white rug by the red wall, two plants and a cup on the
/// window table.
fn cafe_inside(frame: &mut Frame, s: &Surfaces) {
    frame.tag("cafe-inside");
    // The polished parquet reflects the room, not the sky (A.3).
    frame.reflection_probe(&ReflectionProbe::new(CAFE_INSIDE.min, CAFE_INSIDE.max).with_capture(CAFE_PROBE_CAPTURE).with_blend(CAFE_PROBE_BLEND));
    // The lamps' light bounced off the red brick reaches the white rug beside it, and the street's
    // sky stays outside the room's walls (A.4): a cell about every metre, fading out over the front
    // wall's thickness like the probe.
    frame.irradiance_volume(&IrradianceVolume::new(CAFE_INSIDE.min, CAFE_INSIDE.max).with_blend(CAFE_PROBE_BLEND));
    let (x, z) = ((CAFE_WEST, CAFE_EAST), (CAFE_FRONT, CAFE_BACK));
    floor(frame, x, z, KERB, PARQUET_TILE, &s.parquet);
    floor(frame, x, z, CAFE_CEILING + SLAB, PLASTER_TILE, &s.plaster);
    let rise = (KERB, CAFE_CEILING);
    skin(frame, Face::z(CAFE_WEST, 1.0, z, rise), RED_BRICK_TILE, 0.0, &s.red_brick);
    skin(frame, Face::z(CAFE_EAST, -1.0, z, rise), PLASTER_TILE, 0.0, &s.plaster);
    skin(frame, Face::x(CAFE_BACK, -1.0, x, rise), PLASTER_TILE, 0.0, &s.plaster);
    block(frame, BLEED_FLOOR.min, BLEED_FLOOR.max, &s.rug);
    // The counter along the back wall, its marble top, the shelves behind it and a coffee machine.
    block(frame, vec3(-0.6, KERB, 14.2), vec3(4.6, 1.05, 14.95), &s.wood);
    block(frame, vec3(-0.7, 1.05, 14.15), vec3(4.7, 1.1, 15.0), &s.marble);
    for y in [1.7, 2.3] {
        block(frame, vec3(0.2, y, CAFE_BACK - 0.3), vec3(4.2, y + 0.04, CAFE_BACK - SKIN_OUT - SKIN * 0.5), &s.wood);
    }
    block(frame, vec3(3.0, 1.1, 14.45), vec3(3.5, 1.5, 14.85), &s.chrome);
    counter_front(frame, s);
    shelf_bottles(frame, s);
    // Tables, each with two chairs, under the pendant lamps.
    for (tx, tz) in PENDANTS {
        table(frame, s, tx, tz);
        for side in [-1.0_f32, 1.0] {
            chair(frame, s, vec3(tx, KERB, tz + side * 0.65), side);
        }
        let lamp = vec3(tx, PENDANT_HEIGHT, tz);
        frame.line(lamp, vec3(tx, CAFE_CEILING, tz), Color::rgb(20, 18, 16));
        frame.sphere_with(lamp, 0.13, &Material::emissive(PENDANT, PENDANT_GLOW));
        frame.point_light(lamp - vec3(0.0, 0.2, 0.0), PENDANT_RANGE, PENDANT, PENDANT_LIGHT);
    }
    // The prop for the depth-of-field close-up: a cup and saucer on the window table.
    let (cx, cz) = (PENDANTS[0].0 + 0.15, PENDANTS[0].1 - 0.1);
    block(frame, vec3(cx - 0.08, 0.9, cz - 0.08), vec3(cx + 0.08, 0.91, cz + 0.08), &s.marble);
    block(frame, vec3(cx - 0.04, 0.91, cz - 0.04), vec3(cx + 0.04, 0.99, cz + 0.04), &s.marble);
    // Plants in terracotta pots: by the door and in the back corner.
    for (px, pz) in [(5.2, 8.5), (-5.3, 15.1)] {
        block(frame, vec3(px - 0.25, KERB, pz - 0.25), vec3(px + 0.25, 0.65, pz + 0.25), &s.terracotta);
        frame.sphere_with(vec3(px, 1.0, pz), 0.42, &s.leaves);
    }
}

/// The counter's front (it faces the room, −z): wooden stiles over its panel and a dark metal kick
/// plinth along the floor.
fn counter_front(frame: &mut Frame, s: &Surfaces) {
    let face = 14.2;
    block(frame, vec3(-0.6, KERB, face - 0.03), vec3(4.6, KERB + 0.1, face), &s.metal);
    for i in 0..=6 {
        let x = -0.6 + i as f32 * (5.2 / 6.0);
        block(frame, vec3(x - 0.03, KERB + 0.1, face - 0.02), vec3(x + 0.03, 1.05, face), &s.wood);
    }
}

/// Bottles and jars on the shelves behind the counter: green, amber and clear glass in turn.
fn shelf_bottles(frame: &mut Frame, s: &Surfaces) {
    let z = CAFE_BACK - 0.18;
    for (row, y) in [1.74_f32, 2.34].into_iter().enumerate() {
        for i in 0..12 {
            let x = 0.35 + i as f32 * 0.32;
            let glass = &s.bottles[(i + row) % s.bottles.len()];
            if (i + row) % 4 == 3 {
                block(frame, vec3(x - 0.06, y, z - 0.06), vec3(x + 0.06, y + 0.14, z + 0.06), glass);
                continue;
            }
            block(frame, vec3(x - 0.035, y, z - 0.035), vec3(x + 0.035, y + 0.22, z + 0.035), glass);
            block(frame, vec3(x - 0.012, y + 0.22, z - 0.012), vec3(x + 0.012, y + 0.3, z + 0.012), glass);
        }
    }
}

/// A café table at (`x`, `z`): a wooden top on a metal column over a cross of feet.
fn table(frame: &mut Frame, s: &Surfaces, x: f32, z: f32) {
    block(frame, vec3(x - 0.4, 0.86, z - 0.4), vec3(x + 0.4, 0.9, z + 0.4), &s.wood);
    block(frame, vec3(x - 0.03, KERB + 0.02, z - 0.03), vec3(x + 0.03, 0.86, z + 0.03), &s.metal);
    block(frame, vec3(x - 0.28, KERB, z - 0.03), vec3(x + 0.28, KERB + 0.025, z + 0.03), &s.metal);
    block(frame, vec3(x - 0.03, KERB, z - 0.28), vec3(x + 0.03, KERB + 0.025, z + 0.28), &s.metal);
}

/// A chair standing at `at` (its seat's centre over the floor), its back on the `side` away from
/// the table (±z): a wooden seat on four metal legs, the back legs rising into the back's posts,
/// a wooden top rail and a middle rail.
fn chair(frame: &mut Frame, s: &Surfaces, at: Vec3, side: f32) {
    const HALF: f32 = 0.21;
    const LEG: f32 = 0.015;
    const SEAT: f32 = 0.6;
    const BACK: f32 = 1.04;
    block(frame, vec3(at.x - HALF, SEAT - 0.03, at.z - HALF), vec3(at.x + HALF, SEAT + 0.01, at.z + HALF), &s.wood);
    for (dx, dz) in [(-1.0_f32, -1.0_f32), (-1.0, 1.0), (1.0, -1.0), (1.0, 1.0)] {
        let (x, z) = (at.x + dx * (HALF - 0.03), at.z + dz * (HALF - 0.03));
        let top = if dz == side { BACK } else { SEAT - 0.03 };
        block(frame, vec3(x - LEG, at.y, z - LEG), vec3(x + LEG, top, z + LEG), &s.metal);
    }
    let back = at.z + side * (HALF - 0.03);
    for (low, high) in [(BACK - 0.1, BACK), (0.78, 0.83)] {
        block(frame, vec3(at.x - HALF + 0.02, low, back - 0.015), vec3(at.x + HALF - 0.02, high, back + 0.015), &s.wood);
    }
}

/// The street lamps: a post on the pavement, an arm over the street and a glowing head with a spot
/// shining down (the two at the crossing shadowed).
fn lamps(frame: &mut Frame, s: &Surfaces) {
    frame.tag("lamps");
    for (x, z, shadow) in LAMPS {
        let toward_street = -z.signum();
        block(frame, vec3(x - 0.07, KERB, z - 0.07), vec3(x + 0.07, LAMP_HEIGHT + 0.1, z + 0.07), &s.metal);
        let arm_end = z + toward_street * 1.1;
        block(frame, vec3(x - 0.04, LAMP_HEIGHT + 0.05, z.min(arm_end)), vec3(x + 0.04, LAMP_HEIGHT + 0.12, z.max(arm_end)), &s.metal);
        let head = vec3(x, LAMP_HEIGHT, arm_end);
        frame.cube_with(Transform { translation: head, rotation: Quat::IDENTITY, scale: vec3(0.3, 0.08, 0.45) }, &Material::emissive(LAMP, LAMP_GLOW));
        let (inner, outer) = LAMP_CONE_DEGREES;
        let spot = SpotLight::new(head - vec3(0.0, 0.1, 0.0), vec3(0.0, -1.0, toward_street * 0.15), LAMP_RANGE, LAMP, LAMP_LIGHT);
        frame.spot_light_with(&spot.with_cone_degrees(inner, outer).with_shadow(shadow));
    }
}

/// One neon sign: glowing tubes (boxes in the sign's frame on `face`) and its light in front.
fn sign(frame: &mut Frame, face: Face, at: (f32, f32), tubes: &[(f32, f32, f32, f32)], color: Color, bright: f32) {
    let glow = Material::emissive(color, NEON_GLOW * bright);
    for (s0, y0, s1, y1) in tubes {
        let middle = face.point(at.0 + face.reading() * (s0 + s1) * 0.5, at.1 + (y0 + y1) * 0.5, 0.12);
        let size = vec3((s1 - s0).abs().max(0.05), (y1 - y0).abs().max(0.05), 0.05);
        frame.cube_with(Transform { translation: middle, rotation: face.turn(), scale: size }, &glow);
    }
    frame.point_light(face.point(at.0, at.1, 0.9), NEON_RANGE, color, NEON_LIGHT * bright);
}

/// A blade sign standing out from `face` at `at` along it over `rise`: a dark panel with a neon
/// tube round its edge and three bars across it on both sides, glowing `color` at `bright` of its
/// full strength, and its light.
fn blade(frame: &mut Frame, s: &Surfaces, face: Face, at: f32, rise: (f32, f32), (color, bright): (Color, f32)) {
    const WIDTH: f32 = 0.8;
    const OUT: f32 = 0.55;
    const TUBE: f32 = 0.04;
    let height = rise.1 - rise.0;
    let middle_y = (rise.0 + rise.1) * 0.5;
    let turn = face.turn() * Quat::from_rotation_y(FRAC_PI_2);
    frame.cube_with(Transform { translation: face.point(at, middle_y, OUT), rotation: turn, scale: vec3(WIDTH, height, 0.08) }, &s.metal);
    frame.cube_with(Transform { translation: face.point(at, rise.1 + 0.05, OUT - 0.05), rotation: turn, scale: vec3(WIDTH + 0.15, 0.05, 0.05) }, &s.metal);
    let glow = Material::emissive(color, NEON_GLOW * bright);
    // Tubes in the panel's frame: (out from the wall, up, length along out, length up).
    let (w, h) = (WIDTH * 0.5 - 0.06, height * 0.5 - 0.06);
    let mut tubes = vec![(0.0, h, w * 2.0, TUBE), (0.0, -h, w * 2.0, TUBE), (-w, 0.0, TUBE, h * 2.0), (w, 0.0, TUBE, h * 2.0)];
    tubes.extend([-0.5, 0.0, 0.5].map(|k| (0.0, k * h, w * 1.3, TUBE)));
    for side in [-1.0_f32, 1.0] {
        for (u, v, du, dv) in &tubes {
            let along = turn * vec3(*u, 0.0, side * 0.05);
            let at_point = face.point(at, middle_y + v, OUT) + along;
            frame.cube_with(Transform { translation: at_point, rotation: turn, scale: vec3(*du, *dv, TUBE) }, &glow);
        }
    }
    frame.point_light(face.point(at, middle_y, OUT + 0.7), NEON_RANGE, color, NEON_LIGHT * bright);
}

/// The neon: the café's amber sign, a magenta blade sign up the street, a cyan sign over a shop
/// across it, and the alley's signs (one of them flickering).
fn neon(frame: &mut Frame, s: &Surfaces, t: f32) {
    frame.tag("neon");
    let f = FACADE;
    let north = Face::x(f, -1.0, (-EXTENT, EXTENT), (0.0, NORTH_HEIGHT));
    // CAFE: four letters as tubes over the café's windows.
    let letters = [
        (-1.6, 0.0, -1.55, 0.6),
        (-1.6, 0.0, -1.1, 0.05),
        (-1.6, 0.55, -1.1, 0.6),
        (-0.8, 0.0, -0.75, 0.6),
        (-0.35, 0.0, -0.3, 0.6),
        (-0.8, 0.55, -0.3, 0.6),
        (-0.8, 0.3, -0.3, 0.35),
        (0.1, 0.0, 0.15, 0.6),
        (0.1, 0.55, 0.6, 0.6),
        (0.1, 0.3, 0.45, 0.35),
        (0.95, 0.0, 1.0, 0.6),
        (0.95, 0.55, 1.45, 0.6),
        (0.95, 0.3, 1.35, 0.35),
        (0.95, 0.0, 1.45, 0.05),
    ];
    sign(frame, north, (-1.2, 4.2), &letters, AMBER, 1.0);
    blade(frame, s, north, -19.0, (4.4, 6.8), (MAGENTA, 1.0));
    let south_east = Face::x(-f, 1.0, (f, EXTENT), (0.0, SOUTH_EAST_HEIGHT));
    sign(frame, south_east, (13.0, 3.5), &[(-2.4, 0.0, 2.4, 0.06), (-2.4, 0.3, 2.4, 0.36)], CYAN, 1.0);
    let alley_west = Face::z(ALLEY_WEST, 1.0, (f, ALLEY_END), (0.0, NORTH_HEIGHT));
    let alley_east = Face::z(ALLEY_EAST, -1.0, (f, ALLEY_END), (0.0, NORTH_HEIGHT));
    blade(frame, s, alley_west, 12.0, (3.4, 5.4), (MAGENTA, 1.0));
    blade(frame, s, alley_east, 18.0, (2.8, 4.4), (CYAN, 1.0));
    // The alley's broken amber sign flickers: nearly off for a moment every few seconds.
    let flicker = if math::sin(t * 2.3) > 0.93 { 0.15 } else { 1.0 };
    blade(frame, s, alley_west, 24.0, (4.2, 6.0), (AMBER, flicker));
    let end = Face::x(ALLEY_END, -1.0, (ALLEY_WEST, ALLEY_EAST), (0.0, NORTH_HEIGHT));
    let frame_tubes = [(-1.0, 0.0, 1.0, 0.05), (-1.0, 1.0, 1.0, 1.05), (-1.0, 0.0, -0.95, 1.05), (0.95, 0.0, 1.0, 1.05)];
    sign(frame, end, ((ALLEY_WEST + ALLEY_EAST) * 0.5, 3.2), &frame_tubes, MAGENTA, 1.0);
}

/// The festoon strings across the main street: warm bulbs on a sagging wire, each a light.
fn festoons(frame: &mut Frame, t: f32) {
    frame.tag("festoons");
    let glow = Material::emissive(BULB, BULB_GLOW);
    let span = FACADE - 0.3;
    for (string, x) in FESTOON_X.iter().enumerate() {
        // The wire sways a little in the evening breeze.
        let sway = 0.03 * math::sin(t * 0.7 + string as f32 * 1.3);
        let mut last: Option<Vec3> = None;
        for i in 0..BULBS_PER_STRING {
            let u = i as f32 / (BULBS_PER_STRING - 1) as f32;
            let z = -span + 2.0 * span * u;
            let sag = FESTOON_SAG * (1.0 - (2.0 * u - 1.0) * (2.0 * u - 1.0));
            let at = vec3(x + sway * sag, FESTOON_HIGH - sag, z);
            if let Some(previous) = last {
                frame.line(previous + vec3(0.0, BULB_RADIUS, 0.0), at + vec3(0.0, BULB_RADIUS, 0.0), WIRE);
            }
            frame.sphere_with(at, BULB_RADIUS, &glow);
            frame.point_light(at, BULB_RANGE, BULB, BULB_LIGHT);
            last = Some(at);
        }
    }
}

/// What stands in the street: two parked cars, bollards, a bench and the café's menu board.
fn street_things(frame: &mut Frame, s: &Surfaces) {
    frame.tag("street");
    for ((x, z, heading), paint) in [(-14.0, -3.2, 0.0), (20.0, 3.2, math::PI)].into_iter().zip(&s.cars) {
        car(frame, s, vec3(x, 0.0, z), heading, paint);
    }
    for x in [-5.5, -4.5, 4.5, 5.5] {
        block(frame, vec3(x - 0.08, KERB, 4.85), vec3(x + 0.08, 1.0, 5.01), &s.metal);
    }
    bench(frame, s);
    menu_board(frame, s, vec3(1.7, KERB, 6.4));
}

/// The bench against the café's neighbour: three seat slats and two back slats on metal frames.
fn bench(frame: &mut Frame, s: &Surfaces) {
    let (x0, x1) = (-12.0, -10.4);
    for (i, z) in [6.62_f32, 6.78, 6.94].into_iter().enumerate() {
        let low = 0.45 - 0.004 * i as f32;
        block(frame, vec3(x0, low, z - 0.06), vec3(x1, low + 0.04, z + 0.06), &s.wood);
    }
    for y in [0.62_f32, 0.8] {
        block(frame, vec3(x0, y, 7.04), vec3(x1, y + 0.1, 7.08), &s.wood);
    }
    for x in [-11.9, -10.5] {
        block(frame, vec3(x - 0.03, KERB, 6.62), vec3(x + 0.03, 0.45, 6.68), &s.metal);
        block(frame, vec3(x - 0.03, KERB, 6.98), vec3(x + 0.03, 0.92, 7.04), &s.metal);
    }
}

/// The café's A-frame menu board standing on the pavement at `at` (its feet's middle): two slate
/// boards in wooden frames leaning together.
fn menu_board(frame: &mut Frame, s: &Surfaces, at: Vec3) {
    const HEIGHT: f32 = 0.9;
    const WIDTH: f32 = 0.55;
    const LEAN: f32 = 0.2;
    for side in [-1.0_f32, 1.0] {
        let tilt = Quat::from_rotation_x(-side * LEAN);
        let centre = at + vec3(0.0, HEIGHT * 0.5, side * math::sin(LEAN) * HEIGHT * 0.5);
        frame.cube_with(Transform { translation: centre, rotation: tilt, scale: vec3(WIDTH, HEIGHT, 0.025) }, &s.wood);
        let face = centre + tilt * vec3(0.0, 0.04, side * 0.014);
        frame.cube_with(Transform { translation: face, rotation: tilt, scale: vec3(WIDTH - 0.08, HEIGHT - 0.16, 0.006) }, &s.slate);
    }
}

/// A parked car's blockout at `at` facing `heading` (radians about +y): body, cabin, wheels and
/// glowing tail lights.
fn car(frame: &mut Frame, s: &Surfaces, at: Vec3, heading: f32, paint: &Material) {
    let turn = Quat::from_rotation_y(heading);
    let place = |p: Vec3, size: Vec3| Transform { translation: at + turn * p, rotation: turn, scale: size };
    frame.cube_with(place(vec3(0.0, 0.62, 0.0), vec3(4.2, 0.62, 1.8)), paint);
    frame.cube_with(place(vec3(-0.2, 1.18, 0.0), vec3(2.2, 0.5, 1.62)), &s.glass);
    frame.cube_with(place(vec3(-0.2, 1.45, 0.0), vec3(2.0, 0.05, 1.5)), paint);
    for (dx, dz) in [(1.35, 0.8), (1.35, -0.8), (-1.35, 0.8), (-1.35, -0.8)] {
        frame.cube_with(place(vec3(dx, 0.33, dz), vec3(0.66, 0.66, 0.24)), &s.tyre);
    }
    for dz in [0.65, -0.65] {
        frame.cube_with(place(vec3(-2.11, 0.75, dz), vec3(0.03, 0.1, 0.3)), &Material::emissive(TAIL_LIGHT, 2.0));
        frame.cube_with(place(vec3(2.11, 0.72, dz), vec3(0.03, 0.12, 0.32)), &Material::emissive(HEAD_LIGHT, 0.6));
    }
    // Bumpers, front and back, and the dark sills along the doors.
    for dx in [2.13_f32, -2.13] {
        frame.cube_with(place(vec3(dx, 0.42, 0.0), vec3(0.08, 0.16, 1.84)), &s.metal);
    }
    for dz in [0.91_f32, -0.91] {
        frame.cube_with(place(vec3(0.0, 0.36, dz), vec3(2.4, 0.08, 0.03)), &s.tyre);
    }
}

/// Road paint's thickness: it lies on the asphalt (whose top is y = 0); the puddles' decals cover it.
const PAINT: f32 = 0.004;
/// The zebra crossings: stripes across a street, each this wide and long, this far from the main
/// street's kerb line, and the stop line this far before them.
const ZEBRA_STRIPES: usize = 6;
const STRIPE_WIDTH: f32 = 0.5;
const STRIPE_LENGTH: f32 = 2.4;
const ZEBRA_SET_BACK: f32 = 0.8;
const STOP_LINE: f32 = 0.3;
const STOP_GAP: f32 = 0.6;
/// The centre line's dashes: long, gap and width.
const DASH: f32 = 3.0;
const DASH_GAP: f32 = 3.0;
const DASH_WIDTH: f32 = 0.12;

/// A patch of road paint over x `x` and z `z`.
fn paint(frame: &mut Frame, x: (f32, f32), z: (f32, f32), material: &Material) {
    block(frame, vec3(x.0, 0.0, z.0), vec3(x.1, PAINT, z.1), material);
}

/// Dashes along a centre line from `from` to `to` (either way), across `across` (x when the line
/// runs along z, z when it runs along x).
fn dashes(frame: &mut Frame, along_x: bool, from: f32, to: f32, across: f32, material: &Material) {
    let (lo, hi) = (from.min(to), from.max(to));
    let mut at = lo;
    while at + DASH <= hi {
        let line = (across - DASH_WIDTH * 0.5, across + DASH_WIDTH * 0.5);
        if along_x { paint(frame, (at, at + DASH), line, material) } else { paint(frame, line, (at, at + DASH), material) }
        at += DASH + DASH_GAP;
    }
}

/// The road markings: a zebra crossing over the side street and one over the main street west of
/// the crossing, each with its stop line, and the centre lines' dashes.
fn markings(frame: &mut Frame, s: &Surfaces) {
    frame.tag("markings");
    let h = STREET_HALF;
    let pitch = 2.0 * h / ZEBRA_STRIPES as f32;
    let near = h + ZEBRA_SET_BACK;
    let far = near + STRIPE_LENGTH;
    for i in 0..ZEBRA_STRIPES {
        let middle = -h + (i as f32 + 0.5) * pitch;
        let stripe = (middle - STRIPE_WIDTH * 0.5, middle + STRIPE_WIDTH * 0.5);
        // Across the side street (stripes along z), then across the main street (along x).
        paint(frame, stripe, (-far, -near), &s.paint);
        paint(frame, (-far, -near), stripe, &s.paint);
    }
    let stop = (-far - STOP_GAP - STOP_LINE, -far - STOP_GAP);
    paint(frame, (0.1, h - 0.3), stop, &s.paint);
    paint(frame, stop, (-h + 0.3, -0.1), &s.paint);
    let past = far + STOP_GAP + STOP_LINE + 0.3;
    dashes(frame, true, -EXTENT, -past, 0.0, &s.paint);
    dashes(frame, true, h + 0.5, EXTENT, 0.0, &s.paint);
    dashes(frame, false, -EXTENT, -past, 0.0, &s.paint);
}

/// The drains along the kerbs (x along the main street, the kerb's side) and the manhole covers
/// (x, z): rusty iron lying in the asphalt.
const DRAINS: [(f32, f32); 6] = [(-24.0, 1.0), (-12.0, -1.0), (12.0, 1.0), (24.0, -1.0), (-28.0, -1.0), (27.0, 1.0)];
const MANHOLES: [(f32, f32); 3] = [(-20.0, -1.6), (12.5, 1.9), (1.6, -18.0)];
const DRAIN_SIZE: (f32, f32) = (0.7, 0.35);
const MANHOLE_SIDE: f32 = 0.75;

/// The drains and the manhole covers.
fn drains(frame: &mut Frame, s: &Surfaces) {
    frame.tag("drains");
    for (x, side) in DRAINS {
        let z = side * (STREET_HALF - DRAIN_SIZE.1 * 0.5 - 0.05);
        paint(frame, (x - DRAIN_SIZE.0 * 0.5, x + DRAIN_SIZE.0 * 0.5), (z - DRAIN_SIZE.1 * 0.5, z + DRAIN_SIZE.1 * 0.5), &s.grate);
    }
    let r = MANHOLE_SIDE * 0.5;
    for (x, z) in MANHOLES {
        paint(frame, (x - r, x + r), (z - r, z + r), &s.grate);
    }
}

/// The lit shops' awnings: canvas sloping out from over each window (facade, span, its canvas),
/// with a valance hanging from its front edge.
const AWNING_DEPTH: f32 = 1.3;
const AWNING_DROP: f32 = 0.45;
const AWNING_HIGH: f32 = 3.45;
const VALANCE: f32 = 0.25;

/// The awnings over the lit shop windows.
fn awnings(frame: &mut Frame, s: &Surfaces) {
    frame.tag("awnings");
    let f = FACADE;
    let fronts = [(Face::x(f, -1.0, (-26.0, -20.0), (0.6, 3.0)), 0), (Face::x(-f, 1.0, (-18.0, -12.0), (0.6, 3.0)), 1), (Face::x(-f, 1.0, (10.0, 16.0), (0.6, 3.0)), 0)];
    let slope = math::atan2(AWNING_DROP, AWNING_DEPTH);
    let run = math::sqrt(AWNING_DEPTH * AWNING_DEPTH + AWNING_DROP * AWNING_DROP);
    for (face, cloth) in fronts {
        let middle = (face.span.0 + face.span.1) * 0.5;
        let width = face.span.1 - face.span.0 + 0.4;
        // Tilted about the facade's line: its back edge at the wall, its front edge lower.
        let tilt = face.turn() * Quat::from_rotation_x(face.out * slope);
        let centre = face.point(middle, AWNING_HIGH - AWNING_DROP * 0.5, SKIN_OUT + AWNING_DEPTH * 0.5);
        frame.cube_with(Transform { translation: centre, rotation: tilt, scale: vec3(width, 0.03, run) }, &s.canvas[cloth]);
        let valance = face.point(middle, AWNING_HIGH - AWNING_DROP - VALANCE * 0.5, SKIN_OUT + AWNING_DEPTH);
        frame.cube_with(Transform { translation: valance, rotation: face.turn(), scale: vec3(width, VALANCE, 0.02) }, &s.canvas[cloth]);
    }
}

/// The alley's clutter: drainpipes up its west wall (z), air-conditioning units on its east wall
/// (z, height), a stack of crates and a bin, and the gutter down its middle.
const DRAINPIPES: [f32; 3] = [10.0, 21.5, 29.0];
const AC_UNITS: [(f32, f32); 2] = [(13.0, 2.8), (26.0, 3.6)];
const PIPE_TOP: f32 = 11.5;
const GUTTER: f32 = 0.2;
/// The gutter's grates' length, so the iron scan keeps about its size.
const GUTTER_TILE: f32 = 0.6;

/// The alley's clutter.
fn alley(frame: &mut Frame, s: &Surfaces) {
    frame.tag("alley");
    let mid = (ALLEY_WEST + ALLEY_EAST) * 0.5;
    stones(frame, vec3(mid - GUTTER * 0.5, KERB, FACADE + 0.5), vec3(mid + GUTTER * 0.5, KERB + PAINT, ALLEY_END - 0.3), GUTTER_TILE, &s.grate);
    for z in DRAINPIPES {
        let x = ALLEY_WEST + SKIN_OUT + SKIN + 0.07;
        block(frame, vec3(x - 0.05, KERB, z - 0.05), vec3(x + 0.05, PIPE_TOP, z + 0.05), &s.metal);
        for y in [2.0_f32, 5.0, 8.0, 11.0] {
            block(frame, vec3(ALLEY_WEST, y, z - 0.07), vec3(x + 0.06, y + 0.05, z + 0.07), &s.metal);
        }
    }
    for (z, y) in AC_UNITS {
        let wall = ALLEY_EAST - SKIN_OUT - SKIN;
        block(frame, vec3(wall - 0.45, y, z - 0.35), vec3(wall, y + 0.45, z + 0.35), &s.metal);
        block(frame, vec3(wall - 0.47, y + 0.05, z - 0.3), vec3(wall - 0.45, y + 0.4, z + 0.3), &s.grate);
    }
    // Crates by the west wall, two on the ground and one on top, and a bin by the east wall.
    let crate_at = [vec3(13.85, KERB, 26.6), vec3(13.85, KERB, 27.2), vec3(13.9, KERB + 0.5, 26.9)];
    for at in crate_at {
        block(frame, at + vec3(-0.25, 0.0, -0.25), at + vec3(0.25, 0.48, 0.25), &s.wood);
    }
    let bin = vec3(16.05, KERB, 17.2);
    block(frame, bin + vec3(-0.25, 0.0, -0.4), bin + vec3(0.25, 0.85, 0.4), &s.metal);
    block(frame, bin + vec3(-0.28, 0.85, -0.43), bin + vec3(0.28, 0.9, 0.43), &s.metal);
}

/// The `scene` probe: what the blockout places (the same for every seed), and the door
/// transition's path ([`DOOR_WALK`]) the motion rows walk the camera along.
pub fn scene_probe() -> Value {
    let [from, to] = DOOR_WALK.map(|p| json!([p.x, p.y, p.z]));
    json!({
        "festoonBulbs": FESTOON_X.len() * BULBS_PER_STRING,
        "streetLamps": LAMPS.len(),
        "pendants": PENDANTS.len(),
        "doorWalk": { "from": from, "to": to },
    })
}

/// The `where` probe: whether the camera at `eye` is out in the street, in the café's doorway or
/// in the café (the door transition's exposure rows read where the camera crossed).
pub fn where_probe(eye: Vec3) -> Value {
    json!({ "outdoors": outdoors(eye), "inDoorway": CAFE_DOOR.contains(eye), "inCafe": CAFE_INSIDE.contains(eye) })
}

// --- Decals (renderer pass 2 A.10) ---

/// The scene's own decal textures (`harbour/assets/decals/`, authored for it): three posters, grime
/// streaks, a puddle's outline and an oil stain, each shaped by its alpha.
const POSTERS: [&str; 3] = ["decals/poster-sun.png", "decals/poster-bands.png", "decals/poster-dots.png"];
const GRIME: &str = "decals/grime-streaks.png";
const PUDDLE_MASK: &str = "decals/puddle.png";
const OIL_STAIN: &str = "decals/oil-stain.png";
/// How far a wall decal's box is centred in front of its wall's plane: the brick skin's face.
const WALL_DECAL_LIFT: f32 = SKIN_OUT + 0.5 * SKIN;
/// A poster's size (width, height) and how its paper sheens.
const POSTER_SIZE: (f32, f32) = (0.72, 0.9);
const POSTER_ROUGHNESS: f32 = 0.75;
/// How dark the grime is (its texture's alpha times this).
const GRIME_OPACITY: f32 = 0.7;

/// Where the posters are pasted, avoiding the shutters, shop windows and the café: (the face, how
/// far along it, how high its centre, which poster, its tilt in radians).
fn poster_spots() -> [(Face, f32, f32, usize, f32); 13] {
    let f = FACADE;
    let north = Face::x(f, -1.0, (-EXTENT, EXTENT), (0.0, NORTH_HEIGHT));
    let south_west = Face::x(-f, 1.0, (-EXTENT, -f), (0.0, SOUTH_WEST_HEIGHT));
    let south_east = Face::x(-f, 1.0, (f, EXTENT), (0.0, SOUTH_EAST_HEIGHT));
    let side_west = Face::z(-f, 1.0, (-EXTENT, -f), (0.0, SOUTH_WEST_HEIGHT));
    let side_east = Face::z(f, -1.0, (-EXTENT, -f), (0.0, SOUTH_EAST_HEIGHT));
    [
        (north, -9.2, 1.75, 0, 0.03),
        (north, -8.45, 1.62, 1, -0.02),
        (north, -7.7, 1.8, 2, 0.015),
        (north, -18.4, 1.7, 1, -0.03),
        (north, -17.6, 1.78, 0, 0.02),
        (south_west, -20.8, 1.7, 2, 0.02),
        (south_west, -20.0, 1.84, 0, -0.025),
        (south_west, -19.2, 1.66, 1, 0.01),
        (south_west, -10.6, 1.72, 2, -0.015),
        (south_east, 17.4, 1.7, 0, 0.02),
        (south_east, 18.2, 1.76, 2, -0.02),
        (side_west, -10.8, 1.7, 1, 0.025),
        (side_east, -12.0, 1.74, 0, -0.02),
    ]
}

/// One grime streak: the face, how far along it, its bottom and top, its width, and whether it is
/// upside down (rising from the ground instead of falling from a ledge).
type GrimeSpot = (Face, f32, (f32, f32), f32, bool);

/// Grime on the walls: streaks of rain off the café's sills and the shop displays' ledges, and
/// damp rising up the walls' feet.
fn grime_spots() -> [GrimeSpot; 14] {
    let f = FACADE;
    let north = Face::x(f, -1.0, (-EXTENT, EXTENT), (0.0, NORTH_HEIGHT));
    let south_west = Face::x(-f, 1.0, (-EXTENT, -f), (0.0, SOUTH_WEST_HEIGHT));
    let south_east = Face::x(-f, 1.0, (f, EXTENT), (0.0, SOUTH_EAST_HEIGHT));
    let alley_west = Face::z(ALLEY_WEST, 1.0, (f, ALLEY_END), (0.0, NORTH_HEIGHT));
    let alley_east = Face::z(ALLEY_EAST, -1.0, (f, ALLEY_END), (0.0, NORTH_HEIGHT));
    let [(a0, a1), (b0, b1)] = WINDOWS;
    [
        (north, 0.5 * (a0 + a1), (KERB, SILL), a1 - a0, false),
        (north, 0.5 * (b0 + b1), (KERB, SILL), b1 - b0, false),
        (north, -23.0, (KERB, 0.6), 6.0, false),
        (north, -28.5, (KERB, 1.1), 3.5, true),
        (north, -13.0, (3.2, 4.6), 6.0, false),
        (north, 20.0, (KERB, 1.0), 4.0, true),
        (south_west, -15.0, (KERB, 0.6), 6.0, false),
        (south_west, -30.0, (KERB, 1.2), 3.0, true),
        (south_east, 13.0, (KERB, 0.6), 6.0, false),
        (south_east, 29.0, (KERB, 1.0), 4.0, true),
        (alley_west, 12.0, (KERB, 1.3), 5.0, true),
        (alley_west, 24.0, (3.0, 6.0), 2.5, false),
        (alley_east, 18.0, (KERB, 1.1), 6.0, true),
        (alley_east, 27.0, (4.0, 7.5), 2.0, false),
    ]
}

/// Puddles on the asphalt after the rain (x, z, width, depth, turn): projected decals, so their
/// film lies on the road wherever it is, with no box to fight the asphalt for its depth.
const PUDDLES: [(f32, f32, f32, f32, f32); 7] =
    [(0.2, -0.6, 2.6, 1.6, 0.3), (1.6, 0.6, 1.6, 1.2, -0.5), (-0.9, -1.6, 1.4, 1.0, 0.9), (-12.0, 2.4, 3.0, 1.4, 0.1), (9.5, -2.6, 2.4, 1.5, -0.2), (-2.0, -14.0, 2.0, 1.3, 0.4), (22.0, 1.5, 2.8, 1.3, 0.25)];
/// Oil stains under the parked cars and at the crossing's stop lines (x, z, size, turn).
const OIL_STAINS: [(f32, f32, f32, f32); 4] = [(-14.3, -3.0, 1.6, 0.4), (19.6, 3.1, 1.4, -0.7), (-2.6, 2.4, 1.0, 1.1), (2.2, -2.8, 1.2, 2.0)];

/// The street's decals (renderer pass 2 A.10): posters pasted on the walls, grime on the walls,
/// puddles and oil on the asphalt. They are not draws: each lays its texture onto whatever surface
/// its box holds, before lighting (`frame.decal`).
fn decals(frame: &mut Frame) {
    for (face, along, y, poster, tilt) in poster_spots() {
        let at = face.point(along, y, WALL_DECAL_LIFT);
        let decal = Decal::on_wall(at, face.normal(), POSTER_SIZE.0, POSTER_SIZE.1).rotated(tilt).with_base_texture(POSTERS[poster]).with_roughness(POSTER_ROUGHNESS);
        frame.decal(&decal);
    }
    for (face, along, (bottom, top), width, rising) in grime_spots() {
        let at = face.point(along, 0.5 * (bottom + top), WALL_DECAL_LIFT);
        let turn = if rising { math::PI } else { 0.0 };
        let decal = Decal::on_wall(at, face.normal(), width, top - bottom).rotated(turn).with_base_texture(GRIME).with_opacity(GRIME_OPACITY);
        frame.decal(&decal);
    }
    for (x, z, w, d, turn) in PUDDLES {
        let puddle = Decal::on_ground(vec3(x, 0.0, z), w, d)
            .rotated(turn)
            .with_base_texture(PUDDLE_MASK)
            .with_color(PUDDLE)
            .with_albedo_mix(0.85)
            .with_roughness(0.04)
            .with_metallic(0.0)
            .with_flatten(1.0);
        frame.decal(&puddle);
    }
    for (x, z, size, turn) in OIL_STAINS {
        let stain = Decal::on_ground(vec3(x, 0.0, z), size, size).rotated(turn).with_base_texture(OIL_STAIN).with_opacity(0.8).with_roughness(0.3).with_metallic(0.0);
        frame.decal(&stain);
    }
}

/// The drizzle: streaks falling from this high over each half of the main street (and its
/// pavements), with these many spawned a tick and the ticks each lives (60 a second: long enough to
/// reach the street), soft over a few centimetres where they near what is behind them.
const RAIN_TOP: f32 = 10.0;
const RAIN_PER_TICK: u32 = 130;
/// The alley's share of the drizzle (spawned a tick over its narrower sky).
const ALLEY_RAIN_PER_TICK: u32 = 30;
const RAIN_LIFE_TICKS: u32 = 76;
/// A streak's width (metres).
const RAIN_WIDTH: f32 = 0.008;
/// A streak's colour: the damp air's blue grey, faint, so the neon and the lamps carry the scene.
const RAIN_COLOR: Color = Color::rgba(84, 92, 108, 46);
/// The steam from the manholes: puffs spawned a tick and the ticks each lives, its size at birth,
/// its growth over a life, and its colour from birth to death (the dusk's grey, faint, fading out
/// as it thins).
const STEAM_PER_TICK: u32 = 1;
const STEAM_LIFE_TICKS: u32 = 220;
const STEAM_SIZE: f32 = 0.45;
const STEAM_GROWTH: f32 = 3.2;
const STEAM_START: Color = Color::rgba(62, 64, 70, 30);
const STEAM_END: Color = Color::rgba(56, 58, 64, 0);

/// Harbour Street's particles (renderer pass 2 A.11): steam rising from the manholes (soft where
/// it meets the road and the walls, drawn back to front), and a drizzle over the main street whose
/// streaks stop where they meet what the camera sees (the awnings, the cars, the road).
#[derive(Clone, Debug)]
pub struct Weather {
    /// One plume a manhole.
    pub steam: Vec<Particles>,
    /// The drizzle over the west and the east half of the street, and over the alley.
    pub rain: Vec<Particles>,
}

impl Default for Weather {
    fn default() -> Weather {
        let steam = MANHOLES
            .iter()
            .zip(1u32..)
            .map(|(&(x, z), seed)| {
                let plume = Particles::steam(vec3(x, 0.02, z)).with_look(STEAM_SIZE, STEAM_GROWTH, STEAM_START, STEAM_END).with_seed(seed);
                plume.with_rate(STEAM_PER_TICK, STEAM_LIFE_TICKS).unwrap_or(plume)
            })
            .collect();
        let half = EXTENT * 0.5;
        let alley_half = (ALLEY_END - FACADE) * 0.5;
        let skies = [
            (vec3(-half, RAIN_TOP, 0.0), vec3(half, 0.0, FACADE), RAIN_PER_TICK),
            (vec3(half, RAIN_TOP, 0.0), vec3(half, 0.0, FACADE), RAIN_PER_TICK),
            (vec3((ALLEY_WEST + ALLEY_EAST) * 0.5, RAIN_TOP, FACADE + alley_half), vec3((ALLEY_EAST - ALLEY_WEST) * 0.5, 0.0, alley_half), ALLEY_RAIN_PER_TICK),
        ];
        let rain = skies
            .into_iter()
            .zip(11u32..)
            .map(|((top, extent, per_tick), seed)| {
                let over = Particles::rain(top, extent).with_look(RAIN_WIDTH, 1.0, RAIN_COLOR, RAIN_COLOR).with_seed(seed);
                over.with_rate(per_tick, RAIN_LIFE_TICKS).unwrap_or(over)
            })
            .collect();
        Weather { steam, rain }
    }
}

/// Draw the steam and the drizzle.
fn weather(frame: &mut Frame, weather: &Weather) {
    for particles in weather.steam.iter().chain(&weather.rain) {
        frame.particles(particles);
    }
}
