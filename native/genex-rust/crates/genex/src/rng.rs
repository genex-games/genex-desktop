//! PCG32 (O'Neill's `pcg32_random_r`, XSH RR 64/32): the only randomness a simulation may use,
//! seeded by `seed(n)`. The facade re-exports genex-core's golden-checked port of the C++
//! template's `studio::Rng`, so a facade game draws the same stream as `rng.golden.json`.
//!
//! [`GameRng`] is what an engine query that draws takes (`&mut impl GameRng`): a reset's
//! [`Pcg32`], or a tick's `ctx.rng` (passed as `&mut &ctx.rng`, since a hook holds `&Ctx`). Both
//! draw from the one seeded stream.

use crate::ctx::CtxRng;
pub use genex_core::rng::{GameRng, Pcg32};

impl GameRng for CtxRng<'_> {
    fn next_u32(&mut self) -> u32 {
        CtxRng::next_u32(self)
    }

    fn below(&mut self, bound: u32) -> u32 {
        CtxRng::below(self, bound)
    }

    fn unit(&mut self) -> f32 {
        CtxRng::unit(self)
    }

    fn range_f32(&mut self, lo: f32, hi: f32) -> f32 {
        CtxRng::range_f32(self, lo, hi)
    }
}

impl GameRng for &CtxRng<'_> {
    fn next_u32(&mut self) -> u32 {
        CtxRng::next_u32(self)
    }

    fn below(&mut self, bound: u32) -> u32 {
        CtxRng::below(self, bound)
    }

    fn unit(&mut self) -> f32 {
        CtxRng::unit(self)
    }

    fn range_f32(&mut self, lo: f32, hi: f32) -> f32 {
        CtxRng::range_f32(self, lo, hi)
    }
}
