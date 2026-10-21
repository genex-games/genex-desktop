//! Multiplayer (`sim.net`, `game.net`; multiplayer MP-4a): genex-net through the facade.
//!
//! The network is an input stream. Every tick the runtime cuts one immutable frame from the
//! backend before the update hooks (`sim.net` reads answer from it), records it in a byte-capped
//! journal, and after the physics step hands the tick's queued writes back to the backend, whose
//! effects arrive in a later frame. Reads take `&self` and writes `&mut self`, so a read hook can
//! draw remote players and can never send. Every shell frame pumps the backend first, paused or
//! not, so a seat stays alive; when one frame runs several ticks, everything pumped since the last
//! cut lands in the first tick's frame.
//!
//! The backend is chosen by the build, never by game code:
//! - feature `net` (export builds of a `[net]` game): the relay;
//! - feature `net-loopback` (Live, dev, judge and device-launch builds): an in-process room whose
//!   writes echo as the relay would, and a demo's [`NetScript`] adds scripted remote players;
//! - neither: off (`status` offline, reason `net-disabled`);
//! - a run Studio serves is always the loopback room, even with `net`, so no Studio-started game
//!   process reaches the network.
//!
//! Net state is display and session state: it is never checksummed (`state().__net` is display
//! only, emitted while the build links networking or `game.net` is registered), never saved, and
//! a reseed keeps a relay session (a reseed is not a disconnect).

use genex_core::json::Value as CoreValue;
use genex_net::backend::NetBackend;
use genex_net::journal::NetJournal;
use genex_net::loopback::LoopbackBackend;
use genex_net::off::OffBackend;

pub use genex_net::frame::{NetEvent, NetFrame, NetMatch, NetObject, NetPlayer, NetPose};
pub use genex_net::ids::{NetTicket, PlayerId};
pub use genex_net::net::{Net, NetConfig};
pub use genex_net::script::{NetClaimPolicy, NetScript};
pub use genex_net::vocab::{
    MatchStatus, NET_CHAT_CHARS_MAX, NET_EVENTS_PER_TICK_MAX, NET_JOURNAL_BYTES_DESKTOP, NET_JOURNAL_BYTES_PHONE, NET_OBJECTS_MAX, NET_PLAYERS_MAX,
    NET_PUBLISH_HZ_DEFAULT, NET_PUBLISH_HZ_MAX, NetClose, NetControl, NetError, NetErrorCode, NetMode, NetOffline, NetStatus, NetWarning,
};
pub use genex_net::writes::MatchReport;

/// The journal's byte cap on this destination: a phone's or the web's is smaller.
#[cfg(any(target_os = "ios", target_os = "android", target_arch = "wasm32"))]
const JOURNAL_BYTES: usize = NET_JOURNAL_BYTES_PHONE;
#[cfg(not(any(target_os = "ios", target_os = "android", target_arch = "wasm32")))]
const JOURNAL_BYTES: usize = NET_JOURNAL_BYTES_DESKTOP;

/// The backend this build links when nothing overrides it: the relay with `net` (the loopback
/// room in a run Studio serves), the loopback room with `net-loopback`, else off.
pub(crate) fn build_mode(studio_run: bool) -> NetMode {
    let relay = cfg!(feature = "net");
    let loopback = cfg!(feature = "net-loopback");
    if relay && !studio_run {
        return NetMode::Relay;
    }
    if relay || loopback {
        return NetMode::Loopback;
    }
    NetMode::Off
}

impl<W> crate::Game<W> {
    /// The game's net knobs (publish rate, decimals kept, smoothing delay); the defaults fit the
    /// feel checklist and a game that only connects needs no call. Registered once: a second call
    /// is the install refusal `duplicate-net`, values outside the caps `net-config-invalid`.
    /// Whether the game reaches the network is the build's choice (`[net]` in `genex.toml`).
    pub fn net(&mut self, config: NetConfig) -> &mut Self {
        self.g6.net.configs.push(config);
        self
    }
}

/// `game.net`: the configs registered (install refuses more than one).
#[derive(Debug, Default)]
pub(crate) struct Setup {
    configs: Vec<NetConfig>,
}

impl Setup {
    /// The config the seat runs with: the registered one, else the defaults.
    pub(crate) fn config(&self) -> NetConfig {
        self.configs.first().cloned().unwrap_or_default()
    }

    /// Whether `game.net` was called.
    pub(crate) fn registered(&self) -> bool {
        !self.configs.is_empty()
    }

    /// The install check: `duplicate-net`, then `net-config-invalid`.
    pub(crate) fn check(&self) -> Result<(), (crate::InstallErrorCode, String)> {
        if self.configs.len() > 1 {
            return Err((crate::InstallErrorCode::DuplicateNet, "game.net is registered once".to_owned()));
        }
        match self.configs.first().and_then(NetConfig::problem) {
            Some(problem) => Err((crate::InstallErrorCode::NetConfigInvalid, problem)),
            None => Ok(()),
        }
    }
}

/// The runtime's backend and journal.
pub(crate) struct State {
    backend: Box<dyn NetBackend>,
    /// The loopback room when that is the backend (the demo script drives it).
    loopback: Option<LoopbackBackend>,
    mode: NetMode,
    journal: NetJournal,
    /// Script calls outside the loopback room (`__net.scriptIgnored`).
    script_ignored: u64,
    /// Writes a backend dropped (`__net.writesDropped`): the off backend's.
    writes_dropped: u64,
    /// Pumps since the runtime started (`advance_live` pumps every shell frame, paused or not).
    pumps: u64,
    /// What the last frame cut showed, for `__net`.
    shown: Shown,
}

/// The last cut frame as `__net` shows it.
#[derive(Clone, Debug, Default)]
struct Shown {
    status: Option<NetStatus>,
    reason: Option<NetOffline>,
    me: Option<PlayerId>,
    host: Option<PlayerId>,
    players: u64,
    connected: u64,
    objects: u64,
}

impl Shown {
    fn of(frame: &NetFrame) -> Shown {
        Shown {
            status: Some(frame.status()),
            reason: frame.offline_reason(),
            me: frame.me().cloned(),
            host: frame.host().cloned(),
            players: frame.players().count() as u64,
            connected: frame.connected() as u64,
            objects: frame.object_count() as u64,
        }
    }
}

impl std::fmt::Debug for State {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("State").field("mode", &self.mode).field("journal_ticks", &self.journal.len()).finish_non_exhaustive()
    }
}

impl Default for State {
    fn default() -> State {
        State::with_mode(NetMode::Off, &NetConfig::default())
    }
}

/// The backend a mode runs on, with the loopback room kept beside it for the script.
fn backend_for(mode: NetMode, config: &NetConfig) -> (Box<dyn NetBackend>, Option<LoopbackBackend>) {
    match mode {
        NetMode::Loopback => (Box::new(OffBackend::new()), Some(LoopbackBackend::new(config))),
        #[cfg(feature = "net")]
        NetMode::Relay => (relay_backend(), None),
        _ => (Box::new(OffBackend::new()), None),
    }
}

/// The relay backend this export baked in (its slug, API and relay override).
#[cfg(all(feature = "net", not(target_arch = "wasm32")))]
fn relay_backend() -> Box<dyn NetBackend> {
    Box::new(genex_net::relay::RelayBackend::new(genex_net::relay::native::NativeConnector::baked()))
}

/// The relay backend this web export baked in.
#[cfg(all(feature = "net", target_arch = "wasm32"))]
fn relay_backend() -> Box<dyn NetBackend> {
    Box::new(genex_net::relay::RelayBackend::new(genex_net::relay::web::WebConnector::baked()))
}

impl State {
    /// A seat on `mode`'s backend with `config`.
    pub(crate) fn with_mode(mode: NetMode, config: &NetConfig) -> State {
        let (backend, loopback) = backend_for(mode, config);
        let shown = Shown { status: Some(NetFrame::offline(mode, None).status()), ..Shown::default() };
        State { backend, loopback, mode, journal: NetJournal::new(JOURNAL_BYTES), script_ignored: 0, writes_dropped: 0, pumps: 0, shown }
    }

    /// The seat for `setup` on this build's backend.
    pub(crate) fn install(setup: &Setup, studio_run: bool) -> State {
        State::with_mode(build_mode(studio_run), &setup.config())
    }

    /// Run on `backend` from now on (tests: a recorded session, a counting stand-in).
    pub(crate) fn set_backend(&mut self, backend: Box<dyn NetBackend>) {
        self.mode = backend.mode();
        self.backend = backend;
        self.loopback = None;
    }

    /// Which backend the seat runs on.
    pub(crate) fn mode(&self) -> NetMode {
        self.mode
    }

    /// How many times the backend was pumped.
    pub(crate) fn pumps(&self) -> u64 {
        self.pumps
    }

    /// Every shell frame, before any tick: move IO along, paused or not.
    pub(crate) fn pump(&mut self) {
        self.pumps += 1;
        match self.loopback.as_mut() {
            Some(room) => room.pump(),
            None => self.backend.pump(),
        }
    }

    /// Before the update hooks: cut this tick's frame into `sim.net` and journal it.
    pub(crate) fn cut(&mut self, _setup: &Setup, net: &mut Net, tick: u64) {
        let frame = match self.loopback.as_mut() {
            Some(room) => room.cut(tick),
            None => self.backend.cut(tick),
        };
        // A trimmed journal keeps its newest ticks; the warning is the journal's to report.
        let _trimmed = self.journal.append(&frame);
        self.shown = Shown::of(&frame);
        net.begin(frame);
    }

    /// After the physics step: hand the tick's writes to the backend.
    pub(crate) fn flush(&mut self, _setup: &Setup, net: &mut Net, tick: u64) {
        let writes = net.end();
        match self.loopback.as_mut() {
            Some(room) => room.apply(tick, writes),
            None => {
                if self.mode == NetMode::Off {
                    self.writes_dropped += writes.len() as u64;
                }
                self.backend.apply(tick, writes);
            }
        }
    }

    /// A new seed: the loopback room and the journal start over; a relay session is kept.
    pub(crate) fn reset(&mut self, _setup: &Setup) {
        if let Some(room) = self.loopback.as_mut() {
            room.reset();
        }
        self.journal.clear();
        self.script_ignored = 0;
        self.shown = Shown { status: Some(NetFrame::offline(self.mode, None).status()), ..Shown::default() };
    }

    /// The `sim.net` a seed starts from: no frame consumed yet.
    pub(crate) fn fresh(&self, setup: &Setup) -> Net {
        Net::fresh(self.mode, &setup.config())
    }

    /// A demo's script: the loopback room's, else one that counts and ignores every call.
    pub(crate) fn script(&mut self) -> NetScript<'_> {
        match self.loopback.as_mut() {
            Some(room) => NetScript::loopback(room),
            None => NetScript::ignored(&mut self.script_ignored),
        }
    }

    /// Whether `state()` carries `__net`: the build links networking or `game.net` is registered.
    pub(crate) fn shown(&self, setup: &Setup) -> bool {
        self.mode != NetMode::Off || setup.registered()
    }

    /// `state().__net` (display only): `{mode, status, reason?, me?, host?, players, connected,
    /// objects, journalTicks, writesDropped, scriptIgnored}` from the last frame cut.
    pub(crate) fn runtime_key(&self, setup: &Setup, state: &mut CoreValue) {
        if !self.shown(setup) {
            return;
        }
        let shown = &self.shown;
        let mut value = CoreValue::object();
        value.set("mode", CoreValue::from(self.mode.wire()));
        if let Some(status) = shown.status {
            value.set("status", CoreValue::from(status.wire()));
        }
        if let Some(reason) = shown.reason {
            value.set("reason", CoreValue::from(reason.wire()));
        }
        if let Some(me) = &shown.me {
            value.set("me", CoreValue::from(me.as_str()));
        }
        if let Some(host) = &shown.host {
            value.set("host", CoreValue::from(host.as_str()));
        }
        value.set("players", CoreValue::from(shown.players));
        value.set("connected", CoreValue::from(shown.connected));
        value.set("objects", CoreValue::from(shown.objects));
        value.set("journalTicks", CoreValue::from(self.journal.len() as u64));
        value.set("writesDropped", CoreValue::from(self.writes_dropped));
        value.set("scriptIgnored", CoreValue::from(self.script_ignored));
        state.set(NET_RUNTIME_KEY, value);
    }
}

/// The runtime key of the net view (display only, never checksummed).
pub(crate) const NET_RUNTIME_KEY: &str = "__net";

#[cfg(test)]
mod tests {
    use super::*;

    /// A run Studio serves never runs the relay, whatever the build links: no Studio-started game
    /// process reaches the network (MP-4a, the ProcessSandbox contract).
    #[test]
    fn a_run_studio_serves_never_runs_the_relay() {
        assert_ne!(build_mode(true), NetMode::Relay);
        let linked = cfg!(feature = "net") || cfg!(feature = "net-loopback");
        assert_eq!(build_mode(true), if linked { NetMode::Loopback } else { NetMode::Off });
        assert_eq!(build_mode(false) == NetMode::Relay, cfg!(feature = "net"));
    }
}
