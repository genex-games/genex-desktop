//! genex-physics-sidecar: the native process of Genex Physics, contract 1.0
//! (`../genex-physics/CONTRACT.md`; section numbers below are its own).
//!
//! The authority server runs one deterministic world per room. Each room's world runs in a process
//! of its own, the bin `genex-physics-room`, so a crash, hang or fault ends that room alone (the
//! room ends `internal`, §11.3) and never the server. The host (`@genex-ai/physics-native`,
//! `genex-physics/js/native.js`) starts it, and the two speak over two FIFOs in a folder the host
//! gives it: blocking round trips of the frame protocol (`protocol.rs`), one per room tick.
//!
//! ```text
//! genex-physics-room <folder> <deadline-ms>
//! ```
//!
//! 1. The process makes the FIFOs `<folder>/in` and `<folder>/out` (mode 0600), opens `in` for
//!    reading and `out` for writing (each open waits for the host's; [`OPEN_DEADLINE`]), then
//!    unlinks both: they live on as open descriptors only, and a crash leaves nothing behind.
//! 2. It reads frames and answers each one in order. A frame that takes longer than the deadline
//!    ends the process ([`exit::DEADLINE`]); a malformed or out-of-order frame ends it
//!    ([`exit::PROTOCOL`]) before anything of that frame runs; the host closing its end, or
//!    `Shutdown`, ends it cleanly.
//! 3. Once the world exists its address space is capped at `memoryBytes × 1.5` plus
//!    [`ADDRESS_SPACE_BASELINE`] (Linux enforces it; best-effort on macOS); it opens no descriptor
//!    and starts no process or thread past the ones it holds, and dumps no core.
//!
//! A panic inside the core is caught per world and answers `internal` (genex-physics `World`). The
//! process has no network code: the package test holds the Linux binary to importing no socket
//! call.

pub mod frame;
#[cfg(unix)]
pub mod os;
pub mod protocol;
pub mod session;
pub mod watchdog;

use std::time::Duration;

/// This crate's tests measure memory as the binary does: every allocation is charged to the world
/// whose call is running (§11.1).
#[cfg(test)]
#[global_allocator]
static ALLOCATOR: genex_physics::accounting::CountingAllocator<std::alloc::System> =
    genex_physics::accounting::CountingAllocator::new(std::alloc::System);

/// How long opening the FIFOs may wait for the host: it opens them as soon as they exist.
pub const OPEN_DEADLINE: Duration = Duration::from_secs(10);
/// The address space over `memoryBytes × 1.5`: the code, stacks and allocator, and the largest
/// input one call's budget admits parsed whole (about 110 MB of JSON text at the 4x ceiling, read
/// into a JSON tree several times its size; core.js `inputBudget`).
pub const ADDRESS_SPACE_BASELINE: u64 = 1024 * 1024 * 1024;
/// The deadline's range in milliseconds, inclusive.
pub const DEADLINE_MS: std::ops::RangeInclusive<u64> = 1..=600_000;

/// The process's exit codes.
pub mod exit {
    /// `Shutdown`, or the host closed its end (EOF, or EPIPE on a reply).
    pub const CLEAN: i32 = 0;
    /// Bad arguments, or the FIFOs could not be made or opened.
    pub const SETUP: i32 = 2;
    /// A malformed or out-of-order frame (`frame::Fault`): nothing of it ran.
    pub const PROTOCOL: i32 = 3;
    /// A frame (or opening the FIFOs) ran past its deadline.
    pub const DEADLINE: i32 = 4;
    /// A panic outside the core's own catch, or a reply too large to frame.
    pub const INTERNAL: i32 = 5;
}

/// The command line: the FIFO folder and the per-frame deadline.
#[derive(Debug, PartialEq, Eq)]
pub struct Config {
    /// The folder the FIFOs are made in: an existing directory, not a link.
    pub folder: std::path::PathBuf,
    /// How long one frame may take.
    pub deadline: Duration,
}

impl Config {
    /// Reads `<folder> <deadline-ms>`; `None` for anything else.
    pub fn parse(args: &[String]) -> Option<Self> {
        let [folder, deadline] = args else { return None };
        let millis: u64 = deadline.parse().ok().filter(|ms| DEADLINE_MS.contains(ms))?;
        let folder = std::path::PathBuf::from(folder);
        let is_dir = std::fs::symlink_metadata(&folder).is_ok_and(|meta| meta.is_dir());
        (folder.is_absolute() && is_dir).then_some(Self { folder, deadline: Duration::from_millis(millis) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_command_line_names_an_existing_absolute_folder_and_a_deadline_in_range() {
        let dir = std::env::temp_dir().canonicalize().expect("temp");
        let text = dir.to_string_lossy().into_owned();
        let args = |a: &[&str]| a.iter().map(|s| (*s).to_string()).collect::<Vec<_>>();
        assert_eq!(Config::parse(&args(&[&text, "16"])), Some(Config { folder: dir.clone(), deadline: Duration::from_millis(16) }));
        let link = dir.join(format!("gxph-link-{}", std::process::id()));
        std::os::unix::fs::symlink(&dir, &link).expect("a link");
        let link_text = link.to_string_lossy().into_owned();
        let hostile: [&[&str]; 9] = [
            &[],
            &[&text],
            &[&text, "16", "x"],
            &[&text, "0"],
            &[&text, "600001"],
            &[&text, "-5"],
            &[&text, "1e3"],
            &["relative/folder", "16"],
            &[&link_text, "16"],
        ];
        for row in hostile {
            assert_eq!(Config::parse(&args(row)), None, "{row:?}");
        }
        std::fs::remove_file(&link).expect("cleaned");
    }
}
