# Movement presets and prediction

A **preset** is movement the server simulates and every client replays identically, so a player's
own body moves the instant they press a key and the server's correction, when it comes, is
invisible. Name one in the module's `config.preset` and `connectAuthority` predicts with it on its
own; there is nothing to wire on the client but the input (and, for two of them, the world).

Presets are append-only by name. There are three:

| The game | Preset | Ask for |
|---|---|---|
| Seen from above: a twin-stick arena, a top-down shooter, a board game with moving pieces | `topdown` | `tickHz: 30` |
| A character on foot through a level: a first-person or over-the-shoulder shooter, with jumping, ducking, stairs and ramps | `firstperson` | `tickHz: 60` |
| Cars: car football, a derby, an arena brawl, a track of flats and ramps | `vehicle` | `tickHz: 60` |
| Anything else: flying, swimming, climbing, a double jump, a boat, a hovercraft | your own step ([below](#movement-of-your-own)) | |

Pick a preset whenever one fits: each is ported to every engine and held to the same conformance
vectors, so prediction matches on every client. `firstperson` and `vehicle` need `@genex-ai/multiplayer`
0.17.4 or newer.

## `topdown`

Planar movement on the server's x/y plane, with an aim angle.

| Parameter | Range | Default |
|---|---|---|
| `speed` | 0 to 1000 world units per second | 6 |
| `arena` | above 0, up to 1e6: bodies stay within [-arena, arena] on x and y | 20 |

```ts
config: { tickHz: 30, preset: { name: "topdown", params: { speed: 6, arena: 20 } } }
```

Each input moves the player's first owned entity: `moveX` and `moveY` are the stick (a diagonal
is scaled back to length 1), `yaw` is the aim in radians with 0 along +x, and the body is kept
inside the arena. The server applies it before `onInput` sees the input, so `onInput` reads the
moved body. An unknown or out-of-range parameter is refused when the module loads.

In three.js, draw the server's `x` as `x` and its `y` as `z`, and turn the body by `-yaw` around
three's y axis.

The reference implementation is exported from `@genex-ai/multiplayer/authority` as `stepTopdown`
(with `resolveTopdownParams`, `TOPDOWN_DEFAULTS` and `PRESET_MAX_DT_S`); the session already runs it
for you.

## `firstperson`

Source-engine-style movement: friction, ground and air acceleration (air-strafing
works), a jump, ducking and crouch-jumping, a free step up ledges, staying on the ground down slopes
and stairs, and a hull that slides along what it hits. The body is an upright box whose feet are at
`(x, y, z)`, moving through a fixed world of boxes and ramps ([the collision world](#the-collision-world-firstperson-and-vehicle)).

```js
export default defineRoom({
  contract: 1,
  config: { tickHz: 60, maxPlayers: 10, preset: { name: "firstperson", params: {} }, lagComp: { buttons: FIRE } },
  world: WORLD, // the same object the client hands its session
  // init, onJoin, onLeave, onInput, step …
});
```

**Units.** The defaults are the Source engine's, in Source units of about an inch: a hull 32 wide
and 72 tall (54 ducked), a run of 250 units/s, gravity 800. The easy way to a game in metres is to
keep these on the server and scale the drawing (`0.0254` metres a unit). A game that sets its own
units sets every distance, speed and acceleration below, `skin` and `groundSnap` included.

| Parameter | Default | Range | What it does |
|---|---|---|---|
| `maxSpeed` | 250 | 0 to 10000 | Run speed, units/s, before the body's `cap` |
| `walkSpeed` | 0.52 | 0 to 1 | Speed multiplier while walk is held |
| `crouchSpeed` | 0.34 | 0 to 1 | Speed multiplier while ducking (wins over walk) |
| `accelerate` | 5.5 | 0 to 1000 | Ground acceleration |
| `airAccelerate` | 12 | 0 to 1000 | Air acceleration |
| `airMaxWishSpeed` | 30 | 0 to 10000 | Air wish speed cap: what makes air-strafing work |
| `friction` | 5.2 | 0 to 1000 | Ground friction |
| `stopSpeed` | 80 | 0 to 10000 | Below this speed friction acts as if at this speed |
| `gravity` | 800 | 0 to 100000 | Units/s² along −z |
| `jumpImpulse` | 301.993 | 0 to 100000 | The upward speed a jump sets |
| `maxVelocity` | 3500 | 0 to 100000 | Each velocity axis is held within ±this |
| `radius` | 16 | above 0, to 10000 | Half the side of the hull's square footprint |
| `standHeight` | 72 | above 0, to 10000 | Hull height standing |
| `crouchHeight` | 54 | above 0, to 10000 | Hull height fully ducked |
| `duckTime` | 0.4 | above 0, to 100 | Seconds to duck fully, and to stand back up |
| `stepHeight` | 18 | 0 to 10000 | Highest ledge walked up without a jump |
| `standable` | 0.7 | 0 to 1 | Least upward share of a ramp's normal that can be stood on (0.7 is about 45°) |
| `groundTrace` | 2.5 | 0 to 10000 | How far below the feet ground is found |
| `groundSnap` | 1 | 0 to 10000 | How far above the feet ground is found |
| `skin` | 0.03 | 0 to 100 | Clearance kept from a surface |
| `pitchLimit` | 1.5533430576324463 | 0 to π/2 | Largest look up or down, radians (89°) |
| `jumpBit`, `duckBit`, `walkBit` | 1, 2, 4 | integer below 2^24 | Which `buttons` bits jump, duck and walk; 0 turns one off |
| `substeps` | 2 | integer 1 to 8 | Sub-steps per input ([the CPU budget](#sub-steps-and-the-cpu-budget)) |
| `world` | the empty world's hash | | Written by the sandbox from the module's `world`: leave it out |

An unknown parameter, or one out of its range, is refused when the module loads.

**Input.** `moveX` and `moveY` are the direction the player wants to move **in the world's axes**,
not the camera's: turn the keys by the view's yaw before sending them (the step itself has no
trigonometry). `yaw` and `pitch` are the view's aim, stored on the body for drawing and for the
module's shots. The preset's bits are on `buttons`; give the game's own buttons (fire, reload,
switch weapon) other bits, 8 and up.

```ts
const forward = (keys.has("KeyW") ? 1 : 0) - (keys.has("KeyS") ? 1 : 0);
const right = (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0);
session.input.moveX = forward * Math.cos(viewYaw) + right * Math.sin(viewYaw);
session.input.moveY = forward * Math.sin(viewYaw) - right * Math.cos(viewYaw);
session.input.yaw = viewYaw; // +yaw turns left: the mouse moving right is viewYaw -= dx * sensitivity
session.input.pitch = viewPitch; // positive looks up; the step holds it within ±pitchLimit
session.input.buttons = (jump ? 1 : 0) | (duck ? 2 : 0) | (walk ? 4 : 0) | (firing ? FIRE : 0);
```

A jump fires once per press: holding the key does not hop again on landing.

**The body.** On top of `x y z vx vy vz yaw`, the preset writes `pitch` (the aim), `duck` (0 standing
to 1 fully ducked) and `mstate` (bits: 1 on the ground, 2 ducking, 4 jump held), and reads `cap`: a
speed multiplier from 0 to 4 (default 1) that the module writes, for a weapon's weight or a wound. It
limits how fast the body can go, never how hard it pushes, so a slowed player still overcomes
friction. A `cap` written in `onInput` applies from the next input. The eye height is the game's:
The Source engine's is `64 - 18 * duck` over the feet. A respawn writes the new spot with
`vx: 0, vy: 0, vz: 0, duck: 0, mstate: 0` and bumps `epoch`.

**What it does not do.** Players pass through each other: the preset collides only with the world.
The world is fixed for the room's life, so a door, a lift or a crate that moves is the module's own
rule, not a solid. And `ctx.rewind.hitscan` does not know the world either: test the shot against
the same boxes yourself (a ray against each box) and refuse a hit behind a wall. The shot leaves
from the eye along `(cos(pitch) * cos(yaw), cos(pitch) * sin(yaw), sin(pitch))`.

**Tick rate.** Ask for `tickHz: 60`. Air-strafing turns the wish direction once per input, so the
speed a strafe gains grows with the input rate: at 30 Hz a perfect strafer gains less than half of
what they gain at 60 (sub-steps do not change it). A jump pressed on an input whose last sub-step
lands is lost, as on a Source server's tick.

## `vehicle`

An arcade car on Rocket League's ground and air handling, kept level (it never pitches, rolls or
flips): throttle, braking and coasting; boost from a fuel tank; grip that turns the velocity with the
heading, and a drift button that lets the tail slide; a turn rate that grows with speed and mirrors
in reverse; a jump, and steering in the air. It drives the same hull through the same world as
`firstperson`.

```js
export default defineRoom({
  contract: 1,
  config: { tickHz: 60, maxPlayers: 4, preset: { name: "vehicle", params: { radius: 50, height: 36 } } },
  world: WORLD, // the same object the client hands its session
  // init, onJoin, onLeave, onInput, step …
});
```

**Units.** About a centimetre, Rocket League's own scale: a car about 120 long, 1410 units/s on the
throttle and 2300 with boost, gravity 650. The hull does not turn with the heading: its square
footprint, 100 across by default, stands in for a car about 118 long and 84 wide. A game in other
units sets every distance, speed and acceleration, `skin` included.

| Parameter | Default | Range | What it does |
|---|---|---|---|
| `maxSpeed` | 1410 | 0 to 100000 | Top speed on the throttle, units/s, before `cap` |
| `accel` | 1000 | 0 to 100000 | Throttle acceleration, units/s² |
| `brake` | 3500 | 0 to 100000 | Deceleration while the throttle opposes the motion |
| `coast` | 525 | 0 to 100000 | Deceleration with no throttle, and back down to the throttle's top speed after a boost |
| `boostAccel` | 1000 | 0 to 100000 | Boost's push along the heading, on top of the throttle's |
| `boostMaxSpeed` | 2300 | 0 to 100000 | Top speed under boost, before `cap` |
| `boostBurn` | 0.3333333432674408 | 0 to 1000 | Fuel burned per second of boost: a full tank (1) lasts 3 s |
| `grip` | 6000 | 0 to 100000 | How fast sideways speed is lost on the ground, units/s² |
| `driftGrip` | 1500 | 0 to 100000 | The same, while drift is held |
| `turnRate` | 2.2 | 0 to 100 | Turn rate at full steer on the ground, rad/s, at or above `turnSpeed` |
| `turnSpeed` | 400 | above 0, to 100000 | The forward speed where the full turn rate is reached; below it the rate scales with speed |
| `spinAccel` | 30 | 0 to 10000 | How fast the turn rate follows the steering on the ground, rad/s² |
| `airTurnRate` | 5.5 | 0 to 100 | Turn rate at full steer in the air, rad/s |
| `airSpinAccel` | 9 | 0 to 10000 | How fast the turn rate follows the steering in the air, rad/s² |
| `gravity` | 650 | 0 to 100000 | Units/s² along −z |
| `jumpImpulse` | 450 | 0 to 100000 | The upward speed a jump sets |
| `maxVelocity` | 6000 | 0 to 100000 | Each velocity axis is held within ±this |
| `radius` | 50 | above 0, to 10000 | Half the side of the hull's square footprint |
| `height` | 36 | above 0, to 10000 | Hull height |
| `stepHeight` | 8 | 0 to 10000 | Highest kerb driven up without a jump, and the deepest drop a sub-step follows down |
| `standable` | 0.7 | 0 to 1 | Least upward share of a ramp's normal that can be driven on (0.7 is about 45°) |
| `groundTrace` | 4 | 0 to 10000 | How far below the hull ground is found |
| `groundSnap` | 2 | 0 to 10000 | How far above the hull's base ground is found |
| `skin` | 0.03 | 0 to 100 | Clearance kept from a surface |
| `jumpBit`, `boostBit`, `driftBit` | 1, 2, 4 | integer below 2^24 | Which `buttons` bits jump, boost and drift; 0 turns one off |
| `substeps` | 2 | integer 1 to 8 | Sub-steps per input ([the CPU budget](#sub-steps-and-the-cpu-budget)) |
| `world` | the empty world's hash | | Written by the sandbox from the module's `world`: leave it out |

**Input.** The heading is the car's own state, not input: `yaw`, `pitch` and `moveZ` are unused.

```ts
session.input.moveY = (keys.has("KeyW") ? 1 : 0) - (keys.has("KeyS") ? 1 : 0); // throttle: below 0 brakes, then reverses
session.input.moveX = (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0); // steer: +1 turns RIGHT
session.input.buttons = (keys.has("Space") ? 1 : 0) | (keys.has("ShiftLeft") ? 2 : 0) | (keys.has("KeyQ") ? 4 : 0); // jump, boost, drift
```

`moveX = +1` turns the car right, toward −yaw (with z up, +yaw is counterclockwise seen from
above): the steer-right key sends +1, like every other right input. A stick sends its x as is.

**How it drives.** Boost always drives forward at full throttle, burns a full tank in 3 seconds and
works in the air along the level heading. The preset only burns fuel: the module gives it (a boost
pad, a kickoff, a slow refill) by writing `fuel`. A standing car does not turn: the turn rate grows
with speed up to `turnSpeed`. Walls do not bounce: a car meeting one head-on stops in one sub-step,
and one scraping along a wall with its nose turned into it slows (past about 10° the throttle can
no longer hold its speed; parallel to the wall it recovers). A ramp the car can drive on (up to
about 45° with the default `standable`) is climbed at its flat-ground speed; a steeper one is a
wall. Downhill the car keeps to the road only while one sub-step's drop stays under `stepHeight`:
at 60 Hz with 2 sub-steps that is a slope of about 23° at top boost speed, so a steep downhill or a
crest launches it. Cars pass through each other: a bump or a demolition is the module's own rule,
and a velocity the module writes into a car shows on its driver's screen as a correction. A car the
module pushes into a wall, a ramp or the floor is pushed back out on its next step, through the
solid's nearest face (never its bottom, nor a top another solid sits on, such as a wall's top under
the ceiling); keep a push under half a wall's thickness plus the car's radius, or that nearest face
is the far one.

**The body.** On top of `x y z vx vy vz yaw` (the heading), the preset writes `spin` (the turn rate,
rad/s, positive toward +yaw: for wheels and skid marks), `fuel` (the tank, 0 to 1) and `mstate`
(bits: 1 on the ground, 4 jump held), and reads `cap`, a multiplier of both top speeds from 0 to 4
(default 1) that the module writes. It never writes `pitch` or `duck`. A respawn or a kickoff writes
the new spot and heading with `vx: 0, vy: 0, vz: 0, spin: 0, mstate: 0`, the fuel it starts with,
and bumps `epoch`.

**Tick rate.** Ask for `tickHz: 60`. The turn, the grip and the heading's turn of the velocity are
integrated once per sub-step, so another `tickHz` or `substeps` is a slightly different car (the
same one on every engine). A jump pressed on an input whose last sub-step lands is lost.

**Sine and cosine.** The preset turns the heading with `psin` and `pcos`, a sine and cosine every
engine computes to the same bits; the platform's `Math.sin` and `Math.cos` differ in the last bit
between engines and would split prediction from the server. The client can import them from
`@genex-ai/multiplayer/authority`; a room module cannot import a package, so it rounds `Math.sin` and
`Math.cos` with `Math.fround` ([module-api.md](module-api.md)) or, like template 3, uses none.

## The collision world (`firstperson` and `vehicle`)

Both presets move through one static world of boxes and ramps, z up:

```ts
// src/world.ts: imported by server/room.js AND by the client, so both have the same world
export const WORLD = {
  boxes: [
    [-1024, -1024, -64, 1024, 1024, 0], // [minX, minY, minZ, maxX, maxY, maxZ]: the floor
    [-1056, -1056, 0, -1024, 1056, 256], // a wall
  ],
  ramps: [
    [400, -160, 0, 592, 160, 96, 0, 0, 96], // [minX, minY, minZ, maxX, maxY, maxZ, axis, lo, hi]
  ],
};
```

- **A ramp** is a box whose top rises along x (`axis` 0) or y (`axis` 1): `lo` at that axis's min
  end, `hi` at its max end, `maxZ` equal to the higher of them and `minZ` at or below both.
- **Nothing is implicit.** With no floor box a body falls forever: open ground is one box.
- **Every box is axis-aligned** and every ramp rises along x or y, so a level is built on a grid; a
  diagonal wall is a staircase of boxes.
- **Every number must be a float32**: integers are always safe, and so are halves and quarters;
  `0.1` is refused. Each min is below its max. At most 4096 boxes and 512 ramps.
- **The module exports it**: `defineRoom({ …, world: WORLD })`. The sandbox validates it when the
  module loads (a bad world is a bad config: the module does not load) and writes its hash into
  the preset's `params.world`. Leave `params.world` out.
- **The client hands its session the same world**: `connectAuthority({ …, world: WORLD })`, or
  `session.setWorld(WORLD)` before the first `frame()`. It returns the hash, and throws a
  `WorldError` naming the first bad value when the world is one the room would refuse.
- **The hash is the gate.** The session predicts your own body only while its world's hash equals
  the room's, so one number changed on one side turns prediction off: your body is then drawn from
  the server, a round trip late, and the console says why once. `session.prediction` reports it:
  `reason` is `world_mismatch`, with both hashes in `world` and `roomWorld`. Keep the world in one
  file both sides import; never rebuild it on the client from a model or a level file.
- **Size is cheap.** The server and the session both cull with a bounding-volume tree, so a step
  costs the solids near the body, not the size of the map, and a tower of stacked boxes costs no
  more than the same boxes spread out. The results are the same with or without it.
- **Draw what collides.** Build the visible level from the same boxes and ramps (or art that sits
  on them exactly): a wall drawn a little off is one players stop at in the air. The module's own
  tests (a shot's line of sight, a ball's bounce) use the same `WORLD`.

## Axes and three.js

The server's ground is the x/y plane and **+z is up**. `yaw` turns from +x toward +y,
counterclockwise seen from above (yaw 0 faces +x), and a positive `pitch` looks up. For
`firstperson` and `vehicle`, draw with three.js's handedness kept:

```ts
mesh.position.set(e.x, e.z, -e.y); // server (x, y, z) -> three (x, z, -y)
mesh.rotation.y = e.yaw; // a model that faces +x turns onto the heading
camera.rotation.set(pitch, yaw - Math.PI / 2, 0, "YXZ"); // a first-person camera at the eye, looking along the aim
```

Do not use topdown's `(x, z, y)` drawing with these presets. It is a mirror image, which does not
matter while a game reads its input in the same drawn axes, as the topdown templates do. Here the
input's right is the server's, and in a mirror image the steer-right key turns the car left on
screen. Convert only where you draw and where you read input; the world stays in server axes, value
for value the module's, or its hash differs.

## Running a ball

A ball, in car football or any game where bodies knock something about, is **one server projectile
the module re-launches** whenever its flight changes ([projectiles.md](projectiles.md)): a fixed id
such as `ball`, launched from `step` with `src` `''`. Every client draws it from its flight at the
server's present, and nothing moves it in between. Template 3 in [room-template.md](room-template.md)
is a whole car arena built this way. Every tick, `step` reads it with `ctx.projectiles.at("ball")`
and re-launches it from where it is when one of these changes it:

- **Off the world.** A sphere test against every solid of the same `WORLD` (by each box's closest
  point, and a ramp's closest point too, never its planes, which report a touch near an edge before
  there is one). Moving into a surface with normal `n`, the new velocity is
  `v - (1 + e) * dot(v, n) * n`, with a restitution `e` of about 0.6. Lose tangential speed only on
  a real impact (`-dot(v, n)` over a threshold): a ball sliding down a slope touches it every few
  ticks under gravity, and a loss on each touch glues it to the slope.
- **Off a car, at the time of impact.** Sweep the ball's flight from the tick before against the
  car's move since the module last saw it (keep each car's position at the end of `step`), relative
  to each other, to their first contact: sample the tick, then halve the step that first touches.
  Tested only where both are at the end of the tick, a hit's direction and speed depend on how deep
  the car got, and at 30 Hz a fast car passes under the ball. At the contact, push the ball out
  along the normal of the sphere against the car's hull (the preset's box), give it the car's
  velocity relative to it along that normal times `1 + e`, plus a share of the car's speed, and
  place it by where the car is now. A minimum hit speed, if you want one, scales with the car's own
  speed into the ball: a fixed one adds energy at every contact with a parked car, so the ball
  bounces forever on its roof or between it and a wall.
- **Rolling.** A ball resting on the floor is launched with `g: 0` and `vz: 0`, so its flight stays
  on the floor. Every few ticks (6 at 60 Hz) re-launch it with its speed `s` reduced by a share and a
  constant, `max(0, s * (1 - k * N / tickHz) - d * N / tickHz)` for `N` ticks, and at rest once it
  is slow: a share alone decays forever, so a slow ball creeps for seconds.
- **Goals.** The whole ball past a goal line inside the goal mouth is a `goal` event and a kickoff:
  the ball at rest on the centre spot, every car back on its slot with an `epoch` bump.
- **Speed.** Cap the ball's speed below its radius per tick (`radius * tickHz`), so one tick's move
  never carries it through a wall thinner than its diameter.

Each re-launch is one entity update, far inside a tick's caps. **The limit to say out loud:** every
client draws the ball where the server has it now, its own car ahead of the server by its input
lead, and other cars 100 ms behind. So your own touch shows your car reaching the ball a moment
before the ball reacts, and another car's touch shows the ball leaving before that car visibly gets
there: both are off by about the one-way latency. Draw the ball from `session.entities()` and leave
it there; do not try to hide this by moving the ball on the client.

## Sub-steps and the CPU budget

`substeps` (default 2) splits each input's step, so at 60 Hz the default runs 120 sub-steps a
second per body. Each sub-step costs about the same, so a room's preset time is about bodies ×
sub-steps. Genex's servers have room for a full car room at the most sub-steps. The local server runs
the module on QuickJS, several times slower: under Genex's limits a full car room (eight cars at
60 Hz) fits there at 2 sub-steps and is ended for CPU at 4 or more. **Keep `substeps` at 2 for a
full car room**; raise it only for fewer players, and only when the REPORT line of
`npx genex-authority-dev start --module server/room.js --root . --bots 7` keeps `tick.p99Ms` well
under `tick.budgetMs`. A `firstperson` map at the scale of a competitive shooter map (about 1500 boxes
and 60 ramps) at 2 sub-steps holds ten players on Genex's servers and about five on QuickJS.

The bots and the validation fuzz press button bit 1 most often. On both presets that is jump by
default, so in tests the bots mostly hop; a game whose main shot should be exercised binds it to
bit 1 and moves jump (`jumpBit: 8`), or accepts that the fuzz fires its other bits less often.

## Movement of your own

A game whose movement is none of these (flying, swimming, a double jump, a dash) leaves `preset` out
and moves the body itself in `onInput`. Write the step ONCE, in a file both sides import, and hand
the same function to the session so it predicts exactly what the server will do:

```ts
// src/sim/step.ts: imported by server/room.ts AND by the client
import type { InputData } from "@genex-ai/multiplayer/authority/module";

export const SPEED = 8;
export function step(body: { x: number; y: number; yaw: number }, input: InputData, dt: number): void {
  body.x = Math.fround(body.x + input.moveX * SPEED * dt);
  body.y = Math.fround(body.y + input.moveY * SPEED * dt);
  body.yaw = Math.fround(input.yaw);
}
```

```ts
// server/room.ts: onInput
onInput(ctx, playerId, input) {
  const me = ctx.entities.ownedBy(playerId);
  if (me) step(me, input, ctx.dt);
},
```

```ts
// the client
const session = await connectAuthority({
  urls: getAuthorityUrls(),
  room: GENEX.slug,
  auth: () => getColyseusAuth(),
  predict: { step, fields: ["x", "y", "yaw"] },
});
```

`fields` lists what the step writes (any of `x y z vx vy vz yaw pitch duck mstate cap spin fuel`;
all of them when left out). `predict: false` turns prediction off: the player's own body is then
drawn from the server's state, a round trip late, which is right only for something that does not
move under the player's hands (a turret, a card table).

Rules for a step of your own:

- Pure: the body, the input and `dt` in, the body out. No clock, no random, no state of its own.
- `Math.fround` every value it stores, as the wire carries float32.
- `Math.sin`, `Math.cos`, `Math.atan2` and `Math.exp` may differ in the last bit between engines:
  round what they give with `Math.fround` before storing it.
- The server stays the judge: the step predicts movement; collisions with other players, damage
  and scoring stay in the module and reach the client as state.
