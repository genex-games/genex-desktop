---
name: Level plan
description: Before any area is built, plan the whole place — zones with a purpose, the connections between them, exits, spawns, the play loop and the boundary — then block all of it out in grey and prove every zone reachable before art goes on, zone by zone.
facts: web-game
---

# Level plan

A place makes sense when a person can tell where they are, where they came from and where they can
go. A run that polishes one room for hours ships a level with no way in or out. Plan the whole
place, block all of it out, prove it walkable, then dress it zone by zone.

## When

At the start of a build, right after the brief and before any facet builds an area; again when a
brief or a person's message adds a place. In a Rust game folder the plan is `docs/LEVEL.md` and
`docs/level-plan.md` has the rules, a row per kind of game and real sizes.

## Steps

1. **Pick the kind** of the brief (indoor shooter, town, dungeon, arena, racing, platformer, open
   world) and take its row: how many zones, their shape, how they join, what holds the player in.
   Mix rows when the brief mixes kinds. Never shape a level after one reference image alone.
2. **Write the plan** (`## Zones`, `## Connections`, `## Exits`, `## Spawns`, `## Play loop`,
   `## Boundary`): zones each with what the player does there; every connection and its kind; the
   exits; the spawns; the play loop, zone by zone; the boundary at every edge with a backdrop past it.
   More than four zones have a loop; a dead end holds something; a landmark every two or three
   zones.
3. **Block it all out** in about the first third of the budget: every zone at real size with
   colliders, every connection open, boundary up, spawns and exits marked, a tag and a
   `hero:<zone>` camera per zone, a top-down `map:top` camera. One facet may own the blockout; the others wait for it, or build
   systems that do not need the place.
4. **Prove it**: every zone and exit walkable from the spawn, dead ends only where planned and the
   boundary holding (the game's `state().__level` report; the judges name `unreachable-zone`,
   `no-exit`, `dead-end` and `unbounded` from it), the `map:top` capture matching the plan, a demo
   from spawn to exit. A missing connection is fixed in the level and the plan together.
5. **Then art, zone by zone** (`look-dev`, `asset-sourcing`): each zone's hero shot is judged on its
   own; a zone still in greybox never blocks another zone or another facet.

## Briefing a worker

Name the zones and connections it owns, their sizes, the spawn and exit it must keep reachable, and the
hero camera it is judged from. "Build the building" makes one corridor; "front yard, lobby, hall with
a workshop and an office off it, back yard with the exit gate; doors 1.2 m, hall 3 m wide; every
zone reachable from the yard" makes a level.
