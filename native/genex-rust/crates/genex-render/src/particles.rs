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

use crate::compile::Compiled;
use wgpu::{BindGroup, BindGroupLayout, Buffer, BufferUsages, ComputePipeline, Device, RenderPipeline, ShaderModule, ShaderStages, TextureFormat};

use crate::error::{RenderCode, RenderError};
use crate::gpu::Gpu;
use crate::limits::{PARTICLE_EMITTERS_MAX, PARTICLES_PER_EMITTER_MAX, check_count};
use crate::renderer::{DEPTH_FORMAT, WORLD_FORMAT, WorldPass, depth_compare, shader};
use crate::tables::{buffer, entry, pipeline_layout, storage, uniform};

/// Threads per workgroup of the emitter's compute pass (`@workgroup_size` in particles_compute.wgsl).
const WORKGROUP: u32 = 64;
/// Bytes of the indirect draw arguments (`draw_indirect`: vertices, instances, first vertex, first instance).
const ARGS_BYTES: u64 = 16;

/// What an emitter spawns. Velocities are in world units per tick, gravity per tick².
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EmitterDesc {
    /// Where particles spawn.
    pub origin: [f32; 3],
    /// Their initial velocity.
    pub velocity: [f32; 3],
    /// Each particle's speed varies by up to this fraction.
    pub speed_jitter: f32,
    /// Each particle's velocity varies by up to this much per axis.
    pub spread: f32,
    /// Acceleration.
    pub gravity: [f32; 3],
    /// A newborn particle's size in world units (it halves over its life).
    pub size: f32,
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
}

impl EmitterDesc {
    /// A warm fountain at `origin`: four particles a tick, a second's life.
    pub fn fountain(origin: [f32; 3], seed: u32) -> EmitterDesc {
        EmitterDesc {
            origin,
            velocity: [0.0, 0.06, 0.0],
            speed_jitter: 0.25,
            spread: 0.02,
            gravity: [0.0, -0.0015, 0.0],
            size: 0.14,
            color_start: [255, 210, 90, 255],
            color_end: [255, 60, 20, 0],
            rate_per_tick: 4,
            lifetime_ticks: 60,
            seed,
        }
    }

    /// Rows the emitter holds: every particle alive at once.
    pub fn slots(&self) -> u32 {
        self.rate_per_tick.saturating_mul(self.lifetime_ticks)
    }

    /// Refuse `buffer-too-large` for an empty emitter or one above [`PARTICLES_PER_EMITTER_MAX`].
    pub fn check(&self) -> Result<(), RenderError> {
        let slots = self.rate_per_tick.checked_mul(self.lifetime_ticks);
        match slots {
            Some(n) if n > 0 && n <= PARTICLES_PER_EMITTER_MAX => Ok(()),
            _ => Err(RenderError::refused(
                RenderCode::BufferTooLarge,
                format!(
                    "{} a tick living {} ticks: between 1 and {PARTICLES_PER_EMITTER_MAX} particles",
                    self.rate_per_tick, self.lifetime_ticks
                ),
            )),
        }
    }

    /// The emitter's uniforms for `tick` (`Emitter`).
    pub fn to_gpu(&self, tick: u64) -> GpuEmitter {
        let slots = u64::from(self.slots().max(1));
        // Particles spawned through `tick` (tick 0 spawns the first `rate`).
        let spawned = tick.saturating_add(1).saturating_mul(u64::from(self.rate_per_tick)).max(1);
        let newest = spawned - 1;
        let color = |c: [u8; 4]| c.map(|v| f32::from(v) / 255.0);
        let [vx, vy, vz] = self.velocity;
        let [gx, gy, gz] = self.gravity;
        GpuEmitter {
            origin: [self.origin[0], self.origin[1], self.origin[2], self.size],
            velocity: [vx, vy, vz, self.speed_jitter],
            gravity: [gx, gy, gz, self.spread],
            color_start: color(self.color_start),
            color_end: color(self.color_end),
            params: [self.rate_per_tick, self.lifetime_ticks, self.seed, self.slots()],
            spawn: [(newest % slots) as u32, newest as u32, (newest >> 32) as u32, spawned.min(slots) as u32],
        }
    }
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

/// An emitter a renderer holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct EmitterId(u32);

impl EmitterId {
    /// The raw index.
    pub const fn raw(self) -> u32 {
        self.0
    }
}

struct Emitter {
    desc: EmitterDesc,
    uniforms: Buffer,
    rows: Buffer,
    args: Buffer,
    compute_group: BindGroup,
    draw_group: BindGroup,
}

/// The emitters a renderer holds and the ones this frame draws.
pub(crate) struct ParticlePass {
    compute: Compiled<ComputePipeline>,
    draw: Compiled<RenderPipeline>,
    draw_module: ShaderModule,
    samples: u32,
    /// The scene the draw pipeline targets: its colour format and whether depth is reversed.
    scene: (TextureFormat, bool),
    compute_layout: BindGroupLayout,
    frame_layout: BindGroupLayout,
    rows_layout: BindGroupLayout,
    emitters: Vec<Emitter>,
    frame: Vec<EmitterId>,
    frame_group: Option<BindGroup>,
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

/// The billboards' pipeline for a scene of `format` (the HDR fragment unless it is the world
/// format) with `depth_reversed`. The fogged entries (RQ4.3, drawn since RQ4.6) take the fog the
/// billboard's centre sits in, as the forward pass fogs an opaque surface; at the default fog
/// density 0 they draw what the plain entries draw.
fn draw_pipeline(device: &Device, module: &ShaderModule, layouts: &[&BindGroupLayout], samples: u32, scene: (TextureFormat, bool)) -> Compiled<RenderPipeline> {
    let (format, depth_reversed) = scene;
    let fragment = if format == WORLD_FORMAT { "fs_particle_fogged" } else { "fs_particle_hdr_fogged" };
    let targets = [Some(wgpu::ColorTargetState { format, blend: Some(BLEND_OVER), write_mask: wgpu::ColorWrites::ALL })];
    crate::compile::render_pipeline(device, &wgpu::RenderPipelineDescriptor {
        label: Some("particles"),
        layout: Some(&pipeline_layout(device, "particles draw", layouts)),
        vertex: wgpu::VertexState { module, entry_point: Some("vs_particle_fogged"), compilation_options: Default::default(), buffers: &[] },
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

impl ParticlePass {
    pub(crate) fn new(device: &Device, samples: u32) -> Result<ParticlePass, RenderError> {
        let compute_stage = ShaderStages::COMPUTE;
        let compute_layout = layout(device, "particles compute", &[uniform(0, false, compute_stage), storage(1, false, compute_stage), storage(2, false, compute_stage)]);
        // The HDR fragment reads the frame's pre-exposure too; the fogged fragments the fog row and
        // the environment's prefiltered cube (the fog's in-scatter under a sky or a map).
        let fragment = ShaderStages::FRAGMENT;
        let cube = wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Float { filterable: true },
            view_dimension: wgpu::TextureViewDimension::Cube,
            multisampled: false,
        };
        // The aerial-perspective volume (the HDR fogged fragment hazes with it).
        let volume = wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Float { filterable: true },
            view_dimension: wgpu::TextureViewDimension::D3,
            multisampled: false,
        };
        let frame_layout = layout(
            device,
            "particles frame",
            &[
                uniform(0, false, ShaderStages::VERTEX_FRAGMENT),
                uniform(1, false, fragment),
                wgpu::BindGroupLayoutEntry { binding: 2, visibility: fragment, ty: cube, count: None },
                wgpu::BindGroupLayoutEntry { binding: 3, visibility: fragment, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
                wgpu::BindGroupLayoutEntry { binding: 4, visibility: fragment, ty: volume, count: None },
            ],
        );
        let rows_layout = layout(device, "particles rows", &[storage(0, true, ShaderStages::VERTEX)]);
        let compute_module = shader(device, "particles compute", crate::shaders::PARTICLES_COMPUTE)?;
        let compute = crate::compile::compute_pipeline(device, &wgpu::ComputePipelineDescriptor {
            label: Some("particles"),
            layout: Some(&pipeline_layout(device, "particles compute", &[&compute_layout])),
            module: &compute_module,
            entry_point: Some("cs_particles"),
            compilation_options: Default::default(),
            cache: None,
        });
        let draw_module = shader(device, "particles draw", crate::shaders::PARTICLES_DRAW)?;
        let scene = (WORLD_FORMAT, false);
        let draw = draw_pipeline(device, &draw_module, &[&frame_layout, &rows_layout], samples, scene);
        Ok(ParticlePass {
            compute,
            draw,
            draw_module,
            samples,
            scene,
            compute_layout,
            frame_layout,
            rows_layout,
            emitters: Vec::new(),
            frame: Vec::new(),
            frame_group: None,
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
        let pipeline = node.pipeline(device, entry, [&self.frame_layout, &self.rows_layout], &[], depth_reversed)?;
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
        self.draw = draw_pipeline(device, &self.draw_module, &[&self.frame_layout, &self.rows_layout], self.samples, self.scene);
    }

    pub(crate) fn len(&self) -> usize {
        self.emitters.len()
    }

    /// Add an emitter: its uniforms, rows and indirect arguments. Nothing is read back: none of
    /// them is `MAP_READ` or `COPY_SRC`.
    pub(crate) fn add(&mut self, gpu: &Gpu, desc: EmitterDesc) -> Result<EmitterId, RenderError> {
        check_count("particle emitters", self.emitters.len() + 1, PARTICLE_EMITTERS_MAX, RenderCode::BufferTooLarge)?;
        desc.check()?;
        let device = &gpu.device;
        let uniforms = buffer(device, "emitter", size_of::<GpuEmitter>() as u64, BufferUsages::UNIFORM | BufferUsages::COPY_DST)?;
        let rows = buffer(device, "particles", u64::from(desc.slots()) * size_of::<GpuParticle>() as u64, BufferUsages::STORAGE)?;
        let args = buffer(device, "particle args", ARGS_BYTES, BufferUsages::STORAGE | BufferUsages::INDIRECT)?;
        let compute_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("particles compute"),
            layout: &self.compute_layout,
            entries: &[entry(0, &uniforms), entry(1, &rows), entry(2, &args)],
        });
        let draw_group = device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("particles rows"), layout: &self.rows_layout, entries: &[entry(0, &rows)] });
        self.emitters.push(Emitter { desc, uniforms, rows, args, compute_group, draw_group });
        Ok(EmitterId((self.emitters.len() - 1) as u32))
    }

    /// The emitter's description (for a rebuild after device loss).
    pub(crate) fn desc(&self, id: EmitterId) -> Option<EmitterDesc> {
        self.emitters.get(id.0 as usize).map(|e| e.desc)
    }

    /// Check and write this frame's emitters at their ticks; one draw per emitter per frame.
    pub(crate) fn prepare(&mut self, gpu: &Gpu, draws: &[(EmitterId, u64)]) -> Result<u64, RenderError> {
        self.frame.clear();
        for (i, (id, _)) in draws.iter().enumerate() {
            if self.emitters.get(id.0 as usize).is_none() {
                return Err(RenderError::refused(RenderCode::BufferTooLarge, format!("no particle emitter {}", id.0)));
            }
            if draws[..i].iter().any(|(other, _)| other == id) {
                return Err(RenderError::refused(RenderCode::BufferTooLarge, format!("emitter {} is drawn twice in one frame", id.0)));
            }
        }
        for (id, tick) in draws {
            let emitter = &self.emitters[id.0 as usize];
            gpu.queue.write_buffer(&emitter.uniforms, 0, bytemuck::bytes_of(&emitter.desc.to_gpu(*tick)));
            self.frame.push(*id);
        }
        Ok(draws.len() as u64 * size_of::<GpuEmitter>() as u64)
    }

    /// Dispatch this frame's emitters (ahead of the world pass) and bind the frame uniforms.
    pub(crate) fn encode(&mut self, device: &Device, encoder: &mut wgpu::CommandEncoder, world: &WorldPass<'_>) {
        if self.frame.is_empty() {
            return;
        }
        self.frame_group = Some(device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("particles frame"),
            layout: &self.frame_layout,
            entries: &[
                entry(0, world.frame_uniforms),
                entry(1, world.fog),
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&world.env_specular) },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::Sampler(&world.env_sampler) },
                wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::TextureView(&world.aerial) },
            ],
        }));
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("particles"), timestamp_writes: None });
        pass.set_pipeline(&self.compute);
        for id in &self.frame {
            let emitter = &self.emitters[id.0 as usize];
            pass.set_bind_group(0, &emitter.compute_group, &[]);
            pass.dispatch_workgroups(emitter.desc.slots().div_ceil(WORKGROUP), 1, 1);
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

    /// Particle rows' total bytes, for the receipt of what the GPU holds.
    pub(crate) fn bytes(&self) -> u64 {
        self.emitters.iter().map(|e| e.rows.size()).sum()
    }
}
