//! The renderer perf matrix (plan RQ0.9): scenes × profiles × sizes on the host GPU, CPU and GPU
//! frame times as p50/p95, one JSON record per run in `.studio-dev/evidence/rust-renderer/perf/`.
//! `scripts/spike/rust-wgpu/render-perf.ts` drives it (records the baseline, compares against it, runs
//! the interleaved A/B against saved executables) and prints the feature costs against the plan's budgets.
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p showcase --release \
//!     --offline --locked --test perf_matrix -- --ignored metal --nocapture
//!
//! Scenes: the nine lakeside shots (pass 1's five and Lakeside v2's four; fixed cameras, one simulation tick per frame from tick 600, drawn
//! as the studio draws them), the three bench scenes along their camera paths, and the two stress
//! scenes ([`showcase_game::stress`]: 1,024 point lights over a plaza; a 1.5 M triangle forest).
//! Profiles: `off` (today's renderer) and the four presets as the host's device class resolves them.
//!
//! Per frame, as in `benches/render_baseline.rs` (whose method this keeps): `cpuMs` is building the
//! scene, planning, uploading, encoding and submitting; `frameMs` adds the GPU finishing (device
//! poll); `gpuMs` is the GPU time between a timestamp at the start of the frame's first command
//! encoder and one at the end of an empty pass on the world target submitted after the frame
//! (`null` when the adapter offers no `TIMESTAMP_QUERY`). Per-node GPU times need the renderer to take
//! a `GpuTimer` (tier RQ0.7); until then `nodes` is `null` with that reason.
//!
//! Environment: `GENEX_PERF_FRAMES` measured frames (120; the gate uses 600) after `GENEX_PERF_WARMUP`
//! (30); `GENEX_PERF_SIZES` (`1280x720,1920x1080`); `GENEX_PERF_PROFILES` (`off,low,medium,high,ultra`);
//! `GENEX_PERF_ROWS` a comma list of scene names to keep; `GENEX_PERF_OUT` the record's path.
//! Power source and thermal state (`pmset`) are recorded so runs are compared like for like only.
//!
//! The mobile proxy row (`metal_mobile_proxy_*`) renders the lakeside shots at the mobile-high and
//! mobile-mid reference resolutions and nominal scales with the class's default preset and requires
//! the GPU p95 to be at most 1/8 of the class's frame interval on the host: a sanity ratio on a Mac,
//! never a claim about a phone.
#![allow(clippy::disallowed_types, reason = "a perf harness reads the wall clock; the simulation never does")]

mod support;

use std::path::PathBuf;
use std::process::Command;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use genex::{FIXED_STEP_MS, Runtime, Value, View, json};
use genex_render::Gpu;
use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier, TargetOs, classify};
use genex_render::presets::{class_defaults, default_preset, preset_quality, reference_resolution, scene_format};
use genex_render::renderer::FrameStats;
use genex_render::scene::{FramePlan, MeshLibrary, MeshletState, Scene};
use genex_render::settings::{AntiAliasing, CompensationCurve, ExposureMode, Look, Quality, QualityPreset, RenderFeature, Tonemapper};
use genex_render::{RenderOptions, Renderer};
use genex_render::meshlet_cull::CullPass;
use showcase_game::bench::SceneId;
use showcase_game::stress::{self, FOREST_TOLERANCE, FOREST_TRIANGLES, OCCLUSION_TOLERANCE, OCCLUSION_TRIANGLES, PLAZA_LIGHTS, PLAZA_SIDE, StressId};
use showcase_game::world::{SHOTS, World};
use support::{Lakeside, OnGpu, lakeside_at_shot_tick};

/// Measured frames and warm-up frames when the environment names none (the gate asks for 600).
const DEFAULT_FRAMES: u32 = 120;
const DEFAULT_WARMUP: u32 = 30;
const DEFAULT_SIZES: &str = "1280x720,1920x1080";
const DEFAULT_PROFILES: &str = "off,low,medium,high,ultra,medium@0.75,high@0.67";
/// The separator of a profile's render scale (`medium@0.75`: the high phone class's nominal scale;
/// `high@0.67`: desktop-high's lowest dynamic-resolution step), so FSR1's EASU and RCAS and their
/// intermediates are measured end to end (RQ5 review: every row drew at scale 1).
/// Timestamp slots: the frame's start and its end.
const TIMESTAMPS: u32 = 2;
/// The profile that is today's renderer.
const OFF: &str = "off";
/// The mobile proxy: GPU p95 at most this share of the class's frame interval.
const MOBILE_PROXY_SHARE: f64 = 1.0 / 8.0;
/// Frames the mobile proxy measures per shot.
const MOBILE_PROXY_FRAMES: u32 = 240;
/// The proxy measures each shot this many times and keeps the best GPU p95: a shared machine's
/// contention only adds time, so the best repeat is the shot's cost.
const MOBILE_PROXY_REPEATS: u32 = 5;
/// The record's format version.
const RECORD_VERSION: u32 = 1;

/// Whether `Renderer` consumes a [`Quality`]: RQ0.7 wired [`Renderer::set_quality`] (graph gating
/// and the shadows switch), so every preset row is drawn with its quality. A row records what it
/// asked for (`featuresRequested`) and what this build draws of it (`featuresDrawn`,
/// `genex_render::graph::feature_drawn`): only drawn features are ever read as a feature's cost.
const RENDERER_CONSUMES_QUALITY: bool = true;

fn env_u32(name: &str, default: u32) -> u32 {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

fn sizes() -> Vec<[u32; 2]> {
    let text = std::env::var("GENEX_PERF_SIZES").unwrap_or_else(|_| DEFAULT_SIZES.to_owned());
    text.split(',')
        .filter_map(|size| {
            let (w, h) = size.trim().split_once('x')?;
            Some([w.parse().ok()?, h.parse().ok()?])
        })
        .collect()
}

fn kept(scene: &str) -> bool {
    std::env::var("GENEX_PERF_ROWS").map_or(true, |rows| rows.split(',').any(|r| r.trim() == scene))
}

/// The profiles to run: `off` and the four presets, in the order named.
fn profiles() -> Vec<Profile> {
    let text = std::env::var("GENEX_PERF_PROFILES").unwrap_or_else(|_| DEFAULT_PROFILES.to_owned());
    text.split(',').filter_map(|name| Profile::from_name(name.trim())).collect()
}

/// One line of a host tool's output, or `unknown`.
fn host(program: &str, args: &[&str]) -> String {
    Command::new(program)
        .args(args)
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).lines().map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>().join("; "))
        .unwrap_or_else(|| "unknown".to_owned())
}

const SCALE_SEPARATOR: char = '@';

/// A matrix profile: `off`, a preset at scale 1, or a preset at a render scale in hundredths.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Profile {
    Off,
    Preset(QualityPreset),
    Scaled(QualityPreset, u16),
}

impl Profile {
    fn from_name(name: &str) -> Option<Profile> {
        if name == OFF {
            return Some(Profile::Off);
        }
        let Some((preset, scale)) = name.split_once(SCALE_SEPARATOR) else { return QualityPreset::from_wire(name).map(Profile::Preset) };
        let hundredths = (scale.parse::<f32>().ok()? * 100.0).round();
        let held = (1.0..=100.0).contains(&hundredths).then_some(hundredths as u16)?;
        QualityPreset::from_wire(preset).map(|preset| Profile::Scaled(preset, held))
    }

    fn name(self) -> String {
        match self {
            Profile::Off => OFF.to_owned(),
            Profile::Preset(preset) => preset.wire().to_owned(),
            Profile::Scaled(preset, hundredths) => format!("{}{SCALE_SEPARATOR}{:.2}", preset.wire(), f32::from(hundredths) / 100.0),
        }
    }

    /// The preset (None: `off`).
    fn preset(self) -> Option<QualityPreset> {
        match self {
            Profile::Off => None,
            Profile::Preset(preset) | Profile::Scaled(preset, _) => Some(preset),
        }
    }

    /// The render scale the profile draws at.
    fn scale(self) -> f32 {
        match self {
            Profile::Scaled(_, hundredths) => f32::from(hundredths) / 100.0,
            _ => 1.0,
        }
    }
}

/// What a profile asked of the renderer and what it got, as the row records it.
struct Applied {
    profile: Profile,
    class: DeviceClass,
    quality: Quality,
}

impl Applied {
    fn json(&self) -> Value {
        let features: Vec<&str> = RenderFeature::ALL.into_iter().filter(|f| self.quality.feature(*f)).map(RenderFeature::wire).collect();
        let drawn: Vec<&str> =
            RenderFeature::ALL.into_iter().filter(|f| genex_render::graph::feature_drawn(&self.quality, *f)).map(RenderFeature::wire).collect();
        json!({
            "profile": self.profile.name(),
            "class": self.class.wire(),
            "renderScale": self.profile.scale(),
            "wired": RENDERER_CONSUMES_QUALITY && self.profile != Profile::Off,
            "featuresRequested": features,
            "featuresDrawn": drawn,
            "featureShapes": { "shadows": shadow_shape(&self.quality), "ao": ao_shape(&self.quality) },
        })
    }

    /// [`Applied::json`] with what `renderer`'s last frame drew (RQ5 review: the row reported the
    /// quality's switches, so a TAA ask drawn as MSAA read as TAA): the world pass's samples, and
    /// `taa` and `upscaler` from the frame's path.
    fn drawn_json(&self, renderer: &Renderer, content: Content) -> Value {
        let mut value = self.json();
        let path = renderer.last_scene();
        let taa = path.is_some_and(|path| path.taa);
        let upscaled = path.is_some_and(|path| path.fsr.easu || path.fsr.rcas);
        let mut drawn: Vec<&str> = RenderFeature::ALL
            .into_iter()
            .filter(|feature| match feature {
                RenderFeature::Taa => taa,
                RenderFeature::Upscaler => upscaled,
                _ => genex_render::graph::feature_drawn(&self.quality, *feature),
            })
            .map(RenderFeature::wire)
            .collect();
        let hdr = path.is_some_and(|path| path.hdr);
        let clouds = matches!(renderer.environment(), genex_render::settings::Environment::Sky(sky) if sky.clouds.is_some());
        let content = Content { terrain: renderer.terrain_stats().is_some(), grass: renderer.grass_stats().is_some(), clouds, ..content };
        let stage_a = stage_a_drawn(&self.quality, renderer.look(), hdr && taa, content);
        drawn.extend(stage_a.iter().map(|(feature, _)| *feature));
        for (feature, shape) in stage_a.into_iter().filter_map(|(feature, shape)| shape.map(|shape| (feature, shape))) {
            value["featureShapes"][feature] = json!(shape);
        }
        value["featuresDrawn"] = json!(drawn);
        value["samples"] = json!(renderer.sample_count());
        value["scenePath"] = json!({ "taa": taa, "easu": path.is_some_and(|path| path.fsr.easu), "rcas": path.is_some_and(|path| path.fsr.rcas) });
        value
    }
}

/// The shape AO is drawn in, as the budgets name it (`tests/fixtures/render-perf/budgets.json`:
/// GTAO's budget is per resolution): `half`, `full`, or `off`.
fn ao_shape(quality: &Quality) -> &'static str {
    match quality.ao.resolution {
        genex_render::settings::AoResolution::Half => "half",
        genex_render::settings::AoResolution::Full => "full",
        _ => "off",
    }
}

/// What a scene declares that a Stage A feature draws for (owner decision D17: a row is charged
/// a feature's budget only when its frames draw it). The terrain and the grass are read off the
/// renderer; the rest from the frame a subject drew.
#[derive(Clone, Copy, Debug, Default)]
struct Content {
    terrain: bool,
    grass: bool,
    reflection_probes: usize,
    irradiance_volumes: usize,
    decals: usize,
    /// The game's sky carries a cloud layer (renderer pass 2 B.5).
    clouds: bool,
}

/// The Stage A features (and B.5's clouds) `quality` draws under `look` on `content` (`taa_hdr`: the
/// frame is the HDR scene TAA resolves, where the sun mask runs), named as `tests/fixtures/render-perf/
/// budgets.json` names them, each with the shape its budget is keyed by. GPU particles have a
/// budget but no matrix scene declares any.
fn stage_a_drawn(quality: &Quality, look: &Look, taa_hdr: bool, content: Content) -> Vec<(&'static str, Option<&'static str>)> {
    use genex_render::post::dof::DofTier;
    use genex_render::post::motion_blur::MotionBlurTier;
    let environment = &quality.environment;
    let froxel = environment.froxel_fog.filter(|_| quality.fog).map(|grid| if grid == genex_render::froxel::ULTRA_GRID { "ultra" } else { "high" });
    let dof = match quality.dof {
        _ if !look.depth_of_field.enabled => None,
        DofTier::Ring => Some("ring"),
        DofTier::Circular => Some("circular"),
        _ => None,
    };
    let rows = [
        ("grading", look.grading != genex_render::post::grading::Grading::NEUTRAL, None),
        ("reflection-probes", environment.ibl && environment.reflection_probes > 0 && content.reflection_probes > 0, None),
        ("irradiance-volumes", environment.irradiance_volumes > 0 && content.irradiance_volumes > 0, None),
        ("froxel-fog", froxel.is_some(), froxel),
        ("screen-inputs", !quality.screen_inputs.is_empty(), None),
        ("terrain", content.terrain, None),
        ("grass", content.grass && quality.grass != genex_render::foliage::GrassQuality::OFF, None),
        ("dof", dof.is_some(), dof),
        ("motion-blur", look.motion_blur.enabled && quality.motion_blur != MotionBlurTier::Off, None),
        ("decals", quality.lights.decals > 0 && content.decals > 0, None),
        ("sun-mask", genex_render::post::sun_mask::key(quality, taa_hdr, taa_hdr).is_some(), None),
        ("clouds", genex_render::clouds::LANDED && content.clouds && quality.hdr && environment.clouds.is_some(), None),
    ];
    rows.into_iter().filter(|(_, on, _)| *on).map(|(feature, _, shape)| (feature, shape)).collect()
}

/// The sun shadows' shape as a row records it, so a profile drawing other cascades than `off`'s
/// legacy ones is charged against the shadow budget (render-perf's `featureCosts`).
fn shadow_shape(quality: &Quality) -> String {
    let s = &quality.shadows;
    format!(
        "{}x{}-{:?}-{:?}-cadence{}-{}m-blend{}-fade{}",
        s.cascades, s.map_size, s.format, s.filter, s.far_cadence, s.distance, s.blend_percent, s.fade_percent
    )
}

/// The world pass's samples `profile` draws with on `class`, as the presenter builds its renderer
/// for its first frame's preset (RQ5.6): MSAA 4x, or one sample under TAA (`landed_samples`).
fn profile_options(profile: Profile, class: DeviceClass) -> RenderOptions {
    let quality = profile.preset().map_or_else(Quality::off, |preset| preset_quality(preset, class));
    RenderOptions { msaa: genex_render::renderer::landed_samples(quality.anti_aliasing) > 1 }
}

/// Put `renderer` into `profile` for `class` as the presenter does: the profile's quality, the
/// class's HDR scene format on this adapter, the lakeside's look (Khronos PBR Neutral with auto
/// exposure) and the class's form factor and tier (its MSAA resolve). A profile renders at its
/// fixed scale (1, or a scaled profile's: dynamic resolution is off) so its time is the cost of its
/// features alone; `off` stays on the legacy LDR scene (its quality draws no HDR).
fn apply_profile(renderer: &mut Renderer, profile: Profile, class: DeviceClass) -> Applied {
    let quality = profile.preset().map_or_else(Quality::off, |preset| preset_quality(preset, class));
    let rg11b10 = renderer.device_features().contains(wgpu::Features::RG11B10UFLOAT_RENDERABLE);
    renderer.set_quality(&quality);
    renderer.set_render_scale(profile.scale());
    renderer.set_scene_format(scene_format(class, rg11b10));
    renderer.set_look(lakeside_look());
    renderer.set_device_class(class);
    Applied { profile, class, quality }
}

/// The lakeside's look (`showcase::new_game`'s): what every HDR profile draws with.
fn lakeside_look() -> Look {
    let mut look = Look::default();
    look.tonemapper = Tonemapper::KhronosNeutral;
    look.exposure = ExposureMode::Auto;
    look.ev_compensation = showcase_game::showcase::LOOK_EV_COMPENSATION;
    look
}

/// The look a capture of `cell` draws with: the lakeside's, with the scene's own exposure
/// compensation curve where it sets one (the dusk plaza, `StressId::exposure_curve`).
fn scene_look(cell: Cell) -> Look {
    let look = lakeside_look();
    match cell {
        Cell::Stress(id) => id.exposure_curve().map_or(look, |points| look.with_compensation_curve(CompensationCurve::new(points))),
        _ => look,
    }
}

/// GPU timestamps around a frame: a stamped dispatch first in the frame's first encoder and a
/// stamped pass on the world target submitted after the frame, read back once it is done.
struct Stamps {
    set: wgpu::QuerySet,
    resolve: wgpu::Buffer,
    read: wgpu::Buffer,
    /// A one-invocation dispatch the stamps are written around (Metal drops an empty pass).
    tick: wgpu::ComputePipeline,
    period_ns: f32,
}

/// The stamped pass's shader: one invocation that does nothing.
const TICK_WGSL: &str = "@compute @workgroup_size(1) fn main() {}";

impl Stamps {
    fn new(gpu: &Gpu) -> Stamps {
        let device = &gpu.device;
        let bytes = u64::from(TIMESTAMPS) * 8;
        Stamps {
            set: device.create_query_set(&wgpu::QuerySetDescriptor { label: Some("matrix timestamps"), ty: wgpu::QueryType::Timestamp, count: TIMESTAMPS }),
            resolve: device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("matrix timestamp resolve"),
                size: bytes,
                usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            }),
            read: device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("matrix timestamp read"),
                size: bytes,
                usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            }),
            tick: device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some("matrix timestamp tick"),
                layout: None,
                module: &device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("matrix timestamp tick"), source: wgpu::ShaderSource::Wgsl(TICK_WGSL.into()) }),
                entry_point: Some("main"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                cache: None,
            }),
            period_ns: gpu.queue.get_timestamp_period(),
        }
    }

    /// Encode the start stamp, first in the frame's first encoder.
    fn start(&self, encoder: &mut wgpu::CommandEncoder) {
        let writes = wgpu::ComputePassTimestampWrites { query_set: &self.set, beginning_of_pass_write_index: Some(0), end_of_pass_write_index: None };
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("matrix start stamp"), timestamp_writes: Some(writes) });
        pass.set_pipeline(&self.tick);
        pass.dispatch_workgroups(1, 1, 1);
    }

    /// Submit the end stamp: an empty pass that loads and stores the world target, so it ends only
    /// after every earlier write to it has finished (a compute pass with no shared resource ran
    /// beside the frame on Metal instead of after it).
    fn end(&self, gpu: &Gpu, world: &wgpu::TextureView) {
        let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("matrix end stamp") });
        let writes = wgpu::RenderPassTimestampWrites { query_set: &self.set, beginning_of_pass_write_index: None, end_of_pass_write_index: Some(1) };
        drop(encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("matrix end stamp"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: world,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: Some(writes),
            occlusion_query_set: None,
            multiview_mask: None,
        }));
        gpu.queue.submit([encoder.finish()]);
    }

    /// The frame's GPU milliseconds, resolved in a submission of its own (Metal's counter samples are
    /// only readable once their command buffer completed).
    fn read_ms(&self, gpu: &Gpu) -> f64 {
        let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("matrix timestamp resolve") });
        encoder.resolve_query_set(&self.set, 0..TIMESTAMPS, &self.resolve, 0);
        encoder.copy_buffer_to_buffer(&self.resolve, 0, &self.read, 0, u64::from(TIMESTAMPS) * 8);
        gpu.queue.submit([encoder.finish()]);
        let slice = self.read.slice(..);
        slice.map_async(wgpu::MapMode::Read, |_| {});
        gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("timestamps mapped");
        let ticks: Vec<u64> =
            slice.get_mapped_range().expect("timestamps read").chunks(8).map(|c| u64::from_le_bytes(c.try_into().unwrap_or([0; 8]))).collect();
        self.read.unmap();
        ticks[1].saturating_sub(ticks[0]) as f64 * f64::from(self.period_ns) / 1.0e6
    }
}

/// The frame times of one cell.
#[derive(Default)]
struct Samples {
    cpu: Vec<f64>,
    frame: Vec<f64>,
    gpu: Vec<f64>,
}

fn summary(values: &mut [f64]) -> Value {
    if values.is_empty() {
        return Value::Null;
    }
    values.sort_by(f64::total_cmp);
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    let round = |v: f64| (v * 1000.0).round() / 1000.0;
    json!({ "p50": round(support::percentile(values, 0.5)), "p95": round(support::percentile(values, 0.95)), "mean": round(mean), "max": round(values[values.len() - 1]) })
}

/// p95 of `values` (0 when empty).
fn p95(values: &mut [f64]) -> f64 {
    values.sort_by(f64::total_cmp);
    if values.is_empty() { 0.0 } else { support::percentile(values, 0.95) }
}

fn stats_json(stats: FrameStats) -> Value {
    json!({
        "logicalDraws": stats.logical_draws,
        "instances": stats.instances,
        "batches": stats.batches,
        "views": stats.views,
        "indirectDraws": stats.indirect_draws,
        "transparentDraws": stats.transparent_draws,
        "skinJobs": stats.skin_jobs,
    })
}

/// A scene the matrix can draw: one frame at a time on its own renderer.
trait Subject {
    /// Draw frame `frame` with `marker` encoded first, and submit `end` once it is submitted.
    fn frame(&mut self, gpu: &Gpu, frame: u32, stamps: Option<&Stamps>);
    /// The renderer.
    fn renderer(&mut self) -> &mut Renderer;
    /// What the scene holds, for the row (`null` when nothing is worth recording).
    fn facts(&self) -> Value {
        Value::Null
    }
    /// The scene frame `frame` draws, when it is a function of the frame index (the vertex count
    /// of the path rows needs it; the lakeside's follows the simulation and answers `None`).
    fn scene_at(&self, _frame: u32) -> Option<Scene> {
        None
    }
    /// What the scene declares for the Stage A features (none but the lakeside's do).
    fn content(&mut self) -> Content {
        Content::default()
    }
}

/// A lakeside shot, or the tour: the simulation advances one tick per frame.
struct LakesideSubject {
    runtime: Runtime<World>,
    stage: Lakeside,
    view: &'static str,
}

impl Subject for LakesideSubject {
    fn frame(&mut self, gpu: &Gpu, _frame: u32, stamps: Option<&Stamps>) {
        self.runtime.step(FIXED_STEP_MS);
        let view = View::Named(self.view);
        self.stage.draw_marked(gpu, &mut self.runtime, view, &mut |encoder| {
            if let Some(stamps) = stamps {
                stamps.start(encoder);
            }
        });
        if let Some(stamps) = stamps {
            stamps.end(gpu, self.stage.renderer.world_view());
        }
    }

    fn renderer(&mut self) -> &mut Renderer {
        &mut self.stage.renderer
    }

    fn content(&mut self) -> Content {
        let Some(frame) = self.runtime.frame(View::Named(self.view)) else { return Content::default() };
        let lights = frame.lights();
        Content { reflection_probes: lights.reflection_probes.len(), irradiance_volumes: lights.irradiance_volumes.len(), decals: frame.decals().len(), ..Content::default() }
    }
}

/// A scene that is a function of the frame index.
struct IndexedSubject {
    renderer: Renderer,
    scene: Box<dyn Fn(u32) -> Scene>,
    facts: Value,
}

impl Subject for IndexedSubject {
    fn frame(&mut self, gpu: &Gpu, frame: u32, stamps: Option<&Stamps>) {
        let drawn = (self.scene)(frame);
        support::render_marked(&mut self.renderer, gpu, &drawn, &mut |encoder| {
            if let Some(stamps) = stamps {
                stamps.start(encoder);
            }
        });
        if let Some(stamps) = stamps {
            stamps.end(gpu, self.renderer.world_view());
        }
    }

    fn renderer(&mut self) -> &mut Renderer {
        &mut self.renderer
    }

    fn facts(&self) -> Value {
        self.facts.clone()
    }

    fn scene_at(&self, frame: u32) -> Option<Scene> {
        Some((self.scene)(frame))
    }
}

/// A matrix scene: its row name and how to build it at a size.
#[derive(Clone, Copy)]
enum Cell {
    Lakeside(&'static str),
    Bench(SceneId),
    Stress(StressId),
}

impl Cell {
    /// The scenes in report order.
    fn all() -> Vec<Cell> {
        // Every named shot: pass 1's five and Lakeside v2's four (the D7 whole-frame rows).
        let mut cells: Vec<Cell> = showcase_game::world::named_shots().map(|shot| Cell::Lakeside(shot.name)).collect();
        cells.extend(SceneId::ALL.into_iter().map(Cell::Bench));
        cells.extend(StressId::ALL.into_iter().map(Cell::Stress));
        cells
    }

    fn name(self) -> String {
        match self {
            Cell::Lakeside(shot) => format!("lakeside-{shot}"),
            Cell::Bench(id) => format!("bench-{}", id.name()),
            Cell::Stress(id) => format!("stress-{}", id.name()),
        }
    }

    fn camera(self) -> &'static str {
        match self {
            Cell::Lakeside(_) => "fixed shot",
            Cell::Bench(_) | Cell::Stress(_) => "scene path from frame 0",
        }
    }

    /// The scene on a fresh renderer of `size` built with `options`.
    /// A bench or stress cell's scene at `frame`, its meshes loaded into `meshes` (the lakeside
    /// draws through its runtime and has none).
    fn scene(self, meshes: &mut OnGpu<'_>, frame: u32) -> Scene {
        match self {
            Cell::Lakeside(shot) => panic!("the lakeside's {shot} shot draws through its runtime"),
            Cell::Bench(id) => showcase_game::bench::load(id, meshes).expect("the scene's meshes load").scene(frame),
            Cell::Stress(id) => stress::load(id, meshes).expect("the stress scene's meshes load").scene(frame),
        }
    }

    fn build(self, gpu: &Gpu, size: [u32; 2], options: RenderOptions) -> Box<dyn Subject> {
        match self {
            Cell::Lakeside(view) => {
                let mut runtime = lakeside_at_shot_tick();
                let stage = Lakeside::with_options(gpu, &mut runtime, Some(size), options);
                Box::new(LakesideSubject { runtime, stage, view })
            }
            Cell::Bench(id) => {
                let (renderer, scene) = support::bench_stage_with(gpu, id, size, options);
                Box::new(IndexedSubject { renderer, scene: Box::new(move |frame| scene.scene(frame)), facts: Value::Null })
            }
            Cell::Stress(id) => {
                let mut renderer = Renderer::with_options(gpu, size[0], size[1], options).expect("renderer");
                let scene = stress::load(id, &mut OnGpu { renderer: &mut renderer, gpu }).expect("the stress scene's meshes load");
                let facts = stress_facts(&*scene);
                Box::new(IndexedSubject { renderer, scene: Box::new(move |frame| scene.scene(frame)), facts })
            }
        }
    }
}

/// Lights and triangles of a stress scene at frame 0, from a library of its own meshes.
fn stress_facts(scene: &dyn stress::StressScene) -> Value {
    let mut library = MeshLibrary::new();
    let counted = stress::load(scene.id(), &mut library).expect("the stress scene's meshes load");
    let drawn = counted.scene(0);
    json!({ "lights": drawn.lighting.points.len(), "triangles": stress::triangles(&drawn, &library) })
}

/// Run `warmup` + `frames` frames of `subject`, keeping the measured ones.
fn measure(gpu: &Gpu, stamps: Option<&Stamps>, warmup: u32, frames: u32, subject: &mut dyn Subject) -> Samples {
    let mut samples = Samples::default();
    for frame in 0..warmup + frames {
        let start = Instant::now();
        subject.frame(gpu, frame, stamps);
        let cpu = start.elapsed();
        gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("the frame finished");
        let whole = start.elapsed();
        let gpu_ms = stamps.map(|s| s.read_ms(gpu));
        if frame < warmup {
            continue;
        }
        samples.cpu.push(cpu.as_secs_f64() * 1000.0);
        samples.frame.push(whole.as_secs_f64() * 1000.0);
        samples.gpu.extend(gpu_ms);
    }
    samples
}

const NODES_REASON: &str = "renderer-timer-not-wired: the renderer takes a GpuTimer in tier RQ0.7; the whole-frame stamps are the gated statistic";

/// One matrix row.
fn row(cell: Cell, size: [u32; 2], applied: &Applied, mut samples: Samples, subject: &mut dyn Subject) -> Value {
    let content = subject.content();
    let applied_json = applied.drawn_json(subject.renderer(), content);
    json!({
        "row": cell.name(),
        "profile": applied.profile.name(),
        "size": size,
        "camera": cell.camera(),
        "frames": samples.frame.len(),
        "cpuMs": summary(&mut samples.cpu),
        "frameMs": summary(&mut samples.frame),
        "gpuMs": summary(&mut samples.gpu),
        "nodes": Value::Null,
        "nodesReason": NODES_REASON,
        "stats": stats_json(subject.renderer().last_stats()),
        "scene": subject.facts(),
        "applied": applied_json,
    })
}

/// The device: with `TIMESTAMP_QUERY` when the adapter offers it.
fn open() -> Option<(Gpu, Option<String>)> {
    match Gpu::headless_with(wgpu::Features::TIMESTAMP_QUERY) {
        Ok(gpu) => Some((gpu, None)),
        Err(error) => support::admit(Gpu::headless()).map(|gpu| (gpu, Some(format!("no TIMESTAMP_QUERY: {error}")))),
    }
}

fn out_path(name: &str, sha: &str, variable: &str) -> PathBuf {
    std::env::var_os(variable).map_or_else(|| support::evidence_dir("perf").join(format!("{name}-{sha}.json")), PathBuf::from)
}

fn write_record(path: &PathBuf, record: &Value) {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).expect("the perf folder");
    }
    std::fs::write(path, format!("{record:#}\n")).expect("perf record");
    eprintln!("written: {}", path.display());
}

/// A record's header (build, adapter, timestamps, host state, method) and the build sha its file is named by.
struct Header {
    sha: String,
    json: Value,
}

fn header(gpu: &Gpu, timestamp_problem: &Option<String>, harness: &str, method: Value) -> Header {
    let sha = host("git", &["rev-parse", "--short=12", "HEAD"]);
    let status = host("git", &["status", "--porcelain", "--untracked-files=no"]);
    let dirty = !status.is_empty() && status != "unknown";
    let receipt = gpu.receipt();
    let key = format!("{}/{}", receipt.backend, receipt.adapter);
    let timestamps = match timestamp_problem {
        None => json!({ "available": true, "periodNs": gpu.queue.get_timestamp_period() }),
        Some(why) => json!({ "available": false, "reason": why }),
    };
    Header {
        sha: sha.clone(),
        json: json!({
            "harness": harness,
            "version": RECORD_VERSION,
            "recordedAt": SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs()),
            "build": { "sha": sha, "trackedChanges": dirty, "profile": "test (release)" },
            "adapter": { "name": receipt.adapter, "backend": receipt.backend, "key": key },
            "timestamps": timestamps,
            "host": { "power": host("pmset", &["-g", "ps"]), "thermal": host("pmset", &["-g", "therm"]) },
            "deviceClass": classify(gpu.device_facts()).wire(),
            "method": method,
        }),
    }
}

fn merge(header: Value, rows: Vec<Value>, extra: Vec<(&str, Value)>) -> Value {
    let Value::Object(mut map) = header else { unreachable!("the header is an object") };
    map.insert("rows".to_owned(), Value::Array(rows));
    for (key, value) in extra {
        map.insert(key.to_owned(), value);
    }
    Value::Object(map)
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_matrix_scenes_by_profiles_by_sizes() {
    let Some((gpu, timestamp_problem)) = open() else { return };
    let stamps = timestamp_problem.is_none().then(|| Stamps::new(&gpu));
    let (warmup, frames) = (env_u32("GENEX_PERF_WARMUP", DEFAULT_WARMUP), env_u32("GENEX_PERF_FRAMES", DEFAULT_FRAMES).max(1));
    let class = classify(gpu.device_facts());
    let (profiles, sizes) = (profiles(), sizes());
    assert!(!profiles.is_empty(), "GENEX_PERF_PROFILES names no known profile");
    let mut rows = Vec::new();
    for size in &sizes {
        for cell in Cell::all().into_iter().filter(|cell| kept(&cell.name())) {
            for profile in &profiles {
                let mut subject = cell.build(&gpu, *size, profile_options(*profile, class));
                let applied = apply_profile(subject.renderer(), *profile, class);
                let samples = measure(&gpu, stamps.as_ref(), warmup, frames, subject.as_mut());
                rows.push(row(cell, *size, &applied, samples, subject.as_mut()));
                eprintln!("{} {} {size:?} done", cell.name(), profile.name());
            }
        }
    }
    assert!(!rows.is_empty(), "GENEX_PERF_ROWS keeps no scene");
    let method = json!({
        "warmupFrames": warmup,
        "measuredFrames": frames,
        "runs": 1,
        "samples": "per row (applied.samples: the world pass the profile's renderer was built with)",
        "statistic": "nearest-rank p50/p95 per row",
        "profiles": profiles.iter().map(|p| p.name()).collect::<Vec<_>>(),
        "sizes": sizes,
        "profilesWired": RENDERER_CONSUMES_QUALITY,
    });
    let head = header(&gpu, &timestamp_problem, "render-perf-matrix", method);
    let record = merge(head.json, rows, Vec::new());
    write_record(&out_path("matrix", &head.sha, "GENEX_PERF_OUT"), &record);
    println!("{record:#}");
}

/// Owner decision D7 (2026-10-14): a whole frame within 16.7 ms GPU p95 at desktop-high's high at
/// 1440p output and at ultra at 4K output on the reference M4 Max, both allowed dynamic resolution.
const D7_FRAME_BUDGET_MS: f64 = 16.7;
/// D7's outputs and presets: high at 1440p, ultra at 4K.
const D7_ROWS: [([u32; 2], QualityPreset); 2] = [([2560, 1440], QualityPreset::High), ([3840, 2160], QualityPreset::Ultra)];

/// D7 (G0 perf-platform, 2026-10-15): at 1440p high and 4K ultra every scene's whole frame fits
/// [`D7_FRAME_BUDGET_MS`] at scale 1 or at one of the class's dynamic-resolution steps (the highest
/// that fits is the one DRS settles on). The matrix measured scale 1 alone, where stress-forest's 4K
/// ultra frame is 17.4 ms. `GENEX_PERF_OUT` receives the record (default `perf/d7-<sha>.json`).
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_d7_whole_frames_fit_at_1440p_high_and_4k_ultra_with_dynamic_resolution() {
    let Some((gpu, timestamp_problem)) = open() else { return };
    let Some(stamps) = timestamp_problem.is_none().then(|| Stamps::new(&gpu)) else {
        eprintln!("skipped: no timestamp queries");
        return;
    };
    let (warmup, frames) = (env_u32("GENEX_PERF_WARMUP", DEFAULT_WARMUP), env_u32("GENEX_PERF_FRAMES", DEFAULT_FRAMES).max(1));
    let class = classify(gpu.device_facts());
    let steps: Vec<f32> = class_defaults(class).drs_steps.iter().rev().copied().collect();
    let (mut rows, mut problems) = (Vec::new(), Vec::new());
    for (size, preset) in D7_ROWS {
        for cell in Cell::all().into_iter().filter(|cell| kept(&cell.name())) {
            let mut measured = Vec::new();
            let mut fits = None;
            for scale in &steps {
                let hundredths = (scale * 100.0).round() as u16;
                let profile = if hundredths >= 100 { Profile::Preset(preset) } else { Profile::Scaled(preset, hundredths) };
                let mut subject = cell.build(&gpu, size, profile_options(profile, class));
                apply_profile(subject.renderer(), profile, class);
                let mut samples = measure(&gpu, Some(&stamps), warmup, frames, subject.as_mut());
                let p = p95(&mut samples.gpu);
                measured.push(json!({ "scale": scale, "gpuP95Ms": p }));
                if p <= D7_FRAME_BUDGET_MS {
                    fits = Some(*scale);
                    break;
                }
            }
            let name = cell.name();
            eprintln!("D7 {name} {} {size:?}: fits at {fits:?} ({measured:?})", preset.wire());
            rows.push(json!({ "row": name, "preset": preset.wire(), "size": size, "fitsAtScale": fits, "steps": measured }));
            if fits.is_none() {
                problems.push(format!("{name} at {} {size:?} is over {D7_FRAME_BUDGET_MS} ms at every DRS step", preset.wire()));
            }
        }
    }
    let method = json!({ "warmupFrames": warmup, "measuredFrames": frames, "statistic": "GPU timestamp p95, scale 1 then each DRS step down until one fits", "budgetMs": D7_FRAME_BUDGET_MS, "drsSteps": steps });
    let head = header(&gpu, &timestamp_problem, "render-perf-d7", method);
    let record = merge(head.json, rows, Vec::new());
    write_record(&out_path("d7", &head.sha, "GENEX_PERF_OUT"), &record);
    assert!(problems.is_empty(), "{problems:#?}");
}

/// The presenter-path row's limit: Live frames through `Presenter::draw_view` (render settings,
/// the frame timer armed, dynamic resolution observing) may cost at most this much more frame p95
/// than the renderer core drawing the same shot with the same quality.
const PRESENTER_OVERHEAD_LIMIT: f64 = 1.10;

/// Frame p95 of `frames` Live frames of `shot` through genex's presenter on its own device (with
/// timestamps, so the frame timer runs), the preset `auto` resolves to and the scale held at 1.
fn presenter_frames(shot: &'static str, size: [u32; 2], warmup: u32, frames: u32) -> Option<Samples> {
    use genex::present::Presenter;
    use genex::render::RenderChange;
    let gpu = Gpu::headless_with(wgpu::Features::TIMESTAMP_QUERY).ok()?;
    let reopen = || Gpu::headless_with(wgpu::Features::TIMESTAMP_QUERY);
    let log: fn(&str) = |line| eprintln!("{line}");
    let mut presenter =
        Presenter::with_gpu(gpu, size, wgpu::Features::empty(), Box::new(reopen), Box::new(showcase_game::assets()), log).expect("presenter");
    let mut runtime = lakeside_at_shot_tick();
    let _ = presenter.install_for(&mut runtime);
    let hold = RenderChange { render_scale_lock: Some(Some(1.0)), ..RenderChange::default() };
    runtime.render().borrow_mut().apply(&hold);
    let mut samples = Samples::default();
    for frame in 0..warmup + frames {
        runtime.step(FIXED_STEP_MS);
        let start = Instant::now();
        presenter.draw_view(&mut runtime, View::Named(shot)).expect("a view").expect("drawn");
        let cpu = start.elapsed();
        presenter.gpu().device.poll(wgpu::PollType::wait_indefinitely()).expect("the frame finished");
        if frame >= warmup {
            samples.cpu.push(cpu.as_secs_f64() * 1000.0);
            samples.frame.push(start.elapsed().as_secs_f64() * 1000.0);
        }
    }
    Some(samples)
}

/// The renderer core drawing `shot` with the quality the presenter's `auto` resolves to on `class`.
fn core_frames(gpu: &Gpu, class: DeviceClass, shot: &'static str, size: [u32; 2], warmup: u32, frames: u32) -> Samples {
    let mut runtime = lakeside_at_shot_tick();
    let profile = Profile::Preset(default_preset(class, TargetOs::current()));
    let mut stage = Lakeside::with_options(gpu, &mut runtime, Some(size), profile_options(profile, class));
    apply_profile(&mut stage.renderer, profile, class);
    let mut subject = LakesideSubject { runtime, stage, view: shot };
    measure(gpu, None, warmup, frames, &mut subject)
}

/// The path players run: Live frames through `Presenter::draw_view` (render settings resolved, the
/// frame timer armed, dynamic resolution observing, the HUD and the passes) against the renderer
/// core drawing the same shots with the same quality in the same run, interleaved shot by shot.
/// The record names each shot's ratio of frame p95 and whether every one is at most
/// [`PRESENTER_OVERHEAD_LIMIT`] (`passed`, `over`). A pre-RQ0 executable has no presenter, so this
/// in-run comparison is the A/B.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_presenter_path_live_frames_against_the_renderer_core() {
    let Some((gpu, timestamp_problem)) = open() else { return };
    let (warmup, frames) = (env_u32("GENEX_PERF_WARMUP", DEFAULT_WARMUP), env_u32("GENEX_PERF_FRAMES", DEFAULT_FRAMES).max(1));
    let size = sizes().first().copied().unwrap_or([1280, 720]);
    let class = classify(gpu.device_facts());
    let mut rows = Vec::new();
    let mut over = Vec::new();
    for shot in SHOTS.iter().filter(|shot| kept(&format!("presenter-lakeside-{}", shot.name))) {
        let mut core = core_frames(&gpu, class, shot.name, size, warmup, frames);
        let Some(mut live) = presenter_frames(shot.name, size, warmup, frames) else {
            eprintln!("skipped: no timestamped device for the presenter");
            return;
        };
        let (core_p95, live_p95) = (p95(&mut core.frame), p95(&mut live.frame));
        let ratio = live_p95 / core_p95.max(f64::EPSILON);
        if ratio > PRESENTER_OVERHEAD_LIMIT {
            over.push(format!("{}: {ratio:.3}", shot.name));
        }
        rows.push(json!({
            "row": format!("presenter-lakeside-{}", shot.name),
            "size": size,
            "frames": frames,
            "core": { "cpuMs": summary(&mut core.cpu), "frameMs": summary(&mut core.frame) },
            "presenter": { "cpuMs": summary(&mut live.cpu), "frameMs": summary(&mut live.frame) },
            "frameP95Ratio": (ratio * 1000.0).round() / 1000.0,
        }));
        eprintln!("presenter {} done: {ratio:.3}", shot.name);
    }
    let method = json!({
        "warmupFrames": warmup,
        "measuredFrames": frames,
        "statistic": "frame p95 (CPU build + submit + GPU completion) of the presenter path over the renderer core",
        "preset": default_preset(class, TargetOs::current()).wire(),
        "scale": "held at 1 (renderScaleLock)",
        "limit": PRESENTER_OVERHEAD_LIMIT,
    });
    let head = header(&gpu, &timestamp_problem, "render-perf-presenter-path", method);
    let record = merge(head.json, rows, vec![("passed", Value::Bool(over.is_empty())), ("over", json!(over))]);
    write_record(&out_path("presenter-path", &head.sha, "GENEX_PERF_PRESENTER_OUT"), &record);
    println!("{record:#}");
}

/// The classes the mobile proxy stands for.
const MOBILE_PROXY_CLASSES: [DeviceClass; 2] =
    [DeviceClass::new(FormFactor::Mobile, PerformanceTier::High), DeviceClass::new(FormFactor::Mobile, PerformanceTier::Mid)];

/// One repeat of a mobile proxy shot: its GPU p95 and the size it rendered at.
type Repeat = (f64, [u32; 2]);

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_mobile_proxy_default_presets_use_at_most_an_eighth_of_the_frame_interval() {
    let Some((gpu, timestamp_problem)) = open() else { return };
    let Some(stamps) = timestamp_problem.is_none().then(|| Stamps::new(&gpu)) else {
        eprintln!("skipped: the mobile proxy needs GPU timestamps ({timestamp_problem:?})");
        return;
    };
    // Repeats go round all the shots of all classes, so a stretch of slow GPU clock lands on a
    // different shot each time round; a shot keeps its best repeat.
    let mut best: Vec<Vec<Vec<Repeat>>> = vec![vec![Vec::new(); SHOTS.len()]; MOBILE_PROXY_CLASSES.len()];
    for _ in 0..MOBILE_PROXY_REPEATS {
        for (c, class) in MOBILE_PROXY_CLASSES.iter().enumerate() {
            let defaults = class_defaults(*class);
            let preset = default_preset(*class, TargetOs::Ios);
            let (width, height) = reference_resolution(*class);
            for (k, shot) in SHOTS.iter().enumerate() {
                let mut runtime = lakeside_at_shot_tick();
                let mut stage = Lakeside::with_options(&gpu, &mut runtime, Some([width, height]), profile_options(Profile::Preset(preset), *class));
                apply_profile(&mut stage.renderer, Profile::Preset(preset), *class);
                stage.renderer.set_render_scale(defaults.nominal_scale);
                let (render_width, render_height) = stage.renderer.render_size();
                let mut subject = LakesideSubject { runtime, stage, view: shot.name };
                let mut samples = measure(&gpu, Some(&stamps), DEFAULT_WARMUP, MOBILE_PROXY_FRAMES, &mut subject);
                // The proxy measures what a phone draws: the HDR scene with the lakeside's look.
                let path = subject.stage.renderer.last_scene().expect("a frame");
                assert!(path.hdr, "{} {}: the mobile proxy draws the HDR scene: {path:?}", class.wire(), shot.name);
                // Owner decision 2026-10-12 (b): a phone below scale 1 upscales with EASU + RCAS.
                assert!(path.fsr.easu && path.fsr.rcas, "{} {}: a phone upscales with EASU + RCAS: {path:?}", class.wire(), shot.name);
                best[c][k].push((p95(&mut samples.gpu), [render_width, render_height]));
            }
        }
    }
    let mut classes = Vec::new();
    let mut failures = Vec::new();
    for (c, class) in MOBILE_PROXY_CLASSES.iter().enumerate() {
        let defaults = class_defaults(*class);
        let preset = default_preset(*class, TargetOs::Ios);
        let (width, height) = reference_resolution(*class);
        let interval_ms = 1000.0 / f64::from(defaults.target_fps);
        let budget_ms = interval_ms * MOBILE_PROXY_SHARE;
        let mut shots = Vec::new();
        for (k, shot) in SHOTS.iter().enumerate() {
            let repeats = &best[c][k];
            let (gpu_p95, render_size) = repeats.iter().copied().min_by(|a, b| a.0.total_cmp(&b.0)).expect("a repeat");
            if gpu_p95 > budget_ms {
                failures.push(format!("{} {}: best GPU p95 {gpu_p95:.3} ms > {budget_ms:.3} ms", class.wire(), shot.name));
            }
            let all: Vec<f64> = repeats.iter().map(|r| (r.0 * 1000.0).round() / 1000.0).collect();
            shots.push(json!({ "row": format!("lakeside-{}", shot.name), "gpuP95Ms": (gpu_p95 * 1000.0).round() / 1000.0, "repeatsP95Ms": all, "renderSize": render_size }));
        }
        // The upscale's own cost inside those frames (owner decision 2026-10-12 (b)): EASU + RCAS
        // timed alone from the class's render size to its reference output.
        let render_size = best[c][0].first().expect("a repeat").1;
        let timed = genex_render::post::fsr::gpu_ms(&gpu, (render_size[0], render_size[1]), (width, height), MOBILE_PROXY_FRAMES);
        let mut upscale: Vec<f64> = timed.expect("the upscale's cost").unwrap_or_default().into_iter().map(f64::from).collect();
        let upscale_p95 = (!upscale.is_empty()).then(|| (p95(&mut upscale) * 1000.0).round() / 1000.0);
        classes.push(json!({
            "class": class.wire(),
            "preset": preset.wire(),
            "upscalerFsr1": preset_quality(preset, *class).upscaler == genex_render::settings::Upscaler::Fsr1,
            "easuRcasP95Ms": upscale_p95,
            "referenceResolution": [width, height],
            "nominalScale": defaults.nominal_scale,
            "frameIntervalMs": (interval_ms * 1000.0).round() / 1000.0,
            "budgetMs": (budget_ms * 1000.0).round() / 1000.0,
            "share": MOBILE_PROXY_SHARE,
            "shots": shots,
        }));
    }
    let method = json!({ "warmupFrames": DEFAULT_WARMUP, "measuredFrames": MOBILE_PROXY_FRAMES, "repeats": MOBILE_PROXY_REPEATS, "statistic": "best repeat of the GPU timestamp p95 per shot", "note": "a sanity ratio on the host GPU, never a device claim" });
    let head = header(&gpu, &timestamp_problem, "render-perf-mobile-proxy", method);
    let record = merge(head.json, Vec::new(), vec![("classes", Value::Array(classes)), ("passed", Value::Bool(failures.is_empty())), ("failures", json!(failures))]);
    write_record(&out_path("mobile-proxy", &head.sha, "GENEX_PERF_MOBILE_OUT"), &record);
    println!("{record:#}");
    assert!(failures.is_empty(), "the mobile proxy is over its eighth of the frame interval: {failures:?}");
}

/// The most CPU time per frame (p50, ms) TAA's path may add on bench-city's 64k instances: `high`
/// against `high` drawn with MSAA in place of TAA (everything else equal), so what is left is the
/// motion pass's rows (each instance matched with its last frame's model) and the previous-model
/// table. Pass-1 gate (perf finding 4): TAA added 3.9 ms, which put bench-city's `high` at 0.67
/// over desktop-high's 16.67 ms frame on frame p95 (median 17.08 ms). With at most 2.5 ms, that
/// frame keeps a millisecond of headroom (17.08 - 3.9 + 2.5 = 15.68 ms); measured after the fix:
/// +2.1 ms.
const TAA_CPU_EXTRA_MS_MAX: f64 = 2.5;
/// Repeats of each side of the TAA CPU row; each keeps its best CPU p50.
const TAA_CPU_REPEATS: u32 = 3;

/// The best CPU p50 of `repeats` runs of bench-city at 720p under `quality` on `class`.
fn city_cpu_p50(gpu: &Gpu, class: DeviceClass, quality: &Quality, repeats: u32) -> f64 {
    let options = RenderOptions { msaa: genex_render::renderer::landed_samples(quality.anti_aliasing) > 1 };
    let mut best = f64::MAX;
    for _ in 0..repeats {
        let mut subject = Cell::Bench(SceneId::City).build(gpu, [1280, 720], options);
        apply_profile(subject.renderer(), Profile::Preset(QualityPreset::High), class);
        subject.renderer().set_quality(quality);
        let mut samples = measure(gpu, None, DEFAULT_WARMUP, DEFAULT_FRAMES, subject.as_mut());
        samples.cpu.sort_by(f64::total_cmp);
        best = best.min(support::percentile(&samples.cpu, 0.5));
    }
    best
}

/// Perf finding 4 (pass-1 gate): TAA's path adds at most [`TAA_CPU_EXTRA_MS_MAX`] of CPU time to
/// bench-city at `high` over the same frame drawn with MSAA.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_taa_adds_little_cpu_time_to_bench_city() {
    let Some((gpu, _)) = open() else { return };
    let class = classify(gpu.device_facts());
    let high = preset_quality(QualityPreset::High, class);
    let msaa = genex_render::presets::with_world_samples(&high, genex_render::renderer::MSAA_SAMPLES, class);
    assert!(!msaa.anti_aliasing.temporal() && high.anti_aliasing.temporal(), "the two sides differ in their anti-aliasing");
    let without = city_cpu_p50(&gpu, class, &msaa, TAA_CPU_REPEATS);
    let with = city_cpu_p50(&gpu, class, &high, TAA_CPU_REPEATS);
    eprintln!("bench-city CPU p50 at high: MSAA {without:.3} ms, TAA {with:.3} ms (+{:.3})", with - without);
    assert!(with - without <= TAA_CPU_EXTRA_MS_MAX, "TAA adds {:.3} ms of CPU time to bench-city (MSAA {without:.3}, TAA {with:.3})", with - without);
}

/// The clustered-off row's ceiling: stress-plaza at low with the `clustered` switch off may cost at
/// most this much of low's binned GPU p95 (RX review: off looped 256 lights, 7.5x low's).
const UNCLUSTERED_CEILING: f64 = 1.25;
/// Repeats of each side of the clustered-off row; each keeps its best GPU p95.
const UNCLUSTERED_REPEATS: u32 = 3;

/// The best GPU p95 of `repeats` runs of stress-plaza at `size` under `quality` on `class`.
fn plaza_best_p95(gpu: &Gpu, stamps: &Stamps, class: DeviceClass, size: [u32; 2], quality: &Quality, repeats: u32) -> f64 {
    let (warmup, frames) = (env_u32("GENEX_PERF_WARMUP", DEFAULT_WARMUP), env_u32("GENEX_PERF_FRAMES", DEFAULT_FRAMES).max(1));
    let options = RenderOptions { msaa: genex_render::renderer::landed_samples(quality.anti_aliasing) > 1 };
    let mut best = f64::MAX;
    for _ in 0..repeats {
        let mut subject = Cell::Stress(StressId::Plaza).build(gpu, size, options);
        // The class's scene format, look and device class as the matrix sets them, then the quality.
        apply_profile(subject.renderer(), Profile::Preset(QualityPreset::Low), class);
        subject.renderer().set_quality(quality);
        let mut samples = measure(gpu, Some(stamps), warmup, frames, subject.as_mut());
        best = best.min(p95(&mut samples.gpu));
    }
    best
}

/// The `clustered` switch's off variant is the cheaper picture, never a slower one: stress-plaza
/// (1,024 lights) at low with the switch off, as a person's panel resolves it (the per-pixel loop
/// over the nearest few, `presets::cap_lights`), costs at most [`UNCLUSTERED_CEILING`] of low's.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_stress_plaza_with_clustering_switched_off_costs_no_more_than_low() {
    let Some((gpu, timestamp_problem)) = open() else { return };
    let Some(stamps) = timestamp_problem.is_none().then(|| Stamps::new(&gpu)) else {
        eprintln!("skipped: the clustered-off row needs GPU timestamps ({timestamp_problem:?})");
        return;
    };
    let class = classify(gpu.device_facts());
    let person = genex_render::presets::ClassOverride {
        preset: Some(QualityPreset::Low),
        switches: vec![(RenderFeature::Clustered, false)],
        ..genex_render::presets::ClassOverride::default()
    };
    let unclustered = genex_render::presets::profile(gpu.device_facts(), class, &genex_render::presets::RenderOverrides::default(), Some(&person)).quality;
    let low = preset_quality(QualityPreset::Low, class);
    assert!(!unclustered.lights.clustered && low.lights.clustered);
    let mut rows = Vec::new();
    let mut failures = Vec::new();
    for size in sizes() {
        let binned = plaza_best_p95(&gpu, &stamps, class, size, &low, UNCLUSTERED_REPEATS);
        let looped = plaza_best_p95(&gpu, &stamps, class, size, &unclustered, UNCLUSTERED_REPEATS);
        let ratio = looped / binned.max(1e-6);
        if ratio > UNCLUSTERED_CEILING {
            failures.push(format!("{size:?}: clustered off {looped:.3} ms against low {binned:.3} ms (x{ratio:.2})"));
        }
        rows.push(json!({ "size": size, "lowGpuP95Ms": binned, "clusteredOffGpuP95Ms": looped, "ratio": ratio, "lightsShaded": unclustered.lights.cap }));
    }
    let method = json!({ "repeats": UNCLUSTERED_REPEATS, "statistic": "best GPU p95 of the repeats", "ceiling": UNCLUSTERED_CEILING });
    let head = header(&gpu, &timestamp_problem, "render-perf-clustered-off", method);
    let record = merge(head.json, rows, vec![("class", json!(class.wire())), ("failures", json!(failures))]);
    write_record(&out_path("clustered-off", &head.sha, "GENEX_PERF_CLUSTERED_OUT"), &record);
    println!("{record:#}");
    assert!(failures.is_empty(), "the clustered switch off costs more than low: {failures:?}");
}

/// Distinct pixel values in a capture (a blank frame has one).
fn distinct_pixels(capture: &genex_render::capture::Capture) -> usize {
    capture.bgra().chunks(4).map(|p| u32::from_le_bytes([p[0], p[1], p[2], p[3]])).collect::<std::collections::BTreeSet<u32>>().len()
}

/// The stress scenes on `Renderer::new`'s default quality (`off`: the legacy renderer, the instance
/// path, no meshlets): legacy-path captures. The R2 meshlet paths by preset are
/// `metal_r2_stress_captures_by_path_and_preset`'s.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_stress_scenes_render_something_and_are_written_as_pngs() {
    let Some(gpu) = support::gpu() else { return };
    let dir = std::env::var_os("GENEX_PERF_CAPTURES").map_or_else(|| support::evidence_dir("captures/RQ0/RQ0.9"), PathBuf::from);
    std::fs::create_dir_all(&dir).expect("the captures folder");
    let mut digests = Vec::new();
    for id in StressId::ALL {
        // The occlusion hall also shows the camera risen over its walls (frame 420 of 600).
        let frames: &[u32] = if id == StressId::Occlusion { &[0, 300, 420] } else { &[0, 300] };
        for &frame in frames {
            let render = |frame: u32| {
                let mut renderer = Renderer::new(&gpu, support::SIZE[0], support::SIZE[1]).expect("renderer");
                let scene = stress::load(id, &mut OnGpu { renderer: &mut renderer, gpu: &gpu }).expect("the stress scene's meshes load");
                renderer.render(&gpu, &scene.scene(frame), genex_render::CullPath::Gpu).expect("frame");
                renderer.capture(&gpu).expect("capture")
            };
            let capture = render(frame);
            assert_eq!(render(frame).digest(), capture.digest(), "{} frame {frame}: two renders differ", id.name());
            assert!(distinct_pixels(&capture) > 256, "{} frame {frame}: the picture is nearly blank", id.name());
            support::write_png(&dir.join(format!("stress-{}-{frame}.png", id.name())), &capture);
            digests.push(format!("\"{}-{frame}\": \"{:016x}\"", id.name(), capture.digest()));
        }
    }
    let record = format!("{{\"adapter\": {:?}, \"size\": {:?}, \"digests\": {{{}}}}}\n", gpu.receipt().adapter, support::SIZE, digests.join(", "));
    std::fs::write(dir.join("stress-digests.json"), &record).expect("digests");
    println!("{record}");
}

/// The renderer follow-up's final comparison: every bench shot and stress scene at `off` (the legacy
/// renderer's picture) and at each preset as the host's class resolves it, at the showcase's world
/// size, written as `<scene>-<shot>-<profile>.png` with `final-scenes.json` into
/// `GENEX_FINAL_CAPTURES` (default `captures/final`). Each is drawn as a game's capture is
/// (`support::game_frames`: the frame renderer's settled capture, auto exposure metered on the
/// capture's own history; pass-1 gate: through `Renderer::render` no exposure node ran, so the
/// stress forest came out near black), so temporal features are converged and the picture is the
/// same on every run.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_final_bench_and_stress_captures_at_each_preset() {
    let Some(gpu) = support::gpu() else { return };
    let dir = std::env::var_os("GENEX_FINAL_CAPTURES").map_or_else(|| support::evidence_dir("captures/final"), PathBuf::from);
    std::fs::create_dir_all(&dir).expect("the captures folder");
    let class = classify(gpu.device_facts());
    let size = support::SIZE;
    let mut shots: Vec<(Cell, String, u32)> = showcase_game::bench::SHOTS.iter().map(|shot| (Cell::Bench(shot.scene), String::from(shot.name), shot.frame)).collect();
    shots.extend(StressId::ALL.into_iter().map(|id| (Cell::Stress(id), String::from("0"), 0)));
    let profiles = [Profile::Off, Profile::Preset(QualityPreset::Low), Profile::Preset(QualityPreset::Medium), Profile::Preset(QualityPreset::High), Profile::Preset(QualityPreset::Ultra)];
    let mut rows = Vec::new();
    let mut blank = Vec::new();
    let mut lifted = Vec::new();
    for (cell, shot, frame) in &shots {
        let mut off_luma = None;
        for profile in profiles {
            let quality = profile.preset().map(|preset| preset_quality(preset, class));
            let load = |meshes: &mut OnGpu<'_>| cell.scene(meshes, *frame);
            let frames = support::game_frames(&gpu, class, quality.as_ref(), &scene_look(*cell), &load);
            let applied = Applied { profile, class, quality: quality.unwrap_or_else(Quality::off) };
            let settle = frames.settle_frames();
            let capture = frames.capture(&gpu).expect("capture");
            let name = format!("{}-{shot}-{}", cell.name(), profile.name());
            if distinct_pixels(&capture) <= 256 {
                blank.push(name.clone());
            }
            // A dusk scene stays dusk: the HDR presets keep the legacy picture's brightness within
            // a stop either way (gate finding 04: auto exposure lifted the plaza's lamp-lit dusk
            // from luma 37 to a pink-white day at 147, and its light pools barely read).
            let luma = mean_luma(&capture);
            match off_luma {
                None => off_luma = Some(luma),
                Some(off) if matches!(cell, Cell::Stress(StressId::Plaza)) && (luma / off).log2().abs() > NIGHT_EV_TOLERANCE => {
                    lifted.push(format!("{name}: mean luma {luma:.1} against the legacy picture's {off:.1}"));
                }
                Some(_) => {}
            }
            support::write_png(&dir.join(format!("{name}.png")), &capture);
            let mut row = applied.drawn_json(frames.renderer(), Content::default());
            row["scene"] = json!(cell.name());
            row["shot"] = json!(shot);
            row["settleFrames"] = json!(settle);
            row["digest"] = json!(format!("{:016x}", capture.digest()));
            rows.push(row);
        }
    }
    let record = json!({ "adapter": gpu.receipt().adapter, "class": class.wire(), "size": size, "rows": rows });
    std::fs::write(dir.join("final-scenes.json"), format!("{record:#}\n")).expect("final-scenes.json");
    assert!(blank.is_empty(), "nearly blank pictures: {blank:?}");
    assert!(lifted.is_empty(), "the dusk plaza drawn as day: {lifted:#?}");
}

/// How far (EV) a dusk scene's HDR capture may sit from its legacy picture's mean luma.
const NIGHT_EV_TOLERANCE: f64 = 1.0;

/// The mean encoded luma (0..255) of `capture`.
fn mean_luma(capture: &genex_render::capture::Capture) -> f64 {
    let pixels = capture.bgra().chunks(4);
    let count = pixels.len() as f64;
    pixels.map(|p| 0.0722 * f64::from(p[0]) + 0.7152 * f64::from(p[1]) + 0.2126 * f64::from(p[2])).sum::<f64>() / count
}

/// Plan R2: the occlusion path saves at least this share of the instance path's GPU time in the
/// occlusion scene.
const OCCLUSION_SAVING_TARGET: f64 = 0.30;
/// Plan R2: the meshlet path runs at most this many times the instance path's vertex invocations.
const VERTEX_INVOCATION_LIMIT: f64 = 1.3;
/// Plan R2 (R2 review): a meshlet path costs at most this share more GPU time than the instance
/// path on a scene it cannot save on; gated on an immediate-mode GPU like the saving.
const OVERHEAD_LIMIT: f64 = 0.05;
/// R2 review: a meshlet path's CPU p95 over the instance path's that the record calls within its
/// limit (informational: the paths are opt-in, so the CPU cost is the game's to accept).
const CPU_P95_LIMIT: f64 = 1.10;
/// Measured repeats of each path row; a row keeps its best (a shared machine only adds time).
const PATH_REPEATS: u32 = 3;
/// The mobile-high class's reference proxy: the Mac's tile GPU drawing what a phone would.
const TILE_PROXY: DeviceClass = DeviceClass::new(FormFactor::Mobile, PerformanceTier::High);

/// How a geometry row draws the big meshes: the instance path (the indexed batches and the
/// compute cull), meshlets alone, or meshlets with two-pass Hi-Z occlusion.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum GeometryPath {
    Instance,
    Meshlets,
    Occlusion,
}

impl GeometryPath {
    const ALL: [GeometryPath; 3] = [GeometryPath::Instance, GeometryPath::Meshlets, GeometryPath::Occlusion];

    fn name(self) -> &'static str {
        match self {
            GeometryPath::Instance => "instance",
            GeometryPath::Meshlets => "meshlets",
            GeometryPath::Occlusion => "occlusion",
        }
    }

    /// `quality` with this path's two switches and nothing else changed.
    fn apply(self, quality: &mut Quality) {
        quality.set_feature(RenderFeature::Meshlets, self != GeometryPath::Instance);
        quality.set_feature(RenderFeature::Occlusion, self == GeometryPath::Occlusion);
    }

    /// What the renderer drew of this path's switches in its last frame: (meshlets, occlusion). The
    /// switches only ask: occlusion needs the frame's prepass, which tile MSAA presets leave off,
    /// and a one-sample world pass.
    fn drawn(stats: &FrameStats) -> (bool, bool) {
        (stats.meshlet_views > 0, stats.occlusion)
    }
}

/// The world pass a path row draws: the preset's (MSAA 4x, also for TAA until it lands) or one
/// sample per pixel, the only world pass occlusion runs over (R2 review: its Hi-Z holds the
/// single-sample prepass's depth at pixel centres).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WorldSamples {
    Preset,
    One,
}

impl WorldSamples {
    fn name(self) -> &'static str {
        match self {
            WorldSamples::Preset => "preset",
            WorldSamples::One => "one",
        }
    }
}

/// The path rows of a scene, each compared with the instance row of its sample count: meshlets
/// over the preset's MSAA world pass, and meshlets with and without occlusion over one sample.
const PATH_ROWS: [(GeometryPath, WorldSamples); 5] = [
    (GeometryPath::Instance, WorldSamples::Preset),
    (GeometryPath::Meshlets, WorldSamples::Preset),
    (GeometryPath::Instance, WorldSamples::One),
    (GeometryPath::Meshlets, WorldSamples::One),
    (GeometryPath::Occlusion, WorldSamples::One),
];

/// What one path row measured.
#[derive(Clone, Copy, Debug)]
struct PathResult {
    /// (meshlets, occlusion) as the renderer's last frame drew them: a path it did not draw is the
    /// instance path under another name, and its time says nothing.
    drawn: (bool, bool),
    gpu_p50_ms: Option<f64>,
    frame_p50_ms: f64,
    cpu_p95_ms: f64,
    /// Vertex-shader invocations of the frame when the renderer reports them (`None`: it does not).
    vertex_invocations: Option<u64>,
}

/// A path row against the instance row of its scene.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Comparison {
    /// Whether the row draws its path, so its time is a measurement of it.
    measured: bool,
    /// `1 - path / instance` of the GPU p50 (the frame p50 without timestamps).
    saving: Option<f64>,
    /// For the occlusion path: whether the saving reaches [`OCCLUSION_SAVING_TARGET`].
    meets_saving: Option<bool>,
    /// Whether the path costs at most [`OVERHEAD_LIMIT`] more than the instance path.
    within_overhead: Option<bool>,
    /// The path's vertex invocations over the instance path's, when both are reported.
    vertex_ratio: Option<f64>,
    vertex_ratio_ok: Option<bool>,
    /// The path's CPU p95 over the instance path's.
    cpu_p95_ratio: Option<f64>,
}

fn compare(instance: &PathResult, row: &PathResult, path: GeometryPath) -> Comparison {
    let drawn = match path {
        GeometryPath::Instance => false,
        GeometryPath::Meshlets => row.drawn.0,
        GeometryPath::Occlusion => row.drawn.0 && row.drawn.1,
    };
    if !drawn {
        return Comparison { measured: false, saving: None, meets_saving: None, within_overhead: None, vertex_ratio: None, vertex_ratio_ok: None, cpu_p95_ratio: None };
    }
    let (from, to) = match (instance.gpu_p50_ms, row.gpu_p50_ms) {
        (Some(from), Some(to)) => (from, to),
        _ => (instance.frame_p50_ms, row.frame_p50_ms),
    };
    let saving = 1.0 - to / from;
    let vertex_ratio = match (instance.vertex_invocations, row.vertex_invocations) {
        (Some(from), Some(to)) if from > 0 => Some(to as f64 / from as f64),
        _ => None,
    };
    Comparison {
        measured: true,
        saving: Some(saving),
        meets_saving: (path == GeometryPath::Occlusion).then_some(saving >= OCCLUSION_SAVING_TARGET),
        within_overhead: Some(saving >= -OVERHEAD_LIMIT),
        vertex_ratio,
        vertex_ratio_ok: vertex_ratio.map(|ratio| ratio <= VERTEX_INVOCATION_LIMIT),
        cpu_p95_ratio: (instance.cpu_p95_ms > 0.0).then(|| row.cpu_p95_ms / instance.cpu_p95_ms),
    }
}

impl Comparison {
    fn json(&self) -> Value {
        let round = |v: f64| (v * 1000.0).round() / 1000.0;
        json!({
            "measured": self.measured,
            "saving": self.saving.map(round),
            "meetsSavingTarget": self.meets_saving,
            "withinOverheadLimit": self.within_overhead,
            "vertexRatio": self.vertex_ratio.map(round),
            "vertexRatioWithinLimit": self.vertex_ratio_ok,
            "cpuP95Ratio": self.cpu_p95_ratio.map(round),
            "cpuP95WithinLimit": self.cpu_p95_ratio.map(|ratio| ratio <= CPU_P95_LIMIT),
        })
    }

    /// Whether the row breaks a target it was measured against: the saving (occlusion scene) and
    /// the overhead (forest) only where `gate_time` (an immediate-mode GPU, plan §2.4 and G5: a tile
    /// GPU's times are informational), the vertex ratio on every adapter (it counts indices, which
    /// no GPU architecture changes).
    fn failed(&self, gate_saving: bool, gate_overhead: bool) -> bool {
        let saving = gate_saving && self.meets_saving == Some(false);
        let overhead = gate_overhead && self.within_overhead == Some(false);
        saving || overhead || self.vertex_ratio_ok == Some(false)
    }
}

/// Indices the instance path sends to the vertex stage for the camera view, split by whether the
/// meshlet path draws the mesh as meshlets (`clustered`) or whole.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct InstanceIndices {
    clustered: u64,
    whole: u64,
}

/// The camera view's frustum-visible instances of `scene` as the indexed instance path draws
/// them, in indices (an index is a vertex-shader invocation before the post-transform cache,
/// which both paths enjoy alike). A batch is `clustered` when `library` clusters its mesh.
fn instance_indices(scene: &Scene, library: &MeshLibrary, aspect: f32) -> InstanceIndices {
    let plan = FramePlan::build(scene, library, aspect).expect("the scene plans");
    let cull = plan.cpu_cull();
    let clustered_starts: Vec<u32> = scene
        .draws
        .iter()
        .filter(|draw| matches!(library.meshlet_state(draw.mesh), Some(MeshletState::Clustered(_))))
        .filter_map(|draw| library.entry(draw.mesh).map(|entry| entry.first_index))
        .collect();
    let mut total = InstanceIndices { clustered: 0, whole: 0 };
    for (batch, visible) in plan.batches.iter().zip(&cull.counts).take(plan.static_batches as usize) {
        let indices = u64::from(*visible) * u64::from(batch.index_count);
        if clustered_starts.contains(&batch.first_index) {
            total.clustered += indices;
        } else {
            total.whole += indices;
        }
    }
    total
}

/// Vertex invocations of the camera view for `path` over `instance`'s split: the instance path
/// sends every visible index; the meshlet paths send the whole meshes' indices and the meshlets'
/// kept indices (`kept`: both passes of the camera when occlusion ran). Shadow views and the
/// prepass repeat the same shape on both paths and are left out.
fn path_vertex_invocations(path: GeometryPath, instance: InstanceIndices, kept: u64) -> u64 {
    match path {
        GeometryPath::Instance => instance.clustered + instance.whole,
        GeometryPath::Meshlets | GeometryPath::Occlusion => instance.whole + kept,
    }
}

/// Vertex invocations of the renderer's last frame (`frame` of `subject`) on `path`, when the
/// path drew it and the scene is a function of the frame index; `None` otherwise. The renderer
/// has no pipeline-statistics counter (Metal has none), so it is counted from the indices the
/// cull kept ([`Renderer::read_meshlets`]) and the CPU reference cull of the instance path.
fn reported_vertex_invocations(gpu: &Gpu, subject: &mut dyn Subject, frame: u32, path: GeometryPath, drawn: (bool, bool), size: [u32; 2]) -> Option<u64> {
    let scene = subject.scene_at(frame)?;
    let aspect = size[0] as f32 / size[1] as f32;
    let counts = instance_indices(&scene, subject.renderer().library(), aspect);
    if path == GeometryPath::Instance {
        return Some(path_vertex_invocations(path, counts, 0));
    }
    if !drawn.0 {
        return None;
    }
    let read = subject.renderer().read_meshlets(gpu).ok()?;
    let mut kept = u64::from(read.kept_indices(0, CullPass::First));
    if drawn.1 {
        kept += u64::from(read.kept_indices(0, CullPass::Second));
    }
    Some(path_vertex_invocations(path, counts, kept))
}

const VERTEX_REASON: &str = "not-counted: the path did not draw meshlets, or the scene follows the simulation instead of the frame index";

/// One repeat of a path row: its ranking time (GPU p50, else frame p50), samples and what it drew.
struct PathRepeat {
    key: f64,
    samples: Samples,
    drawn: (bool, bool),
    vertices: Option<u64>,
}

/// The stress scene `id` on a fresh renderer of `size` whose world pass draws `samples`.
fn stress_subject(gpu: &Gpu, id: StressId, size: [u32; 2], samples: WorldSamples) -> Box<dyn Subject> {
    let mut renderer = Renderer::with_options(gpu, size[0], size[1], RenderOptions { msaa: samples == WorldSamples::Preset }).expect("renderer");
    let scene = stress::load(id, &mut OnGpu { renderer: &mut renderer, gpu }).expect("the stress scene's meshes load");
    Box::new(IndexedSubject { renderer, scene: Box::new(move |frame| scene.scene(frame)), facts: Value::Null })
}

/// `class`'s `preset` quality with `path`'s two switches, over a one-sample world pass when
/// `samples` asks for it (anti-aliasing off). The occlusion path brings the prepass its Hi-Z is
/// built from (tile MSAA presets leave it off), so a tile class's occlusion row measures occlusion
/// with its whole cost instead of the meshlets alone (R2 review).
fn path_quality(renderer: &mut Renderer, preset: QualityPreset, class: DeviceClass, path: GeometryPath, samples: WorldSamples) -> Quality {
    let mut applied = apply_profile(renderer, Profile::Preset(preset), class);
    path.apply(&mut applied.quality);
    if samples == WorldSamples::One {
        applied.quality.anti_aliasing = AntiAliasing::Off;
    }
    if path == GeometryPath::Occlusion {
        applied.quality.set_feature(RenderFeature::Prepass, true);
    }
    renderer.set_quality(&applied.quality);
    applied.quality
}

/// One scene on one class under one path over the `world` samples, `PATH_REPEATS` times: the best
/// repeat by GPU p50.
fn path_row(gpu: &Gpu, stamps: Option<&Stamps>, class: DeviceClass, scene: StressId, size: [u32; 2], (path, world): (GeometryPath, WorldSamples)) -> (PathResult, Value) {
    let (warmup, frames) = (env_u32("GENEX_PERF_WARMUP", DEFAULT_WARMUP), env_u32("GENEX_PERF_FRAMES", DEFAULT_FRAMES).max(1));
    let tile = class.form == FormFactor::Mobile;
    let mut best: Option<PathRepeat> = None;
    let mut repeats = Vec::new();
    for _ in 0..PATH_REPEATS {
        let mut subject = stress_subject(gpu, scene, size, world);
        path_quality(subject.renderer(), QualityPreset::High, class, path, world);
        if tile {
            subject.renderer().set_render_scale(class_defaults(class).nominal_scale);
        }
        let mut samples = measure(gpu, stamps, warmup, frames, subject.as_mut());
        let drawn = GeometryPath::drawn(&subject.renderer().last_stats());
        let vertices = reported_vertex_invocations(gpu, subject.as_mut(), warmup + frames - 1, path, drawn, size);
        let key = if samples.gpu.is_empty() { p50(&mut samples.frame) } else { p50(&mut samples.gpu) };
        repeats.push((key * 1000.0).round() / 1000.0);
        if best.as_ref().is_none_or(|kept| key < kept.key) {
            best = Some(PathRepeat { key, samples, drawn, vertices });
        }
    }
    let PathRepeat { mut samples, drawn, vertices, .. } = best.expect("a repeat");
    let result = PathResult {
        drawn,
        gpu_p50_ms: (!samples.gpu.is_empty()).then(|| p50(&mut samples.gpu)),
        frame_p50_ms: p50(&mut samples.frame),
        cpu_p95_ms: p95(&mut samples.cpu),
        vertex_invocations: vertices,
    };
    let row = json!({
        "class": class.wire(),
        "scene": scene.name(),
        "path": path.name(),
        "worldSamples": world.name(),
        "size": size,
        "preset": QualityPreset::High.wire(),
        "meshletsDrawn": drawn.0,
        "occlusionDrawn": drawn.1,
        "cpuMs": summary(&mut samples.cpu),
        "frameMs": summary(&mut samples.frame),
        "gpuMs": summary(&mut samples.gpu),
        "repeatsP50Ms": repeats,
        "vertexInvocations": vertices,
        "vertexInvocationsReason": if vertices.is_none() { json!(VERTEX_REASON) } else { Value::Null },
    });
    (result, row)
}

/// p50 of `values` (0 when empty).
fn p50(values: &mut [f64]) -> f64 {
    values.sort_by(f64::total_cmp);
    if values.is_empty() { 0.0 } else { support::percentile(values, 0.5) }
}

/// The instance path, meshlets and meshlets with Hi-Z occlusion on the forest and the occlusion
/// scene, on the host's class (1080p) and on the mobile-high tile proxy (its reference resolution
/// at its nominal scale): `meshlet-paths-<sha>.json` in the perf folder. Meshlets are measured
/// over the preset's world pass (MSAA 4x) and over one sample; occlusion only over one sample, the
/// only world pass it runs over (R2 review). Each path row is compared with the instance row of
/// its sample count. The plan's acceptance reads off it: at least [`OCCLUSION_SAVING_TARGET`] of
/// the GPU time saved in the occlusion scene, at most [`OVERHEAD_LIMIT`] more in the forest, and
/// at most [`VERTEX_INVOCATION_LIMIT`] times the instance path's vertex invocations; the record's
/// `acceptance` says whether this adapter could judge the time targets (an immediate-mode GPU) or
/// only reports them (a tile GPU). The presets follow it (`presets::GEOMETRY_PATH_DEFAULT`). A path
/// this build does not draw is recorded `measured: false` and judged by nobody.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_meshlet_paths_compare_the_instance_path_with_meshlets_and_occlusion() {
    let Some((gpu, timestamp_problem)) = open() else { return };
    let stamps = timestamp_problem.is_none().then(|| Stamps::new(&gpu));
    let host_class = classify(gpu.device_facts());
    let tile_adapter = gpu.device_facts().transient_saves_memory();
    let tile_size = reference_resolution(TILE_PROXY);
    let cases = [(host_class, [1920, 1080]), (TILE_PROXY, [tile_size.0, tile_size.1])];
    let (mut rows, mut comparisons, mut failures) = (Vec::new(), Vec::new(), Vec::new());
    for (class, size) in cases {
        for scene in [StressId::Occlusion, StressId::Forest] {
            let results: Vec<((GeometryPath, WorldSamples), PathResult)> = PATH_ROWS
                .into_iter()
                .map(|key| {
                    let (result, row) = path_row(&gpu, stamps.as_ref(), class, scene, size, key);
                    rows.push(row);
                    eprintln!("{} {} {} {} done", class.wire(), scene.name(), key.0.name(), key.1.name());
                    (key, result)
                })
                .collect();
            for ((path, world), result) in results.iter().filter(|((path, _), _)| *path != GeometryPath::Instance) {
                let Some((_, instance)) = results.iter().find(|((p, w), _)| *p == GeometryPath::Instance && w == world) else { continue };
                let comparison = compare(instance, result, *path);
                // The time targets are for the host's class on an immediate-mode GPU; a tile GPU
                // (the Mac's, the proxy) reports them and the presets follow them, never a pass.
                // The vertex ratio gates the host's class on both scenes: it counts indices,
                // whatever the GPU.
                let host = class == host_class && !tile_adapter;
                let gate_saving = host && scene == StressId::Occlusion;
                let gate_overhead = host && scene == StressId::Forest;
                let gate_ratio = class == host_class;
                if gate_ratio && comparison.failed(gate_saving, gate_overhead) {
                    failures.push(format!("{} {} {} {}: {comparison:?}", class.wire(), scene.name(), path.name(), world.name()));
                }
                comparisons.push(json!({
                    "class": class.wire(), "scene": scene.name(), "path": path.name(), "worldSamples": world.name(),
                    "gatedSaving": gate_saving, "gatedOverhead": gate_overhead, "gatedVertexRatio": gate_ratio,
                    "against": format!("instance ({})", world.name()), "result": comparison.json(),
                }));
            }
        }
    }
    let landed = genex_render::meshlet_cull::LANDED;
    let method = json!({
        "warmupFrames": env_u32("GENEX_PERF_WARMUP", DEFAULT_WARMUP),
        "measuredFrames": env_u32("GENEX_PERF_FRAMES", DEFAULT_FRAMES).max(1),
        "repeats": PATH_REPEATS,
        "statistic": "best repeat by GPU p50 (frame p50 without timestamps); CPU p95 of that repeat",
        "preset": "high",
        "worldSamples": "preset: the preset's MSAA 4x world pass; one: anti-aliasing off (occlusion runs only there)",
        "savingTarget": OCCLUSION_SAVING_TARGET,
        "overheadLimit": OVERHEAD_LIMIT,
        "cpuP95Limit": CPU_P95_LIMIT,
        "vertexInvocationLimit": VERTEX_INVOCATION_LIMIT,
        "meshletPathLanded": landed,
        "tileAdapter": tile_adapter,
        "savingGatedOnThisAdapter": !tile_adapter,
        "note": "a path the build does not draw is recorded measured:false; the tile proxy is the Mac's TBDR GPU at the mobile-high reference, never a device claim",
    });
    // `passed` is the gates this adapter could judge; `acceptance` says whether that includes the
    // time targets, so a tile adapter's pass is never read as the plan's acceptance.
    let acceptance = if tile_adapter {
        "time targets unmeasured: a tile adapter only reports them; the presets default meshlets and occlusion off"
    } else if failures.is_empty() {
        "met on this immediate-mode adapter"
    } else {
        "missed on this immediate-mode adapter"
    };
    let head = header(&gpu, &timestamp_problem, "render-perf-meshlet-paths", method);
    let extra = vec![
        ("comparisons", Value::Array(comparisons)),
        ("passed", Value::Bool(failures.is_empty())),
        ("acceptance", json!(acceptance)),
        ("presetsDefaultOn", json!(genex_render::presets::GEOMETRY_PATH_DEFAULT)),
        ("failures", json!(failures)),
    ];
    let record = merge(head.json, rows, extra);
    write_record(&out_path("meshlet-paths", &head.sha, "GENEX_PERF_PATHS_OUT"), &record);
    println!("{record:#}");
    assert!(failures.is_empty(), "a meshlet path misses its target on the host: {failures:?}");
}

/// The presets' stress captures by geometry path (R2 review): every stress scene at each preset on
/// the host's class, drawn by the instance path and by meshlets over the preset's MSAA world pass,
/// and by the instance path and meshlets with occlusion over one sample, at the showcase's world
/// size. Writes each picture as a PNG, the digests and each meshlet picture's differing pixels
/// against its instance picture (`r2-paths.json`) into `GENEX_R2_CAPTURES` (default
/// `captures/R2/review`). The meshlet pictures must equal their instance pictures.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_r2_stress_captures_by_path_and_preset() {
    let Some(gpu) = support::gpu() else { return };
    let dir = std::env::var_os("GENEX_R2_CAPTURES").map_or_else(|| support::evidence_dir("captures/R2/review"), PathBuf::from);
    std::fs::create_dir_all(&dir).expect("the captures folder");
    let class = classify(gpu.device_facts());
    let size = support::SIZE;
    let (mut rows, mut differing) = (Vec::new(), Vec::new());
    for id in StressId::ALL {
        let frames: &[u32] = if id == StressId::Occlusion { &[0, 420] } else { &[0] };
        for &frame in frames {
            for preset in QualityPreset::ALL {
                let mut pictures = Vec::new();
                for key in PATH_ROWS.into_iter().filter(|(path, world)| *path != GeometryPath::Meshlets || *world == WorldSamples::Preset) {
                    let mut subject = stress_subject(&gpu, id, size, key.1);
                    path_quality(subject.renderer(), preset, class, key.0, key.1);
                    // Two frames: the second draws with the first's visibility history.
                    for at in [frame.saturating_sub(1), frame] {
                        subject.renderer().set_frame_index(u64::from(at));
                        subject.frame(&gpu, at, None);
                    }
                    let drawn = GeometryPath::drawn(&subject.renderer().last_stats());
                    let capture = subject.renderer().capture(&gpu).expect("capture");
                    let name = format!("{}-{frame}-{}-{}-{}", id.name(), preset.wire(), key.0.name(), key.1.name());
                    support::write_png(&dir.join(format!("{name}.png")), &capture);
                    pictures.push((key, drawn, capture));
                }
                for (key, drawn, capture) in pictures.iter().filter(|((path, _), _, _)| *path != GeometryPath::Instance) {
                    let Some((_, _, instance)) = pictures.iter().find(|((path, world), _, _)| *path == GeometryPath::Instance && *world == key.1) else { continue };
                    let pixels = capture.bgra().chunks(4).zip(instance.bgra().chunks(4)).filter(|(a, b)| a != b).count();
                    let at = format!("{} {frame} {} {} {}", id.name(), preset.wire(), key.0.name(), key.1.name());
                    if pixels > 0 {
                        differing.push(format!("{at}: {pixels} pixels"));
                    }
                    rows.push(json!({
                        "scene": id.name(), "frame": frame, "preset": preset.wire(), "path": key.0.name(), "worldSamples": key.1.name(),
                        "meshletsDrawn": drawn.0, "occlusionDrawn": drawn.1, "digest": format!("{:016x}", capture.digest()),
                        "instanceDigest": format!("{:016x}", instance.digest()), "differingPixels": pixels,
                    }));
                }
            }
        }
    }
    let record = json!({ "adapter": gpu.receipt().adapter, "class": class.wire(), "size": size, "rows": rows, "differing": differing });
    std::fs::write(dir.join("r2-paths.json"), format!("{record:#}\n")).expect("r2-paths.json");
    assert!(differing.is_empty(), "meshlet pictures differ from the instance path's: {differing:?}");
}

// The CPU rows: the stress scenes are what the plan says they are, and the matrix's own plumbing.

fn library_of(id: StressId) -> (Box<dyn stress::StressScene>, MeshLibrary) {
    let mut library = MeshLibrary::new();
    let scene = stress::load(id, &mut library).expect("the stress scene's meshes load");
    (scene, library)
}

#[test]
fn the_plaza_has_a_thousand_and_twenty_four_lights_over_two_hundred_metres() {
    let (scene, _) = library_of(StressId::Plaza);
    let drawn = scene.scene(0);
    assert_eq!(drawn.lighting.points.len(), PLAZA_LIGHTS);
    assert_eq!(PLAZA_LIGHTS, 1024);
    assert_eq!(PLAZA_SIDE, 200.0);
    let half = PLAZA_SIDE * 0.5;
    for light in &drawn.lighting.points {
        assert!(light.position[0].abs() < half && light.position[2].abs() < half, "a light outside the plaza: {:?}", light.position);
    }
    let mut spread = drawn.lighting.points.iter().map(|l| (l.position[0] / 3.0).floor() as i32 * 1000 + (l.position[2] / 3.0).floor() as i32).collect::<Vec<_>>();
    spread.sort_unstable();
    spread.dedup();
    assert!(spread.len() > 900, "the lights bunch up: {} distinct 3 m cells", spread.len());
}

#[test]
fn the_plaza_lists_the_lights_nearest_the_camera_first() {
    let (scene, _) = library_of(StressId::Plaza);
    for frame in [0, 150, 411] {
        let drawn = scene.scene(frame);
        let eye = drawn.camera.eye;
        let distance = |l: &genex_render::scene::PointLight| (0..3).map(|k| (l.position[k] - eye[k]) * (l.position[k] - eye[k])).sum::<f32>();
        let listed: Vec<f32> = drawn.lighting.points.iter().map(distance).collect();
        assert!(listed.windows(2).all(|pair| pair[0] <= pair[1]), "frame {frame}: the lights are not nearest first");
    }
}

#[test]
fn the_forest_draws_about_one_and_a_half_million_triangles() {
    let (scene, library) = library_of(StressId::Forest);
    let triangles = stress::triangles(&scene.scene(0), &library);
    let wanted = FOREST_TRIANGLES as f64;
    assert!(
        ((triangles as f64) - wanted).abs() <= wanted * FOREST_TOLERANCE,
        "{triangles} triangles, wanted {FOREST_TRIANGLES} within {}%",
        FOREST_TOLERANCE * 100.0
    );
    // Every frame of the path draws the same forest; only the camera moves.
    assert_eq!(stress::triangles(&scene.scene(299), &library), triangles);
}

#[test]
fn the_forest_camera_looks_at_a_part_of_the_forest() {
    use genex_render::scene::FramePlan;
    let (scene, library) = library_of(StressId::Forest);
    let drawn = scene.scene(0);
    let plan = FramePlan::build(&drawn, &library, 16.0 / 9.0).expect("the forest plans");
    let inside_frustum: u64 = plan.cpu_cull().counts.iter().map(|&c| u64::from(c)).sum();
    let total = drawn.draws.len() as u64;
    assert!(inside_frustum > 0, "the camera sees no tree");
    assert!(inside_frustum * 3 < total * 2, "the frustum keeps {inside_frustum} of {total} instances: the camera should look at a part of the forest");
}

#[test]
fn stress_scenes_are_functions_of_the_frame_and_their_cameras_loop() {
    for id in StressId::ALL {
        let (a, _) = library_of(id);
        let (b, _) = library_of(id);
        assert_eq!(a.scene(120), b.scene(120), "{}: two loads disagree at one frame", id.name());
        assert_ne!(a.scene(0).camera, a.scene(120).camera, "{}: the camera does not move", id.name());
        assert_eq!(a.scene(7).camera, a.scene(7 + showcase_game::bench::PATH_FRAMES).camera, "{}: the camera path does not loop", id.name());
    }
}

#[test]
fn the_asset_table_is_read_once_so_a_frame_does_not_read_or_leak_the_glbs_again() {
    // The lakeside asks for the table every frame it draws; a per-call read leaked 3.6 MB a frame.
    let (first, second) = (showcase_game::assets(), showcase_game::assets());
    assert!(!first.is_empty(), "the showcase has GLB assets");
    assert!(std::ptr::eq(first.as_ptr(), second.as_ptr()), "every call returns the table the first one read");
}

#[test]
fn the_matrix_names_fifteen_scenes_and_five_profiles() {
    // Nine Lakeside shots (pass 1's five and Lakeside v2's four), three bench and three stress scenes.
    let names: Vec<String> = Cell::all().into_iter().map(Cell::name).collect();
    assert_eq!(names.len(), 15, "{names:?}");
    let lakeside = [
        "lakeside-wide",
        "lakeside-dock",
        "lakeside-cabin",
        "lakeside-forest",
        "lakeside-closeup",
        "lakeside-golden-wide",
        "lakeside-shore",
        "lakeside-forest-floor",
        "lakeside-cabin-interior",
    ];
    for want in lakeside.into_iter().chain(["bench-materials", "bench-outdoor", "bench-city", "stress-plaza", "stress-forest", "stress-occlusion"]) {
        assert!(names.iter().any(|n| n == want), "no {want} in {names:?}");
    }
    let all: Vec<String> = DEFAULT_PROFILES.split(',').filter_map(Profile::from_name).map(Profile::name).collect();
    assert_eq!(all, ["off", "low", "medium", "high", "ultra", "medium@0.75", "high@0.67"]);
    assert_eq!(Profile::from_name("potato"), None);
    assert_eq!(Profile::from_name("high@1.5"), None, "a scale above 1 is no profile");
    assert_eq!(Profile::from_name("high@0.67").map(Profile::scale), Some(0.67));
}

#[test]
fn a_profile_requests_its_presets_features_and_off_requests_only_the_legacy_shadows() {
    let class = DeviceClass::new(FormFactor::Desktop, PerformanceTier::Ultra);
    let off = Applied { profile: Profile::Off, class, quality: Quality::off() }.json();
    assert_eq!(off["profile"], "off");
    // The legacy renderer has its two-cascade shadows and nothing else.
    assert_eq!(off["featuresRequested"], json!(["shadows"]));
    assert_eq!(off["wired"], false);
    let ultra = Applied { profile: Profile::Preset(QualityPreset::Ultra), class, quality: preset_quality(QualityPreset::Ultra, class) }.json();
    assert_eq!(ultra["profile"], "ultra");
    assert_eq!(ultra["class"], "desktop-ultra");
    assert!(ultra["featuresRequested"].as_array().is_some_and(|features| !features.is_empty()), "ultra requests no feature");
    assert_eq!(ultra["wired"], RENDERER_CONSUMES_QUALITY);
}

#[test]
fn a_sky_with_clouds_is_charged_the_cloud_budget_where_the_preset_marches_them() {
    let clouded = Content { clouds: true, ..Content::default() };
    let charged = |class: DeviceClass, preset: QualityPreset, content: Content| {
        stage_a_drawn(&preset_quality(preset, class), &Look::default(), true, content).iter().any(|(feature, _)| *feature == "clouds")
    };
    let desktop = DeviceClass::new(FormFactor::Desktop, PerformanceTier::High);
    assert!(charged(desktop, QualityPreset::High, clouded), "desktop high marches the cloud panorama");
    assert!(!charged(desktop, QualityPreset::High, Content::default()), "a sky without a layer draws no clouds");
    assert!(!charged(desktop, QualityPreset::Low, clouded), "low marches no panorama");
    let phone = DeviceClass::new(FormFactor::Mobile, PerformanceTier::High);
    assert!(!charged(phone, QualityPreset::High, clouded), "phones march no clouds (D16)");
}

#[test]
fn the_occlusion_scene_draws_about_a_million_triangles_and_walls_hide_most_of_them_at_ground_level() {
    let (scene, library) = library_of(StressId::Occlusion);
    let triangles = stress::triangles(&scene.scene(0), &library);
    let wanted = OCCLUSION_TRIANGLES as f64;
    assert!(((triangles as f64) - wanted).abs() <= wanted * OCCLUSION_TOLERANCE, "{triangles} triangles, wanted {OCCLUSION_TRIANGLES}");
    // Big meshes carry the triangles, so the R2 path has work: each statue clusters.
    let threshold = u64::from(genex_render::settings::DEFAULT_MESHLET_MIN_TRIANGLES);
    let clustered: u64 =
        scene.scene(0).draws.iter().filter_map(|draw| library.entry(draw.mesh)).map(|entry| u64::from(entry.index_count) / 3).filter(|t| *t >= threshold).sum();
    assert!(clustered * 100 >= triangles * 95, "only {clustered} of {triangles} triangles are in meshes big enough to cluster");
    let frames: Vec<f32> = (0..showcase_game::bench::PATH_FRAMES).step_by(10).map(stress::occlusion_hidden_share).collect();
    assert!(frames[0] >= 0.8, "at ground level the walls hide {:.0}% of the statues", frames[0] * 100.0);
    assert!(frames.iter().any(|share| *share <= 0.3), "the camera never rises over the walls, so nothing is ever disoccluded");
    assert!(frames.iter().filter(|share| **share >= 0.7).count() * 2 >= frames.len(), "the walls should hide at least 70% of the statues for half of the path");
}

#[test]
fn a_path_row_switches_only_meshlets_and_occlusion() {
    let class = DeviceClass::new(FormFactor::Desktop, PerformanceTier::High);
    let base = preset_quality(QualityPreset::High, class);
    let mut qualities = Vec::new();
    for path in GeometryPath::ALL {
        let mut quality = base;
        path.apply(&mut quality);
        qualities.push((path.name(), quality.meshlets, quality.occlusion));
        let mut restored = quality;
        restored.meshlets = base.meshlets;
        restored.occlusion = base.occlusion;
        assert_eq!(restored, base, "{}: the path moved a feature besides meshlets and occlusion", path.name());
    }
    assert_eq!(qualities, [("instance", false, false), ("meshlets", true, false), ("occlusion", true, true)]);
}

fn result(drawn: (bool, bool), gpu_p50: Option<f64>, vertices: Option<u64>) -> PathResult {
    PathResult { drawn, gpu_p50_ms: gpu_p50, frame_p50_ms: 9.0, cpu_p95_ms: 1.0, vertex_invocations: vertices }
}

#[test]
fn the_comparison_judges_the_saving_only_where_both_paths_are_drawn() {
    let instance = result((false, false), Some(10.0), Some(1_000_000));
    // The meshlet path has not landed: both rows are the instance path, so a saving would be noise.
    let same = compare(&instance, &result((false, false), Some(6.0), None), GeometryPath::Occlusion);
    assert!(!same.measured && same.meets_saving.is_none() && same.saving.is_none(), "{same:?}");
    // Meshlets drawn but occlusion not: the occlusion row cannot be judged either.
    assert!(!compare(&instance, &result((true, false), Some(6.0), None), GeometryPath::Occlusion).measured, "an occlusion row needs occlusion drawn");
    let meshlets = compare(&instance, &result((true, false), Some(6.0), None), GeometryPath::Meshlets);
    assert!(meshlets.measured && meshlets.meets_saving.is_none(), "the target belongs to the occlusion path, not to meshlets alone: {meshlets:?}");
    let good = compare(&instance, &result((true, true), Some(6.5), Some(1_100_000)), GeometryPath::Occlusion);
    assert!(good.measured);
    assert_eq!(good.meets_saving, Some(true), "35% is past the 30% target: {good:?}");
    assert!((good.saving.expect("a saving") - 0.35).abs() < 1e-9);
    assert_eq!(good.vertex_ratio_ok, Some(true), "1.1x the instance path's vertex invocations is within 1.3x");
    let short = compare(&instance, &result((true, true), Some(8.0), Some(1_400_000)), GeometryPath::Occlusion);
    assert_eq!((short.meets_saving, short.vertex_ratio_ok), (Some(false), Some(false)), "20% saved and 1.4x the vertices");
    let unreported = compare(&instance, &result((true, true), Some(5.0), None), GeometryPath::Occlusion);
    assert_eq!(unreported.vertex_ratio_ok, None, "no vertex count reported, no claim");
    // Without timestamps the frame interval stands in for the GPU time.
    let no_stamps = compare(&result((false, false), None, None), &result((true, true), None, None), GeometryPath::Occlusion);
    assert!(no_stamps.measured && no_stamps.saving == Some(0.0), "{no_stamps:?}");
}

#[test]
fn the_forests_big_meshes_are_clustered_and_the_instance_path_counts_their_visible_indices() {
    let (scene, library) = library_of(StressId::Forest);
    let drawn = scene.scene(0);
    let counts = instance_indices(&drawn, &library, 16.0 / 9.0);
    assert!(counts.clustered > 0, "the forest has meshes big enough to cluster: {counts:?}");
    assert!(counts.whole > 0, "and meshes too small to: {counts:?}");
    // Every instance counted at most once per index: nothing past the whole scene's indices.
    let everything: u64 = drawn.draws.iter().filter_map(|draw| library.entry(draw.mesh)).map(|entry| u64::from(entry.index_count)).sum();
    assert!(counts.clustered + counts.whole <= everything, "{counts:?} over {everything}");
    assert!(counts.clustered + counts.whole > 0);
}

#[test]
fn a_meshlet_path_counts_the_whole_meshes_and_the_kept_indices_and_the_instance_path_everything() {
    let split = InstanceIndices { clustered: 900, whole: 100 };
    assert_eq!(path_vertex_invocations(GeometryPath::Instance, split, 0), 1000);
    assert_eq!(path_vertex_invocations(GeometryPath::Meshlets, split, 700), 800);
    assert_eq!(path_vertex_invocations(GeometryPath::Occlusion, split, 300), 400, "occlusion keeps fewer indices than the meshlets alone");
    // 1.3x of the instance path: the plan's limit read off the same numbers.
    let instance = result((false, false), Some(10.0), Some(path_vertex_invocations(GeometryPath::Instance, split, 0)));
    let over = result((true, false), Some(10.0), Some(path_vertex_invocations(GeometryPath::Meshlets, split, 1_300)));
    assert_eq!(compare(&instance, &over, GeometryPath::Meshlets).vertex_ratio_ok, Some(false));
}

#[test]
fn a_tile_adapters_saving_is_informational_and_its_vertex_ratio_is_not() {
    let instance = result((false, false), Some(10.0), Some(1_000_000));
    let slow = compare(&instance, &result((true, true), Some(16.0), Some(1_100_000)), GeometryPath::Occlusion);
    assert_eq!(slow.meets_saving, Some(false));
    assert!(slow.failed(true, false), "an immediate-mode GPU gates the saving");
    assert!(!slow.failed(false, false), "a tile GPU reports it");
    let wasteful = compare(&instance, &result((true, true), Some(16.0), Some(1_400_000)), GeometryPath::Occlusion);
    assert!(wasteful.failed(false, false), "the vertex ratio gates on every adapter");
}

/// R2 review: a meshlet path costing more than 5% over the instance path fails on an
/// immediate-mode GPU (the forest's gate) and is reported on a tile GPU; its CPU p95 ratio is
/// recorded beside it.
#[test]
fn the_overhead_gate_holds_a_meshlet_path_to_five_percent_on_an_immediate_mode_gpu() {
    let instance = result((false, false), Some(10.0), None);
    let within = compare(&instance, &result((true, false), Some(10.4), None), GeometryPath::Meshlets);
    assert_eq!(within.within_overhead, Some(true), "4% over is within 5%");
    assert!(!within.failed(false, true));
    let over = compare(&instance, &result((true, false), Some(11.0), None), GeometryPath::Meshlets);
    assert_eq!(over.within_overhead, Some(false), "10% over is past 5%");
    assert!(over.failed(false, true), "an immediate-mode GPU gates the overhead");
    assert!(!over.failed(false, false), "a tile GPU reports it");
    let mut slower_cpu = result((true, false), Some(10.0), None);
    slower_cpu.cpu_p95_ms = 1.3;
    let ratio = compare(&instance, &slower_cpu, GeometryPath::Meshlets).cpu_p95_ratio.expect("a ratio");
    assert!((ratio - 1.3).abs() < 1e-9, "{ratio}");
}

/// Interleaved runs of each side in the indirect-validation A/B.
const INDIRECT_AB_RUNS: u32 = 3;

/// The median of `values` (nearest rank).
fn median(values: &mut [f64]) -> f64 {
    values.sort_by(f64::total_cmp);
    values[values.len() / 2]
}

/// Renderer pass 2 (prior art's "measure first"): what wgpu's indirect-call validation costs on
/// this adapter. The same scenes at high, 1280x720, on a device with the validation (every game's)
/// and one without it (`Gpu::headless_without_indirect_validation`, measurement only), interleaved
/// [`INDIRECT_AB_RUNS`] times; the record keeps each side's median of the per-run p50s (GPU stamps
/// and whole frame). A record, not a gate: the validation stays on until the renderer proves its
/// indirect arguments in range.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_indirect_validation_cost_is_recorded() {
    let Some((gpu, timestamp_problem)) = open() else { return };
    let Ok(unvalidated) = Gpu::headless_without_indirect_validation(gpu.device_facts().features & wgpu::Features::TIMESTAMP_QUERY) else { return };
    let (warmup, frames) = (env_u32("GENEX_PERF_WARMUP", DEFAULT_WARMUP), env_u32("GENEX_PERF_FRAMES", DEFAULT_FRAMES).max(1));
    let class = classify(gpu.device_facts());
    let profile = Profile::Preset(QualityPreset::High);
    let size = [1280, 720];
    let cells = [Cell::Lakeside("wide"), Cell::Bench(SceneId::City), Cell::Stress(StressId::Forest)];
    let mut rows = Vec::new();
    for cell in cells.into_iter().filter(|cell| kept(&cell.name())) {
        let mut sides: [(Vec<f64>, Vec<f64>); 2] = Default::default();
        for _ in 0..INDIRECT_AB_RUNS {
            for (side, device) in [&gpu, &unvalidated].into_iter().enumerate() {
                let stamps = timestamp_problem.is_none().then(|| Stamps::new(device));
                let mut subject = cell.build(device, size, profile_options(profile, class));
                apply_profile(subject.renderer(), profile, class);
                let mut samples = measure(device, stamps.as_ref(), warmup, frames, subject.as_mut());
                if !samples.gpu.is_empty() {
                    sides[side].0.push(percentile_of(&mut samples.gpu, 0.5));
                }
                sides[side].1.push(percentile_of(&mut samples.frame, 0.5));
            }
        }
        let [(mut gpu_on, mut frame_on), (mut gpu_off, mut frame_off)] = sides;
        let gpu_ms = |values: &mut Vec<f64>| if values.is_empty() { Value::Null } else { json!(median(values)) };
        let row = json!({
            "row": cell.name(),
            "profile": profile.name(),
            "size": size,
            "runs": INDIRECT_AB_RUNS,
            "validated": { "gpuP50Ms": gpu_ms(&mut gpu_on), "frameP50Ms": median(&mut frame_on) },
            "unvalidated": { "gpuP50Ms": gpu_ms(&mut gpu_off), "frameP50Ms": median(&mut frame_off) },
        });
        eprintln!("{row}");
        rows.push(row);
    }
    let method = json!({
        "warmupFrames": warmup,
        "measuredFrames": frames,
        "runs": INDIRECT_AB_RUNS,
        "statistic": "median over interleaved runs of each run's nearest-rank p50",
        "sides": "validated: InstanceFlags::VALIDATION_INDIRECT_CALL (every game's device); unvalidated: the flag cleared (measurement only)",
    });
    let head = header(&gpu, &timestamp_problem, "render-indirect-validation", method);
    let record = merge(head.json, rows, Vec::new());
    write_record(&out_path("indirect-validation", &head.sha, "GENEX_PERF_OUT"), &record);
    println!("{record:#}");
}

/// The value at fraction `p` of `values` (nearest rank), sorting them.
fn percentile_of(values: &mut [f64], p: f64) -> f64 {
    values.sort_by(f64::total_cmp);
    support::percentile(values, p)
}
