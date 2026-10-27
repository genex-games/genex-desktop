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
the pinned ANGLE and each re-checked asset into a per-run `.app` no agent reads, signed ad hoc; a
window run's Info.plist, like a Mac export's, declares the game category and Game Mode support
(`gameModeEntries`: `LSApplicationCategoryType`, `LSSupportsGameMode`, `GCSupportsGameMode`), a
background run's none. The game speaks on fd 3. Game reports are never host facts: capture digests are recomputed, captures
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
([`core/rust-lane.ts`](../../src/main/core/rust-lane.ts)). Each source folder of a game (the
game folder, every worker worktree, Play-latest, playtest and integration copy) has its own build
folder, `<game>-<sha12(real source)>/<target>-<lock12>`, and they share the compiled engine
([`rust-build-cache.ts`](../../src/main/rust-build-cache.ts), receipt `cache`): where the lane's
root clones copy-on-write ([`clone-tree.ts`](../../src/substrate/clone-tree.ts): `cp -c` on
APFS, since Node's `COPYFILE_FICLONE` copies there; reflinks on btrfs and XFS) a new folder's
target is cloned from the most recently admitted idle copy of the same game, destination and lock
whose clone succeeds (`copy`; a target holding a link, as cargo's dSYM link after a Mac export, is
passed over), else the store's prewarm (`prewarm`), else empty (`cold`), and copies build in
parallel; the donor's next build waits for the clone. The admitted executable in `<bin>.out` is a
clone of cargo's too (`TreeCloner.cloneFile`: Node's `COPYFILE_FICLONE` copies every byte on APFS). Where it cannot (Windows, NTFS, ext4, HFS+) the game's
copies build one at a time in one target, `shared/<game>-targets/<target>-<lock12>`. Turns go by
`BuildPriority` (`game-build.ts`; default from the purpose): the person's builds (Live, Play, Native,
exports) take a free slot of `rustBuildsMax(cores)`, else one of their own past it, and the shared
target next; agents' (judging) take slots in the order asked; background prebuilds only a slot nobody
else waits for, under `nice -n 10`. A person joining a waiting build raises it. A clean checkout's
Live or judging build is also keyed by content ([`rust-build-content.ts`](../../src/main/rust-build-content.ts):
the commit's tree, lock, destination, profile, flavour, trust, eject, grant, SDK, the host's own
code and web shell), recorded as
`<bin>.content` only when its stage is that tree file for file; any copy of the same content is
served that admitted output (or waits for its build under way) instead of building. The person's
Live builds skip clippy (judges keep it; a judge never reuses an unlinted build). Clippy denies
every warning but its style and complexity groups and `approx_constant`; the store `clippy.toml`'s
determinism bans stay errors (`CLIPPY_LINT_LEVELS`). A failed step's lines are its first error as
rustc renders it, empty gutter lines dropped, then how many more errors named a place; the note the
console and the agents read (`buildFailureNote`) names the exit, never the command and its
environment, which the stage's Details keep. The computer's `check` (`PreviewService.checkBuild`)
asks the lane for a check (`GameBuildOptions.check`): identity, lock and clippy on the stage in the
build's sandbox, whatever the purpose, then nothing is imported, built, admitted or announced; a
build of the folder never shares a check, and waits for it. Play plays one
copy per commit (`show/<game>-<commit12>`, `PreviewService.playCopy`), and a healthy integrated Rust
build is prebuilt there in the background, web and this host's desktop
([`play-prebuilds.ts`](../../src/main/core/play-prebuilds.ts)). Every command
starts with `RUSTC_BOOTSTRAP` set empty as the prewarm's `rustEnv` does, or proc-macro2's build
script reruns and every derive-using unit with it. The sweep (`gameBuilds.sweep()`: at start, after
a worktree goes and after freeing a game's space; the lane's own before it makes a new build
folder, so a copy removed without a worktree hook goes before the next one costs disk) removes a build folder whose source is gone, an
unstamped one after `UNSTAMPED_GRACE_MS`, one of a lock that is neither current nor a game's recorded
lock the store still holds (`installedRustLock`), and a shared target no copy builds in, never one building,
lending or served by a preview, nor anything through a link; one it cannot remove is skipped.
Composer Stop cancels only the chat's own game's builds (`gameBuilds.cancelGame`: its folder's and
every copy's) and agent runs; another game's go on. It builds the Mac and the web (packaged by
[`rust-build-web.ts`](../../src/main/rust-build-web.ts) with the app's shell; Live opens a
`game.mouseLook` game's page at `index.html?mouseLook`, and the shell then takes the pointer lock
on a click, as Native does); the phones'
builders and settings ([`rust-build-mobile.ts`](../../src/main/rust-build-mobile.ts)), registered
by `rustTargetBuilders`, build on a Mac (Android also on Linux);
Windows' and Linux's ([`rust-cross-lane.ts`](../../src/main/core/rust-cross-lane.ts)) register once
the Rust recipe pins their cross components, else `target-unbuilt`. Live and judging builds of a desktop
destination link the facade's dev flavour (`studio` feature: the game serves fd 3, contract v2);
an export and every web build never do (`RustFlavour`, `rust-manifest.ts`). A `[net] enabled = true`
game (G6 MP-5b) links the facade's `net-loopback` (the in-process room) in Live, judging and the
Simulator build a device launch installs, and `net` (the relay) in every other export
(`rustNetFeatureOf`, `RustNetFeature` in [`rust-manifest.ts`](../../src/main/rust-manifest.ts)); a
game without networking gets the same manifest as before. Only a networked export bakes in
`GENEX_GAME_SLUG`: the slug of the game's Genex draft (`genexDraftSlug` in
[`core/genex-publish.ts`](../../src/main/core/genex-publish.ts), the plugin's publish workspace),
and only when it is one plain segment (`bakeableGameSlug`); its web export also serves the store's
`genex-mp-bridge` (MP-5a), refused `mp-bridge-refused` when the component is not installed.
Publishing (MP-5c): `assertPublishable` admits a Rust game by its web build and refuses
`no-web-export` when Browser is not a destination or genex.toml declares native features;
`publicCopyFiles` is the lane's web export; `readGenexGameManifest` carries `[net.matchmaking]` as
`genex.matchmaking`; `plugins.preflightMultiplayer` answers `RustNoWeb`, then the account and the
draft route (`RustReady`), never Genex's npm packages. Non-export builds and
prewarms share one profile (`RUST_DEV_PROFILE_SETTINGS`: dependencies at opt-level 3 without debug assertions or overflow checks, the game at 1 with both). Mac embedded and
headless runs use only lane-admitted bytes (receipt digests); window runs and desktop
exports stay `lane-missing`. Rust creation ([`stack-gate.ts`](../../src/main/core/stack-gate.ts),
the bootstrap's `rustCreation`) is open in development builds and where the Rust lane runs, else
`stack-gated`. Rust games build on their recorded lock while kept and installed, else on the current lock,
which their next own-folder build records (`currentLock(stack, project)`, its genex release). New games default by
`defaultStackFor` ([`toolchain.ts`](../../src/shared/toolchain.ts)); raylib is never creatable
(`raylib-creation-retired`). A preview lease declares the stacks its harness serves
(`preview.acquire {stacks}`); a lease declaring none is refused a Rust game. A Rust run is refused
`rust-parts-missing` unless every `RUST_PARTS` module exports `SERVES_RUST`; the person may
**Re-take** kept ones (`studio:seed.retake`; `seedNightRefusal`, `kept-pre-rust`;
[harness runtime](../harness-runtime.md)). After staging, the lane's import step
(`importStagedAssets` in [`rust-assets.ts`](../../src/main/rust-assets.ts), jobs in
`layout.assetJobs`) plans every staged `assets/**` file for the destination and runs each
importable one as its own sandboxed job, at most `IMPORT_JOBS_MAX` (4) at once. A built app runs
the importer the build bundled into `resources/asset-import/worker.mjs` (`importerWorker`); only a
process running from `src/` starts `worker.ts` itself. A job whose
importer was killed by a signal runs once more (the importer is a pure function of its job), and a
refused file's row names why in `detail`: the importer's own line, its exit or timeout with the end
of its stderr, or the sandbox's error. The outputs
replace their sources in the stage and never in the game folder: an OBJ, STL or PLY becomes a GLB,
a Draco, meshopt or quantized GLB is written back plain, every GLB has its identical vertices welded
and its duplicate or unreferenced accessors and materials dropped
([`weld.ts`](../../src/substrate/asset-import/weld.ts); joints, weights and morph deltas are part of
a vertex), a normal-mapped primitive without `TANGENT` gets MikkTSpace tangents, a mirrored UV
seam's vertices split ([`tangents.ts`](../../src/substrate/asset-import/tangents.ts)), every
triangle list is put in vertex cache and fetch order before its meshlets and LODs
([`reorder.ts`](../../src/substrate/asset-import/reorder.ts)), a GLB whose nodes carry `MSFT_lod` gets
the authored levels as `genex_lods` instead of simplified ones, each level's screen coverage
converted to the error the runtime switches at ([`lod-authored.ts`](../../src/substrate/asset-import/lod-authored.ts)),
and a Basis KTX2 gets its
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
family, `deps`, `boot`), and the receipt's `package` gives the bytes. On the web, `webAssetMap` ([`rust-build-web.ts`](../../src/main/rust-build-web.ts)) writes `assets.json` v2: each family file carries its `family` and the texture it is `of`, so the module plans only the family the shell's adapter samples (`studio_assets_plan(map, {features, mobile})`); the image is tagged `source`, and left out, only when the runtime never falls back to it (every shipped family, none RGBA8, each at least 512 px). Map v2 also puts each file in its fetch group (STR-14b): a cell pack's `world.json` and terrain index in `sim`, its cells and terrain tiles in `stream`, each `[[asset_group]]`'s files in `named` with the group's name, and a streamed KTX2's head and levels as smallest-first `ranges`. The shell preloads only the boot and sim groups and fetches the rest while playing by `Range` once the module wants them (each frame genex-platform-web's `web_stream` wants the named groups the game requires and the cell bodies and terrain tiles around its anchors, and hands what arrived to the sim's reads at the next frame boundary; `state().volatile.webStream` reports it), at most six at once (`WEB_STREAM_LIMITS`: 64 MiB before the first frame, 64 MiB per streamed fetch); a redirect off the page's origin or out of `assets/` is refused. A `[net]` game's web build (MP-5a) also serves the pinned `@genex-ai/multiplayer` bridge (`MULTIPLAYER_BRIDGE_PIN`, store component `genex-mp-bridge`) and its ESM shim (`MP_BRIDGE_SHIM`) under `mp/`; only that page carries the import map and script tag, and the receipt records `mpBridgeBytes` and `mpBridgeGzip`. Streaming reads only the
index ([`stream-facts.ts`](../../src/substrate/asset-import/stream-facts.ts)): a GLB's `mesh`
lists its levels coarse first with their byte ranges, the head and vertex ranges every level
needs, and its UV texel density; a KTX2 file's `levels` run smallest first with their ranges.
`genex.toml`'s `[[asset_group]]` rows become the index's `groups`, and a member of any group is not
`boot`. The receipt's `package.budget` measures the package against its destination's budget
(`assetBudgetOf` in [`genex-toml.ts`](../../src/substrate/genex-toml.ts), `ASSET_BUDGETS`: web 64 MB,
iOS and Android 200 MB, desktop 2 GB unless `[assets]` names another): past it an export warns
`assets-over-budget`, and past a hard cap (the web shell's 512 MB, a phone's 4096 MB)
`packageCeilingRefusal` refuses the build `assets-over-ceiling`. `[assets] phone_max_texture_px`
replaces the phone mip cap. A game file at that name is
refused `reserved-asset-name`. Every lane output passes `admitRustOutput` before
`out/`. The bake step (NAV-14b, [`rust-bake.ts`](../../src/main/rust-bake.ts), `RustBuildsOptions.bakes`)
keys a game's bakes by `bakeInputDigest` (the staged sources and assets before the import step, less
the host-written manifest and lock, plus the toolchain lock): every build places the profile cache's
entry for that input into `out/assets/baked/<kind>/<name>` before the web map and the admission,
and a dev Mac build that misses it asks a headless run of its admitted `out/` for each bake its
receipt's `bakes` advertises (`bakeAssets`, never an agent). That run goes through the native run
registry under the game profile (`nativeBakeSessions`); its `prebuilt` start skips the lane, whose
build is waiting on it. Other destinations take the cache only. The cache is
`<asset-cache>/bakes/<project digest>/<input>/` (`bakeCacheFolder`). The step reads each output from the
run's `state/bakes/` without following a link, checks its size and FNV-1a 64, writes it into the
cache and `out/` (admitted again) and records lock `derived` rows; an unchanged rebuild spawns
nothing, a game whose `src/` names neither `nav_bake` nor `impostor_bake` is never started to ask, and a hostile name or a
linked folder refuses that bake with nothing written. Outputs never reach the game folder, and a
failed bake never fails the build (`NavMesh::from_bytes_for` bakes at reset). An export keeps line tables outside it ([`rust-debug-files.ts`](../../src/substrate/rust-debug-files.ts)):
a dSYM (Apple, debug map stripped), the unstripped executable (ELF/PE, shipped through
`llvm-objcopy --strip-debug`) or the web `wasm-opt --symbolmap` map, in `<bin>.debug/<digest>/` by
the shipped file's SHA-256, four builds kept. Exports carry `rust-notices.ts` notices, phone exports
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
groups. Every 5 s the registry samples a run's memory (a Mac's `phys_footprint`, GPU memory
included; a Linux box's process tree) and keeps the peak on its status (`memory`). Past the 4 GiB
budget (`NATIVE_GAME_MEMORY_BUDGET_BYTES`) the run keeps going, marked `overBudget`; past the host's
cap, `nativeGameMemoryCapBytes(os.totalmem())` (`max(8 GiB, RAM / 4)`, at most `RAM / 2`; the
Windows Job Object's limit too), it is killed `memory-cap`. A v2 game that misses a step or capture
deadline, or goes silent owing one, is killed `gpu-hang`; one that restores a lost GPU device gets a new Live ring generation. A run that ends
crashed names its record in its status (`crash`): the game's own last `crash` record (a forged host
kind or writer is `reply-invalid`), else a host-made `hang` (killed `unresponsive` or `gpu-hang`) or
`process-exit`. [`game-crashes.ts`](../../src/main/core/game-crashes.ts) keeps it in the game's
`.studio/crashes/` by the host's own name (one file per signature, with `repeat`; at most 32),
announces `game_crashed` once and answers `game.crashes` and `studio:game.crashes`. Before it is kept,
[`crash-symbolicate.ts`](../../src/main/core/crash-symbolicate.ts) names its frames (`symbols`) with the
store's `genex-symbolicate` (built at the Mac prewarm beside `genex-naga-check`) under the sandbox, 20 s,
reading only host-chosen files: the export's `<bin>.debug/<digest>/`, or a Live build's executable while it
has the run's digest, its Mach-O debug map followed into `<bin>/target`. The slide comes from
`genex_crash::frames::anchor`; a frame outside the image is `foreign`; a failure keeps it unsymbolicated.
Profiles ([`native-profile.ts`](../../src/substrate/native-profile.ts)): `preview.profile` on a native
lease samples the run's own ops (frame time from `timing`'s frame counter over a host-timed window,
draws and triangles from `state().__render`, CPU/GPU percentiles and hitches from the `profile`
summary when served) as a schema-1 `native` sample; `preview.frameProfile` (a lease, native or Rust
web page) and Live's `studio:native.profile` (the shown run, else Live's page of that game) hand on
the `profile` verb's answer only through `parseProfileAnswer`, `unknown-op`/`unavailable` as
`unavailable`. Captures carry
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

## Profiles and crash records

A Rust game's `profile` verb answers
`studio:native.profile` (Live's profile strip, polled only while open) and `preview.frameProfile`,
checked by [`native-profile.ts`](../../src/substrate/native-profile.ts).
[`game-crashes.ts`](../../src/main/core/game-crashes.ts) keeps a run's last `crash` record (or a
host-made `hang` or `process-exit`) in the game's `.studio/crashes/` (at most 32, one per
signature), appends `game_crashed` once, serves `game.crashes` and Live's crash card;
`crash-symbolicate.ts` names frames with the sandboxed `genex-symbolicate`; nothing uploads.
