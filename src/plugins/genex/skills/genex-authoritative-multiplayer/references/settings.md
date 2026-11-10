# Room settings by genre

A room module says how its game feels as **data in `config`**, never as code that names the game.
Pick the genre preset closest to the game; every setting you leave out comes from its table, and
every engine runs the same table, so prediction matches on every client. All of it needs a
`firstperson` or `vehicle` movement preset ([presets.md](presets.md)); a bad value is refused when the
module loads, naming the first bad path (for example `$.config.contacts.top.speed`).

| The game | `contacts.preset` | Movement | Seats on each other | Input repeat |
|---|---|---|---|---|
| Shooter, arena brawler | `shooter` | `firstperson` | stand on a head, slide off if the foot is mostly over the edge; players are solid and never shoved | on |
| Platformer, co-op climber | `platformer` | `firstperson` | stand and ride; a stomp is opt-in | on |
| Party game, minigames | `party` | `firstperson` | stand and ride, shoved by each other | on |
| Sandbox with crates and props | `physics-sandbox` | `firstperson` or `vehicle` | stand and ride, props ride heads | on |
| Car arena, derby | `vehicle-arena` | `vehicle` | cars slide off roofs, shove each other, bounce (restitution 0.6) | off |

## Contacts

`config.contacts: { preset, ... }` is how two seats in contact are handled. The server runs it after
each tick's movement and before `step`; clients run it in their prediction. Write no contact code, and
never run a pass of your own beside it.

```js
// shooter: the seats' hull is the movement preset's; players walk on each other's heads
config: { tickHz: 60, maxPlayers: 10, preset: { name: "firstperson", params: {} }, contacts: { preset: "shooter" } },
// platformer with a stomp (the upper seat bounces off, a held jump adds a boost)
config: { tickHz: 60, maxPlayers: 8, preset: { name: "firstperson", params: {} }, contacts: { preset: "platformer", top: { policy: "bounce" } } },
// party: a shorter landing zone is one number
config: { tickHz: 30, maxPlayers: 12, preset: { name: "firstperson", params: {} }, contacts: { preset: "party", top: { policy: "stand", center: 0.5 } } },
// sandbox: players stand on each other and on the crates the room simulates
config: { tickHz: 60, maxPlayers: 8, preset: { name: "firstperson", params: {} }, physics: true, contacts: { preset: "physics-sandbox" } },
// car arena: cars on cars slide off, whatever the preset says about hulls
config: { tickHz: 60, maxPlayers: 6, preset: { name: "vehicle", params: {} }, contacts: { preset: "vehicle-arena" } },
```

- **What a seat does on another's top** is `top.policy`: `stand` (rest on the head; `center` is the share
  of the lower seat's half width a landing may be off by, else it slides off; `ride: true` carries the
  rider), `slide` (frictionless, slid off), `bounce` (a stomp: `stompMin`, `bounceSpeed`, `jumpBoost`)
  or `ghost` (the pair never touches). **Head landing** is `stand` with a `center`: the shooter's is 0.25.
- **A pair rule** gives two kinds of seat their own top rule. A seat's tags are its entity's `tags`
  and `flag:k` for each bit `k` of its `flags`: `pairs: [{ a: "flag:0", b: "flag:0", top: { policy: "ghost" } }]`
  lets seats that both carry flag bit 0 (a team) pass through each other. At most 32 pairs.
- **Cells you can override**: `shape` (default: the movement preset's hull, a box over a `vehicle`),
  `restitution`, `passes` (1 to 64), `offWall`, `drawing` (`predicted`, `separate`, `timeline`: how a
  client draws other seats), `push` (`shared` or `mover`), `headFriction` (`slide` or `carry`, for props).
- A module that needs a rule the table cannot say keeps the contact functions of
  [module-api.md](module-api.md); do not mix the two.

## Inputs

`config.inputs: { preset?, repeat? }`. A starved seat (its input is late) is either stepped again
under its last input (`repeat: "on"`, bounded to about 33 ms a starve and 100 ms in all) or held
(`"off"`). The default is the genre's column above (`inputs.preset`, else `contacts.preset`, else on).
Car arenas measured worse with repeats on, shooters and character games better. Override only with a
measurement: `inputs: { repeat: "off" }`. The client follows the room's setting by itself.

## Lifts

`config.lifts` declares moving platforms as data, each posed by an exact function of the tick: no
module code moves them. A rider is carried, and leaves with the lift's velocity unless `impart: "none"`.

```js
lifts: { platforms: [
  { id: "elevator", shape: { kind: "box", half: [96, 96, 8] }, path: { points: [[0, 0, 0], [0, 0, 240]], legs: [240], waits: [60, 60], ease: "smooth" } },
  { id: "turntable", shape: { kind: "disc", radius: 160, half: 8 }, at: [600, 0, 0], spin: { period: 600 } },
  { id: "belt", shape: { kind: "box", half: [200, 64, 8] }, at: [0, 600, 0], surface: [300, 0] },
] }
```

- A path has `points`, one leg length in **ticks** per leg (`legs`: one fewer than the points for the
  default `pingpong`, one per point for `loop`), optional `waits` (one per point), `ease` (`linear` or
  `smooth`) and `phase`. A `spin.period` is the ticks of a full turn (8 or more); `surface` is a
  conveyor's speed in the platform's frame. 1 to 32 platforms, ids of a-z, 0-9 and `-`.
- A platform that moves more than the movement preset's `radius` in one tick is refused, naming the
  leg and the most allowed. Lengths in ticks scale with `tickHz`: the same elevator at 120 Hz has doubled legs.
- The client draws a lift with `session.liftPose(id)` and, in a `firstperson` view, adds
  `session.viewCarry()` to its yaw once a frame. The module reads `ctx.lifts.crushed()` for damage.
- The client must send the `lifts@1` capability; `connectAuthority` does. A client that does not (the
  Godot SDK today) is refused when the room declares lifts, never allowed to fall through them.
  With server physics, crates ride lifts and a conveyor moves them.

## Tick rate

`tickHz` is 20, 30, 60 or 120. Use 60 for character and car games, 30 for slow ones. **120 is for a
module that asks for physics** (`physics: true`): the world steps twice as often, the room counts twice
toward a server's capacity (12 units where 60 Hz counts 6), and each tick keeps a 60 Hz tick's budget
(8 ms, 1 ms on average), so the room gets twice the CPU a second. Check the REPORT line of
`genex-authority-dev start` against `tick.budgetMs` ([testing.md](testing.md)).

```js
config: { tickHz: 120, maxPlayers: 4, preset: { name: "vehicle", params: {} }, physics: true, contacts: { preset: "vehicle-arena" } },
```

## Regions

Pass the stand's regions beside its urls and the client joins the nearest one by measured ping:

```ts
const session = await connectAuthority({
  urls: getAuthorityUrls(), regions: getAuthorityRegions(), room: GENEX.slug, auth: () => getColyseusAuth(),
});
```

Each region is its own matchmaking pool: players meet others who entered through the same region. A
region that answers no probe is tried last. A full region (503) is retried, and moves on to the next-best
after a second refusal. Nothing to configure in the module.

## The fast channel (`fast@1`)

On a bad Wi-Fi link one lost TCP segment holds every input and snapshot behind it. With the fast
channel a seat's inputs and the room's motion go by unordered datagrams (each input is sent in several,
a lost snapshot is replaced by the next); join, game events, chat and everything else stay on the
WebSocket. It needs nothing in the room module.

- The seat asks for it (`fast@1`), the room offers it only when the server has it configured, and a seat
  that is not offered it stays a WebSocket seat. If the datagrams stop, or the endpoint cannot be reached,
  the seat falls back to the WebSocket by itself, mid-game, and prediction does not notice.
- **Status:** a UDP seat in Unreal (`bFastChannel`), Unity (`GenexAuthorityOptions.Fast`, not WebGL),
  Rust (`AuthorityOptions::fast(true)`) and TypeScript in Node (the client's `fast` option, given
  `openUdpFastSocket` from `@genex-ai/multiplayer/authority/fast-udp`). It is off until the game turns it on. **A browser game
  is a WebSocket seat**: browsers have no raw UDP, and WebTransport is not shipped. Godot is a WebSocket seat.
  Do not promise a browser player UDP-like play.
