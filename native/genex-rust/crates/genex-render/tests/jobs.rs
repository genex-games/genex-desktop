//! STR-4: the job pool's priority, cancel and finish queue.
//!
//! Every row runs on the host (CPU only, no GPU):
//!
//!   node scripts/toolchains/rust-env.ts -- cargo test -p genex-render --offline --locked --test jobs
//!
//! The pool rows use their own two-thread [`Pool`] held while the queue is filled, so what runs
//! first is the pool's choice and never a race with the submitting thread. The finish queue rows
//! read a fake clock that advances only when an item is finished.

use std::cell::Cell;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
use genex_render::jobs::{FINISH_BUDGET_DESKTOP_MS, FINISH_BUDGET_PHONE_MS, FinishQueue, JobError, JobState, Pool, Priority, finish_budget_ms};

/// How long each held-back `Prefetch` job takes: long enough that a `Sim` job started beside the
/// first of them always finishes before it.
const PREFETCH_JOB: Duration = Duration::from_millis(5);

/// The order jobs finished in, by name.
#[derive(Clone, Default)]
struct Finished(Arc<Mutex<Vec<String>>>);

impl Finished {
    fn record(&self, name: String) {
        self.0.lock().expect("finished list").push(name);
    }

    fn names(&self) -> Vec<String> {
        self.0.lock().expect("finished list").clone()
    }
}

#[test]
fn a_cancelled_queued_job_never_runs() {
    let pool = Pool::new(2);
    let ran = Arc::new(AtomicUsize::new(0));
    let hold = pool.hold();
    let job = pool.spawn(Priority::Prefetch, {
        let ran = Arc::clone(&ran);
        move || ran.fetch_add(1, Ordering::SeqCst)
    });
    assert_eq!(job.state(), JobState::Queued, "held: nothing has started");
    assert!(job.cancel(), "a queued job cancels");
    assert_eq!(job.state(), JobState::Cancelled);
    drop(hold);
    // A job behind it on the same lane shows the pool has passed the cancelled one.
    let after = pool.spawn(Priority::Prefetch, || 1_u8);
    assert_eq!(after.wait(), Ok(&1));
    assert_eq!(job.wait(), Err(JobError::Cancelled));
    assert_eq!(ran.load(Ordering::SeqCst), 0, "the cancelled job's closure never ran");
    assert!(!job.cancel(), "a cancel is answered once");
}

#[test]
fn a_started_or_finished_job_does_not_cancel() {
    let pool = Pool::new(2);
    let job = pool.spawn(Priority::Visible, || 6 * 7);
    assert_eq!(job.wait(), Ok(&42));
    assert_eq!(job.state(), JobState::Finished);
    assert!(!job.cancel(), "a finished job keeps its value");
    assert_eq!(job.into_result(), Ok(42));
}

#[test]
fn a_sim_job_submitted_after_100_prefetch_jobs_finishes_first_on_2_threads() {
    let pool = Pool::new(2);
    assert_eq!(pool.threads(), 2);
    let finished = Finished::default();
    let hold = pool.hold();
    let prefetch: Vec<_> = (0..100)
        .map(|index| {
            let finished = finished.clone();
            pool.spawn(Priority::Prefetch, move || {
                std::thread::sleep(PREFETCH_JOB);
                finished.record(format!("prefetch-{index}"));
            })
        })
        .collect();
    let sim = pool.spawn(Priority::Sim, {
        let finished = finished.clone();
        move || finished.record("sim".to_owned())
    });
    drop(hold);
    assert_eq!(sim.wait(), Ok(&()));
    for job in &prefetch {
        assert_eq!(job.wait(), Ok(&()));
    }
    let names = finished.names();
    assert_eq!(names.len(), 101);
    assert_eq!(names[0], "sim", "the Sim job finishes first: {:?}", &names[..4]);
}

#[test]
fn lanes_run_sim_then_visible_then_prefetch_and_each_lane_in_submission_order() {
    // One thread, so the start order is the finish order.
    let pool = Pool::new(1);
    let finished = Finished::default();
    let hold = pool.hold();
    let submitted = [(Priority::Prefetch, "p0"), (Priority::Visible, "v0"), (Priority::Prefetch, "p1"), (Priority::Sim, "s0"), (Priority::Visible, "v1"), (Priority::Sim, "s1")];
    let jobs: Vec<_> = submitted
        .iter()
        .map(|&(priority, name)| {
            let finished = finished.clone();
            pool.spawn(priority, move || finished.record(name.to_owned()))
        })
        .collect();
    assert_eq!(pool.queued(), 6);
    drop(hold);
    for job in &jobs {
        assert_eq!(job.wait(), Ok(&()));
    }
    assert_eq!(finished.names(), ["s0", "s1", "v0", "v1", "p0", "p1"]);
    assert_eq!(pool.queued(), 0);
}

#[test]
fn a_job_that_panicked_reports_its_message_and_the_pool_keeps_running() {
    let pool = Pool::new(2);
    let failed = pool.spawn(Priority::Sim, || -> u32 { panic!("bad cell pack") });
    assert_eq!(failed.wait(), Err(JobError::Panicked("bad cell pack".to_owned())));
    assert_eq!(failed.state(), JobState::Finished);
    assert_eq!(pool.spawn(Priority::Sim, || 3_u8).into_result(), Ok(3));
}

#[test]
fn an_inline_pool_runs_each_job_where_it_is_submitted() {
    // The web's pool (no threads): a job is finished when `spawn` returns, so nothing cancels.
    let pool = Pool::inline();
    assert_eq!(pool.threads(), 0);
    let job = pool.spawn(Priority::Prefetch, || std::thread::current().id());
    assert_eq!(job.state(), JobState::Finished);
    assert_eq!(job.wait(), Ok(&std::thread::current().id()));
    assert!(!job.cancel());
}

#[test]
fn a_ready_job_is_its_value() {
    let job = genex_render::jobs::Job::ready("made");
    assert_eq!(job.state(), JobState::Finished);
    assert_eq!(job.try_get(), Some(Ok(&"made")));
}

#[test]
fn try_get_never_waits() {
    let pool = Pool::new(1);
    let hold = pool.hold();
    let job = pool.spawn(Priority::Visible, || 5_u8);
    assert_eq!(job.try_get(), None, "held: not made yet");
    drop(hold);
    assert_eq!(job.wait(), Ok(&5));
    assert_eq!(job.try_get(), Some(Ok(&5)));
}

/// A fake clock: `now_ms` reads it, and finishing an item advances it.
fn fake_clock(now: &Cell<f64>) -> impl FnMut() -> f64 + '_ {
    || now.get()
}

#[test]
fn the_finish_queue_stops_at_its_budget_under_a_fake_clock() {
    let now = Cell::new(100.0);
    let mut queue = FinishQueue::new();
    for index in 0..20 {
        queue.push(Priority::Prefetch, index);
    }
    let mut done = Vec::new();
    let report = queue.drain(2.0, &mut fake_clock(&now), |item| {
        // Each item costs 0.3 ms of fake time.
        now.set(now.get() + 0.3);
        done.push(item);
    });
    // 0.3 ms each: the seventh item crosses 2.0 ms (2.1), and the drain stops there.
    assert_eq!(done, [0, 1, 2, 3, 4, 5, 6]);
    assert_eq!(report.finished, 7);
    assert_eq!(report.left, 13);
    assert!((report.spent_ms - 2.1).abs() < 1e-9, "{report:?}");
    assert_eq!(queue.len(), 13);
    // The next frame carries on where it stopped.
    let mut next = Vec::new();
    let report = queue.drain(2.0, &mut fake_clock(&now), |item| {
        now.set(now.get() + 0.3);
        next.push(item);
    });
    assert_eq!(next, [7, 8, 9, 10, 11, 12, 13]);
    assert_eq!(report.left, 6);
}

#[test]
fn the_finish_queue_finishes_sim_work_first_and_one_item_even_over_budget() {
    let now = Cell::new(0.0);
    let mut queue = FinishQueue::new();
    queue.push(Priority::Prefetch, "prefetch");
    queue.push(Priority::Visible, "visible");
    queue.push(Priority::Sim, "sim");
    let mut done = Vec::new();
    // One item alone costs more than the whole budget: it still finishes, so nothing starves.
    let report = queue.drain(1.0, &mut fake_clock(&now), |item| {
        now.set(now.get() + 5.0);
        done.push(item);
    });
    assert_eq!(done, ["sim"]);
    assert_eq!(report.finished, 1);
    assert_eq!(report.left, 2);
    let report = queue.drain(100.0, &mut fake_clock(&now), |item| done.push(item));
    assert_eq!(done, ["sim", "visible", "prefetch"]);
    assert_eq!(report.left, 0);
    assert!(queue.is_empty());
}

#[test]
fn an_empty_finish_queue_reads_the_clock_once_and_finishes_nothing() {
    let reads = Cell::new(0_u32);
    let mut queue: FinishQueue<u8> = FinishQueue::new();
    let report = queue.drain(2.0, &mut || {
        reads.set(reads.get() + 1);
        0.0
    }, |_| unreachable!("nothing queued"));
    assert_eq!(report.finished, 0);
    assert!(reads.get() <= 1);
}

#[test]
fn work_handed_in_from_a_job_thread_is_finished_on_the_drain() {
    let pool = Pool::new(2);
    let mut queue = FinishQueue::new();
    let inbox = queue.inbox();
    let jobs: Vec<_> = (0..4_u32)
        .map(|cell| {
            let inbox = inbox.clone();
            pool.spawn(Priority::Visible, move || inbox.push(Priority::Visible, cell * 10))
        })
        .collect();
    for job in &jobs {
        assert_eq!(job.wait(), Ok(&()));
    }
    assert_eq!(queue.len(), 4, "handed-in work counts before the drain");
    let now = Cell::new(0.0);
    let mut done = Vec::new();
    queue.drain(2.0, &mut fake_clock(&now), |item| done.push(item));
    done.sort_unstable();
    assert_eq!(done, [0, 10, 20, 30]);
    assert!(queue.is_empty());
}

#[test]
fn phones_get_the_smaller_finish_budget() {
    assert_eq!(FINISH_BUDGET_DESKTOP_MS, 2.0);
    assert_eq!(FINISH_BUDGET_PHONE_MS, 1.0);
    for class in DeviceClass::ALL {
        let expected = if class.form == FormFactor::Mobile { FINISH_BUDGET_PHONE_MS } else { FINISH_BUDGET_DESKTOP_MS };
        assert_eq!(finish_budget_ms(class), expected, "{class:?}");
    }
    assert_eq!(finish_budget_ms(DeviceClass::new(FormFactor::Desktop, PerformanceTier::Low)), 2.0);
}
