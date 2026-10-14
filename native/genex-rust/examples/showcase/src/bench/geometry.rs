//! Procedural meshes for the bench scenes, built straight into the renderer's `MeshData` (uvs and
//! tangents included). Trigonometry is libm's (`genex::math`), so every target builds the same bits.

use genex::math::{self, Mat4, Vec2, Vec3, vec2, vec3};
use genex_render::mesh::{MeshData, Vertex};

use crate::layout::hash2;
use crate::meshgen;

/// A unit vector orthogonal to `n`.
fn any_tangent(n: Vec3) -> Vec3 {
    let helper = if n.x.abs() < 0.9 { Vec3::X } else { Vec3::Y };
    (helper - n * n.dot(helper)).normalize_or(Vec3::X)
}

/// A vertex at `p` facing `n`, its tangent any direction across `n`.
fn vertex(p: Vec3, n: Vec3, uv: Vec2) -> Vertex {
    Vertex { position: p.to_array(), normal: n.to_array(), uv: uv.to_array(), tangent: any_tangent(n).extend(1.0).to_array() }
}

/// The showcase generator's mesh (flat or smooth normals), its uvs projected from above.
pub fn from_mesh(mesh: &meshgen::Mesh) -> MeshData {
    let vertices = mesh
        .positions
        .iter()
        .zip(&mesh.normals)
        .map(|(p, n)| vertex(Vec3::from(*p), Vec3::from(*n), vec2(p[0], p[2])))
        .collect();
    MeshData { vertices, indices: mesh.indices.clone() }
}

/// `mesh` moved by `matrix` (normals by its inverse transpose).
pub fn transformed(mesh: &MeshData, matrix: Mat4) -> MeshData {
    let normal = matrix.inverse().transpose();
    let vertices = mesh
        .vertices
        .iter()
        .map(|v| {
            let n = normal.transform_vector3(Vec3::from(v.normal)).normalize_or(Vec3::Y);
            let t = matrix.transform_vector3(Vec3::from_slice(&v.tangent[..3])).normalize_or(any_tangent(n));
            Vertex { position: matrix.transform_point3(Vec3::from(v.position)).to_array(), normal: n.to_array(), uv: v.uv, tangent: t.extend(v.tangent[3]).to_array() }
        })
        .collect();
    MeshData { vertices, indices: mesh.indices.clone() }
}

/// Every mesh of `parts` in one.
pub fn merged(parts: &[MeshData]) -> MeshData {
    let mut out = MeshData::default();
    for part in parts {
        let base = out.vertices.len() as u32;
        out.vertices.extend_from_slice(&part.vertices);
        out.indices.extend(part.indices.iter().map(|i| base + i));
    }
    out
}

/// A smooth UV sphere of radius 1 (`rings` × `segments` quads), facing out.
pub fn uv_sphere(rings: u32, segments: u32) -> MeshData {
    let mut mesh = MeshData::default();
    for ring in 0..=rings {
        let theta = math::PI * ring as f32 / rings as f32;
        let (sin_theta, cos_theta) = math::sin_cos(theta);
        for segment in 0..=segments {
            let phi = math::TAU * segment as f32 / segments as f32;
            let (sin_phi, cos_phi) = math::sin_cos(phi);
            let n = vec3(sin_theta * cos_phi, cos_theta, -sin_theta * sin_phi).normalize();
            let along = vec3(-sin_phi, 0.0, -cos_phi);
            let tangent = (along - n * n.dot(along)).try_normalize().unwrap_or_else(|| any_tangent(n));
            let uv = [segment as f32 / segments as f32, ring as f32 / rings as f32];
            mesh.vertices.push(Vertex { position: n.to_array(), normal: n.to_array(), uv, tangent: tangent.extend(1.0).to_array() });
        }
    }
    let row = segments + 1;
    for ring in 0..rings {
        for segment in 0..segments {
            let a = ring * row + segment;
            let b = a + row;
            mesh.indices.extend([a, b, a + 1, a + 1, b, b + 1]);
        }
    }
    mesh
}

/// The band of a radius-1 dome between polar angles `from` and `to` (radians from straight up),
/// facing in (seen from its centre), every normal straight up so the whole band shades as one
/// colour: the sky placeholder until the renderer draws a sky.
pub fn dome_band(from: f32, to: f32, segments: u32) -> MeshData {
    let rings = 6;
    let mut mesh = MeshData::default();
    for ring in 0..=rings {
        let theta = from + (to - from) * ring as f32 / rings as f32;
        let (sin_theta, cos_theta) = math::sin_cos(theta);
        for segment in 0..=segments {
            let (sin_phi, cos_phi) = math::sin_cos(math::TAU * segment as f32 / segments as f32);
            let p = vec3(sin_theta * cos_phi, cos_theta, -sin_theta * sin_phi);
            mesh.vertices.push(vertex(p, Vec3::Y, vec2(segment as f32 / segments as f32, ring as f32 / rings as f32)));
        }
    }
    let row = segments + 1;
    for ring in 0..rings {
        for segment in 0..segments {
            let a = ring * row + segment;
            let b = a + row;
            mesh.indices.extend([a, a + 1, b, a + 1, b + 1, b]);
        }
    }
    mesh
}

/// A square grid `2 × half` wide of `cells` × `cells` quads at heights `height(x, z)`, facing up,
/// with smooth normals from central differences.
pub fn heightfield(cells: u32, half: f32, height: impl Fn(f32, f32) -> f32) -> MeshData {
    let step = 2.0 * half / cells as f32;
    let mut mesh = MeshData::default();
    for iz in 0..=cells {
        for ix in 0..=cells {
            let (x, z) = (-half + ix as f32 * step, -half + iz as f32 * step);
            let e = step * 0.5;
            let n = vec3(height(x - e, z) - height(x + e, z), 2.0 * e, height(x, z - e) - height(x, z + e)).normalize_or(Vec3::Y);
            mesh.vertices.push(vertex(vec3(x, height(x, z), z), n, vec2(x, z) * 0.25));
        }
    }
    let row = cells + 1;
    for iz in 0..cells {
        for ix in 0..cells {
            let a = iz * row + ix;
            let (b, c, d) = (a + row, a + 1, a + row + 1);
            mesh.indices.extend([a, b, c, c, b, d]);
        }
    }
    mesh
}

/// Boxes merged into one mesh: each (centre, size) a scaled unit cube.
pub fn boxes(parts: &[(Vec3, Vec3)]) -> MeshData {
    let cube = MeshData::cube();
    let placed: Vec<MeshData> = parts.iter().map(|(center, size)| transformed(&cube, Mat4::from_scale_rotation_translation(*size, math::Quat::IDENTITY, *center))).collect();
    merged(&placed)
}

/// An open cylinder of `radius` along `from` → `to` (`rings` + 1 rings of `segments`), facing out.
pub fn tube(from: Vec3, to: Vec3, radius: [f32; 2], rings: u32, segments: u32) -> MeshData {
    let axis = (to - from).normalize_or(Vec3::Y);
    let side = any_tangent(axis);
    let other = axis.cross(side);
    let mut mesh = MeshData::default();
    for ring in 0..=rings {
        let t = ring as f32 / rings as f32;
        let center = from.lerp(to, t);
        let r = math::lerp(radius[0], radius[1], t);
        for segment in 0..=segments {
            let (s, c) = math::sin_cos(math::TAU * segment as f32 / segments as f32);
            let n = side * c + other * s;
            mesh.vertices.push(vertex(center + n * r, n, vec2(segment as f32 / segments as f32, t)));
        }
    }
    let row = segments + 1;
    for ring in 0..rings {
        for segment in 0..segments {
            let a = ring * row + segment;
            let b = a + row;
            mesh.indices.extend([a, a + 1, b, a + 1, b + 1, b]);
        }
    }
    mesh
}

/// A tuft of grass: `blades` thin two-sided blades about 0.5 m tall, origin at its foot.
pub fn grass_tuft(variant: u32, blades: u32) -> MeshData {
    let mut mesh = MeshData::default();
    for k in 0..blades {
        let jitter = |salt: u32| hash2(k as i32, variant as i32, salt);
        let angle = math::TAU * jitter(1);
        let (s, c) = math::sin_cos(angle);
        let foot = vec3(c, 0.0, s) * 0.18 * jitter(2);
        let across = vec3(-s, 0.0, c) * 0.035;
        let lean = vec3(c, 0.0, s) * (0.08 + 0.12 * jitter(3));
        let tip = foot + lean + Vec3::Y * (0.35 + 0.3 * jitter(4));
        let face = across.cross(tip - foot).normalize_or(Vec3::Y);
        for n in [face, -face] {
            let base = mesh.vertices.len() as u32;
            mesh.vertices.push(vertex(foot - across, n, vec2(0.0, 1.0)));
            mesh.vertices.push(vertex(foot + across, n, vec2(1.0, 1.0)));
            mesh.vertices.push(vertex(tip, n, vec2(0.5, 0.0)));
            let wound = (Vec3::from(mesh.vertices[base as usize + 1].position) - Vec3::from(mesh.vertices[base as usize].position))
                .cross(tip - Vec3::from(mesh.vertices[base as usize].position))
                .dot(n);
            mesh.indices.extend(if wound >= 0.0 { [base, base + 1, base + 2] } else { [base, base + 2, base + 1] });
        }
    }
    mesh
}

/// A broadleaf tree: a trunk and a lumpy low-poly crown, about 6 m tall, origin at its foot.
pub fn broadleaf(variant: u32) -> MeshData {
    let trunk = tube(Vec3::ZERO, vec3(0.0, 3.2, 0.0), [0.22, 0.14], 1, 8);
    let crown = meshgen::icosphere(1, |d| {
        let bump = 0.8 + 0.35 * hash2((d.x * 7.0) as i32, (d.z * 7.0 + d.y * 3.0) as i32, 40 + variant);
        vec3(d.x, d.y * 0.8, d.z) * (1.9 + 0.3 * variant as f32) * bump + vec3(0.0, 4.2, 0.0)
    });
    merged(&[trunk, from_mesh(&crown)])
}

/// A city block's building: a podium and one or two set-back towers, origin at its foot, about
/// 4 m across, `floors` × 3 m tall.
pub fn building(variant: u32, floors: u32) -> MeshData {
    let height = 3.0 * floors as f32;
    let w = 1.6 + 0.4 * hash2(variant as i32, 1, 90);
    let d = 1.6 + 0.4 * hash2(variant as i32, 2, 90);
    let mut parts = vec![(vec3(0.0, 1.5, 0.0), vec3(w * 2.0, 3.0, d * 2.0))];
    let tower = height - 3.0;
    if tower > 0.0 {
        parts.push((vec3(0.0, 3.0 + tower * 0.5, 0.0), vec3(w * 1.5, tower, d * 1.4)));
    }
    if variant.is_multiple_of(3) && tower > 6.0 {
        parts.push((vec3(w * 0.3, height + 1.5, -d * 0.2), vec3(w * 0.7, 3.0, d * 0.7)));
    }
    boxes(&parts)
}
