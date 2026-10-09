# Submit a plugin release

Anyone can submit a plugin. Maintainers review every release by hand before it is listed;
passing automation alone never approves one. Until it is listed, people can already install
your plugin from its GitHub link (Plugins → Add → Install from GitHub).

1. **Build and test it in Genex.** Follow the
   [plugin guide](https://github.com/genex-games/genex-desktop/blob/dev/docs/PLUGIN_GUIDE.md):
   `npm run plugin:new`, `npm run plugin:doctor`, then Plugins → Add → Load local plugin… in
   the app. Use stable `x.y.z` versions; a fix after release needs a higher version.
2. **Publish the source.** Push the plugin to a public GitHub repository, commit, and note the
   40-character commit sha. Keep a license file in the repository.
3. **Write the release record.** From a Genex checkout, with a clone of your fork of this
   repository:

   ```sh
   npm run plugin:submit -- /path/to/plugin --catalog /path/to/genex-plugins \
     --repo you/your-plugin --sha <commit> --category tools [--subdir <folder>] [--docs-url <https URL>]
   ```

   It packs the prebuilt package, writes `records/<id>/<version>.json`, updates `index.json`,
   checks the result with this repository's validator and prints the artifact file it made.
   Never edit an existing record.
4. **Attach the artifact** that command printed to a GitHub release of your plugin's
   repository (the release for that version). Do not commit it here.
5. **Open a pull request** against `main` and fill in the template: the release asset link,
   license, contact, what each capability is for, and the test evidence.

CI's first step checks your record (identity, history, ownership). Its second step stays red
with "Waiting for a maintainer…" until a maintainer has reviewed your package and uploaded the
artifact; that is expected. Maintainers check that the artifact matches your source at the
commit, run it, and look at static findings, account behavior and install/update evidence.

Do not reuse another publisher's id or change the validation policy in a submission. New
hosting origins and ownership transfers are separate maintainer decisions.

Required evidence: fresh install, a real harmless tool call, activation in the same chat,
settings kept after an update, disable/remove behavior, and the account flow when there is one.
No paid generation is required to demonstrate plugin plumbing.
