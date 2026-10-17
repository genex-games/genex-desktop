# Genre recipes

Pick the recipe matching the game and follow its **decisions** — which channel carries what, who
is the authority. The mechanisms are just the SDK calls from
[realtime-patterns.md](realtime-patterns.md); these recipes only tell you *how to wire them per
genre*. Don't invent your own netcode — every genre reduces to the five-channel table in SKILL.md.

Set the human's expectation up front: this is **casual, favor-the-player** multiplayer (Haxball,
not Rocket League). There's no server-side simulation or anti-cheat — great for friends over a
link, not for ranked play. Say that plainly rather than chasing perfect contested physics.

---

## Recipe 1 — Sports / ball (football, hockey, dodgeball)

The genre where a single contested object is the whole game.

| Thing | Channel | Authority |
| --- | --- | --- |
| Each player's avatar | `me.set` / `players` | each player |
| The ball / puck | `objects` (`"ball"`) | current owner (last kicker) |
| Score, timer, kickoff | `shared` | `room.isHost` |
| Goal celebration / whistle | `send` | whoever scored / the host |

**Decisions:**
- **Confirm the ball claim on contact**, not every frame: when your player's collider touches the
  ball, await `room.objects.claimConfirmed("ball")` and apply the kick impulse only after
  `accepted`. If the result is `held`, retry after `retryAfterMs` only while contact still exists.
- **Only the owner simulates** the ball (`if (objects.get("ball")?.isMine) objects.set("ball", …)`
  in the tick). Everyone draws `objects.get("ball").state`. Non-owner writes are dropped by the
  relay, so two players kicking at once resolve to one owner — no fighting.
- **Ball state stays flat** (`{x,y,z}` plus a quaternion if it spins). Nested objects don't smooth.
- **Goals are host-only:** the host detects the ball crossing the line (it reads the ball like
  everyone else) and writes the score to `shared`; everyone reads `shared.get("score_a")` in the HUD.
- **A player quitting mid-match doesn't kill the ball** — if the owner leaves, the ball is
  reassigned to the host automatically and play continues.
- **The receiver's interaction window reads `stateRaw`, never `state`** — return/deflect/catch
  checks against the smoothed ball test a ghost ~120 ms in the past; at rally speeds the REAL
  ball has already crossed your paddle/goal line before the ghost arrives (field-verified: it
  made a pong-style game unreturnable online while feeling perfect in solo play). Render the
  smoothed ball, but run the window on the raw one, sweeping raw-sample→raw-sample.
- **Cap top ball speed against the network:** keep the arena/table crossing time above ~2× the
  smoothing delay (≳0.25 s). Faster than that, no human can respond to what they're shown —
  no amount of correct code fixes reacting to history.

**Acceptance feel:** the kicker sees the ball respond the same frame; everyone else sees it glide;
a contested kick settles on one owner within a snapshot; the owner leaving doesn't freeze the ball;
a full-speed shot is still humanly returnable by the receiving player.

---

## Recipe 2 — Shooter / arena PvP (hitscan, melee, projectiles)

Fast players, instant hits, a live scoreboard. No shared physics object needed for hitscan or melee.
(This is the exact model the netcode-park reference runs live: fists/swords, a hitscan rifle, and
slow physical projectiles, all against the same damage/defeat rules.)

| Thing | Channel | Authority |
| --- | --- | --- |
| Player pos + rotation + hp + `life` | `me.set` / `players` (hp/life read via `stateRaw`) | each player |
| A shot / swing being fired | `send("combat:attack", { from, seq, slot, targets, … })` | the attacker |
| Damage applied | victim's own `me.set` (hp) | the victim |
| A defeat (kill credit) | `send("combat:defeat", { victim, attacker, life })` | the victim |
| Score / round | `shared` (exactly-once marker — see SKILL.md host section) | `room.isHost` |
| Slow physical projectiles (grenades, rockets) | `objects` — one per projectile, **hard cap + `removeConfirmed`** | the thrower |

**Decisions:**
- **Aim with pointer lock** — a first-person or mouse-aimed shooter is the MANDATORY pointer-lock
  bucket (see `$genex-threejs-camera-direction`); the bundled camera locks by default, so ship it
  locked (not drag-to-turn) — and gate firing on `aimState === "locked"` so the lock-acquiring
  click doesn't also shoot.
- **The attacker judges the hit locally** ("favor the shooter"): raycast/cone-check against what
  *you* see, then broadcast ONE attack event naming the `targets` — and draw your own muzzle
  flash / tracer / swing arc **right there**, because `send` never echoes back to you. A high-ping
  victim occasionally "dies behind a wall"; that's inherent to server-less shooters — set the
  expectation, don't chase it with more smoothing.
- **Melee is the same event, different hit-test:** a range + cone check over `players`'
  `stateRaw` positions (plus a line-of-sight ray), targets sorted by distance — single-target for
  a punch, every candidate in the arc for a sword sweep.
- **Skip dead targets up front:** ignore players whose `stateRaw.hp <= 0` in every hit-test, so a
  corpse can't be re-hit during its respawn window.
- **The victim applies its own damage** on receiving an attack event that names it — each player
  owns their own hp, so there's no write conflict. **Dedupe per attack:** the attacker stamps every
  event with a `seq`; the victim keeps a small bounded set of handled `${from}:${seq}` keys and
  ignores repeats (events can arrive more than once around blips).
- **Defeat is exactly-once:** at hp 0 the VICTIM broadcasts `combat:defeat { victim, attacker,
  life }` — `life` is a counter in its player state that increments on every respawn, so everyone
  (including the scoring host) dedupes defeats on the `${victim}:${life}` key. The HOST turns that
  event into a point with the exactly-once marker write from the multiplayer skill's host section.
- **Respawn is a discontinuity:** reset hp, bump `life`, place the body at the spawn point, then
  publish with `room.me.snap(state)` — never `set`, or remotes glide the corpse across the map.
- **Hit-tests read `stateRaw`, not `state`** — the raw latest position, not the render-delayed
  smoothed one. Same for reading remote hp/life (discrete values; `state` would lerp them).
- **Hitscan/melee use `send`, never objects** — a shot is an event, not continuous state. Reserve
  `objects` for a *slow, visible* projectile players can dodge (a rocket): `claim` on spawn,
  `objects.set` its arc at ~30 Hz, `removeConfirmed` on impact/expiry, and a **hard per-player
  cap** that removes the oldest live projectile before spawning a new one (netcode-park ships
  cap = 2). Uncapped per-projectile spawns walk into the room's 128-object cap AND the message
  budget; the cap is what kept projectiles smooth for everyone in live testing.
- **Scoreboard is host-only and keyed by the stable `uid`**, never the session id (see the
  multiplayer skill's host section) — a reload must keep the player's points and color.

**Acceptance feel:** movement is smooth for 4–8 players; hits register on what you aimed at; a kill
scores exactly one point even if the host changes mid-fight; the scoreboard survives a reload; one
player on a throttled/backgrounded tab doesn't drag others.

### Every travel-time projectile vs moving targets — the "visual hit, no damage" trap

Any projectile that spends time moving through the world — object-owned, host-simulated, or
deterministically replayed from a throw event (fireball, rocket, dodgeball) — inherits BOTH classic
netcode failures, and the symptom is always the same: *the projectile visibly hits a strafing player
and nothing happens.* Do not limit these rules to one implementation style:

1. **Detection must run on the ATTACKER too, against `stateRaw`.** Target-only self-detection
   ("each player owns their own hp, so only I test hits on me") silently fails against movers:
   the thrower aimed at the smoothed ghost (~120 ms old), the deterministic projectile flies to
   where the target WAS, and the target's self-test against its own REAL position never fires.
   Run the attacker-side test each frame vs every remote's `stateRaw`, then send the damage
   event the victim always honors (dedupe by projectile id so self-detection can coexist).
2. **Sweep, never point-sample.** A projectile at 20 m/s moves ~0.33 m per 60 Hz frame — more
   than most hit radii. Track `prev` each frame and test segment(prev→pos) vs the target
   sphere, on both the attacker's and the target's tests.
3. Both channels apply damage through ONE deduped `applyHit(projectileId)` on the victim, so a
   ball registered by both sides still counts once.

---

## Recipe 3 — Co-op vs enemies (horde, tower defense, dungeon)

Players cooperate against AI the game itself controls. The trick: **one client runs the enemy AI**,
and it's the host, so it survives players joining and leaving.

| Thing | Channel | Authority |
| --- | --- | --- |
| Each player's avatar | `me.set` / `players` | each player |
| Each enemy / NPC | `objects` (`"enemy:<n>"`), one per enemy | the **host** |
| Wave number, shared score, boss hp | `shared` | `room.isHost` |
| Spawn flashes, hit sparks | `send` | the host / whoever hit |

**Decisions:**
- **The host owns and simulates the enemies.** On spawn, the host uses
  `claimConfirmed(id, { authority: "host" })`; after acceptance its tick runs the AI and
  `objects.set`s each enemy. Non-host clients never simulate enemies — they just draw
  `objects.get("enemy:n").state` (smoothed) and read `stateRaw` for hit-tests.
- **One object per enemy** (flat `{x,y,z,hp}`) so each smooths independently. For a big horde keep
  the count modest (≈8–16 active); it's casual, not a bullet-hell server.
- **Host migration keeps the game alive:** if the host leaves, its enemies are reassigned to the
  new host automatically. The new host reads each enemy's `stateRaw` and continues the AI from
  there — no wave restart. React to `on("host")` if the new host needs to (re)seed spawns.
- **Players still deal damage favor-the-player**: a **non-host** player `send`s "I hit enemy:3" and
  the host (owner of enemy:3) applies the damage to its enemy sim and publishes the new hp. But
  `send` never echoes to the sender — so when the **host itself** shoots an enemy it owns, it must
  apply that damage to its local enemy sim **directly**, not via `send` (which wouldn't come back).
  Rule of thumb: if `objects.get("enemy:3")?.isMine`, apply the hit locally; otherwise `send` it.
  Enemy death: the host awaits `objects.removeConfirmed("enemy:3")` before finalizing rewards.
- **Waves/score are host-only** in `shared`; late joiners read the current wave on connect.

**Acceptance feel:** enemies move smoothly for everyone; killing the host's tab mid-wave promotes a
new host and the enemies keep going within a second or two (no freeze, no duplicates); a late joiner
sees the correct wave and enemy positions.

---

## Recipe 4 — Team vs team (1v1 sides, 2v2, N-v-N: team deathmatch, CTF, team football)

Two (or more) sides; players on a side cooperate. The whole recipe hangs off ONE fact: **teams are
assigned by the HOST into `shared`, balanced from the first frame** — the mandatory team section in
SKILL.md is the assignment story, verbatim. Everything else is Recipe 1/2 mechanics filtered by team.

| Thing | Channel | Authority |
| --- | --- | --- |
| Each player's avatar (hp, `life`; the relay stamps `uid`) | `me.set` / `players` | each player |
| The team map (`id → red/blue`) | `shared` (`"teams"`) | the **host** — the SKILL.md reconciler, every tick |
| Team scores | `shared` (exactly-once marker — SKILL.md host section) | `room.isHost` |
| Attacks / defeats | `send` (Recipe 2 rules verbatim) | attacker / victim |
| A contested ball / flag / payload | `objects` (Recipe 1 rules) | current owner |

**Decisions:**
- **Matchmaking config is only headcount:** `preset: "open"` with `maxPlayers` = team size × team
  count, `minPlayers` = the count the game is playable at (`2` starts a 2v2 short-handed as a 1v1
  and refills to full; `4` waits for a full lobby — pick one deliberately). The server seats
  players; it will NEVER assign teams — that is your host code.
- **Run the SKILL.md team reconciler in the host tick** — sorted roster + smallest-team =
  round-robin balance, late joiners to the short side, the map in `shared` survives host
  migration. Do not re-derive teams anywhere else, and never read `mm.matchmaking.teams` (empty
  on `open`).
- **Everything team-flavored READS the map:** tint/skin by `teams[id]` (the tint recipe is in
  `$genex-threejs-character-controller` — clones share MATERIALS, so the naive version repaints
  both teams, and the naive fix draws zero calls), spawn each player on their
  team's side (respawn via `me.snap`), gate friendly fire in the hit-test — skip targets where
  `teams[target] === teams[me]` before applying damage — and frame the HUD ("your team" vs
  "enemy") from your own entry. A player not yet in the map renders neutral and takes no damage;
  never fold them into a side.
- **Score per TEAM, not per player:** the host turns Recipe 2's defeat events (or goals/captures)
  into a team point with the exactly-once marker write, keyed by the team id; per-player stats can
  ride alongside keyed by the stable `uid`.
- **Win + rematch are host-written `shared` facts:** the host checks its own condition (first to
  N, timer end) and writes `shared.set("result", { winner, at })`; everyone renders it. For a
  rematch the host clears `result` and the scores — keep the team map so nobody's side flips.

**Acceptance feel:** two browsers land on OPPOSITE teams instantly (the 1v1 case); a third and
fourth joiner alternate sides (never 3v1); killing the host's tab mid-match changes nobody's team;
the team score survives the host change; a just-joined player is neutral for a beat, then snaps to
the short-handed side.

---

## Recipe 5 — Title menu with Online / Local / Bots (the seat-contamination fix)

Almost every game opens on a menu: **Play Online**, **Local / Single-player**, **Bots**. The rule
that keeps online matches clean: **the menu is pre-multiplayer — there is no room, no queue, no
server contact until the player commits to online.** The chosen online API — `matchmake()` for fresh
bounded sessions, `connect()` for one ongoing shared world — IS the "Play Online" button. Call either
one earlier (page load, boot code, beside `waitForPlayer()`) and a player who picks Bots is already
present online. With matchmaking they contaminate quorum; with a shared world they spawn an avatar
for someone who never chose to enter it.

Exception: a truly always-online game may call `connect()` after identity and spawn immediately,
but then loading the game already means "join" — it has no Local/Bots choice and no fake Play screen.
An ongoing drop-in sumo ring can use that shape; a sumo title menu cannot auto-spawn behind Play.

| Moment | What runs | Relay contact |
| --- | --- | --- |
| Page load → menu | An **offline world** generated locally, menu overlay on top | NONE. Not `connect()`, not `matchmake()`. `waitForPlayer()` may run (mints identity only, seats nobody). |
| "Bots" / "Local" | The same offline world + local AI / single-player | NONE, ever. |
| "Play Online" | `matchmake()` → queue/seat, or `connect()` → ongoing shared world | FIRST contact. Only now are you an online participant. |
| Leaving online (back to menu / quit / switch to Bots after joining) | Tear down the online view, return to the offline menu | `mm.cancel()` for matchmaking; intentional `room.leave()` for connect. |

**Decisions:**
- **Every menu action blurs its button before acting.** Otherwise the first gameplay Space/Enter
  can natively activate the still-focused Play/Leave button again; scope menu keyboard handlers to
  menu/lobby phases (see the game-ui skill).
- **`matchmake()` is created lazily, on the click — not held from boot.** Keep the handle in a
  variable so you can `cancel()` it; create it inside the "Play Online" handler, not at module load.
- **`connect()` follows the same commitment rule when this menu exists.** Create the session and
  network avatar inside the online handler; intentional leave disables the rejoin loop, calls
  `room.leave()`, removes the online avatar, and returns to the offline world.
- **Bots/Local touch nothing networked.** They run the exact offline world the menu already booted.
  A player can sit in Bots forever and the online queue never knows they exist — which is the point.
- **The waiting screen is an online-only, post-commit overlay.** Show it only when
  `mm.matchmaking.status === 'waiting'` (seated, under `minPlayers`). On the menu there is no room,
  so there is nothing to show and no count to know — never render a "0 players waiting" teaser there.
- **Leaving online is `mm.cancel()`, always.** Back-to-menu button, browser-quit
  (`visibilitychange`/`pagehide` if you want promptness), or choosing Bots after having been seated —
  each calls `cancel()`. Skipping it re-creates the contamination from the other side: a squatted
  seat that never frees.
- **No new cheat surface.** The client only ever chose *when* to search — a player can always just
  not play. Seating, the roster, capacity, and adjudication remain server-authoritative, so a
  modified client still cannot fake participation or force the `minPlayers` gate.

```ts
let mm = null;                                   // no relay contact yet — we're on the menu
let wired = null;
bootOfflineWorld();                              // local world under the menu overlay
const { user } = await waitForPlayer();          // identity token only; seats nobody

function syncSession() {
  const live = mm?.session ?? null;
  if (live === wired) return;
  wired = live;
  if (live) wireRoom(live);
}

onClick("play-online", async () => {
  mm = await matchmake({
    urls: getColyseusUrls(),
    room: GENEX.slug,
    name: user.name,
    auth: () => getColyseusAuth(),
  });
  mm.on("matched", syncSession);
  mm.on("matchStart", syncSession);               // preset-only; `open` never emits it
  mm.on("queue", updateQueue);
  mm.on("error", showQueueError);
  showWaitingOverlay();                          // driven by mm.matchmaking.status, per SKILL.md
});
onClick("play-bots",  () => startBots());        // offline; mm stays null
onClick("leave-online", () => { mm?.cancel(); mm = null; returnToMenu(); });
// Poll every frame or on the independent 250ms network tick: a re-seat installs
// a NEW Session object; the old one is never mutated back to life.
syncSession();
```

**Acceptance feel:** a player who picks Bots never appears in anyone's online room; the online
waiting count reflects exactly the people who pressed Play Online; a player who backs out of online
frees their seat immediately, so a 3/4 lobby doesn't hang on a ghost.

---

## Not sure which? Start from the table

Whatever the genre, ask per thing: *is it one player's own state* (`me.set`) *· a moving thing
nobody owns* (`objects`) *· a slow agreed fact* (`shared`, host-written) *· or a one-off event*
(`send`)? Answer that for each moving/shared piece and the netcode is done. If you're inventing a
sixth mechanism, you've taken a wrong turn — re-read the channel table in SKILL.md.
