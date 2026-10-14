// Immediate 2D primitives (M2.6): rects, sprites and 2D lines as one batch of quads through the
// 2D camera, blended over the world target after the world pass. Colours arrive sRGB-encoded;
// sprite texels come from the colour texture arrays of their size class (an *Srgb format, so they sample linear) and
// are tinted in linear light before being encoded again for the Bgra8Unorm target.

struct Quad2dUniforms {
    view_proj: mat4x4<f32>,
}

@group(0) @binding(0) var<uniform> quad2d: Quad2dUniforms;
@group(0) @binding(1) var quad_textures: texture_2d_array<f32>;
@group(0) @binding(2) var quad_sampler: sampler;
// The colour arrays of the larger size classes (RQ6.4 texture quality: a sprite's source over 256
// texels lives there).
@group(0) @binding(3) var quad_textures_512: texture_2d_array<f32>;
@group(0) @binding(4) var quad_textures_1024: texture_2d_array<f32>;
@group(0) @binding(5) var quad_textures_2048: texture_2d_array<f32>;

const QUAD_NO_TEXTURE: u32 = 0xffffffffu;
// A quad's texture reference: size class in the top bits, layer below (`layout::texture_ref`,
// `TEXTURE_CLASS_SHIFT`); class 0 is the bare layer.
const QUAD_CLASS_SHIFT: u32 = 28u;
const QUAD_LAYER_MASK: u32 = (1u << QUAD_CLASS_SHIFT) - 1u;

// A texel of the larger size class `size_class` at `layer`, with explicit gradients (the class
// varies per quad).
fn quad_class_texel(size_class: u32, layer: u32, uv: vec2<f32>, uv_dx: vec2<f32>, uv_dy: vec2<f32>) -> vec4<f32> {
    switch size_class {
        case 1u: {
            return textureSampleGrad(quad_textures_512, quad_sampler, uv, layer, uv_dx, uv_dy);
        }
        case 2u: {
            return textureSampleGrad(quad_textures_1024, quad_sampler, uv, layer, uv_dx, uv_dy);
        }
        default: {
            return textureSampleGrad(quad_textures_2048, quad_sampler, uv, layer, uv_dx, uv_dy);
        }
    }
}

struct QuadOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) color: vec4<f32>,
    @location(2) @interpolate(flat) layer: u32,
}

@vertex
fn vs_quad(
    @location(0) position: vec2<f32>,
    @location(1) uv: vec2<f32>,
    @location(2) color: vec4<f32>,
    @location(3) layer: u32,
) -> QuadOut {
    var out: QuadOut;
    out.clip = quad2d.view_proj * vec4<f32>(position, 0.0, 1.0);
    out.uv = uv;
    out.color = color;
    out.layer = layer;
    return out;
}

fn quad_decode(c: vec3<f32>) -> vec3<f32> {
    let low = c / 12.92;
    let high = pow((c + 0.055) / 1.055, vec3<f32>(2.4));
    return select(high, low, c <= vec3<f32>(0.04045));
}

fn quad_encode(c: vec3<f32>) -> vec3<f32> {
    let clamped = clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
    let low = clamped * 12.92;
    let high = 1.055 * pow(clamped, vec3<f32>(1.0 / 2.4)) - 0.055;
    return select(high, low, clamped <= vec3<f32>(0.0031308));
}

@fragment
fn fs_quad(in: QuadOut) -> @location(0) vec4<f32> {
    // Class 0 sampled for every fragment (uniform control flow), used only by textured quads; a
    // larger class's texel replaces it.
    let textured = in.layer != QUAD_NO_TEXTURE;
    let size_class = select(0u, in.layer >> QUAD_CLASS_SHIFT, textured);
    var texel = textureSample(quad_textures, quad_sampler, in.uv, select(0u, in.layer, textured && size_class == 0u));
    let uv_dx = dpdx(in.uv);
    let uv_dy = dpdy(in.uv);
    if size_class > 0u {
        texel = quad_class_texel(size_class, in.layer & QUAD_LAYER_MASK, in.uv, uv_dx, uv_dy);
    }
    let tinted = vec4<f32>(quad_encode(quad_decode(in.color.rgb) * texel.rgb), in.color.a * texel.a);
    return select(in.color, tinted, textured);
}
