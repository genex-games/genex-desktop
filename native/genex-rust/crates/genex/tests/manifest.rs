//! The `genex.toml` schema: what a game folder may declare, read as data and refused with typed
//! codes. The host's TypeScript reader (M2.2) mirrors these rows.

use genex::manifest::{
    self, DeviceClass, ExposureMode, FormFactor, ManifestErrorCode, Metering, NativeFeature, QualityPreset, RenderFeature,
    Tonemapper, WgslKind,
};

const FULL: &str = r#"
[game]
title = "Pond"
world_size = [960, 540]
save_name = "pond-1"

[crates]
noise = "0.9"

[[wgsl]]
path = "shaders/water.wgsl"
kind = "material"

[[wgsl]]
path = "shaders/bloom.wgsl"
kind = "post"

[gpu]
native_features = ["subgroup"]
"#;

#[test]
fn a_full_manifest_parses() {
    let parsed = manifest::parse(FULL).expect("valid");
    assert_eq!(parsed.game.title, "Pond");
    assert_eq!(parsed.game.world_size, [960, 540]);
    assert_eq!(parsed.game.save_name.as_deref(), Some("pond-1"));
    assert_eq!(parsed.crates.get("noise").map(String::as_str), Some("0.9"));
    assert_eq!(parsed.wgsl.iter().map(|w| w.kind).collect::<Vec<_>>(), [WgslKind::Material, WgslKind::Post]);
    assert_eq!(parsed.gpu.native_features, [NativeFeature::Subgroup]);
    assert!(parsed.needs_native_features());
}

/// G6 MP-5b: a networked game's genex.toml parses, so the runtime's own read (WGSL extensions)
/// never refuses it; the host owns the value checks (`invalid-net`).
#[test]
fn a_net_table_and_its_matchmaking_parse() {
    let text = "[game]\ntitle = \"Tag\"\n\n[net]\nenabled = true\n\n[net.matchmaking]\npreset = \"arena\"\n\
                win_condition = \"firstToScore\"\n\n[net.matchmaking.config]\nmaxPlayers = 8\nfill = 0.5\n";
    let parsed = manifest::parse(text).expect("a [net] table parses");
    let net = parsed.net.expect("the [net] table");
    assert!(net.enabled);
    let matchmaking = net.matchmaking.expect("the matchmaking table");
    assert_eq!(matchmaking.preset, "arena");
    assert_eq!(matchmaking.win_condition.as_deref(), Some("firstToScore"));
    assert_eq!(matchmaking.config.get("maxPlayers"), Some(&8.0));
    assert!(manifest::parse("[game]\ntitle = \"Tag\"\n").expect("no [net]").net.is_none());
    let unknown = manifest::parse("[game]\ntitle = \"Tag\"\n\n[net]\nenabled = true\nrelay = \"x\"\n");
    assert_eq!(unknown.map_err(|error| error.code()), Err(ManifestErrorCode::Syntax));
}

#[test]
fn a_minimal_manifest_takes_the_defaults() {
    let parsed = manifest::parse("[game]\ntitle = \"Tiny\"\n").expect("valid");
    assert_eq!(parsed.game.world_size, [960, 540]);
    assert!(parsed.crates.is_empty() && parsed.wgsl.is_empty());
    assert!(!parsed.needs_native_features());
}

#[test]
fn every_native_feature_has_one_wire_name() {
    for feature in NativeFeature::ALL {
        let text = format!("[game]\ntitle = \"T\"\n[gpu]\nnative_features = [\"{}\"]\n", feature.as_str());
        assert_eq!(manifest::parse(&text).expect("valid").gpu.native_features, [*feature]);
    }
}

#[test]
fn hostile_and_malformed_manifests_are_refused_with_typed_codes() {
    let game = "[game]\ntitle = \"T\"\n";
    let rows: Vec<(&str, String, ManifestErrorCode)> = vec![
        ("not toml", "[game".into(), ManifestErrorCode::Syntax),
        ("unknown top-level key", format!("{game}[cargo]\nx = 1\n"), ManifestErrorCode::Syntax),
        ("unknown game key", "[game]\ntitle = \"T\"\nbuild = \"x\"\n".into(), ManifestErrorCode::Syntax),
        ("missing title", "[game]\nworld_size = [1, 1]\n".into(), ManifestErrorCode::Syntax),
        ("empty title", "[game]\ntitle = \" \"\n".into(), ManifestErrorCode::InvalidTitle),
        ("zero size", "[game]\ntitle = \"T\"\nworld_size = [0, 540]\n".into(), ManifestErrorCode::InvalidWorldSize),
        ("huge size", "[game]\ntitle = \"T\"\nworld_size = [960, 9000]\n".into(), ManifestErrorCode::InvalidWorldSize),
        ("size below MIN_WORLD_PX", "[game]\ntitle = \"T\"\nworld_size = [32, 32]\n".into(), ManifestErrorCode::InvalidWorldSize),
        ("size above the host's 4096", "[game]\ntitle = \"T\"\nworld_size = [8192, 4608]\n".into(), ManifestErrorCode::InvalidWorldSize),
        ("save name with a slash", "[game]\ntitle = \"T\"\nsave_name = \"a/b\"\n".into(), ManifestErrorCode::InvalidSaveName),
        ("save name dot-dot", "[game]\ntitle = \"T\"\nsave_name = \"..\"\n".into(), ManifestErrorCode::InvalidSaveName),
        ("crate off the allowlist", format!("{game}[crates]\nreqwest = \"0.12\"\n"), ManifestErrorCode::CrateNotAllowlisted),
        ("crate off the allowlist at a caret pin", format!("{game}[crates]\ntidy = \"^1.0.0\"\n"), ManifestErrorCode::CrateNotAllowlisted),
        ("crate off the allowlist at a partial pin", format!("{game}[crates]\ntidy = \"=1.0\"\n"), ManifestErrorCode::CrateNotAllowlisted),
        ("pinned crate with a path in its name", format!("{game}[crates]\n\"../tidy\" = \"=1.0.0\"\n"), ManifestErrorCode::CrateNotAllowlisted),
        ("allowlisted crate with a wildcard", format!("{game}[crates]\nnoise = \"*\"\n"), ManifestErrorCode::InvalidCrateVersion),
        ("allowlisted crate with a range", format!("{game}[crates]\nnoise = \">=0.9, <1\"\n"), ManifestErrorCode::InvalidCrateVersion),
        ("crate request with a requirement", request(game, "tidy", "^1.0", None), ManifestErrorCode::InvalidCrateRequest),
        ("crate request with a climbing name", request(game, "../tidy", "1.0.0", None), ManifestErrorCode::InvalidCrateRequest),
        ("crate request with a shell word", request(game, "tidy", "1.0.0; rm -rf /", None), ManifestErrorCode::InvalidCrateRequest),
        ("crate request with an overlong reason", request(game, "tidy", "1.0.0", Some(&"r".repeat(501))), ManifestErrorCode::InvalidCrateRequest),
        (
            "the same crate request twice",
            format!("{}{}", request(game, "tidy", "1.0.0", None), request("", "tidy", "1.0.0", None)),
            ManifestErrorCode::InvalidCrateRequest,
        ),
        ("crate request with an unknown key", format!("{game}[[crate_request]]\nname = \"tidy\"\nversion = \"1.0.0\"\napprove = true\n"), ManifestErrorCode::Syntax),
        ("allowlisted crate with a path", format!("{game}[crates]\nnoise = {{ path = \"../x\" }}\n"), ManifestErrorCode::Syntax),
        ("wgsl parent escape", wgsl(game, "../x.wgsl"), ManifestErrorCode::InvalidWgslPath),
        ("wgsl absolute", wgsl(game, "/etc/x.wgsl"), ManifestErrorCode::InvalidWgslPath),
        ("wgsl backslash", wgsl(game, "shaders\\x.wgsl"), ManifestErrorCode::InvalidWgslPath),
        ("wgsl home", wgsl(game, "~/x.wgsl"), ManifestErrorCode::InvalidWgslPath),
        ("wgsl not .wgsl", wgsl(game, "shaders/x.glsl"), ManifestErrorCode::InvalidWgslPath),
        ("wgsl dot segment", wgsl(game, "shaders/./x.wgsl"), ManifestErrorCode::InvalidWgslPath),
        ("wgsl duplicate", format!("{}{}", wgsl(game, "a.wgsl"), wgsl("", "a.wgsl")), ManifestErrorCode::DuplicateWgslPath),
        ("unknown native feature", format!("{game}[gpu]\nnative_features = [\"webgl\"]\n"), ManifestErrorCode::Syntax),
        (
            "duplicate native feature",
            format!("{game}[gpu]\nnative_features = [\"subgroup\", \"subgroup\"]\n"),
            ManifestErrorCode::DuplicateNativeFeature,
        ),
    ];
    for (name, text, code) in rows {
        let error = manifest::parse(&text).err().unwrap_or_else(|| panic!("{name}: expected {code:?}"));
        assert_eq!(error.code(), code, "{name}: {error}");
    }
}

#[test]
fn a_crate_the_person_approved_and_a_crate_request_parse_as_the_host_reads_them() {
    let text = format!(
        "[game]\ntitle = \"T\"\n[crates]\nnoise = \"0.9\"\ntidy = \"=1.0.0\"\nrand_pcg = \"=0.3.1-beta.2\"\n{}",
        request("", "hecs", "0.10.5", Some("an entity store")),
    );
    let parsed = manifest::parse(&text).expect("valid");
    assert_eq!(parsed.crates.get("tidy").map(String::as_str), Some("=1.0.0"));
    assert_eq!(parsed.crates.get("rand_pcg").map(String::as_str), Some("=0.3.1-beta.2"));
    let [row] = parsed.crate_request.as_slice() else { panic!("one request row") };
    assert_eq!((row.name.as_str(), row.version.as_str()), ("hecs", "0.10.5"));
    assert_eq!(row.reason.as_deref(), Some("an entity store"));
}

/// Lane EF: `[game] fit` is letterbox unless the game says expand; any other value, a wrong case or
/// type among them, is refused `invalid-fit` (the host's reader holds the same rows).
#[test]
fn the_fit_is_letterbox_unless_the_game_says_expand() {
    let fit = |text: &str| manifest::parse(&format!("[game]\ntitle = \"T\"\n{text}")).map(|parsed| parsed.game.fit());
    assert_eq!(fit("").ok(), Some(genex::Fit::Letterbox), "absent: letterbox");
    assert_eq!(fit("fit = \"letterbox\"\n").ok(), Some(genex::Fit::Letterbox));
    assert_eq!(fit("fit = \"expand\"\n").ok(), Some(genex::Fit::Expand));
    for hostile in ["\"Expand\"", "\"\"", "\"stretch\"", "\"expand \"", "\"letterbox\\u0000\"", "\"../expand\""] {
        let code = fit(&format!("fit = {hostile}\n")).err().map(|error| error.code());
        assert_eq!(code, Some(ManifestErrorCode::InvalidFit), "{hostile}");
    }
    for wrong_type in ["1", "true", "[\"expand\"]"] {
        let code = fit(&format!("fit = {wrong_type}\n")).err().map(|error| error.code());
        assert_eq!(code, Some(ManifestErrorCode::Syntax), "{wrong_type}");
    }
    assert_eq!(ManifestErrorCode::InvalidFit.as_str(), "invalid-fit");
}

#[test]
fn the_crate_codes_keep_the_hosts_wire_spellings() {
    assert_eq!(ManifestErrorCode::InvalidCrateVersion.as_str(), "invalid-crate-version");
    assert_eq!(ManifestErrorCode::InvalidCrateRequest.as_str(), "invalid-crate-request");
}

/// The crates a game names without approval, the one table the host holds too (release R-2).
#[test]
fn the_crate_allowlist_is_the_fixtures() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/game-crate-allowlist.json");
    let fixture: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path).expect("the fixture")).expect("the fixture is JSON");
    let crates: Vec<&str> =
        fixture["crates"].as_array().expect("crates").iter().map(|c| c.as_str().expect("a name")).collect();
    assert_eq!(crates, manifest::GAME_CRATE_ALLOWLIST.to_vec());
}

fn request(prefix: &str, name: &str, version: &str, reason: Option<&str>) -> String {
    let reason = reason.map(|reason| format!("reason = '{reason}'\n")).unwrap_or_default();
    format!("{prefix}[[crate_request]]\nname = '{name}'\nversion = '{version}'\n{reason}")
}

fn wgsl(prefix: &str, path: &str) -> String {
    format!("{prefix}[[wgsl]]\npath = '{path}'\nkind = \"material\"\n")
}

/// The `[render]` and `[[wgsl]] api` rows the host's reader shares (`tests/fixtures/genex-toml-render.json`).
fn render_rows() -> serde_json::Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/genex-toml-render.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("the fixture")).expect("the fixture is JSON")
}

/// The wire fixture's render vocabulary, which the host's `src/shared/render-quality.ts` holds too.
fn wire_render() -> serde_json::Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/native-wire-v2.json");
    let wire: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path).expect("the fixture")).expect("the fixture is JSON");
    wire["render"].clone()
}

fn text_of(row: &serde_json::Value, field: &str) -> String {
    row[field].as_str().unwrap_or_else(|| panic!("a row's {field}")).to_owned()
}

#[test]
fn the_render_rows_the_host_reads_are_read_alike() {
    let rows = render_rows();
    let game = text_of(&rows, "game");
    for row in rows["accepted"].as_array().expect("accepted rows") {
        let text = format!("{game}{}", text_of(row, "text"));
        if let Err(error) = manifest::parse(&text) {
            panic!("{}: refused {error}", text_of(row, "name"));
        }
    }
    for row in rows["hostile"].as_array().expect("hostile rows") {
        let name = text_of(row, "name");
        let text = format!("{game}{}", text_of(row, "text"));
        let error = manifest::parse(&text).err().unwrap_or_else(|| panic!("{name}: accepted"));
        assert_eq!(error.code().as_str(), text_of(row, "code"), "{name}: {error}");
    }
}

// Owner decision 2026-10-11: a browser game names its own code budget in MB of gzip (the host
// warns past it and refuses only past the 32 MB ceiling); a manifest that names none has none.
#[test]
fn the_web_budget_reads_as_the_games_own_and_is_absent_when_unnamed() {
    let parsed = manifest::parse("[game]\ntitle = \"T\"\n[web]\nwasm_budget_mb = 12\n").expect("valid");
    assert_eq!(parsed.web.wasm_budget_mb, Some(12));
    assert_eq!(manifest::parse("[game]\ntitle = \"T\"\n").expect("valid").web.wasm_budget_mb, None);
    let over = manifest::parse("[game]\ntitle = \"T\"\n[web]\nwasm_budget_mb = 33\n").expect_err("past the ceiling");
    assert_eq!(over.code(), ManifestErrorCode::InvalidWebBudget);
}

#[test]
fn the_documented_render_table_reads_into_typed_settings() {
    let rows = render_rows();
    let text = format!("{}{}", text_of(&rows, "game"), text_of(&rows["accepted"][0], "text"));
    let parsed = manifest::parse(&text).expect("valid");
    let render = &parsed.render;
    assert_eq!(render.form_factors(), [FormFactor::Desktop, FormFactor::Mobile]);
    assert_eq!(render.preset(), Some(QualityPreset::Auto));
    assert_eq!(render.look.tonemapper(), Some(Tonemapper::Agx));
    assert_eq!(render.look.exposure(), Some(ExposureMode::Auto));
    assert_eq!(render.look.metering(), Some(Metering::Center));
    assert_eq!(render.look.ev_compensation, Some(-0.5));
    assert_eq!(render.look.bloom_intensity, Some(0.04));
    let classes = render.classes();
    let class = |wanted: DeviceClass| classes.iter().find(|(name, _)| *name == wanted).map(|(_, class)| *class);
    assert_eq!(classes.len(), 2);
    let mobile = class(DeviceClass::MobileMid).expect("mobile-mid");
    assert_eq!(mobile.preset(), Some(QualityPreset::Low));
    assert_eq!((mobile.render_scale, mobile.fps), (Some(0.67), Some(30)));
    let mut switches = mobile.switches();
    switches.sort_by_key(|(feature, _)| feature.as_str());
    assert_eq!(switches, [(RenderFeature::Ao, false), (RenderFeature::Bloom, false)]);
    let mut switches = class(DeviceClass::DesktopUltra).expect("desktop-ultra").switches();
    switches.sort_by_key(|(feature, _)| feature.as_str());
    assert_eq!(switches, [(RenderFeature::ContactShadows, true), (RenderFeature::Taa, true)]);
    assert_eq!(parsed.wgsl.len(), 0);
}

#[test]
fn a_wgsl_source_records_its_extension_api() {
    let parsed = manifest::parse(&wgsl("[game]\ntitle = \"T\"\n", "a.wgsl")).expect("valid");
    assert_eq!(parsed.wgsl[0].api, 1, "a row that names none is api 1");
    assert!(manifest::parse("[game]\ntitle = \"T\"\n").expect("valid").render == manifest::RenderSection::default());
}

#[test]
fn the_render_vocabulary_is_the_wires() {
    let wire = wire_render();
    let names = |key: &str| -> Vec<String> {
        wire[key].as_array().expect(key).iter().map(|item| item.as_str().expect(key).to_owned()).collect()
    };
    let wires = |all: Vec<&'static str>| -> Vec<String> { all.into_iter().map(str::to_owned).collect() };
    assert_eq!(names("presets"), wires(QualityPreset::ALL.iter().map(|value| value.as_str()).collect()));
    assert_eq!(names("formFactors"), wires(FormFactor::ALL.iter().map(|value| value.as_str()).collect()));
    assert_eq!(names("deviceClasses"), wires(DeviceClass::ALL.iter().map(|value| value.as_str()).collect()));
    assert_eq!(names("features"), wires(RenderFeature::ALL.iter().map(|value| value.as_str()).collect()));
    assert_eq!(names("tonemappers"), wires(Tonemapper::ALL.iter().map(|value| value.as_str()).collect()));
    assert_eq!(names("exposureModes"), wires(ExposureMode::ALL.iter().map(|value| value.as_str()).collect()));
    assert_eq!(names("metering"), wires(Metering::ALL.iter().map(|value| value.as_str()).collect()));
    assert_eq!(wire["renderScale"]["min"].as_f64(), Some(manifest::RENDER_SCALE_MIN));
    assert_eq!(wire["renderScale"]["max"].as_f64(), Some(manifest::RENDER_SCALE_MAX));
    let integers = |key: &str| -> Vec<i64> {
        wire[key].as_array().expect(key).iter().filter_map(serde_json::Value::as_i64).collect()
    };
    let fps = integers("fpsTargets");
    assert_eq!(fps, manifest::RENDER_FPS_TARGETS);
    assert_eq!(wire["evCompensationLimit"].as_f64(), Some(manifest::EV_COMPENSATION_LIMIT));
    assert_eq!(wire["bloomIntensityMax"].as_f64(), Some(manifest::BLOOM_INTENSITY_MAX));
    assert_eq!(integers("wgslApis"), manifest::WGSL_EXTENSION_APIS);
    assert_eq!(names("lookKeys"), wires(manifest::LOOK_KEYS.to_vec()));
    // RQ3 review: `[render.shadows]`.
    assert_eq!(names("shadowKeys"), wires(manifest::SHADOW_KEYS.to_vec()));
    assert_eq!(wire["shadowDistance"]["min"].as_i64(), Some(manifest::SHADOW_DISTANCE_MIN));
    assert_eq!(wire["shadowDistance"]["max"].as_i64(), Some(manifest::SHADOW_DISTANCE_MAX));
    assert_eq!(wire["shadowBlendBandMax"].as_f64(), Some(manifest::SHADOW_BLEND_BAND_MAX));
    // Game systems LOD-06: the class tables' LOD ranges.
    assert_eq!(wire["lodThresholdPx"]["min"].as_f64(), Some(manifest::LOD_THRESHOLD_PX_MIN));
    assert_eq!(wire["lodThresholdPx"]["max"].as_f64(), Some(manifest::LOD_THRESHOLD_PX_MAX));
    assert_eq!(wire["lodFadeBandMax"].as_f64(), Some(manifest::LOD_FADE_BAND_MAX));
    assert_eq!(wire["farDensityMin"].as_f64(), Some(manifest::FAR_DENSITY_MIN));
    assert_eq!(manifest::FAR_DENSITY_MIN as f32, genex_render::settings::FAR_DENSITY_MIN, "the file's floor is the renderer's");
    assert_eq!(wire["exposureEvLimit"].as_f64(), Some(manifest::EXPOSURE_EV_LIMIT));
    assert_eq!(wire["adaptationSpeedMax"].as_f64(), Some(manifest::ADAPTATION_SPEED_MAX));
    // RQ4.0: bloom, GTAO, fog and contact-shadow limits.
    assert_eq!(wire["bloomThresholdMax"].as_f64(), Some(manifest::BLOOM_THRESHOLD_MAX));
    assert_eq!(wire["bloomRadius"]["min"].as_f64(), Some(manifest::BLOOM_RADIUS_MIN));
    assert_eq!(wire["bloomRadius"]["max"].as_f64(), Some(manifest::BLOOM_RADIUS_MAX));
    assert_eq!(wire["aoIntensityMax"].as_f64(), Some(manifest::AO_INTENSITY_MAX));
    assert_eq!(wire["aoRadiusMax"].as_f64(), Some(manifest::AO_RADIUS_MAX));
    assert_eq!(wire["fogDensityMax"].as_f64(), Some(manifest::FOG_DENSITY_MAX));
    assert_eq!(wire["fogHeightFalloffMax"].as_f64(), Some(manifest::FOG_HEIGHT_FALLOFF_MAX));
    assert_eq!(wire["fogDistanceLimit"].as_f64(), Some(manifest::FOG_DISTANCE_LIMIT));
    assert_eq!(wire["fogColorMax"].as_f64(), Some(manifest::FOG_COLOR_MAX));
    assert_eq!(wire["contactShadowLengthMax"].as_f64(), Some(manifest::CONTACT_SHADOW_LENGTH_MAX));
    assert_eq!(wire["localExposureContrastMin"].as_f64(), Some(manifest::LOCAL_EXPOSURE_CONTRAST_MIN));
    assert_eq!(manifest::LOCAL_EXPOSURE_CONTRAST_MIN as f32, genex_render::post::local_exposure::CONTRAST_MIN, "the file's floor is the renderer's");
}

/// The RQ4 look of the host's `genex-toml.test.ts` row, as both parsers read it.
const RQ4_LOOK: &str = "[game]\ntitle = \"T\"\n[render.look]\nbloom_threshold = 1.5\nbloom_radius = 2\nao_intensity = 0.8\nao_radius = 0.75\n\
fog_density = 0.02\nfog_height_falloff = 0.3\nfog_base_height = -4\nfog_start = 10\nfog_max_opacity = 0.9\nfog_color = [0.8, 0.85, 1.0]\n\
fog_aerial_perspective = false\ncontact_shadow_length = 0.4\n";

#[test]
fn the_rq4_look_reads_from_the_table_and_applies_to_the_renderer_look() {
    let parsed = manifest::parse(RQ4_LOOK).expect("valid");
    let look = &parsed.render.look;
    assert_eq!((look.bloom_threshold, look.bloom_radius), (Some(1.5), Some(2.0)));
    assert_eq!((look.ao_intensity, look.ao_radius), (Some(0.8), Some(0.75)));
    assert_eq!((look.fog_density, look.fog_height_falloff, look.fog_base_height), (Some(0.02), Some(0.3), Some(-4.0)));
    assert_eq!((look.fog_start, look.fog_max_opacity), (Some(10.0), Some(0.9)));
    assert_eq!(look.fog_color, Some(vec![0.8, 0.85, 1.0]));
    assert_eq!((look.fog_aerial_perspective, look.contact_shadow_length), (Some(false), Some(0.4)));
    let applied = look.apply_effects(genex_render::Look::default());
    assert_eq!((applied.bloom_threshold, applied.bloom_radius, applied.ao_intensity, applied.ao_radius), (1.5, 2.0, 0.8, 0.75));
    assert_eq!((applied.fog.density, applied.fog.height_falloff, applied.fog.base_height), (0.02, 0.3, -4.0));
    assert_eq!((applied.fog.start, applied.fog.max_opacity, applied.fog.color), (10.0, 0.9, [0.8, 0.85, 1.0]));
    assert!(!applied.fog.aerial_perspective);
    assert_eq!(applied.contact_shadow_length, 0.4);
    let untouched = manifest::parse("[game]\ntitle = \"T\"\n").expect("valid").render.look.apply_effects(genex_render::Look::default());
    assert_eq!(untouched, genex_render::Look::default(), "keys left out keep the renderer's defaults");
}

#[test]
fn local_exposure_reads_from_the_table_and_one_turns_a_side_off() {
    let text = "[game]\ntitle = \"T\"\n[render.look]\nlocal_exposure_highlights = 0.5\nlocal_exposure_shadows = 1\n";
    let look = manifest::parse(text).expect("valid").render.look;
    assert_eq!((look.local_exposure_highlights, look.local_exposure_shadows), (Some(0.5), Some(1.0)));
    let applied = look.apply_effects(genex_render::Look::default());
    assert_eq!((applied.local_exposure.highlights, applied.local_exposure.shadows), (0.5, 1.0));
    let config = genex::render::RenderConfig::new().local_exposure(1.0, 1.0);
    assert!(!config.look.local_exposure.is_on(), "both contrasts at 1: off");
}

#[test]
fn an_rq4_look_value_outside_its_range_is_refused_invalid_render_look() {
    let rows = [
        "bloom_threshold = -1",
        "bloom_threshold = 17",
        "bloom_radius = 0.125",
        "bloom_radius = 5",
        "ao_intensity = 1.5",
        "ao_radius = 0",
        "ao_radius = 9",
        "fog_density = -0.1",
        "fog_density = 2",
        "fog_height_falloff = -1",
        "fog_base_height = -100001",
        "fog_start = -1",
        "fog_max_opacity = 1.5",
        "fog_color = [1.0, 1.0]",
        "fog_color = [1.0, 17.0, 1.0]",
        "fog_color = [1.0, -0.5, 1.0]",
        "contact_shadow_length = 0",
        "contact_shadow_length = 3",
        "ao_radius = nan",
        "local_exposure_highlights = 0.1",
        "local_exposure_shadows = 1.5",
        "local_exposure_shadows = nan",
    ];
    for row in rows {
        let error = manifest::parse(&format!("[game]\ntitle = \"T\"\n[render.look]\n{row}\n")).expect_err(row);
        assert_eq!(error.code(), ManifestErrorCode::InvalidRenderLook, "{row}: {error}");
    }
}

#[test]
fn a_wgsl_source_at_api_two_is_admitted_and_three_is_not() {
    let game = "[game]\ntitle = \"T\"\n";
    let two = manifest::parse(&format!("{game}[[wgsl]]\npath = \"a.wgsl\"\nkind = \"material\"\napi = 2\n")).expect("api 2 is served");
    assert_eq!(two.wgsl[0].api, 2);
    let three = manifest::parse(&format!("{game}[[wgsl]]\npath = \"a.wgsl\"\nkind = \"post\"\napi = 3\n")).expect_err("api 3 is unknown");
    assert_eq!(three.code(), ManifestErrorCode::UnknownExtensionApi);
}

#[test]
fn auto_exposure_limits_and_speeds_read_from_the_look() {
    let parsed = manifest::parse(
        "[game]\ntitle = \"T\"\n[render.look]\nexposure = \"auto\"\nev_min = -6\nev_max = 8.5\nadaptation_speed_up = 3\nadaptation_speed_down = 1\n",
    )
    .expect("valid");
    let look = &parsed.render.look;
    assert_eq!((look.ev_min, look.ev_max), (Some(-6.0), Some(8.5)));
    assert_eq!((look.adaptation_speed_up, look.adaptation_speed_down), (Some(3.0), Some(1.0)));
}
