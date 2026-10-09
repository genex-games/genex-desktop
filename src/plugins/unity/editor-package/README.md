# Genex Unity Editor bridge

Install this local UPM package explicitly through the Genex Unity plugin, or add its
folder as a local package in Unity Package Manager. Unity 6 compiles the Editor-only
assembly and publishes authenticated loopback discovery under `Library/Genex`.
The package has no runtime assembly and is excluded from player builds.

See [PROTOCOL.md](PROTOCOL.md) for methods, security boundaries and cancellation limits.
Do not commit `Library/Genex/bridge.json`, copy its token, or expose its listener through a
proxy. Keep existing projects and manually edited scenes; replacement/closing refuses
unsaved scenes. Files modified by script tools use optimistic SHA-256 concurrency.

For package tests, include `com.genex.unity-bridge` in the project's `testables` manifest
array and run the `Genex.Unity.Editor.Tests` EditMode assembly in Unity Test Runner.

Camera capture supports built-in rendering and installed SRPs that accept Unity's standard
render request. URP requires a base camera. Unsupported requests or a session without graphics
fail explicitly. Builds require saved scenes and the selected active target; switch platforms
in Unity Build Profiles and wait for compilation before building.

Compiling this package against Editor assemblies proves API compatibility only. Transport
fixtures and desktop UI tests use synthetic replies. Native scene edits, Undo, script reload,
EditMode/PlayMode callbacks, rendered captures and successful player outputs must be verified
in a licensed Unity Editor before claiming runtime acceptance.
