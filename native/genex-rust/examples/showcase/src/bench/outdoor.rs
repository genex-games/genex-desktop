//! The outdoor scene: rolling terrain 200 m across (160 × 160 cells) around a lake basin, pines,
//! broadleaf trees, rocks and grass tufts scattered by noise (about 12,000 instances), the water as
//! one transparent sheet at sea level, and an opaque three-band sky dome riding with the camera as the placeholder for
//! the physical sky (RQ2). The camera loops along the shore.

use genex::math::{self, Vec2, Vec3, vec2, vec3};
use genex_render::RenderError;
use genex_render::mesh::MeshData;
use genex_render::scene::{Lighting, Material, MeshId, Scene};

use super::geometry::{broadleaf, dome_band, from_mesh, grass_tuft, heightfield};
use super::{BenchScene, Meshes, SceneId, camera, on_circle, path_fraction, placed};
use crate::layout::{fbm, hash2, smoothstep};
use crate::meshgen;

/// Half the terrain's side, metres, and its cells per side.
const HALF: f32 = 100.0;
const CELLS: u32 = 160;
/// The lake basin's centre and radius.
const LAKE: Vec2 = vec2(18.0, -8.0);
const LAKE_RADIUS: f32 = 30.0;
/// The scatter grid's spacing, metres (one candidate per cell and kind).
const SCATTER_STEP: f32 = 1.2;
/// The camera's loop around the lake, and how far either side of it no tree grows.
const CAMERA_RING: f32 = LAKE_RADIUS * 1.25;
const PATH_CLEARING: f32 = 9.0;
/// The sky dome's radius (inside the far plane, past the shadow casters' reach).
const SKY_RADIUS: f32 = 600.0;
/// The bands of the sky placeholder: polar angles and sRGB colours, zenith to horizon, each within
/// a gentle step of the next (G0: a zenith band 44 levels off the next drew a hard-edged ellipse
/// across the top of the frame). Colours only: the scene's draws and their cost are unchanged.
const SKY_BANDS: [(f32, f32, [u8; 3]); 3] = [(0.0, 0.7, [150, 190, 246]), (0.7, 1.25, [172, 204, 250]), (1.25, 1.75, [196, 220, 255])];

/// Terrain height at (x, z): hills from two octaves of noise, cut down into the lake basin.
fn height(x: f32, z: f32) -> f32 {
    let p = vec2(x, z);
    let hills = 9.0 * fbm(p * 0.018, 4, 7) + 2.5 * fbm(p * 0.07, 3, 11) - 1.5;
    let basin = 1.0 - smoothstep(LAKE_RADIUS * 0.4, LAKE_RADIUS, p.distance(LAKE));
    hills - 9.0 * basin
}

/// What grows at a scatter cell, and how it looks.
struct Kind {
    salt: u32,
    /// Chance per cell where it may grow.
    density: f32,
    /// Lowest ground it grows on, metres above the water.
    above: f32,
    /// Whether it is kept off the camera's path (trees).
    tall: bool,
    /// Smallest and largest scale.
    scale: [f32; 2],
    color: [u8; 4],
    roughness: f32,
    /// The mesh of each of its four variants.
    mesh: fn(u32) -> MeshData,
}

fn pine(variant: u32) -> MeshData {
    from_mesh(&meshgen::pine(variant))
}

fn rock(variant: u32) -> MeshData {
    from_mesh(&meshgen::rock(variant))
}

fn tuft(variant: u32) -> MeshData {
    grass_tuft(variant, 7)
}

/// What grows, densest last.
const KINDS: [Kind; 4] = [
    Kind { salt: 1, density: 0.07, above: 1.5, tall: true, scale: [0.7, 1.3], color: [44, 82, 52, 255], roughness: 0.85, mesh: pine },
    Kind { salt: 2, density: 0.035, above: 0.8, tall: true, scale: [0.8, 1.2], color: [78, 120, 56, 255], roughness: 0.8, mesh: broadleaf },
    Kind { salt: 3, density: 0.02, above: 0.2, tall: false, scale: [0.4, 1.4], color: [128, 124, 116, 255], roughness: 0.9, mesh: rock },
    Kind { salt: 4, density: 0.45, above: 0.4, tall: false, scale: [0.8, 1.4], color: [104, 142, 64, 255], roughness: 0.75, mesh: tuft },
];
/// Variants of each kind.
const VARIANTS: u32 = 4;

/// Every instance of `kind`: (model, variant) where its density noise lets it grow.
fn scatter(kind: &Kind) -> Vec<([f32; 16], u32)> {
    let cells = (2.0 * (HALF - 4.0) / SCATTER_STEP) as i32;
    let mut out = Vec::new();
    for iz in 0..cells {
        for ix in 0..cells {
            let x = -HALF + 4.0 + (ix as f32 + hash2(ix, iz, kind.salt * 31)) * SCATTER_STEP;
            let z = -HALF + 4.0 + (iz as f32 + hash2(ix, iz, kind.salt * 37)) * SCATTER_STEP;
            let ground = height(x, z);
            let patch = fbm(vec2(x, z) * 0.03, 3, 50 + kind.salt);
            let chance = kind.density * smoothstep(0.35, 0.65, patch) * 2.0;
            let on_path = kind.tall && (vec2(x, z).distance(LAKE) - CAMERA_RING).abs() < PATH_CLEARING;
            if on_path || ground < kind.above || hash2(ix, iz, kind.salt * 41) > chance {
                continue;
            }
            let size = math::lerp(kind.scale[0], kind.scale[1], hash2(ix, iz, kind.salt * 43));
            let yaw = math::TAU * hash2(ix, iz, kind.salt * 47);
            let variant = ((hash2(ix, iz, kind.salt * 53) * VARIANTS as f32) as u32).min(VARIANTS - 1);
            out.push((placed(vec3(x, ground - 0.05, z), yaw, Vec3::splat(size)), variant));
        }
    }
    out
}

pub(super) struct Outdoor {
    terrain: MeshId,
    water: MeshId,
    sky: [MeshId; 3],
    /// Each instanced group: mesh, material and models.
    groups: Vec<(MeshId, Material, Vec<[f32; 16]>)>,
}

impl Outdoor {
    pub(super) fn load(meshes: &mut dyn Meshes) -> Result<Outdoor, RenderError> {
        let terrain = meshes.add(heightfield(CELLS, HALF, height))?;
        let water = meshes.add(heightfield(8, HALF, |_, _| 0.0))?;
        let sky = [meshes.add(dome_band(SKY_BANDS[0].0, SKY_BANDS[0].1, 48))?, meshes.add(dome_band(SKY_BANDS[1].0, SKY_BANDS[1].1, 48))?, meshes.add(dome_band(SKY_BANDS[2].0, SKY_BANDS[2].1, 48))?];
        let mut groups = Vec::new();
        for kind in &KINDS {
            let instances = scatter(kind);
            let material = Material::color(kind.color).with_pbr(0.0, kind.roughness);
            for variant in 0..VARIANTS {
                let mesh = meshes.add((kind.mesh)(variant))?;
                let models = instances.iter().filter(|(_, v)| *v == variant).map(|(model, _)| *model).collect();
                groups.push((mesh, material, models));
            }
        }
        Ok(Outdoor { terrain, water, sky, groups })
    }

    fn lighting() -> Lighting {
        Lighting {
            sun_dir: [0.55, 0.42, -0.35],
            sun_color: [255, 238, 214],
            sun_intensity: 2.6,
            ambient: [170, 190, 220],
            ambient_intensity: 0.14,
            shadow_distance: 60.0,
            ..Lighting::default()
        }
    }
}

impl BenchScene for Outdoor {
    fn id(&self) -> SceneId {
        SceneId::Outdoor
    }

    fn scene(&self, frame: u32) -> Scene {
        let angle = math::TAU * path_fraction(frame) + 2.2;
        let ring = vec3(LAKE.x, 0.0, LAKE.y) + on_circle(angle, CAMERA_RING);
        let eye = vec3(ring.x, height(ring.x, ring.z).max(0.0) + 3.2, ring.z);
        let ahead = vec3(LAKE.x, 0.0, LAKE.y) + on_circle(angle + 0.9, LAKE_RADIUS * 0.6);
        let target = vec3(ahead.x, (eye.y - 3.0).max(1.0), ahead.z);
        let mut scene = Scene::new(camera(eye, target, 55.0, 900.0), [206, 218, 228, 255]);
        scene.lighting = Outdoor::lighting();
        for (k, band) in self.sky.iter().enumerate() {
            let [r, g, b] = SKY_BANDS[k].2;
            scene.draw(*band, placed(eye, 0.0, Vec3::splat(SKY_RADIUS)), Material::color([r, g, b, 255]).with_pbr(0.0, 1.0));
        }
        scene.draw(self.terrain, placed(Vec3::ZERO, 0.0, Vec3::ONE), Material::color([92, 118, 62, 255]).with_pbr(0.0, 0.92));
        for (mesh, material, models) in &self.groups {
            scene.draw_instanced(*mesh, models, *material);
        }
        scene.draw(self.water, placed(Vec3::ZERO, 0.0, Vec3::ONE), Material::color([46, 92, 118, 168]).with_pbr(0.0, 0.06));
        scene
    }
}
