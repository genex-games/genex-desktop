//! The one presenter every shell draws a game with, native and web: genex-render's renderer V1
//! ([`FrameRenderer`], behind the device-loss-safe [`Resilient`]) fed the frame a game's draw hooks
//! wrote ([`Frame`] seen from a [`Camera`]) as an [`ImmediateFrame`], with the game's custom GPU
//! passes inside the frame and the HUD (genex-hud's [`HudPainter`]) painted last, so a capture,
//! Live's ring and the browser's canvas carry everything the player sees. The triangles drawn are
//! counted per tag for `state().__render`.
//!
//! It is platform-neutral and compiles for wasm32: a shell opens the device its own way and hands
//! it over ([`Presenter::with_gpu`]) with where models come from (a [`ModelSource`]) and where
//! refusals are logged. Natively a studio run or the desktop shell opens it headless on the host
//! GPU (`Presenter::open`, in `present_files.rs` with the asset folders); the web shell
//! (genex-platform-web) opens it on the canvas's adapter, with the staged assets the page fetched.
//!
//! The device is opened with exactly the native-enhanced features the game declared (`[gpu]
//! native_features`, which the lane compiles in as `GENEX_NATIVE_FEATURES`; the web has none);
//! one it lacks refuses the run `native-feature-missing`. A frame that fails keeps its refusal: a
//! capture then answers that code instead of reading back a stale picture, and a lost device
//! answers `device-lost` until [`Presenter::recover`] re-creates it, replays the meshes and
//! rebuilds the passes.
//!
//! Every frame hands the renderer the frame's choice: quality, render scale, the class's scene
//! format, the game's look and the class's form factor (which MSAA resolve the HDR path takes), so
//! a game draws the HDR scene (linear, pre-exposed, tonemapped by its look) unless something in
//! the frame keeps it on the legacy LDR scene: a v1 in-world custom pass or a v1 material, named in
//! Live's `degraded` ([`crate::render::RenderControl::note_ldr_reason`]). Before every frame the
//! presenter hands the pass registry the scene's render size and the pipeline-shaping facts the
//! frame draws with (`FrameRenderer::pipeline_facts`: the scene format and the depth convention);
//! when those facts change, every pass is rebuilt through the device-loss path
//! ([`CustomPasses::set_pipeline_facts`]). A model whose file is missing or
//! malformed draws the magenta checker cube, as the C++ runtime's missing asset does, is never
//! retried, and is named in `state().__render.missingModels`.
//!
//! A frame's Level-2 draws (`frame.custom`, `frame.post_pass`) use the materials and post passes the
//! game's reset admitted (`extend.rs`): each is created on the device the first time a frame uses
//! it, kept by its place among the reset's requests and its source (so a new seed reuses it), its
//! uniforms re-sent when the game changed them; the device-loss path replays them. A refused or
//! missing material draws the checker, a refused post pass is skipped, and a refusal on the device
//! is noted on the handle for `state().volatile.extensions`. Extensions read the tick's simulated
//! seconds, never the wall clock.
//!
//! A frame's lights (`frame.sun`, `frame.ambient`, `frame.point_light`) and its draws' materials
//! become the renderer's scene through one conversion ([`to_scene`] for a bare [`Scene`], the same
//! writer for the presenter's frame), so the phone shells' bridge, native and web draw one scene.
//! A model is loaded once per path ([`AssetCache`]) as one mesh per material its GLB names, with
//! the textures those materials sample; a draw's own [`crate::Material`] replaces them, and its
//! textures load once per path and kind. A texture that cannot load leaves its slot untextured
//! (neutral), never the checker. A dev build's `reloadAssets` ([`Presenter::reload_assets`]) has
//! the files it names read again by the next frame, once their new bytes match the host's digest.
//!
//! Every frame draws through the game's render settings ([`crate::render::RenderControl`], owned
//! by the runtime and attached on the first draw, probed with this device's facts). A **Live**
//! frame ([`Presenter::draw_view`]) takes the resolved Live quality at dynamic resolution's scale
//! step, is timed (GPU timestamps where offered, CPU encode time always) and feeds the controller;
//! a **capture** ([`Presenter::set_capturing`]) takes the pinned capture profile at its nominal
//! scale, is never timed, never moves dynamic resolution and never writes Live's `degraded`
//! findings. A capture is **settled** (RQ1.5, `genex_render::settle`): the held frame is re-drawn K
//! times on the renderer's capture-owned history (K is `genex_render::settle::settle_plan`'s: the
//! jitter cycle with TAA or temporal AO drawn, 2 with auto exposure on the HDR path (3 when a
//! Level-3 `post-hdr` pass changes the scene before it is metered), else 1; the
//! game's Level-3 passes run once per re-render with `PassFrame::settle` set), the HUD painted
//! on the last, so Live's history neither resets nor pops and the reply's `render.settleFrames`
//! names the K drawn. Live frames carry their sim tick: the renderer's Live history index counts
//! drawn frames (the jitter walks every position at any cadence) and adaptation moves by the ticks
//! a frame ran (a redraw of the same tick, such as the Live picture restored after a capture, moves
//! it by none). The world pass's samples (MSAA or TAA's one) are built for Live's anti-aliasing at
//! its first frame and again on an explicit settings change (the person's panel, the verb), and a
//! capture draws with its pinned profile's own, so it is the same picture in any boot order
//! ([`Presenter::draw_view`]; the renderer is rebuilt when they differ). A shell whose frames are paced at the sim rate (the web's tick-gated `rAF`) hands
//! over each display frame's interval ([`Presenter::note_display_frame`]): dynamic resolution then
//! reads the longest display interval since the last Live frame, never the gap between rendered
//! frames, so skipping a tickless display frame is not a missed vsync.
//!
//! A studio run changes settings off the frame thread ([`Presenter::set_off_thread_changes`],
//! native only): after an explicit change Live keeps drawing the settings it drew last while
//! another thread builds and warms the new configuration's renderer (`warm.rs`), which is then
//! swapped in, and the renderer it replaced is kept as the spare for its samples; a capture's
//! pinned profile is warmed as that spare too. A warm-up that builds a new renderer lets the spare
//! go first when the three would hold more than a GiB of targets ([`Presenter::renderers_held`]).
//! The frame thread never compiles a whole new
//! configuration, so the studio's verbs and heartbeat are answered throughout.
//!
//! Host glue for the platform shells, not game API: a game never holds a renderer.
//!
//! [`FrameRenderer`]: genex_render::FrameRenderer

mod characters;
mod hud_history;
#[cfg(not(target_arch = "wasm32"))]
mod warm;

use std::sync::Arc;
use std::time::Duration;

use crate::camera::{Camera, Projection};
use crate::render::{CaptureRender, FrameChoice, RenderHandle, WebHints};
use crate::extend::{ExtensionRefusal, GpuKey, GpuParts};
use crate::frame::{Color, CustomMesh, DEFAULT_METALLIC, DEFAULT_ROUGHNESS, Frame, Lights, Shape};
use crate::gfx::{AssetTable, Model};
use crate::lod::{LodRefusalCode, ModelLod};
use genex_core::paths::is_safe_asset_path;
use crate::runtime::{FIXED_STEP_MS, Runtime, View};
use genex_hud::egui::epaint::textures::TexturesDelta;
use genex_hud::{HudPaint, HudPainter};
use genex_render::custom_pass::{CUSTOM_TAG, CustomPass, CustomPasses, NoCustom, PassStage, PipelineFacts};
use genex_render::device_loss::{CompressedSource, GpuOpener, ModelParts, PartsSource, Resilient, TextureSource};
use genex_render::extension::{CustomMaterialId, PostPassId, PostStage};
use genex_render::hdri::{HdriImage, PreparedMap};
use genex_render::settings::{Environment, Quality};
#[cfg(not(target_arch = "wasm32"))]
use genex_render::extension::native_features;
use genex_render::immediate::HUD_TAG;
use genex_render::mesh::{CUBE_TRIANGLES, GlbMaterial, GlbModel, GlbSidecars, MeshData, SPHERE_TRIANGLES, decode_image};
use genex_render::meshlet::MeshletSet;
use genex_render::motion::DrawId;
use genex_render::letterbox::{letterbox, output_for_window};
use genex_render::overlay::OverlayPainter;
use genex_render::lights::SpotLight;
use genex_render::scene::{CameraDesc, Lighting, LineVertex, Material, MeshId, PointLight, Scene, scaled};
use genex_render::lod_rows::DrawLod;
use genex_render::texture::{CompressedTexture, TextureData, TextureFamily, TextureId, TextureKind, family_file, linear_to_srgb, read_ktx2, srgb_to_linear};
use genex_render::presets::{on_ldr_scene, with_world_samples};
use genex_render::renderer::landed_samples;
use genex_render::timing::{Clock, CpuTimer};
use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier, TargetOs};
use genex_render::{CullPath, Gpu, GpuCounters, ImmediateFrame, RenderCode, RenderError, RenderOptions, WORLD_FORMAT};

/// The streamed view set the presenter draws for a game that registered `game.streaming` (STR-16).
pub use characters::{CharacterStats, RATE_FULL_PX, RATE_HALF_PX, RATE_QUARTER_PX, RateBand, palette_digest, rate_band};
pub use crate::present_stream::{
    STREAM_LOADS_DESKTOP, STREAM_LOADS_PHONE, STREAM_LOADS_WEB, STREAM_VIEW_CELL_MODELS_MAX, STREAM_VIEW_MODEL_ESTIMATE_BYTES, StreamView, ViewIo,
    ViewLimits, ViewStats,
};

/// The renderer's planes for a facade camera, which carries none.
const NEAR_PLANE: f32 = 0.1;
const FAR_PLANE: f32 = 1000.0;
/// Device pixels per HUD point before a window is known. A capture paints the HUD into the world
/// target at its own size's pixels per point (1 at the logical world size, 2 for a capture asked
/// at twice it); Live paints it over the window after the upscale, at the letterbox's own ratio
/// ([`Presenter::present`]).
pub const WORLD_PIXELS_PER_POINT: f32 = 1.0;
/// The native-enhanced features a game declares, as the lane compiles them in: wire names
/// (`subgroup`, `ray-query`, ...) joined by commas. Absent or empty: WebGPU core only. The web is
/// always WebGPU core, so only native shells read it.
#[cfg(not(target_arch = "wasm32"))]
const DECLARED_FEATURES: Option<&str> = option_env!("GENEX_NATIVE_FEATURES");

/// What one drawn frame counted.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Drawn {
    /// Logical tagged draws: the game's, one per custom pass and one per HUD primitive.
    pub draw_calls: u32,
    /// Triangles drawn.
    pub triangles: u32,
    /// Triangles per tag, in first-draw order.
    pub by_tag: Vec<(String, u32)>,
    /// Models drawn as the missing-asset checker, in first-draw order.
    pub missing_models: Vec<String>,
    /// The textures the frame bound, one per path in first-bound order ([`texture_facts`], C-11).
    pub textures: Vec<TextureFact>,
    /// What those textures tell an agent to fix ([`texture_facts`], C-11).
    pub asset_issues: Vec<AssetIssue>,
    /// The models drawn whole because a level-of-detail option was refused, once per model and
    /// code in first-draw order (`state().__render.lodRefused`, game systems LOD-07).
    pub lod_refused: Vec<LodRefused>,
    /// What the GPU encoded for the frame (`state().volatile.gpu`), never compared.
    pub gpu: GpuCounters,
}

/// A model drawn whole because a level-of-detail option was refused (game systems LOD-07).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LodRefused {
    /// The model's path (a compound's first member's; empty for a compound with no members).
    pub model: String,
    /// Why.
    pub code: LodRefusalCode,
}

/// Where a bound texture's texels came from (`__render.textures[path].family`, C-11).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TextureOrigin {
    /// A family file the Studio's import step wrote (`<stem>.<family>.ktx2`).
    Family(TextureFamily),
    /// The image itself, decoded to RGBA8 on the device's CPU.
    Source,
}

impl TextureOrigin {
    /// Wire spelling: the family's (`bc`, `astc`, `etc2`, `rgba8`) or `source`.
    pub const fn wire(self) -> &'static str {
        match self {
            TextureOrigin::Family(family) => family.wire(),
            TextureOrigin::Source => "source",
        }
    }
}

/// Why `state().__render.assetIssues` names an asset (C-11). Display only: an issue never moves
/// the checksum and never refuses anything.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum AssetIssueCode {
    /// A texture loaded from its image because the game ships no family file of it at all (the
    /// import step encoded none: its usage was not resolved), or a GLB image (`<model>#<image>`)
    /// loaded from the GLB because it ships no sidecar of it in any family (C-14: the model was not
    /// imported, or its image could not be encoded).
    TextureUncompressed,
    /// A texture loaded from its image because the renderer refused the family file the game
    /// ships in the device's family (unreadable, or every size class it fits is full: the
    /// detail is in the log), so it is drawn uncompressed. A GLB image whose sidecar was refused
    /// is named `<model>#<image>` (C-14).
    TextureFamilyRefused,
    /// A model with a normal-mapped primitive that had no TANGENT, so MikkTSpace ran at load
    /// (game systems C-9): the import step, which writes the tangents, was skipped.
    TangentsRuntime,
}

impl AssetIssueCode {
    /// Every code, in declaration order.
    pub const ALL: [AssetIssueCode; 3] = [AssetIssueCode::TextureUncompressed, AssetIssueCode::TextureFamilyRefused, AssetIssueCode::TangentsRuntime];

    /// Wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            AssetIssueCode::TextureUncompressed => "texture-uncompressed",
            AssetIssueCode::TextureFamilyRefused => "texture-family-refused",
            AssetIssueCode::TangentsRuntime => "tangents-runtime",
        }
    }
}

/// One texture a frame bound (`state().__render.textures`, C-11): its asset path (a GLB-embedded
/// image is `<model>#<image>`), the array kind its slot samples and where its texels came from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TextureFact {
    /// The asset path, or `<model path>#<image index>` for an image inside a GLB.
    pub path: String,
    /// The kind its slot samples it as (the first slot, when one file fills several).
    pub kind: TextureKind,
    /// Where its texels came from.
    pub origin: TextureOrigin,
}

impl TextureFact {
    /// The usage a `[[texture]]` row would name for it (`color`, `data`, `normal`; the host's
    /// TextureUsage): an alpha-tested base colour is `color`.
    pub const fn usage(&self) -> &'static str {
        match self.kind {
            TextureKind::Color | TextureKind::Cutout => "color",
            TextureKind::Data => "data",
            TextureKind::Normal => "normal",
        }
    }
}

/// One asset issue (`state().__render.assetIssues`, C-11).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssetIssue {
    /// The asset path.
    pub path: String,
    /// What is wrong with it.
    pub code: AssetIssueCode,
}

/// Where the presenter reads a model's GLB bytes, by its path under `assets/`: natively the table
/// a game compiled in and the asset folder, on the web the table and the files the page fetched.
pub trait ModelSource {
    /// The bytes of `path`, or None when the game has no such asset.
    fn model_bytes(&self, path: &str) -> Option<Vec<u8>>;

    /// Whether the game has an asset at `path` (by default: whether its bytes read).
    fn has_asset(&self, path: &str) -> bool {
        self.model_bytes(path).is_some()
    }

    /// The bytes of `path` when the program holds them for its whole life (the table a game
    /// compiled in), so a renderer replays the upload by decoding them again instead of keeping a
    /// decoded copy (review F6). None, the default: the upload's data is kept.
    fn static_bytes(&self, _path: &str) -> Option<&'static [u8]> {
        None
    }
}

impl ModelSource for AssetTable {
    fn model_bytes(&self, path: &str) -> Option<Vec<u8>> {
        self.static_bytes(path).map(<[u8]>::to_vec)
    }

    fn has_asset(&self, path: &str) -> bool {
        self.static_bytes(path).is_some()
    }

    fn static_bytes(&self, path: &str) -> Option<&'static [u8]> {
        self.iter().find(|(known, _)| *known == path).map(|(_, bytes)| *bytes)
    }
}

/// Where the presenter reports a model it refused or a step it skipped: the native shells' stderr,
/// the browser's console.
pub type Log = fn(&str);

/// A model loaded for drawing: one mesh per material its GLB names, and its triangles.
#[derive(Clone, Debug, PartialEq)]
pub struct LoadedModel {
    /// The parts, in first-use order of their materials.
    pub parts: Vec<ModelPart>,
    /// Triangles of every part.
    pub triangles: u32,
    /// The GLB images its parts' materials sample, uploaded, in first-use order.
    pub textures: Vec<ModelTexture>,
    /// A normal-mapped primitive had no TANGENT, so its tangents were generated at load (C-9).
    pub runtime_tangents: bool,
    /// The model-space sphere around every part's mesh (centre xyz, radius; 0 when unknown): a
    /// compound's parts measure their levels from its members' spheres together (LOD-07).
    pub sphere: [f32; 4],
}

/// One GLB image a [`LoadedModel`] uploaded (C-11, C-14).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ModelTexture {
    /// The glTF image index.
    pub image: u32,
    /// The kind it was uploaded as.
    pub kind: TextureKind,
    /// Where its texels came from: a sidecar family file (`genex_textures`) or the embedded image.
    pub origin: TextureOrigin,
    /// Why it loaded from the embedded image, when that is the game's to fix.
    pub issue: Option<AssetIssueCode>,
}

/// One mesh of a [`LoadedModel`] and the material its GLB names for it (`None`: it names none).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ModelPart {
    /// The mesh in the renderer's library.
    pub mesh: MeshId,
    /// Its material, textures uploaded.
    pub material: Option<GlbMaterial<TextureId>>,
}

/// Where an [`AssetCache`] puts what it loads: a renderer's mesh library and texture arrays.
pub trait Uploads {
    /// Add a mesh.
    fn add_mesh(&mut self, mesh: MeshData) -> Result<MeshId, RenderError>;
    /// Add every part of one model. A renderer uploads its library once for them all (the
    /// default adds them one by one).
    fn add_meshes(&mut self, meshes: Vec<MeshData>) -> Result<Vec<MeshId>, RenderError> {
        meshes.into_iter().map(|mesh| self.add_mesh(mesh)).collect()
    }
    /// Add every part of one model with the meshlets each brought (a GLB part's
    /// `genex_meshlets`, R2.3). A renderer clusters a part by its set when the set is valid (the
    /// default drops the sets: [`Uploads::add_meshes`]).
    fn add_meshes_with_meshlets(&mut self, parts: Vec<(MeshData, Option<MeshletSet>)>) -> Result<Vec<MeshId>, RenderError> {
        self.add_meshes(parts.into_iter().map(|(mesh, _)| mesh).collect())
    }
    /// Add every part of one model with its meshlets and levels of detail (a GLB part's
    /// `genex_lods`, renderer pass 2 A6.9): a renderer draws each instance at the level its
    /// distance picks (the default drops the levels: [`Uploads::add_meshes_with_meshlets`]).
    fn add_model_parts(&mut self, parts: ModelParts) -> Result<Vec<MeshId>, RenderError> {
        self.add_meshes_with_meshlets(parts.into_iter().map(|part| (part.mesh, part.meshlets)).collect())
    }
    /// Add a texture as the next layer of its kind's array.
    fn add_texture(&mut self, data: &TextureData, kind: TextureKind) -> Result<TextureId, RenderError>;
    /// Add a character's GLB as a skinned model with its parts (game systems AN-17); refused by
    /// default, and a refused character draws its model in bind pose.
    fn add_skinned_model(&mut self, _model: &genex_render::skin::SkinnedModel) -> Result<genex_render::skin::SkinId, RenderError> {
        Err(RenderError::refused(RenderCode::MeshInvalid, "skinned models are not taken here"))
    }
    /// Remove mesh `id` and its levels (an evicted streamed model, STR-16). The default holds no
    /// meshes, so it removes nothing.
    fn remove_mesh(&mut self, _id: MeshId) -> Result<(), RenderError> {
        Ok(())
    }
    /// [`Uploads::add_meshes_with_meshlets`] for parts `source` decodes again from bytes the
    /// program holds for its whole life: a renderer that replays uploads keeps the source, not the
    /// parts (the default adds them as any other).
    fn add_meshes_from(&mut self, parts: ModelParts, _source: PartsSource) -> Result<Vec<MeshId>, RenderError> {
        self.add_model_parts(parts)
    }
    /// [`Uploads::add_texture`] for a texture `source` decodes again, as [`Uploads::add_meshes_from`].
    fn add_texture_from(&mut self, data: &TextureData, kind: TextureKind, _source: TextureSource) -> Result<TextureId, RenderError> {
        self.add_texture(data, kind)
    }
    /// The widest HDR environment map the device keeps (a decoded map is box-filtered down to it
    /// before it is cached, `genex_render::hdri::prepare_map`); 0, the default, keeps it whole.
    fn environment_map_width(&self) -> u32 {
        0
    }
    /// The compressed texture families the device samples, best first (renderer pass 2 A6.4);
    /// none, the default: every texture loads its image.
    fn compressed_families(&self) -> Vec<TextureFamily> {
        Vec::new()
    }
    /// The family the renderer stores its larger textures in (RGBA8, the default).
    fn texture_family(&self) -> TextureFamily {
        TextureFamily::Rgba8
    }
    /// The side of the smallest size class the family is stored in: a family file under it is
    /// held as its image by design, never refused (0, the default: every side).
    fn compressed_min_side(&self) -> u32 {
        0
    }
    /// Store the larger textures in `family` from the first texture on; refused by default.
    fn set_texture_family(&mut self, family: TextureFamily) -> Result<(), RenderError> {
        Err(RenderError::refused(RenderCode::TextureInvalid, format!("{family:?} textures are not taken here")))
    }
    /// Add a compressed texture in the renderer's family (`source` reads its file again for a
    /// replay); refused by default.
    fn add_compressed_texture(&mut self, texture: &CompressedTexture, _kind: TextureKind, _source: Option<CompressedSource>) -> Result<TextureId, RenderError> {
        Err(RenderError::refused(RenderCode::TextureInvalid, format!("{:?} textures are not taken here", texture.family())))
    }
}

impl Uploads for Resilient {
    fn add_mesh(&mut self, mesh: MeshData) -> Result<MeshId, RenderError> {
        Resilient::add_mesh(self, mesh)
    }

    fn add_meshes(&mut self, meshes: Vec<MeshData>) -> Result<Vec<MeshId>, RenderError> {
        Resilient::add_meshes(self, meshes)
    }

    fn add_meshes_with_meshlets(&mut self, parts: Vec<(MeshData, Option<MeshletSet>)>) -> Result<Vec<MeshId>, RenderError> {
        Resilient::add_meshes_with_meshlets(self, parts)
    }

    fn add_model_parts(&mut self, parts: ModelParts) -> Result<Vec<MeshId>, RenderError> {
        Resilient::add_model_parts(self, parts)
    }

    fn add_texture(&mut self, data: &TextureData, kind: TextureKind) -> Result<TextureId, RenderError> {
        Resilient::add_texture(self, data, kind)
    }

    fn add_skinned_model(&mut self, model: &genex_render::skin::SkinnedModel) -> Result<genex_render::skin::SkinId, RenderError> {
        Resilient::add_skinned_model(self, model)
    }

    fn remove_mesh(&mut self, id: MeshId) -> Result<(), RenderError> {
        Resilient::remove_mesh(self, id).map(drop)
    }

    fn add_meshes_from(&mut self, parts: ModelParts, source: PartsSource) -> Result<Vec<MeshId>, RenderError> {
        Resilient::add_meshes_from(self, parts, source)
    }

    fn add_texture_from(&mut self, data: &TextureData, kind: TextureKind, source: TextureSource) -> Result<TextureId, RenderError> {
        Resilient::add_texture_from(self, data, kind, source)
    }

    fn environment_map_width(&self) -> u32 {
        self.renderer().renderer().environment_map_width()
    }

    fn compressed_families(&self) -> Vec<TextureFamily> {
        self.renderer().renderer().compressed_families()
    }

    fn texture_family(&self) -> TextureFamily {
        self.renderer().renderer().texture_family()
    }

    fn compressed_min_side(&self) -> u32 {
        // Class 0 is always RGBA8 (`ClassArrays::family`): a family starts at the next class.
        genex_render::layout::TEXTURE_SIZE_CLASSES[1]
    }

    fn set_texture_family(&mut self, family: TextureFamily) -> Result<(), RenderError> {
        Resilient::set_texture_family(self, family)
    }

    fn add_compressed_texture(&mut self, texture: &CompressedTexture, kind: TextureKind, source: Option<CompressedSource>) -> Result<TextureId, RenderError> {
        match source {
            Some(source) => Resilient::add_compressed_texture_from(self, texture, kind, source),
            None => Resilient::add_compressed_texture(self, texture, kind),
        }
    }
}

/// What [`AssetCache::invalidate`] dropped: the models (their meshes are the renderer's to free)
/// and whether the environment map was among the paths (the presenter uploads it again).
#[derive(Debug, Default, PartialEq)]
pub struct Invalidated {
    /// The models dropped that had loaded (a refused one had nothing on the device).
    pub models: Vec<LoadedModel>,
    /// Whether an environment map was dropped.
    pub environment: bool,
}

/// Why [`Presenter::reload_assets`] left a file as it was.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReloadMiss {
    /// The game's source has no such file.
    Missing,
    /// The bytes the source serves now are not the digest the host named.
    DigestMismatch,
}

/// Whether a change to `changed` touches what was loaded for the texture `path`: the file itself
/// or one of its family files (`<stem>.<family>.ktx2`).
fn touches_texture(path: &str, changed: &str) -> bool {
    path == changed || TextureFamily::ALL.into_iter().any(|family| family_file(path, family) == changed)
}

/// Whether a change to `changed` touches the model loaded from `path`: the GLB itself, or a family
/// file in its folder, which may be one of its image sidecars (C-14; the stems its GLB names are
/// not kept, so any family file there reloads it).
fn touches_model(path: &str, changed: &str) -> bool {
    if path == changed {
        return true;
    }
    let folder = |file: &str| file.rfind('/').map_or("", |at| &file[..=at]).to_owned();
    changed.ends_with(".ktx2") && folder(path) == folder(changed)
}

/// The models and textures a renderer holds for a game, by asset path. Each is tried once: a
/// refusal is kept (a model then draws the checker, a texture leaves its slot untextured) and
/// never retried; only a lost device leaves it to be tried again, and a dev build's
/// `reloadAssets` ([`AssetCache::invalidate`]) has the paths it names tried again.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AssetCache {
    models: Vec<(String, Option<LoadedModel>)>,
    textures: Vec<CachedTexture>,
    /// The environment maps a frame named (`frame.environment(Environment::hdri(..))`), decoded on
    /// the CPU and prepared for the device (None: refused): only the prepared copy is kept, at most
    /// the device's width, its sun found on the full map. The presenter uploads one when the frame
    /// lights with it (again after the environment left it, or the device was lost).
    environments: Vec<(String, Option<Arc<PreparedMap>>)>,
    /// Whether the texture family was chosen (renderer pass 2 A6.4): at the first frame naming a
    /// texture, before any texture loads.
    family_chosen: bool,
    /// The characters' skinned models and poses (AN-17).
    characters: characters::Characters,
    /// What became of the authored levels of each model loaded with them (LOD-07), by cache key:
    /// every GLB it read (a change to any reloads it) and the load's refusal.
    leveled: Vec<Leveled>,
}

/// A model loaded with authored levels (LOD-07): its cache key, the GLBs it read and the load's
/// refusal (`levels-mismatch`, or `levels-invalid` for a level not in the game's assets).
#[derive(Clone, Debug, PartialEq)]
struct Leveled {
    key: String,
    files: Vec<String>,
    refused: Option<LodRefusalCode>,
}

/// One texture an [`AssetCache`] tried: its path and kind, its id (`None`: refused) and where it
/// loaded from (C-11).
#[derive(Clone, Debug, PartialEq)]
struct CachedTexture {
    path: String,
    kind: TextureKind,
    id: Option<TextureId>,
    origin: TextureOrigin,
    /// Why it was loaded from its image, when that is the game's to fix: no family file of it in
    /// any family, or the device's family file refused.
    issue: Option<AssetIssueCode>,
}

/// What became of a texture's file in the renderer's family ([`load_compressed`]).
enum Compressed {
    /// Uploaded as this texture.
    Loaded(TextureId),
    /// Not looked for (the renderer stores RGBA8, an unsafe path) or not shipped.
    Absent,
    /// Shipped but refused (unreadable, or no size class with room); the refusal is logged.
    Refused,
}

/// Whether the game ships `path` in any family (`<stem>.<family>.ktx2`), whether or not the
/// device samples that family; `known` keeps the answers already looked up for this load.
fn ships_any_family<'a>(path: &'a str, source: &dyn ModelSource, known: &mut Vec<(&'a str, bool)>) -> bool {
    if let Some((_, ships)) = known.iter().find(|(known, _)| *known == path) {
        return *ships;
    }
    let ships = TextureFamily::ALL.into_iter().any(|family| source.has_asset(&family_file(path, family)));
    known.push((path, ships));
    ships
}

/// The image sidecars of a model a frame draws (C-14): its path, the stems its GLB names and
/// whether its materials sample any image.
struct ModelSidecars<'a> {
    path: &'a str,
    sidecars: GlbSidecars,
    samples_images: bool,
}

/// `model`'s sidecar `stem` in `family`: `<stem>.<family>.ktx2` in the model's folder (C-13's
/// `glbTextureFileName`), or None when that is not a plain path under `assets/`.
fn sidecar_file(model: &str, stem: &str, family: TextureFamily) -> Option<String> {
    let folder = model.rfind('/').map_or("", |at| &model[..=at]);
    let file = format!("{folder}{stem}.{}.ktx2", family.wire());
    is_safe_asset_path(&file).then_some(file)
}

/// Store the renderer's larger textures in the first family (best first for the device) the
/// game ships a file of for a texture `frame` names (`<stem>.<family>.ktx2`, the Studio's import
/// step writes them; renderer pass 2 A6.4) or for an image sidecar of a model it draws (C-14). A
/// game without one keeps RGBA8, and so does a renderer that already holds a texture.
fn choose_texture_family(frame: &Frame, models: &[ModelSidecars<'_>], source: &dyn ModelSource, uploads: &mut dyn Uploads, log: &mut dyn FnMut(&str)) {
    let paths: Vec<&str> = texture_paths(frame).map(|(path, _)| path).filter(|path| is_safe_asset_path(path)).collect();
    let ships = |family: TextureFamily| {
        let loose = paths.iter().any(|path| source.has_asset(&family_file(path, family)));
        let sidecars = models.iter().flat_map(|model| model.sidecars.rows().iter().map(move |row| (model.path, row.stem.as_str())));
        loose || sidecars.filter_map(|(model, stem)| sidecar_file(model, stem, family)).any(|file| source.has_asset(&file))
    };
    let Some(family) = uploads.compressed_families().into_iter().find(|family| ships(*family)) else { return };
    if let Err(error) = uploads.set_texture_family(family) {
        log(&format!("{} textures not taken: {error}", family.wire()));
    }
}

/// `path`'s compressed file in the renderer's family uploaded as `kind` (renderer pass 2 A6.4):
/// absent when the renderer stores RGBA8 or the game ships no such file, refused when it is
/// unreadable or the renderer refuses it (the image loads instead in both; a refusal is logged).
/// A lost device is passed on.
fn load_compressed(path: &str, kind: TextureKind, source: &dyn ModelSource, uploads: &mut dyn Uploads, log: &mut dyn FnMut(&str)) -> Result<Compressed, RenderError> {
    let family = uploads.texture_family();
    if family == TextureFamily::Rgba8 || !is_safe_asset_path(path) {
        return Ok(Compressed::Absent);
    }
    load_family_file(&family_file(path, family), path, kind, source, uploads, log)
}

/// The family file `file` uploaded as `kind` in place of `path` (a loose image, or a GLB's
/// `<model>#<image>`): absent when the game ships no such file or it is under the family's
/// smallest size class (the image is held there by design), refused (logged) when it is
/// unreadable or the renderer refuses it. A lost device is passed on.
fn load_family_file(file: &str, path: &str, kind: TextureKind, source: &dyn ModelSource, uploads: &mut dyn Uploads, log: &mut dyn FnMut(&str)) -> Result<Compressed, RenderError> {
    let Some(bytes) = source.model_bytes(file) else { return Ok(Compressed::Absent) };
    let texture = match read_ktx2(&bytes) {
        Ok(texture) => texture,
        Err(error) => {
            log(&format!("texture {file:?} refused: {error}; loading {path:?}"));
            return Ok(Compressed::Refused);
        }
    };
    // Under the family's smallest class the renderer holds the image by design (C-14): not a refusal.
    if texture.side() < uploads.compressed_min_side() {
        return Ok(Compressed::Absent);
    }
    let again = source.static_bytes(file).map(|bytes| -> CompressedSource { Arc::new(move || read_ktx2(bytes)) });
    match uploads.add_compressed_texture(&texture, kind, again) {
        Ok(id) => Ok(Compressed::Loaded(id)),
        Err(error) if error.code() == RenderCode::DeviceLost => Err(error),
        Err(error) => {
            log(&format!("texture {file:?} refused: {error}; loading {path:?}"));
            Ok(Compressed::Refused)
        }
    }
}

impl AssetCache {
    /// The model loaded for `path`; `None` when it was refused or never tried.
    pub fn model(&self, path: &str) -> Option<&LoadedModel> {
        self.models.iter().find(|(known, _)| known == path).and_then(|(_, loaded)| loaded.as_ref())
    }

    /// Whether `path` was tried (loaded or refused).
    pub fn tried(&self, path: &str) -> bool {
        self.models.iter().any(|(known, _)| known == path)
    }

    /// Why the authored levels of the model loaded under `key` were refused at load (LOD-07).
    fn lod_refusal(&self, key: &str) -> Option<LodRefusalCode> {
        self.leveled.iter().find(|leveled| leveled.key == key).and_then(|leveled| leveled.refused)
    }

    /// Record `path` as one mesh with no material of its own (`None`: refused), unless it was
    /// tried already: for a shell that loads meshes itself, and for tests.
    pub fn insert_model(&mut self, path: &str, mesh: Option<MeshId>) {
        if !self.tried(path) {
            let loaded = mesh.map(|mesh| LoadedModel { parts: vec![ModelPart { mesh, material: None }], triangles: 0, textures: Vec::new(), runtime_tangents: false, sphere: [0.0; 4] });
            self.models.push((path.to_owned(), loaded));
        }
    }

    /// Record what became of `path`'s load (`None`: refused), replacing what was recorded: the
    /// streamed view set's finish (STR-16).
    pub(crate) fn put_model(&mut self, path: &str, loaded: Option<LoadedModel>) {
        match self.models.iter_mut().find(|(known, _)| known == path) {
            Some(entry) => entry.1 = loaded,
            None => self.models.push((path.to_owned(), loaded)),
        }
    }

    /// Forget `path` (it was evicted): the model it held, for its meshes to be freed; a later
    /// draw loads it again.
    pub(crate) fn take_model(&mut self, path: &str) -> Option<LoadedModel> {
        let at = self.models.iter().position(|(known, _)| known == path)?;
        self.models.remove(at).1
    }

    /// Forget what was loaded from each of `changed` (game systems C-18): a texture loaded from
    /// the file or one of its family files, a model loaded from the GLB or with a family file in
    /// its folder (a character's skin too), an environment map; the next load reads them again, a
    /// refused one included.
    /// Answers the dropped models, whose meshes the caller frees, and whether an environment map
    /// was dropped. Textures already on the device stay there until the device is re-created (a
    /// texture array slot is never freed); what the sim read (`gfx.assets().bytes`) is untouched.
    pub fn invalidate(&mut self, changed: &[&str]) -> Invalidated {
        let mut dropped = Invalidated::default();
        let touched = |path: &str, rule: fn(&str, &str) -> bool| changed.iter().any(|changed| rule(path, changed));
        let mut kept = Vec::with_capacity(self.models.len());
        let leveled_touched = |key: &str| self.leveled.iter().any(|leveled| leveled.key == key && leveled.files.iter().any(|file| touched(file, touches_model)));
        for (path, loaded) in std::mem::take(&mut self.models) {
            if !touched(&path, touches_model) && !leveled_touched(&path) {
                kept.push((path, loaded));
                continue;
            }
            dropped.models.extend(loaded);
        }
        self.models = kept;
        let models = &self.models;
        self.leveled.retain(|leveled| models.iter().any(|(key, _)| *key == leveled.key));
        self.characters.forget(|path| touched(path, touches_model));
        self.textures.retain(|cached| !touched(&cached.path, touches_texture));
        let environments = self.environments.len();
        self.environments.retain(|(path, _)| !changed.contains(&path.as_str()));
        dropped.environment = self.environments.len() != environments;
        dropped
    }

    /// The texture loaded for `path` as `kind`; `None` when it was refused or never tried.
    pub fn texture(&self, path: &str, kind: TextureKind) -> Option<TextureId> {
        self.cached_texture(path, kind).and_then(|cached| cached.id)
    }

    fn cached_texture(&self, path: &str, kind: TextureKind) -> Option<&CachedTexture> {
        self.textures.iter().find(|cached| cached.path == path && cached.kind == kind)
    }

    /// The environment map decoded for `path`, as prepared for the device; `None` when it was
    /// refused or never tried.
    pub fn environment_map(&self, path: &str) -> Option<&HdriImage> {
        self.prepared_environment_map(path).map(|prepared| &prepared.image)
    }

    /// The environment map prepared for `path` (the map and the sun found on the full map).
    pub fn prepared_environment_map(&self, path: &str) -> Option<&PreparedMap> {
        self.environments.iter().find(|(known, _)| known == path).and_then(|(_, map)| map.as_deref())
    }

    /// [`AssetCache::prepared_environment_map`], shared (a renderer warmed on another thread
    /// uploads it there; the web warms nothing off its one thread).
    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn shared_environment_map(&self, path: &str) -> Option<Arc<PreparedMap>> {
        self.environments.iter().find(|(known, _)| known == path).and_then(|(_, map)| map.clone())
    }

    /// The image sidecars of every model `frame` draws that was never tried, once each, read from
    /// its GLB's JSON (a model that does not open has none: its load says why).
    fn untried_sidecars<'a>(&self, frame: &'a Frame, source: &dyn ModelSource) -> Vec<ModelSidecars<'a>> {
        let mut models: Vec<ModelSidecars<'a>> = Vec::new();
        for path in model_paths(frame) {
            if self.tried(path) || models.iter().any(|model| model.path == path) {
                continue;
            }
            let Some((sidecars, samples_images)) = source.model_bytes(path).and_then(|bytes| GlbModel::sidecars_of_glb(&bytes).ok()) else { continue };
            models.push(ModelSidecars { path, sidecars, samples_images });
        }
        models
    }

    /// Load the model at `path` with its authored levels (LOD-07) under `key`, remembering the
    /// files it read and the load's refusal; a refused chain loads the model whole.
    fn load_leveled(&mut self, key: &str, path: &str, lod: &ModelLod, source: &dyn ModelSource, uploads: &mut dyn Uploads, log: &mut dyn FnMut(&str)) -> Result<Option<LoadedModel>, RenderError> {
        let files: Vec<String> = std::iter::once(path).chain(lod.levels.iter().filter_map(|(level, _)| level.path())).map(str::to_owned).collect();
        let (levels, refused) = match level_parts(lod, source) {
            Ok(levels) => (levels, None),
            Err(code) => (Vec::new(), Some(code)),
        };
        let (loaded, refused) = load_model_levels(path, source, uploads, log, (levels, refused))?;
        if let Some(code) = refused {
            log(&format!("model {path:?}: its levels were refused ({}); drawing it whole", code.wire()));
        }
        self.leveled.push(Leveled { key: key.to_owned(), files, refused });
        Ok(loaded)
    }

    /// Load every model and material texture `frame` draws that was never tried: bytes from
    /// `source`, handed to `uploads`; each refusal is told to `log` once. A lost device stops
    /// the load (`device-lost`) and leaves what was not loaded to be tried again.
    pub fn load(&mut self, frame: &Frame, source: &dyn ModelSource, uploads: &mut dyn Uploads, log: &mut dyn FnMut(&str)) -> Result<(), RenderError> {
        if !self.family_chosen {
            let models = self.untried_sidecars(frame, source);
            let textured = texture_paths(frame).next().is_some() || models.iter().any(|model| model.samples_images);
            if textured {
                choose_texture_family(frame, &models, source, uploads, log);
                self.family_chosen = true;
            }
        }
        for (key, model) in model_keys(frame) {
            if self.tried(key) {
                continue;
            }
            let chained = model.and_then(|model| Some((model.path()?, model.lod_options().filter(|lod| lod.chained())?)));
            let loaded = match chained {
                Some((path, lod)) => self.load_leveled(key, path, lod, source, uploads, log)?,
                None => load_model(key, source, uploads, log)?,
            };
            self.models.push((key.to_owned(), loaded));
        }
        self.characters.load(frame, source, uploads, log)?;
        // A file used as several kinds (a base colour that is also a mask) is read once, and its
        // family files are looked for once.
        let mut read: Vec<(&str, Option<TextureData>)> = Vec::new();
        let mut shipped: Vec<(&str, bool)> = Vec::new();
        for (path, kind) in texture_paths(frame) {
            if self.cached_texture(path, kind).is_some() {
                continue;
            }
            let compressed = load_compressed(path, kind, source, uploads, log)?;
            if let Compressed::Loaded(id) = compressed {
                let origin = TextureOrigin::Family(uploads.texture_family());
                self.textures.push(CachedTexture { path: path.to_owned(), kind, id: Some(id), origin, issue: None });
                continue;
            }
            let at = match read.iter().position(|(known, _)| *known == path) {
                Some(at) => at,
                None => {
                    read.push((path, read_texture(path, source, log)));
                    read.len() - 1
                }
            };
            let again = source.static_bytes(path).map(|bytes| -> TextureSource { Arc::new(move || decode_image(bytes)) });
            let id = match &read[at].1 {
                Some(data) => upload_texture(uploads, (data, kind, again), &format!("texture {path:?}"), log)?,
                None => None,
            };
            let issue = match compressed {
                _ if id.is_none() => None,
                Compressed::Refused => Some(AssetIssueCode::TextureFamilyRefused),
                _ if !ships_any_family(path, source, &mut shipped) => Some(AssetIssueCode::TextureUncompressed),
                _ => None,
            };
            self.textures.push(CachedTexture { path: path.to_owned(), kind, id, origin: TextureOrigin::Source, issue });
        }
        if let Some(Environment::Hdri(hdri)) = frame.declared_environment()
            && !self.environments.iter().any(|(known, _)| *known == hdri.path)
        {
            let width = uploads.environment_map_width();
            let map = read_environment(&hdri.path, source, log).map(|decoded| Arc::new(genex_render::hdri::prepare_map(&decoded, width)));
            self.environments.push((hdri.path.clone(), map));
        }
        Ok(())
    }
}

/// The environment `frame` lights with as the renderer gets it (RQ2.5), with the decoded map an
/// HDRI bakes from: what the frame declared ([`Frame::environment`]; none is the flat colour),
/// except that an HDRI whose map was refused, or is not loaded, lights as the flat colour.
pub fn environment_of<'a>(frame: &Frame, assets: &'a AssetCache) -> (Environment, Option<&'a HdriImage>) {
    match frame.declared_environment() {
        None => (Environment::Color, None),
        Some(Environment::Hdri(hdri)) => match assets.environment_map(&hdri.path) {
            Some(map) => (Environment::Hdri(hdri.clone()), Some(map)),
            None => (Environment::Color, None),
        },
        Some(environment) => (environment.clone(), None),
    }
}

/// An environment map decoded (`.hdr`, Radiance RGBE), or `None` (logged) when its path is unsafe,
/// it is not in the game's assets or it does not decode. An unsafe path never reaches `source`.
fn read_environment(path: &str, source: &dyn ModelSource, log: &mut dyn FnMut(&str)) -> Option<HdriImage> {
    if !is_safe_asset_path(path) {
        log(&format!("environment map {path:?} is not a plain path under assets/: lighting with the flat colour"));
        return None;
    }
    let Some(bytes) = source.model_bytes(path) else {
        log(&format!("environment map {path:?} is not in the game's assets: lighting with the flat colour"));
        return None;
    };
    genex_render::hdri::decode(&bytes).map_err(|refusal| log(&format!("environment map {path:?} refused: {refusal}"))).ok()
}

/// Every model path `frame` draws: its shapes', then its custom draws', in draw order (a
/// compound's members' in its place).
fn model_paths(frame: &Frame) -> impl Iterator<Item = &str> {
    model_keys(frame).filter_map(|(key, model)| match model {
        Some(model) => model.path(),
        None => Some(key),
    })
}

/// The model a shape or custom draw names, if it names one (a character's is not a [`Model`]).
fn shape_model(shape: &Shape) -> Option<&Model> {
    match shape {
        Shape::Model { model, .. } => Some(model),
        Shape::Group { group } => match group.shape() {
            crate::GroupShape::Model(model) => Some(model),
            crate::GroupShape::Cube | crate::GroupShape::Sphere => None,
        },
        Shape::Character { .. } | Shape::Cube { .. } | Shape::Sphere { .. } | Shape::Line { .. } | Shape::Lines { .. } => None,
    }
}

/// Every model `frame` draws as its own [`Model`] handle: its shapes', then its custom draws', in
/// draw order, a compound as itself.
fn drawn_models(frame: &Frame) -> impl Iterator<Item = &Model> {
    let shapes = frame.draws().iter().filter_map(|draw| shape_model(&draw.shape));
    let custom = frame.custom_draws().iter().filter_map(|draw| match &draw.mesh {
        CustomMesh::Model(model) => Some(model),
        CustomMesh::Cube | CustomMesh::Sphere => None,
    });
    shapes.chain(custom)
}

/// The asset-cache key of every model `frame` draws, with its handle (none for a character's
/// GLB, keyed by its path): its shapes', then its custom draws', in draw order, a compound's
/// members in its place (LOD-07). A plain model's key is its path.
fn model_keys(frame: &Frame) -> impl Iterator<Item = (&str, Option<&Model>)> {
    let shapes = frame.draws().iter().flat_map(|draw| {
        let (models, character): (&[Model], Option<&str>) = match &draw.shape {
            Shape::Character { animator, .. } => (&[], Some(animator.asset().path())),
            shape => (shape_model(shape).map_or(&[][..], Model::drawn_members), None),
        };
        let models = models.iter().filter_map(|model| Some((model.key()?, Some(model))));
        character.map(|path| (path, None)).into_iter().chain(models)
    });
    let custom = frame.custom_draws().iter().flat_map(|draw| match &draw.mesh {
        CustomMesh::Model(model) => model.drawn_members(),
        CustomMesh::Cube | CustomMesh::Sphere => &[],
    });
    shapes.chain(custom.filter_map(|model| Some((model.key()?, Some(model)))))
}

/// Every model `frame` draws whole because a level-of-detail option was refused (LOD-07), once
/// per model and code in first-draw order: the handle's own refusal, a member's, or its load's.
fn lod_refusals(frame: &Frame, assets: &AssetCache) -> Vec<LodRefused> {
    let mut refused: Vec<LodRefused> = Vec::new();
    for model in drawn_models(frame) {
        let members = model.drawn_members().iter().filter(|member| *member != model);
        let member_codes = members.filter_map(|member| member.lod_refusal().map(|code| (member, code)));
        let loads = model.drawn_members().iter().filter_map(|member| Some((member, assets.lod_refusal(member.key()?)?)));
        let own = model.lod_refusal().map(|code| (model, code));
        for (named, code) in own.into_iter().chain(member_codes).chain(loads) {
            let entry = LodRefused { model: named.path().unwrap_or_default().to_owned(), code };
            if !refused.contains(&entry) {
                refused.push(entry);
            }
        }
    }
    refused
}

/// Every texture path the draws' materials name, with the array kind its slot samples.
fn texture_paths(frame: &Frame) -> impl Iterator<Item = (&str, TextureKind)> {
    let materials = frame.draws().iter().filter_map(|draw| match &draw.shape {
        Shape::Model { material, .. } | Shape::Character { material, .. } => material.as_ref(),
        Shape::Cube { material, .. } | Shape::Sphere { material, .. } => Some(material),
        Shape::Group { group } => group.material(),
        Shape::Line { .. } | Shape::Lines { .. } => None,
    });
    let drawn = materials.flat_map(|material| {
        let slots = [
            (material.base_texture(), TextureKind::Color),
            (material.normal_texture(), TextureKind::Normal),
            (material.metal_rough_texture(), TextureKind::Data),
            (material.emissive_texture(), TextureKind::Color),
        ];
        slots.into_iter().filter_map(|(path, kind)| Some((path?, kind)))
    });
    // The terrain's layers (renderer pass 2 A.7): base colour and height, then the data texture.
    let terrain = frame.drawn_terrain().into_iter().flat_map(|terrain| terrain.layers().iter()).flat_map(|layer| {
        let slots = [(layer.albedo(), TextureKind::Color), (layer.data(), TextureKind::Data)];
        slots.into_iter().filter_map(|(path, kind)| Some((path?, kind)))
    });
    // The decals' maps (renderer pass 2 A.10): base colour, normal map, ORM.
    let decals = frame.decals().iter().flat_map(|decal| {
        let slots = [(decal.base_texture(), TextureKind::Color), (decal.normal_texture(), TextureKind::Normal), (decal.orm_texture(), TextureKind::Data)];
        slots.into_iter().filter_map(|(path, kind)| Some((path?, kind)))
    });
    drawn.chain(terrain).chain(decals)
}

/// The textures `frame` binds with what `assets` loaded (`state().__render.textures`, C-11): one
/// fact per path in first-bound order (the material, terrain and decal slots, then the images of
/// the GLB models drawn with their own materials, each from its sidecar or its embedded image,
/// C-14), and the asset issues (`__render.assetIssues`): a texture or GLB image loaded from its
/// image while the game ships no family file (sidecar) of it, or whose family file the renderer
/// refused, then each model drawn whose tangents were generated at load (C-9). A texture
/// refused or not loaded yet is not bound. Display only: nothing here enters the simulation.
pub fn texture_facts(frame: &Frame, assets: &AssetCache) -> (Vec<TextureFact>, Vec<AssetIssue>) {
    let mut facts: Vec<TextureFact> = Vec::new();
    let mut issues = Vec::new();
    for (path, kind) in texture_paths(frame) {
        let Some(cached) = assets.cached_texture(path, kind).filter(|cached| cached.id.is_some()) else { continue };
        if facts.iter().any(|fact| fact.path == path) {
            continue;
        }
        facts.push(TextureFact { path: path.to_owned(), kind, origin: cached.origin });
        if let Some(code) = cached.issue {
            issues.push(AssetIssue { path: path.to_owned(), code });
        }
    }
    let mut models: Vec<&str> = Vec::new();
    for (key, path) in models_with_own_materials(frame) {
        if models.contains(&key) {
            continue;
        }
        models.push(key);
        let Some(loaded) = assets.model(key) else { continue };
        for texture in &loaded.textures {
            let key = format!("{path}#{}", texture.image);
            // An image bound in two usages is one fact (its first) but each usage's issue counts.
            if let Some(code) = texture.issue
                && !issues.iter().any(|issue| issue.path == key && issue.code == code)
            {
                issues.push(AssetIssue { path: key.clone(), code });
            }
            if !facts.iter().any(|fact| fact.path == key) {
                facts.push(TextureFact { path: key, kind: texture.kind, origin: texture.origin });
            }
        }
    }
    // Every model drawn whose tangents were generated at load (C-9), once, in first-draw order.
    let mut named: Vec<&str> = Vec::new();
    for (key, model) in model_keys(frame) {
        let path = model.and_then(Model::path).unwrap_or(key);
        if named.contains(&path) || !assets.model(key).is_some_and(|loaded| loaded.runtime_tangents) {
            continue;
        }
        named.push(path);
        issues.push(AssetIssue { path: path.to_owned(), code: AssetIssueCode::TangentsRuntime });
    }
    (facts, issues)
}

/// The cache keys and paths of the models `frame` draws with the materials their GLBs name (no
/// material given), a compound's members in its place.
fn models_with_own_materials(frame: &Frame) -> impl Iterator<Item = (&str, &str)> {
    frame.draws().iter().flat_map(|draw| {
        let (models, character): (&[Model], Option<&str>) = match &draw.shape {
            Shape::Model { model, material: None, .. } => (model.drawn_members(), None),
            Shape::Character { animator, material: None, .. } => (&[], Some(animator.asset().path())),
            Shape::Group { group } if group.material().is_none() => match group.shape() {
                crate::GroupShape::Model(model) => (model.drawn_members(), None),
                crate::GroupShape::Cube | crate::GroupShape::Sphere => (&[], None),
            },
            _ => (&[], None),
        };
        let models = models.iter().filter_map(|model| Some((model.key()?, model.path()?)));
        character.map(|path| (path, path)).into_iter().chain(models)
    })
}

/// The terrain `frame` draws as the renderer takes it (renderer pass 2 A.7), its layers' textures
/// from `assets` (a missing one draws its layer flat), with its version; None without one. A
/// renderer drawn without the presenter (a scene bridge) hands it to `Renderer::set_terrain`.
pub fn terrain_of(frame: &Frame, assets: &AssetCache) -> Option<(genex_render::terrain::TerrainDesc, u64)> {
    let terrain = frame.drawn_terrain()?;
    Some((terrain_desc(terrain, assets), terrain.version()))
}

/// The renderer's terrain for `terrain`, its layers' textures from `assets` (a missing one draws
/// its layer flat).
fn terrain_desc(terrain: &crate::Terrain, assets: &AssetCache) -> genex_render::terrain::TerrainDesc {
    let layers = terrain
        .layers()
        .iter()
        .map(|layer| {
            let (tint, fallback, tile, roughness, normal_strength) = layer.look();
            let texture = |path: Option<&str>, kind| path.and_then(|path| assets.texture(path, kind));
            let linear = |c: u8| genex_render::texture::srgb_to_linear(c);
            let albedo = texture(layer.albedo(), TextureKind::Color);
            // Without its base colour the layer is flat in its fallback colour.
            let tint = match albedo {
                Some(_) => tint.to_array(),
                None => [linear(fallback.r), linear(fallback.g), linear(fallback.b)],
            };
            genex_render::terrain::TerrainLayer {
                albedo,
                data: texture(layer.data(), TextureKind::Data),
                tint,
                tile,
                roughness,
                normal_strength,
                // Its grass (A.8), in linear colours.
                grass: layer.grass().map(crate::Grass::render_layer),
            }
        })
        .collect();
    genex_render::terrain::TerrainDesc { heights: terrain.heights().clone(), control: terrain.control().to_vec(), layers, look: terrain.look() }
}

/// A texture file decoded, or `None` (logged) when its path is unsafe, it is not in the game's
/// assets or it does not decode. An unsafe path never reaches `source`.
fn read_texture(path: &str, source: &dyn ModelSource, log: &mut dyn FnMut(&str)) -> Option<TextureData> {
    if !is_safe_asset_path(path) {
        log(&format!("texture {path:?} is not a plain path under assets/: drawing it untextured"));
        return None;
    }
    let Some(bytes) = source.model_bytes(path) else {
        log(&format!("texture {path:?} is not in the game's assets: drawing it untextured"));
        return None;
    };
    decode_image(&bytes).map_err(|error| log(&format!("texture {path:?} refused: {error}"))).ok()
}

/// One texture to upload: its data, the array it goes to and, for bytes the program holds for its
/// whole life, how a replay decodes it again.
type TextureUpload<'a> = (&'a TextureData, TextureKind, Option<TextureSource>);

/// Upload one texture: its id, `None` (logged as `what`) when refused, `device-lost` passed on.
fn upload_texture(uploads: &mut dyn Uploads, texture: TextureUpload<'_>, what: &str, log: &mut dyn FnMut(&str)) -> Result<Option<TextureId>, RenderError> {
    let (data, kind, again) = texture;
    let added = match again {
        Some(source) => uploads.add_texture_from(data, kind, source),
        None => uploads.add_texture(data, kind),
    };
    match added {
        Ok(id) => Ok(Some(id)),
        Err(error) if error.code() == RenderCode::DeviceLost => Err(error),
        Err(error) => {
            log(&format!("{what} refused: {error}"));
            Ok(None)
        }
    }
}

/// Load one model: every part's mesh and the textures its materials sample. A missing or
/// malformed file, or a refused mesh, refuses the model (logged); a refused texture only its slot.
pub(crate) fn load_model(path: &str, source: &dyn ModelSource, uploads: &mut dyn Uploads, log: &mut dyn FnMut(&str)) -> Result<Option<LoadedModel>, RenderError> {
    Ok(load_model_levels(path, source, uploads, log, (Vec::new(), None))?.0)
}

/// Each authored level's parts with its switch distance (LOD-07), read from the game's assets:
/// `levels-invalid` for a level the game does not ship, `levels-mismatch` for one that does not
/// open as a GLB with triangles.
fn level_parts(lod: &ModelLod, source: &dyn ModelSource) -> Result<Vec<(ModelParts, f32)>, LodRefusalCode> {
    let mut levels = Vec::with_capacity(lod.levels.len());
    for ((level, _), metres) in lod.levels.iter().zip(lod.distances()) {
        let bytes = level.path().and_then(|path| source.model_bytes(path)).ok_or(LodRefusalCode::LevelsInvalid)?;
        let parts = GlbModel::parts_from_glb(&bytes).map_err(|_| LodRefusalCode::LevelsMismatch)?;
        levels.push((parts, metres));
    }
    Ok(levels)
}

/// `parts` with authored `levels` as each part's chain (LOD-07): level k's part i appended to
/// part i's vertices, its triangles over them, its switch distance as the error the renderer's
/// rule switches at ([`crate::lod::switch_error`]). Replaces any imported chain.
fn with_authored_levels(parts: ModelParts, levels: &[(ModelParts, f32)]) -> ModelParts {
    let mut parts = parts;
    for (at, part) in parts.iter_mut().enumerate() {
        let mut chain = genex_render::mesh::LodChain::default();
        for (level_parts, metres) in levels {
            let level = &level_parts[at].mesh;
            let base = part.mesh.vertices.len() as u32;
            part.mesh.vertices.extend_from_slice(&level.vertices);
            let indices = level.indices.iter().map(|index| base + index).collect();
            chain.levels.push(genex_render::mesh::LodLevel { indices, error: crate::lod::switch_error(*metres) });
        }
        part.lods = Some(chain);
    }
    parts
}

/// The smallest sphere around two (centre xyz, radius); a radius that is not positive is none.
fn union_sphere(a: [f32; 4], b: [f32; 4]) -> [f32; 4] {
    let positive = |radius: f32| radius > 0.0;
    if !positive(a[3]) {
        return b;
    }
    if !positive(b[3]) {
        return a;
    }
    let offset = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let distance = (offset[0] * offset[0] + offset[1] * offset[1] + offset[2] * offset[2]).sqrt();
    if distance + b[3] <= a[3] {
        return a;
    }
    if distance + a[3] <= b[3] {
        return b;
    }
    let radius = (distance + a[3] + b[3]) * 0.5;
    let t = (radius - a[3]) / distance;
    [a[0] + offset[0] * t, a[1] + offset[1] * t, a[2] + offset[2] * t, radius]
}

/// The sphere around every part's mesh.
fn parts_sphere(parts: &ModelParts) -> [f32; 4] {
    parts.iter().fold([0.0; 4], |sphere, part| {
        let ([x, y, z], radius) = part.mesh.bounds();
        union_sphere(sphere, [x, y, z, radius])
    })
}

/// [`load_model`] with authored `levels` (LOD-07; none for a plain model) and the refusal they
/// already met: a level with another part count than the model's refuses them
/// `levels-mismatch`, and a refused chain loads the model whole. Answers the load and the chain's
/// refusal.
fn load_model_levels(
    path: &str,
    source: &dyn ModelSource,
    uploads: &mut dyn Uploads,
    log: &mut dyn FnMut(&str),
    (levels, refused): (Vec<(ModelParts, f32)>, Option<LodRefusalCode>),
) -> Result<(Option<LoadedModel>, Option<LodRefusalCode>), RenderError> {
    let Some(bytes) = source.model_bytes(path) else {
        log(&format!("model {path:?} is not in the game's assets: drawing the missing-asset checker"));
        return Ok((None, refused));
    };
    // Images are decoded only when their sidecar does not load (C-14).
    let glb = match GlbModel::from_glb_undecoded(&bytes) {
        Ok(glb) => glb,
        Err(error) => {
            log(&format!("model {path:?} refused: {error}"));
            return Ok((None, refused));
        }
    };
    if let GlbSidecars::Malformed(detail) = glb.sidecars() {
        log(&format!("model {path:?}: genex_textures ignored ({detail}); loading its embedded images"));
    }
    let mut images: Vec<(ModelTexture, Option<TextureId>)> = Vec::new();
    let mut parts = Vec::with_capacity(glb.parts().len());
    let mut triangles = 0u32;
    // Every part in one upload: the renderer writes the model's own rows once, not once a material.
    // Each part brings the clusters the importer wrote (R2.3); a part without them clusters at runtime.
    // Its levels of detail (`genex_lods`, A6.9) come along: far instances draw a coarser level.
    let model_parts: ModelParts = glb.model_parts();
    let sphere = parts_sphere(&model_parts);
    let mismatch = levels.iter().any(|(level, _)| level.len() != model_parts.len());
    let refused = refused.or(mismatch.then_some(LodRefusalCode::LevelsMismatch));
    let still = source.static_bytes(path);
    let added = match still {
        // Authored levels (LOD-07) upload merged parts, which a replay keeps as they are.
        _ if refused.is_none() && !levels.is_empty() => uploads.add_model_parts(with_authored_levels(model_parts, &levels)),
        Some(bytes) => uploads.add_meshes_from(model_parts, Arc::new(move || GlbModel::parts_from_glb(bytes))),
        None => uploads.add_model_parts(model_parts),
    };
    let meshes = match added {
        Ok(meshes) => meshes,
        Err(error) if error.code() == RenderCode::DeviceLost => return Err(error),
        Err(error) => {
            log(&format!("model {path:?} refused: {error}"));
            return Ok((None, refused));
        }
    };
    for (part, mesh) in glb.parts().iter().zip(meshes) {
        for warning in &part.meshlet_warnings {
            // The importer's clusters were refused (R2.3): the mesh clusters at runtime instead.
            log(&format!("model {path:?}: {} (primitive {}), clustered at runtime", warning.fault.wire(), warning.primitive));
        }
        triangles = triangles.saturating_add(triangles_of(&part.mesh));
        let material = match part.material {
            Some(material) => Some(glb_textures(GlbSource { path, bytes: &bytes, still, glb: &glb }, &material, &mut images, (source, uploads), log)?),
            None => None,
        };
        parts.push(ModelPart { mesh, material });
    }
    let textures = images.iter().filter(|(_, id)| id.is_some()).map(|(texture, _)| *texture).collect();
    let runtime_tangents = glb.parts().iter().any(|part| part.runtime_tangents);
    Ok((Some(LoadedModel { parts, triangles, textures, runtime_tangents, sphere }), refused))
}

/// A model's GLB as [`glb_textures`] reads its images: its path, its bytes (an image without a
/// sidecar is decoded from them), the bytes again when the program holds them for its whole life
/// (a replay decodes from them), and the parsed model.
struct GlbSource<'a> {
    path: &'a str,
    bytes: &'a [u8],
    still: Option<&'static [u8]>,
    glb: &'a GlbModel,
}

/// Whether the game ships image `image` of `model` as a sidecar in any family for a slot sampling
/// `kind`, whether or not the device samples that family (the import step did its part).
fn ships_any_sidecar(model: &GlbSource<'_>, image: u32, kind: TextureKind, source: &dyn ModelSource) -> bool {
    let Some(stem) = model.glb.sidecars().stem(image, kind) else { return false };
    TextureFamily::ALL.into_iter().filter_map(|family| sidecar_file(model.path, stem, family)).any(|file| source.has_asset(&file))
}

/// What became of a GLB image's sidecar ([`upload_sidecar`]).
enum Sidecar {
    /// Uploaded from the family file as this texture.
    Loaded(TextureId, TextureFamily),
    /// Shipped but refused (logged): the embedded image loads, named `texture-family-refused`.
    Refused,
}

/// Image `image` of `model` uploaded as `kind` from its sidecar in the renderer's family (C-14);
/// `None` when the GLB names no sidecar for it, the renderer stores RGBA8 or the family file is
/// not shipped, so the embedded image loads. A lost device is passed on.
fn upload_sidecar(model: &GlbSource<'_>, image: u32, kind: TextureKind, source: &dyn ModelSource, uploads: &mut dyn Uploads, log: &mut dyn FnMut(&str)) -> Result<Option<Sidecar>, RenderError> {
    let family = uploads.texture_family();
    let file = model.glb.sidecars().stem(image, kind).filter(|_| family != TextureFamily::Rgba8).and_then(|stem| sidecar_file(model.path, stem, family));
    let Some(file) = file else { return Ok(None) };
    match load_family_file(&file, &format!("{}#{image}", model.path), kind, source, uploads, log)? {
        Compressed::Loaded(id) => Ok(Some(Sidecar::Loaded(id, family))),
        Compressed::Absent => Ok(None),
        Compressed::Refused => Ok(Some(Sidecar::Refused)),
    }
}

/// `material` with its images uploaded, each image and kind once per model (`images` holds those
/// done): from the image's sidecar in the renderer's family when the GLB names one and the game
/// ships it (C-14), else from the embedded image, decoded here; an image that cannot be used
/// leaves its slot untextured (logged).
fn glb_textures(
    model: GlbSource<'_>,
    material: &GlbMaterial,
    images: &mut Vec<(ModelTexture, Option<TextureId>)>,
    (source, uploads): (&dyn ModelSource, &mut dyn Uploads),
    log: &mut dyn FnMut(&str),
) -> Result<GlbMaterial<TextureId>, RenderError> {
    for (image, kind) in material.textures() {
        if images.iter().any(|(done, _)| done.image == image && done.kind == kind) {
            continue;
        }
        let refused = match upload_sidecar(&model, image, kind, source, uploads, log)? {
            Some(Sidecar::Loaded(id, family)) => {
                images.push((ModelTexture { image, kind, origin: TextureOrigin::Family(family), issue: None }, Some(id)));
                continue;
            }
            Some(Sidecar::Refused) => true,
            None => false,
        };
        let what = format!("model {:?} image {image}", model.path);
        let again = model.still.map(|bytes| -> TextureSource { Arc::new(move || GlbModel::image_from_glb(bytes, image)) });
        let id = match GlbModel::image_from_glb(model.bytes, image) {
            Ok(data) => upload_texture(uploads, (&data, kind, again), &what, log)?,
            Err(error) => {
                log(&format!("{what} refused: {error}"));
                None
            }
        };
        let issue = match id {
            None => None,
            Some(_) if refused => Some(AssetIssueCode::TextureFamilyRefused),
            Some(_) if !ships_any_sidecar(&model, image, kind, source) => Some(AssetIssueCode::TextureUncompressed),
            Some(_) => None,
        };
        images.push((ModelTexture { image, kind, origin: TextureOrigin::Source, issue }, id));
    }
    let uploaded = |image: u32, kind: TextureKind| images.iter().find(|(done, _)| done.image == image && done.kind == kind).and_then(|(_, id)| *id);
    Ok(material.map_textures(uploaded))
}

/// One Level-2 extension on the device: the request it was made for (its place among the reset's
/// requests of its kind and its source), its id (None when the device refused it) and the
/// uniforms last sent.
struct OnDevice<Id> {
    index: u32,
    source: std::sync::Arc<str>,
    id: Option<Id>,
    uniforms: Vec<u8>,
}

/// The game's Level-2 materials and post passes on this presenter's device.
#[derive(Default)]
struct Level2 {
    materials: Vec<OnDevice<CustomMaterialId>>,
    posts: Vec<OnDevice<PostPassId>>,
}

/// Where the extension `key` names lives in `held`, if it was created already.
fn held_at<Id>(held: &[OnDevice<Id>], key: &GpuKey) -> Option<usize> {
    held.iter().position(|known| known.index == key.index && *known.source == *key.source)
}

/// One custom pass as `volatile.customPasses` lists it: its name, stage and the code that stopped
/// it (None while it runs).
pub type PassStatus = (String, PassStage, Option<RenderCode>);

/// The renderer, its GPU, the game's passes, the HUD painter and the meshes it holds.
pub struct Presenter {
    /// The renderer on its device, re-created after a device loss.
    pub resilient: Resilient,
    /// The game's custom GPU passes (M2.19), registered at install.
    pub passes: CustomPasses,
    hud: HudPainter,
    /// The HUD's texture changes the painter has not received yet (a frame that was not drawn
    /// keeps them for the next one).
    hud_unsent: TexturesDelta,
    /// Every texture the HUD set so far (the font atlas first), frees applied: what a painter on
    /// a re-created device receives before anything else.
    hud_history: TexturesDelta,
    /// The last Live frame's HUD, painted over the window after the upscale at every present
    /// (its texture changes wait in `hud_unsent`); None after a capture, whose world carries its own.
    live_hud: Option<HudPaint>,
    /// Device pixels per HUD point of the last window present: what the next Live HUD is
    /// tessellated at.
    window_pixels_per_point: f32,
    /// The window the presents go to, in pixels, once a shell said or presented
    /// ([`Presenter::set_window_size`]): Live frames draw at its letterbox's pixels.
    window: Option<(u32, u32)>,
    /// The size captures draw at when one was asked for ([`Presenter::set_capture_size`]).
    capture_size: Option<(u32, u32)>,
    /// What the next settled captures ask of the look's lens ([`Presenter::set_capture_lens`]).
    capture_lens: crate::render::CaptureLens,
    /// The output size the last draw drew at (Live's window pixels or a capture's size).
    last_output: Option<(u32, u32)>,
    source: Box<dyn ModelSource>,
    assets: AssetCache,
    /// The paths a `reloadAssets` dropped that no frame has loaded again yet (C-18).
    reloading: Vec<String>,
    /// The profiler's frame index the next Live frame's graph steps are bracketed as, while
    /// per-node GPU timing is armed (PROF-5); None while it is not.
    node_frame: Option<u64>,
    /// Per-node GPU samples that landed since they were last taken.
    node_samples: Vec<genex_profile::GpuNodeSample>,
    /// The streamed view set (STR-16): idle unless the game registered `game.streaming`; its
    /// limits follow the drawn class.
    stream: crate::present_stream::StreamView,
    /// Why the last frame was not drawn, until one is.
    failed: Option<RenderError>,
    /// Whether frames run the game's custom passes (a diagnostic switch; on by default).
    custom_passes: bool,
    log: Log,
    /// The game's render settings, attached on the first draw.
    render: Option<RenderHandle>,
    /// Whether the next draws are captures (the pinned profile, untimed).
    capturing: bool,
    /// What the last draw drew with, Live or capture.
    last_choice: Option<FrameChoice>,
    /// The re-renders the last settled capture drew (its provenance's `settleFrames`).
    last_settle_frames: Option<u32>,
    /// The web shell's device hints, used when the settings are probed.
    web_hints: Option<WebHints>,
    /// The platform's clock (CPU frame time, dynamic resolution's waits).
    clock: Clock,
    /// When the last Live frame began, on [`Presenter::clock`].
    last_live: Option<Duration>,
    /// The display intervals the shell noted since the last Live frame.
    display: DisplayGaps,
    /// The device facts a shell knows better than the adapter does (a phone shell's), used when
    /// the settings are probed.
    facts: Option<crate::render::DeviceFacts>,
    /// The game's Level-2 extensions on the device.
    level2: Level2,
    /// The environment map last handed to the device: the device's generation, the map's path and
    /// whether the upload was taken (a new device after a loss uploads it again; a refusal is
    /// logged once per device).
    /// The terrain version the renderer refused (logged once; not tried again until it changes).
    terrain_refused: Option<u64>,
    /// The game's particle emitters and flipbook atlases on the renderer (renderer pass 2 A.11).
    particles: ParticlesHeld,
    environment_map: Option<(u32, String, bool)>,
    /// The samples per pixel Live's world pass is fixed to and the settings generation that fixed
    /// them (`RenderControl::pipeline_generation`); None before the first Live frame.
    live_samples: Option<(u32, u64)>,
    /// The renderer options a rebuild was refused for (logged once; not retried until another
    /// rebuild is asked for).
    refused_rebuild: Option<RenderOptions>,
    /// Whether settings changes are warmed off the frame thread (a studio run).
    off_thread: bool,
    /// The last Live frame drawn on settings that were current then: what Live keeps drawing while
    /// a change's renderer is warmed.
    held: Option<HeldLive>,
    /// The renderer being warmed on another thread, when one is.
    #[cfg(not(target_arch = "wasm32"))]
    warming: Option<warm::Warming>,
    /// The settings generation a capture's spare was last looked at for (once per generation).
    #[cfg(not(target_arch = "wasm32"))]
    spare_checked: Option<u64>,
    /// Whether the next frame's immediate frame is kept for a warm-up, and the one kept.
    keep_warm_frame: bool,
    warm_frame: Option<ImmediateFrame>,
}

/// A Live frame as it was drawn: the settings generation it drew, its choice on the world pass's
/// samples and its class.
#[derive(Clone, Copy, Debug, PartialEq)]
struct HeldLive {
    generation: u64,
    choice: FrameChoice,
    class: DeviceClass,
    samples: u32,
}

/// The native clock: elapsed time since the presenter opened. Host glue, never simulation.
#[cfg(not(target_arch = "wasm32"))]
#[allow(clippy::disallowed_types, reason = "host glue: frame timing reads the wall clock; the simulation never sees it")]
fn default_clock() -> Clock {
    let start = std::time::Instant::now();
    std::sync::Arc::new(move || start.elapsed())
}

/// The web has no `Instant`: the shell hands over its own clock ([`Presenter::set_clock`]);
/// until then time stands still (dynamic resolution then moves on GPU time only).
#[cfg(target_arch = "wasm32")]
fn default_clock() -> Clock {
    std::sync::Arc::new(|| Duration::ZERO)
}

/// The native-enhanced features the build declares ([`DECLARED_FEATURES`]); an unknown name is
/// refused `native-feature-missing`.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn declared_features() -> Result<wgpu::Features, RenderError> {
    features_named(DECLARED_FEATURES.unwrap_or(""))
}

/// The features a comma-separated list of wire names names.
#[cfg(not(target_arch = "wasm32"))]
fn features_named(list: &str) -> Result<wgpu::Features, RenderError> {
    let names: Vec<&str> = list.split(',').map(str::trim).filter(|name| !name.is_empty()).collect();
    native_features(&names)
}

/// The renderer options a presenter boots with on `gpu` (RQ5 review): the world pass's samples
/// for the anti-aliasing of the preset `auto` resolves to on the class the adapter probes as, so
/// the common boot (a game on its class default, or a harness capturing first on a reference-class
/// host) builds its renderer once. A game, person or verb choosing other anti-aliasing rebuilds it
/// before the first frame draws (`Presenter::world_samples`).
fn boot_options(gpu: &Gpu) -> RenderOptions {
    let facts = gpu.device_facts();
    let class = genex_render::device_class::classify(facts);
    let preset = genex_render::presets::default_preset(class, facts.os);
    let quality = genex_render::presets::preset_quality(preset, class);
    RenderOptions { msaa: landed_samples(quality.anti_aliasing) > 1 }
}

fn triangles_of(mesh: &MeshData) -> u32 {
    u32::try_from(mesh.indices.len() / 3).unwrap_or(u32::MAX)
}

/// The HUD as the frame's overlay stage: genex-hud's painter over the world target.
struct HudOverlay<'a> {
    painter: &'a mut HudPainter,
    paint: &'a mut HudPaint,
}

impl OverlayPainter for HudOverlay<'_> {
    fn paint(&mut self, gpu: &Gpu, encoder: &mut wgpu::CommandEncoder, target: &wgpu::TextureView, size: [u32; 2]) -> u32 {
        let drawn = self.painter.draw(&gpu.device, &gpu.queue, encoder, target, size, self.paint);
        u32::try_from(drawn).unwrap_or(u32::MAX)
    }
}

/// Whether `paint` has anything to draw or upload.
fn paints(paint: &HudPaint) -> bool {
    let textures = &paint.textures_delta;
    !paint.primitives.is_empty() || !textures.set.is_empty() || !textures.free.is_empty()
}

impl Presenter {
    /// A presenter on `gpu` (opened with the game's `declared` native-enhanced features) for a game
    /// whose logical world is `size` (Live frames then draw at the window's pixels, captures at the
    /// world size or the size asked for); `open` re-opens a device after a loss, models come from
    /// `source` and refusals go to `log`.
    pub fn with_gpu(
        gpu: Gpu,
        size: [u32; 2],
        declared: wgpu::Features,
        open: GpuOpener,
        source: Box<dyn ModelSource>,
        log: Log,
    ) -> Result<Presenter, RenderError> {
        let options = boot_options(&gpu);
        let resilient = Resilient::with_native_features(gpu, size[0], size[1], options, declared, open)?;
        let passes = CustomPasses::new(resilient.gpu(), resilient.renderer().renderer(), declared);
        let hud = HudPainter::new(&resilient.gpu().device, WORLD_FORMAT);
        Ok(Presenter {
            resilient,
            passes,
            hud,
            hud_unsent: TexturesDelta::default(),
            hud_history: TexturesDelta::default(),
            live_hud: None,
            window_pixels_per_point: WORLD_PIXELS_PER_POINT,
            window: None,
            capture_size: None,
            capture_lens: crate::render::CaptureLens::default(),
            last_output: None,
            source,
            assets: AssetCache::default(),
            reloading: Vec::new(),
            node_frame: None,
            node_samples: Vec::new(),
            stream: crate::present_stream::StreamView::new(crate::present_stream::ViewLimits::for_class(
                DeviceClass::new(FormFactor::Desktop, PerformanceTier::High),
                TargetOs::current(),
            )),
            failed: None,
            custom_passes: true,
            log,
            render: None,
            capturing: false,
            last_choice: None,
            last_settle_frames: None,
            web_hints: None,
            clock: default_clock(),
            last_live: None,
            display: DisplayGaps::default(),
            facts: None,
            level2: Level2::default(),
            environment_map: None,
            terrain_refused: None,
            particles: ParticlesHeld::default(),
            live_samples: None,
            refused_rebuild: None,
            off_thread: false,
            held: None,
            #[cfg(not(target_arch = "wasm32"))]
            warming: None,
            #[cfg(not(target_arch = "wasm32"))]
            spare_checked: None,
            keep_warm_frame: false,
            warm_frame: None,
        })
    }

    /// Warm each explicit settings change's renderer off the frame thread and keep the renderer a
    /// change replaced as the spare for its samples (see the module docs; a studio run, a desktop
    /// game). The web has no threads: there it keeps the spare only, so a capture on other samples
    /// and Live after it swap renderers instead of rebuilding each from the uploads (review F5).
    pub fn set_off_thread_changes(&mut self, on: bool) {
        self.resilient.set_keep_spare(on);
        self.off_thread = on && !cfg!(target_arch = "wasm32");
    }

    /// The platform's clock for frame timing (the web shell's `performance.now()`).
    pub fn set_clock(&mut self, clock: Clock) {
        self.clock = clock;
    }

    /// The web shell's hints about the device, read when the settings are probed (before the
    /// first draw).
    pub fn set_web_hints(&mut self, hints: WebHints) {
        self.web_hints = Some(hints);
    }

    /// The device's facts as the shell knows them, probed instead of the adapter's own (before the
    /// first draw): a phone shell's destination, a test's fixture device.
    pub fn set_device_facts(&mut self, facts: crate::render::DeviceFacts) {
        self.facts = Some(facts);
    }

    /// One display frame of `frame_ms` passed (the shell's `rAF` or display-link delta, drawn or
    /// not): the next Live frame reports the longest since the last one to dynamic resolution.
    pub fn note_display_frame(&mut self, frame_ms: f64) {
        self.display.note(frame_ms as f32);
    }

    /// Draw the next frames as captures (`true`: the pinned capture profile, untimed) or as Live
    /// frames (`false`, the default).
    pub fn set_capturing(&mut self, capturing: bool) {
        self.capturing = capturing;
    }

    /// Start warming the first Live frame's renderer off the frame thread, so its pipelines
    /// compile while the boot goes on (a studio run installs the game's passes meanwhile); the
    /// first frame then waits for it and swaps it in. Nothing without off-thread changes, or on
    /// the web.
    pub fn warm_boot<W: Default + 'static>(&mut self, runtime: &mut Runtime<W>) {
        #[cfg(not(target_arch = "wasm32"))]
        self.start_boot_warm(runtime);
        #[cfg(target_arch = "wasm32")]
        let _ = runtime;
    }

    /// The renderers this presenter holds now: the one in use, the spare when one is kept, and the
    /// one a warm-up is building (each holds a full set of render targets; GB live-app round 1: a
    /// Live preset cycle under Studio's memory cap held three).
    pub fn renderers_held(&self) -> usize {
        let spare = usize::from(self.resilient.spare().is_some());
        #[cfg(not(target_arch = "wasm32"))]
        let warming = usize::from(self.warming.is_some());
        #[cfg(target_arch = "wasm32")]
        let warming = 0;
        1 + spare + warming
    }

    /// Whether the boot's warm-up ([`Presenter::warm_boot`]) is still compiling the first Live
    /// frame's pipelines: a shell shows its loading screen meanwhile instead of waiting on that
    /// frame (owner decision D11). Never on the web, which warms nothing off its one thread.
    pub fn boot_warming(&self) -> bool {
        #[cfg(not(target_arch = "wasm32"))]
        return self.held.is_none() && self.warming.as_ref().is_some_and(|warming| !warming.is_finished());
        #[cfg(target_arch = "wasm32")]
        false
    }

    /// The game's render settings, once attached by a draw.
    pub fn render_settings(&self) -> Option<&RenderHandle> {
        self.render.as_ref()
    }

    /// The pinned settings a capture is drawn with now, for its reply's provenance, with the
    /// re-renders the last settled capture drew.
    pub fn capture_render(&self) -> Option<CaptureRender> {
        let render = self.render.as_ref()?.borrow().capture_frame().1;
        Some(CaptureRender { settle_frames: self.last_settle_frames.unwrap_or(render.settle_frames), ..render })
    }

    /// Whether the last draw used what a Live frame uses now (so a capture left the Live picture
    /// in the world target, and no Live redraw is needed after it).
    pub fn last_draw_is_live(&self) -> bool {
        let Some(handle) = self.render.as_ref() else { return false };
        let (live, output) = (handle.borrow().live_frame(), handle.borrow().live_output());
        self.last_choice == Some(live) && self.last_output == Some(output)
    }

    /// Attach `runtime`'s render settings, probing them with this device's facts when no shell
    /// did yet.
    fn attach<W: Default + 'static>(&mut self, runtime: &mut Runtime<W>) -> RenderHandle {
        if let Some(handle) = &self.render {
            return std::rc::Rc::clone(handle);
        }
        let handle = runtime.render();
        if !handle.borrow().probed() {
            let facts = self.facts.clone().unwrap_or_else(|| self.resilient.gpu().device_facts().clone());
            let facts = match self.web_hints {
                Some(hints) => facts.with_web(hints),
                None => facts,
            };
            runtime.boot_render(facts, None);
        }
        self.render = Some(std::rc::Rc::clone(&handle));
        handle
    }

    /// Hand `asked` to the renderer and the passes as the world pass draws it (its anti-aliasing
    /// on the samples the pass was built with, [`genex_render::presets::with_world_samples`]); for a
    /// `live` frame, note what differs from what was asked (a capture's choice is not Live's, so it
    /// never writes Live's findings).
    fn apply(&mut self, handle: &RenderHandle, asked: FrameChoice, live: bool) {
        let class = if live { handle.borrow().live_class() } else { handle.borrow().capture_class() };
        let asked = self.on_scene(asked, class);
        let samples = self.world_samples(handle, &asked.quality, live);
        // Live's world pass only: a capture on other samples (its pinned profile) noted here made
        // `volatile.render`, read after the captures, report Live on the capture's samples (GF
        // round 2: a phone's TAA Live read back as MSAA, which drops AO).
        if live {
            handle.borrow_mut().note_world_samples(samples);
        }
        let choice = FrameChoice { quality: with_world_samples(&asked.quality, samples, class), ..asked };
        let deferred = landed_samples(asked.quality.anti_aliasing) != samples;
        self.set_drawn(handle, choice, class, live, deferred);
    }

    /// `asked` as this frame's scene draws it: a frame kept on the legacy LDR scene draws no TAA
    /// and takes MSAA in its place.
    fn on_scene(&self, asked: FrameChoice, class: DeviceClass) -> FrameChoice {
        if self.ldr_scene() { FrameChoice { quality: on_ldr_scene(&asked.quality, class), ..asked } } else { asked }
    }

    /// Live's last drawn settings again while a change's renderer is warmed: on the renderer built
    /// for their samples (the spare a capture left, swapped back), with the change noted deferred.
    fn apply_held(&mut self, handle: &RenderHandle, held: HeldLive) {
        let options = RenderOptions { msaa: held.samples > 1 };
        if let Err(error) = self.resilient.rebuild_with(options) {
            (self.log)(&format!("renderer for the drawn settings refused: {error}"));
        }
        let samples = self.resilient.renderer().renderer().sample_count();
        handle.borrow_mut().note_world_samples(samples);
        self.set_drawn(handle, held.choice, held.class, true, true);
    }

    /// Hand `choice`, drawn as `class` on the world pass's samples, to the renderer and the passes;
    /// for a `live` frame, note what differs from what was asked (`deferred`: its anti-aliasing
    /// waits for an explicit change, or the change's renderer is warming).
    fn set_drawn(&mut self, handle: &RenderHandle, choice: FrameChoice, class: DeviceClass, live: bool, deferred: bool) {
        // The session's material arrays, before any texture (ignored once one is held): the same
        // for Live and captures whichever draws first.
        let (texture_class, textures) = handle.borrow().texture_arrays();
        let device = self.resilient.gpu().device.clone();
        let frame_renderer = self.resilient.renderer_mut();
        frame_renderer.renderer_mut().set_texture_arrays(&device, texture_class, textures);
        set_choice(frame_renderer, &choice, class);
        // The game's meshlet setting (R2): which meshes cluster and whether occlusion may cull
        // them; a change re-clusters the library once. A refusal keeps the last setting.
        if let Err(error) = self.resilient.set_meshlets(choice.meshlets) {
            (self.log)(&format!("meshlet setting refused: {error}"));
        }
        let held = self.resilient.renderer().held_bytes();
        self.passes.set_quality(choice.quality);
        self.last_choice = Some(choice);
        if !live {
            return;
        }
        let budget = handle.borrow().live_profile().budget_bytes;
        let over = self.passes.over_budget(held, budget);
        handle.borrow_mut().note_frame_findings(over, deferred);
    }

    /// The Live settings to keep drawing: the last drawn, while an explicit change since then has
    /// its renderer warmed off the frame thread (None: draw what is asked).
    fn held_while_changing(&self, handle: &RenderHandle) -> Option<HeldLive> {
        let generation = handle.borrow().pipeline_generation();
        self.held.filter(|held| self.off_thread && held.generation != generation)
    }

    /// After a Live frame was drawn: remember what it drew (unless it held the last settings), then
    /// start warming the renderer a change needs, or the spare a capture's pinned profile needs.
    fn after_live(&mut self, handle: &RenderHandle, holding: bool) {
        if !holding {
            let generation = handle.borrow().pipeline_generation();
            let class = handle.borrow().live_class();
            let samples = self.resilient.renderer().renderer().sample_count();
            self.held = self.last_choice.map(|choice| HeldLive { generation, choice, class, samples });
        }
        self.start_warm(handle, holding);
    }

    #[cfg(target_arch = "wasm32")]
    fn wants_warm(&self, _handle: &RenderHandle, _holding: bool) -> bool {
        false
    }

    #[cfg(target_arch = "wasm32")]
    fn start_warm(&mut self, _handle: &RenderHandle, _holding: bool) {}

    #[cfg(target_arch = "wasm32")]
    fn take_warmed(&mut self, _handle: &RenderHandle, _wait_for_live: bool) {}

    /// Whether the next frame stays on the legacy LDR scene for what the session holds: a v1
    /// material, or a running v1 in-world pass (passes switched off never run).
    fn ldr_scene(&self) -> bool {
        let pass_reason = if self.custom_passes { self.passes.ldr_reason() } else { None };
        self.resilient.renderer().ldr_reason().or(pass_reason).is_some()
    }

    /// The samples per pixel this frame's world pass draws with (RQ5.6, RQ5 review). The samples
    /// are a pipeline knob: changing them rebuilds the renderer (`Resilient::rebuild_with`, every
    /// upload replayed, history started over), so they change only at these points:
    /// - Live's are fixed by its first frame and change on an explicit settings change (the person's
    ///   panel, the verb, a saved choice loaded: `RenderControl::pipeline_generation`); dynamic
    ///   resolution, a thermal hold or a budget refit never rebuild, and their anti-aliasing then
    ///   degrades onto the pass it has (`with_world_samples`, `pipeline-change-deferred`).
    /// - A capture draws with its pinned profile's own samples whatever Live drew before it, so it
    ///   is the same picture on the same adapter in any boot order; the next Live frame rebuilds
    ///   back to Live's when they differ (Live's history then starts over).
    fn world_samples(&mut self, handle: &RenderHandle, asked: &Quality, live: bool) -> u32 {
        let wanted = landed_samples(asked.anti_aliasing);
        let target = if live { self.live_target(handle, wanted) } else { wanted };
        let options = RenderOptions { msaa: target > 1 };
        if self.refused_rebuild != Some(options) {
            match self.resilient.rebuild_with(options) {
                Ok(_) => self.refused_rebuild = None,
                Err(error) => {
                    self.refused_rebuild = Some(options);
                    (self.log)(&format!("renderer for the preset's anti-aliasing refused: {error}"));
                }
            }
        }
        self.resilient.renderer().renderer().sample_count()
    }

    /// The samples Live's world pass is fixed to: `wanted` at the first Live frame and after each
    /// explicit settings change, else what was fixed.
    fn live_target(&mut self, handle: &RenderHandle, wanted: u32) -> u32 {
        let generation = handle.borrow().pipeline_generation();
        match self.live_samples {
            Some((samples, at)) if at == generation => samples,
            _ => {
                self.live_samples = Some((wanted, generation));
                wanted
            }
        }
    }

    /// The device in use.
    pub fn gpu(&self) -> &Gpu {
        self.resilient.gpu()
    }

    /// Draw `frame` from `camera` into the world target with the game's custom GPU `passes` at
    /// `tick` (inside the frame) and `hud` over it, so captures and Live carry both; what it
    /// counted. A refusal is kept for [`Presenter::failure`] until a frame is drawn.
    pub fn draw(
        &mut self,
        frame: &Frame,
        camera: &Camera,
        passes: &mut [&mut dyn CustomPass],
        tick: u64,
        hud: &mut HudPaint,
    ) -> Result<Drawn, RenderError> {
        let fresh = std::mem::take(&mut hud.textures_delta);
        hud_history::record(&mut self.hud_history, fresh.clone());
        self.hud_unsent.append(fresh);
        hud.textures_delta = std::mem::take(&mut self.hud_unsent);
        let drawn = self.render(frame, camera, passes, tick, hud);
        // What the painter did not take (it takes everything once the HUD is painted).
        self.hud_unsent = std::mem::take(&mut hud.textures_delta);
        self.failed = drawn.as_ref().err().cloned();
        drawn
    }

    fn render(
        &mut self,
        frame: &Frame,
        camera: &Camera,
        passes: &mut [&mut dyn CustomPass],
        tick: u64,
        hud: &mut HudPaint,
    ) -> Result<Drawn, RenderError> {
        self.load(frame)?;
        self.admit(frame)?;
        self.light(frame)?;
        self.terrain(frame)?;
        self.hold_particles(frame)?;
        let (mut immediate, mut drawn) = self.immediate(frame, camera);
        // The tick's simulated seconds (`gx_draw.params.x`, `gx_post.params.x`), never wall time.
        immediate.set_seconds((tick as f64 * FIXED_STEP_MS / 1000.0) as f32);
        // The frame's water on the same clock (renderer pass 2 B.3).
        immediate.set_water(water_of(frame, tick));
        self.sync_passes(passes);
        immediate.set_tick(tick);
        // Each emitter as it is at the frame's tick (a refused one is skipped).
        for particles in frame.drawn_particles() {
            if let Some(id) = self.particles.emitter(particles.version()) {
                immediate.particles(id, tick);
            }
        }
        if std::mem::take(&mut self.keep_warm_frame) {
            self.warm_frame = Some(immediate.clone());
        }
        // Live paints the HUD over the window after the upscale (`Presenter::present`), so the world
        // target is drawn without it; its texture changes stay in `hud` for `draw` to keep. A
        // capture's world carries its own HUD, so a present after it paints none over it.
        let live_hud = if self.capturing {
            self.live_hud = None;
            0
        } else {
            self.keep_live_hud(hud)
        };
        let painted = self.capturing && paints(hud);
        let mut overlay = HudOverlay { painter: &mut self.hud, paint: hud };
        let overlay: Option<&mut dyn OverlayPainter> = if painted { Some(&mut overlay) } else { None };
        let report = if self.capturing {
            // A game's `post-hdr` pass (a grade) changes the scene auto exposure meters: one more
            // re-render (`settle_plan_graded`).
            let graded = self.custom_passes && self.passes.runs_at(PassStage::PostHdr);
            let frames = self.resilient.renderer().settle_frames_graded(graded);
            self.last_settle_frames = Some(frames);
            // A recovered renderer starts from the defaults: the shot's lens is handed over per capture.
            self.resilient.renderer_mut().renderer_mut().set_capture_lens(self.capture_lens);
            settle(&mut self.resilient, &mut self.passes, self.custom_passes, passes, tick, &immediate, overlay, frames)?
        } else {
            draw_once(&mut self.resilient, &mut self.passes, self.custom_passes, passes, tick, &immediate, overlay)?
        };
        let extra = |tag: &str| report.tags.iter().find(|(name, _)| name == tag).map_or(0, |(_, count)| *count);
        let hud_draws = extra(HUD_TAG).saturating_add(live_hud);
        drawn.draw_calls = drawn.draw_calls.saturating_add(extra(CUSTOM_TAG)).saturating_add(hud_draws);
        drawn.gpu = report.gpu;
        Ok(drawn)
    }

    /// The window the next presents go to is `window` pixels: Live's HUD is tessellated at its
    /// letterbox's ratio from the next frame on. A shell that knows its window before the first
    /// frame says so (every present says so again), so even that frame's HUD lands on the
    /// window's pixels.
    pub fn set_window_size(&mut self, window: (u32, u32)) {
        let world = self.resilient.renderer().renderer().logical_size();
        let view = letterbox(window, world);
        if view.width > 0 && world.0 > 0 {
            self.window_pixels_per_point = view.width as f32 / world.0 as f32;
            self.window = Some(window);
        }
    }

    /// Draw the next settled captures with what `lens` asks of the look's depth of field and
    /// motion blur (`capture`'s `lens`; renderer pass 2 A.9). Neither by default: a capture is a
    /// still of the held frame.
    pub fn set_capture_lens(&mut self, lens: crate::render::CaptureLens) {
        self.capture_lens = lens;
    }

    /// Draw the next captures at `size` (`capture --size`, the 4K/1440p plan; each side 64..=4096),
    /// or at the world size again (None). The HUD is painted at that size's pixels per point.
    pub fn set_capture_size(&mut self, size: Option<(u32, u32)>) {
        self.capture_size = size.map(|(width, height)| genex_render::caps::world_size(width, height));
    }

    /// The size Live frames draw at now (renderer pass 2, P2-0.9 step B; findings F1/RC-03): the
    /// window's letterbox in its own pixels, capped at the Live class's reference resolution's
    /// pixels (`presets::reference_resolution`), or the world size before a window is known. The
    /// window present copies it texel for texel, or upscales it past the cap.
    fn live_output(&self, handle: &RenderHandle) -> (u32, u32) {
        let world = self.resilient.renderer().renderer().logical_size();
        let Some(window) = self.window else { return world };
        let (cap_w, cap_h) = genex_render::presets::reference_resolution(handle.borrow().live_class());
        output_for_window(world, window, u64::from(cap_w) * u64::from(cap_h))
    }

    /// Hand the settings this draw's output size (Live's window pixels, or the capture's size)
    /// before they are asked for the frame's quality, so the budget is fitted at it; answers it.
    fn frame_output(&mut self, handle: &RenderHandle) -> (u32, u32) {
        handle.borrow_mut().set_capture_size(self.capture_size);
        if self.capturing {
            return handle.borrow().capture_output();
        }
        let output = self.live_output(handle);
        let world = self.resilient.renderer().renderer().logical_size();
        let window = self.window.map(|window| letterbox(window, world)).map(|view| (view.width, view.height));
        handle.borrow_mut().set_live_output(output, window);
        output
    }

    /// Draw the next frame at `output`: a refusal (a target over the texture limits) keeps the
    /// size the renderer had and is logged.
    fn set_output(&mut self, output: (u32, u32)) {
        let renderer = self.resilient.renderer_mut().renderer_mut();
        if let Err(error) = renderer.set_output_size(output) {
            (self.log)(&format!("output size {}x{} refused: {error}", output.0, output.1));
        }
        self.last_output = Some(self.resilient.renderer().renderer().size());
    }

    /// Keep a Live frame's HUD primitives for the window presents (a capture keeps none); answers
    /// how many, the frame's `hud`-tagged draws.
    fn keep_live_hud(&mut self, hud: &mut HudPaint) -> u32 {
        let primitives = std::mem::take(&mut hud.primitives);
        let draws = u32::try_from(primitives.len()).unwrap_or(u32::MAX);
        self.live_hud = Some(HudPaint { primitives, textures_delta: TexturesDelta::default(), pixels_per_point: hud.pixels_per_point });
        draws
    }

    /// Letterbox the world target into a window's `target` (`window` pixels of `format`) through
    /// the renderer's window present (FSR1 up, Catmull-Rom down), then paint the last Live frame's
    /// HUD over the letterbox at the window's own pixels. Every shell presents through this: a
    /// window's frame, the web canvas, a phone's surface and Studio's Live ring.
    pub fn present(&mut self, target: &wgpu::TextureView, format: wgpu::TextureFormat, window: (u32, u32)) {
        self.set_window_size(window);
        let Some(mut paint) = self.live_hud.take() else {
            self.resilient.present(target, format, window);
            return;
        };
        paint.textures_delta = std::mem::take(&mut self.hud_unsent);
        paint.pixels_per_point = self.window_pixels_per_point;
        let painted = paints(&paint);
        let mut overlay = HudOverlay { painter: &mut self.hud, paint: &mut paint };
        let overlay: Option<&mut dyn OverlayPainter> = if painted { Some(&mut overlay) } else { None };
        self.resilient.present_with(target, format, window, overlay);
        // What the painter did not take (a lost device paints nothing) waits for the next one.
        self.hud_unsent = std::mem::take(&mut paint.textures_delta);
        self.live_hud = Some(paint);
    }

    /// Hand the pass registry this frame's render size and the renderer's pipeline-shaping facts;
    /// changed facts rebuild every pass (a pass refused then stops running, its refusal kept).
    fn sync_passes(&mut self, passes: &mut [&mut dyn CustomPass]) {
        let frames = self.resilient.renderer();
        self.passes.set_render_size(frames.renderer().render_size());
        // Passes switched off never run, so they never keep the frame on the legacy scene.
        let reason = if self.custom_passes { self.passes.ldr_reason() } else { None };
        let facts: PipelineFacts = frames.pipeline_facts(reason);
        if let Err(error) = self.passes.set_pipeline_facts(self.resilient.gpu(), passes, facts) {
            (self.log)(&format!("custom passes after a pipeline change: {error}"));
        }
    }

    /// Draw `runtime`'s frame from `view` with its custom passes and its HUD, and give its tally
    /// the triangles drawn; None for a view the game does not have.
    pub fn draw_view<W: Default + 'static>(&mut self, runtime: &mut Runtime<W>, view: View<'_>) -> Option<Result<Drawn, RenderError>> {
        let camera = runtime.camera(view)?;
        let mut frame = runtime.frame(view)?;
        let handle = self.attach(runtime);
        if let Err(error) = self.stream_frame(runtime, &handle, &camera, &mut frame) {
            return Some(Err(error));
        }
        let output = self.frame_output(&handle);
        let world = self.resilient.renderer().renderer().logical_size();
        // A capture paints its HUD into the world target at the capture's own pixels per point (1 at
        // the world size); Live paints it over the window after the upscale.
        let capture_ppp = output.0 as f32 / world.0.max(1) as f32;
        let pixels_per_point = if self.capturing { capture_ppp } else { self.window_pixels_per_point };
        let mut hud = runtime.hud_paint(pixels_per_point);
        let live = !self.capturing;
        // The frame's Level-2 extensions first: a v1 material it brings keeps it on the legacy LDR
        // scene, which `apply` reads to choose the anti-aliasing, so the first frame that draws one
        // chooses as every later frame does (pass-1 gate: two captures of one frame differed).
        if let Err(error) = self.admit(&frame) {
            return Some(Err(error));
        }
        // Before the first Live frame there is nothing to hold: it waits for a boot warm-up.
        self.take_warmed(&handle, self.held.is_none());
        let held = if live { self.held_while_changing(&handle) } else { None };
        match held {
            Some(held) => self.apply_held(&handle, held),
            None => {
                // What is asked: `apply` draws it on the world pass's samples (`live_frame` is the drawn one).
                let choice = if live { handle.borrow().live_asked() } else { handle.borrow().capture_frame().0 };
                self.apply(&handle, choice, live);
            }
        }
        // After any rebuild `apply` made: a new renderer starts at the world size.
        self.set_output(output);
        self.keep_warm_frame = live && self.wants_warm(&handle, held.is_some());
        let timing = live.then(|| self.begin_live());
        // Characters' poses (AN-17), over their skins (loaded first): Live's rate bands read the
        // game camera, whatever the view.
        if let Err(error) = self.load(&frame) {
            return Some(Err(error));
        }
        let game_camera = runtime.camera(View::Game).unwrap_or(camera);
        self.assets.pose_characters(&frame, &game_camera, runtime.tick(), live);
        let drawn = crate::gpu::host::with_passes(runtime, |passes, tick| self.draw(&frame, &camera, passes, tick, &mut hud));
        if let Some(timing) = timing {
            self.end_live(&handle, timing);
        }
        if live && drawn.is_ok() {
            self.after_live(&handle, held.is_some());
            // Why the Live frame asked for HDR and drew the legacy scene (a v1 material or in-world pass).
            let scene = self.resilient.renderer().renderer().last_scene();
            handle.borrow_mut().note_ldr_reason(scene.and_then(|scene| scene.ldr_reason));
        }
        // The buffers the renderer holds (LG-13), counted at the device budget's next fit.
        handle.borrow_mut().note_buffers(self.resilient.renderer().renderer().buffer_ledger());
        // The spot atlas the renderer now holds (a shadowed spot asked for), in the budget from now on.
        handle.borrow_mut().note_spot_atlas(self.resilient.renderer().renderer().uses_shadowed_spots());
        if let Ok(drawn) = &drawn {
            runtime.note_triangles(drawn.triangles, &drawn.by_tag);
            runtime.note_missing_models(&drawn.missing_models);
            runtime.note_lod_refused(&drawn.lod_refused);
            runtime.note_texture_facts(&drawn.textures, &drawn.asset_issues);
        }
        Some(drawn)
    }

    /// The streamed view set's part of a frame (STR-16): its limits follow the drawn class, then it
    /// updates from the camera and appends its draws to `frame`. Nothing without `game.streaming`.
    fn stream_frame<W>(&mut self, runtime: &Runtime<W>, handle: &RenderHandle, camera: &Camera, frame: &mut Frame) -> Result<(), RenderError> {
        let (class, os) = {
            let control = handle.borrow();
            let class = if self.capturing { control.capture_class() } else { control.live_class() };
            (class, control.facts().os)
        };
        let limits = ViewLimits::for_class(class, os);
        if limits != self.stream.limits() {
            self.stream.set_limits(limits);
        }
        let log = self.log;
        let io = ViewIo { assets: &mut self.assets, source: &*self.source, uploads: &mut self.resilient, clock: &self.clock, log: &mut |line| log(line) };
        self.stream.update(runtime, camera, io)?;
        self.stream.draw_into(frame);
        Ok(())
    }

    /// What the streamed view set holds and did in the last frame (STR-16).
    pub fn stream_stats(&self) -> ViewStats {
        self.stream.stats()
    }

    /// Read streamed models through `source` (natively `StreamFiles`, on the web the page's
    /// fetches) instead of the presenter's own source, answered at once (STR-16).
    pub fn set_stream_source(&mut self, source: Box<dyn crate::stream_source::AsyncSource>) {
        self.stream.set_source(source);
    }

    /// Start a Live frame's timing: the GPU times that landed since the last one (None without
    /// timestamp queries), the CPU timer started and the display interval since the last Live
    /// frame.
    fn begin_live(&mut self) -> LiveTiming {
        let queue = self.resilient.gpu().queue.clone();
        if let Some(frame) = self.node_frame {
            let nodes = self.resilient.renderer_mut().renderer_mut().arm_node_timer(&queue, frame);
            self.node_samples.extend(nodes.into_iter().flatten().flat_map(|landed| landed.nodes));
        }
        let landed = self.resilient.renderer_mut().renderer_mut().arm_frame_timer(&queue);
        let now = (self.clock)();
        let since_last = self.last_live.map_or(0.0, |last| now.saturating_sub(last).as_secs_f32() * 1000.0);
        let interval_ms = self.display.take().unwrap_or(since_last);
        self.last_live = Some(now);
        let mut cpu = CpuTimer::new();
        cpu.begin(now);
        LiveTiming { landed, cpu, interval_ms }
    }

    /// Close a Live frame's timing and hand its measurements to the settings.
    fn end_live(&mut self, handle: &RenderHandle, mut timing: LiveTiming) {
        self.resilient.renderer_mut().renderer_mut().finish_frame_timer();
        let now = (self.clock)();
        let cpu_ms = timing.cpu.end(now);
        handle.borrow_mut().observe(cpu_ms, timing.landed.as_deref(), timing.interval_ms, now);
    }

    /// Register `runtime`'s custom passes on this presenter's device; a refused pass is left out of
    /// every frame (and of the draw count). Answers the refused passes' names with their refusals.
    pub fn install_for<W: Default + 'static>(&mut self, runtime: &mut Runtime<W>) -> Vec<(String, RenderError)> {
        crate::gpu::host::install(runtime, &mut self.passes, self.resilient.gpu())
    }

    /// `volatile.customPasses` for the passes a game `registered`: each with the code that
    /// refused it at install (`install_refused`) or stopped it since.
    pub fn pass_statuses(&self, registered: Vec<(String, PassStage)>, install_refused: &[(String, RenderCode)]) -> Vec<PassStatus> {
        let refusal_of = |name: &str| {
            let installed = install_refused.iter().find(|(refused, _)| refused == name).map(|(_, code)| *code);
            installed.or_else(|| self.passes.refusal_of(name))
        };
        registered
            .into_iter()
            .map(|(name, stage)| {
                let code = refusal_of(&name);
                (name, stage, code)
            })
            .collect()
    }

    /// [`Presenter::recover`] with `runtime`'s custom passes.
    pub fn recover_for<W: Default + 'static>(&mut self, runtime: &mut Runtime<W>) -> Result<bool, RenderError> {
        crate::gpu::host::with_passes(runtime, |passes, _| self.recover(passes))
    }

    /// Why the last frame was not drawn: its refusal (`device-lost` included), or None.
    pub fn failure(&self) -> Option<&RenderError> {
        self.failed.as_ref()
    }

    /// The game's custom passes' refusals since the last call (each names its pass), clearing them.
    pub fn take_pass_refusals(&mut self) -> Vec<RenderError> {
        self.passes.take_refusals()
    }

    /// Run frames with the game's custom passes (`true`, the default) or without them: a
    /// diagnostic switch (the web parity row's A/B), never a setting a game sees.
    pub fn set_custom_passes_enabled(&mut self, enabled: bool) {
        self.custom_passes = enabled;
    }

    /// Whether frames run the game's custom passes.
    pub fn custom_passes_enabled(&self) -> bool {
        self.custom_passes
    }

    /// When the device was lost: re-create it, replay every mesh and rebuild the game's custom
    /// `passes` on it. Answers whether a new device is in use.
    pub fn recover(&mut self, passes: &mut [&mut dyn CustomPass]) -> Result<bool, RenderError> {
        if !self.resilient.recover()? {
            return Ok(false);
        }
        self.hud = HudPainter::new(&self.resilient.gpu().device, WORLD_FORMAT);
        // The new painter has no textures: it gets every one the HUD set, then what is new.
        let mut replay = self.hud_history.clone();
        replay.append(std::mem::take(&mut self.hud_unsent));
        replay.free.clear();
        self.hud_unsent = replay;
        // A pass refused now stops running; its refusal is kept with the others and the run goes on.
        let _ = self.passes.rebuild(self.resilient.gpu(), passes);
        self.failed = None;
        Ok(true)
    }

    /// Load every model and material texture `frame` draws that was never tried; a refusal is
    /// logged once. A lost device stops the frame (`device-lost`) and leaves the rest to be tried
    /// again.
    fn load(&mut self, frame: &Frame) -> Result<(), RenderError> {
        let log = self.log;
        self.assets.load(frame, &*self.source, &mut self.resilient, &mut |line| log(line))?;
        // Every dropped path the frame draws was read again; one it does not draw has nothing left
        // to load.
        self.reloading.clear();
        Ok(())
    }

    /// `reloadAssets` (game systems C-18): for each `(path, digest)` (a path already under the
    /// asset-path rule), check the bytes the game's source serves now against the FNV-1a 64 the
    /// host named, then drop what the renderer holds of every file that matched (its models'
    /// meshes freed, an environment map uploaded again), so the next frame reads them; one answer
    /// per file, in order. A missing file or a stale digest changes nothing.
    pub fn reload_assets(&mut self, files: &[(&str, u64)]) -> Vec<Result<(), ReloadMiss>> {
        let answers: Vec<Result<(), ReloadMiss>> = files
            .iter()
            .map(|(path, digest)| match self.source.model_bytes(path) {
                None => Err(ReloadMiss::Missing),
                Some(bytes) if genex_core::digest::fnv1a64(&bytes) != *digest => Err(ReloadMiss::DigestMismatch),
                Some(_) => Ok(()),
            })
            .collect();
        let changed: Vec<&str> = files.iter().zip(&answers).filter(|(_, answer)| answer.is_ok()).map(|((path, _), _)| *path).collect();
        if changed.is_empty() {
            return answers;
        }
        let dropped = self.assets.invalidate(&changed);
        for model in dropped.models {
            for part in model.parts {
                if let Err(error) = self.resilient.remove_mesh(part.mesh) {
                    (self.log)(&format!("a reloaded model's mesh was not removed: {error}"));
                }
            }
        }
        if dropped.environment {
            self.environment_map = None;
        }
        for path in changed {
            if !self.reloading.iter().any(|known| known == path) {
                self.reloading.push(path.to_owned());
            }
        }
        answers
    }

    /// Bracket the next Live frames' graph steps on the GPU as the profiler's frame `frame` (per-node
    /// timing armed, PROF-5), or stop (None). Captures are never bracketed.
    pub fn set_node_frame(&mut self, frame: Option<u64>) {
        self.node_frame = frame;
    }

    /// The per-node GPU samples that landed since the last take, in schedule order per frame.
    pub fn take_node_samples(&mut self) -> Vec<genex_profile::GpuNodeSample> {
        std::mem::take(&mut self.node_samples)
    }

    /// The paths a `reloadAssets` dropped that no frame has loaded again yet: 0 once a frame
    /// drew (a lost device keeps them pending).
    pub fn reload_pending(&self) -> u32 {
        u32::try_from(self.reloading.len()).unwrap_or(u32::MAX)
    }

    /// Hand the renderer the environment `frame` lights with ([`environment_of`]), uploading an
    /// HDRI's map once per device (again after a device loss). A refused upload is logged and the
    /// frame lights with the flat colour; a lost device stops the frame (`device-lost`).
    fn light(&mut self, frame: &Frame) -> Result<(), RenderError> {
        let (mut environment, _) = environment_of(frame, &self.assets);
        let prepared = match &environment {
            Environment::Hdri(hdri) => self.assets.prepared_environment_map(&hdri.path),
            _ => None,
        };
        if let (Environment::Hdri(hdri), Some(map)) = (&environment, prepared)
            && !upload_environment_map(&mut self.resilient, &mut self.environment_map, self.log, &hdri.path, map)?
        {
            environment = Environment::Color;
        }
        let renderer = self.resilient.renderer_mut().renderer_mut();
        if *renderer.environment() != environment {
            renderer.set_environment(&environment);
        }
        Ok(())
    }

    /// Hand the renderer the terrain `frame` draws (renderer pass 2 A.7), once per terrain version
    /// and device (again after a device loss or a warmed renderer's swap), or take it away. A
    /// refused terrain is logged once and the frame draws without it; a lost device stops the
    /// frame (`device-lost`).
    fn terrain(&mut self, frame: &Frame) -> Result<(), RenderError> {
        let wanted = frame.drawn_terrain();
        let held = self.resilient.renderer().renderer().terrain_version();
        let version = wanted.map(crate::Terrain::version);
        if held == version || (version.is_some() && version == self.terrain_refused) {
            return Ok(());
        }
        let desc = wanted.map(|terrain| terrain_desc(terrain, &self.assets));
        let (gpu, renderer) = self.resilient.parts_mut();
        match renderer.renderer_mut().set_terrain(gpu, desc.as_ref().zip(version)) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == RenderCode::DeviceLost => Err(error),
            Err(error) => {
                self.terrain_refused = version;
                (self.log)(&format!("terrain refused: {error}: drawing the frame without it"));
                Ok(())
            }
        }
    }

    /// Create on the device every Level-2 extension `frame` uses that is not there yet, and re-send
    /// changed uniforms. A refusal is noted on the handle (and logged once); a lost device stops
    /// the frame (`device-lost`) and leaves the extension to be tried again.
    fn admit(&mut self, frame: &Frame) -> Result<(), RenderError> {
        for draw in frame.custom_draws() {
            let Some(parts) = draw.material.gpu_parts() else { continue };
            self.admit_material(&parts)?;
        }
        for post in frame.post_passes() {
            let Some(parts) = post.pass.gpu_parts() else { continue };
            if held_at(&self.level2.posts, &parts.key).is_some() {
                continue;
            }
            // Post passes run on the display-ready world target (stage ldr) at either api.
            let add = |resilient: &mut Resilient, parts: &GpuParts| resilient.add_post_pass_api(parts.api, PostStage::Ldr, &parts.key.source, &parts.uniforms, &[]);
            let id = self.on_device(&parts, add)?;
            let GpuParts { key, uniforms, .. } = parts;
            self.level2.posts.push(OnDevice { index: key.index, source: key.source, id, uniforms });
        }
        Ok(())
    }

    fn admit_material(&mut self, parts: &GpuParts) -> Result<(), RenderError> {
        let Some(at) = held_at(&self.level2.materials, &parts.key) else {
            let textures = self.game_textures(parts);
            let add = |resilient: &mut Resilient, parts: &GpuParts| resilient.add_material_api(parts.api, &parts.key.source, &parts.uniforms, &textures);
            let id = self.on_device(parts, add)?;
            let source = std::sync::Arc::clone(&parts.key.source);
            self.level2.materials.push(OnDevice { index: parts.key.index, source, id, uniforms: parts.uniforms.clone() });
            return Ok(());
        };
        let held = &self.level2.materials[at];
        let Some(id) = held.id.filter(|_| held.uniforms != parts.uniforms) else { return Ok(()) };
        match self.resilient.set_material_uniforms(id, &parts.uniforms) {
            Ok(()) => parts.uniforms.clone_into(&mut self.level2.materials[at].uniforms),
            Err(error) if error.code() == RenderCode::DeviceLost => return Err(error),
            Err(error) => self.refuse(parts, error),
        }
        Ok(())
    }

    /// The game textures a material binds, decoded in binding order; a missing or unreadable one is
    /// the neutral white texel (logged), never the checker.
    fn game_textures(&self, parts: &GpuParts) -> Vec<TextureData> {
        let log = self.log;
        let neutral = || TextureData::rgba8(1, 1, vec![u8::MAX; 4]).ok();
        let read = |path: &Option<std::sync::Arc<str>>| path.as_deref().and_then(|path| read_texture(path, &*self.source, &mut |line| log(line)));
        parts.textures.iter().filter_map(|path| read(path).or_else(neutral)).collect()
    }

    /// Create one extension with `create`: its id, or None when the device refused it.
    fn on_device<Id>(
        &mut self,
        parts: &GpuParts,
        create: impl FnOnce(&mut Resilient, &GpuParts) -> Result<Id, RenderError>,
    ) -> Result<Option<Id>, RenderError> {
        match create(&mut self.resilient, parts) {
            Ok(id) => Ok(Some(id)),
            Err(error) if error.code() == RenderCode::DeviceLost => Err(error),
            Err(error) => {
                self.refuse(parts, error);
                Ok(None)
            }
        }
    }

    fn refuse(&self, parts: &GpuParts, error: RenderError) {
        let refusal = ExtensionRefusal::from(error);
        let line = format!("Level-2 source {:?} refused on the device: {refusal}", parts.path());
        if parts.refuse(refusal) {
            (self.log)(&line);
        }
    }

    /// Hand the renderer every particle emitter `frame` draws that it does not hold yet (renderer
    /// pass 2 A.11), with its flipbook's atlas read from the game's assets once per path and grid.
    /// Uploads go through the resilient renderer, so a device loss or a rebuild replays them under
    /// the same ids. A refused emitter or atlas is logged once (the emitter is not drawn; one whose
    /// atlas was refused draws round dots); a lost device stops the frame (`device-lost`).
    fn hold_particles(&mut self, frame: &Frame) -> Result<(), RenderError> {
        for particles in frame.drawn_particles() {
            if self.particles.tried(particles.version()) {
                continue;
            }
            let mut desc = particles.desc();
            if let Some(book) = particles.flipbook() {
                let atlas = self.particle_atlas(book)?;
                desc.flipbook = atlas.map(|atlas| genex_render::particles::Flipbook { atlas, frames: book.frames, cycles: book.cycles, blend: book.blend });
            }
            let id = match self.resilient.add_emitter(desc) {
                Ok(id) => Some(id),
                Err(error) if error.code() == RenderCode::DeviceLost => return Err(error),
                Err(error) => {
                    (self.log)(&format!("particles refused: {error}: drawing the frame without them"));
                    None
                }
            };
            self.particles.emitters.push((particles.version(), id));
        }
        Ok(())
    }

    /// The renderer's atlas for `book`, uploaded on first use; None (logged) when its image is
    /// missing or refused.
    fn particle_atlas(&mut self, book: &crate::ParticleFlipbook) -> Result<Option<genex_render::particles::ParticleAtlasId>, RenderError> {
        let key = (book.atlas().to_owned(), book.grid());
        if let Some((_, id)) = self.particles.atlases.iter().find(|(held, _)| *held == key) {
            return Ok(*id);
        }
        let log = self.log;
        let image = read_texture(book.atlas(), &*self.source, &mut |line| log(line));
        let (columns, rows) = book.grid();
        let id = match image.map(|image| self.resilient.add_particle_atlas(genex_render::particles::ParticleAtlas { image, columns, rows })) {
            Some(Ok(id)) => Some(id),
            Some(Err(error)) if error.code() == RenderCode::DeviceLost => return Err(error),
            Some(Err(error)) => {
                log(&format!("particle atlas {:?} refused: {error}: drawing round particles", book.atlas()));
                None
            }
            None => None,
        };
        self.particles.atlases.push((key, id));
        Ok(id)
    }

    fn material_id(&self, key: Option<GpuKey>) -> Option<CustomMaterialId> {
        self.level2.materials[held_at(&self.level2.materials, &key?)?].id
    }

    fn post_id(&self, key: Option<GpuKey>) -> Option<PostPassId> {
        self.level2.posts[held_at(&self.level2.posts, &key?)?].id
    }

    /// The renderer's frame for `frame` from `camera`, in draw order, and its tally.
    fn immediate(&self, frame: &Frame, camera: &Camera) -> (ImmediateFrame, Drawn) {
        let (mut immediate, mut drawn) = world_frame(frame, camera, &self.assets);
        for draw in frame.custom_draws() {
            immediate.tag(&draw.tag);
            // Its draw id keys its motion under TAA as a plain draw's does (renderer pass 2,
            // P2-0.8b T-04); an id-less one matches by its mesh and order.
            immediate.id(draw.id);
            let triangles = self.push_custom(&mut immediate, &mut drawn, draw);
            note_triangles(&mut drawn, &draw.tag, triangles);
        }
        for post in frame.post_passes() {
            // A refused pass is skipped: the frame is drawn without it.
            if let Some(id) = self.post_id(post.pass.gpu_key()) {
                immediate.tag(&post.tag);
                immediate.post_pass(id);
            }
        }
        (immediate, drawn)
    }

    /// Add one custom draw to `immediate` (the checker for a refused or missing material, or a
    /// missing model); answers its triangles.
    fn push_custom(&self, immediate: &mut ImmediateFrame, drawn: &mut Drawn, draw: &crate::frame::CustomDraw) -> u32 {
        let matrix = draw.transform.to_cols_array();
        let (meshes, triangles) = match &draw.mesh {
            CustomMesh::Cube => (vec![MeshId::CUBE], CUBE_TRIANGLES),
            CustomMesh::Sphere => (vec![MeshId::SPHERE], SPHERE_TRIANGLES),
            CustomMesh::Model(model) => {
                let loaded: Option<Vec<&LoadedModel>> = model.drawn_members().iter().map(|member| self.assets.model(member.key()?)).collect();
                match loaded {
                    Some(loaded) => (loaded.iter().flat_map(|model| model.parts.iter().map(|part| part.mesh)).collect(), loaded.iter().map(|model| model.triangles).sum()),
                    None => {
                        note_missing(&mut drawn.missing_models, model.path());
                        immediate.mesh(MeshId::CUBE, matrix, Material::missing());
                        return CUBE_TRIANGLES;
                    }
                }
            }
        };
        let id = self.material_id(draw.material.gpu_key());
        for mesh in meshes {
            match id {
                Some(id) => immediate.custom(mesh, matrix, id, rgba(draw.tint)),
                None => immediate.mesh(mesh, matrix, Material::missing()),
            };
        }
        triangles
    }
}

impl Drop for Presenter {
    fn drop(&mut self) {
        // The HUD's texture changes die with the painter on purpose (epaint asserts otherwise).
        self.hud_unsent.clear();
        self.hud_history.clear();
    }
}

/// What the presenter hands the renderer for one frame's `choice` drawn as `class`: the same on the
/// frame thread and a warm-up thread.
fn set_choice(frame_renderer: &mut genex_render::FrameRenderer, choice: &FrameChoice, class: DeviceClass) {
    // The particles a frame of the class draws at most (renderer pass 2 A.11).
    frame_renderer.set_particle_cap(genex_render::particles::particle_cap(class));
    let renderer = frame_renderer.renderer_mut();
    renderer.set_quality(&choice.quality);
    renderer.set_render_scale(choice.scale);
    renderer.set_scene_format(choice.scene_format);
    renderer.set_look(choice.look);
    renderer.set_device_class(class);
}

/// The particle emitters (by [`crate::Particles::version`]) and flipbook atlases (by asset path and
/// grid) the presenter handed the renderer, each with its id or None where it was refused.
#[derive(Debug, Default)]
struct ParticlesHeld {
    emitters: Vec<(u64, Option<genex_render::particles::EmitterId>)>,
    atlases: Vec<(AtlasKey, Option<genex_render::particles::ParticleAtlasId>)>,
}

/// A flipbook atlas's key: its asset path and its grid (columns, rows).
type AtlasKey = (String, (u32, u32));

impl ParticlesHeld {
    /// Whether emitter `version` was handed over (held or refused).
    fn tried(&self, version: u64) -> bool {
        self.emitters.iter().any(|(held, _)| *held == version)
    }

    /// The renderer's id of emitter `version`, if it holds it.
    fn emitter(&self, version: u64) -> Option<genex_render::particles::EmitterId> {
        self.emitters.iter().find(|(held, _)| *held == version).and_then(|(_, id)| *id)
    }
}

/// The display intervals noted since the last Live frame: what dynamic resolution reads as the
/// frame's interval when the shell notes them.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct DisplayGaps {
    longest: Option<f32>,
}

impl DisplayGaps {
    /// One display frame of `ms` passed (a non-finite or negative one is ignored).
    fn note(&mut self, ms: f32) {
        if ms.is_finite() && ms >= 0.0 {
            self.longest = Some(self.longest.map_or(ms, |longest| longest.max(ms)));
        }
    }

    /// The longest interval since the last take, if the shell noted any; starts over.
    fn take(&mut self) -> Option<f32> {
        self.longest.take()
    }
}

/// A Live frame's timing in flight.
struct LiveTiming {
    landed: Option<Vec<f32>>,
    cpu: CpuTimer,
    interval_ms: f32,
}

/// Draw `immediate` once with the game's custom passes at `tick` (unless switched off) and the
/// HUD through `overlay`.
fn draw_once(
    resilient: &mut Resilient,
    registry: &mut CustomPasses,
    custom_passes: bool,
    passes: &mut [&mut dyn CustomPass],
    tick: u64,
    immediate: &ImmediateFrame,
    overlay: Option<&mut dyn OverlayPainter>,
) -> Result<genex_render::FrameReport, RenderError> {
    if !custom_passes {
        return resilient.render_with(immediate, CullPath::Gpu, overlay, &mut NoCustom);
    }
    let mut run = registry.frame(resilient.gpu(), passes, tick)?;
    resilient.render_with(immediate, CullPath::Gpu, overlay, &mut run)
}

/// A settled capture of `immediate`: `frames` re-renders on the renderer's capture-owned history,
/// each running the custom passes once with their settle index, the HUD on the last; Live's
/// history is left as it was whatever happens.
#[allow(clippy::too_many_arguments, reason = "the presenter's fields, borrowed apart so the passes and the renderer are both mutable")]
fn settle(
    resilient: &mut Resilient,
    registry: &mut CustomPasses,
    custom_passes: bool,
    passes: &mut [&mut dyn CustomPass],
    tick: u64,
    immediate: &ImmediateFrame,
    mut overlay: Option<&mut dyn OverlayPainter>,
    frames: u32,
) -> Result<genex_render::FrameReport, RenderError> {
    let (gpu, renderer) = resilient.parts_mut();
    renderer.begin_settle(gpu, frames)?;
    // A capture's custom passes start from an empty history (`CaptureRender::history_reset`).
    registry.set_capture(Some(frames));
    let drawn = loop {
        let last = resilient.renderer().settling().is_none_or(|frame| frame.is_last());
        let hud = if last { overlay.take() } else { None };
        let drawn = draw_once(resilient, registry, custom_passes, passes, tick, immediate, hud);
        if drawn.is_err() || last {
            break drawn;
        }
    };
    registry.set_capture(None);
    resilient.renderer_mut().end_settle();
    drawn
}

/// The renderer's camera for a facade camera: perspective with its field of view, or
/// orthographic with its `fovy` as the view's height in world units.
pub fn camera_desc(camera: &Camera) -> CameraDesc {
    let desc = CameraDesc {
        eye: camera.position.to_array(),
        target: camera.target.to_array(),
        up: camera.up.to_array(),
        fovy_degrees: camera.fovy,
        near: NEAR_PLANE,
        far: FAR_PLANE,
        ortho_height: None,
    };
    match camera.projection {
        Projection::Perspective => desc,
        Projection::Orthographic => desc.orthographic(camera.fovy),
    }
}

/// Add `triangles` to `tag`'s count, in first-draw order.
fn note_triangles(drawn: &mut Drawn, tag: &str, triangles: u32) {
    drawn.triangles = drawn.triangles.saturating_add(triangles);
    match drawn.by_tag.iter_mut().find(|(known, _)| known == tag) {
        Some((_, count)) => *count = count.saturating_add(triangles),
        None => drawn.by_tag.push((tag.to_owned(), triangles)),
    }
}

/// Add a model path drawn as the checker to `missing`, once; a handle with no path (an unsafe
/// path) names nothing.
fn note_missing(missing: &mut Vec<String>, path: Option<&str>) {
    let Some(path) = path else { return };
    if !missing.iter().any(|known| known == path) {
        missing.push(path.to_owned());
    }
}

fn rgba(color: Color) -> [u8; 4] {
    [color.r, color.g, color.b, color.a]
}

fn rgb(color: Color) -> [u8; 3] {
    [color.r, color.g, color.b]
}

/// A value in `0..=1`, or `fallback` when it is not finite.
fn unit(value: f32, fallback: f32) -> f32 {
    if value.is_finite() { value.clamp(0.0, 1.0) } else { fallback }
}

/// A light's intensity: dark when negative or not finite.
fn intensity(value: f32) -> f32 {
    if value.is_finite() { value.max(0.0) } else { 0.0 }
}

/// `color` multiplied by `tint` in linear light (alpha as stored); white leaves it exact.
fn tinted(color: Color, tint: Color) -> Color {
    if tint == Color::WHITE {
        return color;
    }
    let channel = |c: u8, t: u8| linear_to_srgb(srgb_to_linear(c) * srgb_to_linear(t));
    let alpha = (f32::from(color.a) * f32::from(tint.a) / 255.0).round() as u8;
    Color::rgba(channel(color.r, tint.r), channel(color.g, tint.g), channel(color.b, tint.b), alpha)
}

/// The renderer's material for a draw's facade material times `tint`, its textures as `assets`
/// loaded them (a slot whose texture did not load is untextured).
fn surface(material: &crate::Material, tint: Color, assets: &AssetCache) -> Material {
    let metallic = unit(material.metallic, DEFAULT_METALLIC);
    let roughness = unit(material.roughness, DEFAULT_ROUGHNESS);
    let texture = |path: Option<&str>, kind: TextureKind| path.and_then(|path| assets.texture(path, kind));
    let base_texture = texture(material.base_texture(), TextureKind::Color);
    // A missing base texture draws the material's stand-in colour where it names one.
    let base_color = material.untextured_color().filter(|_| base_texture.is_none()).unwrap_or(material.base_color);
    let mut surface = Material::color(rgba(tinted(base_color, tint))).with_pbr(metallic, roughness);
    surface.base_texture = base_texture;
    surface.metal_rough_texture = texture(material.metal_rough_texture(), TextureKind::Data);
    if let Some(normal) = texture(material.normal_texture(), TextureKind::Normal) {
        let scale = if material.normal_scale.is_finite() { material.normal_scale } else { 1.0 };
        surface = surface.with_normal_map(normal, scale);
    }
    surface = surface.with_emissive(rgb(material.emissive), intensity(material.emissive_strength));
    surface.emissive_texture = texture(material.emissive_texture(), TextureKind::Color);
    surface.subsurface = material.subsurface();
    surface
}

/// The renderer's decal for a facade decal (renderer pass 2 A.10), its maps as `assets` loaded
/// them: `None` while a base-colour texture it names is not loaded (missing, refused or still
/// loading), since that texture is its shape; a missing normal or ORM texture leaves that map out.
/// The renderer holds or drops hostile values (`decals::Decal::held`).
fn decal_of(decal: &crate::Decal, assets: &AssetCache) -> Option<genex_render::decals::Decal> {
    let texture = |path: Option<&str>, kind: TextureKind| path.and_then(|path| assets.texture(path, kind));
    let albedo = texture(decal.base_texture(), TextureKind::Color);
    if decal.base_texture().is_some() && albedo.is_none() {
        return None;
    }
    let linear = |c: u8| genex_render::texture::srgb_to_linear(c);
    let color = decal.color;
    Some(genex_render::decals::Decal {
        model: decal.transform.to_cols_array(),
        albedo,
        normal: texture(decal.normal_texture(), TextureKind::Normal),
        orm: texture(decal.orm_texture(), TextureKind::Data),
        color: [linear(color.r), linear(color.g), linear(color.b)],
        opacity: decal.opacity * f32::from(color.a) / 255.0,
        albedo_mix: decal.albedo_mix,
        normal_strength: decal.normal_strength,
        flatten: decal.flatten,
        roughness: decal.roughness,
        metallic: decal.metallic,
        occlusion: decal.occlusion,
        depth_fade: decal.depth_fade,
        angle_fade: decal.angle_fade,
    })
}

/// Whether a local light at `position` reaching `range` can light anything: a finite position and
/// a positive finite range.
fn usable_light(position: glam::Vec3, range: f32) -> bool {
    position.is_finite() && range.is_finite() && range > 0.0
}

/// A cone half-angle in radians, or `fallback` when it is not finite (the renderer clamps the rest).
fn angle(value: f32, fallback: f32) -> f32 {
    if value.is_finite() { value } else { fallback }
}

/// The renderer's spot light for a facade spot: a direction that is zero or not finite points down,
/// a cone angle that is not finite takes the default.
fn spot_light(light: &crate::frame::SpotLight) -> SpotLight {
    let usable = light.direction.is_finite() && light.direction != glam::Vec3::ZERO;
    let direction = if usable { light.direction } else { glam::Vec3::NEG_Y };
    let defaults = crate::frame::SpotLight::new(light.position, direction, light.range, light.color, light.intensity);
    SpotLight {
        position: light.position.to_array(),
        direction: direction.to_array(),
        range: light.range,
        color: rgb(light.color),
        intensity: intensity(light.intensity),
        inner_angle: angle(light.inner_angle, defaults.inner_angle),
        outer_angle: angle(light.outer_angle, defaults.outer_angle),
        shadow: light.shadow,
    }
}

/// The renderer's lights for what a frame declared: the defaults for what it left out. A sun
/// direction that is zero or not finite keeps the default; a point or spot light without a finite
/// position or a positive finite range is dropped; intensities are never negative or infinite.
fn lighting(lights: &Lights) -> Lighting {
    let mut lighting = Lighting::default();
    if let Some(sun) = &lights.sun {
        if sun.direction.is_finite() && sun.direction != glam::Vec3::ZERO {
            lighting.sun_dir = sun.direction.to_array();
        }
        lighting.sun_color = rgb(sun.color);
        lighting.sun_intensity = intensity(sun.intensity);
    }
    if let Some(ambient) = &lights.ambient {
        lighting.ambient = rgb(ambient.color);
        lighting.ambient_intensity = intensity(ambient.intensity);
    }
    lighting.points = lights
        .points
        .iter()
        .filter(|light| usable_light(light.position, light.range))
        .map(|light| PointLight { position: light.position.to_array(), range: light.range, color: rgb(light.color), intensity: intensity(light.intensity) })
        .collect();
    lighting.spots = lights.spots.iter().filter(|light| usable_light(light.position, light.range)).map(spot_light).collect();
    // The renderer holds or drops a hostile probe (`probes::ReflectionProbe::held`).
    lighting.reflection_probes = lights
        .reflection_probes
        .iter()
        .map(|probe| genex_render::probes::ReflectionProbe {
            min: probe.min.to_array(),
            max: probe.max.to_array(),
            capture: probe.capture.to_array(),
            blend: probe.blend,
            intensity: probe.intensity,
        })
        .collect();
    // The renderer holds or drops a hostile volume (`irradiance::IrradianceVolume::held`).
    lighting.irradiance_volumes = lights
        .irradiance_volumes
        .iter()
        .map(|volume| genex_render::irradiance::IrradianceVolume {
            min: volume.min.to_array(),
            max: volume.max.to_array(),
            cells: volume.cells,
            blend: volume.blend,
            intensity: volume.intensity,
        })
        .collect();
    lighting
}

/// Where a frame's world draws go: the presenter's [`ImmediateFrame`] or a bare [`Scene`].
trait WorldSink: characters::SkinSink {
    fn tag(&mut self, name: &str);
    /// The draw id the following meshes carry ([`Frame::id`]): motion vectors match a moving
    /// draw to its last frame by it (RQ5.1).
    fn id(&mut self, id: Option<DrawId>);
    fn mesh(&mut self, mesh: MeshId, model: [f32; 16], material: Material);
    /// A retained instance group drawing with `material` (renderer pass 2 A.0b).
    fn group(&mut self, group: &genex_render::retained::InstanceGroup, material: Material);
    fn line(&mut self, from: [f32; 3], to: [f32; 3], color: [u8; 4]);
    /// Line segments as one logical draw (NAV-15): each pair of vertices one segment.
    fn lines(&mut self, vertices: &[LineVertex]);
    fn lighting(&mut self) -> &mut Lighting;
    /// How the following meshes choose their levels (LOD-07): a bias and a compound's sphere.
    fn lod(&mut self, lod: DrawLod);
}

impl WorldSink for Scene {
    fn tag(&mut self, _name: &str) {}

    fn id(&mut self, id: Option<DrawId>) {
        self.set_id(id);
    }

    fn mesh(&mut self, mesh: MeshId, model: [f32; 16], material: Material) {
        self.draw(mesh, model, material);
    }

    fn group(&mut self, group: &genex_render::retained::InstanceGroup, material: Material) {
        self.draw_group_with(group, material);
    }

    fn line(&mut self, from: [f32; 3], to: [f32; 3], color: [u8; 4]) {
        Scene::line(self, from, to, color);
    }

    fn lines(&mut self, vertices: &[LineVertex]) {
        Scene::lines(self, vertices);
    }

    fn lighting(&mut self) -> &mut Lighting {
        &mut self.lighting
    }

    fn lod(&mut self, lod: DrawLod) {
        self.set_lod(lod);
    }
}

impl WorldSink for ImmediateFrame {
    fn tag(&mut self, name: &str) {
        ImmediateFrame::tag(self, name);
    }

    // The presenter's frame carries the ids to the motion prepass (RQ5.6); draws without one fall
    // back to their mesh ordinal.
    fn id(&mut self, id: Option<DrawId>) {
        ImmediateFrame::id(self, id);
    }

    fn mesh(&mut self, mesh: MeshId, model: [f32; 16], material: Material) {
        ImmediateFrame::mesh(self, mesh, model, material);
    }

    fn group(&mut self, group: &genex_render::retained::InstanceGroup, material: Material) {
        ImmediateFrame::group(self, group, material);
    }

    fn line(&mut self, from: [f32; 3], to: [f32; 3], color: [u8; 4]) {
        ImmediateFrame::line(self, from, to, color);
    }

    fn lines(&mut self, vertices: &[LineVertex]) {
        ImmediateFrame::lines(self, vertices);
    }

    fn lighting(&mut self) -> &mut Lighting {
        self.lighting_mut()
    }

    fn lod(&mut self, lod: DrawLod) {
        self.set_lod(lod);
    }
}

/// Write `frame`'s lights and shapes into `sink` with what `assets` loaded, in draw order, and
/// tally their triangles and missing models into `drawn`. Models not loaded (missing, refused or
/// not loaded yet) draw the missing-asset checker cube under their transform.
fn write_world(sink: &mut impl WorldSink, frame: &Frame, assets: &AssetCache, drawn: &mut Drawn) {
    *sink.lighting() = lighting(frame.lights());
    sink.lighting().decals = frame.decals().iter().filter_map(|decal| decal_of(decal, assets)).collect();
    for draw in frame.draws() {
        sink.tag(&draw.tag);
        sink.id(draw.id);
        let triangles = push_shape(sink, assets, &mut drawn.missing_models, &draw.shape);
        note_triangles(drawn, &draw.tag, triangles);
    }
}

/// Add one shape to `sink`; answers its triangles.
fn push_shape(sink: &mut impl WorldSink, assets: &AssetCache, missing: &mut Vec<String>, shape: &Shape) -> u32 {
    match shape {
        Shape::Model { model, transform, tint, material } => {
            let matrix = transform.to_cols_array();
            // LOD-07: a bias, and a compound's one sphere every part measures from.
            let lod = draw_lod(model, assets);
            if let Some(lod) = lod {
                sink.lod(lod);
            }
            let mut triangles = 0u32;
            for member in model.drawn_members() {
                let Some(loaded) = member.key().and_then(|key| assets.model(key)) else {
                    sink.mesh(MeshId::CUBE, matrix, Material::missing());
                    note_missing(missing, member.path());
                    triangles = triangles.saturating_add(CUBE_TRIANGLES);
                    continue;
                };
                for part in &loaded.parts {
                    let drawn_with = match (material, &part.material) {
                        (Some(material), _) => surface(material, *tint, assets),
                        (None, Some(glb)) => glb.to_material(rgba(*tint)),
                        (None, None) => surface(&crate::Material::color(*tint), Color::WHITE, assets),
                    };
                    sink.mesh(part.mesh, matrix, drawn_with);
                }
                triangles = triangles.saturating_add(loaded.triangles);
            }
            if lod.is_some() {
                sink.lod(DrawLod::OWN);
            }
            triangles
        }
        Shape::Cube { transform, material } => {
            sink.mesh(MeshId::CUBE, transform.to_cols_array(), surface(material, Color::WHITE, assets));
            CUBE_TRIANGLES
        }
        Shape::Sphere { center, radius, material } => {
            sink.mesh(MeshId::SPHERE, scaled(center.to_array(), [*radius; 3]), surface(material, Color::WHITE, assets));
            SPHERE_TRIANGLES
        }
        Shape::Line { from, to, color } => {
            sink.line(from.to_array(), to.to_array(), rgba(*color));
            0
        }
        Shape::Lines { points, color } => {
            let color = rgba(*color);
            let vertices: Vec<LineVertex> = points.iter().map(|point| LineVertex::srgb(point.to_array(), color)).collect();
            sink.lines(&vertices);
            0
        }
        Shape::Group { group } => push_group(sink, assets, missing, group),
        // AN-17: skinned in its pose; a missing file draws the checker.
        Shape::Character { animator, transform, tint, material } => {
            let character = characters::CharacterShape { animator, transform: *transform, tint: *tint, material: material.as_ref() };
            characters::push(sink, assets, missing, character)
        }
    }
}

/// How `model`'s draw chooses its levels (LOD-07), when it differs from each part measuring from
/// its own bounds at bias 1: its bias, and for a compound the sphere around its members' loaded
/// meshes, so every part switches at the same distance.
fn draw_lod(model: &Model, assets: &AssetCache) -> Option<DrawLod> {
    let lod = model.lod_options()?;
    let compound = !lod.members.is_empty();
    let sphere = lod.members.iter().filter_map(|member| assets.model(member.key()?)).fold([0.0; 4], |sphere, loaded| union_sphere(sphere, loaded.sphere));
    let origin = (compound && sphere[3] > 0.0).then_some(sphere);
    let bias = lod.bias();
    let differs = origin.is_some() || bias != crate::lod::LOD_BIAS_DEFAULT;
    differs.then_some(DrawLod { origin, bias, ..DrawLod::OWN })
}

/// Add one retained instance group to `sink` (renderer pass 2 A.0b): the renderer's group of
/// each mesh it draws, with the material the matching single draw would take; answers its
/// triangles (every transform's).
fn push_group(sink: &mut impl WorldSink, assets: &AssetCache, missing: &mut Vec<String>, group: &crate::InstanceGroup) -> u32 {
    let count = group.len() as u32;
    let white = crate::Material::color(Color::WHITE);
    let own = || surface(group.material().unwrap_or(&white), Color::WHITE, assets);
    match group.shape() {
        crate::GroupShape::Cube => {
            sink.group(&group.render_group(MeshId::CUBE), own());
            CUBE_TRIANGLES.saturating_mul(count)
        }
        crate::GroupShape::Sphere => {
            sink.group(&group.render_group(MeshId::SPHERE), own());
            SPHERE_TRIANGLES.saturating_mul(count)
        }
        crate::GroupShape::Model(model) => {
            // LOD-07: the model's bias and a compound's sphere hold for every copy.
            let lod = draw_lod(model, assets);
            if let Some(lod) = lod {
                sink.lod(lod);
            }
            let mut triangles = 0u32;
            for member in model.drawn_members() {
                let Some(loaded) = member.key().and_then(|key| assets.model(key)) else {
                    sink.group(&group.render_group(MeshId::CUBE), Material::missing());
                    note_missing(missing, member.path());
                    triangles = triangles.saturating_add(CUBE_TRIANGLES.saturating_mul(count));
                    continue;
                };
                for part in &loaded.parts {
                    let drawn_with = match (group.material(), &part.material) {
                        (None, Some(glb)) => glb.to_material(rgba(Color::WHITE)),
                        _ => own(),
                    };
                    sink.group(&group.render_group(part.mesh), drawn_with);
                }
                triangles = triangles.saturating_add(loaded.triangles.saturating_mul(count));
            }
            if lod.is_some() {
                sink.lod(DrawLod::OWN);
            }
            triangles
        }
    }
}

/// The water `frame` draws ([`Frame::water`], renderer pass 2 B.3) as the renderer takes it, its
/// ripples and foam at `tick`'s simulated seconds (never wall time, so a capture is the same every
/// time); None without one.
pub fn water_of(frame: &Frame, tick: u64) -> Option<genex_render::scene::SceneWater> {
    let body = frame.drawn_water()?.body()?;
    Some(genex_render::scene::SceneWater { body, time: (tick as f64 * FIXED_STEP_MS / 1000.0) as f32 })
}

/// The renderer's scene for `frame` drawn from `camera` with what `assets` loaded: its lights,
/// then its shapes in draw order. The presenter writes its frame with the same writer, so a shell
/// drawing this scene draws what the presenter draws.
/// What `frame`'s world draw counts against `assets` with no GPU: the draws, triangles, models
/// drawn as the checker and textures `draw_view` reports.
pub fn drawn_of(frame: &Frame, camera: &Camera, assets: &AssetCache) -> Drawn {
    world_frame(frame, camera, assets).1
}

pub fn to_scene(frame: &Frame, camera: &Camera, assets: &AssetCache) -> Scene {
    let mut scene = Scene::new(camera_desc(camera), rgba(frame.clear_color()));
    write_world(&mut scene, frame, assets, &mut Drawn::default());
    // A scene bridge has no tick: its water stands at its clock's start.
    scene.water = water_of(frame, 0);
    scene
}

/// Whether the environment map at `path` is on `resilient`'s device: uploaded now unless it was
/// handed to this device already and the renderer still holds it (`handed`: the generation, path
/// and outcome of the last upload; the renderer releases a map when the environment leaves it). A
/// refusal is logged once per device; a lost device stops the frame.
fn upload_environment_map(resilient: &mut Resilient, handed: &mut Option<(u32, String, bool)>, log: Log, path: &str, map: &PreparedMap) -> Result<bool, RenderError> {
    let generation = resilient.generation();
    let held = resilient.renderer().renderer().holds_environment_map();
    if let Some((_, _, taken)) = handed.as_ref().filter(|(at, known, taken)| *at == generation && known == path && (held || !*taken)) {
        return Ok(*taken);
    }
    let (gpu, renderer) = resilient.parts_mut();
    let taken = match renderer.renderer_mut().set_prepared_environment_map(gpu, map) {
        Ok(()) => true,
        Err(error) if error.code() == RenderCode::DeviceLost => return Err(error),
        Err(error) => {
            log(&format!("environment map {path:?} refused: {error}"));
            false
        }
    };
    *handed = Some((generation, path.to_owned(), taken));
    Ok(taken)
}

/// The presenter's frame for `frame`'s lights and shapes (no Level-2 draws yet), and its tally.
fn world_frame(frame: &Frame, camera: &Camera, assets: &AssetCache) -> (ImmediateFrame, Drawn) {
    let mut immediate = ImmediateFrame::new(camera_desc(camera), rgba(frame.clear_color()));
    if frame.is_camera_cut() {
        // A new shot: TAA, AO, motion and exposure history start over (RQ5.6).
        immediate.camera_cut();
    }
    let (textures, asset_issues) = texture_facts(frame, assets);
    let lod_refused = lod_refusals(frame, assets);
    let mut drawn = Drawn { draw_calls: frame.draw_calls(), textures, asset_issues, lod_refused, ..Drawn::default() };
    write_world(&mut immediate, frame, assets, &mut drawn);
    (immediate, drawn)
}

#[cfg(test)]
mod tests {
    use super::*;
    use glam::Vec3;

    #[test]
    fn tick_gated_frames_at_60_hz_report_the_display_interval_and_keep_the_scale() {
        use crate::render::{DeviceClass, DeviceFacts, FormFactor, PerformanceTier, RenderConfig, RenderControl, TargetOs};
        // Safari-like: no timestamps, so only intervals reach dynamic resolution. A 60 Hz FrameClock
        // against a 60 Hz rAF alternates 0 and 2 ticks at the phase boundary: Live frames are drawn
        // every other display frame, 33 ms apart, while no vsync was missed.
        let mut control = RenderControl::new(RenderConfig::new(), (960, 540));
        control.probe(DeviceFacts::new(TargetOs::MacOs, wgpu::Backend::Metal, wgpu::DeviceType::IntegratedGpu), None);
        control.apply(&crate::render::RenderChange {
            device_class: Some(Some(DeviceClass::new(FormFactor::Desktop, PerformanceTier::High))),
            ..Default::default()
        });
        let nominal = control.live_frame().scale;
        let mut gaps = DisplayGaps::default();
        let display_ms = 1000.0 / 60.0;
        let mut drawn = 0u64;
        for (frame, ticks) in [0u32, 2].into_iter().cycle().take(600).enumerate() {
            gaps.note(display_ms);
            if ticks == 0 {
                continue;
            }
            drawn += 1;
            let interval = gaps.take().expect("display frames were noted");
            assert!((interval - display_ms).abs() < 0.01, "frame {frame}: {interval} ms");
            control.observe(Some(1.0), None, interval, Duration::from_micros(16_667 * frame as u64));
        }
        assert_eq!(drawn, 300);
        assert_eq!(control.live_frame().scale, nominal, "skipped tickless display frames are not missed vsyncs");
        let mut slow = DisplayGaps::default();
        slow.note(16.7);
        slow.note(50.0);
        slow.note(f32::NAN);
        assert_eq!(slow.take(), Some(50.0), "a real miss among the skipped frames still counts");
        assert_eq!(slow.take(), None);
    }

    /// The presenter's frame and [`to_scene`] are one writer: for a frame with lights, materials,
    /// a loaded and a missing model, the presenter's scene is the bridge's, and its tally counts
    /// the same draws.
    #[test]
    fn the_presenter_s_world_frame_is_to_scene() {
        let assets = crate::Assets::default();
        let mut frame = Frame::new(Color::rgb(1, 2, 3));
        frame.sun(Vec3::new(0.2, 1.0, 0.0), Color::rgb(255, 220, 200), 3.0).ambient(Color::BLUE, 0.1);
        frame.point_light(Vec3::Y, 3.0, Color::RED, 2.0);
        frame.tag("pond").model_tinted(&assets.model("pond.glb"), crate::Transform::IDENTITY, Color::rgb(10, 20, 30));
        frame.model(&assets.model("gone.glb"), crate::Transform::IDENTITY);
        frame.cube_with(crate::Transform::IDENTITY, &crate::Material::color(Color::GREEN).with_metallic(1.0));
        frame.line(Vec3::ZERO, Vec3::X, Color::WHITE);
        let mut cache = AssetCache::default();
        cache.insert_model("pond.glb", Some(MeshId::from_raw(2)));
        cache.insert_model("gone.glb", None);
        let (immediate, drawn) = world_frame(&frame, &Camera::DEFAULT, &cache);
        assert_eq!(immediate.scene(), &to_scene(&frame, &Camera::DEFAULT, &cache));
        assert_eq!(drawn.draw_calls, 4);
        assert_eq!(drawn.missing_models, ["gone.glb"]);
        assert_eq!(drawn.by_tag, [("pond".to_owned(), 2 * CUBE_TRIANGLES)], "the loaded stand-in has no triangles; the checker and the cube do");
    }

    /// `frame.id(key)` reaches the renderer's scene: every mesh drawn under an id (a model's parts
    /// included) carries it, and draws after `end_id` carry none, so motion vectors match a
    /// moving object by its id.
    #[test]
    fn draw_ids_reach_the_scene_s_draws() {
        let assets = crate::Assets::default();
        let mut frame = Frame::new(Color::BLACK);
        frame.cube(crate::Transform::IDENTITY, Color::RED);
        frame.id("deer").model(&assets.model("deer.glb"), crate::Transform::IDENTITY);
        frame.sphere(Vec3::ZERO, 1.0, Color::GREEN);
        frame.end_id().cube(crate::Transform::IDENTITY, Color::BLUE);
        let mut cache = AssetCache::default();
        cache.insert_model("deer.glb", Some(MeshId::from_raw(2)));
        let scene = to_scene(&frame, &Camera::DEFAULT, &cache);
        let ids: Vec<Option<DrawId>> = scene.draws.iter().map(|draw| draw.id).collect();
        let deer = Some(DrawId::from("deer"));
        assert_eq!(ids, [None, deer, deer, None]);
        assert_eq!(scene.id(), None, "the scope ends with the frame's");
    }

    #[test]
    fn declared_features_are_read_by_wire_name_and_an_unknown_one_is_refused() {
        assert_eq!(features_named("").expect("none"), wgpu::Features::empty());
        assert_eq!(features_named(" subgroup , ").expect("one"), wgpu::Features::SUBGROUP);
        let error = features_named("subgroup,warp-drive").expect_err("unknown");
        assert_eq!(error.code(), RenderCode::NativeFeatureMissing);
    }

    #[test]
    fn a_compiled_table_answers_its_own_paths_only() {
        let table: AssetTable = &[("pond.glb", b"glb bytes")];
        assert_eq!(table.model_bytes("pond.glb").as_deref(), Some(&b"glb bytes"[..]));
        assert_eq!(table.model_bytes("other.glb"), None);
    }

    #[test]
    fn an_orthographic_camera_is_drawn_orthographic_with_its_fovy_as_the_view_height() {
        let ortho = Camera { projection: Projection::Orthographic, fovy: 8.0, ..Camera::look_at(Vec3::new(0.0, 0.0, 10.0), Vec3::ZERO) };
        assert_eq!(camera_desc(&ortho).ortho_height, Some(8.0));
        let perspective = Camera { fovy: 60.0, ..Camera::DEFAULT };
        let desc = camera_desc(&perspective);
        assert_eq!((desc.ortho_height, desc.fovy_degrees), (None, 60.0));
    }
}
