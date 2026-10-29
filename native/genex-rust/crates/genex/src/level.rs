//! Level reachability (AAA review Track C): does a level make sense? A [`Level`] is the plan in
//! code (zones with a centre, the links between them, the spawn zone and the exits) and
//! [`Level::check`] walks it over a [`Nav`]: every zone reached from spawn along the mesh, exits
//! counted, dead ends listed and the world's edge tested. The [`LevelReport`] is what
//! `state().__level` carries for the harness (`to_json`, version 1).
//!
//! The nav must have run one `update` since its mesh was added (the runtime does it every tick); a
//! nav that has not answers no path and every zone reads unreachable.
//!
//! The check is geometric, so a plan that says a door joins two rooms passes only when the nav
//! really joins them. A *dead end* is a reachable zone, neither spawn nor exit, with at most one
//! neighbour in the plan; the report lists every one and the reader decides which were planned.
//! *Bounded* means every direction from every reachable zone ends at a solid wall at least
//! [`MIN_WALL_HEIGHT`] high: a ray runs over the mesh to its edge and the `boundary` function,
//! given the edge point and the ray's direction, answers the height of what stands there (0 for
//! nothing). A lower solid (furniture, a crate) is stepped over when the mesh resumes beyond it.

use crate::math::sin_cos;
use crate::nav::{Nav, NavFilter};
use crate::{Value, json};
use glam::Vec3;

/// A wall must stand at least this high, in metres, to count as the world's edge.
pub const MIN_WALL_HEIGHT: f32 = 2.0;
/// The report format `state().__level` carries.
pub const LEVEL_REPORT_VERSION: u32 = 1;
/// Directions tested around each zone centre.
const BOUNDARY_RAYS: usize = 16;
/// How far a boundary ray runs, in metres.
const BOUNDARY_RANGE: f32 = 400.0;
/// Low solids a ray steps over before the edge counts as open.
const HOPS_MAX: usize = 8;
/// How far past a low solid the ray looks for mesh again, in metres.
const HOP_METRES: f32 = 1.5;
/// How near a point must be to the mesh to stand on it, in metres.
const ON_MESH: f32 = 0.5;

/// A planned level: zones, the links between them, the spawn zone and the exits.
#[derive(Clone, Debug, Default)]
pub struct Level {
    zones: Vec<(String, Vec3)>,
    links: Vec<(String, String)>,
    spawn: Option<String>,
    exits: Vec<(String, String)>,
}

/// One zone's result.
#[derive(Clone, Debug, PartialEq)]
pub struct ZoneReport {
    /// The zone's id.
    pub id: String,
    /// Whether a walk from spawn reaches its centre.
    pub reachable: bool,
    /// Exits the plan puts in this zone.
    pub exits: usize,
}

/// A reachable zone with one way in and no exit.
#[derive(Clone, Debug, PartialEq)]
pub struct DeadEnd {
    /// The zone's id.
    pub zone: String,
    /// Its centre.
    pub at: [f32; 3],
}

/// What [`Level::check`] found.
#[derive(Clone, Debug, PartialEq)]
pub struct LevelReport {
    /// The spawn zone's id (empty when the plan names none).
    pub spawn: String,
    /// Every planned zone, in plan order.
    pub zones: Vec<ZoneReport>,
    /// Zones with an exit a player can reach.
    pub exits: Vec<String>,
    /// Reachable zones that lead nowhere.
    pub dead_ends: Vec<DeadEnd>,
    /// Whether every tested direction ends at a wall of at least [`MIN_WALL_HEIGHT`].
    pub bounded: bool,
}

impl Level {
    /// An empty plan.
    pub fn new() -> Level {
        Level::default()
    }

    /// A zone and the point a player walks to when visiting it.
    pub fn zone(mut self, id: &str, centre: Vec3) -> Level {
        self.zones.push((id.to_owned(), centre));
        self
    }

    /// A way between two zones (a door, stairs, an opening), either direction.
    pub fn link(mut self, a: &str, b: &str) -> Level {
        self.links.push((a.to_owned(), b.to_owned()));
        self
    }

    /// The zone the player starts in.
    pub fn spawn(mut self, id: &str) -> Level {
        self.spawn = Some(id.to_owned());
        self
    }

    /// An exit (or the goal) in a zone, of a kind the plan names (a gate, a door, stairs).
    pub fn exit(mut self, id: &str, kind: &str) -> Level {
        self.exits.push((id.to_owned(), kind.to_owned()));
        self
    }

    /// Walk the plan over `nav`: `boundary(edge, direction)` answers the height of the solid at a
    /// mesh edge the ray `direction` reached (0 for none).
    pub fn check(&self, nav: &Nav, boundary: &dyn Fn(Vec3, Vec3) -> f32) -> LevelReport {
        let spawn = self.spawn.as_deref().and_then(|id| self.centre(id));
        let reachable: Vec<bool> = self.zones.iter().map(|(_, centre)| spawn.is_some_and(|from| walks(nav, from, *centre))).collect();
        let zones: Vec<ZoneReport> = self
            .zones
            .iter()
            .zip(&reachable)
            .map(|((id, _), &reachable)| ZoneReport { id: id.clone(), reachable, exits: self.exits.iter().filter(|(zone, _)| zone == id).count() })
            .collect();
        let exits = zones.iter().filter(|zone| zone.reachable && zone.exits > 0).map(|zone| zone.id.clone()).collect();
        let dead_ends = self.dead_ends(&zones);
        let centres = self.zones.iter().zip(&reachable).filter(|(_, reach)| **reach).map(|((_, centre), _)| *centre);
        let bounded = centres.clone().next().is_some() && centres.into_iter().all(|centre| closed_around(nav, centre, boundary));
        LevelReport { spawn: self.spawn.clone().unwrap_or_default(), zones, exits, dead_ends, bounded }
    }

    fn centre(&self, id: &str) -> Option<Vec3> {
        self.zones.iter().find(|(zone, _)| zone == id).map(|(_, centre)| *centre)
    }

    fn neighbours(&self, id: &str) -> usize {
        let mut seen: Vec<&str> = Vec::new();
        for (a, b) in &self.links {
            let other = if a == id { b } else if b == id { a } else { continue };
            if other != id && !seen.contains(&other.as_str()) {
                seen.push(other);
            }
        }
        seen.len()
    }

    fn dead_ends(&self, zones: &[ZoneReport]) -> Vec<DeadEnd> {
        let spawn = self.spawn.as_deref();
        zones
            .iter()
            .filter(|zone| zone.reachable && zone.exits == 0 && Some(zone.id.as_str()) != spawn && self.neighbours(&zone.id) <= 1)
            .filter_map(|zone| self.centre(&zone.id).map(|centre| DeadEnd { zone: zone.id.clone(), at: centre.to_array() }))
            .collect()
    }
}

/// Whether a complete path joins two points on the mesh.
fn walks(nav: &Nav, from: Vec3, to: Vec3) -> bool {
    let on = |point: Vec3| nav.closest_point(point, ON_MESH).is_some();
    on(from) && on(to) && nav.path(from, to, &NavFilter::new()).is_some_and(|path| !path.partial)
}

/// Whether every ray from `centre` ends at a wall tall enough.
fn closed_around(nav: &Nav, centre: Vec3, boundary: &dyn Fn(Vec3, Vec3) -> f32) -> bool {
    (0..BOUNDARY_RAYS).all(|ray| {
        let (sin, cos) = sin_cos(std::f32::consts::TAU * ray as f32 / BOUNDARY_RAYS as f32);
        ends_at_wall(nav, centre, Vec3::new(cos, 0.0, sin), boundary)
    })
}

fn ends_at_wall(nav: &Nav, from: Vec3, direction: Vec3, boundary: &dyn Fn(Vec3, Vec3) -> f32) -> bool {
    let mut start = from;
    for _ in 0..=HOPS_MAX {
        let Some(hit) = nav.raycast(start, start + direction * BOUNDARY_RANGE, &NavFilter::new()) else { return false };
        if !hit.blocked {
            return false;
        }
        let height = boundary(hit.position, direction);
        if height >= MIN_WALL_HEIGHT {
            return true;
        }
        let beyond = hit.position + direction * HOP_METRES;
        if height <= 0.0 || nav.closest_point(beyond, ON_MESH).is_none() {
            return false;
        }
        start = beyond;
    }
    false
}

impl LevelReport {
    /// The JSON `state().__level` carries (version 1): `spawn`, `zones` by id with `reachable` and
    /// `exits`, `exits` (zones with a reachable exit), `deadEnds` and `bounded`.
    pub fn to_json(&self) -> Value {
        let zones: serde_json::Map<String, Value> =
            self.zones.iter().map(|zone| (zone.id.clone(), json!({ "reachable": zone.reachable, "exits": zone.exits }))).collect();
        let dead_ends: Vec<Value> = self.dead_ends.iter().map(|end| json!({ "zone": end.zone, "at": end.at })).collect();
        json!({ "version": LEVEL_REPORT_VERSION, "spawn": self.spawn, "zones": zones, "exits": self.exits, "deadEnds": dead_ends, "bounded": self.bounded })
    }
}
