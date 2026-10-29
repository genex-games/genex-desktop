//! Facade lights and materials (RQ1.4): what a draw hook declares with `frame.sun`,
//! `frame.ambient`, `frame.point_light` and per-draw [`Material`]s reaches the renderer's scene
//! through the one conversion native and web share (`genex::present::to_scene`), and a frame that
//! declares none draws exactly as before.

use std::cell::RefCell;

use genex::glam::Vec3;
use genex::present::{AssetCache, ModelSource, Uploads, to_scene};
use genex::{Assets, Camera, Color, Frame, Material, Transform};
use genex_render::RenderError;
use genex_render::mesh::{CUBE_TRIANGLES, MeshData};
use genex_render::scene::{Lighting, MeshId, PointLight, Scene};
use genex_render::texture::{TextureData, TextureId, TextureKind};

/// Today's surface for every draw that names no material.
const TODAY_METALLIC: f32 = 0.0;
const TODAY_ROUGHNESS: f32 = 0.55;

fn scene_of(frame: &Frame) -> Scene {
    to_scene(frame, &Camera::DEFAULT, &AssetCache::default())
}

#[test]
fn a_frame_with_no_lighting_calls_draws_today_s_lighting() {
    let mut frame = Frame::default();
    frame.cube(Transform::IDENTITY, Color::RED);
    assert_eq!(scene_of(&frame).lighting, Lighting::default());
}

#[test]
fn reflection_probes_reach_the_scene_s_lighting_in_call_order_and_are_not_draws() {
    let mut frame = Frame::default();
    let room = genex::ReflectionProbe::new(Vec3::new(-6.0, 0.15, 7.8), Vec3::new(6.0, 3.6, 15.8)).with_capture(Vec3::new(0.0, 1.6, 12.0)).with_blend(0.4);
    frame.reflection_probe(&room);
    frame.reflection_probe(&genex::ReflectionProbe::new(Vec3::ZERO, Vec3::ONE).with_intensity(0.5));
    assert_eq!(frame.draw_calls(), 0, "probes are not draws");
    let probes = scene_of(&frame).lighting.reflection_probes;
    assert_eq!(probes.len(), 2);
    assert_eq!((probes[0].min, probes[0].max, probes[0].capture, probes[0].blend), ([-6.0, 0.15, 7.8], [6.0, 3.6, 15.8], [0.0, 1.6, 12.0], 0.4));
    assert_eq!((probes[1].capture, probes[1].intensity), ([0.5; 3], 0.5));
    assert!(scene_of(&Frame::default()).lighting.reflection_probes.is_empty(), "none by default");
}

#[test]
fn irradiance_volumes_reach_the_scene_s_lighting_in_call_order_and_are_not_draws() {
    let mut frame = Frame::default();
    let room = genex::IrradianceVolume::new(Vec3::new(-6.0, 0.15, 7.8), Vec3::new(6.0, 3.6, 15.8)).with_blend(0.4);
    assert_eq!(room.cells, [12, 4, 8], "a cell about every metre");
    frame.irradiance_volume(&room);
    frame.irradiance_volume(&genex::IrradianceVolume::new(Vec3::ZERO, Vec3::ONE).with_cells([2, 3, 4]).with_intensity(0.5));
    assert_eq!(frame.draw_calls(), 0, "volumes are not draws");
    let volumes = scene_of(&frame).lighting.irradiance_volumes;
    assert_eq!(volumes.len(), 2);
    assert_eq!((volumes[0].min, volumes[0].max, volumes[0].cells, volumes[0].blend), ([-6.0, 0.15, 7.8], [6.0, 3.6, 15.8], [12, 4, 8], 0.4));
    assert_eq!((volumes[1].cells, volumes[1].intensity), ([2, 3, 4], 0.5));
    assert!(scene_of(&Frame::default()).lighting.irradiance_volumes.is_empty(), "none by default");
}

#[test]
fn a_sun_call_reaches_the_scene_s_lighting() {
    let mut frame = Frame::default();
    frame.sun(Vec3::new(0.0, 1.0, -1.0), Color::rgb(255, 200, 150), 4.0);
    let lighting = scene_of(&frame).lighting;
    assert_eq!(lighting.sun_dir, [0.0, 1.0, -1.0]);
    assert_eq!(lighting.sun_color, [255, 200, 150]);
    assert_eq!(lighting.sun_intensity, 4.0);
    let rest = Lighting { sun_dir: lighting.sun_dir, sun_color: lighting.sun_color, sun_intensity: 4.0, ..Lighting::default() };
    assert_eq!(lighting, rest, "only the sun changed");
}

#[test]
fn ambient_and_point_lights_reach_the_scene_in_call_order_and_are_not_draws() {
    let mut frame = Frame::default();
    frame.ambient(Color::rgb(100, 120, 255), 0.3);
    frame.point_light(Vec3::new(1.0, 2.0, 3.0), 5.0, Color::rgb(255, 128, 0), 2.0);
    frame.point_light(Vec3::new(-1.0, 0.5, 0.0), 2.0, Color::GREEN, 1.0);
    assert_eq!(frame.draw_calls(), 0, "lights are not draws");
    let lighting = scene_of(&frame).lighting;
    assert_eq!((lighting.ambient, lighting.ambient_intensity), ([100, 120, 255], 0.3));
    assert_eq!(
        lighting.points,
        [
            PointLight { position: [1.0, 2.0, 3.0], range: 5.0, color: [255, 128, 0], intensity: 2.0 },
            PointLight { position: [-1.0, 0.5, 0.0], range: 2.0, color: [0, 228, 48], intensity: 1.0 },
        ]
    );
    assert_eq!(frame.lights().points.len(), 2);
}

/// AAA review WP-15: a point light asking for a cube shadow map reaches the scene's
/// `shadowed_points` by its index among the kept point lights (a dropped one shifts none).
#[test]
fn a_shadow_asking_point_light_is_listed_by_its_kept_index() {
    let mut frame = Frame::default();
    frame.point_light(Vec3::ZERO, 3.0, Color::WHITE, 1.0);
    frame.point_light(Vec3::new(f32::NAN, 0.0, 0.0), 3.0, Color::WHITE, 1.0);
    frame.point_light_with(&genex::render::PointLight::new(Vec3::Y, 4.0, Color::WHITE, 2.0).with_shadow(true));
    let lighting = scene_of(&frame).lighting;
    assert_eq!(lighting.points.len(), 2, "the NaN one is dropped");
    assert_eq!(lighting.shadowed_points, [1]);
    assert_eq!(scene_of(&Frame::default()).lighting.shadowed_points, Vec::<usize>::new());
}

/// Values no light can have: the sun keeps its default direction, a negative or non-finite
/// intensity is dark, and a point light without a finite position or a positive range is dropped.
#[test]
fn hostile_light_values_never_reach_the_renderer() {
    let rows: [(&str, Vec3, f32); 4] = [
        ("NaN direction", Vec3::new(f32::NAN, 1.0, 0.0), 1.0),
        ("zero direction", Vec3::ZERO, 1.0),
        ("infinite intensity", Vec3::Y, f32::INFINITY),
        ("negative intensity", Vec3::Y, -3.0),
    ];
    for (name, direction, intensity) in rows {
        let mut frame = Frame::default();
        frame.sun(direction, Color::WHITE, intensity);
        frame.ambient(Color::WHITE, intensity);
        let lighting = scene_of(&frame).lighting;
        let finite = lighting.sun_dir.iter().all(|c| c.is_finite()) && lighting.sun_dir != [0.0; 3];
        assert!(finite, "{name}: {:?}", lighting.sun_dir);
        assert!(lighting.sun_intensity.is_finite() && lighting.sun_intensity >= 0.0, "{name}");
        assert!(lighting.ambient_intensity.is_finite() && lighting.ambient_intensity >= 0.0, "{name}");
    }
    let mut frame = Frame::default();
    frame.point_light(Vec3::new(f32::NAN, 0.0, 0.0), 2.0, Color::WHITE, 1.0);
    frame.point_light(Vec3::ZERO, 0.0, Color::WHITE, 1.0);
    frame.point_light(Vec3::ZERO, f32::INFINITY, Color::WHITE, 1.0);
    frame.point_light(Vec3::ZERO, 2.0, Color::WHITE, f32::NAN);
    let points = scene_of(&frame).lighting.points;
    assert_eq!(points.len(), 1, "only the light with a finite position and range stays: {points:?}");
    assert_eq!(points[0].intensity, 0.0);
}

#[test]
fn draws_without_a_material_keep_today_s_surface() {
    let mut frame = Frame::default();
    frame.cube(Transform::IDENTITY, Color::RED);
    frame.sphere(Vec3::ZERO, 2.0, Color::rgba(1, 2, 3, 128));
    for draw in &scene_of(&frame).draws {
        assert_eq!((draw.material.metallic, draw.material.roughness), (TODAY_METALLIC, TODAY_ROUGHNESS));
        assert_eq!((draw.material.base_texture, draw.material.normal_texture, draw.material.metal_rough_texture), (None, None, None));
    }
    assert_eq!(Material::default().roughness, TODAY_ROUGHNESS);
    assert_eq!(Material::default().base_color, Color::WHITE);
}

#[test]
fn per_draw_materials_reach_cubes_spheres_and_models() {
    let gold = Material::color(Color::rgb(255, 200, 80)).with_metallic(1.0).with_roughness(0.2);
    let assets = Assets::default();
    let model = assets.model("crate.glb");
    let mut frame = Frame::default();
    frame.cube_with(Transform::IDENTITY, &gold);
    frame.sphere_with(Vec3::ONE, 0.5, &gold);
    frame.model_with(&model, Transform::IDENTITY, &gold);
    assert_eq!(frame.draw_calls(), 3);
    let mut cache = AssetCache::default();
    cache.insert_model("crate.glb", Some(MeshId::from_raw(5)));
    let scene = to_scene(&frame, &Camera::DEFAULT, &cache);
    let meshes: Vec<u32> = scene.draws.iter().map(|d| d.mesh.raw()).collect();
    assert_eq!(meshes, [MeshId::CUBE.raw(), MeshId::SPHERE.raw(), 5]);
    for draw in &scene.draws {
        assert_eq!(draw.material.base_color, [255, 200, 80, 255]);
        assert_eq!((draw.material.metallic, draw.material.roughness), (1.0, 0.2));
    }
}

#[test]
fn a_material_out_of_range_is_clamped_and_a_missing_model_still_draws_the_checker() {
    let wild = Material::color(Color::WHITE).with_metallic(f32::NAN).with_roughness(7.0);
    let assets = Assets::default();
    let mut frame = Frame::default();
    frame.cube_with(Transform::IDENTITY, &wild);
    frame.model_with(&assets.model("absent.glb"), Transform::IDENTITY, &wild);
    let scene = scene_of(&frame);
    assert_eq!((scene.draws[0].material.metallic, scene.draws[0].material.roughness), (TODAY_METALLIC, 1.0));
    assert!(scene.draws[1].material.checker, "a missing model is the checker whatever its material");
}

// ---------------------------------------------------------------------------------------------
// Textures by asset path

/// Asset bytes by path, recording every path asked for.
struct Files {
    files: Vec<(&'static str, Vec<u8>)>,
    asked: RefCell<Vec<String>>,
}

impl ModelSource for Files {
    fn model_bytes(&self, path: &str) -> Option<Vec<u8>> {
        self.asked.borrow_mut().push(path.to_owned());
        self.files.iter().find(|(known, _)| *known == path).map(|(_, bytes)| bytes.clone())
    }
}

/// A renderer stand-in: counts uploads and answers ids in order. `library_uploads` counts what a
/// renderer pays for: one full upload of its mesh library per call.
#[derive(Default)]
struct Counting {
    meshes: u32,
    library_uploads: u32,
    textures: Vec<(u32, u32, TextureKind)>,
}

impl Uploads for Counting {
    fn add_mesh(&mut self, _mesh: MeshData) -> Result<MeshId, RenderError> {
        self.meshes += 1;
        self.library_uploads += 1;
        Ok(MeshId::from_raw(1 + self.meshes))
    }

    fn add_meshes(&mut self, meshes: Vec<MeshData>) -> Result<Vec<MeshId>, RenderError> {
        self.library_uploads += 1;
        let first = self.meshes;
        self.meshes += meshes.len() as u32;
        Ok((first..self.meshes).map(|n| MeshId::from_raw(2 + n)).collect())
    }

    fn add_texture(&mut self, data: &TextureData, kind: TextureKind) -> Result<TextureId, RenderError> {
        let layer = self.textures.iter().filter(|(_, _, known)| *known == kind).count() as u32;
        self.textures.push((data.width(), data.height(), kind));
        Ok(TextureId::new(kind, layer))
    }
}

/// A 2×2 opaque white PNG (stored deflate).
const WHITE_PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x02, 0x00,
    0x00, 0x00, 0x02, 0x08, 0x06, 0x00, 0x00, 0x00, 0x72, 0xb6, 0x0d, 0x24, 0x00, 0x00, 0x00, 0x1d, 0x49, 0x44, 0x41, 0x54, 0x78,
    0x01, 0x01, 0x12, 0x00, 0xed, 0xff, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0x8f, 0x82, 0x0f, 0xf1, 0x6d, 0x9e, 0x54, 0xf2, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42,
    0x60, 0x82,
];

fn load(frame: &Frame, files: &Files, uploads: &mut Counting) -> (AssetCache, Vec<String>) {
    let mut cache = AssetCache::default();
    let mut logged = Vec::new();
    cache.load(frame, files, uploads, &mut |line| logged.push(line.to_owned())).expect("no device loss");
    (cache, logged)
}

#[test]
fn a_material_s_textures_load_once_per_path_and_kind_and_a_missing_one_is_neutral() {
    let files = Files { files: vec![("textures/wood.png", WHITE_PNG.to_vec())], asked: RefCell::default() };
    let wood = Material::color(Color::WHITE).with_base_texture("textures/wood.png").with_metal_rough_texture("textures/wood.png");
    let gone = Material::color(Color::WHITE).with_base_texture("textures/gone.png").with_normal_texture("textures/gone.png", 0.5);
    let mut frame = Frame::default();
    frame.cube_with(Transform::IDENTITY, &wood);
    frame.cube_with(Transform::from_xyz(2.0, 0.0, 0.0), &wood);
    frame.sphere_with(Vec3::ZERO, 1.0, &gone);
    let mut uploads = Counting::default();
    let (mut cache, logged) = load(&frame, &files, &mut uploads);
    assert_eq!(uploads.textures, [(2, 2, TextureKind::Color), (2, 2, TextureKind::Data)], "one upload per path and kind");
    assert_eq!(logged.len(), 1, "the missing texture is named once: {logged:?}");
    cache.load(&frame, &files, &mut uploads, &mut |line| panic!("nothing is retried: {line}")).expect("no device loss");
    let asked = files.asked.borrow().clone();
    let images: Vec<&String> = asked.iter().filter(|path| !path.ends_with(".ktx2")).collect();
    assert_eq!(images, ["textures/wood.png", "textures/gone.png"], "each path is read once, whatever its kinds");
    // C-11: a texture loaded from its image is looked for once in every family (whether the game
    // ships any, for `__render.assetIssues`); a texture that did not load is not.
    let families: Vec<&String> = asked.iter().filter(|path| path.ends_with(".ktx2")).collect();
    assert_eq!(families, ["textures/wood.bc.ktx2", "textures/wood.astc.ktx2", "textures/wood.etc2.ktx2", "textures/wood.rgba8.ktx2"]);

    let scene = to_scene(&frame, &Camera::DEFAULT, &cache);
    let textured = &scene.draws[0].material;
    assert_eq!(textured.base_texture, Some(TextureId::new(TextureKind::Color, 0)));
    assert_eq!(textured.metal_rough_texture, Some(TextureId::new(TextureKind::Data, 0)));
    let neutral = &scene.draws[2].material;
    assert!(!neutral.checker, "a missing texture is neutral, never the checker");
    assert_eq!((neutral.base_texture, neutral.normal_texture), (None, None));
}

/// A material with an untextured colour draws it where its base texture is missing (a fetched
/// texture's procedural stand-in) and its base colour, times the texture, where the texture loads.
#[test]
fn a_missing_base_texture_draws_the_untextured_colour_and_a_loaded_one_the_base_colour() {
    let files = Files { files: vec![("textures/wood.png", WHITE_PNG.to_vec())], asked: RefCell::default() };
    let stand_in = Color::rgb(90, 60, 40);
    let loaded = Material::color(Color::WHITE).with_base_texture("textures/wood.png").with_untextured_color(stand_in);
    let missing = Material::color(Color::WHITE).with_base_texture("fetched/bark.jpg").with_untextured_color(stand_in);
    let plain = Material::color(Color::WHITE).with_base_texture("fetched/bark.jpg");
    let mut frame = Frame::default();
    frame.cube_with(Transform::IDENTITY, &loaded).cube_with(Transform::IDENTITY, &missing).cube_with(Transform::IDENTITY, &plain);
    let mut uploads = Counting::default();
    let (cache, _) = load(&frame, &files, &mut uploads);
    let scene = to_scene(&frame, &Camera::DEFAULT, &cache);
    let colours: Vec<[u8; 4]> = scene.draws.iter().map(|draw| draw.material.base_color).collect();
    assert_eq!(colours, [[255, 255, 255, 255], [90, 60, 40, 255], [255, 255, 255, 255]], "texture loaded, missing with a stand-in, missing without");
    assert_eq!(loaded.untextured_color(), Some(stand_in));
}

/// Texture paths outside `assets/` are never read: the material draws untextured.
#[test]
fn hostile_texture_paths_are_never_read() {
    let files = Files { files: vec![("textures/wood.png", WHITE_PNG.to_vec())], asked: RefCell::default() };
    for path in ["../secret.png", "/etc/passwd", "", "textures\\wood.png", "textures/./wood.png", "textures//wood.png"] {
        let mut frame = Frame::default();
        frame.cube_with(Transform::IDENTITY, &Material::color(Color::WHITE).with_base_texture(path));
        let mut uploads = Counting::default();
        let (cache, _) = load(&frame, &files, &mut uploads);
        assert!(uploads.textures.is_empty(), "{path:?}");
        assert_eq!(to_scene(&frame, &Camera::DEFAULT, &cache).draws[0].material.base_texture, None, "{path:?}");
    }
    assert!(files.asked.borrow().is_empty(), "no hostile path reached the asset source: {:?}", files.asked.borrow());
}

#[test]
fn a_model_loads_once_and_counts_its_triangles() {
    let assets = Assets::default();
    let mut frame = Frame::default();
    frame.model(&assets.model("box.glb"), Transform::IDENTITY);
    frame.model(&assets.model("box.glb"), Transform::from_xyz(1.0, 0.0, 0.0));
    let files = Files { files: vec![("box.glb", Vec::new())], asked: RefCell::default() };
    let mut uploads = Counting::default();
    let (cache, logged) = load(&frame, &files, &mut uploads);
    assert_eq!(uploads.meshes, 0, "an empty file is not a GLB");
    assert_eq!(logged.len(), 1, "{logged:?}");
    assert!(cache.model("box.glb").is_none());
    let scene = to_scene(&frame, &Camera::DEFAULT, &cache);
    assert!(scene.draws.iter().all(|d| d.material.checker && d.mesh == MeshId::CUBE));
    assert_eq!(CUBE_TRIANGLES, 12);
}

/// A GLB of one triangle drawn once per material of `materials` (each a base-colour factor).
fn multi_material_glb(materials: &[[f32; 4]]) -> Vec<u8> {
    let positions: [f32; 9] = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
    let indices: [u16; 3] = [0, 1, 2];
    let mut bin: Vec<u8> = positions.iter().flat_map(|f| f.to_le_bytes()).collect();
    bin.extend(indices.iter().flat_map(|i| i.to_le_bytes()));
    bin.extend([0u8, 0]);
    let primitives: Vec<serde_json::Value> =
        (0..materials.len()).map(|m| serde_json::json!({ "attributes": { "POSITION": 0 }, "indices": 1, "material": m })).collect();
    let rows: Vec<serde_json::Value> = materials.iter().map(|c| serde_json::json!({ "pbrMetallicRoughness": { "baseColorFactor": c } })).collect();
    let gltf = serde_json::json!({
        "asset": { "version": "2.0" },
        "buffers": [{ "byteLength": bin.len() }],
        "bufferViews": [{ "buffer": 0, "byteOffset": 0, "byteLength": 36 }, { "buffer": 0, "byteOffset": 36, "byteLength": 6 }],
        "accessors": [
            { "bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3", "min": [0.0, 0.0, 0.0], "max": [1.0, 1.0, 0.0] },
            { "bufferView": 1, "componentType": 5123, "count": 3, "type": "SCALAR" },
        ],
        "meshes": [{ "primitives": primitives }],
        "nodes": [{ "mesh": 0 }],
        "scenes": [{ "nodes": [0] }],
        "scene": 0,
        "materials": rows,
    });
    let mut json = serde_json::to_vec(&gltf).expect("json");
    while !json.len().is_multiple_of(4) {
        json.push(b' ');
    }
    let mut out = Vec::new();
    out.extend(b"glTF");
    out.extend(2u32.to_le_bytes());
    out.extend(((12 + 8 + json.len() + 8 + bin.len()) as u32).to_le_bytes());
    out.extend((json.len() as u32).to_le_bytes());
    out.extend(b"JSON");
    out.extend(&json);
    out.extend((bin.len() as u32).to_le_bytes());
    out.extend(b"BIN\0");
    out.extend(&bin);
    out
}

#[test]
fn a_model_with_many_materials_uploads_the_mesh_library_once() {
    let assets = Assets::default();
    let glb = multi_material_glb(&[[1.0, 0.0, 0.0, 1.0], [0.0, 1.0, 0.0, 1.0], [0.0, 0.0, 1.0, 1.0], [1.0, 1.0, 0.0, 1.0]]);
    let files = Files { files: vec![("parts.glb", glb)], asked: RefCell::default() };
    let mut frame = Frame::default();
    frame.model(&assets.model("parts.glb"), Transform::IDENTITY);
    let mut uploads = Counting::default();
    let (cache, logged) = load(&frame, &files, &mut uploads);
    assert!(logged.is_empty(), "{logged:?}");
    let model = cache.model("parts.glb").expect("loaded");
    assert_eq!((model.parts.len(), uploads.meshes), (4, 4), "a part per material");
    assert_eq!(uploads.library_uploads, 1, "the four parts share one library upload");
}

// ---------------------------------------------------------------------------------------------
// Spot lights and emissive materials (RQ6.6)

/// The renderer's spot light for a facade spot of the default cone.
fn default_spot(position: [f32; 3], direction: [f32; 3], range: f32, color: [u8; 3], intensity: f32) -> genex_render::lights::SpotLight {
    genex_render::lights::SpotLight {
        position,
        direction,
        range,
        color,
        intensity,
        inner_angle: genex::render::DEFAULT_SPOT_INNER_DEGREES.to_radians(),
        outer_angle: genex::render::DEFAULT_SPOT_OUTER_DEGREES.to_radians(),
        shadow: false,
    }
}

#[test]
fn spot_lights_reach_the_scene_in_call_order_beside_the_point_lights_and_are_not_draws() {
    use genex::render::SpotLight;
    let mut frame = Frame::default();
    frame.point_light(Vec3::new(0.0, 2.0, 0.0), 4.0, Color::WHITE, 1.0);
    frame.spot_light(Vec3::new(1.0, 3.0, 0.0), Vec3::new(0.0, -1.0, 0.0), 6.0, Color::rgb(255, 180, 90), 5.0);
    let narrow = SpotLight::new(Vec3::new(-2.0, 1.0, 4.0), Vec3::new(0.0, 0.0, -1.0), 9.0, Color::BLUE, 2.0).with_cone_degrees(10.0, 15.0).with_shadow(true);
    frame.spot_light_with(&narrow);
    assert_eq!(frame.draw_calls(), 0, "lights are not draws");
    assert_eq!(frame.lights().spots.len(), 2);
    let lighting = scene_of(&frame).lighting;
    assert_eq!(lighting.points.len(), 1, "the point light stays a point light");
    let narrow_row = genex_render::lights::SpotLight {
        inner_angle: 10f32.to_radians(),
        outer_angle: 15f32.to_radians(),
        shadow: true,
        ..default_spot([-2.0, 1.0, 4.0], [0.0, 0.0, -1.0], 9.0, [0, 121, 241], 2.0)
    };
    assert_eq!(lighting.spots, [default_spot([1.0, 3.0, 0.0], [0.0, -1.0, 0.0], 6.0, [255, 180, 90], 5.0), narrow_row]);
}

/// Values no spot light can have: one without a finite position or a positive finite range is
/// dropped, a direction that is zero or not finite points down, an intensity that is negative or not
/// finite is dark, and a cone that is not finite takes the default.
#[test]
fn hostile_spot_values_never_reach_the_renderer() {
    use genex::render::SpotLight;
    let mut frame = Frame::default();
    frame.spot_light(Vec3::new(f32::NAN, 0.0, 0.0), Vec3::NEG_Y, 2.0, Color::WHITE, 1.0);
    frame.spot_light(Vec3::ZERO, Vec3::NEG_Y, 0.0, Color::WHITE, 1.0);
    frame.spot_light(Vec3::ZERO, Vec3::NEG_Y, f32::INFINITY, Color::WHITE, 1.0);
    frame.spot_light(Vec3::ZERO, Vec3::new(f32::NAN, 1.0, 0.0), 2.0, Color::WHITE, f32::NAN);
    frame.spot_light(Vec3::ZERO, Vec3::ZERO, 2.0, Color::WHITE, -4.0);
    frame.spot_light_with(&SpotLight::new(Vec3::ZERO, Vec3::X, 2.0, Color::WHITE, 1.0).with_cone_degrees(f32::NAN, f32::INFINITY));
    let spots = scene_of(&frame).lighting.spots;
    assert_eq!(spots.len(), 3, "only the spots with a finite position and range stay: {spots:?}");
    for spot in &spots[..2] {
        assert_eq!((spot.direction, spot.intensity), ([0.0, -1.0, 0.0], 0.0), "{spot:?}");
    }
    let cone = (spots[2].inner_angle, spots[2].outer_angle);
    assert_eq!(cone, (genex::render::DEFAULT_SPOT_INNER_DEGREES.to_radians(), genex::render::DEFAULT_SPOT_OUTER_DEGREES.to_radians()));
}

#[test]
fn an_emissive_material_reaches_the_draw_in_scene_units_and_a_plain_one_emits_nothing() {
    use genex_render::texture::srgb_to_linear;
    let ember = Material::emissive(Color::rgb(255, 160, 64), 6.0);
    let pane = Material::color(Color::rgb(40, 30, 20)).with_emissive(Color::WHITE, 2.5);
    let mut frame = Frame::default();
    frame.cube_with(Transform::IDENTITY, &ember);
    frame.sphere_with(Vec3::ONE, 0.5, &pane);
    frame.cube(Transform::IDENTITY, Color::RED);
    let scene = scene_of(&frame);
    let glow = &scene.draws[0].material;
    assert_eq!(glow.base_color, [255, 160, 64, 255], "Material::emissive glows in its own colour");
    assert_eq!(glow.emissive_radiance(), [255u8, 160, 64].map(|c| srgb_to_linear(c) * 6.0));
    assert_eq!(scene.draws[1].material.emissive_radiance(), [2.5; 3]);
    assert_eq!(scene.draws[1].material.base_color, [40, 30, 20, 255], "the base colour is the material's own");
    assert!(!scene.draws[2].material.is_emissive(), "a draw that names no emission emits nothing");
    assert_eq!(Material::default().with_emissive_texture("textures/glow.png").emissive_texture(), Some("textures/glow.png"));
}

#[test]
fn hostile_emissive_strengths_are_dark() {
    for strength in [f32::NAN, f32::INFINITY, -3.0] {
        let mut frame = Frame::default();
        frame.cube_with(Transform::IDENTITY, &Material::emissive(Color::WHITE, strength));
        let material = scene_of(&frame).draws[0].material;
        assert!(!material.is_emissive(), "{strength}: {:?}", material.emissive_radiance());
    }
}

#[test]
fn an_emissive_texture_loads_as_a_colour_texture_and_masks_the_emission() {
    let files = Files { files: vec![("textures/glow.png", WHITE_PNG.to_vec())], asked: RefCell::default() };
    let glow = Material::emissive(Color::rgb(255, 200, 120), 3.0).with_emissive_texture("textures/glow.png");
    let mut frame = Frame::default();
    frame.cube_with(Transform::IDENTITY, &glow);
    let mut uploads = Counting::default();
    let (cache, logged) = load(&frame, &files, &mut uploads);
    assert!(logged.is_empty(), "{logged:?}");
    assert_eq!(uploads.textures, [(2, 2, TextureKind::Color)], "an emissive map is sRGB colour");
    let scene = to_scene(&frame, &Camera::DEFAULT, &cache);
    assert_eq!(scene.draws[0].material.emissive_texture, Some(TextureId::new(TextureKind::Color, 0)));
}

/// The GPU rows: a v2 material shaded by `gx_shade_pbr` under a spot light, against the built-in
/// surface of the same colour, roughness and metallic under the same spot (RQ6.6).
///
///   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex \
///     --offline --locked --test frame_lighting -- --ignored metal
mod gpu {
    use std::path::PathBuf;

    use genex::present::Presenter;
    use genex::prelude::*;
    use genex::render::{Exposure, QualityPreset, RenderConfig};
    use genex::{CustomMaterial, FIXED_STEP_MS, Runtime, View};

    const WORLD: [u32; 2] = [128, 96];
    /// The sphere's sRGB colour (the v2 material reads it as its draw tint).
    const ALBEDO: Color = Color::rgb(200, 170, 140);
    const RADIUS: f32 = 1.0;
    /// A channel of a sphere pixel may differ by this many 8-bit levels between the two shadings.
    const CHANNEL_TOLERANCE: u8 = 3;
    /// Pixels past the tolerance allowed (rasterization along the silhouette and the cone's edge).
    const OUTLIER_PIXELS: usize = 24;

    /// v2: the draw's (linear) tint as a dielectric of the built-in roughness, shaded by
    /// `gx_shade_pbr`: what the built-in `Material::color(ALBEDO)` writes.
    const SHADE_V2: &str = "@fragment fn fs_material(in: GxMaterialInV2) -> @location(0) vec4<f32> {\n\
        let s = gx_surface_v2(in.world_position, in.normal, in.tint.rgb, 0.0, 0.55);\n\
        return vec4<f32>(gx_shade_pbr(s), 1.0);\n\
    }\n";

    #[derive(Default)]
    struct World {
        material: CustomMaterial,
    }

    fn folder() -> PathBuf {
        let root = std::env::temp_dir().join(format!("genex-frame-lighting-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("shaders")).expect("game folder");
        let toml = "[game]\ntitle = \"Spot\"\n\n[[wgsl]]\npath = \"shaders/shade.wgsl\"\nkind = \"material\"\napi = 2\n";
        std::fs::write(root.join("genex.toml"), toml).expect("genex.toml");
        std::fs::write(root.join("shaders/shade.wgsl"), SHADE_V2).expect("source");
        root
    }

    /// The sphere in the dark, lit only by a spot from above and in front whose cone covers part
    /// of it, drawn by the built-in surface or by the v2 material.
    fn runtime(root: &std::path::Path, v2: bool) -> Runtime<World> {
        let mut game = Game::new(World::default()).title("Spot").world_size(WORLD[0], WORLD[1]);
        game.wgsl_root(root);
        game.render_settings(RenderConfig::new().preset(QualityPreset::High).exposure(Exposure::manual(0.0)));
        game.on_reset(|sim, _seed, _rng, gfx| sim.world.material = gfx.material("shaders/shade.wgsl", &[]));
        game.camera(|_| Camera::look_at(vec3(0.0, 0.0, 3.2), Vec3::ZERO));
        game.on_draw(move |sim, frame, _| {
            frame.clear(Color::BLACK).sun(Vec3::Y, Color::WHITE, 0.0).ambient(Color::BLACK, 0.0);
            frame.spot_light(vec3(0.6, 1.6, 1.8), vec3(-0.3, -0.8, -1.0), 6.0, Color::rgb(255, 210, 160), 8.0);
            if v2 {
                frame.custom(CustomMesh::Sphere, Transform::IDENTITY.with_scale(Vec3::splat(RADIUS)), &sim.world.material, ALBEDO);
            } else {
                frame.sphere(Vec3::ZERO, RADIUS, ALBEDO);
            }
        });
        let mut runtime = Runtime::new(game).expect("valid registrations");
        runtime.seed(7);
        runtime.start();
        runtime.step(5.0 * FIXED_STEP_MS);
        runtime
    }

    fn presenter() -> Option<Presenter> {
        let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
        match Presenter::open_with_root(WORLD, &[], None) {
            Ok(presenter) => Some(presenter),
            Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
            Err(_) => None,
        }
    }

    /// The capture of `runtime`'s game view, BGRA, top row first.
    fn capture(runtime: &mut Runtime<World>) -> Option<Vec<u8>> {
        let mut presenter = presenter()?;
        presenter.set_capturing(true);
        presenter.draw_view(runtime, View::Game).expect("game view").expect("drawn");
        assert_eq!(presenter.failure(), None);
        Some(presenter.resilient.capture().expect("capture").bgra().to_vec())
    }

    fn lit(pixel: &[u8]) -> bool {
        pixel[..3].iter().any(|channel| *channel > 8)
    }

    #[test]
    #[ignore = "needs a GPU: run with --ignored metal"]
    fn metal_a_v2_material_lit_by_a_spot_matches_the_built_in_surface() {
        let root = folder();
        let mut built_in = runtime(&root, false);
        let mut custom = runtime(&root, true);
        assert_eq!(custom.sim().world.material.refusal(), None);
        let Some(reference) = capture(&mut built_in) else { return };
        let shaded = capture(&mut custom).expect("a presenter");
        let lit_pixels = reference.chunks(4).filter(|pixel| lit(pixel)).count();
        let pixels = (WORLD[0] * WORLD[1]) as usize;
        assert!(lit_pixels > 400, "the spot lights the sphere ({lit_pixels} pixels)");
        assert!(lit_pixels < pixels / 3, "the cone leaves most of the frame dark ({lit_pixels} of {pixels})");
        let over: Vec<(usize, &[u8], &[u8])> = reference
            .chunks(4)
            .zip(shaded.chunks(4))
            .enumerate()
            .filter(|(_, (a, b))| (0..3).any(|c| a[c].abs_diff(b[c]) > CHANNEL_TOLERANCE))
            .map(|(i, (a, b))| (i, a, b))
            .collect();
        assert!(over.len() <= OUTLIER_PIXELS, "{} pixels of the v2 material differ from the built-in surface under the spot: {:?}", over.len(), &over[..over.len().min(8)]);
        let _ = std::fs::remove_dir_all(&root);
    }
}

// Subsurface scattering and diffuse transmission (renderer pass 2 B.1)

#[test]
fn a_translucent_material_reaches_the_draw_and_an_opaque_one_lets_nothing_through() {
    use genex::Subsurface;
    let wax = Material::color(Color::rgb(235, 225, 205)).with_subsurface(Subsurface::WAX);
    let leaf = Material::color(Color::rgb(90, 150, 50)).with_subsurface(Subsurface::LEAF.with_transmission(0.4));
    let mut frame = Frame::default();
    frame.sphere_with(Vec3::ZERO, 0.05, &wax);
    frame.cube_with(Transform::IDENTITY, &leaf);
    frame.cube(Transform::IDENTITY, Color::RED);
    let scene = scene_of(&frame);
    assert_eq!(scene.draws[0].material.subsurface, Some(Subsurface::WAX), "the wax's scattering reaches its draw");
    assert_eq!(scene.draws[1].material.subsurface.map(|s| s.transmission), Some(0.4));
    assert_eq!(scene.draws[2].material.subsurface, None, "a draw that names no scattering lets nothing through");
    assert_eq!(wax.subsurface(), Some(Subsurface::WAX));
}
