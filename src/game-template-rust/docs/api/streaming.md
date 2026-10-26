# Streaming a large world

A world bigger than memory is cut into square cells on the ground. The game names where the
action is (anchors: the player, a vehicle); the cells around them are simulated, and every cell
that enters is built by the game's own builders. The same seed and input give the same cells,
things and checksum on every destination and with any number of worker threads. The example
names its own use line beside the prelude: `use genex::{CellBuild, Streaming};` (`StreamCommit`,
`CellColliders` and `StreamColliders` come from `genex` too).

A game whose genex.toml sets `[streaming] enabled = false` is built without streaming:
`game.streaming` fails install `streaming-disabled`. Delete that line (or set it to `true`) to
use this page.

```rust
#[derive(Clone)]
struct Rock { x: f32, z: f32 }

game.streaming(Streaming::grid(64.0).sim_radius(1));
game.cell_content(|cell, inputs| {
    let (min, _) = inputs.bounds();
    let mut rng = inputs.rng();
    // The cell draws this model while it is in view; its path joins state().assets in cell order.
    let boulder = inputs.model("rocks/boulder.glb");
    let start = CellBuild::default().model(&boulder, Transform::from_xyz(min.x + 32.0, 0.0, min.y + 32.0));
    (0..4).fold(start, |build, _| {
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

- `Streaming::grid(size)`: cells of `size` metres (8 to 1024) anchored at world (0, 0);
  `.cell_size()` reads the size back.
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
- `CellBuild::model(&model, transform)` draws a model while its cell is within the view radius of
  the drawn camera. Drawing is automatic: the game makes no draw call.
  `Streaming::grid(64.0).view_radius(metres)` sets the radius (default 4 cells, at most 64 cells;
  past that `install` refuses `streaming-invalid`). Cells build again on a worker for the view,
  and their models stream in under the device's memory pool and frame budget. A model that is
  still loading draws nothing and is never listed as a missing model; a refused one draws the
  missing-asset checker. A model the asset index lists with levels of detail loads its coarsest
  level first and draws that until the whole model arrives. Display only: never in the checksum.
- `CellBuild::group(InstanceGroup)` draws a retained group while the cell is within the view
  radius: its rows upload once, and stop when the cell leaves the view. A built cell leaves the view
  only a cell side past the view radius, so a camera wobbling on the edge rebuilds and uploads
  nothing again (`state().volatile.__stream.view.groupsAdded` counts groups handed to the
  renderer). A model group draws once its model is resident (nothing while it loads). `inputs.scatter(&terrain, &rule)` is
  `Terrain::scatter` over the cell's bounds; the scatters of neighbouring cells meet exactly (the
  scatter of A plus the scatter of B is the scatter of A and B together). A cell whose groups hold
  more than `STREAM_CELL_INSTANCES_MAX` (4096) instances together draws nothing.

  ```rust
  let forest = Scatter::new(0.8, &[0]).with_scale(0.6, 1.4).following_ground(0.5);
  game.cell_content(move |_cell, inputs| {
      let trees = inputs.scatter(&terrain, &forest);
      CellBuild::<()>::default().group(InstanceGroup::models(&tree, trees).expect("under the cap"))
  });
  ```
- Captures are settled. A Studio capture of a streaming game first waits (at most 6 s,
  `STREAM_DRAIN_MAX_MS`) until every model and group its camera wants is resident or refused, so a
  capture right after a teleport shows what a capture after 300 frames shows. Live frames never
  wait. Past 6 s the capture is drawn with what is resident and `state().volatile.__stream.view`
  (Studio runs: `groups`, `groupInstances`, `drainPasses`, `drainMs`, `drainTimeouts`) reads
  `timeout: "stream-drain-timeout"` until a drain settles.
- `frame.cells_debug()` outlines the view's cells on the ground. Green: drawn. Yellow: loading.
  Grey: building. Red: refused.
- On the web a pack's cells and terrain tiles around the anchors are fetched while playing: each
  frame the page asks for the body and tile of every cell in the sim set, the next commit's set and
  the prefetch ring (by `Range`), hands what arrived to the sim's asset reads at the next frame,
  and drops a cell's files once it leaves. `state().volatile.webStream` (`files`, `bytes`,
  `inFlight`, `cells`) lists the cells whose files are resident. No call reads a cell's body while
  playing: read the pack from the compiled table (below) or a named group. A reset that reads a
  streamed file is refused `not-preloaded`, as natively.
- Caps per cell, all builders together: 256 things, 64 colliders, 4096 group instances. A cell
  past one enters empty (`cell.refused()` is `stream-invalid`), nothing of it is kept, and
  `state().volatile.__stream.refused` names it.
- One memory cap for the simulated cells (128 MiB at the caps, the same on every device):
  `install` refuses a registration past it, or a size, radius or anchor count outside its range,
  `streaming-invalid`.
- `game.stream_commit(hook)` runs a `StreamCommit` hook for each cell that leaves (descending,
  hooks in reverse order) or enters (ascending, in order) inside the commit. Engine areas plug in
  here (streamed colliders, nav islands: `docs/api/navigation.md`); a game rarely needs one.
- `game.stream_colliders()` streams static colliders (physics builds only): a builder adds them
  with `.part(CellColliders::new().with(collider))`, each a Rapier `ColliderBuilder`. They enter
  the raw Rapier world `sim.physics` dereferences to (`docs/api/physics.md`) with their cell (cells ascending, then in build order) and leave with it in
  reverse; `sim.facets.get::<StreamColliders>().handles(cell)` lists their handles. Register it
  once.
- A compiled cell pack (`world/*.cells.json`, compiled by the host into `assets/<folder>/`) is read
  whole with `genex::pack::CellPacks::from_table(ASSETS, "valley")` from the game's compiled asset
  table (the same table `install_with_assets` takes), so cell builders registered at install can
  use it; `CellPacks::read(&source, folder)` reads it through any asset source, natively the asset
  folder's checks (no link below `assets/`, no `..`). `packs.world()` is its `world.json` (cell
  size, bounds, listed cells), `packs.cell(cell)` a listed cell's content (things, colliders,
  models, groups; `None` for an empty cell), `packs.cells()` every listed cell ascending, and
  `packs.digest()` an FNV-1a 64 equal on every destination. A refused read
  (`PackReadError { refusal, path, detail }`) names the file: an asset code (`unsafe-path`,
  `missing`, `too-large`) or a pack code (`stream-pack-invalid` for a truncated body or another
  version, `stream-pack-digest` for a body that is not the listed bytes).
- `genex::digest::fnv1a64(bytes)`, `digest::fnv1a64_from(bytes, hash)` and `digest::hex64(hash)`
  are the digest the checksum uses, for a game's own digests: a game depends on `genex` alone.

  ```rust
  use genex::pack::CellPacks;
  static PACKS: LazyLock<CellPacks> = LazyLock::new(|| CellPacks::from_table(ASSETS, "valley").expect("the built pack"));
  game.cell_content(|cell, _inputs| {
      let mut build = CellBuild::<u32>::default();
      if let Some(pack) = PACKS.cell(cell) {
          for thing in &pack.things {
              build = build.thing(thing.kind);
          }
      }
      build
  });
  ```

## Terrain tiles

- `Streaming::grid(64.0).terrain(tiles)` streams one terrain tile per cell.
  `TerrainTiles::procedural(129, |x, z| height)` samples a pure function (it runs on the stream
  workers), quantized over `.with_height_range(min, max)` (default -512..512 m).
  `TerrainTiles::authored(index, size, read)` takes the import's `terrain/terrain.json` and its
  `terrain/<x>_<z>.r16` tiles; everything is checked first, and a bad file refuses
  `terrain-heights-invalid` with nothing made.
- A tile is 65, 129, 257 or 513 samples a side (`TERRAIN_TILE_SAMPLES`). Neighbours share their
  border samples bit for bit.
- `tiles.samples()`, `tiles.is_procedural()` and `tiles.authored_cells()` (ascending; none for
  procedural tiles, which cover every cell) describe them. `tiles.tile(cell, size)` is a cell's
  tile as a `Terrain` (with its layers) and `tiles.tile_heights(cell, size)` its `Heightfield`:
  `None` for an authored world without that tile or a cell size its tiles were not written for.
- `sim.stream.ground(x, z)` is the tile's `Terrain::height`: procedural tiles anywhere, authored
  ones only inside a sim-active cell (`None` elsewhere).
- With physics, `game.cell_content(tiles.colliders_content(64.0))` beside
  `game.stream_colliders()` gives each sim-active tile one heightfield collider, inserted and
  removed in canonical order; `.with_colliders(false)` turns them off. Neither happens on its own
  with `.terrain(..)`. `tiles.collider(cell, size)` is one tile's collider and
  `tiles.cell_colliders(cell, size)` the `CellColliders` part that carries it.

## Kept cells and saves

- `sim.stream.keep(cell)` keeps a cell in the simulated set wherever the anchors go (a cell the
  game changed and still simulates), from the next commit until `sim.stream.release(cell)` or a
  reseed; `sim.stream.kept()` lists them. At most 64 cells.
- `sim.stream.snapshot()` is a `Value` for the game's save (`docs/api/saves.md`): the anchors, the
  kept cells and the simulated cells, never their content (at most about 62 KB of JSON).
  `sim.stream.restore(&value)` restores it; the next commit leaves the cells it does not hold and
  enters the ones it does, so builders and `game.stream_colliders()` rebuild them in order. The game
  restores its own world beside it.
- Two restores of one save replay equal on every destination. A scene of streamed static
  colliders and kinematic characters also replays equal to the run that never restored. A scene
  with dynamic bodies does not: Rapier's slot generations, contacts and sleep state are not saved,
  so restored collider handles can differ.

```rust
let save: Value = sim.stream.snapshot(); // written with the game's own save
// Later, after the game restored its world from the same save:
sim.stream.restore(&save).expect("a save of this registration");
```

A build that is late holds the frame, never the commit: the tick waits for it, so the
simulation is the same however fast the machine is. `state().volatile.__stream` counts `stalls`
and `heldMs`. One `step(ms)` waits at most 6 s; past that it answers with fewer `ticks` than
asked, nothing of the held tick ran, and `state().volatile.__stream.timeout` is
`stream-hold-timeout` until the commit runs.

`state().__stream` is `{active, cells}`: the active cell count and a digest of the active cells.
It is display only and never in the checksum.

## Named asset groups

A group `genex.toml` declares (`[[asset_group]]`: a name and globs under `assets/`) loads while
playing, on a tick the simulation decides. It works without `game.streaming`, for a level game
loading interiors.

- `sim.stream.require("interior")` returns a ticket (the same ticket while the group stays
  required). Call it in a reset hook or an update hook. A group genex.toml does not declare is
  refused `stream-unknown-group`; the first require of a run is checked at the next tick's start
  instead (the build's groups are read then), and `sim.stream.group_refusal(ticket)` names it.
- `sim.stream.ready(ticket)` is `None` until the start of the tick `STREAM_GROUP_PREFETCH_TICKS`
  (2) after the require, then `Some(handles)`: `handles.bytes(path)` is a member's bytes and
  `handles.model(path)` a model member's handle (draw it with `frame.model`), both usable in
  `on_update`. `handles.paths()` lists the members.
- A member that is not loaded by then holds the frame, as a late cell build does, so the group is
  ready on the same tick on every destination. On the web a required group is fetched while
  playing: the frames before its members arrive are held, and it is ready on the native tick.
- `sim.stream.release_group("interior")` lets it go; requiring it again gives equal handles.
  `sim.stream.required_groups()` lists the groups required now.
- Required groups are not part of a save: a loaded game requires its groups again.

```rust
game.on_update(|sim, _| {
    let Some(ticket) = sim.world.ticket else {
        sim.world.ticket = sim.stream.require("interior").ok();
        return;
    };
    let Some(handles) = sim.stream.ready(ticket) else { return };
    let level = handles.bytes("interior/room.json");
});
```

| Refusal | When |
|-|-|
| `stream-not-registered` | A `sim.stream` call in a game without `game.streaming`. |
| `stream-invalid` | An empty, overlong or control-character anchor name, a point that is not finite, a 65th kept cell, a 65th required group; a cell over its caps (reported, not returned). |
| `stream-out-of-world` | An anchor or a kept cell more than 8192 m from the origin on x or z. |
| `stream-too-many-anchors` | A new anchor name past the registration's `anchors(n)`. |
| `stream-hold-timeout` | Reported in `state().volatile.__stream.timeout`, never returned: a commit held past 6 s. |
| `stream-snapshot-invalid` | A `restore` of another version or cell size, a field missing or of the wrong kind, a cell outside the world, or more anchors, kept or simulated cells than the registration holds. Nothing changes. |
| `stream-unknown-group` | `sim.stream.require` of a group the build's genex.toml does not declare. |
