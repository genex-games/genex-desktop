//! The handles a `Nav` hands out. They are generational: a removed id stays dead.

/// An agent.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct AgentId(pub(crate) u64);

impl AgentId {
    /// The raw number, for probes and saves.
    pub const fn raw(self) -> u64 {
        self.0
    }
}

/// An off-mesh link.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct NavLinkId(pub(crate) u64);

impl NavLinkId {
    /// The raw number, for probes and saves.
    pub const fn raw(self) -> u64 {
        self.0
    }
}

/// A body agents avoid.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct NavBodyId(pub(crate) u64);

impl NavBodyId {
    /// The raw number, for probes and saves.
    pub const fn raw(self) -> u64 {
        self.0
    }
}

/// An obstacle (an avoidance disc or a carving volume).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct NavObstacleId(pub(crate) u64);

impl NavObstacleId {
    /// The raw number, for probes and saves.
    pub const fn raw(self) -> u64 {
        self.0
    }
}
