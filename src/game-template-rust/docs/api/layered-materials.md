# Layered materials and weather

Snow on a bench, moss on a stone, a wet street, dust on a ledge, mortar between bricks, a car's
clear coat, velvet, brushed steel, window glass, and the weather that falls and lays it: built
into `Material` and `Frame`, drawn by every destination at the cost its preset allows.

Every type and call in one line:

```rust
use genex::prelude::*;                                         // Material, Cover, Layer, Weather
use genex::{LayerMask, WeatherKind};
Cover::snow(amount, slope, noise);                             // ::dust, ::moss, ::wet, ::none(); amount 0..1, slope degrees, noise 0..1
cover.with_color(color).with_roughness(r).with_amount(a);      // -> Cover
material.with_cover(cover);                                    // its own cover (wins over the world's)
frame.cover_world(cover);                                      // every draw without its own, GLBs included
frame.model_with_cover(&model, transform, cover);              // a GLB's own materials, covered
material.with_detail(albedo_path, normal_path, tiles);         // "" leaves one out; .with_detail_strength(albedo, normal, fade_metres)
material.with_layer(Layer::textured(base, normal, orm, tiles).with_height(path).masked_by(LayerMask::Up, metres));
Layer::color(color).with_tint(c).with_roughness(r).with_blend_depth(d);   // LayerMask::Noise or ::Up
material.with_parallax(height_path, depth);                    // depth in tiles, 0.02..0.08
material.with_clearcoat(strength, roughness).with_sheen(color, roughness).with_anisotropy(strength, radians);
material.with_transmission(share);                             // glass: draws blended
Weather::heavy_snow();                                         // ::light_snow, ::blizzard, ::rain, ::drizzle, ::dust
frame.weather(&weather, seconds);                              // both layers, and the cover laid by `seconds`
weather.cover_after(seconds);                                  // -> Option<Cover>
```

## Cover: snow, dust, moss and water by material

A cover lies where a surface faces up: its `amount` (0..1) is the share of what may hold it that
is covered (0 none, 1 all), its `slope` the steepest face, in degrees from flat, that still holds
it (90 is a wall, 180 every face), its `noise` (0..1) how much a world-space noise breaks that
share into patches (0 lays a partial amount evenly, thinner). The
surface's own normal map counts, so snow sits on the up-facing bumps of a brick and fills its
joints. Where it lies it replaces the base colour, roughness and metallic and flattens the normal
map: a bench's slats, a shed's roof, a rock's top and a car's bonnet whiten, while walls and the
faces of posts keep their own scans. **Never lay white boxes on props for snow**: a slab reads as
a block, and a cover follows every curve and texture under it.

```rust
let stone = Material::color(Color::rgb(108, 104, 98)).with_roughness(0.9);
frame.sphere_with(rock, 0.6, &stone.clone().with_cover(Cover::moss(0.7, 75.0, 0.6)));
frame.cover_world(Cover::snow(1.0, 50.0, 0.3));                // everything else in this frame
frame.cube_with(pane, &glass.with_cover(Cover::none()));        // the window stays clear
```

| Preset | Snow | Dust | Moss | Wet |
|-|-|-|-|-|
| colour (linear) | 0.80, 0.83, 0.88 | 0.36, 0.31, 0.25 | 0.07, 0.14, 0.03 | the surface's, darkened 45% |
| roughness | 0.62 | 0.95 | 0.9 | 0.1 |
| slope edge (fades over) | 12° | 20° | 25° | 30° |
| noise patch | 0.6 m | 0.35 m | 0.25 m | 1.5 m |
| flattens the normal map | 85% | 30% | 40% | 55% |

`frame.cover_world` covers every cube, sphere, model (a GLB's own materials too), group and instance
whose material carries no cover; a material's own `with_cover` wins and `Cover::none()` keeps one
bare. The first-person view model and posed characters are never covered. The terrain keeps its own
layers: give the ground a snow layer (Terrain, below). A cover is a pure function of the surface,
the same every frame; the cover's noise is drawn from `medium` up (`low` and the low phones lay a
partial amount evenly instead of in patches).

## Weather

`Weather::heavy_snow()` (and `light_snow`, `blizzard`, `rain`, `drizzle`, `dust`) is two particle
layers that follow the camera: a near box of a few metres at a high density, so flakes pass the
lens, and a far box of tens of metres at a low one, so the weather fills the view to the haze.
Every particle wraps into its box around the camera, so the density holds wherever the camera goes
and the game never moves an emitter. They are lit by the sun through its cascaded shadows and by
the sky (a flake under a roof is as dark as the shade), vary in size, flutter, ride a wind and its
gusts, and settle where they land. Draw it every frame with `frame.weather(&weather, seconds)`,
`seconds` since it began: it also lays the weather's cover on the world (`frame.cover_world`), from
none to whole over the preset's time. Make it once (in `on_reset`) and keep it in the world.

| Preset | Near (per m³, box) | Far (per m³, box) | Fall | Wind, gusts | Size | Cover, whole after |
|-|-|-|-|-|-|-|
| `light_snow` | 10, 8×6×8 m | 0.19, 48×20×48 m | 0.8 m/s | 0.3 m/s, +0.6 | 2-3 cm ±55% | snow, 20 min |
| `heavy_snow` | 31, 8×6×8 m | 0.34, 48×20×48 m | 1.1 m/s | 1 m/s, +1.5 | 2.6-3.6 cm ±55% | snow, 6 min |
| `blizzard` | 41, 8×6×8 m | 0.62, 40×16×40 m | 1.6 m/s | 9 m/s, +6 | 2-2.8 cm ±55% | snow, 3 min |
| `rain` | 12, 10×8×10 m | 0.38, 40×20×40 m | 9 m/s | 0.5 m/s, +1.5 | streaks | wet, 2 min |
| `drizzle` | 31, 8×6×8 m | 0.35, 32×16×32 m | 3.5 m/s | 0.4 m/s, +0.8 | fine streaks | wet, 6 min |
| `dust` | 4.8, 10×6×10 m | 0.10 haze puffs, 48×12×48 m | drifting | 4 m/s, +3 | 6 mm ±60% | dust, 30 min |

Pair snow and rain with `Environment::Sky(SkyParams::overcast())` and a thin fog (`docs/api/lighting.md`),
a blizzard with a thick one. Each layer holds at most 16 000 particles; a phone draws every n-th one
under its cap (32 768 a frame, 8 192 on the low phones). For an emitter of your own, the same
behaviour is `Particles::..with_lit(1.0).with_size_variance(0.5).with_gusts(peak, period)
.with_flutter(reach, period).following_camera(true)` (`docs/api/particles.md`).

## Detail maps and a second layer

`.with_detail(albedo, normal, tiles)` adds a finer albedo and normal map repeating `tiles` times per
tile of the material's own maps: an sRGB overlay around mid-grey (128 changes nothing, darker
darkens, lighter lightens) and a normal map added to the material's own, faded out by 15 m
(`.with_detail_strength(albedo, normal, fade_metres)`). Use it for grain the base scan cannot hold
up close: plaster pores, wood fibre, asphalt grit.

`.with_layer(layer)` blends a second set of maps over the material's own by a mask,
`LayerMask::Noise` (patches of `metres`) or `LayerMask::Up` (what faces up), through both layers'
heights: with `.with_parallax(height, ..)` on the material and `.with_height(path)` on the layer, the
layer fills the low parts first (mortar in a wall's joints, moss in a stone's hollows).
`.with_blend_depth(d)` sets how soft the line is (0.01 crisp along the heights, 1 a wide fade).

## Parallax, clear coat, sheen, anisotropy and glass

`.with_parallax(height, depth)` gives the material a height map (red, white high) and parallax
occlusion mapping `depth` tiles deep (0.02..0.08 for bricks and cobbles, at most 0.25): joints and
gaps stay deep at a grazing view. `.with_clearcoat(strength, roughness)` lays a smooth second
specular coat over the surface (car paint, varnish), `.with_sheen(color, roughness)` the rim of
velvet and cloth, `.with_anisotropy(strength, radians)` stretches highlights along the mesh's
tangent (brushed metal, hair), and `.with_transmission(share)` lets that share of the background
through a thin pane (window glass at 0.95, roughness 0.05): it draws blended and keeps its
highlights; the background is not tinted or refracted. A GLB's `KHR_materials_clearcoat`, `_sheen`,
`_anisotropy` and `_transmission` factors draw the same way by themselves.

## What each preset draws

| Part | `low`, low phones | `medium`, phones, the web at `medium` | desktop `high`, `ultra` |
|-|-|-|-|
| Cover | by slope, even (no patches) | in patches by its noise | in patches by its noise |
| Detail, second layer, lobes | off (plain maps) | on | on |
| Parallax | off (flat maps) | off (flat maps) | on, up to 32 steps by view angle, no finer than a pixel |
| Weather | both layers, lit | both layers, lit | both layers, lit |

Measured on the owner's Apple Silicon Mac at 2560×1440 `high`: see the numbers in
`docs/api/layered-materials.md`'s tests (`layered_materials`, `weather`), held to a budget of
0.25 ms for a screen of covered floor, 1.5 ms for every layered part at once on a screen of floor,
and 0.6 ms for `heavy_snow`'s 27 840 flakes.
