//! `genex-physics-room <folder> <deadline-ms>`: one room's physics world in a process of its own
//! (the crate's lib.rs says how it starts, what it answers and how it ends).

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::time::Duration;

use genex_physics::accounting::CountingAllocator;
use genex_physics_sidecar::frame::{Fault, LENGTH_BYTES, read_frame};
use genex_physics_sidecar::protocol::Request;
use genex_physics_sidecar::session::{After, Session};
use genex_physics_sidecar::watchdog::Watchdog;
use genex_physics_sidecar::{ADDRESS_SPACE_BASELINE, Config, OPEN_DEADLINE, exit, os};

/// Every allocation is charged to the world whose call is running (§11.1), as in the WASM build.
#[global_allocator]
static ALLOCATOR: CountingAllocator<std::alloc::System> = CountingAllocator::new(std::alloc::System);

/// Where a reply's `cpuNs` sits: after the length and the kind byte.
const CPU_AT: usize = LENGTH_BYTES + 1;
/// Descriptors the process keeps: stdin, stdout, stderr and the two FIFOs.
const OPEN_FILES: u64 = 5;
/// The address-space cap is `memoryBytes` times this, plus the baseline.
const MEMORY_HEADROOM: f64 = 1.5;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(config) = Config::parse(&args) else {
        eprintln!("usage: genex-physics-room <absolute folder> <deadline ms, 1..=600000>");
        std::process::exit(exit::SETUP);
    };
    os::die_with_parent();
    os::prefer_performance_cores();
    let _ = os::no_core_dumps();
    let watchdog = match Watchdog::start(config.deadline, || os::exit_now(exit::DEADLINE)) {
        Ok(watchdog) => watchdog,
        Err(error) => fail_setup("the watchdog thread", &error),
    };
    let (input, output) = open_fifos(&config, &watchdog);
    let _ = os::forbid_new_processes();
    let _ = os::limit_open_files(OPEN_FILES);
    serve(input, output, &watchdog, config.deadline);
}

fn fail_setup(what: &str, error: &dyn std::fmt::Display) -> ! {
    eprintln!("genex-physics-room: {what}: {error}");
    std::process::exit(exit::SETUP);
}

/// Makes and opens the FIFOs within [`OPEN_DEADLINE`], then unlinks them (lib.rs, step 1).
fn open_fifos(config: &Config, watchdog: &Watchdog) -> (File, File) {
    let (inbound, outbound) = (config.folder.join("in"), config.folder.join("out"));
    for path in [&inbound, &outbound] {
        if let Err(error) = os::mkfifo(path) {
            fail_setup("mkfifo", &error);
        }
    }
    watchdog.begin(OPEN_DEADLINE);
    let input = File::open(&inbound).unwrap_or_else(|error| fail_setup("opening in", &error));
    let output = OpenOptions::new().write(true).open(&outbound).unwrap_or_else(|error| fail_setup("opening out", &error));
    watchdog.end();
    for path in [&inbound, &outbound] {
        let _ = std::fs::remove_file(path);
    }
    (input, output)
}

fn fault(fault: &Fault) -> ! {
    eprintln!("genex-physics-room: protocol fault: {fault:?}");
    std::process::exit(exit::PROTOCOL);
}

/// Answers frames until the host leaves, shuts the process down, or a frame faults.
fn serve(mut input: File, mut output: File, watchdog: &Watchdog, deadline: Duration) -> ! {
    let mut session = Session::new();
    loop {
        let frame = match read_frame(&mut input) {
            Ok(Some(frame)) => frame,
            Ok(None) => std::process::exit(exit::CLEAN),
            Err(error) => fault(&error),
        };
        watchdog.begin(deadline);
        let cpu_start = os::thread_cpu_ns();
        let handled = catch_unwind(AssertUnwindSafe(|| Request::decode(&frame).and_then(|request| session.handle(request))));
        let handled = match handled {
            Ok(Ok(handled)) => handled,
            Ok(Err(error)) => fault(&error),
            Err(_) => os::exit_now(exit::INTERNAL),
        };
        let Some(mut bytes) = handled.reply.finish() else { os::exit_now(exit::INTERNAL) };
        let cpu = os::thread_cpu_ns().saturating_sub(cpu_start);
        bytes[CPU_AT..CPU_AT + 8].copy_from_slice(&cpu.to_le_bytes());
        if output.write_all(&bytes).is_err() {
            std::process::exit(exit::CLEAN);
        }
        watchdog.end();
        match handled.after {
            After::Continue => {}
            After::Exit => std::process::exit(exit::CLEAN),
            After::Created { memory_bytes } => {
                let cap = (memory_bytes as f64 * MEMORY_HEADROOM) as u64 + ADDRESS_SPACE_BASELINE;
                let _ = os::limit_address_space(cap);
            }
        }
    }
}
