# Set dressing (scatter)

An empty level becomes a dressed one by rules, not by hand: rubble along walls, papers round the
rubble, posters at eye height, grime at wall bases, puddles in patches, lamps and bollards along a
kerb, litter in the gutter. A `Dressing` runs named `Layer`s in order from one seed, so the same
inputs place the same things on every destination. (The terrain's grass and tree scatter is
`Terrain::scatter`, see Terrain; this is for everything else.)

```rust
use genex::{Dressing, Layer, Surface, Spline, Zone, Dressed, Placed};
Surface::floor(min_xz, max_xz, y);  Surface::wall(from, to, height, facing);  surface.and(&other);
Surface::from_mesh(&mesh_data, transform);  Surface::from_triangles(&gfx.assets().triangles(&m)?, transform);
Spline::new(&points);  Spline::polyline(&points);  spline.at(distance);  spline.points();  spline.length();
Zone::sphere(c, r);  Zone::cuboid(min, max);  Zone::along(&spline, radius);
Layer::on(&surface) | Layer::inside(min, max) | Layer::along(&spline, nearest, farthest)
    .density(per).cap(n).slope(a, b).height(lo, hi).spacing(m).clustered(m, coverage)
    .avoid(zone, margin).near(zone, m).avoid_layer("name", margin).near_layer("name", m)
    .align(0..1).scale(a, b).yaw(a, b).tilt(deg).sink(a, b).tint(a, b).variants(n);
let mut d = Dressing::new(seed);  d.layer("name", layer);  let dressed = d.run();
dressed.get("name") -> &[Placed];  dressed.transforms("name");  dressed.counts();
dressed.groups("name", &models, Some(&material)) -> Result<Vec<InstanceGroup>, InstanceGroupError>;
placed.decal(width, height) -> Decal;     // Placed { transform, normal, yaw, tint, variant }
```

## Layers

A layer tries `density` candidates (a square metre of a `Surface`, a cubic metre of `inside`, a
metre of a `Spline` for `along`) and its rules keep some:

| Rule | Keeps |
|-|-|
| `slope(a, b)` | normals `a` to `b` degrees from up: 0..30 floors, 80..100 walls, 150..180 ceilings |
| `height(lo, hi)` | world y in the band: skirting 0.1..0.5, posters 1.4..1.8 |
| `spacing(m)` | none within `m` of another of the layer's own |
| `clustered(m, coverage)` | patches about `m` across covering about `coverage` of the area (seeded noise) |
| `avoid(zone, margin)` | none inside the zone or within `margin` of it |
| `near(zone, m)` | only within `m` of the zone, thicker the closer |
| `avoid_layer / near_layer` | the same against an earlier layer's placements |
| `cap(n)` | at most `n` |

Each kept candidate gets a transform: `align(1)` lays it on the surface (a rock on a slope, a
poster on a wall), `scale`, `yaw` (degrees about its up), `tilt` (a lean of up to that many
degrees, for fallen things), `sink` (along the normal; negative into the ground) and a `tint`
brightness and `variants(n)` index for the groups. `Layer::along` turns placements to follow the
spline (yaw 0 is local +x along it) and puts them between `nearest` and `farthest` metres to
either side.

Order is the design: lay the largest things first (rubble, furniture clusters, lamps) and let
smaller layers refer to them (`near_layer("rubble", 1.0)`, `avoid_layer("lamps", 1.2)`), then the
wear. A layer may only refer to layers before it.

## Drawing the result

```rust
// on_reset
let dressed = dressing.run();
let rocks = [gfx.mesh(&rock_a)?, gfx.mesh(&rock_b)?, gfx.mesh(&rock_c)?];
world.groups = dressed.groups("rubble", &rocks, Some(&stone))?;       // one group per variant and tint
let wear: Vec<Decal> = dressed.get("grime").iter()
    .map(|p| p.decal(1.6, 0.6).with_base_texture("decals/grime.png")).collect();
// on_draw: frame.group(g) for each group, frame.decal(d) for each decal
```

`groups` makes an `InstanceGroup` for each variant (placement `variant` draws `models[variant %
len]`) and, with a material, for each of 4 tints of it, so a model's levels, impostor and a
far field (`group.with_far(Far::thin(12.0, 35.0))`, Instance groups) work as on any group; give
small clutter a far field. Model the variants as builds (Mesh builders: rocks from `cuboid().
subdivide(2).displace_noise(..)`, a different seed and size for each) or as GLBs. For trees and
grass use the terrain's scatter and impostors; for props from the library, pass their `Model`s.

`placed.decal(w, h)` is a `Decal` on the surface the placement stands on: facing out along its
normal, turned by its yaw, scaled by its scale; a floor decal reaches 0.5 m above and below, a
wall decal 0.2 m. Give it textures as any decal (grime, leaks, peeling, posters, puddles with
`with_roughness(0.06).with_flatten(1.0)`, cracks). A desktop preset draws 64 decals at most.

## Determinism and limits

Each layer's stream is seeded from the dressing's seed and the layer's name, and every candidate
draws the same numbers whether kept or not: another layer's presence never moves a layer that
does not refer to it, and a rule change drops placements without reshuffling the rest. Change
`Dressing::new(seed)` for another arrangement. A density that is not finite or not positive places
nothing; a layer tries at most `DRESSING_CANDIDATES_MAX` (1,048,576) candidates; a group holds at
most `INSTANCE_GROUP_MAX`. Zones and spacing are checked in world space, so build surfaces in
world space (`Surface::from_mesh(&mesh, the_transform_it_is_drawn_at)`).
`docs/examples/set-dressing/` dresses a room and a street this way, with the numbers.
