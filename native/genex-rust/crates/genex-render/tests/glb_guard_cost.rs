//! The GLB guard's cost (game systems SF-1b): its share of `MeshData::from_glb` on the 1 MB
//! fixture, budget under 2%. A timing in its own test binary, so no counting allocator (the
//! guard rows' `tests/glb_guard.rs` has one) weighs on either side.

use std::path::Path;

use genex_render::mesh::MeshData;

/// A timing, so a release run on a quiet machine:
///
///   node scripts/toolchains/rust-env.ts -- cargo test -p genex-render --release --test glb_guard_cost \
///     -- --ignored --nocapture
#[test]
#[ignore = "a timing: run in release on a quiet machine"]
#[allow(clippy::disallowed_types, reason = "a cost row measures the wall clock on purpose")]
fn guard_cost_on_the_1_mb_fixture() {
    const RUNS: u32 = 200;
    let path = "native/genex-rust/examples/showcase/game/assets/tree-broadleaf-0-lod0-foliage.glb";
    let bytes = std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..").join(path)).expect("the fixture");
    // The fastest of many runs: the machine's other work only ever adds time.
    let time = |read: &dyn Fn()| (0..RUNS).map(|_| {
        let start = std::time::Instant::now();
        read();
        start.elapsed()
    }).min().expect("runs");
    let guard = time(&|| genex_core::glb_guard::check_glb(&bytes).expect("the fixture passes"));
    let load = time(&|| drop(MeshData::from_glb(&bytes).expect("the fixture loads")));
    let share = guard.as_secs_f64() / load.as_secs_f64();
    println!("{path}: {} bytes, guard {guard:?}, from_glb {load:?} (guard included), share {:.2}%", bytes.len(), share * 100.0);
    assert!(share < 0.02, "the guard is {:.2}% of from_glb", share * 100.0);
}
