# Assets

Files the game loads: made by the studio's tools or brought in from anywhere their license
allows. `assets/<name>.glb` is committed with the game, served to the preview and copied by
export; `assets/src/<name>.py` is the Blender script that made it, when Blender did (re-running it
replaces the file). Load with `loadAsset("<name>")` from `src/assets.js`. Stills in `references/`
are to look at, never copied here.
