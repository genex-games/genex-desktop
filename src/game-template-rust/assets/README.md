# Assets

Files the game loads at run time, committed with it: models (GLB or glTF), textures (PNG, JPEG,
WebP) and sounds (WAV, OGG, MP3, FLAC). Load a model in `on_reset` with
`gfx.assets().model("ship.glb")`, a path relative to this folder: a missing or unsafe path draws as
a magenta checker, never a crash. Models made by the studio's Blender tool come with their script
in `assets/src/<name>.py`. Never downloaded, never copied from `references/`.
