// Lighting chunk: fog (RQ4.3). Height and distance fog, evaluated analytically along the view ray
// from the camera to the surface: no depth target, no history, on in every preset. Reads the
// forward binding `frame`, the sky's prefiltered cube through `gx_env_sky` (the environment
// bindings' accessor, A.3) and the accessor `gx_fog()` (the
// forward pass's is forward_effects.wgsl, the Level-2 v2 prelude's reads GxFrameV2); the Level-2 v2 `gx_shade_pbr` is
// built from this same text. fog.rs is the CPU twin of every function here and tests/fog.rs holds
// the two to each other.
//
// The fog's extinction is density × exp(-falloff × (y - base_height)) per world unit. Its optical
// depth along a ray is that integral in closed form, from the fog's start distance to the surface;
// the fog hides `1 - exp(-depth)` of the surface, at most `max_opacity`, behind the fog's
// in-scatter:
// - under the flat-colour environment (`frame.ambient.w` 0) the in-scatter is the fog row's colour,
//   which the renderer makes the fog's colour times the flat backdrop's (`fog::gpu_fog_over`);
// - under a sky or an HDR map (`frame.ambient.w` 1) it is the environment's radiance towards the
//   horizon in the ray's azimuth (the sky's prefiltered cube, `gx_env_sky`, at GX_FOG_ENV_ROUGHNESS,
//   its mirror level, the sky-view LUT's colour unblurred) plus the sun's forward lobe of the
//   frame's sun colour (already the sun as it reaches the ground: under the sky through the
//   transmittance LUT, under a map its analytic sun; never reddened again), both multiplied by the
//   fog's colour. The sky's background and the HDR map's backdrop fog with the same lobe
//   (sky_draw.wgsl, backdrop.wgsl; SI-03). With the default white colour the fog
//   at the horizon is the sky's colour; any other colour tints it away from the sky, so fully
//   fogged geometry stands out against the sky behind it (warm a whole frame with the look's
//   white balance instead).
// On medium and above the aerial-perspective volume adds the sky's own scattering along the ray
// (`gx_air_sample`, `gx_apply_air`, then the fog). On high and ultra the froxel fog (renderer pass
// 2 A.5, froxel.rs) binds its own volume in the same slot, in the same layout: the height fog lit
// by the shadowed sun and the binned lights, the aerial volume folded in behind it, and its
// in-scatter's alpha 1 says the height fog is in it, so the chunk does not add the analytic fog
// again (`gx_air_holds_fog`). A Level-2 v2 material reaches both through `gx_shade_pbr` (its
// prelude binds the volume as the forward pass does); `gx_apply_fog` alone is the height and
// distance fog without the air. Particles take both at their centre.
// Level-3 passes get neither as a chunk: their tables carry the fog row (GxFrameV2's `fog_color`,
// `fog_params`) and the environment cube (`gx_env_specular`), so a pass can repeat the height fog
// with the same in-scatter (the showcase's `look_fog`), but not the aerial-perspective volume.

// Optical depth below which a ray counts as clear.
const GX_FOG_CLEAR_DEPTH: f32 = 1e-7;
// `falloff × vertical extent` below which the height integral is taken as a series around constant
// density (the closed form cancels 1 - exp(-x) there).
const GX_FOG_FLAT_EXPONENT: f32 = 1e-2;
// The exponent a density is evaluated at is held to this: exp(60) is 1e26, inside f32 and far past
// any visible fog.
const GX_FOG_EXPONENT_LIMIT: f32 = 60.0;
// The slope (rise over run) above the horizon the in-scatter is read at, whatever the ray's own
// slope: the fog hugs the ground, so a ray looking up through it still sees the horizon's light.
// Just over the horizon's edge, where the sky is brightest and the bake has not blurred it with the
// ground (tests/fog.rs measures the sky-view LUT, the baked cube and this slope against each other).
const GX_FOG_HORIZON_SLOPE: f32 = 0.02;
// The roughness the environment cube is read at (through the ambient chunk's `gx_env_lod`): its
// mirror level, the sky as the background shows it. A read at 0.05 mixed the ground under the
// horizon into the fog's colour and fogged geometry came out 13 to 17 percent darker than the fogged
// sky behind it (SI-03, tests/fog.rs's towards-the-sun row); the level is a smooth function of the
// direction, so the fog does not speckle.
const GX_FOG_ENV_ROUGHNESS: f32 = 0.0;
// The sun lobe's Henyey-Greenstein asymmetry and share of the sun's radiance. Owner decision D13
// (golden hour): a third weaker than pass 1's 1/2, and its colour a third of the way from the sun's
// to the sun's luminance (GX_FOG_SUN_DESATURATE), so the warm veil towards a low sun keeps the
// ground's colour and texture under it (fog.rs `SUN_SHARE`, `sun_lobe_color`).
const GX_FOG_SUN_G: f32 = 0.6;
const GX_FOG_SUN_SHARE: f32 = 1.0 / 3.0;
const GX_FOG_SUN_DESATURATE: f32 = 1.0 / 3.0;
// The local lights' share of their radiance the froxel fog scatters through the same lobe (pass 1's
// sun share; D13 cut only the sun's).
const GX_FOG_LOCAL_SHARE: f32 = 0.5;
// D13: the in-scatter reads the sky at the horizon in the ray's azimuth whatever the ray's slope,
// so a ray looking down at the ground towards a low sun took the sun's aureole as if it looked at
// the horizon: the bulk of the warm, low-contrast veil over sunlit ground. This share of the
// aureole the read sees beyond what the ray's own angle to the sun sees is cut, in strength and in
// warmth (`gx_fog_sun_side`); a ray along the horizon (the forest at eye level, the fogged sky at
// the horizon) keeps its light.
const GX_FOG_SUN_SIDE_CUT: f32 = 0.5;
// Rec. 709 luminance weights (the scene's linear primaries).
const GX_FOG_LUMINANCE: vec3<f32> = vec3<f32>(0.2126, 0.7152, 0.0722);
// The band (sine of elevation) over which the sun's lobe sets.
const GX_FOG_SET_BAND: f32 = 0.04;
const GX_FOG_PI: f32 = 3.14159265358979;

// exp of `x` held to ±GX_FOG_EXPONENT_LIMIT.
fn gx_fog_exp(x: f32) -> f32 {
    return exp(clamp(x, -GX_FOG_EXPONENT_LIMIT, GX_FOG_EXPONENT_LIMIT));
}

// The fog's optical depth along the ray from `origin` along unit `dir` for `reach` world units:
// `density × ∫ exp(-falloff × (y(t) - base))` over the part of the ray past the fog's start.
fn gx_fog_optical_depth(fog: GxFog, origin: vec3<f32>, dir: vec3<f32>, reach: f32) -> f32 {
    let density = fog.color.a;
    let start = fog.params.z;
    if density <= 0.0 || reach <= start {
        return 0.0;
    }
    let falloff = fog.params.x;
    let span = reach - start;
    let rise = falloff * dir.y;
    let exponent = rise * span;
    let start_exponent = falloff * (origin.y + dir.y * start - fog.params.y);
    if abs(exponent) < GX_FOG_FLAT_EXPONENT {
        // span × (1 - x/2 + x²/6): constant density to the order the closed form can resolve.
        return density * gx_fog_exp(-start_exponent) * span * (1.0 - exponent * (0.5 - exponent / 6.0));
    }
    return density * (gx_fog_exp(-start_exponent) - gx_fog_exp(-start_exponent - exponent)) / rise;
}

// How much of the surface a ray of optical depth `depth` hides, `0..=max_opacity`.
fn gx_fog_opacity(fog: GxFog, depth: f32) -> f32 {
    if depth < GX_FOG_CLEAR_DEPTH {
        return 0.0;
    }
    return min(1.0 - exp(-depth), fog.params.w);
}

// The direction the environment's in-scatter is read in for a ray along unit `dir`: its azimuth at
// GX_FOG_HORIZON_SLOPE above the horizon (a vertical ray reads towards +z).
fn gx_fog_horizon(dir: vec3<f32>) -> vec3<f32> {
    let around = length(dir.xz);
    let azimuth = select(vec2<f32>(0.0, 1.0), dir.xz / around, around > 1e-6);
    return normalize(vec3<f32>(azimuth.x, GX_FOG_HORIZON_SLOPE, azimuth.y));
}

// Henyey-Greenstein phase of the sun's forward lobe at `cos_theta` between ray and sun.
fn gx_fog_phase(cos_theta: f32) -> f32 {
    let g2 = GX_FOG_SUN_G * GX_FOG_SUN_G;
    let denominator = max(1.0 + g2 - 2.0 * GX_FOG_SUN_G * cos_theta, 1e-4);
    return (1.0 - g2) / (4.0 * GX_FOG_PI * denominator * sqrt(denominator));
}

// How much of the sun's lobe stays as the sun sets: 1 above the horizon, 0 a band under it.
fn gx_fog_sun_up(sun_y: f32) -> f32 {
    return smoothstep(-GX_FOG_SET_BAND, 0.0, sun_y);
}

// The colour of the sun's lobe for the sun's radiance `sun_color` as it reaches the ground: a third
// of the way to its luminance (D13), so the lobe keeps the sun's hue with less of its warmth.
fn gx_fog_sun_color(sun_color: vec3<f32>) -> vec3<f32> {
    return mix(sun_color, vec3<f32>(dot(sun_color, GX_FOG_LUMINANCE)), GX_FOG_SUN_DESATURATE);
}

// The sun's forward lobe the fog scatters towards the camera along unit `dir`, before the fog's
// tint (fog.rs `inscatter_env`'s lobe; the sky background's and the map backdrop's repeat it).
fn gx_fog_sun_lobe(dir: vec3<f32>) -> vec3<f32> {
    let sun = normalize(frame.sun_dir.xyz);
    return gx_fog_sun_color(frame.sun_color.rgb) * (gx_fog_sun_up(sun.y) * GX_FOG_SUN_SHARE * gx_fog_phase(dot(dir, sun)));
}

// How much of the sky's light read along the unit horizon direction `horizon` for the ray along
// unit `dir` is cut (D13): GX_FOG_SUN_SIDE_CUT of how much nearer the sun's lobe the read is than
// the ray (each the lobe's phase over its peak), none once the sun has set (fog.rs `sun_side_cut`).
fn gx_fog_sun_side(horizon: vec3<f32>, dir: vec3<f32>) -> f32 {
    let sun = normalize(frame.sun_dir.xyz);
    let nearer = gx_fog_phase(dot(horizon, sun)) - gx_fog_phase(dot(dir, sun));
    return GX_FOG_SUN_SIDE_CUT * gx_fog_sun_up(sun.y) * max(nearer, 0.0) / gx_fog_phase(1.0);
}

// The sky's light `sky`, read along `horizon` for the ray along `dir`, as the fog scatters it
// (D13): the aureole beyond the ray's own share weaker and moved towards its luminance (fog.rs
// `sun_side_sky`).
fn gx_fog_sky_light(sky: vec3<f32>, horizon: vec3<f32>, dir: vec3<f32>) -> vec3<f32> {
    let cut = gx_fog_sun_side(horizon, dir);
    return mix(sky, vec3<f32>(dot(sky, GX_FOG_LUMINANCE)), cut) * (1.0 - cut);
}

// The light the fog scatters towards the camera along unit `dir` (radiance, scene units).
fn gx_fog_inscatter(fog: GxFog, dir: vec3<f32>) -> vec3<f32> {
    let tint = fog.color.rgb;
    if !GX_ENVIRONMENT_LIGHT || frame.ambient.w < 0.5 {
        return tint;
    }
    let horizon = gx_fog_horizon(dir);
    let sky = gx_fog_sky_light(gx_env_sky(horizon, gx_env_lod(GX_FOG_ENV_ROUGHNESS)), horizon, dir);
    return tint * (sky + gx_fog_sun_lobe(dir));
}

// `color` with the sky's own scattering along the ray, from a grey texel (rgb in-scatter, a
// transmittance). Kept for Level-2 v2 shaders written against it; the chunk itself reads the air
// per channel (`gx_apply_air`).
fn gx_apply_aerial(color: vec3<f32>, aerial: vec4<f32>) -> vec3<f32> {
    return color * aerial.a + aerial.rgb;
}

// What the air between the camera and a surface does to its light (renderer pass 2 SI-04): the
// in-scatter, the transmittance per channel, and 1 where the volume holds the height fog too (the
// froxel fog's, A.5), 0 for the aerial perspective alone.
struct GxAir {
    inscatter: vec3<f32>,
    transmittance: vec3<f32>,
    holds_fog: f32,
}

// No air: the colour stays as it is.
fn gx_air_none() -> GxAir {
    return GxAir(vec3<f32>(0.0), vec3<f32>(1.0), 0.0);
}

// `color` seen through `air`.
fn gx_apply_air(color: vec3<f32>, air: GxAir) -> vec3<f32> {
    return color * air.transmittance + air.inscatter;
}

// Whether `air` already holds the height fog (the froxel fog's volume): the analytic fog is not
// added on top of it.
fn gx_air_holds_fog(air: GxAir) -> bool {
    return air.holds_fog > 0.5;
}

// The air volumes' slice mapping (fog.rs `aerial_slice_coordinate`, `AIR_NEAR`): slice coordinate
// `log2(1 + d / GX_AIR_NEAR) / log2(1 + GX_FOG_AERIAL_RANGE / GX_AIR_NEAR)` for the point `d` world
// units along its ray, even steps near the camera and logarithmic past GX_AIR_NEAR, out to
// GX_FOG_AERIAL_RANGE. The aerial volume and the froxel fog share it.
const GX_FOG_AERIAL_RANGE: f32 = 32000.0;
const GX_AIR_NEAR: f32 = 4.0;

fn gx_air_slice(distance: f32) -> f32 {
    let span = log2(1.0 + GX_FOG_AERIAL_RANGE / GX_AIR_NEAR);
    return clamp(log2(1.0 + max(distance, 0.0) / GX_AIR_NEAR) / span, 0.0, 1.0);
}

// An air volume's texture coordinate for the point `distance` away along the ray through screen
// `uv` (0..1, v down): the screen position and the slice coordinate (fog.rs
// `aerial_slice_distance` is the inverse).
fn gx_aerial_uvw(uv: vec2<f32>, distance: f32) -> vec3<f32> {
    return vec3<f32>(uv, gx_air_slice(distance));
}

// The air at coordinate `uvw` of `volume` (an air volume in the split layout, fog.rs `AIR_HALVES`:
// in-scatter in front, transmittance behind), read through the filtering `filtering` sampler inside
// half a texel of each half's edges (so no address mode wraps and no read blends the halves), and
// faded to no air in front of the first slice's centre (the air nearer than it is negligible, never
// a whole slice's). A volume one texel deep (a neutral input) is no air at all.
fn gx_air_sample(volume: texture_3d<f32>, filtering: sampler, uvw: vec3<f32>) -> GxAir {
    let size = textureDimensions(volume);
    if size.z < 2u {
        return gx_air_none();
    }
    let depth = f32(size.z);
    let edge = 0.5 / vec2<f32>(size.xy);
    let xy = clamp(uvw.xy, edge, vec2<f32>(1.0) - edge);
    let z = clamp(uvw.z * 0.5, 0.5 / depth, 0.5 - 0.5 / depth);
    let front = textureSampleLevel(volume, filtering, vec3<f32>(xy, z), 0.0);
    let back = textureSampleLevel(volume, filtering, vec3<f32>(xy, z + 0.5), 0.0);
    // Faded as `in-scatter × f, 1 - (1 - transmittance) × f` (the first slice's centre is at
    // uvw.z = 1 / depth): a texel of no air stays exactly no air.
    let f = clamp(uvw.z * depth, 0.0, 1.0);
    return GxAir(front.rgb * f, vec3<f32>(1.0) - (vec3<f32>(1.0) - back.rgb) * f, front.a);
}

// The volume coordinate of `world_pos` seen from the camera: its screen position and its distance
// (the camera's `view_proj`, jittered or not: a sub-pixel shift is below the volume's resolution).
fn gx_aerial_froxel(world_pos: vec3<f32>) -> vec3<f32> {
    let clip = frame.view_proj * vec4<f32>(world_pos, 1.0);
    let ndc = clip.xy / max(abs(clip.w), 1e-6);
    let uv = clamp(vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5), vec2<f32>(0.0), vec2<f32>(1.0));
    return gx_aerial_uvw(uv, length(world_pos - frame.camera_pos.xyz));
}

// `color` seen through the fog between the camera and `world_pos`.
fn gx_apply_fog(color: vec3<f32>, world_pos: vec3<f32>) -> vec3<f32> {
    let fog = gx_fog();
    if fog.color.a <= 0.0 {
        return color;
    }
    let origin = frame.camera_pos.xyz;
    let to_surface = world_pos - origin;
    let reach = length(to_surface);
    if reach <= 0.0 {
        return color;
    }
    let dir = to_surface / reach;
    let depth = gx_fog_optical_depth(fog, origin, dir, reach);
    if depth < GX_FOG_CLEAR_DEPTH {
        return color;
    }
    let opacity = gx_fog_opacity(fog, depth);
    return color * (1.0 - opacity) + gx_fog_inscatter(fog, dir) * opacity;
}

// `color` seen through a grey aerial texel (`aerial`, rgb in-scatter and a transmittance) and then
// the fog between the camera and `world_pos`. Kept for Level-2 v2 shaders written against it.
fn gx_apply_fog_aerial(color: vec3<f32>, world_pos: vec3<f32>, aerial: vec4<f32>) -> vec3<f32> {
    return gx_apply_fog(gx_apply_aerial(color, aerial), world_pos);
}

// `color` seen through `air` (the volume's at `gx_aerial_froxel(world_pos)`) and then the height
// fog between the camera and `world_pos`, unless the air holds it already (the froxel fog's): what a
// surface shows where the renderer binds an air volume.
fn gx_apply_fog_air(color: vec3<f32>, world_pos: vec3<f32>, air: GxAir) -> vec3<f32> {
    let seen = gx_apply_air(color, air);
    if gx_air_holds_fog(air) {
        return seen;
    }
    return gx_apply_fog(seen, world_pos);
}
