# Vegetation

Trees, shrubs and grass clumps are grown in code with `gfx.plant`, not modelled from cones, boxes
or spheres. Any model sways in the wind with `Model::with_wind`, a grown plant or a CC0 tree alike.

The plant types are in `genex::plants`; the wind types are at the crate root. Every type and call
in one line:

```rust
use genex::plants::{PlantSpec, Season, Species};             // and plant_glb, PlantGlb, PlantFacts, PLANT_*
use genex::WindResponse;                                      // and FOLIAGE_CUTOFF, WIND_STRENGTH_MAX
PlantSpec::new(Species::Birch, Season::Winter).seed(7).height(16.0).texture_size(1024);
gfx.plant(&spec);                                             // -> Model (on_reset), never refused
model.with_wind(WindResponse::tree().with_strength(1.5));     // WindResponse::shrub(), WindResponse::grass()
genex::plants::plant_glb(&spec);                              // -> PlantGlb { levels, distances, facts }
```

```rust
// on_reset: three birch seeds scattered over the snow, one retained group each.
for seed in 1..=3 {
    let birch = gfx.plant(&PlantSpec::new(Species::Birch, Season::Winter).seed(seed));
    let placed = terrain.scatter(&Scatter::new(0.004, &[0]).with_scale(0.85, 1.15).with_seed(seed), min, max);
    sim.world.birches.push(InstanceGroup::models(&birch, placed).expect("a group"));
}
// on_draw:
for group in &sim.world.birches { frame.group(group); }
```

## Growing a plant

`gfx.plant(&spec)` grows the plant on the CPU in `on_reset` and answers a model you draw with
`frame.model`, an `InstanceGroup` or a terrain scatter. The model comes with:

- **Branches:** a parametric L-system after Weber and Penn, with spiral, whorled or flat
  sprays, a crown shape, curvature, droop and taper. The stems are smooth tubes with a root
  flare, buttress lobes and a collar where each branch leaves its parent.
- **Bark PBR:** tileable albedo, normal map and ORM per species. Birch has white bark with
  lenticels and black patches. Oak and willow have furrows. Pine has orange plates and spruce
  has scales. Dead bark is bleached and cracked.
- **Cards:** a 2 × 2 atlas of twigs with leaves, bare winter twigs (birch catkins), conifer
  sprays, palm fronds or grass blades, each with a normal map. Cards are cut out at
  `FOLIAGE_CUTOFF`, two-sided, and let the sun through as `Subsurface::LEAF`.
- **Levels:** three mesh levels and a hemi-octahedral impostor past the last one. Coarser levels
  drop the finest stems, thin the rings and keep fewer, larger cards. The renderer crossfades
  between levels. A grass clump has no impostor: thin it with `Far::thin` instead.
- **Wind:** the species' response (`Species::wind`).

| Species | Look | Wind |
| --- | --- | --- |
| `Birch` | slender white trunk, light crown of hanging twigs | `tree` |
| `Spruce` | dark cone of whorled, drooping branches | `tree` |
| `Pine` | tall bare orange trunk, umbrella of upturned branches | `tree` |
| `Oak` | thick flared gnarled trunk, broad round crown | `tree` |
| `Maple` | dense round crown of palmate leaves | `tree` |
| `Willow` | leaning furrowed trunk, long hanging strands | `tree` |
| `Palm` | ringed curved stem, crown of fronds | `tree` |
| `Shrub` | many stems from the ground | `shrub` |
| `Grass` | a clump of blades (ground cover) | `grass` |

Each species grows in four seasons:

- `Season::Leafy`: summer.
- `Season::Autumn`: yellow birch, red maple, russet oak.
- `Season::Winter`: broadleaves stand bare, conifers and palms keep their needles, and grass
  turns to straw.
- `Season::Dead`: lost and broken branches and a few dry leaves.

A spec's options:

- `.seed(n)`: another plant of the same species. Use 2 to 4 seeds per stand, never one model
  repeated.
- `.height(metres)`: the plant's height, held to 0.1..=120. Without it the seed picks one from
  the species' range.
- `.texture_size(px)`: the maps' side (128..=2048, power of two, 1024 by default).

Every plant of one species and season shares its maps, so seed variants cost no texture memory.
A spec grows once a process and is kept across seeds. The same spec grows the same bytes on every
destination. Full detail stays under 60,000 triangles. The sim never sees a plant's look; give it
a collider from `gfx.assets().triangles(&model)` or a capsule.

`plant_glb(&spec)` answers the same GLBs: level 0 with its maps, and the coarser levels with the
distances for `Model::with_levels`. Write them under `assets/` when a tool or another engine needs
the files; Studio's import then compresses their maps.

## Wind on any model

`model.with_wind(response)` bends the model in the shared wind (the field the terrain's grass
sways in), in three layers:

- **Trunk:** leans down each gust by the square of a vertex's height over the model's.
- **Branches:** bob by the square of a vertex's reach from the trunk, out of phase across the
  crown.
- **Leaves:** flutter in each leaf's own phase.

The weights come from each vertex's position and the model's own extent, so a GLB needs no
painted vertex colours. Every level sways, every copy of an instance group sways in its own
phase, and a compound sways as one plant (keep a CC0 tree's wood and leaves together with
`gfx.assets().compound(..)`). The impostor stands still: at its distance the sway is under a
pixel. `.with_strength(s)` scales every layer (0 still, up to `WIND_STRENGTH_MAX` for a storm).
The sway is display-only and never reaches the sim or its checksum. Its motion vectors come
along, so TAA does not smear it.

A part of a swaying model is foliage when its own GLB material is alpha-tested, blended or
double-sided. Foliage is drawn cut out, two-sided and lit through as `Subsurface::LEAF` (keeping
the transmission a GLB's `KHR_materials_diffuse_transmission` names), and it flutters. Every
other part bends without fluttering. A material you give the draw (`frame.model_with`) keeps its
own alpha and faces.

## Building a stand

Plan the stand as a shot:

- One or two hero trees near the camera, drawn with `frame.model`.
- Two to four seeds of each species in retained groups placed by `terrain.scatter`.
- Shrubs and grass clumps under them, thinned with `Far::thin`.
- A far stand on the hills, which turns into impostors.
- A winter grove takes `Season::Winter` under `SkyParams::overcast()`.

`docs/examples/forest/` is working code for a winter birch grove and a summer forest.
