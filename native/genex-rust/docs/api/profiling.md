# Profiling

A game times its own work with `genex::profile_scope!` and reports a number per frame with
`genex::profile::counter`. Both are write-only: nothing a tick computes can read them, so the
checksums are the same with profiling on, off or never started.

```rust
use genex::profile::ScopeName;

const ENEMIES: ScopeName = ScopeName::new("enemies");

game.on_update(|sim, ctx| {
    genex::profile_scope!("enemy_ai");
    for enemy in &mut sim.world.enemies {
        enemy.think(ctx);
    }
    genex::profile::counter(ENEMIES, sim.world.enemies.len() as f64);
});
```

- **Scope names.** A name is 1 to 48 bytes of `a-z`, `0-9`, `_`, `.` and `-`. The name is checked
  when the game compiles, so `profile_scope!("Enemy AI")` does not build. A run keeps at most 256
  scope names and 64 counter names. Calls past a cap are dropped and counted in `dropped`.
- **Cost.** A scope costs a thread-local read when profiling is off. Time the parts you want to
  compare, such as AI, a generator or a pathfinding batch, and not every small function.
- **Where it shows.** In a Studio run, each Live frame is one profiler frame. The runtime times
  each tick (`tick`), the frame (`frame`) and its draw (`draw`). `state().volatile.profile` then
  summarizes the last 120 frames:

```json
{ "v": 1, "on": true, "frames": 120,
  "cpu": { "p50": 6.1, "p95": 9.8 },
  "gpu": { "p50": 4.2, "p95": 5.0, "source": "timestamps" },
  "top": [ { "scope": "enemy_ai", "game": true, "p95": 1.1 }, { "scope": "tick", "game": false, "p95": 1.9 } ],
  "counters": { "enemies": 42 }, "memory": [], "hitches": { "count": 0 },
  "nodes": "off", "dropped": { "scopes": 0, "counters": 0, "frames": 0 } }
```

  `top` lists the 8 heaviest scopes by p95, and `game: true` marks the game's own scopes. The
  summary is at most 4 KiB. A run whose shell never started profiling, such as a test that drives
  `Runtime` directly, has no `volatile.profile`.
- **On the web** (Web Live and an export) the shell does not start profiling yet: there is no
  `volatile.profile`, Studio's `profile` verb answers `unknown-op`, and a scope costs its
  thread-local read. Time a hitch on a native run (Native Live).
- **Studio's `profile` verb** reads the summary, a `ProfileReport` v2 of the last frames (with the
  hitches kept), arms per-node GPU timing, or writes a Chrome trace into `state/profile/`. The
  project's CONTRACT.md lists each action. An agent reads these, and a game never calls them.

What the renderer's features (`docs/api/rendering.md`) cost: on an M4 Max at 1080p (GPU p50) HDR
with tonemap and exposure costs about 0.1 ms, bloom 0.25-0.4, AO 0.45-0.6 (1.4 at `ultra`), contact
shadows 0.15-0.3, TAA 0.2, EASU with RCAS under 0.3 and `ultra`'s sun shadows about 0.6.

## Crash records

A panic, an uncaught GPU error or a lost device becomes one `genex-crash/1` record: its `kind`
(`panic`, `gpu-validation`, `device-lost`, and from the shell, the platform or the host
`wasm-trap`, `native-fault`, `out-of-memory`, `hang` and `process-exit`), the message, the file and
line, the raw frames, the seed and tick it happened on, the last profile summary and the input
that led to it (`replay`). Where it goes depends on the run:

- **A Studio run** sends it to Studio, which keeps the run's last record in the game's
  `.studio/crashes/` (at most 32; the same crash again is counted, not stored twice), names its
  frames from the build's debug files, shows it on Live's crash card and hands its kind, line and
  tick to the agent that looks next. Agents read them with `game.crashes`.
- **The web page** keeps up to 16 in the browser's IndexedDB, which the page's `crashes` member
  answers (`docs/CONTRACT.md`).
- **A desktop export** writes its records under the save root's `genex-crash/` (the newest 16).
- **A phone build** writes them as `genex-self-test/crash-<n>.json` beside its self-test records
  (the newest 16), and at the next launch also records what the panic hook could not see, each
  once: on iOS every MetricKit crash diagnostic (a native fault, or a memory kill as
  `out-of-memory`), on Android the last exit when it was a native crash (with the tombstone's
  frames from Android 12) or a low-memory kill. Their frames are image offsets, not symbols.

To reproduce one, seed its seed, pause and step to its tick; when `replay` holds input, a demo that
injects the same input after the seed walks the crash path. A crash that does not come back on
that path is nondeterminism (a clock, a thread, a hash map), not the line it named. Fix the cause
and never catch the panic: catching loses the record and leaves the state broken. Nothing uploads
a record; each stays where its run wrote it.

## The player overlay

In the dev flavour (Live, a Studio run) Ctrl+Shift+P shows a small panel in the window's top-right
corner: CPU and GPU frame times, hitches, the heaviest scopes (the game's in blue) and the game's
counters. It is painted over the window after the HUD and outside the tick, so it is never in a
capture, never in `state().hud.items`, and showing it changes nothing a tick sees. Exports do not
offer the chord.
