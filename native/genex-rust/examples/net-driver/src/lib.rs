//! net-driver (multiplayer MP-6b): the netcode bench's driver contract 1 (genex-demo
//! `packages/netcode-bench/DRIVER.md`) over `genex::net`, so the bench's conformance fixtures and
//! feel gates test the facade's wiring and not only the vendored crate, whose own driver is
//! `crates/genex-multiplayer/examples/driver.rs`.
//!
//! Everything goes through the facade a game uses: a headless [`Runtime`] whose net runs on the
//! facade's `RelayBackend`, ticked at the fixed 60 Hz step. Commands queue writes on `sim.net`
//! between ticks (they leave at the next tick's flush, coalesced at the publish rate), every
//! answer is read from the frame a tick cut (`sim.net` reads and `events()`), and the backend is
//! pumped every loop turn, as a shell pumps it every frame. The one thing the facade does not own
//! is where a session goes: the bench names the endpoint, game id, name and token, so the
//! [`BenchConnector`] opens the session the export's baked guest door would have opened.
//!
//! Where the facade shows less than the crate, the answer says so with `null` and never reaches
//! around the facade: a player's `uid` and `team`, an object's `seq`, a control result's
//! `sequence`, a `reconnecting` event's `code`, and a chat line's `id` and `at`. A request the
//! facade refuses before it leaves, and the relay would refuse too (a release by a non-owner, a
//! host claim by a guest), answers as the relay's control result; the rest answer with the
//! facade's error code.

// Host tooling (a stdio process on the wall clock), never a game: a wasm32 build, as the
// six-destination check makes of every example, is an empty crate.
#![cfg(not(target_arch = "wasm32"))]

use std::collections::{BTreeMap, BTreeSet};

use genex::net::{NetClose, NetControl, NetErrorCode, NetEvent, NetFrame, NetStatus};
use genex::{FIXED_STEP_MS, Game, Runtime};
use genex_multiplayer::{ConnectOptions, RoomTarget, Session, stamp};
use genex_net::backend::NetBackend;
use genex_net::net::{Net, NetConfig};
use genex_net::relay::{RelayBackend, RelayConnector};
use serde_json::{Map, Value, json};

/// The contract version this driver speaks (DRIVER.md: any other is killed before a fixture).
pub const CONTRACT: u32 = 1;
/// The driver's name in its `ready` line.
pub const DRIVER_NAME: &str = "rust-facade";
/// The SDK behind it: the facade.
pub const SDK_NAME: &str = "genex";
/// The publish rate the driver registers: the highest a game may choose (the relay's state lane).
pub const PUBLISH_HZ: u32 = genex::net::NET_PUBLISH_HZ_MAX;
/// The digits a published number keeps: the most a game may keep, so the bench's values survive.
pub const DECIMALS: u32 = 6;

/// The errors the crate's driver answers with, kept byte-equal so both drivers answer alike.
struct Message {
    not_connected: &'static str,
    already_connected: &'static str,
    missing_cmd: &'static str,
    no_endpoint: &'static str,
    no_game_id: &'static str,
}

const MESSAGE: Message = Message {
    not_connected: "not connected",
    already_connected: "already connected",
    missing_cmd: "missing cmd",
    no_endpoint: "connect: endpoint",
    no_game_id: "connect: gameId",
};

/// The DRIVER.md snapshot `status` values.
const STATUS_IDLE: &str = "idle";
const STATUS_CONNECTED: &str = "connected";
const STATUS_RECONNECTING: &str = "reconnecting";
const STATUS_CLOSED: &str = "closed";

/// The relay's control reasons (PROTOCOL.md §7.2) for requests the facade refuses before they
/// leave and `NetControl` has no value for.
const REASON_MISSING: &str = "missing";
const REASON_CAPACITY: &str = "capacity";
const REASON_INVALID: &str = "invalid";

/// The DRIVER.md control operations, as a control result spells them.
const OPERATION_CLAIM: &str = "claim";
const OPERATION_RELEASE: &str = "release";
const OPERATION_REMOVE: &str = "remove";

/// The DRIVER.md event names.
const EVENT_RECONNECTING: &str = "reconnecting";
const EVENT_RECONNECTED: &str = "reconnected";
const EVENT_DISCONNECT: &str = "disconnect";
const EVENT_MESSAGE: &str = "message";
const EVENT_CHAT: &str = "chat";
const EVENT_HOST_CHANGED: &str = "hostChanged";
const EVENT_OBJECT_RESULT: &str = "objectResult";

/// The command that ends the process.
const CMD_QUIT: &str = "quit";

/// Where the bench sends a session: what `connect` names.
#[derive(Clone, Debug, PartialEq)]
pub struct BenchJoin {
    /// The relay's ws URL.
    pub endpoint: String,
    /// The game's slug.
    pub game_id: String,
    /// The display-name fallback.
    pub name: Option<String>,
    /// The identity token (the bench relay seats an empty one as a guest).
    pub token: String,
    /// Extra join options.
    pub options: Map<String, Value>,
}

/// Opens the bench's session for the facade's `RelayBackend`, as the export's guest door would.
pub struct BenchConnector {
    join: BenchJoin,
}

impl BenchConnector {
    /// A connector to `join`.
    pub fn new(join: BenchJoin) -> BenchConnector {
        BenchConnector { join }
    }
}

impl RelayConnector for BenchConnector {
    type Session = Session;

    fn slug(&self) -> Option<&str> {
        Some(&self.join.game_id)
    }

    fn open(&mut self, slug: &str, room: RoomTarget) -> Result<Session, String> {
        let mut options = ConnectOptions::new(self.join.endpoint.clone(), slug).room(room);
        options.name = self.join.name.clone();
        options.options = self.join.options.clone();
        let token = self.join.token.clone();
        Ok(Session::connect(options, move || Ok(token.clone())))
    }
}

/// The backend a `connect` installs: the facade's relay over the bench connector.
pub fn bench_backend(join: BenchJoin) -> Box<dyn NetBackend> {
    Box::new(RelayBackend::new(BenchConnector::new(join)))
}

/// What opens a backend for a `connect` (the relay; a test's stand-in).
pub type OpenBackend = Box<dyn FnMut(BenchJoin) -> Box<dyn NetBackend>>;

/// A claim, release or destroy waiting for its control result.
#[derive(Clone, Debug)]
struct Pending {
    cmd_id: Value,
    operation: &'static str,
    id: String,
}

/// The driver: a headless runtime, what the bench asked to hear, and the lines to print.
pub struct Driver {
    runtime: Runtime<()>,
    open: OpenBackend,
    out: Vec<Value>,
    skew: f64,
    /// The skew the process clock carries now (set at connect).
    applied_skew: f64,
    listening: BTreeSet<String>,
    connect_cmd: Option<Value>,
    connected: bool,
    pending: BTreeMap<u32, Pending>,
    left: bool,
}

/// The game the driver runs: nothing but the net knobs.
fn bench_game() -> Game<()> {
    let mut game = Game::new(()).title("Net driver");
    game.net(NetConfig::new().publish_hz(PUBLISH_HZ).decimals(DECIMALS));
    game
}

/// A reply line.
fn reply_line(cmd_id: &Value, result: Result<Value, String>) -> Value {
    match result {
        Ok(result) => json!({ "type": "reply", "cmdId": cmd_id, "ok": true, "result": result }),
        Err(error) => json!({ "type": "reply", "cmdId": cmd_id, "ok": false, "error": error }),
    }
}

/// The snapshot `status` of a facade status.
fn status_wire(status: NetStatus) -> &'static str {
    match status {
        NetStatus::Joined => STATUS_CONNECTED,
        NetStatus::Reconnecting => STATUS_RECONNECTING,
        NetStatus::Closed => STATUS_CLOSED,
        _ => STATUS_IDLE,
    }
}

/// Whether a control result is an acceptance (the relay's `accepted: true` reasons).
fn accepted(result: NetControl) -> bool {
    matches!(result, NetControl::Accepted | NetControl::AlreadyOwner | NetControl::HostAuthority)
}

/// The relay's delay a retry tick stands for, in milliseconds.
fn retry_ms(retry_at_tick: u64, cut_tick: u64) -> f64 {
    retry_at_tick.saturating_sub(cut_tick) as f64 * FIXED_STEP_MS
}

/// A player id as JSON, `null` for none.
fn id_value(id: Option<&genex::net::PlayerId>) -> Value {
    id.map_or(Value::Null, |id| json!(id.as_str()))
}

/// The owner of `id` in `frame`, as the snapshot spells it.
fn owner_of(frame: &NetFrame, id: &str) -> Value {
    id_value(frame.object(id).and_then(|object| object.owner()))
}

/// Why the seat closed, from the frame that closed it.
fn closed_reason(frame: &NetFrame) -> NetClose {
    let reason = frame.events().iter().find_map(|event| match event {
        NetEvent::Closed { reason } => Some(*reason),
        _ => None,
    });
    reason.unwrap_or(NetClose::Other)
}

/// A close's WebSocket code as JSON, `null` when the relay sends none.
fn close_code(reason: NetClose) -> Value {
    reason.code().map_or(Value::Null, |code| json!(code))
}

/// A facade refusal as the driver answers it: `not connected` before a seat, else its code.
fn refused(code: NetErrorCode) -> String {
    if code == NetErrorCode::NotJoined {
        return MESSAGE.not_connected.to_owned();
    }
    code.wire().to_owned()
}

impl Driver {
    /// A driver whose `connect` installs `open(join)`.
    pub fn with_backend(open: OpenBackend) -> Driver {
        let runtime = Runtime::new(bench_game()).unwrap_or_else(|error| panic!("the driver's game installs: {error:?}"));
        Driver {
            runtime,
            open,
            out: Vec::new(),
            skew: 0.0,
            applied_skew: 0.0,
            listening: BTreeSet::new(),
            connect_cmd: None,
            connected: false,
            pending: BTreeMap::new(),
            left: false,
        }
    }

    /// The driver the bench runs: `connect` opens the relay.
    pub fn relay() -> Driver {
        Driver::with_backend(Box::new(bench_backend))
    }

    /// The `ready` line (DRIVER.md: the first stdout line).
    pub fn ready() -> Value {
        json!({
            "type": "ready",
            "contract": CONTRACT,
            "driver": DRIVER_NAME,
            "sdk": SDK_NAME,
            "sdkVersion": env!("CARGO_PKG_VERSION"),
            "protocol": genex_multiplayer::protocol::PROTOCOL_VERSION,
            "capabilities": ["skew"],
        })
    }

    /// The lines to print since the last call, in order.
    pub fn take_output(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.out)
    }

    fn net(&self) -> &Net {
        &self.runtime.sim().net
    }

    fn net_mut(&mut self) -> &mut Net {
        &mut self.runtime.sim_mut().net
    }

    fn reply(&mut self, cmd_id: &Value, result: Result<Value, String>) {
        self.out.push(reply_line(cmd_id, result));
    }

    fn event(&mut self, name: &str, payload: Value) {
        self.out.push(json!({ "type": "event", "name": name, "payload": payload }));
    }

    /// A session is open and not over (the crate driver's `live()`).
    fn live(&self) -> Result<(), String> {
        let over = self.left || self.net().status() == NetStatus::Closed;
        if self.connected && !over {
            return Ok(());
        }
        Err(MESSAGE.not_connected.to_owned())
    }

    /// One command line. A line that is not a JSON object is ignored, as the crate's driver does.
    pub fn command(&mut self, line: &str) {
        let Ok(Value::Object(mut msg)) = serde_json::from_str::<Value>(line) else {
            eprintln!("[net-driver] ignoring non-JSON command line: {line}");
            return;
        };
        let cmd_id = msg.remove("cmdId").unwrap_or(Value::Null);
        let Some(cmd) = msg.remove("cmd").and_then(|cmd| cmd.as_str().map(str::to_owned)) else {
            return self.reply(&cmd_id, Err(MESSAGE.missing_cmd.to_owned()));
        };
        // `None`: answered later (a connect, a control request that left for the relay).
        if let Some(result) = self.run(&cmd, &msg, &cmd_id) {
            self.reply(&cmd_id, result);
        }
    }

    fn run(&mut self, cmd: &str, msg: &Map<String, Value>, cmd_id: &Value) -> Option<Result<Value, String>> {
        let text = |key: &str| msg.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
        let flag = |key: &str| msg.get(key).and_then(Value::as_bool).unwrap_or(false);
        let data = |key: &str| msg.get(key).cloned().unwrap_or(Value::Null);
        let done = |result: Result<(), String>| Some(result.map(|()| Value::Null));
        match cmd {
            "connect" => self.connect(msg, cmd_id).err().map(Err),
            "skew" => {
                self.skew = msg.get("ms").and_then(Value::as_f64).unwrap_or(0.0);
                Some(Ok(json!({ "ms": self.skew })))
            }
            "clock" => Some(Ok(self.clock())),
            "setState" => done(self.set_state(data("data"), flag("snap"))),
            "setShared" => done(self.set_shared(&text("key"), data("value"))),
            "claim" => self.control(OPERATION_CLAIM, &text("id"), msg.get("authority").and_then(Value::as_str) == Some("host"), cmd_id),
            "release" => self.control(OPERATION_RELEASE, &text("id"), false, cmd_id),
            "destroy" => self.control(OPERATION_REMOVE, &text("id"), false, cmd_id),
            "setObject" => done(self.set_object(&text("id"), data("d"), flag("snap"))),
            "listen" => {
                self.listening.insert(text("type"));
                Some(Ok(Value::Null))
            }
            "send" => done(self.send(&text("type"), data("data"))),
            "chat" => done(self.chat(&text("text"))),
            "snapshot" => Some(Ok(self.snapshot())),
            "sampleSmoothed" => Some(Ok(json!({ "state": self.sample(msg) }))),
            "leave" => {
                self.leave();
                Some(Ok(Value::Null))
            }
            other => Some(Err(format!("unknown command: {other}"))),
        }
    }

    fn connect(&mut self, args: &Map<String, Value>, cmd_id: &Value) -> Result<(), String> {
        if self.connected {
            return Err(MESSAGE.already_connected.to_owned());
        }
        let text = |key: &str| args.get(key).and_then(Value::as_str).map(str::to_owned);
        let endpoint = text("endpoint").ok_or(MESSAGE.no_endpoint)?;
        let game_id = text("gameId").ok_or(MESSAGE.no_game_id)?;
        let options = match args.get("options") {
            Some(Value::Object(extra)) => extra.clone(),
            _ => Map::new(),
        };
        let join = BenchJoin { endpoint, game_id, name: text("name"), token: text("token").unwrap_or_default(), options };
        // The skew seam is process-wide; one driver process is one client. The session opens at
        // the next tick's flush, after this.
        stamp::set_clock_skew_for_tests(self.skew);
        self.applied_skew = self.skew;
        let backend = (self.open)(join);
        self.runtime.set_net_backend(backend);
        self.net_mut().connect();
        self.connected = true;
        self.connect_cmd = Some(cmd_id.clone());
        Ok(())
    }

    fn clock(&self) -> Value {
        // The stamping clock and the same clock without the injected skew, one instant.
        let now = stamp::local_now_ms();
        let real = now - self.applied_skew;
        let skew = if self.connected { self.applied_skew } else { self.skew };
        json!({ "now": real + skew, "real": real })
    }

    fn set_state(&mut self, data: Value, snap: bool) -> Result<(), String> {
        self.live()?;
        let net = self.net_mut();
        let result = if snap { net.snap_me(data) } else { net.set_me(data) };
        result.map_err(|error| refused(error.code()))
    }

    fn set_shared(&mut self, key: &str, value: Value) -> Result<(), String> {
        self.live()?;
        self.net_mut().set_shared(key, value).map_err(|error| refused(error.code()))
    }

    fn set_object(&mut self, id: &str, d: Value, snap: bool) -> Result<(), String> {
        self.live()?;
        let net = self.net_mut();
        let result = if snap { net.snap_object(id, d) } else { net.set_object(id, d) };
        // A non-owner's publish is dropped client-side: still `ok` (DRIVER.md).
        if let Err(error) = result {
            eprintln!("[net-driver] setObject {id}: {}", error.code().wire());
        }
        Ok(())
    }

    fn send(&mut self, kind: &str, data: Value) -> Result<(), String> {
        self.live()?;
        // A reserved type is refused locally; the contract still wants `ok`.
        if let Err(error) = self.net_mut().send(kind, data) {
            eprintln!("[net-driver] send {kind}: {}", error.code().wire());
        }
        Ok(())
    }

    fn chat(&mut self, text: &str) -> Result<(), String> {
        self.live()?;
        self.net_mut().chat(text).map_err(|error| refused(error.code()))
    }

    /// A claim, release or destroy: answered when its control result arrives, or now when the
    /// facade refuses it before it leaves.
    fn control(&mut self, operation: &'static str, id: &str, as_host: bool, cmd_id: &Value) -> Option<Result<Value, String>> {
        if let Err(error) = self.live() {
            return Some(Err(error));
        }
        let net = self.net_mut();
        let ticket = match operation {
            OPERATION_CLAIM if as_host => net.claim_as_host(id),
            OPERATION_CLAIM => net.claim(id),
            OPERATION_RELEASE => net.release(id),
            _ => net.remove(id),
        };
        match ticket {
            Ok(ticket) => {
                self.pending.insert(ticket.number(), Pending { cmd_id: cmd_id.clone(), operation, id: id.to_owned() });
                None
            }
            Err(error) => Some(self.refused_control(operation, id, error.code())),
        }
    }

    /// A control request the facade refused before it left, answered as the relay would answer
    /// it (PROTOCOL.md §7.2) when the relay has a reason for it.
    fn refused_control(&self, operation: &str, id: &str, code: NetErrorCode) -> Result<Value, String> {
        let owner = owner_of(self.net().frame(), id);
        let reason = match code {
            NetErrorCode::NotHost => NetControl::NotHost.wire(),
            NetErrorCode::NotOwner if owner.is_null() => REASON_MISSING,
            NetErrorCode::NotOwner => NetControl::NotOwner.wire(),
            NetErrorCode::ObjectCap => REASON_CAPACITY,
            NetErrorCode::MessageTooLarge => REASON_INVALID,
            other => return Err(refused(other)),
        };
        Ok(json!({
            "requestId": Value::Null,
            "operation": operation,
            "id": id,
            "accepted": false,
            "owner": owner,
            "sequence": Value::Null,
            "reason": reason,
        }))
    }

    fn leave(&mut self) {
        self.left = true;
        if self.connected {
            self.net_mut().leave();
        }
    }

    fn snapshot(&self) -> Value {
        let net = self.net();
        let status = if self.left { STATUS_CLOSED } else { status_wire(net.status()) };
        let players: Vec<Value> = net
            .players()
            .map(|player| {
                json!({
                    "sid": player.id().as_str(),
                    "uid": Value::Null,
                    "name": player.name(),
                    "team": Value::Null,
                    "connected": player.connected(),
                    "data": player.state_raw(),
                })
            })
            .collect();
        let objects: Vec<Value> = net
            .objects()
            .map(|object| {
                let d = if object.state_raw().is_null() { json!({}) } else { object.state_raw().clone() };
                json!({ "id": object.id(), "owner": id_value(object.owner()), "seq": Value::Null, "epoch": object.epoch(), "d": d })
            })
            .collect();
        let shared: Map<String, Value> = net.shared_keys().filter_map(|key| Some((key.to_owned(), net.shared(key)?.clone()))).collect();
        json!({
            "me": id_value(net.me()),
            "status": status,
            "players": players,
            "shared": shared,
            "objects": objects,
            "host": id_value(net.host()),
            "isHost": net.is_host(),
        })
    }

    fn sample(&self, args: &Map<String, Value>) -> Value {
        let net = self.net();
        if let Some(id) = args.get("object").and_then(Value::as_str) {
            return net.object(id).map_or(Value::Null, |object| object.state().clone());
        }
        if let Some(sid) = args.get("sid").and_then(Value::as_str) {
            return net.players().find(|player| player.id().as_str() == sid).map_or(Value::Null, |player| player.state().clone());
        }
        Value::Null
    }

    /// One loop turn without a tick: move the session's IO along, as a shell does every frame
    /// (the runtime stays paused, so this runs no tick).
    pub fn pump(&mut self) {
        self.runtime.advance_live(0.0);
    }

    /// One fixed tick: the queued writes leave at its flush, and its frame's answers are printed.
    pub fn tick(&mut self) {
        let _ = self.runtime.step(FIXED_STEP_MS);
        let connect_failed = self.answer_connect();
        let frame = self.net().frame().clone();
        for event in frame.events() {
            // A join the relay refused answers the connect alone, as the crate's driver does.
            let answered = connect_failed && matches!(event, NetEvent::Closed { .. });
            if !answered {
                self.answer_event(&frame, event);
            }
        }
    }

    /// The pending `connect` answers once the seat is joined, or fails when it closes first;
    /// answers whether it failed.
    fn answer_connect(&mut self) -> bool {
        let Some(cmd_id) = self.connect_cmd.clone() else { return false };
        let net = self.net();
        let seated = net.status() == NetStatus::Joined;
        let sid = net.me().filter(|_| seated).map(|me| me.as_str().to_owned());
        let closed = (net.status() == NetStatus::Closed).then(|| closed_reason(net.frame()));
        if let Some(sid) = sid {
            self.connect_cmd = None;
            self.out.push(json!({ "type": "joined", "sid": sid }));
            self.reply(&cmd_id, Ok(json!({ "sid": sid })));
            return false;
        }
        let Some(reason) = closed else { return false };
        self.connect_cmd = None;
        self.reply(&cmd_id, Err(format!("closed ({}): {}", close_code(reason), reason.wire())));
        true
    }

    fn answer_event(&mut self, frame: &NetFrame, event: &NetEvent) {
        match event {
            NetEvent::Reconnecting { attempt } => self.event(EVENT_RECONNECTING, json!({ "attempt": attempt, "code": Value::Null })),
            NetEvent::Reconnected => self.event(EVENT_RECONNECTED, json!({})),
            NetEvent::Closed { reason } => {
                // A deliberate leave emits nothing; a connect still waiting was answered above.
                let reported = self.left || *reason == NetClose::Left;
                if !reported {
                    self.event(EVENT_DISCONNECT, json!({ "code": close_code(*reason) }));
                }
            }
            NetEvent::Message { kind, payload, .. } => {
                if self.listening.contains(kind) {
                    self.event(EVENT_MESSAGE, json!({ "type": kind, "data": payload }));
                }
            }
            NetEvent::Chat { from, name, text } => {
                self.event(EVENT_CHAT, json!({ "id": Value::Null, "from": from.as_str(), "name": name, "text": text, "at": Value::Null }));
            }
            NetEvent::Host { player } => self.event(EVENT_HOST_CHANGED, json!({ "host": id_value(player.as_ref()) })),
            NetEvent::Control { ticket, result, retry_at_tick } => self.answer_control(frame, ticket.number(), *result, *retry_at_tick),
            NetEvent::Warning { code } => eprintln!("[net-driver] warning {}", code.wire()),
            _ => {}
        }
    }

    fn answer_control(&mut self, frame: &NetFrame, ticket: u32, result: NetControl, retry_at_tick: Option<u64>) {
        let Some(pending) = self.pending.remove(&ticket) else { return };
        let mut value = json!({
            "requestId": format!("t{ticket}"),
            "operation": pending.operation,
            "id": pending.id,
            "accepted": accepted(result),
            "owner": owner_of(frame, &pending.id),
            "sequence": Value::Null,
            "reason": result.wire(),
        });
        if let Some(tick) = retry_at_tick {
            value["retryAfterMs"] = json!(retry_ms(tick, frame.tick()));
        }
        self.event(EVENT_OBJECT_RESULT, value.clone());
        self.reply(&pending.cmd_id, Ok(value));
    }

    /// Leave (if seated) and run one tick, whose flush hands the leave to the session; pumps
    /// after it send it.
    pub fn leave_and_flush(&mut self) {
        self.leave();
        self.tick();
    }
}

/// The `cmdId` of `line` when it is the `quit` command.
pub fn quit_command(line: &str) -> Option<Value> {
    let value = serde_json::from_str::<Value>(line).ok()?;
    if value.get("cmd").and_then(Value::as_str) != Some(CMD_QUIT) {
        return None;
    }
    Some(value.get("cmdId").cloned().unwrap_or(Value::Null))
}

/// The `quit` reply.
pub fn quit_reply(cmd_id: &Value) -> Value {
    reply_line(cmd_id, Ok(Value::Null))
}
