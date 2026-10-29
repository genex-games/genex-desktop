// The particles' billboards (graph node 15): one camera-facing quad per drawn row, fogged like an
// opaque surface at its centre and, for a lit emitter, lit by the sun through its shadow and the
// sky there (the HDR scene; AAA materials, WP-13); with renderer pass 2 A.11 rotated or stretched along the motion,
// textured from a flipbook atlas and faded where they near the opaque scene (soft particles).


@group(0) @binding(0) var<uniform> frame: FrameUniforms;
@group(1) @binding(0) var<storage, read> particles_drawn: array<Particle>;
// The emitter's row and its particles' shapes are `particle_billboard.wgsl`'s; the flipbook atlas
// (a white texel without one) and its sampler (renderer pass 2 A.11).
@group(1) @binding(3) var particle_flipbook: texture_2d<f32>;
@group(1) @binding(4) var particle_flipbook_sampler: sampler;
// The opaque scene's view depth at half the render size (`particles_depth.wgsl`; one texel of no
// surface where the prepass did not run): soft billboards fade against it.
@group(0) @binding(5) var particle_scene_depth: texture_2d<f32>;
// The sun's cascaded shadow maps and their comparison sampler (AAA materials, WP-13): a lit
// emitter's billboard is shadowed at its centre, once per vertex.
@group(0) @binding(6) var particle_shadow_map: texture_depth_2d_array;
@group(0) @binding(7) var particle_shadow_sampler: sampler_comparison;

// A lit particle (`EmitterDesc::lit`): the share of the sun's light over pi a flake scatters toward
// the camera from the side, and how much more it sends looking into the sun (forward scatter, a
// lobe of power `PARTICLE_FORWARD_POWER`).
const PARTICLE_SUN_SHARE: f32 = 0.5;
const PARTICLE_FORWARD_GAIN: f32 = 0.8;
const PARTICLE_FORWARD_POWER: f32 = 8.0;
const PARTICLE_PI: f32 = 3.14159265;
// The share of the sky behind a lit particle that comes through it: a flake, a drop or a puff is
// thin and scatters forward, so against a bright overcast it glows, never a dark speck.
const PARTICLE_TRANSLUCENCY: f32 = 0.6;
// The environment mip the light behind a particle is read at, as a share of the last.
const PARTICLE_BEHIND_MIP: f32 = 0.6;
const PARTICLE_CASCADES: u32 = 4u;

// The sun's visibility at `world` through the cascade its view depth falls in: one comparison tap
// (a flake is smaller than a texel's penumbra), 1 beyond the drawn cascades or without shadows.
fn particle_sun_visibility(world: vec3<f32>) -> f32 {
    if frame.cascade_splits.w < 0.5 {
        return 1.0;
    }
    let depth = dot(world - frame.camera_pos.xyz, frame.camera_forward.xyz);
    let count = min(frame.shadow_counts.x, PARTICLE_CASCADES);
    var cascade = PARTICLE_CASCADES;
    for (var c = 0u; c < count; c++) {
        if depth <= frame.cascade_ends[c] {
            cascade = c;
            break;
        }
    }
    if cascade >= PARTICLE_CASCADES {
        return 1.0;
    }
    let clip = frame.cascade_view_proj[cascade] * vec4<f32>(world, 1.0);
    let ndc = clip.xyz / clip.w;
    if abs(ndc.x) > 1.0 || abs(ndc.y) > 1.0 || ndc.z > 1.0 {
        return 1.0;
    }
    let uv = vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
    let reference = clamp(ndc.z, 0.0, 1.0) - frame.cascade_bias[cascade];
    return textureSampleCompareLevel(particle_shadow_map, particle_shadow_sampler, uv, i32(cascade), reference);
}

// The light on a lit particle at `center`: the sun through its shadow, scattered more looking
// into it, plus the sky's mean radiance (the environment's roughest mip above and below, or the
// flat ambient), and under an environment a share of what lies behind it along the view.
fn particle_light(center: vec3<f32>) -> vec3<f32> {
    let sun = normalize(frame.sun_dir.xyz);
    let view = normalize(center - frame.camera_pos.xyz);
    let forward = PARTICLE_FORWARD_GAIN * pow(max(dot(view, sun), 0.0), PARTICLE_FORWARD_POWER);
    let sunlight = frame.sun_color.rgb * (particle_sun_visibility(center) * (PARTICLE_SUN_SHARE + forward) / PARTICLE_PI);
    var sky = frame.ambient.rgb;
    if frame.ambient.w > 0.5 {
        let last = f32(textureNumLevels(particle_env_specular) - 1u);
        let above = textureSampleLevel(particle_env_specular, particle_env_sampler, vec3<f32>(0.0, 1.0, 0.0), last).rgb;
        let below = textureSampleLevel(particle_env_specular, particle_env_sampler, vec3<f32>(0.0, -1.0, 0.0), last).rgb;
        let behind = textureSampleLevel(particle_env_specular, particle_env_sampler, view, last * PARTICLE_BEHIND_MIP).rgb;
        sky = mix(0.5 * (above + below), behind, PARTICLE_TRANSLUCENCY);
    }
    return sunlight + sky;
}

// --- Fog (RQ4.3) -----------------------------------------------------------------------------
// The `*_fogged` entry points take the fog the particle sits in, as the opaque forward shader does:
// one billboard is fogged by the fog between the camera and its centre, with lighting/fog.wgsl's
// closed-form optical depth and in-scatter (repeated here: WGSL has no includes, and this module
// is built without the lighting chunks; tests/fog.rs holds the two to one behaviour, so "a
// particle in fog is fogged like an opaque at the same depth"). They need two bindings the plain
// entries do not: the fog row (`GxFog`'s layout; density 0 draws no fog at all) and the
// environment's prefiltered specular cube and its sampler, beside the frame. A frame under the flat-colour environment
// (`ambient.w` 0) takes the fog's colour as the in-scatter.

struct ParticleFog {
    // rgb: the in-scatter tint; a: extinction per world unit at the base height (0: no fog).
    color: vec4<f32>,
    // x: height falloff; y: base height; z: start distance; w: largest opacity.
    params: vec4<f32>,
}

@group(0) @binding(1) var<uniform> particle_fog: ParticleFog;
@group(0) @binding(2) var particle_env_specular: texture_cube<f32>;
@group(0) @binding(3) var particle_env_sampler: sampler;
// The air volume (RQ4 review; renderer pass 2 SI-04 and A.5): node 11's aerial perspective, or on
// froxel presets the froxel fog with the aerial folded in, in the split layout (fog.rs
// `AIR_HALVES`: in-scatter in front, its alpha 1 where the volume holds the height fog;
// transmittance per channel behind); one texel deep where neither runs (no air, the colour as it is
// bit for bit). The HDR entry hazes the billboard's centre as the forward pass hazes an opaque
// surface (lighting/fog.wgsl's `gx_aerial_froxel` and `gx_air_sample`).
@group(0) @binding(4) var particle_aerial: texture_3d<f32>;

// lighting/fog.wgsl's `GX_FOG_AERIAL_RANGE` and `GX_AIR_NEAR`.
const PARTICLE_AERIAL_RANGE: f32 = 32000.0;
const PARTICLE_AIR_NEAR: f32 = 4.0;

// The air at `world` (lighting/fog.wgsl's `GxAir`, `gx_air_sample`).
struct ParticleAir {
    inscatter: vec3<f32>,
    transmittance: vec3<f32>,
    holds_fog: bool,
}

fn particle_air_at(world: vec3<f32>) -> ParticleAir {
    let size = textureDimensions(particle_aerial);
    if size.z < 2u {
        return ParticleAir(vec3<f32>(0.0), vec3<f32>(1.0), false);
    }
    let clip = frame.view_proj * vec4<f32>(world, 1.0);
    let ndc = clip.xy / max(abs(clip.w), 1e-6);
    let uv = clamp(vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5), vec2<f32>(0.0), vec2<f32>(1.0));
    let span = log2(1.0 + PARTICLE_AERIAL_RANGE / PARTICLE_AIR_NEAR);
    let w = clamp(log2(1.0 + length(world - frame.camera_pos.xyz) / PARTICLE_AIR_NEAR) / span, 0.0, 1.0);
    let depth = f32(size.z);
    let edge = 0.5 / vec2<f32>(size.xy);
    let xy = clamp(uv, edge, vec2<f32>(1.0) - edge);
    let z = clamp(w * 0.5, 0.5 / depth, 0.5 - 0.5 / depth);
    let front = textureSampleLevel(particle_aerial, particle_env_sampler, vec3<f32>(xy, z), 0.0);
    let back = textureSampleLevel(particle_aerial, particle_env_sampler, vec3<f32>(xy, z + 0.5), 0.0);
    let f = clamp(w * depth, 0.0, 1.0);
    return ParticleAir(front.rgb * f, vec3<f32>(1.0) - (vec3<f32>(1.0) - back.rgb) * f, front.a > 0.5);
}

const PARTICLE_FOG_CLEAR_DEPTH: f32 = 1e-7;
const PARTICLE_FOG_FLAT_EXPONENT: f32 = 1e-2;
const PARTICLE_FOG_EXPONENT_LIMIT: f32 = 60.0;
const PARTICLE_FOG_HORIZON_SLOPE: f32 = 0.02;
const PARTICLE_FOG_SUN_G: f32 = 0.6;
// The sun lobe's share and how far its colour moves to the sun's luminance (lighting/fog.wgsl's
// GX_FOG_SUN_SHARE and GX_FOG_SUN_DESATURATE, owner decision D13).
const PARTICLE_FOG_SUN_SHARE: f32 = 1.0 / 3.0;
const PARTICLE_FOG_SUN_DESATURATE: f32 = 1.0 / 3.0;
const PARTICLE_FOG_LUMINANCE: vec3<f32> = vec3<f32>(0.2126, 0.7152, 0.0722);
// lighting/fog.wgsl's GX_FOG_SUN_SIDE_CUT (D13).
const PARTICLE_FOG_SUN_SIDE_CUT: f32 = 0.5;
const PARTICLE_FOG_SET_BAND: f32 = 0.04;
const PARTICLE_FOG_PI: f32 = 3.14159265358979;

fn particle_fog_exp(x: f32) -> f32 {
    return exp(clamp(x, -PARTICLE_FOG_EXPONENT_LIMIT, PARTICLE_FOG_EXPONENT_LIMIT));
}

// The fog's optical depth from the camera to `world`.
fn particle_fog_optical_depth(dir: vec3<f32>, reach: f32) -> f32 {
    let density = particle_fog.color.a;
    let start = particle_fog.params.z;
    if density <= 0.0 || reach <= start {
        return 0.0;
    }
    let falloff = particle_fog.params.x;
    let span = reach - start;
    let rise = falloff * dir.y;
    let exponent = rise * span;
    let start_exponent = falloff * (frame.camera_pos.y + dir.y * start - particle_fog.params.y);
    if abs(exponent) < PARTICLE_FOG_FLAT_EXPONENT {
        return density * particle_fog_exp(-start_exponent) * span * (1.0 - exponent * (0.5 - exponent / 6.0));
    }
    return density * (particle_fog_exp(-start_exponent) - particle_fog_exp(-start_exponent - exponent)) / rise;
}

// The environment's radiance towards unit `n`, read from the prefiltered cube at the fog's
// roughness (lighting/fog.wgsl's `GX_FOG_ENV_ROUGHNESS`).
const PARTICLE_FOG_ENV_ROUGHNESS: f32 = 0.0;

// At the ambient chunk's perceptual level (`gx_env_lod`: `last · r · (2 − r)`).
fn particle_env_radiance(n: vec3<f32>) -> vec3<f32> {
    let last_mip = f32(textureNumLevels(particle_env_specular) - 1u);
    let lod = last_mip * PARTICLE_FOG_ENV_ROUGHNESS * (2.0 - PARTICLE_FOG_ENV_ROUGHNESS);
    return textureSampleLevel(particle_env_specular, particle_env_sampler, n, lod).rgb;
}

// The light the fog scatters towards the camera along unit `dir` (lighting/fog.wgsl's
// `gx_fog_inscatter`).
fn particle_fog_inscatter(dir: vec3<f32>) -> vec3<f32> {
    let tint = particle_fog.color.rgb;
    if frame.ambient.w < 0.5 {
        return tint;
    }
    let sun = normalize(frame.sun_dir.xyz);
    let around = length(dir.xz);
    let azimuth = select(vec2<f32>(0.0, 1.0), dir.xz / around, around > 1e-6);
    let horizon = normalize(vec3<f32>(azimuth.x, PARTICLE_FOG_HORIZON_SLOPE, azimuth.y));
    let g2 = PARTICLE_FOG_SUN_G * PARTICLE_FOG_SUN_G;
    let denominator = max(1.0 + g2 - 2.0 * PARTICLE_FOG_SUN_G * dot(dir, sun), 1e-4);
    let phase = (1.0 - g2) / (4.0 * PARTICLE_FOG_PI * denominator * sqrt(denominator));
    // The frame's sun is already the sun as it reaches the ground (lighting/fog.wgsl): never
    // reddened by a second air mass here.
    let sun_up = smoothstep(-PARTICLE_FOG_SET_BAND, 0.0, sun.y);
    let lobe_color = mix(frame.sun_color.rgb, vec3<f32>(dot(frame.sun_color.rgb, PARTICLE_FOG_LUMINANCE)), PARTICLE_FOG_SUN_DESATURATE);
    let lobe = lobe_color * (sun_up * PARTICLE_FOG_SUN_SHARE * phase);
    // The aureole the horizon read sees beyond the ray's own angle to the sun, cut (lighting/fog.wgsl's
    // `gx_fog_sky_light`, D13): the lobe's phase at the read less the ray's, over its peak.
    let toward = max(1.0 + g2 - 2.0 * PARTICLE_FOG_SUN_G * dot(horizon, sun), 1e-4);
    let peak = (1.0 - PARTICLE_FOG_SUN_G) * (1.0 - PARTICLE_FOG_SUN_G);
    let nearer = pow(peak / toward, 1.5) - pow(peak / denominator, 1.5);
    let cut = PARTICLE_FOG_SUN_SIDE_CUT * sun_up * max(nearer, 0.0);
    let sky = particle_env_radiance(horizon);
    return tint * (mix(sky, vec3<f32>(dot(sky, PARTICLE_FOG_LUMINANCE)), cut) * (1.0 - cut) + lobe);
}

// `color` (linear) seen through the fog between the camera and `world` is `color * terms.a +
// terms.rgb` for these terms: rgb the in-scatter times the fog's opacity, a one minus the opacity
// ((0, 0, 0, 1) without fog). Taken once per billboard, at its centre, by the vertex stage
// (renderer pass 2 A.11: the same fog for a fraction of a big puff's fragment work).
fn particle_fog_terms(world: vec3<f32>) -> vec4<f32> {
    let clear = vec4<f32>(0.0, 0.0, 0.0, 1.0);
    if particle_fog.color.a <= 0.0 {
        return clear;
    }
    let origin = frame.camera_pos.xyz;
    let to_particle = world - origin;
    let reach = length(to_particle);
    if reach <= 0.0 {
        return clear;
    }
    let dir = to_particle / reach;
    let depth = particle_fog_optical_depth(dir, reach);
    if depth < PARTICLE_FOG_CLEAR_DEPTH {
        return clear;
    }
    let opacity = min(1.0 - exp(-depth), particle_fog.params.w);
    return vec4<f32>(particle_fog_inscatter(dir) * opacity, 1.0 - opacity);
}

// Every billboard's varyings (the legacy LDR entry's vertex output; tests/fog.rs draws both
// fragment entries over it). Each fragment entry reads only its locations, so the HDR scene's own
// vertex entry writes a subset of them (`ParticleHdrOut`): eight floats a vertex fewer for the
// tiler to keep (renderer pass 2 A.11: the cost of 64k rain streaks).
struct ParticleFogOut {
    @builtin(position) clip: vec4<f32>,
    // The particle's sRGB colour and alpha: the legacy LDR entry's colour as it is.
    @location(0) @interpolate(flat) color: vec4<f32>,
    // xy: the billboard's corner (-1..1); z: the fragment's view depth (world units along the
    // camera's forward axis), the soft fade's.
    @location(1) corner_depth: vec3<f32>,
    // The particle's life (0..1), the flipbook's frame.
    @location(2) @interpolate(flat) life: f32,
    // At the centre, the same at every corner: the fog's terms (`particle_fog_terms`), which the
    // legacy LDR entry applies.
    @location(3) @interpolate(flat) fog: vec4<f32>,
    // The HDR entry's colour as `shape · paint + glow` before exposure: the particle's linear
    // colour through the air and the fog at its centre (`particle_hdr_terms`), so a fragment
    // never decodes sRGB or reads the air; paint's alpha is the particle's.
    @location(4) @interpolate(flat) paint: vec4<f32>,
    @location(5) @interpolate(flat) glow: vec3<f32>,
}

// The HDR scene's varyings: `ParticleFogOut`'s locations 1, 2, 4 and 5.
struct ParticleHdrOut {
    @builtin(position) clip: vec4<f32>,
    @location(1) corner_depth: vec3<f32>,
    @location(2) @interpolate(flat) life: f32,
    @location(4) @interpolate(flat) paint: vec4<f32>,
    @location(5) @interpolate(flat) glow: vec3<f32>,
}

// The HDR entry's (paint, glow) for a particle of sRGB `color` at `center` under the fog `fog`
// (`particle_fog_terms`): the linear colour through the air (the aerial perspective, or the froxel
// fog holding the height fog), then the fog where the air does not hold it. A tint `t` of the
// billboard's shape then draws `t · paint + glow`, as `(linear · t · T + I) · fog.a + fog.rgb`.
fn particle_hdr_terms(color: vec3<f32>, center: vec3<f32>, fog: vec4<f32>) -> array<vec3<f32>, 2> {
    let air = particle_air_at(center);
    let linear = particle_srgb_to_linear(color);
    if air.holds_fog {
        return array<vec3<f32>, 2>(linear * air.transmittance, air.inscatter);
    }
    return array<vec3<f32>, 2>(linear * air.transmittance * fog.a, air.inscatter * fog.a + fog.rgb);
}

// Every varying of one corner of row `instance`'s billboard.
fn particle_vertex(vertex: u32, instance: u32) -> ParticleFogOut {
    let p = particles_drawn[instance];
    let shape = particle_shapes_drawn[instance];
    let corner = particle_quad_corner(vertex);
    let world = particle_corner_world(p, shape, corner);
    var out: ParticleFogOut;
    out.clip = frame.view_proj * vec4<f32>(world, 1.0);
    out.color = p.color;
    out.corner_depth = vec3<f32>(corner, dot(world - frame.camera_pos.xyz, frame.camera_forward.xyz));
    out.life = shape.life.x;
    out.fog = particle_fog_terms(p.position_size.xyz);
    let terms = particle_hdr_terms(p.color.rgb, p.position_size.xyz, out.fog);
    var paint = terms[0];
    let lit = particle_emitter.flutter.w;
    if (particle_emitter.flags.x & PARTICLE_FLAG_LIT) != 0u && lit > 0.0 {
        paint *= mix(vec3<f32>(1.0), particle_light(p.position_size.xyz), lit);
    }
    out.paint = vec4<f32>(paint, p.color.a);
    out.glow = terms[1];
    return out;
}

@vertex
fn vs_particle_fogged(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> ParticleFogOut {
    return particle_vertex(vertex, instance);
}

@vertex
fn vs_particle_hdr(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> ParticleHdrOut {
    let all = particle_vertex(vertex, instance);
    return ParticleHdrOut(all.clip, all.corner_depth, all.life, all.paint, all.glow);
}

fn particle_srgb_to_linear(c: vec3<f32>) -> vec3<f32> {
    return select(pow((c + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4)), c / 12.92, c <= vec3<f32>(0.04045));
}

fn particle_linear_to_srgb(c: vec3<f32>) -> vec3<f32> {
    return select(1.055 * pow(c, vec3<f32>(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3<f32>(0.0031308));
}

// The flipbook atlas's texel for frame `index` at the billboard's `corner`, inset half a texel from
// the cell's edges so the filter never reads the next cell.
fn particle_flipbook_texel(index: u32, corner: vec2<f32>) -> vec4<f32> {
    let grid = max(particle_emitter.book.xy, vec2<f32>(1.0));
    let columns = u32(grid.x);
    let cell = vec2<f32>(f32(index % columns), f32(index / columns));
    let texel = 0.5 / vec2<f32>(textureDimensions(particle_flipbook));
    let within = clamp(vec2<f32>(corner.x * 0.5 + 0.5, 0.5 - corner.y * 0.5), texel * grid, vec2<f32>(1.0) - texel * grid);
    return textureSample(particle_flipbook, particle_flipbook_sampler, (cell + within) / grid);
}

// What the billboard's shape makes of its colour: rgb a linear tint (white for the round dot), a the
// coverage. A flipbook plays its frames `cycles` times over a life, cross-faded when the emitter
// blends them; the round dot is full inside half the radius, fading to the edge.
fn particle_shape(corner: vec2<f32>, life: f32) -> vec4<f32> {
    let flags = particle_emitter.flags.x;
    if (flags & PARTICLE_FLAG_FLIPBOOK) == 0u {
        return vec4<f32>(1.0, 1.0, 1.0, 1.0 - smoothstep(0.5, 1.0, length(corner)));
    }
    let frames = max(particle_emitter.book.z, 1.0);
    let played = clamp(life, 0.0, 1.0) * frames * max(particle_emitter.book.w, 0.0);
    let index = u32(floor(played)) % u32(frames);
    let first = particle_flipbook_texel(index, corner);
    let next = particle_flipbook_texel((index + 1u) % u32(frames), corner);
    let blend = select(0.0, fract(played), (flags & PARTICLE_FLAG_BLEND_FRAMES) != 0u);
    return mix(first, next, blend);
}

// The opaque scene's view depth under the fragment at `pixel`: the half-size view depth
// (`particles_depth.wgsl`) filtered bilinearly by hand (it is not a filterable format), so a fade
// across a slope has no two-pixel steps; the one texel of no surface as it is.
fn particle_scene_view_depth(pixel: vec2<f32>) -> f32 {
    let size = textureDimensions(particle_scene_depth);
    let last = vec2<i32>(size) - vec2<i32>(1);
    let at = max(pixel * 0.5 - vec2<f32>(0.5), vec2<f32>(0.0));
    let low = min(vec2<i32>(at), last);
    let high = min(low + vec2<i32>(1), last);
    let t = fract(at);
    let top = mix(textureLoad(particle_scene_depth, low, 0).r, textureLoad(particle_scene_depth, vec2<i32>(high.x, low.y), 0).r, t.x);
    let bottom = mix(textureLoad(particle_scene_depth, vec2<i32>(low.x, high.y), 0).r, textureLoad(particle_scene_depth, high, 0).r, t.x);
    return mix(top, bottom, t.y);
}

// The soft-particle fade (after three.js r186 `SoftParticles.js`, MIT, from NVIDIA's "Soft
// Particles" paper by Tristan Lorach; THIRD-PARTY-NOTICES.md): the gap between the opaque scene
// and the fragment in world units over the soft distance, through a symmetric contrast curve of
// power 2, for the fragment at `pixel` of view depth `depth`. 1 where the emitter is hard (soft
// distance 0) or nothing is behind.
fn particle_soft(pixel: vec2<f32>, depth: f32) -> f32 {
    let distance = particle_emitter.surface.x;
    if distance <= 0.0 {
        return 1.0;
    }
    let scene = particle_scene_view_depth(pixel);
    let gap = clamp((scene - depth) / distance, 0.0, 1.0);
    let above = gap > 0.5;
    let folded = select(gap, 1.0 - gap, above);
    let curved = 0.5 * (2.0 * folded) * (2.0 * folded);
    return select(curved, 1.0 - curved, above);
}

// The camera fade (GA): a billboard's fragment `depth` world units in front of the camera is gone
// within a quarter of the emitter's near fade and fades in over the rest of it, so a drop passing
// just in front of the lens draws no wide streak for one frame; 1 without a near fade.
fn particle_near(depth: f32) -> f32 {
    let fade = particle_emitter.surface.w;
    if fade <= 0.0 {
        return 1.0;
    }
    return smoothstep(fade * PARTICLE_NEAR_GONE, fade, depth);
}

// The share of the near fade in front of the camera where a billboard draws nothing.
const PARTICLE_NEAR_GONE: f32 = 0.25;

// The legacy LDR world: the particle's sRGB colour fogged in linear light, encoded back.
@fragment
fn fs_particle_fogged(in: ParticleFogOut) -> @location(0) vec4<f32> {
    let shape = particle_shape(in.corner_depth.xy, in.life);
    let alpha = in.color.a * shape.a * particle_soft(in.clip.xy, in.corner_depth.z) * particle_near(in.corner_depth.z);
    let tinted = (particle_emitter.flags.x & PARTICLE_FLAG_FLIPBOOK) != 0u;
    if particle_fog.color.a <= 0.0 && !tinted {
        return vec4<f32>(in.color.rgb, alpha);
    }
    let fogged = particle_srgb_to_linear(in.color.rgb) * shape.rgb * in.fog.a + in.fog.rgb;
    return vec4<f32>(particle_linear_to_srgb(clamp(fogged, vec3<f32>(0.0), vec3<f32>(1.0))), alpha);
}

// The HDR scene: the particle's linear colour through the air (the aerial perspective) and then
// the fog (`particle_hdr_terms`, taken by the vertex stage), exposed with the frame's pre-exposure
// (`cascade_splits.z`, auto exposure's GPU value included) and held under the half-float limit.
@fragment
fn fs_particle_hdr_fogged(in: ParticleHdrOut) -> @location(0) vec4<f32> {
    let shape = particle_shape(in.corner_depth.xy, in.life);
    let fogged = shape.rgb * in.paint.rgb + in.glow;
    let exposed = min(fogged * frame.cascade_splits.z, vec3<f32>(64512.0));
    return vec4<f32>(exposed, in.paint.a * shape.a * particle_soft(in.clip.xy, in.corner_depth.z) * particle_near(in.corner_depth.z));
}
