//! The device probe and device classes (plan §2.4).
//!
//! A class is a form factor × a performance tier. The probe reads facts only: backend, device
//! type, numeric vendor and device ids, limits, offered features, transient-attachment savings,
//! the target OS (compile time) and, on the web, the shell's hints. Adapter name strings are never
//! read: [`DeviceFacts`] does not even carry one.
//!
//! Classification has two steps:
//! - [`classify`] is the **form-factor default** from static facts alone: Mac → desktop-high,
//!   Windows/Linux → desktop-mid, iOS → mobile-high, Android → mobile-mid, the web by its hints
//!   (a phone mid, a desktop browser mid, high when it reports 8 GB and 8 threads).
//!   Captures and conformance use only this (plus a pinned genex.toml preset), never calibration.
//! - [`classify_calibrated`] refines it with a **calibration hint**: two fixed kernels (ALU and
//!   blended fill on a 256x256 target, at most [`CALIBRATION_GPU_BUDGET_MS`] of GPU time, timed by
//!   timestamp queries) give a score, quantized into a [`ScoreLevel`] with hysteresis. The hint
//!   moves the class at most one tier from the default and is skipped without timestamp queries
//!   (Safari; static facts only). Live caches it per adapter ([`CalibrationKey`]) in game saves.
//!
//! Apple silicon reports integrated GPUs, so the score decides the tier, not the device type.

use crate::compile::Compiled;
use wgpu::{AdapterInfo, Backend, DeviceType, Features, Limits};

use crate::error::RenderError;
use crate::floor::{AdapterFacts, backend_wire};
use crate::gpu::Gpu;

/// Apple's PCI vendor id (Metal adapters on Apple silicon).
pub const APPLE_VENDOR_ID: u32 = 0x106B;
/// Qualcomm's vendor id (Adreno, as Vulkan reports it).
pub const QUALCOMM_VENDOR_ID: u32 = 0x5143;
/// Arm's vendor id (Mali).
pub const ARM_VENDOR_ID: u32 = 0x13B5;
/// The short side, in CSS pixels, at or below which a touch screen reads as a phone. Bodycam B1:
/// at 900 (any screen) a 1440x900 MacBook Air read as a phone; tablets past it report a coarse
/// pointer, and a screen without touch is never a phone's.
pub const WEB_MOBILE_SHORT_SIDE_CSS_PX: u32 = 600;
/// The `deviceMemory` (GB; Chrome reports at most 8) from which a desktop browser starts high.
pub const WEB_HIGH_DEVICE_MEMORY_GB: f32 = 8.0;
/// The `hardwareConcurrency` from which a desktop browser starts high.
pub const WEB_HIGH_HARDWARE_CONCURRENCY: u32 = 8;
/// `navigator.deviceMemory` when the browser hides it (Safari, Firefox), in GB.
pub const WEB_DEFAULT_DEVICE_MEMORY_GB: f32 = 4.0;

/// Desktop or mobile (`FormFactor` on the wire).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum FormFactor {
    /// Desktops and laptops.
    Desktop,
    /// Phones and tablets.
    Mobile,
}

impl FormFactor {
    /// Every form factor.
    pub const ALL: [FormFactor; 2] = [FormFactor::Desktop, FormFactor::Mobile];

    /// The wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            FormFactor::Desktop => "desktop",
            FormFactor::Mobile => "mobile",
        }
    }

    /// The form factor spelled `wire`, if any.
    pub fn from_wire(wire: &str) -> Option<FormFactor> {
        FormFactor::ALL.into_iter().find(|form| form.wire() == wire)
    }

    /// The fastest tier the form factor names (there is no `mobile-ultra`).
    pub const fn top_tier(self) -> PerformanceTier {
        match self {
            FormFactor::Desktop => PerformanceTier::Ultra,
            FormFactor::Mobile => PerformanceTier::High,
        }
    }
}

/// A performance tier within a form factor (`PerformanceTier` on the wire).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum PerformanceTier {
    /// Old or integrated GPUs, entry phones.
    Low,
    /// Mid-range.
    Mid,
    /// Recent and capable.
    High,
    /// High-end.
    Ultra,
}

impl PerformanceTier {
    /// Every tier, slowest first.
    pub const ALL: [PerformanceTier; 4] = [PerformanceTier::Low, PerformanceTier::Mid, PerformanceTier::High, PerformanceTier::Ultra];

    /// The wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            PerformanceTier::Low => "low",
            PerformanceTier::Mid => "mid",
            PerformanceTier::High => "high",
            PerformanceTier::Ultra => "ultra",
        }
    }

    /// The tier's position in [`PerformanceTier::ALL`].
    const fn index(self) -> usize {
        match self {
            PerformanceTier::Low => 0,
            PerformanceTier::Mid => 1,
            PerformanceTier::High => 2,
            PerformanceTier::Ultra => 3,
        }
    }
}

/// A device class: form factor × tier (`DeviceClass` on the wire, `desktop-high` and so on).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct DeviceClass {
    /// Desktop or mobile.
    pub form: FormFactor,
    /// The tier.
    pub tier: PerformanceTier,
}

impl DeviceClass {
    /// A class.
    pub const fn new(form: FormFactor, tier: PerformanceTier) -> DeviceClass {
        DeviceClass { form, tier }
    }

    /// Every class the host vocabulary names (plan §2.4's table; there is no `mobile-ultra`):
    /// desktop then mobile, fastest first.
    pub const ALL: [DeviceClass; 7] = [
        DeviceClass::new(FormFactor::Desktop, PerformanceTier::Ultra),
        DeviceClass::new(FormFactor::Desktop, PerformanceTier::High),
        DeviceClass::new(FormFactor::Desktop, PerformanceTier::Mid),
        DeviceClass::new(FormFactor::Desktop, PerformanceTier::Low),
        DeviceClass::new(FormFactor::Mobile, PerformanceTier::High),
        DeviceClass::new(FormFactor::Mobile, PerformanceTier::Mid),
        DeviceClass::new(FormFactor::Mobile, PerformanceTier::Low),
    ];

    /// The wire spelling (`${form}-${tier}`).
    pub fn wire(self) -> String {
        format!("{}-{}", self.form.wire(), self.tier.wire())
    }

    /// The class spelled `wire`, if any.
    pub fn from_wire(wire: &str) -> Option<DeviceClass> {
        DeviceClass::ALL.into_iter().find(|class| class.wire() == wire)
    }
}

/// The destination a build runs on (compile-time).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TargetOs {
    /// macOS.
    MacOs,
    /// Windows.
    Windows,
    /// Linux.
    Linux,
    /// iOS (device or simulator).
    Ios,
    /// Android.
    Android,
    /// A browser (wasm32).
    Web,
}

impl TargetOs {
    /// The destination this build is for.
    pub const fn current() -> TargetOs {
        if cfg!(target_arch = "wasm32") {
            TargetOs::Web
        } else if cfg!(target_os = "ios") {
            TargetOs::Ios
        } else if cfg!(target_os = "android") {
            TargetOs::Android
        } else if cfg!(target_os = "windows") {
            TargetOs::Windows
        } else if cfg!(target_os = "macos") {
            TargetOs::MacOs
        } else {
            TargetOs::Linux
        }
    }

    /// The spelling in a [`CalibrationKey`].
    pub const fn wire(self) -> &'static str {
        match self {
            TargetOs::MacOs => "macos",
            TargetOs::Windows => "windows",
            TargetOs::Linux => "linux",
            TargetOs::Ios => "ios",
            TargetOs::Android => "android",
            TargetOs::Web => "web",
        }
    }
}

/// What a web shell tells the probe (`studio_boot`): browsers expose no adapter class.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct WebHints {
    /// `navigator.maxTouchPoints`.
    pub max_touch_points: u32,
    /// Whether `(pointer: coarse)` matches.
    pub coarse_pointer: bool,
    /// The screen's short side in CSS pixels (0 when unknown).
    pub short_side_css_px: u32,
    /// `navigator.deviceMemory` in GB (None when the browser hides it).
    pub device_memory_gb: Option<f32>,
    /// `navigator.hardwareConcurrency`.
    pub hardware_concurrency: Option<u32>,
    /// `navigator.userAgentData.mobile` (None without `userAgentData`: Safari, Firefox).
    pub ua_mobile: Option<bool>,
}

impl WebHints {
    /// Whether the hints say phone or tablet: a mobile user agent, touch with a coarse pointer
    /// (iPadOS Safari reports a desktop user agent), or a touch screen whose short side is at most
    /// [`WEB_MOBILE_SHORT_SIDE_CSS_PX`]. A screen without touch is a desktop's at any size.
    pub fn is_mobile(&self) -> bool {
        let touch = self.max_touch_points > 0;
        let coarse_touch = touch && self.coarse_pointer;
        let small_touch_screen = touch && self.short_side_css_px > 0 && self.short_side_css_px <= WEB_MOBILE_SHORT_SIDE_CSS_PX;
        self.ua_mobile == Some(true) || coarse_touch || small_touch_screen
    }

    /// Whether a desktop browser's hints describe a roomy machine (at least
    /// [`WEB_HIGH_DEVICE_MEMORY_GB`] of `deviceMemory` and [`WEB_HIGH_HARDWARE_CONCURRENCY`]
    /// threads), which starts high; calibration may still move it one tier down.
    pub fn is_roomy(&self) -> bool {
        let memory = self.device_memory_gb() >= WEB_HIGH_DEVICE_MEMORY_GB;
        let threads = self.hardware_concurrency.is_some_and(|threads| threads >= WEB_HIGH_HARDWARE_CONCURRENCY);
        memory && threads
    }

    /// `deviceMemory` in GB, reading a missing or nonsense hint as [`WEB_DEFAULT_DEVICE_MEMORY_GB`].
    pub fn device_memory_gb(&self) -> f32 {
        match self.device_memory_gb {
            Some(gb) if gb.is_finite() && gb > 0.0 => gb,
            _ => WEB_DEFAULT_DEVICE_MEMORY_GB,
        }
    }
}

/// What the probe reads about a device.
#[derive(Clone, Debug, PartialEq)]
pub struct DeviceFacts {
    /// The backend.
    pub backend: Backend,
    /// Integrated, discrete, virtual, CPU or other.
    pub device_type: DeviceType,
    /// The PCI vendor id (0 when unknown, as on the web).
    pub vendor: u32,
    /// The backend's device id (0 when unknown): part of the calibration cache key only.
    pub device: u32,
    /// The adapter's limits.
    pub limits: Limits,
    /// Every feature it offers.
    pub features: Features,
    /// Whether `TRANSIENT_ATTACHMENT` saves memory (None on the web: unknown).
    pub transient_saves_memory: Option<bool>,
    /// The destination.
    pub os: TargetOs,
    /// The web shell's hints (web only).
    pub web: Option<WebHints>,
    /// The GPU-visible memory the platform reports, in bytes (None when unknown): Metal's
    /// `recommendedMaxWorkingSetSize` on Apple (unified memory), a discrete adapter's dedicated
    /// VRAM on DX12 and Vulkan (its largest device-local heap). wgpu does not expose it, so the
    /// adapter probe asks the backend (`genex_gpu_memory`); on native desktops it scales the
    /// memory budget ([`crate::presets::class_budget_bytes`]).
    pub gpu_visible_memory_bytes: Option<u64>,
}

impl DeviceFacts {
    /// The facts of an adapter with `info` that passed the floor with `facts`.
    pub fn probe(info: &AdapterInfo, facts: &AdapterFacts) -> DeviceFacts {
        DeviceFacts {
            backend: facts.backend,
            device_type: info.device_type,
            vendor: info.vendor,
            device: info.device,
            limits: facts.limits.clone(),
            features: facts.features,
            transient_saves_memory: info.transient_saves_memory,
            os: TargetOs::current(),
            web: None,
            gpu_visible_memory_bytes: None,
        }
    }

    /// Bare facts: core limits, no optional features, unknown ids (fixtures, and a web shell
    /// before its hints arrive).
    pub fn new(os: TargetOs, backend: Backend, device_type: DeviceType) -> DeviceFacts {
        DeviceFacts {
            backend,
            device_type,
            vendor: 0,
            device: 0,
            limits: Limits::defaults(),
            features: Features::empty(),
            transient_saves_memory: None,
            os,
            web: None,
            gpu_visible_memory_bytes: None,
        }
    }

    /// The facts with these numeric vendor and device ids.
    pub fn with_vendor(mut self, vendor: u32, device: u32) -> DeviceFacts {
        self.vendor = vendor;
        self.device = device;
        self
    }

    /// The facts with the web shell's `hints`.
    pub fn with_web(mut self, hints: WebHints) -> DeviceFacts {
        self.web = Some(hints);
        self
    }

    /// The facts with `bytes` of GPU-visible memory, as the platform reports it (None: unknown).
    pub fn with_gpu_visible_memory(mut self, bytes: Option<u64>) -> DeviceFacts {
        self.gpu_visible_memory_bytes = bytes;
        self
    }

    /// The facts as if on `os` (fixtures; a probe always reads the build's own).
    pub fn with_os(mut self, os: TargetOs) -> DeviceFacts {
        self.os = os;
        self
    }

    /// Whether transient attachments may be used to save memory: only when the adapter says so,
    /// never on the web (usage bits pass straight to the browser).
    pub fn transient_saves_memory(&self) -> bool {
        self.os != TargetOs::Web && self.transient_saves_memory == Some(true)
    }

    /// Whether the renderer-owned `RG11B10UFLOAT_RENDERABLE` is offered.
    pub fn rg11b10_renderable(&self) -> bool {
        self.features.contains(Features::RG11B10UFLOAT_RENDERABLE)
    }

    /// Whether the calibration hint can run: it needs timestamp queries, and is skipped (static
    /// facts only) without them.
    pub fn can_calibrate(&self) -> bool {
        self.features.contains(Features::TIMESTAMP_QUERY)
    }

    /// Desktop or mobile: by destination natively, by the shell's hints on the web (unknown hints
    /// read as mobile, so a promotion by DRS or the person is the only risk).
    pub fn form_factor(&self) -> FormFactor {
        match self.os {
            TargetOs::Ios | TargetOs::Android => FormFactor::Mobile,
            TargetOs::Web if self.web.is_none_or(|hints| hints.is_mobile()) => FormFactor::Mobile,
            _ => FormFactor::Desktop,
        }
    }

    /// The tier before calibration.
    fn default_tier(&self) -> PerformanceTier {
        match self.os {
            TargetOs::MacOs => mac_tier(self),
            TargetOs::Windows | TargetOs::Linux => match self.device_type {
                DeviceType::Cpu | DeviceType::VirtualGpu => PerformanceTier::Low,
                _ => PerformanceTier::Mid,
            },
            TargetOs::Ios => PerformanceTier::High,
            TargetOs::Web => web_tier(self),
            TargetOs::Android => PerformanceTier::Mid,
        }
    }
}

/// A browser starts mid, a roomy desktop one ([`WebHints::is_roomy`]) high: browsers name no
/// adapter, so Studio's Live page on a Mac would otherwise never start where a native Mac does.
fn web_tier(facts: &DeviceFacts) -> PerformanceTier {
    let roomy_desktop = facts.web.is_some_and(|hints| !hints.is_mobile() && hints.is_roomy());
    if roomy_desktop { PerformanceTier::High } else { PerformanceTier::Mid }
}

/// Apple silicon (or an unknown vendor) starts high; an Intel Mac's integrated GPU starts low and
/// its discrete AMD GPU mid.
fn mac_tier(facts: &DeviceFacts) -> PerformanceTier {
    let apple = facts.vendor == APPLE_VENDOR_ID || facts.vendor == 0;
    match (apple, facts.device_type) {
        (true, _) => PerformanceTier::High,
        (false, DeviceType::IntegratedGpu) => PerformanceTier::Low,
        (false, _) => PerformanceTier::Mid,
    }
}

/// The class a device starts in before calibration: its destination's form-factor default (plan
/// §2.4). Captures read only this.
pub fn classify(facts: &DeviceFacts) -> DeviceClass {
    DeviceClass::new(facts.form_factor(), facts.default_tier())
}

/// The class with the calibration hint `level` applied: at most one tier from [`classify`]'s,
/// toward the score's tier, never past the form factor's top tier. `None` (no timestamps, or not
/// yet calibrated) is the default.
pub fn classify_calibrated(facts: &DeviceFacts, level: Option<ScoreLevel>) -> DeviceClass {
    let start = classify(facts);
    let Some(level) = level else { return start };
    let from = start.tier.index();
    let toward = score_tier(start.form, level).index();
    let moved = match toward.cmp(&from) {
        std::cmp::Ordering::Greater => from + 1,
        std::cmp::Ordering::Less => from - 1,
        std::cmp::Ordering::Equal => from,
    };
    let tier = PerformanceTier::ALL[moved.min(start.form.top_tier().index())];
    DeviceClass::new(start.form, tier)
}

/// Quantization: levels per doubling of the score.
const LEVELS_PER_OCTAVE: f32 = 2.0;
/// A cached level is kept while a new score stays within this many levels outside it.
const HYSTERESIS_LEVELS: f32 = 0.25;
/// Absorbs `exp2`/`log2` rounding, so a tier's floor score quantizes to the floor's own level.
const LEVEL_ROUNDING: f32 = 1.0e-3;

/// A calibration score quantized to half-octaves (`floor(2 · log2(score))`): what Live caches per
/// adapter and what the tier thresholds name.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ScoreLevel(u8);

impl ScoreLevel {
    /// The highest level (a score of 2^31.5).
    pub const MAX: u8 = 63;

    /// The level `level` (clamped to [`ScoreLevel::MAX`]).
    pub const fn new(level: u8) -> ScoreLevel {
        if level > ScoreLevel::MAX { ScoreLevel(ScoreLevel::MAX) } else { ScoreLevel(level) }
    }

    /// The level as a number (what a cache stores).
    pub const fn get(self) -> u8 {
        self.0
    }

    /// The level of `score`. With a `previous` (cached) level, a score that lands within
    /// [`HYSTERESIS_LEVELS`] outside it keeps it, so a measurement wobbling over a tier boundary
    /// never flips the class between launches.
    pub fn quantize(score: f32, previous: Option<ScoreLevel>) -> ScoreLevel {
        let continuous = continuous_level(score);
        if let Some(previous) = previous {
            let low = f32::from(previous.0) - HYSTERESIS_LEVELS;
            let high = f32::from(previous.0) + 1.0 + HYSTERESIS_LEVELS;
            if continuous >= low && continuous < high {
                return previous;
            }
        }
        ScoreLevel::new((continuous + LEVEL_ROUNDING) as u8)
    }

    /// The lowest score that quantizes to this level.
    pub fn floor_score(self) -> f32 {
        libm::exp2f(f32::from(self.0) / LEVELS_PER_OCTAVE)
    }
}

/// `2 · log2(score)`, clamped to the level range (no throughput or NaN is level 0).
fn continuous_level(score: f32) -> f32 {
    if score.is_nan() || score <= 1.0 {
        return 0.0;
    }
    let level = LEVELS_PER_OCTAVE * libm::log2f(score);
    level.min(f32::from(ScoreLevel::MAX))
}

/// The lowest level of each tier above low, per form factor (scores 2^(level/2)). Desktop: mid from
/// ~1k, high from ~2.9k, ultra from ~8.2k; mobile: mid from ~360, high from ~1k. Scores are
/// `sqrt(ALU GFLOP/s × fill Gpix/s × 100)` on the calibration kernels, as measured at boot (GPU
/// clocks still ramping, so below peak): the M4 Max measures levels 25-27, desktop-high or
/// desktop-ultra (renderer log, RQ0.4). Other thresholds are provisional, scaled from that by
/// the devices' relative throughput, and refined as device measurements arrive.
const DESKTOP_TIER_LEVELS: [(PerformanceTier, u8); 3] =
    [(PerformanceTier::Mid, 20), (PerformanceTier::High, 23), (PerformanceTier::Ultra, 26)];
const MOBILE_TIER_LEVELS: [(PerformanceTier, u8); 2] = [(PerformanceTier::Mid, 17), (PerformanceTier::High, 20)];

fn tier_levels(form: FormFactor) -> &'static [(PerformanceTier, u8)] {
    match form {
        FormFactor::Desktop => &DESKTOP_TIER_LEVELS,
        FormFactor::Mobile => &MOBILE_TIER_LEVELS,
    }
}

/// The tier a calibration `level` names for `form`.
pub fn score_tier(form: FormFactor, level: ScoreLevel) -> PerformanceTier {
    tier_levels(form).iter().rev().find(|(_, floor)| level.0 >= *floor).map_or(PerformanceTier::Low, |(tier, _)| *tier)
}

/// The lowest score of `tier` on `form` (1 for low; infinite for a tier the form factor lacks).
pub fn tier_floor_score(form: FormFactor, tier: PerformanceTier) -> f32 {
    if tier == PerformanceTier::Low {
        return 1.0;
    }
    tier_levels(form).iter().find(|(named, _)| *named == tier).map_or(f32::INFINITY, |(_, level)| ScoreLevel(*level).floor_score())
}

/// What a calibration result is cached under (per adapter, in game saves, Live only): numbers,
/// never names.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct CalibrationKey {
    os: TargetOs,
    backend: Backend,
    device_type: DeviceType,
    vendor: u32,
    device: u32,
}

impl CalibrationKey {
    /// The key of the adapter `facts` describe.
    pub fn of(facts: &DeviceFacts) -> CalibrationKey {
        CalibrationKey {
            os: facts.os,
            backend: facts.backend,
            device_type: facts.device_type,
            vendor: facts.vendor,
            device: facts.device,
        }
    }

    /// The key as a save-file string: `os-backend-type-vendor-device`, ids in lowercase hex.
    pub fn wire(&self) -> String {
        let device_type = match self.device_type {
            DeviceType::IntegratedGpu => "integrated",
            DeviceType::DiscreteGpu => "discrete",
            DeviceType::VirtualGpu => "virtual",
            DeviceType::Cpu => "cpu",
            DeviceType::Other => "other",
        };
        let backend = backend_wire(self.backend).unwrap_or("unknown");
        format!("{}-{backend}-{device_type}-{:x}-{:x}", self.os.wire(), self.vendor, self.device)
    }
}

/// The most GPU time calibration may take, in milliseconds.
pub const CALIBRATION_GPU_BUDGET_MS: f32 = 40.0;
/// A kernel's measurement is kept once one run takes at least this long (Chrome quantizes
/// timestamps to 100 µs: 5% at 2 ms).
const CALIBRATION_SAMPLE_MS: f32 = 2.0;
/// The repetition multiplier never exceeds this.
const CALIBRATION_MAX_REPS: u32 = 1024;
/// Rounds per kernel at most.
const CALIBRATION_MAX_ROUNDS: u32 = 16;
/// The calibration target's side (both kernels cover 256 × 256).
const CALIBRATION_SIDE: u32 = 256;
/// ALU loop iterations per repetition (each iteration is 8 vec4 FMAs: 64 FLOPs per thread).
const ALU_ITERATIONS_PER_REP: u32 = 64;
/// FLOPs per thread per loop iteration.
const ALU_FLOPS_PER_ITERATION: f64 = 64.0;
/// Full-screen blended triangles per fill repetition.
const FILL_LAYERS_PER_REP: u32 = 32;
/// Gpix/s are weighed by this to sit on the GFLOP/s scale in the score.
const FILL_WEIGHT: f32 = 100.0;
/// Timestamps per round: begin and end of the timed pass.
const TIMESTAMPS: u32 = 2;
/// Resolves tried per round before its stamps count as unusable.
const RESOLVE_ATTEMPTS: u32 = 4;

/// The calibration kernels: `alu` (compute, 256 × 256 threads, eight independent FMA chains) and
/// `fill_vs`/`fill_fs` (full-screen triangles additively blended into a 256 × 256 `rgba16float`
/// target). WebGPU core only.
pub const CALIBRATION_WGSL: &str = r#"
struct Params {
    iterations: u32,
    seed: f32,
    pad0: u32,
    pad1: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> sink: array<f32>;

@compute @workgroup_size(64)
fn alu(@builtin(global_invocation_id) id: vec3<u32>) {
    let index = id.y * 256u + id.x;
    let b = vec4<f32>(0.9999, 0.9998, 0.9997, 0.9996);
    let c = vec4<f32>(params.seed * 0.001);
    var a0 = vec4<f32>(f32(index) * 1e-6, params.seed, 0.5, 0.25);
    var a1 = a0.yzwx;
    var a2 = a0.zwxy;
    var a3 = a0.wxyz;
    var a4 = a0 * 0.5;
    var a5 = a1 * 0.5;
    var a6 = a2 * 0.5;
    var a7 = a3 * 0.5;
    for (var i = 0u; i < params.iterations; i = i + 1u) {
        a0 = fma(a0, b, c);
        a1 = fma(a1, b, c);
        a2 = fma(a2, b, c);
        a3 = fma(a3, b, c);
        a4 = fma(a4, b, c);
        a5 = fma(a5, b, c);
        a6 = fma(a6, b, c);
        a7 = fma(a7, b, c);
    }
    sink[index] = dot(a0 + a1 + a2 + a3 + a4 + a5 + a6 + a7, vec4<f32>(1.0));
}

@vertex
fn fill_vs(@builtin(vertex_index) vertex: u32) -> @builtin(position) vec4<f32> {
    let x = f32((vertex << 1u) & 2u) * 2.0 - 1.0;
    let y = f32(vertex & 2u) * 2.0 - 1.0;
    return vec4<f32>(x, y, 0.0, 1.0);
}

@fragment
fn fill_fs() -> @location(0) vec4<f32> {
    return vec4<f32>(1.0 / 4096.0);
}
"#;

/// A calibration run's measurements (volatile: never read by a capture or the state checksum).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Calibration {
    /// Achieved ALU throughput, GFLOP/s.
    pub alu_gflops: f32,
    /// Achieved blended fill rate into `rgba16float`, Gpix/s.
    pub fill_gpix: f32,
    /// GPU time spent in all rounds, milliseconds.
    pub gpu_ms: f32,
    /// Rounds run (both kernels).
    pub rounds: u32,
}

impl Calibration {
    /// The score: the geometric mean of ALU GFLOP/s and weighted fill Gpix/s.
    pub fn score(&self) -> f32 {
        (self.alu_gflops * self.fill_gpix * FILL_WEIGHT).max(0.0).sqrt()
    }
}

/// Which kernel a round times.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kernel {
    Alu,
    Fill,
}

/// The GPU objects of the calibration kernels.
struct Kernels {
    alu: Compiled<wgpu::ComputePipeline>,
    fill: Compiled<wgpu::RenderPipeline>,
    group: wgpu::BindGroup,
    params: wgpu::Buffer,
    target: wgpu::TextureView,
    queries: wgpu::QuerySet,
    resolve: wgpu::Buffer,
    readback: wgpu::Buffer,
    /// The last accepted stamp pair (a repeat is stale).
    last: std::cell::Cell<(u64, u64)>,
}

/// Bytes of the resolved timestamps.
const TIMESTAMP_BYTES: u64 = TIMESTAMPS as u64 * 8;

impl Kernels {
    fn new(gpu: &Gpu) -> Result<Kernels, RenderError> {
        let device = &gpu.device;
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("calibration"),
            source: wgpu::ShaderSource::Wgsl(CALIBRATION_WGSL.into()),
        });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("calibration"),
            entries: &[buffer_entry(0, wgpu::BufferBindingType::Uniform), buffer_entry(1, wgpu::BufferBindingType::Storage { read_only: false })],
        });
        let pipeline_layout = crate::tables::pipeline_layout(device, "calibration", &[&layout]);
        let alu = crate::compile::compute_pipeline(device, &wgpu::ComputePipelineDescriptor {
            label: Some("calibration alu"),
            layout: Some(&pipeline_layout),
            module: &module,
            entry_point: Some("alu"),
            compilation_options: Default::default(),
            cache: None,
        });
        let fill = fill_pipeline(device, &module, &crate::tables::pipeline_layout(device, "calibration fill", &[]));
        let params = crate::tables::buffer(device, "calibration params", 16, wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST)?;
        let sink_bytes = u64::from(CALIBRATION_SIDE * CALIBRATION_SIDE) * 4;
        let sink = crate::tables::buffer(device, "calibration sink", sink_bytes, wgpu::BufferUsages::STORAGE)?;
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("calibration"),
            layout: &layout,
            entries: &[crate::tables::entry(0, &params), crate::tables::entry(1, &sink)],
        });
        let target = device
            .create_texture(&wgpu::TextureDescriptor {
                label: Some("calibration fill"),
                size: wgpu::Extent3d { width: CALIBRATION_SIDE, height: CALIBRATION_SIDE, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba16Float,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                view_formats: &[],
            })
            .create_view(&wgpu::TextureViewDescriptor::default());
        let queries = device.create_query_set(&wgpu::QuerySetDescriptor { label: Some("calibration"), ty: wgpu::QueryType::Timestamp, count: TIMESTAMPS });
        let resolve =
            crate::tables::buffer(device, "calibration resolve", 256, wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC)?;
        let readback = crate::tables::buffer(device, "calibration readback", 256, wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST)?;
        Ok(Kernels { alu, fill, group, params, target, queries, resolve, readback, last: std::cell::Cell::new((0, 0)) })
    }

    /// Run `kernel` at `reps` repetitions; answers its GPU time in ms (None for unusable stamps).
    async fn time(&self, gpu: &Gpu, kernel: Kernel, reps: u32) -> Result<Option<f32>, RenderError> {
        let iterations = ALU_ITERATIONS_PER_REP * reps;
        let params: [u32; 4] = [iterations, 1.5f32.to_bits(), 0, 0];
        gpu.queue.write_buffer(&self.params, 0, bytemuck::cast_slice(&params));
        let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("calibration") });
        match kernel {
            Kernel::Alu => self.encode_alu(&mut encoder),
            Kernel::Fill => self.encode_fill(&mut encoder, FILL_LAYERS_PER_REP * reps),
        }
        gpu.queue.submit([encoder.finish()]);
        // Metal writes stage-boundary samples after its command buffer: a resolve in the same
        // submission can read the previous round's pair. Resolve separately, and again while the
        // pair is stale (equal to the last one) or inverted.
        for _ in 0..RESOLVE_ATTEMPTS {
            let (begin, end) = self.resolve(gpu).await?;
            if end > begin && (begin, end) != self.last.get() {
                self.last.set((begin, end));
                let nanos = (end - begin) as f64 * f64::from(gpu.queue.get_timestamp_period());
                return Ok(Some((nanos / 1.0e6) as f32));
            }
        }
        Ok(None)
    }

    /// The query set's two stamps, resolved and read back in a submission of their own.
    async fn resolve(&self, gpu: &Gpu) -> Result<(u64, u64), RenderError> {
        let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("calibration resolve") });
        encoder.resolve_query_set(&self.queries, 0..TIMESTAMPS, &self.resolve, 0);
        encoder.copy_buffer_to_buffer(&self.resolve, 0, &self.readback, 0, TIMESTAMP_BYTES);
        gpu.queue.submit([encoder.finish()]);
        let bytes = crate::readback::map_read(gpu, &self.readback, TIMESTAMP_BYTES).await?;
        let stamp = |at: usize| bytes.get(at..at + 8).and_then(|b| b.try_into().ok()).map_or(0, u64::from_le_bytes);
        Ok((stamp(0), stamp(8)))
    }

    fn encode_alu(&self, encoder: &mut wgpu::CommandEncoder) {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("calibration alu"),
            timestamp_writes: Some(wgpu::ComputePassTimestampWrites {
                query_set: &self.queries,
                beginning_of_pass_write_index: Some(0),
                end_of_pass_write_index: Some(1),
            }),
        });
        pass.set_pipeline(&self.alu);
        pass.set_bind_group(0, &self.group, &[]);
        pass.dispatch_workgroups(CALIBRATION_SIDE / 64, CALIBRATION_SIDE, 1);
    }

    fn encode_fill(&self, encoder: &mut wgpu::CommandEncoder, layers: u32) {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("calibration fill"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &self.target,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Discard },
            })],
            timestamp_writes: Some(wgpu::RenderPassTimestampWrites {
                query_set: &self.queries,
                beginning_of_pass_write_index: Some(0),
                end_of_pass_write_index: Some(1),
            }),
            ..Default::default()
        });
        pass.set_pipeline(&self.fill);
        pass.draw(0..3, 0..layers);
    }
}

fn buffer_entry(binding: u32, ty: wgpu::BufferBindingType) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::Buffer { ty, has_dynamic_offset: false, min_binding_size: None },
        count: None,
    }
}

fn fill_pipeline(device: &wgpu::Device, module: &wgpu::ShaderModule, layout: &wgpu::PipelineLayout) -> Compiled<wgpu::RenderPipeline> {
    let add = wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::One, operation: wgpu::BlendOperation::Add };
    let targets = [Some(wgpu::ColorTargetState {
        format: wgpu::TextureFormat::Rgba16Float,
        blend: Some(wgpu::BlendState { color: add, alpha: add }),
        write_mask: wgpu::ColorWrites::ALL,
    })];
    crate::compile::render_pipeline(device, &wgpu::RenderPipelineDescriptor {
        label: Some("calibration fill"),
        layout: Some(layout),
        vertex: wgpu::VertexState { module, entry_point: Some("fill_vs"), compilation_options: Default::default(), buffers: &[] },
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        fragment: Some(wgpu::FragmentState { module, entry_point: Some("fill_fs"), compilation_options: Default::default(), targets: &targets }),
        multiview_mask: None,
        cache: None,
    })
}

/// One kernel's measurement: its time at its final repetitions, and the GPU time all its rounds
/// spent.
struct Measured {
    ms: f32,
    reps: u32,
    spent_ms: f32,
    rounds: u32,
}

/// Time `kernel`: grow its repetitions until one run takes [`CALIBRATION_SAMPLE_MS`] (or the
/// repetitions or rounds cap), then repeat that size while `budget_ms` lasts and keep the fastest
/// run. GPUs raise their clocks under load (Apple's take tens of milliseconds), so the first long
/// run alone reads an idle clock.
async fn measure(gpu: &Gpu, kernels: &Kernels, kernel: Kernel, budget_ms: f32) -> Result<Option<Measured>, RenderError> {
    let mut reps = 1u32;
    let mut spent_ms = 0.0f32;
    let mut rounds = 0u32;
    let mut best: Option<f32> = None;
    loop {
        let Some(ms) = kernels.time(gpu, kernel, reps).await? else { return Ok(None) };
        spent_ms += ms;
        rounds += 1;
        let sized = ms >= CALIBRATION_SAMPLE_MS || reps >= CALIBRATION_MAX_REPS;
        if sized {
            best = Some(best.map_or(ms, |fastest| fastest.min(ms)));
        }
        let growth = if sized { 1 } else { growth_factor(ms) };
        let next_ms = ms * growth as f32;
        if rounds >= CALIBRATION_MAX_ROUNDS || spent_ms + next_ms > budget_ms {
            return Ok(Some(Measured { ms: best.unwrap_or(ms), reps, spent_ms, rounds }));
        }
        reps = (reps * growth).min(CALIBRATION_MAX_REPS);
    }
}

/// How much to grow the repetitions after a run of `ms`: toward the sample time, a power of two
/// from 2 to 16.
fn growth_factor(ms: f32) -> u32 {
    if ms <= 0.0 {
        return 16;
    }
    let wanted = (CALIBRATION_SAMPLE_MS / ms).clamp(2.0, 16.0);
    (wanted as u32).next_power_of_two().clamp(2, 16)
}

/// Run the calibration kernels on `gpu` (at most [`CALIBRATION_GPU_BUDGET_MS`] of GPU time, half
/// per kernel). `None` when the device has no timestamp queries or they report nothing usable:
/// the class then stays [`classify`]'s. A future: the web awaits it, natively it polls.
pub async fn calibrate(gpu: &Gpu) -> Result<Option<Calibration>, RenderError> {
    if !gpu.device.features().contains(Features::TIMESTAMP_QUERY) {
        return Ok(None);
    }
    let kernels = Kernels::new(gpu)?;
    let half = CALIBRATION_GPU_BUDGET_MS / 2.0;
    let Some(alu) = measure(gpu, &kernels, Kernel::Alu, half).await? else { return Ok(None) };
    let Some(fill) = measure(gpu, &kernels, Kernel::Fill, half).await? else { return Ok(None) };
    let threads = f64::from(CALIBRATION_SIDE * CALIBRATION_SIDE);
    let flops = threads * f64::from(ALU_ITERATIONS_PER_REP * alu.reps) * ALU_FLOPS_PER_ITERATION;
    let pixels = threads * f64::from(FILL_LAYERS_PER_REP * fill.reps);
    let per_ms = |work: f64, ms: f32| (work / (f64::from(ms) * 1.0e6)) as f32;
    Ok(Some(Calibration {
        alu_gflops: per_ms(flops, alu.ms),
        fill_gpix: per_ms(pixels, fill.ms),
        gpu_ms: alu.spent_ms + fill.spent_ms,
        rounds: alu.rounds + fill.rounds,
    }))
}

/// [`calibrate`], blocking (native only; a web page awaits the future).
#[cfg(not(target_arch = "wasm32"))]
pub fn calibrate_blocking(gpu: &Gpu) -> Result<Option<Calibration>, RenderError> {
    pollster::block_on(calibrate(gpu))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn growth_heads_for_the_sample_time_in_powers_of_two() {
        assert_eq!(growth_factor(0.0), 16);
        assert_eq!(growth_factor(0.01), 16);
        assert_eq!(growth_factor(0.5), 4);
        assert_eq!(growth_factor(1.5), 2, "never less than doubling");
    }

    #[test]
    fn every_tier_floor_is_a_level_boundary() {
        for form in FormFactor::ALL {
            for (tier, level) in tier_levels(form) {
                assert_eq!(ScoreLevel::quantize(tier_floor_score(form, *tier), None), ScoreLevel(*level));
                assert_eq!(score_tier(form, ScoreLevel(*level)), *tier);
                assert!(score_tier(form, ScoreLevel(*level - 1)) < *tier);
            }
        }
        assert_eq!(tier_floor_score(FormFactor::Mobile, PerformanceTier::Ultra), f32::INFINITY);
    }
}
