//! The `use` lines and signature lists that open the drawing and rendering reference pages
//! (`docs/api/drawing.md`, `ctx.md`, `lighting.md`, `custom-materials.md`, `gpu-passes.md`,
//! `grading.md`, `rendering.md`), written out as code like `api_headers.rs`: each line here is one
//! a page teaches, so a facade change that moves a type or a call breaks this build before it
//! misleads a game.

use genex::gpu::{
    BindGroup, BindGroupLayout, ColorTargetState, CommandEncoder, DepthStencilState, GpuError, GpuPass, GpuPassCtx, MultisampleState, PassSetup,
    PassStage, RenderInputs, ShaderModule, Texture, TextureFormat, TextureView,
};
use genex::prelude::*;
use genex::render::{
    ClassOverride, Clouds, Decal, DepthOfField, DeviceClass, Environment, Exposure, Fog, FormFactor, Grading, GradingLut, GradingLutError,
    GradingSection, HdriEnvironment, HdriSun, IrradianceVolume, JitterCycle, LodConfig, Metering, Moon, MotionBlur, PerformanceTier, QualityPreset,
    ReflectionProbe, RenderConfig, ShadowConfig, ShadowFilter, SkyMedium, SkyParams, SpotLight, TaaQuality, Tonemap, UpscaleMode, lock_upscale,
    settings_panel,
};
use genex::{ExtensionRefusal, Fit, Impostor, LodRefusalCode, MeshError, MeshErrorCode, Subsurface, TouchPhase};

/// drawing.md: every draw, a transform, a built mesh (both faces of a card), levels and a camera.
fn drawing(gfx: &Gfx, frame: &mut Frame, plaster: &Material) -> Result<Model, MeshError> {
    let model: Model = gfx.assets().model("pond.glb");
    let panel = Transform::from_xyz(0.0, 1.5, -4.0).with_rotation(Quat::IDENTITY).with_scale(vec3(4.0, 3.0, 0.2));
    let _: Transform = Transform::from_translation(Vec3::ZERO);
    frame.tag("walls").model(&model, panel).model_with(&model, panel, plaster).model_tinted(&model, panel, Color::rgba(255, 255, 255, 128));
    frame.cube(panel, Color::WHITE).cube_with(panel, plaster);
    frame.sphere(Vec3::Y, 0.5, Color::RED).sphere_with(Vec3::Y, 0.5, plaster);
    frame.line(Vec3::ZERO, Vec3::Y, Color::GREEN).lines(&[Vec3::ZERO, Vec3::X], Color::BLUE).clear(Color::BLACK);
    let mut data = MeshData::new();
    let card = [vec3(-1.0, 0.0, 0.0), vec3(1.0, 0.0, 0.0), vec3(1.0, 2.0, 0.0), vec3(-1.0, 2.0, 0.0)];
    let [bottom_left, bottom_right, top_right, top_left] = card;
    data.cuboid(vec3(-2.0, 0.0, 0.0), vec3(-0.6, 3.0, 0.25), 1.0)
        .quad(card, 1.0)
        .quad([bottom_right, bottom_left, top_left, top_right], 1.0);
    let corner: u32 = data.vertex(Vec3::ZERO, Vec3::Z, Vec2::ZERO);
    data.triangle(corner, corner, corner);
    let checked: Result<(), MeshError> = data.check();
    if let Err(error) = &checked {
        let _: (MeshErrorCode, &str) = (error.code, error.code.wire());
    }
    let wall: Model = gfx.mesh(&data)?;
    let tree = model.clone().with_levels(&[(wall.clone(), 24.0)]).with_lod_bias(2.0).with_impostor(Impostor::hemi());
    let _: (Option<Impostor>, Option<LodRefusalCode>) = (tree.impostor(), tree.lod_refusal());
    let _: Model = gfx.assets().compound(&[&model, &wall]);
    let _: Camera = Camera { projection: Projection::Orthographic, fovy: 12.0, ..Camera::look_at(vec3(0.0, 5.0, 10.0), Vec3::ZERO) };
    Ok(wall)
}

/// ctx.md: the devices, the rng, the clock, the save folder, the window's rect and the injections.
fn ctx(ctx: &Ctx, ui: &mut egui::Ui, rng: &mut Pcg32) -> Input {
    let _: (bool, bool, bool) = (ctx.keys.down(Key::KeyW), ctx.keys.pressed(Key::Space), ctx.keys.released(Key::Space));
    for touch in ctx.touches.all() {
        let _: (u32, Vec2) = (touch.id, touch.position);
        match touch.phase {
            TouchPhase::Began | TouchPhase::Held | TouchPhase::Ended | TouchPhase::Tapped => {}
        }
    }
    let _: (bool, bool) = (ctx.touches.tapped(), ctx.touches.began());
    let _: (bool, f32, f32) = (ctx.pads.down(0, 0), ctx.pads.value(0, 0), ctx.pads.axis(0, 0));
    let _: (Vec2, Vec2, Vec2, &str) = (ctx.pointer, ctx.look, ctx.wheel, ctx.text);
    let _: (f32, f32, i32, u32, bool, u32) = (ctx.rng.f32(), ctx.rng.range(0.0, 1.0), ctx.rng.range_i32(1, 6), ctx.rng.below(10), ctx.rng.chance(0.5), ctx.rng.next_u32());
    let _: (f32, f32) = (rng.f32(), rng.range(0.0, 1.0));
    let _: (f32, u64, [u32; 2]) = (ctx.dt, ctx.tick, ctx.world_size);
    let _: bool = ctx.save("progress.json", b"{}");
    let _: Option<Vec<u8>> = ctx.load("progress.json");
    let _: egui::Rect = ui.ctx().content_rect();
    let _: Game<()> = Game::new(()).fit(Fit::Expand);
    Input::key_tap(Key::Space)
        .and(Input::key_down(Key::KeyW))
        .and(Input::key_up(Key::KeyW))
        .and(Input::click_at(10.0, 20.0))
        .and(Input::pointer(0.5, 0.5))
        .and(Input::look(4.0, 0.0))
        .and(Input::wheel(0.0, 1.0))
        .and(Input::text("a"))
        .and(Input::touch_start(0, 10.0, 20.0))
        .and(Input::touch_move(0, 12.0, 20.0))
        .and(Input::touch_end(0, 12.0, 20.0))
}

/// lighting.md: the lights, a material's every builder, probes, volumes, decals, the environment,
/// the fog, local exposure and the shadow rows.
fn lighting(frame: &mut Frame) -> RenderConfig {
    let (at, down, warm) = (vec3(0.0, 3.0, 0.0), Vec3::NEG_Y, Color::rgb(255, 200, 140));
    let plaster: Material = Material::color(Color::rgb(214, 206, 188))
        .with_base_texture("textures/plaster_albedo.jpg")
        .with_normal_texture("textures/plaster_normal.png", 1.0)
        .with_orm_texture("textures/plaster_orm.png")
        .with_metal_rough_texture("textures/plaster_mr.png")
        .with_occlusion_texture("textures/plaster_ao.png", 1.0)
        .with_roughness(1.0)
        .with_metallic(1.0)
        .with_uv_scale(2.0, 2.0)
        .with_world_uv(1.5)
        .with_uv_offset(0.1, 0.0)
        .with_uv_rotation(0.3)
        .with_uv_jitter(7)
        .with_stochastic_tiling(true)
        .with_macro_variation(0.18, 3.0)
        .with_untextured_color(Color::rgb(200, 190, 170))
        .with_emissive(Color::BLACK, 1.0)
        .with_emissive_texture("textures/glow.png");
    let _: Material = Material::emissive(Color::rgb(255, 160, 64), 6.0).with_subsurface(Subsurface::WAX);
    let _: Subsurface = Subsurface::new([0.8, 0.4, 0.2], 0.3).with_transmission(0.2).with_power(6.0).with_depth(0.01);
    let _ = (Subsurface::SKIN, Subsurface::LEAF);
    frame
        .sun(vec3(0.4, 1.0, 0.3), Color::WHITE, 2.5)
        .ambient(Color::WHITE, 0.08)
        .point_light(at, 4.0, warm, 3.0)
        .spot_light(at, down, 8.0, warm, 5.0)
        .spot_light_with(&SpotLight::new(at, down, 8.0, warm, 5.0).with_cone_degrees(25.0, 40.0).with_shadow(true))
        .reflection_probe(&ReflectionProbe::new(Vec3::ZERO, vec3(6.0, 3.0, 8.0)).with_capture(vec3(3.0, 1.6, 4.0)).with_blend(0.4))
        .irradiance_volume(&IrradianceVolume::new(Vec3::ZERO, vec3(6.0, 3.0, 8.0)).with_cells([6, 3, 8]).with_blend(0.3))
        .decal(
            &Decal::on_wall(vec3(0.0, 1.5, 0.0), Vec3::Z, 1.0, 1.5)
                .with_base_texture("decals/poster.png")
                .with_normal_texture("decals/poster_normal.png", 1.0)
                .with_orm_texture("decals/poster_orm.png")
                .with_depth(0.2)
                .rotated(0.1)
                .with_color(warm)
                .with_opacity(0.9)
                .with_roughness(0.04)
                .with_metallic(0.0)
                .with_albedo_mix(0.0)
                .with_flatten(1.0),
        )
        .decal(&Decal::on_ground(Vec3::ZERO, 2.0, 3.0))
        .cube_with(Transform::IDENTITY, &plaster);
    let moon = Moon::new([-0.4, 0.5, -0.3]).with_moonlight(0.004).with_tint([1.0, 0.95, 0.9]).with_earthshine(0.1).with_angular_radius_degrees(0.5);
    let clouds = Clouds::default().with_coverage(0.5).with_layer(1.5, 1.0).with_density(1.0).with_offset([0.0, 0.0]).with_cirrus(0.6);
    let air = SkyMedium::earth().with_rayleigh([5.8e-3, 13.5e-3, 33.1e-3], 8.0).with_mie(3.996e-3, 4.44e-3, 0.8, 1.2);
    let _: SkyMedium = air.with_absorption([0.65e-3, 1.881e-3, 0.085e-3], 25.0, 30.0).with_planet(6360.0, 100.0);
    let sky = SkyParams::default()
        .with_ground_albedo([0.1, 0.12, 0.06])
        .with_sun_angular_radius_degrees(2.0)
        .with_intensity(1.0)
        .with_stars(2e-5)
        .with_moon(Some(moon))
        .with_medium(SkyMedium::mars())
        .with_clouds(Some(clouds));
    frame.environment(Environment::Sky(sky)).environment(Environment::sky()).environment(Environment::hdri("env/sky.hdr"));
    frame.environment(Environment::Hdri(HdriEnvironment::new("env/sky.hdr").with_rotation_degrees(90.0).with_intensity(0.5).with_sun(HdriSun::Off)));
    let _ = (HdriSun::Analytic, Environment::Color);
    let fog = Fog::default()
        .with_density(0.02)
        .with_height(0.3, 0.0)
        .with_range(0.0, 0.9)
        .with_color([1.0, 1.0, 1.0])
        .with_aerial_perspective(false)
        .with_volumetric(false);
    let shadows = ShadowConfig::new().cascades(4).map_size(2048).filter(ShadowFilter::Pcf5x5).distance(60).blend_band(0.1);
    RenderConfig::new()
        .local_exposure(0.5, 0.8)
        .fog(fog)
        .shadows_at(QualityPreset::High, shadows)
        .class(DeviceClass::new(FormFactor::Mobile, PerformanceTier::Mid), ClassOverride { shadows, ..Default::default() })
}

/// custom-materials.md: a compiled source, its material, uniforms, textures, a post pass and TAA's knobs.
fn custom_materials(game: &mut Game<()>, gfx: &Gfx, frame: &mut Frame, model: &Model) -> Result<RenderConfig, ExtensionRefusal> {
    game.wgsl("shaders/glow.wgsl", "@fragment fn fs_material() {}");
    let glow: CustomMaterial = gfx.material("shaders/glow.wgsl", &[1.0, 0.5, 0.2, 0.0]);
    let _: (Option<&ExtensionRefusal>, bool) = (glow.refusal(), glow.is_missing());
    gfx.set_material_uniforms(&glow, &[0.5, 0.5, 0.2, 0.0])?;
    let noise = gfx.texture("textures/noise.png");
    let _: CustomMaterial = gfx.material_textured("shaders/ground.wgsl", &[], &[&noise]);
    let vignette: PostPass = gfx.post_pass("shaders/vignette.wgsl");
    let _: PostPass = gfx.post_pass_with("shaders/tint.wgsl", &[0.2, 0.0, 0.0, 0.0]);
    frame
        .custom(model, Transform::IDENTITY, &glow, Color::WHITE)
        .custom(CustomMesh::Cube, Transform::IDENTITY, &glow, Color::WHITE)
        .custom(CustomMesh::Sphere, Transform::IDENTITY, &glow, Color::WHITE)
        .post_pass(&vignette);
    let taa = TaaQuality::DEFAULT.with_jitter_cycle(JitterCycle::Sixteen).with_alpha_min(0.05).with_lod_bias(-0.5);
    let class = DeviceClass::new(FormFactor::Desktop, PerformanceTier::Ultra);
    Ok(RenderConfig::new().class(class, ClassOverride { taa: Some(taa), ..Default::default() }))
}

/// gpu-passes.md: a pass at API v2, its setup and its frame.
#[derive(Default)]
struct Outline;

impl GpuPass<()> for Outline {
    fn rebuild(&mut self, setup: &mut PassSetup<'_>) -> Result<(), GpuError> {
        let _: (TextureFormat, &BindGroupLayout, Option<&BindGroupLayout>) = (setup.world_format(), setup.tables_layout(), setup.environment_layout());
        let _: (DepthStencilState, MultisampleState) = (setup.world_depth(false), setup.world_multisample());
        let _: (ColorTargetState, ColorTargetState) = (setup.motion_target(), setup.reactive_target());
        let _: (DepthStencilState, MultisampleState) = (setup.temporal_depth(true), setup.temporal_multisample());
        let _: ShaderModule = setup.create_shader("outline", "@compute @workgroup_size(1) fn main() {}")?;
        Ok(())
    }

    fn run(&mut self, ctx: &mut GpuPassCtx<'_, '_, ()>) {
        let _: (&Sim<()>, u64, u64, bool) = (ctx.sim(), ctx.tick(), ctx.prev_tick(), ctx.depth_reversed());
        let _: (Option<&TextureView>, Option<&TextureView>, Option<&TextureView>) = (ctx.prepass_depth(), ctx.prepass_normals(), ctx.prepass_motion());
        let _: (Option<&Texture>, Option<&BindGroup>, &BindGroup) = (ctx.world_texture(), ctx.environment(), ctx.tables());
        if let Some(draws) = ctx.draws() {
            draws.bind_tables(0);
        }
        let _ = (ctx.motion_draws().is_some(), ctx.reactive_draws().is_some());
        if let Some(encoder) = ctx.encoder() {
            let _: &mut CommandEncoder = encoder;
        }
    }

    fn api(&self) -> u32 {
        2
    }

    fn inputs(&self) -> RenderInputs {
        RenderInputs::DEPTH | RenderInputs::NORMALS | RenderInputs::MOTION | RenderInputs::ENVIRONMENT | RenderInputs::HDR_SCENE
    }
}

/// gpu-passes.md: registration at each stage.
fn gpu_passes(game: &mut Game<()>) {
    game.gpu_pass("outline", PassStage::PostHdr, Outline);
    let _ = [PassStage::BeforeCull, PassStage::AfterPrepass, PassStage::AfterOpaque, PassStage::AfterTransparent, PassStage::Post];
}

/// grading.md: the grade, its sections and LUT, white balance, the exposure curve and the lens.
fn grading(game: &mut Game<()>, cube: &str) -> Result<(), GradingLutError> {
    let lut: &'static GradingLut = GradingLut::parse_cube(cube)?.intern()?;
    let grade = Grading { shadows: GradingSection { lift: -0.01, ..GradingSection::NEUTRAL }, ..Grading::NEUTRAL }
        .with_contrast(1.1)
        .with_saturation(0.95)
        .with_vibrance(1.1)
        .with_lut(lut, 0.8);
    game.render_settings(
        RenderConfig::from_build()
            .grading(grade)
            .temperature(0.3, 0.0)
            .white_balance([1.0, 0.85, 0.65])
            .exposure_curve(&[(-8.0, -6.0), (0.0, 0.0)])
            .depth_of_field(DepthOfField::focused(3.0, 2.0))
            .motion_blur(MotionBlur::shutter(0.5)),
    );
    Ok(())
}

/// rendering.md: the look, the preset, a class's wishes, the panel, upscaling and TAA's draw ids.
fn rendering(game: &mut Game<()>, ui: &mut egui::Ui, frame: &mut Frame) {
    let mobile_mid: DeviceClass = DeviceClass::new(FormFactor::Mobile, PerformanceTier::Mid);
    let _: Option<DeviceClass> = DeviceClass::from_wire("mobile-mid");
    let exposure = Exposure::auto().compensation(0.5).metering(Metering::Ground);
    let _: Exposure = Exposure::manual(0.0);
    game.render_settings(
        RenderConfig::new()
            .preset(QualityPreset::Medium)
            .tonemap(Tonemap::AgxPunchy)
            .exposure(exposure)
            .upscale(UpscaleMode::Quality)
            .class(mobile_mid, ClassOverride { render_scale: Some(0.67), fps: Some(30), ..Default::default() })
            .lod_at(mobile_mid, LodConfig::new().threshold_px(3.0).fade_band(0.2).far_density(0.5)),
    );
    let _: RenderConfig = RenderConfig::from_build().upscale_locked(UpscaleMode::Native);
    let _: bool = settings_panel(ui);
    lock_upscale(Some(UpscaleMode::Native));
    frame.id("hero").id(7u32).end_id().camera_cut();
}

/// What each page's code reaches is named where the page says it is.
#[test]
fn the_render_pages_name_real_paths_and_shapes() {
    let _ = (drawing, ctx, lighting, custom_materials, gpu_passes, grading, rendering);
    let mut frame = Frame::default();
    frame.sphere_with(vec3(0.0, 1.0, 0.0), 0.5, &Material::default());
    assert_eq!(frame.draw_calls(), 1, "a sphere is a centre and a radius");
    assert_eq!(Outline.api(), 2, "a pass written at API v2 says so");
    assert_eq!(DeviceClass::from_wire("mobile-mid"), Some(DeviceClass::new(FormFactor::Mobile, PerformanceTier::Mid)));
}
