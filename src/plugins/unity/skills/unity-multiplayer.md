# Genex multiplayer in a Unity game

Use this when the person wants people to play this Unity game together: online, multiplayer, co-op,
versus, a lobby or matchmaking. Genex multiplayer runs on Genex's relays, the same ones Genex's web,
Godot and Unity games use. A player in the published WebGL build and a player in a Mac or Windows
build of the same game meet in the same rooms.

The Genex skills for three.js games (`genex-threejs-multiplayer` and the other `genex-threejs-*`)
are for web pages built with npm. They don't apply to a Unity game: don't add npm packages, a
package.json, or a script to the WebGL page for multiplayer.

## 1. Set it up: `unity__multiplayer`

Call `unity__multiplayer` once. It adds:

- `Packages/com.genex.multiplayer/`: Genex's package (`Genex.Multiplayer`).
- The Colyseus Unity SDK it runs on, in `Packages/manifest.json`. Unity fetches it from Colyseus's
  repository when its editor next comes forward, which needs git on this Mac.
- `Assets/Genex/link.xml`, which keeps IL2CPP builds from stripping what the relay's messages use.
- `Assets/Genex/GenexGame.cs` (and its `.jslib`): `GenexGame.Slug`, the game's Genex project
  wherever the build runs, and `GenexGame.ApiUrl`. Keep the game's online code in the default
  assembly (no `.asmdef` of its own) so it can use them.
- `Assets/Resources/GenexSettings.json`: the game's Genex project (`slug`) and API (`apiUrl`).
- The matchmaking you pass, in the game's `genex.json` (Genex reads it when the game is published).

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

## 2. Join: one component owns the session

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

## 3. Share the game

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

## 4. Build, check and test

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
