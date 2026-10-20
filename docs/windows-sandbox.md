# Windows sandbox

How Genex contains processes on Windows. The macOS and Linux model, and everything the platforms
share, is in [architecture](agent/architecture.md#processes-and-trust-boundaries).

[`src/substrate/windows-sandbox.ts`](../src/substrate/windows-sandbox.ts)
drives sandbox-runtime's srt-win backend (vendored `srt-win.exe` from `app.asar.unpacked`):
commands run as the local `srt-sandbox` user under Git Bash. The packaged app brings its own Git
for Windows as `resources\git` and uses it only when the PC has no Git of its own (`findGitBash`);
a development build uses the installed Git. The host runs git itself too, so the core settles which Git before
anything else at startup (`ensureHostGit`, which puts its `cmd` folder first on PATH); with none,
the setup screen opens on `git-missing`. What differs from macOS:

- Grants are NTFS ACL entries for the whole process, Genex's own (below) set before srt-win's
  `initialize()`. One `WindowsSandboxSession` holds the union of every `ProcessSandbox`'s roots. A folder opened later,
  or a disposed member's folders, queue one `reset()` + `initialize()` that runs once no command
  holds the session; the last member out releases everything. A per-run grant outside the
  session's roots is refused (`not-granted`); network changes stay live (`updateConfig`).
  `initialize()` is tried a second time only when srt-win's egress check (`wfp`) times out; a
  timed-out ACL step fails at once, since a retry would repeat its walk under each folder srt-win
  grants and each denied path's parent.
- The version-guarded [SRT patch](../scripts/patch-sandbox-runtime.mjs) runs initialization,
  failed-initialization rollback, launcher rollback and session reset ACL commands asynchronously.
  Revoke and restore each keep their holder PID, SID and best-effort outcomes; a slow cleanup must
  not hold Electron's main thread. Every srt-win ACL call (grant, stamp, revoke and restore, sync
  and async) and the egress check wait two minutes instead of SRT's 60 and 30 seconds
  (`SRT_WIN_TIMEOUT_MS`), so a slow disk, an antivirus scan or a cold first start as the sandbox
  user does not fail a start; srt-win's setup, status and `trust-ca` calls keep SRT's. The actual
  process `exit` event retains synchronous cleanup, since promises cannot finish there. Partial
  grants remain eligible for that exit cleanup while initialization or its rollback is pending.
- srt-win starts every command as `srt-sandbox` through CreateProcessWithLogonW, which the
  Secondary Logon service (`seclogon`) carries out; where hardening disabled it, Windows refuses
  every start ("Access is denied"). The setup check (`windowsSetupGaps`) reads its start type with
  `sc qc seclogon`, which needs no administrator (the number decides; the word after it is
  localized), beside srt-win's two status probes, and a disabled service is a setup gap
  (`WindowsSetupNeed.LogonService`) the setup card names in one line. Set up sets it to Manual
  (`sc config seclogon start= demand`, [`windows-logon-service.ts`](../src/substrate/windows-logon-service.ts))
  through Windows PowerShell's `Start-Process -Verb RunAs` before srt-win's install. srt-win
  elevates itself, so a PC that needs both sees two approval prompts. A service Set up could not
  turn on (a policy keeps it off) leaves the card saying how to do it in Services.
- That egress check starts srt-win as the sandbox user before any grant, and Windows opens its
  program and working folder as that user. A per-user install lives in the profile, so the session
  grants the install folder (and srt-win's, when apart) for reading first, among Genex's own grants
  or, where Genex cannot set them, with srt-win's (`grantLauncherFolders`), and a packaged app
  works from its install folder (`installedWorkingDir`).
  It asks srt-win for the user's SID up to three times; without that grant the check fails with
  "CreateProcessWithLogonW(srt-sandbox): Access is denied", so the log says why one was not made.
  The same refusal comes from a disabled Secondary Logon service (`seclogon`).
- The sandbox user reads nothing in the profile unless granted, so each folder between
  `USERPROFILE` and a root gets `(S,RA)` (read attributes and synchronize, no listing) after every
  apply, since srt-win's deny stamps replace the entry. Synchronize matters before Windows 11
  24H2: Node's stat opens each folder there, and every synchronous open asks for it. The entry names the `sandbox-runtime-users` group
  (`srtAncestorGrantee`; the user itself outside it): every srt host, Claude Code's own shell
  sandbox among them, stamps and cleans up the user's entries, and its cleanup took Genex's on
  `AppData`. The entry is set on that folder alone
  ([`windows-folder-ace.ts`](../src/substrate/windows-folder-ace.ts): `SetFileSecurityW` from one
  Windows PowerShell run per batch); `icacls`, the fallback where PowerShell is locked down,
  rewrites everything under the folder as well. Each Genex records its folders in
  `%LOCALAPPDATA%\genex-sandbox-grants\<pid>.json` and revokes only those no other running Genex
  records. The SID is asked of srt-win up to three times; without it the apply fails. The harness gets the entries set again just before it starts, and one that exits during
  boot logs `icacls` for each folder from the profile down to its files.
- The toolchain's PATH folders under the profile (npm's global prefix, pnpm's home, nvm, Scoop) are
  granted for reading (`grantableToolDirs`), and a grant passes its entry down through every file
  under each one. pnpm's home holds its package store (`store\v3`, `store\v10`), a file
  for every package the person's projects ever installed, which made a pnpm user's first start
  grow with their history; no sandboxed command reads it (a sandboxed pnpm keeps its own store, and
  global packages' files are hardlinks that share their security descriptor). So that home is
  granted entry by entry without its store, and with no link among the entries, since srt-win
  grants a link's target. npm's global prefix is granted whole: its `node_modules` are the global
  CLIs that run in the sandbox, OpenCode among them.
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
- Genex sets every grant and every deny on a path that exists itself (`routeWindowsGrants`,
  `routeWindowsDenies`, `ownAclEntries`), before srt-win starts, and keeps them between launches.
  srt-win's grant passed its entry down through everything under each folder at every start (a
  toolchain, a games folder full of `node_modules`), and took it back at every exit; its stamp
  puts an inheritable FILE_DELETE_CHILD deny on each denied path's parent, which Windows passes
  down through everything under it, once per path: for `.ssh` or `.claude` the whole profile, for
  a game's `.claude` the whole game. Either ran past srt-win's deadline (SRT's 60 seconds; two
  minutes now, above) on a large profile ([sandbox-runtime#457](https://github.com/anthropic-experimental/sandbox-runtime/issues/457)),
  in the background start behind the open window. Genex grants a folder to the sandbox users'
  group, passed down through what is under it (read and run, or with write and delete, without
  FILE_DELETE_CHILD, as srt-win's grants), and marks its write grants safe for Git, as srt-win
  does. It denies a path, where it really is, to the sandbox
  users' group, passed down through what is under the path alone, and FILE_DELETE_CHILD on its
  parent folder alone (the shape
  [sandbox-runtime#523](https://github.com/anthropic-experimental/sandbox-runtime/pull/523) proposes), with
  [`windows-folder-ace.ts`](../src/substrate/windows-folder-ace.ts): `SetNamedSecurityInfoW` on
  the path, `SetFileSecurityW` on the parent. A write deny there also refuses FILE_DELETE_CHILD.
  Applying or removing a deny preserves whether the path's DACL is protected from inheritance;
  protected paths use `PROTECTED_DACL_SECURITY_INFORMATION` together with the DACL mask.
  The entries name the group because srt-win's recompose of a path drops every explicit entry for
  the user's SID. Each Genex records its entries in `%LOCALAPPDATA%\genex-sandbox-denies\<pid>.json`;
  every edit makes a path what all running holders need. The group's passed-down allows are Genex's
  only on a folder it grants or granted: on a path it only denies or guards, an allow someone else
  gave the group stays. An edit that finds a path as it should be
  writes nothing, so passing entries down a folder happens once: a Genex that quits keeps its
  record, and the next sync of any Genex keeps what a running one needs and takes back the rest. A
  first walk of a large folder can take minutes (10 at most per batch; the log names each edit
  over 2 s); one that runs out of time keeps what it set, and the next try goes on. A per-command
  deny Genex already sets is not sent again. Without the group, where PowerShell cannot run the
  batch or the running user holds the SID, srt-win sets every grant and deny as before, and the
  log says so (`own entries off`). srt-win keeps a missing deny path (it makes its placeholder), a
  drive root and a share.
- `killChild` kills the srt-win broker, whose job ends the tree; `HarnessHost.stop()` sends
  `shutdown` and kills only after the grace.

## Bundled Git

[`scripts/vendor-git-for-windows.ts`](../scripts/vendor-git-for-windows.ts) downloads the portable
edition pinned by version and SHA-256 during a Windows release build (`build.mjs --release`, or
`GENEX_VENDOR_GIT=1`), unpacks it with 7-Zip and leaves out what Genex never reaches: the
documentation, gitk and git gui with Tcl/Tk, Vim (a git command that wants an editor fails at once
instead of waiting) and Git Credential Manager, with the `[credential]` section of `etc\gitconfig`
that names it (host git never prompts; sandboxed commands have the credential helper off). Forge
copies it beside the archive
([`scripts/package-git.cjs`](../scripts/package-git.cjs)). It sits in the install folder, which
the session already grants for reading, so it needs no grant of its own. The Squirrel install check
runs its Git Bash and `cmd\git.exe` with no other Git on PATH, and the package job's chat turn
sets `STUDIO_WINDOWS_BUNDLED_GIT_ONLY=1`, so the sandbox user runs this Git Bash. To move to a newer Git, change the
pin; the build refuses a release that lacks a path the trim list names, so the list is reviewed.
The terminal panel still opens an installed Git Bash, else PowerShell.

## Visual C++ runtime

`srt-win.exe` imports `vcruntime140.dll`, which Windows does not include: without it the broker
exits 0xC0000135 (`srt-win user status exited 3221225781` in the log) and the sandbox never starts.
A hosted runner hides this, since its Visual Studio installed the DLL in System32. Packaging copies
each Visual C++ runtime DLL a bundled executable imports beside it, for its architecture, from the
build machine's Visual Studio (`VCToolsRedistDir`, else vswhere), and refuses to package without
one ([`scripts/package-vc-runtime.cjs`](../scripts/package-vc-runtime.cjs)). The packaged smoke
reads every executable and DLL in the package and fails on a runtime import with no copy beside it.

## Denied reads

`ProcessSandbox`'s base deny list (`baseDenyRead` in `spawn.ts`) is macOS and Linux's. Windows has its own list
(`windowsDenyRead`): `.ssh`, `.aws`, `.azure`, `.kube`, `.docker`, `.config\gh`,
`.git-credentials`, `_netrc`, the `%APPDATA%`/`%LOCALAPPDATA%` credential and DPAPI stores, GitHub
CLI and gcloud, and the Chrome, Edge, Brave, Firefox and Opera profiles. Genex sets those that
exist itself; a missing one outside every grant is not sent.

## Residual risks

srt-win is alpha. Every srt host on the machine shares the
`srt-sandbox` SID and so each other's grants and denies. Claude Code's tool-less sessions (usage,
model list, judge) run without its own sandbox on Windows (`toollessSandbox`); a worker's session
needs it, and where the CLI cannot run it the worker is refused rather than run unboxed
([harness runtime](harness-runtime.md#a-workers-engine-that-cannot-run-its-sandbox)). DNS still resolves; the proxy token is on the
runner's command line. A folder opened while the harness runs is writable only after it next
stops. srt-win's stamp of a missing deny path (or a per-command one) re-propagates permissions
under that path's parent, holding each folder open meanwhile. Genex's own entries stay between
launches (the owner's choice, for start times): while Genex is closed, only processes running as
the sandbox user (any srt sandbox on the PC, Claude Code's shell sandbox among them) keep reading
the granted toolchains and writing Genex's game folders and linked projects, and they stay denied
the secrets; the real user's own access never changes. The next Genex start takes back what it no
longer needs, and uninstalling Genex takes back every recorded entry no running Genex needs, in
one Windows PowerShell batch that runs on after Squirrel's uninstall launch exits
(`takeBackSandboxEntries`). Genex has no switch that turns the sandbox off; one added must take
them back the same way. A folder moved into
a granted one from elsewhere on the same drive keeps what it inherited there, so the sandbox
cannot open it until its entries are passed down again (the grant changing, or a reinstall).
Two Genex editing one folder's entries at the same moment can lose one edit until the next sync,
and srt-win's own cleanup never sees Genex's entries. Every sandboxed process can read a run's env
file until the command deletes it, and PATH folders under the profile whole (pnpm's home without
its store). A broker outlives an Electron crash.

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
real srt-win's hostile-input tables; skipped unless `GENEX_WINDOWS_SANDBOX=ready`).
`windows-logon-service.test.ts` reads the runner's real Secondary Logon service and runs Set up's
elevated step there (Actions only: it changes a service). A dispatch
with `backlog` also runs the rest of the fast group as an informational pass that never fails;
the job summary and `windows-tests` artifact list failing files and tests and clean files not yet
in the suite. Test files run side by side, so one file's sandbox re-propagates srt-win's entries
through the folders the others keep in `%TEMP%`: tests remove theirs with `removeTree`
(`tests/helpers/tmp.ts`), and a test of session logic hands `ProcessSandbox` a
`WindowsSandboxSession` over fake ancestor grants.
A dispatch with `files` runs only those files after the sandbox setup
(`gh workflow run windows.yml --ref <branch> -f files="tests/a.test.ts"`). `.gitattributes` keeps every checkout LF.
