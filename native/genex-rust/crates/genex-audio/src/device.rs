//! The audio device on every destination: a cpal output stream on the destination's default host
//! (CoreAudio on macOS and iOS, WASAPI, ALSA or PulseAudio, AAudio on Android, Web Audio on
//! wasm32) that plays the blocks the simulated-clock mixer already rendered ([`SinkQueue`]),
//! resampled from [`MIXER_RATE_HZ`] to the device's rate. The device never pulls from kira, so it
//! can change nothing the game or `audioLevel` sees. A stream error is a typed
//! [`DeviceFault`] the runtime reads ([`DeviceHealth`]), never only a line on stderr. iOS's audio
//! session and Android's audio focus are their shells'.

use crate::mixer::{AudioError, AudioErrorCode, MIXER_RATE_HZ};
use crate::output::{DeviceFault, stream_fault};
use crate::sink::{Drain, SinkQueue};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, AtomicU64, Ordering};

const STEREO: usize = 2;
/// Source frames a fresh resampler pulls before its first output: the interpolation's two ends.
const FRESH_POSITION: f64 = 2.0;
const NO_FAULT: u8 = 0;

/// Converts the mixer's interleaved stereo at [`MIXER_RATE_HZ`] to a device's rate and channel
/// count by linear interpolation, carrying its position across callbacks. Each callback drains the
/// queue once, so a starved callback counts one underrun.
#[derive(Clone, Debug)]
pub struct Resampler {
    device_rate: u32,
    /// Position in source frames of the next output frame, past `previous`.
    position: f64,
    previous: [f32; STEREO],
    next: [f32; STEREO],
    /// The source samples one callback drains (grown once to the largest callback).
    scratch: Vec<f32>,
}

impl Resampler {
    /// A resampler to `device_rate` Hz.
    pub fn new(device_rate: u32) -> Resampler {
        Resampler { device_rate: device_rate.max(1), position: FRESH_POSITION, previous: [0.0; STEREO], next: [0.0; STEREO], scratch: Vec::new() }
    }

    fn step(&self) -> f64 {
        f64::from(MIXER_RATE_HZ) / f64::from(self.device_rate)
    }

    /// Source frames `frames` output frames take from where the resampler stands.
    fn source_frames(&self, frames: usize) -> usize {
        let (step, mut position, mut taken) = (self.step(), self.position, 0);
        for _ in 0..frames {
            while position >= 1.0 {
                position -= 1.0;
                taken += 1;
            }
            position += step;
        }
        taken
    }

    /// Fill `out` (interleaved, `channels` per frame) from `queue`; the first two channels carry
    /// left and right (a mono device gets their mean), any others silence. While the queue primes,
    /// `out` is silence and the resampler starts fresh, so the first frame played is the first
    /// frame queued.
    pub fn fill(&mut self, queue: &SinkQueue, out: &mut [f32], channels: usize) {
        let channels = channels.max(1);
        let needed = self.source_frames(out.len().div_ceil(channels));
        self.scratch.clear();
        self.scratch.resize(needed * STEREO, 0.0);
        if queue.drain(&mut self.scratch) == Drain::Priming {
            out.fill(0.0);
            *self = Resampler { scratch: std::mem::take(&mut self.scratch), ..Resampler::new(self.device_rate) };
            return;
        }
        let step = self.step();
        let (pairs, _) = self.scratch.as_chunks::<STEREO>();
        let mut pairs = pairs.iter();
        for frame in out.chunks_mut(channels) {
            while self.position >= 1.0 {
                self.previous = self.next;
                self.next = pairs.next().copied().unwrap_or([0.0; STEREO]);
                self.position -= 1.0;
            }
            let t = self.position as f32;
            let left = self.previous[0] + (self.next[0] - self.previous[0]) * t;
            let right = self.previous[1] + (self.next[1] - self.previous[1]) * t;
            write_frame(frame, left, right);
            self.position += step;
        }
    }
}

fn write_frame(frame: &mut [f32], left: f32, right: f32) {
    match frame {
        [mono] => *mono = (left + right) / 2.0,
        [l, r, rest @ ..] => {
            *l = left;
            *r = right;
            rest.fill(0.0);
        }
        [] => {}
    }
}

/// What the device callback reports to the game: the last typed fault and how many there were.
#[derive(Debug, Default)]
pub struct DeviceHealth {
    fault: AtomicU8,
    faults: AtomicU64,
}

impl DeviceHealth {
    /// Record a stream error, typed by [`stream_fault`]; one that is no fault is ignored.
    pub fn report(&self, kind: cpal::ErrorKind) {
        if let Some(fault) = stream_fault(kind) {
            let code = DeviceFault::ALL.iter().position(|known| *known == fault).map_or(NO_FAULT, |index| index as u8 + 1);
            self.fault.store(code, Ordering::SeqCst);
            self.faults.fetch_add(1, Ordering::SeqCst);
        }
    }

    /// The last fault reported, if any.
    pub fn fault(&self) -> Option<DeviceFault> {
        let code = usize::from(self.fault.load(Ordering::SeqCst));
        code.checked_sub(1).and_then(|index| DeviceFault::ALL.get(index).copied())
    }

    /// Faults reported since the stream opened.
    pub fn faults(&self) -> u64 {
        self.faults.load(Ordering::SeqCst)
    }
}

/// The open output stream; dropping it stops the sound.
pub struct DeviceOutput {
    _stream: cpal::Stream,
    rate: u32,
    health: Arc<DeviceHealth>,
}

impl DeviceOutput {
    /// Open the default output device and play `queue` on it. Errs (`mixer-failed`) when there is
    /// no device or it takes no float stream; a game then runs silent, its `audioLevel` unchanged.
    pub fn open(queue: SinkQueue) -> Result<DeviceOutput, AudioError> {
        let failed = |detail: String| AudioError::new(AudioErrorCode::MixerFailed, detail);
        let device = cpal::default_host().default_output_device().ok_or_else(|| failed("no output device".into()))?;
        let supported = device.default_output_config().map_err(|e| failed(e.to_string()))?;
        if supported.sample_format() != cpal::SampleFormat::F32 {
            return Err(failed(format!("the device takes {:?}, not f32", supported.sample_format())));
        }
        let config = supported.config();
        let channels = usize::from(config.channels);
        let rate = config.sample_rate;
        let mut resampler = Resampler::new(rate);
        let health = Arc::new(DeviceHealth::default());
        let reported = health.clone();
        let stream = device
            .build_output_stream(
                config,
                move |out: &mut [f32], _: &cpal::OutputCallbackInfo| resampler.fill(&queue, out, channels),
                move |error| reported.report(error.kind()),
                None,
            )
            .map_err(|e| failed(e.to_string()))?;
        stream.play().map_err(|e| failed(e.to_string()))?;
        Ok(DeviceOutput { _stream: stream, rate, health })
    }

    /// The device's sample rate, in Hz.
    pub fn rate(&self) -> u32 {
        self.rate
    }

    /// What the device callback reported.
    pub fn health(&self) -> &DeviceHealth {
        &self.health
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_device_at_the_mixer_rate_plays_the_queue_as_it_is() {
        let queue = SinkQueue::with_capacity(64);
        queue.push(&[0.1, -0.1, 0.2, -0.2, 0.3, -0.3]);
        let mut resampler = Resampler::new(MIXER_RATE_HZ);
        let mut out = [9.0; 8];
        resampler.fill(&queue, &mut out, 2);
        assert_eq!(out, [0.1, -0.1, 0.2, -0.2, 0.3, -0.3, 0.0, 0.0], "then silence once the queue is empty");
    }

    #[test]
    fn a_slower_device_takes_frames_at_the_rate_ratio_and_a_mono_one_their_mean() {
        let queue = SinkQueue::with_capacity(1024);
        let ramp: Vec<f32> = (0..96).flat_map(|i| [i as f32, i as f32]).collect();
        queue.push(&ramp);
        let mut resampler = Resampler::new(MIXER_RATE_HZ / 2);
        let mut out = [0.0; 8];
        resampler.fill(&queue, &mut out, 1);
        assert_eq!(out, [0.0, 2.0, 4.0, 6.0, 8.0, 10.0, 12.0, 14.0]);
        let mut surround = [5.0; 12];
        Resampler::new(MIXER_RATE_HZ).fill(&SinkQueue::with_capacity(4), &mut surround, 6);
        assert_eq!(surround, [0.0; 12], "extra channels and an empty queue are silence");
    }

    #[test]
    fn a_stream_error_is_recorded_typed() {
        let health = DeviceHealth::default();
        assert_eq!((health.fault(), health.faults()), (None, 0));
        health.report(cpal::ErrorKind::DeviceChanged);
        assert_eq!((health.fault(), health.faults()), (None, 0), "a reroute is no fault");
        health.report(cpal::ErrorKind::Xrun);
        health.report(cpal::ErrorKind::DeviceNotAvailable);
        assert_eq!((health.fault(), health.faults()), (Some(DeviceFault::DeviceLost), 2));
    }
}
