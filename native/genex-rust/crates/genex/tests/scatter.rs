//! Set dressing (AAA review WP-8): a dressing places the same things from the same seed, bit for
//! bit, and another seed places others; a layer is untouched by layers it does not refer to;
//! every rule keeps exactly what it promises (slope, height, spacing, zones, earlier layers,
//! clusters, caps, ranges); splines and volumes place inside their bands; placements become
//! instance groups by variant and tint and decals on their surfaces; hostile numbers place
//! nothing and never panic. CPU only.

use genex::prelude::*;
use genex::{DRESSING_CANDIDATES_MAX, DRESSING_TINT_BUCKETS, Dressing, Layer, Placed, Spline, Surface, Zone};

const EPS: f32 = 1.0e-4;

/// A 10 x 10 m floor at y = 0.
fn floor() -> Surface {
    Surface::floor(vec2(-5.0, -5.0), vec2(5.0, 5.0), 0.0)
}

/// The floor and a 10 m wall 3 m tall along its back edge, facing the room (+z).
fn room() -> Surface {
    floor().and(&Surface::wall(vec3(-5.0, 0.0, -5.0), vec3(5.0, 0.0, -5.0), 3.0, Vec3::Z))
}

fn positions(placed: &[Placed]) -> Vec<Vec3> {
    placed.iter().map(|p| p.transform.translation).collect()
}

fn one(seed: u32, layer: Layer) -> Vec<Placed> {
    let mut dressing = Dressing::new(seed);
    dressing.layer("layer", layer);
    dressing.run().get("layer").to_vec()
}

#[test]
fn the_same_seed_places_the_same_things_and_another_seed_others() {
    let layer = || Layer::on(&room()).density(4.0).spacing(0.3).scale(0.5, 2.0).tilt(15.0).tint(0.8, 1.1).variants(3).clustered(2.0, 0.6);
    let a = one(11, layer());
    assert!(a.len() > 50, "enough placed to compare: {}", a.len());
    assert_eq!(a, one(11, layer()), "bit for bit");
    let b = one(12, layer());
    assert_ne!(positions(&a), positions(&b));
}

#[test]
fn a_layer_is_untouched_by_layers_it_does_not_refer_to() {
    let rubble = Layer::on(&floor()).density(2.0).spacing(0.4);
    let mut alone = Dressing::new(5);
    alone.layer("rubble", rubble.clone());
    let mut crowded = Dressing::new(5);
    crowded.layer("papers", Layer::on(&floor()).density(9.0)).layer("rubble", rubble).layer("posters", Layer::on(&room()).density(1.0));
    assert_eq!(alone.run().get("rubble"), crowded.run().get("rubble"), "seeded by the dressing's seed and its own name");
    // A rule change thins candidates without reshuffling the ones it keeps.
    let all = one(3, Layer::on(&floor()).density(3.0));
    let some = one(3, Layer::on(&floor()).density(3.0).avoid(Zone::cuboid(vec3(-5.0, -1.0, -5.0), vec3(0.0, 1.0, 5.0)), 0.0));
    let kept: Vec<&Placed> = all.iter().filter(|p| p.transform.translation.x > 0.0).collect();
    assert_eq!(some.iter().collect::<Vec<_>>(), kept, "the same placements, the others dropped");
}

#[test]
fn density_counts_candidates_and_a_cap_stops_them() {
    assert_eq!(one(1, Layer::on(&floor()).density(1.0)).len(), 100, "1 a square metre on 100 square metres");
    assert_eq!(one(1, Layer::on(&floor()).density(1.0).cap(7)).len(), 7);
    for hostile in [0.0, -3.0, f32::NAN, f32::INFINITY] {
        assert!(one(1, Layer::on(&floor()).density(hostile)).is_empty(), "density {hostile} places nothing");
    }
    let huge = one(1, Layer::on(&floor()).density(1.0e12).cap(10));
    assert_eq!(huge.len(), 10, "held to {DRESSING_CANDIDATES_MAX} candidates, then the cap");
    assert!(one(1, Layer::on(&Surface::default()).density(5.0)).is_empty(), "an empty surface places nothing");
    let degenerate = Surface::from_triangle_list([[Vec3::ZERO, Vec3::X, Vec3::X * 2.0], [Vec3::NAN, Vec3::Y, Vec3::Z]]);
    assert_eq!(degenerate.area(), 0.0, "degenerate and non-finite triangles dropped");
}

#[test]
fn slope_and_height_bands_keep_floors_walls_and_poster_height() {
    let on_floor = one(2, Layer::on(&room()).density(3.0).slope(0.0, 30.0));
    assert!(!on_floor.is_empty() && on_floor.iter().all(|p| p.normal.y > 0.86), "floor only");
    let on_wall = one(2, Layer::on(&room()).density(3.0).slope(80.0, 100.0).height(1.2, 2.0));
    assert!(!on_wall.is_empty());
    for p in &on_wall {
        assert!(p.normal.z > 0.99, "on the wall, facing the room: {}", p.normal);
        let y = p.transform.translation.y;
        assert!((1.2..=2.0).contains(&y), "at poster height: {y}");
    }
}

#[test]
fn spacing_zones_and_earlier_layers_hold_their_distances() {
    let spaced = one(4, Layer::on(&floor()).density(20.0).spacing(0.5));
    let points = positions(&spaced);
    for (i, a) in points.iter().enumerate() {
        for b in &points[i + 1..] {
            assert!(a.distance(*b) >= 0.5, "spacing: {a} {b}");
        }
    }
    let door = Zone::sphere(vec3(0.0, 0.0, 5.0), 1.0);
    let clear = one(4, Layer::on(&floor()).density(8.0).avoid(door.clone(), 0.5));
    assert!(clear.iter().all(|p| door.distance(p.transform.translation) >= 0.5), "the doorway kept clear");
    let wall_base = Zone::cuboid(vec3(-5.0, 0.0, -5.0), vec3(5.0, 0.0, -5.0));
    let litter = one(4, Layer::on(&floor()).density(8.0).near(wall_base.clone(), 1.0));
    assert!(!litter.is_empty() && litter.iter().all(|p| wall_base.distance(p.transform.translation) <= 1.0), "along the wall only");
    let close = litter.iter().filter(|p| wall_base.distance(p.transform.translation) < 0.5).count();
    assert!(close > litter.len() - close, "thicker close in: {close} of {}", litter.len());
    let mut dressing = Dressing::new(4);
    dressing
        .layer("desks", Layer::on(&floor()).density(0.2).spacing(1.5))
        .layer("papers", Layer::on(&floor()).density(10.0).near_layer("desks", 1.0))
        .layer("puddles", Layer::on(&floor()).density(2.0).avoid_layer("desks", 1.0));
    let dressed = dressing.run();
    let desks = positions(dressed.get("desks"));
    let nearest = |p: Vec3| desks.iter().map(|d| d.distance(p)).fold(f32::INFINITY, f32::min);
    assert!(!dressed.get("papers").is_empty() && dressed.get("papers").iter().all(|p| nearest(p.transform.translation) <= 1.0));
    assert!(dressed.get("puddles").iter().all(|p| nearest(p.transform.translation) > 1.0));
    assert!(dressed.get("unknown").is_empty(), "no layer of that name: nothing");
}

#[test]
fn clustering_gathers_placements_into_patches() {
    let even = one(6, Layer::on(&floor()).density(6.0));
    let patchy = one(6, Layer::on(&floor()).density(6.0).clustered(2.5, 0.4));
    assert!(patchy.len() < even.len() * 3 / 4 && !patchy.is_empty(), "about the coverage kept: {} of {}", patchy.len(), even.len());
    // Patches: of 1 m cells, the occupied ones hold more than an even sprinkle's.
    let cells = |placed: &[Placed]| {
        let mut cells = std::collections::BTreeMap::new();
        for p in placed {
            let t = p.transform.translation;
            *cells.entry((t.x.floor() as i32, t.z.floor() as i32)).or_insert(0u32) += 1;
        }
        cells
    };
    let empty_share = |placed: &[Placed]| 1.0 - cells(placed).len() as f32 / 100.0;
    assert!(empty_share(&patchy) > empty_share(&even) + 0.2, "whole cells left bare");
}

#[test]
fn placements_take_their_ranges_alignment_and_variants() {
    let slope = Surface::from_triangle_list([[vec3(0.0, 0.0, 0.0), vec3(4.0, 4.0, 0.0), vec3(0.0, 0.0, -4.0)], [vec3(4.0, 4.0, 0.0), vec3(4.0, 4.0, -4.0), vec3(0.0, 0.0, -4.0)]]);
    let aligned = one(8, Layer::on(&slope).density(4.0).align(1.0).scale(0.5, 1.5).yaw(-30.0, 30.0).tint(0.7, 0.9).variants(4).sink(-0.1, -0.05));
    let leaning = one(8, Layer::on(&slope).density(4.0));
    assert!(!aligned.is_empty());
    let mut variants = [0u32; 4];
    for p in &aligned {
        let up = p.transform.rotation * Vec3::Y;
        assert!(up.distance(p.normal) < EPS, "flat on the slope: {up} {}", p.normal);
        let s = p.transform.scale.x;
        assert!((0.5..=1.5).contains(&s) && p.transform.scale == Vec3::splat(s));
        assert!((-30.0f32.to_radians() - EPS..=30.0f32.to_radians() + EPS).contains(&p.yaw));
        assert!((0.7..=0.9).contains(&p.tint));
        variants[p.variant as usize] += 1;
    }
    assert!(variants.iter().all(|count| *count > 0), "every variant used: {variants:?}");
    for (sunk, upright) in aligned.iter().zip(&leaning) {
        let along = (sunk.transform.translation - upright.transform.translation).dot(sunk.normal);
        assert!((-0.1 - EPS..=-0.05 + EPS).contains(&along), "sunk along the normal: {along}");
        assert!((upright.transform.rotation * Vec3::Y).distance(Vec3::Y) < EPS, "upright by default");
    }
}

#[test]
fn a_spline_places_beside_itself_and_a_volume_inside_itself() {
    let street = Spline::new(&[vec3(0.0, 0.0, 0.0), vec3(20.0, 0.0, 5.0), vec3(40.0, 0.0, 0.0)]);
    assert!(street.length() > 40.0);
    let (start, direction) = street.at(0.0);
    assert!(start.distance(Vec3::ZERO) < EPS && direction.length() > 0.99);
    let posts = one(9, Layer::along(&street, 3.0, 4.0).density(0.5));
    assert!(!posts.is_empty());
    for p in &posts {
        let d = street.distance_to(p.transform.translation);
        assert!((3.0 - 0.05..=4.0 + 0.05).contains(&d), "in the band beside the street: {d}");
    }
    // Turned to follow it: local +x along the street where it stands, with yaw 0.
    let kerb = one(9, Layer::along(&street, 0.0, 0.0).density(1.0).yaw(0.0, 0.0));
    for p in &kerb {
        let along = p.transform.rotation * Vec3::X;
        let nearest = (0..400).map(|k| street.at(k as f32 * 0.11)).min_by(|a, b| a.0.distance(p.transform.translation).total_cmp(&b.0.distance(p.transform.translation))).expect("a point");
        assert!(along.dot(nearest.1) > 0.98, "follows the street: {along} {}", nearest.1);
    }
    let dust = one(9, Layer::inside(vec3(-1.0, 0.5, -1.0), vec3(1.0, 2.5, 1.0)).density(10.0));
    assert_eq!(dust.len(), 80, "10 a cubic metre in 8");
    assert!(dust.iter().all(|p| p.transform.translation.cmpge(vec3(-1.0, 0.5, -1.0)).all() && p.transform.translation.cmple(vec3(1.0, 2.5, 1.0)).all()));
}

#[test]
fn a_layer_becomes_groups_by_variant_and_tint_and_decals_on_its_surface() {
    let mut dressing = Dressing::new(10);
    dressing.layer("rocks", Layer::on(&floor()).density(3.0).variants(2).tint(0.6, 1.0));
    let dressed = dressing.run();
    let models = [Model::default(), Model::default()];
    let stone = Material::default();
    let groups = dressed.groups("rocks", &models, Some(&stone)).expect("groups");
    assert!(groups.len() <= 2 * DRESSING_TINT_BUCKETS && groups.len() > 2);
    assert_eq!(groups.iter().map(|g| g.len()).sum::<usize>(), dressed.get("rocks").len(), "every placement drawn once");
    let tints: std::collections::BTreeSet<u8> = groups.iter().map(|g| g.material().expect("tinted").base_color.r).collect();
    assert!(tints.len() > 1 && tints.iter().all(|r| (153..=255).contains(r)), "tinted within the range: {tints:?}");
    let plain = dressed.groups("rocks", &models, None).expect("groups");
    assert_eq!(plain.len(), 2, "one a variant with the GLB's materials");
    assert!(dressed.groups("rocks", &[], None).expect("none").is_empty());
    assert!(dressed.groups("none", &models, None).expect("none").is_empty());
    // Decals: posters face out of the wall, puddles lie on the floor.
    let mut decals = Dressing::new(10);
    decals.layer("posters", Layer::on(&room()).density(1.0).slope(85.0, 95.0).yaw(-5.0, 5.0)).layer("puddles", Layer::on(&floor()).density(0.2));
    let dressed = decals.run();
    for p in dressed.get("posters") {
        let decal = p.decal(0.6, 0.8);
        let out = decal.transform.rotation * Vec3::Y;
        assert!(out.distance(Vec3::Z) < 0.01, "projects onto the wall: {out}");
        assert!((decal.transform.scale.x - 0.6).abs() < EPS && (decal.transform.scale.z - 0.8).abs() < EPS);
    }
    for p in dressed.get("puddles") {
        let decal = p.decal(1.0, 1.5);
        assert!((decal.transform.rotation * Vec3::Y).distance(Vec3::Y) < EPS, "projects down onto the floor");
        assert!((decal.transform.scale.y - 0.5).abs() < EPS, "a ground decal's depth");
    }
}
