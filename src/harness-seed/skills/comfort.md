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
| Vertical field of view (first person) | 60 to 80 degrees; 70 for a shooter, 72 for a bodycam |
| Bob, peak to peak, at a sprint | 2.8 cm |
| Roll | 1.2 degrees at a walk; 2 degrees in all, any cause |
| Step cadence | 2.8 Hz at most at a sprint |
| Shake and noise | eased from world state, nothing above 8 Hz; never a fresh random value per tick |
| Sprint field-of-view kick | at most 4 degrees, eased in and out |
| Reduced motion on | a tenth of every amplitude above |

Lens effects stay off where the person steers: no depth of field or motion blur in play, and a
stylised lens (fisheye, grain, vignette) has a setting that turns it off.

## Building it

- In a Rust game folder a first-person view is the engine's camera rig (`docs/examples/fps.md`,
  The camera), whose caps hold whatever a brief asks: never write a head bob, roll or shake of your
  own. Elsewhere, derive the bob from a gait phase the world keeps, over a stride that grows with
  speed, with smooth curves: never an `abs(..)` whose cusp jerks.
- A brief, a milestone or a critic idea asking for "heavier shake", "more bob" or a wider lens
  is answered within the caps: more weight is a longer ease, a footstep sound and a small dip on
  landing, not amplitude.

## Measuring it

Give the game a demo named `sprint-run` that sprints along a straight path for a few seconds and
returns the camera's pose each tick (its height above the feet, its roll, its field of view). From the series:
the bob's peak to peak, the roll's largest value, the step cadence and the energy above 8 Hz. A
Rust game's rig reports these itself under `state().volatile.camera` once its probe is
registered. A round that moves any of them past its cap is a regression, whatever it adds.
