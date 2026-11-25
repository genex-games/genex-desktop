# Genex server-authoritative multiplayer in AI Game Studio

You are building inside AI Game Studio. Below the upstream marker is Genex's server-authoritative
multiplayer card, with its CLI-only testing section taken out. Where it disagrees with this
preface, this preface wins.

## What Studio runs of it today

- Writing works: the room module, its `authority` block and the client, in any web game made here.
  A Unity game writes the same room module and block (in `genex.json`) with a C# client: follow
  section 5 of `unity__skill {"name":"unity-multiplayer"}`, not this card's client half.
- Shipping works. `genex__publish` (draft or gallery) sends the room module with the build: Studio
  ships `@genex-ai/authority-dev` itself, stages `server/` and every file the module imports beside
  the public copy (never in it), and the publish bundles and validates the module before any game
  file moves. A module that fails stops the publish with each typed reason in the job's error; fix
  the module and publish again. The job's `room` (in `genex__publish-status`) says it plainly:
  `validated` and `uploaded` with the module's `moduleSha256` once it passed and went up with this
  build, or the gate's `failures`; tell the person from it. On Genex's servers the owner needs
  Genex Pro: a free account is refused with `authority_requires_pro` after validation, and nothing
  is uploaded.
- Testing it on this computer works, with `genex__room` in place of the card's
  `npx genex-authority-dev` commands (a game's commands cannot download it):
  - `genex__room {"action":"validate"}` is the publish gate's own check: `{passed, failures}`.
    Run it after every change to the module, and fix each failure before anything else.
  - `genex__room {"action":"start","latencyMs":75}` serves the room on this computer with bots
    and loads the game's preview into it, so the person plays against the bots there. The preview
    takes a seat and your own test client needs another: with the authority block's `maxPlayers`
    the default is that less 2 bots (at most 3), and a `bots` count that leaves no seat free is
    refused by name. `genex__room {"action":"status"}` answers the room's last REPORT, its `ctx.log`
    lines and errors, and `rooms`: more than 1 (its `warning`) means players did not all fit and
    opened another room, so start with fewer bots; the REPORT's `perRoom` lists each room's seats,
    players and bots. A client that joins with a `matchKey` needs the same `"matchKey"` on `start`,
    or the bots play in the game's other pool. Read it while the room runs, as the card's testing reference describes. Stop it with
    `genex__room {"action":"stop"}`. The preview hands the game the room's address through the
    embed SDK's local test mode (`getAuthorityUrls()`): never write the address into the game.
- Before a publish, validate, then play it in a local room with bots, and say what you saw. Never
  report a server-authoritative game as online before a draft of it passed.
- A passed draft's `draftPlayUrl` (in `genex__publish-status`) is where two people test the rooms:
  a guest joins there with no account, and the owner's Genex Pro pays for the rooms. `draftUrl` is
  the owner's draft page, behind their sign-in.

## Packages

- `genex__package {"package":"@genex-ai/multiplayer"}` adds both SDKs at Studio's pins (nobody is
  asked): `@genex-ai/multiplayer` with `@genex-ai/multiplayer/authority`, and `@genex-ai/embed-sdk`
  with `getAuthorityUrls`. Never run `npm i` for them yourself; the card's step 4 does not apply.
- `@genex-ai/authority-dev` ships with Studio: never install it in the game.
- A room module imports nothing at runtime from a package, and imports the game's own files only
  from folders inside the game (`src/`, `shared/`), never a file at the game's top level or in a
  hidden folder: the publish refuses those, and a link anywhere on the way.

## A game made from Studio's template

- It has no `package.json`: the `authority` block goes in `genex.json` at the game's root, beside
  any other setting: `{"authority": {"module": "server/room.js", "tickHz": 30, "maxPlayers": 8}}`.
  Keep `genex.json` valid JSON and add no package.json beside it: Genex reads a package.json first,
  so a stray one, or a `genex.json` that does not parse, would drop the block. The publish and
  `genex__room` refuse such a game by name (`export_room_manifest_shadowed`,
  `export_room_manifest_broken`) rather than ship it with no room.
- The same `genex__package` call maps `@genex-ai/multiplayer/authority` in its import map; a game
  that mapped multiplayer earlier gets it by making the call again. Never copy the SDK by hand.
- It has no TypeScript build: write the room module and every file it shares with the client in
  plain JavaScript (`server/room.js`, `src/world.js`), without the card's type annotations and
  `import type` lines, importing shared files by their `.js` path.
- Its public copy holds `index.html`, `src/` and `assets/`: keep server-only code in `server/`
  and shared code in `src/`.
- Studio connects the game: never call `initEmbed()`. The `room` for `connectAuthority` is the
  game's slug, from `src/genex.config.js` as the multiplayer card's preface describes
  (`genex__skill {"name":"genex-threejs-multiplayer"}`).

## An Unreal game

- The room module, its `authority` block in `genex.json`, `genex__room` and the publish are the
  same as above: only the client differs. Read `unreal__skill {"name":"unreal-multiplayer"}` for
  it: `unreal__multiplayer` adds Genex's Unreal plugin (shipped with Studio, never fetched by the
  game), and the client joins with its `Genex Authority Subsystem`. Ignore this card's
  `@genex-ai/multiplayer` and embed SDK steps for an Unreal game.

## Reading the references

The card links its references by relative path. Read one with `genex__skill` and the file exactly
as listed, for example
`genex__skill {"name":"genex-authoritative-multiplayer","file":"skills/genex-authoritative-multiplayer/references/module-api.md"}`.

## Commands

`npx genex preview` is `genex__publish {"operation":"draft"}` and `npx genex publish` is
`genex__publish {"operation":"gallery"}`; both carry the room module (above). Other commands map
onto Studio tools as the `genex` skill describes (`genex__skill {"name":"genex"}`).

<!-- upstream @genex-ai/cli-demo/templates/skills/genex-authoritative-multiplayer/SKILL.md v1.46.4 sha256 4df517a65e24c3011cc106a7993ebaaccdb8a9376a0b86f713c3c7f7187f67bb -->
---
name: genex-authoritative-multiplayer
description: Server-authoritative multiplayer for Genex games — the game's own room module runs on Genex's servers, players only send input, and the server decides every move and hit (lag-compensated). Use for competitive play where cheating matters: ranked PvP, arenas, shooters (first-person, hitscan or dodgeable projectiles), car football, "so nobody can cheat". Casual co-op and hangouts use genex-threejs-multiplayer instead. Load before writing the room module or any networking code.
---

# Genex Server-Authoritative Multiplayer

In a server-authoritative game the **server runs the game's rules**. The game ships a **room
module** — one script, `server/room.ts` or `server/room.js` — that Genex runs in a sandbox at a
fixed tick. Players send typed input (`moveX`, `moveY`, `yaw`, `buttons`, …); the server moves
every body, judges every shot against where the shooter saw its target, and writes the state every
client renders. A modified client can lie only about its own stick and buttons.

The client half is `connectAuthority` from `@genex-ai/multiplayer/authority`: it predicts the
player's own body with the same movement preset the server runs (so moving feels instant), draws
everything else a render delay in the past (100 ms, more on a jittery link where the room allows
it), and reconciles when the server's truth arrives.

## Casual or server-authoritative

| | Casual — `$genex-threejs-multiplayer` | Server-authoritative — this skill |
|---|---|---|
| Who runs the rules | Each player's browser; Genex's relay passes messages | Genex's servers run the game's room module |
| Cheating | A modified client can say where it is and what it hit | The server decides every move and every hit |
| Fits | Co-op, hangouts, party, turn-based, casual races | Competitive shooters, arenas, ranked play — anything with a winner worth faking |
| On Genex's servers | Free | Needs Genex Pro for the game's owner, unless Genex's free tier is on (smaller limits) |
| Building and testing | Free | Free, on this machine, with no account |

"Competitive", "ranked", "PvP", "esports", "so nobody can cheat" or "server-authoritative" mean
this skill; everything else is casual. When the person has not said which, ask in one line and say
what each costs. Never mix the two in one game: an authority game has no relay `Session`, no host
and no shared objects — the server owns all state.

## What you write

1. **The room module**, `server/room.ts` (or `.js`): `export default` a room with `contract: 1`,
   `config`, `init`, `onJoin`, `onLeave`, `onInput` and `step`. It is server code: keep it and
   everything only it uses in `server/`. Shared pure code (a movement step the client also runs)
   may live in `src/` and be imported by both. The full API and the sandbox's rules are in
   [references/module-api.md](references/module-api.md); five complete games to start from (an
   arena with instant shots, one with bolts players can dodge, a car arena with a ball, the car
   arena on server physics with crates, and a first-person arena) are in
   [references/room-template.md](references/room-template.md). Start a first-person or third-person
   shooter from template 5.
2. **The manifest block**, in package.json:

   ```json
   { "genex": { "authority": { "module": "server/room.ts", "maxPlayers": 8 } } }
   ```

   A game without a package.json (one made from Studio's template) puts the same object in
   `genex.json` as `{ "authority": { … } }`. `module` is a plain relative path to a `.js` or `.ts`
   file inside the game folder. The rest is optional: `maxPlayers` (1 to 64) is the most a room
   seats (the module may ask for fewer) and `preset` names its movement preset. `tickHz` (20, 30, 60
   or 120; 120 only for a module that asks for physics) is the highest rate Genex's servers run the
   room at: a module whose `config.tickHz` is higher runs at the manifest's rate there, and so does
   a module whose `config` names none. The local server never reads it, so a manifest `tickHz: 30`
   over a module that asks for 60 plays at 60 in testing and at 30 once published. Leave `tickHz`
   out of the manifest and set it in the module's `config`. Left out, each comes from the
   module's own `config`. A malformed block is not ignored — `genex preview` refuses it and says why.
3. **The client**: `connectAuthority` with the identity from `$genex-threejs-embed-auth`, input
   written to `session.input`, `session.frame(now)` once per render frame, and the scene drawn
   from `session.entities()`.
4. **The packages**: `npm i @genex-ai/multiplayer@latest @genex-ai/embed-sdk@latest` and
   `npm i -D @genex-ai/authority-dev@latest`. Everything this skill teaches is in
   `@genex-ai/multiplayer` 0.17.21, `@genex-ai/embed-sdk` 0.38.0 and `@genex-ai/authority-dev`
   0.1.11; a game on older ones lacks what came after them. Projectiles need `@genex-ai/multiplayer`
   0.17.4 or newer; `home` and `getAuthorityHome` need 0.17.12 (and embed SDK 0.36.0); `region` and
   `rttMs` need 0.17.13; predicted hits and a render delay that follows the link need 0.17.14; the
   update rate (60 a second by default) needs 0.17.15; bodies as targets (`height`, `duckHeight`) and
   a projectile's `rewind` need 0.17.17, and `@genex-ai/authority-dev` 0.1.9 for the local server to
   judge them (an older one ignores both and tests a ball at the feet); `pingMs` needs 0.17.19. If
   `@genex-ai/multiplayer/authority` does not resolve after installing `@latest`, tell the person
   plainly and stop, rather than writing a server of your own.

## Rules that decide whether it plays well

1. **The server decides; the client asks.** Health, score, pickups, kills, respawns and round
   state change only in the room module, and the client draws them from `session.entities()` and
   the module's events. Show a muzzle flash or play a sound at once if you like. A hit marker may
   go up the moment your own shot reaches a target on screen, but only from the session's predicted
   hits ("Shots", below), which say when to take it back. Never draw damage, a kill or a score the
   server has not sent.
2. **Never move your own body yourself.** Write the stick and aim into `session.input`; the session
   predicts your body with the room's preset and corrects it. A game whose movement is not the
   preset passes its own step as `predict: { step }` — the exact step the module runs
   ([references/presets.md](references/presets.md)).
3. **The module must be deterministic.** The same seed and inputs must give the same room: no
   clock, no timers, and randomness only from `ctx.random()` (`Math.random` is the same seeded
   generator inside the sandbox). `validate` and `replay` check this, and a publish refuses a
   module that fails.
4. **Bump `epoch` to teleport.** A respawn or a teleport that does not bump the entity's `epoch`
   slides across the map on every other screen.
5. **Keep per-tick work bounded.** Each tick has a CPU and memory budget; a runaway loop ends the
   room for everyone in it. Loops run over entities or players, never "until something happens".
6. **The server's plane is x/y, and +z is up.** `yaw` turns from +x toward +y. For `firstperson`
   and `vehicle`, draw at three.js `(x, z, -y)` with `rotation.y = yaw`: their input's "right" is
   the server's, and a mirrored drawing steers the car the wrong way. The topdown templates draw the
   server's `y` as three's `z`, which works there because they read input in the same drawn axes.

## Movement: pick a preset

| The game | `config.preset` | Notes |
|---|---|---|
| Seen from above (twin-stick, top-down shooter) | `topdown` | 30 Hz is enough |
| On foot through a level (a first-person or third-person shooter) | `firstperson` | Source-engine-style movement through a world of boxes and ramps; `tickHz: 60` |
| Cars (car football, a derby, a track of ramps) | `vehicle` | Rocket League's handling, kept level, through the same kind of world; `tickHz: 60` |
| Anything else | none: your own step | Shared by the module and the client, `predict: { step }` |

`firstperson` and `vehicle` move through a fixed collision world the module exports
(`defineRoom({ world })`) and the client hands its session (`connectAuthority({ …, world })`),
from one file both import: the session predicts only while the two hash the same. A level made in
an editor gets that file from an exporter and `genex world fit`, on any engine:
[references/levels.md](references/levels.md). Their inputs,
parameters, units and CPU budget are in [references/presets.md](references/presets.md); read it
before writing either side. An Unreal level becomes that file by a bake (`Genex.FitCollisionWorld`, "Unreal"
in levels.md), not by hand. A ball the cars knock about is one projectile the module re-launches
(template 3, and "Running a ball" in presets.md). Template 5 is a whole first-person game on the
`firstperson` preset.

## Feel settings: contacts, inputs, lifts, tick rate, update rate, regions, fast channel

Seats that touch (standing on heads, shoving, passing through), starved inputs, moving platforms, 120 Hz,
how often the room sends its state, regions and the UDP fast channel are **settings in `config`**, picked by genre (`shooter`, `platformer`,
`party`, `physics-sandbox`, `vehicle-arena`), never code that names the game. Read
[references/settings.md](references/settings.md) for a worked config per genre before writing any of them.

## Physics: crates, balls, doors

When things must collide with each other (a stack that topples, a ball between cars and walls, a
door a player shoves), the module asks for server physics (`config.physics`) and spawns bodies with
`ctx.physics`; the game's client code only draws them. Read
[references/physics.md](references/physics.md) first; template 4 is the car arena with a physics ball
and crate stacks.

## Shots: hitscan or projectile

- **Instant** (a rifle, a laser): `ctx.rewind.hitscan` in `onInput`, lag-compensated with
  `config.lagComp`. Template 1 (top-down) and template 5 (first-person, with walls, bodies, health
  and the predicted hit marker). A world's walls stop it with `ctx.world.ray`:
  [references/presets.md](references/presets.md#a-shot-and-the-world). Where bullets differ from
  bodies, a shot world and the shooter's own stop: [references/levels.md](references/levels.md#what-bullets-meet).
- **Something players see travel and can dodge** (a bolt, a rocket, a grenade, an arrow, a
  dodgeball): a projectile. The module launches it once with `ctx.projectiles.launch` and judges it
  with `ctx.projectiles.sweep`; the shooter's client calls `session.predictProjectile` while staging
  the input that fires, and every client draws it from `session.entities()`. Template 2. Read
  [references/projectiles.md](references/projectiles.md) before writing either side.

Never make a travelling shot a plain entity the module moves in `step`: it costs an update every
tick and every client draws it a render delay (100 ms or more) late. Every client in a room whose
module launches projectiles must support them; one that does not draws each projectile frozen where
it was launched.

**Show the hit at once.** A hit marker that waits for the server shows a round trip late. The
session can test your own shot against the bodies as it draws them and tell you the frame it
lands; the server still decides every hit, and nothing extra is sent.

- A projectile: add `hits` to its `predictProjectile` call, `{ kinds, radius }` exactly as the
  module passes them to `ctx.projectiles.sweep`.
- A hitscan: `session.predictHitscan(origin, dir, { range, radius, kinds })` while staging the
  input that fires, with what the module passes `ctx.rewind.hitscan`.
- **Bodies** (`firstperson`): both sides add `height: 72, duckHeight: 54` with `radius: 16`, or the
  target is a ball at the feet. Never judge bodies with a test of your own in the module: the
  client then has nothing to predict with.
- **A projectile a player fires** is swept with `rewind: true` in a room whose config has
  `lagComp: { projectiles: true }`, so it is judged where that player saw the targets and its
  predicted hit is confirmed: [references/projectiles.md](references/projectiles.md#bodies-and-what-the-shooter-saw).
- `session.onPredictedHit(cb)` shows the marker; `session.onHitSettled((hit, confirmed) => …)`
  keeps it or takes it back.
- A hit is confirmed when the state shows the target's `hp` lower (or the target gone, or in a new
  `epoch`), so a module that lowers `hp` on a hit needs nothing more. For a module that reports
  hits another way, pass `settle: "manual"` beside `kinds` and call `session.confirmHit(id)` or
  `session.cancelHit(id)` from the module's own event.

The code for both is in
[references/projectiles.md](references/projectiles.md#show-the-hit-at-once-predicted-hits).

## The client in one screen

```ts
import { connectAuthority } from "@genex-ai/multiplayer/authority";
import { getAuthorityHome, getAuthorityRegions, getAuthorityUrls, getColyseusAuth, waitForPlayer } from "@genex-ai/embed-sdk";
import { GENEX } from "./genex.config";

await waitForPlayer();
const session = await connectAuthority({
  urls: getAuthorityUrls(),
  regions: getAuthorityRegions(), // each region is its own pool
  home: getAuthorityHome(), // the player's region by geography: joined first
  room: GENEX.slug,
  auth: () => getColyseusAuth(),
});

function loop(now: number) {
  session.input.moveX = stick.x; // [-1, 1] on the server's x axis
  session.input.moveY = stick.y; // [-1, 1] on the server's y axis
  session.input.yaw = aimAngle; // radians, 0 along +x
  session.input.buttons = firing ? FIRE : 0;
  session.frame(now); // sends the due inputs, predicts you, interpolates everyone else
  for (const [id, e] of session.entities()) drawBody(id, e.x, e.y, e.yaw, e.epoch);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
session.on("shot", (data) => showTracer(data)); // an event the room module emitted
session.on("reconnecting", () => showBanner("Reconnecting…")); // the socket dropped: the SDK restores it
session.on("reconnected", () => hideBanner()); // the same seat in the same room
session.on("rejoining", () => showBanner("Reconnecting…")); // a deploy or a dead server: the SDK finds the next room
session.on("rejoined", () => { hideBanner(); clearDrawnEntities(); }); // a new seat in a new room, on the same session object
session.on("disconnect", (code) => showLeft(code)); // over for good
```

**The session in one table.** Everything the client reads comes from it:

| Member | What it is |
|---|---|
| `session.id` | Your seat: the `owner` of your entity. It changes on `rejoined`. |
| `session.me()` | Your own entity, predicted; `undefined` until the room spawned it. |
| `session.entities()`, `session.entity(id)` | Every entity as this frame draws it, your predicted shots included. |
| `session.players()` | The roster, by seat: `{ id, name, uid, team, connected, avatarUrl }`. Names and avatars for a scoreboard come from here; `connected` is false while that player's socket is down. |
| `session.region`, `session.pingMs` | The region the room's server is in (`''` on the local server) and the link's round trip to it, ms (-1 until measured): what a HUD shows. |
| `session.connected` | False from a dropped socket until the reconnect's first state, and after the session ends. |
| `session.code` | The room's invite code ([references/settings.md](references/settings.md#playing-with-a-friend)). |
| `session.leave()` | Leaves on purpose, for a quit to the menu. Nothing reconnects after it. |

**Show `session.pingMs` as the ping, with `session.region`** (`eu · 42 ms`). Never show
`session.rttMs`: it is the round trip of an input to the state that acknowledges it, and a room with
a movement preset keeps a seat's inputs in a buffer before it steps them (up to 100 ms on a link
that stalls), so `rttMs` reads above the link ([references/settings.md](references/settings.md#inputs)).

**Other players are drawn a render delay behind**, and the session sizes it: 100 ms on a steady
link, more (up to the room's ceiling, at most 250 ms) when states arrive unevenly, so other players
keep moving instead of freezing and jumping. There is nothing to call and nothing to tune in the
client; `session.renderDelayMs` reads the delay now. A server that has the setting off keeps every
client at 100 ms. A module lowers the ceiling with `config.interpolation`
([references/module-api.md](references/module-api.md)). Never hard-code 100 ms in the game as that
delay: each input carries the delay its player really drew, so a shot is still judged where it was
aimed.

**Deploys never end a game.** When a server is updated, your players get a `draining` event
(`{ closesInMs }`), keep playing, and are moved by the SDK to a fresh room, together: `rejoining`
(`{ attempt, code, waitMs }`), then `rejoined` (`{ code, url }`). A dropped socket that the SDK
restores is `reconnecting` and `reconnected`: the same seat, nothing to rebuild. After `rejoined`
the `session` object, its listeners, `session.input` and the world you gave it are the same, and
these are new, so the handler resets what the game keeps of them:

- `session.id` and every entity id: remove every mesh keyed by entity id and let the draw loop build
  the room again; drop anything cached by the old seat.
- `session.telemetry`, which counts from 0: reset a fire cooldown counted in `inputsSent`.
- Your entity's life: its `epoch` starts over. A predicted hit still pending is cancelled by the
  session.

`rejoined` with `moved: true` is a player who was alone and now sits in a room that has players
([references/settings.md](references/settings.md#regions)). The new room starts from `init` unless
your module hands its state on: add `onDrain(ctx)` and read `ctx.handoff` in `init`, keyed by uid
([references/module-api.md](references/module-api.md); template 5 keeps its scores this way).
`disconnect` means it is really over: a kick, a fault, or no server for three minutes.
`rejoin: false` in `connectAuthority` makes a lost room a `disconnect`. Every template handles
`reconnecting`, `reconnected`, `rejoining`, `rejoined` and `disconnect`.

A refused join rejects with a `code`: 402 (the owner's plan does not include Genex servers — final),
424 (no room module is published for this build yet), 426 (the SDK is too old), 429 (the owner's
server time or room limit is used up — try later) or 503 (no server free — the session already retried). Say each
in the player's words; never loop on 402 or 424. The whole client, with three.js, is in
[references/room-template.md](references/room-template.md).

## A client in Unity, Unreal, Rust or Godot

The room module is the same for every engine: `server/room.ts`, the manifest block,
`genex-authority-dev` and every reference page about the module apply as written. The client code in
this skill is TypeScript for a web game. A game in another engine uses that engine's Genex
multiplayer SDK, which has the same session under its own names. Read the SDK's README before
writing the client, and never port the TypeScript by hand.

| Engine | The SDK in the game | Read | The ping to show |
|---|---|---|---|
| Unity | The package `com.genex.multiplayer` in `Packages/` | `README.md` in the package, "Server-authoritative rooms" | `Ping` on the session |
| Unreal | The plugin `GenexMultiplayer` in `Plugins/` (a C++ project to package) | `sdks/unreal/README.md` in the Genex SDK, "Authority rooms" | Blueprint **Get Ping Ms**; C++ `PingMs()` |
| Rust | The crate `genex-multiplayer` (`sdks/rust/genex-multiplayer`) | `sdks/rust/README.md` in the Genex SDK, "Authority rooms" | `ping_ms()` |
| Godot | The addon `addons/genex_multiplayer/` | `sdks/godot/README.md` in the Genex SDK, "Server-authoritative rooms" | `rtt()` only: it has no link-only ping |

In Genex Studio the engine's own plugin installs the Unity package, the Unreal plugin and the Godot
addon into the project and brings its own multiplayer skill for the client: use that skill for the
client and this one for the room. Two limits to design the room around: the Unity and Unreal SDKs and the
native Rust and Godot sessions do not send the `lifts@1` capability, so a room that declares
`config.lifts` refuses their seats (426); and the Godot session ends on a server deploy instead of
rejoining.

## Shipping it

`npx genex preview` and `npx genex publish` ship the room module with the build, and refuse to
ship one that is not ready:

- **Before anything is built**, the module is bundled and validated with the game's own
  `@genex-ai/authority-dev` (the same check as `npx genex-authority-dev validate`). Any failure stops
  the deploy and prints its typed reason; the full report is kept at `.genex/authority/report.json`.
- **Before any game file uploads**, the module and its report go to a private store that the game's
  address never serves, and `server/` is left out of the public build.
- **On Genex's servers the owner needs Genex Pro, unless Genex's free tier is on.** With it off a
  free account is refused with `Room module refused (requires_pro)` and nothing is uploaded; it can still build
  and test everything locally. With it on a free account publishes too, under smaller limits (fewer
  players, rooms and room-hours, at most 60 Hz by default), and once its monthly room time is used
  new rooms are refused until the next period. Say so before the person publishes.
- A preview link plays in rooms apart from the live game, as casual multiplayer's does, and
  `npx genex promote` / `npx genex rollback` move the module together with the build — a rollback can
  restore the previous module alone when only `server/` changed.
