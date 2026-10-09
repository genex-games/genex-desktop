# Studio curated plugin catalog

This repository lists reviewed releases. It does not host games or require a Genex account.
Anyone can submit a plugin release: see [CONTRIBUTING.md](CONTRIBUTING.md) and the
[plugin guide](https://github.com/genex-games/genex-desktop/blob/dev/docs/PLUGIN_GUIDE.md).
Maintainers review every submission before it is listed.

- `index.json`: current discoverable releases.
- `records/<id>/<version>.json`: immutable release identity, retained after withdrawal.
- `policy.json`: maintainer-owned artifact origins and reserved official identities. Each
  official id lists its publisher and `repos`: the current source first, then repositories it
  used to live in. Released records may name any of them and keep one identity; a new release
  must name the first. No other id may name an official repository.
- `scripts/check-catalog.mjs`: dependency-free static release gate; its identity rules are
  tested by `node --test scripts/check-catalog.test.mjs`.
- `scripts/stage-artifact.mjs`: maintainer step that fetches a submitter's release asset and
  stages it for upload only if it matches its record.
- `.github/workflows/catalog.yml`: PR validation against the base branch's validator and policy:
  the submitter's record first, then whether its artifact has been published.
- `.github/pull_request_template.md`: what a submission states and shows.

Artifacts live on the approved public HTTPS origin, at `<id>/<version>/<sha256>.json`.
They are prebuilt base64 JSON envelopes, never npm installs or extraction hooks. Upload
artifact objects before updating the index; never overwrite a published object. This
repository contains metadata only. The preparation command's sibling `uploads/` directory
is the payload for hosting, not something to commit into this repository.

## Maintainer bootstrap

1. Review `policy.json`, official identities, source SHA/build provenance and package licenses.
2. Replace draft URLs/source locations with approved, publicly accessible destinations.
3. Run local artifact validation before uploading:
   `node scripts/check-catalog.mjs --root . --artifacts /absolute/path/to/uploads`.
4. Publish immutable artifacts through the approved hosting process; then run:
   `node scripts/check-catalog.mjs --root . --remote`.
5. Require review of catalog/policy/workflow changes and the validation check in repository settings.
   Configure actual maintainers/CODEOWNERS before accepting submissions; preparation does not
   configure GitHub branch protection. Review workflow/policy changes separately from submissions.
6. Perform a clean unsigned-in Studio install/use/update acceptance before changing Studio's default URL.

The static gate checks identities, ownership continuity, versions, hashes, paths and the
manifest's core match. Studio's full manifest validation, scan and activation checks still run
at install time. A passing catalog check is not a security audit or runtime acceptance.

Official indicates the designated maintainer, not a stronger sandbox. Plugin backends are
trusted native code. Community submissions are reviewed manually; users still approve installation.

Removing an index entry withdraws discovery. It does not delete or automatically disable an
installed plugin. Retain records and artifacts for recovery; disclose incidents and corrective
versions. Signed metadata, automatic revocation and silent updates are not implemented.
