//! The convex hull the core computes for a `hull` shape (§6.2) and a static ramp (§6.5).
//!
//! The backend is handed a ready triangle mesh, never a point cloud: its own hull algorithm works
//! in f32 with tolerances and has assertions reachable on near-degenerate input, which would trap
//! a WASM instance (§1.5, §11.3). Here every orientation test is exact. Each point is mapped per
//! axis onto an integer grid of 2^30 steps either side of the cloud's middle (an affine map, so it
//! keeps which points are coplanar and which side of a plane each lies on), and the incremental
//! hull runs on those integers with `i128` determinants. The result is a closed triangle mesh,
//! every edge shared by exactly two triangles in opposite directions and every triangle wound
//! counter-clockwise seen from outside, over the original f32 points of its vertices. A cloud
//! whose grid points span no volume has no hull (`None`).
//!
//! Points that land on one grid point are one vertex (the first given). A vertex that ends up in
//! the middle of a flat region of the surface is not a corner, so it is dropped and the hull
//! computed again without it. The same points give the same mesh on every target.

/// Grid steps from a cloud's middle to its edge, per axis.
const GRID_HALF: f64 = (1u64 << 30) as f64;

/// A point on the integer grid.
type GridPoint = [i64; 3];

/// A hull as the backend takes it: its vertices and its triangles as indices into them.
pub(crate) type HullMesh = (Vec<[f32; 3]>, Vec<[u32; 3]>);

/// One triangle of the hull under construction: its corners (indices into the grid points),
/// counter-clockwise from outside.
#[derive(Clone, Copy, Debug)]
struct Face {
    corners: [usize; 3],
    alive: bool,
}

/// The hull of `points`: its vertices (a subset of `points`, in first-given order) and its
/// triangles as indices into them, or `None` when the points span no volume.
pub(crate) fn convex_hull(points: &[[f32; 3]]) -> Option<HullMesh> {
    let grid = to_grid(points)?;
    let mut members = distinct(&grid);
    loop {
        let faces = incremental_hull(&grid, &members)?;
        let flat = flat_vertices(&grid, &faces);
        if flat.is_empty() {
            return Some(mesh(points, &faces));
        }
        members.retain(|index| !flat.contains(index));
    }
}

/// Every point on the grid, per axis, or `None` when an axis has no extent.
fn to_grid(points: &[[f32; 3]]) -> Option<Vec<GridPoint>> {
    let mut low = [f64::INFINITY; 3];
    let mut high = [f64::NEG_INFINITY; 3];
    for point in points {
        for axis in 0..3 {
            low[axis] = low[axis].min(f64::from(point[axis]));
            high[axis] = high[axis].max(f64::from(point[axis]));
        }
    }
    let half: [f64; 3] = [0, 1, 2].map(|axis| (high[axis] - low[axis]) * 0.5);
    if half.iter().any(|h| *h <= 0.0 || !h.is_finite()) {
        return None;
    }
    let middle: [f64; 3] = [0, 1, 2].map(|axis| low[axis] + half[axis]);
    let step = |value: f32, axis: usize| ((f64::from(value) - middle[axis]) / half[axis] * GRID_HALF).round() as i64;
    Some(points.iter().map(|p| [step(p[0], 0), step(p[1], 1), step(p[2], 2)]).collect())
}

/// The index of the first point at each distinct grid point, in order.
fn distinct(grid: &[GridPoint]) -> Vec<usize> {
    let mut seen = std::collections::BTreeSet::new();
    (0..grid.len()).filter(|index| seen.insert(grid[*index])).collect()
}

fn sub(a: GridPoint, b: GridPoint) -> [i128; 3] {
    [0, 1, 2].map(|axis| i128::from(a[axis]) - i128::from(b[axis]))
}

fn cross(a: [i128; 3], b: [i128; 3]) -> [i128; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn dot(a: [i128; 3], b: [i128; 3]) -> i128 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// Six times the signed volume of (a, b, c, d): above 0 when `d` lies on the side of the
/// triangle (a, b, c) that its counter-clockwise winding faces.
fn orient(a: GridPoint, b: GridPoint, c: GridPoint, d: GridPoint) -> i128 {
    dot(cross(sub(b, a), sub(c, a)), sub(d, a))
}

/// The member that maximises `measure`, the first of equals.
fn best(members: &[usize], measure: impl Fn(usize) -> i128) -> (usize, i128) {
    let mut best = (members[0], measure(members[0]));
    for &index in &members[1..] {
        let value = measure(index);
        if value > best.1 {
            best = (index, value);
        }
    }
    best
}

/// A first tetrahedron of extreme members, wound outward, or `None` when they span no volume.
fn first_tetrahedron(grid: &[GridPoint], members: &[usize]) -> Option<[Face; 4]> {
    let a = *members.first()?;
    let (b, far) = best(members, |i| dot(sub(grid[i], grid[a]), sub(grid[i], grid[a])));
    let (c, wide) = best(members, |i| {
        let normal = cross(sub(grid[b], grid[a]), sub(grid[i], grid[a]));
        dot(normal, normal)
    });
    let (d, _) = best(members, |i| orient(grid[a], grid[b], grid[c], grid[i]).abs());
    let volume = orient(grid[a], grid[b], grid[c], grid[d]);
    if far == 0 || wide == 0 || volume == 0 {
        return None;
    }
    let (b, c) = if volume > 0 { (c, b) } else { (b, c) };
    let face = |corners| Face { corners, alive: true };
    Some([face([a, b, c]), face([a, d, b]), face([b, d, c]), face([c, d, a])])
}

/// The hull of `members` by adding one point at a time: the faces a point sees (strictly) are
/// replaced by a fan from it to their horizon. With exact tests the seen faces form one patch
/// whose border is a simple loop, so the mesh stays closed and consistently wound.
fn incremental_hull(grid: &[GridPoint], members: &[usize]) -> Option<Vec<Face>> {
    let start = first_tetrahedron(grid, members)?;
    let mut faces = start.to_vec();
    let corners: Vec<usize> = start.iter().flat_map(|face| face.corners).collect();
    for &point in members.iter().filter(|index| !corners.contains(index)) {
        let sees = |face: &Face| {
            let [a, b, c] = face.corners;
            face.alive && orient(grid[a], grid[b], grid[c], grid[point]) > 0
        };
        let seen: Vec<usize> = (0..faces.len()).filter(|index| sees(&faces[*index])).collect();
        if seen.is_empty() {
            continue;
        }
        let edges: Vec<(usize, usize)> = seen.iter().flat_map(|index| directed_edges(&faces[*index])).collect();
        let mut lookup = edges.clone();
        lookup.sort_unstable();
        let horizon: Vec<(usize, usize)> =
            edges.iter().copied().filter(|(a, b)| lookup.binary_search(&(*b, *a)).is_err()).collect();
        for index in &seen {
            faces[*index].alive = false;
        }
        faces.extend(horizon.into_iter().map(|(a, b)| Face { corners: [a, b, point], alive: true }));
    }
    faces.retain(|face| face.alive);
    Some(faces)
}

fn directed_edges(face: &Face) -> [(usize, usize); 3] {
    let [a, b, c] = face.corners;
    [(a, b), (b, c), (c, a)]
}

/// Vertices whose every face lies in one plane: they sit inside a flat region, not at a corner.
fn flat_vertices(grid: &[GridPoint], faces: &[Face]) -> Vec<usize> {
    let mut vertices: Vec<usize> = faces.iter().flat_map(|face| face.corners).collect();
    vertices.sort_unstable();
    vertices.dedup();
    vertices.retain(|vertex| {
        let around: Vec<&Face> = faces.iter().filter(|face| face.corners.contains(vertex)).collect();
        let [a, b, c] = around[0].corners;
        let neighbours = around.iter().flat_map(|face| face.corners);
        neighbours.into_iter().all(|other| orient(grid[a], grid[b], grid[c], grid[other]) == 0)
    });
    vertices
}

/// The faces as a mesh over the original points of their corners, in first-given order.
fn mesh(points: &[[f32; 3]], faces: &[Face]) -> HullMesh {
    let mut used: Vec<usize> = faces.iter().flat_map(|face| face.corners).collect();
    used.sort_unstable();
    used.dedup();
    let slot = |index: usize| used.binary_search(&index).map_or(0, |at| at as u32);
    let triangles = faces.iter().map(|face| face.corners.map(slot)).collect();
    (used.iter().map(|index| points[*index]).collect(), triangles)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every undirected edge is used exactly twice, once each way, and no triangle repeats a corner.
    fn is_closed_and_consistent(triangles: &[[u32; 3]]) -> bool {
        let mut edges: Vec<(u32, u32)> = triangles.iter().flat_map(|[a, b, c]| [(*a, *b), (*b, *c), (*c, *a)]).collect();
        let repeats = triangles.iter().any(|[a, b, c]| a == b || b == c || a == c);
        edges.sort_unstable();
        let once_each = edges.windows(2).all(|pair| pair[0] != pair[1]);
        let paired = edges.iter().all(|(a, b)| edges.binary_search(&(*b, *a)).is_ok());
        !repeats && once_each && paired
    }

    /// Whether every triangle faces away from the hull's middle (outward winding).
    fn faces_outward(points: &[[f32; 3]], triangles: &[[u32; 3]]) -> bool {
        let n = points.len() as f64;
        let middle = [0, 1, 2].map(|axis| points.iter().map(|p| f64::from(p[axis])).sum::<f64>() / n);
        triangles.iter().all(|t| {
            let [a, b, c] = t.map(|i| points[i as usize].map(f64::from));
            let e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            let e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            let normal = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
            let to_middle = [middle[0] - a[0], middle[1] - a[1], middle[2] - a[2]];
            normal[0] * to_middle[0] + normal[1] * to_middle[1] + normal[2] * to_middle[2] < 0.0
        })
    }

    fn cube(extra: &[[f32; 3]]) -> Vec<[f32; 3]> {
        let mut points: Vec<[f32; 3]> = (0..8).map(|i| [0, 1, 2].map(|bit| if i >> bit & 1 == 0 { -1.0 } else { 1.0 })).collect();
        points.extend_from_slice(extra);
        points
    }

    #[test]
    fn a_cube_is_eight_corners_and_twelve_triangles_wound_outward() {
        let (points, triangles) = convex_hull(&cube(&[])).expect("a cube has a hull");
        assert_eq!((points.len(), triangles.len()), (8, 12));
        assert!(is_closed_and_consistent(&triangles) && faces_outward(&points, &triangles));
    }

    #[test]
    fn inner_duplicate_face_and_edge_points_are_not_corners() {
        let extra = [[0.0, 0.0, 0.0], [1.0, 1.0, 1.0], [0.0, 0.0, 1.0], [0.3, -0.2, 1.0], [0.0, 1.0, 1.0]];
        let (points, triangles) = convex_hull(&cube(&extra)).expect("a hull");
        assert!(points.len() <= 9, "only the corners and at most the edge point stay: {points:?}");
        assert!(!points.contains(&[0.0, 0.0, 1.0]) && !points.contains(&[0.3, -0.2, 1.0]), "face points go");
        assert!(is_closed_and_consistent(&triangles) && faces_outward(&points, &triangles));
    }

    #[test]
    fn flat_collinear_and_coincident_clouds_have_no_hull() {
        assert!(convex_hull(&[[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [1.0, 1.0, 0.0]]).is_none());
        assert!(convex_hull(&[[0.0; 3], [1.0; 3], [2.0; 3], [3.0; 3]]).is_none());
        assert!(convex_hull(&[[5.0, 6.0, 7.0]; 4]).is_none());
    }

    #[test]
    fn extreme_aspect_ratios_keep_their_hull() {
        let thin = f32::from_bits((127 - 100) << 23); // 2^-100
        let sliver = [[0.0, 0.0, -1e9], [thin, 0.0, -1e9], [0.0, 1.0, -1e9], [thin, 1.0, -1e9], [thin, 0.0, 1e9], [thin, 1.0, 1e9]];
        let (points, triangles) = convex_hull(&sliver).expect("a wedge 2^-100 wide is a volume");
        assert_eq!(points.len(), 6);
        assert!(is_closed_and_consistent(&triangles));
    }

    #[test]
    fn nearly_coplanar_clouds_give_closed_meshes() {
        let mut state = 7u64;
        let mut next = || {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((state >> 11) as f64 / (1u64 << 53) as f64 * 2.0 - 1.0) as f32
        };
        for round in 0..300 {
            let lift = [0.0, 1e-7, 1e-6, 1e-3][round % 4];
            let points: Vec<[f32; 3]> = (0..4 + round % 61).map(|_| [next(), next(), lift * next()]).collect();
            if let Some((hull_points, triangles)) = convex_hull(&points) {
                assert!(is_closed_and_consistent(&triangles), "round {round}");
                assert!(hull_points.len() >= 4 && triangles.len() == 2 * hull_points.len() - 4, "round {round}");
            }
        }
    }
}
