//! Ring semantics without a GPU: the ring the host announces is validated as `gxf_ring_create`
//! does, slots cycle round-robin and are the host's until released, a release for another
//! generation or a free slot changes nothing, and `seq` only grows and never passes 2^53 - 1 (`gxf_validate.c`).

use genex_frames::FramesCode;
use genex_frames::ring::{RingSpec, SeqCounter, SlotLedger};
use genex_frames::wire::MAX_SEQ;

#[test]
fn a_ring_outside_the_wire_limits_is_refused_invalid_ring() {
    let hostile: [(u32, u32, u32, u32); 9] = [
        (0, 320, 180, 3),   // generation 0 is never announced
        (1, 320, 180, 0),   // no slots
        (1, 320, 180, 4),   // more than three
        (1, 0, 180, 3),     // empty side
        (1, 320, 0, 3),     // empty side
        (1, 8193, 16, 3),   // side over 8192
        (1, 16, 8193, 3),   // side over 8192
        (1, 8192, 8192, 3), // 64 Mpx: over the 32 Mpx surface ceiling
        (1, u32::MAX, u32::MAX, 3),
    ];
    for (generation, width, height, slots) in hostile {
        let refused = RingSpec::new(generation, width, height, slots);
        assert_eq!(
            refused.err().map(|e| e.code),
            Some(FramesCode::InvalidRing),
            "{generation} {width}x{height} {slots}"
        );
    }
    let edge = RingSpec::new(u32::MAX, 8192, 4096, 1).expect("exactly 32 Mpx at the side ceiling");
    assert_eq!((edge.generation(), edge.width(), edge.height(), edge.slots()), (u32::MAX, 8192, 4096, 1));
}

#[test]
fn three_slots_cycle_and_each_is_held_until_its_release() {
    let ring = RingSpec::new(5, 64, 32, 3).expect("a valid ring");
    let mut ledger = SlotLedger::new(&ring);
    let mut order = Vec::new();
    for _ in 0..3 {
        let slot = ledger.next_free().expect("a free slot");
        ledger.hold(slot);
        order.push(slot);
    }
    assert_eq!(order, [0, 1, 2]);
    assert_eq!(ledger.next_free(), None, "every slot is the host's");
    assert_eq!(ledger.held_mask(), 0b111);

    assert!(ledger.release(5, 1));
    assert_eq!(ledger.next_free(), Some(1));
    ledger.hold(1);
    assert!(ledger.release(5, 0));
    assert!(ledger.release(5, 2));
    assert_eq!(ledger.next_free(), Some(2), "round-robin after the last sent slot");
    assert_eq!(ledger.held_mask(), 0b010);
}

#[test]
fn a_stale_foreign_or_repeated_release_changes_nothing() {
    let ring = RingSpec::new(5, 64, 32, 2).expect("a valid ring");
    let mut ledger = SlotLedger::new(&ring);
    ledger.hold(0);
    let refused = [(4, 0), (6, 0), (5, 1), (5, 2), (5, 3), (5, u32::MAX)];
    for (generation, slot) in refused {
        assert!(!ledger.release(generation, slot), "release({generation}, {slot})");
        assert_eq!(ledger.held_mask(), 0b01);
    }
    assert!(ledger.release(5, 0));
    assert!(!ledger.release(5, 0), "a second release of the same slot");
    assert_eq!(ledger.held_mask(), 0);
}

#[test]
fn seq_starts_at_one_only_grows_and_stops_at_2_pow_53_minus_1() {
    let mut seq = SeqCounter::default();
    assert_eq!(seq.next().ok(), Some(1));
    assert_eq!(seq.next().ok(), Some(2));
    let mut last = SeqCounter::starting_after(MAX_SEQ - 1);
    assert_eq!(last.next().ok(), Some(MAX_SEQ), "the receiver accepts seq <= 2^53 - 1");
    assert_eq!(last.next().err().map(|e| e.code), Some(FramesCode::SeqExhausted));
    assert_eq!(last.next().err().map(|e| e.code), Some(FramesCode::SeqExhausted), "stays exhausted");
}
