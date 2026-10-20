//! The device side with no device: a [`NullOutput`] drains a [`SinkQueue`] exactly as the cpal
//! callback does, so these rows hold for every destination's output. No sample leaves before the
//! class's prefill, an overflowing queue drops its oldest samples, a starved callback counts one
//! underrun however short it fell, the queue reports what it holds in milliseconds, and every cpal
//! stream error is a typed [`DeviceFault`] (or no fault) by a table. No test opens a device.

use genex_audio::{
    AudioOutput, DeviceFault, FRAMES_PER_TICK, MIXER_RATE_HZ, NullOutput, PoolClass, SinkQueue, capacity_ticks, prefill_ticks,
    stream_fault,
};

const STEREO: usize = 2;
const TICK_SAMPLES: usize = FRAMES_PER_TICK * STEREO;

/// A tick's block whose samples count up from `from`, so a test sees which samples left.
fn block(from: usize) -> Vec<f32> {
    (from..from + TICK_SAMPLES).map(|i| i as f32).collect()
}

/// One device callback at the mixer's rate: `frames` stereo frames.
fn callback(output: &mut NullOutput, frames: usize) -> Vec<f32> {
    let mut out = vec![f32::NAN; frames * STEREO];
    output.pull(&mut out);
    out
}

#[test]
fn no_sample_leaves_before_the_class_prefill() {
    for (class, ticks) in [(PoolClass::Desktop, 3), (PoolClass::Web, 6), (PoolClass::Phone, 6)] {
        assert_eq!(prefill_ticks(class), ticks, "{class:?}");
        let queue = SinkQueue::for_class(class);
        let mut output = NullOutput::open(queue.clone(), class, MIXER_RATE_HZ, STEREO);
        for tick in 0..ticks - 1 {
            queue.push(&block(tick * TICK_SAMPLES));
            assert!(callback(&mut output, 64).iter().all(|sample| *sample == 0.0), "{class:?} tick {tick}: silence while priming");
        }
        assert_eq!(queue.len(), (ticks - 1) * TICK_SAMPLES, "{class:?}: nothing was taken");
        assert_eq!(queue.underruns(), 0, "{class:?}: priming is not an underrun");
        queue.push(&block((ticks - 1) * TICK_SAMPLES));
        let first = callback(&mut output, 4);
        assert_eq!(first, [0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0], "{class:?}: the oldest samples play first once primed");
    }
}

/// Characterization of the existing rule: past the capacity the oldest samples go, so a stalled
/// device catches up with the game instead of lagging behind it.
#[test]
fn an_overflowing_queue_drops_its_oldest_samples() {
    for class in [PoolClass::Desktop, PoolClass::Web, PoolClass::Phone] {
        let queue = SinkQueue::for_class(class);
        let capacity = capacity_ticks(class) * TICK_SAMPLES;
        assert_eq!(queue.capacity(), capacity, "{class:?}");
        assert!(capacity_ticks(class) > prefill_ticks(class), "{class:?}: the prefill fits");
        let extra = 3;
        for tick in 0..capacity_ticks(class) + extra {
            queue.push(&block(tick * TICK_SAMPLES));
        }
        assert_eq!(queue.len(), capacity, "{class:?}");
        assert_eq!(queue.dropped(), (extra * TICK_SAMPLES) as u64, "{class:?}");
        let mut output = NullOutput::open(queue.clone(), class, MIXER_RATE_HZ, STEREO);
        let first = callback(&mut output, 1);
        assert_eq!(first, [(extra * TICK_SAMPLES) as f32, (extra * TICK_SAMPLES + 1) as f32], "{class:?}: the newest samples win");
    }
    let legacy = SinkQueue::with_capacity(4);
    legacy.push(&[1.0, 2.0, 3.0, 4.0, 5.0, 6.0]);
    let mut out = [0.0_f32; 5];
    legacy.drain_into(&mut out);
    assert_eq!(out, [3.0, 4.0, 5.0, 6.0, 0.0], "a queue made with a bare capacity has no prefill");
}

/// A callback the queue cannot fill counts one underrun, however many samples it lacked; the
/// queue then primes again (its callbacks are silence, not underruns) and the next starved
/// callback counts again.
#[test]
fn a_starved_callback_counts_one_underrun() {
    let class = PoolClass::Desktop;
    let queue = SinkQueue::for_class(class);
    let mut output = NullOutput::open(queue.clone(), class, MIXER_RATE_HZ, STEREO);
    for tick in 0..3 {
        queue.push(&block(tick * TICK_SAMPLES));
    }
    let played = callback(&mut output, 3 * FRAMES_PER_TICK - 10);
    assert_eq!(played[0], 0.0);
    assert_eq!(queue.underruns(), 0, "a full callback is no underrun");
    let short = callback(&mut output, 512);
    assert_eq!(queue.underruns(), 1, "500 frames short is one underrun");
    assert_eq!(&short[..20], &block(3 * TICK_SAMPLES - 20)[..20], "the last ten frames, then silence");
    assert!(short[20..].iter().all(|sample| *sample == 0.0), "the rest is silence");
    for _ in 0..4 {
        assert!(callback(&mut output, 512).iter().all(|sample| *sample == 0.0));
    }
    assert_eq!(queue.underruns(), 1, "re-priming callbacks are not underruns");
    for tick in 3..6 {
        queue.push(&block(tick * TICK_SAMPLES));
    }
    assert_eq!(callback(&mut output, 1), [(3 * TICK_SAMPLES) as f32, (3 * TICK_SAMPLES + 1) as f32], "primed again");
    callback(&mut output, 4 * FRAMES_PER_TICK);
    assert_eq!(queue.underruns(), 2, "the next starved callback counts again");
}

/// A device at another rate takes source frames at the rate ratio through one drain per callback,
/// so a starved resampled callback still counts once.
#[test]
fn a_resampled_callback_drains_once_and_counts_once() {
    let class = PoolClass::Web;
    let queue = SinkQueue::for_class(class);
    let mut output = NullOutput::open(queue.clone(), class, MIXER_RATE_HZ / 2, 1);
    for tick in 0..prefill_ticks(class) {
        queue.push(&block(tick * TICK_SAMPLES));
    }
    let before = queue.len();
    let mut out = vec![0.0; 100];
    output.pull(&mut out);
    assert_eq!(before - queue.len(), 200 * STEREO, "100 frames at half the rate take 200 source frames");
    assert_eq!(queue.underruns(), 0);
    let mut long = vec![0.0; prefill_ticks(class) * FRAMES_PER_TICK];
    output.pull(&mut long);
    assert_eq!(queue.underruns(), 1, "one starved callback");
}

#[test]
fn the_queue_reports_what_it_holds_in_milliseconds() {
    let queue = SinkQueue::for_class(PoolClass::Phone);
    assert_eq!(queue.queued_ms(), 0.0);
    for tick in 0..3 {
        queue.push(&block(tick * TICK_SAMPLES));
    }
    assert!((queue.queued_ms() - 50.0).abs() < 1e-9, "three ticks are 50 ms: {}", queue.queued_ms());
}

/// Every cpal stream error maps to a typed fault or to none (the stream goes on); nothing is only
/// printed.
#[test]
fn every_cpal_stream_error_is_a_typed_fault_or_none() {
    use cpal::ErrorKind;
    let rows = [
        (ErrorKind::DeviceNotAvailable, Some(DeviceFault::DeviceLost)),
        (ErrorKind::HostUnavailable, Some(DeviceFault::DeviceLost)),
        (ErrorKind::StreamInvalidated, Some(DeviceFault::DeviceLost)),
        (ErrorKind::DeviceBusy, Some(DeviceFault::DeviceLost)),
        (ErrorKind::PermissionDenied, Some(DeviceFault::DeviceLost)),
        (ErrorKind::ResourceExhausted, Some(DeviceFault::DeviceLost)),
        (ErrorKind::BackendError, Some(DeviceFault::DeviceLost)),
        (ErrorKind::Other, Some(DeviceFault::DeviceLost)),
        (ErrorKind::InvalidInput, Some(DeviceFault::DeviceLost)),
        (ErrorKind::UnsupportedConfig, Some(DeviceFault::DeviceLost)),
        (ErrorKind::UnsupportedOperation, Some(DeviceFault::DeviceLost)),
        (ErrorKind::Xrun, Some(DeviceFault::Underrun)),
        (ErrorKind::DeviceChanged, None),
        (ErrorKind::RealtimeDenied, None),
    ];
    for (kind, fault) in rows {
        assert_eq!(stream_fault(kind), fault, "{kind:?}");
    }
    let _never_called: fn(SinkQueue, PoolClass) -> Result<AudioOutput, DeviceFault> = AudioOutput::open;
}
