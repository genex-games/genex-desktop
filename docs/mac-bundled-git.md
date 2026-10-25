# Bundled git on macOS

Genex runs git itself (the harness workspace at start, snapshots and undo, chat and asset
checkpoints, Loop worktrees, Remix) and its agents run `git` in the sandbox. On a Mac without
Apple's Command Line Tools, `/usr/bin/git` is only a stand-in that asks to install them, so every
macOS release carries its own git, the counterpart of Windows'
[bundled Git](windows-sandbox.md#bundled-git).

## Which git runs

At start (`StudioCore.init`, and before a data-folder move repairs build copies),
`ensureMacGit` ([`src/substrate/git-policy.ts`](../src/substrate/git-policy.ts)) asks
whether the PATH's git runs (`hostGitRuns`: not the stand-in, or the stand-in with a developer
folder holding git). Only where it does not does `<resources>/git/bin` go first on the app's own
PATH. A Mac with the tools, or with its own git (Homebrew) first, keeps it. The toolchain PATH the
agents, plugins and the terminal get ([`src/substrate/toolchain.ts`](../src/substrate/toolchain.ts))
takes the login shell's first; when that one's git is the stand-in, the app's own git folder goes
first there too. The sandbox already lets agents read and run the app's resources. Remix comes back
on such a Mac without a change of its own: `hostGitRuns` now finds a git that runs.

## The build

[`scripts/vendor-git-for-mac.ts`](../scripts/vendor-git-for-mac.ts) compiles git's source tarball
from kernel.org, pinned by version and SHA-256, during a macOS release build (`build.mjs
--release`, or `GENEX_VENDOR_GIT=1`), into `dist/resources/git`. Git publishes no macOS binary, and
the others are bound to their install folder (Homebrew) or not ours to ship (Xcode), so source is
the reproducible choice. The build runs with Apple's PATH alone and `NO_HOMEBREW`, for the build's
processor and macOS 12, with `RUNTIME_PREFIX` so git finds its helpers beside itself; the programs
load only system libraries (libz, libiconv, libcurl). It needs Xcode's compiler, which the macOS
runners have; the tarball and the build are cached under `node_modules/.cache/genex/git-macos`.

Only git, the HTTPS remote helper, the shell-script commands with what they source, and `git init`'s
two template files ship (`MAC_GIT_FILES`), about 8 MB. The dashed names `make install` links (`git-upload-pack` and others, without which a local clone runs `/usr/bin`'s stand-in) ship as `/bin/sh` wrappers, since a development build refuses links in its resources. The build refuses a release
whose install lacks a listed path, and a program built for another processor. The resources are
asar-unpacked, so the packager signs and notarizes the git with the app. Git's licenses and a
`SOURCE.txt` naming the tarball and the build's settings ship beside it
([notices](../THIRD-PARTY-NOTICES.md#bundled-git-macos)).

To move to a newer git, change the pin, check the list against what `make install` writes, then run
the Mac package job. `DEVELOPER_DIR=/nonexistent` makes this Mac's stand-in fail as on a Mac without
the tools, for a test or a `studio:dev` launch.

Not covered: Publish also needs `git lfs`, which this git does not carry.
