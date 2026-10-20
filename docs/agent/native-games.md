# Native games

External developer reference for compiled games, C++ · raylib and Rust · wgpu: how they build, run
and stay contained. The [architecture](architecture.md) links here from its trust boundaries and
its builds; product behavior is in [Builds and Live](../product/builds-live.md).

## Processes and containment

**Native games.** A C++ game's Mac build runs only through `ProcessSandbox.spawnGame` under the
Seatbelt profile measured on macOS 26 (`gameSandboxProfile`): deny by default, `process-exec` of the
bundle's executable only (no fork; `setsid`/`setpgid` denied by syscall), reads of the system, the
bundle and `state/` (its only writable folder), Metal and audio, no network, and file-read denies on
`OpenGL.framework` and `AppleMetalOpenGLRenderer.bundle`. A run whose host-written Info.plist names
a studio bundle id also reads and writes its own Metal shader cache, `<DARWIN_USER_CACHE_DIR>/<id>`
(host-made, never a link, never another game's; plus `dirhelper` and two metadata reads), so its
pipelines compile warm from the second run. The headless profile (agents, Live's
embedded runs) has no WindowServer; an embedded run adds `IOSurfaceRootUserClient` and a lookup of
its own frames service. The windowed one keeps `com.apple.view-bridge` denied; the port folds repeated stderr lines into one.
`admitMacBundle` ([`native-bundle.ts`](../../src/substrate/native-bundle.ts)) reads the Mach-O
itself: thin arm64, link-time imports only from the system and the store's ANGLE (Metal still maps
OpenGL.framework at run time), one rpath, no Mach-O or hard-linked asset. `assembleRunDir` copies
the pinned ANGLE and each re-checked asset into a per-run `.app` no agent reads, signed ad hoc; the
game speaks on fd 3. Game reports are never host facts: capture digests are recomputed, captures
read only from a real `state/captures`. An overlay `allowWrite` never lifts a base `denyWrite`
(`mergeOverlay`). Frames reach Live through the frames addon
(`dist/resources/native/genex-frames.node`, `process.dlopen` in `native-frames.ts` only): it
checks each message and never maps or reads a pixel. Frames are untrusted pixels the compositor
draws; a fatal code or a slot held 2 s past its send kills the game.
Windows and Linux builds pass `admitCrossOutput`
([`native-cross-admission.ts`](../../src/substrate/native-cross-admission.ts)), which reads their PE
or ELF headers (x64, allow-listed imports plus pinned ANGLE, RUNPATH `$ORIGIN`). Their boxes
([launcher](../windows-sandbox.md#game-launcher), bubblewrap) ship in no build (`no-game-box`).

**Device launches (containment stage 1).** Simulator apps, emulator guests and phones run
agent-written code outside `ProcessSandbox`, so only the person's **On a device** press starts
one: `studio:native.launchDevice`, native-classified, refused in fixtures, with no harness method
(`harness-api.test.ts`). Its handler
([`core/device-launch.ts`](../../src/main/core/device-launch.ts)) installs only what a
Simulator-app or dev-APK export admitted into `layout.phonePackages` from its staging (else
`unsupported`), checked against that SHA-256, as a private copy via `execFile`, and records
`device_launch`.
Sandboxed commands cannot reach the adb port or `~/.android`
([devices](../tool-permissions.md#devices-and-emulators)).

## Builds and the stack seam

**Stacks and the build-lane seam.** A game's stack is `stackOf(shape)` (glossary). Every compiled
build (Live, Mac Play, `native.build`, exports, prepare) goes through `GameBuildLanes`
([`src/main/game-build.ts`](../../src/main/game-build.ts)), the core's `x.gameBuilds` from
`coreGameBuilds`: it dispatches by the stack the files make, not by `studio.json`, and refuses a
stack without a lane `lane-missing`. Raylib's lane is `CppBuilds`; Rust's
is `RustBuilds` ([`src/main/rust-build.ts`](../../src/main/rust-build.ts)) in `layout.rustBuilds`,
denied to prewarm, over the store's Rust toolchain and the payload's genex release and `clippy.toml`
([`core/rust-lane.ts`](../../src/main/core/rust-lane.ts)). It
builds the Mac and the web (packaged by
[`rust-build-web.ts`](../../src/main/rust-build-web.ts) with the app's shell); the phones'
builders and settings ([`rust-build-mobile.ts`](../../src/main/rust-build-mobile.ts)), registered
by `rustTargetBuilders`, build on a Mac (Android also on Linux);
Windows' and Linux's ([`rust-cross-lane.ts`](../../src/main/core/rust-cross-lane.ts)) register once
the Rust recipe pins their cross components, else `target-unbuilt`. Live and judging builds of a desktop
destination link the facade's dev flavour (`studio` feature: the game serves fd 3, contract v2);
an export and every web build never do (`RustFlavour`, `rust-manifest.ts`). Non-export builds and
prewarms optimize dependencies (`RUST_DEV_PROFILE_SETTINGS`). Mac embedded and
headless runs use only lane-admitted bytes (receipt digests); window runs and desktop
exports stay `lane-missing`. Rust creation ([`stack-gate.ts`](../../src/main/core/stack-gate.ts),
the bootstrap's `rustCreation`) is open in development builds and where the Rust lane runs, else
`stack-gated`. Rust games build on their recorded lock while kept (`currentLock(stack, project)`,
its genex release). New games default by
`defaultStackFor` ([`toolchain.ts`](../../src/shared/toolchain.ts)); raylib is never creatable
(`raylib-creation-retired`). A preview lease declares the stacks its harness serves
(`preview.acquire {stacks}`); a lease declaring none is refused a Rust game. A Rust run is refused
`rust-parts-missing` unless every `RUST_PARTS` module exports `SERVES_RUST`; the person may
**Re-take** kept ones (`studio:seed.retake`; `seedNightRefusal`, `kept-pre-rust`;
[harness runtime](../harness-runtime.md)). After staging, the lane's import step
(`importStagedAssets` in [`rust-assets.ts`](../../src/main/rust-assets.ts), jobs in
`layout.assetJobs`) plans every staged `assets/**` file for the destination and runs each
importable one as its own sandboxed job, at most `IMPORT_JOBS_MAX` (4) at once. The outputs
replace their sources in the stage and never in the game folder: an OBJ, STL or PLY becomes a GLB,
a Draco, meshopt or quantized GLB is written back plain, every GLB has its identical vertices welded
and its duplicate or unreferenced accessors and materials dropped
([`weld.ts`](../../src/substrate/asset-import/weld.ts); joints, weights and morph deltas are part of
a vertex), a normal-mapped primitive without `TANGENT` gets MikkTSpace tangents, a mirrored UV
seam's vertices split ([`tangents.ts`](../../src/substrate/asset-import/tangents.ts)), every
triangle list is put in vertex cache and fetch order before its meshlets and LODs
([`reorder.ts`](../../src/substrate/asset-import/reorder.ts)), and a Basis KTX2 gets its
per-family files. The receipt carries each written GLB's counts
and bytes (`sizes`, [`inspect.ts`](../../src/substrate/asset-import/inspect.ts)).
A PNG or JPEG whose usage resolved (a `[[texture]]` row or a model's material slot; never its name)
is encoded once to UASTC and gets the same per-family KTX2 beside it, the image kept as the fallback
([`texture-encode.ts`](../../src/substrate/asset-import/texture-encode.ts)); a non-square or
non-power-of-two one is first resampled into its square power-of-two class, and the row's
`texture` records the class (issue `resampled`).
A GLB's embedded PNG and JPEG images get the same encode as the last pass of its step: each once per
usage its material slots give it, written beside the GLB as `<model>.t<image>[.<usage>].<family>.ktx2`
and named in its `asset.extras.genex_textures`
([`glb-textures.ts`](../../src/substrate/asset-import/glb-textures.ts)); the embedded image stays as
the fallback, and an image it cannot encode keeps loading from the GLB.
Every glTF first passes the Khronos validator ([`validate.ts`](../../src/substrate/asset-import/validate.ts),
before any decoder): an error refuses it `validation-failed`, severity decided by issue code. The
validator reads only an image's header, so the gate also decodes each embedded PNG
([`png-check.ts`](../../src/substrate/asset-import/png-check.ts)); one the runtime could not decode
is an `IMAGE_DATA_INVALID` warning on its image, and the model still imports.
An Opus, AAC or M4A file becomes mono or stereo Ogg Vorbis at 48 kHz through the pinned host tool
`genex-audio-ogg` ([`audio-ogg.ts`](../../src/substrate/asset-import/audio-ogg.ts)): its container is
checked first (`malformed`), and a platform without the tool's pin refuses it `converter-missing`.
A refused file leaves the build, and so does an output whose name another staged file holds
(`name-taken`). The receipt's `assets` lists each file's action and refusal. A game with nothing
to import starts no sandbox. Each file is looked up first in the content-addressed import cache
([`asset-cache.ts`](../../src/main/asset-cache.ts), `layout.assetCache`, `cachedImporter`; host-owned,
every sandboxed process is denied writing it by `studioBaseDenyWrites`), and a
delivery into a Rust game imports its files into that cache at once, keyed for this host's desktop
build (`warmImports` in [`core/assets.ts`](../../src/main/core/assets.ts)), so that build runs no job
for them. `assets.inventory` gives each `assets/` file's `import`: `pending` until its version is
imported (a read starts it), `ready` with validator `issues`, or `refused` with its `refusal`.
A written GLB's `issues` also hold the validation report's codes
([`report.ts`](../../src/substrate/asset-import/report.ts)): an untextured base colour outside
real albedo, part metal, an IOR outside 1.0-3.0, triangles over the class budget. A rigged GLB's
`import.character` lists clip names, lengths and motion, joints, humanoid coverage and skinned
levels ([`character-facts.ts`](../../src/substrate/asset-import/character-facts.ts), the alias
table `tests/fixtures/humanoid-aliases.json`); the host checks both in the receipt. `writeOutput` then packages the stage per destination
(`packageAssets` in [`rust-package-assets.ts`](../../src/main/rust-package-assets.ts),
`DESTINATION_PACKAGES`): family files only for the families the destination picks (desktops BC,
iOS ASTC, Android ASTC and ETC2, the web all three), never RGBA8; a phone drops a source image its
families cover and family mips above `PHONE_MAX_TEXTURE_PX`. It writes
`assets/genex-asset-index.json` (ids from a trusted `genex-assets.lock`, files and bytes per
family, `deps`, `boot`), and the receipt's `package` gives the bytes. Streaming reads only the
index ([`stream-facts.ts`](../../src/substrate/asset-import/stream-facts.ts)): a GLB's `mesh`
lists its levels coarse first with their byte ranges, the head and vertex ranges every level
needs, and its UV texel density; a KTX2 file's `levels` run smallest first with their ranges.
`genex.toml`'s `[[asset_group]]` rows become the index's `groups`, and a member of any group is not
`boot`. A game file at that name is
refused `reserved-asset-name`. Every lane output passes `admitRustOutput` before
`out/`, exports carry `rust-notices.ts` notices, phone exports
([`mobile-export-deps.ts`](../../src/main/core/mobile-export-deps.ts)) are signed by `mobile-sign.ts`, and a compiled-stack session builds with its lock's tools, never writing the store. The template is checked by
`rust-template.test.ts`; the vendored set by `rust-vendor.ts`, cargo-deny and cargo-vet
(`.github/workflows/rust-toolchain.yml`); person-approved crates join a per-profile overlay
([crate requests](../tool-permissions.md#crate-requests)). `tests/fixtures/stack-split-sites.json`
classifies the `isCompiledStack` sites.

**C++ games.** `CppBuilds` (`src/main/cpp-build.ts`) uses the store lock and `recipe.json`:
CMake/Ninja under `ProcessSandbox`, raylib prebuilds, native clang or emcc behind a `-B` Python.
`ToolchainService.install` prepares all host-supported destinations, preserving game selections.
Missing Apple tools block only Mac; adding the SDK requires
preparation without redownloads.
Mac denies `setsid`/`setpgid`, but Ninja’s `posix_spawn` groups can escape reaping and change cached
output. Launch/export recheck bytes in private staging; immutable build containment remains needed.
Windows/Linux use Zig; `admitCrossOutput` records refusal `DestinationCheck`s.
`native.build` reports host-read imports, including refusals. Cross parity checks admission only.
Desktop exports stage privately at the current lock; certificate signing uses its own sandbox and Java proxy.
Mac Play, agent runs and embedding use `NativeRuns`: prepare, `spawnGame`, nonce `ready`,
`NativeGamePort`. Stop requests quit, then TERM/KILL; boot sweeps orphans; app death kills registered
groups. A v2 game that misses a step or capture deadline, or goes silent owing one, is killed
`gpu-hang`; one that restores a lost GPU device gets a new Live ring generation. Captures carry
provenance (seq, digest, camera, run, build, the `render` settings the game answered with and the
capture's `outputSize`; null where the path did not know them), saved as `<label>.provenance.json`; builder captures add `c<N>_<camera>.manifest.json` (run, worker, commit, build); a failed one `c<N>.refused.json`; links refused (`confinedCaptureDir`). Sessions clone Emscripten caches under `<scratch>/cpp-sessions/<game>/`.

**Toolchain store.** Each compiled stack keeps its own current lock in one store
(`LOCK_FILE_OF_STACK`). Locks made current are recorded (`lock-records/`), so a game keeps
its lock after an update; Prune and the Rust build-folder sweep keep
every referenced lock ([`retention.ts`](../../src/substrate/toolchain-store/retention.ts)). Archives install
through a host-level verified download cache (`download-cache.ts`, in every profile's base
`denyWrite`); installs, prewarm and builds stay per profile. A developer profile may seed its prewarm
from the normal profile's manifest-checked, relocatable outputs (`prewarm-seed.ts`), never the reverse.
A live developer profile seeds its Rust stack from the dev store, digest-checked (`rust-seed.ts`).
