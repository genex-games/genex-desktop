
@group(0) @binding(0) var<uniform> frame: FrameUniforms;
@group(1) @binding(0) var<storage, read> particles_drawn: array<Particle>;

struct ParticleOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) color: vec4<f32>,
    @location(1) corner: vec2<f32>,
}

// One corner of one camera-facing billboard (the plain and the fogged vertex entries share it).
fn particle_billboard(vertex: u32, instance: u32) -> ParticleOut {
    let corners = array<vec2<f32>, 6>(
        vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
        vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0),
    );
    let p = particles_drawn[instance];
    let corner = corners[vertex];
    // The camera's own right and up, the first two rows of the (unjittered, symmetric)
    // view-projection: a billboard faces the camera at every pitch. A basis crossed with the
    // world's +Y was zero, and so NaN, under a camera looking straight up or down (renderer
    // pass 2, LG-08/S9).
    let vp = frame.view_proj;
    let right = normalize(vec3<f32>(vp[0].x, vp[1].x, vp[2].x));
    let up = normalize(vec3<f32>(vp[0].y, vp[1].y, vp[2].y));
    let half = p.position_size.w * 0.5;
    let world = p.position_size.xyz + (right * corner.x + up * corner.y) * half;
    var out: ParticleOut;
    out.clip = frame.view_proj * vec4<f32>(world, 1.0);
    out.color = p.color;
    out.corner = corner;
    return out;
}

@vertex
fn vs_particle(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> ParticleOut {
    return particle_billboard(vertex, instance);
}

@fragment
fn fs_particle(in: ParticleOut) -> @location(0) vec4<f32> {
    // A soft round dot: full inside half the radius, fading to the edge.
    let fade = 1.0 - smoothstep(0.5, 1.0, length(in.corner));
    return vec4<f32>(in.color.rgb, in.color.a * fade);
}

// The HDR scene: the particle's sRGB colour as linear light, exposed with the frame's pre-exposure
// (`cascade_splits.z`, auto exposure's GPU value included), held under the half-float limit.
@fragment
fn fs_particle_hdr(in: ParticleOut) -> @location(0) vec4<f32> {
    let fade = 1.0 - smoothstep(0.5, 1.0, length(in.corner));
    let c = in.color.rgb;
    let linear = select(pow((c + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4)), c / 12.92, c <= vec3<f32>(0.04045));
    let exposed = min(linear * frame.cascade_splits.z, vec3<f32>(64512.0));
    return vec4<f32>(exposed, in.color.a * fade);
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
        return color;
    }
    let dir = to_particle / reach;
    let depth = particle_fog_optical_depth(dir, reach);
    if depth < PARTICLE_FOG_CLEAR_DEPTH {
        return color;
    }
    let opacity = min(1.0 - exp(-depth), particle_fog.params.w);
    return color * (1.0 - opacity) + particle_fog_inscatter(dir) * opacity;
}

struct ParticleFogOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) color: vec4<f32>,
    @location(1) corner: vec2<f32>,
    // The billboard's centre, which the fog is taken at.
    @location(2) center: vec3<f32>,
}

@vertex
fn vs_particle_fogged(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> ParticleFogOut {
    let base = particle_billboard(vertex, instance);
    var out: ParticleFogOut;
    out.clip = base.clip;
    out.color = base.color;
    out.corner = base.corner;
    out.center = particles_drawn[instance].position_size.xyz;
    return out;
}

fn particle_srgb_to_linear(c: vec3<f32>) -> vec3<f32> {
    return select(pow((c + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4)), c / 12.92, c <= vec3<f32>(0.04045));
}

fn particle_linear_to_srgb(c: vec3<f32>) -> vec3<f32> {
    return select(1.055 * pow(c, vec3<f32>(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3<f32>(0.0031308));
}

// The legacy LDR world: the particle's sRGB colour fogged in linear light, encoded back.
@fragment
fn fs_particle_fogged(in: ParticleFogOut) -> @location(0) vec4<f32> {
    let fade = 1.0 - smoothstep(0.5, 1.0, length(in.corner));
    if particle_fog.color.a <= 0.0 {
        return vec4<f32>(in.color.rgb, in.color.a * fade);
    }
    let fogged = particle_apply_fog(particle_srgb_to_linear(in.color.rgb), in.center);
    return vec4<f32>(particle_linear_to_srgb(clamp(fogged, vec3<f32>(0.0), vec3<f32>(1.0))), in.color.a * fade);
}

// The HDR scene: the particle's linear colour through the air (the aerial perspective) and then
// the fog, exposed like `fs_particle_hdr`.
@fragment
fn fs_particle_hdr_fogged(in: ParticleFogOut) -> @location(0) vec4<f32> {
    let fade = 1.0 - smoothstep(0.5, 1.0, length(in.corner));
    let air = particle_aerial_at(in.center);
    let fogged = particle_apply_fog(particle_srgb_to_linear(in.color.rgb) * air.a + air.rgb, in.center);
    let exposed = min(fogged * frame.cascade_splits.z, vec3<f32>(64512.0));
    return vec4<f32>(exposed, in.color.a * fade);
}
