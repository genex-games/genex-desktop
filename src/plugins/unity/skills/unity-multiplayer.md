# Genex multiplayer in a Unity game

Use this when the person wants people to play this Unity game together: online, multiplayer, co-op,
versus, a lobby or matchmaking. A player in the published WebGL build and a player in a Mac or
Windows build of the same game meet in the same rooms.

The Genex skills for three.js games (`genex-threejs-multiplayer` and the other `genex-threejs-*`)
are for web pages built with npm. Their client code doesn't apply to a Unity game: don't add npm
packages, a package.json, or a script to the WebGL page for multiplayer.

## 0. Pick one: the relay or a server room

| | The relay (sections 2 to 4) | A server-authoritative room (section 5) |
|---|---|---|
| Who runs the rules | Each player's copy; Genex's relay passes messages | Genex's servers run the game's room module, `server/room.ts` |
| Cheating | A modified client can say where it is and what it hit | The server decides every move and every hit |
| Fits | Co-op, hangouts, party, turn-based, casual races | Competitive shooters, arenas, car football, ranked play |
| On Genex's servers | Free | Needs Genex Pro for the game's owner |

"Competitive", "ranked", "PvP", "so nobody can cheat" or "server-authoritative" mean a server
room; everything else is the relay. When the person has not said which, ask in one line and say
what each costs. Never mix the two in one game: a server-room game has no `GenexSession`, no host
and no shared objects. The server owns all state.

## 1. Set it up: `unity__multiplayer`

Both paths start here. Call `unity__multiplayer` once. It adds:

- `Packages/com.genex.multiplayer/`: Genex's package (`Genex.Multiplayer`): the relay client and
  the server-room client (`Genex.Multiplayer.Authority`).
- The Colyseus Unity SDK it runs on, in `Packages/manifest.json`. Unity fetches it from Colyseus's
  repository when its editor next comes forward, which needs git on this Mac.
- `Assets/Genex/link.xml`, which keeps IL2CPP builds from stripping what the relay's messages use.
- `Assets/Genex/GenexGame.cs` (and its `.jslib`): `GenexGame.Slug`, the game's Genex project
  wherever the build runs, `GenexGame.ApiUrl`, and for server rooms `GenexGame.LocalRoomUrl` and
  `GenexGame.PageAuthorityUrls`. Keep the game's online code in the default
  assembly (no `.asmdef` of its own) so it can use them.
- `Assets/Resources/GenexSettings.json`: the game's Genex project (`slug`) and API (`apiUrl`).
- The matchmaking you pass, in the game's `genex.json` (Genex reads it when the game is published).
  A server-room game passes none: its room module decides who plays.

Pass `matchmaking` when the game matches players into rooms:

- `{"preset": "open", "config": {"minPlayers": 2, "maxPlayers": 10}}`: a room of up to N players
  with the game's own rules.
- `duel`, `arena` and `teams` each take a `winCondition`: `lastStanding`, `firstToScore`,
  `highScoreInTime` or `firstToFinish`.
- `private` gives invite-code lobbies.

A game has no Genex project until its first publish, and its builds don't need one:
`GenexGame.Slug` takes the project from Genex's Play (`GENEX_GAME`) when Play starts a Mac or
Windows build, and from the published web page. So the builds a publish sends join their rooms with
no second build and no second publish. Only the editor and a build you start yourself read
`GenexSettings.json`: to test online there, publish first, then call `unity__multiplayer` again with
`slug` (`genex__publish-status` names it). Calling the tool again is safe.

After it, bring Unity forward so it resolves the packages, then check that the project compiles
(the unity-editor tools' console).

## 2. Relay: join with one component that owns the session

```csharp
using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Genex.Multiplayer;
using Genex.Multiplayer.Unity;
using UnityEngine;

public sealed class Online : MonoBehaviour
{
    public GenexSession Session { get; private set; }

    public async Task<bool> Join(string playerName)
    {
        var slug = GenexGame.Slug;                       // Play's, the published page's, or GenexSettings.json's
        if (slug == null) return false;                  // not published yet: say so on screen and stay offline
        var options = new GenexConnectOptions { GameId = slug, Name = playerName };
        try
        {
            if (GenexWebGL.Available)
            {
                var auth = await GenexWebGL.RequestAuth();     // the published page's player (guest or signed in)
                options.Urls = auth.RelayUrls;
                options.GetEmbedToken = GenexWebGL.EmbedToken; // a fresh token per join: never store one
            }
            else
            {
                var identity = new GenexNativeIdentity(GenexGame.ApiUrl, slug);
                var ticket = GenexNativeIdentity.TakeLaunchTicket();   // Genex's Play passed one: a signed-in player
                if (ticket != null) await identity.RedeemTicket(ticket);
                else await identity.SignInAsGuest();
                options.Urls = identity.RelayUrls;
                options.GetEmbedToken = identity.TokenProvider;
            }
            Session = GenexPump.Register(await GenexMultiplayer.Connect(options));
            return true;
        }
        catch (Exception e)
        {
            Debug.LogWarning("Online play unavailable: " + e.Message);  // show it on screen too, and keep offline play
            return false;
        }
    }

    private void OnDestroy() { if (Session != null) _ = Session.Leave(); }
}
```

- Read the project only through `GenexGame.Slug`. A game that reads `GenexSettings.json` itself
  stays offline in every copy it publishes before the slug is written.
- `GenexPump.Register` ticks the session every frame and keeps its timers running, even in a hidden
  browser tab.
- When Genex's Play starts a native build, it passes its own API address (`GENEX_API_URL`) and a
  sign-in ticket. `GenexNativeIdentity` takes both by itself, so keep the ticket first and the
  guest second, as above.
- **Matchmaking:** `GenexMatchmaker.Start(options)` gives `QueueChanged`, `Matched` and `Failed`,
  and its `Session` once seated. Read its exact members in
  `Packages/com.genex.multiplayer/Runtime/Core/GenexMatchmaker.cs` rather than guessing.
- Show a "Finding players… N searching" screen from the queue, and a lobby from `Session.Players`.
  Show every failure as words on screen, never an endless spinner, and always keep a way back to
  offline play.

## 3. Relay: share the game

The relay runs no game code. Each client simulates what it owns, and values are `double`, `string`,
`bool`, `List<object>` and `Dictionary<string, object>`. Every number goes out as a `double`, so
read numbers back with `GenexJson.Num(state, "x")`.

- **Your own player:** `Session.SetState(new Dictionary<string, object> { ["x"] = (double)p.x, … })`
  on a ~15 Hz timer, never every frame. Use `SnapState` for a respawn or teleport.
- **Everyone else:** each frame, for every `player` in `Session.Players.Values` that is not
  `IsMe`, draw `player.State`. It is already smoothed. Use `StateRaw` for hit tests.
- **The room's state:** `SetShared(key, value)` / `GetShared(key)` for the score, the round or the
  map seed. Let the host write it.
- **Things one client runs:** bots, the ball, doors.
  1. `var r = await Session.Claim(id, new ControlOptions { HostAuthority = true })`.
  2. When `r.Accepted`, call `SetObject(id, …)` on a timer.
  3. Other clients draw `GetObject(id).State`.
  4. When the host changes, the new one claims what the old one ran.
- **Moments:** `Send("shot", payload)` and `On("shot", handler)`.
- **Inputs to the host:** `SendInput`, which the host receives as `InputReceived`.
- **Host-only simulation:** run it from `Session.OnHostTick(hz, dtMs => …)`; `IsHost` says who
  hosts.

Trust is casual. Let the shooter decide a hit and tell the victim's owner (`Send`). The owner applies
the damage to its own state.

## 4. Relay: build, check and test

- **WebGL:** build into `web/` at the game's root with **Compression Format: Disabled**, because
  Genex hosting serves no compressed files. The published page gives the build its player; in
  Genex's preview there is none, so online play says it's unavailable and offline play stays.
- **Testing on the web:** publish a draft (`genex__publish`) and test on the draft link as two
  *different* players: a normal and a private window, or a friend. Draft players meet only draft
  players.
- **Native builds** (Mac, Windows) join only the *published* game: as a guest, or as the signed-in
  player when Genex's Play starts them.
- **Testing two players on this Mac:** once the game is published, start two copies of the Mac
  build from the terminal with the project in their environment, for example
  `GENEX_GAME=<slug> "unity/Builds/Mac/<Game>.app/Contents/MacOS/<Game>" &` twice, and play both
  until each sees the other. No rebuild is needed for this.
- The WebGL and native builds of the same published game meet in the same rooms.
- Until two players have met in one room, say so plainly: never tell the person online play works
  when it has only compiled.

## 5. Server-authoritative rooms

The room is the game's own code on Genex's servers. Players send input; the server moves every
body, judges every shot against where the shooter saw its target, and sends what everyone draws.
Your own body is predicted with the room's movement preset, so moving feels instant.

### The room module and its block

1. Read the card: `genex__skill {"name":"genex-authoritative-multiplayer"}`, then its
   `references/module-api.md`, `references/presets.md` and `references/room-template.md`. Its
   rules for the room module, the `authority` block and testing apply here as written. Its
   client half (`connectAuthority`, npm packages, `session.frame`) is the web's: the Unity client
   is below.
2. Write `server/room.ts` at the game's root (beside the Unity project, never in `Assets/`):
   `export default` a room with `contract: 1`, `config` (`tickHz`, `maxPlayers`, `preset`),
   `init`, `onJoin`, `onLeave`, `onInput` and `step`. It imports nothing from a package. Keep
   everything only the server uses in `server/`.
3. Declare it in `genex.json` at the game's root, beside any other setting:
   `{"authority": {"module": "server/room.ts", "tickHz": 30, "maxPlayers": 8}}`. A
   `firstperson` room asks for `tickHz` 60.
4. Run `genex__room {"action":"validate"}` after every change to the module, and fix each
   failure before anything else. It is the publish gate's own check.

### The Unity client: one component owns the session

```csharp
using System;
using System.Threading.Tasks;
using Genex.Multiplayer;
using Genex.Multiplayer.Authority;
using Genex.Multiplayer.Unity;
using UnityEngine;

public sealed class Arena : MonoBehaviour
{
    public GenexAuthoritySession Session { get; private set; }
    private float aimYaw;                                // the player's aim, radians, from your own camera code

    public async Task<bool> Join(string playerName)
    {
        var local = GenexGame.LocalRoomUrl;               // Studio's local room (genex__room), or null
        var slug = GenexGame.Slug ?? (local != null ? "local" : null);
        if (slug == null) return false;                  // not published yet: say so on screen and stay offline
        var options = new GenexAuthorityOptions { GameId = slug, Name = playerName };
        try
        {
            if (local != null) options.Url = local;      // a loopback room needs no sign-in
            else if (GenexWebGL.Available)
            {
                options.Urls = GenexGame.PageAuthorityUrls;      // the published page's room servers
                options.GetEmbedToken = GenexWebGL.EmbedToken;   // a fresh token per join: never store one
            }
            else
            {
                var identity = new GenexNativeIdentity(GenexGame.ApiUrl, slug);
                var ticket = GenexNativeIdentity.TakeLaunchTicket();
                if (ticket != null) await identity.RedeemTicket(ticket);
                else await identity.SignInAsGuest();
                options.Urls = identity.AuthorityUrls;
                options.GetEmbedToken = identity.TokenProvider;
            }
            if (options.Url == null && (options.Urls == null || options.Urls.Length == 0)) return false;
            Session = GenexPump.Register(await GenexAuthority.Connect(options));
            Session.Disconnected += code => Debug.LogWarning("Left the room: " + code);   // show it on screen too
            return true;
        }
        catch (GenexJoinException e)
        {
            // NotEntitled: the owner has no Genex Pro. ModuleUnavailable: publish again. RoomQuota: try later.
            Debug.LogWarning("Online play unavailable: " + e.Message);
            return false;
        }
        catch (Exception e)
        {
            Debug.LogWarning("Online play unavailable: " + e.Message);
            return false;
        }
    }

    private void Update()                                // GenexPump ran Session.Frame() before this
    {
        if (Session == null || !Session.IsReady) return;
        Session.Input.MoveX = Input.GetAxis("Horizontal");
        Session.Input.MoveY = Input.GetAxis("Vertical");
        Session.Input.Yaw = aimYaw;                      // radians
        Session.Input.Buttons = Input.GetButton("Fire1") ? 1 : 0;
        foreach (var e in Session.Entities.Values)       // yours predicted, everyone else 100 ms behind
            Draw(e.Id, new Vector3((float)e.X, (float)e.Z, (float)e.Y), (float)e.Yaw, (float)e.Hp, e.IsMine);
    }

    private void Draw(string id, Vector3 at, float yaw, float hp, bool mine) { /* your scene: place id's object */ }

    private void OnDestroy() { if (Session != null) _ = Session.Leave(); }
}
```

- **The server decides; the client asks.** Health, score, kills, respawns and rounds change only in
  the room module. Draw them from `Session.Entities` (`Hp`, `Flags`, `Data`) and the module's
  events (`Session.On("shot", data => …)`). Never move your own body yourself: write the stick and
  aim into `Session.Input` and draw `Session.Me`.
- **Axes.** The room's ground is x/y and +z is up; Unity is y-up. Draw a room point as
  `new Vector3((float)x, (float)z, (float)y)` and send Unity directions back the same way.
- **Firstperson and vehicle rooms** move bodies through a collision world of boxes and ramps the
  module exports as `world`. Keep it in one JSON file the module imports and the game ships as a
  `TextAsset`, then `Session.SetWorld(GenexFirstpersonWorld.FromJson(file.text))`. If
  `Session.Prediction.Reason` is `"world_mismatch"`, the two copies differ. Read the exact members
  in `Packages/com.genex.multiplayer/README.md` (Firstperson, Vehicle, Projectiles) rather than
  guessing.
- **Physics rooms** draw their bodies as the server sends them: Studio's copy of the package ships
  no native physics core, so bodies near you are not predicted.

### Test it on this computer, then publish

- `genex__room {"action":"start","bots":3}` serves the room on this computer with bots, and
  `genex__room {"action":"status"}` answers its `url`, its last REPORT, its `ctx.log` lines and
  errors. Stop it with `genex__room {"action":"stop"}`.
- **The WebGL build** in `web/` joins it in Studio's preview: the room hands the preview its
  address, which `GenexGame.LocalRoomUrl` reads. Never write the address into the game.
- **A Mac build** joins it when started with the address:
  `GENEX_AUTHORITY_URL=<url> "unity/Builds/Mac/<Game>.app/Contents/MacOS/<Game>" &`. The editor
  joins only when it was started with `GENEX_AUTHORITY_URL`, so test in a build.
- Play against the bots and say what you saw. Until a player has moved in a room and seen the bots,
  never tell the person it works.
- `genex__publish {"operation":"draft"}` sends the room module with the WebGL build: Studio stages
  `server/` beside the build, never in it, and the publish validates the module before any game
  file moves. The owner needs Genex Pro: a free account is refused with `authority_requires_pro`.
  Test the draft as two different players. Never report the game as online before a draft passed.
- Native builds join the published game's rooms through `GenexNativeIdentity.AuthorityUrls`, as in
  the code above.

