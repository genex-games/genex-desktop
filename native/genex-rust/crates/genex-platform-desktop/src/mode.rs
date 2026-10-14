//! Which mode a run uses, decided at run time (Q1: one binary).

/// The environment variable the host sets for a headless run (`1`).
pub const HEADLESS_ENV: &str = "GENEX_HEADLESS";
/// The command-line flag that asks for a headless run.
pub const HEADLESS_FLAG: &str = "--headless";
/// The environment variable that forbids this process a window (`1`): `cargo test` and
/// `cargo bench` run through rust-env with it set, so a test that reaches the windowed shell is
/// refused `window-refused` instead of opening a window on the developer's screen.
pub const NO_WINDOW_ENV: &str = "GENEX_NO_WINDOW";
const ENV_ON: &str = "1";

/// Whether a `GENEX_NO_WINDOW` value forbids a window: exactly `1`, read like `GENEX_HEADLESS`.
pub fn windows_forbidden(marker: Option<&str>) -> bool {
    marker == Some(ENV_ON)
}

/// Whether this process may not open a window ([`NO_WINDOW_ENV`]).
pub fn windows_forbidden_here() -> bool {
    windows_forbidden(std::env::var(NO_WINDOW_ENV).ok().as_deref())
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
