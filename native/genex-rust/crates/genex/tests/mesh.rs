//! Meshes a game builds at reset (Bodycam B2c, `gfx.mesh`): every hostile mesh is refused with its
//! typed code and makes nothing; the same data builds the same bytes and path; a drawn built mesh
//! loads from the handle with no file in the game's assets, draws with a material, and its
//! triangles reach the sim. CPU only.

use std::cell::RefCell;

use genex::present::{AssetCache, ModelSource, Uploads, drawn_of};
use genex::prelude::*;
use genex::{MESH_PATH_PREFIX, MESH_TRIANGLES_MAX, MESH_VERTICES_MAX, MeshErrorCode, Runtime, View};
use genex_render::RenderError;
use genex_render::device_loss::ModelParts;
use genex_render::mesh::GlbModel;
use genex_render::scene::MeshId;
use genex_render::texture::{TextureData, TextureId, TextureKind};

/// A game's files: none, recording every path asked for.
#[derive(Default)]
struct NoFiles {
    read: RefCell<Vec<String>>,
}

impl ModelSource for NoFiles {
    fn model_bytes(&self, path: &str) -> Option<Vec<u8>> {
        self.read.borrow_mut().push(path.to_owned());
        None
    }
}

/// A renderer stand-in that keeps every model's parts as uploaded.
#[derive(Default)]
struct Recording {
    models: Vec<ModelParts>,
    meshes: u32,
}

impl Uploads for Recording {
    fn add_mesh(&mut self, _mesh: genex_render::mesh::MeshData) -> Result<MeshId, RenderError> {
        self.meshes += 1;
        Ok(MeshId::from_raw(1 + self.meshes))
    }

    fn add_model_parts(&mut self, parts: ModelParts) -> Result<Vec<MeshId>, RenderError> {
        let ids = parts
            .iter()
            .map(|_| {
                self.meshes += 1;
                MeshId::from_raw(1 + self.meshes)
            })
            .collect();
        self.models.push(parts);
        Ok(ids)
    }

    fn add_texture(&mut self, _data: &TextureData, kind: TextureKind) -> Result<TextureId, RenderError> {
        Ok(TextureId::new(kind, 0))
    }
}

/// A 2 x 3 m wall with a 1 x 1.2 m window hole, as four boxes 0.25 m deep.
fn wall_with_window() -> MeshData {
    let mut wall = MeshData::new();
    wall.cuboid(vec3(-1.0, 0.0, 0.0), vec3(-0.5, 3.0, 0.25), 1.0)
        .cuboid(vec3(0.5, 0.0, 0.0), vec3(1.0, 3.0, 0.25), 1.0)
        .cuboid(vec3(-0.5, 0.0, 0.0), vec3(0.5, 0.9, 0.25), 1.0)
        .cuboid(vec3(-0.5, 2.1, 0.0), vec3(0.5, 3.0, 0.25), 1.0);
    wall
}

/// A triangle with only positions and indices (normals and UVs to fill).
fn bare_triangle() -> MeshData {
    MeshData { positions: vec![Vec3::ZERO, Vec3::X, Vec3::Y], indices: vec![0, 1, 2], ..MeshData::default() }
}

#[test]
fn every_hostile_mesh_is_refused_with_its_code_and_makes_nothing() {
    let base = bare_triangle();
    let too_many = MeshData { positions: vec![Vec3::ZERO; MESH_VERTICES_MAX + 1], indices: vec![0, 1, 2], ..MeshData::default() };
    let too_many_triangles = MeshData { positions: vec![Vec3::ZERO; 3], indices: vec![0; 3 * (MESH_TRIANGLES_MAX + 1)], ..MeshData::default() };
    let table: Vec<(&str, MeshData, MeshErrorCode)> = vec![
        ("nothing", MeshData::new(), MeshErrorCode::Empty),
        ("no triangles", MeshData { indices: Vec::new(), ..base.clone() }, MeshErrorCode::Empty),
        ("no positions", MeshData { positions: Vec::new(), ..base.clone() }, MeshErrorCode::Empty),
        ("two indices", MeshData { indices: vec![0, 1], ..base.clone() }, MeshErrorCode::NotTriangles),
        ("index past the end", MeshData { indices: vec![0, 1, 3], ..base.clone() }, MeshErrorCode::IndexOutOfRange),
        ("u32::MAX index", MeshData { indices: vec![0, 1, u32::MAX], ..base.clone() }, MeshErrorCode::IndexOutOfRange),
        ("two normals", MeshData { normals: vec![Vec3::Z; 2], ..base.clone() }, MeshErrorCode::AttributeMismatch),
        ("four uvs", MeshData { uvs: vec![Vec2::ZERO; 4], ..base.clone() }, MeshErrorCode::AttributeMismatch),
        ("a NaN position", MeshData { positions: vec![Vec3::ZERO, Vec3::NAN, Vec3::Y], ..base.clone() }, MeshErrorCode::NotFinite),
        ("an infinite normal", MeshData { normals: vec![Vec3::Z, Vec3::Z, Vec3::INFINITY], ..base.clone() }, MeshErrorCode::NotFinite),
        ("a NaN uv", MeshData { uvs: vec![Vec2::ZERO, Vec2::NAN, Vec2::ONE], ..base.clone() }, MeshErrorCode::NotFinite),
        ("too many vertices", too_many, MeshErrorCode::TooLarge),
        ("too many triangles", too_many_triangles, MeshErrorCode::TooLarge),
    ];
    for (name, data, code) in table {
        let error = data.check().expect_err(name);
        assert_eq!(error.code, code, "{name}: {error}");
        assert!(error.to_string().starts_with(code.wire()), "{name}: {error}");
        assert_eq!(data.to_glb().map(|_| ()), Err(error), "{name}: nothing is built");
    }
}

#[test]
fn mesh_refusal_codes_keep_their_wire_spellings() {
    let wire: Vec<&str> = MeshErrorCode::ALL.iter().map(|code| code.wire()).collect();
    assert_eq!(wire, ["mesh-empty", "mesh-not-triangles", "mesh-index-out-of-range", "mesh-attribute-mismatch", "mesh-not-finite", "mesh-too-large"]);
}

#[test]
fn the_same_data_builds_the_same_glb_and_the_renderer_reads_it_with_filled_attributes() {
    let wall = wall_with_window();
    let glb = wall.to_glb().expect("a wall");
    assert_eq!(wall.clone().to_glb().expect("again"), glb, "a pure function of the data");
    let model = GlbModel::from_glb(&glb).expect("the renderer reads the GLB it builds");
    let [part] = model.parts() else { panic!("one part") };
    assert_eq!(part.mesh.indices.len(), 4 * 36, "four boxes of twelve triangles");
    let material = part.material.expect("its own material");
    assert_eq!((material.metallic, material.roughness), (0.0, 0.55), "the facade's default surface, not glTF's metal");
    // The front face of the left pillar (+z): UVs in metres, v down, tangent along +x with w -1.
    let front = part.mesh.vertices.iter().find(|v| v.normal == [0.0, 0.0, 1.0] && v.position == [-1.0, 3.0, 0.25]).expect("its top left");
    assert_eq!(front.uv, [0.0, 0.0]);
    let bottom_right = part.mesh.vertices.iter().find(|v| v.normal == [0.0, 0.0, 1.0] && v.position == [-0.5, 0.0, 0.25]).expect("its bottom right");
    assert_eq!(bottom_right.uv, [0.5, 3.0], "half a metre across, three down");
    let along_x = front.tangent.iter().zip([1.0, 0.0, 0.0, -1.0]).all(|(got, want)| (got - want).abs() < 1.0e-6);
    assert!(along_x, "tangent along +x with the renderer's cube handedness: {:?}", front.tangent);
    // Only positions: unit normals from the triangle, box-projected UVs.
    let filled = GlbModel::from_glb(&bare_triangle().to_glb().expect("a triangle")).expect("read");
    for vertex in &filled.parts()[0].mesh.vertices {
        assert_eq!(vertex.normal, [0.0, 0.0, 1.0]);
        assert_eq!(vertex.uv, [vertex.position[0], -vertex.position[1]], "a wall facing +z: u along x, v down");
    }
}

#[derive(Default)]
struct Room {
    wall: Option<Model>,
    refused: Option<String>,
    triangles: usize,
}

fn room_game() -> Game<Room> {
    let mut game = Game::new(Room::default()).title("Room");
    game.on_reset(|sim, _, _, gfx| {
        let wall = gfx.mesh(&wall_with_window()).expect("a wall");
        sim.world.triangles = gfx.assets().triangles(&wall).map_or(0, |triangles| triangles.triangle_count());
        sim.world.refused = gfx.mesh(&MeshData::new()).err().map(|error| error.code.wire().to_owned());
        sim.world.wall = Some(wall);
    });
    game.on_draw(|sim, frame, _| {
        if let Some(wall) = &sim.world.wall {
            let plaster = Material::color(Color::rgb(200, 190, 170)).with_world_uv(2.0);
            frame.model_with(wall, Transform::IDENTITY, &plaster);
        }
    });
    game
}

#[test]
fn a_built_mesh_loads_from_its_handle_draws_with_a_material_and_reaches_the_sim() {
    let mut rt = Runtime::new(room_game()).expect("installs");
    rt.seed(1);
    let frame = rt.frame(View::Game).expect("the game's view");
    let files = NoFiles::default();
    let (mut cache, mut uploads, mut lines) = (AssetCache::default(), Recording::default(), Vec::new());
    cache.load(&frame, &files, &mut uploads, &mut |line| lines.push(line.to_owned())).expect("no device loss");
    assert_eq!(uploads.models.len(), 1, "the wall's parts were uploaded ({lines:?})");
    assert!(files.read.borrow().iter().all(|path| !path.starts_with(MESH_PATH_PREFIX)), "the asset source is never asked for it");
    let camera = Camera::look_at(vec3(0.0, 1.5, 6.0), vec3(0.0, 1.5, 0.0));
    assert!(drawn_of(&frame, &camera, &cache).missing_models.is_empty(), "drawn, not the checker");
    let room = &rt.sim().world;
    assert_eq!(room.triangles, 4 * 12, "gfx.assets().triangles reads it at reset");
    assert_eq!(room.refused.as_deref(), Some("mesh-empty"));
    // A re-seed builds the same model: the same path, so nothing loads again.
    let path = |rt: &Runtime<Room>| rt.sim().world.wall.as_ref().and_then(|wall| wall.path().map(str::to_owned));
    let first = path(&rt);
    rt.seed(2);
    assert_eq!(path(&rt), first);
    assert!(first.is_some_and(|path| path.starts_with(MESH_PATH_PREFIX)));
}
