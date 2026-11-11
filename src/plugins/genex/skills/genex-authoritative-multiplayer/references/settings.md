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

`config.inputs: { preset?, repeat?, settleMs? }`. A starved seat (its input is late) is either stepped again
under its last input (`repeat: "on"`, bounded to about 33 ms a starve and 100 ms in all) or held
(`"off"`). The default is the genre's column above (`inputs.preset`, else `contacts.preset`, else on).
Car arenas measured worse with repeats on, shooters and character games better. Override only with a
measurement: `inputs: { repeat: "off" }`. The client follows the room's setting by itself.

A seat that stops sending inputs holds where its last one left it, in the air too, and everyone else
sees that. `settleMs` (100 to 60000, default none) has the room step its `firstperson` or `vehicle` body
under a stick at rest once it has been quiet that long, until it lies still. Keep it above a hitch: 500
is a fair start. A kick for idling stays the module's.

## Holding bodies still: announce the release

A body held with `cap` 0 (a freeze time, a kickoff) and let go: inputs already on their way are stepped
at the new cap, so a stick held through the lift lurches ahead by about speed × round trip when the
client hears. Announce the tick instead, the way a countdown is shown anyway:
- The module writes the tick `go` into data the client reads, more than a round trip ahead, and sets
  `cap` in its `step` of tick `go`.
- The client gives `connectAuthority` a seat rule:
  `seatRule: (seat, tick) => { if (seat.cap === 0 && go > 0 && tick > go) seat.cap = 1; }`, and clears `go`
  when no release is coming.
Every seat then starts on one tick at any ping, and nothing is corrected. Any announced `cap` change works
the same way, up or down. A change the module could not announce arrives as a correction.

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

Pass the stand's regions beside its urls. The client measures its ping to each and goes where the
players are:

```ts
const session = await connectAuthority({
  urls: getAuthorityUrls(), regions: getAuthorityRegions(), room: GENEX.slug, auth: () => getColyseusAuth(),
});
```

Each region is its own matchmaking pool: players meet others who entered through the same region. So
a join first asks every region within reach for a room that already has players, nearest first, and
opens a new room in the nearest region only when none has one. A player in Asia therefore joins a
friend's room in Europe instead of waiting alone. A region that answers no probe is never asked. A
full region (503) is retried, and moves on to the next-best after a second refusal. Nothing to
configure in the module.

Three options on `connectAuthority` change this, and most games need none:

| Option | Default | What it does |
|---|---|---|
| `maxPingMs` | `350` | The farthest region asked for players, as round-trip ping. A twitch-competitive game sets it lower. |
| `regionRule` | `'players'` | `'nearest'` joins the nearest region only, whoever is elsewhere. |
| `region` | none | A region the player picked by name (`'asia'`, `'eu'`, `'us'`): only it is joined. Offer it as a setting when players ask to choose. |

A player who ends up alone keeps looking. Two players who start at the same moment in two regions each
open a room; within a few seconds one of them is moved into the other's room. The session object stays
the same and fires `rejoined` with `moved: true`: the room is a new one, so redraw from its state and
say so ("Found players, joining their room"). `regroup: false` keeps a player where they are; use it
when a player alone still has something to lose, such as a run against the room's own enemies.

### A region picker

Most games need none: Auto finds the players. Add one when players ask to choose, or when ping matters
more than company. It is a setting, not a screen before every match.

```ts
import { authorityRegionOf, connectAuthority, measureAuthorityRegions } from '@genex-ai/multiplayer/authority';

const regions = getAuthorityRegions();
const NAMES: Record<string, string> = { asia: 'Asia', eu: 'Europe', us: 'North America' };

// In settings: Auto first, then each region with its ping. No join is made.
const pings = await measureAuthorityRegions(regions); // [{ region: 'asia', pingMs: 38 }, …] in list order
const rows = [{ value: '', label: 'Auto (recommended)' }, ...pings.map((p) => ({
  value: p.region,
  label: `${NAMES[p.region] ?? p.region} · ${p.pingMs === null ? 'no answer' : `${Math.round(p.pingMs)} ms`}`,
}))];

// The choice is the player's: keep it, and pass it on the next join. '' is Auto.
const picked = localStorage.getItem('genex-region') ?? '';
const session = await connectAuthority({
  urls: getAuthorityUrls(), regions, room: GENEX.slug, auth: () => getColyseusAuth(),
  ...(picked === '' ? {} : { region: picked }),
});

// Show where the player is, and say when they were moved.
const here = authorityRegionOf(regions, session.url); // 'asia' | 'eu' | 'us' | undefined
session.on('rejoined', (info) => { if (info.moved) showToast('Found players, joining their room'); });
```

- A picked region is the only one joined: no search and no move. Say what that costs beside the
  choice ("Only players in Europe"), and keep Auto the default.
- Measure when the settings open, not on every frame; show the number the player will feel.
- A change applies to the next join. Offer "Find a new match" rather than moving a player mid-match.

### Playing with a friend

A room's code brings a friend into it from any region. Show `session.code` with a copy button; the
friend enters it and joins by it. A private room is one nobody else can find:

```ts
const mine = await createPrivateAuthority(options);            // a room only a code opens
const theirs = await joinPrivateAuthority(code, options);      // any room by its code, pool or private
```

A code that names no room is refused; show "That room is gone" and offer a new one.

## The fast channel (`fast@1`)

On a bad Wi-Fi link one lost TCP segment holds every input and snapshot behind it. With the fast
channel a seat's inputs and the room's motion go by unordered datagrams (each input is sent in several,
a lost snapshot is replaced by the next); join, game events, chat and everything else stay on the
WebSocket. It needs nothing in the room module.

- The seat asks for it (`fast@1`), the room offers it only when the server has it configured, and a seat
  that is not offered it stays a WebSocket seat. If the datagrams stop, or the endpoint cannot be reached,
  the seat falls back to the WebSocket by itself, mid-game, and prediction does not notice; when the path
  comes back the seat returns to it by itself. A network that blocks UDP loses no input: a seat moves only
  once the path is proven. A seat with nothing to send, a NAT rebinding and a Wi-Fi to mobile move all keep it
  on the channel, and a room too big for one snapshot sends what matters most first, the rest in turn.
- **On by default:** Unreal (`bFastChannel`), Unity (`GenexAuthorityOptions.Fast`) and Rust
  (`AuthorityOptions::fast`) seats and TypeScript in Node ask for UDP unless the game sets it to false, and
  the WebSocket is the automatic fallback. Do not write code to turn it on. Do not turn it off unless you are
  testing the fallback. `genex-authority-dev start` serves it locally too (`--no-fast` is its off switch).
- **See which transport you are on:** one line per join says so, in every engine:
  `genex transport: udp fast@1 udp://...`, or `genex transport: websocket, <reason>: ...` with the reason
  (`off`, `no_udp`, `not_offered`, or a fallback's `unreachable`, `handshake`, `stall`, `server`). Read it in
  the log, or as `session.fast.line`, `GetTransportLine()`, `GenexFastStatus.Line`, `transport_line()`. A log
  that says `websocket` is the first thing to read when a game feels late.
- **A browser game has it by default, over WebTransport, with nothing to write**: `connectAuthority` and the
  web engine bridge (Godot and Rust web exports) use it wherever the room's server runs the relay and the
  browser can open it; `fast: false` turns it off. Anything else lands the seat on the WebSocket by itself,
  and `session.fast.fallback` says why (`no-webtransport`, `no-relay`, `not-offered`, `unreachable`,
  `handshake`, `stall`, `server`). A game gets it once it is rebuilt on this SDK.
- **Not on UDP:** a native Godot build (no fast channel yet) and Unity WebGL (no sockets; `FastWebTransport`
  asks for WebTransport) are WebSocket seats.

## Idle seats and room age

`config.lifetime: { idleSeatS?, maxRoomAgeS? }`, whole seconds. A seat whose input has not changed for `idleSeatS` (default 1800, 30 to 86400) leaves with `onLeave` reason `idle`; your client sees close 4408 and may offer to rejoin. Raise it if your honest players stand still that long: a turn-based game, a spectator. A room `maxRoomAgeS` old (default 86400, 60 to 604800) gets `server:restart` and ends: raise it for a world that should live longer. Neither can be turned off.

## Rooms past about 30 seats

A seat on the fast channel gets a share of what its room may send: 68 KiB/s a seat at 30 seats, 32 at 64. Past its share its snapshots are cut: far entities update less often, its own seat never does. Rooms that large have not been measured on UDP, so `validate` warns (`downlink_share`). Test yours full, or lower `maxPlayers`.
