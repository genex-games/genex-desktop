# Genex for Unreal Engine (the Fab plugin)

`Genex/` is the source of the plugin listed on Fab, Epic's marketplace. It is not part of the
Genex app and the app never loads it. Fab takes a code plugin only when it holds a C++ module, and
builds the plugin itself for every engine version the listing ticks, so only source goes up.

## What it does

One editor module, `GenexEditor` (Win64, Mac, Linux), adds a button with the word GENEX to the
level editor's toolbar (`LevelEditor.LevelEditorToolBar.PlayToolBar`, section `Genex`, entry
`Genex.OpenChat`).

- With Genex on the computer, a press opens `genex://editor/<the project's folder in base64url>`.
  Genex opens that project's chat as a small window over the editor, or offers to open the project
  as a game when it is not in Genex yet ([links](../../docs/play.md)).
- Without Genex, a press opens `https://genex.games/unreal-engine?s=fab-plugin`.
  Genex counts as present when a program answers `genex://` links: the registry on Windows, Launch
  Services on a Mac, `xdg-mime` on Linux.
- `UGenexChatLibrary` gives editor scripts `ProjectLink`, `IsGenexInstalled` and `OpenChat`. Genex's
  own editor helper looks for it and then adds no second button.

## Build and try it

```
<engine>/Engine/Build/BatchFiles/RunUAT.sh BuildPlugin -Plugin=<repo>/fab/unreal/Genex/Genex.uplugin -Package=<out>/Genex -TargetPlatforms=Mac -Rocket
```

On Windows use `RunUAT.bat` and `-TargetPlatforms=Win64`. Copy the package folder to a project's
`Plugins/Genex` and start the editor. A press needs an installed Genex with the `genex://editor`
link (after 0.2.11); a developer launch of Genex takes no links.

## Send it to Fab

Zip the `Genex` folder (`Genex.uplugin`, `Config`, `Resources`, `Source`, no `Binaries` or
`Intermediate`) and upload it once per engine version in the listing. A build that fails on Fab
returns the listing to draft with the log.
