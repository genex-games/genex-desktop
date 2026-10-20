# genex-nav: ported code

This file lists the code genex-nav takes from other projects, the version, the licence and what
changed. The header of each ported file names its source and its own changes. The repository's
`THIRD-PARTY-NOTICES.md` carries the licence rows.

## rerecast 0.5.0: Recast generation (`src/recast/`)

- Source: https://github.com/janhohenheim/rerecast at tag `v0.5.0`, `crates/rerecast/src/*`. The
  codeload tarball's sha256 is `1ed9c37afa1ccca1121b16bed89afd33dab05cf5668bbeeac58dc4d7054fc2d0`.
  The crate inside is version 0.4.0, published on crates.io the same day as the tag.
- Licence: MIT OR Apache-2.0, used under MIT (Jan Hohenheim and contributors). rerecast is a port
  of Recast (recastnavigation, Zlib).
- It is ported file for file: one module per upstream file, the same functions and the same
  stage order. The changes:
  - **R1**: glam 0.33 (the workspace's scalar-math + libm glam) instead of glam 0.32.
  - **R2**: `slotmap` is replaced by this crate's `arena` for span keys. The arena reuses the
    last-freed slot first, so keys come out in the same order. The unused `CompactSpanKey` is
    dropped.
  - **R3**: the `thiserror` derives become hand-written `Display` and `Error` impls with the same
    messages. `RecastError` wraps every stage's error, in place of the `anyhow` dependency. The
    `bitflags` types (`RegionId`, `RegionVertexId`, `BuildContoursFlags`) are written out with the
    `flag_set!` macro in `region.rs`. It gives bitflags 2's `|`, `&`, `!` (known bits only),
    `contains`, `intersects`, `bits` and `from_bits_retain`.
  - **R4**: `ops.rs` keeps only the operations the stages call. `floor`, `ceil` and `abs` are
    exact. `cos` always goes through libm (via glam's `Vec2::from_angle`); upstream does that only
    with its `libm` feature.
  - **R5**: `tracing`, `serde` and `bevy_reflect` are dropped. Only attributes and log lines go;
    every code path stays.
  - **R6**: upstream's `no_std` + `alloc` becomes std. The code allocates the same way.
- With these changes the crate takes no dependency beyond genex-core and glam.
- Parity: `tests/recast_parity.rs` is a port of `crates/rerecast/tests/cpp_comparison.rs` and
  `crates/test_utils`. It bakes Recast's dungeon level and compares the contour set, the polygon
  mesh and the detail mesh with C++ Recast's dumps. Detail vertices may differ by 1e-5, as
  upstream allows.

### Dungeon fixtures

`tests/fixtures/recast/dungeon/` holds rerecast's `assets/test/dungeon` files byte for byte, so
their sha256 match upstream:

| File | sha256 |
|-|-|
| `geometry.json` | `121bfbf980869c377c5ee3f6529159b81c1a12322a815a25ccb562a7c82b43a4` |
| `config.json` | `7e2e3869fd9fec43ec441ffbd23abcb6681f97134caa3c40cae49d6e83beffb6` |
| `convex_volumes.json` | `e689d0e2e66c13287257eab6cf9ba4e2a7665749e0906a419810068ac7d6384c` |
| `contour_set.json` | `1259942b30ab33cabb0fb70da59276d9684cf614ca66a54044bcd779ea9818c3` |
| `poly_mesh.json` | `ea8cabfb4d564141d394269ab82bf8cb06e69631fe062ca3fb3d27bed527a699` |
| `poly_mesh_detail.json` | `81025567d536f2da39241647fb1bcdd26d9f58274e38a5731415b462dc93b1db` |

- The geometry is Recast's demo level (`RecastDemo/Bin/Meshes/dungeon.obj` in recastnavigation,
  Zlib). rerecast's `assets/models/license.md` says: "Dungeon level copyrighted by John Ratcliff
  for use in recast algorithm testing".
- The stage dumps are 2-3 MB each and stay out of the repository. To run the stage-by-stage rows,
  fetch them from the same tag and point `GENEX_NAV_DUMPS` at their folder:

| File | sha256 |
|-|-|
| `heightfield_initial.json` | `77ed95307aca14234a1032e5d4c755f39af1702eddf78069e18938fa8b386b5a` |
| `heightfield_filtered.json` | `d6739569ab2f98834ae1bd51c8eb7d8300f6d3c717b1e320f833292ae5a3b381` |
| `compact_heightfield_initial.json` | `b80a9b35cd9785090922de476f6fde9f672f3e1d72be6e6e19a5adf7eb9e0c72` |
| `compact_heightfield_eroded.json` | `abf761970198b93b1e5e69b6220917fcf1c8b76c9dbe53124b739c5a7d63d72a` |
| `compact_heightfield_distance_field.json` | `74aeaeb995e00d92dd885257906406e13628c0f3fe01629d3556dec1e1f4f777` |
| `compact_heightfield_regions.json` | `b9750390859a4df660feb300ea4bba280fec9cba017cbc882b8164aa9ac8aa1c` |
| `compact_heightfield_contours.json` | `b9750390859a4df660feb300ea4bba280fec9cba017cbc882b8164aa9ac8aa1c` |

## The tiled bake and the tile format (`src/bake.rs`, `src/tile.rs`)

- Not ported code. The per-tile build follows the steps of Recast's
  `RecastDemo/Source/Sample_TileMesh.cpp` `buildTileMesh` (recastnavigation, Zlib), written over
  the port above:
  - a border of `walkableRadius + 3` cells;
  - the region partition keeps out the border;
  - every tile counts heights from the bounds' floor.
- `NavTile::navigation_mesh` does for genex's tiles what landmass_rerecast's
  `raw_conversion.rs` (MIT OR Apache-2.0) does for landmass. It was written from the two formats;
  no code was taken.
- The tile bytes are this crate's own layout, documented in `tile.rs`.

## landmass 0.9.3 and dodgy_2d 0.5.5 (`src/runtime/`)

The runtime core (NAV-4) and local avoidance (NAV-6) are ports too. Each ported file's header
lists its patches. The FNV-pinned traces live in `tests/runtime_stitch.rs` and
`tests/avoidance.rs`.

`src/runtime/detour.rs` (NAV-9) ports Detour's raycast, moveAlongSurface,
findRandomPointAroundCircle and findDistanceToWall (Zlib, altered; changes in the file header;
pinned digest in `tests/detour.rs`).

## Carving (`src/carve.rs`, NAV-10)

- Not ported code. The logic follows DetourTileCache (recastnavigation, Zlib; `DetourTileCache.cpp`:
  `dtObstacleCylinder`/`dtObstacleBox` shapes, obstacle requests marking the tiles they touch, a
  rebuild queue worked a bounded amount per update) and DotRecast's `Detour.Dynamic` (Zlib: keep a
  dynamic tile's checkpoint and rebuild only touched tiles from it). No code was copied.
- Changed: the bound is Recast stage units (7 per tile), not whole tiles; obstacles are marked
  with the null area on the compact heightfield before erosion, through rerecast's
  `mark_convex_poly_area` (already ported in `src/recast/`); the checkpoint is the compact
  heightfield, kept only while carving covers the tile; a cylinder is the circumscribed 12-gon.
