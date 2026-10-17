// Alpha testing (renderer pass 2, P2-0.12: S11, prior-art A4.0). A glTF `MASK` material's draws
// take their own batches and pipelines (`scene::DrawVariant`): the depth writers that see them (the
// prepass, the sun's casters and the world pass's depth step before its `Equal` shading) cut a
// fragment away where the base colour's alpha (factor times map) falls under the material's
// cutoff (`material_ext[row].params.w`). How the edge is resolved is the pipeline's
// `GX_ALPHA_MODE`:
// - GX_ALPHA_TEST: a plain test against the cutoff (the casters, and frames with no anti-aliasing);
// - GX_ALPHA_TO_COVERAGE: under MSAA the depth step writes the alpha, sharpened to about one pixel
//   of falloff around the cutoff (Golus 2017), and the pipeline turns it into sample coverage, so
//   the `Equal` shading that follows covers exactly those samples;
// - GX_ALPHA_HASHED: under TAA a stable hashed threshold per world-space cell of about a pixel,
//   turned by the frame (three.js `getAlphaHashThreshold`, MIT, after Wyman and McGuire 2017), so
//   the resolve averages the edge into partial coverage.
// The includer declares `materials`, `material_ext`, `color_textures`, `color_textures_512`,
// `color_textures_1024`, `color_textures_2048` and `texture_sampler` (its own bindings).

const GX_ALPHA_TEST: u32 = 0u;
const GX_ALPHA_TO_COVERAGE: u32 = 1u;
const GX_ALPHA_HASHED: u32 = 2u;
// How the pipeline resolves a cutout's edge (`renderer::AlphaMode`).
override GX_ALPHA_MODE: u32 = 0u;

// three.js's ALPHA_HASH_SCALE: the hash cell is about 1 / (0.05 x 20) = one pixel wide.
const GX_ALPHA_HASH_SCALE: f32 = 0.05;
// The golden ratio's fraction: the per-frame turn of the hashed threshold (a low-discrepancy walk).
const GX_ALPHA_HASH_TURN: f32 = 0.618034;
// The hashed threshold's turns repeat after this many frames (keeps the walk's float exact).
const GX_ALPHA_HASH_FRAMES: u32 = 64u;
// The least alpha slope a coverage edge is sharpened with (a flat alpha keeps its value).
const GX_ALPHA_SLOPE_MIN: f32 = 1.0e-4;

// The colour texel of material texture `reference` (size class and layer) at `uv` with explicit
// gradients, from its class's colour array.
fn gx_color_class_texel(reference: u32, uv: vec2<f32>, uv_dx: vec2<f32>, uv_dy: vec2<f32>) -> vec4<f32> {
    let at = i32(reference & GX_TEXTURE_LAYER_MASK);
    switch reference >> GX_TEXTURE_CLASS_SHIFT {
        case 0u: {
            return textureSampleGrad(color_textures, texture_sampler, uv, at, uv_dx, uv_dy);
        }
        case 1u: {
            return textureSampleGrad(color_textures_512, texture_sampler, uv, at, uv_dx, uv_dy);
        }
        case 2u: {
            return textureSampleGrad(color_textures_1024, texture_sampler, uv, at, uv_dx, uv_dy);
        }
        default: {
            return textureSampleGrad(color_textures_2048, texture_sampler, uv, at, uv_dx, uv_dy);
        }
    }
}

// Material row `material`'s base colour alpha at `uv`: the factor times its map's (a cutout map
// keeps its coverage down its mips, `texture::cutout_mip_chain`). Call it in uniform control flow:
// the gradients are taken here.
fn gx_mask_alpha(material: u32, uv: vec2<f32>) -> f32 {
    let uv_dx = dpdx(uv);
    let uv_dy = dpdy(uv);
    let row = materials[material];
    var alpha = row.base_color.a;
    if row.textures.x != NO_TEXTURE {
        alpha *= gx_color_class_texel(row.textures.x, uv, uv_dx, uv_dy).a;
    }
    return alpha;
}

// three.js's `hash2D` and `hash3D` (MIT).
fn gx_alpha_hash2(v: vec2<f32>) -> f32 {
    return fract(1.0e4 * sin(17.0 * v.x + 0.1 * v.y) * (0.1 + abs(sin(13.0 * v.y + v.x))));
}

fn gx_alpha_hash3(v: vec3<f32>) -> f32 {
    return gx_alpha_hash2(vec2<f32>(gx_alpha_hash2(v.xy), v.z));
}

// The hashed alpha threshold at `position` (world space), in (0, 1]: three.js's
// `getAlphaHashThreshold` (MIT), a hash on a grid of about one pixel at two scales blended by the
// pixel's footprint and remapped to a uniform threshold, turned by `frame` so successive frames
// cut different texels and TAA averages them. Call it in uniform control flow (derivatives).
fn gx_alpha_hash_threshold(position: vec3<f32>, frame_key: u32) -> f32 {
    let max_deriv = max(length(dpdx(position)), length(dpdy(position)));
    let pix_scale = 1.0 / (GX_ALPHA_HASH_SCALE * max(max_deriv, 1.0e-8));
    let pix_scales = vec2<f32>(exp2(floor(log2(pix_scale))), exp2(ceil(log2(pix_scale))));
    let alpha = vec2<f32>(gx_alpha_hash3(floor(pix_scales.x * position)), gx_alpha_hash3(floor(pix_scales.y * position)));
    let lerp_factor = fract(log2(pix_scale));
    let x = (1.0 - lerp_factor) * alpha.x + lerp_factor * alpha.y;
    let a = max(min(lerp_factor, 1.0 - lerp_factor), 1.0e-6);
    let cases = vec3<f32>(
        x * x / (2.0 * a * (1.0 - a)),
        (x - 0.5 * a) / (1.0 - a),
        1.0 - ((1.0 - x) * (1.0 - x) / (2.0 * a * (1.0 - a)))
    );
    var threshold = cases.z;
    if x < a {
        threshold = cases.x;
    } else if x < 1.0 - a {
        threshold = cases.y;
    }
    let turned = fract(threshold + f32(frame_key % GX_ALPHA_HASH_FRAMES) * GX_ALPHA_HASH_TURN);
    return clamp(turned, 1.0e-6, 1.0);
}

// Whether a fragment of material row `material` at `uv` (`position` in world space, the frame's
// key `frame_key`) survives the alpha test: 1 kept, 0 cut, or under alpha-to-coverage the alpha the
// pipeline turns into sample coverage. Hashed, the edge's coverage (the alpha sharpened to about a
// pixel of falloff around the cutoff) is compared with the hashed threshold, so only the edge's
// pixel dithers and a texel well above the cutoff is always kept, as `MASK` asks. Call it in
// uniform control flow, then discard on 0 where the pipeline does not take coverage.
fn gx_alpha_mask(material: u32, uv: vec2<f32>, position: vec3<f32>, frame_key: u32) -> f32 {
    let alpha = gx_mask_alpha(material, uv);
    let cutoff = material_ext[material].params.w;
    let slope = max(fwidth(alpha), GX_ALPHA_SLOPE_MIN);
    let coverage = clamp((alpha - cutoff) / slope + 0.5, 0.0, 1.0);
    let threshold = gx_alpha_hash_threshold(position, frame_key);
    if GX_ALPHA_MODE == GX_ALPHA_TO_COVERAGE {
        return coverage;
    }
    if GX_ALPHA_MODE == GX_ALPHA_HASHED {
        return select(0.0, 1.0, coverage >= threshold);
    }
    return select(0.0, 1.0, alpha >= cutoff && alpha > 0.0);
}
