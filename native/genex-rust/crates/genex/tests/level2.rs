//! The facade's Level-2 API (extension ladder level 2, renderer follow-up RQ0.8): a custom material
//! (`gfx.material(path, uniforms)`, drawn with `frame.custom(..)`) and a post pass
//! (`gfx.post_pass(path)`, run with `frame.post_pass(..)`) from `[[wgsl]]` sources.
//!
//! A source is read through genex-render's `read_extension_source` (relative, by realpath inside
//! the game, a regular file, at most `WGSL_MAX_BYTES`) or taken from the binary (`game.wgsl`), is
//! declared under `[[wgsl]]` with the kind of the call that takes it, at an api this renderer
//! serves (1 or 2 from RQ1), and is admitted by naga against that extension API's prelude. A refusal is a
//! typed handle that draws the missing-asset checker, listed in `state().volatile.extensions`, and
//! has no other effect: nothing is written, the simulation and its checksum are untouched.
//!
//! The GPU rows are `#[ignore]`d and named `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex \
//!     --offline --locked -- --ignored metal

use std::path::{Path, PathBuf};

use genex::present::Presenter;
use genex::prelude::*;
use genex::{CustomMaterial, ExtensionRefusalCode, FIXED_STEP_MS, PostPass, Runtime, View};
use genex_render::RenderCode;
use genex_render::extension::ExtensionFault;

/// Ticks the determinism rows run: ten seconds.
const CHECKSUM_TICKS: u32 = 600;
const WORLD: [u32; 2] = [96, 64];

/// A material that paints its uniform colour, lit by the sun.
const MATERIAL_WGSL: &str = "struct Params { color: vec4<f32> }\n\
@group(2) @binding(0) var<uniform> params: Params;\n\
@fragment fn fs_material(in: GxMaterialIn) -> @location(0) vec4<f32> {\n\
    let lit = gx_srgb_to_linear(params.color.rgb) * gx_lambert(in.normal);\n\
    return vec4<f32>(gx_linear_to_srgb(lit), 1.0);\n\
}\n";
/// A post pass that inverts the frame.
const POST_WGSL: &str = "@fragment fn fs_post(in: GxPostIn) -> @location(0) vec4<f32> {\n\
    let c = textureSample(gx_source, gx_sampler, in.uv);\n\
    return vec4<f32>(vec3<f32>(1.0) - c.rgb, 1.0);\n\
}\n";
/// A v2 material: its uniform colour as a surface the renderer shades (sun, shadows, exposure).
const MATERIAL_V2_WGSL: &str = "struct Params { color: vec4<f32> }\n\
@group(2) @binding(0) var<uniform> params: Params;\n\
@fragment fn fs_material(in: GxMaterialInV2) -> @location(0) vec4<f32> {\n\
    let s = gx_surface_v2(in.world_position, in.normal, gx_srgb_to_linear(params.color.rgb), 0.0, 0.6);\n\
    return vec4<f32>(gx_shade_pbr(s), 1.0);\n\
}\n";
/// A v2 material sampling the game's texture at binding 1 with the linear sampler, exposed.
const TEXTURED_V2_WGSL: &str = "@group(2) @binding(1) var albedo: texture_2d<f32>;\n\
@group(2) @binding(5) var linear_repeat: sampler;\n\
@fragment fn fs_material(in: GxMaterialInV2) -> @location(0) vec4<f32> {\n\
    return vec4<f32>(gx_expose(textureSample(albedo, linear_repeat, in.uv).rgb), 1.0);\n\
}\n";
/// A v2 post pass that inverts the display-ready frame (stage ldr).
const POST_V2_WGSL: &str = "@fragment fn fs_post(in: GxPostInV2) -> @location(0) vec4<f32> {\n\
    let c = textureSampleLevel(gx_scene, gx_sampler, gx_scene_uv(in.position), 0.0);\n\
    return vec4<f32>(vec3<f32>(1.0) - c.rgb, 1.0);\n\
}\n";
/// A 2x2 white PNG (a game texture).
const WHITE_PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x02, 0x00,
    0x00, 0x00, 0x02, 0x08, 0x06, 0x00, 0x00, 0x00, 0x72, 0xb6, 0x0d, 0x24, 0x00, 0x00, 0x00, 0x1d, 0x49, 0x44, 0x41, 0x54, 0x78,
    0x01, 0x01, 0x12, 0x00, 0xed, 0xff, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0x8f, 0x82, 0x0f, 0xf1, 0x6d, 0x9e, 0x54, 0xf2, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42,
    0x60, 0x82,
];
/// The game's compiled assets for the textured rows.
const TEXTURED_ASSETS: &[(&str, &[u8])] = &[("textures/white.png", WHITE_PNG)];
/// A Level-3 pass source: valid WGSL of another kind.
const PASS_WGSL: &str = "@fragment fn fs_pass() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }\n";
const RED: [f32; 4] = [0.9, 0.2, 0.1, 1.0];

#[derive(Default)]
struct World {
    ticks: u32,
    material: CustomMaterial,
    post: Option<PostPass>,
}

/// A fresh game folder under the temp dir, its `genex.toml` declaring `rows` (path, kind, api).
struct Folder {
    root: PathBuf,
}

impl Folder {
    fn new(name: &str, rows: &[(&str, &str, i64)]) -> Folder {
        let root = std::env::temp_dir().join(format!("genex-level2-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("shaders")).expect("game folder");
        let mut toml = String::from("[game]\ntitle = \"Level two\"\n");
        for (path, kind, api) in rows {
            toml.push_str(&format!("\n[[wgsl]]\npath = \"{path}\"\nkind = \"{kind}\"\napi = {api}\n"));
        }
        std::fs::write(root.join("genex.toml"), toml).expect("genex.toml");
        Folder { root }
    }

    fn write(&self, path: &str, text: &str) {
        std::fs::write(self.root.join(path), text).expect("source");
    }

    /// Every file under the folder with its bytes, in path order: what "no side effect" compares.
    fn snapshot(&self) -> Vec<(PathBuf, Vec<u8>)> {
        fn walk(dir: &Path, out: &mut Vec<(PathBuf, Vec<u8>)>) {
            let mut entries: Vec<_> = std::fs::read_dir(dir).expect("folder").flatten().map(|e| e.path()).collect();
            entries.sort();
            for path in entries {
                let meta = std::fs::symlink_metadata(&path).expect("meta");
                if meta.is_dir() {
                    walk(&path, out);
                } else if meta.is_file() {
                    out.push((path.clone(), std::fs::read(&path).expect("bytes")));
                } else {
                    out.push((path, Vec::new()));
                }
            }
        }
        let mut out = Vec::new();
        walk(&self.root, &mut out);
        out
    }
}

impl Drop for Folder {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// A game whose reset asks for the material at `material` (and the post pass at `post`), drawing
/// it on a cube under the `world` tag.
fn game(root: &Path, material: Option<&'static str>, post: Option<&'static str>) -> Game<World> {
    let mut game = Game::new(World::default()).title("Level two").world_size(WORLD[0], WORLD[1]);
    game.wgsl_root(root);
    game.on_reset(move |sim, _seed, _rng, gfx| {
        if let Some(path) = material {
            sim.world.material = gfx.material(path, &RED);
        }
        if let Some(path) = post {
            sim.world.post = Some(gfx.post_pass(path));
        }
    });
    game.on_update(|sim, _ctx| sim.world.ticks += 1);
    game.camera(|_| Camera::look_at(vec3(0.0, 1.5, 3.0), Vec3::ZERO));
    game.on_draw(|sim, frame, _| {
        frame.custom(CustomMesh::Cube, Transform::IDENTITY, &sim.world.material, Color::WHITE);
        if let Some(post) = &sim.world.post {
            frame.post_pass(post);
        }
    });
    game.probe("ticks", |sim| json!(sim.world.ticks));
    game
}

fn runtime(game: Game<World>) -> Runtime<World> {
    Runtime::new(game).expect("valid registrations")
}

fn run(runtime: &mut Runtime<World>, ticks: u32) {
    runtime.seed(7);
    runtime.start();
    runtime.step(f64::from(ticks) * FIXED_STEP_MS);
}

/// The one `volatile.extensions` row of a runtime that asked for one source.
fn extension_row(runtime: &Runtime<World>) -> Value {
    let state = runtime.state();
    let rows = state["volatile"]["extensions"].as_array().cloned().unwrap_or_default();
    assert_eq!(rows.len(), 1, "one row: {}", state["volatile"]);
    rows[0].clone()
}

#[test]
fn hostile_sources_are_refused_typed_with_no_side_effect() {
    let folder = Folder::new(
        "hostile",
        &[
            ("shaders/link.wgsl", "material", 1),
            ("shaders/linked/x.wgsl", "material", 1),
            ("shaders/pass.wgsl", "pass", 1),
            ("shaders/big.wgsl", "material", 1),
            ("shaders/bad.wgsl", "material", 1),
            ("shaders/ok.wgsl", "material", 1),
        ],
    );
    let outside = std::env::temp_dir().join(format!("genex-level2-outside-{}", std::process::id()));
    std::fs::create_dir_all(&outside).expect("outside folder");
    std::fs::write(outside.join("x.wgsl"), MATERIAL_WGSL).expect("outside source");
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(outside.join("x.wgsl"), folder.root.join("shaders/link.wgsl")).expect("file link");
        std::os::unix::fs::symlink(&outside, folder.root.join("shaders/linked")).expect("folder link");
    }
    folder.write("shaders/pass.wgsl", PASS_WGSL);
    folder.write("shaders/big.wgsl", &"// padding\n".repeat(genex_render::WGSL_MAX_BYTES / 10));
    folder.write("shaders/bad.wgsl", "fn fs_material( {");
    folder.write("shaders/ok.wgsl", MATERIAL_WGSL);
    folder.write("shaders/undeclared.wgsl", MATERIAL_WGSL);

    let path_refused = ExtensionRefusalCode::Render(RenderCode::WgslTooLarge);
    // (the path asked for, its code, its fault)
    let mut rows: Vec<(&'static str, ExtensionRefusalCode, Option<ExtensionFault>)> = vec![
        ("../x.wgsl", path_refused, Some(ExtensionFault::PathRefused)),
        ("shaders/../../x.wgsl", path_refused, Some(ExtensionFault::PathRefused)),
        ("/etc/hosts.wgsl", path_refused, Some(ExtensionFault::PathRefused)),
        ("shaders\\ok.wgsl", path_refused, Some(ExtensionFault::PathRefused)),
        ("", path_refused, Some(ExtensionFault::PathRefused)),
        ("shaders/pass.wgsl", ExtensionRefusalCode::WgslKindMismatch, None),
        ("shaders/undeclared.wgsl", ExtensionRefusalCode::WgslUndeclared, None),
        ("shaders/big.wgsl", path_refused, Some(ExtensionFault::TooLarge)),
        ("shaders/bad.wgsl", path_refused, Some(ExtensionFault::Invalid)),
    ];
    if cfg!(unix) {
        rows.push(("shaders/link.wgsl", path_refused, Some(ExtensionFault::PathRefused)));
        rows.push(("shaders/linked/x.wgsl", path_refused, Some(ExtensionFault::PathRefused)));
    }
    let before = folder.snapshot();
    let outside_before = std::fs::read(outside.join("x.wgsl")).expect("outside bytes");
    let mut plain = runtime(game(&folder.root, None, None));
    run(&mut plain, 30);
    for (path, code, fault) in rows {
        let mut hostile = runtime(game(&folder.root, Some(path), None));
        let material = hostile.sim().world.material.clone();
        let refusal = material.refusal().unwrap_or_else(|| panic!("{path:?} admitted"));
        assert_eq!((refusal.code(), refusal.fault()), (code, fault), "{path:?}: {refusal}");
        assert!(material.is_missing(), "{path:?} draws the checker");
        let row = extension_row(&hostile);
        assert_eq!(row["kind"], json!("material"), "{path:?}");
        assert_eq!(row["code"], json!(code.as_str()), "{path:?}");
        run(&mut hostile, 30);
        assert_eq!(hostile.checksum(), plain.checksum(), "{path:?} moved the simulation");
        assert_eq!(folder.snapshot(), before, "{path:?} changed the game folder");
    }
    assert_eq!(std::fs::read(outside.join("x.wgsl")).expect("outside bytes"), outside_before);
    let _ = std::fs::remove_dir_all(&outside);
}

#[test]
fn an_api_2_source_is_admitted_against_the_v2_prelude_and_a_v1_source_declared_2_is_refused() {
    let folder = Folder::new("api2", &[("shaders/v2.wgsl", "material", 2), ("shaders/v1.wgsl", "material", 2), ("shaders/post.wgsl", "post", 2)]);
    folder.write("shaders/v2.wgsl", MATERIAL_V2_WGSL);
    folder.write("shaders/v1.wgsl", MATERIAL_WGSL);
    folder.write("shaders/post.wgsl", POST_V2_WGSL);
    let admitted = runtime(game(&folder.root, Some("shaders/v2.wgsl"), Some("shaders/post.wgsl")));
    let material = admitted.sim().world.material.clone();
    assert_eq!(material.refusal(), None, "a v2 material is admitted");
    assert_eq!(material.api(), 2);
    let post = admitted.sim().world.post.clone().expect("a post pass");
    assert_eq!((post.refusal(), post.api()), (None, 2), "a v2 post pass is admitted");
    let mismatched = runtime(game(&folder.root, Some("shaders/v1.wgsl"), None));
    let refusal = mismatched.sim().world.material.refusal().cloned().expect("a v1 source declared api 2 is refused");
    assert!(mismatched.sim().world.material.is_missing(), "{refusal}");
    assert_eq!(extension_row(&mismatched)["api"], json!(2));
}

#[test]
fn an_unknown_api_refuses_typed() {
    let folder = Folder::new("api3", &[("shaders/ok.wgsl", "material", 3)]);
    folder.write("shaders/ok.wgsl", MATERIAL_V2_WGSL);
    let runtime = runtime(game(&folder.root, Some("shaders/ok.wgsl"), None));
    let refusal = runtime.sim().world.material.refusal().cloned().expect("refused");
    assert_eq!(refusal.code().as_str(), "unknown-extension-api", "{refusal}");
}

#[test]
fn a_valid_material_counts_one_world_draw_and_records_its_api() {
    let folder = Folder::new("valid", &[("shaders/ok.wgsl", "material", 1)]);
    folder.write("shaders/ok.wgsl", MATERIAL_WGSL);
    let twin = runtime(game(&folder.root, Some("shaders/ok.wgsl"), None));
    let mut runtime = runtime(game(&folder.root, Some("shaders/ok.wgsl"), None));
    let material = runtime.sim().world.material.clone();
    assert_eq!(material.refusal(), None);
    assert!(!material.is_missing());
    assert_eq!(material.api(), 1);
    assert_eq!(twin.sim().world.material, material, "two runtimes on one seed hold equal handles");
    let row = extension_row(&runtime);
    assert_eq!((row["path"].clone(), row["api"].clone(), row["code"].clone()), (json!("shaders/ok.wgsl"), json!(1), Value::Null));
    let frame = runtime.frame(View::Game).expect("frame");
    assert_eq!(frame.custom_draws().len(), 1);
    let state = runtime.state();
    assert_eq!(state["__render"]["drawCalls"], json!(1), "{}", state["__render"]);
    assert_eq!(state["__render"]["tags"]["world"]["drawCalls"], json!(1), "{}", state["__render"]);
}

#[test]
fn uniforms_of_the_wrong_size_are_refused_and_a_compiled_source_needs_no_folder() {
    let folder = Folder::new("uniforms", &[("shaders/ok.wgsl", "material", 1)]);
    folder.write("shaders/ok.wgsl", MATERIAL_WGSL);
    let mut game = Game::new(World::default()).title("Level two").world_size(WORLD[0], WORLD[1]);
    game.wgsl_root(&folder.root);
    game.on_reset(|sim, _, _, gfx| sim.world.material = gfx.material("shaders/ok.wgsl", &[1.0, 2.0]));
    let short = runtime(game).sim().world.material.refusal().cloned().expect("refused");
    assert_eq!(short.fault(), Some(ExtensionFault::LayoutMismatch), "{short}");

    // No folder at all (the web, a phone, an export): the source compiled into the binary.
    let mut compiled = Game::new(World::default()).title("Level two").world_size(WORLD[0], WORLD[1]);
    compiled.wgsl("shaders/water.wgsl", MATERIAL_WGSL);
    compiled.on_reset(|sim, _, _, gfx| {
        sim.world.material = gfx.material("shaders/water.wgsl", &RED);
        let set = gfx.set_material_uniforms(&sim.world.material, &[0.1, 0.5, 0.9, 1.0]);
        assert!(set.is_ok(), "{set:?}");
        let refused = gfx.set_material_uniforms(&sim.world.material, &[0.1]);
        assert!(refused.is_err());
    });
    let runtime = runtime(compiled);
    let material = runtime.sim().world.material.clone();
    assert_eq!(material.refusal(), None);
    assert_eq!(material.uniform_bytes().len(), 16);
}

#[test]
fn the_600_tick_checksum_is_the_same_with_and_without_the_extensions() {
    let folder = Folder::new("checksum", &[("shaders/ok.wgsl", "material", 1), ("shaders/post.wgsl", "post", 1)]);
    folder.write("shaders/ok.wgsl", MATERIAL_WGSL);
    folder.write("shaders/post.wgsl", POST_WGSL);
    let mut plain = runtime(game(&folder.root, None, None));
    let mut with = runtime(game(&folder.root, Some("shaders/ok.wgsl"), Some("shaders/post.wgsl")));
    assert_eq!(with.sim().world.post.as_ref().and_then(PostPass::refusal), None);
    run(&mut plain, CHECKSUM_TICKS);
    run(&mut with, CHECKSUM_TICKS);
    assert_eq!(with.tick(), u64::from(CHECKSUM_TICKS));
    assert_eq!(with.checksum(), plain.checksum());
}

fn presenter() -> Option<Presenter> {
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    match Presenter::open_with_root(WORLD, &[], None) {
        Ok(presenter) => {
            if require {
                assert_eq!(presenter.gpu().receipt().backend, "metal", "GENEX_REQUIRE_METAL=1 but the adapter is not Metal");
            }
            Some(presenter)
        }
        Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
        Err(error) => {
            eprintln!("skipped: no WebGPU-core adapter ({error})");
            None
        }
    }
}

/// Draw `runtime`'s game view as a capture; its digest and what it counted.
fn capture(presenter: &mut Presenter, runtime: &mut Runtime<World>) -> (u64, genex::present::Drawn) {
    presenter.set_capturing(true);
    let drawn = presenter.draw_view(runtime, View::Game).expect("game view").expect("drawn");
    let capture = presenter.resilient.capture().expect("capture");
    (capture.digest(), drawn)
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_material_draws_and_a_post_pass_changes_the_capture_only() {
    let Some(mut presenter) = presenter() else { return };
    let folder = Folder::new("metal", &[("shaders/ok.wgsl", "material", 1), ("shaders/post.wgsl", "post", 1)]);
    folder.write("shaders/ok.wgsl", MATERIAL_WGSL);
    folder.write("shaders/post.wgsl", POST_WGSL);

    let mut refused = runtime(game(&folder.root, Some("shaders/missing.wgsl"), None));
    run(&mut refused, 30);
    let (checker, _) = capture(&mut presenter, &mut refused);

    let mut material = runtime(game(&folder.root, Some("shaders/ok.wgsl"), None));
    run(&mut material, 30);
    let (lit, drawn) = capture(&mut presenter, &mut material);
    assert_eq!(drawn.draw_calls, 1, "one logical draw: {drawn:?}");
    assert_eq!(drawn.by_tag.first().map(|(tag, _)| tag.as_str()), Some("world"));
    assert_ne!(lit, checker, "the material drew, not the checker");
    let (again, _) = capture(&mut presenter, &mut material);
    assert_eq!(again, lit, "the same frame captures identically");

    let mut post = runtime(game(&folder.root, Some("shaders/ok.wgsl"), Some("shaders/post.wgsl")));
    run(&mut post, 30);
    let (inverted, drawn) = capture(&mut presenter, &mut post);
    assert_ne!(inverted, lit, "the post pass changed the capture");
    assert_eq!(drawn.draw_calls, 2, "the material and the post pass: {drawn:?}");
    assert_eq!(post.checksum(), material.checksum(), "the post pass never moves the simulation");
    assert_eq!(presenter.failure(), None);
}

/// A presenter on `assets` (no folder), or None without an adapter.
fn presenter_on(assets: genex::AssetTable) -> Option<Presenter> {
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    match Presenter::open_with_root(WORLD, assets, None) {
        Ok(presenter) => Some(presenter),
        Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
        Err(_) => None,
    }
}

/// Draw one Live frame of `runtime` and answer the scene path it drew.
fn live(presenter: &mut Presenter, runtime: &mut Runtime<World>) -> genex_render::renderer::ScenePath {
    presenter.set_capturing(false);
    presenter.draw_view(runtime, View::Game).expect("game view").expect("drawn");
    presenter.resilient.renderer().renderer().last_scene().expect("a frame")
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_v2_material_draws_on_the_hdr_scene_and_a_v1_one_keeps_the_frame_ldr_and_says_why() {
    use genex::render::DegradeReason;
    let folder = Folder::new("metal-v2", &[("shaders/v2.wgsl", "material", 2), ("shaders/v1.wgsl", "material", 1), ("shaders/post.wgsl", "post", 2)]);
    folder.write("shaders/v2.wgsl", MATERIAL_V2_WGSL);
    folder.write("shaders/v1.wgsl", MATERIAL_WGSL);
    folder.write("shaders/post.wgsl", POST_V2_WGSL);

    let Some(mut presenter) = presenter_on(&[]) else { return };
    let mut checker = runtime(game(&folder.root, Some("shaders/missing.wgsl"), None));
    run(&mut checker, 30);
    let (missing, _) = capture(&mut presenter, &mut checker);
    let Some(mut presenter) = presenter_on(&[]) else { return };
    let mut v2 = runtime(game(&folder.root, Some("shaders/v2.wgsl"), None));
    run(&mut v2, 30);
    let path = live(&mut presenter, &mut v2);
    assert!(path.hdr && path.depth_reversed, "a v2 material keeps the HDR scene: {path:?}");
    let (shaded, drawn) = capture(&mut presenter, &mut v2);
    assert_ne!(shaded, missing, "the v2 material drew, not the checker");
    assert_eq!(drawn.draw_calls, 1);
    assert_eq!(presenter.failure(), None);

    let Some(mut presenter) = presenter_on(&[]) else { return };
    let mut inverted = runtime(game(&folder.root, Some("shaders/v2.wgsl"), Some("shaders/post.wgsl")));
    run(&mut inverted, 30);
    assert!(live(&mut presenter, &mut inverted).hdr, "a v2 post pass keeps the HDR scene");
    let (post, _) = capture(&mut presenter, &mut inverted);
    assert_ne!(post, shaded, "the v2 post pass ran");

    let Some(mut presenter) = presenter_on(&[]) else { return };
    let mut v1 = runtime(game(&folder.root, Some("shaders/v1.wgsl"), None));
    run(&mut v1, 30);
    let path = live(&mut presenter, &mut v1);
    assert!(!path.hdr, "a v1 material keeps the legacy scene: {path:?}");
    let status = presenter.render_settings().expect("attached").borrow().status();
    assert!(status.degraded.iter().any(|d| d.reason == DegradeReason::MaterialV1InHdr), "{:?}", status.degraded);
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_v2_material_samples_a_game_texture_and_a_missing_one_binds_neutral() {
    let folder = Folder::new("metal-textured", &[("shaders/tex.wgsl", "material", 2)]);
    folder.write("shaders/tex.wgsl", TEXTURED_V2_WGSL);
    let textured = |texture: &'static str| {
        let mut game = Game::new(World::default()).title("Textured").world_size(WORLD[0], WORLD[1]);
        game.wgsl_root(&folder.root);
        game.on_reset(move |sim, _seed, _rng, gfx| {
            let albedo = gfx.texture(texture);
            sim.world.material = gfx.material_textured("shaders/tex.wgsl", &[], &[&albedo]);
        });
        game.camera(|_| Camera::look_at(vec3(0.0, 1.5, 3.0), Vec3::ZERO));
        game.on_draw(|sim, frame, _| {
            frame.custom(CustomMesh::Cube, Transform::IDENTITY, &sim.world.material, Color::WHITE);
        });
        game
    };
    let Some(mut presenter) = presenter_on(TEXTURED_ASSETS) else { return };
    let mut white = runtime(textured("textures/white.png"));
    run(&mut white, 5);
    assert_eq!(white.sim().world.material.refusal(), None);
    let (lit, _) = capture(&mut presenter, &mut white);
    assert!(presenter.resilient.renderer().renderer().last_scene().is_some_and(|path| path.hdr));
    assert_eq!(presenter.failure(), None);
    let Some(mut presenter) = presenter_on(TEXTURED_ASSETS) else { return };
    let mut missing = runtime(textured("textures/gone.png"));
    run(&mut missing, 5);
    let (neutral, _) = capture(&mut presenter, &mut missing);
    assert_eq!(presenter.failure(), None);
    assert_eq!(neutral, lit, "a missing texture binds the neutral white texel, as the white texture does");
}

// WP-9 iteration speed: with a game folder (a dev build, Live) the folder's copy of a `[[wgsl]]`
// source wins over the one compiled in, so an edited shader takes effect at the next reset
// (`seed`), no rebuild; the compiled copy stands in where the folder has none.
#[test]
fn a_dev_build_reads_an_edited_shader_from_its_folder_at_the_next_reset() {
    let folder = Folder::new("live-edit", &[("shaders/live.wgsl", "material", 1)]);
    folder.write("shaders/live.wgsl", MATERIAL_WGSL);
    let mut game = game(&folder.root, Some("shaders/live.wgsl"), None);
    game.wgsl("shaders/live.wgsl", "this is not wgsl");
    let mut live = runtime(game);
    assert_eq!(live.sim().world.material.refusal(), None, "the folder's valid copy wins over the stale compiled one");
    folder.write("shaders/live.wgsl", "fn broken( {");
    live.seed(7);
    assert!(live.sim().world.material.refusal().is_some(), "the edited source is read again at the reset");
    folder.write("shaders/live.wgsl", MATERIAL_WGSL);
    live.seed(7);
    assert_eq!(live.sim().world.material.refusal(), None, "and fixed again without a rebuild");
}
