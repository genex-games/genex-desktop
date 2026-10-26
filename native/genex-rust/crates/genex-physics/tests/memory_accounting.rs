//! Memory per world (§11.1) with the counting allocator installed, as the WASM binding installs it:
//! allocations are charged to the world whose call runs, frees credit the world that allocated,
//! `LimitMemory` is judged before allocating, and `memoryExceeded` / `stats().memoryBytes` report
//! the measured bytes. This test binary is the only one that installs the allocator.

mod common;

use std::alloc::System;
use std::sync::{Mutex, MutexGuard, PoisonError};

use common::{ball, body, cube, world};
use genex_physics::accounting::{ACCOUNT_SLOTS, CountingAllocator, installed};
use genex_physics::{BodyType, PhysicsError, UpAxis, World, WorldDesc};

#[global_allocator]
static ALLOCATOR: CountingAllocator<System> = CountingAllocator::new(System);

/// One test at a time: the slot test holds every slot for a moment.
static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

fn serial() -> MutexGuard<'static, ()> {
    ONE_AT_A_TIME.lock().unwrap_or_else(PoisonError::into_inner)
}

fn heap(w: &mut World, prefix: &str, n: usize) {
    for i in 0..n {
        let p = [(i % 6) as f64 * 1.1, 0.5 + (i / 36) as f64, ((i / 6) % 6) as f64 * 1.1];
        w.spawn(&body(&format!("{prefix}{i:03}"), BodyType::Dynamic, p, cube(0.5))).expect("spawns");
    }
}

#[test]
fn a_world_is_measured_once_the_allocator_is_installed() {
    let _serial = serial();
    let w = world(UpAxis::Y);
    assert!(installed());
    assert!(w.memory_is_measured());
    assert!(w.memory_bytes() > 0);
    assert_eq!(w.stats().memory_bytes, w.memory_bytes());
}

#[test]
fn each_world_is_charged_only_for_its_own_allocations() {
    let _serial = serial();
    let mut a = world(UpAxis::Y);
    let b = world(UpAxis::Z);
    let b_before = b.memory_bytes();
    let a_before = a.memory_bytes();
    heap(&mut a, "a", 60);
    for _ in 0..20 {
        a.step().expect("steps");
    }
    assert!(a.memory_bytes() > a_before + 60 * 500, "the bodies and their contacts are charged to a");
    assert_eq!(b.memory_bytes(), b_before, "b is not charged for a's work");
}

#[test]
fn a_free_outside_the_world_credits_the_world_that_allocated() {
    let _serial = serial();
    let mut w = world(UpAxis::Y);
    w.spawn(&body("a", BodyType::Dynamic, [0.0, 1.0, 0.0], ball(0.5))).expect("spawns");
    let before = w.memory_bytes();
    let failure = w.spawn(&body("a", BodyType::Dynamic, [0.0, 3.0, 0.0], ball(0.5))).expect_err("a duplicate");
    assert_eq!(failure.code, PhysicsError::DuplicateKey);
    assert!(w.memory_bytes() > before, "the failure's detail was allocated during the world's call");
    drop(failure);
    assert_eq!(w.memory_bytes(), before, "freeing it outside any call credits the world back exactly");
}

#[test]
fn removing_bodies_gives_their_bytes_back() {
    let _serial = serial();
    let mut w = world(UpAxis::Y);
    heap(&mut w, "b", 40);
    let full = w.memory_bytes();
    for i in 0..40 {
        w.remove(&format!("b{i:03}")).expect("removes");
    }
    w.step().expect("steps");
    assert!(w.memory_bytes() < full - 40 * 500, "{} vs {full}", w.memory_bytes());
}

/// A world whose memory limit is its measured bytes now plus `headroom`.
fn tight_world(headroom: u64) -> World {
    let probe = world(UpAxis::Y);
    let mut desc = WorldDesc::new(1.0 / 60.0, 1.0, [0.0, -9.81, 0.0], UpAxis::Y, 1.0);
    desc.limits.memory_bytes = Some((probe.memory_bytes() + headroom) as f64);
    World::create(&desc).expect("world")
}

#[test]
fn limit_memory_is_judged_before_allocating_and_changes_nothing() {
    let _serial = serial();
    let mut w = tight_world(4096);
    w.spawn(&body("first", BodyType::Dynamic, [0.0, 1.0, 0.0], ball(0.5))).expect("one body fits");
    let before = (w.memory_bytes(), w.state_hash(), w.bodies(&Default::default()).len());
    let points: Vec<[f64; 3]> = (0..60).map(|i| [(i % 4) as f64, ((i / 4) % 4) as f64, (i / 16) as f64 + (i % 3) as f64 * 0.1]).collect();
    let big = body("big", BodyType::Dynamic, [5.0, 1.0, 0.0], genex_physics::Shape::Hull { points });
    let refused = w.spawn(&big).map_err(|f| f.code);
    assert_eq!(refused, Err(PhysicsError::LimitMemory));
    assert_eq!((w.memory_bytes(), w.state_hash(), w.bodies(&Default::default()).len()), before);
}

#[test]
fn memory_exceeded_and_stats_report_the_measured_bytes_after_a_step() {
    let _serial = serial();
    let mut w = tight_world(64 * 1024);
    heap(&mut w, "c", 30);
    let limit = u64::from(w.desc().limits.memory_bytes);
    let mut exceeded = false;
    for _ in 0..30 {
        exceeded |= w.step().expect("steps").memory_exceeded;
    }
    assert!(exceeded, "the contacts took the world past its limit");
    assert!(w.memory_bytes() > limit);
    assert_eq!(w.stats().memory_bytes, w.memory_bytes());
}

#[test]
fn a_restore_measures_the_restored_world() {
    let _serial = serial();
    let mut small = world(UpAxis::Y);
    small.spawn(&body("only", BodyType::Dynamic, [0.0, 1.0, 0.0], ball(0.5))).expect("spawns");
    let bytes = small.snapshot().expect("snapshots");
    let mut big = world(UpAxis::Y);
    heap(&mut big, "d", 80);
    let full = big.memory_bytes();
    big.restore(&bytes).expect("restores");
    assert!(big.memory_bytes() < full, "the old world's memory was freed and credited");
    assert!(big.memory_is_measured());
}

#[test]
fn slots_are_given_back_and_worlds_past_them_report_the_model() {
    let _serial = serial();
    for _ in 0..ACCOUNT_SLOTS + 8 {
        let w = world(UpAxis::Y);
        assert!(w.memory_is_measured(), "a dropped world gives its slot back");
    }
    let mut held: Vec<World> = Vec::new();
    while held.len() < ACCOUNT_SLOTS + 1 {
        held.push(world(UpAxis::Y));
    }
    let unmeasured = held.iter().filter(|w| !w.memory_is_measured()).count();
    assert!(unmeasured >= 1, "past the slots a world falls back to the model");
    let model = held.iter().find(|w| !w.memory_is_measured()).map(World::memory_bytes);
    assert_eq!(model, Some(genex_physics::memory::WORLD_BASE_BYTES));
}

#[test]
fn an_atomic_batch_adds_each_command_s_estimate_to_the_measured_bytes() {
    let _serial = serial();
    let spawn = |key: &str| genex_physics::Command::Spawn(body(key, BodyType::Dynamic, [0.0, 1.0, 0.0], ball(0.5)));
    // Room for one body by the model's estimate (about 1.5 KiB each), not for two.
    let mut w = tight_world(2500);
    let before = (w.memory_bytes(), w.state_hash());
    let refused = w.apply_atomic(&[spawn("a"), spawn("b")]).map_err(|f| (f.code, f.index));
    assert_eq!(refused, Err((PhysicsError::LimitMemory, Some(1))));
    assert_eq!((w.memory_bytes(), w.state_hash()), before);
    w.apply_atomic(&[spawn("a")]).expect("one fits");
}
