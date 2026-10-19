//! NAV-4: the ported landmass runtime core stitches islands the same way on every run.
//!
//! Upstream landmass keeps its stitching state in std `HashMap`/`HashSet`s seeded per process (and
//! per map), so the order it walks dirty islands and node link sets in decides which off-mesh link
//! gets which id and which region gets which number. The port (P1) keeps them in insertion-ordered
//! `Map`/`Set`s and a deterministic arena, so 32 replicas of one archipelago session agree on every
//! link id, boundary link, modified node and region number. Upstream's own expected stitch results
//! (which check `clip.rs` and `grid.rs`, the `geo` and `kdtree` replacements) are the converted
//! upstream tests in `src/runtime/nav_data_test.rs`.

use std::fmt::Write as _;
use std::sync::Arc;

use genex_core::digest::fnv1a64;
use genex_nav::arena::ArenaKey;
use genex_nav::runtime::coords::{CoordinateSystem, GenexCoords, XYZ};
use genex_nav::runtime::island::{Island, IslandId};
use genex_nav::runtime::link::{AnimationLink, AnimationLinkId, PermittedAnimationLinks};
use genex_nav::runtime::nav_data::{KindedOffMeshLink, NavigationData, NodeRef, DEFAULT_EDGE_LINK_DISTANCE};
use genex_nav::runtime::nav_mesh::NavigationMesh;
use genex_nav::runtime::util::Transform;
use glam::Vec3;

const REPLICAS: usize = 32;
/// How far above or below the mesh an animation link's ends may sit and still attach.
const LINK_VERTICAL_DISTANCE: f32 = 0.5;

/// A `cols` × `rows` grid of rectangles covering `size` metres from (`x0`, `z0`) toward +x and −z,
/// in genex's Y-up coordinates, each polygon counter-clockwise seen from above.
fn grid_mesh(x0: f32, z0: f32, size: f32, cols: usize, rows: usize) -> NavigationMesh<GenexCoords> {
    let (w, h) = (size / cols as f32, size / rows as f32);
    let mut vertices = Vec::new();
    for j in 0..=rows {
        for i in 0..=cols {
            vertices.push(Vec3::new(x0 + i as f32 * w, 0.0, z0 - j as f32 * h));
        }
    }
    let at = |i: usize, j: usize| j * (cols + 1) + i;
    let mut polygons = Vec::new();
    for j in 0..rows {
        for i in 0..cols {
            polygons.push(vec![at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)]);
        }
    }
    let polygon_type_indices = vec![0; polygons.len()];
    NavigationMesh { vertices, polygons, polygon_type_indices, height_mesh: None }
}

fn island(mesh: NavigationMesh<GenexCoords>) -> Island<GenexCoords> {
    Island::new(Transform::default(), Arc::new(mesh.validate().expect("a valid grid mesh")))
}

/// The four islands of the archipelago: A (2×2 cells), B (one cell), C (three strips) and D (2×3).
fn islands() -> [Island<GenexCoords>; 4] {
    [
        island(grid_mesh(0.0, 0.0, 2.0, 2, 2)),
        island(grid_mesh(2.0, 0.0, 2.0, 1, 1)),
        island(grid_mesh(0.0, -2.0, 2.0, 3, 1)),
        island(grid_mesh(2.0, -2.0, 2.0, 2, 3)),
    ]
}

fn link(start: (Vec3, Vec3), end: (Vec3, Vec3), kind: usize, cost: f32, bidirectional: bool) -> AnimationLink<GenexCoords> {
    AnimationLink { start_edge: start, end_edge: end, kind, cost, bidirectional }
}

fn v(x: f32, z: f32) -> Vec3 {
    Vec3::new(x, 0.0, z)
}

/// Six animation links: edges and points, one-way and both ways, within one island and across.
fn links() -> [AnimationLink<GenexCoords>; 6] {
    [
        link((v(0.2, -0.2), v(0.8, -0.2)), (v(3.2, -3.2), v(3.8, -3.2)), 1, 2.0, false),
        link((v(1.5, -1.5), v(1.5, -1.5)), (v(3.5, -0.5), v(3.5, -0.5)), 2, 1.0, true),
        link((v(1.5, -1.0), v(2.5, -1.0)), (v(1.5, -3.0), v(2.5, -3.0)), 1, 3.0, true),
        link((v(0.5, -2.5), v(0.5, -3.5)), (v(3.5, -1.5), v(3.5, -0.5)), 3, 1.5, false),
        link((v(0.2, -1.2), v(0.2, -1.8)), (v(1.8, -0.2), v(1.8, -0.8)), 2, 1.0, false),
        link((v(3.0, -3.5), v(3.0, -3.5)), (v(0.5, -0.5), v(1.5, -0.5)), 1, 1.0, false),
    ]
}

fn node(n: NodeRef) -> String {
    format!("{}:{}", n.island_id.raw(), n.polygon_index)
}

fn bits(p: Vec3) -> [u32; 3] {
    [p.x.to_bits(), p.y.to_bits(), p.z.to_bits()]
}

/// Everything stitching decided, in the order the nav data holds it, as text.
fn trace<CS: CoordinateSystem>(data: &NavigationData<CS>) -> String {
    let mut out = String::new();
    for (source, id, link) in data.off_mesh_links_by_node() {
        let kind = match &link.kinded {
            KindedOffMeshLink::BoundaryLink { reverse_link } => format!("boundary rev {}", reverse_link.raw()),
            KindedOffMeshLink::AnimationLink { destination_portal, cost, kind, animation_link } => format!(
                "anim {} kind {kind} cost {} to {:?} {:?}",
                animation_link.raw(),
                cost.to_bits(),
                bits(destination_portal.0),
                bits(destination_portal.1)
            ),
        };
        let _ = writeln!(
            out,
            "link {} from {} to {} type {} portal {:?} {:?} {kind}",
            id.raw(),
            node(source),
            node(link.destination_node),
            link.destination_type_index,
            bits(link.portal.0),
            bits(link.portal.1),
        );
    }
    for (n, modified) in data.modified_nodes() {
        let vertices: Vec<[u32; 2]> = modified.new_vertices.iter().map(|p| [p.x.to_bits(), p.y.to_bits()]).collect();
        let _ = writeln!(out, "modified {} boundary {:?} new {vertices:?}", node(n), modified.new_boundary);
    }
    for ((island, region), number) in data.region_numbers() {
        let _ = writeln!(out, "region {}:{region} = {number} root {}", island.raw(), data.region_root(number));
    }
    out
}

/// One run of the archipelago session; returns the trace after every update.
fn session() -> Vec<String> {
    let mut data = NavigationData::<GenexCoords>::new();
    let mut traces = Vec::new();
    let [a, b, c, d] = islands();
    let a = data.add_island(a);
    let b = data.add_island(b);
    let c = data.add_island(c);
    let d = data.add_island(d);
    let link_ids: Vec<AnimationLinkId> = links().into_iter().map(|l| data.add_animation_link(l)).collect();
    let mut update = |data: &mut NavigationData<GenexCoords>| {
        data.update(DEFAULT_EDGE_LINK_DISTANCE, LINK_VERTICAL_DISTANCE);
        traces.push(trace(data));
    };
    update(&mut data);

    data.remove_island(b);
    update(&mut data);

    let [_, b_again, c_again, d_again] = islands();
    let _b = data.add_island(b_again);
    data.remove_animation_link(link_ids[2]);
    let [_, _, third, _, _, _] = links();
    data.add_animation_link(third);
    update(&mut data);

    data.remove_island(c);
    data.remove_island(d);
    update(&mut data);

    data.add_island(d_again);
    data.add_island(c_again);
    update(&mut data);

    let mut island_a = data.get_island_mut(a).expect("A is live");
    let transform = island_a.get_transform().clone();
    island_a.set_transform(transform);
    update(&mut data);
    traces
}

#[test]
fn replicas_of_one_archipelago_agree_on_link_ids_boundaries_and_regions() {
    let first = session();
    let mut differing = 0;
    for _ in 1..REPLICAS {
        if session() != first {
            differing += 1;
        }
    }
    assert_eq!(differing, 0, "{differing} of {} replicas stitched differently", REPLICAS - 1);
    let digests: Vec<String> = first.iter().map(|t| format!("{:016x}", fnv1a64(t.as_bytes()))).collect();
    println!("trace digests per update: {digests:?}");
}

#[test]
fn the_session_stitches_touching_islands_and_links_regions() {
    let mut data = NavigationData::<GenexCoords>::new();
    let [a, b, c, d] = islands();
    let (a, b, c, d) = (data.add_island(a), data.add_island(b), data.add_island(c), data.add_island(d));
    let [first, ..] = links();
    data.add_animation_link(first);
    data.update(DEFAULT_EDGE_LINK_DISTANCE, LINK_VERTICAL_DISTANCE);

    let boundary = data
        .off_mesh_links_by_node()
        .filter(|(_, _, l)| matches!(l.kinded, KindedOffMeshLink::BoundaryLink { .. }))
        .count();
    // Portals: A–B 2 (A's two rows against B's one cell), A–C 4 (A's two cells against C's three
    // strips), B–D 2 (B against D's two columns), C–D 3 (C's one row against D's three rows). The
    // corner-only pairs (A–D, B–C) make none. Each portal is a pair of links.
    assert_eq!(boundary, 2 * (2 + 4 + 2 + 3), "boundary links");
    let animation = data
        .off_mesh_links_by_node()
        .filter(|(_, _, l)| matches!(l.kinded, KindedOffMeshLink::AnimationLink { .. }))
        .count();
    assert!(animation >= 1, "the A → D link attached");

    let on = |island: IslandId, polygon_index: usize| NodeRef { island_id: island, polygon_index };
    let all = PermittedAnimationLinks::All;
    assert!(data.are_nodes_connected(on(a, 0), on(d, 5), all.clone()), "A reaches D across B and C");
    data.remove_island(b);
    data.remove_island(c);
    data.update(DEFAULT_EDGE_LINK_DISTANCE, LINK_VERTICAL_DISTANCE);
    assert!(data.are_nodes_connected(on(a, 0), on(d, 5), all), "the A → D link still joins them");
    let only_kind_9 = PermittedAnimationLinks::kinds([9]);
    assert!(!data.are_nodes_connected(on(a, 0), on(d, 5), only_kind_9), "not without that link's kind");
}

#[test]
fn genex_coordinates_are_landmass_x_minus_z_y() {
    let p = Vec3::new(1.0, 2.0, 3.0);
    assert_eq!(GenexCoords::to_landmass(&p), Vec3::new(1.0, -3.0, 2.0));
    assert_eq!(GenexCoords::from_landmass(&GenexCoords::to_landmass(&p)), p);
    assert_eq!(XYZ::to_landmass(&p), p);
}
