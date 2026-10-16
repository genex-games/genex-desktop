// The emitter's compute passes: `cs_particles` writes every slot's row, shape and sort key for the
// frame's tick; `cs_particles_gather` writes the rows a sorted emitter draws in the sort's order.

@group(0) @binding(0) var<uniform> emitter: Emitter;
@group(0) @binding(1) var<storage, read_write> particle_rows: array<Particle>;
@group(0) @binding(2) var<storage, read_write> particle_args: array<u32, 4>;
// (key, slot) pairs: the view depth a sorted emitter draws by (farthest first), and the slot.
@group(0) @binding(3) var<storage, read_write> particle_keys: array<vec2<u32>>;
@group(0) @binding(4) var<storage, read_write> particle_shapes: array<ParticleShape>;
// The gather's output: rows and shapes in drawing order.
@group(0) @binding(5) var<storage, read_write> particle_drawn: array<Particle>;
@group(0) @binding(6) var<storage, read_write> particle_drawn_shapes: array<ParticleShape>;

// The frame the emitter is drawn in: its camera, and the opaque scene's view depth at half the
// render size (one texel of no surface where the prepass did not run or nothing collides).
@group(1) @binding(0) var<uniform> frame: FrameUniforms;
@group(1) @binding(1) var particle_scene_depth: texture_2d<f32>;

// Samples along a particle's path the depth collision tests (its age in ticks when fewer).
const PARTICLE_COLLISION_STEPS: u32 = 24u;

fn particle_hash(value: u32) -> u32 {
    // PCG output permutation: integer-only, the same bits on every GPU.
    let state = value * 747796405u + 2891336453u;
    let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}

fn particle_unit(seed: u32) -> f32 {
    return f32(particle_hash(seed) >> 8u) / 16777216.0;
}

// Where a particle born at `spawn` and launched with `velocity` is `age` ticks after its birth.
fn particle_path(spawn: vec3<f32>, velocity: vec3<f32>, age: f32) -> vec3<f32> {
    return spawn + velocity * age + 0.5 * emitter.gravity.xyz * age * age;
}

// The opaque scene's view depth under `world` (a huge value off screen or behind the camera).
fn particle_scene_depth_at(world: vec3<f32>) -> f32 {
    let clip = frame.view_proj * vec4<f32>(world, 1.0);
    let far = 3.0e38;
    if clip.w <= 0.0 {
        return far;
    }
    let ndc = clip.xy / clip.w;
    if any(abs(ndc) > vec2<f32>(1.0)) {
        return far;
    }
    let size = textureDimensions(particle_scene_depth);
    let uv = vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
    let texel = min(vec2<u32>(uv * vec2<f32>(size)), size - vec2<u32>(1u));
    return textureLoad(particle_scene_depth, texel, 0).r;
}

// The first age (ticks) at which the path from birth to `age` is behind what the camera sees,
// within `thickness` of it (depth-buffer collision); a negative value where it never is.
fn particle_hit_age(spawn: vec3<f32>, velocity: vec3<f32>, age: f32, thickness: f32) -> f32 {
    let steps = min(PARTICLE_COLLISION_STEPS, max(u32(age), 1u));
    for (var k = 1u; k <= steps; k += 1u) {
        let t = age * f32(k) / f32(steps);
        let at = particle_path(spawn, velocity, t);
        let depth = dot(at - frame.camera_pos.xyz, frame.camera_forward.xyz);
        let scene = particle_scene_depth_at(at);
        if depth > scene && depth < scene + thickness {
            return t;
        }
    }
    return -1.0;
}

// The sort key of a drawn particle `depth` along the view: farther first (the bits of a positive
// float order as the float does, and the complement turns ascending into descending).
fn particle_key(depth: f32) -> u32 {
    return ~bitcast<u32>(max(depth, 0.0));
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
    let sorted = (emitter.flags.x & PARTICLE_FLAG_SORTED) != 0u;
    var row: Particle;
    row.position_size = vec4<f32>(emitter.origin.xyz, 0.0);
    row.color = vec4<f32>(0.0);
    var shape: ParticleShape;
    shape.motion = vec4<f32>(0.0);
    shape.life = vec4<f32>(0.0);
    var key = PARTICLE_KEY_LAST;
    let stride = max(emitter.flags.y, 1u);
    if slot < emitter.spawn.w && slot % stride == 0u {
        // The newest particle k ≡ slot (mod slots) spawned so far is d particles before the newest.
        let d = (emitter.spawn.x + slots - slot) % slots;
        let rate = max(emitter.params.x, 1u);
        var age = f32(d / rate);
        let k_low = emitter.spawn.y - d;
        let k_high = emitter.spawn.z - select(0u, 1u, d > emitter.spawn.y);
        let seed = particle_hash(emitter.params.z ^ particle_hash(k_low ^ particle_hash(k_high)));
        let jitter = vec3<f32>(particle_unit(seed), particle_unit(seed + 1u), particle_unit(seed + 2u)) * 2.0 - 1.0;
        let speed = 1.0 + emitter.velocity.w * (particle_unit(seed + 3u) * 2.0 - 1.0);
        let launch = emitter.velocity.xyz * speed + jitter * emitter.gravity.w;
        // Where in the spawn box it was born (exactly the origin for a point emitter).
        let place = vec3<f32>(particle_unit(seed + 5u), particle_unit(seed + 6u), particle_unit(seed + 7u)) * 2.0 - 1.0;
        let spawn = emitter.origin.xyz + emitter.extent.xyz * place;
        let lifetime = f32(max(emitter.params.y, 1u));
        let life = age / lifetime;
        var position = particle_path(spawn, launch, age);
        var velocity = launch + emitter.gravity.xyz * age;
        var alpha = 1.0;
        let thickness = emitter.surface.y;
        if thickness > 0.0 {
            let hit = particle_hit_age(spawn, launch, age, thickness);
            if hit >= 0.0 {
                // At rest where it hit, fading out over the rest ticks, then gone.
                let rest = emitter.surface.z;
                let since = age - hit;
                alpha = select(0.0, 1.0 - since / max(rest, 1.0), since < rest);
                position = particle_path(spawn, launch, hit);
                velocity = vec3<f32>(0.0);
                age = hit;
            }
        }
        if alpha > 0.0 {
            // `1 - (1 - end) · life`: at the default end 0.5 the bits of the shrink before A.11.
            let size = emitter.origin.w * (1.0 - (1.0 - emitter.shape.x) * life);
            let rotation = emitter.shape.y * (particle_unit(seed + 4u) * 2.0 - 1.0) + emitter.shape.z * age;
            row.position_size = vec4<f32>(position, size);
            row.color = mix(emitter.color_start, emitter.color_end, life);
            row.color.a *= alpha;
            shape.motion = vec4<f32>(velocity, rotation);
            shape.life = vec4<f32>(life, 0.0, 0.0, 0.0);
            key = particle_key(dot(position - frame.camera_pos.xyz, frame.camera_forward.xyz));
        }
    }
    particle_rows[slot] = row;
    particle_shapes[slot] = shape;
    if sorted {
        particle_keys[slot] = vec2<u32>(key, slot);
    }
}

@compute @workgroup_size(64)
fn cs_particles_gather(@builtin(global_invocation_id) id: vec3<u32>) {
    let slot = id.x;
    if slot >= emitter.params.w {
        return;
    }
    let source = particle_keys[slot].y;
    particle_drawn[slot] = particle_rows[source];
    particle_drawn_shapes[slot] = particle_shapes[source];
}
