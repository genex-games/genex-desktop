//! UIS-3: the slot index lists sidecars without reading a body, the autosave ring writes by tick,
//! the quota planner counts everything the game keeps, and `SlotDriver` runs saves and loads at
//! the tick boundary over a fake store with an injected clock: a save queued in tick T shows in
//! T+1, a load is restored before T+1, and a lazy body holds the tick until it arrives.

use std::collections::{BTreeMap, BTreeSet};

use genex_core::saves::MAX_TOTAL_SAVE_BYTES;
use genex_save::autosave::AutosaveRing;
use genex_save::driver::{BodyRead, SAVE_LOAD_HOLD_MAX_MS, SlotDriver, SlotOp, SlotStore, Snapshot, Step};
use genex_save::envelope::decode;
use genex_save::error::{SAVE_RESTORE_DIVERGED, SaveError, SaveErrorCode};
use genex_save::index::{SlotIndex, SlotMeta, SlotState};
use genex_save::migrate::Migrations;
use genex_save::quota::Quota;
use genex_save::slot::SlotName;
use serde_json::{Map, Value, json};

/// The schema-1 golden UIS-2 committed.
const GOLDEN_SCHEMA1: &[u8] = include_bytes!("goldens/schema1.sav");

/// An in-memory store: files by save name, some bodies lazy until provided.
#[derive(Default)]
struct FakeStore {
    files: BTreeMap<String, Vec<u8>>,
    lazy: BTreeSet<String>,
    reads: Vec<String>,
    other_bytes: u64,
}

impl FakeStore {
    fn provide(&mut self, file: &str) {
        self.lazy.remove(file);
    }
}

impl SlotStore for FakeStore {
    fn list(&self, folder: &str) -> Vec<String> {
        let prefix = format!("{folder}/");
        self.files
            .keys()
            .filter(|name| name.strip_prefix(&prefix).is_some_and(|leaf| !leaf.contains('/')))
            .cloned()
            .collect()
    }

    fn read_meta(&self, file: &str) -> Option<Vec<u8>> {
        self.files.get(file).cloned()
    }

    fn read(&mut self, file: &str) -> BodyRead {
        self.reads.push(file.to_owned());
        if self.lazy.contains(file) {
            return BodyRead::Pending;
        }
        self.files.get(file).cloned().map_or(BodyRead::Missing, BodyRead::Ready)
    }

    fn write(&mut self, file: &str, bytes: &[u8]) -> Result<(), SaveError> {
        self.files.insert(file.to_owned(), bytes.to_vec());
        Ok(())
    }

    fn remove(&mut self, file: &str) -> bool {
        self.files.remove(file).is_some()
    }

    fn bytes_used(&self) -> u64 {
        self.other_bytes + self.files.values().map(|bytes| bytes.len() as u64).sum::<u64>()
    }
}

/// The running game the driver saves: a world of one counter at a tick.
struct Sim {
    tick: u64,
    hp: u64,
}

impl Sim {
    fn snapshot(&self) -> Result<Snapshot, SaveError> {
        let mut sections = Map::new();
        sections.insert("world".to_owned(), json!({"hp": self.hp}));
        Ok(Snapshot {
            tick: self.tick,
            seed: 7,
            rng: [self.tick, 3],
            state_checksum: self.hp * 31 + self.tick,
            play_ms: self.tick * 1000 / 60,
            saved_at_ms: None,
            locale: "en".to_owned(),
            build: "build".to_owned(),
            sections,
        })
    }
}

fn migrations() -> Migrations {
    Migrations::new(3).step(1, Ok).step(2, Ok)
}

fn driver() -> SlotDriver {
    SlotDriver::new("golden-game", migrations())
}

/// Run hooks for one tick (`hooks`), then the end-of-tick boundary, then the next tick's start.
fn tick(
    driver: &mut SlotDriver,
    store: &mut FakeStore,
    sim: &mut Sim,
    now_ms: u64,
    hooks: impl FnOnce(&SlotDriver),
) -> Step {
    hooks(driver);
    sim.tick += 1;
    driver.end_tick(store, sim.tick, &mut || sim.snapshot());
    driver.begin_tick(store, now_ms)
}

fn names(driver: &SlotDriver) -> Vec<String> {
    driver.list().iter().map(|info| info.name.as_str().to_owned()).collect()
}

#[test]
fn a_save_queued_in_tick_t_is_written_after_it_and_visible_in_t_plus_1() {
    let (mut store, mut sim, mut driver) = (FakeStore::default(), Sim { tick: 10, hp: 5 }, driver());
    driver.refresh(&store);
    let step = tick(&mut driver, &mut store, &mut sim, 0, |slots| {
        assert_eq!(slots.request_save("chapter-1", "Chapter 1"), Ok(()));
        assert!(slots.list().is_empty(), "nothing is written inside the tick");
        assert!(slots.events().is_empty());
    });
    assert!(matches!(step, Step::Run));
    assert_eq!(names(&driver), ["chapter-1"]);
    let events = driver.events();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].op, SlotOp::Save);
    let info = events[0].result.as_ref().expect("saved");
    assert_eq!((info.tick, info.label.as_str(), info.schema, info.state), (11, "Chapter 1", 3, SlotState::Ready));
    assert_eq!(info.saved_at_ms, None, "no wall clock in a Genex run");
    let body = store.files.get("slots/chapter-1.sav").expect("the body is written");
    assert_eq!(info.bytes, body.len() as u64);
    let slot = decode(body).expect("the body is an envelope");
    assert_eq!((slot.tick, slot.sections["world"].clone()), (11, json!({"hp": 5})));
    assert!(store.files.contains_key("slots/chapter-1.meta.json"));
    let step = tick(&mut driver, &mut store, &mut sim, 0, |_| {});
    assert!(matches!(step, Step::Run));
    assert!(driver.events().is_empty(), "events last one tick");
    assert_eq!(driver.last_save().map(|s| (s.slot.as_str().to_owned(), s.tick)), Some(("chapter-1".to_owned(), 11)));
}

#[test]
fn a_load_queued_in_tick_t_is_restored_before_t_plus_1() {
    let (mut store, mut sim, mut driver) = (FakeStore::default(), Sim { tick: 10, hp: 5 }, driver());
    driver.refresh(&store);
    tick(&mut driver, &mut store, &mut sim, 0, |slots| slots.request_save("a", "A").expect("queued"));
    sim.hp = 99;
    for _ in 0..5 {
        tick(&mut driver, &mut store, &mut sim, 0, |_| {});
    }
    let step = tick(&mut driver, &mut store, &mut sim, 0, |slots| {
        assert_eq!(slots.request_load("a"), Ok(()));
        assert!(slots.busy());
        assert_eq!(slots.request_load("a").map_err(|e| e.code), Err(SaveErrorCode::Busy));
    });
    let Step::Restore(restore) = step else { panic!("the load restores before the next tick") };
    assert_eq!(restore.slot.as_str(), "a");
    assert_eq!((restore.envelope.tick, restore.envelope.sections["world"].clone()), (11, json!({"hp": 5})));
    assert!(driver.busy(), "busy until the runtime says the restore applied");
    driver.restored(Ok(restore.envelope.state_checksum));
    assert!(!driver.busy());
    let load = driver.events().iter().find(|event| event.op == SlotOp::Load).expect("a load event in T+1");
    assert_eq!(load.result.as_ref().map(|info| info.tick), Ok(11));
    let last = driver.last_load().expect("a last load");
    assert!(last.checksum_match);
    assert!(driver.issues().is_empty());
}

#[test]
fn a_restore_whose_checksum_differs_reports_save_restore_diverged() {
    let (mut store, mut sim, mut driver) = (FakeStore::default(), Sim { tick: 0, hp: 1 }, driver());
    driver.refresh(&store);
    tick(&mut driver, &mut store, &mut sim, 0, |slots| slots.request_save("a", "A").expect("queued"));
    let Step::Restore(restore) =
        tick(&mut driver, &mut store, &mut sim, 0, |slots| slots.request_load("a").expect("queued"))
    else {
        panic!("restores")
    };
    driver.restored(Ok(restore.envelope.state_checksum ^ 1));
    assert_eq!(driver.last_load().map(|last| last.checksum_match), Some(false));
    assert_eq!(driver.issues(), [SAVE_RESTORE_DIVERGED]);
}

#[test]
fn a_pending_lazy_body_reports_busy_and_holds_the_tick_until_it_arrives() {
    let (mut store, mut sim, mut driver) = (FakeStore::default(), Sim { tick: 0, hp: 4 }, driver());
    driver.refresh(&store);
    tick(&mut driver, &mut store, &mut sim, 0, |slots| slots.request_save("lazy", "Lazy").expect("queued"));
    store.lazy.insert("slots/lazy.sav".to_owned());
    let step = tick(&mut driver, &mut store, &mut sim, 1_000, |slots| slots.request_load("lazy").expect("queued"));
    assert!(matches!(step, Step::Hold), "a body that is not resident holds the tick");
    assert!(driver.busy());
    assert!(matches!(driver.begin_tick(&mut store, 1_000 + SAVE_LOAD_HOLD_MAX_MS - 1), Step::Hold));
    store.provide("slots/lazy.sav");
    let Step::Restore(restore) = driver.begin_tick(&mut store, 1_000 + SAVE_LOAD_HOLD_MAX_MS - 1) else {
        panic!("restores once the body is resident")
    };
    assert_eq!(restore.envelope.sections["world"], json!({"hp": 4}));
}

#[test]
fn a_lazy_body_that_never_arrives_is_save_load_timeout_on_the_injected_clock() {
    let (mut store, mut sim, mut driver) = (FakeStore::default(), Sim { tick: 0, hp: 4 }, driver());
    driver.refresh(&store);
    tick(&mut driver, &mut store, &mut sim, 0, |slots| slots.request_save("lazy", "Lazy").expect("queued"));
    store.lazy.insert("slots/lazy.sav".to_owned());
    assert!(matches!(
        tick(&mut driver, &mut store, &mut sim, 500, |slots| slots.request_load("lazy").expect("queued")),
        Step::Hold
    ));
    assert!(matches!(driver.begin_tick(&mut store, 500 + SAVE_LOAD_HOLD_MAX_MS), Step::Run));
    assert!(!driver.busy());
    let load = driver.events().iter().find(|event| event.op == SlotOp::Load).expect("a load event");
    assert_eq!(load.result.as_ref().map_err(|e| e.code), Err(SaveErrorCode::LoadTimeout));
}

#[test]
fn the_ring_writes_autosave_0_to_2_round_robin_by_tick_and_the_suspend_save_takes_the_oldest() {
    let ring = AutosaveRing::new(100, 3).expect("a ring");
    let due: Vec<Option<String>> =
        [0, 99, 100, 150, 200, 300, 400, 700].iter().map(|&t| ring.due(t).map(|s| s.as_str().to_owned())).collect();
    let expect = |name: &str| Some(name.to_owned());
    assert_eq!(
        due,
        [
            None,
            None,
            expect("autosave-0"),
            None,
            expect("autosave-1"),
            expect("autosave-2"),
            expect("autosave-0"),
            expect("autosave-0")
        ]
    );
    let (mut store, mut sim) = (FakeStore::default(), Sim { tick: 0, hp: 1 });
    let mut driver = driver().with_autosave(ring);
    driver.refresh(&store);
    assert_eq!(
        driver.suspend_slot().map(|s| s.as_str().to_owned()),
        Some("autosave-0".to_owned()),
        "an empty ring's oldest is slot 0"
    );
    let mut autosaves = Vec::new();
    while sim.tick < 400 {
        tick(&mut driver, &mut store, &mut sim, 0, |_| {});
        autosaves.extend(
            driver.events().iter().filter(|e| e.op == SlotOp::Autosave).map(|e| (e.slot.as_str().to_owned(), sim.tick)),
        );
    }
    let expected: Vec<(String, u64)> =
        [("autosave-0", 100), ("autosave-1", 200), ("autosave-2", 300), ("autosave-0", 400)]
            .map(|(s, t)| (s.to_owned(), t))
            .to_vec();
    assert_eq!(autosaves, expected);
    let ticks: Vec<(String, u64)> =
        driver.list().iter().map(|info| (info.name.as_str().to_owned(), info.tick)).collect();
    assert_eq!(ticks, [("autosave-0", 400), ("autosave-1", 200), ("autosave-2", 300)].map(|(s, t)| (s.to_owned(), t)));
    assert!(driver.list().iter().all(|info| info.autosave));
    assert_eq!(driver.suspend_slot().map(|s| s.as_str().to_owned()), Some("autosave-1".to_owned()));
    sim.tick = 401;
    let written = driver.suspend_save(&mut store, &mut || sim.snapshot()).expect("a ring").expect("written");
    assert_eq!((written.name.as_str(), written.tick), ("autosave-1", 401));
    assert_eq!(driver.suspend_slot().map(|s| s.as_str().to_owned()), Some("autosave-2".to_owned()));
    assert_eq!(
        driver.request_save("autosave-1", "mine").map_err(|e| e.code),
        Err(SaveErrorCode::SlotInvalid),
        "a game never writes the ring"
    );
    let step = tick(&mut driver, &mut store, &mut sim, 0, |slots| {
        slots.request_load("autosave-1").expect("a game loads an autosave")
    });
    assert!(matches!(step, Step::Restore(_)));
}

#[test]
fn a_meta_whose_digest_does_not_match_its_body_lists_the_slot_corrupt() {
    let (mut store, mut sim, mut driver) = (FakeStore::default(), Sim { tick: 0, hp: 1 }, driver());
    driver.refresh(&store);
    tick(&mut driver, &mut store, &mut sim, 0, |slots| {
        slots.request_save("good", "Good").expect("queued");
        slots.request_save("bad", "Bad").expect("queued");
    });
    let other = store.files.get("slots/good.sav").cloned().expect("written");
    sim.hp = 2;
    tick(&mut driver, &mut store, &mut sim, 0, |slots| slots.request_save("good", "Good").expect("queued"));
    store.files.insert("slots/bad.sav".to_owned(), other);
    store.files.insert("slots/unreadable.meta.json".to_owned(), b"{not json".to_vec());
    store.files.insert("slots/unreadable.sav".to_owned(), b"{}".to_vec());
    store.files.insert("slots/orphan.sav".to_owned(), b"{}".to_vec());
    store.reads.clear();
    let mut fresh = driver_after_restart(&store);
    assert!(store.reads.is_empty(), "listing reads sidecars through the index only, never a body");
    let state =
        |driver: &SlotDriver, name: &str| driver.list().iter().find(|i| i.name.as_str() == name).map(|i| i.state);
    assert_eq!(state(&fresh, "unreadable"), Some(SlotState::Corrupt));
    assert_eq!(state(&fresh, "orphan"), Some(SlotState::Corrupt), "a body without a sidecar");
    assert_eq!(state(&fresh, "bad"), Some(SlotState::Ready), "the sidecar alone looks fine");
    let step = tick(&mut fresh, &mut store, &mut sim, 0, |slots| slots.request_load("bad").expect("queued"));
    assert!(matches!(step, Step::Run), "a mismatched body is never restored");
    let load = fresh.events().iter().find(|event| event.op == SlotOp::Load).expect("a load event");
    assert_eq!(load.result.as_ref().map_err(|e| e.code), Err(SaveErrorCode::Corrupt));
    assert_eq!(state(&fresh, "bad"), Some(SlotState::Corrupt));
    assert_eq!(fresh.request_load("bad").map_err(|e| e.code), Err(SaveErrorCode::Corrupt));
    assert_eq!(state(&fresh, "good"), Some(SlotState::Ready));
}

fn driver_after_restart(store: &FakeStore) -> SlotDriver {
    let mut driver = driver();
    driver.refresh(store);
    driver
}

#[test]
fn a_17th_slot_with_slots_max_16_is_save_slots_full_and_overwrites_still_save() {
    let (mut store, mut sim) = (FakeStore::default(), Sim { tick: 0, hp: 1 });
    let mut driver = driver().with_slots_max(16).expect("16 is in range");
    driver.refresh(&store);
    tick(&mut driver, &mut store, &mut sim, 0, |slots| {
        for i in 0..16 {
            slots.request_save(&format!("slot-{i}"), "").expect("within slots_max");
        }
        assert_eq!(
            slots.request_save("slot-16", "").map_err(|e| e.code),
            Err(SaveErrorCode::SlotsFull),
            "queued saves count"
        );
    });
    assert_eq!(driver.list().len(), 16);
    for slot in ["slot-0", "slot-15"] {
        let body = store.files.get(&format!("slots/{slot}.sav")).expect("written");
        let sections = decode(body).expect("decodes").sections;
        assert_eq!(sections["world"], json!({"hp": 1}), "every save of one tick holds the sections ({slot})");
    }
    tick(&mut driver, &mut store, &mut sim, 0, |slots| {
        assert_eq!(slots.request_save("slot-16", "").map_err(|e| e.code), Err(SaveErrorCode::SlotsFull));
        assert_eq!(slots.request_save("slot-3", "again"), Ok(()), "an existing slot is overwritten");
    });
    assert!(SlotDriver::new("g", migrations()).with_slots_max(0).is_err());
    assert!(SlotDriver::new("g", migrations()).with_slots_max(33).is_err(), "past SLOTS_MAX");
    tick(&mut driver, &mut store, &mut sim, 0, |slots| slots.request_delete("slot-0").expect("queued"));
    assert_eq!(driver.list().len(), 15);
    assert!(!store.files.contains_key("slots/slot-0.sav") && !store.files.contains_key("slots/slot-0.meta.json"));
    tick(&mut driver, &mut store, &mut sim, 0, |slots| slots.request_save("slot-16", "").expect("room again"));
    assert_eq!(driver.list().len(), 16);
}

#[test]
fn a_schema_4_slot_lists_newer_and_its_load_refuses_save_newer() {
    let (mut store, mut sim, mut driver) = (FakeStore::default(), Sim { tick: 0, hp: 1 }, driver());
    let mut slot = decode(GOLDEN_SCHEMA1).expect("golden");
    slot.schema = 4;
    let body = genex_save::envelope::encode(&slot).expect("encodes");
    let name = SlotName::new("future").expect("a name");
    store.files.insert(name.body_file(), body.clone());
    store.files.insert(name.meta_file(), SlotMeta::for_body(&name, &slot, &body).to_bytes());
    store.files.insert("slots/old.sav".to_owned(), GOLDEN_SCHEMA1.to_vec());
    let old = SlotName::new("old").expect("a name");
    let old_slot = decode(GOLDEN_SCHEMA1).expect("golden");
    store.files.insert(old.meta_file(), SlotMeta::for_body(&old, &old_slot, GOLDEN_SCHEMA1).to_bytes());
    driver.refresh(&store);
    let states: Vec<(String, SlotState)> =
        driver.list().iter().map(|i| (i.name.as_str().to_owned(), i.state)).collect();
    assert_eq!(states, [("future".to_owned(), SlotState::Newer), ("old".to_owned(), SlotState::NeedsMigration)]);
    assert_eq!(driver.request_load("future").map_err(|e| e.code), Err(SaveErrorCode::Newer));
    assert_eq!(driver.request_load("nowhere").map_err(|e| e.code), Err(SaveErrorCode::SlotMissing));
    assert_eq!(driver.request_delete("nowhere").map_err(|e| e.code), Err(SaveErrorCode::SlotMissing));
    let Step::Restore(restore) =
        tick(&mut driver, &mut store, &mut sim, 0, |slots| slots.request_load("old").expect("queued"))
    else {
        panic!("the schema-1 slot migrates and restores")
    };
    assert_eq!(restore.envelope.schema, 3);
}

#[test]
fn the_quota_planner_counts_everything_the_game_keeps_and_a_replaced_slot_counts_the_difference() {
    let quota = Quota::default();
    assert_eq!(quota.total, MAX_TOTAL_SAVE_BYTES);
    assert_eq!(quota.check(MAX_TOTAL_SAVE_BYTES - 10, 0, 10), Ok(MAX_TOTAL_SAVE_BYTES));
    assert_eq!(quota.check(MAX_TOTAL_SAVE_BYTES - 10, 0, 11).map_err(|e| e.code), Err(SaveErrorCode::Quota));
    assert_eq!(
        quota.check(MAX_TOTAL_SAVE_BYTES, 100, 100),
        Ok(MAX_TOTAL_SAVE_BYTES),
        "a same-size overwrite at the cap fits"
    );
    assert_eq!(quota.headroom(MAX_TOTAL_SAVE_BYTES - 5), 5);
    assert_eq!(quota.headroom(MAX_TOTAL_SAVE_BYTES + 5), 0);
    let (mut store, mut sim) = (FakeStore::default(), Sim { tick: 0, hp: 1 });
    store.other_bytes = MAX_TOTAL_SAVE_BYTES - 100;
    let mut driver = driver();
    driver.refresh(&store);
    tick(&mut driver, &mut store, &mut sim, 0, |slots| slots.request_save("a", "A").expect("queued"));
    let save = driver.events().first().expect("an event");
    assert_eq!(
        save.result.as_ref().map_err(|e| e.code),
        Err(SaveErrorCode::Quota),
        "a pipeline cache and other files count"
    );
    assert!(store.files.is_empty(), "neither body nor sidecar is written");
}

#[test]
fn the_index_round_trips_its_sidecar_and_refuses_a_large_one() {
    let slot = decode(GOLDEN_SCHEMA1).expect("golden");
    let name = SlotName::new("chapter-1").expect("a name");
    let meta = SlotMeta::for_body(&name, &slot, GOLDEN_SCHEMA1);
    let bytes = meta.to_bytes();
    assert_eq!(SlotMeta::parse(&bytes), Ok(meta.clone()));
    assert!(meta.matches(GOLDEN_SCHEMA1));
    assert!(!meta.matches(&GOLDEN_SCHEMA1[1..]));
    let mut big: Value = serde_json::from_slice(&bytes).expect("JSON");
    big["label"] = json!("x".repeat(5000));
    assert_eq!(
        SlotMeta::parse(&serde_json::to_vec(&big).expect("json")).map_err(|e| e.code),
        Err(SaveErrorCode::Corrupt)
    );
    let mut index = SlotIndex::default();
    index.put(meta, bytes.len() as u64, 3);
    assert_eq!(index.get("chapter-1").map(|i| i.state), Some(SlotState::NeedsMigration));
    assert!(!index.verify(&name, b"other"));
    assert_eq!(index.get("chapter-1").map(|i| i.state), Some(SlotState::Corrupt));
}
