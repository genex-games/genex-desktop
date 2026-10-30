//! The look facts and the exposure telemetry a capture writes have the shape of the contract in
//! `src/shared/render-look.ts`, held by the fixture `tests/fixtures/render-look-v1.json`. It lives here,
//! not beside the code, because an ejected game's fork stages a crate's sources and never its `tests/`.

use genex::look_facts::{exposure_value, DrawnLook, ExposureTrace, LookFacts, TagFacts};
use genex_render::look_features::LookFeature;
use genex_render::post::exposure::ExposureTelemetry;

#[test]
fn the_value_is_the_contract_s_shape() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!("../../../../../tests/fixtures/render-look-v1.json")).expect("fixture");
    let facts = LookFacts {
        grid: [160, 90],
        coverage: 0.82,
        flat_coverage: 0.031,
        tags: vec![
            TagFacts { name: "bench".into(), coverage: 0.04, flat_coverage: 0.031, texels_per_metre: None, pixels_per_metre: Some(640.0), triangles_per_square_metre: Some(2.5), normal_map_share: 0.0, orm_share: 0.0, alpha_card_share: 0.0, draws: 12, models: Vec::new(), primitive_only: true },
            TagFacts { name: "walls".into(), coverage: 0.61, flat_coverage: 0.0, texels_per_metre: Some(1365.3), pixels_per_metre: Some(212.4), triangles_per_square_metre: Some(0.5), normal_map_share: 1.0, orm_share: 1.0, alpha_card_share: 0.0, draws: 40, models: vec!["models/wall_kit.glb".into()], primitive_only: false },
        ],
        // An ultra frame with every look feature but the lens's two.
        drawn: Some(DrawnLook {
            preset: "ultra",
            features: LookFeature::ALL.map(|feature| (feature.wire(), !matches!(feature, LookFeature::DepthOfField | LookFeature::MotionBlur))).to_vec(),
        }),
    };
    let written: serde_json::Value = serde_json::from_slice(&facts.to_value().dump()).expect("JSON");
    assert_eq!(written, fixture["look"]);
    let mut histogram = vec![0.0_f32; 16];
    for (bin, share) in [(4, 0.05), (5, 0.3), (6, 0.4), (7, 0.15), (8, 0.06), (9, 0.03), (10, 0.01)] {
        histogram[bin] = share;
    }
    let telemetry = ExposureTelemetry {
        auto: true,
        metered_ev: Some(-2.75),
        target_ev: Some(-2.75),
        applied_ev: -2.5,
        compensation: 0.5,
        ev_min: -8.0,
        ev_max: 8.0,
        histogram,
        doorway_boost: false,
        age_frames: 2,
        reading: Some(5),
        warnings: Vec::new(),
    };
    let mut trace = ExposureTrace::default();
    trace.note(1.0, &telemetry);
    let written: serde_json::Value = serde_json::from_slice(&trace.to_value().expect("a point").dump()).expect("JSON");
    assert_eq!(written, fixture["exposureTrace"]);
    let written: serde_json::Value = serde_json::from_slice(&exposure_value(&telemetry).dump()).expect("JSON");
    assert_eq!(written, fixture["exposure"]);
}
