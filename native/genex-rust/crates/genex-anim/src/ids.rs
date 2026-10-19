//! The handles genex-anim hands out: plain numbers in typed wrappers, so a joint index is never
//! passed where a clip is meant.

/// A joint of a skeleton, by its parent-first index.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct JointId(pub(crate) u16);

impl JointId {
    /// The raw number, for probes and saves.
    pub const fn raw(self) -> u16 {
        self.0
    }
}

/// A clip of a character asset.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ClipId(pub(crate) u32);

impl ClipId {
    /// The raw number, for probes and saves.
    pub const fn raw(self) -> u32 {
        self.0
    }
}

/// A state of an animation graph.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct StateId(pub(crate) u32);

impl StateId {
    /// The raw number, for probes and saves.
    pub const fn raw(self) -> u32 {
        self.0
    }
}

/// A layer of an animation graph.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct LayerId(pub(crate) u32);

impl LayerId {
    /// The raw number, for probes and saves.
    pub const fn raw(self) -> u32 {
        self.0
    }
}

/// A parameter of an animation graph.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ParamId(pub(crate) u32);

impl ParamId {
    /// The raw number, for probes and saves.
    pub const fn raw(self) -> u32 {
        self.0
    }
}

/// An event a graph declares.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct EventId(pub(crate) u32);

impl EventId {
    /// The raw number, for probes and saves.
    pub const fn raw(self) -> u32 {
        self.0
    }
}
