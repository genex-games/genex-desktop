//! Debug drawing: segment lists per tile for `frame.nav_debug`.
//!
//! Stub until NAV-16 fills it: no segments.

use crate::world::Nav;
use glam::Vec3;

/// What `frame.nav_debug` draws (polygons, links, agents' paths).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct NavDebug {}

/// The line segments that draw `nav` as `debug` asks, as pairs of points.
pub fn segments(nav: &Nav, debug: NavDebug) -> Vec<[Vec3; 2]> {
    let _ = (nav, debug);
    Vec::new()
}
