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
secret `SIGNPATH_API_TOKEN` is SignPath's CI user's API token. Publishing runs use the
`release-signing` policy, which accepts only builds from this repository's GitHub workflows; a
Package dispatch with `only: win32` and `test_sign` uses `test-signing`, SignPath's self-signed
test certificate, to check the wiring.

The owner controls signing secrets, the protected release environment, tags and publication.
Require product checks and approval on the actual release repository, including fork workflow
restrictions. Pin and review installation/build actions before granting signing access. Keep
certificates out of the checkout and do not give pull-request code release credentials.

Retain the candidate's checksums, inventory, notices and signed-asset verification. Validate
`codesign`, Gatekeeper and stapling on macOS, and Authenticode on Windows. The workflow validates tag/version and main ancestry before signing access, then requires full
regression, terminal and gallery checks. Build-only dispatches use the `candidate` environment
and receive no signing secrets. Draft upload requires verified macOS signing plus the macOS and
Linux packaged smokes. Windows is built and tested every release, cannot hold the draft back, and
joins it only once it is signed and its job passed (`distributionPlatforms` in `scripts/release-policy.mjs`); unsigned candidates, including
unsigned Windows packages, remain Actions artifacts. Each packaged platform
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

## Automatic updates

Installed macOS and Windows copies ask update.electronjs.org hourly, which serves the newest
published GitHub release of `UPDATE_REPO` ([auto-update](../src/main/auto-update.ts)), the
repository `forge.config.cjs` publishes to and `package.json` names (`auto-update.test.ts`
holds the three together). `AUTO_UPDATE_ENABLED` is on and [PRIVACY](../PRIVACY.md) discloses
the check. Linux copies ask GitHub's `releases/latest` every six hours instead
([release-check](../src/main/release-check.ts)) and offer the release page; nothing installs in
place there. Settings → About and the app menu's Check for Updates ask on demand. Squirrel.Mac
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
