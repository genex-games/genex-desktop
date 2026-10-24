//! The presenter's characters (game systems AN-17): a rigged GLB drawn with `frame.character` is
//! skinned in its animator's pose, not drawn in bind pose. The presenter evaluates the pose and
//! hands the joint palette (skin order) to the renderer's skinned draw. In Live a character's
//! pose is held between evaluations by its rate band, read from LOD's screen-size metric of the
//! game camera (an observer or a player eye never changes it); a capture is always full rate. A
//! missing file draws the magenta checker, and drawing never moves the simulation.
//!
//! The CPU rows run everywhere. The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex \
//!     --test character_draw -- --ignored metal
//!
//! The golden rows compare the settled capture with `tests/goldens/characters/<name>.bgra` (raw
//! BGRA, top row first) within the renderer's golden tolerance. `GENEX_RENDER_GOLDEN_UPDATE=1`
//! rewrites them instead; review the diff.

#[path = "../../genex-anim/tests/support/mod.rs"]
mod rigs;

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use genex::animation::Motion;
use genex::present::{AssetCache, CharacterStats, ModelSource, RateBand, Uploads, drawn_of, rate_band, to_scene};
use genex::prelude::*;
use genex::{AssetTable, FIXED_STEP_MS, Runtime, View};
use genex_render::RenderError;
use genex_render::mesh::MeshData;
use genex_render::scene::{MeshId, MeshLibrary};
use genex_render::skin::{SkinId, SkinnedModel};
use genex_render::texture::{TextureData, TextureId, TextureKind};

/// The capture size of the GPU rows.
const WORLD: [u32; 2] = [128, 96];
/// A golden pixel may differ by this much per channel (another Apple GPU family rounds differently).
const GOLDEN_CHANNEL_TOLERANCE: u8 = 2;
/// Pixels allowed past the channel tolerance (rasterization on edges), of 12,288.
const GOLDEN_OUTLIER_PIXELS: usize = 61;
/// Ticks to t = 0.5 s at the fixed step.
const HALF_SECOND_TICKS: u32 = 30;
/// The distance of the far character (the row's 60 m).
const FAR_METRES: f32 = 60.0;
/// Live ticks the rate rows draw.
const LIVE_TICKS: u64 = 16;

/// genex-anim's 22-joint humanoid: two skinned parts (two materials) and a walk clip that moves
/// its hips 1.2 m along +z over 1 s.
static HERO: LazyLock<&'static [u8]> = LazyLock::new(|| Box::leak(rigs::humanoid22().glb().into_boxed_slice()));

fn table() -> AssetTable {
    static TABLE: LazyLock<AssetTable> = LazyLock::new(|| Box::leak(vec![("hero.glb", *HERO)].into_boxed_slice()));
    *TABLE
}

#[derive(Default)]
struct World {
    hero: Option<Animator>,
    /// The model of the same file, for the bind-pose comparison.
    bind: Model,
}

/// What a test game draws: the animated character, or its file as a plain model (bind pose).
#[derive(Clone, Copy, PartialEq)]
enum Draws {
    Character,
    BindPose,
    /// The one animator drawn by three characters side by side (a crowd's shared cycle).
    Crowd,
    /// Three temporary copies of the animator, each advanced a little further, drawn in turn from
    /// one stack slot (each its own pose).
    Phased,
}

/// A game walking the hero in place at the origin, seen from `eye`; a player eye named
/// "observer" sits at `observer`.
fn hero_game(draws: Draws, eye: Vec3, observer: Vec3) -> Game<World> {
    let mut game = Game::new(World::default()).title("Characters").world_size(WORLD[0], WORLD[1]);
    let target = vec3(1.0, 0.5, 0.0);
    game.camera(move |_| Camera::look_at(eye, target));
    game.eye("observer", move |_| Camera::look_at(observer, target));
    game.on_reset(|sim, _, _, gfx| {
        let hero = gfx.character("hero.glb").expect("the hero loads");
        let walk = hero.clip("Walk").expect("the hero walks");
        let mut g = hero.graph();
        let base = g.layer("base");
        g.state(base, "walk", Motion::clip(walk));
        let graph = g.build().expect("the graph builds");
        sim.world.hero = Some(hero.animator(&graph).expect("an animator"));
        sim.world.bind = gfx.assets().model("hero.glb");
    });
    game.on_update(|sim, ctx| {
        if let Some(hero) = sim.world.hero.as_mut() {
            hero.update(ctx.dt);
        }
    });
    game.on_draw(move |sim, frame, _| {
        frame.sun(vec3(0.4, 0.8, 1.0), Color::WHITE, 3.0);
        let Some(hero) = &sim.world.hero else { return };
        match draws {
            Draws::Character => frame.tag("hero").character(hero, Transform::IDENTITY),
            Draws::BindPose => frame.tag("hero").model(&sim.world.bind, Transform::IDENTITY),
            Draws::Crowd => {
                for x in [-2.0, 0.0, 2.0] {
                    frame.tag("hero").character(hero, Transform::from_xyz(x, 0.0, 0.0));
                }
                frame
            }
            Draws::Phased => {
                for k in 1..=3 {
                    let mut phased = hero.clone();
                    phased.update(0.1 * k as f32);
                    frame.tag("hero").character(&phased, Transform::from_xyz(2.0 * k as f32, 0.0, 0.0));
                }
                frame
            }
        };
    });
    game
}

/// The near camera every capture row draws from.
fn near_eye() -> Vec3 {
    vec3(1.0, 1.0, 4.0)
}

fn runtime(game: Game<World>, ticks: u32) -> Runtime<World> {
    let mut runtime = Runtime::with_assets(game, Box::new(table())).expect("valid game");
    runtime.seed(1);
    runtime.start();
    runtime.step(f64::from(ticks) * FIXED_STEP_MS);
    runtime
}

/// The hero's skinning palette as genex-anim evaluates it (the full-rate pose).
fn palette_of(hero: &Animator) -> Vec<[f32; 16]> {
    let mut palette = vec![Mat4::IDENTITY.to_cols_array(); hero.set().skeleton().skin_order().len()];
    hero.palette(&mut palette);
    palette
}

/// A renderer stand-in over a CPU mesh library: real mesh and skin ids, textures in order.
#[derive(Default)]
struct Library {
    library: MeshLibrary,
    skinned: u32,
    refuse_skins: bool,
}

impl Uploads for Library {
    fn add_mesh(&mut self, mesh: MeshData) -> Result<MeshId, RenderError> {
        self.library.add(mesh)
    }

    fn add_texture(&mut self, _data: &TextureData, kind: TextureKind) -> Result<TextureId, RenderError> {
        Ok(TextureId::new(kind, 0))
    }

    fn add_skinned_model(&mut self, model: &SkinnedModel) -> Result<SkinId, RenderError> {
        if self.refuse_skins {
            return Err(RenderError::refused(genex_render::RenderCode::MeshInvalid, "skins refused by the test"));
        }
        self.skinned += 1;
        self.library.add_skinned_parts(&model.data, &model.parts)
    }
}

/// `frame`'s assets loaded into a fresh cache through `uploads` from the hero's table.
fn loaded(frame: &Frame, uploads: &mut Library) -> AssetCache {
    let mut cache = AssetCache::default();
    let source: &dyn ModelSource = &table();
    cache.load(frame, source, uploads, &mut |line| eprintln!("{line}")).expect("no device to lose");
    cache
}

// ---------------------------------------------------------------------------------------------
// CPU rows

#[test]
fn a_rigged_glb_drawn_with_frame_character_is_one_skinned_draw_in_its_animators_pose() {
    let mut runtime = runtime(hero_game(Draws::Character, near_eye(), near_eye()), HALF_SECOND_TICKS);
    let frame = runtime.frame(View::Game).expect("the game view");
    let camera = runtime.camera(View::Game).expect("the game camera");
    let mut uploads = Library::default();
    let cache = loaded(&frame, &mut uploads);
    assert_eq!(uploads.skinned, 1, "the character's GLB is uploaded skinned once");
    let skin = cache.skin("hero.glb").expect("the skin is held");

    let scene = to_scene(&frame, &camera, &cache);
    assert_eq!(scene.skinned.len(), 1, "one skinned draw, not the bind-pose model: {:?}", scene.draws.len());
    assert!(scene.draws.is_empty(), "nothing draws in bind pose");
    let draw = &scene.skinned[0];
    assert_eq!(draw.skin, skin);
    let hero = runtime.sim().world.hero.clone().expect("the hero");
    assert_eq!(draw.joints, palette_of(&hero), "the palette is the animator's evaluated pose, in skin order");
    assert_eq!(draw.part_materials.len(), 2, "each part draws with its own material");
    assert_ne!(draw.part_materials[0], draw.part_materials[1], "the GLB's two materials");
    assert_eq!(drawn_of(&frame, &camera, &cache).missing_models, Vec::<String>::new());
}

/// C-18 with AN-17: a `reloadAssets` that names the character's GLB has it skinned again from its
/// new bytes on the next load.
#[test]
fn an_invalidated_character_glb_is_skinned_again_on_the_next_load() {
    let mut runtime = runtime(hero_game(Draws::Character, near_eye(), near_eye()), 1);
    let frame = runtime.frame(View::Game).expect("the game view");
    let mut uploads = Library::default();
    let mut cache = loaded(&frame, &mut uploads);
    let first = cache.skin("hero.glb").expect("the skin is held");
    cache.invalidate(&["hero.glb"]);
    assert_eq!(cache.skin("hero.glb"), None, "the reload forgot the skin");
    let source: &dyn ModelSource = &table();
    cache.load(&frame, source, &mut uploads, &mut |line| eprintln!("{line}")).expect("no device to lose");
    assert_eq!(uploads.skinned, 2, "the GLB is skinned again");
    assert_ne!(cache.skin("hero.glb"), Some(first), "a new skin");
}

#[test]
fn the_pose_at_half_a_second_differs_from_the_bind_pose() {
    let pose_at = |ticks: u32| {
        let mut runtime = runtime(hero_game(Draws::Character, near_eye(), near_eye()), ticks);
        let frame = runtime.frame(View::Game).expect("the game view");
        let camera = runtime.camera(View::Game).expect("the game camera");
        let cache = loaded(&frame, &mut Library::default());
        to_scene(&frame, &camera, &cache).skinned[0].joints.clone()
    };
    assert_ne!(pose_at(HALF_SECOND_TICKS), pose_at(0), "the walk moved the hips by t = 0.5 s");
    assert_eq!(pose_at(HALF_SECOND_TICKS), pose_at(HALF_SECOND_TICKS), "the same tick gives the same palette bits");
}

#[test]
fn a_missing_file_draws_the_checker_and_a_refused_skin_draws_the_bind_pose_model() {
    let mut runtime = runtime(hero_game(Draws::Character, near_eye(), near_eye()), 1);
    let frame = runtime.frame(View::Game).expect("the game view");
    let camera = runtime.camera(View::Game).expect("the game camera");

    // The presenter's own source lacks the file (the sim read it from its table).
    let mut cache = AssetCache::default();
    let empty: AssetTable = &[];
    let source: &dyn ModelSource = &empty;
    cache.load(&frame, source, &mut Library::default(), &mut |_| {}).expect("no device to lose");
    let drawn = drawn_of(&frame, &camera, &cache);
    assert_eq!(drawn.missing_models, vec!["hero.glb".to_owned()], "the checker stands in");
    let scene = to_scene(&frame, &camera, &cache);
    assert!(scene.skinned.is_empty());
    assert_eq!(scene.draws.len(), 1, "one checker cube");
    assert_eq!(scene.draws[0].mesh, MeshId::CUBE);

    // A renderer that takes no skinned mesh draws the file's model, as before AN-17.
    let mut refusing = Library { refuse_skins: true, ..Library::default() };
    let cache = loaded(&frame, &mut refusing);
    assert_eq!(cache.skin("hero.glb"), None);
    let scene = to_scene(&frame, &camera, &cache);
    assert!(scene.skinned.is_empty());
    assert_eq!(scene.draws.len(), 2, "the model's two parts in bind pose");
}

#[test]
fn rate_bands_read_lods_screen_size_metric() {
    let camera = Camera::look_at(Vec3::ZERO, vec3(0.0, 0.0, -1.0));
    // A 1.8 m tall character (radius 0.9) at the default 45° field of view.
    let at = |metres: f32| rate_band(&camera, [0.0, 0.0, -metres, 0.9]);
    assert_eq!(at(3.0), RateBand::Full);
    assert_eq!(at(15.0), RateBand::Half);
    assert_eq!(at(30.0), RateBand::Quarter);
    assert_eq!(at(FAR_METRES), RateBand::Eighth, "a character at 60 m holds its pose 8 ticks");
    assert_eq!([RateBand::Full, RateBand::Half, RateBand::Quarter, RateBand::Eighth].map(RateBand::interval), [1, 2, 4, 8]);
    // Inside the sphere and under an orthographic camera (levels off) it is full rate.
    assert_eq!(at(0.5), RateBand::Full);
    assert_eq!(rate_band(&Camera { projection: Projection::Orthographic, ..camera }, [0.0, 0.0, -FAR_METRES, 0.9]), RateBand::Full);
}

/// The Live poses of the far hero over [`LIVE_TICKS`] ticks: the stats of each tick, and the
/// runtime after them.
fn live_far_ticks(eye: Vec3) -> (Vec<CharacterStats>, Runtime<World>, AssetCache) {
    let far = vec3(1.0, 0.5, FAR_METRES);
    let mut runtime = runtime(hero_game(Draws::Character, far, eye), 1);
    let frame = runtime.frame(View::Game).expect("the game view");
    let mut cache = loaded(&frame, &mut Library::default());
    let mut stats = Vec::new();
    for _ in 0..LIVE_TICKS {
        runtime.step(FIXED_STEP_MS);
        let view = if eye == far { View::Game } else { View::Eye("observer") };
        let frame = runtime.frame(view).expect("the view");
        let game_camera = runtime.camera(View::Game).expect("the game camera");
        cache.pose_characters(&frame, &game_camera, runtime.tick(), true);
        stats.push(cache.character_stats());
    }
    (stats, runtime, cache)
}

#[test]
fn in_live_a_character_at_60_m_evaluates_at_most_every_4th_tick_and_a_capture_is_full_rate() {
    let far = vec3(1.0, 0.5, FAR_METRES);
    let (stats, mut runtime, mut cache) = live_far_ticks(far);
    let evaluated: u32 = stats.iter().map(|s| s.evaluated).sum();
    let held: u32 = stats.iter().map(|s| s.held).sum();
    assert!(evaluated <= (LIVE_TICKS / 4) as u32, "evaluated {evaluated} times in {LIVE_TICKS} ticks: {stats:?}");
    assert_eq!(evaluated + held, LIVE_TICKS as u32, "drawn every tick");

    // On a held tick Live draws the held pose; a capture of that tick is the full-rate pose.
    let frame = runtime.frame(View::Game).expect("the game view");
    let camera = runtime.camera(View::Game).expect("the game camera");
    let hero = runtime.sim().world.hero.clone().expect("the hero");
    let full = palette_of(&hero);
    let live = to_scene(&frame, &camera, &cache).skinned[0].joints.clone();
    let tick = runtime.tick();
    assert_eq!(live, full, "a frame never posed for Live is drawn at full rate");
    cache.pose_characters(&frame, &camera, tick, false);
    assert_eq!(cache.character_stats().evaluated, 1, "a capture evaluates");
    assert_eq!(to_scene(&frame, &camera, &cache).skinned[0].joints, full, "the capture of that tick is full rate");
}

#[test]
fn the_rate_follows_the_game_camera_not_the_observer_eye() {
    let far = vec3(1.0, 0.5, FAR_METRES);
    let (from_game, ..) = live_far_ticks(far);
    let (from_observer, ..) = live_far_ticks(near_eye());
    let evaluated = |stats: &[CharacterStats]| stats.iter().map(|s| s.evaluated).collect::<Vec<_>>();
    assert_eq!(evaluated(&from_game), evaluated(&from_observer), "a near observer eye does not raise the rate");
    let digests = |stats: &[CharacterStats]| stats.iter().map(|s| s.palette_digest).collect::<Vec<_>>();
    assert_eq!(digests(&from_game), digests(&from_observer), "the same poses from either view");
}

#[test]
fn an_entry_is_evicted_after_two_undrawn_frames_and_lod_never_writes_back_to_the_sim() {
    let far = vec3(1.0, 0.5, FAR_METRES);
    let (_, runtime, mut cache) = live_far_ticks(far);
    assert_eq!(cache.character_stats().cached, 1);
    let empty = Frame::default();
    let camera = runtime.camera(View::Game).expect("the game camera");
    cache.pose_characters(&empty, &camera, runtime.tick() + 1, true);
    assert_eq!(cache.character_stats().cached, 1, "kept one undrawn frame");
    cache.pose_characters(&empty, &camera, runtime.tick() + 2, true);
    assert_eq!(cache.character_stats().cached, 0, "evicted after two");

    // The same run without any Live posing ends in the same simulation.
    let mut plain = runtime_far_plain();
    assert_eq!(plain.checksum(), runtime.checksum(), "posing never moves the simulation");
    let digest = |runtime: &Runtime<World>| runtime.sim().world.hero.as_ref().map(|hero| hero.digest());
    assert_eq!(digest(&plain), digest(&runtime));
    let _ = plain.frame(View::Game);
}

/// A crowd drawn with one shared animator (lane CP): the frame copies the animator once, and Live
/// poses it once a tick, at full rate, for all three (never held: a held pose per character would
/// split the one pose the renderer skins once into three).
#[test]
fn an_animator_drawn_by_several_characters_is_copied_once_and_posed_every_tick() {
    let far = vec3(1.0, 0.5, FAR_METRES);
    let mut runtime = runtime(hero_game(Draws::Crowd, far, far), 1);
    let frame = runtime.frame(View::Game).expect("the game view");
    let animators: Vec<_> = frame.draws().iter().filter_map(|draw| if let genex::Shape::Character { animator, .. } = &draw.shape { Some(animator.clone()) } else { None }).collect();
    assert_eq!(animators.len(), 3);
    assert!(animators.iter().all(|animator| std::sync::Arc::ptr_eq(animator, &animators[0])), "one copy for the three draws");
    let mut cache = loaded(&frame, &mut Library::default());
    for _ in 0..LIVE_TICKS {
        runtime.step(FIXED_STEP_MS);
        let frame = runtime.frame(View::Game).expect("the view");
        let game_camera = runtime.camera(View::Game).expect("the game camera");
        cache.pose_characters(&frame, &game_camera, runtime.tick(), true);
        let stats = cache.character_stats();
        assert_eq!((stats.drawn, stats.evaluated, stats.held), (3, 3, 0), "tick {}: {stats:?}", runtime.tick());
        let hero = runtime.sim().world.hero.clone().expect("the hero");
        let scene = to_scene(&frame, &game_camera, &cache);
        assert!(scene.skinned.iter().all(|draw| draw.joints == palette_of(&hero)), "all three draw this tick's full-rate pose");
    }
}

/// Temporaries drawn from one stack slot are three states: each is copied for its own draw.
#[test]
fn temporary_animators_at_one_address_are_copied_apart() {
    let mut runtime = runtime(hero_game(Draws::Phased, near_eye(), near_eye()), 1);
    let frame = runtime.frame(View::Game).expect("the game view");
    let digests: Vec<u64> = frame.draws().iter().filter_map(|draw| if let genex::Shape::Character { animator, .. } = &draw.shape { Some(animator.digest()) } else { None }).collect();
    assert_eq!(digests.len(), 3);
    assert!(digests[0] != digests[1] && digests[1] != digests[2] && digests[0] != digests[2], "three poses: {digests:?}");
}

/// [`live_far_ticks`]'s run with no presenter.
fn runtime_far_plain() -> Runtime<World> {
    let far = vec3(1.0, 0.5, FAR_METRES);
    runtime(hero_game(Draws::Character, far, far), 1 + LIVE_TICKS as u32)
}

// ---------------------------------------------------------------------------------------------
// GPU rows

mod metal {
    use super::*;
    use genex::present::Presenter;

    fn open_presenter() -> Option<Presenter> {
        let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
        match Presenter::open_with_root(WORLD, table(), None) {
            Ok(presenter) => Some(presenter),
            Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
            Err(error) => {
                eprintln!("skipped: no WebGPU-core adapter ({error})");
                None
            }
        }
    }

    /// The settled capture of `view` as BGRA, written as a PNG under `GENEX_RENDER_EVIDENCE_DIR`.
    fn capture(presenter: &mut Presenter, runtime: &mut Runtime<World>, view: View<'_>, name: &str) -> Vec<u8> {
        presenter.set_capturing(true);
        presenter.draw_view(runtime, view).expect("a view").expect("drawn");
        assert_eq!(presenter.failure(), None);
        let bgra = presenter.resilient.capture().expect("capture").bgra().to_vec();
        if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
            let rgba: Vec<u8> = bgra.as_chunks::<4>().0.iter().flat_map(|p| [p[2], p[1], p[0], p[3]]).collect();
            let _ = std::fs::create_dir_all(&dir);
            std::fs::write(Path::new(&dir).join(format!("{name}.png")), png(WORLD[0], WORLD[1], &rgba)).expect("evidence");
        }
        bgra
    }

    fn goldens_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/goldens/characters")
    }

    /// Compare `bgra` with golden `name` within the tolerance (or rewrite it under
    /// `GENEX_RENDER_GOLDEN_UPDATE=1`).
    fn check_golden(name: &str, bgra: &[u8]) {
        let path = goldens_dir().join(format!("{name}.bgra"));
        if std::env::var("GENEX_RENDER_GOLDEN_UPDATE").is_ok_and(|v| v == "1") {
            std::fs::create_dir_all(goldens_dir()).expect("goldens dir");
            std::fs::write(&path, bgra).expect("golden written");
            return;
        }
        let golden = std::fs::read(&path).unwrap_or_else(|_| panic!("golden {path:?} missing: record it with GENEX_RENDER_GOLDEN_UPDATE=1"));
        assert_eq!(golden.len(), bgra.len(), "{name}: size");
        let outliers =
            golden.as_chunks::<4>().0.iter().zip(bgra.as_chunks::<4>().0).filter(|(g, c)| (0..3).any(|k| g[k].abs_diff(c[k]) > GOLDEN_CHANNEL_TOLERANCE)).count();
        assert!(outliers <= GOLDEN_OUTLIER_PIXELS, "{name}: {outliers} pixels past the tolerance");
    }

    /// A stored-deflate PNG of `rgba` (`width` x `height`).
    fn png(width: u32, height: u32, rgba: &[u8]) -> Vec<u8> {
        let crc = |bytes: &[u8]| {
            let mut crc = 0xffff_ffffu32;
            for byte in bytes {
                crc ^= u32::from(*byte);
                for _ in 0..8 {
                    crc = if crc & 1 == 1 { 0xedb8_8320 ^ (crc >> 1) } else { crc >> 1 };
                }
            }
            !crc
        };
        let chunk = |out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]| {
            out.extend((data.len() as u32).to_be_bytes());
            let mut body = kind.to_vec();
            body.extend(data);
            out.extend(&body);
            out.extend(crc(&body).to_be_bytes());
        };
        let mut raw = Vec::new();
        for row in rgba.chunks_exact(width as usize * 4) {
            raw.push(0);
            raw.extend(row);
        }
        let (mut a, mut b) = (1u32, 0u32);
        for byte in &raw {
            a = (a + u32::from(*byte)) % 65_521;
            b = (b + a) % 65_521;
        }
        let mut zlib = vec![0x78, 0x01];
        for (at, block) in raw.chunks(65_535).enumerate() {
            let last = (at + 1) * 65_535 >= raw.len();
            zlib.push(u8::from(last));
            zlib.extend((block.len() as u16).to_le_bytes());
            zlib.extend((!(block.len() as u16)).to_le_bytes());
            zlib.extend(block);
        }
        zlib.extend(((b << 16) | a).to_be_bytes());
        let mut out = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        let mut header = Vec::new();
        header.extend(width.to_be_bytes());
        header.extend(height.to_be_bytes());
        header.extend([8, 6, 0, 0, 0]);
        chunk(&mut out, b"IHDR", &header);
        chunk(&mut out, b"IDAT", &zlib);
        chunk(&mut out, b"IEND", &[]);
        out
    }

    /// FNV-1a 64 of `bytes`.
    fn digest(bytes: &[u8]) -> u64 {
        bytes.iter().fold(0xcbf2_9ce4_8422_2325u64, |hash, byte| (hash ^ u64::from(*byte)).wrapping_mul(0x0100_0000_01b3))
    }

    /// Pixels of two BGRA captures differing in any colour channel.
    fn differing(a: &[u8], b: &[u8]) -> usize {
        a.as_chunks::<4>().0.iter().zip(b.as_chunks::<4>().0).filter(|(p, q)| (0..3).any(|c| p[c] != q[c])).count()
    }

    #[test]
    #[ignore = "needs a GPU: run with --ignored metal"]
    fn metal_a_rigged_glb_renders_animated_with_a_stable_digest_from_the_game_camera_and_the_observer_eye() {
        let Some(mut presenter) = open_presenter() else { return };
        let mut animated = runtime(hero_game(Draws::Character, near_eye(), near_eye()), HALF_SECOND_TICKS);
        let first = capture(&mut presenter, &mut animated, View::Game, "an17-walk-t0.5");
        assert_eq!(presenter.character_stats().drawn, 1);
        let from_eye = capture(&mut presenter, &mut animated, View::Eye("observer"), "an17-walk-t0.5-observer");
        assert_eq!(digest(&first), digest(&from_eye), "the observer eye at the game camera draws the same pixels");

        let mut bind = runtime(hero_game(Draws::BindPose, near_eye(), near_eye()), HALF_SECOND_TICKS);
        let bind_pose = capture(&mut presenter, &mut bind, View::Game, "an17-bind-pose");
        let moved = differing(&first, &bind_pose);
        assert!(moved > 50, "t = 0.5 s differs from bind pose: {moved} pixels");

        // A second run on a fresh presenter: the same bits.
        let Some(mut again) = open_presenter() else { return };
        let mut replay = runtime(hero_game(Draws::Character, near_eye(), near_eye()), HALF_SECOND_TICKS);
        let second = capture(&mut again, &mut replay, View::Game, "an17-walk-t0.5-run2");
        assert_eq!(digest(&first), digest(&second), "the capture digest is stable over two runs");
        eprintln!("an17 walk t=0.5 digest {:016x}, {moved} pixels differ from bind pose", digest(&first));
        check_golden("walk-t0.5", &first);
        check_golden("bind-pose", &bind_pose);
    }

    #[test]
    #[ignore = "needs a GPU: run with --ignored metal"]
    fn metal_a_character_survives_a_device_loss_with_the_same_pixels() {
        let Some(mut presenter) = open_presenter() else { return };
        let mut animated = runtime(hero_game(Draws::Character, near_eye(), near_eye()), HALF_SECOND_TICKS);
        let before = capture(&mut presenter, &mut animated, View::Game, "an17-before-loss");
        presenter.resilient.force_device_loss();
        assert!(presenter.recover_for(&mut animated).expect("recovers"), "a new device");
        let after = capture(&mut presenter, &mut animated, View::Game, "an17-after-loss");
        assert_eq!(presenter.character_stats().drawn, 1, "still drawn skinned: its skin was replayed");
        assert_eq!(digest(&before), digest(&after), "the skinned model replayed on the new device");
    }

    #[test]
    #[ignore = "needs a GPU: run with --ignored metal"]
    fn metal_in_live_a_far_character_holds_its_pose_and_a_capture_of_that_tick_is_full_rate() {
        let Some(mut presenter) = open_presenter() else { return };
        let far = vec3(1.0, 0.5, FAR_METRES);
        let mut runtime = runtime(hero_game(Draws::Character, far, far), 1);
        presenter.set_capturing(false);
        let mut evaluated = 0;
        for _ in 0..LIVE_TICKS {
            runtime.step(FIXED_STEP_MS);
            presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("drawn");
            evaluated += presenter.character_stats().evaluated;
        }
        assert!(evaluated <= (LIVE_TICKS / 4) as u32, "Live evaluated {evaluated} times in {LIVE_TICKS} ticks");
        let hero = runtime.sim().world.hero.clone().expect("the hero");
        let full = palette_of(&hero);
        let expected = genex::present::palette_digest(&[full]);
        capture(&mut presenter, &mut runtime, View::Game, "an17-far-capture");
        assert_eq!(presenter.character_stats().palette_digest, expected, "the capture draws the full-rate pose");
    }
}
