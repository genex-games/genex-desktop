# Release readiness

This page records acceptance boundaries, not assignments or a running task journal.
Issues and PRs own current work/status. Update a boundary in place when direct evidence closes
it; link the resulting PR/CI artifact instead of appending another checkpoint here.
The original remaining-work plan and acceptance reports are recoverable from Git history.

## Boundaries requiring direct acceptance

| Boundary | Required proof |
| --- | --- |
| Public plugin distribution | Approved public catalog/artifact destination, source/license review, anonymous discover → install → execute → update with retained settings; see [marketplace release](STUDIO-MARKETPLACE-RELEASE.md) |
| Native Claude/Codex context | Authenticated session-specific measurements, supported context policy, resume/model switch, and separately bounded compaction acceptance; see [connections and context](connections-and-context.md) |
| Fresh Bonsai setup | New UI download/install, cancellation/resume, and first response; existing-runtime inference does not prove fresh installation; see [local models](local-models.md) |
| Fresh-user account/MCP lifecycle | Explicit disconnect/restart/reconnect, denied credential access, connector setup/revocation, and accurate skill scope |
| Asset and first-playable behavior | Retained optimized variants selected through actual manifest data, bounded model-led asset adherence, first-playable timing and incremental preview; fixture coverage does not establish model outcomes |
| Hosted publishing | Attribute cold owner-page startup delays, distinguish uploaded bytes from an initialized playable page, and verify one draft/update without duplicate transactions |
| Combined release | Integration regression plus applicable package/resource checks after release changes settle; component CI totals do not establish full-app readiness |

These are retained unclosed acceptance boundaries from the previous plan, not failures
reproduced by the developer-workflow cleanup. Verify current issue/PR evidence before taking
one on or claiming it is still open. Passing a narrower check does not close a wider boundary.

## Distribution and open source

Status: **Open** needs an owner decision or work not started, **Partial** has work in the tree
but no acceptance, **Done** is in place.

| Boundary | Status | Current state and what closes it |
| --- | --- | --- |
| License | Done | Root [MIT license](../LICENSE), copyright `genex.games`; owner confirmed historical contributor rights. Package and RPM metadata use MIT; third-party terms remain separate |
| Contributor terms | Open | DCO or CLA, described in [CONTRIBUTING](../CONTRIBUTING.md#contributor-terms); depends on the license decision |
| Third-party sources | Partial | [Notices](../THIRD-PARTY-NOTICES.md) cover copied sources (Exo, orbkit, shadcn/ui), packages without license files and three.js's vendored libraries; the build stops on a gap. Beautiful UI and transitions.dev material was removed or rewritten. Genex UI adaptations use MIT with separate trademark rights. The unlicensed third-party editor reference is excluded from `dev` but still on `main`, in tag `v0.1.0-rc.1` and in history; vendored hosted guide terms and historical publication review remain open |
| Provider terms | Open | Claude runs only on a subscription login through Claude Code. Needs Anthropic's confirmation for a distributed app, or an API-key mode as the default for distributed builds. The Claude Agent SDK in the package is proprietary |
| Repository history | Open | Internal evidence and personal paths in history; publish with full or fresh history. No credentials were found |
| Platforms | Partial | macOS arm64 supported; Intel untested. Linux x64 deb, rpm and zip are built and booted in CI on Ubuntu 22.04, but window controls and a secret store without a keyring are open. Ubuntu 24.04's user-namespace restriction: the deb installs an AppArmor profile for the app (`build/linux/postinst`) and the rpm Genex's (`linux-apparmor.ts`); startup shows the setup screen when the sandbox cannot start a process (`isolation-blocked`, with the command for the zip) or the restriction leaves bubblewrap no capabilities (`userns-restricted`: Set up installs the profile and relaunches); zip copies, stopped sooner by Chromium's sandbox, need their `README-LINUX.txt` command first. CI (`linux-userns.yml`) that boots the deb and a portable copy under the restriction and checks that an unprofiled zip copy fails awaits its first run, so the rpm scriptlets and the installed-deb smoke are unproven, and no 24.04 machine has tried it (the polkit prompt, the relaunch); 24.10 and later are unverified, and where `bwrap-userns-restrict` is loaded (listed for 25.10) bubblewrap may still fail. Accepted by the owner for now (2026-10-01): with the profile loaded, programs Genex runs, including sandboxed agent commands, and anything run as Genex's binary (RunAsNode is on) may create capability-bearing user namespaces, as on distributions without the restriction and as Ubuntu's own VS Code profile allows; the portable profile names a folder its owner can write to (Set up refuses one others can). Windows x64 is being ported: CI makes an unsigned per-user Squirrel installer (`Genex-Setup.exe`) and the setup screen installs the sandbox (one UAC prompt); the sandbox wiring and a clean-machine install are open. The Genex plugin payload leaves out Sentry's bundler plugins so every file stays under 260 characters in an install under a 20-character user name (`plugin-payload-paths.test.ts`) |
| C++ games for Windows and Linux | Partial | On a Mac, product and agent exports build declared destinations with pinned Zig 0.16, admit PE/ELF outputs and stage Windows zip/Linux tar.gz archives with licences and secret checks. Windows executables are stripped and reproducible across two full builds; PDB reproducibility is unmeasured (no PDB emitted). ANGLE ships for both. The Linux sysroot archive is deterministic and pinned, but its URL is null: fresh installs show Linux unavailable until the owner publishes it as a release asset. Cross parity records admission and leaves gameplay unmeasured on this Mac. Linux smoke checks exported packages under Xvfb/SwiftShader on Ubuntu 24.04 and AlmaLinux 8; Windows WARP is billed, label/dispatch only. Certificate signing needs the person and an absolute `GENEX_EXPORT_JSIGN` launcher, runs in its own sandbox with a Java proxy, and has no sheet; real jsign/certificate signing remains unverified. Windows-host builds and actual Windows/Linux host play remain refused pending acceptance of the AppContainer/bubblewrap game boxes, GPU and Wayland |
| Rust games for iPhone and Android | Partial | A Rust game's phone exports run in development builds: on a Mac the Rust lane builds the device and (on a lane of its own) the Simulator triple, Android on a Mac or the Linux Studio with the person's pinned NDK (r30; r27 only stands in for the real tests), and the export packages a Simulator app (ad hoc) or development APK (Studio's per-profile debug key) for the person or the agent, and an IPA (Apple Development or Distribution identity, Xcode 26) or Play bundle (release keystore) for the person alone, each tool in its own sandbox. `mobile-export-real` builds and packages both on a Mac; `bundletool validate`, `zipalign -P 16` and the 16 KB page check run in `rust-mobile.yml`'s Linux emulator job, whose smoke waits for the shell's first presented frame and captures the screen only while the game's own window has focus (system dialogs are closed first). No agent installs or launches one; the person's **On a device** press installs the Simulator app or development APK the export admitted. Open in the runtime: Android's soft keyboard delivers key-by-key typing only (NativeActivity has no `InputConnection` bridge, so composed, autocorrected and swipe text is lost) and an audio-focus loss while playing goes unheard (both need a Java helper class in the APK); Android joystick axes are not read; `rust-mobile.yml`'s iOS job packages the spike's pond, not the core's export. Open, each needing the owner: the iOS Simulator job's dispatch; the iPhone row (p95 frame interval ≤ 33.3 ms on the reference scene, resume ≤ 1 s, no leak over 30 suspend cycles, rotation, device loss, audio interruptions, soft keyboard) and a signed distribution IPA; Android real-device rows on mid-range Adreno and Mali at 4 KB and 16 KB pages (sustained 30 fps at thermal steady state), or a recorded `deferred`; an App Store build needs an `actool` asset catalog and a 1024 px icon. Until a device row passes, phone exports say "Untested on real devices" (`RUST_GPU_QUALIFICATION`). The APK uses NativeActivity, so no GameActivity AAR ships and no notice is owed for one; its manifest handles every configuration change in place, theme overlays (`assetsPaths`) included, because winit 0.30 ignores onDestroy and the activity cannot survive a relaunch |
| Package contents | Partial | Packaging drops other platforms' node-pty and sandbox-runtime helpers and the Genex CLI's app-level dependency tree (`scripts/package-prune.cjs`), and refuses a symlinked `node_modules`. The packaged smoke checks both, the fuses and C++ games' contents (template, recipe, headless raylib platform byte for byte, frames addon, no toolchain program, no ANGLE outside its pinned folder); it passed 42/42 on an unsigned darwin-arm64 package with fuses applied, all three ANGLE builds included. Every build bundles the pinned ANGLE for macOS, Windows and Linux; package and release builds fail closed unless the three builds of the `angle.yml` run named in `native/angle/bundle-lock.json` are present and match (CI fetches them with `node scripts/bundle-angle.mjs --fetch`, `actions: read`), and the smoke checks all three (`--verify`). GitHub deletes that run's artifacts on the lock's `expires` date (2027-01-12): re-pin from a newer run before then. Needs the same pass on CI's Linux package and a signed build |
| Signed and notarized builds | Partial | Wired: `osxSign` (hardened runtime, `allow-jit` only, no library-validation exemption) and notarytool with an App Store Connect API key when the release secrets exist; fuses; `release.yml` verifies codesign, spctl and the staple. The Developer ID Application certificate exists (an Individual account, so Gatekeeper shows the developer's personal name). Waiting for: the `.p12` with its password, the API key (`.p8`, key id, issuer id), and the `release` environment secrets. The bundle id is `games.genex.desktop` (the app is Genex); changing it after release resets macOS permissions. Windows is built and tested every release but left out of the draft until it is signed: SignPath (the OSS Foundation program) signs it with the `release-signing` policy once its production certificate is in the organization; until then a Package dispatch with `test_sign` proves the wiring with the test certificate ([release operations](release-operations.md)). Closed by a signed tag build that installs from the draft release on a clean Mac and a clean Windows machine. Games exported as Mac apps are signed ad hoc; their Developer ID signing and notarization (`GENEX_EXPORT_SIGN_IDENTITY_OK=1`, a person only) are owner-run and unaccepted, as is opening an export on a second Mac |
| Update channel | Partial | `update-electron-app` (update.electronjs.org, GitHub Releases) is on (`AUTO_UPDATE_ENABLED`) for packaged macOS and Windows builds from the public launch: the service reads only public repositories, skips drafts and pre-releases, and needs signed builds; copies built earlier (every `-rc`) never check. A download shows **Relaunch to update** in the sidebar (asking before it ends an active run); draft upload refuses a release missing the feed's assets for the platforms it distributes (the macOS zip always; RELEASES, the full nupkg and the installer once Windows ships). Linux builds ask GitHub's latest published release every six hours and offer **Download Genex X** (the release page); Settings → About and the app menu check on demand. Closes with an update from one signed release to the next ([release operations](release-operations.md#automatic-updates)) |
| Diagnostics | Partial | In code: a rotating, redacted `<userData>/logs/studio.log` (5 × 5 MB, mode 0600), local-only crash dumps in `<userData>/Crashpad` (no upload), Settings → Harness → Copy diagnostics, an error screen with Reload and Copy error, a crashed renderer reloaded at most twice a minute, and a bounded quit. Bug reports point at the log. Needs acceptance in a fixture UI run and a packaged build |
| CI gating | Partial | Every PR runs Linux static checks, baseline contracts, affected L1 tests and, when a change reaches it, the harness gate (`verify:harness`). macOS fast/package/Windows/terminal workflows retain main-target and dispatch gates; rigs require `full-tests` (a nightly rig is billed macOS time, an owner decision; a schedule must live on `main` and check out `dev`). The added behavior gate needs Linux CI acceptance and branch protection. Release validates source/version before signing, requires full regression plus terminal/gallery checks, and refuses draft distribution without macOS signing (Windows ships only once signed); exact candidate CI, environment reviewers and branch protection remain required |
| Telemetry disclosure | Done | Studio sends no analytics or crash reports. Share build metrics (Settings → Privacy) is an off-by-default opt-in that sends anonymous build rows described in [PRIVACY](../PRIVACY.md); the app never asks for it, and a server 410 pauses it. The Genex CLI's crash reporting is off unless `GENEX_TELEMETRY` is set, where the asset adapter runs it and where the Genex plugin starts it as an MCP server (`genexTelemetryEnv`); Claude Code and Codex follow their vendors' settings (README) |

## Execution constraints

- Preserve normal profiles, game originals, edited harnesses and existing generated assets.
- Account-connected checks require their explicit opt-in under [verification](agent/verification.md).
  A context read does not authorize a compaction, paid generation or new-build run.
- Use an identified owned profile and check for active user work before restart or UI testing.
- Public hosting, repository visibility, source publication and release promotion require
  their own authorized scope. Curated catalog preparation alone is not publication.
- Keep unresolved checks visible in the relevant PR. Put raw identities/logs locally or in
  selected CI artifacts, following [PR guidance](../AGENTS.md#documentation-and-prs).

## Product decisions retained

The catalog is curated. Keep the public index, immutable plugin artifacts and private app
source separate. Local developer installation remains available; plugins handle their own
service accounts. Broad self-service publishing, billing, ratings, search services, publisher
dashboards, silent updates and wider sandboxing are separate product work.

## Hardening gates

Use Node 24 (`.nvmrc`) and the lockfile. `npm ci` runs `runtime:check`, which validates the actual
pinned Electron independently of external coding installations; no coding CLI is required for npm installation. Binary presence does not prove authentication.
The shared `scripts/electron-runtime.mjs` resolves Electron for developer/test launchers.
`genex.test.ts` invokes the real pinned CLI against a fixture API, covering shared admission and server credit refusal without a Studio allowance,
lost-create recovery, repeated retrieval, credential isolation and account/character approval races.
`genex-delivery.test.ts` covers unsafe destinations. Export checks cover explicit roots, nested
private files, symlinks and module dependency closure. These fixtures spend no live credits.

Live acceptance additionally requires account-holder sign-in/terms, a current affordable quote,
one in-app coding-agent asset request, visible or audible integration, restart/retrieval without
regeneration, independent export and packaged reuse. A downloaded file alone does not pass this
gate. Record total ambiguous as well as accepted paid submissions against the authorized test cap.
The current task allows 100 credits total; that number is not a product default.

Plain-Node rigs must inject fixture providers even when recreating StudioCore to test restart.
Close rigs after each scenario and close the fixture server if initialization fails. A test that
asserts events are absent from Studio must read that specific thread, not listAllEvents. Preserve
routing/termination assertions and diagnose broad-suite failures separately from isolated passes.

Sandbox preparation regressions inject transient lookup failures, inaccessible binaries and
Stop during preparation. The real sandbox suite retains read/write/network denial assertions.
A missing health verdict includes the director tool trace, so failed integration cannot be
misdiagnosed from the final pass list alone.
