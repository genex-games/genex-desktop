# Custom materials and post passes

Level 2 of the extension ladder is a WGSL source: declare each WGSL source in `genex.toml` as a `[[wgsl]]` row (`path`,
`kind = "material"` or `"post"`, `api = 1`) and compile it in with
`game.wgsl("shaders/glow.wgsl", include_str!("../shaders/glow.wgsl"))`: web, phone and export builds
have no game folder to read it from. In `on_reset`, `gfx.material(path, &uniforms)` returns a
`CustomMaterial` you draw with `frame.custom(mesh, transform, &material, tint)` (`mesh` is a `Model`,
`CustomMesh::Cube` or `CustomMesh::Sphere`, radius 1; change its uniforms later with
`gfx.set_material_uniforms(&material, &uniforms)`), and `gfx.post_pass(path)`, or
`gfx.post_pass_with(path, &uniforms)` for a source with a uniform block, returns a `PostPass` you run
with `frame.post_pass(&pass)` after the world and before the HUD. Uniforms are `f32`s in WGSL's
layout (pad a vec3 to four). Each counts one draw, and shaders read the tick's simulated seconds,
never wall time. A refused source never crashes: its material draws the magenta checker, its pass
is skipped, and `state().volatile.extensions` names it with a typed code (`wgsl-undeclared`,
`wgsl-kind-mismatch`, `extension-api-unavailable`, `wgsl-too-large`, `native-feature-missing`).
Custom materials cast no shadow yet (the shadow pass draws only the plain draws), so a
character or prop drawn only with `frame.custom` stands without one. Write new sources at
`api = 2`: a v2 material's `fs_material(in: GxMaterialInV2)` builds a surface with
`gx_surface_v2(..)` and returns `vec4(gx_shade_pbr(surface) + gx_expose(glow), 1.0)`, so the
renderer's sun, shadows (the preset's filter, cascade blend and end fade, the sun's contact
shadows), lights, environment (`frame.environment`), ambient occlusion (with its bent normal, or
on desktop `ultra` its screen-space bounce light),
the aerial perspective and fog reach it as they reach a built-in surface, on the HDR and the LDR
scene alike (`gx_expose` holds even a blinding emissive
under the scene's limit). `gx_surface_v2` takes no derivatives, so it does not filter a shiny
highlight against sparkle; wrap it as built-in surfaces are, in uniform control flow:
`let n = normalize(in.normal); let s = gx_filter_specular_v2(gx_surface_v2(in.world_position, n,
albedo, 0.0, 0.2), dpdx(n), dpdy(n));` `gx_draw.prev_model` is the draw's model last frame
(matched by its id) and `gx_draw.params.z` last frame's simulated seconds (`params.x` this
frame's), so a vertex animation can place itself at both times. The draws of one v2 material
and one mesh are one instanced call, and `gx_draw` is still the drawing instance's own row (group
1 holds the frame's read-only `gx_draws` table). A v2 post pass is one fragment entry, `@fragment fn fs_post(in: GxPostInV2) -> @location(0)
vec4<f32>`: `in.uv` runs (0, 0) top-left to (1, 1) bottom-right over the output, and
`gx_scene_uv(position)` turns a fragment position (`in.position`, or a uv you moved times
`gx_post.output_size`) into the uv to sample `gx_scene` at, which differs from `in.uv` when the
scene is drawn at a lower render scale: `textureSampleLevel(gx_scene, gx_sampler,
gx_scene_uv(in.position), 0.0)` is the frame as it is. `gx_post` holds `output_size`, `time`
(simulated seconds) and `frame_index` (key grain to it). A v2 post pass reads `gx_scene` and `gx_frame` (and `gx_env_sh`, the
environment's SH9) on the display-ready frame after the tonemap, and `gx_depth`, `gx_normals` and
`gx_motion` (the prepass's motion vectors, written whenever a source declares them; the
formula is under Custom GPU passes) (an effect on the HDR scene before it is a Level-3 `PostHdr` pass; grass or water a Level-3 pass draws shadows itself from the v2 tables' `gx_shadow_map`, under Custom GPU passes), and
textures from `gfx.texture(path)` bind through `gfx.material_textured(path, &uniforms,
&[&texture])` (a missing texture binds a white 1x1 texel, never the checker; game textures carry
their mips, and the linear sampler filters anisotropically). A v1 material keeps working
but its frame stays on the legacy LDR scene (`material-v1-in-hdr` in `degraded`). Where this build does not serve a source's `api` yet it is refused
`extension-api-unavailable`: write it at `api = 1` there.

The look's fog reaches a v2 material and particles as it reaches a built-in surface (`gx_shade_pbr`
applies it; call `gx_apply_fog` on linear radiance only for a surface shaded its own way), and
under the physical sky the air's aerial perspective with it (`fog_aerial_perspective = false`
turns that off). On desktop and web `high` and `ultra` the fog is a lit volume: the sun's shadows
carve shafts out of it and local lights glow in it, for built-in surfaces, transparents, v2
materials (through `gx_shade_pbr`) and particles alike. A Level-3 pass applying the fog from its
tables (`fog_color`, `fog_params`) draws the plain height fog, without shafts.

Shaders under TAA: a v2 material and a v2 pass in the world draw through `gx_frame.view_proj`,
which carries the jitter, so they line up with the scene; `inv_view_proj` is its inverse (the depth
they read was drawn jittered), `prev_jitter` last frame's jitter, and their motion uses
`unjittered_view_proj` and `prev_view_proj`. Post stages (`PostHdr`, `Post`, v2 post passes) read
TAA's resolved scene, which has no jitter, beside the jittered depth, normals and motion: project
markers and outlines with `unjittered_view_proj` and read the depth at that uv plus
`gx_frame.jitter * vec2(0.5, -0.5)` (`gx_post.jitter` in a post pass). Under TAA (`gx_frame.jitter`
is never zero then) key stochastic per-pixel noise (a dither, a jittered ray start, a slice offset)
to `frame_index` so the history averages it: noise that never moves stays as grain, and RCAS
sharpens it. The world pass draws one sample per pixel under TAA (MSAA is off, on every
destination). A budget refit that asks for other anti-aliasing draws the closest one the world
pass has and is listed `pipeline-change-deferred`, as a Studio run's preset change is while its
pipelines compile off the frame thread (Live keeps the last preset until then); a new window or
canvas size whose budget changes the samples rebuilds the world pass for them. TAA's knobs are the preset's; a game may tune
them per class from code only: `RenderConfig::new().class(class, ClassOverride { taa:
Some(TaaQuality::DEFAULT.with_jitter_cycle(JitterCycle::Sixteen)), ..Default::default() })`
(`.with_alpha_min(..)` for a steadier history, `.with_lod_bias(..)` for sharper textures).
