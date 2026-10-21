//! Crash context through the facade (game systems PROF-5): the runtime names each tick and the
//! seed for the crash hook (genex-crash), so a panic inside a game's update becomes one
//! `genex-crash/1` record whose context says the seed and the tick it happened on, the inputs an
//! agent replays it from. One test per binary: the hook is the process's and installs once.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, Mutex};

use genex::prelude::*;
use genex::{FIXED_STEP_MS, Runtime};
use genex_crash::{CrashKind, CrashRecord, FnSink};

const CRASH_TICK: u64 = 300;

#[derive(Default)]
struct World;

#[test]
fn a_panicking_update_at_tick_300_sends_one_record_naming_tick_300_and_seed_1() {
    let records: Arc<Mutex<Vec<Vec<u8>>>> = Arc::default();
    let sink = Arc::clone(&records);
    let _installed = genex_crash::install(vec![Box::new(FnSink(move |_record: &CrashRecord, json: &[u8]| {
        sink.lock().expect("records").push(json.to_vec());
    }))]);
    let mut game = Game::new(World).title("Crashes").world_size(96, 64);
    game.on_update(|_, ctx| {
        assert!(ctx.tick != CRASH_TICK, "the enemy list ran dry at tick {}", ctx.tick);
    });
    let mut runtime = Runtime::new(game).expect("valid registrations");
    runtime.seed(1);
    runtime.start();
    let crashed = catch_unwind(AssertUnwindSafe(|| {
        for _ in 0..400 {
            runtime.step(FIXED_STEP_MS);
        }
    }));
    assert!(crashed.is_err(), "the update panicked");
    let records = records.lock().expect("records");
    assert_eq!(records.len(), 1, "one record per panic");
    let record = CrashRecord::from_json(&records[0]).expect("a genex-crash/1 record");
    assert_eq!(record.kind, CrashKind::Panic);
    assert_eq!(record.context.tick, Some(CRASH_TICK), "{}", String::from_utf8_lossy(&records[0]));
    assert_eq!(record.context.seed, Some(1));
    assert!(record.message.contains("ran dry at tick 300"), "{}", record.message);
}
