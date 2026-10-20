//! NetJournal: the byte-capped ring of cut frames, dropping whole oldest ticks, with its v1 JSON form.
//!
//! Each tick that changed something is kept as its compact JSON entry (the frame's changes and
//! events, nothing derived), so the cap counts the bytes actually held and `to_json` is a join.
//! A run is a pure function of (seed, input journal, net journal): a fresh room fed these entries
//! cuts the same frames. `from_json` takes hostile text: it refuses, never panics, and allocates
//! nothing a count declares, only what the text itself holds.

use std::collections::VecDeque;
use std::fmt;
use std::sync::Arc;

use glam::{Quat, Vec3};
use serde_json::Value;

use crate::frame::{NetChange, NetEvent, NetFrame, NetMatch, NetPose};
use crate::ids::{NetTicket, PlayerId};
use crate::vocab::{MatchStatus, NET_JOURNAL_BYTES_DESKTOP, NetClose, NetControl, NetOffline, NetStatus, NetWarning};

/// The `format` field of a journal's JSON form.
pub const NET_JOURNAL_FORMAT: &str = "genex-net-journal";
/// The only `version` this build reads and writes.
pub const NET_JOURNAL_VERSION: u64 = 1;
/// The longest JSON form `from_json` reads: a full desktop journal plus its separators.
pub const NET_JOURNAL_JSON_BYTES_MAX: usize = 2 * NET_JOURNAL_BYTES_DESKTOP;

/// A journal text that cannot be used: truncated, of another version, over a cap, or malformed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JournalError {
    detail: String,
}

impl JournalError {
    fn new(detail: impl Into<String>) -> JournalError {
        JournalError { detail: detail.into() }
    }

    /// What was wrong, for a person to read.
    pub fn detail(&self) -> &str {
        &self.detail
    }
}

impl fmt::Display for JournalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "net journal refused: {}", self.detail)
    }
}

impl std::error::Error for JournalError {}

/// One journaled tick, decoded: what a replay feeds a fresh room before cutting `tick`.
#[derive(Clone, Debug, PartialEq)]
pub struct JournalTick {
    /// The tick.
    pub tick: u64,
    /// The changes, in order.
    pub changes: Vec<NetChange>,
    /// The events the frame carried, in order.
    pub events: Vec<NetEvent>,
}

#[derive(Clone, Debug)]
struct Entry {
    tick: u64,
    bytes: Box<[u8]>,
}

/// The ring of journaled ticks, at most `cap_bytes` of entries.
#[derive(Clone, Debug)]
pub struct NetJournal {
    cap_bytes: usize,
    entries: VecDeque<Entry>,
    bytes: usize,
    trimmed: u64,
    warned: bool,
}

impl NetJournal {
    /// An empty journal holding at most `cap_bytes` of entries.
    pub fn new(cap_bytes: usize) -> NetJournal {
        NetJournal { cap_bytes, entries: VecDeque::new(), bytes: 0, trimmed: 0, warned: false }
    }

    /// Record a cut frame. A frame with no change and no event takes no entry. Past the cap, whole
    /// oldest ticks go; the first time that happens the answer is `journal-trimmed`.
    pub fn append(&mut self, frame: &NetFrame) -> Option<NetWarning> {
        if frame.changes().is_empty() && frame.events().is_empty() {
            return None;
        }
        let bytes = encode_tick(frame.tick(), frame.changes(), frame.events());
        self.push(Entry { tick: frame.tick(), bytes })
    }

    fn push(&mut self, entry: Entry) -> Option<NetWarning> {
        let mut trimmed_now = false;
        while self.bytes + entry.bytes.len() > self.cap_bytes {
            let Some(oldest) = self.entries.pop_front() else { break };
            self.bytes -= oldest.bytes.len();
            self.trimmed += 1;
            trimmed_now = true;
        }
        if entry.bytes.len() > self.cap_bytes {
            self.trimmed += 1;
            trimmed_now = true;
        } else {
            self.bytes += entry.bytes.len();
            self.entries.push_back(entry);
        }
        if trimmed_now && !self.warned {
            self.warned = true;
            return Some(NetWarning::JournalTrimmed);
        }
        None
    }

    /// The byte cap.
    pub fn cap_bytes(&self) -> usize {
        self.cap_bytes
    }

    /// The bytes held.
    pub fn bytes(&self) -> usize {
        self.bytes
    }

    /// How many ticks are held (`__net.journalTicks`).
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether no tick is held.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// How many ticks the cap dropped since the journal started.
    pub fn trimmed_ticks(&self) -> u64 {
        self.trimmed
    }

    /// The first and last tick held.
    pub fn span(&self) -> Option<(u64, u64)> {
        Some((self.entries.front()?.tick, self.entries.back()?.tick))
    }

    /// Forget every tick (a reseed).
    pub fn clear(&mut self) {
        *self = NetJournal::new(self.cap_bytes);
    }

    /// The held ticks, decoded, oldest first.
    pub fn ticks(&self) -> impl Iterator<Item = JournalTick> + '_ {
        // Every entry was encoded by this module or checked by `from_json`, so it decodes.
        self.entries.iter().filter_map(|entry| decode_entry_bytes(&entry.bytes).ok())
    }

    /// The v1 JSON form.
    pub fn to_json(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.bytes + self.entries.len() + 160);
        out.extend_from_slice(b"{\"format\":");
        put(&mut out, NET_JOURNAL_FORMAT);
        let header = format!(
            ",\"version\":{NET_JOURNAL_VERSION},\"capBytes\":{},\"trimmedTicks\":{},\"count\":{},\"ticks\":[",
            self.cap_bytes,
            self.trimmed,
            self.entries.len()
        );
        out.extend_from_slice(header.as_bytes());
        for (at, entry) in self.entries.iter().enumerate() {
            if at > 0 {
                out.push(b',');
            }
            out.extend_from_slice(&entry.bytes);
        }
        out.extend_from_slice(b"]}");
        out
    }

    /// Read a v1 JSON form. Refuses (never panics) a truncated text, another format or version, a
    /// count that is not the tick list's length, ticks out of order, entries past the declared cap
    /// and any malformed entry.
    pub fn from_json(text: &[u8]) -> Result<NetJournal, JournalError> {
        if text.len() > NET_JOURNAL_JSON_BYTES_MAX {
            return Err(JournalError::new(format!("{} bytes; the cap is {NET_JOURNAL_JSON_BYTES_MAX}", text.len())));
        }
        let root: Value = serde_json::from_slice(text).map_err(|error| JournalError::new(format!("not JSON: {error}")))?;
        let header = Header::read(&root)?;
        let mut journal = NetJournal::new(header.cap_bytes);
        journal.trimmed = header.trimmed;
        let mut last_tick = None;
        for raw in header.ticks {
            let tick = decode_entry(raw)?;
            if last_tick.is_some_and(|last| tick.tick <= last) {
                return Err(JournalError::new(format!("tick {} is out of order", tick.tick)));
            }
            last_tick = Some(tick.tick);
            let bytes = encode_tick(tick.tick, &tick.changes, &tick.events);
            if journal.bytes + bytes.len() > journal.cap_bytes {
                return Err(JournalError::new(format!("the entries pass the declared cap of {} bytes", journal.cap_bytes)));
            }
            journal.bytes += bytes.len();
            journal.entries.push_back(Entry { tick: tick.tick, bytes });
        }
        Ok(journal)
    }
}

/// The checked header of a journal's JSON form.
struct Header<'a> {
    cap_bytes: usize,
    trimmed: u64,
    ticks: &'a [Value],
}

impl<'a> Header<'a> {
    fn read(root: &'a Value) -> Result<Header<'a>, JournalError> {
        let object = root.as_object().ok_or_else(|| JournalError::new("the root is not an object"))?;
        if object.get("format").and_then(Value::as_str) != Some(NET_JOURNAL_FORMAT) {
            return Err(JournalError::new(format!("the format is not {NET_JOURNAL_FORMAT}")));
        }
        let version = object.get("version").and_then(Value::as_u64);
        if version != Some(NET_JOURNAL_VERSION) {
            return Err(JournalError::new(format!("version {version:?} is not {NET_JOURNAL_VERSION}")));
        }
        let cap = object.get("capBytes").and_then(Value::as_u64).unwrap_or(0);
        let cap_ok = cap > 0 && cap <= NET_JOURNAL_BYTES_DESKTOP as u64;
        if !cap_ok {
            return Err(JournalError::new(format!("capBytes {cap} is outside 1..={NET_JOURNAL_BYTES_DESKTOP}")));
        }
        let trimmed = object.get("trimmedTicks").and_then(Value::as_u64).ok_or_else(|| JournalError::new("trimmedTicks is missing"))?;
        let ticks = object.get("ticks").and_then(Value::as_array).ok_or_else(|| JournalError::new("ticks is not a list"))?;
        let count = object.get("count").and_then(Value::as_u64).ok_or_else(|| JournalError::new("count is missing"))?;
        if count != ticks.len() as u64 {
            return Err(JournalError::new(format!("count {count} is not the {} ticks listed", ticks.len())));
        }
        Ok(Header { cap_bytes: cap as usize, trimmed, ticks })
    }
}

// ---- encoding ----------------------------------------------------------------------------------

fn put(out: &mut Vec<u8>, text: &str) {
    // Serializing a string into a Vec cannot fail.
    let _ = serde_json::to_writer(&mut *out, text);
}

fn put_tag(out: &mut Vec<u8>, tag: &str) {
    out.push(b'[');
    put(out, tag);
}

fn put_id(out: &mut Vec<u8>, id: Option<&PlayerId>) {
    out.push(b',');
    match id {
        Some(id) => put(out, id.as_str()),
        None => out.extend_from_slice(b"null"),
    }
}

fn put_value(out: &mut Vec<u8>, value: &Value) {
    out.push(b',');
    // Serializing a `Value` into a Vec cannot fail.
    let _ = serde_json::to_writer(&mut *out, value);
}

fn put_pose(out: &mut Vec<u8>, pose: Option<NetPose>) {
    out.push(b',');
    let Some(pose) = pose else {
        out.extend_from_slice(b"null");
        return;
    };
    let p = pose.position;
    let q = pose.rotation;
    let parts = [p.x, p.y, p.z, q.x, q.y, q.z, q.w].map(f64::from);
    // Serializing numbers into a Vec cannot fail.
    let _ = serde_json::to_writer(&mut *out, &parts);
}

fn encode_tick(tick: u64, changes: &[NetChange], events: &[NetEvent]) -> Box<[u8]> {
    let mut out = Vec::with_capacity(64);
    out.extend_from_slice(format!("{{\"t\":{tick}").as_bytes());
    if !changes.is_empty() {
        out.extend_from_slice(b",\"c\":[");
        for (at, change) in changes.iter().enumerate() {
            if at > 0 {
                out.push(b',');
            }
            encode_change(&mut out, change);
        }
        out.push(b']');
    }
    if !events.is_empty() {
        out.extend_from_slice(b",\"e\":[");
        for (at, event) in events.iter().enumerate() {
            if at > 0 {
                out.push(b',');
            }
            encode_event(&mut out, event);
        }
        out.push(b']');
    }
    out.push(b'}');
    out.into_boxed_slice()
}

fn encode_change(out: &mut Vec<u8>, change: &NetChange) {
    match change {
        NetChange::Status { status, reason } => {
            put_tag(out, "status");
            put_value(out, &Value::from(status.wire()));
            put_value(out, &reason.map_or(Value::Null, |reason| Value::from(reason.wire())));
        }
        NetChange::Me(id) => {
            put_tag(out, "me");
            put_id(out, id.as_ref());
        }
        NetChange::Host(id) => {
            put_tag(out, "host");
            put_id(out, id.as_ref());
        }
        NetChange::RoomOpen(open) => {
            put_tag(out, "open");
            put_value(out, &Value::Bool(*open));
        }
        NetChange::Join { id, name, avatar_url } => {
            put_tag(out, "join");
            put_id(out, Some(id));
            put_value(out, &Value::from(name.as_str()));
            put_value(out, &Value::from(avatar_url.as_str()));
        }
        NetChange::Leave(id) => {
            put_tag(out, "leave");
            put_id(out, Some(id));
        }
        NetChange::Connected { id, connected } => {
            put_tag(out, "conn");
            put_id(out, Some(id));
            put_value(out, &Value::Bool(*connected));
        }
        NetChange::PlayerState { id, raw, smoothed, pose_raw, pose } => {
            put_tag(out, "p");
            put_id(out, Some(id));
            put_value(out, raw);
            let tail = smoothed.is_some() || pose_raw.is_some() || pose.is_some();
            if tail {
                put_value(out, smoothed.as_ref().unwrap_or(&Value::Null));
                put_pose(out, *pose_raw);
                put_pose(out, *pose);
            }
        }
        NetChange::Object { id, owner, epoch, raw, smoothed, pose } => {
            put_tag(out, "obj");
            put_value(out, &Value::from(id.as_ref()));
            put_id(out, owner.as_ref());
            put_value(out, &Value::from(*epoch));
            put_value(out, raw);
            if smoothed.is_some() || pose.is_some() {
                put_value(out, smoothed.as_ref().unwrap_or(&Value::Null));
                put_pose(out, *pose);
            }
        }
        NetChange::ObjectRemoved(id) => {
            put_tag(out, "objx");
            put_value(out, &Value::from(id.as_ref()));
        }
        NetChange::Shared { key, value } => {
            put_tag(out, "shared");
            put_value(out, &Value::from(key.as_str()));
            if let Some(value) = value {
                put_value(out, value);
            }
        }
        NetChange::Match(matchmaking) => {
            put_tag(out, "match");
            put_value(out, &matchmaking.as_ref().map_or(Value::Null, match_to_value));
        }
        NetChange::LobbyCode(code) => {
            put_tag(out, "code");
            put_value(out, &code.as_deref().map_or(Value::Null, Value::from));
        }
        NetChange::ServerMs(ms) => {
            put_tag(out, "ms");
            put_value(out, &ms.map_or(Value::Null, Value::from));
        }
    }
    out.push(b']');
}

fn id_value(id: Option<&PlayerId>) -> Value {
    id.map_or(Value::Null, |id| Value::from(id.as_str()))
}

fn match_to_value(matchmaking: &NetMatch) -> Value {
    let (position, size) = matchmaking.queue();
    serde_json::json!({
        "status": matchmaking.status().wire(),
        "queue": [position, size],
        "players": matchmaking.players().iter().map(|id| id.as_str()).collect::<Vec<_>>(),
        "min": matchmaking.min_players(),
        "max": matchmaking.max_players(),
        "winner": id_value(matchmaking.winner()),
    })
}

fn encode_event(out: &mut Vec<u8>, event: &NetEvent) {
    match event {
        NetEvent::Joined { player } => player_event(out, "joined", player),
        NetEvent::Left { player } => player_event(out, "left", player),
        NetEvent::Dropped { player } => player_event(out, "dropped", player),
        NetEvent::Returned { player } => player_event(out, "returned", player),
        NetEvent::Host { player } => {
            put_tag(out, "host");
            put_id(out, player.as_ref());
        }
        NetEvent::Owner { object, owner } => {
            put_tag(out, "owner");
            put_value(out, &Value::from(object.as_str()));
            put_id(out, owner.as_ref());
        }
        NetEvent::Shared { key } => {
            put_tag(out, "shared");
            put_value(out, &Value::from(key.as_str()));
        }
        NetEvent::Message { from, kind, payload } => {
            put_tag(out, "msg");
            put_id(out, Some(from));
            put_value(out, &Value::from(kind.as_str()));
            put_value(out, payload);
        }
        NetEvent::HostInput { from, payload } => {
            put_tag(out, "input");
            put_id(out, Some(from));
            put_value(out, payload);
        }
        NetEvent::Chat { from, name, text } => {
            put_tag(out, "chat");
            put_id(out, Some(from));
            put_value(out, &Value::from(name.as_str()));
            put_value(out, &Value::from(text.as_str()));
        }
        NetEvent::Control { ticket, result, retry_at_tick } => {
            put_tag(out, "control");
            put_value(out, &Value::from(ticket.number()));
            put_value(out, &Value::from(result.wire()));
            put_value(out, &retry_at_tick.map_or(Value::Null, Value::from));
        }
        NetEvent::RoomOpen { open } => {
            put_tag(out, "open");
            put_value(out, &Value::Bool(*open));
        }
        NetEvent::Reconnecting { attempt } => {
            put_tag(out, "reconnecting");
            put_value(out, &Value::from(*attempt));
        }
        NetEvent::Reconnected => put_tag(out, "reconnected"),
        NetEvent::Closed { reason } => {
            put_tag(out, "closed");
            put_value(out, &Value::from(reason.wire()));
        }
        NetEvent::Match { status } => {
            put_tag(out, "match");
            put_value(out, &Value::from(status.wire()));
        }
        NetEvent::Warning { code } => {
            put_tag(out, "warn");
            put_value(out, &Value::from(code.wire()));
        }
    }
    out.push(b']');
}

fn player_event(out: &mut Vec<u8>, tag: &str, player: &PlayerId) {
    put_tag(out, tag);
    put_id(out, Some(player));
}

// ---- decoding ----------------------------------------------------------------------------------

fn bad(what: &str) -> JournalError {
    JournalError::new(format!("malformed {what}"))
}

/// The fields of one tagged entry (`["tag", a, b, ...]`), read by position.
struct Fields<'a> {
    what: &'static str,
    items: &'a [Value],
}

impl<'a> Fields<'a> {
    fn at(&self, index: usize) -> Result<&'a Value, JournalError> {
        self.items.get(index).ok_or_else(|| bad(self.what))
    }

    fn optional(&self, index: usize) -> Option<&'a Value> {
        self.items.get(index).filter(|value| !value.is_null())
    }

    fn text(&self, index: usize) -> Result<&'a str, JournalError> {
        self.at(index)?.as_str().ok_or_else(|| bad(self.what))
    }

    fn id(&self, index: usize) -> Result<PlayerId, JournalError> {
        self.text(index).map(PlayerId::new)
    }

    fn optional_id(&self, index: usize) -> Result<Option<PlayerId>, JournalError> {
        self.optional(index).map(|value| value.as_str().map(PlayerId::new).ok_or_else(|| bad(self.what))).transpose()
    }

    fn flag(&self, index: usize) -> Result<bool, JournalError> {
        self.at(index)?.as_bool().ok_or_else(|| bad(self.what))
    }

    fn u64(&self, index: usize) -> Result<u64, JournalError> {
        self.at(index)?.as_u64().ok_or_else(|| bad(self.what))
    }

    fn u32(&self, index: usize) -> Result<u32, JournalError> {
        u32::try_from(self.u64(index)?).map_err(|_| bad(self.what))
    }

    fn word<T>(&self, index: usize, from_wire: fn(&str) -> Option<T>) -> Result<T, JournalError> {
        from_wire(self.text(index)?).ok_or_else(|| bad(self.what))
    }

    fn pose(&self, index: usize) -> Result<Option<NetPose>, JournalError> {
        self.optional(index).map(|value| decode_pose(value).ok_or_else(|| bad(self.what))).transpose()
    }
}

fn decode_pose(value: &Value) -> Option<NetPose> {
    let parts = value.as_array()?;
    if parts.len() != 7 {
        return None;
    }
    let mut f = [0.0_f32; 7];
    for (slot, part) in f.iter_mut().zip(parts) {
        *slot = part.as_f64()? as f32;
    }
    Some(NetPose { position: Vec3::new(f[0], f[1], f[2]), rotation: Quat::from_xyzw(f[3], f[4], f[5], f[6]) })
}

fn tagged<'a>(value: &'a Value, what: &'static str) -> Result<(&'a str, Fields<'a>), JournalError> {
    let items = value.as_array().ok_or_else(|| bad(what))?;
    let tag = items.first().and_then(Value::as_str).ok_or_else(|| bad(what))?;
    Ok((tag, Fields { what, items }))
}

fn decode_entry_bytes(bytes: &[u8]) -> Result<JournalTick, JournalError> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| bad("tick"))?;
    decode_entry(&value)
}

fn decode_entry(value: &Value) -> Result<JournalTick, JournalError> {
    let object = value.as_object().ok_or_else(|| bad("tick"))?;
    let tick = object.get("t").and_then(Value::as_u64).ok_or_else(|| bad("tick"))?;
    let list = |key: &str| -> Result<&[Value], JournalError> {
        match object.get(key) {
            None => Ok(&[]),
            Some(value) => value.as_array().map(Vec::as_slice).ok_or_else(|| bad("tick")),
        }
    };
    let changes = list("c")?.iter().map(decode_change).collect::<Result<Vec<_>, _>>()?;
    let events = list("e")?.iter().map(decode_event).collect::<Result<Vec<_>, _>>()?;
    Ok(JournalTick { tick, changes, events })
}

fn decode_change(value: &Value) -> Result<NetChange, JournalError> {
    let (tag, f) = tagged(value, "change")?;
    let change = match tag {
        "status" => {
            let reason = f.optional(2).map(|value| value.as_str().and_then(NetOffline::from_wire).ok_or_else(|| bad(f.what))).transpose()?;
            NetChange::Status { status: f.word(1, NetStatus::from_wire)?, reason }
        }
        "me" => NetChange::Me(f.optional_id(1)?),
        "host" => NetChange::Host(f.optional_id(1)?),
        "open" => NetChange::RoomOpen(f.flag(1)?),
        "join" => NetChange::Join { id: f.id(1)?, name: f.text(2)?.to_owned(), avatar_url: f.text(3)?.to_owned() },
        "leave" => NetChange::Leave(f.id(1)?),
        "conn" => NetChange::Connected { id: f.id(1)?, connected: f.flag(2)? },
        "p" => NetChange::PlayerState { id: f.id(1)?, raw: f.at(2)?.clone(), smoothed: f.optional(3).cloned(), pose_raw: f.pose(4)?, pose: f.pose(5)? },
        "obj" => NetChange::Object {
            id: Arc::from(f.text(1)?),
            owner: f.optional_id(2)?,
            epoch: f.u32(3)?,
            raw: f.at(4)?.clone(),
            smoothed: f.optional(5).cloned(),
            pose: f.pose(6)?,
        },
        "objx" => NetChange::ObjectRemoved(Arc::from(f.text(1)?)),
        "shared" => NetChange::Shared { key: f.text(1)?.to_owned(), value: f.items.get(2).cloned() },
        "match" => NetChange::Match(f.optional(1).map(decode_match).transpose()?),
        "code" => NetChange::LobbyCode(f.optional(1).map(|value| value.as_str().map(str::to_owned).ok_or_else(|| bad(f.what))).transpose()?),
        "ms" => NetChange::ServerMs(f.optional(1).map(|value| value.as_f64().ok_or_else(|| bad(f.what))).transpose()?),
        _ => return Err(JournalError::new(format!("unknown change `{tag}`"))),
    };
    Ok(change)
}

fn decode_match(value: &Value) -> Result<NetMatch, JournalError> {
    let what = "match";
    let object = value.as_object().ok_or_else(|| bad(what))?;
    let number = |key: &str| -> Result<u32, JournalError> {
        object.get(key).and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok()).ok_or_else(|| bad(what))
    };
    let status = object.get("status").and_then(Value::as_str).and_then(MatchStatus::from_wire).ok_or_else(|| bad(what))?;
    let queue = object.get("queue").and_then(Value::as_array).filter(|queue| queue.len() == 2).ok_or_else(|| bad(what))?;
    let place = |at: usize| queue[at].as_u64().and_then(|n| u32::try_from(n).ok()).ok_or_else(|| bad(what));
    let players = object.get("players").and_then(Value::as_array).ok_or_else(|| bad(what))?;
    let players = players.iter().map(|id| id.as_str().map(PlayerId::new).ok_or_else(|| bad(what))).collect::<Result<Vec<_>, _>>()?;
    let winner = match object.get("winner") {
        None | Some(Value::Null) => None,
        Some(id) => Some(id.as_str().map(PlayerId::new).ok_or_else(|| bad(what))?),
    };
    Ok(NetMatch::new(status).with_queue(place(0)?, place(1)?).with_players(players).with_limits(number("min")?, number("max")?).with_winner(winner))
}

fn decode_event(value: &Value) -> Result<NetEvent, JournalError> {
    let (tag, f) = tagged(value, "event")?;
    let event = match tag {
        "joined" => NetEvent::Joined { player: f.id(1)? },
        "left" => NetEvent::Left { player: f.id(1)? },
        "dropped" => NetEvent::Dropped { player: f.id(1)? },
        "returned" => NetEvent::Returned { player: f.id(1)? },
        "host" => NetEvent::Host { player: f.optional_id(1)? },
        "owner" => NetEvent::Owner { object: f.text(1)?.to_owned(), owner: f.optional_id(2)? },
        "shared" => NetEvent::Shared { key: f.text(1)?.to_owned() },
        "msg" => NetEvent::Message { from: f.id(1)?, kind: f.text(2)?.to_owned(), payload: f.at(3)?.clone() },
        "input" => NetEvent::HostInput { from: f.id(1)?, payload: f.at(2)?.clone() },
        "chat" => NetEvent::Chat { from: f.id(1)?, name: f.text(2)?.to_owned(), text: f.text(3)?.to_owned() },
        "control" => NetEvent::Control {
            ticket: NetTicket::new(f.u32(1)?),
            result: f.word(2, NetControl::from_wire)?,
            retry_at_tick: f.optional(3).map(|value| value.as_u64().ok_or_else(|| bad(f.what))).transpose()?,
        },
        "open" => NetEvent::RoomOpen { open: f.flag(1)? },
        "reconnecting" => NetEvent::Reconnecting { attempt: f.u32(1)? },
        "reconnected" => NetEvent::Reconnected,
        "closed" => NetEvent::Closed { reason: f.word(1, NetClose::from_wire)? },
        "match" => NetEvent::Match { status: f.word(1, MatchStatus::from_wire)? },
        "warn" => NetEvent::Warning { code: f.word(1, NetWarning::from_wire)? },
        _ => return Err(JournalError::new(format!("unknown event `{tag}`"))),
    };
    Ok(event)
}
