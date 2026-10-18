//! `genex::nav`: navigation, genex-nav's surface re-exported. The runtime owns the nav as it owns
//! physics: `game.navigation(config)` registers it and every seed rebuilds `sim.nav`.
//!
//! Stub until NAV-11 fills it: `sim.nav` is an empty world.

pub use genex_nav::{AgentId, Nav, NavBodyId, NavConfig, NavDebug, NavErrorCode, NavLinkId, NavObstacleId};

/// The nav a seed starts with, for the game's registration (none: an empty world).
pub(crate) fn fresh(config: Option<&NavConfig>) -> Nav {
    let _ = config;
    Nav::default()
}
