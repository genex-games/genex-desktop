//! The GLB guard in front of the `gltf` crate (game systems SF-1b): `gltf` 1.4.1 panics on
//! damaged input (gltf-rs #478 and the reader's unchecked arithmetic), and wasm aborts on a panic,
//! so every runtime GLB read (`MeshData::from_glb`, `SkinnedMeshData::from_glb`,
//! `GlbModel::from_glb`, the facade's `Assets::triangles`) is refused `mesh-invalid` before
//! `gltf` parses anything the guard has not checked.
//!
//! The hostile GLBs come from genex-core's guard rows (`tests/support/glb.rs`). The fixture table
//! holds every GLB the repository tracks to the outcome it had before the guard:
//!
//!   GENEX_GLB_OUTCOMES_UPDATE=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --test glb_guard every_fixture_glb
//!
//! rewrites `tests/fixtures/glb-guard-outcomes.json`.

// The counting allocator below implements `GlobalAlloc`, which is an unsafe trait; it only
// forwards to the system allocator and counts on the calling thread.
#![allow(unsafe_code)]

#[path = "../../genex-core/tests/support/glb.rs"]
mod glb;

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::fmt::Write as _;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};

use genex_render::RenderCode;
use genex_render::mesh::{GlbModel, MeshData};
use genex_render::skin::SkinnedMeshData;
use serde_json::{Value, json};

/// Bytes a hostile GLB may allocate above what was live before its read: its own parse, never a
/// size it declares.
const HOSTILE_ALLOCATION_CAP: usize = 1 << 20;
/// Mutated inputs the fuzz row reads (each through two loaders).
const FUZZ_CASES: usize = 10_000;

thread_local! {
    static LIVE: Cell<usize> = const { Cell::new(0) };
    static PEAK: Cell<usize> = const { Cell::new(0) };
}

/// Counts this thread's live heap bytes and their peak, so a row measures only its own reads.
struct Counting;

// SAFETY: forwards every call to the system allocator unchanged; the counters are thread-local
// cells read with `try_with`, which never allocates.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let _ = LIVE.try_with(|live| {
            live.set(live.get() + layout.size());
            let _ = PEAK.try_with(|peak| peak.set(peak.get().max(live.get())));
        });
        // SAFETY: the caller's layout, passed through.
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        let _ = LIVE.try_with(|live| live.set(live.get().saturating_sub(layout.size())));
        // SAFETY: the pointer came from `alloc` with this layout.
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

/// The peak bytes `read` allocated above what was live when it started.
fn peak_allocation(read: impl FnOnce()) -> usize {
    let base = LIVE.with(Cell::get);
    PEAK.with(|peak| peak.set(base));
    read();
    PEAK.with(Cell::get) - base
}

/// Runs `read` with the panic message silenced; `Err` when it panicked.
fn quietly<T>(read: impl FnOnce() -> T) -> std::thread::Result<T> {
    catch_unwind(AssertUnwindSafe(read))
}

/// What each runtime loader answers for `bytes`, or the panic.
fn loaders(bytes: &[u8]) -> [(&'static str, std::thread::Result<Result<(), RenderCode>>); 3] {
    [
        ("MeshData::from_glb", quietly(|| MeshData::from_glb(bytes).map(drop).map_err(|e| e.code()))),
        ("SkinnedMeshData::from_glb", quietly(|| SkinnedMeshData::from_glb(bytes).map(drop).map_err(|e| e.code()))),
        ("GlbModel::from_glb", quietly(|| GlbModel::from_glb(bytes).map(drop).map_err(|e| e.code()))),
    ]
}

#[test]
fn each_hostile_glb_is_refused_mesh_invalid_with_no_panic_and_no_declared_allocation() {
    // The cycle row runs alone below: on a build without the guard it overflows the stack.
    let rows: Vec<_> = glb::hostile().into_iter().filter(|(name, _)| !name.contains("ancestor")).collect();
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let mut failures = Vec::new();
    for (name, bytes) in rows {
        let mut answers = None;
        let peak = peak_allocation(|| answers = Some(loaders(&bytes)));
        for (loader, answer) in answers.expect("read") {
            match answer {
                Ok(Err(RenderCode::MeshInvalid)) => {}
                Ok(other) => failures.push(format!("{name}: {loader} answered {other:?}")),
                Err(_) => failures.push(format!("{name}: {loader} panicked")),
            }
        }
        if peak > HOSTILE_ALLOCATION_CAP {
            failures.push(format!("{name}: {peak} bytes allocated"));
        }
    }
    std::panic::set_hook(previous);
    assert!(failures.is_empty(), "{failures:#?}");
}

#[test]
fn a_node_that_is_its_own_ancestor_is_refused_not_walked_forever() {
    let (_, bytes) = glb::hostile().into_iter().find(|(name, _)| name.contains("ancestor")).expect("the cycle row");
    let error = MeshData::from_glb(&bytes).expect_err("a cycle");
    assert_eq!(error.code(), RenderCode::MeshInvalid, "{error}");
}

#[test]
fn a_node_listed_twice_as_a_child_at_each_of_64_levels_is_refused_not_walked_2_to_the_64_times() {
    let nodes: Vec<Value> = (0..64).map(|n| json!({"children": [n + 1, n + 1]})).chain([json!({"mesh": 0})]).collect();
    let bytes = glb::triangle().set("/nodes", Value::Array(nodes)).bytes();
    let error = MeshData::from_glb(&bytes).expect_err("a diamond chain");
    assert_eq!(error.code(), RenderCode::MeshInvalid, "{error}");
}

/// The repository root.
fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..")
}

/// Every GLB fixture the runtime loaders read in a test or an example, repository-relative.
fn fixture_glbs() -> Vec<String> {
    let folders = ["native/genex-rust/examples/showcase/game/assets", "native/genex-rust/examples/pond/assets", "tests/fixtures/asset-import", "tests/fixtures/asset-previews"];
    let mut paths: Vec<String> = folders
        .iter()
        .flat_map(|folder| std::fs::read_dir(repo().join(folder)).unwrap_or_else(|error| panic!("{folder}: {error}")).map(move |entry| (folder, entry)))
        .filter_map(|(folder, entry)| {
            let name = entry.expect("a folder entry").file_name().into_string().expect("a UTF-8 name");
            name.ends_with(".glb").then(|| format!("{folder}/{name}"))
        })
        .collect();
    paths.sort();
    paths
}

/// FNV-1a 64 over what a `Debug` writes, without building the string.
struct DebugDigest(u64);

impl std::fmt::Write for DebugDigest {
    fn write_str(&mut self, text: &str) -> std::fmt::Result {
        self.0 = genex_core::digest::fnv1a64_from(text.as_bytes(), self.0);
        Ok(())
    }
}

fn digest(value: &impl std::fmt::Debug) -> String {
    let mut digest = DebugDigest(genex_core::digest::fnv1a64(b""));
    write!(digest, "{value:?}").expect("a digest write");
    genex_core::digest::hex64(digest.0)
}

/// Each runtime loader's answer for `bytes`: the digest of what it loaded, or its refusal code.
fn outcome(bytes: &[u8]) -> Value {
    let answer = |result: Result<String, genex_render::RenderError>| match result {
        Ok(digest) => json!(digest),
        Err(error) => json!(format!("refused {}", error.code().wire())),
    };
    json!({
        "mesh": answer(MeshData::from_glb(bytes).map(|mesh| digest(&mesh))),
        "skinned": answer(SkinnedMeshData::from_glb(bytes).map(|skinned| digest(&skinned))),
        "parts": answer(GlbModel::parts_from_glb(bytes).map(|parts| digest(&parts))),
    })
}

#[test]
fn every_fixture_glb_loads_exactly_as_it_did_before_the_guard() {
    let table = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/glb-guard-outcomes.json");
    let outcomes: serde_json::Map<String, Value> = fixture_glbs()
        .into_iter()
        .map(|path| {
            let bytes = std::fs::read(repo().join(&path)).unwrap_or_else(|error| panic!("{path}: {error}"));
            (path, outcome(&bytes))
        })
        .collect();
    assert!(outcomes.len() >= 60, "{} fixture GLBs", outcomes.len());
    if std::env::var_os("GENEX_GLB_OUTCOMES_UPDATE").is_some() {
        std::fs::write(&table, serde_json::to_string_pretty(&outcomes).expect("JSON writes") + "\n").expect("the table writes");
        return;
    }
    let recorded: serde_json::Map<String, Value> = serde_json::from_slice(&std::fs::read(&table).expect("the recorded table")).expect("JSON");
    for (path, outcome) in &outcomes {
        assert_eq!(Some(outcome), recorded.get(path), "{path}");
    }
    assert_eq!(outcomes.len(), recorded.len(), "the fixture set changed: re-record with GENEX_GLB_OUTCOMES_UPDATE=1");
}

/// A deterministic xorshift64* stream: the fuzz row replays the same inputs on every run.
struct Stream(u64);

impl Stream {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
}

/// Hostile numbers a mutation writes over a JSON number.
const HOSTILE_NUMBERS: [u64; 8] = [0, 1, 3, 99, 1 << 31, (1 << 32) + 1, 1 << 62, u64::MAX];

/// The document with the `nth` number (in document order) replaced by `value`.
fn replace_number(json: &Value, nth: usize, value: u64) -> Value {
    fn walk(node: &mut Value, nth: usize, seen: &mut usize, value: u64) {
        match node {
            Value::Number(_) => {
                if *seen == nth {
                    *node = json!(value);
                }
                *seen += 1;
            }
            Value::Array(items) => items.iter_mut().for_each(|item| walk(item, nth, seen, value)),
            Value::Object(members) => members.values_mut().for_each(|member| walk(member, nth, seen, value)),
            _ => {}
        }
    }
    let mut copy = json.clone();
    walk(&mut copy, nth, &mut 0, value);
    copy
}

fn number_count(json: &Value) -> usize {
    match json {
        Value::Number(_) => 1,
        Value::Array(items) => items.iter().map(number_count).sum(),
        Value::Object(members) => members.values().map(number_count).sum(),
        _ => 0,
    }
}

/// Case `case` of the fuzz table over `source`: a truncation, a bit flip in the header and JSON
/// chunk, or a hostile number written into the JSON (the container re-sized to match).
fn mutate(source: &[u8], json: &Value, bin: &[u8], case: usize, stream: &mut Stream) -> Vec<u8> {
    match case % 3 {
        0 => source[..stream.below(source.len())].to_vec(),
        1 => {
            let json_end = 20 + u32::from_le_bytes(source[12..16].try_into().expect("a word")) as usize;
            let mut flipped = source.to_vec();
            for _ in 0..1 + stream.below(3) {
                let at = stream.below(json_end.min(flipped.len()));
                flipped[at] ^= 1 << stream.below(8);
            }
            flipped
        }
        _ => {
            let numbers = number_count(json);
            let value = HOSTILE_NUMBERS[stream.below(HOSTILE_NUMBERS.len())];
            let mutated = replace_number(json, stream.below(numbers), value);
            glb::container(serde_json::to_vec(&mutated).expect("JSON writes"), bin)
        }
    }
}

#[test]
fn ten_thousand_truncations_bit_flips_and_hostile_numbers_of_fixture_glbs_never_panic() {
    let sources = ["tests/fixtures/asset-import/lods-sphere.glb", "tests/fixtures/asset-previews/animated.glb", "native/genex-rust/examples/pond/assets/pond.glb", "native/genex-rust/examples/showcase/game/assets/part-deer-head.glb"];
    let sources: Vec<(Vec<u8>, Value, Vec<u8>)> = sources
        .iter()
        .map(|path| {
            let bytes = std::fs::read(repo().join(path)).unwrap_or_else(|error| panic!("{path}: {error}"));
            let (json, bin) = glb::split(&bytes).unwrap_or_else(|| panic!("{path} is a GLB"));
            (bytes, json, bin)
        })
        .collect();
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let mut stream = Stream(0x5f1b_9e37_79b9_7f4a);
    let mut panics = Vec::new();
    for case in 0..FUZZ_CASES {
        let (bytes, json, bin) = &sources[case % sources.len()];
        let input = mutate(bytes, json, bin, case / sources.len(), &mut stream);
        for (loader, answer) in loaders(&input).into_iter().take(2) {
            if answer.is_err() {
                panics.push(format!("case {case}: {loader}"));
            }
        }
    }
    std::panic::set_hook(previous);
    assert!(panics.is_empty(), "{} panics of {FUZZ_CASES} cases, first: {:#?}", panics.len(), &panics[..panics.len().min(12)]);
}
