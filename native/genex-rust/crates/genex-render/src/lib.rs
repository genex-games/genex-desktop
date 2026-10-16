//! The wgpu renderer on WebGPU core. V1 is GPU-driven-ready (plan "Renderer scope"): instances,
//! materials, texture indices and lights live in storage-buffer tables; a compute pass frustum-
//! culls every opaque batch for the camera and both shadow cascades and writes indirect draw
//! arguments drawn by `multi_draw_indexed_indirect`; skinning runs in compute into a storage
//! vertex buffer; transparent draws stay CPU-sorted direct draws. The tagged draw counter counts
//! logical draws before culling, so culling never changes `drawCalls`, and nothing the checksum
//! reads comes from the GPU.
//!
//! GPU-facing structs are explicit `[f32; N]` arrays with bytemuck, never glam types ([`layout`]).
//! Every CPU transcendental that reaches a capture is libm's (clippy.toml).
//!
//! # Modules
//!
//! The registry below is the renderer's feature map. Part 2 (M2.6) adds counted immediate
//! primitives with the tagged draw counter, the 2D camera, the HUD overlay stage, the WGSL
//! extension points, GPU particles, device-loss recovery, HiDPI and pacing, and world labels; a
//! [`FrameRenderer`] draws an [`ImmediateFrame`] through all of them. M2.19 adds custom GPU passes
//! ([`custom_pass`]) to the part-2 block: the game's own WGSL, admitted per pass, so none of it is
//! in [`shaders::SHADERS`].

// --- Device, bounds, readback (M0a.4) ---
/// Adapter floor and capability receipt.
pub mod floor;
/// The device a renderer draws with.
pub mod gpu;
/// GPU bounds: caps for WGSL, buffers, textures, per-frame uploads and captures.
pub mod caps;
mod error;
/// Captures: top-down BGRA readback, FNV-1a-64, the v1 capture files.
pub mod capture;
mod readback;
/// The letterbox that places the world target in a window.
pub mod letterbox;

// --- Part 1: GPU-driven tables and culling, PBR, shadows, skinning (M2.5) ---
/// GPU-facing struct layouts.
pub mod layout;
/// Meshes: immediate primitives and GLB models.
pub mod mesh;
/// Scenes and the frame plan (the tables a frame draws from).
pub mod scene;
/// Instance-table rows.
pub mod instance;
/// Retained static instance groups (renderer pass 2 A.0b; owner decision D4).
pub mod retained;
/// The storage-buffer tables and per-frame uploads.
pub mod tables;
/// The compute frustum cull and its CPU reference.
pub mod cull;
/// Metallic-roughness materials (lights moved to [`lights`], re-exported here).
pub mod pbr;
/// Two-cascade sun shadows.
pub mod shadow;
/// Skinned glTF and compute skinning.
pub mod skin;
/// Sorted transparency.
pub mod transparent;
/// Texture arrays and mips.
pub mod texture;
/// The renderer's WGSL.
pub mod shaders;
/// Built-in pipelines compiled side by side on a small thread pool.
pub mod compile;
/// The renderer: passes, MSAA, present.
pub mod renderer;

// --- Part 2: immediate primitives, 2D camera, HUD stage, WGSL extensions, particles, device
// loss, HiDPI and pacing, world labels (M2.6). Custom passes (M2.19) register here too ---
/// Part-2 bounds: the counts the immediate primitives, extensions and particles are held to.
pub mod limits;
/// The 2D camera the 2D primitives are drawn through.
pub mod camera2d;
/// Counted immediate primitives, the tagged draw counter and the frame renderer.
pub mod immediate;
/// The HUD overlay stage (egui paints counted as `hud`-tagged draws).
pub mod overlay;
/// The WGSL extension points (`Material::custom`, `post_pass`): versioned layouts, naga admission.
pub mod extension;
/// GPU particles: a render-only compute emitter.
pub mod particles;
/// Device-loss recovery: the device watch and the resilient renderer.
pub mod device_loss;
/// HiDPI world sizing, logical captures, present mode and 60 Hz pacing.
pub mod pacing;
/// In-world labels projected for the HUD.
pub mod world_text;
/// Custom GPU passes (extension ladder level 3, M2.19): raw wgpu work registered into the frame.
pub mod custom_pass;
/// The shared wind field vertex animation evaluates at two times for its motion (pass 2, B.7).
pub mod wind;

// --- Renderer follow-up (RQ0.1 registers every RQ0 module, so wave-1 work never edits this file).
// Settings and the frozen ABI are registry files: each tier's contracts WP appends to them ---
/// Render settings: the game's look, per-preset quality knobs, the legacy `off` profile.
pub mod settings;
/// The published GPU ABI: the frozen v1 frame compat buffer and rows, Level-3 render inputs.
pub mod abi;
/// The device probe and device classes.
pub mod device_class;
/// Quality presets and per-class defaults.
pub mod presets;
/// The render memory budget ledger.
pub mod budget;
/// Dynamic resolution: discrete scale steps driven by typed frame signals.
pub mod drs;
/// Frame timing: GPU timestamps, CPU time, sliding percentiles.
pub mod timing;
/// The frame graph: the ordered node table.
pub mod graph;
/// The render-target pool.
pub mod target_pool;

// --- RQ1: HDR, tonemapping, exposure; extension API v2 (RQ1.0 registers every RQ1 module) ---
/// Post-processing nodes: the tonemap and MSAA resolve, exposure.
pub mod post;
/// Settled captures: K-frame re-renders on capture-owned history.
pub mod settle;

// --- RQ2: image-based lighting, the physical sky, HDR environment maps (RQ2.0 registers every
// RQ2 module, so wave-1 work never edits this file) ---
/// Image-based lighting baked on the GPU: the specular cube, SH9 and the BRDF LUT.
pub mod ibl;
/// The physical sky (Hillaire) on every preset: its LUTs and the background.
pub mod sky;
/// HDR environment maps from a game's assets: the Radiance `.hdr` decoder and its caps.
pub mod hdri;
/// Reflection probes (renderer pass 2 A.3): box-projected local cubes captured in the scene.
pub mod probes;
/// Irradiance volumes (renderer pass 2 A.4): grids of ambient cubes baked in the scene.
pub mod irradiance;
/// Heightmap terrain (renderer pass 2 A.7): CDLOD selection and morph over a quantized height
/// field, its own pipelines, and splat materials from a control map.
pub mod terrain;
/// Screen inputs (renderer pass 2 A.6): the opaque copy, the previous frame's colour pyramid, the
/// prepass's normal and roughness, the screen reflections' slot and the shared SSR march helper.
pub mod screen_inputs;
/// Foliage (renderer pass 2 A.8): GPU-generated grass on the terrain's grassy layers, in the
/// shared wind, lit through the forward chunks with diffuse transmission.
pub mod foliage;

// --- RQ4: the depth/normal prepass, bloom, GTAO, fog, contact shadows (RQ4.0 registers every RQ4
// module; bloom, AO and contact shadows are `post` nodes) ---
/// The depth/normal prepass: its targets, consumers and `Equal`-depth reuse.
pub mod prepass;
/// Height and distance fog matched to the sky: its GPU row and CPU reference.
pub mod fog;

// --- RQ5: motion vectors, TAA, the FSR1 upscaler (RQ5.0 registers every RQ5 module; TAA and the
// upscaler are `post` nodes, `post::taa` and `post::fsr`, whose shaders their modules hold until
// the tier's integrate WP lists them in `shaders::SHADERS`) ---
/// TAA's sub-pixel jitter: Halton(2, 3) keyed to the frame index.
pub mod jitter;
/// Motion vectors: the motion target, the previous-model table and draw ids.
pub mod motion;

// --- R2: meshlets and two-pass Hi-Z occlusion (R2.0 registers every R2 module, so wave-1 work
// never edits this file; renderer architecture notes, the meshlet schema among them, are in the
// crate's README.md, which eject copies with the crate) ---
/// Meshlets: limits, the packed triangle and index encodings, the `genex_meshlets` extras schema,
/// the validator and the library's meshlet buffers.
pub mod meshlet;
/// The Hi-Z pyramid: its format, size, mips and the reduction of each depth convention.
pub mod hiz;
/// Meshlet culling with two-pass Hi-Z occlusion: visibility history, ordered scan, draws.
pub mod meshlet_cull;

// --- RQ6: emissive materials, spot lights, light binning, texture quality (RQ6.0 registers every
// RQ6 module, so wave-1 work never edits this file) ---
/// The scene's lights: the sun, points and spots, the light table and its extension table.
pub mod lights;
/// Light binning: depth-sorted lights, per-tile bitmasks and z-bins (no per-cluster cap).
pub mod cluster;
/// Shadowed spot lights: tiles of one atlas layer of the shared shadow array (RQ6.5).
pub mod spot_shadow;

pub use caps::{BUFFER_MAX_BYTES, CAPTURE_MAX_BYTES, TEXTURE_MAX_BYTES, UPLOAD_MAX_BYTES_PER_FRAME, WGSL_MAX_BYTES};
pub use error::{ExtensionFault, RenderCode, RenderError, UnsupportedReason};
pub use abi::{CUSTOM_PASS_API_VERSION, CUSTOM_PASS_APIS, EXTENSION_API_VERSION, EXTENSION_APIS};
pub use settings::{Environment, Fog, FrameConfig, JitterCycle, LdrReason, Look, Meshlets, Quality, RcasQuality, RenderSettings, ShadowSettings, TaaQuality};
pub use immediate::{FrameRenderer, FrameReport, GpuCounters, ImmediateFrame};
pub use gpu::Gpu;
pub use renderer::{CullPath, FrameStats, MSAA_SAMPLES, RenderOptions, Renderer, WORLD_FORMAT, WorldPass, WorldStage};

// rapier3d is only in the graph for the layout check (`--features rapier-layout-check`).
#[cfg(feature = "rapier-layout-check")]
use rapier3d as _;
