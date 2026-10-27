//! `genex::nav`: navigation, genex-nav's surface re-exported. The runtime owns the nav as it owns
//! physics: `game.navigation(config)` registers it and every seed rebuilds `sim.nav` as an empty
//! nav for that walker; a reset bakes (or reads) a `NavMesh` and adds it. Agents, links, bodies,
//! queries, the probe and saves are genex-nav's `agents_api`; streamed islands are its `stream` module.

pub use genex_nav::agents_api::{
    NAV_AGENTS_MAX, NAV_BODIES_MAX, NAV_SNAPSHOT_VERSION, NAV_SPEED_DEFAULT, NAV_SPEED_MAX_DEFAULT, NavAgent, NavBody, NavHit,
    NavLinkReached, NavPath, NavPoint, NavStatus, NavStep,
};
pub use genex_nav::carve::{NAV_BAKE_UNITS_PER_TICK_DEFAULT, NAV_OBSTACLES_MAX, NAV_REBUILD_STAGES, NavObstacle};
pub use genex_nav::debug::NavDebugLine;
pub use genex_nav::error::NavError;
pub use genex_nav::filter::NavFilter;
pub use genex_nav::input::{HeightGrid, NAV_AREA_VOLUMES_MAX, NAV_INPUT_TRIANGLES_MAX, NavArea, NavInput, TerrainHeights};
#[cfg(feature = "physics-raw")]
pub use genex_nav::input_rapier::ColliderView;
// NAV_MEMO_BYTES_MAX_PHONE stays in genex-nav until the runtime applies a per-class cap.
pub use genex_nav::memo::NAV_MEMO_BYTES_MAX;
pub use genex_nav::links::{NAV_LINKS_MAX, NavLink, NavLinkKind};
pub use genex_nav::stream::{NavIsland, NavIslands, StreamedNav};
pub use genex_nav::tile::NavTile;
pub use genex_nav::world::{NAV_SEARCH_NODES_DEFAULT, NAV_SEARCHES_PER_TICK_DEFAULT, NAV_TILES_MAX, NavBudget, NavMesh, NavMeshSource};
pub use genex_nav::{AgentId, Nav, NavBodyId, NavConfig, NavDebug, NavErrorCode, NavLinkId, NavObstacleId};

/// Whether this build links navigation (the facade's `nav` feature; `[nav] enabled = false` in a
/// game's genex.toml leaves it out, release R-1). Without it `install` refuses `game.navigation`
/// and `game.nav_bake` `nav-disabled`, and the runtime never bakes, saves or restores a nav, so
/// none of genex-nav's engine is linked; `sim.nav` stays an empty nav the game's code compiles
/// against.
pub(crate) const NAV_BUILT: bool = cfg!(feature = "nav");

/// The nav a seed starts with: empty, for the registered walker (the default walker when the
/// game registered none).
pub(crate) fn fresh(config: Option<&NavConfig>) -> Nav {
    config.map_or_else(Nav::default, Nav::new)
}
