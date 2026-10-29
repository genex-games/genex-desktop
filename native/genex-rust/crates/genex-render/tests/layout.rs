//! GPU-facing structs are explicit `[f32; N]` arrays with hand padding, never glam types, so their
//! sizes do not move when Rapier's `enhanced-determinism` turns glam to scalar math. This test runs
//! in both builds (default, and `--features rapier-layout-check`, which puts rapier3d in the
//! graph) against one golden table, so the two builds agree; it also holds each Rust size to the
//! size naga computes for the WGSL struct of the same name, and validates every renderer shader
//! against WebGPU core (no naga capabilities).
//!
//! Every shader also emits through naga's back ends the destinations compile it with: HLSL at
//! shader model 5.1 (FXC, Windows), MSL 2.4 (the iOS 16 / macOS floor) and SPIR-V 1.3 (Vulkan
//! 1.1, Android), for each override variant its pipelines use, so a shader that only one browser
//! or one Mac accepts fails here first. The published v1 tables (`GxFrame`, `GxInstance`,
//! `GxMaterial`) are held to the frozen ABI rows of `abi.rs`.
//!
//! The v2 ABI (RQ1.0): `GxFrameV2`, `GxDrawV2`, `GxPostV2` and the environment and material
//! extension rows equal naga's layout member for member; both v2 preludes declare exactly the
//! reserved bind-group map of `abi.rs`, and that map plus the game's group 2 fits WebGPU core's
//! per-stage limits (`Limits::defaults()`).
//!
//! The environment (RQ2.0): the forward frame layout binds the environment under the v2 map's
//! names and types and stays within core's per-stage limits; every compute shader keeps plan
//! §2.3's format rules (storage formats, at most 4 storage textures, at most 16 KB of workgroup
//! memory); and every target the pool may be asked for is one core guarantees.
//!
//! RQ4.0: every depth-writing vertex entry point declares its position `@invariant` (naga
//! reflection), the RQ4 rows (`GxFog`, bloom, AO and contact-shadow uniforms) equal naga's layout,
//! the forward frame group's reserved effect slots fit core beside today's bindings, every RQ4
//! target is one core guarantees, and the custom-pass stage vocabulary (with `after-prepass`) is
//! the host's.
//!
//! R2.0: the meshlet rows (`Meshlet`, `MeshletInstance`, `DrawnMeshlet`, `MeshletCull`,
//! `HizParams`) equal naga's layout; the R2 stub shaders (Hi-Z build, meshlet cull, meshlet draw)
//! validate against core, emit on every back end and keep the format rules; the meshlet draw's
//! vertex stage reads at most core's 8 storage buffers, its pipeline layout (forward frame group,
//! pass view, meshlet group) shows each stage at most 8 counted the WebGPU way (every binding the
//! stage can see) and builds on a core device, it writes an `@invariant` position through
//! `gx_clip_position` and declares exactly the meshlet group the tables lay out; the Hi-Z pyramid
//! is a core target reduced by the depth convention; and the R2 nodes stay unlanded, so the picture
//! is unchanged.
//!
//! RQ3.0: the frame uniforms grow past the frozen v1 prefix (`GxFrameV1` keeps its 416 bytes) with
//! every cascade of up to four, under the members the sun chunk shares with `GxFrameV2`; the cull
//! views reserve nine views; the sun chunk's filter variants emit everywhere; and the PCSS blocker
//! search gathers the shadow map through the non-filtering `point_sampler` in core, in the forward
//! pass and the Level-2 v2 prelude alike.
//!
//! RQ5.0: the previous-model table is parallel to the instance table (`Instance` keeps its 160
//! bytes; `PrevModel` is its own 80-byte row), the TAA and FSR1 rows (`TaaParams`, `EasuParams`,
//! `RcasParams`) equal naga's layout, the RQ5 stub shaders (TAA, reactive coverage, EASU, RCAS)
//! validate against core and emit on every back end, every RQ5 target (motion, reactive mask, TAA
//! history, the upscaler's intermediates) is one core guarantees, and the RQ5 nodes stay unlanded:
//! asking for TAA or FSR1 changes no node and no projection, so the picture is unchanged.
//!
//! RQ6.0: the local-light table keeps its 32-byte row with a parallel extension row (`LightExt`:
//! cone, kind, shadow slot) and the material table its 48-byte row with the v2 `GxMaterialExt`
//! beside it; the light-bin header (`LightBinParams`) equals naga's layout; the WGSL light, z-bin
//! and texture-reference constants are the Rust ones; the forward frame layout binds the light
//! and material-extension tables under the v2 map's names and types plus the larger material
//! size classes' arrays, and with every RQ4 effect slot added its fragment stage stays at 14
//! sampled textures (two below core's 16) and within core's storage-buffer, uniform and sampler
//! limits; the RQ6 stub shaders validate against core and emit everywhere; and the RQ6 nodes stay
//! unlanded, so the picture is unchanged.

use genex_render::abi::{
    BindingKind, CUSTOM_PASS_API_VERSION, CUSTOM_PASS_APIS, CUSTOM_PASS_STAGES, EXTENSION_API_VERSION, EXTENSION_APIS, FORWARD_FRAGMENT_TEXTURES_MAX,
    FORWARD_EXTRA_MATERIAL_ARRAYS_MAX, GAME_GROUP, GAME_SAMPLERS_MAX, GAME_TEXTURES_MAX, GX_FRAME_V1_BYTES, GX_FRAME_V2_BYTES, GX_INSTANCE_V1_BYTES,
    GX_MATERIAL_V1_BYTES, GxFrameV1, L2_V2_SAMPLED_TEXTURES_MAX, L2_V2_SAMPLERS_MAX, L2_V2_STORAGE_BUFFERS_MAX, MATERIAL_V2_BINDINGS,
    NeutralInputs, POST_V2_BINDINGS, StageCounts, V2_STRUCTS, V2Binding, layout_entries,
};
use genex_render::custom_pass::TABLES_WGSL;
use genex_render::layout::{
    COMPUTE_STORAGE_FORMATS, FRAGMENT_WRITTEN_FORMATS, FRAME_EFFECT_BINDINGS, FRAME_EFFECT_BOUND, FRAME_ENV_BINDINGS, GPU_STRUCTS, MESHLET_DRAW_BINDINGS, MESHLET_DRAW_GROUP,
    STORAGE_TEXTURES_PER_STAGE_MAX, StorageRule, WORKGROUP_SHARED_BYTES_MAX,
};
use genex_render::shaders::{DEPTH_WRITING_VERTEX_ENTRIES, MATERIAL_V2_PRELUDE, POST_V2_PRELUDE, SHADERS};
use naga::back::{hlsl, msl, spv};
use naga::proc::Layouter;
use naga::valid::{Capabilities, ModuleInfo, ValidationFlags, Validator};

/// The golden sizes in bytes. Changing one is a layout change for every shader and extension.
const GOLDEN: [(&str, usize); 35] = [
    // RQ5.6 flipped 752 -> 768: the camera's TAA jitter lane (`GpuFrame::jitter`). Pass 2's
    // contracts wave flipped 768 -> 784: each cascade's comparison bias (`GpuFrame::cascade_bias`).
    // P2-0.8b (T-06) flipped 784 -> 800: the frame's texture mip bias (`GpuFrame::texture_lod`).
    ("FrameUniforms", 800),
    ("Light", 32),
    ("Instance", 160),
    ("Material", 48),
    // Pass 2 A6.9 flipped 32 -> 36: each batch's first instance row (`GpuBatch::first_row`, a level's
    // batch has slots of its own over its mesh's rows) beside its level of detail (`lod`).
    ("Batch", 36),
    // Game systems LOD-02 added the LOD row (cull binding 6): the sphere an instance's levels are
    // measured from, its bias, its far rule and two spare words.
    ("LodRow", 32),
    ("PassView", 16),
    // Pass 2 A6.9 flipped 880 -> 912: the levels of detail's view (`GpuCullViews::lod`, `lod_params`);
    // lane FQ flipped 912 -> 928: each sun cascade's caster error (`GpuCullViews::shadow_lod`).
    // AAA review WP-15 flipped 928 -> 2080: twelve more cull views (two point lights' faces).
    ("CullViews", 2080),
    ("DrawIndexedArgs", 20),
    ("MeshVertex", 48),
    ("SkinVertex", 32),
    ("SkinJob", 32),
    ("BlitParams", 32),
    ("ExposureState", 16),
    ("GxEnvSh", 144),
    ("IblBake", 64),
    ("SkyAtmosphere", 144),
    ("GxFog", 32),
    ("BloomParams", 48),
    ("AoParams", 80),
    ("ContactShadowParams", 64),
    ("Meshlet", 48),
    ("MeshletInstance", 16),
    ("DrawnMeshlet", 8),
    ("MeshletCull", 64),
    ("HizParams", 32),
    ("PrevModel", 80),
    // RQ5 review flipped 64 -> 128 (named in the log): the camera reprojection TAA's disocclusion
    // test reads (`reproject`, a mat4x4).
    ("TaaParams", 128),
    // G0 (2026-10-15) flipped 16 -> 32 (named in the log): the reactive coverage's motion row (the
    // render size and whether a moved mesh writes its share of the cap by its motion).
    ("ReactiveJitter", 32),
    ("EasuParams", 64),
    ("RcasParams", 32),
    ("LightExt", 32),
    // Renderer pass 2 B.1 flipped 32 -> 64: the subsurface scatter colour and thickness, and the
    // forward-scatter power, diffuse transmission and scattering depth (two rows).
    // Bodycam B2b flipped 64 -> 96: the UV mapping row (scale, offset) and the tiling row (world
    // projection and stochastic flags, rotation, macro variation).
    ("GxMaterialExt", 96),
    // Renderer pass 2 A.0 (LG-16) flipped 32 -> 64: the clusterable kinds' index ranges and the
    // decals' and probes' own depth mappings (lights, decals and probes share one index space).
    ("LightBinParams", 64),
    // Pass 2's contracts wave: the tonemap's uniform joins the table at 128 bytes, its white
    // balance a 3x3 matrix (three 16-byte columns) where the gains row was (96 before). P2-0.10
    // flipped 128 -> 144: AgX punchy's curve row (Godot's AgX, contrast, toe, slope and w). A.2
    // flipped 144 -> 256: grading's seven rows (global knobs, ranges, five per-section knobs).
    ("GxTonemapParams", 288),
];

fn parse(name: &str, source: &str) -> naga::Module {
    naga::front::wgsl::parse_str(source).unwrap_or_else(|error| panic!("{name}: {}", error.emit_to_string(source)))
}

#[test]
fn every_renderer_shader_validates_against_webgpu_core() {
    assert!(!SHADERS.is_empty());
    for (name, source) in SHADERS {
        let module = parse(name, source);
        // WebGPU core's cube arrays (renderer pass 2 A.3: the forward pass's probe array).
        Validator::new(ValidationFlags::all(), Capabilities::CUBE_ARRAY_TEXTURES)
            .validate(&module)
            .unwrap_or_else(|error| panic!("{name} needs more than WebGPU core: {error:?}"));
    }
}

/// The float literals of `source` (comments dropped) whose value lies outside f32's finite range:
/// a shader-creation error under the WGSL spec that Chromium's Tint applies and naga does not
/// (naga rounds `3.40282347e38` to `f32::MAX`; Tint refuses the module, so every pipeline built
/// from it is invalid and the browser frame draws nothing).
fn f32_overflowing_literals(source: &str) -> Vec<String> {
    let text = genex_render::shaders::minify::minify(source);
    let bytes = text.as_bytes();
    let mut found = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        let starts_number = bytes[at].is_ascii_digit() || (bytes[at] == b'.' && bytes.get(at + 1).is_some_and(u8::is_ascii_digit));
        let inside_word = at > 0 && (bytes[at - 1].is_ascii_alphanumeric() || bytes[at - 1] == b'_');
        if !starts_number || inside_word {
            at += 1;
            continue;
        }
        let (end, value) = literal_at(bytes, at);
        if value.is_some_and(|value| value.abs() > f64::from(f32::MAX)) {
            found.push(text[at..end].to_owned());
        }
        at = end.max(at + 1);
    }
    found
}

/// The end of the numeric literal starting at `at` and its value when it is an f32 or abstract
/// float literal (`None` for integers and f16).
fn literal_at(bytes: &[u8], at: usize) -> (usize, Option<f64>) {
    let hex = bytes[at] == b'0' && matches!(bytes.get(at + 1), Some(b'x' | b'X'));
    let (digits_end, value) = if hex { hex_float_at(bytes, at + 2) } else { decimal_float_at(bytes, at) };
    match bytes.get(digits_end) {
        Some(b'f') => (digits_end + 1, value.or_else(|| std::str::from_utf8(&bytes[at..digits_end]).ok()?.parse().ok())),
        Some(b'h' | b'i' | b'u') => (digits_end + 1, None),
        _ => (digits_end, value),
    }
}

/// A decimal literal's end and, when it has a point or an exponent, its value.
fn decimal_float_at(bytes: &[u8], at: usize) -> (usize, Option<f64>) {
    let mut end = at;
    let mut float = false;
    while end < bytes.len() && (bytes[end].is_ascii_digit() || bytes[end] == b'.') {
        float |= bytes[end] == b'.';
        end += 1;
    }
    if matches!(bytes.get(end), Some(b'e' | b'E')) {
        float = true;
        end += 1;
        if matches!(bytes.get(end), Some(b'+' | b'-')) {
            end += 1;
        }
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
    }
    let text = std::str::from_utf8(&bytes[at..end]).unwrap_or_default();
    (end, if float { text.parse().ok() } else { None })
}

/// A hexadecimal literal's end (after `0x`) and, when it has a binary exponent, its value.
fn hex_float_at(bytes: &[u8], at: usize) -> (usize, Option<f64>) {
    let mut end = at;
    let mut mantissa = 0.0_f64;
    let mut fraction_digits = 0_i32;
    let mut after_point = false;
    while let Some(&byte) = bytes.get(end) {
        if byte == b'.' {
            after_point = true;
        } else if let Some(digit) = char::from(byte).to_digit(16) {
            mantissa = mantissa * 16.0 + f64::from(digit);
            fraction_digits += i32::from(after_point);
        } else {
            break;
        }
        end += 1;
    }
    if !matches!(bytes.get(end), Some(b'p' | b'P')) {
        return (end, None);
    }
    end += 1;
    let exponent_start = end;
    if matches!(bytes.get(end), Some(b'+' | b'-')) {
        end += 1;
    }
    while end < bytes.len() && bytes[end].is_ascii_digit() {
        end += 1;
    }
    let exponent: i32 = std::str::from_utf8(&bytes[exponent_start..end]).ok().and_then(|text| text.parse().ok()).unwrap_or(0);
    (end, Some(mantissa * 2f64.powi(exponent - 4 * fraction_digits)))
}

#[test]
fn the_literal_scan_finds_what_tint_refuses_and_passes_what_it_accepts() {
    assert_eq!(f32_overflowing_literals("let a = 3.40282347e38; // 1e39 in a comment"), vec!["3.40282347e38"]);
    assert_eq!(f32_overflowing_literals("let b = -1e39f; let c = 4e38;"), vec!["1e39f", "4e38"]);
    assert!(f32_overflowing_literals("let d = 0x1.fffffep+127f; let e = 3.4e38; let f = 340282346638528859811704183484516925440.0;").is_empty());
    assert_eq!(f32_overflowing_literals("let g = 0x1p+128f;"), vec!["0x1p+128f"]);
    assert!(f32_overflowing_literals("let h = 4294967295u; let v1e39 = vec2<f32>(1.0, 2.5e-3); let i = 0xffffffffu;").is_empty());
    // The spelling the shaders use for f32::MAX is exactly it.
    assert_eq!(literal_at(b"0x1.fffffep+127f", 0), (16, Some(f64::from(f32::MAX))));
}

#[test]
fn every_renderer_shader_keeps_its_float_literals_in_f32_range() {
    let unregistered = [("light-bin", genex_render::cluster::LIGHT_BIN)];
    for (name, source) in SHADERS.iter().chain(&unregistered) {
        let overflowing = f32_overflowing_literals(source);
        assert!(overflowing.is_empty(), "{name}: {overflowing:?} lie outside f32's range; Tint refuses the module (write f32::MAX as 0x1.fffffep+127f)");
    }
}

#[test]
fn rust_struct_sizes_equal_the_golden_table_in_this_build() {
    let sizes: Vec<(&str, usize)> = GPU_STRUCTS.iter().map(|s| (s.wgsl, s.rust_size)).collect();
    assert_eq!(sizes, GOLDEN.to_vec(), "rapier in graph: {}", cfg!(feature = "rapier-layout-check"));
    for gpu in GPU_STRUCTS {
        assert!(gpu.rust_align <= 4, "{} holds no glam-aligned field (align {})", gpu.wgsl, gpu.rust_align);
    }
}

#[test]
fn rust_struct_sizes_equal_the_wgsl_struct_sizes_naga_computes() {
    for gpu in GPU_STRUCTS {
        let mut found = 0;
        let sources = SHADERS.iter().map(|(name, source)| (*name, (*source).to_owned())).chain(rq5_shaders());
        for (shader, source) in sources {
            let module = parse(shader, &source);
            let mut layouter = Layouter::default();
            layouter.update(module.to_ctx()).expect("layout");
            for (handle, ty) in module.types.iter() {
                if ty.name.as_deref() == Some(gpu.wgsl) {
                    assert_eq!(layouter[handle].size as usize, gpu.rust_size, "{} in {shader}", gpu.wgsl);
                    found += 1;
                }
            }
        }
        assert!(found > 0, "{} is declared by some shader", gpu.wgsl);
    }
}

/// The `override` values each shader's pipelines pass, by shader name: every shader is emitted
/// with its defaults, then once per listed variant. A tier that adds an `override` lists its
/// pipeline values here (wave 0 of that tier owns this file).
const OVERRIDE_VARIANTS: &[(&str, &[Variant])] = &[
    (
        "tonemap",
        // `GX_TONEMAPPER` is `Tonemapper::shader_id`: khronos-neutral 0, agx 1, aces 2, none 3, agx-punchy 4.
        // `GX_GRADING` is `ShaderGrading::shader_id` (A.2): 1 parametric, 2 the LUT, 3 both.
        &[
            &[("GX_TONEMAPPER", 1.0)],
            &[("GX_TONEMAPPER", 2.0)],
            &[("GX_TONEMAPPER", 3.0)],
            &[("GX_TONEMAPPER", 4.0)],
            &[("GX_GRADING", 1.0)],
            &[("GX_GRADING", 2.0)],
            &[("GX_GRADING", 3.0), ("GX_TONEMAPPER", 4.0)],
        ],
    ),
    // The HDR scene's pipelines (`GX_SCENE_HDR`): the legacy scene's are the default. The sun
    // chunk's filters (`GX_SHADOW_FILTER`, `ShadowFilter::shader_id`): 3x3 PCF is the default.
    (
        "forward",
        &[
            &[("GX_SCENE_HDR", 1.0)],
            &[("GX_SHADOW_FILTER", 0.0)],
            &[("GX_SHADOW_FILTER", 2.0)],
            &[("GX_SHADOW_FILTER", 3.0)],
            &[("GX_SHADOW_FILTER", 4.0), ("GX_SCENE_HDR", 1.0)],
            // Pass 2's contracts wave (stage 0): the transparent pipeline's static shadow kernel
            // (`GX_SHADOW_TEMPORAL` off beside TAA's soft filter), the roughness floor a class sets
            // (desktop's sun disc, phones'), the rg11b10 scene's dither and the LOD crossfade.
            &[("GX_SHADOW_FILTER", 4.0), ("GX_SHADOW_TEMPORAL", 0.0), ("GX_SCENE_HDR", 1.0)],
            &[("GX_ROUGHNESS_FLOOR", 0.045), ("GX_SCENE_HDR", 1.0)],
            &[("GX_ROUGHNESS_FLOOR", 0.089), ("GX_SCENE_RG11B10", 1.0), ("GX_SCENE_HDR", 1.0)],
            &[("GX_LOD_FADE", 1.0), ("GX_SCENE_HDR", 1.0)],
        ],
    ),
    ("lines", &[&[("GX_SCENE_HDR", 1.0)]]),
    ("prepass", &[&[("GX_LOD_FADE", 1.0)]]),
    ("shadow", &[&[("GX_LOD_FADE", 1.0)]]),
];

/// One pipeline's `override` values: (name, value) pairs.
type Variant = &'static [(&'static str, f64)];

/// HLSL shader model 5.1: FXC, which a Windows game compiles with (`gpu.rs`).
const HLSL_SHADER_MODEL: hlsl::ShaderModel = hlsl::ShaderModel::V5_1;
/// MSL 2.4: the language the iOS 16 and macOS floor devices take.
const MSL_VERSION: (u8, u8) = (2, 4);
/// SPIR-V 1.3: what a Vulkan 1.1 device (the Android floor) takes.
const SPIRV_VERSION: (u8, u8) = (1, 3);

fn variants_of(shader: &str) -> Vec<Variant> {
    let listed = OVERRIDE_VARIANTS.iter().filter(|(name, _)| *name == shader).flat_map(|(_, variants)| variants.iter().copied());
    std::iter::once(&[][..]).chain(listed).collect()
}

fn validated(name: &str, module: &naga::Module) -> ModuleInfo {
    // WebGPU core's cube arrays (renderer pass 2 A.3: the forward pass's probe array).
    Validator::new(ValidationFlags::all(), Capabilities::CUBE_ARRAY_TEXTURES)
        .validate(module)
        .unwrap_or_else(|error| panic!("{name} needs more than WebGPU core: {error:?}"))
}

/// Emit `module` (overrides resolved with `variant`) through the HLSL, MSL and SPIR-V writers.
fn emit(name: &str, module: &naga::Module, info: &ModuleInfo, variant: &[(&str, f64)]) {
    let constants: naga::back::PipelineConstants = variant.iter().map(|(key, value)| ((*key).to_owned(), *value)).collect();
    let (module, info) = naga::back::pipeline_constants::process_overrides(module, info, None, &constants)
        .unwrap_or_else(|error| panic!("{name} {variant:?}: overrides: {error:?}"));
    let mut hlsl_source = String::new();
    let hlsl_options = hlsl::Options { shader_model: HLSL_SHADER_MODEL, ..Default::default() };
    hlsl::Writer::new(&mut hlsl_source, &hlsl_options, &hlsl::PipelineOptions::default())
        .write(&module, &info, None)
        .unwrap_or_else(|error| panic!("{name} {variant:?}: HLSL SM 5.1: {error:?}"));
    assert!(!hlsl_source.is_empty(), "{name}: HLSL written");
    let msl_options = msl::Options { lang_version: MSL_VERSION, ..Default::default() };
    let (msl_source, _) = msl::write_string(&module, &info, &msl_options, &msl::PipelineOptions::default())
        .unwrap_or_else(|error| panic!("{name} {variant:?}: MSL 2.4: {error:?}"));
    assert!(!msl_source.is_empty(), "{name}: MSL written");
    let spv_options = spv::Options { lang_version: SPIRV_VERSION, ..Default::default() };
    let words = spv::write_vec(&module, &info, &spv_options, None).unwrap_or_else(|error| panic!("{name} {variant:?}: SPIR-V 1.3: {error:?}"));
    assert!(!words.is_empty(), "{name}: SPIR-V written");
}

#[test]
fn every_renderer_shader_and_variant_emits_hlsl_msl_and_spirv() {
    for (name, _) in OVERRIDE_VARIANTS {
        assert!(SHADERS.iter().any(|(shader, _)| shader == name), "override variants listed for unknown shader {name}");
    }
    for (name, source) in SHADERS {
        let module = parse(name, source);
        let info = validated(name, &module);
        for variant in variants_of(name) {
            emit(name, &module, &info, variant);
        }
    }
}

#[test]
fn the_published_v1_tables_are_the_frozen_abi_rows() {
    let module = parse("tables", &format!("{TABLES_WGSL}\n@compute @workgroup_size(1) fn main() {{}}"));
    let mut layouter = Layouter::default();
    layouter.update(module.to_ctx()).expect("layout");
    let size_of_wgsl = |wanted: &str| {
        let (handle, _) = module.types.iter().find(|(_, ty)| ty.name.as_deref() == Some(wanted)).unwrap_or_else(|| panic!("{wanted} declared"));
        u64::from(layouter[handle].size)
    };
    assert_eq!(size_of_wgsl("GxFrame"), GX_FRAME_V1_BYTES);
    assert_eq!(size_of::<GxFrameV1>() as u64, GX_FRAME_V1_BYTES);
    assert_eq!(size_of_wgsl("GxInstance"), GX_INSTANCE_V1_BYTES);
    assert_eq!(size_of_wgsl("GxMaterial"), GX_MATERIAL_V1_BYTES);
}

// ---------------------------------------------------------------------------------------------
// The v2 ABI (RQ1.0)

fn shader(name: &str) -> &'static str {
    SHADERS.iter().find(|(shader, _)| *shader == name).map(|(_, source)| *source).unwrap_or_else(|| panic!("{name} is in SHADERS"))
}

/// Each member of the WGSL struct `wanted` in `module`: (name, byte offset), and its size.
fn wgsl_members(module: &naga::Module, wanted: &str) -> (Vec<(String, usize)>, usize) {
    let mut layouter = Layouter::default();
    layouter.update(module.to_ctx()).expect("layout");
    let (handle, ty) = module.types.iter().find(|(_, ty)| ty.name.as_deref() == Some(wanted)).unwrap_or_else(|| panic!("{wanted} declared"));
    let naga::TypeInner::Struct { members, span } = &ty.inner else { panic!("{wanted} is a struct") };
    assert_eq!(*span, layouter[handle].size, "{wanted}");
    let named = members.iter().map(|member| (member.name.clone().unwrap_or_default(), member.offset as usize)).collect();
    (named, *span as usize)
}

#[test]
fn every_v2_struct_equals_nagas_layout_member_for_member() {
    for v2 in V2_STRUCTS {
        let module = parse(v2.shader, shader(v2.shader));
        let (members, size) = wgsl_members(&module, v2.wgsl);
        assert_eq!(size, v2.rust_size, "{} size", v2.wgsl);
        let rust: Vec<(String, usize)> = v2.fields.iter().map(|(name, offset)| ((*name).to_owned(), *offset)).collect();
        assert_eq!(members, rust, "{} members and offsets", v2.wgsl);
        assert!(v2.rust_align <= 4, "{} holds no glam-aligned field", v2.wgsl);
    }
    let frame = V2_STRUCTS.iter().find(|v2| v2.wgsl == "GxFrameV2").expect("GxFrameV2 is published");
    assert_eq!(frame.rust_size as u64, GX_FRAME_V2_BYTES);
    for wanted in ["pre_exposure", "depth_reversed", "prev_view_proj", "inv_view_proj", "jitter", "frame_index", "time"] {
        assert!(frame.fields.iter().any(|(name, _)| *name == wanted), "GxFrameV2 carries {wanted}");
    }
    let post = V2_STRUCTS.iter().find(|v2| v2.wgsl == "GxPostV2").expect("GxPostV2 is published");
    assert!(post.fields.iter().any(|(name, _)| *name == "depth_reversed"), "GxPostV2 carries depth_reversed");
}

#[test]
fn the_pre_exposure_can_be_copied_from_the_exposure_buffer_into_the_frame() {
    let offset = genex_render::abi::GX_FRAME_V2_PRE_EXPOSURE_OFFSET;
    let frame = V2_STRUCTS.iter().find(|v2| v2.wgsl == "GxFrameV2").expect("GxFrameV2");
    assert_eq!(frame.fields.iter().find(|(name, _)| *name == "pre_exposure").map(|(_, at)| *at as u64), Some(offset));
    assert!(offset.is_multiple_of(wgpu::COPY_BUFFER_ALIGNMENT), "copy_buffer_to_buffer lands it");
}

/// What a naga global binds, as the v2 map spells it.
fn kind_of(module: &naga::Module, global: &naga::GlobalVariable) -> BindingKind {
    use naga::{AddressSpace, ImageClass, ImageDimension, TypeInner};
    match (&global.space, &module.types[global.ty].inner) {
        (AddressSpace::Uniform, _) => BindingKind::Uniform,
        (AddressSpace::Storage { .. }, _) => BindingKind::Storage,
        (_, TypeInner::Sampler { comparison: true }) => BindingKind::ComparisonSampler,
        (_, TypeInner::Sampler { comparison: false }) => BindingKind::Sampler,
        (_, TypeInner::Image { dim, arrayed, class }) => match (dim, arrayed, class) {
            (ImageDimension::D2, false, ImageClass::Depth { multi: false }) => BindingKind::Depth2d,
            (ImageDimension::D2, true, ImageClass::Depth { multi: false }) => BindingKind::DepthArray,
            (ImageDimension::D2, false, ImageClass::Sampled { multi: false, .. }) => BindingKind::Texture2d,
            (ImageDimension::D2, true, ImageClass::Sampled { multi: false, .. }) => BindingKind::Texture2dArray,
            (ImageDimension::Cube, false, ImageClass::Sampled { .. }) => BindingKind::TextureCube,
            // The forward pass's reflection-probe array (renderer pass 2 A.3): no v2 kind (the v2
            // map keeps the cube); one sampled texture, counted as the cube it replaced.
            (ImageDimension::Cube, true, ImageClass::Sampled { .. }) => BindingKind::TextureCube,
            (ImageDimension::D3, false, ImageClass::Sampled { .. }) => BindingKind::Texture3d,
            other => panic!("no v2 binding kind for {other:?}"),
        },
        other => panic!("no v2 binding kind for {other:?}"),
    }
}

/// Every bound global of `module` in groups other than the game's: (group, binding, name, kind).
fn declared(module: &naga::Module) -> Vec<(u32, u32, String, BindingKind)> {
    let mut rows: Vec<(u32, u32, String, BindingKind)> = module
        .global_variables
        .iter()
        .filter_map(|(_, global)| global.binding.as_ref().map(|at| (at.group, at.binding, global.name.clone().unwrap_or_default(), kind_of(module, global))))
        .filter(|(group, ..)| *group != GAME_GROUP)
        .collect();
    rows.sort();
    rows
}

fn reserved(table: &[V2Binding]) -> Vec<(u32, u32, String, BindingKind)> {
    let mut rows: Vec<(u32, u32, String, BindingKind)> = table.iter().map(|row| (row.group, row.binding, row.name.to_owned(), row.kind.as_declared())).collect();
    rows.sort();
    rows
}

#[test]
fn both_v2_preludes_declare_exactly_the_reserved_group_map() {
    for (name, table) in [("material-v2-sample", MATERIAL_V2_BINDINGS), ("post-v2-sample", POST_V2_BINDINGS)] {
        let module = parse(name, shader(name));
        validated(name, &module);
        assert_eq!(declared(&module), reserved(table), "{name} declares the v2 map");
        for row in table {
            assert!(row.group < GAME_GROUP, "{}: the renderer's groups are 0 and 1; 2 is the game's, 3 reserved", row.name);
        }
    }
    let functions = |source: &str| -> Vec<String> { parse("v2", source).functions.iter().filter_map(|(_, f)| f.name.clone()).collect() };
    let material = functions(&format!("{MATERIAL_V2_PRELUDE}\n@fragment fn fs_material(in: GxMaterialInV2) -> @location(0) vec4<f32> {{ return vec4<f32>(0.0); }}"));
    for helper in ["gx_shade_pbr", "gx_apply_fog", "gx_expose", "gx_surface_v2", "gx_linear_depth"] {
        assert!(material.iter().any(|f| f == helper), "material v2 offers {helper}");
    }
    let post = functions(&format!("{POST_V2_PRELUDE}\n@fragment fn fs_post(in: GxPostInV2) -> @location(0) vec4<f32> {{ return vec4<f32>(0.0); }}"));
    for helper in ["gx_linear_depth", "gx_scene_uv", "gx_expose"] {
        assert!(post.iter().any(|f| f == helper), "post v2 offers {helper}");
    }
}

/// The per-stage counts of a module's globals in every group (the game's included).
fn counts_in(module: &naga::Module) -> StageCounts {
    let mut counts = StageCounts::default();
    for (_, global) in module.global_variables.iter().filter(|(_, global)| global.binding.is_some()) {
        counts.add(kind_of(module, global));
    }
    counts
}

/// The counts of the bound globals that `stage`'s entry points of `module` use (`info` from
/// [`validated`]): what WebGPU's per-stage limits apply to, unlike [`counts_in`]'s declarations.
fn stage_counts_in(module: &naga::Module, info: &ModuleInfo, stage: naga::ShaderStage) -> StageCounts {
    let entries: Vec<usize> = module.entry_points.iter().enumerate().filter(|(_, entry)| entry.stage == stage).map(|(index, _)| index).collect();
    let mut counts = StageCounts::default();
    for (handle, global) in module.global_variables.iter().filter(|(_, global)| global.binding.is_some()) {
        if entries.iter().any(|index| !info.get_entry_point(*index)[handle].is_empty()) {
            counts.add(kind_of(module, global));
        }
    }
    counts
}

/// A game's v2 source using the whole of group 2: one uniform, four textures, two samplers.
const GAME_GROUP_FULL: &str = "
struct GameParams { tint: vec4<f32> }
@group(2) @binding(0) var<uniform> params: GameParams;
@group(2) @binding(1) var tex_a: texture_2d<f32>;
@group(2) @binding(2) var tex_b: texture_2d<f32>;
@group(2) @binding(3) var tex_c: texture_2d<f32>;
@group(2) @binding(4) var tex_d: texture_2d<f32>;
@group(2) @binding(5) var smp_a: sampler;
@group(2) @binding(6) var smp_b: sampler;
";

#[test]
fn the_v2_group_map_with_a_full_game_group_fits_webgpu_core() {
    let core = wgpu::Limits::defaults();
    assert!(L2_V2_SAMPLED_TEXTURES_MAX <= core.max_sampled_textures_per_shader_stage);
    assert!(L2_V2_SAMPLERS_MAX <= core.max_samplers_per_shader_stage);
    assert!(L2_V2_STORAGE_BUFFERS_MAX <= core.max_storage_buffers_per_shader_stage);
    assert_eq!((L2_V2_SAMPLED_TEXTURES_MAX, L2_V2_SAMPLERS_MAX, L2_V2_STORAGE_BUFFERS_MAX), (12, 16, 8));
    let tail = [
        ("material", MATERIAL_V2_PRELUDE, "@fragment fn fs_material(in: GxMaterialInV2) -> @location(0) vec4<f32> { return params.tint + textureSample(tex_a, smp_a, in.uv) + textureSample(tex_b, smp_b, in.uv) + textureSample(tex_c, smp_a, in.uv) + textureSample(tex_d, smp_a, in.uv); }"),
        ("post", POST_V2_PRELUDE, "@fragment fn fs_post(in: GxPostInV2) -> @location(0) vec4<f32> { return params.tint + textureSample(tex_a, smp_a, in.uv) + textureSample(tex_b, smp_b, in.uv) + textureSample(tex_c, smp_a, in.uv) + textureSample(tex_d, smp_a, in.uv); }"),
    ];
    for (name, prelude, fragment) in tail {
        let source = format!("{prelude}\n{GAME_GROUP_FULL}\n{fragment}");
        let module = parse(name, &source);
        validated(name, &module);
        let counts = counts_in(&module);
        assert!(counts.sampled_textures <= L2_V2_SAMPLED_TEXTURES_MAX, "{name}: {counts:?}");
        assert!(counts.samplers <= L2_V2_SAMPLERS_MAX, "{name}: {counts:?}");
        assert!(counts.storage_buffers <= L2_V2_STORAGE_BUFFERS_MAX, "{name}: {counts:?}");
        assert!(counts.uniform_buffers <= core.max_uniform_buffers_per_shader_stage, "{name}: {counts:?}");
        let groups = module.global_variables.iter().filter_map(|(_, global)| global.binding.as_ref().map(|at| at.group)).max().unwrap_or(0);
        assert!(groups < core.max_bind_groups, "{name} binds groups 0..={groups}");
    }
    for (name, table) in [("material", MATERIAL_V2_BINDINGS), ("post", POST_V2_BINDINGS)] {
        let reserved = StageCounts::of(table).with_game_group();
        assert!(reserved.sampled_textures <= L2_V2_SAMPLED_TEXTURES_MAX, "{name} map: {reserved:?}");
        assert!(reserved.samplers <= L2_V2_SAMPLERS_MAX, "{name} map: {reserved:?}");
        assert!(reserved.storage_buffers <= L2_V2_STORAGE_BUFFERS_MAX, "{name} map: {reserved:?}");
    }
    assert_eq!((GAME_TEXTURES_MAX, GAME_SAMPLERS_MAX), (4, 2));
}

// Renderer pass 2 A.4 renamed this row (was `..._stays_within_fourteen_sampled_textures`) and
// flipped the cap 14 -> 16: owner decision D1 gives the forward stage all of core's 16 (the
// irradiance volumes' atlas the 15th, A.6's screen reflections the 16th).
#[test]
fn the_internal_forward_fragment_stage_stays_within_sixteen_sampled_textures() {
    let forward = counts_in(&parse("forward", shader("forward")));
    assert!(forward.sampled_textures <= FORWARD_FRAGMENT_TEXTURES_MAX, "today's forward: {forward:?}");
    // The forward pass binds the renderer's group 0 (its two material arrays included) plus the
    // extra material arrays reserved for texture size classes.
    let group_zero = StageCounts::of(MATERIAL_V2_BINDINGS).sampled_textures;
    assert!(group_zero + FORWARD_EXTRA_MATERIAL_ARRAYS_MAX <= FORWARD_FRAGMENT_TEXTURES_MAX);
    assert_eq!(FORWARD_FRAGMENT_TEXTURES_MAX, 16);
}

#[test]
fn the_extension_and_custom_pass_apis_serve_v1_and_v2() {
    assert_eq!((EXTENSION_API_VERSION, CUSTOM_PASS_API_VERSION), (2, 2));
    assert_eq!((EXTENSION_APIS, CUSTOM_PASS_APIS), ([1, 2], [1, 2]));
    assert_eq!(genex_render::EXTENSION_API_VERSION, EXTENSION_API_VERSION);
    assert_eq!(genex_render::CUSTOM_PASS_API_VERSION, CUSTOM_PASS_API_VERSION);
}

#[test]
fn the_custom_pass_stage_ids_are_the_hosts_and_frame_graph_nodes() {
    let fixture = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../tests/fixtures/native-wire-v2.json")).expect("wire fixture");
    let wire: serde_json::Value = serde_json::from_str(&fixture).expect("json");
    use genex_render::custom_pass::PassStage;
    use genex_render::graph::{FRAME_GRAPH, NodeId};
    let stages: Vec<&str> = wire["customPassStages"].as_array().expect("customPassStages").iter().filter_map(|v| v.as_str()).collect();
    let vocabulary: Vec<&str> = PassStage::VOCABULARY.iter().map(|stage| stage.wire()).collect();
    assert_eq!(stages, vocabulary, "the host's CustomPassStage, in vocabulary order (after-prepass included, RQ4.0)");
    assert_eq!(wire["extensionApis"], serde_json::json!(EXTENSION_APIS));
    assert_eq!(wire["customPassApis"], serde_json::json!(CUSTOM_PASS_APIS));
    // The served stages are the vocabulary's prefix and what the receipt serves; v2 appended
    // `post-hdr` (graph node 18), RQ4 appends `after-prepass` (node 9), served once it lands.
    let served: Vec<&str> = PassStage::ALL.iter().map(|stage| stage.wire()).collect();
    assert_eq!(served, CUSTOM_PASS_STAGES, "the receipt's stages are the served ones");
    assert_eq!(vocabulary[..served.len()], served[..]);
    for stage in PassStage::VOCABULARY {
        assert_eq!(PassStage::from_wire(stage.wire()), Some(stage));
        assert!(FRAME_GRAPH.iter().any(|row| row.id == stage.node()), "stage {} is a graph row", stage.wire());
        assert_eq!(stage.served(), served.contains(&stage.wire()), "{}", stage.wire());
    }
    assert_eq!(PassStage::AfterPrepass.node(), NodeId::AfterPrepass);
    assert_eq!(genex_render::graph::spec(NodeId::AfterPrepass).wire, "after-prepass", "graph node 9");
    assert!(PassStage::AfterPrepass.v2_only() && !PassStage::AfterPrepass.in_world() && !PassStage::AfterPrepass.on_scene());
}

#[test]
fn layout_entries_follow_the_map_and_name_the_core_binding_types() {
    for table in [MATERIAL_V2_BINDINGS, POST_V2_BINDINGS] {
        for group in 0..GAME_GROUP {
            let entries = layout_entries(table, group);
            let rows: Vec<u32> = table.iter().filter(|row| row.group == group).map(|row| row.binding).collect();
            assert_eq!(entries.iter().map(|entry| entry.binding).collect::<Vec<u32>>(), rows);
            for entry in &entries {
                assert!(entry.count.is_none(), "no binding arrays (native-only)");
                if let wgpu::BindingType::StorageTexture { .. } = entry.ty {
                    panic!("the v2 map binds no storage textures in material or post stages");
                }
            }
        }
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_v2_preludes_build_pipelines_and_bind_neutral_inputs_on_a_core_device() {
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    let gpu = match genex_render::Gpu::headless() {
        Ok(gpu) => gpu,
        Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
        Err(error) => return eprintln!("skipped: no WebGPU-core adapter ({error})"),
    };
    let device = &gpu.device;
    let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let neutral = NeutralInputs::new(device, &gpu.queue);
    for (name, table, entry, format) in [
        ("material-v2-sample", MATERIAL_V2_BINDINGS, "fs_material", wgpu::TextureFormat::Rgba16Float),
        ("post-v2-sample", POST_V2_BINDINGS, "fs_post", wgpu::TextureFormat::Rgba16Float),
    ] {
        let layouts: Vec<wgpu::BindGroupLayout> = (0..=GAME_GROUP)
            .map(|group| device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some(name), entries: &layout_entries(table, group) }))
            .collect();
        let groups: Vec<wgpu::BindGroup> = (0..GAME_GROUP).map(|group| neutral.bind_group(device, table, group, &layouts[group as usize])).collect();
        assert_eq!(groups.len(), GAME_GROUP as usize);
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some(name), source: wgpu::ShaderSource::Wgsl(shader(name).into()) });
        let refs: Vec<Option<&wgpu::BindGroupLayout>> = layouts.iter().map(Some).collect();
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some(name), bind_group_layouts: &refs, immediate_size: 0 });
        let material = name.starts_with("material");
        let vertex_buffers = [Some(wgpu::VertexBufferLayout {
            array_stride: 32,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3, 2 => Float32x2],
        })];
        let _pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some(name),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module: &module,
                entry_point: Some(if material { "gx_vs_material_v2" } else { "gx_vs_post_v2" }),
                compilation_options: Default::default(),
                buffers: if material { &vertex_buffers } else { &[] },
            },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some(entry),
                compilation_options: Default::default(),
                targets: &[Some(format.into())],
            }),
            multiview_mask: None,
            cache: None,
        });
    }
    let error = pollster::block_on(scope.pop());
    assert!(error.is_none(), "{error:?}");
}

/// The LDR degrade reasons are spelled as the host's `degraded` reasons (the wire fixture). An
/// integration test, not a unit test: an engine's sources never read a build variable the lane
/// does not set for an ejected engine (`CARGO_MANIFEST_DIR` is a host path).
#[test]
fn the_ldr_degrade_reasons_spell_the_hosts_degrade_reasons() {
    let fixture = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../tests/fixtures/native-wire-v2.json")).expect("wire fixture");
    let wire: serde_json::Value = serde_json::from_str(&fixture).expect("json");
    let reasons: Vec<&str> = wire["render"]["degradeReasons"].as_array().expect("list").iter().filter_map(|v| v.as_str()).collect();
    for reason in genex_render::LdrReason::ALL {
        assert!(reasons.contains(&reason.wire()), "{}", reason.wire());
    }
}

// ---------------------------------------------------------------------------------------------
// The environment (RQ2.0)

#[test]
fn the_forward_frame_layout_binds_the_environment_under_the_v2_maps_names_and_types() {
    let module = parse("forward", shader("forward"));
    let declared = declared(&module);
    // Renderer pass 2 A.3 flips binding 11: the forward pass binds the reflection probes' cube
    // array there (`env_probes`, its layer 0 the sky's cube) while the v2 map keeps the cube; the
    // other environment inputs keep the v2 map's names and types.
    for (binding, name) in FRAME_ENV_BINDINGS.into_iter().filter(|(binding, _)| *binding != 11) {
        let v2 = MATERIAL_V2_BINDINGS.iter().find(|row| row.name == name).unwrap_or_else(|| panic!("the v2 map names {name}"));
        let row = declared.iter().find(|(group, at, ..)| (*group, *at) == (0, binding)).unwrap_or_else(|| panic!("forward binds group 0 binding {binding}"));
        assert_eq!((row.2.as_str(), row.3), (name, v2.kind.as_declared()), "forward binding {binding}");
    }
    for (binding, name) in genex_render::probes::FRAME_PROBE_BINDINGS {
        assert!(declared.iter().any(|(group, at, declared, _)| (*group, *at, declared.as_str()) == (0, binding, name)), "forward binds {name} at {binding}");
    }
    // The shared lighting chunks read the environment in both preludes: the SH9 evaluation and
    // the environment term compile against the forward bindings and the v2 material map alike.
    let functions: Vec<String> = module.functions.iter().filter_map(|(_, f)| f.name.clone()).collect();
    for helper in ["gx_env_irradiance", "gx_environment_light"] {
        assert!(functions.iter().any(|f| f == helper), "forward offers {helper}");
    }
}

#[test]
fn the_forward_frame_group_stays_within_webgpu_core_per_stage_limits() {
    let core = wgpu::Limits::defaults();
    let module = parse("forward", shader("forward"));
    let info = validated("forward", &module);
    let counts = counts_in(&module);
    // Declared: frame + env_sh + the pass view + the fog row; eight tables (five, the binned local
    // lights' extension rows and one light-bin table, RQ6.2 and pass 2 A.0 LG-16, which flipped
    // 9 -> 8 by merging the tile masks into the z-bin table, and the material extensions, RQ6.3);
    // shadow, two material arrays, env cube, BRDF LUT, the AO term, the aerial-perspective volume
    // and the contact-shadow mask (RQ4.6), and the larger size classes' six material arrays
    // (RQ6.7 flipped 8 -> 14: the forward pass samples them); shadow comparison, texture,
    // environment samplers and, since renderer pass 2 (P2-0.3, flipped 3 -> 4), the non-filtering
    // sampler PCSS's blocker search gathers the shadow map with (16 per stage in core).
    assert_eq!(
        (counts.uniform_buffers, counts.storage_buffers, counts.sampled_textures, counts.samplers),
        // Renderer pass 2 A.3 flipped 8 -> 9 storage buffers: the reflection probes' rows. A.4
        // flipped the sampled textures from the cap then (14) to 15 of the cap now (16): the
        // irradiance volumes' atlas at binding 32. The look pass (B.9's frame hook) flipped them
        // 15 -> 16, all of the cap: the screen reflections at binding 30. Game systems LOD-04
        // flipped 9 -> 10 storage buffers: the instance fade table at binding 31; LOD-18 flipped
        // 10 -> 11: the same table at the faded pipelines' group 1 binding 2 (their vertices'
        // far-field grow), which no other pipeline's layout holds.
        (4, 11, 16, 4),
        "{counts:?}"
    );
    // WebGPU's limits are per stage: the fragment stage reads five tables (materials, lights, the
    // light extensions, the one light-bin table and the material extensions; pass 2 A.0 LG-16
    // flipped 6 -> 5), the vertex stage the instance side.
    let fragment = stage_counts_in(&module, &info, naga::ShaderStage::Fragment);
    // Renderer pass 2 A.3 flipped 5 -> 6: the reflection probes' rows. Game systems LOD-04
    // flipped 6 -> 7: the instance fade table, read by the faded fragment entries alone.
    assert_eq!(fragment.storage_buffers, 7, "{fragment:?}");
    for stage in [naga::ShaderStage::Vertex, naga::ShaderStage::Fragment] {
        let used = stage_counts_in(&module, &info, stage);
        assert!(used.uniform_buffers <= core.max_uniform_buffers_per_shader_stage, "{stage:?}: {used:?}");
        assert!(used.storage_buffers <= core.max_storage_buffers_per_shader_stage, "{stage:?}: {used:?}");
        assert!(used.sampled_textures <= FORWARD_FRAGMENT_TEXTURES_MAX && FORWARD_FRAGMENT_TEXTURES_MAX <= core.max_sampled_textures_per_shader_stage, "{stage:?}: {used:?}");
        assert!(used.samplers <= core.max_samplers_per_shader_stage, "{stage:?}: {used:?}");
    }
    let highest = FRAME_ENV_BINDINGS.iter().map(|(binding, _)| *binding).max().unwrap_or(0);
    assert!(highest < core.max_bindings_per_bind_group, "binding {highest}");
}

/// Every storage texture `module` declares: (name, format, access).
fn storage_textures(module: &naga::Module) -> Vec<(String, naga::StorageFormat, naga::StorageAccess)> {
    module
        .global_variables
        .iter()
        .filter_map(|(_, global)| match module.types[global.ty].inner {
            naga::TypeInner::Image { class: naga::ImageClass::Storage { format, access }, .. } => Some((global.name.clone().unwrap_or_default(), format, access)),
            _ => None,
        })
        .collect()
}

/// The bytes of workgroup memory `module` declares.
fn workgroup_bytes(module: &naga::Module) -> u32 {
    let mut layouter = Layouter::default();
    layouter.update(module.to_ctx()).expect("layout");
    module.global_variables.iter().filter(|(_, global)| global.space == naga::AddressSpace::WorkGroup).map(|(_, global)| layouter[global.ty].size).sum()
}

fn naga_format(format: wgpu::TextureFormat) -> naga::StorageFormat {
    match format {
        wgpu::TextureFormat::Rgba16Float => naga::StorageFormat::Rgba16Float,
        wgpu::TextureFormat::R32Float => naga::StorageFormat::R32Float,
        wgpu::TextureFormat::Rgba8Unorm => naga::StorageFormat::Rgba8Unorm,
        other => panic!("no storage rule for {other:?}"),
    }
}

#[test]
fn the_format_rule_table_is_what_webgpu_core_guarantees() {
    let core = wgpu::Limits::defaults();
    assert!(STORAGE_TEXTURES_PER_STAGE_MAX <= core.max_storage_textures_per_shader_stage);
    assert!(WORKGROUP_SHARED_BYTES_MAX <= core.max_compute_workgroup_storage_size);
    assert_eq!((STORAGE_TEXTURES_PER_STAGE_MAX, WORKGROUP_SHARED_BYTES_MAX), (4, 16 * 1024));
    for (format, rule) in COMPUTE_STORAGE_FORMATS {
        let guaranteed = format.guaranteed_format_features(wgpu::Features::empty());
        assert!(guaranteed.allowed_usages.contains(wgpu::TextureUsages::STORAGE_BINDING), "{format:?} is storage in core");
        if *rule == StorageRule::ReadWrite {
            assert!(guaranteed.flags.contains(wgpu::TextureFormatFeatureFlags::STORAGE_READ_WRITE), "{format:?} is read-write in core");
        }
    }
    for (what, format) in FRAGMENT_WRITTEN_FORMATS {
        let guaranteed = format.guaranteed_format_features(wgpu::Features::empty());
        assert!(!guaranteed.allowed_usages.contains(wgpu::TextureUsages::STORAGE_BINDING), "{what}: {format:?} has no core storage, so a fragment pass writes it");
        assert!(guaranteed.allowed_usages.contains(wgpu::TextureUsages::RENDER_ATTACHMENT), "{what}: {format:?} is renderable in core");
    }
}

#[test]
fn every_renderer_shader_keeps_the_storage_and_workgroup_rules() {
    let mut computes = 0;
    for (name, source) in SHADERS {
        let module = parse(name, source);
        let storage = storage_textures(&module);
        assert!(storage.len() as u32 <= STORAGE_TEXTURES_PER_STAGE_MAX, "{name}: {storage:?}");
        for (texture, format, access) in &storage {
            let rule = COMPUTE_STORAGE_FORMATS
                .iter()
                .find(|(allowed, _)| naga_format(*allowed) == *format)
                .map(|(_, rule)| *rule)
                .unwrap_or_else(|| panic!("{name}: {texture} writes {format:?}, outside the format rules"));
            if rule == StorageRule::WriteOnly {
                assert_eq!(*access, naga::StorageAccess::STORE, "{name}: {texture} is write-only (ping-pong to read back)");
            }
        }
        assert!(workgroup_bytes(&module) <= WORKGROUP_SHARED_BYTES_MAX, "{name}: {} bytes of workgroup memory", workgroup_bytes(&module));
        computes += usize::from(module.entry_points.iter().any(|entry| entry.stage == naga::ShaderStage::Compute));
    }
    for stub in ["ibl-equirect", "ibl-prefilter", "ibl-sh9", "ibl-brdf-lut", "sky-transmittance", "sky-multiscatter", "sky-view", "sky-draw"] {
        assert!(SHADERS.iter().any(|(name, _)| *name == stub), "RQ2.0 registers {stub}");
    }
    let sh9 = parse("ibl-sh9", shader("ibl-sh9"));
    let threads: u32 = sh9.entry_points.iter().map(|entry| entry.workgroup_size.iter().product()).max().unwrap_or(0);
    assert!(threads <= genex_render::ibl::SH9_THREADS, "SH9 reduces in one workgroup of at most 64 threads: {threads}");
    assert!(computes >= 8, "every compute shader is checked: {computes}");
}

#[test]
fn every_pooled_target_is_one_webgpu_core_guarantees() {
    use genex_render::device_class::DeviceClass;
    use genex_render::presets::preset_quality;
    use genex_render::renderer::target_catalog;
    use genex_render::settings::{Quality, QualityPreset};
    use genex_render::target_pool::{TargetPolicy, validate, validate_with};
    let mut qualities = vec![Quality::off()];
    for class in DeviceClass::ALL {
        qualities.extend(QualityPreset::ALL.map(|preset| preset_quality(preset, class)));
    }
    for quality in &qualities {
        for policy in [TargetPolicy::new(None, true), TargetPolicy::new(Some(true), false)] {
            for samples in [1, 4] {
                for desc in target_catalog(policy, samples, wgpu::TextureFormat::Rgba16Float, quality) {
                    assert_eq!(validate(&desc), Ok(()), "{} {:?} {:?} x{}", desc.label, desc.format, desc.usage, desc.samples);
                }
                // The renderer-owned exception: an `rg11b10ufloat` scene where the device has it.
                for desc in target_catalog(policy, samples, wgpu::TextureFormat::Rg11b10Ufloat, quality) {
                    assert_eq!(validate_with(&desc, wgpu::Features::RG11B10UFLOAT_RENDERABLE), Ok(()), "{}", desc.label);
                }
            }
        }
    }
    let ultra = preset_quality(QualityPreset::Ultra, DeviceClass::ALL[0]);
    let labels: Vec<&str> = target_catalog(TargetPolicy::default(), 4, wgpu::TextureFormat::Rgba16Float, &ultra).iter().map(|desc| desc.label).collect();
    for wanted in ["env specular", "env radiance", "brdf lut", "sky transmittance", "sky multiscatter", "sky view"] {
        assert!(labels.contains(&wanted), "the catalog lists {wanted}: {labels:?}");
    }
    // TAA's luma and lock side histories (renderer pass 2, P2-0.8a) are checked with the rest.
    use genex_render::post::taa::{LOCK_LABELS, LUMA_HISTORY_LABELS};
    for wanted in LUMA_HISTORY_LABELS.into_iter().chain(LOCK_LABELS) {
        assert!(labels.contains(&wanted), "the catalog lists {wanted}: {labels:?}");
    }
}

#[test]
fn an_ibl_target_asking_storage_of_rg16float_is_refused() {
    use genex_render::target_pool::{TargetDesc, TargetRefusal, validate};
    let usage = wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING;
    let lut = TargetDesc { label: "brdf lut", format: wgpu::TextureFormat::Rg16Float, usage, samples: 1, size: (128, 128), mips: 1, srgb_view: false };
    assert_eq!(validate(&lut), Err(TargetRefusal::UsageBeyondCore { label: "brdf lut", format: wgpu::TextureFormat::Rg16Float, usage }));
    let fragment = TargetDesc { usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING, ..lut };
    assert_eq!(validate(&fragment), Ok(()), "written by a fragment pass, the LUT is core");
}

// ---------------------------------------------------------------------------------------------
// The prepass, bloom, AO, fog and contact shadows (RQ4.0)

/// Whether the result of `entry` in `module` is a position declared `@invariant` (the entry's
/// direct result, or a member of its result struct).
fn invariant_position(module: &naga::Module, entry: &naga::EntryPoint) -> Option<bool> {
    let result = entry.function.result.as_ref()?;
    let is_position = |binding: &Option<naga::Binding>| match binding {
        Some(naga::Binding::BuiltIn(naga::BuiltIn::Position { invariant })) => Some(*invariant),
        _ => None,
    };
    if let Some(invariant) = is_position(&result.binding) {
        return Some(invariant);
    }
    match &module.types[result.ty].inner {
        naga::TypeInner::Struct { members, .. } => members.iter().find_map(|member| is_position(&member.binding)),
        _ => None,
    }
}

#[test]
fn every_depth_writing_vertex_entry_declares_an_invariant_position() {
    let listed: Vec<&str> = DEPTH_WRITING_VERTEX_ENTRIES.iter().map(|(shader, _)| *shader).collect();
    for wanted in ["forward", "prepass", "material-v2-sample"] {
        assert!(listed.contains(&wanted), "{wanted} writes depth a later pass tests against");
    }
    for (name, entry_name) in DEPTH_WRITING_VERTEX_ENTRIES {
        let module = parse(name, shader(name));
        let entry = module.entry_points.iter().find(|entry| entry.name == *entry_name).unwrap_or_else(|| panic!("{name} has {entry_name}"));
        assert_eq!(entry.stage, naga::ShaderStage::Vertex, "{name} {entry_name}");
        assert_eq!(invariant_position(&module, entry), Some(true), "{name} {entry_name}: @builtin(position) @invariant");
        let calls_clip = module.functions.iter().any(|(_, function)| function.name.as_deref() == Some("gx_clip_position"));
        assert!(calls_clip, "{name} computes its position with gx_clip_position");
    }
    // The material prelude a game's v2 source is prepended with carries the same entry point.
    let game = parse("v2", &format!("{MATERIAL_V2_PRELUDE}\n@fragment fn fs_material(in: GxMaterialInV2) -> @location(0) vec4<f32> {{ return in.tint; }}"));
    let entry = game.entry_points.iter().find(|entry| entry.name == "gx_vs_material_v2").expect("the v2 geometry entry point");
    assert_eq!(invariant_position(&game, entry), Some(true));
}

#[test]
fn the_lighting_chunks_find_the_effect_accessors_in_the_forward_pass_and_the_v2_prelude() {
    let functions = |module: &naga::Module| -> Vec<String> { module.functions.iter().filter_map(|(_, f)| f.name.clone()).collect() };
    let forward = functions(&parse("forward", shader("forward")));
    let material = functions(&parse("v2", &format!("{MATERIAL_V2_PRELUDE}\n@fragment fn fs_material(in: GxMaterialInV2) -> @location(0) vec4<f32> {{ return in.tint; }}")));
    // Pass 2 A.0 (LG-16): the light walk reads the bins through accessors, one merged table in
    // the forward pass and the v2 map's two bindings (slices of it) in the prelude.
    for accessor in ["gx_fog", "gx_ambient_occlusion", "gx_contact_shadow", "gx_oct_encode", "gx_oct_decode", "gx_clip_position", "gx_light_bin_word", "gx_light_tile_word"] {
        assert!(forward.iter().any(|f| f == accessor), "forward offers {accessor}");
        assert!(material.iter().any(|f| f == accessor), "material v2 offers {accessor}");
    }
}

#[test]
fn the_forward_frame_group_reserves_the_effect_slots_within_webgpu_core() {
    let core = wgpu::Limits::defaults();
    let module = parse("forward", shader("forward"));
    let declared = declared(&module);
    let env_highest = FRAME_ENV_BINDINGS.iter().map(|(binding, _)| *binding).max().unwrap_or(0);
    let mut extra = StageCounts::default();
    for (binding, name) in FRAME_EFFECT_BINDINGS {
        assert!(binding > env_highest && binding < core.max_bindings_per_bind_group, "{name} at {binding}");
        let kind = match MATERIAL_V2_BINDINGS.iter().find(|row| row.name == name) {
            Some(v2) => v2.kind.as_declared(),
            None if name == "frame_fog" => BindingKind::Uniform,
            None => BindingKind::Texture2d,
        };
        let row = declared.iter().find(|(group, at, ..)| (*group, *at) == (0, binding));
        // RQ4.6 binds the fog row, the AO term and the contact-shadow mask under their slot's name
        // and kind; the other slots stay free until their producers bind them.
        if FRAME_EFFECT_BOUND.contains(&(binding, name)) {
            let row = row.unwrap_or_else(|| panic!("forward declares {name} at {binding}"));
            assert_eq!((row.2.as_str(), row.3), (name, kind), "{name} at {binding}");
            continue;
        }
        assert!(row.is_none(), "{name}: binding {binding} is free until its producer binds it");
        extra.add(kind);
    }
    let today = counts_in(&module);
    assert!(today.uniform_buffers + extra.uniform_buffers <= core.max_uniform_buffers_per_shader_stage);
    assert!(today.sampled_textures + extra.sampled_textures <= FORWARD_FRAGMENT_TEXTURES_MAX, "{today:?} + {extra:?}");
    assert!(today.samplers + extra.samplers <= core.max_samplers_per_shader_stage);
}

#[test]
fn every_rq4_target_is_one_webgpu_core_guarantees() {
    use genex_render::post::{ao, bloom, contact_shadow};
    use genex_render::target_pool::validate;
    let render = (1920, 1080);
    let mut targets: Vec<genex_render::target_pool::TargetDesc> = genex_render::prepass::targets(render).to_vec();
    let quality = genex_render::presets::preset_quality(genex_render::settings::QualityPreset::Ultra, genex_render::device_class::DeviceClass::ALL[0]);
    // The chain is sized from the output (renderer pass 2, P5): 1080p here.
    targets.extend(bloom::chain_target(render, &quality.bloom));
    targets.extend(ao::targets(render, &quality.ao));
    targets.push(contact_shadow::mask_target(render));
    assert!(targets.len() >= 6, "{targets:?}");
    for desc in &targets {
        assert_eq!(validate(desc), Ok(()), "{} {:?} {:?}", desc.label, desc.format, desc.usage);
    }
    // The fragment-written formats are the format rule table's.
    for (format, what) in [(genex_render::prepass::NORMALS_FORMAT, "normals"), (ao::AO_FORMAT, "ao"), (contact_shadow::MASK_FORMAT, "contact-shadows")] {
        assert!(FRAGMENT_WRITTEN_FORMATS.contains(&(what, format)), "{what}");
    }
    for stub in ["prepass", "bloom-down", "bloom-up", "aerial-perspective", "gtao", "ao-denoise", "contact-shadow"] {
        assert!(SHADERS.iter().any(|(name, _)| *name == stub), "RQ4.0 registers {stub}");
    }
}

// ---------------------------------------------------------------------------------------------
// Meshlets and two-pass Hi-Z occlusion (R2.0)

/// The R2 shaders the contracts land as stubs (their work packages fill them), by name. The R2
/// integrate WP registers them in `shaders::SHADERS`; until then this file checks them itself.
fn r2_shaders() -> [(&'static str, &'static str); 3] {
    [
        ("hiz-build", genex_render::hiz::HIZ_BUILD),
        ("meshlet-cull", genex_render::meshlet_cull::MESHLET_CULL),
        ("meshlet-draw", genex_render::meshlet_cull::MESHLET_DRAW),
    ]
}

#[test]
fn the_r2_shaders_validate_against_core_emit_everywhere_and_keep_the_format_rules() {
    for (name, source) in r2_shaders() {
        let module = parse(name, source);
        let info = validated(name, &module);
        emit(name, &module, &info, &[]);
        let storage = storage_textures(&module);
        assert!(storage.len() as u32 <= STORAGE_TEXTURES_PER_STAGE_MAX, "{name}: {storage:?}");
        for (texture, format, access) in &storage {
            let rule = COMPUTE_STORAGE_FORMATS
                .iter()
                .find(|(allowed, _)| naga_format(*allowed) == *format)
                .map(|(_, rule)| *rule)
                .unwrap_or_else(|| panic!("{name}: {texture} writes {format:?}, outside the format rules"));
            if rule == StorageRule::WriteOnly {
                assert_eq!(*access, naga::StorageAccess::STORE, "{name}: {texture} is write-only");
            }
        }
        assert!(workgroup_bytes(&module) <= WORKGROUP_SHARED_BYTES_MAX, "{name}: {} bytes of workgroup memory", workgroup_bytes(&module));
    }
    let hiz = parse("hiz-build", genex_render::hiz::HIZ_BUILD);
    let pyramid = storage_textures(&hiz);
    assert!(
        pyramid.iter().all(|(_, format, _)| *format == naga_format(genex_render::hiz::HIZ_FORMAT)),
        "the Hi-Z pyramid is r32float storage: {pyramid:?}"
    );
}

/// The storage buffers the entry point `entry` of `module` really reads or writes (naga's usage
/// analysis), by name.
fn storage_buffers_used(module: &naga::Module, info: &ModuleInfo, entry: &str) -> Vec<String> {
    let index = module.entry_points.iter().position(|point| point.name == entry).unwrap_or_else(|| panic!("{entry} declared"));
    let usage = info.get_entry_point(index);
    let mut names: Vec<String> = module
        .global_variables
        .iter()
        .filter(|(handle, global)| matches!(global.space, naga::AddressSpace::Storage { .. }) && !usage[*handle].is_empty())
        .map(|(_, global)| global.name.clone().unwrap_or_default())
        .collect();
    names.sort();
    names
}

#[test]
fn the_meshlet_draws_vertex_stage_reads_at_most_cores_eight_storage_buffers() {
    let core = wgpu::Limits::defaults();
    let module = parse("meshlet-draw", genex_render::meshlet_cull::MESHLET_DRAW);
    let info = validated("meshlet-draw", &module);
    let entry_name = genex_render::meshlet_cull::MESHLET_DRAW_VERTEX_ENTRY;
    let used = storage_buffers_used(&module, &info, entry_name);
    // Vertex pulling: the instance table, the library's vertices, the meshlet table, the meshlet
    // vertex buffer and this view's drawn-meshlet slots.
    assert_eq!(used, ["drawn_meshlets", "instances", "mesh_vertices", "meshlet_vertices", "meshlets"], "{used:?}");
    assert!(used.len() as u32 <= core.max_storage_buffers_per_shader_stage, "{used:?}");
    assert_eq!(core.max_storage_buffers_per_shader_stage, 8);
    // A depth writer: the position is @invariant and computed by gx_clip_position.
    let entry = module.entry_points.iter().find(|point| point.name == entry_name).expect("the vertex entry");
    assert_eq!(entry.stage, naga::ShaderStage::Vertex);
    assert_eq!(invariant_position(&module, entry), Some(true), "meshlet pulling writes depth an Equal pass tests against");
    assert!(module.functions.iter().any(|(_, function)| function.name.as_deref() == Some("gx_clip_position")));
}

/// Storage buffers `entries` make visible to `stage`, counted the way WebGPU's
/// `createPipelineLayout` counts them: every layout binding, read by the shader or not.
fn layout_storage_buffers(entries: &[wgpu::BindGroupLayoutEntry], stage: wgpu::ShaderStages) -> u32 {
    let storage = |entry: &&wgpu::BindGroupLayoutEntry| matches!(entry.ty, wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { .. }, .. });
    entries.iter().filter(|entry| entry.visibility.contains(stage)).filter(storage).count() as u32
}

/// The layout type a shader global needs: (storage or uniform, read-only storage).
fn buffer_kind(ty: &wgpu::BindingType) -> Option<(BindingKind, bool)> {
    match ty {
        wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only }, .. } => Some((BindingKind::Storage, *read_only)),
        wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, .. } => Some((BindingKind::Uniform, false)),
        _ => None,
    }
}

#[test]
fn the_meshlet_draw_pipeline_layout_holds_cores_eight_storage_buffers_per_stage() {
    // The draw is built on the forward frame group (0), the pass-view group (1, one dynamic
    // uniform) and the meshlet group (2). WebGPU counts every storage binding a stage can see in
    // all of the pipeline's groups, so the frame group's vertex tables count beside the meshlet
    // group even where the draw never reads them.
    let core = wgpu::Limits::defaults();
    let frame = genex_render::renderer::frame_layout_entries();
    let meshlet = genex_render::tables::meshlet_draw_layout_entries();
    let module = parse("meshlet-draw", genex_render::meshlet_cull::MESHLET_DRAW);
    let pass_view: Vec<(u32, BindingKind)> =
        module.global_variables.iter().filter_map(|(_, global)| global.binding.as_ref().filter(|at| at.group == 1).map(|at| (at.binding, kind_of(&module, global)))).collect();
    assert_eq!(pass_view, [(0, BindingKind::Uniform)], "group 1 is the pass view's one uniform: no storage buffer");
    for stage in [wgpu::ShaderStages::VERTEX, wgpu::ShaderStages::FRAGMENT] {
        let total = layout_storage_buffers(&frame, stage) + layout_storage_buffers(&meshlet, stage);
        assert!(total <= core.max_storage_buffers_per_shader_stage, "{stage:?}: {total} storage buffers in the meshlet draw's pipeline layout");
    }
    // Today's frame group shows three tables to the vertex stage (instances, batches, the visible
    // list): with the meshlet group's four, one vertex-stage storage binding is left for R2.4
    // (for example the previous-model table motion vectors need). Game systems LOD-18 reads the
    // far-field grow through the faded pipelines' own group 1, not here.
    let vertex = layout_storage_buffers(&frame, wgpu::ShaderStages::VERTEX) + layout_storage_buffers(&meshlet, wgpu::ShaderStages::VERTEX);
    assert_eq!(vertex, 7, "vertex-stage storage buffers of the meshlet draw's pipeline layout");
    // Every group-0 global the draw declares is a frame-group binding of the same kind and access
    // that its stage can see, so the draw binds the forward frame group as it is.
    for (_, global) in module.global_variables.iter() {
        let Some(at) = global.binding.as_ref().filter(|at| at.group == 0) else { continue };
        let name = global.name.clone().unwrap_or_default();
        let entry = frame.iter().find(|entry| entry.binding == at.binding).unwrap_or_else(|| panic!("frame group binds {name} at {}", at.binding));
        let read_only = matches!(global.space, naga::AddressSpace::Storage { access } if !access.contains(naga::StorageAccess::STORE));
        assert_eq!(buffer_kind(&entry.ty), Some((kind_of(&module, global), read_only)), "{name}");
        assert!(entry.visibility.contains(wgpu::ShaderStages::VERTEX), "{name} is visible to vertex pulling");
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_meshlet_draw_pipeline_builds_on_a_core_device() {
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    let gpu = match genex_render::Gpu::headless() {
        Ok(gpu) => gpu,
        Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
        Err(error) => return eprintln!("skipped: no WebGPU-core adapter ({error})"),
    };
    let device = &gpu.device;
    assert_eq!(device.limits().max_storage_buffers_per_shader_stage, wgpu::Limits::defaults().max_storage_buffers_per_shader_stage, "a core device");
    let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let layout_of = |label: &str, entries: &[wgpu::BindGroupLayoutEntry]| device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some(label), entries });
    let pass_view = [wgpu::BindGroupLayoutEntry {
        binding: 0,
        visibility: wgpu::ShaderStages::VERTEX,
        ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: true, min_binding_size: None },
        count: None,
    }];
    let groups = [
        layout_of("frame", &genex_render::renderer::frame_layout_entries()),
        layout_of("pass view", &pass_view),
        layout_of("meshlet draw", &genex_render::tables::meshlet_draw_layout_entries()),
    ];
    let refs: Vec<Option<&wgpu::BindGroupLayout>> = groups.iter().map(Some).collect();
    let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("meshlet draw"), bind_group_layouts: &refs, immediate_size: 0 });
    let source = genex_render::meshlet_cull::MESHLET_DRAW;
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("meshlet draw"), source: wgpu::ShaderSource::Wgsl(source.into()) });
    let _pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("meshlet draw"),
        layout: Some(&layout),
        vertex: wgpu::VertexState {
            module: &module,
            entry_point: Some(genex_render::meshlet_cull::MESHLET_DRAW_VERTEX_ENTRY),
            compilation_options: Default::default(),
            buffers: &[],
        },
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: Some(wgpu::DepthStencilState {
            format: genex_render::renderer::DEPTH_FORMAT,
            depth_write_enabled: Some(true),
            depth_compare: Some(wgpu::CompareFunction::Less),
            stencil: wgpu::StencilState::default(),
            bias: wgpu::DepthBiasState::default(),
        }),
        multisample: wgpu::MultisampleState::default(),
        fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs_meshlet_depth"), compilation_options: Default::default(), targets: &[] }),
        multiview_mask: None,
        cache: None,
    });
    let error = pollster::block_on(scope.pop());
    assert!(error.is_none(), "{error:?}");
}

#[test]
fn the_meshlet_draw_declares_exactly_the_meshlet_group_the_tables_lay_out() {
    let core = wgpu::Limits::defaults();
    assert!(MESHLET_DRAW_GROUP < core.max_bind_groups, "group {MESHLET_DRAW_GROUP}");
    let module = parse("meshlet-draw", genex_render::meshlet_cull::MESHLET_DRAW);
    let mut group: Vec<(u32, String, BindingKind)> = module
        .global_variables
        .iter()
        .filter_map(|(_, global)| {
            let at = global.binding.as_ref()?;
            (at.group == MESHLET_DRAW_GROUP).then(|| (at.binding, global.name.clone().unwrap_or_default(), kind_of(&module, global)))
        })
        .collect();
    group.sort();
    let wanted: Vec<(u32, String, BindingKind)> = MESHLET_DRAW_BINDINGS.iter().map(|(binding, name)| (*binding, (*name).to_owned(), BindingKind::Storage)).collect();
    assert_eq!(group, wanted);
    let entries = genex_render::tables::meshlet_draw_layout_entries();
    let laid: Vec<u32> = entries.iter().map(|entry| entry.binding).collect();
    assert_eq!(laid, MESHLET_DRAW_BINDINGS.map(|(binding, _)| binding).to_vec());
    for entry in &entries {
        assert_eq!(entry.visibility, wgpu::ShaderStages::VERTEX, "binding {}: read by vertex pulling only", entry.binding);
        assert!(
            matches!(entry.ty, wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only: true }, .. }),
            "binding {}: read-only storage",
            entry.binding
        );
    }
}

#[test]
fn the_hiz_pyramid_is_a_core_target_reduced_by_the_depth_convention() {
    use genex_render::hiz::{self, HizReduce};
    use genex_render::target_pool::validate;
    let format = hiz::HIZ_FORMAT;
    assert!(COMPUTE_STORAGE_FORMATS.contains(&(format, StorageRule::ReadWrite)), "r32float is read-write storage in core");
    for render in [(1920, 1080), (127, 73), (1, 1)] {
        let desc = hiz::target(render);
        assert_eq!(validate(&desc), Ok(()), "{render:?}: {desc:?}");
        assert_eq!(desc.size, hiz::base_size(render));
        assert_eq!(desc.mips, hiz::mip_count(desc.size));
    }
    assert_eq!(hiz::base_size((127, 73)), (63, 36));
    assert_eq!(hiz::mip_count((63, 36)), 6);
    assert_eq!(hiz::reduction(false), HizReduce::Max, "standard Z: the farthest depth is the largest");
    assert_eq!(hiz::reduction(true), HizReduce::Min, "reverse-Z: the farthest depth is the smallest");
    assert_eq!(HizReduce::Max.reduce([0.2, 0.9, 0.5, 0.1]), 0.9);
    assert_eq!(HizReduce::Min.reduce([0.2, 0.9, 0.5, 0.1]), 0.1);
}

#[test]
fn the_r2_nodes_have_landed_and_asking_for_occlusion_schedules_its_node() {
    use genex_render::graph::{FRAME_GRAPH, NodeId, Target, feature_landed, schedule};
    use genex_render::settings::{Quality, RenderFeature};
    assert!(NodeId::Occlusion.landed(), "the Hi-Z + cull pass 2 row landed with R2.4");
    assert!(NodeId::Occlusion.writes().contains(&Target::HiZ));
    assert!(feature_landed(RenderFeature::Meshlets) && feature_landed(RenderFeature::Occlusion));
    let mut asked = Quality::off();
    asked.set_feature(RenderFeature::Meshlets, true);
    asked.set_feature(RenderFeature::Occlusion, true);
    let with: Vec<NodeId> = schedule(|id| genex_render::graph::quality_allows(id, &asked)).iter().flat_map(|step| step.nodes()).collect();
    let without: Vec<NodeId> = schedule(|id| genex_render::graph::quality_allows(id, &Quality::off())).iter().flat_map(|step| step.nodes()).collect();
    assert!(with.contains(&NodeId::Occlusion), "asking for occlusion schedules node 8: {with:?}");
    assert!(!without.contains(&NodeId::Occlusion), "the legacy renderer never runs it");
    assert!(FRAME_GRAPH.iter().any(|row| row.id == NodeId::Occlusion && row.wire == "occlusion"));
}

// ---------------------------------------------------------------------------------------------
// RQ3.0: cascades and cull views

#[test]
fn the_frame_grows_past_the_frozen_v1_prefix_with_every_cascade() {
    use genex_render::layout::{GpuFrame, MAX_CASCADES, MAX_SHADOWED_SPOTS, MAX_VIEWS, SHADOW_CASCADES};
    use std::mem::offset_of;
    // AAA review WP-15 flipped MAX_VIEWS 1 + 4 + 4 -> 1 + 4 + 16: two shadowed point lights' faces.
    assert_eq!((MAX_CASCADES, MAX_SHADOWED_SPOTS, MAX_VIEWS), (4, 4, 1 + 4 + 16));
    assert_eq!(size_of::<GxFrameV1>() as u64, GX_FRAME_V1_BYTES, "the v1 frame is frozen");
    assert!(size_of::<GpuFrame>() as u64 > GX_FRAME_V1_BYTES, "the renderer's frame grows");
    assert_eq!(SHADOW_CASCADES, 2, "the v1 prefix carries two cascades");
    assert!(offset_of!(GpuFrame, cascade_matrices) as u64 >= GX_FRAME_V1_BYTES, "the new members follow the v1 prefix");
    let module = parse("forward", shader("forward"));
    let (members, size) = wgsl_members(&module, "FrameUniforms");
    assert_eq!(size, size_of::<GpuFrame>());
    let at = |name: &str| members.iter().find(|(member, _)| member == name).map(|(_, offset)| *offset).unwrap_or_else(|| panic!("FrameUniforms.{name}"));
    let rust = [
        ("cascade_view_proj_v1", offset_of!(GpuFrame, cascade_view_proj)),
        ("cascade_splits", offset_of!(GpuFrame, cascade_splits)),
        ("counts", offset_of!(GpuFrame, counts)),
        ("cascade_view_proj", offset_of!(GpuFrame, cascade_matrices)),
        ("cascade_ends", offset_of!(GpuFrame, cascade_ends)),
        ("cascade_offsets", offset_of!(GpuFrame, cascade_offsets)),
        ("cascade_texels", offset_of!(GpuFrame, cascade_texels)),
        ("shadow_soft", offset_of!(GpuFrame, shadow_soft)),
        ("shadow_counts", offset_of!(GpuFrame, shadow_counts)),
        ("texture_lod", offset_of!(GpuFrame, texture_lod)),
    ];
    for (name, offset) in rust {
        assert_eq!(at(name), offset, "FrameUniforms.{name}");
    }
}

/// The member `name` of the WGSL struct `wanted` in `module`, as naga's type.
fn member_type<'a>(module: &'a naga::Module, wanted: &str, name: &str) -> &'a naga::TypeInner {
    let (_, ty) = module.types.iter().find(|(_, ty)| ty.name.as_deref() == Some(wanted)).unwrap_or_else(|| panic!("{wanted} declared"));
    let naga::TypeInner::Struct { members, .. } = &ty.inner else { panic!("{wanted} is a struct") };
    let member = members.iter().find(|member| member.name.as_deref() == Some(name)).unwrap_or_else(|| panic!("{wanted}.{name}"));
    &module.types[member.ty].inner
}

#[test]
fn the_sun_chunk_reads_cascades_under_members_both_frames_share() {
    // The sun chunk compiles against FrameUniforms (forward) and GxFrameV2 (Level-2 v2): the
    // cascade members it reads have one name, one type and one meaning in both.
    let module = parse("forward", shader("forward"));
    for frame in ["FrameUniforms", "GxFrameV2"] {
        let naga::TypeInner::Array { size, .. } = member_type(&module, frame, "cascade_view_proj") else { panic!("{frame}.cascade_view_proj is an array") };
        assert_eq!(*size, naga::ArraySize::Constant(std::num::NonZeroU32::new(4).expect("4")), "{frame}: four cascades");
        for vector in ["cascade_ends", "cascade_offsets", "cascade_splits", "shadow_params"] {
            assert!(matches!(member_type(&module, frame, vector), naga::TypeInner::Vector { size: naga::VectorSize::Quad, .. }), "{frame}.{vector}");
        }
    }
}

#[test]
fn the_cull_views_reserve_every_view_and_the_cull_shader_reads_them() {
    use genex_render::layout::{GpuCullViews, MAX_VIEWS};
    let module = parse("cull", shader("cull"));
    let naga::TypeInner::Array { size, stride, .. } = member_type(&module, "CullViews", "planes") else { panic!("CullViews.planes") };
    assert_eq!(*size, naga::ArraySize::Constant(std::num::NonZeroU32::new(MAX_VIEWS as u32).expect("views")));
    assert_eq!(*stride as usize, 6 * 16, "six planes per view");
    // Pass 2 A6.9 flipped MAX_VIEWS * 96 + 16 -> + 48: the LOD view and its flags after `params`;
    // lane FQ -> + 64: each sun cascade's caster error (`shadow_lod`).
    assert_eq!(size_of::<GpuCullViews>(), MAX_VIEWS * 96 + 64);
    assert!(size_of::<GpuCullViews>() as u64 <= wgpu::Limits::defaults().max_uniform_buffer_binding_size, "a core uniform");
}

/// `textureGather` over the cascades with a non-filtering sampler: PCSS's blocker search.
const BLOCKER_SEARCH: &str = "
fn gx_test_blockers(uv: vec2<f32>, layer: i32) -> vec4<f32> {
    return textureGather(shadow_map, point_sampler, uv, layer);
}
";

#[test]
fn the_blocker_search_gathers_the_shadow_map_with_the_non_filtering_sampler_in_core() {
    use genex_render::layout::SHADOW_BLOCKER_SAMPLER;
    let (binding, name) = SHADOW_BLOCKER_SAMPLER;
    assert!(FRAME_EFFECT_BINDINGS.contains(&SHADOW_BLOCKER_SAMPLER), "the forward frame reserves {name} at {binding}");
    let v2 = MATERIAL_V2_BINDINGS.iter().find(|row| row.name == name).expect("the v2 map names it");
    assert_eq!(v2.kind, BindingKind::NonFilteringSampler);
    // P2-0.3 integration: the forward frame binds it (the search gathers through it), so the
    // forward pass declares it under the slot's name.
    assert!(FRAME_EFFECT_BOUND.contains(&SHADOW_BLOCKER_SAMPLER), "the forward frame binds {name} at {binding}");
    let declared = declared(&parse("forward", shader("forward")));
    let row = declared.iter().find(|(group, at, ..)| (*group, *at) == (0, binding));
    assert_eq!(row.map(|row| (row.2.as_str(), row.3)), Some((name, BindingKind::Sampler)), "forward declares {name} at {binding}");
    let forward = format!("{}\n{BLOCKER_SEARCH}", shader("forward"));
    let material = format!(
        "{MATERIAL_V2_PRELUDE}\n{BLOCKER_SEARCH}\n@fragment fn fs_material(in: GxMaterialInV2) -> @location(0) vec4<f32> {{ return gx_test_blockers(in.uv, 0); }}"
    );
    for (prelude, source) in [("forward", forward), ("material-v2", material)] {
        let module = parse(prelude, &source);
        let info = validated(prelude, &module);
        emit(prelude, &module, &info, &[]);
    }
}

// ---------------------------------------------------------------------------------------------
// Motion vectors, TAA and the upscaler (RQ5.0)

/// The RQ5 shaders (TAA and the reactive coverage, EASU and RCAS), by name, plus the
/// previous-model row RQ5.1's prepass declares: checked here as fragment passes, and listed in
/// `shaders::SHADERS` since the RQ5 review (the module and size checks, the browser's pipeline
/// check).
fn rq5_shaders() -> [(&'static str, String); 5] {
    use genex_render::post::{fsr, taa};
    let prev_model = format!(
        "{}\n@group(0) @binding(0) var<storage, read> prev_models: array<PrevModel>;\n@compute @workgroup_size(1) fn main() {{ _ = prev_models[0].flags.x; }}",
        genex_render::motion::PREV_MODEL_WGSL
    );
    [
        ("taa", taa::TAA.to_owned()),
        ("taa-reactive", taa::REACTIVE.to_owned()),
        ("easu", fsr::EASU.to_owned()),
        ("rcas", fsr::RCAS.to_owned()),
        ("prev-model", prev_model),
    ]
}

#[test]
fn the_previous_model_table_is_parallel_and_leaves_the_instance_row_alone() {
    use genex_render::layout::{GpuInstance, GpuPrevModel};
    use genex_render::motion::{MOTION_FLAG_NO_HISTORY, PREV_MODEL_WGSL};
    // The published instance row (and the frozen v1 `GxInstance`) does not grow for motion.
    assert_eq!(size_of::<GpuInstance>(), 160);
    assert_eq!(size_of::<GpuInstance>() as u64, GX_INSTANCE_V1_BYTES);
    assert_eq!(size_of::<GpuPrevModel>() as u64, genex_render::tables::PREV_MODEL_STRIDE);
    let module = parse("prev-model", &format!("{PREV_MODEL_WGSL}\n@compute @workgroup_size(1) fn main() {{}}"));
    let (members, size) = wgsl_members(&module, "PrevModel");
    assert_eq!(members, [("model".to_owned(), 0), ("flags".to_owned(), 64)]);
    assert_eq!(size, size_of::<GpuPrevModel>());
    assert_eq!(std::mem::offset_of!(GpuPrevModel, flags), 64);
    assert_eq!(MOTION_FLAG_NO_HISTORY, 1, "bit 0: the row has no usable history (TAA takes the current sample)");
}

#[test]
fn the_rq5_shaders_validate_against_core_emit_everywhere_and_keep_the_format_rules() {
    for (name, source) in rq5_shaders() {
        let module = parse(name, &source);
        let info = validated(name, &module);
        emit(name, &module, &info, &[]);
        let storage = storage_textures(&module);
        assert!(storage.is_empty(), "{name}: the RQ5 passes are fragment passes: {storage:?}");
        assert!(workgroup_bytes(&module) <= WORKGROUP_SHARED_BYTES_MAX, "{name}");
    }
    let core = wgpu::Limits::defaults();
    let taa = parse("taa", &rq5_shaders()[0].1);
    let counts = counts_in(&taa);
    assert!(counts.sampled_textures <= core.max_sampled_textures_per_shader_stage, "{counts:?}");
    assert!(counts.samplers <= core.max_samplers_per_shader_stage, "{counts:?}");
}

#[test]
fn every_rq5_target_is_one_webgpu_core_guarantees() {
    use genex_render::post::{fsr, taa};
    use genex_render::target_pool::validate;
    for (render, output) in [((1920, 1080), (1920, 1080)), ((1280, 720), (1920, 1080)), ((1, 1), (2, 2))] {
        let mut targets = vec![genex_render::motion::target(render), taa::reactive_target(render), fsr::intermediate_target(render), fsr::easu_target(output)];
        targets.extend(taa::history_targets(render));
        for desc in &targets {
            assert_eq!(validate(desc), Ok(()), "{} {:?} {:?}", desc.label, desc.format, desc.usage);
        }
        let [a, b] = taa::history_targets(render);
        assert_ne!(a.label, b.label, "the history ping-pongs between two pooled targets");
        assert_eq!((a.format, a.size), (wgpu::TextureFormat::Rgba16Float, render), "TAA history is rgba16float at render size on every class");
        assert_eq!(fsr::easu_target(output).size, output);
    }
    for (format, what) in [(genex_render::motion::MOTION_FORMAT, "motion"), (taa::REACTIVE_FORMAT, "reactive")] {
        assert!(FRAGMENT_WRITTEN_FORMATS.contains(&(what, format)), "{what}");
    }
}

// RQ5.6 flipped (was `the_rq5_nodes_stay_unlanded_so_the_picture_is_unchanged`): the RQ5 nodes
// have landed, write their targets, and a TAA quality's frames walk the Halton jitter.
#[test]
fn the_rq5_nodes_have_landed_and_a_taa_quality_walks_the_jitter_cycle() {
    use genex_render::graph::{NodeId, Target, feature_landed, quality_allows, schedule};
    use genex_render::settings::{JitterCycle, PresetChoice, Quality, RenderFeature, RenderSettings};
    assert_eq!(NodeId::Reactive.writes(), &[Target::ReactiveMask]);
    assert_eq!(NodeId::Taa.writes(), &[Target::SceneColor, Target::TaaHistory]);
    assert!(NodeId::Prepass.writes().contains(&Target::Motion), "the prepass writes motion");
    assert!(feature_landed(RenderFeature::Taa) && feature_landed(RenderFeature::Upscaler));
    let mut asked = Quality::off();
    asked.set_feature(RenderFeature::Taa, true);
    asked.set_feature(RenderFeature::Upscaler, true);
    let nodes = |quality: &Quality| -> Vec<NodeId> { schedule(|id| quality_allows(id, quality)).iter().flat_map(|step| step.nodes()).collect() };
    let (with, without) = (nodes(&asked), nodes(&Quality::off()));
    assert!(with.contains(&NodeId::Reactive) && with.contains(&NodeId::Taa), "{with:?}");
    assert!(!without.contains(&NodeId::Reactive) && !without.contains(&NodeId::Taa), "the legacy renderer draws MSAA");
    for cycle in JitterCycle::ALL {
        asked.taa = asked.taa.with_jitter_cycle(cycle);
        let settings = RenderSettings::off().with_quality(PresetChoice::Off, asked);
        let positions: Vec<[f32; 2]> = (0..u64::from(cycle.frames())).map(|frame| settings.frame_config((640, 360), 0.75, frame, frame == 0).jitter).collect();
        for (frame, jitter) in positions.iter().enumerate() {
            assert_eq!(*jitter, genex_render::jitter::offset_px(frame as u64, cycle), "frame {frame}");
            assert!(jitter.iter().all(|c| c.abs() < 0.5), "a sub-pixel offset");
        }
        let again = settings.frame_config((640, 360), 0.75, u64::from(cycle.frames()), false).jitter;
        assert_eq!(again, positions[0], "the cycle repeats");
    }
}

// ---------------------------------------------------------------------------------------------
// Emissive, spot lights, light binning, texture size classes (RQ6.0)

/// The RQ6 shaders the contracts land as stubs (RQ6.1 fills the binning, RQ6.5 the spot shadow
/// pass), by name. The RQ6 integrate WP registers them in `shaders::SHADERS`; until then this
/// file checks them itself.
fn rq6_shaders() -> [(&'static str, &'static str); 2] {
    [("light-bin", genex_render::cluster::LIGHT_BIN), ("spot-shadow", genex_render::spot_shadow::SPOT_SHADOW)]
}

#[test]
fn the_light_and_material_tables_keep_their_rows_and_grow_parallel_extensions() {
    use genex_render::layout::{GpuLight, GpuLightBinParams, GpuLightExt, GpuMaterial, GpuMaterialExt, LIGHT_EXT_VEC4S};
    let module = parse("forward", shader("forward"));
    let (members, size) = wgsl_members(&module, "LightExt");
    assert_eq!((members, size), (vec![("spot".to_owned(), 0), ("params".to_owned(), 16)], size_of::<GpuLightExt>()));
    assert_eq!(size_of::<GpuLightExt>(), LIGHT_EXT_VEC4S * 16, "light_ext is array<vec4<f32>>: two vec4s per light");
    let (members, size) = wgsl_members(&module, "LightBinParams");
    assert_eq!((members, size), (vec![("grid".to_owned(), 0), ("depth".to_owned(), 16), ("ranges".to_owned(), 32), ("kind_depth".to_owned(), 48)], size_of::<GpuLightBinParams>()));
    // The rows the Level-2 v2 map already binds do not move: the light row, the material row and
    // the material extension are the ones v2 materials read.
    let v2 = |name: &str| MATERIAL_V2_BINDINGS.iter().find(|row| row.name == name).unwrap_or_else(|| panic!("v2 binds {name}"));
    assert_eq!((v2("lights").bytes, size_of::<GpuLight>()), (32, 32));
    assert_eq!(v2("material_ext").bytes, size_of::<GpuMaterialExt>() as u64);
    assert_eq!(v2("light_ext").bytes, 16, "one vec4<f32> element");
    assert_eq!(size_of::<GpuMaterial>() as u64, GX_MATERIAL_V1_BYTES);
}

/// Each `u32` constant `module` declares, by name.
fn u32_constants(module: &naga::Module) -> Vec<(String, u32)> {
    module
        .constants
        .iter()
        .filter_map(|(_, constant)| match module.global_expressions[constant.init] {
            naga::Expression::Literal(naga::Literal::U32(value)) => Some((constant.name.clone()?, value)),
            _ => None,
        })
        .collect()
}

#[test]
fn the_wgsl_light_bin_and_texture_constants_are_the_rust_ones() {
    use genex_render::cluster::{LIGHT_BIN_HEADER_WORDS, LIGHT_TILES_OFFSET_WORDS, LIGHT_ZBINS, ZBIN_EMPTY, ZBIN_INDEX_BITS};
    use genex_render::layout::{LIGHT_EXT_VEC4S, LIGHT_KIND_POINT, LIGHT_KIND_SPOT, SPOT_MATRIX_VEC4S, TEXTURE_CLASS_SHIFT, TEXTURE_LAYER_MASK};
    let constants = u32_constants(&parse("forward", shader("forward")));
    let value = |name: &str| constants.iter().find(|(declared, _)| declared == name).map(|(_, value)| *value).unwrap_or_else(|| panic!("{name} declared"));
    assert_eq!(value("GX_LIGHT_POINT"), LIGHT_KIND_POINT as u32);
    assert_eq!(value("GX_LIGHT_SPOT"), LIGHT_KIND_SPOT as u32);
    assert_eq!(value("GX_LIGHT_EXT_VEC4S") as usize, LIGHT_EXT_VEC4S);
    assert_eq!(value("GX_SPOT_MATRIX_VEC4S") as usize, SPOT_MATRIX_VEC4S);
    assert_eq!(value("GX_LIGHT_BIN_HEADER_WORDS"), LIGHT_BIN_HEADER_WORDS);
    assert_eq!(value("GX_ZBIN_EMPTY"), ZBIN_EMPTY);
    assert_eq!(value("GX_LIGHT_ZBINS"), LIGHT_ZBINS);
    assert_eq!(value("GX_LIGHT_TILES_OFFSET_WORDS"), LIGHT_TILES_OFFSET_WORDS);
    assert_eq!(value("GX_ZBIN_INDEX_BITS"), ZBIN_INDEX_BITS);
    assert_eq!(value("GX_TEXTURE_CLASS_SHIFT"), TEXTURE_CLASS_SHIFT);
    assert_eq!(value("GX_TEXTURE_LAYER_MASK"), TEXTURE_LAYER_MASK);
}

/// Each `f32` constant `module` declares, by name.
fn f32_constants(module: &naga::Module) -> Vec<(String, f32)> {
    module
        .constants
        .iter()
        .filter_map(|(_, constant)| match module.global_expressions[constant.init] {
            naga::Expression::Literal(naga::Literal::F32(value)) => Some((constant.name.clone()?, value)),
            _ => None,
        })
        .collect()
}

/// Each `override` `module` declares, with its default, by name.
fn override_defaults(module: &naga::Module) -> Vec<(String, Option<naga::Literal>)> {
    module
        .overrides
        .iter()
        .filter_map(|(_, declared)| {
            let default = declared.init.and_then(|init| match module.global_expressions[init] {
                naga::Expression::Literal(literal) => Some(literal),
                _ => None,
            });
            Some((declared.name.clone()?, default))
        })
        .collect()
}

/// Pass 2's contracts wave (stage 0): the slots and lanes later packages fill are declared with
/// the values that draw today's picture. The spot shadow fade lane and the instance fade table's
/// whole value are the Rust ones; the stage's new pipeline constants default to today's behaviour
/// (the roughness floor 0.04, no rg11b10 dither, no LOD fade) in every module that declares them;
/// the instance fade table's reserved slot collides with no forward frame binding.
#[test]
fn the_stage_zero_contract_slots_hold_todays_values() {
    use genex_render::layout::{
        FRAME_EFFECT_BINDINGS, FRAME_ENV_BINDINGS, FRAME_INSTANCE_FADE_BINDING, FRAME_LIGHT_BINDINGS, FRAME_MATERIAL_CLASS_BINDINGS, INSTANCE_FADE_WHOLE,
        SPOT_SHADOW_UNFADED,
    };
    let forward = parse("forward", shader("forward"));
    let constants = f32_constants(&forward);
    let value = |name: &str| constants.iter().find(|(declared, _)| declared == name).map(|(_, value)| *value).unwrap_or_else(|| panic!("{name} declared"));
    assert_eq!(value("GX_SPOT_SHADOW_UNFADED").to_bits(), SPOT_SHADOW_UNFADED.to_bits());
    assert_eq!(value("GX_INSTANCE_FADE_WHOLE").to_bits(), INSTANCE_FADE_WHOLE.to_bits());
    let expected: &[(&str, &[&str], naga::Literal)] = &[
        ("GX_ROUGHNESS_FLOOR", &["forward", "material-v2-sample"], naga::Literal::F32(0.04)),
        ("GX_SCENE_RG11B10", &["forward", "material-v2-sample"], naga::Literal::Bool(false)),
        ("GX_LOD_FADE", &["forward", "prepass", "shadow"], naga::Literal::Bool(false)),
    ];
    for (name, shaders, default) in expected {
        for shader_name in *shaders {
            let declared = override_defaults(&parse(shader_name, shader(shader_name)));
            let found = declared.iter().find(|(declared, _)| declared == name).unwrap_or_else(|| panic!("{shader_name} declares {name}"));
            assert_eq!(found.1, Some(*default), "{name} in {shader_name}");
        }
    }
    let taken: Vec<u32> = (0..=10)
        .chain(FRAME_ENV_BINDINGS.iter().map(|(binding, _)| *binding))
        .chain(FRAME_EFFECT_BINDINGS.iter().map(|(binding, _)| *binding))
        .chain(FRAME_LIGHT_BINDINGS.iter().map(|(binding, _)| *binding))
        .chain(FRAME_MATERIAL_CLASS_BINDINGS.iter().map(|(binding, _)| *binding))
        .collect();
    assert!(!taken.contains(&FRAME_INSTANCE_FADE_BINDING.0), "binding {} collides with no forward frame binding", FRAME_INSTANCE_FADE_BINDING.0);
    assert!(FRAME_INSTANCE_FADE_BINDING.0 > 30, "it clears the screen reflections' binding 30");
}

/// Game systems LOD-02 and LOD-03: the cull reads the LOD rows (binding 6, `LodRow` per opaque
/// row) and writes the instance fade table (binding 7, `vec2<f32>` per visible-list slot, the
/// table the forward frame's binding 31 names), within WebGPU core's eight storage buffers per
/// stage. Named flips: the fade table went from reserved and unbound (`binding 31 is free`) to
/// bound and written by the cull, and its row from 4 bytes (f32 per instance row) to 8 (fade and
/// grow per slot); the cull's storage buffers from 5 to 7 of 8, then to 8 of 8 with instance
/// occlusion's history (binding 11, horde 10k: read and written, the last free storage buffer).
#[test]
fn the_cull_reads_the_lod_rows_and_writes_the_fade_table_within_cores_storage_limit() {
    use genex_render::cull::{CULL_FADES_BINDING, CULL_MARK_ENTRY, CULL_SCAN_ENTRY, CULL_SCATTER_ENTRY};
    use genex_render::layout::INSTANCE_FADE_BYTES;
    use genex_render::lod_rows::{CULL_LOD_ROWS_BINDING, LOD_ROW_BYTES};
    assert_eq!(INSTANCE_FADE_BYTES, 8, "a fade and a grow per slot");
    let module = parse("cull", shader("cull"));
    let info = validated("cull", &module);
    let global = |name: &str| module.global_variables.iter().find(|(_, global)| global.name.as_deref() == Some(name)).map(|(_, global)| global).unwrap_or_else(|| panic!("{name} declared"));
    let (lod_rows, fades) = (global("lod_rows"), global("fades"));
    assert_eq!(lod_rows.binding.as_ref().map(|at| (at.group, at.binding)), Some((0, CULL_LOD_ROWS_BINDING)));
    assert_eq!(fades.binding.as_ref().map(|at| (at.group, at.binding)), Some((0, CULL_FADES_BINDING)));
    assert_eq!(lod_rows.space, naga::AddressSpace::Storage { access: naga::StorageAccess::LOAD });
    assert_eq!(fades.space, naga::AddressSpace::Storage { access: naga::StorageAccess::LOAD | naga::StorageAccess::STORE });
    let stride = |global: &naga::GlobalVariable| match module.types[global.ty].inner {
        naga::TypeInner::Array { stride, .. } => u64::from(stride),
        ref other => panic!("an array, not {other:?}"),
    };
    assert_eq!((stride(lod_rows), stride(fades)), (LOD_ROW_BYTES, INSTANCE_FADE_BYTES));
    let core = wgpu::Limits::defaults();
    let declared = module.global_variables.iter().filter(|(_, global)| matches!(global.space, naga::AddressSpace::Storage { .. })).count() as u32;
    assert_eq!(declared, 8, "the cull group's storage buffers");
    let history = global("occ_history");
    assert_eq!(history.binding.as_ref().map(|at| (at.group, at.binding)), Some((0, genex_render::cull::CULL_HISTORY_BINDING)));
    assert_eq!(history.space, naga::AddressSpace::Storage { access: naga::StorageAccess::LOAD | naga::StorageAccess::STORE });
    assert!(declared <= core.max_storage_buffers_per_shader_stage, "{declared} of {}", core.max_storage_buffers_per_shader_stage);
    for entry in [CULL_MARK_ENTRY, CULL_SCAN_ENTRY, CULL_SCATTER_ENTRY] {
        let used = storage_buffers_used(&module, &info, entry);
        eprintln!("{entry}: {} storage buffers {used:?}", used.len());
        assert!(used.len() as u32 <= core.max_storage_buffers_per_shader_stage, "{entry}: {used:?}");
    }
}

#[test]
fn texture_references_keep_class_zero_bytes_and_never_alias_no_texture() {
    use genex_render::layout::{NO_TEXTURE, TEXTURE_LAYER_MASK, TEXTURE_SIZE_CLASSES, texture_ref, texture_ref_parts};
    for layer in [0, 1, 255, 4095] {
        assert_eq!(texture_ref(0, layer), layer, "a class-0 reference is today's bare layer");
    }
    for class in 0..TEXTURE_SIZE_CLASSES.len() as u32 {
        for layer in [0, 7, TEXTURE_LAYER_MASK] {
            let reference = texture_ref(class, layer);
            assert_ne!(reference, NO_TEXTURE);
            assert_eq!(texture_ref_parts(reference), Some((class, layer)));
        }
    }
    assert_eq!(texture_ref_parts(NO_TEXTURE), None);
    assert_eq!(TEXTURE_SIZE_CLASSES, [256, 512, 1024, 2048]);
}

/// Bindings of `entries` visible to `stage`, by WebGPU's per-stage limit classes.
fn stage_counts(entries: &[wgpu::BindGroupLayoutEntry], stage: wgpu::ShaderStages) -> StageCounts {
    let mut counts = StageCounts::default();
    for entry in entries.iter().filter(|entry| entry.visibility.contains(stage)) {
        let kind = match entry.ty {
            wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, .. } => BindingKind::Uniform,
            wgpu::BindingType::Buffer { .. } => BindingKind::Storage,
            wgpu::BindingType::Sampler(_) => BindingKind::Sampler,
            wgpu::BindingType::Texture { .. } => BindingKind::Texture2d,
            ref other => panic!("binding {} is {other:?}: no storage textures or arrays in the frame group", entry.binding),
        };
        counts.add(kind);
    }
    counts
}

/// The kind of an RQ4 effect slot ([`FRAME_EFFECT_BINDINGS`]): the v2 map's, the fog uniform, or
/// a 2D texture.
fn effect_kind(name: &str) -> BindingKind {
    match MATERIAL_V2_BINDINGS.iter().find(|row| row.name == name) {
        Some(v2) => v2.kind,
        None if name == "frame_fog" => BindingKind::Uniform,
        None => BindingKind::Texture2d,
    }
}

/// The RQ4 effect slots the forward frame layout does not bind yet ([`FRAME_EFFECT_BINDINGS`]
/// past [`FRAME_EFFECT_BOUND`]): the ones a later producer adds.
fn unbound_effect_slots() -> impl Iterator<Item = (u32, &'static str)> {
    FRAME_EFFECT_BINDINGS.into_iter().filter(|slot| !FRAME_EFFECT_BOUND.contains(slot))
}

#[test]
fn the_forward_frame_layout_binds_the_rq6_tables_under_the_v2_maps_names_and_types() {
    use genex_render::layout::{FRAME_LIGHT_BINDINGS, FRAME_MATERIAL_CLASS_BINDINGS};
    let core = wgpu::Limits::defaults();
    let entries = genex_render::renderer::frame_layout_entries();
    let at = |binding: u32| entries.iter().find(|entry| entry.binding == binding).unwrap_or_else(|| panic!("the frame layout binds {binding}"));
    for (binding, name) in FRAME_LIGHT_BINDINGS {
        // LG-16: the one bin table takes the type of the v2 map's z-bins (both slices of it).
        let twin = genex_render::layout::frame_light_v2_twin(name);
        let v2 = MATERIAL_V2_BINDINGS.iter().find(|row| row.name == twin).unwrap_or_else(|| panic!("the v2 map names {twin}"));
        assert_eq!(at(binding).ty, v2.kind.binding_type(false, v2.bytes), "{name}");
        assert_eq!(at(binding).visibility, wgpu::ShaderStages::FRAGMENT, "{name}");
    }
    let class_array = wgpu::BindingType::Texture {
        sample_type: wgpu::TextureSampleType::Float { filterable: true },
        view_dimension: wgpu::TextureViewDimension::D2Array,
        multisampled: false,
    };
    for (binding, name) in FRAME_MATERIAL_CLASS_BINDINGS {
        assert_eq!(at(binding).ty, class_array, "{name} is a filterable colour array like the class-0 pair");
    }
    // The bound RQ4 effect slots are in the layout at their bindings (RQ4.6), and no slot collides
    // with another, nor with the RQ4 effect slots a later producer binds.
    for (binding, name) in FRAME_EFFECT_BOUND {
        assert!(entries.iter().any(|entry| entry.binding == binding), "the frame layout binds {name} at {binding}");
    }
    let mut bindings: Vec<u32> = entries.iter().map(|entry| entry.binding).chain(unbound_effect_slots().map(|(binding, _)| binding)).collect();
    let all = bindings.len();
    bindings.sort_unstable();
    bindings.dedup();
    assert_eq!(bindings.len(), all, "{bindings:?}");
    assert!(bindings.iter().all(|binding| *binding < core.max_bindings_per_bind_group));
    assert_eq!(FRAME_MATERIAL_CLASS_BINDINGS.len(), 2 * (genex_render::layout::TEXTURE_SIZE_CLASSES.len() - 1));
    assert!(FRAME_MATERIAL_CLASS_BINDINGS.len() as u32 <= FORWARD_EXTRA_MATERIAL_ARRAYS_MAX);
}

// Renderer pass 2 A.4 renamed this row (was `..._fits_webgpu_core_with_headroom`): D1 spends the
// two sampled textures of headroom it held.
#[test]
fn the_forward_frame_layout_with_every_reserved_slot_fits_webgpu_core() {
    let core = wgpu::Limits::defaults();
    let entries = genex_render::renderer::frame_layout_entries();
    let mut fragment = stage_counts(&entries, wgpu::ShaderStages::FRAGMENT);
    for (_, name) in unbound_effect_slots() {
        fragment.add(effect_kind(name));
    }
    // frame, env_sh, fog; lights, materials, light_ext, light_bins, material_ext (pass 2 A.0
    // LG-16 flipped 6 -> 5 storage buffers: the tile masks share the z-bin table) and the
    // reflection probes' rows (A.3 flipped 5 -> 6); shadow array, two class-0 arrays, the env
    // cube (A.3: the probe cube array in its slot), BRDF LUT, six size-class arrays, AO, aerial
    // perspective, contact shadows; shadow comparison, texture, environment and point samplers.
    // Renderer pass 2 A.4 flipped the sampled textures 14 -> 15 (the irradiance volumes' atlas)
    // and the headroom row: under owner decision D1 the forward stage may use all of core's 16.
    // The look pass (B.9's frame hook) flipped them 15 -> 16: the screen reflections at binding 30.
    // Game systems LOD-04 flipped the storage buffers 6 -> 7: the instance fade table (binding 31).
    assert_eq!(
        (fragment.uniform_buffers, fragment.storage_buffers, fragment.sampled_textures, fragment.samplers),
        (3, 7, 16, 4),
        "{fragment:?}"
    );
    assert!(fragment.sampled_textures <= FORWARD_FRAGMENT_TEXTURES_MAX);
    assert!(FORWARD_FRAGMENT_TEXTURES_MAX <= core.max_sampled_textures_per_shader_stage, "the forward stage's cap is within core's");
    assert!(fragment.storage_buffers <= core.max_storage_buffers_per_shader_stage);
    assert!(fragment.uniform_buffers <= core.max_uniform_buffers_per_shader_stage);
    assert!(fragment.samplers <= core.max_samplers_per_shader_stage);
    let vertex = stage_counts(&entries, wgpu::ShaderStages::VERTEX);
    assert_eq!((vertex.uniform_buffers, vertex.storage_buffers, vertex.sampled_textures), (1, 3, 0), "{vertex:?}");
}

#[test]
fn the_rq6_shaders_validate_against_core_emit_everywhere_and_keep_the_format_rules() {
    let core = wgpu::Limits::defaults();
    for (name, source) in rq6_shaders() {
        let module = parse(name, source);
        let info = validated(name, &module);
        emit(name, &module, &info, &[]);
        assert!(storage_textures(&module).is_empty(), "{name}: the bins are buffers");
        assert!(workgroup_bytes(&module) <= WORKGROUP_SHARED_BYTES_MAX, "{name}");
        let counts = counts_in(&module);
        assert!(counts.storage_buffers <= core.max_storage_buffers_per_shader_stage, "{name}: {counts:?}");
    }
    let bin = parse("light-bin", rq6_shaders()[0].1);
    let entry = bin.entry_points.iter().find(|entry| entry.name == genex_render::cluster::LIGHT_BIN_ENTRY).expect("binning entry");
    assert_eq!(entry.workgroup_size, [genex_render::cluster::LIGHT_BIN_WORKGROUP, 1, 1]);
    let spot = parse("spot-shadow", rq6_shaders()[1].1);
    let entry = spot.entry_points.iter().find(|entry| entry.name == genex_render::spot_shadow::SPOT_SHADOW_VERTEX_ENTRY).expect("spot shadow entry");
    assert_eq!(invariant_position(&spot, entry), Some(true), "a depth-writing vertex entry declares an invariant position");
}

#[test]
fn the_light_binning_node_lands_and_the_legacy_plan_keeps_its_light_table() {
    use genex_render::graph::{NodeId, Target, feature_landed, quality_allows, schedule};
    use genex_render::lights::SpotLight;
    use genex_render::scene::{CameraDesc, FramePlan, MeshLibrary, PointLight, Scene};
    use genex_render::settings::{Quality, RenderFeature};
    // RQ6.7 flipped (was `the_rq6_nodes_stay_unlanded_so_the_picture_is_unchanged`): graph node 4
    // builds the bins on the GPU, so it is landed, writes the bins and runs when asked.
    assert!(NodeId::LightBinning.landed(), "light binning lands with RQ6.7");
    assert_eq!(NodeId::LightBinning.writes(), &[Target::LightBins]);
    assert!(feature_landed(RenderFeature::Clustered));
    let mut asked = Quality::off();
    asked.set_feature(RenderFeature::Clustered, true);
    let nodes = |quality: &Quality| -> Vec<NodeId> { schedule(|id| quality_allows(id, quality)).iter().flat_map(|step| step.nodes()).collect() };
    assert!(nodes(&asked).contains(&NodeId::LightBinning), "asking for binned lights schedules node 4");
    assert!(!nodes(&Quality::off()).contains(&NodeId::LightBinning), "the legacy quality never bins");
    // The legacy plan's light table leaves spots out (the binned path shades them).
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 2.0, 8.0], [0.0, 0.0, 0.0]), [0, 0, 0, 255]);
    scene.lighting.points.push(PointLight { position: [1.0, 2.0, 0.0], range: 5.0, color: [255, 200, 120], intensity: 3.0 });
    let without = FramePlan::build(&scene, &MeshLibrary::new(), 1.0).expect("plan");
    scene.lighting.spots.push(SpotLight {
        position: [0.0, 3.0, 0.0],
        direction: [0.0, -1.0, 0.0],
        range: 8.0,
        color: [255, 255, 255],
        intensity: 5.0,
        inner_angle: 0.3,
        outer_angle: 0.5,
        shadow: true,
    });
    let with = FramePlan::build(&scene, &MeshLibrary::new(), 1.0).expect("plan");
    assert_eq!(with.lights, without.lights);
    assert_eq!(with.frame, without.frame, "no light count, no shadowed spot");
}

/// The forward fragment stage's storage-buffer plan (renderer pass 2 section 2, LG-16): five
/// today, then the reflection-probe rows (A.3) and the decal rows (A.10) take one each, so it ends
/// at seven of core's eight. Lights, decals and probes are binned into one table (`light_bins`).
// Renderer pass 2 A.3 flipped 5 -> 6 (the reflection probes' rows). The decal rows (A.10) landed
// in the light tables, so game systems LOD-04 flipped 6 -> 7 with the slot they had held: the
// instance fade table (frame binding 31, fragment-only), leaving one of core's eight spare.
const FORWARD_FRAGMENT_STORAGE_TODAY: u32 = 7;
const FORWARD_FRAGMENT_STORAGE_TIER_A: u32 = FORWARD_FRAGMENT_STORAGE_TODAY;

#[test]
fn the_forward_fragment_stage_leaves_tier_a_its_storage_slots_and_every_stage_stays_within_eight() {
    let core = wgpu::Limits::defaults();
    assert_eq!(core.max_storage_buffers_per_shader_stage, 8);
    let module = parse("forward", shader("forward"));
    let info = validated("forward", &module);
    let fragment = stage_counts_in(&module, &info, naga::ShaderStage::Fragment);
    assert_eq!(fragment.storage_buffers, FORWARD_FRAGMENT_STORAGE_TODAY, "LG-16: one light-bin table for tiles and z-bins: {fragment:?}");
    assert!(FORWARD_FRAGMENT_STORAGE_TIER_A < core.max_storage_buffers_per_shader_stage, "probe and decal rows fit with one slot spare");
    let entries = genex_render::renderer::frame_layout_entries();
    let stage = |visibility: wgpu::ShaderStages| {
        let storage = |entry: &&wgpu::BindGroupLayoutEntry| matches!(entry.ty, wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { .. }, .. });
        entries.iter().filter(|entry| entry.visibility.contains(visibility)).filter(storage).count() as u32
    };
    assert_eq!(stage(wgpu::ShaderStages::FRAGMENT), FORWARD_FRAGMENT_STORAGE_TODAY, "the frame layout counted the WebGPU way");
    // Every renderer shader's every entry point reads at most core's eight (the planning rule).
    for (name, source) in SHADERS {
        let module = parse(name, source);
        let info = validated(name, &module);
        for (index, entry) in module.entry_points.iter().enumerate() {
            let used = module
                .global_variables
                .iter()
                .filter(|(handle, global)| matches!(global.space, naga::AddressSpace::Storage { .. }) && !info.get_entry_point(index)[*handle].is_empty())
                .count() as u32;
            assert!(used <= core.max_storage_buffers_per_shader_stage, "{name} {}: {used} storage buffers", entry.name);
        }
    }
}

// Game systems AN-18: vertex-shader skinning reads two tables in the vertex stage (the skin rows
// and the vertex skin table, as the grass reads its blades) and none in the fragment: the forward
// fragment's storage and texture counts are unchanged, and each of its pipelines' layouts stays
// within core's eight vertex-stage storage buffers.
#[test]
fn vertex_skinning_reads_two_vertex_tables_and_leaves_the_forward_fragment_unchanged() {
    let core = wgpu::Limits::defaults();
    let forward = parse("forward", shader("forward"));
    let forward_info = validated("forward", &forward);
    let skinned = parse("skin-vertex", shader("skin-vertex"));
    let skinned_info = validated("skin-vertex", &skinned);
    let (vertex, fragment) = genex_render::skin_vertex::FORWARD_ENTRIES;
    let mut plain = storage_buffers_used(&forward, &forward_info, "vs_main");
    plain.extend(["skin_vertex_rows".to_owned(), "skin_vertex_table".to_owned()]);
    plain.retain(|name| name != "visible" && name != "slot_base" && name != "instances");
    let mut used = storage_buffers_used(&skinned, &skinned_info, vertex);
    used.retain(|name| name != "visible" && name != "slot_base" && name != "instances");
    assert_eq!(used, plain, "the vertex stage reads the two tables, not the visible list");
    let shaded = stage_counts_in(&skinned, &skinned_info, naga::ShaderStage::Fragment);
    let before = stage_counts_in(&forward, &forward_info, naga::ShaderStage::Fragment);
    assert_eq!((shaded.storage_buffers, shaded.sampled_textures), (before.storage_buffers, before.sampled_textures), "the fragment is fs_main's");
    assert_eq!(shaded.storage_buffers, FORWARD_FRAGMENT_STORAGE_TODAY);
    assert_eq!(fragment, "fs_main");
    // The pipelines' layouts, counted the WebGPU way: the frame (or casters') group, the motion
    // node's two tables on the motion prepass, and the two tables.
    let frame = layout_storage_buffers(&genex_render::renderer::frame_layout_entries(), wgpu::ShaderStages::VERTEX);
    for (name, others) in [("world", frame), ("motion prepass", frame + 2)] {
        assert!(others + 2 <= core.max_storage_buffers_per_shader_stage, "{name}: {} vertex storage buffers", others + 2);
    }
    for (name, source, entry) in [
        ("skin-vertex-prepass", shader("skin-vertex-prepass"), genex_render::skin_vertex::MOTION_ENTRIES.0),
        ("skin-vertex-shadow", shader("skin-vertex-shadow"), genex_render::skin_vertex::SHADOW_VERTEX_ENTRY),
    ] {
        let module = parse(name, source);
        let info = validated(name, &module);
        let used = storage_buffers_used(&module, &info, entry);
        assert!(used.contains(&"skin_vertex_rows".to_owned()) && used.contains(&"skin_vertex_table".to_owned()), "{name}: {used:?}");
        assert!(used.len() as u32 <= core.max_storage_buffers_per_shader_stage, "{name}: {used:?}");
    }
}

/// Lane FR: the prepass's surface twin (`shaders::PREPASS_SURFACE`) draws the plain batches into
/// the motion prepass's three targets and the reflections' surface texel through the frame group,
/// the pass view and the motion node's group, so it holds the motion prepass's vertex tables and
/// the forward fragment's, within WebGPU core's per-stage limits, its four attachments within
/// core's bytes per sample and its varyings within core's inter-stage variables: the same on
/// every destination that traces (desktop `high` and `ultra`, a desktop browser's too).
#[test]
fn the_prepass_surface_twin_stays_within_webgpu_core_limits() {
    let core = wgpu::Limits::defaults();
    let module = parse("prepass-surface", shader("prepass-surface"));
    let info = validated("prepass-surface", &module);
    let used = storage_buffers_used(&module, &info, "vs_prepass_surface");
    assert!(used.contains(&"prev_models".to_owned()), "the vertex stage reads last frame's rows: {used:?}");
    let frame = layout_storage_buffers(&genex_render::renderer::frame_layout_entries(), wgpu::ShaderStages::VERTEX);
    // The motion node's group shows two tables to the vertex stage, as on the motion prepass.
    assert!(frame + 2 <= core.max_storage_buffers_per_shader_stage, "{} vertex storage buffers in the layout", frame + 2);
    for stage in [naga::ShaderStage::Vertex, naga::ShaderStage::Fragment] {
        let counts = stage_counts_in(&module, &info, stage);
        assert!(counts.storage_buffers <= core.max_storage_buffers_per_shader_stage, "{stage:?}: {counts:?}");
        assert!(counts.sampled_textures <= core.max_sampled_textures_per_shader_stage, "{stage:?}: {counts:?}");
        assert!(counts.samplers <= core.max_samplers_per_shader_stage, "{stage:?}: {counts:?}");
        assert!(counts.uniform_buffers <= core.max_uniform_buffers_per_shader_stage, "{stage:?}: {counts:?}");
    }
    let targets = genex_render::motion::surface_targets();
    assert!(targets.len() as u32 <= core.max_color_attachments);
    // WebGPU's rule: each target's byte cost after its component alignment.
    let bytes = targets.iter().flatten().fold(0u32, |sum, target| {
        let align = target.format.target_component_alignment().expect("a colour target");
        sum.div_ceil(align) * align + target.format.target_pixel_byte_cost().expect("a colour target")
    });
    assert!(bytes <= core.max_color_attachment_bytes_per_sample, "{bytes} bytes per sample");
    let entry = module.entry_points.iter().find(|point| point.name == "vs_prepass_surface").expect("the vertex entry");
    let result = entry.function.result.as_ref().expect("its outputs");
    let naga::TypeInner::Struct { members, .. } = &module.types[result.ty].inner else { panic!("a struct of outputs") };
    let varyings = members.iter().filter(|member| matches!(member.binding, Some(naga::Binding::Location { .. }))).count() as u32;
    assert!(varyings <= core.max_inter_stage_shader_variables, "{varyings} varyings");
}
