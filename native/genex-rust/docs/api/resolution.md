# Resolution

Every type and call in one line:

```rust
use genex::render::{ClassOverride, RenderConfig, ResolutionPreset, TextureClass};
game.render_settings(RenderConfig::from_build().resolution(ResolutionPreset::Native4k)); // or Cinematic8k
config.class(class, ClassOverride { max_texture_class: Some(TextureClass::S8192), ..Default::default() });
```

A game never hard-codes a resolution: the destination and the person pick it. These are the
numbers each destination draws at, and the two explicit tiers a game may ask for.

## Resolution and frame rate

| destination | output side (most) | rendered by default | textures (most) | material memory | frame rate |
| --- | --- | --- | --- | --- | --- |
| native desktop, `ultra` or `high` | 8192 | the Quality or Balanced share of the window, TAA-upscaled | 4096 | 40% of the budget | 60 |
| native desktop, `resolution(ResolutionPreset::Native4k)` | 8192 | every pixel (Native), checked at 3840x2160 | 4096 | 40% of the budget | 60 |
| native desktop, `resolution(ResolutionPreset::Cinematic8k)` | 8192 | every pixel (Native), checked at 7680x4320 | 8192 | 40% of the budget | 30 |
| native desktop, `medium` or `low` | 8192 | 1080p or 1440p, stretched to the window | 1024 or 512 | the class's rows | 60 |
| browser | 4096 | the class's share, at most 1440p | 2048 | the class's rows | 60 |
| phone | its screen | 0.6 to 0.75 of the screen | 1024 (512 at `low`) | the class's rows | 60 or 30 |

`resolution(..)` sets `ultra`, Native upscaling, dynamic resolution off and the tier's texture
class on every desktop class; a browser or a phone holds it to its own row, so one config is right
everywhere. Check it with `capture --size 3840x2160` (or `7680x4320`): a native capture side goes
up to 8192. Studio's embedded Live view stays at most 4096 a side; the game's own window and its
captures are not held to it. Measured on an M4 Max (a lit yard with a 4096 ground map): Native4k
draws in about 13 ms of GPU time, Cinematic8k in about 55 ms, so treat Cinematic8k as a capture and
cutscene tier.

Supersampling: on a native desktop-ultra a render scale set in code may reach 2 (`ClassOverride {
render_scale: Some(2.0), .. }`; `genex.toml` and the `renderSettings` lock stay within 0.5..=1), and
each output pixel is then the luminance-weighted mean of four rendered ones. Every other class stops at 1. Prefer the Native
tier first: scale 2 costs four times the pixels.

A material texture keeps its source size up to the largest class it reaches: a 4096 map stays
4096 on a native desktop at `high` and up, and is resampled to 2048 in a browser. The shaders bind
four class slots; natively they hold 256, 1024, 2048 and 4096 (256, 1024, 4096 and 8192 at the
cinematic tier), so a 512 image takes the 1024 class and a 512 KTX2 file loads its image instead.
Ship 2k and 4k maps as KTX2 (BC7 or ASTC: a quarter of RGBA8's bytes) with their normal and ORM
maps. Models holding the same image (kit pieces exported with the same scans, or their identical
sidecars) upload it once and share its layer, so a kit costs one upload a scan, not one a piece.

## Budgets

A native desktop's memory budget is a third of its GPU-visible memory, at most 12 GiB (9 GiB on a
36 GB Mac, about 1.8 GiB on an 8 GB MacBook Air). The material arrays may take 40% of it, split
half to the largest class, a quarter to the next and an eighth below: about ten 4096 layers of
colour and ten of data in RGBA8 on that Mac. A browser's budget is 64 MB per GB of `deviceMemory`
up to 1 GB, a phone's its class's (48 to 160 MB). Calibration moves a native desktop straight to its
measured tier, so Windows and Linux reach `ultra`; browsers and phones move one tier at most.

The web's 15 s boot gate and its 4 GiB memory warning are web budgets. Never cut native textures,
drop normal or ORM maps, or reuse GLBs to meet them.
