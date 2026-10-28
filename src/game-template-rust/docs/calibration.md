# Calibration

The numbers behind `docs/look-recipes.md`: what a light's intensity means, what exposure does by
default, what a capture's brightness should be, how many texels a surface needs and what each
device draws at. Per-class budgets are `docs/api/performance.md`.

## Light units

The engine's lights are in relative scene units, not lux or lumens: there is no aperture, shutter
or ISO. Auto exposure brings the metered scene to a key of 0.18 (middle grey), so what matters is
each light's ratio to the others. The recipes are captured with these values; the desk lamp and the
candle are starting points to tune against a capture.

| Light | Call | Value |
| --- | --- | --- |
| Sun (default) | `frame.sun(towards, Color::WHITE, 2.5)` | 2.5; 3.0 for a low sun through windows; 2.8 for a desert noon |
| Ambient (default, where no sky or HDRI draws) | `frame.ambient(color, 0.08)` | 0.08; 0.15 for a day room, 0.01 to 0.02 at night |
| Physical sky | `SkyParams::default().with_intensity(1.0)` | 1.0 (0 to 64); 0.6 for rain |
| Moonlight | `Moon::new([x, y, z]).with_moonlight(0.004)` | 0.004 of the sun's light |
| Fluorescent tube | `Material::emissive(color, 6.0)` plus `frame.point_light(at, 6.0, color, 2.2)` | glow 6, light 2.2, range 6 m |
| Street lamp | `Material::emissive(color, 8.0)` plus `frame.spot_light(at, down, 12.0, color, 4.0)` | glow 8, light 4, range 12 m |
| Desk or bedside lamp | `frame.point_light(at, 4.0, warm, 1.0)` | light 1, range 4 m |
| Candle, screen | `frame.point_light(at, 2.0, warm, 0.3)` | light 0.3, range 2 m |
| Reflection probe, irradiance volume | `.with_intensity(1.0)` | 1.0; never above 1 to brighten a room |

Emission lights only the picture, never another surface: pair every glowing thing with a light.
A spot's cone defaults to 20 and 30 degrees (inner and outer).

## Exposure defaults

| Key or field | Default | Range | Note |
| --- | --- | --- | --- |
| `exposure` | `manual` | `manual`, `auto` | use `auto` wherever light meets shade |
| `metering` | `average` | `average`, `center`, `spot`, `ground` | `ground` for open sky over ground |
| `ev_compensation` | 0 | -10 to 10 | +0.3 to +0.5 sunlit, +1.0 snow, -0.7 rain, -0.5 to -1.0 night |
| `ev_min`, `ev_max` | -8, 8 | -16 to 16 | keep the defaults |
| `adaptation_speed_up`, `adaptation_speed_down` | 4, 3 EV per simulated second | above 0 to 20 | |
| transition | 0.5 EV | | smoothed near the target |
| `doorway_adaptation` (a `Look` field, code only) | on | | 8 times faster for half a second when the camera crosses a probe or volume box |
| `local_exposure_highlights`, `local_exposure_shadows` | 0.6, 0.8 | 0.25 to 1 (1 is off) | drawn on `high` and `ultra` |
| `bloom_intensity` | 0.04 | 0 to 1 | 0.06 for a night street |
| `fog_density` | 0 (off) | 0 to 1 | 0.002 open air to 0.02 rain |
| `fog_height_falloff` | 0.2 | 0 to 10 | 0.05 to 0.1 in the recipes |

`exposure_curve` (code only, at most 8 points of metered EV and EV added) keeps a night dark
under auto exposure. `Exposure::auto().compensation(..).metering(..).range(..)` in code is the
same as the keys.

## Luma bands

The mean Rec. 709 luma (0 to 255) of a settled 1280x720 `ultra` capture of the main camera, lens
off, that each recipe is captured inside (`docs/examples/looks/`).

| Scene | Band | The `looks` stage at `ultra` (`low`) |
| --- | --- | --- |
| Interior day | 90 to 130 | 124 (126) |
| Interior night | 45 to 85 | 72 (58) |
| Exterior day | 95 to 140 | 135 (140) |
| Forest | 95 to 140 | 136 (141) |
| Overcast and snow | 125 to 175 | 155 (169) |
| Rain | 70 to 110 | 103 (100) |
| Night street | 25 to 65 | 37 (23) |
| Desert and sunny | 115 to 160 | 122 (127) |

A playable camera darker than its band needs more light (a lamp, a window, a volume), not a grade.

## Texel density

A surface needs about as many texels per metre as the screen gives it pixels per metre where the
camera gets closest. Pixels per metre at distance `d` metres is
`height_px / (2 * d * tan(fovy / 2))`: at 1440 rows and `fovy` 62, about 1200 at 1 m, 400 at 3 m
and 120 at 10 m.

| Map | Covers | Texels per metre | Good for |
| --- | --- | --- | --- |
| 1k | 2 m | 512 | surfaces seen from 3 m or farther |
| 2k | 2 m | 1024 | walls, floors and props seen from 1 to 3 m |
| 2k | 4 m | 512 | large surfaces seen from 3 m or farther |
| 4k | 2 m | 2048 | a hero surface the camera touches |

Aim for at least 512 texels per metre on every surface within 3 m and 1024 on hero props. The
engine keeps textures up to 2048 a side today; a larger source is reduced to 2048 on import.

## Resolution and frame rate

| Device class | Starts on | Frame rate | Render scale |
| --- | --- | --- | --- |
| `desktop-ultra` | `ultra` | 60 | 1.0 |
| `desktop-high` | `high` | 60 | 1.0 |
| `desktop-mid` | `medium` | 60 | 1.0 |
| `desktop-low` | `low` | 60 | 0.85 |
| `mobile-high`, `mobile-ultra` | `medium` | 60 | 0.75 |
| `mobile-mid` | `low` | 60, 30 sustained | 0.67 |
| `mobile-low` | `low` | 30 | 0.6 |

The budgets are sized for a reference picture: a desktop monitor at 2560x1440, a laptop panel or a
browser window at 1920x1080, a phone at about 800x1750. On a native desktop at `high` and `ultra` (temporal upscaling on), Live draws at the window's own
pixels up to four times the reference's; elsewhere it draws at the reference size and the window
upscales. A frame rate is 30 or 60. A capture is at most 4096 pixels a side.
