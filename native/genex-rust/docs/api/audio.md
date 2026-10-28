# Audio

Sounds, music and spatial audio live in `genex::audio`. A reset loads them with `gfx.sound(path)`
and `gfx.music(path)`, the update and UI hooks play them through `ctx.audio`, and
`game.audio(AudioSetup { .. })` registers ducking, reverb zones and occlusion. The prelude has
`Sound`, `Music`, `PlayOpts`, `MusicOpts`, `Bus`, `Voice`, `Spatial`, `Listener`, `AudioSetup`,
`Duck`, `ReverbZone`, `ReverbPreset` and `ZoneShape`.

Every type and call in one line:

```rust
use genex::prelude::*;                                         // Sound, Music, PlayOpts, MusicOpts, Bus, Voice, Listener, AudioSetup, Duck, ReverbZone, ReverbPreset, ZoneShape
use genex::audio::{SoundRefusal, ZoneId};                      // what sound.refusal() and add_zone answer
gfx.sound("sfx/step.wav"); gfx.music("music/theme.ogg");       // on_reset -> Sound, Music (missing, never a panic)
sound.refusal(); sound.is_missing(); sound.seconds();          // -> Option<SoundRefusal>, bool, f32; Music the same
ctx.audio.play(&sound); ctx.audio.play_at(&sound, at);         // -> Voice
ctx.audio.play_with(&hum, PlayOpts::default().looped().on(Bus::Ambience).volume_db(-6.0)); // -> Voice
// PlayOpts::default() then .looped() .on(bus) .volume_db(db) .max_instances(n); PlayOpts::ui() for menu sounds
// Bus::Music | Bus::Sfx (the default) | Bus::Ui | Bus::Voice | Bus::Ambience
ctx.audio.stop(voice, fade_s); ctx.audio.stop_bus(bus, fade_s);
ctx.audio.set_position(voice, at); ctx.audio.teleport(voice, at);
ctx.audio.set_volume(voice, db, fade_s); ctx.audio.set_pitch(voice, rate, fade_s);
ctx.audio.playing(voice); ctx.audio.position_s(voice);         // -> bool, Option<f32>
ctx.audio.bus_volume(bus, db, fade_s); ctx.audio.master_volume(db, fade_s);
ctx.audio.music(&music, MusicOpts::default()); ctx.audio.stop_music(fade_s);
ctx.audio.listener(Some(Listener { position, forward, up }));  // None: back to the game camera
ctx.audio.add_zone(zone); ctx.audio.remove_zone(id);           // -> ZoneId; zone: a ReverbZone (below)
game.audio(AudioSetup { ducks: vec![duck], zones: vec![zone], occlusion: true, ..AudioSetup::default() });
// Duck { trigger: Bus::Voice, target: Bus::Music, depth_db, attack_s, release_s }
// ReverbZone { name, shape: ZoneShape::Box { min, max } | ZoneShape::Sphere { center, radius }, preset: ReverbPreset::CAVE, send_db, uniformity }
```

```rust
// World holds `step: Option<Sound>` and the player's `position: Vec3`.
game.on_reset(|sim, _, _, gfx| sim.world.step = Some(gfx.sound("sfx/step.wav")));
game.on_update(|sim, ctx| {
    let Some(step) = &sim.world.step else { return };
    if ctx.keys.pressed(Key::Space) {
        ctx.audio.play_at(step, sim.world.position);
    }
});
```

## Loading

- `gfx.sound(path)` in `on_reset` reads `assets/<path>` (WAV, Ogg Vorbis, MP3, FLAC) once and keeps
  it decoded across seeds. `gfx.music(path)` reads music the same way; Ogg Vorbis stays compressed
  and decodes while it plays (about 1 MB a minute).
- A refused file is a missing handle, never a panic: `sound.refusal()` names why (`not-at-reset`,
  `not-preloaded`, `unsafe-path`, `missing`, `needs-import` for Opus or AAC, `malformed`,
  `memory-limit` past 48 MiB of decoded sounds) and a play of it is refused `sound-missing`.
  `sound.is_missing()` says whether it plays silence; `sound.seconds()` is its length at pitch 1
  (0 when missing). Music handles answer the same three.
  `state().volatile.audio.issues` lists each refusal once.

## Playing

From `on_update` and the UI hooks:

| Call | Does |
|-|-|
| `ctx.audio.play(&sound)`, `ctx.audio.play_with(&sound, opts)`, `ctx.audio.play_at(&sound, position)` | Start a voice; answers its `Voice` |
| `ctx.audio.stop(voice, fade_s)`, `ctx.audio.stop_bus(bus, fade_s)` | Fade out |
| `ctx.audio.set_position(voice, at)`, `ctx.audio.teleport(voice, at)` | Move a voice (`teleport` without a Doppler sweep) |
| `ctx.audio.set_volume(voice, db, fade_s)`, `ctx.audio.set_pitch(voice, rate, fade_s)` | Change a voice |
| `ctx.audio.playing(voice)`, `ctx.audio.position_s(voice)` | Read the logical state (end of the last tick) |
| `ctx.audio.bus_volume(bus, db, fade_s)`, `ctx.audio.master_volume(db, fade_s)` | The simulation's volume layer |
| `ctx.audio.music(&music, opts)`, `ctx.audio.stop_music(fade_s)` | Music with crossfade |
| `ctx.audio.listener(Some(ears))`, `ctx.audio.listener(None)` | Override the ears; None goes back to the game camera |
| `ctx.audio.add_zone(zone)`, `ctx.audio.remove_zone(id)` | Reverb zones (16 at most) |

Commands apply after the hooks and the physics step, in call order, with the game's own camera as
the ears (never an observer or debug camera). `PlayOpts::ui()` plays menu sounds on the UI bus.
The buses are `music`, `sfx`, `ui`, `voice` and `ambience`; the settings menu's Audio tab (`docs/api/settings.md`) sets the
person's volume for each, outside the simulation.

A sound plays once unless its options loop it: `ctx.audio.play_with(&hum, PlayOpts::default()
.looped().on(Bus::Ambience).volume_db(-6.0))` plays an engine hum, rain or a room tone until
`ctx.audio.stop(voice, fade_s)`, so keep the answered `Voice` in the world. `.on(bus)` picks its
bus (`Bus::Music`, `Bus::Sfx`, the default, `Bus::Ui`, `Bus::Voice`, `Bus::Ambience`) and
`.volume_db(db)` its level.

A play keeps at most 4 voices of one sound (`MAX_INSTANCES_DEFAULT`): another play of it steals the
oldest. `ctx.audio.play_with(&steps, PlayOpts::default().max_instances(8))` sets the cap, and
`.max_instances(0)` removes it, as a ring of looping emitters of one sound needs.

## Setup

`game.audio(AudioSetup { .. })` registers ducking rules, reverb zones present from the first tick
and collider occlusion (with physics: each non-sensor collider between the ears and a voice lets
about -9 dB through, up to three). Install refusals: `duplicate-audio` (a second call),
`audio-zone-limit` (more than 16 zones).

## Refusals

A refused load or command is silence and a typed code, never a panic. A load answers its code
through `sound.refusal()`, a play through a `refused` event in `volatile.audio.events`:

| Code | When |
|-|-|
| `mixer-failed` | The mixer could not start; the game runs silent. |
| `sound-limit` | Every voice is playing and outranks the new one. |
| `unsupported-format` | A format the runtime never plays (QOA, XM or MOD trackers, video, an unknown extension). |
| `needs-import` | Opus or AAC: the studio's import step converts it to Ogg first. |
| `malformed` | The bytes are not the format the name says, or are damaged. |
| `too-large` | Larger than the runtime decodes into memory. |
| `instance-limit` | Every instance a sound's `max_instances` allows outranks the new play. |
| `zone-limit` | More than 16 reverb zones. |
| `sound-missing` | The sound was missing or refused at reset. |
| `memory-limit` | Decoded sounds would pass 48 MiB. |
| `invalid-value` | A position, volume or pitch that is not finite: the command is dropped. |
| `audio-disabled` | The game is built with `[audio] enabled = false`: every sound and piece of music is missing. |

## Determinism

Audio never enters the checksum. Voices, gains, pans, occlusion and music position are decided
logically: the same seed, input and ticks give the same `volatile.audio` on every destination and
device class (48 rendered voices on desktop, 32 on the web, 24 on phones, 64 logical; the others
are virtual and resume at the right offset). Rendered samples differ by target and are display
only.

`native/genex-rust/examples/audio-yard` plays every call on this page along a 20 s walk: footsteps
and a gun burst capped by `max_instances`, dialogue ducking the music, a crossfade at a cave's
reverb zone, a wall occluding a generator, a Doppler fly-by and UI clicks. Its rows pin one logical
digest that native, x86_64 and wasm32 reach at all three pool sizes, and its captures equal those of
the same game with every audio call left out.

## Checking sound

Check sound with the state and the meter, never by ear:

- `state().volatile.audio`: `pool`, `voices` (`sound`, `bus`, `gainDb`, `pan`, `occluded`,
  `virtual`, `positionS`), `buses` (`simDb`, `personDb`), `music`, `listener`, `zone`, `events`
  (`played`, `ended`, `stopped`, `stolen`, `virtualized`, `realized`, `refused`, `music-started`,
  `music-ended`, each with its tick), `counts`, `person` (the settings menu's volumes), `device`
  (`open`, `muted`, `queuedMs`, `underruns`, `fault`) and `issues`. It appears once the game asked
  for a sound or registered `game.audio`.
- To prove a sound played: `step` past the tick that plays it, then read `volatile.audio.events`
  for its `played` event and `counts.played`.
- `audioLevel` (a native run) and the web page's `audio()` answer the game's own mix as `rms` and
  `centroid`, over the last 2048 frames, before the mute. The page's answer also carries
  `available`: false only for a build made before the level probe or a level it could not read,
  and then it is never judged.

## Building without audio

A game that plays no sound sets `[audio] enabled = false` in `genex.toml`: it builds without the
mixer and the decoders, the largest audio share of a web build. Its code compiles unchanged, but
every `gfx.sound` and `gfx.music` handle is missing (`audio-disabled`), `ctx.audio.play` answers
`Voice::NONE`, `playing` is false, no device opens, and `state().volatile.audio` is
`{ "enabled": false, "issues": [...] }` once the game asked for a sound. The template ships audio
off: set `[audio] enabled = true` in the change that adds the first sound.

## Devices

A device plays only in a run a person sees: a desktop window, Studio Live while embedded, the web
page after its first click, key or touch (the browser's autoplay rule), and a phone while it holds
its audio (iOS session, Android focus; an interruption mutes it). `audio({muted})` and a phone's
audio gate mute the device only; the mix, the meter and the simulation go on. Headless runs and
tests never open one (`volatile.audio.device.open` is false). Faults are typed in
`volatile.audio.device.fault`: `no-device`, `device-lost`, `underrun`.
