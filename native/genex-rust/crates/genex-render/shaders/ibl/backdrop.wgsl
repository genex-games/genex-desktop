// The HDR map behind the scene (graph node 13 under an HDR environment, RQ2): drawn inside the
// world pass at the far plane over whatever no opaque draw covered, like the sky's background
// (sky/sky_draw.wgsl), from the uploaded equirect map turned and scaled as the environment says.
// The map is drawn as it is, its sun included (the bake clamps the sun out of the light; the
// backdrop shows what the map holds). The level of detail follows the angle a pixel covers, so a
// small window does not alias a large map, and is taken from the view direction's derivatives,
// which have no seam where the map's u wraps. Radiance times the frame's pre-exposure.
//
// Fog: as the sky's background, the frame's fog takes the map at a very large finite distance
// into the map's colour at the horizon in the pixel's azimuth, tinted by the fog's colour
// (sky_draw.wgsl's closed form, repeated: WGSL has no includes; tests/sky.rs holds the two).
//
// The map's mapping is `ibl::equirect_uv` and the turn `ibl::map_direction` (equirect.wgsl's).

struct BackdropOut {
    @builtin(position) position: vec4<f32>,
    @location(0) ndc: vec2<f32>,
}

// x, y: cos and sin of the map's rotation about up; z: the map's radiance multiplier; w: unused.
struct BackdropParams {
    map: vec4<f32>,
}

@group(0) @binding(0) var<uniform> frame: GxFrameV2;
@group(0) @binding(1) var<uniform> backdrop: BackdropParams;
@group(0) @binding(2) var equirect: texture_2d<f32>;
@group(0) @binding(3) var equirect_sampler: sampler;

const BACKDROP_PI: f32 = 3.14159265358979;
// The largest radiance the HDR scene stores (lighting/output.wgsl's GX_SCENE_RADIANCE_MAX).
const BACKDROP_RADIANCE_MAX: f32 = 64512.0;
// The smallest angle a pixel is taken to cover (a degenerate camera reads the map's top level).
const BACKDROP_MIN_PIXEL_ANGLE: f32 = 1e-6;
// The level the fog's horizon colour is read at, above the pixel's (a little blurred).
const BACKDROP_FOG_LOD_BIAS: f32 = 2.0;

// --- Fog (sky_draw.wgsl's constants and optical depth) ---
const BACKDROP_FOG_REACH: f32 = 50000.0;
const BACKDROP_FOG_CLEAR_DEPTH: f32 = 1e-7;
const BACKDROP_FOG_FLAT_EXPONENT: f32 = 1e-2;
const BACKDROP_FOG_EXPONENT_LIMIT: f32 = 60.0;
const BACKDROP_FOG_HORIZON_SLOPE: f32 = 0.02;

fn backdrop_fog_exp(x: f32) -> f32 {
    return exp(clamp(x, -BACKDROP_FOG_EXPONENT_LIMIT, BACKDROP_FOG_EXPONENT_LIMIT));
}

// The fog's optical depth along the ray from the camera along unit `dir` for `reach` world units.
fn backdrop_fog_optical_depth(dir: vec3<f32>, reach: f32) -> f32 {
    let density = frame.fog_color.a;
    let start = frame.fog_params.z;
    if density <= 0.0 || reach <= start {
        return 0.0;
    }
    let falloff = frame.fog_params.x;
    let span = reach - start;
    let rise = falloff * dir.y;
    let exponent = rise * span;
    let start_exponent = falloff * (frame.camera_pos.y + dir.y * start - frame.fog_params.y);
    if abs(exponent) < BACKDROP_FOG_FLAT_EXPONENT {
        return density * backdrop_fog_exp(-start_exponent) * span * (1.0 - exponent * (0.5 - exponent / 6.0));
    }
    return density * (backdrop_fog_exp(-start_exponent) - backdrop_fog_exp(-start_exponent - exponent)) / rise;
}

@vertex
fn vs_backdrop(@builtin(vertex_index) index: u32) -> BackdropOut {
    let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
    let ndc = uv * 2.0 - 1.0;
    // The far plane: 0 under reverse-Z, 1 under standard Z.
    let far = select(1.0, 0.0, frame.depth_reversed == 1u);
    var out: BackdropOut;
    out.position = vec4<f32>(ndc, far, 1.0);
    out.ndc = ndc;
    return out;
}

// The map's coordinate for world direction `world`: the map turned by angle a about up shows its
// R(-a) w in world direction w (`ibl::map_direction`), u = 0.5 + atan2(z, x) / 2pi, v = acos(y) / pi.
fn backdrop_uv(world: vec3<f32>) -> vec2<f32> {
    let c = backdrop.map.x;
    let s = backdrop.map.y;
    let d = vec3<f32>(c * world.x - s * world.z, world.y, s * world.x + c * world.z);
    return vec2<f32>(0.5 + atan2(d.z, d.x) / (2.0 * BACKDROP_PI), acos(clamp(d.y, -1.0, 1.0)) / BACKDROP_PI);
}

// The map's radiance towards unit `dir` at level `lod`.
fn backdrop_radiance(dir: vec3<f32>, lod: f32) -> vec3<f32> {
    return textureSampleLevel(equirect, equirect_sampler, backdrop_uv(dir), lod).rgb * backdrop.map.z;
}

// `radiance` seen through the fog towards unit `dir`: blended into the map's colour at the horizon
// in `dir`'s azimuth (read at `lod`), tinted by the fog's colour.
fn backdrop_fogged(radiance: vec3<f32>, dir: vec3<f32>, lod: f32) -> vec3<f32> {
    if frame.fog_color.a <= 0.0 {
        return radiance;
    }
    let depth = backdrop_fog_optical_depth(dir, BACKDROP_FOG_REACH);
    if depth < BACKDROP_FOG_CLEAR_DEPTH {
        return radiance;
    }
    let opacity = min(1.0 - exp(-depth), frame.fog_params.w);
    let around = length(dir.xz);
    let azimuth = select(vec2<f32>(0.0, 1.0), dir.xz / around, around > 1e-6);
    let horizon_dir = normalize(vec3<f32>(azimuth.x, BACKDROP_FOG_HORIZON_SLOPE, azimuth.y));
    let horizon = backdrop_radiance(horizon_dir, lod + BACKDROP_FOG_LOD_BIAS);
    return radiance * (1.0 - opacity) + frame.fog_color.rgb * horizon * opacity;
}

@fragment
fn fs_backdrop(in: BackdropOut) -> @location(0) vec4<f32> {
    // A point on the near plane (1 under reverse-Z, 0 under standard Z): finite even with an
    // infinite far plane.
    let near = select(0.0, 1.0, frame.depth_reversed == 1u);
    let world = frame.inv_view_proj * vec4<f32>(in.ndc, near, 1.0);
    let dir = normalize(world.xyz / world.w - frame.camera_pos.xyz);
    // The angle one pixel covers against one map texel's (2 pi / width radians at the equator).
    let pixel = max(max(length(dpdx(dir)), length(dpdy(dir))), BACKDROP_MIN_PIXEL_ANGLE);
    let texel = 2.0 * BACKDROP_PI / f32(textureDimensions(equirect).x);
    let top = f32(textureNumLevels(equirect) - 1u);
    let lod = clamp(log2(pixel / texel), 0.0, top);
    let radiance = backdrop_fogged(backdrop_radiance(dir, lod), dir, lod);
    return vec4<f32>(min(radiance * frame.pre_exposure, vec3<f32>(BACKDROP_RADIANCE_MAX)), 1.0);
}
