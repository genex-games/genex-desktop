//! The facade's environment (RQ2.5): what a draw hook declares with `frame.environment(..)` (the
//! flat colour, the physical sky or an HDR map from the game's assets) is kept on the frame, is not
//! a draw, and reaches the renderer through the one conversion native and web share
//! (`genex::present::environment_of`, the HDRI decoded once by the presenter's `AssetCache`); a
//! frame that declares none keeps the flat colour, and an HDRI that cannot be read lights as it.

use std::cell::RefCell;

use genex::glam::Vec3;
use genex::present::{AssetCache, ModelSource, Uploads, environment_of};
use genex::render::{Environment, EnvironmentKind, HdriEnvironment, HdriSun, SkyParams};
use genex::{Color, Frame, Transform};
use genex_render::RenderError;
use genex_render::mesh::MeshData;
use genex_render::scene::MeshId;
use genex_render::texture::{TextureData, TextureId, TextureKind};

/// The showcase's CC0 HDRI, as a game names it (relative to `assets/`).
const HDRI: &str = "env/kloofendal_43d_clear_puresky_1k.hdr";

#[test]
fn a_frame_that_declares_no_environment_keeps_the_flat_colour() {
    let mut frame = Frame::default();
    frame.cube(Transform::IDENTITY, Color::RED).sun(Vec3::Y, Color::WHITE, 2.0);
    assert_eq!(frame.declared_environment(), None, "no environment declared: the flat colour, as before RQ2");
    assert_eq!(Environment::default(), Environment::Color);
    assert!(!Environment::Color.lights_scene());
}

#[test]
fn the_environment_a_frame_declares_is_kept_is_not_a_draw_and_the_last_call_wins() {
    let mut frame = Frame::default();
    frame.environment(Environment::hdri(HDRI)).cube(Transform::IDENTITY, Color::RED);
    assert_eq!(frame.declared_environment().map(Environment::kind), Some(EnvironmentKind::Hdri));
    frame.environment(Environment::sky());
    assert_eq!(frame.declared_environment(), Some(&Environment::sky()), "the last call wins");
    assert_eq!(frame.draw_calls(), 1, "an environment is not a draw");
    assert_eq!(frame.tags().len(), 1, "and counts under no tag");
    let copy = frame.clone();
    assert_eq!(copy, frame, "a frame's environment is part of the frame");
}

#[test]
fn sky_and_map_settings_reach_the_frame_as_given_and_clamped() {
    let sky = SkyParams::default().with_sun_angular_radius_degrees(1.0).with_intensity(2.0).with_ground_albedo([0.2, 0.3, 2.0]);
    let map = HdriEnvironment::new(HDRI).with_intensity(1.5).with_rotation_degrees(90.0).with_sun(HdriSun::Off);
    let mut frame = Frame::default();
    frame.environment(Environment::Sky(sky));
    let Some(Environment::Sky(kept)) = frame.declared_environment() else { panic!("a sky") };
    assert_eq!(kept.intensity, 2.0);
    assert_eq!(kept.ground_albedo, [0.2, 0.3, 1.0], "albedo clamps to 0..=1");
    assert!((kept.sun_angular_radius - 1.0f32.to_radians()).abs() < 1e-6);
    frame.environment(Environment::Hdri(map.clone()));
    assert_eq!(frame.declared_environment(), Some(&Environment::Hdri(map)));
    let hostile = HdriEnvironment::new(HDRI).with_intensity(f32::NAN).with_rotation_degrees(f32::INFINITY);
    assert_eq!((hostile.intensity, hostile.rotation), (1.0, 0.0), "non-finite values never reach the renderer");
    assert_eq!(HdriEnvironment::new(HDRI).with_intensity(1e9).intensity, genex_render::settings::ENVIRONMENT_INTENSITY_MAX);
}

#[test]
fn the_environment_vocabulary_spells_the_host_s_wire_values() {
    assert_eq!(EnvironmentKind::ALL.map(EnvironmentKind::wire), ["color", "sky", "hdri"]);
    assert_eq!(HdriSun::ALL.map(HdriSun::wire), ["analytic", "off"]);
    assert_eq!(Environment::sky().kind().wire(), "sky");
}

// ---------------------------------------------------------------------------------------------
// The environment reaches the renderer

/// The showcase's CC0 HDRI on disk (the same file the game names as [`HDRI`]).
const HDRI_FILE: &[u8] = include_bytes!("../../../examples/showcase/game/assets/env/kloofendal_43d_clear_puresky_1k.hdr");

/// Asset bytes by path, recording every path asked for.
struct Files {
    files: Vec<(&'static str, Vec<u8>)>,
    asked: RefCell<Vec<String>>,
}

impl Files {
    fn new(files: &[(&'static str, &[u8])]) -> Files {
        Files { files: files.iter().map(|(path, bytes)| (*path, bytes.to_vec())).collect(), asked: RefCell::default() }
    }
}

impl ModelSource for Files {
    fn model_bytes(&self, path: &str) -> Option<Vec<u8>> {
        self.asked.borrow_mut().push(path.to_owned());
        self.files.iter().find(|(known, _)| *known == path).map(|(_, bytes)| bytes.clone())
    }
}

/// Uploads nothing: an environment map is decoded on the CPU and uploaded by the presenter.
struct NoUploads;

impl Uploads for NoUploads {
    fn add_mesh(&mut self, _mesh: MeshData) -> Result<MeshId, RenderError> {
        panic!("an environment uploads no mesh")
    }

    fn add_texture(&mut self, _data: &TextureData, _kind: TextureKind) -> Result<TextureId, RenderError> {
        panic!("an environment uploads no texture")
    }
}

fn load(frame: &Frame, files: &Files, cache: &mut AssetCache) -> Vec<String> {
    let mut logged = Vec::new();
    cache.load(frame, files, &mut NoUploads, &mut |line| logged.push(line.to_owned())).expect("no device loss");
    logged
}

fn declaring(environment: Environment) -> Frame {
    let mut frame = Frame::default();
    frame.sphere(Vec3::ZERO, 1.0, Color::WHITE).environment(environment);
    frame
}

#[test]
fn the_environment_a_frame_declares_reaches_the_renderer() {
    let cache = AssetCache::default();
    let mut plain = Frame::default();
    plain.cube(Transform::IDENTITY, Color::RED);
    assert_eq!(environment_of(&plain, &cache), (Environment::Color, None), "none declared: the flat colour");
    let sky = SkyParams::default().with_intensity(2.0);
    assert_eq!(environment_of(&declaring(Environment::Sky(sky)), &cache), (Environment::Sky(sky), None), "the sky as declared");
    assert_eq!(environment_of(&declaring(Environment::Color), &cache), (Environment::Color, None));
}

#[test]
fn an_hdri_is_read_and_decoded_once_and_reaches_the_renderer_with_its_map() {
    let files = Files::new(&[(HDRI, HDRI_FILE)]);
    let map = HdriEnvironment::new(HDRI).with_rotation_degrees(90.0).with_sun(HdriSun::Off);
    let frame = declaring(Environment::Hdri(map.clone()));
    let mut cache = AssetCache::default();
    assert_eq!(environment_of(&frame, &cache), (Environment::Color, None), "before the map loads: the flat colour");
    assert!(load(&frame, &files, &mut cache).is_empty(), "the map decodes");
    let _ = load(&frame, &files, &mut cache);
    assert_eq!(*files.asked.borrow(), [HDRI], "read once");
    let decoded = genex_render::hdri::decode(HDRI_FILE).expect("the showcase map decodes");
    let (environment, held) = environment_of(&frame, &cache);
    assert_eq!(environment, Environment::Hdri(map), "rotation and sun as declared");
    assert_eq!(held, Some(&decoded), "with its decoded map");
    assert_eq!(cache.environment_map(HDRI), Some(&decoded));
}

#[test]
fn a_hostile_missing_or_broken_map_is_never_uploaded_and_lights_as_the_flat_colour() {
    let files = Files::new(&[("env/broken.hdr", b"#?RADIANCE\nnot a map"), ("env/ok.hdr", HDRI_FILE)]);
    for (path, read) in [
        ("../secrets.hdr", false),
        ("/etc/passwd", false),
        ("env/../../outside.hdr", false),
        ("C:\\maps\\sky.hdr", false),
        ("", false),
        ("env/missing.hdr", true),
        ("env/broken.hdr", true),
    ] {
        files.asked.borrow_mut().clear();
        let frame = declaring(Environment::hdri(path));
        let mut cache = AssetCache::default();
        let logged = load(&frame, &files, &mut cache);
        assert_eq!(logged.len(), 1, "{path:?}: one line says why ({logged:?})");
        assert_eq!(files.asked.borrow().len(), usize::from(read), "{path:?}: an unsafe path never reaches the source");
        assert_eq!(cache.environment_map(path), None, "{path:?}: nothing to upload");
        assert_eq!(environment_of(&frame, &cache), (Environment::Color, None), "{path:?}: the flat colour");
        assert!(load(&frame, &files, &mut cache).is_empty(), "{path:?}: refused once, never retried");
    }
}

// ---------------------------------------------------------------------------------------------
// Through the presenter (a GPU)

mod presenter {
    use genex::prelude::*;
    use genex::present::Presenter;
    use genex::render::Environment;
    use genex::{FIXED_STEP_MS, Runtime, View};

    use super::{HDRI, HDRI_FILE};

    const WORLD: [u32; 2] = [96, 64];
    const ASSETS: genex::AssetTable = &[(HDRI, HDRI_FILE)];

    #[derive(Default)]
    struct World;

    /// A game drawing a sphere in the sun, lit by `environment` (None: it declares none).
    fn runtime(environment: Option<Environment>) -> Runtime<World> {
        let mut game = Game::new(World).title("Environment").world_size(WORLD[0], WORLD[1]);
        game.camera(|_| Camera::look_at(vec3(0.0, 0.6, 3.0), Vec3::ZERO));
        game.on_draw(move |_, frame, _| {
            frame.sun(vec3(0.3, 0.6, 0.2), Color::WHITE, 3.0).sphere(Vec3::ZERO, 0.8, Color::rgb(200, 200, 200));
            if let Some(environment) = &environment {
                frame.environment(environment.clone());
            }
        });
        let mut runtime = Runtime::new(game).expect("valid registrations");
        runtime.seed(7);
        runtime.start();
        runtime.step(10.0 * FIXED_STEP_MS);
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

    fn capture(presenter: &mut Presenter, runtime: &mut Runtime<World>) -> u64 {
        presenter.set_capturing(true);
        presenter.draw_view(runtime, View::Game).expect("game view").expect("drawn");
        presenter.resilient.capture().expect("capture").digest()
    }

    #[test]
    #[ignore = "needs a GPU: run with --ignored metal"]
    fn metal_the_sky_and_an_hdri_reach_the_renderer_change_the_picture_and_survive_a_device_loss() {
        let Some(mut presenter) = presenter() else { return };
        let mut flat = runtime(None);
        let flat_digest = capture(&mut presenter, &mut flat);
        assert_eq!(*presenter.resilient.renderer().renderer().environment(), Environment::Color, "none declared: the flat colour");
        for environment in [Environment::sky(), Environment::hdri(HDRI)] {
            let mut lit = runtime(Some(environment.clone()));
            let digest = capture(&mut presenter, &mut lit);
            assert_eq!(*presenter.resilient.renderer().renderer().environment(), environment, "the declared environment reaches the renderer");
            assert_ne!(digest, flat_digest, "{:?} lights the sphere and backs it", environment.kind());
            assert_eq!(capture(&mut presenter, &mut lit), digest, "{:?}: the same frame captures identically", environment.kind());
            presenter.resilient.force_device_loss();
            assert!(presenter.recover_for(&mut lit).expect("recovers"), "a new device");
            assert_eq!(capture(&mut presenter, &mut lit), digest, "{:?}: replayed on the new device (the map uploaded again)", environment.kind());
            assert_eq!(presenter.failure(), None);
        }
        assert_eq!(capture(&mut presenter, &mut flat), flat_digest, "back to the flat colour: the picture as before");
    }
}
