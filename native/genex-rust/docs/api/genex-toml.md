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

[audio]                   # optional: a game with no sound builds without the mixer and decoders
enabled = false           # default true

[nav]                     # optional: a game without walkers builds without navigation's engine
enabled = false           # default true

[streaming]               # optional: a game without a streamed world builds without its engine
enabled = false           # default true

[animation]               # optional: a game without animated characters builds without its engine
enabled = false           # default true

[[texture]]               # optional: how a loose texture is used, when no model's material says
path = "textures/flow.png"   # under assets/: a PNG, JPEG or WebP
usage = "data"            # color | data | normal

[[asset_group]]           # optional: assets the game loads during play, by name
name = "castle"           # letters, digits, _ and -; never boot, sim or stream
paths = ["interiors/castle/**", "props/throne.glb"]  # globs under assets/

[assets]                  # optional: your packages' budgets, in MB
budget_mb = 300           # every destination's; defaults web 64, ios 200, android 200, desktop 2048
phone_max_texture_px = 2048  # 512..=4096, a power of two

[assets.web]              # one destination's own budget: web, ios, android or desktop
budget_mb = 64            # at most 512 on the web, 4096 on a phone

[net]                     # optional: multiplayer; absent, the game is built with no networking
enabled = true            # required in the table

[net.matchmaking]         # optional: what matchmake() asks Genex's relay for, carried by the draft
preset = "open"           # open | duel | arena | teams | private
win_condition = "firstToScore"  # optional: lastStanding | firstToScore | highScoreInTime | firstToFinish

[net.matchmaking.config]  # optional: the preset's numeric knobs, in Genex's spelling
maxPlayers = 8            # at most 16 knobs, each 0..=1000000
minPlayers = 2
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

A game that plays no sound sets `[audio] enabled = false`: it builds without the mixer and the
decoders, and its code compiles unchanged, with every sound missing `audio-disabled`
(`docs/api/audio.md`).

Navigation, world streaming and animation switch off alike: `[nav]`, `[streaming]` and
`[animation]` with `enabled = false` leave that system's engine out of the build, and the game's
code compiles unchanged. A switched-off system refuses what it would do: `game.navigation` and
`game.nav_bake` fail install `nav-disabled`, `game.streaming` fails install `streaming-disabled`,
and `gfx.character`, `gfx.node_clips` and every animator are refused `animation-disabled`;
`sim.nav` and `sim.stream` stay, empty. The switches apply in Live as in the export. The template
switches all three off, so a new game's web build stays small; set `enabled = true` (or delete
the line) before adding walkers, a streamed world or an animated character.

A `[[texture]]` row tells Studio how a loose image your code samples itself is used (a flow map, a
mask, a custom material's normal map). A texture a model's material samples needs no row. The usage
never comes from the file name. A usage outside `color`, `data` and `normal`, a path outside
`assets/` or not a PNG, JPEG or WebP, or the same path twice is refused `invalid-texture-usage`.

When a build knows a PNG or JPEG's usage, Studio encodes it into GPU-compressed KTX2 files beside it,
one per texture family your destinations use (`ground.bc.ktx2` on desktops, `.astc` and `.etc2` on
phones, all of them on the web, where a browser downloads only the one its GPU reads), and keeps the image as the fallback. An image that is not square
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

Each build's assets are measured against its destination's budget: 64 MB on the web, 200 MB on an
iPhone or an Android phone, 2 GB on a desktop, unless `[assets]` names another (`budget_mb` for every
destination, `[assets.<destination>] budget_mb` for one; `desktop` is Mac, Windows and Linux).
Past its budget an export is still made, with a warning that it takes longer to download
(`assets-over-budget`). Past the destination's hard cap (512 MB on the web, the most the page loads;
4096 MB on a phone) the build is refused `assets-over-ceiling`, and a budget below 1 MB or past the
cap is refused `asset-budget-out-of-range`. `phone_max_texture_px` (default 2048) is the largest
texture side an iPhone or Android package keeps; one that is not a power of two from 512 to 4096 is
refused `invalid-texture-cap`.

`[net] enabled = true` builds the game with networking (`docs/api/net.md`). Studio's Live, its
judges and the Simulator build an On a device press installs link the in-process room, so nothing
Studio runs reaches the network; only an export links the relay, and it joins the game's own Genex
draft. Test multiplayer on the published draft, in a normal and a private window.
`[net.matchmaking]` reaches Genex with the draft as a three.js game's `genex.matchmaking` does;
without it, `matchmake()` gets Genex's `duel`. Write it as the tables above: an inline table
(`matchmaking = { … }`) is refused `manifest-syntax`. `enabled` missing or not a boolean, an
unknown key, a preset or win condition outside the lists, or a knob that is not a camelCase name
with a number from 0 to 1000000 (at most 16) is refused `invalid-net`.
