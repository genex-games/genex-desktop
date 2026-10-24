# Reading assets

A reset may read the game's own files while it builds the world: a level's JSON, a table of
waves, the triangles of a model for a navmesh or a collider. The bytes are part of the build, so
the same seed gives the same checksum on every destination.

```rust
game.on_reset(|sim, _seed, _rng, gfx| {
    let level = gfx.assets().bytes("levels/one.json").expect("the level ships with the game");
    let level = level.json().expect("the level is JSON");
    sim.world.enemies = level["enemies"].as_i64().unwrap_or(0);
    let rocks = gfx.assets().model("rocks.glb");
    sim.world.rock_triangles = gfx.assets().triangles(&rocks).ok();
});
```

- `gfx.assets().bytes(path)` answers the file's bytes (`AssetBytes`, shared, derefs to `[u8]`):
  `.json()` parses them (a `Value`, or `malformed`), `.as_str()` reads UTF-8 text and `.digest()`
  is their FNV-1a 64.
- `gfx.assets().triangles(&model)` answers the model's `ModelTriangles` (`positions`,
  `indices`, `min`, `max`; `.triangle_count()`): its default scene with node transforms applied,
  read by the renderer's own glTF reader. Never a render level of detail.
- `gfx.assets().info(path)` answers `AssetInfo` (`bytes`, `group`) without reading the file into
  the simulation, or `None` for an unsafe path or a file the build does not have.
- Keep what a reset read in the world (`Arc`, owned values): update hooks never read files. A
  world field names these types from the crate root, not the prelude
  (`use genex::{AnimationError, AssetBytes, AssetError, CharacterAsset, ModelTriangles, Skeleton};`).
- A re-seed reuses what the first seed read and parsed; reading again costs nothing.
- `state().assets` lists every path a reset read.
- In a Studio dev run, a changed file is swapped in place (`reloadAssets`, sent by Studio, never
  by a game): the renderer reads models, textures and environment maps again on the next frame.
  Bytes a reset already read (`bytes`, `triangles`, `character`) stay in the world until the next
  seed.

Reads follow one rule on every destination (desktop, web, phones):

| Refusal | When |
|-|-|
| `unsafe-path` | The path is absolute, climbs (`..`), has `.`, an empty segment, a backslash or NUL, or is a link or passes through one under `assets/`. |
| `missing` | The build has no file at the path. |
| `too-large` | The file is over 256 MiB. |
| `malformed` | `triangles` of a file that is not a GLB with triangles (or a `.gltf` whose buffers are not embedded), or of a GLB refused before it is read: a damaged container, an index naming an entry that does not exist, data past its buffer, a layout glTF does not give an attribute, or a node that is its own ancestor; `.json()` of bytes that are not JSON. |
| `not-at-reset` | Read outside `on_reset`. |
| `not-preloaded` | The file ships in a group that arrives while playing (streamed or a named group). |

Each refusal is an `AssetError` with `.code()` (`AssetErrorCode`, its wire spelling from
`.code().wire()`) and `.detail()` for a log line.

On a phone the compiled table is read first, then the files the build ships beside the game: the
app bundle's `assets/` on iOS, and the APK's `assets/` on Android (read by range through
`AAssetManager`). A game whose assets outgrow the table keeps its files under `assets/`, and
nothing in its code changes.

## Characters

A rigged GLB loads at reset the same way, as a `CharacterAsset`: its skeleton, parsed once and
shared by every seed.

```rust
game.on_reset(|sim, _seed, _rng, gfx| {
    match gfx.character("characters/hero.glb") {
        Ok(hero) => sim.world.hero = Some(hero),
        Err(error) => sim.world.note = error.code.wire().to_owned(),
    }
});
```

- `gfx.character(path)` answers the rig of the file's first skinned mesh node. It reads as
  `gfx.assets().bytes(path)` reads (in `on_reset`, boot and sim groups only) and lists the path in
  `state().assets`.
- `.joint_count()` and `.skeleton()` (joint names, parents, rest pose) describe it; `.path()` is
  the file it came from. Cloning one is cheap.
- Every refusal is `animation-asset-invalid` (`error.code.wire()`, with `error.detail` for a log
  line): an unsafe path, a file the build does not have or that ships in a streamed or named
  group, or a file that is not a GLB with a usable skin (no skinned mesh node, more than 256
  joints, a node with two parents, a cycle, a non-finite transform). Nothing crashes. A path the
  build does not have shows the checker when drawn with `frame.model`; a GLB the renderer reads
  but that has no usable skin still draws there as a static model.
