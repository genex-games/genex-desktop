# Server physics: crates, balls, doors

A room module can ask Genex's servers to simulate rigid bodies — crates that topple, a ball that
bounces off cars, doors on hinges — with the Genex Physics core. The server alone steps them. Every
client only **draws** them: at the server's present, smoothed when a correction arrives. A client
never moves a body itself.

**New, and not on Genex's servers until the release that carries the physics core is deployed.**
`genex-authority-dev validate` runs a physics module on that same core; a validator without it fails
`physics_unavailable` (update `@genex-ai/authority-dev`). Until the servers run it, a game that must
ship today keeps to presets and projectiles ([presets.md](presets.md),
[projectiles.md](projectiles.md)).

Reach for physics when things must collide with each other: a stack, a pile, a ball between cars
and walls, a door a player shoves. A player's own movement stays a preset, so it is predicted and
feels instant; a lone flying shot stays a projectile.

## Asking for it

```js
config: {
  tickHz: 60,
  preset: { name: "vehicle", params: { radius: 50, height: 36 } },
  physics: { subscribe: ["ball"], player: { events: true } },
},
```

`physics: true` takes every default. The keys:

| Key | Default | What it is |
|---|---|---|
| `lengthUnit` | 100 with `vehicle`, 39.37 with `firstperson`, else 1 | Your units per metre. |
| `gravity` | The preset's `gravity`, else 9.81 × `lengthUnit` | Units/s² along −z. |
| `iterations` | 4 | Solver iterations, 1 to 16. |
| `limits` | The defaults below | Lower any limit; higher ones are clamped. |
| `subscribe` | `[]` | Up to 8 physics kinds whose body states `ctx.physics.body(key)` returns. |
| `player` | `{ events: false }` | `events: true` reports the players' hulls touching bodies. A `topdown` room also gives `radius` and `height` here, or its players have no hulls. |

Any other key is a bad config. A room's limits: 512 bodies, 64 joints, 16 bodies with continuous
collision (`ccd`), 64 queries a tick, 64 events a tick, at most 256 commands a tick.

## A body is an entity

Every body belongs to one entity with the same id. Spawn the entity, then its body:

```js
init(ctx) {
  ctx.entities.spawn({ id: "ball", kind: "ball", z: 92 });
  ctx.physics.spawn({
    key: "ball", kind: "ball", type: "dynamic", ccd: true,
    pose: { p: { x: 0, y: 0, z: 92 }, q: { x: 0, y: 0, z: 0, w: 1 } },
    colliders: [{ key: "ball", shape: { kind: "sphere", radius: 92 }, restitution: 0.65 }],
  });
  return {};
},
```

- **Ids**: 1 to 64 of `A-Z a-z 0-9 _ . : -`, never starting `static:`. Ids the room makes up
  (`e1`, `e2`, …) qualify. A body's `kind` (`"ball"`, `"crate"`) is its own, 1 to 32 of the same.
- **The server writes a body entity's `x y z`, orientation and velocities.** Your module must never
  write those fields on a body entity: the write throws. Every other field is yours: `kind`,
  `owner`, `hp`, `data`, `epoch`.
- **A teleport** (a kickoff, a respawn): `ctx.physics.setPose(key, pose, { resetVelocity: true, wake: true })`
  and bump the entity's `epoch` in the same tick, so every client snaps instead of sliding there.
- **Removing** the entity removes its body. `ctx.physics.remove(key)` removes only the body.
- A player's own entity never gets a body, and a projectile never does.

Vectors are `{ x, y, z }` and rotations `{ x, y, z, w }`. Shapes: `box` (`half`), `sphere`
(`radius`), `capsule` (`halfHeight`, `radius`, `axis`), `hull` (`points`), `trimesh` and
`heightfield` (fixed bodies only).

**Put a body's origin at its centre of mass.** Clients extrapolate a body's origin by its centre's
velocity, so a spinning body whose colliders are offset from its origin is drawn off until the next
update. Swing a door by posing its middle around the hinge, or join it to the world with a hinge
joint, rather than giving it an offset collider.

## Commands, queries, events

Commands take effect in this tick's step, and every hook may call them (`init` too):

| Call | Does |
|---|---|
| `ctx.physics.spawn(desc)` | Adds a body to an existing entity. |
| `ctx.physics.remove(key)` | Removes the body; the entity stays. |
| `ctx.physics.impulse(key, j, at?)` | A push, in mass × units/s. |
| `ctx.physics.setVelocity(key, linvel?, angvel?)` | Sets a dynamic body's velocities. |
| `ctx.physics.setPose(key, pose, options?)` | Moves it (bump the epoch with it). |
| `ctx.physics.setNextKinematicPose(key, pose)` | Where a kinematic body (a lift, a door you drive) is at the end of this tick. |
| `ctx.physics.addJoint(desc)` / `ctx.physics.removeJoint(key)` | Hinges, sliders, ropes; `b: null` is the world. |
| `ctx.physics.setMotor(jointKey, motor)` | Drives a joint. |
| `ctx.physics.areaPush(center, radius, strength, falloff, groups?)` | An explosion. |
| `ctx.physics.wake(key)` / `ctx.physics.sleep(key)` | |

Each returns its command number, or `'invalid-key'` for a bad id. A command the core refuses
changes nothing and is listed next tick in `ctx.physics.refused` (`{ n, code }`). It is never a
fault.

Queries (`ctx.physics.ray`, `ctx.physics.shapeCast`, `ctx.physics.overlap`) return an index; the
answer is `ctx.physics.answers[index]` on the **next** tick. Queries throw in `init`.

What the last step did: `ctx.physics.events` (`contactBegin`, `contactEnd`, `triggerEnter`,
`triggerExit`, for colliders with `events: true`), `ctx.physics.escaped` (ids whose bodies left the
world; the server removed those entities), and `ctx.physics.body(key)` (`{ p, q, v, w, sleeping }`
for a subscribed kind).

## Players push bodies

With `firstperson` or `vehicle` (or `topdown` with `player.radius` and `player.height`), each
player's own entity carries a hull the server moves with it. Hulls push dynamic bodies; bodies never
block a player, who still moves only through the preset's world. With `player: { events: true }`,
`contactBegin` events name the player's entity id, so a module sees who touched the ball:

```js
for (const ev of ctx.physics.events) {
  if (ev.kind !== "contactBegin" || (ev.a !== "ball" && ev.b !== "ball")) continue;
  const car = ctx.entities.get(ev.a === "ball" ? ev.b : ev.a);
  if (car && car.kind === "car") ctx.state.lastTouch = car.owner;
}
```

## Drawing bodies on the client

Nothing to set up: `connectAuthority` joins physics rooms and draws bodies. In
`session.entities()`, a body has `body: true`, its orientation in `qx qy qz qw` (z up) and `sleep`.
Its `x y z` are already where the server has it now: extrapolated past the last update, never
100 ms behind like other players. A correction eases out over about 100 ms, and a jump over one
metre (or an `epoch` bump) snaps. With three.js, z up becomes y up for both:

```ts
mesh.position.set(e.x, e.z, -e.y);
if (e.body) mesh.quaternion.set(e.qx, e.qz, -e.qy, e.qw);
else mesh.rotation.set(0, e.yaw, 0);
```

A body far from the player may update less often: each player gets the 100 nearest awake bodies
every update and the rest in turns. A body that has not updated for a while is held where it was.

## Costs and limits

The server measures physics time apart from your module's. A tick over 8 ms per 1/60 s of game
time, or an average over 1 ms per 1/60 s, is a strike; the third ends the room. At 120 Hz a tick
gets a 60 Hz tick's 8 ms and 1 ms average, and the room counts twice toward the server's capacity. Asleep bodies cost
almost nothing, so let piles settle: `canSleep` is on by default.

## Testing

`npx genex-authority-dev validate --module server/room.js` fuzzes a physics module like any other,
on the physics core. Play it at a real ping (`--latency 75`) and judge it there, not at zero: a
fast ball drawn from the server is a little behind the moment a car hits it, by about the one-way
latency, and one that bounces off a wall is drawn a little into it before it comes back.
