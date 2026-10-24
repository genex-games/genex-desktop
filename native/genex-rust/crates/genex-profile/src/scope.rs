//! What a scope is called: the engine's stages as a closed vocabulary ([`EngineScope`]) and a
//! game's own names ([`ScopeName`]), checked when the game compiles. Each scope site gets one
//! puffin scope id the first time it runs; the id's name lives in a lock-free table, so the
//! recorder resolves names without taking a lock on the frame path.
//!
//! A scope only records on a thread attached to a [`crate::recorder::Profiler`] whose scopes are
//! on; anywhere else entering one costs a thread-local read. Scopes are write-only: nothing a tick
//! computes can read them back.

use std::sync::OnceLock;

use puffin::{ProfilerScope, ScopeId, ThreadProfiler};

use crate::caps::SCOPE_IDS_MAX;
use crate::recorder;

/// The longest scope or counter name, in bytes.
pub const SCOPE_NAME_MAX_BYTES: usize = 48;

/// A stage the runtime times. Wire values: never rename one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum EngineScope {
    /// One whole frame: the summary's CPU time, never one of its top scopes.
    Frame,
    /// One simulation tick.
    Tick,
    /// The game's update hooks.
    Update,
    /// The physics step.
    Physics,
    /// Animation sampling and blending.
    Anim,
    /// Navigation queries and crowds.
    Nav,
    /// World streaming's commit of loaded cells.
    StreamCommit,
    /// Gameplay UI.
    Ui,
    /// The audio mixer's game-thread work.
    Audio,
    /// The draw hooks.
    Draw,
    /// Command encoding.
    Encode,
    /// Queue submission.
    Submit,
    /// Presenting the frame.
    Present,
    /// A capture's readback.
    Capture,
    /// Loading an asset.
    AssetLoad,
    /// Compiling a pipeline.
    PipelineCompile,
    /// Writing or reading a save.
    Save,
    /// Choosing the drawn characters' poses (inside the frame's draw, lane CP).
    Pose,
    /// Planning the renderer's frame: its draws, skinning jobs and tables (inside the draw).
    Plan,
}

/// How many engine scopes there are.
const ENGINE_SCOPES: usize = 19;

impl EngineScope {
    /// Every engine scope, in declaration order.
    pub const ALL: &'static [EngineScope; ENGINE_SCOPES] = &[
        EngineScope::Frame,
        EngineScope::Tick,
        EngineScope::Update,
        EngineScope::Physics,
        EngineScope::Anim,
        EngineScope::Nav,
        EngineScope::StreamCommit,
        EngineScope::Ui,
        EngineScope::Audio,
        EngineScope::Draw,
        EngineScope::Encode,
        EngineScope::Submit,
        EngineScope::Present,
        EngineScope::Capture,
        EngineScope::AssetLoad,
        EngineScope::PipelineCompile,
        EngineScope::Save,
        EngineScope::Pose,
        EngineScope::Plan,
    ];

    /// The scope's wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            EngineScope::Frame => "frame",
            EngineScope::Tick => "tick",
            EngineScope::Update => "update",
            EngineScope::Physics => "physics",
            EngineScope::Anim => "anim",
            EngineScope::Nav => "nav",
            EngineScope::StreamCommit => "stream-commit",
            EngineScope::Ui => "ui",
            EngineScope::Audio => "audio",
            EngineScope::Draw => "draw",
            EngineScope::Encode => "encode",
            EngineScope::Submit => "submit",
            EngineScope::Present => "present",
            EngineScope::Capture => "capture",
            EngineScope::AssetLoad => "asset-load",
            EngineScope::PipelineCompile => "pipeline-compile",
            EngineScope::Save => "save",
            EngineScope::Pose => "pose",
            EngineScope::Plan => "plan",
        }
    }

    /// The scope spelled `text`, or None.
    pub fn from_wire(text: &str) -> Option<EngineScope> {
        EngineScope::ALL.iter().copied().find(|scope| scope.wire() == text)
    }
}

/// A name a game gives a profile scope or counter: 1..=48 bytes of `a-z`, `0-9`, `_`, `.`, `-`.
/// Built in a const context ([`crate::profile_scope!`] always does), an invalid name is a compile
/// error, never a runtime refusal.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ScopeName(&'static str);

impl ScopeName {
    /// `name`, checked: panics (a compile error in a const) when it is empty, longer than 48
    /// bytes, or holds anything but `a-z`, `0-9`, `_`, `.` and `-`.
    pub const fn new(name: &'static str) -> ScopeName {
        assert!(is_scope_name(name), "a scope name is 1..=48 bytes of a-z, 0-9, '_', '.' and '-'");
        ScopeName(name)
    }

    /// `name` when it is a valid scope name, or None (for names that arrive at run time).
    pub const fn try_new(name: &'static str) -> Option<ScopeName> {
        if is_scope_name(name) { Some(ScopeName(name)) } else { None }
    }

    /// The name as written.
    pub const fn as_str(self) -> &'static str {
        self.0
    }
}

/// Whether `name` is 1..=48 bytes of `a-z`, `0-9`, `_`, `.` and `-`.
pub const fn is_scope_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    if bytes.is_empty() || bytes.len() > SCOPE_NAME_MAX_BYTES {
        return false;
    }
    let mut at = 0;
    while at < bytes.len() {
        let byte = bytes[at];
        let allowed = byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'.' | b'-');
        if !allowed {
            return false;
        }
        at += 1;
    }
    true
}

/// What a recorded scope is: an engine stage or a game's named scope.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ScopeKey {
    /// One of the runtime's stages.
    Engine(EngineScope),
    /// A scope a game named.
    Game(ScopeName),
}

impl ScopeKey {
    /// The name the summary and the report show.
    pub const fn name(self) -> &'static str {
        match self {
            ScopeKey::Engine(scope) => scope.wire(),
            ScopeKey::Game(name) => name.as_str(),
        }
    }

    /// Whether a game named it.
    pub const fn is_game(self) -> bool {
        matches!(self, ScopeKey::Game(_))
    }

    /// The marker puffin's scope details carry as their function name.
    const fn origin(self) -> &'static str {
        match self {
            ScopeKey::Engine(_) => "genex.engine",
            ScopeKey::Game(_) => "genex.game",
        }
    }
}

/// Every genex scope id's key, indexed by id. Set once per site, read without locks.
static KEYS: [OnceLock<ScopeKey>; SCOPE_IDS_MAX] = [const { OnceLock::new() }; SCOPE_IDS_MAX];
/// The engine scopes' ids, registered the first time each is entered.
static ENGINE_IDS: [OnceLock<ScopeId>; ENGINE_SCOPES] = [const { OnceLock::new() }; ENGINE_SCOPES];

/// The table slot of `id`.
fn slot(id: ScopeId) -> usize {
    usize::try_from(id.0.get()).unwrap_or(usize::MAX)
}

/// The key of a genex scope id; None for another library's scope or a site past the table.
pub fn key_of(id: ScopeId) -> Option<ScopeKey> {
    KEYS.get(slot(id))?.get().copied()
}

/// A new puffin scope id for `key`, entered in the name table when it fits.
fn register(key: ScopeKey) -> ScopeId {
    let id = ThreadProfiler::call(|profiler| profiler.register_named_scope(key.name(), key.origin(), "", 0));
    if let Some(entry) = KEYS.get(slot(id)) {
        let _ = entry.set(key);
    }
    id
}

/// An open scope: it closes when dropped. Never sent between threads (puffin's scope is not Send).
#[must_use = "a scope closes when this guard drops"]
pub struct ScopeGuard {
    _scope: Option<ProfilerScope>,
}

impl ScopeGuard {
    /// A guard that recorded nothing.
    const fn off() -> ScopeGuard {
        ScopeGuard { _scope: None }
    }

    /// Open the scope `id` stands for when this thread records and the id has a name.
    fn open(id: ScopeId) -> ScopeGuard {
        if key_of(id).is_none() {
            recorder::count_unnamed_scope();
            return ScopeGuard::off();
        }
        ScopeGuard { _scope: Some(ProfilerScope::new(id, "")) }
    }

    /// Whether this guard is timing a scope.
    pub fn is_recording(&self) -> bool {
        self._scope.is_some()
    }
}

/// Time the rest of the enclosing block as the engine stage `stage`.
pub fn scope(stage: EngineScope) -> ScopeGuard {
    if !recorder::thread_records() {
        return ScopeGuard::off();
    }
    // Declaration order is ALL's order, so the discriminant is the stage's slot.
    let id = ENGINE_IDS[stage as usize].get_or_init(|| register(ScopeKey::Engine(stage)));
    ScopeGuard::open(*id)
}

/// One `profile_scope!` call site: its checked name and, after the first entry, its scope id.
#[doc(hidden)]
pub struct Site {
    name: ScopeName,
    id: OnceLock<ScopeId>,
}

impl Site {
    /// A site named `name` (a const, so a bad name fails the build).
    pub const fn new(name: ScopeName) -> Site {
        Site { name, id: OnceLock::new() }
    }

    /// Open this site's scope; it closes when the guard drops.
    pub fn enter(&'static self) -> ScopeGuard {
        if !recorder::thread_records() {
            return ScopeGuard::off();
        }
        let id = self.id.get_or_init(|| register(ScopeKey::Game(self.name)));
        ScopeGuard::open(*id)
    }
}

/// Time the rest of the enclosing block under `name`, a string literal checked when the game
/// compiles. Costs a thread-local read when scopes are off; never changes what a tick computes.
///
/// ```
/// fn update() {
///     genex_profile::profile_scope!("enemy_ai");
///     // …
/// }
/// ```
#[macro_export]
macro_rules! profile_scope {
    ($name:literal) => {
        let _genex_profile_scope = {
            static SITE: $crate::scope::Site = $crate::scope::Site::new($crate::scope::ScopeName::new($name));
            SITE.enter()
        };
    };
}
