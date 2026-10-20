//! Built-in pipelines compiled off the frame thread (renderer pass-1 gate).
//!
//! A cold pipeline compile is the slowest call a frame makes. On Metal each one is an MSL compile:
//! about 0.23 s inside the game box (whose profile grants no shader cache) against 0.04 s outside
//! it, and a studio run's first frame at `high` makes about sixty. Made one after another on the
//! frame thread they held a boxed game's `ready` past its 20 s deadline. The driver compiles
//! concurrently (16 MSL compiles in the box: 3.7 s one after another, 0.55 s side by side on an M4
//! Max), so every built-in pipeline is handed to the job pool's threads ([`crate::jobs`], on its
//! [`COMPILE_PRIORITY`] lane) and the renderer keeps a [`Compiled`] handle. The first use waits for it; by then the frame has handed out every
//! pipeline it needs, so they compile side by side. The pipelines and their order of use are
//! unchanged, so every picture is the same.
//!
//! On the web (no threads; the browser compiles off its own main thread) a pipeline is made where
//! it is asked for. A game's own Level-2 WGSL (materials and post passes) compiles on the same pool
//! through [`render_pipeline_checked`]: the job thread pushes its own error scopes (wgpu's are
//! per thread), so a pipeline the backend refuses after naga accepted the source comes back as an
//! error the admission turns into a typed refusal (renderer pass 2, RC-04), never the device's
//! uncaptured-error panic raised again at the first draw. Level-3 passes compile where they are
//! admitted, inside their own scopes (`custom_pass`).
//!
//! Pipeline caches (renderer pass 2, RC-09; LG-14 is the game box's Metal half): Metal and D3D12
//! drivers keep their own, Vulkan keeps none unless the application hands one in, and drivers on
//! Android often do not. A device opened with `PIPELINE_CACHE` (offered on Vulkan only) gets one
//! from the game's saves ([`open_pipeline_cache`], keyed by wgpu's adapter key: vendor and device,
//! the driver checked by wgpu's header) and every built-in pipeline compiled on it afterwards uses
//! it; [`save_pipeline_cache`] writes it back.

use std::ops::Deref;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use genex_core::saves::Saves;
use wgpu::{ComputePipeline, Device, PipelineCache, RenderPipeline};

use crate::jobs::{Job, Pool, Priority};

/// The lane pipeline compiles take on the job pool (game systems STR-4): a frame that needs a
/// pipeline waits for it, so it goes ahead of prefetched streaming work and behind only what the
/// simulation waits for.
pub const COMPILE_PRIORITY: Priority = Priority::Visible;

/// A pipeline (or any value) being made on a job thread: [`Compiled::get`] (or a deref) waits
/// for it. A job that panicked panics again where its value is first used, with its message, as
/// the call it replaced would have panicked there.
pub struct Compiled<T> {
    job: Arc<Job<T>>,
}

impl<T> Clone for Compiled<T> {
    fn clone(&self) -> Self {
        Compiled { job: Arc::clone(&self.job) }
    }
}

impl<T: std::fmt::Debug> std::fmt::Debug for Compiled<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.job.try_get() {
            Some(Ok(value)) => f.debug_tuple("Compiled").field(value).finish(),
            Some(Err(error)) => f.debug_tuple("Compiled").field(&format_args!("panicked: {error}")).finish(),
            None => f.write_str("Compiled(<compiling>)"),
        }
    }
}

impl<T: Send + Sync + 'static> Compiled<T> {
    /// A value that is already made.
    pub fn ready(value: T) -> Self {
        Compiled { job: Arc::new(Job::ready(value)) }
    }

    /// `job` run on the job pool's [`COMPILE_PRIORITY`] lane (inline on the web, or when no job
    /// thread can start).
    pub fn spawn(job: impl FnOnce() -> T + Send + 'static) -> Self {
        PENDING_JOBS.fetch_add(1, Ordering::AcqRel);
        SUBMITTED_JOBS.fetch_add(1, Ordering::AcqRel);
        let counted = move || {
            // Caught as handled (CRASH-2); the re-raise below is not a new panic, so one record.
            let made = genex_crash::catching(std::panic::AssertUnwindSafe(job));
            // Counted before the value is out, so a reader that has the value sees it counted.
            FINISHED_JOBS.fetch_add(1, Ordering::AcqRel);
            // The pool catches it again and keeps its message.
            made.unwrap_or_else(|panic| std::panic::resume_unwind(panic))
        };
        let after = || {
            // The last job of a burst (a launch's, a preset change's): keep what it compiled.
            if PENDING_JOBS.fetch_sub(1, Ordering::AcqRel) == 1 {
                save_pipeline_caches();
            }
        };
        Compiled { job: Arc::new(Pool::global().spawn_then(COMPILE_PRIORITY, counted, after)) }
    }
}

impl<T> Compiled<T> {
    /// The value, waiting until its job thread has made it.
    pub fn get(&self) -> &T {
        #[cfg(not(target_arch = "wasm32"))]
        if !self.job.is_ready() && Pool::global().is_held() && std::env::var("GENEX_DEBUG_WAITS").is_ok() {
            eprintln!("DEBUGWAIT {}", std::backtrace::Backtrace::force_capture());
        }
        self.job.get()
    }

    /// Whether the value is made (diagnostics and tests; never waits).
    pub fn is_ready(&self) -> bool {
        self.job.is_ready()
    }
}

impl<T> Deref for Compiled<T> {
    type Target = T;

    fn deref(&self) -> &T {
        self.get()
    }
}

/// While alive, no job thread starts a job: queued compiles wait and a frame that needs one waits
/// with them. Tests stand a slow shader compiler in with it (the game box grants no shader cache,
/// so every compile is cold there); dropping it lets the queue run. It holds the whole job pool.
#[cfg(not(target_arch = "wasm32"))]
#[must_use = "the pool runs again when the hold is dropped"]
pub struct CompileHold(#[allow(dead_code, reason = "held for its drop")] crate::jobs::PoolHold);

/// Hold the job pool (see [`CompileHold`]).
#[cfg(not(target_arch = "wasm32"))]
pub fn hold() -> CompileHold {
    CompileHold(Pool::global().hold())
}

/// The built-in compute shaders that declare workgroup memory, each audited to write every
/// workgroup variable before any invocation reads it (renderer pass 2, A8.6), with the proof: the
/// shader's name (as `shaders::SHADERS` or its module registers it) and why. Their pipelines skip
/// wgpu's workgroup zeroing ([`written_first`]); a new kernel with workgroup memory joins only
/// with its own audit (tests/workgroup_memory.rs holds every registered shader to this list).
pub const WORKGROUP_AUDIT: &[(&str, &str)] = &[
    ("cull", "cull_mark, cull_scan and cull_scatter store every lane's scan[lane] before the first barrier; lanes 0-7 store word_counts[lane] before the barrier lane 0 reads them after"),
    ("light-bin", "cs_light_zbins: each lane stores zbin_lowest/zbin_highest[lane] before the reduction's first barrier"),
    ("exposure-histogram", "lanes below the bin count store 0 into every bin before the first barrier"),
    ("exposure-adapt", "each of the 128 lanes stores gx_prefix[bin] and gx_sums[bin] before the barrier that precedes any read"),
    ("aerial-perspective", "each of the 32 lanes stores its slice of both scans before the first barrier"),
    ("sky-multiscatter", "each of the 64 lanes stores its direction's gathers before the reduction's first barrier"),
    ("ibl-sh9", "each lane stores partial[lane] and lowest[lane] before reading; lane 0 stores ringing before the uniform load"),
    ("meshlet-cull", "cull_mark, cull_scan and cull_scatter store every lane's scan_a, scan_b, marks and lane_slots before a barrier"),
    ("grass-gen", "cs_grass_tiles and cs_grass_scan store every lane's gx_grass_scan[lane] before the scan's first barrier; cs_grass_pack declares none it reads"),
    ("irradiance-passes", "cs_irradiance_reduce: each of the 64 lanes stores lane_light[lane][a] and lane_reach[lane][a] for all six directions before the reduction's first barrier"),
    ("particles-sort", "cs_sort_block and cs_sort_inner: each of the 256 lanes stores all eight of its sort_lds slots (a pair past the count as the last key) before the first barrier; cs_sort_step declares none"),
    ("ocean-fft", "cs_ocean_fft_rows and cs_ocean_fft_columns: each of the 256 lanes stores gx_ocean_a[lane] before the first barrier, and every Stockham pass writes the whole ping-pong row it reads next before a barrier; cs_ocean_spectrum and cs_ocean_resolve read none"),
];

/// Compilation options for a kernel in [`WORKGROUP_AUDIT`]: no workgroup zeroing on native, where
/// naga's MSL writer otherwise zeroes every workgroup array from one thread before a barrier at the
/// start of each workgroup. The web always zeroes (the browser does it, whatever wgpu is told).
pub fn written_first<'a>() -> wgpu::PipelineCompilationOptions<'a> {
    wgpu::PipelineCompilationOptions { zero_initialize_workgroup_memory: false, ..Default::default() }
}

/// Compiles handed to the job pool and not finished yet.
static PENDING_JOBS: AtomicUsize = AtomicUsize::new(0);
/// Compiles ever handed to the job pool, and ever finished: a boot's progress (owner decision D11).
static SUBMITTED_JOBS: AtomicUsize = AtomicUsize::new(0);
static FINISHED_JOBS: AtomicUsize = AtomicUsize::new(0);

/// The compiles' counts since the process started: pipelines (and other [`Compiled`] values)
/// handed to the job pool and finished; the pool's other jobs (streaming) are not counted. A boot reads them twice and reports the difference as pipelines n of m.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CompileTally {
    /// Jobs handed to the pool.
    pub submitted: usize,
    /// Jobs it finished (a job that panicked counts as finished).
    pub finished: usize,
}

impl CompileTally {
    /// The pool's work since `base` was read: the jobs still pending then plus those handed over
    /// since, and how many of them finished. A job pending at the base (the presenter's own, handed
    /// over before a boot's warm-up) is in both, so `finished` never passes `submitted`.
    pub fn since(self, base: CompileTally) -> CompileTally {
        CompileTally { submitted: self.submitted.saturating_sub(base.finished), finished: self.finished.saturating_sub(base.finished) }
    }
}

/// The compiles' counts now.
pub fn compile_tally() -> CompileTally {
    // Finished first: a job that finishes between the two reads is never counted done before it was handed over.
    let finished = FINISHED_JOBS.load(Ordering::Acquire);
    CompileTally { submitted: SUBMITTED_JOBS.load(Ordering::Acquire).max(finished), finished }
}

/// The save folder a game's pipeline caches are kept in, one file per adapter key.
pub const PIPELINE_CACHE_FOLDER: &str = "genex-pipeline-cache";

/// The saves pipeline caches are kept in, and each open cache with its device and save file.
struct PipelineCaches {
    saves: Option<Saves>,
    open: Vec<(Device, PipelineCache, String)>,
}

static PIPELINE_CACHES: Mutex<PipelineCaches> = Mutex::new(PipelineCaches { saves: None, open: Vec::new() });

fn pipeline_caches() -> std::sync::MutexGuard<'static, PipelineCaches> {
    PIPELINE_CACHES.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The save file a device on `info`'s adapter keeps its pipeline cache in:
/// `genex-pipeline-cache/<wgpu's adapter key>.bin`, or None where the backend keeps its own (every
/// backend but Vulkan) or the key is not a plain file name.
pub fn pipeline_cache_file(info: &wgpu::AdapterInfo) -> Option<String> {
    let key = wgpu::util::pipeline_cache_key(info)?;
    let plain = !key.is_empty() && key.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_');
    plain.then(|| format!("{PIPELINE_CACHE_FOLDER}/{key}.bin"))
}

/// Keep pipeline caches in `saves` (the game's own; None keeps none): the devices opened from now
/// on start from what is saved there, and [`save_pipeline_cache`] writes there.
pub fn keep_pipeline_caches_in(saves: Option<Saves>) {
    pipeline_caches().saves = saves;
}

/// Open `device`'s pipeline cache, from its save file when there is one: on a device opened with
/// `PIPELINE_CACHE` (Vulkan) on `info`'s adapter while the game's saves are kept
/// ([`keep_pipeline_caches_in`]). A later device on the same adapter (a lost device's
/// replacement) takes its place. False when the device gets none.
pub fn open_pipeline_cache(device: &Device, info: &wgpu::AdapterInfo) -> bool {
    let Some(file) = pipeline_cache_file(info) else { return false };
    let mut caches = pipeline_caches();
    let Some(saves) = caches.saves.clone() else { return false };
    let saved = saves.load(&file);
    let Some(cache) = genex_gpu_memory::open_pipeline_cache(device, saved.as_deref()) else { return false };
    caches.open.retain(|(_, _, open)| *open != file);
    caches.open.push((device.clone(), cache, file));
    true
}

/// Write `device`'s pipeline cache to its save file (the job pool may still be adding to it;
/// a later call writes what it has then). False when the device has none or the save is refused.
pub fn save_pipeline_cache(device: &Device) -> bool {
    let caches = pipeline_caches();
    let Some(saves) = caches.saves.as_ref() else { return false };
    let Some((_, cache, file)) = caches.open.iter().find(|(open, _, _)| open == device) else { return false };
    cache.get_data().is_some_and(|bytes| saves.save(file, &bytes))
}

/// Write every open pipeline cache to its save file: when the job pool finishes a burst of
/// compiles, so a launch's or a preset change's pipelines are kept for the next launch.
fn save_pipeline_caches() {
    let caches = pipeline_caches();
    let Some(saves) = caches.saves.as_ref() else { return };
    for (_, cache, file) in &caches.open {
        if let Some(bytes) = cache.get_data() {
            let _ = saves.save(file, &bytes);
        }
    }
}

/// The pipeline cache `device` compiles with, when it has one.
fn pipeline_cache_of(device: &Device) -> Option<PipelineCache> {
    pipeline_caches().open.iter().find(|(open, _, _)| open == device).map(|(_, cache, _)| cache.clone())
}

/// `desc` compiled on the pool: the descriptor's borrowed parts are copied (the module, layout and
/// device handles are reference-counted), so the call returns at once.
pub fn render_pipeline(device: &Device, desc: &wgpu::RenderPipelineDescriptor<'_>) -> Compiled<RenderPipeline> {
    let owned = OwnedRender::of(desc);
    let device = device.clone();
    Compiled::spawn(move || owned.create(&device))
}

/// [`render_pipeline`] for a game's own source: the job thread wraps the creation in
/// validation and internal error scopes, so a pipeline the backend refuses is `Err` with wgpu's
/// message. A scope the backend has not answered by then (the browser's, which answers
/// asynchronously) counts as clean: the browser reports its own pipeline errors.
pub fn render_pipeline_checked(device: &Device, desc: &wgpu::RenderPipelineDescriptor<'_>) -> Compiled<Result<RenderPipeline, String>> {
    let owned = OwnedRender::of(desc);
    let device = device.clone();
    Compiled::spawn(move || scoped(&device, || owned.create(&device)))
}

/// `create` inside validation and internal error scopes pushed on this thread: its value, or the
/// first error a scope caught.
fn scoped<T>(device: &Device, create: impl FnOnce() -> T) -> Result<T, String> {
    let internal = device.push_error_scope(wgpu::ErrorFilter::Internal);
    let validation = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let made = create();
    let invalid = answered(validation.pop());
    let failed = answered(internal.pop());
    match invalid.or(failed) {
        Some(error) => Err(error.to_string()),
        None => Ok(made),
    }
}

/// A scope's error if the backend has answered (native backends answer at once).
fn answered(future: impl std::future::Future<Output = Option<wgpu::Error>>) -> Option<wgpu::Error> {
    let mut future = std::pin::pin!(future);
    match future.as_mut().poll(&mut std::task::Context::from_waker(std::task::Waker::noop())) {
        std::task::Poll::Ready(error) => error,
        std::task::Poll::Pending => None,
    }
}

/// [`render_pipeline`] for a compute pipeline.
pub fn compute_pipeline(device: &Device, desc: &wgpu::ComputePipelineDescriptor<'_>) -> Compiled<ComputePipeline> {
    let owned = OwnedCompute::of(desc);
    let device = device.clone();
    Compiled::spawn(move || owned.create(&device))
}

/// A stage's module, entry point and compilation options, owned.
struct OwnedStage {
    module: wgpu::ShaderModule,
    entry_point: Option<String>,
    constants: Vec<(String, f64)>,
    zero_initialize_workgroup_memory: bool,
}

impl OwnedStage {
    fn of(module: &wgpu::ShaderModule, entry_point: Option<&str>, options: &wgpu::PipelineCompilationOptions<'_>) -> Self {
        OwnedStage {
            module: module.clone(),
            entry_point: entry_point.map(str::to_owned),
            constants: options.constants.iter().map(|(name, value)| ((*name).to_owned(), *value)).collect(),
            zero_initialize_workgroup_memory: options.zero_initialize_workgroup_memory,
        }
    }

    fn constants(&self) -> Vec<(&str, f64)> {
        self.constants.iter().map(|(name, value)| (name.as_str(), *value)).collect()
    }

    fn options<'a>(&self, constants: &'a [(&'a str, f64)]) -> wgpu::PipelineCompilationOptions<'a> {
        wgpu::PipelineCompilationOptions { constants, zero_initialize_workgroup_memory: self.zero_initialize_workgroup_memory }
    }
}

/// One vertex buffer's layout, owned.
struct OwnedBuffer {
    array_stride: wgpu::BufferAddress,
    step_mode: wgpu::VertexStepMode,
    attributes: Vec<wgpu::VertexAttribute>,
}

/// A render pipeline descriptor, owned (its device's pipeline cache is looked up where it is made).
struct OwnedRender {
    label: Option<String>,
    layout: Option<wgpu::PipelineLayout>,
    vertex: OwnedStage,
    buffers: Vec<Option<OwnedBuffer>>,
    primitive: wgpu::PrimitiveState,
    depth_stencil: Option<wgpu::DepthStencilState>,
    multisample: wgpu::MultisampleState,
    fragment: Option<(OwnedStage, Vec<Option<wgpu::ColorTargetState>>)>,
    multiview_mask: Option<std::num::NonZeroU32>,
}

impl OwnedRender {
    fn of(desc: &wgpu::RenderPipelineDescriptor<'_>) -> Self {
        let buffers = desc
            .vertex
            .buffers
            .iter()
            .map(|buffer| {
                buffer.as_ref().map(|buffer| OwnedBuffer {
                    array_stride: buffer.array_stride,
                    step_mode: buffer.step_mode,
                    attributes: buffer.attributes.to_vec(),
                })
            })
            .collect();
        OwnedRender {
            label: desc.label.map(str::to_owned),
            layout: desc.layout.cloned(),
            vertex: OwnedStage::of(desc.vertex.module, desc.vertex.entry_point, &desc.vertex.compilation_options),
            buffers,
            primitive: desc.primitive,
            depth_stencil: desc.depth_stencil.clone(),
            multisample: desc.multisample,
            fragment: desc
                .fragment
                .as_ref()
                .map(|fragment| (OwnedStage::of(fragment.module, fragment.entry_point, &fragment.compilation_options), fragment.targets.to_vec())),
            multiview_mask: desc.multiview_mask,
        }
    }

    fn create(&self, device: &Device) -> RenderPipeline {
        let buffers: Vec<Option<wgpu::VertexBufferLayout<'_>>> = self
            .buffers
            .iter()
            .map(|buffer| {
                buffer.as_ref().map(|buffer| wgpu::VertexBufferLayout {
                    array_stride: buffer.array_stride,
                    step_mode: buffer.step_mode,
                    attributes: &buffer.attributes,
                })
            })
            .collect();
        let vertex_constants = self.vertex.constants();
        let fragment_constants = self.fragment.as_ref().map(|(stage, _)| stage.constants()).unwrap_or_default();
        let cache = pipeline_cache_of(device);
        device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: self.label.as_deref(),
            layout: self.layout.as_ref(),
            vertex: wgpu::VertexState {
                module: &self.vertex.module,
                entry_point: self.vertex.entry_point.as_deref(),
                compilation_options: self.vertex.options(&vertex_constants),
                buffers: &buffers,
            },
            primitive: self.primitive,
            depth_stencil: self.depth_stencil.clone(),
            multisample: self.multisample,
            fragment: self.fragment.as_ref().map(|(stage, targets)| wgpu::FragmentState {
                module: &stage.module,
                entry_point: stage.entry_point.as_deref(),
                compilation_options: stage.options(&fragment_constants),
                targets,
            }),
            multiview_mask: self.multiview_mask,
            cache: cache.as_ref(),
        })
    }
}

/// A compute pipeline descriptor, owned (its device's pipeline cache is looked up where it is made).
struct OwnedCompute {
    label: Option<String>,
    layout: Option<wgpu::PipelineLayout>,
    stage: OwnedStage,
}

impl OwnedCompute {
    fn of(desc: &wgpu::ComputePipelineDescriptor<'_>) -> Self {
        OwnedCompute {
            label: desc.label.map(str::to_owned),
            layout: desc.layout.cloned(),
            stage: OwnedStage::of(desc.module, desc.entry_point, &desc.compilation_options),
        }
    }

    fn create(&self, device: &Device) -> ComputePipeline {
        let constants = self.stage.constants();
        let cache = pipeline_cache_of(device);
        device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: self.label.as_deref(),
            layout: self.layout.as_ref(),
            module: &self.stage.module,
            entry_point: self.stage.entry_point.as_deref(),
            compilation_options: self.stage.options(&constants),
            cache: cache.as_ref(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jobs::panic_message;

    /// Owner decision D11: a boot counts its pipelines n of m from the pool's tally (other tests'
    /// jobs run alongside, so the counts are at least this row's own).
    #[test]
    fn the_tally_counts_every_job_handed_over_and_finished() {
        let base = compile_tally();
        let made: Vec<Compiled<u32>> = (0..5).map(|n| Compiled::spawn(move || n)).collect();
        assert!(compile_tally().since(base).submitted >= 5, "every job is counted as handed over at once");
        assert_eq!(made.iter().map(|value| *value.get()).sum::<u32>(), 10);
        let now = compile_tally().since(base);
        assert!(now.finished >= 5, "every job is counted finished once made: {now:?}");
        assert!(now.finished <= now.submitted, "never more finished than handed over: {now:?}");
    }

    /// A job still compiling when a boot reads its base (the presenter's own, handed over before
    /// the warm-up) finishes inside the boot's count: its n never passes its m.
    #[test]
    #[cfg(not(target_arch = "wasm32"))]
    fn a_job_pending_when_the_base_was_read_counts_inside_its_n_of_m() {
        let held = hold();
        let pending = Compiled::spawn(|| 7_u32);
        let base = compile_tally();
        drop(held);
        assert_eq!(*pending.get(), 7);
        let now = compile_tally().since(base);
        assert!(now.finished >= 1, "the pending job finished since the base: {now:?}");
        assert!(now.finished <= now.submitted, "never more finished than handed over: {now:?}");
    }

    #[test]
    fn a_spawned_value_is_the_jobs_and_a_ready_one_is_itself() {
        let made = Compiled::spawn(|| 6 * 7);
        assert_eq!(*made.get(), 42);
        assert!(made.is_ready());
        let ready = Compiled::ready("made");
        assert_eq!(*ready, "made");
        assert_eq!(*ready.clone(), "made", "a clone reads the same slot");
    }

    #[test]
    fn many_jobs_finish_and_each_keeps_its_own_value() {
        let handles: Vec<Compiled<usize>> = (0..64).map(|index| Compiled::spawn(move || index * 2)).collect();
        for (index, handle) in handles.iter().enumerate() {
            assert_eq!(**handle, index * 2);
        }
    }

    #[test]
    fn a_job_that_panicked_panics_again_where_its_value_is_used_with_its_message() {
        let failed: Compiled<u32> = Compiled::spawn(|| panic!("bad descriptor"));
        let used = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| *failed.get()));
        let message = used.expect_err("the use panics");
        assert_eq!(panic_message(message.as_ref()), "bad descriptor");
        // The pool survives a panicking job.
        assert_eq!(*Compiled::spawn(|| 1u8), 1);
    }
}
