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

    /// The stream's position as `[state, increment]`, which a save stores so a load continues
    /// the stream exactly ([`Pcg32::from_parts`]).
    pub const fn parts(&self) -> [u64; 2] {
        [self.state, self.increment]
    }

    /// The stream at a position [`Pcg32::parts`] answered. The increment is made odd, as PCG's
    /// always is, so an even one from a hostile save still gives a full-period stream.
    pub const fn from_parts(parts: [u64; 2]) -> Self {
        Pcg32 { state: parts[0], increment: parts[1] | 1 }
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

/// What a deterministic query draws from: the reset's [`Pcg32`] or a tick's `ctx.rng` (the facade
/// implements it for `CtxRng`). Engine crates take `&mut impl GameRng`, never a generator of their
/// own, so every draw comes from the seeded stream.
pub trait GameRng {
    /// The next 32 random bits.
    fn next_u32(&mut self) -> u32;
    /// Uniform in `[0, bound)`; 0 when `bound` is 0.
    fn below(&mut self, bound: u32) -> u32;
    /// Uniform in `[0, 1)`.
    fn unit(&mut self) -> f32;
    /// Uniform in `[lo, hi)`.
    fn range_f32(&mut self, lo: f32, hi: f32) -> f32;
}

impl GameRng for Pcg32 {
    fn next_u32(&mut self) -> u32 {
        Pcg32::next_u32(self)
    }

    fn below(&mut self, bound: u32) -> u32 {
        Pcg32::below(self, bound)
    }

    fn unit(&mut self) -> f32 {
        Pcg32::unit(self)
    }

    fn range_f32(&mut self, lo: f32, hi: f32) -> f32 {
        Pcg32::range_f32(self, lo, hi)
    }
}

#[cfg(test)]
mod tests {
    use super::Pcg32;

    #[test]
    fn parts_restore_the_stream_exactly_where_it_was() {
        let mut rng = Pcg32::new(7, 3);
        for _ in 0..5 {
            rng.next_u32();
        }
        let mut restored = Pcg32::from_parts(rng.parts());
        assert_eq!(restored, rng);
        let ahead: Vec<u32> = (0..8).map(|_| rng.next_u32()).collect();
        let again: Vec<u32> = (0..8).map(|_| restored.next_u32()).collect();
        assert_eq!(again, ahead);
    }

    #[test]
    fn an_even_increment_from_a_hostile_save_is_made_odd() {
        let rng = Pcg32::from_parts([12, 40]);
        assert_eq!(rng.parts(), [12, 41], "PCG's increment is always odd");
        assert_eq!(Pcg32::seeded(1).parts()[1] % 2, 1);
    }
}
