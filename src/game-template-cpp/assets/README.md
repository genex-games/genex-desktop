# Assets

Files the game loads at run time, committed with it: textures (PNG, JPEG, QOI, DDS), models (GLB
or glTF without Draco, OBJ, IQM, M3D, VOX) and sounds (WAV, OGG, MP3, QOA, XM, MOD). The browser
build packs this folder into its `.data` file, mounted at `/assets`; a Mac app carries it in
`Contents/Resources/assets`; Windows and Linux builds keep it beside the executable. Load with
`studio::asset("hero.png")`, `studio::assetModel("ship.glb")` and `studio::assetSound("hit.wav")`:
a missing texture or model shows a magenta checker and a missing sound stays silent, never a
crash. Models made by the studio's Blender tool come with their script in `assets/src/<name>.py`.
Never downloaded, never copied from `references/`.
