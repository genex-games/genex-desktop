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
    // x: half height (0: as wide as high); yzw: the centre last frame (TAA's reactive coverage).
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

// Corner `i` of `sprite`'s quad in the world.
fn sprite_corner(i: u32, sprite: SpriteIn) -> vec3<f32> {
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
    return sprite.center_size.xyz + right * uv.x * half_width + up * uv.y * half_height;
}

fn sprite_out(i: u32, sprite: SpriteIn) -> SpriteOut {
    let corners = array<vec2<f32>, 6>(vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0));
    var out: SpriteOut;
    out.clip = gx_frame.view_proj * vec4<f32>(sprite_corner(i, sprite), 1.0);
    out.uv = corners[i];
    out.color = sprite.color;
    out.kind = sprite.axis_kind.w;
    return out;
}

@vertex
fn vs_sprite(@builtin(vertex_index) i: u32, sprite: SpriteIn) -> SpriteOut {
    return sprite_out(i, sprite);
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

// --- TAA's reactive coverage (renderer pass 2, B.7) -------------------------------------------
// A sprite moving through the scene does not share the motion of what lies behind it, so TAA would
// reproject its last position's history and trail or pop it (the fireflies' halos on an orbit or a
// dolly). Where it moved on screen against the scene behind it since last frame it writes how much
// of the pixel it owns into the reactive mask, from none below REACTIVE_STILL_PX to all of it at a
// pixel a frame. The scene behind is taken at infinity in the sprite's direction, so a camera
// turning about its eye (which moves every depth alike) asks for none, and a sprite whose glow is
// smaller than REACTIVE_SIZE_PX on screen writes none either: its jittered current sample is a
// sub-pixel spot that comes and goes (a mote taken whole popped on every pan). A still sprite
// under a still camera writes none, so a settled capture is unchanged.

// The motion against the scene (pixels a frame) below which a sprite writes no coverage.
const REACTIVE_STILL_PX: f32 = 0.05;
// The glow's on-screen half width (pixels) from which a sprite writes its coverage whole.
const REACTIVE_SIZE_PX: f32 = 4.0;
// How much coverage a glow's light writes per unit of its strongest channel.
const REACTIVE_GLOW_GAIN: f32 = 2.5;
// The most coverage a sprite writes (FSR2's guidance: a tenth of the history stays).
const REACTIVE_MAX: f32 = 0.9;

// The NDC of world point `p` (w 1) or direction `p` (w 0) through `m`; far off for a point behind it.
fn ndc_of(m: mat4x4<f32>, p: vec4<f32>) -> vec2<f32> {
    let clip = m * p;
    if clip.w <= 1e-6 {
        return vec2<f32>(1e6);
    }
    return clip.xy / clip.w;
}

// How far (pixels) a sprite now at `now` and last frame at `before` moved on screen against the
// scene at infinity behind it, through last frame's camera and this frame's (both unjittered).
fn parallax_px(now: vec3<f32>, before: vec3<f32>) -> f32 {
    let moved = ndc_of(gx_frame.unjittered_view_proj, vec4<f32>(now, 1.0)) - ndc_of(gx_frame.prev_view_proj, vec4<f32>(before, 1.0));
    let away = vec4<f32>(normalize(now - gx_frame.camera_pos.xyz), 0.0);
    let behind = ndc_of(gx_frame.unjittered_view_proj, away) - ndc_of(gx_frame.prev_view_proj, away);
    return length((moved - behind) * 0.5 * gx_frame.render_size);
}

// The half width (pixels) of a camera-facing sprite of `half_width` metres at `center`.
fn half_width_px(center: vec3<f32>, half_width: f32) -> f32 {
    let depth = max(dot(center - gx_frame.camera_pos.xyz, gx_frame.camera_forward.xyz), 1e-3);
    return half_width / depth * gx_frame.proj[1][1] * 0.5 * gx_frame.render_size.y;
}

struct SpriteReactiveOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) @interpolate(flat) color: vec4<f32>,
    @location(2) @interpolate(flat) kind: f32,
    // The share of its coverage the sprite writes, by how far its centre moved on screen.
    @location(3) @interpolate(flat) share: f32,
}

@vertex
fn vs_sprite_reactive(@builtin(vertex_index) i: u32, sprite: SpriteIn) -> SpriteReactiveOut {
    let base = sprite_out(i, sprite);
    var out: SpriteReactiveOut;
    out.clip = base.clip;
    out.uv = base.uv;
    out.color = base.color;
    out.kind = base.kind;
    let moved = parallax_px(sprite.center_size.xyz, sprite.extra.yzw);
    let size = half_width_px(sprite.center_size.xyz, sprite.center_size.w);
    out.share = saturate((moved - REACTIVE_STILL_PX) / (1.0 - REACTIVE_STILL_PX)) * smoothstep(REACTIVE_SIZE_PX * 0.5, REACTIVE_SIZE_PX, size);
    return out;
}

// How much of a pixel a glow owns at `uv` on its quad: its light over its strongest channel.
fn glow_cover(uv: vec2<f32>, color: vec4<f32>) -> f32 {
    let r2 = dot(uv, uv);
    let light = exp(-r2 * 5.0) * 0.55 + exp(-r2 * 60.0) * 1.6;
    return max(color.r, max(color.g, color.b)) * color.a * light * REACTIVE_GLOW_GAIN;
}

@fragment
fn fs_sprite_reactive(in: SpriteReactiveOut) -> @location(0) vec4<f32> {
    let r2 = dot(in.uv, in.uv);
    if in.share <= 0.0 || in.kind == KIND_POOL || r2 > 1.0 {
        discard;
    }
    var cover: f32;
    if in.kind == KIND_SMOKE {
        let body = exp(-r2 * SMOKE_FALLOFF) * (1.0 - smoothstep(0.5, 1.0, sqrt(r2)));
        cover = body * in.color.a;
    } else {
        cover = glow_cover(in.uv, in.color);
        // Where the glow draws its own motion (`fs_sprite_motion`) its history follows it.
        if cover >= GLOW_MOTION_COVER {
            discard;
        }
    }
    return vec4<f32>(min(cover, REACTIVE_MAX) * in.share, 0.0, 0.0, 1.0);
}

// --- The glows' own motion (renderer pass 2, B.7) ----------------------------------------------
// Wherever a glow shows (a firefly's halo near the camera, its faint ring included) it draws its
// own motion into TAA's motion target, so its history is fetched from where it was last frame
// instead of from the scene behind it. A dolly carried a near firefly across the screen faster
// than any reactive coverage could hide (one-frame discs and rings along its path).

// The glow coverage from which a glow writes its motion (below it, its reactive coverage).
const GLOW_MOTION_COVER: f32 = 0.002;

struct SpriteMotionOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) @interpolate(flat) color: vec4<f32>,
    @location(2) @interpolate(flat) kind: f32,
    // The centre's NDC motion, this frame's position minus last frame's (unjittered cameras).
    @location(3) @interpolate(flat) motion: vec2<f32>,
}

@vertex
fn vs_sprite_motion(@builtin(vertex_index) i: u32, sprite: SpriteIn) -> SpriteMotionOut {
    let base = sprite_out(i, sprite);
    var out: SpriteMotionOut;
    out.clip = base.clip;
    out.uv = base.uv;
    out.color = base.color;
    out.kind = base.kind;
    let now = ndc_of(gx_frame.unjittered_view_proj, vec4<f32>(sprite.center_size.xyz, 1.0));
    let before = ndc_of(gx_frame.prev_view_proj, vec4<f32>(sprite.extra.yzw, 1.0));
    // A centre behind either camera has no reprojection: no motion (the renderer's rule).
    out.motion = select(now - before, vec2<f32>(0.0), any(abs(now) > vec2<f32>(1e5)) || any(abs(before) > vec2<f32>(1e5)));
    return out;
}

@fragment
fn fs_sprite_motion(in: SpriteMotionOut) -> @location(0) vec4<f32> {
    if in.kind != KIND_GLOW || dot(in.uv, in.uv) > 1.0 || glow_cover(in.uv, in.color) < GLOW_MOTION_COVER {
        discard;
    }
    return vec4<f32>(in.motion, 0.0, 0.0);
}
