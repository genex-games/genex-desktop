# Unity Editor integration

The bundled Unity plugin connects Genex to a local Unity 6 source project. It is a new
implementation; the retired integration in `archive/unity/` remains historical source.

## Integration status

This direct bridge has not completed licensed live Editor acceptance or established permission
for agentic access under [Unity's Terms of Service](https://unity.com/legal/terms-of-service),
sections 17.2 and 26. Resolve that authorization before agent use. The bridge's MIT license and
an activated Editor do not establish it. Unity documents an
[official CLI/Pipeline route](https://docs.unity.com/en-us/unity-cli/use-unity-cli); this bridge
does not yet use that route. Release review must also address applicable
[Unity Core Standards](https://unity.com/core-standards) and package distribution requirements.

## Open or create a project

Install and activate Unity 6 through Unity Hub, including the build modules you need. Open
the source folder containing `Assets`, `Packages/manifest.json` and
`ProjectSettings/ProjectVersion.txt`. Genex recognizes it before any browser entry point;
adoption preserves its scenes, scripts, packages, settings and existing instructions. It adds
only missing Genex metadata, Git history and Unity cache ignore rules.

The stage shows the Unity workspace. Enable the Unity plugin, install its Editor bridge
explicitly, then open the project in a detected Editor and connect. The plugin's setup also
creates a new, empty Unity 6 source folder with the bridge at a previously nonexistent path.
Open that folder in Genex afterward. Creating a project does not download an Editor or activate a license.

Bridge installation preserves unrelated dependencies and package settings. An installation
receipt protects package files against accidental replacement of human edits; generated
`.meta` files survive updates. A different configured bridge dependency requires review.

## Build through native tools

Use the game conversation and the `unity__skill` guide. The tools expose scene and hierarchy
inspection, stable object IDs, GameObjects, components and serialized properties, prefabs,
materials, scripts and supported text assets, packages, console, Play controls and PNG camera
or Scene captures. Type discovery describes installed APIs without arbitrary reflection
invocation. This supports installed physics, audio, animation, UI and rendering components;
package availability and the project's rendering pipeline still determine actual features.

Script overwrites require the hash returned by reading the file. Wait through compilation or
domain reload, read console errors and call project verification before claiming success.
Inspect loaded-scene missing scripts separately from compilation. Batches are bounded,
ordered and fail fast; earlier successful commands remain applied if a later command fails.
Unity Undo covers supported scene edits, not every filesystem or package operation.

Deletion, package changes, scene replacement, prefab application and builds use declared
confirmation boundaries. Ordinary parameters and batches cannot supply confirmation.
Editor jobs return IDs: poll the same job for EditMode/PlayMode tests, package operations or
player builds. Cancellation support depends on the underlying Unity API. A running
`BuildPlayer` operation cannot be safely interrupted and is observed to completion.
Builds write unique project-relative outputs under `Builds/Genex/`; install missing target
modules in Unity Hub. Select the matching active Build Profile in Unity and wait for compilation
before requesting that target; the bridge refuses mismatched platforms and dirty scenes.
A completed build is distinct from uploaded or published software.

Local Blender's `blender__model` accepts `format: "fbx"` for Unity. Generation retains the
GLB and two PNG previews and adds `model.fbx`; delivery into a Unity source project uses
`Assets/Generated/<plugin>/<job>/`. Import the returned FBX asset path through the Unity
bridge, then inspect its model and assign materials for the project's rendering pipeline.
Blender shaders do not imply equivalent Unity materials. Default browser delivery remains GLB.

Browser preview, browser public export and browser-scored Auto/Loop runs are not Unity
execution paths. They cannot certify a native game. Use native chat/tools and the Unity
workspace; export a completed player build for its selected target. WebGL build output may
be opened separately as a browser export.

## Connection and trust

The Editor package binds only `127.0.0.1` on an ephemeral port. Its private per-project
discovery file is in `Library/Genex`; an authenticated request carries a random session token
and every reply binds to its request and project. The plugin does not expose the token in
tool output. Buffers, captures, pagination and queued work are bounded.

Unity API work runs on the Editor's main thread. Domain reload may change the port; discovery
is reread on the next call. A lost, cancelled or timed-out response does not mean an accepted
mutation failed. Inspect its result before retrying; the client never automatically replays it.

The installed plugin and Editor package are trusted native code. Explicit Open Editor launches
only a detected GUI executable with fixed project arguments and a filtered environment. It
does not launch agent shells or silently remove the process sandbox. Scripts and packages
inside a Unity project execute with the Editor's permissions: only open projects you trust.

The package's [wire protocol](../src/plugins/unity/editor-package/PROTOCOL.md) owns exact
arguments, results and limits. [Editor tests](../src/plugins/unity/editor-package/Tests/Editor/)
exercise native behavior. JavaScript transport/setup tests and C# compilation alone do not
prove live scene editing, Play mode, Test Runner, captures or player builds. Release acceptance
requires an activated Editor and a disposable project through each of those operations.

## License and integration authorization

The bridge package is MIT; Unity Editor and its UPM dependencies retain their own terms.
An activated Editor does not establish permission for this integration. Unity's
[Terms of Service](https://unity.com/legal/terms-of-service) restrict agentic access
(sections 17.2 and 26). Authorization for this direct local bridge is not established;
confirm applicable permissions or an authorized route before live agent use.
