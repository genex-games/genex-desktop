// Light sprites: fireflies, pollen in the low sun, the ducks' glints, the chimney's smoke and the
// pools the lanterns and windows cast on the grass (the lanterns and the cabin's windows are the
// scene's own lights and emissive materials, which Level-3 passes do not receive yet). One
// instanced quad each, blended premultiplied: a glow adds light (alpha 0), smoke both covers and
// adds.

struct SpriteIn {
    // xyz: centre; w: half width.
    @location(0) center_size: vec4<f32>,
    // rgb: linear colour; a: strength.
    @location(1) color: vec4<f32>,
    // xyz: the quad's normal for a quad fixed in the world (zero faces the camera); w: kind.
    @location(2) axis_kind: vec4<f32>,
    // x: half height (0: as wide as high).
    @location(3) extra: vec4<f32>,
}

struct SpriteOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) @interpolate(flat) color: vec4<f32>,
    @location(2) @interpolate(flat) kind: f32,
}

@group(0) @binding(0) var<uniform> gx_frame: GxFrameV2;

// How fast a smoke puff thins from its centre (exp(-r² × this) over the quad's unit radius).
const SMOKE_FALLOFF: f32 = 2.5;
// How much of a puff's light comes from the sky above it; the rest from the low sun's side.
const SMOKE_SKY_SHARE: f32 = 0.7;

const KIND_GLOW: f32 = 0.0;
const KIND_SMOKE: f32 = 2.0;
const KIND_POOL: f32 = 3.0;

@vertex
fn vs_sprite(@builtin(vertex_index) i: u32, sprite: SpriteIn) -> SpriteOut {
    let corners = array<vec2<f32>, 6>(vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0));
    let uv = corners[i];
    var right: vec3<f32>;
    var up: vec3<f32>;
    let axis = sprite.axis_kind.xyz;
    if dot(axis, axis) < 0.5 {
        let forward = gx_frame.camera_forward.xyz;
        right = normalize(cross(forward, vec3<f32>(0.0, 1.0, 0.0)));
        up = cross(right, forward);
    } else {
        let helper = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), abs(axis.y) > 0.9);
        right = normalize(cross(helper, axis));
        up = cross(axis, right);
    }
    let half_width = sprite.center_size.w;
    let half_height = select(sprite.extra.x, half_width, sprite.extra.x <= 0.0);
    let world = sprite.center_size.xyz + right * uv.x * half_width + up * uv.y * half_height;
    var out: SpriteOut;
    out.clip = gx_frame.view_proj * vec4<f32>(world, 1.0);
    out.uv = uv;
    out.color = sprite.color;
    out.kind = sprite.axis_kind.w;
    return out;
}

// The light smoke of colour `albedo` scatters: under the environment (the physical sky or a map)
// what a surface of that colour facing the sky and the sun reflects, so the smoke sits in the
// sky's light rather than glowing over it; on the flat colour (and the legacy scene) the painted
// colour as it is.
fn smoke_light(albedo: vec3<f32>) -> vec3<f32> {
    if !environment_lights() {
        return albedo;
    }
    let sky = sh9_irradiance(gx_env_sh, vec3<f32>(0.0, 1.0, 0.0));
    let sun_side = sh9_irradiance(gx_env_sh, normalize(GLOW_DIR));
    return albedo * mix(sun_side, sky, SMOKE_SKY_SHARE);
}

@fragment
fn fs_sprite(in: SpriteOut) -> @location(0) vec4<f32> {
    let r2 = dot(in.uv, in.uv);
    if in.kind == KIND_SMOKE {
        let n = noise2(in.uv * 2.0 + in.color.a * 13.0);
        // A soft puff: a Gaussian body faded to nothing at the quad's rim, so the puffs build a
        // wisp with no edge (pass-1 gate finding 09: hard-edged puffs stacked into a white beam).
        let body = exp(-r2 * SMOKE_FALLOFF) * (1.0 - smoothstep(0.5, 1.0, sqrt(r2)));
        let a = body * in.color.a * (0.6 + 0.4 * n);
        return vec4<f32>(scene_rgb(smoke_light(in.color.rgb)) * a, a);
    }
    if r2 > 1.0 {
        discard;
    }
    var light = exp(-r2 * 5.0) * 0.55 + exp(-r2 * 60.0) * 1.6;
    if in.kind == KIND_POOL {
        light = (1.0 - smoothstep(0.0, 1.0, sqrt(r2))) * 0.6;
    }
    return vec4<f32>(scene_rgb(in.color.rgb * in.color.a * light * glow_gain()), 0.0);
}
