# Assets and plugins

## Assets in a game

Assets groups `assets/`, `public/assets/` and the asset folders of the project's kind (Unreal
`Content`, Unity `Assets`, Blender files, a plugin's) by source and generation; engine files show
by name. Deliveries and outside changes refresh it. Cards hide metadata; animation-only GLBs fold
into their model.

Opening a file shows it with only Reveal in Finder and Close: images (click: full
size), audio/video, 3D models with their clips, textures or bounded text. Unsupported
formats and decoder failures explain themselves; media reads are bounded and load lazily.

Chat shows game-folder files, Open in Assets and bounded batches. Builds shows Loop workspace
assets as thumbnails with their location until landing; checks and Blender passes are notes;
visuals preview in two columns, sounds in compact rows. Job completion or “seen in game”
never proves integration or passing checks.

## Tools and setup

The prompt bar's Add menu holds reference attachments, plugin and MCP switches, Connect and
Manage. Enabled, connected, signed in and permitted are different states.

Plugins opens a page with Plugins/Skills, search, rows and details. Plugins and MCP
servers show their own pictures (manifest `icon`, MCP `serverInfo.icons`) or an initial. The
list shows installed plugins (Genex as the game dev tools router), servers you added, the
Marketplace (Coming soon until it lists something new) and the plugin guide. Install from GitHub pins a pasted link's latest release
(else the default branch's newest commit). Games build, preview and export without plugins.
The host draws Genex's app-wide page (balance, routed tools) and Local Blender's
runtime card. Connect, unapproved, reuses a saved account or
opens browser sign-in; setup survives restart and reinstall. Game spend is in the usage panel.
Enabled Genex suggests assets in planning; workers use it once the account is ready. Your
preferences win; failures and fallbacks are disclosed.
Genex bundles its MCP with the same account: game/animation search, owned games and
generation status. Host tools handle generation, delivery, credits and publishing
and run the pinned Genex CLI outside the game: `genex__cli` free; `genex__cli-paid` and
`genex__package` (pinned multiplayer or player-identity package, build games) after consent.
Publish (a host-drawn stage dialog) tests the draft before making it public.
Agents read Genex’s guide and cards via `genex__skill`, never from game files.
Plugin MCPs connect on first use; the composer shows actionable failures only.

The curated catalog is served anonymously from `plugins.genex.games`; reviewed releases
live in `genex-games/genex-plugins`. Genex and Local Blender are the initial official entries.
Catalog installs require native-code trust; updates keep data, settings and jobs and require
a newer compatible release. See the [release procedure](../STUDIO-MARKETPLACE-RELEASE.md).

## Permissions and lifecycle

Installation shows publisher and capabilities; new capabilities need confirmation. Game agents
never install, enable or approve plugins; an agent may suggest one that is off or in
Genex's catalog as a card only your click acts on. Process isolation
does not sandbox native code.

Confirmation tools ask in chat ([questions](chat.md#questions-and-plans)); routine generation
progress has no answer controls.

Connector tools ask before each call unless Settings holds an exact tool grant; server hints
grant nothing. Plugin upload staging shows the complete included/excluded file list
for a second approval. Revocation prevents future calls; remote side effects remain.

Removal keeps data, credentials and jobs; another source reusing a plugin's id needs
**Replace and erase data**, and bundled ids cannot be taken. Reinstall is explicit, bundled plugins too;
local reinstall reviews a fresh snapshot. Host-managed secrets never enter composer text.

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
