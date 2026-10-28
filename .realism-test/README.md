# Realism test (temporary, not for merge)

Throwaway scripts for one research question: can a Blender-made scene look realistic in Roblox?
They build a small alley from CC0 Poly Haven assets and show it in Roblox Studio without uploading
anything (EditableMesh and EditableImage live only in the open Studio). This folder and branch are
removed once the screenshots are taken.

1. `python3 -I fetch_assets.py <work>/assets` downloads the CC0 textures and models (about 50 MB).
2. `blender -b --factory-startup -P realism_scene.py -- <work>/assets <work>/export` builds the
   scene and exports meshes (GXM1), raw texture pixels and `manifest.json` (tested on Blender 4.5.15).
3. Open `realism-test.rbxlx` (a copy of Genex's baseplate template) in Roblox Studio.
4. `node studio_build.mjs <work>/export realism-test <work>/shots` builds it through Studio's MCP
   server and saves `today_*.jpg` (shape-only meshes, the template's lighting) and
   `realistic_*.jpg` (PBR SurfaceAppearances, Realistic lighting, atmosphere, post effects).
