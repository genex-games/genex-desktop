//! audio-yard's settled captures on the host GPU (Metal on the Mac), drawn as the Studio draws a
//! frame (genex's presenter): the yard, the cave, behind the wall and the drone's pass. Audio
//! never reaches the picture: each capture of the game equals the capture of the same tick of
//! [`game_quiet`] (every audio call left out), and two settled captures of one tick are equal.
//!
//! The row is `#[ignore]`d and named `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p audio-yard \
//!     --release --offline --test captures -- --ignored metal --nocapture
//!
//! It writes `audio-yard-<shot>.png` and `audio-yard-digests.json` to `GENEX_AUDIO_YARD_OUT`
//! (default `.studio-dev/evidence/rust-renderer/captures/audio-yard`).

use std::path::PathBuf;

use audio_yard_game::{ASSETS, DRONE_START_TICK, WORLD_SIZE, World, game, game_quiet};
use genex::present::Presenter;
use genex::render::{DeviceClass, RenderChange};
use genex::{FIXED_STEP_MS, Game, Runtime, View};

const SEED: u32 = 1;
/// The device class the captures draw at.
const CLASS: &str = "desktop-high";
/// Each shot: its name and the loop tick it settles on.
const SHOTS: [(&str, u64); 4] = [("yard", 100), ("cave", 620), ("behind-wall", 960), ("drone", DRONE_START_TICK + 80)];

fn out_dir() -> PathBuf {
    let evidence = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../.studio-dev/evidence/rust-renderer/captures/audio-yard");
    let dir = std::env::var_os("GENEX_AUDIO_YARD_OUT").map_or(evidence, PathBuf::from);
    std::fs::create_dir_all(&dir).expect("the captures folder");
    dir
}

/// Write a BGRA capture as an opaque RGBA PNG.
fn write_png(path: &PathBuf, bgra: &[u8], size: [u32; 2]) {
    let rgba: Vec<u8> = bgra.chunks(4).flat_map(|p| [p[2], p[1], p[0], 255]).collect();
    image::save_buffer(path, &rgba, size[0], size[1], image::ExtendedColorType::Rgba8).expect("png written");
}

fn settled(game: Game<World>, ticks: u64) -> Runtime<World> {
    let mut rt = Runtime::with_assets(game, Box::new(ASSETS)).expect("installs");
    rt.seed(SEED);
    assert!(rt.start());
    for _ in 0..=ticks {
        rt.step(FIXED_STEP_MS);
    }
    rt
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_settled_captures_of_the_yard_are_the_quiet_games() {
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    let mut presenter = match Presenter::open(WORLD_SIZE, ASSETS) {
        Ok(presenter) => presenter,
        Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
        Err(error) => return eprintln!("skipped: no WebGPU-core adapter ({error})"),
    };
    let dir = out_dir();
    let mut digests = genex::json!({});
    for (name, ticks) in SHOTS {
        let mut shoot = |game: Game<World>| {
            let mut rt = settled(game, ticks);
            assert!(presenter.install_for(&mut rt).is_empty());
            presenter.set_capturing(true);
            // The first draw attaches the game's render settings to the presenter.
            presenter.draw_view(&mut rt, View::Game).expect("a view").expect("drawn");
            let settings = presenter.render_settings().expect("the game's settings attached");
            settings.borrow_mut().apply(&RenderChange { device_class: Some(DeviceClass::from_wire(CLASS)), ..RenderChange::default() });
            let mut once = || {
                presenter.draw_view(&mut rt, View::Game).expect("a view").expect("drawn");
                presenter.resilient.capture().expect("capture")
            };
            let (capture, again) = (once(), once());
            assert_eq!(capture.digest(), again.digest(), "{name}: two settled captures of one tick differ");
            capture
        };
        let (audible, quiet) = (shoot(game()), shoot(game_quiet()));
        assert_eq!(audible.digest(), quiet.digest(), "{name}: audio changed the picture");
        let size = [audible.width(), audible.height()];
        write_png(&dir.join(format!("audio-yard-{name}.png")), audible.bgra(), size);
        digests[name] = genex::json!(format!("{:016x}", audible.digest()));
        println!("{name}: {}x{} {:016x}", size[0], size[1], audible.digest());
    }
    std::fs::write(dir.join("audio-yard-digests.json"), digests.to_string()).expect("the digests write");
}
