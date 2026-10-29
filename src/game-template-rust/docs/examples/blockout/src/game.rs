//! GREYBOX: replace every box here before done. This is a blockout, the first third of a build:
//! the whole level from its plan (`plan.rs`) in grey boxes with colliders, walkable end to end
//! before any art. Then each zone gets its look in turn (`docs/look-recipes.md`), its kit and its
//! props (`docs/examples/rooms-and-buildings.md`), from its `hero:<zone>` camera.
//!
//! Everything is built from the plan: floors, walls with an opening at every link, the boundary,
//! the colliders, a nav baked from those colliders, a `zone:<id>` tag per zone, a `hero:<zone>`
//! camera per zone, the top-down `map:top` camera, and the `__level` probe that says whether every
//! zone and exit can be walked to from the spawn and whether the boundary holds, beside the `plan`
//! probe that prints the plan as the lines of `docs/LEVEL.md`.

use genex::nav::{Nav, NavArea, NavConfig, NavFilter, NavInput, NavMesh};
use genex::physics::ColliderBuilder;
use genex::prelude::*;
use genex::render::Environment;
use genex::FIXED_STEP_MS;

use crate::plan::{BoundaryKind, LinkKind, Plan, Zone};

/// Walls: their height, thickness (inside the zone's floor) and a door's head.
const WALL_HEIGHT: f32 = 3.0;
const WALL: f32 = 0.2;
const DOOR_HEAD: f32 = 2.1;
/// A boundary's thickness; a locked door sits in its wall, a hand's width proud of it.
const BOUNDARY_THICK: f32 = 0.2;
const LOCKED_DOOR_THICK: f32 = 0.5;
/// The floor slab under every zone.
const FLOOR_DEPTH: f32 = 0.2;
/// The walker the nav is baked for: the character controller's capsule.
const WALKER: (f32, f32) = (0.35, 1.8);
/// How close a point on a wall line counts as on it, in metres.
const ON_LINE: f32 = 0.01;
/// The eye of the player and of every hero camera, and the map camera's height over the level.
const EYE: f32 = 1.6;
const MAP_HEIGHT: f32 = 80.0;
/// The share of the level's size the map camera adds round it.
const MAP_MARGIN: f32 = 1.1;
/// A boundary that holds stands this high (the default jump rises about 1.1 m), and an exit leaves
/// this much of it open round its point.
const HOLD: f32 = 2.0;
const EXIT_GAP: f32 = 2.5;
/// How far apart the boundary check samples an edge, in metres.
const EDGE_STEP: f32 = 0.5;

/// The blockout keeps nothing of its own: the plan builds the level on every seed.
#[derive(Default)]
pub struct World;

/// What a box is for: it picks its grey and whether it is solid.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Role {
    Floor,
    Wall,
    Edge(BoundaryKind),
    Marker,
}

/// One box of the blockout, in the zone it belongs to.
#[derive(Clone, Copy, Debug)]
struct Solid {
    zone: &'static str,
    min: Vec3,
    max: Vec3,
    role: Role,
}

impl Solid {
    fn solid(&self) -> bool {
        match self.role {
            Role::Edge(kind) => kind.solid(),
            Role::Marker => false,
            _ => true,
        }
    }
}

/// Register the blockout of `plan`.
pub fn wire(game: &mut Game<World>, plan: &'static Plan) {
    game.navigation(NavConfig::walker(WALKER.0, WALKER.1).with_tile(16.0));
    game.on_reset(move |sim, _seed, _rng, _gfx| build(sim, plan));
    game.on_update(|sim, ctx| sim.nav.update(ctx.dt));
    game.on_draw(move |_sim, frame, _camera| draw(frame, plan));
    game.camera(move |_sim| player_camera(plan));
    game.named_camera("map:top", move |_sim| map_camera(plan));
    for zone in plan.zones {
        let camera = hero_camera(zone);
        game.named_camera(&format!("hero:{}", zone.id), move |_sim| camera);
    }
    game.probe("__level", move |sim| level(&sim.nav, plan));
    game.probe("plan", move |_sim| plan.lines());
}

/// The colliders of every solid box, then the nav baked from them.
fn build(sim: &mut Sim<World>, plan: &Plan) {
    for solid in solids(plan).iter().filter(|solid| solid.solid()) {
        let half = (solid.max - solid.min) * 0.5;
        let collider = ColliderBuilder::cuboid(half.x, half.y, half.z).translation(solid.min + half);
        sim.physics.insert_collider(collider, None);
    }
    let input = NavInput::new().with_static_colliders(&sim.physics, NavArea::WALK).expect("the blockout's colliders bake");
    let mesh = NavMesh::bake(&input, sim.nav.config()).expect("the blockout bakes");
    sim.nav.add_mesh(&mesh).expect("its tiles fit");
    sim.nav.update(FIXED_STEP_MS as f32 / 1000.0);
}

// region: level-probe
/// The level's reachability report, `state().__level`: whether each zone can be walked to from the
/// spawn, which zones hold a reachable exit, the dead ends the plan did not mean, and whether the
/// boundary holds the player in.
fn level(nav: &Nav, plan: &Plan) -> Value {
    let from = ground(plan.spawn);
    let walk = |to: Vec2| nav.path(from, ground(to), &NavFilter::new()).is_some_and(|path| !path.partial);
    let mut zones = json!({});
    for zone in plan.zones {
        zones[zone.id] = json!({ "reachable": walk(zone.centre()), "exits": plan.links_of(zone.id) });
    }
    let exits: Vec<&str> = plan.exits.iter().filter(|exit| walk(exit.at)).map(|exit| exit.zone).collect();
    let start = spawn_zone(plan).map(|zone| zone.id);
    let unplanned = |zone: &&Zone| plan.links_of(zone.id) < 2 && Some(zone.id) != start && !plan.planned_end(zone.id);
    let dead_ends: Vec<Value> = plan.zones.iter().filter(unplanned).map(|zone| json!({ "zone": zone.id, "at": ground(zone.centre()).to_array() })).collect();
    json!({ "version": 1, "spawn": start, "zones": zones, "exits": exits, "deadEnds": dead_ends, "bounded": bounded(plan) })
}

/// Whether every outer edge of the floors (one no other zone continues past) is closed by a solid
/// box from the ground to at least `HOLD` high, but at an exit, the one planned way out.
fn bounded(plan: &Plan) -> bool {
    let solids = solids(plan);
    let closed = |at: Vec2| {
        let blocks = |s: &Solid| s.solid() && s.role != Role::Floor && s.min.y <= 0.0 && s.max.y >= HOLD;
        solids.iter().filter(|s| blocks(s)).any(|s| (s.min.x..=s.max.x).contains(&at.x) && (s.min.z..=s.max.z).contains(&at.y))
    };
    let at_exit = |at: Vec2| plan.exits.iter().any(|exit| exit.at.distance(at) <= EXIT_GAP);
    plan.zones.iter().all(|zone| {
        edges(zone).into_iter().all(|edge| {
            let outward = -edge.inward;
            edge.samples().all(|at| plan.zones.iter().any(|other| other.holds(at + outward * 0.3)) || at_exit(at) || closed(at + edge.inward * 0.05))
        })
    })
}
// endregion

/// A point on the floor at `at`.
fn ground(at: Vec2) -> Vec3 {
    vec3(at.x, 0.0, at.y)
}

/// The zone whose floor holds the spawn.
fn spawn_zone(plan: &Plan) -> Option<&Zone> {
    plan.zones.iter().find(|zone| zone.holds(plan.spawn))
}

/// One side of a zone's floor: along x or z, the line it lies on, its span, and which way is in.
#[derive(Clone, Copy, Debug)]
struct Edge {
    along_x: bool,
    line: f32,
    span: (f32, f32),
    inward: Vec2,
}

impl Edge {
    /// The point `along` the edge.
    fn at(&self, along: f32) -> Vec2 {
        if self.along_x { vec2(along, self.line) } else { vec2(self.line, along) }
    }

    /// Points every `EDGE_STEP` along it, half a step in from each end.
    fn samples(self) -> impl Iterator<Item = Vec2> {
        let count = ((self.span.1 - self.span.0) / EDGE_STEP).round() as u32;
        (0..count).map(move |i| self.at(self.span.0 + (i as f32 + 0.5) * EDGE_STEP))
    }
}

/// A zone's four sides.
fn edges(zone: &Zone) -> [Edge; 4] {
    let (min, max) = (zone.min, zone.max);
    [
        Edge { along_x: true, line: min.y, span: (min.x, max.x), inward: Vec2::Y },
        Edge { along_x: true, line: max.y, span: (min.x, max.x), inward: -Vec2::Y },
        Edge { along_x: false, line: min.x, span: (min.y, max.y), inward: Vec2::X },
        Edge { along_x: false, line: max.x, span: (min.y, max.y), inward: -Vec2::X },
    ]
}

/// Every box of the level: each zone's floor and walls, then the boundary and the markers.
fn solids(plan: &Plan) -> Vec<Solid> {
    let mut out = Vec::new();
    for zone in plan.zones {
        let (min, max) = (zone.min, zone.max);
        out.push(Solid { zone: zone.id, min: vec3(min.x, -FLOOR_DEPTH, min.y), max: vec3(max.x, 0.0, max.y), role: Role::Floor });
        if zone.indoors {
            walls(plan, zone, &mut out);
        }
    }
    for edge in plan.boundary {
        let thick = if edge.kind == BoundaryKind::LockedDoor { LOCKED_DOOR_THICK } else { BOUNDARY_THICK };
        let (lo, hi) = (edge.from.min(edge.to) - Vec2::splat(thick * 0.5), edge.from.max(edge.to) + Vec2::splat(thick * 0.5));
        out.push(Solid { zone: edge.zone, min: vec3(lo.x, 0.0, lo.y), max: vec3(hi.x, edge.kind.height(), hi.y), role: Role::Edge(edge.kind) });
    }
    for (zone, at) in plan.exits.iter().map(|exit| (exit.zone, exit.at)).chain(spawn_zone(plan).map(|zone| (zone.id, plan.spawn))) {
        out.push(Solid { zone, min: vec3(at.x - 0.5, 0.0, at.y - 0.5), max: vec3(at.x + 0.5, 0.02, at.y + 0.5), role: Role::Marker });
    }
    out
}

/// A zone's four walls, inside its floor, with an opening at every link (a door's with its head).
fn walls(plan: &Plan, zone: &Zone, out: &mut Vec<Solid>) {
    for edge in edges(zone) {
        let (from, to) = edge.span;
        let mut gaps: Vec<(f32, f32, LinkKind)> = plan
            .links
            .iter()
            .filter(|link| link.from == zone.id || link.to == zone.id)
            .filter_map(|link| {
                let (across, along) = if edge.along_x { (link.at.y, link.at.x) } else { (link.at.x, link.at.y) };
                let on = (across - edge.line).abs() < ON_LINE && (from..=to).contains(&along);
                on.then_some((along - link.width * 0.5, along + link.width * 0.5, link.kind))
            })
            .collect();
        gaps.sort_by(|a, b| a.0.total_cmp(&b.0));
        let inner = edge.line + (edge.inward.x + edge.inward.y) * WALL;
        let (c0, c1) = (edge.line.min(inner), edge.line.max(inner));
        let piece = |a: f32, b: f32, y0: f32| {
            let (lo, hi) = if edge.along_x { (vec3(a, y0, c0), vec3(b, WALL_HEIGHT, c1)) } else { (vec3(c0, y0, a), vec3(c1, WALL_HEIGHT, b)) };
            Solid { zone: zone.id, min: lo, max: hi, role: Role::Wall }
        };
        let mut at = from;
        for (a, b, kind) in gaps {
            out.push(piece(at, a, 0.0));
            if kind == LinkKind::Door {
                out.push(piece(a, b, DOOR_HEAD));
            }
            at = b;
        }
        out.push(piece(at, to, 0.0));
    }
}

/// The grey of each role: walls lighter than floors, the edge darker, markers bright.
fn material(role: Role) -> Material {
    let color = match role {
        Role::Floor => Color::rgb(150, 150, 146),
        Role::Wall => Color::rgb(184, 184, 180),
        Role::Edge(BoundaryKind::LockedDoor) => Color::rgb(120, 84, 60),
        Role::Edge(BoundaryKind::Backdrop) => Color::rgb(130, 136, 148),
        Role::Edge(_) => Color::rgb(80, 80, 84),
        Role::Marker => Color::rgb(230, 200, 60),
    };
    Material::color(color).with_roughness(0.9)
}

fn draw(frame: &mut Frame, plan: &Plan) {
    frame.clear(Color::rgb(130, 170, 220)).ambient(Color::rgb(180, 200, 230), 0.1);
    frame.sun(vec3(0.4, 1.0, 0.3), Color::WHITE, 2.5);
    frame.environment(Environment::sky());
    let solids = solids(plan);
    for zone in plan.zones {
        frame.tag(&format!("zone:{}", zone.id));
        for solid in solids.iter().filter(|solid| solid.zone == zone.id) {
            frame.cube_with(Transform::from_translation((solid.min + solid.max) * 0.5).with_scale(solid.max - solid.min), &material(solid.role));
        }
    }
}

/// The player's view at the spawn, looking at the first way on.
fn player_camera(plan: &Plan) -> Camera {
    let eye = ground(plan.spawn) + Vec3::Y * EYE;
    let start = spawn_zone(plan).map(|zone| zone.id);
    let next = plan.links.iter().find(|link| Some(link.from) == start || Some(link.to) == start).map_or(Vec2::ZERO, |link| link.at);
    Camera { fovy: 70.0, ..Camera::look_at(eye, ground(next) + Vec3::Y * EYE) }
}

/// Straight down over the whole level, orthographic, north (-z) at the top: the plan as built.
fn map_camera(plan: &Plan) -> Camera {
    let lo = plan.zones.iter().fold(Vec2::splat(f32::MAX), |lo, zone| lo.min(zone.min));
    let hi = plan.zones.iter().fold(Vec2::splat(f32::MIN), |hi, zone| hi.max(zone.max));
    let (centre, size) = ((lo + hi) * 0.5, hi - lo);
    let height = size.y.max(size.x * 9.0 / 16.0) * MAP_MARGIN;
    let target = ground(centre);
    Camera { position: target + Vec3::Y * MAP_HEIGHT, target, up: Vec3::NEG_Z, fovy: height, projection: Projection::Orthographic }
}

/// From one corner of the zone across to the far one, at eye height.
fn hero_camera(zone: &Zone) -> Camera {
    let inset = Vec2::splat(WALL + 0.6);
    let (from, to) = (zone.min + inset, zone.max - inset);
    Camera { fovy: 70.0, ..Camera::look_at(vec3(from.x, EYE, from.y), vec3(to.x, 1.2, to.y)) }
}
