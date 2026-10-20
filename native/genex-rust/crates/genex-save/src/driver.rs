//! `SlotDriver`: the runtime's slot machine, pure over a [`SlotStore`] and an injected clock.
//!
//! - Inside tick T a game queues saves, loads and deletes ([`SlotDriver::request_save`] and the
//!   others take `&self`, as hooks hold a shared context); the list it reads is the one at the
//!   tick's start.
//! - At the end of tick T ([`SlotDriver::end_tick`]) queued deletes and saves run in order, then
//!   the ring's autosave when one is due. A save reads the sections once (read hooks: the
//!   checksum never moves), encodes, checks the quota, writes the body, then the sidecar.
//! - At the start of tick T+1 ([`SlotDriver::begin_tick`]) the events finished since become
//!   visible, and a queued load is decoded and migrated into a [`Step::Restore`] the runtime
//!   applies beside the running sim before T+1's hooks. A body that is not resident yet (the web's
//!   lazy `.sav`) holds the tick ([`Step::Hold`], zero ticks run) until it arrives or
//!   [`SAVE_LOAD_HOLD_MAX_MS`] pass on the injected clock, so replay never depends on storage
//!   latency.

use std::cell::RefCell;

use serde_json::{Map, Value};

use crate::autosave::AutosaveRing;
use crate::envelope::{Envelope, LABEL_CHARS_MAX, SaveMeta, decode, encode};
use crate::error::{SAVE_RESTORE_DIVERGED, SaveError, SaveErrorCode};
use crate::index::{SlotIndex, SlotInfo, SlotMeta, SlotState};
use crate::migrate::Migrations;
use crate::quota::Quota;
use crate::slot::SlotName;

/// How long a load holds the tick for a lazy body before it refuses `save-load-timeout`, in
/// milliseconds of the injected clock (a failure path only).
pub const SAVE_LOAD_HOLD_MAX_MS: u64 = 6_000;
/// The most named slots a game may allow (`slots_max`); autosaves are not counted.
pub const SLOTS_MAX: usize = 32;
/// The named slots a game allows when it does not say.
pub const SLOTS_DEFAULT: usize = 16;
/// The most issues kept for `volatile.saves.issues`.
pub const ISSUES_MAX: usize = 16;

/// A body read from the store.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BodyRead {
    /// The stored bytes.
    Ready(Vec<u8>),
    /// Known but not resident yet (the web mirror's lazy body); the store has asked for it.
    Pending,
    /// Not stored.
    Missing,
}

/// Where slots are kept: genex-core `Saves` (files, or the web mirror) behind the facade, or a
/// fake in tests.
pub trait SlotStore {
    /// The files directly in `folder`, as save names (`slots/a.sav`).
    fn list(&self, folder: &str) -> Vec<String>;
    /// A sidecar's bytes (small files are always resident), or None.
    fn read_meta(&self, file: &str) -> Option<Vec<u8>>;
    /// A body's bytes, or that it is pending or missing.
    fn read(&mut self, file: &str) -> BodyRead;
    /// Write `bytes` as `file`, replacing it.
    fn write(&mut self, file: &str, bytes: &[u8]) -> Result<(), SaveError>;
    /// Remove `file`; false when nothing was removed.
    fn remove(&mut self, file: &str) -> bool;
    /// Everything the game keeps under its save root, in bytes.
    fn bytes_used(&self) -> u64;
}

/// What a save reads from the running game at the tick boundary.
#[derive(Clone, Debug, PartialEq)]
pub struct Snapshot {
    /// The simulated tick.
    pub tick: u64,
    /// The run's seed.
    pub seed: u64,
    /// The sim rng's position.
    pub rng: [u64; 2],
    /// The state checksum at `tick`.
    pub state_checksum: u64,
    /// Simulated play time in milliseconds.
    pub play_ms: u64,
    /// Wall clock, display only; None in Genex runs.
    pub saved_at_ms: Option<u64>,
    /// The locale the game runs in.
    pub locale: String,
    /// The build's digest.
    pub build: String,
    /// The sections in registration order.
    pub sections: Map<String, Value>,
}

/// What a slot event did.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum SlotOp {
    /// A game's save.
    Save,
    /// A game's load.
    Load,
    /// A game's delete.
    Delete,
    /// The ring's save (by tick, or on suspend).
    Autosave,
}

impl SlotOp {
    /// Every op, in declaration order.
    pub const ALL: [SlotOp; 4] = [SlotOp::Save, SlotOp::Load, SlotOp::Delete, SlotOp::Autosave];

    /// The op's wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            SlotOp::Save => "save",
            SlotOp::Load => "load",
            SlotOp::Delete => "delete",
            SlotOp::Autosave => "autosave",
        }
    }
}

/// A finished slot operation, visible for one tick.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SlotEvent {
    /// What it did.
    pub op: SlotOp,
    /// The slot.
    pub slot: SlotName,
    /// The slot as listed after it, or why it refused.
    pub result: Result<SlotInfo, SaveError>,
}

/// A load ready to apply: the slot's envelope, migrated to the game's schema.
#[derive(Clone, Debug, PartialEq)]
pub struct Restore {
    /// The slot.
    pub slot: SlotName,
    /// Its envelope at the game's schema.
    pub envelope: Envelope,
}

/// What the runtime does before the next tick.
#[derive(Clone, Debug, PartialEq)]
pub enum Step {
    /// Run the tick.
    Run,
    /// Run no tick this frame: a load waits for its body.
    Hold,
    /// Apply this restore, report it with [`SlotDriver::restored`], then run the tick.
    Restore(Box<Restore>),
}

/// The last save written (`volatile.saves.lastSave`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LastSave {
    /// The slot.
    pub slot: SlotName,
    /// The tick it holds.
    pub tick: u64,
    /// Its body's stored bytes.
    pub bytes: u64,
}

/// The last load applied (`volatile.saves.lastLoad`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LastLoad {
    /// The slot.
    pub slot: SlotName,
    /// The tick it restored.
    pub tick: u64,
    /// Whether the recomputed state checksum equals the saved one.
    pub checksum_match: bool,
}

/// A queued request.
#[derive(Clone, Debug)]
enum Request {
    Save { slot: SlotName, label: String },
    Load(SlotName),
    Delete(SlotName),
}

/// A load waiting for its body (`since_ms`: when the hold began on the injected clock).
#[derive(Clone, Debug)]
struct PendingLoad {
    slot: SlotName,
    since_ms: Option<u64>,
}

/// A restore handed to the runtime and not yet reported.
#[derive(Clone, Debug)]
struct Restoring {
    slot: SlotName,
    tick: u64,
    state_checksum: u64,
}

/// One game's slots at the tick boundary.
#[derive(Debug)]
pub struct SlotDriver {
    game: String,
    migrations: Migrations,
    autosave: Option<AutosaveRing>,
    autosave_on_suspend: bool,
    slots_max: usize,
    quota: Quota,
    index: SlotIndex,
    requests: RefCell<Vec<Request>>,
    events: Vec<SlotEvent>,
    next_events: Vec<SlotEvent>,
    pending: Option<PendingLoad>,
    restoring: Option<Restoring>,
    last_save: Option<LastSave>,
    last_load: Option<LastLoad>,
    issues: Vec<&'static str>,
}

impl SlotDriver {
    /// The slots of the game saved as `game`, at the schema and with the steps of `migrations`,
    /// with no autosave, [`SLOTS_DEFAULT`] named slots and the default quota.
    pub fn new(game: &str, migrations: Migrations) -> SlotDriver {
        SlotDriver {
            game: game.to_owned(),
            migrations,
            autosave: None,
            autosave_on_suspend: true,
            slots_max: SLOTS_DEFAULT,
            quota: Quota::default(),
            index: SlotIndex::default(),
            requests: RefCell::new(Vec::new()),
            events: Vec::new(),
            next_events: Vec::new(),
            pending: None,
            restoring: None,
            last_save: None,
            last_load: None,
            issues: Vec::new(),
        }
    }

    /// Autosave into `ring`.
    pub fn with_autosave(mut self, ring: AutosaveRing) -> SlotDriver {
        self.autosave = Some(ring);
        self
    }

    /// Whether a suspend or close writes the ring's oldest slot (default true).
    pub fn with_autosave_on_suspend(mut self, on: bool) -> SlotDriver {
        self.autosave_on_suspend = on;
        self
    }

    /// Allow `slots` named slots (1 to [`SLOTS_MAX`]); the reason when outside that range.
    pub fn with_slots_max(mut self, slots: usize) -> Result<SlotDriver, String> {
        if !(1..=SLOTS_MAX).contains(&slots) {
            return Err(format!("slots_max is 1 to {SLOTS_MAX}, not {slots}"));
        }
        self.slots_max = slots;
        Ok(self)
    }

    /// Hold the game's saves to `quota`.
    pub fn with_quota(mut self, quota: Quota) -> SlotDriver {
        self.quota = quota;
        self
    }

    /// Rebuild the index from the store's sidecars (at boot, and once the web index is loaded).
    pub fn refresh(&mut self, store: &impl SlotStore) {
        let files: Vec<String> = SlotIndex::FOLDERS.iter().flat_map(|folder| store.list(folder)).collect();
        self.index = SlotIndex::build(&files, |file| store.read_meta(file), self.migrations.schema());
    }

    /// Every slot as of this tick's start, sorted by name.
    pub fn list(&self) -> &[SlotInfo] {
        self.index.list()
    }

    /// The slot named `slot`.
    pub fn get(&self, slot: &str) -> Option<&SlotInfo> {
        self.index.get(slot)
    }

    /// The index behind [`SlotDriver::list`].
    pub fn index(&self) -> &SlotIndex {
        &self.index
    }

    /// The events finished since the last tick.
    pub fn events(&self) -> &[SlotEvent] {
        &self.events
    }

    /// Whether a load is queued, waiting for its body, or being applied.
    pub fn busy(&self) -> bool {
        let queued = self.requests.borrow().iter().any(|request| matches!(request, Request::Load(_)));
        queued || self.pending.is_some() || self.restoring.is_some()
    }

    /// The last save written.
    pub fn last_save(&self) -> Option<&LastSave> {
        self.last_save.as_ref()
    }

    /// The last load applied.
    pub fn last_load(&self) -> Option<&LastLoad> {
        self.last_load.as_ref()
    }

    /// Volatile issues, oldest first (at most [`ISSUES_MAX`]).
    pub fn issues(&self) -> &[&'static str] {
        &self.issues
    }

    /// Queue a save of `slot` labelled `label`, written after this tick. Refuses
    /// `save-slot-invalid` (a bad or autosave name, a label past `LABEL_CHARS_MAX`), `save-busy`,
    /// and `save-slots-full` for a new slot past `slots_max` (queued saves count).
    pub fn request_save(&self, slot: &str, label: &str) -> Result<(), SaveError> {
        let slot = SlotName::new(slot)?;
        if label.chars().count() > LABEL_CHARS_MAX {
            return Err(SaveError::slot_invalid(format!("a slot label holds at most {LABEL_CHARS_MAX} characters")));
        }
        self.refuse_when_busy()?;
        let mut requests = self.requests.borrow_mut();
        let queued_new: Vec<&SlotName> = requests
            .iter()
            .filter_map(|request| match request {
                Request::Save { slot, .. } if self.index.get(slot.as_str()).is_none() => Some(slot),
                _ => None,
            })
            .collect();
        let is_new = self.index.get(slot.as_str()).is_none() && !queued_new.contains(&&slot);
        if is_new && self.index.named_count() + queued_new.len() >= self.slots_max {
            return Err(SaveError::new(
                SaveErrorCode::SlotsFull,
                format!("the game keeps at most {} slots", self.slots_max),
            ));
        }
        requests.push(Request::Save { slot, label: label.to_owned() });
        Ok(())
    }

    /// Queue a load of `slot` (a named or autosave slot), restored before the next tick. Refuses
    /// `save-slot-invalid`, `save-busy`, `save-slot-missing`, `save-newer` and `save-corrupt`.
    pub fn request_load(&self, slot: &str) -> Result<(), SaveError> {
        let slot = SlotName::lookup(slot)?;
        self.refuse_when_busy()?;
        let info = self.listed(&slot)?;
        match info.state {
            SlotState::Newer => {
                Err(SaveError::new(SaveErrorCode::Newer, format!("{slot} was saved by a newer version")))
            }
            SlotState::Corrupt => Err(SaveError::corrupt(format!("{slot} is damaged"))),
            _ => {
                self.requests.borrow_mut().push(Request::Load(slot));
                Ok(())
            }
        }
    }

    /// Queue a delete of `slot`, removed after this tick. Refuses `save-slot-invalid`,
    /// `save-busy` and `save-slot-missing`.
    pub fn request_delete(&self, slot: &str) -> Result<(), SaveError> {
        let slot = SlotName::lookup(slot)?;
        self.refuse_when_busy()?;
        self.listed(&slot)?;
        self.requests.borrow_mut().push(Request::Delete(slot));
        Ok(())
    }

    /// The end of a tick that leaves the sim at `tick`: run the queued deletes and saves in order,
    /// then the ring's autosave if one is due. `snapshot` is called at most once.
    pub fn end_tick(
        &mut self,
        store: &mut impl SlotStore,
        tick: u64,
        snapshot: &mut dyn FnMut() -> Result<Snapshot, SaveError>,
    ) {
        let mut read: Option<Result<Snapshot, SaveError>> = None;
        for request in std::mem::take(self.requests.get_mut()) {
            match request {
                Request::Save { slot, label } => {
                    let result =
                        cached(&mut read, snapshot).and_then(|snap| self.write_slot(store, &slot, &label, snap));
                    self.next_events.push(SlotEvent { op: SlotOp::Save, slot, result });
                }
                Request::Delete(slot) => {
                    let result = self.delete_slot(store, &slot);
                    self.next_events.push(SlotEvent { op: SlotOp::Delete, slot, result });
                }
                Request::Load(slot) => self.pending = Some(PendingLoad { slot, since_ms: None }),
            }
        }
        let Some(slot) = self.autosave.and_then(|ring| ring.due(tick)) else { return };
        let result = cached(&mut read, snapshot).and_then(|snap| self.write_slot(store, &slot, "", snap));
        self.next_events.push(SlotEvent { op: SlotOp::Autosave, slot, result });
    }

    /// The start of the next tick at `now_ms` on the injected clock: publish the finished events
    /// and say whether to run, hold, or restore a queued load first.
    pub fn begin_tick(&mut self, store: &mut impl SlotStore, now_ms: u64) -> Step {
        let Some(pending) = self.pending.as_mut() else {
            self.publish();
            return Step::Run;
        };
        let read = store.read(&pending.slot.body_file());
        if read == BodyRead::Pending {
            let since = *pending.since_ms.get_or_insert(now_ms);
            if now_ms.saturating_sub(since) < SAVE_LOAD_HOLD_MAX_MS {
                return Step::Hold;
            }
        }
        let slot = pending.slot.clone();
        self.pending = None;
        self.publish();
        let prepared = match read {
            BodyRead::Ready(body) => self.prepare(&slot, &body),
            BodyRead::Pending => {
                Err(SaveError::new(SaveErrorCode::LoadTimeout, format!("{slot}'s body did not arrive")))
            }
            BodyRead::Missing => Err(SaveError::new(SaveErrorCode::SlotMissing, format!("{slot}'s body is gone"))),
        };
        match prepared {
            Ok(envelope) => {
                let (tick, state_checksum) = (envelope.tick, envelope.state_checksum);
                self.restoring = Some(Restoring { slot: slot.clone(), tick, state_checksum });
                Step::Restore(Box::new(Restore { slot, envelope }))
            }
            Err(error) => {
                self.events.push(SlotEvent { op: SlotOp::Load, slot, result: Err(error) });
                Step::Run
            }
        }
    }

    /// Report the restore [`Step::Restore`] handed out: the recomputed state checksum, or why it
    /// failed (the running sim untouched). Its event is visible in the tick that follows.
    pub fn restored(&mut self, result: Result<u64, SaveError>) {
        let Some(restoring) = self.restoring.take() else { return };
        let Restoring { slot, tick, state_checksum } = restoring;
        let result = result.map(|checksum| {
            let checksum_match = checksum == state_checksum;
            if !checksum_match {
                self.push_issue(SAVE_RESTORE_DIVERGED);
            }
            self.last_load = Some(LastLoad { slot: slot.clone(), tick, checksum_match });
        });
        let result = result.and_then(|()| self.listed(&slot).cloned());
        self.events.push(SlotEvent { op: SlotOp::Load, slot, result });
    }

    /// The slot a suspend save would write: the ring's oldest, when the game autosaves on suspend.
    pub fn suspend_slot(&self) -> Option<SlotName> {
        let ring = self.autosave.filter(|_| self.autosave_on_suspend)?;
        ring.oldest(&self.index)
    }

    /// Write the ring's oldest slot now, between ticks (the app is being suspended or closed):
    /// None when the game does not autosave on suspend. Its event is visible in the next tick.
    pub fn suspend_save(
        &mut self,
        store: &mut impl SlotStore,
        snapshot: &mut dyn FnMut() -> Result<Snapshot, SaveError>,
    ) -> Option<Result<SlotInfo, SaveError>> {
        let slot = self.suspend_slot()?;
        let result = snapshot().and_then(|mut snap| self.write_slot(store, &slot, "", &mut snap));
        self.next_events.push(SlotEvent { op: SlotOp::Autosave, slot, result: result.clone() });
        Some(result)
    }

    fn refuse_when_busy(&self) -> Result<(), SaveError> {
        if self.busy() {
            return Err(SaveError::new(SaveErrorCode::Busy, "a load is pending"));
        }
        Ok(())
    }

    fn listed(&self, slot: &SlotName) -> Result<&SlotInfo, SaveError> {
        self.index
            .get(slot.as_str())
            .ok_or_else(|| SaveError::new(SaveErrorCode::SlotMissing, format!("no slot {slot}")))
    }

    fn publish(&mut self) {
        self.events = std::mem::take(&mut self.next_events);
    }

    fn push_issue(&mut self, issue: &'static str) {
        if self.issues.len() == ISSUES_MAX {
            self.issues.remove(0);
        }
        self.issues.push(issue);
    }

    /// Encode `snap` into `slot`, check the quota for body and sidecar together, write the body,
    /// then the sidecar, and index it. The sections are lent to the envelope and handed back, so a
    /// save holds one copy of them (the phone budget is at most 3x a slot's size).
    fn write_slot(
        &mut self,
        store: &mut impl SlotStore,
        slot: &SlotName,
        label: &str,
        snap: &mut Snapshot,
    ) -> Result<SlotInfo, SaveError> {
        let mut envelope = Envelope {
            schema: self.migrations.schema(),
            game: self.game.clone(),
            tick: snap.tick,
            seed: snap.seed,
            rng: snap.rng,
            state_checksum: snap.state_checksum,
            sections: std::mem::take(&mut snap.sections),
            meta: SaveMeta {
                label: label.to_owned(),
                play_ms: snap.play_ms,
                saved_at_ms: snap.saved_at_ms,
                locale: snap.locale.clone(),
                build: snap.build.clone(),
            },
        };
        let encoded = encode(&envelope);
        snap.sections = std::mem::take(&mut envelope.sections);
        let body = encoded?;
        let meta = SlotMeta::for_body(slot, &envelope, &body);
        let meta_bytes = meta.to_bytes();
        let written = (body.len() + meta_bytes.len()) as u64;
        self.quota.check(store.bytes_used(), self.index.stored_bytes(slot), written)?;
        store.write(&slot.body_file(), &body)?;
        if let Err(error) = store.write(&slot.meta_file(), &meta_bytes) {
            // The new body is down but its old sidecar still describes the old one.
            self.index.verify(slot, &body);
            return Err(error);
        }
        self.index.put(meta, meta_bytes.len() as u64, self.migrations.schema());
        self.last_save = Some(LastSave { slot: slot.clone(), tick: snap.tick, bytes: body.len() as u64 });
        self.listed(slot).cloned()
    }

    fn delete_slot(&mut self, store: &mut impl SlotStore, slot: &SlotName) -> Result<SlotInfo, SaveError> {
        let info = self.listed(slot)?.clone();
        let body = store.remove(&slot.body_file());
        let meta = store.remove(&slot.meta_file());
        if !body && !meta {
            return Err(SaveError::new(SaveErrorCode::Unavailable, format!("{slot} could not be removed")));
        }
        self.index.remove(slot);
        Ok(info)
    }

    /// The envelope a load restores: the body checked against its sidecar, decoded, of this game,
    /// and migrated. A damaged body lists its slot corrupt.
    fn prepare(&mut self, slot: &SlotName, body: &[u8]) -> Result<Envelope, SaveError> {
        if !self.index.verify(slot, body) {
            return Err(SaveError::corrupt(format!("{slot}'s body does not match its sidecar")));
        }
        let decoded = decode(body).and_then(|envelope| {
            if envelope.game == self.game {
                return Ok(envelope);
            }
            Err(SaveError::corrupt(format!("{slot} was saved by another game")))
        });
        if decoded.is_err() {
            self.index.mark_corrupt(slot);
        }
        self.migrations.migrate(decoded?)
    }
}

/// The snapshot, read on first use.
fn cached<'a>(
    read: &'a mut Option<Result<Snapshot, SaveError>>,
    snapshot: &mut dyn FnMut() -> Result<Snapshot, SaveError>,
) -> Result<&'a mut Snapshot, SaveError> {
    read.get_or_insert_with(snapshot).as_mut().map_err(|error| error.clone())
}
