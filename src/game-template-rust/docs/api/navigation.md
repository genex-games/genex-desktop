# Navigation

`game.navigation(NavConfig::walker(radius, height))` registers the nav. Every seed rebuilds
`sim.nav` as an empty nav for that walker (the runtime owns it, as it owns physics). Bake in
`on_reset` and call `sim.nav.update(ctx.dt)` once per tick in `on_update`. The nav types live in
`genex::nav`, so the example names its own use line beside the prelude:
`use genex::nav::{NavArea, NavConfig, NavInput, NavMesh};` (`NavObstacle`, `NavMeshSource`,
`NavBudget` and the caps are there too).

```rust
game.navigation(NavConfig::walker(0.4, 1.8).with_tile(16.0));
game.on_reset(|sim, _, _, _| {
    let input = NavInput::new().with_triangles(&floor, &indices, NavArea::WALK).expect("floor");
    let mesh = NavMesh::bake(&input, sim.nav.config()).expect("navmesh");
    sim.nav.add_mesh(&mesh).expect("tiles");
});
game.on_update(|sim, ctx| sim.nav.update(ctx.dt));
```

- **Config.** `NavConfig::walker(r, h)` has climb 0.4 m, slope 45°, cells 0.2 m by 0.1 m and
  32 m tiles. Change them with `with_climb`, `with_slope`, `with_cells(cell, height)` and
  `with_tile(metres)`. A tile is a whole number of cells. With streaming, the stream cell size
  must be a whole number of tiles, or `install` refuses `streaming-invalid`.
- **Input.** `NavInput::new()` takes `with_triangles`, `with_mesh`, `with_box`, `with_terrain`,
  `with_area_volume(outline, min_y, max_y, area)` and `with_bounds`. Areas are `NavArea::WALK`,
  `ROAD`, `GRASS`, `WATER`, `DOOR` and `NavArea::custom(8..=62)`.
- **Meshes.** `NavMesh::bake(&input, &config)` bakes every tile over the input on the calling
  thread; `NavMesh::bake_tile(&input, &config, cell)` bakes one. Baking the same input again in
  one process is free (a memo of at most 32 MiB). `mesh.to_bytes()` writes `.navmesh` bytes.
  `NavMesh::from_bytes_for(&input, &config, bytes)` uses them when they were baked from this
  input and config; otherwise it bakes again and `mesh.source()` is `NavMeshSource::Rebaked`.
- **Tiles.** Tiles sit on a grid anchored at world (0, 0), keyed by `CellId`
  (`config.tile_of(point)`). `nav.add_tile(&tile)` adds one, `nav.remove_tile(cell)` removes one,
  and `nav.tiles()` and `nav.digest()` read them.
- **Areas.** `nav.set_area_cost(area, cost)` takes a finite cost above zero, or it refuses
  `nav-cost-invalid`. `nav.set_area_open(NavArea::DOOR, false)` shuts doors.
- **Obstacles.** `nav.add_obstacle(NavObstacle::Avoid { position, radius })` is a disc agents
  steer around. `CarveCylinder { base, radius, height }` and `CarveBox { transform }` (a unit cube)
  are cut out of the mesh: the tiles under them rebuild over the next updates, seven Recast stages
  per tile, `NavBudget::bake_units_per_tick` stages per update (default 7). Agents keep the old
  tile until the new one is swapped in. `nav.pending_rebuilds()` is 0 once settled. Move an
  obstacle with `nav.move_obstacle(id, shape)` and remove it with `nav.remove_obstacle(id)`.
  Carving needs a mesh added with its input: tiles read from bytes alone take avoid discs only
  (`nav-input-invalid`).
- **Refusals.** `nav-input-invalid`, `nav-config-invalid`, `nav-tile-invalid`, `nav-too-large`,
  `nav-cost-invalid`, `nav-link-invalid`. A refused call changes nothing.
- **Caps.** `NAV_TILES_MAX` 4096, `NAV_OBSTACLES_MAX` 256, `NAV_INPUT_TRIANGLES_MAX` 4,194,304,
  obstacles at most 256 m from their centre.

Agents, off-mesh links, bodies, path queries and `frame.nav_debug` are not available yet.
