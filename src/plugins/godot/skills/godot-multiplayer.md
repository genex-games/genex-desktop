# Genex multiplayer in a Godot game

Use this when the person wants people to play this Godot game together: online, multiplayer, co-op,
versus, a lobby or matchmaking. Genex multiplayer runs on Genex's relay, the same one Genex's web
games use, so a player in the published web build and a player in a native build (macOS, Windows,
Linux) of the same game meet in the same rooms.

The Genex skills for three.js games (`genex-threejs-multiplayer` and the other `genex-threejs-*`
skills) are for web pages built with npm. They don't apply to a Godot game: never add a
package.json, npm packages, an HTML shell or a script to `web/` for multiplayer. `web/` is Godot's
build.

## 1. Set it up: `godot__multiplayer`

Call `godot__multiplayer` once. It adds:

- `addons/genex_multiplayer/` and its `GenexMultiplayer` autoload;
- the Colyseus GDExtension that native builds connect with (`addons/colyseus/`);
- the game's Genex project and API in `project.godot`'s `[genex]` section;
- the matchmaking you pass, written into the game's `genex.json` (Genex reads it when the game is
  published);
- a setting in the Genex Web preset that loads Genex's multiplayer bridge into the web build.

Pass `matchmaking` when the game matches players into rooms:

- `{"preset": "open", "config": {"minPlayers": 2, "maxPlayers": 10}}`: a room of up to N players
  with the game's own rules. The room goes from waiting to playing at `minPlayers`.
- `duel` (1v1, winner stays), `arena` (free-for-all, join any time) and `teams` (balanced N v N)
  each take a `winCondition`: `lastStanding`, `firstToScore`, `highScoreInTime` or
  `firstToFinish`.
- `private` gives invite-code lobbies.

A game has no Genex project until its first publish, and its builds don't need one: Genex's Play
names it to a native build (`GENEX_GAME`) and the published page to the web build
(`window.__GENEX__.slug`), so the builds a publish sends join their rooms with no second build. Only
the editor and a build you start yourself read `project.godot`: to test online there, publish
first, then call `godot__multiplayer` again with `slug` (`genex__publish-status` names it). Calling
the tool again is safe.

## 2. Join: one script owns the session

```gdscript
# online.gd: an autoload or the game's own node
extends Node

const TICK := 1.0 / 15.0          # publish own state 15 times a second; render every frame

var identity                       # native only: Genex sign-in for the relay

func slug() -> String:
	var from_play := OS.get_environment("GENEX_GAME")   # Genex's Play starting a native build
	if from_play != "":
		return from_play
	if OS.has_feature("web"):
		var from_page = JavaScriptBridge.eval("(window.__GENEX__ && window.__GENEX__.slug) || ''", true)
		if str(from_page) != "":
			return str(from_page)
	return str(ProjectSettings.get_setting("genex/slug", ""))

func start_online() -> bool:
	var game := slug()
	if game == "":
		return false              # not published yet: keep the offline / bots mode
	var opts := {"game_id": game, "mode": "matchmake", "name": "Player"}
	if not OS.has_feature("web"):
		identity = preload("res://addons/genex_multiplayer/identity.gd").new()
		add_child(identity)
		identity.api_url = str(ProjectSettings.get_setting("genex/api_url", "https://api.genex.games"))
		# Launched from Genex: a signed-in ticket. Otherwise a guest of the published game.
		if not await identity.from_launcher(game) and not await identity.guest(game):
			return false
		opts["urls"] = identity.relay_urls
		opts["identity"] = identity.provider()   # called before EVERY join: never store a token
	GenexMultiplayer.join(opts)
	return true
```

- On the web, the page's Genex player (a guest or a signed-in player) is used automatically. The
  `identity` and `urls` options are native-only.
- Read the project only through `slug()` as above. A game that reads `project.godot` alone stays
  offline in every native copy it publishes before the slug is written.
- When Genex's Play starts the game on this Mac, the addon reaches Genex through Play's gateway
  (`GENEX_API_URL`) and signs the player in with Play's ticket. `from_launcher` takes it. Keep
  `from_launcher` first and `guest` second, as above.
- `mode`:
  - `"matchmake"` uses the queue, the seat and the match room;
  - `"play"` joins one shared room per game (a hangout, a persistent world);
  - `"create"` / `"join_by_id"` with `code` are private lobbies.
- Listen to the signals. Lifecycle: `connected(session_id)`, `error(code, message)`,
  `disconnected(code)`, `reconnecting(attempt, code)`, `reconnected()`. Players and the host:
  `player_joined(id, state)`, `player_left(id)`, `host_changed(host_id)`. Shared state and events:
  `shared_changed(key, value)`, `message(type, data)`. Matchmaking: `queue_update(position, size)`,
  `match_state_changed(state)`.
- Show a "Finding players… N searching" screen from `queue_update`, and a lobby from `players()`.
  Show every failure as words on screen (`error`, `disconnected`), never an endless spinner, and
  always offer a way back to the offline mode.

## 3. Share the game

The relay runs no game code. Each client simulates what it owns, and everything synced goes
through four things:

- **Your own player:** `GenexMultiplayer.set_me({x, y, z, yaw, hp, ...})` on a 15 Hz timer, and
  `snap_me(...)` for a respawn or teleport. Keep it a flat dictionary of numbers, strings and
  booleans.
- **Everyone else:** each frame, draw `GenexMultiplayer.players()[id].state` for every player whose
  `is_me` is false. That state is already smoothed. Use `state_raw` for hit tests.
- **The room's state:** `shared_set(key, value)` / `shared_get(key)` for the score, the round,
  the clock or the map seed. The last writer wins, so let the host write it.
- **Things one client runs:** NPCs, bots, the ball, doors.
  1. `var r = await GenexMultiplayer.claim(id, true).done` (the host claims with host authority).
  2. `object_set(id, {...})` on a timer.
  3. Other clients draw `get_object(id).state`.
  4. React to `object_changed(id, owner)`: when the host changes, the new host claims what the old
     one ran.
- **Moments:** `send("shot", {...})` reaches every other client as `message(type, data)`. Names
  starting with `__`, `match:`, `state` or `obj` are reserved.
- **Inputs to the host:** `send_input({...})` reaches only the host, as `input_received`.

The host is `is_host()`. Run host-only simulation only while it is true, from a timer, with dt
clamped to 250 ms. The relay elects a new host when the host leaves.

Trust is casual. Let the shooter decide a hit and tell the victim's owner (`send`). The owner
applies the damage to its own state, so every client agrees.

## 4. Check and test

- Call `godot__check` after each change. In Genex's preview the game has no Genex page, so online
  play can't run there: the online button should say why and leave the offline mode working.
- The web build plays online on its Genex page. Publish a draft (`genex__publish`), then test it
  on the draft link as two *different* players: a normal and a private window, or a friend. Two
  tabs on one account share one seat. Draft players meet only draft players.
- Native builds join only the *published* game, as a guest or with a ticket from Genex. Draft rooms
  are web-only.
- The web and native builds of the same published game meet in the same rooms.
