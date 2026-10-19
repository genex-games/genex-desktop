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
`[[texture]]` row in `genex.toml`, or sample it from a model's material, so the import encodes it);
`texture-family-refused` names one whose compressed file the renderer refused (unreadable, or
every size class it fits is full: the log says which), so it is drawn from its image (fewer or
smaller textures of that kind keep it compressed).
Both keys are absent while empty and never move the checksum.
The Studio's asset import writes a compressed (Draco, meshopt) or
quantized (`KHR_mesh_quantization`, gltfpack's default) GLB back plain with float attributes,
welds every model's identical vertices (skins and morph targets kept), gives a normal-mapped
model without tangents MikkTSpace ones (split at mirrored UV seams) and orders its vertices for
the GPU's vertex cache; at runtime an attribute
stored in any other layout than core glTF's is refused, never misread. A
model of 512 or more triangles gets simplified levels at import, and each drawn copy far from the
camera draws a coarser one, in its shadows too.
`Camera::look_at(position, target)` places a view;
`Camera { projection: Projection::Orthographic, fovy: 12.0, ..Camera::look_at(position, target) }`
draws it orthographic, `fovy` then being the view's height in world units (a 2D or isometric
game: an object keeps its size at any distance).
