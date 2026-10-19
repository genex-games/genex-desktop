//! The soft upload queue (game systems STR-5): streamed uploads spread over frames under the
//! class's byte budget and the frame's millisecond budget, whole assets only, an asset larger than
//! the budget alone in its frame; the hard 32 MiB frame-table cap unchanged. The clock is a fake
//! one, so every CPU row is exact; the GPU row writes real buffers and reads them back.
//!
//!   node scripts/toolchains/rust-env.ts -- cargo test -p genex-render --test upload_queue --offline --locked
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --test upload_queue --offline --locked -- --ignored metal

use genex_render::caps::{UPLOAD_MAX_BYTES_PER_FRAME, UploadBudget};
use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier, TargetOs};
use genex_render::RenderCode;
use genex_render::jobs::{FINISH_BUDGET_DESKTOP_MS, FINISH_BUDGET_PHONE_MS, Priority};
use genex_render::presets::{StreamBudget, stream_budget};
use genex_render::upload_queue::{UploadQueue, UploadStop};
use genex_render::Gpu;

const KIB: u64 = 1024;
const MIB: u64 = 1024 * KIB;

fn class(form: FormFactor, tier: PerformanceTier) -> DeviceClass {
    DeviceClass::new(form, tier)
}

fn mobile_mid() -> StreamBudget {
    stream_budget(class(FormFactor::Mobile, PerformanceTier::Mid), TargetOs::Android)
}

/// A fake clock that moves `step_ms` at every reading.
fn ticking(step_ms: f64) -> impl FnMut() -> f64 {
    let mut now = 0.0;
    move || {
        now += step_ms;
        now
    }
}

/// Asset sizes cycling through a mix of small and mid uploads, `total` bytes in all.
fn mixed_sizes(total: u64) -> Vec<u64> {
    let cycle = [256 * KIB, MIB, 768 * KIB, 2 * MIB, 512 * KIB, 3 * MIB / 2];
    let mut sizes = Vec::new();
    let mut left = total;
    for size in cycle.into_iter().cycle() {
        if left == 0 {
            break;
        }
        let size = size.min(left);
        sizes.push(size);
        left -= size;
    }
    sizes
}

/// Drain `queue` once a frame under `budget` until it is empty: each frame's uploaded (index, bytes).
fn frames(queue: &mut UploadQueue<(usize, u64)>, budget: StreamBudget) -> Vec<Vec<(usize, u64)>> {
    let mut clock = ticking(0.01);
    let mut frames = Vec::new();
    while !queue.is_empty() {
        let mut frame = Vec::new();
        let report = queue.drain(budget.upload_bytes, budget.finish_ms, &mut clock, |item| frame.push(item));
        assert_eq!(report.uploaded, frame.len());
        assert_eq!(report.bytes, frame.iter().map(|(_, bytes)| bytes).sum::<u64>());
        frames.push(frame);
        assert!(frames.len() < 10_000, "the queue drains");
    }
    frames
}

/// 40 MiB queued at mobile-mid's 3 MiB spread over at least 14 frames; each frame holds at most
/// 3 MiB, or one asset alone (here a 5 MiB one, the only frame over the budget); every asset goes
/// exactly once, in order.
#[test]
fn forty_mib_at_mobile_mid_spreads_over_at_least_fourteen_frames_each_within_three_mib_or_one_asset() {
    let budget = mobile_mid();
    assert_eq!(budget.upload_bytes, 3 * MIB);
    let mut sizes = mixed_sizes(35 * MIB);
    sizes.insert(9, 5 * MIB);
    assert_eq!(sizes.iter().sum::<u64>(), 40 * MIB);
    let mut queue = UploadQueue::new();
    for (index, bytes) in sizes.iter().enumerate() {
        queue.push(Priority::Visible, *bytes, (index, *bytes));
    }
    assert_eq!(queue.bytes(), 40 * MIB);
    let frames = frames(&mut queue, budget);
    assert!(frames.len() >= 14, "{} frames", frames.len());
    eprintln!("40 MiB at mobile-mid: {} frames", frames.len());
    let mut over = 0;
    for (at, frame) in frames.iter().enumerate() {
        let bytes: u64 = frame.iter().map(|(_, bytes)| bytes).sum();
        if bytes > budget.upload_bytes {
            over += 1;
            assert_eq!(frame.len(), 1, "frame {at} holds {bytes} B in {} assets", frame.len());
        }
    }
    assert_eq!(over, 1, "only the 5 MiB asset's frame is over the budget");
    let order: Vec<usize> = frames.iter().flatten().map(|(index, _)| *index).collect();
    assert_eq!(order, (0..sizes.len()).collect::<Vec<_>>());
}

/// The hard cap is untouched: a 33 MiB frame table is still refused `upload-budget`, and 32 MiB
/// still fits (characterization of `caps.rs`).
#[test]
fn the_hard_cap_still_refuses_a_33_mib_frame_table() {
    assert_eq!(UPLOAD_MAX_BYTES_PER_FRAME, 32 * MIB);
    let refused = UploadBudget::new().charge(33 * MIB).expect_err("33 MiB is over the hard cap");
    assert_eq!(refused.code(), RenderCode::UploadBudget);
    let mut fits = UploadBudget::new();
    fits.charge(32 * MIB).expect("32 MiB fits");
    assert_eq!(fits.used(), 32 * MIB);
}

/// An asset larger than the budget waits for a frame of its own, and the frame after it starts
/// with what came next; one at the front of an empty queue goes at once, alone.
#[test]
fn an_oversize_asset_goes_alone_in_an_empty_frame() {
    let mut queue = UploadQueue::new();
    let mut clock = ticking(0.01);
    for (index, bytes) in [MIB, 4 * MIB, MIB].into_iter().enumerate() {
        queue.push(Priority::Visible, bytes, index);
    }
    let mut went = Vec::new();
    let first = queue.drain(2 * MIB, 2.0, &mut clock, |index| went.push(index));
    assert_eq!((went.as_slice(), first.stop, first.left), (&[0][..], UploadStop::Bytes, 2));
    went.clear();
    let second = queue.drain(2 * MIB, 2.0, &mut clock, |index| went.push(index));
    assert_eq!((went.as_slice(), second.bytes, second.stop), (&[1][..], 4 * MIB, UploadStop::Bytes));
    went.clear();
    let third = queue.drain(2 * MIB, 2.0, &mut clock, |index| went.push(index));
    assert_eq!((went.as_slice(), third.stop, third.left, third.left_bytes), (&[2][..], UploadStop::Empty, 0, 0));
}

/// The millisecond budget stops the drain after the upload that reaches it, at least one upload
/// goes even when it alone is dearer than the budget, and the rest wait in place.
#[test]
fn the_ms_budget_stops_after_the_upload_that_reaches_it() {
    let mut queue = UploadQueue::new();
    for index in 0..10 {
        queue.push(Priority::Prefetch, KIB, index);
    }
    // 0.3 ms per upload against 1.0 ms: the fourth reaches it.
    let report = queue.drain(MIB, FINISH_BUDGET_PHONE_MS, &mut ticking(0.3), |_| {});
    assert_eq!((report.uploaded, report.left, report.stop), (4, 6, UploadStop::Time));
    let dear = queue.drain(MIB, FINISH_BUDGET_PHONE_MS, &mut ticking(5.0), |_| {});
    assert_eq!((dear.uploaded, dear.left, dear.stop), (1, 5, UploadStop::Time));
    let mut rest = Vec::new();
    queue.drain(MIB, FINISH_BUDGET_PHONE_MS, &mut ticking(0.01), |index| rest.push(index));
    assert_eq!(rest, vec![5, 6, 7, 8, 9]);
}

/// Lanes go most urgent first and in order within a lane; a big upload at the front of a lane is
/// not overtaken by smaller ones behind it.
#[test]
fn uploads_go_by_priority_then_in_order_and_nothing_overtakes_a_waiting_one() {
    let mut queue = UploadQueue::new();
    queue.push(Priority::Prefetch, KIB, "p0");
    queue.push(Priority::Visible, KIB, "v0");
    queue.push(Priority::Prefetch, KIB, "p1");
    queue.push(Priority::Sim, KIB, "s0");
    queue.push(Priority::Visible, 3 * KIB, "v1");
    queue.push(Priority::Visible, KIB, "v2");
    let mut went = Vec::new();
    queue.drain(4 * KIB, 2.0, &mut ticking(0.01), |name| went.push(name));
    assert_eq!(went, vec!["s0", "v0"], "v1 does not fit and nothing behind it jumps ahead");
    went.clear();
    queue.drain(4 * KIB, 2.0, &mut ticking(0.01), |name| went.push(name));
    assert_eq!(went, vec!["v1", "v2"]);
    went.clear();
    queue.drain(4 * KIB, 2.0, &mut ticking(0.01), |name| went.push(name));
    assert_eq!(went, vec!["p0", "p1"]);
}

/// A cancelled upload never goes, whether it was pushed on the frame thread or handed in from a
/// job thread; uploads handed in from other threads join their lanes at the next drain.
#[test]
fn a_cancelled_upload_never_goes_and_handed_in_uploads_join_at_the_next_drain() {
    let mut queue = UploadQueue::new();
    let kept = queue.push(Priority::Visible, KIB, 0);
    let dropped = queue.push(Priority::Visible, KIB, 1);
    let inbox = queue.inbox();
    let handed = std::thread::spawn(move || (inbox.push(Priority::Sim, KIB, 2), inbox.push(Priority::Sim, KIB, 3)))
        .join()
        .expect("the job thread hands in");
    assert_eq!(queue.len(), 4);
    assert_eq!(queue.cancel(dropped), Some(1));
    assert_eq!(queue.cancel(handed.1), Some(3));
    assert_eq!(queue.cancel(dropped), None, "already cancelled");
    let mut went = Vec::new();
    queue.drain(MIB, 2.0, &mut ticking(0.01), |item| went.push(item));
    assert_eq!(went, vec![2, 0]);
    assert_eq!(queue.cancel(kept), None, "already went");
    assert!(queue.is_empty());
}

/// The budget rows (plan section 10): desktop 24/16/8/6 MiB, web at most 8, phones 4/3/2; the
/// finish milliseconds are the job pool's.
#[test]
fn the_stream_budget_rows_follow_the_plan() {
    let desktop = [(PerformanceTier::Ultra, 24), (PerformanceTier::High, 16), (PerformanceTier::Mid, 8), (PerformanceTier::Low, 6)];
    for (tier, mib) in desktop {
        let budget = stream_budget(class(FormFactor::Desktop, tier), TargetOs::MacOs);
        assert_eq!(budget, StreamBudget { upload_bytes: mib * MIB, finish_ms: FINISH_BUDGET_DESKTOP_MS }, "{tier:?}");
        let web = stream_budget(class(FormFactor::Desktop, tier), TargetOs::Web);
        assert_eq!(web.upload_bytes, (mib * MIB).min(8 * MIB), "web {tier:?}");
    }
    let phones = [(PerformanceTier::Ultra, 4), (PerformanceTier::High, 4), (PerformanceTier::Mid, 3), (PerformanceTier::Low, 2)];
    for (tier, mib) in phones {
        for os in [TargetOs::Ios, TargetOs::Android, TargetOs::Web] {
            let budget = stream_budget(class(FormFactor::Mobile, tier), os);
            assert_eq!(budget, StreamBudget { upload_bytes: mib * MIB, finish_ms: FINISH_BUDGET_PHONE_MS }, "{tier:?} {os:?}");
        }
    }
    for class in DeviceClass::ALL {
        assert!(stream_budget(class, TargetOs::current()).upload_bytes < UPLOAD_MAX_BYTES_PER_FRAME, "{}", class.wire());
    }
}

fn gpu() -> Option<Gpu> {
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    match Gpu::headless() {
        Ok(gpu) => {
            if require {
                assert_eq!(gpu.receipt().backend, "metal", "GENEX_REQUIRE_METAL=1 but the adapter is not Metal");
            }
            Some(gpu)
        }
        Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
        Err(error) => {
            eprintln!("skipped: no WebGPU-core adapter ({error})");
            None
        }
    }
}

/// A byte pattern no two offsets of a buffer share in their low bytes.
fn pattern(offset: u64, bytes: u64) -> Vec<u8> {
    (offset..offset + bytes).map(|at| (at.wrapping_mul(2_654_435_761) >> 13) as u8).collect()
}

/// Streamed buffer writes drained through the queue at mobile-mid land whole: 12 MiB of uploads
/// (one of them 4 MiB, over the budget) go over at least four frames, one submission each, no
/// frame over 3 MiB but the oversize one, and the buffer reads back byte for byte.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_streamed_writes_drained_under_the_budget_read_back_whole() {
    let Some(gpu) = gpu() else { return };
    let budget = mobile_mid();
    let mut sizes = mixed_sizes(8 * MIB);
    sizes.insert(3, 4 * MIB);
    let total: u64 = sizes.iter().sum();
    let target = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("upload queue target"),
        size: total,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let mut queue = UploadQueue::new();
    let mut offset = 0;
    for bytes in &sizes {
        queue.push(Priority::Visible, *bytes, (offset, pattern(offset, *bytes)));
        offset += bytes;
    }
    let mut clock = ticking(0.01);
    let mut frame_bytes = Vec::new();
    while !queue.is_empty() {
        let mut written = 0u64;
        let mut count = 0;
        let report = queue.drain(budget.upload_bytes, budget.finish_ms, &mut clock, |(offset, data): (u64, Vec<u8>)| {
            gpu.queue.write_buffer(&target, offset, &data);
            written += data.len() as u64;
            count += 1;
        });
        assert_eq!(report.bytes, written);
        gpu.queue.submit([]);
        gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("the GPU finishes");
        assert!(written <= budget.upload_bytes || count == 1, "frame {} wrote {written} B in {count} uploads", frame_bytes.len());
        frame_bytes.push(written);
    }
    assert!(frame_bytes.len() >= 4, "{frame_bytes:?}");
    assert_eq!(frame_bytes.iter().sum::<u64>(), total);
    let staging = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("upload queue readback"),
        size: total,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("upload queue readback") });
    encoder.copy_buffer_to_buffer(&target, 0, &staging, 0, total);
    gpu.queue.submit([encoder.finish()]);
    staging.slice(..).map_async(wgpu::MapMode::Read, |result| result.expect("mapped"));
    gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
    let data = staging.slice(..).get_mapped_range().expect("mapped range").to_vec();
    assert!(data == pattern(0, total), "the buffer reads back as written");
    eprintln!("upload queue GPU row: {} frames, bytes per frame {frame_bytes:?}", frame_bytes.len());
}
