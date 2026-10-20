//! `genex::nav`: navigation, genex-nav's surface re-exported. The runtime owns the nav as it owns
//! physics: `game.navigation(config)` registers it and every seed rebuilds `sim.nav` as an empty
//! nav for that walker; a reset bakes (or reads) a `NavMesh` and adds it. Agents, links, bodies
//! and queries arrive with NAV-12.

pub use genex_nav::carve::{NAV_BAKE_UNITS_PER_TICK_DEFAULT, NAV_OBSTACLES_MAX, NAV_REBUILD_STAGES, NavObstacle};
pub use genex_nav::error::NavError;
pub use genex_nav::input::{HeightGrid, NAV_AREA_VOLUMES_MAX, NAV_INPUT_TRIANGLES_MAX, NavArea, NavInput, TerrainHeights};
pub use genex_nav::memo::{NAV_MEMO_BYTES_MAX, NAV_MEMO_BYTES_MAX_PHONE};
pub use genex_nav::tile::NavTile;
pub use genex_nav::world::{NAV_SEARCH_NODES_DEFAULT, NAV_SEARCHES_PER_TICK_DEFAULT, NAV_TILES_MAX, NavBudget, NavMesh, NavMeshSource};
pub use genex_nav::{AgentId, Nav, NavBodyId, NavConfig, NavDebug, NavErrorCode, NavLinkId, NavObstacleId};

/// The nav a seed starts with: empty, for the registered walker (the default walker when the
/// game registered none).
pub(crate) fn fresh(config: Option<&NavConfig>) -> Nav {
    config.map_or_else(Nav::default, Nav::new)
}
