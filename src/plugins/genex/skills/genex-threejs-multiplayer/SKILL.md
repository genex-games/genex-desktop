# Genex multiplayer in AI Game Studio

You are building inside AI Game Studio. Below the upstream marker is Genex's multiplayer card,
unchanged. Where it disagrees with this preface, this preface wins.

## Multiplayer works only on the published Genex draft

- Studio's preview is single-player. It opens a game that uses `@genex-ai/embed-sdk` in local
  test mode (`?genex_local_test=1`): the relay gets no credential there, so `connect()` and
  `matchmake()` fail by design. Rendering, controls and feel can still be checked in the preview.
- Check prerequisites before building online features: a package-managed project, the pinned
  SDKs, and an authorized hosted test route. Request both SDKs in one approval with
  `genex__package {"package":"@genex-ai/multiplayer"}` (it includes embed-sdk). After approval,
  build the game; publish a draft with
  `genex__publish {"operation":"draft"}`; wait with `genex__publish-status`; then test on the draft
  link. Only the owner can open a draft, so hand the link to the user to try in two tabs; a friend
  can join only once the game is published to the gallery. Until someone has played the draft,
  say plainly that multiplayer was not exercised.
- Studio installs the version it pins, which satisfies the card's `^0.16.0`. Never run
  `npm i` for these packages yourself.
- A game made from Studio's template has no `package.json` (it loads three.js through an import
  map), so it cannot add these packages. Tell the user multiplayer needs a game with its own
  package manager and build; never copy the SDK into the game by hand.

- If approval is declined or times out, or the hosted test route is unavailable, report the
  specific blocker. Preserve local play; do not retry without changed authorization or claim
  multiplayer works. Finish independent required work before optional visual polish.

## Config without `genex init`

Studio never runs `genex init`, so the game starts without `src/genex.config.ts` or `.env`. After
the first draft, `genex__publish-status` reports the game's `slug`. Write the config yourself,
then publish a new draft:

```ts
// src/genex.config.ts
export const GENEX = {
  slug: "<the slug genex__publish-status reported>",
  apiUrl: "https://api.genex.games",
  dashboardOrigins: ["https://genex.games"],
} as const;
```

## Reading the references

The card links its references by relative path. Read one with `genex__skill` and the file exactly
as listed:

- `skills/genex-threejs-multiplayer/references/realtime-patterns.md`
- `skills/genex-threejs-multiplayer/references/genre-recipes.md`
- `skills/genex-threejs-multiplayer/references/host-physics.md`
- `skills/genex-threejs-multiplayer/references/genex-netcode-feel-checklist.md`

For example: `genex__skill {"name":"genex-threejs-multiplayer","file":"skills/genex-threejs-multiplayer/references/genre-recipes.md"}`.

## Commands

`npx genex controller chat`, `npx genex controller voice` and `genex controller character` are not
available in Studio: build chat, voice and the character from the SDK calls the card shows.
Commands map onto Studio tools as the `genex` skill describes (`genex__skill {"name":"genex"}`).

<!-- upstream @genex-ai/cli-demo/templates/skills/genex-threejs-multiplayer/SKILL.md v1.36.2 sha256 54f6a7324ae013962bd128efbd1cf217c41e0960df882259022e214b33072723 -->
---
name: genex-threejs-multiplayer
description: Realtime multiplayer for Genex Three.js games with `@genex-ai/multiplayer` — a relay whose SDK auto-smooths remote players AND shared objects (you do NOT write interpolation). Use whenever 2+ players share a world: movement sync, a shared ball/NPC via objects + ownership, host-authoritative scores/waves, shots/emotes, presence. MANDATORY for any multiplayer game — load before writing networking code.
---

# Genex Three.js Multiplayer

`@genex-ai/multiplayer` is a **relay with a smart client**: whatever you write to `me`,
`shared`, or an `object` is synced to everyone; everything else stays local. The **server**
runs no physics and no game logic — but it *does* enforce two generic invariants so the naive
path is the correct one: **exactly one smoother** (the SDK interpolates remote players and
objects for you) and **exactly one owner/host** (server-arbitrated). You read a remote player
or a shared object and it is already smooth; you never fight over who simulates the ball.

**This skill is mandatory for any multiplayer game. Load it before you write a single line of
networking code.** The mistakes below are what make a multiplayer game stutter — they are the
whole reason this skill exists.

## Two rules that decide whether it feels good

1. **Do NOT write your own interpolation/smoothing.** The SDK already smooths remote players
   *and* objects. Read `players.get(id).state` / `objects.get(id).state` and draw them directly.
   Buffering `state` and lerping it yourself stacks a second smoother and adds ~100 ms of lag —
   the #1 cause of a "laggy/stuttery" game here. Drawing `state` **is** the smooth path.
2. **Render YOURSELF (and objects you own) from your own local object, live.** Your input
   mutates a local object; you draw yourself from it every frame (zero latency). Never draw
   yourself from `players.get(room.id).state` — that's the network echo, round-trip-delayed.

Read [references/realtime-patterns.md](references/realtime-patterns.md) for the complete movement
example, the shared-object/ball code, rotation, and host usage. Read
[references/genre-recipes.md](references/genre-recipes.md) for ready-made per-genre setups
(sports/ball, shooter, co-op with host-simulated enemies) — pick the one matching the game. Before
calling multiplayer done, run the mandatory
[netcode feel gate](references/genex-netcode-feel-checklist.md).

## Install

```bash
npm i @genex-ai/multiplayer@^0.16.0
```

> Pin `@^0.16.0` (not a bare `npm i`, and not an older range): automatic TURN — the thing that
> lets players behind symmetric NAT or carrier CGNAT be heard at all — landed in 0.16, mesh voice
> in 0.15, room text chat in 0.14, host-only `setRoomOpen()` in 0.13; cross-region invites can
> select the inviter's exact relay with the optional `url` override since 0.11; unowned object
> writes warn instead of failing silently, live connected-player presence, supplier-form
> `connect()` auth and regional relay selection (`getColyseusUrls()` + `urls`) landed in 0.10;
> confirmed object controls, snaps, host-tick teardown, and reconnect rebasing in 0.9. An older
> resolve does not have those — and because this package is still `0.x`, a caret range is
> minor-locked, so `^0.12.0` would resolve to 0.12.x and give you no voice at all.

This skill targets `@genex-ai/multiplayer` **≥ 0.16.0** (`objects`/`host` since 0.4; verified per-player `avatarUrl` since 0.12;
room text chat via `room.chat` since 0.14; mesh voice via `room.voice` since 0.15;
automatic TURN (voice connects behind symmetric NAT with no configuration) since 0.16;
`matchmake()` since 0.5; private lobbies since 0.7; auto-reconnect + `inputs`/`onHostTick`
since 0.8; soft ownership handoff since 0.8.4; confirmed controls, snap epochs, and host-tick
lifecycle guarantees since 0.9; regional relay selection via `getColyseusUrls()` since 0.10; host-only `setRoomOpen()` since 0.13;
exact-relay `url` overrides for cross-region invites since 0.11).

## Trust model (say it plainly in your game's copy)

This is **casual, favor-the-player multiplayer** (Haxball, not Rocket League): you are
authoritative over yourself, match outcomes are self-reported, and there is no server-side
simulation or anti-cheat. The server DOES enforce identity (verified tokens), object
ownership, match seating/adjudication, and rate/size caps — but a modified client can still
lie about its own position or score. Great for friends and casual lobbies; don't promise
ranked-grade fairness.

## Choose one net model from the player experience

Infer this yourself when the experience is clear. Do **not** make the player choose an SDK API,
preset, or config. Ask one plain-language question only when the design genuinely supports both
models and the answer changes the experience — for example: *"Should this be one ongoing arena
people drop into, or a fresh fair match that waits for everyone and then starts together?"*
(Use your question tool when you have one; if you have none, a short numbered
list in chat.)

| Player experience | Model | Why |
| --- | --- | --- |
| One ongoing drop-in world; late joiners enter what is already happening; solo play remains valid | `connect()` | One shared room, no queue or round formation |
| Fresh bounded match/mission; quorum, fair start, capacity, teams, or parallel sessions matter | `matchmake()` | Server forms capped rooms and exposes queue/waiting state |

Genre names do not decide this. A sumo game may be an always-online drop-in ring (`connect()`) or a
fair-start bout (`matchmake()`). A co-op game may be an ongoing shared space (`connect()`) or a
bounded dungeon run (`matchmake()`). Write one plan line before coding:

> Net model: `<connect|matchmake>` — `<player-experience reason>`; start/quorum: `<rule>`;
> late join/backfill: `<rule>`; below-quorum/end tail: `<rule>`.

Use `connect()` when the game is honestly one always-online world. Use `matchmake()` when it promises
a match, run, race, mission, teams, a waiting count, or a synchronized start. If the brief says
"100 players in the same world," or mixes a shared hub with instanced matches, do not guess: surface
the platform/capacity mismatch or ask which experience matters. Do not combine the requirements or
silently convert one model into the other.

## Matchmaking (competitive presets — server-owned)

When players should be **matched into separate capped rooms** rather than share one big room (a 1v1
duel, an FFA arena, N-v-N teams, an invite lobby), use `matchmake()` instead of `connect()`. It
returns a handle whose **`session` is `null` while searching** — render your OWN "finding a match…"
HUD from `mm.matchmaking` (its `status`, `queue.position`, `players`/`opponents`, `teams`, `scores`,
`winCondition`), and switch to the game once `session` goes live:

```ts
import { matchmake, type Session } from "@genex-ai/multiplayer";
import {
  waitForPlayer, getColyseusAuth, getColyseusUrls,
} from "@genex-ai/embed-sdk";
import { GENEX } from "./genex.config";

const { user } = await waitForPlayer();
const mm = await matchmake<MyState>({
  urls: getColyseusUrls(),
  room: GENEX.slug,
  name: user.name,
  auth: () => getColyseusAuth(), // fresh for every queue join and re-seat
});

let wired: Session<MyState> | null = null;
function syncSession() {
  const live = mm.session;
  if (live === wired) return;
  wired = live;
  if (live) wireRoom(live); // attach leave/reconnect/disconnect + game listeners
}

mm.on("queue", (payload) => {
  const q = payload as { position?: number; size?: number } | undefined;
  updateQueue(q?.position ?? 0, q?.size ?? 0);
});
mm.on("matched", () => syncSession());
mm.on("matchStart", () => syncSession()); // duel/arena/teams only
mm.on("matchEnded", (result) => showResult(result)); // duel/arena/teams only
mm.on("error", (e) => showQueueError(e)); // after SDK retries; fix, then mm.retry()

// Every frame AND a low-rate timer: the handle swaps in a new Session after
// seating, terminal drop/requeue, and the next match.
syncSession();

// Report ONLY your own outcome — the server adjudicates. Which call fits depends on the win condition:
mm.eliminated();   // I'm out              (lastStanding)
mm.score(1);       // I scored             (firstToScore / highScoreInTime)
mm.finish();       // I finished the race  (firstToFinish)
```

For `open`, `matchStart` and `matchEnded` never fire: poll
`mm.matchmaking.status`, `mm.matchmaking.players`, and `mm.session` instead.
The event listeners above are for the batteries-included presets and do not
replace `syncSession()`.

Everything is **server-owned** — set once in `package.json` under `genex.matchmaking`, reported at
`genex preview` AND `genex publish` (removing it from package.json clears the stored config on the
next preview/publish); the client declares nothing. You never run matchmaking logic: the server
owns the queue, roles, winner-stays, forfeit, timeout, and the win condition.

If `genex.matchmaking` is absent, unavailable, or names an unknown preset, the
relay falls back to `duel`: rooms of exactly two with the duel round loop.
That is silently wrong for most 3–64 player `open` games. A `matchmake()` game
must declare and preview/publish the intended block; a `connect()` shared-world
game does not use this block.

### WHEN to call `matchmake()` — it IS the "Play Online" button, never a boot call (MANDATORY)

`matchmake()` is the ONE action that puts a player on the server: calling it enters the queue and
the server seats them into a room. So call it **only when the player commits to online play** —
the click on "Play Online" / "Find Match" — and NEVER on page load, in your boot code, or next to
`waitForPlayer()`. Getting this wrong is the seat-contamination bug: a player who loaded the page,
saw the menu, and started a **bots/local** game is STILL sitting in an online room counting toward
`minPlayers` — three real players wait forever for a fourth who is off fighting bots.

**The menu is pre-multiplayer — the player is in NO room and the server does not know they exist.**
Concretely, for the near-universal "Play Online / Local / Bots" title menu:

- **On page load:** boot the menu over an **offline world** generated locally. Do NOT `connect()`,
  do NOT `matchmake()`. `await waitForPlayer()` MAY run here — that only mints an identity token, it
  seats nobody — but nothing touches the relay yet. No room, no queue, no roster entry, no network.
- **"Bots" / "Local" / "Single-player":** run entirely offline. Never call `matchmake()` or
  `connect()`. The player is a party of one against local AI; the server is never involved.
- **"Play Online":** NOW call `matchmake()`. This is the first and only relay contact. The player
  enters the queue (`status: 'searching'`), the server seats them into a room, and only from this
  moment are they a counted participant.

**The waiting screen belongs to online play, not to the menu.** Show it only AFTER the player
pressed "Play Online" (so `matchmake()` was called and they hold a seat) AND the room hasn't reached
`minPlayers` yet (`mm.matchmaking.status === 'waiting'`). A player still on the menu sees no waiting
screen and no player count — they are in no room, so there is genuinely nothing to show, and there
is no way for them to know how many others are waiting. The count becomes visible the instant they
commit and get seated, never before.

**Symmetric rule — leaving online play calls `mm.cancel()`.** Entering online is `matchmake()`;
LEAVING it (back to menu, quit, switching to a bots/local game after being seated) MUST call
`mm.cancel()`. Otherwise the player keeps their seat and keeps counting toward `minPlayers` for
everyone else — the same contamination from the other side. One rule, both directions: **commit to
online → `matchmake()`; leave online → `cancel()`.**

This costs the server nothing and adds NO cheat surface: the client only ever decided *whether/when*
to search (a player can always just not play). Seating, the roster, capacity, and adjudication stay
server-authoritative — a modified client still cannot fake participation, inflate the roster, or
force `minPlayers`. Full menu wiring is Recipe 5 in
[references/genre-recipes.md](references/genre-recipes.md).

```jsonc
"genex": {
  "matchmaking": {
    "preset": "arena",                 // open | duel | arena | teams | private
    "winCondition": "firstToScore",    // lastStanding | firstToScore | highScoreInTime | firstToFinish
    "config": { "scoreTarget": 20, "maxPlayers": 8 }   // numeric knobs, optional
  }
}
```

**Choosing a preset — your own rules → `open`; a ready-made match loop → `duel`/`arena`/`teams`.**
Presets: **open** (a room of N players — the server owns only seating/capacity/refill, you write
everything else), **duel** (1v1 winner-stays), **arena** (N-player FFA, join-anytime), **teams**
(N-v-N with a server-owned match loop + eviction — only when you want that whole loop ready-made;
for your own team game use `open` + the team section below), **private** (invite-code lobby). Win conditions (batteries-included presets only):
**lastStanding** (last one alive), **firstToScore** (first to the score target), **highScoreInTime**
(top score at the time cap), **firstToFinish** (first to finish). A round that hits the time cap
undecided is a draw. (`open` has no win condition — it never ends a round for you.)

### `open` — the default building block (bring your own rules)

Reach for **`open`** first: a room of up to `maxPlayers` that the queue seats and (optionally)
refills, and NOTHING else — no rounds, no scores, no win condition, no winner-stays eviction. You
build teams/rounds/scoring/win-logic in game code on the primitives you already have (host election,
`shared`, per-player state, the `players` list). Config knobs (all numbers):

```jsonc
"genex": { "matchmaking": { "preset": "open", "config": {
  "maxPlayers": 10,   // seat cap (clamped 2..64)
  "minPlayers": 2,    // quorum to flip waiting→playing (default 1)
  "fill": 1           // 1 = keep full: grow to max + refill freed seats (default); 0 = lock for good once simultaneously full (no substitutes)
} } } }
```

With `open`, `mm.matchmaking.status` only goes `searching`→`waiting`→`playing` (never `countdown`/
`ended`), `players` is the live roster, and `teams`/`myTeam`/`scores`/`winnerId` stay EMPTY forever
— only the server presets fill them. Watch `players` and `status`, not `matchStart`/`matchEnded`
(they never fire); your teams live in `shared` (mandatory section below), never in
`mm.matchmaking.teams` — reading that empty map is how every player ends up "on one team".
Nobody is ever evicted. Build the rest:

| Want… | Do it in game code on top of `open` |
| --- | --- |
| Room formation & refill | Nothing — the server owns it via `minPlayers`/`maxPlayers`/`fill`. |
| Duel (1v1) | `maxPlayers: 2, minPlayers: 2`, then start when `mm.matchmaking.players.length === 2`. |
| Team assignment | The MANDATORY team section right below this table — the **host** reconciles a balanced `id → team` map into `shared`; every client only reads it. Never computed per-client, never read from `mm.matchmaking.teams` (empty on `open`). |
| Rounds / countdown | Host writes `{ phase, deadline }` into `shared`; clients render the countdown from the timestamp (no server clock — approximate fairness is fine at this trust tier). |
| Scores | A host-owned entry in `shared` (or per-player state); you define what a point means. |
| Win condition | Your code checks its own condition (you already compute the signals) and the host writes the result to `shared`. |
| Winner-stays / rotation | The losing **client** leaves voluntarily — `mm.cancel()` then `matchmake()` again; the freed seat refills (`fill: 1`). There is NO forced kick (a server-only power, deliberately not exposed) — a modified client can squat its seat, so if you need *enforced* rotation use `duel`/`arena`/`teams` instead. |
| Forfeit on disconnect | React to the `players` list shrinking (the SDK surfaces leaves after the reconnect grace). |
| Spectators | A game-level role: keep a "dead"/observing player seated and just render them as a watcher. There is no server spectator concept — everyone in a room is a player. |

#### Team games — the HOST assigns teams into `shared` (MANDATORY, balanced from the first frame)

Any team game on `open` (1v1 on opposite sides, 2v2, N-v-N, red-vs-blue) assigns teams in GAME
CODE — the server never will. Get this wrong and every player lands on one team and the match is
unplayable. The non-negotiable shape: exactly ONE writer — the current host — keeps an
`id → teamId` map in `shared`, and every client (host included) READS its own team from that map.
The assignment is one reconciler that keeps sides balanced at all times: drop leavers, then seat
every unassigned player on the SMALLEST team, walking the roster in sorted order. From an empty
map that IS a round-robin split (1v1 → opposite teams, four players → 2+2), and a late joiner
(`fill: 1`) always lands on the short-handed side. Run it in the host's fixed tick:

```ts
const TEAM_IDS = ["red", "blue"];  // your team set — three or more sides work unchanged

function reconcileTeams() {        // HOST-only, every tick — cheap; writes only on change
  if (!room.isHost) return;
  const teams = { ...((room.shared.get("teams") ?? {}) as Record<string, string>) };
  const roster = [...room.players.keys()].sort();           // deterministic order
  let changed = false;
  for (const id of Object.keys(teams))                      // 1. drop leavers
    if (!roster.includes(id)) { delete teams[id]; changed = true; }
  const size = (t: string) => Object.values(teams).filter((x) => x === t).length;
  for (const id of roster) {                                // 2. newcomers → the smallest team
    if (teams[id]) continue;
    teams[id] = TEAM_IDS.reduce((a, b) => (size(b) < size(a) ? b : a));
    changed = true;
  }
  if (changed) room.shared.set("teams", teams);             // no diff, no write (message budget)
}

// EVERY client, in the render loop — read your team, never compute it:
const myTeam = (room.shared.get("teams") as Record<string, string> | undefined)?.[room.id] ?? null;
if (myTeam === null) renderNeutral();                       // unassigned ≠ team red
```

The failure modes this shape exists to prevent — do NOT do any of these:

- **Per-client assignment** (each client picks its own team from `players` order, join time, or
  `Math.random()`): clients see different rosters at different moments, so they all self-assign
  the same side. Team choice has exactly one writer — the host.
- **Reading `mm.matchmaking.teams` / `myTeam`** — empty/`null` on `open` forever (server presets
  only). A `myTeam ?? "red"` fallback puts EVERYONE on red.
- **Defaulting the unassigned** (`teams[id] ?? "red"`): between joining and the host's next write
  a player has NO team — render them neutral (or keep the lobby up), never fold them into a side.
- **Assigning once at match start**: with `fill: 1` the queue keeps seating players mid-game; the
  reconciler runs every tick precisely so joiner #5 lands on the 2-player side, not the 3-player one.
- **Keeping the map anywhere but `shared`**: host-local state dies with the host's tab. In `shared`
  the map survives host migration — the NEW host's reconciler continues from what's already there
  (nobody's team changes; it only fills gaps).

Balance beyond headcount (roles, kits, skill) stays a game decision — headcount balance via this
reconciler is the floor every team game ships with. **Verify it like the lobby rule:** two browser
windows on a two-team game MUST land on OPPOSITE teams (different colors, different spawn sides).
Both on one team = broken — fix it before shipping. Full genre wiring (team spawns, friendly fire,
team score) is Recipe 4 in [references/genre-recipes.md](references/genre-recipes.md).

#### Waiting room / lobby — two patterns

The waiting room exists only AFTER the player pressed "Play Online" and got seated (see "WHEN to call
`matchmake()`" above — the menu is pre-multiplayer and shows no waiting screen). Once seated, `open`
puts you in a LIVE shared room the moment you're matched (`session` goes live, players sync) but
doesn't "start" anything — so the pre-game lobby is simply **your room before it's grown to the size
you want**. Set `minPlayers` to your target: the SERVER flips `mm.matchmaking.status` from
`'waiting'` to `'playing'` the instant the roster reaches it. The lobby and the game are ONE `open`
room — never spin up a second room for it.

**MANDATORY — the waiting screen closes on `status === 'playing'`, and you verify it.** The single
most common lobby bug is a waiting screen that never goes away even with two players seated. Both
halves of this rule are non-negotiable:

1. Drive the overlay's visibility from `mm.matchmaking.status` **re-read every frame in your render
   loop** (it's a view you poll, not an event): `status === 'waiting'` → overlay visible with the
   `players.length / minPlayers` count; `status === 'playing'` → overlay GONE, game visible. Do NOT
   gate dismissal on `matchStart`/`matchEnded` (they NEVER fire for `open`), on a one-time status
   read at connect, or on a host-written `shared` "go" signal as the *only* path — if that signal
   is never written (host bug, host left), every player is stuck on the waiting screen forever.
   A ready-check or countdown is fine as an ADDITION layered on top of `status === 'playing'`
   (host writes it to `shared` so it survives host migration), never as a replacement for it.
2. **Verify it for real before calling multiplayer done**: open the game in two browser windows
   (one regular + one incognito, so they're two players), join with both, and watch the waiting
   screen disappear on BOTH the moment the count reaches `minPlayers` (with
   `minPlayers: 2, maxPlayers: 2`: the instant the second player joins). If it doesn't close on
   both, the lobby is broken — fix it; do not ship a waiting room you haven't watched close.

**While `status === 'searching'` the roster is EMPTY — count the queue, not `players`.** The
matchmaker never parks a searcher in a room as a non-player: until it can seat you, you are in the
search line and in no room at all, so `players`/`connectedPlayers` are `[]`. A pre-match screen that
counts `players.length` there shows `0 / 2` to a player who is sitting in it, forever. Use the queue
count — it includes YOU, so it reads `1 / 2` when you are alone — and switch to the roster the moment
you are seated:

```ts
const v = mm.matchmaking;
const lobbyCount = v.status === "searching" ? Math.max(v.queue.size, 1) : v.connectedPlayers.length;
```

This bites hardest in the commonest co-op shape: with `minPlayers === maxPlayers` (e.g. `2` and `2`)
the room can only be formed once BOTH searchers exist, so you go `searching → playing` and **never
pass through `waiting`** — the screen the player stares at is the SEARCHING screen, and driving it
off `players.length` pins it at `0 / target` for its entire life.

Two ways to present the lobby:

- **A) UI lobby (Dota-style).** While `status === 'waiting'`, render an OVERLAY from `mm.matchmaking`
  instead of the game: the roster + count (`players.length` / target), each player's name, and
  optionally a per-player "ready" toggle (store it in per-player state or a `shared` map). When
  `status` flips to `'playing'`, swap the overlay for the game — the host may additionally write
  e.g. `session.shared.set('phase', { started: true, at: <ts> })` to sequence a countdown or
  ready-gate on top, but the overlay's dismissal must not depend on it alone.
- **B) Physical lobby (Roblox-style).** The waiting area IS a 3D scene in the SAME room: render a lobby
  and let players walk their avatars around, syncing position with `me.set` on the tick exactly like
  in-game. Show a "N / target — starting soon" sign driven by `players.length`. A "ready pad" is a nice
  affordance: players stand on it, the host counts how many are on it (from their synced positions) and
  writes a `shared` countdown; when it elapses everyone moves their camera/scene into the match — no
  re-matchmaking, they're already together. The transition into the match still keys off
  `status === 'playing'` first; the pad only sequences what happens after quorum.

#### Quorum loss after start is game-owned — enforce it independently

For `open`, `status` reaches `playing` once and NEVER regresses to `waiting`.
If live connectivity later falls below `minPlayers`, the relay preserves the
dropped player's seat during reconnection grace but deliberately leaves the
gameplay decision to you. `players` is the seated roster;
`connectedPlayers` / `session.activePlayers` excludes grace-window ghosts:

```ts
const MIN_PLAYERS = 2;
function enforceQuorum() {
  syncSession();
  const connected = mm.session?.activePlayers.size ?? 0;
  if (phase === "playing" && connected < MIN_PLAYERS) {
    setPhase("lobby");
    showNotice("Opponent disconnected — waiting for them or a replacement…");
  }
}
setInterval(enforceQuorum, 250); // independent of a throttled/failed render loop
```

Run the same check in the render/network pump for immediate response. The
250 ms watchdog is the backstop: no code path may leave a quorum-required game
in `playing` below its connected minimum. A shared-world `connect()` game may
intentionally continue solo; choose that explicitly rather than inheriting this
match rule.

**Private lobbies** (for `preset: 'private'`) don't use `matchmake()` — a host makes an invite code
and friends join it; the lobby is persistent (rounds replay, nobody is evicted):

```ts
import { createPrivate, joinPrivate } from "@genex-ai/multiplayer";
const lobby = await createPrivate<MyState>({ urls, room: slug, auth: () => getColyseusAuth() });  // live NOW
showCode(lobby.code);                                                   // share this
// a friend, elsewhere:
const lobby = await joinPrivate<MyState>(code, { urls, room: slug, auth: () => getColyseusAuth() });
// same handle API as matchmake(): lobby.session, lobby.matchmaking, eliminated()/score()/finish(), cancel()
```

## Connect

Pick your own per-player state shape (any JSON). `room` is the **project slug**
(printed by `genex init`) — same id = same room, different ids are fully isolated.

### WHEN to call `connect()` — make the screen tell the truth (MANDATORY)

`connect()` immediately joins the shared world and makes the player present. Two lifecycles are
valid; pick exactly one:

- **Always-online world:** there is no Play/Online commitment screen. After identity is ready,
  connect and spawn immediately. This is correct for a drop-in social space or an ongoing sumo ring
  where loading the game already means joining it. A lightweight loading/reconnecting overlay is
  honest; a Play button that appears to delay entry is not.
- **Menu before online:** if the game shows **Play**, **Play Online**, **Join Arena**, or offers
  Local/Bots, that click is the commitment point. Boot the menu/offline world with no relay contact,
  call `connect()` only inside the online handler, and spawn the network player only after it
  resolves. Local/Bots never connect. Leaving online calls `room.leave()`, disables terminal rejoin,
  removes the online avatar, and returns to the pre-online state.

Never auto-connect/spawn behind a title menu and then ask the player to press Play. The API is not
the bug in that case; the lifecycle is. Likewise, do not add a fake queue/finding screen to an
always-online `connect()` world — it has no match formation to report.

**Joining requires the SDK's player identity — the relay rejects tokenless
joins, but accepts guests** (accountless players named like `Guest-1234`).
Load the `genex-threejs-embed-auth` skill first (it sets up `initEmbed(...)`),
then gate `connect()` on `waitForPlayer()` — NOT `waitForAuth()`, which stays
pending for guests and would keep them out of multiplayer forever:

```ts
import { connect, type Session } from "@genex-ai/multiplayer";
import { waitForPlayer, getColyseusAuth, getColyseusUrls } from "@genex-ai/embed-sdk";

type State = { x: number; z: number; q: number[] };  // YOUR per-player state (rotation as quaternion)

const { user } = await waitForPlayer();  // player gate (guest OR signed-in) — rejects only if blocked
let room = await connect<State>({
  urls: getColyseusUrls(),    // regional relays for this session (server-owned); SDK joins the fastest
  room: GENEX.slug,           // the project slug — everyone with this id shares a room
  name: user.name,            // display name — the server prefers the verified identity's name
  auth: () => getColyseusAuth(), // REQUIRED — fresh on every explicit connect attempt; NEVER log it.
});
```

**Capacity:** 64 players is the relay's **mechanical seat cap**, not a proven high-motion physics
envelope. Object-heavy rooms amplify fanout; measure the exact game at 8/16/32/64 before promising a
supported count. Above the cap the relay opens another room for the same game. If the game needs one
seated competitive world, use matchmaking rather than one large `connect()` room.

## Disconnects: transient reconnect is built in; terminal rejoin is yours

The SDK auto-reconnects after a network blip or brief signal loss: the relay holds your seat for a
grace window (~30 s). A short blip keeps the same session id, ownership, and host. If a disconnected
host exceeds the shorter simulation lease, an active peer takes authority once; the old host can
return to its seat but is demoted. Long reconnects rebase remote smoothing rather than replaying a
whole-map catch-up streak. Your UI still reflects connection state:

```ts
let intentionalLeave = false;
let rejoining = false;

function wireRoom(live: Session<State>) {
  live.on("reconnecting", ({ attempt }) => showOverlay(`Reconnecting… (${attempt})`));
  live.on("reconnected", () => hideOverlay());
  live.on("disconnect", (code) => {
    // 4409 means this player deliberately opened the game elsewhere. Rejoining
    // here would evict the new tab, which would rejoin and evict this one forever.
    if (code === 4409) {
      flushSaves();
      showMenu("This game is open in another tab or device.");
      return;
    }
    if (!intentionalLeave) void rejoinShared();
  });
  live.on("server:restart", () => flushSaves());
}
wireRoom(room);

async function rejoinShared() {
  if (rejoining) return;
  rejoining = true;
  showOverlay("Connection lost — rejoining…");
  try {
    let delay = 1_000;
    while (!intentionalLeave) {
      try {
        const { user } = await waitForPlayer();
        room = await connect<State>({
          urls: getColyseusUrls(),
          room: GENEX.slug,
          name: user.name,
          auth: () => getColyseusAuth(), // fresh on EVERY attempt
        });
        wireRoom(room); // installs this same connection/disconnect wiring again
        hideOverlay();
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 10_000);
      }
    }
  } finally {
    rejoining = false;
  }
}

function leaveShared() {
  intentionalLeave = true;
  room.leave();
}
```

Keep your render loop running during `reconnecting` — remote players freeze briefly and then
glide on; don't tear the scene down. A deliberate `room.leave()` never auto-reconnects.

**One seat per player (enforced server-side):** joining the same game again — a second tab,
another device, or a page reload — instantly evicts the previous session (it gets
`disconnect`, code 4409). You never need to handle "the same player twice" and a reload
never leaves a ghost avatar behind. If the evicted tab was the host and holds unsaved world
state, flush it in the `disconnect` handler (code 4409, above): that tab is still alive, so an
async `saveWorldState` completes — otherwise a debounced save in flight is lost.

## Which channel for which data

**This table is the most important thing in this skill.** Every piece of networked state is one
of five kinds — put each on its channel and the game just works:

| What you're syncing | Channel | Who writes it |
| --- | --- | --- |
| Your own avatar (position, rotation, anim) | `me.set` → others read `players` | you (each player their own) |
| A moving thing nobody owns (**ball**, puck, NPC) | `objects` (claim + set) | the one current **owner** |
| Slow agreed facts (score, round, wave, seed) | `shared` | the **host** (`isHost`) |
| One-off actions (shot, emote, hit) | `send` + `on` | whoever did it |
| Discrete per-player values (hp, ammo, flags) | in `me.set`, read via `stateRaw` | you |
| Which avatar MODEL a player is (VRM look) | already on `players` as `p.avatarUrl` — sync nothing | the **relay** (verified identity) |
| **Text chat** | `room.chat` — its own channel, NOT `send` | the **relay** (stamps the sender) |
| **Voice chat** | `room.voice` — peer-to-peer audio, max 6 | nobody (the relay carries no audio) |

Getting the channel right is the whole game. A ball on `shared` stutters (not smoothed) and
fights (many writers). A ball on `objects` glides and has one owner. That's the difference.

## API surface (exact — do not invent methods)

- `room.id` — your own session id.
- `room.me.set(state)` — publish your state, **replaces it wholesale**. Fixed **10–20 Hz tick**,
  never per frame.
- `room.me.snap(state)` — respawn/teleport/mode edge. Publishes a discontinuity epoch so remotes
  hard-reseed instead of interpolating from the old pose. Never use for ordinary movement.
- `room.players` — fresh `Map` each read, **includes you** (skip `id === room.id`). Each value is
  `{ id, name, avatarUrl, connected, state, stateRaw }`: `state` is auto-smoothed (remotes) / live (you);
  `stateRaw` is the raw latest (hit-tests, discrete values). A reconnect-grace seat remains in this
  map with `connected: false`. `avatarUrl` is that player's verified VRM pick (server-set, `''`
  when unknown) — render each remote with
  `loadRemotePlayerCharacter({ avatarUrl: p.avatarUrl })` (the vendored controller kit's
  loader) and `remote.dispose()` on leave; never publish avatar URLs through `me.set`.
  That one call carries the whole rule: **in a game with its own generated character,
  every remote wears it** — `p.avatarUrl` is used only when this game has no generated
  character, which is exactly when per-player looks are the right answer. It shares one
  parsed base across remotes (N remotes ≈ 1 body of geometry/textures instead of a parse
  per player) and clips are retargeted once on that base. **A remote player's body is
  NEVER hand-built primitives** (no capsule + cone "person" — the single most common
  shipped co-op defect). This applies with full force to
  first-person games — the local player may be invisible to themselves, but every
  remote hunter/partner is a full character on screen. On phone tiers, animate and fully draw only the
  nearest `tier.remoteAvatarCap` remotes (`$genex-threejs-adaptive-quality`) — freeze the
  mixer and billboard or hide the rest; a room allows up to 64 players and 64 live avatars
  is a real phone memory kill on its own.
- **Build each remote's body exactly ONCE — reserve the id BEFORE the first `await`.** You read
  `room.players` every frame, but loading a body is async and slow (seconds). If the only guard is
  the map you fill *after* the await, every frame in that window passes it: you spawn one body per
  frame, each stranded where it spawned — a trail of frozen clones behind the moving player — plus
  dozens of wasted loads. Mark the id synchronously, and drop the body if that player left mid-load:

  ```ts
  const bodies = new Map<string, Body>();
  const loading = new Set<string>();                      // the seat reservation
  function ensureBody(p: Player) {
    if (bodies.has(p.id) || loading.has(p.id)) return;    // BOTH — checked before any await
    loading.add(p.id);
    void (async () => {
      try {
        const body = await loadVrmClone(p.avatarUrl || "./assets/avatar.vrm");
        if (!room.activePlayers.has(p.id)) return;        // left while loading — never add it
        scene.add(body.scene);
        bodies.set(p.id, body);
      } finally { loading.delete(p.id); }                 // always release, success or throw
    })();
  }
  // Each frame: ensureBody for every remote, then drop bodies whose id is gone.
  for (const [id, body] of bodies) {
    if (!room.activePlayers.has(id)) { scene.remove(body.scene); bodies.delete(id); }
  }
  ```

  The same rule covers anything else you lazily load per player or per object (nameplates, weapon
  models, audio): a check that straddles an `await` is not a guard.
- `room.setRoomOpen(open)` — **host only.** Stop (or resume) the matchmaker putting NEW players
  into THIS room. A lobby game needs this: once your match starts, arrivals would otherwise be
  dropped into a fight already in progress. Close the room at match start and the next arrival
  forms the NEXT room instead; reopen when you return to the lobby. Everyone already inside keeps
  playing, and a reconnecting player still gets back in (reconnection uses a reserved seat, not
  matchmaking). A non-host call is ignored, so check `isHost` first — and because the host can
  change, re-assert it on `on('host')` rather than only once at match start:

  ```ts
  function startMatch() {
    if (room.isHost) room.setRoomOpen(false);   // late arrivals form the next lobby
  }
  function backToLobby() {
    if (room.isHost) room.setRoomOpen(true);
  }
  room.on("room:open", ({ open }) => showLobbyClosedBadge(!open)); // every client is told
  ```
- `room.activePlayers` — the connected-only subset of `room.players`; use its size for live quorum.
- `room.objects` — shared objects nobody owns until claimed (a ball, an NPC):
  - `claim(id)` — **legacy** optimistic request. It flips local ownership immediately and is corrected
    if the relay rejects it. Keep only for reversible old-game behavior.
  - `await claimConfirmed(id, options?)` — authoritative accepted/rejected result for a kick, seat,
    reset, or other irreversible action. Ordinary claims, including host-player contact, honor the
    relay minimum hold. `reason: "held"` includes `retryAfterMs`; retry only while contact/intent is
    still valid. `{ authority: "host" }` is reserved for current-host seed/reset lifecycle work.
    A real hold bypass returns `host-authority`; a non-host request returns `not-host`. A current-owner
    reassert is accepted as `already-owner` without extending the hold.
  - `set(id, state)` — publish it (only lands while you own it; full flat object each call).
  - `get(id)` → `{ id, owner, isMine, epoch, state, stateRaw }` or `undefined`. `state` is auto-smoothed
    (or live if `isMine`); `stateRaw` is the raw latest.
  - `release(id)` / `remove(id)` — legacy fire-and-forget operations.
  - `releaseConfirmed(id)` / `removeConfirmed(id)` — acknowledged, idempotent operations; use when
    local mode/state depends on convergence. Remove stays owner-only.
  - `snap(id, state)` — owner-only reset/teleport with an object discontinuity epoch. Ordinary motion
    stays on `set`.
  - `ids()` — all object ids seen.
- `room.isHost` / `room.host` — you are (or who is) the elected authority. Use to pick the single
  writer of `shared` scores/rounds and the single simulator of host-owned objects. Settles within
  the first patch after connect — read in your loop / react to `on('host')`, not once.
  `room.host === undefined` before that patch means **authority is not ready**:
  do not start host-owned simulation and do not synthesize an "acting host" from
  a locally sorted roster. Clients can briefly observe different rosters, so
  that fallback can create multiple writers. Gate host-dependent initialization
  until `host !== undefined`; if it remains unset while connected, expose it in
  diagnostics and re-seat/reconnect instead of inventing authority.
- `room.shared.get/set/keys` — key/value store (any JSON) for **slow agreed facts only**.
- `room.on(event, cb)` → unsubscribe fn. Events: `'join'`/`'change'` `(id, state)` (also fire for
  you), `'leave'` `(id)`, `'shared'` `(key, value)`, `'object'` `(id)` (ownership handoff),
  `'host'` `(id)`, and any custom `send` name.
- `room.send(type, payload)` — fire-and-forget to all **other** clients. **It never echoes to
  you**, so apply your own action's local effect directly (draw your own tracer at fire time),
  not inside `on(...)`. Relay-internal names (`state`, `shared`, `claim`, `obj`, `release`,
  `destroy`, `match:*`, `__*`) are refused — pick your own event names. `room.leave()`.
- `room.chat` — room text chat, **its own channel, not `send`**: `chat.send(text)`,
  `chat.on(m => …)`, `chat.history`, `chat.mute(id)` / `chat.unmute(id)` / `chat.muted`.
  The relay stamps `m.from`/`m.name` from the verified session (nobody can post under
  another player's name), sanitizes `m.text`, caps it at 500 chars, and replays the last
  ~50 lines so a late joiner sees the conversation. **Your own lines echo back to you** —
  render only what arrives in `on`, or every message appears twice. UI:
  `npx genex controller chat`, and you MUST pass its `onTypingChange` (or check
  `chat.isTyping`) so the game stops reading the keyboard while someone types — otherwise
  typing "was that a wall?" walks and jumps the player. Render `m.text` with `textContent`,
  never `innerHTML`. See [references/realtime-patterns.md](references/realtime-patterns.md).
- `room.voice` — mesh voice chat: `voice.join(opts)` / `leave()` / `setMicEnabled(on)` /
  `mute(id)` / `participants` / `active` / `speaking`, plus `room.on('voice', …)` and
  `room.on('voice:rejected', …)`. **Party-sized: the relay caps it at 6** (audio is a full
  mesh — everyone uploads to everyone, and reliability, not bandwidth, breaks first). The
  room still holds 64 players; the 7th `join()` is refused, so handle `voice:rejected`
  instead of retrying. `join()` MUST run inside a click/tap — browsers gate both the mic
  prompt and audio playback on a user gesture — and it REJECTS when the player denies the
  mic, which is an ordinary outcome to show, not an error to swallow. For a 3D game use
  `npx genex controller voice` (proximity audio + push-to-talk); it joins with
  `{ spatial: true }` and drives a `THREE.PositionalAudio` per speaker. **TURN is automatic
  — do not pass `iceServers`**: `join()` fetches short-lived relay credentials from the
  platform before opening any peer connection, which is what lets the ~15% of players behind
  symmetric NAT or carrier CGNAT be heard at all (in a mesh they fail every leg, so they
  connect to nobody while everyone else works — a miserable bug to diagnose from a report).
  Passing `iceServers` overrides this and is only for running your own TURN.
- `room.inputs.send(payload)` / `room.inputs.on((fromId, payload) => …)` — the host-routed
  input channel for host-authoritative physics: anyone sends, ONLY the current host receives.
  See [references/host-physics.md](references/host-physics.md).
- `room.onHostTick(hz, cb)` — fixed simulation only while connected and host. It pauses during
  reconnect, resumes only if still host, and stops on demotion, deliberate leave, or terminal
  disconnect. Returns a disposer for removing the subsystem earlier.

## Your message budget (every publish is one relay message)

Every publish costs one relay message. The relay uses a global ceiling plus reserved lanes: player
state 30/s sustained, object control 40/s, host input 60/s, and bulk object/shared/custom traffic
120/s (all with bursts). A bulk-object flood therefore cannot consume the avatar or control lane.
Drops still produce the SDK warning; confirmed controls additionally resolve `rate-limited` rather
than silently disappearing. The budget math that matters:

- Your own state (`me.set`) at 15 Hz + ONE driven/owned moving object at 15 Hz = 30/s. Fine.
- The pattern that blows the budget: **republishing IDLE objects every tick.** A host that
  owns several parked vehicles/props must NOT `objects.set` each of them at full tick rate —
  publish an object **when it changed**, plus a low-rate keepalive (~1–2 Hz) so late joiners
  converge. Unchanged pose ⇒ no message.
- **Per-projectile objects need a hard cap + confirmed removal.** Each live projectile at 30 Hz
  is 30/s of bulk budget, and every spawned id counts against the room's 128-object cap forever
  unless removed. Cap live projectiles per player (2–3), remove the OLDEST via
  `objects.removeConfirmed` before spawning past the cap, and `removeConfirmed` on impact/expiry
  — uncapped spawns are how a shooter silently kills its own object budget.
- If you see the drop warning, count each lane separately and also leave headroom under the global
  ceiling. Reserved capacity protects presence and control, but it is not permission to spam bulk.

## The loop you must build (input → local → tick → render)

1. **Input mutates a local object only** (`me.x += …`). Never network on keypress.
2. **A fixed tick publishes it:** `setInterval(() => room.me.set(me), 66)` (~15 Hz). If you own an
   object, `objects.set` it in the same tick. **Round numbers before publishing** —
   `Math.round(v * 100) / 100` (2 decimals ≈ cm precision) — raw floats serialize as 17-digit
   JSON and are the #1 bandwidth waste; nobody can see a 0.001-unit difference.
3. **Render at your own framerate:** yourself from your *local* object; every other player from
   `players.get(id).state` directly (already smoothed); every object from `objects.get(id).state`.
4. **Create-or-reuse one mesh per id**; remove a player's mesh on `'leave'`.

> **Physics character?** If your player is the `genex controller character` capsule, do NOT
> hand-build the state from the body position — publish `room.me.set(character.netState())` and
> apply remotes with `applyNetState(mesh, players.get(id).state)`. The controller's raw `currPos.y`
> bobs on its float-suspension spring; `netState()` publishes a settled ground Y so a standing remote
> doesn't bob. See `$genex-threejs-character-controller` → "Multiplayer rule".

## Rotation: sync a quaternion, not an angle

Send rotation as a 4-number quaternion `q: mesh.quaternion.toArray()`; on the remote do
`mesh.quaternion.fromArray(p.state.q)`. A scalar `yaw` is lerped linearly, so a heading crossing
±π spins the long way. This applies to `objects` state too — keep object fields **flat**
(top-level numbers + a 4-number quaternion smooth; nested objects snap).

## Smoothed vs raw — `state` vs `stateRaw`

`state` is smoothed and rendered slightly in the past (that's what makes motion glide). `stateRaw`
is the newest value with no smoothing. **Draw** from `state`; **test** against `stateRaw` — hit
detection, "am I close enough to kick", pickups, and any discrete number (hp, ammo, animation id,
a 0/1 flag) that must not arrive fractional. This holds for both players and objects.

**HARD RULE — `state` is for RENDER ONLY.** Every GAMEPLAY read — hit tests, deflection/catch/
return windows, physics seeding after adoption, distance and reach checks — uses `stateRaw`.
The smoothed view is ~100–150 ms in the past; at projectile or ball speeds the REAL object has
already passed where the ghost still is. Two field-verified failures caused by breaking this rule:
- A pong-style game read the incoming ball via `state` for its deflection window — at top speed
  the real ball crossed the paddle plane before the smoothed one arrived; returns were literally
  impossible online while feeling fine in solo testing.
- A dodgeball game aimed at opponents drawn from `state` — a strafing target's real position was
  already elsewhere, so "direct hits" never registered damage.
Corollary: **cap top speeds against the network, not just the physics** — an object's arena/table
crossing time should stay above ~2× the smoothing delay (~0.25 s), or receivers are reacting to
history no matter how correct the code is.

**Packed animation-flag bitfields are the sneakiest violation.** Smoothing lerps EVERY numeric
field — there is no integer exemption — and a lerped bitfield decodes to garbage: with
`moving=1, running=2, grounded=8`, walking is `f=9` and running is `f=11`, and the interpolation
passes through `10`, where `10 & moving === 0` — the sprinting opponent renders as *standing
still*. Worse, the exponential ease approaches an increasing target from below, so truncation
reads `target - 1` for the whole approach (~1.5 s median before RUN appears; at a vsync-locked
frame rate it can stick one ULP below the target *forever*). A field-verified failure: a
playtester swore he was running while his opponent's screen showed him walking — both were right.
Always drive remote animation from `stateRaw`:

```js
avatar.updateFromFlags(p.stateRaw.f ?? 0, dt);   // flags are DISCRETE — never p.state.f
```

**Reaction one-shots on remotes fire on EDGES, never per frame.** If you replay a remote's
death/hit pose from their published `out`/`hp` state, track the previous value and act only on
the transition — a per-frame `reset()`/`playDown()` restarts or cancels every in-flight reaction
clip (and re-writing ghost/material flags 60×/s is pure churn).

## Shared objects (the ball, the NPC) — use `objects`, never `shared`

A ball belongs to no player. Put it on `objects`: exactly one client owns it at a time (the SDK +
relay enforce it), the owner simulates it, and everyone else reads it auto-smoothed — on the same
interpolation as a player. Ownership survives the owner leaving (reassigned to the host).

```ts
const result = await room.objects.claimConfirmed("ball");
if (result.accepted) applyKickAndFeedback();
else if (result.reason === "held" && stillTouching) retryAfter(result.retryAfterMs);

if (room.objects.get("ball")?.isMine) {
  room.objects.set("ball", stepBallPhysics());       // only the owner's writes land
}
const ball = room.objects.get("ball");
if (ball) drawBall(ball.state);                       // smoothed for everyone, live for the owner
```

**Keep contact validity alive until acceptance; do not consume one rejected rising edge forever.**
Never claim every frame: maintain one pending request, then retry after the relay delay only while the
contact remains valid. Keep object state flat. For Rapier pushables, install the shipped state machine
with `genex controller networked-physics`; see
[references/host-physics.md](references/host-physics.md).

**OWNERSHIP INVARIANT — a host-simulated object MUST be claimed before it publishes.**
`objects.set()` / `objects.snap()` on an object you do not own are ignored; SDK ≥0.10.2 warns once
per object/operation instead of failing silently.
The field-verified symptom is unmistakable — *the object moves on the host's screen and sits
frozen at spawn for everyone else* (each client falls back to whatever local body it has; only
the host's is simulated). If the host simulates an object (a crate, an NPC, a puck), it must:

```ts
let hostReady: Promise<boolean> | null = null;
function ensureHostObjects(room: Session<S>) {
  if (!room.isHost) return Promise.resolve(false);
  if (hostReady) return hostReady;                    // one adoption flight, never per tick
  hostReady = (async () => {
    for (const id of HOST_OBJECT_IDS) {
      const before = room.objects.get(id)?.stateRaw;  // last published truth, before claiming
      const res = await room.objects.claimConfirmed(id, { authority: "host" });
      if (!res.accepted) return false;
      seedPhysicsFromRaw(id, before);                 // pose + velocity/cooldowns, never zero
    }
    return true;
  })();
  return hostReady;
}

room.on("host", () => { hostReady = null; void ensureHostObjects(room); });
room.onHostTick(30, async () => {
  if (!(await ensureHostObjects(room))) return;       // no step/publish before adoption
  stepAndPublishHostPhysics();
});
```

Do not assume `onHostTick` firing means you own anything — host *election* and object
*ownership* are separate systems. Claim explicitly, check `accepted`, re-claim on migration, and
do not step or publish until the whole host-owned set is ready.

**RENDER SPLIT — the host draws its own authority, only NON-hosts read the wire.** Once the
host owns the object and publishes, `objects.get(id).state` becomes defined on EVERY client
including the host — and if the host now renders from that networked `state` instead of its
own sim body, a subtle trap bites: a freshly-claimed object's smoothed `state` can briefly be
a DEGENERATE transform (a zero/NaN quaternion, or a position mid-interpolation from origin),
which renders the mesh to NaN and it vanishes ON EVERY SCREEN. Field-verified: enabling the
claim above without this split made a crate invisible for everyone. The fix:

```ts
// Host renders its own authoritative sim; non-hosts render the published truth, GUARDED.
const cs = room.isHost ? null : room.objects.get(id)?.state;
const ok = cs && Number.isFinite(cs.x) && Number.isFinite(cs.y) && Number.isFinite(cs.z);
if (ok) {
  mesh.position.set(cs.x, cs.y, cs.z);
  if (Array.isArray(cs.q) && cs.q.length === 4) {         // normalize — a bad sample must not vanish the mesh
    const n = Math.hypot(cs.q[0], cs.q[1], cs.q[2], cs.q[3]);
    if (n > 1e-3) mesh.quaternion.set(cs.q[0]/n, cs.q[1]/n, cs.q[2]/n, cs.q[3]/n);
  }
} else {
  mesh.position.copy(localBodyPos); // host, offline, or non-host awaiting first valid sample
}
```
Prefer syncing the MINIMAL transform a slide/roll needs (a puck on a plane is `{x,z}` + a
constant y — no quaternion at all); every field you don't send is a field that can't arrive
degenerate. The netcode-park reference does exactly this.

## Host authority (scores, rounds, enemies)

One client is the `host`. Let *only* the host write agreed state and simulate shared enemies, so
there's a single source of truth. **But: a host is only the authority for objects it OWNS.**
If another player owns/drives an object (their claim landed), the host renders it from the
stream like everyone else — a host branch that pins "its" objects to a local pose without
checking `owner`/`isMine` shows every other player's driving as a frozen object:

```ts
if (room.isHost) room.shared.set("round", nextRound);   // only the host advances the round
room.on("host", (id) => {});                             // host migrated (someone left)
```

**Award points exactly once — even across a host migration.** A newly-elected host re-observes
whatever condition the old host may already have scored (the goal state, the defeat event — they
are still on the wire). Never bump a score from a re-observable condition alone: carry a
**monotonic marker in the same `shared` write**, so the score and its dedupe commit atomically:

```ts
// One shared "scores" map holds both the tallies and reserved "__" marker rows.
function awardOnce(scorerUid: string, name: string, marker: `__${string}`, seq: number) {
  if (!room.isHost || !Number.isSafeInteger(seq)) return false;
  const scores = { ...((room.shared.get("scores") ?? {}) as Record<string, { name: string; points: number }>) };
  if ((scores[marker]?.points ?? -1) >= seq) return false;      // already awarded by SOME host
  scores[scorerUid] = { name, points: (scores[scorerUid]?.points ?? 0) + 1 };
  scores[marker] = { name: "", points: seq };                    // the marker rides the same write
  room.shared.set("scores", scores);
  return true;
}
// goals: seq = a goalEpoch you bump on each reset · kills: seq = the victim's `life` counter
```

**Key scores by a STABLE identity, never the session id.** A session id dies on every reload —
the points orphan into a duplicate row and the player's color changes. Publish a short `uid` in
each player's state (from the embed identity: `const { user } = await waitForPlayer()`,
`uid = user.id` — stable for signed-in players AND guests; see `$genex-threejs-embed-auth`), and
key `scores`/colors/`isMe` by that uid. When an event only carries a session id, map it via
`room.players.get(sid)?.stateRaw.uid`.

For host-simulated NPCs, the host claims and drives each enemy as an `object`; when the host
leaves, its enemies are reassigned to the new host, which reads their `stateRaw` and keeps
simulating. See the co-op recipe in [references/genre-recipes.md](references/genre-recipes.md).
For PvP combat (hitscan, melee, projectiles, defeat/respawn) follow the shooter recipe there —
its damage/defeat dedupe rules are what keep kills exactly-once under lag.

### Pushable / contested physics — pick the tier

Claim-on-touch is the default for any **ownable** body — a ball, a box, a prop, a pickup — even when
players take turns bumping it: whoever touches it owns + simulates it with real Rapier physics, and
since `@genex-ai/multiplayer` 0.8.4 the ownership handoff **glides** (a soft handoff) instead of
teleporting. Give it a Rapier proxy that is `dynamic` while you own it (your character shoves it through
the solver) and a `kinematicPosition` follower of the smoothed `state` when you don't.

Reserve **host-authoritative** for a genuine *simultaneous* contest — two players pushing ONE crate
*against each other*, sumo, tug-of-war — where "whoever touched last owns it" is the wrong model. There
one neutral simulation (the host) runs the physics; everyone else sends **inputs**
(`room.inputs.send({ push })`), which the relay routes to the host only; the host applies them on
`room.onHostTick(...)` and publishes results via `objects` (smooth for everyone).

Both patterns — the claim-on-touch Rapier proxy and the host-authoritative contest, plus surviving host
migration and wiring the vendored controllers — are in [references/host-physics.md](references/host-physics.md).

## Production supportability floor

Every multiplayer build ships three small, token-free diagnostics:

1. A `BUILD` string, bumped for every preview/publish, shown in a quiet
   menu/lobby corner, printed once to the console, and exposed on a read-only
   game debug object.
2. A 250 ms status line containing only:
   `build · seated/connected players · phase · host · matchmaking status · last transition/cause · last network error`.
   Keep it unobtrusive and never include embed auth, URLs containing credentials,
   player tokens, or arbitrary server payloads.
3. The independent connected-quorum watchdog above for games that cannot play solo.

These are production supportability, not a hidden test mode: a screenshot must
identify the build and network state without changing game behavior.

## Smoothness is felt, not seen — hand the feel to a human

Lag and stutter are *motion over time*. A screenshot is one frozen instant, so **you cannot tell
from any still capture whether movement feels smooth.** Don't try — it leads to blind tuning.

1. **Trust the SDK's smoothing.** Draw `state` directly; don't add your own.
2. **Verify it *runs*:** two clients, distinct meshes, both move, no console errors, each sees the
   other (and the ball, if any). That's all a capture can prove. Local test mode (what the dev
   server boots into — the embed-auth skill) can NOT do this: it mints no relay credential, so `connect()`
   fails there by design and two local-test tabs never see each other — run the two-client check
   on the published game (or have the owner open their draft), and if multiplayer wasn't
   exercised, say exactly that in your handoff instead of implying it was.
3. **Then say plainly:** *"Multiplayer smoothness depends on your network and can only be felt by a
   person — open it in two tabs or with a friend and tell me how it feels."* Stop there.

### When the human reports a problem, match the symptom (don't guess)

- **"Everyone (including me) feels laggy / stuttery."** You're re-smoothing: you buffered `state`
  and lerped it yourself. **Delete that** — draw `state` directly. Most common mistake.
- **"My own avatar feels laggy."** You're rendering yourself from the network echo. Render yourself
  from your local object instead.
- **"Other players spin the wrong way when turning."** You synced a scalar `yaw`. Use a quaternion.
- **"The ball stutters / jumps / two of it / fights."** It's on `shared`, or you re-smoothed it.
  Put it on `objects` (claim on contact, owner simulates, everyone draws `state`).
- **"The ball freezes when someone else takes it."** You're re-smoothing an object, or reading the
  wrong owner — just draw `objects.get(id).state`; handoff continuity is handled for you.
- **"The score/enemies desync or double up."** More than one writer. Gate writes on `room.isHost`.
- **"Everything lags equally, even idle objects."** You're calling `me.set`/`objects.set` per
  frame — move publishing to the fixed 10–20 Hz tick.

## Config wiring (already done — do NOT hand-write URLs)

`genex init` already wrote `src/genex.config.ts` — a static env-reader with
production URL defaults (local-stack overrides live in `.env.development.local`,
which applies in dev mode only and is never committed or shipped). Just import
it; never hardcode a URL or edit the file:

```ts
import { GENEX } from "./genex.config";
// GENEX.slug / GENEX.apiUrl / GENEX.dashboardOrigins
```

See the `genex-threejs-embed-auth` skill's "Config wiring" section for the full
file layout.

## Persistent worlds (optional — survives restarts)

The relay is in-memory: room state is gone when everyone leaves or the server restarts. For a world
that persists (a driven car stays where it was parked, built structures survive), save/load the
game's shared world slot via the embed SDK, from **one authority** (the host):

```ts
import { loadWorldState, saveWorldState } from "@genex-ai/embed-sdk";

// load on boot (safe to call immediately — waits for identity internally;
// guests resolve { data: null, guest: true } and receive the live world
// through the room instead)
const { data, version } = await loadWorldState();
initWorld(data ?? defaultWorld());
let worldVersion = version;

// save from ONE authority — the elected host — debounced, WITH ifVersion so a
// stale host handoff loses loudly instead of silently clobbering:
async function persistWorld(world: unknown) {
  if (!room.isHost) return;
  const res = await saveWorldState(world, { ifVersion: worldVersion });
  if (res.saved) worldVersion = res.version!;
  else if (res.conflict) {
    // someone else wrote since our read (host migration race) — resync
    const fresh = await loadWorldState();
    worldVersion = fresh.version;
    mergeWorld(fresh.data);
  }
  // res.guest: this host is a guest (guest-only room) — saving is off until a
  // signed-in player joins; the relay prefers signed-in hosts automatically.
}
```

The slot is one JSON blob per game (≤ 1 MB) shared by every player — world layout only,
NEVER per-player progression (that belongs in each player's own `savePlayerState()` slot —
see the embed-auth skill). Don't save every frame: debounce (~1/sec), and also flush on
`document.visibilitychange === "hidden"` so the last edits survive the host closing the tab.
Guests can't write it, but the relay elects a signed-in host whenever one is present, so
host-driven saving works as long as ANY account is in the room.

## Checklist

- [ ] `npm i @genex-ai/multiplayer@^0.16.0` (automatic TURN, mesh voice, room text chat, connected presence, supplier auth, confirmed controls, snap epochs, reconnect-safe host ticks, unowned-write warnings, cross-region exact-relay overrides); config wired into the build.
- [ ] The plan names one net model, the player-experience reason, start/quorum, late-join/backfill,
      and below-quorum/end behavior. The agent inferred it unless the experience was genuinely ambiguous.
- [ ] `reconnecting`/`reconnected`/`disconnect` render an overlay (don't tear the scene down).
- [ ] `connect()` terminal `disconnect` starts a guarded backoff rejoin that reruns
      `waitForPlayer()` and reads fresh auth on every attempt; deliberate leave stops it;
      replacement code `4409` NEVER auto-rejoins.
- [ ] `connect()` lifecycle is honest: an always-online world has no fake Play screen and may
      connect/spawn after identity; if a Play/Online/Local/Bots menu exists, connect and spawn happen
      only after the online click, Local/Bots stay offline, and leaving calls `room.leave()`.
- [ ] Numbers rounded (~2 decimals) before `me.set`/`objects.set`.
- [ ] Pushable/ownable objects (ball, box, prop) use claim-on-touch + a Rapier proxy (the soft handoff glides the handoff); only a genuine simultaneous tug-of-war (sumo) uses the host-authoritative pattern. See host-physics.md.
- [ ] Irreversible actions wait for `claimConfirmed`; held contact retries after `retryAfterMs` while still valid.
- [ ] Respawn/reset/vehicle-mode discontinuities use `me.snap`/`objects.snap`; ordinary motion uses `set`.
- [ ] Idle/unchanged objects republish at ≤2 Hz keepalive, never every tick (message budget).
- [ ] PvP combat follows the shooter recipe: attacks/defeats are `send` events with `seq`/`life`
      dedupe keys, the victim applies its own damage, respawn publishes via `me.snap`, and
      projectiles are hard-capped objects removed with `removeConfirmed`.
- [ ] Host score writes are exactly-once (marker in the same `shared` write) and keyed by the
      stable embed `uid`, never the session id.
- [ ] Host renders objects OWNED BY OTHERS from the stream (authority follows ownership).
- [ ] `connect()` runs AFTER `await waitForPlayer()` (never `waitForAuth()` — guests would
      hang) and passes `auth: () => getColyseusAuth()` (the relay rejects tokenless joins —
      see `genex-threejs-embed-auth`).
- [ ] `room` is the **project slug**.
- [ ] `me.set` on a fixed **10–20 Hz** tick; full object each time.
- [ ] Skip yourself in `room.players` (`id === room.id`).
- [ ] Remote players & objects drawn from `state` **directly** — no hand-rolled interpolation.
- [ ] **You** (and objects you own) render from your local object, not the network echo.
- [ ] Rotation synced as a quaternion `q`, not a scalar angle.
- [ ] Hit-tests and discrete values read from `stateRaw`, not `state`.
- [ ] A ball / shared NPC is on `objects` (claim on contact), never on `shared`.
- [ ] `shared` scores/rounds and host-simulated enemies are written only by `room.isHost`.
- [ ] Host-owned work waits for `room.host !== undefined`; no client-invented acting host.
- [ ] `matchmake()` fires ONLY on the "Play Online" commit, never on page load / in boot code — the
      menu runs an offline world with NO relay contact; "Bots"/"Local" never call it; leaving online
      calls `mm.cancel()`.
- [ ] `matchmake()` polls `mm.session` and rebinds when it changes after seating or re-seat;
      function-form auth is used.
- [ ] Waiting room (if any): shown only AFTER "Play Online" (seated) and while under `minPlayers`;
      overlay driven by `mm.matchmaking.status` read every frame, gone the moment it flips to
      `'playing'` — and you WATCHED it close in two browser windows at `minPlayers` (never gated on
      `matchStart` or a host `shared` signal alone).
- [ ] Every menu/lobby action button blurs before acting, and menu Enter/arrow handling runs only
      in menu/lobby phases.
- [ ] Multiplayer was exercised by two DISTINCT identities using real clicks and real key presses.
      After clicking Play/Find Match, Space/Enter gameplay input does not repeat that menu action;
      scripted `element.click()` is not evidence for this focus path.
- [ ] For a quorum-required matchmade game: close one client mid-match, watch connected quorum
      (`activePlayers` / `connectedPlayers`) leave `playing`, then join a new distinct client and
      watch it re-seat. For a shared-world `connect()` game, verify leave/host migration according
      to that game's design instead of imposing a lobby.
- [ ] Build id is visible in menu/lobby, logged once, and exposed with token-free 250 ms network
      telemetry; quorum-required games have the independent connected-quorum watchdog.
- [ ] Team game: the HOST reconciles the balanced `id → team` map into `shared` (leavers dropped,
      newcomers to the smallest team); every client READS its team from `shared` — never computed
      per-client, never `mm.matchmaking.teams`, never a default for the unassigned — and you
      WATCHED two browsers land on OPPOSITE teams.
- [ ] Picked the matching recipe from [references/genre-recipes.md](references/genre-recipes.md).
- [ ] Passed the [netcode feel gate](references/genex-netcode-feel-checklist.md), including the two-
      identity real-input proof for the chosen model.

## Troubleshooting auth

- **`connect()` rejects with 401/403** — 401 "auth required"/"invalid token": you joined
  without `auth`, before `waitForPlayer()` resolved, or reused a stale token for a NEW terminal
  rejoin — read `getColyseusAuth()` fresh at every connect. 403 "wrong game": the `room` value
  doesn't match this game's own slug. 403 "guest capacity": the room is at its guest
  limit — signing in gets the player a seat; surface the message as-is.
- **`disconnect` fired and the player wants back in** — the old session is dead; run your
  connect flow again from the top with a FRESH `getColyseusAuth()` (a cached auth object is
  the usual cause of a rejoin failing 401).
