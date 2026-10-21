//! The facade's agent-facing vocabularies are the ones `tests/fixtures/rust-facade-vocabulary.json`
//! pins: the template docs test (`tests/conformance/rust-template-docs.test.ts`) reads that file
//! and checks the docs name each, so a change here fails one side until the other follows.

use genex::gpu::{GpuCode, PassStage};
use genex::prelude::*;
use genex::{InstallErrorCode, RUNTIME_KEYS};
use std::path::Path;

fn fixture() -> serde_json::Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/rust-facade-vocabulary.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("the fixture")).expect("the fixture is JSON")
}

fn names(value: &serde_json::Value) -> Vec<&str> {
    value.as_array().expect("a list").iter().map(|item| item.as_str().expect("a name")).collect()
}

#[test]
fn the_state_keys_and_install_refusals_are_the_fixtures() {
    let pinned = fixture();
    assert_eq!(names(&pinned["runtimeKeys"]), RUNTIME_KEYS);
    let codes: Vec<&str> = InstallErrorCode::ALL.iter().map(|code| code.as_str()).collect();
    assert_eq!(names(&pinned["installRefusals"]), codes);
}

#[derive(Default)]
struct World;

/// A pass that is never built: the registration panics before anything runs.
struct Idle;

impl genex::gpu::GpuPass<World> for Idle {
    fn rebuild(&mut self, _setup: &mut genex::gpu::PassSetup<'_>) -> Result<(), genex::gpu::GpuError> {
        Ok(())
    }
    fn run(&mut self, _ctx: &mut genex::gpu::GpuPassCtx<'_, '_, World>) {}
}

#[test]
fn a_refused_registration_panics_with_the_fixtures_code() {
    let pinned = fixture();
    assert_eq!(names(&pinned["registrationRefusals"]), [GpuCode::GpuPassInvalid.wire()]);
    let refused = std::panic::catch_unwind(|| {
        let mut game = Game::new(World);
        game.gpu_pass("", PassStage::Post, Idle);
    });
    let message = refused.expect_err("an empty pass name is refused");
    let text = message.downcast_ref::<String>().map(String::as_str).or_else(|| message.downcast_ref::<&str>().copied());
    assert!(text.is_some_and(|text| text.contains(GpuCode::GpuPassInvalid.wire())), "{text:?}");
}

#[test]
fn the_level_two_calls_and_the_call_each_wgsl_kind_feeds_are_the_fixtures() {
    let pinned = fixture();
    assert_eq!(names(&pinned["levelTwoCalls"]), genex::manifest::LEVEL_TWO_CALLS);
    for kind in genex::manifest::WgslKind::ALL {
        assert_eq!(pinned["wgslKindCalls"][kind.as_str()].as_str(), Some(kind.facade_call()), "{}", kind.as_str());
    }
    let kinds = pinned["wgslKindCalls"].as_object().expect("an object").len();
    assert_eq!(kinds, genex::manifest::WgslKind::ALL.len());
}

#[test]
fn the_meshlet_extras_schema_is_the_fixtures() {
    use genex_render::meshlet::{self, MeshletExtrasKey, MeshletFault};
    let pinned = fixture();
    let schema = &pinned["meshlets"];
    assert_eq!(schema["extrasKey"].as_str(), Some(meshlet::MESHLETS_EXTRAS_KEY));
    let numbers = [
        ("schemaVersion", meshlet::MESHLET_SCHEMA_VERSION),
        ("maxVertices", meshlet::MESHLET_MAX_VERTICES),
        ("maxTriangles", meshlet::MESHLET_MAX_TRIANGLES),
        ("recordBytes", meshlet::MESHLET_RECORD_BYTES),
        ("minTrianglesDefault", genex_render::settings::DEFAULT_MESHLET_MIN_TRIANGLES),
    ];
    for (key, value) in numbers {
        assert_eq!(schema[key].as_u64(), Some(u64::from(value)), "{key}");
    }
    let keys: Vec<&str> = MeshletExtrasKey::ALL.iter().map(|key| key.wire()).collect();
    assert_eq!(names(&schema["extrasKeys"]), keys);
    let faults: Vec<&str> = MeshletFault::ALL.iter().map(|fault| fault.wire()).collect();
    assert_eq!(names(&schema["faults"]), faults);
}

#[test]
fn the_lod_extras_schema_is_the_fixtures() {
    use genex_render::mesh::{self, LodExtrasKey, LodFault, LodLevelKey};
    let pinned = fixture();
    let schema = &pinned["lods"];
    assert_eq!(schema["extrasKey"].as_str(), Some(mesh::LODS_EXTRAS_KEY));
    let numbers = [
        ("schemaVersion", mesh::LOD_SCHEMA_VERSION),
        ("maxLevels", mesh::LOD_MAX_LEVELS),
        ("minTriangles", mesh::LOD_MIN_TRIANGLES),
    ];
    for (key, value) in numbers {
        assert_eq!(schema[key].as_u64(), Some(u64::from(value)), "{key}");
    }
    let keys: Vec<&str> = LodExtrasKey::ALL.iter().map(|key| key.wire()).collect();
    assert_eq!(names(&schema["extrasKeys"]), keys);
    let levels: Vec<&str> = LodLevelKey::ALL.iter().map(|key| key.wire()).collect();
    assert_eq!(names(&schema["levelKeys"]), levels);
    let faults: Vec<&str> = LodFault::ALL.iter().map(|fault| fault.wire()).collect();
    assert_eq!(names(&schema["faults"]), faults);
}

#[test]
fn the_environment_calls_and_their_wire_spellings_are_the_fixtures() {
    use genex::render::{EnvironmentKind, HdriSun};
    let pinned = fixture();
    let environment = &pinned["environment"];
    assert_eq!(names(&environment["calls"]), genex::manifest::ENVIRONMENT_CALLS);
    let kinds: Vec<&str> = EnvironmentKind::ALL.iter().map(|kind| kind.wire()).collect();
    assert_eq!(names(&environment["kinds"]), kinds);
    let suns: Vec<&str> = HdriSun::ALL.iter().map(|sun| sun.wire()).collect();
    assert_eq!(names(&environment["hdriSun"]), suns);
}

#[test]
fn the_frame_calls_temporal_effects_need_are_the_fixtures() {
    let pinned = fixture();
    assert_eq!(names(&pinned["temporalCalls"]), genex::manifest::TEMPORAL_CALLS);
    assert!(genex::manifest::TEMPORAL_CALLS.contains(&"frame.camera_cut"));
}

#[test]
fn the_light_and_emission_calls_are_the_fixtures() {
    let pinned = fixture();
    assert_eq!(names(&pinned["lights"]["calls"]), genex::manifest::LIGHT_CALLS);
}

#[test]
fn the_instance_group_calls_and_refusals_are_the_fixtures() {
    use genex::InstanceGroupErrorCode;
    let pinned = fixture();
    assert_eq!(names(&pinned["instanceGroups"]["calls"]), genex::manifest::INSTANCE_GROUP_CALLS);
    let refusals = [InstanceGroupErrorCode::TooManyInstances, InstanceGroupErrorCode::RangeOutOfGroup].map(InstanceGroupErrorCode::wire);
    assert_eq!(names(&pinned["instanceGroups"]["refusals"]), refusals);
}

#[test]
fn the_particle_calls_and_refusals_are_the_fixtures() {
    use genex::ParticlesErrorCode;
    let pinned = fixture();
    assert_eq!(names(&pinned["particles"]["calls"]), genex::manifest::PARTICLE_CALLS);
    let refusals = ParticlesErrorCode::ALL.map(ParticlesErrorCode::wire);
    assert_eq!(names(&pinned["particles"]["refusals"]), refusals);
}

#[test]
fn the_fog_calls_are_the_fixtures_and_each_is_a_call_of_the_facade() {
    use genex::render::{Fog, RenderConfig};
    let pinned = fixture();
    assert_eq!(names(&pinned["fog"]["calls"]), genex::manifest::FOG_CALLS);
    // Every pinned name is a real call, chained as GENEX_API.md teaches it.
    let fog = Fog::default()
        .with_density(0.02)
        .with_height(0.3, 0.0)
        .with_range(0.0, 0.9)
        .with_color([1.0, 1.0, 1.0])
        .with_aerial_perspective(false)
        .with_volumetric(false);
    assert!(fog.is_on() && !fog.volumetric && !fog.aerial_perspective);
    let _config = RenderConfig::new().fog(fog);
}

#[test]
fn the_terrain_calls_and_refusals_are_the_fixtures() {
    use genex::TerrainErrorCode;
    let pinned = fixture();
    assert_eq!(names(&pinned["terrain"]["calls"]), genex::manifest::TERRAIN_CALLS);
    let refusals = TerrainErrorCode::ALL.map(TerrainErrorCode::wire);
    assert_eq!(names(&pinned["terrain"]["refusals"]), refusals);
}

#[test]
fn the_game_systems_blocks_are_the_fixtures() {
    use genex::manifest::{ANIMATION_CALLS, ASSET_CALLS, ASSET_REFUSALS, INPUT_CALLS, LOD_CALLS, LOD_REFUSALS, NAV_CALLS, STREAM_CALLS};
    let pinned = fixture();
    let animation: Vec<&str> = genex_anim::AnimationErrorCode::ALL
        .map(genex_anim::AnimationErrorCode::wire)
        .into_iter()
        .chain(genex::CharacterErrorCode::ALL.map(genex::CharacterErrorCode::wire))
        .collect();
    let stream = genex::StreamErrorCode::ALL.map(genex::StreamErrorCode::wire);
    let nav = genex::nav::NavErrorCode::ALL.map(genex::nav::NavErrorCode::wire);
    let input = genex::actions::InputErrorCode::ALL.map(genex::actions::InputErrorCode::as_str);
    let assets = genex::AssetErrorCode::ALL.map(genex::AssetErrorCode::wire);
    assert_eq!(ASSET_REFUSALS, assets, "the manifest's asset refusals are AssetErrorCode's");
    let lod = genex::LodRefusalCode::ALL.map(genex::LodRefusalCode::wire);
    assert_eq!(LOD_REFUSALS, lod, "the manifest's lod refusals are LodRefusalCode's");
    let blocks: [(&str, &[&str], &[&str]); 6] = [
        ("animation", &ANIMATION_CALLS, &animation[..]),
        ("stream", &STREAM_CALLS, &stream),
        ("nav", &NAV_CALLS, &nav),
        ("input", &INPUT_CALLS, &input),
        ("assets", &ASSET_CALLS, &ASSET_REFUSALS),
        ("lod", &LOD_CALLS, &LOD_REFUSALS),
    ];
    for (key, calls, refusals) in blocks {
        assert_eq!(names(&pinned[key]["calls"]), calls, "{key} calls");
        assert_eq!(names(&pinned[key]["refusals"]), refusals, "{key} refusals");
    }
}

/// The net block (MP-4a): `sim.net`'s local refusals; its calls are pinned with the net page (MP-4b).
#[test]
fn the_net_block_is_the_fixtures() {
    let pinned = &fixture()["net"];
    let refusals: Vec<&str> = genex::net::NetErrorCode::ALL.iter().map(|code| code.wire()).collect();
    assert_eq!(names(&pinned["refusals"]), refusals);
    assert!(names(&pinned["calls"]).is_empty(), "the net calls are pinned with the net page");
}

/// The saves block (UIS-9): the calls the saves page teaches, genex-save's refusals, the volatile
/// issue, the slot states and the slot ops.
#[test]
fn the_saves_block_is_the_fixtures() {
    use genex::saves::{SAVE_CALLS, SAVE_RESTORE_DIVERGED, SaveErrorCode, SlotOp, SlotState};
    let pinned = &fixture()["saves"];
    assert_eq!(names(&pinned["calls"]), SAVE_CALLS);
    assert_eq!(names(&pinned["refusals"]), SaveErrorCode::ALL.map(SaveErrorCode::wire));
    assert_eq!(names(&pinned["issues"]), [SAVE_RESTORE_DIVERGED]);
    assert_eq!(names(&pinned["slotStates"]), SlotState::ALL.map(SlotState::wire));
    assert_eq!(names(&pinned["slotOps"]), SlotOp::ALL.map(SlotOp::wire));
}

/// The audio block (AU-9): the calls the audio page teaches and genex-audio's refusals.
#[test]
fn the_audio_block_is_the_fixtures() {
    use genex::audio::{AUDIO_CALLS, AudioErrorCode};
    let pinned = &fixture()["audio"];
    assert_eq!(names(&pinned["calls"]), AUDIO_CALLS);
    assert_eq!(names(&pinned["refusals"]), AudioErrorCode::ALL.map(AudioErrorCode::as_str));
}

/// The profile block (PROF-5): the calls the profiling page teaches, `volatile.profile`'s key and
/// fields, the engine scopes, the GPU sources and the node timing modes.
#[test]
fn the_profile_block_is_the_fixtures() {
    use genex::profile::{EngineScope, GpuTimeSource, NodeTiming, PROFILE_CALLS, SUMMARY_FIELDS, VOLATILE_PROFILE_KEY};
    let pinned = &fixture()["profile"];
    assert_eq!(names(&pinned["calls"]), PROFILE_CALLS);
    assert_eq!(pinned["volatileKey"], VOLATILE_PROFILE_KEY);
    assert_eq!(names(&pinned["summaryFields"]), SUMMARY_FIELDS);
    assert_eq!(names(&pinned["engineScopes"]), EngineScope::ALL.map(EngineScope::wire));
    assert_eq!(names(&pinned["gpuSources"]), GpuTimeSource::ALL.iter().map(|source| source.wire()).collect::<Vec<_>>());
    assert_eq!(names(&pinned["nodeTiming"]), NodeTiming::ALL.iter().map(|mode| mode.wire()).collect::<Vec<_>>());
}

#[test]
fn the_render_facts_are_the_fixtures() {
    use genex::present::{AssetIssueCode, TextureOrigin};
    use genex_render::texture::TextureFamily;
    let pinned = fixture();
    assert_eq!(names(&pinned["runtimeRender"]["keys"]), ["textures", "assetIssues"]);
    assert_eq!(names(&pinned["runtimeRender"]["issueCodes"]), AssetIssueCode::ALL.map(AssetIssueCode::wire));
    let families: Vec<&str> = TextureFamily::ALL.into_iter().map(|family| TextureOrigin::Family(family).wire()).chain([TextureOrigin::Source.wire()]).collect();
    assert_eq!(names(&pinned["runtimeRender"]["families"]), families);
}

/// The runtime's `genex_textures` reader (C-14) reads the importer's schema (C-13's writer).
#[test]
fn the_glb_texture_sidecar_reader_is_the_fixture_s_schema() {
    use genex_render::mesh::{GLB_TEXTURE_STEM_MAX_CHARS, GLB_TEXTURES_EXTRAS_KEY, GLB_TEXTURES_SCHEMA_VERSION, GlbTextureImageKey, GlbTextureUsage, GlbTexturesKey};
    let pinned = &fixture()["textures"];
    assert_eq!(pinned["extrasKey"], GLB_TEXTURES_EXTRAS_KEY);
    assert_eq!(pinned["schemaVersion"], GLB_TEXTURES_SCHEMA_VERSION);
    assert_eq!(names(&pinned["extrasKeys"]), GlbTexturesKey::ALL.map(GlbTexturesKey::wire));
    assert_eq!(names(&pinned["imageKeys"]), GlbTextureImageKey::ALL.map(GlbTextureImageKey::wire));
    assert_eq!(names(&pinned["kinds"]), GlbTextureUsage::ALL.map(GlbTextureUsage::wire));
    assert_eq!(pinned["stemMaxChars"], GLB_TEXTURE_STEM_MAX_CHARS);
}

/// The calls the fixture pins under `key`, checked against the names a chain below calls.
fn pinned_calls<'a>(pinned: &'a serde_json::Value, key: &str) -> Vec<&'a str> {
    names(&pinned[key]["calls"])
}

#[test]
fn the_probe_and_decal_calls_are_the_fixtures_and_each_is_a_call_of_the_facade() {
    use genex::render::{Decal, IrradianceVolume, ReflectionProbe};
    let pinned = fixture();
    assert_eq!(
        pinned_calls(&pinned, "probes"),
        ["frame.reflection_probe", "ReflectionProbe::new", ".with_capture", ".with_blend", "frame.irradiance_volume", "IrradianceVolume::new", ".with_cells"]
    );
    assert_eq!(pinned_calls(&pinned, "decals"), ["frame.decal", "Decal::on_wall", "Decal::on_ground", ".with_opacity", ".with_flatten", ".rotated"]);
    // Every pinned name is a real call, chained as GENEX_API.md teaches it.
    let (min, max) = (vec3(-4.0, 0.0, -4.0), vec3(4.0, 3.0, 4.0));
    let mut frame = Frame::new(Color::BLACK);
    frame
        .reflection_probe(&ReflectionProbe::new(min, max).with_capture(vec3(0.0, 1.6, 0.0)).with_blend(0.4))
        .irradiance_volume(&IrradianceVolume::new(min, max).with_cells([8, 3, 8]).with_blend(0.3))
        .decal(&Decal::on_wall(vec3(0.0, 1.5, -4.0), vec3(0.0, 0.0, 1.0), 1.0, 1.4).with_opacity(0.9))
        .decal(&Decal::on_ground(vec3(1.0, 0.0, 1.0), 2.0, 1.5).with_flatten(1.0).rotated(0.3));
    assert_eq!(frame.decals().len(), 2);
}

#[test]
fn the_grading_and_lens_calls_are_the_fixtures_and_each_is_a_call_of_the_facade() {
    use genex::render::{DepthOfField, Grading, GradingLut, GradingSection, MotionBlur, RenderConfig};
    let pinned = fixture();
    assert_eq!(
        pinned_calls(&pinned, "grading"),
        ["RenderConfig::from_build", ".grading", ".with_contrast", ".with_saturation", ".with_vibrance", ".with_lut", "GradingLut::parse_cube", ".temperature", ".white_balance", ".exposure_curve"]
    );
    assert_eq!(pinned_calls(&pinned, "lens"), [".depth_of_field", "DepthOfField::focused", ".motion_blur", "MotionBlur::shutter"]);
    let cube = GradingLut::identity(2).expect("an identity LUT").to_cube("identity");
    let lut = GradingLut::parse_cube(&cube).expect("a .cube LUT").intern().expect("an interned LUT");
    let grading = Grading::NEUTRAL.with_contrast(1.1).with_saturation(0.95).with_vibrance(1.1).with_lut(lut, 0.5);
    // A section's lift, gamma and gain are fields, as GENEX_API.md (Grading and the lens) sets them.
    let sections = Grading { shadows: GradingSection { lift: -0.01, ..GradingSection::NEUTRAL }, ..grading };
    assert!(sections.shadows.lift < 0.0);
    // A grade added in code keeps the genex.toml look: it starts from the [render] the build compiled in.
    let _config = RenderConfig::from_build()
        .grading(grading)
        .temperature(0.2, 0.0)
        .white_balance([1.0, 0.95, 0.9])
        .exposure_curve(&[(-8.0, -6.0), (0.0, 0.0)])
        .depth_of_field(DepthOfField::focused(3.0, 2.0))
        .motion_blur(MotionBlur::shutter(0.5));
}

#[test]
fn the_cloud_calls_are_the_fixture_s_and_each_is_a_call_of_the_facade() {
    use genex::render::{Clouds, Environment, SkyParams};
    assert_eq!(pinned_calls(&fixture(), "clouds"), [".with_clouds", "Clouds::default", ".with_coverage", ".with_layer", ".with_density", ".with_offset"]);
    let clouds = Clouds::default().with_coverage(0.5).with_layer(1.5, 2.5).with_density(1.0).with_offset([0.0, 0.0]);
    let mut frame = Frame::new(Color::BLACK);
    frame.environment(Environment::Sky(SkyParams::default().with_clouds(Some(clouds))));
}

#[test]
fn the_water_calls_are_the_fixture_s_and_each_is_a_call_of_the_facade() {
    use genex::render::Water;
    assert_eq!(pinned_calls(&fixture(), "water"), ["frame.water", "Water::lake", ".with_absorption", ".with_scatter", ".with_foam", ".with_ripple", ".with_refraction", "Water::drawn_at"]);
    let lake = Water::lake(genex::glam::Vec3::ZERO, genex::glam::Vec2::new(10.0, 8.0))
        .with_absorption([0.45, 0.09, 0.06])
        .with_scatter([0.02, 0.09, 0.08])
        .with_foam(0.12)
        .with_ripple(0.08, 0.08)
        .with_refraction(0.02);
    let mut frame = Frame::new(Color::BLACK);
    frame.water(&lake);
    assert_eq!(frame.drawn_water(), Some(&lake));
    // Where the renderer draws no water (an MSAA preset) a game may draw its own.
    let class = genex_render::device_class::DeviceClass::from_wire("desktop-high").expect("class");
    let preset = |preset| genex_render::presets::preset_quality(preset, class);
    assert!(Water::drawn_at(&preset(genex::render::QualityPreset::High)));
    assert!(!Water::drawn_at(&preset(genex::render::QualityPreset::Medium)));
}

#[test]
fn the_night_sky_and_subsurface_calls_are_the_fixtures_and_each_is_a_call_of_the_facade() {
    use genex::Subsurface;
    use genex::render::{Environment, Moon, SkyMedium, SkyParams};
    let pinned = fixture();
    assert_eq!(
        pinned_calls(&pinned, "nightSky"),
        [".with_stars", ".with_moon", "Moon::new", ".with_moonlight", ".with_medium", "SkyMedium::mars", "SkyMedium::earth"]
    );
    assert_eq!(pinned_calls(&pinned, "subsurface"), [".with_subsurface", "Subsurface::new", ".with_transmission"]);
    let sky = SkyParams::default().with_stars(2e-5).with_moon(Some(Moon::new([-0.3, 0.6, 0.7]).with_moonlight(0.004))).with_medium(SkyMedium::mars());
    let _earth = SkyParams::default().with_medium(SkyMedium::earth());
    let mut frame = Frame::new(Color::BLACK);
    frame.environment(Environment::Sky(sky));
    let leaf = Material::color(Color::rgb(60, 110, 30)).with_subsurface(Subsurface::new([0.2, 0.3, 0.05], 0.15).with_transmission(0.6));
    assert!(leaf.subsurface().is_some());
}
