//! The desktop audio device: a cpal output stream that plays the blocks the simulated-clock mixer
//! already rendered ([`SinkQueue`]), resampled from [`MIXER_RATE_HZ`] to the device's rate. The
//! device never pulls from kira, so it can change nothing the game or `audioLevel` sees. iOS's
//! audio session and Android's audio focus are their shells' (M5); the web plays through Web Audio.

use crate::mixer::{AudioError, AudioErrorCode, MIXER_RATE_HZ};
use crate::sink::SinkQueue;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

const STEREO: usize = 2;

/// Converts the mixer's interleaved stereo at [`MIXER_RATE_HZ`] to a device's rate and channel
/// count by linear interpolation, carrying its position across callbacks.
#[derive(Clone, Debug)]
pub struct Resampler {
    device_rate: u32,
    /// Position in source frames of the next output frame, past `previous`.
    position: f64,
    previous: [f32; STEREO],
    next: [f32; STEREO],
}

impl Resampler {
    /// A resampler to `device_rate` Hz.
    pub fn new(device_rate: u32) -> Resampler {
        // Two source frames are pulled before the first output: the interpolation's two ends.
        Resampler { device_rate: device_rate.max(1), position: 2.0, previous: [0.0; STEREO], next: [0.0; STEREO] }
    }

    /// Fill `out` (interleaved, `channels` per frame) from `queue`; the first two channels carry
    /// left and right (a mono device gets their mean), any others silence.
    pub fn fill(&mut self, queue: &SinkQueue, out: &mut [f32], channels: usize) {
        let channels = channels.max(1);
        let step = f64::from(MIXER_RATE_HZ) / f64::from(self.device_rate);
        for frame in out.chunks_mut(channels) {
            while self.position >= 1.0 {
                self.previous = self.next;
                let mut pair = [0.0; STEREO];
                queue.drain_into(&mut pair);
                self.next = pair;
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

/// The open output stream; dropping it stops the sound.
pub struct DeviceOutput {
    _stream: cpal::Stream,
    rate: u32,
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
        let stream = device
            .build_output_stream(
                config,
                move |out: &mut [f32], _: &cpal::OutputCallbackInfo| resampler.fill(&queue, out, channels),
                // The studio reads the game's stderr into its log; the mixer and `audioLevel` go on.
                |error| eprintln!("genex-audio: the output device failed: {error}"),
                None,
            )
            .map_err(|e| failed(e.to_string()))?;
        stream.play().map_err(|e| failed(e.to_string()))?;
        Ok(DeviceOutput { _stream: stream, rate })
    }

    /// The device's sample rate, in Hz.
    pub fn rate(&self) -> u32 {
        self.rate
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
}
