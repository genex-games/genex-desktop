//! `paths.h`: save roots from an injected environment, the asset-path rule, asset claims, capture
//! paths, raylib's log claims and the window-system choice. Every row is a pure computation.

use crate::support::{golden, same, text_str, u64_of};
use genex_core::json::Value;
use genex_core::paths::{
    Destination, GameIdentity, SaveRefusal, asset_claim, capture_folder, capture_path, claimed_file, destination_of,
    identity_of, is_safe_asset_path, prefers_x11, save_root,
};

fn destination_named(name: &str) -> Destination {
    match name {
        "genex-run" => Destination::GenexRun,
        "web" => Destination::Web,
        "mac" => Destination::Mac,
        "windows" => Destination::Windows,
        "linux" => Destination::Linux,
        other => panic!("unknown destination {other}"),
    }
}

fn refusal_name(refusal: Option<SaveRefusal>) -> &'static str {
    match refusal {
        None => "none",
        Some(SaveRefusal::NoStateDir) => "no-state-dir",
        Some(SaveRefusal::NoHome) => "no-home",
        Some(SaveRefusal::NoAppData) => "no-app-data",
        Some(SaveRefusal::BadName) => "bad-name",
        Some(SaveRefusal::BadBundleId) => "bad-bundle-id",
        Some(SaveRefusal::NoDataDir) => "no-data-dir",
    }
}

fn destination_name(where_: Destination) -> &'static str {
    match where_ {
        Destination::GenexRun => "genex-run",
        Destination::Web => "web",
        Destination::Mac => "mac",
        Destination::Windows => "windows",
        Destination::Linux => "linux",
        Destination::Ios => "ios",
        Destination::Android => "android",
    }
}

/// An environment that holds exactly `vars`.
fn env_of(vars: &Value) -> impl Fn(&str) -> Option<String> + '_ {
    move |name: &str| vars.members().iter().find(|(key, _)| key == name.as_bytes()).map(|(_, value)| text_str(value))
}

#[test]
fn save_roots_match_the_cpp() {
    let cases = golden!("paths");
    assert!(cases["saveRoots"].items().len() > 100);
    for case in cases["saveRoots"].items() {
        let name = text_str(&case["name"]);
        let bundle_id = text_str(&case["bundleId"]);
        let game = GameIdentity { name: &name, bundle_id: &bundle_id };
        let root = save_root(destination_named(case["destination"].as_str()), &env_of(&case["env"]), game);
        let (refusal, path) = match root {
            Ok(path) => (None, path),
            Err(refusal) => (Some(refusal), String::new()),
        };
        let context = format!("save root {case:?}");
        same(&Value::from(refusal_name(refusal)), &case["refusal"], &context);
        same(&Value::from(path), &case["path"], &context);
    }
}

#[test]
fn asset_paths_are_refused_alike() {
    let cases = golden!("paths");
    for case in cases["assetPaths"].items() {
        let safe = is_safe_asset_path(&text_str(&case["path"]));
        same(&Value::from(safe), &case["safe"], &format!("asset path {:?}", case["path"]));
    }
}

#[test]
fn asset_claims_label_the_same_files() {
    let cases = golden!("paths");
    for case in cases["assetClaims"].items() {
        let claim = asset_claim(&text_str(&case["file"]), &text_str(&case["root"]));
        same(&Value::from(claim), &case["claim"], &format!("asset claim {case:?}"));
    }
}

#[test]
fn capture_paths_match_on_this_platform_form() {
    if cfg!(windows) {
        // The goldens were taken on a POSIX host, where only POSIX roots are absolute.
        return;
    }
    let cases = golden!("paths");
    for case in cases["captures"].items() {
        let root = text_str(&case["root"]);
        let seq = u64_of(&case["seq"]) as u32;
        same(&Value::from(capture_folder(&root)), &case["folder"], &format!("capture folder {root:?}"));
        same(&Value::from(capture_path(&root, seq)), &case["path"], &format!("capture path {root:?}"));
    }
}

#[test]
fn log_claims_name_the_same_files() {
    let cases = golden!("paths");
    for case in cases["claimedFiles"].items() {
        let line = text_str(&case["line"]);
        let save = text_str(&case["saveRoot"]);
        let file = claimed_file(case["informational"].as_bool(), &line, &save);
        same(&Value::from(file), &case["file"], &format!("claimed file {line:?}"));
    }
}

#[test]
fn environments_choose_the_same_window_system_and_destination() {
    let cases = golden!("paths");
    for case in cases["environments"].items() {
        let env = env_of(&case["env"]);
        same(&Value::from(prefers_x11(&env)), &case["prefersX11"], &format!("x11 {:?}", case["env"]));
        let destination = destination_name(destination_of(&env));
        // Without the studio's descriptor the destination is the build's own platform.
        if case["destination"].as_str() == "genex-run" || cfg!(target_os = "macos") {
            same(&Value::from(destination), &case["destination"], &format!("destination {:?}", case["env"]));
        }
    }
}

#[test]
fn identities_prefer_the_game_and_the_running_bundle() {
    let cases = golden!("paths");
    let unnamed = GameIdentity { name: "", bundle_id: "" };
    for case in cases["identities"].items() {
        let save_name = text_str(&case["saveName"]);
        let running = text_str(&case["runningBundleId"]);
        let identity = identity_of(&save_name, &running, unnamed);
        same(&Value::from(identity.name), &case["name"], "identity name");
        same(&Value::from(identity.bundle_id), &case["bundleId"], "identity bundle id");
    }
    let built = GameIdentity { name: "Pond", bundle_id: "games.genex.game.pond" };
    assert_eq!(identity_of("", "", built), built);
    assert_eq!(identity_of("Mine", "", built).name, "Mine");
}
