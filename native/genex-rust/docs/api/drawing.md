# Drawing

Every type and call in one line (each `frame.*` returns `&mut Frame`, so calls chain):

```rust
use genex::prelude::*;                                      // Frame, Transform, Color, Material, Model, MeshData, Camera
use genex::{Impostor, LodRefusalCode, MeshError, MeshErrorCode}; // and LOD_LEVELS_MAX, MESH_VERTICES_MAX
frame.tag("walls");                                         // later draws count under "walls"
frame.view_model(); frame.end_view_model();                 // the first-person arms and weapon between them
frame.model(&model, transform);                             // a GLB with its own materials
frame.model_with(&model, transform, &material);             // a GLB (or a built mesh) in one Material
frame.model_tinted(&model, transform, color);               // its own materials times a colour
frame.cube(transform, color);                               // a unit cube (-0.5..0.5), scaled by the transform
frame.cube_with(transform, &material);
frame.sphere(center, radius, color);                        // a Vec3 and a radius, never a Transform
frame.sphere_with(center, radius, &material);               // the same: frame.sphere_with(vec3(0.0, 1.0, 0.0), 0.5, &mat)
frame.line(from, to, color);
frame.lines(&points, color);                                // each pair of points one segment
frame.clear(color);
Transform::from_xyz(x, y, z).with_rotation(quat).with_scale(scale); // also ::from_translation(v), ::IDENTITY
Color::rgb(r, g, b); Color::rgba(r, g, b, a);               // u8 sRGB; Color::WHITE, BLACK, RED, GREEN, BLUE
gfx.assets().model("pond.glb");                             // -> Model, in on_reset
gfx.mesh(&data);                                            // -> Result<Model, MeshError>; error.code.wire()
data.cuboid(min, max, metres).quad(corners, metres);        // data: MeshData::new(); .vertex(p, n, uv) -> u32, .triangle(a, b, c)
model.with_levels(&[(lod1, 24.0)]).with_lod_bias(2.0).with_impostor(Impostor::hemi()); // -> Model
model.impostor(); model.lod_refusal();                      // -> Option<Impostor>, Option<LodRefusalCode>
gfx.assets().compound(&[&wood, &foliage]);                  // -> Model
Camera::look_at(position, target);                          // Camera { projection: Projection::Orthographic, fovy, .. }; fovy: vertical, degrees
```

Draw a first-person game's arms and weapon between `frame.view_model()` and
`frame.end_view_model()` (with their `frame.id`, as `docs/examples/fps-arms` does): screen-space
ambient occlusion and contact shadows, made for the world, leave them alone, and a soft fill from
over the camera's shoulder at the frame's exposure keeps them from going black against a bright
sky. Give them their real colours: a 3% black glove still reads as black.

There is no `Material::with_double_sided`. A GLB whose glTF material is `doubleSided` draws both
faces through `frame.model` or `frame.model_tinted`; `frame.model_with` replaces its materials and
culls back faces. A built card gets its back as a second quad wound the other way:
`data.quad([bl, br, tr, tl], 1.0).quad([br, bl, tl, tr], 1.0)`.

A `Transform` is `Transform::from_xyz(x, y, z)` or `Transform::from_translation(v)`, then
`.with_rotation(quat)` and `.with_scale(vec3(4.0, 3.0, 0.2))`: a 4 m wide, 3 m tall, 0.2 m thick
wall panel from the unit cube. Give such a panel `Material::with_world_uv(metres)`
(`docs/api/lighting.md`) and its texture keeps one size on every face instead of stretching; give
each panel `.with_uv_jitter(index)` (and the material `.with_stochastic_tiling(true)` or
`.with_macro_variation(strength, metres)`) so a corridor of them does not show the same tile over
and over.

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
camera draws a coarser one, in its shadows too. A GLB that reaches the game without them (it
skipped the import step) gets them at load the same way, up to 100,000 triangles; a bigger one
draws whole and the load's log says so.

`state().__render.look` says how the last frame looks, per tag (`frame.tag(name)`), from a coarse
raster of the world draws (160 cells across, after occlusion; the same on every device):
`coverage` and `flatCoverage` (its share of the screen, and the share drawn with neither a base
colour nor an emissive map: a coloured box), `texelsPerMetre` (the median base-colour texels a
metre of its visible surface gets), `pixelsPerMetre` (the screen pixels a metre of it covers),
`trianglesPerSquareMetre`, `normalMapShare`, `ormShare`, `alphaCardShare` (shares of its visible
cells), `draws`, `models` (the model paths it drew) and `primitiveOnly` (cubes and spheres alone);
the top level adds `coverage` and `flatCoverage` over every draw, tagged or not. Live measures it
every 15 frames, a capture every time; custom materials, characters, terrain, grass, water and
particles are not rasterised. A look-bar pass reads it: keep total `flatCoverage` under 0.02,
near surfaces at 512 texels a metre or more, and textured tags at `normalMapShare` 1.

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
last mesh level still casts the shadow). The card takes over where its error allows; hold a model's
mesh further with `.with_lod_bias(2.0)`. It works on a model with levels and on a compound (one card). Live bakes one model a frame
after it loads, its last mesh level standing in meanwhile; a capture bakes every model first, and
a lost device bakes again. A quality with impostors off keeps the last mesh level. An empty model
is refused `impostor-invalid` (a missing model at once, a GLB with no triangles at load) and
draws whole; `model.impostor()` answers the impostor in force. `state().volatile.render.lod`
shows the Live threshold, band, `species` against the class's `speciesCap` and the baked
impostors (`model`, `layout`, `frames`, `framePx`, `bytes`, `bakeMs`, `prebaked`); it is never
part of the checksum.

`game.impostor_bake(|gfx| gfx.assets().model("oak.glb").with_impostor(Impostor::hemi()))` bakes
that model's impostor when the game is built: the dev build bakes one atlas per device-class row
into its own output (never the game folder), and a run that draws the same model (the same files
and layout) loads it instead of baking, so a relaunch or a page load runs no bake (`prebaked`).
A changed model bakes at runtime until the next build. A model drawn by world streaming never
bakes mid-game: register it, or it keeps its last mesh level and is named `impostor-not-baked` in
`__render.lodRefused`.

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

Many copies cost what can be seen of them. Each sun cascade draws only the casters that can
shadow something the camera may see through it: a caster beside the view's light-space footprint,
or farther from the sun than every surface that reads the cascade (behind the camera under a sun
ahead of it), is left out, so a crowd or a forest behind the camera costs no shadow time, and a
cascade casts a copy at the coarser level of its mesh its map cannot show. Where a model's first
level would lose thin parts (rags, claws, ears), the import adds a finer level for its shadows
alone, which the nearer cascades cast and the camera never draws. A
frame of at least 1,024 opaque copies also tests each copy against a depth pyramid of what the
prepass (the camera) or a cascade (the sun) drew first, and leaves out what that hides, where it
measures that this pays (a walled street, a forest behind a hill). The pictures are the same;
there is nothing to set. For a crowd, draw plain models under a stable `frame.id` each (baked
poses past a skinned band of the nearest, under the class's skinned cap) and leave their levels to
the import. Measured on an M4 Max at `ultra` on its 3456x2169 full screen (which renders a
2560x1440 budget and upscales it by TAA), 1,000 and 5,000 such copies hold 60 fps with every
feature on; 10,000 hold a median of 60 fps at dynamic resolution's floor with every feature on,
dipping to 52-56 (their four sun cascades cost most of a frame). With the scale held at 1 they draw 30 to 40 fps: never
hold it.

**Built meshes.** Shapes the cube cannot make (a window recessed into a wall, a door frame, a
sill, a skirting board, a broken plaster edge, a stair) are built in `on_reset` from vertices with
`gfx.mesh(&data)`, which answers a `Model` like `gfx.assets().model(..)`'s: draw it with
`frame.model` or `frame.model_with`, give it `.with_levels`, an impostor or a compound, and read
its triangles with `gfx.assets().triangles(&model)` for a collider or a navmesh. Keep the handle in
the world and draw it every frame; build it once.

```rust
use genex::prelude::*;

// A 4 m wall, 3 m tall and 0.25 m thick, with a 1.2 x 1.4 m window 0.9 m up.
let mut wall = MeshData::new();
wall.cuboid(vec3(-2.0, 0.0, 0.0), vec3(-0.6, 3.0, 0.25), 1.0)
    .cuboid(vec3(0.6, 0.0, 0.0), vec3(2.0, 3.0, 0.25), 1.0)
    .cuboid(vec3(-0.6, 0.0, 0.0), vec3(0.6, 0.9, 0.25), 1.0)
    .cuboid(vec3(-0.6, 2.3, 0.0), vec3(0.6, 3.0, 0.25), 1.0);
let wall = gfx.mesh(&wall).expect("a wall"); // in on_reset; keep it in the world
// in on_draw:
frame.model_with(&wall, Transform::from_xyz(0.0, 0.0, -5.0), &plaster);
```

`MeshData` holds `positions`, `normals`, `uvs` (`Vec<Vec3>`, `Vec<Vec3>`, `Vec<Vec2>`) and
`indices` (`Vec<u32>`, three a triangle, counter-clockwise seen from its front). Fill them
yourself, or with `data.vertex(position, normal, uv)` (answers the index) and
`data.triangle(a, b, c)`, or with the builders: `data.quad([bottom_left, bottom_right, top_right,
top_left], metres)` (a flat quad as you face it) and `data.cuboid(min, max, metres)` (an
axis-aligned box), whose UVs are in tiles of `metres`, so faces of any size keep one texel size.
Leave `normals` empty to have them computed from the triangles (smooth where vertices are
shared), and `uvs` empty to project them from the world one tile a metre; tangents are always
computed. The same data builds the same model on every destination. `data.check()` answers
whether it builds; `gfx.mesh` refuses with a `MeshError` (`error.code.wire()`), making nothing:
`mesh-empty` (no position or no index), `mesh-not-triangles` (an index count not a multiple of
3), `mesh-index-out-of-range`, `mesh-attribute-mismatch` (normals or UVs given but not one per
position), `mesh-not-finite` and `mesh-too-large` (past `MESH_VERTICES_MAX` or
`MESH_TRIANGLES_MAX`, 262,144 each). A built mesh's path starts `genex-mesh/` and is no file under
`assets/`. Shapes that must not read as boxes (rounded edges, turned, swept or smoothed solids,
rocks) have builders: `docs/api/meshes.md`; filling a level with clutter, debris and wear is
`docs/api/scatter.md`. A bigger or organic shape (a car, a sofa, a tree) is still a GLB: generated,
a CC0 download or a Blender script.

`Camera::look_at(position, target)` places a view; its `fovy` is the vertical field of view in
degrees (45 by default; 65-75 for first person, `docs/api/camera.md` has the range and
`FirstPersonRig`).
`Camera { projection: Projection::Orthographic, fovy: 12.0, ..Camera::look_at(position, target) }`
draws it orthographic, `fovy` then being the view's height in world units (a 2D or isometric
game: an object keeps its size at any distance).
