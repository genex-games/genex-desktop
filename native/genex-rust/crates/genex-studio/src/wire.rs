//! Contract v2's wire: the Rust side of the host's `src/shared/native-contract.ts` (and the touch
//! shape of `src/shared/preview-contract.ts`). Both sides are held to
//! `tests/fixtures/native-wire-v2.json` by their own tests; change the three together.
//!
//! What v2 adds to the v1 verbs, which stay byte for byte as `verbs.rs` serves them:
//!
//! - `ready` states [`PROTOCOL_VERSION`] and carries the capability [`Receipt`] inline (tier core,
//!   the WebGPU-core [`Backend`], the adapter, the offered [`NativeEnhanced`] features and the
//!   extension API versions); `backend.api` names the receipt's backend. The host refuses a v2
//!   `ready` without a receipt, with a GL backend or a tier other than core, and a receipt past
//!   [`RECEIPT_MAX_BYTES`].
//! - `state()` carries `lifecycle` ([`Lifecycle`]) and `safeArea` ([`SafeArea`]): the host refuses
//!   a v2 game's state without them.
//! - `input` takes `touch` actions ([`Touch`], parsed by [`parse_touch`]): start, move and end
//!   with a uint32 id, in world coordinates.
//! - The GPU refusals ([`GpuRefusal`]) and bounds ([`GpuBound`]) are typed codes the host matches,
//!   never English.
//! - Embedded runs: [`parse_surface`] and [`parse_release`] check the ring verbs' arguments, and
//!   [`ring_point_to_world`] maps Live's ring-pixel pointer through the letterbox.
//! - The renderer's quality (`src/shared/render-quality.ts`): the `renderSettings` verb
//!   ([`parse_render_settings`], [`RenderSettingsAnswer`]), `state().volatile.render`
//!   ([`RenderStatus`]) and a capture's `render` provenance ([`CaptureProvenance`]). The receipt
//!   lists every extension API version served, the renderer's own optional features, the inputs a
//!   v2 extension really gets and, once served, the verb's version ([`RENDER_SETTINGS_API_VERSION`]).
//!
//! `verbs.rs` sends [`ready_fields`]' receipt and protocol 2 in `ready` and adds
//! [`set_state_v2`]'s fields to every state snapshot.

use std::fmt;

use genex_core::json::Value;

/// Protocol 1: every C++ · raylib game, and a Rust game made before contract v2. Frozen.
pub const PROTOCOL_V1: u32 = 1;
/// The protocol a contract v2 game states in `ready`.
pub const PROTOCOL_VERSION: u32 = 2;
/// The `contractVersion` a contract v2 game states in `ready` and `state()`.
pub const CONTRACT_VERSION_V2: u32 = 2;
/// The highest WGSL extension points' bind layout version (`gfx.material`, `gfx.post_pass`).
pub const EXTENSION_API_VERSION: u32 = 2;
/// Every extension API version a receipt serves, ascending, ending in [`EXTENSION_API_VERSION`].
pub const EXTENSION_APIS: [u32; 2] = [1, 2];
/// The highest custom GPU pass API version (extension ladder level 3, `genex::gpu`).
pub const CUSTOM_PASS_API_VERSION: u32 = 2;
/// Every custom pass API version a receipt serves, ascending, ending in [`CUSTOM_PASS_API_VERSION`].
pub const CUSTOM_PASS_APIS: [u32; 2] = [1, 2];
/// The most bytes the receipt may take as JSON; the host refuses a larger one before reading it.
pub const RECEIPT_MAX_BYTES: usize = 4 * 1024;
/// The adapter name the receipt carries is cut to this many characters (the host's text cap),
/// counted as the host counts them: UTF-16 code units, so a character outside the Basic
/// Multilingual Plane counts two.
pub const ADAPTER_MAX_CHARS: usize = 256;
/// The longest WGSL source the renderer and the lane's naga step take (genex-render's cap).
pub const WGSL_MAX_BYTES: usize = 256 * 1024;
/// The largest touch id (a uint32 the sender picks).
pub const TOUCH_ID_MAX: u32 = u32::MAX;
/// The largest safe-area inset, in physical pixels.
pub const SAFE_AREA_INSET_MAX_PX: u32 = 16_384;
/// The most ring slots an embedded run's `surface` may ask for (`NATIVE_FRAME_SLOTS`).
pub const RING_SLOTS_MAX: u32 = 3;
/// The longest side of a ring slot, in device pixels (`NATIVE_FRAME_SIDE_MAX`).
pub const RING_SIDE_MAX: u32 = 4096;
/// The highest device-pixel ratio Live sends.
pub const RING_DPR_MAX: f64 = 4.0;
/// The `renderSettings` verb's version a receipt advertises (`renderSettingsApi`).
pub const RENDER_SETTINGS_API_VERSION: u32 = 1;
/// The lowest render scale (of the output size) a lock may name (`RENDER_SCALE_MIN`).
pub const RENDER_SCALE_MIN: f64 = 0.5;
/// The highest render scale (`RENDER_SCALE_MAX`).
pub const RENDER_SCALE_MAX: f64 = 1.0;
/// The shortest frame time, in milliseconds, `renderSettings` may ask dynamic resolution to hold
/// (`FRAME_BUDGET_MS_MIN`).
pub const FRAME_BUDGET_MS_MIN: f64 = 1.0;
/// The longest (`FRAME_BUDGET_MS_MAX`).
pub const FRAME_BUDGET_MS_MAX: f64 = 100.0;
/// The most settle frames a capture re-renders (`CAPTURE_SETTLE_FRAMES_MAX`).
pub const CAPTURE_SETTLE_FRAMES_MAX: u32 = 16;
/// The most API versions one receipt list carries (the host refuses a longer one).
pub const API_VERSIONS_MAX: usize = 16;

/// The `input` action kind of a touch (`NativeInputKind.Touch`).
pub const INPUT_TOUCH: &str = "touch";
/// The embedded-run verb that creates the shared-image ring (`NativeOp.Surface`).
pub const OP_SURFACE: &str = "surface";
/// The embedded-run verb that gives a slot back (`NativeOp.Release`).
pub const OP_RELEASE: &str = "release";
/// `ready`'s receipt member.
pub const READY_RECEIPT: &str = "receipt";
/// `state()`'s lifecycle member.
pub const STATE_LIFECYCLE: &str = "lifecycle";
/// `state()`'s safe-area member.
pub const STATE_SAFE_AREA: &str = "safeArea";
/// The verb that reads or changes the renderer's quality (`NativeOp.RenderSettings`).
pub const OP_RENDER_SETTINGS: &str = "renderSettings";
/// The `state().volatile` key of what the renderer runs with, and a capture reply's provenance key
/// (`NATIVE_RENDER_KEY`). Outside the checksum; never compared.
pub const STATE_RENDER: &str = "render";

/// A wire value outside its shape: the field that failed. The host's own check refuses the same.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BadField(pub &'static str);

impl fmt::Display for BadField {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "bad-field: {}", self.0)
    }
}

impl std::error::Error for BadField {}

/// Declares a wire vocabulary: the variants, their spellings, `ALL`, `wire` and `from_wire`.
macro_rules! vocabulary {
    ($(#[$meta:meta])* $name:ident { $($(#[$vmeta:meta])* $variant:ident => $wire:literal,)+ }) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub enum $name {
            $($(#[$vmeta])* $variant,)+
        }

        impl $name {
            /// Every value, in the wire table's order.
            pub const ALL: &'static [$name] = &[$($name::$variant,)+];

            /// The wire spelling. Never renamed once shipped.
            pub const fn wire(self) -> &'static str {
                match self {
                    $($name::$variant => $wire,)+
                }
            }

            /// The value a wire spelling names, if any.
            pub fn from_wire(text: &str) -> Option<$name> {
                $name::ALL.iter().copied().find(|value| value.wire() == text)
            }
        }
    };
}

vocabulary! {
    /// Where one finger is in its touch (`TouchPhase`).
    TouchPhase {
        /// The finger went down.
        Start => "start",
        /// The finger moved.
        Move => "move",
        /// The finger lifted.
        End => "end",
    }
}

vocabulary! {
    /// Where the app is in its life (`NativeLifecycle`): a surface exists only while resumed.
    Lifecycle {
        /// Launched, never resumed: no surface yet.
        Launched => "launched",
        /// In the foreground (every desktop and headless run).
        Resumed => "resumed",
        /// In the background (iOS, Android): no surface.
        Suspended => "suspended",
    }
}

vocabulary! {
    /// A WebGPU-core backend (`NativeWgpuBackend`). There is no GL member: wgpu's GL backend is
    /// never built, and the host refuses a receipt naming one.
    Backend {
        /// Metal (macOS, iOS).
        Metal => "metal",
        /// Vulkan (Linux, Android).
        Vulkan => "vulkan",
        /// Direct3D 12 (Windows).
        D3d12 => "d3d12",
        /// The browser's WebGPU.
        WebGpu => "webgpu",
    }
}

vocabulary! {
    /// The receipt's tier (`NativeGpuTier`): always core, the device is opened with core limits.
    Tier {
        /// WebGPU core: compute, storage buffers, indirect draws. Guaranteed everywhere.
        Core => "core",
    }
}

vocabulary! {
    /// Optional wgpu native features (`NativeEnhancedFeature`), as `genex.toml` spells them.
    NativeEnhanced {
        /// `SHADER_INT64_ATOMIC_MIN_MAX`.
        ShaderInt64AtomicMinMax => "shader-int64-atomic-min-max",
        /// `SHADER_INT64_ATOMIC_ALL_OPS`.
        ShaderInt64AtomicAllOps => "shader-int64-atomic-all-ops",
        /// `SUBGROUP`.
        Subgroup => "subgroup",
        /// `EXPERIMENTAL_RAY_QUERY`.
        RayQuery => "ray-query",
        /// `EXPERIMENTAL_MESH_SHADER`.
        MeshShader => "mesh-shader",
        /// `TEXTURE_BINDING_ARRAY` and its non-uniform indexing companions.
        TextureBindingArray => "texture-binding-array",
        /// `MULTI_DRAW_INDIRECT_COUNT`.
        MultiDrawIndirectCount => "multi-draw-indirect-count",
    }
}

vocabulary! {
    /// The GPU refusals a run ends or is refused with (`NativeRefusal`'s v2 members).
    GpuRefusal {
        /// No adapter on a WebGPU-core backend, or one below core limits.
        GpuUnsupported => "gpu-unsupported",
        /// The device was lost; `capture` answers this while it is re-created.
        DeviceLost => "device-lost",
        /// A frame or step deadline passed: taken for a GPU hang.
        GpuHang => "gpu-hang",
        /// A declared native-enhanced feature the device does not offer.
        NativeFeatureMissing => "native-feature-missing",
        /// A web build of a game that declares native-enhanced features.
        NativeFeaturesWeb => "native-features-web",
        /// A custom GPU pass (extension ladder level 3) failed validation.
        GpuPassInvalid => "gpu-pass-invalid",
    }
}

vocabulary! {
    /// The GPU bounds' codes (`NativeGpuBound`, genex-render's `RenderCode` spellings).
    GpuBound {
        /// The device request failed after the floor check passed.
        DeviceFailed => "device-failed",
        /// A WGSL source above [`WGSL_MAX_BYTES`], or one naga refused.
        WgslTooLarge => "wgsl-too-large",
        /// An empty buffer, or one above the core storage binding size.
        BufferTooLarge => "buffer-too-large",
        /// A texture above 4096 × 4096 × 4 bytes.
        TextureTooLarge => "texture-too-large",
        /// One frame's uploads above the per-frame budget.
        UploadBudget => "upload-budget",
        /// A capture above the host's capture cap.
        CaptureTooLarge => "capture-too-large",
        /// A malformed, external-buffer or unknown mesh.
        MeshInvalid => "mesh-invalid",
    }
}

vocabulary! {
    /// A quality preset (`QualityPreset`); `auto` follows the device class.
    QualityPreset {
        /// The device class's own default; never an effective preset.
        Auto => "auto",
        /// The cheapest.
        Low => "low",
        /// Mid-range.
        Medium => "medium",
        /// High.
        High => "high",
        /// Everything on.
        Ultra => "ultra",
    }
}

vocabulary! {
    /// A device class, `<form factor>-<tier>` (`DeviceClass`).
    DeviceClass {
        /// A high-end desktop.
        DesktopUltra => "desktop-ultra",
        /// A good desktop or laptop.
        DesktopHigh => "desktop-high",
        /// A mid-range desktop.
        DesktopMid => "desktop-mid",
        /// An old or integrated laptop.
        DesktopLow => "desktop-low",
        /// A recent iPhone or flagship Android.
        MobileHigh => "mobile-high",
        /// An older iPhone or mid-range Android.
        MobileMid => "mobile-mid",
        /// A weak phone.
        MobileLow => "mobile-low",
    }
}

vocabulary! {
    /// A renderer feature with its own switch (`RenderFeature`).
    RenderFeature {
        /// The HDR scene target.
        Hdr => "hdr",
        /// The tonemapper.
        Tonemap => "tonemap",
        /// Exposure (manual or auto).
        Exposure => "exposure",
        /// Image-based lighting.
        Ibl => "ibl",
        /// The physical sky.
        Sky => "sky",
        /// Sun and spot shadows.
        Shadows => "shadows",
        /// Screen-space contact shadows.
        ContactShadows => "contact-shadows",
        /// Bloom.
        Bloom => "bloom",
        /// Ambient occlusion.
        Ao => "ao",
        /// Height and distance fog.
        Fog => "fog",
        /// Temporal anti-aliasing.
        Taa => "taa",
        /// The spatial upscaler.
        Upscaler => "upscaler",
        /// Clustered (binned) local lights.
        Clustered => "clustered",
        /// Meshlet rendering.
        Meshlets => "meshlets",
        /// Hi-Z occlusion culling.
        Occlusion => "occlusion",
        /// The depth/normal prepass.
        Prepass => "prepass",
        /// Texture size classes above 256 and Toksvig normal-map mips.
        TextureQuality => "texture-quality",
        /// Shadow maps for spot lights that ask for one.
        SpotShadows => "spot-shadows",
    }
}

vocabulary! {
    /// Why a frame runs with less than asked (`DegradeReason`).
    DegradeReason {
        /// A v1 custom pass in the world keeps the frame LDR.
        CustomPassV1InWorld => "custom-pass-v1-in-world",
        /// A v1 custom material in a frame that asked for HDR.
        MaterialV1InHdr => "material-v1-in-hdr",
        /// The preset did not fit the class budget.
        Budget => "budget",
        /// The class's scene format cannot be rendered to here.
        FormatUnrenderable => "format-unrenderable",
        /// A custom pass's bytes are over its share of the budget.
        PassOverBudget => "pass-over-budget",
        /// A pipeline-shaping change waits for the next loading point.
        PipelineChangeDeferred => "pipeline-change-deferred",
        /// Transient attachments are not offered.
        TransientUnsupported => "transient-unsupported",
        /// The preset asks for a knob this build does not draw yet.
        NotLanded => "not-landed",
    }
}

vocabulary! {
    /// Where a capture's settings came from (`SettingsSource`).
    SettingsSource {
        /// The game's `genex.toml` `[render]` preset.
        Toml => "toml",
        /// The reference class the host recorded for the adapter.
        ReferenceClass => "reference-class",
        /// The `renderSettings` verb in this session.
        Verb => "verb",
    }
}

vocabulary! {
    /// How a capture's exposure was settled (`CaptureExposure`).
    CaptureExposure {
        /// Converged at once, with no adaptation history.
        Instant => "instant",
    }
}

vocabulary! {
    /// An optional adapter feature the renderer opens the device with for itself (`RendererFeature`).
    RendererFeature {
        /// `TIMESTAMP_QUERY`: GPU timing for dynamic resolution.
        TimestampQuery => "timestamp-query",
        /// `RG11B10UFLOAT_RENDERABLE`: the compact HDR scene format.
        Rg11b10UfloatRenderable => "rg11b10ufloat-renderable",
        /// `DEPTH_CLIP_CONTROL`: shadow casters drawn with unclipped depth (exact pancaking).
        DepthClipControl => "depth-clip-control",
        /// `TEXTURE_COMPRESSION_BC`: BC7 material textures.
        TextureCompressionBc => "texture-compression-bc",
        /// `TEXTURE_COMPRESSION_ASTC`: ASTC 4x4 material textures.
        TextureCompressionAstc => "texture-compression-astc",
        /// `TEXTURE_COMPRESSION_ETC2`: ETC2 RGBA8 material textures.
        TextureCompressionEtc2 => "texture-compression-etc2",
    }
}

vocabulary! {
    /// A frame input a v2 extension may read (`RenderInput`).
    RenderInput {
        /// Scene depth.
        Depth => "depth",
        /// View-space normals.
        Normals => "normals",
        /// Motion vectors.
        Motion => "motion",
        /// The environment (cube, SH, BRDF LUT).
        Environment => "environment",
        /// Linear HDR scene colour.
        HdrScene => "hdr-scene",
    }
}

vocabulary! {
    /// What a game answers a `renderSettings` it refuses (`RenderSettingsRefusal`).
    RenderSettingsRefusal {
        /// The game knows the verb but this build cannot serve it yet.
        Unavailable => "unavailable",
        /// A preset outside [`QualityPreset`].
        UnknownPreset => "unknown-preset",
        /// A class outside [`DeviceClass`].
        UnknownDeviceClass => "unknown-device-class",
        /// A switch outside [`RenderFeature`].
        UnknownFeature => "unknown-render-feature",
        /// A scale lock outside [`RENDER_SCALE_MIN`]..=[`RENDER_SCALE_MAX`].
        InvalidScale => "invalid-render-scale",
        /// A frame budget outside [`FRAME_BUDGET_MS_MIN`]..=[`FRAME_BUDGET_MS_MAX`].
        InvalidFrameBudget => "invalid-frame-budget",
    }
}

/// What `ready` reports about the GPU (`NativeCapabilityReceipt`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Receipt {
    /// The backend the device runs on.
    pub backend: Backend,
    /// The adapter's name (cut to [`ADAPTER_MAX_CHARS`] on the wire).
    pub adapter: String,
    /// The native-enhanced features the adapter offers (offered, not requested).
    pub native_enhanced: Vec<NativeEnhanced>,
    /// The highest WGSL extension points' bind layout version this runtime serves.
    pub extension_api: u32,
    /// The highest custom GPU pass API version this runtime serves.
    pub custom_pass_api: u32,
    /// Every extension API version served, ascending, ending in `extension_api`.
    pub extension_apis: Vec<u32>,
    /// Every custom pass API version served, ascending, ending in `custom_pass_api`.
    pub custom_pass_apis: Vec<u32>,
    /// The optional features the renderer opened the device with for itself.
    pub renderer_features: Vec<RendererFeature>,
    /// The v2 extension inputs a producer really fills.
    pub render_inputs: Vec<RenderInput>,
    /// The `renderSettings` version served; None until the game serves the verb.
    pub render_settings_api: Option<u32>,
}

/// `text` cut to at most `units` UTF-16 code units, never inside a character.
fn cut_utf16(text: &str, units: usize) -> String {
    let mut used = 0;
    text.chars()
        .take_while(|c| {
            used += c.len_utf16();
            used <= units
        })
        .collect()
}

impl Receipt {
    /// A receipt with this runtime's extension API versions, no renderer features or real
    /// inputs, and no `renderSettings` (the facade fills those it serves).
    pub fn new(backend: Backend, adapter: impl Into<String>, native_enhanced: Vec<NativeEnhanced>) -> Receipt {
        Receipt {
            backend,
            adapter: adapter.into(),
            native_enhanced,
            extension_api: EXTENSION_API_VERSION,
            custom_pass_api: CUSTOM_PASS_API_VERSION,
            extension_apis: EXTENSION_APIS.to_vec(),
            custom_pass_apis: CUSTOM_PASS_APIS.to_vec(),
            renderer_features: Vec::new(),
            render_inputs: Vec::new(),
            render_settings_api: None,
        }
    }

    /// The receipt as the wire's object: `{tier, backend, adapter, nativeEnhanced, extensionApi,
    /// customPassApi, extensionApis, customPassApis, rendererFeatures, renderInputs,
    /// renderSettingsApi?}`, the adapter cut to [`ADAPTER_MAX_CHARS`] and each name listed once.
    pub fn to_value(&self) -> Value {
        let adapter = cut_utf16(&self.adapter, ADAPTER_MAX_CHARS);
        let mut receipt = Value::object();
        receipt.set("tier", Value::from(Tier::Core.wire()));
        receipt.set("backend", Value::from(self.backend.wire()));
        receipt.set("adapter", Value::from(adapter));
        receipt.set("nativeEnhanced", distinct(&self.native_enhanced, |feature| feature.wire()));
        receipt.set("extensionApi", Value::from(self.extension_api));
        receipt.set("customPassApi", Value::from(self.custom_pass_api));
        receipt.set("extensionApis", versions(&self.extension_apis));
        receipt.set("customPassApis", versions(&self.custom_pass_apis));
        receipt.set("rendererFeatures", distinct(&self.renderer_features, |feature| feature.wire()));
        receipt.set("renderInputs", distinct(&self.render_inputs, |input| input.wire()));
        if let Some(version) = self.render_settings_api {
            receipt.set("renderSettingsApi", Value::from(version));
        }
        receipt
    }

    /// A receipt as the host's `parseNativeCapabilityReceipt` reads one: a receipt from before
    /// the renderer follow-up (singular API fields only) serves `[extensionApi]` and
    /// `[customPassApi]`. Unknown members are ignored; the field that failed otherwise.
    pub fn from_value(value: &Value) -> Result<Receipt, BadField> {
        if value.get("tier").map(Value::as_str) != Some(Tier::Core.wire()) {
            return Err(BadField("tier"));
        }
        let backend = Backend::from_wire(text(value, "backend")?).ok_or(BadField("backend"))?;
        let adapter = text(value, "adapter")?.to_owned();
        let native_enhanced =
            names(value, "nativeEnhanced", NativeEnhanced::from_wire)?.ok_or(BadField("nativeEnhanced"))?;
        let extension_api = whole(value, "extensionApi", u32::MAX)?;
        let custom_pass_api = whole(value, "customPassApi", u32::MAX)?;
        let render_settings_api = match value.get("renderSettingsApi") {
            None => None,
            Some(_) => Some(whole(value, "renderSettingsApi", u32::MAX)?),
        };
        Ok(Receipt {
            backend,
            adapter,
            native_enhanced,
            extension_api,
            custom_pass_api,
            extension_apis: api_list(value, "extensionApis", extension_api)?,
            custom_pass_apis: api_list(value, "customPassApis", custom_pass_api)?,
            renderer_features: names(value, "rendererFeatures", RendererFeature::from_wire)?.unwrap_or_default(),
            render_inputs: names(value, "renderInputs", RenderInput::from_wire)?.unwrap_or_default(),
            render_settings_api,
        })
    }

    /// The receipt's JSON bytes, as the `ready` line carries them.
    pub fn to_json(&self) -> Vec<u8> {
        self.to_value().dump()
    }
}

/// Each value once, in order, as wire names.
fn distinct<T: Copy + PartialEq>(values: &[T], wire: fn(T) -> &'static str) -> Value {
    let mut listed: Vec<T> = Vec::new();
    let mut out = Value::array();
    for value in values {
        if !listed.contains(value) {
            listed.push(*value);
            out.push(Value::from(wire(*value)));
        }
    }
    out
}

fn versions(list: &[u32]) -> Value {
    let mut out = Value::array();
    for version in list {
        out.push(Value::from(*version));
    }
    out
}

fn text<'a>(value: &'a Value, key: &'static str) -> Result<&'a str, BadField> {
    match value.get(key) {
        Some(Value::String(_)) => Ok(value[key].as_str()),
        _ => Err(BadField(key)),
    }
}

/// A list of distinct wire names `from_wire` knows; None when the member is absent.
fn names<T: PartialEq>(
    value: &Value,
    key: &'static str,
    from_wire: fn(&str) -> Option<T>,
) -> Result<Option<Vec<T>>, BadField> {
    let Some(list) = value.get(key) else { return Ok(None) };
    if !matches!(list, Value::Array(_)) {
        return Err(BadField(key));
    }
    let mut out: Vec<T> = Vec::new();
    for item in list.items() {
        let known = match item {
            Value::String(_) => from_wire(item.as_str()),
            _ => None,
        };
        match known {
            Some(name) if !out.contains(&name) => out.push(name),
            _ => return Err(BadField(key)),
        }
    }
    Ok(Some(out))
}

/// An API version list: ascending, distinct, ending in `highest`; `[highest]` when absent.
fn api_list(value: &Value, key: &'static str, highest: u32) -> Result<Vec<u32>, BadField> {
    let Some(list) = value.get(key) else { return Ok(vec![highest]) };
    let items = match list {
        Value::Array(items) if !items.is_empty() && items.len() <= API_VERSIONS_MAX => items,
        _ => return Err(BadField(key)),
    };
    let mut out: Vec<u32> = Vec::new();
    for item in items {
        let version = match item {
            Value::Number(number) if number.fract() == 0.0 && *number >= 1.0 && *number <= f64::from(u32::MAX) => {
                // Whole and in range, so the conversion is exact.
                *number as u32
            }
            _ => return Err(BadField(key)),
        };
        if out.last().is_some_and(|last| *last >= version) {
            return Err(BadField(key));
        }
        out.push(version);
    }
    if out.last() != Some(&highest) {
        return Err(BadField(key));
    }
    Ok(out)
}

/// The v2 members `ready` adds to the v1 event: `protocol` 2, `contractVersion` 2, a `backend`
/// naming the receipt's backend and adapter, and the `receipt` itself, in that order.
pub fn ready_fields(receipt: &Receipt) -> Vec<(&'static str, Value)> {
    let receipt_value = receipt.to_value();
    let mut backend = Value::object();
    backend.set("api", Value::from(receipt.backend.wire()));
    backend.set("device", receipt_value.get("adapter").cloned().unwrap_or_default());
    vec![
        ("protocol", Value::from(PROTOCOL_VERSION)),
        ("contractVersion", Value::from(CONTRACT_VERSION_V2)),
        ("backend", backend),
        (READY_RECEIPT, receipt_value),
    ]
}

/// Insets from each edge, in physical pixels (`NativeSafeArea`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SafeArea {
    /// From the top edge.
    pub top: u32,
    /// From the left edge.
    pub left: u32,
    /// From the bottom edge.
    pub bottom: u32,
    /// From the right edge.
    pub right: u32,
}

impl SafeArea {
    /// The wire's object, each inset held to [`SAFE_AREA_INSET_MAX_PX`].
    pub fn to_value(&self) -> Value {
        let mut area = Value::object();
        for (key, inset) in [("top", self.top), ("left", self.left), ("bottom", self.bottom), ("right", self.right)] {
            area.set(key, Value::from(inset.min(SAFE_AREA_INSET_MAX_PX)));
        }
        area
    }
}

/// The `state().volatile` key that holds what the GPU encoder issued for the last frame
/// (`{encoderDraws, dispatches, passes}`): reported apart from the logical `drawCalls`, never compared.
pub const STATE_GPU: &str = "gpu";
/// The key under `state().volatile` that lists a game's custom GPU passes (extension ladder
/// level 3) with whether each still runs and, when not, its typed refusal: the host reads a
/// `gpu-pass-invalid` there, never from stderr. Outside the checksum, as all of `volatile`.
pub const STATE_CUSTOM_PASSES: &str = "customPasses";

/// One custom pass in `volatile.customPasses`: `{name, stage, running, code}`, `code` the
/// refusal's wire code (`gpu-pass-invalid`, a cap's or naga's) or null while it runs.
pub fn custom_pass_status(name: &str, stage: &str, refusal: Option<&str>) -> Value {
    let mut status = Value::object();
    status.set("name", Value::from(name));
    status.set("stage", Value::from(stage));
    status.set("running", Value::Bool(refusal.is_none()));
    status.set("code", refusal.map_or(Value::Null, Value::from));
    status
}

/// Add a v2 game's `lifecycle` and `safeArea` to its `state()` snapshot (an object; anything
/// else is left alone).
pub fn set_state_v2(state: &mut Value, lifecycle: Lifecycle, safe_area: SafeArea) {
    if !matches!(state, Value::Object(_)) {
        return;
    }
    state.set(STATE_LIFECYCLE, Value::from(lifecycle.wire()));
    state.set(STATE_SAFE_AREA, safe_area.to_value());
}

/// One finger's step in world coordinates (`PreviewTouchAction`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Touch {
    /// Start, move or end.
    pub phase: TouchPhase,
    /// Ties a start to its moves and end.
    pub id: u32,
    /// World x.
    pub x: f64,
    /// World y.
    pub y: f64,
}

impl Touch {
    /// The wire's action object.
    pub fn to_value(&self) -> Value {
        let mut action = Value::object();
        action.set("type", Value::from(INPUT_TOUCH));
        action.set("phase", Value::from(self.phase.wire()));
        action.set("id", Value::from(self.id));
        action.set("x", Value::from(self.x));
        action.set("y", Value::from(self.y));
        action
    }
}

fn number(action: &Value, key: &'static str) -> Result<f64, BadField> {
    match action.get(key) {
        Some(Value::Number(value)) if value.is_finite() => Ok(*value),
        _ => Err(BadField(key)),
    }
}

/// A whole number in `0..=max`, as JSON carries it (a double).
fn whole(action: &Value, key: &'static str, max: u32) -> Result<u32, BadField> {
    let value = number(action, key)?;
    let in_range = value.fract() == 0.0 && value >= 0.0 && value <= f64::from(max);
    // In range and whole, so the conversion is exact.
    if in_range { Ok(value as u32) } else { Err(BadField(key)) }
}

/// A `touch` input action, as the host's `parseNativeInput` accepts it: a known phase, a uint32
/// id and finite world coordinates. Unknown members are ignored.
pub fn parse_touch(action: &Value) -> Result<Touch, BadField> {
    if action.get("type").map(Value::as_str) != Some(INPUT_TOUCH) {
        return Err(BadField("type"));
    }
    let phase = match action.get("phase") {
        Some(Value::String(_)) => action["phase"].as_str(),
        _ => "",
    };
    let phase = TouchPhase::from_wire(phase).ok_or(BadField("phase"))?;
    Ok(Touch { phase, id: whole(action, "id", TOUCH_ID_MAX)?, x: number(action, "x")?, y: number(action, "y")? })
}

/// The ring an embedded run's `surface` asks for (`NativeOpArgs[surface]`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SurfaceArgs {
    /// Slot width, device pixels.
    pub width: u32,
    /// Slot height, device pixels.
    pub height: u32,
    /// The screen's device-pixel ratio.
    pub dpr: f64,
    /// Slots in the ring.
    pub slots: u32,
    /// The host-chosen, increasing generation the ring carries.
    pub generation: u32,
}

/// A `surface` argument as the host builds it: sides 1..=[`RING_SIDE_MAX`], dpr in
/// 1..=[`RING_DPR_MAX`], 1..=[`RING_SLOTS_MAX`] slots and a generation from 1.
pub fn parse_surface(arg: &Value) -> Result<SurfaceArgs, BadField> {
    let width = whole(arg, "w", RING_SIDE_MAX)?;
    let height = whole(arg, "h", RING_SIDE_MAX)?;
    let dpr = number(arg, "dpr")?;
    let slots = whole(arg, "slots", RING_SLOTS_MAX)?;
    let generation = whole(arg, "generation", u32::MAX)?;
    if width == 0 {
        return Err(BadField("w"));
    }
    if height == 0 {
        return Err(BadField("h"));
    }
    if !(1.0..=RING_DPR_MAX).contains(&dpr) {
        return Err(BadField("dpr"));
    }
    if slots == 0 {
        return Err(BadField("slots"));
    }
    if generation == 0 {
        return Err(BadField("generation"));
    }
    Ok(SurfaceArgs { width, height, dpr, slots, generation })
}

/// A `release` argument (`{slot, generation}`): the slot back to the game.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReleaseArgs {
    /// The slot.
    pub slot: u32,
    /// The ring generation it belongs to.
    pub generation: u32,
}

/// A `release` argument: a slot below [`RING_SLOTS_MAX`] and a generation from 1.
pub fn parse_release(arg: &Value) -> Result<ReleaseArgs, BadField> {
    let slot = whole(arg, "slot", RING_SLOTS_MAX - 1)?;
    let generation = whole(arg, "generation", u32::MAX)?;
    if generation == 0 {
        return Err(BadField("generation"));
    }
    Ok(ReleaseArgs { slot, generation })
}

/// Where a pointer Live sends in ring pixels (`px: true`) lands in the world: the world is drawn
/// letterboxed into the ring (scaled to fit, centred), so a point on a bar is held to the world's
/// nearest edge. A degenerate ring or world maps to the world's centre.
pub fn ring_point_to_world(point: (f64, f64), ring: (u32, u32), world: (u32, u32)) -> (f64, f64) {
    let (ring_w, ring_h) = (f64::from(ring.0), f64::from(ring.1));
    let (world_w, world_h) = (f64::from(world.0), f64::from(world.1));
    let degenerate = ring_w <= 0.0 || ring_h <= 0.0 || world_w <= 0.0 || world_h <= 0.0;
    if degenerate || !point.0.is_finite() || !point.1.is_finite() {
        return (world_w / 2.0, world_h / 2.0);
    }
    let scale = (ring_w / world_w).min(ring_h / world_h);
    let offset_x = (ring_w - world_w * scale) / 2.0;
    let offset_y = (ring_h - world_h * scale) / 2.0;
    let x = ((point.0 - offset_x) / scale).clamp(0.0, world_w);
    let y = ((point.1 - offset_y) / scale).clamp(0.0, world_h);
    (x, y)
}

/// Feature switches as the wire's object, in order, each feature once (the last switch wins).
fn switches_value(switches: &[(RenderFeature, bool)]) -> Value {
    let mut out = Value::object();
    for (feature, on) in switches {
        out.set(feature.wire(), Value::Bool(*on));
    }
    out
}

/// What `renderSettings {set}` changes (`RenderSettingsChange`); a member left out stays.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RenderSettingsChange {
    /// `Some(Some(preset))` uses `preset`, `Some(None)` (`null`) gives the game's and the
    /// person's own choice back.
    pub preset: Option<Option<QualityPreset>>,
    /// `Some(Some(class))` emulates a class, `Some(None)` gives the probed class back.
    pub device_class: Option<Option<DeviceClass>>,
    /// Feature switches, in the order given.
    pub features: Vec<(RenderFeature, bool)>,
    /// `features: null`: the switches this verb set earlier are given back.
    pub reset_features: bool,
    /// `Some(Some(scale))` holds the render scale, `Some(None)` lets it move again.
    pub render_scale_lock: Option<Option<f64>>,
    /// `Some(Some(ms))` makes dynamic resolution hold `ms` per frame, `Some(None)` gives the
    /// class's frame time back.
    pub frame_budget_ms: Option<Option<f64>>,
}

/// Why a `renderSettings` argument was refused: a typed refusal, or a value outside its shape
/// (the studio's `bad-argument`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettingsArgError {
    /// A value the vocabulary does not know.
    Refused(RenderSettingsRefusal),
    /// A member of the wrong type.
    Bad(BadField),
}

fn optional_vocabulary<T>(
    set: &Value,
    key: &'static str,
    from_wire: fn(&str) -> Option<T>,
    refusal: RenderSettingsRefusal,
) -> Result<Option<Option<T>>, SettingsArgError> {
    match set.get(key) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::String(_)) => {
            from_wire(set[key].as_str()).map(|value| Some(Some(value))).ok_or(SettingsArgError::Refused(refusal))
        }
        Some(_) => Err(SettingsArgError::Bad(BadField(key))),
    }
}

fn feature_switches(set: &Value) -> Result<Vec<(RenderFeature, bool)>, SettingsArgError> {
    let Some(features) = set.get("features").filter(|features| !matches!(features, Value::Null)) else { return Ok(Vec::new()) };
    if !matches!(features, Value::Object(_)) {
        return Err(SettingsArgError::Bad(BadField("features")));
    }
    let mut out = Vec::new();
    for (key, on) in features.members() {
        let feature = std::str::from_utf8(key)
            .ok()
            .and_then(RenderFeature::from_wire)
            .ok_or(SettingsArgError::Refused(RenderSettingsRefusal::UnknownFeature))?;
        let Value::Bool(on) = on else { return Err(SettingsArgError::Bad(BadField("features"))) };
        out.push((feature, *on));
    }
    Ok(out)
}

fn scale_lock(set: &Value) -> Result<Option<Option<f64>>, SettingsArgError> {
    match set.get("renderScaleLock") {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::Number(scale)) if (RENDER_SCALE_MIN..=RENDER_SCALE_MAX).contains(scale) => Ok(Some(Some(*scale))),
        Some(Value::Number(_)) => Err(SettingsArgError::Refused(RenderSettingsRefusal::InvalidScale)),
        Some(_) => Err(SettingsArgError::Bad(BadField("renderScaleLock"))),
    }
}

fn frame_budget(set: &Value) -> Result<Option<Option<f64>>, SettingsArgError> {
    match set.get("frameBudgetMs") {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::Number(ms)) if (FRAME_BUDGET_MS_MIN..=FRAME_BUDGET_MS_MAX).contains(ms) => Ok(Some(Some(*ms))),
        Some(Value::Number(_)) => Err(SettingsArgError::Refused(RenderSettingsRefusal::InvalidFrameBudget)),
        Some(_) => Err(SettingsArgError::Bad(BadField("frameBudgetMs"))),
    }
}

/// A `renderSettings` argument (`NativeOpArgs[renderSettings]`): None for a read (no `set`), the
/// change otherwise. A preset of `auto` is a preset like any other; a null preset, class, lock or
/// feature table clears what this verb set before.
pub fn parse_render_settings(arg: &Value) -> Result<Option<RenderSettingsChange>, SettingsArgError> {
    let Some(set) = arg.get("set") else { return Ok(None) };
    if !matches!(set, Value::Object(_)) {
        return Err(SettingsArgError::Bad(BadField("set")));
    }
    let preset = optional_vocabulary(set, "preset", QualityPreset::from_wire, RenderSettingsRefusal::UnknownPreset)?;
    let device_class =
        optional_vocabulary(set, "deviceClass", DeviceClass::from_wire, RenderSettingsRefusal::UnknownDeviceClass)?;
    Ok(Some(RenderSettingsChange {
        preset,
        device_class,
        features: feature_switches(set)?,
        reset_features: matches!(set.get("features"), Some(Value::Null)),
        render_scale_lock: scale_lock(set)?,
        frame_budget_ms: frame_budget(set)?,
    }))
}

/// What `renderSettings` answers (`RenderSettingsAnswer`): the settings in force after the call.
#[derive(Clone, Debug, PartialEq)]
pub struct RenderSettingsAnswer {
    /// The effective preset (never `auto`).
    pub preset: QualityPreset,
    /// What was asked for (`auto` follows the class).
    pub requested: QualityPreset,
    /// The class in force (emulated or probed).
    pub device_class: DeviceClass,
    /// What the probe found.
    pub detected_class: DeviceClass,
    /// The switches in force.
    pub features: Vec<(RenderFeature, bool)>,
    /// The held render scale, if any.
    pub render_scale_lock: Option<f64>,
    /// The frame time dynamic resolution holds for the verb, if any (`frameBudgetMs`).
    pub frame_budget_ms: Option<f64>,
    /// The last frame's render scale.
    pub scale: f64,
}

impl RenderSettingsAnswer {
    /// The answer as the wire's object.
    pub fn to_value(&self) -> Value {
        let mut answer = Value::object();
        answer.set("preset", Value::from(self.preset.wire()));
        answer.set("requested", Value::from(self.requested.wire()));
        answer.set("deviceClass", Value::from(self.device_class.wire()));
        answer.set("detectedClass", Value::from(self.detected_class.wire()));
        answer.set("features", switches_value(&self.features));
        answer.set("renderScaleLock", self.render_scale_lock.map_or(Value::Null, Value::from));
        answer.set("frameBudgetMs", self.frame_budget_ms.map_or(Value::Null, Value::from));
        answer.set("scale", Value::from(self.scale));
        answer
    }
}

/// One reason in `volatile.render.degraded`, and what it concerns (a pass, a feature) when it says.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Degrade {
    /// The typed reason.
    pub reason: DegradeReason,
    /// The pass or feature it concerns, if any.
    pub subject: Option<String>,
}

/// `state().volatile.render` (`RenderStatus`): what the renderer runs with. Never compared.
#[derive(Clone, Debug, PartialEq)]
pub struct RenderStatus {
    /// The class in force.
    pub device_class: DeviceClass,
    /// The effective preset.
    pub preset: QualityPreset,
    /// The last frame's render scale.
    pub scale: f64,
    /// The switches in force.
    pub features: Vec<(RenderFeature, bool)>,
    /// Why the frame runs with less than asked.
    pub degraded: Vec<Degrade>,
    /// GPU ms (p50 of the window); None without timestamp queries.
    pub gpu_ms: Option<f64>,
    /// CPU encode and submit ms (p50 of the window).
    pub cpu_ms: Option<f64>,
    /// Frames that ran the graph and frames that re-presented the last one, since boot.
    pub frames: Option<(u64, u64)>,
}

impl RenderStatus {
    /// The status as the wire's object.
    pub fn to_value(&self) -> Value {
        let mut degraded = Value::array();
        for entry in &self.degraded {
            let mut item = Value::object();
            item.set("reason", Value::from(entry.reason.wire()));
            item.set("subject", entry.subject.as_deref().map_or(Value::Null, Value::from));
            degraded.push(item);
        }
        let mut status = Value::object();
        status.set("deviceClass", Value::from(self.device_class.wire()));
        status.set("preset", Value::from(self.preset.wire()));
        status.set("scale", Value::from(self.scale));
        status.set("features", switches_value(&self.features));
        status.set("degraded", degraded);
        status.set("gpuMs", self.gpu_ms.map_or(Value::Null, Value::from));
        status.set("cpuMs", self.cpu_ms.map_or(Value::Null, Value::from));
        if let Some((rendered, repeated)) = self.frames {
            let mut frames = Value::object();
            frames.set("rendered", Value::from(rendered));
            frames.set("repeated", Value::from(repeated));
            status.set("frames", frames);
        }
        status
    }
}

/// A capture's `render` provenance (`CaptureProvenance`): the settings a capture was drawn with.
#[derive(Clone, Debug, PartialEq)]
pub struct CaptureProvenance {
    /// The effective preset.
    pub preset: QualityPreset,
    /// The class in force.
    pub device_class: DeviceClass,
    /// Where the settings came from.
    pub settings_source: SettingsSource,
    /// The render scale (the class's nominal step: dynamic resolution never applies to captures).
    pub scale: f64,
    /// Frames re-rendered from one Sim state (1..=[`CAPTURE_SETTLE_FRAMES_MAX`]).
    pub settle_frames: u32,
    /// Whether the capture's history started empty.
    pub history_reset: bool,
    /// How exposure was settled.
    pub exposure: CaptureExposure,
}

impl CaptureProvenance {
    /// The provenance as the wire's object.
    pub fn to_value(&self) -> Value {
        let mut provenance = Value::object();
        provenance.set("preset", Value::from(self.preset.wire()));
        provenance.set("deviceClass", Value::from(self.device_class.wire()));
        provenance.set("settingsSource", Value::from(self.settings_source.wire()));
        provenance.set("scale", Value::from(self.scale));
        provenance.set("settleFrames", Value::from(self.settle_frames.clamp(1, CAPTURE_SETTLE_FRAMES_MAX)));
        provenance.set("historyReset", Value::Bool(self.history_reset));
        provenance.set("exposure", Value::from(self.exposure.wire()));
        provenance
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use genex_core::json;

    /// The fixture both sides hold their names to.
    const FIXTURE: &str = include_str!("../../../../../tests/fixtures/native-wire-v2.json");

    fn fixture() -> Value {
        json::parse(FIXTURE.as_bytes()).expect("the fixture is JSON")
    }

    fn names(value: &Value) -> Vec<String> {
        value.items().iter().map(|item| item.as_str().to_owned()).collect()
    }

    fn wires<T: Copy>(all: &[T], wire: fn(T) -> &'static str) -> Vec<String> {
        all.iter().map(|value| wire(*value).to_owned()).collect()
    }

    fn object(members: &[(&str, Value)]) -> Value {
        let mut value = Value::object();
        for (key, member) in members {
            value.set(*key, member.clone());
        }
        value
    }

    #[test]
    fn the_device_restored_event_is_the_fixtures() {
        let wire = fixture();
        let named = genex_core::protocol::Event::DEVICE_RESTORED;
        assert_eq!(wire["events"]["deviceRestored"], Value::from(named));
    }

    #[test]
    fn the_starting_event_is_the_fixtures() {
        let wire = fixture();
        assert_eq!(wire["events"]["starting"], Value::from(genex_core::protocol::Event::STARTING));
    }

    /// Owner decision D11: the stages a `starting` event names, in boot order, are the host's.
    #[test]
    fn the_boot_stages_are_the_fixtures() {
        let wire = fixture();
        let stages: Vec<String> = genex_core::protocol::BootStage::ALL.iter().map(|stage| stage.wire().to_owned()).collect();
        assert_eq!(names(&wire["bootStages"]), stages);
    }

    #[test]
    fn the_vocabularies_are_the_fixtures() {
        let wire = fixture();
        assert_eq!(wire["protocol"]["v1"].as_f64(), f64::from(PROTOCOL_V1));
        assert_eq!(wire["protocol"]["current"].as_f64(), f64::from(PROTOCOL_VERSION));
        assert_eq!(wire["inputKind"]["touch"].as_str(), INPUT_TOUCH);
        assert_eq!(names(&wire["touchPhases"]), wires(TouchPhase::ALL, TouchPhase::wire));
        assert_eq!(names(&wire["lifecycle"]), wires(Lifecycle::ALL, Lifecycle::wire));
        assert_eq!(names(&wire["wgpuBackends"]), wires(Backend::ALL, Backend::wire));
        assert_eq!(wire["receiptTier"].as_str(), Tier::Core.wire());
        assert_eq!(names(&wire["nativeEnhanced"]), wires(NativeEnhanced::ALL, NativeEnhanced::wire));
        assert_eq!(names(&wire["gpuRefusals"]), wires(GpuRefusal::ALL, GpuRefusal::wire));
        assert_eq!(names(&wire["gpuBounds"]), wires(GpuBound::ALL, GpuBound::wire));
        assert_eq!(wire["extensionApi"].as_f64(), f64::from(EXTENSION_API_VERSION));
        assert_eq!(wire["customPassApi"].as_f64(), f64::from(CUSTOM_PASS_API_VERSION));
        assert_eq!(wire["receiptMaxBytes"].as_f64() as usize, RECEIPT_MAX_BYTES);
        assert_eq!(wire["wgslMaxBytes"].as_f64() as usize, WGSL_MAX_BYTES);
    }

    #[test]
    fn a_receipt_serves_extension_and_custom_pass_apis_one_and_two() {
        let wire = fixture();
        let receipt = Receipt::new(Backend::Metal, "Apple M4 Max", Vec::new());
        assert_eq!((receipt.extension_api, receipt.custom_pass_api), (EXTENSION_API_VERSION, CUSTOM_PASS_API_VERSION));
        assert_eq!(versions(&receipt.extension_apis), wire["extensionApis"]);
        assert_eq!(versions(&receipt.custom_pass_apis), wire["customPassApis"]);
        assert_eq!((EXTENSION_APIS.last(), CUSTOM_PASS_APIS.last()), (Some(&EXTENSION_API_VERSION), Some(&CUSTOM_PASS_API_VERSION)));
        let parsed = Receipt::from_value(&receipt.to_value()).expect("this runtime's receipt parses");
        assert_eq!((parsed.extension_apis, parsed.custom_pass_apis), (EXTENSION_APIS.to_vec(), CUSTOM_PASS_APIS.to_vec()));
    }

    #[test]
    fn no_gl_backend_and_from_wire_refuses_other_spellings() {
        for gl in ["gl", "gles", "opengl", "webgl", "webgl2", "metal-angle", "Metal", ""] {
            assert_eq!(Backend::from_wire(gl), None, "{gl}");
        }
        for backend in Backend::ALL {
            assert_eq!(Backend::from_wire(backend.wire()), Some(*backend));
        }
        assert_eq!(Tier::from_wire("native-enhanced"), None);
        assert_eq!(Tier::from_wire("downlevel"), None);
    }

    #[test]
    fn the_receipt_and_ready_fields_are_the_fixtures_bytes() {
        let wire = fixture();
        let ready = &wire["readyV2"];
        let receipt = Receipt {
            renderer_features: vec![RendererFeature::TimestampQuery, RendererFeature::TimestampQuery],
            ..Receipt::new(
                Backend::Metal,
                "Apple M4 Max",
                vec![NativeEnhanced::Subgroup, NativeEnhanced::MultiDrawIndirectCount, NativeEnhanced::Subgroup],
            )
        };
        assert_eq!(receipt.to_value(), ready["receipt"], "same members, same order, each feature once");
        assert_eq!(receipt.to_json(), ready["receipt"].dump());
        let fields = ready_fields(&receipt);
        let keys: Vec<&str> = fields.iter().map(|(key, _)| *key).collect();
        assert_eq!(keys, ["protocol", "contractVersion", "backend", "receipt"]);
        for (key, value) in &fields {
            assert_eq!(value, &ready[*key], "{key}");
        }
    }

    #[test]
    fn the_largest_receipt_fits_its_cap() {
        // The longest adapter of the worst characters for JSON escaping, every feature twice.
        let adapter: String = std::iter::repeat_n('\u{1}', 300).chain(std::iter::repeat_n('😀', 300)).collect();
        let all = NativeEnhanced::ALL.iter().chain(NativeEnhanced::ALL.iter()).copied().collect();
        let most_versions: Vec<u32> = (u32::MAX - API_VERSIONS_MAX as u32 + 1..=u32::MAX).collect();
        let receipt = Receipt {
            extension_api: u32::MAX,
            custom_pass_api: u32::MAX,
            extension_apis: most_versions.clone(),
            custom_pass_apis: most_versions,
            renderer_features: RendererFeature::ALL.iter().chain(RendererFeature::ALL.iter()).copied().collect(),
            render_inputs: RenderInput::ALL.to_vec(),
            render_settings_api: Some(u32::MAX),
            ..Receipt::new(Backend::WebGpu, adapter, all)
        };
        let bytes = receipt.to_json();
        assert!(bytes.len() <= RECEIPT_MAX_BYTES, "{} bytes", bytes.len());
        assert_eq!(receipt.to_value()["adapter"].as_str().encode_utf16().count(), ADAPTER_MAX_CHARS);
        assert_eq!(receipt.to_value()["nativeEnhanced"].items().len(), NativeEnhanced::ALL.len());
    }

    #[test]
    fn the_adapter_is_cut_by_the_hosts_utf16_count() {
        // The host's text cap counts UTF-16 code units: 300 emoji are 600 units, so 128 fit.
        let emoji: String = std::iter::repeat_n('😀', 300).collect();
        let cut = Receipt::new(Backend::Metal, emoji, Vec::new()).to_value()["adapter"].as_str().to_owned();
        assert_eq!(cut.encode_utf16().count(), ADAPTER_MAX_CHARS);
        assert_eq!(cut.chars().count(), ADAPTER_MAX_CHARS / 2);
        // An odd budget never splits a surrogate pair.
        let mixed: String = std::iter::once('a').chain(std::iter::repeat_n('😀', 300)).collect();
        let cut = Receipt::new(Backend::Metal, mixed, Vec::new()).to_value()["adapter"].as_str().to_owned();
        assert_eq!(cut.encode_utf16().count(), ADAPTER_MAX_CHARS - 1);
    }

    #[test]
    fn a_custom_pass_status_is_the_fixtures_shape() {
        let wire = fixture();
        let pinned = &wire["customPasses"];
        assert_eq!(pinned["key"].as_str(), STATE_CUSTOM_PASSES);
        let refused = custom_pass_status("glow", "post", Some(GpuRefusal::GpuPassInvalid.wire()));
        let running = custom_pass_status("ring", "after-opaque", None);
        assert_eq!(pinned["example"].items(), [refused, running]);
    }

    #[test]
    fn state_v2_adds_lifecycle_and_safe_area() {
        let wire = fixture();
        let mut state = object(&[("phase", Value::from("play"))]);
        set_state_v2(&mut state, Lifecycle::Resumed, SafeArea::default());
        assert_eq!(state["phase"].as_str(), "play");
        assert_eq!(state[STATE_LIFECYCLE], wire["stateV2"]["lifecycle"]);
        assert_eq!(state[STATE_SAFE_AREA], wire["stateV2"]["safeArea"]);
        let mut notch = Value::object();
        set_state_v2(&mut notch, Lifecycle::Suspended, SafeArea { top: 47, left: 0, bottom: 34, right: u32::MAX });
        assert_eq!(notch[STATE_LIFECYCLE].as_str(), "suspended");
        assert_eq!(notch[STATE_SAFE_AREA]["right"].as_f64(), f64::from(SAFE_AREA_INSET_MAX_PX));
        let mut not_an_object = Value::array();
        set_state_v2(&mut not_an_object, Lifecycle::Resumed, SafeArea::default());
        assert_eq!(not_an_object, Value::array());
    }

    fn touch(members: &[(&str, Value)]) -> Value {
        let mut action = object(&[
            ("type", Value::from("touch")),
            ("phase", Value::from("start")),
            ("id", Value::from(3u32)),
            ("x", Value::from(120.5)),
            ("y", Value::from(-4.0)),
        ]);
        for (key, member) in members {
            action.set(*key, member.clone());
        }
        action
    }

    #[test]
    fn a_touch_round_trips_and_each_phase_parses() {
        for phase in TouchPhase::ALL {
            let parsed = parse_touch(&touch(&[("phase", Value::from(phase.wire())), ("pressure", Value::from(0.4))]));
            assert_eq!(parsed, Ok(Touch { phase: *phase, id: 3, x: 120.5, y: -4.0 }));
            let again = parse_touch(&parsed.expect("parsed").to_value());
            assert_eq!(again.map(|t| t.phase), Ok(*phase));
        }
        assert_eq!(parse_touch(&touch(&[("id", Value::from(u32::MAX))])).map(|t| t.id), Ok(u32::MAX));
    }

    #[test]
    fn a_touch_outside_its_shape_is_refused() {
        let rows: Vec<(Value, &str)> = vec![
            (touch(&[("x", Value::Number(f64::NAN))]), "x"),
            (touch(&[("y", Value::Number(f64::INFINITY))]), "y"),
            (touch(&[("x", Value::from("1"))]), "x"),
            (touch(&[("id", Value::Null)]), "id"),
            (touch(&[("id", Value::from(-1.0))]), "id"),
            (touch(&[("id", Value::from(1.5))]), "id"),
            (touch(&[("id", Value::from(4_294_967_296.0))]), "id"),
            (touch(&[("id", Value::from("3"))]), "id"),
            (touch(&[("phase", Value::from("cancel"))]), "phase"),
            (touch(&[("phase", Value::from("Start"))]), "phase"),
            (touch(&[("phase", Value::from(1u32))]), "phase"),
            (touch(&[("type", Value::from("tap"))]), "type"),
        ];
        for (action, field) in rows {
            assert_eq!(parse_touch(&action), Err(BadField(field)), "{}", String::from_utf8_lossy(&action.dump()));
        }
        let mut no_id = Value::object();
        for (key, member) in touch(&[]).members() {
            if key.as_slice() != b"id" {
                no_id.set(key.clone(), member.clone());
            }
        }
        assert_eq!(parse_touch(&no_id), Err(BadField("id")));
    }

    #[test]
    fn surface_and_release_arguments_are_checked() {
        let surface = |w: f64, h: f64, dpr: f64, slots: f64, generation: f64| {
            object(&[
                ("w", Value::from(w)),
                ("h", Value::from(h)),
                ("dpr", Value::from(dpr)),
                ("slots", Value::from(slots)),
                ("generation", Value::from(generation)),
            ])
        };
        assert_eq!(
            parse_surface(&surface(1280.0, 720.0, 2.0, 3.0, 1.0)),
            Ok(SurfaceArgs { width: 1280, height: 720, dpr: 2.0, slots: 3, generation: 1 })
        );
        for (arg, field) in [
            (surface(0.0, 720.0, 2.0, 3.0, 1.0), "w"),
            (surface(4097.0, 720.0, 2.0, 3.0, 1.0), "w"),
            (surface(1280.0, 0.0, 2.0, 3.0, 1.0), "h"),
            (surface(1280.0, 720.0, 0.5, 3.0, 1.0), "dpr"),
            (surface(1280.0, 720.0, 4.5, 3.0, 1.0), "dpr"),
            (surface(1280.0, 720.0, 2.0, 4.0, 1.0), "slots"),
            (surface(1280.0, 720.0, 2.0, 0.0, 1.0), "slots"),
            (surface(1280.0, 720.0, 2.0, 3.0, 0.0), "generation"),
            (surface(1280.0, 720.0, 2.0, 3.0, 4_294_967_296.0), "generation"),
            (surface(1280.5, 720.0, 2.0, 3.0, 1.0), "w"),
        ] {
            assert_eq!(parse_surface(&arg), Err(BadField(field)), "{field}");
        }
        let release = |slot: f64, generation: f64| {
            object(&[("slot", Value::from(slot)), ("generation", Value::from(generation))])
        };
        assert_eq!(parse_release(&release(2.0, 7.0)), Ok(ReleaseArgs { slot: 2, generation: 7 }));
        assert_eq!(parse_release(&release(3.0, 7.0)), Err(BadField("slot")));
        assert_eq!(parse_release(&release(0.0, 0.0)), Err(BadField("generation")));
        assert_eq!(parse_release(&Value::Null), Err(BadField("slot")));
    }

    #[test]
    fn a_ring_point_maps_through_the_letterbox() {
        // A 960×540 world in a 1920×1440 ring: scale 2, bars of 180 px above and below.
        let ring = (1920, 1440);
        let world = (960, 540);
        assert_eq!(ring_point_to_world((960.0, 720.0), ring, world), (480.0, 270.0));
        assert_eq!(ring_point_to_world((0.0, 180.0), ring, world), (0.0, 0.0));
        assert_eq!(ring_point_to_world((1920.0, 1260.0), ring, world), (960.0, 540.0));
        // A point on a bar is held to the world's nearest edge.
        assert_eq!(ring_point_to_world((960.0, 10.0), ring, world), (480.0, 0.0));
        assert_eq!(ring_point_to_world((-50.0, 1439.0), ring, world), (0.0, 540.0));
        // Degenerate rings, worlds and points answer the centre.
        assert_eq!(ring_point_to_world((5.0, 5.0), (0, 1440), world), (480.0, 270.0));
        assert_eq!(ring_point_to_world((f64::NAN, 5.0), ring, world), (480.0, 270.0));
    }

    fn render_wire() -> Value {
        fixture()["render"].clone()
    }

    #[test]
    fn the_render_vocabularies_and_ranges_are_the_fixtures() {
        let render = render_wire();
        assert_eq!(render["op"].as_str(), OP_RENDER_SETTINGS);
        assert_eq!(render["stateKey"].as_str(), STATE_RENDER);
        assert_eq!(render["captureKey"].as_str(), STATE_RENDER);
        assert_eq!(render["renderSettingsApi"].as_f64(), f64::from(RENDER_SETTINGS_API_VERSION));
        assert_eq!(render["unavailable"].as_str(), RenderSettingsRefusal::Unavailable.wire());
        assert_eq!(names(&render["presets"]), wires(QualityPreset::ALL, QualityPreset::wire));
        assert_eq!(names(&render["deviceClasses"]), wires(DeviceClass::ALL, DeviceClass::wire));
        assert_eq!(names(&render["features"]), wires(RenderFeature::ALL, RenderFeature::wire));
        assert_eq!(names(&render["degradeReasons"]), wires(DegradeReason::ALL, DegradeReason::wire));
        assert_eq!(names(&render["settingsSources"]), wires(SettingsSource::ALL, SettingsSource::wire));
        assert_eq!(names(&render["captureExposure"]), wires(CaptureExposure::ALL, CaptureExposure::wire));
        assert_eq!(names(&render["rendererFeatures"]), wires(RendererFeature::ALL, RendererFeature::wire));
        assert_eq!(names(&render["renderInputs"]), wires(RenderInput::ALL, RenderInput::wire));
        assert_eq!(names(&render["settingsRefusals"]), wires(RenderSettingsRefusal::ALL, RenderSettingsRefusal::wire));
        assert_eq!(render["renderScale"]["min"].as_f64(), RENDER_SCALE_MIN);
        assert_eq!(render["renderScale"]["max"].as_f64(), RENDER_SCALE_MAX);
        assert_eq!(render["frameBudgetMs"]["min"].as_f64(), FRAME_BUDGET_MS_MIN);
        assert_eq!(render["frameBudgetMs"]["max"].as_f64(), FRAME_BUDGET_MS_MAX);
        assert_eq!(render["captureSettleFramesMax"].as_f64(), f64::from(CAPTURE_SETTLE_FRAMES_MAX));
    }

    #[test]
    fn an_old_receipt_and_a_new_one_parse_as_the_host_reads_them() {
        let wire = fixture();
        let old = Receipt::from_value(&wire["receiptSingular"]).expect("an old receipt parses");
        assert_eq!((old.extension_apis.as_slice(), old.custom_pass_apis.as_slice()), (&[1][..], &[1][..]));
        assert_eq!(old.render_settings_api, None);
        assert!(old.renderer_features.is_empty() && old.render_inputs.is_empty());
        let fresh = Receipt::from_value(&wire["receiptRenderSettings"]).expect("a new receipt parses");
        assert_eq!(fresh.to_value(), wire["receiptRenderSettings"], "it round-trips byte for byte");
        assert_eq!(fresh.render_settings_api, Some(RENDER_SETTINGS_API_VERSION));
        let ready = Receipt::from_value(&wire["readyV2"]["receipt"]).expect("the ready receipt parses");
        assert_eq!(ready.to_value(), wire["readyV2"]["receipt"]);
        let mut bad = wire["receiptRenderSettings"].clone();
        bad.set("extensionApis", versions(&[2]));
        assert_eq!(Receipt::from_value(&bad), Err(BadField("extensionApis")), "the list must end in extensionApi");
        let mut bad = wire["receiptRenderSettings"].clone();
        let mut twice = Value::array();
        twice.push(Value::from("depth"));
        twice.push(Value::from("depth"));
        bad.set("renderInputs", twice);
        assert_eq!(Receipt::from_value(&bad), Err(BadField("renderInputs")));
    }

    #[test]
    fn a_render_settings_argument_parses_and_hostile_ones_are_refused_with_their_codes() {
        let render = render_wire();
        assert_eq!(parse_render_settings(&render["get"]), Ok(None));
        assert_eq!(parse_render_settings(&Value::Null), Ok(None));
        let change = parse_render_settings(&render["set"]).expect("the fixture's set").expect("a change");
        assert_eq!(change.preset, Some(Some(QualityPreset::Low)));
        assert_eq!(change.device_class, Some(Some(DeviceClass::MobileMid)));
        assert_eq!(change.features, [(RenderFeature::Bloom, false), (RenderFeature::Taa, false)]);
        assert_eq!(change.render_scale_lock, Some(Some(0.75)));
        assert_eq!(change.frame_budget_ms, Some(Some(4.0)));
        let mut clear = Value::object();
        let mut set = Value::object();
        set.set("deviceClass", Value::Null);
        set.set("renderScaleLock", Value::Null);
        set.set("frameBudgetMs", Value::Null);
        set.set("preset", Value::Null);
        set.set("features", Value::Null);
        clear.set("set", set);
        let cleared = parse_render_settings(&clear).expect("a clear").expect("a change");
        assert_eq!((cleared.device_class, cleared.render_scale_lock), (Some(None), Some(None)));
        assert_eq!(cleared.frame_budget_ms, Some(None), "a null budget gives the class's frame time back");
        assert_eq!(cleared.preset, Some(None), "a null preset gives the game's and the person's choice back");
        assert!(cleared.reset_features && cleared.features.is_empty(), "a null feature table gives the verb's switches back");
        assert!(!change.reset_features, "a feature table sets switches");
        for row in render["setRefused"].items() {
            let wanted = row["error"].as_str();
            let got = match parse_render_settings(&row["arg"]) {
                Err(SettingsArgError::Refused(refusal)) => refusal.wire(),
                Err(SettingsArgError::Bad(_)) => "bad-argument",
                Ok(_) => "accepted",
            };
            assert_eq!(got, wanted, "{}", String::from_utf8_lossy(&row["arg"].dump()));
        }
    }

    #[test]
    fn the_answer_status_and_provenance_are_the_fixtures_bytes() {
        let render = render_wire();
        let switches = vec![(RenderFeature::Bloom, false), (RenderFeature::Taa, false)];
        let answer = RenderSettingsAnswer {
            preset: QualityPreset::Low,
            requested: QualityPreset::Low,
            device_class: DeviceClass::MobileMid,
            detected_class: DeviceClass::DesktopHigh,
            features: switches,
            render_scale_lock: Some(0.75),
            frame_budget_ms: Some(4.0),
            scale: 0.75,
        };
        assert_eq!(answer.to_value(), render["answer"]);
        let status = RenderStatus {
            device_class: DeviceClass::DesktopHigh,
            preset: QualityPreset::High,
            scale: 1.0,
            features: vec![(RenderFeature::Hdr, true), (RenderFeature::Bloom, true)],
            degraded: vec![Degrade { reason: DegradeReason::CustomPassV1InWorld, subject: Some("halo".to_owned()) }],
            gpu_ms: Some(1.25),
            cpu_ms: Some(0.5),
            frames: Some((120, 120)),
        };
        assert_eq!(status.to_value(), render["status"]);
        let provenance = CaptureProvenance {
            preset: QualityPreset::High,
            device_class: DeviceClass::DesktopHigh,
            settings_source: SettingsSource::ReferenceClass,
            scale: 1.0,
            settle_frames: 1,
            history_reset: true,
            exposure: CaptureExposure::Instant,
        };
        assert_eq!(provenance.to_value(), render["provenance"]);
    }
}
