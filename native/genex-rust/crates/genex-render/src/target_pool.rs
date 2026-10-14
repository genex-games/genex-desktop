//! Render-target pool (plan §2.2, §2.5, §2.6): every target the frame graph draws into, allocated
//! by descriptor at the current dynamic-resolution step and registered in the budget ledger.
//!
//! - Each pooled target is an **exact size per scale step**: no sub-viewport of a larger target,
//!   so every texel of a step's target is valid. A step change reallocates (a descriptor with a new
//!   size replaces the target of the same label) and a target no longer drawn is released.
//! - A descriptor whose usages or sample count exceed what WebGPU core guarantees for its format
//!   (`guaranteed_format_features(Features::empty())`) is refused ([`TargetRefusal`]): no
//!   destination may need an optional feature for a renderer target. The one exception is a
//!   renderer-owned feature the device was opened with ([`RENDERER_TARGET_FEATURES`]:
//!   `rg11b10ufloat` as an attachment), which the renderer asks for only where it is granted and
//!   falls back from to a core format elsewhere.
//! - MSAA colour and depth that nothing reads get `TRANSIENT_ATTACHMENT` where the adapter reports
//!   `transient_saves_memory == Some(true)` ([`TargetPolicy`]); never on the web, where wgpu passes
//!   usage bits straight to the browser. A transient target counts 0 bytes in the ledger.

use std::fmt;

use wgpu::{Device, Features, Texture, TextureFormat, TextureUsages, TextureView};

use crate::budget::{BudgetKind, BudgetLedger, target_bytes};
use crate::error::{RenderCode, RenderError};

/// What a pooled target is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct TargetDesc {
    /// Its label (the pool's key: one target per label).
    pub label: &'static str,
    /// Its format.
    pub format: TextureFormat,
    /// Its usages.
    pub usage: TextureUsages,
    /// Samples per pixel.
    pub samples: u32,
    /// Width and height in pixels.
    pub size: (u32, u32),
    /// Mip levels.
    pub mips: u32,
    /// Whether it is also sampled through its format's sRGB twin, which decodes to linear before
    /// filtering (listed in `view_formats`, which WebGPU core allows for an sRGB twin).
    pub srgb_view: bool,
}

/// The optional features a renderer target may lean on where the device was opened with them.
pub const RENDERER_TARGET_FEATURES: Features = Features::RG11B10UFLOAT_RENDERABLE;

impl TargetDesc {
    /// Whether WebGPU core guarantees every usage and the sample count this target asks of its format.
    pub fn core_allows(&self) -> bool {
        self.allows_with(Features::empty())
    }

    /// Whether a device opened with `features` (of them, only [`RENDERER_TARGET_FEATURES`] count)
    /// takes every usage and the sample count this target asks of its format.
    pub fn allows_with(&self, features: Features) -> bool {
        let guaranteed = self.format.guaranteed_format_features(features & RENDERER_TARGET_FEATURES);
        let usages = guaranteed.allowed_usages.contains(self.usage - TextureUsages::TRANSIENT_ATTACHMENT);
        usages && (self.samples == 1 || guaranteed.flags.sample_count_supported(self.samples))
    }

    /// Whether the target is a transient attachment (it never leaves tile memory).
    pub fn transient(&self) -> bool {
        self.usage.contains(TextureUsages::TRANSIENT_ATTACHMENT)
    }

    /// Bytes per texel per sample (the depth aspect for a depth format).
    pub fn texel_bytes(&self) -> u32 {
        let aspect = self.format.is_depth_stencil_format().then_some(wgpu::TextureAspect::DepthOnly);
        self.format.block_copy_size(aspect).unwrap_or(4)
    }

    /// The bytes the ledger holds for it: 0 for a transient attachment.
    pub fn bytes(&self) -> u64 {
        let (width, height) = self.size;
        let base = target_bytes(width, height, self.texel_bytes(), self.samples, self.transient());
        // Each further mip adds a quarter of the one above it.
        (1..self.mips).fold(base, |sum, level| sum + (base >> (2 * level)))
    }
}

/// Why the pool refused a descriptor.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TargetRefusal {
    /// A usage WebGPU core does not guarantee for the format (e.g. storage on `rg16float`).
    UsageBeyondCore {
        /// The target.
        label: &'static str,
        /// Its format.
        format: TextureFormat,
        /// The usages asked.
        usage: TextureUsages,
    },
    /// A zero-sized side, zero samples or zero mips.
    Empty {
        /// The target.
        label: &'static str,
    },
    /// An sRGB view asked of a format without an sRGB twin.
    NoSrgbTwin {
        /// The target.
        label: &'static str,
        /// Its format.
        format: TextureFormat,
    },
}

impl fmt::Display for TargetRefusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TargetRefusal::UsageBeyondCore { label, format, usage } => {
                write!(f, "render target {label}: {format:?} does not take {usage:?} in WebGPU core")
            }
            TargetRefusal::Empty { label } => write!(f, "render target {label} is empty"),
            TargetRefusal::NoSrgbTwin { label, format } => write!(f, "render target {label}: {format:?} has no sRGB view format"),
        }
    }
}

impl From<TargetRefusal> for RenderError {
    fn from(refusal: TargetRefusal) -> RenderError {
        RenderError::refused(RenderCode::TextureInvalid, refusal.to_string())
    }
}

/// Check `desc` against WebGPU core before anything is allocated.
pub fn validate(desc: &TargetDesc) -> Result<(), TargetRefusal> {
    validate_with(desc, Features::empty())
}

/// Check `desc` against WebGPU core plus the renderer-owned target features a device opened with
/// `features` grants ([`RENDERER_TARGET_FEATURES`]).
pub fn validate_with(desc: &TargetDesc, features: Features) -> Result<(), TargetRefusal> {
    let (width, height) = desc.size;
    if width == 0 || height == 0 || desc.samples == 0 || desc.mips == 0 {
        return Err(TargetRefusal::Empty { label: desc.label });
    }
    if !desc.allows_with(features) {
        return Err(TargetRefusal::UsageBeyondCore { label: desc.label, format: desc.format, usage: desc.usage });
    }
    if desc.srgb_view && desc.format.add_srgb_suffix() == desc.format {
        return Err(TargetRefusal::NoSrgbTwin { label: desc.label, format: desc.format });
    }
    Ok(())
}

/// What the adapter offers attachments that are never read, and the renderer-owned target
/// features the device was opened with.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TargetPolicy {
    transient: bool,
    features: Features,
}

impl TargetPolicy {
    /// The policy for an adapter reporting `transient_saves_memory`, on the web or not (no
    /// optional target feature).
    pub const fn new(transient_saves_memory: Option<bool>, web: bool) -> TargetPolicy {
        TargetPolicy { transient: !web && matches!(transient_saves_memory, Some(true)), features: Features::empty() }
    }

    /// The policy with the renderer-owned target features of `features` granted.
    pub fn with_features(self, features: Features) -> TargetPolicy {
        TargetPolicy { features: features & RENDERER_TARGET_FEATURES, ..self }
    }

    /// The policy of `device`'s adapter on this destination, with the target features it was
    /// opened with.
    pub fn for_device(device: &Device) -> TargetPolicy {
        TargetPolicy::new(device.adapter_info().transient_saves_memory, cfg!(target_arch = "wasm32")).with_features(device.features())
    }

    /// The renderer-owned target features granted.
    pub const fn features(self) -> Features {
        self.features
    }

    /// The usages of an attachment nothing reads after its pass (MSAA colour, unread depth).
    pub const fn attachment_usage(self) -> TextureUsages {
        if self.transient {
            return TextureUsages::RENDER_ATTACHMENT.union(TextureUsages::TRANSIENT_ATTACHMENT);
        }
        TextureUsages::RENDER_ATTACHMENT
    }
}

/// A pooled target: its descriptor, texture and default view (and its sRGB view when asked).
#[derive(Clone, Debug)]
pub struct PooledTarget {
    desc: TargetDesc,
    texture: Texture,
    view: TextureView,
    srgb_view: Option<TextureView>,
}

impl PooledTarget {
    /// Its descriptor.
    pub fn desc(&self) -> &TargetDesc {
        &self.desc
    }

    /// Its texture.
    pub fn texture(&self) -> &Texture {
        &self.texture
    }

    /// Its default view.
    pub fn view(&self) -> &TextureView {
        &self.view
    }

    /// Its sRGB-twin view (sampling decodes to linear light), when the descriptor asks for one.
    pub fn srgb_view(&self) -> Option<&TextureView> {
        self.srgb_view.as_ref()
    }
}

/// The pool: one target per label, at the size its descriptor names.
#[derive(Debug, Default)]
pub struct TargetPool {
    policy: TargetPolicy,
    targets: Vec<PooledTarget>,
    ledger: BudgetLedger,
    generation: u64,
}

impl TargetPool {
    /// An empty pool with no transient attachments.
    pub fn new() -> TargetPool {
        TargetPool::default()
    }

    /// An empty pool for `policy`.
    pub fn with_policy(policy: TargetPolicy) -> TargetPool {
        TargetPool { policy, ..TargetPool::default() }
    }

    /// The pool's policy.
    pub fn policy(&self) -> TargetPolicy {
        self.policy
    }

    /// The target `desc` names: the pooled one when its descriptor is equal, else a new
    /// allocation replacing the label's target (a step change). Refused before allocating when
    /// `desc` breaks [`validate`].
    pub fn acquire(&mut self, device: &Device, desc: TargetDesc) -> Result<&PooledTarget, TargetRefusal> {
        let held = self.targets.iter().position(|target| target.desc.label == desc.label);
        if let Some(index) = held.filter(|index| self.targets[*index].desc == desc) {
            return Ok(&self.targets[index]);
        }
        validate_with(&desc, self.policy.features)?;
        let twin = [desc.format.add_srgb_suffix()];
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some(desc.label),
            size: wgpu::Extent3d { width: desc.size.0, height: desc.size.1, depth_or_array_layers: 1 },
            mip_level_count: desc.mips,
            sample_count: desc.samples,
            dimension: wgpu::TextureDimension::D2,
            format: desc.format,
            usage: desc.usage,
            view_formats: if desc.srgb_view { &twin } else { &[] },
        });
        let view = texture.create_view(&Default::default());
        let srgb_view = desc.srgb_view.then(|| texture.create_view(&wgpu::TextureViewDescriptor { format: Some(twin[0]), ..Default::default() }));
        self.ledger.register(BudgetKind::Target, desc.label, desc.bytes());
        self.generation += 1;
        let target = PooledTarget { desc, texture, view, srgb_view };
        let index = match held {
            Some(index) => {
                self.targets[index] = target;
                index
            }
            None => {
                self.targets.push(target);
                self.targets.len() - 1
            }
        };
        Ok(&self.targets[index])
    }

    /// Release the target `label` (its ledger entry drops to 0 bytes).
    pub fn release(&mut self, label: &str) {
        let before = self.targets.len();
        self.targets.retain(|target| target.desc.label != label);
        if self.targets.len() != before {
            self.ledger.register(BudgetKind::Target, label, 0);
            self.generation += 1;
        }
    }

    /// The target `label`, if pooled.
    pub fn get(&self, label: &str) -> Option<&PooledTarget> {
        self.targets.iter().find(|target| target.desc.label == label)
    }

    /// Every pooled target, in allocation order.
    pub fn targets(&self) -> &[PooledTarget] {
        &self.targets
    }

    /// The pool's ledger entries ([`BudgetKind::Target`]).
    pub fn ledger(&self) -> &BudgetLedger {
        &self.ledger
    }

    /// Bumped by every allocation and release: bind groups over pooled views are rebuilt when it
    /// moves.
    pub fn generation(&self) -> u64 {
        self.generation
    }
}
