---
name: Comfort
description: Keep first-person camera motion within comfort caps — field of view, bob, roll, cadence, shake and kicks, reduced motion — and measure it over time, because a still frame cannot show it.
facts: web-game
---

# Comfort

A camera that bobs, rolls or shakes too much makes people ill, and no still capture shows it: a
judge sees one frame of a sprint and calls it fine. Treat motion as a measured mechanic.

## Caps

| Motion | Cap |
| --- | --- |
| Vertical field of view (first person) | 55 to 80 degrees; 70 for a shooter, 72 for a bodycam |
| Bob, peak to peak, at a sprint | 3 cm (1.5 cm at a walk) |
| Roll at a sprint | 1.5 degrees; 2 degrees in all, any cause |
| Bob cadence | under 3 Hz at a sprint; no energy above 6 Hz |
| Shake | eased from world state; never a fresh random value per tick |
| Sprint field-of-view kick | at most 5 degrees, eased over a quarter second |
| Reduced motion on | a tenth of every amplitude above |

Lens effects stay off where the person steers: no depth of field or motion blur in play, and a
stylised lens (fisheye, grain, vignette) has a setting that turns it off.

## Building it

- The bob comes from a gait phase the world keeps, advanced by speed over a stride that grows with
  speed (about 0.8 m at a walk, 1.75 m at a sprint), with smooth curves: a sway of `sin(phase)`,
  a lift of `(1 - cos(2 * phase)) / 2`, never an `abs(..)` whose cusp jerks. In a Rust game folder
  `docs/examples/fps.md` (The camera) has the rules; its FPS example's own `bob()` is older than
  these caps and is not to be copied.
- A brief, a milestone or a critic idea asking for "heavier shake", "more bob" or a wider lens
  is answered within the caps: more weight is a longer ease, a footstep sound and a small dip on
  landing, not amplitude.

## Measuring it

Give the game a demo that sprints along a straight path for a few seconds and a probe of the
camera's pose each tick (its height above the feet, its roll, its field of view). From the series:
the bob's peak to peak, the roll's largest value, the dominant bob frequency and the energy above
6 Hz. A round that moves any of them past its cap is a regression, whatever it adds.
