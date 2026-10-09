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
- Before runtime initialization, the sandbox user receives read/execute access to the exact
  `srt-win.exe` file, through srt-win's PID-refcounted journal. Its WFP verification launches that
  file as the sandbox user before granting application roots; a per-user install otherwise fails
  with access denied. Reset and failed initialization release this bootstrap grant; the helper's
  containing directory is never granted for this preflight.
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
  command as it reads it. The harness hears the host over a loopback inbox
  ([`src/substrate/harness-inbox.ts`](../src/substrate/harness-inbox.ts)) whose first line must
  be the one-time `HARNESS_INBOX_TOKEN`; it answers on stdout.
  Git ignores system and global configuration, as host Git does; repository settings and
  `.gitattributes` still apply. Ambient `core.autocrlf` cannot rewrite the integrated game's bytes.
  Host and sandbox Git enable `core.longpaths` for files beyond Windows MAX_PATH. Git for Windows
  separately limits a worktree directory's absolute `/.git` path: unsupported directory lengths
  are refused with `WindowsWorktreePathError` before changing Git or scratch. The data folder
  must keep a worktree's absolute path within 215 UTF-8 bytes; long files inside it are supported.
- Deny paths are session-wide (a per-command deny binds every command anyway); a path denied both
  ways is sent as a read deny only. A missing deny path in the profile outside every grant is
  dropped, since srt-win would create a placeholder; off the profile it is kept. srt-win's
  `argv_too_long`, `srt_win_timeout` and exit 16 `mapped_drive_cwd` become `SandboxLaunchError`
  codes.
- `killChild` kills the srt-win broker, whose job ends the tree; `HarnessHost.stop()` sends
  `shutdown` and kills only after the grace.
- Asset checkpoints compare canonical registered Git worktrees, using NUL-delimited porcelain
  records. Git's forward slashes and Unicode display quoting cannot reject the game's own
  integration workspace; foreign and unregistered worktrees remain refused.
- Local AI sessions discover a linked worktree's Git metadata with native Git on Windows,
  ignoring ambient Git routing. Only the workspace and its Git metadata receive write grants;
  the repository's other working copy remains outside the grant.

## Denied reads

`ProcessSandbox`'s base deny list (`baseDenyRead` in `spawn.ts`) is macOS and Linux's. Windows has its own list
(`windowsDenyRead`): `.ssh`, `.aws`, `.azure`, `.kube`, `.docker`, `.config\gh`,
`.git-credentials`, `_netrc`, the `%APPDATA%`/`%LOCALAPPDATA%` credential and DPAPI stores, GitHub
CLI and gcloud, and the Chrome, Edge, Brave, Firefox and Opera profiles.

## First-run setup

Windows x64 users install Genex and open it; no Node, npm, Rust or terminal command is required.
Before SDK initialization, structured sandbox-user and WFP status route missing provisioning to
the setup screen instead of the SDK's generic dependency error. A normal launch starts setup
once, keeping the Electron window responsive. Windows asks for administrator approval for the
shipped broker to provision its account and network filters. Cancellation keeps Set up available;
there is no unprotected fallback. Fixture, smoke and developer launches never auto-provision.

Existing Git Bash is reused. If missing, Genex downloads the official PortableGit 2.56.0(2) x64
distribution, with pinned size and SHA-256, to a generated staging folder. The upstream
self-extractor runs its post-install step; a Git/Bash probe must pass before atomic publication
under the app's `runtime/git` folder. Links, tampered bytes and incomplete installs are refused.
Only Genex's process PATH changes. The portable distribution and all its licenses remain intact.
Internet is required only when Git needs downloading. Sandbox installation uses the packaged
`srt-win.exe` in `app.asar.unpacked`, never an npm package installed by the user.

A ready Sandbox is not reinstalled: the SDK otherwise rotates its shared account's password.
Setup verifies account, credentials and actual non-elevated egress containment before reusing
or accepting an installation. Unreadable BFE status alone cannot declare success; inactive
filters trigger repair, and temporary helper grants are released even when verification fails.
The boot gate publishes Ready before creating the replacement renderer, preventing a second
automatic install. Automatic private Git installation is currently x64-only.

Build locally with Node 24, Rust and MSVC build tools: `npm ci`, then `npm run make`.
The Squirrel installer is under `out/make/squirrel.windows/x64`.

## Residual risks

Native asset jobs also accept noncanonical Windows DACLs, which .NET's rule editor refuses.
The fallback journals temporary protection and integrity labels, pins paths without delete
sharing, skips descendant links, and edits only each job's SID. Existing descendants are
protected before parent edits; cleanup restores their original flags, ACE order and labels,
including after broker death. Jobs sharing an exact grant root queue through named mutexes
for their lifetime; independent roots can run together. Waiting remains cancellable and uses
the job's existing deadline. Large noncanonical runtime trees require a walk; canonical paths
retain the ordinary ACL writer.

srt-win is alpha. Every srt host on the machine shares the
`srt-sandbox` SID and so each other's grants and denies; revoking an `(RA)` grant also removes
one another host made there (fail closed). DNS still resolves; the proxy token is on the
runner's command line. A folder opened while the harness runs is writable only after it next
stops. Full grants and denies are inheritable and can take time to propagate through large trees.
The parent deletion guard is object-only: denying `.ssh` or `.docker` no longer propagates that
guard through unrelated profile folders. Removing legacy inheritable entries still propagates
once. Every sandboxed process can read a run's env file until the command deletes it, and PATH
folders under the profile whole. A broker outlives an Electron crash.

The bundled Genex CLI needs a private writable run folder while the shared-account harness is
active. Its Windows calls therefore use `ProcessSandbox.runNative`: an offline AppContainer
with a distinct SID, scoped file grants and the same 90-second command deadline. The harness
cannot read or modify that folder, and the CLI cannot read the harness's files. Node preload
imports use file URLs, including drive letters and spaces.

The trusted host relays the CLI's `fetch` calls over inherited anonymous stdin/stdout pipes.
It checks the pinned API origin before each request and redirect; no AppContainer network
capability is enabled. Credentials travel only in those pipes, never the command line,
environment or broker specification. Individual request cancellation and Stop abort pending
host requests; sandbox disposal stops native jobs. Requests are limited to 1 MiB, responses to
8 MiB and captured command output to 64 KiB. `genex-cli-windows.test.ts` proves private-file
boundaries, origin and redirect refusals, cancellation and output limits on real Windows jobs;
`genex-cli-tool.test.ts` also runs the bundled, pinned CLI against a fixture API.

## Broker build

Windows builds require Rust and MSVC build tools for the pinned native dependency. The application
remains Electron / React / TypeScript. `scripts/patch-sandbox-runtime.mjs` builds the attributed
v0.0.73 broker sources in `native/srt-win` with the locked Cargo dependency graph and a static CRT;
compiler output stays in `.studio-dev/native`. The SDK's paths and CLI protocol stay unchanged.
The package carries the broker's provenance, Apache-2.0 license and dependency license files.

The parent-only correction backports upstream PR #523. A Windows profile held without delete
sharing also needs a narrow, no-follow security handle and object-only `SetFileSecurityW` write.
This fallback preserves ownership, protected DACLs and other principals' entries, but Windows
normalizes the AUTO_INHERITED bookkeeping marker. Native fixture tests permit only that marker
change and verify existing/future siblings, denied descendants and cleanup. See
[`PROVENANCE.md`](../native/srt-win/PROVENANCE.md) for exact revisions and changes.

Run `cargo test --release --locked --manifest-path native/srt-win/Cargo.toml` for the native ACL
regressions. Real application acceptance must also boot against an ordinary Windows profile;
a disposable home alone cannot reproduce the locked-profile startup failure.

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

`npm run build && npm run test:windows-ui` exercises the production shortcut hook and sandbox
setup component in an offscreen Electron window with a disposable profile and synthetic callbacks.
It checks Ctrl shortcuts across keyboard layouts, AltGr, repeated keys, modal ownership, setup
states and overflow at 100%, 125% and 200% zoom. It does not prove complete application startup or
live provider, installer or Unity behavior. Evidence stays in `.studio-dev/evidence/windows-ui/`.
