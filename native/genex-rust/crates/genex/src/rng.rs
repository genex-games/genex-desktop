//! PCG32 (O'Neill's `pcg32_random_r`, XSH RR 64/32): the only randomness a simulation may use,
//! seeded by `seed(n)`. The facade re-exports genex-core's golden-checked port of the C++
//! template's `studio::Rng`, so a facade game draws the same stream as `rng.golden.json`.

pub use genex_core::rng::Pcg32;
