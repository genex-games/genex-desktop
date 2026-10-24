//! Hook semantics of the headless reference runtime: seeding, ticking, the input edges, read
//! hooks that never move the checksum, demos, physics and the egui input path.

use genex::physics::{ColliderBuilder, RigidBodyBuilder, RigidBodyHandle};
use genex::prelude::*;
use genex::{FIXED_STEP_MS, MAX_STEP_TICKS, Runtime, step_ticks};

#[derive(Default)]
struct World {
    rolls: Vec<u32>,
    presses: u32,
    taps: u32,
    ticks: u32,
    order: Vec<&'static str>,
    ball: Option<RigidBodyHandle>,
    bought: u32,
    name: String,
}

fn dice_game() -> Game<World> {
    let mut game = Game::new(World::default()).title("Dice");
    game.on_reset(|sim, seed, rng, _gfx| {
        sim.world.rolls.push(seed);
        sim.world.rolls.push(rng.below(1000));
    });
    game.on_update(|sim, ctx| {
        sim.world.ticks += 1;
        sim.world.rolls.push(ctx.rng.below(1000));
        if ctx.keys.pressed(Key::Space) {
            sim.world.presses += 1;
        }
        if ctx.touches.tapped() {
            sim.world.taps += 1;
        }
    });
    game.probe("dice", |sim| json!({ "rolls": sim.world.rolls, "presses": sim.world.presses }));
    game.probe_volatile("debug", |sim| json!(sim.world.ticks));
    game
}

fn runtime(game: Game<World>) -> Runtime<World> {
    Runtime::new(game).expect("a consistent game installs")
}

#[test]
fn step_runs_rounded_fixed_ticks_with_at_least_one_and_a_cap() {
    assert_eq!(step_ticks(0.0), 1);
    assert_eq!(step_ticks(FIXED_STEP_MS), 1);
    assert_eq!(step_ticks(1000.0), 60);
    assert_eq!(step_ticks(2000.0), 120);
    assert_eq!(step_ticks(f64::NAN), 1);
    assert_eq!(step_ticks(-50.0), 1);
    assert_eq!(step_ticks(1.0e12), MAX_STEP_TICKS);
    let mut rt = runtime(dice_game());
    rt.seed(1);
    let step = rt.step(1000.0);
    assert_eq!((step.ticks, step.frame), (60, 60));
    assert_eq!(rt.sim().world.ticks, 60);
}

#[test]
fn live_frames_pace_like_genex_core_frame_clock_and_start_resets_the_carry() {
    let mut game = runtime(dice_game());
    assert_eq!(game.advance_live(250.0), 0, "a paused game runs no live ticks");
    game.start();
    // 250 ms is 14.999… steps in floats: the golden-checked clock (and C++ clock.cpp) runs 15.
    assert_eq!(game.advance_live(250.0), 15);
    assert_eq!(game.advance_live(1000.0), 15, "a stalled frame counts at most 250 ms");
    assert_eq!(game.advance_live(f64::NAN), 0);
    assert_eq!(game.advance_live(-5.0), 0);
    assert_eq!(game.advance_live(10.0), 0, "10 ms is carried");
    game.pause();
    game.start();
    assert_eq!(game.advance_live(10.0), 0, "start forgot the carry: 10 + 10 ms would have ticked");
    let mut replay = runtime(dice_game());
    replay.start();
    let mut paced = genex_core_clock();
    for frame_ms in [16.0, 17.0, 16.5, 33.4, 8.3, 250.0, 0.1, 16.6] {
        assert_eq!(replay.advance_live(frame_ms), paced.advance(frame_ms), "{frame_ms} ms");
    }
}

fn genex_core_clock() -> genex_core::clock::FrameClock {
    genex_core::clock::FrameClock::default()
}

#[test]
fn the_same_seed_gives_the_same_stream_and_checksum() {
    let mut a = runtime(dice_game());
    let mut b = runtime(dice_game());
    for rt in [&mut a, &mut b] {
        rt.seed(42);
        rt.step(500.0);
    }
    assert_eq!(a.sim().world.rolls, b.sim().world.rolls);
    assert_eq!(a.checksum(), b.checksum());
    b.seed(43);
    b.step(500.0);
    assert_ne!(a.sim().world.rolls, b.sim().world.rolls);
    assert_ne!(a.checksum(), b.checksum());
}

#[test]
fn seed_rebuilds_the_world_from_default_and_pauses() {
    let mut rt = runtime(dice_game());
    rt.seed(7);
    rt.start();
    rt.step(200.0);
    rt.seed(7);
    assert!(!rt.running());
    assert_eq!(rt.sim().world.ticks, 0);
    assert_eq!(rt.sim().world.rolls.first(), Some(&7));
    assert_eq!(rt.sim().world.rolls.len(), 2);
}

#[test]
fn reset_hooks_run_in_registration_order() {
    let mut game = Game::new(World::default());
    game.on_reset(|sim, _, _, _| sim.world.order.push("first"));
    game.on_reset(|sim, _, _, _| sim.world.order.push("second"));
    let mut rt = runtime(game);
    rt.seed(1);
    assert_eq!(rt.sim().world.order, ["first", "second"]);
}

#[test]
fn reading_state_frames_cameras_and_probes_never_moves_the_checksum() {
    let mut game = dice_game();
    game.on_draw(|sim, frame, _camera| {
        frame.tag("dice");
        for _ in &sim.world.rolls {
            frame.cube(Transform::IDENTITY, Color::WHITE);
        }
    });
    game.named_camera("top", |_| Camera::look_at(vec3(0.0, 20.0, 0.1), Vec3::ZERO));
    let mut rt = runtime(game);
    rt.seed(9);
    rt.step(100.0);
    let before = rt.checksum();
    for _ in 0..5 {
        let frame = rt.frame(View::Named("top")).expect("the named camera exists");
        assert_eq!(frame.draw_calls(), rt.sim().world.rolls.len() as u32);
        assert_eq!(frame.tags().get("dice"), Some(&frame.draw_calls()));
        let _ = rt.state();
        let _ = rt.probes();
    }
    assert_eq!(rt.checksum(), before);
}

#[test]
fn volatile_probes_are_reported_but_left_out_of_the_checksum() {
    let mut game = Game::new(World::default());
    game.probe_volatile("ticks", |sim| json!(sim.world.ticks));
    let mut rt = runtime(game);
    rt.seed(1);
    let before = rt.checksum();
    rt.sim_mut().world.ticks = 99;
    assert_eq!(rt.state()["volatile"]["ticks"], json!(99));
    assert_eq!(rt.checksum(), before);
}

#[test]
fn state_merges_probes_after_the_runtime_keys_in_registration_order() {
    let mut game = Game::new(World::default());
    game.probe("zeta", |_| json!(1));
    game.probe("alpha", |_| json!(2));
    let mut rt = runtime(game);
    rt.seed(5);
    let state = rt.state();
    assert_eq!(state["seed"], json!(5));
    assert_eq!(state["frame"], json!(0));
    assert_eq!(state["zeta"], json!(1));
    let names: Vec<String> = rt.probes().keys().cloned().collect();
    assert_eq!(names, ["zeta", "alpha"]);
}

#[test]
fn a_tap_is_pressed_on_exactly_one_tick() {
    let mut rt = runtime(dice_game());
    rt.seed(1);
    rt.inject(Input::key_tap(Key::Space));
    rt.step(FIXED_STEP_MS * 5.0);
    assert_eq!(rt.sim().world.presses, 1);
    assert!(rt.held().is_empty());
}

#[test]
fn a_held_key_presses_once_and_is_held_until_released() {
    let mut rt = runtime(dice_game());
    rt.seed(1);
    let held = rt.inject(Input::key_down(Key::Space));
    assert_eq!(held, ["Space"]);
    rt.step(FIXED_STEP_MS * 3.0);
    assert_eq!(rt.sim().world.presses, 1);
    let held = rt.inject(Input::key_up(Key::Space));
    assert!(held.is_empty());
}

#[test]
fn a_mouse_click_also_arrives_as_one_touch_tap() {
    let mut rt = runtime(dice_game());
    rt.seed(1);
    rt.inject(Input::click_at(0.5, 0.5));
    rt.step(FIXED_STEP_MS * 3.0);
    assert_eq!(rt.sim().world.taps, 1);
}

#[test]
fn a_demo_drives_the_simulation_and_leaves_it_paused() {
    let mut game = dice_game();
    game.demo("press", |d| {
        d.inject(Input::key_tap(Key::Space));
        let step = d.advance_ms(1000);
        json!({ "ticks": step.ticks, "presses": d.sim().world.presses })
    });
    let mut rt = runtime(game);
    rt.seed(1);
    rt.start();
    let result = rt.demo("press").expect("the demo exists");
    assert_eq!(result, json!({ "ticks": 60, "presses": 1 }));
    assert!(!rt.running());
    assert_eq!(rt.demos(), ["press"]);
    let unknown = rt.demo("absent").expect_err("no such demo");
    assert_eq!(unknown.available, ["press"]);
}

#[test]
fn physics_steps_once_per_tick_after_update() {
    let mut game = Game::new(World::default());
    game.on_reset(|sim, _, _, _| {
        let (body, _collider) =
            sim.physics.insert(RigidBodyBuilder::dynamic().translation(vec3(0.0, 10.0, 0.0)), ColliderBuilder::ball(0.5));
        sim.world.ball = Some(body);
    });
    game.probe("y", |sim| {
        let ball = sim.world.ball.and_then(|h| sim.physics.bodies.get(h));
        json!(ball.map(|b| b.translation().y))
    });
    let mut rt = runtime(game);
    rt.seed(1);
    rt.step(1000.0);
    let y = rt.probes()["y"].as_f64().expect("the ball exists");
    // One second of free fall from 10 m under -9.81 m/s^2 lands near 5.1 m.
    assert!((4.5..5.6).contains(&y), "y = {y}");
}

#[test]
fn an_injected_click_on_an_egui_button_reaches_on_ui() {
    let mut game = Game::new(World::default()).world_size(400, 300);
    game.on_ui(|sim, ui, _ctx| {
        if ui.button("Buy bait").clicked() {
            sim.world.bought += 1;
        }
    });
    let mut rt = runtime(game);
    rt.seed(1);
    // The button is laid out at the top-left, inside the HUD's 16 pt margin (R-25); aim a few
    // pixels into it.
    let (x, y) = (24.0 / 400.0, 24.0 / 300.0);
    rt.inject(Input::pointer(x, y));
    rt.step(FIXED_STEP_MS);
    rt.inject(Input::click_at(x, y));
    rt.step(FIXED_STEP_MS * 2.0);
    assert_eq!(rt.sim().world.bought, 1);
}

#[test]
fn the_keyboard_is_wanted_once_a_tap_focuses_a_hud_text_field() {
    let mut game = Game::new(World::default()).world_size(400, 300);
    game.on_ui(|sim, ui, _ctx| {
        ui.text_edit_singleline(&mut sim.world.name);
    });
    let mut rt = runtime(game);
    rt.seed(1);
    rt.step(FIXED_STEP_MS);
    assert!(!rt.keyboard_wanted(), "no field has focus before a tap");
    // The field is laid out at the top-left, inside the HUD's 16 pt margin (R-25); aim a few
    // pixels into it.
    let (x, y) = (24.0 / 400.0, 24.0 / 300.0);
    rt.inject(Input::pointer(x, y));
    rt.step(FIXED_STEP_MS);
    rt.inject(Input::click_at(x, y));
    rt.step(FIXED_STEP_MS * 2.0);
    assert!(rt.keyboard_wanted(), "the tapped field has focus, so a phone raises its keyboard");
}

/// Pass-1 gate: Space on a focused settings-panel switch also toggled the showcase's tour.
#[test]
fn keys_go_to_a_focused_hud_widget_and_not_to_the_update_hooks_until_escape_releases_it() {
    let mut game = Game::new(World::default()).world_size(400, 300);
    game.on_update(|sim, ctx| {
        if ctx.keys.pressed(Key::Space) {
            sim.world.presses += 1;
        }
        if ctx.keys.down(Key::KeyW) {
            sim.world.ticks += 1;
        }
    });
    game.on_ui(|sim, ui, _ctx| {
        if ui.button("Panel switch").clicked() {
            sim.world.bought += 1;
        }
    });
    let mut rt = runtime(game);
    rt.seed(1);
    rt.step(FIXED_STEP_MS);
    rt.inject(Input::key_tap(Key::Space));
    rt.step(FIXED_STEP_MS);
    assert_eq!((rt.sim().world.presses, rt.sim().world.bought), (1, 0), "nothing focused: the game has Space");
    rt.inject(Input::key_tap(Key::Tab));
    rt.step(FIXED_STEP_MS);
    rt.inject(Input::key_tap(Key::Space));
    rt.step(FIXED_STEP_MS * 2.0);
    assert_eq!((rt.sim().world.presses, rt.sim().world.bought), (1, 1), "the focused switch has Space, the game does not");
    rt.inject(Input::key_down(Key::KeyW));
    rt.step(FIXED_STEP_MS * 3.0);
    assert_eq!(rt.sim().world.ticks, 0, "a key held while a widget has focus does not reach the game");
    rt.inject(Input::key_up(Key::KeyW).and(Input::key_tap(Key::Escape)));
    rt.step(FIXED_STEP_MS);
    rt.inject(Input::key_tap(Key::Space));
    rt.step(FIXED_STEP_MS);
    assert_eq!((rt.sim().world.presses, rt.sim().world.bought), (2, 1), "Escape gives the keys back to the game");
}

#[test]
fn an_android_shell_rebases_the_saves_onto_the_activitys_internal_data_folder() {
    let data = std::env::temp_dir().join(format!("genex-android-data-{}", std::process::id()));
    std::fs::create_dir_all(&data).expect("a private data folder");
    let data = data.to_str().expect("a UTF-8 temp folder").to_owned();
    let mut rt = runtime(dice_game());
    rt.use_android_data(&data);
    assert_eq!(rt.saves().root(), Some(format!("{data}/").as_str()));
    assert!(rt.saves().save("slot.json", b"{}"));
    assert_eq!(std::fs::read(format!("{data}/slot.json")).ok().as_deref(), Some(&b"{}"[..]));
    // Not an absolute folder: no save root at all, never one the process environment names.
    rt.use_android_data("relative/data");
    assert_eq!(rt.saves().root(), None);
    let _ = std::fs::remove_dir_all(&data);
}

#[test]
fn assets_requested_at_reset_are_listed_and_unsafe_paths_are_missing_models() {
    let mut game = Game::new(World::default());
    game.on_reset(|_, _, _, gfx| {
        assert!(!gfx.assets().model("pond.glb").is_missing());
        for hostile in ["../escape.glb", "/abs.glb", "a\\b.glb", "", "dir//x.glb", "./x.glb"] {
            assert!(gfx.assets().model(hostile).is_missing(), "{hostile}");
        }
    });
    let mut rt = runtime(game);
    rt.seed(1);
    assert_eq!(rt.state()["assets"], json!(["pond.glb"]));
}

// Runtime texture facts (C-11): `__render.textures` and `__render.assetIssues`.

mod texture_facts {
    use genex::present::{AssetCache, AssetIssue, AssetIssueCode, ModelSource, TextureFact, TextureOrigin, Uploads, texture_facts};
    use genex::prelude::*;
    use genex::{Frame, Transform};
    use genex_render::{RenderCode, RenderError};
    use genex_render::device_loss::CompressedSource;
    use genex_render::mesh::MeshData;
    use genex_render::scene::MeshId;
    use genex_render::texture::{CompressedTexture, TextureData, TextureFamily, TextureId, TextureKind};

    const BARK: &str = "textures/bark.png";
    const BARK_BC: &str = "textures/bark.bc.ktx2";
    const MOSS: &str = "textures/moss.png";
    const CRATE: &str = "props/crate.glb";

    /// A 2x2 opaque white PNG (stored deflate).
    pub(super) const WHITE_PNG: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x02, 0x00,
        0x00, 0x00, 0x02, 0x08, 0x06, 0x00, 0x00, 0x00, 0x72, 0xb6, 0x0d, 0x24, 0x00, 0x00, 0x00, 0x1d, 0x49, 0x44, 0x41, 0x54, 0x78,
        0x01, 0x01, 0x12, 0x00, 0xed, 0xff, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0xff, 0xff, 0x8f, 0x82, 0x0f, 0xf1, 0x6d, 0x9e, 0x54, 0xf2, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42,
        0x60, 0x82,
    ];

    /// A family file the Studio's import step wrote (BC7, `tests/conformance/rust-assets-ktx2.test.ts`).
    fn bc_file() -> Vec<u8> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/asset-import/basis-uastc-64.bc.ktx2");
        std::fs::read(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
    }

    /// A unit quad whose material samples an embedded copy of [`WHITE_PNG`] as its base colour.
    fn quad_glb() -> Vec<u8> {
        let positions: [f32; 12] = [-1.0, -1.0, 0.0, 1.0, -1.0, 0.0, 1.0, 1.0, 0.0, -1.0, 1.0, 0.0];
        let normals: [f32; 12] = [0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0];
        let uvs: [f32; 8] = [0.0, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0];
        let indices: [u16; 6] = [0, 1, 2, 0, 2, 3];
        let mut bin: Vec<u8> = positions.iter().chain(&normals).chain(&uvs).flat_map(|f| f.to_le_bytes()).collect();
        bin.extend(indices.iter().flat_map(|i| i.to_le_bytes()));
        let image_at = bin.len();
        bin.extend(WHITE_PNG);
        while !bin.len().is_multiple_of(4) {
            bin.push(0);
        }
        let gltf = json!({
            "asset": { "version": "2.0" },
            "buffers": [{ "byteLength": bin.len() }],
            "bufferViews": [
                { "buffer": 0, "byteOffset": 0, "byteLength": 48 },
                { "buffer": 0, "byteOffset": 48, "byteLength": 48 },
                { "buffer": 0, "byteOffset": 96, "byteLength": 32 },
                { "buffer": 0, "byteOffset": 128, "byteLength": 12 },
                { "buffer": 0, "byteOffset": image_at, "byteLength": WHITE_PNG.len() },
            ],
            "accessors": [
                { "bufferView": 0, "componentType": 5126, "count": 4, "type": "VEC3", "min": [-1.0, -1.0, 0.0], "max": [1.0, 1.0, 0.0] },
                { "bufferView": 1, "componentType": 5126, "count": 4, "type": "VEC3" },
                { "bufferView": 2, "componentType": 5126, "count": 4, "type": "VEC2" },
                { "bufferView": 3, "componentType": 5123, "count": 6, "type": "SCALAR" },
            ],
            "images": [{ "bufferView": 4, "mimeType": "image/png" }],
            "textures": [{ "source": 0 }],
            "materials": [{ "pbrMetallicRoughness": { "baseColorTexture": { "index": 0 } } }],
            "meshes": [{ "primitives": [{ "attributes": { "POSITION": 0, "NORMAL": 1, "TEXCOORD_0": 2 }, "indices": 3, "material": 0 }] }],
            "nodes": [{ "mesh": 0 }],
            "scenes": [{ "nodes": [0] }],
            "scene": 0,
        });
        let mut json = gltf.to_string().into_bytes();
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

    /// A game's files by path.
    struct Files(Vec<(&'static str, Vec<u8>)>);

    impl ModelSource for Files {
        fn model_bytes(&self, path: &str) -> Option<Vec<u8>> {
            self.0.iter().find(|(known, _)| *known == path).map(|(_, bytes)| bytes.clone())
        }
    }

    /// A renderer stand-in offering `families` for compressed textures and taking everything.
    struct Renderer {
        families: Vec<TextureFamily>,
        family: TextureFamily,
        /// Refuse every compressed texture `texture-too-large` (every size class it fits is full).
        classes_full: bool,
    }

    impl Renderer {
        fn offering(families: &[TextureFamily]) -> Renderer {
            Renderer { families: families.to_vec(), family: TextureFamily::Rgba8, classes_full: false }
        }
    }

    impl Uploads for Renderer {
        fn add_mesh(&mut self, _mesh: MeshData) -> Result<MeshId, RenderError> {
            Ok(MeshId::from_raw(10))
        }

        fn add_texture(&mut self, _data: &TextureData, kind: TextureKind) -> Result<TextureId, RenderError> {
            Ok(TextureId::new(kind, 0))
        }

        fn compressed_families(&self) -> Vec<TextureFamily> {
            self.families.clone()
        }

        fn texture_family(&self) -> TextureFamily {
            self.family
        }

        fn set_texture_family(&mut self, family: TextureFamily) -> Result<(), RenderError> {
            self.family = family;
            Ok(())
        }

        fn add_compressed_texture(&mut self, _texture: &CompressedTexture, kind: TextureKind, _source: Option<CompressedSource>) -> Result<TextureId, RenderError> {
            if self.classes_full {
                return Err(RenderError::refused(RenderCode::TextureTooLarge, "every Normal size class it fits is full"));
            }
            Ok(TextureId::new(kind, 1))
        }
    }

    /// The facts of `frame` after loading it from `files` into a renderer offering `families`.
    fn facts(frame: &Frame, files: &Files, families: &[TextureFamily]) -> (Vec<TextureFact>, Vec<AssetIssue>) {
        let mut cache = AssetCache::default();
        cache.load(frame, files, &mut Renderer::offering(families), &mut |_| {}).expect("no device loss");
        texture_facts(frame, &cache)
    }

    fn fact(path: &str, kind: TextureKind, origin: TextureOrigin) -> TextureFact {
        TextureFact { path: path.to_owned(), kind, origin }
    }

    fn normal_mapped(path: &str) -> Frame {
        let mut frame = Frame::default();
        frame.cube_with(Transform::IDENTITY, &Material::color(Color::WHITE).with_normal_texture(path, 1.0));
        frame
    }

    #[test]
    fn a_normal_map_with_no_family_file_is_a_source_texture_and_an_uncompressed_issue() {
        let (textures, issues) = facts(&normal_mapped(BARK), &Files(vec![(BARK, WHITE_PNG.to_vec())]), &[TextureFamily::Bc7]);
        assert_eq!(textures, [fact(BARK, TextureKind::Normal, TextureOrigin::Source)]);
        assert_eq!(issues, [AssetIssue { path: BARK.to_owned(), code: AssetIssueCode::TextureUncompressed }]);
        assert_eq!(textures[0].usage(), "normal");
    }

    #[test]
    fn a_shipped_family_file_is_reported_as_its_family_with_no_issue() {
        let files = Files(vec![(BARK, WHITE_PNG.to_vec()), (BARK_BC, bc_file())]);
        let (textures, issues) = facts(&normal_mapped(BARK), &files, &[TextureFamily::Bc7]);
        assert_eq!(textures, [fact(BARK, TextureKind::Normal, TextureOrigin::Family(TextureFamily::Bc7))]);
        assert!(issues.is_empty(), "{issues:?}");
        // A device that samples no family the game ships loads the image, but the import did its
        // part: nothing for an agent to fix.
        let (textures, issues) = facts(&normal_mapped(BARK), &files, &[TextureFamily::Etc2Rgba8]);
        assert_eq!(textures, [fact(BARK, TextureKind::Normal, TextureOrigin::Source)]);
        assert!(issues.is_empty(), "{issues:?}");
    }

    /// GF round 2 (visual): under BC7, Lakeside's stone normal and ORM files were refused
    /// (`texture-too-large`: every size class they fit was full) and loaded as RGBA8 images, and
    /// `assetIssues` named nothing, so an agent never learnt its maps were drawn uncompressed.
    #[test]
    fn a_shipped_family_file_the_renderer_refuses_is_a_source_texture_and_a_family_refused_issue() {
        let files = Files(vec![(BARK, WHITE_PNG.to_vec()), (BARK_BC, bc_file())]);
        let frame = normal_mapped(BARK);
        let mut cache = AssetCache::default();
        let mut full = Renderer { classes_full: true, ..Renderer::offering(&[TextureFamily::Bc7]) };
        cache.load(&frame, &files, &mut full, &mut |_| {}).expect("no device loss");
        let (textures, issues) = texture_facts(&frame, &cache);
        assert_eq!(textures, [fact(BARK, TextureKind::Normal, TextureOrigin::Source)]);
        let named: Vec<(&str, &str)> = issues.iter().map(|issue| (issue.path.as_str(), issue.code.wire())).collect();
        assert_eq!(named, [(BARK, "texture-family-refused")]);
    }

    #[test]
    fn only_bound_textures_are_facts_one_per_path_in_first_bound_order() {
        let mut frame = Frame::default();
        let both = Material::color(Color::WHITE).with_base_texture(MOSS).with_metal_rough_texture(MOSS).with_normal_texture(BARK, 1.0);
        frame.cube_with(Transform::IDENTITY, &both);
        frame.cube_with(Transform::IDENTITY, &Material::color(Color::WHITE).with_base_texture("textures/missing.png"));
        frame.cube_with(Transform::IDENTITY, &Material::color(Color::WHITE).with_base_texture("../escape.png"));
        frame.cube_with(Transform::IDENTITY, &Material::color(Color::WHITE).with_base_texture("textures/broken.png"));
        let files = Files(vec![(BARK, WHITE_PNG.to_vec()), (MOSS, WHITE_PNG.to_vec()), ("textures/broken.png", b"not a png".to_vec())]);
        let (textures, issues) = facts(&frame, &files, &[]);
        // A missing, unsafe or refused texture is bound to nothing; MOSS (colour and data) once.
        assert_eq!(textures, [fact(MOSS, TextureKind::Color, TextureOrigin::Source), fact(BARK, TextureKind::Normal, TextureOrigin::Source)]);
        assert_eq!(issues.iter().map(|issue| issue.path.as_str()).collect::<Vec<_>>(), [MOSS, BARK]);
        let (textures, _) = facts(&Frame::default(), &files, &[]);
        assert!(textures.is_empty());
    }

    #[test]
    fn a_glb_drawn_with_its_own_material_binds_its_images_as_model_hash_image() {
        let files = Files(vec![(CRATE, quad_glb())]);
        let mut cache = AssetCache::default();
        let model = |frame: &mut Frame, material: Option<&Material>| {
            let handle = genex::Assets::default().model(CRATE);
            match material {
                Some(material) => frame.model_with(&handle, Transform::IDENTITY, material),
                None => frame.model(&handle, Transform::IDENTITY),
            };
        };
        let mut own = Frame::default();
        model(&mut own, None);
        model(&mut own, None);
        cache.load(&own, &files, &mut Renderer::offering(&[]), &mut |_| {}).expect("no device loss");
        let (textures, issues) = texture_facts(&own, &cache);
        assert_eq!(textures, [fact("props/crate.glb#0", TextureKind::Color, TextureOrigin::Source)]);
        let uncompressed = AssetIssue { path: "props/crate.glb#0".to_owned(), code: AssetIssueCode::TextureUncompressed };
        assert_eq!(issues, [uncompressed], "an embedded image the game ships no sidecar of is drawn uncompressed (C-14)");
        let mut replaced = Frame::default();
        model(&mut replaced, Some(&Material::color(Color::WHITE)));
        assert!(texture_facts(&replaced, &cache).0.is_empty(), "a material of the game's own binds none of the GLB's images");
    }

    #[test]
    fn the_facts_are_render_keys_absent_while_empty_and_never_in_the_checksum() {
        let mut game = Game::new(super::World::default());
        game.probe("ticks", |sim| json!(sim.world.ticks));
        let mut rt = super::runtime(game);
        rt.seed(4);
        let checksum = rt.checksum();
        assert_eq!(rt.state()["__render"].get("textures"), None);
        assert_eq!(rt.state()["__render"].get("assetIssues"), None);
        let textures = [fact(BARK, TextureKind::Normal, TextureOrigin::Source), fact(MOSS, TextureKind::Cutout, TextureOrigin::Family(TextureFamily::Astc4x4))];
        let issues = [AssetIssue { path: BARK.to_owned(), code: AssetIssueCode::TextureUncompressed }];
        rt.note_texture_facts(&textures, &issues);
        assert_eq!(rt.state()["__render"]["textures"], json!({ BARK: { "kind": "normal", "family": "source" }, MOSS: { "kind": "color", "family": "astc" } }));
        assert_eq!(rt.state()["__render"]["assetIssues"], json!([{ "path": BARK, "code": "texture-uncompressed" }]));
        assert_eq!(rt.checksum(), checksum, "display only");
        // The core writer agrees with the serde view (the C++ tally's spelling).
        let core = String::from_utf8(rt.state_value("default", 0.0)["__render"]["assetIssues"].dump()).expect("utf-8");
        assert_eq!(core, r#"[{"path":"textures/bark.png","code":"texture-uncompressed"}]"#);
        rt.frame(genex::View::Game);
        assert_eq!(rt.state()["__render"].get("textures"), None, "a new frame's tally starts empty");
        assert_eq!(rt.state()["__render"].get("assetIssues"), None);
    }

    #[test]
    fn the_issue_codes_have_their_wire_spellings() {
        let wire: Vec<&str> = AssetIssueCode::ALL.iter().map(|code| code.wire()).collect();
        assert_eq!(wire, ["texture-uncompressed", "texture-family-refused", "tangents-runtime"]);
        assert_eq!(TextureOrigin::Source.wire(), "source");
        assert_eq!(TextureOrigin::Family(TextureFamily::Etc2Rgba8).wire(), "etc2");
    }
}

// Through the presenter (a GPU)

mod texture_facts_presenter {
    use super::texture_facts::WHITE_PNG;
    use genex::present::Presenter;
    use genex::prelude::*;
    use genex::{FIXED_STEP_MS, Runtime, View};

    const WORLD: [u32; 2] = [96, 64];
    const BARK: &str = "textures/bark.png";
    const ASSETS: &[(&str, &[u8])] = &[(BARK, WHITE_PNG)];

    #[derive(Default)]
    struct World;

    /// A game drawing one cube with `bark.png` as its normal map, and nothing else textured.
    fn runtime() -> Runtime<World> {
        let mut game = Game::new(World).title("Bark").world_size(WORLD[0], WORLD[1]);
        game.camera(|_| Camera::look_at(vec3(0.0, 1.5, 3.0), Vec3::ZERO));
        game.on_draw(|_, frame, _| {
            frame.sun(vec3(0.3, 0.6, 0.2), Color::WHITE, 3.0).cube_with(Transform::IDENTITY, &Material::color(Color::rgb(120, 90, 60)).with_normal_texture(BARK, 1.0));
        });
        let mut runtime = Runtime::new(game).expect("valid registrations");
        runtime.seed(3);
        runtime.start();
        runtime.step(2.0 * FIXED_STEP_MS);
        runtime
    }

    fn presenter() -> Option<Presenter> {
        let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
        match Presenter::open_with_root(WORLD, ASSETS, None) {
            Ok(presenter) => Some(presenter),
            Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
            Err(_) => None,
        }
    }

    #[test]
    #[ignore = "needs a GPU: run with --ignored metal"]
    fn metal_a_normal_map_with_no_family_file_is_reported_as_an_uncompressed_source_texture() {
        let Some(mut presenter) = presenter() else { return };
        let mut runtime = runtime();
        let checksum = runtime.checksum();
        presenter.set_capturing(true);
        presenter.draw_view(&mut runtime, View::Game).expect("game view").expect("drawn");
        let render = runtime.state()["__render"].clone();
        assert_eq!(render["textures"], json!({ BARK: { "kind": "normal", "family": "source" } }), "{render}");
        assert_eq!(render["assetIssues"], json!([{ "path": BARK, "code": "texture-uncompressed" }]), "{render}");
        assert_eq!(runtime.checksum(), checksum, "the texture facts are display only");
        assert_eq!(presenter.failure(), None);
    }
}
