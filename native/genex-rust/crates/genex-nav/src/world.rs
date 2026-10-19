//! `Nav`: the navigation world a game's `sim.nav` holds (the runtime owns it, as it owns physics).
//!
//! Stub until NAV-11 fills it: an empty world with no tiles and no agents.

/// The navigation world: tiles, agents, links and obstacles.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Nav {}
