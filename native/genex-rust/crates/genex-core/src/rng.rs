//! The only randomness a simulation may use: PCG32 (O'Neill's `pcg32_random_r`, XSH RR 64/32),
//! ported from the C++ template's `rng.h`. Seeded by the studio's `seed(n)` and handed to a tick
//! as `ctx.rng`: the same seed gives the same stream on every destination.

/// The stream the runtime seeds when a game names none.
pub const DEFAULT_SEQUENCE: u64 = 54;
const MULTIPLIER: u64 = 6_364_136_223_846_793_005;
/// 2^-24: [`Pcg32::unit`] keeps 24 random bits, so every value is exact in an `f32`.
const UNIT_SCALE: f32 = 1.0 / 16_777_216.0;

/// A PCG32 stream.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pcg32 {
    state: u64,
    increment: u64,
}

impl Default for Pcg32 {
    /// Seed 1 on the default sequence, as the C++ `Rng()` starts.
    fn default() -> Self {
        Pcg32::seeded(1)
    }
}

impl Pcg32 {
    /// A stream started exactly as `pcg32_srandom_r(seed, sequence)` starts one.
    pub fn new(seed: u64, sequence: u64) -> Self {
        let mut rng = Pcg32 { state: 0, increment: 0 };
        rng.reseed(seed, sequence);
        rng
    }

    /// A stream on the default sequence.
    pub fn seeded(seed: u64) -> Self {
        Pcg32::new(seed, DEFAULT_SEQUENCE)
    }

    /// Restart the stream, exactly as `pcg32_srandom_r` does.
    pub fn reseed(&mut self, seed: u64, sequence: u64) {
        self.state = 0;
        self.increment = (sequence << 1) | 1;
        self.next_u32();
        self.state = self.state.wrapping_add(seed);
        self.next_u32();
    }

    /// The next 32 random bits.
    pub fn next_u32(&mut self) -> u32 {
        let old = self.state;
        self.state = old.wrapping_mul(MULTIPLIER).wrapping_add(self.increment);
        // Truncations are the algorithm: XSH keeps bits 27..59, the rotation is the top five bits.
        let shifted = (((old >> 18) ^ old) >> 27) as u32;
        let rotation = (old >> 59) as u32;
        shifted.rotate_right(rotation)
    }

    /// Uniform in `[0, bound)` without modulo bias; 0 when `bound` is 0.
    pub fn below(&mut self, bound: u32) -> u32 {
        if bound == 0 {
            return 0;
        }
        let threshold = bound.wrapping_neg() % bound;
        loop {
            let value = self.next_u32();
            if value >= threshold {
                return value % bound;
            }
        }
    }

    /// Uniform in `[lo, hi]`, both ends included; the ends may come in either order.
    pub fn range_i32(&mut self, lo: i32, hi: i32) -> i32 {
        let (lo, hi) = if hi < lo { (hi, lo) } else { (lo, hi) };
        let span = i64::from(hi) - i64::from(lo) + 1;
        let Ok(span) = u32::try_from(span) else {
            // The whole i32 range: every 32-bit pattern is one value.
            return self.next_u32().cast_signed();
        };
        let value = i64::from(lo) + i64::from(self.below(span));
        i32::try_from(value).unwrap_or(lo)
    }

    /// Uniform in `[0, 1)`: 24 random bits, so every value is exact in an `f32`.
    pub fn unit(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 * UNIT_SCALE
    }

    /// Uniform in `[lo, hi)`. Two roundings, a product then a sum: never one fused multiply-add
    /// (the C++ source means the same; Apple clang on arm64 fuses it unless told not to).
    pub fn range_f32(&mut self, lo: f32, hi: f32) -> f32 {
        lo + (hi - lo) * self.unit()
    }

    /// True with probability `p`.
    pub fn chance(&mut self, p: f32) -> bool {
        self.unit() < p
    }
}
