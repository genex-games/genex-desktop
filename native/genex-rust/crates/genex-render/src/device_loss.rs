//! Device-loss recovery (plan "HiDPI and pacing"; forced-loss rows here and in the M5 gate). A
//! [`DeviceWatch`] marks the device lost from wgpu's device-lost callback; while it is lost every
//! frame and capture answers the typed `device-lost` refusal and nothing touches the device. The
//! [`Resilient`] renderer keeps a CPU cache of everything it uploaded (meshes, skinned meshes,
//! textures, custom materials, post passes, emitters, in the order they were added; a model or
//! texture decoded from bytes the program holds for its whole life keeps only how to decode it
//! again, [`Resilient::add_meshes_from`], so a game's compiled assets are not resident twice), so
//! [`Resilient::recover`] re-creates the adapter and device, rebuilds the renderer and replays the
//! cache: every id is the same and the next frame draws the identical image. Each recovery bumps
//! [`Resilient::generation`], the ring generation the Live sender re-announces.
//!
//! A mesh removed with [`Resilient::remove_mesh`] (game systems STR-2) is replayed as its removal:
//! the cache logs the ids each removal freed, and once every mesh of an upload is gone the upload
//! keeps no data, only how many slots it held. A replay holds those slots empty and frees them
//! where the removal was, so every live id, every removed id's generation and every slot a later
//! mesh reused come back the same.
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
//! instead of compiling every pipeline again. A spare that was the renderer in use comes back with
//! its temporal history when at most [`SPARE_HISTORY_FRAMES_MAX`] frames were drawn while it was
//! out (a capture's settle: Live's TAA, temporal AO and exposure go on where they were, review
//! F5); any other renderer swapped in starts its history over.

use std::collections::BTreeMap;
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
use crate::letterbox::present::{PresentInto, WindowPresent};
use crate::mesh::MeshData;
use crate::meshlet::MeshletSet;
use crate::overlay::OverlayPainter;
use crate::particles::{EmitterDesc, EmitterId, ParticleAtlas, ParticleAtlasId};
use crate::renderer::RenderOptions;
use crate::settings::Meshlets;
use crate::scene::{MeshId, ModelPart};
use crate::skin::{SkinId, SkinnedMeshData, SkinnedModel};
use crate::tables::CullPath;
use crate::texture::{CompressedTexture, TextureData, TextureFamily, TextureId, TextureKind};

/// Whether a device has been lost, set from wgpu's device-lost callback.
#[derive(Clone, Debug)]
pub struct DeviceWatch {
    lost: Arc<AtomicBool>,
}

impl DeviceWatch {
    /// Watch `gpu`'s device. Once it is lost, wgpu's errors from work already in flight are
    /// logged instead of panicking (the default handler's behaviour stays for a live device).
    /// With the crash hook installed (CRASH-2), a loss is a `device-lost` record that is not fatal
    /// (recovery goes on) and an uncaptured error on a live device panics as a `gpu-validation`
    /// record with its class.
    pub fn attach(gpu: &Gpu) -> DeviceWatch {
        let lost = Arc::new(AtomicBool::new(false));
        let on_lost = Arc::clone(&lost);
        gpu.device.set_device_lost_callback(move |reason, message| {
            on_lost.store(true, Ordering::SeqCst);
            log::warn!("genex-render: device lost ({reason:?}): {message}");
            genex_crash::record_device_lost(lost_reason(reason), &message);
        });
        let on_error = Arc::clone(&lost);
        gpu.device.on_uncaptured_error(Arc::new(move |error: wgpu::Error| {
            if on_error.load(Ordering::SeqCst) {
                log::warn!("genex-render: error on a lost device: {error}");
                return;
            }
            // wgpu's own default: an uncaptured validation error on a live device is a bug. The
            // crash hook types the panic below by the error's class.
            genex_crash::note_gpu_error(error_class(&error), &error.to_string());
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

/// A wgpu device-lost reason as the crash record spells it.
fn lost_reason(reason: wgpu::DeviceLostReason) -> &'static str {
    match reason {
        wgpu::DeviceLostReason::Destroyed => "destroyed",
        wgpu::DeviceLostReason::Unknown => "unknown",
    }
}

/// The crash record's class of an uncaptured wgpu error.
fn error_class(error: &wgpu::Error) -> genex_crash::GpuErrorClass {
    match error {
        wgpu::Error::OutOfMemory { .. } => genex_crash::GpuErrorClass::OutOfMemory,
        wgpu::Error::Internal { .. } => genex_crash::GpuErrorClass::Internal,
        wgpu::Error::Validation { .. } => genex_crash::GpuErrorClass::Validation,
    }
}

fn device_lost() -> RenderError {
    RenderError::refused(RenderCode::DeviceLost, "the GPU device was lost; it is being re-created")
}

/// Every part of one model with the meshlets and levels of detail each brought, as
/// [`Resilient::add_model_parts`] takes them.
pub type ModelParts = Vec<ModelPart>;

/// Where a model's parts come back from for a replay: decoded again from bytes that live as long
/// as the program (a game's compiled asset table), so no CPU copy is kept (review F6). A replay may
/// run on the thread that warms a renderer ([`RendererPlan::build`]).
pub type PartsSource = Arc<dyn Fn() -> Result<ModelParts, RenderError> + Send + Sync>;
/// Where a texture comes back from for a replay, as [`PartsSource`].
pub type TextureSource = Arc<dyn Fn() -> Result<TextureData, RenderError> + Send + Sync>;
/// Where a compressed texture comes back from for a replay (renderer pass 2 A6.4), as
/// [`PartsSource`].
pub type CompressedSource = Arc<dyn Fn() -> Result<CompressedTexture, RenderError> + Send + Sync>;

/// One upload, kept to replay after a loss.
#[derive(Clone)]
enum Upload {
    Mesh(MeshData),
    /// Every part of one model with the meshlets each brought, replayed as one upload.
    Meshes(ModelParts),
    /// [`Upload::Meshes`] decoded again from its source at each replay.
    MeshesFrom(PartsSource),
    Skinned(SkinnedMeshData),
    /// A skinned GLB with its parts (game systems AN-17), kept.
    SkinnedModel(Box<SkinnedModel>),
    Texture(TextureData, TextureKind),
    /// [`Upload::Texture`] decoded again from its source at each replay.
    TextureFrom(TextureSource, TextureKind),
    /// A compressed texture in the renderer's family (A6.4), kept.
    Compressed(CompressedTexture, TextureKind),
    /// [`Upload::Compressed`] read again from its source at each replay.
    CompressedFrom(CompressedSource, TextureKind),
    Material(Extension),
    PostPass(PostStage, Extension),
    Emitter(EmitterDesc),
    /// A flipbook atlas (renderer pass 2 A.11), kept.
    ParticleAtlas(ParticleAtlas),
    /// A mesh upload whose meshes were all removed (STR-2): only the slots it held (its parts and
    /// their levels), held empty at a replay so the ids after it come back the same.
    Vacant(u32),
    /// A removal (STR-2): every id it freed, the mesh's first, freed again at a replay.
    Removed(Vec<MeshId>),
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

    fn bytes(&self) -> u64 {
        let textures: u64 = self.textures.iter().map(texture_bytes).sum();
        (self.wgsl.len() + self.uniforms.len()) as u64 + textures
    }
}

/// The CPU bytes a kept mesh holds.
fn mesh_bytes(mesh: &MeshData) -> u64 {
    (std::mem::size_of_val(mesh.vertices.as_slice()) + std::mem::size_of_val(mesh.indices.as_slice())) as u64
}

/// The CPU bytes a kept meshlet set holds.
fn meshlet_bytes(set: &MeshletSet) -> u64 {
    (std::mem::size_of_val(set.meshlets.as_slice()) + std::mem::size_of_val(set.vertices.as_slice()) + std::mem::size_of_val(set.triangles.as_slice())) as u64
}

/// The CPU bytes a kept model part holds: its mesh, meshlets and levels' indices.
fn part_bytes(part: &ModelPart) -> u64 {
    let levels = part.lods.as_ref().map_or(0, |chain| chain.levels.iter().map(|level| std::mem::size_of_val(level.indices.as_slice()) as u64).sum());
    mesh_bytes(&part.mesh) + part.meshlets.as_ref().map_or(0, meshlet_bytes) + levels
}

/// The CPU bytes a kept texture holds.
fn texture_bytes(data: &TextureData) -> u64 {
    data.rgba().len() as u64
}

impl Upload {
    /// The CPU bytes this upload keeps for a replay.
    fn kept_bytes(&self) -> u64 {
        match self {
            Upload::Mesh(mesh) => mesh_bytes(mesh),
            Upload::Meshes(parts) => parts.iter().map(part_bytes).sum(),
            Upload::Skinned(data) => mesh_bytes(&data.mesh) + std::mem::size_of_val(data.skin.as_slice()) as u64,
            Upload::SkinnedModel(model) => mesh_bytes(&model.data.mesh) + std::mem::size_of_val(model.data.skin.as_slice()) as u64,
            Upload::Texture(data, _) => texture_bytes(data),
            Upload::Material(kept) | Upload::PostPass(_, kept) => kept.bytes(),
            Upload::Emitter(_) => std::mem::size_of::<EmitterDesc>() as u64,
            Upload::ParticleAtlas(atlas) => texture_bytes(&atlas.image),
            Upload::Compressed(texture, _) => texture.levels().iter().map(|level| level.len() as u64).sum(),
            Upload::Removed(ids) => std::mem::size_of_val(ids.as_slice()) as u64,
            Upload::MeshesFrom(_) | Upload::TextureFrom(..) | Upload::CompressedFrom(..) | Upload::Vacant(_) => 0,
        }
    }
}

impl std::fmt::Debug for Upload {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Upload::Mesh(mesh) => f.debug_tuple("Mesh").field(mesh).finish(),
            Upload::Meshes(parts) => f.debug_tuple("Meshes").field(&parts.len()).finish(),
            Upload::MeshesFrom(_) => f.write_str("MeshesFrom"),
            Upload::Skinned(_) => f.write_str("Skinned"),
            Upload::SkinnedModel(model) => f.debug_tuple("SkinnedModel").field(&model.parts.len()).finish(),
            Upload::Texture(data, kind) => f.debug_tuple("Texture").field(&(data.width(), data.height())).field(kind).finish(),
            Upload::TextureFrom(_, kind) => f.debug_tuple("TextureFrom").field(kind).finish(),
            Upload::Compressed(texture, kind) => f.debug_tuple("Compressed").field(&(texture.family(), texture.side())).field(kind).finish(),
            Upload::CompressedFrom(_, kind) => f.debug_tuple("CompressedFrom").field(kind).finish(),
            Upload::Material(_) => f.write_str("Material"),
            Upload::PostPass(stage, _) => f.debug_tuple("PostPass").field(stage).finish(),
            Upload::Emitter(desc) => f.debug_tuple("Emitter").field(desc).finish(),
            Upload::ParticleAtlas(atlas) => f.debug_tuple("ParticleAtlas").field(&(atlas.image.width(), atlas.image.height(), atlas.columns, atlas.rows)).finish(),
            Upload::Vacant(slots) => f.debug_tuple("Vacant").field(slots).finish(),
            Upload::Removed(ids) => f.debug_tuple("Removed").field(&ids.len()).finish(),
        }
    }
}

/// A spare that was the renderer in use keeps its history when at most this many frames were
/// drawn while it was out (a capture's settle and the frames around it); after more, its history
/// is too old and starts over.
pub const SPARE_HISTORY_FRAMES_MAX: u64 = 64;

/// Opens a fresh device (natively `Gpu::headless` or the shell's surface-compatible opener).
pub type GpuOpener = Box<dyn FnMut() -> Result<Gpu, RenderError>>;

/// A renderer kept for its options while another one draws, and the uploads it holds.
struct Spare {
    options: RenderOptions,
    renderer: FrameRenderer,
    replayed: usize,
    /// The frames drawn when it stopped being the renderer in use; None for one that never was.
    out_since: Option<u64>,
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
    texture_family: TextureFamily,
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
        set_family(&mut renderer, &self.gpu, self.texture_family)?;
        if let Some((class, quality)) = self.texture_arrays {
            renderer.renderer_mut().set_texture_arrays(&self.gpu.device, class, quality);
        }
        for upload in &self.uploads {
            replay(&mut renderer, &self.gpu, upload)?;
        }
        Ok(Prepared { renderer, options: self.options, replayed: self.uploads.len(), generation: self.generation, keeps_history: false })
    }
}

/// A renderer a [`RendererPlan`] built, for [`Resilient::adopt`] (or [`Resilient::keep_as_spare`]).
pub struct Prepared {
    renderer: FrameRenderer,
    options: RenderOptions,
    replayed: usize,
    generation: u32,
    /// It was the renderer in use a moment ago (a spare swapped back): its history goes on.
    keeps_history: bool,
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
    /// The window present's pipelines and letterbox-sized images, on this device.
    window: WindowPresent,
    /// Frames drawn, by whichever renderer was in use.
    frames: u64,
    /// Every live mesh slot (parts and their levels) and the upload that made it (STR-2).
    mesh_upload: BTreeMap<MeshId, usize>,
    /// Per mesh upload still in the cache: the slots it held and how many are live.
    upload_slots: BTreeMap<usize, (u32, u32)>,
}

/// The slots `ids` (a mesh upload's parts) hold in `renderer`: each part, then its levels.
fn held_slots(renderer: &FrameRenderer, ids: &[MeshId]) -> Vec<MeshId> {
    let library = renderer.renderer().library();
    ids.iter().flat_map(|id| std::iter::once(*id).chain(library.lods(*id).map(|lods| lods.levels.clone()).unwrap_or_default())).collect()
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
            window: WindowPresent::default(),
            frames: 0,
            mesh_upload: BTreeMap::new(),
            upload_slots: BTreeMap::new(),
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

    /// The CPU bytes kept to replay the uploads after a loss or onto a rebuilt renderer: what a
    /// game's procedural meshes, decoded files and Level-2 sources hold in RAM (wasm memory on the
    /// web) beside their GPU copies. Uploads with a source ([`Resilient::add_meshes_from`],
    /// [`Resilient::add_texture_from`]) keep none.
    pub fn kept_bytes(&self) -> u64 {
        self.uploads.iter().map(|upload| upload.kept_bytes()).sum()
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
        let id = self.upload(Upload::Mesh(mesh.clone()), |r, gpu| r.add_mesh(gpu, mesh))?;
        self.note_mesh_upload(&[id]);
        Ok(id)
    }

    /// Remember which upload (the last one) made the slots of `ids`, for [`Resilient::remove_mesh`].
    fn note_mesh_upload(&mut self, ids: &[MeshId]) {
        let at = self.uploads.len() - 1;
        let slots = held_slots(&self.renderer, ids);
        let held = slots.len() as u32;
        self.mesh_upload.extend(slots.into_iter().map(|slot| (slot, at)));
        self.upload_slots.insert(at, (held, held));
    }

    /// Remove mesh `id` and its levels ([`crate::Renderer::remove_mesh`], STR-2), logged for
    /// replay: the cache drops the upload's data once all its meshes are removed, and a replay
    /// keeps every id. Answers every id freed; `device-lost` while the device is lost.
    pub fn remove_mesh(&mut self, id: MeshId) -> Result<Vec<MeshId>, RenderError> {
        self.healthy()?;
        let freed = self.renderer.renderer_mut().remove_mesh(id).map_err(|e| self.lost_or(e))?;
        for slot in &freed {
            let Some(at) = self.mesh_upload.remove(slot) else { continue };
            let Some((held, live)) = self.upload_slots.get_mut(&at) else { continue };
            *live -= 1;
            if *live == 0 {
                self.uploads[at] = Arc::new(Upload::Vacant(*held));
                self.upload_slots.remove(&at);
            }
        }
        self.uploads.push(Arc::new(Upload::Removed(freed.clone())));
        Ok(freed)
    }

    /// Add every part of one model with one library upload (kept for replay as one).
    pub fn add_meshes(&mut self, meshes: Vec<MeshData>) -> Result<Vec<MeshId>, RenderError> {
        self.add_meshes_with_meshlets(meshes.into_iter().map(|mesh| (mesh, None)).collect())
    }

    /// [`Resilient::add_meshes`] with the meshlets each part brought (a GLB part's
    /// `genex_meshlets`), kept for replay with them.
    pub fn add_meshes_with_meshlets(&mut self, parts: Vec<(MeshData, Option<MeshletSet>)>) -> Result<Vec<MeshId>, RenderError> {
        self.add_model_parts(parts.into_iter().map(|(mesh, meshlets)| ModelPart { mesh, meshlets, lods: None }).collect())
    }

    /// [`Resilient::add_meshes_with_meshlets`] with each part's levels of detail (renderer pass 2
    /// A6.9), kept for replay with them.
    pub fn add_model_parts(&mut self, parts: ModelParts) -> Result<Vec<MeshId>, RenderError> {
        let ids = self.upload(Upload::Meshes(parts.clone()), |r, gpu| r.add_model_parts(gpu, parts))?;
        self.note_mesh_upload(&ids);
        Ok(ids)
    }

    /// [`Resilient::add_meshes_with_meshlets`] for parts that `source` decodes again (bytes the
    /// program holds for its whole life, a game's compiled assets): nothing is kept, and a replay
    /// takes the parts from `source`.
    pub fn add_meshes_from(&mut self, parts: ModelParts, source: PartsSource) -> Result<Vec<MeshId>, RenderError> {
        let ids = self.upload(Upload::MeshesFrom(source), |r, gpu| r.add_model_parts(gpu, parts))?;
        self.note_mesh_upload(&ids);
        Ok(ids)
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

    /// Add a skinned GLB's mesh with its parts (game systems AN-17, kept for replay).
    pub fn add_skinned_model(&mut self, model: &SkinnedModel) -> Result<SkinId, RenderError> {
        self.upload(Upload::SkinnedModel(Box::new(model.clone())), |r, gpu| r.add_skinned_model(gpu, model))
    }

    /// Add a texture (kept for replay).
    pub fn add_texture(&mut self, data: &TextureData, kind: TextureKind) -> Result<TextureId, RenderError> {
        self.upload(Upload::Texture(data.clone(), kind), |r, gpu| r.add_texture(gpu, data, kind))
    }

    /// [`Resilient::add_texture`] for a texture that `source` decodes again (as
    /// [`Resilient::add_meshes_from`]): nothing is kept.
    pub fn add_texture_from(&mut self, data: &TextureData, kind: TextureKind, source: TextureSource) -> Result<TextureId, RenderError> {
        self.upload(Upload::TextureFrom(source, kind), |r, gpu| r.add_texture(gpu, data, kind))
    }

    /// Store the larger size classes in `family` (renderer pass 2 A6.4,
    /// [`crate::Renderer::set_texture_family`]); a rebuilt renderer takes it before its replay.
    pub fn set_texture_family(&mut self, family: TextureFamily) -> Result<(), RenderError> {
        self.healthy()?;
        self.renderer.renderer_mut().set_texture_family(&self.gpu, family).map_err(|e| self.lost_or(e))
    }

    /// Add a compressed texture in the renderer's family (A6.4, kept for replay).
    pub fn add_compressed_texture(&mut self, texture: &CompressedTexture, kind: TextureKind) -> Result<TextureId, RenderError> {
        self.upload(Upload::Compressed(texture.clone(), kind), |r, gpu| r.add_compressed_texture(gpu, texture, kind))
    }

    /// [`Resilient::add_compressed_texture`] for a file `source` reads again: nothing is kept.
    pub fn add_compressed_texture_from(&mut self, texture: &CompressedTexture, kind: TextureKind, source: CompressedSource) -> Result<TextureId, RenderError> {
        self.upload(Upload::CompressedFrom(source, kind), |r, gpu| r.add_compressed_texture(gpu, texture, kind))
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

    /// Add a flipbook atlas (kept for replay).
    pub fn add_particle_atlas(&mut self, atlas: ParticleAtlas) -> Result<ParticleAtlasId, RenderError> {
        let kept = atlas.clone();
        self.upload(Upload::ParticleAtlas(kept), |r, gpu| r.add_particle_atlas(gpu, &atlas))
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
        self.frames += 1;
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
    /// window's frame, upscaled with FSR1 into a larger letterbox and filtered into a smaller one
    /// ([`crate::letterbox::present`]); nothing is drawn while the device is lost.
    pub fn present(&mut self, target: &wgpu::TextureView, format: wgpu::TextureFormat, window: (u32, u32)) {
        self.present_with(target, format, window, None);
    }

    /// [`Resilient::present`], then `overlay` (the HUD) painted over the letterbox at the window's
    /// pixels, after the upscale. Answers the overlay's draws (0 while the device is lost).
    pub fn present_with(&mut self, target: &wgpu::TextureView, format: wgpu::TextureFormat, window: (u32, u32), overlay: Option<&mut dyn OverlayPainter>) -> u32 {
        if self.watch.is_lost() {
            return 0;
        }
        let renderer = self.renderer.renderer();
        // The world target as the last frame drew it: an output size set since applies from the
        // next frame on (renderer pass 2, P2-0.9 step B).
        let world = renderer.world_texture();
        let fill = renderer.fit() == crate::letterbox::Fit::Expand;
        let into = PresentInto { fill, world: (renderer.world_view(), (world.width(), world.height())), target, format, window };
        self.window.present(&self.gpu, &into, overlay)
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
            let keeps_history = self.history_kept(&spare);
            let Spare { renderer, replayed, .. } = spare;
            self.swap_in(Prepared { renderer, options, replayed, generation: self.generation, keeps_history })?;
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

    /// Let the spare go (answers whether one was kept): a warm-up about to build a new renderer
    /// from a plan releases it first, so the renderer in use and the one warmed are the only two
    /// sets of render targets held at once (GB live-app round 1: a Live preset cycle held three
    /// and Studio's memory cap stopped the game).
    pub fn release_spare(&mut self) -> bool {
        self.spare.take().is_some()
    }

    /// The spare built for `options`, brought up to date with every upload, to warm on another
    /// thread and [`Resilient::adopt`] (None when there is none for those options).
    pub fn take_spare(&mut self, options: RenderOptions) -> Result<Option<Prepared>, RenderError> {
        self.healthy()?;
        let Some(spare) = self.spare.take_if(|spare| spare.options == options) else { return Ok(None) };
        let keeps_history = self.history_kept(&spare);
        let Spare { mut renderer, replayed, .. } = spare;
        self.catch_up(&mut renderer, replayed)?;
        Ok(Some(Prepared { renderer, options, replayed: self.uploads.len(), generation: self.generation, keeps_history }))
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
            texture_family: self.renderer.renderer().texture_family(),
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
            self.spare = Some(Spare { options, renderer, replayed, out_since: None });
        }
        usable
    }

    /// `prepared` becomes the renderer in use once it holds every upload (with today's material
    /// uniforms and meshlet setting); the one it replaces becomes the spare when spares are kept
    /// and its options differ.
    fn swap_in(&mut self, prepared: Prepared) -> Result<(), RenderError> {
        let Prepared { mut renderer, options, replayed, keeps_history, .. } = prepared;
        self.catch_up(&mut renderer, replayed)?;
        if !keeps_history {
            renderer.reset_history(HistoryReset::Settings);
        }
        let replaced = std::mem::replace(&mut self.renderer, renderer);
        let replaced_options = std::mem::replace(&mut self.options, options);
        if self.spare.as_ref().is_some_and(|spare| spare.options == options) {
            self.spare = None;
        }
        if self.keep_spare && replaced_options != options {
            self.spare = Some(Spare { options: replaced_options, renderer: replaced, replayed: self.uploads.len(), out_since: Some(self.frames) });
        }
        Ok(())
    }

    /// Whether `spare` comes back with its history: it was the renderer in use, and at most
    /// [`SPARE_HISTORY_FRAMES_MAX`] frames were drawn since.
    fn history_kept(&self, spare: &Spare) -> bool {
        spare.out_since.is_some_and(|at| self.frames.saturating_sub(at) <= SPARE_HISTORY_FRAMES_MAX)
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
        set_family(&mut renderer, &gpu, self.renderer.renderer().texture_family())?;
        if let Some((class, quality)) = self.renderer.renderer().texture_arrays() {
            renderer.renderer_mut().set_texture_arrays(&gpu.device, class, quality);
        }
        for upload in &self.uploads {
            replay(&mut renderer, &gpu, upload)?;
        }
        // A new device starts every history over (auto exposure adapts at once).
        renderer.reset_history(HistoryReset::DeviceRecreated);
        // A spare and the window present were made on the lost device.
        self.spare = None;
        self.window = WindowPresent::default();
        self.watch = DeviceWatch::attach(&gpu);
        self.renderer = renderer;
        self.gpu = gpu;
        self.generation += 1;
        self.builds += 1;
        Ok(true)
    }
}

/// A rebuilt renderer takes the family its compressed textures were stored in (A6.4) before any
/// upload is replayed; RGBA8, the default, needs nothing.
fn set_family(renderer: &mut FrameRenderer, gpu: &Gpu, family: TextureFamily) -> Result<(), RenderError> {
    if family == TextureFamily::Rgba8 {
        return Ok(());
    }
    renderer.renderer_mut().set_texture_family(gpu, family)
}

fn replay(renderer: &mut FrameRenderer, gpu: &Gpu, upload: &Upload) -> Result<(), RenderError> {
    match upload {
        Upload::Mesh(mesh) => renderer.add_mesh(gpu, mesh.clone()).map(drop),
        Upload::Meshes(parts) => renderer.add_model_parts(gpu, parts.clone()).map(drop),
        Upload::MeshesFrom(source) => renderer.add_model_parts(gpu, source()?).map(drop),
        Upload::Skinned(data) => renderer.add_skinned_mesh(gpu, data).map(drop),
        Upload::SkinnedModel(model) => renderer.add_skinned_model(gpu, model).map(drop),
        Upload::Texture(data, kind) => renderer.add_texture(gpu, data, *kind).map(drop),
        Upload::TextureFrom(source, kind) => renderer.add_texture(gpu, &source()?, *kind).map(drop),
        Upload::Compressed(texture, kind) => renderer.add_compressed_texture(gpu, texture, *kind).map(drop),
        Upload::CompressedFrom(source, kind) => renderer.add_compressed_texture(gpu, &source()?, *kind).map(drop),
        Upload::Material(kept) => renderer.add_material_api(gpu, kept.api, &kept.wgsl, &kept.uniforms, &kept.textures).map(drop),
        Upload::PostPass(stage, kept) => renderer.add_post_pass_api(gpu, kept.api, *stage, &kept.wgsl, &kept.uniforms, &kept.textures).map(drop),
        Upload::Emitter(desc) => renderer.add_emitter(gpu, *desc).map(drop),
        Upload::ParticleAtlas(atlas) => renderer.add_particle_atlas(gpu, atlas).map(drop),
        Upload::Vacant(slots) => {
            for _ in 0..*slots {
                renderer.renderer_mut().hold_mesh_slot();
            }
            Ok(())
        }
        Upload::Removed(ids) => {
            for id in ids {
                renderer.renderer_mut().vacate_mesh(*id);
            }
            Ok(())
        }
    }
}
