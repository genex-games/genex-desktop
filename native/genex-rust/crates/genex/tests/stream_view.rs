//! The streamed view set in the presenter (game systems STR-16): a game that registers
//! `game.streaming` and gives its cells models (`CellBuild::model`) has them drawn with no game
//! call. The cells within the view radius build on the job pool, their models stream in under the
//! class's content pool, loads in flight, finish milliseconds and upload bytes, and leave when the
//! pool needs the room. A model still loading draws nothing and is never named a missing model; a
//! refused one draws the checker and is.
//!
//! The rows drive `genex::present::StreamView` with a fake clock, a fake renderer and a fake async
//! source; the GPU row is `#[ignore]`d and its name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex \
//!     --test stream_view -- --include-ignored

use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use genex::present::{AssetCache, ModelSource, StreamView, Uploads, ViewIo, ViewLimits, drawn_of};
use genex::{AssetError, AsyncSource, Camera, CellBuild, CellId, Frame, Game, Runtime, StreamBytes, StreamRequest, Streaming, Transform};
use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier, TargetOs};
use genex_render::jobs::{Pool, Priority};
use genex_render::mesh::MeshData;
use genex_render::scene::MeshId;
use genex_render::texture::{TextureData, TextureId, TextureKind};
use genex_render::timing::Clock;
use genex_render::{RenderCode, RenderError};
use glam::{Vec2, vec3};

/// The cell side of the rows' worlds, in metres.
const CELL: f32 = 32.0;
/// The rows' view radius: about 21 cells around the camera.
const VIEW: f32 = 64.0;
/// The fly-over's frames.
const FLY_FRAMES: usize = 600;
/// The fly-over's square of cells a side (49 cells).
const FLY_SIDE: i32 = 7;
/// What the fake renderer's clock moves per model it uploads, in milliseconds.
const UPLOAD_MS: f64 = 0.4;
/// Frames the fake async source takes to answer a read.
const READ_FRAMES: u64 = 3;
/// Frames it takes to answer a range read.
const RANGE_FRAMES: u64 = 2;
/// Models the rows' pool holds: fewer than the view wants at once, so the fly must evict.
const POOL_MODELS: u64 = 30;

#[derive(Default)]
struct World;

/// The model a cell draws: one per cell, so a fly-over keeps asking for new ones.
fn cell_model(cell: CellId) -> String {
    format!("cells/c{}_{}.glb", cell.x, cell.z)
}

/// A streaming game whose cells each draw their own model at their centre; `refused` names a cell
/// whose model is not in the game's assets.
fn runtime() -> Runtime<World> {
    let mut game = Game::new(World).title("Stream view");
    game.streaming(Streaming::grid(CELL).view_radius(VIEW));
    game.cell_content(|cell, inputs| {
        let (min, max) = inputs.bounds();
        let centre = (min + max) * 0.5;
        CellBuild::<()>::default().model(&inputs.model(&cell_model(cell)), Transform::from_xyz(centre.x, 0.0, centre.y))
    });
    let mut runtime = Runtime::new(game).expect("valid registrations");
    runtime.seed(1);
    runtime
}

/// A unit quad (positions, normals and indices; no material), as a GLB.
fn quad_glb() -> Vec<u8> {
    quad_glb_with(false)
}

/// Where the binary chunk's body starts in a GLB whose JSON chunk is `json_len` bytes.
fn bin_start(glb: &[u8]) -> u64 {
    let json_len = u32::from_le_bytes([glb[12], glb[13], glb[14], glb[15]]) as u64;
    12 + 8 + json_len + 8
}

/// [`quad_glb`], with a `genex_lods` chain of one level (one triangle) when `lods`.
fn quad_glb_with(lods: bool) -> Vec<u8> {
    let positions: [f32; 12] = [-1.0, 0.0, -1.0, 1.0, 0.0, -1.0, 1.0, 0.0, 1.0, -1.0, 0.0, 1.0];
    let normals: [f32; 12] = [0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0];
    let indices: [u16; 6] = [0, 2, 1, 0, 3, 2];
    let coarse: [u32; 3] = [0, 2, 1];
    let mut bin: Vec<u8> = positions.iter().chain(&normals).flat_map(|f| f.to_le_bytes()).collect();
    bin.extend(indices.iter().flat_map(|i| i.to_le_bytes()));
    bin.extend(coarse.iter().flat_map(|i| i.to_le_bytes()));
    let mut primitive = serde_json::json!({ "attributes": { "POSITION": 0, "NORMAL": 1 }, "indices": 2 });
    if lods {
        primitive["extras"] = serde_json::json!({ "genex_lods": { "version": 1, "indices": 3, "levels": [{ "first": 0, "count": 3, "error": 0.5 }] } });
    }
    let gltf = serde_json::json!({
        "asset": { "version": "2.0" },
        "buffers": [{ "byteLength": bin.len() }],
        "bufferViews": [
            { "buffer": 0, "byteOffset": 0, "byteLength": 48 },
            { "buffer": 0, "byteOffset": 48, "byteLength": 48 },
            { "buffer": 0, "byteOffset": 96, "byteLength": 12 },
            { "buffer": 0, "byteOffset": 108, "byteLength": 12 },
        ],
        "accessors": [
            { "bufferView": 0, "componentType": 5126, "count": 4, "type": "VEC3", "min": [-1.0, 0.0, -1.0], "max": [1.0, 0.0, 1.0] },
            { "bufferView": 1, "componentType": 5126, "count": 4, "type": "VEC3" },
            { "bufferView": 2, "componentType": 5123, "count": 6, "type": "SCALAR" },
        ],
        "meshes": [{ "primitives": [primitive] }],
        "nodes": [{ "mesh": 0 }],
        "scenes": [{ "nodes": [0] }],
        "scene": 0,
    });
    let mut json = gltf.to_string().into_bytes();
    while !json.len().is_multiple_of(4) {
        json.push(b' ');
    }
    let mut out = Vec::new();
    out.extend(b"glTF");
    out.extend(2u32.to_le_bytes());
    out.extend(((12 + 8 + json.len() + 8 + bin.len()) as u32).to_le_bytes());
    out.extend((json.len() as u32).to_le_bytes());
    out.extend(b"JSON");
    out.extend(&json);
    out.extend((bin.len() as u32).to_le_bytes());
    out.extend(b"BIN\0");
    out.extend(bin);
    out
}

/// The rows' game files: every cell's model is the quad, except the `missing` cells'.
struct Files {
    glb: Vec<u8>,
    missing: BTreeSet<String>,
    /// `genex-asset-index.json`, when the game ships one.
    index: Option<Vec<u8>>,
}

impl Files {
    fn new(missing: &[CellId]) -> Files {
        Files { glb: quad_glb(), missing: missing.iter().map(|cell| cell_model(*cell)).collect(), index: None }
    }

    /// Every cell's model is the quad with a one-level chain, and the index lists its levels
    /// coarse first, as the package step writes them (C-29).
    fn with_lods() -> Files {
        let glb = quad_glb_with(true);
        let bin = bin_start(&glb);
        let range = |offset: u64, bytes: u64| serde_json::json!({ "offset": offset, "bytes": bytes });
        let mesh = serde_json::json!({
            "triangles": 2,
            "uvDensity": null,
            "head": range(0, bin),
            "vertices": [range(bin, 96)],
            "levels": [
                { "level": 1, "triangles": 1, "error": 0.5, "ranges": [range(bin + 108, 12)] },
                { "level": 0, "triangles": 2, "error": 0, "ranges": [range(bin + 96, 12)] },
            ],
        });
        let assets: Vec<serde_json::Value> = (-8..16)
            .flat_map(|x| (-8..16).map(move |z| CellId::new(x, z)))
            .map(|cell| {
                let path = cell_model(cell);
                serde_json::json!({ "path": path, "files": [{ "path": path, "bytes": glb.len() }], "mesh": mesh })
            })
            .collect();
        let index = serde_json::to_vec(&serde_json::json!({ "version": 1, "target": "macos", "assets": assets, "groups": [] })).expect("index");
        Files { glb, missing: BTreeSet::new(), index: Some(index) }
    }
}

impl ModelSource for Files {
    fn model_bytes(&self, path: &str) -> Option<Vec<u8>> {
        if path == "genex-asset-index.json" {
            return self.index.clone();
        }
        (path.starts_with("cells/") && !self.missing.contains(path)).then(|| self.glb.clone())
    }
}

/// A fake clock in microseconds, shared by the presenter's clock and the fake renderer.
#[derive(Clone, Default)]
struct FakeTime(Arc<AtomicU64>);

impl FakeTime {
    fn advance_ms(&self, ms: f64) {
        self.0.fetch_add((ms * 1000.0) as u64, Ordering::SeqCst);
    }

    fn clock(&self) -> Clock {
        let micros = Arc::clone(&self.0);
        Arc::new(move || Duration::from_micros(micros.load(Ordering::SeqCst)))
    }
}

/// A renderer stand-in: each model it uploads costs [`UPLOAD_MS`] on the fake clock; it records the
/// meshes it holds.
struct FakeRenderer {
    time: FakeTime,
    next: u32,
    held: BTreeSet<u32>,
    removed: u32,
}

impl FakeRenderer {
    fn new(time: &FakeTime) -> FakeRenderer {
        FakeRenderer { time: time.clone(), next: 100, held: BTreeSet::new(), removed: 0 }
    }
}

impl Uploads for FakeRenderer {
    fn add_mesh(&mut self, _mesh: MeshData) -> Result<MeshId, RenderError> {
        self.time.advance_ms(UPLOAD_MS);
        self.next += 1;
        self.held.insert(self.next);
        Ok(MeshId::from_raw(self.next))
    }

    fn add_texture(&mut self, _data: &TextureData, kind: TextureKind) -> Result<TextureId, RenderError> {
        Ok(TextureId::new(kind, 0))
    }

    fn remove_mesh(&mut self, id: MeshId) -> Result<(), RenderError> {
        if !self.held.remove(&id.raw()) {
            return Err(RenderError::refused(RenderCode::MeshInvalid, "not held"));
        }
        self.removed += 1;
        Ok(())
    }
}

/// An async source answering each read [`READ_FRAMES`] polls after it was made.
struct SlowReads {
    files: Arc<Files>,
    next: u64,
    polls: u64,
    /// Polls a whole-file read takes; a range read takes [`RANGE_FRAMES`].
    whole_frames: u64,
    pending: BTreeMap<u64, (u64, String, Option<std::ops::Range<u64>>)>,
    asked: Arc<Mutex<Vec<String>>>,
}

impl SlowReads {
    fn new(files: Arc<Files>) -> SlowReads {
        SlowReads { files, next: 0, polls: 0, whole_frames: READ_FRAMES, pending: BTreeMap::new(), asked: Arc::default() }
    }
}

impl AsyncSource for SlowReads {
    fn request(&mut self, path: &str, range: Option<std::ops::Range<u64>>, priority: Priority) -> StreamRequest {
        assert_eq!(priority, Priority::Visible, "the view's priority");
        self.asked.lock().expect("asked").push(path.to_owned());
        self.next += 1;
        let frames = if range.is_some() { RANGE_FRAMES } else { self.whole_frames };
        self.pending.insert(self.next, (self.polls + frames, path.to_owned(), range));
        request_id(self.next)
    }

    fn cancel(&mut self, request: StreamRequest) -> bool {
        self.pending.remove(&request.raw()).is_some()
    }

    fn poll(&mut self) -> Vec<(StreamRequest, Result<StreamBytes, AssetError>)> {
        self.polls += 1;
        let due: Vec<u64> = self.pending.iter().filter(|(_, (at, _, _))| *at <= self.polls).map(|(id, _)| *id).collect();
        due.into_iter()
            .filter_map(|id| self.pending.remove(&id).map(|(_, path, range)| (id, path, range)))
            .map(|(id, path, range)| {
                let bytes = self.files.model_bytes(&path).and_then(|bytes| match range {
                    Some(range) => bytes.get(range.start as usize..range.end as usize).map(<[u8]>::to_vec),
                    None => Some(bytes),
                });
                let answer = match bytes {
                    Some(bytes) => Ok(StreamBytes::Read(Arc::from(bytes))),
                    None => Err(AssetError::new(genex::AssetErrorCode::Missing, format!("{path}: no such file"))),
                };
                (request_id(id), answer)
            })
            .collect()
    }

    fn in_flight(&self) -> usize {
        self.pending.len()
    }
}

/// A request id the fake source hands out, from its own counter.
fn request_id(raw: u64) -> StreamRequest {
    StreamRequest::from_raw(raw)
}

/// The camera over the ground point `at`, looking down the +z axis.
fn camera_at(at: Vec2) -> Camera {
    Camera::look_at(vec3(at.x, 40.0, at.y - 30.0), vec3(at.x, 0.0, at.y))
}

/// One frame: update the view set and draw it into an empty frame.
fn frame(view: &mut StreamView, runtime: &Runtime<World>, at: Vec2, io: &mut Io) -> Frame {
    let camera = camera_at(at);
    let clock = io.time.clock();
    let files: &Files = &io.files;
    let view_io = ViewIo { assets: &mut io.assets, source: files, uploads: &mut io.renderer, clock: &clock, log: &mut |line| io.log.push(line.to_owned()) };
    view.update(runtime, &camera, view_io).expect("no device loss");
    let mut frame = Frame::default();
    view.draw_into(&mut frame);
    frame
}

struct Io {
    time: FakeTime,
    files: Arc<Files>,
    assets: AssetCache,
    renderer: FakeRenderer,
    log: Vec<String>,
}

impl Io {
    fn new(missing: &[CellId]) -> Io {
        Io::with_files(Files::new(missing))
    }

    fn with_files(files: Files) -> Io {
        let time = FakeTime::default();
        let renderer = FakeRenderer::new(&time);
        Io { time, files: Arc::new(files), assets: AssetCache::default(), renderer, log: Vec::new() }
    }
}

/// The fly path: a serpentine over the [`FLY_SIDE`]-cell square, `frames` points.
fn fly_point(frame: usize, frames: usize) -> Vec2 {
    let side = FLY_SIDE as f32 * CELL;
    let t = frame as f32 / (frames - 1) as f32;
    let lanes = 4.0;
    let lane = (t * lanes).floor().min(lanes - 1.0);
    let along = t * lanes - lane;
    let x = if lane as i32 % 2 == 0 { along } else { 1.0 - along };
    Vec2::new(x * side, (lane + 0.5) / lanes * side)
}

/// The view set of `class` on a test pool of [`POOL_MODELS`] models, its models reserved at
/// their real size.
fn view_for(class: DeviceClass, glb_bytes: u64) -> StreamView {
    let limits = ViewLimits::for_class(class, TargetOs::MacOs).with_pool(POOL_MODELS * glb_bytes).with_estimate(glb_bytes);
    let mut view = StreamView::new(limits);
    view.use_pool(Arc::new(Pool::inline()));
    view
}

/// Fly 600 frames over 49 cells: resident bytes never pass the pool, no frame finishes more than
/// the class's budget of work, and the pool evicts as the view moves on.
fn fly(class: DeviceClass) {
    let runtime = runtime();
    let mut io = Io::new(&[]);
    let glb_bytes = io.files.glb.len() as u64;
    let mut view = view_for(class, glb_bytes);
    view.set_source(Box::new(SlowReads::new(Arc::clone(&io.files))));
    let limits = view.limits();
    let mut wanted_cells = BTreeSet::new();
    let mut most_finished = 0;
    for n in 0..FLY_FRAMES {
        let at = fly_point(n, FLY_FRAMES);
        let drawn = frame(&mut view, &runtime, at, &mut io);
        let stats = view.stats();
        assert!(
            stats.residency.resident_bytes <= limits.residency.pool_bytes,
            "frame {n}: {} resident bytes over the {}-byte pool",
            stats.residency.resident_bytes,
            limits.residency.pool_bytes
        );
        assert!(stats.finish_ms <= limits.finish_ms + 1e-9, "frame {n}: {} ms of finishing over the {} ms budget", stats.finish_ms, limits.finish_ms);
        assert!(stats.residency.in_flight <= limits.residency.loads_in_flight, "frame {n}: {} loads in flight", stats.residency.in_flight);
        let alone = stats.finished <= 1;
        assert!(alone || stats.upload_bytes <= limits.upload_bytes, "frame {n}: {} upload bytes", stats.upload_bytes);
        let missing = drawn_of(&drawn, &camera_at(at), &io.assets).missing_models;
        assert!(missing.is_empty(), "frame {n}: loading models drew the checker: {missing:?}");
        most_finished = most_finished.max(stats.finished);
        let cell = CellId::new((at.x / CELL).floor() as i32, (at.y / CELL).floor() as i32);
        wanted_cells.insert(cell);
    }
    let stats = view.stats();
    assert!(wanted_cells.len() >= 25, "the camera crossed {} cells", wanted_cells.len());
    assert!(stats.residency.evicted > 0, "the pool evicted as the view moved: {stats:?}");
    assert_eq!(io.renderer.removed as u64, stats.residency.evicted, "each evicted model's mesh left the renderer");
    assert!(most_finished >= 2, "frames finished several models when the budget allowed: {most_finished}");
    assert!(io.log.is_empty(), "nothing was refused: {:?}", io.log);
    println!(
        "fly {}-{}: evicted {} models, {} resident bytes of a {}-byte pool, most finished in a frame {most_finished}, budget {} ms",
        class.form.wire(),
        class.tier.wire(),
        stats.residency.evicted,
        stats.residency.resident_bytes,
        limits.residency.pool_bytes,
        limits.finish_ms
    );
}

#[test]
fn a_600_frame_fly_over_49_cells_holds_the_pool_and_the_finish_budget_at_desktop_high() {
    // New behaviour (STR-16): no view set existed.
    fly(DeviceClass::new(FormFactor::Desktop, PerformanceTier::High));
}

#[test]
fn a_600_frame_fly_over_49_cells_holds_the_pool_and_the_finish_budget_at_mobile_mid() {
    // The mobile-mid proxy: 1.0 ms of finishing, 4 loads in flight, the 3 MiB upload row.
    fly(DeviceClass::new(FormFactor::Mobile, PerformanceTier::Mid));
}

#[test]
fn a_loading_model_draws_nothing_and_is_not_missing_while_a_refused_one_is() {
    let runtime = runtime();
    let refused = CellId::new(1, 0);
    let mut io = Io::new(&[refused]);
    let glb_bytes = io.files.glb.len() as u64;
    let mut view = view_for(DeviceClass::new(FormFactor::Desktop, PerformanceTier::High), glb_bytes);
    view.set_source(Box::new(SlowReads::new(Arc::clone(&io.files))));
    let at = Vec2::new(16.0, 16.0);
    // Frame 1: the cells build (inline pool) and their reads go out.
    let first = frame(&mut view, &runtime, at, &mut io);
    assert_eq!(first.draws().len(), 0, "nothing is resident yet, so nothing draws");
    assert!(view.stats().loading_draws > 0, "built cells wait on their models");
    let missing = drawn_of(&first, &camera_at(at), &io.assets).missing_models;
    assert!(missing.is_empty(), "a loading model is never the checker: {missing:?}");
    // The reads answer after READ_FRAMES polls; a few frames finish them under the budget.
    let mut last = first;
    for _ in 0..12 {
        last = frame(&mut view, &runtime, at, &mut io);
    }
    let drawn = drawn_of(&last, &camera_at(at), &io.assets);
    assert_eq!(drawn.missing_models, [cell_model(refused)], "the refused model, and only it, is the checker");
    assert_eq!(view.stats().loading_draws, 0, "every other model arrived");
    let wanted = view.stats().cells_wanted as usize;
    assert_eq!(last.draws().len(), wanted, "one draw per wanted cell, the refused one as the checker");
    assert!(io.log.iter().any(|line| line.contains(&cell_model(refused))), "the refusal is logged: {:?}", io.log);
}

#[test]
fn the_view_set_s_counts_read_as_state_volatile_stream_view() {
    let runtime = runtime();
    let mut io = Io::new(&[CellId::new(1, 0)]);
    let glb_bytes = io.files.glb.len() as u64;
    let mut view = view_for(DeviceClass::new(FormFactor::Desktop, PerformanceTier::High), glb_bytes);
    let at = Vec2::new(16.0, 16.0);
    for _ in 0..8 {
        frame(&mut view, &runtime, at, &mut io);
    }
    let stats = view.stats();
    let value: serde_json::Value = serde_json::from_slice(&stats.volatile_value().dump()).expect("json");
    let wanted = u64::from(stats.cells_wanted);
    assert_eq!(value["cells"], serde_json::json!(wanted));
    assert_eq!(value["cellsBuilt"], serde_json::json!(wanted));
    assert_eq!(value["residentBytes"], serde_json::json!((wanted - 1) * glb_bytes), "every model but the refused one");
    assert_eq!(value["refused"], serde_json::json!(1));
    assert_eq!(value["loading"], serde_json::json!(0));
    for key in ["heldBytes", "inFlight", "queued", "evicted", "cellsRefused", "finished", "finishMs", "uploadBytes"] {
        assert!(value[key].is_number(), "{key}: {value}");
    }
}

#[test]
fn a_game_without_streaming_gets_no_view_set_draws() {
    let mut game = Game::new(World).title("No streaming");
    game.on_draw(|_, frame, _| {
        frame.cube(Transform::IDENTITY, genex::Color::WHITE);
    });
    let runtime = Runtime::new(game).expect("valid registrations");
    let mut io = Io::new(&[]);
    let mut view = StreamView::new(ViewLimits::for_class(DeviceClass::new(FormFactor::Desktop, PerformanceTier::High), TargetOs::MacOs));
    let camera = camera_at(Vec2::ZERO);
    let clock = io.time.clock();
    let files: &Files = &io.files;
    let io_view = ViewIo { assets: &mut io.assets, source: files, uploads: &mut io.renderer, clock: &clock, log: &mut |_| {} };
    view.update(&runtime, &camera, io_view).expect("no device loss");
    let mut frame = Frame::default();
    view.draw_into(&mut frame);
    assert_eq!(frame.draw_calls(), 0);
    assert_eq!(view.stats().cells_wanted, 0);
    assert_eq!(io.renderer.next, 100, "nothing was uploaded");
}

#[test]
fn the_cell_overlay_outlines_each_wanted_cell_in_one_batch_per_state() {
    let runtime = runtime();
    let mut io = Io::new(&[CellId::new(0, 0)]);
    let glb_bytes = io.files.glb.len() as u64;
    let mut view = view_for(DeviceClass::new(FormFactor::Desktop, PerformanceTier::High), glb_bytes);
    let at = Vec2::new(16.0, 16.0);
    for _ in 0..8 {
        frame(&mut view, &runtime, at, &mut io);
    }
    let mut overlay = Frame::default();
    overlay.cells_debug();
    view.draw_into(&mut overlay);
    let wanted = view.stats().cells_wanted as usize;
    let lines = genex::present::to_scene(&overlay, &camera_at(at), &io.assets).lines.len();
    assert_eq!(lines, wanted * 8, "four segments (eight vertices) per wanted cell");
    let model_draws = wanted;
    assert_eq!(overlay.draw_calls() as usize, model_draws + 2, "the models, then a green and a red batch (the refused cell)");
}

#[test]
fn a_new_seed_rebuilds_the_view_cells() {
    let mut runtime = runtime();
    let mut io = Io::new(&[]);
    let glb_bytes = io.files.glb.len() as u64;
    let mut view = view_for(DeviceClass::new(FormFactor::Desktop, PerformanceTier::High), glb_bytes);
    let at = Vec2::new(16.0, 16.0);
    for _ in 0..4 {
        frame(&mut view, &runtime, at, &mut io);
    }
    let before = view.stats();
    runtime.seed(2);
    let reseeded = frame(&mut view, &runtime, at, &mut io);
    assert_eq!(view.stats().cells_wanted, before.cells_wanted);
    assert_eq!(reseeded.draws().len(), before.cells_wanted as usize, "the rebuilt cells draw their resident models at once");
    assert_eq!(view.stats().residency.evicted, 0, "nothing was reloaded: the models stayed resident");
}

#[test]
fn a_view_radius_past_its_cap_is_refused_at_install() {
    let mut game = Game::new(World).title("Too far");
    game.streaming(Streaming::grid(CELL).view_radius(CELL * 65.0));
    let refused = Runtime::new(game).err().expect("refused");
    assert_eq!(refused.code().as_str(), "streaming-invalid");
    let mut game = Game::new(World).title("Not a number");
    game.streaming(Streaming::grid(CELL).view_radius(f32::NAN));
    assert_eq!(Runtime::new(game).err().expect("refused").code().as_str(), "streaming-invalid");
}

/// The model paths a frame draws, in draw order.
fn drawn_paths(frame: &Frame) -> Vec<String> {
    frame
        .draws()
        .iter()
        .filter_map(|draw| match &draw.shape {
            genex::Shape::Model { model, .. } => model.path().map(str::to_owned),
            _ => None,
        })
        .collect()
}

#[test]
fn a_cell_entering_view_draws_its_coarsest_level_until_the_whole_model_arrives_with_no_hole() {
    // New behaviour (STR-19): no view set read by range.
    let runtime = runtime();
    let mut io = Io::with_files(Files::with_lods());
    let file_bytes = io.files.glb.len() as u64;
    let mut view = StreamView::new(ViewLimits::for_class(DeviceClass::new(FormFactor::Desktop, PerformanceTier::High), TargetOs::MacOs));
    view.use_pool(Arc::new(Pool::inline()));
    let mut reads = SlowReads::new(Arc::clone(&io.files));
    reads.whole_frames = 9;
    view.set_source(Box::new(reads));
    let at = Vec2::new(16.0, 16.0);
    let mut first_drawn: BTreeMap<String, usize> = BTreeMap::new();
    let (mut coarse_frames, mut whole_frames) = (0, 0);
    for n in 0..60 {
        let drawn = frame(&mut view, &runtime, at, &mut io);
        let facts = drawn_of(&drawn, &camera_at(at), &io.assets);
        assert!(facts.missing_models.is_empty(), "frame {n}: {:?}", facts.missing_models);
        let paths = drawn_paths(&drawn);
        let wanted = view.stats().cells_wanted as usize;
        for path in &paths {
            first_drawn.entry(path.trim_end_matches(".coarse").to_owned()).or_insert(n);
        }
        let holes = first_drawn.len() - paths.len();
        assert_eq!(holes, 0, "frame {n}: a cell drawn before draws nothing now ({} of {} drawn)", paths.len(), first_drawn.len());
        if !paths.is_empty() && paths.iter().all(|path| path.ends_with(".coarse")) {
            assert_eq!(facts.triangles as usize, paths.len(), "frame {n}: each stand-in draws the coarsest level's one triangle");
            coarse_frames += 1;
        }
        if paths.len() == wanted && paths.iter().all(|path| !path.ends_with(".coarse")) {
            assert_eq!(facts.triangles as usize, 2 * wanted, "frame {n}: the whole models draw level 0's two triangles each");
            whole_frames += 1;
        }
    }
    println!("coarse-first: stand-ins alone {coarse_frames} frames, whole models {whole_frames} frames of 60; first draws {:?}", first_drawn.values().collect::<BTreeSet<_>>());
    assert!(coarse_frames >= 3, "the stand-ins drew alone for {coarse_frames} frames before the whole reads answered");
    assert!(whole_frames >= 3, "the whole models drew for {whole_frames} frames");
    let stats = view.stats();
    assert_eq!(stats.residency.held_bytes, stats.cells_wanted as u64 * file_bytes, "the stand-ins were let go once the whole models arrived");
    assert!(io.log.is_empty(), "{:?}", io.log);
}

// Through the presenter (a GPU)

mod presenter {
    use std::sync::Arc;

    use super::{CELL, Files, SlowReads, VIEW, World, cell_model, quad_glb};
    use genex::prelude::*;
    use genex::present::Presenter;
    use genex::{CellBuild, Runtime, Streaming, View};

    const WORLD: [u32; 2] = [320, 192];
    /// Frames drawn before the capture: the builds run on the process pool.
    const SETTLE_FRAMES: usize = 30;

    /// A streaming game that draws nothing itself (no `on_draw` model, no `frame.world_cells`).
    fn runtime() -> Runtime<World> {
        let mut game = Game::new(World).title("Stream view").world_size(WORLD[0], WORLD[1]);
        game.streaming(Streaming::grid(CELL).view_radius(VIEW));
        game.cell_content(|cell, inputs| {
            let (min, max) = inputs.bounds();
            let centre = (min + max) * 0.5;
            let transform = Transform::from_xyz(centre.x, 0.0, centre.y).with_scale(vec3(12.0, 1.0, 12.0));
            CellBuild::<()>::default().model(&inputs.model(&cell_model(cell)), transform)
        });
        game.camera(|_| Camera::look_at(vec3(48.0, 70.0, -30.0), vec3(48.0, 0.0, 40.0)));
        game.on_draw(|_, frame, _| {
            frame.sun(vec3(0.3, 0.8, 0.2), Color::WHITE, 3.0);
        });
        let mut runtime = Runtime::new(game).expect("valid registrations");
        runtime.seed(1);
        runtime
    }

    fn table() -> genex::AssetTable {
        table_of(quad_glb(), None)
    }

    /// Every cell's model as `glb`, and the asset index when there is one.
    fn table_of(glb: Vec<u8>, index: Option<Vec<u8>>) -> genex::AssetTable {
        let glb: &'static [u8] = Box::leak(glb.into_boxed_slice());
        let mut rows: Vec<(&'static str, &'static [u8])> = Vec::new();
        if let Some(index) = index {
            rows.push(("genex-asset-index.json", Box::leak(index.into_boxed_slice())));
        }
        for x in -4..8 {
            for z in -4..8 {
                let path: &'static str = Box::leak(cell_model(genex::CellId::new(x, z)).into_boxed_str());
                rows.push((path, glb));
            }
        }
        Box::leak(rows.into_boxed_slice())
    }

    /// A channel value only the lit quads reach: the sky and its exposure drift stay far below.
    const LIT_CHANNEL: u8 = 100;

    /// A capture's pixels covered by a cell's quad (the white ground tiles against the dark sky).
    /// Exact background equality would not do: auto exposure moves the sky's gradient as geometry
    /// arrives.
    fn lit_mask(bgra: &[u8]) -> Vec<bool> {
        let (pixels, _) = bgra.as_chunks::<4>();
        pixels.iter().map(|pixel| pixel[..3].iter().any(|channel| *channel > LIT_CHANNEL)).collect()
    }

    /// Write a capture as evidence when `GENEX_RENDER_EVIDENCE_DIR` names a folder.
    fn evidence(name: &str, bgra: &[u8]) {
        if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
            let _ = std::fs::create_dir_all(&dir);
            std::fs::write(std::path::Path::new(&dir).join(format!("{name}-{}x{}.bgra", WORLD[0], WORLD[1])), bgra).expect("evidence");
        }
    }

    #[test]
    #[ignore = "needs a GPU: run with --ignored metal"]
    fn metal_coarse_first_cells_never_leave_a_hole_while_their_whole_models_arrive() {
        // The D12-style row (STR-19): every capture from the first lit one on keeps every pixel a
        // stand-in or a whole model lit before; the stand-ins draw alone first.
        let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
        let files = Files::with_lods();
        let table = table_of(files.glb.clone(), files.index.clone());
        let mut presenter = match Presenter::open_with_root(WORLD, table, None) {
            Ok(presenter) => presenter,
            Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
            Err(_) => return,
        };
        let mut reads = SlowReads::new(Arc::new(files));
        reads.whole_frames = 9;
        presenter.set_stream_source(Box::new(reads));
        let mut runtime = runtime();
        presenter.set_capturing(true);
        let mut previous: Option<Vec<bool>> = None;
        let (mut holes_total, mut coarse_frames, mut frames) = (0usize, 0usize, 0usize);
        for n in 0..60 {
            let drawn = presenter.draw_view(&mut runtime, View::Game).expect("game view").expect("drawn");
            assert!(drawn.missing_models.is_empty(), "frame {n}: {:?}", drawn.missing_models);
            let bgra = presenter.resilient.capture().expect("capture").bgra().to_vec();
            let mask = lit_mask(&bgra);
            if let Some(before) = &previous {
                let holes = before.iter().zip(&mask).filter(|(was, is)| **was && !**is).count();
                holes_total += holes;
                if holes > 0 {
                    evidence(&format!("coarse-first-hole-{n}"), &bgra);
                }
            }
            let stats = presenter.stream_stats();
            if drawn.draw_calls > 0 && drawn.triangles == drawn.draw_calls {
                coarse_frames += 1;
                // The last capture of stand-ins alone: the most of them on screen.
                evidence("coarse-first-stand-ins", &bgra);
            }
            if mask.iter().any(|lit| *lit) {
                previous = Some(mask);
            }
            frames = n + 1;
            let settled = stats.cells_built == stats.cells_wanted && stats.loading_draws == 0 && stats.residency.in_flight == 0;
            if settled && drawn.triangles == 2 * drawn.draw_calls && n > 20 {
                evidence("coarse-first-whole", &bgra);
                break;
            }
        }
        println!("coarse-first GPU: {frames} captures, {coarse_frames} with stand-ins alone, {holes_total} hole pixels");
        assert!(coarse_frames >= 1, "the stand-ins drew alone first");
        assert_eq!(holes_total, 0, "no pixel lit by a cell went dark while its whole model arrived");
        assert_eq!(presenter.failure(), None);
    }

    #[test]
    #[ignore = "needs a GPU: run with --ignored metal"]
    fn metal_a_streaming_game_that_draws_nothing_itself_still_draws_its_cells() {
        let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
        let mut presenter = match Presenter::open_with_root(WORLD, table(), None) {
            Ok(presenter) => presenter,
            Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
            Err(_) => return,
        };
        let mut runtime = runtime();
        presenter.set_capturing(true);
        let mut drawn = None;
        for _ in 0..SETTLE_FRAMES {
            drawn = Some(presenter.draw_view(&mut runtime, View::Game).expect("game view").expect("drawn"));
            if presenter.stream_stats().loading_draws == 0 && presenter.stream_stats().cells_built == presenter.stream_stats().cells_wanted {
                break;
            }
        }
        let drawn = drawn.expect("a frame");
        let stats = presenter.stream_stats();
        assert!(stats.cells_wanted > 0 && stats.cells_built == stats.cells_wanted, "{stats:?}");
        assert_eq!(stats.loading_draws, 0, "{stats:?}");
        assert_eq!(drawn.draw_calls, stats.cells_wanted, "one draw per cell, with no game call");
        assert!(drawn.missing_models.is_empty(), "{:?}", drawn.missing_models);
        let capture = presenter.resilient.capture().expect("capture");
        let bgra = capture.bgra();
        if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
            let _ = std::fs::create_dir_all(&dir);
            std::fs::write(std::path::Path::new(&dir).join(format!("stream-view-{}x{}.bgra", WORLD[0], WORLD[1])), bgra).expect("evidence");
        }
        let (pixels, _) = bgra.as_chunks::<4>();
        let background = pixels[0];
        let lit = pixels.iter().filter(|pixel| **pixel != background).count();
        assert!(lit * 10 > bgra.len() / 4, "the cells cover more than a tenth of the picture: {lit} pixels");
        assert_eq!(presenter.failure(), None);
    }
}
