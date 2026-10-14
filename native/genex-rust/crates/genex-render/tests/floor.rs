//! The WebGPU-core adapter floor: an adapter below it is refused `gpu-unsupported` before any
//! device is requested, and the capability receipt records tier core plus the offered
//! native-enhanced features without requesting them. The renderer-owned optional features
//! (`TIMESTAMP_QUERY`, `RG11B10UFLOAT_RENDERABLE`) are requested when offered, listed apart as
//! `rendererFeatures`, and never widen what a game's WGSL may use.

use std::cell::Cell;

use genex_render::extension::{ExtensionContext, ExtensionKind, validate};
use genex_render::floor::{
    AdapterFacts, GpuAdapter, INSTANCE_BACKENDS, NATIVE_ENHANCED_FEATURES, RENDERER_FEATURES, Tier, UnsupportedReason, check_floor,
    open_device, open_device_with,
};
use genex_render::{RenderCode, RenderError};
use wgpu::{Backend, Backends, DownlevelCapabilities, DownlevelFlags, Features, Limits};

/// A test double: facts chosen by the test, and a record of device requests.
struct FakeAdapter {
    facts: AdapterFacts,
    opened: Cell<u32>,
    requested_limits: Cell<Option<Limits>>,
    requested_features: Cell<Option<Features>>,
}

impl FakeAdapter {
    fn new(facts: AdapterFacts) -> FakeAdapter {
        FakeAdapter { facts, opened: Cell::new(0), requested_limits: Cell::new(None), requested_features: Cell::new(None) }
    }
}

impl GpuAdapter for FakeAdapter {
    type Device = &'static str;

    fn facts(&self) -> AdapterFacts {
        self.facts.clone()
    }

    fn open(&self, limits: &Limits, features: Features) -> Result<Self::Device, RenderError> {
        self.opened.set(self.opened.get() + 1);
        self.requested_limits.set(Some(limits.clone()));
        self.requested_features.set(Some(features));
        Ok("device")
    }
}

fn compliant() -> AdapterFacts {
    AdapterFacts {
        name: "fake gpu".to_owned(),
        backend: Backend::Metal,
        limits: Limits::defaults(),
        downlevel: DownlevelCapabilities::default(),
        features: Features::empty(),
    }
}

fn refused_reason(facts: AdapterFacts) -> (UnsupportedReason, u32) {
    let adapter = FakeAdapter::new(facts);
    let error = open_device(&adapter).expect_err("an adapter below WebGPU core is refused");
    assert_eq!(error.code(), RenderCode::GpuUnsupported);
    assert_eq!(error.code().wire(), "gpu-unsupported");
    let RenderError::GpuUnsupported { reason, .. } = error else { panic!("not gpu-unsupported: {error:?}") };
    (reason, adapter.opened.get())
}

#[test]
fn a_compliant_adapter_opens_with_webgpu_default_limits_and_no_features() {
    let mut facts = compliant();
    facts.limits.max_texture_dimension_2d = 16_384;
    facts.features = Features::SUBGROUP | Features::MULTI_DRAW_INDIRECT_COUNT;
    let adapter = FakeAdapter::new(facts);
    let (device, receipt) = open_device(&adapter).expect("a compliant adapter opens");
    assert_eq!(device, "device");
    assert_eq!(adapter.opened.get(), 1);
    assert_eq!(adapter.requested_limits.take(), Some(Limits::defaults()), "the device never exceeds web limits");
    assert_eq!(adapter.requested_features.take(), Some(Features::empty()), "native-enhanced features are never requested");
    assert_eq!(receipt.tier, Tier::Core);
    assert_eq!(receipt.tier.wire(), "core");
    assert_eq!(receipt.backend, "metal");
    assert_eq!(receipt.adapter, "fake gpu");
    assert_eq!(receipt.native_enhanced, vec!["subgroup", "multi-draw-indirect-count"]);
}

#[test]
fn a_game_that_declares_native_features_gets_exactly_those_or_native_feature_missing() {
    let mut facts = compliant();
    facts.features = Features::SUBGROUP | Features::MULTI_DRAW_INDIRECT_COUNT;
    let adapter = FakeAdapter::new(facts.clone());
    let (_, receipt) = open_device_with(&adapter, Features::SUBGROUP).expect("an offered feature opens");
    assert_eq!(adapter.requested_features.take(), Some(Features::SUBGROUP), "only the declared feature, never the other offered one");
    assert_eq!(receipt.native_enhanced, vec!["subgroup", "multi-draw-indirect-count"]);
    facts.features = Features::MULTI_DRAW_INDIRECT_COUNT;
    let lacking = FakeAdapter::new(facts);
    let error = open_device_with(&lacking, Features::SUBGROUP).expect_err("a declared feature the adapter lacks is refused");
    assert_eq!(error.code(), RenderCode::NativeFeatureMissing);
    assert!(error.to_string().contains("subgroup"), "{error}");
    assert_eq!(lacking.opened.get(), 0, "no device is requested");
}

#[test]
fn an_adapter_that_is_not_webgpu_compliant_is_refused_before_a_device_is_requested() {
    let mut facts = compliant();
    facts.downlevel.flags.remove(DownlevelFlags::COMPUTE_SHADERS);
    let (reason, opened) = refused_reason(facts);
    assert_eq!(reason, UnsupportedReason::NotWebGpuCompliant);
    assert_eq!(opened, 0);
}

#[test]
fn an_adapter_below_default_limits_is_refused_before_a_device_is_requested() {
    type Lower = fn(&mut Limits);
    let hostile: [(&str, Lower); 5] = [
        ("max_storage_buffers_per_shader_stage", |l| l.max_storage_buffers_per_shader_stage = 4),
        ("max_compute_workgroup_size_x", |l| l.max_compute_workgroup_size_x = 64),
        ("max_texture_dimension_2d", |l| l.max_texture_dimension_2d = 4096),
        ("max_storage_buffer_binding_size", |l| l.max_storage_buffer_binding_size = 1 << 20),
        ("max_bind_groups", |l| l.max_bind_groups = 2),
    ];
    for (name, lower) in hostile {
        let mut facts = compliant();
        lower(&mut facts.limits);
        let (reason, opened) = refused_reason(facts);
        assert_eq!(reason, UnsupportedReason::LimitBelowCore { limit: name.to_owned() }, "{name}");
        assert_eq!(opened, 0, "{name}: no device is requested");
    }
}

#[test]
fn a_gl_or_noop_backend_is_refused_even_when_its_limits_pass() {
    for backend in [Backend::Gl, Backend::Noop] {
        let mut facts = compliant();
        facts.backend = backend;
        let (reason, opened) = refused_reason(facts);
        assert_eq!(reason, UnsupportedReason::Backend);
        assert_eq!(opened, 0);
    }
}

#[test]
fn check_floor_accepts_better_than_default_limits() {
    let mut facts = compliant();
    facts.limits.max_texture_dimension_2d = 16_384;
    facts.limits.max_storage_buffer_binding_size = 1 << 30;
    assert_eq!(check_floor(&facts), Ok(()));
}

#[test]
fn the_instance_requests_only_webgpu_class_backends_and_this_build_has_no_gl() {
    assert!(!INSTANCE_BACKENDS.intersects(Backends::GL), "no GL backend is requested");
    assert!(!wgpu::Instance::enabled_backend_features().contains(Backends::GL), "no wgpu GL cargo feature is built");
    if cfg!(target_os = "windows") {
        assert_eq!(INSTANCE_BACKENDS, Backends::DX12, "a Windows game draws on D3D12 alone");
    } else if cfg!(not(target_arch = "wasm32")) {
        assert_eq!(INSTANCE_BACKENDS, Backends::METAL | Backends::VULKAN | Backends::DX12);
    }
}

#[test]
fn the_native_enhanced_table_names_the_plan_features_and_none_is_a_webgpu_feature() {
    let names: Vec<&str> = NATIVE_ENHANCED_FEATURES.iter().map(|(_, name)| *name).collect();
    assert_eq!(
        names,
        vec![
            "shader-int64-atomic-min-max",
            "shader-int64-atomic-all-ops",
            "subgroup",
            "ray-query",
            "mesh-shader",
            "texture-binding-array",
            "multi-draw-indirect-count",
        ]
    );
    for (feature, name) in NATIVE_ENHANCED_FEATURES {
        assert!(!Features::all_webgpu_mask().intersects(*feature), "{name} is native-only");
    }
}

/// The default material's fragment: needs nothing beyond WebGPU core.
const PLAIN_MATERIAL: &str = "@fragment\nfn fs_material(in: GxMaterialIn) -> @location(0) vec4<f32> {\n    return vec4<f32>(in.tint.rgb, 1.0);\n}\n";

#[test]
fn the_renderer_owned_table_names_webgpu_optional_features_disjoint_from_native_enhanced() {
    let names: Vec<&str> = RENDERER_FEATURES.iter().map(|(_, name)| *name).collect();
    assert_eq!(names, vec!["timestamp-query", "rg11b10ufloat-renderable", "depth-clip-control"]);
    for (feature, name) in RENDERER_FEATURES {
        assert!(Features::all_webgpu_mask().contains(*feature), "{name} is a WebGPU optional feature, so the web may offer it");
        assert!(!NATIVE_ENHANCED_FEATURES.iter().any(|(native, _)| native.intersects(*feature)), "{name} is not native-enhanced");
    }
}

#[test]
fn an_adapter_offering_timestamp_queries_opens_with_them_and_lists_them_as_renderer_features() {
    let mut facts = compliant();
    facts.features = Features::TIMESTAMP_QUERY | Features::SUBGROUP;
    let adapter = FakeAdapter::new(facts);
    let (_, receipt) = open_device(&adapter).expect("a compliant adapter opens");
    assert_eq!(adapter.requested_features.take(), Some(Features::TIMESTAMP_QUERY), "the renderer-owned feature, never the undeclared native one");
    assert_eq!(adapter.requested_limits.take(), Some(Limits::defaults()), "limits stay core");
    assert_eq!(receipt.renderer_features, vec!["timestamp-query"]);
    assert_eq!(receipt.native_enhanced, vec!["subgroup"]);
    let json: serde_json::Value = serde_json::from_str(&receipt.to_json()).expect("receipt json");
    assert_eq!(json["rendererFeatures"], serde_json::json!(["timestamp-query"]));
    assert_eq!(json["nativeEnhanced"], serde_json::json!(["subgroup"]));
}

#[test]
fn renderer_features_join_the_games_declared_ones_and_are_skipped_when_not_offered() {
    let mut facts = compliant();
    facts.features = Features::TIMESTAMP_QUERY | Features::RG11B10UFLOAT_RENDERABLE | Features::SUBGROUP;
    let adapter = FakeAdapter::new(facts);
    let (_, receipt) = open_device_with(&adapter, Features::SUBGROUP).expect("opens");
    assert_eq!(
        adapter.requested_features.take(),
        Some(Features::SUBGROUP | Features::TIMESTAMP_QUERY | Features::RG11B10UFLOAT_RENDERABLE)
    );
    assert_eq!(receipt.renderer_features, vec!["timestamp-query", "rg11b10ufloat-renderable"]);
    let bare = FakeAdapter::new(compliant());
    let (_, receipt) = open_device(&bare).expect("opens");
    assert_eq!(bare.requested_features.take(), Some(Features::empty()), "nothing optional is asked of an adapter without it");
    assert!(receipt.renderer_features.is_empty());
    let json: serde_json::Value = serde_json::from_str(&receipt.to_json()).expect("receipt json");
    assert_eq!(json["rendererFeatures"], serde_json::json!([]));
}

#[test]
fn renderer_owned_features_never_become_usable_by_game_wgsl() {
    let offered = Features::TIMESTAMP_QUERY | Features::RG11B10UFLOAT_RENDERABLE;
    for declared in [Features::empty(), Features::TIMESTAMP_QUERY, offered] {
        let context = ExtensionContext::new(declared, offered);
        assert!(context.usable().is_empty(), "{declared:?}: a renderer feature is never the game's to use");
        assert_eq!(context.check_device(), Ok(()), "{declared:?}: nothing native is missing");
        let admitted = validate(ExtensionKind::Material, PLAIN_MATERIAL, &context).expect("a core material still validates");
        assert_eq!(admitted.native_features(), Features::empty());
    }
    let with_subgroup = ExtensionContext::new(Features::SUBGROUP, offered | Features::SUBGROUP);
    assert_eq!(with_subgroup.usable(), Features::SUBGROUP, "usable stays declared ∩ offered native-enhanced features");
}
