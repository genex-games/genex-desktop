//! Streamed textures (game systems STR-17): the view set's side of mip streaming. Each frame a
//! streamed model's textures are seen at the screen pixels per metre of its cell's nearest point
//! ([`pixels_per_metre`] over [`distance_to_cell`]), weighted by the model's UV density from the
//! asset index (C-29, [`uv_densities`]); genex-render's [`TextureStream`] turns the sights into
//! loads and pool drops ([`ViewTextures`]).
//!
//! What is here is the policy's input and its ledger; the presenter's half (writing a promoted
//! chain into a layer of the larger class array, rewriting the material row the frame after it
//! lands, and on the web reading the head levels by `Range`) is not wired yet, so the view set does
//! not hold one: until it does, streamed models upload their textures whole, as before.
#![cfg_attr(not(test), expect(dead_code, reason = "the presenter's half of STR-17 is not wired yet (module doc)"))]

use std::collections::BTreeMap;

use genex_render::texture::TextureFamily;
use genex_render::texture_stream::{StreamPlan, StreamedId, TextureStream};
use glam::{Vec2, Vec3};
use serde_json::Value;

use crate::camera::{Camera, Projection};

/// The nearest distance a sight is taken at, in metres: closer reads as this close (a camera
/// inside a cell sees its textures as near as they come, never infinitely large).
const SIGHT_DISTANCE_MIN: f32 = 0.25;

/// Screen pixels per metre at `distance` metres from `camera` on a view `viewport_height` pixels
/// tall: the vertical field of view spread over the view (an orthographic view's height in metres
/// is its `fovy`).
pub(crate) fn pixels_per_metre(camera: &Camera, viewport_height: u32, distance: f32) -> f32 {
    let height = viewport_height as f32;
    match camera.projection {
        Projection::Orthographic => height / camera.fovy.max(f32::EPSILON),
        Projection::Perspective => {
            let half = crate::math::tan(camera.fovy.to_radians() / 2.0).max(f32::EPSILON);
            height / (2.0 * distance.max(SIGHT_DISTANCE_MIN) * half)
        }
    }
}

/// The horizontal distance from `eye` to the ground square of a cell `size` metres a side whose
/// lowest corner is `min` (zero inside it).
pub(crate) fn distance_to_cell(eye: Vec3, min: Vec2, size: f32) -> f32 {
    let ground = Vec2::new(eye.x, eye.z);
    let nearest = ground.clamp(min, min + Vec2::splat(size));
    ground.distance(nearest)
}

/// Each model's UV density (UV units per metre, the index's `mesh.uvDensity`) by path. A missing or
/// foreign index, or a model without UVs, lists nothing: its textures then read density 1.
pub(crate) fn uv_densities(index: &[u8]) -> BTreeMap<String, f32> {
    let Ok(index) = serde_json::from_slice::<Value>(index) else { return BTreeMap::new() };
    let Some(assets) = index.get("assets").and_then(Value::as_array) else { return BTreeMap::new() };
    let density = |asset: &Value| {
        let path = asset.get("path")?.as_str()?.to_owned();
        let value = asset.get("mesh")?.get("uvDensity")?.as_f64()? as f32;
        (value.is_finite() && value > 0.0).then_some((path, value))
    };
    assets.iter().filter_map(density).collect()
}

/// The streamed textures of the view set's models.
#[derive(Debug)]
pub(crate) struct ViewTextures {
    stream: TextureStream,
    by_model: BTreeMap<String, Vec<StreamedId>>,
    densities: BTreeMap<String, f32>,
}

impl ViewTextures {
    /// No textures, the class's texture pool, the index's UV densities.
    pub(crate) fn new(pool_bytes: u64, index: &[u8]) -> ViewTextures {
        ViewTextures { stream: TextureStream::new(pool_bytes), by_model: BTreeMap::new(), densities: uv_densities(index) }
    }

    /// A model became resident with textures of these sides and families, each at its tail. A
    /// model tracked already keeps what it has.
    pub(crate) fn track(&mut self, model: &str, textures: &[(u32, TextureFamily)]) {
        if self.by_model.contains_key(model) {
            return;
        }
        let density = self.densities.get(model).copied();
        let ids = textures.iter().filter_map(|(side, family)| self.stream.add(*side, *family, density)).collect();
        self.by_model.insert(model.to_owned(), ids);
    }

    /// A model was evicted: its textures leave the ledger.
    pub(crate) fn untrack(&mut self, model: &str) {
        for id in self.by_model.remove(model).into_iter().flatten() {
            self.stream.remove(id);
        }
    }

    /// `model` is drawn this frame at `pixels_per_metre`.
    pub(crate) fn see(&mut self, model: &str, pixels_per_metre: f32) {
        for id in self.by_model.get(model).into_iter().flatten() {
            self.stream.see(*id, pixels_per_metre);
        }
    }

    /// End the frame: the loads to start and what the pool dropped.
    pub(crate) fn plan(&mut self) -> StreamPlan {
        self.stream.plan()
    }

    /// The residency itself (the presenter reports landed loads through it).
    pub(crate) fn stream_mut(&mut self) -> &mut TextureStream {
        &mut self.stream
    }

    /// The rungs `model`'s textures show, in the order they were tracked.
    pub(crate) fn shown(&self, model: &str) -> Vec<u32> {
        self.by_model.get(model).into_iter().flatten().filter_map(|id| self.stream.shown(*id)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const INDEX: &[u8] = br#"{"version":1,"assets":[
        {"path":"models/rock.glb","mesh":{"uvDensity":2.0}},
        {"path":"models/flat.glb","mesh":{"uvDensity":null}},
        {"path":"textures/a.png"}
    ]}"#;

    fn camera(fovy: f32, projection: Projection) -> Camera {
        Camera { fovy, projection, ..Camera::look_at(Vec3::ZERO, Vec3::NEG_Z) }
    }

    #[test]
    fn a_perspective_view_halves_its_pixels_per_metre_at_twice_the_distance() {
        let camera = camera(90.0, Projection::Perspective);
        let near = pixels_per_metre(&camera, 1000, 10.0);
        assert!((near - 50.0).abs() < 1e-3, "{near}");
        assert!((pixels_per_metre(&camera, 1000, 20.0) - near / 2.0).abs() < 1e-3);
        assert_eq!(pixels_per_metre(&camera, 1000, 0.0), pixels_per_metre(&camera, 1000, SIGHT_DISTANCE_MIN));
        assert_eq!(pixels_per_metre(&self::camera(20.0, Projection::Orthographic), 1000, 500.0), 50.0);
    }

    #[test]
    fn the_distance_to_a_cell_is_zero_inside_it_and_horizontal_outside() {
        let min = Vec2::new(0.0, 0.0);
        assert_eq!(distance_to_cell(Vec3::new(10.0, 50.0, 10.0), min, 64.0), 0.0);
        assert_eq!(distance_to_cell(Vec3::new(-3.0, 9.0, 10.0), min, 64.0), 3.0);
        assert_eq!(distance_to_cell(Vec3::new(67.0, 0.0, 68.0), min, 64.0), 5.0);
    }

    #[test]
    fn the_index_names_each_models_uv_density_and_a_foreign_one_names_none() {
        let densities = uv_densities(INDEX);
        assert_eq!(densities.into_iter().collect::<Vec<_>>(), [("models/rock.glb".to_owned(), 2.0)]);
        assert!(uv_densities(b"not json").is_empty());
    }

    #[test]
    fn a_tracked_model_promotes_as_its_cell_nears_and_an_evicted_one_leaves_the_ledger() {
        let mut view = ViewTextures::new(1 << 30, INDEX);
        view.track("models/rock.glb", &[(1024, TextureFamily::Bc7), (512, TextureFamily::Bc7)]);
        assert_eq!(view.shown("models/rock.glb"), [64, 64]);
        let camera = camera(60.0, Projection::Perspective);
        // 2,000 px per metre over 2 UV units per metre: 1,000 texels per UV unit.
        let sight = pixels_per_metre(&camera, 1080, 1080.0 / (2.0 * 2000.0 * crate::math::tan(30.0_f32.to_radians())));
        view.see("models/rock.glb", sight);
        let plan = view.plan();
        for load in &plan.loads {
            view.stream_mut().landed(load.id, load.to);
        }
        assert_eq!(view.shown("models/rock.glb"), [1024, 512]);
        let before = view.stream_mut().resident_bytes();
        view.untrack("models/rock.glb");
        assert!(view.stream_mut().resident_bytes() < before);
        assert_eq!(view.stream_mut().resident_bytes(), 0);
    }
}
