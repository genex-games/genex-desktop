# Water

Lakes, ponds and rivers are `Water`; there is no open ocean in the facade yet.

Every type and call in one line:

```rust
use genex::render::Water;                                      // and WATER_ABSORPTION_MAX, WATER_REFRACTION_MAX
Water::lake(centre, half_extent);                              // Vec3, Vec2 -> Water
water.with_absorption([r, g, b]).with_scatter([r, g, b]).with_foam(width); // -> Water, like every with_*
water.with_ripple(strength, roughness).with_refraction(offset);
frame.water(&water);                                           // one a frame: a second call replaces it
Water::drawn_at(setup.quality());                              // -> bool; setup: a level-3 pass's genex::gpu::PassSetup (or PassFrame)
```

A lake, a pond or a flooded quarry: `frame.water(&Water::lake(centre, half_extent))`
(`use genex::render::Water;`), one logical draw, a flat rectangle at the level `centre.y`, `half_extent`
metres either side along x and z. Make it larger than the water: the ground above the level hides
it, so the shoreline is wherever your terrain meets the level and needs no outline. The renderer
draws it after the opaque scene on presets with TAA (desktop and web `high` and `ultra`): the bed
shows through by its depth (Beer-Lambert absorption), foam laps the shallows, and it refracts what
is behind it and reflects the screen. An MSAA preset (`low`, `medium`, the phones' defaults) draws
no water yet: where `Water::drawn_at(setup.quality())` (a level-3 pass's quality) is false, draw
your own in that pass.
The look's height fog covers it as it covers the ground. Where the screen has no reflection it
reflects the reflection probes over it and the sky, so give a lake a `frame.reflection_probe(..)`
over it and its shores to see the woods in it, captured from open water: what stands near the
capture point (a dock, a fisher's rod) is magnified across the reflection. Its ripples and foam run
on the simulation's clock,
so a capture of a tick is the same every time.

```rust
// on_draw:
frame.water(
    &Water::lake(vec3(6.0, 0.0, 2.0), vec2(28.0, 20.0))
        .with_absorption([0.6, 0.45, 1.1])
        .with_scatter([0.012, 0.014, 0.006])
        .with_foam(0.025)
        .with_ripple(0.035, 0.07)
        .with_refraction(0.02),
);
```

`.with_absorption(per_metre)` (linear rgb, red first for clear fresh water, blue first for a
peaty forest lake like the one above; at most `WATER_ABSORPTION_MAX`), `.with_scatter(albedo)`
(the body's colour, linear, 0..1, lit by the scene's sky and sun, so it darkens at night),
`.with_foam(width)` (metres of water under the surface the foam reaches; 0: none),
`.with_ripple(strength, roughness)` and `.with_refraction(offset)` (a fraction of the screen, at
most `WATER_REFRACTION_MAX`) change the default clear lake; a value out of range is held to its
range. A frame draws one water (a second call replaces the first); a rectangle whose centre is not
finite or whose half extent is not a positive size is ignored. A transparent draw or a pass's
sprite over the water is drawn over it.
