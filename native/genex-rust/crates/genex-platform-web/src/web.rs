//! The wasm-bindgen exports `native/genex-rust/web/shell.html` calls (wasm32 only).
//!
//! Boot is two gates: the shell's own preflight (no `navigator.gpu`, no adapter, an adapter whose
//! limits are below WebGPU's defaults) shows the designed unsupported page before this module is
//! even fetched; [`studio_boot`] then runs genex-render's floor check on the adapter wgpu got and
//! answers the same typed `gpu-unsupported` code when it fails, so the game never starts.
//!
//! The game starts in [`studio_boot`], not when the module is instantiated: [`install`] keeps the
//! game, so the shell can fill the saves mirror from IndexedDB ([`studio_saves_preload`]) before
//! the first reset reads it. [`studio_saves_take`] and [`studio_saves_flushed`] are the shell's
//! write-behind: the files saved since, and how their IndexedDB write went.
//!
//! Before `studio_boot` the shell also hands over the game's staged assets: [`studio_assets_plan`]
//! reads the build's asset map (with the adapter's features, so one family file per texture is
//! planned) and answers the files to fetch before the first reset (the boot and sim groups), and
//! [`studio_assets_preload`] admits each fetched file (`crate::assets`). Models draw from the
//! compiled table first, then these; the sim's reads see each file's group. Streamed and named
//! files arrive while playing: [`studio_assets_wanted`] answers the fetches the game wants,
//! [`studio_assets_arrived`] admits each (a whole file or one planned range) and
//! [`studio_assets_release`] drops one again.
//!
//! Frames are drawn by genex's shared presenter (`genex::present::Presenter`), the one a native
//! run draws with, behind the [`Screen`] painter: the game's Level-3 custom GPU passes (installed
//! at `studio_boot`), its custom materials and post passes, the HUD, the per-tag triangles and the
//! frame meter, so `state()` answers `fps`, `volatile.customPasses` and `volatile.gpu` as a native
//! studio run does. The browser answers wgpu's error scopes asynchronously: a pass's scopes are
//! parked and answered on later frames, and awaited at boot (after the install and after a first
//! frame, so in-world passes are proven before anything is captured) and before every capture's
//! readback; a pass whose scope reports an error is listed `gpu-pass-invalid` and stays off. An
//! uncaptured error is logged to the console, never a panic that would end the page.
//!
//! Render settings (RQ0.7): `studio_boot` takes the page's device hints (JSON, optional; Safari
//! and Firefox expose fewer) for the device-class probe, the presenter times Live frames on the
//! page's clock, `state().volatile.render` and `renderSettings` answer as natively, and
//! [`studio_capture`] draws the game's pinned capture profile and names it in its `render` member.
//! A capture is settled as natively (RQ1.5): the presenter re-draws the held frame K times on the
//! renderer's capture-owned history (`render.settleFrames`, `historyReset`, `exposure: "instant"`),
//! so Live's temporal history (auto exposure today) is never reset by a capture, and the next
//! animation frame draws the Live picture into the world target again.
//!
//! Frames are paced at the sim rate (RQ0.12, `genex_render::pacing::FrameGate`): [`studio_frame`]
//! renders and presents only an animation frame that ran a tick (or the first, or one after a page
//! verb, which may have moved the view); every other frame encodes nothing and leaves the canvas
//! alone (WebGPU keeps its last picture), unless the canvas was resized, when the last world target
//! is presented again. A 120 or 144 Hz display therefore runs the graph once per tick;
//! [`studio_frame_tally`] answers the frames rendered and repeated. Once the device is lost (the
//! browser reset its GPU) [`studio_frame`] throws an Error whose `code` is `device-lost` (review
//! F4); the shell flushes the saves and shows its card with that code. The presenter keeps one
//! spare renderer, so a capture on other samples than Live's and the Live frame after it swap
//! renderers instead of rebuilding each from the uploads (review F5).
//!
//! [`studio_call`] answers every page verb through genex-studio's `Studio::web()` (the C++ web
//! build's `webCall` envelope and shapes, the shared ops only; `starting` until boot succeeded).
//!
//! [`studio_capture`] is async: it draws the current view (the camera or eye a `capture` or
//! `debugCamera` placed, else the game's own) into the world target, copies it
//! (through the renderer's nearest-texel present at world size, which keeps the bytes) into a
//! mappable buffer and resolves once the browser has mapped it, with top-down BGRA and its
//! FNV-1a-64 digest. The shell awaits it instead of reading the canvas in the same turn.
//!
//! Two diagnostic exports serve the web parity row: [`studio_custom_passes`] draws without the
//! game's passes (the A/B), and [`studio_pipeline_check`] creates every renderer pipeline variant
//! on the browser's device under error scopes and answers what each reported.

use crate::assets::WebAssets;
use crate::draw::AssetTable;
use crate::handle::GameHandle;
use crate::saves::{SAVES_DATABASE_PREFIX, saves_state};
use crate::selftest::{self, CaptureDigest, SelfTestPlan};
use crate::studio::{HandleGame, Held, Painter, Screen, WebSource, verb_changes_frame};
use genex::present::Presenter;
use genex::{Game, Runtime, Value, json};
use genex_core::saves::mirror::{self, MirrorError};
use genex_hud::HudPainter;
use genex_render::capture::{CAPTURE_FORMAT, Capture, check_capture_size, hex64};
use genex_render::gpu::core_instance;
use genex_render::immediate::ImmediateFrame;
use genex_render::pacing::{FrameAction, FrameGate};
use genex_render::abi::ABI_V2;
use genex_render::mesh::{MeshData, Vertex};
use genex_render::scene::{CameraDesc, Material, MeshId, scaled, translation};
use genex_render::immediate::Rect2d;
use genex_render::lights::{PointLight, SpotLight};
use genex_render::texture::{TextureData, TextureFamily, TextureKind};
use genex_render::device_class::DeviceClass;
use genex_render::post::grading::{Grading, GradingLut, GradingLutError};
use genex_render::presets::preset_quality;
use genex_render::renderer::ScenePath;
use genex_render::settings::{
    AntiAliasing, Environment, ExposureMode, Fog, Look, Quality, QualityPreset, RenderFeature, SceneFormat, ShadowFilter, ShadowFormat, TextureClass,
};
use genex_render::shaders::{self, SHADERS};
use genex_render::{CullPath, FrameRenderer, Gpu, RenderCode, RenderError, RenderOptions, UnsupportedReason, WORLD_FORMAT};
use genex_studio::Studio;
use std::cell::RefCell;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;
use web_sys::HtmlCanvasElement;

/// The shell's own refusal codes (the renderer's codes keep their own spelling).
const NOT_INSTALLED: &str = "not-installed";
const NOT_BOOTED: &str = "not-booted";
/// The side of the targets the pipeline check builds its renderers at (the smallest world).
const CHECK_SIZE: u32 = 64;
/// Point lights the RQ6 lights variant bins (with two shadowed spots).
const CHECK_LIGHTS: usize = 64;
/// The render scales the pipeline check draws at: native size, and below 1 (the upscale pipeline).
const CHECK_SCALES: [f32; 2] = [1.0, 0.5];
/// The pipeline check's injected variant: WGSL that parses but fails validation (a type error).
const INJECTED_VARIANT: &str = "injected-invalid";
const INJECTED_WGSL: &str = "@fragment fn fs_main() -> @location(0) vec4<f32> { return 1u; }";

struct Canvas {
    element: HtmlCanvasElement,
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
}

/// What the shell draws with: the screen (the shared presenter and its meters) and the canvas.
struct Graphics {
    screen: Screen,
    canvas: Option<Canvas>,
}

/// Starts the installed game: its registrations checked, the assets its resets read attached, and
/// its first reset run.
type StartGame = Box<dyn FnOnce(Box<dyn genex::AssetSource>) -> Box<dyn GameHandle>>;

struct Shell {
    name: String,
    /// The installed game until `studio_boot` starts it.
    waiting: Option<StartGame>,
    /// The started game.
    game: Option<Box<dyn GameHandle>>,
    assets: AssetTable,
    /// The staged assets: before boot the whole plan and the files fetched for it (the preloaded
    /// ones move to the game at boot), after it the plan of the streamed and named files.
    fetched: WebAssets,
    graphics: Option<Graphics>,
    /// The named camera or eye the frame is drawn from; None for the game's own.
    view: Option<String>,
    /// Draw calls the last frame made.
    draws: u32,
    /// Which animation frames render and which leave the canvas's last picture (RQ0.12).
    gate: FrameGate,
    /// Captures drawn and not read back yet: animation frames wait while one is in flight, since
    /// a Live frame drawn while it awaits its scopes or its readback would rebuild the renderer for
    /// Live's settings and overwrite the world target the capture reads.
    captures_in_flight: u32,
}

thread_local! {
    static SHELL: RefCell<Option<Shell>> = const { RefCell::new(None) };
    /// The page verbs' studio: ready once `studio_boot` succeeded.
    static STUDIO: RefCell<Studio> = RefCell::new(Studio::web());
}

/// Hand a game to the web shell under `name` (its saves database's): a game's `genex::install` in a
/// web build ([`crate::install`]), or a sample's `#[wasm_bindgen(start)]`. The game starts in
/// `studio_boot`, after the shell preloaded its saves: there its registrations are checked as
/// `genex::install` does (a refusal panics with the typed code) and its first reset runs.
pub fn install_named<W: Default + 'static>(name: &str, game: Game<W>, assets: AssetTable) {
    // A panic gives the shell one crash record, then the console text it always logged (CRASH-3).
    crate::crash::install(name);
    let start: StartGame = Box::new(move |source| {
        let runtime = Runtime::with_assets(game, source).unwrap_or_else(|error| panic!("genex::install: {error}"));
        Box::new(runtime)
    });
    let shell = Shell {
        name: name.to_owned(),
        waiting: Some(start),
        game: None,
        assets,
        fetched: WebAssets::default(),
        graphics: None,
        view: None,
        draws: 0,
        gate: FrameGate::default(),
        captures_in_flight: 0,
    };
    SHELL.with_borrow_mut(|slot| *slot = Some(shell));
}

/// The started game; `not-booted` before `studio_boot` started it.
fn started(game: &mut Option<Box<dyn GameHandle>>) -> Result<&mut dyn GameHandle, JsValue> {
    match game {
        Some(game) => Ok(game.as_mut()),
        None => Err(refusal(NOT_BOOTED, "studio_boot has not started the game")),
    }
}

/// Start the installed game once (its first reset reads the preloaded saves and `assets`, the
/// files fetched before boot); answers its world size.
fn start_game(shell: &mut Shell, assets: WebSource) -> Result<[u32; 2], JsValue> {
    if let Some(start) = shell.waiting.take() {
        shell.game = Some(start(Box::new(assets)));
    }
    Ok(started(&mut shell.game)?.world_size())
}

fn refusal(code: &str, detail: impl std::fmt::Display) -> JsValue {
    js_sys::Error::new(&format!("{code}: {detail}")).into()
}

fn render_refusal(error: &RenderError) -> JsValue {
    refusal(error.code().wire(), error)
}

/// The refusal of a frame on a lost device: an Error whose `code` is `device-lost`, which the
/// shell reads without parsing the message.
fn device_lost_refusal() -> JsValue {
    let code = RenderCode::DeviceLost.wire();
    let error = refusal(code, "the browser lost the GPU device; reload the page");
    // Setting a property on a fresh Error object cannot fail; the message still names the code.
    let _ = js_sys::Reflect::set(&error, &JsValue::from_str("code"), &JsValue::from_str(code));
    error
}

fn with_shell<T>(f: impl FnOnce(&mut Shell) -> Result<T, JsValue>) -> Result<T, JsValue> {
    SHELL.with_borrow_mut(|slot| match slot.as_mut() {
        Some(shell) => f(shell),
        None => Err(refusal(NOT_INSTALLED, "no game was installed")),
    })
}

fn graphics(shell: &mut Shell) -> Result<&mut Graphics, JsValue> {
    shell.graphics.as_mut().ok_or_else(|| refusal(NOT_BOOTED, "studio_boot has not succeeded"))
}

fn unsupported_reason(reason: &UnsupportedReason) -> Value {
    match reason {
        UnsupportedReason::NoAdapter => json!({ "reason": "no-adapter" }),
        UnsupportedReason::Backend => json!({ "reason": "backend" }),
        UnsupportedReason::NotWebGpuCompliant => json!({ "reason": "not-webgpu-compliant" }),
        UnsupportedReason::LimitBelowCore { limit } => json!({ "reason": "limit-below-core", "limit": limit }),
    }
}

/// The boot answer for a refused GPU: `{ok: false, code, reason, limit?, detail}`.
fn boot_refused(error: &RenderError) -> String {
    let mut answer = match error {
        RenderError::GpuUnsupported { reason, .. } => unsupported_reason(reason),
        RenderError::Refused { .. } => json!({}),
    };
    if let Some(object) = answer.as_object_mut() {
        object.insert("ok".to_owned(), json!(false));
        object.insert("code".to_owned(), json!(error.code().wire()));
        object.insert("detail".to_owned(), json!(error.to_string()));
    }
    answer.to_string()
}

/// A presenter's refusals and skipped models go to the browser's console.
fn log_to_console(line: &str) {
    log::warn!("genex web: {line}");
}

/// The web does not re-create a lost device in place: the page reloads instead.
fn no_reopen() -> Result<Gpu, RenderError> {
    Err(RenderError::refused(RenderCode::DeviceLost, "the web re-creates a lost device by reloading the page"))
}

/// The browser reports an error no scope caught to the console; it is logged here too and never
/// ends the page (a native run's device watch panics instead: an uncaptured error is a bug there).
fn log_uncaptured(gpu: &Gpu) {
    gpu.device.on_uncaptured_error(Arc::new(|error: wgpu::Error| log::error!("genex web: uncaptured GPU error: {error}")));
}

/// The canvas configured for live frames on `gpu`.
fn configure_canvas(gpu: &Gpu, element: HtmlCanvasElement, surface: wgpu::Surface<'static>) -> Canvas {
    let format = surface.get_capabilities(gpu.adapter()).formats.first().copied().unwrap_or(WORLD_FORMAT);
    let config = wgpu::SurfaceConfiguration {
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        format,
        width: element.width().max(1),
        height: element.height().max(1),
        present_mode: wgpu::PresentMode::Fifo,
        desired_maximum_frame_latency: 2,
        alpha_mode: wgpu::CompositeAlphaMode::Auto,
        view_formats: Vec::new(),
        color_space: wgpu::SurfaceColorSpace::default(),
    };
    surface.configure(&gpu.device, &config);
    Canvas { element, surface, config }
}

/// The page's clock for frame timing: `performance.now()` (monotonic, sub-millisecond; the
/// browser has no `Instant`), `Date.now()` only on a page without one.
fn page_clock() -> genex_render::timing::Clock {
    Arc::new(|| {
        let performance = web_sys::window().and_then(|window| window.performance());
        let ms = performance.map_or_else(js_sys::Date::now, |performance| performance.now());
        std::time::Duration::from_secs_f64((ms / 1000.0).max(0.0))
    })
}

/// The page's device hints (`studio_boot`'s JSON); None for none or unreadable ones (a phone).
fn hints_of(hints: Option<&str>) -> Option<genex::render::WebHints> {
    let value: Value = serde_json::from_str(hints?).ok()?;
    genex::render::web_hints_from_json(&value)
}

async fn open_graphics(canvas: Option<HtmlCanvasElement>, world: [u32; 2], models: WebSource) -> Result<Graphics, RenderError> {
    let no_adapter = |detail: String| RenderError::GpuUnsupported { reason: UnsupportedReason::NoAdapter, detail };
    let instance = core_instance();
    let surface = match &canvas {
        Some(element) => {
            let target = wgpu::SurfaceTarget::Canvas(element.clone());
            Some(instance.create_surface(target).map_err(|error| no_adapter(error.to_string()))?)
        }
        None => None,
    };
    let options = wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        force_fallback_adapter: false,
        compatible_surface: surface.as_ref(),
        ..Default::default()
    };
    let adapter = instance.request_adapter(&options).await.map_err(|error| no_adapter(error.to_string()))?;
    let gpu = Gpu::open(adapter).await?;
    let mut presenter = Presenter::with_gpu(gpu, world, wgpu::Features::empty(), Box::new(no_reopen), Box::new(models), log_to_console)?;
    // One spare renderer (the web has no threads, so nothing is warmed off the frame): a capture on
    // the pinned profile's samples and Live after it swap instead of rebuilding (review F5).
    presenter.set_off_thread_changes(true);
    log_uncaptured(presenter.gpu());
    let canvas = match (canvas, surface) {
        (Some(element), Some(surface)) => Some(configure_canvas(presenter.gpu(), element, surface)),
        _ => None,
    };
    Ok(Graphics { screen: Screen::new(presenter), canvas })
}

/// Await every scope `presenter`'s passes left pending and apply the answers; answers whether they
/// changed what the frame draws (a pass refused, or an in-world pass proven for the first time).
async fn settle_scopes(presenter: &mut Presenter) -> bool {
    let pending = presenter.passes.take_pending();
    if pending.is_empty() {
        return false;
    }
    let settled = pending.settle().await;
    presenter.passes.apply_settled(settled)
}

/// [`settle_scopes`] for the booted shell's presenter, without holding the shell across the wait.
async fn settle_shell_scopes() -> Result<bool, JsValue> {
    let pending = with_shell(|shell| Ok(graphics(shell)?.screen.presenter.passes.take_pending()))?;
    if pending.is_empty() {
        return Ok(false);
    }
    let settled = pending.settle().await;
    with_shell(|shell| Ok(graphics(shell)?.screen.presenter.passes.apply_settled(settled)))
}

/// Draw the current view into `graphics`' world target for `shell`'s game.
fn draw_into(graphics: &mut Graphics, game: &mut Option<Box<dyn GameHandle>>, view: Option<&str>) -> Result<u32, JsValue> {
    Ok(graphics.screen.paint(started(game)?, view))
}

/// Open the GPU through the WebGPU-core floor and, with a canvas, configure it for live frames;
/// install the game's custom passes and draw a first frame, each followed by its error scopes'
/// answers. `hints` is the page's device hints as JSON (`{maxTouchPoints, coarsePointer,
/// shortSideCssPx, deviceMemoryGb, hardwareConcurrency, uaMobile}`, each optional) for the
/// device-class probe. Resolves with JSON: `{ok: true, receipt, world}` or `{ok: false, code:
/// "gpu-unsupported", reason, limit?, detail}`; the shell shows the unsupported page for the latter.
#[wasm_bindgen]
pub async fn studio_boot(canvas: Option<HtmlCanvasElement>, hints: Option<String>) -> Result<String, JsValue> {
    // One set of fetched files serves the sim's reads (attached before its first reset) and the
    // presenter's models.
    // The preloaded files move to the game's source with their groups; the shell keeps the plan
    // of the streamed and named files for the fetches made while playing.
    let models = with_shell(|shell| {
        let fetched = std::mem::take(&mut shell.fetched);
        shell.fetched = fetched.streaming_part();
        let groups = fetched.groups();
        Ok(WebSource::new(shell.assets, fetched).with_groups(groups))
    })?;
    let world = with_shell(|shell| start_game(shell, models.clone()))?;
    let mut graphics = match open_graphics(canvas, world, models).await {
        Ok(graphics) => graphics,
        Err(error) => return Ok(boot_refused(&error)),
    };
    if let Some(hints) = hints_of(hints.as_deref()) {
        graphics.screen.presenter.set_web_hints(hints);
    }
    graphics.screen.presenter.set_clock(page_clock());
    let receipt: Value = serde_json::from_str(&graphics.screen.presenter.gpu().receipt().to_json()).unwrap_or(Value::Null);
    with_shell(|shell| {
        graphics.screen.install(started(&mut shell.game)?);
        Ok(())
    })?;
    settle_scopes(&mut graphics.screen.presenter).await;
    // A first frame proves the in-world passes' draws before anything is captured.
    with_shell(|shell| {
        shell.draws = draw_into(&mut graphics, &mut shell.game, shell.view.as_deref())?;
        Ok(())
    })?;
    settle_scopes(&mut graphics.screen.presenter).await;
    with_shell(|shell| {
        shell.graphics = Some(graphics);
        STUDIO.with_borrow_mut(Studio::mark_ready);
        Ok(json!({ "ok": true, "receipt": receipt, "world": world }).to_string())
    })
}

/// Draw the current view (a placed camera or eye, or the game's own) into the world target.
fn render_world(shell: &mut Shell) -> Result<(), JsValue> {
    let Shell { game, graphics, view, draws, .. } = shell;
    let graphics = graphics.as_mut().ok_or_else(|| refusal(NOT_BOOTED, "studio_boot has not succeeded"))?;
    *draws = draw_into(graphics, game, view.as_deref())?;
    Ok(())
}

/// One page verb (`window.__studio`): `op` with its JSON argument, answered with the JSON envelope
/// `{id:null, ok, op, result}` or `{id:null, ok:false, op, error, available?}` the C++ web build's
/// `webCall` answers. Before `studio_boot` succeeded every call is answered `starting`.
#[wasm_bindgen]
pub fn studio_call(op: &str, arg: &str) -> Result<String, JsValue> {
    let arg = genex_core::json::parse(arg.as_bytes()).unwrap_or(genex_core::json::Value::Null);
    let reply = with_shell(|shell| {
        // A verb that can move the view or change what the frame shows makes the next frame render.
        if verb_changes_frame(op, &arg) {
            shell.gate.mark_stale();
        }
        let held = shell.captures_in_flight > 0;
        let Shell { game, graphics, view, draws, .. } = shell;
        // Not booted: the studio is not ready yet, so its answer is `starting` and nothing is drawn.
        let (Some(graphics), Some(game)) = (graphics.as_mut(), game.as_mut()) else { return Ok(starting_reply()) };
        if held {
            // A capture is drawn and not read back: the verb runs, its drawing waits (`Held`).
            let mut painter = Held::new(&mut graphics.screen, *draws);
            let mut adapter = HandleGame { game: game.as_mut(), painter: &mut painter, view, draws };
            return Ok(STUDIO.with_borrow_mut(|studio| studio.call(&mut adapter, op, &arg)));
        }
        let mut adapter = HandleGame { game: game.as_mut(), painter: &mut graphics.screen, view, draws };
        Ok(STUDIO.with_borrow_mut(|studio| studio.call(&mut adapter, op, &arg)))
    })?;
    Ok(String::from_utf8_lossy(&reply).into_owned())
}

/// `webCall`'s answer before the game began: `{id:null, ok:false, op:null, error:"starting"}`.
fn starting_reply() -> Vec<u8> {
    let mut reply = genex_core::json::Value::object();
    reply.set("id", genex_core::json::Value::Null);
    reply.set("ok", genex_core::json::Value::Bool(false));
    reply.set("op", genex_core::json::Value::Null);
    reply.set("error", genex_core::json::Value::from(genex_studio::VerbRefusal::STARTING));
    reply.dump()
}

/// The canvas element's drawing-buffer size, at least 1×1.
fn canvas_size(canvas: &Canvas) -> (u32, u32) {
    (canvas.element.width().max(1), canvas.element.height().max(1))
}

/// Whether the canvas changed size since its surface was configured (a repeat frame must then
/// present the last world target again at the new size).
fn canvas_resized(graphics: &Graphics) -> bool {
    graphics.canvas.as_ref().is_some_and(|canvas| (canvas.config.width, canvas.config.height) != canvas_size(canvas))
}

fn present_to_canvas(graphics: &mut Graphics) {
    let Graphics { screen, canvas: Some(canvas) } = graphics else { return };
    let size = canvas_size(canvas);
    if (canvas.config.width, canvas.config.height) != size {
        (canvas.config.width, canvas.config.height) = size;
        canvas.surface.configure(&screen.presenter.gpu().device, &canvas.config);
    }
    let texture = match canvas.surface.get_current_texture() {
        wgpu::CurrentSurfaceTexture::Success(texture) | wgpu::CurrentSurfaceTexture::Suboptimal(texture) => texture,
        _ => return,
    };
    let view = texture.texture.create_view(&wgpu::TextureViewDescriptor::default());
    screen.presenter.present(&view, canvas.config.format, size);
    screen.presenter.gpu().queue.present(texture);
}

/// One animation frame of `frame_ms` (since the last): run the ticks it is worth; draw and present
/// when it ran one (module docs), else leave the canvas's last picture. The frame meter counts
/// every animation frame. Answers the ticks run; none while a capture is in flight (the frame
/// neither advances nor draws, and a page verb's drawing is held too ([`studio_call`]), so the
/// capture reads back the picture it drew). Throws `device-lost` once the device is lost.
#[wasm_bindgen]
pub fn studio_frame(frame_ms: f64) -> Result<u32, JsValue> {
    with_shell(|shell| {
        if shell.captures_in_flight > 0 {
            return Ok(0);
        }
        let ticks = started(&mut shell.game)?.advance_live(frame_ms);
        let action = shell.gate.frame(ticks);
        // Dynamic resolution reads display intervals, drawn or not (tickless frames are skipped).
        graphics(shell)?.screen.presenter.note_display_frame(frame_ms);
        if action == FrameAction::Render {
            render_world(shell)?;
        }
        let graphics = graphics(shell)?;
        if graphics.screen.presenter.resilient.is_lost() {
            return Err(device_lost_refusal());
        }
        graphics.screen.shown(frame_ms);
        if action == FrameAction::Render || canvas_resized(graphics) {
            present_to_canvas(graphics);
        }
        Ok(ticks)
    })
}

/// The animation frames that ran the frame graph and those that left the canvas's last picture,
/// and the frame index (rendered ticks since boot), as JSON `{rendered, repeated, frameIndex}`.
#[wasm_bindgen]
pub fn studio_frame_tally() -> Result<String, JsValue> {
    with_shell(|shell| {
        let tally = shell.gate.tally();
        Ok(json!({ "rendered": tally.rendered, "repeated": tally.repeated, "frameIndex": shell.gate.frame_index() }).to_string())
    })
}

/// Draw frames with the game's custom passes (`true`, the default) or without them. A diagnostic
/// switch for the web parity row's A/B, never something a game sees.
#[wasm_bindgen]
pub fn studio_custom_passes(enabled: bool) -> Result<(), JsValue> {
    with_shell(|shell| {
        graphics(shell)?.screen.presenter.set_custom_passes_enabled(enabled);
        Ok(())
    })
}

/// A variant's error scopes: what wgpu reported, or the renderer's own refusal.
type VariantScope = Pin<Box<dyn Future<Output = Option<String>>>>;

/// Run `build` on `gpu` inside validation and out-of-memory error scopes, as the variant `name`.
fn variant(gpu: &Gpu, name: String, build: impl FnOnce(&Gpu) -> Result<(), RenderError>) -> (String, VariantScope) {
    let memory = gpu.device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
    let validation = gpu.device.push_error_scope(wgpu::ErrorFilter::Validation);
    let refused = build(gpu).err().map(|error| error.to_string());
    let invalid = validation.pop();
    let out_of_memory = memory.pop();
    let scope = Box::pin(async move {
        let caught = invalid.await.or(out_of_memory.await).map(|error| error.to_string());
        refused.or(caught)
    });
    (name, scope)
}

/// One empty frame through a renderer with `msaa` at `scale`, on the legacy scene or (`hdr`) the
/// HDR scene with auto exposure: every pipeline it builds and the lazily built ones a frame needs
/// (the upscale below scale 1; the HDR scene's set, every tonemap and resolve variant, the exposure
/// node and the GPU-exposed background).
fn renderer_variant(gpu: &Gpu, msaa: bool, scale: f32, hdr: bool) -> Result<(), RenderError> {
    let mut renderer = FrameRenderer::new(gpu, CHECK_SIZE, CHECK_SIZE, RenderOptions { msaa })?;
    renderer.renderer_mut().set_render_scale(scale);
    if hdr {
        let mut quality = Quality::off();
        (quality.hdr, quality.tonemap, quality.exposure) = (true, true, true);
        let mut look = Look::default();
        look.exposure = ExposureMode::Auto;
        renderer.renderer_mut().set_quality(&quality);
        renderer.renderer_mut().set_look(look);
        renderer.renderer_mut().set_scene_format(SceneFormat::Rgba16Float);
    }
    let frame = ImmediateFrame::new(CameraDesc::look_at([0.0, 2.0, 6.0], [0.0, 0.0, 0.0]), [0, 0, 0, 255]);
    renderer.render(gpu, &frame, CullPath::Gpu, None).map(drop)
}

/// A Level-2 v2 material shaded by the renderer's lighting: its pipeline takes the sun chunk's
/// shadow constants.
const SHADED_V2_CHECK: &str = "
@fragment
fn fs_material(in: GxMaterialInV2) -> @location(0) vec4<f32> {
    let s = gx_surface_v2(in.world_position, in.normal, in.tint.rgb, 0.0, 0.5);
    return vec4<f32>(gx_shade_pbr(s), 1.0);
}
";

/// The shadow layouts the check draws: one 16-bit cascade (low and the phones) and four 32-bit
/// ones (desktop high and ultra), small maps.
const CHECK_SHADOW_LAYOUTS: [(u8, ShadowFormat); 2] = [(1, ShadowFormat::Depth16), (4, ShadowFormat::Depth32)];

/// One shadowed frame on the HDR scene with `filter` over `cascades` maps of `format`: the
/// casters into that format (unclipped depth where the browser has `depth-clip-control`, the
/// fragment pancake otherwise), the forward pipelines with that `GX_SHADOW_FILTER` (PCSS's
/// `textureLoad`, PCF5's `textureGatherCompare` on a depth array) and a v2 material's pipeline
/// built with the same constants.
fn shadow_variant(gpu: &Gpu, filter: ShadowFilter, cascades: u8, format: ShadowFormat) -> Result<(), RenderError> {
    let mut renderer = FrameRenderer::new(gpu, CHECK_SIZE, CHECK_SIZE, RenderOptions { msaa: true })?;
    let mut quality = Quality::off();
    (quality.hdr, quality.tonemap, quality.exposure) = (true, true, true);
    quality.shadows.filter = filter;
    quality.shadows.cascades = cascades;
    quality.shadows.map_size = 512;
    quality.shadows.format = format;
    quality.shadows.blend_percent = 10;
    quality.shadows.fade_percent = 10;
    renderer.renderer_mut().set_quality(&quality);
    renderer.renderer_mut().set_scene_format(SceneFormat::Rgba16Float);
    let material = renderer.add_material_api(gpu, ABI_V2, SHADED_V2_CHECK, &[], &[])?;
    let mut frame = ImmediateFrame::new(CameraDesc::look_at([0.0, 2.0, 6.0], [0.0, 0.0, 0.0]), [0, 0, 0, 255]);
    frame.cube(translation(0.0, 0.5, 0.0), [200, 60, 50, 255]);
    frame.custom(MeshId::CUBE, scaled([0.0, -0.05, 0.0], [8.0, 0.1, 8.0]), material, [200, 200, 200, 255]);
    renderer.render(gpu, &frame, CullPath::Gpu, None).map(drop)
}

/// The presets whose RQ4 screen effects the check draws, by device class: medium and high on a
/// mid desktop (half-resolution AO, without and with its history and bent normals, contact
/// shadows, bloom), ultra on a high desktop (full-resolution AO) and medium on a high phone.
const CHECK_EFFECT_PRESETS: [(QualityPreset, &str); 4] =
    [(QualityPreset::Medium, "desktop-mid"), (QualityPreset::High, "desktop-mid"), (QualityPreset::Ultra, "desktop-high"), (QualityPreset::Medium, "mobile-high")];

/// Two frames of `preset` on `class` under the physical sky with the look's fog thickened (density
/// above 0): the prepass and its `Equal` twin, GTAO's view-depth chain, horizon search, denoise,
/// temporal blend and joint-bilateral upsample, the contact-shadow march and its upsample, the
/// bloom chain, the sky LUTs and the aerial-perspective volume, the forward pipelines with the
/// screen-effect constants, and a v2 material binding the effects (AO, contact mask, aerial
/// volume). The second frame takes AO's history path.
fn effects_variant(gpu: &Gpu, preset: QualityPreset, class: DeviceClass) -> Result<(), RenderError> {
    effects_at(gpu, preset, class, 1.0, None).map(drop)
}

/// The graded variants (renderer pass 2 A.2): desktop-high's medium and the low phone's own preset
/// with the look's parametric grading and an identity 17³ LUT, so the tonemap's `GX_GRADING`
/// pipelines and their 3D LUT binding are created on the browser's device (the phone's LUT side is
/// capped at 16).
const CHECK_GRADING_PRESETS: [(QualityPreset, &str, &str); 2] =
    [(QualityPreset::Medium, "desktop-high", "grading-desktop"), (QualityPreset::Low, "mobile-low", "grading-mobile-low-class")];

/// The identity LUT's side the graded variants draw.
const CHECK_GRADING_LUT_SIDE: u32 = 17;
/// The graded variants' contrast (the showcase grade's).
const CHECK_GRADING_CONTRAST: f32 = 1.15;

/// [`effects_variant`] under the check's grading.
fn grading_variant(gpu: &Gpu, preset: QualityPreset, class: DeviceClass) -> Result<(), RenderError> {
    let refused = |error: GradingLutError| RenderError::refused(RenderCode::DeviceFailed, error.to_string());
    let lut = GradingLut::identity(CHECK_GRADING_LUT_SIDE).and_then(GradingLut::intern).map_err(refused)?;
    effects_at(gpu, preset, class, 1.0, Some(Grading::NEUTRAL.with_contrast(CHECK_GRADING_CONTRAST).with_lut(lut, 1.0))).map(drop)
}

/// The upscaler a below-scale-1 variant must draw.
#[derive(Clone, Copy, Debug)]
enum CheckUpscaler {
    /// FSR1: EASU then RCAS (the MSAA presets).
    Fsr1,
    /// TAAU (renderer pass 2 B.8): the temporal presets reconstruct to output size in the TAA
    /// resolve, with no EASU after it.
    Taau,
}

impl CheckUpscaler {
    /// Whether the frame drawn along `path` took this upscaler.
    fn drew(self, path: &ScenePath) -> bool {
        match self {
            CheckUpscaler::Fsr1 => path.fsr.easu && path.fsr.rcas && !path.taau,
            CheckUpscaler::Taau => path.taau && !path.fsr.easu,
        }
    }
}

/// The presets the check draws below scale 1 (RQ5 review, B.8): the high phone's medium at its
/// nominal 0.75 (EASU and RCAS after MSAA, the iPhone class's default) and the high desktop's high
/// at its lowest dynamic-resolution step (TAAU), so FSR1's pipelines with their `rgb10a2unorm`
/// intermediates and TAAU's output-size history are created on the browser's device.
const CHECK_UPSCALE_PRESETS: [(QualityPreset, &str, f32, CheckUpscaler); 2] =
    [(QualityPreset::Medium, "mobile-high", 0.75, CheckUpscaler::Fsr1), (QualityPreset::High, "desktop-high", 0.67, CheckUpscaler::Taau)];

/// [`effects_variant`] at render `scale`; an error when `upscaler` did not draw the frame.
fn upscale_variant(gpu: &Gpu, preset: QualityPreset, class: DeviceClass, scale: f32, upscaler: CheckUpscaler) -> Result<(), RenderError> {
    let path = effects_at(gpu, preset, class, scale, None)?;
    if path.is_some_and(|path| upscaler.drew(&path)) {
        return Ok(());
    }
    Err(RenderError::refused(RenderCode::DeviceFailed, format!("{upscaler:?} did not upscale at scale {scale}: {path:?}")))
}

/// Two frames of `preset` on `class` at render `scale`; the scene path the last one took.
fn effects_at(gpu: &Gpu, preset: QualityPreset, class: DeviceClass, scale: f32, grading: Option<Grading>) -> Result<Option<ScenePath>, RenderError> {
    let quality = preset_quality(preset, class);
    let msaa = genex_render::renderer::landed_samples(quality.anti_aliasing) > 1;
    let mut renderer = FrameRenderer::new(gpu, CHECK_SIZE, CHECK_SIZE, RenderOptions { msaa })?;
    let part1 = renderer.renderer_mut();
    part1.set_scene_format(SceneFormat::Rgba16Float);
    part1.set_device_class(class);
    part1.set_quality(&quality);
    part1.set_render_scale(scale);
    let fogged = part1.look().with_fog(Fog::default().with_density(0.02).with_height(0.3, 0.0));
    part1.set_look(grading.map_or(fogged, |grading| fogged.with_grading(grading)));
    part1.set_environment(&Environment::sky());
    let material = renderer.add_material_api(gpu, ABI_V2, SHADED_V2_CHECK, &[], &[])?;
    let mut frame = ImmediateFrame::new(CameraDesc::look_at([0.0, 2.0, 6.0], [0.0, 0.0, 0.0]), [0, 0, 0, 255]);
    frame.cube(translation(0.0, 0.5, 0.0), [200, 60, 50, 255]);
    frame.custom(MeshId::CUBE, scaled([0.0, -0.05, 0.0], [8.0, 0.1, 8.0]), material, [200, 200, 200, 255]);
    for tick in 1..=2 {
        frame.set_tick(tick);
        renderer.render(gpu, &frame, CullPath::Gpu, None)?;
    }
    Ok(renderer.renderer().last_scene())
}

/// Quads per side of the check's dense mesh: 48 x 48 quads, 4608 triangles, past the meshlet
/// threshold (2048), so it is clustered.
const CHECK_GRID_QUADS: u32 = 48;

/// A flat grid of `CHECK_GRID_QUADS` squared quads facing +z, one unit wide.
fn dense_grid() -> MeshData {
    let side = CHECK_GRID_QUADS + 1;
    let mut mesh = MeshData::default();
    for y in 0..side {
        for x in 0..side {
            let (u, v) = (x as f32 / CHECK_GRID_QUADS as f32, y as f32 / CHECK_GRID_QUADS as f32);
            mesh.vertices.push(Vertex { position: [u - 0.5, v - 0.5, 0.0], normal: [0.0, 0.0, 1.0], uv: [u, 1.0 - v], tangent: [1.0, 0.0, 0.0, 1.0] });
        }
    }
    for y in 0..CHECK_GRID_QUADS {
        for x in 0..CHECK_GRID_QUADS {
            let a = y * side + x;
            mesh.indices.extend([a, a + 1, a + side, a + 1, a + side + 1, a + side]);
        }
    }
    mesh
}

/// R2 review: the meshlet path on the browser's device, which no other variant reaches. A mesh past
/// the clustering threshold, in front of a wall and casting shadows, with meshlets on and
/// (`occlusion`) two-pass Hi-Z occlusion over a one-sample world pass (where occlusion runs): the
/// cull's mark, scan and scatter pipelines, the meshlet draw, prepass and shadow-caster pipelines,
/// the compacted index buffer's `draw_indexed_indirect` and (with occlusion) the Hi-Z build over
/// `r32float` storage mips. Two frames, so the second reads the first's visibility history.
fn meshlet_variant(gpu: &Gpu, occlusion: bool) -> Result<(), RenderError> {
    let class = DeviceClass::from_wire("desktop-mid").ok_or_else(|| RenderError::refused(RenderCode::DeviceFailed, "no desktop-mid class"))?;
    let mut quality = preset_quality(QualityPreset::High, class);
    if occlusion {
        quality.anti_aliasing = AntiAliasing::Off;
    }
    quality.set_feature(RenderFeature::Meshlets, true);
    quality.set_feature(RenderFeature::Occlusion, occlusion);
    let msaa = genex_render::renderer::landed_samples(quality.anti_aliasing) > 1;
    let mut renderer = FrameRenderer::new(gpu, CHECK_SIZE, CHECK_SIZE, RenderOptions { msaa })?;
    let part1 = renderer.renderer_mut();
    part1.set_scene_format(SceneFormat::Rgba16Float);
    part1.set_device_class(class);
    part1.set_quality(&quality);
    let grid = renderer.add_mesh(gpu, dense_grid())?;
    let mut frame = ImmediateFrame::new(CameraDesc::look_at([0.0, 2.0, 6.0], [0.0, 0.0, 0.0]), [0, 0, 0, 255]);
    frame.cube(scaled([0.0, 0.5, 1.5], [1.0, 1.0, 0.2]), [200, 60, 50, 255]);
    frame.mesh(grid, scaled([0.0, 0.8, 0.0], [3.0, 1.6, 1.0]), Material::color([80, 160, 90, 255]));
    frame.cube(scaled([0.0, -0.05, 0.0], [8.0, 0.1, 8.0]), [200, 200, 200, 255]);
    for tick in 1..=2 {
        frame.set_tick(tick);
        renderer.render(gpu, &frame, CullPath::Gpu, None)?;
    }
    let drawn = renderer.renderer_mut().last_stats();
    if drawn.meshlet_draws == 0 || drawn.occlusion != occlusion {
        return Err(RenderError::refused(RenderCode::DeviceFailed, format!("the meshlet path did not draw as asked: {drawn:?}")));
    }
    Ok(())
}

/// The binned local lights of RQ6 on the browser's device (`hdr`: the HDR scene, else the legacy
/// LDR scene, which bins too): desktop-high's high preset with 64 point lights and two shadowed
/// spots over a floor and a caster, two frames. Graph node 4 (its 2D dispatch and
/// `num_workgroups`), the spot casters' pipelines and the forward pass's binned walk with spot
/// shadows all run; an error when the spots did not draw their atlas.
fn lights_variant(gpu: &Gpu, hdr: bool) -> Result<(), RenderError> {
    let class = DeviceClass::from_wire("desktop-high").ok_or_else(|| RenderError::refused(RenderCode::DeviceFailed, "no desktop-high class"))?;
    let mut quality = preset_quality(QualityPreset::High, class);
    quality.hdr = hdr;
    let msaa = genex_render::renderer::landed_samples(quality.anti_aliasing) > 1;
    let mut renderer = FrameRenderer::new(gpu, CHECK_SIZE, CHECK_SIZE, RenderOptions { msaa })?;
    let part1 = renderer.renderer_mut();
    part1.set_scene_format(SceneFormat::Rgba16Float);
    part1.set_device_class(class);
    part1.set_quality(&quality);
    let mut frame = ImmediateFrame::new(CameraDesc::look_at([0.0, 4.0, 8.0], [0.0, 0.0, 0.0]), [0, 0, 0, 255]);
    let lighting = frame.lighting_mut();
    for i in 0..CHECK_LIGHTS {
        let (x, z) = ((i % 8) as f32 - 3.5, (i / 8) as f32 - 3.5);
        lighting.points.push(PointLight { position: [x, 0.6, z], range: 1.5, color: [255, 180, 120], intensity: 2.0 });
    }
    for x in [-1.5, 1.5] {
        let spot = SpotLight {
            position: [x, 3.0, 0.0],
            direction: [0.0, -1.0, 0.0],
            range: 6.0,
            color: [255, 255, 255],
            intensity: 8.0,
            inner_angle: 0.4,
            outer_angle: 0.6,
            shadow: true,
        };
        lighting.spots.push(spot);
    }
    frame.cube(scaled([0.0, 0.5, 0.0], [0.6, 1.0, 0.6]), [200, 60, 50, 255]);
    frame.cube(scaled([0.0, -0.05, 0.0], [10.0, 0.1, 10.0]), [200, 200, 200, 255]);
    for tick in 1..=2 {
        frame.set_tick(tick);
        renderer.render(gpu, &frame, CullPath::Gpu, None)?;
    }
    if !renderer.renderer_mut().uses_shadowed_spots() {
        return Err(RenderError::refused(RenderCode::DeviceFailed, "the shadowed spots drew no atlas"));
    }
    Ok(())
}

/// Texture quality on the browser's device: desktop-high's high preset (size classes up to 2048,
/// Toksvig mips), a 1024 colour texture and a 1024 normal map on a cube, a 512 sprite through the
/// immediate quads, one frame. The forward pipelines with `GX_TEXTURE_CLASSES` and `GX_TOKSVIG`,
/// and the quads' class arrays, are created; an error when the textures stayed in class 0.
fn textures_variant(gpu: &Gpu) -> Result<(), RenderError> {
    let class = DeviceClass::from_wire("desktop-high").ok_or_else(|| RenderError::refused(RenderCode::DeviceFailed, "no desktop-high class"))?;
    let quality = preset_quality(QualityPreset::High, class);
    let msaa = genex_render::renderer::landed_samples(quality.anti_aliasing) > 1;
    let mut renderer = FrameRenderer::new(gpu, CHECK_SIZE, CHECK_SIZE, RenderOptions { msaa })?;
    let part1 = renderer.renderer_mut();
    part1.set_scene_format(SceneFormat::Rgba16Float);
    part1.set_device_class(class);
    part1.set_quality(&quality);
    let checker = |side: u32, a: [u8; 4], b: [u8; 4]| {
        let rgba = (0..side * side).flat_map(|i| if ((i % side) / 8 + (i / side) / 8).is_multiple_of(2) { a } else { b }).collect();
        TextureData::rgba8(side, side, rgba)
    };
    let color = renderer.add_texture(gpu, &checker(1024, [220, 200, 160, 255], [60, 50, 40, 255])?, TextureKind::Color)?;
    let normal = renderer.add_texture(gpu, &checker(1024, [160, 128, 230, 255], [96, 128, 230, 255])?, TextureKind::Normal)?;
    let sprite = renderer.add_texture(gpu, &checker(512, [255, 255, 255, 255], [0, 0, 0, 255])?, TextureKind::Color)?;
    if color.class() == TextureClass::S256 || normal.class() == TextureClass::S256 || sprite.class() == TextureClass::S256 {
        return Err(RenderError::refused(RenderCode::DeviceFailed, "texture quality kept the textures in class 0"));
    }
    let mut frame = ImmediateFrame::new(CameraDesc::look_at([0.0, 2.0, 4.0], [0.0, 0.0, 0.0]), [0, 0, 0, 255]);
    frame.mesh(MeshId::CUBE, scaled([0.0, 0.5, 0.0], [1.5, 1.5, 1.5]), Material::color([255, 255, 255, 255]).with_base_texture(color).with_normal_map(normal, 1.0));
    frame.sprite(sprite, Rect2d { x: 8.0, y: 8.0, w: 32.0, h: 32.0 }, [255, 255, 255, 255]);
    renderer.render(gpu, &frame, CullPath::Gpu, None).map(drop)
}

/// The terrain's pipelines (renderer pass 2 A.7) at `preset` on desktop-high: a small rolling
/// height field with a flat and a textured layer, two frames (the casters, the prepass with motion
/// on a TAA preset, the world pass's `Equal` or MSAA variant). With `grass` the flat layer grows a
/// meadow (A.8): the grass's generation passes, its prepass, motion prepass and world pass, and on
/// high its cascade casters.
fn terrain_variant(gpu: &Gpu, preset: QualityPreset, grass: bool) -> Result<(), RenderError> {
    use genex_render::terrain::{ControlTexel, Heightfield, TerrainDesc, TerrainLayer};
    let class = DeviceClass::from_wire("desktop-high").ok_or_else(|| RenderError::refused(RenderCode::DeviceFailed, "no desktop-high class"))?;
    let quality = preset_quality(preset, class);
    let msaa = genex_render::renderer::landed_samples(quality.anti_aliasing) > 1;
    let mut renderer = FrameRenderer::new(gpu, CHECK_SIZE, CHECK_SIZE, RenderOptions { msaa })?;
    let part1 = renderer.renderer_mut();
    part1.set_scene_format(SceneFormat::Rgba16Float);
    part1.set_device_class(class);
    part1.set_quality(&quality);
    let heights = Heightfield::from_fn((65, 65), [-16.0, -16.0], 0.5, |x, z| 0.8 * ((x * 0.4).floor() - (z * 0.3).floor()).abs().min(3.0))?;
    let texture = TextureData::rgba8(4, 4, vec![128; 64])?;
    let albedo = renderer.add_texture(gpu, &texture, TextureKind::Color)?;
    let data = renderer.add_texture(gpu, &texture, TextureKind::Data)?;
    let meadow = TerrainLayer::flat([0.2, 0.3, 0.1]);
    let meadow = if grass { meadow.with_grass(genex_render::foliage::GrassLayer::meadow(1.0, 0.4)) } else { meadow };
    let layers = vec![meadow, TerrainLayer::textured(Some(albedo), Some(data), 2.0)];
    let control = (0..65 * 65).map(|i| ControlTexel::blend(0, 1, (i % 255) as u8)).collect();
    let desc = TerrainDesc { heights, control, layers, look: Default::default() };
    renderer.renderer_mut().set_terrain(gpu, Some((&desc, 1)))?;
    let mut frame = ImmediateFrame::new(CameraDesc::look_at([0.0, 4.0, 8.0], [0.0, 0.0, 0.0]), [0, 0, 0, 255]);
    for tick in 1..=2 {
        frame.set_tick(tick);
        renderer.render(gpu, &frame, CullPath::Gpu, None)?;
    }
    match renderer.renderer().terrain_stats() {
        Some(stats) if stats.camera_rows > 0 => {}
        _ => return Err(RenderError::refused(RenderCode::DeviceFailed, "the terrain drew no row")),
    }
    if grass && renderer.renderer().grass_stats().is_none() {
        return Err(RenderError::refused(RenderCode::DeviceFailed, "the meadow drew no grass"));
    }
    Ok(())
}

/// The look's lens (renderer pass 2 A.9, graph nodes 17a and 17b) on desktop-high's high under TAA:
/// depth of field and motion blur at the preset's tiers (the ring gather and the reconstruction,
/// `ring`) or at the other ones (the circular gather and the direct blur), two frames with the
/// camera moving, so the nodes' pipelines (the reconstruction's block reduction a compute pass over
/// an `r32uint` storage texture) are created on the browser's device.
fn lens_variant(gpu: &Gpu, ring: bool) -> Result<(), RenderError> {
    use genex_render::post::dof::{DepthOfField, DofTier};
    use genex_render::post::motion_blur::{MotionBlur, MotionBlurTier};
    let class = DeviceClass::from_wire("desktop-high").ok_or_else(|| RenderError::refused(RenderCode::DeviceFailed, "no desktop-high class"))?;
    let mut quality = preset_quality(QualityPreset::High, class);
    if !ring {
        quality.dof = DofTier::Circular;
        quality.motion_blur = MotionBlurTier::Direct;
    }
    let msaa = genex_render::renderer::landed_samples(quality.anti_aliasing) > 1;
    let mut renderer = FrameRenderer::new(gpu, CHECK_SIZE, CHECK_SIZE, RenderOptions { msaa })?;
    let part1 = renderer.renderer_mut();
    part1.set_scene_format(SceneFormat::Rgba16Float);
    part1.set_device_class(class);
    part1.set_quality(&quality);
    let look = part1.look().with_depth_of_field(DepthOfField::focused(2.0, 1.4)).with_motion_blur(MotionBlur::shutter(0.5));
    part1.set_look(look);
    for tick in 1..=2u64 {
        let x = tick as f32 * 0.5;
        let mut frame = ImmediateFrame::new(CameraDesc::look_at([x, 2.0, 6.0], [x, 0.0, 0.0]), [0, 0, 0, 255]);
        frame.cube(translation(0.0, 0.5, 0.0), [200, 60, 50, 255]);
        frame.set_tick(tick);
        renderer.render(gpu, &frame, CullPath::Gpu, None)?;
    }
    let held = |label: &str| renderer.renderer().buffer_ledger().entries().iter().any(|entry| entry.label == label && entry.bytes > 0);
    if !(held(genex_render::budget::DEPTH_OF_FIELD_LABEL) && held(genex_render::budget::MOTION_BLUR_LABEL)) {
        return Err(RenderError::refused(RenderCode::DeviceFailed, "the lens did not draw"));
    }
    Ok(())
}

/// Every renderer pipeline variant on `gpu`, each under its own scopes: the renderer with and
/// without MSAA at each check scale, a shadowed HDR frame per shadow filter and layout, the RQ4
/// screen effects per preset row, the meshlet path with and without occlusion, RQ6's binned lights
/// with shadowed spots (HDR and LDR) and texture size classes, the HUD painter,
/// and every renderer shader module; with `inject_invalid`, one module the scope must report.
fn pipeline_variants(gpu: &Gpu, inject_invalid: bool) -> Vec<(String, VariantScope)> {
    let mut variants = Vec::new();
    for hdr in [false, true] {
        for msaa in [true, false] {
            for scale in CHECK_SCALES {
                let scene = if hdr { "hdr-" } else { "" };
                let name = format!("renderer-{scene}{}-scale-{scale}", if msaa { "msaa" } else { "single-sample" });
                variants.push(variant(gpu, name, |gpu| renderer_variant(gpu, msaa, scale, hdr)));
            }
        }
    }
    for filter in ShadowFilter::ALL {
        for (cascades, format) in CHECK_SHADOW_LAYOUTS {
            let name = format!("shadows-filter-{}-{cascades}x-{format:?}", filter.shader_id());
            variants.push(variant(gpu, name, |gpu| shadow_variant(gpu, filter, cascades, format)));
        }
    }
    for (preset, wire) in CHECK_EFFECT_PRESETS {
        let Some(class) = DeviceClass::from_wire(wire) else { continue };
        let name = format!("effects-{}-{wire}", preset.wire());
        variants.push(variant(gpu, name, |gpu| effects_variant(gpu, preset, class)));
    }
    for (preset, wire, name) in CHECK_GRADING_PRESETS {
        let Some(class) = DeviceClass::from_wire(wire) else { continue };
        variants.push(variant(gpu, name.to_owned(), |gpu| grading_variant(gpu, preset, class)));
    }
    for (preset, wire, scale, upscaler) in CHECK_UPSCALE_PRESETS {
        let Some(class) = DeviceClass::from_wire(wire) else { continue };
        let name = format!("upscale-{}-{wire}", preset.wire());
        variants.push(variant(gpu, name, |gpu| upscale_variant(gpu, preset, class, scale, upscaler)));
    }
    for occlusion in [false, true] {
        let name = format!("meshlets-{}", if occlusion { "occlusion" } else { "msaa" });
        variants.push(variant(gpu, name, |gpu| meshlet_variant(gpu, occlusion)));
    }
    for hdr in [true, false] {
        let name = format!("lights-{}", if hdr { "hdr" } else { "ldr" });
        variants.push(variant(gpu, name, |gpu| lights_variant(gpu, hdr)));
    }
    variants.push(variant(gpu, "textures-classes".to_owned(), textures_variant));
    for (preset, name) in [(QualityPreset::Medium, "terrain-medium"), (QualityPreset::High, "terrain-high")] {
        variants.push(variant(gpu, name.to_owned(), move |gpu| terrain_variant(gpu, preset, false)));
    }
    for (preset, name) in [(QualityPreset::Medium, "grass-medium"), (QualityPreset::High, "grass-high")] {
        variants.push(variant(gpu, name.to_owned(), move |gpu| terrain_variant(gpu, preset, true)));
    }
    for (ring, name) in [(true, "lens-ring"), (false, "lens-circular")] {
        variants.push(variant(gpu, name.to_owned(), move |gpu| lens_variant(gpu, ring)));
    }
    variants.push(variant(gpu, "hud".to_owned(), |gpu| {
        drop(HudPainter::new(&gpu.device, WORLD_FORMAT));
        Ok(())
    }));
    for (name, source) in SHADERS {
        variants.push(variant(gpu, format!("shader-{name}"), |gpu| shaders::module(&gpu.device, name, source).map(drop)));
    }
    if inject_invalid {
        variants.push(variant(gpu, INJECTED_VARIANT.to_owned(), |gpu| shaders::module(&gpu.device, INJECTED_VARIANT, INJECTED_WGSL).map(drop)));
    }
    variants
}

/// Create every renderer pipeline variant on the browser's device under error scopes (and, with
/// `inject_invalid`, one invalid module); resolves with JSON `[{variant, error}]`, `error` null for
/// a variant the browser accepted.
#[wasm_bindgen]
pub async fn studio_pipeline_check(inject_invalid: bool) -> Result<String, JsValue> {
    let variants = with_shell(|shell| Ok(pipeline_variants(graphics(shell)?.screen.presenter.gpu(), inject_invalid)))?;
    let mut rows = Vec::with_capacity(variants.len());
    for (name, scope) in variants {
        rows.push(json!({ "variant": name, "error": scope.await }));
    }
    Ok(Value::Array(rows).to_string())
}

/// A readback in flight: the staging buffer and what its rows hold.
struct Readback {
    staging: wgpu::Buffer,
    width: u32,
    height: u32,
    padded: u32,
    tick: u64,
}

/// Queue the world target's copy into a mappable buffer (the frame drawn already).
fn start_readback(shell: &mut Shell) -> Result<Readback, JsValue> {
    let tick = started(&mut shell.game)?.tick();
    let presenter = &mut graphics(shell)?.screen.presenter;
    let (width, height) = presenter.resilient.renderer().renderer().size();
    check_capture_size(width, height).map_err(|error| render_refusal(&error))?;
    let texture = presenter.gpu().device.create_texture(&wgpu::TextureDescriptor {
        label: Some("capture"),
        size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: WORLD_FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    // The world target at its own size (the window present's texel-for-texel copy) with opaque
    // alpha: its own bytes.
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    presenter.resilient.present(&view, WORLD_FORMAT, (width, height));
    let gpu = presenter.gpu();
    let padded = (width * 4).div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT) * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let staging = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("capture readback"),
        size: u64::from(padded) * u64::from(height),
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("capture") });
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture: &texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &staging,
            layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(padded), rows_per_image: Some(height) },
        },
        wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
    );
    gpu.queue.submit([encoder.finish()]);
    Ok(Readback { staging, width, height, padded, tick })
}

/// Await the browser's map of the staging buffer, then strip the row padding.
async fn finish_readback(readback: Readback) -> Result<(Capture, u64), JsValue> {
    let mut resolve_slot = None;
    let promise = js_sys::Promise::new(&mut |resolve, _reject| resolve_slot = Some(resolve));
    let resolve: js_sys::Function = resolve_slot.ok_or_else(|| refusal("capture-failed", "no promise resolver"))?;
    let slice = readback.staging.slice(..);
    slice.map_async(wgpu::MapMode::Read, move |result| {
        let _ = resolve.call1(&JsValue::NULL, &JsValue::from_bool(result.is_ok()));
    });
    if JsFuture::from(promise).await?.as_bool() != Some(true) {
        return Err(refusal("capture-failed", "the readback buffer could not be mapped"));
    }
    let bytes = slice.get_mapped_range().map_err(|error| refusal("capture-failed", error))?.to_vec();
    readback.staging.unmap();
    let capture = Capture::from_padded_rows(readback.width, readback.height, readback.padded, &bytes)
        .map_err(|error| render_refusal(&error))?;
    Ok((capture, readback.tick))
}

/// Draw the current view as a capture (the game's pinned capture settings, untimed).
fn render_capture(shell: &mut Shell) -> Result<(), JsValue> {
    let Shell { game, graphics, view, draws, .. } = shell;
    let graphics = graphics.as_mut().ok_or_else(|| refusal(NOT_BOOTED, "studio_boot has not succeeded"))?;
    *draws = graphics.screen.paint_capture(started(game)?, view.as_deref());
    Ok(())
}

/// Draw the current view as a capture, answer the scopes it left pending and draw it again when
/// the answers changed what it draws (a pass refused now is drawn without, so a capture never shows
/// a frame an invalid pass spoiled; an in-world pass whose first proof resolved now is drawn with,
/// so a capture on other samples than Live's, whose rebuild put the passes on probation, still
/// carries them), then read it back.
/// The next animation frame draws Live again (the world target holds the capture until then).
async fn capture_now() -> Result<(Capture, u64), JsValue> {
    with_shell(|shell| {
        shell.captures_in_flight = shell.captures_in_flight.saturating_add(1);
        Ok(())
    })?;
    let captured = draw_and_read_capture().await;
    with_shell(|shell| {
        shell.captures_in_flight = shell.captures_in_flight.saturating_sub(1);
        shell.gate.mark_stale();
        Ok(())
    })?;
    captured
}

/// [`capture_now`]'s draws and readback, with animation frames held off.
async fn draw_and_read_capture() -> Result<(Capture, u64), JsValue> {
    with_shell(render_capture)?;
    if settle_shell_scopes().await? {
        with_shell(render_capture)?;
    }
    let readback = with_shell(start_readback)?;
    finish_readback(readback).await
}

fn set(object: &js_sys::Object, key: &str, value: &JsValue) -> Result<(), JsValue> {
    js_sys::Reflect::set(object, &JsValue::from_str(key), value).map(|_| ())
}

/// Capture the current view from the world target. Resolves with `{width, height, format:
/// "bgra8", tick, digest, bgra, render}`: `bgra` a `Uint8Array` of top-down BGRA rows, `digest` the
/// FNV-1a-64 of those bytes in 16 hex digits, `render` the pinned settings it was drawn with.
#[wasm_bindgen]
pub async fn studio_capture() -> Result<JsValue, JsValue> {
    let (capture, tick) = capture_now().await?;
    let provenance = with_shell(|shell| Ok(graphics(shell)?.screen.capture_provenance()))?;
    let object = js_sys::Object::new();
    if let Some(provenance) = provenance {
        set(&object, "render", &js_sys::JSON::parse(&String::from_utf8_lossy(&provenance.dump()))?)?;
    }
    set(&object, "width", &JsValue::from(capture.width()))?;
    set(&object, "height", &JsValue::from(capture.height()))?;
    set(&object, "format", &JsValue::from_str(CAPTURE_FORMAT))?;
    // Ticks stay far below 2^53.
    set(&object, "tick", &JsValue::from(tick as f64))?;
    set(&object, "digest", &JsValue::from_str(&hex64(capture.digest())))?;
    set(&object, "bgra", &js_sys::Uint8Array::from(capture.bgra()).into())?;
    Ok(object.into())
}

/// The self-test (`selftest`'s sequence) in the browser: resolves with the same JSON record the
/// native `--self-test` mode writes.
#[wasm_bindgen]
pub async fn studio_self_test(ticks: u32, seed: u32, demo: String) -> Result<String, JsValue> {
    let game = with_shell(|shell| Ok(shell.name.clone()))?;
    let plan = SelfTestPlan { game, seed, demo, ticks };
    let demo_result =
        with_shell(|shell| selftest::begin(started(&mut shell.game)?, &plan).map_err(|e| refusal(e.code(), e)))?;
    let mut captures = Vec::new();
    let mut done = 0;
    for point in plan.checkpoints() {
        with_shell(|shell| {
            selftest::advance(started(&mut shell.game)?, done, point);
            Ok(())
        })?;
        done = point;
        let (capture, tick) = capture_now().await?;
        let digest = hex64(capture.digest());
        captures.push(CaptureDigest { tick, width: capture.width(), height: capture.height(), digest });
    }
    with_shell(|shell| Ok(selftest::record(&plan, &*started(&mut shell.game)?, &demo_result, &captures)))
}

/// The IndexedDB database the game's saves live in: `genex-saves:<game name>`.
#[wasm_bindgen]
pub fn studio_saves_database() -> Result<String, JsValue> {
    with_shell(|shell| Ok(format!("{SAVES_DATABASE_PREFIX}{}", shell.name)))
}

/// One `[name, bytes]` pair from the page; None for any other shape.
fn saved_entry(entry: &JsValue) -> Option<(String, Vec<u8>)> {
    let pair = entry.dyn_ref::<js_sys::Array>()?;
    let name = pair.get(0).as_string()?;
    let bytes = pair.get(1).dyn_into::<js_sys::Uint8Array>().ok()?.to_vec();
    Some((name, bytes))
}

/// Fill the saves mirror with what IndexedDB held, `[[name, Uint8Array], …]`, before
/// `studio_boot` runs the first reset. Entries of another shape, an unsafe name or too many bytes
/// are skipped.
#[wasm_bindgen]
pub fn studio_saves_preload(entries: js_sys::Array) {
    mirror::preload(entries.iter().filter_map(|entry| saved_entry(&entry)).collect());
}

/// The files saved since the last take, `[[name, Uint8Array], …]`, for the shell to write to
/// IndexedDB; they are in flight until `studio_saves_flushed` answers.
#[wasm_bindgen]
pub fn studio_saves_take() -> js_sys::Array {
    let taken = js_sys::Array::new();
    for (name, bytes) in mirror::take_dirty() {
        let pair = js_sys::Array::of2(&JsValue::from_str(&name), &js_sys::Uint8Array::from(bytes.as_slice()));
        taken.push(&pair);
    }
    taken
}

/// How the flush of the taken files went: `error` none for written, else the wire code (an unknown
/// code counts as `save-unavailable`) with the names that were not written, which stay pending.
#[wasm_bindgen]
pub fn studio_saves_flushed(error: Option<String>, names: js_sys::Array) {
    let Some(code) = error else { return mirror::flushed(Ok(())) };
    let error = MirrorError::from_wire(&code).unwrap_or(MirrorError::Unavailable);
    mirror::flushed(Err((error, names.iter().filter_map(|name| name.as_string()).collect())));
}

/// IndexedDB could not be opened: saves last only as long as the page (`save-unavailable`).
#[wasm_bindgen]
pub fn studio_saves_unavailable() {
    mirror::fail(MirrorError::Unavailable);
}

/// The files saved since the last take: the shell's cheap check before it schedules a flush.
#[wasm_bindgen]
pub fn studio_saves_pending() -> u32 {
    u32::try_from(mirror::status().pending).unwrap_or(u32::MAX)
}

/// The mirror's account as JSON, `{store, files, pending, inFlight, error}`.
#[wasm_bindgen]
pub fn studio_saves_status() -> String {
    saves_state(&mirror::status()).to_string()
}

/// The WebGPU feature names (`GPUAdapter.features`) of the compressed texture families.
const WEBGPU_TEXTURE_FEATURES: [(&str, wgpu::Features); 3] = [
    ("texture-compression-bc", wgpu::Features::TEXTURE_COMPRESSION_BC),
    ("texture-compression-astc", wgpu::Features::TEXTURE_COMPRESSION_ASTC),
    ("texture-compression-etc2", wgpu::Features::TEXTURE_COMPRESSION_ETC2),
];

/// The compressed families an adapter samples, best first, from the shell's `{features, mobile}`
/// JSON (`GPUAdapter.features` names and whether the page is a phone's); none without it.
fn usable_families(adapter: Option<&str>) -> Vec<TextureFamily> {
    let Some(adapter) = adapter.and_then(|text| serde_json::from_str::<Value>(text).ok()) else { return Vec::new() };
    let names: Vec<&str> = adapter.get("features").and_then(Value::as_array).map(|names| names.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    let features = WEBGPU_TEXTURE_FEATURES.iter().filter(|(name, _)| names.contains(name)).fold(wgpu::Features::empty(), |all, (_, feature)| all | *feature);
    let mobile = adapter.get("mobile").and_then(Value::as_bool).unwrap_or(false);
    TextureFamily::usable_compressed(features, mobile)
}

/// Plan the staged assets from the build's asset map (`assets.json`'s text) for the adapter
/// (`{features, mobile}` JSON, optional): answers the files to fetch before the first reset,
/// `[[path, bytes], …]`, each under the asset-path rule and the caps (a v1 map's every file; a v2
/// map's boot and sim groups, one family file per texture); entries left out are logged and never
/// fetched. A map that is not well formed is refused `asset-map-invalid`.
#[wasm_bindgen]
pub fn studio_assets_plan(map: &str, adapter: Option<String>) -> Result<js_sys::Array, JsValue> {
    let usable = usable_families(adapter.as_deref());
    let assets = WebAssets::plan_for(map.as_bytes(), &usable).map_err(|error| refusal(error.code().wire(), &error))?;
    for (path, why) in assets.skipped() {
        log::warn!("genex web: asset {path:?} left out: {}", why.wire());
    }
    let planned = js_sys::Array::new();
    for asset in assets.preload() {
        // Planned files are at most MAX_ASSET_BYTES, far below 2^53.
        planned.push(&js_sys::Array::of2(&JsValue::from_str(&asset.path), &JsValue::from(asset.bytes as f64)));
    }
    with_shell(|shell| {
        shell.fetched = assets;
        Ok(planned)
    })
}

/// The fetches the game wants since the last call, `[[path, offset, bytes], …]`: a streamed or
/// named file's planned ranges not yet admitted, or the whole file. Each is fetched (a `Range`
/// request for a piece) and handed to [`studio_assets_arrived`].
#[wasm_bindgen]
pub fn studio_assets_wanted() -> Result<js_sys::Array, JsValue> {
    with_shell(|shell| {
        let wanted = js_sys::Array::new();
        for fetch in shell.fetched.take_wanted() {
            // Offsets and lengths are inside a file of at most MAX_ASSET_BYTES, far below 2^53.
            let row = js_sys::Array::of3(&JsValue::from_str(&fetch.path), &JsValue::from(fetch.offset as f64), &JsValue::from(fetch.bytes as f64));
            wanted.push(&row);
        }
        Ok(wanted)
    })
}

/// Admit bytes fetched while playing: the whole of a planned file (offset 0) or exactly one of its
/// planned ranges, with the recorded length and FNV-1a 64; refused (`asset-not-planned`,
/// `asset-size-mismatch`, `asset-digest-mismatch`) with nothing admitted otherwise.
#[wasm_bindgen]
pub fn studio_assets_arrived(path: &str, offset: f64, bytes: js_sys::Uint8Array) -> Result<(), JsValue> {
    let Some(offset) = whole_offset(offset) else { return Err(refusal(crate::assets::AssetRefusal::NotPlanned.wire(), "the offset is not a whole byte")) };
    with_shell(|shell| shell.fetched.arrived(path, offset, bytes.to_vec()).map_err(|error| refusal(error.code().wire(), &error)))
}

/// `offset` as a byte position, when the page sent a whole, non-negative number below 2^53.
fn whole_offset(offset: f64) -> Option<u64> {
    let whole = offset.is_finite() && offset >= 0.0 && offset.fract() == 0.0 && offset < 9_007_199_254_740_992.0;
    whole.then_some(offset as u64)
}

/// Drop a streamed or named file's admitted bytes so it can be wanted again; a boot or sim file
/// stays resident (`asset-group-invalid`), an unplanned path is `asset-not-planned`.
#[wasm_bindgen]
pub fn studio_assets_release(path: &str) -> Result<(), JsValue> {
    with_shell(|shell| shell.fetched.release(path).map_err(|error| refusal(error.code().wire(), &error)))
}

/// Admit one fetched file (its path as planned and its bytes): refused unless the plan named it
/// and the bytes are exactly the recorded length and FNV-1a 64; a refused file never loads.
#[wasm_bindgen]
pub fn studio_assets_preload(path: &str, bytes: js_sys::Uint8Array) -> Result<(), JsValue> {
    with_shell(|shell| shell.fetched.admit(path, bytes.to_vec()).map_err(|error| refusal(error.code().wire(), &error)))
}
