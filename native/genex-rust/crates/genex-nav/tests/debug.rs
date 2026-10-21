//! NAV-16: nav debug drawing (new behaviour: `debug::segments` was a stub that drew nothing).
//!
//! - a 3x3-tile mesh draws each tile seam once, as boundary links (seams), with no gap along
//!   it, and its outer border once; the row fails on a double draw (a seam drawn as two borders,
//!   or as both of a stitch's directed links) or on a stitching gap;
//! - the whole mesh draws every polygon edge once;
//! - links and agents' paths draw when asked, and nothing draws by default;
//! - the same nav draws the same bytes.

use genex_nav::debug::{NavDebugLine, lines, segments};
use genex_nav::{NavAgent, NavArea, NavConfig, NavDebug, NavInput, NavLink, NavLinkKind, NavMesh};
use genex_nav::world::Nav;
use glam::{Vec3, vec3};

const DT: f32 = 1.0 / 60.0;
/// How far a point may sit off a seam or border line and still be on it, metres.
const ON_LINE: f32 = 1.0e-3;
/// The largest gap or overlap allowed between segments along one line, metres.
const SLACK: f32 = 1.0e-3;
/// The floor's side: three 8 m tiles.
const SIDE: f32 = 24.0;

fn config() -> NavConfig {
    NavConfig::walker(0.4, 1.8).with_tile(8.0)
}

/// A flat 24 x 24 m floor at `height`, from world (0, 0): exactly 3x3 tiles.
fn floor(height: f32) -> NavInput {
    let v = |x: f32, z: f32| vec3(x, height, z);
    let vertices = [v(0.0, 0.0), v(SIDE, 0.0), v(SIDE, SIDE), v(0.0, SIDE)];
    NavInput::new().with_triangles(&vertices, &[0, 2, 1, 0, 3, 2], NavArea::WALK).expect("the floor")
}

/// The same floor cut from 1 m squares, with a 2 x 2 m hole in its first tile, so that tile's
/// surface needs several polygons.
fn holed_floor(height: f32) -> NavInput {
    let mut vertices = Vec::new();
    let mut indices = Vec::new();
    let in_hole = |x: u32, z: u32| (3..5).contains(&x) && (3..5).contains(&z);
    for (x, z) in (0..SIDE as u32).flat_map(|x| (0..SIDE as u32).map(move |z| (x, z))).filter(|&(x, z)| !in_hole(x, z)) {
        let base = vertices.len() as u32;
        let (x, z) = (x as f32, z as f32);
        vertices.extend([vec3(x, height, z), vec3(x + 1.0, height, z), vec3(x + 1.0, height, z + 1.0), vec3(x, height, z + 1.0)]);
        indices.extend([base, base + 2, base + 1, base, base + 3, base + 2]);
    }
    NavInput::new().with_triangles(&vertices, &indices, NavArea::WALK).expect("the holed floor")
}

fn nav_of(input: &NavInput) -> Nav {
    let mut nav = Nav::new(&config());
    nav.add_mesh(&NavMesh::bake(input, &config()).expect("the bake")).expect("the tiles");
    nav.update(DT);
    nav
}

fn nav(height: f32) -> Nav {
    nav_of(&floor(height))
}

/// The axis a line of constant x (0) or constant z (2) runs along.
#[derive(Clone, Copy, Debug)]
enum Along {
    /// The line x = value; segments run along z.
    Z(f32),
    /// The line z = value; segments run along x.
    X(f32),
}

impl Along {
    fn on(self, point: Vec3) -> bool {
        match self {
            Along::Z(x) => (point.x - x).abs() <= ON_LINE,
            Along::X(z) => (point.z - z).abs() <= ON_LINE,
        }
    }

    fn coordinate(self, point: Vec3) -> f32 {
        match self {
            Along::Z(_) => point.z,
            Along::X(_) => point.x,
        }
    }
}

/// The intervals of the segments lying on `line`, sorted, with their kinds.
fn on_line(drawn: &[(NavDebugLine, [Vec3; 2])], line: Along) -> Vec<(f32, f32, NavDebugLine)> {
    let mut intervals: Vec<_> = drawn
        .iter()
        .filter(|(_, [a, b])| line.on(*a) && line.on(*b))
        .map(|(kind, [a, b])| {
            let (s, t) = (line.coordinate(*a), line.coordinate(*b));
            (s.min(t), s.max(t), *kind)
        })
        .collect();
    intervals.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.total_cmp(&b.1)));
    intervals
}

/// Assert the intervals cover `lo..hi` with no gap and no overlap past the slack.
fn assert_covers_once(row: &str, intervals: &[(f32, f32, NavDebugLine)], lo: f32, hi: f32) {
    assert!(!intervals.is_empty(), "{row}: nothing drawn on the line");
    assert!((intervals[0].0 - lo).abs() <= SLACK, "{row}: starts at {} not {lo}", intervals[0].0);
    for pair in intervals.windows(2) {
        let (end, next) = (pair[0].1, pair[1].0);
        assert!(next - end <= SLACK, "{row}: a gap from {end} to {next}");
        assert!(end - next <= SLACK, "{row}: drawn twice from {next} to {end}");
    }
    let last = intervals[intervals.len() - 1].1;
    assert!((last - hi).abs() <= SLACK, "{row}: ends at {last} not {hi}");
}

/// The bounds of every drawn point.
fn bounds(drawn: &[(NavDebugLine, [Vec3; 2])]) -> (Vec3, Vec3) {
    drawn.iter().flat_map(|(_, s)| *s).fold((Vec3::INFINITY, Vec3::NEG_INFINITY), |(lo, hi), p| (lo.min(p), hi.max(p)))
}

/// Assert no two drawn segments lie on one line and overlap (a double draw).
fn assert_no_double_draw(row: &str, drawn: &[(NavDebugLine, [Vec3; 2])]) {
    for (i, (kind_a, [a0, a1])) in drawn.iter().enumerate() {
        let along = *a1 - *a0;
        let length = along.length();
        assert!(length > 0.0, "{row}: segment {i} has no length");
        let dir = along / length;
        for (kind_b, [b0, b1]) in &drawn[i + 1..] {
            let off = |p: Vec3| (p - *a0 - dir * (p - *a0).dot(dir)).length();
            if off(*b0) > ON_LINE || off(*b1) > ON_LINE {
                continue;
            }
            let (s, t) = ((*b0 - *a0).dot(dir), (*b1 - *a0).dot(dir));
            let overlap = s.max(t).min(length) - s.min(t).max(0.0);
            assert!(overlap <= SLACK, "{row}: {kind_a:?} {a0}..{a1} and {kind_b:?} {b0}..{b1} overlap {overlap} m");
        }
    }
}

#[test]
fn a_three_by_three_tile_mesh_draws_each_seam_once_as_links_with_no_gap() {
    let nav = nav(0.0);
    assert_eq!(nav.tile_count(), 9, "a 24 m floor over 8 m tiles");
    let drawn = lines(&nav, NavDebug::borders());
    assert!(drawn.iter().all(|(kind, _)| matches!(kind, NavDebugLine::Border | NavDebugLine::Seam)), "borders only");
    assert_no_double_draw("borders", &drawn);
    let (lo, hi) = bounds(&drawn);
    assert!(lo.x > 0.0 && hi.x < SIDE, "the walker's radius erodes the floor's edge");

    // The seams: drawn once each, as links, end to end across the eroded floor.
    for seam in [8.0, 16.0] {
        for line in [Along::Z(seam), Along::X(seam)] {
            let row = format!("seam {line:?}");
            let intervals = on_line(&drawn, line);
            assert!(intervals.iter().all(|(.., kind)| *kind == NavDebugLine::Seam), "{row}: every piece is a link, {intervals:?}");
            let (from, to) = match line {
                Along::Z(_) => (lo.z, hi.z),
                Along::X(_) => (lo.x, hi.x),
            };
            assert_covers_once(&row, &intervals, from, to);
        }
    }
    // The outer border: drawn once, as borders, all the way round.
    for line in [Along::Z(lo.x), Along::Z(hi.x), Along::X(lo.z), Along::X(hi.z)] {
        let row = format!("border {line:?}");
        let intervals = on_line(&drawn, line);
        assert!(intervals.iter().all(|(.., kind)| *kind == NavDebugLine::Border), "{row}: {intervals:?}");
        let (from, to) = match line {
            Along::Z(_) => (lo.z, hi.z),
            Along::X(_) => (lo.x, hi.x),
        };
        assert_covers_once(&row, &intervals, from, to);
    }
}

#[test]
fn the_whole_mesh_draws_every_polygon_edge_once_at_the_floor_s_height() {
    let height = 1.5;
    let nav = nav_of(&holed_floor(height));
    let drawn = lines(&nav, NavDebug::mesh());
    assert!(drawn.iter().any(|(kind, _)| *kind == NavDebugLine::Edge), "the polygons' inner edges");
    assert_no_double_draw("mesh", &drawn);
    for (kind, segment) in &drawn {
        for point in segment {
            assert!((point.y - height).abs() < 0.5, "{kind:?} at {point} sits on the floor at {height} m");
        }
    }
    let borders = lines(&nav, NavDebug::borders()).len();
    assert!(drawn.len() > borders, "the mesh draws more than its borders");
}

#[test]
fn nothing_draws_by_default_and_links_and_paths_draw_when_asked() {
    let mut nav = nav(0.0);
    assert!(segments(&nav, NavDebug::default()).is_empty(), "the default draws nothing");
    assert!(segments(&Nav::default(), NavDebug::everything()).is_empty(), "an empty nav draws nothing");

    let (from, to) = (vec3(4.0, 0.0, 4.0), vec3(20.0, 0.0, 4.0));
    nav.add_link(NavLink::between(from, to, NavLinkKind::Jump)).expect("a link");
    let agent = nav.add_agent(NavAgent::new(vec3(2.0, 0.0, 2.0))).expect("an agent");
    let target = vec3(21.0, 0.0, 21.0);
    nav.move_to(agent, target);
    nav.update(DT);

    let links: Vec<_> = lines(&nav, NavDebug::default().with_links());
    assert!(!links.is_empty() && links.iter().all(|(kind, _)| *kind == NavDebugLine::Link), "a link draws as links only");
    let joins = links.iter().any(|(_, [a, b])| a.distance(from) < 0.5 && b.distance(to) < 0.5);
    assert!(joins, "the link draws from its start to its end: {links:?}");

    let path: Vec<_> = lines(&nav, NavDebug::default().with_paths()).into_iter().map(|(_, s)| s).collect();
    assert!(!path.is_empty(), "the moving agent's path draws");
    let start = nav.position(agent).expect("the agent");
    assert!(path[0][0].distance(start) < 1.0e-4, "the path starts where the agent stands");
    for pair in path.windows(2) {
        assert!(pair[0][1].distance(pair[1][0]) < 1.0e-4, "the path is one unbroken polyline");
    }
    let end = path[path.len() - 1][1];
    assert!(vec3(end.x - target.x, 0.0, end.z - target.z).length() < 0.5, "the path ends at the target ({end})");

    let everything = segments(&nav, NavDebug::everything()).len();
    let parts = segments(&nav, NavDebug::mesh()).len() + links.len() + path.len();
    assert_eq!(everything, parts, "everything is the mesh, the links and the paths");
}

#[test]
fn the_same_nav_draws_the_same_bytes() {
    let draw = || {
        let drawn = segments(&nav(0.0), NavDebug::everything());
        drawn.iter().flatten().flat_map(|p| [p.x.to_bits(), p.y.to_bits(), p.z.to_bits()]).collect::<Vec<u32>>()
    };
    assert_eq!(draw(), draw());
}
