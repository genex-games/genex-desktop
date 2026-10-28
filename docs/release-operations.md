# Release operations

The desktop is a prerelease. A workflow definition or local smoke pass is not acceptance of a
signed release. [Release readiness](release-readiness.md) records the outstanding gates.

## Prepare a candidate

Integrate through `dev`; the owner promotes `dev` to `main`. Keep the lockfile, Node 24,
Electron and native terminal ABI aligned. Apply compatible dependency fixes as a reviewed
change; major toolchain upgrades get their own acceptance. Assess advisory leaf packages and
their shipped/build exposure, rather than treating each transitive parent as a distinct CVE.

Run `npm run verify`, the changed UI review and `npm run test:terminal` after native runtime
changes. Run platform checks on every advertised OS. For a source setup check, use an owned
fixture profile and a disposable install; do not touch normal profiles or provider credentials.

Record a candidate's source SHA, lockfile digest, version, platform/architecture, signing
identity, checks and limitations. Generate a lockfile dependency inventory with
`npm sbom --sbom-format cyclonedx --package-lock-only`; it includes build dependencies and is
not an assertion that every listed package ships. Inspect generated and manually maintained
notices in `dist/resources/third-party/` and the packaged resources, including the root MIT
license. Keep provenance for copied sources and runtime downloads.

## Package and authorize

`npm run package` creates a local app; `npm run make` creates installers: dmg and zip on macOS;
deb, rpm and zip on Linux, which needs `rpm` installed; a Squirrel `Setup.exe` on Windows. Use a
checkout with its own `node_modules` (a symlinked one is refused). Check free disk first. Run `npm run test:packaged` against the exact app.
An ad-hoc macOS package is not Developer ID/notarization acceptance. The release workflow has
separate macOS and Windows signing paths; an unsigned artifact must be labelled unsigned.

For a single-platform build without the release regression, dispatch `package.yml` on the
desired source branch with `only=linux`, `darwin` or `win32`. It runs that platform's makers,
packaged smoke and terminal checks, then retains installers and provenance in the Actions
artifact `package-<platform>-<arch>`. For Linux x64, download `package-linux-x64` for the `.deb`.
These unsigned candidates do not publish a release or establish full regression acceptance.
Linux packaging installs locked dependencies without lifecycle scripts, installs the pinned
Electron runtime, rebuilds the terminal, then runs `runtime:check` so the required Unix
native addon is built before runtime validation. The separate `spawn-helper` is macOS-only;
Linux node-pty forks through its native addon.

Without signing variables the macOS build is ad-hoc signed. Locally, `MACOS_SIGN_IDENTITY` (with `APPLE_API_KEY`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`)
signs and notarizes the way the workflow does (`scripts/package-signing.cjs`). Distribution
needs a protected `release` environment with these secrets:

| Secret | What it holds |
| --- | --- |
| `MACOS_CERT_P12` | The Developer ID Application certificate and its private key, as a base64 `.p12` |
| `MACOS_CERT_PASSWORD` | The `.p12` password |
| `APPLE_TEAM_ID` | The 10-character team id in the certificate's name |
| `APPLE_API_KEY` | The App Store Connect API key's `.p8` contents (role Developer), for notarization |
| `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | That key's id and issuer id |

Windows is signed by the [SignPath Foundation](https://signpath.org) through
[`.github/actions/windows-signpath`](../.github/actions/windows-signpath/action.yml): the
packaged app's `genex.exe` and `.node` add-ons, then the `Genex-Setup.exe` made from them (the
SignPath project `genex-desktop`'s artifact configurations `app` and `installer`). The repository
secret `SIGNPATH_API_TOKEN` is SignPath's CI user's API token. Publishing runs sign only while the
repository variable `WINDOWS_SIGNING` is `on`; until SignPath has the production certificate,
leave it unset so Windows ships unsigned as a preview (SignPath refuses the policy otherwise, and
the refusal drops Windows from the release). They use the
`release-signing` policy, which accepts only builds from this repository's GitHub workflows; a
Package dispatch with `only: win32` and `test_sign` uses `test-signing`, SignPath's self-signed
test certificate, to check the wiring. The SignPath Foundation program requires the README's
[code signing policy](../README.md#code-signing-policy) (attribution, team roles, privacy) and a
link to it from release notes that ship Windows files.

The owner controls signing secrets, the protected release environment, tags and publication.
Require product checks and approval on the actual release repository, including fork workflow
restrictions. Pin and review installation/build actions before granting signing access. Keep
certificates out of the checkout and do not give pull-request code release credentials.

Retain the candidate's checksums, inventory, notices and signed-asset verification. Validate
`codesign`, Gatekeeper and stapling on macOS, and Authenticode on Windows. The workflow validates tag/version and main ancestry before signing access, then requires full
regression, terminal and gallery checks. The regression runs the whole `npm test` inventory as
parallel shards (`node scripts/ci-test-plan.mjs plan --full`: fast, rig and harness, each rig
runner serial) beside the end-to-end suites, while the packages build; only the draft upload
waits for both, and a failed shard re-runs alone. When Check's macOS `fast` job already passed on
the same commit (its push to `main`, or a dispatch), the release reuses it and skips its own fast
shards (`scripts/release-fast-evidence.mjs`); otherwise it runs them. The serial rig shards balance by the file
times the newest earlier release left (`scripts/release-durations.mjs`), by source bytes without one; the short harness shards queue after them (they wait on `linux-static`) so long rig shards never start last. An urgent fix may skip the regression with the repository
variable `RELEASE_REGRESSION=skip` (the builds then start after validation); dispatch a build-only
run on `main` after publication to run it, and unset the variable. Build-only dispatches use the `candidate` environment
and receive no signing secrets. Draft upload requires verified macOS signing plus the macOS and
Linux packaged smokes. Windows is built and tested every release, cannot hold the draft back, and
joins it once its job passed (`windowsShips` in `scripts/release-policy.mjs`): signed when
SignPath signs it, otherwise unsigned as a preview while `WINDOWS_SHIPS_UNSIGNED` is on. Release
notes that ship an unsigned Windows build say so and how to open it (SmartScreen: More info, then
Run anyway); set the flag off once Windows is signed. Unsigned build-only candidates remain
Actions artifacts. Each packaged platform
also exercises its terminal; Windows checks
the installer/uninstaller and a scripted packaged chat turn. Apps and DMGs both
need notarization/stapling. Platform provenance records the source and lock digest alongside
artifact hashes; `SHA256SUMS` covers the final inventory. Download links use
`releases/latest/download/<name>`, so every release, prereleases included, also carries
version-free names: `Genex.dmg`, byte-identical copies of the Linux packages
(`Genex-linux-amd64.deb`, `Genex-linux-x86_64.rpm`, `Genex-linux-x64.zip`, made by
`scripts/release-downloads.mjs` beside the versioned files, which keep their names) and, once
Windows ships, `Genex-Setup.exe`. A draft missing one is refused (`assertStableDownloads`).
GitHub's `latest` is the newest full release, never a prerelease. Existing public assets and drafts from
a different source cannot be replaced. The owner merges the version bump into `main`, and
`tag-release.yml` creates the matching annotated tag on that commit and dispatches `release.yml`
on it (a tag the workflow token pushes starts no workflow); a version whose tag exists is left
alone. Draft upload resolves that remote tag to the candidate commit and refuses missing or
mismatched tags. A draft
release is reviewed before publication. Maintain release notes that
name behavior changes, migration requirements and known limitations.

## Install, update and recovery acceptance

Test clean install, launch, terminal, first game, upgrade from the previous supported version,
data migration, quit during work, relaunch and uninstall on each supported platform. Back up
owned test games/profile before migration and prove the backup restores. Verify failed or
partial update recovery separately from a successful download.

Automatic updates are on from the public launch; see
[Automatic updates](#automatic-updates). Renamed forks fail the official-feed
identity check; a fork must also choose its own bundle/application id, data directory, signing
identity, catalog and service disclosures. Never publish the existing private history by changing
visibility: use the owner's approved, independently reviewed source/history route. Current-tree
cleanup does not erase old refs, PR diffs, Actions logs or artifacts.

### Release canary

`canary.yml` checks a published release the way people get it: on `release: published`, every
Monday on the latest release, and by hand with a tag. Each machine downloads from the public link
(waiting up to 20 minutes for it to serve the tag), checks the file against `SHA256SUMS`, installs
as a person does (a quarantined DMG into `/Applications`, `Genex-Setup.exe` with Mark of the Web, the
deb or rpm whose repository must then offer the version), times a flag-free first start to
`studio ready` in `studio.log`, and runs the release's own `run-electron-e2e.mjs --packaged` on the
installed app until the self test's sandboxed chat turn has reported (`scripts/canary/`). On Windows,
when the release's runner has the stage, the run adds `--claude-worker`: one Loop worker on the real
Claude Code CLI (the vendor's installer puts it in a home of the stage's own), its model a scripted Anthropic
stand-in (`tests/helpers/fake-anthropic.ts`, a dummy token, nothing billed), must run its turn
unrefused and write its folder from Genex's sandbox (`smoke/claude-worker-check.ts`). The vendor's installer gets 4 minutes there, inside the self test's 8, so a stalled install
reports how long it ran and what it last printed; every install says how long it took. Machines:
macOS 26 and 15, Ubuntu 26.04 and 24.04 and Windows Server 2025 on GitHub-hosted runners, Fedora
(install and repository only, in a container), and with `CANARY_AZURE=on` Windows 11 and 10 on
Azure VMs made for the run and deleted after it. Every Windows machine starts Genex as its
administrator on a lived-in profile (`lived-in-profile.ts`), whose first start sets the sandbox up;
after writing a profile it waits up to 15 minutes for the CPU to go quiet (`settle.ts`), since
Windows Search and the antivirus scan the new files and a start timed in that storm measured them;
the Azure machines then log a standard user on at its own desktop, with a lived-in profile too, and
run it again. An owner's run whose script never starts fails its machine as `owner run did not
start`, and the standard user's run, which needs that sandbox, is skipped. A GitHub runner cannot: an account started inside the runner's session cannot set up
that session's objects for the sandbox's runner. Logs, crash dumps and screenshots are run artifacts for 30 days.
A failing release gets one issue labelled `canary`, assigned to whoever published it; a passing
run closes it. The canary only reports: pulling a release stays the owner's call.

A dispatch with `package_run` checks a build before it is released: give it a Package workflow run
(dispatched with `only: win32`) and the Azure machines install that run's `Genex-Setup.exe` instead
of a download, with that run's commit driving the agent command. No other machine runs and no issue
is touched. Dispatch it from a ref the `canary` environment allows.

Adding `upgrade_from` (a release tag) checks the update from that release instead. Each Azure owner
installs the release, with one game in its library (`canary-kept-game`, a `.claude` folder and a
dependency tree), and starts it once, which sets the sandbox up for that release's srt-win; then the
build goes over it as Squirrel's update. The steps are `earlier-release`, `install`, `upgrade-card`
(the card that asks to update the sandbox, `upgrade-card.png`), `upgrade-approval` (pressing Update
raises exactly one approval prompt), `upgrade-start` (the studio up with no harness rewind) and
`agent-command`, run on that same profile. Azure's own account is the built-in Administrator,
which runs elevated and is never asked even under Admin Approval Mode, so an upgrade run's owner is
`canary-owner`, an ordinary administrator Prepare makes (UAC on, `EnableLUA 1`), with prompts off
for the earlier release's own setup. The earlier installer carries no Mark of the Web: with UAC on,
SmartScreen holds a release it does not recognize at "Windows protected your PC".
`scripts/canary/windows/uac-approver.ps1`, started as SYSTEM on the owner's desktop through WMI
(Run Command's job cannot hold a process of another session), turns the prompt on right before
Update is pressed and shows it on the normal desktop (`PromptOnSecureDesktop 0`), where it
photographs (`uac-<n>.png`) and approves each one; `approver-start.log` says whether it started. The standard user then installs the build
on the updated machine, as before. The build needs a higher version than the release, or Squirrel
has nothing to update: dispatch Package with `only: win32` and `version` (for example `0.1.99`).

Azure setup, once: the subscription owner runs `scripts/canary/azure-setup.sh` in Cloud Shell. It
creates an app registration whose only credential is GitHub's OIDC token for the `canary`
environment, gives it Contributor on the subscription, and sets a budget alert. Its three IDs go
in the `canary` environment's variables (`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
`AZURE_SUBSCRIPTION_ID`). A run outlasts one OIDC sign-in, so `azure.ts` signs in again with a
fresh token before an Azure call once the last sign-in is five minutes old, dropping az's cached
Azure token first so az never renews it with an expired OIDC token. `CANARY_WIN11_IMAGE`, `CANARY_WIN10_IMAGE`, `CANARY_AZURE_SIZE` and
`CANARY_AZURE_LOCATION` (regions, comma-separated) override the defaults. Without them the job
takes the first two-core size its quota allows, in the first region that accepts it; a region
whose quota the run's other machine took first is passed over too. Windows 11
and 10 images need a qualifying Windows license (Microsoft 365 Business Premium, E3/E5, Windows
Enterprise or Visual Studio); Windows Server images carry their own.

## Automatic updates

Installed macOS and Windows copies ask update.electronjs.org hourly, which serves the newest
published GitHub release of `UPDATE_REPO` ([auto-update](../src/main/auto-update.ts)), the
repository `forge.config.cjs` publishes to and `package.json` names (`auto-update.test.ts`
holds the three together). `AUTO_UPDATE_ENABLED` is on and [PRIVACY](../PRIVACY.md) discloses
the check. Linux copies ask GitHub's `releases/latest` every six hours instead
([release-check](../src/main/release-check.ts)) and offer the release page; nothing installs in
place there. The exception is a `.deb` or `.rpm` installed since the Genex package repository:
its maintainer scripts (`build/linux/postinst`, `rpm-post`) add packages.genex.games with the
key the package carries (`build/linux/genex-archive-keyring.asc`), and the system's updates bring
the next version, so the app asks nothing (`UpdateMode.System`).

The first check runs at launch, before the core starts (10 s later on a fresh Windows install's
first launch, while Squirrel holds its lock), so a start that fails, waits on Set up or hangs still
downloads the release that may fix it. Until the studio opens, its setup, start and start-failure
screens offer **Relaunch to update** for a downloaded version; once a version waits, quitting
installs it too, and Squirrel.Windows starts the newest installed version at the next launch.

### Linux package repository

packages.genex.games is the R2 bucket `genex-packages` behind that custom domain: a signed apt
repository (`dists/stable`, `pool/`) and a signed dnf repository (`rpm/`), each naming only the
newest release. `linux-repo.yml` fills it when a release is published, and on a pull request
builds it from the latest release with a throwaway key and installs Genex from it on Ubuntu 24.04
and Fedora. Its `packages` environment (dev and `v*` tags) holds `LINUX_REPO_SIGNING_KEY` and the
R2 credentials (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`); the workflow refuses
a key whose fingerprint differs from the shipped public key. To republish a release, run it on
dev with its tag. A publishing `release.yml` refuses to build Linux packages while the repository
is down, because every new install points apt or dnf at it. Never lose or replace the key without a
release that ships the new public key first: installs trust only the key their package wrote. Settings → About and the app menu's Check for Updates ask on demand. Squirrel.Mac
runs one check at a time, the download inside it, so a check asked meanwhile answers from the
running one (downloading), and the hourly checks stop once a version is downloaded: asked again,
the release CDN answers 304 and Electron forgets the update. Copies built before the switch
(every `-rc` so far) never check: their users reinstall from a release.

Rules for every release, because each mistake strands installed copies:

1. Bump `package.json` `version` and merge it into `main` in the public repository, which tags
   exactly `v<version>` (`release.yml` drafts into the repository it runs in). Run the full
   `npm test` first: the PR checks run only its fast group, and the release regression stops on
   any failure.
2. Publish each reviewed draft as a full release. The service skips drafts and pre-releases, so a
   `-rc` version reaches no installed copy. Draft upload refuses a release missing what the
   service serves: the `-darwin-arm64` zip, and Windows `RELEASES`, full `.nupkg` and installer.
3. Never change the bundle id, the Developer ID team, the product name `Genex` (the fork
   identity check) or `UPDATE_REPO`, and never replace a published release's assets: fix forward
   with a new version.
4. Accept the channel once with two signed releases: install the first from `/Applications` (Squirrel.Mac cannot
   replace an app run from the disk image), publish the second, relaunch, and check Restart to
   update, the prompt during an active run, and an install at a plain quit. On Linux, check
   that the sidebar offers the second release's download and Check for Updates finds it.

For an incident, stop further distribution, preserve candidate/evidence identifiers, use the
private [security channel](../SECURITY.md), and publish corrected release notes only after the
owner approves the replacement. Do not claim a rollback restores remote side effects.

## Repository controls

Configure required Linux `gate`, documentation and relevant platform/rig checks on `dev` and
`main`, restrict direct updates, and require an owner review before main promotion. Protect the
`release` environment with required reviewers and approved main/tag deployment rules; disable
administrator bypass where supported. Workflow code alone does not configure these controls.
Check the live settings and exact candidate CI before calling a release cycle accepted.
