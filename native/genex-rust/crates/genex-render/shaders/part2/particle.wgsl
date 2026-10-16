// GPU particles (M2.6): a render-only compute emitter. Every particle is a pure function of the
// emitter and the tick (never of the frames drawn before), so Live and a capture agree whatever
// came first, and nothing here is read back: the checksum never sees it. The compute pass writes
// one row per slot (spawn rate × lifetime) and the indirect draw arguments; dead or unspawned
// slots are written transparent with no size. Slot order is the draw order, or with the emitter
// sorted (renderer pass 2 A.11) the order of a bitonic sort by view depth and slot: blending is
// deterministic either way. Shares FrameUniforms with common.wgsl.

struct Particle {
    // xyz position, w size (0: not drawn).
    position_size: vec4<f32>,
    color: vec4<f32>,
}

// A particle's shape beside its row (renderer pass 2 A.11), row for row with `Particle`.
struct ParticleShape {
    // xyz: velocity (world units a tick, 0 once it has hit something); w: rotation (radians).
    motion: vec4<f32>,
    // x: life (0 at birth, 1 at death); y, z, w: reserved (0).
    life: vec4<f32>,
}

// Mirrors `particles::GpuEmitter`: what the compute, sort and draw passes read of one emitter.
struct Emitter {
    // xyz origin, w particle size (world units).
    origin: vec4<f32>,
    // xyz initial velocity (units per tick), w speed jitter (fraction of the speed).
    velocity: vec4<f32>,
    // xyz gravity (units per tick²), w spread (velocity jitter radius, units per tick).
    gravity: vec4<f32>,
    color_start: vec4<f32>,
    color_end: vec4<f32>,
    // x spawn rate per tick, y lifetime in ticks, z seed, w slots.
    params: vec4<u32>,
    // x: (spawned - 1) mod slots; y, z: spawned - 1 (low, high words); w: spawned slots (≤ slots).
    spawn: vec4<u32>,
    // x: size at death over size at birth; y: rotation jitter (radians either way); z: spin
    // (radians a tick); w: stretch along the motion (ticks of velocity; 0: a square billboard).
    shape: vec4<f32>,
    // x: soft distance (world units; 0: a hard intersection); y: depth collision thickness (world
    // units; 0: no collision); z: ticks a particle rests where it hit before it is gone; w: reserved.
    surface: vec4<f32>,
    // Flipbook: x columns, y rows, z frames, w cycles over a life (all 0: the round dot).
    book: vec4<f32>,
    // x: PARTICLE_FLAG_* bits; y: the draw stride (1: every slot; n: every n-th slot, the class's
    // particle cap); z, w: reserved.
    flags: vec4<u32>,
    // xyz: half the sides of the box around the origin particles spawn in; w: reserved.
    extent: vec4<f32>,
}

// `Emitter::flags.x` bits (`particles::flags`).
const PARTICLE_FLAG_SORTED: u32 = 1u;
const PARTICLE_FLAG_FLIPBOOK: u32 = 2u;
const PARTICLE_FLAG_BLEND_FRAMES: u32 = 4u;

// The sort's key of a slot nothing draws: after every drawn slot.
const PARTICLE_KEY_LAST: u32 = 0xffffffffu;
