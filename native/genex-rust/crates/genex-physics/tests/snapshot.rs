//! snapshot() and restore() (§9.4): the header, a round trip that steps on bit for bit (§9.3), a
//! restore that replaces the description, limits and static world, and refusals (BadSnapshot,
//! BuildMismatch, LimitMemory) that leave the world unchanged.

mod common;

use common::{ball, body, busy_world, cube, drive, run_busy, world};
use genex_physics::{
    BodyFilter, BodyType, PhysicsError, SNAPSHOT_MAGIC, StaticWorld, UpAxis, World, WorldDesc, build_id, fnv1a64,
};

const WARMUP: usize = 40;
const AFTER: usize = 120;
const HEAP: usize = 48;

/// Everything a caller can see of a world, `stats().stepMs` aside.
fn everything(w: &World) -> String {
    let mut stats = w.stats();
    stats.step_ms = 0.0;
    format!(
        "{} {:016x} {} {:?} {:?} {:?} {:?}",
        w.tick(),
        w.state_hash(),
        w.physics_hash(),
        w.desc(),
        w.bodies(&BodyFilter::default()),
        stats,
        w.export_changed(0).keys
    )
}

/// The header's fields, read by the layout `snapshot` documents.
struct Header {
    magic: [u8; 4],
    contract: (u16, u16),
    build: String,
    tick: u64,
    checksum: u64,
    length: u64,
    payload_at: usize,
}

fn header(bytes: &[u8]) -> Header {
    let u16_at = |i: usize| u16::from_le_bytes([bytes[i], bytes[i + 1]]);
    let u64_at = |i: usize| u64::from_le_bytes(bytes[i..i + 8].try_into().expect("8 bytes"));
    let id_len = usize::from(u16_at(8));
    let after = 10 + id_len;
    Header {
        magic: bytes[0..4].try_into().expect("4 bytes"),
        contract: (u16_at(4), u16_at(6)),
        build: String::from_utf8(bytes[10..after].to_vec()).expect("utf-8"),
        tick: u64_at(after),
        checksum: u64_at(after + 8),
        length: u64_at(after + 16),
        payload_at: after + 24,
    }
}

/// `bytes` with its checksum written again over its (edited) payload.
fn reseal(mut bytes: Vec<u8>) -> Vec<u8> {
    let h = header(&bytes);
    let sum = fnv1a64(&bytes[h.payload_at..]).to_le_bytes();
    let at = h.payload_at - 16;
    bytes[at..at + 8].copy_from_slice(&sum);
    bytes
}

/// `bytes` with another buildId in its header.
fn with_build(bytes: &[u8], build: &str) -> Vec<u8> {
    let h = header(bytes);
    let mut out = bytes[..8].to_vec();
    out.extend_from_slice(&(build.len() as u16).to_le_bytes());
    out.extend_from_slice(build.as_bytes());
    out.extend_from_slice(&bytes[10 + h.build.len()..]);
    out
}

fn busy_snapshot(up: UpAxis) -> (World, Vec<u8>) {
    let mut w = busy_world(up, HEAP);
    run_busy(&mut w, up, WARMUP);
    let bytes = w.snapshot().expect("snapshots");
    (w, bytes)
}

#[test]
fn the_header_carries_magic_contract_build_tick_and_the_payload_checksum() {
    let (w, bytes) = busy_snapshot(UpAxis::Z);
    let h = header(&bytes);
    assert_eq!(h.magic, SNAPSHOT_MAGIC);
    assert_eq!(&h.magic, b"GXPH");
    assert_eq!(h.contract, (1, 0));
    assert_eq!(h.build, build_id());
    assert_eq!(h.tick, w.tick());
    assert_eq!(h.length as usize, bytes.len() - h.payload_at);
    assert_eq!(h.checksum, fnv1a64(&bytes[h.payload_at..]));
}

#[test]
fn a_restored_world_steps_on_bit_for_bit_in_both_frames() {
    for up in [UpAxis::Y, UpAxis::Z] {
        let (mut original, bytes) = busy_snapshot(up);
        let mut restored = world(UpAxis::Y);
        restored.restore(&bytes).expect("restores");
        assert_eq!(everything(&restored), everything(&original), "{up:?}: the restore reads back as the original");
        let a = run_busy(&mut original, up, AFTER);
        let b = run_busy(&mut restored, up, AFTER);
        assert_eq!(a, b, "{up:?}: stateHash, events and escapes agree on every step");
        assert_eq!(everything(&restored), everything(&original), "{up:?}");
        assert_eq!(restored.export_changed(WARMUP as u64), original.export_changed(WARMUP as u64), "{up:?}");
    }
}

#[test]
fn a_snapshot_of_a_restored_world_is_the_same_bytes() {
    let (_, bytes) = busy_snapshot(UpAxis::Z);
    let mut restored = world(UpAxis::Y);
    restored.restore(&bytes).expect("restores");
    assert_eq!(restored.snapshot().expect("snapshots"), bytes);
}

#[test]
fn a_snapshot_between_steps_carries_pending_targets_and_the_query_quota() {
    let up = UpAxis::Y;
    let mut w = busy_world(up, 8);
    run_busy(&mut w, up, 10);
    let tick = w.tick();
    drive(&mut w, up, tick);
    let quota = w.stats().queries_this_step;
    assert!(quota > 0, "the queries counted");
    let bytes = w.snapshot().expect("snapshots");
    let mut restored = world(UpAxis::Z);
    restored.restore(&bytes).expect("restores");
    assert_eq!(restored.stats().queries_this_step, quota);
    assert_eq!(common::step_trace(&mut restored), common::step_trace(&mut w), "the lift's pending target moves both");
}

#[test]
fn a_restore_replaces_the_description_limits_and_static_world() {
    let mut desc = WorldDesc::new(1.0 / 20.0, 3.0, [0.0, 0.0, -800.0], UpAxis::Z, 39.37);
    desc.limits.bodies = Some(2.0);
    let mut source = World::create(&desc).expect("world");
    let floor = StaticWorld { boxes: vec![vec![-100.0, -100.0, -10.0, 100.0, 100.0, 0.0]], ramps: vec![] };
    source.add_static_world(&floor).expect("static");
    source.spawn(&body("a", BodyType::Dynamic, [0.0, 0.0, 40.0], ball(10.0))).expect("a");
    let bytes = source.snapshot().expect("snapshots");

    let mut target = world(UpAxis::Y);
    target.spawn(&body("other", BodyType::Dynamic, [0.0, 3.0, 0.0], cube(0.5))).expect("other");
    target.restore(&bytes).expect("restores");
    assert_eq!(target.desc(), source.desc());
    assert_eq!(target.physics_hash(), source.physics_hash());
    assert!(target.body("other").is_none(), "the old world is gone");
    target.spawn(&body("b", BodyType::Dynamic, [30.0, 0.0, 40.0], ball(10.0))).expect("a second body fits");
    let third = target.spawn(&body("c", BodyType::Dynamic, [60.0, 0.0, 40.0], ball(10.0)));
    assert_eq!(third.map_err(|f| f.code), Err(PhysicsError::LimitBodies), "the restored limits apply");
    let again = target.add_static_world(&floor).map_err(|f| f.code);
    assert_eq!(again, Err(PhysicsError::DuplicateKey), "the static world came with it");
    assert_eq!(target.overlap(&cube(1.0), genex_physics::Pose::at([0.0, 0.0, -5.0]), &Default::default()).expect("q"), vec![
        "static:box:0000".to_string()
    ]);
}

#[test]
fn a_snapshot_restores_on_another_target_of_the_same_build() {
    let (w, bytes) = busy_snapshot(UpAxis::Z);
    let (build, _) = build_id().rsplit_once('+').map(|(b, t)| (b.to_string(), t.to_string())).expect("a target");
    for target in ["wasm32", "x86_64-linux"] {
        let other = with_build(&bytes, &format!("{build}+{target}"));
        let mut restored = world(UpAxis::Y);
        restored.restore(&other).unwrap_or_else(|f| panic!("{target}: {f}"));
        assert_eq!(everything(&restored), everything(&w), "{target}");
    }
}

/// Restores `bytes` into a busy world and asserts the refusal's code and that nothing changed.
fn refused(bytes: &[u8], code: PhysicsError, what: &str) {
    let mut w = busy_world(UpAxis::Y, 8);
    run_busy(&mut w, UpAxis::Y, 3);
    let before = (everything(&w), w.snapshot().expect("snapshots"));
    let got = w.restore(bytes).map_err(|f| f.code);
    assert_eq!(got, Err(code), "{what}");
    assert_eq!((everything(&w), w.snapshot().expect("snapshots")), before, "{what}: the world is unchanged");
    w.check().expect("a refusal does not poison the world");
}

#[test]
fn malformed_snapshots_are_refused_and_change_nothing() {
    let (_, good) = busy_snapshot(UpAxis::Y);
    let h = header(&good);
    let mut rows: Vec<(String, Vec<u8>, PhysicsError)> = vec![
        ("empty".into(), vec![], PhysicsError::BadSnapshot),
        ("magic only".into(), b"GXPH".to_vec(), PhysicsError::BadSnapshot),
        ("wrong magic".into(), [b"GXPX".as_slice(), &good[4..]].concat(), PhysicsError::BadSnapshot),
        ("lower-case magic".into(), [b"gxph".as_slice(), &good[4..]].concat(), PhysicsError::BadSnapshot),
        ("a trailing byte".into(), [good.as_slice(), &[0]].concat(), PhysicsError::BadSnapshot),
        ("JSON".into(), br#"{"snapshot":true}"#.to_vec(), PhysicsError::BadSnapshot),
    ];
    let mut flipped = good.clone();
    let middle = h.payload_at + (good.len() - h.payload_at) / 2;
    flipped[middle] ^= 0x40;
    rows.push(("a payload byte flipped".into(), flipped, PhysicsError::BadSnapshot));
    let mut sum = good.clone();
    sum[h.payload_at - 16] ^= 1;
    rows.push(("the checksum flipped".into(), sum, PhysicsError::BadSnapshot));
    let mut length = good.clone();
    length[h.payload_at - 8] ^= 1;
    rows.push(("the length flipped".into(), length, PhysicsError::BadSnapshot));
    let mut long_id = good[..8].to_vec();
    long_id.extend_from_slice(&u16::MAX.to_le_bytes());
    rows.push(("a 64 KiB buildId".into(), long_id, PhysicsError::BadSnapshot));
    let mut minor = good.clone();
    minor[6] = 1;
    rows.push(("contract 1.1".into(), minor, PhysicsError::BuildMismatch));
    let mut major = good.clone();
    major[4] = 2;
    rows.push(("contract 2.0".into(), major, PhysicsError::BuildMismatch));
    let target = build_id().rsplit_once('+').map(|(_, t)| t.to_string()).expect("a target");
    for build in [
        format!("genex-physics/9.9.9+contract-1.0+rapier-0.36.0+det+{target}"),
        format!("genex-physics/0.1.0+contract-1.0+rapier-0.37.0+det+{target}"),
        format!("genex-physics/0.1.0+contract-1.0+box3d-1.0.0+det+{target}"),
        "genex-physics/0.1.0+contract-1.0+rapier-0.36.0+det".to_string(),
        "no target".to_string(),
        String::new(),
    ] {
        rows.push((format!("build {build:?}"), with_build(&good, &build), PhysicsError::BuildMismatch));
    }
    let mut not_utf8 = with_build(&good, "xx");
    not_utf8[10] = 0xff;
    rows.push(("a buildId that is not UTF-8".into(), not_utf8, PhysicsError::BuildMismatch));
    rows.push(("a payload of garbage, resealed".into(), reseal([&good[..h.payload_at], &[7u8; 64][..]].concat()), PhysicsError::BadSnapshot));
    rows.push(("an empty payload, resealed".into(), reseal(good[..h.payload_at].to_vec()), PhysicsError::BadSnapshot));
    for cut in (0..good.len()).step_by(97).chain(0..h.payload_at + 2) {
        rows.push((format!("truncated at {cut}"), good[..cut].to_vec(), PhysicsError::BadSnapshot));
    }
    for (what, bytes, code) in rows {
        let bytes = fix_length(bytes, &what);
        refused(&bytes, code, &what);
    }
}

/// Rows that change the payload keep its declared length right, so they reach the checksum.
fn fix_length(mut bytes: Vec<u8>, what: &str) -> Vec<u8> {
    if !what.ends_with("resealed") {
        return bytes;
    }
    let h = header(&bytes);
    let at = h.payload_at - 8;
    let length = (bytes.len() - h.payload_at) as u64;
    bytes[at..at + 8].copy_from_slice(&length.to_le_bytes());
    bytes
}

#[test]
fn a_world_over_its_own_memory_limit_is_refused_with_limit_memory() {
    let probe = world(UpAxis::Y);
    let base = probe.memory_bytes();
    let mut desc = WorldDesc::new(1.0 / 60.0, 1.0, [0.0, -9.81, 0.0], UpAxis::Y, 1.0);
    // Room for the floor and the heap's bodies, not for the contact pairs they make when they land.
    let bodies = 1 + 16;
    desc.limits.memory_bytes = Some((base + bodies * 1600) as f64);
    let mut w = World::create(&desc).expect("world");
    w.spawn(&body("floor", BodyType::Fixed, [0.0, -1.0, 0.0], genex_physics::Shape::Box { half: [20.0, 1.0, 20.0] }))
        .expect("floor");
    for i in 0..16 {
        w.spawn(&body(&format!("b{i:02}"), BodyType::Dynamic, [(i % 4) as f64, 0.5, (i / 4) as f64], cube(0.45))).expect("fits");
    }
    let mut exceeded = false;
    for _ in 0..30 {
        exceeded = w.step().expect("steps").memory_exceeded;
    }
    assert!(exceeded, "the contact pairs took the world over its limit");
    let bytes = w.snapshot().expect("a world over its limit still snapshots");
    refused(&bytes, PhysicsError::LimitMemory, "a world that does not fit its own memoryBytes");
}

#[test]
fn every_payload_byte_flip_is_refused_or_restores_a_world_that_steps_without_panicking() {
    let mut w = busy_world(UpAxis::Z, 6);
    run_busy(&mut w, UpAxis::Z, 5);
    let good = w.snapshot().expect("snapshots");
    let start = header(&good).payload_at;
    let (mut accepted, mut refusals) = (0, 0);
    for at in (start..good.len()).step_by(7) {
        let mut bytes = good.clone();
        bytes[at] ^= 0x5a;
        let bytes = reseal(bytes);
        let mut target = world(UpAxis::Y);
        let before = everything(&target);
        match target.restore(&bytes) {
            Ok(()) => {
                accepted += 1;
                for _ in 0..3 {
                    let step = target.step().map_err(|f| f.code);
                    assert!(matches!(step, Ok(_) | Err(PhysicsError::Internal)), "byte {at}: {step:?}");
                }
            }
            Err(failure) => {
                refusals += 1;
                let code_ok = matches!(failure.code, PhysicsError::BadSnapshot | PhysicsError::LimitMemory);
                assert!(code_ok, "byte {at}: {failure}");
                assert_eq!(everything(&target), before, "byte {at}: a refusal changes nothing");
            }
        }
    }
    assert!(refusals > 0 && accepted + refusals > 100, "{accepted} accepted, {refusals} refused");
}

/// The payload's description starts it (postcard): dt as 4 bytes, substeps, gravity's 12 bytes,
/// upAxis, lengthUnit's 4 bytes and solver iterations, then the limits, bodies first. Each small
/// integer is one byte.
const PAYLOAD_DT: usize = 0;
const PAYLOAD_BODIES_LIMIT: usize = 4 + 1 + 12 + 1 + 4 + 1;

#[test]
fn a_resealed_payload_no_world_could_hold_is_bad_snapshot() {
    let mut desc = WorldDesc::new(1.0 / 60.0, 1.0, [0.0, -9.81, 0.0], UpAxis::Y, 1.0);
    desc.limits.bodies = Some(2.0);
    let mut w = World::create(&desc).expect("world");
    w.spawn(&body("a", BodyType::Dynamic, [0.0, 1.0, 0.0], ball(0.5))).expect("a");
    w.spawn(&body("b", BodyType::Dynamic, [2.0, 1.0, 0.0], ball(0.5))).expect("b");
    let good = w.snapshot().expect("snapshots");
    let at = header(&good).payload_at;
    assert_eq!(good[at + PAYLOAD_BODIES_LIMIT], 2, "the payload layout this test edits");
    assert_eq!(&good[at + PAYLOAD_DT..at + 4], &(1.0f32 / 60.0).to_le_bytes(), "the payload layout this test edits");

    let mut fewer = good.clone();
    fewer[at + PAYLOAD_BODIES_LIMIT] = 1;
    refused(&reseal(fewer), PhysicsError::BadSnapshot, "two bodies in a world limited to one");
    let mut slow = good.clone();
    slow[at + PAYLOAD_DT..at + 4].copy_from_slice(&0.5f32.to_le_bytes());
    refused(&reseal(slow), PhysicsError::BadSnapshot, "a dt of 0.5");
    let mut ok = good.clone();
    ok[at + PAYLOAD_BODIES_LIMIT] = 3;
    let mut target = world(UpAxis::Z);
    target.restore(&reseal(ok)).expect("a resealed payload that a world could hold restores");
    assert_eq!(target.desc().limits.bodies, 3);
}
