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

- **Agents.** `sim.nav.add_agent(NavAgent::new(at))` adds one (`with_speed(desired, max)`,
  `with_radius`, `with_reach`, `with_links(&[kinds])`, `with_area_cost(area, cost)`); at most
  `NAV_AGENTS_MAX` 1024, and `nav.remove_agent(agent)` removes one. `nav.move_to(agent, target)`
  and `nav.stop(agent)` set its goal. The game moves it: after `nav.update(dt)`, read
  `nav.desired_velocity(agent)`, move the body (by hand, a character controller or root motion)
  and report back with `nav.set_position(agent, at, velocity)`. `nav.status(agent)` is `idle`,
  `moving`, `waiting` (the tick's search budget is spent), `arrived`, `at-link`, `on-link`,
  `no-path`, `off-mesh` (its tile streamed out: it stands still) or `target-off-mesh`;
  `nav.next_corner(agent)` is where it heads next.
- **Links.** `nav.add_link(NavLink::between(from, to, NavLinkKind::Ladder).both_ways())` joins two
  places (`Jump`, `Drop`, `Ladder`, `Door`, `Teleport`, `Custom(n)`; `with_cost`), and
  `nav.remove_link(link)` removes one. An agent at a link says `at-link`: `nav.take_link(agent)`
  returns the crossing (start, end, kind), the game plays it, then `nav.finish_link(agent)`.
  `nav.set_link_open(link, false)` locks one.
- **Bodies.** `nav.add_body(NavBody { position, velocity, radius })` is something agents steer
  around that the nav does not move (the player); `nav.set_body(body, ..)` moves it each tick and
  `nav.remove_body(body)` removes it.
- **Queries.** `nav.closest_point(near, reach)`, `nav.path(from, to, &NavFilter::new())` (steps,
  length, `partial`), `nav.raycast(from, to, &filter)`, `nav.move_along(from, to, &filter)`,
  `nav.distance_to_wall(at, reach)` and `nav.random_point(&mut rng, around, radius, &filter)`. A
  reset passes its `Pcg32`; a tick passes `&mut &ctx.rng`. It draws one number per polygon its
  search visits, then two. Queries read the mesh as of the last update. `NavFilter` sets
  per-query area costs, shut areas and link kinds.
- **Probe and saves.** `game.probe("nav", |sim| serde_json::Value::from(&sim.nav.probe()))` is a
  few hundred bytes for any agent count: agents by status, tiles, links, bodies, obstacles,
  pending rebuilds and an agents digest. `nav.snapshot()` saves agents (targets, paths, status),
  bodies, obstacles, link and area state; re-add the meshes and links as at reset, then
  `nav.restore(&snapshot)` (refused `nav-input-invalid` with nothing changed when they differ). A
  carving rebuild still queued at the snapshot finishes at once on restore.
- **Streamed islands.** With streaming, each cell's nav tiles come from its offline bake:
  `NavIsland::from_bytes(bytes)` in the cell builder, carried as a part, and a
  `game.stream_commit` hook that calls `NavIslands::enter`/`leave` (facet state) on `sim.nav`
  through `StreamedNav`. Leaving cells go out descending, then entering cells come in ascending; a
  late island holds the frame like a collider. Agents on a cell that leaves go `off-mesh` and
  freeze; when it comes back they walk on. On the web, islands come only from offline bakes.

`frame.nav_debug` draws nothing yet.
