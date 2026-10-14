//! What `audioLevel` answers: the rms and spectral centroid of the last [`AUDIO_WINDOW_FRAMES`]
//! frames the mixer played. A port of the C++ runtime's `AudioMeter` (`session.cpp`), with libm
//! for the window and the FFT twiddles so every target computes the same bits.

/// Frames the level is taken over.
pub const AUDIO_WINDOW_FRAMES: usize = 2048;
/// `audioLevel` reports rms to four decimals and the centroid in whole hertz, as the web probe does.
const RMS_SCALE: f64 = 10_000.0;
const STEREO: usize = 2;

/// What `audioLevel` answers.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct AudioLevel {
    /// Root mean square of every sample in the window: 0 for silence, 1 for a full-scale square wave.
    pub rms: f64,
    /// Spectral centroid of the window's mono mix, in Hz; 0 for silence.
    pub centroid: f64,
}

impl AudioLevel {
    /// The level as the verb reports it: rms to four decimals, the centroid in whole hertz.
    pub fn reported(self) -> AudioLevel {
        AudioLevel { rms: libm::round(self.rms * RMS_SCALE) / RMS_SCALE, centroid: libm::round(self.centroid) }
    }
}

/// The last [`AUDIO_WINDOW_FRAMES`] interleaved stereo frames the mixer played.
#[derive(Clone, Debug)]
pub struct AudioMeter {
    ring: Box<[f32]>,
    next: usize,
    filled: usize,
}

impl Default for AudioMeter {
    fn default() -> AudioMeter {
        AudioMeter { ring: vec![0.0; AUDIO_WINDOW_FRAMES * STEREO].into_boxed_slice(), next: 0, filled: 0 }
    }
}

impl AudioMeter {
    /// Remember interleaved stereo samples; a trailing half frame is dropped.
    pub fn feed(&mut self, samples: &[f32]) {
        let (frames, _half) = samples.as_chunks::<STEREO>();
        for [left, right] in frames {
            self.ring[self.next * STEREO] = *left;
            self.ring[self.next * STEREO + 1] = *right;
            self.next = (self.next + 1) % AUDIO_WINDOW_FRAMES;
            self.filled = (self.filled + 1).min(AUDIO_WINDOW_FRAMES);
        }
    }

    /// The level of what is in the window, the centroid at `sample_rate_hz`.
    pub fn level(&self, sample_rate_hz: f64) -> AudioLevel {
        if self.filled == 0 {
            return AudioLevel::default();
        }
        let first = (self.next + AUDIO_WINDOW_FRAMES - self.filled) % AUDIO_WINDOW_FRAMES;
        let mut squares = 0.0;
        let mut mono = Vec::with_capacity(self.filled);
        for i in 0..self.filled {
            let frame = (first + i) % AUDIO_WINDOW_FRAMES;
            let left = finite_sample(self.ring[frame * STEREO]);
            let right = finite_sample(self.ring[frame * STEREO + 1]);
            squares += left * left + right * right;
            mono.push((left + right) / 2.0);
        }
        // At most 2 * 2048 samples: exact in f64.
        let count = (mono.len() * STEREO) as f64;
        AudioLevel { rms: libm::sqrt(squares / count), centroid: centroid_of(&mono, sample_rate_hz) }
    }
}

/// A mixed sample as the device plays it: clipped to full scale, and anything not finite (a broken
/// effect's output) as silence, so the level is always a finite number.
fn finite_sample(sample: f32) -> f64 {
    if sample.is_finite() { f64::from(sample).clamp(-1.0, 1.0) } else { 0.0 }
}

#[derive(Clone, Copy, Debug, Default)]
struct Complex {
    re: f64,
    im: f64,
}

impl Complex {
    fn add(self, other: Complex) -> Complex {
        Complex { re: self.re + other.re, im: self.im + other.im }
    }

    fn sub(self, other: Complex) -> Complex {
        Complex { re: self.re - other.re, im: self.im - other.im }
    }

    fn mul(self, other: Complex) -> Complex {
        Complex { re: self.re * other.re - self.im * other.im, im: self.re * other.im + self.im * other.re }
    }

    fn abs(self) -> f64 {
        libm::hypot(self.re, self.im)
    }
}

/// In-place radix-2 FFT; `values.len()` is a power of two.
fn fft(values: &mut [Complex]) {
    let n = values.len();
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if i < j {
            values.swap(i, j);
        }
    }
    let mut length = 2;
    while length <= n {
        let angle = -2.0 * core::f64::consts::PI / length as f64;
        let step = Complex { re: libm::cos(angle), im: libm::sin(angle) };
        for start in (0..n).step_by(length) {
            let mut turn = Complex { re: 1.0, im: 0.0 };
            for k in 0..length / 2 {
                let even = values[start + k];
                let odd = values[start + k + length / 2].mul(turn);
                values[start + k] = even.add(odd);
                values[start + k + length / 2] = even.sub(odd);
                turn = turn.mul(step);
            }
        }
        length <<= 1;
    }
}

/// The magnitude-weighted mean frequency of `mono` (Hann-windowed, zero-padded to the window).
fn centroid_of(mono: &[f64], sample_rate_hz: f64) -> f64 {
    let mut bins = vec![Complex::default(); AUDIO_WINDOW_FRAMES];
    let length = mono.len() as f64;
    for (i, sample) in mono.iter().enumerate() {
        let hann = 0.5 - 0.5 * libm::cos(2.0 * core::f64::consts::PI * i as f64 / length);
        bins[i] = Complex { re: sample * hann, im: 0.0 };
    }
    fft(&mut bins);
    let mut weighted = 0.0;
    let mut total = 0.0;
    for (k, bin) in bins.iter().enumerate().take(AUDIO_WINDOW_FRAMES / 2 + 1).skip(1) {
        let magnitude = bin.abs();
        weighted += magnitude * k as f64 * sample_rate_hz / AUDIO_WINDOW_FRAMES as f64;
        total += magnitude;
    }
    if total > 0.0 { weighted / total } else { 0.0 }
}
