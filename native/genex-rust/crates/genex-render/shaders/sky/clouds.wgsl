// The cloud panorama's march (renderer pass 2 B.5, `clouds.rs`): for each texel (sky/clouds_map.wgsl's
// mapping) a ray from the camera through the layer, the light it gathers on the way and what is left
// of the sky behind it, into `rgba16float` (rgb the clouds' light as it reaches the camera, a the
// sky's share left behind them). A frame marches the whole panorama or one texel of every 4x4 block.
//
// The model is takram's three-clouds 0.7.6 (MIT) in outline, rewritten for this sky:
// - density: the weather field's coverage (a threshold that the layer's coverage lowers), a cumulus
//   height profile topped by the field's height variation, the Perlin-Worley shape remapped by its
//   Worley fbm (Schneider 2015), then eroded at the edges by the detail volume;
// - light: the sun through the atmosphere (the transmittance LUT) and the planet's shadow, a short
//   march towards it, Wrenninge's multiple-scattering octaves over a dual-lobe Henyey-Greenstein
//   phase with a powder term away from the sun, plus the sky's own light (the sky-view LUT's zenith
//   and horizon) as the ambient term, darker at the layer's base;
// - integration: Hillaire's energy-conserving step (Frostbite 2016), ending when the ray is opaque;
// - aerial perspective: the air between the camera and the transmittance-weighted mean depth of the
//   clouds (the transmittance LUT's ratio) dims their light, and the sky's light in front of them
//   (the sky-view LUT along the ray, the share the air there scatters) is added to it, so the
//   composite multiplies the sky behind (and the sun's disk) by the clouds' transmittance alone.
// Each texel starts its march at a 2 x 2 Bayer quarter plus an interleaved gradient noise of its own
// position, fixed over time (never takram's STBN texture): a texel marched again under the same sun
// writes the same value.

@group(0) @binding(0) var<uniform> atmosphere: SkyAtmosphere;
@group(0) @binding(1) var<uniform> params: CloudParams;
@group(0) @binding(2) var transmittance: texture_2d<f32>;
@group(0) @binding(3) var sky_view: texture_2d<f32>;
@group(0) @binding(4) var lut_sampler: sampler;
@group(0) @binding(5) var shape_noise: texture_3d<f32>;
@group(0) @binding(6) var detail_noise: texture_3d<f32>;
@group(0) @binding(7) var weather: texture_2d<f32>;
@group(0) @binding(8) var noise_sampler: sampler;
@group(0) @binding(9) var panorama_out: texture_storage_2d<rgba16float, write>;

struct CloudParams {
    // x: the base above the ground (km); y: the top; z: the coverage; w: the density.
    layer: vec4<f32>,
    // xy: the weather offset (km); z: the camera's height (km); w: the sky's radiance multiplier.
    offset: vec4<f32>,
    // xyz: towards the light (the sun, or the moon on a moonlit night); w: 1 for the moon.
    sun_dir: vec4<f32>,
    // rgb: the sun's illuminance outside the atmosphere.
    sun_illuminance: vec4<f32>,
    // xy: the slice's texel in each block; z: the block's side (1: the whole panorama).
    slice: vec4<u32>,
    // x: steps along a ray; y: steps towards the sun.
    steps: vec4<u32>,
}

// The noise's periods over the world, km: the shape, the erosion and the weather field.
const CLOUD_SHAPE_KM: f32 = 6.0;
const CLOUD_DETAIL_KM: f32 = 0.8;
const CLOUD_WEATHER_KM: f32 = 24.0;
// How deep the detail volume erodes the shape's edges (share of the density it cuts at most).
const CLOUD_EROSION: f32 = 0.5;
// Extinction at density 1 and full cloud, per km (cumulus: about 0.03 to 0.1 per metre).
const CLOUD_EXTINCTION_PER_KM: f32 = 20.0;
// The share of extinction that scatters (water droplets barely absorb).
const CLOUD_ALBEDO: f32 = 0.98;
// The farthest the layer is marched from and through, km (beyond, the air hides it).
const CLOUD_START_MAX_KM: f32 = 160.0;
const CLOUD_SPAN_MAX_KM: f32 = 16.0;
// The ray ends once less than this of the sky behind is left.
const CLOUD_OPAQUE: f32 = 0.01;
// The march towards the sun covers this much of the layer's thickness (at most this many km)
// along the vertical, so as far again along a slanting sun as the slant asks, up to the grazing
// reach: a low sun reaches a cloud's base only through kilometres of it, so the bases of the clouds
// overhead stay in their own shade at golden hour instead of glowing orange through (look lane SKY).
const CLOUD_LIGHT_SHARE: f32 = 0.6;
const CLOUD_LIGHT_MAX_KM: f32 = 2.0;
const CLOUD_LIGHT_GRAZING_KM: f32 = 10.0;
// The sine of the sun's elevation the slant is read at, at least (about 6 degrees).
const CLOUD_LIGHT_SLANT_MIN: f32 = 0.1;
// Wrenninge's octaves: each scatters this share as much, through this share of the optical depth,
// with this share of the phase's asymmetry.
const CLOUD_OCTAVES: u32 = 4u;
const CLOUD_OCTAVE_SCATTER: f32 = 0.7;
const CLOUD_OCTAVE_EXTINCTION: f32 = 0.35;
const CLOUD_OCTAVE_ECCENTRICITY: f32 = 0.5;
// The two Henyey-Greenstein lobes (forward, back) and the forward lobe's weight.
const CLOUD_FORWARD_G: f32 = 0.75;
const CLOUD_BACK_G: f32 = -0.25;
const CLOUD_FORWARD_WEIGHT: f32 = 0.6;
// The depth over which the powder term's density is read, km.
const CLOUD_POWDER_KM: f32 = 0.1;
// The ambient light at the layer's base, as a share of its top's.
const CLOUD_AMBIENT_BASE: f32 = 0.6;
// The coverage threshold's soft band, and the cumulus profile's rise (share of the layer).
const CLOUD_COVERAGE_BAND: f32 = 0.3;
const CLOUD_BASE_RISE: f32 = 0.1;
// The planet's shadow edge on the clouds, km either side of the shadow line.
const CLOUD_EARTH_SHADOW_KM: f32 = 0.6;
const CLOUD_LUMINANCE: vec3<f32> = vec3<f32>(0.2126, 0.7152, 0.0722);

fn cloud_remap(value: f32, low: f32, high: f32, to_low: f32, to_high: f32) -> f32 {
    return to_low + (value - low) / max(high - low, 1e-5) * (to_high - to_low);
}

// The transmittance from `height` km to the top along zenith cosine `mu` (sky_draw.wgsl's
// sky_transmittance, repeated: WGSL has no includes).
fn cloud_transmittance(height: f32, mu: f32) -> vec3<f32> {
    let bottom = atmosphere.radii.x;
    let top = atmosphere.radii.y;
    let r = bottom + clamp(height, 0.0, top - bottom);
    let horizon = sqrt((top - bottom) * (top + bottom));
    let rho = sqrt(max(r * r - bottom * bottom, 0.0));
    let discriminant = (top - r) * (top + r) + r * r * mu * mu;
    let d = max(0.0, -r * mu + sqrt(max(discriminant, 0.0)));
    let d_min = top - r;
    let d_max = rho + horizon;
    let uv = vec2<f32>((d - d_min) / max(d_max - d_min, 1e-6), rho / horizon);
    return textureSampleLevel(transmittance, lut_sampler, uv, 0.0).rgb;
}

// The distance from `origin` (planet-centred, km) along unit `dir` to the sphere of `radius` the
// origin lies inside.
fn cloud_exit(origin: vec3<f32>, dir: vec3<f32>, radius: f32) -> f32 {
    let b = dot(origin, dir);
    let c = dot(origin, origin) - radius * radius;
    return -b + sqrt(max(b * b - c, 0.0));
}

// The layer's density at planet-centred `p`, `fraction` of the way up the layer (`eroded`: with the
// detail volume's erosion).
fn cloud_density(p: vec3<f32>, fraction: f32, eroded: bool) -> f32 {
    if fraction <= 0.0 || fraction >= 1.0 {
        return 0.0;
    }
    let ground = p.xz + params.offset.xy;
    let field = textureSampleLevel(weather, noise_sampler, ground / CLOUD_WEATHER_KM, 0.0);
    let threshold = 1.0 - params.layer.z;
    let local = smoothstep(threshold - CLOUD_COVERAGE_BAND, threshold + CLOUD_COVERAGE_BAND, field.r) * params.layer.z;
    if local <= 0.0 {
        return 0.0;
    }
    // A dome: a clump rises highest where the field covers most, lower towards its edges.
    let top = mix(0.2, 1.0, local / max(params.layer.z, 1e-3)) * mix(0.7, 1.0, field.g);
    let profile = clamp(fraction / CLOUD_BASE_RISE, 0.0, 1.0) * (1.0 - smoothstep(top * 0.5, top, fraction));
    if profile <= 0.0 {
        return 0.0;
    }
    let height = fraction * (params.layer.y - params.layer.x);
    let at = vec3<f32>(ground.x, height, ground.y);
    let shape = textureSampleLevel(shape_noise, noise_sampler, at / CLOUD_SHAPE_KM, 0.0);
    let fbm = shape.g * 0.625 + shape.b * 0.25 + shape.a * 0.125;
    let base = clamp(cloud_remap(shape.r, fbm - 1.0, 1.0, 0.0, 1.0), 0.0, 1.0) * profile;
    var density = clamp(cloud_remap(base, 1.0 - local, 1.0, 0.0, 1.0), 0.0, 1.0);
    if eroded && density > 0.0 {
        let detail = textureSampleLevel(detail_noise, noise_sampler, at / CLOUD_DETAIL_KM, 0.0);
        let erosion = detail.r * 0.625 + detail.g * 0.25 + detail.b * 0.125;
        let wisps = mix(erosion, 1.0 - erosion, clamp(fraction * 5.0, 0.0, 1.0));
        density = clamp(cloud_remap(density, wisps * CLOUD_EROSION, 1.0, 0.0, 1.0), 0.0, 1.0);
    }
    return density * params.layer.w;
}

// Where planet-centred `p` lies in the layer (0 at its base, 1 at its top).
fn cloud_fraction(p: vec3<f32>) -> f32 {
    let base = atmosphere.radii.x + params.layer.x;
    return (length(p) - base) / max(params.layer.y - params.layer.x, 1e-3);
}

// The optical depth from `p` towards the sun through the layer.
fn cloud_light_depth(p: vec3<f32>, sun: vec3<f32>) -> f32 {
    let steps = max(params.steps.y, 1u);
    let vertical = min((params.layer.y - params.layer.x) * CLOUD_LIGHT_SHARE, CLOUD_LIGHT_MAX_KM);
    let reach = min(vertical / max(abs(sun.y), CLOUD_LIGHT_SLANT_MIN), CLOUD_LIGHT_GRAZING_KM);
    let n = f32(steps);
    var depth = 0.0;
    var travelled = 0.0;
    for (var i = 0u; i < steps; i++) {
        // Steps growing linearly (2i + 1) / n^2 of the reach: fine near the point, coarse far off.
        let step = reach * (2.0 * f32(i) + 1.0) / (n * n);
        let at = p + sun * (travelled + 0.5 * step);
        depth += cloud_density(at, cloud_fraction(at), false) * CLOUD_EXTINCTION_PER_KM * step;
        travelled += step;
    }
    return depth;
}

fn cloud_hg(cos_theta: f32, g: f32) -> f32 {
    let g2 = g * g;
    let denominator = max(1.0 + g2 - 2.0 * g * cos_theta, 1e-4);
    return (1.0 - g2) / (4.0 * GX_CLOUD_PI * denominator * sqrt(denominator));
}

// Wrenninge's multiple scattering over the dual-lobe phase at `cos_theta` through `depth` towards
// the sun.
fn cloud_scattering(cos_theta: f32, depth: f32) -> f32 {
    var sum = 0.0;
    var scatter = 1.0;
    var extinction = 1.0;
    var eccentricity = 1.0;
    for (var octave = 0u; octave < CLOUD_OCTAVES; octave++) {
        let phase = mix(cloud_hg(cos_theta, CLOUD_BACK_G * eccentricity), cloud_hg(cos_theta, CLOUD_FORWARD_G * eccentricity), CLOUD_FORWARD_WEIGHT);
        sum += scatter * phase * exp(-depth * extinction);
        scatter *= CLOUD_OCTAVE_SCATTER;
        extinction *= CLOUD_OCTAVE_EXTINCTION;
        eccentricity *= CLOUD_OCTAVE_ECCENTRICITY;
    }
    return sum;
}

// The sun's illuminance at planet-centred `p` through the air, in the planet's shadow none.
fn cloud_sunlight(p: vec3<f32>, sun: vec3<f32>) -> vec3<f32> {
    let r = length(p);
    let mu = dot(p / r, sun);
    var lit = 1.0;
    if mu < 0.0 {
        let closest = r * sqrt(max(1.0 - mu * mu, 0.0)) - atmosphere.radii.x;
        lit = smoothstep(-CLOUD_EARTH_SHADOW_KM, CLOUD_EARTH_SHADOW_KM, closest);
    }
    return params.sun_illuminance.rgb * cloud_air_tint(cloud_transmittance(r - atmosphere.radii.x, mu)) * lit;
}

// The air's transmittance `t` as the clouds take it: by the sun as it is; by the moon its luminance
// alone, so moonlit clouds keep the moon's own tint (night vision sees no warm cast: a low moon's
// reddened light drew them sepia; look lane SKY).
fn cloud_air_tint(t: vec3<f32>) -> vec3<f32> {
    if params.sun_dir.w > 0.5 {
        return vec3<f32>(dot(t, CLOUD_LUMINANCE));
    }
    return t;
}

// The sky's light the layer sits in: the sky-view LUT's cosine-weighted mean over the sky above
// (the zenith and rings at CLOUD_AMBIENT_RINGS elevations, CLOUD_AMBIENT_AZIMUTHS round each). Three
// horizon samples weighed like the zenith let the low sun's glow light the whole deck at golden
// hour, flat orange, and dyed the environment's ambient (look lane SKY).
const CLOUD_AMBIENT_AZIMUTHS: u32 = 8u;
const CLOUD_AMBIENT_RINGS: vec3<f32> = vec3<f32>(0.2618, 0.6981, 1.1345);
fn cloud_ambient(sun: vec3<f32>, height: f32) -> vec3<f32> {
    // The zenith's weight: a cap a ring's spacing wide, cos(theta) sin(theta) near 0 integrated.
    var sum = cloud_sky(vec3<f32>(0.0, 1.0, 0.0), sun, height) * 0.1;
    var weight = 0.1;
    for (var ring = 0u; ring < 3u; ring++) {
        let elevation = CLOUD_AMBIENT_RINGS[ring];
        // cos(zenith) sin(zenith) of the ring, shared by its samples.
        let share = sin(elevation) * cos(elevation) / f32(CLOUD_AMBIENT_AZIMUTHS);
        for (var i = 0u; i < CLOUD_AMBIENT_AZIMUTHS; i++) {
            let azimuth = (f32(i) + 0.5) / f32(CLOUD_AMBIENT_AZIMUTHS) * 2.0 * GX_CLOUD_PI;
            let dir = vec3<f32>(cos(elevation) * cos(azimuth), sin(elevation), cos(elevation) * sin(azimuth));
            sum += cloud_sky(dir, sun, height) * share;
            weight += share;
        }
    }
    return sum / weight;
}

// Where along its first step a texel's march starts: a quarter of the step from the texel's place in
// a 2 x 2 Bayer block, plus an interleaved gradient noise (Jimenez 2014) of its position within that
// quarter. The composite filters the panorama [1, 2, 1] / 4 each way (`gx_clouds_at`), which weighs
// the four places of any 2 x 2 block alike, so the Bayer part of the dither cancels there and only
// the noise inside each quarter is left (look fix lane SKY: a bare noise over the whole step showed
// as a cross-hatch along the clouds' edges at 4K).
fn cloud_start(texel: vec2<u32>) -> f32 {
    let p = vec2<f32>(texel);
    let bayer = f32(((texel.x & 1u) ^ (texel.y & 1u)) * 2u + (texel.y & 1u));
    return (bayer + fract(52.9829189 * fract(dot(p, vec2<f32>(0.06711056, 0.00583715))))) * 0.25;
}

// The clouds along unit `dir` from the camera: the cumulus layer, then the cirrus sheet above it
// seen through what the layer leaves (`cloud_cirrus`); rgb their light as it reaches the camera
// plus the sky's in front of them, a their transmittance (gx_clouds_over).
fn cloud_march(dir: vec3<f32>, texel: vec2<u32>) -> vec4<f32> {
    return cloud_cirrus(dir, cloud_cumulus(dir, texel));
}

// The cumulus layer along unit `dir` (`cloud_march`'s terms).
fn cloud_cumulus(dir: vec3<f32>, texel: vec2<u32>) -> vec4<f32> {
    let bottom = atmosphere.radii.x;
    let height = max(params.offset.z, 0.0);
    if dir.y < 0.0 || height >= params.layer.y {
        return vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }
    let camera = vec3<f32>(0.0, bottom + height, 0.0);
    let start = select(cloud_exit(camera, dir, bottom + params.layer.x), 0.0, height >= params.layer.x);
    if start > CLOUD_START_MAX_KM {
        return vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }
    let span = min(cloud_exit(camera, dir, bottom + params.layer.y) - start, CLOUD_SPAN_MAX_KM);
    let steps = max(params.steps.x, 1u);
    let step = span / f32(steps);
    let jitter = cloud_start(texel);
    let sun = normalize(params.sun_dir.xyz);
    let cos_theta = dot(dir, sun);
    // Away from the sun, the powder term darkens the clouds' thin edges (Schneider 2015): from the
    // sample's own density, at most half.
    let powder_share = 0.25 - 0.25 * cos_theta;
    let ambient = cloud_ambient(sun, height);
    let intensity = params.offset.w;
    var light = vec3<f32>(0.0);
    var through = 1.0;
    var depth_sum = 0.0;
    var depth_weight = 0.0;
    for (var i = 0u; i < steps; i++) {
        let t = start + (f32(i) + jitter) * step;
        let p = camera + dir * t;
        let fraction = cloud_fraction(p);
        let density = cloud_density(p, fraction, true);
        if density <= 0.0 {
            continue;
        }
        let extinction = density * CLOUD_EXTINCTION_PER_KM;
        let towards_sun = cloud_light_depth(p, sun);
        let powder = mix(1.0, 1.0 - exp(-extinction * CLOUD_POWDER_KM), powder_share);
        let sunlit = cloud_sunlight(p, sun) * (cloud_scattering(cos_theta, towards_sun) * powder * intensity);
        let skylit = ambient * mix(CLOUD_AMBIENT_BASE, 1.0, clamp(fraction, 0.0, 1.0));
        let source = (sunlit + skylit) * (extinction * CLOUD_ALBEDO);
        let segment = exp(-extinction * step);
        light += through * source * (1.0 - segment) / extinction;
        depth_sum += t * through * (1.0 - segment);
        depth_weight += through * (1.0 - segment);
        through *= segment;
        if through < CLOUD_OPAQUE {
            through = 0.0;
            break;
        }
    }
    if depth_weight <= 0.0 {
        return vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }
    // The air in front of the clouds: the transmittance LUT's ratio between the camera and their
    // mean depth.
    let mean = camera + dir * (depth_sum / depth_weight);
    let mean_r = length(mean);
    let air = cloud_air_tint(min(cloud_transmittance(height, dir.y) / max(cloud_transmittance(mean_r - bottom, dot(mean / mean_r, dir)), vec3<f32>(1e-6)), vec3<f32>(1.0)));
    // The sky in front of the clouds: what the air up to them scatters, the sky-view LUT's share
    // the clouds hide (the composite multiplies the whole sky by `through`).
    let front = cloud_sky(dir, sun, height) * (vec3<f32>(1.0) - air) * (1.0 - through);
    return vec4<f32>(cloud_moonlit(light) * air + front, through);
}

// The cirrus sheet (look fix lane SKY: the Lakeside's dusk had lost the game's streaky cirrus deck
// when the renderer's cumulus replaced its flat clouds): a sheet of ice cloud CIRRUS_HEIGHT_KM up,
// its cover the weather field read in streaks CIRRUS_STREAK_KM long and wide along CIRRUS_WIND
// in patches CIRRUS_PATCH_KM across,
// optically thin (CIRRUS_DEPTH at full cover straight up, more along a slant), single scattering of
// the sun through the air (the planet's shadow included, so it glows pink after the sun has set
// on the ground) over a mostly forward phase, plus the sky's light.
const CIRRUS_HEIGHT_KM: f32 = 8.0;
const CIRRUS_STREAK_KM: vec2<f32> = vec2<f32>(40.0, 9.0);
const CIRRUS_PATCH_KM: f32 = 70.0;
// The view's rise (sine of elevation) over which the streaks' fine octave fades in.
const CIRRUS_FINE_FADE: vec2<f32> = vec2<f32>(0.05, 0.3);
const CIRRUS_WIND: vec2<f32> = vec2<f32>(0.8, 0.6);
const CIRRUS_DEPTH: f32 = 0.6;
const CIRRUS_SOFT: f32 = 0.4;
const CIRRUS_SLANT_MIN: f32 = 0.1;
const CIRRUS_FORWARD_G: f32 = 0.6;
const CIRRUS_BACK_G: f32 = -0.2;
const CIRRUS_FORWARD_WEIGHT: f32 = 0.7;

// The sheet's cover (0..1) over a ground position (km, the layer's offset added), along unit
// `dir`: patches of the weather field CIRRUS_PATCH_KM across hold the sheet, and within them the
// field read in streaks; the streaks' fine octave fades towards the horizon, where a panorama texel
// spans kilometres of them (it aliased into a comb there).
fn cirrus_density(ground: vec2<f32>, dir: vec3<f32>) -> f32 {
    let along = dot(ground, CIRRUS_WIND) / CIRRUS_STREAK_KM.x;
    let across = dot(ground, vec2<f32>(-CIRRUS_WIND.y, CIRRUS_WIND.x)) / CIRRUS_STREAK_KM.y;
    let q = vec2<f32>(along, across);
    let patches = textureSampleLevel(weather, noise_sampler, ground / CIRRUS_PATCH_KM + vec2<f32>(0.5, 0.25), 0.0).r;
    let fine = smoothstep(CIRRUS_FINE_FADE.x, CIRRUS_FINE_FADE.y, dir.y);
    var f = textureSampleLevel(weather, noise_sampler, q, 0.0).r * 0.7;
    f += (textureSampleLevel(weather, noise_sampler, q * vec2<f32>(2.3, 1.7) + vec2<f32>(0.31, 0.17), 0.0).g - 0.5) * 0.3 * fine;
    let threshold = 1.0 - params.sun_illuminance.w;
    return smoothstep(threshold, threshold + CIRRUS_SOFT, f * 0.6 + patches * 0.4);
}

// `under` (the cumulus along unit `dir`) with the cirrus sheet behind it: the sheet's light and
// the sky in front of it reach the camera through what the cumulus leaves.
fn cloud_cirrus(dir: vec3<f32>, under: vec4<f32>) -> vec4<f32> {
    let height = max(params.offset.z, 0.0);
    let cover = params.sun_illuminance.w;
    if cover <= 0.0 || dir.y <= 0.0 || under.a <= 0.0 || height >= CIRRUS_HEIGHT_KM {
        return under;
    }
    let bottom = atmosphere.radii.x;
    let camera = vec3<f32>(0.0, bottom + height, 0.0);
    let p = camera + dir * cloud_exit(camera, dir, bottom + CIRRUS_HEIGHT_KM);
    let density = cirrus_density(p.xz + params.offset.xy, dir);
    if density <= 0.0 {
        return under;
    }
    let r = length(p);
    let slant = max(dot(p / r, dir), CIRRUS_SLANT_MIN);
    let through = exp(-density * CIRRUS_DEPTH / slant);
    let sun = normalize(params.sun_dir.xyz);
    let cos_theta = dot(dir, sun);
    let phase = mix(cloud_hg(cos_theta, CIRRUS_BACK_G), cloud_hg(cos_theta, CIRRUS_FORWARD_G), CIRRUS_FORWARD_WEIGHT);
    let source = cloud_sunlight(p, sun) * (phase * params.offset.w) + cloud_ambient(sun, height);
    let light = cloud_moonlit(source * (CLOUD_ALBEDO * (1.0 - through)));
    let air = cloud_air_tint(min(cloud_transmittance(height, dir.y) / max(cloud_transmittance(r - bottom, dot(p / r, dir)), vec3<f32>(1e-6)), vec3<f32>(1.0)));
    let front = cloud_sky(dir, sun, height) * (vec3<f32>(1.0) - air) * (1.0 - through);
    return vec4<f32>(under.rgb + under.a * (light * air + front), under.a * through);
}

// The clouds' own light `light` as night vision takes it under the moon: its luminance in the
// moon's light's colour (the game's tint), so the moonlit sky's reddened glow round a low moon
// lights them neutral, not sepia (look lane SKY). By the sun, as it is.
fn cloud_moonlit(light: vec3<f32>) -> vec3<f32> {
    if params.sun_dir.w <= 0.5 {
        return light;
    }
    let moon = params.sun_illuminance.rgb;
    return dot(light, CLOUD_LUMINANCE) * moon / max(dot(moon, CLOUD_LUMINANCE), 1e-12);
}

// The sky-view LUT along unit `dir` with the sun towards unit `sun` at `height` km (sky_draw.wgsl's
// sky_view_uv and sky_horizon, repeated: WGSL has no includes).
fn cloud_sky(dir: vec3<f32>, sun: vec3<f32>, height: f32) -> vec3<f32> {
    let size = vec2<f32>(textureDimensions(sky_view));
    let bottom = atmosphere.radii.x;
    let h = clamp(height, 0.001, atmosphere.radii.y - bottom - 0.01);
    let beta = acos(clamp(sqrt(h * (2.0 * bottom + h)) / (bottom + h), -1.0, 1.0));
    let horizon = GX_CLOUD_PI - beta;
    let zenith = acos(clamp(dir.y, -1.0, 1.0));
    let v = (1.0 - sqrt(max(1.0 - zenith / horizon, 0.0))) * 0.5;
    let flat_dir = vec2<f32>(dir.x, dir.z);
    let flat_sun = vec2<f32>(sun.x, sun.z);
    var light_view_cos = 1.0;
    if dot(flat_dir, flat_dir) > 1e-12 && dot(flat_sun, flat_sun) > 1e-12 {
        light_view_cos = clamp(dot(normalize(flat_dir), normalize(flat_sun)), -1.0, 1.0);
    }
    let u = sqrt(max(0.5 - 0.5 * light_view_cos, 0.0));
    return textureSampleLevel(sky_view, lut_sampler, (vec2<f32>(u, v) * (size - 1.0) + 0.5) / size, 0.0).rgb;
}

@compute @workgroup_size(8, 8, 1)
fn cs_clouds(@builtin(global_invocation_id) id: vec3<u32>) {
    let size = textureDimensions(panorama_out);
    let block = max(params.slice.z, 1u);
    let texel = id.xy * block + params.slice.xy;
    if any(texel >= size) {
        return;
    }
    let dir = gx_cloud_dir((vec2<f32>(texel) + 0.5) / vec2<f32>(size));
    textureStore(panorama_out, vec2<i32>(texel), cloud_march(dir, texel));
}
