// GPU particles (M2.6): a render-only compute emitter. Every particle is a pure function of the
// emitter and the tick (never of the frames drawn before), so Live and a capture agree whatever
// came first, and nothing here is read back: the checksum never sees it. The compute pass writes
// one row per slot (spawn rate × lifetime) and the indirect draw arguments; dead or unspawned
// slots are written transparent with no size. Slot order is the draw order, so blending is
// deterministic. Shares FrameUniforms with common.wgsl.

struct Particle {
    // xyz position, w size (0: not drawn).
    position_size: vec4<f32>,
    color: vec4<f32>,
}

