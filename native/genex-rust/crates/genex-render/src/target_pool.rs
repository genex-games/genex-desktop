//! Render-target pool (plan §2.2, §2.5, §2.6): every target the frame graph draws into, allocated
//! by descriptor at the current dynamic-resolution step and registered in the budget ledger.
//!
//! - Each pooled target is an **exact size per scale step**: no sub-viewport of a larger target,
//!   so every texel of a step's target is valid. A step change reallocates (a descriptor with a new
//!   size replaces the target of the same label) and a target no longer drawn is released.
//! - **Step spares** (renderer pass 2, RC-10): where the policy keeps them ([`TargetPolicy::spares`];
//!   desktop, never phones or the web), a target replaced or released on a frame whose render
//!   size changed ([`TargetPool::note_render_size`]: a dynamic-resolution step, a capture's size,
//!   a resize) stays as its label's spare, so going back to that size swaps it in instead of
//!   allocating and clearing a new one: on an M4 Max at 1440p that allocation was most of a step
//!   frame's extra 1.3-1.7 ms. A quality change at the same render size keeps none (the pool and
//!   the budget model agree again at once). A spare is counted in the ledger under its label (the
//!   memory a step holds is in the budget, not a peak nobody sees), all spares together stay
//!   within [`SPARE_BYTES_MAX`], and a spare not swapped back within [`SPARE_IDLE_FRAMES`] frames is
//!   released, so memory is flat again once dynamic resolution settles. A spare holds a step's
//!   last contents: every pooled target is written before it is read in a frame, and AO, whose
//!   history persists, starts it over on any texture it did not hold (as for a new one).
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

/// The most bytes a pool's step spares hold together (about one 4K ultra set of render-size
/// targets at a lower step); a spare that would pass it is not kept.
pub const SPARE_BYTES_MAX: u64 = 512 << 20;
/// Acquires of its label (one a frame) after which a spare not swapped back is released: longer
/// than dynamic resolution's longest wait before a rise ([`crate::drs::RISE_BACKOFF_MAX_FRAMES`]),
/// so an oscillation keeps it and a settled scale lets it go.
pub const SPARE_IDLE_FRAMES: u32 = 600;
const _: () = assert!(SPARE_IDLE_FRAMES > crate::drs::RISE_BACKOFF_MAX_FRAMES);

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
    spares: bool,
}

impl TargetPolicy {
    /// The policy for an adapter reporting `transient_saves_memory`, on the web or not (no
    /// optional target feature).
    pub const fn new(transient_saves_memory: Option<bool>, web: bool) -> TargetPolicy {
        TargetPolicy { transient: !web && matches!(transient_saves_memory, Some(true)), features: Features::empty(), spares: false }
    }

    /// The policy keeping step spares or not (see the module docs).
    pub const fn with_spares(self, spares: bool) -> TargetPolicy {
        TargetPolicy { spares, ..self }
    }

    /// Whether a step change keeps the target it replaced as its label's spare.
    pub const fn spares(self) -> bool {
        self.spares
    }

    /// The policy with the renderer-owned target features of `features` granted.
    pub fn with_features(self, features: Features) -> TargetPolicy {
        TargetPolicy { features: features & RENDERER_TARGET_FEATURES, ..self }
    }

    /// The policy of `device`'s adapter on this destination, with the target features it was
    /// opened with. Step spares are kept on desktop only: phones and the web keep their memory
    /// flat (a phone's budget is tens of megabytes, and wasm memory never shrinks).
    pub fn for_device(device: &Device) -> TargetPolicy {
        let web = cfg!(target_arch = "wasm32");
        let phone = cfg!(any(target_os = "ios", target_os = "android"));
        let policy = TargetPolicy::new(device.adapter_info().transient_saves_memory, web).with_features(device.features());
        policy.with_spares(!web && !phone)
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

/// A target a step change replaced or a step released, kept for its label's next return to that
/// step.
#[derive(Debug)]
struct Spare {
    target: PooledTarget,
    /// Frames since it was kept.
    idle: u32,
}

/// Whether `replaced` may be kept as a spare when `next` takes its label: a step change (only the
/// size differs).
fn is_step(replaced: &TargetDesc, next: &TargetDesc) -> bool {
    replaced.size != next.size && TargetDesc { size: next.size, ..*replaced } == *next
}

/// The pool: one target per label, at the size its descriptor names, and where the policy keeps
/// them one step spare per label.
#[derive(Debug, Default)]
pub struct TargetPool {
    policy: TargetPolicy,
    targets: Vec<PooledTarget>,
    spares: Vec<Spare>,
    /// The labels acquired since the frame began: acquiring one again begins the next frame (the
    /// renderer acquires each label at most once a frame), which ages the spares.
    this_frame: Vec<&'static str>,
    /// The render size the renderer noted last, and whether the frame drawing now changed it: only
    /// such a frame keeps spares.
    render_size: Option<(u32, u32)>,
    resized: bool,
    ledger: BudgetLedger,
    generation: u64,
    allocations: u64,
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

    /// The target `desc` names: the pooled one when its descriptor is equal, the label's spare
    /// when it is the spare's (swapped in; the target it replaces becomes the spare), else a new
    /// allocation replacing the label's target (a step change, kept as the spare where the policy
    /// says). Refused before allocating when `desc` breaks [`validate`].
    pub fn acquire(&mut self, device: &Device, desc: TargetDesc) -> Result<&PooledTarget, TargetRefusal> {
        self.count_frame(desc.label);
        let held = self.targets.iter().position(|target| target.desc.label == desc.label);
        if let Some(index) = held.filter(|index| self.targets[*index].desc == desc) {
            return Ok(&self.targets[index]);
        }
        validate_with(&desc, self.policy.features)?;
        let spare = self.spares.iter().position(|spare| spare.target.desc == desc).map(|at| self.spares.swap_remove(at).target);
        let target = match spare {
            Some(target) => target,
            None => self.allocate(device, desc),
        };
        self.generation += 1;
        let index = match held {
            Some(index) => {
                let replaced = std::mem::replace(&mut self.targets[index], target);
                self.keep_or_drop(replaced);
                index
            }
            None => {
                self.targets.push(target);
                self.targets.len() - 1
            }
        };
        self.register(desc.label);
        Ok(&self.targets[index])
    }

    /// A new texture (and views) for `desc`, which [`validate_with`] passed.
    fn allocate(&mut self, device: &Device, desc: TargetDesc) -> PooledTarget {
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
        self.allocations += 1;
        PooledTarget { desc, texture, view, srgb_view }
    }

    /// The label's spare is now `replaced` when the policy keeps spares, the label's new target is
    /// a step of it (or there is none: a step released it) and the spares stay within
    /// [`SPARE_BYTES_MAX`]; otherwise it is released. Any older spare of the label goes.
    fn keep_or_drop(&mut self, replaced: PooledTarget) {
        let label = replaced.desc.label;
        self.spares.retain(|spare| spare.target.desc.label != label);
        let step = self.get(label).is_none_or(|next| is_step(&replaced.desc, &next.desc));
        let fits = self.spare_bytes().saturating_add(replaced.desc.bytes()) <= SPARE_BYTES_MAX;
        let keeps = self.policy.spares && self.resized;
        if keeps && step && fits {
            self.spares.push(Spare { target: replaced, idle: 0 });
        }
    }

    /// Note an acquire of `label`: a label acquired again since the frame began begins the next
    /// frame, and every spare ages one frame (released after [`SPARE_IDLE_FRAMES`]).
    fn count_frame(&mut self, label: &'static str) {
        if !self.this_frame.contains(&label) {
            self.this_frame.push(label);
            return;
        }
        self.this_frame.clear();
        self.this_frame.push(label);
        for spare in &mut self.spares {
            spare.idle += 1;
        }
        let stale: Vec<&'static str> = self.spares.iter().filter(|spare| spare.idle > SPARE_IDLE_FRAMES).map(|spare| spare.target.desc.label).collect();
        if stale.is_empty() {
            return;
        }
        self.spares.retain(|spare| spare.idle <= SPARE_IDLE_FRAMES);
        for label in stale {
            self.register(label);
        }
    }

    /// The ledger entry of `label`: its target's bytes and its spare's.
    fn register(&mut self, label: &str) {
        let held = self.get(label).map_or(0, |target| target.desc.bytes());
        let spare = self.spares.iter().find(|spare| spare.target.desc.label == label).map_or(0, |spare| spare.target.desc.bytes());
        self.ledger.register(BudgetKind::Target, label, held + spare);
    }

    /// Release the target `label`: its ledger entry drops to 0 bytes, or, where the policy keeps
    /// spares, to its bytes as the label's spare (a step that draws without it, such as FSR's
    /// intermediates at scale 1, gets it back when dynamic resolution steps down again).
    pub fn release(&mut self, label: &str) {
        let Some(at) = self.targets.iter().position(|target| target.desc.label == label) else { return };
        let released = self.targets.remove(at);
        self.keep_or_drop(released);
        self.register(label);
        self.generation += 1;
    }

    /// The render size of the frame the renderer is about to draw, before it acquires its targets:
    /// when it differs from the last frame's, the targets that frame replaces or releases are kept
    /// as spares (where the policy keeps them).
    pub fn note_render_size(&mut self, size: (u32, u32)) {
        self.resized = self.render_size.is_some_and(|last| last != size);
        self.render_size = Some(size);
    }

    /// Release every spare now (their ledger entries go with them).
    pub fn drop_spares(&mut self) {
        let labels: Vec<&'static str> = self.spares.drain(..).map(|spare| spare.target.desc.label).collect();
        for label in labels {
            self.register(label);
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

    /// Bumped by every allocation, spare swapped in and release: bind groups over pooled views are
    /// rebuilt when it moves.
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Textures the pool has created.
    pub fn allocations(&self) -> u64 {
        self.allocations
    }

    /// Bytes the step spares hold (counted in the ledger under their labels).
    pub fn spare_bytes(&self) -> u64 {
        self.spares.iter().map(|spare| spare.target.desc.bytes()).sum()
    }
}
