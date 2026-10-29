# Mesh builders

Shapes built in code that do not read as boxes: soft edges, turned and swept profiles, smoothed
and roughened solids. Build in `on_reset`, turn the data into a model once with `gfx.mesh(&data)`
(see Drawing, Built meshes) and draw it every frame. A real edge is never a knife edge: round it
(a few millimetres on furniture, 1 to 2 cm on plaster and stone) so it catches a highlight.

Every call in one line:

```rust
use genex::{MeshData, Profile};                                   // and ROUND_SEGMENTS_MAX, LATHE_SEGMENTS_MAX, SUBDIVIDE_LEVELS_MAX
let p = Profile::rect(w, h);  Profile::rounded_rect(w, h, r, segments);  Profile::circle(r, segments);
Profile::polygon(points);  Profile::polyline(points);  p.bevel(radius, segments);  p.length();
data.rounded_cuboid(min, max, radius, segments, metres);         // a box, every edge and corner rounded
data.extrude(&profile, depth, bevel, metres);                    // along +z from 0 to depth, caps bevelled
data.lathe(&profile, segments, metres);                          // x = radius, y = height, about +y
data.sweep(&profile, &path, metres);  data.tube(&path, radius, sides, metres);
data.subdivide(levels);  data.tessellate(levels);                // smooth (Loop) / finer, same shape
data.displace(|p| metres);  data.displace_noise(amplitude, wavelength, seed);
data.weighted_normals(smooth_degrees);  data.auto_uv(metres);  data.append(&part, transform);
genex::noise3(p, seed);  genex::fbm3(p, seed, octaves);          // -1..1, the same on every destination
```

Each builder appends to the mesh and returns it, so calls chain. Every one writes its own normals
and UVs in tiles of `metres` along the surface (a 1 m scan at its real size takes `metres` 1);
numbers out of range are clamped, never refused (a radius past half a side rounds as far as it
can, segments are held to their range), and the same call builds the same bytes everywhere.

## Shapes

```rust
use genex::prelude::*;
use genex::{MeshData, Profile};

// A desk: a top with 12 mm rounded edges on four round legs.
let mut desk = MeshData::new();
desk.rounded_cuboid(vec3(-0.6, 0.71, -0.3), vec3(0.6, 0.74, 0.3), 0.012, 6, 1.0);
for (x, z) in [(-0.55, -0.25), (0.55, -0.25), (0.55, 0.25), (-0.55, 0.25)] {
    desk.tube(&[vec3(x, 0.0, z), vec3(x, 0.71, z)], 0.014, 10, 1.0);
}
// A bench slat: a rounded section, its cut ends bevelled 4 mm.
let mut slat = MeshData::new();
slat.extrude(&Profile::rect(0.09, 0.045).bevel(0.008, 4), 1.6, 0.004, 1.0);
// A turned bin, a skirting swept round a room, a pipe with two bends.
let mut bin = MeshData::new();
bin.lathe(&Profile::polyline(vec![vec2(0.0, 0.0), vec2(0.15, 0.0), vec2(0.18, 0.4), vec2(0.19, 0.42), vec2(0.0, 0.42)]).bevel(0.004, 2), 32, 1.0);
let board = Profile::rounded_rect(0.018, 0.12, 0.004, 2);
let mut skirting = MeshData::new();
skirting.sweep(&board, &[vec3(-4.0, 0.06, -3.0), vec3(4.0, 0.06, -3.0), vec3(4.0, 0.06, 3.0)], 1.0);
let desk = gfx.mesh(&desk).expect("a desk"); // in on_reset; keep it in the world
```

- **`rounded_cuboid(min, max, radius, segments, metres)`**: `segments` is the facets across each
  edge (even, 2 a chamfer, 6 to 8 a soft cushion). Its flat parts keep exact face normals and the
  UVs [`cuboid`]'s; a radius of 0 is the plain cuboid.
- **`Profile`**: a 2D outline in metres, a closed counter-clockwise polygon (`polygon` turns a
  clockwise one round) or an open polyline. Its outside, where its normals face, is on the right
  as you walk it. `bevel(radius, segments)` rounds every corner (an open polyline keeps its ends;
  1 segment is a chamfer). A point where the outline turns less than 35 degrees shades smooth,
  a sharper turn stays a hard edge: bevel a profile for edges soft lengthways too.
- **`extrude(&profile, depth, bevel, metres)`**: a beam, a slat, a moulding, a kerb, a stair
  nosing. A polygon gets caps whose edges round over `bevel` (held to half the depth); an open
  polyline makes one sheet. Keep `bevel` under the profile's own corner radius.
- **`lathe(&profile, segments, metres)`**: a column, a vase, a bottle, a lamp, a turned leg. Walk
  the outline from bottom to top at positive x; a point on the axis closes the solid there; a
  closed polygon off the axis makes a ring (a torus, a tyre).
- **`sweep(&profile, &path, metres)`** and **`tube(&path, radius, sides, metres)`**: a rail, a
  pipe, a cable, a gutter, a kerb along a street, a moulding round a room. The profile's x is the
  path's right and its y the path's up (the world's up across the first segment, then turned as
  little as possible), and it widens through a sharp corner to keep its thickness. Smooth a path
  first with `Spline::new(&points).points()` (see Set dressing).

## Operations

- **`subdivide(levels)`** smooths (Loop subdivision; each level makes four triangles of one, up to
  `SUBDIVIDE_LEVELS_MAX` = 5) and gives smooth normals: a box becomes a pebble. Open borders
  stay borders. **`tessellate(levels)`** only splits, keeping the shape: vertices to displace.
- **`displace(|p| metres)`** moves every vertex along the surface's smooth normal (out positive);
  vertices at one position move together, so no crack opens. **`displace_noise(amplitude,
  wavelength, seed)`** is that with seeded fractal noise. A rock:
  `MeshData::new().cuboid(-size, size, 1.0).subdivide(2).displace_noise(0.08, 0.4, seed)`; vary
  the seed and the size for variants. A dented panel: `quad(..).tessellate(4).displace(..)`.
- **`weighted_normals(smooth_degrees)`** recomputes normals weighted by face area across faces
  that turn less than `smooth_degrees` (40 to 60 for hard-surface pieces): on a bevelled piece
  the large faces shade dead flat and only the bevels turn. 180 smooths all, 0 shades flat.
- **`auto_uv(metres)`** box-projects every triangle along the axis it faces most, as
  `Material::with_world_uv` projects the world, splitting the vertices between projections: any
  shape at a scan's real texel density. Use it after `displace` or on a mesh with no UVs.
- **`append(&part, transform)`** adds a part moved, turned and scaled (a mirroring scale rewinds
  it): one mesh and one draw from parts built apart.

Every operation treats vertices at one position as one point, so a mesh of faces with vertices of
their own (a cuboid's) smooths and moves whole while its UV seams stay. An operation on a mesh
`check()` refuses leaves it as it is, for `gfx.mesh` to name the refusal. Limits are `gfx.mesh`'s:
262,144 vertices and triangles (`MESH_VERTICES_MAX`, `MESH_TRIANGLES_MAX`); a subdivision level
that would pass them is not applied.

## When to build, when to model

Build in code what is made of profiles and parts: furniture frames, trims, mouldings, kerbs,
railings, pipes, posts, frames, rubble and rocks (subdivide and displace), modular walls with
rounded reveals. A shape that needs sculpting, a rig or a hand-painted texture (a character, a
car, a sofa, a tree) is still a GLB: generated, a CC0 download or a Blender script. A built
mesh's material is the drawing's (`frame.model_with`); give it a CC0 scan at its real size.
`docs/examples/set-dressing/` builds a whole room and street this way.
