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
Colyseus core it links (on a Mac, a one-time download Genex checks and keeps). Never download the
plugin, its core or any SDK yourself, and never edit the plugin's files: a later call replaces them.
Its answer says whether the core is ready; on Windows it is not yet, so build the client on a Mac.

Then `unreal__cpp-status`: a game that uses the plugin must have a C++ module to package
(`unreal__add-cpp-module` when it has none).

## 2. Write the room

- `server/room.ts` (or `.js`), in the game folder beside `unreal/`, exporting the module the
  authoritative card describes. Pick its preset by the game: `firstperson` for a shooter on foot,
  `vehicle`, `projectile`, or `topdown`. Rooms measure in metres.
- `genex.json` at the game folder's root: `{"authority": {"module": "server/room.ts", "tickHz": 60, "maxPlayers": 8}}`.
- `genex__room {"action":"validate"}` after every change; fix each failure before anything else.

## 3. Write the client

Blueprint, on the game instance's `Genex Authority Subsystem`:

- **Join** with `Genex Authority Options` (leave Url and Urls empty: Genex names the server; set
  `Game Id` only to override the project's Slug). Bind **On Connected**, **On Refused**,
  **On Disconnected** and **On Event** first.
- Every frame: **Set Input** (`Move X/Y/Z`, `Yaw`, `Pitch`, `Buttons`; for `firstperson` use
  **Make Firstperson Input**), then draw from **Get Me** (your own entity, predicted) and
  **Get Entities** (everyone else, 100 ms behind on the server's timeline). Never move a networked
  actor from local logic: move it to what these return.
- Locations are converted with the project's `UnitsPerMeter` (100: Unreal's centimetres).

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
2. `genex__room {"action":"start","bots":3}`. While it runs, Genex names the room in the game's
   `.studio/authority.json`; the plugin hands it to Play, which joins it with no account.
3. Play in the editor (2 to 4 players), then `genex__room {"action":"status"}` for the room's
   report, logs and errors. `genex__room {"action":"stop"}` when done.

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
players install joins its rooms.
