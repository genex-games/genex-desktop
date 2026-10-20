//! The native session: Genex protocol 3 over the official Colyseus 0.18 C core, in polled mode.
//!
//! Single-threaded by construction. `colyseus_set_polled(true)` is latched once per process, and
//! every C callback fires inside `colyseus_poll()`, which `Session::poll()` calls. Callbacks only
//! copy data into a queue; the session processes that queue after the poll returns, so no Rust
//! borrow is ever live across the C boundary and no room is ever freed inside its own callback.

mod ffi;
mod identity;
mod nodelay;
mod state;

pub use identity::{DeviceCode, DevicePoll, EmbedIdentity, IdentityError, TICKET_ENV};

use serde_json::{json, Map, Value};
use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::sync::Once;

use crate::interp::Interpolator;
use crate::msgpack;
use crate::pose::{self, PoseFields, VelocityMemory};
use crate::protocol::{
    self, client_message as cm, clock_sync, close_code, interpolation as ip, join_error, limits, reconnection,
    server_message as sm, POSE_KEYS, PROTOCOL_VERSION,
};
use crate::stamp::{local_now_ms, parse_json_text, parse_player_data, stamp_state};
use crate::types::*;
use state::{ObjectRaw, PlayerRaw, Snapshot};

/// Supplies a FRESH embed token immediately before every join, create, joinById and queue join
/// (§3.2). Never cache one across calls, never log it.
pub type IdentityProvider = Box<dyn FnMut() -> Result<String, String>>;

static POLLED: Once = Once::new();

fn ensure_polled() {
    // SAFETY: process-wide switch, set once before any client exists.
    POLLED.call_once(|| unsafe { ffi::colyseus_set_polled(true) });
}

/// Drive every live session's sockets without processing any session's queue. `Session::poll()`
/// already calls this; it exists for apps that hold sessions they do not poll every frame.
pub fn poll_network() {
    ensure_polled();
    // SAFETY: called from the polling thread, outside any callback.
    unsafe { ffi::colyseus_poll() }
}

// ---------------------------------------------------------------------------------------------
// C callback plumbing
// ---------------------------------------------------------------------------------------------

#[derive(Debug)]
enum Raw {
    Room(*mut ffi::colyseus_room_t),
    JoinError(i32, String),
    Joined,
    State(Box<Snapshot>),
    Message(String, Value),
    Drop(i32),
    Reconnect,
    Leave(i32, String),
    RoomError(i32, String),
    Latency(Option<String>),
}

#[derive(Default)]
struct Sink {
    raw: VecDeque<(u32, f64, Raw)>,
    /// The session was dropped while a callback could still arrive: rooms that show up are left.
    orphaned: bool,
}

/// Userdata of one join attempt and of the room it produced.
struct Ctx {
    sink: *const RefCell<Sink>,
    gen: u32,
    room: Cell<*mut ffi::colyseus_room_t>,
    reconnect: bool,
}

unsafe fn push(ud: *mut c_void, raw: Raw) {
    let ctx = &*(ud as *const Ctx);
    if let Ok(mut sink) = (*ctx.sink).try_borrow_mut() {
        sink.raw.push_back((ctx.gen, local_now_ms(), raw));
    }
}

unsafe fn lossy(p: *const c_char) -> String {
    if p.is_null() {
        String::new()
    } else {
        CStr::from_ptr(p).to_string_lossy().into_owned()
    }
}

unsafe extern "C" fn cb_room(room: *mut ffi::colyseus_room_t, ud: *mut c_void) {
    let ctx = &*(ud as *const Ctx);
    ctx.room.set(room);
    if (*ctx.sink).try_borrow().map(|s| s.orphaned).unwrap_or(false) {
        ffi::colyseus_room_leave(room, true);
        return;
    }
    // Wire the room's callbacks right here: the join handshake can arrive in this same poll.
    ffi::colyseus_room_on_join(room, cb_join, ud);
    ffi::colyseus_room_on_state_change(room, cb_state, ud);
    ffi::colyseus_room_on_leave(room, cb_leave, ud);
    ffi::colyseus_room_on_drop(room, cb_drop, ud);
    ffi::colyseus_room_on_reconnect(room, cb_reconnect, ud);
    ffi::colyseus_room_on_error(room, cb_room_error, ud);
    ffi::colyseus_room_on_message_any_with_type_encoded(room, cb_message, ud);
    // §8: one reconnect owner, the SDK, from the first millisecond; never on the queue room.
    let options = ffi::colyseus_reconnection_options_t {
        enabled: ctx.reconnect && reconnection::ENABLED,
        max_retries: reconnection::MAX_RETRIES,
        min_delay_ms: reconnection::MIN_DELAY_MS,
        max_delay_ms: reconnection::MAX_DELAY_MS,
        min_uptime_ms: reconnection::MIN_UPTIME_MS,
        delay_ms: reconnection::DELAY_MS,
        max_enqueued_messages: reconnection::MAX_ENQUEUED_MESSAGES,
    };
    ffi::colyseus_room_set_reconnection_options(room, &options);
    push(ud, Raw::Room(room));
}

unsafe extern "C" fn cb_join_error(code: c_int, message: *const c_char, ud: *mut c_void) {
    push(ud, Raw::JoinError(code, lossy(message)));
}

unsafe extern "C" fn cb_join(ud: *mut c_void) {
    push(ud, Raw::Joined);
}

unsafe extern "C" fn cb_state(ud: *mut c_void) {
    let ctx = &*(ud as *const Ctx);
    if let Some(snap) = state::read_snapshot(ctx.room.get()) {
        push(ud, Raw::State(Box::new(snap)));
    }
}

unsafe extern "C" fn cb_leave(code: c_int, reason: *const c_char, ud: *mut c_void) {
    push(ud, Raw::Leave(code, lossy(reason)));
}

unsafe extern "C" fn cb_drop(code: c_int, reason: *const c_char, ud: *mut c_void) {
    let _ = reason;
    push(ud, Raw::Drop(code));
}

unsafe extern "C" fn cb_reconnect(ud: *mut c_void) {
    push(ud, Raw::Reconnect);
}

unsafe extern "C" fn cb_room_error(code: c_int, message: *const c_char, ud: *mut c_void) {
    push(ud, Raw::RoomError(code, lossy(message)));
}

unsafe extern "C" fn cb_message(kind: *const c_char, data: *const u8, len: usize, ud: *mut c_void) {
    let bytes = if data.is_null() || len == 0 {
        &[][..]
    } else {
        std::slice::from_raw_parts(data, len)
    };
    if std::env::var_os("GENEX_DEBUG_BYTES").is_some() {
        eprintln!("MSG {} {:02x?}", lossy(kind), bytes);
    }
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        msgpack::decode(bytes).unwrap_or(Value::Null)
    };
    push(ud, Raw::Message(lossy(kind), value));
}

unsafe extern "C" fn cb_latency(best: *const c_char, _latency_ms: f64, ud: *mut c_void) {
    let best = if best.is_null() { None } else { Some(lossy(best)) };
    push(ud, Raw::Latency(best));
}

// ---------------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RoomKind {
    Play,
    Queue,
    Match,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Phase {
    /// Measuring latency to several endpoints.
    Selecting,
    /// Matchmaking request or socket handshake in flight.
    Connecting,
    /// Waiting in the queue room for a seat.
    Queued,
    /// Queue dropped: search again at this local time.
    Searching {
        at: f64,
    },
    Joined,
    Reconnecting {
        since: f64,
    },
    /// §8: reconnected, waiting (≤ 2 s) for the first full state.
    Resyncing {
        deadline: f64,
    },
    Closed,
}

struct RoomSlot {
    room: *mut ffi::colyseus_room_t,
    ctx: Box<Ctx>,
}

#[derive(Debug, Default)]
struct PlayerMirror {
    raw: PlayerRaw,
    data: Map<String, Value>,
    posed_stream: bool,
}

#[derive(Debug, Default)]
struct ObjectMirror {
    raw: ObjectRaw,
    value: Value,
    /// Owner as this client sees it: the relay's, or `me` right after an accepted claim.
    owner: String,
    /// The last state this client published while owning it.
    local: Option<Value>,
    /// A coalesced publish waiting for the rate limit: the time the game set it.
    pending: Option<f64>,
    last_sent: f64,
}

struct PendingControl {
    payload: Value,
    message: &'static str,
    operation: &'static str,
    id: String,
    deadline: f64,
}

/// Native-core v0.18.10 workaround: an EOF during a WebSocket handshake leaves the transport
/// waiting forever (it never reports a close), so the core's in-place reconnect stalls with no
/// further attempts and no 4003.
///
/// The core owns the reconnect (§8) for as long as it makes progress. The session watches its
/// attempts through [`room_probe`] and steps in only when one is really stuck: the attempt has
/// been in flight for `STALL_TAKEOVER_MS` (timed per attempt, from the core's own backoff
/// schedule) and its socket never opened. Then it abandons that room WITHOUT consent (no
/// LEAVE_ROOM can go out on a socket that is not open) and re-takes the held seat itself with the
/// reconnection token (`colyseus_client_reconnect`), with its own backoff, until the grace is
/// nearly spent. The seat, session id and objects are the same ones.
///
/// A socket that is open is never abandoned, the core's or the crate's own: it is waiting for
/// JOIN_ROOM, and a socket closed inside that window loses the seat at once (§8).
struct Takeover {
    token: String,
    attempt: u32,
    attempt_started: Option<f64>,
    next_at: f64,
}

/// The core's current reconnect attempt, as seen through [`room_probe`].
struct CoreWatch {
    retry_count: i32,
    /// When the session first saw this `retry_count`: the core armed the attempt's backoff then.
    scheduled_at: f64,
}

/// Well beyond any handshake: a TCP connect, a TLS handshake and the HTTP upgrade.
const STALL_TAKEOVER_MS: f64 = 5000.0;
/// A takeover attempt whose socket has not opened after this is abandoned (never an open one).
const TAKEOVER_ATTEMPT_TIMEOUT_MS: f64 = 5000.0;
/// Stop before the relay's 30 s grace runs out (§8).
const RECONNECT_GIVE_UP_MS: f64 = 27_000.0;
/// A first join whose handshake never completes (same core bug) fails after this.
const CONNECT_TIMEOUT_MS: f64 = 15_000.0;

#[derive(Default)]
struct Heartbeat {
    handle: Option<*mut ffi::colyseus_input_handle_t>,
    probed: bool,
    next_at: f64,
    synced: bool,
}

/// A Genex multiplayer session (native).
///
/// Call [`Session::poll`] once per frame; it drives the network, returns the events since the
/// last call and refreshes the smoothed player and object views. Host logic should run from a
/// fixed wall-clock tick while [`Session::is_host`] is true.
pub struct Session {
    opts: ConnectOptions,
    identity: IdentityProvider,
    sink: *const RefCell<Sink>,
    settings: *mut ffi::colyseus_settings_t,
    client: *mut ffi::colyseus_client_t,
    endpoint: Option<String>,
    current: Option<RoomSlot>,
    retired: Vec<RoomSlot>,
    /// Join attempts whose matchmaking callback has not fired yet.
    pending_ctx: HashMap<u32, Box<Ctx>>,
    gen: u32,
    phase: Phase,
    leaving: bool,
    session_id: String,
    room_id: String,
    room_kind: RoomKind,
    joined_once: bool,
    search_attempt: usize,
    connect_started: f64,
    takeover: Option<Takeover>,
    core_watch: Option<CoreWatch>,
    probe_warned: bool,
    /// The relay's TCP port, to find the core's sockets for TCP_NODELAY (nodelay.rs); 0 = unknown.
    relay_port: u16,

    players: BTreeMap<String, PlayerMirror>,
    objects: BTreeMap<String, ObjectMirror>,
    shared: BTreeMap<String, String>,
    host: String,
    match_text: String,
    clock_origin: f64,
    interp: Interpolator,
    player_views: Vec<PlayerView>,
    object_views: Vec<ObjectView>,

    me: Option<Value>,
    /// A coalesced `set_me` waiting for the rate limit: the time the game set it.
    me_pending: Option<f64>,
    last_publish: f64,
    last_data_text: String,
    last_data_sent: f64,
    pose_pending: Option<PoseFields>,
    pose_memory: Option<VelocityMemory>,

    pending: BTreeMap<String, PendingControl>,
    request_prefix: String,
    request_counter: u64,
    chat: BTreeMap<i64, ChatMessage>,
    heartbeat: Heartbeat,
    rng: u64,
    dropped_offline: u64,
    events: Vec<Event>,
}

impl Session {
    /// Start connecting. Returns at once; [`Event::Joined`] (or [`Event::JoinFailed`]) arrives
    /// from a later [`Session::poll`]. `identity` is called right before every join.
    pub fn connect(opts: ConnectOptions, identity: impl FnMut() -> Result<String, String> + 'static) -> Session {
        ensure_polled();
        let sink = Box::into_raw(Box::new(RefCell::new(Sink::default())));
        let seed = (local_now_ms().to_bits() ^ (sink as u64).rotate_left(17)) | 1;
        let mut s = Session {
            opts,
            identity: Box::new(identity),
            sink,
            settings: std::ptr::null_mut(),
            client: std::ptr::null_mut(),
            endpoint: None,
            current: None,
            retired: Vec::new(),
            pending_ctx: HashMap::new(),
            gen: 0,
            phase: Phase::Connecting,
            leaving: false,
            session_id: String::new(),
            room_id: String::new(),
            room_kind: RoomKind::Play,
            joined_once: false,
            search_attempt: 0,
            connect_started: 0.0,
            takeover: None,
            core_watch: None,
            probe_warned: false,
            relay_port: 0,
            players: BTreeMap::new(),
            objects: BTreeMap::new(),
            shared: BTreeMap::new(),
            host: String::new(),
            match_text: String::new(),
            clock_origin: 0.0,
            interp: Interpolator::new(),
            player_views: Vec::new(),
            object_views: Vec::new(),
            me: None,
            me_pending: None,
            last_publish: 0.0,
            last_data_text: String::new(),
            last_data_sent: 0.0,
            pose_pending: None,
            pose_memory: None,
            pending: BTreeMap::new(),
            request_prefix: String::new(),
            request_counter: 0,
            chat: BTreeMap::new(),
            heartbeat: Heartbeat::default(),
            rng: seed,
            dropped_offline: 0,
            events: Vec::new(),
        };
        s.request_prefix = format!("rs{:08x}", s.next_random() as u32);
        s.opts.publish_hz = s.opts.publish_hz.clamp(1.0, 30.0);
        s.opts.control_timeout_ms = s.opts.control_timeout_ms.clamp(100.0, protocol::CONTROL_TIMEOUT_MAX_MS);
        match s.opts.endpoints.len() {
            0 => s.fail_join(0, "no relay endpoint given".into()),
            1 => {
                let url = s.opts.endpoints[0].clone();
                s.use_endpoint(url);
            }
            _ => s.select_endpoint(),
        }
        s
    }

    /// [`Session::connect`], then poll until joined or refused (or `timeout_ms` passes).
    pub fn connect_blocking(
        opts: ConnectOptions,
        identity: impl FnMut() -> Result<String, String> + 'static,
        timeout_ms: u64,
    ) -> Result<(Session, Vec<Event>), JoinFailure> {
        let mut s = Session::connect(opts, identity);
        let deadline = local_now_ms() + timeout_ms as f64;
        let mut seen = Vec::new();
        while local_now_ms() < deadline {
            for e in s.poll() {
                match e {
                    Event::JoinFailed { code, message } | Event::Disconnected { code, reason: message } => {
                        return Err(JoinFailure { code, message })
                    }
                    Event::Joined { .. } => {
                        seen.push(e);
                        return Ok((s, seen));
                    }
                    other => seen.push(other),
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        Err(JoinFailure {
            code: 0,
            message: format!("timed out after {timeout_ms} ms"),
        })
    }

    // ---- lifecycle -------------------------------------------------------------------------

    fn next_random(&mut self) -> u64 {
        // xorshift64*
        let mut x = self.rng;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.rng = x;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    fn new_ctx(&mut self, reconnect: bool) -> *mut c_void {
        self.gen += 1;
        let ctx = Box::new(Ctx {
            sink: self.sink,
            gen: self.gen,
            room: Cell::new(std::ptr::null_mut()),
            reconnect,
        });
        let ptr = &*ctx as *const Ctx as *mut c_void;
        self.pending_ctx.insert(self.gen, ctx);
        ptr
    }

    fn select_endpoint(&mut self) {
        self.phase = Phase::Selecting;
        let urls: Vec<CString> = self
            .opts
            .endpoints
            .iter()
            .filter_map(|u| CString::new(u.as_str()).ok())
            .collect();
        let ptrs: Vec<*const c_char> = urls.iter().map(|c| c.as_ptr()).collect();
        let secure = self
            .opts
            .endpoints
            .first()
            .is_some_and(|u| u.starts_with("wss") || u.starts_with("https"));
        let options = ffi::colyseus_latency_options_t {
            ping_count: 2,
            timeout_ms: 1500,
            use_secure: secure,
            tls_skip_verification: false,
            ca_pem_data: std::ptr::null(),
            ca_pem_len: 0,
        };
        let ud = self.new_ctx(false);
        // SAFETY: the endpoint array is borrowed only for the call; ud outlives the callback.
        unsafe { ffi::colyseus_select_by_latency(ptrs.as_ptr(), ptrs.len(), &options, cb_latency, ud) };
    }

    fn use_endpoint(&mut self, url: String) {
        let Some((address, port, secure)) = parse_endpoint(&url) else {
            return self.fail_join(
                0,
                format!("unsupported relay URL `{url}` (expected ws://host[:port] or wss://host[:port])"),
            );
        };
        self.relay_port = port.parse::<u16>().unwrap_or(0);
        let (Ok(address), Ok(port)) = (CString::new(address), CString::new(port)) else {
            return self.fail_join(0, format!("invalid relay URL `{url}`"));
        };
        // SAFETY: plain constructor calls; the settings outlive the client and every room.
        unsafe {
            self.settings = ffi::colyseus_settings_create();
            ffi::colyseus_settings_set_address(self.settings, address.as_ptr());
            ffi::colyseus_settings_set_port(self.settings, port.as_ptr());
            ffi::colyseus_settings_set_secure(self.settings, secure);
            self.client = ffi::colyseus_client_create(self.settings);
        }
        self.endpoint = Some(url);
        let target = self.opts.room.clone();
        self.start_join(target);
    }

    fn join_options(&mut self) -> Result<CString, String> {
        let token = (self.identity)()?;
        let mut o = Map::new();
        o.insert("gameId".into(), Value::from(self.opts.game_id.clone()));
        o.insert("embedToken".into(), Value::from(token));
        if let Some(name) = &self.opts.name {
            o.insert("name".into(), Value::from(name.clone()));
        }
        for (k, v) in &self.opts.options {
            o.insert(k.clone(), v.clone());
        }
        // Last, so nothing can misreport it (§2).
        o.insert("protocol".into(), Value::from(PROTOCOL_VERSION));
        CString::new(Value::Object(o).to_string()).map_err(|_| "join options contain a NUL byte".to_string())
    }

    fn start_join(&mut self, target: RoomTarget) {
        let options = match self.join_options() {
            Ok(o) => o,
            Err(e) => return self.fail_join(join_error::AUTH_REQUIRED, format!("identity provider failed: {e}")),
        };
        let kind = match target {
            RoomTarget::Queue => RoomKind::Queue,
            RoomTarget::Play => RoomKind::Play,
            _ => RoomKind::Match,
        };
        let ud = self.new_ctx(kind != RoomKind::Queue);
        self.room_kind = kind;
        self.phase = Phase::Connecting;
        self.connect_started = local_now_ms();
        // SAFETY: client is live; strings live for the call (the core copies them); ud outlives callbacks.
        unsafe {
            match &target {
                RoomTarget::Play => ffi::colyseus_client_join_or_create(
                    self.client,
                    c"play".as_ptr(),
                    options.as_ptr(),
                    cb_room,
                    cb_join_error,
                    ud,
                ),
                RoomTarget::Queue => ffi::colyseus_client_join_or_create(
                    self.client,
                    c"queue".as_ptr(),
                    options.as_ptr(),
                    cb_room,
                    cb_join_error,
                    ud,
                ),
                RoomTarget::CreatePrivate => ffi::colyseus_client_create_room(
                    self.client,
                    c"match".as_ptr(),
                    options.as_ptr(),
                    cb_room,
                    cb_join_error,
                    ud,
                ),
                RoomTarget::JoinById(code) => {
                    let Ok(code) = CString::new(code.as_str()) else {
                        return self.fail_join(0, "invite code contains a NUL byte".into());
                    };
                    ffi::colyseus_client_join_by_id(
                        self.client,
                        code.as_ptr(),
                        options.as_ptr(),
                        cb_room,
                        cb_join_error,
                        ud,
                    )
                }
            }
        }
    }

    fn consume_seat(&mut self, reservation: &Value) {
        let Ok(json) = CString::new(reservation.to_string()) else {
            return;
        };
        let ud = self.new_ctx(true);
        self.room_kind = RoomKind::Match;
        self.phase = Phase::Connecting;
        self.connect_started = local_now_ms();
        // SAFETY: as in start_join.
        unsafe {
            ffi::colyseus_client_consume_seat_reservation_json(self.client, json.as_ptr(), cb_room, cb_join_error, ud)
        };
    }

    fn fail_join(&mut self, code: i32, message: String) {
        self.phase = Phase::Closed;
        self.events.push(Event::JoinFailed { code, message });
    }

    /// Leave the room with consent. [`Event::Disconnected`] (code 4000) follows.
    pub fn leave(&mut self) {
        self.leaving = true;
        if let Some(slot) = &self.current {
            // SAFETY: live room, polling thread.
            unsafe { ffi::colyseus_room_leave(slot.room, true) };
        } else if self.phase != Phase::Closed {
            self.close(close_code::CONSENTED, "left".into());
        }
    }

    /// Whether the session is over (terminal close, refused join, or left).
    pub fn is_closed(&self) -> bool {
        self.phase == Phase::Closed
    }

    fn retire_current(&mut self, consented_leave: bool) {
        if let Some(slot) = self.current.take() {
            if consented_leave {
                // SAFETY: live room; its on_leave arrives later and frees it.
                unsafe { ffi::colyseus_room_leave(slot.room, true) };
            }
            self.retired.push(slot);
        }
        self.heartbeat = Heartbeat {
            synced: self.heartbeat.synced,
            ..Heartbeat::default()
        };
    }

    /// Drop the current room without consent. Used only on a room whose socket is not open:
    /// `colyseus_room_leave(room, false)` then sends nothing, cancels the core's retries and reports
    /// on_leave at once, and the slot is freed when that arrives.
    fn abandon_current(&mut self) {
        if let Some(slot) = &self.current {
            // SAFETY: live room, polling thread, outside every callback.
            unsafe { ffi::colyseus_room_leave(slot.room, false) };
        }
        self.retire_current(false);
    }

    /// Set TCP_NODELAY on the core's relay sockets (nodelay.rs); say so when none was found.
    fn apply_nodelay(&mut self) {
        if self.relay_port == 0 {
            return;
        }
        if nodelay::apply(self.relay_port) == Some(0) {
            self.events.push(Event::Warning {
                message: format!(
                    "found no relay socket (port {}) to set TCP_NODELAY on: state may arrive in bursts",
                    self.relay_port
                ),
            });
        }
    }

    fn free_retired(&mut self, gen: u32) {
        if let Some(i) = self.retired.iter().position(|s| s.ctx.gen == gen) {
            let slot = self.retired.swap_remove(i);
            // SAFETY: we are outside every callback; the room's ctx is dropped right after.
            unsafe { ffi::colyseus_room_free(slot.room) };
        }
    }

    fn close(&mut self, code: i32, reason: String) {
        if self.phase == Phase::Closed {
            return;
        }
        self.phase = Phase::Closed;
        let pending = std::mem::take(&mut self.pending);
        for (request_id, p) in pending {
            self.events.push(Event::ControlResult(ControlResult {
                request_id,
                operation: p.operation.into(),
                id: p.id,
                accepted: false,
                owner: None,
                sequence: 0.0,
                reason: "disconnected".into(),
                retry_after_ms: None,
            }));
        }
        self.events.push(Event::Disconnected { code, reason });
    }

    // ---- poll ------------------------------------------------------------------------------

    /// Drive the network, process everything that arrived, run the timers (publish tick,
    /// heartbeat, control timeouts) and refresh the smoothed views. Call once per frame, at
    /// least ~20 times a second. Returns the events since the last call.
    pub fn poll(&mut self) -> Vec<Event> {
        poll_network();
        // SAFETY: sink is live for the session's lifetime; nothing else borrows it now.
        let raw = std::mem::take(unsafe { &mut (*self.sink).borrow_mut().raw });
        for (gen, at, r) in raw {
            self.process(gen, at, r);
        }
        let now = local_now_ms();
        self.run_timers(now);
        self.refresh_views(now);
        std::mem::take(&mut self.events)
    }

    fn process(&mut self, gen: u32, at: f64, raw: Raw) {
        let current_gen = self.current.as_ref().map(|s| s.ctx.gen);
        if let Raw::Room(room) = raw {
            if let Some(ctx) = self.pending_ctx.remove(&gen) {
                let slot = RoomSlot { room, ctx };
                if gen == self.gen && self.phase != Phase::Closed {
                    self.current = Some(slot);
                } else {
                    // SAFETY: a stale attempt's room: leave it; freed on its on_leave.
                    unsafe { ffi::colyseus_room_leave(room, true) };
                    self.retired.push(slot);
                }
            }
            return;
        }
        if let Raw::Latency(best) = raw {
            self.pending_ctx.remove(&gen);
            let url = best.unwrap_or_else(|| self.opts.endpoints[0].clone());
            return self.use_endpoint(url);
        }
        if let Raw::JoinError(code, message) = raw {
            let ours = gen == self.gen;
            self.pending_ctx.remove(&gen);
            if current_gen == Some(gen) {
                self.retire_current(false);
            }
            self.free_retired(gen);
            if ours && self.takeover.is_some() {
                self.takeover_attempt_failed(code, message);
            } else if ours {
                self.on_join_error(code, message);
            }
            return;
        }
        if current_gen != Some(gen) {
            if let Raw::Leave(..) = raw {
                self.free_retired(gen);
            }
            return;
        }
        let taking_over = self.takeover.is_some() && matches!(self.phase, Phase::Reconnecting { .. });
        match raw {
            Raw::Joined if taking_over => self.on_takeover_joined(at),
            Raw::Leave(_, reason) | Raw::RoomError(_, reason) if taking_over => {
                self.retire_current(false);
                self.free_retired(gen);
                self.takeover_attempt_failed(0, reason);
            }
            Raw::Joined => self.on_joined(),
            Raw::State(snap) => self.on_state(*snap, at),
            Raw::Message(kind, data) => self.on_message(kind, data),
            Raw::Drop(code) => {
                if self.room_kind != RoomKind::Queue && !self.leaving {
                    if !matches!(self.phase, Phase::Reconnecting { .. }) {
                        self.phase = Phase::Reconnecting { since: at };
                        self.core_watch = None;
                    }
                    self.events.push(Event::Reconnecting { code });
                }
            }
            Raw::Reconnect => {
                if let Phase::Reconnecting { since } = self.phase {
                    // §8 step 2, done before the snapshot lands so its samples seed the rebased history.
                    if at - since > ip::REBASE_AFTER_GAP_MS {
                        self.interp.rebase_all();
                    }
                }
                if self.leaving {
                    // A room still held: leave it. None means the slot was already cleared, so there is
                    // nothing to leave (and no panic inside the FFI pump).
                    if let Some(room) = self.current.as_ref().map(|s| s.room) {
                        // SAFETY: live room.
                        unsafe { ffi::colyseus_room_leave(room, true) };
                    }
                    return;
                }
                self.phase = Phase::Resyncing {
                    deadline: at + reconnection::FIRST_STATE_TIMEOUT_MS,
                };
            }
            Raw::Leave(code, reason) => self.on_leave(gen, code, reason),
            Raw::RoomError(code, message) => {
                if self.phase == Phase::Connecting {
                    self.retire_current(false);
                    self.free_retired(gen);
                    self.on_join_error(code, message);
                } else {
                    self.events.push(Event::Warning {
                        message: format!("room error {code}: {message}"),
                    });
                }
            }
            Raw::Room(_) | Raw::Latency(_) | Raw::JoinError(..) => {}
        }
    }

    fn reconnect_watchdog(&mut self, now: f64, since: f64) {
        if self.leaving {
            return;
        }
        if now - since > RECONNECT_GIVE_UP_MS {
            self.takeover = None;
            self.retire_current(true);
            return self.close(close_code::FAILED_TO_RECONNECT, "reconnection failed".into());
        }
        if self.takeover.is_none() {
            let Some(slot) = &self.current else { return };
            let room = slot.room;
            // SAFETY: live room, polling thread, outside every callback.
            let Some(probe) = (unsafe { room_probe(room) }) else {
                return self.warn_probe_unavailable();
            };
            if !probe.reconnecting {
                return;
            }
            let fresh = match &self.core_watch {
                Some(w) => w.retry_count != probe.retry_count,
                None => true,
            };
            if fresh {
                self.core_watch = Some(CoreWatch {
                    retry_count: probe.retry_count,
                    // The first attempt was armed by the drop itself.
                    scheduled_at: if self.core_watch.is_none() { since } else { now },
                });
            }
            let Some(w) = &self.core_watch else { return };
            let attempt_started = w.scheduled_at + core_backoff_ms(w.retry_count);
            if probe.open || now - attempt_started < STALL_TAKEOVER_MS {
                return;
            }
            // SAFETY: live room.
            let token = unsafe { lossy(ffi::colyseus_room_get_reconnection_token(room)) };
            if token.is_empty() {
                return;
            }
            self.events.push(Event::Warning {
                message: format!(
                    "reconnect attempt {} has had no open socket for {:.0} ms (a native-core handshake stall); re-taking the held seat",
                    w.retry_count,
                    now - attempt_started
                ),
            });
            self.abandon_current();
            self.takeover = Some(Takeover {
                token,
                attempt: 0,
                attempt_started: None,
                next_at: now,
            });
        }
        let Some(t) = &self.takeover else { return };
        match t.attempt_started {
            Some(started) if now - started > TAKEOVER_ATTEMPT_TIMEOUT_MS => {
                // Only this attempt's own room, and only while its socket has not opened. With no
                // room yet the matchmake request is still out; the give-up above bounds the wait.
                let gen = self.gen;
                let Some(room) = self.current.as_ref().filter(|s| s.ctx.gen == gen).map(|s| s.room) else {
                    return;
                };
                // SAFETY: live room, polling thread, outside every callback.
                match unsafe { room_probe(room) } {
                    Some(p) if !p.open => {}
                    _ => return,
                }
                self.abandon_current();
                self.takeover_attempt_failed(0, "reconnect attempt timed out".into());
            }
            None if now >= t.next_at => {
                let Ok(token) = CString::new(t.token.as_str()) else {
                    return;
                };
                let ud = self.new_ctx(true);
                // SAFETY: client is live; the token is copied; ud outlives the callbacks.
                unsafe { ffi::colyseus_client_reconnect(self.client, token.as_ptr(), cb_room, cb_join_error, ud) };
                if let Some(t) = self.takeover.as_mut() {
                    t.attempt += 1;
                    t.attempt_started = Some(now);
                }
            }
            _ => {}
        }
    }

    fn warn_probe_unavailable(&mut self) {
        if !self.probe_warned {
            self.probe_warned = true;
            self.events.push(Event::Warning {
                message: "the linked Colyseus core is not v0.18.10's layout: a stalled reconnect cannot be detected and ends at the 27 s give-up".into(),
            });
        }
    }

    fn takeover_attempt_failed(&mut self, code: i32, message: String) {
        if code >= 4000 {
            // The relay no longer holds the seat.
            self.takeover = None;
            return self.close(close_code::FAILED_TO_RECONNECT, message);
        }
        if let Some(t) = self.takeover.as_mut() {
            t.attempt_started = None;
            t.next_at = local_now_ms() + (250.0 * f64::from(1u32 << t.attempt.min(3))).min(2000.0);
        }
    }

    fn on_takeover_joined(&mut self, at: f64) {
        let Some(slot) = &self.current else { return };
        // SAFETY: live room.
        let (sid, rid) = unsafe {
            (
                lossy(ffi::colyseus_room_get_session_id(slot.room)),
                lossy(ffi::colyseus_room_get_id(slot.room)),
            )
        };
        if sid != self.session_id {
            self.events.push(Event::Warning {
                message: format!("reconnected into session {sid}, expected {}", self.session_id),
            });
            self.session_id = sid;
        }
        self.room_id = rid;
        self.takeover = None;
        if let Phase::Reconnecting { since } = self.phase {
            if at - since > ip::REBASE_AFTER_GAP_MS {
                self.interp.rebase_all();
            }
        }
        self.phase = Phase::Resyncing {
            deadline: at + reconnection::FIRST_STATE_TIMEOUT_MS,
        };
    }

    fn on_join_error(&mut self, code: i32, message: String) {
        if code == join_error::PROTOCOL_UNSUPPORTED {
            self.events.push(Event::Warning {
                message: format!(
                    "the relay refused protocol {PROTOCOL_VERSION} (426): this build of genex-multiplayer is too old for it; update and rebuild"
                ),
            });
        }
        // A queue search that failed for a transient reason searches again; a refusal never does.
        let refusal = (400..500).contains(&code);
        if self.opts.room == RoomTarget::Queue && !refusal && !self.leaving {
            return self.schedule_search();
        }
        self.fail_join(code, message);
    }

    fn on_joined(&mut self) {
        let Some(slot) = &self.current else { return };
        // SAFETY: live room.
        let (sid, rid) = unsafe {
            (
                lossy(ffi::colyseus_room_get_session_id(slot.room)),
                lossy(ffi::colyseus_room_get_id(slot.room)),
            )
        };
        if self.room_kind == RoomKind::Queue {
            self.phase = Phase::Queued;
            self.search_attempt = 0;
            return;
        }
        self.session_id = sid.clone();
        self.room_id = rid;
        self.phase = Phase::Joined;
        self.joined_once = true;
        self.apply_nodelay();
        self.events.push(Event::Joined { session_id: sid });
        // §12: history after the listener exists.
        let _ = self.send_value(cm::CHAT_HISTORY_REQUEST, &json!({}));
        // Requests made before the join was confirmed.
        self.resend_pending();
        if self.me.is_some() || self.pose_pending.is_some() {
            self.me_pending = Some(local_now_ms());
        }
    }

    fn on_leave(&mut self, gen: u32, code: i32, reason: String) {
        let kind = self.room_kind;
        self.retire_current(false);
        self.free_retired(gen);
        if kind == RoomKind::Queue && !self.leaving && self.phase != Phase::Closed {
            // §9.2 step 3: a dropped search searches again with backoff.
            return self.schedule_search();
        }
        self.close(code, reason);
    }

    fn schedule_search(&mut self) {
        const BACKOFF: [f64; 3] = [1000.0, 2000.0, 4000.0];
        let delay = BACKOFF[self.search_attempt.min(BACKOFF.len() - 1)];
        self.search_attempt += 1;
        self.phase = Phase::Searching {
            at: local_now_ms() + delay,
        };
    }

    // ---- state -----------------------------------------------------------------------------

    fn on_state(&mut self, snap: Snapshot, at: f64) {
        if self.room_kind == RoomKind::Queue {
            return;
        }
        self.apply_snapshot(snap, at);
        if !self.heartbeat.probed {
            self.heartbeat.probed = true;
            // §16.2 Detect: the handshake's INPUT_REFLECTION is parsed by the time state arrives.
            let room = self.current.as_ref().map(|s| s.room).unwrap_or(std::ptr::null_mut());
            // SAFETY: live room; NULL vtable = synthesize from the handshake (NULL when no clock).
            let handle = unsafe { ffi::colyseus_room_input(room, std::ptr::null(), std::ptr::null()) };
            if !handle.is_null() {
                self.heartbeat.handle = Some(handle);
                self.heartbeat.next_at = at;
            }
        }
        if let Phase::Resyncing { .. } = self.phase {
            self.finish_resync();
        }
    }

    /// §8 post-reconnect steps 3–6 (the snapshot diff already reconciled the mirrors).
    fn finish_resync(&mut self) {
        self.phase = Phase::Joined;
        self.apply_nodelay();
        self.resend_pending();
        let _ = self.send_value(cm::CHAT_HISTORY_REQUEST, &json!({}));
        if self.me.is_some() || self.pose_pending.is_some() {
            self.me_pending = Some(local_now_ms());
        }
        self.events.push(Event::Reconnected);
        if self.dropped_offline > 0 {
            self.events.push(Event::Warning {
                message: format!(
                    "{} game event(s)/input(s) were dropped while reconnecting (they are never queued)",
                    self.dropped_offline
                ),
            });
            self.dropped_offline = 0;
        }
    }

    fn apply_snapshot(&mut self, snap: Snapshot, at: f64) {
        let me = self.session_id.clone();

        // players
        let mut seen = HashSet::with_capacity(snap.players.len());
        for (id, p) in snap.players {
            seen.insert(id.clone());
            let joining = !self.players.contains_key(&id);
            let m = self.players.entry(id.clone()).or_default();
            let data_changed = joining || p.data != m.raw.data;
            let epoch_changed = !joining && p.epoch != m.raw.epoch;
            let pose_changed = p.pose_t != m.raw.pose_t;
            let mut send_time = None;
            if data_changed {
                let (data, t) = parse_player_data(&p.data);
                m.data = data;
                send_time = t;
            }
            let remote = id != me;
            if remote {
                if p.posed && !m.posed_stream {
                    m.posed_stream = true;
                    self.interp.set_posed(&id, true);
                }
                if epoch_changed {
                    self.interp.reset_epoch(&id);
                }
                if p.posed {
                    if p.pose_t != 0.0 && (pose_changed || epoch_changed) {
                        self.interp
                            .push(&id, &id, p.pose_t, pose::pose_map(p.pose, &p.anim), at);
                    }
                } else if let Some(t) = send_time.filter(|_| data_changed || epoch_changed) {
                    self.interp.push(&id, &id, t, m.data.clone(), at);
                }
            }
            m.raw = p;
            if joining {
                self.events.push(Event::PlayerJoined { id });
            }
        }
        let gone: Vec<String> = self.players.keys().filter(|k| !seen.contains(*k)).cloned().collect();
        for id in gone {
            self.players.remove(&id);
            self.interp.remove_stream(&id);
            self.interp.remove_sender(&id);
            self.events.push(Event::PlayerLeft { id });
        }

        // objects (§7.3 rules, in order)
        let mut seen = HashSet::with_capacity(snap.objects.len());
        for (id, o) in snap.objects {
            seen.insert(id.clone());
            let stream = format!("obj:{id}");
            let known = self.objects.contains_key(&id);
            let m = self.objects.entry(id.clone()).or_default();
            let seq_changed = known && o.seq != m.raw.seq;
            let epoch_changed = known && o.epoch != m.raw.epoch;
            let t_changed = o.t != m.raw.t;
            if !known || o.d != m.raw.d {
                m.value = parse_json_text(&o.d).unwrap_or(Value::Null);
            }
            let prev_owner = std::mem::take(&mut m.owner);
            let owner_changed = !known || o.owner != m.raw.owner;
            let mine_now = !o.owner.is_empty() && o.owner == me;
            // 1. Ownership moved: soft handoff. Leaving us, the bridge starts from our own last publish.
            if seq_changed && !mine_now {
                if prev_owner == me && !me.is_empty() {
                    if let Some(Value::Object(local)) = m.local.clone().or_else(|| Some(m.value.clone())) {
                        self.interp.hold(&stream, local, at);
                    }
                }
                self.interp.soft_handoff(&stream);
            }
            if !mine_now {
                m.local = None;
                m.pending = None;
            }
            // 2. Hard reset.
            if epoch_changed {
                self.interp.reset_epoch(&stream);
            }
            // 3. A sample from the current owner (never fed to our own objects).
            if !mine_now && o.t != 0.0 && (t_changed || epoch_changed) {
                if let Value::Object(state) = &m.value {
                    self.interp.push(&stream, &o.owner, o.t, state.clone(), at);
                }
            }
            // 4. t == 0: the resting pose; the view falls back to the raw value.
            m.owner = o.owner.clone();
            let owner = (!o.owner.is_empty()).then(|| o.owner.clone());
            m.raw = o;
            if owner_changed {
                self.events.push(Event::ObjectChanged { id, owner });
            }
        }
        let gone: Vec<String> = self.objects.keys().filter(|k| !seen.contains(*k)).cloned().collect();
        for id in gone {
            self.objects.remove(&id);
            self.interp.remove_stream(&format!("obj:{id}"));
            self.events.push(Event::ObjectRemoved { id });
        }

        // host
        if snap.host != self.host {
            self.host = snap.host;
            let host = (!self.host.is_empty()).then(|| self.host.clone());
            self.events.push(Event::HostChanged { host });
        }
        // shared (keys are never removed)
        for (key, text) in snap.shared {
            if self.shared.get(&key) != Some(&text) {
                self.shared.insert(key.clone(), text);
                self.events.push(Event::SharedChanged { key });
            }
        }
        self.match_text = snap.match_text;
        self.clock_origin = snap.clock_origin;
    }

    // ---- messages --------------------------------------------------------------------------

    fn on_message(&mut self, kind: String, data: Value) {
        match kind.as_str() {
            sm::OBJECT_RESULT => self.on_control_result(data),
            sm::INPUT => {
                if self.is_host() {
                    let from = data.get("from").and_then(Value::as_str).unwrap_or_default().to_string();
                    let d = data.get("d").cloned().unwrap_or(Value::Null);
                    self.events.push(Event::Input { from, data: d });
                }
            }
            sm::ROOM_OPEN => {
                let open = data.get("open").and_then(Value::as_bool).unwrap_or(true);
                self.events.push(Event::RoomOpen { open });
            }
            sm::CHAT => {
                if let Ok(line) = serde_json::from_value::<ChatMessage>(data) {
                    self.merge_chat(line);
                }
            }
            sm::CHAT_HISTORY => {
                if let Some(lines) = data.get("messages").and_then(Value::as_array) {
                    for line in lines.clone() {
                        if let Ok(line) = serde_json::from_value::<ChatMessage>(line) {
                            self.merge_chat(line);
                        }
                    }
                }
            }
            sm::RATE_DROP => {
                let dropped = data.get("dropped").and_then(Value::as_f64).unwrap_or(0.0);
                self.events.push(Event::RateDrop { dropped });
            }
            sm::SERVER_RESTART => self.events.push(Event::ServerRestart),
            sm::MATCH_START => {
                let round_id = data.get("roundId").and_then(Value::as_f64).unwrap_or(0.0);
                self.events.push(Event::MatchStart { round_id });
            }
            sm::MATCH_ENDED => self.events.push(Event::MatchEnded { data }),
            sm::MATCH_REQUEUE => {
                let reason = data.get("reason").and_then(Value::as_str).map(str::to_string);
                self.events.push(Event::MatchRequeue { reason });
                // §9.2 step 4: leave with consent and search again within 5 s.
                if self.opts.room == RoomTarget::Queue && !self.leaving {
                    self.reset_room_view();
                    self.retire_current(true);
                    self.start_join(RoomTarget::Queue);
                }
            }
            sm::QUEUE => {
                let position = data.get("position").and_then(Value::as_f64).unwrap_or(0.0);
                let size = data.get("size").and_then(Value::as_f64).unwrap_or(0.0);
                self.events.push(Event::Queue { position, size });
            }
            sm::SEAT => {
                if self.room_kind == RoomKind::Queue {
                    if let Some(reservation) = data.get("reservation").cloned() {
                        self.events.push(Event::Seated);
                        self.retire_current(true);
                        self.consume_seat(&reservation);
                    }
                }
            }
            sm::VOICE_ICE | sm::VOICE_SIGNAL | sm::VOICE_REJECTED => {}
            other if protocol::is_reserved_event_type(other) => {}
            _ => self.events.push(Event::Message { kind, data }),
        }
    }

    fn reset_room_view(&mut self) {
        for id in std::mem::take(&mut self.players).into_keys() {
            self.interp.remove_stream(&id);
            self.interp.remove_sender(&id);
            self.events.push(Event::PlayerLeft { id });
        }
        for id in std::mem::take(&mut self.objects).into_keys() {
            self.interp.remove_stream(&format!("obj:{id}"));
            self.events.push(Event::ObjectRemoved { id });
        }
        self.shared.clear();
        if !self.host.is_empty() {
            self.host.clear();
            self.events.push(Event::HostChanged { host: None });
        }
        self.match_text.clear();
    }

    fn merge_chat(&mut self, line: ChatMessage) {
        let id = line.id as i64;
        if let std::collections::btree_map::Entry::Vacant(e) = self.chat.entry(id) {
            e.insert(line.clone());
            self.events.push(Event::Chat(line));
            while self.chat.len() > 200 {
                self.chat.pop_first();
            }
        }
    }

    fn on_control_result(&mut self, data: Value) {
        let Ok(result) = serde_json::from_value::<ControlResult>(data) else {
            return;
        };
        if self.pending.remove(&result.request_id).is_none() {
            return;
        }
        if result.accepted {
            let me = self.session_id.clone();
            match result.operation.as_str() {
                "claim" => {
                    let m = self.objects.entry(result.id.clone()).or_default();
                    if m.owner != me {
                        m.owner = me;
                        self.interp.soft_handoff(&format!("obj:{}", result.id));
                    }
                }
                "release" => {
                    if let Some(m) = self.objects.get_mut(&result.id) {
                        m.owner.clear();
                        m.local = None;
                        m.pending = None;
                    }
                }
                _ => {}
            }
        }
        self.events.push(Event::ControlResult(result));
    }

    // ---- timers ----------------------------------------------------------------------------

    fn run_timers(&mut self, now: f64) {
        match self.phase {
            Phase::Connecting if now - self.connect_started > CONNECT_TIMEOUT_MS => {
                self.retire_current(true);
                self.on_join_error(0, "timed out waiting for the relay handshake".into());
            }
            Phase::Reconnecting { since } => self.reconnect_watchdog(now, since),
            Phase::Resyncing { deadline } if now >= deadline => self.finish_resync(),
            Phase::Searching { at } if now >= at => self.start_join(RoomTarget::Queue),
            _ => {}
        }
        // Control request timeouts (§7.2).
        let expired: Vec<String> = self
            .pending
            .iter()
            .filter(|(_, p)| now >= p.deadline)
            .map(|(k, _)| k.clone())
            .collect();
        for request_id in expired {
            if let Some(p) = self.pending.remove(&request_id) {
                self.events.push(Event::ControlResult(ControlResult {
                    request_id,
                    operation: p.operation.into(),
                    id: p.id,
                    accepted: false,
                    owner: None,
                    sequence: 0.0,
                    reason: "timeout".into(),
                    retry_after_ms: None,
                }));
            }
        }
        if !self.socket_open() || self.phase != Phase::Joined {
            return;
        }
        // §16.2 heartbeat, on wall-clock deadlines (never once per rendered frame).
        if let Some(handle) = self.heartbeat.handle {
            if now >= self.heartbeat.next_at {
                // SAFETY: the handle lives as long as its room; sent only on an open socket.
                unsafe { ffi::colyseus_input_handle_send(handle) };
                let base = 1000.0 / clock_sync::HEARTBEAT_HZ;
                let dither = (self.next_random() as f64 / u64::MAX as f64) * 2.0 - 1.0;
                let next = (base * (1.0 + dither * clock_sync::HEARTBEAT_DITHER)).clamp(
                    1000.0 / clock_sync::MAX_HEARTBEAT_HZ,
                    1000.0 / clock_sync::MIN_HEARTBEAT_HZ,
                );
                self.heartbeat.next_at = now + next;
                // SAFETY: as above.
                if unsafe { ffi::colyseus_input_handle_last_processed(handle) } >= clock_sync::WARMUP_ACKS {
                    self.heartbeat.synced = true;
                }
            }
        }
        // Publishes the rate limit coalesced, stamped with the time the game set them.
        let interval = self.publish_interval();
        if let Some(t) = self.me_pending {
            if now - self.last_publish >= interval {
                self.publish_me(t);
            }
        }
        let due: Vec<(String, f64)> = self
            .objects
            .iter()
            .filter_map(|(k, m)| {
                m.pending
                    .filter(|_| now - m.last_sent >= interval)
                    .map(|t| (k.clone(), t))
            })
            .collect();
        for (id, t) in due {
            self.publish_object(&id, t);
        }
    }

    fn publish_interval(&self) -> f64 {
        1000.0 / self.opts.publish_hz
    }

    /// Send your pose (when posing) and `data`, stamped `t`: the time the game set them (§6.1).
    fn publish_me(&mut self, t: f64) {
        self.last_publish = local_now_ms();
        self.me_pending = None;
        if let Some(pose) = self.pose_pending.take() {
            let (pose, memory) = pose::derive_velocity(&pose, t, self.pose_memory.as_ref());
            self.pose_memory = Some(memory);
            let _ = self.send_pose(cm::POSE, &pose, t);
        }
        let Some(me) = self.me.clone() else { return };
        let data = self.data_part(&me);
        let text = data.to_string();
        // A posed player sends `data` only when it changes, plus a slow keepalive (§6.6).
        if self.opts.pose && text == self.last_data_text && t - self.last_data_sent < 2000.0 {
            return;
        }
        if let Ok(stamped) = stamp_state(&data, t) {
            if self.send_value(cm::STATE, &Value::String(stamped.text)).is_ok() {
                self.last_data_text = text;
                self.last_data_sent = t;
            }
        }
    }

    /// Publish now when the rate limit allows, else coalesce (the latest state wins).
    fn request_publish_me(&mut self) {
        let now = local_now_ms();
        if now - self.last_publish >= self.publish_interval() && self.socket_open() {
            self.publish_me(now);
        } else {
            self.me_pending = Some(now);
        }
    }

    fn publish_object(&mut self, id: &str, t: f64) {
        let me = self.session_id.clone();
        let Some(m) = self.objects.get_mut(id) else { return };
        m.pending = None;
        m.last_sent = local_now_ms();
        if m.owner != me {
            return;
        }
        if let Some(d) = m.local.clone() {
            let _ = self.send_value(cm::OBJECT, &json!({ "id": id, "d": d, "t": t }));
        }
    }

    // ---- views -----------------------------------------------------------------------------

    fn refresh_views(&mut self, now: f64) {
        let me = self.session_id.clone();
        let mut players = Vec::with_capacity(self.players.len());
        for (id, m) in &self.players {
            let is_me = *id == me;
            let posed = m.raw.posed;
            let mut raw = m.data.clone();
            if posed {
                let pose = pose::pose_map(m.raw.pose, &m.raw.anim);
                raw.extend(pose);
            }
            let raw = Value::Object(raw);
            let state = if is_me {
                self.me.clone().unwrap_or_else(|| raw.clone())
            } else {
                match self.interp.sample(id, now) {
                    Some(s) if posed => {
                        let mut merged = m.data.clone();
                        merged.extend(s);
                        Value::Object(merged)
                    }
                    Some(s) => Value::Object(s),
                    None => raw.clone(),
                }
            };
            players.push(PlayerView {
                id: id.clone(),
                name: m.raw.name.clone(),
                uid: m.raw.uid.clone(),
                team: m.raw.team as i32,
                connected: m.raw.connected,
                avatar_url: m.raw.avatar_url.clone(),
                state,
                state_raw: raw,
                epoch: m.raw.epoch,
                is_me,
                posed,
            });
        }
        let mut objects = Vec::with_capacity(self.objects.len());
        for (id, m) in &self.objects {
            let mine = !me.is_empty() && m.owner == me;
            let state = if mine {
                m.local.clone().unwrap_or_else(|| m.value.clone())
            } else {
                self.interp
                    .sample(&format!("obj:{id}"), now)
                    .map(Value::Object)
                    .unwrap_or_else(|| m.value.clone())
            };
            objects.push(ObjectView {
                id: id.clone(),
                owner: (!m.owner.is_empty()).then(|| m.owner.clone()),
                seq: m.raw.seq,
                epoch: m.raw.epoch,
                state,
                state_raw: m.value.clone(),
            });
        }
        self.player_views = players;
        self.object_views = objects;
    }

    // ---- sending ---------------------------------------------------------------------------

    fn socket_open(&self) -> bool {
        // SAFETY: live room pointer or none.
        self.current
            .as_ref()
            .is_some_and(|s| unsafe { ffi::colyseus_room_is_connected(s.room) })
    }

    fn send_value(&mut self, kind: &str, value: &Value) -> Result<(), Error> {
        let bytes = msgpack::encode(value)?;
        if !self.socket_open() || self.room_kind == RoomKind::Queue {
            return Err(Error::NotConnected);
        }
        let room = self.current.as_ref().map(|s| s.room).unwrap_or(std::ptr::null_mut());
        let kind = CString::new(kind).map_err(|_| Error::InvalidPayload("type has a NUL byte".into()))?;
        // SAFETY: open room; the core copies the bytes before returning.
        unsafe { ffi::colyseus_room_send_encoded(room, kind.as_ptr(), bytes.as_ptr(), bytes.len()) };
        Ok(())
    }

    fn data_part(&self, state: &Value) -> Value {
        if !self.opts.pose {
            return state.clone();
        }
        match state {
            Value::Object(map) => Value::Object(
                map.iter()
                    .filter(|(k, _)| !POSE_KEYS.contains(&k.as_str()))
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect(),
            ),
            other => other.clone(),
        }
    }

    fn pose_part(state: &Value) -> Option<PoseFields> {
        let map = state.as_object()?;
        let n = |k: &str| {
            map.get(k)
                .and_then(Value::as_f64)
                .filter(|v| pose::valid_pose_number(*v))
        };
        let fields = PoseFields {
            x: n("x"),
            y: n("y"),
            z: n("z"),
            yaw: n("yaw"),
            vx: n("vx"),
            vy: n("vy"),
            vz: n("vz"),
            anim: map.get("anim").and_then(Value::as_str).map(str::to_string),
        };
        (fields != PoseFields::default()).then_some(fields)
    }

    fn send_pose(&mut self, kind: &str, pose: &PoseFields, t: f64) -> Result<(), Error> {
        if !pose.is_valid() {
            return Err(Error::InvalidPayload(
                "pose values must be finite, |v| ≤ 1e9, anim ≤ 64 chars".into(),
            ));
        }
        let mut v = serde_json::to_value(pose).map_err(|e| Error::InvalidPayload(e.to_string()))?;
        v["t"] = Value::from(t);
        self.send_value(kind, &v)
    }

    /// Set your own player state (a JSON object), stamped with `__t` and sent now. Call it from
    /// your fixed 10–20 Hz network tick (§6.1); calls faster than `publish_hz` are coalesced (the
    /// latest wins, stamped when you set it). With `ConnectOptions::pose`, the pose keys
    /// (`x y z yaw vx vy vz anim`) go out as the typed pose and everything else as `data`.
    pub fn set_me(&mut self, state: Value) -> Result<(), Error> {
        if !state.is_object() {
            return Err(Error::State(crate::stamp::StateError::NotAnObject));
        }
        if state.get(protocol::SEND_TIME_KEY).is_some() {
            self.events.push(Event::Warning {
                message: "`__t` is reserved for the send clock; it is overwritten".into(),
            });
        }
        stamp_state(&self.data_part(&state), 1.0)?;
        if self.opts.pose {
            if let Some(p) = Self::pose_part(&state) {
                self.pose_pending = Some(p);
            }
        }
        self.me = Some(state);
        self.request_publish_me();
        Ok(())
    }

    /// Set your state across a deliberate discontinuity (teleport, respawn): sent now as
    /// `__state:snap` (and `__pose:snap` when posing), so receivers drop interpolation history.
    pub fn snap_me(&mut self, state: Value) -> Result<(), Error> {
        let now = local_now_ms();
        let data = self.data_part(&state);
        let stamped = stamp_state(&data, now)?;
        if self.opts.pose {
            if let Some(p) = Self::pose_part(&state) {
                let (p, memory) = pose::derive_velocity(&p, now, None);
                self.pose_memory = Some(memory);
                self.pose_pending = None;
                self.send_pose(cm::POSE_SNAP, &p, now)?;
            }
        }
        self.send_value(cm::STATE_SNAP, &Value::String(stamped.text))?;
        self.last_data_text = data.to_string();
        self.last_data_sent = now;
        self.me = Some(state);
        self.me_pending = None;
        self.last_publish = now;
        Ok(())
    }

    /// Publish the typed pose directly (§6.6; needs `ConnectOptions::pose`), rate-limited like `set_me`.
    pub fn set_pose(&mut self, pose: PoseFields) -> Result<(), Error> {
        if !self.opts.pose {
            return Err(Error::InvalidPayload(
                "typed pose is off: set ConnectOptions::pose".into(),
            ));
        }
        if !pose.is_valid() {
            return Err(Error::InvalidPayload(
                "pose values must be finite, |v| ≤ 1e9, anim ≤ 64 chars".into(),
            ));
        }
        self.pose_pending = Some(pose);
        self.request_publish_me();
        Ok(())
    }

    /// Write a room-wide fact (§6.2). `value` is any JSON (write `null` to "delete").
    pub fn set_shared(&mut self, key: &str, value: &Value) -> Result<(), Error> {
        let units = key.encode_utf16().count();
        if units == 0 || units > limits::MAX_SHARED_KEY_CHARS || key.starts_with(protocol::RESERVED_SHARED_PREFIX) {
            return Err(Error::InvalidPayload(format!(
                "shared key `{key}`: 1..=256 chars, no `__` prefix"
            )));
        }
        let text = value.to_string();
        if text.len() > limits::MAX_SHARED_VALUE_BYTES {
            return Err(Error::InvalidPayload("shared value over 64 KiB".into()));
        }
        self.send_value(cm::SHARED, &json!({ "key": key, "value": text }))
    }

    /// The shared map, parsed.
    pub fn shared(&self) -> BTreeMap<String, Value> {
        self.shared
            .iter()
            .map(|(k, v)| (k.clone(), parse_json_text(v).unwrap_or(Value::Null)))
            .collect()
    }

    /// One shared value, parsed.
    pub fn shared_get(&self, key: &str) -> Option<Value> {
        self.shared.get(key).and_then(|t| parse_json_text(t))
    }

    /// Send a game event to every other client (§5.4). Not queued while disconnected.
    pub fn send(&mut self, kind: &str, data: &Value) -> Result<(), Error> {
        if !protocol::is_sendable_event_type(kind) {
            return Err(Error::ReservedType(kind.into()));
        }
        if data.to_string().len() > limits::MAX_EVENT_BYTES {
            return Err(Error::InvalidPayload("event payload over 16 KiB".into()));
        }
        self.send_counted(kind, data)
    }

    /// Game events of every type arrive as [`Event::Message`] on native; this exists for parity
    /// with the web session, where the browser SDK delivers only subscribed types.
    pub fn listen(&mut self, _kind: &str) {}

    /// Send an input to the current host (§6.4). Dropped when there is no host.
    pub fn send_input(&mut self, data: &Value) -> Result<(), Error> {
        if data.to_string().len() > limits::MAX_EVENT_BYTES {
            return Err(Error::InvalidPayload("input payload over 16 KiB".into()));
        }
        self.send_counted(cm::INPUT, data)
    }

    fn send_counted(&mut self, kind: &str, data: &Value) -> Result<(), Error> {
        let r = self.send_value(kind, data);
        if r == Err(Error::NotConnected) && self.joined_once {
            self.dropped_offline += 1;
        }
        r
    }

    /// Host only: close the room to (or reopen it for) new matchmaking placements (§6.5).
    pub fn set_room_open(&mut self, open: bool) -> Result<(), Error> {
        if !self.is_host() {
            return Err(Error::InvalidPayload("only the host may open or close the room".into()));
        }
        self.send_value(cm::ROOM_OPEN, &json!({ "open": open }))
    }

    /// Send a chat line (§12). It is shown when the relay echoes it back as [`Event::Chat`].
    pub fn chat_send(&mut self, text: &str) -> Result<(), Error> {
        self.send_value(cm::CHAT, &json!({ "text": text }))
    }

    /// Chat lines received so far, ascending by id, de-duplicated.
    pub fn chat_messages(&self) -> Vec<ChatMessage> {
        self.chat.values().cloned().collect()
    }

    // ---- objects ---------------------------------------------------------------------------

    fn control(
        &mut self,
        message: &'static str,
        operation: &'static str,
        id: &str,
        host: bool,
    ) -> Result<String, Error> {
        let units = id.encode_utf16().count();
        if units == 0 || units > limits::MAX_OBJECT_ID_CHARS {
            return Err(Error::InvalidPayload("object id must be 1..=128 chars".into()));
        }
        self.request_counter += 1;
        let request_id = format!("{}-{}", self.request_prefix, self.request_counter);
        let mut payload = json!({ "id": id, "requestId": request_id });
        if host {
            payload["authority"] = Value::from("host");
        }
        let deadline = local_now_ms() + self.opts.control_timeout_ms;
        self.pending.insert(
            request_id.clone(),
            PendingControl {
                payload: payload.clone(),
                message,
                operation,
                id: id.into(),
                deadline,
            },
        );
        if self.phase == Phase::Joined {
            let _ = self.send_value(message, &payload);
        }
        Ok(request_id)
    }

    fn resend_pending(&mut self) {
        let msgs: Vec<(&'static str, Value)> = self.pending.values().map(|p| (p.message, p.payload.clone())).collect();
        for (message, payload) in msgs {
            let _ = self.send_value(message, &payload);
        }
    }

    /// Ask for ownership of object `id` (created on first claim). Returns the request id; the
    /// answer arrives as [`Event::ControlResult`].
    pub fn claim(&mut self, id: &str) -> Result<String, Error> {
        self.control(cm::CLAIM, "claim", id, false)
    }

    /// Host-authority claim: displaces an owner inside its minimum hold (host only).
    pub fn claim_as_host(&mut self, id: &str) -> Result<String, Error> {
        self.control(cm::CLAIM, "claim", id, true)
    }

    pub fn release(&mut self, id: &str) -> Result<String, Error> {
        self.control(cm::RELEASE, "release", id, false)
    }

    pub fn destroy(&mut self, id: &str) -> Result<String, Error> {
        self.control(cm::DESTROY, "remove", id, false)
    }

    /// Whether this session owns object `id` (as far as it knows).
    pub fn owns(&self, id: &str) -> bool {
        !self.session_id.is_empty() && self.objects.get(id).is_some_and(|m| m.owner == self.session_id)
    }

    /// Publish an owned object's state (a JSON object), stamped and sent now; rate-limited per
    /// object like `set_me`. Idle objects: a keepalive of 2 Hz or less, never every frame (§5.1).
    pub fn set_object(&mut self, id: &str, state: Value) -> Result<(), Error> {
        self.check_object_write(id, &state)?;
        let now = local_now_ms();
        let interval = self.publish_interval();
        let m = self.objects.get_mut(id).ok_or_else(|| Error::NotOwner(id.into()))?;
        m.local = Some(state);
        if now - m.last_sent >= interval {
            self.publish_object(id, now);
        } else {
            m.pending = Some(now);
        }
        Ok(())
    }

    /// Publish an owned object's state now as `__object:snap` (a hard reset: teleport, respawn).
    pub fn snap_object(&mut self, id: &str, state: Value) -> Result<(), Error> {
        self.check_object_write(id, &state)?;
        let now = local_now_ms();
        self.send_value(cm::OBJECT_SNAP, &json!({ "id": id, "d": state, "t": now }))?;
        if let Some(m) = self.objects.get_mut(id) {
            m.local = Some(state);
            m.pending = None;
            m.last_sent = now;
        }
        Ok(())
    }

    fn check_object_write(&self, id: &str, state: &Value) -> Result<(), Error> {
        if !self.owns(id) {
            return Err(Error::NotOwner(id.into()));
        }
        if !state.is_object() {
            return Err(Error::InvalidPayload("object state must be a JSON object".into()));
        }
        if state.to_string().len() > limits::MAX_OBJECT_STATE_BYTES {
            return Err(Error::InvalidPayload("object state over 64 KiB".into()));
        }
        Ok(())
    }

    // ---- views & getters -------------------------------------------------------------------

    /// Every seated player (yourself included), refreshed by the last `poll()`.
    pub fn players(&self) -> &[PlayerView] {
        &self.player_views
    }

    pub fn player(&self, id: &str) -> Option<&PlayerView> {
        self.player_views.iter().find(|p| p.id == id)
    }

    /// Every shared object, refreshed by the last `poll()`.
    pub fn objects(&self) -> &[ObjectView] {
        &self.object_views
    }

    pub fn object(&self, id: &str) -> Option<&ObjectView> {
        self.object_views.iter().find(|o| o.id == id)
    }

    /// Your session id (empty until joined).
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// The room id (a private lobby's invite code).
    pub fn room_id(&self) -> &str {
        &self.room_id
    }

    /// The relay URL this session uses (fixed for its life, §3.1).
    pub fn endpoint(&self) -> Option<&str> {
        self.endpoint.as_deref()
    }

    /// The elected host's session id.
    pub fn host_id(&self) -> Option<&str> {
        (!self.host.is_empty()).then_some(self.host.as_str())
    }

    /// Whether to run host simulation now (§6.3): the relay says you are host AND the socket is up
    /// AND the post-reconnect sequence has completed.
    pub fn is_host(&self) -> bool {
        self.phase == Phase::Joined && !self.session_id.is_empty() && self.host == self.session_id && self.socket_open()
    }

    /// Joined and not reconnecting.
    pub fn is_connected(&self) -> bool {
        self.phase == Phase::Joined && self.socket_open()
    }

    /// Match rooms: the match state (§9.3), parsed.
    pub fn match_state(&self) -> Option<Value> {
        parse_json_text(&self.match_text)
    }

    /// Match self-reports (§9.3).
    pub fn report_eliminated(&mut self) -> Result<(), Error> {
        self.send_value(cm::MATCH_ELIMINATED, &json!({}))
    }

    pub fn report_finish(&mut self) -> Result<(), Error> {
        self.send_value(cm::MATCH_FINISH, &json!({}))
    }

    pub fn report_score(&mut self, delta: f64) -> Result<(), Error> {
        self.send_value(cm::MATCH_SCORE, &json!({ "delta": delta }))
    }

    // ---- clock (§16) -----------------------------------------------------------------------

    /// Whether the relay publishes its clock (the handshake advertised the heartbeat input).
    pub fn has_server_clock(&self) -> bool {
        self.heartbeat.handle.is_some()
    }

    fn clock(&self) -> *mut ffi::colyseus_room_clock_t {
        match (&self.current, self.heartbeat.handle) {
            // SAFETY: live room.
            (Some(slot), Some(_)) => unsafe { ffi::colyseus_room_get_clock(slot.room) },
            _ => std::ptr::null_mut(),
        }
    }

    /// Estimated relay room clock (ms since room creation), when the relay publishes it.
    pub fn server_now(&self) -> Option<f64> {
        let c = self.clock();
        // SAFETY: clock owned by the live room.
        (!c.is_null()).then(|| unsafe { ffi::colyseus_room_clock_server_now(c) })
    }

    /// Smoothed round-trip time (ms), when the relay publishes its clock. An upper bound (§16.2).
    pub fn rtt(&self) -> Option<f64> {
        let c = self.clock();
        // SAFETY: as above.
        (!c.is_null())
            .then(|| unsafe { ffi::colyseus_room_clock_smoothed_rtt(c) })
            .filter(|r| *r > 0.0)
    }

    /// `serverNow` is synced: 30 heartbeats acked (sticky).
    pub fn clock_synced(&self) -> bool {
        self.heartbeat.synced
    }

    /// `RoomState.clockOrigin`: relay epoch ms at room-clock zero (0 = no clock).
    pub fn clock_origin(&self) -> f64 {
        self.clock_origin
    }

    /// Milliseconds until a relay epoch-ms deadline (`match.startsAt` / `endsBy`), §16.3: on the
    /// server clock once synced, otherwise against the local wall clock.
    pub fn ms_until(&self, epoch_ms: f64) -> f64 {
        if let (true, Some(server_now)) = (self.heartbeat.synced && self.clock_origin > 0.0, self.server_now()) {
            return epoch_ms - self.clock_origin - server_now;
        }
        let wall = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs_f64() * 1000.0)
            .unwrap_or(0.0);
        epoch_ms - wall
    }

    /// Voice is browser-only (WebRTC); native sessions do not offer it.
    pub fn voice_supported(&self) -> bool {
        false
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        // SAFETY: we are not inside any callback (callbacks never call user code).
        unsafe {
            if let Some(slot) = &self.current {
                if self.phase != Phase::Closed {
                    // A consented leave frees the seat at once instead of holding it for the grace.
                    ffi::colyseus_room_leave(slot.room, true);
                }
            }
            for slot in self.current.take().into_iter().chain(self.retired.drain(..)) {
                ffi::colyseus_room_free(slot.room);
            }
        }
        if self.pending_ctx.is_empty() {
            // SAFETY: no callback can reach these any more.
            unsafe {
                if !self.client.is_null() {
                    ffi::colyseus_client_free(self.client);
                }
                if !self.settings.is_null() {
                    ffi::colyseus_settings_free(self.settings);
                }
                drop(Box::from_raw(self.sink as *mut RefCell<Sink>));
            }
        } else {
            // A matchmaking request is still in flight and will call back into the sink and its
            // ctx: leak them (and the client it runs on) rather than free under it. The callback
            // sees `orphaned` and leaves any room it gets.
            // SAFETY: sink is live.
            unsafe { (*self.sink).borrow_mut().orphaned = true };
            for (_, ctx) in self.pending_ctx.drain() {
                std::mem::forget(ctx);
            }
        }
    }
}

/// `ws://host[:port]` / `wss://host[:port]` (http/https accepted) → (address, port, secure).
/// What the session can see of a room's connection, read from its public head.
#[derive(Clone, Copy, Debug)]
struct RoomProbe {
    /// The core's reconnect attempt counter: n while attempt n is armed or in flight.
    retry_count: i32,
    reconnecting: bool,
    /// The WebSocket upgrade has completed (the transport is open), joined or not.
    open: bool,
}

/// Reads a room's head (`colyseus_room_head_t`) after checking its layout against the accessor
/// functions. `None` when they disagree, as with a core other than v0.18.10 linked through
/// `GENEX_COLYSEUS_LIB_DIR`.
///
/// # Safety
/// `room` is a live room, read on the polling thread outside every callback.
unsafe fn room_probe(room: *mut ffi::colyseus_room_t) -> Option<RoomProbe> {
    if room.is_null() {
        return None;
    }
    let head = &*(room as *const ffi::colyseus_room_head_t);
    let mut o = ffi::colyseus_reconnection_options_t {
        enabled: false,
        max_retries: 0,
        min_delay_ms: 0,
        max_delay_ms: 0,
        min_uptime_ms: 0,
        delay_ms: 0,
        max_enqueued_messages: 0,
    };
    ffi::colyseus_room_get_reconnection_options(room, &mut o);
    let layout_ok = head.session_id == ffi::colyseus_room_get_session_id(room)
        && head.reconnection_token == ffi::colyseus_room_get_reconnection_token(room)
        && head.has_joined <= 1
        && head.reconnection_enabled == u8::from(o.enabled)
        && head.reconnection_max_retries == o.max_retries
        && head.reconnection_min_delay_ms == o.min_delay_ms
        && head.reconnection_max_delay_ms == o.max_delay_ms
        && head.reconnection_min_uptime_ms == o.min_uptime_ms
        && head.reconnection_delay_ms == o.delay_ms
        && head.reconnection_max_enqueued_messages == o.max_enqueued_messages
        && head.is_reconnecting == u8::from(ffi::colyseus_room_is_reconnecting(room))
        && (0..=o.max_retries.saturating_add(1)).contains(&head.retry_count);
    if !layout_ok {
        return None;
    }
    let t = head.transport;
    let open = !t.is_null() && (*t).is_open.is_some_and(|is_open| is_open(t));
    Some(RoomProbe {
        retry_count: head.retry_count,
        reconnecting: head.is_reconnecting == 1,
        open,
    })
}

/// The core's wait before reconnect attempt `n`: `clamp(min, max, 2^n × delay)` (room.c).
fn core_backoff_ms(n: i32) -> f64 {
    let d = (1i64 << n.clamp(0, 30)) * i64::from(reconnection::DELAY_MS);
    d.clamp(
        i64::from(reconnection::MIN_DELAY_MS),
        i64::from(reconnection::MAX_DELAY_MS),
    ) as f64
}

fn parse_endpoint(url: &str) -> Option<(String, String, bool)> {
    let (scheme, rest) = url.split_once("://")?;
    let secure = match scheme {
        "ws" | "http" => false,
        "wss" | "https" => true,
        _ => return None,
    };
    let rest = rest.trim_end_matches('/');
    if rest.is_empty() || rest.contains('/') || rest.contains('?') {
        return None;
    }
    let default_port = if secure { "443" } else { "80" };
    let (host, port) = if let Some(v6) = rest.strip_prefix('[') {
        let (h, after) = v6.split_once(']')?;
        (h, after.strip_prefix(':').unwrap_or(default_port))
    } else {
        rest.rsplit_once(':').unwrap_or((rest, default_port))
    };
    if port.parse::<u16>().is_err() || host.is_empty() || host.contains(':') && !rest.starts_with('[') {
        return None;
    }
    Some((host.to_string(), port.to_string(), secure))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn core_backoff_matches_the_spec_schedule() {
        let waits: Vec<f64> = (1..=9).map(core_backoff_ms).collect();
        assert_eq!(
            waits,
            [250.0, 500.0, 1000.0, 2000.0, 4000.0, 4000.0, 4000.0, 4000.0, 4000.0]
        );
        assert_eq!(waits.iter().sum::<f64>(), 23_750.0);
    }

    #[cfg(target_pointer_width = "64")]
    #[test]
    fn room_head_matches_the_v0_18_10_layout() {
        use std::mem::offset_of;
        // room.h: five char*, bool, transport*, factory fn*, char*, settings*, uint64_t, then the
        // reconnection state (options of one bool + six ints, int retry_count, bool, bool).
        assert_eq!(offset_of!(ffi::colyseus_room_head_t, has_joined), 40);
        assert_eq!(offset_of!(ffi::colyseus_room_head_t, transport), 48);
        assert_eq!(offset_of!(ffi::colyseus_room_head_t, joined_at_ms), 80);
        assert_eq!(offset_of!(ffi::colyseus_room_head_t, reconnection_enabled), 88);
        assert_eq!(
            offset_of!(ffi::colyseus_room_head_t, reconnection_max_retries) - 88,
            offset_of!(ffi::colyseus_reconnection_options_t, max_retries)
        );
        assert_eq!(offset_of!(ffi::colyseus_room_head_t, retry_count), 88 + 28);
        assert_eq!(offset_of!(ffi::colyseus_room_head_t, is_reconnecting), 120);
        assert_eq!(offset_of!(ffi::colyseus_transport_head_t, is_open), 32);
    }

    #[test]
    fn parses_relay_urls() {
        assert_eq!(
            parse_endpoint("ws://127.0.0.1:2711"),
            Some(("127.0.0.1".into(), "2711".into(), false))
        );
        assert_eq!(
            parse_endpoint("wss://relay.genex.games"),
            Some(("relay.genex.games".into(), "443".into(), true))
        );
        assert_eq!(
            parse_endpoint("wss://relay.genex.games/"),
            Some(("relay.genex.games".into(), "443".into(), true))
        );
        assert_eq!(parse_endpoint("ftp://x"), None);
        assert_eq!(parse_endpoint("ws://host/path"), None);
        assert_eq!(parse_endpoint("ws://host:notaport"), None);
    }
}
