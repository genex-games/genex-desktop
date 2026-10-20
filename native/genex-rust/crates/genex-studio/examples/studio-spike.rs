//! The M0a.3 spike game: a headless, CPU-drawn toy on genex-core's session, served over the
//! studio's fd 3 by genex-studio. `tests/conformance/rust-protocol-spike.test.ts` starts it the way
//! `spawnGame` starts a game (fd 3 piped, its own process group, `GENEX_STUDIO_*` and
//! `GENEX_STATE_DIR` only) and drives it through the host's real `NativeGamePort` and `NativeRuns`.
//!
//! The world is a dot that `KeyD`/`KeyA` move and the session's PCG32 wobbles; probes `x`, `score`,
//! `wobble`; camera `top`, eye `eye:spawn`; demos `walk` (drives `KeyD` for half a second) and
//! `crash` (panics: the studio gets `fatal`). Test doubles, by flag:
//!
//!   --world WxH            the world target (default 64x36)
//!   --boot-ms N            boot for N ms before `ready` (requests sent meanwhile wait and are
//!                          answered after it, as v1's transport does)
//!   --oversize-capture     every capture reads back one pixel wider than the host takes
//!   --probe-bytes N        a `blob` probe of N bytes, so `state` can outgrow the line cap
//!   --stubborn             answer `quit` but keep running, and ignore SIGTERM (Stop's SIGKILL row)
//!   --probe-child-fd       at boot, spawn `/bin/sh` and report as probe `childFd3` whether the
//!                          child inherited descriptor 3 ("inherited") or not ("closed")
//!
//! Without a studio (no fd 3 or nonce) it runs its live loop until a signal ends it, as a window would.

use std::sync::Arc;
use std::time::{Duration, Instant};

use genex_core::clock::FpsMeter;
use genex_core::input::{Injection, TickInput};
use genex_core::json::Value;
use genex_core::paths::process_env;
use genex_core::rng::Pcg32;
use genex_core::session::{DEFAULT_SEED, FrameTiming, Hooks, Session, StateExtras, StepResult, Timings, snapshot};
use genex_studio::{
    CAPTURE_MAX_PX, CaptureFault, Pixels, ReadyInfo, Studio, StudioGame, Transport, from_environment, report_panics,
};

/// One live frame at 60 Hz.
const FRAME: Duration = Duration::from_micros(16_667);
/// What the child shell runs: whether descriptor 3 is open in it.
const CHILD_FD3_PROBE: &str = "if { true >&3; } 2>/dev/null; then echo inherited; else echo closed; fi";
/// The demo `walk` holds `KeyD` this long.
const WALK_MS: f64 = 500.0;
/// The dot's side, in pixels.
const DOT_PX: u32 = 4;
const DEFAULT_WORLD: [u32; 2] = [64, 36];
/// Background per view (BGRA), so captures from different cameras differ.
const GAME_BACKGROUND: [u8; 4] = [28, 20, 18, 255];
const TOP_BACKGROUND: [u8; 4] = [60, 40, 20, 255];
const EYE_BACKGROUND: [u8; 4] = [20, 60, 40, 255];
const DOT: [u8; 4] = [255, 255, 255, 255];
const TOP_CAMERA: &str = "top";
const SPAWN_EYE: &str = "eye:spawn";
const WALK_DEMO: &str = "walk";
const CRASH_DEMO: &str = "crash";
/// The graphics path `ready` reports: the spike draws on the CPU, so none of contract v2's wgpu
/// backends (a protocol 1 `ready`).
const BACKEND_API: &str = "unknown";
const DEVICE: &str = "cpu-spike";

/// The test doubles the command line turns on.
#[derive(Clone, Debug)]
struct Options {
    world: [u32; 2],
    boot: Duration,
    oversize_capture: bool,
    probe_bytes: usize,
    stubborn: bool,
    probe_child_fd: bool,
}

impl Options {
    fn parse(mut args: impl Iterator<Item = String>) -> Options {
        let mut options = Options {
            world: DEFAULT_WORLD,
            boot: Duration::ZERO,
            oversize_capture: false,
            probe_bytes: 0,
            stubborn: false,
            probe_child_fd: false,
        };
        while let Some(flag) = args.next() {
            match flag.as_str() {
                "--world" => options.world = args.next().and_then(|v| parse_size(&v)).unwrap_or(DEFAULT_WORLD),
                "--boot-ms" => options.boot = Duration::from_millis(number(args.next())),
                "--oversize-capture" => options.oversize_capture = true,
                "--probe-bytes" => options.probe_bytes = usize::try_from(number(args.next())).unwrap_or(0),
                "--stubborn" => options.stubborn = true,
                "--probe-child-fd" => options.probe_child_fd = true,
                _ => eprintln!("WARNING: studio-spike: unknown flag {flag}"),
            }
        }
        options
    }
}

fn number(text: Option<String>) -> u64 {
    text.and_then(|t| t.parse().ok()).unwrap_or(0)
}

fn parse_size(text: &str) -> Option<[u32; 2]> {
    let (w, h) = text.split_once('x')?;
    let size = [w.parse().ok()?, h.parse().ok()?];
    size.iter().all(|side| *side > 0).then_some(size)
}

/// The simulation: everything a tick reads and writes.
#[derive(Clone, Debug, Default)]
struct World {
    x: f64,
    score: u32,
    wobble: u32,
}

impl Hooks for World {
    fn reset(&mut self, seed: u32) {
        *self = World { x: f64::from(seed % 7), score: 0, wobble: 0 };
    }

    fn tick(&mut self, input: &TickInput, _tick: u64, rng: &mut Pcg32) {
        if input.keys.down("KeyD") {
            self.x += 1.0;
        }
        if input.keys.down("KeyA") {
            self.x -= 1.0;
        }
        if input.keys.pressed("Space") {
            self.score += 1;
        }
        self.wobble = self.wobble.wrapping_add(rng.below(3));
    }
}

/// Which view the frame is drawn from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum View {
    Game,
    Top,
    Eye,
}

/// The game the studio drives.
struct Spike {
    options: Options,
    session: Session,
    world: World,
    view: View,
    frame: Vec<u8>,
    draws: u32,
    timing: FrameTiming,
    fps: FpsMeter,
    born: Instant,
    /// What `--probe-child-fd` saw: "inherited" or "closed" (empty without the flag).
    child_fd3: String,
}

impl Spike {
    fn new(options: Options) -> Spike {
        Spike {
            options,
            session: Session::default(),
            world: World::default(),
            view: View::Game,
            frame: Vec::new(),
            draws: 0,
            timing: FrameTiming::default(),
            fps: FpsMeter::default(),
            born: Instant::now(),
            child_fd3: String::new(),
        }
    }

    /// The first reset, then live play: what the game is at `ready`.
    fn begin(&mut self) {
        self.session.seed(DEFAULT_SEED, &mut self.world);
        self.session.start();
        self.render();
    }

    fn ready_info(&self) -> ReadyInfo {
        let os = if cfg!(target_os = "macos") { "macos" } else if cfg!(windows) { "windows" } else { "linux" };
        ReadyInfo {
            build: format!("genex-rust-spike/{os}/headless"),
            backend_api: BACKEND_API.to_owned(),
            device: Some(DEVICE.to_owned()),
            size: self.options.world,
            seed: self.session.seed_value(),
            // The spike stays a protocol 1 game (its conformance rows assert protocol 1).
            receipt: None,
            ai: false,
        }
    }

    /// One live frame of `interval_ms`: its ticks, then a draw when one is due.
    fn live_frame(&mut self, interval_ms: f64) {
        self.fps.frame(self.born.elapsed().as_secs_f64() * 1000.0);
        let ticked_from = Instant::now();
        self.session.frame(interval_ms, &mut self.world);
        let ticked = Instant::now();
        if self.session.take_render() {
            self.render();
        }
        let update_ms = (ticked - ticked_from).as_secs_f64() * 1000.0;
        self.timing.record(interval_ms, update_ms, ticked.elapsed().as_secs_f64() * 1000.0);
    }

    fn probes(&self) -> Value {
        let mut probes = Value::object();
        probes.set("x", Value::from(self.world.x));
        probes.set("score", Value::from(self.world.score));
        probes.set("wobble", Value::from(self.world.wobble));
        if !self.child_fd3.is_empty() {
            probes.set("childFd3", Value::from(self.child_fd3.as_str()));
        }
        if self.options.probe_bytes > 0 {
            probes.set("blob", Value::from("b".repeat(self.options.probe_bytes)));
        }
        probes
    }
}

impl StudioGame for Spike {
    fn seed(&mut self, seed: u32) {
        self.fps.reset();
        self.session.seed(seed, &mut self.world);
    }
    fn start(&mut self) -> bool {
        self.session.start()
    }
    fn pause(&mut self) -> bool {
        self.session.pause()
    }
    fn step(&mut self, ms: f64) -> StepResult {
        self.session.step(ms, &mut self.world)
    }
    fn state(&mut self, camera: &str) -> Value {
        let extras = StateExtras {
            fps: self.fps.fps(),
            camera: camera.to_owned(),
            probes: self.probes(),
            ..StateExtras::default()
        };
        snapshot(&self.session, &extras)
    }
    fn inject(&mut self, injection: &Injection) -> Vec<String> {
        self.session.inject(injection)
    }
    fn view(&mut self, name: Option<&str>) -> bool {
        let view = match name {
            None => View::Game,
            Some(TOP_CAMERA) => View::Top,
            Some(SPAWN_EYE) => View::Eye,
            Some(_) => return false,
        };
        self.view = view;
        true
    }
    fn cameras(&self) -> Vec<String> {
        vec![TOP_CAMERA.to_owned()]
    }
    fn eyes(&self) -> Vec<String> {
        vec![SPAWN_EYE.to_owned()]
    }
    fn demos(&self) -> Vec<String> {
        vec![WALK_DEMO.to_owned(), CRASH_DEMO.to_owned()]
    }
    fn run_demo(&mut self, name: &str) -> Value {
        assert_ne!(name, CRASH_DEMO, "studio-spike: the crash demo crashes");
        let hold = |keys: &str| vec![keys.to_owned()];
        self.session.inject(&Injection { down: hold("KeyD"), ..Injection::default() });
        self.session.step(WALK_MS, &mut self.world);
        self.session.inject(&Injection { up: hold("KeyD"), ..Injection::default() });
        let mut out = Value::object();
        out.set("x", Value::from(self.world.x));
        out
    }
    fn render(&mut self) {
        let [width, height] = self.options.world;
        let background = match self.view {
            View::Game => GAME_BACKGROUND,
            View::Top => TOP_BACKGROUND,
            View::Eye => EYE_BACKGROUND,
        };
        let mut frame = background.repeat(width as usize * height as usize);
        // The dot's column wraps around the world; it sits on the middle row.
        let column = (self.world.x.floor() as i64).rem_euclid(i64::from(width)) as u32;
        for y in (height / 2)..(height / 2 + DOT_PX).min(height) {
            for x in column..(column + DOT_PX).min(width) {
                let at = (y as usize * width as usize + x as usize) * 4;
                frame[at..at + 4].copy_from_slice(&DOT);
            }
        }
        self.frame = frame;
        self.draws = 2;
    }
    fn draw_calls(&self) -> u32 {
        self.draws
    }
    fn world_size(&self) -> [u32; 2] {
        self.options.world
    }
    fn capture(&mut self) -> Result<Pixels, CaptureFault> {
        if self.options.oversize_capture {
            let width = CAPTURE_MAX_PX + 1;
            return Ok(Pixels { width, height: 1, bgra: DOT.repeat(width as usize) });
        }
        let [width, height] = self.options.world;
        Ok(Pixels { width, height, bgra: self.frame.clone() })
    }
    fn timings(&self) -> Timings {
        self.timing.timings()
    }
}

/// Whether a child process inherits descriptor 3: "inherited", "closed", or why it could not tell.
fn child_fd3() -> String {
    let output = std::process::Command::new("/bin/sh").args(["-c", CHILD_FD3_PROBE]).output();
    match output {
        Ok(output) => String::from_utf8_lossy(&output.stdout).trim().to_owned(),
        Err(error) => format!("spawn-failed: {error}"),
    }
}

/// The stubborn double: SIGTERM is ignored, so only SIGKILL ends the game.
#[cfg(unix)]
#[allow(unsafe_code)] // std has no signal API; this is a test double's one call.
fn ignore_sigterm() {
    // SAFETY: setting a signal's disposition to SIG_IGN installs no handler and runs no code.
    unsafe { libc::signal(libc::SIGTERM, libc::SIG_IGN) };
}

#[cfg(not(unix))]
fn ignore_sigterm() {}

/// The live loop: serve the studio, run the frame, pace to 60 Hz waking for the studio's next
/// request; returns once `quit` or the studio's end of file asked the game to close (never for
/// the stubborn double).
fn run(studio: &mut Studio, link: Option<&Transport>, game: &mut Spike) {
    let mut last: Option<Instant> = None;
    loop {
        let start = Instant::now();
        if let Some(link) = link {
            studio.serve(link, game);
            if studio.closing() && !game.options.stubborn {
                return;
            }
        }
        let interval = last.map_or(f64::NAN, |at| (start - at).as_secs_f64() * 1000.0);
        last = Some(start);
        game.live_frame(if interval.is_finite() { interval } else { 0.0 });
        let rest = FRAME.saturating_sub(start.elapsed());
        match link {
            Some(link) => {
                link.wait(rest);
            }
            None => std::thread::sleep(rest),
        }
    }
}

fn main() {
    let options = Options::parse(std::env::args().skip(1));
    if options.stubborn {
        ignore_sigterm();
    }
    let env = |name: &str| process_env(name);
    let link = from_environment(&env).map(Arc::new);
    if let Some(link) = &link {
        report_panics(Arc::clone(link));
    }
    let mut studio = Studio::for_run(&env);
    let boot_length = options.boot;
    let mut game = Spike::new(options);
    if game.options.probe_child_fd {
        game.child_fd3 = child_fd3();
    }
    // Booting: the studio's requests wait in the transport's queue until `ready`.
    std::thread::sleep(boot_length);
    game.begin();
    if let Some(link) = &link {
        studio.announce_ready(link, &game.ready_info());
    }
    run(&mut studio, link.as_deref(), &mut game);
}
