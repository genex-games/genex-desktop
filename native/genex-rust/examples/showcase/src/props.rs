//! The cabin's and the dock's parts as textured meshes (`game/assets/`): logs, posts, planks,
//! beams, the porch, the roof, the footing and the chimney, each sized as the draw hook places it
//! and mapped in metres against its texture's real size, so wood grain, slate and stone keep their
//! scale whatever the part's size (a scaled unit cube would stretch them).

use genex::math::{self, Vec3, vec2, vec3};

use crate::draw::{
    BEAM, BENCH, CABIN_DEPTH, CABIN_WIDTH, CHIMNEY, CHIMNEY_HEIGHT, DEER_BODY, DEER_HEAD, DOOR, FISHER_JACKET, FISHER_TROUSERS, FOOTING, HULL, LOG_FIREWOOD, LOG_LONG, LOG_RADIUS, LOG_SHORT, PLANKS, PORCH, POST, ROOF, STEP,
    roof_run_drop,
};
use crate::layout::DOCK_LENGTH;
use crate::meshgen::{Mesh, textured_box, tube};

/// The real sizes of the fetched textures (assets-manifest.json `worldSizeMetres`): the dock's and
/// the porch's planks, the cabin's logs, the roof's slate and the stone.
const PLANK_METRES: f32 = 2.0;
const LOG_METRES: f32 = 1.87;
const SLATE_METRES: f32 = 3.0;
const STONE_METRES: f32 = 1.52;
/// Sides around a log.
const LOG_SIDES: u32 = 14;

/// A log along +x from x 0 to `length`, of `radius`, its ends capped.
fn log(length: f32, radius: f32) -> Mesh {
    let mut mesh = Mesh::default();
    let wraps = (math::TAU * radius / LOG_METRES).round().max(1.0);
    tube(&mut mesh, &[(Vec3::ZERO, radius), (vec3(length, 0.0, 0.0), radius)], LOG_SIDES, wraps, LOG_METRES);
    for (x, facing) in [(0.0_f32, -1.0_f32), (length, 1.0)] {
        let n = vec3(facing, 0.0, 0.0);
        let center = mesh.vertex(vec3(x, 0.0, 0.0), n, vec2(0.5, 0.5));
        let ring: Vec<u32> = (0..LOG_SIDES)
            .map(|s| {
                let (sin, cos) = math::sin_cos(math::TAU * s as f32 / LOG_SIDES as f32);
                mesh.vertex(vec3(x, cos * radius, sin * radius), n, vec2(0.5 + cos * radius, 0.5 + sin * radius))
            })
            .collect();
        for s in 0..LOG_SIDES as usize {
            let (a, b) = (ring[s], ring[(s + 1) % LOG_SIDES as usize]);
            mesh.indices.extend(if facing > 0.0 { [center, a, b] } else { [center, b, a] });
        }
    }
    mesh
}

/// A post: a unit-radius-0.5 cylinder from y 0 to 1 (the draw scales it), its grain mapped for a
/// post about three metres tall.
fn post() -> Mesh {
    let mut mesh = Mesh::default();
    tube(&mut mesh, &[(Vec3::ZERO, 0.5), (Vec3::Y, 0.5)], 12, 1.0, LOG_METRES / 3.0);
    mesh
}

/// The height of the rowboat's bottom boards in the hull's frame: over the lake's surface however
/// the boat bobs (`draw.rs`'s `BOAT_WATERLINE`), so the water drawn under the boat never shows
/// inside it (pass-1 gate finding 03: the hull read as flooded).
pub const HULL_FLOOR: f32 = -0.1;

/// A rowboat's hull: a lofted shell 3.8 m long (along z) and 1.24 m wide, pointed at the bow and
/// square at the stern (a transom closes it), its gunwale at y 0.18, its keel at -0.3 and its
/// bottom boards at [`HULL_FLOOR`]; two-sided (the inside shows from the dock), the planks running
/// along it.
fn hull() -> Mesh {
    const STATIONS: u32 = 28;
    const AROUND: u32 = 14;
    let mut mesh = Mesh::default();
    let mut rows = Vec::new();
    for k in 0..=STATIONS {
        let t = k as f32 / STATIONS as f32 * 2.0 - 1.0;
        let z = t * 1.9;
        let pinch = if t > 0.0 { 1.0 - t * t } else { 1.0 - 0.75 * t * t };
        let half_width = 0.62 * math::pow(pinch.max(0.0), 0.55);
        let depth = 0.3;
        let sheer = 0.18 + 0.12 * t * t;
        let ring: Vec<(Vec3, Vec3, f32)> = (0..=AROUND)
            .map(|a| {
                let s = a as f32 / AROUND as f32 * 2.0 - 1.0;
                let bottom = math::pow(1.0 - s * s, 0.6);
                let p = vec3(half_width * s, sheer - (sheer + depth) * bottom, z);
                let n = vec3(s * 0.9, -bottom, 0.0).normalize_or(Vec3::NEG_Y);
                (p, n, a as f32 / AROUND as f32)
            })
            .collect();
        rows.push((ring, z));
    }
    let shells = rows.clone();
    for side in [1.0_f32, -1.0] {
        let base = mesh.positions.len() as u32;
        for (ring, z) in &rows {
            for (p, n, around) in ring {
                mesh.vertex(*p, *n * side, vec2(*z / PLANK_METRES, *around * 1.3 / PLANK_METRES * 2.0));
            }
        }
        let row = AROUND + 1;
        for k in 0..STATIONS {
            for a in 0..AROUND {
                let i = base + k * row + a;
                let quad = [i, i + row, i + 1, i + 1, i + row, i + row + 1];
                let outward = (mesh_point(&mesh, quad[1]) - mesh_point(&mesh, quad[0])).cross(mesh_point(&mesh, quad[2]) - mesh_point(&mesh, quad[0])).dot(Vec3::from(mesh.normals[quad[0] as usize])) > 0.0;
                mesh.indices.extend(if outward { quad } else { [quad[0], quad[2], quad[1], quad[3], quad[5], quad[4]] });
            }
        }
    }
    hull_floor(&mut mesh, &shells);
    hull_transom(&mut mesh, &shells[0].0);
    mesh
}

/// One ring of the hull's loft: each point around it with its normal and its share of the way
/// round.
type HullRing = Vec<(Vec3, Vec3, f32)>;

/// The bottom boards: a plate at [`HULL_FLOOR`] from shell to shell along the hull, facing up.
fn hull_floor(mesh: &mut Mesh, rows: &[(HullRing, f32)]) {
    let base = mesh.positions.len() as u32;
    for (ring, z) in rows {
        // Where the ring's port and starboard halves cross the floor's height (the ring runs from
        // port's gunwale down to the keel and up to starboard's).
        let reach = ring.windows(2).filter_map(|pair| crossing(pair[0].0, pair[1].0)).fold(0.0_f32, f32::max);
        for x in [-reach, reach] {
            mesh.vertex(vec3(x, HULL_FLOOR, *z), Vec3::Y, vec2(*z / PLANK_METRES, x / PLANK_METRES));
        }
    }
    for k in 0..rows.len() as u32 - 1 {
        // Port then starboard per station, stations along +z: this winding faces up.
        let i = base + k * 2;
        mesh.indices.extend([i, i + 3, i + 1, i, i + 2, i + 3]);
    }
}

/// Where the segment from `a` to `b` crosses [`HULL_FLOOR`], as a distance from the keel line.
fn crossing(a: Vec3, b: Vec3) -> Option<f32> {
    let (low, high) = (a.y.min(b.y), a.y.max(b.y));
    if HULL_FLOOR < low || HULL_FLOOR > high || high - low < 1e-6 {
        return None;
    }
    let f = (HULL_FLOOR - a.y) / (b.y - a.y);
    Some((a.x + (b.x - a.x) * f).abs())
}

/// The transom: the stern's ring closed by a flat board from its gunwale line down to the keel,
/// both faces (the outside shows from the lake, the inside from the dock).
fn hull_transom(mesh: &mut Mesh, stern: &[(Vec3, Vec3, f32)]) {
    let z = stern[0].0.z;
    let top = stern.iter().map(|(p, _, _)| p.y).fold(f32::MIN, f32::max);
    for normal in [Vec3::NEG_Z, Vec3::Z] {
        let center = mesh.vertex(vec3(0.0, top, z), normal, vec2(0.5, 0.0));
        let base = mesh.positions.len() as u32;
        for (p, _, _) in stern {
            mesh.vertex(*p, normal, vec2(p.x / PLANK_METRES, p.y / PLANK_METRES));
        }
        for a in 0..stern.len() as u32 - 1 {
            let (i, j) = (base + a, base + a + 1);
            let facing = (mesh_point(mesh, i) - mesh_point(mesh, center)).cross(mesh_point(mesh, j) - mesh_point(mesh, center)).dot(normal) > 0.0;
            mesh.indices.extend(if facing { [center, i, j] } else { [center, j, i] });
        }
    }
}

fn mesh_point(mesh: &Mesh, index: u32) -> Vec3 {
    Vec3::from(mesh.positions[index as usize])
}

/// A loft of elliptical sections: per station its centre and its half-width and half-height,
/// `around` vertices each, smooth normals, closed at both ends by the sections shrinking to zero.
fn loft(mesh: &mut Mesh, stations: &[(Vec3, f32, f32)], around: u32) {
    let base = mesh.positions.len() as u32;
    for (k, (center, rx, ry)) in stations.iter().enumerate() {
        let before = stations[k.saturating_sub(1)].0;
        let after = stations[(k + 1).min(stations.len() - 1)].0;
        let along = (after - before).normalize_or(Vec3::Z);
        let side = Vec3::Y.cross(along).normalize_or(Vec3::X);
        let up = along.cross(side).normalize_or(Vec3::Y);
        for a in 0..=around {
            let (sin, cos) = math::sin_cos(math::TAU * a as f32 / around as f32);
            let p = *center + side * cos * *rx + up * sin * *ry;
            let n = (side * cos / rx.max(1e-3) + up * sin / ry.max(1e-3)).normalize_or(up);
            mesh.vertex(p, n, vec2(a as f32 / around as f32, k as f32 / stations.len() as f32));
        }
    }
    let row = around + 1;
    for k in 0..stations.len() as u32 - 1 {
        for a in 0..around {
            let i = base + k * row + a;
            let quad = [i, i + 1, i + row, i + 1, i + row + 1, i + row];
            let outward = (mesh_point(mesh, quad[1]) - mesh_point(mesh, quad[0])).cross(mesh_point(mesh, quad[2]) - mesh_point(mesh, quad[0])).dot(Vec3::from(mesh.normals[i as usize])) > 0.0;
            mesh.indices.extend(if outward { quad } else { [quad[0], quad[2], quad[1], quad[3], quad[5], quad[4]] });
        }
    }
}

/// A deer's body (unit size, facing +z, standing on y 0): the torso with its deep chest and
/// rounded rump, the four slender legs with their knees and hocks, and the short tail.
fn deer_body() -> Mesh {
    let mut mesh = Mesh::default();
    let torso: Vec<(Vec3, f32, f32)> = [
        (-0.78, 1.12, 0.0, 0.0),
        (-0.72, 1.12, 0.14, 0.15),
        (-0.55, 1.1, 0.25, 0.29),
        (-0.3, 1.06, 0.27, 0.31),
        (0.0, 1.03, 0.25, 0.31),
        (0.3, 1.06, 0.26, 0.34),
        (0.52, 1.12, 0.24, 0.32),
        (0.68, 1.2, 0.17, 0.22),
        (0.74, 1.24, 0.0, 0.0),
    ]
    .iter()
    .map(|&(z, y, rx, ry)| (vec3(0.0, y, z), rx, ry))
    .collect();
    loft(&mut mesh, &torso, 16);
    for (x, z, front) in [(-0.14, 0.46, true), (0.14, 0.46, true), (-0.14, -0.5, false), (0.14, -0.5, false)] {
        let bend = if front { 0.04 } else { -0.1 };
        let leg = [(vec3(x, 1.0, z), 0.085), (vec3(x * 1.05, 0.62, z + bend), 0.05), (vec3(x * 1.05, 0.42, z + bend * 0.4), 0.035), (vec3(x * 1.05, 0.06, z), 0.03), (vec3(x * 1.05, 0.0, z + 0.02), 0.032)];
        tube(&mut mesh, &leg, 8, 1.0, 1.0);
    }
    loft(&mut mesh, &[(vec3(0.0, 1.16, -0.74), 0.0, 0.0), (vec3(0.0, 1.14, -0.8), 0.05, 0.07), (vec3(0.0, 1.06, -0.86), 0.04, 0.06), (vec3(0.0, 0.99, -0.88), 0.0, 0.0)], 8);
    mesh
}

/// A deer's neck and head (unit size), its neck leaving the origin (the base of the neck on the
/// shoulders) along +z, so the draw hook swings it about x between grazing and looking up: the
/// tapering neck, the long head with its muzzle and the two ears.
fn deer_head() -> Mesh {
    let mut mesh = Mesh::default();
    let neck: Vec<(Vec3, f32, f32)> =
        [(-0.05, 0.0, 0.0, 0.0), (0.0, 0.0, 0.14, 0.17), (0.25, 0.02, 0.11, 0.13), (0.55, 0.04, 0.085, 0.1), (0.78, 0.06, 0.08, 0.09)]
            .iter()
            .map(|&(z, y, rx, ry)| (vec3(0.0, y, z), rx, ry))
            .collect();
    loft(&mut mesh, &neck, 12);
    let head: Vec<(Vec3, f32, f32)> =
        [(0.72, 0.1, 0.0, 0.0), (0.76, 0.1, 0.085, 0.09), (0.86, 0.06, 0.08, 0.085), (0.98, 0.0, 0.055, 0.065), (1.08, -0.04, 0.04, 0.045), (1.12, -0.05, 0.0, 0.0)]
            .iter()
            .map(|&(z, y, rx, ry)| (vec3(0.0, y, z), rx, ry))
            .collect();
    loft(&mut mesh, &head, 12);
    for x in [-1.0_f32, 1.0] {
        let ear = [(vec3(0.05 * x, 0.17, 0.8), 0.035), (vec3(0.12 * x, 0.27, 0.77), 0.03), (vec3(0.16 * x, 0.33, 0.76), 0.004)];
        tube(&mut mesh, &ear, 6, 1.0, 1.0);
    }
    mesh
}

/// The fisher's jacket (in his frame: sitting on the dock's end, facing +z out over the lake): the
/// torso leaning a little forward and the two arms reaching to the rod in his lap.
fn fisher_jacket() -> Mesh {
    let mut mesh = Mesh::default();
    let torso: Vec<(Vec3, f32, f32)> =
        [(0.04, 0.0, 0.0), (0.08, 0.19, 0.15), (0.25, 0.23, 0.17), (0.45, 0.22, 0.16), (0.62, 0.2, 0.14), (0.72, 0.13, 0.1), (0.79, 0.0, 0.0)]
            .iter()
            .map(|&(y, rx, rz)| (vec3(0.0, y, -0.05 + y * 0.08), rx, rz))
            .collect();
    loft(&mut mesh, &torso, 14);
    for x in [-1.0_f32, 1.0] {
        let arm = [(vec3(0.19 * x, 0.64, 0.0), 0.06), (vec3(0.22 * x, 0.46, 0.14), 0.052), (vec3(0.07 * x, 0.55, 0.36), 0.045)];
        tube(&mut mesh, &arm, 8, 1.0, 1.0);
    }
    mesh
}

/// The fisher's trousers: thighs along the deck and shins hanging over its edge.
fn fisher_trousers() -> Mesh {
    let mut mesh = Mesh::default();
    for x in [-0.11_f32, 0.11] {
        let leg = [(vec3(x, 0.14, -0.02), 0.085), (vec3(x, 0.1, 0.45), 0.072), (vec3(x, -0.38, 0.52), 0.06), (vec3(x, -0.42, 0.6), 0.055)];
        tube(&mut mesh, &leg, 10, 1.0, 1.0);
    }
    mesh
}

/// Every part as (file name, mesh).
pub fn assets() -> Vec<(String, Mesh)> {
    let box_at = |size: Vec3, tile: f32, offset: f32| textured_box(Vec3::ZERO, size, tile, vec2(0.0, offset));
    let mut out = vec![
        (LOG_LONG.to_owned(), log(CABIN_WIDTH + 0.7, LOG_RADIUS)),
        (LOG_SHORT.to_owned(), log(CABIN_DEPTH + 0.7, LOG_RADIUS)),
        (LOG_FIREWOOD.to_owned(), log(1.8, 0.13)),
        (POST.to_owned(), post()),
        (BEAM.to_owned(), box_at(vec3(DOCK_LENGTH, 0.16, 0.14), PLANK_METRES, 0.4)),
        (PORCH.to_owned(), box_at(vec3(CABIN_WIDTH + 0.8, 0.16, 2.0), PLANK_METRES, 0.0)),
        (STEP.to_owned(), box_at(vec3(1.8, 0.16, 0.5), PLANK_METRES, 0.2)),
        (BENCH.to_owned(), box_at(vec3(1.6, 0.08, 0.42), PLANK_METRES, 0.55)),
        (DOOR.to_owned(), box_at(vec3(1.05, 2.0, 0.08), PLANK_METRES, 0.1)),
        (ROOF.to_owned(), box_at(vec3(CABIN_WIDTH + 1.3, 0.16, math::hypot(roof_run_drop().0, roof_run_drop().1) + 0.1), SLATE_METRES, 0.0)),
        (FOOTING.to_owned(), box_at(vec3(CABIN_WIDTH + 0.5, 0.7, CABIN_DEPTH + 0.5), STONE_METRES, 0.0)),
        (CHIMNEY.to_owned(), box_at(vec3(0.95, CHIMNEY_HEIGHT, 0.95), STONE_METRES, 0.3)),
        (HULL.to_owned(), hull()),
        (DEER_BODY.to_owned(), deer_body()),
        (DEER_HEAD.to_owned(), deer_head()),
        (FISHER_JACKET.to_owned(), fisher_jacket()),
        (FISHER_TROUSERS.to_owned(), fisher_trousers()),
    ];
    out.extend(PLANKS.iter().enumerate().map(|(k, name)| ((*name).to_owned(), box_at(vec3(2.0, 0.07, 0.29), PLANK_METRES, 0.13 + 0.31 * k as f32))));
    out
}
