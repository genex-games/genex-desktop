//! The desktop shell: one binary with a runtime headless mode (Q1), a headless loop that never
//! creates a winit EventLoop, the lifecycle rule (a surface only between resumed and suspended)
//! and real input sampled into the frame the merger reads.

use genex_platform_desktop::winit::event::{ElementState, MouseButton, MouseScrollDelta};
use genex_platform_desktop::winit::keyboard::KeyCode;
use genex_platform_desktop::{
    FrameControl, FrameSample, HEADLESS_ENV, HeadlessOptions, InputSampler, Letterbox, MAX_TEXT_CHARS, NO_WINDOW_ENV,
    ShellClock, ShellCore, ShellErrorCode, ShellEvent, ShellFrame, ShellGame, ShellMode, ShellSurface,
    WHEEL_PIXELS_PER_NOTCH, event_loop_created, run_headless, windows_forbidden,
};
use std::process::Command;

fn args(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| (*s).to_owned()).collect()
}

#[test]
fn the_mode_is_chosen_at_run_time_by_flag_or_environment() {
    let rows: [(&[&str], Option<&str>, ShellMode); 7] = [
        (&[], None, ShellMode::Windowed),
        (&["--headless"], None, ShellMode::Headless),
        (&[], Some("1"), ShellMode::Headless),
        (&[], Some("0"), ShellMode::Windowed),
        (&[], Some(""), ShellMode::Windowed),
        (&["--headless"], Some("0"), ShellMode::Headless),
        (&["--headlessly", "headless"], Some("yes"), ShellMode::Windowed),
    ];
    for (argv, env, mode) in rows {
        assert_eq!(ShellMode::select(&args(argv), env), mode, "{argv:?} {env:?}");
    }
    assert_eq!(HEADLESS_ENV, "GENEX_HEADLESS");
}

#[test]
fn the_letterbox_centres_the_world_and_maps_the_pointer_to_fractions() {
    let view = Letterbox::fit([1920.0, 1080.0], [320, 240]);
    assert_eq!(view, Letterbox { x: 240.0, y: 0.0, width: 1440.0, height: 1080.0 });
    assert_eq!(view.fraction([960.0, 540.0]), [0.5, 0.5]);
    assert_eq!(view.fraction([0.0, 0.0]), [0.0, 0.0], "the bar left of the world clamps to its edge");
    assert_eq!(view.fraction([5000.0, -10.0]), [1.0, 0.0]);
}

/// Hostile window sizes and pointer positions: nothing NaN or outside 0..1 reaches the merger.
#[test]
fn degenerate_windows_and_pointers_give_the_centre() {
    let zero = Letterbox::fit([0.0, 0.0], [320, 240]);
    assert!(zero.width > 0.0 && zero.height > 0.0, "{zero:?}");
    let view = Letterbox::fit([640.0, 480.0], [320, 240]);
    assert_eq!(view.fraction([f32::NAN, f32::NAN]), [0.5, 0.5]);
    let flat = Letterbox { x: 0.0, y: 0.0, width: 0.0, height: f32::NAN };
    assert_eq!(flat.fraction([10.0, 10.0]), [0.5, 0.5]);
}

#[test]
fn a_tap_faster_than_a_frame_is_pressed_and_released_but_not_held() {
    let mut sampler = InputSampler::default();
    sampler.key(KeyCode::Space, ElementState::Pressed);
    sampler.key(KeyCode::Space, ElementState::Released);
    sampler.key(KeyCode::KeyW, ElementState::Pressed);
    sampler.key(KeyCode::KeyA, ElementState::Pressed);
    sampler.mouse_button(MouseButton::Left, ElementState::Pressed);
    let sample = sampler.take(Letterbox::fit([320.0, 240.0], [320, 240]));
    assert_eq!(sample.held, ["KeyA", "KeyW", "Mouse1"], "canonical and sorted");
    assert_eq!(sample.pressed, ["Space"]);
    assert_eq!(sample.released, ["Space"]);
    let next = sampler.take(Letterbox::fit([320.0, 240.0], [320, 240]));
    assert_eq!(next.held, ["KeyA", "KeyW", "Mouse1"], "held keys stay held");
    assert!(next.pressed.is_empty() && next.released.is_empty(), "edges last one frame");
}

#[test]
fn keys_outside_the_protocol_table_are_dropped() {
    let mut sampler = InputSampler::default();
    sampler.key(KeyCode::MediaPlayPause, ElementState::Pressed);
    sampler.key(KeyCode::NumpadEnter, ElementState::Pressed);
    sampler.mouse_button(MouseButton::Other(9), ElementState::Pressed);
    let sample = sampler.take(Letterbox::fit([320.0, 240.0], [320, 240]));
    assert!(sample.held.is_empty(), "{sample:?}");
}

#[test]
fn losing_focus_releases_every_held_key() {
    let mut sampler = InputSampler::default();
    sampler.key(KeyCode::KeyD, ElementState::Pressed);
    sampler.take(Letterbox::fit([320.0, 240.0], [320, 240]));
    sampler.focus_lost();
    let sample = sampler.take(Letterbox::fit([320.0, 240.0], [320, 240]));
    assert!(sample.held.is_empty(), "no key stays stuck down: {sample:?}");
    assert!(sample.released.is_empty(), "the merger sees the key leave `held`; only taps fill the edge lists");
    sampler.key(KeyCode::KeyD, ElementState::Released);
    let late = sampler.take(Letterbox::fit([320.0, 240.0], [320, 240]));
    assert!(late.held.is_empty() && late.released.is_empty(), "a release after focus loss is not a tap: {late:?}");
}

#[test]
fn pointer_wheel_look_and_text_are_sampled_per_frame() {
    let mut sampler = InputSampler::default();
    sampler.cursor_moved([400.0, 300.0]);
    sampler.wheel(MouseScrollDelta::LineDelta(1.0, 2.0));
    sampler.wheel(MouseScrollDelta::PixelDelta(winit_position(5.0, -5.0)));
    sampler.mouse_motion([3.0, -4.0]);
    sampler.text("hé");
    sampler.text("llo");
    let sample = sampler.take(Letterbox::fit([800.0, 600.0], [320, 240]));
    assert_eq!(sample.pointer, [0.5, 0.5]);
    assert_eq!(sample.wheel, [WHEEL_PIXELS_PER_NOTCH + 5.0, -2.0 * WHEEL_PIXELS_PER_NOTCH + 5.0]);
    assert_eq!(sample.look, [3.0, -4.0]);
    assert_eq!(sample.text, "héllo");
    let next = sampler.take(Letterbox::fit([800.0, 600.0], [320, 240]));
    assert_eq!((next.wheel, next.look, next.text.as_str()), ([0.0, 0.0], [0.0, 0.0], ""), "deltas reset");
    assert_eq!(next.pointer, [0.5, 0.5], "the pointer stays where it was");
}

#[test]
fn committed_text_is_capped() {
    let mut sampler = InputSampler::default();
    sampler.text(&"a".repeat(MAX_TEXT_CHARS * 2));
    sampler.text("\u{7}tail");
    let sample = sampler.take(Letterbox::fit([320.0, 240.0], [320, 240]));
    assert_eq!(sample.text.chars().count(), MAX_TEXT_CHARS);
    assert!(!sample.text.contains('\u{7}'));
}

fn winit_position(x: f64, y: f64) -> genex_platform_desktop::winit::dpi::PhysicalPosition<f64> {
    genex_platform_desktop::winit::dpi::PhysicalPosition::new(x, y)
}

/// A game that records what the shell told it.
#[derive(Default)]
struct Recorder {
    log: Vec<String>,
    frames: u32,
    exit_after: Option<u32>,
}

impl ShellGame for Recorder {
    fn title(&self) -> String {
        "Recorder".to_owned()
    }

    fn world_size(&self) -> [u32; 2] {
        [320, 240]
    }

    fn surface_created(&mut self, surface: &ShellSurface) {
        self.log.push(format!("created {:?} {}", surface.size(), surface.scale()));
    }

    fn surface_resized(&mut self, size: [u32; 2], scale: f64) {
        self.log.push(format!("resized {size:?} {scale}"));
    }

    fn surface_lost(&mut self) {
        self.log.push("lost".to_owned());
    }

    fn focus(&mut self, focused: bool) {
        self.log.push(format!("focus {focused}"));
    }

    fn closing(&mut self) {
        self.log.push("closing".to_owned());
    }

    fn os_locale(&mut self, tag: Option<&str>) {
        self.log.push(format!("locale {tag:?}"));
    }

    fn frame(&mut self, frame: ShellFrame) -> FrameControl {
        self.frames += 1;
        self.log.push(format!("frame {} present={} headless={}", frame.frame_ms, frame.present, frame.headless));
        match self.exit_after {
            Some(limit) if self.frames >= limit => FrameControl::Exit,
            _ => FrameControl::Continue,
        }
    }
}

fn fake_surface(size: [u32; 2]) -> ShellSurface {
    ShellSurface::detached(size, 2.0)
}

#[test]
fn a_surface_exists_only_between_resumed_and_suspended() {
    let mut core = ShellCore::new(Recorder::default());
    core.handle(ShellEvent::Suspended);
    core.handle(ShellEvent::Resized { size: [100, 100], scale: 1.0 });
    core.handle(ShellEvent::Redraw { sample: FrameSample::default(), frame_ms: 16.0 });
    core.handle(ShellEvent::Resumed(fake_surface([640, 480])));
    core.handle(ShellEvent::Resumed(fake_surface([640, 480])));
    core.handle(ShellEvent::Resized { size: [800, 600], scale: 2.0 });
    core.handle(ShellEvent::Focus(true));
    core.handle(ShellEvent::Redraw { sample: FrameSample::default(), frame_ms: 16.0 });
    core.handle(ShellEvent::Suspended);
    core.handle(ShellEvent::Redraw { sample: FrameSample::default(), frame_ms: 16.0 });
    core.handle(ShellEvent::Suspended);
    assert_eq!(
        core.game().log,
        [
            "frame 16 present=false headless=false",
            "created [640, 480] 2",
            "lost",
            "created [640, 480] 2",
            "resized [800, 600] 2",
            "focus true",
            "frame 16 present=true headless=false",
            "lost",
            "frame 16 present=false headless=false",
        ]
    );
    assert!(!core.surface_live());
}

#[test]
fn close_and_a_game_exit_end_the_loop() {
    let mut core = ShellCore::new(Recorder { exit_after: Some(2), ..Recorder::default() });
    assert_eq!(core.handle(ShellEvent::Redraw { sample: FrameSample::default(), frame_ms: 1.0 }), FrameControl::Continue);
    assert_eq!(core.handle(ShellEvent::Redraw { sample: FrameSample::default(), frame_ms: 1.0 }), FrameControl::Exit);
    let mut closing = ShellCore::new(Recorder::default());
    assert_eq!(closing.handle(ShellEvent::CloseRequested), FrameControl::Exit);
}

/// G6 UIS-12, new behaviour: a close asks the game for its suspend autosave exactly once, before
/// the loop ends; a suspend or a frame never does.
#[test]
fn a_close_asks_the_game_for_its_suspend_autosave_once_before_the_loop_ends() {
    let mut core = ShellCore::new(Recorder::default());
    core.handle(ShellEvent::Resumed(fake_surface([640, 480])));
    core.handle(ShellEvent::Redraw { sample: FrameSample::default(), frame_ms: 16.0 });
    core.handle(ShellEvent::Suspended);
    assert!(!core.game().log.iter().any(|line| line == "closing"), "a suspend is not a close");
    assert_eq!(core.handle(ShellEvent::CloseRequested), FrameControl::Exit);
    assert_eq!(core.handle(ShellEvent::CloseRequested), FrameControl::Exit, "a second close still ends the loop");
    let log = &core.game().log;
    assert_eq!(log.iter().filter(|line| *line == "closing").count(), 1, "{log:?}");
    assert_eq!(log.last().map(String::as_str), Some("closing"));
}

/// G6 UIS-12, new behaviour: the windowed shell reports the OS locale (sys-locale) once; the tag
/// is a BCP 47 spelling or none.
#[test]
fn the_os_locale_is_a_bcp47_tag_or_none() {
    let tag = genex_platform_desktop::os_locale();
    let well_formed = |tag: &str| !tag.is_empty() && tag.len() <= 64 && tag.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    assert!(tag.as_deref().is_none_or(well_formed), "{tag:?}");
    let mut core = ShellCore::new(Recorder::default());
    core.report_os_locale(Some("fr-FR"));
    assert_eq!(core.game().log, ["locale Some(\"fr-FR\")"]);
}

/// A clock the test drives: each idle wait advances it by what was asked.
#[derive(Default)]
struct FakeClock {
    now: f64,
    waits: Vec<f64>,
}

impl ShellClock for FakeClock {
    fn now_ms(&mut self) -> f64 {
        self.now
    }

    fn idle(&mut self, max_ms: f64) {
        self.waits.push(max_ms);
        self.now += max_ms;
    }
}

/// Runs off the main thread on purpose: winit refuses an EventLoop there on macOS, so a headless
/// loop that created one would panic here.
#[test]
fn the_headless_loop_runs_off_the_main_thread_without_an_event_loop() {
    let handle = std::thread::spawn(|| {
        let mut game = Recorder::default();
        let mut clock = FakeClock::default();
        let exit = run_headless(&mut game, &mut clock, HeadlessOptions { max_frames: Some(3) });
        (game.log, clock.waits, exit)
    });
    let (log, waits, exit) = handle.join().expect("the headless loop needs no main thread");
    assert_eq!(log.len(), 3);
    assert!(log.iter().all(|l| l.ends_with("present=false headless=true")), "{log:?}");
    assert_eq!(log[1], format!("frame {} present=false headless=true", 1000.0 / 60.0));
    assert_eq!(waits.len(), 3, "each frame waits at most a sixtieth of a second");
    assert_eq!(exit.frames, 3);
    assert!(!event_loop_created());
}

#[test]
fn a_game_exit_ends_the_headless_loop() {
    let mut game = Recorder { exit_after: Some(2), ..Recorder::default() };
    let exit = run_headless(&mut game, &mut FakeClock::default(), HeadlessOptions { max_frames: None });
    assert_eq!(exit.frames, 2);
}

/// Q1: the same binary runs headless by flag or by environment, never creating an EventLoop.
#[test]
fn one_binary_runs_headless_by_flag_or_environment() {
    let binary = env!("CARGO_BIN_EXE_genex-desktop-spike");
    let runs = [
        Command::new(binary).args(["--headless", "--frames", "5"]).output(),
        Command::new(binary).args(["--frames", "5"]).env(HEADLESS_ENV, "1").output(),
    ];
    for run in runs {
        let output = run.expect("spawn the spike binary");
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        let stdout = String::from_utf8(output.stdout).unwrap();
        assert!(stdout.contains(r#""mode":"headless""#), "{stdout}");
        assert!(stdout.contains(r#""frames":5"#), "{stdout}");
        assert!(stdout.contains(r#""eventLoop":false"#), "{stdout}");
    }
}

/// `GENEX_NO_WINDOW=1` (rust-env sets it for `cargo test` and `cargo bench`) forbids a window,
/// read exactly like `GENEX_HEADLESS`.
#[test]
fn only_the_exact_marker_forbids_a_window() {
    let rows: [(Option<&str>, bool); 6] = [
        (None, false),
        (Some("1"), true),
        (Some("0"), false),
        (Some(""), false),
        (Some("yes"), false),
        (Some(" 1"), false),
    ];
    for (marker, forbidden) in rows {
        assert_eq!(windows_forbidden(marker), forbidden, "{marker:?}");
    }
    assert_eq!(NO_WINDOW_ENV, "GENEX_NO_WINDOW");
    assert_eq!(ShellErrorCode::WindowRefused.as_str(), "window-refused");
}

/// A run that would open a window under the marker is refused before any EventLoop exists: the
/// binary exits with the typed code and never reports a frame. The same marker leaves a headless
/// run alone.
#[test]
fn a_marked_run_is_refused_a_window_before_an_event_loop_exists() {
    let binary = env!("CARGO_BIN_EXE_genex-desktop-spike");
    let refused = Command::new(binary)
        .args(["--frames", "1"])
        .env_remove(HEADLESS_ENV)
        .env(NO_WINDOW_ENV, "1")
        .output()
        .expect("spawn the spike binary");
    let stderr = String::from_utf8_lossy(&refused.stderr);
    assert_eq!(refused.status.code(), Some(1), "{stderr}");
    assert!(stderr.contains(ShellErrorCode::WindowRefused.as_str()), "{stderr}");
    assert!(refused.stdout.is_empty(), "no frame ran: {}", String::from_utf8_lossy(&refused.stdout));
    let headless = Command::new(binary)
        .args(["--headless", "--frames", "2"])
        .env(NO_WINDOW_ENV, "1")
        .output()
        .expect("spawn the spike binary");
    assert!(headless.status.success(), "{}", String::from_utf8_lossy(&headless.stderr));
    let stdout = String::from_utf8(headless.stdout).unwrap();
    assert!(stdout.contains(r#""eventLoop":false"#), "{stdout}");
}

/// The windowed half of Q1 needs a display: opt in with GENEX_SHELL_WINDOWED_SMOKE=1 (through
/// rust-env also `GENEX_NO_WINDOW=0`, or the marker refuses the window).
#[test]
fn the_same_binary_opens_a_window_when_asked() {
    if std::env::var_os("GENEX_SHELL_WINDOWED_SMOKE").is_none() {
        eprintln!("skipped: set GENEX_SHELL_WINDOWED_SMOKE=1 on a machine with a display");
        return;
    }
    let output = Command::new(env!("CARGO_BIN_EXE_genex-desktop-spike"))
        .args(["--frames", "20"])
        .output()
        .expect("spawn the spike binary");
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.contains(r#""mode":"windowed""#), "{stdout}");
    assert!(stdout.contains(r#""eventLoop":true"#), "{stdout}");
    assert!(stdout.contains(r#""surfaces":1"#), "{stdout}");
}
