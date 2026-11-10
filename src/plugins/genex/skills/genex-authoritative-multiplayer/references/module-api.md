# Room module API

The room module is one ES module whose default export is a room. Its types are published at
`@genex-ai/multiplayer/authority/module`: `GenexRoomModule`, `RoomContext`, `InitContext`,
`EntityApi`, `EntityData`, `EntityInit`, `RewindApi`, `ProjectileApi`, `ProjectileInit`,
`ProjectileFlight`, `ProjectileHit`, `InputData`, `PlayerInfo`, `ModuleConfig`,
`ResolvedModuleConfig`, `PresetSpec`, `LeaveReason`, `Vec3`, `Json`, `MODULE_CONTRACT` and the
identity helper `defineRoom`.

A TypeScript module imports the types with `import type` (they are erased when it is bundled). A
module imports **nothing at runtime from a package**: the bundle runs in a sandbox and every byte it
needs must be inside the game folder. A plain-JavaScript module therefore writes its own one-line
`defineRoom`, as [the template](room-template.md) does. Relative imports of your own files are
fine — a movement step in `src/` that the client also runs is the usual one.

```ts
import type { GenexRoomModule, InputData, PlayerInfo, RoomContext } from "@genex-ai/multiplayer/authority/module";

interface State {
  score: Record<string, number>;
}

const room: GenexRoomModule<State> = {
  contract: 1,
  config: { tickHz: 30, maxPlayers: 8, preset: { name: "topdown" }, lagComp: { buttons: 1 } },
  init: () => ({ score: {} }),
  onJoin(ctx, player) { ctx.entities.spawn({ kind: "player", owner: player.id, hp: 3 }); },
  onLeave(ctx, player) { const me = ctx.entities.ownedBy(player.id); if (me) ctx.entities.remove(me.id); },
  onInput(ctx, playerId, input) { /* one input, after the preset moved the player's body */ },
  step(ctx) { /* once per tick, after the tick's inputs */ },
};
export default room;
```

## The room

| Field | What it is |
|---|---|
| `contract` | Always `1`. A bundle whose default export has another contract does not load. |
| `config` | Optional, and the one place to set these. `tickHz` (20, 30, 60 or 120), 120 only with `physics`; `maxPlayers` (a room never seats more than the game's manifest allows), `preset` (`{ name, params? }` with `name` one of `topdown`, `firstperson` or `vehicle`, see [presets.md](presets.md)) and `lagComp: { buttons }` — the bitmask of input buttons that ask for lag compensation. What the room runs with is `ctx.config` in `init`. `physics` asks for server physics (crates, balls, doors): see [physics.md](physics.md), which also says when Genex's servers run it. |
| `world` | The `firstperson` and `vehicle` presets' collision world, `{ boxes, ramps }`, fixed for the room's life. Validated when the module loads; its hash becomes the preset's `params.world`, and the client hands its session the same object (`session.setWorld`). Left out, the world is empty: no floor. See [presets.md](presets.md). |
| `init(ctx)` | Runs once. Returns the module's own state, `ctx.state` from then on. Clients never see it. |
| `onJoin(ctx, player)` | A player took a seat. Spawn their body here. |
| `onLeave(ctx, player, reason)` | A seat ended. Remove what they owned. `reason` is a `LeaveReason`: `left`, `dropped` (the reconnect grace ran out), `superseded` (a newer session of the same player took the seat), `revoked` or `closing`. |
| `onInput(ctx, playerId, input)` | One call per input, in each player's order, before `step`. |
| `step(ctx)` | Once per tick, after the tick's inputs. |

`player` is a `PlayerInfo`: `id` is the **seat** (an entity's `owner`, and what `emit(…, to)` takes);
`uid` is the player's stable id for this game across visits — key saves and scores by it; `name`;
`team` (`''` for none). A hook that throws costs only itself — the tick's other hooks still run —
but it is a fault (below).

`input` is an `InputData`, already cleaned by the server: `moveX`, `moveY`, `moveZ` in [-1, 1],
`yaw` and `pitch` in [-π, π), `buttons` an integer bitmask below 2^24. With a `preset`, the server
has already moved the player's first owned entity by this input when `onInput` runs; `onInput` is
where buttons become actions.

## The context

| Member | What it is |
|---|---|
| `ctx.state` | What `init` returned. |
| `ctx.tick` | The fixed-step tick, from 0. |
| `ctx.dt` | Seconds per tick (1 / tickHz). |
| `ctx.random()` | The room's seeded generator: the only randomness there is. `Math.random` is the same generator. |
| `ctx.entities` | The entities: the only state clients see. |
| `ctx.rewind` | Lag-compensated hit tests. |
| `ctx.projectiles` | Shots on a ballistic flight that every client draws from one launch (below, and [projectiles.md](projectiles.md)). |
| `ctx.emit(type, data?, to?)` | A game event to every client, or only to the seat `to`. Clients receive it with `session.on(type, handler)`. |
| `ctx.log(...values)` | A server log line, rate limited. |

`init` gets `ctx.config`, `ctx.seed`, `ctx.random()`, `ctx.entities`, `ctx.projectiles` and
`ctx.log` (no tick, no rewind, no emit yet). A projectile launch in `init` throws, and the module
does not load: launch from a hook that runs in a tick.

## Entities

Each entity is an `EntityData`: `id`, `kind`, `owner` (a seat, or `''`), `x` `y` `z`, `vx` `vy`
`vz`, `yaw`, `hp`, `flags` (an integer bitmask below 2^24), `epoch` and `data` (any JSON), plus
three projectile fields that only `ctx.projectiles.launch` writes and `update` ignores: `t0` (the
launch tick; 0 = not a projectile), `g` (its gravity) and `src` (the seat that fired it, `''` for
none). Numbers are float32 on the wire. Only fields that changed this tick go out.

The movement presets add their own fields, which the preset writes from each input and the module
may write too (a respawn, a refuel):

| Field | Preset | What it is |
|---|---|---|
| `pitch` | `firstperson` | The aim's pitch, radians, positive up. |
| `duck` | `firstperson` | 0 standing to 1 fully ducked: derive the eye height from it. |
| `mstate` | `firstperson`, `vehicle` | Movement bits: 1 on the ground, 2 ducking, 4 jump held. Write 0 on a respawn. |
| `cap` | `firstperson`, `vehicle` | A speed multiplier from 0 to 4, default 1, that only the module writes (a weapon's weight, a wound, a slow zone); a car's applies to both top speeds. |
| `spin` | `vehicle` | The car's turn rate, rad/s, positive toward +yaw. Write 0 on a respawn. |
| `fuel` | `vehicle` | The boost tank, 0 to 1, default 0. The preset only burns it: write it to refuel. |

| Call | Does |
|---|---|
| `ctx.entities.spawn({ kind, ...fields })` | Adds one and returns its id (the `id` you pass when it is free, else a fresh one). |
| `ctx.entities.get(id)` | The entity, or `undefined`. Assigning to its fields updates it. |
| `ctx.entities.update(id, patch)` | Changes several fields at once. |
| `ctx.entities.remove(id)` | Removes it. |
| `ctx.entities.ownedBy(seat)` | The first entity that seat owns: a player's body. |
| `ctx.entities.all()` | Every entity. |

**Bump `epoch` when an entity jumps** (a respawn, a teleport): clients snap to it instead of sliding
across the map. Clients predict the first entity a player owns that is not a projectile, so give
each player one body, spawn everything else (pickups, props) unowned, and launch shots with
`ctx.projectiles.launch`, never as plain entities moved in `step`.

## Lag compensation

`ctx.rewind.hitscan(origin, dir, { range, radius, kinds })` returns the nearest `{ id, dist }` along
the ray, or `null`; `ctx.rewind.overlapAt(center, radius)` returns every id within the radius. While
`onInput` handles an input whose `buttons` intersect `config.lagComp.buttons`, both test the
positions **that player saw** when they pressed it (at most 500 ms back); otherwise they test the
current positions. During that input the shooter's own entities are never its target. A shot judged
this way lands when it looked right on the shooter's screen.

`ctx.rewind.at(id)` returns the `{ x, y, z }` those tests use for one entity, and
`ctx.rewind.pose(id)` adds its `yaw` and `duck` at that same instant: `{ x, y, z, yaw, duck }`, live
outside such an input, `null` for an unknown id, a projectile or a physics body entity, `duck` 0 for
an entity that never ducks. Use it for hit zones that depend on stance: a head lower on a ducking
target, a back that faces where the target faced.

## Projectiles

A projectile's launch is written once; every client computes its flight, so it costs nothing per
tick on the wire and is drawn at the server's present. The whole guide, the client side included, is
[projectiles.md](projectiles.md).

| Call | Does |
|---|---|
| `ctx.projectiles.launch({ kind, x, y, z, vx, vy, vz, g?, hp?, flags?, data?, id? })` | Launches at the tick being stepped, `owner` `''`, and returns the id. In `onInput` the id is `<seat>.<seq>.<n>` (the one the shooter's client predicted) and `src` the seat; passing `id` there throws. Elsewhere `id` is required and `src` is `''`. An existing id is re-launched, replaced whole: a bounce. `g` is downward along −z, 0 to 1000 units/s². Throws a `RangeError`, writing nothing, past the launch budget. |
| `ctx.projectiles.at(id, tick?)` | `{ x, y, z, vx, vy, vz }` at that tick (default: this one), or `undefined` for an id that is not a projectile. |
| `ctx.projectiles.sweep(id, { kinds, radius })` | `{ id, dist }[]`, nearest first: the entities of those kinds whose sphere of `radius` the path crossed since the previous tick. The shooter's own body can be among them (a launch point inside it): skip it. Costs the number of entities of those kinds. |

Projectiles take no part in lag compensation: `ctx.rewind` skips them, and a sweep tests bodies
where they are now. The server never removes one: the module does, on a hit, at the walls or after a
maximum age. Change a flight by re-launching; `update` on its `x`…`vz` keeps the old launch tick, so
it jumps. The launches waiting to go out may hold at most 224 entities and 28 KiB of output, about a
hundred new projectiles in one tick.

## What the sandbox has, and what it refuses

The module runs with no clock, no timers, no network, no files and no shared memory. Absent:
`Date`, `SharedArrayBuffer`, `Atomics`, `WebAssembly`, `console`, `WeakRef`, `FinalizationRegistry`,
`Intl`, `setTimeout`, `setInterval`, `setImmediate`, `clearTimeout`, `clearInterval`,
`queueMicrotask`, `fetch`, `require`, `process`, `performance`. Reaching the global object
(`globalThis`) instead of `ctx` fails validation too. Everything the module needs arrives through
`ctx`.

Its output is checked every tick, and each of these is a **fault**:

- a hook that throws;
- a number that is not finite, or past 1e9 in magnitude;
- at most 256 entity updates, and at most 256 removals, in one tick — more is a fault;
- at most 64 events in one tick;
- at most 1024 entities in the room at once;
- one event at most 16 KiB as JSON;
- entity `data` at most 256 characters as JSON;
- an id that is empty, longer than 64 characters, or `__proto__`, `constructor` or `prototype`.

The third fault ends the room (close code 4501, and every player sees `disconnect`). So does a tick
that runs past its deadline or a module whose CPU or memory use stays over budget. Keep per-tick
work small, bounded and the same every run: `validate` holds it to a local CPU budget so a module
that passes here fits Genex's servers.

## Determinism

The same seed and the same inputs must give the same room. That is what makes a validation report
mean something and what `replay` checks. Rules that keep it true:

- randomness only from `ctx.random()`;
- iterate in a fixed order (`Object.keys` of objects you built in a fixed order, arrays, the entity
  list) and never depend on timing;
- round what you store with `Math.fround` when it comes from `Math.sin`, `Math.cos`, `Math.atan2` or
  `Math.exp`: their last bit may differ between Genex's servers and the local one, and float32
  hides that difference, as the wire does.
