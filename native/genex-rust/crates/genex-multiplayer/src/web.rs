//! The web session (`wasm32-unknown-unknown`): a thin binding of the JS bridge module
//! `@genex-ai/multiplayer/bridge`, whose contract is `sdks/rust/BRIDGE.md`.
//!
//! In a browser the TypeScript SDK owns identity (the embed token from `@genex-ai/embed-sdk`,
//! read fresh per join), relay selection, reconnection, the server clock, interpolation and voice.
//! This module crosses the boundary once per call with JSON strings: `poll()` drains the bridge's
//! event queue and refreshes the player, object and shared views once per frame. The bridge
//! delivers every game event type, as native does; `listen` is a no-op kept for parity.

use serde_json::{json, Value};
use std::collections::BTreeMap;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::JsFuture;

use crate::protocol::{self, limits};
use crate::types::*;

#[wasm_bindgen(module = "@genex-ai/multiplayer/bridge")]
extern "C" {
    /// `connect(optsJson) -> Promise<handle>`; rejects with `{code, message}` on a refused join.
    #[wasm_bindgen(js_name = connect)]
    fn bridge_connect(opts_json: &str) -> js_sys::Promise;
    #[wasm_bindgen(js_name = setMe, catch)]
    fn bridge_set_me(handle: &JsValue, json: &str) -> Result<bool, JsValue>;
    #[wasm_bindgen(js_name = snapMe, catch)]
    fn bridge_snap_me(handle: &JsValue, json: &str) -> Result<bool, JsValue>;
    #[wasm_bindgen(js_name = playersJson)]
    fn bridge_players_json(handle: &JsValue) -> String;
    #[wasm_bindgen(js_name = sharedJson)]
    fn bridge_shared_json(handle: &JsValue) -> String;
    #[wasm_bindgen(js_name = objectsJson)]
    fn bridge_objects_json(handle: &JsValue) -> String;
    #[wasm_bindgen(js_name = sessionJson)]
    fn bridge_session_json(handle: &JsValue) -> String;
    #[wasm_bindgen(js_name = setShared, catch)]
    fn bridge_set_shared(handle: &JsValue, key: &str, json: &str) -> Result<bool, JsValue>;
    #[wasm_bindgen(js_name = claim, catch)]
    fn bridge_claim(handle: &JsValue, id: &str, request_id: &str) -> Result<(), JsValue>;
    #[wasm_bindgen(js_name = claimAsHost, catch)]
    fn bridge_claim_as_host(handle: &JsValue, id: &str, request_id: &str) -> Result<(), JsValue>;
    #[wasm_bindgen(js_name = release, catch)]
    fn bridge_release(handle: &JsValue, id: &str, request_id: &str) -> Result<(), JsValue>;
    #[wasm_bindgen(js_name = destroy, catch)]
    fn bridge_destroy(handle: &JsValue, id: &str, request_id: &str) -> Result<(), JsValue>;
    #[wasm_bindgen(js_name = setObject, catch)]
    fn bridge_set_object(handle: &JsValue, id: &str, json: &str) -> Result<bool, JsValue>;
    #[wasm_bindgen(js_name = snapObject, catch)]
    fn bridge_snap_object(handle: &JsValue, id: &str, json: &str) -> Result<bool, JsValue>;
    #[wasm_bindgen(js_name = send, catch)]
    fn bridge_send(handle: &JsValue, kind: &str, json: &str) -> Result<bool, JsValue>;
    #[wasm_bindgen(js_name = sendInput, catch)]
    fn bridge_send_input(handle: &JsValue, json: &str) -> Result<bool, JsValue>;
    #[wasm_bindgen(js_name = setRoomOpen, catch)]
    fn bridge_set_room_open(handle: &JsValue, open: bool) -> Result<bool, JsValue>;
    #[wasm_bindgen(js_name = chatSend, catch)]
    fn bridge_chat_send(handle: &JsValue, text: &str) -> Result<bool, JsValue>;
    #[wasm_bindgen(js_name = listen)]
    fn bridge_listen(handle: &JsValue, kind: &str);
    #[wasm_bindgen(js_name = drainEventsJson)]
    fn bridge_drain_events_json(handle: &JsValue) -> String;
    #[wasm_bindgen(js_name = leave)]
    fn bridge_leave(handle: &JsValue);
    #[wasm_bindgen(js_name = dispose)]
    fn bridge_dispose(handle: &JsValue);
    #[wasm_bindgen(js_name = reportEliminated, catch)]
    fn bridge_report_eliminated(handle: &JsValue) -> Result<bool, JsValue>;
    #[wasm_bindgen(js_name = reportScore, catch)]
    fn bridge_report_score(handle: &JsValue, delta: f64) -> Result<bool, JsValue>;
    #[wasm_bindgen(js_name = reportFinish, catch)]
    fn bridge_report_finish(handle: &JsValue) -> Result<bool, JsValue>;
    #[wasm_bindgen(js_name = timeUntil)]
    fn bridge_time_until(handle: &JsValue, epoch_ms: f64) -> f64;
}

fn js_err(e: JsValue) -> Error {
    Error::Bridge(
        e.dyn_ref::<js_sys::Error>()
            .map(|e| String::from(e.message()))
            .or_else(|| e.as_string())
            .unwrap_or_else(|| "bridge call failed".into()),
    )
}

/// A bridge write (BRIDGE.md: `false` = no live session, or a refused argument) as a `Result`.
/// Every argument the bridge would refuse is checked on this side first, so `false` here means
/// there was no live session: [`Error::NotConnected`], as native answers.
fn sent(r: Result<bool, JsValue>) -> Result<(), Error> {
    match r.map_err(js_err)? {
        true => Ok(()),
        false => Err(Error::NotConnected),
    }
}

/// The `session` part of `sessionJson()` (BRIDGE.md).
#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct SessionInfo {
    session_id: String,
    room_id: String,
    host_id: Option<String>,
    is_host: bool,
    connected: bool,
    closed: bool,
    server_now: Option<f64>,
    rtt: Option<f64>,
    clock_synced: bool,
    clock_origin: f64,
    match_state: Option<Value>,
}

/// A Genex multiplayer session over the browser bridge. Same surface as the native `Session`
/// where the platforms agree; `connect` is async here.
pub struct Session {
    handle: JsValue,
    info: SessionInfo,
    players: Vec<PlayerView>,
    objects: Vec<ObjectView>,
    shared: BTreeMap<String, Value>,
    chat: BTreeMap<i64, ChatMessage>,
    request_counter: u64,
    /// `ConnectOptions::pose`, for `set_pose`.
    pose: bool,
    /// The last state given to `set_me` / `snap_me`, which `set_pose` merges the pose into.
    me: Option<Value>,
}

fn opts_json(opts: &ConnectOptions) -> String {
    let room = match &opts.room {
        RoomTarget::Play => json!("play"),
        RoomTarget::Queue => json!("queue"),
        RoomTarget::CreatePrivate => json!("private"),
        RoomTarget::JoinById(code) => json!({ "joinById": code }),
    };
    json!({
        "gameId": opts.game_id,
        "name": opts.name,
        "urls": opts.endpoints,
        "room": room,
        "pose": opts.pose,
        "options": opts.options,
        "publishHz": opts.publish_hz,
        "controlTimeoutMs": opts.control_timeout_ms,
        "protocol": protocol::PROTOCOL_VERSION,
    })
    .to_string()
}

impl Session {
    /// Join through the bridge. The bridge waits for the player's identity (guest or signed in)
    /// and reads a fresh embed token itself; Rust never handles the token in a browser.
    pub async fn connect(opts: &ConnectOptions) -> Result<Session, JoinFailure> {
        let handle = JsFuture::from(bridge_connect(&opts_json(opts))).await.map_err(|e| {
            let code = js_sys::Reflect::get(&e, &"code".into())
                .ok()
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0) as i32;
            let message = match js_err(e) {
                Error::Bridge(m) => m,
                other => other.to_string(),
            };
            JoinFailure { code, message }
        })?;
        let mut s = Session {
            handle,
            info: SessionInfo::default(),
            players: Vec::new(),
            objects: Vec::new(),
            shared: BTreeMap::new(),
            chat: BTreeMap::new(),
            request_counter: 0,
            pose: opts.pose,
            me: None,
        };
        s.refresh();
        Ok(s)
    }

    fn refresh(&mut self) {
        self.info = serde_json::from_str(&bridge_session_json(&self.handle)).unwrap_or_default();
        self.players = serde_json::from_str(&bridge_players_json(&self.handle)).unwrap_or_default();
        self.objects = serde_json::from_str(&bridge_objects_json(&self.handle)).unwrap_or_default();
        self.shared = serde_json::from_str(&bridge_shared_json(&self.handle)).unwrap_or_default();
    }

    /// Drain the bridge's events and refresh the views. Call once per frame.
    pub fn poll(&mut self) -> Vec<Event> {
        let events: Vec<Event> = serde_json::from_str::<Vec<Value>>(&bridge_drain_events_json(&self.handle))
            .unwrap_or_default()
            .into_iter()
            .filter_map(|v| serde_json::from_value(v).ok())
            .collect();
        for e in &events {
            if let Event::Chat(line) = e {
                self.chat.entry(line.id as i64).or_insert_with(|| line.clone());
            }
        }
        self.refresh();
        events
    }

    pub fn leave(&mut self) {
        bridge_leave(&self.handle);
    }

    pub fn is_closed(&self) -> bool {
        self.info.closed
    }

    pub fn set_me(&mut self, state: Value) -> Result<(), Error> {
        if !state.is_object() {
            return Err(Error::State(crate::stamp::StateError::NotAnObject));
        }
        sent(bridge_set_me(&self.handle, &state.to_string()))?;
        self.me = Some(state);
        Ok(())
    }

    pub fn snap_me(&mut self, state: Value) -> Result<(), Error> {
        if !state.is_object() {
            return Err(Error::State(crate::stamp::StateError::NotAnObject));
        }
        sent(bridge_snap_me(&self.handle, &state.to_string()))?;
        self.me = Some(state);
        Ok(())
    }

    /// Publish the typed pose (§6.6). In a browser the TypeScript SDK splits the pose keys out of
    /// your state, so this merges `pose` into your last `set_me` state and publishes that.
    pub fn set_pose(&mut self, pose: crate::PoseFields) -> Result<(), Error> {
        if !self.pose {
            return Err(Error::InvalidPayload(
                "typed pose is off: set ConnectOptions::pose".into(),
            ));
        }
        if !pose.is_valid() {
            return Err(Error::InvalidPayload(
                "pose values must be finite, |v| ≤ 1e9, anim ≤ 64 chars".into(),
            ));
        }
        let mut state = match self.me.clone() {
            Some(Value::Object(m)) => m,
            _ => serde_json::Map::new(),
        };
        if let Ok(Value::Object(fields)) = serde_json::to_value(&pose) {
            state.extend(fields);
        }
        self.set_me(Value::Object(state))
    }

    pub fn set_shared(&mut self, key: &str, value: &Value) -> Result<(), Error> {
        if key.is_empty() || key.starts_with(protocol::RESERVED_SHARED_PREFIX) {
            return Err(Error::InvalidPayload(format!("shared key `{key}`")));
        }
        sent(bridge_set_shared(&self.handle, key, &value.to_string()))
    }

    pub fn shared(&self) -> BTreeMap<String, Value> {
        self.shared.clone()
    }

    pub fn shared_get(&self, key: &str) -> Option<Value> {
        self.shared.get(key).cloned()
    }

    pub fn send(&mut self, kind: &str, data: &Value) -> Result<(), Error> {
        if !protocol::is_sendable_event_type(kind) {
            return Err(Error::ReservedType(kind.into()));
        }
        let text = data.to_string();
        if text.len() > limits::MAX_EVENT_BYTES {
            return Err(Error::InvalidPayload("event payload over 16 KiB".into()));
        }
        sent(bridge_send(&self.handle, kind, &text))
    }

    /// Kept for parity and a no-op on the bridge: every game event already arrives as
    /// [`Event::Message`], as native does, whatever its name.
    pub fn listen(&mut self, kind: &str) {
        if protocol::is_sendable_event_type(kind) {
            bridge_listen(&self.handle, kind);
        }
    }

    pub fn send_input(&mut self, data: &Value) -> Result<(), Error> {
        sent(bridge_send_input(&self.handle, &data.to_string()))
    }

    pub fn set_room_open(&mut self, open: bool) -> Result<(), Error> {
        sent(bridge_set_room_open(&self.handle, open))
    }

    pub fn chat_send(&mut self, text: &str) -> Result<(), Error> {
        sent(bridge_chat_send(&self.handle, text))
    }

    pub fn chat_messages(&self) -> Vec<ChatMessage> {
        self.chat.values().cloned().collect()
    }

    fn next_request_id(&mut self) -> String {
        self.request_counter += 1;
        format!("rsw-{}", self.request_counter)
    }

    pub fn claim(&mut self, id: &str) -> Result<String, Error> {
        let rid = self.next_request_id();
        bridge_claim(&self.handle, id, &rid).map_err(js_err)?;
        Ok(rid)
    }

    pub fn claim_as_host(&mut self, id: &str) -> Result<String, Error> {
        let rid = self.next_request_id();
        bridge_claim_as_host(&self.handle, id, &rid).map_err(js_err)?;
        Ok(rid)
    }

    pub fn release(&mut self, id: &str) -> Result<String, Error> {
        let rid = self.next_request_id();
        bridge_release(&self.handle, id, &rid).map_err(js_err)?;
        Ok(rid)
    }

    pub fn destroy(&mut self, id: &str) -> Result<String, Error> {
        let rid = self.next_request_id();
        bridge_destroy(&self.handle, id, &rid).map_err(js_err)?;
        Ok(rid)
    }

    /// An object write the bridge answered. `owns()` reads the last `poll()`'s snapshot while the
    /// bridge checks ownership live, so a `false` from a session still open means ownership was
    /// lost since that poll: [`Error::NotOwner`]. From an ended session it is
    /// [`Error::NotConnected`].
    fn object_sent(&mut self, r: Result<bool, JsValue>, id: &str) -> Result<(), Error> {
        match sent(r) {
            Err(Error::NotConnected) => {
                self.refresh();
                if self.info.closed || !self.info.connected {
                    Err(Error::NotConnected)
                } else {
                    Err(Error::NotOwner(id.into()))
                }
            }
            other => other,
        }
    }

    pub fn owns(&self, id: &str) -> bool {
        let me = &self.info.session_id;
        !me.is_empty()
            && self
                .objects
                .iter()
                .any(|o| o.id == id && o.owner.as_deref() == Some(me.as_str()))
    }

    pub fn set_object(&mut self, id: &str, state: Value) -> Result<(), Error> {
        if !self.owns(id) {
            return Err(Error::NotOwner(id.into()));
        }
        let r = bridge_set_object(&self.handle, id, &state.to_string());
        self.object_sent(r, id)
    }

    pub fn snap_object(&mut self, id: &str, state: Value) -> Result<(), Error> {
        if !self.owns(id) {
            return Err(Error::NotOwner(id.into()));
        }
        let r = bridge_snap_object(&self.handle, id, &state.to_string());
        self.object_sent(r, id)
    }

    pub fn players(&self) -> &[PlayerView] {
        &self.players
    }

    pub fn player(&self, id: &str) -> Option<&PlayerView> {
        self.players.iter().find(|p| p.id == id)
    }

    pub fn objects(&self) -> &[ObjectView] {
        &self.objects
    }

    pub fn object(&self, id: &str) -> Option<&ObjectView> {
        self.objects.iter().find(|o| o.id == id)
    }

    pub fn session_id(&self) -> &str {
        &self.info.session_id
    }

    pub fn room_id(&self) -> &str {
        &self.info.room_id
    }

    pub fn host_id(&self) -> Option<&str> {
        self.info.host_id.as_deref()
    }

    pub fn is_host(&self) -> bool {
        self.info.is_host
    }

    pub fn is_connected(&self) -> bool {
        self.info.connected
    }

    pub fn match_state(&self) -> Option<Value> {
        self.info.match_state.clone()
    }

    /// Match self-reports (§9.3). [`Error::NotConnected`] outside a live match room.
    pub fn report_eliminated(&mut self) -> Result<(), Error> {
        sent(bridge_report_eliminated(&self.handle))
    }

    pub fn report_finish(&mut self) -> Result<(), Error> {
        sent(bridge_report_finish(&self.handle))
    }

    pub fn report_score(&mut self, delta: f64) -> Result<(), Error> {
        sent(bridge_report_score(&self.handle, delta))
    }

    /// Milliseconds until a relay epoch-ms deadline (§16.3): on the server clock once synced.
    pub fn ms_until(&self, epoch_ms: f64) -> f64 {
        bridge_time_until(&self.handle, epoch_ms)
    }

    pub fn has_server_clock(&self) -> bool {
        self.info.server_now.is_some()
    }

    pub fn server_now(&self) -> Option<f64> {
        self.info.server_now
    }

    pub fn rtt(&self) -> Option<f64> {
        self.info.rtt
    }

    pub fn clock_synced(&self) -> bool {
        self.info.clock_synced
    }

    pub fn clock_origin(&self) -> f64 {
        self.info.clock_origin
    }

    /// Voice exists in browsers through the TypeScript SDK, but this binding does not expose it.
    pub fn voice_supported(&self) -> bool {
        false
    }
}

/// Dropping a session leaves its room with consent, as the native `Session` does, and frees the
/// bridge's handle: the TypeScript session lives in the bridge's module scope, so without this a
/// dropped value would keep its seat, socket, heartbeats and auto-reconnect until the tab closes.
impl Drop for Session {
    fn drop(&mut self) {
        bridge_dispose(&self.handle);
    }
}
