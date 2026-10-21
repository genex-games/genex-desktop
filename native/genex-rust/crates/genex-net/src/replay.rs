//! The Replay backend: a journal fed back reproduces every tick's frame (multiplayer MP-3b).
//!
//! A run is a pure function of (seed, input journal, net journal), so a Relay session, which
//! depends on IO timing, replays bit for bit from what it journaled: a fresh room is fed each
//! journaled tick's changes and events before that tick's cut, and the frames it cuts are the
//! frames the run read. [`frame_digest`] names one frame in 64 bits, so a test compares two runs
//! tick by tick (the SyncTest idea from GGRS, MIT OR Apache-2.0, ideas only).
//!
//! [`crash_journal`] is the form a crash report attaches: the newest ticks of a journal with player
//! names, avatar addresses and chat text replaced by [`REDACTED`], the word Studio's redaction
//! writes.

use std::collections::VecDeque;
use std::fmt;

use genex_core::digest::{FNV_OFFSET_BASIS, fnv1a64_from};
use serde_json::{Map as JsonMap, Value, json};

use crate::backend::NetBackend;
use crate::frame::{NetChange, NetEvent, NetFrame, NetPose, NetRoom};
use crate::ids::PlayerId;
use crate::journal::{JournalTick, NetJournal};
use crate::vocab::{NET_JOURNAL_BYTES_DESKTOP, NetMode, NetOffline};
use crate::writes::NetWrites;

/// How many of the newest journal ticks a crash report attaches.
pub const NET_CRASH_JOURNAL_TICKS: usize = 120;
/// What a redacted name or chat line reads as (Studio's `REDACTED`, `src/shared/redact.ts`).
pub const REDACTED: &str = "[redacted]";

/// A journal the Replay backend cannot reproduce a run from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReplayError {
    trimmed_ticks: u64,
}

impl ReplayError {
    /// How many of the run's first ticks the journal's byte cap dropped.
    pub fn trimmed_ticks(&self) -> u64 {
        self.trimmed_ticks
    }
}

impl fmt::Display for ReplayError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "replay refused: the journal dropped its first {} ticks, so it no longer starts the run", self.trimmed_ticks)
    }
}

impl std::error::Error for ReplayError {}

/// The backend that feeds a journal back: the frames a recorded run read, tick by tick.
#[derive(Clone, Debug)]
pub struct ReplayBackend {
    room: NetRoom,
    ticks: VecDeque<JournalTick>,
    recorded: NetMode,
    late: u64,
    writes: u64,
}

impl ReplayBackend {
    /// Replay `journal`, recorded by a run in `recorded` mode whose room started offline with no
    /// reason (otherwise see [`ReplayBackend::starting_offline`]). Refuses a journal whose byte cap
    /// dropped ticks: it no longer holds the run's start.
    pub fn new(journal: &NetJournal, recorded: NetMode) -> Result<ReplayBackend, ReplayError> {
        if journal.trimmed_ticks() > 0 {
            return Err(ReplayError { trimmed_ticks: journal.trimmed_ticks() });
        }
        Ok(ReplayBackend { room: NetRoom::new(None), ticks: journal.ticks().collect(), recorded, late: 0, writes: 0 })
    }

    /// The recorded room started offline for `reason` (a Relay build with no slug): a reason that
    /// never changed takes no journal entry, so the replay is told it.
    pub fn starting_offline(mut self, reason: Option<NetOffline>) -> ReplayBackend {
        self.room = NetRoom::new(reason);
        self
    }

    /// Journaled ticks not yet cut.
    pub fn remaining(&self) -> usize {
        self.ticks.len()
    }

    /// Journaled ticks fed into a later tick's cut because their own tick was never cut: zero when
    /// the replay steps the ticks the run stepped.
    pub fn late_ticks(&self) -> u64 {
        self.late
    }

    /// How many writes the replayed run made. A replay sends nothing: the journal already holds
    /// their effects.
    pub fn writes(&self) -> u64 {
        self.writes
    }
}

impl NetBackend for ReplayBackend {
    fn pump(&mut self) {}

    fn cut(&mut self, tick: u64) -> NetFrame {
        while let Some(entry) = self.ticks.pop_front() {
            if entry.tick > tick {
                self.ticks.push_front(entry);
                break;
            }
            if entry.tick < tick {
                self.late += 1;
            }
            for change in entry.changes {
                self.room.apply(change);
            }
            for event in entry.events {
                self.room.push_event(event);
            }
        }
        self.room.cut(tick, self.recorded)
    }

    fn apply(&mut self, _tick: u64, writes: NetWrites) {
        self.writes += writes.len() as u64;
    }

    fn mode(&self) -> NetMode {
        NetMode::Replay
    }
}

// ---- frame digest ------------------------------------------------------------------------------

fn pose_bits(pose: Option<NetPose>) -> Value {
    let Some(pose) = pose else { return Value::Null };
    let (p, q) = (pose.position, pose.rotation);
    Value::from([p.x, p.y, p.z, q.x, q.y, q.z, q.w].map(f32::to_bits).to_vec())
}

fn id_or_null(id: Option<&PlayerId>) -> Value {
    id.map_or(Value::Null, |id| Value::from(id.as_str()))
}

/// Everything a frame shows apart from its changes and events, as one JSON value (floats by bits).
fn frame_view(frame: &NetFrame) -> Value {
    let players: Vec<Value> = frame
        .players()
        .map(|p| json!([p.id().as_str(), p.name(), p.avatar_url(), p.connected(), p.is_me(), p.state_raw(), p.state(), pose_bits(p.pose_raw()), pose_bits(p.pose())]))
        .collect();
    let objects: Vec<Value> =
        frame.objects().map(|o| json!([o.id(), id_or_null(o.owner()), o.mine(), o.epoch(), o.state_raw(), o.state(), pose_bits(o.pose())])).collect();
    let shared: Vec<Value> = frame.shared_keys().map(|key| json!([key, frame.shared(key)])).collect();
    let matchmaking = frame.matchmaking().map_or(Value::Null, |m| {
        let players: Vec<&str> = m.players().iter().map(PlayerId::as_str).collect();
        json!([m.status().wire(), m.queue(), players, m.min_players(), m.max_players(), id_or_null(m.winner())])
    });
    json!([
        frame.tick(),
        frame.mode().wire(),
        frame.status().wire(),
        frame.offline_reason().map(NetOffline::wire),
        id_or_null(frame.me()),
        id_or_null(frame.host()),
        frame.room_open(),
        players,
        objects,
        shared,
        matchmaking,
        frame.lobby_code(),
        frame.server_ms().map(f64::to_bits),
    ])
}

/// FNV-1a 64 of everything `frame` shows: its views, then its changes and events in the journal's
/// own encoding. Equal frames give equal digests on every destination.
pub fn frame_digest(frame: &NetFrame) -> u64 {
    // Serializing a `Value` into a Vec cannot fail.
    let view = serde_json::to_vec(&frame_view(frame)).unwrap_or_default();
    let mut entry = NetJournal::new(NET_JOURNAL_BYTES_DESKTOP);
    entry.append(frame);
    fnv1a64_from(&entry.to_json(), fnv1a64_from(&view, FNV_OFFSET_BASIS))
}

// ---- crash report ------------------------------------------------------------------------------

/// `text` redacted; an empty text (no avatar) stays empty.
fn redacted(text: &str) -> String {
    if text.is_empty() { String::new() } else { REDACTED.to_owned() }
}

fn redact_change(change: NetChange) -> NetChange {
    match change {
        NetChange::Join { id, name, avatar_url } => NetChange::Join { id, name: redacted(&name), avatar_url: redacted(&avatar_url) },
        other => other,
    }
}

fn redact_event(event: NetEvent) -> NetEvent {
    match event {
        NetEvent::Chat { from, name, text } => NetEvent::Chat { from, name: redacted(&name), text: redacted(&text) },
        other => other,
    }
}

/// The journal a crash report attaches: the newest `last_ticks` ticks of `journal` (reports use
/// [`NET_CRASH_JOURNAL_TICKS`]) in the journal's v1 JSON form, with player names, avatar addresses
/// and chat text replaced by [`REDACTED`]. Seat ids, states and every other event stay, so the tail
/// still explains the crash; `trimmedTicks` counts every tick left out.
pub fn crash_journal(journal: &NetJournal, last_ticks: usize) -> Vec<u8> {
    let skip = journal.len().saturating_sub(last_ticks);
    let mut tail = NetJournal::new(NET_JOURNAL_BYTES_DESKTOP);
    // A scratch room turns each redacted tick back into a frame the journal appends; its views are
    // never read, and a journaled tick holds at most one cut's events, so none is deferred.
    let mut scratch = NetRoom::new(None);
    for entry in journal.ticks().skip(skip) {
        for change in entry.changes {
            scratch.apply(redact_change(change));
        }
        for event in entry.events {
            scratch.push_event(redact_event(event));
        }
        tail.append(&scratch.cut(entry.tick, NetMode::Replay));
    }
    let mut form: JsonMap<String, Value> = serde_json::from_slice(&tail.to_json()).unwrap_or_default();
    form.insert("trimmedTicks".to_owned(), Value::from(journal.trimmed_ticks() + skip as u64));
    // Serializing a `Value` into a Vec cannot fail.
    serde_json::to_vec(&Value::Object(form)).unwrap_or_default()
}
