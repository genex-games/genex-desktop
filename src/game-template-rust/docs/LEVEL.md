# Level

This game's level plan: the zones a person plays in, how they connect, where the player spawns,
how they leave, what they do and what holds them in. Write it before building any area
(`docs/level-plan.md` says how, for every kind of game), and change it in the same change that
changes the level. Each section takes list items: a zone is its id, a colon and what the player
does there; a connection is two zone ids joined by an arrow, a colon and its kind (door, opening,
stairs, ramp, ladder, lift, jump, path, gate); an exit, a spawn or a boundary is a zone id, a colon
and what it is (a zone with one connection is a planned dead end only when it is named under
Boundary or Exits). Zone ids are lowercase letters, digits and `-`. `docs/examples/blockout/` builds a greybox, its cameras and the level report from
a plan.

## Zones

## Connections

## Exits

## Spawns

## Play loop

## Boundary
