//! net-driver's process (multiplayer MP-6b): DRIVER.md's stdio loop around [`net_driver::Driver`].
//! stdout carries only contract lines; diagnostics go to stderr. The stdin reader thread is bench
//! scaffolding; the facade itself runs on this one loop: pumped every ~2 ms, ticked at 60 Hz.
//!
//! ```sh
//! node scripts/toolchains/rust-env.ts -- cargo build -p net-driver --offline
//! GENEX_CONFORMANCE_DRIVERS=rust GENEX_DRIVER_RUST=<target>/debug/net-driver \
//!   pnpm --filter @genex/netcode-bench test:conformance
//! ```

// Host tooling (a stdio process on the wall clock), never a game: a wasm32 build, as the
// six-destination check makes of every example, is an empty program.
#![cfg_attr(target_arch = "wasm32", no_main)]
#![cfg(not(target_arch = "wasm32"))]

use std::io::{BufRead, Write};
use std::sync::mpsc::{self, TryRecvError};
use std::time::{Duration, Instant};

use net_driver::{Driver, quit_command, quit_reply};
use serde_json::Value;

/// How long the loop sleeps between turns (the crate's driver polls every ~2 ms too).
const LOOP_SLEEP: Duration = Duration::from_millis(2);
/// One fixed tick of wall time.
const TICK: Duration = Duration::from_micros(16_667);
/// The most ticks one loop turn catches up; a longer stall drops the rest, as Live does.
const CATCH_UP_TICKS: u32 = 15;
/// Pumps after the final leave, so its frame goes out before the process exits.
const FINISH_PUMPS: u32 = 25;

fn emit(lines: impl IntoIterator<Item = Value>) {
    let mut out = std::io::stdout().lock();
    for line in lines {
        let _ = writeln!(out, "{line}");
    }
    let _ = out.flush();
}

fn main() {
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    emit([Driver::ready()]);
    let mut driver = Driver::relay();
    let mut next_tick = Instant::now();
    loop {
        loop {
            match rx.try_recv() {
                Ok(line) if line.trim().is_empty() => {}
                Ok(line) => {
                    if let Some(cmd_id) = quit_command(&line) {
                        emit([quit_reply(&cmd_id)]);
                        return finish(driver);
                    }
                    driver.command(&line);
                    emit(driver.take_output());
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => return finish(driver),
            }
        }
        driver.pump();
        let mut ran = 0;
        while Instant::now() >= next_tick && ran < CATCH_UP_TICKS {
            driver.tick();
            emit(driver.take_output());
            next_tick += TICK;
            ran += 1;
        }
        if ran == CATCH_UP_TICKS {
            next_tick = Instant::now() + TICK;
        }
        std::thread::sleep(LOOP_SLEEP);
    }
}

/// Leave (if seated), give the leave a moment to go out, then exit.
fn finish(mut driver: Driver) {
    driver.leave_and_flush();
    for _ in 0..FINISH_PUMPS {
        driver.pump();
        std::thread::sleep(LOOP_SLEEP);
    }
    emit(driver.take_output());
    std::process::exit(0);
}
