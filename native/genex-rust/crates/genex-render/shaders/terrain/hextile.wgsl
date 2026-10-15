// Hex-tiling against visible repeats (Morten S. Mikkelsen, "Practical Real-Time Hex-Tiling",
// JCGT 11(2) 2022; ported from `mmikk/hextile-demo` `hextiling.h`, MIT): the plane is split into a
// grid of hexagons, each samples the texture at its own random offset and rotation, and three
// hexagons blend at every point by their barycentric weights sharpened by the samples' luminance,
// so a tile's features never line up into a pattern. The vertex hash is an integer hash here (the
// demo's `sin` hash differs between GPUs), and the three tiles' coordinates are made once per uv
// so a layer's colour and data textures share them.

// The luminance contrast the blend keeps (the demo's `g_fallOffContrast`) and its exponent
// (`g_exp`).
const GX_HEX_FALLOFF_CONTRAST: f32 = 0.6;
const GX_HEX_EXPONENT: f32 = 7.0;
const GX_HEX_PI: f32 = 3.14159265;

// The three hexagons around a point: each one's uv and its rotation (cos, sin), and their
// barycentric weights.
struct GxHexTiles {
    uv0: vec2<f32>,
    uv1: vec2<f32>,
    uv2: vec2<f32>,
    rot0: vec2<f32>,
    rot1: vec2<f32>,
    rot2: vec2<f32>,
    weights: vec3<f32>,
}

// A vector in 0..1 from a hexagon's vertex id (an integer hash: the same bits on every GPU).
fn gx_hex_hash(v: vec2<i32>) -> vec2<f32> {
    var h = (bitcast<u32>(v.x) * 0x8da6b343u) ^ (bitcast<u32>(v.y) * 0xd8163841u);
    h = (h ^ (h >> 16u)) * 0x7feb352du;
    h = (h ^ (h >> 15u)) * 0x846ca68bu;
    h = h ^ (h >> 16u);
    return vec2<f32>(f32(h & 0xffffu), f32(h >> 16u)) / 65535.0;
}

// A hexagon's rotation (cos, sin) from its vertex id (`LoadRot2x2`, full strength).
fn gx_hex_rotation(v: vec2<i32>) -> vec2<f32> {
    var angle = f32(abs(v.x * v.y) + abs(v.x + v.y)) + GX_HEX_PI;
    angle = angle - 2.0 * GX_HEX_PI * floor(angle / (2.0 * GX_HEX_PI));
    if angle > GX_HEX_PI {
        angle -= 2.0 * GX_HEX_PI;
    }
    return vec2<f32>(cos(angle), sin(angle));
}

// `v` turned by the rotation (cos, sin) `r`, as the demo multiplies a row vector by its matrix.
fn gx_hex_turn(v: vec2<f32>, r: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(v.x * r.x + v.y * r.y, -v.x * r.y + v.y * r.x);
}

// A tangent-space normal's xy sampled in a hexagon turned by `r`, turned back onto the surface.
fn gx_hex_unturn(n: vec2<f32>, r: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(n.x * r.x - n.y * r.y, n.x * r.y + n.y * r.x);
}

// The centre of hexagon `v` in uv (`MakeCenST`).
fn gx_hex_centre(v: vec2<i32>) -> vec2<f32> {
    let p = vec2<f32>(v);
    return vec2<f32>(p.x + 0.5 * p.y, 0.8660254 * p.y) / 3.4641016;
}

// The three hexagons around `uv` (`TriangleGrid` and the tiles' coordinates of `hex2colTex`).
fn gx_hex_tiles(uv: vec2<f32>) -> GxHexTiles {
    let st = uv * 3.4641016;
    let skewed = vec2<f32>(st.x - 0.57735027 * st.y, 1.15470054 * st.y);
    let base = vec2<i32>(floor(skewed));
    let t = fract(skewed);
    let tz = 1.0 - t.x - t.y;
    let s = step(0.0, -tz);
    let s2 = 2.0 * s - 1.0;
    let w = vec3<f32>(-tz * s2, s - t.y * s2, s - t.x * s2);
    let si = i32(s);
    let v1 = base + vec2<i32>(si, si);
    let v2 = base + vec2<i32>(si, 1 - si);
    let v3 = base + vec2<i32>(1 - si, si);
    var tiles: GxHexTiles;
    tiles.rot0 = gx_hex_rotation(v1);
    tiles.rot1 = gx_hex_rotation(v2);
    tiles.rot2 = gx_hex_rotation(v3);
    let c1 = gx_hex_centre(v1);
    let c2 = gx_hex_centre(v2);
    let c3 = gx_hex_centre(v3);
    tiles.uv0 = gx_hex_turn(uv - c1, tiles.rot0) + c1 + gx_hex_hash(v1);
    tiles.uv1 = gx_hex_turn(uv - c2, tiles.rot1) + c2 + gx_hex_hash(v2);
    tiles.uv2 = gx_hex_turn(uv - c3, tiles.rot2) + c3 + gx_hex_hash(v3);
    tiles.weights = w;
    return tiles;
}

// The blend weights of three colour samples (`hex2colTex`): the barycentric weights to the
// demo's exponent, scaled by each sample's luminance (kept to the falloff contrast), normalized.
fn gx_hex_blend(tiles: GxHexTiles, c0: vec3<f32>, c1: vec3<f32>, c2: vec3<f32>) -> vec3<f32> {
    let luma = vec3<f32>(0.299, 0.587, 0.114);
    let lum = vec3<f32>(dot(c0, luma), dot(c1, luma), dot(c2, luma));
    let d = mix(vec3<f32>(1.0), lum, GX_HEX_FALLOFF_CONTRAST);
    let w = d * pow(max(tiles.weights, vec3<f32>(0.0)), vec3<f32>(GX_HEX_EXPONENT));
    return w / max(w.x + w.y + w.z, 1e-6);
}
