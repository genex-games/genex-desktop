//! Which mode a run uses, decided at run time (Q1: one binary).

/// The environment variable the host sets for a headless run (`1`).
pub const HEADLESS_ENV: &str = "GENEX_HEADLESS";
/// The command-line flag that asks for a headless run.
pub const HEADLESS_FLAG: &str = "--headless";
/// The environment variable that forbids this process a window (`1`): `cargo test` and
/// `cargo bench` run through rust-env with it set, so a test that reaches the windowed shell is
/// refused `window-refused` instead of opening a window on the developer's screen.
pub const NO_WINDOW_ENV: &str = "GENEX_NO_WINDOW";
/// The environment variable that asks a windowed run for a fullscreen window: `1` borderless on
/// its monitor at the desktop's own resolution, `native` exclusive at the monitor's largest mode
/// (its panel's own pixels; the desktop's mode comes back when the window closes).
pub const FULLSCREEN_ENV: &str = "GENEX_FULLSCREEN";
/// The command-line flag that asks a windowed run for a borderless fullscreen window.
pub const FULLSCREEN_FLAG: &str = "--fullscreen";
/// The command-line flag that asks for the exclusive fullscreen window at the monitor's own pixels.
pub const FULLSCREEN_NATIVE_FLAG: &str = "--fullscreen=native";
const FULLSCREEN_NATIVE: &str = "native";
const ENV_ON: &str = "1";

/// Whether a `GENEX_NO_WINDOW` value forbids a window: exactly `1`, read like `GENEX_HEADLESS`.
pub fn windows_forbidden(marker: Option<&str>) -> bool {
    marker == Some(ENV_ON)
}

/// Whether this process may not open a window ([`NO_WINDOW_ENV`]).
pub fn windows_forbidden_here() -> bool {
    windows_forbidden(std::env::var(NO_WINDOW_ENV).ok().as_deref())
}

/// How a windowed run fills its monitor.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Fullscreen {
    /// A window at the game's world size (the default).
    #[default]
    Off,
    /// Borderless fullscreen at the desktop's resolution (`--fullscreen`, `GENEX_FULLSCREEN=1`).
    Borderless,
    /// Exclusive fullscreen at the monitor's largest mode, its panel's own pixels
    /// (`--fullscreen=native`, `GENEX_FULLSCREEN=native`).
    Native,
}

/// The fullscreen `args` (the arguments after the program name) or the `GENEX_FULLSCREEN` value
/// ask for, each read exactly like the headless switch; the native one wins when both are asked.
pub fn fullscreen_asked(args: &[String], fullscreen_env: Option<&str>) -> Fullscreen {
    let native = args.iter().any(|arg| arg == FULLSCREEN_NATIVE_FLAG) || fullscreen_env == Some(FULLSCREEN_NATIVE);
    if native {
        return Fullscreen::Native;
    }
    if args.iter().any(|arg| arg == FULLSCREEN_FLAG) || fullscreen_env == Some(ENV_ON) {
        return Fullscreen::Borderless;
    }
    Fullscreen::Off
}

/// The fullscreen this process was started with ([`fullscreen_asked`] on its arguments and
/// [`FULLSCREEN_ENV`]).
pub fn fullscreen_from_process() -> Fullscreen {
    let args: Vec<String> = std::env::args().skip(1).collect();
    fullscreen_asked(&args, std::env::var(FULLSCREEN_ENV).ok().as_deref())
}

/// How the shell runs a game.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ShellMode {
    /// No window, no real input: the host's `input` op is all the game sees.
    Headless,
    /// A winit window with real input.
    Windowed,
}

impl ShellMode {
    /// Headless when `args` (the arguments after the program name) hold exactly `--headless`, or
    /// the `GENEX_HEADLESS` value is exactly `1`; windowed otherwise.
    pub fn select(args: &[String], headless_env: Option<&str>) -> ShellMode {
        if args.iter().any(|arg| arg == HEADLESS_FLAG) || headless_env == Some(ENV_ON) {
            return ShellMode::Headless;
        }
        ShellMode::Windowed
    }

    /// The mode this process was started in.
    pub fn from_process() -> ShellMode {
        let args: Vec<String> = std::env::args().skip(1).collect();
        let env = std::env::var(HEADLESS_ENV).ok();
        ShellMode::select(&args, env.as_deref())
    }

    /// The mode's wire spelling.
    pub const fn as_str(self) -> &'static str {
        match self {
            ShellMode::Headless => "headless",
            ShellMode::Windowed => "windowed",
        }
    }
}
