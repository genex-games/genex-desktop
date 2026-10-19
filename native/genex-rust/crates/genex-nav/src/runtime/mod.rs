//! The navigation runtime, ported from landmass (MIT OR Apache-2.0): islands and stitching, agents,
//! A*, funnel paths, links, avoidance (dodgy_2d) and Detour-style queries.
//!
//! Filled so far: the islands-and-stitching core (NAV-4: `coords`, `nav_mesh`, `island`,
//! `nav_data`, `geometry`, `util`, `clip`, `grid`, `disjoint`, and the link data in `link`) and
//! avoidance (NAV-6: `avoidance`, `dodgy`). Each other sub-module is a stub until the work package
//! it names fills it. Every ported file's header names its upstream file, licence and changes.

pub mod coords;
pub mod nav_mesh;
pub mod island;
pub mod nav_data;
pub mod geometry;
pub mod util;
pub mod clip;
pub mod grid;
pub mod disjoint;
pub mod archipelago;
pub mod agent;
pub mod character;
pub mod astar;
pub mod path;
pub mod pathfinding;
pub mod query;
pub mod link;
pub mod avoidance;
pub mod detour;
pub mod dodgy;
