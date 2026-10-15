//! The committed GLBs are exactly what the generator writes, every GLB loads in the renderer, the
//! CC0 HDR map decodes, the terrain's control map names the layout's layers, the fetched golden map
//! (when cached) is turned to the lakeside's sun, and the faceted meshes face outwards.

use genex_render::mesh::MeshData;
use showcase_game::meshgen::{all_assets, icosphere};
use showcase_game::{ASSETS_DIR, assets};
use showcase_game::draw::{BOAT_BOB, BOAT_ROLL, BOAT_WATERLINE, HULL};

#[test]
fn the_committed_glbs_are_the_generators_output() {
    for (name, bytes) in all_assets() {
        let path = format!("{ASSETS_DIR}/{name}");
        let on_disk = std::fs::read(&path).unwrap_or_else(|error| panic!("{path}: {error}; run the showcase-assets binary"));
        assert!(on_disk == bytes, "{name} differs from the generator: run the showcase-assets binary");
    }
    let generated = assets().iter().filter(|(name, _)| !name.contains('/')).count();
    assert_eq!(generated, all_assets().len(), "game/assets holds exactly the generated GLBs");
}

#[test]
fn the_hdr_map_ships_in_the_table_and_decodes_within_the_caps() {
    let maps: Vec<_> = assets().iter().filter(|(name, _)| name.starts_with("env/")).collect();
    assert_eq!(maps.iter().map(|(name, _)| *name).collect::<Vec<_>>(), [showcase_game::world::HDRI]);
    let map = genex_render::hdri::decode(maps[0].1).expect("the CC0 map decodes");
    assert_eq!((map.width, map.height), (1024, 512));
}

#[test]
fn every_glb_loads_as_a_mesh_with_triangles() {
    for (name, bytes) in assets().iter().filter(|(name, _)| name.ends_with(".glb")) {
        let mesh = MeshData::from_glb(bytes).unwrap_or_else(|error| panic!("{name}: {error}"));
        assert!(!mesh.indices.is_empty(), "{name}");
    }
}

#[test]
fn faceted_spheres_face_outwards() {
    let mesh = icosphere(1, |d| d);
    for tri in mesh.indices.chunks(3) {
        let [a, b, c] = [0, 1, 2].map(|k| genex::math::Vec3::from(mesh.positions[tri[k] as usize]));
        let normal = (b - a).cross(c - a);
        assert!(normal.dot(a + b + c) > 0.0, "a face points inwards");
    }
}

/// The control map's texels name only the terrain's six layers and blend the two that cover most
/// of the ground: the path is soil, the deep lake bed is the bed layer, a steep hillside is rock.
#[test]
fn the_control_map_names_the_layer_the_layout_puts_there() {
    use showcase_game::layout::{CABIN, LAKE_CENTER, PATH, TERRAIN_LAYERS, terrain_texel};
    let (_, control) = showcase_game::layout::terrain_ground();
    assert!(control.iter().all(|texel| (texel.control().base() as usize) < TERRAIN_LAYERS && (texel.control().overlay() as usize) < TERRAIN_LAYERS));
    let (soil, bed) = (2, 5);
    assert_eq!(terrain_texel(PATH[2].x, PATH[2].y).control().base(), soil, "the path");
    assert_eq!(terrain_texel(CABIN.x + 3.0, CABIN.y).control().base(), soil, "the yard");
    assert_eq!(terrain_texel(LAKE_CENTER.x, LAKE_CENTER.y).control().base(), bed, "the middle of the lake");
    assert_eq!(terrain_texel(LAKE_CENTER.x, LAKE_CENTER.y).control().wetness(), 255, "under the water: wet");
}

/// The fetched golden-hour map (when the asset cache holds it) is turned so its sun, which becomes
/// the scene's, stands where the lakeside's own sun does: [`showcase_game::world::GOLDEN_ROTATION_DEGREES`]
/// is the turn from the map's sun azimuth to `layout::SUN_DIR`'s, within a degree.
#[test]
fn the_golden_map_is_turned_so_its_sun_stands_where_the_lakesides_does() {
    let Some((_, bytes)) = assets().iter().find(|(name, _)| *name == showcase_game::world::GOLDEN_HDRI) else {
        eprintln!("skipped: no fetched golden-hour map (run node scripts/showcase-assets.ts fetch)");
        return;
    };
    let map = genex_render::hdri::decode(bytes).expect("the fetched map decodes");
    let sun = genex_render::hdri::analytic_sun(&map).expect("the golden-hour map holds a sun");
    let [x, _, z] = sun.direction;
    let target = showcase_game::layout::SUN_DIR;
    let turn = (genex::math::atan2(target.x, target.z) - genex::math::atan2(x, z)).to_degrees();
    let wrapped = (turn - showcase_game::world::GOLDEN_ROTATION_DEGREES + 540.0).rem_euclid(360.0) - 180.0;
    println!("map sun {:?} (elevation {:.1} degrees), turn {turn:.2} degrees", sun.direction, genex::math::asin(sun.direction[1]).to_degrees());
    assert!(wrapped.abs() <= 1.0, "turn the map by {turn:.2} degrees");
}

/// The highest point of `mesh` straight above or below (x, z), if any triangle covers it.
fn highest_at(mesh: &MeshData, x: f32, z: f32) -> Option<f32> {
    let mut top: Option<f32> = None;
    for tri in mesh.indices.chunks(3) {
        let [a, b, c] = [0, 1, 2].map(|k| mesh.vertices[tri[k] as usize].position);
        let det = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
        if det.abs() < 1e-9 {
            continue;
        }
        let l1 = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / det;
        let l2 = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / det;
        let l3 = 1.0 - l1 - l2;
        if l1 < 0.0 || l2 < 0.0 || l3 < 0.0 {
            continue;
        }
        let y = l1 * a[1] + l2 * b[1] + l3 * c[1];
        top = Some(top.map_or(y, |t: f32| t.max(y)));
    }
    top
}

/// The rowboat's widest reach from its keel line, in metres (the hull is 1.24 m wide).
const HULL_HALF_WIDTH: f32 = 0.62;

/// Gate finding 03: the rowboat read as flooded, the lake showing inside the hull. Wherever the
/// hull reaches under the water, something of the boat (its bottom boards) covers that spot above
/// the water, however far the boat bobs and rolls.
#[test]
fn the_rowboat_floats_dry_with_its_bottom_boards_over_the_water() {
    let bytes = assets().iter().find(|(name, _)| *name == HULL).map(|(_, bytes)| bytes.to_vec()).expect("the hull ships");
    let mesh = MeshData::from_glb(&bytes).expect("the hull loads");
    // The water's highest reach in the hull's frame: the boat bobs down and rolls its side under.
    let reach = BOAT_WATERLINE + BOAT_BOB + HULL_HALF_WIDTH * genex::math::sin(BOAT_ROLL);
    let mut wet = Vec::new();
    for zi in -38..=38 {
        for xi in -12..=12 {
            let (x, z) = (xi as f32 * 0.05, zi as f32 * 0.05);
            let Some(top) = highest_at(&mesh, x, z) else { continue };
            if top < reach {
                wet.push((x, z, top));
            }
        }
    }
    assert!(wet.is_empty(), "{} spots inside the hull lie under the water's reach {reach:.3}, e.g. {:?}", wet.len(), &wet[..wet.len().min(4)]);
}
