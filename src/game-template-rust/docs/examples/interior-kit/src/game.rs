//! A school corridor and the classroom off it, assembled from the interior kit (`assets/kit/`,
//! made by `interior_kit.py`): every wall a 2 m module (plain, window or door) with its dado coat
//! and trims, windows dressed with frames, sashes, broken glass and grilles, beams and fittings
//! overhead, desks, lockers and rubble on the floor. The shell takes CC0 scans projected from the
//! world (`with_world_uv`, stochastic tiling), trims and props take the kit's trim sheet and props
//! atlas, and the wear is the kit's decals: peeling paint along the dado line, leaks under the
//! sills, grime along the floor. Each room has a probe and a volume, every wall a collider.
//!
//! The level is data (`plan`): change the modules, and the draw, the colliders and the decals follow.

use std::collections::BTreeMap;
use std::f32::consts::{FRAC_PI_2, PI};

use genex::physics::{ColliderBuilder, RigidBodyBuilder};
use genex::prelude::*;
use genex::render::{Decal, Environment, Fog, Grading, IrradianceVolume, ReflectionProbe, RenderConfig, SpotLight};

/// The storey's height, a wall's thickness and the dado's top: the kit's own numbers.
const CEILING: f32 = 3.2;
const FACE: f32 = 0.125;
const DADO: f32 = 1.3;
/// The corridor and the classroom north of it, between their wall lines (metres).
const HALL: [Vec3; 2] = [vec3(0.0, 0.0, 0.0), vec3(16.0, CEILING, 4.0)];
const ROOM: [Vec3; 2] = [vec3(4.0, 0.0, 4.0), vec3(12.0, CEILING, 10.0)];
/// Towards the sun: low in the south, so it falls through the corridor's windows.
const SUN_TOWARDS: Vec3 = vec3(0.45, 0.35, -1.0);
const TUBE: Color = Color::rgb(220, 235, 255);
/// The seed of every dressing choice (broken panes, open doors, tipped chairs, wear).
const LAYOUT_SEED: u64 = 0x5c40_0001;
/// The pieces with a coarser level (`<name>-lod1.glb`) and how far away it takes over (metres).
const LODS: [(&str, f32); 5] = [("radiator", 8.0), ("desk", 12.0), ("chair", 10.0), ("lockers", 12.0), ("window-grille-sunburst", 14.0)];
/// Every piece the level draws, under `assets/kit/`.
const PIECES: [&str; 32] = [
    "wall", "wall-window", "wall-door", "wall-paint", "wall-window-paint", "wall-door-paint", "wall-trims", "wall-window-trims",
    "wall-door-trims", "pilaster", "pilaster-paint", "pilaster-trims", "window-frame", "window-sash", "window-glass", "window-glass-broken",
    "window-grille-bars", "window-grille-sunburst", "window-sill", "door-frame", "door", "beam", "light-fitting", "light-tube", "radiator",
    "desk", "desk-broken", "chair", "chair-broken", "lockers", "teacher-desk", "blackboard",
];
/// Rubble, litter and the yard's bench, each placed once.
const SCATTER: [(&str, f32, f32, f32); 7] = [
    ("debris-pile", 9.3, 2.9, 0.0),
    ("fallen-plaster", 13.0, 2.2, 0.6),
    ("paper-litter", 6.0, 2.0, 0.3),
    ("paper-litter", 8.6, 6.2, 2.1),
    ("desk-broken", 2.6, 3.0, 0.5),
    ("chair-broken", 12.2, 0.9, 2.0),
    ("bench", 7.0, -3.0, PI),
];

/// A Poly Haven scan as `cc0__fetch {source: "polyhaven", id, resolution: "1k"}` delivers it, the
/// metres one copy covers and its colour until its maps load (or when they are missing).
struct Scan {
    folder: &'static str,
    id: &'static str,
    tile: f32,
    stand_in: Color,
}

const PLASTER: Scan = Scan { folder: "cc0/57973f46-efe4-5584-8ecc-c8335e641d32", id: "painted_plaster_wall", tile: 2.5, stand_in: Color::rgb(190, 186, 178) };
const DADO_PAINT: Scan = Scan { folder: "cc0/c2536c59-bceb-ebba-aced-d476539274ad", id: "blue_plaster_wall", tile: 2.0, stand_in: Color::rgb(90, 130, 150) };
const CONCRETE: Scan = Scan { folder: "cc0/69d58cd7-d02f-5f73-c20b-748197b36df8", id: "concrete_wall_003", tile: 2.5, stand_in: Color::rgb(150, 146, 136) };
const TILES: Scan = Scan { folder: "cc0/e6657b6b-b54c-49ce-7af8-709354a34ed0", id: "floor_tiles_06", tile: 2.0, stand_in: Color::rgb(120, 112, 104) };

impl Scan {
    /// The scan projected from the world at its real size on any piece at any scale, stochastic
    /// tiling and a macro variation keeping a 16 m corridor from showing a tile twice; `roughness`
    /// scales the scan's own.
    fn material(&self, roughness: f32) -> Material {
        let map = |kind: &str| format!("{}/{}_{kind}_1k.jpg", self.folder, self.id);
        Material::color(Color::WHITE)
            .with_untextured_color(self.stand_in)
            .with_roughness(roughness)
            .with_base_texture(&map("diff"))
            .with_normal_texture(&map("nor_gl"), 1.0)
            .with_metal_rough_texture(&map("arm"))
            .with_world_uv(self.tile)
            .with_stochastic_tiling(true)
            .with_macro_variation(0.12, 3.0)
    }
}

/// One of the kit's sheets (`kit/<name>_color|normal|orm.jpg`) on its pieces' own UVs.
fn sheet(name: &str, stand_in: Color) -> Material {
    let map = |kind: &str| format!("kit/{name}_{kind}.jpg");
    Material::color(Color::WHITE)
        .with_untextured_color(stand_in)
        .with_roughness(1.0)
        .with_metallic(1.0)
        .with_base_texture(&map("color"))
        .with_normal_texture(&map("normal"), 1.0)
        .with_orm_texture(&map("orm"))
}

/// The material of each role the kit's pieces are named for.
pub struct Looks {
    plaster: Material,
    paint: Material,
    concrete: Material,
    tiles: Material,
    trim: Material,
    props: Material,
    glass: Material,
    ground: Material,
}

impl Default for Looks {
    fn default() -> Looks {
        Looks {
            plaster: PLASTER.material(1.0),
            // Oil paint is glossier than the distemper above it.
            paint: DADO_PAINT.material(0.6),
            concrete: CONCRETE.material(1.0),
            tiles: TILES.material(0.7),
            trim: sheet("trim", Color::rgb(110, 60, 40)),
            props: sheet("props", Color::rgb(120, 100, 80)),
            glass: Material::color(Color::rgba(170, 190, 195, 60)).with_roughness(0.05),
            ground: Material::color(Color::rgb(70, 72, 60)).with_roughness(0.95),
        }
    }
}

/// Everything the simulation owns. Every seed rebuilds it from `World::default()`.
#[derive(Default)]
pub struct World {
    /// Ticks since the seed: the flickering tube reads it.
    pub tick: u64,
    kit: BTreeMap<&'static str, Model>,
    looks: Looks,
}

impl World {
    /// Draw kit piece `name` at `at` in `material` (nothing before the kit is loaded).
    fn put(&self, frame: &mut Frame, name: &str, at: Transform, material: &Material) {
        if let Some(model) = self.kit.get(name) {
            frame.model_with(model, at, material);
        }
    }
}

/// A place on the plan: a point on the floor and a turn about y (0: the piece's +z faces +z).
#[derive(Clone, Copy)]
struct At {
    pos: Vec3,
    yaw: f32,
}

impl At {
    fn new(x: f32, z: f32, yaw: f32) -> At {
        At { pos: vec3(x, 0.0, z), yaw }
    }

    /// The place `local` away in this one's axes, turned `turn` more.
    fn then(self, local: Vec3, turn: f32) -> At {
        At { pos: self.pos + Quat::from_rotation_y(self.yaw) * local, yaw: self.yaw + turn }
    }

    fn transform(self) -> Transform {
        Transform::from_translation(self.pos).with_rotation(Quat::from_rotation_y(self.yaw))
    }

    /// The way its +z faces: a wall's room face.
    fn facing(self) -> Vec3 {
        Quat::from_rotation_y(self.yaw) * Vec3::Z
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Plain,
    Window,
    Door,
}

/// One wall module: its kind, where it stands (its room face along the yaw's +z) and whether
/// its back is a room too (painted and trimmed on both faces).
struct Module {
    kind: Kind,
    at: At,
    back_inside: bool,
}

impl Module {
    /// The kit's shell, coat and trims for this kind.
    fn pieces(&self) -> [&'static str; 3] {
        match self.kind {
            Kind::Plain => ["wall", "wall-paint", "wall-trims"],
            Kind::Window => ["wall-window", "wall-window-paint", "wall-window-trims"],
            Kind::Door => ["wall-door", "wall-door-paint", "wall-door-trims"],
        }
    }

    /// Each painted face: the front, and the back when it is inside.
    fn faces(&self) -> Vec<At> {
        let back = self.at.then(Vec3::ZERO, PI);
        if self.back_inside { vec![self.at, back] } else { vec![self.at] }
    }

    /// The solid parts (centre, half size) in the module's axes: the collider boxes.
    fn solids(&self) -> Vec<(Vec3, Vec3)> {
        match self.kind {
            Kind::Plain => vec![(vec3(0.0, 1.6, 0.0), vec3(1.0, 1.6, FACE))],
            Kind::Window => vec![(vec3(-0.9, 1.6, 0.0), vec3(0.1, 1.6, FACE)), (vec3(0.9, 1.6, 0.0), vec3(0.1, 1.6, FACE)), (vec3(0.0, 0.45, 0.0), vec3(0.8, 0.45, FACE)), (vec3(0.0, 2.9, 0.0), vec3(0.8, 0.3, FACE))],
            Kind::Door => vec![(vec3(-0.75, 1.6, 0.0), vec3(0.25, 1.6, FACE)), (vec3(0.75, 1.6, 0.0), vec3(0.25, 1.6, FACE)), (vec3(0.0, 2.65, 0.0), vec3(0.5, 0.55, FACE))],
        }
    }
}

/// The level: the corridor's window wall and its wall of doors into the classroom, its two ends,
/// and the classroom's window wall and sides.
fn plan() -> Vec<Module> {
    let mut walls = Vec::new();
    let module = |kind, x, z, yaw, back_inside| Module { kind, at: At::new(x, z, yaw), back_inside };
    for i in 0..8 {
        let x = 1.0 + 2.0 * i as f32;
        walls.push(module(if (1..7).contains(&i) { Kind::Window } else { Kind::Plain }, x, HALL[0].z, 0.0, false));
        walls.push(module(if i == 2 || i == 5 { Kind::Door } else { Kind::Plain }, x, HALL[1].z, PI, (2..6).contains(&i)));
    }
    for z in [1.0, 3.0] {
        walls.push(module(Kind::Plain, HALL[0].x, z, FRAC_PI_2, false));
        walls.push(module(Kind::Plain, HALL[1].x, z, -FRAC_PI_2, false));
    }
    for i in 0..4 {
        walls.push(module(Kind::Window, 5.0 + 2.0 * i as f32, ROOM[1].z, PI, false));
    }
    for z in [5.0, 7.0, 9.0] {
        walls.push(module(Kind::Plain, ROOM[0].x, z, FRAC_PI_2, false));
        walls.push(module(Kind::Plain, ROOM[1].x, z, -FRAC_PI_2, false));
    }
    walls
}

/// The look in code on top of `genex.toml`'s `[render]`: thin air, a cold, faded grade.
pub fn look(base: RenderConfig) -> RenderConfig {
    base.fog(Fog::default().with_density(0.012).with_height(0.05, 0.0)).grading(Grading::NEUTRAL.with_contrast(1.08).with_saturation(0.85)).temperature(-0.1, 0.0)
}

/// Register the level's hooks.
pub fn wire(game: &mut Game<World>) {
    game.render_settings(look(RenderConfig::from_build()));
    game.on_reset(|sim, _seed, _rng, gfx| {
        let (world, physics) = sim.split();
        for name in PIECES.into_iter().chain(SCATTER.map(|(name, ..)| name)) {
            let model = gfx.assets().model(&format!("kit/{name}.glb"));
            let model = match LODS.iter().find(|(piece, _)| *piece == name) {
                Some((_, metres)) => model.with_levels(&[(gfx.assets().model(&format!("kit/{name}-lod1.glb")), *metres)]),
                None => model,
            };
            world.kit.insert(name, model);
        }
        colliders(physics);
    });
    game.on_update(|sim, _ctx| sim.world.tick += 1);
    game.on_draw(|sim, frame, _camera| draw(&sim.world, frame));
    game.camera(|_sim| Camera { fovy: 70.0, ..Camera::look_at(vec3(0.9, 1.6, 2.7), vec3(15.0, 1.25, 1.2)) });
    game.named_camera("corridor", |_sim| Camera { fovy: 70.0, ..Camera::look_at(vec3(0.9, 1.6, 2.7), vec3(15.0, 1.25, 1.2)) });
    game.named_camera("classroom", |_sim| Camera { fovy: 68.0, ..Camera::look_at(vec3(11.3, 1.6, 4.8), vec3(4.6, 1.2, 8.6)) });
    game.probe("kit", |sim| json!({ "tick": sim.world.tick, "pieces": sim.world.kit.len() }));
}

/// The floor, every wall's solid parts, and the heavy furniture, as fixed boxes.
fn colliders(physics: &mut PhysicsWorld) {
    let mut fixed = |centre: Vec3, half: Vec3| {
        physics.insert(RigidBodyBuilder::fixed().translation(centre), ColliderBuilder::cuboid(half.x, half.y, half.z));
    };
    fixed(vec3(8.0, -0.1, 5.0), vec3(8.2, 0.1, 5.2));
    for wall in plan() {
        // Every module turns by quarter turns, so its boxes stay boxes: swap x and z when turned.
        let quarter = (wall.at.yaw / FRAC_PI_2).round() as i32 % 2 != 0;
        for (centre, half) in wall.solids() {
            fixed(wall.at.then(centre, 0.0).pos, if quarter { vec3(half.z, half.y, half.x) } else { half });
        }
    }
    for x in [7.0, 9.0] {
        fixed(vec3(x, 0.93, HALL[1].z - FACE - 0.23), vec3(0.45, 0.93, 0.23));
    }
}

fn draw(world: &World, frame: &mut Frame) {
    let looks = &world.looks;
    frame.clear(Color::rgb(120, 140, 160)).ambient(Color::rgb(170, 185, 210), 0.12).sun(SUN_TOWARDS, Color::WHITE, 3.0);
    frame.environment(Environment::sky());
    frame.tag("outside");
    // The yard, its top a little under the rooms' floors so the two never fight.
    let ground = Transform::from_translation(vec3(8.0, -0.17, 5.0)).with_scale(vec3(120.0, 0.3, 120.0));
    frame.cube_with(ground, &looks.ground);
    frame.cube_with(Transform::from_translation(vec3(8.0, 4.0, -40.0)).with_scale(vec3(40.0, 8.0, 1.0)), &looks.concrete);
    frame.tag("shell");
    for [lo, hi] in [HALL, ROOM] {
        let pad = vec3(FACE, 0.0, FACE);
        frame.cube_with(Transform::from_translation((lo + hi) * 0.5 - Vec3::Y * (CEILING * 0.5 + 0.1)).with_scale(vec3(hi.x - lo.x, 0.2, hi.z - lo.z) + pad * 2.0), &looks.tiles);
        frame.cube_with(Transform::from_translation((lo + hi) * 0.5 + Vec3::Y * (CEILING * 0.5 + 0.1)).with_scale(vec3(hi.x - lo.x, 0.2, hi.z - lo.z) + pad * 2.0), &looks.concrete);
    }
    for (i, wall) in plan().iter().enumerate() {
        let [shell, paint, trims] = wall.pieces();
        world.put(frame, shell, wall.at.transform(), &looks.plaster);
        for face in wall.faces() {
            world.put(frame, paint, face.transform(), &looks.paint);
            world.put(frame, trims, face.transform(), &looks.trim);
        }
        let mut rng = Pcg32::seeded(LAYOUT_SEED ^ i as u64);
        match wall.kind {
            Kind::Window => window(world, frame, wall.at, wall.at.pos.z < HALL[1].z, &mut rng),
            Kind::Door => {
                world.put(frame, "door-frame", wall.at.transform(), &looks.trim);
                let open = if rng.below(2) == 0 { -1.35 } else { 0.0 };
                world.put(frame, "door", wall.at.then(vec3(-0.47, 0.0, 0.0), open).transform(), &looks.props);
            }
            Kind::Plain => {}
        }
    }
    // Pilasters between the corridor's windows, and the concrete beams they carry.
    for x in [4.0, 8.0, 12.0] {
        for (name, look) in [("pilaster", &looks.plaster), ("pilaster-paint", &looks.paint), ("pilaster-trims", &looks.trim)] {
            world.put(frame, name, At::new(x, HALL[0].z, 0.0).transform(), look);
        }
        let beam = At::new(x, 2.0, FRAC_PI_2).transform();
        world.put(frame, "beam", Transform { translation: beam.translation + Vec3::Y * CEILING, scale: vec3(4.0 + 2.0 * FACE, 1.0, 1.0), ..beam }, &looks.concrete);
    }
    furniture(world, frame);
    lamps(world, frame);
    for [lo, hi] in [HALL, ROOM] {
        let (min, max) = (lo + vec3(FACE, 0.0, FACE), hi - vec3(FACE, 0.0, FACE));
        let eye = vec3((min.x + max.x) * 0.5, 1.6, (min.z + max.z) * 0.5);
        frame.reflection_probe(&ReflectionProbe::new(min, max).with_capture(eye).with_blend(FACE * 2.0));
        frame.irradiance_volume(&IrradianceVolume::new(min, max).with_blend(FACE * 2.0));
    }
    wear(frame);
}

/// A window's dressing, chosen from its seed: frame and sill always, the sashes mostly, glass broken
/// or gone, a sunburst grille on the corridor's side, bars on the classroom's, a radiator under it.
fn window(world: &World, frame: &mut Frame, at: At, corridor: bool, rng: &mut Pcg32) {
    let (looks, place) = (&world.looks, at.transform());
    frame.tag("windows");
    world.put(frame, "window-frame", place, &looks.trim);
    world.put(frame, "window-sill", place, &looks.concrete);
    if rng.below(4) != 0 {
        world.put(frame, "window-sash", place, &looks.trim);
        world.put(frame, if rng.below(3) == 0 { "window-glass" } else { "window-glass-broken" }, place, &looks.glass);
    }
    world.put(frame, if corridor { "window-grille-sunburst" } else { "window-grille-bars" }, place, &looks.trim);
    world.put(frame, "radiator", at.then(vec3(0.0, 0.0, FACE), 0.0).transform(), &looks.props);
    frame.tag("shell");
}

/// Desks in rows facing the blackboard, a few shoved or tipped; the teacher's desk; lockers in the
/// corridor; and the rubble and litter.
fn furniture(world: &World, frame: &mut Frame) {
    let props = &world.looks.props;
    frame.tag("props");
    let mut rng = Pcg32::seeded(LAYOUT_SEED);
    for x in [6.4, 8.2, 10.0] {
        for z in [5.6, 7.0, 8.4] {
            let shove = rng.range_f32(-0.25, 0.25);
            world.put(frame, "desk", At::new(x, z, FRAC_PI_2 + shove * 0.4).transform(), props);
            let chair = At::new(x + 0.55, z + shove, -FRAC_PI_2 + shove);
            let tipped = Transform { rotation: Quat::from_rotation_y(chair.yaw) * Quat::from_rotation_x(-FRAC_PI_2), ..chair.then(vec3(0.0, 0.2, -0.3), 0.0).transform() };
            world.put(frame, "chair", if rng.below(4) == 0 { tipped } else { chair.transform() }, props);
        }
    }
    world.put(frame, "teacher-desk", At::new(5.1, 7.3, FRAC_PI_2).transform(), props);
    world.put(frame, "blackboard", At::new(ROOM[0].x, 7.0, FRAC_PI_2).then(vec3(0.0, 0.0, FACE), 0.0).transform(), props);
    for x in [7.0, 9.0] {
        world.put(frame, "lockers", At::new(x, HALL[1].z, PI).then(vec3(0.0, 0.0, FACE), 0.0).transform(), props);
    }
    for (name, x, z, yaw) in SCATTER {
        world.put(frame, name, At::new(x, z, yaw).transform(), props);
    }
}

/// A twin-tube fitting over each room's lanes, each tube paired with a spot light (one flickers).
fn lamps(world: &World, frame: &mut Frame) {
    frame.tag("lamps");
    let spots = [(2.0, 2.0), (6.0, 2.0), (10.0, 2.0), (14.0, 2.0), (6.0, 6.0), (10.0, 6.0), (6.0, 8.4), (10.0, 8.4)];
    for (i, (x, z)) in spots.into_iter().enumerate() {
        let on = i != 2 || !matches!((world.tick / 4) % 37, 3 | 5 | 21);
        let at = Transform::from_translation(vec3(x, CEILING, z));
        world.put(frame, "light-fitting", at, &world.looks.props);
        world.put(frame, "light-tube", at, &Material::emissive(TUBE, if on { 6.0 } else { 0.05 }));
        if on {
            let spot = SpotLight::new(vec3(x, CEILING - 0.45, z), Vec3::NEG_Y, 7.0, TUBE, 2.0);
            frame.spot_light_with(&spot.with_cone_degrees(60.0, 85.0));
        }
    }
}

/// The kit's decals, from the layout seed: grime along the floor and peeling paint under the dado
/// rail on half the faces, a patch or a crack higher up, a leak under each sill, and the ceiling's
/// skim coat come away over the fallen plaster.
fn wear(frame: &mut Frame) {
    let mut rng = Pcg32::seeded(LAYOUT_SEED ^ 0xdeca1);
    // Each decal's shape is a PNG's alpha; its normal map, where it has one, a JPEG.
    let decal = |name: &str| format!("kit/decals/{name}.png");
    let normal = |name: &str| format!("kit/decals/{name}_normal.jpg");
    for wall in plan() {
        for face in wall.faces() {
            let (out, along) = (face.facing(), Quat::from_rotation_y(face.yaw) * Vec3::X);
            let on = |up: f32, shift: f32| face.pos + out * (FACE + 0.003) + Vec3::Y * up + along * shift;
            if rng.below(2) == 0 {
                frame.decal(&Decal::on_wall(on(0.16, 0.0), out, 2.0, 0.32).with_base_texture(&decal("grime_base")).with_opacity(0.8));
            }
            if rng.below(2) == 0 {
                let edge = Decal::on_wall(on(DADO - 0.2, rng.range_f32(-0.3, 0.3)), out, rng.range_f32(1.0, 1.8), 0.34);
                frame.decal(&edge.with_base_texture(&decal("peel_edge")).with_normal_texture(&normal("peel_edge"), 1.0));
            }
            if wall.kind == Kind::Window {
                frame.decal(&Decal::on_wall(on(0.45, 0.0), out, 1.4, 0.9).with_base_texture(&decal("leak")).with_opacity(0.7));
            } else if rng.below(3) == 0 {
                let size = rng.range_f32(0.7, 1.3);
                let patch = Decal::on_wall(on(rng.range_f32(1.8, 2.7), rng.range_f32(-0.5, 0.5)), out, size, size).rotated(rng.range_f32(-0.4, 0.4));
                let patch = if rng.below(2) == 0 { patch.with_base_texture(&decal("peel_patch")).with_normal_texture(&normal("peel_patch"), 0.6) } else { patch.with_base_texture(&decal("crack")) };
                frame.decal(&patch);
            }
        }
    }
    for (x, z, size) in [(13.0, 2.2, 1.6), (5.5, 1.4, 1.0), (8.4, 7.4, 1.3)] {
        let ceiling = Decal::on_wall(vec3(x, CEILING, z), Vec3::NEG_Y, size, size).with_base_texture(&decal("peel_patch"));
        frame.decal(&ceiling.with_normal_texture(&normal("peel_patch"), 1.0));
    }
}
