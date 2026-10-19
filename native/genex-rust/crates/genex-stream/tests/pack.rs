//! Cell pack format v1 (STR-24). The shared fixture (`tests/fixtures/stream/cell-pack-v1.json`,
//! written by an independent encoder from the same format text, and the bytes C-28's compiler must
//! write) round-trips through the reader and the writer; hostile `world.json` texts and cell
//! bodies (truncated, unknown version, escaping path, count over a cap, digest mismatch, and more)
//! are refused with a typed `stream-pack-invalid` or `stream-pack-digest` and no allocation past the
//! declared size; and 10,000 truncations and corruptions never panic.

// The counting allocator below implements `GlobalAlloc`, which is an unsafe trait; it only
// forwards to the system allocator and counts on the calling thread.
#![allow(unsafe_code)]

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;

use genex_core::digest::fnv1a64;
use genex_core::json::Value;
use genex_core::rng::Pcg32;
use genex_stream::CellId;
use genex_stream::error::StreamViewCode;
use genex_stream::pack::{
    CELL_COLLIDERS_MAX, CELL_GROUPS_MAX, CELL_INSTANCES_MAX, CELL_MODELS_MAX, CELL_THINGS_MAX, CellPack, ColliderShapeKind,
    NavSource, PACK_CELL_BYTES_MAX, PACK_CELLS_MAX, PACK_DATA_BYTES_MAX, PACK_PATH_BYTES_MAX, PACK_VERSION, PACK_WORLD_BYTES_MAX,
    PackCollider, PackEntry, PackGroup, PackModel, PackShape, PackTerrain, PackThing, PackTransform, PackWorld,
    TERRAIN_TILE_SAMPLES, cell_file, pack_file,
};
use glam::{Quat, Vec3};

/// Allocations and bytes, per thread, so parallel tests do not count each other.
struct Counting;

thread_local! {
    static ALLOCATIONS: Cell<u64> = const { Cell::new(0) };
    static BYTES: Cell<u64> = const { Cell::new(0) };
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let _ = ALLOCATIONS.try_with(|c| c.set(c.get() + 1));
        let _ = BYTES.try_with(|c| c.set(c.get() + layout.size() as u64));
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let _ = ALLOCATIONS.try_with(|c| c.set(c.get() + 1));
        let _ = BYTES.try_with(|c| c.set(c.get() + new_size as u64));
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static COUNTING: Counting = Counting;

/// (allocations, bytes) made on this thread while `run` runs.
fn counted<T>(run: impl FnOnce() -> T) -> (T, u64, u64) {
    let (a0, b0) = (ALLOCATIONS.with(Cell::get), BYTES.with(Cell::get));
    let out = run();
    (out, ALLOCATIONS.with(Cell::get) - a0, BYTES.with(Cell::get) - b0)
}

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/stream/cell-pack-v1.json");
    let text = std::fs::read(&path).unwrap_or_else(|error| panic!("{path:?}: {error}"));
    genex_core::json::parse(&text).expect("the fixture parses")
}

fn hex(text: &str) -> Vec<u8> {
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("hex")).collect()
}

fn f(value: &Value) -> f32 {
    value.as_f64() as f32
}

fn v3(value: &Value) -> Vec3 {
    let items = value.items();
    Vec3::new(f(&items[0]), f(&items[1]), f(&items[2]))
}

fn transform(value: &Value) -> PackTransform {
    let r = value["rotation"].items();
    PackTransform {
        translation: v3(&value["translation"]),
        rotation: Quat::from_xyzw(f(&r[0]), f(&r[1]), f(&r[2]), f(&r[3])),
        scale: v3(&value["scale"]),
    }
}

fn u(value: &Value) -> u32 {
    value.as_f64() as u32
}

fn shape(value: &Value) -> PackShape {
    match value["kind"].as_str() {
        "cuboid" => PackShape::Cuboid { half: v3(&value["half"]) },
        "ball" => PackShape::Ball { radius: f(&value["radius"]) },
        "capsule" => PackShape::Capsule { half_height: f(&value["halfHeight"]), radius: f(&value["radius"]) },
        "cylinder" => PackShape::Cylinder { half_height: f(&value["halfHeight"]), radius: f(&value["radius"]) },
        "heightfield" => PackShape::Heightfield { x: u(&value["x"]), z: u(&value["z"]), columns: u(&value["columns"]), rows: u(&value["rows"]) },
        other => panic!("shape {other}"),
    }
}

fn optional_text(value: &Value) -> Option<String> {
    (!value.is_null()).then(|| value.as_str().to_owned())
}

/// The fixture's `content` of one cell, as the reader should give it.
fn content(value: &Value) -> CellPack {
    let cell = CellId::new(value["cell"]["x"].as_f64() as i32, value["cell"]["z"].as_f64() as i32);
    let terrain = &value["terrain"];
    CellPack {
        cell,
        terrain: (!terrain.is_null()).then(|| PackTerrain { path: terrain["path"].as_str().to_owned(), samples: u(&terrain["samples"]) }),
        nav: u(&value["nav"]),
        things: value["things"]
            .items()
            .iter()
            .map(|t| PackThing { kind: u(&t["kind"]), transform: transform(&t["transform"]), data: t["data"].as_str().to_owned() })
            .collect(),
        colliders: value["colliders"].items().iter().map(|c| PackCollider { shape: shape(&c["shape"]), transform: transform(&c["transform"]) }).collect(),
        models: value["models"].items().iter().map(|m| PackModel { path: m["path"].as_str().to_owned(), transform: transform(&m["transform"]) }).collect(),
        groups: value["groups"]
            .items()
            .iter()
            .map(|g| PackGroup { model: g["model"].as_str().to_owned(), instances: g["instances"].items().iter().map(transform).collect() })
            .collect(),
        far: optional_text(&value["far"]),
    }
}

/// One fixture cell: its file name, its body bytes and what they hold.
type FixtureCell = (String, Vec<u8>, CellPack);

/// The fixture's world text and its cells.
fn shared() -> (Vec<u8>, Vec<FixtureCell>) {
    let pinned = fixture();
    let cells = pinned["cells"].items().iter().map(|c| (c["file"].as_str().to_owned(), hex(c["hex"].as_str()), content(&c["content"]))).collect();
    (pinned["world"].as_str().as_bytes().to_vec(), cells)
}

#[test]
fn the_fixture_round_trips_through_the_reader_and_the_writer() {
    let (text, cells) = shared();
    let world = PackWorld::read(&text).expect("the fixture's world.json");
    assert_eq!(world.to_json(), text, "the writer gives the fixture's world.json byte for byte");
    assert_eq!(world.cell_size(), 64);
    assert_eq!(world.bounds(), (CellId::new(-1, -1), CellId::new(1, 1)));
    assert_eq!(world.cells().len(), cells.len());
    for (file, bytes, expected) in &cells {
        let entry = world.entry(expected.cell).expect("listed");
        assert_eq!(&cell_file(expected.cell), file);
        assert_eq!(*entry, PackEntry::of(expected.cell, bytes));
        let pack = CellPack::read(entry, bytes).unwrap_or_else(|e| panic!("{file}: {e:?}"));
        assert_eq!(&pack, expected, "{file}: the reader gives the fixture's content");
        assert_eq!(&pack.to_bytes().expect("valid"), bytes, "{file}: the writer gives the fixture's bytes");
    }
    assert!(world.entry(CellId::new(1, 1)).is_none(), "an unlisted cell is empty");
    assert_eq!(pack_file("world", &cell_file(CellId::new(-1, 0))).unwrap(), "world/cells/-1_0.cell");
    // The pack is a contract held from both sides: the reader rebuilds the world from its parts.
    let rebuilt = PackWorld::new(64, CellId::new(-1, -1), CellId::new(1, 1), world.cells().to_vec()).expect("valid");
    assert_eq!(rebuilt.to_json(), text);
}

#[test]
fn the_fixture_pins_the_codes_caps_and_kinds() {
    let pinned = fixture();
    let names = |v: &Value| v.items().iter().map(|i| i.as_str().to_owned()).collect::<Vec<_>>();
    assert_eq!(pinned["version"].as_f64() as u32, PACK_VERSION);
    assert_eq!(names(&pinned["codes"]), StreamViewCode::ALL.map(StreamViewCode::wire));
    assert_eq!(names(&pinned["colliderShapes"]), ColliderShapeKind::ALL.map(ColliderShapeKind::wire));
    let caps = &pinned["caps"];
    let pinned_caps: Vec<(&str, u64)> = [
        "worldBytesMax",
        "cellBytesMax",
        "cellsMax",
        "thingsMax",
        "collidersMax",
        "modelsMax",
        "groupsMax",
        "instancesMax",
        "pathBytesMax",
        "dataBytesMax",
    ]
    .iter()
    .map(|k| (*k, caps[*k].as_f64() as u64))
    .collect();
    let ours = [
        PACK_WORLD_BYTES_MAX,
        PACK_CELL_BYTES_MAX,
        PACK_CELLS_MAX,
        CELL_THINGS_MAX,
        CELL_COLLIDERS_MAX,
        CELL_MODELS_MAX,
        CELL_GROUPS_MAX,
        CELL_INSTANCES_MAX,
        PACK_PATH_BYTES_MAX,
        PACK_DATA_BYTES_MAX,
    ];
    for ((name, value), cap) in pinned_caps.iter().zip(ours) {
        assert_eq!(*value, cap as u64, "{name}");
    }
    let samples: Vec<u32> = pinned["terrainSamples"].items().iter().map(u).collect();
    assert_eq!(samples, TERRAIN_TILE_SAMPLES);
    for source in NavSource::ALL {
        assert_eq!(u(&pinned["navSources"][source.wire()]), source.bit(), "{}", source.wire());
    }
}

/// A raw cell body, written by hand so a hostile row can say exactly what the bytes hold.
#[derive(Default)]
struct Raw(Vec<u8>);

impl Raw {
    fn varint(mut self, mut n: u64) -> Raw {
        loop {
            let byte = (n & 0x7f) as u8;
            n >>= 7;
            if n == 0 {
                self.0.push(byte);
                return self;
            }
            self.0.push(byte | 0x80);
        }
    }

    fn zigzag(self, n: i32) -> Raw {
        self.varint(u64::from(((n << 1) ^ (n >> 31)) as u32))
    }

    fn f32s(mut self, values: &[f32]) -> Raw {
        for v in values {
            self.0.extend_from_slice(&v.to_le_bytes());
        }
        self
    }

    fn text(self, s: &str) -> Raw {
        self.bytes(s.as_bytes())
    }

    fn bytes(mut self, raw: &[u8]) -> Raw {
        self = self.varint(raw.len() as u64);
        self.0.extend_from_slice(raw);
        self
    }

    fn identity(self) -> Raw {
        self.f32s(&[0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0])
    }

    /// Version 1, cell (0, 0), no terrain, nav 0.
    fn head() -> Raw {
        Raw::default().varint(1).zigzag(0).zigzag(0).varint(0).varint(0)
    }

    /// Version 1, cell (0, 0) and a terrain tile; the nav field comes next.
    fn with_terrain(path: &str, samples: u64) -> Raw {
        Raw::default().varint(1).zigzag(0).zigzag(0).varint(1).text(path).varint(samples)
    }

    /// No things, colliders, models or groups, no far model.
    fn empty_tail(self) -> Raw {
        self.varint(0).varint(0).varint(0).varint(0).varint(0)
    }
}

/// One model at `path`, otherwise empty.
fn with_model(path: &[u8]) -> Vec<u8> {
    Raw::head().varint(0).varint(0).varint(1).bytes(path).identity().varint(0).varint(0).0
}

/// One thing of kind 1 with these transform floats and data bytes, otherwise empty.
fn one_thing(transform: &[f32; 10], data: &[u8]) -> Vec<u8> {
    Raw::head().varint(1).varint(1).f32s(transform).bytes(data).varint(0).varint(0).varint(0).varint(0).0
}

/// No things and one collider whose shape `shape` writes after `head`, otherwise empty.
fn one_collider(head: Raw, shape: impl FnOnce(Raw) -> Raw) -> Vec<u8> {
    shape(head.varint(0).varint(1)).identity().varint(0).varint(0).varint(0).0
}

/// `n` things of kind 1 with `{}` data, otherwise empty.
fn full_things(n: usize) -> Vec<u8> {
    let mut raw = Raw::head().varint(n as u64);
    for _ in 0..n {
        raw = raw.varint(1).identity().text("{}");
    }
    raw.varint(0).varint(0).varint(0).varint(0).0
}

/// `n` unit balls, otherwise empty.
fn full_colliders(n: usize) -> Vec<u8> {
    let mut raw = Raw::head().varint(0).varint(n as u64);
    for _ in 0..n {
        raw = raw.varint(1).f32s(&[1.0]).identity();
    }
    raw.varint(0).varint(0).varint(0).0
}

/// `n` models, otherwise empty.
fn full_models(n: usize) -> Vec<u8> {
    let mut raw = Raw::head().varint(0).varint(0).varint(n as u64);
    for _ in 0..n {
        raw = raw.text("m.glb").identity();
    }
    raw.varint(0).varint(0).0
}

/// `groups` groups of `instances` instances each, otherwise empty.
fn full_groups(groups: usize, instances: usize) -> Vec<u8> {
    let mut raw = Raw::head().varint(0).varint(0).varint(0).varint(groups as u64);
    for _ in 0..groups {
        raw = raw.text("r.glb").varint(instances as u64);
        for _ in 0..instances {
            raw = raw.identity();
        }
    }
    raw.varint(0).0
}

/// A body refused `code`, allocating at most the declared size; returns the bytes allocated.
fn refused(name: &str, entry: PackEntry, body: &[u8], code: StreamViewCode) -> u64 {
    let (result, _, bytes) = counted(|| CellPack::read(&entry, body));
    let error = result.expect_err(name);
    assert_eq!(error.code, code, "{name}: {}", error.detail);
    assert!(bytes <= u64::from(entry.bytes), "{name}: allocated {bytes} B past the declared {} B", entry.bytes);
    bytes
}

fn entry_for(body: &[u8]) -> PackEntry {
    PackEntry::of(CellId::new(0, 0), body)
}

#[test]
fn hostile_cell_bodies_are_refused_typed_with_no_allocation_past_the_declared_size() {
    let (_, cells) = shared();
    let rich = &cells[0].1;
    let rich_entry = PackEntry::of(CellId::new(-1, 0), rich);
    let invalid = StreamViewCode::PackInvalid;
    let mut report = Vec::new();
    // Truncated and overlong bodies against what world.json declares.
    report.push(("truncated", refused("truncated", rich_entry, &rich[..rich.len() - 1], invalid)));
    let mut longer = rich.clone();
    longer.push(0);
    report.push(("longer than declared", refused("longer", rich_entry, &longer, invalid)));
    // A digest mismatch: same length, one byte changed.
    let mut flipped = rich.clone();
    flipped[rich.len() / 2] ^= 0x10;
    report.push(("digest", refused("digest", rich_entry, &flipped, StreamViewCode::PackDigest)));
    // Every other row declares its own bytes and digest, so the decoder itself must refuse.
    let mut rows: Vec<(&str, Vec<u8>)> = vec![
        ("unknown version 2", Raw::default().varint(2).zigzag(0).zigzag(0).varint(0).varint(0).empty_tail().0),
        ("version 0", Raw::default().varint(0).zigzag(0).zigzag(0).varint(0).varint(0).empty_tail().0),
        ("another cell's body", Raw::default().varint(1).zigzag(3).zigzag(0).varint(0).varint(0).empty_tail().0),
        ("model path escapes", with_model(b"../secrets.glb")),
        ("model path absolute", with_model(b"/etc/passwd")),
        ("model path backslash", with_model(b"models\\rock.glb")),
        ("model path a device name", with_model(b"models/con.glb")),
        ("model path empty", with_model(b"")),
        ("model path not UTF-8", with_model(&[b'm', 0xff, b'.', b'g'])),
        ("model path over the cap", with_model(&vec![b'a'; PACK_PATH_BYTES_MAX + 1])),
        ("far path escapes", Raw::head().varint(0).varint(0).varint(0).varint(0).varint(1).text("../far.glb").0),
        ("a non-minimal varint", [0x81, 0x00].into_iter().chain(Raw::default().zigzag(0).zigzag(0).varint(0).varint(0).empty_tail().0).collect()),
        ("terrain path escapes", Raw::with_terrain("../t.r16", 65).empty_tail().0),
        ("terrain samples not a tile size", Raw::with_terrain("t/0_0.r16", 64).empty_tail().0),
        ("unknown nav source bit", Raw::default().varint(1).zigzag(0).zigzag(0).varint(0).varint(4).empty_tail().0),
        // Each over-cap row is a complete, well-formed body: only the cap refuses it.
        ("things over the cap", full_things(CELL_THINGS_MAX + 1)),
        ("things claim u32::MAX", Raw::head().varint(u64::from(u32::MAX)).0),
        ("colliders over the cap", full_colliders(CELL_COLLIDERS_MAX + 1)),
        ("models over the cap", full_models(CELL_MODELS_MAX + 1)),
        ("groups over the cap", full_groups(CELL_GROUPS_MAX + 1, 1)),
        ("instances over the cap", full_groups(2, CELL_INSTANCES_MAX / 2 + 1)),
        ("things claim more than the body holds", Raw::head().varint(40).varint(1).identity().text("{}").0),
        ("thing data over the cap", one_thing(&[0.0; 10], &vec![b' '; PACK_DATA_BYTES_MAX + 1])),
        ("a NaN transform", one_thing(&[f32::NAN; 10], b"{}")),
        ("an infinite scale", one_thing(&[0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, f32::INFINITY, 1.0], b"{}")),
        ("unknown collider shape", one_collider(Raw::head(), |r| r.varint(5))),
        ("a ball of radius 0", one_collider(Raw::head(), |r| r.varint(1).f32s(&[0.0]))),
        ("a negative cuboid", one_collider(Raw::head(), |r| r.varint(0).f32s(&[1.0, -1.0, 1.0]))),
        ("a heightfield without terrain", one_collider(Raw::head(), |r| r.varint(4).varint(0).varint(0).varint(2).varint(2))),
        (
            "a heightfield window past the tile",
            one_collider(Raw::with_terrain("t/0_0.r16", 65).varint(0), |r| r.varint(4).varint(60).varint(0).varint(8).varint(8)),
        ),
        ("an overlong varint", Raw::head().0.into_iter().chain([0x80, 0x80, 0x80, 0x80, 0x80, 0x01]).collect()),
        ("an option tag of 2", Raw::default().varint(1).zigzag(0).zigzag(0).varint(2).0),
        ("a trailing byte", Raw::head().empty_tail().0.into_iter().chain([0]).collect()),
        ("empty", Vec::new()),
    ];
    let over = PACK_CELL_BYTES_MAX + 1;
    rows.push(("over the cell byte cap", vec![0; over]));
    for (name, body) in &rows {
        report.push((name, refused(name, entry_for(body), body, invalid)));
    }
    // The controls: the same builders at the caps make valid bodies.
    let valid = with_model(b"models/rock.glb");
    assert_eq!(CellPack::read(&entry_for(&valid), &valid).expect("valid").models[0].path, "models/rock.glb");
    let at_caps = [
        full_things(CELL_THINGS_MAX),
        full_colliders(CELL_COLLIDERS_MAX),
        full_models(CELL_MODELS_MAX),
        full_groups(CELL_GROUPS_MAX, 1),
        full_groups(2, CELL_INSTANCES_MAX / 2),
    ];
    for body in &at_caps {
        CellPack::read(&entry_for(body), body).expect("a body at the caps");
    }
    for (name, bytes) in report {
        println!("refused {name}: allocated {bytes} B");
    }
}

#[test]
fn hostile_world_texts_are_refused_typed() {
    let (text, _) = shared();
    let good = String::from_utf8(text).unwrap();
    let swap = |from: &str, to: &str| {
        assert!(good.contains(from), "{from}");
        good.replacen(from, to, 1)
    };
    let fnv = &good[good.find("\"fnv\":\"").unwrap() + 7..][..16];
    let rows: Vec<(&str, String)> = vec![
        ("unknown version", swap("\"version\":1", "\"version\":2")),
        ("another format", swap("genex-cell-pack", "genex-cell-pak")),
        ("a cell size under the minimum", swap("\"cellSize\":64", "\"cellSize\":4")),
        ("a fractional cell size", swap("\"cellSize\":64", "\"cellSize\":64.5")),
        ("a cell size as text", swap("\"cellSize\":64", "\"cellSize\":\"64\"")),
        ("min past max", swap("\"min\":{\"x\":-1,\"z\":-1}", "\"min\":{\"x\":2,\"z\":-1}")),
        ("bounds past the world", swap("\"max\":{\"x\":1,\"z\":1}", "\"max\":{\"x\":200,\"z\":1}")),
        ("a listed cell outside the bounds", swap("{\"x\":-1,\"z\":0,", "{\"x\":-2,\"z\":0,")),
        ("cells out of order", swap("{\"x\":-1,\"z\":0,", "{\"x\":0,\"z\":1,")),
        ("a listed cell twice", swap("{\"x\":-1,\"z\":0,", "{\"x\":0,\"z\":0,")),
        ("a fractional cell", swap("{\"x\":-1,\"z\":0,", "{\"x\":-0.5,\"z\":0,")),
        ("zero bytes", swap("\"bytes\":604", "\"bytes\":0")),
        ("bytes over the cap", swap("\"bytes\":604", "\"bytes\":16777217")),
        ("an uppercase digest", swap(fnv, &fnv.to_uppercase())),
        ("a short digest", swap(fnv, &fnv[..15])),
        ("an unknown key", swap("\"version\":1", "\"version\":1,\"extra\":true")),
        ("an unknown cell key", swap("{\"x\":-1,\"z\":0,", "{\"x\":-1,\"z\":0,\"path\":\"../x\",")),
        ("a missing key", swap("\"version\":1,", "")),
        ("not JSON", good[..good.len() - 1].to_owned()),
        ("an array", "[]".to_owned()),
    ];
    for (name, text) in &rows {
        let error = PackWorld::read(text.as_bytes()).expect_err(name);
        assert_eq!(error.code, StreamViewCode::PackInvalid, "{name}: {}", error.detail);
    }
    // A text over the cap is refused before it is parsed: nothing near its size is allocated.
    let huge = vec![b' '; PACK_WORLD_BYTES_MAX + 1];
    let (result, _, bytes) = counted(|| PackWorld::read(&huge));
    assert_eq!(result.unwrap_err().code, StreamViewCode::PackInvalid);
    assert!(bytes < 1024, "allocated {bytes} B for an oversized world.json");
    // More cells than the cap.
    let entries: Vec<PackEntry> = (0..=PACK_CELLS_MAX as i32).map(|i| PackEntry { cell: CellId::new(i / 256, i % 256), bytes: 1, fnv: 0 }).collect();
    let error = PackWorld::new(8, CellId::new(0, 0), CellId::new(1000, 1000), entries).expect_err("over the cell cap");
    assert_eq!(error.code, StreamViewCode::PackInvalid);
}

#[test]
fn folders_and_files_must_stay_inside_assets() {
    assert_eq!(cell_file(CellId::new(-3, 12)), "cells/-3_12.cell");
    assert_eq!(pack_file("worlds/valley", "world.json").unwrap(), "worlds/valley/world.json");
    for folder in ["", "../world", "/world", "world/../..", "a//b", "world\\x", "con", "world/", "w\0"] {
        let error = pack_file(folder, "world.json").expect_err(folder);
        assert_eq!(error.code, StreamViewCode::PackInvalid, "{folder:?}");
    }
    // The writer refuses what the reader refuses: it never writes a pack the reader would not take.
    let mut pack = CellPack::empty(CellId::new(0, 0));
    pack.models.push(PackModel { path: "../x.glb".to_owned(), transform: PackTransform::IDENTITY });
    assert_eq!(pack.to_bytes().unwrap_err().code, StreamViewCode::PackInvalid);
    pack.models[0].path = "x.glb".to_owned();
    pack.nav = NavSource::Colliders.bit() | NavSource::Terrain.bit();
    let bytes = pack.to_bytes().expect("valid");
    assert_eq!(CellPack::read(&PackEntry::of(CellId::new(0, 0), &bytes), &bytes).unwrap(), pack);
}

#[test]
fn ten_thousand_truncations_and_corruptions_never_panic() {
    let (text, cells) = shared();
    let rich = &cells[0].1;
    let cell = CellId::new(-1, 0);
    let mut runs = 0u32;
    let mut accepted = 0u32;
    // Every prefix of the rich body, declared as its own size and digest: the decoder must refuse.
    for len in 0..rich.len() {
        let body = &rich[..len];
        let result = catch_unwind(AssertUnwindSafe(|| CellPack::read(&PackEntry::of(cell, body), body)));
        assert!(result.expect("no panic").is_err(), "a {len}-byte prefix decoded");
        runs += 1;
    }
    // Every prefix of world.json.
    for len in 0..text.len() {
        let result = catch_unwind(AssertUnwindSafe(|| PackWorld::read(&text[..len])));
        assert!(result.expect("no panic").is_err(), "a {len}-byte world.json prefix read");
        runs += 1;
    }
    // Seeded corruptions: 1 to 4 bytes overwritten, some cut short, declared as they are.
    let mut rng = Pcg32::seeded(24);
    while runs < 10_000 {
        let mut body = rich.clone();
        for _ in 0..=rng.below(4) {
            let at = rng.below(body.len() as u32) as usize;
            body[at] = rng.next_u32() as u8;
        }
        if rng.chance(0.25) {
            body.truncate(rng.below(body.len() as u32) as usize);
        }
        let result = catch_unwind(AssertUnwindSafe(|| CellPack::read(&PackEntry::of(cell, &body), &body)));
        if let Ok(pack) = result.expect("no panic") {
            // Whatever is accepted writes back to the same bytes.
            assert_eq!(pack.to_bytes().expect("an accepted pack writes"), body);
            accepted += 1;
        }
        runs += 1;
    }
    println!("{runs} runs, {accepted} corrupted bodies still valid (and rewritten byte for byte)");
    assert_eq!(fnv1a64(rich), PackEntry::of(cell, rich).fnv);
}
