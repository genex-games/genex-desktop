# Ctx

`ctx.keys` (`down`, `pressed`, `released` by `Key`, the DOM code names), `ctx.touches`,
`ctx.pads`, `ctx.pointer` (fraction of the frame, y down), `ctx.look`, `ctx.wheel`,
`ctx.text`, `ctx.rng` (the only randomness), `ctx.dt` (1/60), `ctx.tick` (ticks since the last
seed), `ctx.world_size`, and `ctx.save(file, bytes)` / `ctx.load(file)` for the game's own save
folder (a safe relative name; a folder the studio gives each run). One save holds at most 16 MiB
and all of a game's saves 64 MiB together; `ctx.save` answers false past either. On Vulkan the
renderer keeps its pipeline cache in the same folder (`genex-pipeline-cache/<adapter>.bin`): leave
that name alone. The pipeline cache counts toward the 64 MiB. The `.sav` suffix is reserved for
genex's slot bodies, which load lazily on the web, so name your own files otherwise.

`world_size` is the game's logical size on every screen: touches, the pointer, the HUD's points
and a capture's default size are measured in it. It is not the resolution: Live frames are drawn
at the window's own pixels (capped per device class), so a larger window is sharper, never a
stretched picture, and a capture is drawn at the world size unless a check asks for another.

`Game::fit` says how the world meets a window of another aspect (keep `genex.toml` `[game] fit`
the same; another word is refused `invalid-fit`). `Fit::Letterbox`, the default, keeps black bars.
`Fit::Expand` fills the window: the world stays whole and centred where the letterbox would put
it, and the view grows past it on the window's long side, more scene at the sides of a wide
window (the vertical field of view kept) and above and below a tall one (widened to keep the
world's width). The simulation, `ctx.world_size`, the pointer and touches, the HUD and captures
at the world size never see the window, so replays and goldens do not change with it. Over the
margin past the world the pointer and touches hold at its nearest edge and the 2D layer goes on
in world pixels (draw a 2D backdrop wider than the world); keep a fixed-aspect picture on letterbox.

Edges fire on the first tick after input arrives, so a long step never presses a key twice.
`Input::key_tap(Key::Space)`, `Input::key_down`, `Input::key_up`, `Input::click_at(x, y)`,
`Input::pointer`, `Input::look`, `Input::wheel` and `Input::text` build injections;
`a.and(b)` combines them.

**Touch** is the first-class pointer on phones and tablets, and every destination delivers it
the same way. `ctx.touches.all()` lists the fingers this tick, each a `Touch` with a stable
`id`, a world position in pixels (y down, the game's own `world_size` before any letterbox) and a
phase: `Began`, `Held`, `Ended` or `Tapped` (down and up between two ticks). `tapped()` and
`began()` answer for any finger. The mouse's first button arrives as touch 0, so one code path
serves a desktop and a phone: do not also read `ctx.pointer` for the same action. Multi-touch
needs only the list. `Input::touch_start(id, x, y)`, `Input::touch_move(id, x, y)` and
`Input::touch_end(id, x, y)` inject a finger (the `touch` input kind; the others are `gamepad`,
`text`), which is how a demo and the checks play a touch game.

**Input actions.** Read a game's own controls as actions, not keys: `game.input(..)` and
`ctx.actions` are `docs/api/input.md` (the action map, contexts, on-screen touch controls,
rebinding, prompts and replays). The raw devices above stay for what an action map does not
cover, such as a finger the touch controls did not take.

**Audio.** The types live in `genex::audio` (the prelude has `Sound`, `Music`, `PlayOpts`, `Bus`,
`AudioSetup` and the rest):

- `gfx.sound(path)` and `gfx.music(path)` in `on_reset` read a file under `assets/` once (WAV,
  Ogg Vorbis, MP3, FLAC; Ogg music stays compressed). A refused file is a missing sound:
  `sound.refusal()` names why (`not-preloaded`, `needs-import`, `malformed`, `memory-limit`) and
  its play is refused `sound-missing`.
- The update and UI hooks call `ctx.audio.play(&sound)`, `ctx.audio.play_with(&sound, opts)`
  (`PlayOpts::ui()` for menus), `ctx.audio.play_at(&sound, position)`, `ctx.audio.stop(..)`,
  `ctx.audio.set_position(..)`, `ctx.audio.bus_volume(..)` and `ctx.audio.music(&music, opts)`.
  Commands apply after physics, with the game's own camera as the ears.
- `ctx.audio.playing(voice)` answers the logical state, the same on every destination; audio
  never enters the checksum. Check sound through `state().volatile.audio` (voices, events,
  counts, issues) and `audioLevel`, never by ear.
- `game.audio(AudioSetup { .. })` adds ducking, reverb zones and collider occlusion. Install
  refusals: `duplicate-audio`, `audio-zone-limit`.
- A device plays only in a run a person sees: a desktop window, Studio Live, the web page after
  its first click or key, a phone while it holds its audio. Headless runs and tests open none
  (`volatile.audio.device.open` is false); the mix and `audioLevel` are the same either way.
