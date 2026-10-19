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
  `indices`, `min`, `max`): its default scene with node transforms applied, read by the renderer's
  own glTF reader. Never a render level of detail.
- `gfx.assets().info(path)` answers `AssetInfo` (`bytes`, `group`) without reading the file into
  the simulation, or `None` for an unsafe path or a file the build does not have.
- Keep what a reset read in the world (`Arc`, owned values): update hooks never read files.
- A re-seed reuses what the first seed read and parsed; reading again costs nothing.
- `state().assets` lists every path a reset read.

Reads follow one rule on every destination (desktop, web, phones):

| Refusal | When |
|-|-|
| `unsafe-path` | The path is absolute, climbs (`..`), has `.`, an empty segment, a backslash or NUL, is a link, or leads out of `assets/` once links are followed. |
| `missing` | The build has no file at the path. |
| `too-large` | The file is over 256 MiB. |
| `malformed` | `triangles` of a file that is not a GLB with triangles (or a `.gltf` whose buffers are not embedded), or of a GLB refused before it is read: a damaged container, an index naming an entry that does not exist, data past its buffer, a layout glTF does not give an attribute, or a node that is its own ancestor; `.json()` of bytes that are not JSON. |
| `not-at-reset` | Read outside `on_reset`. |
| `not-preloaded` | The file ships in a group that arrives while playing (streamed or a named group). |

Each refusal is an `AssetError` with `.code()` (`AssetErrorCode`, its wire spelling from
`.code().wire()`) and `.detail()` for a log line.
