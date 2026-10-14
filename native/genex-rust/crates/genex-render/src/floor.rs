//! The WebGPU-core floor (owner decision 2026-10-06). Adapters come only from Metal, D3D12 and
//! Vulkan natively and the browser's WebGPU on the web; an adapter is refused `gpu-unsupported`
//! before any device request unless it is WebGPU-compliant and meets `Limits::defaults()`. The
//! device is then requested with exactly `Limits::defaults()`, so naga validates against core and
//! a game that runs on the Mac cannot exceed web limits. Native-enhanced features the adapter
//! offers are recorded in the capability receipt and requested only when the game declares them.
//!
//! The renderer also requests its own optional WebGPU features when offered
//! ([`RENDERER_FEATURES`]: GPU timestamps for frame timing and dynamic resolution,
//! `rg11b10ufloat` render targets for a cheaper HDR scene, unclipped depth for exact shadow
//! pancaking). They only accelerate: none grants a naga capability (wgpu 30's
//! `features_to_naga_capabilities` maps none), the extension
//! context never counts them as the game's (`ExtensionContext::usable` stays declared ∩ offered
//! native-enhanced features), and every use has a core fallback. The receipt lists them apart, as
//! `rendererFeatures`.

use wgpu::{Backend, Backends, DownlevelCapabilities, Features, Limits};

pub use crate::error::UnsupportedReason;
use crate::error::{RenderCode, RenderError};

/// The backends an instance is created with: WebGPU-class only, never GL.
#[cfg(all(not(target_arch = "wasm32"), not(target_os = "windows")))]
pub const INSTANCE_BACKENDS: Backends = Backends::METAL.union(Backends::VULKAN).union(Backends::DX12);
/// The backends an instance is created with on Windows: D3D12 alone (with FXC, `gpu.rs`), never
/// Vulkan or GL, so a machine without a WebGPU-compliant D3D12 adapter is refused `gpu-unsupported`.
#[cfg(target_os = "windows")]
pub const INSTANCE_BACKENDS: Backends = Backends::DX12;
/// The backends an instance is created with: the browser's WebGPU only, never WebGL.
#[cfg(target_arch = "wasm32")]
pub const INSTANCE_BACKENDS: Backends = Backends::BROWSER_WEBGPU;

/// Native-enhanced features the receipt records when the adapter offers them, with their wire
/// names (M2.0's `NativeEnhancedFeature` wire spellings). All are native-only in wgpu 30.
pub const NATIVE_ENHANCED_FEATURES: &[(Features, &str)] = &[
    (Features::SHADER_INT64_ATOMIC_MIN_MAX, "shader-int64-atomic-min-max"),
    (Features::SHADER_INT64_ATOMIC_ALL_OPS, "shader-int64-atomic-all-ops"),
    (Features::SUBGROUP, "subgroup"),
    (Features::EXPERIMENTAL_RAY_QUERY, "ray-query"),
    (Features::EXPERIMENTAL_MESH_SHADER, "mesh-shader"),
    (Features::TEXTURE_BINDING_ARRAY, "texture-binding-array"),
    (Features::MULTI_DRAW_INDIRECT_COUNT, "multi-draw-indirect-count"),
];

/// WebGPU optional features the renderer requests for itself whenever the adapter offers them,
/// with their WebGPU spellings (the receipt's `rendererFeatures`). Plan §2.8.
pub const RENDERER_FEATURES: &[(Features, &str)] = &[
    (Features::TIMESTAMP_QUERY, "timestamp-query"),
    (Features::RG11B10UFLOAT_RENDERABLE, "rg11b10ufloat-renderable"),
    (Features::DEPTH_CLIP_CONTROL, "depth-clip-control"),
];

/// The renderer-owned features among `offered` (what the device is opened with besides the
/// game's declared ones).
pub fn renderer_features(offered: Features) -> Features {
    RENDERER_FEATURES.iter().filter(|(feature, _)| offered.contains(*feature)).fold(Features::empty(), |all, (feature, _)| all | *feature)
}

/// What the floor check reads from an adapter.
#[derive(Clone, Debug)]
pub struct AdapterFacts {
    /// The adapter's name, for the receipt.
    pub name: String,
    /// Its backend.
    pub backend: Backend,
    /// Its best limits.
    pub limits: Limits,
    /// Its downlevel capabilities.
    pub downlevel: DownlevelCapabilities,
    /// Every feature it offers.
    pub features: Features,
}

/// An adapter the floor can be checked on and a device opened from (a test double in tests).
pub trait GpuAdapter {
    /// What [`GpuAdapter::open`] gives.
    type Device;
    /// The adapter's facts.
    fn facts(&self) -> AdapterFacts;
    /// Request a device with these limits and features.
    fn open(&self, limits: &Limits, features: Features) -> Result<Self::Device, RenderError>;
}

/// The capability tier.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tier {
    /// WebGPU core: compute, storage buffers, indirect draws. Guaranteed everywhere.
    Core,
}

impl Tier {
    /// The wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            Tier::Core => "core",
        }
    }
}

/// What `ready` reports about the GPU: tier core, the backend, the offered native-enhanced
/// features (offered, not requested) and the renderer-owned features the device was opened with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapabilityReceipt {
    /// Always [`Tier::Core`]: the device is opened with core limits only.
    pub tier: Tier,
    /// `metal`, `vulkan`, `d3d12` or `webgpu`.
    pub backend: &'static str,
    /// The adapter's name.
    pub adapter: String,
    /// Wire names from [`NATIVE_ENHANCED_FEATURES`] the adapter offers, in table order.
    pub native_enhanced: Vec<&'static str>,
    /// Wire names from [`RENDERER_FEATURES`] the device was opened with, in table order.
    pub renderer_features: Vec<&'static str>,
}

impl CapabilityReceipt {
    /// The receipt as one JSON object (`{"tier","backend","adapter","nativeEnhanced","rendererFeatures"}`).
    pub fn to_json(&self) -> String {
        let quoted = |names: &[&str]| names.iter().map(|name| format!("\"{name}\"")).collect::<Vec<_>>().join(",");
        format!(
            "{{\"tier\":\"{}\",\"backend\":\"{}\",\"adapter\":\"{}\",\"nativeEnhanced\":[{}],\"rendererFeatures\":[{}]}}",
            self.tier.wire(),
            self.backend,
            json_escape(&self.adapter),
            quoted(&self.native_enhanced),
            quoted(&self.renderer_features)
        )
    }
}

fn json_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if u32::from(c) < 0x20 => out.push_str(&format!("\\u{:04x}", u32::from(c))),
            c => out.push(c),
        }
    }
    out
}

/// The backend's wire name, or `None` for a backend below the floor (GL, no-op).
pub const fn backend_wire(backend: Backend) -> Option<&'static str> {
    match backend {
        Backend::Metal => Some("metal"),
        Backend::Vulkan => Some("vulkan"),
        Backend::Dx12 => Some("d3d12"),
        Backend::BrowserWebGpu => Some("webgpu"),
        _ => None,
    }
}

/// The limits every device is requested with: WebGPU's defaults.
pub fn core_limits() -> Limits {
    Limits::defaults()
}

fn unsupported(reason: UnsupportedReason, facts: &AdapterFacts) -> RenderError {
    RenderError::GpuUnsupported { reason, detail: format!("{} on {:?}", facts.name, facts.backend) }
}

/// Refuse an adapter below WebGPU core: wrong backend, not compliant, or a limit below default.
pub fn check_floor(facts: &AdapterFacts) -> Result<(), RenderError> {
    if backend_wire(facts.backend).is_none() {
        return Err(unsupported(UnsupportedReason::Backend, facts));
    }
    if !facts.downlevel.is_webgpu_compliant() {
        return Err(unsupported(UnsupportedReason::NotWebGpuCompliant, facts));
    }
    let mut below = None;
    core_limits().check_limits_with_fail_fn(&facts.limits, true, |name, _, _| below = Some(name));
    if let Some(limit) = below {
        return Err(unsupported(UnsupportedReason::LimitBelowCore { limit: limit.to_owned() }, facts));
    }
    Ok(())
}

/// The receipt for an adapter that passed the floor (opened with its renderer-owned features).
pub fn receipt(facts: &AdapterFacts) -> CapabilityReceipt {
    let named = |table: &[(Features, &'static str)]| -> Vec<&'static str> {
        table.iter().filter(|(feature, _)| facts.features.contains(*feature)).map(|(_, name)| *name).collect()
    };
    CapabilityReceipt {
        tier: Tier::Core,
        backend: backend_wire(facts.backend).unwrap_or("unknown"),
        adapter: facts.name.clone(),
        native_enhanced: named(NATIVE_ENHANCED_FEATURES),
        renderer_features: named(RENDERER_FEATURES),
    }
}

/// The features a device is requested with: the game's declared native-enhanced ones plus the
/// renderer-owned ones `offered` has.
pub fn requested_features(declared: Features, offered: Features) -> Features {
    declared | renderer_features(offered)
}

/// Check the floor, then open a device with core limits and the renderer-owned features offered.
pub fn open_device<A: GpuAdapter>(adapter: &A) -> Result<(A::Device, CapabilityReceipt), RenderError> {
    open_device_with(adapter, Features::empty())
}

/// Check the floor, then open a device with core limits, exactly the native-enhanced features a
/// game declared (`[gpu] native_features`) and the renderer-owned features the adapter offers:
/// refused `native-feature-missing`, before any device is requested, when the adapter lacks a
/// declared one. An undeclared native-enhanced feature is never requested.
pub fn open_device_with<A: GpuAdapter>(adapter: &A, declared: Features) -> Result<(A::Device, CapabilityReceipt), RenderError> {
    let facts = adapter.facts();
    check_floor(&facts)?;
    check_declared(&facts, declared)?;
    let device = adapter.open(&core_limits(), requested_features(declared, facts.features))?;
    Ok((device, receipt(&facts)))
}

/// Refuse `native-feature-missing` naming each declared feature `facts` does not offer.
pub fn check_declared(facts: &AdapterFacts, declared: Features) -> Result<(), RenderError> {
    let missing = declared - facts.features;
    if missing.is_empty() {
        return Ok(());
    }
    let named: Vec<&str> =
        NATIVE_ENHANCED_FEATURES.iter().filter(|(feature, _)| missing.contains(*feature)).map(|(_, name)| *name).collect();
    let detail = format!("the game declares {} but {} does not offer it", named.join(", "), facts.name);
    Err(RenderError::refused(RenderCode::NativeFeatureMissing, detail))
}
