//! The render memory budget (plan §2.5): a pure byte ledger, its degrade ladder and the numeric
//! work model.
//!
//! [`ledger`] models every pooled target, history buffer, IBL map, shadow array, material-texture
//! array and Level-3 pass of a [`Quality`] at the current dynamic-resolution step's size.
//! Transient attachments (MSAA colour, and MSAA depth nobody reads) count 0 bytes on adapters
//! where they save memory.
//!
//! [`fit`] steps a quality down a fixed ladder ([`DegradeRung::ALL`]) until the ledger fits the
//! class budget. Pipeline rungs (MSAA, TAA history) change the pipeline set and run only at boot
//! or on an explicit change ([`DegradeMode::Boot`]); at runtime ([`DegradeMode::Runtime`]) only the
//! resource rungs step. A rung is taken only when it saves bytes. A quality that still does not
//! fit is returned degraded as far as the ladder goes: the frame runs, it is never refused.
//!
//! [`work_model`] counts off-chip bytes, full-screen passes, texture taps per pixel and passes per
//! frame, the numbers `presets::work_limits` caps per class (mobile acceptance before devices).

use crate::graph::feature_landed;
use crate::presets::step_size;
use crate::renderer::landed_samples;
use crate::settings::{AntiAliasing, AoResolution, KnobKind, Quality, RenderFeature, SceneFormat, ShadowFilter, ShadowFormat, Upscaler};

/// What an entry holds.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum BudgetKind {
    /// A pooled render target.
    Target,
    /// A temporal history buffer (TAA, AO, exposure).
    History,
    /// Environment maps and LUTs.
    Ibl,
    /// Shadow map arrays.
    Shadows,
    /// Material texture arrays.
    MaterialArrays,
    /// A Level-3 custom pass's own resources (`PassSetup::bytes`).
    Pass,
    /// A GPU buffer the renderer holds: a frame table, the mesh library, a uniform or a node's own
    /// (renderer pass 2 A.0, LG-13; `Renderer::buffer_ledger`).
    Buffers,
}

/// One registered allocation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BudgetEntry {
    /// What it holds.
    pub kind: BudgetKind,
    /// Its label (a target's or a pass's name).
    pub label: String,
    /// Its bytes (0 for a transient attachment that saves memory).
    pub bytes: u64,
}

/// The ledger.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BudgetLedger {
    entries: Vec<BudgetEntry>,
}

impl BudgetLedger {
    /// An empty ledger.
    pub fn new() -> BudgetLedger {
        BudgetLedger::default()
    }

    /// Register `bytes` of `kind` as `label` (replacing an entry of the same kind and label).
    pub fn register(&mut self, kind: BudgetKind, label: &str, bytes: u64) {
        self.entries.retain(|entry| !(entry.kind == kind && entry.label == label));
        self.entries.push(BudgetEntry { kind, label: label.to_owned(), bytes });
    }

    /// The entries, in registration order.
    pub fn entries(&self) -> &[BudgetEntry] {
        &self.entries
    }

    /// Bytes in all.
    pub fn total(&self) -> u64 {
        self.entries.iter().fold(0u64, |sum, entry| sum.saturating_add(entry.bytes))
    }

    /// Bytes of one kind.
    pub fn total_of(&self, kind: BudgetKind) -> u64 {
        self.entries.iter().filter(|entry| entry.kind == kind).fold(0u64, |sum, entry| sum.saturating_add(entry.bytes))
    }

    /// Whether the ledger fits `budget_bytes`.
    pub fn fits(&self, budget_bytes: u64) -> bool {
        self.total() <= budget_bytes
    }
}

/// The bytes of a 2D target: `width` × `height` × `samples` × `texel_bytes`, or 0 when it is a
/// transient attachment on an adapter where that saves memory.
pub fn target_bytes(width: u32, height: u32, texel_bytes: u32, samples: u32, transient_saves_memory: bool) -> u64 {
    if transient_saves_memory {
        return 0;
    }
    u64::from(width) * u64::from(height) * u64::from(texel_bytes) * u64::from(samples.max(1))
}

/// The sky transmittance LUT (`rgba16float`).
const SKY_TRANSMITTANCE: (u64, u64) = (256, 64);
/// The sky multi-scattering LUT's side.
const SKY_MULTISCATTER_PX: u64 = 32;
/// The aerial-perspective volume's side.
const AERIAL_PX: u64 = 32;
/// Exposure histogram bins (plus one adapted value), 4 bytes each.
const EXPOSURE_HISTOGRAM_WORDS: u64 = 128 + 1;
/// `rgba16float` texel bytes (TAA history, bloom chain, IBL and sky maps).
const RGBA16F: u64 = 8;
/// Bytes of the 4-byte formats (depth32, normals, motion, AO, rgba8, bgra8, rg11b10).
const TEXEL4: u64 = 4;
/// The smallest shadow map the ladder halves to.
const SHADOW_SIZE_MIN: u32 = 768;
/// The smallest IBL cube the ladder halves to.
const IBL_SIZE_MIN: u32 = 64;
/// The smallest material size class the ladder halves to.
const MATERIAL_SIZE_MIN: u32 = 64;
/// The lowest chain resolution (top rows) the bloom rung halves to.
const BLOOM_RESOLUTION_MIN: u16 = 180;

/// A material texture array: square layers of `size_px` (rgba8 with a full mip chain).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct MaterialClass {
    /// Each layer's side in pixels.
    pub size_px: u32,
    /// Layers in the array.
    pub layers: u32,
}

impl MaterialClass {
    /// The array's bytes.
    pub fn bytes(&self) -> u64 {
        mip_chain_px(u64::from(self.size_px), u64::from(self.size_px), u32::MAX) * TEXEL4 * u64::from(self.layers)
    }
}

/// What the ledger is computed at, besides the quality.
#[derive(Clone, Debug, PartialEq)]
pub struct BudgetInput {
    /// The output (world target) size.
    pub output: (u32, u32),
    /// The current dynamic-resolution scale (the render size is the step's exact size).
    pub scale: f32,
    /// The class's scene format (used when the quality is HDR).
    pub scene_format: SceneFormat,
    /// Whether transient attachments save memory on this adapter.
    pub transient_saves_memory: bool,
    /// Whether a pass reads the MSAA colour after the world pass (the luminance-weighted resolve
    /// on the HDR path, `MsaaResolve::for_class`): it is never transient then.
    pub msaa_read: bool,
    /// Material texture arrays.
    pub materials: Vec<MaterialClass>,
    /// Whether `materials` are the arrays a renderer already allocated (fixed until the game
    /// reloads): the material rung cannot shrink them, so it is never taken.
    pub materials_fixed: bool,
    /// Whether the game uses shadowed spots (`Renderer::uses_shadowed_spots`): only then is the
    /// spot atlas layer reserved and its pass counted, for a quality that grants spot slots.
    pub spot_atlas: bool,
    /// Level-3 passes' declared bytes, by pass name.
    pub passes: Vec<(String, u64)>,
    /// The widest HDR environment map the device keeps (`presets::hdri_map_width`; 0: none
    /// reserved).
    pub environment_map_width: u32,
    /// The letterbox the window present fills on a Live frame (renderer pass 2, P2-0.9 step B),
    /// None for a capture or a frame no window shows: its staged image (the HUD paints over it)
    /// and, when the output is smaller, EASU's image are counted at this size.
    pub window: Option<(u32, u32)>,
    /// The GPU buffers the renderer holds, by label (LG-13; `Renderer::buffer_ledger`).
    pub buffers: Vec<(String, u64)>,
    /// The bytes of the look's 3D grading LUT the tonemap holds (renderer pass 2 A.2; 0: none;
    /// the [`GRADING_LUT_LABEL`] entry of `Renderer::buffer_ledger`).
    pub grading_lut_bytes: u64,
}

/// The ledger label of the look's 3D grading LUT ([`BudgetKind::Ibl`]; renderer pass 2 A.2).
pub const GRADING_LUT_LABEL: &str = "grading-lut";

impl BudgetInput {
    /// An input with no materials and no passes.
    pub fn new(output: (u32, u32), scale: f32, scene_format: SceneFormat, transient_saves_memory: bool) -> BudgetInput {
        BudgetInput {
            output,
            scale,
            scene_format,
            transient_saves_memory,
            msaa_read: false,
            materials: Vec::new(),
            materials_fixed: false,
            spot_atlas: false,
            passes: Vec::new(),
            environment_map_width: 0,
            window: None,
            buffers: Vec::new(),
            grading_lut_bytes: 0,
        }
    }

    /// The input with the [`BudgetKind::Buffers`] entries of `held` (the renderer's buffers) and
    /// its grading LUT ([`GRADING_LUT_LABEL`]).
    pub fn with_buffers(mut self, held: &BudgetLedger) -> BudgetInput {
        self.buffers = held.entries().iter().filter(|entry| entry.kind == BudgetKind::Buffers).map(|entry| (entry.label.clone(), entry.bytes)).collect();
        self.grading_lut_bytes = held.entries().iter().filter(|entry| entry.label == GRADING_LUT_LABEL).map(|entry| entry.bytes).sum();
        self
    }

    /// The input with the window present filling a `letterbox` (a Live frame's), or none.
    pub fn with_window(mut self, letterbox: Option<(u32, u32)>) -> BudgetInput {
        self.window = letterbox;
        self
    }

    /// The input with the MSAA colour read after the world pass (`read`) or not.
    pub fn with_msaa_read(mut self, read: bool) -> BudgetInput {
        self.msaa_read = read;
        self
    }

    /// The input with an HDR environment map up to `width` texels wide reserved.
    pub fn with_environment_map(mut self, width: u32) -> BudgetInput {
        self.environment_map_width = width;
        self
    }

    /// The input with one more material array.
    pub fn with_material(mut self, material: MaterialClass) -> BudgetInput {
        self.materials.push(material);
        self
    }

    /// The input with exactly these material arrays.
    pub fn with_materials(mut self, materials: Vec<MaterialClass>) -> BudgetInput {
        self.materials = materials;
        self
    }

    /// The input with the material arrays a renderer already allocated (`materials`, as
    /// `texture::material_arrays` of the class and quality it fixed them to): counted, never
    /// degraded.
    pub fn with_fixed_materials(mut self, materials: Vec<MaterialClass>) -> BudgetInput {
        self.materials = materials;
        self.materials_fixed = true;
        self
    }

    /// The input for a game that uses shadowed spots (`uses`) or not: the spot atlas layer is
    /// reserved only for one that does.
    pub fn with_spot_atlas(mut self, uses: bool) -> BudgetInput {
        self.spot_atlas = uses;
        self
    }

    /// The input with a Level-3 pass declaring `bytes`.
    pub fn with_pass(mut self, name: &str, bytes: u64) -> BudgetInput {
        self.passes.push((name.to_owned(), bytes));
        self
    }

    /// The render (scene) size: the scale step's exact size.
    pub fn render_size(&self) -> (u32, u32) {
        step_size(self.output, self.scale)
    }
}

/// Pixels in a mip chain from `w` × `h` down to 1 × 1, or `mips` levels if fewer.
fn mip_chain_px(w: u64, h: u64, mips: u32) -> u64 {
    let (mut w, mut h, mut total) = (w.max(1), h.max(1), 0u64);
    for _ in 0..mips {
        total += w * h;
        if w == 1 && h == 1 {
            break;
        }
        w = (w / 2).max(1);
        h = (h / 2).max(1);
    }
    total
}

/// Bytes per scene texel.
fn scene_texel(quality: &Quality, format: SceneFormat) -> u64 {
    match (quality.hdr, format) {
        (true, SceneFormat::Rgba16Float) => RGBA16F,
        _ => TEXEL4,
    }
}

/// What a quality's frame derives (shared by the ledger and the work model).
struct Shape {
    render: (u64, u64),
    output: (u64, u64),
    texel: u64,
    samples: u64,
    taa: bool,
    depth_consumers: bool,
    upscale: bool,
    /// Whether the MSAA colour is read after the world pass (never transient then).
    msaa_read: bool,
    /// Whether the spot atlas layer is held and drawn: the game uses shadowed spots and the
    /// quality grants them slots.
    spot_atlas: bool,
}

impl Shape {
    fn of(quality: &Quality, input: &BudgetInput) -> Shape {
        let (rw, rh) = input.render_size();
        // What the build draws: a preset asking for TAA draws one sample, resolved by TAA (RQ5.6).
        let taa = quality.anti_aliasing.temporal() && feature_landed(RenderFeature::Taa);
        let ao = quality.ao.resolution != AoResolution::Off;
        let depth_consumers = quality.prepass && (ao || taa || quality.occlusion || quality.contact_shadows);
        // TAA's scene is `rgba16float` whatever the class's format (its history's, so a resolve
        // copies into it for `post-hdr` passes: `Renderer::hdr_scene_format`).
        let texel = if taa && quality.hdr && input.scene_format.is_hdr() { RGBA16F } else { scene_texel(quality, input.scene_format) };
        Shape {
            render: (u64::from(rw), u64::from(rh)),
            output: (u64::from(input.output.0), u64::from(input.output.1)),
            texel,
            samples: u64::from(landed_samples(quality.anti_aliasing)),
            taa,
            depth_consumers,
            upscale: quality.hdr && quality.upscaler == Upscaler::Fsr1 && (rw, rh) != input.output,
            msaa_read: quality.hdr && input.msaa_read,
            spot_atlas: spot_atlas_held(quality, input.spot_atlas),
        }
    }

    fn render_px(&self) -> u64 {
        self.render.0 * self.render.1
    }

    fn output_px(&self) -> u64 {
        self.output.0 * self.output.1
    }

    /// The AO target's size (None when AO is off).
    fn ao_size(&self, quality: &Quality) -> Option<(u64, u64)> {
        match quality.ao.resolution {
            AoResolution::Full => Some(self.render),
            AoResolution::Half => Some(((self.render.0 / 2).max(1), (self.render.1 / 2).max(1))),
            _ => None,
        }
    }

    /// Pixels in the bloom chain (0 when bloom is off): sized from the output, the chain the
    /// renderer allocates ([`crate::post::bloom::chain_sizes`]), whatever the DRS step, and the
    /// pre-levels a scene more than twice its top's size is halved into first.
    fn bloom_px(&self, quality: &Quality) -> u64 {
        let size = |(w, h): (u64, u64)| (u32::try_from(w).unwrap_or(u32::MAX), u32::try_from(h).unwrap_or(u32::MAX));
        let (render, output) = (size(self.render), size(self.output));
        let chain = crate::post::bloom::chain_sizes(output, &quality.bloom);
        let pre = crate::post::bloom::pre_level_sizes(render, output, &quality.bloom);
        chain.iter().chain(&pre).map(|(w, h)| u64::from(*w) * u64::from(*h)).sum()
    }

    /// Bytes of the Hi-Z pyramid (half resolution down to 1 × 1, `r32float`).
    fn hi_z_bytes(&self) -> u64 {
        mip_chain_px((self.render.0 / 2).max(1), (self.render.1 / 2).max(1), u32::MAX) * TEXEL4
    }

    /// Bytes of the per-tile light masks.
    fn light_bin_bytes(&self, quality: &Quality) -> u64 {
        let tile = u64::from(quality.lights.tile_px.max(1));
        let tiles = self.render.0.div_ceil(tile) * self.render.1.div_ceil(tile);
        tiles * u64::from(quality.lights.cap.div_ceil(32)) * 4
    }
}

fn shadow_texel(quality: &Quality) -> u64 {
    match quality.shadows.format {
        ShadowFormat::Depth16 => 2,
        _ => TEXEL4,
    }
}

/// Whether the spot atlas layer is held under `quality` for a game that does (`used`) or does not
/// use shadowed spots: as the renderer holds it (sticky once a shadowed spot is asked for), only
/// while the quality bins lights, draws shadows and grants spot slots.
fn spot_atlas_held(quality: &Quality, used: bool) -> bool {
    used && quality.shadows.enabled && quality.lights.clustered && quality.lights.shadowed_spots > 0
}

fn shadow_bytes(quality: &Quality, spot_atlas: bool) -> (u64, u64) {
    if !quality.shadows.enabled {
        return (0, 0);
    }
    let texel = shadow_texel(quality);
    let side = u64::from(quality.shadows.map_size);
    let cascades = u64::from(quality.shadows.cascades) * side * side * texel;
    // Every shadowed spot is a tile of one atlas layer at the cascades' side (`spot_shadow::map_desc`).
    let spots = if spot_atlas { side * side * texel } else { 0 };
    (cascades, spots)
}

/// The IBL bake's bytes as the bake allocates them (`ibl::bake_parts`): the specular cubes, the
/// radiance cubes with SH9, the BRDF LUT.
fn ibl_bytes(quality: &Quality) -> Option<(u64, u64, u64)> {
    if !quality.hdr {
        return None;
    }
    crate::ibl::bake_parts(&quality.environment)
}

/// The HDR environment map's bytes at the widest map the device keeps (`width` × `width / 2`
/// `rgba16float` with its mips, `ibl::map_bytes`): reserved whenever the environment can draw (IBL
/// or the backdrop on), since a game may name a map in any frame.
fn environment_map_bytes(quality: &Quality, width: u32) -> Option<u64> {
    let environment = &quality.environment;
    let draws = quality.hdr && (environment.ibl || environment.sky);
    (draws && width > 0).then(|| crate::ibl::map_bytes(width, (width / 2).max(1)))
}

/// The sky LUT bytes: sky-view, transmittance, multi-scattering and (if on) aerial perspective.
fn sky_bytes(quality: &Quality) -> Option<[u64; 4]> {
    let environment = &quality.environment;
    if !quality.hdr || !environment.sky || environment.sky_lut.0 == 0 {
        return None;
    }
    let (w, h) = environment.sky_lut;
    let aerial = if environment.aerial_perspective { AERIAL_PX * AERIAL_PX * AERIAL_PX * RGBA16F } else { 0 };
    Some([
        u64::from(w) * u64::from(h) * RGBA16F,
        SKY_TRANSMITTANCE.0 * SKY_TRANSMITTANCE.1 * RGBA16F,
        SKY_MULTISCATTER_PX * SKY_MULTISCATTER_PX * RGBA16F,
        aerial,
    ])
}

/// The ledger of `quality` at `input`: every allocation the frame graph would pool for it.
pub fn ledger(quality: &Quality, input: &BudgetInput) -> BudgetLedger {
    let shape = Shape::of(quality, input);
    let mut ledger = BudgetLedger::new();
    register_scene(&mut ledger, quality, &shape, input.transient_saves_memory);
    register_post(&mut ledger, quality, &shape);
    register_lighting(&mut ledger, quality, &shape, input.environment_map_width);
    // Labelled by position too: two arrays of one shape (a class halved onto the next) are two entries.
    for (at, material) in input.materials.iter().enumerate() {
        ledger.register(BudgetKind::MaterialArrays, &format!("materials-{at}-{}x{}", material.size_px, material.layers), material.bytes());
    }
    for (name, bytes) in &input.passes {
        ledger.register(BudgetKind::Pass, name, *bytes);
    }
    for (label, bytes) in &input.buffers {
        ledger.register(BudgetKind::Buffers, label, *bytes);
    }
    if input.grading_lut_bytes > 0 {
        ledger.register(BudgetKind::Ibl, GRADING_LUT_LABEL, input.grading_lut_bytes);
    }
    register_window(&mut ledger, input);
    ledger
}

/// What a frame's buffers hold, in rows (LG-13): what [`buffer_model`] reads.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BufferCounts {
    /// Instance-table rows (opaque and transparent).
    pub instances: u64,
    /// Each cull view's visible-list region: the plan's visible slots (its opaque rows, and each
    /// level batch's slots, renderer pass 2 A6.9).
    pub opaque_instances: u64,
    /// Transparent draws.
    pub transparent: u64,
    /// Active cull views.
    pub views: u64,
    /// Opaque batches.
    pub batches: u64,
    /// Material-table rows.
    pub materials: u64,
    /// Light-table rows.
    pub lights: u64,
    /// Bytes of the light extension rows (with the shadowed spots' matrices).
    pub light_ext_bytes: u64,
    /// Bytes of the light-bin table (`cluster::bins_bytes`).
    pub light_bin_bytes: u64,
    /// Pass-view entries (256 bytes each).
    pub pass_views: u64,
    /// Slot-base rows.
    pub slot_base: u64,
    /// Whether previous models are written (motion vectors).
    pub motion: bool,
    /// The mesh library: vertices, indices and skin vertices.
    pub vertices: u64,
    /// Library indices.
    pub indices: u64,
    /// Skin-vertex rows.
    pub skin_vertices: u64,
}

/// A frame table of `bytes` as allocated: the table rounding (16 bytes, at least 256) grown to
/// the next power of two (`tables::Table::ensure`).
pub fn table_bytes(bytes: u64) -> u64 {
    crate::tables::aligned(bytes).next_power_of_two()
}

/// Bytes of the renderer's fixed buffers beside the frame tables and the library: the frame
/// uniforms, cull views, fog and background rows, and the light binning's uniform, bounds rows
/// and starting axis scratch.
const FIXED_BUFFER_BYTES: u64 = 4 * 1024 + (crate::cluster::MAX_CLUSTERABLES as u64) * 16 + 32 * 1024;

/// The model of the buffers a frame of `counts` makes the renderer hold (renderer pass 2 A.0,
/// LG-13): every frame table at its rows' bytes as tables grow, the library as uploaded and the
/// fixed buffers. A frame drawn after a larger one holds the larger tables (tables never shrink).
pub fn buffer_model(counts: &BufferCounts) -> u64 {
    use crate::layout::{DrawIndexedArgs, GpuBatch, GpuInstance, GpuLight, GpuMaterial, GpuMaterialExt, GpuMeshVertex, GpuPrevModel};
    let rows = |count: u64, stride: usize| table_bytes(count * stride as u64);
    let visible = counts.views * counts.opaque_instances + counts.transparent;
    let tables = [
        rows(counts.instances, size_of::<GpuInstance>()),
        rows(counts.materials, size_of::<GpuMaterial>()),
        rows(counts.materials, size_of::<GpuMaterialExt>()),
        rows(counts.lights, size_of::<GpuLight>()),
        rows(counts.batches, size_of::<GpuBatch>()),
        rows(counts.slot_base, 4),
        rows(visible, 4),
        rows(counts.views * counts.batches, size_of::<DrawIndexedArgs>()),
        table_bytes(crate::cull::scratch_bytes(counts.opaque_instances as u32, counts.views as u32)),
        rows(counts.pass_views.max(1), crate::tables::PASS_VIEW_STRIDE as usize),
        if counts.motion { rows(counts.instances, size_of::<GpuPrevModel>()) } else { table_bytes(0) },
        table_bytes(counts.light_ext_bytes),
        table_bytes(counts.light_bin_bytes),
    ];
    let library = [counts.vertices * size_of::<GpuMeshVertex>() as u64, counts.vertices * 4, counts.indices * 4, counts.skin_vertices * 32].map(crate::tables::aligned);
    tables.iter().chain(&library).sum::<u64>() + FIXED_BUFFER_BYTES
}

/// The window present's images ([`crate::letterbox::present`]) at the letterbox's size: the staged
/// `bgra8` image the HUD is painted over, and EASU's `rgb10a2` image when the output is upscaled
/// into a larger letterbox (the class's cap below the window's pixels).
fn register_window(ledger: &mut BudgetLedger, input: &BudgetInput) {
    let Some((width, height)) = input.window else { return };
    let pixels = u64::from(width) * u64::from(height);
    ledger.register(BudgetKind::Target, "window-staged", pixels * TEXEL4);
    let upscaled = width >= input.output.0 && height >= input.output.1 && (width, height) != input.output;
    if upscaled {
        ledger.register(BudgetKind::Target, "window-easu", pixels * TEXEL4);
    }
}

/// Scene colour, depth, the prepass, the output and the upscale target.
fn register_scene(ledger: &mut BudgetLedger, quality: &Quality, shape: &Shape, transient: bool) {
    let r = shape.render_px();
    let msaa = shape.samples > 1;
    if msaa {
        let held = transient && !shape.msaa_read;
        ledger.register(BudgetKind::Target, "scene-msaa", if held { 0 } else { r * shape.texel * shape.samples });
    }
    // Without HDR the scene is the legacy world target itself (LDR, at output size: scale 1).
    ledger.register(BudgetKind::Target, "scene", r * shape.texel);
    if msaa {
        ledger.register(BudgetKind::Target, "depth-msaa", if transient { 0 } else { r * TEXEL4 * shape.samples });
    } else {
        ledger.register(BudgetKind::Target, "depth", r * TEXEL4);
    }
    if shape.depth_consumers {
        if msaa {
            ledger.register(BudgetKind::Target, "prepass-depth", r * TEXEL4);
        }
        ledger.register(BudgetKind::Target, "normals", r * TEXEL4);
    }
    if quality.hdr {
        ledger.register(BudgetKind::Target, "output", shape.output_px() * TEXEL4);
    }
    if shape.upscale {
        ledger.register(BudgetKind::Target, "upscale", shape.output_px() * TEXEL4);
    }
    // FSR1's tonemapped `rgb10a2unorm` intermediate at render size (EASU's output is "upscale").
    if quality.hdr && (shape.upscale || quality.anti_aliasing == AntiAliasing::TaaSharpen) && feature_landed(RenderFeature::Upscaler) {
        ledger.register(BudgetKind::Target, "fsr-input", shape.render_px() * TEXEL4);
    }
}

/// TAA, AO, bloom, exposure.
fn register_post(ledger: &mut BudgetLedger, quality: &Quality, shape: &Shape) {
    let r = shape.render_px();
    if shape.taa {
        ledger.register(BudgetKind::History, "taa-history", r * RGBA16F * 2);
        ledger.register(BudgetKind::Target, "motion", r * TEXEL4);
        // The `r8unorm` reactive mask (the prepass's no-history flags, the transparents' coverage).
        ledger.register(BudgetKind::Target, "taa-reactive", r);
    }
    // AO's and the contact shadows' targets as the pool allocates them (`post::ao::targets`:
    // the raw and denoised terms, the view-depth chains with their mips, the bent normal's rgba8,
    // the history and the render-size upsample; the half-size mask and its upsample).
    let render = (shape.render.0 as u32, shape.render.1 as u32);
    if shape.ao_size(quality).is_some() {
        let (frame, history) = crate::post::ao::target_bytes(render, &quality.ao);
        ledger.register(BudgetKind::Target, "ao", frame);
        if history > 0 {
            ledger.register(BudgetKind::History, "ao-history", history);
        }
    }
    if quality.contact_shadows {
        ledger.register(BudgetKind::Target, "contact-shadows", crate::post::contact_shadow::mask_bytes(render));
    }
    // The sun-shadow mask's raw, two state and mask targets (renderer pass 2, B.7) where its key
    // lets it run: soft shadows on the HDR scene under TAA.
    if crate::post::sun_mask::key(quality, quality.hdr, shape.taa).is_some() {
        ledger.register(BudgetKind::Target, "sun-shadow-mask", crate::post::sun_mask::mask_bytes(render));
    }
    let bloom = shape.bloom_px(quality);
    if bloom > 0 {
        // The chain is `rgba16float` whatever the scene format: storage-capable in WebGPU core.
        ledger.register(BudgetKind::Target, "bloom", bloom * RGBA16F);
    }
    if quality.hdr && quality.exposure {
        ledger.register(BudgetKind::History, "exposure", EXPOSURE_HISTOGRAM_WORDS * 4);
    }
}

/// Hi-Z, light bins, shadows, IBL and the sky.
fn register_lighting(ledger: &mut BudgetLedger, quality: &Quality, shape: &Shape, map_width: u32) {
    if quality.occlusion {
        ledger.register(BudgetKind::Target, "hi-z", shape.hi_z_bytes());
    }
    if quality.lights.clustered {
        ledger.register(BudgetKind::Target, "light-bins", shape.light_bin_bytes(quality));
    }
    let (cascades, spots) = shadow_bytes(quality, shape.spot_atlas);
    if quality.shadows.enabled {
        ledger.register(BudgetKind::Shadows, "cascades", cascades);
    }
    if spots > 0 {
        ledger.register(BudgetKind::Shadows, "spots", spots);
    }
    if let Some((specular, irradiance, lut)) = ibl_bytes(quality) {
        ledger.register(BudgetKind::Ibl, "specular", specular);
        ledger.register(BudgetKind::Ibl, "irradiance", irradiance);
        ledger.register(BudgetKind::Ibl, "brdf-lut", lut);
    }
    if let Some(map) = environment_map_bytes(quality, map_width) {
        ledger.register(BudgetKind::Ibl, "environment-map", map);
    }
    if let Some([view, transmittance, multiscatter, aerial]) = sky_bytes(quality) {
        ledger.register(BudgetKind::Ibl, "sky-view", view);
        ledger.register(BudgetKind::Ibl, "transmittance", transmittance);
        ledger.register(BudgetKind::Ibl, "multi-scatter", multiscatter);
        if aerial > 0 {
            ledger.register(BudgetKind::Ibl, "aerial", aerial);
        }
    }
}

/// One rung of the degrade ladder, in its fixed order ([`DegradeRung::ALL`]).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum DegradeRung {
    /// Shadow maps `depth32float` → `depth16unorm` (`from`/`to`: bits per texel 32 → 16): half
    /// the maps' bytes at no feature's cost, so it comes before any anti-aliasing is given up.
    /// Pipeline: boot or explicit only.
    ShadowFormat,
    /// MSAA 4x → no AA (`from`/`to`: samples). Pipeline: boot or explicit only.
    Msaa,
    /// The sun-shadow screen mask → the forward pass's inline soft shadows (`from`/`to`: 1 on, 0
    /// off; renderer pass 2, B.7). It is the first resource rung: its 28 bytes a pixel (58 MB at
    /// 1080p) would otherwise take AO, the shadow and IBL sizes and then TAA from a browser that
    /// hides `deviceMemory`, and the inline path draws the same shadows with a little more
    /// still-camera flicker.
    SunMask,
    /// TAA → MSAA 4x where MSAA is transient, else no AA (`from`/`to`: history buffers 2 → 0).
    /// Pipeline: boot or explicit only. It comes after the resource rungs (AO, bloom resolution, spot
    /// shadows, shadow and IBL size; RQ5 review): its history pair is a fraction of what they
    /// free, and on a GPU without transient attachments its fallback is no anti-aliasing at all
    /// (a browser hiding `deviceMemory` keeps TAA at 1080p this way).
    TaaHistory,
    /// AO full → half → off (`from`/`to`: 2 full, 1 half, 0 off).
    Ao,
    /// The bloom chain's resolution halves, down to 180 rows (`from`/`to`: its top's rows). Its
    /// mip count never changes (renderer pass 2, P5).
    BloomResolution,
    /// Shadowed spots → none (`from`/`to`: spot slots): the spot atlas layer goes before the sun's
    /// cascades are halved for its memory. Taken only for a game that uses shadowed spots (only
    /// then is the layer reserved).
    SpotShadows,
    /// Shadow map side halves, down to 768.
    ShadowSize,
    /// IBL cube side halves, down to 64.
    IblSize,
    /// The largest material size class halves, down to 64.
    MaterialSize,
    /// Cascades −1, down to 1.
    Cascades,
}

impl DegradeRung {
    /// The ladder, in order.
    pub const ALL: [DegradeRung; 11] = [
        DegradeRung::ShadowFormat,
        DegradeRung::Msaa,
        DegradeRung::SunMask,
        DegradeRung::Ao,
        DegradeRung::BloomResolution,
        DegradeRung::SpotShadows,
        DegradeRung::ShadowSize,
        DegradeRung::IblSize,
        DegradeRung::TaaHistory,
        DegradeRung::MaterialSize,
        DegradeRung::Cascades,
    ];

    /// Whether the rung changes resources (runtime) or the pipeline set (boot or explicit only).
    pub const fn kind(self) -> KnobKind {
        match self {
            DegradeRung::ShadowFormat | DegradeRung::Msaa | DegradeRung::TaaHistory => KnobKind::Pipeline,
            _ => KnobKind::Resource,
        }
    }

    /// The wire spelling (`volatile.render` degrade details).
    pub const fn wire(self) -> &'static str {
        match self {
            DegradeRung::ShadowFormat => "shadow-format",
            DegradeRung::Msaa => "msaa",
            DegradeRung::TaaHistory => "taa-history",
            DegradeRung::SunMask => "sun-mask",
            DegradeRung::Ao => "ao",
            DegradeRung::BloomResolution => "bloom-resolution",
            DegradeRung::SpotShadows => "spot-shadows",
            DegradeRung::ShadowSize => "shadow-size",
            DegradeRung::IblSize => "ibl-size",
            DegradeRung::MaterialSize => "material-size",
            DegradeRung::Cascades => "cascades",
        }
    }
}

/// When a degrade runs.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum DegradeMode {
    /// At boot or on an explicit change: every rung.
    Boot,
    /// While running (DRS demotion): resource rungs only.
    Runtime,
}

/// One step taken down a rung.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct DegradeStep {
    /// The rung.
    pub rung: DegradeRung,
    /// The value before (see [`DegradeRung`] for each rung's unit).
    pub from: u32,
    /// The value after.
    pub to: u32,
}

/// What [`fit`] answers.
#[derive(Clone, Debug, PartialEq)]
pub struct Fitted {
    /// The degraded quality.
    pub quality: Quality,
    /// The material arrays after the material rung.
    pub materials: Vec<MaterialClass>,
    /// The steps taken, in order.
    pub steps: Vec<DegradeStep>,
    /// The ledger total after them.
    pub total_bytes: u64,
    /// Whether it fits the budget (false: degraded as far as the ladder goes, still drawn).
    pub fits: bool,
}

fn ao_level(resolution: AoResolution) -> u32 {
    match resolution {
        AoResolution::Full => 2,
        AoResolution::Half => 1,
        _ => 0,
    }
}

/// One step down `rung` from `quality` and `materials`, if the rung has room.
fn step_down(rung: DegradeRung, quality: &mut Quality, materials: &mut [MaterialClass], input: &BudgetInput) -> Option<(u32, u32)> {
    let transient = input.transient_saves_memory;
    match rung {
        DegradeRung::ShadowFormat => step_shadow_format(quality),
        DegradeRung::Msaa => step_msaa(quality),
        DegradeRung::TaaHistory => step_taa(quality, transient),
        DegradeRung::SunMask => step_sun_mask(quality),
        DegradeRung::Ao => step_ao(quality),
        DegradeRung::BloomResolution => step_bloom(quality),
        DegradeRung::SpotShadows => step_spot_shadows(quality),
        DegradeRung::ShadowSize => step_shadow_size(quality),
        DegradeRung::IblSize => step_ibl(quality),
        DegradeRung::MaterialSize if input.materials_fixed => None,
        DegradeRung::MaterialSize => step_material(materials),
        DegradeRung::Cascades => step_cascades(quality),
    }
}

fn step_msaa(quality: &mut Quality) -> Option<(u32, u32)> {
    if quality.anti_aliasing != AntiAliasing::Msaa4 {
        return None;
    }
    let from = quality.anti_aliasing.samples();
    quality.anti_aliasing = AntiAliasing::Off;
    Some((from, quality.anti_aliasing.samples()))
}

fn step_taa(quality: &mut Quality, transient: bool) -> Option<(u32, u32)> {
    if !quality.anti_aliasing.temporal() {
        return None;
    }
    quality.anti_aliasing = if transient { AntiAliasing::Msaa4 } else { AntiAliasing::Off };
    Some((2, 0))
}

fn step_ao(quality: &mut Quality) -> Option<(u32, u32)> {
    let from = ao_level(quality.ao.resolution);
    quality.ao.resolution = match quality.ao.resolution {
        AoResolution::Full => AoResolution::Half,
        AoResolution::Half => AoResolution::Off,
        _ => return None,
    };
    Some((from, ao_level(quality.ao.resolution)))
}

fn step_bloom(quality: &mut Quality) -> Option<(u32, u32)> {
    let resolution = quality.bloom.resolution;
    if !quality.bloom.enabled || resolution / 2 < BLOOM_RESOLUTION_MIN {
        return None;
    }
    quality.bloom.resolution = resolution / 2;
    Some((u32::from(resolution), u32::from(resolution / 2)))
}

fn step_sun_mask(quality: &mut Quality) -> Option<(u32, u32)> {
    if !quality.shadows.screen_mask {
        return None;
    }
    quality.shadows.screen_mask = false;
    Some((1, 0))
}

fn step_spot_shadows(quality: &mut Quality) -> Option<(u32, u32)> {
    let spots = quality.lights.shadowed_spots;
    if spots == 0 {
        return None;
    }
    quality.lights.shadowed_spots = 0;
    Some((u32::from(spots), 0))
}

fn step_shadow_format(quality: &mut Quality) -> Option<(u32, u32)> {
    if !quality.shadows.enabled || quality.shadows.format == ShadowFormat::Depth16 {
        return None;
    }
    quality.shadows.format = ShadowFormat::Depth16;
    Some((32, 16))
}

fn step_shadow_size(quality: &mut Quality) -> Option<(u32, u32)> {
    let size = quality.shadows.map_size;
    if !quality.shadows.enabled || size <= SHADOW_SIZE_MIN {
        return None;
    }
    quality.shadows.map_size = (size / 2).max(SHADOW_SIZE_MIN);
    Some((size, quality.shadows.map_size))
}

/// Halve both IBL cubes (the sky's and an HDR map's); `from`/`to` are the larger side.
fn step_ibl(quality: &mut Quality) -> Option<(u32, u32)> {
    let environment = &mut quality.environment;
    let size = environment.cube_size.max(environment.hdri_cube_size);
    if !environment.ibl || size <= IBL_SIZE_MIN {
        return None;
    }
    environment.cube_size = (environment.cube_size / 2).max(IBL_SIZE_MIN);
    environment.hdri_cube_size = (environment.hdri_cube_size / 2).max(IBL_SIZE_MIN);
    Some((size, environment.cube_size.max(environment.hdri_cube_size)))
}

fn step_material(materials: &mut [MaterialClass]) -> Option<(u32, u32)> {
    let largest = materials.iter().map(|material| material.size_px).max()?;
    let material = materials.iter_mut().find(|material| material.size_px == largest)?;
    if largest <= MATERIAL_SIZE_MIN {
        return None;
    }
    material.size_px = (largest / 2).max(MATERIAL_SIZE_MIN);
    Some((largest, material.size_px))
}

fn step_cascades(quality: &mut Quality) -> Option<(u32, u32)> {
    let cascades = quality.shadows.cascades;
    if !quality.shadows.enabled || cascades <= 1 {
        return None;
    }
    quality.shadows.cascades = cascades - 1;
    Some((u32::from(cascades), u32::from(cascades - 1)))
}

/// Step `quality` down the ladder until its ledger at `input` fits `budget_bytes`: each rung in
/// order, one step at a time, a step kept only when it saves bytes. [`DegradeMode::Runtime`]
/// skips the pipeline rungs, so a runtime degrade never changes [`Quality::pipeline_key`].
pub fn fit(quality: &Quality, input: &BudgetInput, budget_bytes: u64, mode: DegradeMode) -> Fitted {
    let mut current = *quality;
    let mut materials = input.materials.clone();
    let mut steps = Vec::new();
    let measure = |quality: &Quality, materials: &[MaterialClass]| ledger(quality, &input.clone().with_materials(materials.to_vec())).total();
    let mut total = measure(&current, &materials);
    for rung in DegradeRung::ALL {
        if mode == DegradeMode::Runtime && rung.kind() == KnobKind::Pipeline {
            continue;
        }
        while total > budget_bytes {
            let (mut next, mut next_materials) = (current, materials.clone());
            let Some((from, to)) = step_down(rung, &mut next, &mut next_materials, input) else { break };
            let next_total = measure(&next, &next_materials);
            if next_total >= total {
                break;
            }
            (current, materials, total) = (next, next_materials, next_total);
            steps.push(DegradeStep { rung, from, to });
        }
    }
    Fitted { quality: current, materials, steps, total_bytes: total, fits: total <= budget_bytes }
}

/// The numeric work of one frame (plan §2.5).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct WorkModel {
    /// Off-chip bytes: target stores, loads and resolves (material textures and geometry excluded).
    pub offchip_bytes: u64,
    /// Passes that touch every pixel at render or output size.
    pub fullscreen_passes: u32,
    /// Texture taps per pixel (reduced-resolution passes weighed by their area).
    pub taps_per_pixel: f32,
    /// Render and compute passes opened.
    pub render_passes: u32,
}

/// Taps of one shadow lookup per filter (shaders/lighting/sun.wgsl): one hardware tap, nine
/// bilinear taps, nine `textureGatherCompare` footprints, PCSS-lite's 8 blocker and 16 filter
/// taps, PCSS's 16 and 32.
pub fn shadow_taps(filter: ShadowFilter) -> f32 {
    match filter {
        ShadowFilter::Hardware2x2 => 1.0,
        ShadowFilter::Pcf3x3 | ShadowFilter::Pcf5x5 => 9.0,
        ShadowFilter::PcssLite => 24.0,
        _ => 48.0,
    }
}

/// Material texture layers sampled per pixel (base colour, metallic-roughness, normal): one fetch
/// each, on the size-class path too (each from its own class's arrays, RQ6 review).
const MATERIAL_TAPS: f32 = 3.0;
/// Taps of one shadowed spot's lookup (`gx_spot_shadow`'s 3x3 PCF), counted per spot slot where
/// the spot atlas is held (spots overlapping on screen, the worst case).
const SPOT_PCF_TAPS: f32 = 9.0;
/// TAA taps: 3x3 neighbourhood, history, motion and a 3x3 depth dilation.
const TAA_TAPS: f32 = 20.0;
/// EASU's 12-tap kernel.
const EASU_TAPS: f32 = 12.0;
/// RCAS's 5-tap cross.
const RCAS_TAPS: f32 = 5.0;
/// Bloom: a 13-tap downsample and a 9-tap tent upsample per mip texel.
const BLOOM_TAPS_PER_MIP_TEXEL: f32 = 22.0;
/// Contact-shadow march steps (half resolution).
const CONTACT_SHADOW_STEPS: f32 = 16.0;
/// The AO denoiser's taps.
const AO_DENOISE_TAPS: f32 = 4.0;

/// The work model of `quality` at `input` on a tile GPU (`tile`: MSAA attachments and discarded
/// depth never leave the chip) or an immediate-mode one.
pub fn work_model(quality: &Quality, input: &BudgetInput, tile: bool) -> WorkModel {
    let shape = Shape::of(quality, input);
    WorkModel {
        offchip_bytes: offchip_bytes(quality, &shape, tile),
        fullscreen_passes: fullscreen_passes(quality, &shape),
        taps_per_pixel: taps_per_pixel(quality, &shape),
        render_passes: render_passes(quality, &shape),
    }
}

fn offchip_bytes(quality: &Quality, shape: &Shape, tile: bool) -> u64 {
    let (r, o, texel) = (shape.render_px(), shape.output_px(), shape.texel);
    let (cascades, spots) = shadow_bytes(quality, shape.spot_atlas);
    // A shadow map is stored once and read about once by the lit pass.
    let mut bytes = 2 * (cascades + spots);
    bytes += world_pass_bytes(shape, tile);
    if shape.depth_consumers {
        bytes += 3 * r * TEXEL4; // prepass depth + normals stored, depth read by the Equal test
    }
    if quality.hdr {
        // Tonemap: the scene read, the output written (bilinear fused); an upscale's extra
        // traffic is [`upscale_offchip_bytes`].
        bytes += r * texel + o * TEXEL4;
        bytes += upscale_offchip_bytes(shape);
        bytes += r * texel / u64::from(quality.exposure_input_divisor.max(1)).pow(2);
    }
    bytes += post_bytes(quality, shape);
    bytes += lighting_bytes(quality, shape);
    bytes + o * TEXEL4 // the compositor reads the output
}

/// The off-chip bytes EASU and RCAS add over the bilinear upscale fused into the tonemap: the
/// tonemap writes the render-size intermediate (instead of the output) and EASU reads it, EASU
/// writes its output-size image and RCAS reads it before writing the output the fused tonemap
/// would have written.
fn upscale_offchip_bytes(shape: &Shape) -> u64 {
    if !shape.upscale {
        return 0;
    }
    let (r, o) = (shape.render_px(), shape.output_px());
    2 * r * TEXEL4 + 2 * o * TEXEL4
}

/// The share of [`work_model`] that the FSR1 upscale adds below scale 1 over the bilinear upscale
/// fused into the tonemap: EASU, and RCAS where TAA's sharpen does not already run it (a frame at
/// scale 1, or with the bilinear upscaler, adds nothing). Owner decision 2026-10-12 (b) spends it
/// on every phone class on top of the plan's work ceilings (`presets::work_limits`); its GPU cost
/// is gated by the Mac mobile proxy.
pub fn upscale_work(quality: &Quality, input: &BudgetInput) -> WorkModel {
    let shape = Shape::of(quality, input);
    if !(quality.hdr && shape.upscale) {
        return WorkModel::default();
    }
    let rcas_added = quality.anti_aliasing != AntiAliasing::TaaSharpen;
    let passes = 1 + u32::from(rcas_added);
    WorkModel {
        offchip_bytes: upscale_offchip_bytes(&shape),
        fullscreen_passes: passes,
        taps_per_pixel: EASU_TAPS + if rcas_added { RCAS_TAPS } else { 0.0 },
        render_passes: passes,
    }
}

/// Of every MSAA pixel, the fraction (numerator over denominator) whose samples differ: desktop
/// GPUs compress MSAA colour and depth, so only edge pixels move their extra samples.
const MSAA_EDGE_FRACTION: (u64, u64) = (1, 4);

/// Off-chip bytes of an MSAA surface of `single_bytes` per sample-1 image at `samples`.
fn msaa_traffic(single_bytes: u64, samples: u64) -> u64 {
    let (edge, of) = MSAA_EDGE_FRACTION;
    single_bytes * (of + (samples - 1) * edge) / of
}

/// The world pass's colour and depth traffic.
fn world_pass_bytes(shape: &Shape, tile: bool) -> u64 {
    let (r, texel, samples) = (shape.render_px(), shape.texel, shape.samples);
    let depth_stored = if shape.depth_consumers { r * TEXEL4 } else { 0 };
    if tile {
        return r * texel + depth_stored;
    }
    if samples > 1 {
        // MSAA colour written, read by the resolve, resolved colour written; MSAA depth written.
        return 2 * msaa_traffic(r * texel, samples) + r * texel + msaa_traffic(r * TEXEL4, samples);
    }
    r * texel + r * TEXEL4
}

fn post_bytes(quality: &Quality, shape: &Shape) -> u64 {
    let (r, texel) = (shape.render_px(), shape.texel);
    let mut bytes = 0;
    if shape.taa {
        bytes += r * (texel + RGBA16F + TEXEL4 + TEXEL4) + r * RGBA16F + r * TEXEL4;
    }
    if let Some((w, h)) = shape.ao_size(quality) {
        let px = w * h;
        let history = if quality.ao.temporal { 2 * px * TEXEL4 } else { 0 };
        bytes += px * 8 + px * TEXEL4 + 2 * px * TEXEL4 + history + px * TEXEL4;
    }
    let bloom = shape.bloom_px(quality);
    if bloom > 0 {
        bytes += 4 * bloom * RGBA16F;
    }
    if quality.contact_shadows {
        bytes += r * TEXEL4 + r / 4 * TEXEL4;
    }
    bytes
}

fn lighting_bytes(quality: &Quality, shape: &Shape) -> u64 {
    let mut bytes = 0;
    if quality.occlusion {
        bytes += shape.render_px() * TEXEL4 + shape.hi_z_bytes();
    }
    if quality.lights.clustered {
        bytes += 2 * shape.light_bin_bytes(quality);
    }
    if let Some((specular, irradiance, lut)) = ibl_bytes(quality) {
        bytes += specular + irradiance + lut;
    }
    if let Some([view, _, _, aerial]) = sky_bytes(quality) {
        bytes += 2 * (view + aerial) / u64::from(quality.environment.sky_cadence.max(1));
    }
    bytes
}

fn fullscreen_passes(quality: &Quality, shape: &Shape) -> u32 {
    let ao = u32::from(quality.ao.resolution != AoResolution::Off) * 2;
    let sharpen = shape.upscale || quality.anti_aliasing == AntiAliasing::TaaSharpen;
    u32::from(quality.hdr)
        + u32::from(shape.taa)
        + u32::from(shape.upscale)
        + u32::from(sharpen)
        + ao
        + u32::from(quality.contact_shadows)
}

fn taps_per_pixel(quality: &Quality, shape: &Shape) -> f32 {
    let mut taps = MATERIAL_TAPS;
    if quality.shadows.enabled {
        taps += shadow_taps(quality.shadows.filter);
    }
    if shape.spot_atlas {
        taps += SPOT_PCF_TAPS * f32::from(quality.lights.shadowed_spots);
    }
    if ibl_bytes(quality).is_some() {
        taps += 3.0;
    }
    if let Some([_, _, _, aerial]) = sky_bytes(quality) {
        taps += 1.0 + if aerial > 0 { 1.0 } else { 0.0 };
    }
    if quality.contact_shadows {
        taps += CONTACT_SHADOW_STEPS / 4.0;
    }
    if let Some((w, h)) = shape.ao_size(quality) {
        let area = (w * h) as f32 / shape.render_px().max(1) as f32;
        let temporal = if quality.ao.temporal { 1.0 } else { 0.0 };
        taps += (f32::from(quality.ao.slices) * f32::from(quality.ao.steps) * 2.0 + AO_DENOISE_TAPS + temporal) * area + 1.0;
    }
    let bloom = shape.bloom_px(quality);
    if bloom > 0 {
        taps += BLOOM_TAPS_PER_MIP_TEXEL * bloom as f32 / shape.render_px().max(1) as f32 + 1.0;
    }
    taps + post_taps(quality, shape)
}

fn post_taps(quality: &Quality, shape: &Shape) -> f32 {
    let mut taps = if quality.hdr { 1.0 } else { 0.0 };
    if shape.taa {
        taps += TAA_TAPS;
    }
    if shape.upscale {
        taps += EASU_TAPS;
    }
    if shape.upscale || quality.anti_aliasing == AntiAliasing::TaaSharpen {
        taps += RCAS_TAPS;
    }
    taps
}

/// Passes opened: the pre-pass compute (cull, skinning, sky, light bins), one per cascade, one for
/// all shadowed spots (an atlas), the prepass and its compute (AO, Hi-Z, contact shadows), the
/// world pass and the occlusion pass's second geometry pass, the post compute (exposure, bloom,
/// TAA), the tonemap, EASU and RCAS.
fn render_passes(quality: &Quality, shape: &Shape) -> u32 {
    let shadows = if quality.shadows.enabled { u32::from(quality.shadows.cascades) } else { 0 };
    let spots = u32::from(shape.spot_atlas);
    let screen_compute = quality.ao.resolution != AoResolution::Off || quality.occlusion || quality.contact_shadows;
    let post_compute = quality.hdr && (quality.exposure || quality.bloom.enabled || shape.taa);
    let sharpen = shape.upscale || quality.anti_aliasing == AntiAliasing::TaaSharpen;
    1 + shadows
        + spots
        + u32::from(shape.depth_consumers)
        + u32::from(shape.depth_consumers && screen_compute)
        + 1
        + u32::from(quality.occlusion)
        + u32::from(post_compute)
        + u32::from(quality.hdr)
        + u32::from(shape.upscale)
        + u32::from(sharpen)
}
