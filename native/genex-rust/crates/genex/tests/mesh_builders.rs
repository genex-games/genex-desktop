//! The mesh builders (AAA review WP-8): each shape is closed where it should be (every edge
//! between welded points shared by two triangles, wound outwards), keeps its size, has unit
//! normals that agree with its faces, UVs at the real texel density it was asked for, and builds
//! the same bytes twice; each operation keeps its promise (smoothing shrinks, tessellating keeps
//! the shape, displacing opens no crack, weighted normals shade large faces flat, auto UVs split
//! seams). Hostile numbers clamp, never panic. CPU only.

use std::collections::BTreeMap;

use genex::prelude::*;
use genex::{LATHE_SEGMENTS_MAX, MESH_TRIANGLES_MAX, MeshErrorCode, Profile, ROUND_SEGMENTS_MAX, SUBDIVIDE_LEVELS_MAX};
use genex_render::mesh::GlbModel;

const EPS: f32 = 1.0e-4;

/// Vertices at bit-equal positions as one point.
fn weld(mesh: &MeshData) -> Vec<u32> {
    let mut seen: BTreeMap<[u32; 3], u32> = BTreeMap::new();
    mesh.positions
        .iter()
        .map(|p| {
            let next = seen.len() as u32;
            *seen.entry((*p + Vec3::ZERO).to_array().map(f32::to_bits)).or_insert(next)
        })
        .collect()
}

/// Each welded edge's directed uses (from, to) counted.
fn directed_edges(mesh: &MeshData) -> BTreeMap<(u32, u32), u32> {
    let point = weld(mesh);
    let mut edges = BTreeMap::new();
    for t in mesh.indices.chunks(3) {
        let [a, b, c] = [point[t[0] as usize], point[t[1] as usize], point[t[2] as usize]];
        for (from, to) in [(a, b), (b, c), (c, a)] {
            *edges.entry((from, to)).or_insert(0) += 1;
        }
    }
    edges
}

/// Closed and consistently wound: every directed edge once, its reverse once.
fn assert_watertight(name: &str, mesh: &MeshData) {
    let edges = directed_edges(mesh);
    for ((from, to), uses) in &edges {
        assert_eq!(*uses, 1, "{name}: edge {from}->{to} used {uses} times");
        assert_eq!(edges.get(&(*to, *from)), Some(&1), "{name}: edge {from}->{to} has no twin (a hole or a flipped triangle)");
    }
}

/// The volume enclosed (divergence theorem): positive when wound outwards.
fn volume(mesh: &MeshData) -> f32 {
    mesh.indices.chunks(3).map(|t| mesh.positions[t[0] as usize].dot(mesh.positions[t[1] as usize].cross(mesh.positions[t[2] as usize])) / 6.0).sum()
}

/// The most a facet of a rounded edge turns: its share of 90 degrees, 1.75 times that where three
/// faces round into a corner, and a degree of rounding.
fn facet_share(segments: u32) -> f32 {
    90.0 / segments as f32 * 1.75 + 1.0
}

fn bounds(mesh: &MeshData) -> (Vec3, Vec3) {
    mesh.positions.iter().fold((Vec3::splat(f32::INFINITY), Vec3::splat(f32::NEG_INFINITY)), |(lo, hi), p| (lo.min(*p), hi.max(*p)))
}

fn face_normal(mesh: &MeshData, t: &[u32]) -> Vec3 {
    let [a, b, c] = [0, 1, 2].map(|k| mesh.positions[t[k] as usize]);
    (b - a).cross(c - a).normalize_or_zero()
}

/// Unit normals, each within `degrees` of every face it belongs to, and the GLB builds and reads.
fn assert_shaded(name: &str, mesh: &MeshData, degrees: f32) {
    assert!(mesh.check().is_ok(), "{name}: {:?}", mesh.check());
    assert_eq!(mesh.normals.len(), mesh.positions.len(), "{name}: a normal per vertex");
    assert_eq!(mesh.uvs.len(), mesh.positions.len(), "{name}: a UV per vertex");
    let limit = genex::math::cos(genex::math::to_radians(degrees));
    for t in mesh.indices.chunks(3) {
        let face = face_normal(mesh, t);
        for vertex in t {
            let n = mesh.normals[*vertex as usize];
            assert!((n.length() - 1.0).abs() < EPS, "{name}: normal {n} is not unit");
            assert!(n.dot(face) >= limit, "{name}: normal {n} turns more than {degrees} degrees from its face {face}");
        }
    }
    let glb = mesh.to_glb().expect("builds");
    assert_eq!(mesh.clone().to_glb().expect("again"), glb, "{name}: the same bytes twice");
    GlbModel::from_glb(&glb).expect("the renderer reads it");
}

/// The largest angle (degrees) between two triangles meeting at a welded edge where the surface
/// bends outwards: a box's is 90.
fn sharpest_convex_edge(mesh: &MeshData) -> f32 {
    let point = weld(mesh);
    let mut by_edge: BTreeMap<(u32, u32), Vec<usize>> = BTreeMap::new();
    for (face, t) in mesh.indices.chunks(3).enumerate() {
        let [a, b, c] = [point[t[0] as usize], point[t[1] as usize], point[t[2] as usize]];
        for (x, y) in [(a, b), (b, c), (c, a)] {
            by_edge.entry((x.min(y), x.max(y))).or_default().push(face);
        }
    }
    let mut sharpest: f32 = 0.0;
    for faces in by_edge.values().filter(|faces| faces.len() == 2) {
        let (t0, t1) = (&mesh.indices[faces[0] * 3..faces[0] * 3 + 3], &mesh.indices[faces[1] * 3..faces[1] * 3 + 3]);
        let (n0, n1) = (face_normal(mesh, t0), face_normal(mesh, t1));
        // Convex where the second face's far corner lies behind the first face.
        let centre1 = t1.iter().map(|i| mesh.positions[*i as usize]).sum::<Vec3>() / 3.0;
        let convex = (centre1 - mesh.positions[t0[0] as usize]).dot(n0) <= 1.0e-6;
        if convex {
            sharpest = sharpest.max(genex::math::acos(n0.dot(n1).clamp(-1.0, 1.0)).to_degrees());
        }
    }
    sharpest
}

#[test]
fn a_rounded_cuboid_keeps_its_box_closes_and_has_no_hard_edge() {
    let (min, max) = (vec3(-0.4, 0.0, -0.2), vec3(0.4, 0.75, 0.2));
    for segments in [2, 4, 8] {
        let mut mesh = MeshData::new();
        mesh.rounded_cuboid(min, max, 0.03, segments, 0.5);
        let name = format!("rounded cuboid, {segments} facets");
        assert_watertight(&name, &mesh);
        let (lo, hi) = bounds(&mesh);
        assert!(lo.distance(min) < EPS && hi.distance(max) < EPS, "{name}: keeps its box: {lo} {hi}");
        assert!(volume(&mesh) > 0.0 && volume(&mesh) < 0.8 * 0.75 * 0.4, "{name}: wound out, smaller than the box");
        let share = facet_share(segments);
        let edge = sharpest_convex_edge(&mesh);
        assert!(edge <= share, "{name}: no facet turns more than its share of the edge: {edge}");
        assert_shaded(&name, &mesh, share);
    }
    // The flat middle of the front face shades exactly flat, its UVs in tiles of 0.5 m.
    let mut mesh = MeshData::new();
    mesh.rounded_cuboid(min, max, 0.03, 4, 0.5);
    let front: Vec<usize> = (0..mesh.positions.len()).filter(|i| mesh.positions[*i].z == 0.2).collect();
    assert!(!front.is_empty() && front.iter().all(|i| mesh.normals[*i] == Vec3::Z), "the front's flat part faces +z exactly");
    let us: Vec<f32> = front.iter().map(|i| mesh.uvs[*i].x).collect();
    let span = us.iter().copied().fold(f32::NEG_INFINITY, f32::max) - us.iter().copied().fold(f32::INFINITY, f32::min);
    assert!((span - (0.8 - 0.06) / 0.5).abs() < EPS, "the flat front spans its width in 0.5 m tiles: {span}");
}

#[test]
fn a_rounded_cuboid_clamps_hostile_numbers() {
    let mut plain = MeshData::new();
    plain.cuboid(Vec3::ZERO, Vec3::ONE, 1.0);
    for radius in [0.0, -1.0, f32::NAN] {
        let mut mesh = MeshData::new();
        mesh.rounded_cuboid(Vec3::ZERO, Vec3::ONE, radius, 4, 1.0);
        assert_eq!(mesh, plain, "radius {radius}: the plain cuboid");
    }
    // Too big a radius rounds as far as half the smallest side: a slab with round ends.
    let mut mesh = MeshData::new();
    mesh.rounded_cuboid(Vec3::ZERO, vec3(1.0, 0.1, 1.0), 5.0, 1000, 1.0);
    assert_watertight("huge radius", &mesh);
    let (lo, hi) = bounds(&mesh);
    assert!(lo.distance(Vec3::ZERO) < EPS && hi.distance(vec3(1.0, 0.1, 1.0)) < EPS);
    assert!(sharpest_convex_edge(&mesh) <= facet_share(ROUND_SEGMENTS_MAX), "segments held to the most");
    assert!(sharpest_convex_edge(&mesh) > facet_share(1000) * 0.3, "and not more than the most: facets are not infinitely fine");
}

#[test]
fn a_bevel_rounds_every_corner_inside_the_outline() {
    let square = Profile::rect(1.0, 1.0);
    let round = square.bevel(0.1, 4);
    assert!(round.closed);
    assert_eq!(round.points.len(), 4 * 5, "five points round each corner");
    for p in &round.points {
        assert!(p.x.abs() <= 0.5 + EPS && p.y.abs() <= 0.5 + EPS, "inside the square: {p}");
        assert!(p.distance(vec2(0.5, 0.5)) > 0.04, "no point at the sharp corner: {p}");
    }
    // Each corner's arc lies on a circle of the radius round a centre 0.1 in from both edges.
    for p in round.points.iter().filter(|p| p.x > 0.4 && p.y > 0.4) {
        assert!((p.distance(vec2(0.4, 0.4)) - 0.1).abs() < EPS, "on the arc: {p}");
    }
    let perimeter = 4.0 * 0.8 + std::f32::consts::TAU * 0.1;
    assert!((round.length() - perimeter).abs() < 0.01, "the rounded length: {}", round.length());
    // Too big a radius rounds as far as half the shorter edge; 0 or not finite changes nothing.
    let capped = Profile::rect(1.0, 0.2).bevel(10.0, 3);
    assert!(capped.points.iter().all(|p| p.x.abs() <= 0.5 + EPS && p.y.abs() <= 0.1 + EPS));
    assert_eq!(square.bevel(f32::NAN, 4), square);
    assert_eq!(square.bevel(0.0, 4), square);
    // A clockwise polygon is turned round; an open polyline keeps its ends.
    let clockwise = Profile::polygon(vec![vec2(0.0, 0.0), vec2(0.0, 1.0), vec2(1.0, 1.0), vec2(1.0, 0.0)]);
    let area: f32 = (0..4).map(|i| clockwise.points[i].perp_dot(clockwise.points[(i + 1) % 4])).sum();
    assert!(area > 0.0, "made counter-clockwise");
    let line = Profile::polyline(vec![vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(1.0, 1.0)]).bevel(0.2, 2);
    assert_eq!((line.points[0], line.points[line.points.len() - 1]), (vec2(0.0, 0.0), vec2(1.0, 1.0)));
}

#[test]
fn an_extrusion_closes_with_caps_and_its_bevel_softens_the_cap_edges() {
    let mut plain = MeshData::new();
    plain.extrude(&Profile::rect(0.3, 0.4), 2.0, 0.0, 1.0);
    assert_watertight("extruded box", &plain);
    assert_eq!(plain.triangle_count(), 4 * 2 + 2 * 2);
    assert!((volume(&plain) - 0.3 * 0.4 * 2.0).abs() < EPS);
    assert_shaded("extruded box", &plain, 1.0);
    // A rounded profile with a bevelled cap: closed, the same size, no hard edge anywhere.
    let mut soft = MeshData::new();
    soft.extrude(&Profile::rounded_rect(0.09, 0.045, 0.01, 4), 1.6, 0.006, 1.0);
    assert_watertight("bevelled slat", &soft);
    let (lo, hi) = bounds(&soft);
    assert!(lo.distance(vec3(-0.045, -0.0225, 0.0)) < EPS && hi.distance(vec3(0.045, 0.0225, 1.6)) < EPS, "{lo} {hi}");
    let edge = sharpest_convex_edge(&soft);
    assert!(edge <= 31.0, "a 90 degree edge split in three or more: {edge}");
    assert_shaded("bevelled slat", &soft, 35.0);
    // A concave L: its caps cover exactly its area.
    let l = Profile::polygon(vec![vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(1.0, 0.2), vec2(0.2, 0.2), vec2(0.2, 1.0), vec2(0.0, 1.0)]);
    let mut angle = MeshData::new();
    angle.extrude(&l, 0.5, 0.0, 1.0);
    assert_watertight("L section", &angle);
    assert!((volume(&angle) - 0.36 * 0.5).abs() < EPS, "{}", volume(&angle));
    // UVs: along the extrusion in metres; an open polyline makes a sheet with no caps.
    let along: f32 = plain.uvs.iter().map(|uv| uv.y).fold(0.0, f32::max);
    assert!((along - 2.0).abs() < EPS);
    let mut sheet = MeshData::new();
    sheet.extrude(&Profile::polyline(vec![vec2(0.0, 0.0), vec2(1.0, 0.1), vec2(2.0, 0.0)]), 1.0, 0.5, 1.0);
    assert_eq!(sheet.triangle_count(), 4, "two quads, no caps, no bevel");
}

#[test]
fn a_lathe_turns_a_profile_into_a_closed_solid_and_its_seam_is_exact() {
    let can = Profile::polyline(vec![vec2(0.0, 0.0), vec2(0.5, 0.0), vec2(0.5, 1.0), vec2(0.0, 1.0)]);
    let mut mesh = MeshData::new();
    mesh.lathe(&can, 32, 1.0);
    assert_watertight("lathed can", &mesh);
    let polygon_area = 0.5 * 32.0 * 0.25 * genex::math::sin(std::f32::consts::TAU / 32.0);
    assert!((volume(&mesh) - polygon_area).abs() < 1.0e-3, "a 32-gon prism: {}", volume(&mesh));
    assert_shaded("lathed can", &mesh, 360.0 / 32.0);
    // The side is smooth round (shared normals), the rim a hard edge (the profile turns 90).
    let side: Vec<Vec3> = (0..mesh.positions.len()).filter(|i| (mesh.positions[*i].y - 0.5).abs() < 0.6 && mesh.normals[*i].y.abs() < 0.1).map(|i| mesh.normals[i]).collect();
    assert!(side.iter().all(|n| n.y.abs() < EPS), "the side's normals point out flat");
    // A torus from a closed circle profile; segments held to their range.
    let mut torus = MeshData::new();
    let ring = Profile::polygon(Profile::circle(0.1, 12).points.iter().map(|p| *p + vec2(0.5, 0.0)).collect::<Vec<_>>());
    torus.lathe(&ring, 1000, 1.0);
    assert_watertight("torus", &torus);
    assert_eq!(torus.triangle_count(), 12 * 2 * LATHE_SEGMENTS_MAX as usize);
}

#[test]
fn a_tube_follows_its_path_at_its_radius_and_closes_its_ends() {
    let path = [vec3(0.0, 0.0, 0.0), vec3(0.0, 1.0, 0.0), vec3(0.0, 1.0, -1.0), vec3(1.0, 1.0, -1.0)];
    let mut pipe = MeshData::new();
    pipe.tube(&path, 0.05, 12, 1.0);
    assert_watertight("pipe", &pipe);
    assert!(volume(&pipe) > 0.0, "wound out");
    // A 90 degree bend is one mitre ring: smooth shading turns by half the bend plus a facet.
    assert_shaded("pipe", &pipe, 60.0);
    // On the straight first run (away from the bend) every vertex is the radius from the axis.
    for p in pipe.positions.iter().filter(|p| p.y < 0.9 && p.z.abs() < 0.2) {
        assert!((vec2(p.x, p.z).length() - 0.05).abs() < EPS, "on the first run's radius: {p}");
    }
    let v_max = pipe.uvs.iter().map(|uv| uv.y).fold(0.0, f32::max);
    assert!((v_max - 3.0).abs() < EPS, "v runs the path's 3 m: {v_max}");
    // A sweep of a polyline profile is an open sheet; a path of one point makes nothing.
    let mut gutter = MeshData::new();
    gutter.sweep(&Profile::polyline(vec![vec2(-0.05, 0.05), vec2(-0.05, 0.0), vec2(0.05, 0.0), vec2(0.05, 0.05)]), &path, 1.0);
    assert_eq!(gutter.triangle_count(), 3 * 3 * 2);
    let mut nothing = MeshData::new();
    nothing.tube(&[Vec3::ZERO, Vec3::ZERO], 0.1, 8, 1.0);
    assert!(nothing.positions.is_empty());
}

#[test]
fn subdividing_smooths_a_closed_box_without_a_crack_and_tessellating_keeps_its_shape() {
    let mut rock = MeshData::new();
    rock.cuboid(vec3(-1.0, -1.0, -1.0), vec3(1.0, 1.0, 1.0), 1.0).subdivide(2);
    assert_eq!(rock.triangle_count(), 12 * 16);
    assert_watertight("smoothed box", &rock);
    let (lo, hi) = bounds(&rock);
    assert!(hi.max_element() < 1.0 && lo.min_element() > -1.0, "Loop smoothing pulls the corners in");
    assert_shaded("smoothed box", &rock, 40.0);
    let mut tiles = MeshData::new();
    tiles.cuboid(vec3(-1.0, -1.0, -1.0), vec3(1.0, 1.0, 1.0), 1.0).tessellate(3);
    assert_eq!(tiles.triangle_count(), 12 * 64);
    assert_watertight("tessellated box", &tiles);
    assert!(tiles.positions.iter().all(|p| (p.abs().max_element() - 1.0).abs() < EPS), "every vertex still on the box");
    assert_shaded("tessellated box", &tiles, 1.0);
    // An open sheet keeps its border in its plane; the triangle cap stops the levels.
    let mut sheet = MeshData::new();
    sheet.quad([vec3(0.0, 0.0, 0.0), vec3(1.0, 0.0, 0.0), vec3(1.0, 1.0, 0.0), vec3(0.0, 1.0, 0.0)], 1.0).subdivide(3);
    assert!(sheet.positions.iter().all(|p| p.z == 0.0));
    let mut big = MeshData::new();
    big.cuboid(Vec3::ZERO, Vec3::ONE, 1.0).tessellate(99);
    assert_eq!(big.triangle_count(), 12 << (2 * SUBDIVIDE_LEVELS_MAX), "levels held to the most");
    big.tessellate(99);
    assert_eq!(big.triangle_count(), 12 << 14, "a level past the triangle cap is not applied");
    assert!(big.triangle_count() <= MESH_TRIANGLES_MAX);
}

#[test]
fn displacing_moves_along_the_normal_without_opening_a_crack() {
    let mut ball = MeshData::new();
    ball.cuboid(vec3(-1.0, -1.0, -1.0), vec3(1.0, 1.0, 1.0), 1.0).subdivide(3);
    let before = ball.clone();
    ball.displace(|_| 0.1);
    assert_watertight("displaced ball", &ball);
    for (a, b) in before.positions.iter().zip(&ball.positions) {
        assert!(((b - a).length() - 0.1).abs() < EPS, "moved 0.1 m");
    }
    let mut a = before.clone();
    a.displace_noise(0.05, 0.4, 3);
    let mut b = before.clone();
    b.displace_noise(0.05, 0.4, 3);
    assert_eq!(a.to_glb().expect("a"), b.to_glb().expect("b"), "the same seed, the same rock");
    let mut c = before.clone();
    c.displace_noise(0.05, 0.4, 4);
    assert_ne!(a.positions, c.positions, "another seed, another rock");
    assert_watertight("noisy rock", &a);
    assert!(a.positions.iter().zip(&before.positions).all(|(p, q)| p.distance(*q) <= 0.05 + EPS), "within the amplitude");
    // An amount that is not finite moves nothing; a refused mesh is left for gfx.mesh to name.
    let mut still = before.clone();
    still.displace(|_| f32::NAN);
    assert_eq!(still.positions, before.positions);
    let mut broken = MeshData { positions: vec![Vec3::ZERO], indices: vec![0, 1, 2], ..MeshData::default() };
    broken.displace(|_| 1.0).subdivide(2).auto_uv(1.0).weighted_normals(30.0);
    assert_eq!(broken.check().map_err(|e| e.code), Err(MeshErrorCode::IndexOutOfRange));
}

#[test]
fn weighted_normals_keep_large_faces_flat_and_turn_only_the_bevels() {
    let mut beam = MeshData::new();
    beam.extrude(&Profile::rect(0.3, 0.4).bevel(0.02, 1), 2.0, 0.0, 1.0);
    // Smooth everything, then weight it: the broad faces' vertices beside the chamfer point
    // nearly straight out of their face; a chamfer's own normal is between.
    beam.weighted_normals(50.0);
    for (at, p) in beam.positions.iter().enumerate() {
        let n = beam.normals[at];
        let on_top_face = (p.y - 0.2).abs() < EPS && p.x.abs() < 0.13 + EPS && p.z > EPS && p.z < 2.0 - EPS;
        if on_top_face {
            assert!(n.dot(Vec3::Y) > 0.97, "the top face shades flat to its edge: {n} at {p}");
        }
    }
    // A chamfer's two edges take its broad neighbours' normals, so it blends from one to the
    // other and nothing points off at 45 degrees.
    for n in beam.normals.iter().filter(|n| n.z.abs() < 0.5) {
        assert!(n.x.abs() > 0.97 || n.y.abs() > 0.97, "every side normal near a broad face's: {n}");
    }
    assert_shaded("weighted beam", &beam, 50.0);
    // Below the faces' angle every face keeps its own normal: a cuboid stays crisp.
    let mut crate_box = MeshData::new();
    crate_box.cuboid(Vec3::ZERO, Vec3::ONE, 1.0);
    let crisp = crate_box.clone();
    crate_box.weighted_normals(30.0);
    assert_eq!(crate_box.normals, crisp.normals);
}

#[test]
fn auto_uvs_project_each_face_at_the_real_density_and_split_their_seams() {
    let mut can = MeshData::new();
    can.lathe(&Profile::polyline(vec![vec2(0.0, 0.0), vec2(0.5, 0.0), vec2(0.5, 1.0), vec2(0.0, 1.0)]), 16, 1.0);
    let triangles = can.triangle_count();
    let before = can.positions.len();
    can.auto_uv(0.25);
    assert_eq!(can.triangle_count(), triangles);
    assert!(can.positions.len() != before, "vertices regrouped by the side they project along");
    for t in can.indices.chunks(3) {
        let n = face_normal(&can, t);
        let a = n.abs();
        for vertex in t {
            let (p, uv) = (can.positions[*vertex as usize], can.uvs[*vertex as usize] * 0.25);
            let expected = if a.x >= a.y && a.x >= a.z {
                vec2(-n.x.signum() * p.z, -p.y)
            } else if a.z >= a.y {
                vec2(n.z.signum() * p.x, -p.y)
            } else {
                vec2(p.x, n.y.signum() * p.z)
            };
            assert!(uv.distance(expected) < EPS, "box-projected in 0.25 m tiles: {uv} vs {expected}");
        }
    }
    assert_shaded("auto-uv can", &can, 360.0 / 16.0);
}

#[test]
fn appending_moves_turns_and_mirrors_parts_into_one_mesh() {
    let mut leg = MeshData::new();
    leg.rounded_cuboid(vec3(-0.02, 0.0, -0.02), vec3(0.02, 0.45, 0.02), 0.008, 4, 1.0);
    let mut stool = MeshData::new();
    stool.append(&leg, Transform::from_xyz(1.0, 0.0, 0.0));
    stool.append(&leg, Transform::from_xyz(-1.0, 0.0, 0.0).with_rotation(Quat::from_rotation_z(std::f32::consts::FRAC_PI_2)));
    stool.append(&leg, Transform::from_xyz(0.0, 0.0, 2.0).with_scale(vec3(-1.0, 1.0, 1.0)));
    assert_eq!(stool.triangle_count(), 3 * leg.triangle_count());
    assert!(volume(&stool) > 0.0 && (volume(&stool) - 3.0 * volume(&leg)).abs() < 1.0e-5, "every part still wound out, the mirrored one too");
    assert_shaded("stool", &stool, 45.0);
    // A part gfx.mesh would refuse is not added.
    let refused = MeshData { positions: vec![Vec3::NAN; 3], indices: vec![0, 1, 2], ..MeshData::default() };
    let count = stool.triangle_count();
    stool.append(&refused, Transform::IDENTITY);
    assert_eq!(stool.triangle_count(), count);
}

#[test]
fn every_builder_makes_the_same_bytes_from_the_same_call() {
    let build = || {
        let mut mesh = MeshData::new();
        mesh.rounded_cuboid(Vec3::ZERO, Vec3::ONE, 0.1, 6, 1.0)
            .extrude(&Profile::rounded_rect(0.2, 0.1, 0.02, 3), 1.0, 0.01, 1.0)
            .lathe(&Profile::polyline(vec![vec2(0.0, 0.0), vec2(0.3, 0.1), vec2(0.0, 0.5)]), 20, 1.0)
            .tube(&[Vec3::ZERO, vec3(0.0, 1.0, 0.0), vec3(1.0, 2.0, 0.0)], 0.04, 10, 1.0)
            .subdivide(1)
            .displace_noise(0.01, 0.2, 9)
            .auto_uv(0.5);
        mesh.to_glb().expect("builds")
    };
    assert_eq!(build(), build());
}
