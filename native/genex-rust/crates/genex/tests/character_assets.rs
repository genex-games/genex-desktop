//! `gfx.character(path)`: a rigged GLB read at reset through the sim-side asset source (SF-1a),
//! parsed by genex-anim behind the GLB guard and kept in an `Arc` cache across seeds. The rows: the
//! first seed gets the rig, a re-seed neither reads nor parses again, a missing, unsafe or unrigged
//! file refuses `animation-asset-invalid` (and the model draws the checker, no crash), and every
//! source a shell attaches gives the same rig and checksum.

#[path = "../../genex-anim/tests/support/mod.rs"]
mod rigs;

use genex::present::{AssetCache, Uploads};
use genex::prelude::*;
use genex::{AssetError, AssetFiles, CharacterAsset, AssetGroup, AssetGroups, AssetSource, AssetTable, DEFAULT_SEED, Runtime, View};
use genex_anim::AnimationErrorCode;
use genex_anim::import::import_rig;
use genex_render::RenderError;
use genex_render::mesh::MeshData;
use genex_render::scene::MeshId;
use genex_render::texture::{TextureData, TextureId, TextureKind};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

/// A 22-joint humanoid GLB (genex-anim's fixture rig, the same bytes its own tests import).
static HERO: LazyLock<&'static [u8]> = LazyLock::new(|| Box::leak(rigs::humanoid22().glb().into_boxed_slice()));
/// A real GLB with triangles and no skin.
const SPHERE: &[u8] = include_bytes!("../../../../../tests/fixtures/asset-import/lods-sphere.glb");

fn table() -> AssetTable {
    static TABLE: LazyLock<AssetTable> = LazyLock::new(|| Box::leak(vec![("characters/hero.glb", *HERO), ("lods-sphere.glb", SPHERE)].into_boxed_slice()));
    *TABLE
}

/// What a reset loaded: the asset, each refusal's wire code, the joint count it probes.
#[derive(Default)]
struct World {
    hero: Option<CharacterAsset>,
    outcome: Vec<String>,
    joints: usize,
    steps: u64,
}

/// A source that counts the reads that reach it and names each path it was asked for.
struct Counting {
    inner: Box<dyn AssetSource>,
    reads: Arc<AtomicUsize>,
    asked: Arc<Mutex<Vec<String>>>,
}

impl AssetSource for Counting {
    fn read(&self, path: &str) -> Result<Arc<[u8]>, AssetError> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        self.asked.lock().expect("asked").push(path.to_owned());
        self.inner.read(path)
    }

    fn size(&self, path: &str) -> Result<u64, AssetError> {
        self.inner.size(path)
    }

    fn group(&self, path: &str) -> AssetGroup {
        self.inner.group(path)
    }
}

type Probe = (Box<dyn AssetSource>, Arc<AtomicUsize>, Arc<Mutex<Vec<String>>>);

fn counting(inner: Box<dyn AssetSource>) -> Probe {
    let reads = Arc::new(AtomicUsize::new(0));
    let asked = Arc::new(Mutex::new(Vec::new()));
    (Box::new(Counting { inner, reads: Arc::clone(&reads), asked: Arc::clone(&asked) }), reads, asked)
}

/// A game whose reset loads its hero, probes the joint count and moves it a step a tick.
fn hero_game() -> Game<World> {
    let mut game = Game::new(World::default()).world_size(64, 64);
    game.on_reset(|sim, _, _, gfx| {
        let hero = gfx.character("characters/hero.glb").expect("the hero rig loads at reset");
        sim.world.joints = hero.joint_count();
        sim.world.hero = Some(hero);
    });
    game.on_update(|sim, ctx| sim.world.steps += u64::from(ctx.rng.below(4)));
    game.probe("joints", |sim| json!(sim.world.joints));
    game.probe("steps", |sim| json!(sim.world.steps));
    game
}

/// A game whose reset loads each of `paths` as a character and records each answer's code.
fn loading_game(paths: &'static [&'static str]) -> Game<World> {
    let mut game = Game::new(World::default()).world_size(64, 64);
    game.on_reset(move |sim, _, _, gfx| {
        for path in paths {
            let answer = gfx.character(path);
            sim.world.outcome.push(answer.map_or_else(|error| error.code.wire().to_owned(), |hero| format!("{} joints", hero.joint_count())));
        }
    });
    game.on_draw(move |_, frame, _| {
        for path in paths {
            frame.model(&Assets::default().model(path), Transform::IDENTITY);
        }
    });
    game.probe("outcome", |sim| json!(sim.world.outcome));
    game
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("genex-character-assets-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("assets/characters")).expect("assets folder");
    dir
}

#[test]
fn the_first_seed_gets_the_rig() {
    let runtime = Runtime::with_assets(hero_game(), Box::new(table())).expect("valid game");
    assert_eq!(runtime.tick(), 0, "the first seed, not a re-seed");
    let hero = runtime.sim().world.hero.clone().expect("loaded on the first seed");
    let expected = import_rig(*HERO).expect("genex-anim imports the fixture");
    assert_eq!(hero.skeleton(), expected.skeleton(), "the facade's rig is genex-anim's import of the bytes");
    assert_eq!(hero.joint_count(), 22);
    assert_eq!(hero.path(), "characters/hero.glb");
    assert_eq!(runtime.state()["assets"], json!(["characters/hero.glb"]), "state().assets lists the read");
}

#[test]
fn a_reseed_neither_reads_nor_parses_again() {
    let (source, reads, _) = counting(Box::new(table()));
    let mut runtime = Runtime::with_assets(hero_game(), source).expect("valid game");
    let first = runtime.sim().world.hero.clone().expect("first seed");
    let checksum = runtime.checksum();
    runtime.seed(2);
    runtime.seed(DEFAULT_SEED);
    assert_eq!(reads.load(Ordering::SeqCst), 1, "one read over three seeds");
    let again = runtime.sim().world.hero.clone().expect("a re-seed");
    assert!(std::ptr::eq(first.skeleton(), again.skeleton()), "the rig is parsed once and shared");
    assert_eq!(first, again);
    assert_eq!(runtime.checksum(), checksum, "the same seed gives the same checksum");
}

/// A missing file, a GLB with no skin, bytes that are not a GLB and every hostile path refuse
/// `animation-asset-invalid` with no panic; a hostile path is never read and never listed, and the
/// model the game still draws for it is the checker.
#[test]
fn a_missing_unsafe_or_unrigged_file_refuses_animation_asset_invalid() {
    const PATHS: &[&str] =
        &["characters/missing.glb", "lods-sphere.glb", "notes.json", "escape.gltf", "../x.glb", "/etc/hosts", "a/../../x.glb", "", "characters\\hero.glb", "nul\0.glb"];
    // A .gltf whose buffer climbs out of the folder: refused without its URI ever being asked for.
    let escape: &[u8] = br#"{"asset":{"version":"2.0"},"buffers":[{"uri":"../secret.bin","byteLength":36}],"nodes":[{"name":"Hips"}],"skins":[{"joints":[0]}]}"#;
    let table: AssetTable = Box::leak(vec![("lods-sphere.glb", SPHERE), ("notes.json", &b"{}"[..]), ("escape.gltf", escape)].into_boxed_slice());
    let (source, reads, asked) = counting(Box::new(table));
    let mut runtime = Runtime::with_assets(loading_game(PATHS), source).expect("valid game");
    assert_eq!(runtime.sim().world.outcome, vec![AnimationErrorCode::AssetInvalid.wire(); PATHS.len()]);
    let plain = ["characters/missing.glb", "lods-sphere.glb", "notes.json", "escape.gltf"];
    assert_eq!(*asked.lock().expect("asked"), plain, "only plain paths reach the source, and no buffer URI");
    assert_eq!(reads.load(Ordering::SeqCst), 4);
    assert_eq!(runtime.state()["assets"], json!(["lods-sphere.glb", "notes.json", "escape.gltf"]), "a file that read is listed, a refused path is not");

    // The game draws the missing hero's model anyway: the presenter loads nothing and the frame
    // names it among the checker's models.
    let frame = runtime.frame(View::Game).expect("the game view");
    let mut cache = AssetCache::default();
    let mut uploads = NoUploads::default();
    cache.load(&frame, &table, &mut uploads, &mut |_| {}).expect("no device loss");
    assert!(cache.tried("characters/missing.glb"));
    assert!(cache.model("characters/missing.glb").is_none(), "the checker stands in for it");
}

#[test]
fn a_streamed_rig_refuses_at_reset_without_a_read() {
    let groups = AssetGroups::default().with("characters/hero.glb", AssetGroup::Stream);
    let files = AssetFiles::new(table(), None).with_groups(groups);
    let (source, reads, _) = counting(Box::new(files));
    let runtime = Runtime::with_assets(loading_game(&["characters/hero.glb"]), source).expect("valid game");
    assert_eq!(runtime.sim().world.outcome, [AnimationErrorCode::AssetInvalid.wire()]);
    assert_eq!(reads.load(Ordering::SeqCst), 0, "a streamed asset is never read at reset");
}

/// The compiled table and the asset folder give one rig and one checksum (the web's fetched set is
/// genex-platform-web's `character_assets` row).
#[test]
fn the_table_and_the_asset_folder_give_one_rig_and_checksum() {
    let dir = scratch("folder");
    std::fs::write(dir.join("assets/characters/hero.glb"), *HERO).expect("hero");
    let run = |source: Box<dyn AssetSource>| {
        let mut runtime = Runtime::with_assets(hero_game(), source).expect("valid game");
        runtime.step(1000.0);
        let hero = runtime.sim().world.hero.clone().expect("loaded");
        (hero.skeleton().clone(), runtime.checksum())
    };
    let compiled = run(Box::new(table()));
    let folder = run(Box::new(AssetFiles::new(&[], Some(dir.join("assets")))));
    assert_eq!(compiled, folder);
    let _ = std::fs::remove_dir_all(&dir);
}

/// A renderer stand-in that hands out ids in order.
#[derive(Default)]
struct NoUploads {
    meshes: u32,
}

impl Uploads for NoUploads {
    fn add_mesh(&mut self, _mesh: MeshData) -> Result<MeshId, RenderError> {
        self.meshes += 1;
        Ok(MeshId::from_raw(self.meshes))
    }

    fn add_texture(&mut self, _data: &TextureData, kind: TextureKind) -> Result<TextureId, RenderError> {
        Ok(TextureId::new(kind, 0))
    }
}
