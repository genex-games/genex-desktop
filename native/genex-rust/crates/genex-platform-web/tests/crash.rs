//! The web's crash hook (game systems CRASH-3) on the host: our port of console_error_panic_hook
//! 0.1.7 logs the text it logged, byte for byte, and genex-crash's hook is chained in front of it,
//! so a panic hands the shell exactly one `genex-crash/1` record and then logs the same console
//! text as before. The browser rows (a trap, IndexedDB, device loss) are in
//! `tests/conformance/rust-web-crash.test.ts`.

use std::sync::Mutex;

use genex_crash::{CRASH_RECORD_MAX_BYTES, CrashKind, CrashRecord, CrashSource, Installed};
use genex_platform_web::crash::{CRASH_DATABASE_PREFIX, WebCrashOutlets, console_text, crash_database, install_with};
use genex_platform_web::saves::SAVES_DATABASE_PREFIX;

/// What reached each outlet, in the order it arrived.
static ARRIVED: Mutex<Vec<(&'static str, String)>> = Mutex::new(Vec::new());
/// The stack the test's outlet answers (the browser's `new Error().stack`).
const STACK: &str = "Error\n    at game.wasm.__rust_start_panic (wasm://wasm/00a1b2c3:wasm-function[42]:0x1f00)";

fn arrived(outlet: &'static str, text: &str) {
    ARRIVED.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push((outlet, text.to_owned()));
}

fn outlets() -> WebCrashOutlets {
    WebCrashOutlets {
        console: |text| arrived("console", text),
        stack: || STACK.to_owned(),
        shell: |json| arrived("shell", json),
    }
}

#[test]
fn the_console_text_is_console_error_panic_hook_s() {
    // console_error_panic_hook 0.1.7 `hook_impl`: the panic, "\n\nStack:\n\n", the stack, "\n\n".
    let text = console_text("panicked at src/lib.rs:3:5:\nboom", "Error\n    at f");
    assert_eq!(text, "panicked at src/lib.rs:3:5:\nboom\n\nStack:\n\nError\n    at f\n\n");
}

#[test]
fn a_game_s_crash_records_live_in_their_own_database() {
    assert_eq!(crash_database("pond"), "genex-crashes:pond");
    assert_eq!(CRASH_DATABASE_PREFIX, "genex-crashes:");
    assert_ne!(crash_database("pond"), format!("{SAVES_DATABASE_PREFIX}pond"), "never the saves database");
}

#[test]
fn a_panic_hands_the_shell_one_record_then_logs_the_console_text_as_before() {
    assert_eq!(install_with(outlets()), Installed::Now);
    assert_eq!(install_with(outlets()), Installed::Already, "a second install changes nothing");
    let line = line!() + 1;
    let joined = std::thread::Builder::new().name("game".to_owned()).spawn(|| panic!("index 7 of 3")).expect("thread").join();
    assert!(joined.is_err(), "the panic still unwinds its thread");

    let arrived = ARRIVED.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
    let outlets: Vec<&str> = arrived.iter().map(|(outlet, _)| *outlet).collect();
    assert_eq!(outlets, ["shell", "console"], "one record first, then the console line once");

    let json = &arrived[0].1;
    assert!(json.len() <= CRASH_RECORD_MAX_BYTES);
    let record = CrashRecord::from_json(json.as_bytes()).expect("a genex-crash/1 record");
    assert_eq!(record.kind, CrashKind::Panic);
    assert_eq!(record.source, CrashSource::Game);
    assert!(record.fatal && !record.handled);
    assert_eq!(record.message, "index 7 of 3");
    let location = record.location.expect("the panic's location");
    assert!(location.file.ends_with("crash.rs"), "{}", location.file);
    assert_eq!(location.line, u64::from(line));
    assert_eq!(record.thread.map(|thread| thread.name).as_deref(), Some("game"));

    let console = &arrived[1].1;
    let file = location.file;
    let expected = console_text(&format!("panicked at {file}:{line}:{}:\nindex 7 of 3", location.column), STACK);
    assert_eq!(console, &expected, "the same console.error text as console_error_panic_hook");
}
