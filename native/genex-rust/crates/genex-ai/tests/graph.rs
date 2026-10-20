//! genex-ai never reaches a model vendor (owner decision D5): it only prints lines for the
//! studio's broker. The crate's built graph, for every target, holds JSON and derive crates and
//! nothing else, so no HTTP client, socket, TLS or async runtime can enter a game through it. A
//! new dependency is a reviewed change to this list.

use std::process::Command;

/// Every package genex-ai may build, by name.
const ALLOWED: [&str; 14] = [
    "genex-ai",
    "genex-ai-derive",
    "serde",
    "serde_core",
    "serde_derive",
    "serde_json",
    "itoa",
    "zmij",
    "memchr",
    "indexmap",
    "equivalent",
    "hashbrown",
    "proc-macro2",
    "quote",
];
/// The derive's parser and its identifier tables.
const ALLOWED_PARSERS: [&str; 2] = ["syn", "unicode-ident"];

#[test]
fn the_built_graph_holds_no_network_crate() {
    let manifest = concat!(env!("CARGO_MANIFEST_DIR"), "/../../Cargo.toml");
    let output = Command::new(env!("CARGO"))
        .args(["tree", "--offline", "--locked", "-p", "genex-ai", "--target", "all", "--edges", "normal,build"])
        .args(["--prefix", "none", "--format", "{p}", "--manifest-path", manifest])
        .output()
        .expect("cargo tree runs");
    assert!(output.status.success(), "cargo tree: {}", String::from_utf8_lossy(&output.stderr));
    let tree = String::from_utf8(output.stdout).expect("utf-8");
    let names: Vec<&str> =
        tree.lines().filter_map(|line| line.split(' ').next()).filter(|name| !name.is_empty()).collect();
    assert!(names.contains(&"serde_json"), "the tree was read: {tree}");
    let outside: Vec<&str> =
        names.into_iter().filter(|name| !ALLOWED.contains(name) && !ALLOWED_PARSERS.contains(name)).collect();
    assert!(outside.is_empty(), "genex-ai builds crates outside its list: {outside:?}");
}
