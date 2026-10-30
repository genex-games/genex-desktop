# Level plan

A place makes sense when a person can tell where they are, where they came from and where they can
go next. Plan the whole place first, greybox all of it, walk it end to end, and only then give each
zone its look. A level that is one finished room and nothing past it is not a level.

## The plan

Write `docs/LEVEL.md` before any area is built, and keep it true: a change to the level changes the
plan in the same round. It names:

- **Zones**: each with an id and what the player does there (a fight, a search, a view, a puzzle),
  never a name alone.
- **Connections**: every pair of zones a person can walk between, and how (door, opening, stairs,
  ramp, ladder, lift, jump, path, gate). A connection is an opening in the level, never a wall drawn
  over.
- **Exits and spawns**: how the player leaves or finishes (a gate, a stair down, the next level's
  door, the goal the game ends on), and the zones they start in. Arrival shows where the person came
  from: a road, a door behind them, a vehicle.
- **Boundary**: what holds the player in at every edge, as a thing of the place (fence, wall,
  rubble, locked door, cliff, water, dense trees), and a backdrop past it (facades, hills, a
  skyline) so the world does not end at the fence. Never an invisible wall in the open or the void
  past a floor.
- **Play loop**: what the player does, in order, zone by zone.

Rules for every kind of game:

- More than four zones have at least one loop: two ways between two zones, so a person can choose
  a route and get round a threat.
- A dead end (a zone with one connection) holds something worth the walk: a key, loot, an
  objective, a view. The plan marks it by naming the zone under `## Boundary` (what closes its far
  side) or `## Exits`; any other dead end is a defect.
- One landmark seen from far (a tower, a lit sign, a big tree) every two or three zones, so a person
  knows where they are.
- Real sizes (the table below), so a person reads the space as built.

`docs/examples/blockout/src/plan.rs` is a plan as data; the greybox, the cameras and the
level report are built from it:

<!-- compiled: plan -->
```rust
/// A building between a front yard and a back yard: in at the front, out at the back gate.
pub const PLAN: Plan = Plan {
    zones: &[
        Zone { id: "front-yard", purpose: "arrive, see the building", min: vec2(-12.0, 10.0), max: vec2(12.0, 22.0), indoors: false },
        Zone { id: "lobby", purpose: "first room, two ways on", min: vec2(-6.0, 4.0), max: vec2(6.0, 10.0), indoors: true },
        Zone { id: "workshop", purpose: "fight among the benches", min: vec2(-12.0, 4.0), max: vec2(-6.0, 10.0), indoors: true },
        Zone { id: "office", purpose: "the key to the back door", min: vec2(6.0, 4.0), max: vec2(12.0, 10.0), indoors: true },
        Zone { id: "hall", purpose: "the spine every room opens on", min: vec2(-12.0, 1.0), max: vec2(12.0, 4.0), indoors: true },
        Zone { id: "back-yard", purpose: "the last stretch to the gate", min: vec2(-12.0, -10.0), max: vec2(12.0, 1.0), indoors: false },
    ],
    links: &[
        Link { from: "front-yard", to: "lobby", kind: LinkKind::Door, at: vec2(0.0, 10.0), width: 1.6 },
        Link { from: "lobby", to: "hall", kind: LinkKind::Opening, at: vec2(0.0, 4.0), width: 2.0 },
        Link { from: "lobby", to: "workshop", kind: LinkKind::Door, at: vec2(-6.0, 7.0), width: 1.2 },
        Link { from: "hall", to: "workshop", kind: LinkKind::Door, at: vec2(-9.0, 4.0), width: 1.2 },
        Link { from: "hall", to: "office", kind: LinkKind::Door, at: vec2(9.0, 4.0), width: 1.2 },
        Link { from: "hall", to: "back-yard", kind: LinkKind::Door, at: vec2(0.0, 1.0), width: 1.6 },
    ],
    spawn: vec2(0.0, 18.0),
    exits: &[Exit { zone: "back-yard", kind: LinkKind::Gate, at: vec2(0.0, -9.0) }],
    boundary: &[
        Boundary { zone: "front-yard", kind: BoundaryKind::Fence, from: vec2(-12.0, 10.0), to: vec2(-12.0, 22.0) },
        Boundary { zone: "front-yard", kind: BoundaryKind::Fence, from: vec2(12.0, 10.0), to: vec2(12.0, 22.0) },
        Boundary { zone: "front-yard", kind: BoundaryKind::Fence, from: vec2(-12.0, 22.0), to: vec2(12.0, 22.0) },
        Boundary { zone: "front-yard", kind: BoundaryKind::Backdrop, from: vec2(-30.0, 34.0), to: vec2(30.0, 34.0) },
        Boundary { zone: "hall", kind: BoundaryKind::LockedDoor, from: vec2(-12.0, 2.0), to: vec2(-12.0, 3.0) },
        Boundary { zone: "office", kind: BoundaryKind::LockedDoor, from: vec2(12.0, 6.5), to: vec2(12.0, 7.5) },
        Boundary { zone: "back-yard", kind: BoundaryKind::Fence, from: vec2(-12.0, -10.0), to: vec2(-12.0, 1.0) },
        Boundary { zone: "back-yard", kind: BoundaryKind::Fence, from: vec2(12.0, -10.0), to: vec2(12.0, 1.0) },
        Boundary { zone: "back-yard", kind: BoundaryKind::Fence, from: vec2(-12.0, -10.0), to: vec2(-1.5, -10.0) },
        Boundary { zone: "back-yard", kind: BoundaryKind::Fence, from: vec2(1.5, -10.0), to: vec2(12.0, -10.0) },
    ],
};
```

## By kind

Start from the row of the brief's kind; several kinds mix (a horror shooter in a town: both rows).

| Kind | Zones | Shape | Connections | Boundary |
| --- | --- | --- | --- | --- |
| Indoor shooter, horror, stealth | 6 to 12 rooms and halls on 1 to 3 floors, with a yard or street outside | a spine hall with rooms off it, a loop through two rooms, a way out other than the way in | doors, openings, stairs, windows to climb | outer walls, locked doors, boarded windows, a yard fence |
| Town, street, open area | 5 to 10: streets, a square, yards, a park | streets 6 to 12 m wide between 30 to 60 m blocks, the square as a hub | streets, alleys, gates, steps | fences, walls, rubble, hills, water; facades and terrain as backdrop |
| Dungeon, crawler | 8 to 20 rooms | a critical path with side rooms, a hub, keys and the locks they open | doors, corridors 2 to 4 m wide, stairs, drops | rock, chasms, locked gates |
| Arena, multiplayer map | 3 lanes and the spaces between | balanced from each spawn, sight lines under 40 m | openings, ramps, jumps | walls, drops, out-of-bounds terrain |
| Racing | a circuit or a point-to-point, each section a zone | a track 10 to 14 m wide with 5 to 10 m of run-off | the track itself, checkpoints | barriers, fences, walls, scenery as backdrop |
| Platformer, action adventure | a chain of zones, a checkpoint in each | climbs and gaps sized from the character's jump | jumps, ladders, lifts | drops that respawn, cliffs, water |
| Open world, survival | a home zone and 4 to 8 regions, a landmark each | roads and paths between regions, streamed in cells (`docs/api/streaming.md`) | roads, paths, bridges | mountains, sea, a fenced border |

## Sizes

| Thing | Size |
| --- | --- |
| Character | capsule radius 0.35 m, height 1.8 m, eye 1.6 m (`docs/api/characters.md`) |
| Door | 1.0 to 1.2 m wide (double 1.6 to 2.0 m), 2.1 m high |
| Corridor | 2 to 3 m wide; a hall 3 to 6 m |
| Ceiling | 2.7 to 3.5 m in a room, 4 to 6 m in a hall or a factory |
| Stairs | rise 0.15 to 0.18 m (the character climbs at most `step_height`, 0.3 m), run 0.28 to 0.30 m, at least 1.2 m wide |
| Ramp | at most 30 degrees (the character slides past `max_slope_degrees`, 45) |
| Boundary that must hold | 2 m or more: the default jump (7 m/s against gravity 22) rises about 1.1 m |
| Cover | 1.0 to 1.2 m to crouch behind, 2 m to stand behind |
| Street | 6 to 12 m between kerbs, pavements 2 to 3 m |

## Blockout first

1. **Whole level, grey, first.** In about the first third of the build, every zone of the plan as
   boxes at real size with colliders, every connection open, the boundary up, the spawns and exits
   marked, under a GREYBOX header. Never polish one zone while another is missing.
2. **Measure it.** The game reports `state().__level`: whether each zone and exit can be walked to
   from the spawn on a nav baked from the colliders, the dead ends the plan did not mean, and
   whether the boundary holds. A `map:top` camera looks straight down, orthographic, at the whole
   level; a `frame.tag("zone:<id>")` goes before each zone's draws and a `hero:<zone>` camera stands
   in each zone. Compare the map capture with the plan.
3. **Walk it.** A `demo` from the spawn to each exit, through every connection the play loop names.
4. **Then the art, zone by zone.** Each zone takes its look recipe (`docs/look-recipes.md`), its kit
   and props (`docs/examples/rooms-and-buildings.md`) and is judged from its `hero:<zone>` camera.
   A zone still in greybox does not stop work on another.

The judges read the report: a zone it cannot reach is `unreachable-zone`, a planned exit it cannot
reach is `no-exit`, an unplanned dead end is `dead-end`, a boundary that does not hold is
`unbounded`. The report from `docs/examples/blockout/src/game.rs`, registered with
`game.probe("__level", ..)`:

<!-- compiled: level-probe -->
```rust
/// The level's reachability report, `state().__level`: whether each zone can be walked to from the
/// spawn, which zones hold a reachable exit, the dead ends the plan did not mean, and whether the
/// boundary holds the player in.
fn level(nav: &Nav, plan: &Plan) -> Value {
    let from = ground(plan.spawn);
    let walk = |to: Vec2| nav.path(from, ground(to), &NavFilter::new()).is_some_and(|path| !path.partial);
    let mut zones = json!({});
    for zone in plan.zones {
        zones[zone.id] = json!({ "reachable": walk(zone.centre()), "exits": plan.links_of(zone.id) });
    }
    let exits: Vec<&str> = plan.exits.iter().filter(|exit| walk(exit.at)).map(|exit| exit.zone).collect();
    let start = spawn_zone(plan).map(|zone| zone.id);
    let unplanned = |zone: &&Zone| plan.links_of(zone.id) < 2 && Some(zone.id) != start && !plan.planned_end(zone.id);
    let dead_ends: Vec<Value> = plan.zones.iter().filter(unplanned).map(|zone| json!({ "zone": zone.id, "at": ground(zone.centre()).to_array() })).collect();
    json!({ "version": 1, "spawn": start, "zones": zones, "exits": exits, "deadEnds": dead_ends, "bounded": bounded(plan) })
}

/// Whether every outer edge of the floors (one no other zone continues past) is closed by a solid
/// box from the ground to at least `HOLD` high, but at an exit, the one planned way out.
fn bounded(plan: &Plan) -> bool {
    let solids = solids(plan);
    let closed = |at: Vec2| {
        let blocks = |s: &Solid| s.solid() && s.role != Role::Floor && s.min.y <= 0.0 && s.max.y >= HOLD;
        solids.iter().filter(|s| blocks(s)).any(|s| (s.min.x..=s.max.x).contains(&at.x) && (s.min.z..=s.max.z).contains(&at.y))
    };
    let at_exit = |at: Vec2| plan.exits.iter().any(|exit| exit.at.distance(at) <= EXIT_GAP);
    plan.zones.iter().all(|zone| {
        edges(zone).into_iter().all(|edge| {
            let outward = -edge.inward;
            edge.samples().all(|at| plan.zones.iter().any(|other| other.holds(at + outward * 0.3)) || at_exit(at) || closed(at + edge.inward * 0.05))
        })
    })
}
```

It needs `[nav] enabled = true` in `genex.toml` and the bake in `on_reset` from the level's static
colliders (`docs/api/navigation.md`).
