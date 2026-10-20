//! Crash reports on the web (game systems CRASH-3). A panic on the page goes through genex-crash's
//! hook, which hands the shell one `genex-crash/1` record (`GenexShell.crash(json)`: the shell keeps
//! it in the game's IndexedDB database [`crash_database`] and answers `window.__studio.crashes()`),
//! then through the hook installed before it: our port of console_error_panic_hook 0.1.7, which
//! logs the text that crate logged (the panic, then the stack of a fresh `Error`), so the console
//! reads as before. A wasm32 panic then aborts with a trap, which the shell sees as a
//! `WebAssembly.RuntimeError` and does not record twice; a trap with no panic before it is the
//! shell's own `wasm-trap` record.
//!
//! [`console_text`], [`crash_database`] and [`install_with`] are plain Rust and build and test on
//! every target with injected outlets; the browser's outlets and the `studio_crash_database` export
//! are wasm32 only.
//!
//! The console hook is ported from console_error_panic_hook 0.1.7 (MIT OR Apache-2.0, the Rust and
//! WebAssembly Working Group): `hook_impl`'s message layout and its `Error().stack` binding.

use std::panic::PanicHookInfo;
use std::sync::OnceLock;

use genex_crash::{FnSink, Installed};

/// The IndexedDB database a game's crash records are kept in: this prefix and the game's name.
pub const CRASH_DATABASE_PREFIX: &str = "genex-crashes:";

/// Where the web's crash pieces go: the console's error line, the stack the console text carries,
/// and the shell's record intake (the record as JSON). Plain functions: the hook may run at any
/// point of a frame and must not capture state.
#[derive(Clone, Copy, Debug)]
pub struct WebCrashOutlets {
    /// `console.error(text)`.
    pub console: fn(&str),
    /// `new Error().stack` (the browser's stack at the panic).
    pub stack: fn() -> String,
    /// `GenexShell.crash(json)`; nothing when no shell listens (the dry boot's worker).
    pub shell: fn(&str),
}

/// The outlets the hooks were installed with (the first call's).
static OUTLETS: OnceLock<WebCrashOutlets> = OnceLock::new();

/// What console_error_panic_hook 0.1.7 logs for a panic: its text, then the stack in the message
/// itself (Firefox's console rewrites a logged message's own stack), then whitespace that breaks
/// Safari's devtools rewriting of the message.
pub fn console_text(panic: &str, stack: &str) -> String {
    let mut text = String::with_capacity(panic.len() + stack.len() + 16);
    text.push_str(panic);
    text.push_str("\n\nStack:\n\n");
    text.push_str(stack);
    text.push_str("\n\n");
    text
}

/// The IndexedDB database `game`'s crash records are kept in (never its saves database).
pub fn crash_database(game: &str) -> String {
    format!("{CRASH_DATABASE_PREFIX}{game}")
}

/// Install the console hook, then genex-crash's hook in front of it with a sink to the shell: a
/// panic gives the shell one record, then the console its text. Once per process: a second call
/// changes nothing and answers [`Installed::Already`].
pub fn install_with(outlets: WebCrashOutlets) -> Installed {
    if OUTLETS.set(outlets).is_err() {
        return Installed::Already;
    }
    std::panic::set_hook(Box::new(console_hook));
    let to_shell = FnSink(|_record: &genex_crash::CrashRecord, json: &[u8]| {
        if let Some(outlets) = OUTLETS.get() {
            (outlets.shell)(&String::from_utf8_lossy(json));
        }
    });
    genex_crash::install(vec![Box::new(to_shell)])
}

/// The ported console_error_panic_hook: the panic's text and the stack, as one `console.error`.
fn console_hook(info: &PanicHookInfo<'_>) {
    let Some(outlets) = OUTLETS.get() else { return };
    (outlets.console)(&console_text(&info.to_string(), &(outlets.stack)()));
}

#[cfg(target_arch = "wasm32")]
pub use page::{install, studio_crash_database};

/// The browser's outlets and the shell's export (wasm32 only).
#[cfg(target_arch = "wasm32")]
mod page {
    use std::sync::OnceLock;

    use genex_crash::Installed;
    use wasm_bindgen::JsCast;
    use wasm_bindgen::prelude::*;

    use super::{WebCrashOutlets, crash_database, install_with};

    /// The shell's global object, and its record intake on it.
    const SHELL_GLOBAL: &str = "GenexShell";
    const SHELL_CRASH: &str = "crash";

    /// The game's crash database, named at install.
    static DATABASE: OnceLock<String> = OnceLock::new();

    #[wasm_bindgen]
    extern "C" {
        #[wasm_bindgen(js_namespace = console, js_name = error)]
        fn console_error(text: &str);

        /// A fresh `Error`, for its `stack` (console_error_panic_hook's binding).
        type Error;

        #[wasm_bindgen(constructor)]
        fn new() -> Error;

        #[wasm_bindgen(structural, method, getter)]
        fn stack(error: &Error) -> String;
    }

    fn log(text: &str) {
        console_error(text);
    }

    fn stack() -> String {
        Error::new().stack()
    }

    /// `GenexShell.crash(json)` when the page has a shell; every failure (no shell, no intake, an
    /// intake that throws) is ignored, so nothing unwinds through the panic hook.
    fn to_shell(json: &str) {
        let global = js_sys::global();
        let Ok(shell) = js_sys::Reflect::get(&global, &JsValue::from_str(SHELL_GLOBAL)) else { return };
        let Ok(intake) = js_sys::Reflect::get(&shell, &JsValue::from_str(SHELL_CRASH)) else { return };
        let Some(intake) = intake.dyn_ref::<js_sys::Function>() else { return };
        let _ = intake.call1(&shell, &JsValue::from_str(json));
    }

    /// Install the web's crash hooks for game `name` (its crash database is named from it).
    pub fn install(name: &str) -> Installed {
        let _ = DATABASE.set(crash_database(name));
        install_with(WebCrashOutlets { console: log, stack, shell: to_shell })
    }

    /// The IndexedDB database the shell keeps this game's crash records in (`genex-crashes:<name>`);
    /// `not-installed` before the module handed its game to the shell.
    #[wasm_bindgen]
    pub fn studio_crash_database() -> Result<String, JsValue> {
        DATABASE.get().cloned().ok_or_else(|| JsValue::from_str("not-installed"))
    }
}
