//! The web relay (multiplayer MP-3b): the Relay backend over genex-multiplayer's browser bridge
//! (`@genex-ai/multiplayer/bridge`, mapped by the web shell's import map).
//!
//! In a browser the TypeScript SDK owns identity (the edge's embed token, read fresh per join),
//! relay selection, reconnection, the clock and smoothing; the crate crosses the boundary once per
//! call with JSON, and `poll` drains the bridge's event queue (`drainEventsJson`, at most
//! [`BRIDGE_EVENT_QUEUE_MAX`] events) once per shell frame. The events are the crate's own `Event`
//! in the same serde shape native reports, so [`RelayMap`](super::RelayMap) maps both alike; a
//! drain at the queue's cap reaches the room whole, and the room hands it to later ticks in order
//! behind `events-deferred`.
//!
//! A web join is a promise, while the backend opens a session in one call, so [`DialedSession`]
//! holds the join in flight and polls it (with a no-op waker) every pump: until it settles the
//! session is empty and every write answers not-connected; a refused join reads as the crate's
//! `JoinFailed`, so the seat closes as a native refusal does. The slug is the one the web export
//! bakes in (`GENEX_GAME_SLUG`), as on native.

use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll, Waker};

use genex_multiplayer::{Error as SessionError, Event, JoinFailure, ObjectView, PlayerView};
use serde_json::Value;

use super::RelaySession;

/// The most events the bridge's queue holds between two drains (BRIDGE.md).
pub const BRIDGE_EVENT_QUEUE_MAX: usize = 4096;

/// One `drainEventsJson` batch, read the way the crate's web session reads it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DrainedBatch {
    /// The events, in queue order.
    pub events: Vec<Event>,
    /// Entries that are not a crate event (a newer bridge's kinds): skipped, as the crate does.
    pub unreadable: usize,
    /// Whether the batch filled the bridge's queue, so the bridge may have held more back.
    pub full: bool,
}

/// Read one `drainEventsJson` batch: a JSON list of events in the crate's serde shape. A batch
/// that is not a list reads as no events.
pub fn drained_events(batch: &str) -> DrainedBatch {
    let entries: Vec<Value> = serde_json::from_str(batch).unwrap_or_default();
    let full = entries.len() >= BRIDGE_EVENT_QUEUE_MAX;
    let total = entries.len();
    let events: Vec<Event> = entries.into_iter().filter_map(|entry| serde_json::from_value(entry).ok()).collect();
    DrainedBatch { unreadable: total - events.len(), events, full }
}

/// A join in flight: the bridge's connect promise, or any future that settles to a session.
pub type Dial<S> = Pin<Box<dyn Future<Output = Result<S, JoinFailure>>>>;

enum DialState<S> {
    Dialing(Dial<S>),
    Open(S),
    Refused,
}

/// A session that is still joining until its dial settles; then the session itself.
pub struct DialedSession<S> {
    state: DialState<S>,
    leave_on_open: bool,
    full_drains: u64,
}

impl<S: RelaySession> DialedSession<S> {
    /// A session whose join is `dial`.
    pub fn dialing(dial: Dial<S>) -> DialedSession<S> {
        DialedSession { state: DialState::Dialing(dial), leave_on_open: false, full_drains: 0 }
    }

    /// The session, once the join settled seated.
    pub fn session(&self) -> Option<&S> {
        match &self.state {
            DialState::Open(session) => Some(session),
            _ => None,
        }
    }

    /// Whether the join is still in flight.
    pub fn is_dialing(&self) -> bool {
        matches!(self.state, DialState::Dialing(_))
    }

    /// Drains that came back at the bridge queue's cap (for `__net` and crash reports).
    pub fn full_drains(&self) -> u64 {
        self.full_drains
    }

    /// Poll the join once; the events its settling gives.
    fn settle(&mut self) -> Vec<Event> {
        let DialState::Dialing(dial) = &mut self.state else { return Vec::new() };
        let mut context = Context::from_waker(Waker::noop());
        match dial.as_mut().poll(&mut context) {
            Poll::Pending => Vec::new(),
            Poll::Ready(Err(failure)) => {
                self.state = DialState::Refused;
                vec![Event::JoinFailed { code: failure.code, message: failure.message }]
            }
            Poll::Ready(Ok(mut session)) => {
                // A leave asked for while joining: the bridge's own close events follow.
                if self.leave_on_open {
                    session.leave();
                }
                self.state = DialState::Open(session);
                Vec::new()
            }
        }
    }

    fn open_mut(&mut self) -> Result<&mut S, SessionError> {
        match &mut self.state {
            DialState::Open(session) => Ok(session),
            _ => Err(SessionError::NotConnected),
        }
    }
}

impl<S: RelaySession> RelaySession for DialedSession<S> {
    fn poll(&mut self) -> Vec<Event> {
        let mut events = self.settle();
        if let DialState::Open(session) = &mut self.state {
            let drained = session.poll();
            if drained.len() >= BRIDGE_EVENT_QUEUE_MAX {
                self.full_drains += 1;
            }
            events.extend(drained);
        }
        events
    }

    fn players(&self) -> &[PlayerView] {
        self.session().map_or(&[], RelaySession::players)
    }

    fn objects(&self) -> &[ObjectView] {
        self.session().map_or(&[], RelaySession::objects)
    }

    fn shared(&self) -> BTreeMap<String, Value> {
        self.session().map(RelaySession::shared).unwrap_or_default()
    }

    fn session_id(&self) -> &str {
        self.session().map_or("", RelaySession::session_id)
    }

    fn host_id(&self) -> Option<&str> {
        self.session().and_then(RelaySession::host_id)
    }

    fn match_state(&self) -> Option<Value> {
        self.session().and_then(RelaySession::match_state)
    }

    fn server_now(&self) -> Option<f64> {
        self.session().and_then(RelaySession::server_now)
    }

    fn leave(&mut self) {
        match &mut self.state {
            DialState::Open(session) => session.leave(),
            DialState::Dialing(_) => self.leave_on_open = true,
            DialState::Refused => {}
        }
    }

    fn set_me(&mut self, state: Value) -> Result<(), SessionError> {
        self.open_mut()?.set_me(state)
    }

    fn snap_me(&mut self, state: Value) -> Result<(), SessionError> {
        self.open_mut()?.snap_me(state)
    }

    fn set_object(&mut self, id: &str, state: Value) -> Result<(), SessionError> {
        self.open_mut()?.set_object(id, state)
    }

    fn snap_object(&mut self, id: &str, state: Value) -> Result<(), SessionError> {
        self.open_mut()?.snap_object(id, state)
    }

    fn claim(&mut self, id: &str) -> Result<String, SessionError> {
        self.open_mut()?.claim(id)
    }

    fn claim_as_host(&mut self, id: &str) -> Result<String, SessionError> {
        self.open_mut()?.claim_as_host(id)
    }

    fn release(&mut self, id: &str) -> Result<String, SessionError> {
        self.open_mut()?.release(id)
    }

    fn destroy(&mut self, id: &str) -> Result<String, SessionError> {
        self.open_mut()?.destroy(id)
    }

    fn set_shared(&mut self, key: &str, value: &Value) -> Result<(), SessionError> {
        self.open_mut()?.set_shared(key, value)
    }

    fn send(&mut self, kind: &str, data: &Value) -> Result<(), SessionError> {
        self.open_mut()?.send(kind, data)
    }

    fn send_input(&mut self, data: &Value) -> Result<(), SessionError> {
        self.open_mut()?.send_input(data)
    }

    fn set_room_open(&mut self, open: bool) -> Result<(), SessionError> {
        self.open_mut()?.set_room_open(open)
    }

    fn chat_send(&mut self, text: &str) -> Result<(), SessionError> {
        self.open_mut()?.chat_send(text)
    }

    fn report_eliminated(&mut self) -> Result<(), SessionError> {
        self.open_mut()?.report_eliminated()
    }

    fn report_finish(&mut self) -> Result<(), SessionError> {
        self.open_mut()?.report_finish()
    }

    fn report_score(&mut self, delta: f64) -> Result<(), SessionError> {
        self.open_mut()?.report_score(delta)
    }
}

#[cfg(target_arch = "wasm32")]
mod bridge {
    //! The wasm32 half: the connector over the crate's web `Session` and its `RelaySession` impl.

    use std::collections::BTreeMap;

    use genex_multiplayer::{ConnectOptions, Error as SessionError, Event, ObjectView, PlayerView, RoomTarget, Session};
    use serde_json::Value;

    use super::super::{RelayConnector, RelaySession};
    use super::DialedSession;

    /// Opens web sessions for one game through the bridge.
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub struct WebConnector {
        slug: Option<String>,
    }

    impl WebConnector {
        /// The connector the web export baked in: its slug, when it has one.
        pub fn baked() -> WebConnector {
            WebConnector { slug: option_env!("GENEX_GAME_SLUG").filter(|slug| !slug.is_empty()).map(str::to_owned) }
        }

        /// A connector for `slug` (tests and tools).
        pub fn new(slug: Option<&str>) -> WebConnector {
            WebConnector { slug: slug.map(str::to_owned) }
        }
    }

    impl RelayConnector for WebConnector {
        type Session = DialedSession<Session>;

        fn slug(&self) -> Option<&str> {
            self.slug.as_deref()
        }

        fn open(&mut self, slug: &str, room: RoomTarget) -> Result<DialedSession<Session>, String> {
            // No endpoints: the TypeScript SDK picks the relay and reads the embed identity.
            let options = ConnectOptions::new(String::new(), slug).room(room);
            Ok(DialedSession::dialing(Box::pin(async move { Session::connect(&options).await })))
        }
    }

    impl RelaySession for Session {
        fn poll(&mut self) -> Vec<Event> {
            Session::poll(self)
        }

        fn players(&self) -> &[PlayerView] {
            Session::players(self)
        }

        fn objects(&self) -> &[ObjectView] {
            Session::objects(self)
        }

        fn shared(&self) -> BTreeMap<String, Value> {
            Session::shared(self)
        }

        fn session_id(&self) -> &str {
            Session::session_id(self)
        }

        fn host_id(&self) -> Option<&str> {
            Session::host_id(self)
        }

        fn match_state(&self) -> Option<Value> {
            Session::match_state(self)
        }

        fn server_now(&self) -> Option<f64> {
            Session::server_now(self)
        }

        fn leave(&mut self) {
            Session::leave(self);
        }

        fn set_me(&mut self, state: Value) -> Result<(), SessionError> {
            Session::set_me(self, state)
        }

        fn snap_me(&mut self, state: Value) -> Result<(), SessionError> {
            Session::snap_me(self, state)
        }

        fn set_object(&mut self, id: &str, state: Value) -> Result<(), SessionError> {
            Session::set_object(self, id, state)
        }

        fn snap_object(&mut self, id: &str, state: Value) -> Result<(), SessionError> {
            Session::snap_object(self, id, state)
        }

        fn claim(&mut self, id: &str) -> Result<String, SessionError> {
            Session::claim(self, id)
        }

        fn claim_as_host(&mut self, id: &str) -> Result<String, SessionError> {
            Session::claim_as_host(self, id)
        }

        fn release(&mut self, id: &str) -> Result<String, SessionError> {
            Session::release(self, id)
        }

        fn destroy(&mut self, id: &str) -> Result<String, SessionError> {
            Session::destroy(self, id)
        }

        fn set_shared(&mut self, key: &str, value: &Value) -> Result<(), SessionError> {
            Session::set_shared(self, key, value)
        }

        fn send(&mut self, kind: &str, data: &Value) -> Result<(), SessionError> {
            Session::send(self, kind, data)
        }

        fn send_input(&mut self, data: &Value) -> Result<(), SessionError> {
            Session::send_input(self, data)
        }

        fn set_room_open(&mut self, open: bool) -> Result<(), SessionError> {
            Session::set_room_open(self, open)
        }

        fn chat_send(&mut self, text: &str) -> Result<(), SessionError> {
            Session::chat_send(self, text)
        }

        fn report_eliminated(&mut self) -> Result<(), SessionError> {
            Session::report_eliminated(self)
        }

        fn report_finish(&mut self) -> Result<(), SessionError> {
            Session::report_finish(self)
        }

        fn report_score(&mut self, delta: f64) -> Result<(), SessionError> {
            Session::report_score(self, delta)
        }
    }
}

#[cfg(target_arch = "wasm32")]
pub use bridge::WebConnector;
