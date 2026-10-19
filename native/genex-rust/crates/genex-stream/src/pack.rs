//! Cell pack format v1: what the host compiles a world's placement into (C-28), and what
//! `Streaming::cells_from(folder)` reads.
//!
//! A pack is a folder under `assets/` holding `world.json` and one `cells/<x>_<z>.cell` file per
//! listed cell; an unlisted cell inside the bounds is empty. The shared fixture
//! `tests/fixtures/stream/cell-pack-v1.json` holds both sides to the same bytes.
//!
//! `world.json` is compact JSON with exactly these keys, in this order:
//! `{"format":"genex-cell-pack","version":1,"cellSize":64,"min":{"x":-1,"z":-1},"max":{"x":1,"z":1},
//! "cells":[{"x":-1,"z":0,"bytes":604,"fnv":"<16 lowercase hex>"}]}`. The cell size is a whole number
//! of metres; the bounds are inclusive cells inside the world; cells are listed strictly ascending
//! (by `x`, then `z`) inside the bounds, each with its body's size and FNV-1a 64.
//!
//! A cell body is postcard 1.x wire format: unsigned integers as LEB128 varints (minimal, at most 5
//! bytes for a `u32`), signed integers as zigzag varints, `f32` as 4 bytes little-endian, strings as
//! a varint byte length and UTF-8, sequences as a varint count and the items, options as a 0 or 1
//! byte and the value, a collider shape as its varint index in [`ColliderShapeKind::ALL`] and its
//! fields. The fields, in order: version (`u32`, 1), cell `x` and `z` (`i32`, the file's own cell),
//! terrain (`Option<(path, samples)>`), nav sources (`u32` bits of [`NavSource`]), things
//! (`kind: u32`, transform, `data`: the game's JSON text), colliders (shape, transform), models
//! (path, transform), groups (model path, transforms), far model (`Option<path>`). A transform is
//! translation xyz, rotation xyzw and scale xyz, ten finite `f32`. Paths are `assets/`-relative and
//! pass genex-core's `is_safe_asset_path`. Nothing may follow the last field.
//!
//! The reader checks the declared size and the digest first, then walks the body once without
//! allocating; only a body that passed is built, with each `Vec` reserved to its exact count. So a
//! refused pack allocates nothing, and a count is checked against its cap and the bytes left before
//! anything is reserved for it. The writer encodes with the same rules and then walks its own output,
//! so it never writes a pack the reader refuses. The varints are hand-coded rather than derived
//! through serde so the reader can bound every allocation and the host's writer (C-28) can match
//! the bytes from this text alone.

use genex_core::cell::CellId;
use genex_core::digest::{fnv1a64, hex64};
use genex_core::json::{self, Value};
use genex_core::paths::is_safe_asset_path;
use glam::{Quat, Vec3};

use crate::error::StreamViewCode;
use crate::grid::Grid;

/// The pack format version this reader takes and this writer writes.
pub const PACK_VERSION: u32 = 1;
/// `world.json`'s `format` value.
pub const PACK_FORMAT: &str = "genex-cell-pack";
/// The world file inside a pack folder.
pub const PACK_WORLD_FILE: &str = "world.json";
/// The largest `world.json`, in bytes (refused before it is parsed).
pub const PACK_WORLD_BYTES_MAX: usize = 8 * 1024 * 1024;
/// The largest cell body, in bytes.
pub const PACK_CELL_BYTES_MAX: usize = 16 * 1024 * 1024;
/// The most cells one `world.json` lists.
pub const PACK_CELLS_MAX: usize = 65_536;
/// The most things one cell holds.
pub const CELL_THINGS_MAX: usize = 4_096;
/// The most colliders one cell holds.
pub const CELL_COLLIDERS_MAX: usize = 4_096;
/// The most single model placements one cell holds.
pub const CELL_MODELS_MAX: usize = 1_024;
/// The most instance groups one cell holds.
pub const CELL_GROUPS_MAX: usize = 256;
/// The most group instances one cell holds, over all its groups.
pub const CELL_INSTANCES_MAX: usize = 65_536;
/// The longest path, in bytes.
pub const PACK_PATH_BYTES_MAX: usize = 256;
/// The longest thing data text, in bytes.
pub const PACK_DATA_BYTES_MAX: usize = 4_096;
/// The samples per side a terrain tile may have (tile side = cell size).
pub const TERRAIN_TILE_SAMPLES: [u32; 4] = [65, 129, 257, 513];

/// `world.json` nests an object, the cell array and a cell object.
const WORLD_JSON_DEPTH: usize = 4;
/// Ten `f32`: translation, rotation, scale.
const TRANSFORM_BYTES: usize = 40;
/// The fewest bytes a thing takes: its kind, a transform and an empty data text.
const THING_BYTES_MIN: usize = 1 + TRANSFORM_BYTES + 1;
/// The fewest bytes a collider takes: a ball's tag and radius, and a transform.
const COLLIDER_BYTES_MIN: usize = 1 + 4 + TRANSFORM_BYTES;
/// The fewest bytes a model placement takes: a one-byte path and a transform.
const MODEL_BYTES_MIN: usize = 2 + TRANSFORM_BYTES;
/// The fewest bytes a group takes: a one-byte path and its count.
const GROUP_BYTES_MIN: usize = 3;
/// The most bytes a `u32` varint takes.
const VARINT_BYTES_MAX: usize = 5;

/// A refused pack: the code, what was wrong (never matched on) and the byte it was found at.
/// Building one allocates nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PackError {
    /// `stream-pack-invalid` or `stream-pack-digest`.
    pub code: StreamViewCode,
    /// What was wrong, for a person to read.
    pub detail: &'static str,
    /// The byte offset in the body or `world.json` (0 when the whole file is at fault).
    pub at: usize,
}

impl PackError {
    fn invalid(detail: &'static str, at: usize) -> PackError {
        PackError { code: StreamViewCode::PackInvalid, detail, at }
    }
}

impl std::fmt::Display for PackError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {} (at byte {})", self.code.wire(), self.detail, self.at)
    }
}

impl std::error::Error for PackError {}

type Read<T> = Result<T, PackError>;

/// A collider shape's kind, its wire spelling and its tag (the index in [`ColliderShapeKind::ALL`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ColliderShapeKind {
    /// A box by its half extents.
    Cuboid,
    /// A sphere by its radius.
    Ball,
    /// A Y-axis capsule by its half height and radius.
    Capsule,
    /// A Y-axis cylinder by its half height and radius.
    Cylinder,
    /// A window of the cell's terrain tile, in samples.
    Heightfield,
}

impl ColliderShapeKind {
    /// Every kind, in tag order.
    pub const ALL: [ColliderShapeKind; 5] =
        [ColliderShapeKind::Cuboid, ColliderShapeKind::Ball, ColliderShapeKind::Capsule, ColliderShapeKind::Cylinder, ColliderShapeKind::Heightfield];

    /// The kind's wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            ColliderShapeKind::Cuboid => "cuboid",
            ColliderShapeKind::Ball => "ball",
            ColliderShapeKind::Capsule => "capsule",
            ColliderShapeKind::Cylinder => "cylinder",
            ColliderShapeKind::Heightfield => "heightfield",
        }
    }

    /// The kind's tag in a cell body.
    pub const fn tag(self) -> u32 {
        self as u32
    }
}

/// What a cell's nav island is built from, as bits of the body's `nav` field.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum NavSource {
    /// The cell's colliders.
    Colliders,
    /// The cell's terrain tile.
    Terrain,
}

impl NavSource {
    /// Every source, in bit order.
    pub const ALL: [NavSource; 2] = [NavSource::Colliders, NavSource::Terrain];

    /// The source's wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            NavSource::Colliders => "colliders",
            NavSource::Terrain => "terrain",
        }
    }

    /// The source's bit.
    pub const fn bit(self) -> u32 {
        match self {
            NavSource::Colliders => 1,
            NavSource::Terrain => 2,
        }
    }
}

/// Every bit a `nav` field may hold.
const NAV_SOURCE_BITS: u32 = NavSource::Colliders.bit() | NavSource::Terrain.bit();

/// A placement: translation, rotation and scale.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PackTransform {
    /// World position, metres.
    pub translation: Vec3,
    /// Rotation (stored x, y, z, w).
    pub rotation: Quat,
    /// Scale per axis.
    pub scale: Vec3,
}

impl PackTransform {
    /// No move, no turn, scale 1.
    pub const IDENTITY: PackTransform = PackTransform { translation: Vec3::ZERO, rotation: Quat::IDENTITY, scale: Vec3::ONE };
}

/// A collider shape with its dimensions.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PackShape {
    /// A box by its half extents (each positive).
    Cuboid {
        /// Half extents, metres.
        half: Vec3,
    },
    /// A sphere.
    Ball {
        /// Radius, metres (positive).
        radius: f32,
    },
    /// A Y-axis capsule.
    Capsule {
        /// Half the segment's height, metres (positive).
        half_height: f32,
        /// Radius, metres (positive).
        radius: f32,
    },
    /// A Y-axis cylinder.
    Cylinder {
        /// Half height, metres (positive).
        half_height: f32,
        /// Radius, metres (positive).
        radius: f32,
    },
    /// A window of the cell's terrain tile: `columns` by `rows` samples from sample (`x`, `z`),
    /// at least 2 by 2 and inside the tile.
    Heightfield {
        /// First sample column.
        x: u32,
        /// First sample row.
        z: u32,
        /// Samples across.
        columns: u32,
        /// Samples down.
        rows: u32,
    },
}

impl PackShape {
    /// The shape's kind.
    pub const fn kind(&self) -> ColliderShapeKind {
        match self {
            PackShape::Cuboid { .. } => ColliderShapeKind::Cuboid,
            PackShape::Ball { .. } => ColliderShapeKind::Ball,
            PackShape::Capsule { .. } => ColliderShapeKind::Capsule,
            PackShape::Cylinder { .. } => ColliderShapeKind::Cylinder,
            PackShape::Heightfield { .. } => ColliderShapeKind::Heightfield,
        }
    }
}

/// A thing the game spawns when the cell enters: its kind number and its JSON data text.
#[derive(Clone, Debug, PartialEq)]
pub struct PackThing {
    /// The game's own kind number.
    pub kind: u32,
    /// Where it stands.
    pub transform: PackTransform,
    /// The game's JSON text, not parsed here.
    pub data: String,
}

/// A static collider inserted while the cell is active.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PackCollider {
    /// The shape.
    pub shape: PackShape,
    /// Where it stands.
    pub transform: PackTransform,
}

/// One model drawn while the cell is resident.
#[derive(Clone, Debug, PartialEq)]
pub struct PackModel {
    /// The model's path under `assets/`.
    pub path: String,
    /// Where it stands.
    pub transform: PackTransform,
}

/// An instance group: one model drawn many times.
#[derive(Clone, Debug, PartialEq)]
pub struct PackGroup {
    /// The model's path under `assets/`.
    pub model: String,
    /// One transform per instance.
    pub instances: Vec<PackTransform>,
}

/// The cell's terrain tile.
#[derive(Clone, Debug, PartialEq)]
pub struct PackTerrain {
    /// The tile's heights under `assets/`.
    pub path: String,
    /// Samples per side, one of [`TERRAIN_TILE_SAMPLES`].
    pub samples: u32,
}

/// One cell's content, as a cell body holds it.
#[derive(Clone, Debug, PartialEq)]
pub struct CellPack {
    /// The cell.
    pub cell: CellId,
    /// Its terrain tile.
    pub terrain: Option<PackTerrain>,
    /// Bits of [`NavSource`].
    pub nav: u32,
    /// Things, in build order.
    pub things: Vec<PackThing>,
    /// Colliders, in build order.
    pub colliders: Vec<PackCollider>,
    /// Single models.
    pub models: Vec<PackModel>,
    /// Instance groups.
    pub groups: Vec<PackGroup>,
    /// The model drawn past the detail radius (its HLOD).
    pub far: Option<String>,
}

/// One `world.json` row: a listed cell, its body's size and its FNV-1a 64.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PackEntry {
    /// The cell.
    pub cell: CellId,
    /// The body's size in bytes.
    pub bytes: u32,
    /// The body's FNV-1a 64.
    pub fnv: u64,
}

impl PackEntry {
    /// The row that lists `body` for `cell`.
    pub fn of(cell: CellId, body: &[u8]) -> PackEntry {
        PackEntry { cell, bytes: u32::try_from(body.len()).unwrap_or(u32::MAX), fnv: fnv1a64(body) }
    }
}

/// `cells/<x>_<z>.cell`: a cell's body file inside its pack folder.
pub fn cell_file(cell: CellId) -> String {
    format!("cells/{}_{}.cell", cell.x, cell.z)
}

/// `<folder>/<file>`, both of which must stay inside `assets/` (`is_safe_asset_path`).
pub fn pack_file(folder: &str, file: &str) -> Result<String, PackError> {
    if !(is_safe_asset_path(folder) && is_safe_asset_path(file)) {
        return Err(PackError::invalid("the pack folder or file escapes assets/", 0));
    }
    Ok(format!("{folder}/{file}"))
}

/// A body's bytes, read front to back. Every read checks what is left.
struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn fail<T>(&self, detail: &'static str) -> Read<T> {
        Err(PackError::invalid(detail, self.at))
    }

    fn remaining(&self) -> usize {
        self.bytes.len() - self.at
    }

    fn take(&mut self, n: usize) -> Read<&'a [u8]> {
        if n > self.remaining() {
            return self.fail("the body ends early");
        }
        let out = &self.bytes[self.at..self.at + n];
        self.at += n;
        Ok(out)
    }

    fn varint(&mut self) -> Read<u32> {
        let mut value: u64 = 0;
        for i in 0..VARINT_BYTES_MAX {
            let byte = self.take(1)?[0];
            value |= u64::from(byte & 0x7f) << (7 * i);
            if byte & 0x80 == 0 {
                if byte == 0 && i > 0 {
                    return self.fail("a varint is not in its shortest form");
                }
                return u32::try_from(value).or_else(|_| self.fail("a varint overflows 32 bits"));
            }
        }
        self.fail("a varint is longer than 5 bytes")
    }

    fn zigzag(&mut self) -> Read<i32> {
        let n = self.varint()?;
        Ok(((n >> 1) as i32) ^ -((n & 1) as i32))
    }

    fn f32(&mut self) -> Read<f32> {
        let raw = self.take(4)?;
        Ok(f32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]))
    }

    fn positive(&mut self) -> Read<f32> {
        let v = self.f32()?;
        if v > 0.0 && v.is_finite() { Ok(v) } else { self.fail("a collider size is not a positive number") }
    }

    fn transform(&mut self) -> Read<PackTransform> {
        let mut v = [0.0f32; 10];
        for slot in &mut v {
            *slot = self.f32()?;
        }
        if !v.iter().all(|x| x.is_finite()) {
            return self.fail("a transform is not finite");
        }
        Ok(PackTransform {
            translation: Vec3::new(v[0], v[1], v[2]),
            rotation: Quat::from_xyzw(v[3], v[4], v[5], v[6]),
            scale: Vec3::new(v[7], v[8], v[9]),
        })
    }

    fn option(&mut self) -> Read<bool> {
        match self.take(1)?[0] {
            0 => Ok(false),
            1 => Ok(true),
            _ => self.fail("an option tag is neither 0 nor 1"),
        }
    }

    fn text(&mut self, cap: usize) -> Read<&'a str> {
        let len = self.varint()? as usize;
        if len > cap {
            return self.fail("a text is longer than its cap");
        }
        let raw = self.take(len)?;
        std::str::from_utf8(raw).or_else(|_| self.fail("a text is not UTF-8"))
    }

    fn path(&mut self) -> Read<&'a str> {
        let path = self.text(PACK_PATH_BYTES_MAX)?;
        if is_safe_asset_path(path) { Ok(path) } else { self.fail("a path escapes assets/") }
    }

    /// A count, at most `cap`, whose items (each at least `item_bytes`) fit the bytes left.
    fn count(&mut self, cap: usize, item_bytes: usize) -> Read<usize> {
        let n = self.varint()? as usize;
        if n > cap {
            return self.fail("a count is over its cap");
        }
        if n.saturating_mul(item_bytes) > self.remaining() {
            return self.fail("a count claims more than the body holds");
        }
        Ok(n)
    }

    fn shape(&mut self, samples: Option<u32>) -> Read<PackShape> {
        let tag = self.varint()?;
        let Some(kind) = ColliderShapeKind::ALL.get(tag as usize) else {
            return self.fail("an unknown collider shape");
        };
        Ok(match kind {
            ColliderShapeKind::Cuboid => PackShape::Cuboid { half: Vec3::new(self.positive()?, self.positive()?, self.positive()?) },
            ColliderShapeKind::Ball => PackShape::Ball { radius: self.positive()? },
            ColliderShapeKind::Capsule => PackShape::Capsule { half_height: self.positive()?, radius: self.positive()? },
            ColliderShapeKind::Cylinder => PackShape::Cylinder { half_height: self.positive()?, radius: self.positive()? },
            ColliderShapeKind::Heightfield => self.heightfield(samples)?,
        })
    }

    fn heightfield(&mut self, samples: Option<u32>) -> Read<PackShape> {
        let (x, z, columns, rows) = (self.varint()?, self.varint()?, self.varint()?, self.varint()?);
        let Some(samples) = samples else {
            return self.fail("a heightfield collider in a cell without terrain");
        };
        let fits = |first: u32, count: u32| count >= 2 && u64::from(first) + u64::from(count) <= u64::from(samples);
        if !(fits(x, columns) && fits(z, rows)) {
            return self.fail("a heightfield window is outside the terrain tile");
        }
        Ok(PackShape::Heightfield { x, z, columns, rows })
    }
}

/// What a walk over a valid body reports, in body order. The scan ignores it all; the build keeps it.
trait Visit<'a> {
    fn terrain(&mut self, _path: &'a str, _samples: u32) {}
    fn nav(&mut self, _bits: u32) {}
    fn things(&mut self, _count: usize) {}
    fn thing(&mut self, _kind: u32, _transform: PackTransform, _data: &'a str) {}
    fn colliders(&mut self, _count: usize) {}
    fn collider(&mut self, _shape: PackShape, _transform: PackTransform) {}
    fn models(&mut self, _count: usize) {}
    fn model(&mut self, _path: &'a str, _transform: PackTransform) {}
    fn groups(&mut self, _count: usize) {}
    fn group(&mut self, _model: &'a str, _instances: usize) {}
    fn instance(&mut self, _transform: PackTransform) {}
    fn far(&mut self, _path: &'a str) {}
}

/// The first pass: checks everything, keeps nothing.
struct Scan;

impl Visit<'_> for Scan {}

impl<'a> Visit<'a> for CellPack {
    fn terrain(&mut self, path: &'a str, samples: u32) {
        self.terrain = Some(PackTerrain { path: path.to_owned(), samples });
    }

    fn nav(&mut self, bits: u32) {
        self.nav = bits;
    }

    fn things(&mut self, count: usize) {
        self.things.reserve_exact(count);
    }

    fn thing(&mut self, kind: u32, transform: PackTransform, data: &'a str) {
        self.things.push(PackThing { kind, transform, data: data.to_owned() });
    }

    fn colliders(&mut self, count: usize) {
        self.colliders.reserve_exact(count);
    }

    fn collider(&mut self, shape: PackShape, transform: PackTransform) {
        self.colliders.push(PackCollider { shape, transform });
    }

    fn models(&mut self, count: usize) {
        self.models.reserve_exact(count);
    }

    fn model(&mut self, path: &'a str, transform: PackTransform) {
        self.models.push(PackModel { path: path.to_owned(), transform });
    }

    fn groups(&mut self, count: usize) {
        self.groups.reserve_exact(count);
    }

    fn group(&mut self, model: &'a str, instances: usize) {
        self.groups.push(PackGroup { model: model.to_owned(), instances: Vec::with_capacity(instances) });
    }

    fn instance(&mut self, transform: PackTransform) {
        if let Some(group) = self.groups.last_mut() {
            group.instances.push(transform);
        }
    }

    fn far(&mut self, path: &'a str) {
        self.far = Some(path.to_owned());
    }
}

/// Walks a body of `cell`, refusing anything v1 does not allow, and reports each part to `visit`.
fn walk<'a>(bytes: &'a [u8], cell: CellId, visit: &mut impl Visit<'a>) -> Read<()> {
    let mut r = Reader { bytes, at: 0 };
    if r.varint()? != PACK_VERSION {
        return r.fail("an unknown cell pack version");
    }
    if CellId::new(r.zigzag()?, r.zigzag()?) != cell {
        return r.fail("the body is another cell's");
    }
    let samples = walk_terrain(&mut r, visit)?;
    let nav = r.varint()?;
    if nav & !NAV_SOURCE_BITS != 0 {
        return r.fail("an unknown nav source bit");
    }
    visit.nav(nav);
    walk_content(&mut r, samples, visit)?;
    if r.option()? {
        visit.far(r.path()?);
    }
    if r.remaining() != 0 {
        return r.fail("bytes follow the last field");
    }
    Ok(())
}

/// The terrain option; returns the tile's samples per side.
fn walk_terrain<'a>(r: &mut Reader<'a>, visit: &mut impl Visit<'a>) -> Read<Option<u32>> {
    if !r.option()? {
        return Ok(None);
    }
    let path = r.path()?;
    let samples = r.varint()?;
    if !TERRAIN_TILE_SAMPLES.contains(&samples) {
        return r.fail("terrain samples are not a tile size");
    }
    visit.terrain(path, samples);
    Ok(Some(samples))
}

/// Things, colliders, models and groups.
fn walk_content<'a>(r: &mut Reader<'a>, samples: Option<u32>, visit: &mut impl Visit<'a>) -> Read<()> {
    let things = r.count(CELL_THINGS_MAX, THING_BYTES_MIN)?;
    visit.things(things);
    for _ in 0..things {
        let (kind, transform) = (r.varint()?, r.transform()?);
        visit.thing(kind, transform, r.text(PACK_DATA_BYTES_MAX)?);
    }
    let colliders = r.count(CELL_COLLIDERS_MAX, COLLIDER_BYTES_MIN)?;
    visit.colliders(colliders);
    for _ in 0..colliders {
        let shape = r.shape(samples)?;
        visit.collider(shape, r.transform()?);
    }
    let models = r.count(CELL_MODELS_MAX, MODEL_BYTES_MIN)?;
    visit.models(models);
    for _ in 0..models {
        let path = r.path()?;
        visit.model(path, r.transform()?);
    }
    let groups = r.count(CELL_GROUPS_MAX, GROUP_BYTES_MIN)?;
    visit.groups(groups);
    let mut instances_left = CELL_INSTANCES_MAX;
    for _ in 0..groups {
        let model = r.path()?;
        let instances = r.count(instances_left, TRANSFORM_BYTES)?;
        instances_left -= instances;
        visit.group(model, instances);
        for _ in 0..instances {
            visit.instance(r.transform()?);
        }
    }
    Ok(())
}

impl CellPack {
    /// A cell with nothing in it.
    pub fn empty(cell: CellId) -> CellPack {
        CellPack { cell, terrain: None, nav: 0, things: Vec::new(), colliders: Vec::new(), models: Vec::new(), groups: Vec::new(), far: None }
    }

    /// Reads the body `world.json` lists as `entry`. A body that is not the declared size, over
    /// [`PACK_CELL_BYTES_MAX`], or anything v1 does not allow refuses `stream-pack-invalid`; one
    /// whose digest differs refuses `stream-pack-digest`. A refusal allocates nothing.
    pub fn read(entry: &PackEntry, bytes: &[u8]) -> Result<CellPack, PackError> {
        if entry.bytes as usize > PACK_CELL_BYTES_MAX {
            return Err(PackError::invalid("the cell body is over the byte cap", 0));
        }
        if bytes.len() != entry.bytes as usize {
            return Err(PackError::invalid("the cell body is not the size world.json declares", bytes.len().min(entry.bytes as usize)));
        }
        if fnv1a64(bytes) != entry.fnv {
            return Err(PackError { code: StreamViewCode::PackDigest, detail: "the cell body's FNV-1a 64 is not the one world.json lists", at: 0 });
        }
        walk(bytes, entry.cell, &mut Scan)?;
        let mut pack = CellPack::empty(entry.cell);
        walk(bytes, entry.cell, &mut pack)?;
        Ok(pack)
    }

    /// The cell's body. Refuses (as [`CellPack::read`] would) a pack the reader would not take.
    pub fn to_bytes(&self) -> Result<Vec<u8>, PackError> {
        let mut w = Writer(Vec::new());
        w.varint(PACK_VERSION);
        w.zigzag(self.cell.x);
        w.zigzag(self.cell.z);
        w.option(self.terrain.as_ref(), |w, t| {
            w.text(&t.path);
            w.varint(t.samples);
        });
        w.varint(self.nav);
        w.count(self.things.len());
        for thing in &self.things {
            w.varint(thing.kind);
            w.transform(&thing.transform);
            w.text(&thing.data);
        }
        w.count(self.colliders.len());
        for collider in &self.colliders {
            w.shape(&collider.shape);
            w.transform(&collider.transform);
        }
        self.write_placements(&mut w);
        w.option(self.far.as_ref(), |w, far| w.text(far));
        if w.0.len() > PACK_CELL_BYTES_MAX {
            return Err(PackError::invalid("the cell body is over the byte cap", 0));
        }
        walk(&w.0, self.cell, &mut Scan)?;
        Ok(w.0)
    }

    fn write_placements(&self, w: &mut Writer) {
        w.count(self.models.len());
        for model in &self.models {
            w.text(&model.path);
            w.transform(&model.transform);
        }
        w.count(self.groups.len());
        for group in &self.groups {
            w.text(&group.model);
            w.count(group.instances.len());
            for instance in &group.instances {
                w.transform(instance);
            }
        }
    }
}

/// A body being written. Counts and lengths past `u32` are written as `u32::MAX`, which the
/// writer's own walk then refuses.
struct Writer(Vec<u8>);

impl Writer {
    fn varint(&mut self, value: u32) {
        let mut n = value;
        while n >= 0x80 {
            self.0.push((n as u8 & 0x7f) | 0x80);
            n >>= 7;
        }
        self.0.push(n as u8);
    }

    fn zigzag(&mut self, value: i32) {
        self.varint(((value << 1) ^ (value >> 31)) as u32);
    }

    fn count(&mut self, n: usize) {
        self.varint(u32::try_from(n).unwrap_or(u32::MAX));
    }

    fn f32s(&mut self, values: &[f32]) {
        for v in values {
            self.0.extend_from_slice(&v.to_le_bytes());
        }
    }

    fn text(&mut self, text: &str) {
        self.count(text.len());
        self.0.extend_from_slice(text.as_bytes());
    }

    fn transform(&mut self, t: &PackTransform) {
        self.f32s(&t.translation.to_array());
        self.f32s(&t.rotation.to_array());
        self.f32s(&t.scale.to_array());
    }

    fn option<T>(&mut self, value: Option<&T>, write: impl FnOnce(&mut Writer, &T)) {
        match value {
            None => self.0.push(0),
            Some(v) => {
                self.0.push(1);
                write(self, v);
            }
        }
    }

    fn shape(&mut self, shape: &PackShape) {
        self.varint(shape.kind().tag());
        match *shape {
            PackShape::Cuboid { half } => self.f32s(&half.to_array()),
            PackShape::Ball { radius } => self.f32s(&[radius]),
            PackShape::Capsule { half_height, radius } | PackShape::Cylinder { half_height, radius } => self.f32s(&[half_height, radius]),
            PackShape::Heightfield { x, z, columns, rows } => {
                for v in [x, z, columns, rows] {
                    self.varint(v);
                }
            }
        }
    }
}

/// A pack's `world.json`: the grid, the inclusive cell bounds and the listed cells, ascending.
#[derive(Clone, Debug, PartialEq)]
pub struct PackWorld {
    cell_size: u32,
    grid: Grid,
    min: CellId,
    max: CellId,
    cells: Vec<PackEntry>,
}

impl PackWorld {
    /// A world of `cell_size`-metre cells (a whole number inside the grid's caps) with bounds
    /// `min..=max` inside the world and `cells` listed strictly ascending inside them, at most
    /// [`PACK_CELLS_MAX`], each body 1 to [`PACK_CELL_BYTES_MAX`] bytes. Others refuse
    /// `stream-pack-invalid`.
    pub fn new(cell_size: u32, min: CellId, max: CellId, cells: Vec<PackEntry>) -> Result<PackWorld, PackError> {
        let invalid = |detail| Err(PackError::invalid(detail, 0));
        let Ok(grid) = Grid::new(cell_size as f32) else {
            return invalid("the cell size is outside the grid's caps");
        };
        let ordered = min.x <= max.x && min.z <= max.z;
        if !(ordered && grid.contains(min) && grid.contains(max)) {
            return invalid("the bounds are not ordered cells inside the world");
        }
        if cells.len() > PACK_CELLS_MAX {
            return invalid("more cells than the cap");
        }
        let inside = |c: CellId| (min.x..=max.x).contains(&c.x) && (min.z..=max.z).contains(&c.z);
        let sized = |e: &PackEntry| e.bytes > 0 && e.bytes as usize <= PACK_CELL_BYTES_MAX;
        if !cells.iter().all(|e| inside(e.cell) && sized(e)) {
            return invalid("a listed cell is outside the bounds or its size is out of range");
        }
        if !cells.windows(2).all(|pair| pair[0].cell < pair[1].cell) {
            return invalid("the cells are not listed strictly ascending");
        }
        Ok(PackWorld { cell_size, grid, min, max, cells })
    }

    /// Reads `world.json`. A text over [`PACK_WORLD_BYTES_MAX`] is refused before it is parsed;
    /// anything but the v1 shape refuses `stream-pack-invalid`.
    pub fn read(text: &[u8]) -> Result<PackWorld, PackError> {
        if text.len() > PACK_WORLD_BYTES_MAX {
            return Err(PackError::invalid("world.json is over the byte cap", 0));
        }
        let Ok(value) = json::parse_with_depth(text, WORLD_JSON_DEPTH) else {
            return Err(PackError::invalid("world.json is not JSON", 0));
        };
        let fields = exact_keys(&value, &["format", "version", "cellSize", "min", "max", "cells"])?;
        if fields[0].as_bytes() != PACK_FORMAT.as_bytes() || whole(fields[1]) != Some(i64::from(PACK_VERSION)) {
            return Err(PackError::invalid("not a version 1 cell pack", 0));
        }
        let cell_size = whole(fields[2]).and_then(|v| u32::try_from(v).ok()).ok_or(PackError::invalid("the cell size is not a whole number", 0))?;
        let Value::Array(rows) = fields[5] else {
            return Err(PackError::invalid("cells is not an array", 0));
        };
        if rows.len() > PACK_CELLS_MAX {
            return Err(PackError::invalid("more cells than the cap", 0));
        }
        let cells = rows.iter().map(entry_of).collect::<Result<Vec<_>, _>>()?;
        PackWorld::new(cell_size, cell_of(fields[3])?, cell_of(fields[4])?, cells)
    }

    /// The canonical `world.json` text (what C-28's compiler writes too).
    pub fn to_json(&self) -> Vec<u8> {
        let cell = |c: CellId| format!("{{\"x\":{},\"z\":{}}}", c.x, c.z);
        let rows: Vec<String> =
            self.cells.iter().map(|e| format!("{{\"x\":{},\"z\":{},\"bytes\":{},\"fnv\":\"{}\"}}", e.cell.x, e.cell.z, e.bytes, hex64(e.fnv))).collect();
        format!(
            "{{\"format\":\"{PACK_FORMAT}\",\"version\":{PACK_VERSION},\"cellSize\":{},\"min\":{},\"max\":{},\"cells\":[{}]}}",
            self.cell_size,
            cell(self.min),
            cell(self.max),
            rows.join(",")
        )
        .into_bytes()
    }

    /// The cell side, whole metres.
    pub fn cell_size(&self) -> u32 {
        self.cell_size
    }

    /// The grid the cells sit on.
    pub fn grid(&self) -> &Grid {
        &self.grid
    }

    /// The first and last cells of the bounds (inclusive).
    pub fn bounds(&self) -> (CellId, CellId) {
        (self.min, self.max)
    }

    /// The listed cells, ascending.
    pub fn cells(&self) -> &[PackEntry] {
        &self.cells
    }

    /// The row of a listed cell; `None` for an empty one.
    pub fn entry(&self, cell: CellId) -> Option<&PackEntry> {
        self.cells.binary_search_by(|e| e.cell.cmp(&cell)).ok().map(|i| &self.cells[i])
    }
}

/// An object's members by `keys`, refusing any other, missing or repeated key.
fn exact_keys<'v>(value: &'v Value, keys: &[&str]) -> Read<Vec<&'v Value>> {
    let Value::Object(members) = value else {
        return Err(PackError::invalid("an object was expected", 0));
    };
    let known = members.iter().all(|(key, _)| keys.iter().any(|k| k.as_bytes() == key.as_slice()));
    if !(known && members.len() == keys.len()) {
        return Err(PackError::invalid("an object's keys are not the v1 keys", 0));
    }
    keys.iter().map(|k| value.get(k).ok_or(PackError::invalid("an object's keys are not the v1 keys", 0))).collect()
}

/// A JSON number that is a whole number an `i64` holds.
fn whole(value: &Value) -> Option<i64> {
    let Value::Number(n) = value else { return None };
    let fits = n.fract() == 0.0 && n.abs() < 9.0e15;
    fits.then_some(*n as i64)
}

fn coordinate(value: &Value) -> Read<i32> {
    whole(value).and_then(|v| i32::try_from(v).ok()).ok_or(PackError::invalid("a cell coordinate is not a whole number", 0))
}

fn cell_of(value: &Value) -> Read<CellId> {
    let fields = exact_keys(value, &["x", "z"])?;
    Ok(CellId::new(coordinate(fields[0])?, coordinate(fields[1])?))
}

fn entry_of(value: &Value) -> Read<PackEntry> {
    let fields = exact_keys(value, &["x", "z", "bytes", "fnv"])?;
    let cell = CellId::new(coordinate(fields[0])?, coordinate(fields[1])?);
    let bytes = whole(fields[2]).and_then(|v| u32::try_from(v).ok()).ok_or(PackError::invalid("a cell's bytes is not a whole number", 0))?;
    let digest = fields[3].as_bytes();
    let lower_hex = digest.len() == 16 && digest.iter().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b));
    let fnv = std::str::from_utf8(digest).ok().filter(|_| lower_hex).and_then(|text| u64::from_str_radix(text, 16).ok());
    let fnv = fnv.ok_or(PackError::invalid("a cell's fnv is not 16 lowercase hex digits", 0))?;
    Ok(PackEntry { cell, bytes, fnv })
}
