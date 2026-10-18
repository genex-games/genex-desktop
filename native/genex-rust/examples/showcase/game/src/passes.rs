//! The lakeside's custom GPU passes (extension ladder level 3, custom-pass API v2): only what no
//! built-in draws. The clouds (where the renderer's panorama does not draw) after the opaque
//! models; the lake (where the renderer draws no water: `draw.rs` declares `frame.water`) and the
//! light sprites (the fireflies' halos, pollen, glints, smoke and the lights' pools on the grass)
//! after the transparent ones. Everything else is the renderer's own: the sky
//! (`frame.environment`, see `draw.rs`), the meadow (the terrain's grassy layers grow it, renderer
//! pass 2 A.8, `world::terrain`), the lanterns and windows (real lights and emissive materials,
//! `draw.rs`), and the look's height fog, bloom and tonemap (`showcase.rs`). The look's fog is
//! applied as each built-in surface is shaded and does not reach geometry a pass draws, so the lake
//! applies the same fog from the v2 tables'
//! fog row themselves (`common.wgsl`'s `look_fog`). Each pass reads the simulation (its tick)
//! read-only and builds every resource through `PassSetup`. At API v2 every pass draws in the scene
//! format: linear, pre-exposed radiance on the HDR scene, which the look's tonemapper maps to the
//! display (`common.wgsl`'s `scene_rgb`), and sRGB-encoded colour on the legacy LDR scene; no pass
//! keeps the frame off the HDR scene.

use genex::gpu::{self, GpuError, GpuPass, GpuPassCtx, PassSetup, PassStage};
use genex::math::{self, Vec3, vec3};
use genex::prelude::*;

use crate::draw::{duck, firefly};
use crate::layout::{CABIN, CABIN_FLOOR, CABIN_YAW, LAKE_CENTER, LAKE_RADII, height, layout};
use crate::world::{TICKS_PER_SECOND, World};

const COMMON_WGSL: &str = include_str!("../shaders/common.wgsl");
const WATER_WGSL: &str = include_str!("../shaders/water.wgsl");
const SPRITES_WGSL: &str = include_str!("../shaders/sprites.wgsl");
const CLOUDS_WGSL: &str = include_str!("../shaders/clouds.wgsl");

/// The custom-pass API every lakeside pass is written against (the v2 tables, the scene format).
const PASS_API: u32 = 2;
/// Bytes per sprite in the sprites' instance buffer.
const SPRITE_BYTES: u64 = 64;
/// How strong a firefly's halo is at the peak of its blink.
const FIREFLY_HALO: f32 = 0.35;
/// The most sprites a frame draws.
const MAX_SPRITES: usize = 1024;
/// The lake's grid: cells across and along, and bed samples per side.
const WATER_CELLS: [u32; 2] = [160, 120];
const BED_SAMPLES: [u32; 2] = [161, 121];
/// How far past the lake's radii the water grid reaches (the shoreline wobbles outwards).
const WATER_MARGIN: f32 = 1.35;
/// Chimney smoke puffs alive at once, and the seconds each lives.
const SMOKE_PUFFS: u32 = 18;
const SMOKE_LIFE: f32 = 9.0;
/// Wood smoke's single-scattering albedo: its fine particles scatter far more than they absorb, a
/// little more in the blue. The sprite shader lights it by the sky and by the sun through its
/// forward phase (`smoke_light`); at 0.5 lit by the sky alone it drew as a dark grey column against
/// the dusk sky (look fix lane SKY).
const SMOKE_ALBEDO: [f32; 3] = [0.82, 0.83, 0.86];
/// A young puff's opacity at its centre (it thins as it ages and spreads): a stove's thin smoke.
const SMOKE_STRENGTH: f32 = 0.35;

/// Register every pass, in drawing order within each stage.
pub fn wire(game: &mut Game<World>) {
    game.gpu_pass("clouds", PassStage::AfterOpaque, Clouds::default());
    game.gpu_pass("lake", PassStage::AfterTransparent, Lake::default());
    game.gpu_pass("lights", PassStage::AfterTransparent, Sprites::default());
}

/// Bytes of f32s, little-endian (what the GPU reads).
fn floats(values: &[f32]) -> Vec<u8> {
    values.iter().flat_map(|v| v.to_le_bytes()).collect()
}

/// The pass's WGSL after the shared helpers.
fn shader(setup: &mut PassSetup<'_>, label: &str, source: &str) -> Result<gpu::ShaderModule, GpuError> {
    setup.create_shader(label, &format!("{COMMON_WGSL}\n{source}"))
}

fn uniform_entry(binding: u32) -> gpu::BindGroupLayoutEntry {
    gpu::BindGroupLayoutEntry {
        binding,
        visibility: gpu::ShaderStages::VERTEX_FRAGMENT,
        ty: gpu::BindingType::Buffer { ty: gpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
        count: None,
    }
}

fn uniform_buffer(setup: &mut PassSetup<'_>, label: &str, size: u64) -> Result<gpu::Buffer, GpuError> {
    setup.create_buffer(&gpu::BufferDescriptor {
        label: Some(label),
        size,
        usage: gpu::BufferUsages::UNIFORM | gpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    })
}

/// A uniform buffer of `size` bytes as group 1 (`entries` adds more bindings after it).
fn params_group(
    setup: &mut PassSetup<'_>,
    label: &str,
    size: u64,
    extra: &[(gpu::BindGroupLayoutEntry, &gpu::Buffer)],
) -> Result<(gpu::Buffer, gpu::BindGroupLayout, gpu::BindGroup), GpuError> {
    let buffer = uniform_buffer(setup, label, size)?;
    let mut layout_entries = vec![uniform_entry(0)];
    layout_entries.extend(extra.iter().map(|(entry, _)| *entry));
    let layout = setup.create_bind_group_layout(&gpu::BindGroupLayoutDescriptor { label: Some(label), entries: &layout_entries });
    let mut entries = vec![gpu::BindGroupEntry { binding: 0, resource: buffer.as_entire_binding() }];
    entries.extend(extra.iter().map(|(entry, buffer)| gpu::BindGroupEntry { binding: entry.binding, resource: buffer.as_entire_binding() }));
    let group = setup.create_bind_group(&gpu::BindGroupDescriptor { label: Some(label), layout: &layout, entries: &entries });
    Ok((buffer, layout, group))
}

/// An in-world pipeline: the tables at group 0 and `group` at 1, the world's depth and samples.
struct WorldPipeline<'a> {
    label: &'a str,
    module: &'a gpu::ShaderModule,
    vertex: &'a str,
    fragment: &'a str,
    buffers: &'a [Option<gpu::VertexBufferLayout<'a>>],
    topology: gpu::PrimitiveTopology,
    blend: Option<gpu::BlendState>,
    depth_write: bool,
}

fn world_pipeline(setup: &mut PassSetup<'_>, group: Option<&gpu::BindGroupLayout>, desc: &WorldPipeline<'_>) -> gpu::RenderPipeline {
    let tables = setup.tables_layout();
    let groups = [Some(tables), group];
    let count = if group.is_some() { 2 } else { 1 };
    let layout =
        setup.create_pipeline_layout(&gpu::PipelineLayoutDescriptor { label: Some(desc.label), bind_group_layouts: &groups[..count], immediate_size: 0 });
    let targets = [Some(gpu::ColorTargetState { format: setup.world_format(), blend: desc.blend, write_mask: gpu::ColorWrites::ALL })];
    setup.create_render_pipeline(&gpu::RenderPipelineDescriptor {
        label: Some(desc.label),
        layout: Some(&layout),
        vertex: gpu::VertexState { module: desc.module, entry_point: Some(desc.vertex), compilation_options: Default::default(), buffers: desc.buffers },
        primitive: gpu::PrimitiveState { topology: desc.topology, cull_mode: None, ..Default::default() },
        depth_stencil: Some(setup.world_depth(desc.depth_write)),
        multisample: setup.world_multisample(),
        fragment: Some(gpu::FragmentState {
            module: desc.module,
            entry_point: Some(desc.fragment),
            compilation_options: Default::default(),
            targets: &targets,
        }),
        multiview_mask: None,
        cache: None,
    })
}

/// A pipeline drawing into TAA's motion target or reactive mask (graph node 15a, renderer pass 2
/// B.7): the tables at group 0 and `group` at 1, one sample, against the prepass depth.
struct TemporalPipeline<'a> {
    label: &'a str,
    module: &'a gpu::ShaderModule,
    vertex: &'a str,
    fragment: &'a str,
    buffers: &'a [Option<gpu::VertexBufferLayout<'a>>],
    topology: gpu::PrimitiveTopology,
    target: gpu::ColorTargetState,
    depth: gpu::DepthStencilState,
}

fn temporal_pipeline(setup: &mut PassSetup<'_>, group: Option<&gpu::BindGroupLayout>, desc: &TemporalPipeline<'_>) -> gpu::RenderPipeline {
    let tables = setup.tables_layout();
    let groups = [Some(tables), group];
    let count = if group.is_some() { 2 } else { 1 };
    let layout =
        setup.create_pipeline_layout(&gpu::PipelineLayoutDescriptor { label: Some(desc.label), bind_group_layouts: &groups[..count], immediate_size: 0 });
    let targets = [Some(desc.target.clone())];
    setup.create_render_pipeline(&gpu::RenderPipelineDescriptor {
        label: Some(desc.label),
        layout: Some(&layout),
        vertex: gpu::VertexState { module: desc.module, entry_point: Some(desc.vertex), compilation_options: Default::default(), buffers: desc.buffers },
        primitive: gpu::PrimitiveState { topology: desc.topology, cull_mode: None, ..Default::default() },
        depth_stencil: Some(desc.depth.clone()),
        multisample: setup.temporal_multisample(),
        fragment: Some(gpu::FragmentState {
            module: desc.module,
            entry_point: Some(desc.fragment),
            compilation_options: Default::default(),
            targets: &targets,
        }),
        multiview_mask: None,
        cache: None,
    })
}

/// Premultiplied alpha: a glow adds (alpha 0), a solid covers.
const PREMULTIPLIED: gpu::BlendState = gpu::BlendState {
    color: gpu::BlendComponent { src_factor: gpu::BlendFactor::One, dst_factor: gpu::BlendFactor::OneMinusSrcAlpha, operation: gpu::BlendOperation::Add },
    alpha: gpu::BlendComponent { src_factor: gpu::BlendFactor::One, dst_factor: gpu::BlendFactor::OneMinusSrcAlpha, operation: gpu::BlendOperation::Add },
};

/// Straight alpha over what is there.
const ALPHA: gpu::BlendState = gpu::BlendState {
    color: gpu::BlendComponent { src_factor: gpu::BlendFactor::SrcAlpha, dst_factor: gpu::BlendFactor::OneMinusSrcAlpha, operation: gpu::BlendOperation::Add },
    alpha: gpu::BlendComponent { src_factor: gpu::BlendFactor::Zero, dst_factor: gpu::BlendFactor::One, operation: gpu::BlendOperation::Add },
};

fn seconds(tick: u64) -> f32 {
    tick as f32 / TICKS_PER_SECOND
}

/// Whether the renderer's own cloud panorama (renderer pass 2 B.5, `world::sky_clouds`) draws
/// behind the scene: the physical sky at a quality that marches it (desktop medium and up). There
/// the lakeside's flat layer stands aside; on phones and low it still draws.
pub fn renderer_draws_clouds(backdrop: crate::world::Backdrop, environment: &genex::render::EnvironmentQuality) -> bool {
    backdrop == crate::world::Backdrop::Sky && environment.sky && environment.clouds.is_some()
}

/// The clouds over the physical sky (`clouds.wgsl`): one full-screen triangle behind the scene
/// where the renderer's panorama does not draw ([`renderer_draws_clouds`]).
#[derive(Default)]
pub struct Clouds {
    resources: Option<(gpu::Buffer, gpu::BindGroup, gpu::RenderPipeline)>,
}

impl GpuPass<World> for Clouds {
    fn rebuild(&mut self, setup: &mut PassSetup<'_>) -> Result<(), GpuError> {
        let module = shader(setup, "clouds", CLOUDS_WGSL)?;
        let (buffer, layout, group) = params_group(setup, "clouds", 16, &[])?;
        let desc = WorldPipeline {
            label: "clouds",
            module: &module,
            vertex: "vs_clouds",
            fragment: "fs_clouds",
            buffers: &[],
            topology: gpu::PrimitiveTopology::TriangleList,
            blend: Some(PREMULTIPLIED),
            depth_write: false,
        };
        let pipeline = world_pipeline(setup, Some(&layout), &desc);
        self.resources = Some((buffer, group, pipeline));
        Ok(())
    }

    fn run(&mut self, ctx: &mut GpuPassCtx<'_, '_, World>) {
        if renderer_draws_clouds(ctx.sim().world.backdrop, &ctx.quality().environment) {
            return;
        }
        let Some((buffer, group, pipeline)) = &self.resources else { return };
        let time = seconds(ctx.sim().world.tick);
        let _ = ctx.write_buffer(buffer, 0, &floats(&[time, 0.0, 0.0, 0.0]));
        let Some(draws) = ctx.draws() else { return };
        draws.set_pipeline(pipeline).bind_tables(0).set_bind_group(1, group, &[]).draw(0..3, 0..1);
    }

    fn api(&self) -> u32 {
        PASS_API
    }

    // The sky's light lights the clouds from above.
    fn inputs(&self) -> gpu::RenderInputs {
        gpu::RenderInputs::ENVIRONMENT
    }
}

/// The lake's bounds: min x, min z, size x, size z.
fn lake_bounds() -> [f32; 4] {
    let half = LAKE_RADII * WATER_MARGIN;
    let min = LAKE_CENTER - half;
    [min.x, min.y, half.x * 2.0, half.y * 2.0]
}

/// The lake where the renderer draws no water (an MSAA preset: `low`, `medium`, the phones'
/// defaults); elsewhere `draw.rs`'s `frame.water` is the lake ([`genex::render::Water::drawn_at`]).
#[derive(Default)]
pub struct Lake {
    resources: Option<(gpu::Buffer, gpu::BindGroup, gpu::RenderPipeline)>,
}

impl GpuPass<World> for Lake {
    fn rebuild(&mut self, setup: &mut PassSetup<'_>) -> Result<(), GpuError> {
        let [min_x, min_z, size_x, size_z] = lake_bounds();
        let [columns, rows] = BED_SAMPLES;
        let bed: Vec<f32> = (0..rows)
            .flat_map(|row| {
                (0..columns).map(move |column| {
                    let x = min_x + size_x * column as f32 / (columns - 1) as f32;
                    let z = min_z + size_z * row as f32 / (rows - 1) as f32;
                    height(x, z)
                })
            })
            .collect();
        let bed = setup.create_buffer_init("lake bed", &floats(&bed), gpu::BufferUsages::STORAGE)?;
        let storage = gpu::BindGroupLayoutEntry {
            binding: 1,
            visibility: gpu::ShaderStages::FRAGMENT,
            ty: gpu::BindingType::Buffer { ty: gpu::BufferBindingType::Storage { read_only: true }, has_dynamic_offset: false, min_binding_size: None },
            count: None,
        };
        let module = shader(setup, "lake", WATER_WGSL)?;
        let (buffer, layout, group) = params_group(setup, "lake", 48, &[(storage, &bed)])?;
        let mut header = floats(&[0.0, 0.0, 0.0, 0.0, min_x, min_z, size_x, size_z]);
        for value in [columns, rows, WATER_CELLS[0], WATER_CELLS[1]] {
            header.extend(value.to_le_bytes());
        }
        setup.write_buffer(&buffer, 0, &header);
        let desc = WorldPipeline {
            label: "lake",
            module: &module,
            vertex: "vs_water",
            fragment: "fs_water",
            buffers: &[],
            topology: gpu::PrimitiveTopology::TriangleList,
            blend: Some(ALPHA),
            depth_write: true,
        };
        let pipeline = world_pipeline(setup, Some(&layout), &desc);
        self.resources = Some((buffer, group, pipeline));
        Ok(())
    }

    fn run(&mut self, ctx: &mut GpuPassCtx<'_, '_, World>) {
        if genex::render::Water::drawn_at(ctx.quality()) {
            return;
        }
        let Some((buffer, group, pipeline)) = &self.resources else { return };
        let time = seconds(ctx.sim().world.tick);
        let _ = ctx.write_buffer(buffer, 0, &floats(&[time, 0.0, 0.0, 0.0]));
        let Some(draws) = ctx.draws() else { return };
        let vertices = WATER_CELLS[0] * WATER_CELLS[1] * 6;
        draws.set_pipeline(pipeline).bind_tables(0).set_bind_group(1, group, &[]).draw(0..vertices, 0..1);
    }

    fn api(&self) -> u32 {
        PASS_API
    }

    // The environment's light is the sky the lake mirrors (`water.wgsl`) and the fog scatters.
    fn inputs(&self) -> gpu::RenderInputs {
        gpu::RenderInputs::ENVIRONMENT
    }
}

/// One light sprite (see `sprites.wgsl`).
#[derive(Clone, Copy)]
struct Sprite {
    center: Vec3,
    half_width: f32,
    color: [f32; 4],
    axis: Vec3,
    kind: f32,
    half_height: f32,
}

const GLOW: f32 = 0.0;
const SMOKE: f32 = 2.0;
const POOL: f32 = 3.0;

/// A lantern's light pool on the grass and path (its flame's colour; alpha its strength).
const LANTERN_POOL: [f32; 4] = [1.0, 0.55, 0.22, 0.2];
/// A lit window's pool where its spot meets the yard.
const WINDOW_POOL: [f32; 4] = [1.0, 0.62, 0.3, 0.12];
/// How far the window spots dip towards the ground per unit outwards (`draw.rs`'s
/// `WINDOW_LIGHT_DIP`).
const WINDOW_DIP: f32 = 0.45;
/// The cabin's lit windows in its frame: (x, height above the floor, z of the pane, facing).
const WINDOWS: [(f32, f32, f32, f32); 3] = [(-2.0, 1.45, 2.8, 1.0), (2.0, 1.45, 2.8, 1.0), (-1.6, 0.86, -2.8, -1.0)];

impl Sprite {
    fn glow(center: Vec3, half_width: f32, color: [f32; 4]) -> Sprite {
        Sprite { center, half_width, color, axis: Vec3::ZERO, kind: GLOW, half_height: 0.0 }
    }

    /// Its instance row, with `before` (its centre last frame) for TAA's reactive coverage.
    fn push(&self, before: Vec3, out: &mut Vec<f32>) {
        let c = self.center;
        let a = self.axis;
        out.extend([c.x, c.y, c.z, self.half_width]);
        out.extend(self.color);
        out.extend([a.x, a.y, a.z, self.kind, self.half_height, before.x, before.y, before.z]);
    }
}

/// Every sprite of the frame at `t` seconds.
fn sprites(t: f32) -> Vec<Sprite> {
    let layout = layout();
    let mut sprites = Vec::new();
    // The fireflies' halo around their emissive bodies (`draw.rs`): a faint glow that keeps a far
    // firefly, smaller than a pixel, visible.
    for (i, home) in layout.fireflies.iter().enumerate() {
        let (at, lit) = firefly(i, *home, t);
        sprites.push(Sprite::glow(at, 0.12, [0.75, 1.0, 0.3, FIREFLY_HALO * lit]));
    }
    // Pollen drifting through the low sun.
    for (i, home) in layout.motes.iter().enumerate() {
        let k = i as f32;
        let drift = vec3(math::sin(t * 0.13 + k) * 2.0, math::sin(t * 0.21 + k * 3.1) * 0.6, math::cos(t * 0.11 + k * 1.3) * 2.0);
        sprites.push(Sprite::glow(*home + drift, 0.045, [1.0, 0.82, 0.55, 0.22]));
    }
    ground_pools(&mut sprites, t);
    chimney_smoke(&mut sprites, t);
    // Ripples of light where the ducks swim: a faint glint trailing each.
    for i in 0..3 {
        let (at, _) = duck(i, t);
        sprites.push(Sprite::glow(at + vec3(0.0, 0.02, 0.0), 0.5, [1.0, 0.75, 0.45, 0.08]));
    }
    sprites.truncate(MAX_SPRITES);
    sprites
}

/// The light the lanterns and the windows cast on the grass and the path. Level-3 passes (the grass
/// and the lake are drawn by them) do not receive the scene's local lights yet, so these pools
/// stand in for it there; the built-in surfaces (the deck, the porch, the cabin) are lit by the
/// real lights, so lanterns over them (the dock's and the porch's) cast no pool.
fn ground_pools(sprites: &mut Vec<Sprite>, t: f32) {
    let lanterns = &layout().lanterns;
    let count = lanterns.len();
    for (i, light) in lanterns.iter().enumerate() {
        let over_built_in = i + 3 >= count;
        if over_built_in {
            continue;
        }
        let flicker = crate::draw::lantern_flicker(*light, t);
        let [r, g, b, a] = LANTERN_POOL;
        let floor = height(light.x, light.z) + 0.04;
        sprites.push(Sprite { center: vec3(light.x, floor, light.z), half_width: 1.8, color: [r, g, b, a * flicker], axis: Vec3::Y, kind: POOL, half_height: 0.0 });
    }
    let rotation = Quat::from_rotation_y(CABIN_YAW);
    let origin = vec3(CABIN.x, CABIN_FLOOR, CABIN.y);
    for (x, y, z, side) in WINDOWS {
        let reach = y / WINDOW_DIP;
        let hit = origin + rotation * vec3(x, 0.0, z + side * reach);
        let center = vec3(hit.x, height(hit.x, hit.z) + 0.04, hit.z);
        sprites.push(Sprite { center, half_width: 1.4, color: WINDOW_POOL, axis: Vec3::Y, kind: POOL, half_height: 0.0 });
    }
}

/// The cabin chimney's smoke.
fn chimney_smoke(sprites: &mut Vec<Sprite>, t: f32) {
    let rotation = Quat::from_rotation_y(CABIN_YAW);
    let origin = vec3(CABIN.x, CABIN_FLOOR, CABIN.y);
    let chimney = origin + rotation * vec3(-3.2 + 0.9, 5.0, -0.9);
    for puff in 0..SMOKE_PUFFS {
        let age = ((t + puff as f32 * SMOKE_LIFE / SMOKE_PUFFS as f32) % SMOKE_LIFE) / SMOKE_LIFE;
        let drift = vec3(0.55, 0.0, 0.8) * age * 5.0 + vec3(math::sin(puff as f32 * 2.1 + t * 0.4) * 0.3 * age, 0.0, 0.0);
        let center = chimney + drift + vec3(0.0, age * 6.0, 0.0);
        let fade = (1.0 - age) * crate::layout::smoothstep(0.0, 0.08, age);
        sprites.push(Sprite { center, half_width: 0.35 + age * 1.6, color: [SMOKE_ALBEDO[0], SMOKE_ALBEDO[1], SMOKE_ALBEDO[2], SMOKE_STRENGTH * fade], axis: Vec3::ZERO, kind: SMOKE, half_height: 0.0 });
    }
}

/// The light sprites: fireflies, pollen, the ducks' glints, the chimney's smoke and the lanterns'
/// and windows' pools on the grass (the lanterns and the windows are the scene's own lights and
/// emissive materials, `draw.rs`, which Level-3 passes do not receive yet). Under TAA a glow draws
/// its own motion where it owns most of the pixel (`motion_draws`) and a sprite moving against the
/// scene writes its coverage into the reactive mask elsewhere (`reactive_draws`), so a halo is
/// neither trailed nor popped by history that belongs to the scene behind it (renderer pass 2, B.7).
#[derive(Default)]
pub struct Sprites {
    resources: Option<SpriteResources>,
}

struct SpriteResources {
    instances: gpu::Buffer,
    pipeline: gpu::RenderPipeline,
    motion: gpu::RenderPipeline,
    reactive: gpu::RenderPipeline,
}

impl GpuPass<World> for Sprites {
    fn rebuild(&mut self, setup: &mut PassSetup<'_>) -> Result<(), GpuError> {
        let instances = setup.create_buffer(&gpu::BufferDescriptor {
            label: Some("sprites"),
            size: SPRITE_BYTES * MAX_SPRITES as u64,
            usage: gpu::BufferUsages::VERTEX | gpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        })?;
        let module = shader(setup, "sprites", SPRITES_WGSL)?;
        let attributes: [gpu::VertexAttribute; 4] = std::array::from_fn(|i| gpu::VertexAttribute {
            format: gpu::VertexFormat::Float32x4,
            offset: 16 * i as u64,
            shader_location: i as u32,
        });
        let buffers = [Some(gpu::VertexBufferLayout { array_stride: SPRITE_BYTES, step_mode: gpu::VertexStepMode::Instance, attributes: &attributes })];
        let desc = WorldPipeline {
            label: "sprites",
            module: &module,
            vertex: "vs_sprite",
            fragment: "fs_sprite",
            buffers: &buffers,
            topology: gpu::PrimitiveTopology::TriangleList,
            blend: Some(PREMULTIPLIED),
            depth_write: false,
        };
        let pipeline = world_pipeline(setup, None, &desc);
        let reactive_desc = TemporalPipeline {
            label: "sprites reactive",
            module: &module,
            vertex: "vs_sprite_reactive",
            fragment: "fs_sprite_reactive",
            buffers: &buffers,
            topology: gpu::PrimitiveTopology::TriangleList,
            target: setup.reactive_target(),
            depth: setup.temporal_depth(false),
        };
        let reactive = temporal_pipeline(setup, None, &reactive_desc);
        let motion_desc = TemporalPipeline {
            label: "sprites motion",
            vertex: "vs_sprite_motion",
            fragment: "fs_sprite_motion",
            target: setup.motion_target(),
            ..reactive_desc
        };
        let motion = temporal_pipeline(setup, None, &motion_desc);
        self.resources = Some(SpriteResources { instances, pipeline, motion, reactive });
        Ok(())
    }

    fn run(&mut self, ctx: &mut GpuPassCtx<'_, '_, World>) {
        let Some(SpriteResources { instances, pipeline, motion, reactive }) = &self.resources else { return };
        let tick = ctx.sim().world.tick;
        let list = sprites(seconds(tick));
        // The same sprites last frame (every list holds the same sprites in the same order): what
        // each moved from (itself after a history reset and in a capture).
        let before = sprites(seconds(tick.saturating_sub(ctx.tick() - ctx.prev_tick())));
        let mut data = Vec::with_capacity(list.len() * 16);
        for (i, sprite) in list.iter().enumerate() {
            sprite.push(before.get(i).map_or(sprite.center, |was| was.center), &mut data);
        }
        if ctx.write_buffer(instances, 0, &floats(&data)).is_err() {
            return;
        }
        let count = u32::try_from(list.len()).unwrap_or(0);
        if let Some(draws) = ctx.draws() {
            draws.set_pipeline(pipeline).bind_tables(0).set_vertex_buffer(0, instances, ..).draw(0..6, 0..count);
        }
        if let Some(draws) = ctx.motion_draws() {
            draws.set_pipeline(motion).bind_tables(0).set_vertex_buffer(0, instances, ..).draw(0..6, 0..count);
        }
        if let Some(draws) = ctx.reactive_draws() {
            draws.set_pipeline(reactive).bind_tables(0).set_vertex_buffer(0, instances, ..).draw(0..6, 0..count);
        }
    }

    fn api(&self) -> u32 {
        PASS_API
    }

    // The smoke is lit by the environment's light (`smoke_light`).
    fn inputs(&self) -> gpu::RenderInputs {
        gpu::RenderInputs::ENVIRONMENT
    }
}
