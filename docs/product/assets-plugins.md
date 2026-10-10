# Assets and plugins

## Assets in a game

Assets groups `assets/` and `public/assets/` files by source and generation, even before a
build; deliveries and external changes refresh it. Cards hide metadata; animation-only GLBs fold
into their model.

A file opens with only Reveal in Finder and Close: images (click: full
size), audio/video, 3D models playing their clips, textures or bounded text. Unsupported
formats and decoder failures explain themselves. Reads are bounded; offscreen previews load lazily.

Chat shows game-folder files. Builds shows Loop workspace assets as thumbnails with their
location until landing; checks and Blender passes on an asset are notes.
Chat offers Open in Assets and bounded batches. Job completion or “seen in game”
proves neither correct integration nor passing checks.

## Tools and setup

The prompt bar's Add menu holds reference attachments, plugin and MCP switches, Connect and
Manage. Enabled, connected, signed in and permitted are different states.

Plugins opens a page with Plugins/Skills, search, rows and details. Plugins and MCP
servers show their pictures ([Icons](../plugins.md#icons)) or an initial. It
lists installed plugins (Genex routes game dev tools), your servers, the
Marketplace (Coming soon until the catalog has something new) and the plugin guide. Install from GitHub pins a pasted link's latest release
(else the default branch's newest commit). Games build, preview and export without plugins.
The host draws Genex's app-wide page (shared balance, routed tools) and Local Blender's
runtime card. Connect, unapproved, reuses a saved account or
opens browser sign-in; setup survives restart and reinstall. Game spend is in the usage panel.
Enabled Genex suggests assets in planning; workers use it once the account is ready. User
preferences win; failures and fallbacks are disclosed.
Genex bundles its MCP with the same account: game/animation search, owned games and
generation status. Host tools handle generation, delivery, credits and publishing
and run the pinned CLI outside the game: `genex__cli` free; `genex__cli-paid` and
`genex__package` (pinned multiplayer or player-identity package, build games) after consent.
Publish (a host-drawn stage dialog) tests the draft, makes it public, then sends the
game's `genex-cover` demo frame as its Genex cover (not the sidebar sphere); without one, Ask for a
cover drafts that request in chat. Agents check it before every publish (`genex__cover`);
consented `genex__cover-set` sends it. Chat shows the latest kept shot with Publish.
Agents read Genex’s guide and cards via `genex__skill`, never from game files.
Plugin MCPs connect on first use; the composer shows only actionable failures.

The curated catalog is served anonymously from `plugins.genex.games`; reviewed release records
live in `genex-games/genex-plugins`. Genex and Local Blender are official entries.
Catalog installation requires native-code trust
([release procedure](../STUDIO-MARKETPLACE-RELEASE.md)).

## Permissions and lifecycle

Installation shows publisher and capabilities; new capabilities need confirmation. Game agents
cannot install, enable or approve plugins. Process isolation does not sandbox native code.

Confirmation tools ask in chat ([questions](chat.md#questions-and-plans)); routine generation
progress has no answer controls.

Connector tools ask before each call unless Settings holds an exact tool grant. Server hints
cannot grant authority. Plugin upload staging lists every included/excluded file
for a second approval. Revocation prevents future calls; remote side effects remain.

Removal preserves data, credentials and jobs; another source reusing a plugin's id needs
**Replace and erase data**; bundled ids cannot be taken. Reinstall is explicit, even for bundled plugins;
local reinstall reviews a fresh snapshot. Updates (a newer compatible release) preserve data;
rows offer **Update to x**, the sidebar **Update plugins** (all, each approved).
Host-managed secrets never enter composer text.

Skills lists Studio’s own (local chat, planner, director), this game’s, each provider’s global
and plugin skills. Codex says whether workers load its catalog; Claude’s global entries stay
excluded. Plugin switches cover all games; resumed workers hear what was withdrawn. Discovery
is read-only.

## Where to work

[AssetsCanvas](../../src/renderer/panels/AssetsCanvas.tsx),
[AssetPreview](../../src/renderer/panels/AssetPreview.tsx),
[AssetResults](../../src/renderer/chat/AssetResults.tsx) and
[PluginsPanel](../../src/renderer/panels/PluginsPanel.tsx) own the UI.
Details: [plugin host contract](../plugins.md),
[Plugin guide](../PLUGIN_GUIDE.md) (authoring),
[Connections and context](../connections-and-context.md) (setup).
