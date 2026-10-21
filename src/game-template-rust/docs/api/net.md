# Multiplayer

`sim.net` is the room the game plays in, read like input: the runtime cuts one frame of it before
the update hooks, and the writes a tick queues leave after the tick, so their effects arrive in a
later frame. Reads take `&self` and writes `&mut self`, so `on_draw` can draw remote players and can
never send. The types live in `genex::net`: `use genex::net::{NetConfig, NetEvent, NetStatus};`.

## In Studio

- The build chooses the room, never the game. A build with networking runs a **loopback room** in
  Live, captures, checks and demos: nothing reaches the network, `sim.net.connect()` seats you as
  the host of a room of one, your writes echo on the next tick, and a demo's `driver.net()` adds
  scripted remote players. Only exports and the published draft reach the relay.
- `[net] enabled = true` in `genex.toml` (`docs/api/genex-toml.md`) builds the game with
  networking. Without it every build is offline: `sim.net.status()` is `offline` with the reason
  `net-disabled`, writes refuse `net-not-joined` and `driver.net()` calls are ignored (counted in `__net.scriptIgnored`). Write the game so its
  local mode plays without the network.
- Online play is proved only on the published draft opened in two windows with two identities (a
  normal and a private window). A loopback demo, a capture or one window is not that proof: until
  someone has played the draft, say plainly that multiplayer was not exercised.

```rust
game.net(NetConfig::new().publish_hz(15).decimals(3).interp_delay_ticks(6));
game.on_update(|sim, ctx| {
    if sim.world.online && sim.net.status() == NetStatus::Offline {
        sim.net.connect(); // the commitment point: after the Play online click, never on boot
    }
    if ctx.keys.down(Key::KeyD) { sim.world.x += 0.1; } // move yourself locally, on the input tick
    sim.net.set_me(json!({ "x": sim.world.x })).ok();
    for event in sim.net.events() {
        if let NetEvent::Left { player } = event { sim.world.scores.remove(player.as_str()); }
    }
});
game.on_draw(|sim, frame, _| {
    for remote in sim.net.remotes() {
        let x = remote.state()["x"].as_f64().unwrap_or(0.0) as f32; // smoothed: drawing only
        frame.sphere(vec3(x, 0.5, 0.0), 0.5, Color::BLUE);
    }
});
```

## Reads and writes

- **Session.** `sim.net.connect()` joins the game's shared room, `sim.net.matchmake()` searches
  with the game's preset, `sim.net.cancel()` leaves a queue or a match seat and
  `sim.net.leave()` leaves on purpose (no auto-reconnect). `sim.net.status()` is `offline`,
  `connecting`, `searching`, `waiting`, `joined`, `reconnecting` or `closed`.
- **Players.** `sim.net.me()`, `sim.net.players()` (id order, me included), `sim.net.remotes()`
  (without me) and `sim.net.connected()` (seats in the reconnect grace do not count). A player's
  `state()` is smoothed and is for drawing only; `.state_raw()` is the latest value and serves
  every gameplay read (hits, pickups, reach, scores, flags).
- **Writes.** `sim.net.set_me(state)` is coalesced (the latest call leaves at `publish_hz`);
  `sim.net.snap_me(state)` is a teleport or respawn and leaves this tick. State is a JSON object
  of finite numbers, rounded to `decimals` when it is published.
- **Objects and the host.** `sim.net.object(id)` reads a shared object. `sim.net.claim(id)` asks
  to own it and `sim.net.claim_as_host(id)` is the host's seed or adoption claim; the answer is a
  `NetEvent::Control` with the ticket. Only the owner may `sim.net.set_object(id, state)`.
  `sim.net.host()` is `None` while authority is unsettled; `sim.net.is_host()` is true only when
  it is settled and you. `sim.net.set_shared(key, value)` is host only; `sim.net.shared(key)`
  reads it.
- **Messages.** `sim.net.send(kind, payload)` reaches everyone else and never echoes to you;
  `sim.net.send_to_host(payload)` reaches only the host; `sim.net.chat(text)` echoes to you.
  `sim.net.events()` holds this tick's events in arrival order.
- **Refusals.** A write is checked against this tick's frame and answers a `NetError` whose
  `code()` is `net-not-joined`, `net-not-host`, `net-not-owner`, `net-message-reserved` (a relay
  message name or a `__` key), `net-message-too-large`, `net-state-invalid` (not an object, or a
  non-finite number), `net-object-cap` (128 objects), `net-chat-too-long` (500 characters) or
  `net-code-invalid`. `game.net` installs once (`duplicate-net`) and refuses a publish rate
  outside 1..=30 Hz, more than 6 decimals or a delay outside 1..=30 ticks (`net-config-invalid`).

## The feel rules

- **Menu before online.** No `connect` or `matchmake` until the player commits (Play online, Find
  match); a local or bots mode never touches `sim.net`. Leaving online calls `sim.net.leave()`.
- **Render yourself locally.** Your own body moves on the input tick; never wait for your echo.
  Remote players and objects you do not own draw `state()` directly, with no second smoother.
- **Test raw.** Every gameplay rule reads `.state_raw()`; a fast body tests the segment from the
  previous raw position to the current one, never a single point.
- **Host-only shared state.** Teams, rounds and scores live in `set_shared` keys only the host
  writes. A team reconciler is game code: each tick the host keeps every present player's team,
  drops leavers and puts each newcomer, in id order, on the smaller team.
- **Claim before host simulation.** Write an object only after an accepted claim. When the host
  leaves, the new host claims each orphaned object with `claim_as_host` and seeds it from the
  last `.state_raw()`, so nothing jumps to the origin.
- **The message budget.** Publish continuous state with `set_me` and `set_object`, which coalesce;
  keep `send` for discrete moments. The relay answers floods with a `rate-limited` warning.
- **Quorum.** A game that needs two players leaves playing when `sim.net.connected()` falls
  below its minimum, and resumes on a return or a backfill.
- **Replaced.** A second window with the same identity closes the first seat with
  `NetEvent::Closed { reason: NetClose::Replaced }` (code 4409): show it and do not rejoin.

## Demos

A demo scripts remote players in the loopback room through `driver.net()`: `join(name)` (ids
`remote-1`, `remote-2`, ...), `leave`, `drop_connection`, `set_state`, `set_object`, `send`,
`chat`, `set_shared`, `make_host`, `answer_claims`, `latency_ticks`, `reconnect_for` and `close`.
A scripted run is a pure function of the seed and the script, so its checksum is the same on every
destination. Net state is never saved and never in the checksum; a reseed keeps a relay seat.

A helper the game needs beyond this (a lobby screen, a team reconciler, interpolation of your own)
is the game's own code: the facade keeps only what a hook cannot build, the write queue, publish
coalescing and the loopback room.
