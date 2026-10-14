//! Device-loss recovery (plan "HiDPI and pacing"; forced-loss rows here and in the M5 gate). A
//! [`DeviceWatch`] marks the device lost from wgpu's device-lost callback; while it is lost every
//! frame and capture answers the typed `device-lost` refusal and nothing touches the device. The
//! [`Resilient`] renderer keeps a CPU cache of everything it uploaded (meshes, skinned meshes,
//! textures, custom materials, post passes, emitters, in the order they were added), so
//! [`Resilient::recover`] re-creates the adapter and device, rebuilds the renderer and replays the
//! cache: every id is the same and the next frame draws the identical image. Each recovery bumps
//! [`Resilient::generation`], the ring generation the Live sender re-announces.
//!
//! The facade's studio presenter draws through a [`Resilient`]: a frame or capture on a lost
//! device answers `device-lost` (the `capture` verb's refusal), and the studio loop calls
//! [`Resilient::recover`] between requests, rebuilds the game's custom passes on the new device and
//! makes Live's ring again on it.
//!
//! The same cache builds a renderer away from the frame thread (pass-1 gate: a native game was
//! killed leaving the Medium preset). [`Resilient::plan`] hands another thread what a renderer for
//! other options needs ([`RendererPlan`]: the device, the options and the uploads so far); that
//! thread builds it ([`RendererPlan::build`]) and warms it with a frame, compiling its pipelines,
//! while this one keeps drawing; [`Resilient::adopt`] then replays what was uploaded meanwhile and
//! swaps it in. With [`Resilient::set_keep_spare`] the renderer a swap or a rebuild replaced is kept
//! as the spare for its options, so going back (a capture's pinned profile and Live again) swaps
//! instead of compiling every pipeline again.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::device_class::DeviceClass;
use crate::settings::TextureQuality;

use crate::capture::Capture;
use crate::custom_pass::{CustomStage, NoCustom};
use crate::error::{RenderCode, RenderError};
use crate::abi::ABI_V1;
use crate::extension::{CustomMaterialId, PostPassId, PostStage};
use crate::settle::HistoryReset;
use crate::gpu::Gpu;
use crate::immediate::{FrameReport, FrameRenderer, ImmediateFrame};
use crate::mesh::MeshData;
use crate::meshlet::MeshletSet;
use crate::overlay::OverlayPainter;
use crate::particles::{EmitterDesc, EmitterId};
use crate::renderer::RenderOptions;
use crate::settings::Meshlets;
use crate::scene::MeshId;
use crate::skin::{SkinId, SkinnedMeshData};
use crate::tables::CullPath;
use crate::texture::{TextureData, TextureId, TextureKind};

/// Whether a device has been lost, set from wgpu's device-lost callback.
#[derive(Clone, Debug)]
pub struct DeviceWatch {
    lost: Arc<AtomicBool>,
}

impl DeviceWatch {
    /// Watch `gpu`'s device. Once it is lost, wgpu's errors from work already in flight are
    /// logged instead of panicking (the default handler's behaviour stays for a live device).
    pub fn attach(gpu: &Gpu) -> DeviceWatch {
        let lost = Arc::new(AtomicBool::new(false));
        let on_lost = Arc::clone(&lost);
        gpu.device.set_device_lost_callback(move |reason, message| {
            on_lost.store(true, Ordering::SeqCst);
            log::warn!("genex-render: device lost ({reason:?}): {message}");
        });
        let on_error = Arc::clone(&lost);
        gpu.device.on_uncaptured_error(Arc::new(move |error: wgpu::Error| {
            if on_error.load(Ordering::SeqCst) {
                log::warn!("genex-render: error on a lost device: {error}");
                return;
            }
            // wgpu's own default: an uncaptured validation error on a live device is a bug.
            panic!("wgpu error: {error}");
        }));
        DeviceWatch { lost }
    }

    /// Whether the device has been lost.
    pub fn is_lost(&self) -> bool {
        self.lost.load(Ordering::SeqCst)
    }

    /// Lose the device on purpose: destroy it (the forced-loss rows; the hang watchdog's path).
    pub fn force_loss(&self, gpu: &Gpu) {
        self.lost.store(true, Ordering::SeqCst);
        gpu.device.destroy();
    }
}

fn device_lost() -> RenderError {
    RenderError::refused(RenderCode::DeviceLost, "the GPU device was lost; it is being re-created")
}

/// One upload, kept to replay after a loss.
#[derive(Clone, Debug)]
enum Upload {
    Mesh(MeshData),
    /// Every part of one model with the meshlets each brought, replayed as one upload.
    Meshes(Vec<(MeshData, Option<MeshletSet>)>),
    Skinned(SkinnedMeshData),
    Texture(TextureData, TextureKind),
    Material(Extension),
    PostPass(PostStage, Extension),
    Emitter(EmitterDesc),
}

/// A Level-2 source as it was admitted: its API, WGSL, uniform bytes and game textures.
#[derive(Clone, Debug)]
struct Extension {
    api: u32,
    wgsl: String,
    uniforms: Vec<u8>,
    textures: Vec<TextureData>,
}

impl Extension {
    fn new(api: u32, wgsl: &str, uniforms: &[u8], textures: &[TextureData]) -> Extension {
        Extension { api, wgsl: wgsl.to_owned(), uniforms: uniforms.to_vec(), textures: textures.to_vec() }
    }
}

/// Opens a fresh device (natively `Gpu::headless` or the shell's surface-compatible opener).
pub type GpuOpener = Box<dyn FnMut() -> Result<Gpu, RenderError>>;

/// A renderer kept for its options while another one draws, and the uploads it holds.
struct Spare {
    options: RenderOptions,
    renderer: FrameRenderer,
    replayed: usize,
}

/// What another thread needs to build a renderer for `options` on this device (see the module
/// docs): sent there, built with [`RendererPlan::build`].
pub struct RendererPlan {
    gpu: Gpu,
    size: (u32, u32),
    options: RenderOptions,
    declared: wgpu::Features,
    meshlets: Meshlets,
    texture_arrays: Option<(DeviceClass, TextureQuality)>,
    uploads: Vec<Arc<Upload>>,
    generation: u32,
}

impl RendererPlan {
    /// The device the renderer is built on.
    pub fn gpu(&self) -> &Gpu {
        &self.gpu
    }

    /// The options it is built with.
    pub fn options(&self) -> RenderOptions {
        self.options
    }

    /// Build the renderer and replay the uploads the plan holds (on the thread that warms it).
    pub fn build(&self) -> Result<Prepared, RenderError> {
        let (width, height) = self.size;
        let mut renderer = FrameRenderer::with_native_features(&self.gpu, width, height, self.options, self.declared)?;
        renderer.renderer_mut().set_meshlets(&self.gpu, self.meshlets)?;
        if let Some((class, quality)) = self.texture_arrays {
            renderer.renderer_mut().set_texture_arrays(&self.gpu.device, class, quality);
        }
        for upload in &self.uploads {
            replay(&mut renderer, &self.gpu, upload)?;
        }
        Ok(Prepared { renderer, options: self.options, replayed: self.uploads.len(), generation: self.generation })
    }
}

/// A renderer a [`RendererPlan`] built, for [`Resilient::adopt`] (or [`Resilient::keep_as_spare`]).
pub struct Prepared {
    renderer: FrameRenderer,
    options: RenderOptions,
    replayed: usize,
    generation: u32,
}

impl Prepared {
    /// The renderer, to warm with a frame before it is adopted.
    pub fn renderer_mut(&mut self) -> &mut FrameRenderer {
        &mut self.renderer
    }

    /// The options it was built with.
    pub fn options(&self) -> RenderOptions {
        self.options
    }
}

/// A [`FrameRenderer`] that survives device loss (see the module docs).
pub struct Resilient {
    gpu: Gpu,
    renderer: FrameRenderer,
    watch: DeviceWatch,
    uploads: Vec<Arc<Upload>>,
    size: (u32, u32),
    options: RenderOptions,
    declared: wgpu::Features,
    generation: u32,
    open: GpuOpener,
    /// The game's meshlet setting, applied to a recovered renderer before the replay.
    meshlets: Meshlets,
    /// Renderers built so far (the first, each rebuild and each recovery).
    builds: u32,
    /// Whether a replaced renderer is kept as the spare for its options.
    keep_spare: bool,
    /// The renderer kept for other options, when one is.
    spare: Option<Spare>,
}

impl Resilient {
    /// A renderer on `gpu` that re-opens a device through `open` after a loss.
    pub fn new(gpu: Gpu, width: u32, height: u32, options: RenderOptions, open: impl FnMut() -> Result<Gpu, RenderError> + 'static) -> Result<Resilient, RenderError> {
        Resilient::with_native_features(gpu, width, height, options, wgpu::Features::empty(), Box::new(open))
    }

    /// [`Resilient::new`] for a game that declares native-enhanced features.
    pub fn with_native_features(gpu: Gpu, width: u32, height: u32, options: RenderOptions, declared: wgpu::Features, open: GpuOpener) -> Result<Resilient, RenderError> {
        let renderer = FrameRenderer::with_native_features(&gpu, width, height, options, declared)?;
        let watch = DeviceWatch::attach(&gpu);
        Ok(Resilient {
            gpu,
            renderer,
            watch,
            uploads: Vec::new(),
            size: (width, height),
            options,
            declared,
            generation: 0,
            open,
            meshlets: Meshlets::DEFAULT,
            builds: 1,
            keep_spare: false,
            spare: None,
        })
    }

    /// The device in use.
    pub fn gpu(&self) -> &Gpu {
        &self.gpu
    }

    /// The renderer in use.
    pub fn renderer(&self) -> &FrameRenderer {
        &self.renderer
    }

    /// The renderer in use, mutably: the settings a frame draws with (quality, render scale) and
    /// its timer. A recovered renderer starts from the defaults, so a caller sets them per frame.
    pub fn renderer_mut(&mut self) -> &mut FrameRenderer {
        &mut self.renderer
    }

    /// The device and the renderer at once, the renderer mutably (a caller that renders with both).
    pub fn parts_mut(&mut self) -> (&Gpu, &mut FrameRenderer) {
        (&self.gpu, &mut self.renderer)
    }

    /// Whether the device is lost.
    pub fn is_lost(&self) -> bool {
        self.watch.is_lost()
    }

    /// Recoveries so far: the Live ring generation to announce.
    pub fn generation(&self) -> u32 {
        self.generation
    }

    /// Renderers built so far: the first, each [`Resilient::rebuild_with`] that rebuilt and each
    /// recovery (a boot that builds twice shows here).
    pub fn renderer_builds(&self) -> u32 {
        self.builds
    }

    /// The options the renderer in use was built with.
    pub fn options(&self) -> RenderOptions {
        self.options
    }

    fn healthy(&self) -> Result<(), RenderError> {
        if self.watch.is_lost() { Err(device_lost()) } else { Ok(()) }
    }

    /// A refusal from the device, read as `device-lost` when the device went away meanwhile.
    fn lost_or(&self, error: RenderError) -> RenderError {
        if self.watch.is_lost() { device_lost() } else { error }
    }

    fn upload<T>(&mut self, upload: Upload, apply: impl FnOnce(&mut FrameRenderer, &Gpu) -> Result<T, RenderError>) -> Result<T, RenderError> {
        self.healthy()?;
        let value = apply(&mut self.renderer, &self.gpu).map_err(|e| self.lost_or(e))?;
        self.uploads.push(Arc::new(upload));
        Ok(value)
    }

    /// Add a mesh (kept for replay).
    pub fn add_mesh(&mut self, mesh: MeshData) -> Result<MeshId, RenderError> {
        self.upload(Upload::Mesh(mesh.clone()), |r, gpu| r.add_mesh(gpu, mesh))
    }

    /// Add every part of one model with one library upload (kept for replay as one).
    pub fn add_meshes(&mut self, meshes: Vec<MeshData>) -> Result<Vec<MeshId>, RenderError> {
        self.add_meshes_with_meshlets(meshes.into_iter().map(|mesh| (mesh, None)).collect())
    }

    /// [`Resilient::add_meshes`] with the meshlets each part brought (a GLB part's
    /// `genex_meshlets`), kept for replay with them.
    pub fn add_meshes_with_meshlets(&mut self, parts: Vec<(MeshData, Option<MeshletSet>)>) -> Result<Vec<MeshId>, RenderError> {
        self.upload(Upload::Meshes(parts.clone()), |r, gpu| r.add_meshes_with_meshlets(gpu, parts))
    }

    /// Cluster the game's meshes by `meshlets` from now on ([`crate::Renderer::set_meshlets`]);
    /// a recovered renderer takes the latest setting before it replays the uploads.
    pub fn set_meshlets(&mut self, meshlets: Meshlets) -> Result<(), RenderError> {
        self.healthy()?;
        self.renderer.renderer_mut().set_meshlets(&self.gpu, meshlets).map_err(|e| self.lost_or(e))?;
        self.meshlets = meshlets;
        Ok(())
    }

    /// Add a skinned mesh (kept for replay).
    pub fn add_skinned_mesh(&mut self, data: &SkinnedMeshData) -> Result<SkinId, RenderError> {
        self.upload(Upload::Skinned(data.clone()), |r, gpu| r.add_skinned_mesh(gpu, data))
    }

    /// Add a texture (kept for replay).
    pub fn add_texture(&mut self, data: &TextureData, kind: TextureKind) -> Result<TextureId, RenderError> {
        self.upload(Upload::Texture(data.clone(), kind), |r, gpu| r.add_texture(gpu, data, kind))
    }

    /// Admit a custom material (kept for replay).
    pub fn add_material(&mut self, wgsl: &str, uniforms: &[u8]) -> Result<CustomMaterialId, RenderError> {
        self.add_material_api(ABI_V1, wgsl, uniforms, &[])
    }

    /// Admit a custom material at extension API `api` with its game textures (kept for replay).
    pub fn add_material_api(&mut self, api: u32, wgsl: &str, uniforms: &[u8], textures: &[TextureData]) -> Result<CustomMaterialId, RenderError> {
        let kept = Extension::new(api, wgsl, uniforms, textures);
        self.upload(Upload::Material(kept), |r, gpu| r.add_material_api(gpu, api, wgsl, uniforms, textures))
    }

    /// Admit a post pass (kept for replay).
    pub fn add_post_pass(&mut self, wgsl: &str, uniforms: &[u8]) -> Result<PostPassId, RenderError> {
        self.add_post_pass_api(ABI_V1, PostStage::Ldr, wgsl, uniforms, &[])
    }

    /// Admit a post pass at extension API `api` for `stage` with its game textures (kept for replay).
    pub fn add_post_pass_api(&mut self, api: u32, stage: PostStage, wgsl: &str, uniforms: &[u8], textures: &[TextureData]) -> Result<PostPassId, RenderError> {
        let kept = Extension::new(api, wgsl, uniforms, textures);
        self.upload(Upload::PostPass(stage, kept), |r, gpu| r.add_post_pass_api(gpu, api, stage, wgsl, uniforms, textures))
    }

    /// Add a particle emitter (kept for replay).
    pub fn add_emitter(&mut self, desc: EmitterDesc) -> Result<EmitterId, RenderError> {
        self.upload(Upload::Emitter(desc), |r, gpu| r.add_emitter(gpu, desc))
    }

    /// Draw `frame`; `device-lost` while the device is lost.
    pub fn render(&mut self, frame: &ImmediateFrame, path: CullPath, overlay: Option<&mut dyn OverlayPainter>) -> Result<FrameReport, RenderError> {
        self.render_with(frame, path, overlay, &mut NoCustom)
    }

    /// [`Resilient::render`] with `custom`'s passes (M2.19). After [`Resilient::recover`] the
    /// caller rebuilds them on the new device (`CustomPasses::rebuild` with [`Resilient::gpu`]):
    /// the pass objects are the game's, not this cache's.
    pub fn render_with(
        &mut self,
        frame: &ImmediateFrame,
        path: CullPath,
        overlay: Option<&mut dyn OverlayPainter>,
        custom: &mut dyn CustomStage,
    ) -> Result<FrameReport, RenderError> {
        self.healthy()?;
        let report = self.renderer.render_with(&self.gpu, frame, path, overlay, custom);
        report.map_err(|e| self.lost_or(e))
    }

    /// Read the world target back; `device-lost` while the device is lost (the `capture` verb's
    /// typed refusal).
    #[cfg(not(target_arch = "wasm32"))]
    pub fn capture(&self) -> Result<Capture, RenderError> {
        self.healthy()?;
        self.renderer.capture(&self.gpu).map_err(|e| self.lost_or(e))
    }

    /// [`Resilient::capture`] as a future (the web).
    pub async fn capture_async(&self) -> Result<Capture, RenderError> {
        self.healthy()?;
        let capture = self.renderer.capture_async(&self.gpu).await;
        capture.map_err(|e| self.lost_or(e))
    }

    /// Letterbox the world target into `target` (`window` pixels of `format`): Live's ring and a
    /// window's frame; nothing is drawn while the device is lost.
    pub fn present(&mut self, target: &wgpu::TextureView, format: wgpu::TextureFormat, window: (u32, u32)) {
        if self.watch.is_lost() {
            return;
        }
        self.renderer.renderer_mut().present(&self.gpu, target, format, window);
    }

    /// Replace a custom material's uniforms (the replay keeps the new ones).
    pub fn set_material_uniforms(&mut self, material: CustomMaterialId, uniforms: &[u8]) -> Result<(), RenderError> {
        self.healthy()?;
        self.renderer.set_material_uniforms(&self.gpu, material, uniforms).map_err(|e| self.lost_or(e))?;
        let kept = self.uploads.iter_mut().map(Arc::make_mut).filter_map(|u| if let Upload::Material(kept) = u { Some(kept) } else { None }).nth(material.raw() as usize);
        if let Some(kept) = kept {
            uniforms.clone_into(&mut kept.uniforms);
        }
        Ok(())
    }

    /// Rebuild the renderer on the same device with `options` (RQ5.6: the world pass's samples, a
    /// pipeline knob the presenter fixes for Live's anti-aliasing at boot and on an explicit
    /// settings change, and for a capture's pinned profile; MSAA or one sample under TAA),
    /// replaying every upload as a recovery does. Answers whether it rebuilt (equal options keep
    /// the renderer). A refusal keeps the renderer in use.
    ///
    /// With [`Resilient::set_keep_spare`] a spare built for `options` is swapped in instead
    /// (catching up on the uploads since it was kept), and the renderer it replaces becomes the
    /// spare.
    pub fn rebuild_with(&mut self, options: RenderOptions) -> Result<bool, RenderError> {
        if options == self.options {
            return Ok(false);
        }
        self.healthy()?;
        if let Some(spare) = self.spare.take_if(|spare| spare.options == options) {
            let Spare { renderer, replayed, .. } = spare;
            self.swap_in(Prepared { renderer, options, replayed, generation: self.generation })?;
            return Ok(true);
        }
        let prepared = self.plan(options).build()?;
        self.swap_in(prepared)?;
        self.builds += 1;
        Ok(true)
    }

    /// Keep the renderer a swap or a rebuild replaces as the spare for its options (one spare at
    /// most; off by default, and switching it off lets the spare go).
    pub fn set_keep_spare(&mut self, keep: bool) {
        self.keep_spare = keep;
        if !keep {
            self.spare = None;
        }
    }

    /// The options of the spare renderer, when one is kept.
    pub fn spare_options(&self) -> Option<RenderOptions> {
        self.spare.as_ref().map(|spare| spare.options)
    }

    /// The spare renderer and its options, when one is kept.
    pub fn spare(&self) -> Option<(RenderOptions, &FrameRenderer)> {
        self.spare.as_ref().map(|spare| (spare.options, &spare.renderer))
    }

    /// The spare built for `options`, brought up to date with every upload, to warm on another
    /// thread and [`Resilient::adopt`] (None when there is none for those options).
    pub fn take_spare(&mut self, options: RenderOptions) -> Result<Option<Prepared>, RenderError> {
        self.healthy()?;
        let Some(Spare { mut renderer, replayed, .. }) = self.spare.take_if(|spare| spare.options == options) else { return Ok(None) };
        self.catch_up(&mut renderer, replayed)?;
        Ok(Some(Prepared { renderer, options, replayed: self.uploads.len(), generation: self.generation }))
    }

    /// What another thread needs to build a renderer for `options` (see the module docs).
    pub fn plan(&self, options: RenderOptions) -> RendererPlan {
        RendererPlan {
            gpu: self.gpu.share(),
            size: self.size,
            options,
            declared: self.declared,
            meshlets: self.meshlets,
            texture_arrays: self.renderer.renderer().texture_arrays(),
            uploads: self.uploads.clone(),
            generation: self.generation,
        }
    }

    /// Swap in a renderer a [`RendererPlan`] built: the uploads since its plan are replayed and its
    /// history starts over, as a rebuild's does. Answers false, keeping the renderer in use, when
    /// the device was re-created since the plan (the prepared renderer belongs to the old one).
    pub fn adopt(&mut self, prepared: Prepared) -> Result<bool, RenderError> {
        if prepared.generation != self.generation {
            return Ok(false);
        }
        self.healthy()?;
        self.swap_in(prepared)?;
        self.builds += 1;
        Ok(true)
    }

    /// Keep a renderer a [`RendererPlan`] built as the spare for its options (a capture's pinned
    /// profile warmed ahead of the capture). Answers whether it was kept: not when spares are off,
    /// its options are the renderer in use's or the device was re-created since its plan.
    pub fn keep_as_spare(&mut self, prepared: Prepared) -> bool {
        let usable = self.keep_spare && prepared.options != self.options && prepared.generation == self.generation;
        if usable {
            let Prepared { renderer, options, replayed, .. } = prepared;
            self.spare = Some(Spare { options, renderer, replayed });
        }
        usable
    }

    /// `prepared` becomes the renderer in use once it holds every upload (with today's material
    /// uniforms and meshlet setting); the one it replaces becomes the spare when spares are kept
    /// and its options differ.
    fn swap_in(&mut self, prepared: Prepared) -> Result<(), RenderError> {
        let Prepared { mut renderer, options, replayed, .. } = prepared;
        self.catch_up(&mut renderer, replayed)?;
        renderer.reset_history(HistoryReset::Settings);
        let replaced = std::mem::replace(&mut self.renderer, renderer);
        let replaced_options = std::mem::replace(&mut self.options, options);
        if self.spare.as_ref().is_some_and(|spare| spare.options == options) {
            self.spare = None;
        }
        if self.keep_spare && replaced_options != options {
            self.spare = Some(Spare { options: replaced_options, renderer: replaced, replayed: self.uploads.len() });
        }
        Ok(())
    }

    /// Bring `renderer`, which holds the first `replayed` uploads, up to date: the later uploads
    /// replayed, the earlier materials' uniforms as they are now and today's meshlet setting.
    fn catch_up(&self, renderer: &mut FrameRenderer, replayed: usize) -> Result<(), RenderError> {
        renderer.renderer_mut().set_meshlets(&self.gpu, self.meshlets)?;
        let earlier = self.uploads.iter().take(replayed).filter_map(|upload| match upload.as_ref() {
            Upload::Material(kept) => Some(kept),
            _ => None,
        });
        for (index, kept) in earlier.enumerate() {
            let material = CustomMaterialId::from_raw(u32::try_from(index).unwrap_or(u32::MAX));
            renderer.set_material_uniforms(&self.gpu, material, &kept.uniforms)?;
        }
        for upload in self.uploads.iter().skip(replayed) {
            replay(renderer, &self.gpu, upload)?;
        }
        Ok(())
    }

    /// Lose the device on purpose (forced-loss rows).
    pub fn force_device_loss(&mut self) {
        self.watch.force_loss(&self.gpu);
    }

    /// Re-create the device and renderer and replay every upload when the device is lost; answers
    /// whether it did. A failure leaves the device lost (try again later).
    pub fn recover(&mut self) -> Result<bool, RenderError> {
        if !self.watch.is_lost() {
            return Ok(false);
        }
        let gpu = (self.open)()?;
        let (width, height) = self.size;
        let mut renderer = FrameRenderer::with_native_features(&gpu, width, height, self.options, self.declared)?;
        // The setting first, so every replayed mesh is clustered once, by it.
        renderer.renderer_mut().set_meshlets(&gpu, self.meshlets)?;
        // The lost device's texture arrays, so every replayed texture keeps its class and layer.
        if let Some((class, quality)) = self.renderer.renderer().texture_arrays() {
            renderer.renderer_mut().set_texture_arrays(&gpu.device, class, quality);
        }
        for upload in &self.uploads {
            replay(&mut renderer, &gpu, upload)?;
        }
        // A new device starts every history over (auto exposure adapts at once).
        renderer.reset_history(HistoryReset::DeviceRecreated);
        // A spare was made on the lost device.
        self.spare = None;
        self.watch = DeviceWatch::attach(&gpu);
        self.renderer = renderer;
        self.gpu = gpu;
        self.generation += 1;
        self.builds += 1;
        Ok(true)
    }
}

fn replay(renderer: &mut FrameRenderer, gpu: &Gpu, upload: &Upload) -> Result<(), RenderError> {
    match upload {
        Upload::Mesh(mesh) => renderer.add_mesh(gpu, mesh.clone()).map(drop),
        Upload::Meshes(parts) => renderer.add_meshes_with_meshlets(gpu, parts.clone()).map(drop),
        Upload::Skinned(data) => renderer.add_skinned_mesh(gpu, data).map(drop),
        Upload::Texture(data, kind) => renderer.add_texture(gpu, data, *kind).map(drop),
        Upload::Material(kept) => renderer.add_material_api(gpu, kept.api, &kept.wgsl, &kept.uniforms, &kept.textures).map(drop),
        Upload::PostPass(stage, kept) => renderer.add_post_pass_api(gpu, kept.api, *stage, &kept.wgsl, &kept.uniforms, &kept.textures).map(drop),
        Upload::Emitter(desc) => renderer.add_emitter(gpu, *desc).map(drop),
    }
}
