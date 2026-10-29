//! A skinned GLB's armature (B8): an "Armature" node above the mesh and the root joint, turned and
//! scaled (Mixamo, Meshy and Uthana write it turned 90° about X at 0.01, the joints in
//! centimetres). glTF places a skinned vertex at `global(joint) × inverse bind`, the armature
//! included; the renderer's palette takes the skinned mesh node's frame out, so `frame.character`
//! draws under `transform × mesh frame`. Then a character stands upright at its real size, where
//! its bind-pose model and `socket` put it, instead of lying on its back 100 times too big.
//!
//! Separate clip files on one rig (B8): `with_clip_files` adds the first animation of each
//! skeleton-only GLB (one per clip, as Uthana delivers them), its channels matched to the rig's
//! joints by name, under the name the game gives it.

#[path = "../../genex-anim/tests/support/mod.rs"]
mod rigs;

use std::sync::LazyLock;

use genex::present::{AssetCache, ModelSource, Uploads, to_scene};
use genex::prelude::*;
use genex::{AnimationErrorCode, AssetTable, CharacterAsset, FIXED_STEP_MS, Runtime, View};
use genex_render::RenderError;
use genex_render::mesh::MeshData;
use genex_render::scene::{MeshId, MeshLibrary};
use genex_render::skin::{SkinId, SkinnedModel, skin_vertices_cpu};
use genex_render::texture::{TextureData, TextureId, TextureKind};

/// Matrices composed in another order differ by float rounding, at most this much per entry.
const TOLERANCE: f32 = 1e-4;

/// A Mixamo-style rig: the armature turned 90° about X at scale 0.01, its joints in centimetres.
static MIXAMO: LazyLock<&'static [u8]> = LazyLock::new(|| Box::leak(rigs::mixamo().glb().into_boxed_slice()));
/// A rig whose mesh node is the scene's identity: its draw is the game's transform alone.
static HUMANOID: LazyLock<&'static [u8]> = LazyLock::new(|| Box::leak(rigs::humanoid22().glb().into_boxed_slice()));
/// The Mixamo rig's file with its own clip turned and its mesh unbound: one clip, no skinned mesh.
static WAVE: LazyLock<&'static [u8]> = LazyLock::new(|| Box::leak(skeleton_only(wave_rig()).into_boxed_slice()));
/// The Mixamo rig's skeleton with no animation at all.
static STILL: LazyLock<&'static [u8]> = LazyLock::new(|| {
    let mut rig = rigs::mixamo();
    rig.clips.clear();
    Box::leak(skeleton_only(rig).into_boxed_slice())
});

fn table() -> AssetTable {
    static TABLE: LazyLock<AssetTable> =
        LazyLock::new(|| Box::leak(vec![("mixamo.glb", *MIXAMO), ("humanoid.glb", *HUMANOID), ("clips/wave.glb", *WAVE), ("clips/still.glb", *STILL)].into_boxed_slice()));
    *TABLE
}

/// The Mixamo rig with a clip turning its left arm the other way, named "Take 001".
fn wave_rig() -> rigs::RigSpec {
    let mut rig = rigs::mixamo();
    let clip = &mut rig.clips[0];
    clip.name = "Take 001".to_owned();
    clip.channels[0].values = [Quat::IDENTITY, Quat::from_rotation_z(-1.0)].iter().flat_map(|q| q.to_array()).collect();
    rig
}

/// `rig` as a skeleton-only GLB: the same nodes and clips, the mesh node holding no skinned mesh.
fn skeleton_only(rig: rigs::RigSpec) -> Vec<u8> {
    let (json, bin) = rig.json_and_bin();
    let unbound = json.replace(r#","mesh":0,"skin":0"#, "");
    assert_ne!(unbound, json, "the fixture's mesh node was unbound");
    rigs::glb(&unbound, &bin)
}

#[derive(Default)]
struct World {
    hero: Option<Animator>,
    asset: Option<CharacterAsset>,
    refusals: Vec<AnimationErrorCode>,
}

/// A game drawing `path`'s character at rest under `at`.
fn game(path: &'static str, at: Transform) -> Game<World> {
    let mut game = Game::new(World::default()).title("Armature").world_size(128, 96);
    game.camera(|_| Camera::look_at(vec3(0.0, 1.0, 4.0), vec3(0.0, 1.0, 0.0)));
    game.on_reset(move |sim, _, _, gfx| {
        let hero = gfx.character(path).expect("the rig loads");
        let graph = hero.graph().build_simple().expect("a simple graph");
        sim.world.hero = Some(hero.animator(&graph).expect("an animator"));
    });
    game.on_draw(move |sim, frame, _| {
        if let Some(hero) = &sim.world.hero {
            frame.character(hero, at);
        }
    });
    game
}

fn runtime(game: Game<World>) -> Runtime<World> {
    let mut runtime = Runtime::with_assets(game, Box::new(table())).expect("valid game");
    runtime.seed(1);
    runtime.start();
    runtime.step(FIXED_STEP_MS);
    runtime
}

/// A renderer stand-in over a CPU mesh library.
#[derive(Default)]
struct Library {
    library: MeshLibrary,
}

impl Uploads for Library {
    fn add_mesh(&mut self, mesh: MeshData) -> Result<MeshId, RenderError> {
        self.library.add(mesh)
    }

    fn add_texture(&mut self, _data: &TextureData, kind: TextureKind) -> Result<TextureId, RenderError> {
        Ok(TextureId::new(kind, 0))
    }

    fn add_skinned_model(&mut self, model: &SkinnedModel) -> Result<SkinId, RenderError> {
        self.library.add_skinned_parts(&model.data, &model.parts)
    }
}

/// The one skinned draw of `runtime`'s game view: its model matrix and palette.
fn skinned_draw(runtime: &mut Runtime<World>) -> (Mat4, Vec<[f32; 16]>) {
    let frame = runtime.frame(View::Game).expect("the game view");
    let camera = runtime.camera(View::Game).expect("the game camera");
    let mut cache = AssetCache::default();
    let source: &dyn ModelSource = &table();
    cache.load(&frame, source, &mut Library::default(), &mut |line| eprintln!("{line}")).expect("no device to lose");
    let scene = to_scene(&frame, &camera, &cache);
    assert_eq!(scene.skinned.len(), 1, "one skinned draw");
    let draw = &scene.skinned[0];
    (Mat4::from_cols_array(&draw.model), draw.joints.clone())
}

fn assert_near(got: Mat4, want: Mat4, what: &str) {
    let worst = got.to_cols_array().iter().zip(want.to_cols_array()).map(|(a, b)| (a - b).abs()).fold(0.0_f32, f32::max);
    assert!(worst <= TOLERANCE, "{what}: off by {worst}\n got {got:?}\nwant {want:?}");
}

#[test]
fn a_turned_and_scaled_armature_draws_each_joint_where_its_socket_is() {
    let at = Transform::from_xyz(2.0, 0.0, -1.0);
    let mut runtime = runtime(game("mixamo.glb", at));
    let (model, palette) = skinned_draw(&mut runtime);
    let hero = runtime.sim().world.hero.clone().expect("the hero");
    let skeleton = hero.set().skeleton();
    let rig = rigs::mixamo();
    let inverse_bind = rig.inverse_bind();
    for (slot, &joint) in skeleton.skin_order().iter().enumerate() {
        // A vertex bound wholly to this joint, at its bind position, is drawn where the joint is.
        let drawn = model * Mat4::from_cols_array(&palette[slot]) * Mat4::from_cols_array(&inverse_bind[slot]).inverse();
        assert_near(drawn, hero.socket(joint, at.matrix()), &format!("joint {}", skeleton.name(joint)));
    }
}

#[test]
fn a_mixamo_rig_at_rest_stands_at_its_bind_pose_size_not_100_times_larger() {
    let mut runtime = runtime(game("mixamo.glb", Transform::IDENTITY));
    let (model, palette) = skinned_draw(&mut runtime);
    let data = SkinnedModel::from_glb(&MIXAMO).expect("the renderer loads it").data;
    let skinned = skin_vertices_cpu(&data.mesh, &data.skin, &palette);
    let rig = rigs::mixamo();
    let mesh_global = rig.rest_globals()[rig.mesh_node];
    for (vertex, bind) in skinned.iter().zip(&data.mesh.vertices) {
        let drawn = model.transform_point3(Vec3::from(vertex.position));
        let want = mesh_global.transform_point3(Vec3::from(bind.position));
        assert!(drawn.distance(want) <= TOLERANCE, "drawn {drawn:?}, the bind pose puts it at {want:?}");
    }
}

#[test]
fn a_rig_whose_mesh_node_is_the_identity_draws_under_the_games_transform_alone() {
    let at = Transform::from_xyz(1.0, 0.0, 0.5);
    let mut runtime = runtime(game("humanoid.glb", at));
    let (model, _) = skinned_draw(&mut runtime);
    assert_near(model, at.matrix(), "the draw's model matrix");
}

/// A game that loads the Mixamo rig and adds `clips/wave.glb` as "Wave".
fn clip_game(files: &'static [(&'static str, &'static str)]) -> Game<World> {
    let mut game = Game::new(World::default()).title("Clips").world_size(128, 96);
    game.on_reset(move |sim, _, _, gfx| {
        let hero = gfx.character("mixamo.glb").expect("the rig loads");
        match hero.with_clip_files(gfx.assets(), files) {
            Ok(merged) => sim.world.asset = Some(merged),
            Err(error) => sim.world.refusals.push(error.code),
        }
        if let Err(error) = gfx.character("clips/wave.glb") {
            sim.world.refusals.push(error.code);
        }
    });
    game
}

#[test]
fn clip_files_join_the_rig_under_the_names_the_game_gives_them() {
    let runtime = runtime(clip_game(&[("Wave", "clips/wave.glb")]));
    let world = &runtime.sim().world;
    assert_eq!(world.refusals, vec![AnimationErrorCode::AssetInvalid], "a skeleton-only file is no character of its own");
    let merged = world.asset.as_ref().expect("the clip file joined the rig");
    assert_eq!(merged.clip_names().collect::<Vec<_>>(), vec!["mixamo.com", "Wave"], "its own clip, then the file's under the given name");
    let wave = merged.clip("Wave").expect("the added clip");
    let mut g = merged.graph();
    let base = g.layer("base");
    g.state(base, "wave", genex::animation::Motion::clip(wave));
    let mut animator = merged.animator(&g.build().expect("builds")).expect("an animator");
    let start = animator.pose().to_vec();
    // Half way through the 1 s loop (a whole second wraps back to its first key).
    animator.update(0.5);
    let joint = merged.skeleton().find("mixamorig:LeftArm").expect("the clip's joint");
    let turned = animator.pose()[usize::from(joint.raw())];
    assert_ne!(turned, start[usize::from(joint.raw())], "the added clip drives the joint its file names");
    let half_turn = Quat::from_rotation_z(-0.5);
    assert!(turned.rotation.angle_between(half_turn) < 1e-3, "the file's own keys, not the rig's clip: {turned:?}");
}

#[test]
fn a_clip_file_that_is_missing_or_has_no_animation_is_refused_by_code() {
    let runtime = runtime(clip_game(&[("Wave", "clips/none.glb")]));
    assert_eq!(runtime.sim().world.refusals[0], AnimationErrorCode::AssetInvalid, "a file the build does not have");
    let runtime = self::runtime(clip_game(&[("Wave", "clips/still.glb")]));
    assert_eq!(runtime.sim().world.refusals[0], AnimationErrorCode::ClipMissing, "a file with no animation");
    let runtime = self::runtime(clip_game(&[("mixamo.com", "clips/wave.glb")]));
    assert_eq!(runtime.sim().world.refusals[0], AnimationErrorCode::AssetInvalid, "a name the rig's clips already use");
}

// ---------------------------------------------------------------------------------------------
// GPU rows: `#[ignore]`d, every name contains `metal`:
//
//   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex \
//     --test armature_frame -- --ignored metal

mod metal {
    use super::*;
    use genex::present::Presenter;

    /// The capture size.
    const WORLD: [u32; 2] = [128, 96];
    /// Pixels a skinned rest pose may differ from the bind-pose model by (rasterization on edges), of 12,288.
    const EDGE_PIXELS: usize = 61;
    /// The Mixamo rig's centimetre mesh drawn 100 times larger: its 1 cm triangle becomes 1 m.
    const METRES: f32 = 100.0;

    /// What the GPU game draws.
    #[derive(Clone, Copy, PartialEq)]
    enum Draws {
        Character,
        BindPose,
        Nothing,
    }

    #[derive(Default)]
    struct Shown {
        hero: Option<Animator>,
        bind: Model,
    }

    /// The Mixamo rig at rest, lit, seen from below (its triangle faces down once the armature
    /// turns it), drawn as `draws` says.
    fn shown(draws: Draws) -> Runtime<Shown> {
        let mut game = Game::new(Shown::default()).title("Armature").world_size(WORLD[0], WORLD[1]);
        game.camera(|_| Camera::look_at(vec3(0.4, -1.6, 1.4), vec3(0.4, 0.0, 0.4)));
        game.on_reset(|sim, _, _, gfx| {
            let hero = gfx.character("mixamo.glb").expect("the rig loads");
            let graph = hero.graph().build_simple().expect("a simple graph");
            sim.world.hero = Some(hero.animator(&graph).expect("an animator"));
            sim.world.bind = gfx.assets().model("mixamo.glb");
        });
        game.on_draw(move |sim, frame, _| {
            frame.sun(vec3(0.2, -1.0, 0.4), Color::WHITE, 3.0);
            let at = Transform::IDENTITY.with_scale(Vec3::splat(METRES));
            match (draws, &sim.world.hero) {
                (Draws::Character, Some(hero)) => frame.character(hero, at),
                (Draws::BindPose, _) => frame.model(&sim.world.bind, at),
                _ => frame,
            };
        });
        let mut runtime = Runtime::with_assets(game, Box::new(table())).expect("valid game");
        runtime.seed(1);
        runtime.start();
        runtime.step(FIXED_STEP_MS);
        runtime
    }

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

    /// The settled capture of the game view as BGRA.
    fn capture(presenter: &mut Presenter, runtime: &mut Runtime<Shown>) -> Vec<u8> {
        presenter.set_capturing(true);
        presenter.draw_view(runtime, View::Game).expect("a view").expect("drawn");
        assert_eq!(presenter.failure(), None);
        presenter.resilient.capture().expect("capture").bgra().to_vec()
    }

    /// Pixels of two BGRA captures differing in any colour channel by more than 2.
    fn differing(a: &[u8], b: &[u8]) -> usize {
        a.as_chunks::<4>().0.iter().zip(b.as_chunks::<4>().0).filter(|(p, q)| (0..3).any(|c| p[c].abs_diff(q[c]) > 2)).count()
    }

    #[test]
    #[ignore = "needs a GPU: run with --ignored metal"]
    fn metal_a_mixamo_rig_skinned_at_rest_covers_the_pixels_of_its_bind_pose_model() {
        let Some(mut presenter) = open_presenter() else { return };
        let skinned = capture(&mut presenter, &mut shown(Draws::Character));
        assert_eq!(presenter.character_stats().drawn, 1, "drawn skinned");
        let bind = capture(&mut presenter, &mut shown(Draws::BindPose));
        let empty = capture(&mut presenter, &mut shown(Draws::Nothing));
        let covered = differing(&bind, &empty);
        assert!(covered > 200, "the bind-pose model is in view: {covered} pixels");
        let off = differing(&skinned, &bind);
        eprintln!("bind pose covers {covered} pixels; the skinned rest pose differs from it in {off}");
        assert!(off <= EDGE_PIXELS, "the skinned rest pose stands where the bind-pose model does: {off} pixels differ");
    }
}
