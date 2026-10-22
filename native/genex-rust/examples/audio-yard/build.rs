//! Synthesizes audio-yard's short sounds into 16-bit mono WAV files in `OUT_DIR`, so the example
//! carries no third-party audio and no binary sound files in the tree. Every sample is a pure
//! function of its index (a fixed xorshift seed for the noise), so every build writes the same
//! bytes. `src/lib.rs` compiles the files into the asset table.

use std::f64::consts::TAU;
use std::path::Path;

/// The rate of the synthesized sounds (the mixer resamples to 48 kHz).
const RATE: u32 = 24_000;
/// The click is short and bright: it keeps the mixer's own rate.
const CLICK_RATE: u32 = 48_000;
const NOISE_SEED: u32 = 0x9e37_79b9;

/// A deterministic white-noise source in -1..1.
struct Noise(u32);

impl Noise {
    fn next(&mut self) -> f64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        f64::from(x) / f64::from(u32::MAX) * 2.0 - 1.0
    }
}

/// A two-pole band-pass resonator (RBJ constant 0 dB peak gain).
struct Resonator {
    b0: f64,
    a1: f64,
    a2: f64,
    x1: f64,
    x2: f64,
    y1: f64,
    y2: f64,
}

impl Resonator {
    fn new(freq: f64, q: f64, rate: u32) -> Resonator {
        let w = TAU * freq / f64::from(rate);
        let alpha = w.sin() / (2.0 * q);
        let a0 = 1.0 + alpha;
        Resonator { b0: alpha / a0, a1: -2.0 * w.cos() / a0, a2: (1.0 - alpha) / a0, x1: 0.0, x2: 0.0, y1: 0.0, y2: 0.0 }
    }

    fn tune(&mut self, freq: f64, q: f64, rate: u32) {
        let fresh = Resonator::new(freq, q, rate);
        (self.b0, self.a1, self.a2) = (fresh.b0, fresh.a1, fresh.a2);
    }

    fn run(&mut self, x: f64) -> f64 {
        let y = self.b0 * x - self.b0 * self.x2 - self.a1 * self.y1 - self.a2 * self.y2;
        (self.x2, self.x1, self.y2, self.y1) = (self.x1, x, self.y1, y);
        y
    }
}

fn frames(rate: u32, seconds: f64) -> usize {
    (f64::from(rate) * seconds).round() as usize
}

/// A footstep on gravel: a low-passed noise burst over a short thump, then the gravel settling.
fn footstep() -> Vec<f64> {
    let mut noise = Noise(NOISE_SEED);
    let mut low = 0.0;
    (0..frames(RATE, 0.5))
        .map(|i| {
            let t = i as f64 / f64::from(RATE);
            let white = noise.next();
            low += 0.3 * (white - low);
            let settle = white * (-t / 0.12).exp() * 0.08;
            low * (-t / 0.025).exp() * 1.4 + (TAU * 90.0 * t).sin() * (-t / 0.03).exp() * 0.5 + settle
        })
        .collect()
}

/// A gunshot: a bright crack, a darker body and a 55 Hz thump.
fn gunshot() -> Vec<f64> {
    let mut noise = Noise(NOISE_SEED ^ 0x5a5a);
    let mut body = 0.0;
    (0..frames(RATE, 0.4))
        .map(|i| {
            let t = i as f64 / f64::from(RATE);
            let white = noise.next();
            body += 0.12 * (white - body);
            white * (-t / 0.008).exp() * 0.7 + body * (-t / 0.08).exp() * 2.0 + (TAU * 55.0 * t).sin() * (-t / 0.06).exp() * 0.6
        })
        .collect()
}

/// Radio dialogue: a glottal pulse train through two formants that change every syllable.
fn dialogue() -> Vec<f64> {
    const VOWELS: [(f64, f64); 5] = [(700.0, 1220.0), (300.0, 2300.0), (450.0, 1900.0), (350.0, 800.0), (600.0, 1000.0)];
    const SYLLABLE_S: f64 = 0.2;
    let (mut f1, mut f2) = (Resonator::new(VOWELS[0].0, 8.0, RATE), Resonator::new(VOWELS[0].1, 10.0, RATE));
    let mut phase = 0.0;
    let mut vowel = usize::MAX;
    (0..frames(RATE, 2.4))
        .map(|i| {
            let t = i as f64 / f64::from(RATE);
            let syllable = (t / SYLLABLE_S) as usize;
            if syllable != vowel {
                vowel = syllable;
                let (a, b) = VOWELS[(syllable * 3 + syllable / 4) % VOWELS.len()];
                f1.tune(a, 8.0, RATE);
                f2.tune(b, 10.0, RATE);
            }
            let pitch = 120.0 + 18.0 * (TAU * 0.7 * t).sin();
            phase = (phase + pitch / f64::from(RATE)) % 1.0;
            let pulse = if phase < 0.08 { 1.0 } else { 0.0 };
            let within = (t % SYLLABLE_S) / SYLLABLE_S;
            let envelope = if within < 0.8 { (std::f64::consts::PI * within / 0.8).sin() } else { 0.0 };
            (f1.run(pulse) * 3.0 + f2.run(pulse) * 2.0) * envelope
        })
        .collect()
}

/// A UI click: a 2 kHz blip.
fn click() -> Vec<f64> {
    (0..frames(CLICK_RATE, 0.03))
        .map(|i| {
            let t = i as f64 / f64::from(CLICK_RATE);
            (TAU * 2000.0 * t).sin() * (-t / 0.004).exp() * 0.8
        })
        .collect()
}

/// A drone's rotor: six harmonics of 100 Hz under a 25 Hz flutter; a whole number of cycles, so it
/// loops without a seam.
fn drone() -> Vec<f64> {
    (0..frames(RATE, 1.0))
        .map(|i| {
            let t = i as f64 / f64::from(RATE);
            let tone: f64 = (1..=6).map(|k| (TAU * 100.0 * f64::from(k) * t).sin() / f64::from(k)).sum();
            tone * (0.7 + 0.3 * (TAU * 25.0 * t).sin()) * 0.35
        })
        .collect()
}

/// A generator's mains hum: 50 Hz and three harmonics; loops without a seam.
fn hum() -> Vec<f64> {
    (0..frames(RATE, 1.0))
        .map(|i| {
            let t = i as f64 / f64::from(RATE);
            [(50.0, 0.5), (100.0, 0.3), (150.0, 0.2), (200.0, 0.1)].iter().map(|(f, a)| (TAU * f * t).sin() * a).sum::<f64>() * 0.6
        })
        .collect()
}

/// A cricket: three 30 ms chirps of a 4.5 kHz carrier, then quiet; loops without a seam.
fn cricket() -> Vec<f64> {
    (0..frames(RATE, 0.6))
        .map(|i| {
            let t = i as f64 / f64::from(RATE);
            let pulse = (t / 0.05) as usize;
            let within = t % 0.05;
            let on = pulse < 3 && within < 0.03;
            if on { (TAU * 4500.0 * t).sin() * (std::f64::consts::PI * within / 0.03).sin() * 0.3 } else { 0.0 }
        })
        .collect()
}

/// A water drip in the cave: a sine sweeping up from 900 Hz, decaying.
fn drip() -> Vec<f64> {
    let mut phase = 0.0;
    (0..frames(RATE, 0.25))
        .map(|i| {
            let t = i as f64 / f64::from(RATE);
            phase += (900.0 + 2400.0 * t) / f64::from(RATE);
            (TAU * phase).sin() * (-t / 0.04).exp() * 0.6
        })
        .collect()
}

/// `samples` as a 16-bit PCM mono WAV at `rate`.
fn wav(samples: &[f64], rate: u32) -> Vec<u8> {
    let data_bytes = u32::try_from(samples.len() * 2).expect("a short sound");
    let mut bytes = Vec::with_capacity(44 + samples.len() * 2);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + data_bytes).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&rate.to_le_bytes());
    bytes.extend_from_slice(&(rate * 2).to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&16u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_bytes.to_le_bytes());
    for sample in samples {
        let value = (sample.clamp(-1.0, 1.0) * f64::from(i16::MAX)).round() as i16;
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes
}

fn main() {
    println!("cargo::rerun-if-changed=build.rs");
    let out = std::env::var_os("OUT_DIR").expect("cargo sets OUT_DIR");
    let sounds: [(&str, Vec<f64>, u32); 8] = [
        ("footstep", footstep(), RATE),
        ("gunshot", gunshot(), RATE),
        ("dialogue", dialogue(), RATE),
        ("click", click(), CLICK_RATE),
        ("drone", drone(), RATE),
        ("hum", hum(), RATE),
        ("cricket", cricket(), RATE),
        ("drip", drip(), RATE),
    ];
    for (name, samples, rate) in sounds {
        std::fs::write(Path::new(&out).join(format!("{name}.wav")), wav(&samples, rate)).expect("the sound writes");
    }
}
