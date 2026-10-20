//! The native relay: genex-multiplayer's libcolyseus `Session` behind [`RelaySession`], opened
//! through the guest door with the slug the export lane bakes in (owner call MP-O1).
//!
//! `GENEX_GAME_SLUG` (the game's Genex binding at export), `GENEX_API_URL` and `GENEX_RELAY_URL`
//! are read when the crate compiles, never from the player's environment. A build without a slug
//! opens nothing: the Relay backend stays offline with `net-no-slug`.

use std::collections::BTreeMap;

use genex_multiplayer::{ConnectOptions, EmbedIdentity, Error as SessionError, Event, ObjectView, PlayerView, RoomTarget, Session};
use serde_json::Value;

use super::{RelayConnector, RelaySession};

/// The Genex API the guest door asks when the build names none.
pub const DEFAULT_API_URL: &str = "https://api.genex.games";

/// Opens native sessions for one game.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeConnector {
    slug: Option<String>,
    api_url: String,
    relay_url: Option<String>,
}

impl NativeConnector {
    /// The connector the export baked in: its slug, API and optional relay override.
    pub fn baked() -> NativeConnector {
        let slug = option_env!("GENEX_GAME_SLUG").filter(|slug| !slug.is_empty());
        let api_url = option_env!("GENEX_API_URL").filter(|url| !url.is_empty()).unwrap_or(DEFAULT_API_URL);
        let relay_url = option_env!("GENEX_RELAY_URL").filter(|url| !url.is_empty());
        NativeConnector { slug: slug.map(str::to_owned), api_url: api_url.to_owned(), relay_url: relay_url.map(str::to_owned) }
    }

    /// A connector for `slug` against `api_url`, optionally pinned to one relay (local benches).
    pub fn new(slug: Option<&str>, api_url: &str, relay_url: Option<&str>) -> NativeConnector {
        NativeConnector { slug: slug.map(str::to_owned), api_url: api_url.to_owned(), relay_url: relay_url.map(str::to_owned) }
    }
}

impl RelayConnector for NativeConnector {
    type Session = Session;

    fn slug(&self) -> Option<&str> {
        self.slug.as_deref()
    }

    fn open(&mut self, slug: &str, room: RoomTarget) -> Result<Session, String> {
        // The guest door is one blocking HTTPS call; the facade makes it at a commitment point
        // (connect, matchmake), never every frame.
        let identity = EmbedIdentity::guest(&self.api_url, slug).map_err(|error| error.to_string())?;
        let endpoints = match &self.relay_url {
            Some(url) => vec![url.clone()],
            None => identity.relay_urls().to_vec(),
        };
        let mut options = ConnectOptions::new(String::new(), slug).room(room);
        options.endpoints = endpoints;
        Ok(Session::connect(options, identity.into_provider()))
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
