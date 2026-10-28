# Assets and plugins

## Assets in a game

Assets groups media in `assets/`, `public/assets/` and the project kind's asset folders (Unreal `Content`,
Unity `Assets`, Blender files, a plugin's) by source and generation, engine files by name;
deliveries and outside changes refresh it. Cards hide metadata; [jobs being made](../plugins.md#assets-being-made)
(any plugin's, any MCP tool's) keep their spot, chat included; animation-only GLBs fold into models.

An opened file has only Reveal in Finder and Close: images (click: full size), audio/video, 3D
models with clips, textures, bounded text; unsupported formats and decoder failures say why.

Chat shows game-folder files with Open in Assets; Builds, a Loop's workspace assets until landing. Job completion or “seen in game” never proves integration or passing checks. [Save, Share, search](../play.md#asset-library-and-sharing).

## Tools and setup

The Add menu holds attachments, plugin and MCP switches, Connect and Manage.
Enabled, connected, signed in and permitted differ.

The Plugins page (Plugins/Skills, search, details) lists installed plugins, your servers,
Community plugins and the plugin guide ([icons](../plugins.md#icons)). Install from GitHub pins a link's latest release
(else newest commit). Games build, preview and export without plugins. The host draws Genex's
app-wide page (balance, routed tools, candidate pictures) and Local Blender's runtime card. Connect,
unapproved, turns Genex on and reuses a saved account or opens browser sign-in; setup survives restart and reinstall.
Spend: usage panel; prices: Credits. Enabled Genex suggests assets in planning.
Generations wait for unaccepted terms (Review: sidebar, chat).

Genex bundles its MCP (game/animation search, owned games, generation status) on the same account;
host tools run the pinned CLI outside the game: `genex__cli` and `genex__package` (multiplayer,
player identity; template games map Studio's copies) free; `genex__cli-paid` after consent; a
`shop add --json` draft becomes chat's [Listing draft card](../play.md#the-item-store). Publish (host-drawn)
refuses empty starters, connects SDK-less games, tests the draft, goes public, sends the `genex-cover` frame,
`genex-clip` ([rules](../plugins.md#first-party-privileges)), plus its project if remixable
([Remix](../play.md)); Studio takes the cover after
turns, never blank (engine builders render theirs); consented `genex__cover-set` sends it now; chat shows it. Multiplayer (built, single-player) asks chat (Genex
off: enable it); Publish needs only the account; both offer Update while older. Agents read
Genex’s guide via `genex__skill`, not game files. Plugin MCPs connect on first use.

The curated catalog (`plugins.genex.games`; reviewed releases in `genex-games/genex-plugins`) lists
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
Removal (never Genex's) keeps data, credentials and jobs; updates (newer compatible releases) also keep
settings: rows offer **Update to x**, the sidebar's **plugin updates** the ticked ones. Built-ins install and update
unasked. Reusing a plugin's id from another source needs **Replace and erase data** (never a
bundled id). Reinstall is explicit; local reinstall reviews a fresh snapshot. Host-managed secrets
never enter composer text.

Skills lists Studio’s own (local chat, planner, director), the game’s, providers’ global and plugin
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
