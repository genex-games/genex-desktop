
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
}

@group(0) @binding(0) var<uniform> emitter: Emitter;
@group(0) @binding(1) var<storage, read_write> particle_rows: array<Particle>;
@group(0) @binding(2) var<storage, read_write> particle_args: array<u32, 4>;

fn particle_hash(value: u32) -> u32 {
    // PCG output permutation: integer-only, the same bits on every GPU.
    let state = value * 747796405u + 2891336453u;
    let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}

fn particle_unit(seed: u32) -> f32 {
    return f32(particle_hash(seed) >> 8u) / 16777216.0;
}

@compute @workgroup_size(64)
fn cs_particles(@builtin(global_invocation_id) id: vec3<u32>) {
    let slots = emitter.params.w;
    let slot = id.x;
    if slot == 0u {
        particle_args[0] = 6u;
        particle_args[1] = slots;
        particle_args[2] = 0u;
        particle_args[3] = 0u;
    }
    if slot >= slots {
        return;
    }
    var row: Particle;
    row.position_size = vec4<f32>(emitter.origin.xyz, 0.0);
    row.color = vec4<f32>(0.0);
    if slot >= emitter.spawn.w {
        particle_rows[slot] = row;
        return;
    }
    // The newest particle k ≡ slot (mod slots) spawned so far is d particles before the newest.
    let d = (emitter.spawn.x + slots - slot) % slots;
    let rate = max(emitter.params.x, 1u);
    let age = f32(d / rate);
    let k_low = emitter.spawn.y - d;
    let k_high = emitter.spawn.z - select(0u, 1u, d > emitter.spawn.y);
    let seed = particle_hash(emitter.params.z ^ particle_hash(k_low ^ particle_hash(k_high)));
    let jitter = vec3<f32>(particle_unit(seed), particle_unit(seed + 1u), particle_unit(seed + 2u)) * 2.0 - 1.0;
    let speed = 1.0 + emitter.velocity.w * (particle_unit(seed + 3u) * 2.0 - 1.0);
    let velocity = emitter.velocity.xyz * speed + jitter * emitter.gravity.w;
    let position = emitter.origin.xyz + velocity * age + 0.5 * emitter.gravity.xyz * age * age;
    let life = age / f32(max(emitter.params.y, 1u));
    row.position_size = vec4<f32>(position, emitter.origin.w * (1.0 - 0.5 * life));
    row.color = mix(emitter.color_start, emitter.color_end, life);
    particle_rows[slot] = row;
}

