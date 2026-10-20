//! NAV-1: the Recast port bakes what C++ Recast bakes.
//!
//! Ported from rerecast v0.5.0 `crates/rerecast/tests/cpp_comparison.rs` and `crates/test_utils`
//! (MIT OR Apache-2.0, used under MIT): Recast's dungeon geometry and config go through every
//! stage, and the polygon mesh and detail mesh must equal the dumps C++ Recast wrote for the same
//! input (vertex for vertex; detail vertices within 1e-5, as upstream asserts, because Recast's
//! jitter differs in the last bits). The committed dumps are the input, the area volumes, the
//! contour set and the two meshes; the large stage dumps (heightfields and compact heightfields,
//! 2-3 MB each) stay out of the repository: point `GENEX_NAV_DUMPS` at a folder holding them
//! (from rerecast's `assets/test/dungeon` at tag v0.5.0; `N/PORTS.md` lists their sha256) and the
//! stage-by-stage rows run too.
//!
//! The fixtures are Recast's own demo level (recastnavigation, Zlib) as dumped by rerecast.
//! Changed from upstream: the JSON is read with genex-core's reader (no serde in this crate), the
//! C++ "area 63" is written as `DEFAULT_WALKABLE` where upstream maps it, and two rows are new:
//! two bakes in one process give equal bytes, and the bake time is printed (the NAV-18 baseline).

use std::path::{Path, PathBuf};
use std::time::Duration;

use genex_core::json::{self, Value};
use genex_nav::recast::{
    Aabb3d, AreaType, BuildContoursFlags, CompactHeightfield, Config, ContourSet, ConvexVolume, DetailNavmesh,
    Heightfield, HeightfieldBuilder, PolygonNavmesh, RecastError, RegionId, TriMesh,
};
use glam::{U8Vec3, UVec3, Vec2, Vec3, Vec3A};

/// Nesting a stage dump reaches (a heightfield column chains its spans as nested objects).
const DUMP_DEPTH: usize = 4096;
/// How far a detail vertex may sit from the C++ one (upstream's tolerance: Recast's jitter).
const DETAIL_VERTEX_TOLERANCE: f32 = 1.0e-5;
/// Relative tolerance of the float headers (upstream's `relative_eq!` epsilon).
const HEADER_EPSILON: f32 = 1.0e-6;
/// Recast's walkable area id in the C++ dumps; the port's walkable area is `u8::MAX`.
const CPP_WALKABLE_AREA: u8 = 63;

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/recast/dungeon")
}

fn load(dir: &Path, name: &str) -> Value {
    let path = dir.join(format!("{name}.json"));
    let text = std::fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    json::parse_with_depth(&text, DUMP_DEPTH).unwrap_or_else(|e| panic!("parse {}: {e:?}", path.display()))
}

fn f(value: &Value) -> f32 {
    value.as_f64() as f32
}

fn u(value: &Value) -> u32 {
    let number = value.as_f64();
    assert!(number >= 0.0 && number.fract() == 0.0, "{number} is not a whole number");
    number as u32
}

fn u16_of(value: &Value) -> u16 {
    u16::try_from(u(value)).expect("a u16")
}

fn vec3(value: &Value) -> Vec3 {
    let items = value.items();
    Vec3::new(f(&items[0]), f(&items[1]), f(&items[2]))
}

fn area(cpp: u32) -> AreaType {
    let cpp = u8::try_from(cpp).expect("an area id");
    if cpp == CPP_WALKABLE_AREA { AreaType::DEFAULT_WALKABLE } else { AreaType::from(cpp) }
}

fn close(a: f32, b: f32) -> bool {
    a == b || (a - b).abs() <= HEADER_EPSILON * a.abs().max(b.abs())
}

fn trimesh(dir: &Path) -> TriMesh {
    let geometry = load(dir, "geometry");
    let vertices: Vec<Vec3A> = geometry["verts"].items().iter().map(|v| Vec3A::from(vec3(v))).collect();
    let indices: Vec<UVec3> = geometry["tris"]
        .items()
        .iter()
        .map(|t| {
            let t = t.items();
            UVec3::new(u(&t[0]), u(&t[1]), u(&t[2]))
        })
        .collect();
    let area_types = vec![AreaType::NOT_WALKABLE; indices.len()];
    TriMesh { vertices, indices, area_types }
}

/// rerecast's `Config::load_from_test_data`.
fn config(dir: &Path) -> Config {
    let c = load(dir, "config");
    Config {
        width: u16_of(&c["width"]),
        height: u16_of(&c["height"]),
        tile_size: u16_of(&c["tileSize"]),
        border_size: u16_of(&c["borderSize"]),
        cell_size: f(&c["cs"]),
        cell_height: f(&c["ch"]),
        aabb: Aabb3d { min: vec3(&c["bmin"]), max: vec3(&c["bmax"]) },
        walkable_slope_angle: f(&c["walkableSlopeAngle"]).to_radians(),
        walkable_height: u16_of(&c["walkableHeight"]),
        walkable_climb: u16_of(&c["walkableClimb"]),
        walkable_radius: u16_of(&c["walkableRadius"]),
        max_edge_len: u16_of(&c["maxEdgeLen"]),
        max_simplification_error: f(&c["maxSimplificationError"]),
        min_region_area: u16_of(&c["minRegionArea"]),
        merge_region_area: u16_of(&c["mergeRegionArea"]),
        max_vertices_per_polygon: u16_of(&c["maxVertsPerPoly"]),
        detail_sample_dist: f(&c["detailSampleDist"]),
        detail_sample_max_error: f(&c["detailSampleMaxError"]),
        area_volumes: Vec::new(),
        contour_flags: BuildContoursFlags::default(),
    }
}

fn volumes(dir: &Path) -> Vec<ConvexVolume> {
    load(dir, "convex_volumes")["volumes"]
        .items()
        .iter()
        .map(|volume| ConvexVolume {
            vertices: volume["verts"].items().iter().map(vec3).map(|v| Vec2::new(v.x, v.z)).collect(),
            min_y: f(&volume["hmin"]),
            max_y: f(&volume["hmax"]),
            area: area(u(&volume["area"])),
        })
        .collect()
}

/// Every stage's output, kept for the stage rows.
struct Bake {
    heightfield_initial: Heightfield,
    heightfield_filtered: Heightfield,
    compact_initial: CompactHeightfield,
    compact_eroded: CompactHeightfield,
    compact_distance: CompactHeightfield,
    compact_regions: CompactHeightfield,
    compact_contours: CompactHeightfield,
    contours: ContourSet,
    poly_mesh: PolygonNavmesh,
    detail_mesh: DetailNavmesh,
}

/// The pipeline of upstream's `validate_navmesh_against_cpp_implementation`, stage for stage.
fn bake(trimesh: &TriMesh, config: &Config, volumes: &[ConvexVolume]) -> Result<Bake, RecastError> {
    let mut trimesh = trimesh.clone();
    trimesh.mark_walkable_triangles(config.walkable_slope_angle);
    let aabb = trimesh.compute_aabb().expect("geometry");
    let mut heightfield = HeightfieldBuilder { aabb, cell_size: config.cell_size, cell_height: config.cell_height }.build()?;
    heightfield.rasterize_triangles(&trimesh, config.walkable_climb)?;
    let heightfield_initial = heightfield.clone();

    heightfield.filter_low_hanging_walkable_obstacles(config.walkable_climb);
    heightfield.filter_ledge_spans(config.walkable_height, config.walkable_climb);
    heightfield.filter_walkable_low_height_spans(config.walkable_height);
    let heightfield_filtered = heightfield.clone();

    let mut compact = heightfield.into_compact(config.walkable_height, config.walkable_climb)?;
    let compact_initial = compact.clone();
    compact.erode_walkable_area(config.walkable_radius);
    let compact_eroded = compact.clone();
    for volume in volumes {
        compact.mark_convex_poly_area(volume);
    }
    compact.build_distance_field();
    let compact_distance = compact.clone();
    compact.build_regions(config.border_size, config.min_region_area, config.merge_region_area)?;
    let compact_regions = compact.clone();
    let contours = compact.build_contours(config.max_simplification_error, config.max_edge_len, config.contour_flags);
    let compact_contours = compact.clone();
    let poly_mesh = contours.clone().into_polygon_mesh(config.max_vertices_per_polygon)?;
    let detail_mesh = DetailNavmesh::new(&poly_mesh, &compact, config.detail_sample_dist, config.detail_sample_max_error)?;
    Ok(Bake {
        heightfield_initial,
        heightfield_filtered,
        compact_initial,
        compact_eroded,
        compact_distance,
        compact_regions,
        compact_contours,
        contours,
        poly_mesh,
        detail_mesh,
    })
}

fn dungeon_bake() -> (Config, TriMesh, Bake) {
    let dir = fixture_dir();
    let trimesh = trimesh(&dir);
    let config = config(&dir);
    assert_eq!(Some(config.aabb), trimesh.compute_aabb(), "the config's box is the geometry's");
    let bake = bake(&trimesh, &config, &volumes(&dir)).expect("the dungeon bakes");
    (config, trimesh, bake)
}

fn assert_poly_mesh(mesh: &PolygonNavmesh, cpp: &Value) {
    for (axis, (c, r)) in cpp["bmin"].items().iter().zip(mesh.aabb.min.to_array()).enumerate() {
        assert!(close(f(c), r), "poly mesh aabb min {axis}");
    }
    for (axis, (c, r)) in cpp["bmax"].items().iter().zip(mesh.aabb.max.to_array()).enumerate() {
        assert!(close(f(c), r), "poly mesh aabb max {axis}");
    }
    assert!(close(f(&cpp["cs"]), mesh.cell_size), "poly mesh cell size");
    assert!(close(f(&cpp["ch"]), mesh.cell_height), "poly mesh cell height");
    let nvp = u16_of(&cpp["nvp"]);
    assert_eq!(nvp, mesh.max_vertices_per_polygon, "poly mesh vertices per polygon");
    assert_eq!(u16_of(&cpp["borderSize"]), mesh.border_size, "poly mesh border size");
    assert!(close(f(&cpp["maxEdgeError"]), mesh.max_edge_error), "poly mesh max edge error");

    let verts = cpp["verts"].items();
    assert_eq!(verts.len(), mesh.vertices.len(), "poly mesh vertex count");
    for (i, (c, r)) in verts.iter().zip(&mesh.vertices).enumerate() {
        let c: Vec<u16> = c.items().iter().map(u16_of).collect();
        assert_eq!(c, r.to_array(), "poly mesh vertex {i}");
    }

    let polys: Vec<u16> = cpp["polys"].items().iter().map(u16_of).collect();
    let (mut cpp_polygons, mut cpp_neighbors) = (Vec::new(), Vec::new());
    for chunk in polys.chunks_exact(usize::from(nvp) * 2) {
        let (vertices, neighbors) = chunk.split_at(usize::from(nvp));
        cpp_polygons.extend_from_slice(vertices);
        cpp_neighbors.extend_from_slice(neighbors);
    }
    assert_eq!(cpp_polygons.len(), mesh.polygons.len(), "poly mesh polygon indices");
    assert_eq!(cpp_polygons, mesh.polygons, "poly mesh polygons");
    assert_eq!(cpp_neighbors, mesh.polygon_neighbors, "poly mesh neighbours");

    let areas: Vec<AreaType> = cpp["areas"].items().iter().map(|a| area(u(a))).collect();
    assert_eq!(areas, mesh.areas, "poly mesh areas");
    let flags: Vec<u16> = cpp["flags"].items().iter().map(u16_of).collect();
    assert_eq!(flags, mesh.flags, "poly mesh flags");
}

fn assert_detail_mesh(mesh: &DetailNavmesh, cpp: &Value) {
    let meshes = cpp["meshes"].items();
    assert_eq!(meshes.len(), mesh.meshes.len(), "detail sub-mesh count");
    for (i, (c, r)) in meshes.iter().zip(&mesh.meshes).enumerate() {
        let c: Vec<u32> = c.items().iter().map(u).collect();
        assert_eq!(c, [r.base_vertex_index, r.vertex_count, r.base_triangle_index, r.triangle_count], "detail sub-mesh {i}");
    }
    let tris = cpp["tris"].items();
    assert_eq!(tris.len(), mesh.triangles.len(), "detail triangle count");
    for (i, (c, (triangle, flags))) in tris.iter().zip(mesh.triangles.iter().zip(&mesh.triangle_flags)).enumerate() {
        let c: Vec<u8> = c.items().iter().map(|v| u8::try_from(u(v)).expect("a u8")).collect();
        assert_eq!(U8Vec3::from_slice(&c[..3]), U8Vec3::from_array(*triangle), "detail triangle {i}");
        assert_eq!(c[3], *flags, "detail triangle {i} flags");
    }
    let verts = cpp["verts"].items();
    assert_eq!(verts.len(), mesh.vertices.len(), "detail vertex count");
    for (i, (c, r)) in verts.iter().zip(&mesh.vertices).enumerate() {
        let c = vec3(c);
        assert!(r.distance(c) < DETAIL_VERTEX_TOLERANCE, "detail vertex {i}: {r} against C++ {c}");
    }
}

fn assert_contours(contours: &ContourSet, cpp: &Value) {
    for (axis, (c, r)) in cpp["bmin"].items().iter().zip(contours.aabb.min.to_array()).enumerate() {
        assert!(close(f(c), r), "contour aabb min {axis}");
    }
    assert!(close(f(&cpp["cs"]), contours.cell_size), "contour cell size");
    assert!(close(f(&cpp["ch"]), contours.cell_height), "contour cell height");
    assert_eq!(u16_of(&cpp["width"]), contours.width, "contour width");
    assert_eq!(u16_of(&cpp["height"]), contours.height, "contour height");
    assert_eq!(u16_of(&cpp["borderSize"]), contours.border_size, "contour border size");
    assert!(close(f(&cpp["maxError"]), contours.max_error), "contour max error");
    let cpp_contours = cpp["contours"].items();
    assert_eq!(cpp_contours.len(), contours.contours.len(), "contour count");
    for (i, (c, r)) in cpp_contours.iter().zip(&contours.contours).enumerate() {
        assert_eq!(u16_of(&c["reg"]), r.region.bits(), "contour {i} region");
        assert_eq!(area(u(&c["area"])), r.area, "contour {i} area");
        let verts: Vec<[u32; 4]> = c["verts"].items().iter().map(quad).collect();
        let ours: Vec<[u32; 4]> = r.vertices.iter().map(|(p, data)| [u32::from(p.x), u32::from(p.y), u32::from(p.z), *data]).collect();
        assert_eq!(verts, ours, "contour {i} vertices");
        let raw: Vec<[u32; 4]> = c["rverts"].items().iter().map(quad).collect();
        let ours: Vec<[u32; 4]> =
            r.raw_vertices.iter().map(|(p, data)| [u32::from(p.x), u32::from(p.y), u32::from(p.z), data.bits()]).collect();
        assert_eq!(raw, ours, "contour {i} raw vertices");
    }
}

fn quad(value: &Value) -> [u32; 4] {
    let items = value.items();
    [u(&items[0]), u(&items[1]), u(&items[2]), u(&items[3])]
}

/// Red row (NAV-1): the dungeon's polygon and detail meshes equal C++ Recast's.
#[test]
fn the_dungeon_bake_equals_cpp_recast() {
    let (_, _, bake) = dungeon_bake();
    let dir = fixture_dir();
    assert_contours(&bake.contours, &load(&dir, "contour_set"));
    assert_poly_mesh(&bake.poly_mesh, &load(&dir, "poly_mesh"));
    assert_detail_mesh(&bake.detail_mesh, &load(&dir, "poly_mesh_detail"));
}

/// Bytes that pin every field of a polygon mesh and a detail mesh (floats by their bits).
fn mesh_bytes(poly: &PolygonNavmesh, detail: &DetailNavmesh) -> Vec<u8> {
    let mut out = Vec::new();
    for v in &poly.vertices {
        for c in v.to_array() {
            out.extend_from_slice(&c.to_le_bytes());
        }
    }
    for list in [&poly.polygons, &poly.polygon_neighbors, &poly.flags] {
        out.extend_from_slice(&(list.len() as u32).to_le_bytes());
        for v in list.iter() {
            out.extend_from_slice(&v.to_le_bytes());
        }
    }
    out.extend(poly.regions.iter().flat_map(|r| r.bits().to_le_bytes()));
    out.extend(poly.areas.iter().map(|a| a.0));
    for m in &detail.meshes {
        for v in [m.base_vertex_index, m.vertex_count, m.base_triangle_index, m.triangle_count] {
            out.extend_from_slice(&v.to_le_bytes());
        }
    }
    out.extend(detail.vertices.iter().flat_map(|v| v.to_array()).flat_map(|c| c.to_bits().to_le_bytes()));
    out.extend(detail.triangles.iter().flatten());
    out.extend(&detail.triangle_flags);
    out
}

/// New behaviour (NAV-1): two bakes of the same input in one process give equal bytes, and the
/// bake time is printed as the NAV-18 baseline (advisory in a lane; gated at NAV-18).
#[test]
#[allow(clippy::disallowed_types, reason = "the baseline row measures the wall clock on purpose; nothing replays it")]
fn two_dungeon_bakes_are_byte_equal() {
    let dir = fixture_dir();
    let (trimesh, config, volumes) = (trimesh(&dir), config(&dir), volumes(&dir));
    let clock = std::time::Instant::now();
    let first = bake(&trimesh, &config, &volumes).expect("the dungeon bakes");
    let first_time: Duration = clock.elapsed();
    let second = bake(&trimesh, &config, &volumes).expect("the dungeon bakes again");
    let a = mesh_bytes(&first.poly_mesh, &first.detail_mesh);
    let b = mesh_bytes(&second.poly_mesh, &second.detail_mesh);
    assert!(!a.is_empty());
    assert_eq!(a, b, "two bakes differ");
    println!(
        "dungeon bake: {:.1} ms (with stage copies), {} polygons, {} detail triangles, digest {:016x}",
        first_time.as_secs_f64() * 1000.0,
        first.poly_mesh.polygon_count(),
        first.detail_mesh.triangles.len(),
        genex_core::digest::fnv1a64(&a)
    );
}

// --- Stage rows: run when `GENEX_NAV_DUMPS` names a folder of rerecast's stage dumps. ---

fn assert_heightfield(field: &Heightfield, cpp: &Value, name: &str) {
    assert_eq!(field.width, u16_of(&cpp["width"]), "{name}: width");
    assert_eq!(field.height, u16_of(&cpp["height"]), "{name}: height");
    assert_eq!(field.aabb.min, vec3(&cpp["bmin"]), "{name}: aabb min");
    assert_eq!(field.aabb.max, vec3(&cpp["bmax"]), "{name}: aabb max");
    assert_eq!(field.cell_size, f(&cpp["cs"]), "{name}: cell size");
    assert_eq!(field.cell_height, f(&cpp["ch"]), "{name}: cell height");
    let columns = cpp["spans"].items();
    assert_eq!(field.spans.len(), columns.len(), "{name}: column count");
    for z in 0..field.height {
        for x in 0..field.width {
            let column = usize::from(x) + usize::from(z) * usize::from(field.width);
            let mut ours = field.span_key_at(x, z);
            let mut theirs = &columns[column];
            let mut layer = 0;
            while theirs.get("min").is_some() {
                let key = ours.unwrap_or_else(|| panic!("{name}: C++ has a span at [{x}, {z}, {layer}] and the port does not"));
                let span = &field.allocated_spans[key];
                assert_eq!(span.min, u16_of(&theirs["min"]), "{name}: [{x}, {z}, {layer}] min");
                assert_eq!(span.max, u16_of(&theirs["max"]), "{name}: [{x}, {z}, {layer}] max");
                assert_eq!(span.area, area(u(&theirs["area"])), "{name}: [{x}, {z}, {layer}] area");
                ours = span.next;
                theirs = &theirs["next"];
                layer += 1;
            }
            assert!(ours.is_none(), "{name}: the port has a span at [{x}, {z}, {layer}] and C++ does not");
        }
    }
}

fn assert_compact(field: &CompactHeightfield, cpp: &Value, name: &str) {
    assert_eq!(field.width, u16_of(&cpp["width"]), "{name}: width");
    assert_eq!(field.height, u16_of(&cpp["height"]), "{name}: height");
    assert_eq!(field.walkable_height, u16_of(&cpp["walkableHeight"]), "{name}: walkable height");
    assert_eq!(field.walkable_climb, u16_of(&cpp["walkableClimb"]), "{name}: walkable climb");
    assert_eq!(field.border_size, u16_of(&cpp["borderSize"]), "{name}: border size");
    assert_eq!(field.max_region.bits(), u16_of(&cpp["maxRegions"]), "{name}: max region");
    assert_eq!(field.max_distance, u16_of(&cpp["maxDistance"]), "{name}: max distance");
    assert_eq!(field.aabb.min, vec3(&cpp["bmin"]), "{name}: aabb min");
    assert_eq!(field.aabb.max, vec3(&cpp["bmax"]), "{name}: aabb max");
    let cells = cpp["cells"].items();
    assert_eq!(field.cells.len(), cells.len(), "{name}: cell count");
    for (i, (cell, c)) in field.cells.iter().zip(cells).enumerate() {
        assert_eq!(cell.index(), u(&c["index"]), "{name}: cell {i} index");
        assert_eq!(u32::from(cell.count()), u(&c["count"]), "{name}: cell {i} count");
    }
    let spans = cpp["spans"].items();
    assert_eq!(field.spans.len(), spans.len(), "{name}: span count");
    for (i, (span, c)) in field.spans.iter().zip(spans).enumerate() {
        assert_eq!(span.y, u16_of(&c["y"]), "{name}: span {i} y");
        assert_eq!(span.region, RegionId::from(u16_of(&c["reg"])), "{name}: span {i} region");
        assert_eq!(span.data & 0x00FF_FFFF, u(&c["con"]), "{name}: span {i} connections");
        assert_eq!(u32::from(span.height()), u(&c["h"]), "{name}: span {i} height");
    }
    let dist: Vec<u16> = cpp["dist"].items().iter().map(u16_of).collect();
    assert_eq!(field.dist, dist, "{name}: distances");
    let areas: Vec<AreaType> = cpp["areas"].items().iter().map(|a| area(u(a))).collect();
    assert_eq!(field.areas, areas, "{name}: areas");
}

/// Stage rows (NAV-1, with `GENEX_NAV_DUMPS`): every intermediate stage equals C++ Recast's.
#[test]
fn every_dungeon_stage_equals_cpp_recast_when_the_dumps_are_present() {
    let Some(dumps) = std::env::var_os("GENEX_NAV_DUMPS").map(PathBuf::from) else {
        println!("GENEX_NAV_DUMPS is not set: the stage rows did not run");
        return;
    };
    let (_, _, bake) = dungeon_bake();
    assert_heightfield(&bake.heightfield_initial, &load(&dumps, "heightfield_initial"), "heightfield_initial");
    assert_heightfield(&bake.heightfield_filtered, &load(&dumps, "heightfield_filtered"), "heightfield_filtered");
    let stages = [
        (&bake.compact_initial, "compact_heightfield_initial"),
        (&bake.compact_eroded, "compact_heightfield_eroded"),
        (&bake.compact_distance, "compact_heightfield_distance_field"),
        (&bake.compact_regions, "compact_heightfield_regions"),
        (&bake.compact_contours, "compact_heightfield_contours"),
    ];
    for (field, name) in stages {
        assert_compact(field, &load(&dumps, name), name);
    }
    println!("every stage row ran against {}", dumps.display());
}
