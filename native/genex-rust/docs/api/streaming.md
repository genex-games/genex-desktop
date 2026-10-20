# Streaming a large world

A world bigger than memory is cut into square cells on the ground. The game names where the
action is (anchors: the player, a vehicle); the cells around them are simulated, and every cell
that enters is built by the game's own builders. The same seed and input give the same cells,
things and checksum on every destination and with any number of worker threads.

```rust
#[derive(Clone)]
struct Rock { x: f32, z: f32 }

game.streaming(Streaming::grid(64.0).sim_radius(1));
game.cell_content(|cell, inputs| {
    let (min, _) = inputs.bounds();
    let mut rng = inputs.rng();
    // The cell draws this model; its path joins state().assets in cell order.
    let _boulder = inputs.model("rocks/boulder.glb");
    (0..4).fold(CellBuild::default(), |build, _| {
        build.thing(Rock { x: min.x + rng.unit() * 64.0, z: min.y + rng.unit() * 64.0 })
    })
});
game.on_reset(|sim, _, _, _| sim.stream.set_anchor("player", vec3(0.0, 0.0, 0.0)).expect("inside the world"));
game.on_update(|sim, _| {
    for cell in sim.stream.entered() {
        let rocks: Vec<Rock> = cell.things::<Rock>().cloned().collect();
        sim.world.rocks.extend(rocks.into_iter().map(|rock| (cell.cell(), rock)));
    }
    let left = sim.stream.left().to_vec();
    sim.world.rocks.retain(|(cell, _)| !left.contains(cell));
    let at = sim.world.player;
    sim.stream.set_anchor("player", at).expect("inside the world");
});
```

- `Streaming::grid(size)`: cells of `size` metres (8 to 1024) anchored at world (0, 0).
  `.sim_radius(cells)` (default 1, at most 8), `.hysteresis(cells)` (default 1, at most 4: a cell
  leaves only past `sim_radius + hysteresis`), `.prefetch(cells)` (default 1, at most 4: built ahead)
  and `.anchors(n)` (default 1, at most 8). Register it once with `game.streaming(..)`.
- `sim.stream.set_anchor(name, at)` places an anchor; it takes effect at the start of the next
  tick. `sim.stream.clear_anchor(name)` removes one.
- Every tick starts with the commit: cells that left are listed by `sim.stream.left()`
  (descending), cells that entered by `sim.stream.entered()` (ascending), each with the things its
  builders added (`cell.things::<T>()`: builders in registration order, each one's things in the
  order it added them). Both lists hold for that tick only.
- `sim.stream.active()`, `sim.stream.is_active(cell)` and `sim.stream.anchors()` read the set.
- `game.cell_content(|cell, inputs| ..)` builds a cell. It runs on a worker thread (on the web, in
  place), so it must be pure: read only `inputs` (`cell()`, `seed()`, `bounds()`, `rng()`, a
  generator for this cell alone, and `model(path)`), never the world or a clock. Each facet may
  register its own; they run in registration order. `inputs.model(path)` paths appear in
  `state().assets` in cell order.
- Caps per cell, all builders together: 256 things, 64 colliders, 4096 group instances. A cell
  past one enters empty (`cell.refused()` is `stream-invalid`), nothing of it is kept, and
  `state().volatile.__stream.refused` names it.
- One memory cap for the simulated cells (128 MiB at the caps, the same on every device):
  `install` refuses a registration past it, or a size, radius or anchor count outside its range,
  `streaming-invalid`.
- `game.stream_commit(hook)` runs a `StreamCommit` hook for each cell that leaves (descending,
  hooks in reverse order) or enters (ascending, in order) inside the commit. Engine areas plug in
  here (streamed colliders, nav islands); a game rarely needs one.
- `game.stream_colliders()` streams static colliders (physics builds only): a builder adds them
  with `.part(CellColliders::new().with(collider))`, each a Rapier `ColliderBuilder`. They enter
  `sim.physics` with their cell (cells ascending, then in build order) and leave with it in
  reverse; `sim.facets.get::<StreamColliders>().handles(cell)` lists their handles. Register it
  once.

A build that is late holds the frame, never the commit: the tick waits for it, so the
simulation is the same however fast the machine is. `state().volatile.__stream` counts `stalls`
and `heldMs`. Live keeps drawing and shows the loading look after 250 ms. One `step(ms)` waits at
most 6 s; past that it answers with fewer `ticks` than asked, nothing of the held tick ran, and
`state().volatile.__stream.timeout` is `stream-hold-timeout` until the commit runs.

`state().__stream` is `{active, cells}`: the active cell count and a digest of the active cells.
It is display only and never in the checksum.

| Refusal | When |
|-|-|
| `stream-not-registered` | A `sim.stream` call in a game without `game.streaming`. |
| `stream-invalid` | An empty, overlong or control-character anchor name, a point that is not finite; a cell over its caps (reported, not returned). |
| `stream-out-of-world` | An anchor more than 8192 m from the origin on x or z. |
| `stream-too-many-anchors` | A new anchor name past the registration's `anchors(n)`. |
| `stream-hold-timeout` | Reported in `state().volatile.__stream.timeout`, never returned: a commit held past 6 s. |
