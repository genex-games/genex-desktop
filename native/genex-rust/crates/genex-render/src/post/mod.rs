//! Post-processing nodes of the frame graph (plan §2.2): the HDR scene's way to the world target.
//! RQ1.0 registers the modules each RQ1 work package fills; later tiers add bloom, AO, TAA and the
//! upscaler here.

/// The tonemap node (graph node 21) and the luminance-weighted MSAA resolve (node 16): RQ1.1.
pub mod tonemap;
/// Auto and manual exposure (graph node 20): RQ1.2.
pub mod exposure;
/// Threshold-free, energy-conserving bloom (graph node 19): RQ4.0 contract, RQ4.2.
pub mod bloom;
/// GTAO with its own history (graph node 10): RQ4.0 contract, RQ4.4.
pub mod ao;
/// The sun's screen-space contact shadows (graph node 10a): RQ4.0 contract, RQ4.7.
pub mod contact_shadow;
/// The joint-bilateral upsample of half-resolution AO and contact shadows (RQ4 review).
pub mod upsample;
/// The sun-shadow screen mask with its own temporal and spatial filter (renderer pass 2, B.7).
pub mod sun_mask;
/// TAA and its reactive coverage (graph nodes 17 and 15a): RQ5.0 contract, RQ5.2.
pub mod taa;
/// The FSR1 upscaler, EASU + RCAS (graph node 22): RQ5.0 contract, RQ5.3.
pub mod fsr;
/// Colour grading in the tonemap: parametric knobs and a `.cube` LUT (A.2).
pub mod grading;
