//! Crash reports (G6 PROFILE over genex-crash): the runtime names the seed and each tick in the
//! process's crash context (atomics the hook reads without waiting), and a shell installs the hook
//! with its sinks: a studio run sends each record over the studio's channel
//! (`genex_studio::report_panics`), a desktop export writes it under the save root's
//! `genex-crash/` ([`install_file_sink`]). A record then names the seed and the tick a panic
//! happened on, the inputs an agent replays it from. Nothing here is readable by a tick.

/// The context a crash record carries; the process's context is global, this marks the hooks.
#[derive(Debug, Default)]
pub(crate) struct State;

impl State {
    /// A new seed: the run's seed, and no tick yet.
    pub(crate) fn seeded(&mut self, seed: u32) {
        genex_crash::context().set_seed(seed);
    }

    /// At the start of a tick: the tick a crash would name (the simulation is stepping it).
    pub(crate) fn enter_tick(&mut self, tick: u64) {
        let simulated_ms = tick as f64 * genex_core::clock::FIXED_STEP_MS;
        genex_crash::context().set_tick(tick, simulated_ms, true);
    }
}

/// A profiled frame closed: the frame a crash would name.
pub(crate) fn frame_closed(frame: u64) {
    genex_crash::context().set_frame(frame);
}

/// The last profile summary, for a record to carry.
pub(crate) fn profile_summary(json: &[u8]) {
    genex_crash::context().set_profile_summary(json);
}

/// Name the build crash records describe (host glue: a shell, once): `destination` (`mac`, ...),
/// the flavour (`dev` for a studio run), the build's name and the game contract's version.
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
pub(crate) fn set_identity(destination: &str, dev: bool, build: &str, contract: u64) {
    let flavour = if dev { genex_crash::CrashFlavour::Dev } else { genex_crash::CrashFlavour::Export };
    genex_crash::context().set_identity(genex_crash::CrashIdentity {
        destination: destination.to_owned(),
        flavour,
        build: build.to_owned(),
        contract,
        genex: env!("CARGO_PKG_VERSION").to_owned(),
    });
}

/// Install the crash hook with a file sink under `saves`' root (`genex-crash/<n>.json`, at most
/// 16 kept): a desktop export's records, read by the Studio or a person. Idempotent per process.
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
pub(crate) fn install_file_sink(saves: &genex_core::saves::Saves) -> genex_crash::Installed {
    genex_crash::install(vec![Box::new(genex_crash::FileSink::new(saves))])
}
