//! A dev page swaps a changed file's admitted bytes (game systems C-18, the web side of
//! `reloadAssets`): [`WebAssets::replace`] takes the new bytes of a planned whole file only when
//! their FNV-1a 64 is the digest the host named, within the caps, and records the new length and
//! digest; every refusal leaves the old bytes and the plan as they were.

use genex_core::digest::{fnv1a64, hex64};
use genex_platform_web::assets::{AssetRefusal, MAX_ASSET_BYTES, WebAssets};

fn entry(path: &str, bytes: &[u8]) -> String {
    format!(r#"{{"path":{},"bytes":{},"fnv1a64":"{}"}}"#, serde_json::json!(path), bytes.len(), hex64(fnv1a64(bytes)))
}

fn ranged(path: &str, bytes: &[u8]) -> String {
    let digest = hex64(fnv1a64(bytes));
    format!(
        r#"{{"path":{},"bytes":{},"fnv1a64":"{digest}","group":"stream","ranges":[{{"offset":0,"bytes":{},"fnv1a64":"{digest}"}}]}}"#,
        serde_json::json!(path),
        bytes.len(),
        bytes.len()
    )
}

fn planned(entries: &[String]) -> WebAssets {
    WebAssets::plan(format!(r#"{{"version":2,"files":[{}]}}"#, entries.join(",")).as_bytes()).expect("a well-formed map")
}

const OLD: &[u8] = b"old bark bytes";
const NEW: &[u8] = b"the new, longer bark bytes";

#[test]
fn a_planned_file_takes_its_new_bytes_when_they_match_the_host_s_digest() {
    let mut assets = planned(&[entry("textures/bark.png", OLD), entry("textures/moss.png", OLD)]);
    assets.admit("textures/bark.png", OLD.to_vec()).expect("admitted");
    assets.replace("textures/bark.png", NEW.to_vec(), &hex64(fnv1a64(NEW))).expect("swapped");
    assert_eq!(assets.get("textures/bark.png"), Some(NEW));
    let bark = assets.planned().iter().find(|asset| asset.path == "textures/bark.png").expect("planned");
    assert_eq!(bark.bytes, NEW.len() as u64, "the plan records the new length");
    // A file not admitted yet (moved to the game at boot, or not fetched) takes them too.
    assets.replace("textures/moss.png", NEW.to_vec(), &hex64(fnv1a64(NEW))).expect("swapped");
    assert_eq!(assets.get("textures/moss.png"), Some(NEW));
    // After a swap the old bytes are refused like any stale fetch.
    let again = assets.admit("textures/bark.png", OLD.to_vec());
    assert_eq!(again.map_err(|error| error.code()), Err(AssetRefusal::NotPlanned));
}

#[test]
fn every_refusal_leaves_the_old_bytes_and_the_plan() {
    let mut assets = planned(&[entry("textures/bark.png", OLD), ranged("cells/a.pack", OLD)]);
    assets.admit("textures/bark.png", OLD.to_vec()).expect("admitted");
    let before: Vec<(String, u64)> = assets.planned().iter().map(|asset| (asset.path.clone(), asset.bytes)).collect();
    let cases: [(&str, Vec<u8>, String, AssetRefusal); 5] = [
        ("textures/bark.png", NEW.to_vec(), hex64(fnv1a64(OLD)), AssetRefusal::DigestMismatch),
        ("textures/bark.png", NEW.to_vec(), "NOT-HEX".to_owned(), AssetRefusal::DigestMismatch),
        ("textures/none.png", NEW.to_vec(), hex64(fnv1a64(NEW)), AssetRefusal::NotPlanned),
        ("../bark.png", NEW.to_vec(), hex64(fnv1a64(NEW)), AssetRefusal::UnsafePath),
        ("cells/a.pack", NEW.to_vec(), hex64(fnv1a64(NEW)), AssetRefusal::RangeInvalid),
    ];
    for (path, bytes, digest, code) in cases {
        let refused = assets.replace(path, bytes, &digest);
        assert_eq!(refused.map_err(|error| error.code()), Err(code), "{path} {digest}");
    }
    assert_eq!(assets.get("textures/bark.png"), Some(OLD));
    let after: Vec<(String, u64)> = assets.planned().iter().map(|asset| (asset.path.clone(), asset.bytes)).collect();
    assert_eq!(after, before);
    assert!(MAX_ASSET_BYTES > NEW.len() as u64);
}
