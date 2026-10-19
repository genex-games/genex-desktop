# Drawing

`frame.tag(name)` names what the following draws count under (`state().__render.tags`);
`frame.model(&model, transform)`, `frame.cube`, `frame.sphere`, `frame.line` and
`frame.clear(color)` record draws. `gfx.assets().model("pond.glb")` in `on_reset` gives a model
handle; a missing or unsafe path (absolute, `..`, `.`, backslash) gives a missing model that
draws as a magenta checker, never a crash. A model the renderer could not load (not in
`assets/`, or malformed) is named in `state().__render.missingModels`, a key that is absent
while every model loads. The Studio's asset import writes a compressed (Draco, meshopt) or
quantized (`KHR_mesh_quantization`, gltfpack's default) GLB back plain with float attributes, and
welds every model's identical vertices (skins and morph targets kept); at runtime an attribute
stored in any other layout than core glTF's is refused, never misread. A
model of 512 or more triangles gets simplified levels at import, and each drawn copy far from the
camera draws a coarser one, in its shadows too.
`Camera::look_at(position, target)` places a view;
`Camera { projection: Projection::Orthographic, fovy: 12.0, ..Camera::look_at(position, target) }`
draws it orthographic, `fovy` then being the view's height in world units (a 2D or isometric
game: an object keeps its size at any distance).
