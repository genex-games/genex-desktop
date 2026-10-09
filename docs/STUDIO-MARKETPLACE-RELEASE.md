# Public curated plugin releases

## Distribution

The catalog repository is [genex-games/genex-plugins](https://github.com/genex-games/genex-plugins).
Its tooling and documentation use MIT. Hosted plugin dependencies retain their own licenses;
the catalog license does not relicense the private Studio source or package artifacts.

The public index is `https://plugins.genex.games/catalog/v1/index.json`. Packages live at
`https://plugins.genex.games/releases/<id>/<version>/<sha256>.json`, served by the R2 bucket
`studio-plugin-releases` in Cloudflare account `d77cfbca817ed65e0f033ddb32f3c8a2`.
Downloads need no Genex account or private GitHub credential. Official package records pin
private Studio source commits for maintainer provenance; installation uses the public artifact.

Genex and Local Blender are official curated entries. The catalog never executes install
hooks. Studio validates manifests, checks SHA-256, scans packages and asks for native-code
trust before installation. Official identifies the maintainer; it does not imply a stronger
sandbox. Generated games, profiles, credentials and acceptance scaffolds are not catalog content.

### Source repository moved

The Studio source moved from `Rabneba/ai-game-studio` to `genex-games/genex-desktop`. Published
records are immutable and still name the old repository, so the move takes three steps:

1. The app accepts either repository for the official `genex` and `blender` ids
   (`STUDIO_CATALOG_POLICY` in `src/substrate/plugins/marketplace.ts`) and treats them as one
   source, so an installed official plugin keeps its identity, account and data. Done.
2. The next official Genex and Blender releases name `genex-games/genex-desktop` in their
   records; `policy.json` in genex-plugins lists it first, then the legacy repository. Done for
   Genex 1.5.0; Local Blender 1.1.1 (the bundled 1.1.0 code; catalog installs get the current backend and panel) is next.
3. Once every current official record names the new repository, a later app release drops
   `Rabneba/ai-game-studio` from its policy.

## Maintainer workflow

1. Scaffold with `npm run plugin:new -- my-plugin --out /path/to/packages`.
2. Implement and test through the public SDK. Run `plugin:doctor` on reviewed code only.
3. Build the distributable and review source provenance, licenses, files and capabilities.
4. Run `npm run catalog:prepare -- <config> <new-output>`. It creates a portable catalog,
   immutable records, trusted-origin policy and separate `uploads/` envelopes.
5. Submit metadata and evidence to the public repository. Its trusted base-branch checker
   rejects changed historical records, ownership takeover, downgrades and unapproved origins.
6. Upload immutable packages before publishing the reviewed index. Run anonymous hash and
   manifest validation and real clean-profile install/update acceptance first.
7. Follow [RELEASING.md](https://github.com/genex-games/genex-plugins/blob/main/RELEASING.md)
   for the exact R2 commands. Package objects have immutable caching; the index has a 60-second
   HTTP cache lifetime. Studio retains its six-hour cache with explicit refresh and stale fallback.

Community releases arrive as pull requests written by `npm run plugin:submit`: a record, its index
entry and an artifact attached to the author's own GitHub release. The maintainer stages that
artifact, restores it with `npm run plugin:unpack` to compare with the source commit, doctors it in
isolation and uploads it, as
[RELEASING.md](https://github.com/genex-games/genex-plugins/blob/main/RELEASING.md#community-submissions)
lists.

Public main requires one approving code-owner review and the `validate` status check, including
for administrators. Pull-request CI has read-only permissions and no deployment credentials.
Publication is a maintainer operation, not a side effect of accepting a submission.

## Client guarantees and acceptance

Updates require a newer compatible version from the same publisher/source location. The host
rechecks eligibility when the user acts. Updates preserve plugin data and do not silently enable
a disabled plugin. Withdrawing discovery retains immutable records and existing installations;
corrective changes need a higher version.

Large artifact downloads have a separate bounded five-minute timeout. The host caps decoded
bytes and verifies the final SHA-256 before installation. HTTP transport compression can
reduce transfer size without changing the decoded package or its digest. Catalog metadata
keeps its shorter timeout. Truncated or modified packages never reach the installer.

Release acceptance covers anonymous discovery, install, a harmless real backend call,
newer-version update/data retention, offline cache, digest rejection and same-chat activation.
Account sign-in and entitlement acceptance remain separate from public package delivery.

Run `node tests/e2e/run-public-catalog.mjs --live` for anonymous official-package installation,
a real read-only Genex backend status call and offline-cache recovery. The manual Embedded
terminal workflow includes this job without application dependencies or credentials. It executes
reviewed native packages; it is deliberately excluded from untrusted pull-request validation.
