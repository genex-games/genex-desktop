//! GPU particles: a small render-only compute emitter (plan "Renderer scope"). An emitter spawns
//! `rate_per_tick` particles every tick, each living `lifetime_ticks`, so it holds
//! [`EmitterDesc::slots`] rows in a storage buffer. A compute pass writes every row and the
//! indirect draw arguments for the frame's tick; the world pass draws them as camera-facing
//! billboards after the transparent draws, depth-tested against the world. On the HDR scene
//! ([`ParticlePass::set_scene`]) a billboard writes its sRGB colour as exposed linear light and
//! depth-tests reverse-Z, like every other scene writer.
//!
//! Render-only by construction: a particle is a pure function of the emitter and the tick, never
//! of earlier frames, so Live and a capture agree whatever was drawn before; no API reads the
//! rows back, and the emitter never draws from the game's rng, so the checksum and the simulation
//! cannot see it. The hash is integer-only (the same spawn pattern on every GPU).
//!
//! Renderer pass 2 A.11 (each opt-in per emitter; [`EmitterDesc::fountain`] draws as before):
//! - **soft particles** ([`EmitterDesc::soft_distance`], after three.js r186 `SoftParticles.js`,
//!   MIT): a billboard fades as it nears the opaque scene behind it, against the prepass depth
//!   turned into view depth at half the render size (the nearest of each 2 x 2, filtered by hand)
//!   in a texture of the particles' own (`particles_depth.wgsl`; the world pass may hold the
//!   prepass depth itself as its attachment). A soft emitter asks the frame for the prepass as the
//!   extension ladder does ([`ParticlePass::inputs_of`]) wherever the quality lets the prepass run
//!   (desktop medium and up, the TAA phone path); elsewhere it draws hard;
//! - **flipbooks** ([`Flipbook`], [`ParticleAtlas`]): frames of an atlas played over a life,
//!   cross-faded on request;
//! - **back-to-front sorting** ([`EmitterDesc::sorted`]): AMD GPUParticles11's bitonic sort as
//!   Godot 4.7.2 carries it (MIT; [`sort_plan`]), in blocks of [`SORT_BLOCK`] pairs, over unique
//!   (view depth, slot) pairs, so the order is the same on every run, then a gather writes the
//!   drawn rows in that order;
//! - **depth-buffer collision** ([`DepthCollision`]): a particle's closed-form path is tested
//!   against the opaque scene's view depth; one that went behind what the camera sees (within a
//!   thickness) rests where it hit, fading out, then is gone. Being stateless, a particle that hit
//!   something out of view or behind something nearer is not stopped. Only a colliding frame's
//!   emit pass waits for the prepass: otherwise the emit, sort and gather run beside it;
//! - spawn boxes (rain and snow from a box's top, dust throughout it), growth, rotation and
//!   stretching along the motion (rain), and a per-class cap on the particles a frame draws
//!   ([`particle_cap`]): past it every n-th slot is drawn;
//! - TAA's reactive coverage marks the billboard as drawn, turned or stretched
//!   (`particle_billboard.wgsl`, shared with the draw).
//!
//! Cost (tests/particles.rs): 64k sorted, soft, colliding rain streaks at 2560 x 1440 `high` add at
//! most 0.5 ms of GPU time to a frame on the M4 Max.

use crate::compile::Compiled;
use wgpu::{BindGroup, BindGroupLayout, Buffer, BufferUsages, ComputePipeline, Device, RenderPipeline, Sampler, ShaderModule, ShaderStages, TextureFormat, TextureView};

use crate::abi::RenderInputs;
use crate::device_class::{DeviceClass, FormFactor, PerformanceTier};
use crate::error::{RenderCode, RenderError};
use crate::gpu::Gpu;
use crate::limits::{PARTICLE_EMITTERS_MAX, PARTICLES_PER_EMITTER_MAX, check_count};
use crate::renderer::{DEPTH_FORMAT, WORLD_FORMAT, WorldPass, depth_compare, shader};
use crate::tables::{buffer, entry, pipeline_layout, storage, uniform};
use crate::texture::{TextureData, TextureKind, rect_mip_chain};

/// A sorted emitter's bitonic sort (AMD GPUParticles11 via Godot 4.7.2, MIT).
pub const PARTICLES_SORT: &str = crate::shaders::minify::shipped_wgsl!(concat!(include_str!("../shaders/part2/particle.wgsl"), include_str!("../shaders/part2/particles_sort.wgsl")));
/// The opaque scene's view depth the soft billboards and the depth collision read.
pub const PARTICLES_DEPTH: &str = crate::shaders::minify::shipped_wgsl!(concat!(include_str!("../shaders/common.wgsl"), include_str!("../shaders/part2/particles_depth.wgsl")));

/// Threads per workgroup of the emitter's compute passes (`@workgroup_size` in particles_compute.wgsl).
const WORKGROUP: u32 = 64;
/// Pairs one sort workgroup holds (`SORT_SIZE` in particles_sort.wgsl; 256 threads, 16 KiB).
pub const SORT_BLOCK: u32 = 2048;
/// Threads of one global sort step's workgroup (`cs_sort_step`), each one exchange.
const SORT_STEP_THREADS: u32 = 256;
/// The view-depth pass's tile side (`@workgroup_size(8, 8)` in particles_depth.wgsl).
const DEPTH_TILE: u32 = 8;
/// Bytes of the indirect draw arguments (`draw_indirect`: vertices, instances, first vertex, first instance).
const ARGS_BYTES: u64 = 16;
/// Bytes between two sort steps' rows (WebGPU core's uniform offset alignment).
const SORT_STEP_STRIDE: u64 = 256;
/// Bytes of one (key, slot) pair.
const PAIR_BYTES: u64 = 8;
/// Bytes of one sorted emitter's segment of the shared pairs: room for the most particles an
/// emitter holds (a storage offset, so a multiple of 256).
const SEGMENT_BYTES: u64 = PARTICLES_PER_EMITTER_MAX as u64 * PAIR_BYTES;
/// Rows of the frame's sort segments (`sort_segments` in particles_sort.wgsl).
const SORT_SEGMENTS: usize = 16;
/// The most columns or rows of a flipbook atlas.
pub const FLIPBOOK_GRID_MAX: u32 = 16;
/// The smallest side (texels) a flipbook cell keeps in its atlas's coarsest mip.
const FLIPBOOK_CELL_MIP_MIN: u32 = 4;
/// Flipbook atlases one renderer may hold.
pub const PARTICLE_ATLASES_MAX: usize = 16;
/// How far in front of the camera rain fades in, world units (GA): a drop 0.6 m from Harbour
/// Street's camera drew a 9-pixel-wide streak for exactly one frame.
pub const RAIN_NEAR_FADE: f32 = 2.0;
/// The view depth the "no surface" texel holds (`PARTICLE_NO_SURFACE` in particles_depth.wgsl).
const NO_SURFACE_DEPTH: f32 = 3.0e38;

/// `GpuEmitter::flags[0]` bits (`PARTICLE_FLAG_*` in particle.wgsl).
pub mod flags {
    /// Drawn back to front.
    pub const SORTED: u32 = 1;
    /// Textured from a flipbook atlas.
    pub const FLIPBOOK: u32 = 2;
    /// The flipbook cross-fades between frames.
    pub const BLEND_FRAMES: u32 = 4;
    /// Lit by the sun and the sky (`EmitterDesc::lit` above 0).
    pub const LIT: u32 = 8;
    /// Wrapped into its box around the camera (`EmitterDesc::follow_camera`).
    pub const FOLLOW_CAMERA: u32 = 16;
}

/// The particles a frame of `class` draws at most (the per-class cap): a frame whose emitters hold
/// more draws every n-th slot of each, the same slots every frame.
pub const fn particle_cap(class: DeviceClass) -> u32 {
    match (class.form, class.tier) {
        (FormFactor::Desktop, _) => PARTICLES_PER_EMITTER_MAX * PARTICLE_EMITTERS_MAX as u32,
        (FormFactor::Mobile, PerformanceTier::High) => 32_768,
        (FormFactor::Mobile, _) => 8_192,
    }
}

/// The draw stride a frame whose emitters hold `slots` particles takes under `cap`: 1 (every
/// slot) within it, else the smallest n whose every n-th slot fits.
pub const fn draw_stride(slots: u64, cap: u32) -> u32 {
    let cap = if cap == 0 { 1 } else { cap as u64 };
    let stride = slots.div_ceil(cap);
    if stride <= 1 { 1 } else { stride as u32 }
}

/// A flipbook atlas: an sRGB image of `columns` × `rows` equal cells, frame 0 top left, row by row.
#[derive(Clone, Debug, PartialEq)]
pub struct ParticleAtlas {
    /// The image.
    pub image: TextureData,
    /// Cells across.
    pub columns: u32,
    /// Cells down.
    pub rows: u32,
}

impl ParticleAtlas {
    /// Refuse `texture-invalid` for a grid of no cells, more than [`FLIPBOOK_GRID_MAX`] a side or
    /// cells smaller than a texel.
    pub fn check(&self) -> Result<(), RenderError> {
        let grid_ok = (1..=FLIPBOOK_GRID_MAX).contains(&self.columns) && (1..=FLIPBOOK_GRID_MAX).contains(&self.rows);
        if !grid_ok || self.image.width() < self.columns || self.image.height() < self.rows {
            return Err(RenderError::refused(
                RenderCode::TextureInvalid,
                format!("a {}x{} atlas grid over {}x{} texels: 1 to {FLIPBOOK_GRID_MAX} cells a side, each a texel or more", self.columns, self.rows, self.image.width(), self.image.height()),
            ));
        }
        crate::caps::check_texture(self.image.width(), self.image.height(), 4)
    }

    /// Mip levels the atlas keeps: down to cells of [`FLIPBOOK_CELL_MIP_MIN`] texels (a coarser
    /// level would blend neighbouring frames), at least one.
    pub fn mip_levels(&self) -> u32 {
        let cell = (self.image.width() / self.columns).min(self.image.height() / self.rows).max(1);
        let mut levels = 1;
        while (cell >> levels) >= FLIPBOOK_CELL_MIP_MIN {
            levels += 1;
        }
        levels
    }
}

/// A flipbook atlas a renderer holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ParticleAtlasId(u32);

impl ParticleAtlasId {
    /// The atlas at index `raw` of a renderer (it may name none: an emitter naming none is refused).
    pub const fn from_raw(raw: u32) -> ParticleAtlasId {
        ParticleAtlasId(raw)
    }

    /// The raw index.
    pub const fn raw(self) -> u32 {
        self.0
    }
}

/// An emitter's flipbook: `frames` cells of its atlas played `cycles` times over each particle's
/// life.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Flipbook {
    /// The atlas.
    pub atlas: ParticleAtlasId,
    /// Frames it plays (at most the atlas's cells).
    pub frames: u32,
    /// Times the frames play over a life (1: once, birth to death).
    pub cycles: f32,
    /// Cross-fade between a frame and the next.
    pub blend: bool,
}

/// Depth-buffer collision: a particle whose path went behind the opaque scene the camera sees, by
/// less than `thickness`, rests where it hit for `rest_ticks` (fading out), then is gone.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DepthCollision {
    /// How far behind a visible surface (world units) a path still counts as hitting it.
    pub thickness: f32,
    /// Ticks a particle rests where it hit (0: gone at once).
    pub rest_ticks: u32,
}

/// What an emitter spawns. Velocities are in world units per tick, gravity per tick².
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EmitterDesc {
    /// Where particles spawn.
    pub origin: [f32; 3],
    /// Half the sides of the box around `origin` particles spawn in (0: the point).
    pub extent: [f32; 3],
    /// Their initial velocity.
    pub velocity: [f32; 3],
    /// Each particle's speed varies by up to this fraction.
    pub speed_jitter: f32,
    /// Each particle's velocity varies by up to this much per axis.
    pub spread: f32,
    /// Acceleration.
    pub gravity: [f32; 3],
    /// A newborn particle's size in world units.
    pub size: f32,
    /// Its size at death as a multiple of `size` (0.5: it halves over its life).
    pub size_end: f32,
    /// sRGB colour and alpha at birth.
    pub color_start: [u8; 4],
    /// sRGB colour and alpha at death.
    pub color_end: [u8; 4],
    /// Particles spawned each tick.
    pub rate_per_tick: u32,
    /// Ticks each particle lives.
    pub lifetime_ticks: u32,
    /// The spawn pattern's seed (not the game's rng).
    pub seed: u32,
    /// Each particle starts turned by up to this many radians either way.
    pub rotation_jitter: f32,
    /// Radians a particle turns each tick.
    pub spin: f32,
    /// Stretch along the motion: a billboard lies along its particle's motion across the view and
    /// trails this many ticks of it (rain streaks; 0: square, turned by its rotation).
    pub stretch: f32,
    /// Soft particles: world units over which a billboard fades out as it nears the opaque scene
    /// behind it (0: a hard intersection).
    pub soft_distance: f32,
    /// Camera fade: world units in front of the camera over which a billboard fades in (nothing
    /// within the first quarter), so a particle passing just in front of the lens draws no wide
    /// one-frame streak (0: none).
    pub near_fade: f32,
    /// Draw back to front (a GPU bitonic sort by view depth) instead of in slot order.
    pub sorted: bool,
    /// Textured from a flipbook atlas instead of the round dot.
    pub flipbook: Option<Flipbook>,
    /// Stopped by the opaque scene the camera sees.
    pub collision: Option<DepthCollision>,
    /// Each particle's size varies by up to this fraction either way, `0..=0.9` (0: all one
    /// size; 0.5: from half to one and a half; AAA materials, review WP-13).
    pub size_variance: f32,
    /// How much the sun (through its cascaded shadows) and the sky light the particles, `0..=1`
    /// (0: their colour as given, unlit, as before; 1: a white flake in shade is as dark as the
    /// shade). Lit once per billboard at its centre.
    pub lit: f32,
    /// The wind's gusts: the peak extra velocity (world units a tick) a gust adds, swelling and
    /// dying over `gust_period` ticks and moving across the box as a front (0: steady air).
    pub gust: [f32; 3],
    /// Ticks between one gust's peak and the next (≥ 30 when there are gusts).
    pub gust_period: f32,
    /// Flutter: each particle sways about its path by up to `flutter[0]` world units, one sway
    /// every `flutter[1]` ticks (a snowflake's tumble; 0: straight).
    pub flutter: [f32; 2],
    /// An endless field that follows the view (weather): every particle is wrapped into the box of
    /// half sides `extent` around the camera, so the density holds wherever the camera goes, and
    /// fades out over the box's outer tenth and its first and last twentieth of a life. `origin`
    /// is then the box centre's offset from the camera ([`crate::weather`]).
    pub follow_camera: bool,
}

impl EmitterDesc {
    /// A warm fountain at `origin`: four particles a tick, a second's life.
    pub fn fountain(origin: [f32; 3], seed: u32) -> EmitterDesc {
        EmitterDesc {
            origin,
            extent: [0.0; 3],
            velocity: [0.0, 0.06, 0.0],
            speed_jitter: 0.25,
            spread: 0.02,
            gravity: [0.0, -0.0015, 0.0],
            size: 0.14,
            size_end: 0.5,
            color_start: [255, 210, 90, 255],
            color_end: [255, 60, 20, 0],
            rate_per_tick: 4,
            lifetime_ticks: 60,
            seed,
            rotation_jitter: 0.0,
            spin: 0.0,
            stretch: 0.0,
            soft_distance: 0.0,
            near_fade: 0.0,
            sorted: false,
            flipbook: None,
            collision: None,
            size_variance: 0.0,
            lit: 0.0,
            gust: [0.0; 3],
            gust_period: 0.0,
            flutter: [0.0; 2],
            follow_camera: false,
        }
    }

    /// Steam rising from a vent at `origin` (a 0.3 m square): slow, growing, turning puffs, sorted
    /// and soft against what they rise past.
    pub fn steam(origin: [f32; 3], seed: u32) -> EmitterDesc {
        EmitterDesc {
            extent: [0.15, 0.0, 0.15],
            velocity: [0.0, 0.012, 0.0],
            speed_jitter: 0.3,
            spread: 0.004,
            gravity: [0.0, 0.00004, 0.0],
            size: 0.35,
            size_end: 3.0,
            color_start: [215, 218, 222, 110],
            color_end: [200, 204, 210, 0],
            rate_per_tick: 2,
            lifetime_ticks: 180,
            rotation_jitter: std::f32::consts::PI,
            spin: 0.004,
            soft_distance: 0.6,
            sorted: true,
            ..EmitterDesc::fountain(origin, seed)
        }
    }

    /// Rain over the box of half sides `extent` around `origin` (its top): streaks falling 9 m/s
    /// at 60 ticks a second, stopped where they meet what the camera sees, and faded out over the
    /// [`RAIN_NEAR_FADE`] in front of the camera.
    pub fn rain(origin: [f32; 3], extent: [f32; 3], seed: u32) -> EmitterDesc {
        EmitterDesc {
            extent,
            velocity: [0.004, -0.15, 0.0],
            speed_jitter: 0.1,
            spread: 0.003,
            gravity: [0.0; 3],
            size: 0.012,
            size_end: 1.0,
            color_start: [190, 200, 215, 120],
            color_end: [190, 200, 215, 120],
            rate_per_tick: 160,
            lifetime_ticks: 60,
            stretch: 1.6,
            soft_distance: 0.05,
            near_fade: RAIN_NEAR_FADE,
            collision: Some(DepthCollision { thickness: 0.6, rest_ticks: 0 }),
            ..EmitterDesc::fountain(origin, seed)
        }
    }

    /// Snow over the box of half sides `extent` around `origin` (its top, as for
    /// [`EmitterDesc::rain`]): round soft flakes 2.5 cm across, near-white with a touch of blue,
    /// falling 1 m/s (± 20%) and drifting up to 0.18 m/s on each axis, 14 a tick living 12 s
    /// (10 080 alive), so nearly every flake reaches the ground from 8-10 m. A flake that meets
    /// what the camera sees rests there for half a second, fading; flakes fade against the scene
    /// over 10 cm and in over the [`RAIN_NEAR_FADE`] in front of the camera. Weather is these
    /// dots, never meshes.
    pub fn snow(origin: [f32; 3], extent: [f32; 3], seed: u32) -> EmitterDesc {
        EmitterDesc {
            extent,
            velocity: [0.0, -0.0167, 0.0],
            speed_jitter: 0.2,
            spread: 0.003,
            gravity: [0.0; 3],
            size: 0.025,
            size_end: 1.0,
            color_start: [235, 240, 255, 200],
            color_end: [235, 240, 255, 160],
            rate_per_tick: 14,
            lifetime_ticks: 720,
            soft_distance: 0.1,
            near_fade: RAIN_NEAR_FADE,
            // A collision samples a 12 s path 24 times (0.5 m apart at 1 m/s): thicker than that.
            collision: Some(DepthCollision { thickness: 0.8, rest_ticks: 30 }),
            ..EmitterDesc::fountain(origin, seed)
        }
    }

    /// Dust motes hanging in the air of the box of half sides `extent` around `origin` (a room, a
    /// sunbeam): round soft specks 5 mm across, warm and faint (alpha 70 of 255, fading out over
    /// a life), born anywhere in the box, sinking 6 mm/s and drifting up to 1.8 cm/s on each axis,
    /// one a tick for 20 s (1 200 alive). They are not lit: give the box a sunbeam's extent for
    /// motes in the light. They fade against the scene over 2 cm and in over 0.4 m in front of
    /// the camera.
    pub fn dust(origin: [f32; 3], extent: [f32; 3], seed: u32) -> EmitterDesc {
        EmitterDesc {
            extent,
            velocity: [0.0, -0.0001, 0.0],
            speed_jitter: 0.5,
            spread: 0.0003,
            gravity: [0.0; 3],
            size: 0.005,
            size_end: 1.0,
            color_start: [255, 236, 200, 70],
            color_end: [255, 236, 200, 0],
            rate_per_tick: 1,
            lifetime_ticks: 1200,
            soft_distance: 0.02,
            near_fade: 0.4,
            ..EmitterDesc::fountain(origin, seed)
        }
    }

    /// Rows the emitter holds: every particle alive at once.
    pub fn slots(&self) -> u32 {
        self.rate_per_tick.saturating_mul(self.lifetime_ticks)
    }

    /// Whether the emitter reads the opaque scene's depth (soft or colliding).
    pub fn reads_depth(&self) -> bool {
        self.soft_distance > 0.0 || self.collides()
    }

    /// Whether the emitter's particles collide with the opaque scene the camera sees.
    pub fn collides(&self) -> bool {
        self.collision.is_some_and(|collision| collision.thickness > 0.0)
    }

    /// Refuse `buffer-too-large` for an empty emitter or one above [`PARTICLES_PER_EMITTER_MAX`],
    /// and `texture-invalid` for a flipbook of no frames.
    pub fn check(&self) -> Result<(), RenderError> {
        let slots = self.rate_per_tick.checked_mul(self.lifetime_ticks);
        if !matches!(slots, Some(n) if n > 0 && n <= PARTICLES_PER_EMITTER_MAX) {
            return Err(RenderError::refused(
                RenderCode::BufferTooLarge,
                format!("{} a tick living {} ticks: between 1 and {PARTICLES_PER_EMITTER_MAX} particles", self.rate_per_tick, self.lifetime_ticks),
            ));
        }
        if let Some(book) = self.flipbook
            && (book.frames == 0 || !book.cycles.is_finite())
        {
            return Err(RenderError::refused(RenderCode::TextureInvalid, format!("a flipbook of {} frames played {} times", book.frames, book.cycles)));
        }
        Ok(())
    }

    /// The emitter's uniforms for `tick` (`Emitter`), drawing every `stride`-th slot and its
    /// flipbook on a grid of `grid` (columns, rows).
    pub fn to_gpu(&self, tick: u64) -> GpuEmitter {
        self.to_gpu_with(tick, 1, (1, 1))
    }

    /// [`EmitterDesc::to_gpu`] drawing every `stride`-th slot, its flipbook on a `grid` of
    /// (columns, rows).
    pub fn to_gpu_with(&self, tick: u64, stride: u32, grid: (u32, u32)) -> GpuEmitter {
        let slots = u64::from(self.slots().max(1));
        // Particles spawned through `tick` (tick 0 spawns the first `rate`).
        let spawned = tick.saturating_add(1).saturating_mul(u64::from(self.rate_per_tick)).max(1);
        let newest = spawned - 1;
        let color = |c: [u8; 4]| c.map(|v| f32::from(v) / 255.0);
        let [vx, vy, vz] = self.velocity;
        let [gx, gy, gz] = self.gravity;
        let collision = self.collision.unwrap_or(DepthCollision { thickness: 0.0, rest_ticks: 0 });
        let mut bits = if self.sorted { flags::SORTED } else { 0 };
        let lit = finite_unit(self.lit);
        if lit > 0.0 {
            bits |= flags::LIT;
        }
        if self.follow_camera {
            bits |= flags::FOLLOW_CAMERA;
        }
        let mut book = [0.0; 4];
        if let Some(flipbook) = self.flipbook {
            bits |= flags::FLIPBOOK;
            if flipbook.blend {
                bits |= flags::BLEND_FRAMES;
            }
            let frames = flipbook.frames.min(grid.0 * grid.1).max(1);
            book = [grid.0 as f32, grid.1 as f32, frames as f32, flipbook.cycles];
        }
        GpuEmitter {
            origin: [self.origin[0], self.origin[1], self.origin[2], self.size],
            velocity: [vx, vy, vz, self.speed_jitter],
            gravity: [gx, gy, gz, self.spread],
            color_start: color(self.color_start),
            color_end: color(self.color_end),
            params: [self.rate_per_tick, self.lifetime_ticks, self.seed, self.slots()],
            spawn: [(newest % slots) as u32, newest as u32, (newest >> 32) as u32, spawned.min(slots) as u32],
            shape: [self.size_end, self.rotation_jitter, self.spin, self.stretch],
            surface: [self.soft_distance.max(0.0), collision.thickness.max(0.0), collision.rest_ticks as f32, self.near_fade.max(0.0)],
            book,
            flags: [bits, stride.max(1), 0, 0],
            extent: [self.extent[0], self.extent[1], self.extent[2], 0.0],
            weather: self.gust_row(),
            flutter: [finite_or_zero(self.flutter[0]).max(0.0), finite_or_zero(self.flutter[1]).max(0.0), finite_or_zero(self.size_variance).clamp(0.0, SIZE_VARIANCE_MAX), lit],
        }
    }

    /// The gusts' row: their peak velocity and period, zero without gusts (a period under
    /// [`GUST_PERIOD_MIN_TICKS`] reads as that).
    fn gust_row(&self) -> [f32; 4] {
        let [x, y, z] = self.gust.map(finite_or_zero);
        if x == 0.0 && y == 0.0 && z == 0.0 {
            return [0.0; 4];
        }
        [x, y, z, finite_or_zero(self.gust_period).max(GUST_PERIOD_MIN_TICKS)]
    }
}

/// The largest size variance an emitter keeps (a flake is never smaller than a tenth of its size).
pub const SIZE_VARIANCE_MAX: f32 = 0.9;
/// The shortest gust period an emitter keeps, in ticks (half a second).
pub const GUST_PERIOD_MIN_TICKS: f32 = 30.0;

/// `value`, or 0 when it is not finite.
fn finite_or_zero(value: f32) -> f32 {
    if value.is_finite() { value } else { 0.0 }
}

/// `value` held to `0..=1`, 0 when it is not finite.
fn finite_unit(value: f32) -> f32 {
    finite_or_zero(value).clamp(0.0, 1.0)
}

/// An emitter's uniforms for one tick (`Emitter`).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, bytemuck::Pod, bytemuck::Zeroable)]
pub struct GpuEmitter {
    /// xyz origin, w size.
    pub origin: [f32; 4],
    /// xyz velocity, w speed jitter.
    pub velocity: [f32; 4],
    /// xyz gravity, w spread.
    pub gravity: [f32; 4],
    /// sRGB colour at birth, 0..1.
    pub color_start: [f32; 4],
    /// sRGB colour at death, 0..1.
    pub color_end: [f32; 4],
    /// Rate, lifetime, seed, slots.
    pub params: [u32; 4],
    /// (spawned − 1) mod slots, spawned − 1 (low, high words), spawned slots.
    pub spawn: [u32; 4],
    /// Size at death over size at birth, rotation jitter, spin, stretch.
    pub shape: [f32; 4],
    /// Soft distance, collision thickness, rest ticks, near fade.
    pub surface: [f32; 4],
    /// Flipbook columns, rows, frames, cycles (0 without one).
    pub book: [f32; 4],
    /// [`flags`] bits, the draw stride, 0, 0.
    pub flags: [u32; 4],
    /// xyz: half the spawn box's sides; w 0.
    pub extent: [f32; 4],
    /// xyz: the gusts' peak extra velocity; w: their period in ticks (0: no gusts).
    pub weather: [f32; 4],
    /// x: the flutter's reach (world units), y: its period in ticks, z: the size variance, w: how
    /// lit the particles are (0..1).
    pub flutter: [f32; 4],
}

/// One particle row (`Particle`).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, bytemuck::Pod, bytemuck::Zeroable)]
pub struct GpuParticle {
    /// xyz position, w size (0: not drawn).
    pub position_size: [f32; 4],
    /// sRGB colour and alpha, 0..1.
    pub color: [f32; 4],
}

/// One particle's shape (`ParticleShape`), row for row with [`GpuParticle`].
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, bytemuck::Pod, bytemuck::Zeroable)]
pub struct GpuParticleShape {
    /// xyz velocity (world units a tick), w rotation (radians).
    pub motion: [f32; 4],
    /// x life (0..1), yzw 0.
    pub life: [f32; 4],
}

/// One global step of the bitonic sort (`SortStep`): the merge's sub size, the partner's offset and
/// direction (a flip mirrors: offset 2·sub − 1, direction −1; otherwise sub and 1), 0.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, bytemuck::Pod, bytemuck::Zeroable)]
pub struct GpuSortStep {
    /// Sub size, partner offset, direction, 0.
    pub params: [i32; 4],
}

/// One sorted emitter's row of a frame's sort (`sort_segments` in particles_sort.wgsl): its first
/// pair in the shared pairs, its count, 0, 0.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, bytemuck::Pod, bytemuck::Zeroable)]
pub struct GpuSortSegment {
    /// First pair, count, 0, 0.
    pub span: [u32; 4],
}

/// One dispatch of an emitter's sort ([`sort_plan`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SortDispatch {
    /// Sort each [`SORT_BLOCK`] pairs in workgroup memory.
    Block,
    /// One global step: row `n` of [`sort_steps`].
    Step(usize),
    /// The rest of a merge (sub sizes below [`SORT_BLOCK`]) in workgroup memory.
    Inner,
}

/// The global steps every sort shares, in the order [`sort_plan`] takes them: for each merge from
/// 2 × [`SORT_BLOCK`] up to [`PARTICLES_PER_EMITTER_MAX`], its sub sizes down to [`SORT_BLOCK`].
pub fn sort_steps() -> Vec<GpuSortStep> {
    let mut rows = Vec::new();
    let mut merge = SORT_BLOCK * 2;
    while merge / 2 < PARTICLES_PER_EMITTER_MAX {
        let mut sub = merge / 2;
        while sub > SORT_BLOCK / 2 {
            let flip = sub == merge / 2;
            let params = if flip { [sub as i32, 2 * sub as i32 - 1, -1, 0] } else { [sub as i32, sub as i32, 1, 0] };
            rows.push(GpuSortStep { params });
            sub /= 2;
        }
        merge *= 2;
    }
    rows
}

/// The dispatches that sort `count` pairs: a block sort, then for each merge past one block its
/// global steps and the inner rest. Nothing for one pair or none.
pub fn sort_plan(count: u32) -> Vec<SortDispatch> {
    if count <= 1 {
        return Vec::new();
    }
    let mut plan = vec![SortDispatch::Block];
    let mut row = 0;
    let mut merge = SORT_BLOCK * 2;
    while merge / 2 < count {
        let mut sub = merge / 2;
        while sub > SORT_BLOCK / 2 {
            plan.push(SortDispatch::Step(row));
            row += 1;
            sub /= 2;
        }
        plan.push(SortDispatch::Inner);
        merge *= 2;
    }
    plan
}

/// An emitter a renderer holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct EmitterId(u32);

impl EmitterId {
    /// The raw index.
    pub const fn raw(self) -> u32 {
        self.0
    }
}

/// What a sorted emitter adds: its pairs, the drawn rows and shapes in order and the groups over
/// them.
struct SortedRows {
    /// Its segment of the shared pairs.
    segment: u32,
    drawn: Buffer,
    drawn_shapes: Buffer,
    gather_group: BindGroup,
}

struct Emitter {
    desc: EmitterDesc,
    uniforms: Buffer,
    rows: Buffer,
    shapes: Buffer,
    args: Buffer,
    sorted: Option<SortedRows>,
    compute_group: BindGroup,
    draw_group: BindGroup,
}

impl Emitter {
    fn bytes(&self) -> u64 {
        let sorted = self.sorted.as_ref().map_or(0, |s| s.drawn.size() + s.drawn_shapes.size());
        self.rows.size() + self.shapes.size() + sorted
    }
}

/// A flipbook atlas the renderer holds: its grid, its view and its bytes (every mip).
struct Atlas {
    grid: (u32, u32),
    view: TextureView,
    bytes: u64,
}

/// What every sorted emitter shares: the pairs, the frame's segment rows and the group over both.
struct SharedSort {
    pairs: Buffer,
    segments: Buffer,
    group: BindGroup,
    /// The frame's sorted emitters: their count and the largest count among them.
    frame: (u32, u32),
}

/// The shared pairs and segment rows for `segments` sorted emitters, and the group over them.
fn shared_sort(device: &Device, layouts: &Layouts, segments: u64, read_back: bool) -> Result<SharedSort, RenderError> {
    // Only the diagnostic sort reads its pairs back; a renderer's never leave the GPU.
    let usage = if read_back { BufferUsages::STORAGE | BufferUsages::COPY_DST | BufferUsages::COPY_SRC } else { BufferUsages::STORAGE };
    let pairs = buffer(device, "particle sort pairs", segments * SEGMENT_BYTES, usage)?;
    let rows = buffer(device, "particle sort segments", (SORT_SEGMENTS * size_of::<GpuSortSegment>()) as u64, BufferUsages::UNIFORM | BufferUsages::COPY_DST)?;
    let group = device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("particles sort"), layout: &layouts.sort, entries: &[entry(0, &rows), entry(1, &pairs)] });
    Ok(SharedSort { pairs, segments: rows, group, frame: (0, 0) })
}

/// `segment`'s range of the shared pairs, `slots` long.
fn segment_binding(pairs: &Buffer, segment: u32, slots: u64) -> wgpu::BindingResource<'_> {
    wgpu::BindingResource::Buffer(wgpu::BufferBinding { buffer: pairs, offset: u64::from(segment) * SEGMENT_BYTES, size: std::num::NonZeroU64::new(slots * PAIR_BYTES) })
}

/// The layouts the particle passes bind.
struct Layouts {
    /// Emit, group 0: the emitter, rows, arguments, keys and shapes.
    emit: BindGroupLayout,
    /// Gather, group 0: the emitter, rows, keys, shapes and the drawn rows and shapes.
    gather: BindGroupLayout,
    /// Emit and gather, group 1: the frame and the scene's view depth.
    inputs: BindGroupLayout,
    /// Sort, group 0: the frame's segment rows and the shared pairs.
    sort: BindGroupLayout,
    /// Sort, group 1: one step's row (dynamic offset).
    step: BindGroupLayout,
    /// The view-depth pass: the frame, the prepass depth and the view depth.
    depth: BindGroupLayout,
    /// Draw, group 0: the frame, fog, environment, aerial volume and the scene's view depth.
    frame: BindGroupLayout,
    /// Draw, group 1: the rows, the emitter, the shapes and the flipbook.
    rows: BindGroupLayout,
}

/// The compute pipelines.
struct Kernels {
    emit: Compiled<ComputePipeline>,
    gather: Compiled<ComputePipeline>,
    sort_block: Compiled<ComputePipeline>,
    sort_step: Compiled<ComputePipeline>,
    sort_inner: Compiled<ComputePipeline>,
    depth: Compiled<ComputePipeline>,
}

/// What the passes bind beside the emitters: the sort's step table, a key buffer for emitters
/// that never sort, the white flipbook and the "no surface" depth.
struct Fixtures {
    step_group: BindGroup,
    no_keys: Buffer,
    white: TextureView,
    sampler: Sampler,
    no_surface: TextureView,
}

/// The emitters a renderer holds and the ones this frame draws.
pub(crate) struct ParticlePass {
    kernels: Kernels,
    draw: Compiled<RenderPipeline>,
    draw_module: ShaderModule,
    samples: u32,
    /// The scene the draw pipeline targets: its colour format and whether depth is reversed.
    scene: (TextureFormat, bool),
    layouts: Layouts,
    fixtures: Fixtures,
    atlases: Vec<Atlas>,
    emitters: Vec<Emitter>,
    /// The sorted emitters' (key, slot) pairs, one segment each, and the frame's sort over them
    /// (made with the first sorted emitter).
    sort: Option<SharedSort>,
    frame: Vec<EmitterId>,
    frame_group: Option<BindGroup>,
    /// The particles a frame draws at most ([`particle_cap`]).
    cap: u32,
    /// The prepass depth node 9 handed over this frame (None: it did not run).
    scene_depth: Option<TextureView>,
    /// The view depth the particles read, and its size (half the render size it was made for).
    view_depth: Option<(TextureView, (u32, u32))>,
    /// TAA's reactive coverage of the billboards (graph node 15a; RQ5.6) and the depth convention
    /// it was made for, made on the first TAA frame that draws particles.
    reactive: Option<(Compiled<RenderPipeline>, bool)>,
}

/// Blending over the frame while keeping the target's alpha (1), as the transparent draws do.
const BLEND_OVER: wgpu::BlendState = wgpu::BlendState {
    color: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::SrcAlpha, dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha, operation: wgpu::BlendOperation::Add },
    alpha: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::Zero, dst_factor: wgpu::BlendFactor::One, operation: wgpu::BlendOperation::Add },
};

fn layout(device: &Device, label: &str, entries: &[wgpu::BindGroupLayoutEntry]) -> BindGroupLayout {
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some(label), entries })
}

fn texture_entry(binding: u32, visibility: ShaderStages, sample_type: wgpu::TextureSampleType, view_dimension: wgpu::TextureViewDimension) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry { binding, visibility, ty: wgpu::BindingType::Texture { sample_type, view_dimension, multisampled: false }, count: None }
}

fn view_entry(binding: u32, view: &TextureView) -> wgpu::BindGroupEntry<'_> {
    wgpu::BindGroupEntry { binding, resource: wgpu::BindingResource::TextureView(view) }
}

fn make_layouts(device: &Device) -> Layouts {
    let compute = ShaderStages::COMPUTE;
    let fragment = ShaderStages::FRAGMENT;
    let unfilterable = wgpu::TextureSampleType::Float { filterable: false };
    let filterable = wgpu::TextureSampleType::Float { filterable: true };
    let d2 = wgpu::TextureViewDimension::D2;
    let emit = layout(device, "particles emit", &[uniform(0, false, compute), storage(1, false, compute), storage(2, false, compute), storage(3, false, compute), storage(4, false, compute)]);
    let gather = layout(
        device,
        "particles gather",
        &[uniform(0, false, compute), storage(1, false, compute), storage(3, false, compute), storage(4, false, compute), storage(5, false, compute), storage(6, false, compute)],
    );
    let inputs = layout(device, "particles inputs", &[uniform(0, false, compute), texture_entry(1, compute, unfilterable, d2)]);
    let sort = layout(device, "particles sort", &[uniform(0, false, compute), storage(1, false, compute)]);
    let step = layout(device, "particles sort step", &[uniform(0, true, compute)]);
    let depth = layout(
        device,
        "particles depth",
        &[
            uniform(0, false, compute),
            texture_entry(1, compute, wgpu::TextureSampleType::Depth, d2),
            wgpu::BindGroupLayoutEntry {
                binding: 2,
                visibility: compute,
                ty: wgpu::BindingType::StorageTexture { access: wgpu::StorageTextureAccess::WriteOnly, format: TextureFormat::R32Float, view_dimension: d2 },
                count: None,
            },
        ],
    );
    // The vertex stage reads the fog row, the environment's prefiltered cube (the fog's in-scatter
    // under a sky or a map) and the aerial-perspective volume at each billboard's centre; the soft
    // fade the scene's view depth; a lit emitter's vertices the sun's cascaded shadow maps.
    let both = ShaderStages::VERTEX_FRAGMENT;
    let frame = layout(
        device,
        "particles frame",
        &[
            uniform(0, false, ShaderStages::VERTEX_FRAGMENT),
            uniform(1, false, both),
            texture_entry(2, both, filterable, wgpu::TextureViewDimension::Cube),
            wgpu::BindGroupLayoutEntry { binding: 3, visibility: both, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
            texture_entry(4, both, filterable, wgpu::TextureViewDimension::D3),
            texture_entry(5, fragment, unfilterable, d2),
            texture_entry(6, ShaderStages::VERTEX, wgpu::TextureSampleType::Depth, wgpu::TextureViewDimension::D2Array),
            wgpu::BindGroupLayoutEntry { binding: 7, visibility: ShaderStages::VERTEX, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Comparison), count: None },
        ],
    );
    let rows = layout(
        device,
        "particles rows",
        &[
            storage(0, true, ShaderStages::VERTEX),
            uniform(1, false, ShaderStages::VERTEX_FRAGMENT),
            storage(2, true, ShaderStages::VERTEX),
            texture_entry(3, fragment, filterable, d2),
            wgpu::BindGroupLayoutEntry { binding: 4, visibility: fragment, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
        ],
    );
    Layouts { emit, gather, inputs, sort, step, depth, frame, rows }
}

fn kernel(device: &Device, label: &str, module: &ShaderModule, entry_point: &str, groups: &[&BindGroupLayout], options: wgpu::PipelineCompilationOptions<'_>) -> Compiled<ComputePipeline> {
    crate::compile::compute_pipeline(device, &wgpu::ComputePipelineDescriptor {
        label: Some(label),
        layout: Some(&pipeline_layout(device, label, groups)),
        module,
        entry_point: Some(entry_point),
        compilation_options: options,
        cache: None,
    })
}

fn make_kernels(device: &Device, layouts: &Layouts) -> Result<Kernels, RenderError> {
    let compute = shader(device, "particles compute", crate::shaders::PARTICLES_COMPUTE)?;
    let sort = shader(device, "particles sort", PARTICLES_SORT)?;
    let depth = shader(device, "particles depth", PARTICLES_DEPTH)?;
    let plain = wgpu::PipelineCompilationOptions::default;
    // The sort's workgroup memory is written by every lane before any reads it
    // (`compile::WORKGROUP_AUDIT`).
    let audited = crate::compile::written_first;
    Ok(Kernels {
        emit: kernel(device, "particles", &compute, "cs_particles", &[&layouts.emit, &layouts.inputs], plain()),
        gather: kernel(device, "particles gather", &compute, "cs_particles_gather", &[&layouts.gather], plain()),
        sort_block: kernel(device, "particles sort block", &sort, "cs_sort_block", &[&layouts.sort, &layouts.step], audited()),
        sort_step: kernel(device, "particles sort step", &sort, "cs_sort_step", &[&layouts.sort, &layouts.step], plain()),
        sort_inner: kernel(device, "particles sort inner", &sort, "cs_sort_inner", &[&layouts.sort, &layouts.step], audited()),
        depth: kernel(device, "particles depth", &depth, "cs_particle_depth", &[&layouts.depth], plain()),
    })
}

/// A 1 × 1 texture of `format` holding `texel`.
fn texel_view(gpu: &Gpu, label: &str, format: TextureFormat, texel: &[u8]) -> TextureView {
    let size = wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 };
    let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    let layout = wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(texel.len() as u32), rows_per_image: Some(1) };
    gpu.queue.write_texture(texture.as_image_copy(), texel, layout, size);
    texture.create_view(&wgpu::TextureViewDescriptor::default())
}

fn make_fixtures(gpu: &Gpu, layouts: &Layouts) -> Result<Fixtures, RenderError> {
    let device = &gpu.device;
    let rows = sort_steps();
    let steps = buffer(device, "particle sort steps", (rows.len().max(1) as u64) * SORT_STEP_STRIDE, BufferUsages::UNIFORM | BufferUsages::COPY_DST)?;
    for (n, row) in rows.iter().enumerate() {
        gpu.queue.write_buffer(&steps, n as u64 * SORT_STEP_STRIDE, bytemuck::bytes_of(row));
    }
    let step_binding = wgpu::BufferBinding { buffer: &steps, offset: 0, size: std::num::NonZeroU64::new(size_of::<GpuSortStep>() as u64) };
    let step_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("particle sort step"),
        layout: &layouts.step,
        entries: &[wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::Buffer(step_binding) }],
    });
    let no_keys = buffer(device, "particle no keys", PAIR_BYTES, BufferUsages::STORAGE)?;
    let white = texel_view(gpu, "particle white flipbook", TextureFormat::Rgba8UnormSrgb, &[255; 4]);
    let no_surface = texel_view(gpu, "particle no surface", TextureFormat::R32Float, &NO_SURFACE_DEPTH.to_le_bytes());
    let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
        label: Some("particle flipbook"),
        mag_filter: wgpu::FilterMode::Linear,
        min_filter: wgpu::FilterMode::Linear,
        mipmap_filter: wgpu::MipmapFilterMode::Linear,
        ..Default::default()
    });
    Ok(Fixtures { step_group, no_keys, white, sampler, no_surface })
}

/// The billboards' pipeline for a scene of `format` (the HDR fragment unless it is the world
/// format) with `depth_reversed`. The fogged entries (RQ4.3, drawn since RQ4.6) take the fog the
/// billboard's centre sits in, as the forward pass fogs an opaque surface; at the default fog
/// density 0 they draw what the plain entries draw.
fn draw_pipeline(device: &Device, module: &ShaderModule, layouts: &[&BindGroupLayout], samples: u32, scene: (TextureFormat, bool)) -> Compiled<RenderPipeline> {
    let (format, depth_reversed) = scene;
    let (vertex, fragment) = if format == WORLD_FORMAT { ("vs_particle_fogged", "fs_particle_fogged") } else { ("vs_particle_hdr", "fs_particle_hdr_fogged") };
    let targets = [Some(wgpu::ColorTargetState { format, blend: Some(BLEND_OVER), write_mask: wgpu::ColorWrites::ALL })];
    crate::compile::render_pipeline(device, &wgpu::RenderPipelineDescriptor {
        label: Some("particles"),
        layout: Some(&pipeline_layout(device, "particles draw", layouts)),
        vertex: wgpu::VertexState { module, entry_point: Some(vertex), compilation_options: Default::default(), buffers: &[] },
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: Some(wgpu::DepthStencilState {
            format: DEPTH_FORMAT,
            depth_write_enabled: Some(false),
            depth_compare: Some(depth_compare(false, depth_reversed)),
            stencil: wgpu::StencilState::default(),
            bias: wgpu::DepthBiasState::default(),
        }),
        multisample: wgpu::MultisampleState { count: samples, ..Default::default() },
        fragment: Some(wgpu::FragmentState { module, entry_point: Some(fragment), compilation_options: Default::default(), targets: &targets }),
        multiview_mask: None,
        cache: None,
    })
}

/// Record the sort of `segments` segments the `group` binds, the longest `count` pairs, on `pass`.
fn encode_sort(pass: &mut wgpu::ComputePass<'_>, kernels: &Kernels, fixtures: &Fixtures, group: &BindGroup, (segments, count): (u32, u32)) {
    let blocks = count.div_ceil(SORT_BLOCK);
    // A global step pairs every slot of the padded power of two: a flip mirrors a slot near the
    // middle of a merge onto one near its end, past the last workgroup a count's blocks reach.
    // One exchange a thread: half the padded count.
    let step_groups = count.next_power_of_two().div_ceil(2 * SORT_STEP_THREADS);
    pass.set_bind_group(0, group, &[]);
    for dispatch in sort_plan(count) {
        let (pipeline, row, groups) = match dispatch {
            SortDispatch::Block => (&kernels.sort_block, 0, blocks),
            SortDispatch::Step(row) => (&kernels.sort_step, row, step_groups),
            SortDispatch::Inner => (&kernels.sort_inner, 0, blocks),
        };
        pass.set_pipeline(pipeline);
        pass.set_bind_group(1, &fixtures.step_group, &[(row as u64 * SORT_STEP_STRIDE) as u32]);
        pass.dispatch_workgroups(groups, segments, 1);
    }
}

impl ParticlePass {
    pub(crate) fn new(gpu: &Gpu, samples: u32) -> Result<ParticlePass, RenderError> {
        let device = &gpu.device;
        let layouts = make_layouts(device);
        let kernels = make_kernels(device, &layouts)?;
        let fixtures = make_fixtures(gpu, &layouts)?;
        let draw_module = shader(device, "particles draw", crate::shaders::PARTICLES_DRAW)?;
        let scene = (WORLD_FORMAT, false);
        let draw = draw_pipeline(device, &draw_module, &[&layouts.frame, &layouts.rows], samples, scene);
        Ok(ParticlePass {
            kernels,
            draw,
            draw_module,
            samples,
            scene,
            layouts,
            fixtures,
            atlases: Vec::new(),
            emitters: Vec::new(),
            sort: None,
            frame: Vec::new(),
            frame_group: None,
            cap: particle_cap(DeviceClass::new(FormFactor::Desktop, PerformanceTier::High)),
            scene_depth: None,
            view_depth: None,
            reactive: None,
        })
    }

    /// The reactive coverage's pipeline over `node`'s jitter group for a scene of `depth_reversed`
    /// (made once per convention, outside any pass).
    pub(crate) fn ensure_reactive(&mut self, device: &Device, node: &crate::post::taa::ReactiveNode, depth_reversed: bool) -> Result<(), RenderError> {
        if self.reactive.as_ref().is_some_and(|(_, reversed)| *reversed == depth_reversed) {
            return Ok(());
        }
        let entry = crate::post::taa::ReactiveEntry::Particles;
        let pipeline = node.pipeline(device, entry, [&self.layouts.frame, &self.layouts.rows], &[], depth_reversed)?;
        self.reactive = Some((pipeline, depth_reversed));
        Ok(())
    }

    /// Draw this frame's billboards as soft coverage into TAA's reactive mask (inside node 15a's
    /// pass, `node`'s jitter group at group 2). False when nothing was drawn.
    pub(crate) fn draw_reactive(&self, pass: &mut wgpu::RenderPass<'_>, node: &crate::post::taa::ReactiveNode) -> bool {
        let (Some(frame_group), Some((pipeline, _))) = (&self.frame_group, &self.reactive) else { return false };
        if self.frame.is_empty() {
            return false;
        }
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, frame_group, &[]);
        pass.set_bind_group(2, node.jitter_group(), &[]);
        for id in &self.frame {
            let emitter = &self.emitters[id.0 as usize];
            pass.set_bind_group(1, &emitter.draw_group, &[]);
            pass.draw_indirect(&emitter.args, 0);
        }
        true
    }

    /// Whether this frame draws billboards (TAA's reactive coverage marks them).
    pub(crate) fn draws(&self) -> bool {
        !self.frame.is_empty()
    }

    /// Draw into a scene of `format` with `depth_reversed` from now on (the legacy world format with
    /// standard Z, or the HDR scene): the draw pipeline is rebuilt when either changes.
    pub(crate) fn set_scene(&mut self, device: &Device, format: TextureFormat, depth_reversed: bool) {
        if self.scene == (format, depth_reversed) {
            return;
        }
        self.scene = (format, depth_reversed);
        self.draw = draw_pipeline(device, &self.draw_module, &[&self.layouts.frame, &self.layouts.rows], self.samples, self.scene);
    }

    /// Draw at most `cap` particles a frame from now on ([`particle_cap`] of the device's class).
    pub(crate) fn set_cap(&mut self, cap: u32) {
        self.cap = cap.max(1);
    }

    /// The prepass depth graph node 9 handed over this frame (the soft fade and the collision read
    /// it); None where the prepass did not run.
    pub(crate) fn set_scene_depth(&mut self, depth: Option<TextureView>) {
        self.scene_depth = depth;
    }

    pub(crate) fn len(&self) -> usize {
        self.emitters.len()
    }

    /// The frame inputs `draws` need produced: the scene depth where one of them is soft or
    /// collides and `prepass_allowed` (the quality lets the prepass run); otherwise nothing, and
    /// those emitters draw hard and collide with nothing.
    pub(crate) fn inputs_of(&self, draws: &[(EmitterId, u64)], prepass_allowed: bool) -> RenderInputs {
        let reads = draws.iter().any(|(id, _)| self.emitters.get(id.0 as usize).is_some_and(|e| e.desc.reads_depth()));
        if reads && prepass_allowed { RenderInputs::DEPTH } else { RenderInputs::NONE }
    }

    /// Add a flipbook atlas: its image with mips down to cells of a few texels.
    pub(crate) fn add_atlas(&mut self, gpu: &Gpu, atlas: &ParticleAtlas) -> Result<ParticleAtlasId, RenderError> {
        check_count("particle atlases", self.atlases.len() + 1, PARTICLE_ATLASES_MAX, RenderCode::TextureTooLarge)?;
        atlas.check()?;
        let mut chain = rect_mip_chain(&atlas.image, TextureKind::Color);
        chain.truncate(atlas.mip_levels() as usize);
        let size = wgpu::Extent3d { width: atlas.image.width(), height: atlas.image.height(), depth_or_array_layers: 1 };
        let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("particle flipbook"),
            size,
            mip_level_count: chain.len() as u32,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: TextureFormat::Rgba8UnormSrgb,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        for (level, mip) in chain.iter().enumerate() {
            let extent = wgpu::Extent3d { width: mip.width(), height: mip.height(), depth_or_array_layers: 1 };
            let layout = wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(4 * mip.width()), rows_per_image: Some(mip.height()) };
            let target = wgpu::TexelCopyTextureInfo { texture: &texture, mip_level: level as u32, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All };
            gpu.queue.write_texture(target, mip.rgba(), layout, extent);
        }
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let bytes = chain.iter().map(|mip| u64::from(mip.width()) * u64::from(mip.height()) * 4).sum();
        self.atlases.push(Atlas { grid: (atlas.columns, atlas.rows), view, bytes });
        Ok(ParticleAtlasId((self.atlases.len() - 1) as u32))
    }

    /// Add an emitter: its uniforms, rows, shapes and indirect arguments (and a sorted one's pairs
    /// and drawn rows). Nothing is read back: none of them is `MAP_READ` or `COPY_SRC`.
    pub(crate) fn add(&mut self, gpu: &Gpu, desc: EmitterDesc) -> Result<EmitterId, RenderError> {
        check_count("particle emitters", self.emitters.len() + 1, PARTICLE_EMITTERS_MAX, RenderCode::BufferTooLarge)?;
        desc.check()?;
        let atlas = match desc.flipbook {
            Some(book) => Some(self.atlases.get(book.atlas.0 as usize).ok_or_else(|| RenderError::refused(RenderCode::TextureInvalid, format!("no particle atlas {}", book.atlas.0)))?),
            None => None,
        };
        let device = &gpu.device;
        let slots = u64::from(desc.slots());
        let uniforms = buffer(device, "emitter", size_of::<GpuEmitter>() as u64, BufferUsages::UNIFORM | BufferUsages::COPY_DST)?;
        let rows = buffer(device, "particles", slots * size_of::<GpuParticle>() as u64, BufferUsages::STORAGE)?;
        let shapes = buffer(device, "particle shapes", slots * size_of::<GpuParticleShape>() as u64, BufferUsages::STORAGE)?;
        let args = buffer(device, "particle args", ARGS_BYTES, BufferUsages::STORAGE | BufferUsages::INDIRECT)?;
        let segment = self.emitters.iter().filter(|e| e.sorted.is_some()).count() as u32;
        if desc.sorted && self.sort.is_none() {
            self.sort = Some(shared_sort(device, &self.layouts, PARTICLE_EMITTERS_MAX as u64, false)?);
        }
        let pairs = self.sort.as_ref().filter(|_| desc.sorted).map(|sort| &sort.pairs);
        let keys = match pairs {
            Some(pairs) => segment_binding(pairs, segment, slots),
            None => self.fixtures.no_keys.as_entire_binding(),
        };
        let compute_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("particles emit"),
            layout: &self.layouts.emit,
            entries: &[entry(0, &uniforms), entry(1, &rows), entry(2, &args), wgpu::BindGroupEntry { binding: 3, resource: keys }, entry(4, &shapes)],
        });
        let sorted = match pairs {
            Some(pairs) => {
                let drawn = buffer(device, "particles drawn", slots * size_of::<GpuParticle>() as u64, BufferUsages::STORAGE)?;
                let drawn_shapes = buffer(device, "particle shapes drawn", slots * size_of::<GpuParticleShape>() as u64, BufferUsages::STORAGE)?;
                let gather_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("particles gather"),
                    layout: &self.layouts.gather,
                    entries: &[
                        entry(0, &uniforms),
                        entry(1, &rows),
                        wgpu::BindGroupEntry { binding: 3, resource: segment_binding(pairs, segment, slots) },
                        entry(4, &shapes),
                        entry(5, &drawn),
                        entry(6, &drawn_shapes),
                    ],
                });
                Some(SortedRows { segment, drawn, drawn_shapes, gather_group })
            }
            None => None,
        };
        let (drawn_rows, drawn_shapes) = sorted.as_ref().map_or((&rows, &shapes), |s| (&s.drawn, &s.drawn_shapes));
        let flipbook = atlas.map_or(&self.fixtures.white, |atlas| &atlas.view);
        let draw_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("particles rows"),
            layout: &self.layouts.rows,
            entries: &[
                entry(0, drawn_rows),
                entry(1, &uniforms),
                entry(2, drawn_shapes),
                view_entry(3, flipbook),
                wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::Sampler(&self.fixtures.sampler) },
            ],
        });
        self.emitters.push(Emitter { desc, uniforms, rows, shapes, args, sorted, compute_group, draw_group });
        Ok(EmitterId((self.emitters.len() - 1) as u32))
    }

    /// The emitter's description (for a rebuild after device loss).
    pub(crate) fn desc(&self, id: EmitterId) -> Option<EmitterDesc> {
        self.emitters.get(id.0 as usize).map(|e| e.desc)
    }

    /// Check and write this frame's emitters at their ticks; one draw per emitter per frame. Past
    /// the cap every emitter draws every n-th slot ([`draw_stride`]).
    pub(crate) fn prepare(&mut self, gpu: &Gpu, draws: &[(EmitterId, u64)]) -> Result<u64, RenderError> {
        self.frame.clear();
        self.scene_depth = None;
        for (i, (id, _)) in draws.iter().enumerate() {
            if self.emitters.get(id.0 as usize).is_none() {
                return Err(RenderError::refused(RenderCode::BufferTooLarge, format!("no particle emitter {}", id.0)));
            }
            if draws[..i].iter().any(|(other, _)| other == id) {
                return Err(RenderError::refused(RenderCode::BufferTooLarge, format!("emitter {} is drawn twice in one frame", id.0)));
            }
        }
        let slots: u64 = draws.iter().map(|(id, _)| u64::from(self.emitters[id.0 as usize].desc.slots())).sum();
        let stride = draw_stride(slots, self.cap);
        let mut segments = Vec::new();
        for (id, tick) in draws {
            let emitter = &self.emitters[id.0 as usize];
            let grid = emitter.desc.flipbook.and_then(|book| self.atlases.get(book.atlas.0 as usize)).map_or((1, 1), |atlas| atlas.grid);
            gpu.queue.write_buffer(&emitter.uniforms, 0, bytemuck::bytes_of(&emitter.desc.to_gpu_with(*tick, stride, grid)));
            if let Some(sorted) = &emitter.sorted {
                let first = sorted.segment * PARTICLES_PER_EMITTER_MAX;
                segments.push(GpuSortSegment { span: [first, emitter.desc.slots(), 0, 0] });
            }
            self.frame.push(*id);
        }
        // The frame's sorted emitters sort together, one segment each (workgroup y).
        if let Some(sort) = &mut self.sort {
            let longest = segments.iter().map(|row| row.span[1]).max().unwrap_or(0);
            sort.frame = (segments.len() as u32, longest);
            if !segments.is_empty() {
                gpu.queue.write_buffer(&sort.segments, 0, bytemuck::cast_slice(&segments));
            }
        }
        Ok(draws.len() as u64 * size_of::<GpuEmitter>() as u64)
    }

    /// Whether a frame emitter reads the scene's depth.
    fn frame_reads_depth(&self) -> bool {
        self.frame.iter().any(|id| self.emitters[id.0 as usize].desc.reads_depth())
    }

    /// The view depth the particles read this frame: the prepass depth turned into view depth
    /// (recorded on `encoder`) where a frame emitter reads it and the prepass ran, else the "no
    /// surface" texel.
    fn encode_view_depth(&mut self, device: &Device, encoder: &mut wgpu::CommandEncoder, world: &WorldPass<'_>) -> TextureView {
        let Some(depth) = self.scene_depth.clone().filter(|_| self.frame_reads_depth()) else { return self.fixtures.no_surface.clone() };
        // Half the render size: each texel the nearest of four (particles_depth.wgsl).
        let extent = depth.texture().size();
        let size = (extent.width.div_ceil(2), extent.height.div_ceil(2));
        if self.view_depth.as_ref().is_none_or(|(_, made)| *made != size) {
            let texture = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("particle view depth"),
                size: wgpu::Extent3d { width: size.0, height: size.1, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: TextureFormat::R32Float,
                usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            });
            self.view_depth = Some((texture.create_view(&wgpu::TextureViewDescriptor::default()), size));
        }
        let Some((view, _)) = &self.view_depth else { return self.fixtures.no_surface.clone() };
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("particles depth"),
            layout: &self.layouts.depth,
            entries: &[entry(0, world.frame_uniforms), view_entry(1, &depth), view_entry(2, view)],
        });
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("particle view depth"), timestamp_writes: None });
        pass.set_pipeline(&self.kernels.depth);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups(size.0.div_ceil(DEPTH_TILE), size.1.div_ceil(DEPTH_TILE), 1);
        view.clone()
    }

    /// Dispatch this frame's emitters (ahead of the world pass): the scene's view depth where one
    /// reads it, each emitter's rows, and a sorted one's sort and gather; then bind the frame.
    /// Only the depth collision reads the view depth in the emit pass. Without a colliding emitter
    /// the emitters are recorded first and the view depth (for the soft fade) after them, so the
    /// emit, sort and gather wait for nothing the prepass makes and run beside it.
    pub(crate) fn encode(&mut self, device: &Device, encoder: &mut wgpu::CommandEncoder, world: &WorldPass<'_>) {
        if self.frame.is_empty() {
            return;
        }
        let collides = self.frame.iter().any(|id| self.emitters[id.0 as usize].desc.collides());
        let made_first = collides.then(|| self.encode_view_depth(device, encoder, world));
        let emit_depth = made_first.clone().unwrap_or_else(|| self.fixtures.no_surface.clone());
        self.encode_emitters(device, encoder, world, &emit_depth);
        let view_depth = made_first.unwrap_or_else(|| self.encode_view_depth(device, encoder, world));
        self.frame_group = Some(device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("particles frame"),
            layout: &self.layouts.frame,
            entries: &[
                entry(0, world.frame_uniforms),
                entry(1, world.fog),
                view_entry(2, &world.env_specular),
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::Sampler(&world.env_sampler) },
                view_entry(4, &world.aerial),
                view_entry(5, &view_depth),
                view_entry(6, world.shadow_map),
                wgpu::BindGroupEntry { binding: 7, resource: wgpu::BindingResource::Sampler(world.shadow_sampler) },
            ],
        }));
    }

    /// Record the frame's emit pass against `emit_depth` (the view depth or the "no surface"
    /// texel), then one sort for every sorted emitter and each one's gather.
    fn encode_emitters(&self, device: &Device, encoder: &mut wgpu::CommandEncoder, world: &WorldPass<'_>, emit_depth: &TextureView) {
        let inputs = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("particles inputs"),
            layout: &self.layouts.inputs,
            entries: &[entry(0, world.frame_uniforms), view_entry(1, emit_depth)],
        });
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("particles"), timestamp_writes: None });
        pass.set_pipeline(&self.kernels.emit);
        pass.set_bind_group(1, &inputs, &[]);
        for id in &self.frame {
            let emitter = &self.emitters[id.0 as usize];
            pass.set_bind_group(0, &emitter.compute_group, &[]);
            pass.dispatch_workgroups(emitter.desc.slots().div_ceil(WORKGROUP), 1, 1);
        }
        let Some(sort) = self.sort.as_ref().filter(|sort| sort.frame.0 > 0) else { return };
        encode_sort(&mut pass, &self.kernels, &self.fixtures, &sort.group, sort.frame);
        pass.set_pipeline(&self.kernels.gather);
        for id in &self.frame {
            let emitter = &self.emitters[id.0 as usize];
            if let Some(sorted) = &emitter.sorted {
                pass.set_bind_group(0, &sorted.gather_group, &[]);
                pass.dispatch_workgroups(emitter.desc.slots().div_ceil(WORKGROUP), 1, 1);
            }
        }
    }

    /// Draw this frame's emitters from their indirect arguments (inside the world pass).
    pub(crate) fn draw(&self, pass: &mut wgpu::RenderPass<'_>) {
        let Some(frame_group) = &self.frame_group else { return };
        if self.frame.is_empty() {
            return;
        }
        pass.set_pipeline(&self.draw);
        pass.set_bind_group(0, frame_group, &[]);
        for id in &self.frame {
            let emitter = &self.emitters[id.0 as usize];
            pass.set_bind_group(1, &emitter.draw_group, &[]);
            pass.draw_indirect(&emitter.args, 0);
        }
    }

    /// Emitters this frame draws.
    pub(crate) fn frame_draws(&self) -> u32 {
        self.frame.len() as u32
    }

    /// The particles' total bytes on the GPU (rows, shapes, a sorted emitter's pairs and drawn
    /// rows, the flipbook atlases and the view depth), for the receipt of what the GPU holds.
    pub(crate) fn bytes(&self) -> u64 {
        let shared = self.sort.as_ref().map_or(0, |sort| sort.pairs.size() + sort.segments.size());
        let atlases: u64 = self.atlases.iter().map(|atlas| atlas.bytes).sum();
        let depth = self.view_depth.as_ref().map_or(0, |(_, (w, h))| u64::from(*w) * u64::from(*h) * 4);
        self.emitters.iter().map(Emitter::bytes).sum::<u64>() + shared + atlases + depth
    }
}

/// Sort `pairs` of (key, slot) on the GPU with the emitters' bitonic sort, ascending by key then
/// slot (a diagnostic: the sort's own rows read it back; natively only).
pub fn sort_pairs_on_gpu(gpu: &Gpu, pairs: &[[u32; 2]]) -> Result<Vec<[u32; 2]>, RenderError> {
    let count = u32::try_from(pairs.len()).unwrap_or(u32::MAX);
    if count == 0 || count > PARTICLES_PER_EMITTER_MAX {
        return Err(RenderError::refused(RenderCode::BufferTooLarge, format!("{count} pairs: between 1 and {PARTICLES_PER_EMITTER_MAX}")));
    }
    let device = &gpu.device;
    let layouts = make_layouts(device);
    let kernels = make_kernels(device, &layouts)?;
    let fixtures = make_fixtures(gpu, &layouts)?;
    let sort = shared_sort(device, &layouts, 1, true)?;
    let bytes = u64::from(count) * PAIR_BYTES;
    gpu.queue.write_buffer(&sort.pairs, 0, bytemuck::cast_slice(pairs));
    gpu.queue.write_buffer(&sort.segments, 0, bytemuck::bytes_of(&GpuSortSegment { span: [0, count, 0, 0] }));
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("particle sort") });
    {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("particle sort"), timestamp_writes: None });
        encode_sort(&mut pass, &kernels, &fixtures, &sort.group, (1, count));
    }
    gpu.queue.submit([encoder.finish()]);
    let staging = crate::readback::stage_buffer(gpu, &sort.pairs, 0, bytes)?;
    let data = crate::readback::map_read_blocking(gpu, &staging, bytes)?;
    Ok(bytemuck::cast_slice::<u8, [u32; 2]>(&data).to_vec())
}
