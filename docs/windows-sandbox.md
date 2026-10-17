# Windows sandbox

How Genex contains processes on Windows. The macOS and Linux model, and everything the platforms
share, is in [architecture](agent/architecture.md#processes-and-trust-boundaries).

[`src/substrate/windows-sandbox.ts`](../src/substrate/windows-sandbox.ts)
drives sandbox-runtime's srt-win backend (vendored `srt-win.exe` from `app.asar.unpacked`):
commands run as the local `srt-sandbox` user under Git Bash. The packaged app brings its own Git
for Windows as `resources\git` and prefers it to an installed one (`findGitBash`); a development
build uses the installed Git. The host runs git itself too, so the core settles which Git before
anything else at startup (`ensureHostGit`, which puts its `cmd` folder first on PATH); with none,
the setup screen opens on `git-missing`. What differs from macOS:

- Grants are NTFS ACL entries set at `initialize()` for the whole process. One
  `WindowsSandboxSession` holds the union of every `ProcessSandbox`'s roots. A folder opened later,
  or a disposed member's folders, queue one `reset()` + `initialize()` that runs once no command
  holds the session; the last member out releases everything. A per-run grant outside the
  session's roots is refused (`not-granted`); network changes stay live (`updateConfig`).
  `initialize()` is tried up to three times only when srt-win's egress check (`wfp`) times out; a
  timed-out ACL step fails at once, since a retry would repeat its walk under the denied path's parent.
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

## Bundled Git

[`scripts/vendor-git-for-windows.ts`](../scripts/vendor-git-for-windows.ts) downloads the portable
edition pinned by version and SHA-256 during a Windows release build (`build.mjs --release`, or
`GENEX_VENDOR_GIT=1`), unpacks it with 7-Zip and leaves out what Genex never reaches: the
documentation, gitk and git gui with Tcl/Tk, Vim (a git command that wants an editor fails at once
instead of waiting) and Git Credential Manager (host git runs without the system config and never
prompts; sandboxed commands have the credential helper off). Forge copies it beside the archive
([`scripts/package-git.cjs`](../scripts/package-git.cjs)). It sits in the install folder, which
the session already grants for reading, so it needs no grant of its own. The Squirrel install check
runs its Git Bash and `cmd\git.exe` with no other Git on PATH. To move to a newer Git, change the
pin; the build refuses a release that lacks a path the trim list names, so the list is reviewed.
The terminal panel still opens an installed Git Bash, else PowerShell.

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
