# Terrain

Ground that spans the world (hills, a valley, a beach) is a heightmap terrain: made once, drawn
every frame with `frame.terrain(&terrain)`, one logical draw. The renderer draws it finer near
the camera and coarser far away (continuous levels of detail that morph, so the ground never
pops or cracks), casts it into the sun's shadows, and shades it per pixel from up to
`TERRAIN_LAYER_MAX` (16) material layers.

The terrain types are at the crate root, not in the prelude. Every type and call in one line:

```rust
use genex::{Grass, Scatter, Terrain, TerrainError, TerrainLayer, TerrainTexel}; // and TERRAIN_SAMPLES_MAX, TERRAIN_LAYER_MAX
Terrain::from_fn([385, 385], origin, spacing, |x, z| height);  // -> Result<Terrain, TerrainError>; samples: [u32; 2], origin: Vec2
Terrain::from_heights(samples, origin, spacing, &heights);     // row-major, x fastest
terrain.with_layers(vec![TerrainLayer::textured(albedo, data, tile), TerrainLayer::flat(color)]); // -> Result<Terrain, TerrainError>
TerrainLayer::textured(albedo, data, tile).with_tint(rgb).with_fallback(color).with_grass(grass); // rgb: Vec3
Grass::meadow(density, height).with_height(lo, hi).with_width(lo, hi).with_colors(root, tip);
grass.with_dry(color, share).with_flowers(color, share).with_transmission(amount);
terrain.with_control(&texels);                                 // TerrainTexel::layer(i), TerrainTexel::blend(base, overlay, amount), .with_wetness(w)
terrain.height(x, z);                                          // -> f32
terrain.scatter(&Scatter::new(density, &[0, 1]).with_scale(lo, hi).with_seed(2), min, max); // -> Vec<Transform>
// Scatter's other builders: .on_flat_ground(least_normal_y), .following_ground(share), .with_cap(most)
frame.terrain(&terrain);                                       // one a frame
```

```rust
// on_reset: heights every 0.5 m over 192 m, two layers, a control texel per height sample.
let terrain = Terrain::from_fn([385, 385], vec2(-96.0, -96.0), 0.5, |x, z| hills(x, z))
    .expect("heights")
    .with_layers(vec![
        TerrainLayer::textured("ground/grass-layer.png", "ground/grass-data.png", 2.0).with_fallback(Color::rgb(54, 79, 34)),
        TerrainLayer::flat(Color::rgb(138, 134, 126)),
    ])
    .expect("layers");
let texels: Vec<TerrainTexel> = samples.iter().map(|s| TerrainTexel::blend(0, 1, s.rockiness)).collect();
sim.world.ground = Some(terrain.with_control(&texels).expect("a control texel per sample"));
// on_draw:
if let Some(ground) = &sim.world.ground { frame.terrain(ground); }
```

`Terrain::from_fn(samples, origin, spacing, |x, z| height)` or `Terrain::from_heights(samples,
origin, spacing, &heights)` (row-major, x fastest) make one: at most `TERRAIN_SAMPLES_MAX` (2049)
samples a side. A layer is `TerrainLayer::textured(albedo, data, tile)` (two files under
`assets/`: the base colour with the layer's height in alpha, and a data texture with the normal's
x and y in red and green, roughness in blue and occlusion in alpha, one tile every `tile` metres,
`.with_tint(..)`, `.with_fallback(..)` for the colour it draws without its texture) or
`TerrainLayer::flat(color)`. Make the two files from a CC0 scan with the `cc0__terrain-layer` tool
(`cc0__fetch` a texture, then `cc0__terrain-layer` with its folder and a name): it answers the
`TerrainLayer::textured(..)` line to paste and the `[[texture]]` rows; never pack them by hand. `terrain.with_layers(..)` sets them; without a control map every
sample is layer 0. `TerrainTexel::layer(i)`, `TerrainTexel::blend(base, overlay, amount)` and
`.with_wetness(..)` make one control texel per height sample for `terrain.with_control(..)`; the
renderer blends the texels around each pixel by weight and by each layer's height, and hex-tiles
the layers on desktop `high` and `ultra` so no tile repeats visibly. `terrain.height(x, z)`
answers the ground's height anywhere (the same bits on every destination): place things and
build colliders with it. Refusals change nothing: `terrain-heights-invalid` (a side outside
2..=2049, a spacing that is not positive, a height that is not a number),
`terrain-layers-invalid` (no layer, more than 16, a tile that is not positive) and
`terrain-control-invalid` (a control map of another size, a texel naming a missing layer). A
frame draws one terrain.

A layer can grow grass: `TerrainLayer::textured(..).with_grass(Grass::meadow(36.0, 0.5))` (blades a
square metre up to `GRASS_DENSITY_MAX` (150), the tallest blade in metres up to `GRASS_HEIGHT_MAX`
(2)), with `.with_height(shortest, tallest)`, `.with_width(narrowest, widest)`,
`.with_colors(root, tip)`, `.with_dry(color, share)`, `.with_flowers(color, share)` and
`.with_transmission(..)` (how much of the sun behind a blade shines through it). Wherever the
control map paints that layer, the renderer grows blades around the camera on the GPU (nothing is
uploaded per blade; a blade belongs to its place, so the field never swims), thinner and wider far
away and gone past a reach that grows with the preset, swaying in the shared wind (simulated time,
with its own motion so TAA keeps it sharp), shadowed by the sun and lit through from behind.
Desktop and web `medium`, `high` and `ultra` draw it (`high` and `ultra` also cast its shadows);
the high phones draw a third of it from `high`; `low` and the low phones draw the ground alone, so
paint the grassy layer's own colour close to the grass's. Grass out of range (a density or height
past its cap, a share outside 0..1, a number that is not one) is refused `terrain-layers-invalid`.

Bushes, rocks and flowers are placed on a terrain once, at a loading point, and drawn as an
instance group: `terrain.scatter(&Scatter::new(0.4, &[0, 1]).with_scale(0.7, 1.3).with_seed(2),
vec2(-60.0, -60.0), vec2(60.0, 60.0))` returns the transforms standing on the ground wherever
layers 0 and 1 cover it (instances a square metre, up to 16), with `.on_flat_ground(0.9)` (only
where the ground's normal has at least that much y), `.following_ground(share)` (lean with the
slope), `.with_cap(most)` (past it they thin evenly; give phones a smaller cap). An instance belongs
to its place, so the same rule gives the same instances for any area that covers them: scatter
chunks as the player moves and they meet exactly. A rule out of range or an empty area places
nothing.
