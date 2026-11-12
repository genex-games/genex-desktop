# Server-authoritative multiplayer in this Unreal game

The person wants competitive or cheat-proof online play: the **server decides** everything that
matters (movement, hits, score); each player only sends input. Genex runs the room module you
write on its servers, and this Unreal game is its client. Never mix this with Genex's relay
(`Genex Multiplayer Subsystem`, Join Genex Room): one game uses one or the other.

The room side is the same for every engine: read `genex__skill {"name":"genex-authoritative-multiplayer"}`
first for the module's API, presets and rules. Only the client below is Unreal's.

## 1. Add Genex's Unreal plugin

`unreal__multiplayer` copies Genex's `GenexMultiplayer` plugin, shipped with Genex at a pinned
version, into `unreal/Plugins/GenexMultiplayer`, turns it on in the .uproject, and adds the
Colyseus core it links (on a Mac, a one-time download Genex checks and keeps; on Windows, the
build Genex ships with itself; a Mac also gets that Windows build, so Genex can build the game for
Windows). Never download the plugin, its core or any SDK yourself, and never edit the plugin's
files: a later call replaces them. Its answer says whether the core is ready (`core.ready`); when it
isn't, `core.why` says why and the plugin won't build until it is. On a Mac, `windows.ready` says
whether the Windows core is in too; a project whose plugin was added before it gets it by calling
`unreal__multiplayer` again.

Then `unreal__cpp-status`: a game that uses the plugin must have a C++ module to package
(`unreal__add-cpp-module` when it has none).

## 2. Write the room

- `server/room.ts` (or `.js`), in the game folder beside `unreal/`, exporting the module the
  authoritative card describes. Pick its preset by the game: `firstperson` for a shooter on foot,
  `vehicle`, `projectile`, or `topdown`. Rooms measure in metres.
- `genex.json` at the game folder's root: `{"authority": {"module": "server/room.ts", "tickHz": 60, "maxPlayers": 8}}`.
  Keep it valid JSON, and put no package.json at the game's root: Genex would read that instead,
  and refuses the publish and `genex__room` by name.
- `genex__room {"action":"validate"}` after every change; fix each failure before anything else.

## 3. Write the client

Blueprint, on the game instance's `Genex Authority Subsystem`:

- **Join** with `Genex Authority Options` (leave Url and Urls empty: Genex names the server; set
  `Game Id` only to override the project's Slug). Bind **On Connected**, **On Refused**,
  **On Disconnected** and **On Event** first.
- **Regions need nothing.** A join first asks every region within reach for a room that already
  has players, nearest first, and opens a room in the nearest region only when none has one, so a
  player in Asia joins a friend's room in Europe instead of waiting alone. Three options change it,
  and most games set none: `Max Ping Ms` (350, the farthest region asked, as round-trip ping),
  `Region Rule` (`Nearest` keeps a player in their nearest region) and `Region` (a region the
  player picked by name: `asia`, `eu` or `us`; offer it as a setting when players ask to choose).
- **A player waiting alone is moved to players.** When two people start at the same moment in two
  empty regions, one of them is moved into the other's room within seconds. **On Rejoined** fires
  and **Was Moved** is true inside its handler: the room is a new one, so redraw from its state
  and say so ("Found players, joining their room"). The option `Regroup` off keeps a player where
  they are; a private room, a join by code, a pinned `Region` and the rule `Nearest` never move
  anyone. **Get Region** names the region the seat is in.
- **A region picker** shows what **Measure Genex Regions** returns: its **Measured** pin fires once
  with every region (`Region`, `Ping Ms`, `Answered`), measured without joining; sign in first.
  Put the player's choice in `Region`.
- **A friend's room code works from any region:** the join finds the region that holds the room.
- Every frame: **Set Input** (`Move X/Y/Z`, `Yaw`, `Pitch`, `Buttons`; for `firstperson` use
  **Make Firstperson Input**), then draw from **Get Me** (your own entity, predicted) and
  **Get Entities** (everyone else, 100 ms behind on the server's timeline). Never move a networked
  actor from local logic: move it to what these return.
- Locations are converted with the project's `UnitsPerMeter` (100: Unreal's centimetres).
- **On Refused** hands a `Refusal` (`EGenexJoinRefusal`), a `Code` and a `Message`: switch on the
  `Refusal`, with a line of its own for each. `Unauthorized` (401) means the player could not sign
  in, which includes no network ("Couldn't sign in to Genex. Check your connection."); `Other` with
  code 0 means no server was named or none answered; `Capacity` (503) is retried. Never fold them
  into one catch-all, and log `Message`: it names the reason.

A Shipping app logs nothing of Unreal's. On a Mac, macOS's own log shows what it refused the game
(a sandbox denial reads "Sandbox restriction" or "Operation not permitted"):
`/usr/bin/log show --last 5m --style compact --predicate 'process == "<Name>-Mac-Shipping"'`.

C++ games include `GenexAuthoritySubsystem.h` and call the same functions on
`GetGameInstance()->GetSubsystem<UGenexAuthoritySubsystem>()`; `Core()` is the engine-free
`genex::AuthoritySession` for the rest. The plugin's public headers
(`unreal/Plugins/GenexMultiplayer/Source/GenexMultiplayer/Public/`) document each call.

Project settings live in `unreal/Config/DefaultGame.ini`:

```ini
[/Script/GenexMultiplayer.GenexSettings]
Slug=my-game
```

Quote any URL there (`ApiUrl="https://api.genex.games"`): Unreal cuts an unquoted value at `//`.
Never write a local room's address into the game.

## 4. Play it against bots on this computer

1. After adding the plugin or changing C++, rebuild with Unreal closed (in a chat `unreal__quit-editor`,
   then `unreal__open-editor` with build: true; in a Loop, Genex's restart): Unreal builds the plugin.
2. `genex__room {"action":"start"}`: its bots leave a seat free for the editor's Play beside the
   preview (a `bots` count that fills the room is refused by name). While it runs, Genex names the room in the game's
   `.studio/authority.json`; the plugin hands it to Play, which joins it with no account.
3. Play in the editor (2 to 4 players), then `genex__room {"action":"status"}` for the room's
   report, logs and errors; `rooms` above 1 means a player did not fit and is in another room. `genex__room {"action":"stop"}` when done.

Say what you saw. Never report the game as online before a published draft of it passed.

## 5. Publish

Players install an Unreal game as an app, so the person publishes it from the stage strip's
Publish with the app `unreal__package-game` made; `genex__publish` refuses an Unreal game, so never
call it. That Publish carries the room module: before any app goes, Genex stages `server/` (and
every game file it imports), runs the same validation as `genex__room`, stores the module in
Genex's private module store and makes it what the game's live rooms run. A module that fails the
gate fails the publish and no app goes. `genex__publish-status` reports it in `job.room`: validated,
uploaded and the module's sha, or the gate's failures. The owner needs Genex Pro for
server-authoritative rooms. The first publish names the game's slug (`genex__publish-status`): put
it in `Slug` above, then `unreal__package-game` and ask the person to publish again so the app
players install joins its rooms. Package only with `unreal__package-game`: on a Mac it lets the app
reach the network, while a package made from Unreal's own Platforms menu keeps Unreal's Shipping
sandbox, which has no network, and its players never get online. Publish refuses such a Mac app
before anything goes ("can't reach the internet"): package it again with `unreal__package-game`.
