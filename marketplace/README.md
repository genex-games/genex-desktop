# Curated catalog preparation

Studio uses `https://plugins.genex.games/catalog/v1/index.json`. The public curated source
is `genex-games/genex-plugins`; see [release procedure](../docs/STUDIO-MARKETPLACE-RELEASE.md).
The local `index.json` is an empty scaffold, not the deployed catalog.

`template/` is a portable, dependency-free catalog repository scaffold. Prepare actual built
packages into a new output directory (no upload or repository creation):

```sh
npm run catalog:prepare -- /absolute/path/catalog-config.json /absolute/path/new-catalog-release
```

Configuration:

```json
{
  "artifactBaseUrl": "https://plugins.example.invalid/releases",
  "packages": [{
    "directory": "/absolute/path/prebuilt/my-plugin",
    "category": "tools",
    "tier": "community",
    "repo": "publisher/plugin-source",
    "sha": "FULL_40_CHARACTER_SOURCE_COMMIT",
    "minStudioVersion": "0.1.0",
    "docsUrl": "https://example.invalid/plugin-docs"
  }]
}
```

URLs above are placeholders. Source commit and package license/build provenance must be
reviewed; preparation does not establish their correctness or anonymous reachability.
Use the actual built `genex` and `blender` packages for initial official entries, with tier
`official`, category `assets`, and their reviewed source repository/commit. Do not pack their
TypeScript source directories: the release needs built backend files and runtime dependencies.

The app enforces the same official ids and artifact origins itself (`STUDIO_CATALOG_POLICY` in
`src/substrate/plugins/marketplace.ts`): an official entry or artifact origin the catalog's
`policy.json` allows but the app does not is dropped by every Studio build. Change both together.

Output:
- `catalog/`: index, immutable release records, maintainer policy, submission guide and pull
  request template, validator, its tests, the artifact staging step for community submissions
  (`scripts/stage-artifact.mjs`) and PR CI. The policy reserves each `official` package as
  `official[id] = {publisher, repos: [repo]}`; when an official source has moved, list its
  previous repositories after the current one.
- `uploads/`: content-addressed envelopes, separate from Git metadata.
- `preparation.json`: validation report, explicitly unpublished.

Run the copied validator against the previous catalog to prevent repacking, downgrade and
publisher takeover. CI reads the validator and approved origins from the PR base; it never
executes plugin code, uses package install hooks, or publishes anything. Source build/doctor
and runtime checks belong in a separate reviewed, isolated acceptance environment.
