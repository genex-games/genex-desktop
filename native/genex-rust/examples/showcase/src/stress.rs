//! The three stress scenes of the renderer perf matrix (plan RQ0.9 and R2.5), beside the lakeside shots and the
//! bench scenes. They draw through genex-render's [`Scene`] directly, like [`crate::bench`], and are
//! a function of the frame index alone.
//!
//! - `plaza`: a 200 × 200 m paved plaza under a low sun with [`PLAZA_LIGHTS`] point lights on a
//!   32 × 32 lamp lattice, pavilions and benches. Today's light table holds [`MAX_LIGHTS`] lights,
//!   so each frame lists the lights nearest the camera first and the rest are dropped by the
//!   renderer; the clustered lighting of tier RQ6 takes all of them (its acceptance row).
//! - `forest`: about [`FOREST_TRIANGLES`] triangles of pines, broadleaf trees and boulders on rolling
//!   hills, the camera walking a closed path at eye height between the trunks: most of the forest
//!   is hidden behind the nearest trees and ridges, which is the case the meshlet and Hi-Z
//!   occlusion tier (R2) is measured on.
//! - `occlusion`: a courtyard of 48 dense statues (about a million triangles in four big meshes,
//!   each far above the meshlet threshold) inside a ring of twelve walls, the camera circling
//!   outside at ground level: the walls hide nearly every statue for most of the path, and the
//!   camera then rises over the walls and every statue is disoccluded. It is the scene the meshlet
//!   and two-pass Hi-Z occlusion path (R2) is judged on: the saving while hidden, and the
//!   correctness when the camera rises (pass 2 re-tests every candidate).

use genex::math::{self, Mat4, Vec3, vec3};
use genex_render::RenderError;
use genex_render::layout::MAX_LIGHTS;
use genex_render::mesh::MeshData;
use genex_render::scene::{CameraDesc, Lighting, Material, MeshId, MeshLibrary, PointLight, Scene};

use crate::bench::geometry::{boxes, broadleaf, building, from_mesh, heightfield, merged, transformed, tube, uv_sphere};
use crate::bench::{Meshes, PATH_FRAMES};
use crate::layout::{fbm, hash2, smoothstep};
use crate::meshgen;

/// Point lights in the plaza scene.
pub const PLAZA_LIGHTS: usize = 1024;
/// The plaza's side, metres.
pub const PLAZA_SIDE: f32 = 200.0;
/// Lamp posts (and lights) per side of the plaza's lattice.
const LAMPS_PER_SIDE: usize = 32;
/// How far a plaza light reaches, metres, and its height above the paving.
const LIGHT_RANGE: f32 = 9.0;
const LAMP_HEIGHT: f32 = 3.6;
/// The plaza's pavilions, benches and the camera loop's radius around the centre.
const PAVILIONS: i32 = 96;
const BENCHES: i32 = 360;
const PLAZA_LOOP_RADIUS: f32 = 62.0;

/// Triangles the forest draws (all instances counted) and how far the total may be from it.
pub const FOREST_TRIANGLES: u64 = 1_500_000;
/// How far the forest's total may be from [`FOREST_TRIANGLES`], as a share of it.
pub const FOREST_TOLERANCE: f64 = 0.03;
/// Half the forest's side, metres, and the spacing of its planting grid.
const FOREST_HALF: f32 = 75.0;
const PLANTING_STEP: f32 = 2.0;
/// Variants of each kind: pines, broadleaf trees, old-growth trees (a thousand triangles each) and
/// boulders (five thousand each).
const PINES: u32 = 6;
const BROADLEAVES: u32 = 6;
const OLD_GROWTH: u32 = 4;
const BOULDERS: u32 = 3;
/// Where the kinds change along a planting's 0..1 roll: pine, broadleaf, old growth, then boulder.
const KIND_EDGES: [f32; 3] = [0.40, 0.65, 0.95];
/// The camera's loop around the forest's centre, and the width of the path kept clear of trees.
const FOREST_LOOP_RADIUS: f32 = 30.0;
const FOREST_PATH_CLEARING: f32 = 2.4;
const EYE_HEIGHT: f32 = 1.75;

/// Triangles the occlusion hall draws (all instances counted) and how far the total may be from it.
pub const OCCLUSION_TRIANGLES: u64 = 1_000_000;
/// How far the hall's total may be from [`OCCLUSION_TRIANGLES`], as a share of it.
pub const OCCLUSION_TOLERANCE: f64 = 0.03;
/// Icosphere subdivisions of a statue (20 x 4^5 = 20,480 triangles) and the variants of it.
const STATUE_SUBDIVISIONS: u32 = 5;
const STATUE_VARIANTS: u32 = 4;
/// Statues per ring of the courtyard, the rings' radii and the statues' radius, metres.
const STATUE_RINGS: [(u32, f32); 3] = [(6, 5.0), (14, 12.0), (28, 20.0)];
const STATUE_RADIUS: f32 = 2.0;
/// The walls: segments around the courtyard, their radius, length, height and thickness, metres.
/// Twelve 12 m walls on a 30 m radius leave a 3.5 m gap between neighbours.
const WALLS: u32 = 12;
const WALL_RADIUS: f32 = 30.0;
const WALL_LENGTH: f32 = 12.0;
const WALL_HEIGHT: f32 = 9.0;
const WALL_THICKNESS: f32 = 2.0;
/// The camera's circle around the courtyard, its low and its high eye height, and the share of the
/// path (start, end) it spends rising over the walls and coming back down.
const HALL_LOOP_RADIUS: f32 = 56.0;
const HALL_EYE_LOW: f32 = 2.5;
const HALL_EYE_HIGH: f32 = 24.0;
const HALL_RISE: (f32, f32) = (0.6, 0.7);
const HALL_FALL: (f32, f32) = (0.9, 1.0);
/// The camera starts facing a wall, not a gap (gaps lie on the multiples of 360 / [`WALLS`] degrees).
const HALL_PHASE: f32 = math::PI / WALLS as f32;

/// The stress scenes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum StressId {
    /// 1,024 point lights over a 200 × 200 m plaza.
    Plaza,
    /// A dense forest of about 1.5 million triangles with heavy occlusion.
    Forest,
    /// A million triangles of big statues behind walls, then the camera rises over the walls.
    Occlusion,
}

impl StressId {
    /// Both scenes, in report order.
    pub const ALL: [StressId; 3] = [StressId::Plaza, StressId::Forest, StressId::Occlusion];

    /// Its name in file names and reports.
    pub const fn name(self) -> &'static str {
        match self {
            StressId::Plaza => "plaza",
            StressId::Forest => "forest",
            StressId::Occlusion => "occlusion",
        }
    }

    /// Auto exposure's compensation curve (`Look::compensation_curve`, `(metered EV, compensation
    /// EV)` points) where the scene sets its own: the plaza is a lamp-lit dusk, and an exposure
    /// free to lift it to middle grey lifted it to a pink-white day in which its light pools barely
    /// read (pass-1 gate finding 04). [`DUSK_EXPOSURE_CURVE`] keeps a dark scene dark, as any
    /// game's look can, instead of a floor on the metered EV.
    pub const fn exposure_curve(self) -> Option<&'static [(f32, f32)]> {
        match self {
            StressId::Plaza => Some(&DUSK_EXPOSURE_CURVE),
            StressId::Forest | StressId::Occlusion => None,
        }
    }
}

/// A dusk's compensation curve: a scene metered below EV 0 is lifted towards middle grey by only
/// a quarter of its darkness (metered EV -4 draws 3 EV under middle grey, -8 draws 6 under), and
/// daylight is untouched.
pub const DUSK_EXPOSURE_CURVE: [(f32, f32); 2] = [(-8.0, -6.0), (0.0, 0.0)];

/// A loaded stress scene: what it draws at a frame of its path.
pub trait StressScene {
    /// The scene's id.
    fn id(&self) -> StressId;
    /// The frame to draw at `frame` (any index; the path loops every [`PATH_FRAMES`]).
    fn scene(&self, frame: u32) -> Scene;
}

/// Load scene `id`'s meshes into `meshes`.
pub fn load(id: StressId, meshes: &mut dyn Meshes) -> Result<Box<dyn StressScene>, RenderError> {
    Ok(match id {
        StressId::Plaza => Box::new(Plaza::load(meshes)?),
        StressId::Forest => Box::new(Forest::load(meshes)?),
        StressId::Occlusion => Box::new(Hall::load(meshes)?),
    })
}

/// Triangles `scene` draws, every instance counted, against the meshes in `library` (skinned draws
/// and lines are not counted).
pub fn triangles(scene: &Scene, library: &MeshLibrary) -> u64 {
    scene.draws.iter().filter_map(|draw| library.entry(draw.mesh)).map(|entry| u64::from(entry.index_count) / 3).sum()
}

/// A perspective camera from `eye` to `target` with `fovy` degrees and a far plane at `far`.
fn camera(eye: Vec3, target: Vec3, fovy: f32, far: f32) -> CameraDesc {
    CameraDesc { fovy_degrees: fovy, far, ..CameraDesc::look_at(eye.to_array(), target.to_array()) }
}

fn path_fraction(frame: u32) -> f32 {
    (frame % PATH_FRAMES) as f32 / PATH_FRAMES as f32
}

fn placed(position: Vec3, yaw: f32, scale: Vec3) -> [f32; 16] {
    Mat4::from_scale_rotation_translation(scale, math::Quat::from_rotation_y(yaw), position).to_cols_array()
}

fn point_on_circle(angle: f32, radius: f32) -> Vec3 {
    let (s, c) = math::sin_cos(angle);
    vec3(c * radius, 0.0, s * radius)
}

/// The lamp lattice's position `(ix, iz)` on the paving.
fn lamp_position(ix: usize, iz: usize) -> Vec3 {
    let step = PLAZA_SIDE / LAMPS_PER_SIDE as f32;
    let origin = -PLAZA_SIDE * 0.5 + step * 0.5;
    vec3(origin + ix as f32 * step, 0.0, origin + iz as f32 * step)
}

/// The sRGB colour of lamp `(ix, iz)`: warm sodium to cold white, picked by a hash.
fn lamp_color(ix: usize, iz: usize) -> [u8; 3] {
    const PALETTE: [[u8; 3]; 6] = [[255, 190, 120], [255, 214, 160], [255, 240, 220], [190, 215, 255], [255, 150, 110], [170, 255, 200]];
    let pick = (hash2(ix as i32, iz as i32, 3) * PALETTE.len() as f32) as usize;
    PALETTE[pick.min(PALETTE.len() - 1)]
}

struct Plaza {
    ground: MeshId,
    lamp: MeshId,
    pavilion: [MeshId; 3],
    bench: MeshId,
    lamps: Vec<[f32; 16]>,
    pavilions: Vec<(usize, [f32; 16])>,
    benches: Vec<[f32; 16]>,
    lights: Vec<PointLight>,
}

impl Plaza {
    fn load(meshes: &mut dyn Meshes) -> Result<Plaza, RenderError> {
        let pole = tube(Vec3::ZERO, vec3(0.0, LAMP_HEIGHT - 0.2, 0.0), [0.09, 0.06], 1, 8);
        let head = transformed(&uv_sphere(8, 12), Mat4::from_scale_rotation_translation(Vec3::splat(0.26), math::Quat::IDENTITY, vec3(0.0, LAMP_HEIGHT, 0.0)));
        let ground = meshes.add(boxes(&[(vec3(0.0, -0.1, 0.0), vec3(PLAZA_SIDE, 0.2, PLAZA_SIDE))]))?;
        let lamp = meshes.add(merged(&[pole, head]))?;
        let pavilion = [meshes.add(building(1, 2))?, meshes.add(building(4, 3))?, meshes.add(building(7, 4))?];
        let bench = meshes.add(boxes(&[(vec3(0.0, 0.45, 0.0), vec3(1.8, 0.1, 0.5)), (vec3(0.0, 0.9, -0.22), vec3(1.8, 0.5, 0.08))]))?;
        let (mut lamps, mut lights) = (Vec::new(), Vec::new());
        for iz in 0..LAMPS_PER_SIDE {
            for ix in 0..LAMPS_PER_SIDE {
                let at = lamp_position(ix, iz);
                lamps.push(placed(at, 0.0, Vec3::ONE));
                lights.push(PointLight { position: [at.x, LAMP_HEIGHT - 0.4, at.z], range: LIGHT_RANGE, color: lamp_color(ix, iz), intensity: 4.0 });
            }
        }
        // Pavilions and benches stand between the lamp rows, never on a lamp.
        let step = PLAZA_SIDE / LAMPS_PER_SIDE as f32;
        let between = |i: i32, salt: u32| -> Vec3 {
            let x = (hash2(i, 1, salt) - 0.5) * (PLAZA_SIDE - step * 2.0);
            let z = (hash2(i, 2, salt) - 0.5) * (PLAZA_SIDE - step * 2.0);
            vec3(x, 0.0, z)
        };
        let pavilions = (0..PAVILIONS)
            .map(|i| (i as usize % 3, placed(between(i, 51), math::FRAC_PI_2 * (hash2(i, 3, 51) * 4.0).floor(), Vec3::splat(0.8))))
            .collect();
        let benches = (0..BENCHES).map(|i| placed(between(i, 61), math::TAU * hash2(i, 3, 61), Vec3::ONE)).collect();
        Ok(Plaza { ground, lamp, pavilion, bench, lamps, pavilions, benches, lights })
    }
}

impl StressScene for Plaza {
    fn id(&self) -> StressId {
        StressId::Plaza
    }

    fn scene(&self, frame: u32) -> Scene {
        let fraction = path_fraction(frame);
        let angle = math::TAU * fraction;
        let climb = 0.5 - 0.5 * math::cos(angle * 2.0);
        let eye = point_on_circle(angle, PLAZA_LOOP_RADIUS) + Vec3::Y * (4.5 + 14.0 * climb);
        let ahead = point_on_circle(angle + 0.45, PLAZA_LOOP_RADIUS * 0.55);
        let camera = camera(eye, vec3(ahead.x, 1.0, ahead.z), 60.0, 700.0);
        let mut scene = Scene::new(camera, [20, 24, 38, 255]);
        let mut lights = self.lights.clone();
        // Nearest first: today's light table keeps the first MAX_LIGHTS, so the ones that matter stay.
        lights.sort_by(|a, b| {
            let distance = |l: &PointLight| (Vec3::from(l.position) - eye).length_squared();
            distance(a).total_cmp(&distance(b))
        });
        debug_assert!(lights.len() > MAX_LIGHTS, "the stress scene is meant to exceed the light table");
        scene.lighting = Lighting {
            sun_dir: [-0.35, 0.28, 0.5],
            sun_color: [255, 170, 120],
            sun_intensity: 1.1,
            ambient: [90, 110, 160],
            ambient_intensity: 0.2,
            points: lights,
            shadow_distance: 90.0,
            ..Lighting::default()
        };
        scene.draw(self.ground, placed(Vec3::ZERO, 0.0, Vec3::ONE), Material::color([112, 112, 118, 255]).with_pbr(0.0, 0.7));
        scene.draw_instanced(self.lamp, &self.lamps, Material::color([60, 62, 70, 255]).with_pbr(0.6, 0.45));
        for (k, mesh) in self.pavilion.iter().enumerate() {
            let models: Vec<[f32; 16]> = self.pavilions.iter().filter(|(kind, _)| *kind == k).map(|(_, model)| *model).collect();
            scene.draw_instanced(*mesh, &models, Material::color([188, 176, 160, 255]).with_pbr(0.0, 0.8));
        }
        scene.draw_instanced(self.bench, &self.benches, Material::color([120, 84, 56, 255]).with_pbr(0.0, 0.85));
        scene
    }
}

/// Ground height at (x, z): rolling hills and two ridges that hide the far forest.
fn forest_height(x: f32, z: f32) -> f32 {
    let p = math::vec2(x, z);
    let hills = 7.0 * fbm(p * 0.02, 4, 71) + 1.6 * fbm(p * 0.09, 3, 73) - 3.0;
    let ridge = |centre: f32, width: f32, height: f32| height * (1.0 - smoothstep(0.0, width, (x - centre).abs()));
    hills + ridge(-48.0, 12.0, 9.0) + ridge(46.0, 11.0, 7.0)
}

/// One planted instance: which mesh group and its model.
struct Planting {
    mesh: usize,
    model: [f32; 16],
}

struct Forest {
    terrain: MeshId,
    /// Each mesh and the planted models: pines, broadleaves, old growth, boulders.
    groups: Vec<(MeshId, Material, Vec<[f32; 16]>)>,
}

/// An old-growth tree: a tapering trunk and a tall canopy of three lumpy blobs.
fn old_growth(variant: u32) -> MeshData {
    let trunk = tube(Vec3::ZERO, vec3(0.0, 4.6, 0.0), [0.34, 0.16], 4, 10);
    let canopy = transformed(&from_mesh(&meshgen::canopy(variant)), Mat4::from_scale_rotation_translation(Vec3::splat(1.7), math::Quat::IDENTITY, vec3(0.0, 5.8, 0.0)));
    merged(&[trunk, canopy])
}

/// A boulder: a finely subdivided lumpy sphere about two metres across.
fn boulder(variant: u32) -> MeshData {
    from_mesh(&meshgen::icosphere(4, |d| {
        let bump = 0.7 + 0.5 * hash2((d.x * 5.0) as i32, (d.z * 5.0 + d.y * 3.0) as i32, 300 + variant);
        d * bump
    }))
}

/// The forest's meshes in group order: pines, broadleaves, old growth, boulders.
fn forest_meshes() -> Vec<MeshData> {
    let mut meshes: Vec<MeshData> = (0..PINES).map(|v| from_mesh(&meshgen::pine(v))).collect();
    meshes.extend((0..BROADLEAVES).map(broadleaf));
    meshes.extend((0..OLD_GROWTH).map(old_growth));
    meshes.extend((0..BOULDERS).map(boulder));
    meshes
}

fn forest_material(group: usize) -> Material {
    let pines = PINES as usize;
    let leaves = pines + BROADLEAVES as usize;
    let old = leaves + OLD_GROWTH as usize;
    let paint = |color: [u8; 3], roughness: f32| Material::color([color[0], color[1], color[2], 255]).with_pbr(0.0, roughness);
    if group < pines {
        paint([44, 78, 52], 0.9)
    } else if group < leaves {
        paint([86, 118, 56], 0.85)
    } else if group < old {
        paint([62, 96, 48], 0.88)
    } else {
        paint([126, 122, 114], 0.95)
    }
}

/// The mesh group a planting rolls: by its roll's place among [`KIND_EDGES`], then a variant.
fn kind_of(roll: f32, variant: f32) -> usize {
    let (pines, leaves, old) = (PINES as usize, BROADLEAVES as usize, OLD_GROWTH as usize);
    let pick = |count: usize| ((variant * count as f32) as usize).min(count - 1);
    if roll < KIND_EDGES[0] {
        pick(pines)
    } else if roll < KIND_EDGES[1] {
        pines + pick(leaves)
    } else if roll < KIND_EDGES[2] {
        pines + leaves + pick(old)
    } else {
        pines + leaves + old + pick(BOULDERS as usize)
    }
}

/// The plantings of the forest, in a fixed shuffled order, until no further one fits in `budget`
/// triangles.
fn plant(triangles_of: &[u64], budget: u64) -> Vec<Planting> {
    let cells = (2.0 * FOREST_HALF / PLANTING_STEP) as i32;
    let mut candidates = Vec::new();
    for iz in 0..cells {
        for ix in 0..cells {
            let x = -FOREST_HALF + (ix as f32 + hash2(ix, iz, 81)) * PLANTING_STEP;
            let z = -FOREST_HALF + (iz as f32 + hash2(ix, iz, 83)) * PLANTING_STEP;
            let on_path = ((x * x + z * z).sqrt() - FOREST_LOOP_RADIUS).abs() < FOREST_PATH_CLEARING;
            if !on_path {
                candidates.push((hash2(ix, iz, 89), ix, iz, x, z));
            }
        }
    }
    candidates.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
    let mut plantings = Vec::new();
    let mut total = 0_u64;
    for (_, ix, iz, x, z) in candidates {
        let mesh = kind_of(hash2(ix, iz, 91), hash2(ix, iz, 93));
        if total + triangles_of[mesh] > budget {
            continue;
        }
        total += triangles_of[mesh];
        let scale = 0.8 + 0.6 * hash2(ix, iz, 99);
        let ground = forest_height(x, z);
        plantings.push(Planting { mesh, model: placed(vec3(x, ground - 0.05, z), math::TAU * hash2(ix, iz, 101), Vec3::splat(scale)) });
    }
    plantings
}

impl Forest {
    fn load(meshes: &mut dyn Meshes) -> Result<Forest, RenderError> {
        let terrain_mesh = heightfield(100, FOREST_HALF + 10.0, forest_height);
        let terrain_triangles = terrain_mesh.indices.len() as u64 / 3;
        let terrain = meshes.add(terrain_mesh)?;
        let list = forest_meshes();
        let triangles_of: Vec<u64> = list.iter().map(|m| m.indices.len() as u64 / 3).collect();
        let plantings = plant(&triangles_of, FOREST_TRIANGLES - terrain_triangles);
        let mut groups = Vec::new();
        for (index, mesh) in list.into_iter().enumerate() {
            let id = meshes.add(mesh)?;
            let models = plantings.iter().filter(|p| p.mesh == index).map(|p| p.model).collect();
            groups.push((id, forest_material(index), models));
        }
        Ok(Forest { terrain, groups })
    }
}

impl StressScene for Forest {
    fn id(&self) -> StressId {
        StressId::Forest
    }

    fn scene(&self, frame: u32) -> Scene {
        let angle = math::TAU * path_fraction(frame);
        let at = point_on_circle(angle, FOREST_LOOP_RADIUS);
        let eye = vec3(at.x, forest_height(at.x, at.z) + EYE_HEIGHT, at.z);
        let ahead = point_on_circle(angle + 0.12, FOREST_LOOP_RADIUS);
        let target = vec3(ahead.x, forest_height(ahead.x, ahead.z) + EYE_HEIGHT * 1.1, ahead.z);
        let mut scene = Scene::new(camera(eye, target, 62.0, 500.0), [170, 190, 205, 255]);
        scene.lighting = Lighting {
            sun_dir: [0.45, 0.62, -0.3],
            sun_color: [255, 238, 214],
            sun_intensity: 2.8,
            ambient: [150, 175, 210],
            ambient_intensity: 0.45,
            shadow_distance: 60.0,
            ..Lighting::default()
        };
        scene.draw(self.terrain, placed(Vec3::ZERO, 0.0, Vec3::ONE), Material::color([84, 108, 58, 255]).with_pbr(0.0, 0.92));
        for (mesh, material, models) in &self.groups {
            if !models.is_empty() {
                scene.draw_instanced(*mesh, models, *material);
            }
        }
        scene
    }
}

/// One wall of the hall: where it stands, how it turns about Y, and its half extents.
struct Wall {
    centre: Vec3,
    yaw: f32,
    half: Vec3,
}

/// The twelve walls, each centred on a multiple of 30 degrees plus 15 (the gaps lie between them),
/// its long side tangent to the circle.
fn hall_walls() -> Vec<Wall> {
    (0..WALLS)
        .map(|k| {
            let angle = math::TAU * (k as f32 + 0.5) / WALLS as f32;
            let on_circle = point_on_circle(angle, WALL_RADIUS);
            Wall {
                centre: vec3(on_circle.x, WALL_HEIGHT * 0.5, on_circle.z),
                // Rotation about +Y by yaw maps +X to (cos yaw, 0, -sin yaw); the tangent at `angle` is (-sin, 0, cos).
                yaw: -(angle + math::FRAC_PI_2),
                half: vec3(WALL_LENGTH * 0.5, WALL_HEIGHT * 0.5, WALL_THICKNESS * 0.5),
            }
        })
        .collect()
}

/// The statues' positions (on the ground), ring by ring.
fn hall_statues() -> Vec<Vec3> {
    let mut statues = Vec::new();
    for (ring, (count, radius)) in STATUE_RINGS.into_iter().enumerate() {
        for k in 0..count {
            // Each ring is turned by its own offset so no statue stands behind another along a spoke.
            let angle = math::TAU * (k as f32 + 0.37 * ring as f32) / count as f32;
            statues.push(point_on_circle(angle, radius));
        }
    }
    statues
}

/// The camera's eye and target at `frame`: a circle outside the walls at ground level, rising over
/// them for a tenth of the path ([`HALL_RISE`], [`HALL_FALL`]) and looking at the courtyard.
fn hall_camera(frame: u32) -> (Vec3, Vec3) {
    let fraction = path_fraction(frame);
    let height = HALL_EYE_LOW + (HALL_EYE_HIGH - HALL_EYE_LOW) * smoothstep(HALL_RISE.0, HALL_RISE.1, fraction) * (1.0 - smoothstep(HALL_FALL.0, HALL_FALL.1, fraction));
    let around = point_on_circle(HALL_PHASE + math::TAU * fraction, HALL_LOOP_RADIUS);
    (vec3(around.x, height, around.z), vec3(0.0, STATUE_RADIUS, 0.0))
}

/// Whether the segment `from` to `to` crosses `wall` (slab test in the wall's own frame).
fn segment_hits_wall(wall: &Wall, from: Vec3, to: Vec3) -> bool {
    let local = |p: Vec3| math::Quat::from_rotation_y(-wall.yaw) * (p - wall.centre);
    let (a, b) = (local(from), local(to));
    let (mut enter, mut leave) = (0.0_f32, 1.0_f32);
    for axis in 0..3 {
        let (start, delta, half) = (a[axis], b[axis] - a[axis], wall.half[axis]);
        if delta.abs() < 1e-6 {
            if start.abs() > half {
                return false;
            }
            continue;
        }
        let (t0, t1) = ((-half - start) / delta, (half - start) / delta);
        enter = enter.max(t0.min(t1));
        leave = leave.min(t0.max(t1));
        if enter > leave {
            return false;
        }
    }
    true
}

/// The share of the hall's statues the walls hide from the camera at `frame`: a statue is hidden
/// when a wall crosses the sight line from the eye to its centre and to its top. A conservative
/// geometric reference for the scene's design (a renderer's Hi-Z culls by depth, so it can hide
/// more, and it can show a statue through a gap that this reads as hidden never).
pub fn occlusion_hidden_share(frame: u32) -> f32 {
    let (eye, _) = hall_camera(frame);
    let (walls, statues) = (hall_walls(), hall_statues());
    let hidden = statues
        .iter()
        .filter(|at| {
            let samples = [*at + Vec3::Y * STATUE_RADIUS, *at + Vec3::Y * (STATUE_RADIUS * 2.0)];
            samples.iter().all(|sample| walls.iter().any(|wall| segment_hits_wall(wall, eye, *sample)))
        })
        .count();
    hidden as f32 / statues.len() as f32
}

struct Hall {
    ground: MeshId,
    walls: MeshId,
    /// Each statue variant and the models that place it.
    statues: Vec<(MeshId, Vec<[f32; 16]>)>,
}

/// A statue: a finely subdivided lumpy sphere, `variant` choosing the lumps.
fn statue(variant: u32) -> MeshData {
    from_mesh(&meshgen::icosphere(STATUE_SUBDIVISIONS, |d| {
        let lump = 0.8 + 0.4 * hash2((d.x * 4.0) as i32, (d.z * 4.0 + d.y * 2.0) as i32, 400 + variant);
        d * lump
    }))
}

impl Hall {
    fn load(meshes: &mut dyn Meshes) -> Result<Hall, RenderError> {
        let ground = meshes.add(boxes(&[(vec3(0.0, -0.1, 0.0), vec3(160.0, 0.2, 160.0))]))?;
        let cube = MeshData::cube();
        let slabs: Vec<MeshData> = hall_walls()
            .iter()
            .map(|wall| transformed(&cube, Mat4::from_scale_rotation_translation(wall.half * 2.0, math::Quat::from_rotation_y(wall.yaw), wall.centre)))
            .collect();
        let walls = meshes.add(merged(&slabs))?;
        let mut statues = Vec::new();
        for variant in 0..STATUE_VARIANTS {
            statues.push((meshes.add(statue(variant))?, Vec::new()));
        }
        for (index, at) in hall_statues().into_iter().enumerate() {
            let model = placed(vec3(at.x, STATUE_RADIUS, at.z), math::TAU * hash2(index as i32, 5, 411), Vec3::splat(STATUE_RADIUS));
            statues[index % STATUE_VARIANTS as usize].1.push(model);
        }
        Ok(Hall { ground, walls, statues })
    }
}

impl StressScene for Hall {
    fn id(&self) -> StressId {
        StressId::Occlusion
    }

    fn scene(&self, frame: u32) -> Scene {
        let (eye, target) = hall_camera(frame);
        let mut scene = Scene::new(camera(eye, target, 60.0, 400.0), [150, 170, 195, 255]);
        scene.lighting = Lighting {
            sun_dir: [0.4, 0.7, 0.35],
            sun_color: [255, 236, 210],
            sun_intensity: 2.6,
            ambient: [140, 160, 200],
            ambient_intensity: 0.4,
            shadow_distance: 70.0,
            ..Lighting::default()
        };
        scene.draw(self.ground, placed(Vec3::ZERO, 0.0, Vec3::ONE), Material::color([96, 100, 92, 255]).with_pbr(0.0, 0.9));
        scene.draw(self.walls, placed(Vec3::ZERO, 0.0, Vec3::ONE), Material::color([170, 160, 148, 255]).with_pbr(0.0, 0.85));
        const PAINT: [[u8; 3]; STATUE_VARIANTS as usize] = [[196, 120, 96], [104, 150, 186], [170, 176, 104], [150, 118, 176]];
        for (variant, (mesh, models)) in self.statues.iter().enumerate() {
            let [r, g, b] = PAINT[variant];
            scene.draw_instanced(*mesh, models, Material::color([r, g, b, 255]).with_pbr(0.1, 0.6));
        }
        scene
    }
}
