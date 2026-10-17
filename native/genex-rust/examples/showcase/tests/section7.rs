//! The 4K and 1440p capture plan (renderer pass 2, plan section 7): the showcase scenes' settled
//! Studio captures at 2560x1440 and 3840x2160, high and ultra. G0 (2026-10-15) found no tooling
//! wrote them and the determinism row covered only the template at one preset.
//!
//! Metal rows (`--ignored metal`), one at a time:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p showcase \
//!     --release --offline --locked --test section7 -- --ignored metal --test-threads=1
//!
//! - The determinism row captures the Lakeside's wide shot and Harbour Street's street-wide shot
//!   at both presets and sizes in four child processes each, and requires one digest.
//! - The stills row writes every shot of both scenes (the Lakeside's pass-1 five and its v2 four)
//!   at both presets and sizes as `<scene>/<shot>-<preset>-<W>x<H>.png` with `digests.json` into
//!   `GENEX_SECTION7_OUT` (default `pass2/captures/latest` in the evidence folder), each taken
//!   twice in one process and required to draw one picture; a pair that differs is written beside
//!   it (`-again.png`) and named when the row fails, after every still is written.
//!   `GENEX_SECTION7_SIZES` (`2560x1440`) and `GENEX_SECTION7_SHOTS` (`cabin-interior,cafe`) narrow
//!   it. Crops and A/B sheets are cut from these PNGs (ffmpeg).
//! - Every capture here hides the scene's HUD (H) before its first tick: a still is the picture,
//!   never the card over it (GA1 look review).

mod support;

use std::path::PathBuf;
use std::process::Command;

use genex::present::Presenter;
use genex::render::{PresetChoice, RenderChange};
use genex::{FIXED_STEP_MS, Input, Key, Runtime, View};
use genex_render::capture::Capture;
use genex_render::settings::QualityPreset;
use support::{SHOT_TICK, gpu, write_png};

/// The plan's output sizes.
const SIZES: [(u32, u32); 2] = [(2560, 1440), (3840, 2160)];
/// The plan's presets at those sizes.
const PRESETS: [QualityPreset; 2] = [QualityPreset::High, QualityPreset::Ultra];
/// Child processes per capture in the determinism row.
const CHILD_RUNS: usize = 4;
/// The shots the determinism row captures, by scene.
const DETERMINISM_SHOTS: [(Scene, &str); 2] = [(Scene::Lakeside, "wide"), (Scene::Harbour, "street-wide")];
/// What a child run captures (`scene,shot,preset,WxH`) and where it writes the digest.
const CHILD_ENV: &str = "GENEX_SECTION7_CHILD";
const CHILD_OUT_ENV: &str = "GENEX_SECTION7_CHILD_OUT";
const OUT_ENV: &str = "GENEX_SECTION7_OUT";
/// The 4K shots the stills writer found drawing two pictures in one process (G0 round 2), and how
/// often the repeat row captures each.
const REPEAT_SHOTS: [(Scene, &str, QualityPreset); 4] = [
    (Scene::Lakeside, "wide", QualityPreset::High),
    (Scene::Lakeside, "dock", QualityPreset::Ultra),
    (Scene::Lakeside, "forest", QualityPreset::Ultra),
    (Scene::Harbour, "cafe", QualityPreset::High),
];
const REPEATS: usize = 5;

/// The showcase's scenes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Scene {
    Lakeside,
    Harbour,
}

impl Scene {
    fn wire(self) -> &'static str {
        match self {
            Scene::Lakeside => "lakeside",
            Scene::Harbour => "harbour-street",
        }
    }

    fn from_wire(wire: &str) -> Option<Scene> {
        [Scene::Lakeside, Scene::Harbour].into_iter().find(|scene| scene.wire() == wire)
    }

    fn shots(self) -> Vec<&'static str> {
        match self {
            Scene::Lakeside => showcase_game::world::named_shots().map(|shot| shot.name).collect(),
            Scene::Harbour => showcase_game::harbour::SHOTS.iter().map(|shot| shot.name).collect(),
        }
    }
}

/// `runtime` at tick 600 from seed 1, its HUD hidden (H, tapped before the first tick).
fn at_shot_tick<W: Default + 'static>(mut runtime: Runtime<W>) -> Runtime<W> {
    runtime.seed(1);
    runtime.start();
    runtime.inject(Input::key_tap(Key::KeyH));
    runtime.step(f64::from(SHOT_TICK) * FIXED_STEP_MS);
    runtime
}

/// `shot` of `scene` at tick 600 with its HUD hidden, captured the way the Studio captures it at
/// `preset` and `size`.
fn capture(scene: Scene, shot: &str, preset: QualityPreset, size: (u32, u32)) -> Option<Capture> {
    match scene {
        Scene::Lakeside => {
            let presenter = Presenter::open(showcase_game::showcase::WORLD_SIZE, showcase_game::assets()).ok()?;
            let runtime = at_shot_tick(Runtime::new(showcase_game::game()).expect("installs"));
            Some(settled(presenter, runtime, shot, preset, size))
        }
        Scene::Harbour => {
            let presenter = Presenter::open(showcase_game::harbour::WORLD_SIZE, showcase_game::harbour_assets()).ok()?;
            let runtime = at_shot_tick(Runtime::new(showcase_game::harbour_game()).expect("installs"));
            Some(settled(presenter, runtime, shot, preset, size))
        }
    }
}

/// The comma-separated list in `var`, or None when unset.
fn narrowed(var: &str) -> Option<Vec<String>> {
    std::env::var(var).ok().map(|list| list.split(',').map(|item| item.trim().to_owned()).collect())
}

/// A settled capture of `shot` on `presenter` at `preset` and `size`.
fn settled<W: Default + 'static>(mut presenter: Presenter, mut runtime: Runtime<W>, shot: &str, preset: QualityPreset, size: (u32, u32)) -> Capture {
    assert!(presenter.install_for(&mut runtime).is_empty(), "every pass installs");
    presenter.set_capturing(true);
    presenter.set_capture_size(Some(size));
    // The first frame attaches the game's render settings.
    presenter.draw_view(&mut runtime, View::Named(shot)).expect("a view").expect("drawn");
    let change = RenderChange { preset: Some(Some(PresetChoice::Preset(preset))), ..RenderChange::default() };
    presenter.render_settings().expect("the game's settings attached").borrow_mut().apply(&change);
    presenter.draw_view(&mut runtime, View::Named(shot)).expect("a view").expect("drawn");
    assert!(presenter.take_pass_refusals().is_empty(), "{shot}: every pass draws");
    let capture = presenter.resilient.capture().expect("capture");
    assert_eq!((capture.width(), capture.height()), size, "{shot}: captured at the size asked for");
    capture
}

fn parse_size(text: &str) -> (u32, u32) {
    let (w, h) = text.split_once('x').expect("WxH");
    (w.parse().expect("width"), h.parse().expect("height"))
}

/// The child half of the determinism row: with [`CHILD_ENV`] set, capture what it names and write
/// the digest to [`CHILD_OUT_ENV`].
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_section7_child_capture() {
    let (Ok(what), Ok(out)) = (std::env::var(CHILD_ENV), std::env::var(CHILD_OUT_ENV)) else { return };
    let [scene, shot, preset, size] = what.split(',').collect::<Vec<_>>().try_into().expect("scene,shot,preset,WxH");
    let scene = Scene::from_wire(scene).expect("a showcase scene");
    let preset = QualityPreset::from_wire(preset).expect("a preset");
    let shot = capture(scene, shot, preset, parse_size(size)).expect("a GPU in the child");
    std::fs::write(out, format!("{:016x}", shot.digest())).expect("child digest");
}

fn child_digest(what: &str, run: usize) -> String {
    let out = std::env::temp_dir().join(format!("genex-section7-child-{}-{run}.txt", std::process::id()));
    let _ = std::fs::remove_file(&out);
    let status = Command::new(std::env::current_exe().expect("test binary"))
        .args(["--ignored", "--exact", "metal_section7_child_capture", "--test-threads=1"])
        .env(CHILD_ENV, what)
        .env(CHILD_OUT_ENV, &out)
        .status()
        .expect("child run");
    assert!(status.success(), "child run {run} of {what} failed");
    let digest = std::fs::read_to_string(&out).expect("the child wrote its digest");
    let _ = std::fs::remove_file(&out);
    digest
}

/// Section 7 and gate G0: the showcase's settled captures at 1440p and 4K, high and ultra, are the
/// same bytes in four processes (the template's row covered one preset of the template only).
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_showcase_captures_at_1440p_and_4k_are_deterministic_across_processes() {
    if gpu().is_none() {
        return;
    }
    let mut problems = Vec::new();
    for (scene, shot) in DETERMINISM_SHOTS {
        for preset in PRESETS {
            for (w, h) in SIZES {
                let what = format!("{},{shot},{},{w}x{h}", scene.wire(), preset.wire());
                let digests: Vec<String> = (0..CHILD_RUNS).map(|run| child_digest(&what, run)).collect();
                eprintln!("{what}: {digests:?}");
                if digests.iter().any(|digest| *digest != digests[0]) {
                    problems.push(format!("{what} differs across processes: {digests:?}"));
                }
            }
        }
    }
    assert!(problems.is_empty(), "{problems:#?}");
}

/// Busy threads on every core until dropped: the stills writer's 4K mismatches came under load.
struct CpuLoad {
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    threads: Vec<std::thread::JoinHandle<()>>,
}

impl CpuLoad {
    #[allow(clippy::disallowed_methods, reason = "test glue: busy threads load the host; no simulation runs on them")]
    fn start() -> CpuLoad {
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let cores = std::thread::available_parallelism().map_or(4, std::num::NonZero::get);
        let threads = (0..cores)
            .map(|_| {
                let stop = std::sync::Arc::clone(&stop);
                std::thread::spawn(move || {
                    let mut spin = 0_u64;
                    while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                        spin = std::hint::black_box(spin.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1));
                    }
                })
            })
            .collect();
        CpuLoad { stop, threads }
    }
}

impl Drop for CpuLoad {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::Relaxed);
        for thread in self.threads.drain(..) {
            let _ = thread.join();
        }
    }
}

/// Where two captures of one size differ: the pixel count, the largest channel step and the box.
fn difference(a: &Capture, b: &Capture) -> String {
    let width = a.width() as usize;
    let (mut count, mut largest) = (0_usize, 0_u8);
    let (mut x0, mut y0, mut x1, mut y1) = (usize::MAX, usize::MAX, 0, 0);
    for (at, (pa, pb)) in a.bgra().chunks(4).zip(b.bgra().chunks(4)).enumerate() {
        let step = pa.iter().zip(pb).map(|(ca, cb)| ca.abs_diff(*cb)).max().unwrap_or(0);
        if step == 0 {
            continue;
        }
        count += 1;
        largest = largest.max(step);
        let (x, y) = (at % width, at / width);
        (x0, y0, x1, y1) = (x0.min(x), y0.min(y), x1.max(x), y1.max(y));
    }
    format!("{count} pixels differ, largest step {largest}, box ({x0},{y0})-({x1},{y1})")
}

/// G0 round 2: the stills writer stopped at a different 4K shot in each of four runs, two settled
/// captures of one tick drawing two pictures in one process while other lanes loaded the machine.
/// One 4K shot captured [`REPEATS`] times in one process, a 1440p capture of it between each two
/// as the writer orders them and every core busy, draws one picture.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_4k_shot_captured_again_in_one_process_under_load_draws_one_picture() {
    if gpu().is_none() {
        return;
    }
    let out = std::env::var_os(OUT_ENV).map(PathBuf::from);
    let _load = CpuLoad::start();
    let mut problems = Vec::new();
    for (scene, shot, preset) in REPEAT_SHOTS {
        let first = capture(scene, shot, preset, (3840, 2160)).expect("a presenter");
        for run in 1..REPEATS {
            // The writer's order: a 1440p capture between two 4K ones.
            capture(scene, shot, preset, (2560, 1440)).expect("a 1440p presenter");
            let again = capture(scene, shot, preset, (3840, 2160)).expect("another presenter");
            if again.digest() == first.digest() {
                continue;
            }
            problems.push(format!("{} {shot} {} capture {run}: {}", scene.wire(), preset.wire(), difference(&first, &again)));
            if let Some(dir) = &out {
                std::fs::create_dir_all(dir).expect("the out folder");
                write_png(&dir.join(format!("repeat-{}-{shot}-0.png", scene.wire())), &first);
                write_png(&dir.join(format!("repeat-{}-{shot}-{run}.png", scene.wire())), &again);
            }
        }
    }
    assert!(problems.is_empty(), "{problems:#?}");
}

/// Section 7's stills: every shot of both scenes at high and ultra at 1440p and 4K, each taken twice
/// in one process (one picture), written as PNGs with their digests.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_section7_stills_are_written_at_1440p_and_4k() {
    if gpu().is_none() {
        return;
    }
    let root = std::env::var_os(OUT_ENV).map_or_else(|| support::evidence_dir("pass2/captures/latest"), PathBuf::from);
    let sizes: Vec<(u32, u32)> = narrowed("GENEX_SECTION7_SIZES").map_or_else(|| SIZES.to_vec(), |list| list.iter().map(|size| parse_size(size)).collect());
    let only = narrowed("GENEX_SECTION7_SHOTS");
    let mut rows = Vec::new();
    let mut problems = Vec::new();
    for scene in [Scene::Lakeside, Scene::Harbour] {
        let dir = root.join(scene.wire());
        std::fs::create_dir_all(&dir).expect("the stills folder");
        for shot in scene.shots().into_iter().filter(|shot| only.as_ref().is_none_or(|only| only.iter().any(|name| name == shot))) {
            for preset in PRESETS {
                for &(w, h) in &sizes {
                    let first = capture(scene, shot, preset, (w, h)).expect("a presenter");
                    let again = capture(scene, shot, preset, (w, h)).expect("a second presenter");
                    write_png(&dir.join(format!("{shot}-{}-{w}x{h}.png", preset.wire())), &first);
                    if again.digest() != first.digest() {
                        write_png(&dir.join(format!("{shot}-{}-{w}x{h}-again.png", preset.wire())), &again);
                        problems.push(format!("{} {shot} {} {w}x{h}: two settled captures differ: {}", scene.wire(), preset.wire(), difference(&first, &again)));
                    }
                    rows.push(format!("{{\"scene\": \"{}\", \"shot\": \"{shot}\", \"preset\": \"{}\", \"size\": [{w}, {h}], \"digest\": \"{:016x}\"}}", scene.wire(), preset.wire(), first.digest()));
                }
            }
        }
    }
    std::fs::write(root.join("digests.json"), format!("{{\"tick\": {SHOT_TICK}, \"rows\": [\n{}\n]}}\n", rows.join(",\n"))).expect("digests");
    assert!(problems.is_empty(), "{problems:#?}");
}
