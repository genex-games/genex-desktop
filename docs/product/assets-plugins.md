# Assets and plugins

## Assets in a game

Assets groups media in `assets/`, `public/assets/` and the project kind's asset folders (Unreal `Content`,
Unity `Assets`, Blender files, a plugin's) by source and generation, engine files by name;
deliveries and outside changes refresh it. Cards hide metadata; [jobs being made](../plugins.md#assets-being-made)
(any plugin's or MCP tool's) keep their spot, chat included; animation-only GLBs fold into models.

An opened file has only Reveal in Finder and Close: images, audio/video, 3D
models with clips, textures or bounded text; unsupported formats and decoder failures say why.
Deliveries a C++ or Rust game cannot load land refused ([formats](../../src/shared/game-assets.ts)).

Chat shows game-folder files with Open in Assets; Builds, a Loop's workspace assets until landing. Job completion or “seen in game” never proves integration or passing checks.

## Tools and setup

The prompt bar's Add menu holds attachments, plugin and MCP switches, Connect and Manage.
Enabled, connected, signed in and permitted differ.

The Plugins page lists installed plugins, your servers, the
Marketplace (Coming soon) and plugin guide, with
[icons](../plugins.md#icons). Install from GitHub pins a link's latest release
(else newest commit); games need no plugins. The host draws Genex's
app-wide page and Local Blender's runtime card. Connect,
unapproved, reuses a saved account or opens browser sign-in; setup survives restart and reinstall.
Game spend is in the usage panel. Enabled Genex suggests assets in planning;
[CC0 Library](../plugins.md#the-cc0-library) fetches free ones.

Genex bundles its MCP (game/animation search, owned games, generation status) on the same account;
host tools run the pinned CLI outside the game: `genex__cli` free; `genex__cli-paid` and
`genex__package` (multiplayer, player identity) after consent. Publish (a host-drawn dialog)
connects SDK-less games for sign-in, tests the draft, goes public and sends the `genex-cover` demo
frame as the Genex cover, not the sidebar sphere ([rules](../plugins.md#first-party-privileges));
else Ask for a cover drafts it in chat. Agents check `genex__cover` before publishing; consented
`genex__cover-set` sends it. Chat shows the kept shot with Publish. Agents read Genex’s guide and
cards via `genex__skill`, never from game files. Plugin MCPs connect on first use.

The curated catalog (`plugins.genex.games`) lists
Genex and Local Blender as official; its installs require native-code trust
([procedure](../STUDIO-MARKETPLACE-RELEASE.md)).

## Permissions and lifecycle

Installation shows publisher and capabilities; new capabilities need confirmation. Game agents never
install, enable or approve plugins, only
[suggest or write one](projects-engines.md#plugins-on-or-off). Process isolation does not sandbox
native code.

Connector tools ask before each call unless Settings holds an exact grant (a plugin's read-only
tools never ask, its others not in Auto); server hints grant nothing. Plugin uploads show every
included/excluded file for a second approval. Revoking stops future calls, not remote effects.
Removal keeps data, credentials and jobs; updates (a newer compatible release) also keep settings:
rows offer **Update to x**, the sidebar **Update plugins** (all). Built-in plugins install and update
without asking. Reusing a plugin's id from another source needs **Replace and erase data** (never a
bundled id). Reinstall is explicit; local reinstall reviews a fresh snapshot. Host-managed secrets
never enter composer text.

Skills lists Studio’s own, the game’s, providers’ global and plugin
skills. Codex says whether workers load its catalog; Claude’s global entries stay excluded. Plugin
switches cover all games; resumed workers hear what was withdrawn.

## Where to work

[AssetsCanvas](../../src/renderer/panels/AssetsCanvas.tsx),
[AssetPreview](../../src/renderer/panels/AssetPreview.tsx),
[AssetResults](../../src/renderer/chat/AssetResults.tsx) and
[PluginsPanel](../../src/renderer/panels/PluginsPanel.tsx) own the UI.
Details: [plugin host](../plugins.md),
[Plugin guide](../PLUGIN_GUIDE.md),
[connections](../connections-and-context.md).
