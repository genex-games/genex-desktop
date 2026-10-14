//! The material and lighting scene: a five-by-seven wall of spheres (metallic 0..1 down the rows,
//! roughness 0.05..1 across the columns) in front of a backdrop, three skinned walkers circling on
//! the floor, glass (spheres of three opacities, a tinted pane and a cube) and four coloured point
//! lights under a low sun. Emissive materials join when the renderer has them (RQ6).

use genex::math::{self, Vec3, vec3};
use genex_render::RenderError;
use genex_render::scene::{Lighting, Material, MeshId, PointLight, Scene};
use genex_render::skin::{SkinId, SkinnedMeshData};

use super::geometry::{boxes, uv_sphere};
use super::{BenchScene, Meshes, SceneId, camera, on_circle, path_fraction, placed, seconds};

/// Metallic per row and roughness per column of the sphere wall.
const METALLIC: [f32; 5] = [0.0, 0.25, 0.5, 0.75, 1.0];
const ROUGHNESS: [f32; 7] = [0.05, 0.2, 0.35, 0.5, 0.65, 0.8, 1.0];
/// The spheres' base colour (a warm copper, so metals and dielectrics read apart).
const SPHERE_COLOR: [u8; 4] = [222, 168, 120, 255];
/// Where the walkers circle, and how far out.
const WALK_CENTER: Vec3 = vec3(-4.2, 0.0, 1.2);
const WALK_RADIUS: f32 = 1.5;
/// Walking speed around the circle, radians per second.
const WALK_TURN: f32 = 0.55;

pub(super) struct Materials {
    sphere: MeshId,
    floor: MeshId,
    backdrop: MeshId,
    pane: MeshId,
    walker: SkinnedMeshData,
    walker_id: SkinId,
}

impl Materials {
    pub(super) fn load(meshes: &mut dyn Meshes) -> Result<Materials, RenderError> {
        let walker = super::walker();
        Ok(Materials {
            sphere: meshes.add(uv_sphere(48, 96))?,
            floor: meshes.add(boxes(&[(vec3(0.0, -0.1, 0.0), vec3(30.0, 0.2, 22.0))]))?,
            backdrop: meshes.add(boxes(&[(vec3(0.0, 4.0, -6.2), vec3(30.0, 8.0, 0.4)), (vec3(-11.0, 2.0, -3.0), vec3(0.4, 4.0, 6.0))]))?,
            pane: meshes.add(boxes(&[(Vec3::ZERO, vec3(1.6, 1.8, 0.05))]))?,
            walker_id: meshes.add_skinned(&walker)?,
            walker,
        })
    }

    fn lighting() -> Lighting {
        let light = |position: [f32; 3], color: [u8; 3]| PointLight { position, range: 9.0, color, intensity: 3.0 };
        Lighting {
            sun_dir: [-0.5, 0.75, 0.6],
            sun_color: [255, 236, 210],
            sun_intensity: 2.2,
            ambient: [190, 205, 230],
            ambient_intensity: 0.12,
            points: vec![
                light([-5.5, 2.6, 2.5], [255, 180, 110]),
                light([5.0, 2.6, 2.5], [120, 170, 255]),
                light([-2.0, 0.6, -3.2], [255, 70, 60]),
                light([2.5, 0.6, -3.2], [80, 255, 120]),
            ],
            ..Lighting::default()
        }
    }

    fn sphere_wall(&self, scene: &mut Scene) {
        for (row, metallic) in METALLIC.iter().enumerate() {
            for (column, roughness) in ROUGHNESS.iter().enumerate() {
                let position = vec3((column as f32 - 3.0) * 1.05, 0.55 + row as f32 * 1.0, -4.6);
                scene.draw(self.sphere, placed(position, 0.0, Vec3::splat(0.45)), Material::color(SPHERE_COLOR).with_pbr(*metallic, *roughness));
            }
        }
    }

    fn glass(&self, scene: &mut Scene) {
        for (k, alpha) in [64u8, 128, 192].into_iter().enumerate() {
            let position = vec3(3.0 + k as f32 * 1.2, 0.6, 1.4);
            scene.draw(self.sphere, placed(position, 0.0, Vec3::splat(0.55)), Material::color([150, 210, 235, alpha]).with_pbr(0.0, 0.05));
        }
        scene.draw(self.pane, placed(vec3(4.2, 0.9, 3.0), 0.35, Vec3::ONE), Material::color([120, 220, 160, 110]).with_pbr(0.0, 0.1));
        scene.draw(MeshId::CUBE, placed(vec3(6.6, 0.5, 2.6), 0.6, Vec3::ONE), Material::color([235, 120, 200, 150]).with_pbr(0.0, 0.3));
    }

    fn walkers(&self, scene: &mut Scene, frame: u32) {
        let colors = [[70, 110, 200, 255], [210, 90, 70, 255], [90, 170, 90, 255]];
        let time = seconds(frame);
        for (k, color) in colors.into_iter().enumerate() {
            let angle = WALK_TURN * time + math::TAU * k as f32 / 3.0;
            let position = WALK_CENTER + on_circle(angle, WALK_RADIUS);
            // Walking counter-clockwise seen from above: facing along the circle's tangent.
            let yaw = -angle;
            let joints = super::walk(&self.walker, time + k as f32 * 0.37);
            scene.draw_skinned(self.walker_id, placed(position, yaw, Vec3::ONE), joints, Material::color(color).with_pbr(0.0, 0.55));
        }
    }
}

impl BenchScene for Materials {
    fn id(&self) -> SceneId {
        SceneId::Materials
    }

    fn scene(&self, frame: u32) -> Scene {
        let swing = 0.55 * math::sin(math::TAU * path_fraction(frame));
        let target = vec3(0.0, 1.9, -2.0);
        let eye = target + vec3(0.0, 1.5, 0.0) + on_circle(math::FRAC_PI_2 - swing, 9.0);
        let mut scene = Scene::new(camera(eye, target, 50.0, 200.0), [40, 44, 52, 255]);
        scene.lighting = Materials::lighting();
        scene.draw(self.floor, placed(Vec3::ZERO, 0.0, Vec3::ONE), Material::color([128, 128, 132, 255]).with_pbr(0.0, 0.8));
        scene.draw(self.backdrop, placed(Vec3::ZERO, 0.0, Vec3::ONE), Material::color([196, 192, 186, 255]).with_pbr(0.0, 0.9));
        self.sphere_wall(&mut scene);
        self.walkers(&mut scene, frame);
        self.glass(&mut scene);
        scene
    }
}
