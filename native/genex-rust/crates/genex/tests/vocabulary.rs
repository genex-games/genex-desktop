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
