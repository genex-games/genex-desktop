//! The determinism self-check (§1.2): the busy scene (a heap, joints, a kinematic lift, a sensor,
//! a CCD ball, queries and kicks) gives the same stateHash and events on every step in two fresh
//! worlds, and through snapshot/restore into fresh worlds along the way; and its trace hashes to a
//! pinned value.
//!
//! The pins are this build's (`genex-physics/1.1.0-dev.0+contract-1.0+rapier-0.36.0+det`): §1.2 promises
//! them on every target of the determinism row (Mac ARM, Linux x86_64, wasm32). They were computed
//! on aarch64-macos; a different value on another target is a determinism break to investigate,
//! never a pin to update. A change of backend or core that changes results changes the buildId's
//! version, and the pins with it.

mod common;

use common::{busy_world, run_busy, world};
use genex_physics::{UpAxis, build_id_without_target, fnv1a64, hex16};

const STEPS: usize = 300;
const HEAP: usize = 64;
const RESTORE_EVERY: usize = 50;
/// The trace's FNV-1a 64 for the z-up and y-up scenes, this build.
const PINNED_TRACE: [(UpAxis, &str); 2] = [(UpAxis::Z, "d0960f84d74a8226"), (UpAxis::Y, "e6a0bca37e622ca5")];
const PINNED_BUILD: &str = "genex-physics/1.1.0-dev.0+contract-1.0+rapier-0.36.0+det";

fn trace(up: UpAxis) -> Vec<String> {
    let mut w = busy_world(up, HEAP);
    run_busy(&mut w, up, STEPS)
}

#[test]
fn two_fresh_worlds_agree_on_every_step() {
    for up in [UpAxis::Z, UpAxis::Y] {
        assert_eq!(trace(up), trace(up), "{up:?}");
    }
}

#[test]
fn restoring_into_fresh_worlds_along_the_way_changes_nothing() {
    for up in [UpAxis::Z, UpAxis::Y] {
        let mut w = busy_world(up, HEAP);
        let mut steps = Vec::new();
        while steps.len() < STEPS {
            steps.extend(run_busy(&mut w, up, RESTORE_EVERY));
            let bytes = w.snapshot().expect("snapshots");
            w = world(UpAxis::Y);
            w.restore(&bytes).expect("restores");
        }
        assert_eq!(steps, trace(up), "{up:?}");
    }
}

#[test]
fn the_trace_matches_the_pinned_value_of_this_build() {
    assert_eq!(build_id_without_target(), PINNED_BUILD, "a new build has new pins");
    for (up, pinned) in PINNED_TRACE {
        let all = trace(up).join("\n");
        assert_eq!(hex16(fnv1a64(all.as_bytes())), pinned, "{up:?}");
    }
}
