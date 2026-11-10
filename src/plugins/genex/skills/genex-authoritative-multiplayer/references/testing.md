# Testing a room module on this machine

`@genex-ai/authority-dev` runs the room module exactly as Genex's servers do — the same room core,
the same sandbox limits, the same bundler — on this machine, with no account and no network. It is
a dev dependency of the game (`npm i -D @genex-ai/authority-dev`); `npx genex preview` uses the same
package to check the module before it ships.

| Command | What it does |
|---|---|
| `npx genex-authority-dev validate --module server/room.ts --root .` | The publish gate: bundles the module, fuzzes it for 30 simulated seconds with random and adversarial players, checks every tick, holds its tick time to a CPU budget, and replays the run twice. Exit 0 = passed. `--out report.json` keeps the report. |
| `npx genex-authority-dev start --module server/room.ts --root . --bots 3 --latency 75 --report` | Serves the module on `127.0.0.1` with bots that join, wander, aim and fire, behind a 75 ms each-way link. |
| `npx genex-authority-dev replay --module server/room.ts --root .` | Replays the validation run twice and prints both state hashes. Equal means the module is deterministic. |

`--root .` lets the module import files outside its own folder (a movement step in `src/`); every
file the bundle reads must still be inside the game. `--port` picks the port (default: any free
one), `--jitter` adds random delay on top of `--latency`, `--duration` stops after that many seconds
and `--seed` changes the run. `start` only ever listens on `127.0.0.1`.

## Playing against the local server

`start` prints one line per event on stdout:

```
LISTEN ws://127.0.0.1:<port>
REPORT {"rooms":1,"players":4,"tick":{"p50Ms":…,"p99Ms":…,"maxMs":…,"budgetMs":…},"strikes":0,"lastFault":null,…}
LOG {"room":"…","line":"what ctx.log wrote"}
ERROR {"reason":"…","detail":"…"}
```

Start the game's dev server and open it with the address from `LISTEN`:

```
http://localhost:5173/?genex_local_test=1&genex_authority_url=ws://127.0.0.1:<port>
```

In local test mode `getAuthorityUrls()` returns that address and `getColyseusAuth()` a local
placeholder, so the game's own client joins without a change. Every join is a fresh local player
(whatever room name it sends, it meets the bots), so a second browser window is a second player.
Only a page served from this machine may join.

Read the REPORT line while you play: `strikes` above 0 or a `lastFault` means the module faulted
(the module's own bug, named by its close code); a `tick.p99Ms` near `tick.budgetMs` means the
module is too slow for Genex's servers; `corrections.visible` counts the bots' predictions the
server had to correct visibly — near zero is the goal, and your own client's count is
`session.telemetry.visibleCorrections`. Stop the server with Ctrl+C.

## A room with projectiles

The same commands test it; nothing extra to install. What to look for:

- **The fuzz and the bots fire button bit 1.** `validate` presses it most often and other bits now
  and then; the bots that `start` runs press only bit 1, aimed at the nearest player. Bind the main shot
  to bit 1, or neither ever launches one.
- **Removal is yours.** A module that never removes its projectiles fills the room's 1024 entities
  and fails `module_ended`, with `too_many_entities` in the detail. `--out report.json` keeps the
  report, whose `entitiesPeak` says how many entities the fuzz room held at its fullest: it should
  stay far below 1024.
- **A launch that throws is a fault**: an `id` passed inside `onInput`, none passed in `step`, a
  launch in `init` (`load_failed`), or a burst past the launch budget (`RangeError`).
- **In the browser**, at `--latency 75`: your shot leaves the frame you fire and flies on without a
  jump when the server's arrives; another player's (a bot's) shots fly smoothly, not 100 ms behind;
  `session.telemetry.projectilesRejected` stays near 0 while you fire steadily, and
  `session.telemetry.projectilesConfirmed` grows with each shot.

## Why validation failed

`validate` (and `npx genex preview`, which runs it) names each failure by reason, with the close code
where the module itself ended or faulted:

| Reason | What happened | Fix |
|---|---|---|
| `build_failed` | The bundler could not build it: a syntax error, a missing file, a package import, a Node built-in. | Import only your own files; the module gets everything else through `ctx`. |
| `outside_root` | The bundle reads a file outside the game folder (or outside `--root`). | Keep every import inside the game; pass `--root .` for shared files in `src/`. |
| `too_large` | The bundle is over 1 MiB. | Move data out of the module; generate it in `init`. |
| `unavailable_global` | It uses something the sandbox does not have (`Date`, `setTimeout`, `fetch`, …). | Use `ctx.tick` and `ctx.dt` for time, `ctx.random()` for randomness. |
| `global_object` | It reaches `globalThis` instead of `ctx`. | Pass what it needs through `ctx` and `ctx.state`. |
| `load_failed` | Its top level or `init` failed (the code says how: an error, a timeout). | Keep the top level to constants and functions; make `init` small. |
| `module_ended` | The fuzz run ended the room: a timeout, too much memory, too many faults, a CPU budget broken. | Bound every loop by entities or players; never grow state without limit. |
| `module_fault` | It faulted at least once and survived: a hook threw, or its output broke a limit. | Fix the throw or the output; validation allows none. |
| `nondeterministic` | Two replays of the same run gave different states. | Remove every source of difference: a clock, unordered iteration, state outside `ctx.state`. |
| `tick_budget` | Its tick time p99 is over the local budget. | Do less per tick; move setup to `init` and `onJoin`. |
| `orphan_entity` | After a tick, an entity was owned by a player who had left. | Remove (or disown) a player's entities in `onLeave`. |
| `log_flood` | One tick logged more lines, or longer lines, than a room keeps. | Log on events, not every tick. |
| `short_run` | The fuzz ran fewer than 30 simulated seconds (`--duration`). | Run it with the default duration; a short run never passes. |
| `host_stall` | A busy machine cut a call off by wall clock while the module stayed under its CPU limit: no verdict on the module. | Change nothing in the module; run `validate` again on a quieter machine. |
| `physics_unavailable` | The module asks for `physics` and this validator has no physics core. | Update `@genex-ai/authority-dev`; see [physics.md](physics.md) for when servers run physics. |
| `physics_build` | The two replays ran on different physics core builds, so they were not compared. | Change nothing; run `validate` again. |
| `physics_backend_parity` | With `--physics-backend both`, the replay on the second physics core gave a different state from some tick on. | Report it with the tick the output names: the two cores must agree, so this is a core bug, not the module's. |

## When the deploy refuses the module

`npx genex preview` and `npx genex publish` print `Room module refused (<reason>)` and change
nothing:

| Reason | What to do |
|---|---|
| `manifest_invalid` | Fix `genex.authority` as the message says: a plain relative path to a `.js` or `.ts` file inside the game, and valid optional knobs. |
| `toolchain_missing` | `npm i -D @genex-ai/authority-dev`, then deploy again. |
| `toolchain_unusable` | `npm i -D @genex-ai/authority-dev@latest`, then deploy again. |
| `bundle_failed` | The bundler's reason is printed beside it (a reason from the table above). |
| `validate_failed` | Each validation failure is printed; the full report is at `.genex/authority/report.json`. Reproduce with `npx genex-authority-dev validate`. |
| `sha_disagrees` | The report passed a different bundle than the one to upload: update `@genex-ai/authority-dev` and deploy again. |
| `too_large` | The module is over 1 MiB, or its report over 64 KiB. |
| `config_out_of_range` | The tick rate or player count is one Genex does not run (20, 30, 60 or 120 Hz, 120 only with physics; 1 to 64 players). |
| `requires_pro` | The game's owner needs Genex Pro for Genex's servers. Testing on this machine stays free. |
| `upload_failed` | The module store refused the upload or could not be reached; try again. |

## Before calling it done

1. `validate` passes and `replay` says the hashes are equal.
2. At `--latency 75`, two players (two windows count) move, aim and fire, and see each other move
   smoothly, about 100 ms behind.
3. A hit lands when it looked right on the shooter's screen; a respawn snaps instead of sliding.
   With projectiles: a shot is judged where the target is on the server, so a dodged bolt misses.
4. Leaving and rejoining works, and the leaver's body is gone for everyone.
5. The REPORT line shows no strikes after a few minutes of play.

Say plainly what was not exercised (a full room, a slow connection, a reconnect).
