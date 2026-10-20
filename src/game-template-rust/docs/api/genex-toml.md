# genex.toml

```toml
[game]
title = "Pond"            # required
world_size = [960, 540]   # optional, each side 64..=4096
save_name = "pond"        # optional: letters, digits, space, _ - .

[crates]                  # optional: the reviewed allowlist (noise, fastrand, pathfinding), or a crate the
noise = "0.9"             # person approved through request_crate, pinned exactly: tidy = "=1.0.0"

[[crate_request]]         # optional: asks the person for a crate, as request_crate does
name = "tidy"
version = "1.0.0"         # one exact release
reason = "tidy layouts"   # optional, one sentence for the person

[[wgsl]]                  # optional WGSL sources: a custom pass reads one with include_str!, Level 2
path = "shaders/water.wgsl"   # loads material and post sources through Gfx (see Custom materials and post passes)
kind = "pass"             # pass | material | post
api = 1                   # optional: the extension API it is written against (default 1)

[gpu]                     # optional native-enhanced features; a game that names any has no web build
native_features = ["subgroup"]

[web]                     # optional: the browser build's code budget, in MB of gzip
wasm_budget_mb = 8        # 1..=32, default 4

[physics]                 # optional: a game with no physics builds without Rapier
enabled = false           # default true

[[texture]]               # optional: how a loose texture is used, when no model's material says
path = "textures/flow.png"   # under assets/: a PNG, JPEG or WebP
usage = "data"            # color | data | normal

[[asset_group]]           # optional: assets the game loads during play, by name
name = "castle"           # letters, digits, _ and -; never boot, sim or stream
paths = ["interiors/castle/**", "props/throne.glb"]  # globs under assets/
```

Unknown keys are refused. A `[[crate_request]]` row is a request, never an approval: keep it
(Studio files it for the person, who decides), and do not move the crate into `[crates]` yourself.
Native features: `shader-int64-atomic-min-max`,
`shader-int64-atomic-all-ops`, `subgroup`, `ray-query`, `mesh-shader`,
`texture-binding-array`, `multi-draw-indirect-count`. Every destination guarantees WebGPU
core (compute shaders, storage buffers, indirect draws) without declaring anything. The device
is opened with exactly the declared features, and one without them ends the run
`native-feature-missing`.

A `[[wgsl]]` source is staged with the game, size-checked and validated by naga. A `pass` source
is read by a custom GPU pass with `include_str!("../shaders/water.wgsl")` and built through
`PassSetup`; a `material` or `post` source is loaded by name through `Gfx` (see Custom materials and post passes). A
`[render]` table sets the look and the per-device quality (see Rendering).

A web export is built for size. Past its budget (`[web] wasm_budget_mb`, default 4 MB of gzip) it
still exports, with a warning that it loads slower on phones and weak devices; raise the budget
only when the brief targets strong desktops. Past 32 MB it is refused `wasm-over-budget`, and a
budget outside 1..=32 is refused `invalid-web-budget`. Live builds have no budget.

Rapier is about a fifth of a web build's code. A game that never touches `sim.physics` or
`genex::physics` sets `[physics] enabled = false`: it builds without Rapier, `sim.physics` is an
empty stand-in that is never stepped, and code that reaches for Rapier does not compile until
physics is turned back on.

A `[[texture]]` row tells Studio how a loose image your code samples itself is used (a flow map, a
mask, a custom material's normal map). A texture a model's material samples needs no row. The usage
never comes from the file name. A usage outside `color`, `data` and `normal`, a path outside
`assets/` or not a PNG, JPEG or WebP, or the same path twice is refused `invalid-texture-usage`.

When a build knows a PNG or JPEG's usage, Studio encodes it into GPU-compressed KTX2 files beside it,
one per texture family your destinations use (`ground.bc.ktx2` on desktops, `.astc` and `.etc2` on
phones, all of them on the web), and keeps the image as the fallback. An image that is not square
with a power-of-two side is first resized to the nearest square power-of-two size (a 1000x600 image
becomes 1024x1024), so sample it with UVs from 0 to 1. A WebP, or an image with no usage, ships as
it is.

An `[[asset_group]]` names assets your game does not need before its first frame (a castle's
interiors, a level's props). Each path is a glob under `assets/`: `*` matches within one folder, `?`
one character, and a whole `**` segment any number of folders. An asset may be in several groups.
Studio's asset index lists each group with its assets and marks them as not needed at boot. A name
outside letters, digits, `_` and `-` (64 at most), `boot`, `sim` or `stream`, a name used twice, a
group with no paths or more than 256, the same path twice, or a path outside `assets/` is refused
`invalid-asset-group`; so are more than 64 groups.
