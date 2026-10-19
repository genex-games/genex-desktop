//! The native async source (game systems STR-13): ranges and whole files from the compiled table
//! and `assets/`, read on the job pool and answered at a later poll. Hostile names and ranges are
//! refused with nothing opened (the source counts every file it opens), by the same path check as
//! the sim's reads ([`AssetFiles`]); a 64 MiB file read in ranges comes back in the order the reads
//! finished and reassembles by id.
//!
//!   node scripts/toolchains/rust-env.ts -- cargo test -p genex --test stream_source --offline --locked
#![cfg(not(target_arch = "wasm32"))]

use std::path::{Path, PathBuf};
use std::time::Duration;

use genex::{AssetErrorCode, AssetFiles, AssetSource, AsyncSource, StreamAnswer, StreamBytes, StreamFiles, StreamRequest};
use genex_render::jobs::{Pool, Priority};

const MIB: u64 = 1024 * 1024;
/// Polls a test waits for its answers, 1 ms apart, before it fails (a read that blocked).
const POLLS_MAX: usize = 30_000;

/// A fresh folder for one test, with an `assets/` inside.
fn scratch(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("genex-stream-source-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("assets")).expect("assets folder");
    dir
}

/// A pool of its own, so held or slow jobs never touch another test's.
fn pool(threads: usize) -> &'static Pool {
    Box::leak(Box::new(Pool::new(threads)))
}

/// Poll `source` until every request is answered.
fn settle(source: &mut StreamFiles) -> Vec<StreamAnswer> {
    let mut answers = Vec::new();
    for _ in 0..POLLS_MAX {
        answers.extend(source.poll());
        if source.in_flight() == 0 {
            return answers;
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    panic!("{} requests never answered", source.in_flight());
}

/// The one answer of `request` among `answers`.
fn answer_of(answers: &[StreamAnswer], request: StreamRequest) -> &Result<StreamBytes, genex::AssetError> {
    let mut found = answers.iter().filter(|(id, _)| *id == request);
    let (_, answer) = found.next().expect("answered");
    assert!(found.next().is_none(), "answered once");
    answer
}

/// A byte pattern no two nearby offsets share.
fn pattern(bytes: u64) -> Vec<u8> {
    (0..bytes).map(|at| (at.wrapping_mul(2_654_435_761) >> 11) as u8).collect()
}

/// Make a FIFO at `path` (a named pipe: opening it for reading blocks until a writer comes).
#[cfg(unix)]
fn fifo(path: &Path) {
    let made = std::process::Command::new("mkfifo").arg(path).status().expect("mkfifo runs");
    assert!(made.success(), "mkfifo {}", path.display());
}

/// Hostile names and ranges are refused with a typed code and nothing opened; each name is refused
/// with the same code as the sim's reads give it (one check, in `AssetFiles`). A good read after
/// them opens exactly one file, so the count is live.
#[cfg(unix)]
#[test]
fn hostile_names_and_ranges_are_refused_with_nothing_opened() {
    let dir = scratch("hostile");
    let assets = dir.join("assets");
    std::fs::write(assets.join("data.bin"), pattern(64)).expect("asset");
    std::fs::write(dir.join("secret.bin"), b"secret").expect("outside file");
    std::fs::create_dir_all(dir.join("outside")).expect("outside folder");
    std::fs::write(dir.join("outside/inner.bin"), b"inner").expect("outside inner");
    std::fs::create_dir_all(assets.join("folder")).expect("a folder");
    std::os::unix::fs::symlink(assets.join("data.bin"), assets.join("link.bin")).expect("link at the name");
    std::os::unix::fs::symlink(dir.join("secret.bin"), assets.join("leak.bin")).expect("link out");
    std::os::unix::fs::symlink(dir.join("outside"), assets.join("leaks")).expect("folder link out");
    fifo(&assets.join("fifo.bin"));
    let table: genex::AssetTable = &[("table.bin", b"0123456789")];
    let mut source = StreamFiles::with_pool(AssetFiles::new(table, Some(assets.clone())), pool(2));
    let sim = AssetFiles::new(table, Some(assets.clone()));
    // (path, range, code)
    let rows: [(&str, Option<std::ops::Range<u64>>, AssetErrorCode); 17] = [
        ("../secret.bin", None, AssetErrorCode::UnsafePath),
        ("a/../../secret.bin", None, AssetErrorCode::UnsafePath),
        ("/etc/hosts", None, AssetErrorCode::UnsafePath),
        ("", None, AssetErrorCode::UnsafePath),
        ("./data.bin", None, AssetErrorCode::UnsafePath),
        ("a\\data.bin", None, AssetErrorCode::UnsafePath),
        ("link.bin", None, AssetErrorCode::UnsafePath),
        ("leak.bin", Some(0..1), AssetErrorCode::UnsafePath),
        ("leaks/inner.bin", None, AssetErrorCode::UnsafePath),
        ("fifo.bin", None, AssetErrorCode::Missing),
        ("fifo.bin", Some(0..1), AssetErrorCode::Missing),
        ("folder", None, AssetErrorCode::Missing),
        ("missing.bin", None, AssetErrorCode::Missing),
        ("data.bin", Some(0..65), AssetErrorCode::Malformed),
        ("data.bin", Some(64..65), AssetErrorCode::Malformed),
        ("data.bin", Some(std::ops::Range { start: 10, end: 5 }), AssetErrorCode::Malformed),
        ("table.bin", Some(4..11), AssetErrorCode::Malformed),
    ];
    let requests: Vec<StreamRequest> = rows.iter().map(|(path, range, _)| source.request(path, range.clone(), Priority::Visible)).collect();
    let answers = settle(&mut source);
    assert_eq!(answers.len(), rows.len());
    for ((path, range, code), request) in rows.iter().zip(&requests) {
        let refusal = answer_of(&answers, *request).as_ref().expect_err(path);
        assert_eq!(refusal.code(), *code, "{path:?} {range:?}: {refusal}");
        if range.is_none() && !path.starts_with("table") {
            let sim_code = sim.read(path).expect_err(path).code();
            assert_eq!(sim_code, *code, "{path:?}: the sim's read and the stream's refuse alike");
        }
    }
    assert_eq!(source.opened(), 0, "a refused request opens nothing");
    let good = source.request("data.bin", Some(60..64), Priority::Visible);
    let answers = settle(&mut source);
    assert_eq!(answer_of(&answers, good).as_deref().expect("read"), &pattern(64)[60..]);
    assert_eq!(source.opened(), 1);
    let _ = std::fs::remove_dir_all(&dir);
}

/// A 64 MiB file read in 16 ranges comes back whole once reassembled by id. On one held thread,
/// with the ranges queued as prefetches and one range asked for at `Sim` after them, that range is
/// answered first: answers come in the order the reads finish, not the order they were asked for.
#[test]
fn a_64_mib_file_read_in_ranges_arrives_by_completion_and_reassembles_by_id() {
    let dir = scratch("big");
    let bytes = pattern(64 * MIB);
    std::fs::write(dir.join("assets/big.bin"), &bytes).expect("64 MiB asset");
    let pool = pool(1);
    let mut source = StreamFiles::with_pool(AssetFiles::new(&[], Some(dir.join("assets"))), pool);
    let hold = pool.hold();
    let chunk = 4 * MIB;
    let mut requests: Vec<(StreamRequest, u64)> =
        (0..15).map(|index| (source.request("big.bin", Some(index * chunk..(index + 1) * chunk), Priority::Prefetch), index * chunk)).collect();
    let urgent = source.request("big.bin", Some(15 * chunk..16 * chunk), Priority::Sim);
    requests.push((urgent, 15 * chunk));
    assert_eq!(source.in_flight(), 16);
    assert!(source.poll().is_empty(), "nothing is read while the pool is held");
    drop(hold);
    let answers = settle(&mut source);
    assert_eq!(answers.first().map(|(id, _)| *id), Some(urgent), "the Sim read finished first");
    let mut whole = vec![0u8; bytes.len()];
    for (request, offset) in &requests {
        let read = answer_of(&answers, *request).as_ref().expect("range read");
        let start = usize::try_from(*offset).expect("offset");
        whole[start..start + read.len()].copy_from_slice(read);
    }
    assert!(whole == bytes, "the ranges reassemble to the file");
    assert_eq!(source.opened(), 16);
    let whole_file = source.request("big.bin", None, Priority::Visible);
    let answers = settle(&mut source);
    assert!(**answer_of(&answers, whole_file).as_ref().expect("whole read") == *bytes, "None reads the whole file");
    let _ = std::fs::remove_dir_all(&dir);
}

/// The compiled table answers first, as a slice of the program's bytes with no file opened; a
/// table miss falls through to `assets/`.
#[test]
fn the_table_answers_first_without_a_copy_or_an_open() {
    let dir = scratch("table");
    std::fs::write(dir.join("assets/disk.bin"), b"disk bytes").expect("asset");
    std::fs::write(dir.join("assets/table.bin"), b"shadowed on disk").expect("shadowed asset");
    static TABLE: genex::AssetTable = &[("table.bin", b"table bytes")];
    let mut source = StreamFiles::with_pool(AssetFiles::new(TABLE, Some(dir.join("assets"))), pool(1));
    let table = source.request("table.bin", Some(6..11), Priority::Visible);
    let disk = source.request("disk.bin", None, Priority::Visible);
    let answers = settle(&mut source);
    match answer_of(&answers, table) {
        Ok(StreamBytes::Static(bytes)) => assert_eq!(*bytes, b"bytes"),
        other => panic!("the table's own bytes, not {other:?}"),
    }
    assert_eq!(answer_of(&answers, disk).as_deref().expect("disk read"), b"disk bytes");
    assert_eq!(source.opened(), 1, "only the disk read opened a file");
    let _ = std::fs::remove_dir_all(&dir);
}

/// A withdrawn request is never answered: a queued one never runs, and one already answered but
/// not yet polled is dropped.
#[test]
fn a_cancelled_request_is_never_answered() {
    let dir = scratch("cancel");
    std::fs::write(dir.join("assets/a.bin"), b"aaaa").expect("asset");
    static TABLE: genex::AssetTable = &[("t.bin", b"tttt")];
    let pool = pool(1);
    let mut source = StreamFiles::with_pool(AssetFiles::new(TABLE, Some(dir.join("assets"))), pool);
    let hold = pool.hold();
    let queued = source.request("a.bin", None, Priority::Visible);
    let kept = source.request("a.bin", Some(0..2), Priority::Visible);
    let table = source.request("t.bin", None, Priority::Visible);
    assert!(source.cancel(queued));
    assert!(source.cancel(table));
    assert!(!source.cancel(table), "already withdrawn");
    drop(hold);
    let answers = settle(&mut source);
    assert_eq!(answers.iter().map(|(id, _)| *id).collect::<Vec<_>>(), vec![kept]);
    assert_eq!(source.opened(), 1, "the withdrawn read never ran");
    assert!(!source.cancel(kept), "already answered");
    let _ = std::fs::remove_dir_all(&dir);
}
