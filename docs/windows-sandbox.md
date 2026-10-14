# Windows sandbox

How Genex contains processes on Windows. The macOS and Linux model, and everything the platforms
share, is in [architecture](agent/architecture.md#processes-and-trust-boundaries).

[`src/substrate/windows-sandbox.ts`](../src/substrate/windows-sandbox.ts)
drives sandbox-runtime's srt-win backend (vendored `srt-win.exe` from `app.asar.unpacked`):
commands run as the local `srt-sandbox` user under Git Bash (no Git for Windows opens the setup
screen on `git-missing`). What differs from macOS:

- Grants are NTFS ACL entries set at `initialize()` for the whole process. One
  `WindowsSandboxSession` holds the union of every `ProcessSandbox`'s roots. A folder opened later,
  or a disposed member's folders, queue one `reset()` + `initialize()` that runs once no command
  holds the session; the last member out releases everything. A per-run grant outside the
  session's roots is refused (`not-granted`); network changes stay live (`updateConfig`).
- The sandbox user reads nothing in the profile unless granted, so each folder between
  `USERPROFILE` and a root gets `(RA)` (read attributes, no listing) after every apply, since
  srt-win's deny stamps replace the entry. The entry is set on that folder alone
  ([`windows-folder-ace.ts`](../src/substrate/windows-folder-ace.ts): `SetFileSecurityW` from one
  Windows PowerShell run per batch); `icacls`, the fallback where PowerShell is locked down,
  rewrites everything under the folder as well. Each Genex records its folders in
  `%LOCALAPPDATA%\genex-sandbox-grants\<pid>.json` and revokes only those no other running Genex
  records.
- Neither `spawn()`'s environment nor stdin reaches the child: each run's variables
  (`windowsRunEnv`) go to an env file in scratch and its stdin to a file, each deleted by the
  command as it reads it. The host sends nothing down the stdin pipe the command swaps away. The harness hears the host over a loopback inbox
  ([`src/substrate/harness-inbox.ts`](../src/substrate/harness-inbox.ts)) whose first line must
  be the one-time `HARNESS_INBOX_TOKEN`; it answers on stdout.
- Deny paths are session-wide (a per-command deny binds every command anyway); a path denied both
  ways is sent as a read deny only. A missing deny path in the profile outside every grant is
  dropped, since srt-win would create a placeholder; off the profile it is kept. srt-win's
  `argv_too_long`, `srt_win_timeout` and exit 16 `mapped_drive_cwd` become `SandboxLaunchError`
  codes.
- `killChild` kills the srt-win broker, whose job ends the tree; `HarnessHost.stop()` sends
  `shutdown` and kills only after the grace.

## Game launcher

A C++ · raylib game never runs under srt-win: `ProcessSandbox.spawnGame` starts it through
`genex-game-launcher.exe` ([`native/genex-game-launcher`](../native/genex-game-launcher/README.md),
planned by [`windows-game-launch.ts`](../src/substrate/windows-game-launch.ts)). The launcher puts
the game in a per-run AppContainer with no capabilities (no network), grants it the run's
`bundle\` (read and execute) and `state\` (read and write) and nothing else, holds it in a
kill-on-close Job Object with the memory cap, and relays the protocol between its own fd 3 and
the run's pipe `\\.\pipe\genex-game-<run id>` (`GENEX_STUDIO_PIPE`). The host checks the run
folder by realpath and claims it once (`launch.claim`). Stop closes fd 3, then ends the launcher;
no process group is signalled. Neither Windows nor Linux has a headless build, so an agent's run is
refused (`no-headless-build`) and judged on the web build.

No build ships the launcher yet (it needs Genex's Windows signing), so Play answers
`no-game-box` with `launcher-missing`.

A Rust · wgpu game's Windows build is cross-built on a Mac
([`rust-build-windows.ts`](../src/main/rust-build-windows.ts): `x86_64-pc-windows-gnullvm` with
llvm-mingw, a static C runtime, one `game.exe`); its builder registers only once the Rust recipe
pins the cross components, and until then the build is refused `target-unbuilt`. It draws through D3D12 alone with FXC
(`d3dcompiler_47.dll`) chosen explicitly, and its PE policy refuses desktop OpenGL, a DXC compiler
or a shipped runtime DLL. wgpu loads `d3dcompiler_47.dll`, `d3d12.dll` and `dxgi.dll` by bare
name, and none is a KnownDLL, so Windows' default search order looks in the executable's folder
before System32: a Rust run bundle or export must never put a DLL beside `game.exe`. No Windows
host runs one: it would start through the same launcher, whose shipping is a separate decision.
Its export (a zip with the exe alone signed, only with the person's own certificate, labelled
untested on real GPUs) is refused `lane-missing` until the export run routes a Rust game to it.

## Denied reads

`ProcessSandbox`'s base deny list (`baseDenyRead` in `spawn.ts`) is macOS and Linux's. Windows has its own list
(`windowsDenyRead`): `.ssh`, `.aws`, `.azure`, `.kube`, `.docker`, `.config\gh`,
`.git-credentials`, `_netrc`, the `%APPDATA%`/`%LOCALAPPDATA%` credential and DPAPI stores, GitHub
CLI and gcloud, and the Chrome, Edge, Brave, Firefox and Opera profiles.

## Residual risks

srt-win is alpha. Every srt host on the machine shares the
`srt-sandbox` SID and so each other's grants and denies; revoking an `(RA)` grant also removes
one another host made there (fail closed). DNS still resolves; the proxy token is on the
runner's command line. A folder opened while the harness runs is writable only after it next
stops. srt-win's own entries are inheritable, so each apply and reset re-propagates them through
everything under the folder they are on, holding each folder open meanwhile; its deny stamp on a
denied path's parent covers the whole profile for `.ssh` or `.docker`. Every sandboxed process can read a run's env file until the command deletes it, and PATH
folders under the profile whole. A broker outlives an Electron crash.

## CI and curated suite

`windows.yml` and `terminal.yml`. Every PR runs `check.yml`'s Linux `gate` (architecture,
typecheck, lint, test style). For a platform-sensitive branch, dispatch one (`gh workflow run
package.yml --ref <branch> -f only=win32`). `rig.yml` runs the rig group on PRs labelled
`full-tests` and on demand. Label a PR `full-tests` when it touches core, harness or engine code.

`windows.yml` (`windows-latest`) runs `npm ci`, `typecheck`, `lint`, the one-time sandbox setup
(`scripts/ci-windows-sandbox.mjs`: the vendored srt-win's `srt-sandbox` user and WFP filters;
runner only, it exports `GENEX_WINDOWS_SANDBOX=ready`) and `npm run test:windows -- --suite-only`
(the curated `tests/windows-suite.json`). Its sandbox files are `windows-sandbox.test.ts` (grant
session, env file and launch through fakes; runs everywhere) and `sandbox-windows.test.ts` (the
real srt-win's hostile-input tables; skipped unless `GENEX_WINDOWS_SANDBOX=ready`). A dispatch
with `backlog` also runs the rest of the fast group as an informational pass that never fails;
the job summary and `windows-tests` artifact list failing files and tests and clean files not yet
in the suite. Test files run side by side, so one file's sandbox re-propagates srt-win's entries
through the folders the others keep in `%TEMP%`: tests remove theirs with `removeTree`
(`tests/helpers/tmp.ts`), and a test of session logic hands `ProcessSandbox` a
`WindowsSandboxSession` over fake ancestor grants.
A dispatch with `files` runs only those files after the sandbox setup
(`gh workflow run windows.yml --ref <branch> -f files="tests/a.test.ts"`). `.gitattributes` keeps every checkout LF.

The Rust WARP row is separate and billed (`gh workflow run windows.yml --ref <branch> -f
rust_warp=true`, or the `windows-smoke` label on a PR into `main`): `rust-warp-build` cross-builds
the gnullvm pond and a decoy `dxcompiler.dll` on Linux, and `rust-warp` runs it on `windows-2025`
under D3D12 WARP with the decoy first on PATH. The adapter must be WebGPU-compliant and FXC, never
the decoy, must compile the shaders. Until a real GPU runs a Windows row, every Rust Windows
export stays labelled untested.
