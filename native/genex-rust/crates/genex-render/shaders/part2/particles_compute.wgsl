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

// The gusts (AAA materials, WP-13) as a pure function of the tick: the wind's extra speed swells
// and dies as two sines of the gust period and 2.7 times it, never below a tenth of the peak, and
// a gust front sweeps across the box along the wind (its phase a wavelength of `GUST_FRONT_TICKS`
// of travel). `particle_gust_drift` is its closed-form integral over a life, so a particle's place
// stays a function of its birth and age alone.
const PARTICLE_GUST_BASE: f32 = 0.55;
const PARTICLE_GUST_SLOW: f32 = 0.3;
const PARTICLE_GUST_FAST: f32 = 0.15;
const PARTICLE_GUST_FAST_RATE: f32 = 2.7;
const PARTICLE_GUST_FRONT_TICKS: f32 = 240.0;
const PARTICLE_TAU: f32 = 6.28318531;

// The gusts' phase at the spawn point `spawn`: the front's place along the wind.
fn particle_gust_phase(spawn: vec3<f32>) -> f32 {
    let wind = emitter.weather.xyz;
    let reach = max(length(wind) * PARTICLE_GUST_FRONT_TICKS, 1e-3);
    return -dot(spawn, wind) / (length(wind) * reach) * PARTICLE_TAU;
}

// The gusts' extra velocity at `tick` for a particle of gust phase `phase`.
fn particle_gust_velocity(tick: f32, phase: f32) -> vec3<f32> {
    let w = PARTICLE_TAU / emitter.weather.w;
    let swell = PARTICLE_GUST_BASE + PARTICLE_GUST_SLOW * sin(w * tick + phase) + PARTICLE_GUST_FAST * sin(PARTICLE_GUST_FAST_RATE * w * tick + 1.3 * phase);
    return emitter.weather.xyz * swell;
}

// How far the gusts carry a particle born at tick `born` over `age` ticks (the integral of
// `particle_gust_velocity`).
fn particle_gust_drift(born: f32, age: f32, phase: f32) -> vec3<f32> {
    let w = PARTICLE_TAU / emitter.weather.w;
    let fast = PARTICLE_GUST_FAST_RATE * w;
    let slow_part = PARTICLE_GUST_SLOW / w * (cos(w * born + phase) - cos(w * (born + age) + phase));
    let fast_part = PARTICLE_GUST_FAST / fast * (cos(fast * born + 1.3 * phase) - cos(fast * (born + age) + 1.3 * phase));
    return emitter.weather.xyz * (PARTICLE_GUST_BASE * age + slow_part + fast_part);
}

// A particle's flutter about its path at `age`: a sway of the emitter's reach in the horizontal
// plane, its own phases from `seed`, and the sway's velocity.
fn particle_flutter(seed: u32, age: f32) -> array<vec3<f32>, 2> {
    let reach = emitter.flutter.x;
    if reach <= 0.0 || emitter.flutter.y <= 0.0 {
        return array<vec3<f32>, 2>(vec3<f32>(0.0), vec3<f32>(0.0));
    }
    let w = PARTICLE_TAU / emitter.flutter.y * (0.75 + 0.5 * particle_unit(seed + 9u));
    let a = particle_unit(seed + 10u) * PARTICLE_TAU;
    let b = particle_unit(seed + 11u) * PARTICLE_TAU;
    let offset = reach * vec3<f32>(sin(w * age + a), 0.0, cos(0.83 * w * age + b));
    let velocity = reach * w * vec3<f32>(cos(w * age + a), 0.0, -0.83 * sin(0.83 * w * age + b));
    return array<vec3<f32>, 2>(offset, velocity);
}

// The offset that wraps `position` into the box of half sides `extent` centred `origin` from the
// camera (a camera-following emitter's endless field), and how far it lies into the box's outer
// tenth (0 inside, 1 at its face).
fn particle_wrap(position: vec3<f32>) -> vec4<f32> {
    let box = max(emitter.extent.xyz * 2.0, vec3<f32>(1e-3));
    let relative = position - (frame.camera_pos.xyz + emitter.origin.xyz);
    let wrapped = relative - box * round(relative / box);
    let edge = max(max(abs(wrapped.x) / box.x, abs(wrapped.y) / box.y), abs(wrapped.z) / box.z) * 2.0;
    return vec4<f32>(wrapped - relative, smoothstep(0.9, 1.0, edge));
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
        // Weather (AAA materials, WP-13): the gusts carry it, it flutters about its path, and a
        // camera-following field wraps the whole path into the box around the camera.
        var drift = vec3<f32>(0.0);
        if emitter.weather.w > 0.0 {
            let born = f32(k_low) / f32(rate);
            let phase = particle_gust_phase(spawn);
            drift = particle_gust_drift(born, age, phase);
            velocity += particle_gust_velocity(born + age, phase);
        }
        let flutter = particle_flutter(seed, age);
        drift += flutter[0];
        velocity += flutter[1];
        position += drift;
        var spawn_at = spawn + drift;
        if (emitter.flags.x & PARTICLE_FLAG_FOLLOW_CAMERA) != 0u {
            let wrap = particle_wrap(position);
            position += wrap.xyz;
            spawn_at += wrap.xyz;
            // Fade out at the box's faces and over a life's ends, so no wrap or rebirth pops.
            alpha = (1.0 - wrap.w) * smoothstep(0.0, 0.05, life) * (1.0 - smoothstep(0.95, 1.0, life));
        }
        let thickness = emitter.surface.y;
        if thickness > 0.0 {
            // The path as it is drawn: moved by the weather's drift at this age and the wrap.
            let hit = particle_hit_age(spawn_at, launch, age, thickness);
            if hit >= 0.0 {
                // At rest where it hit, fading out over the rest ticks, then gone.
                let rest = emitter.surface.z;
                let since = age - hit;
                alpha = select(0.0, alpha * (1.0 - since / max(rest, 1.0)), since < rest);
                position = particle_path(spawn_at, launch, hit);
                velocity = vec3<f32>(0.0);
                age = hit;
            }
        }
        if alpha > 0.0 {
            // `1 - (1 - end) · life`: at the default end 0.5 the bits of the shrink before A.11.
            var size = emitter.origin.w * (1.0 - (1.0 - emitter.shape.x) * life);
            if emitter.flutter.z > 0.0 {
                size *= 1.0 + emitter.flutter.z * (particle_unit(seed + 8u) * 2.0 - 1.0);
            }
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
