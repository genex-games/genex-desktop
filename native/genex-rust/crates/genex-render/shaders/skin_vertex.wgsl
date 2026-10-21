// Vertex-shader skinning for mid and far characters (game systems AN-18): the shared chunk. A
// draw on this path reads its bind-pose vertex from the library's vertex buffer, blends its four
// joint matrices in the vertex stage and writes no skinned output: two vertex-stage storage tables,
// as the grass reads its blades. Each entry file (`skin_vertex_forward.wgsl`,
// `skin_vertex_prepass.wgsl`, `skin_vertex_shadow.wgsl`) declares the two tables at its module's
// free group:
//
//   skin_vertex_rows: array<SkinVertex>         the library's skin rows (`MeshLibrary::skin`)
//   skin_vertex_table: array<mat4x4<f32>>       each draw's record, then the palettes
//
// A draw's record (`skin_vertex::GpuSkinVertexRecord`, GX_SKIN_VERTEX_RECORD matrices) is its
// model matrix, its normal matrix, last frame's model matrix, then one matrix of words: x the
// first matrix of its palette, y last frame's palette's, z the skin-row offset (added to the
// vertex index, wrapping), w its material row; the second column's x its motion flags. A direct
// draw names its record by its instance index.
//
// The blend is `skin.wgsl`'s, term for term and in slot order, so a vertex skinned here is the
// one compute skinning writes (within the 1-LSB tolerance of the AN-18 golden).

const GX_SKIN_VERTEX_RECORD: u32 = 4u;

struct GxSkinVertexDraw {
    model: mat4x4<f32>,
    normal: mat4x4<f32>,
    prev_model: mat4x4<f32>,
    joint_base: u32,
    prev_joint_base: u32,
    skin_offset: u32,
    material: u32,
    flags: u32,
}

// The draw whose record is `record`.
fn gx_skin_vertex_draw(record: u32) -> GxSkinVertexDraw {
    let base = record * GX_SKIN_VERTEX_RECORD;
    let words = skin_vertex_table[base + 3u];
    var draw: GxSkinVertexDraw;
    draw.model = skin_vertex_table[base];
    draw.normal = skin_vertex_table[base + 1u];
    draw.prev_model = skin_vertex_table[base + 2u];
    draw.joint_base = bitcast<u32>(words[0].x);
    draw.prev_joint_base = bitcast<u32>(words[0].y);
    draw.skin_offset = bitcast<u32>(words[0].z);
    draw.material = bitcast<u32>(words[0].w);
    draw.flags = bitcast<u32>(words[1].x);
    return draw;
}

// The skinning matrix of library vertex `vertex` posed by the palette at `joint_base`.
fn gx_skin_vertex_matrix(vertex: u32, skin_offset: u32, joint_base: u32) -> mat4x4<f32> {
    let s = skin_vertex_rows[vertex + skin_offset];
    var m = mat4x4<f32>(vec4<f32>(0.0), vec4<f32>(0.0), vec4<f32>(0.0), vec4<f32>(0.0));
    for (var k = 0u; k < 4u; k++) {
        m = m + skin_vertex_table[joint_base + s.joints[k]] * s.weights[k];
    }
    return m;
}

// A bind-pose position skinned by `m`: the model-space point compute skinning stores.
fn gx_skin_vertex_position(m: mat4x4<f32>, position: vec3<f32>) -> vec3<f32> {
    return (m * vec4<f32>(position, 1.0)).xyz;
}

// A bind-pose direction (normal, tangent) skinned by `m` and normalized, as compute skinning
// stores it.
fn gx_skin_vertex_direction(m: mat4x4<f32>, direction: vec3<f32>) -> vec3<f32> {
    return normalize((m * vec4<f32>(direction, 0.0)).xyz);
}
