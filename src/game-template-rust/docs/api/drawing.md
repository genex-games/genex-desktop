# Drawing

`frame.tag(name)` names what the following draws count under (`state().__render.tags`);
`frame.model(&model, transform)`, `frame.cube`, `frame.sphere`, `frame.line` and
`frame.clear(color)` record draws; `frame.lines(&points, color)` draws many segments (each pair of
points one segment, a trailing odd point dropped) as one logical draw, so a debug overlay of
thousands of segments counts once in `drawCalls` and draws the pixels a `frame.line` per segment
would. `gfx.assets().model("pond.glb")` in `on_reset` gives a model
handle; a missing or unsafe path (absolute, `..`, `.`, backslash) gives a missing model that
draws as a magenta checker, never a crash. A model the renderer could not load (not in
`assets/`, or malformed) is named in `state().__render.missingModels`, a key that is absent
while every model loads.
`state().__render.textures` names every texture the last frame bound, by asset path (an image
inside a GLB is `props/crate.glb#0`), with the usage it was bound as (`kind`: `color`, `data` or
`normal`) and where its texels came from (`family`: `bc`, `astc`, `etc2` or `rgba8` for a
compressed file the import step wrote, `source` for the image itself).
`state().__render.assetIssues` lists `{path, code}` to fix: `texture-uncompressed` names a loose
texture loaded from its image because the game ships no compressed file of it (give it a
`[[texture]]` row in `genex.toml`, or sample it from a model's material, so the import encodes
it), or an image inside a GLB (`props/crate.glb#0`) the game ships no compressed copy of (import
the model: the import writes each image a material samples beside it); `texture-family-refused`
names one whose compressed file the renderer refused (unreadable, or every size class it fits is
full: the log says which), so it is drawn from its image (fewer or smaller textures of that kind
keep it compressed); `tangents-runtime` names a model with a normal map and no tangents, so they
were generated when it loaded (import the model to have them written once). A compressed file
of 256 texels or less (under the smallest compressed size class) is drawn from its image by
design and named for nothing.
Both keys are absent while empty and never move the checksum.
The Studio's asset import writes a compressed (Draco, meshopt) or
quantized (`KHR_mesh_quantization`, gltfpack's default) GLB back plain with float attributes,
welds every model's identical vertices (skins and morph targets kept), gives a normal-mapped
model without tangents MikkTSpace ones (split at mirrored UV seams) and orders its vertices for
the GPU's vertex cache; at runtime an attribute
stored in any other layout than core glTF's is refused, never misread. A
model of 512 or more triangles gets simplified levels at import, and each drawn copy far from the
camera draws a coarser one, in its shadows too.

A game names its own levels with `model.with_levels(&[(lod1, 24.0), (lod2, 58.0)])` (each level a
GLB with the model's part count, its parts drawn with the model's parts' materials, at most
`LOD_LEVELS_MAX` = 3): a copy of scale 1 switches to `lod1` 24 m from the camera (to the nearest
point of its bounding sphere) at the nominal view (1080 rows, 60° fov, the one-pixel threshold),
a bigger copy or a sharper view later, a coarser quality preset sooner, with the renderer's
crossfades and shadows. `model.with_lod_bias(2.0)` holds every level twice as far (0.25..=4).
`gfx.assets().compound(&[&wood, &foliage])` draws several models as one: one transform, and every
part measures its level from the compound's one sphere, so a tree's wood and foliage switch
together; members keep their own levels and materials. A refused option draws the model whole and
is named in `state().__render.lodRefused` (`[{model, code}]`, absent while empty):
`levels-invalid` (no levels, too many, distances not finite, positive and increasing, a missing
or unsafe level, a level with levels of its own, a model that already has levels),
`levels-mismatch` (a level with another part count) and `compound-invalid` (no members, a missing
member, a nested compound); `model.lod_refusal()` answers the first and last at once.

`model.with_impostor(Impostor::hemi())` (side and above: trees, bushes, buildings) or
`Impostor::sphere()` (every side) draws the model past its last mesh level as a camera-facing card
baked from its own parts on the GPU, sized by the device class, lit and fogged like the mesh (its
last mesh level still casts the shadow); `.not_before(40.0)` keeps the mesh nearer than 40 m.
It works on a model with levels and on a compound (one card). Live bakes one model a frame
after it loads, its last mesh level standing in meanwhile; a capture bakes every model first, and
a lost device bakes again. A quality with impostors off keeps the last mesh level. An empty model
is refused `impostor-invalid` (a missing model at once, a GLB with no triangles at load) and
draws whole; `model.impostor()` answers the impostor in force. `state().volatile.render.lod`
shows the Live threshold, band, `species` against the class's `speciesCap` and the baked
impostors (`model`, `layout`, `frames`, `framePx`, `bytes`, `bakeMs`); it is never part of the
checksum.

The threshold and the crossfade band follow the quality preset: 2 px (band 0.15, half the
far-field copies) on `low`, 1.5 px (0.2, three quarters of them) on `medium`, 1 px (0.15, all) on
`high` and `ultra`. Phones
draw no finer than 2, 2.5 and 3 px (`mobile-high`, `-mid`, `-low`) and keep half, then a third, of
the far-field copies. A class's `[render.class.<class>]` may set `lod_threshold_px` (0.5..=8 px,
held to half..twice the preset's), `lod_fade_band` (0..=0.5 of the threshold; 0 is hard switches)
and `far_density` (0.1..=1, the far-field copies kept); in code
`.lod_at(class, LodConfig::new().threshold_px(4.0))`. A value outside its range is refused
`invalid-render-lod`. The settings panel's Detail distance slider moves the threshold from half to
twice the preset's.

`Camera::look_at(position, target)` places a view;
`Camera { projection: Projection::Orthographic, fovy: 12.0, ..Camera::look_at(position, target) }`
draws it orthographic, `fovy` then being the view's height in world units (a 2D or isometric
game: an object keeps its size at any distance).
