//! The navigation runtime, ported from landmass (MIT OR Apache-2.0): islands and stitching, agents,
//! A*, funnel paths, links, avoidance (dodgy_2d) and Detour-style queries.
//!
//! Each sub-module is a stub until the work package it names fills it.

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
