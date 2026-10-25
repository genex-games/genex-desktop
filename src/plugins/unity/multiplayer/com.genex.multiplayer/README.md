# Genex Multiplayer for Unity (`com.genex.multiplayer`)

A thin client for the Genex relay, [protocol 3](../../packages/multiplayer/PROTOCOL.md), layered on the official Colyseus Unity SDK 0.18.8. The protocol is normative; this package follows it.

- `Runtime/Core/`: the Genex layer. It is plain C# with no `UnityEngine` references, and it compiles against the NuGet `Colyseus` 0.18.8 (netstandard2.1).
- `Runtime/Unity/` and `Runtime/WebGL/`: the Unity glue. A frame pump and the WebGL identity bridge.

## Install

1. Add the official Colyseus SDK 0.18.8. In `Packages/manifest.json`, the `upm` branch commit of 0.18.8 is:
   ```json
   "io.colyseus.sdk": "https://github.com/colyseus/colyseus-unity-sdk.git#7306c8ee4be7e78984baf0837df5ea8125154820"
   ```
   The release's `Colyseus_Plugin.unitypackage` works too. UPM cannot declare a git dependency, so you add it yourself.
2. Add this package, either from disk (`file:../../sdks/unity`) or by git URL with `?path=sdks/unity`.

You need Unity 2021.3 or later, for C# 8 and the `makeDynCall` jslib macro.

## Quickstart

```csharp
var session = GenexPump.Register(await GenexMultiplayer.Connect(new GenexConnectOptions {
    Urls = relayUrls, GameId = "my-game", Name = "ada",
    GetEmbedToken = GenexWebGL.EmbedToken,      // or nativeIdentity.TokenProvider
}));
session.SetState(new Dictionary<string, object> { ["x"] = 1.0, ["y"] = 2.0 });   // on a ~15 Hz tick
foreach (var p in session.Players.Values) if (!p.IsMe) Draw(p.Id, p.State);        // smoothed
var r = await session.Claim("ball");                                                // r.Accepted, r.Reason
if (r.Accepted) session.SetObject("ball", new Dictionary<string, object> { ["x"] = 3.0 });
```

There is a full sample under `Samples~/Quickstart`; import it from the Package Manager.

Values use one model: `null`, `bool`, `double` (every number), `string`, `List<object>` and `Dictionary<string, object>`. Every number goes out as msgpack float64. The layer never sends int64 or float32. Read values with `GenexJson.Num/Str/Bool/Map/List`.

## API

| Area | `GenexSession` members |
|---|---|
| Connect | `GenexMultiplayer.Connect(opts)`, `CreatePrivate(opts)`, `JoinPrivate(opts, code)`. A refused join throws `GenexJoinException(Code)`: 401, 403, or 426 (do not retry). |
| Pump | `Tick()` once per frame on the main thread, plus `TickTimers()` from a wall-clock timer (heartbeat, host ticks, timeouts). `GenexPump.Register(session)` does both for you. |
| Players | `Players`, `Me` → `GenexPlayer {Id, Name, Uid, Team, Connected, AvatarUrl, IsMe, Posed, Epoch, State, StateRaw}` |
| My state | `SetState(dict)`, `SnapState(dict)`. `__t` is stamped for you and stripped on receipt. |
| Shared | `GetShared(key)`, `SetShared(key, value)`, `SharedKeys`, `SharedChanged` |
| Objects | `Claim/Release/Destroy(id, ControlOptions{HostAuthority, Optimistic, TimeoutMs})` → `Task<ObjectControlResult>`, `SetObject`, `SnapObject`, `GetObject(id)` → `{Owner, Seq, Epoch, IsMine, State, StateRaw}` |
| Host | `Host`, `IsHost`, `HostChanged`, `OnHostTick(hz, dtMs => …)`, `SendInput(x)`, `InputReceived`, `SetRoomOpen(bool)` |
| Events | `Send(type, payload)` (to the other clients), `On(type, handler)` |
| Chat | `SendChat(text)`, `ChatReceived`, `ChatHistory`, `Mute/Unmute`. Render only lines that arrive; your own line comes back too. |
| Lifecycle | `Reconnecting(attempt, code)`, `Reconnected`, `Disconnected(code)`, `RateDropped`, `ServerRestart`, `Leave()` |
| Clock (§16) | `ClockAvailable`, `ServerNow`, `Rtt`, `ClockSynced`, `TimeUntil(epochMs)` |
| Match | `GenexMatchmaker.Start(opts)` → `QueueChanged`, `Matched`, `SearchRetrying`, `Failed`, `Disconnected`, `Session`, `Cancel()`, `Tick()`/`TickTimers()`. On the session: `Match`, `MatchStarted/Ended/Requeue`, `ReportScore/Eliminated/Finish` |
| Voice | `VoiceSupported == false`. Voice is browser WebRTC only. |

### Behaviour

- **Reconnect.** The SDK's in-place reconnect uses the §8 settings: `minUptime 0`, 125/100/4000 ms, 9 retries, no queue. After it, the post-reconnect sequence runs: wait for the first full state (2 s cap), rebase history if the gap was over 1 s, resend pending controls with the same `requestId`, re-request chat, then raise `Reconnected`. `IsHost` stays false until that sequence completes. Nothing is ever sent on a closed socket.
- **Interpolation.** Remote players and objects use §10, on each sender's clock: a per-sender min-offset window, adaptive delay from 90 to 300 ms, extrapolation up to 250/150 ms, output ease with τ 30/70 ms, and a soft handoff on a `seq` change. While you own an object its stream is kept at your live pose, so if you lose it the handoff glides from where it is. Posed players use §10.1. Read `StateRaw` for gameplay.
- **Views are rewritten in place.** `State` is the same dictionary every frame, updated by `Tick()` (about 230 bytes of allocation per frame for five moving streams, all of it boxed numbers that changed). Copy it if you need a frame's values later.
- **Objects.** An accepted `Claim` makes you the owner at once: `SetObject` right after `await Claim` is published, before the relay's state patch arrives.
- **Matchmaking.** Network errors and 5xx are retried for as long as you search, with backoff capped at 8 s, so a relay deploy (§14) does not end the search. `Failed` fires only for 426, for a 400/401/403 that repeats with a fresh token, or for bad options. A match seat that closes with 4401, 4409, 4002 or 1000 stops (`Disconnected`); any other close searches again.
- **Typed pose (§6.6).** It is experimental and off by default (`GenexConnectOptions.Pose`). Posed peers are always decoded.

## Identity

Read a fresh `embed:play` token before every join (§3.2). Never cache or log it. Pass a provider as `GetEmbedToken`:

- **WebGL.** Use `GenexWebGL.EmbedToken` / `RequestAuth()`. Your WebGL template must expose the embed SDK:
  ```html
  <script type="module">
    import * as genexEmbed from "https://cdn.jsdelivr.net/npm/@genex-ai/embed-sdk@0.33.0/+esm";
    genexEmbed.initEmbed({ slug: "my-game", apiUrl: "https://api.genex.games", dashboardOrigins: ["https://genex.games"] });
    window.genexEmbed = genexEmbed;
  </script>
  ```
- **Native.** `GenexNativeIdentity` implements [CLI_INTEGRATION.md §6b](../../CLI_INTEGRATION.md):
  1. `TakeLaunchTicket()` + `RedeemTicket(t)` when launched by Genex.
  2. Otherwise `SignInAsGuest()`, or the device code flow: `StartDeviceSignIn()` and then `PollDeviceSignIn()`.

  `TokenProvider` refreshes the token through `/api/embed/session/refresh`.

  When a launcher sets `GENEX_API_URL`, it replaces the API base you pass to the constructor (`ApiBase` shows
  the one in use). Genex Desktop's Play points it at its local gateway when it runs the game in its sandbox;
  the `RelayUrls` that come back already lead through the gateway.

## Verify (no Unity needed)

`Tests~/GenexSmoke` is a net8.0 console app. It compiles `Runtime/Core` against the pinned NuGet packages and drives two or more real sessions against a local relay.

```bash
cd "sdks/unity/Tests~/GenexSmoke" && ./fetch-deps.sh     # sha256-pinned nupkgs into .feed/ (gitignored)
dotnet build                                            # any .NET 8 SDK (UE 5.7 bundles one)
dotnet run -- play  ws://127.0.0.1:<port> [--expect-clock]   # bench relay: netcode-bench bootRelay()
dotnet run -- match ws://127.0.0.1:<port> http://127.0.0.1:<mint>   # real relay + JWT mint (play/queue/match)
```

The same binary is the [conformance driver](../../packages/netcode-bench/DRIVER.md). Run from the repo root after `dotnet build`:

```bash
GENEX_CONFORMANCE_DRIVERS=unity \
GENEX_DRIVER_UNITY='dotnet "sdks/unity/Tests~/GenexSmoke/bin/Debug/net8.0/GenexSmoke.dll" driver' \
  pnpm --filter @genex/netcode-bench test:conformance
# feel gates with this client on one side: add BENCH_FEEL_OBSERVER=unity (or BENCH_FEEL_SENDER=unity) to test/feel.test.ts
```

## Limits

- `Runtime/Unity` and `Runtime/WebGL` are only type-checked against stub `UnityEngine` types. They have not been run in Unity or in a WebGL build.
- `GenexNativeIdentity` has not been run against a live API.
- **Background.** The heartbeat and host ticks run from `TickTimers()`. On WebGL, `GenexPump` calls it from a browser `setInterval` (50 ms; browsers throttle a hidden tab to about 1 Hz), so a hidden host keeps the room alive. Elsewhere it runs from the player loop, and `GenexPump` sets `Application.runInBackground`. A mobile app the OS suspends stops everything, and the relay fails over.
- **No voice.**
- **Conformance.** The core passes every §15 fixture through its driver (`dotnet GenexSmoke.dll driver`, see below): alone, and in mixed rooms with the TypeScript driver in both role orders. It passes `feel.test.ts` (8 gates) as sender and as observer, and the conformance suite's own feel checks with the relay clock on and off. The ex-owner handoff, handoff and mixed-ping gates call the TypeScript SDK directly, so they have not run against this client; the smoke test covers its ex-owner path instead. All of this is the core on .NET 8, not inside Unity, IL2CPP or a WebGL build.
