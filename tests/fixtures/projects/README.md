# Project fixtures

Tiny synthetic folders standing for the kinds of project Genex opens. Tests copy one into a temp
folder with `copyProject` (`tests/helpers/project-fixtures.ts`), which also adds the files an
engine writes while it runs (`.godot/`, `*.blend1`, `Saved/`, `Intermediate/`, `Cache/`); those are
never committed here.

- `godot-game/`: a Godot 4 game (`project.godot`, one scene, one script), no web page.
- `blender-assets/`: a pack of Blender props and a brief, no game at all.
- `web-folder/`: someone's own web game: a page loading `game.js`, a package with no build script.
- `unreal-game/`: an Unreal game with the Genex editor helper in `Plugins/GenexEditorHelper/`.
- `unreal-plugin-src/`: an Unreal C++ editor plugin on its own, with no host project.
- `unreal-and-site/`: an Unreal game with a web site in `site/`.
- `toy-project/`: a project of the made-up toy engine (`tests/fixtures/toy-engine-plugin/`), with a
  vendored toy project in `vendor/kit/` that its plugin's `notUnder` leaves out.
