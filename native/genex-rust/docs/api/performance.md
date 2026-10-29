# Performance and budgets

What each device class and preset holds, and what one piece of content should cost. Author for
`ultra` on desktop and let the presets take away: a phone draws fewer lights, smaller shadow maps
and smaller texture classes on its own, so never make the desktop picture cheaper to fit a phone.
Measure before cutting (`docs/api/profiling.md`); the units and frame-rate table are
`docs/calibration.md`.

## Per class

| Class | Preset | GPU memory budget | Frame rate | Render scale |
| --- | --- | --- | --- | --- |
| `desktop-ultra` | `ultra` | 1024 MiB | 60 | 1.0 |
| `desktop-high` | `high` | 512 MiB | 60 | 1.0 |
| `desktop-mid` | `medium` | 256 MiB | 60 | 1.0 |
| `desktop-low` | `low` | 128 MiB | 60 | 0.85 |
| `mobile-high`, `mobile-ultra` | `medium` | 160 MiB | 60 | 0.75 |
| `mobile-mid` | `low` | 96 MiB | 60, 30 sustained | 0.67 |
| `mobile-low` | `low` | 48 MiB | 30 | 0.6 |

A native desktop's budget is also held to a third of the GPU's memory and at most 12 GiB; a web
page's to 1024 MiB on a desktop and 256 MiB on a phone, and the web runs at most `high`.

## Per preset

| | `low` | `medium` | `high` | `ultra` |
| --- | --- | --- | --- | --- |
| Local lights shaded | 64 | 256 | 1024 | 1024 |
| Shadowed spot lights | 0 | 0 | 2 | 4 |
| Sun cascades, map side | 2, 1024 | 2, 1536 | 3, 2048 | 4, 4096 |
| Anti-aliasing | MSAA 4x | MSAA 4x | TAA, upscaling | TAA, upscaling |
| Largest texture class, native desktop (browser) | 512 | 1024 | 4096 (2048) | 4096 (2048) |
| Irradiance volumes baked | none | 4 | 8 | 8 |
| LOD threshold (px), far density | 2.0, 0.5 | 1.5, 0.75 | 1.0, 1.0 | 1.0, 1.0 |

Phones shade at most 256 local lights and one shadowed spot, at most 2 cascades of 1536 (512 on
`mobile-low`), keep textures to 1024 a side, bake 2 to 4 volumes at `high` and `ultra` only, and
draw the nearest 16 decals (64 on desktop).

## Hard caps

| What | Cap | Past it |
| --- | --- | --- |
| Triangles in one mesh or imported model level | 262,144 | `triangles-over-budget` on import |
| Texture side | 8192 native (when asked; 4096 by default), 2048 in a browser, 1024 on a phone | reduced to fit |
| Particle emitters drawn, particles per emitter | 16, 16,384 | the rest are not drawn |
| Particles per frame | 262,144 desktop, 32,768 `mobile-high`, 8,192 other phones | thinned |
| Custom materials, post passes | 32, 8 | registration refused |
| A capture's side | 8192 px natively, 4096 in a browser | the largest a check can ask |
| Assets per destination | web 64 MB, phones 200 MB, desktop 2 GB (`[assets] budget_mb`) | slower download; past 512 MB a web build is refused `assets-over-ceiling` |
| Web code | 4 MB of gzip (`[web] wasm_budget_mb`, at most 32) | slower load; past 32 MB refused `wasm-over-budget` |
| Web boot | `studio.json` `bootMs`, default 15000, 1000 to 60000 | the preview looks anyway |

`Particles::rain(..)` keeps about 9,600 drops alive, `Particles::snow(..)` about 10,000 flakes and
`Particles::dust(..)` about 1,200 motes: one emitter each covers a street.

## Per piece of content

Starting points for a desktop `ultra` picture; the importer makes the lower levels and impostors.

| Piece | Triangles at level 0 | Maps |
| --- | --- | --- |
| Hero prop the player handles or passes within 2 m | 10,000 to 60,000 | 2k colour, normal, ORM |
| Mid prop, furniture | 2,000 to 15,000 | 1k to 2k, shared atlas |
| Player character, enemy | 20,000 to 60,000 | 2k to 4k per character |
| Vehicle | 50,000 to 150,000 | 2k to 4k |
| Tree | 20,000 to 80,000, with an impostor past its last level | bark 2k, leaf cards with alpha |
| Kit module (2 m wall, window, door) | 200 to 3,000 | the shell's scans and a trim sheet |

A level's draws stay in budget by instancing what repeats (`docs/api/instance-groups.md`) and by
levels and impostors for what is far (`docs/api/drawing.md`), not by cutting what is near.
