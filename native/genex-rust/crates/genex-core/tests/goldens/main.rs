//! genex-core against characterization goldens taken from the C++ template's own sources
//! (`tests/fixtures/genex-core-goldens`, written by `scripts/spike/rust-wgpu/extract-goldens.ts`):
//! every case the C++ answered is replayed through the port and must answer the same, bit for bit.

mod clock;
mod fnv;
mod input;
mod json;
mod paths;
mod protocol;
mod rng;
mod session;
mod support;
mod toy;
