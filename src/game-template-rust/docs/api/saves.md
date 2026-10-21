# Saves

`game.saves(SaveConfig::schema(1))` gives the game save slots, and `game.save_world()` puts the
whole world in each slot through serde (`World` derives `Serialize` and `Deserialize`). A hook
asks `ctx.slots()` to save, load or delete a slot. The save types live in `genex::saves`:
`use genex::saves::{SaveConfig, SlotOp};`.

```rust
game.saves(SaveConfig::schema(2).migrate(1, |mut sections| {
    sections["world"]["coins"] = sections["world"]["gold"].take();
    Ok(sections)
}).autosave(3600, 3));
game.save_world();
game.save_section("door", |sim| json!(sim.world.door_open), |sim, value, _gfx| {
    sim.world.door_open = value.as_bool().ok_or("not a bool")?;
    Ok(())
});
game.on_update(|sim, ctx| {
    let slots = ctx.slots();
    if ctx.keys.pressed(Key::F5) { slots.save("quick", "Quick save").ok(); }
    if ctx.keys.pressed(Key::F9) { slots.load("quick").ok(); }
    for event in slots.events() {
        if event.op == SlotOp::Load && event.result.is_ok() { sim.world.toast = 120; }
    }
});
```

- **Config.** `SaveConfig::schema(n)` (at least 1) is the version this build writes.
  `.migrate(from, step)` moves a slot's game sections (an object of section name to value) from
  `from` to `from + 1`; an older slot runs every step up to `n` when it loads. `.autosave(ticks,
  ring)` writes `autosave-0` and on every `ticks` simulated ticks into a ring of 1 to 8 slots.
  `.autosave_on_suspend(on)` sets whether a suspend or close should also write the ring's oldest
  slot (default on). No shell writes that save yet. `.slots_max(n)` caps named slots at 1 to 32 (default 16); autosaves do not count.
- **Sections.** `game.save_world()` is the section `world`. `game.save_section(name, save, load)`
  adds any other: `save` reads the `Sim` and returns JSON, `load` writes it back onto the restored
  `Sim`. Physics bodies, facet state and anything outside `sim.world` need their own section. With
  `game.navigation` the runtime adds `genex.nav` (`sim.nav`'s snapshot), and with `game.streaming`
  it adds `genex.stream` (`sim.stream.snapshot()`: anchors, kept cells and active cells). A slot
  holds at most 62 game sections; names are at most 48 characters.
- **Saving.** `slots.save(slot, label)` queues a save written at the end of the tick, after
  physics. A save only reads, so it never changes the checksum. A slot name is 1 to 32 of
  `[a-z0-9-]` with no leading dash; `autosave-*` is the ring's. A label is at most 64 characters.
- **Loading.** `slots.load(slot)` restores before the next tick. The runtime builds a fresh `Sim`,
  runs the reset hooks with the slot's seed, restores `genex.nav`, `genex.stream` and then the
  game's sections in registration order, and sets the tick and `ctx.rng`. A streamed world's cells
  and their colliders are rebuilt by the next tick's commit. Only then does it replace the running game,
  so a refused load leaves it untouched. On the web a slot's body may still be loading: the game
  then runs no tick until it arrives (at most 6 s, else `save-load-timeout`).
- **Replay.** A load then the same input replays bit for bit, on every destination. It equals the
  run that never stopped when every state the probes read is in a section. The runtime compares
  the checksum it recomputes after a load with the saved one: a difference is the issue
  `save-restore-diverged`, and the load still applies. In a streamed world that checksum is taken
  before the commit rebuilds the cells, so a probe that reads streamed cells or their colliders
  reports `save-restore-diverged` even when the replay matches.
- **Listing.** `slots.list()` is every slot, sorted by name, and `slots.get(slot)` one of them:
  `SlotInfo { name, label, schema, tick, play_ms, bytes, autosave, state, saved_at_ms }`. `state`
  is `ready`, `needs-migration`, `newer` (a later build's) or `corrupt`. `slots.delete(slot)` removes
  one after the tick. `slots.busy()` is true while a load waits.
- **Events.** A queued call finishes as a `SlotEvent { op, slot, result }` in `slots.events()` of a
  later tick, `op` one of `save`, `load`, `delete` and `autosave`.
- **Refusals.** A call refuses at once or in its event: `save-slot-invalid`, `save-slot-missing`,
  `save-slots-full`, `save-too-large` (a slot over 16 MiB), `save-quota` (all saves over 64 MiB, or
  the browser's quota), `save-unavailable`, `save-corrupt`, `save-format-unknown`, `save-newer`,
  `save-migration-missing`, `save-migration-failed`, `save-section-invalid` (a `load` returned
  `Err`), `save-section-missing`, `save-busy` (a load is waiting), `save-load-timeout` and
  `save-not-configured` (no `game.saves`). `install` refuses `save-schema-invalid` (a schema of 0,
  a migration gap, a ring or slot cap out of range, too many sections), `save-section-reserved` (a
  `genex.` name), `duplicate-save-section` and `duplicate-saves`.
- **State.** While `game.saves` is registered, `state().volatile.saves` shows `store` (`files` or
  `indexeddb`), `files`, `bytes`, `quota`, `persistent`, `pending`, `inFlight`, `lazy`, `error`,
  `slots`, `lastSave {slot, tick, bytes}`, `lastLoad {slot, tick, checksumMatch}` and `issues`. It
  is the same on every destination and never in the checksum. In a Genex run a slot records no
  date.
- **Studio.** In a Studio run the host can list, read, write (seed a fixture envelope), save, load
  and delete slots through the dev `saves` verb; a load answers once it applied, with
  `checksumMatch`.
- `ctx.save(file, bytes)` and `ctx.load(file)` stay for a game's own files beside the slots.
