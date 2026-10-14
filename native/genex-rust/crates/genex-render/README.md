# genex-render

The wgpu renderer behind the `genex` facade, on WebGPU core: every feature runs on the six
destinations (macOS, Windows, Linux, iOS, Android, the web) without optional features, and
degrades to a cheaper variant or off instead of refusing a game. These notes are the renderer's
architecture; they live in the crate so an ejected game keeps them. The game-facing API is
`docs/GENEX_API.md` in the workspace (and in the game template).

## Rules

- GPU-facing structs (`src/layout.rs`, `src/abi.rs`) are `#[repr(C)]` arrays of `f32`/`u32` with
  hand padding, never glam types. `tests/layout.rs` holds each size to a golden table and to the
  size naga computes for the WGSL struct of the same name (`shaders/common.wgsl`).
- Every shader validates against WebGPU core with naga and emits HLSL SM 5.1, MSL 2.4 and SPIR-V
  1.3 (`tests/layout.rs`). Compute storage textures are `rgba16float` or `rgba8unorm`
  (write-only) and `r32float` (read-write); at most 4 per stage, at most 16 KB of workgroup memory.
- Every depth-writing vertex shader computes its position with `gx_clip_position`
  (`shaders/clip_position.wgsl`) and declares it `@invariant`.
- The Sim never reads the GPU: captures are a pure function of (state, camera, pinned settings,
  adapter, build). Temporal effects key their sequences to the renderer frame index and reset on
  camera cuts, resizes, settled captures and device re-creation.

## Settings

`src/settings.rs`: the game's `Look` (tonemapper, exposure, bloom, AO, fog, contact shadows),
`Environment` (flat colour, physical sky, HDR map) and `Meshlets` are equal on every device; the
`Quality` a preset or a device class picks switches and sizes features. `RenderSettings::off()`
is the renderer before the follow-up, exactly; existing goldens are drawn with it.

## Frame graph

`src/graph.rs` holds a fixed, ordered node table: no scheduler, no dependency solver. A node
runs when it has landed (`NodeId::landed`), its feature switch is on (`quality_allows`) and its
renderer enables it. In-pass nodes draw inside one world pass.

| # | node | kind |
| --- | --- | --- |
| 1 | tables | queue writes |
| 2 | Level-3 `before-cull` | compute |
| 3 | skinning | compute |
| 4 | light binning | compute |
| 5 | cull (instances; meshlets pass 1 with R2) | compute |
| 6 | shadows | pass |
| 7 | depth/normal prepass | pass |
| 8 | occlusion: Hi-Z build, meshlet cull pass 2, prepass part 2 | compute + pass |
| 9 | Level-3 `after-prepass` | pass |
| 10, 10a | ambient occlusion, contact shadows | pass |
| 11 | environment: sky LUTs, IBL bake | compute |
| 12-15 | opaque, sky, Level-2 materials and `after-opaque`, transparent | in the world pass |
| 15a, 16, 17 | reactive mask, MSAA resolve, TAA | pass |
| 18-21 | `post-hdr`, bloom, exposure, tonemap | pass / compute |
| 22-25 | upscale, 2D and `ldr` post, HUD, timestamps | pass / queue |

The HDR path draws camera views reverse-Z (`Greater`, cleared to 0) on `Depth32Float`; the
legacy path keeps standard Z. `GxFrameV2` and `GxPostV2` expose `depth_reversed`.

## Extension layouts

Level-2 materials and post passes declare `[[wgsl]] api = 1 | 2`. API 2 reads the v2 group map
of `src/abi.rs` (`MATERIAL_V2_BINDINGS`, `POST_V2_BINDINGS`): the frame (`GxFrameV2`), depth,
normals, motion, the environment and the HDR scene; group 2 is the game's. API 1 keeps loading
unchanged. Level-3 passes register at stage ids (`before-cull`, `after-prepass`, `after-opaque`,
`after-transparent`, `post-hdr`, `post`) that never change once shipped.

## Meshlets and Hi-Z occlusion (R2)

Meshes with at least `Meshlets::min_triangles` triangles (2048 by default) draw as meshlets
where the quality has `meshlets` on; the rest draw whole. A meshlet holds at most 64 vertices
and 124 triangles (`src/meshlet.rs`).

No preset turns meshlets or occlusion on (`presets::GEOMETRY_PATH_DEFAULT`): on the M4 Max they
measured slower than the instance path on every typical scene (R2 review, `meshlet-paths` record:
meshlets +26% to +51% GPU p50 at desktop-high 1080p, occlusion +49% to +55%, and about twice the
time on the mobile-high proxy), and no immediate-mode GPU has shown a gain. A game opts in per
class with the `meshlets` and `occlusion` switches. The library clusters lazily: the first quality
that draws meshlets clusters it, and it stays clustered, so a renderer on the instance path holds
no meshlet tables. When frames stop drawing meshlets, the GPU tables, the cull's working buffers
and the Hi-Z are given back (`Renderer::meshlet_bytes` is 0), and they count in
`FrameRenderer::held_bytes` while they are up.

Occlusion runs only over a one-sample world pass (`presets::occlusion_runs_with`): the Hi-Z is
built from the single-sample prepass at pixel centres, so over MSAA it would cull a meshlet that
is seen only through an edge pixel's uncovered samples. Every preset draws MSAA 4x until TAA
lands, so today occlusion runs only where anti-aliasing is off. With one sample, the meshlet path
draws the instance path's picture to the bit. Under MSAA, meshlets alone draw it too in every
recorded scene, but two draws that tie on an edge may resolve in another order.

Library buffers (`MeshletLibrary`), uploaded as read-only storage:

| buffer | element | meaning |
| --- | --- | --- |
| meshlets | `Meshlet`, 48 bytes | bounds sphere (xyz centre, w radius), normal cone (xyz axis, w cutoff; 1 means no cone), vertex offset, triangle offset, vertex count, triangle count |
| meshlet vertices | `u32` | the library vertex id of each meshlet vertex (mesh-local ids rebased by the mesh's base vertex) |
| triangles | `u32` | three meshlet-local vertex indices, one byte each, low byte first; the top byte is 0 |

A meshlet's ranges tile both buffers in order. The cone test is meshoptimizer's: a meshlet
faces wholly away from a viewer at `p` when
`dot(centre - p, axis) >= cutoff * |centre - p| + radius`.

Per frame (`src/meshlet_cull.rs`):

- **Candidates** are (instance, meshlet) pairs in `MeshletInstance` order; candidate `c` owns
  bit `c` of the visibility bitset.
- **Two-pass occlusion:** pass 1 draws what last frame's bitset marks and the Hi-Z is built
  from that depth. Pass 2 re-tests every candidate (instance sphere, then meshlet sphere and cone
  against the frustum and the new Hi-Z) and draws those that pass and were not drawn in pass 1.
  Its result is the next frame's bitset. History is only a hint: a wrong bit costs time, never a
  missing object.
- **History:** three bitsets, two live ones (ping-pong) and one that settled captures write,
  so a capture never reads, moves or resets the live history, whatever quality it draws. Live's
  history is keyed on the candidates' layout (each row's meshlet range and first candidate), not
  on global instance indices, so one more cube drawn before the clustered meshes keeps it. A
  reset (a new candidate layout, a Live frame without occlusion, a camera cut,
  `Renderer::reset_meshlet_history`, every capture re-render) makes pass 1 draw nothing and pass
  2 draw every candidate in view, so a capture holds no visibility history.
- **Compaction:** a three-dispatch scan (keep counts per 256-item block, an exclusive scan of the
  block sums, an ordered scatter). It uses no atomics and no inter-workgroup waits, so the draw
  order is the candidate order on every run.
- **Draws:** each view gets a compacted `u32` index buffer and one `draw_indexed_indirect`. An
  index is `slot << 6 | local`: the drawn slot (`DrawnMeshlet`: instance row, meshlet row) and
  the meshlet-local vertex. The vertex shader pulls the vertex from the library through the
  meshlet vertex buffer. The group is `layout::MESHLET_DRAW_BINDINGS` in group 2, after the
  forward frame group (0) and the pass view (1). WebGPU counts every storage binding a stage can
  see in the pipeline layout, read or not: the vertex stage sees 7 (the frame group's 3 and the
  meshlet group's 4; core allows 8), so one vertex-stage table is left. The meshlet group stays
  vertex-only: the fragment stage already sees 6 of the frame group's tables.
- **Shadow views** test the frustum and the cone only.
- **Fallback:** each view's index region is sized on the CPU from the instances its frustum
  holds. A view whose region does not fit one storage binding draws its batches the instance
  way (shadow cascades fall back first, then the camera), so a frame never fails over it.

**Hi-Z** (`src/hiz.rs`): an `r32float` chain from half the render size down to 1 × 1. Mip 0 is
read from depth by `textureLoad` in compute; each later mip reads the previous one as a sampled
texture and writes an `r32float` write-only storage view. Each texel keeps
the farthest depth it covers: the maximum under standard Z, the minimum under reverse-Z.

### `genex_meshlets` in glTF

The importer may store a primitive's meshlets in the primitive's `extras`, never as an
extension and never in `extensionsRequired`, so any glTF reader still draws the primitive:

```json
"extras": { "genex_meshlets": {
  "version": 1, "max_vertices": 64, "max_triangles": 124,
  "meshlets": 7, "vertices": 8, "triangles": 9
} }
```

`meshlets`, `vertices` and `triangles` are bufferView indices, not accessors: glTF reserves
`UNSIGNED_INT` accessors for indices. The views are little-endian. `meshlets` holds the 48-byte
records above, with offsets relative to this primitive's own `vertices` and `triangles`.
`vertices` holds one `u32` primitive vertex index per meshlet vertex, and `triangles` one packed
`u32` per triangle.

At load the set goes through `meshlet::validate`: limits, ranges that tile, indices in range,
and every primitive triangle exactly once with its winding kept. A set that fails is dropped with
a typed `MeshletFault`, and the mesh is clustered at runtime instead. An unknown `version` is
ignored the same way. The faults travel with the part (`GlbPart::meshlet_warnings`), and the
facade's model load logs each one by its wire spelling.

A loaded model keeps each part's merged set (`GlbPart::meshlets`: one part per material, `None`
when any of its primitives had none or was refused) and hands it to the renderer with the part
(`Renderer::add_meshes_with_meshlets`; the facade's `Uploads::add_meshes_with_meshlets`). The
device-loss `Resilient` keeps the sets with the upload and the game's `Meshlets` setting
(`Resilient::set_meshlets`), and a recovered renderer takes the setting before it replays them.
