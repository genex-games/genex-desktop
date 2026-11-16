# Projectiles

A projectile is an entity on a fixed ballistic flight: a start point, a velocity and an optional
gravity. The room module writes the launch **once**; every client works out where the projectile is
at any instant from that launch. Other players' projectiles are therefore drawn where the server has
them now, not a render delay (100 ms or more) behind like bodies, and your own is drawn from the
frame you fire it. A flying projectile costs nothing per tick on the wire: only its launch, a
re-launch and its removal go out.

Projectiles need `@genex-ai/multiplayer` 0.17.4 or newer. If `session.predictProjectile` does not
exist after `npm i @genex-ai/multiplayer@latest`, the release is not out yet: say so and stop; do
not move projectile entities by hand every tick instead. Predicted hits
([below](#show-the-hit-at-once-predicted-hits)) need 0.17.14 or newer: while
`session.onPredictedHit` does not exist, show hits from the module's events only.

A complete room and client to start from: the bolt arena, the second template in
[room-template.md](room-template.md).

## Projectile or hitscan

| Use | When | How it is judged | The shooter's hit marker, at once |
|---|---|---|---|
| Hitscan, `ctx.rewind.hitscan` | The shot is instant: rifles, lasers, a sniper. It must land where the crosshair was. | Lag-compensated (with `config.lagComp`): against where the shooter saw the targets. | `session.predictHitscan` |
| A projectile, `ctx.projectiles` | Players can see the shot travel and dodge it: bolts, rockets, grenades, arrows, dodgeballs, fireballs. | Against where the targets are on the server now. No lag compensation. | `hits` in `session.predictProjectile` |

A projectile is fair without lag compensation because the target sees it coming at the server's
present and can step aside. That also means a shooter must lead a moving target: the bodies they see
are their render delay in the past, 100 ms or more. Keep projectiles slow enough to see (a few to a
few tens of units per second); a shot that should feel instant is hitscan.

## The room module

### `ctx.projectiles.launch(init)`

```js
const id = ctx.projectiles.launch({ kind: "bolt", x, y, z: 0, vx, vy, vz: 0, g: 0 });
```

Writes a projectile whose flight starts at the tick being stepped and returns its id. `kind`, `x`,
`y`, `z`, `vx`, `vy` and `vz` are required (finite, at most 1e9 in magnitude); `g` is the downward
pull along −z in units/s², from 0 to 1000 (default 0, a straight line); `hp`, `flags` and `data` are
optional and work as on any entity. The server stores every number as float32. `owner` is always
`''`: a projectile is never a player's predicted body.

- **In `onInput`** the projectile belongs to that input: its `src` is the shooter's seat and its id
  is `<seat>.<seq>.<n>`, the firing input's sequence number and the launch's index within that input
  from 0. This is the id the shooter's client predicted it under, so never pass `id` here — it is
  refused (a `TypeError`).
- **In `step`, `onJoin` or `onLeave`** pass an `id` yourself; `src` is `''` (a server projectile: a
  turret, a trap, a bounce).
- **Never in `init`**: a launch there throws. `init` steps no tick.
- **The same id again re-launches it**: the new launch replaces the old one whole, from the tick being
  stepped (pass `hp`, `flags` and `data` again to keep them). That is how a projectile bounces or
  turns. A re-launch from `step` makes it a server projectile (`src` becomes `''`), so keep who
  fired it in `ctx.state` if you score with it.
- **Change a flight only by re-launching.** Writing `x`…`vz` with `ctx.entities.update` moves the
  start point but keeps the old launch tick, so the projectile jumps. `t0`, `g` and `src` are
  read-only (`ctx.entities.update` ignores them). `hp`, `flags` and `data` update normally.

### `ctx.projectiles.at(id, tick?)`

Where the projectile is at `tick` (default: the tick being stepped): `{ x, y, z, vx, vy, vz }`, or
`undefined` when `id` is not a projectile. Use it for walls, the floor and bounds:

```js
const at = ctx.projectiles.at(id);
if (Math.abs(at.x) > ARENA || Math.abs(at.y) > ARENA || at.z < 0) ctx.entities.remove(id);
```

### `ctx.projectiles.sweep(id, { kinds, radius })`

The entities of those `kinds` whose sphere of `radius` the projectile's path crossed between the
previous tick and this one, nearest first, as `{ id, dist }` (`dist`: how far along that path, from
its point at the previous tick). A fast projectile never tunnels through a body between two ticks.

- The projectile is a point: `radius` is the target's radius **plus** the projectile's.
- Swept in `step`, bodies are tested where they stand this tick, after this tick's inputs moved them.
- **The shooter's own body comes back too** when the projectile starts inside it (launched from the
  body's centre, as the templates do). Skip hits whose `owner` is the shooter.
- When `step` sweeps a projectile this tick's input launched, its path is just its start point: a
  target standing inside the muzzle is hit before any client sees the shot (a point-blank hit).
- Cost is the number of entities of the kinds you ask for. A couple of hundred projectiles each
  swept against the players fit a tick; hundreds swept against each other do not. Name only the
  kinds that can be hit.

### Removing them is the module's job

The server never ages a projectile out. Remove it on a hit, past the arena, below the floor and after
a maximum age, or the room fills up: a tick that would leave more than 1024 entities is a fault.
Keep the live projectiles in `ctx.state` (an array, in launch order) and walk that list in `step`,
so the order is fixed and every replay is identical.

```js
step(ctx) {
  ctx.state.shots = ctx.state.shots.filter((shot) => fly(ctx, shot)); // false once it is gone
}
```

### Limits

- Projectiles are entities: they count against the 1024 per room, and their launches and removals
  against the 256 updates and 256 removals per tick.
- Launches still waiting to go out may hold at most 224 entities and 28 KiB of output — about a
  hundred new projectiles in one tick. A launch past that throws a `RangeError` and writes nothing.
  Uncaught, it is a fault, and the tick's changes go out with the next tick. A shotgun or a burst
  catches it:

  ```js
  for (let i = 0; i < PELLETS; i++) {
    try { ctx.projectiles.launch(pellet(i)); } catch (e) { if (e instanceof RangeError) break; throw e; }
  }
  ```

- Cap the fire rate per seat with a cooldown in ticks, as the template does. It is what keeps the
  number of live projectiles, and of hit events per tick (at most 64), bounded.

## The client

### Fire: predict while staging the input

```ts
if (wantsToFire && !armed) {
  session.input.buttons = FIRE;
  session.predictProjectile({ kind: "bolt", x: me.x, y: me.y, z: 0, vx, vy, vz: 0, g: 0 });
  armed = true; // staged: predict nothing more until it is sent
}
const sent = session.frame(now);
if (armed && sent > 0) {
  session.input.buttons = 0; // only the input the prediction was made for fires
  armed = false;
}
```

`predictProjectile` must run **before the `frame()` that sends the firing input**, once per
projectile the module will launch for it, in the same order. It returns the id the module's launch
will get; the projectile is in `session.entities()` that same frame. When the server's projectile of
that id arrives, the same entry keeps flying from where the prediction was, so a mesh keyed by id
never jumps back.

- **Predict the module's numbers**: the same start point, speed, gravity and aim. Round the aim with
  `Math.fround` before you send it and before you use it, as the server stores it. The module
  launches from the body after this input moved it, the client from its drawn body; a shooter firing
  on the run sees a small nudge when the server's projectile takes over.
- **Mirror the cooldown, with slack.** A prediction the module refuses is drawn and then vanishes.
  Count inputs with `session.telemetry.inputsSent` and wait a few inputs longer than the module's
  cooldown in ticks.
- Predict only your own shots. Never create, move or remove projectile entities on the client.

### Draw them from `session.entities()`

An entity with `t0 > 0` is a projectile. Its `x`, `y`, `z` (and `vx`, `vy`, `vz`) are already where
it is this frame: set the mesh there every frame and do not smooth, lerp or extrapolate it.

- `e.src === session.id` is your own shot; `''` is a server projectile, or one the server re-launched
  (a bounce). A projectile is never `session.me()`.
- When an id leaves `session.entities()`, remove its mesh: it hit something, left the arena or was
  refused.
- **A refused or point-blank shot**: the prediction disappears once the server has handled the input
  that fired it (at the latest after max(2·RTT, 600 ms)). A refusal (cooldown, dead shooter) and a
  point-blank hit look the same from the state; the module's own events say which, so draw
  damage and kills only from those events and from `hp`. A hit marker may come earlier, from a
  predicted hit (below).
- `session.telemetry` counts `projectilesPredicted`, `projectilesConfirmed` and
  `projectilesRejected`; `lastProjectileLeadMs` is how much later the server launched your latest
  confirmed shot than you predicted it (roughly the one-way latency plus up to a tick).

### Show the hit at once (predicted hits)

A hit marker that waits for the module's event shows a round trip late. The session can test your
own shot against the bodies **as it draws them**, by the module's own rule, and tell the game the
frame the shot lands. Nothing is sent, and the server still decides every hit: a predicted hit is a
marker to show early and, now and then, to take back.

```ts
/** What a bolt can hit: the kinds and the radius the module passes ctx.projectiles.sweep. */
const BOLT_HITS = { kinds: ["player"], radius: 0.8 };

session.onPredictedHit((hit) => showMarker(hit.id, hit.x, hit.y, hit.z)); // once, the frame it lands on your screen
session.onHitSettled((hit, confirmed) => {
  if (!confirmed) hideMarker(hit.id); // the server did not hurt the target: take it back
});

// while staging the input that fires, as in "Fire" above:
session.predictProjectile({ kind: "bolt", x: me.x, y: me.y, z: 0, vx, vy, vz: 0, g: 0, hits: BOLT_HITS });
```

- **`hits` is the module's sweep**: the same `kinds` and the same `radius` the module passes
  `ctx.projectiles.sweep` for this projectile. Each `frame()` tests the path from where the last
  frame drew your projectile to where this one does; the nearest target is its hit, one per
  projectile. Leave `hits` out and the projectile predicts none.
- **The targets** are the entities of those kinds where this frame draws them: never a projectile,
  a physics body or anything your own seat owns, so a bolt launched inside your body does not hit
  you.
- **Only kinds and radius are known.** A target the module skips for a reason of its own (a
  teammate, a shield) is still predicted, and cancelled a moment later. Look at
  `session.entity(hit.target)` in the handler and show no marker for a target the module would skip.
- **Only while the projectile is yours.** Once the server re-launches it as its own (a bounce from
  `step`), it predicts no hit: that hit shows from the module's event.
- **A `PredictedHit`** is `{ id, kind, target, x, y, z, dist }`: `id` is the projectile's id, `kind`
  is `"projectile"` or `"hitscan"`, `target` is the entity hit, and `x y z` is where the path
  enters the target's sphere. Each is told once to `onPredictedHit` and settled once to
  `onHitSettled`; both return an unsubscribe.
- **The target's health settles it.** Lower `hp`, a new `epoch` or a removed entity means the
  target was hurt. A projectile's hit is confirmed by the first state that shows that. Anything
  still unsettled is cancelled after max(2·RTT, 600 ms), and at once when the connection drops. So
  a module that lowers `hp` on every hit (and bumps `epoch` on a respawn) needs nothing more.
- **A module that reports hits another way** (an event, a shield with no `hp`) settles them itself:
  add `settle: "manual"` to `hits`, and call `session.confirmHit(id)` or `session.cancelHit(id)`
  from the module's own event, which must carry the projectile's id. Only the time limit settles a
  manual hit otherwise.
- **Confirmed means hurt, not hurt by you.** A target someone else hurts in the same moment also
  confirms the hit. Take score, damage numbers and kills from the module's events and `hp`, never
  from a predicted hit.
- `session.telemetry` counts `hitsPredicted`, `hitsConfirmed` and `hitsCancelled`.

**A hitscan** is predicted with one call, made while staging the input that fires:

```ts
if (me && wantsToFire && !armed) {
  const yaw = session.input.yaw;
  session.input.buttons = FIRE;
  // What the module gives ctx.rewind.hitscan: its origin, direction, range, radius and kinds.
  session.predictHitscan([me.x, me.y, 0], [Math.cos(yaw), Math.sin(yaw), 0], { range: RANGE, radius: RADIUS, kinds: ["player"] });
  armed = true; // staged: predict nothing more until it is sent
}
const sent = session.frame(now);
if (armed && sent > 0) {
  session.input.buttons = 0; // only the input the prediction was made for fires
  armed = false;
}
```

- The origin and the direction are `[x, y, z]` arrays in the server's axes. It returns the
  `PredictedHit`, or `null` for a miss or while the socket is down; a hit also reaches
  `onPredictedHit`. Its `id` is `<seat>.<seq>.h<n>`: the firing input's sequence and that input's
  `predictHitscan` calls from 0.
- The module judges that shot against the same drawn positions (lag compensation, with
  `config.lagComp`), so the two agree but for the link's noise. The first state that covers the
  firing input decides: the target hurt confirms, unhurt cancels. With `settle: "manual"` in the
  options, keep the returned hit's `id` and settle it from the module's event for that shot.
- **Mirror the module's cooldown, with slack**, as for a projectile: a hit predicted for an input
  the module does not fire on is cancelled.
- **It knows no walls**, like `ctx.rewind.hitscan`. Where the module cuts the shot at a wall with
  `ctx.world.ray`, cut `range` to the client's own wall distance along the aim before predicting.

### Axes in three.js

The server's ground is x/y and +z is up; `yaw` 0 points along +x. In three.js y is up:

```ts
mesh.position.set(e.x, e.z + HEIGHT, e.y); // server (x, y, z) → three (x, z, y)
mesh.lookAt(e.x + e.vx, e.z + HEIGHT + e.vz, e.y + e.vy); // point a rocket along its flight
```

A body turns by `-yaw` around three's y axis. A projectile launched at `z: 0` and drawn at a fixed
`HEIGHT` keeps the hit test on the ground plane; a lob launches with `vz > 0` and `g > 0` and lands
when `ctx.projectiles.at(id).z < 0`.

## Every client must support projectiles

A client that does not implement projectiles draws each one frozen where it was launched: the server
writes the launch once and never moves it. Every client in a room whose module launches projectiles
must support them:

- Ship `@genex-ai/multiplayer` 0.17.4 or newer in the same build as the first module that launches.
- A native build (Unity, Godot, Unreal, Rust) in the same room supports them only once its Genex
  multiplayer SDK passes the projectile conformance checks; until then, keep that build out of rooms
  with projectiles.

## Before calling it done

1. `validate` passes, and its fuzz players fire (bind the main shot to button bit 1, the bit the fuzz
   and the local bots press most).
2. At `--latency 75`, your shot leaves the instant you click and flies on without a jump; another
   player's shots fly smoothly toward you, not a render delay late.
3. `session.telemetry.projectilesRejected` stays near 0 while you fire steadily (a rising count means
   the client predicts shots the module refuses).
4. Every projectile is removed: a few minutes of play leave the entity count flat.
5. With predicted hits: the marker shows the frame your shot reaches a body on your screen, and
   `session.telemetry.hitsCancelled` stays far below `hitsConfirmed` (a rising count means `hits`
   or the hitscan options are not the module's).
