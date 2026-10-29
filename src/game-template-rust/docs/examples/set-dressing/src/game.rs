//! A dressed room and street: every shape is a built mesh with soft edges (`MeshData` builders,
//! `docs/api/meshes.md`) and every piece of clutter, debris and wear is placed by a `Dressing`
//! (`docs/api/scatter.md`) from one seed. Nothing is placed by hand but the furniture, the walls
//! and the street's line.
//!
//! The order is the one a level is dressed in: the shell (walls with rounded reveals, a skirting
//! swept round the room, kerbs swept along the street), the hero furniture, then the layers from
//! the largest to the smallest (rubble along the walls, plaster round the rubble, papers in drifts;
//! lamps and bollards along the kerb, bins by the facade, litter in the gutter), then the wear as
//! decals (grime along wall bases, leaks, posters, puddles in patches on the road). Each layer
//! names the rules a person would say aloud: "near the walls", "not in the doorway", "in patches",
//! "round the rubble". Copy a layer and change its rules; keep the order.
//!
//! The decals are the interior kit's (`docs/examples/interior-kit/assets/kit/decals/`: copy that
//! folder to `assets/kit/decals/`); the surfaces are plain PBR colours here, so swap in CC0 scans
//! with `Material::with_world_uv` as `docs/examples/interior-room` does.

use genex::prelude::*;
use genex::render::{Environment, Fog, Grading, IrradianceVolume, ReflectionProbe, RenderConfig};
use genex::{Dressed, Dressing, Far, InstanceGroup, Layer, Profile, Spline, Surface, Zone};

/// The room: its inner faces, ceiling height and wall thickness (metres).
const ROOM_MIN: Vec3 = vec3(-4.0, 0.0, -3.0);
const ROOM_MAX: Vec3 = vec3(4.0, CEILING, 3.0);
const CEILING: f32 = 3.0;
const WALL: f32 = 0.25;
/// The two windows in the street wall (x from, x to), their sill and head.
const WINDOWS: [(f32, f32); 2] = [(-2.9, -1.1), (1.1, 2.9)];
const SILL: f32 = 0.9;
const HEAD: f32 = 2.5;
/// The door in the west wall (z from, z to) and its head.
const DOOR: (f32, f32) = (-0.5, 0.5);
const DOOR_HEAD: f32 = 2.1;
/// How round a plastered reveal is: a real corner bead, never a knife edge.
const PLASTER_RADIUS: f32 = 0.015;
/// The street: its centre line's points, half the road's width, the kerb's height.
const STREET: [Vec3; 4] = [vec3(-40.0, 0.0, 10.5), vec3(-12.0, 0.0, 9.6), vec3(14.0, 0.0, 10.2), vec3(40.0, 0.0, 9.4)];
const ROAD_HALF: f32 = 3.6;
const KERB: f32 = 0.12;
/// The far side's facade (z), its height.
const FACADE_Z: f32 = 17.0;
const FACADE_HEIGHT: f32 = 9.0;
/// The seed every layer is placed from: change it for another dressing.
const DRESSING_SEED: u32 = 0x5e7d;
/// Towards the sun: high in the street's sky, so it falls in through the windows too.
const SUN_TOWARDS: Vec3 = vec3(0.45, 0.62, 1.0);
const SUN_INTENSITY: f32 = 3.0;
/// Where the cameras stand and look.
const ROOM_EYE: Vec3 = vec3(-3.4, 1.6, -2.5);
const ROOM_LOOK: Vec3 = vec3(1.6, 0.7, 2.2);
const STREET_EYE: Vec3 = vec3(-9.0, 1.7, 5.2);
const STREET_LOOK: Vec3 = vec3(6.0, 0.9, 10.5);

/// A built mesh and the material it is drawn in.
struct Piece {
    model: Model,
    material: Material,
    at: Transform,
}

/// Everything the reset builds once: the shell, the furniture, the dressing's groups and decals.
pub struct Set {
    pieces: Vec<(&'static str, Piece)>,
    groups: Vec<(&'static str, InstanceGroup)>,
    decals: Vec<genex::Decal>,
    dressed: Dressed,
}

/// Everything the simulation owns. Every seed rebuilds it from `World::default()`.
#[derive(Default)]
pub struct World {
    /// The dressed set, built in `on_reset`.
    pub set: Option<Set>,
}

/// The surfaces, as plain PBR colours.
struct Paints {
    plaster: Material,
    dado: Material,
    floor: Material,
    wood: Material,
    steel: Material,
    iron: Material,
    concrete: Material,
    rubble: Material,
    paper: Material,
    asphalt: Material,
    stone: Material,
    brick: Material,
}

impl Paints {
    fn new() -> Paints {
        let matte = |c: Color, roughness: f32| Material::color(c).with_roughness(roughness).with_macro_variation(0.12, 2.0);
        Paints {
            plaster: matte(Color::rgb(214, 208, 196), 0.95),
            dado: matte(Color::rgb(78, 112, 128), 0.55),
            floor: matte(Color::rgb(120, 96, 80), 0.6),
            wood: matte(Color::rgb(122, 86, 56), 0.7),
            steel: Material::color(Color::rgb(72, 76, 80)).with_metallic(1.0).with_roughness(0.45),
            iron: Material::color(Color::rgb(58, 52, 48)).with_metallic(0.6).with_roughness(0.7),
            concrete: matte(Color::rgb(150, 147, 140), 0.92),
            rubble: matte(Color::rgb(160, 154, 146), 0.95),
            paper: matte(Color::rgb(226, 222, 210), 0.85),
            asphalt: matte(Color::rgb(58, 58, 60), 0.88),
            stone: matte(Color::rgb(168, 164, 156), 0.8),
            brick: matte(Color::rgb(132, 74, 58), 0.9),
        }
    }
}

/// The look in code on top of `genex.toml`'s `[render]`: thin air and a neutral grade.
pub fn look(base: RenderConfig) -> RenderConfig {
    base.fog(Fog::default().with_density(0.008).with_height(0.05, 0.0)).grading(Grading::NEUTRAL.with_contrast(1.05).with_saturation(0.92))
}

/// Register the set's hooks.
pub fn wire(game: &mut Game<World>) {
    game.render_settings(look(RenderConfig::from_build()));
    game.on_reset(|sim, _seed, _rng, gfx| sim.world.set = Some(build(gfx)));
    game.on_draw(|sim, frame, _camera| {
        if let Some(set) = &sim.world.set {
            draw(set, frame);
        }
    });
    game.camera(|_sim| Camera { fovy: 64.0, ..Camera::look_at(ROOM_EYE, ROOM_LOOK) });
    game.named_camera("street", |_sim| Camera { fovy: 58.0, ..Camera::look_at(STREET_EYE, STREET_LOOK) });
    game.probe("dressing", |sim| {
        let set = sim.world.set.as_ref();
        let layers: std::collections::BTreeMap<String, usize> = set.map(|set| set.dressed.counts().into_iter().map(|(name, count)| (name.to_owned(), count)).collect()).unwrap_or_default();
        json!({ "layers": layers, "decals": set.map_or(0, |set| set.decals.len()) })
    });
}

fn build(gfx: &Gfx) -> Set {
    let paints = Paints::new();
    let mut pieces = Vec::new();
    let mut piece = |tag: &'static str, mesh: &MeshData, material: &Material, at: Transform| {
        let model = gfx.mesh(mesh).expect("a built mesh");
        pieces.push((tag, Piece { model, material: material.clone(), at }));
    };
    let (shell, skirting) = room_shell();
    piece("shell", &shell, &paints.plaster, Transform::IDENTITY);
    piece("shell", &dado(), &paints.dado, Transform::IDENTITY);
    piece("shell", &skirting, &paints.wood, Transform::IDENTITY);
    piece("shell", &floor_and_ceiling(), &paints.floor, Transform::IDENTITY);
    for (x0, x1) in WINDOWS {
        piece("shell", &window_frame(x0, x1), &paints.steel, Transform::IDENTITY);
        piece("furniture", &radiator((x0 + x1) / 2.0), &paints.iron, Transform::IDENTITY);
    }
    let (desk, chair, bin) = (desk(), chair(), bin());
    for (row, z) in [-0.4_f32, 1.4].into_iter().enumerate() {
        for (col, x) in [-2.3_f32, 0.0, 2.3].into_iter().enumerate() {
            let shove = if (row + col) % 3 == 1 { 0.3 } else { 0.0 };
            piece("furniture", &desk, &paints.wood, Transform::from_xyz(x, 0.0, z));
            let turn = Quat::from_rotation_y(shove * 0.6);
            piece("furniture", &chair, &paints.wood, Transform::from_xyz(x + shove * 0.4, 0.0, z - 0.6 - shove).with_rotation(turn));
        }
    }
    piece("furniture", &bin, &paints.steel, Transform::from_xyz(-3.6, 0.0, 2.5));
    let street = Spline::new(&STREET);
    let (road, pavements, kerbs) = street_shell(&street);
    piece("street", &road, &paints.asphalt, Transform::IDENTITY);
    piece("street", &pavements, &paints.stone, Transform::IDENTITY);
    piece("street", &kerbs, &paints.concrete, Transform::IDENTITY);
    piece("street", &facades(), &paints.brick, Transform::IDENTITY);
    let dressed = dressing(&street).run();
    let groups = groups(gfx, &dressed, &paints);
    let decals = decals(&dressed);
    Set { pieces, groups, decals, dressed }
}

/// The room's walls as rounded boxes (every reveal and corner softened), with the window and door
/// openings, and a skirting swept round the floor.
fn room_shell() -> (MeshData, MeshData) {
    let mut walls = MeshData::new();
    let mut slab = |min: Vec3, max: Vec3| {
        walls.rounded_cuboid(min, max, PLASTER_RADIUS, 4, 1.0);
    };
    let (lo, hi) = (ROOM_MIN, ROOM_MAX);
    // The street wall (+z): piers between the windows, under the sills and over the heads.
    let mut from = lo.x - WALL;
    for (x0, x1) in WINDOWS {
        slab(vec3(from, 0.0, hi.z), vec3(x0, CEILING, hi.z + WALL));
        slab(vec3(x0, 0.0, hi.z), vec3(x1, SILL, hi.z + WALL));
        slab(vec3(x0, HEAD, hi.z), vec3(x1, CEILING, hi.z + WALL));
        from = x1;
    }
    slab(vec3(from, 0.0, hi.z), vec3(hi.x + WALL, CEILING, hi.z + WALL));
    slab(vec3(lo.x - WALL, 0.0, lo.z - WALL), vec3(hi.x + WALL, CEILING, lo.z));
    slab(vec3(hi.x, 0.0, lo.z), vec3(hi.x + WALL, CEILING, hi.z));
    // The west wall with its door.
    slab(vec3(lo.x - WALL, 0.0, lo.z), vec3(lo.x, CEILING, DOOR.0));
    slab(vec3(lo.x - WALL, DOOR_HEAD, DOOR.0), vec3(lo.x, CEILING, DOOR.1));
    slab(vec3(lo.x - WALL, 0.0, DOOR.1), vec3(lo.x, CEILING, hi.z));
    // A skirting: a rounded-top board swept along the walls, stopping at the door.
    let board = Profile::polygon(vec![vec2(0.0, 0.0), vec2(0.018, 0.0), vec2(0.018, 0.09), vec2(0.008, 0.12), vec2(0.0, 0.12)]).bevel(0.006, 3);
    let run = [vec3(lo.x, 0.0, DOOR.0), vec3(lo.x, 0.0, lo.z), vec3(hi.x, 0.0, lo.z), vec3(hi.x, 0.0, hi.z), vec3(lo.x, 0.0, hi.z), vec3(lo.x, 0.0, DOOR.1)];
    let mut skirting = MeshData::new();
    skirting.sweep(&board, &run, 1.0);
    (walls, skirting)
}

/// The painted dado: a 3 mm coat proud of the walls up to 1.3 m, its top edge rounded.
fn dado() -> MeshData {
    let (lo, hi) = (ROOM_MIN, ROOM_MAX);
    let mut coat = MeshData::new();
    let mut panel = |min: Vec3, max: Vec3| {
        coat.rounded_cuboid(min, max, 0.002, 2, 1.0);
    };
    panel(vec3(lo.x, 0.0, lo.z), vec3(hi.x, 1.3, lo.z + 0.004));
    panel(vec3(hi.x - 0.004, 0.0, lo.z), vec3(hi.x, 1.3, hi.z));
    panel(vec3(lo.x, 0.0, lo.z), vec3(lo.x + 0.004, 1.3, DOOR.0 - 0.1));
    panel(vec3(lo.x, 0.0, DOOR.1 + 0.1), vec3(lo.x + 0.004, 1.3, hi.z));
    let mut from = lo.x;
    for (x0, x1) in WINDOWS {
        panel(vec3(from, 0.0, hi.z - 0.004), vec3(x0, 1.3, hi.z));
        panel(vec3(x0, 0.0, hi.z - 0.004), vec3(x1, SILL, hi.z));
        from = x1;
    }
    panel(vec3(from, 0.0, hi.z - 0.004), vec3(hi.x, 1.3, hi.z));
    coat
}

/// The floor slab and the ceiling slab over the room.
fn floor_and_ceiling() -> MeshData {
    let mut slabs = MeshData::new();
    slabs
        .cuboid(vec3(ROOM_MIN.x - WALL, -0.2, ROOM_MIN.z - WALL), vec3(ROOM_MAX.x + WALL, 0.0, ROOM_MAX.z + WALL), 1.0)
        .cuboid(vec3(ROOM_MIN.x - WALL, CEILING, ROOM_MIN.z - WALL), vec3(ROOM_MAX.x + WALL, CEILING + 0.25, ROOM_MAX.z + WALL), 1.0);
    slabs
}

/// A steel window: an L-section frame swept round the opening, a mullion and a transom, its glass
/// long gone.
fn window_frame(x0: f32, x1: f32) -> MeshData {
    let z = ROOM_MAX.z + WALL / 2.0;
    let section = Profile::rounded_rect(0.05, 0.06, 0.006, 2);
    let mut frame = MeshData::new();
    frame.sweep(&section, &[vec3(x0, SILL, z), vec3(x1, SILL, z), vec3(x1, HEAD, z), vec3(x0, HEAD, z), vec3(x0, SILL, z)], 1.0);
    frame.sweep(&section, &[vec3((x0 + x1) / 2.0, SILL, z), vec3((x0 + x1) / 2.0, HEAD, z)], 1.0);
    frame.sweep(&section, &[vec3(x0, 1.95, z), vec3(x1, 1.95, z)], 1.0);
    // The sill: a rounded concrete slab standing proud of the wall.
    frame.rounded_cuboid(vec3(x0 - 0.06, SILL - 0.05, ROOM_MAX.z - 0.06), vec3(x1 + 0.06, SILL, ROOM_MAX.z + WALL + 0.04), 0.012, 4, 1.0);
    frame
}

/// A cast-iron column radiator centred at `x` under a window: rounded columns between two
/// rounded headers, on two feet, with its pipe.
fn radiator(x: f32) -> MeshData {
    let z = ROOM_MAX.z - 0.12;
    let mut column = MeshData::new();
    column.rounded_cuboid(vec3(-0.022, 0.16, -0.05), vec3(0.022, 0.72, 0.05), 0.018, 6, 1.0);
    let mut radiator = MeshData::new();
    for i in 0..14 {
        radiator.append(&column, Transform::from_xyz(x - 0.42 + i as f32 * 0.0646, 0.0, z));
    }
    for y in [0.14, 0.7] {
        radiator.rounded_cuboid(vec3(x - 0.46, y, z - 0.035), vec3(x + 0.46, y + 0.05, z + 0.035), 0.02, 4, 1.0);
    }
    for dx in [-0.38, 0.38] {
        radiator.rounded_cuboid(vec3(x + dx - 0.03, 0.0, z - 0.06), vec3(x + dx + 0.03, 0.16, z + 0.06), 0.01, 4, 1.0);
    }
    radiator.tube(&[vec3(x - 0.5, 0.0, z), vec3(x - 0.5, 0.16, z), vec3(x - 0.46, 0.165, z)], 0.016, 10, 1.0);
    radiator
}

/// A school desk: a rounded top, round steel legs and rails, one mesh.
fn desk() -> MeshData {
    let mut desk = MeshData::new();
    desk.rounded_cuboid(vec3(-0.6, 0.71, -0.3), vec3(0.6, 0.74, 0.3), 0.012, 6, 1.0);
    for (x, z) in [(-0.55, -0.25), (0.55, -0.25), (0.55, 0.25), (-0.55, 0.25)] {
        desk.tube(&[vec3(x, 0.0, z), vec3(x, 0.71, z)], 0.014, 10, 1.0);
    }
    for x in [-0.55, 0.55] {
        desk.tube(&[vec3(x, 0.12, -0.25), vec3(x, 0.12, 0.25)], 0.01, 8, 1.0);
    }
    desk
}

/// A chair: a moulded seat and back (rounded boxes, the back raked) on tube legs.
fn chair() -> MeshData {
    let mut back = MeshData::new();
    back.rounded_cuboid(vec3(-0.2, 0.0, -0.012), vec3(0.2, 0.22, 0.012), 0.01, 6, 1.0);
    let mut chair = MeshData::new();
    chair.rounded_cuboid(vec3(-0.21, 0.43, -0.2), vec3(0.21, 0.46, 0.2), 0.012, 6, 1.0);
    chair.append(&back, Transform::from_xyz(0.0, 0.62, -0.21).with_rotation(Quat::from_rotation_x(-0.14)));
    for (x, z) in [(-0.18, -0.18), (0.18, -0.18), (0.18, 0.18), (-0.18, 0.18)] {
        let top = if z < 0.0 { 0.84 } else { 0.43 };
        chair.tube(&[vec3(x, 0.0, z), vec3(x, top, z)], 0.011, 8, 1.0);
    }
    chair
}

/// A waste bin turned on a lathe: a tapered can with a rolled rim.
fn bin() -> MeshData {
    let outline = Profile::polyline(vec![vec2(0.0, 0.0), vec2(0.15, 0.0), vec2(0.18, 0.4), vec2(0.192, 0.405), vec2(0.192, 0.42), vec2(0.172, 0.42), vec2(0.162, 0.03), vec2(0.0, 0.03)]).bevel(0.004, 2);
    let mut can = MeshData::new();
    can.lathe(&outline, 32, 1.0);
    can
}

/// The road (a sheet following the street), the pavements either side raised a kerb's height,
/// and the kerbs: a rounded stone section swept along each road edge.
fn street_shell(street: &Spline) -> (MeshData, MeshData, MeshData) {
    let edge = |side: f32| -> Vec<Vec3> {
        let steps = (street.length() / 1.0) as usize;
        (0..=steps)
            .map(|k| {
                let (p, along) = street.at(k as f32 * street.length() / steps as f32);
                p + along.cross(Vec3::Y).normalize_or(Vec3::Z) * side
            })
            .collect()
    };
    let mut road = MeshData::new();
    let (near, far) = (edge(-ROAD_HALF - 0.3), edge(ROAD_HALF + 0.3));
    for k in 0..near.len() - 1 {
        road.quad([near[k], near[k + 1], far[k + 1], far[k]], 1.0);
    }
    let mut pavements = MeshData::new();
    pavements.rounded_cuboid(vec3(-40.0, -0.2, ROOM_MAX.z + WALL), vec3(40.0, KERB, 6.0), 0.01, 2, 1.0);
    pavements.rounded_cuboid(vec3(-40.0, -0.2, 13.6), vec3(40.0, KERB, FACADE_Z), 0.01, 2, 1.0);
    let section = Profile::rounded_rect(0.3, KERB + 0.1, 0.025, 3);
    let mut kerbs = MeshData::new();
    for side in [-ROAD_HALF, ROAD_HALF] {
        let line: Vec<Vec3> = edge(side).into_iter().map(|p| p + Vec3::Y * ((KERB + 0.1) / 2.0 - 0.1)).collect();
        kerbs.sweep(&section, &line, 1.0);
    }
    (road, pavements, kerbs)
}

/// The facade across the street and the outside of the room's own street wall above the yard.
fn facades() -> MeshData {
    let mut walls = MeshData::new();
    walls.rounded_cuboid(vec3(-40.0, 0.0, FACADE_Z), vec3(40.0, FACADE_HEIGHT, FACADE_Z + 0.5), 0.02, 2, 1.0);
    walls.rounded_cuboid(vec3(-40.0, 0.0, ROOM_MAX.z), vec3(ROOM_MIN.x - WALL, FACADE_HEIGHT, ROOM_MAX.z + WALL), 0.02, 2, 1.0);
    walls.rounded_cuboid(vec3(ROOM_MAX.x + WALL, 0.0, ROOM_MAX.z), vec3(40.0, FACADE_HEIGHT, ROOM_MAX.z + WALL), 0.02, 2, 1.0);
    walls
}

/// The room's floor, its four inner wall faces (facing in) and its ceiling.
fn room_surfaces() -> (Surface, Surface, Surface) {
    let (lo, hi) = (ROOM_MIN, ROOM_MAX);
    let floor = Surface::floor(vec2(lo.x, lo.z), vec2(hi.x, hi.z), 0.0);
    let walls = Surface::wall(vec3(lo.x, 0.0, lo.z), vec3(hi.x, 0.0, lo.z), CEILING, Vec3::Z)
        .and(&Surface::wall(vec3(hi.x, 0.0, lo.z), vec3(hi.x, 0.0, hi.z), CEILING, Vec3::NEG_X))
        .and(&Surface::wall(vec3(hi.x, 0.0, hi.z), vec3(lo.x, 0.0, hi.z), CEILING, Vec3::NEG_Z))
        .and(&Surface::wall(vec3(lo.x, 0.0, hi.z), vec3(lo.x, 0.0, lo.z), CEILING, Vec3::X));
    let ceiling = Surface::from_triangle_list([[vec3(lo.x, CEILING, lo.z), vec3(hi.x, CEILING, hi.z), vec3(hi.x, CEILING, lo.z)], [vec3(lo.x, CEILING, lo.z), vec3(lo.x, CEILING, hi.z), vec3(hi.x, CEILING, hi.z)]]);
    (floor, walls, ceiling)
}

/// Every layer, from the largest things to the smallest, then the wear.
fn dressing(street: &Spline) -> Dressing {
    let (floor, walls, ceiling) = room_surfaces();
    let (lo, hi) = (ROOM_MIN, ROOM_MAX);
    let doorway = Zone::cuboid(vec3(lo.x - 0.3, 0.0, DOOR.0), vec3(lo.x + 1.2, DOOR_HEAD, DOOR.1));
    let windows: Vec<Zone> = WINDOWS.iter().map(|(x0, x1)| Zone::cuboid(vec3(*x0, SILL, hi.z - 0.1), vec3(*x1, HEAD, hi.z + 0.1))).collect();
    // Rubble heaped along the walls: kept out of the room's middle, in patches, not in the door.
    let middle = Zone::cuboid(vec3(lo.x + 0.8, 0.0, lo.z + 0.8), vec3(hi.x - 0.8, 0.0, hi.z - 0.8));
    let rubble = Layer::on(&floor).density(9.0).spacing(0.14).scale(0.07, 0.24).tilt(30.0).sink(-0.02, 0.0).tint(0.8, 1.05).variants(3).clustered(2.2, 0.55).avoid(doorway.clone(), 0.2).avoid(middle, 0.0);
    let mut leaks = Layer::on(&walls).density(0.4).slope(85.0, 95.0).height(1.7, 2.7).spacing(1.6).yaw(-4.0, 4.0).scale(0.8, 1.3).cap(5);
    for window in &windows {
        leaks = leaks.avoid(window.clone(), 0.2);
    }
    let pavement_near = Surface::floor(vec2(-30.0, ROOM_MAX.z + WALL), vec2(30.0, 6.0), KERB);
    let pavement_far = Surface::floor(vec2(-30.0, 13.6), vec2(30.0, FACADE_Z), KERB);
    let pavements = pavement_near.and(&pavement_far);
    let road = Surface::floor(vec2(-30.0, 6.0), vec2(30.0, 13.6), 0.0);
    let facade = Surface::wall(vec3(-30.0, 0.0, FACADE_Z), vec3(30.0, 0.0, FACADE_Z), FACADE_HEIGHT, Vec3::NEG_Z)
        .and(&Surface::wall(vec3(-30.0, 0.0, ROOM_MAX.z + WALL), vec3(30.0, 0.0, ROOM_MAX.z + WALL), FACADE_HEIGHT, Vec3::Z));
    let gutter = Zone::along(street, ROAD_HALF + 0.05);
    let room_facade = Zone::cuboid(vec3(-30.0, 0.0, ROOM_MAX.z + WALL), vec3(30.0, 1.0, ROOM_MAX.z + WALL));
    let mut dressing = Dressing::new(DRESSING_SEED);
    dressing
        // The room: rubble along the walls, plaster slabs round it, papers in drifts.
        .layer("rubble", rubble)
        .layer("plaster", Layer::on(&floor).density(4.0).near_layer("rubble", 1.0).spacing(0.18).scale(0.6, 1.4).tilt(8.0).tint(0.85, 1.0))
        .layer("papers", Layer::on(&floor).density(5.0).clustered(1.6, 0.45).avoid_layer("rubble", 0.08).spacing(0.12).tilt(5.0).scale(0.9, 1.1).avoid(doorway, 0.0))
        // Its wear: grime along every wall base, leaks under the ceiling, a few posters, stains.
        .layer("grime", Layer::on(&walls).density(1.0).slope(85.0, 95.0).height(0.25, 0.45).spacing(1.4).scale(0.9, 1.4).yaw(0.0, 0.0).cap(10))
        .layer("leaks", leaks)
        .layer("posters", Layer::on(&walls).density(0.6).slope(85.0, 95.0).height(1.45, 1.75).spacing(1.8).yaw(-3.0, 3.0).variants(4).cap(4).avoid(Zone::cuboid(vec3(lo.x, 0.0, -1.5), vec3(lo.x, 3.0, 1.5)), 0.0))
        .layer("stains", Layer::on(&floor).density(0.5).spacing(1.2).scale(0.8, 1.6).cap(5))
        .layer("ceiling-stains", Layer::on(&ceiling).density(0.3).slope(170.0, 180.0).spacing(2.0).scale(1.0, 2.0).cap(3))
        // The street: lamps and bollards along the kerbs, bins by the facades, litter in the gutters.
        .layer("lamps", Layer::along(street, ROAD_HALF + 0.6, ROAD_HALF + 0.6).density(0.12).spacing(12.0).yaw(0.0, 0.0))
        .layer("bollards", Layer::along(street, ROAD_HALF + 0.45, ROAD_HALF + 0.45).density(0.6).spacing(2.2).avoid_layer("lamps", 1.2).yaw(0.0, 0.0))
        .layer("bins", Layer::on(&pavements).density(0.05).spacing(7.0).near(room_facade, 0.9).yaw(-15.0, 15.0))
        .layer("litter", Layer::on(&road.and(&pavements)).density(1.5).near(gutter, 0.9).spacing(0.15).tilt(10.0).variants(2).tint(0.8, 1.0))
        .layer("street-rubble", Layer::on(&pavements).density(1.2).clustered(3.0, 0.35).spacing(0.25).scale(0.06, 0.18).tilt(30.0).variants(3).tint(0.75, 1.0))
        // The street's wear: puddles in patches on the road, cracks, posters and grime on the facades.
        .layer("puddles", Layer::on(&road).density(0.12).clustered(5.0, 0.4).spacing(2.5).scale(0.8, 2.2).cap(10))
        .layer("cracks", Layer::on(&road.and(&pavements)).density(0.05).spacing(3.0).scale(1.0, 2.0).cap(6))
        .layer("street-posters", Layer::on(&facade).density(0.08).slope(85.0, 95.0).height(1.5, 2.2).spacing(2.5).yaw(-4.0, 4.0).variants(4).cap(8))
        .layer("street-grime", Layer::on(&facade).density(0.2).slope(85.0, 95.0).height(0.3, 0.5).spacing(3.0).scale(1.5, 2.5).yaw(0.0, 0.0).cap(8));
    dressing
}

/// One dressing layer's name, its draw tag, its models, material and optional far field.
type Drawn<'a> = (&'static str, &'static str, Vec<Model>, &'a Material, Option<Far>);

/// The dressing's solid layers as instance groups: rubble from smoothed, roughened boxes in three
/// variants, plaster slabs, papers, lamp posts, bollards, bins and litter, each tinted in buckets;
/// small things far away thinned by a far field.
fn groups(gfx: &Gfx, dressed: &Dressed, paints: &Paints) -> Vec<(&'static str, InstanceGroup)> {
    let mesh = |data: &MeshData| gfx.mesh(data).expect("a built mesh");
    let rocks: Vec<Model> = (0..3u32)
        .map(|seed| {
            let mut rock = MeshData::new();
            let stretch = [vec3(0.6, 0.35, 0.5), vec3(0.45, 0.4, 0.45), vec3(0.7, 0.25, 0.4)][seed as usize];
            rock.cuboid(-stretch, stretch, 1.0).subdivide(2).displace_noise(0.09, 0.35, seed + 1);
            rock.auto_uv(0.5);
            mesh(&rock)
        })
        .collect();
    let mut slab = MeshData::new();
    slab.rounded_cuboid(vec3(-0.16, 0.0, -0.12), vec3(0.16, 0.018, 0.12), 0.006, 2, 1.0).tessellate(2).displace_noise(0.004, 0.08, 3);
    let mut sheet = MeshData::new();
    sheet.rounded_cuboid(vec3(-0.105, 0.0, -0.148), vec3(0.105, 0.0015, 0.148), 0.0007, 2, 1.0);
    let mut can = MeshData::new();
    can.lathe(&Profile::polyline(vec![vec2(0.0, 0.0), vec2(0.033, 0.0), vec2(0.033, 0.115), vec2(0.026, 0.123), vec2(0.0, 0.123)]).bevel(0.003, 2), 16, 1.0);
    let lying = Quat::from_rotation_z(std::f32::consts::FRAC_PI_2);
    let mut can_down = MeshData::new();
    can_down.append(&can, Transform::from_xyz(0.0, 0.033, 0.0).with_rotation(lying));
    let mut post = MeshData::new();
    post.lathe(&Profile::polyline(vec![vec2(0.0, 0.0), vec2(0.16, 0.0), vec2(0.15, 0.25), vec2(0.07, 0.4), vec2(0.06, 4.6), vec2(0.18, 4.75), vec2(0.2, 5.1), vec2(0.0, 5.25)]).bevel(0.02, 2), 24, 1.0);
    let mut bollard = MeshData::new();
    bollard.lathe(&Profile::polyline(vec![vec2(0.0, 0.0), vec2(0.1, 0.0), vec2(0.09, 0.85), vec2(0.11, 0.9), vec2(0.06, 1.0), vec2(0.0, 1.0)]).bevel(0.01, 3), 20, 1.0);
    let mut street_bin = MeshData::new();
    street_bin.extrude(&Profile::rounded_rect(0.5, 0.45, 0.08, 4), 0.95, 0.02, 1.0);
    let mut stood_bin = MeshData::new();
    stood_bin.append(&street_bin, Transform::IDENTITY.with_rotation(Quat::from_rotation_x(-std::f32::consts::FRAC_PI_2)));
    let near = Far::thin(12.0, 35.0);
    let layers: [Drawn<'_>; 8] = [
        ("rubble", "rubble", rocks.clone(), &paints.rubble, None),
        ("plaster", "rubble", vec![mesh(&slab)], &paints.plaster, None),
        ("papers", "rubble", vec![mesh(&sheet)], &paints.paper, None),
        ("lamps", "street", vec![mesh(&post)], &paints.iron, None),
        ("bollards", "street", vec![mesh(&bollard)], &paints.iron, None),
        ("bins", "street", vec![mesh(&stood_bin)], &paints.steel, None),
        ("litter", "litter", vec![mesh(&sheet), mesh(&can_down)], &paints.paper, Some(near)),
        ("street-rubble", "litter", rocks, &paints.concrete, Some(near)),
    ];
    let mut out = Vec::new();
    for (layer, tag, models, material, far) in layers {
        for group in dressed.groups(layer, &models, Some(material)).expect("groups within their cap") {
            let group = match far {
                Some(far) => group.with_far(far).expect("a valid far field"),
                None => group,
            };
            out.push((tag, group));
        }
    }
    out
}

/// The dressing's wear layers as the interior kit's decals.
fn decals(dressed: &Dressed) -> Vec<genex::Decal> {
    const POSTERS: [&str; 4] = ["kit/decals/poster_space.png", "kit/decals/poster_study.png", "kit/decals/poster_table.png", "kit/decals/poster_defence.png"];
    let mut out = Vec::new();
    for p in dressed.get("grime").iter().chain(dressed.get("street-grime")) {
        out.push(p.decal(1.6, 0.6).with_base_texture("kit/decals/grime_base.png").with_opacity(0.75));
    }
    for p in dressed.get("leaks") {
        out.push(p.decal(0.7, 1.4).with_base_texture("kit/decals/leak.png").with_opacity(0.6));
    }
    for p in dressed.get("posters").iter().chain(dressed.get("street-posters")) {
        out.push(p.decal(0.6, 0.85).with_base_texture(POSTERS[p.variant as usize % POSTERS.len()]).with_roughness(0.7));
    }
    for p in dressed.get("stains").iter().chain(dressed.get("ceiling-stains")) {
        out.push(p.decal(1.2, 1.2).with_base_texture("kit/decals/ceiling_stain.png").with_opacity(0.55));
    }
    // Water on the road: no colour of its own, dark, glossy and flat over the asphalt's grain.
    for p in dressed.get("puddles") {
        let puddle = p.decal(1.6, 1.1).with_base_texture("kit/decals/peel_patch.png").with_color(Color::rgb(30, 30, 32));
        out.push(puddle.with_albedo_mix(0.35).with_roughness(0.06).with_flatten(1.0));
    }
    for p in dressed.get("cracks") {
        out.push(p.decal(1.0, 1.0).with_base_texture("kit/decals/crack.png").with_opacity(0.8));
    }
    out
}

fn draw(set: &Set, frame: &mut Frame) {
    frame.clear(Color::rgb(150, 170, 195)).ambient(Color::rgb(170, 185, 210), 0.12).sun(SUN_TOWARDS, Color::WHITE, SUN_INTENSITY);
    frame.environment(Environment::sky());
    for (tag, piece) in &set.pieces {
        frame.tag(tag);
        frame.model_with(&piece.model, piece.at, &piece.material);
    }
    for (tag, group) in &set.groups {
        frame.tag(tag);
        frame.group(group);
    }
    let room = (ROOM_MIN, ROOM_MAX);
    let eye = vec3(0.0, 1.6, 0.0);
    frame.reflection_probe(&ReflectionProbe::new(room.0, room.1).with_capture(eye).with_blend(WALL));
    frame.irradiance_volume(&IrradianceVolume::new(room.0, room.1).with_blend(WALL));
    for decal in &set.decals {
        frame.decal(decal);
    }
}
