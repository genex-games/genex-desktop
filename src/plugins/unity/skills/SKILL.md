# Unity game development in Genex

Use this skill for a Unity 6 project. Read `recipes.md` for the relevant subsystem and
`editor-package/PROTOCOL.md` for exact argument and result shapes before unfamiliar calls.
These are instructions for tools the Unity plugin actually implements, not promises that
every optional package or build module is installed.

## First establish the project and Editor

Call `unity__status`. It must identify this project and return `ready: true`. If setup is
missing, explain the next action: select the Unity project in plugin settings, install the
Editor bridge, and open the project in an installed, licensed Unity 6 Editor. Setup actions
belong to the person; never edit account data, activate licenses or download modules for them.
An existing Unity game uses its current project directory; a linked project uses the explicit
Project folder setting. Verify the reported root before every consequential edit.

Read `unity__editor` with `operation: "status"`. Wait while compilation/import/play transition
is active. Read the loaded scenes and a paginated hierarchy. Follow `nextOffset` until null.
Use returned IDs; saved scenes use stable GlobalObjectIds, unsaved objects explicitly use
session IDs. Save scenes and re-read IDs before expecting them to survive an Editor reload.

## Develop and verify in a closed loop

1. Inspect the affected object, components, serialized properties, scripts and asset provenance.
2. Make a bounded edit using the matching tool. Use `unity__batch` for up to 25 independent
   ordinary operations; batches are ordered and nontransactional. Consent-bearing operations
   are excluded and use their own declared tools.
3. After writing a C# script or assembly definition, wait for compilation, reconnect after
   domain reload, and read console errors. Attach a new component only after it compiles.
4. Run `unity__verify` for compilation state and missing scripts in loaded scenes. It is a
   structural check; a green result does not prove gameplay behavior or unopened scenes.
5. Use Play mode, pause/step, the real camera capture, relevant EditMode/PlayMode tests and
   a supported target build as the task requires. Inspect the actual visual result.
6. Save the changed scene/project assets, report what ran, and preserve existing user work.

Text edits require `expectedSha256` from the latest read when overwriting. Preserve manual
edits; never reuse a stale hash or silently overwrite a source file. Paths stay under Assets;
external files must first be intentionally placed/imported into the project. A GLB is not
native Unity import support: use an installed, approved importer, or prepare FBX/another
supported source. Local Blender's `blender__model` supports `format: "fbx"`; inspect the
exact delivered path and import its FBX in the intended Unity project. Do not install an
optional importer automatically.

## Consent and remote operation uncertainty

`unity__change` names destructive changes explicitly: deletion, asset moves, prefab apply or
overwrite, packages, Undo/Redo, replacement/closing and build-scene configuration. Inspect the
target first and explain the consequence. Dirty scenes must be saved before closing/replacing;
there is no silent discard option. Never put `confirmed` in arguments or smuggle a destructive
command into a batch. The host provides authorization after the declared tool's consent.

`unity__test` and confirmed `unity__build` return a queued job ID. Poll that same ID with
`unity__jobs` (`operation: "status"`). Preserve failures, skipped tests and interrupted states.
Cancellation is supported before work starts and for running EditMode tests; Unity cannot safely
cancel a running BuildPlayer, PlayMode test or UPM operation through this bridge. Job records
survive domain reload in the current Editor session. A disconnect or timeout after sending is
ambiguous: inspect status, hierarchy, files and job records before deciding whether to retry.
Never automatically replay an accepted mutation or start the same build/test again.

Export only actual accepted build outputs. A queued build, successful screenshot or delivered
asset is insufficient completion evidence. No tool uploads, publishes or signs a game.
