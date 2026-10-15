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

use genex::math::{self, FRAC_PI_2, Quat, Vec3, vec3};
use genex::prelude::*;
use genex::render::{IrradianceVolume, ReflectionProbe, SpotLight};

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

/// A textured PBR surface from the fetched maps `fetched/<name>-{albedo,normal,orm}.jpg`, drawing
/// `untextured` in their place where they are missing; `roughness` scales the scan's own.
fn scanned(name: &str, untextured: Color, roughness: f32) -> Material {
    Material::color(Color::WHITE)
        .with_untextured_color(untextured)
        .with_roughness(roughness)
        .with_base_texture(&format!("fetched/{name}-albedo.jpg"))
        .with_normal_texture(&format!("fetched/{name}-normal.jpg"), 1.0)
        .with_metal_rough_texture(&format!("fetched/{name}-orm.jpg"))
}

/// Every surface the draw hook uses, made once per seed.
#[derive(Clone, Debug)]
pub struct Surfaces {
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
    puddle: Material,
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
            granite: Material::color(GRANITE).with_roughness(0.7),
            mass: Material::color(MASS).with_roughness(0.9),
            metal: Material::color(METAL).with_metallic(0.8).with_roughness(0.4),
            chrome: Material::color(CHROME).with_metallic(1.0).with_roughness(0.2),
            wood: Material::color(WOOD).with_roughness(0.55),
            marble: Material::color(MARBLE).with_roughness(0.2),
            rug: Material::color(RUG).with_roughness(0.95),
            leaves: Material::color(LEAVES).with_roughness(0.8),
            terracotta: Material::color(TERRACOTTA).with_roughness(0.85),
            puddle: Material::color(PUDDLE).with_roughness(0.04),
            glass: Material::color(GLASS).with_roughness(0.04),
            cars: CAR_PAINT.map(|paint| Material::color(paint).with_metallic(0.6).with_roughness(0.3)),
            tyre: Material::color(TYRE).with_roughness(0.9),
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
    block(frame, vec3(-e, -SLAB, h), vec3(e, KERB, h + k), &s.granite);
    floor(frame, (-e, e), (h + k, f), KERB, PAVING_TILE, &s.paving);
    let span = |a: f32, b: f32| (a.min(b), a.max(b));
    for side in [-1.0_f32, 1.0] {
        let (along, kerb_line) = (span(side * e, side * h), span(side * h, side * (h + k)));
        block(frame, vec3(along.0, -SLAB, -h - k), vec3(along.1, KERB, -h), &s.granite);
        block(frame, vec3(kerb_line.0, -SLAB, -e), vec3(kerb_line.1, KERB, -h - k), &s.granite);
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
    // Tables, each with two chairs, under the pendant lamps.
    for (tx, tz) in PENDANTS {
        block(frame, vec3(tx - 0.4, 0.86, tz - 0.4), vec3(tx + 0.4, 0.9, tz + 0.4), &s.wood);
        block(frame, vec3(tx - 0.03, KERB, tz - 0.03), vec3(tx + 0.03, 0.86, tz + 0.03), &s.metal);
        for side in [-1.0_f32, 1.0] {
            let cz = tz + side * 0.65;
            block(frame, vec3(tx - 0.22, 0.58, cz - 0.22), vec3(tx + 0.22, 0.62, cz + 0.22), &s.wood);
            block(frame, vec3(tx - 0.22, 0.62, cz + side * 0.2 - 0.02), vec3(tx + 0.22, 1.05, cz + side * 0.2 + 0.02), &s.wood);
            block(frame, vec3(tx - 0.02, KERB, cz - 0.02), vec3(tx + 0.02, 0.58, cz + 0.02), &s.metal);
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

/// What stands in the street: puddles on the asphalt, two parked cars, bollards and a bench.
fn street_things(frame: &mut Frame, s: &Surfaces) {
    frame.tag("street");
    // Puddles: dark mirror-smooth patches a few millimetres proud of the asphalt, each a blob of
    // three overlapping turned boxes about its centre (x, z, width, depth, turn).
    let puddles = [
        (0.2, -0.6, 2.4, 1.3, 0.3),
        (1.6, 0.6, 1.4, 0.9, -0.5),
        (-0.9, -1.6, 1.2, 0.8, 0.9),
        (-12.0, 2.4, 2.8, 1.1, 0.1),
        (9.5, -2.6, 2.2, 1.2, -0.2),
        (-2.0, -14.0, 1.8, 1.0, 0.4),
        (22.0, 1.5, 2.6, 1.0, 0.25),
    ];
    for (x, z, w, d, turn) in puddles {
        for (scale_w, scale_d, twist) in [(1.0, 1.0, 0.0), (0.8, 1.3, 0.5), (0.62, 1.5, -0.45)] {
            let transform = Transform { translation: vec3(x, 0.0, z), rotation: Quat::from_rotation_y(turn + twist), scale: vec3(w * scale_w, 0.01, d * scale_d) };
            frame.cube_with(transform, &s.puddle);
        }
    }
    for ((x, z, heading), paint) in [(-14.0, -3.2, 0.0), (20.0, 3.2, math::PI)].into_iter().zip(&s.cars) {
        car(frame, s, vec3(x, 0.0, z), heading, paint);
    }
    for x in [-5.5, -4.5, 4.5, 5.5] {
        block(frame, vec3(x - 0.08, KERB, 4.85), vec3(x + 0.08, 1.0, 5.01), &s.metal);
    }
    block(frame, vec3(-12.0, 0.45, 6.6), vec3(-10.4, 0.5, 7.05), &s.wood);
    for x in [-11.9, -10.5] {
        block(frame, vec3(x - 0.04, KERB, 6.7), vec3(x + 0.04, 0.45, 6.95), &s.metal);
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
    }
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
