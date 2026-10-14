//! The custom GPU pass sample (M2.19, extension ladder level 3): a cube bounces along the ground,
//! a halo pass draws a ring around it inside the world pass (reading the simulation, never writing
//! it) and a CRT pass filters the finished frame before the HUD. Both are raw wgpu in safe Rust
//! through `genex::gpu`; every resource comes from `PassSetup`, so the GPU caps and naga's
//! admission hold, and each pass counts one `custom` draw.
//!
//! It also shows extension ladder level 2 (RQ0.8): a sphere drawn with a custom WGSL material
//! (`gfx.material`, `shaders/glow.wgsl`, drawn with `frame.custom`) and a vignette post pass
//! (`gfx.post_pass_with`, `shaders/vignette.wgsl`, run with `frame.post_pass`), both declared under
//! `[[wgsl]]` in `genex.toml` and compiled in with `game.wgsl`, so every destination has them.

use genex::gpu::{self, GpuError, GpuPass, GpuPassCtx, PassSetup, PassStage};
use genex::prelude::*;

/// Ticks the cube takes to cross from one end of its track to the other.
pub const CROSSING_TICKS: u32 = 90;
/// Half the cube's track, in world units.
pub const TRACK_HALF_WIDTH: f32 = 2.0;
/// The halo's radius around the cube.
const HALO_RADIUS: f32 = 0.9;
/// Vertices of the halo: 32 segments of two triangles.
const HALO_VERTICES: u32 = 32 * 6;
/// The halo's colour (linear rgb and alpha).
const HALO_COLOR: [f32; 4] = [1.0, 0.75, 0.15, 1.0];
const HALO_WGSL: &str = include_str!("../shaders/halo.wgsl");
const CRT_WGSL: &str = include_str!("../shaders/crt.wgsl");
/// The Level-2 sources, by their `[[wgsl]]` paths.
pub const GLOW_PATH: &str = "shaders/glow.wgsl";
/// The Level-2 post pass's path.
pub const VIGNETTE_PATH: &str = "shaders/vignette.wgsl";
const GLOW_WGSL: &str = include_str!("../shaders/glow.wgsl");
const VIGNETTE_WGSL: &str = include_str!("../shaders/vignette.wgsl");
/// The glow material's uniforms: base colour (sRGB) and rim strength, rim colour and pulses per second.
const GLOW_UNIFORMS: [f32; 8] = [0.25, 0.45, 0.95, 0.9, 0.55, 0.85, 1.0, 0.5];
/// The vignette's uniforms: edge tint (sRGB) and strength.
const VIGNETTE_UNIFORMS: [f32; 4] = [0.95, 0.7, 0.45, 0.8];
/// Where the glowing sphere floats, and its radius.
const GLOW_CENTER: Vec3 = Vec3::new(1.2, 0.9, -1.0);
const GLOW_RADIUS: f32 = 0.45;

/// The simulation: where the cube is and which way it moves, and the Level-2 handles its reset
/// asked for (display only: no rule reads them).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct World {
    /// The cube's x position.
    pub x: f32,
    /// Ticks into the current crossing.
    pub step: u32,
    /// Whether the cube moves towards -x.
    pub back: bool,
    /// The glow material (missing in [`plain_game`]).
    pub glow: CustomMaterial,
    /// The vignette (None in [`plain_game`]).
    pub vignette: Option<PostPass>,
}

/// The cube's position: on its track, resting on the ground.
pub fn cube_position(world: &World) -> Vec3 {
    vec3(world.x, 0.5, 0.0)
}

fn uniform_entry(binding: u32, visibility: gpu::ShaderStages) -> gpu::BindGroupLayoutEntry {
    gpu::BindGroupLayoutEntry {
        binding,
        visibility,
        ty: gpu::BindingType::Buffer { ty: gpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
        count: None,
    }
}

/// Bytes of an f32 slice, little-endian (what the GPU reads).
fn bytes_of(values: &[f32]) -> Vec<u8> {
    values.iter().flat_map(|v| v.to_le_bytes()).collect()
}

/// The halo pass: an in-world ring that follows the cube.
#[derive(Default)]
pub struct Halo {
    resources: Option<(gpu::Buffer, gpu::BindGroup, gpu::RenderPipeline)>,
}

impl GpuPass<World> for Halo {
    fn rebuild(&mut self, setup: &mut PassSetup<'_>) -> Result<(), GpuError> {
        let module = setup.create_shader("halo", HALO_WGSL)?;
        let uniforms = setup.create_buffer(&gpu::BufferDescriptor {
            label: Some("halo"),
            size: 32,
            usage: gpu::BufferUsages::UNIFORM | gpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        })?;
        let layout = setup.create_bind_group_layout(&gpu::BindGroupLayoutDescriptor {
            label: Some("halo"),
            entries: &[uniform_entry(0, gpu::ShaderStages::VERTEX_FRAGMENT)],
        });
        let group = setup.create_bind_group(&gpu::BindGroupDescriptor {
            label: Some("halo"),
            layout: &layout,
            entries: &[gpu::BindGroupEntry { binding: 0, resource: uniforms.as_entire_binding() }],
        });
        let pipeline_layout = setup.create_pipeline_layout(&gpu::PipelineLayoutDescriptor {
            label: Some("halo"),
            bind_group_layouts: &[Some(setup.tables_layout()), Some(&layout)],
            immediate_size: 0,
        });
        let targets = [Some(gpu::ColorTargetState { format: setup.world_format(), blend: None, write_mask: gpu::ColorWrites::ALL })];
        let pipeline = setup.create_render_pipeline(&gpu::RenderPipelineDescriptor {
            label: Some("halo"),
            layout: Some(&pipeline_layout),
            vertex: gpu::VertexState { module: &module, entry_point: Some("vs_halo"), compilation_options: Default::default(), buffers: &[] },
            primitive: gpu::PrimitiveState { cull_mode: None, ..Default::default() },
            depth_stencil: Some(setup.world_depth(true)),
            multisample: setup.world_multisample(),
            fragment: Some(gpu::FragmentState { module: &module, entry_point: Some("fs_halo"), compilation_options: Default::default(), targets: &targets }),
            multiview_mask: None,
            cache: None,
        });
        self.resources = Some((uniforms, group, pipeline));
        Ok(())
    }

    fn run(&mut self, ctx: &mut GpuPassCtx<'_, '_, World>) {
        let Some((uniforms, group, pipeline)) = &self.resources else { return };
        let center = cube_position(&ctx.sim().world);
        let mut halo = vec![center.x, 0.02, center.z, HALO_RADIUS];
        halo.extend(HALO_COLOR);
        // 32 bytes a frame, far inside the upload budget; a refusal only skips the move.
        let _ = ctx.write_buffer(uniforms, 0, &bytes_of(&halo));
        let Some(draws) = ctx.draws() else { return };
        draws.set_pipeline(pipeline).bind_tables(0).set_bind_group(1, group, &[]).draw(0..HALO_VERTICES, 0..1);
    }
}

/// The CRT pass: scanlines and a vignette over the finished frame.
#[derive(Default)]
pub struct Crt {
    resources: Option<(gpu::Texture, gpu::Buffer, gpu::BindGroup, gpu::RenderPipeline)>,
}

impl GpuPass<World> for Crt {
    fn rebuild(&mut self, setup: &mut PassSetup<'_>) -> Result<(), GpuError> {
        let (width, height) = setup.world_size();
        let copy = setup.create_texture(&gpu::TextureDescriptor {
            label: Some("crt source"),
            size: gpu::Extent3d { width, height, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: gpu::TextureDimension::D2,
            format: setup.world_format(),
            usage: gpu::TextureUsages::TEXTURE_BINDING | gpu::TextureUsages::COPY_DST,
            view_formats: &[],
        })?;
        let params = setup.create_buffer(&gpu::BufferDescriptor {
            label: Some("crt"),
            size: 16,
            usage: gpu::BufferUsages::UNIFORM | gpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        })?;
        let module = setup.create_shader("crt", CRT_WGSL)?;
        let source = gpu::BindGroupLayoutEntry {
            binding: 0,
            visibility: gpu::ShaderStages::FRAGMENT,
            ty: gpu::BindingType::Texture {
                sample_type: gpu::TextureSampleType::Float { filterable: false },
                view_dimension: gpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        };
        let layout = setup.create_bind_group_layout(&gpu::BindGroupLayoutDescriptor {
            label: Some("crt"),
            entries: &[source, uniform_entry(1, gpu::ShaderStages::FRAGMENT)],
        });
        let view = copy.create_view(&gpu::TextureViewDescriptor::default());
        let group = setup.create_bind_group(&gpu::BindGroupDescriptor {
            label: Some("crt"),
            layout: &layout,
            entries: &[
                gpu::BindGroupEntry { binding: 0, resource: gpu::BindingResource::TextureView(&view) },
                gpu::BindGroupEntry { binding: 1, resource: params.as_entire_binding() },
            ],
        });
        let pipeline_layout =
            setup.create_pipeline_layout(&gpu::PipelineLayoutDescriptor { label: Some("crt"), bind_group_layouts: &[Some(&layout)], immediate_size: 0 });
        let targets = [Some(gpu::ColorTargetState { format: setup.world_format(), blend: None, write_mask: gpu::ColorWrites::ALL })];
        let pipeline = setup.create_render_pipeline(&gpu::RenderPipelineDescriptor {
            label: Some("crt"),
            layout: Some(&pipeline_layout),
            vertex: gpu::VertexState { module: &module, entry_point: Some("vs_crt"), compilation_options: Default::default(), buffers: &[] },
            primitive: gpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: gpu::MultisampleState::default(),
            fragment: Some(gpu::FragmentState { module: &module, entry_point: Some("fs_crt"), compilation_options: Default::default(), targets: &targets }),
            multiview_mask: None,
            cache: None,
        });
        self.resources = Some((copy, params, group, pipeline));
        Ok(())
    }

    fn run(&mut self, ctx: &mut GpuPassCtx<'_, '_, World>) {
        let Some((copy, params, group, pipeline)) = &self.resources else { return };
        // The tick is far below 2^24, where u64 -> f32 is exact.
        let tick = ctx.tick() as f32;
        let _ = ctx.write_buffer(params, 0, &bytes_of(&[tick, 0.0, 0.0, 0.0]));
        let (Some(world), Some(target)) = (ctx.world_texture().cloned(), ctx.world_view().cloned()) else { return };
        let Some(encoder) = ctx.encoder() else { return };
        encoder.copy_texture_to_texture(world.as_image_copy(), copy.as_image_copy(), world.size());
        let mut pass = encoder.begin_render_pass(&gpu::RenderPassDescriptor {
            label: Some("crt"),
            color_attachments: &[Some(gpu::RenderPassColorAttachment {
                view: &target,
                depth_slice: None,
                resolve_target: None,
                ops: gpu::Operations { load: gpu::LoadOp::Load, store: gpu::StoreOp::Store },
            })],
            ..Default::default()
        });
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, group, &[]);
        pass.draw(0..3, 0..1);
    }
}

/// The game without its passes: the same simulation and draws (the determinism rows compare).
pub fn plain_game() -> Game<World> {
    let mut game = Game::new(World::default()).title("Custom pass").world_size(160, 90).background(Color::rgb(18, 22, 34));
    game.on_update(|sim, _ctx| {
        let world = &mut sim.world;
        world.step += 1;
        if world.step >= CROSSING_TICKS {
            world.step = 0;
            world.back = !world.back;
        }
        let along = world.step as f32 / CROSSING_TICKS as f32;
        let from = if world.back { TRACK_HALF_WIDTH } else { -TRACK_HALF_WIDTH };
        world.x = from + (if world.back { -2.0 } else { 2.0 }) * TRACK_HALF_WIDTH * along;
    });
    game.camera(|_| Camera::look_at(vec3(0.0, 3.0, 6.0), vec3(0.0, 0.4, 0.0)));
    game.on_draw(|sim, frame, _| {
        frame.tag("ground").cube(Transform::from_xyz(0.0, -0.05, 0.0).with_scale(vec3(7.0, 0.1, 4.0)), Color::rgb(90, 96, 110));
        frame.tag("cube").cube(Transform::from_translation(cube_position(&sim.world)), Color::rgb(220, 70, 60));
    });
    game.probe("x", |sim| json!(sim.world.x));
    game
}

/// [`plain_game`] with the Level-2 material and post pass only: a glowing sphere and the vignette.
pub fn level2_game() -> Game<World> {
    let mut game = plain_game();
    with_level2(&mut game);
    game
}

fn with_level2(game: &mut Game<World>) {
    game.wgsl(GLOW_PATH, GLOW_WGSL).wgsl(VIGNETTE_PATH, VIGNETTE_WGSL);
    game.on_reset(|sim, _seed, _rng, gfx| {
        sim.world.glow = gfx.material(GLOW_PATH, &GLOW_UNIFORMS);
        sim.world.vignette = Some(gfx.post_pass_with(VIGNETTE_PATH, &VIGNETTE_UNIFORMS));
    });
    game.on_draw(|sim, frame, _| {
        let sphere = Transform::from_translation(GLOW_CENTER).with_scale(Vec3::splat(GLOW_RADIUS));
        frame.tag("glow").custom(CustomMesh::Sphere, sphere, &sim.world.glow, Color::WHITE);
        if let Some(vignette) = &sim.world.vignette {
            frame.post_pass(vignette);
        }
    });
}

/// The sample: [`plain_game`] with the halo (after the opaque work), the CRT filter (post), the
/// glow material and the vignette post pass.
pub fn game() -> Game<World> {
    let mut game = plain_game();
    game.gpu_pass("halo", PassStage::AfterOpaque, Halo::default());
    game.gpu_pass("crt", PassStage::Post, Crt::default());
    with_level2(&mut game);
    game
}

/// [`game`] without the Level-2 material and post pass: the Level-3 passes alone (what the
/// sample's golden shows).
pub fn level3_game() -> Game<World> {
    let mut game = plain_game();
    game.gpu_pass("halo", PassStage::AfterOpaque, Halo::default());
    game.gpu_pass("crt", PassStage::Post, Crt::default());
    game
}
