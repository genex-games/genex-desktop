# Multiplayer patterns (optional advice)

Genex's experience with multiplayer web games on `@genex-ai/multiplayer`. None of this is required:
the API facts are in `genex__skill {"name":"genex-threejs-multiplayer"}`, and the game's design is
its own. Use what fits, ignore what does not.

## Choosing connect or matchmake from the experience

- One ongoing world people drop into, where late joiners enter what is already happening and solo
  play stays valid: `connect()`, one shared room.
- A fresh, bounded match, mission or race where quorum, a fair start, capacity, teams or parallel
  sessions matter: `matchmake()`, which forms capped rooms and reports the queue.
- Genre does not decide it: a sumo ring can be either. When the brief supports both and the answer
  changes the experience, one plain question to the person can settle it ("one ongoing arena, or a
  fresh fair match that starts together?").
- Writing the choice down before coding helps: the model, how a match starts, whether late joiners
  fill in, and what happens when players drop below quorum.

## Menus, lobbies and the moment a player goes online

- Many games put an offline menu first ("Play Online", "Local", "Bots") and reach the relay only
  when the player commits to online play. Calling `matchmake()` on page load seats a player who may
  then play bots, and they count toward `minPlayers` for everyone else; `mm.cancel()` when they
  leave online play avoids the same problem from the other side.
- A waiting screen makes sense only after the player has committed and is seated; from that click,
  showing their own slot from what the client already knows (their name, their colour) feels
  immediate, while the roster fills the other slots.
- With `open`, the lobby and the match can be one room: set `minPlayers` to the size you want and
  switch to play when `mm.matchmaking.status` becomes `'playing'`.
- Two lobby styles work well: a UI lobby (a list of seated players and a countdown) or a physical
  one (players walk around the world and step onto a ready pad; the host writes a countdown into
  `shared`).
- An always-online `connect()` world reads best with no Play button that seems to delay entry, and
  no fake "finding a match" screen.

## Teams on `open`

`mm.matchmaking.teams` is empty on `open`. A pattern that keeps teams balanced: one writer (the
current host) keeps an `id → team` map in `shared`, reconciles it when players join or leave
(fill the smaller team), and every client only reads it. Two browser windows on a two-team game
landing on opposite teams is a quick check that it works. Team spawns, friendly fire and a team
score sit on top of that map.

## Quorum, reconnects and leaving

- For `open`, `status` never returns to `'waiting'`. If the game needs its quorum during play,
  checking `session.activePlayers` (it leaves out seats in reconnect grace) in the game loop and in
  a low-rate timer lets it pause or end a match when players drop.
- The SDK reconnects through short blips by itself; a small "Reconnecting…" overlay while it does,
  and a menu with a rejoin button after a terminal disconnect (4409: opened elsewhere; 4401: signed
  out), keep the player informed.
- Awarding points exactly once across a host change is easiest with a monotonic marker written in
  the same `shared` update as the score.

## Physics and contested objects

- Claim-on-touch: whoever touches a pushable object claims it and simulates it while they own it;
  the SDK's soft handoff smooths ownership changes.
- A genuine simultaneous contest (a tug of war, sumo) works better host-authoritative: players
  send inputs with `room.inputs.send`, the host simulates in `room.onHostTick`.
- Keeping the number of contested objects modest keeps the bandwidth predictable.

## Per-genre setups

- **Sports / ball:** the ball is one `object`; cap its top speed so a full-speed shot stays
  returnable over the network.
- **Shooter:** hitscan judged by the shooter, damage and defeat de-duplicated by a shot id, a small
  per-player cap on live projectiles, respawn written by the host. Pointer lock for aim, acquired
  from a click.
- **Co-op:** the host simulates enemies as `objects`; a modest count (around 8–16 active) keeps a
  phone host comfortable.
- **Teams:** the team map above, team-coloured players, spawns on each team's side.
- **Casual expectations:** the relay has no anti-cheat; this suits friends and casual lobbies more
  than ranked play, which is worth saying in the game's own words when it matters.

## Testing and support

- Multiplayer runs on the Genex draft link. Testing it as two different players (a normal window
  and an incognito window, or a friend) exercises what one player cannot; until then, saying
  plainly that multiplayer has not been tried with two players keeps expectations honest.
- A build id shown somewhere quiet (a menu corner) and a compact status line (room, players, host,
  ping) in a debug overlay make player reports much easier to act on.
- Smoothness is felt more than seen: asking the person to play it and describe what feels off
  (rubber-banding, late hits, jitter) finds problems a screenshot cannot.
