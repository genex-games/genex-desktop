//! The Content Library (`docs/api/library.md`): pre-processed CC0 materials, skies, models and trees
//! that Studio's `library__add` delivers into `assets/library/<folder>/`, each folder holding an
//! `entry.json` of facts beside its files. `gfx.assets().library(id)` reads those facts at reset
//! and answers a [`LibraryAsset`] that hands out what the game draws: a [`Material`] at the
//! texture's real size, an HDRI [`Environment`], or a [`Model`] in metres with its impostor.
//!
//! The folder of an entry is [`library_folder`] of its id, the same name the plugin delivers to
//! (`src/shared/genex-library.ts` `libraryFolder`; both tests hold the same vectors).

use serde::Deserialize;
use std::collections::BTreeMap;
use std::sync::Arc;

use crate::frame::{Color, Material};
use crate::gfx::{AssetError, AssetErrorCode, Assets, Model};
use crate::lod::Impostor;
use crate::math::Vec3;
use crate::render::Environment;

/// The folder under `assets/` that library deliveries land in.
pub const LIBRARY_ASSET_FOLDER: &str = "library";
/// The facts file every delivered entry carries.
pub const LIBRARY_ENTRY_FILE: &str = "entry.json";
/// The `entry.json` format this runtime reads.
pub const LIBRARY_ENTRY_SCHEMA: u32 = 1;
/// The longest slug an id may have (`<kind>/<slug>`).
const SLUG_MAX: usize = 48;
/// The tiers a material or sky may carry, largest first: the largest the game shipped wins.
const TIERS_LARGEST_FIRST: [&str; 3] = ["4k", "2k", "1k"];
/// How strongly a library normal map tilts the normal (as authored).
const NORMAL_SCALE: f32 = 1.0;

/// What a library entry is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum LibraryKind {
    /// A tiling PBR surface: albedo, normal and ORM maps.
    Material,
    /// An equirectangular HDRI that lights and backs the scene.
    Sky,
    /// A prop, rock or structure: one GLB in metres within its triangle budget.
    Model,
    /// A tree or plant from the generator: its members drawn as one.
    Vegetation,
}

impl LibraryKind {
    /// Every kind, in declaration order.
    pub const ALL: [LibraryKind; 4] = [LibraryKind::Material, LibraryKind::Sky, LibraryKind::Model, LibraryKind::Vegetation];

    /// The kind's wire spelling (the first segment of an id).
    pub const fn wire(self) -> &'static str {
        match self {
            LibraryKind::Material => "material",
            LibraryKind::Sky => "sky",
            LibraryKind::Model => "model",
            LibraryKind::Vegetation => "vegetation",
        }
    }

    /// The kind spelled `wire`, if any.
    pub fn from_wire(wire: &str) -> Option<LibraryKind> {
        LibraryKind::ALL.into_iter().find(|kind| kind.wire() == wire)
    }
}

/// A material's maps at one tier, as `entry.json` names them.
#[derive(Clone, Debug, Deserialize)]
struct MaterialMaps {
    albedo: String,
    normal: String,
    orm: String,
}

/// `entry.json`, as the pack build writes it (`LibraryEntryFacts` in `src/shared/genex-library.ts`).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EntryFacts {
    schema: u32,
    id: String,
    kind: String,
    name: String,
    #[serde(default)]
    tags: Vec<String>,
    licence: String,
    size: [f32; 3],
    #[serde(default)]
    maps: BTreeMap<String, MaterialMaps>,
    base_color: Option<[u8; 3]>,
    #[serde(default)]
    hdri: BTreeMap<String, String>,
    #[serde(default)]
    members: Vec<String>,
    triangles: Option<u32>,
    #[serde(default)]
    impostor: bool,
}

/// One library entry a game added, read at reset: its facts and the handles it draws with.
/// Cloning one is cheap; keep it (or what it hands out) in the world.
#[derive(Clone, Debug)]
pub struct LibraryAsset {
    inner: Arc<Inner>,
}

#[derive(Debug)]
struct Inner {
    id: String,
    kind: LibraryKind,
    name: String,
    tags: Vec<String>,
    licence: String,
    size: Vec3,
    tier: Option<String>,
    triangles: Option<u32>,
    material: Option<Material>,
    environment: Option<Environment>,
    model: Option<Model>,
}

impl LibraryAsset {
    /// Its id, `<kind>/<slug>`.
    pub fn id(&self) -> &str {
        &self.inner.id
    }

    /// What it is.
    pub fn kind(&self) -> LibraryKind {
        self.inner.kind
    }

    /// Its display name (`Asphalt 01`).
    pub fn name(&self) -> &str {
        &self.inner.name
    }

    /// Its search tags.
    pub fn tags(&self) -> &[String] {
        &self.inner.tags
    }

    /// Its licence: always `CC0-1.0`.
    pub fn licence(&self) -> &str {
        &self.inner.licence
    }

    /// Its real size in metres: a model's bounding box (x, y height, z), a material's tile
    /// (one texture repeat, x and y; z 0), zero for a sky.
    pub fn size(&self) -> Vec3 {
        self.inner.size
    }

    /// One texture repeat of a material in metres (the size's x); 0 for any other kind.
    pub fn tile_metres(&self) -> f32 {
        if self.inner.kind == LibraryKind::Material { self.inner.size.x } else { 0.0 }
    }

    /// The tier the game shipped and this asset draws (`2k`, `4k`, `1k`); `None` for a model.
    pub fn tier(&self) -> Option<&str> {
        self.inner.tier.as_deref()
    }

    /// A model's or tree's LOD0 triangles; `None` for a material or sky.
    pub fn triangles(&self) -> Option<u32> {
        self.inner.triangles
    }

    /// A material entry's surface: its albedo, normal and ORM maps, metallic and roughness taken
    /// from the ORM map as they are, repeating at its real tile size in world space
    /// ([`Material::with_world_uv`]) and drawing its mean colour where no texture loads. Give a
    /// model's own UVs [`Material::with_uv_scale`] instead. Any other kind answers
    /// [`Material::default`].
    pub fn material(&self) -> Material {
        self.inner.material.clone().unwrap_or_default()
    }

    /// A sky entry's HDRI environment (`frame.environment(..)`); tune it with
    /// `Environment::Hdri(HdriEnvironment::new(path).with_intensity(..))` from its path. Any
    /// other kind answers the physical sky, [`Environment::sky`].
    pub fn environment(&self) -> Environment {
        self.inner.environment.clone().unwrap_or_else(Environment::sky)
    }

    /// A model or vegetation entry's model: its GLB in metres with its levels baked in, its
    /// members drawn as one ([`Assets::compound`]) and, for rocks, vehicles, structures and trees,
    /// an impostor past its last level. Any other kind answers a missing model (the checker).
    pub fn model(&self) -> Model {
        self.inner.model.clone().unwrap_or_default()
    }
}

/// The delivery folder of entry `id` under `assets/library/`: the UUID-shaped name made from two
/// FNV-1a 64 digests of the id that Studio's `library__add` delivers to.
pub fn library_folder(id: &str) -> String {
    let first = genex_core::digest::fnv1a64(format!("genex-library\n{id}").as_bytes());
    let second = genex_core::digest::fnv1a64(format!("folder\n{id}").as_bytes());
    let hex = format!("{first:016x}{second:016x}");
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}

/// Whether `id` is `<kind>/<slug>` with a known kind and a slug of `a-z`, `0-9` and `_`.
fn is_library_id(id: &str) -> bool {
    let Some((kind, slug)) = id.split_once('/') else { return false };
    let slug_ok = !slug.is_empty() && slug.len() <= SLUG_MAX && slug.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_');
    LibraryKind::from_wire(kind).is_some() && slug_ok
}

/// A `malformed` refusal of `id`'s facts.
fn malformed(id: &str, detail: &str) -> AssetError {
    AssetError::new(AssetErrorCode::Malformed, format!("library entry {id}: {detail}"))
}

impl Assets {
    /// The Content Library entry `id` (`material/asphalt_01`, `model/painted_wooden_bench`), read
    /// from the `entry.json` Studio's `library__add` delivered, in `on_reset` like
    /// [`Assets::bytes`] (and under its refusals). Refused `unsafe-path` for an id that is not
    /// `<kind>/<slug>`, `missing` for an entry this game has not added (call `library__add`), and
    /// `malformed` for facts this runtime does not read or that name another entry.
    pub fn library(&self, id: &str) -> Result<LibraryAsset, AssetError> {
        if !is_library_id(id) {
            return Err(AssetError::new(AssetErrorCode::UnsafePath, format!("library id {id:?} is not <kind>/<slug>")));
        }
        let folder = format!("{LIBRARY_ASSET_FOLDER}/{}", library_folder(id));
        let bytes = self.bytes(&format!("{folder}/{LIBRARY_ENTRY_FILE}")).map_err(|error| match error.code() {
            AssetErrorCode::Missing => AssetError::new(AssetErrorCode::Missing, format!("library entry {id} was not added to this game: call library__add {id}")),
            _ => error,
        })?;
        let facts: EntryFacts = serde_json::from_slice(&bytes).map_err(|error| malformed(id, &error.to_string()))?;
        let kind = LibraryKind::from_wire(&facts.kind).ok_or_else(|| malformed(id, "an unknown kind"))?;
        if facts.schema != LIBRARY_ENTRY_SCHEMA || facts.id != id {
            return Err(malformed(id, "facts of another schema or entry"));
        }
        Ok(self.library_asset(&folder, kind, facts))
    }

    /// The handles of an entry whose facts read: each from the largest tier the game shipped.
    fn library_asset(&self, folder: &str, kind: LibraryKind, facts: EntryFacts) -> LibraryAsset {
        let shipped = |file: &str| self.info(&format!("{folder}/{file}")).is_some();
        let mut tier = None;
        let mut material = None;
        let mut environment = None;
        let mut model = None;
        match kind {
            LibraryKind::Material => {
                tier = TIERS_LARGEST_FIRST.into_iter().find(|tier| facts.maps.get(*tier).is_some_and(|maps| shipped(&maps.albedo)));
                material = tier.and_then(|tier| facts.maps.get(tier)).map(|maps| library_material(folder, maps, &facts));
            }
            LibraryKind::Sky => {
                tier = TIERS_LARGEST_FIRST.into_iter().find(|tier| facts.hdri.get(*tier).is_some_and(|file| shipped(file)));
                environment = tier.and_then(|tier| facts.hdri.get(tier)).map(|file| Environment::hdri(format!("{folder}/{file}")));
            }
            LibraryKind::Model | LibraryKind::Vegetation => model = Some(self.library_model(folder, &facts)),
        }
        let size = Vec3::new(facts.size[0], facts.size[1], facts.size[2]);
        let inner = Inner {
            id: facts.id,
            kind,
            name: facts.name,
            tags: facts.tags,
            licence: facts.licence,
            size,
            tier: tier.map(str::to_owned),
            triangles: facts.triangles,
            material,
            environment,
            model,
        };
        LibraryAsset { inner: Arc::new(inner) }
    }

    /// A model entry's members as one model, with its impostor when its budget draws one.
    fn library_model(&self, folder: &str, facts: &EntryFacts) -> Model {
        let members: Vec<Model> = facts.members.iter().map(|member| self.model(&format!("{folder}/{member}"))).collect();
        let model = match members.as_slice() {
            [] => Model::default(),
            [only] => only.clone(),
            many => self.compound(&many.iter().collect::<Vec<_>>()),
        };
        if facts.impostor && !model.is_missing() { model.with_impostor(Impostor::hemi()) } else { model }
    }
}

/// A material entry's surface at one tier.
fn library_material(folder: &str, maps: &MaterialMaps, facts: &EntryFacts) -> Material {
    let [r, g, b] = facts.base_color.unwrap_or([128, 128, 128]);
    // Metallic and roughness 1: the ORM map's values are taken as they are (they multiply).
    Material::color(Color::WHITE)
        .with_metallic(1.0)
        .with_roughness(1.0)
        .with_base_texture(&format!("{folder}/{}", maps.albedo))
        .with_normal_texture(&format!("{folder}/{}", maps.normal), NORMAL_SCALE)
        .with_orm_texture(&format!("{folder}/{}", maps.orm))
        .with_world_uv(facts.size[0])
        .with_untextured_color(Color::rgb(r, g, b))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gfx::{AssetTable, Gfx};
    use crate::render::EnvironmentKind;
    use genex_core::saves::Saves;

    const MATERIAL: &str = r#"{"schema":1,"id":"material/asphalt_02","kind":"material","name":"Asphalt 02","tags":["road"],
        "licence":"CC0-1.0","source":{"site":"polyhaven","id":"asphalt_02","page":"https://polyhaven.com/a/asphalt_02","authors":["A"]},
        "size":[2.5,2.5,0],"baseColor":[60,61,62],
        "maps":{"2k":{"albedo":"albedo.2k.jpg","normal":"normal.2k.jpg","orm":"orm.2k.jpg"},
                "4k":{"albedo":"albedo.4k.jpg","normal":"normal.4k.jpg","orm":"orm.4k.jpg"}}}"#;
    const ROCK: &str = r#"{"schema":1,"id":"model/boulder_01","kind":"model","name":"Boulder","tags":[],"licence":"CC0-1.0",
        "size":[1.3,1.0,1.8],"members":["model.glb"],"triangles":24000,"impostor":true}"#;
    const TREE: &str = r#"{"schema":1,"id":"vegetation/birch_winter","kind":"vegetation","name":"Birch","tags":[],"licence":"CC0-1.0",
        "size":[6,15,6],"members":["trunk.glb","foliage.glb"],"triangles":40000,"impostor":true}"#;
    const SKY: &str = r#"{"schema":1,"id":"sky/noon_grass","kind":"sky","name":"Noon Grass","tags":[],"licence":"CC0-1.0",
        "size":[0,0,0],"hdri":{"2k":"sky.2k.hdr","4k":"sky.4k.hdr"}}"#;

    fn path(id: &str, file: &str) -> &'static str {
        Box::leak(format!("library/{}/{file}", library_folder(id)).into_boxed_str())
    }

    fn gfx_with(files: Vec<(&'static str, &'static [u8])>) -> Gfx {
        let table: AssetTable = Box::leak(files.into_boxed_slice());
        let gfx = Gfx::new([320, 180], Saves::at(Err(genex_core::paths::SaveRefusal::NoStateDir)), crate::extend::WgslSetup::default(), Box::new(table));
        gfx.assets().set_at_reset(true);
        gfx
    }

    #[test]
    fn the_delivery_folder_is_the_plugins_for_the_same_id() {
        // The vectors `tests/conformance/genex-library.test.ts` holds for `libraryFolder`.
        let rows = [
            ("material/asphalt_02", "08082baa-906b-49a8-ea9f-1ff424475e8b"),
            ("model/painted_wooden_bench", "b545ae2d-dfe9-38f7-41af-202237a3a7a6"),
            ("sky/kloofendal_48d_partly_cloudy_puresky", "176302c6-21fa-d28a-0c2a-fdde1a6f8c77"),
            ("vegetation/birch_winter", "931cb11b-235a-f893-bc62-4df34cb900e0"),
        ];
        for (id, folder) in rows {
            assert_eq!(library_folder(id), folder, "{id}");
        }
    }

    #[test]
    fn a_material_draws_its_largest_shipped_tier_at_its_real_tile() {
        let id = "material/asphalt_02";
        let gfx = gfx_with(vec![(path(id, "entry.json"), MATERIAL.as_bytes()), (path(id, "albedo.2k.jpg"), b"jpg")]);
        let asset = gfx.assets().library(id).expect("added");
        assert_eq!(asset.kind(), LibraryKind::Material);
        assert_eq!(asset.tier(), Some("2k"), "the 4k maps were not shipped");
        assert_eq!(asset.tile_metres(), 2.5);
        let material = asset.material();
        assert_eq!(material.base_texture(), Some(path(id, "albedo.2k.jpg")));
        assert_eq!(material.normal_texture(), Some(path(id, "normal.2k.jpg")));
        assert_eq!(material.metal_rough_texture(), Some(path(id, "orm.2k.jpg")));
        assert_eq!(material.occlusion_texture(), Some((path(id, "orm.2k.jpg"), 1.0)));
        assert_eq!((material.metallic, material.roughness), (1.0, 1.0), "the ORM map's values as they are");
        assert_eq!(material.untextured_color(), Some(Color::rgb(60, 61, 62)));
        assert_eq!(asset.model(), Model::default(), "a material has no model");
    }

    #[test]
    fn a_rock_is_its_glb_with_an_impostor_and_a_tree_its_members_as_one() {
        let rock = "model/boulder_01";
        let tree = "vegetation/birch_winter";
        let gfx = gfx_with(vec![(path(rock, "entry.json"), ROCK.as_bytes()), (path(tree, "entry.json"), TREE.as_bytes())]);
        let boulder = gfx.assets().library(rock).expect("added").model();
        assert_eq!(boulder.path(), Some(path(rock, "model.glb")));
        assert!(boulder.impostor().is_some());
        let birch = gfx.assets().library(tree).expect("added");
        assert_eq!(birch.size(), Vec3::new(6.0, 15.0, 6.0));
        assert_eq!(birch.triangles(), Some(40_000));
        assert_eq!(birch.model().drawn_members().len(), 2);
    }

    #[test]
    fn a_sky_is_its_hdri_environment() {
        let id = "sky/noon_grass";
        let gfx = gfx_with(vec![(path(id, "entry.json"), SKY.as_bytes()), (path(id, "sky.4k.hdr"), b"hdr"), (path(id, "sky.2k.hdr"), b"hdr")]);
        let asset = gfx.assets().library(id).expect("added");
        assert_eq!(asset.tier(), Some("4k"));
        assert_eq!(asset.environment().kind(), EnvironmentKind::Hdri);
        assert_eq!(asset.material(), Material::default());
    }

    #[test]
    fn an_id_that_is_not_kind_slug_refuses_unsafe_path_before_any_read() {
        let gfx = gfx_with(vec![]);
        for id in ["../material/x", "material/../x", "material/a/b", "material/", "sound/x", "material/X", "material/a b", "", "material"] {
            let error = gfx.assets().library(id).expect_err(id);
            assert_eq!(error.code(), AssetErrorCode::UnsafePath, "{id:?}");
        }
        assert!(gfx.assets().requested().is_empty(), "nothing was read");
    }

    #[test]
    fn an_entry_not_added_is_missing_and_says_how_to_add_it() {
        let gfx = gfx_with(vec![]);
        let error = gfx.assets().library("material/asphalt_02").expect_err("not added");
        assert_eq!(error.code(), AssetErrorCode::Missing);
        assert!(error.detail().contains("library__add material/asphalt_02"), "{}", error.detail());
    }

    #[test]
    fn facts_of_another_entry_or_schema_or_not_json_are_malformed() {
        let id = "material/asphalt_02";
        let other = MATERIAL.replace("material/asphalt_02", "material/asphalt_03");
        let schema = MATERIAL.replace("\"schema\":1", "\"schema\":2");
        for facts in [other, schema, "not json".to_owned()] {
            let gfx = gfx_with(vec![(path(id, "entry.json"), Box::leak(facts.into_bytes().into_boxed_slice()))]);
            assert_eq!(gfx.assets().library(id).expect_err("refused").code(), AssetErrorCode::Malformed);
        }
    }

    #[test]
    fn outside_the_reset_a_library_read_refuses_not_at_reset() {
        let id = "material/asphalt_02";
        let gfx = gfx_with(vec![(path(id, "entry.json"), MATERIAL.as_bytes())]);
        gfx.assets().set_at_reset(false);
        assert_eq!(gfx.assets().library(id).expect_err("outside").code(), AssetErrorCode::NotAtReset);
    }
}
