# Content Library

Genex ships its own library of pre-processed CC0 content (Studio's `library` plugin): about 67 PBR
materials, 13 HDRI skies, 39 props, rocks and debris, and tree slots. Each entry is ready to draw:
textures GPU-encoded, models decimated to a triangle budget with their levels baked in, real-world
sizes recorded. There is no import work. Search it first for any common surface, sky or prop,
before `cc0__search`, Blender or a generator. Every type and call, in one line each:

```rust
use genex::{LibraryAsset, LibraryKind};          // Assets is in the prelude
gfx.assets().library(id);                         // -> Result<LibraryAsset, AssetError>, in on_reset
asset.material(); asset.model(); asset.environment(); // -> Material, Model, Environment
asset.id(); asset.kind(); asset.name(); asset.tags(); asset.licence(); // -> &str, LibraryKind, &str, &[String], &str
asset.size(); asset.tile_metres(); asset.tier(); asset.triangles(); // -> Vec3, f32, Option<&str>, Option<u32>
genex::library_folder(id);                        // -> String, the entry's folder under assets/library/
```

## Finding and adding an entry

1. `library__search {query: "wet asphalt"}` answers ids such as `material/asphalt_01`. Any word of
   the query matches. `kind` narrows the search to `material`, `sky`, `model` or `vegetation`.
   Each result gives:
   - `status`: `ready`, `slot-open` or `not-built`;
   - `tiers`: what the entry carries;
   - `sizeMetres` (x, y height, z), or for a material `tileMetres` (the metres one texture repeat covers);
   - `triangles` (LOD0);
   - for a sky, `time` and `weather`.
2. `library__add {id: "material/asphalt_01"}` installs the entry, checks every file against its
   sha256 pin, and delivers it to `assets/library/<folder>/`. The answer's `use` line shows the call.
   `tier` takes `1k`, `2k` or `4k` for a material or sky (default `2k`). Ask for `4k` only for a
   surface that fills the screen on desktop. Adding another tier later lands beside the first.
3. Read the entry in `on_reset` and keep what it gives in the world:

```rust
game.on_reset(|sim, _seed, _rng, gfx| {
    let assets = gfx.assets();
    sim.world.road = assets.library("material/asphalt_01").map(|asset| asset.material()).unwrap_or_default();
    sim.world.bench = assets.library("model/painted_wooden_bench").map(|asset| asset.model()).unwrap_or_default();
    sim.world.sky = assets.library("sky/kloofendal_48d_partly_cloudy_puresky").map(|asset| asset.environment()).ok();
});
game.on_draw(|sim, frame, _camera| {
    frame.environment(sim.world.sky.clone().unwrap_or_else(Environment::sky));
    frame.cube_with(Transform::from_translation(vec3(0.0, -0.1, 0.0)).with_scale(vec3(40.0, 0.2, 40.0)), &sim.world.road);
    frame.model(&sim.world.bench, Transform::from_translation(vec3(0.0, 0.0, 3.0)));
});
```

`docs/examples/library-yard/` is a whole yard dressed this way.

## What each kind gives

| Kind | Call | What it is |
|-|-|-|
| `material` | `.material()` | Albedo, normal and packed ORM maps from the largest tier the game shipped. Metallic and roughness are 1, so the ORM map's values are used as they are. The textures repeat in world space at the scan's real size (`with_world_uv(tile_metres)`). Where no texture loads, the material draws the scan's mean colour. Chain more as usual: `.with_stochastic_tiling(true)`, `.with_macro_variation(..)`, or `.with_uv_scale(u, v)` for a model's own UVs. |
| `sky` | `.environment()` | `Environment::hdri(path)` of the largest HDRI the game shipped. To tune it, build `Environment::Hdri(HdriEnvironment::new(path).with_intensity(..))` yourself (`docs/api/lighting.md`). |
| `model` | `.model()` | One GLB in metres at real size, within its budget, with its levels baked in. Rocks, vehicles and structures also get an `Impostor::hemi()` past their last level. Draw it with `frame.model` or `frame.model_with`. |
| `vegetation` | `.model()` | A generated tree's members (`trunk.glb`, and `foliage.glb` when it has one) drawn as one `compound`, with an impostor past their last level. |

A call for another kind's handle answers that handle's default: a material answers no model (the
checker), and a model answers `Material::default()` and the physical sky.

Model budgets (LOD0 triangles; the runtime's levels go down from there):

| Budget | Triangles | Impostor | Typical entries |
|-|-|-|-|
| `small-prop` | 5,000 | no | bench, barrel, chair, sign, tyre |
| `prop` | 20,000 | no | crate, bin, hydrant, desk, road barrier |
| `large-prop` | 50,000 | no | street lamp, street seating |
| `rock` | 24,000 | yes | boulders, moss rocks, stumps, logs |
| `structure` | 80,000 | yes | chain-link fence |
| `vehicle` | 80,000 | yes | covered car |
| `tree` | 60,000 | yes | the vegetation slots |

## Refusals

`library` reads `assets/library/<folder>/entry.json` the way `gfx.assets().bytes` reads a file
(`docs/api/assets.md`), so the same rules apply:

| Code | When |
|-|-|
| `unsafe-path` | The id is not `<kind>/<slug>`: a known kind, then a slug of `a-z`, `0-9` and `_`, at most 48 long. Nothing is read. |
| `missing` | This game has not added the entry. The detail names the `library__add` call to make. |
| `malformed` | The `entry.json` is not JSON, has another schema, or names another entry. |
| `not-at-reset` | Read outside `on_reset`. |
| `not-preloaded` | The entry's folder ships in a streamed or named asset group. |

The plugin's own refusals start `library <code>:`:
- `unknown-entry`: search again.
- `slot-open`: a tree the generator has not filled yet. Use another entry.
- `not-built`: in the catalog but not in the pack yet. Use another entry, or `cc0__search`.
- `tier-unavailable`: the tier asked for is not in the pack.
- `unpublished`: the pack is not available on this machine.
- `digest-mismatch`, `size-mismatch`, `download-failed`: nothing was delivered. Try again later.
- `no-game`: no game is open.

## Files and licence

An entry's folder holds:
- `entry.json`: its facts, which the runtime reads;
- `preview.jpg`: a swatch or render to look at;
- a material's `<map>.<tier>.jpg`: the fallback image the material names;
- `<map>.<tier>.ktx2`: Basis UASTC, which Studio transcodes into each device's compressed format with no encoding;
- a sky's `sky.<tier>.hdr`;
- a model's `model.glb`.

Never edit or rename these files. Add another tier or entry instead.

Every entry is CC0-1.0 from Poly Haven, or made by a Genex generator. No credit is required.
The plugin records each delivery's source and authors.

## Vegetation slots

`vegetation/*` entries are slots that Genex's tree generator fills: birch (winter and summer),
spruce, pine, oak (summer and bare), a leafy bush and a grass tuft. An open slot answers
`slot-open`. Each filled slot is drawn like any model entry.
