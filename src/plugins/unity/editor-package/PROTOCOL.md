# Genex Unity Editor protocol 1

The UPM package `com.genex.unity-bridge` runs only in the Unity 6 Editor. Its TCP listener
binds `127.0.0.1` on an ephemeral port. Discovery is the private, atomically replaced
`Library/Genex/bridge.json`: `protocol`, `host`, `port`, `token`, `projectRoot`, `projectId`,
`pid`, `unityVersion`. The directory/file belongs only to the current OS user. The 32-byte
random token is encoded as 64 lowercase hexadecimal characters, kept in `SessionState`
across domain reloads, and replaced when the Editor session ends. Never show it in logs,
tool output or prompts. `projectId` is SHA-256 of the UTF-8 absolute project root, replacing
backslashes with `/` and lowercasing on Windows.

Each connection accepts one UTF-8 JSON request terminated by LF:

```json
{"id":"request-1","token":"<discovery token>","method":"editor.status","params":{}}
```

Replies include the request `id` and `projectId`:

```json
{"id":"request-1","projectId":"<project hash>","ok":true,"result":{}}
{"id":"request-1","projectId":"<project hash>","ok":false,"error":{"code":"busy","message":"Unity is compiling or importing; read status and wait"}}
```

Requests are capped at 1 MiB, JSON depth 32, with duplicate properties rejected. Replies
are capped at 4 MiB. Each connection ends after its reply. There are at most 32 clients
and queued requests; ordinary operations run on `EditorApplication.update`. Compilation
and import return `busy` except for status, console and job polling. Domain reload shuts
down the old listener and publishes a new endpoint. Re-read discovery on reconnect;
**never replay a mutation after a disconnect or ambiguous timeout**. A cancellation closes
the waiting client's connection; it does not undo an Editor operation already accepted.
A server wait timeout reports `completion_unknown`: the operation may already be running.
Status is an explicitly timestamped main-thread snapshot, and job status/summary reads use
immutable JSON records without calling Unity APIs from the transport threads.

`confirmed: true` is a host-produced authorization flag, not an agent-controlled option.
The Genex backend must reject it in ordinary tool arguments and add it only after the
corresponding confirmed tool has been approved. Authenticated transports do not replace
the host's tool consent. The Editor also checks this flag for destructive operations.

## Shared arguments

All parameters are objects. Paths use forward slashes relative to this project, stay under
`Assets`, and reject absolute paths, `..`, dot-leading segments, Windows device names,
alternate streams and linked files/folders. Build outputs are separate unique
`Builds/Genex/<job-id>/` directories. Object IDs are `GlobalObjectId` strings for saved
scene/asset objects; `session:<instance-id>` explicitly identifies unsaved scene objects.
Re-read IDs after saving an unsaved scene or reloading. A `scene` selector is a loaded scene
handle (decimal string, to preserve Unity 6.5's 64-bit value) or its Assets-relative path;
omitted means the active scene. Paginated lists use
`offset` (default 0) and `limit` (1–500, default 100), returning `items`, `total`, `nextOffset`.

## Methods

| Method | Parameters | Result / behavior |
| --- | --- | --- |
| `editor.status` | none | Project identity, Unity version, compilation/import/play/build state, active scene/target, implemented methods, and bounded job summaries. `snapshot: true` and `observedAt` identify when the main-thread fields were recorded; these remain readable while a synchronous build runs. Job summaries and the running-build flag are refreshed from immutable job records. |
| `editor.console` | `since?`, `type?` (`all`, `error`, `warning`, `log`, `exception`, `assert`), `limit?`, `tail?` (false) | `entries` with sequence/type/message/stack; `nextSequence`, `oldestSequence`. Last 500 logs since bridge load; follow cursor or request the latest page with `tail: true` |
| `editor.play`, `editor.stop` | none | Request Play/Edit transition, return status; poll after reload |
| `editor.pause` | `paused?` (true) | Pause/resume and status |
| `editor.step` | none | One frame in paused Play mode |
| `editor.undo`, `editor.redo` | `confirmed` | Perform Editor undo/redo; may affect a human's prior operation |
| `scene.list` | none | Loaded `scenes`: handle/name/path/dirty/active |
| `scene.create` | `defaultObjects?`, `additive?` (true), `active?` (true); `confirmed` for replacement | Create empty/default scene. Replacement refuses any dirty loaded scene |
| `scene.open` | `path`, `additive?`, `active?`; `confirmed` for replacement | Open a saved scene, preserve dirty scenes |
| `scene.save` | `scene?`, `path?`; `confirmed` to overwrite a different existing asset | Saved scene description |
| `scene.close` | `scene?`, `confirmed` | Close clean scene; refuses last loaded scene and dirty scenes |
| `hierarchy.list` | `scene?`, `depth?` (0–100, default 20), pagination | Recursive flat hierarchy: ID/parent/name/active/scene/depth/childCount; at most 100000 objects |
| `object.inspect` | `id` | Name, parent, active, layer, tag, world position/Euler rotation, local scale, component IDs/types |
| `object.create` | `name?`, `primitive?` (`Sphere`, `Capsule`, `Cylinder`, `Cube`, `Plane`, `Quad`), `scene?`, `parent?`; update fields | New object description, Undo registered |
| `object.update` | `id`; `name?`, `active?`, `tag?`, `layer?`, `position?`, `rotation?`, `scale?`, `parent?` (null unparents) | Changed scene object; transform vectors are three finite numbers |
| `object.delete` | `id`, `confirmed` | Delete loaded scene object with Undo |
| `component.list` | GameObject `id` | Component IDs and full type names; missing scripts marked |
| `component.add` | GameObject `id`, unique concrete Component `type` | New component ID/type, Undo |
| `component.remove` | Component `id`, `confirmed` | Remove component with Undo; Transform protected |
| `component.get` | Component `id`, pagination | Visible serialized property paths/types/values/editability, up to 2000 properties |
| `component.set` | Component `id`, `property`, `value` | Set scalar, enum index, object-reference ID/null, vector/color/quaternion/rect/bounds or array size; protected lifecycle/script pointers refused |
| `component.types` | `query?`, pagination | Available concrete Component full type/assembly names; includes installed optional subsystems |
| `type.inspect` | Fully qualified loaded `type` | Metadata for fields/properties/methods without invoking anything |
| `project.verify` | none | Current compilation status and missing scripts in loaded scenes; this is not a game behavior test |
| `scene.build-scenes` | `scenes?:[{path,enabled?}]`, `confirmed` to change | Read/change project build scenes; active target and installed supported targets |
| `asset.search` | `query?` (Unity FindAssets syntax), `folder?` (`Assets`), pagination | Paths/GUIDs/types |
| `asset.inspect` | `path` | Asset ID/GUID/type/importer/dependencies/bytes |
| `asset.import` | `path` | Import existing project file/folder; no external copy or package installation |
| `asset.move` | `path`, `destination`, `confirmed` | Move through AssetDatabase, preserve GUID; destination must not exist |
| `asset.delete` | `path`, `confirmed` | Delete through AssetDatabase (not undoable; no automatic replay) |
| `prefab.create` | Scene object `id`, `.prefab` `path`; `confirmed` when overwriting | Save prefab asset ID/GUID/path |
| `prefab.instantiate` | `.prefab` `path`, `scene?`; object update fields | Instance description and Undo |
| `prefab.apply` | Instance `id`, `confirmed` | Apply outermost instance overrides to Assets prefab |
| `material.create` | New `.mat` `path`, installed `shader?` (Standard), `properties?` | Material path/ID/shader |
| `material.update` | `.mat` `path`, `properties?` | Undo and save this material only. Properties map shader names to number, four-number vector/color or texture Assets path |
| `script.read` | `path` | UTF-8 `contents`, `sha256`; at most 512 KiB |
| `script.write` | `path`, `contents`, `expectedSha256?` | Atomic guarded write; existing file requires current SHA, missing file forbids expected SHA; result hash and `compileRequested` |
| `asset.read-text`, `asset.write-text` | Same as script read/write | Reviewed shader/UI/JSON/assembly-definition source files through the same hash/path boundary |
| `script.delete` | `path`, `expectedSha256`, `confirmed` | Hash-checked deletion |
| `capture.camera` | Camera GameObject/component `id`, `width?` (64–1920), `height?` (64–1080) | PNG `base64`, mimeType/dimensions; 2 MiB image cap. Restores camera/render targets. Built-in rendering uses Camera.Render; an installed SRP uses a supported StandardRequest (URP base camera). Null graphics device or unsupported requests fail explicitly. |
| `capture.scene` | dimensions | Render last active Scene view camera; requires an open Scene view |
| `batch` | `commands:[{method,params}]` (1–25), `failFast?` (true) | Ordered per-command successes/errors; explicitly nontransactional; no nested batches, jobs or packages |
| `job.start` | `kind:tests`, `mode?` (`EditMode`, `PlayMode`), `testNames?`, `assemblyNames?` | Queued test job ID; result pass/fail/skip/inconclusive counts and up to 50 failure details |
| `job.start` | `kind:build`, `target?`, saved `scenes?`, `development?`, `confirmed` | Queued unique output job; requires installed target module, matching active target and clean loaded scenes; result build summary. Select another target in Unity Build Profiles and wait for compilation first. Windows/macOS use `.exe`/`.app`; Android respects the current APK/AAB setting. |
| `job.status` | Job `id` | Snapshot with state/result/error/cancelSupported. Safe to poll even while BuildPlayer blocks the Editor thread |
| `job.cancel` | Job `id` | Cancels queued jobs; running EditMode tests request Unity cancellation. Builds, PlayMode tests and UPM requests report not_cancellable |
| `package.list` | `includeIndirect?` (true) | Offline UPM listing job, poll `job.status` for package name/version/source/direct |
| `package.add` | Registry `name` optionally `@version`, `confirmed` | Async UPM add job; Git/file URLs refused; bridge cannot replace itself |
| `package.remove` | Registry `name`, `confirmed` | Async UPM removal job; bridge and its dependencies protected |

Editable text extensions are `.cs`, `.shader`, `.compute`, `.hlsl`, `.cginc`, `.uxml`, `.uss`,
`.txt`, `.json`, `.asmdef`. C# edits/imports can reload the domain: wait for compilation and
inspect console before using new types. Generic serialized properties cover installed
camera/physics/audio/UI/Animator components; they do not prove the behavior of an authored game.

Jobs are retained in Editor `SessionState`, bounded to 40. Reloaded test callbacks resume
observation of their accepted run; other unfinished operations become `interrupted` and are
never restarted. Only one bridge test/build can be queued or running at a time; package
changes also wait for it to finish. Registry listings remain separate read operations.
Package state can be reconciled by a fresh offline listing. Unity's synchronous BuildPlayer
API has no supported external cancellation once running; poll its snapshot instead.

The package contains newly authored MIT code. It does not restore `archive/unity`, vend
competitor implementations, run arbitrary C#/shell text, sign into Unity, install Editor
modules, upload/publish a game, or implicitly accept license terms.
