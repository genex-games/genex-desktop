//! GPU particles (renderer pass 2 A.11): an emitter a game makes once and draws every frame with
//! `frame.particles(&emitter)`. A particle is a pure function of the emitter and the simulation
//! tick the frame is drawn at, never of earlier frames: Live and a capture of the same tick draw
//! the same particles, nothing is read back, and the simulation and its checksum never see them.
//!
//! Start from [`Particles::steam`], [`Particles::rain`] or [`Particles::fountain`] and change what
//! you need: soft billboards that fade where they meet the scene behind them, a flipbook atlas
//! from the game's assets, back-to-front sorting, and collision with what the camera sees (a
//! particle that falls behind a visible surface rests there and is gone; one that hits something
//! out of view is not stopped).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use genex_render::limits::PARTICLES_PER_EMITTER_MAX;
use genex_render::particles::{DepthCollision, EmitterDesc, FLIPBOOK_GRID_MAX};

use crate::frame::Color;
use crate::math::Vec3;

/// The most particles one emitter holds alive at once (its rate times its lifetime).
pub const PARTICLES_MAX: u32 = PARTICLES_PER_EMITTER_MAX;

/// Why a particle emitter was refused (nothing was made).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParticlesErrorCode {
    /// No particle alive, or more than [`PARTICLES_MAX`] at once.
    CountInvalid,
    /// A flipbook of no frames, or a grid of no cells or more than 16 a side.
    FlipbookInvalid,
}

impl ParticlesErrorCode {
    /// Every code.
    pub const ALL: [ParticlesErrorCode; 2] = [ParticlesErrorCode::CountInvalid, ParticlesErrorCode::FlipbookInvalid];

    /// The code's wire spelling (`particles-count-invalid`, `particles-flipbook-invalid`).
    pub const fn wire(self) -> &'static str {
        match self {
            ParticlesErrorCode::CountInvalid => "particles-count-invalid",
            ParticlesErrorCode::FlipbookInvalid => "particles-flipbook-invalid",
        }
    }
}

/// A refused emitter.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParticlesError {
    /// What was refused.
    pub code: ParticlesErrorCode,
    /// The numbers involved.
    pub detail: String,
}

impl std::fmt::Display for ParticlesError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code.wire(), self.detail)
    }
}

impl std::error::Error for ParticlesError {}

/// An emitter's flipbook: `frames` cells of the atlas image at `atlas` (an asset path), a grid of
/// `columns` × `rows` read row by row from the top left, played `cycles` times over a life.
#[derive(Clone, Debug, PartialEq)]
pub struct ParticleFlipbook {
    pub(crate) atlas: Arc<str>,
    pub(crate) columns: u32,
    pub(crate) rows: u32,
    pub(crate) frames: u32,
    pub(crate) cycles: f32,
    pub(crate) blend: bool,
}

impl ParticleFlipbook {
    /// The atlas's asset path.
    pub fn atlas(&self) -> &str {
        &self.atlas
    }

    /// The atlas grid (columns, rows).
    pub fn grid(&self) -> (u32, u32) {
        (self.columns, self.rows)
    }
}

/// What makes an emitter itself: its description and its flipbook.
#[derive(Clone, Debug, PartialEq)]
struct ParticlesLook {
    desc: EmitterDesc,
    flipbook: Option<ParticleFlipbook>,
}

#[derive(Clone, Debug, PartialEq)]
struct ParticlesInner {
    look: ParticlesLook,
    version: u64,
}

/// A particle emitter (see the module docs): a cheap handle, made in `on_reset` and kept in the
/// world. Each `with_*` answers the changed emitter; the old one draws as it did. An emitter is
/// its description: the same one made again (after a reset) is the same emitter, so the renderer
/// holds it once.
#[derive(Clone, Debug)]
pub struct Particles {
    inner: Arc<ParticlesInner>,
}

impl PartialEq for Particles {
    fn eq(&self, other: &Particles) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner) || self.inner.version == other.inner.version
    }
}

/// The most different emitters a process remembers; past them each new one is another version
/// (a game making a fresh emitter every frame then fills the renderer's 16 and is refused, logged).
const REMEMBERED_MAX: usize = 4096;

/// Versions handed out so far.
static VERSIONS: AtomicU64 = AtomicU64::new(1);
/// Every emitter made so far and its version: the same emitter made again is the same version, so
/// a reset rebuilding the world does not hand the renderer another emitter.
static REMEMBERED: Mutex<Vec<(ParticlesLook, u64)>> = Mutex::new(Vec::new());

/// `look`'s version: the one it was given when first made, or the next.
fn version_of(look: &ParticlesLook) -> u64 {
    let mut remembered = REMEMBERED.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some((_, version)) = remembered.iter().find(|(held, _)| held == look) {
        return *version;
    }
    let version = VERSIONS.fetch_add(1, Ordering::Relaxed);
    if remembered.len() < REMEMBERED_MAX {
        remembered.push((look.clone(), version));
    }
    version
}

fn rgba(color: Color) -> [u8; 4] {
    [color.r, color.g, color.b, color.a]
}

impl Particles {
    fn of(desc: EmitterDesc) -> Particles {
        let look = ParticlesLook { desc, flipbook: None };
        Particles { inner: Arc::new(ParticlesInner { version: version_of(&look), look }) }
    }

    fn changed(&self, change: impl FnOnce(&mut ParticlesLook)) -> Particles {
        let mut look = self.inner.look.clone();
        change(&mut look);
        Particles { inner: Arc::new(ParticlesInner { version: version_of(&look), look }) }
    }

    /// A warm spark fountain at `origin`: four particles a tick for a second, round glowing dots.
    pub fn fountain(origin: Vec3) -> Particles {
        Particles::of(EmitterDesc::fountain(origin.to_array(), 1))
    }

    /// Steam rising from a vent at `origin`: slow, growing, turning puffs, drawn back to front and
    /// soft where they rise past walls and the ground.
    pub fn steam(origin: Vec3) -> Particles {
        Particles::of(EmitterDesc::steam(origin.to_array(), 1))
    }

    /// Rain falling from the top face of the box centred on `origin` with half sides `extent`:
    /// streaks stopped where they meet what the camera sees (a roof, an awning, the road), faded
    /// out within two metres of the camera.
    pub fn rain(origin: Vec3, extent: Vec3) -> Particles {
        Particles::of(EmitterDesc::rain(origin.to_array(), extent.to_array(), 1))
    }

    /// `per_tick` particles spawned each tick, each living `lifetime_ticks` (60 a second). Refused
    /// `particles-count-invalid` for none alive or more than [`PARTICLES_MAX`] at once.
    pub fn with_rate(&self, per_tick: u32, lifetime_ticks: u32) -> Result<Particles, ParticlesError> {
        let alive = u64::from(per_tick) * u64::from(lifetime_ticks);
        if alive == 0 || alive > u64::from(PARTICLES_MAX) {
            return Err(ParticlesError { code: ParticlesErrorCode::CountInvalid, detail: format!("{per_tick} a tick living {lifetime_ticks} ticks: 1 to {PARTICLES_MAX} alive") });
        }
        Ok(self.changed(|look| {
            look.desc.rate_per_tick = per_tick;
            look.desc.lifetime_ticks = lifetime_ticks;
        }))
    }

    /// Moved to `origin`, spawning in the box of half sides `extent` around it.
    pub fn with_origin(&self, origin: Vec3, extent: Vec3) -> Particles {
        self.changed(|look| {
            look.desc.origin = origin.to_array();
            look.desc.extent = extent.max(Vec3::ZERO).to_array();
        })
    }

    /// Launched at `velocity` (world units a tick), each varying by up to `spread` a tick per axis,
    /// pulled by `gravity` (units a tick²).
    pub fn with_motion(&self, velocity: Vec3, spread: f32, gravity: Vec3) -> Particles {
        self.changed(|look| {
            look.desc.velocity = velocity.to_array();
            look.desc.spread = spread.max(0.0);
            look.desc.gravity = gravity.to_array();
        })
    }

    /// Born `size` world units across, `end_scale` times that at death; from `start` to `end`
    /// in colour and alpha over a life.
    pub fn with_look(&self, size: f32, end_scale: f32, start: Color, end: Color) -> Particles {
        self.changed(|look| {
            look.desc.size = size.max(0.0);
            look.desc.size_end = end_scale.max(0.0);
            look.desc.color_start = rgba(start);
            look.desc.color_end = rgba(end);
        })
    }

    /// Soft: each billboard fades out over `distance` world units as it nears the scene behind it,
    /// instead of cutting a hard line where it meets a wall or the ground (0: hard). Soft
    /// particles are soft where the quality runs the depth prepass (desktop medium and up).
    pub fn with_soft(&self, distance: f32) -> Particles {
        self.changed(|look| look.desc.soft_distance = distance.max(0.0))
    }

    /// Drawn back to front (true), as overlapping smoke and steam need, or in spawn order.
    pub fn with_sorted(&self, sorted: bool) -> Particles {
        self.changed(|look| look.desc.sorted = sorted)
    }

    /// Stopped by what the camera sees: a particle whose path went behind a visible surface (by
    /// less than `thickness` world units) rests there for `rest_ticks`, fading, then is gone.
    /// A `thickness` of 0 turns collision off.
    pub fn with_collision(&self, thickness: f32, rest_ticks: u32) -> Particles {
        let collision = (thickness > 0.0).then_some(DepthCollision { thickness, rest_ticks });
        self.changed(|look| look.desc.collision = collision)
    }

    /// Stretched along their motion across the view, trailing `ticks` of it (rain streaks; 0:
    /// square), or else turned by up to `rotation_jitter` radians at birth and `spin` radians a
    /// tick.
    pub fn with_shape(&self, ticks: f32, rotation_jitter: f32, spin: f32) -> Particles {
        self.changed(|look| {
            look.desc.stretch = ticks.max(0.0);
            look.desc.rotation_jitter = rotation_jitter;
            look.desc.spin = spin;
        })
    }

    /// Textured from the atlas image `atlas` (an asset path; sRGB) of `columns` × `rows` cells,
    /// playing `frames` of them `cycles` times over a life, cross-faded when `blend`. The cell
    /// colour multiplies the particle's colour and its alpha the coverage. Refused
    /// `particles-flipbook-invalid` for no frames or a grid of no cells or more than 16 a side.
    pub fn with_flipbook(&self, atlas: &str, columns: u32, rows: u32, frames: u32, cycles: f32, blend: bool) -> Result<Particles, ParticlesError> {
        let grid_ok = (1..=FLIPBOOK_GRID_MAX).contains(&columns) && (1..=FLIPBOOK_GRID_MAX).contains(&rows);
        if !grid_ok || frames == 0 || !cycles.is_finite() {
            return Err(ParticlesError {
                code: ParticlesErrorCode::FlipbookInvalid,
                detail: format!("{frames} frames of a {columns}x{rows} grid played {cycles} times: 1 to {FLIPBOOK_GRID_MAX} cells a side, a frame or more"),
            });
        }
        let flipbook = ParticleFlipbook { atlas: Arc::from(atlas), columns, rows, frames: frames.min(columns * rows), cycles, blend };
        Ok(self.changed(|look| look.flipbook = Some(flipbook)))
    }

    /// Spawned in another pattern: emitters of the same kind with different seeds look different.
    pub fn with_seed(&self, seed: u32) -> Particles {
        self.changed(|look| look.desc.seed = seed)
    }

    /// The renderer's emitter (its flipbook's atlas named apart, [`Particles::flipbook`]).
    pub fn desc(&self) -> EmitterDesc {
        self.inner.look.desc
    }

    /// The flipbook, if any.
    pub fn flipbook(&self) -> Option<&ParticleFlipbook> {
        self.inner.look.flipbook.as_ref()
    }

    /// This emitter's version: the same for the same emitter made again (equal description and
    /// flipbook), another for a different one.
    pub fn version(&self) -> u64 {
        self.inner.version
    }

    /// Particles alive at once.
    pub fn alive(&self) -> u32 {
        self.inner.look.desc.slots()
    }
}
