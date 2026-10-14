//! The procedural meshes behind `game/assets/`: the terrain, the trees ([`crate::trees`]), the
//! rocks, the cabin's and the dock's parts ([`crate::props`]), a cylinder and a smooth sphere, each
//! written as a GLB (positions, normals, texture coordinates, indices in one embedded buffer), and
//! the terrain's splat map ([`splat_png`]). Deterministic: the same bytes on every run. The faceted
//! pines, canopies and rocks of the lakeside before its remaster stay for the bench scenes.

use genex::json;
use image::ImageEncoder;
use genex::math::{self, Vec2, Vec3, vec2, vec3};

use crate::layout::{CABIN, TERRAIN_HALF, WATER_LEVEL, fbm, height, lake_radius, normal, path_distance, path_half_width, smoothstep, value_noise, yard_radius};

/// Terrain grid cells per side.
pub const TERRAIN_CELLS: u32 = 256;
/// The terrain's texture coordinates: one unit per this many metres (the terrain material reads the
/// world position itself; the coordinates serve the tangents).
const TERRAIN_UV_METRES: f32 = 4.0;
/// The splat map's texels per side over the whole terrain (`terrain-splat.png`).
pub const SPLAT_TEXELS: u32 = 512;

/// An indexed triangle mesh, counter-clockwise seen from outside.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Mesh {
    /// Positions.
    pub positions: Vec<[f32; 3]>,
    /// Unit normals.
    pub normals: Vec<[f32; 3]>,
    /// Texture coordinates (zero where a generator maps none).
    pub uvs: Vec<[f32; 2]>,
    /// Three indices per triangle.
    pub indices: Vec<u32>,
}

impl Mesh {
    /// Append one flat-shaded triangle (its own three vertices, the face normal).
    pub fn flat(&mut self, a: Vec3, b: Vec3, c: Vec3) {
        let n = (b - a).cross(c - a).normalize_or(Vec3::Y);
        let base = self.positions.len() as u32;
        for p in [a, b, c] {
            self.positions.push(p.to_array());
            self.normals.push(n.to_array());
            self.uvs.push([0.0, 0.0]);
        }
        self.indices.extend([base, base + 1, base + 2]);
    }

    /// Append one vertex: its position, normal and texture coordinate; answers its index.
    pub fn vertex(&mut self, p: Vec3, n: Vec3, uv: Vec2) -> u32 {
        self.positions.push(p.to_array());
        self.normals.push(n.to_array());
        self.uvs.push(uv.to_array());
        self.positions.len() as u32 - 1
    }

    /// Append another mesh.
    pub fn append(&mut self, other: &Mesh) {
        let base = self.positions.len() as u32;
        self.positions.extend(&other.positions);
        self.normals.extend(&other.normals);
        self.uvs.extend(&other.uvs);
        self.indices.extend(other.indices.iter().map(|i| base + i));
    }
}

/// The mesh as a GLB file.
pub fn glb(mesh: &Mesh) -> Vec<u8> {
    let mut bin: Vec<u8> = Vec::new();
    for p in &mesh.positions {
        p.iter().for_each(|v| bin.extend(v.to_le_bytes()));
    }
    let normals_at = bin.len();
    for n in &mesh.normals {
        n.iter().for_each(|v| bin.extend(v.to_le_bytes()));
    }
    let uvs_at = bin.len();
    assert_eq!(mesh.uvs.len(), mesh.positions.len(), "every vertex has a texture coordinate");
    for uv in &mesh.uvs {
        uv.iter().for_each(|v| bin.extend(v.to_le_bytes()));
    }
    let indices_at = bin.len();
    mesh.indices.iter().for_each(|i| bin.extend(i.to_le_bytes()));
    let indices_end = bin.len();
    let (mut min, mut max) = ([f32::MAX; 3], [f32::MIN; 3]);
    for p in &mesh.positions {
        for k in 0..3 {
            min[k] = min[k].min(p[k]);
            max[k] = max[k].max(p[k]);
        }
    }
    let count = mesh.positions.len();
    let gltf = json!({
        "asset": { "version": "2.0", "generator": "genex showcase meshgen" },
        "scene": 0,
        "scenes": [{ "nodes": [0] }],
        "nodes": [{ "mesh": 0 }],
        "meshes": [{ "primitives": [{ "attributes": { "POSITION": 0, "NORMAL": 1, "TEXCOORD_0": 3 }, "indices": 2 }] }],
        "buffers": [{ "byteLength": indices_end }],
        "bufferViews": [
            { "buffer": 0, "byteOffset": 0, "byteLength": normals_at, "target": 34962 },
            { "buffer": 0, "byteOffset": normals_at, "byteLength": uvs_at - normals_at, "target": 34962 },
            { "buffer": 0, "byteOffset": indices_at, "byteLength": indices_end - indices_at, "target": 34963 },
            { "buffer": 0, "byteOffset": uvs_at, "byteLength": indices_at - uvs_at, "target": 34962 },
        ],
        "accessors": [
            { "bufferView": 0, "componentType": 5126, "count": count, "type": "VEC3", "min": min, "max": max },
            { "bufferView": 1, "componentType": 5126, "count": count, "type": "VEC3" },
            { "bufferView": 2, "componentType": 5125, "count": mesh.indices.len(), "type": "SCALAR" },
            { "bufferView": 3, "componentType": 5126, "count": count, "type": "VEC2" },
        ],
    });
    let mut json_chunk = gltf.to_string().into_bytes();
    while !json_chunk.len().is_multiple_of(4) {
        json_chunk.push(b' ');
    }
    while !bin.len().is_multiple_of(4) {
        bin.push(0);
    }
    let total = 12 + 8 + json_chunk.len() + 8 + bin.len();
    let mut out = Vec::with_capacity(total);
    out.extend(b"glTF");
    out.extend(2u32.to_le_bytes());
    out.extend((total as u32).to_le_bytes());
    out.extend((json_chunk.len() as u32).to_le_bytes());
    out.extend(b"JSON");
    out.extend(json_chunk);
    out.extend((bin.len() as u32).to_le_bytes());
    out.extend(b"BIN\0");
    out.extend(bin);
    out
}

/// The whole terrain as one grid with smooth normals from the height field, drawn with the
/// terrain material (its layers blended per pixel from the splat map, `shaders/terrain.wgsl`).
pub fn terrain() -> Mesh {
    let n = TERRAIN_CELLS;
    let step = TERRAIN_HALF * 2.0 / n as f32;
    let mut mesh = Mesh::default();
    for j in 0..=n {
        for i in 0..=n {
            let p = vec2(-TERRAIN_HALF + i as f32 * step, -TERRAIN_HALF + j as f32 * step);
            mesh.vertex(vec3(p.x, height(p.x, p.y), p.y), normal(p.x, p.y), p / TERRAIN_UV_METRES);
        }
    }
    let row = n + 1;
    for j in 0..n {
        for i in 0..n {
            let a = j * row + i;
            mesh.indices.extend([a, a + row, a + 1, a + 1, a + row, a + row + 1]);
        }
    }
    mesh
}

/// How much of each terrain layer covers (x, z): soil (the path and the yard), sand (the beach and
/// the lake bed), rock (steep slopes) and the meadow's dryness (0 lush to 1 golden); grass is what
/// the other layers leave. Each 0..1, soft-edged, from the layout's own functions.
pub fn splat_weights(x: f32, z: f32) -> [f32; 4] {
    let p = vec2(x, z);
    let edge = 0.25 * (value_noise(p * 1.7, 21) - 0.5);
    let path = 1.0 - smoothstep(-0.25, 0.3, path_distance(x, z) - path_half_width(x, z) + edge);
    let d = p - CABIN;
    let yard = 1.0 - smoothstep(-0.6, 0.4, d.length() - yard_radius(math::atan2(d.y, d.x)) + edge * 2.0);
    let soil = path.max(yard);
    let h = height(x, z);
    let shore = (1.0 - smoothstep(0.02, 0.22, h - WATER_LEVEL + edge * 0.4)) * (1.0 - smoothstep(1.15, 1.3, lake_radius(x, z)));
    let grassy_bank = smoothstep(0.62, 0.74, value_noise(p * 0.12, 9)) * smoothstep(-0.25, 0.0, h - WATER_LEVEL);
    let sand = (shore * (1.0 - grassy_bank)).max(1.0 - smoothstep(-0.35, -0.1, h - WATER_LEVEL));
    let steep = smoothstep(0.93, 0.84, normal(x, z).y) * smoothstep(2.0, 3.5, h);
    let patch = fbm(p * 0.045, 3, 7) + 0.18 * (value_noise(p * 0.35, 8) - 0.5);
    let dry = smoothstep(0.38, 0.66, patch);
    [soil, sand * (1.0 - soil), steep * (1.0 - soil), dry]
}

/// The splat map as an RGBA PNG over the whole terrain ([`SPLAT_TEXELS`] per side, texel centres
/// from -TERRAIN_HALF): soil, sand and rock in R, G and B, stored sRGB-encoded so the terrain
/// material's sRGB texture decodes the weight itself, and dryness in A (never decoded).
pub fn splat_png() -> Vec<u8> {
    let side = SPLAT_TEXELS;
    let mut rgba = Vec::with_capacity((side * side * 4) as usize);
    for j in 0..side {
        for i in 0..side {
            let at = |k: u32| -TERRAIN_HALF + (k as f32 + 0.5) / side as f32 * TERRAIN_HALF * 2.0;
            let [soil, sand, rock, dry] = splat_weights(at(i), at(j));
            rgba.extend([soil, sand, rock].map(crate::fetched::srgb_byte));
            rgba.push((dry.clamp(0.0, 1.0) * 255.0).round() as u8);
        }
    }
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new_with_quality(&mut png, image::codecs::png::CompressionType::Best, image::codecs::png::FilterType::Adaptive)
        .write_image(&rgba, side, side, image::ExtendedColorType::Rgba8)
        .expect("the splat map encodes");
    png
}

/// A deterministic 0..1 noise over a direction (for displacing spheres).
fn direction_noise(d: Vec3, salt: u32) -> f32 {
    let a = fbm(vec2(d.x * 1.7 + d.y * 0.9, d.z * 1.7 - d.y * 0.6) + vec2(3.0, 5.0), 3, salt);
    let b = fbm(vec2(d.y * 1.9 + d.z * 0.5, d.x * 1.3) + vec2(11.0, 2.0), 3, salt + 7);
    (a + b) * 0.5
}

/// An icosphere of `subdivisions`, each vertex pushed out by `displace(direction)`, faceted.
pub fn icosphere(subdivisions: u32, displace: impl Fn(Vec3) -> Vec3) -> Mesh {
    let t = (1.0 + 5.0_f32.sqrt()) / 2.0;
    let mut vertices: Vec<Vec3> = [
        (-1.0, t, 0.0),
        (1.0, t, 0.0),
        (-1.0, -t, 0.0),
        (1.0, -t, 0.0),
        (0.0, -1.0, t),
        (0.0, 1.0, t),
        (0.0, -1.0, -t),
        (0.0, 1.0, -t),
        (t, 0.0, -1.0),
        (t, 0.0, 1.0),
        (-t, 0.0, -1.0),
        (-t, 0.0, 1.0),
    ]
    .iter()
    .map(|&(x, y, z)| vec3(x, y, z).normalize())
    .collect();
    let mut faces: Vec<[usize; 3]> = vec![
        [0, 11, 5],
        [0, 5, 1],
        [0, 1, 7],
        [0, 7, 10],
        [0, 10, 11],
        [1, 5, 9],
        [5, 11, 4],
        [11, 10, 2],
        [10, 7, 6],
        [7, 1, 8],
        [3, 9, 4],
        [3, 4, 2],
        [3, 2, 6],
        [3, 6, 8],
        [3, 8, 9],
        [4, 9, 5],
        [2, 4, 11],
        [6, 2, 10],
        [8, 6, 7],
        [9, 8, 1],
    ];
    for _ in 0..subdivisions {
        let mut midpoints: Vec<((usize, usize), usize)> = Vec::new();
        let mut midpoint = |vertices: &mut Vec<Vec3>, a: usize, b: usize| {
            let key = (a.min(b), a.max(b));
            if let Some((_, k)) = midpoints.iter().find(|(known, _)| *known == key) {
                return *k;
            }
            vertices.push(((vertices[a] + vertices[b]) * 0.5).normalize());
            midpoints.push((key, vertices.len() - 1));
            vertices.len() - 1
        };
        let mut next = Vec::with_capacity(faces.len() * 4);
        for [a, b, c] in faces {
            let ab = midpoint(&mut vertices, a, b);
            let bc = midpoint(&mut vertices, b, c);
            let ca = midpoint(&mut vertices, c, a);
            next.extend([[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]]);
        }
        faces = next;
    }
    let moved: Vec<Vec3> = vertices.iter().map(|&d| displace(d)).collect();
    let mut mesh = Mesh::default();
    for [a, b, c] in faces {
        mesh.flat(moved[a], moved[b], moved[c]);
    }
    mesh
}

/// A broadleaf canopy: three overlapping lumpy blobs, about 2.4 m across, centred on the origin.
pub fn canopy(variant: u32) -> Mesh {
    let salt = 100 + variant * 13;
    let blobs = [(vec3(0.0, 0.0, 0.0), 2.1), (vec3(0.9, -0.4, 0.6), 1.5), (vec3(-0.8, 0.3, -0.5), 1.6)];
    let mut mesh = Mesh::default();
    for (k, (center, radius)) in blobs.iter().enumerate() {
        let offset = *center * (0.8 + 0.25 * variant as f32);
        let blob = icosphere(2, |d| {
            let bump = 0.78 + 0.45 * direction_noise(d * 1.5, salt + k as u32);
            offset + vec3(d.x, d.y * 0.82, d.z) * radius * bump
        });
        mesh.append(&blob);
    }
    mesh
}

/// A rock: a faceted, lumpy unit sphere.
pub fn rock(variant: u32) -> Mesh {
    let salt = 300 + variant * 17;
    icosphere(1, |d| d * (0.7 + 0.55 * direction_noise(d * 2.2, salt)))
}

/// A pine: four stacked, faceted cones from 1.2 m up to about 7.2 m, origin at the trunk's foot.
pub fn pine(variant: u32) -> Mesh {
    let layers = [(1.2, 2.1, 2.7), (2.6, 1.65, 2.3), (3.95, 1.2, 2.0), (5.15, 0.72, 2.05)];
    let segments = 9;
    let mut mesh = Mesh::default();
    for (k, (base, radius, rise)) in layers.iter().enumerate() {
        let jitter = |s: u32| 0.85 + 0.3 * crate::layout::hash2(s as i32, k as i32, 500 + variant);
        let twist = k as f32 * 0.37 + variant as f32;
        let apex = vec3(0.0, base + rise, 0.0);
        let ring: Vec<Vec3> = (0..segments)
            .map(|s| {
                let a = twist + math::TAU * s as f32 / segments as f32;
                let r = radius * jitter(s);
                vec3(math::cos(a) * r, *base - 0.15 * jitter(s + 20), math::sin(a) * r)
            })
            .collect();
        let center = vec3(0.0, *base, 0.0);
        for s in 0..segments as usize {
            let (a, b) = (ring[s], ring[(s + 1) % segments as usize]);
            mesh.flat(a, apex, b);
            mesh.flat(a, b, center);
        }
    }
    mesh
}

/// A cylinder of radius 0.5 from y 0 to y 1, smooth sides and flat caps; its texture wraps once
/// around and runs once along it (the caps are mapped from above).
pub fn cylinder() -> Mesh {
    let mut mesh = Mesh::default();
    tube(&mut mesh, &[(Vec3::ZERO, 0.5), (Vec3::Y, 0.5)], 16, 1.0, 1.0);
    for (y, up) in [(1.0_f32, 1.0_f32), (0.0, -1.0)] {
        let center = mesh.vertex(vec3(0.0, y, 0.0), vec3(0.0, up, 0.0), vec2(0.5, 0.5));
        let ring: Vec<u32> = (0..16)
            .map(|s| {
                let (sin, cos) = math::sin_cos(math::TAU * s as f32 / 16.0);
                mesh.vertex(vec3(cos * 0.5, y, sin * 0.5), vec3(0.0, up, 0.0), vec2(0.5 + cos * 0.5, 0.5 + sin * 0.5))
            })
            .collect();
        for s in 0..16 {
            let (a, b) = (ring[s], ring[(s + 1) % 16]);
            mesh.indices.extend(if up > 0.0 { [center, b, a] } else { [center, a, b] });
        }
    }
    mesh
}

/// A tube along `spine` (points and their radii): `sides` vertices around each point, the frame
/// carried along the spine without twisting, smooth normals; its texture wraps `wraps` times around
/// and repeats every `tile` metres along (open ends: a branch ends in its leaves, a trunk in the
/// ground).
pub fn tube(mesh: &mut Mesh, spine: &[(Vec3, f32)], sides: u32, wraps: f32, tile: f32) {
    if spine.len() < 2 {
        return;
    }
    let direction = |k: usize| (spine[(k + 1).min(spine.len() - 1)].0 - spine[k.saturating_sub(1)].0).normalize_or(Vec3::Y);
    let first = direction(0);
    let helper = if first.y.abs() > 0.9 { Vec3::X } else { Vec3::Y };
    let mut across = first.cross(helper).normalize();
    let mut along = 0.0;
    let base = mesh.positions.len() as u32;
    for (k, (point, radius)) in spine.iter().enumerate() {
        let dir = direction(k);
        across = (across - dir * across.dot(dir)).normalize_or(dir.any_orthonormal_vector());
        let other = dir.cross(across);
        if k > 0 {
            along += (spine[k].0 - spine[k - 1].0).length();
        }
        for s in 0..=sides {
            let (sin, cos) = math::sin_cos(math::TAU * s as f32 / sides as f32);
            let n = across * cos + other * sin;
            mesh.vertex(*point + n * *radius, n, vec2(wraps * s as f32 / sides as f32, along / tile));
        }
    }
    let row = sides + 1;
    for k in 0..spine.len() as u32 - 1 {
        for s in 0..sides {
            let a = base + k * row + s;
            mesh.indices.extend([a, a + row, a + 1, a + 1, a + row, a + row + 1]);
        }
    }
}

/// A box of `size` centred at `center` whose texture repeats every `tile` metres on every face,
/// shifted by `offset` (texture units): u runs along x on the top, the bottom and the faces
/// across z, along z on the faces across x, and v down the sides, so wood grain follows a plank's
/// length along x and courses of stone or slate stay level.
pub fn textured_box(center: Vec3, size: Vec3, tile: f32, offset: Vec2) -> Mesh {
    let mut mesh = Mesh::default();
    let half = size * 0.5;
    let faces = [(Vec3::X, Vec3::NEG_Z, Vec3::Y), (Vec3::NEG_X, Vec3::Z, Vec3::Y), (Vec3::Y, Vec3::X, Vec3::NEG_Z), (Vec3::NEG_Y, Vec3::X, Vec3::Z), (Vec3::Z, Vec3::X, Vec3::Y), (Vec3::NEG_Z, Vec3::NEG_X, Vec3::Y)];
    for (n, u, v) in faces {
        let (u_len, v_len) = ((u * size).length(), (v * size).length());
        let origin = center + n * (n * half).length();
        let corners = [(-0.5, -0.5), (0.5, -0.5), (0.5, 0.5), (-0.5, 0.5)];
        let ids: Vec<u32> = corners
            .iter()
            .map(|&(a, b)| mesh.vertex(origin + u * a * u_len + v * b * v_len, n, offset + vec2((a + 0.5) * u_len / tile, (0.5 - b) * v_len / tile)))
            .collect();
        let facing = (mesh_point(&mesh, ids[1]) - mesh_point(&mesh, ids[0])).cross(mesh_point(&mesh, ids[2]) - mesh_point(&mesh, ids[0])).dot(n) > 0.0;
        mesh.indices.extend(if facing { [ids[0], ids[1], ids[2], ids[0], ids[2], ids[3]] } else { [ids[0], ids[2], ids[1], ids[0], ids[3], ids[2]] });
    }
    mesh
}

fn mesh_point(mesh: &Mesh, index: u32) -> Vec3 {
    Vec3::from(mesh.positions[index as usize])
}

/// A unit sphere with smooth normals (16 rings, 24 segments), its texture wrapping once around.
pub fn sphere() -> Mesh {
    let (rings, segments) = (16u32, 24u32);
    let mut mesh = Mesh::default();
    for ring in 0..=rings {
        let theta = math::PI * ring as f32 / rings as f32;
        for segment in 0..=segments {
            let phi = math::TAU * segment as f32 / segments as f32;
            let n = vec3(math::sin(theta) * math::cos(phi), math::cos(theta), -math::sin(theta) * math::sin(phi));
            mesh.vertex(n, n, vec2(segment as f32 / segments as f32, ring as f32 / rings as f32));
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

/// Rings and segments of a smooth rock.
const ROCK_RINGS: u32 = 22;
const ROCK_SEGMENTS: u32 = 32;

/// A weathered rock: a unit sphere pushed out by noise into a lumpy, smooth boulder (normals from
/// the displaced surface, so it shades round, never faceted), flattened underneath, its poles
/// along x so their texture pinch is on its flanks. The texture wraps twice around.
pub fn smooth_rock(variant: u32) -> Mesh {
    let salt = 700 + variant * 31;
    let surface = |d: Vec3| {
        let lumps = 0.72 + 0.5 * direction_noise(d * 1.6, salt) + 0.12 * direction_noise(d * 4.5, salt + 3);
        let p = d * lumps;
        vec3(p.x, p.y.max(-0.35 + 0.1 * p.y), p.z)
    };
    let direction = |theta: f32, phi: f32| vec3(math::cos(theta), math::sin(theta) * math::cos(phi), math::sin(theta) * math::sin(phi));
    let mut mesh = Mesh::default();
    let e = 1e-3;
    for ring in 0..=ROCK_RINGS {
        let theta = (math::PI * ring as f32 / ROCK_RINGS as f32).clamp(e * 2.0, math::PI - e * 2.0);
        for segment in 0..=ROCK_SEGMENTS {
            let phi = math::TAU * segment as f32 / ROCK_SEGMENTS as f32;
            let p = surface(direction(theta, phi));
            let dt = surface(direction(theta + e, phi)) - surface(direction(theta - e, phi));
            let dp = surface(direction(theta, phi + e)) - surface(direction(theta, phi - e));
            let mut n = dt.cross(dp).normalize_or(p.normalize_or(Vec3::Y));
            if n.dot(p) < 0.0 {
                n = -n;
            }
            mesh.vertex(p, n, vec2(2.0 * segment as f32 / ROCK_SEGMENTS as f32, ring as f32 / ROCK_RINGS as f32));
        }
    }
    let row = ROCK_SEGMENTS + 1;
    for ring in 0..ROCK_RINGS {
        for segment in 0..ROCK_SEGMENTS {
            let a = ring * row + segment;
            let (b, c, d) = (a + row, a + 1, a + row + 1);
            let outward = (mesh_point(&mesh, b) - mesh_point(&mesh, a)).cross(mesh_point(&mesh, c) - mesh_point(&mesh, a)).dot(mesh_point(&mesh, a)) > 0.0;
            mesh.indices.extend(if outward { [a, b, c, c, b, d] } else { [a, c, b, c, d, b] });
        }
    }
    mesh
}

/// Every asset of `game/assets/` as (file name, bytes), in a fixed order: the GLBs and the splat
/// map.
pub fn all_assets() -> Vec<(String, Vec<u8>)> {
    let mut assets: Vec<(String, Vec<u8>)> = vec![("terrain.glb".to_owned(), glb(&terrain())), ("terrain-splat.png".to_owned(), splat_png())];
    assets.extend((0..3).map(|i| (format!("rock-{i}.glb"), glb(&smooth_rock(i)))));
    assets.push(("cylinder.glb".to_owned(), glb(&cylinder())));
    assets.push(("sphere.glb".to_owned(), glb(&sphere())));
    assets.extend(crate::trees::assets().into_iter().map(|(name, mesh)| (name, glb(&mesh))));
    assets.extend(crate::props::assets().into_iter().map(|(name, mesh)| (name, glb(&mesh))));
    assets
}
