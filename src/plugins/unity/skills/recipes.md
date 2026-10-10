# Unity workflows

Every grouped tool takes `operation` plus structured `params`. Use object form; JSON-string
form is retained for older engine clients. Read the exact wire protocol for fields and limits.

## Scene and object authoring

Read scenes and hierarchy, save a new scene to `Assets/Scenes/Main.unity`, then re-read object
IDs. Create primitive or empty GameObjects through `unity__object`; place them using world
position/Euler rotation and local scale. Add components by unique full type name. Changes use
Editor Undo, but file and asset deletion do not. Open scenes additively by default. Prefabs can
be created and instantiated ordinarily; overwriting/applying an existing prefab needs consent.

## Components, physics, cameras, lighting, audio, animation and UI

Use `unity__component` (`types`) to discover concrete components installed in this project.
`inspect-type` exposes metadata without invoking methods. Add the real component, inspect its
serialized paths with `get`, and set only supported fields with `set`. Object-reference values
are returned IDs or null; enums use the listed index, arrays are resized before editing entries.

For physics, start with the appropriate Rigidbody/Collider and inspect mass, constraints and
collision settings. For cameras/lights/audio, inspect the actual pipeline and serialized fields
before setting them. Animator setup can reference an existing controller; authoring complex
controllers or Timeline assets requires reviewed project C# Editor scripts, compiled normally,
not a bridge eval function. Runtime scripts, tests and camera evidence establish behavior.

For uGUI/Canvas and UI Toolkit, first list installed packages/types. Use GameObjects/components
for installed uGUI controls; write UXML/USS through guarded `asset.write-text` for UI Toolkit and
bind a UIDocument to the imported assets. TextMeshPro/Input System/Cinemachine/ProBuilder/
Navigation features require the respective installed packages; their presence is never inferred
from Unity version alone. Request package changes explicitly via the confirmed change tool.

## Scripts and shader/UI source

Read the file first and keep its SHA. Write a complete bounded edit with that expected hash.
Read Editor status until compilation/import ends, reconnect after reload, inspect console,
then discover/add the newly compiled component. Write shaders, compute/HLSL includes, UXML,
USS, JSON and assembly definitions through the same file boundary. Material tools accept an
installed shader and named scalar/vector4/texture properties; inspect names instead of guessing.

## Assets and Blender

Search/inspect Assets and import only an existing project file. AssetDatabase moves preserve
GUIDs and require consent. Do not modify Packages/library caches as asset sources. Preserve
source models and inspect import results, transform scale, materials and animation clips.
Use Local Blender only when `blender__status` reports ready. Call `blender__model` with
`format: "fbx"` (plus its usual name/script inputs) to request `model.fbx` alongside the GLB
and two renders. A bound native Unity project receives those files under
`Assets/Generated/blender/<job>/`. Use the exact returned path. If the selected Unity root
is a separate linked project, intentionally place that source under its `Assets/Models/`
through the approved project file workflow first. Run
`unity__asset` (`import`) with that Assets-relative path and inspect the imported asset.
Do not assume Blender's delivered work directory is the linked Unity project or pass a path
outside a tool's allowed roots. The plugin does not silently install GLB importers or switch
to paid asset generation.

## Tests, builds and evidence

Start tests with `mode`, relevant `assemblyNames`/`testNames`, then poll their job ID. Record
passed/failed/skipped/inconclusive totals and failures. Structural `verify` is complementary.
Run Play mode, inspect console and capture the target camera; graphics capture needs a usable
graphics Editor session. Scene-view capture needs an open Scene view.
The active render pipeline must support the selected camera's standard render request;
URP requires a base camera. A null graphics device or unsupported pipeline/camera returns
an explicit limitation. Do not treat a failed request as a screenshot or install a pipeline
package to hide that limitation.

Read build scenes and installed supported targets. Select the intended active target in Unity
Build Profiles, then wait for compilation/import. The bridge refuses a mismatched target to
avoid building with the current platform's scripting symbols. Configuration changes and player builds
need declared consent. Save scenes before building. Poll the resulting build job, require
`state: completed` and `result.result: Succeeded`, and use its unique outputPath. Packaging,
platform signing, store accounts and publication remain explicit separate operations.

### Native validation sequence

Use this sequence for a completed game change. It does not start unattended web evaluation.

1. `unity__status` must report the expected project root and `ready: true`. Read
   `unity__editor` with `operation: "status"`; wait for compilation/import/Play transition to
   finish. Status fields are recorded at `observedAt`; a synchronous build can keep that
   snapshot old while its job records remain readable.
2. Call `unity__verify`, then `unity__editor` with `operation: "console"` and
   `params: {"type":"error","limit":100}`. Preserve current compilation errors and missing
   scripts as failures. Load relevant scenes explicitly before checking their references.
3. Call `unity__test` with `params: {"mode":"EditMode","assemblyNames":["Your.Tests"]}`;
   choose actual assemblies discovered in this project. Save the returned `id` immediately.
   Poll `unity__jobs` with `operation: "status", params: {"id":"returned-id"}` until a
   terminal state. Record passed, failed, skipped and inconclusive counts, plus failures.
   If runtime behavior needs tests, repeat with `mode: "PlayMode"` only after the first
   job finishes. A queued/running/interrupted job is incomplete evidence.
4. For visual behavior, inspect the intended camera and its real ID. Start Play using
   `unity__editor` (`play`), read status/console, and capture through `unity__capture` with
   `operation: "camera", params: {"id":"camera-id","width":960,"height":540}`. Inspect
   the PNG. Pause/step when useful, then stop Play. A capture establishes the observed frame,
   not untested gameplay. Record graphics or Scene-view limitations explicitly.
5. If a player build is required, read `unity__scene` (`build-scenes`) for saved enabled scenes
   and supported targets. Configure the exact scene list through the confirmed `unity__change`
   (`build-scenes`) if needed. Request the confirmed `unity__build` with an installed target,
   matching Unity's active target, save its returned ID and poll that same ID. Require `state: "completed"` and
   `result.result: "Succeeded"` before reporting or using its `outputPath`.
6. Report the actual project/Editor version, compilation/console result, structural check scope,
   test job IDs and counts, inspected capture, and completed build target/path. List incomplete
   or blocked checks beside those results. Never infer native validation from a mock transport,
   desktop UI screenshot, code-only compilation, browser score or accepted job.
