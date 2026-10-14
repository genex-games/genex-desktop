// The lake: a grid over the lake's bounds with small waves, its colour from the depth of the bed
// below (the terrain's heights in a storage buffer), the golden sky reflected by Fresnel, a glint
// streak under the low sun and foam where it laps the shore. Blended over the lake bed.

struct Water {
    // x: simulated seconds.
    params: vec4<f32>,
    // The bounds the grid and the bed heights cover: min x, min z, size x, size z.
    bounds: vec4<f32>,
    // x, y: bed samples per row and rows; z, w: grid cells per row and rows.
    grid: vec4<u32>,
}

struct WaterOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) world: vec3<f32>,
}

@group(0) @binding(0) var<uniform> gx_frame: GxFrameV2;

// How much the shoreline's foam covers the water where it laps.
const FOAM_COVER: f32 = 0.3;
// The share of the sun's light the lake's glint shows under the renderer's environment.
const WATER_SUN_GLINT: f32 = 0.3;
@group(1) @binding(0) var<uniform> water: Water;
@group(1) @binding(1) var<storage, read> bed: array<f32>;

fn bed_height(xz: vec2<f32>) -> f32 {
    let size = vec2<f32>(f32(water.grid.x - 1u), f32(water.grid.y - 1u));
    let uv = clamp((xz - water.bounds.xy) / water.bounds.zw, vec2<f32>(0.0), vec2<f32>(1.0)) * size;
    let cell = min(floor(uv), size - vec2<f32>(1.0));
    let f = uv - cell;
    let row = water.grid.x;
    let i = u32(cell.y) * row + u32(cell.x);
    let a = bed[i];
    let b = bed[i + 1u];
    let c = bed[i + row];
    let d = bed[i + row + 1u];
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// The swell's slope at `xz` (a few long directional waves).
fn swell(xz: vec2<f32>, t: f32) -> vec3<f32> {
    var height = 0.0;
    var slope = vec2<f32>(0.0);
    let dirs = array<vec2<f32>, 5>(vec2<f32>(0.8, 0.6), vec2<f32>(-0.3, 0.95), vec2<f32>(0.95, -0.3), vec2<f32>(0.2, 0.98), vec2<f32>(-0.7, 0.7));
    let freqs = array<f32, 5>(0.9, 1.7, 2.6, 4.1, 6.3);
    let amps = array<f32, 5>(0.022, 0.012, 0.007, 0.004, 0.0025);
    for (var k = 0; k < 5; k++) {
        let phase = dot(dirs[k], xz) * freqs[k] + t * (0.9 + f32(k) * 0.45);
        height += amps[k] * sin(phase);
        slope += amps[k] * freqs[k] * cos(phase) * dirs[k];
    }
    return vec3<f32>(slope, height);
}

@vertex
fn vs_water(@builtin(vertex_index) i: u32) -> WaterOut {
    let cell = i / 6u;
    let corner = i % 6u;
    let dx = array<u32, 6>(0u, 1u, 1u, 0u, 1u, 0u);
    let dz = array<u32, 6>(0u, 0u, 1u, 0u, 1u, 1u);
    let gx = cell % water.grid.z + dx[corner];
    let gz = cell / water.grid.z + dz[corner];
    let xz = water.bounds.xy + vec2<f32>(f32(gx) / f32(water.grid.z), f32(gz) / f32(water.grid.w)) * water.bounds.zw;
    let wave = swell(xz, water.params.x);
    let world = vec3<f32>(xz.x, WATER_LEVEL + wave.z, xz.y);
    var out: WaterOut;
    out.clip = gx_frame.view_proj * vec4<f32>(world, 1.0);
    out.world = world;
    return out;
}

@fragment
fn fs_water(in: WaterOut) -> @location(0) vec4<f32> {
    let t = water.params.x;
    let depth = WATER_LEVEL - bed_height(in.world.xz);
    if depth < -0.05 {
        discard;
    }
    let eye = gx_frame.camera_pos.xyz;
    let distance_to_eye = distance(eye, in.world);
    let calm = 1.0 - smoothstep(25.0, 140.0, distance_to_eye);
    let s = swell(in.world.xz, t).xy;
    let e = 0.07;
    let p = in.world.xz * 2.2 + vec2<f32>(t * 0.12, t * 0.05);
    let ripple = vec2<f32>(noise2(p + vec2<f32>(e, 0.0)) - noise2(p - vec2<f32>(e, 0.0)), noise2(p + vec2<f32>(0.0, e)) - noise2(p - vec2<f32>(0.0, e))) / (2.0 * e);
    let slope = (s * 1.4 + ripple * 0.035) * mix(0.25, 1.0, calm);
    let n = normalize(vec3<f32>(-slope.x, 1.0, -slope.y));
    let v = normalize(eye - in.world);
    var r = reflect(-v, n);
    r.y = abs(r.y);
    // The sky the lake mirrors: the environment's own light (smooth, its colour and brightness),
    // or the painted golden-hour sky without one.
    var reflected = sky(r, t);
    var glint_color = vec3<f32>(1.0, 0.72, 0.4);
    if environment_lights() {
        reflected = sh9_irradiance(gx_env_sh, r);
        glint_color = gx_frame.sun_color.rgb * WATER_SUN_GLINT;
    }
    // The far shore's hills and trees, reflected as a dark band along the horizon.
    let shore = 1.0 - smoothstep(0.01, 0.075, r.y);
    reflected = mix(reflected, vec3<f32>(0.05, 0.07, 0.06) + reflected * 0.2, shore * 0.8);
    let fresnel = 0.1 + 0.9 * pow(1.0 - max(dot(n, v), 0.0), 4.0);
    let deep = vec3<f32>(0.006, 0.024, 0.032);
    let shallow = vec3<f32>(0.04, 0.075, 0.06);
    let body_light = gx_frame.sun_color.rgb / PI * 0.45 + gx_frame.ambient.rgb;
    let body = mix(shallow, deep, smoothstep(0.0, 2.2, depth)) * body_light * 1.2;
    var color = mix(body, reflected * 0.92, clamp(fresnel * 1.25, 0.0, 1.0));
    let glint = max(dot(r, normalize(GLOW_DIR)), 0.0);
    color += glint_color * (pow(glint, 260.0) * 5.0 + pow(glint, 30.0) * 0.28);
    // A thin lap of foam where the water meets the shore, broken up by noise: a lake, not a surf.
    let foam_line = 1.0 - smoothstep(0.0, 0.05, depth);
    let foam = foam_line * smoothstep(0.55, 0.85, noise2(in.world.xz * 5.0 + vec2<f32>(t * 0.25, -t * 0.18)));
    color = mix(color, vec3<f32>(0.80, 0.74, 0.64) * body_light * 1.6, foam * FOAM_COVER);
    let alpha = clamp(mix(0.55, 0.97, smoothstep(0.0, 0.9, depth)) + fresnel * 0.55 + foam * 0.4, 0.0, 1.0);
    return vec4<f32>(scene_rgb(look_fog(color, in.world)), alpha);
}
