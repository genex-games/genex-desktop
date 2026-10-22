//! Audio's logical state across destinations and pool classes (AU-10's GE rows "logical state
//! bit-equal native vs wasm32 vs Rosetta x86_64" and "equal at pool sizes 48/32/24, virtual flags
//! aside"): one loop of the walk (1200 ticks) from seed 1, the Director's logical hash read every
//! 60 ticks, folded into one digest. Every destination and every pool class must reach the same
//! pinned digest, while the smaller pools really do virtualize voices. These rows live in the
//! library so the same binary runs as a plain wasm32 libtest module (the web entry is compiled
//! out of it) and on the host, aarch64 or x86_64.

use genex::audio::PoolClass;
use genex::{FIXED_STEP_MS, Runtime};

use crate::{ASSETS, TOUR_TICKS, World, game};

/// The digest every destination and pool class must reach (FNV-1a 64 over the twenty logical
/// hashes, little-endian).
const LOGICAL_DIGEST: u64 = 0x6dbc_8d9b_4795_b854;
const SEED: u32 = 1;
/// Ticks between logical-hash samples.
const SAMPLE_TICKS: u64 = 60;
const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

/// What one walk reports: the digest of the samples, and the most voices virtual at a sample.
struct Walk {
    digest: u64,
    most_virtual: u64,
}

fn walk(class: PoolClass) -> Walk {
    let mut rt: Runtime<World> = Runtime::with_assets(game(), Box::new(ASSETS)).expect("installs");
    rt.set_audio_pool(class);
    rt.seed(SEED);
    let mut digest = FNV_OFFSET;
    let mut most_virtual = 0;
    for _ in 0..TOUR_TICKS / SAMPLE_TICKS {
        for _ in 0..SAMPLE_TICKS {
            rt.step(FIXED_STEP_MS);
        }
        digest = rt.audio_logical_hash().to_le_bytes().iter().fold(digest, |hash, byte| (hash ^ u64::from(*byte)).wrapping_mul(FNV_PRIME));
        let virtual_now = rt.state()["volatile"]["audio"]["pool"]["virtual"].as_u64().unwrap_or(0);
        most_virtual = most_virtual.max(virtual_now);
    }
    Walk { digest, most_virtual }
}

#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
fn the_walks_logical_audio_is_the_pinned_digest_on_this_destination() {
    let walk = walk(PoolClass::Desktop);
    assert_eq!(walk.digest, LOGICAL_DIGEST, "logical digest {:#018x}", walk.digest);
}

#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
fn the_web_and_phone_pools_keep_the_desktop_logical_state_while_virtualizing() {
    let desktop = walk(PoolClass::Desktop);
    assert_eq!(desktop.most_virtual, 0, "48 physical voices hold the whole yard");
    for class in [PoolClass::Web, PoolClass::Phone] {
        let smaller = walk(class);
        assert_eq!(smaller.digest, desktop.digest, "{class:?}: the logical state is the desktop's");
        assert!(smaller.most_virtual > 0, "{class:?}: the yard plays more voices than the pool renders");
    }
}
