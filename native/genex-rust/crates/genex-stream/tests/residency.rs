//! The residency policy (STR-6): request and release sequences with a fake clock, checked for the
//! four promises the view set relies on. Bytes never exceed the pool after a drain; a Sim-referenced
//! entry is never evicted; with `forbid_holes` an HLOD stays until its last child arrives; and the
//! eviction order is equal across runs. Pure: no GPU, no IO, no wall clock.

use genex_stream::residency::{
    EntryState, Requester, Residency, ResidencyClock, ResidencyLimits, Want, screen_space_error_px,
};

const MIB: u64 = 1024 * 1024;

/// A clock that moves `step_ms` on every read, so a drain's time limit is exact.
struct FakeClock {
    now: f64,
    step_ms: f64,
}

impl FakeClock {
    fn still() -> FakeClock {
        FakeClock { now: 0.0, step_ms: 0.0 }
    }

    fn stepping(step_ms: f64) -> FakeClock {
        FakeClock { now: 0.0, step_ms }
    }
}

impl ResidencyClock for FakeClock {
    fn now_ms(&mut self) -> f64 {
        let now = self.now;
        self.now += self.step_ms;
        now
    }
}

/// One step of a request and release sequence.
#[derive(Clone, Copy, Debug)]
enum Op {
    /// Request `key` for a requester at a priority (screen-space error, px) with an estimate.
    Req(u32, Requester, f32, u64),
    /// Request `key` under `parent` (an HLOD and its children).
    ReqUnder(u32, Requester, f32, u64, u32),
    Rel(u32, Requester),
    /// Start what the in-flight cap and the pool allow.
    Start,
    /// Every load in flight finishes with its estimate.
    FinishAll,
    Finish(u32, u64),
    Fail(u32),
    Drain,
}

/// What a sequence did: the keys started and evicted, in order.
#[derive(Debug, Default, PartialEq)]
struct Log {
    started: Vec<u32>,
    evicted: Vec<u32>,
}

/// Runs `ops`, checking after every drain that resident bytes fit the pool (when the referenced
/// and pinned bytes alone fit it) and that no Sim-referenced key was evicted.
fn run(limits: ResidencyLimits, ops: &[Op]) -> (Residency<u32>, Log) {
    let mut policy = Residency::new(limits);
    let mut clock = FakeClock::still();
    let mut log = Log::default();
    let mut in_flight: Vec<(u32, u64)> = Vec::new();
    for op in ops {
        match *op {
            Op::Req(key, who, px, bytes) => {
                policy.request(key, who, Want::new(px, bytes));
            }
            Op::ReqUnder(key, who, px, bytes, parent) => {
                policy.request(key, who, Want::new(px, bytes).under(parent));
            }
            Op::Rel(key, who) => {
                policy.release(key, who);
            }
            Op::Start => {
                for key in policy.start_loads() {
                    log.started.push(key);
                    let bytes = policy.estimated_bytes(key).expect("a started key has an estimate");
                    in_flight.push((key, bytes));
                }
            }
            Op::FinishAll => {
                for (key, bytes) in in_flight.drain(..) {
                    policy.finish(key, bytes);
                }
            }
            Op::Finish(key, bytes) => {
                in_flight.retain(|(k, _)| *k != key);
                policy.finish(key, bytes);
            }
            Op::Fail(key) => {
                in_flight.retain(|(k, _)| *k != key);
                policy.fail(key);
            }
            Op::Drain => {
                let evicted = policy.drain(&mut clock);
                for key in &evicted {
                    assert_eq!(policy.refs(*key, Requester::Sim), 0, "a Sim-referenced key {key} was evicted");
                    assert_eq!(policy.state(*key), None, "an evicted key {key} is forgotten");
                }
                log.evicted.extend(evicted);
                let stats = policy.stats();
                if stats.held_bytes <= limits.pool_bytes {
                    assert!(
                        stats.resident_bytes <= limits.pool_bytes,
                        "resident {} over the pool {} after a drain",
                        stats.resident_bytes,
                        limits.pool_bytes
                    );
                }
            }
        }
    }
    (policy, log)
}

/// A small deterministic generator for long sequences (no rand crate in a simulation crate's tests).
struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u32 {
        self.0 = self.0.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        (self.0 >> 33) as u32
    }

    fn below(&mut self, n: u32) -> u32 {
        self.next() % n
    }
}

/// A fly-path-like churn: 64 keys, View requests and releases with SSE priorities, a few Sim and
/// Kept holds, loads finishing a frame later, a drain every frame.
fn churn(seed: u64, frames: usize) -> Vec<Op> {
    let mut rng = Lcg(seed);
    let mut ops = Vec::new();
    let mut held: Vec<(u32, Requester)> = Vec::new();
    for frame in 0..frames {
        for _ in 0..6 {
            let key = rng.below(64);
            let roll = rng.below(10);
            let who = match roll {
                0 => Requester::Sim,
                1 => Requester::Kept,
                _ => Requester::View,
            };
            let sim_held = held.iter().filter(|(_, w)| *w == Requester::Sim).count();
            if who == Requester::Sim && sim_held >= 4 {
                continue;
            }
            let px = (rng.below(4000) as f32) / 10.0;
            let bytes = u64::from(1 + rng.below(8)) * MIB;
            ops.push(Op::Req(key, who, px, bytes));
            held.push((key, who));
        }
        for _ in 0..5 {
            if held.is_empty() {
                break;
            }
            let at = rng.below(held.len() as u32) as usize;
            let (key, who) = held.remove(at);
            ops.push(Op::Rel(key, who));
        }
        ops.push(Op::FinishAll);
        ops.push(Op::Start);
        ops.push(Op::Drain);
        if frame % 50 == 49 {
            for (key, who) in held.drain(..) {
                ops.push(Op::Rel(key, who));
            }
            ops.push(Op::Drain);
        }
    }
    ops
}

#[test]
fn bytes_never_exceed_the_pool_after_a_drain() {
    use Op::*;
    use Requester::*;
    let limits = ResidencyLimits::new(10 * MIB, 4);
    let tables: [&[Op]; 3] = [
        // Fill the pool, release, then want more: the released entries make room.
        &[
            Req(1, View, 10.0, 4 * MIB),
            Req(2, View, 9.0, 4 * MIB),
            Start,
            FinishAll,
            Drain,
            Rel(1, View),
            Rel(2, View),
            Req(3, View, 8.0, 6 * MIB),
            Req(4, View, 7.0, 3 * MIB),
            Start,
            FinishAll,
            Drain,
        ],
        // A finish larger than its estimate pushes over; the drain evicts the unreferenced.
        &[
            Req(1, View, 1.0, MIB),
            Req(2, View, 1.0, MIB),
            Start,
            FinishAll,
            Rel(1, View),
            Req(3, View, 5.0, 4 * MIB),
            Start,
            Finish(3, 9 * MIB),
            Drain,
        ],
        // A View load that cannot fit waits for room instead of overfilling the pool.
        &[
            Req(1, Kept, 1.0, 8 * MIB),
            Start,
            FinishAll,
            Req(2, View, 99.0, 4 * MIB),
            Start,
            FinishAll,
            Drain,
            Rel(1, Kept),
            Drain,
            Start,
            FinishAll,
            Drain,
        ],
    ];
    for ops in tables {
        run(limits, ops);
    }
    let (_, log) = run(limits, tables[2]);
    assert_eq!(log.started, vec![1, 2], "key 2 starts only after key 1's bytes are released");

    for seed in [1, 7, 42] {
        let (policy, log) = run(ResidencyLimits::new(24 * MIB, 3), &churn(seed, 300));
        assert!(!log.evicted.is_empty(), "the churn evicts (seed {seed})");
        assert!(policy.stats().resident_bytes <= 24 * MIB);
    }
}

#[test]
fn a_sim_referenced_entry_is_never_evicted() {
    use Op::*;
    use Requester::*;
    let limits = ResidencyLimits::new(8 * MIB, 8);
    let ops = [
        Req(1, Sim, 0.0, 4 * MIB),
        Req(1, View, 50.0, 4 * MIB),
        Req(2, View, 40.0, 3 * MIB),
        Start,
        FinishAll,
        // Both leave the view: 1 is still the sim's.
        Rel(1, View),
        Rel(2, View),
        Req(3, View, 30.0, 4 * MIB),
        Start,
        FinishAll,
        Drain,
    ];
    let (policy, log) = run(limits, &ops);
    assert_eq!(log.evicted, vec![2], "only the unreferenced View entry goes");
    assert_eq!(policy.state(1), Some(EntryState::Resident));
    assert_eq!(policy.refs(1, Sim), 1);

    // A Sim load starts even when the pool is full of referenced View bytes: the sim set never waits
    // on the view budget.
    let ops = [Req(1, View, 9.0, 8 * MIB), Start, FinishAll, Req(2, Sim, 0.0, 4 * MIB), Start, Fail(2), Drain];
    let (policy, log) = run(limits, &ops);
    assert_eq!(log.started, vec![1, 2]);
    assert_eq!(policy.state(2), Some(EntryState::Refused), "a failed Sim load is refused, not retried");

    for seed in [3, 11] {
        run(ResidencyLimits::new(16 * MIB, 2), &churn(seed, 300));
    }
}

#[test]
fn forbid_holes_keeps_the_hlod_until_the_last_child_arrives() {
    use Op::*;
    use Requester::*;
    let hlod = 100;
    let sequence = |forbid: bool| {
        let mut limits = ResidencyLimits::new(9 * MIB, 8);
        limits.forbid_holes = forbid;
        let ops = [
            Req(hlod, View, 2.0, 4 * MIB),
            Start,
            FinishAll,
            // The camera comes close: the cell's detail models are wanted and the HLOD released.
            ReqUnder(1, View, 20.0, 3 * MIB, hlod),
            ReqUnder(2, View, 20.0, 3 * MIB, hlod),
            ReqUnder(3, View, 20.0, 3 * MIB, hlod),
            Rel(hlod, View),
            Start,
            Finish(1, 3 * MIB),
            Finish(2, 3 * MIB),
            Drain,
        ];
        run(limits, &ops)
    };

    let (mut policy, log) = sequence(true);
    assert!(log.evicted.is_empty(), "the HLOD stays while child 3 is loading");
    assert_eq!(policy.state(hlod), Some(EntryState::Resident));
    assert_eq!(policy.stand_in(3), Some(hlod), "the HLOD draws in place of the missing child");
    assert_eq!(policy.stand_in(1), Some(1), "a resident child draws itself");
    policy.finish(3, 3 * MIB);
    let evicted = policy.drain(&mut FakeClock::still());
    assert_eq!(evicted, vec![hlod], "the last child arrived: the HLOD goes");
    assert!(policy.stats().resident_bytes <= 9 * MIB);

    // A refused child is no hole: it will never arrive, so it does not keep the HLOD forever.
    let (mut policy, _) = sequence(true);
    policy.fail(3);
    assert_eq!(policy.drain(&mut FakeClock::still()), vec![hlod]);

    // Control: without forbid_holes the HLOD is evicted at the first drain over the pool.
    let (_, log) = sequence(false);
    assert_eq!(log.evicted, vec![hlod]);
}

#[test]
fn eviction_order_is_equal_across_runs_and_follows_release_order() {
    use Op::*;
    use Requester::*;
    for seed in [5, 9, 1234] {
        let ops = churn(seed, 400);
        let limits = ResidencyLimits::new(20 * MIB, 4);
        let (first_policy, first) = run(limits, &ops);
        let (second_policy, second) = run(limits, &ops);
        assert!(!first.evicted.is_empty());
        assert_eq!(first, second, "seed {seed}: two runs differ");
        assert_eq!(first_policy.stats(), second_policy.stats());
    }

    // Least recently released first: 3, then 1, then 2.
    let mut ops = vec![
        Req(1, View, 1.0, 2 * MIB),
        Req(2, View, 1.0, 2 * MIB),
        Req(3, View, 1.0, 2 * MIB),
        Start,
        FinishAll,
        Rel(3, View),
        Rel(1, View),
        Rel(2, View),
    ];
    ops.extend([Req(4, View, 1.0, 6 * MIB), Start, FinishAll, Drain]);
    let (_, log) = run(ResidencyLimits::new(6 * MIB, 4), &ops);
    assert_eq!(log.evicted, vec![3, 1, 2]);
}

#[test]
fn a_re_requested_entry_revives_without_a_reload() {
    use Requester::*;
    let mut policy = Residency::new(ResidencyLimits::new(4 * MIB, 4));
    policy.request(1u32, View, Want::new(1.0, 2 * MIB));
    assert_eq!(policy.start_loads(), vec![1]);
    policy.finish(1, 2 * MIB);
    policy.release(1, View);
    assert_eq!(policy.request(1, View, Want::new(1.0, 2 * MIB)), EntryState::Resident);
    assert!(policy.start_loads().is_empty(), "no second load");
    policy.request(2, View, Want::new(1.0, 3 * MIB));
    assert!(policy.start_loads().is_empty(), "2 waits: 1 is referenced again");
    assert!(policy.drain(&mut FakeClock::still()).is_empty());
    assert_eq!(policy.stats().waiting_for_room, 1);
}

#[test]
fn loads_start_by_sim_first_then_screen_space_error_under_the_in_flight_cap() {
    use Requester::*;
    let mut policy = Residency::new(ResidencyLimits::new(64 * MIB, 3));
    policy.request(1u32, View, Want::new(5.0, MIB));
    policy.request(2, View, Want::new(50.0, MIB));
    policy.request(3, View, Want::new(f32::NAN, MIB));
    policy.request(4, Ticket, Want::new(0.0, MIB));
    policy.request(5, View, Want::new(50.0, MIB));
    assert_eq!(policy.start_loads(), vec![4, 2, 5], "ticket first, then by error, ties by request order");
    assert!(policy.start_loads().is_empty(), "three in flight is the cap");
    assert_eq!(policy.stats().in_flight, 3);
    policy.finish(2, MIB);
    assert_eq!(policy.start_loads(), vec![1]);
    policy.fail(4);
    assert_eq!(policy.start_loads(), vec![3], "a NaN priority sorts last");
    assert_eq!(policy.state(4), Some(EntryState::Refused));
    assert_eq!(policy.stats().refused, 1);

    // A queued entry released before it starts is dropped, never loaded.
    policy.request(6, View, Want::new(99.0, MIB));
    policy.release(6, View);
    assert_eq!(policy.state(6), None);
    // A loading entry released finishes into the unload queue.
    policy.release(1, View);
    policy.finish(1, MIB);
    assert_eq!(policy.state(1), Some(EntryState::Resident));
    assert!(!policy.is_referenced(1));
}

#[test]
fn the_drain_stops_at_its_time_limit_and_resumes_next_frame() {
    use Requester::*;
    let mut limits = ResidencyLimits::new(0, 16);
    limits.unload_time_limit_ms = 2.0;
    let mut policy = Residency::new(limits);
    for key in 0u32..10 {
        policy.request(key, View, Want::new(1.0, MIB));
    }
    let mut big = ResidencyLimits::new(64 * MIB, 16);
    big.unload_time_limit_ms = 2.0;
    policy.set_limits(big);
    assert_eq!(policy.start_loads().len(), 10);
    for key in 0..10 {
        policy.finish(key, MIB);
        policy.release(key, View);
    }
    policy.set_limits(limits);
    // One read at the start, one after each eviction: 1 ms a read stops after the second eviction.
    let mut clock = FakeClock::stepping(1.0);
    assert_eq!(policy.drain(&mut clock), vec![0, 1]);
    assert_eq!(policy.drain(&mut clock), vec![2, 3]);
    limits.unload_time_limit_ms = 0.0;
    policy.set_limits(limits);
    assert_eq!(policy.drain(&mut clock), vec![4, 5, 6, 7, 8, 9], "a zero limit is unthrottled");
    assert_eq!(policy.stats().resident_bytes, 0);
    assert_eq!(policy.stats().evicted, 10);
}

/// One hostile call; true when it reported a change.
type HostileCall = fn(&mut Residency<u32>) -> bool;

#[test]
fn hostile_calls_change_nothing() {
    use Requester::*;
    let build = || {
        let mut policy = Residency::new(ResidencyLimits::new(8 * MIB, 2));
        policy.request(1u32, View, Want::new(1.0, MIB));
        policy.request(2, View, Want::new(1.0, MIB).under(1));
        policy.start_loads();
        policy.finish(1, MIB);
        policy
    };
    let reference = build().stats();
    let cases: [(&str, HostileCall); 7] = [
        ("release a key never requested", |p| p.release(9, View)),
        ("release by a requester that holds nothing", |p| p.release(1, Sim)),
        ("finish a key that is not loading", |p| p.finish(1, MIB)),
        ("finish an unknown key", |p| p.finish(9, MIB)),
        ("fail a resident key", |p| p.fail(1)),
        ("fail an unknown key", |p| p.fail(9)),
        ("finish a queued key", |p| {
            p.request(3, View, Want::new(1.0, MIB));
            let refused = p.finish(3, MIB);
            p.release(3, View);
            refused
        }),
    ];
    for (name, case) in cases {
        let mut policy = build();
        assert!(!case(&mut policy), "{name}: reported a change");
        assert_eq!(policy.stats(), reference, "{name}: changed the policy");
    }

    // Parent cycles and self-parents end the walk instead of looping.
    let mut policy = Residency::new(ResidencyLimits::new(0, 4));
    policy.request(1u32, View, Want::new(1.0, MIB).under(2));
    policy.request(2, View, Want::new(1.0, MIB).under(1));
    policy.request(3, View, Want::new(1.0, MIB).under(3));
    assert_eq!(policy.stand_in(1), None);
    assert_eq!(policy.stand_in(3), None);
    assert!(policy.drain(&mut FakeClock::still()).is_empty());

    // Byte counts saturate instead of wrapping.
    let mut policy = Residency::new(ResidencyLimits::new(u64::MAX, 4));
    policy.request(1u32, Sim, Want::new(f32::INFINITY, u64::MAX));
    policy.request(2, Sim, Want::new(-1.0, u64::MAX));
    assert_eq!(policy.start_loads(), vec![1, 2]);
    policy.finish(1, u64::MAX);
    policy.finish(2, u64::MAX);
    assert_eq!(policy.stats().resident_bytes, u64::MAX);
}

#[test]
fn screen_space_error_is_the_select_lod_metric() {
    // select_lod draws a level when error * pixels_per_unit <= threshold * distance.
    assert_eq!(screen_space_error_px(0.5, 10.0, 800.0), 40.0);
    assert_eq!(screen_space_error_px(0.5, 0.0, 800.0), f32::MAX, "at the eye: the most urgent");
    assert_eq!(screen_space_error_px(0.5, f32::NAN, 800.0), f32::MAX);
    assert_eq!(screen_space_error_px(f32::NAN, 10.0, 800.0), 0.0, "a NaN error is the least urgent");
}

#[test]
fn requesters_have_one_wire_spelling_each() {
    let wires: Vec<&str> = Requester::ALL.iter().map(|r| r.wire()).collect();
    assert_eq!(wires, ["sim", "view", "kept", "ticket"]);
}
