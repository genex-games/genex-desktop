//! The frontier's props, written as GLB bytes in code so the example ships no model file and every
//! destination reads the same bytes: a hut, a waystone, the watchtower, a rock, a pine and a door.
//! Each is a few oriented boxes, one primitive per material, standing on its origin. Adapted from
//! stream-valley's `props.rs`; the door is two nodes, a fixed frame and a slab hinged at the origin
//! that its `open` and `close` clips turn 90 degrees about y (a rigid node clip, AN-27).

use genex::glam::{Quat, Vec3};

/// The hut a village is made of (`models/hut.glb`).
pub const HUT: &str = "models/hut.glb";
/// The waystones along the ring road (`models/stone.glb`).
pub const STONE: &str = "models/stone.glb";
/// The watchtower the climber's ladder leans on (`models/tower.glb`): a 6 x 6 m block 3 m high.
pub const TOWER: &str = "models/tower.glb";
/// The rocks of the rock fields (`models/rock.glb`).
pub const ROCK: &str = "models/rock.glb";
/// The pines the cells scatter (`models/pine.glb`).
pub const PINE: &str = "models/pine.glb";
/// The door that swings open when an agent comes near (`models/door.glb`).
pub const DOOR: &str = "models/door.glb";
/// Every prop, by path.
pub const PROPS: [&str; 6] = [HUT, STONE, TOWER, ROCK, PINE, DOOR];
/// The door's clips: each turns the slab a quarter turn over [`DOOR_SWING_S`].
pub const DOOR_OPEN: &str = "open";
/// The clip that turns the slab back shut.
pub const DOOR_CLOSE: &str = "close";
/// How long a swing takes, seconds.
pub const DOOR_SWING_S: f32 = 1.0;
/// Keys a swing has.
const DOOR_KEYS: usize = 9;

/// One box: its centre, half extents and turn.
struct Block {
    center: Vec3,
    half: Vec3,
    turn: Quat,
}

const fn block(center: [f32; 3], half: [f32; 3]) -> Block {
    Block { center: Vec3::from_array(center), half: Vec3::from_array(half), turn: Quat::IDENTITY }
}

/// One primitive: a material colour (linear RGBA), its roughness and its boxes.
struct Part {
    color: [f32; 4],
    roughness: f32,
    blocks: Vec<Block>,
}

fn hut() -> Vec<Part> {
    let roof_turn = 0.6_f32;
    let roof = |side: f32| Block { center: Vec3::new(side * 1.55, 3.55, 0.0), half: Vec3::new(1.9, 0.12, 2.9), turn: Quat::from_rotation_z(-side * roof_turn) };
    vec![
        Part { color: [0.62, 0.48, 0.32, 1.0], roughness: 0.9, blocks: vec![block([0.0, 1.5, 0.0], [3.0, 1.5, 2.5])] },
        Part { color: [0.45, 0.16, 0.10, 1.0], roughness: 0.8, blocks: vec![roof(1.0), roof(-1.0)] },
        Part { color: [0.20, 0.13, 0.08, 1.0], roughness: 0.9, blocks: vec![block([0.0, 0.9, 2.52], [0.5, 0.9, 0.05])] },
    ]
}

fn stone() -> Vec<Part> {
    vec![Part { color: [0.42, 0.42, 0.40, 1.0], roughness: 0.95, blocks: vec![block([0.0, 0.8, 0.0], [0.3, 0.8, 0.2]), block([0.0, 1.65, 0.0], [0.24, 0.08, 0.16])] }]
}

fn tower() -> Vec<Part> {
    vec![
        Part { color: [0.50, 0.40, 0.30, 1.0], roughness: 0.9, blocks: vec![block([0.0, 1.5, 0.0], [3.0, 1.5, 3.0])] },
        Part { color: [0.35, 0.24, 0.15, 1.0], roughness: 0.85, blocks: vec![block([2.8, 3.5, 2.8], [0.12, 0.5, 0.12]), block([-2.8, 3.5, 2.8], [0.12, 0.5, 0.12]), block([2.8, 3.5, -2.8], [0.12, 0.5, 0.12]), block([-2.8, 3.5, -2.8], [0.12, 0.5, 0.12])] },
    ]
}

fn rock() -> Vec<Part> {
    let turned = |center: [f32; 3], half: [f32; 3], yaw: f32, tilt: f32| Block { center: Vec3::from_array(center), half: Vec3::from_array(half), turn: Quat::from_rotation_y(yaw) * Quat::from_rotation_x(tilt) };
    vec![Part { color: [0.36, 0.35, 0.33, 1.0], roughness: 0.95, blocks: vec![turned([0.0, 0.5, 0.0], [1.1, 0.6, 0.8], 0.3, 0.15), turned([0.5, 0.8, 0.2], [0.6, 0.5, 0.6], 1.1, -0.3)] }]
}

fn pine() -> Vec<Part> {
    vec![
        Part { color: [0.30, 0.20, 0.12, 1.0], roughness: 0.9, blocks: vec![block([0.0, 1.5, 0.0], [0.25, 1.5, 0.25])] },
        Part { color: [0.10, 0.30, 0.12, 1.0], roughness: 0.85, blocks: vec![block([0.0, 3.2, 0.0], [1.8, 0.9, 1.8]), block([0.0, 4.8, 0.0], [1.3, 0.8, 1.3]), block([0.0, 6.2, 0.0], [0.8, 0.7, 0.8])] },
    ]
}

/// The prop at `path` as GLB bytes (None for another path): the same bytes on every call.
pub fn glb(path: &str) -> Option<Vec<u8>> {
    let parts = match path {
        HUT => hut(),
        STONE => stone(),
        TOWER => tower(),
        ROCK => rock(),
        PINE => pine(),
        DOOR => return Some(door()),
        _ => return None,
    };
    Some(write(path, &parts))
}

#[derive(Default)]
struct Writer {
    bin: Vec<u8>,
    views: Vec<String>,
    accessors: Vec<String>,
}

impl Writer {
    fn view(&mut self, bytes: &[u8], target: u32) -> usize {
        while !self.bin.len().is_multiple_of(4) {
            self.bin.push(0);
        }
        self.views.push(format!(r#"{{"buffer":0,"byteOffset":{},"byteLength":{},"target":{target}}}"#, self.bin.len(), bytes.len()));
        self.bin.extend_from_slice(bytes);
        self.views.len() - 1
    }

    fn vec3s(&mut self, values: &[f32], bounds: bool) -> usize {
        let bytes: Vec<u8> = values.iter().flat_map(|value| value.to_le_bytes()).collect();
        let view = self.view(&bytes, 34962);
        let bounds = if bounds {
            let (mut min, mut max) = ([f32::MAX; 3], [f32::MIN; 3]);
            for corner in values.chunks(3) {
                for axis in 0..3 {
                    min[axis] = min[axis].min(corner[axis]);
                    max[axis] = max[axis].max(corner[axis]);
                }
            }
            format!(r#","min":{},"max":{}"#, list(&min), list(&max))
        } else {
            String::new()
        };
        self.accessors.push(format!(r#"{{"bufferView":{view},"componentType":5126,"count":{},"type":"VEC3"{bounds}}}"#, values.len() / 3));
        self.accessors.len() - 1
    }

    fn floats(&mut self, values: &[f32], kind: &str, width: usize, bounds: Option<(f32, f32)>) -> usize {
        let bytes: Vec<u8> = values.iter().flat_map(|value| value.to_le_bytes()).collect();
        let view = self.view_plain(&bytes);
        let bounds = bounds.map_or(String::new(), |(min, max)| format!(r#","min":[{min}],"max":[{max}]"#));
        self.accessors.push(format!(r#"{{"bufferView":{view},"componentType":5126,"count":{},"type":"{kind}"{bounds}}}"#, values.len() / width));
        self.accessors.len() - 1
    }

    /// A view with no target (animation keys).
    fn view_plain(&mut self, bytes: &[u8]) -> usize {
        while !self.bin.len().is_multiple_of(4) {
            self.bin.push(0);
        }
        self.views.push(format!(r#"{{"buffer":0,"byteOffset":{},"byteLength":{}}}"#, self.bin.len(), bytes.len()));
        self.bin.extend_from_slice(bytes);
        self.views.len() - 1
    }

    fn indices(&mut self, values: &[u16]) -> usize {
        let bytes: Vec<u8> = values.iter().flat_map(|value| value.to_le_bytes()).collect();
        let view = self.view(&bytes, 34963);
        self.accessors.push(format!(r#"{{"bufferView":{view},"componentType":5123,"count":{},"type":"SCALAR"}}"#, values.len()));
        self.accessors.len() - 1
    }
}

fn list(values: &[f32]) -> String {
    let items: Vec<String> = values.iter().map(|value| format!("{value}")).collect();
    format!("[{}]", items.join(","))
}

/// A box's 24 corners with flat normals and its 36 indices.
fn push_block(block: &Block, positions: &mut Vec<f32>, normals: &mut Vec<f32>, indices: &mut Vec<u16>) {
    let axes = [block.turn * Vec3::X, block.turn * Vec3::Y, block.turn * Vec3::Z];
    let extent = block.half.to_array();
    for (axis, sign) in [(0, 1.0), (0, -1.0), (1, 1.0), (1, -1.0), (2, 1.0), (2, -1.0)] {
        let normal = axes[axis] * sign;
        let (u, v) = (axes[(axis + 1) % 3] * extent[(axis + 1) % 3], axes[(axis + 2) % 3] * extent[(axis + 2) % 3]);
        let face = block.center + normal * extent[axis];
        let base = (positions.len() / 3) as u16;
        let corners = if sign > 0.0 { [face - u - v, face + u - v, face + u + v, face - u + v] } else { [face - u - v, face - u + v, face + u + v, face + u - v] };
        for corner in corners {
            positions.extend(corner.to_array());
            normals.extend(normal.to_array());
        }
        indices.extend([base, base + 1, base + 2, base, base + 2, base + 3]);
    }
}

/// One mesh's primitives and materials (material indices from `first_material`), written through
/// `writer`.
fn mesh_json(writer: &mut Writer, parts: &[Part], first_material: usize) -> (Vec<String>, Vec<String>) {
    let mut primitives = Vec::new();
    let mut materials = Vec::new();
    for (index, part) in parts.iter().enumerate() {
        let (mut positions, mut normals, mut indices) = (Vec::new(), Vec::new(), Vec::new());
        for block in &part.blocks {
            push_block(block, &mut positions, &mut normals, &mut indices);
        }
        let position = writer.vec3s(&positions, true);
        let normal = writer.vec3s(&normals, false);
        let index_accessor = writer.indices(&indices);
        let material = first_material + index;
        primitives.push(format!(r#"{{"attributes":{{"POSITION":{position},"NORMAL":{normal}}},"indices":{index_accessor},"material":{material}}}"#));
        materials.push(format!(r#"{{"pbrMetallicRoughness":{{"baseColorFactor":{},"metallicFactor":0,"roughnessFactor":{}}}}}"#, list(&part.color), part.roughness));
    }
    (primitives, materials)
}

fn write(name: &str, parts: &[Part]) -> Vec<u8> {
    let mut writer = Writer::default();
    let (primitives, materials) = mesh_json(&mut writer, parts, 0);
    let json = format!(
        concat!(
            r#"{{"asset":{{"version":"2.0","generator":"genex frontier example"}},"buffers":[{{"byteLength":{bin}}}],"bufferViews":[{views}],"accessors":[{accessors}],"#,
            r#""materials":[{materials}],"meshes":[{{"name":"{name}","primitives":[{primitives}]}}],"nodes":[{{"name":"{name}","mesh":0}}],"scenes":[{{"nodes":[0]}}],"scene":0}}"#
        ),
        bin = writer.bin.len(),
        views = writer.views.join(","),
        accessors = writer.accessors.join(","),
        materials = materials.join(","),
        name = name,
        primitives = primitives.join(","),
    );
    pack(&json, &writer.bin)
}

/// The door: node 0 the fixed frame (two posts and a lintel round a 1.2 m opening), node 1 the slab
/// hinged at the origin, 1.2 m wide along +x and 2.1 m tall; clips `open` (0 to 90 degrees about y)
/// and `close` (back).
fn door() -> Vec<u8> {
    let frame = vec![Part { color: [0.30, 0.20, 0.12, 1.0], roughness: 0.9, blocks: vec![block([-0.1, 1.15, 0.0], [0.1, 1.15, 0.12]), block([1.3, 1.15, 0.0], [0.1, 1.15, 0.12]), block([0.6, 2.4, 0.0], [0.8, 0.1, 0.12])] }];
    let slab = vec![Part { color: [0.55, 0.34, 0.18, 1.0], roughness: 0.75, blocks: vec![block([0.6, 1.05, 0.0], [0.6, 1.05, 0.05])] }];
    let mut writer = Writer::default();
    let (frame_primitives, frame_materials) = mesh_json(&mut writer, &frame, 0);
    let (slab_primitives, slab_materials) = mesh_json(&mut writer, &slab, frame.len());
    let times: Vec<f32> = (0..DOOR_KEYS).map(|key| DOOR_SWING_S * key as f32 / (DOOR_KEYS - 1) as f32).collect();
    let input = writer.floats(&times, "SCALAR", 1, Some((0.0, DOOR_SWING_S)));
    let turn = |key: usize| Quat::from_rotation_y(-std::f32::consts::FRAC_PI_2 * key as f32 / (DOOR_KEYS - 1) as f32);
    let opening: Vec<f32> = (0..DOOR_KEYS).flat_map(|key| turn(key).to_array()).collect();
    let closing: Vec<f32> = (0..DOOR_KEYS).rev().flat_map(|key| turn(key).to_array()).collect();
    let open = writer.floats(&opening, "VEC4", 4, None);
    let close = writer.floats(&closing, "VEC4", 4, None);
    let clip = |name: &str, output: usize| format!(r#"{{"name":"{name}","samplers":[{{"input":{input},"output":{output},"interpolation":"LINEAR"}}],"channels":[{{"sampler":0,"target":{{"node":1,"path":"rotation"}}}}]}}"#);
    let materials: Vec<String> = frame_materials.into_iter().chain(slab_materials).collect();
    let json = format!(
        concat!(
            r#"{{"asset":{{"version":"2.0","generator":"genex frontier example"}},"buffers":[{{"byteLength":{bin}}}],"bufferViews":[{views}],"accessors":[{accessors}],"#,
            r#""materials":[{materials}],"meshes":[{{"name":"frame","primitives":[{frame}]}},{{"name":"slab","primitives":[{slab}]}}],"#,
            r#""nodes":[{{"name":"frame","mesh":0}},{{"name":"slab","mesh":1}}],"scenes":[{{"nodes":[0,1]}}],"scene":0,"animations":[{open},{close}]}}"#
        ),
        bin = writer.bin.len(),
        views = writer.views.join(","),
        accessors = writer.accessors.join(","),
        materials = materials.join(","),
        frame = frame_primitives.join(","),
        slab = slab_primitives.join(","),
        open = clip(DOOR_OPEN, open),
        close = clip(DOOR_CLOSE, close),
    );
    pack(&json, &writer.bin)
}

/// The GLB container: header, JSON chunk (space padded), BIN chunk (zero padded).
fn pack(json: &str, bin: &[u8]) -> Vec<u8> {
    let mut json = json.as_bytes().to_vec();
    while !json.len().is_multiple_of(4) {
        json.push(b' ');
    }
    let mut bin = bin.to_vec();
    while !bin.len().is_multiple_of(4) {
        bin.push(0);
    }
    let total = 12 + 8 + json.len() + 8 + bin.len();
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(b"glTF");
    out.extend_from_slice(&2u32.to_le_bytes());
    out.extend_from_slice(&(total as u32).to_le_bytes());
    out.extend_from_slice(&(json.len() as u32).to_le_bytes());
    out.extend_from_slice(b"JSON");
    out.extend_from_slice(&json);
    out.extend_from_slice(&(bin.len() as u32).to_le_bytes());
    out.extend_from_slice(b"BIN\0");
    out.extend_from_slice(&bin);
    out
}
