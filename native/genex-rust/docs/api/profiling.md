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
- **Studio's `profile` verb** reads the summary, a `ProfileReport` v2 of the last frames (with the
  hitches kept), arms per-node GPU timing, or writes a Chrome trace into `state/profile/`. The
  project's CONTRACT.md lists each action. An agent reads these, and a game never calls them.
- **Crash records.** When a panic happens, the record names the seed, the tick it happened on
  and the last summary, so an agent can replay it with `seed` and `step`. A desktop export writes
  its records under the save root's `genex-crash/` (the newest 16 are kept).
