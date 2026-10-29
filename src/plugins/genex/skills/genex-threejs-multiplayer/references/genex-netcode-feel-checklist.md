# Genex multiplayer netcode feel gate

Run this gate before calling any multiplayer loop playable. A build, screenshot, or one local client
does not prove networking. Keep the check proportional: one focused two-client pass, not a new test
suite for the game.

## Before coding

- Write the net-model line: `connect` or `matchmake`, the player-experience reason, start/quorum,
  late-join/backfill, and below-quorum/end behavior.
- Infer the model from the experience. Ask the user only if both an ongoing drop-in world and fresh
  bounded sessions are plausible and the brief does not choose between them.
- State authority per thing: local player, remote player, shared object, score/round, projectile/hit,
  and host-simulated entity.
- Budget the fastest interaction. Rendered remote state is delayed for smoothness; gameplay tests use
  `stateRaw`, sweep between raw samples, and cap speeds so reaction windows remain humanly possible.

## Lifecycle

- `connect` always-online world: no fake Play/finding screen; identity may be followed by immediate
  join/spawn. Leaving is explicit and stops terminal rejoin.
- `connect` behind Play/Online/Local/Bots: no relay contact or network spawn before the online click;
  Local/Bots stay offline; leaving online calls `room.leave()`.
- `matchmake`: create the handle only on Play/Find Match; show searching/waiting only after that
  commitment; leaving calls `mm.cancel()`; bind every replacement `mm.session`.
- Quorum-required games leave `playing` when connected quorum falls below the declared minimum.
  Ongoing shared worlds may continue solo only when that was the stated design.

## Authority and interaction

- Self movement and immediate reversible feedback happen locally on the input frame.
- Remote players and non-owned objects render `state` directly, with no second interpolator.
- Every gameplay read uses `stateRaw`: hit, return/deflect/catch, reach, pickup, goal, physics adoption,
  hp/ammo/flags, and target selection.
- Fast bodies/projectiles use a segment or swept-volume test from previous raw position to current raw
  position; point samples are not enough.
- Irreversible shared results wait for confirmed authority. `objects.set`/`snap` happen only after an
  accepted claim; host simulation waits for single-flight adoption and seeds from last raw truth.
- Every travel-time PvP projectile has attacker-side raw detection plus victim-side/self detection
  where appropriate, both feeding one projectile-id-deduped hit application.
- Hitstop never pauses the networking pump or another player's simulation. Freeze/slow the local
  presentation and locally owned gameplay clock only; keep sends, receives, reconnects, and quorum
  checks running.

## One focused proof with two distinct identities

Run it on the preview link (`npx genex preview`): a preview plays in rooms of its own, apart from
the live game. Use regular + incognito guest identities, two accounts/devices, or ask the user to
perform the exact sequence. Two tabs sharing one identity are one enforced seat.

1. Enter online using real clicks. Then press Space/Enter/the main action using real key input; confirm
   focus did not re-trigger Play/Leave and both sessions remain live.
2. Confirm reciprocal presence and movement: A sees B move and B sees A move.
3. Exercise the signature interaction at full intended speed: kick/return, projectile hit, shared
   object claim, enemy hit, or vehicle seat. Confirm immediate local feedback and exactly one result.
4. Exercise one authority transition: object ownership, seat, or host migration. Confirm no freeze,
   teleport-to-origin, duplicate point/damage, or host-only visual divergence.
5. For `matchmake`, drop one player, observe quorum/waiting behavior, then join a new identity and
   confirm re-seat/backfill. For `connect`, verify the declared leave/solo/host-migration behavior.

If this proof was not possible, say exactly which items remain unverified. Never substitute a
screenshot or local-test mode for multiplayer evidence.
