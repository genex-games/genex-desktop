---
name: Asset sourcing
description: A timeboxed stage before builders start that fetches or generates every asset class the brief needs, in parallel, by the route for its class — CC0 models and full PBR scans, generated props, characters and textures — and never boxes, cones or flat-coloured scripts.
facts: web-game
---

# Asset sourcing

Most of a game's look is its assets, and an agent with a box script at hand always reaches for the
box. Source first, in parallel, then let builders place and light what was delivered.

## When

At the start of a build, as soon as the plan names its areas: about 20 to 30 minutes, every
request in parallel, before any facet builds an area's content. Again when an area is added.

## By asset class

| Class | Route, best first | Never |
| --- | --- | --- |
| Hero prop, furniture, vehicle (seen within 10 m) | `library__search` then `library__add`, else `cc0__search` a model; else `genex__asset` `model` with `auto-size` (`face-limit` for a mid prop) | a cube or cone script, a flat-coloured `blender__model` |
| Character, creature, enemy | `genex__asset` `character` or `creature`, then `animate` | a capsule, a mannequin |
| First-person arms and weapon | the arms kit in a Rust folder (`docs/examples/fps-arms/`), else `genex__asset` `model` | arms or a gun from boxes |
| Walls, floors, ground surfaces | `library__search` then `library__add`, else `cc0__fetch` a scan at `2k` with normal and ORM maps; `genex__asset` `texture` for a surface no scan has | a scan without normal and ORM, 1k or less on a near surface |
| Modular shell | `blender__model` kit scripts textured with scans | untextured modules |
| Trees, bushes, foliage | `gfx.plant(..)` in a Rust game (`docs/api/vegetation.md`), else a CC0 tree model with its impostor; `genex__asset` `image` (transparent) for leaf and grass cards | cone, sphere or box trees; one model in rows |
| Posters, grime, decals | `genex__asset` `image` or a CC0 decal | thin boxes |
| Sky | `library__search` then `library__add`, else the physical sky with the scene recipe, or a CC0 `.hdr` at 4k | a textured dome |
| Sound | `genex__asset` `sfx`, or CC0 | none |

## Rules

- **Search in few words.** `cc0__search` matches every word: search `bench`, then `park bench`,
  never `snowy soviet park bench`. A miss goes to `genex__asset` at once; do not retry for long.
- **Generate in parallel.** Ten to fifteen `genex__asset` `model` requests for the area's props
  start together and are waited on together; a generation is minutes, a rebuilt box bench is a
  round.
- **Full quality.** Fetch scans at `2k` with every map; `4k` for a hero surface that fills a
  desktop screen. A web boot or memory warning is answered by streaming groups and `bootMs`, never
  by smaller maps or fewer of them.
- **Heavy models.** A CC0 model over the import's triangle cap is decimated (Blender) with its
  levels and an impostor, never replaced by a primitive.
- **Record what landed.** Each sourced model gets a `- <tag>: <file>` line in the game's
  `docs/ASSETS.md` (its draw tag and its file under `assets/`), so builders place delivered files,
  the sourcing hold knows when to let them start, and the judges check provenance: a row planned as
  a model that ships as a box is a defect.
- **Blender is for kits and preparation.** Modular pieces textured with scans, decimation, levels
  and impostors of heavy models. A `blender__model` script of cubes and flat colours is greybox,
  whatever the tool's name.
