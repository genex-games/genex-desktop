//! genex-stream is simulation code that replays bit for bit on every destination: its sources
//! name no per-process-ordered collection, no rand crate, no wall clock and no thread. Clippy's
//! workspace `clippy.toml` refuses the calls; this scan also refuses the names, so a planted type
//! alias or a `use` that clippy would only see when called is caught too.

use std::path::{Path, PathBuf};

/// The names a simulation crate never writes, with the reason.
const FORBIDDEN: [(&str, &str); 7] = [
    ("HashMap", "per-process iteration order: use genex_core::map::Map"),
    ("HashSet", "per-process iteration order: use genex_core::map::Set"),
    ("rand::", "per-process seeding: take a &mut impl GameRng"),
    ("Instant", "a wall clock: count ticks"),
    ("SystemTime", "a wall clock: count ticks"),
    ("thread::", "threads reorder work: the runtime owns threads"),
    ("std::thread", "threads reorder work: the runtime owns threads"),
];

/// The forbidden names one source text uses outside `//` comments, as (line, name).
fn findings(text: &str) -> Vec<(usize, &'static str)> {
    let mut found = Vec::new();
    for (number, line) in text.lines().enumerate() {
        let code = line.split("//").next().unwrap_or("");
        for (name, _) in FORBIDDEN {
            if code.contains(name) {
                found.push((number + 1, name));
            }
        }
    }
    found
}

fn sources(dir: &Path, out: &mut Vec<PathBuf>) {
    let mut entries: Vec<PathBuf> = std::fs::read_dir(dir).expect("a source folder").map(|e| e.expect("an entry").path()).collect();
    entries.sort();
    for path in entries {
        if path.is_dir() {
            sources(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

#[test]
fn the_scan_refuses_each_planted_name() {
    let planted = [
        "use std::collections::HashMap;",
        "let seen: std::collections::HashSet<u32> = Default::default();",
        "let x: f32 = rand::random();",
        "let t = std::time::Instant::now();",
        "let t = std::time::SystemTime::now();",
        "std::thread::spawn(|| ());",
    ];
    for line in planted {
        assert!(!findings(line).is_empty(), "the scan misses {line:?}");
    }
    assert!(findings("// a comment may say HashMap").is_empty(), "comments are not code");
}

#[test]
fn the_crate_sources_name_nothing_forbidden() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    sources(&src, &mut files);
    assert!(!files.is_empty(), "genex-stream has sources");
    let mut refused = Vec::new();
    for file in &files {
        let text = std::fs::read_to_string(file).expect("a source file");
        for (line, name) in findings(&text) {
            let reason = FORBIDDEN.iter().find(|(n, _)| *n == name).map_or("", |(_, r)| *r);
            refused.push(format!("{}:{line}: {name} ({reason})", file.display()));
        }
    }
    assert!(refused.is_empty(), "forbidden names:\n{}", refused.join("\n"));
}
