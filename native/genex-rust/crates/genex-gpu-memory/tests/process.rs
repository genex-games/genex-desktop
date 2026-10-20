//! Process memory per destination (game systems PROF-3): the resident bytes and what the OS says
//! the process can still get, read on the host; the web answers None (the facade fills its heap).
//! One row per process-wide measurement, so no other test in this binary allocates beside it.

use genex_gpu_memory::{ProcessMemory, process_memory};

/// One MiB.
#[cfg(not(target_arch = "wasm32"))]
const MIB: u64 = 1024 * 1024;
/// The allocation the resident row touches.
#[cfg(not(target_arch = "wasm32"))]
const TOUCHED_BYTES: usize = 64 * 1024 * 1024;
/// The smallest page any destination uses: touching one byte per page faults every page in.
#[cfg(not(target_arch = "wasm32"))]
const PAGE_STRIDE: usize = 4096;
/// How much of the touched allocation must show up as resident growth (allocator and page
/// accounting noise stay under the rest).
#[cfg(not(target_arch = "wasm32"))]
const GROWTH_FLOOR_BYTES: u64 = 48 * MIB;

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn the_resident_size_grows_after_touching_a_64_mib_allocation() {
    let before = process_memory().resident.expect("a native host reports its resident size");
    let mut block = vec![0u8; TOUCHED_BYTES];
    for offset in (0..TOUCHED_BYTES).step_by(PAGE_STRIDE) {
        block[offset] = 1;
    }
    std::hint::black_box(&mut block);
    let after = process_memory().resident.expect("a native host reports its resident size");
    assert!(after >= before + GROWTH_FLOOR_BYTES, "resident grew {} MiB (before {before}, after {after})", after.saturating_sub(before) / MIB);
    drop(block);
}

#[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
#[test]
fn a_desktop_host_says_how_much_memory_is_still_available() {
    let available = process_memory().available.expect("a desktop host reports available memory");
    let physical = genex_gpu_memory::memory_facts().physical_bytes.expect("and its physical memory");
    assert!(available > 0 && available <= physical, "available {available} within physical {physical}");
}

#[cfg(target_arch = "wasm32")]
#[test]
fn the_web_answers_none() {
    assert_eq!(process_memory(), ProcessMemory { resident: None, available: None });
}

#[test]
fn unknown_process_memory_is_none() {
    assert_eq!(ProcessMemory::default(), ProcessMemory { resident: None, available: None });
}
