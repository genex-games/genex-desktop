//! genex-nav: navigation for genex games, below the facade. Recast navmesh generation (a port of
//! rerecast), tiled bakes, a runtime of islands, agents, A* and funnel paths, ORCA avoidance,
//! off-mesh links, area costs, carving and Detour-style queries. Everything here is simulation
//! state: deterministic on every destination (glam scalar-math and libm, `Map`, no clock, rand or
//! thread), saveable and probe-visible. Tiles sit on a grid anchored at world (0, 0) whose size
//! divides the stream cell size, keyed by genex-core's `CellId`.
//!
//! Every planned module is declared now so each work package fills one body (game systems
//! EP-0a1); a module that names its work package is still a stub.

pub mod error;
pub mod ids;
pub mod recast;
pub mod runtime;
pub mod arena;
pub mod bake;
pub mod tile;
pub mod input;
pub mod carve;
pub mod links;
pub mod filter;
pub mod config;
pub mod world;
pub mod memo;
pub mod agents_api;
pub mod stream;
pub mod debug;
#[cfg(feature = "physics")]
pub mod input_rapier;

pub use bake::{BakeConfig, bake_tile};
pub use config::NavConfig;
pub use debug::NavDebug;
pub use error::{NavError, NavErrorCode};
pub use ids::{AgentId, NavBodyId, NavLinkId, NavObstacleId};
pub use input::{NavArea, NavInput};
pub use tile::NavTile;
pub use world::Nav;
