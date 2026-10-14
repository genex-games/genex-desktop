//! The large-scene perf case: a 256 × 256 grid of plots 6 m apart (1.5 km across; about 64,000
//! instances once the ring road is cleared) holding buildings of twelve shapes and heights, pines, broadleaf trees and rocks
//! (28 meshes) in twelve materials, on one ground plane. Instances of one mesh and material are one
//! instanced draw. The camera flies a closed loop over a ring road that climbs from street level to an aerial view.

use genex::math::{self, Vec3, vec3};
use genex_render::RenderError;
use genex_render::mesh::MeshData;
use genex_render::scene::{Lighting, Material, MeshId, Scene};

use super::geometry::{broadleaf, building, from_mesh, heightfield};
use super::{BenchScene, Meshes, SceneId, camera, on_circle, path_fraction, placed};
use crate::layout::hash2;
use crate::meshgen;

/// Plots per side and their spacing, metres.
const PLOTS: i32 = 256;
const SPACING: f32 = 6.0;
/// Building shapes, and the floors of the tallest.
const BUILDINGS: u32 = 12;
const MAX_FLOORS: u32 = 12;
/// Tree and rock variants.
const PINES: u32 = 6;
const BROADLEAVES: u32 = 6;
const ROCKS: u32 = 4;
/// The palette every instance's material is picked from (sRGB, roughness).
const PALETTE: [([u8; 3], f32); 12] = [
    ([196, 186, 170], 0.85),
    ([168, 92, 70], 0.8),
    ([120, 128, 140], 0.6),
    ([220, 212, 196], 0.9),
    ([90, 96, 104], 0.5),
    ([184, 150, 104], 0.75),
    ([60, 90, 64], 0.85),
    ([46, 78, 50], 0.9),
    ([88, 120, 60], 0.8),
    ([132, 128, 120], 0.95),
    ([150, 160, 176], 0.35),
    ([210, 120, 90], 0.7),
];
/// The camera loop's radius around the city centre, and the half-width of the ring road along it
/// (no plot is built on, so the street-level part of the loop flies down a road).
const LOOP_RADIUS: f32 = 320.0;
const RING_ROAD: f32 = 14.0;

/// The mesh of every shape, in library order: buildings, pines, broadleaves, rocks.
fn shapes() -> Vec<MeshData> {
    let mut out: Vec<MeshData> = (0..BUILDINGS).map(|v| building(v, 2 + v * (MAX_FLOORS - 2) / (BUILDINGS - 1))).collect();
    out.extend((0..PINES).map(|v| from_mesh(&meshgen::pine(v))));
    out.extend((0..BROADLEAVES).map(broadleaf));
    out.extend((0..ROCKS).map(|v| from_mesh(&meshgen::rock(v))));
    out
}

/// What stands on plot (ix, iz): its shape index and palette index.
fn plot(ix: i32, iz: i32) -> (usize, usize) {
    let roll = hash2(ix, iz, 7);
    let pick = |count: u32, salt: u32| ((hash2(ix, iz, salt) * count as f32) as u32).min(count - 1) as usize;
    let downtown = 1.0 - ((ix - PLOTS / 2).abs().max((iz - PLOTS / 2).abs()) as f32 / (PLOTS / 2) as f32);
    if roll < 0.35 + 0.4 * downtown {
        let tall = (pick(BUILDINGS, 11) as f32 * (0.4 + 0.6 * downtown)) as usize;
        return (tall, pick(6, 13));
    }
    let base = BUILDINGS as usize;
    if roll < 0.9 {
        let tree = pick(PINES + BROADLEAVES, 17);
        return (base + tree, 6 + pick(3, 19));
    }
    (base + (PINES + BROADLEAVES) as usize + pick(ROCKS, 23), 9)
}

pub(super) struct City {
    ground: MeshId,
    /// Each instanced group: mesh, material and models.
    groups: Vec<(MeshId, Material, Vec<[f32; 16]>)>,
}

impl City {
    pub(super) fn load(meshes: &mut dyn Meshes) -> Result<City, RenderError> {
        let ground = meshes.add(heightfield(16, PLOTS as f32 * SPACING * 0.5 + 20.0, |_, _| 0.0))?;
        let ids = shapes().into_iter().map(|mesh| meshes.add(mesh)).collect::<Result<Vec<MeshId>, RenderError>>()?;
        let mut models: Vec<Vec<Vec<[f32; 16]>>> = vec![vec![Vec::new(); PALETTE.len()]; ids.len()];
        let origin = -(PLOTS as f32 - 1.0) * SPACING * 0.5;
        for iz in 0..PLOTS {
            for ix in 0..PLOTS {
                let (shape, paint) = plot(ix, iz);
                let jitter = vec3(hash2(ix, iz, 29) - 0.5, 0.0, hash2(ix, iz, 31) - 0.5) * SPACING * 0.3;
                let position = vec3(origin + ix as f32 * SPACING, 0.0, origin + iz as f32 * SPACING) + jitter;
                if (position.length() - LOOP_RADIUS).abs() < RING_ROAD {
                    continue;
                }
                let yaw = if shape < BUILDINGS as usize { math::FRAC_PI_2 * (hash2(ix, iz, 37) * 4.0).floor() } else { math::TAU * hash2(ix, iz, 37) };
                let scale = 0.8 + 0.4 * hash2(ix, iz, 41);
                models[shape][paint].push(placed(position, yaw, Vec3::splat(scale)));
            }
        }
        let mut groups = Vec::new();
        for (mesh, per_paint) in ids.into_iter().zip(models) {
            for (paint, list) in per_paint.into_iter().enumerate() {
                if list.is_empty() {
                    continue;
                }
                let (color, roughness) = PALETTE[paint];
                let [r, g, b] = color;
                groups.push((mesh, Material::color([r, g, b, 255]).with_pbr(0.0, roughness), list));
            }
        }
        Ok(City { ground, groups })
    }
}

impl BenchScene for City {
    fn id(&self) -> SceneId {
        SceneId::City
    }

    fn scene(&self, frame: u32) -> Scene {
        let fraction = path_fraction(frame);
        let angle = math::TAU * fraction;
        let climb = 0.5 - 0.5 * math::cos(angle);
        let eye = on_circle(angle, LOOP_RADIUS) + Vec3::Y * (14.0 + 70.0 * climb);
        let ahead = on_circle(angle + 0.25, LOOP_RADIUS * 0.92);
        let target = vec3(ahead.x, 2.0 + 20.0 * climb, ahead.z);
        let mut scene = Scene::new(camera(eye, target, 55.0, 1200.0), [178, 196, 214, 255]);
        scene.lighting = Lighting { sun_dir: [0.35, 0.8, 0.45], sun_intensity: 2.4, ambient_intensity: 0.12, shadow_distance: 80.0, ..Lighting::default() };
        scene.draw(self.ground, placed(Vec3::ZERO, 0.0, Vec3::ONE), Material::color([84, 86, 90, 255]).with_pbr(0.0, 0.9));
        for (mesh, material, models) in &self.groups {
            scene.draw_instanced(*mesh, models, *material);
        }
        scene
    }
}
