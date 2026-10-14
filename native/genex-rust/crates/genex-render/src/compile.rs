//! Built-in pipelines compiled off the frame thread (renderer pass-1 gate).
//!
//! A cold pipeline compile is the slowest call a frame makes. On Metal each one is an MSL compile:
//! about 0.23 s inside the game box (whose profile grants no shader cache) against 0.04 s outside
//! it, and a studio run's first frame at `high` makes about sixty. Made one after another on the
//! frame thread they held a boxed game's `ready` past its 20 s deadline. The driver compiles
//! concurrently (16 MSL compiles in the box: 3.7 s one after another, 0.55 s side by side on an M4
//! Max), so every built-in pipeline is handed to a small pool of compile threads and the renderer
//! keeps a [`Compiled`] handle. The first use waits for it; by then the frame has handed out every
//! pipeline it needs, so they compile side by side. The pipelines and their order of use are
//! unchanged, so every picture is the same.
//!
//! On the web (no threads; the browser compiles off its own main thread) a pipeline is made where
//! it is asked for. A game's own WGSL (Level-2 materials, Level-3 passes) is still compiled where
//! it is admitted, inside its error scopes.

use std::ops::Deref;
use std::sync::{Arc, OnceLock};

use wgpu::{ComputePipeline, Device, RenderPipeline};

/// Compile threads at most: the driver's own compiler service does not scale past about this.
#[cfg(not(target_arch = "wasm32"))]
const MAX_COMPILE_THREADS: usize = 8;
/// Compile threads at least, when the host's parallelism is unknown or 1.
#[cfg(not(target_arch = "wasm32"))]
const MIN_COMPILE_THREADS: usize = 2;

/// A pipeline (or any value) being made on a compile thread: [`Compiled::get`] (or a deref) waits
/// for it. A job that panicked panics again where its value is first used, with its message, as
/// the call it replaced would have panicked there.
pub struct Compiled<T> {
    slot: Arc<OnceLock<Result<T, String>>>,
}

impl<T> Clone for Compiled<T> {
    fn clone(&self) -> Self {
        Compiled { slot: Arc::clone(&self.slot) }
    }
}

impl<T: std::fmt::Debug> std::fmt::Debug for Compiled<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.slot.get() {
            Some(Ok(value)) => f.debug_tuple("Compiled").field(value).finish(),
            Some(Err(message)) => f.debug_tuple("Compiled").field(&format_args!("panicked: {message}")).finish(),
            None => f.write_str("Compiled(<compiling>)"),
        }
    }
}

impl<T: Send + Sync + 'static> Compiled<T> {
    /// A value that is already made.
    pub fn ready(value: T) -> Self {
        let slot = OnceLock::new();
        let _ = slot.set(Ok(value));
        Compiled { slot: Arc::new(slot) }
    }

    /// `job` run on a compile thread (inline on the web, or when no compile thread can start).
    pub fn spawn(job: impl FnOnce() -> T + Send + 'static) -> Self {
        let slot = Arc::new(OnceLock::new());
        let filled = Arc::clone(&slot);
        let run = move || {
            let made = std::panic::catch_unwind(std::panic::AssertUnwindSafe(job)).map_err(|panic| panic_message(panic.as_ref()));
            let _ = filled.set(made);
        };
        submit(Box::new(run));
        Compiled { slot }
    }
}

impl<T> Compiled<T> {
    /// The value, waiting until its compile thread has made it.
    pub fn get(&self) -> &T {
        #[cfg(not(target_arch = "wasm32"))]
        if self.slot.get().is_none() && HOLDS.0.lock().map(|h| *h > 0).unwrap_or(false) && std::env::var("GENEX_DEBUG_WAITS").is_ok() {
            eprintln!("DEBUGWAIT {}", std::backtrace::Backtrace::force_capture());
        }
        match self.slot.wait() {
            Ok(value) => value,
            Err(message) => panic!("{message}"),
        }
    }

    /// Whether the value is made (diagnostics and tests; never waits).
    pub fn is_ready(&self) -> bool {
        self.slot.get().is_some()
    }
}

impl<T> Deref for Compiled<T> {
    type Target = T;

    fn deref(&self) -> &T {
        self.get()
    }
}

/// What a panic carried, as the message it is raised again with.
fn panic_message(panic: &(dyn std::any::Any + Send)) -> String {
    if let Some(text) = panic.downcast_ref::<&str>() {
        return (*text).to_owned();
    }
    panic.downcast_ref::<String>().cloned().unwrap_or_else(|| "a pipeline compile panicked".to_owned())
}

type Job = Box<dyn FnOnce() + Send>;

/// Run `job` on the compile pool, or here when there is none.
#[cfg(not(target_arch = "wasm32"))]
fn submit(job: Job) {
    match pool() {
        Some(sender) => {
            if let Err(returned) = sender.send(job) {
                (returned.0)();
            }
        }
        None => job(),
    }
}

#[cfg(target_arch = "wasm32")]
fn submit(job: Job) {
    job();
}

/// The compile pool's queue: its threads start on first use and live as long as the process.
/// None when not one thread could start (every job then runs where it is submitted).
#[cfg(not(target_arch = "wasm32"))]
fn pool() -> Option<&'static std::sync::mpsc::Sender<Job>> {
    static POOL: OnceLock<Option<std::sync::mpsc::Sender<Job>>> = OnceLock::new();
    POOL.get_or_init(start_pool).as_ref()
}

#[cfg(not(target_arch = "wasm32"))]
fn start_pool() -> Option<std::sync::mpsc::Sender<Job>> {
    use std::sync::Mutex;
    let (sender, receiver) = std::sync::mpsc::channel::<Job>();
    let receiver = Arc::new(Mutex::new(receiver));
    let threads = std::thread::available_parallelism().map_or(MIN_COMPILE_THREADS, |n| n.get()).clamp(MIN_COMPILE_THREADS, MAX_COMPILE_THREADS);
    let started = (0..threads)
        .filter(|index| {
            let receiver = Arc::clone(&receiver);
            std::thread::Builder::new().name(format!("genex-compile-{index}")).spawn(move || compile_thread(&receiver)).is_ok()
        })
        .count();
    (started > 0).then_some(sender)
}

/// One compile thread: take the next job and run it (the queue lock is released first, and a job
/// never unwinds: [`Compiled::spawn`] catches its panic). A job waits while a [`CompileHold`] is
/// alive.
#[cfg(not(target_arch = "wasm32"))]
fn compile_thread(receiver: &std::sync::Mutex<std::sync::mpsc::Receiver<Job>>) {
    loop {
        let next = match receiver.lock() {
            Ok(queue) => queue.recv(),
            Err(_) => return,
        };
        match next {
            Ok(job) => {
                wait_while_held();
                job();
            }
            Err(_) => return,
        }
    }
}

/// Live holds on the compile pool and the condition a held compile thread waits on.
#[cfg(not(target_arch = "wasm32"))]
static HOLDS: (std::sync::Mutex<u32>, std::sync::Condvar) = (std::sync::Mutex::new(0), std::sync::Condvar::new());

#[cfg(not(target_arch = "wasm32"))]
fn wait_while_held() {
    let (holds, released) = &HOLDS;
    let Ok(held) = holds.lock() else { return };
    // The guard is dropped at once: the job runs without it.
    drop(released.wait_while(held, |held| *held > 0));
}

/// While alive, no compile thread starts a job: queued compiles wait and a frame that needs one
/// waits with them. Tests stand a slow shader compiler in with it (the game box grants no shader
/// cache, so every compile is cold there); dropping it lets the queue run.
#[cfg(not(target_arch = "wasm32"))]
#[must_use = "the pool runs again when the hold is dropped"]
pub struct CompileHold(());

/// Hold the compile pool (see [`CompileHold`]).
#[cfg(not(target_arch = "wasm32"))]
pub fn hold() -> CompileHold {
    if let Ok(mut held) = HOLDS.0.lock() {
        *held += 1;
    }
    CompileHold(())
}

#[cfg(not(target_arch = "wasm32"))]
impl Drop for CompileHold {
    fn drop(&mut self) {
        if let Ok(mut held) = HOLDS.0.lock() {
            *held = held.saturating_sub(1);
        }
        HOLDS.1.notify_all();
    }
}

/// `desc` compiled on the pool: the descriptor's borrowed parts are copied (the module, layout and
/// device handles are reference-counted), so the call returns at once.
pub fn render_pipeline(device: &Device, desc: &wgpu::RenderPipelineDescriptor<'_>) -> Compiled<RenderPipeline> {
    let owned = OwnedRender::of(desc);
    let device = device.clone();
    Compiled::spawn(move || owned.create(&device))
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

/// A render pipeline descriptor, owned (no pipeline cache: the built-in pipelines use none).
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
            cache: None,
        })
    }
}

/// A compute pipeline descriptor, owned (no pipeline cache).
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
        device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: self.label.as_deref(),
            layout: self.layout.as_ref(),
            module: &self.stage.module,
            entry_point: self.stage.entry_point.as_deref(),
            compilation_options: self.stage.options(&constants),
            cache: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
