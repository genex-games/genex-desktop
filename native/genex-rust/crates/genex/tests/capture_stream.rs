//! Settled captures drain the view set (game systems STR-25): before a capture is drawn, the
//! streamed view set updates from the captured camera until every model it wants is resident or
//! refused, so a capture right after a teleport draws what a capture after 300 frames draws. Live
//! frames never wait, and a drain stops at `STREAM_DRAIN_MAX_MS` with `stream-drain-timeout` in
//! `volatile.__stream.view`, before the host's 10 s call timeout.
//!
//! The CPU rows drive `genex::present::StreamView` and `drain_blocking` with a fake async source
//! and a fake drain clock; one row times a real drain on the wall clock. The GPU row is
//! `#[ignore]`d and its name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex \
//!     --test capture_stream -- --include-ignored

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use genex::present::{
    AssetCache, DrainClock, DrainReport, ModelSource, STREAM_DRAIN_MAX_MS, StreamView, Uploads, ViewIo, ViewLimits, WallDrainClock, drain_blocking,
};
use genex::{AssetError, AsyncSource, Camera, CellBuild, CellId, Frame, Game, Runtime, Shape, StreamBytes, StreamRequest, Streaming, Transform};
use genex_render::RenderError;
use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier, TargetOs};
use genex_render::jobs::{Pool, Priority};
use genex_render::mesh::MeshData;
use genex_render::scene::MeshId;
use genex_render::texture::{TextureData, TextureId, TextureKind};
use genex_render::timing::Clock;
use glam::{Vec2, vec2, vec3};

/// The cell side of the rows' worlds, in metres.
const CELL: f32 = 32.0;
/// The rows' view radius.
const VIEW: f32 = 64.0;
/// Polls the fake source takes to answer a read.
const READ_POLLS: u64 = 4;
/// Frames the long run draws before its capture.
const LONG_RUN_FRAMES: usize = 300;
/// The host's call timeout (`NATIVE_CALL_TIMEOUT_MS`, `src/shared/native-contract.ts`).
const NATIVE_CALL_TIMEOUT_MS: f64 = 10_000.0;
/// What the fake drain clock moves per pause, in milliseconds.
const FAKE_PAUSE_MS: f64 = 1.0;
/// Where the camera starts, and where it is teleported to (far past the view radius).
const HOME: Vec2 = Vec2::new(0.5 * CELL, 0.5 * CELL);
const AWAY: Vec2 = Vec2::new(20.5 * CELL, 12.5 * CELL);

#[derive(Default)]
struct World;

/// The model a cell draws: one per cell, so a teleport asks for models never read.
fn cell_model(cell: CellId) -> String {
    format!("cells/c{}_{}.glb", cell.x, cell.z)
}

/// A streaming game whose cells each draw their own model at their centre.
fn runtime() -> Runtime<World> {
    let mut game = Game::new(World).title("Capture stream");
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

/// A unit quad (positions, normals, indices), as a GLB.
fn quad_glb() -> Vec<u8> {
    let positions: [f32; 12] = [-1.0, 0.0, -1.0, 1.0, 0.0, -1.0, 1.0, 0.0, 1.0, -1.0, 0.0, 1.0];
    let normals: [f32; 12] = [0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0];
    let indices: [u16; 6] = [0, 2, 1, 0, 3, 2];
    let mut bin: Vec<u8> = positions.iter().chain(&normals).flat_map(|f| f.to_le_bytes()).collect();
    bin.extend(indices.iter().flat_map(|i| i.to_le_bytes()));
    bin.extend([0, 0]);
    let gltf = serde_json::json!({
        "asset": { "version": "2.0" },
        "buffers": [{ "byteLength": bin.len() }],
        "bufferViews": [
            { "buffer": 0, "byteOffset": 0, "byteLength": 48 },
            { "buffer": 0, "byteOffset": 48, "byteLength": 48 },
            { "buffer": 0, "byteOffset": 96, "byteLength": 12 },
        ],
        "accessors": [
            { "bufferView": 0, "componentType": 5126, "count": 4, "type": "VEC3", "min": [-1.0, 0.0, -1.0], "max": [1.0, 0.0, 1.0] },
            { "bufferView": 1, "componentType": 5126, "count": 4, "type": "VEC3" },
            { "bufferView": 2, "componentType": 5123, "count": 6, "type": "SCALAR" },
        ],
        "meshes": [{ "primitives": [{ "attributes": { "POSITION": 0, "NORMAL": 1 }, "indices": 2 }] }],
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

/// The rows' game files: every cell's model is the quad.
struct Files(Vec<u8>);

impl ModelSource for Files {
    fn model_bytes(&self, path: &str) -> Option<Vec<u8>> {
        path.starts_with("cells/").then(|| self.0.clone())
    }
}

/// A renderer stand-in that hands out mesh ids and frees them.
#[derive(Default)]
struct FakeRenderer {
    next: u32,
}

impl Uploads for FakeRenderer {
    fn add_mesh(&mut self, _mesh: MeshData) -> Result<MeshId, RenderError> {
        self.next += 1;
        Ok(MeshId::from_raw(100 + self.next))
    }

    fn add_texture(&mut self, _data: &TextureData, kind: TextureKind) -> Result<TextureId, RenderError> {
        Ok(TextureId::new(kind, 0))
    }

    fn remove_mesh(&mut self, _id: MeshId) -> Result<(), RenderError> {
        Ok(())
    }
}

/// An async source answering each read [`READ_POLLS`] polls after it was made, or never.
struct SlowReads {
    glb: Vec<u8>,
    polls: u64,
    next: u64,
    never: bool,
    pending: BTreeMap<u64, u64>,
}

impl SlowReads {
    fn new(never: bool) -> SlowReads {
        SlowReads { glb: quad_glb(), polls: 0, next: 0, never, pending: BTreeMap::new() }
    }
}

impl AsyncSource for SlowReads {
    fn request(&mut self, _path: &str, _range: Option<std::ops::Range<u64>>, _priority: Priority) -> StreamRequest {
        self.next += 1;
        self.pending.insert(self.next, self.polls + READ_POLLS);
        StreamRequest::from_raw(self.next)
    }

    fn cancel(&mut self, request: StreamRequest) -> bool {
        self.pending.remove(&request.raw()).is_some()
    }

    fn poll(&mut self) -> Vec<(StreamRequest, Result<StreamBytes, AssetError>)> {
        self.polls += 1;
        if self.never {
            return Vec::new();
        }
        let due: Vec<u64> = self.pending.iter().filter(|(_, at)| **at <= self.polls).map(|(id, _)| *id).collect();
        due.into_iter()
            .map(|id| {
                self.pending.remove(&id);
                (StreamRequest::from_raw(id), Ok(StreamBytes::Read(Arc::from(self.glb.clone()))))
            })
            .collect()
    }

    fn in_flight(&self) -> usize {
        self.pending.len()
    }
}

/// A drain clock that moves [`FAKE_PAUSE_MS`] per pause.
#[derive(Default)]
struct FakeDrainClock {
    now: f64,
    pauses: u32,
}

impl DrainClock for FakeDrainClock {
    fn now_ms(&mut self) -> f64 {
        self.now
    }

    fn pause(&mut self) {
        self.now += FAKE_PAUSE_MS;
        self.pauses += 1;
    }
}

struct Io {
    files: Files,
    assets: AssetCache,
    renderer: FakeRenderer,
    log: Vec<String>,
}

impl Io {
    fn new() -> Io {
        Io { files: Files(quad_glb()), assets: AssetCache::default(), renderer: FakeRenderer::default(), log: Vec::new() }
    }
}

fn camera_at(at: Vec2) -> Camera {
    Camera::look_at(vec3(at.x, 40.0, at.y - 30.0), vec3(at.x, 0.0, at.y))
}

fn view(never: bool) -> StreamView {
    let class = DeviceClass::new(FormFactor::Desktop, PerformanceTier::High);
    let mut view = StreamView::new(ViewLimits::for_class(class, TargetOs::MacOs));
    view.use_pool(Arc::new(Pool::inline()));
    view.set_source(Box::new(SlowReads::new(never)));
    view
}

fn still_clock() -> Clock {
    Arc::new(|| Duration::ZERO)
}

/// One view-set update from above `at` (a Live frame's, or a drain pass's).
fn update(view: &mut StreamView, runtime: &Runtime<World>, at: Vec2, io: &mut Io) {
    let clock = still_clock();
    let log = &mut io.log;
    let view_io = ViewIo { assets: &mut io.assets, source: &io.files, uploads: &mut io.renderer, clock: &clock, log: &mut |line| log.push(line.to_owned()) };
    view.update(runtime, &camera_at(at), view_io).expect("no device loss");
}

/// What a frame draws now, as `path @ transform` lines in draw order: the capture's digest input.
fn drawn(view: &mut StreamView) -> Vec<String> {
    let mut frame = Frame::default();
    view.draw_into(&mut frame);
    frame
        .draws()
        .iter()
        .filter_map(|draw| match &draw.shape {
            Shape::Model { model, transform, .. } => Some(format!("{} @ {:?}", model.path().unwrap_or("?"), transform.to_cols_array().map(f32::to_bits))),
            _ => None,
        })
        .collect()
}

/// A settled capture's drain of `view` from above `at`, on `clock`.
fn drain(view: &mut StreamView, runtime: &Runtime<World>, at: Vec2, io: &mut Io, clock: &mut dyn DrainClock) -> DrainReport {
    let report = drain_blocking::<()>(clock, STREAM_DRAIN_MAX_MS, || {
        update(view, runtime, at, io);
        Ok(view.settled())
    })
    .expect("drained");
    view.note_drain(report);
    report
}

#[test]
fn a_capture_right_after_a_teleport_equals_a_capture_after_300_frames() {
    // Red on the head: no drain existed, so the frame after a teleport drew the cells' models only
    // as they arrived (the undrained frame below is that capture).
    let runtime = runtime();
    let mut io = Io::new();
    let mut teleported = view(false);
    for _ in 0..30 {
        update(&mut teleported, &runtime, HOME, &mut io);
    }
    update(&mut teleported, &runtime, AWAY, &mut io);
    let undrained = drawn(&mut teleported);
    let report = drain(&mut teleported, &runtime, AWAY, &mut io, &mut FakeDrainClock::default());
    let after_teleport = drawn(&mut teleported);
    let mut long = view(false);
    for _ in 0..LONG_RUN_FRAMES {
        update(&mut long, &runtime, AWAY, &mut io);
    }
    let after_long_run = drawn(&mut long);
    assert!(!after_long_run.is_empty() && after_long_run.len() as u32 == long.stats().cells_wanted, "every wanted cell draws its model");
    assert_ne!(undrained, after_long_run, "undrained, the teleport's frame draws what has arrived (that capture's digest depended on IO)");
    assert_eq!(after_teleport, after_long_run, "drained, it draws what 300 frames draw");
    assert!(report.passes > 1 && !report.timed_out, "{report:?}");
    let volatile = teleported.stats().volatile_value();
    assert_eq!(volatile["drainPasses"].as_f64(), f64::from(report.passes));
    assert!(volatile.get("timeout").is_none(), "{volatile:?}");
    assert!(io.log.is_empty(), "{:?}", io.log);
}

#[test]
fn a_live_frame_after_a_teleport_never_waits_for_the_view_set() {
    // New behaviour row (STR-25): the drain is the capture's alone. A Live frame is one update: it
    // draws what is resident and goes on, its loads still in flight.
    let runtime = runtime();
    let mut io = Io::new();
    let mut live = view(false);
    update(&mut live, &runtime, AWAY, &mut io);
    let first = drawn(&mut live);
    let stats = live.stats();
    assert!(first.is_empty() && stats.loading_draws > 0, "the Live frame drew without waiting: {stats:?}");
    assert!(!live.settled(), "its loads are still in flight");
    assert_eq!(stats.drain, DrainReport::default(), "no drain ran");
}

#[test]
fn a_drain_past_its_cap_answers_stream_drain_timeout_before_the_host_call_timeout() {
    // New behaviour (STR-25): a source that never answers stops the drain at STREAM_DRAIN_MAX_MS.
    let runtime = runtime();
    let mut io = Io::new();
    let mut stuck = view(true);
    let mut clock = FakeDrainClock::default();
    let report = drain(&mut stuck, &runtime, AWAY, &mut io, &mut clock);
    assert!(report.timed_out, "{report:?}");
    assert!((STREAM_DRAIN_MAX_MS..STREAM_DRAIN_MAX_MS + FAKE_PAUSE_MS + 1e-9).contains(&report.ms), "{report:?}");
    assert!(report.ms < NATIVE_CALL_TIMEOUT_MS, "the capture answers inside the host's call deadline");
    assert_eq!(report.passes, clock.pauses + 1);
    let volatile = stuck.stats().volatile_value();
    assert_eq!(volatile["timeout"].as_str(), "stream-drain-timeout", "{volatile:?}");
    assert_eq!(volatile["drainTimeouts"].as_f64(), 1.0);
    // The capture is drawn with what is resident: nothing, and no checker (a wait is not a refusal).
    assert!(drawn(&mut stuck).is_empty());
    // A later drain that settles clears the timeout (a game without streamed loads settles at once).
    stuck.note_drain(DrainReport { passes: 1, ms: 0.0, timed_out: false });
    let volatile = stuck.stats().volatile_value();
    assert!(volatile.get("timeout").is_none() && volatile["drainTimeouts"].as_f64() == 1.0, "{volatile:?}");
}

/// Milliseconds a closure takes on the wall clock (a lane timing row).
#[allow(clippy::disallowed_types, reason = "a capture-deadline row reads the wall clock; nothing simulated sees it")]
fn wall_ms(work: impl FnOnce()) -> f64 {
    let start = std::time::Instant::now();
    work();
    start.elapsed().as_secs_f64() * 1000.0
}

#[test]
fn a_real_drain_that_never_settles_answers_between_its_cap_and_the_host_call_timeout() {
    // Accept (STR-25): a capture never hangs. On the wall clock a stuck drain pauses between passes
    // (the loop yields the thread) and answers after its 6 s cap, inside the host's 10 s deadline;
    // the host holds its heartbeat while a capture is owed (`native-runs.ts`), so the next beat is
    // the first request the game answers after it.
    let runtime = runtime();
    let mut io = Io::new();
    let mut stuck = view(true);
    let mut report = DrainReport::default();
    let elapsed = wall_ms(|| report = drain(&mut stuck, &runtime, AWAY, &mut io, &mut WallDrainClock::default()));
    println!("a stuck drain answered after {elapsed:.0} ms in {} passes", report.passes);
    assert!(report.timed_out);
    assert!((STREAM_DRAIN_MAX_MS..NATIVE_CALL_TIMEOUT_MS).contains(&elapsed), "{elapsed} ms");
    assert!(f64::from(report.passes) < STREAM_DRAIN_MAX_MS, "each pass paused: {} passes", report.passes);
}

#[test]
fn a_game_without_streaming_settles_at_once() {
    let mut game = Game::new(World).title("No streaming");
    game.on_draw(|_, frame, _| {
        frame.cube(Transform::IDENTITY, genex::Color::WHITE);
    });
    let runtime = Runtime::new(game).expect("valid registrations");
    let mut io = Io::new();
    let mut plain = view(false);
    let report = drain(&mut plain, &runtime, vec2(0.0, 0.0), &mut io, &mut FakeDrainClock::default());
    assert_eq!((report.passes, report.timed_out), (1, false), "one pass, nothing to wait for");
}

// Through the presenter (a GPU)

mod presenter {
    use super::{CELL, SlowReads, VIEW, cell_model, quad_glb};
    use genex::prelude::*;
    use genex::present::{Presenter, STREAM_DRAIN_MAX_MS, WallDrainClock, drain_blocking};
    use genex::{CellBuild, Runtime, Streaming, View};

    const WORLD: [u32; 2] = [320, 192];

    /// The camera's ground point: a teleport moves it.
    #[derive(Default)]
    struct Place {
        at: Vec2,
    }

    fn runtime() -> Runtime<Place> {
        let mut game = Game::new(Place::default()).title("Capture stream").world_size(WORLD[0], WORLD[1]);
        game.streaming(Streaming::grid(CELL).view_radius(VIEW));
        game.cell_content(|cell, inputs| {
            let (min, max) = inputs.bounds();
            let centre = (min + max) * 0.5;
            let transform = Transform::from_xyz(centre.x, 0.0, centre.y).with_scale(vec3(12.0, 1.0, 12.0));
            CellBuild::<()>::default().model(&inputs.model(&cell_model(cell)), transform)
        });
        game.camera(|sim| Camera::look_at(vec3(sim.world.at.x, 70.0, sim.world.at.y - 60.0), vec3(sim.world.at.x, 0.0, sim.world.at.y + 10.0)));
        game.on_draw(|_, frame, _| {
            frame.sun(vec3(0.3, 0.8, 0.2), Color::WHITE, 3.0);
        });
        let mut runtime = Runtime::new(game).expect("valid registrations");
        runtime.seed(1);
        runtime
    }

    fn table() -> genex::AssetTable {
        let glb: &'static [u8] = Box::leak(quad_glb().into_boxed_slice());
        let mut rows: Vec<(&'static str, &'static [u8])> = Vec::new();
        for x in -6..40 {
            for z in -6..30 {
                let path: &'static str = Box::leak(cell_model(genex::CellId::new(x, z)).into_boxed_str());
                rows.push((path, glb));
            }
        }
        Box::leak(rows.into_boxed_slice())
    }

    /// A settled capture as the studio draws one: drain, then the capture profile's draw, read back.
    fn capture(presenter: &mut Presenter, runtime: &mut Runtime<Place>) -> (u64, genex_render::capture::Capture) {
        let report = drain_blocking(&mut WallDrainClock::default(), STREAM_DRAIN_MAX_MS, || presenter.drain_pass(runtime, View::Game)).expect("drained");
        presenter.note_drain(report);
        assert!(!report.timed_out, "{report:?}");
        presenter.set_capturing(true);
        presenter.draw_view(runtime, View::Game).expect("game view").expect("drawn");
        presenter.set_capturing(false);
        let capture = presenter.resilient.capture().expect("capture");
        (capture.digest(), capture)
    }

    #[test]
    #[ignore = "needs a GPU: run with --ignored metal"]
    fn metal_a_capture_right_after_a_teleport_equals_a_capture_after_300_live_frames() {
        let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
        let mut presenter = match Presenter::open_with_root(WORLD, table(), None) {
            Ok(presenter) => presenter,
            Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
            Err(_) => return,
        };
        presenter.set_stream_source(Box::new(SlowReads::new(false)));
        let mut runtime = runtime();
        runtime.sim_mut().world.at = vec2(0.5 * CELL, 0.5 * CELL);
        for _ in 0..20 {
            presenter.draw_view(&mut runtime, View::Game).expect("game view").expect("drawn");
        }
        runtime.sim_mut().world.at = vec2(20.5 * CELL, 12.5 * CELL);
        let (teleported, first) = capture(&mut presenter, &mut runtime);
        for _ in 0..super::LONG_RUN_FRAMES {
            presenter.draw_view(&mut runtime, View::Game).expect("game view").expect("drawn");
        }
        let (settled, second) = capture(&mut presenter, &mut runtime);
        if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
            let _ = std::fs::create_dir_all(&dir);
            for (name, shot) in [("teleported", &first), ("after-300", &second)] {
                let path = std::path::Path::new(&dir).join(format!("capture-stream-{name}-{}x{}.bgra", shot.width(), shot.height()));
                std::fs::write(path, shot.bgra()).expect("evidence");
            }
        }
        let (pixels, _) = first.bgra().as_chunks::<4>();
        let lit = pixels.iter().filter(|pixel| pixel[..3].iter().any(|channel| *channel > 100)).count();
        assert!(lit * 10 > pixels.len(), "the teleport's capture shows its cells: {lit} lit pixels");
        assert_eq!(teleported, settled, "a capture right after a teleport equals one after 300 Live frames");
        assert_eq!(presenter.failure(), None);
    }
}
