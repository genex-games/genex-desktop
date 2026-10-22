# Studio plugins — API 3

The composer's Add panel lists installed plugins with the same global enable switches, plus
configured MCP connectors. Enabled and connected are separate states. Connect lists tools on
the registry's live connection (or opens setup when trust/secrets are missing); a plugin's name,
or the Settings its row shows while hovered or focused, opens that plugin's page; Manage opens the
sidebar's Plugins workspace page, which includes MCP servers. Local Blender is an
independent first-party plugin using the public API 3 managed-native services. It needs no
Genex account. No connector credentials enter the composer. See [connections and context](connections-and-context.md) for the current setup/session lifecycle.

Plugins contribute tools, skills, standard settings, isolated interactive panels and, since API 2,
buttons in the stage strip beside Live/Builds and MCP servers the host runs as connectors they own. Genex is bundled and enabled by default. Enablement
never signs in, unlocks credentials or enables paid assets. Core game creation, previews and
exports work with no enabled plugins.

## Compatibility policy

- `apiVersion` is `1`, `2` or `3`. All are accepted by the same validator (`substrate/plugins/manifest.ts`)
  and run on the same host; a manifest that names any other version is refused as incompatible.
- API 2 is additive over API 1. The new sections (`toolbar`, `network`, `mcpServers`,
  `tools[].confirmation`) are optional. Documented API is never removed; a working API 1 package keeps working.
- Unknown top-level fields are ignored: the validator returns a **canonical** manifest in a fixed
  key order with unknown keys dropped (nested objects are rebuilt from their known keys too), and
  `canonicalManifest(m)` is the string the catalog and the marketplace compare — key order and
  unknown fields never make two equal manifests differ.
- Version-gated fields are rejected under a lower `apiVersion` with a clear message
  (`toolbar requires apiVersion 2`, `network requires apiVersion 2`,
  `mcpServers requires apiVersion 2`, `tools[].confirmation requires apiVersion 2`) rather than silently ignored, so a package cannot
  claim API 1 and still ship API 2 behaviour.
- API 3 adds `native-runtime`, `nativeRuntimes`, `nativeJobs`, `assetLimits`, host-memory credential-session access, file skills, `tools[].audience` and (bundled Genex only) `tools[].host`, and the sections that shape a project's Loop: `detect`, `facts` and `tools[].makes` ([Project facts](#project-facts)), `workspace` and `assets`, `workerTypes`, `scaffolds`, `folders`, `hooks`, `locks` (with `needs` and `tools[].ready`) and `observers`. Lower-version manifests cannot claim those declarations.
- API 3's `observe` also takes an optional `still` (additive; no manifest field or capability of
  its own). A host older than the option ignores it and answers an ordinary observation, so a
  caller checks the answer for `still`, then `stillProblem`, and handles neither (the SDK types the
  answer as `PluginStillAnswer | PluginStillIgnored`).
- API 3's `observe` takes an optional `clip` the same way (additive, no field or capability of its
  own; never beside `still` or files): `{ demo, width, height, seconds?, fps?, maxBytes? }` records
  `seconds` of the game running from the moment the demo stages, after the host starts its clock
  (`__studio.start()`), on a hidden window (`core/view-clip.ts`, budget: its seconds and a minute).
  The page records the canvas a still reads with `MediaRecorder` (MP4/H.264, else WebM VP9/VP8) at
  two bitrates and the host keeps the best that fits (`main/preview-clip.ts`). The answer is
  `clip` (video, poster, `motion`) or `clipProblem` with a still's codes.
- Plugin tool parameters are scalar (`string` / `number` / `boolean` properties); API 3 also accepts `type: "object"`, optionally with `acceptJsonString` for a migrated scalar (`toolParameter` in `src/substrate/plugins/manifest.ts`; see the plugin guide's structured arguments). External MCP tools retain their full nested schemas.

## Package and distribution

A prebuilt directory contains `plugin.json`, a backend ES module and self-contained HTML panels.
See `src/plugins/example` for the independent SDK example (API 2: a plain tool, a confirmed tool,
two actions, a settings panel and one toolbar button). IDs use lowercase letters, digits and
hyphens. Agent tool names are `<plugin-id>__<tool-name>`. Duplicate declarations, unsupported
capabilities, escaping paths, symlinks and incompatible API versions are rejected.

Plugins → Add → Load local plugin copies a selected package into host-owned storage after displaying
its publisher and capabilities. A package is one set of files on every route: dotfiles and
dot-folders anywhere (`.git`, `.env`) and the scaffold's authoring files at its root
(`AGENTS.md`, `jsconfig.json`, `tsconfig.json`, `plugin-sdk/`) are never packed, copied, fetched
from GitHub or scanned (`isPackageEntry` in `substrate/plugins/pack.ts`). Local packages are unreviewed. Backends execute trusted native
code; a child process is crash isolation, not an OS security sandbox — the trust dialog says so.
Never load a package merely because an agent placed it in a game. Agents cannot install, enable,
update, allow or approve plugins. A plugin from a local folder (Load local plugin, a re-load after
removal, a replacement from a folder, dropped code the person allows) is installed **off**: only the
person turns it on, and the trust dialog says it runs with their access and, for one with `hooks`,
at which of Genex's moments. One that starts off runs none of its code: its backend is proven to
start when the person turns it on. An update or a watch reload keeps the person's choice (the trust
dialog says an update of one that is on stays on, its new code running at once); bundled,
catalog, GitHub and index installs start on as before (`startsEnabled` in `registry.ts`).

The curated catalog is an app-owned `catalog.json` containing exact manifests, HTTPS artifact
URLs and SHA-256 digests. No remote catalog releases are configured yet. A release artifact is a
JSON object mapping relative file names to base64 bytes; build all JS before distributing it.
`node scripts/pack-plugin.ts <prebuilt-directory> <artifact.json>` creates the envelope and prints
the exact manifest/digest for catalog review. There are no npm install hooks or archive
extraction scripts. Downloads refuse redirects and are bounded to 256 MiB. A digest/manifest
mismatch aborts installation (manifests are compared canonically). Local packages and catalog
releases use the same validation and isolated startup probe. Updates wait for active sessions; a
failed probe leaves the prior installation selected. Expanded capabilities require explicit
installation confirmation. Updates are never automatic. Each install or reload copies the package
to `packages/<id>/<version>-<uuid>` (a clone where the disk can make one, as APFS does, so a
profile's copies of the bundled plugins take no space until edited); once the new copy is active (and its MCP servers moved to it)
the copy it replaced is deleted, as is a pending update superseded before it activated. At start-up
Studio deletes copies of an installed id that no record points to and any `staging/` leftovers;
folders of ids with no record are unlisted code and stay. Stored settings reach a new version only
as the keys it declares, each with the declared type or else its default.

### Three states and the allow-list gate

Every plugin the registry knows is in one of three states, reported as `PluginInfo.state`:

- `enabled` — installed and active: tools, skills, panels and toolbar items are contributed.
- `disabled` — installed but switched off, or removed (`removed: true`). Nothing is contributed.
- `not-enabled` — code found under `engine-homes/plugins/packages/<id>` **without an install
  record** (`unlisted: true`). It is listed in the Plugins page under "Not enabled" and never
  activated until the user presses **Allow…**, which shows the same trust dialog as a local load
  and then records it (`allowUnlisted`). A record whose directory lies outside Studio storage is
  force-disabled at startup with an error naming the reason. Dropping a folder into the packages
  directory therefore changes nothing until a person allows it.

Records name packages by absolute path. One saved before the data folder was renamed or copied
(the AI Game Studio → Genex migration) names `<old folder>/packages/<id>/<copy>`; startup reads
it as the same copy under the current storage and never reads the old folder. When that copy is
gone, a bundled plugin gets a fresh copy of its seed with its on/off switch kept; any other
plugin is disabled with a "package is missing" error until it is removed and installed again.

### Removal and reinstall by recorded origin

Removal preserves plugin data, credentials and job references for a reinstall of **the same
plugin**. An id is not an identity: each record also stores the installer's identity (publisher
plus `studio`, `local`, or `github` with repo and subfolder). A package that reuses an id held by a
different identity, installed or removed, is refused unless the user answers the dialog's
**Replace plugin** title with **Replace and erase data**; the old plugin's account, saved
credential and data are then erased, never inherited. Bundled seed ids (such as `genex` and
`blender`) cannot be installed from GitHub, the index or a local folder, and neither can an id that
belongs to one of your connectors. A direct GitHub install is labelled "(not in the catalog)"; an
index entry reads "(cataloged, not audited)". For bundled plugins removal persists
an uninstall preference: the read-only seed in the application remains inert, including on
restart. Reinstall is explicit: each install record carries its **origin** (`PluginInfo.origin`,
kind `bundled`, `local` with the folder it was loaded from, `catalog` with the artifact URL and
digest, or `github` / `index` for marketplace installs), and the Plugins page's **Reinstall**
re-acquires the package from that origin. A local plugin whose folder is gone reports
"The folder this plugin was loaded from is gone; load it again"; a record with no origin asks
to be loaded again. A `github` or `index` origin re-acquires through the marketplace: the commit
**the record pins** — not whatever the index lists today — is fetched, checked, staged and scanned
again, and the trust dialog describes that staged package before anything is installed. When the
index has since moved to another commit, the dialog says so and names it, so moving is the
separate, deliberate **Update** press. Local loading and reinstallation use
`main/plugin-local-install.ts` to snapshot and scan the current folder before the trust dialog.
The dialog shows that snapshot's version, capabilities and findings; installation uses the same
bytes even if the author edits the folder while approval is open. A changed plugin ID is refused
on reinstall. Cancelling preserves the removed state and deletes the temporary snapshot.
Reinstalling a removed plugin is an **install**, not an update: the dialog is answered for the
manifest that is about to land, so a seed that has grown new capabilities or a new MCP server since
the record was written installs rather than being refused with no way forward.

Bundled seeds are inspected for explicit versioned updates, so a change to a bundled plugin's files needs a
higher `version` in its `plugin.json`: `scripts/check-plugin-versions.ts` (run by `check:static`) refuses
one that changed against where the branch left `origin/dev` without it. Existing profiles keep their pinned
version until the user chooses Update; active leases defer activation, while disabling still
blocks calls immediately. The renderer lists a seed's newer version and the index's newer release
as one set (`pluginUpdates` in `renderer/state/plugins.ts`; none for a plugin whose update already
waits for sessions): each plugin's row and page offer **Update to x**, and the sidebar's **Update
plugins** runs them one after another. A seed's update asks nothing: it is Genex's own code, shipped
inside the app the user installed (`asksBeforeInstall` in `main/plugin-local-install.ts`); an index
release goes through its own trust dialog. A removed preference suppresses the seed across Studio upgrades.
Normal updates preserve settings, protected credentials and job state. The Genex plugin adopts
`engine-homes/genex`, keeping existing allowances and unresolved jobs; remove/reinstall is not a
required upgrade step.

The registry reports every mutation through `onChange` (`PluginChange` reasons `installed`,
`updated`, `enabled`, `disabled`, `removed`, `failed`, `reloaded`); Studio forwards it to the
renderer as the UI event `plugins.changed`, which is what refreshes the plugin list, the toolbar
and the Plugins page — no polling is needed for a change to show.

## Manifest reference

| Field | Version | Meaning |
| --- | --- | --- |
| `apiVersion` | 1, 2, 3 | Supported SDK major; unrecognized versions are incompatible |
| `id`, `version`, `name`, `publisher`, `description`, `backend` | 1 | Identity, semver, display text and the backend module path |
| `capabilities` | 1 | Host services the backend may call: `settings`, `project.read`, `project.write`, `jobs` (also `events.emit`), `observe`, `credentials`, `external-auth`, `network`, (API 2) `export`, and (API 3) `native-runtime` and `game-engine` |
| `tools[]` | 1 | `{name, description, parameters}`; scalar properties only; agent-invoked as `<id>__<name>` |
| `tools[].confirmation` | 2 | 1–300 characters. The tool needs the user's consent before it runs; see the consent model below |
| `tools[].confirmationInput` | 3 | `{parameter, label}`, with `confirmation`: one of the tool's string parameters the person may edit on the card, under a one-line label of at most 60 characters; see the consent model below |
| `tools[].timeoutMs` | 3 | 1,000–540,000: the longest one call may run in the backend when that is longer than the host's 190-second ceiling (a game engine's import or export), within an agent's own call deadline |
| `tools[].host` | 3 | A program Studio runs for the tool instead of the backend; reserved for the bundled Genex plugin (see [First-party privileges](#first-party-privileges)) |
| `tools[].facts`, `tools[].makes` | 3 | The facts of the games whose sessions get the tool, and (agent tools) the facts it makes in a game's folder; see [Scope by facts](#scope-by-facts) |
| `skills[]` | 1 | Guidance for agents while the plugin is enabled: inline `{name, text}`, or (API 3) a file skill `{name, summary, file, references?}`, either (API 3) with `facts` (or the older `engines`) and `tools`; see [Skills](#skills) |
| `panels[]` | 1 | `{id, title, file, placement: settings \| project}` isolated HTML panels |
| `settings[]` | 1 | `{key, label, type, default}` host-owned standard settings |
| `actions[]` | 1 | `{name, label, confirmation?, native?}` UI-invoked backend actions; never agent tools. `native: true` marks an action that starts, quits or opens a desktop app or the browser, or writes outside the plugin's storage: a fixture profile refuses it in main before the backend runs (`unsupported-in-fixture`); any other value is refused. Sensitive names (`unlock`, `connect`, `disconnect`, `approve`, `allowance`, `enable-paid`, `publish-draft`, `publish-gallery`) must carry a `confirmation` |
| `network` | 2 | `{hosts: string[]}` (at most 32 hostnames): the hosts the backend talks to, disclosed at install and checked by the static scan |
| `toolbar[]` | 2 | Up to 4 buttons in the stage strip; see below |
| `mcpServers[]` | 2 | Up to 4 MCP servers the plugin ships, run by the host as connectors the plugin owns, each (API 3) with `facts`; see below |
| `detect[]` | 3 | Up to 8 `{fact, files, notUnder?}` rules that recognise the plugin's kinds of project by their files; see [Project facts](#project-facts) |
| `engine` | 3 | Capability `game-engine` only: `{id, label, projectFiles, fact, projectInFolder, play?, apps?, playerApps?}`, the engine the plugin declares; see [The engine declaration](#the-engine-declaration) |
| `workspace` | 3 | `{facts?, ignore?, copySkip?}`: what history and writers' copies leave out of a folder holding the plugin's facts; see [Workspace rules](#workspace-rules) |
| `assets` | 3 | `{facts?, folders, formats?}`: where the assets of a folder holding the plugin's facts live (1–8 folders inside the fact's folder or `.`, up to 32 lowercase extensions without the dot) |
| `workerTypes[]` | 3 | Up to 16 `{id, description, tools, isolation}`: the kinds of worker a lead may start while the plugin is on; see [Worker types](#worker-types) |
| `scaffolds[]` | 3 | Up to 8 `{id, label, tool?, game?, facts?}`: the kinds of project the plugin's tools make, each with its own label; see [Scaffolds](#scaffolds) |
| `folders[]` | 3 | Up to 8 `{path, why}`: folders outside the game the plugin's engine programs write to, workers' write roots; see [Folders](#folders) |
| `locks[]` | 3 | Up to 8 `{id, label, per, personFirst?}`: what one holder at a time may use, giving way to the person; see [Locks](#locks-the-person-comes-first) |
| `tools[].needs`, `mcpServers[].needs` | 3 | 1–4 of the manifest's lock ids a call of the tool, or of the connector's tools, holds while it runs; see [Locks](#locks-the-person-comes-first) |
| `hooks[]` | 3 | Up to 32 `{on, tool, facts?, messages?}`: the plugin's harness tools Genex runs at its moments; see [Hooks](#hooks-genexs-moments) |
| `observers[]` | 3 | Up to 8 `{id, facts, tool, live?, label?}`: what Genex can capture of a project with these facts, and the Live view it shows; see [Observers](#observers) |
| `judges[]` | 3 | Beside `engine` only: up to 8 `{id, label, facts?, brief, players?, probe?}`, blind judges that play the engine's games in its editor; see [Judges](#judges) |
| `tools[].ready` | 3 | Agent tools with `makes` only: the harness tool that answers whether the kind can be made now (`{ready, note}`) |
| `tools[].asset` | 3 | Agent tools only: `{kind, prompt?, tool?}`, the kind of asset a call makes; see [Assets being made](#assets-being-made) |
| `icon` | any | The plugin's picture: a `.png`, `.jpg`, `.webp` or `.svg` file in the package, at most 512 KiB, square and full-bleed (Studio rounds the corners); see [Icons](#icons) |

### Icons

A plugin's picture shows on its row, its page and the composer's Add menu, the way an app shows
in the Dock; without one Studio shows the plugin's initial on a quiet tile. `inspectPackage`
refuses an `icon` that is missing, a link, over 512 KiB, or not the picture its extension says
(bitmaps by magic bytes, SVG by its root element). The host serves it only as an image at
`studio-plugin://<id>/.icon` (`nosniff`, a CSP that runs nothing), for a plugin that is on, off or
waiting to be allowed; `PluginInfo.iconUrl` names it. A bundled plugin installed before its seed
shipped an icon shows the seed's. The scan reads a declared icon that is the picture it says as a
picture (no finding); any other image file stays `not-scanned`.

An MCP server's own name and picture come from its `initialize` answer (`serverInfo.title` and
`serverInfo.icons`, MCP 2025-11-25) once it connects: the registry keeps the title and the
dark-theme icon (else one for any theme), a `data:` icon only when its bytes are that picture and
an `https:` one fetched once in main (10 s, 256 KiB, sniffed, never off https), and hands the
renderer a `data:` URL on `McpConnectorView.title` / `.icon`. A plugin's own server that sends none
wears its plugin's icon on the plugin's page.

### Skills

A skill is guidance for agents, contributed while the plugin is enabled and withdrawn the moment
it is not. Studio serves it from the installed package and never writes it into a game folder
(no `.claude`, `.agents` or `AGENTS.md`).

- **Inline** `{name, text}` (API 1): every builder brief carries the whole text after a
  `[<plugin>/<name>]` line.
- **File** `{name, summary, file, references?}` (API 3): `file` and each reference are
  package-relative `.md` paths with no `..` and no dot-leading segment (packing leaves dot files
  out). The brief carries one index line, `[<plugin>/<name>] <summary> Read it with
  <plugin>__skill {"name":"<name>"} before that work.`, and the agent reads the body on demand.
  Run planning sees the same index, naming the tool (`readWith`), never the body.
- **Facts and tools** (API 3, either kind): `facts` limits the skill to the briefs of games that
  hold one of those facts, and `tools` (1–16 of the plugin's own agent tools) keeps it only while
  one of them reaches the session too ([Scope by facts](#scope-by-facts)). `engines`, a non-empty
  list of `GameEngine` values (`web`, `unreal`) each named once, is the older spelling: `web`
  reads as `web-game` and `unreal` as `unreal-project` (`skillScope`); `facts` wins when both are
  given. Without either a skill reaches every game. A Unity or Godot game's web export in `web/`
  is its engine's build, so a skill reaches the game through it for no fact
  (`withoutEngineWebVersion`). The bundled Local Blender skill (GLTFLoader)
  and Genex's three.js multiplayer, embed sign-in, publishing, play-time model and shop skills say
  `["web"]`; the Unreal editor skill names `unreal-project` and its three editor tools. API 1 and
  2 ignore the keys.

**The `<plugin>__skill` tool.** A plugin with a file skill gets a synthetic tool, `<plugin>__skill`
(`name`, optional `file`, optional `offset`), answered by the host and never by the backend; such a
manifest may not declare its own tool named `skill`. It reads only a file the skill lists, spelled
exactly as listed, through an opened handle that refuses links and oversized files, and answers
`{plugin, skill, file, references, text, offset, nextOffset?}` in pages of 24,000 characters. It
answers only while the plugin is live, checked again after the read, and writes nothing. The Skills
page reads the same files over `studio:plugins.skill`, for disabled plugins too.

**Caps** (`LIMIT` in `substrate/plugins/manifest.ts`, checked by the validator and `inspectPackage`):

| Limit | Value |
| --- | --- |
| Skills per plugin | 32, unique names (API 1–2: a repeated name is dropped) |
| Inline text | 1–16,000 characters (API 1–2: 0–16,000, other keys ignored) |
| Summary | 1–300 characters |
| References per skill | 16, distinct, never the skill's own file |
| One skill file | 128 KiB, a plain file inside the package |
| All skill files together | 1 MiB |

An installed plugin that fails a cap after an app update stays installed, disabled, with its error.

**Changes.** The static scan records one sha256 per skill (`skillDigests`: the inline text, or the
file with its references). An update or hot reload compares the old and new skills and reports
them as `PluginChange.skills` and `PluginInfo.lastSkillChange` (`added`, `changed`, `removed`),
which the plugin's page shows. The trust dialog lists the skills, marks each new or changed one
and names each removed one; digest changes count only for scanned packages, so a bundled update
is compared by manifest.
Each builder brief is built from one registry `snapshot(engine)`, so its tools and skill lines agree;
`engine` is the game's (`studio.json` `engine`, read by the delegation before it takes the plugin
lease, and by the capability facts a session without plugin tools reads), the web's when no game
is named. The tools are the same for every engine. A session with host tools also reads, beside the
skill lines, one line for each plugin it is handed: its name, the prefix of its tools (`<id>__`)
when it has any, and its description on one line, cut at 200 characters (`handedPluginsNote`). A
plugin that declares an `account` whose state (`PluginAccountState`) is anything but `unlocked`
adds that it is not set up yet and the person still has to connect its account on its page.
The plugins and skills a session was handed ride its `tool_registry_applied` event; a resumed
session that has since lost some is told first to ignore their earlier instructions and not to call
their tools, and one handed a plugin it was not handed before is told first, once, that it was
turned on and its tools are there now (`addedNotice`). A new session, or one with nothing recorded,
gets no such notice: the list names what is on (`delegation-prompts.ts`).

### Toolbar contributions

```json
"toolbar": [{
  "id": "demo", "label": "Example", "ariaLabel": "Example plugin demo", "icon": "★",
  "requiresProject": false,
  "target": { "kind": "panel", "id": "demo" },
  "status": "count"
}]
```

- `id` unique within the plugin; `label` 1–24 characters, not one of Studio's reserved labels
  (`Retry`, `Ready`, `Live`, `Builds`, `Assets`, `Export`, `Plugins`, `Reload`, `State`,
  `Close plugins`, compared case-insensitively); `ariaLabel` 1–60 characters, unique, not reserved;
  `icon` a glyph of at most 4 characters or a host icon (`globe`, `export`, `play`, `image`, `box`,
  `boxes`, `unreal`, `godot`, `unity`).
- `target` is either `{kind: "action", name, args?}` naming a declared action (scalar args, at
  most 16 keys) — pressed, it runs the same review → ticket → native approval sequence as the
  Plugins page — or `{kind: "panel", id}` naming a declared panel, which opens as a dialog over
  the stage (`role="dialog"`, titled with the panel's own visible `data-panel-head` heading, else
  the panel title; one scroll, the frame as tall as the panel); the native game view is hidden while
  it is open.
- `requiresProject` (default `true`) hides the button until a game is loaded.
- `facts` (API 3, 1–8 fact ids) shows the button only on a game served by one of them (an
  engine's project); absent, every game. An engine plugin's button always names them and an `icon`,
  and its panel follows [Engine panels](../design/genex/README.md#engine-panels). Out of its facts the button is still
  asked for its status and shows while that status says `shown: true` (its chat chose the engine
  before the project exists); `visibleToolbarEntries` in `shared/plugin-toolbar.ts` decides.
- Buttons render as `button[data-plugin-toolbar="<plugin>:<item>"]` immediately after the
  Live/Builds group, for enabled installed plugins only; a disabled, removed or not-enabled plugin
  contributes nothing.

**Status.** `status` names a declared action **without** confirmation. Studio calls it with no
arguments (and the current project binding) when the toolbar mounts, on every `plugins.changed`,
debounced to once per second, whenever the open game's own record changes (`game.changed` without a
file, as a link to an engine project does), when a turn of the open game's chat finishes
(`delegation.finished`), and every 30 s while a project is open; switching games
clears the old game's words at once. Status batches run sequentially; events during a pending
batch coalesce into one follow-up, and unmounting drops late answers and scheduled work. It returns a
`PluginToolbarStatus` — `{badge?, disabled?, title?, tone?: ok | warn | err | info, attention?, dot?, shown?}`
— sanitized by `toolbarStatusFrom` (badge ≤ 16 characters, title ≤ 120, unknown tones dropped,
`attention`, `dot` and `shown` booleans). The badge is a word in its tone, or with `dot` a 6 px dot in it
(green, amber, red, grey) whose word leads the tooltip. The title shows in the strip's own tooltip.
A button is drawn in the prompt bar's quiet pill fill, or in the accent while its status sets
`attention` (the action is due) and the game is not empty; Genex's Publish uses only `title` and
`attention`, in Play's blue (its tint, filled once due). Buttons keep their labels at every width:
while the strip is too narrow for them, they move to a second row under it. An offered update's Update badge is always a word in the quiet tone. A backend can also
push a status without being asked through `events.emit` with
`{kind: "toolbar", item, badge, tone, title, attention, dot}`; the renderer applies it to that item,
or re-asks the status action when the item is not named.

### MCP servers

A plugin can hand Studio an MCP server to run. It becomes a **connector the plugin owns**: published
when the plugin is enabled, withdrawn the moment it is disabled, updated, removed or cancelled, held
in memory and never written to Studio's own `engine-homes/mcp/connectors.json`, and trusted by the
install dialog the user already answered rather than by the connector trust dialog a typed-in
connector needs. Its tools reach Claude Code, Codex and the local harness as
`<pluginId>-<serverId>__<tool>` — the same `liveTools` channel the plugin's own tools ride — and the
Plugins → MCP servers lists it read-only, as `<Plugin name> · <serverId>`, with an action to open its plugin detail page.

```json
"mcpServers": [{
  "id": "scenes",
  "transport": "stdio",
  "command": "node",
  "args": ["server.mjs", "--quiet"],
  "cwd": "storage:project",
  "env": {
    "SCENES_ENDPOINT": "setting:endpoint",
    "SCENES_CREDENTIAL_FILE": "credential-file"
  },
  "requires": { "credential": true, "settings": ["endpoint"] },
  "toolPolicy": { "deny": ["delete_everything"] },
  "maxTools": 16,
  "callTimeoutMs": 900000,
  "description": "What this server is for, and what a user must set up before it works."
}]
```

**Grammar.** At most 4 servers, `apiVersion: 2` only (`mcpServers requires apiVersion 2` otherwise).
`id` is unique within the plugin, lowercase letters, digits and dashes, no `_` (the `__` in a tool
name has to stay unambiguous) and short enough that `<pluginId>-<id>` still fits a connector id.
`transport` is `stdio`. `command` is `node` — Studio runs it as `process.execPath` with
`ELECTRON_RUN_AS_NODE=1`, because a packaged app has no `node` on its PATH — and `args[0]` is a script
**inside your package**, checked by the same containment rule an install uses. (`host-cli` runs a
program Studio itself ships and is reserved for the bundled Genex plugin.) `cwd` is `storage` or
`storage:project`, never the package, which an update replaces and a remove deletes; `HOME` (and on
Windows `USERPROFILE`, `APPDATA` and `LOCALAPPDATA`) is set to a folder inside whichever you pick, so
a CLI that reads dotfiles on startup cannot reach the user's.
`description` is required, 1–4000 characters, and rides along in the prompt guidance. `toolPolicy`
(deny wins) and `maxTools` keep an enthusiastic server out of every prompt's tool list; Studio caps a
connector at 64 tools regardless. `reads` (API 3, up to 64 distinct raw tool names) are the tools
that only read, listing or describing what the server offers: they run with no card in any mode, as
a file read does (a local plugin's still ask every call). `callTimeoutMs` is 1 000–1 800 000. `facts` (API 3) limits the
server to the sessions of games that hold one of those facts: for any other game it is not listed and
never started (the harness's `mcp.invoke` included), and a session's call to a connector it was not
handed is refused as an unknown tool before anyone is asked. Unknown keys are dropped and the section is canonicalised in a fixed key
order like the rest of the manifest.

**`env` names sources, never values.** `setting:<key>` must name a declared setting; `literal:<value>`
is a constant; `credential-file` needs the `credentials` capability. The plugin's one credential
travels down an anonymous pipe on **file descriptor 3**, read at the moment the child starts, never
in argv, never in the environment, never as a file on disk. For a `node` server the variable is set
to `/dev/fd/3` and the pipe carries the bare token (no `NAME=` line, no newline), so
`readFileSync(process.env.MY_TOKEN_FILE, 'utf8')` at start-up is the whole contract; an empty read
means the account is locked. The `GENEX_TOKEN=` env-file line and the virtual path its preload
answers are Studio's own Genex CLI's (`host-cli`), not part of the public contract. `secret:<NAME>` is accepted by the validator and reads a value from the connector's own secret
store, but there is no UI in this version that stores one for a plugin's server, so in practice it
resolves to nothing: use `setting:<key>` for anything the user has to type. The child's environment
is `PATH`, `HOME`, `TMPDIR`, `LANG` and what the manifest asked for, plus — for a server that does
not use the credential pipe, which is spawned by the MCP SDK's own transport — the SDK's small
default-inheritance set, `LOGNAME`, `SHELL`, `TERM` and `USER`. Nothing else of Studio's.

**`requires` is a gate, not a hint.** `credential: true` means the server is not started until the
user has explicitly run the plugin's `unlock` action — and a plugin locked or disconnected since it
was published gets an empty pipe rather than a live token. `settings` names settings that must be
filled in. A server whose requirements are not met is still listed, switched off, with the reason on
it: something to finish, not something to hide.

**Trust and updates.** The server is trusted native code in a child process — crash isolation, not an
OS sandbox — and the install dialog says so, naming each server and marking the ones that are new or
changed since the installed version. Changing what a server runs, where it runs or what it is handed
is a **permission expansion**: an *update* that was never shown to anybody is refused with
`Permission expansion requires confirmation`, exactly as a new capability is. Reinstalling a plugin
the user removed is an install, not an update — the dialog has just been answered for the manifest
that is about to land — so the gate does not stand in front of it. A hot reload of a watched folder
is refused the same way when its `mcpServers` or `network.hosts` differ from the installed manifest
(`MCP servers changed; load the folder again to review`); load the folder again to see the dialog.

**The bundled example.** Genex declares `creator` and optional `blender`. `creator` runs the
self-contained `creator-mcp.mjs` package over stdio, forwarding to the fixed HTTPS endpoint
`https://mcp.genex.games/mcp`. It requires the same unlocked credential, delivered on fd 3;
there is no separate OAuth grant, endpoint setting or CLI installation. Its allowlist exposes
`search_games`, `search_animations`, `my_games` and `generation_status`. Both listing and direct
calls enforce it, including against future upstream tools. Redirects are refused. Remote creation,
setup instructions, credits and publishing are replaced by the existing `genex__asset` and
`genex__publish` tools, preserving local delivery, Unlimited entitlement and publishing consent.
The bridge is bundled with its dependencies and exits when its host pipe closes.

`blender` is published as the connector
`genex-blender`: `host-cli` with `args: ["blender", "mcp", "--api-url", …]`, `cwd: "storage:project"`,
`GENEX_BLENDER_URL` from the `blender-url` setting, `GENEX_API_URL` as a literal (the same API base
the asset adapter spawns the CLI with), `GENEX_ENV_FILE` as `credential-file`,
`requires: {credential: true, settings: ["blender-url"]}` and `blender_export_glb` denied, because
that tool writes to a caller-supplied absolute path; finished models reach a game through the
contained asset tools. The endpoint is a requirement rather than a preference because without one
the CLI can list tools that only answer with a setup hint. The independent Local Blender plugin
remains available alongside a ready remote connector. Local jobs start from an empty scene;
a remote server may retain its scene. The agent follows each source's registered guidance and
must not silently switch from a local job to a paid service.

**Unreal Editor.** The bundled `unreal` plugin is off until the user turns it on. Its one server,
`editor` (connector `unreal-editor`), runs `editor-mcp.mjs` (`src/plugins/unreal/editor-mcp.ts`)
against Epic's experimental Unreal MCP in the user's own editor, at `http://127.0.0.1:<port>/mcp`.
There is no port setting. The host runs one bridge per game in `<plugin storage>/mcp/<game>`
(manifest cwd `storage:project`; `_shared` for a call with no game), and for every call it reads
the game's link (`links/<game>.json`), the project chosen in the panel (`chosen.json`) and the
set-up projects with their ports (`setup/*/record.json`) in that storage. A linked game's calls go
only to its own project's editor; an unlinked game's go to the project chosen in the panel. A chosen project that is closed gets a
message naming it and, when another set-up project's editor answers, naming that one as open
instead. A chosen project Genex is starting (the toolbar's Starting: its `starting.json` record, a
running editor and the project's own log) is asked again every 2 s for up to 150 s, then called;
past that the agent reads "Unreal is still starting <Name>. Call again in a minute." The wait
comes out of the call's own five minutes, inside the host's 330 s. One whose own log says Epic's
server couldn't listen on its port gets that message at once. A chosen project that isn't set up
gets a message naming its file and `unreal__use-project` (which sets it up and links it), and no
editor is asked. Only with nothing chosen does the bridge use the first set-up project whose editor
answers. Each answer ends with `[Unreal project: <Name>]`. "Answering" means Epic's own server
completes an MCP `initialize` on the project's port: an empty `serverInfo.name` (UE 5.8.3 never
fills it, where other MCP apps name themselves) with both the `resources` and `tools`
capabilities. Nothing else counts, so another app's MCP server on the port is never taken for
Unreal. Epic's answer names no project, so the bridge and the status also ask the Genex editor
helper's `project_file` which project the editor has open, and use the editor only when it names
this project's real `.uproject`; another project's editor on the port gets no call and never
shows Connected. Epic sends that tool's answer as an event stream it keeps open for about 15 s
after the answer, so the check reads up to the first event and closes it. The panel and toolbar status remember a project's last good answer for 10 s:
while it stands they say yes at once and ask the editor again in the background, so status stays
fast with Unreal behind another app and one stalled request doesn't flip Connected; a failed ask
is never remembered, so a stopped editor reads as not answering one refresh later. A record whose
port lies outside Genex's block (Epic's 8000, from before ports moved
there) is not trusted until the project is set up again.

The bridge lists Epic's three meta-tools itself
(`list_toolsets`, `describe_toolset`, `call_tool`; the first two declared `reads`, so only
`call_tool` asks, and not in Auto), so they are there before the editor opens, and
opens one editor session per call, so a restarted editor answers the next call and nothing is
sent twice. While a call waits, the bridge reads the editor's log every second, so a call fails
within seconds when Unreal crashes ("Unreal crashed while this call ran (<Unreal's own text>), so
whether it took effect is unknown. Ask the user to reopen it from the Unreal button; once it
answers, look before you repeat the call.") instead of waiting out its timeout. That answer, and the
one for a call whose connection to the editor broke, carry `_meta: {"genex/outcome": "unknown"}`, so
Studio records the call as outcome unknown (below). A call that ran out of time says its outcome is
unknown but stays unmarked (the editor may still be running it); so do an answer refused before any
editor was reached, a JSON-RPC error the editor sent back (invalid params, its own internal error)
and a failure after the editor answered. It reaches only that endpoint and refuses redirects.
An agent's `call_tool` or `describe_toolset` that names the helper's Loop toolset
(`genex_loop.tools.GenexLoopTools`, below) is refused before any editor is reached, however it is
spelled: any case, whitespace or zero-width characters, the module or class alone, behind a prefix,
or qualified in `tool_name` with no toolset. Only Genex's own queue calls it. Epic answers pictures
(`CaptureEditorImage`, `CaptureViewport`, `CaptureAssetImage`) as base64 inside the JSON text,
which Studio would truncate, so the bridge hands up to four per answer to the agent as MCP images.
The Genex editor helper's build and play tools (below) answer a refusal or a failure as `{error}`
inside a call Epic counts as done, so the bridge marks such an answer `isError` (the toolset named
short or qualified, in any case): the agent and the chat read it as a failed call, in the helper's
own words. An `error` field in any other toolset's answer stays as Epic sent it.
Some of Epic's toolsets describe themselves in more than an engine takes from one tool answer
(Niagara's system toolset in about 278 KB, past Claude Code's 25,000 tokens), so a
`describe_toolset` answer over 60,000 characters comes back as its tools by name, each with the
first line of its description (by name alone when those are too long), with a note; the bridge's
own `tool_name` argument, never sent to Epic, returns one tool's whole entry, and the chat shows that
call as reading the toolset. A description whose tools it can't find, and anything still too long,
is cut at the limit without splitting a character (`editor-describe.ts`). Shorter answers and Epic's
errors stay as Epic sent them.
An editor behind Genex runs at 3 frames per second while Unreal's "Use Less CPU when in
Background" (`bThrottleCPUWhenNotForeground`) is on. To avoid that, a `StartPIE` call first turns
the setting off through Epic's `ObjectTools.set_properties`. This changes only the running editor
and never its saved settings. The bridge turns the setting back on when the agent calls `StopPIE`,
when the start is refused and when the bridge itself closes. If the user had already turned it
off, the bridge leaves it alone. A minimized editor is still throttled. Epic's server checks only the `Origin` header: any local process can reach it. What a call
changes in the editor is in the game's checkpoints only when the project lies inside the game
folder (New game puts it in `unreal/`); a project elsewhere is not.

Epic's toolsets cannot press the player's buttons, so the plugin also ships the **Genex editor
helper** (`src/plugins/unreal/GenexEditorHelper`), a Python-only plugin for Unreal itself (a
`.uplugin` folder), so nothing compiles. Setup copies it into a project's `Plugins/` folder.
Because it is enabled by default, Unreal loads it without a `.uproject` entry. Its `init_unreal.py` then registers the toolset `genex_play.tools.GenexPlayTools`, which
Epic's server lists:
- `project_file` names the project the editor has open (the bridge's check above).
- `list_actions` lists the game's controls.
- `hold` presses an input action or a key for a time and returns at once.
- `player_state` reads where the pawn is and how fast it moves, and the latest settle and drive.
- `release_all` lets go of everything held, and ends a settle or a drive.
- `settle` watches the pawn come to rest (moving under 20 cm/s with its height steady) and returns
  at once.
- `drive_route` holds the throttle and steers the pawn along the game's route (the spline tagged
  `GenexRoute`) and returns at once.
- `probe_route` measures the pawn against the route: how far its facing and position are off it,
  and how far along it is.

The input goes through Enhanced Input's own `Input.+action` / `Input.+key` console commands.
These find the player's subsystem from its player controller, which Python cannot do reliably.

The helper also registers the build toolset `genex_build.tools.GenexBuildTools`, an agent's
hands and eyes in the editor. `run_script {file, args_json}` runs a plain `.py` of the game's
`unreal/build/` (found by real path, no link on the way, at most 256 KB) with the full `unreal`
module and the `gx` library, in one undo step with a 240 s timeout, and answers its output, result
and the scopes it changed, or the file and line it failed at (a run that changed a level with
navigation bounds rebuilds its nav mesh, so no AI stands on a stale one). A material Unreal fails to
compile while the script runs, which Unreal only warns about in its log and draws with the default
material, fails the run with `materials` (each one's `/Game/` path, base and reasons) when the run
changed it (unsaved, or saved since it began; others compiling meanwhile are only named, as
`otherMaterials`), read from what the editor log gained meanwhile (`genex_loop/editor_log.py`, `genex_build/compile_log.py`); `gx.scope` makes a script idempotent,
and `gx` places instanced meshes, bevelled Nanite kit pieces, world-aligned materials, an
atmosphere preset (`megastructure`, `daylight`), lights and hero cameras (`GX_Shot_<name>`).
`import_model {file, dest, name, collision, nanite}` combines a model file of the game's assets into
one static mesh in `<dest>/<name>/`; `import_character`, `import_animation` (with its `skeleton`),
`import_sound`, `attach_to_socket` and `audit` do what their names say, and no import
opens the Content Browser. Imports and retargets refuse during play, where Unreal makes only part of
an asset (a Skeleton with no mesh) and says so only in its log. A `.glb` character or clip whose
skeleton hangs under a scaled root (a centimetre Armature at 0.01, the root joint's own scale
counted; a clip file with no skin by the shallowest node it animates) is imported from a copy with
that scale baked in (`genex_build/rig_math.py`: bones and their clip keys rescaled, inverse bind
matrices premultiplied, so every bone and skinned vertex stays put), written under the project's
`Saved/Genex/imports/`, and answers `skeletonScale`; a file the bake can't take exactly (a scale that
differs by axis, a rigid mesh under the scaled node, keys outside the file's own buffer) is imported
as it is with `scaleWarning`. Importing again into a folder that already holds an import doesn't
import over it (Unreal's importer then imports nothing): the same file, unchanged, answers the
first import's answer again (`reused`), so a build script that imports can run again, and any other
file is refused, naming the folder and a new name to use (`Saved/Genex/imports/records.json` keeps
which file each folder holds). `retarget` sets an auto-rigged character up on 5.8 so its arms point as
the mannequin's do: an IK Rig per mesh by auto-characterisation and auto
full-body IK, its Spine chain started at the lowest spine bone (the template an auto-rig matches maps
only the top one); an IK Retargeter with the default op stack alone (Run IK Rig does the deprecated
IK chains op's work; a Copy Base Pose op adds nothing on such a rig), every op on the target's
rig, chains mapped by exact name and then by fuzzy name, FK chains One to One on the arms and legs,
IK off on the arms; the retarget pose reset and auto-aligned chain to chain (mesh to mesh leaves
the arms further off), each target upper arm and forearm turned to the direction of the source's (bent bind
elbows otherwise stay 25° or more off), and the finger chains aligned again; then
`run_batch_retarget`. It answers `fbik`, `spineFrom`, `oneToOne`, `ikOff`, `armFixDeg` and, as Unreal
made the first new clip, `limbErrorDeg` (each limb against its source clip's, a warning past 20°). `character_check {mesh,
idle, walk, driver, pictures}` measures a rigged character (a mesh path or a level actor's label)
standing and walking, from its clips by Unreal's AnimPose evaluation with no play session: each
upper arm's angle out from the body, each hand's distance from its thigh, width against height,
feet against the ground, the most any mesh edge at least 5 cm long posed stretches against the bind
pose (Geometry Script's copy of the mesh, skinned in Python; a fold at a joint stays shorter), finger bones and their motion and, with a `driver`, each
limb's angle from the driver's at the same frame. The thresholds are named constants in
`genex_build/character_math.py`; the answer is `passed` with its `reasons` and `warnings`. With
`pictures`, a temporary copy of the character at the level's PlayerStart is shot from the front,
side and back in idle and from the side through the walk, then removed; the bridge shows the shots
as one sheet. The eyes: `capture_shot {camera, width, height, delay_s}` (a still from a
hero camera, no play needed), `capture_play` (the player's 3D view during play, through the player's
console `HighResShot`, which leaves out on-screen UI), `motion_strip` (frames scheduled by the game clock, one at a time, each with
the pawn's and view's position) and `shot_cameras` (the hero cameras' labels). The bridge waits for
a capture's file and hands the agent the picture itself, with its tone numbers (black point,
contrast, near against far contrast, saturation; a nearly black frame is called out as a render to
doubt) and the frame rate (`editor-captures.ts`, `tone.ts`); a strip and a character sheet come back as one contact sheet. `attach_mesh` puts a static mesh on a
Blueprint's component, and `set_route` (the route the play checks drive), `track_terrain` along it
and `dirt_material` serve racing games. The plugin's skill (`unreal-editor`) tells every agent to
look with these eyes, never `CaptureEditorImage` (the whole editor window) or `CaptureViewport` (the
editor camera), and the lead's brief says the same. It also asks for a review of every character,
up close and moving (`character_check` and its sheet, then a look in play), before it goes into the
game or a save point claims one: a whole body, five-fingered hands, arms at its sides, nothing
tearing between the legs, textures in play. What is wrong is fixed where it is (Blender for the rig,
finger bones and weights, Unreal for materials and the retarget), and a character is regenerated only
as a last resort. The character sub-agent's brief says the same. It also asks for foliage and props
that match the reference's biome.

**Motion Matching** (plugin 0.11.0). Epic's Game Animation Sample can't ship with Genex (Fab content
for Unreal projects, not Genex's to hand on): the person gets it once, and `motion-status` finds it
among their Unreal projects (`~/Documents/Unreal Projects/*/Content/Blueprints/SandboxCharacter_CMC`
beside a showcase character no game gets) and says whether the game holds its content.
`add-motion-matching` (asks the person first, holds the `editor` lock, one job per project,
`motion-tools.ts`) refuses a game with a file where the sample's go, a link where its folders go, a
config it can't read, a first custom trace channel that is another's (the sample's traversal traces
on it as `Traversable`), or without the disk; then saves and quits Unreal, looks again, clones the sample's
`Blueprints`, `Characters/UEFN_Mannequin` and `UE5_Mannequins`, `Input`, `Audio`, `Widgets`, `Misc`
and `Levels/LevelPrototyping` into the game's Content (`cp -c` on a Mac: a clone shares the
sample's blocks; its showcase characters left out), merges the settings the game lacks
(`motion-config.ts`: the channel, data-driven and plain console variables, gameplay tags, network
prediction), turns on the sample's plugins and opens Unreal again. Before the copy, the game's
`.gitignore` gets what the copy adds (each folder it makes, or a file it puts in a folder the game
already has), so the sample's gigabytes stay out of checkpoints and worker copies while the game's
own folders stay in; the sample's own files, `ABP_GenericRetarget`'s map included, are not in
checkpoints. A step that fails takes the copy back out and puts the config files, the `.uproject`
and the `.gitignore` back as they were. The helper's `motion_character {mesh, name}` (`genex_build/motion.py`)
then moves a character the sample's way: a retargeter from the sample's UEFN mannequin set up as
`retarget` sets one, its entry (tag: the retargeter's name) in `ABP_GenericRetarget`'s
`IKRetargeter_Map`, and `BP_<name>`, a child of `SandboxCharacter_CMC` whose mannequin mesh is hidden
but still poses and whose `Body` mesh shows the character with that ABP and tag. No clip is copied.

The helper offers no tool that derives normal and roughness maps from a base-colour texture's
luminance: Unreal's Python has no image library, so it would hold the editor for many seconds per
texture, and relief guessed from brightness is often wrong (dark paint reads as a dent). Such maps
belong to the asset's own pipeline (PBR sets from Genex, or a bake in Blender); a map imported
with the wrong colour space now fails the `run_script` that uses it, with Unreal's reason.

The helper's second toolset, `genex_loop.tools.GenexLoopTools`, is Genex's own (agents are
refused it): the part tools of the earlier Unreal Loop and the editor queue the harness's tools
use (every parameter is passed: Unreal's schema marks even the defaulted ones required). A part lives in
the game folder as `unreal/parts/<Part>/`: `part.json` (its title, goal, the C++ classes it defines
as `cpp`, UCLASS names without the A or U prefix, at most 12, and the Blueprints it owns, with their
base class or one of those classes as `parent`, components, variables and functions), one
`<Blueprint>.dsl` per graph text,
`apply.py` (placing and tuning, through the helper's `genex` module) and `test.json` (`hold`,
`wait`, `shot`, `expect`, `settle` and `drive` steps; `expect` reads an actor, a whole `genex:` tag
or a player field). `apply_part` builds the declared Blueprints in one undo step,
compiles them and runs `apply.py` only when all compile; the part owns `/Game/Parts/<Part>/` and the
actors tagged `GenexPart:<Part>`, which `rollback_part` deletes. `genex.import_model(path, name)`,
`import_sound` and `import_texture` import a plain file of the game folder, given relative to it and
reached through no link (a `.glb`, `.gltf`, `.fbx` or `.obj` up to 100 MB; a `.wav`, `.png`, `.jpg`
or `.jpeg` up to 20 MB), into `/Game/Parts/<Part>/Imported/<name>/` and answer the static mesh,
SoundWave or Texture2D to place: another file is refused before Unreal imports, a model that makes
several meshes after. `capture_play` writes a game-view PNG under `Saved/Genex/captures/`. Two read-only probes measure during play what a shot can hide:
`probe_characters` traces each pawn's bottom (a character's capsule and visible feet) to the ground
and compares its facing with its velocity (a vehicle also reports its wheels on the ground), and
`probe_view` checks the player's own meshes (the view target's and what is attached to it, drawn
with Unreal's first-person scale) against the camera's near clip plane and audits the active
post-process volumes and camera settings, flagging extreme values, such as a pawn floating
40 cm. `export_project`
writes the template's facts to `Saved/Genex/project.json`: the level, the game mode (the level's
override, else the project default) and the pawn it spawns, the project's Blueprints outside
`/Game/Parts` (native parent, components, variables; at most 200, the rest counted in `more`) and the
input actions. `recompile_module {module, classes}` hot-reloads the game's C++ module
(`Module Recompile`, 11 to 19 s, refused during play): it answers `ok` only when a new
`libUnrealEditor-<Module>-<n>.dylib` appeared, the reload logged no `<Category>: Error:` line and
every class loads, with up to 20 compiler and hot-reload lines from the editor's log written during
the call (none when the log shrank), project paths from `Source/` on and the home folder as `~`.
`save_all` saves every unsaved level and asset without asking and names what is still unsaved.
`stop_play`, `play_state`,
`game_state`, `editor_activity`, `reload_level`, `import_asset`, `list_assets`, `export_reference`
and `export_python_names` do what their names say. The plugin's own tools sit on top: `check-part`
(the builders' gate, no editor: part.json, the Blueprint text against the engine's node reference,
the other parts' and the template's exported Blueprints, `apply.py` parsed by Unreal's Python with
its `genex.` and `unreal.` names checked, the test), `run-part` (queues a part that passes and answers at once),
`part-result` (its state, then its shots, checks and `probes`), `rollback-part`, `reload-level`,
`find-nodes` (the reference's nodes and the template Blueprints' casts and members) and
`export-reference` (keeps the node reference and Python names per engine in the plugin's storage,
then asks for `project.json`; that call failing fails nothing). Of the part tools the Unreal lead
still uses `export-reference`, `part-result` (its play-check fallback) and `check-part` (its C++
sub-agents check their folder as a part); `run-part`, `rollback-part`, `reload-level`,
`blueprint-guide` and `find-nodes` have no caller in the seed now. The harness's tools
(`run-part`, `part-result`, `rollback-part`, `reload-level`, `export-reference`, `reopen-editor`,
`editor-state`, `play-check`, `save-all`, `log-errors`, `end-editor`, `update-helper`,
`editor-activity`, `hero-shots`, `open-for-run`, `wait-editor`, `engine-status`) are
`"audience": "harness"`: no chat, builder or plan sees them, the harness calls them through
`plugins.invoke` as its own steps (`step: true`), and they write no `plugin_tool` records. An agent
that names one on any path is refused (`Unknown tool`) before anything runs, and the registry runs
one only for the harness (`PluginRegistry.tool`'s `caller`). `cpp-status` and `add-cpp-module` are
agent tools for an `unreal-project` (`facts`), which the one Loop's lead calls; `add-cpp-module`
asks the person first (its `confirmation`) and holds the `editor` lock. While its job restarts
Unreal, `editor-state` reads as reopening, so Genex's health watch waits and a crash step starts no
second editor or build (`editor-reopen.ts` `createReopenTools`). A step runs while the chat is in
Plan mode unless it writes (`checkpoint: true`), which waits. A held write answers the Unreal
runner behind its switch the Plan answer (`blocker: "plan_mode"`, `PluginCallBlocker`), which
`loop/unreal/lead-steps.ts` turns into a refusal. The seed calls no other Unreal tool by name: a
chat turn's end save is Genex's checkpoint and its wait after a kind change Genex's `health`
([a game's engine](#a-games-engine)). A harness workspace that kept an agent-edited copy of
`loop/delegated-turn.ts` from before the chat's checkpoint still saves by name; the seed upgrade
reports such a copy and notes it in the agent's memory ([harness runtime](harness-runtime.md)). The
runner makes its calls from `lead-steps.ts`, new with `step`, so a kept older `lead-journal.ts` is
reported as a move instead. The queue takes one part at a time,
waits while Unreal doesn't answer (failing the part at once when the project's log says Epic's
server couldn't bind its port) or the person works in the editor, runs both probes after the
test steps while the game still plays (a probe that fails is recorded as `{error}`, never failing
the part), and always stops a play session it started. Like the bridge, it plays each test with the
background throttle off: before `StartPIE` it reads the setting and turns it off when it is on, and
once play stops (also after a failed step, a play that never started or a missing shot) it writes
the old value back. A setting that is already off, or that can't be read, is left alone and the
test runs anyway. For a C++ part, `run-part` hands the queue the folder it was called on, the game's
project, its module and part.json's `cpp`; before `apply_part`, outside play, the queue copies
`unreal/Source/<Module>/Parts/<Part>/` from that folder into the project's
`Source/<Module>/Parts/<Part>/` (`landPartCpp` in `cpp-tools.ts`; nothing when it is the game's
own), then calls `recompile_module` with a 6-minute timeout. Both sides are read by real path: a
link, a file that isn't a plain `.h` or `.cpp`, a folder too deep, more than 20 files or one over
200 KB, in either folder or on the way, refuses the copy before anything is written, and only that
one folder's files are replaced. A hot reload that isn't `ok` ends the part with its log lines (paths
from `Source/` on), a missing class named, and nothing applied.

While a part applies and plays, the queue reads what the project's own log gained (every 2 s, and
twice when a call fails) and whether an editor process runs. Epic's `=== Critical error: ===`
banner, or no editor process on two looks in a row, ends the part at once, and nothing more reaches
that editor: `part-result` answers `{state: "failed", crashed: true, error: "Unreal crashed while
testing <Part>: <signal> in <frame>", crash: {signal, frames}}` (the top eight functions, no library,
path or address; the frame named is the game module's first). The runner then calls `reopen-editor`
(`editor-reopen.ts`): `{answering: true}` when Unreal answers, else `{started: true}` and a job that
ends this project's leftover editor and crash reporter only (normal quit when it is the only editor,
then `SIGTERM`, then `SIGKILL`; on Windows only the editors are listed, by WMI with their command
lines, and each is ended with its process tree; the crash reporter is looked for on a Mac only), rebuilds the game's module with
UnrealBuildTool (a hot reload leaves `UnrealEditor.modules` on a numbered library; a failed build
fails the job with its errors) and opens the project, waiting up to 5 minutes. `editor-state`
answers `{answering, running, reopening: {state: idle|reopening|done|failed, error?, seconds?},
helper}`: `running` says whether this project's editor process runs (on a Mac by its processes, a
listing with none at all reading as null; elsewhere false only when no editor runs at all), so an
editor busy on its game thread (a long script, an import, a play session's warm-up) is told apart
from a crashed one; `helper` is where the project's editor helper stands against the plugin's
(`current|outdated|newer|missing`, null without a linked project).

The lead's save points, restarts and close use the tools below. `play-check {checks}` queues a play of
the game in the same queue, applying nothing; the lead asks it for no checks, only for the shot where
play starts, and only when `hero-shots` fails (an older plugin has none; a level without hero cameras
answers none and is not played). Its checks are keyed by id, each `{tag: "genex:<name>",
exists}` or `{player, atLeast and/or atMost}`, at most 40; a bad one refuses the call, naming each,
and nothing is queued. It answers `{id}`, and `part-result` reads the run (part `play-check`). After
the owner wait (at most 3 minutes, then `failure: "owner-busy"`; Unreal never answering is
`not-answering`) and with the throttle off, it starts play, warms up, settles the pawn, probes the
characters and the route, shoots `spawn`, drives the route for 20 s with frames `drive-1`…`drive-4`,
shoots `ride`, judges every check against `game_state ''` (a tag check by its `tags`, the count of
every `genex:`-tagged actor, which holds past the 200 rows it lists), probes again and stops play. Every wait in
play (also a part test's holds and waits) counts the play world's game seconds from `play_state`, at
most four times as long plus 10 s on the clock, so a slow editor still plays the whole drive; an older
helper without a game clock gets real seconds. The result carries `fps` and `gameSeconds`.
`save-all` ends a play session first (`stop_play`, then up to 15 s for `play_state` to say it ended)
and saves through the helper. `log-errors {since?}` answers `{offset, lines, more, rotated}`:
the project log's `Error:` and `Fatal:` lines since `since` (without it, the log's end now), each once
and without its stamp or the owner's paths, at most 40 of 300 characters. Epic's and Genex's own
noise is left out (the MCP server's, online services', a toolset lookup's, an ensure's call stack).
A log Unreal started anew is read from its start as `rotated`. `end-editor` ends this project's editor
and crash reporter as the reopen job does, saving nothing, and is refused while that job runs. It
answers `{ended}` only once the game's Unreal no longer answers, asked again for up to 15 s (past the
setup's 10 s memory of a good answer, so a `reopen-editor` right after never reads a closed editor as
open), and throws when it still does. `update-helper` runs setup's `updateHelper` only while the game's Unreal doesn't answer.
`editor-activity` answers `{personActive, unsaved, pie, dirty}`: whether a play session runs and how
many packages are unsaved (the helper's `editor_activity` names them), and whether the person is
using the editor (below). With no editor of the game running, no linked project or Unreal still
opening under Genex's own start it answers that nobody is and nothing is unsaved; it throws when
Unreal runs but doesn't answer or the helper answers anything else, so no caller reads an editor it
can't see as idle. `hero-shots {prefix?, max?}` lists the level's hero cameras (the build toolset's
`shot_cameras`), takes a 960×540 still from each label starting with `prefix` (`GX_Shot_` unless
given), at most `max` (8, also the most), one at a time through
`capture_shot`, and answers `{shots: [{name, file, data, tone}]}`: the PNG as it landed in the
project's own `Saved/Genex/captures` (that folder reached through no link below the project's) and
its tone numbers. A still that never lands is left out, none is asked for after a minute, and a
level without hero cameras has none.

**The editor lock and Genex's moments** (plugin 0.7.0). The plugin declares one lock, `editor`
(label "Unreal", per game, probe `editor-activity`), which its editor connector and its harness
tools that work in the open editor need (`open-for-run`, `save-all`, `end-editor`, `reopen-editor`,
`update-helper`, `add-cpp-module`, `add-motion-matching`, `export-reference`, `hero-shots`, `play-check`, `run-part`,
`rollback-part`, `reload-level`); lookups, the gate, the probe and the readers need none. While the
person plays in the game's editor, the agents' and Genex's calls there wait. A play the agent
started is not the person's: the connector marks the agent's `StartPIE` with `agent-play.json` in
its own folder (`<storage>/mcp/<game>`, `src/plugins/unreal/agent-play.ts`), written before the
`StartPIE` reaches the editor (a refused start gives back the mark there was), cleared by its
`StopPIE`, a crash under a call or the connector closing. The probe notes each time it sees that
play running (`seenAt`) and believes a mark for 30 minutes after it was written or last seen; it
forgets one when it sees no play, but not a play nobody saw running yet within 30 s of its start.
Nor is a play the plugin's own queue is running the person's. The panel's Agents block holds the
same checkbox as Unity's, **Agents may use Unreal while you play** (on unless turned off, actions
`agents`, `agents-go-ahead`, `agents-wait`): while it is on, the probe answers that nobody is at the
person's play, with `wentAhead` the first time for each game. `new-game.ready` names `engine-status`,
which also answers `{ready, note}`: whether a new Unreal game can be made here and the engine
question's words for it. The handlers answer in hook terms when `context.hook` is set
(`editor-moments.ts`, words in `hook-answers.ts`), and the manifest hooks them, each for games with
the `unreal-project` fact: `run.prepare` → `open-for-run`, `log-errors`; `checkpoint.before` →
`save-all`, `log-errors`; `checkpoint.after` → `hero-shots`; `restore.before` → `save-all`,
`end-editor`; `restore.after` → `reopen-editor`; `health` → `editor-state`; `crash` →
`reopen-editor`. Nothing hooks `run.end`: the person's editor stays open when a run ends. Since
0.8.0 the manifest also declares its `viewport` [observer](#observers) (`hero-shots`, Live's Unreal
card) for the same games.

| Handler at its moment | In a run | In a chat |
| --- | --- | --- |
| `save-all` at `checkpoint.before` | blocks on a play, an editor that doesn't answer or can't tell, or a save that saved nothing | blocks on a play; otherwise notes what it saved or why not |
| `save-all` at `restore.before` | nothing for an editor that isn't running; waits up to 5 minutes for a busy one; blocks when it stays busy or the save fails or leaves work | same |
| `end-editor` at `restore.before` | blocks when Unreal couldn't be closed; a game with no linked project has nothing to end (`save-all` and `reopen-editor` do nothing for it either) | same |
| `reopen-editor` at `restore.after`, `crash` | starts reopening, updating an outdated helper while Unreal is closed | same, but after a restore (the person's Rewind among them) only when that restore closed a running Unreal |
| `editor-state` at `health` | quiet while it answers; pending while reopening, opening, busy or can't tell; blocks once reopening failed, its port is blocked or it is gone three asks in a row | same, gone in the chat's words |
| `log-errors` at `run.prepare`, `checkpoint.before` | marks the log's end per game; notes the new errors since | same |
| `hero-shots` at `checkpoint.after` | the stills as images, their tone as measures | nothing: no stills are taken |
| `open-for-run` at `run.prepare` | opens a closed Unreal and waits for it; updates an outdated helper once its process exits (saved first, no snapshot); exports missing template facts; blocks without a helper or when Unreal can't be opened; a Stop updates nothing after it, but an Unreal it closed for the update is still reopened (without the update), as a restore's after steps reopen what its before steps closed; its slowest path (`OPEN_FOR_RUN_MAX_MS`) stays under Genex's 33-minute ceiling for `run.prepare` | — |

Each handler's editor calls have limits its own longest path counts, each call's session with the
editor (connect, the helper's identity call and the session's end) held within its limit
(`callProjectTool`), and each ask of whether Unreal answers and runs counted too: a checkpoint's
save (`CHECKPOINT_SAVE_MAX_MS`) and `hero-shots` (`HERO_SHOTS_MAX_MS`, every wait for a still ending
with its two minutes) stay under the checkpoint step's ceiling, the save before a restore
(`RESTORE_SAVE_MAX_MS`) under the restore's.

Since 0.9.0 a Loop on an Unreal project is the one Loop ([harness runtime](harness-runtime.md)): the
chat's own session leads it in the game folder, its save points, rewinds and `restart` run the
moments above, its health watch asks `editor-state`, and `cpp-status` and `add-cpp-module` are agent
tools for Unreal projects (`add-cpp-module` asks the person first, since it saves and restarts
their editor; Plan's refusal in a planning chat as for any agent tool) that the lead calls itself;
its brief says to call `restart` after C++ changes, which
rebuilds through `reopen-editor`. The runner below runs only behind the developers' switch
(`STUDIO_UNREAL_RUNNER=lead`) until a live Unreal Loop passes on the one Loop.

That runner's Loop is one lead (the seed's `loop/unreal/lead.ts`), the only builder: a fresh session in the
game folder on the Workers role's engine and model (high effort unless the person chose one; the
chat's bookmark follows it), briefed once with the chat so far, NOTES.md, the whole goal, the
look-first checklist and the facts of the template the game is built on (`lead-prompts.ts`). It
builds through the helper's build toolset, looks with its eyes before it saves or claims anything,
and works in turns of up to 45 minutes resumed in the same session; each later turn opens with a
digest (time left, the owner's
words, the workers' news, the last save point, the critic's advice). Its run tools (`run_status`,
`save_point`, `rewind`, `milestone`, Genex's six worker tools `worker_start`, `worker_status`,
`worker_wait`, `worker_steer`, `worker_stop` and `worker_mark`, `critic`, `rebuild_unreal` (a
restart between turns: after C++ changes, or when the editor renders differently from play),
`note`, `finish`) come with the director grant and no window. `finish` is the lead's claim that the
game meets the request: Genex's `finish` moment runs first (a block keeps the lead working), then a
reviewer that did none of the work checks the claim on the game's folder and the named proof; a yes
ends the Loop, a no comes back with reasons, and three in a row stop it with what isn't done. While a turn runs
the harness looks every 15 s: the owner's words are steered at once, to be acted on now; a finished
worker's news too; a save is asked for after 15 minutes of unsaved work, and the wrap-up 12
minutes before the working deadline.

The runner names none of the plugin's moment steps: it works through Genex's moments (the seed's
`loop/hooks.ts`), and calls only the C++ module's `cpp-status` and `add-cpp-module` by name. Its
start reads the C++ status, then fires `run.prepare` (a step that blocks halts the run with its
reason; a helper update's note reaches the owner); its end fires `run.end`. Its turns fire
`turn.start` and `turn.end` when a plugin hooks them; a held turn is no idle turn: the lead waits a
minute and asks again, and five held in a row halt the run with why (the director's wake loop does
the same, then wraps up). Mid-turn and between turns it asks `health`:
only a block is a crash (Unreal gone three asks in a row, 5 s apart, or a reopen that failed); a
busy or reopening Unreal is pending and left to work. A crash fires `crash` (the plugin reopens
Unreal in place) and waits until `health` is quiet, twice at most; then the last save point is
restored, and the lead is told what may be lost.

A `save_point` is Genex's checkpoint (`checkpoint.take` under the lead's label): the plugin's steps
before it save the editor's work (refused while a play the agent started runs, or when the save
fails) and note the log's new errors; the snapshot follows; `hero-shots` after it hands back the
hero cameras' stills, kept as JPEG run artefacts with their tone numbers (a nearly black one is
called out as a render to doubt, with the restart named). The editor lock gives way to the person,
so a save point waits while they play, and is refused when Genex can't tell. Between turns, a turn
that made no save point gets an autosave asked only if the editor lock's probe says something is
unsaved (the lead hears why it wasn't). A rewind is Genex's restore of the save point
(`snapshot.restore`, naming the run's chat so Plan mode holds it): the plugin saves the editor's
work unless Unreal is gone, ends it before the files change and reopens it after (a block keeps
Unreal open and the files as they are); a rebuild fires the same restore moments with no file
changed; then the runner waits until `health` is quiet. C++ that doesn't build goes back to the
last save point. A rewind or rebuild still pending when the run paused runs before the resumed
lead's first turn.

Typed workers (`agents.ts`, at most two at once, medium effort, 25 minutes, a Genex cast 40)
are small jobs of one kind (`AgentKind`: `blender_model`, `blender_prep`, `genex_cast`, `sound`,
`texture`, `cpp`), started by `worker_start` with that `type`. A kind is on offer only when a plugin
that is on declares it as a worker type (`plugins.workerTypes`; the C++ kind also needs a game that
can take C++), and the lead's brief lists only those (`kindOffered`). Each is offered only its
kind's plugin tools (`AGENT_TOOL_ALLOW`: Local Blender's, `genex__asset`, or `check-part`; never the
editor, publishing or a paid CLI), and its delegation carries the run's `worker` grant, so the host
seats it in the mode of the chat the run was started in. `worker_stop` aborts its turn in its copy:
a delivery whose manifest it wrote still lands, otherwise it ends as stopped; it cannot be steered.
A copy too large to make (`copy-too-large`, read by its code) ends it with the host's words and
points at a worker in place. A `worker_start` with no type starts a generic worker from the run's
shared pool (`loop/workers/run-pool.ts`, the pool of a chat's workers, its records in the run's own
artifact and its copies' work on `refs/studio/runs/<run>/pool/<id>`), which the other worker tools
reach by its id and the run's close stops; a journaled call's `kind` and `brief` still replay. Each delivers files with a
manifest (`assets/agents/<id>/manifest.json`: each file's role, size and triangles, renders and the
exact import calls), which the lead hears until it marks it used or rejected. They work in copies
of the game, numbered past every delivery earlier runs left in the game; one with inputs gets a
snapshot of the game folder first,
so its copy holds them, and reads them by their game-folder paths. Their deliveries land in
`assets/agents/<id>/` and stay; every git write to the game folder (a landing, a save point's
snapshot, a restore) waits for the one before it (`lead-journal.ts` `oneGitWrite`), a refused
checkout is tried again, and a delivery git still won't take stays delivered and lands between
turns.

The run's paid Genex jobs, the lead's own and its sub-agents', are held to its credit cap
(`budgets.creditCap`, default 600) by the host (`HarnessDelegateParams.creditCap`,
`main/core/run-credits.ts`): it counts each job's charged or quoted credits under the run and
refuses the next paid job past the cap before Genex is asked. A lost or full session hands the run
to a fresh one (at most six); a usage cap pauses the run with its journal (`autopilot_<runId>`,
`kind: "unreal-lead"`), which Resume picks up; a journal of the older step machine
(`kind: "unreal-live"`) closes with a plain line. Three turns in a row the engine answers as failed
end the run as failed, with why.

`critic` (`critic.ts`) is advice the lead asks for: the named captures (by real path inside the
project's `Saved/Genex/captures/`), the game's `references/` stills and ART.md go to a fresh vision
call on the Reviewers role's engine that counts light, atmosphere, materials and composition as
structure, and the characters as hero pieces; it answers at most five defects with their fixes, one
bold move and its own Art checks, and changes nothing; it never stands between the lead and the
finish check. A later look is shown its last look's open
items and names the ones it still sees (`stillOpen`): those are required (a defect seen in two looks
in a row), and lead every digest, every `save_point` answer and `run_status` until a look no longer
sees them; the brief puts them before any new mechanic. When a model's sub-agent delivers renders,
the critic looks at them against the agent's brief before the lead hears of it (`lookAtDelivery`,
each render by real path inside the agent's folder): ready, or not ready with its fixes, and the
news says not to import it as it is; a look that can't be made says to look at the renders by
hand. At the end the run saves what is unsaved, settles its sub-agents
and writes `report.json`, its cost the sum of each turn's own share. On the Builds graph
(`lead-graph.ts`) the lead's milestones are rows whose save points are nodes it kept itself (no
eye); each typed worker is a node with its asset cards, Delivered until a save uses it, and leaves
the records every lead's worker leaves (`worker_started`, `worker_finished`, and one more with the
lead's verdict); the critic's advice sits on the save it looked at, never as a verdict.

C++ (`loop/unreal/cpp.ts`): before the first turn, the runner asks `cpp-status`. When this computer
compiles C++, the lead may start a C++ sub-agent; one asked for in a game without a module has the
runner call `add-cpp-module` between turns. Unreal restarts once, about two minutes, announced in the
chat. The runner polls `cpp-status` every 5 s for up to 8 minutes, then takes a "C++ module" snapshot
that every sub-agent's copy holds, and every restore reads `cpp-status` again. On failure or timeout
no C++ sub-agent starts; after a timeout nothing touches the editor or the folder until `cpp-status` no
longer says `adding`. `cpp-status` answers `{canCompile, xcode, platform, module,
adding: {state: idle|adding|done|failed, error?, seconds?}}` (`cpp-tools.ts`). `add-cpp-module`
answers `{module, already: true}` for a game that has one; it refuses off a Mac, without a ready
Xcode or for a project `addCppModule` would refuse, touching nothing; otherwise it answers
`{started: true}` and runs one job per project: `save_all` (any work left unsaved stops it with
Unreal open), the panel's normal quit and up to 90 s for no editor to run, `addCppModule`,
UnrealBuildTool on the project, then Open in Unreal and up to 5 minutes for the project to answer
(it fails at once when the project's log says Epic's server couldn't bind its port).
A build that fails takes the module's files and `.uproject` entry back out, and an editor the job
closed is opened again after any failure. An editor that runs without this game's project answering
is never quit. A C++ sub-agent writes `unreal/Source/<Module>/Parts/<agent>/` in its copy; its
delivery is checked out into the game folder, and Unreal is rebuilt between turns.

`check-part` on a C++ part (`part-files.ts`, `part-check.ts`, `part-compile.ts`) reads that folder in
the builder's copy by real path: plain `.h` and `.cpp` files at most one folder deep, at most 20, each
at most 200 KB; a link or anything else is a problem, never read. It refuses the part in a game
without a C++ module (write it in Blueprints and Python, or wait for the module), off a Mac or
without a ready Xcode, for a listed class whose `UCLASS()` declaration (`class <MODULE>_API A<Name>`
or `U<Name>`) no header has, for C++ files `cpp` doesn't list, for a class another part defines, and
for anything else UnrealBuildTool reads that the copy added, changed or lost against the game: its
Source (outside `Parts/`, a part that landed later is no change), `.uproject` and `Plugins/`.
Then it compiles the copy with UnrealBuildTool (`ubt.ts`, at most two at once) and names each error
as `<file>:<line>: <message>`; an error in a file outside the game and the engine names only where
it is. UBT runs under `sandbox-exec` (`ubt-sandbox.ts`): of the home folder it reads only the copy,
the engine, Xcode and its own folders (its configuration read-only), it writes only the copy's
`Intermediate/`, `Binaries/` and `Saved/`, its log folder and a private scratch, never a sign-in home,
with no network, no Apple Events (no scripting or typing into another app) and a fresh environment. It builds with `-NoUBA`: the build accelerator lists the
folders above the copy, which the sandbox closes in the home folder (a full build took 26.7 s). UBT
misses a source written within about a second after its last build, so a part file written then is
given a later write time first. In the game's own
folder check-part never compiles: the open editor compiles that module, so the C++ counts as not
verified. A compile takes 45 to 90 s: check-part waits up to 140 s, never past 170 s into its call
(190 s limit), then answers that the C++ is still compiling; the job keeps running per copy, keyed by
the part's C++, the module's `Build.cs`, the copy's Source, Plugins and `.uproject`, and the engine,
and the next call takes its result. `run-part` makes the same checks but never compiles. A Blueprint
whose `parent` is a C++ class is checked as an Actor (or its `base`): a node or event the reference
lacks is unverified there, and wherever a node names that class or its Blueprint child; `apply_part`
makes it from `/Script/<Module>.<Class>`, the module holding `Parts/<Part>/`, and refuses it (so
`apply.py` doesn't run) until the hot reload loaded the class. Both part.json readers are held to one
schema (`unreal-part-manifest-contract.test.ts`). In `apply.py`, `unreal.<Class>` of the parts'
classes passes; an unknown method is unverified only on what such a class made, and an unknown name
is told that `unreal.load_class(None, '/Script/<Module>.<Class>')` is the reliable form.

**The Unreal projects panel** (`setup.ts`, `backend.ts` and the `setup` panel, titled "Unreal")
finds the engines in Epic's launcher list (`LauncherInstalled.dat`). Its project list
(`find-projects.ts`) joins Unreal's recent list (each 5.8+ engine's `EditorSettings.ini`),
`*/*.uproject` one level inside Documents › Unreal Projects, and the projects Genex created, set up
or was shown. Each project appears once by its real path, with the file's own name on disk (another
case of the name is the same project), newest first, at most 12; the folder scan is kept for 10 s.
Types come from `lstat`, never from `readdir`, so Windows OneDrive placeholders count as plain files
and folders while real links are still skipped or refused. There is no path box: **Choose a project
file…** calls `studioPlugin.chooseFile({title, extensions: ["uproject"]})`.

The panel groups what belongs together in outlined blocks: a quiet label above each, a rule between
the rows inside, the actions in the block's foot. It opens on the shown project: its block holds the
name, its place and where it stands (a dot and a word; Ready is the green dot alone, its word for
screen readers and the tooltip), the step's words, the Engine it was made with and, in a game,
whether Rewind and Loops reach it, then the step's buttons, **Change project** and ⋯ More; a second
block, This computer, holds the engine, Xcode and the disk and memory notes. Change project opens
"Choose a project" (in a web game with no Unreal project, "Make this game in Unreal") with Back: a
New Unreal project row leads (in a web game: what was made for the web stays, and Undo in the chat
switches back), then the projects on this computer with their count and, past six, a name filter.
A row's place reads from `~` inside home, else the whole path; a temporary folder is "Temporary
folder › <Name>" and a long path keeps its first folder and last two around …, whole in its tooltip.
The shown project is tagged In use and, in a game, each one outside its folder Outside game,
explained once under the list (Loops and Rewind can't reach it). A pick is linked only by "Use … in
this game", which leads, with Open in Unreal second, for a set-up project the game doesn't use yet.

`stage-status` answers the same step for the open game's own project, which the Live card turns into
one button (`whereItStands` is shared with `status`). `status` returns the engines, the list, the
shown project and `next`, the panel's one primary step
(`PanelStep`: get-unreal, choose, quit-first, set-up, update-helper, open, starting, connected,
switch, not-answering, port-blocked, open-when-free, crashed). The shown project is, in order: the one the panel names,
only ever a project the person picked there or the only one found (remembered in `chosen.json`);
the open game's linked project (when that can't be read, its error over the list, never another
game's project); the project chosen last; the newest. `chosen` is false for the newest and for a
linked project that can't be read. Status also returns `game`, `linked`, `setUp`, `connection`,
`opening`, `firstStart`,
`helperOutdated`, `helperNewer`, `launcher`, `openProject`, `busyPort`, `editor.editors`,
`projectOpen` (Unreal has the shown project itself open), `owned` (a Genex game builds in it, so
Connected says to open that game), `holder` and `busyRun`. Unreal has a project open while its port
answers for it, or while its own log is open: the log names the project on its command line by any
spelling of its real path (through a link, or in another case), never wrote `Log file closed`, and,
on a Mac, an Unreal Editor process still holds it (`/usr/sbin/lsof`, `editor-holds.ts`), so a log a
crash left days ago doesn't count while another editor runs; where lsof can't answer, an unclosed log
counts. quit-first comes only while Unreal has the shown project open; beside another open project,
set-up only sets up and opens nothing, since Genex keeps one editor. A set-up project Unreal doesn't
have open while an editor runs, with no other set-up project answering, is open-when-free: no
Restart or Quit (that would close the user's other project), only "Open <Project> once Unreal is
free.", with Open in Unreal shown but held until then. `holder` names what Unreal has open for set-up beside it, switch and open-when-free: the other
set-up project that answers, else on a Mac a project whose own log an editor holds (one lsof call
over `~/Library/Logs/Unreal Engine/*Editor/*.log`); null when unknown. `busyRun` names a run (a Loop)
going whose game's linked project is the one Unreal has open (it answers, or its own log is open),
from the host's `game.engine.runs`; a run whose project isn't open holds nothing. The panel and the
Live card then offer no Quit, Switch or Restart, and say what to do once the Loop ends. While an editor runs
unanswered, port-blocked means the project's own open log holds Epic's `LogHttpListener: Error:
HttpListener unable to bind to 127.0.0.1:<its port>` line (another port's line counts for nothing):
that editor will never answer, so it is never Starting, the panel says "Unreal couldn't use the port
Genex gave <Project>." with Restart Unreal (its normal quit, then Open once it has closed and
Open is the step; a port another app holds by then shows set-up again; on the Live card, moving to another game drops the waiting Open), as it does for not-answering, and the toolbar's Not open says the same; no copy names the port's number. `busyPort` is the port Open found still held when it opened the
project, while its editor runs unanswered; the panel adds that to Starting and not-answering. While the shown set-up project
runs unanswered and isn't loading, status asks the other set-up projects on their own recorded
ports; when one answers, `openProject` names it and `next` is switch, which the panel turns into
one press: Unreal's normal quit, then Open in Unreal once it has closed. A project counts as set up with its plugins on, its own port and
a setup record; a Genex editor helper that is older or missing gives it the update-helper step
(setup again copies only the helper) rather than making it look never set up, and Connected then
adds a quiet note. A project set up before Epic's toolsets were added is still set up; the same Open
adds them (`addToolsetPlugins`, after the game snapshot, recorded so Undo takes them out), with no note.
A toolset Genex added that the user took out again counts as settled: no Open, setup or snapshot puts it back.
A user's Open updates an older helper only in the open game's own linked project, so only
there does the panel say Open in Unreal updates it; elsewhere it says opening it from its Genex game does. A newer helper (`helperNewer`) gets one line under Open in Unreal and Connected,
never an update. Connected needs both an answer on the project's port and a running editor
process. Starting means Genex opened the project in the last 15 s, or its own Unreal log
(`~/Library/Logs/Unreal Engine/<Name>Editor/<Name>.log`, or `Saved/Logs` on Windows) is open, names
this `.uproject`, hasn't logged `LogLoad: (Engine Initialization) Total time` and changed in the
last 3 minutes; Genex's launch counts for 20 minutes only while no log says either way. So a
project opened from Finder shows Starting too, for as long as it loads, and a loaded editor that
doesn't answer is not-answering at once. This holds for a project that isn't set up as well, so the
panel never offers to quit a loading editor. Genex's own Starting record is dropped once the
project answers. `firstStart` is true until Unreal's recent list names the project before this
start; the panel shows its first-start hints only then, and while a project starts it always says
the panel may close (the Unreal button says Ready when it is done). With Unreal closed and another app on a
set-up project's port, `next` is set-up again, which moves the port (not yet on Windows). When
that app is Unreal's own crash reporter (lsof finds `CrashRep…` listening there on a Mac: a crashed
editor's reporter inherits its sockets), `next` is crashed instead, closed or reopened alike: the
panel and the Live card say Unreal crashed and to close its crash report window, then open the
game again, and nothing moves the port. On a Mac, status's `rayTracingRisk` says the shown
project's `Config/DefaultEngine.ini` turns hardware ray tracing on (`ray-tracing.ts`: the last
`r.RayTracing` in the renderer settings): UE 5.8 rendering a ray-traced level behind another app
hangs the GPU (on an M4 Max it crashed within a few plays, throttled ones too at startup), so the
panel notes it with Turn off ray tracing (`ray-tracing-off`, confirmed first), which sets every
such line to False, Lumen lighting the level in software from the next start. A new game made on a
Mac is made without it (`create-project.ts`, after Epic's own values), and the bridge, the editor
queue and the computer's play lift the background throttle on a Mac only for an editor that says
`r.RayTracing` is 0 (`editor-throttle.ts`). Xcode
is recommended to every Mac user, since without it Genex works in Blueprints only: status's `xcode`
(`xcode.ts`) gives This computer an Xcode row, only under a shown project, that says to get
Xcode, to open it once to finish its setup, to run one Terminal command (with Copy) when another
developer folder is selected, or the range the engine builds with (once ready, a ticked row with its
version under the engine's): one too new
(`tooNew`) is kept and an older one added from Apple's downloads, and a second installed Xcode in
range is judged instead of the selected one. It warns
about an engine mismatch and under 16 GB of memory, and about free disk below
`diskNeedBytes` (on the project's disk, else the engine's): 20 GB for a project, or 20 GB plus `installBytes` (45 GB) while no supported Unreal
is installed. `launcher` says whether Epic's Games Launcher is installed, asked only then; the Get
Unreal view's first step holds its one button: getting the Launcher and signing in without it, else
opening it at Library, then installing 5.8 (not a newer one).

The confirmed `setup` step does four things, each one only if it is needed:
- switches a project made with an older Unreal (5.7 or before) to the newest supported engine by
  its `EngineAssociation`. Unreal opens a project named on its command line in place, without its
  own Convert prompt, so `open-editor` refuses such a project (`needs-setup`) and Studio's
  confirmation says that content saved in 5.8 won't open in the old version. Undo puts the old
  association back unless the user has moved the project on since;
- turns on `ModelContextProtocol` and `EditorToolset` in the `.uproject`, keeping Unreal's tab
  layout, and adds Epic's toolsets for games, editor-only (`TOOLSET_PLUGINS`: `UMGToolSet`,
  `NiagaraToolsets`, `StateTreeToolset`, `AIModuleToolset`, `AnimationAssistantToolset`,
  `PCGToolset`, `PhysicsToolsets`, `GameplayTagsToolset`, `AutomationTestToolset`). A toolset the
  project already names, on or off, stays as the user left it, and one Genex added that the user took
  out stays out. Not Epic's `AllToolsets`: on UE 5.8.3
  its `GameFeaturesToolset` makes every start log a GameFeatureData load error, and the rest serve
  no game Genex makes. On UE 5.8.3 a fresh project with these starts with no load errors and opens
  as fast as one without them; `list_toolsets` grows from 19 toolsets to 40, while the agent's three
  meta-tools stay the same;
- gives the project its own port and starts the MCP server on it, by writing `bAutoStartServer`
  and `ServerPortNumber` into `Saved/Config/<Mac|Windows>Editor/EditorPerProjectUserSettings.ini`.
  The port is always in Genex's block, 18000–18999: it starts from a hash of the real `.uproject`
  path and takes the first port nothing listens on and no other set-up project holds. A port the
  project already has inside the block is kept; any other, such as Epic's default 8000, moves;
- copies the helper. Over an earlier copy, a helper file the user changed is kept beside it as
  `<file>.mine` first. Studio's confirmation then says it updates the helper to the shipped
  `.uplugin`'s `VersionName` (dotted numbers only, else no version), not that it adds one. A
  project's helper whose `.uplugin` names a higher whole-number `Version` than the shipped one is
  newer (`HelperState` newer): setup leaves it. With an equal or lower `Version`, or a descriptor
  that is missing, unreadable, over 64 KiB or reached out of the project, the bytes decide.

It refuses while Unreal Editor has this project open (its port answers for it, or its own log is
open as status reads it, by any spelling of its real path), because the editor rewrites that
settings file when it closes; another project
open in Unreal holds it back no more than undo. It also refuses a path that is not a real `.uproject` and a write target reached through
a link. Before the first change it copies each file into the plugin's storage, under
`setup/<hash>/before/`, and records what it changed, the port and the hash of each helper file it
wrote. `undo-setup` takes back exactly those changes and keeps the user's own later edits: a
helper file goes only while its bytes are still the ones setup wrote, Python's caches go, folders
go only once empty, and a helper that was there before comes back. It also removes a settings file
and a Plugins folder setup created that are empty afterwards. Its answer names the helper files
left because the user changed them.

**New Unreal project** (in a game, "Make this game in Unreal"). `templates` returns the five allowlisted Blueprint templates (Third person, First
person, Top down, Vehicle, Blank) with Epic's names and thumbnails and a short line of Genex's own
for each, plus Third person's Combat variant (its own card, offered only while its content pack is
installed; Epic's C++ versions and other variants aren't offered), a free name, where the game is
saved, and `newGame` when no game is open. `create {template, name, variant?}` (no confirmation:
nothing that exists changes) builds the project the way Epic's `CreateProjectFromTemplate` does
(a variant's own pack copied after the template's, as `AddSharedContentToProject` does), then sets
it up. With no game open, the name and template are checked first, then the host makes a Genex game
named for the project (`game.create`, below) and the project goes in its folder as `unreal/`, linked
to it (`game.engine.link {game}`), so every project Genex makes can run the Loop, and the panel
says which game it made, to open from the sidebar; only a host
that makes no games leaves it in Documents › Unreal Projects, in a temporary sibling renamed into
place (on Windows, the real Documents folder, which may be in OneDrive; the rename is retried while
another app holds the new files). `game.create {title}` (`game-engine` capability) takes one plain
line of at most 80 characters, makes an ordinary game and remembers it as that plugin's; a link
naming `game` is refused for any game that plugin didn't make, and from inside another game. Names
are 1–20 ASCII letters, digits or underscores starting with a letter, never a platform or Windows
device name; a refused name is told the first rule it breaks (empty, first character, a space,
another character, length). On Windows `<folder>/<Name>/<Name>` must fit in 130 characters, stricter than Epic's
long-path limit because Unreal's Content Browser still assumes 260. New projects use Unreal 5.8 only,
the version whose creation steps were compared with Epic's source. With only a newer engine the form
gives way to installing 5.8 beside it (Open the Epic Games Launcher leads) and a quieter Choose a
project… (one made in Unreal's own New Project dialog works in chats, not in Loops); 5.8 without its
templates gives way to verifying it in the Launcher. An agent's `new-game` is refused with the same
ways, and the engine question never offers it then: with only a newer or only an older Unreal
(`engine-status` newer-only or older-only, its `note` on the kind) it offers "Unreal Engine 5.8" as
needing 5.8 beside it.

**Open, quit and get Unreal.** `open-editor` runs `open -n -a <engine>/Engine/Binaries/Mac/UnrealEditor.app --args <uproject>`
on a Mac, or starts `UnrealEditor.exe` detached on Windows, outside ProcessSandbox: it is the
user's own editor, like double-clicking the project. Before it opens a set-up project it waits up
to 45 s, asking every second, until Unreal could listen on the project's port: for about 30 s after
Unreal quits, its sockets linger there (TIME_WAIT), Epic's listener logs `HttpListener unable to
bind to 127.0.0.1:<port>` and the MCP server never starts. A test bind sees a listener, and on a Mac
`/usr/sbin/netstat -an -p tcp` must list no socket on `127.0.0.1.<port>` or `*.<port>` (Node's own
bind passes over lingering sockets). Past the wait it opens anyway and keeps the held port in the
Starting record. This covers the panel's Open and Switch, `new-game` and `add-cpp-module`'s
reopen. It records `starting.json`. `quit-editor`
sends Unreal's normal quit (AppleScript to `com.epicgames.UnrealEditor`, or `taskkill` without
`/F`), never a forced one, refuses with two editors open, and forgets only the named project's
Starting record. `get-unreal` opens the Epic Games Launcher when installed, else the constant
https://www.unrealengine.com/download. Windows console tools (`tasklist`, `taskkill`, PowerShell)
run by full path under `SystemRoot` with no window. These four actions are `native`, so a fixture
profile refuses them.

**Toolbar.** The item `editor` ("Unreal" after the host's `unreal` glyph, aria-label "Unreal
Editor", `facts: ["unreal-project", "unreal-plugin"]`) opens the setup panel on an Unreal game only:
a web game, a game with no kind yet and no game at all get no Unreal button. A game whose chat chose
Unreal while no Unreal that makes games is installed (the agent's `show-steps`, or a `new-game` or
`new-plugin` refused for it) is remembered in `wants/<game>.json`, and its status says `shown`, so
its strip shows the button that gets Unreal from the turn's end. Its `toolbar-status` is per game. While no Unreal 5.8 or
newer is installed (Epic's launcher list, read on every ask) the badge is Not installed, whatever
the game. With a game open and no link (`links/<game>.json` missing,
undone or not trusted: a symlink, not JSON, another engine, a `.uproject` that is gone or not a
plain file) there is no badge, only the title "Make this game in Unreal"; linked, it is that game's
own project's state, named in the title: Not set up, Not open, Starting or Ready. Closing the panel
asks again at once. With no game open it reports the
project chosen in the panel. Every badge is a `dot`: Ready `ok` (green), Starting `warn` (amber),
every other state `info` (grey). Its word leads the tooltip, above the title, and a screen reader
hears it after the button's name (`aria-describedby`). The plugin page's Editor connection, once the plugin is on,
shows the same word in place of the bridge's own Ready (`PluginConnections.tsx`). The state comes from Genex's records, one process check and the
project's identity check on its port (remembered like the panel's), plus the project's own log only
while Unreal runs unanswered. It scans no folders, and the only thing it writes is removing its own
stale Starting record once the project answers.

**Roblox Studio.** The bundled `roblox` plugin (`src/plugins/roblox`) is off until the user turns
it on (`seedEnabled.roblox = false`): it needs Roblox Studio and a Roblox account, and its
description and panel say "Not affiliated with Roblox Corporation. For people 18 and over." It
declares the engine `roblox` (label "Roblox Studio", project files `.rbxl`, `.rbxlx` and
`.project.json`, fact `roblox-project`, `projectInFolder: false`, play for up to 8 players, and the
editor apps `com.Roblox.RobloxStudio` and `RobloxStudioBeta.exe`), the `network` capability (hosts
`setup.rbxcdn.com` for Studio's installer, `127.0.0.1` for the helper link, and GitHub's
`github.com`, `release-assets.githubusercontent.com`, `objects.githubusercontent.com` and
`raw.githubusercontent.com` for the Luau checks), the per-game lock
`studio` with its probe `studio-activity`, and no `folders`: a write root there would let any worker drop a
plugin into Studio's Plugins folder. `studio-locate.ts` finds Studio on a Mac at
`/Applications/RobloxStudio.app` (a link only while it stays inside /Applications; its version
from Info.plist through `plutil`) with `Contents/MacOS/StudioMCP`, and on Windows as the newest
`%LOCALAPPDATA%\Roblox\Versions\version-*\RobloxStudioBeta.exe` beside `mcp.bat`; it refuses
links out of those folders and a home or LOCALAPPDATA of the other system. Whether Studio runs is
`pgrep -x RobloxStudio`, or `tasklist` by its full path. The toolbar item `studio` ("Roblox Studio"
after the host's `box` glyph, scoped to `roblox-project` games like every engine's button) opens the panel; its `toolbar-status` is a
dot: Not installed and Not open `info`, Set up and Starting `warn`, Ready `ok`. Set up holds until
Genex's setup record (`setup/record.json` in plugin storage) exists; Ready means Studio's own MCP
server lists an open Studio, asked through the one StudioMCP the backend keeps once Studio runs. Neither the button nor the
panel's `status` reads `~/Documents`, where macOS asks the person first; the Mac Plugins folder
(`~/Documents/Roblox/Plugins`) is only named there.

Set up (`setup.ts`, `mcp-switch.ts`) runs only from the person's press and only while Studio is
closed, because Studio rewrites its settings while it runs. It adds the Genex helper
`GenexStudioHelper.rbxmx` to Studio's Plugins folder (`~/Documents/Roblox/Plugins` on a Mac,
`%LOCALAPPDATA%\Roblox\Plugins` on Windows), making that folder inside the real Roblox folder when
Studio hasn't yet, and turns Studio's MCP server on (`"mcp-server": {"enabled": true}`) in every
account's settings file named by digits in `AssistantSettings` (`~/Library/Roblox` on a Mac; on
Windows presumed under `%LOCALAPPDATA%\Roblox`, not yet run there). The switch is edited in the
file's own text, so every other key keeps its bytes. Genex never makes a settings file or guesses
an account: with none, the panel offers Do it for me and Studio's click path. A link, something
other than a folder or file where one belongs, an unreadable or oversize settings file, or a
running Studio refuses the whole step before anything is written. Set up's confirmation says macOS
may ask to let Genex use the Documents folder, where Roblox keeps its plugins. The record
`setup/record.json` lists each write with its bytes' hash or the switch value it replaced, and keeps
a copy of a helper file that was there before; Undo Set up takes back only what still holds Genex's
bytes, and the Plugins folder only when Genex made it and it is empty. The helper carries
`GENEX_HELPER_VERSION`: an older or unmarked one is replaced, a newer one is kept, and at the same
version the bytes decide (an earlier Genex's recorded write that isn't the shipped helper is
replaced; the person's own edit is kept). With Studio open,
Set up offers **Restart Studio** (a normal quit of every Studio process, each asked on its own
because each place opens a Studio of its own, so Studio asks to save as always; Set up; Studio
opened again), **Do it for me** (`game.engine.assist` with the task "Turn on Studio's MCP server:
Assistant › ⋯ › Settings › MCP Servers › Enable Studio as MCP server", clicking only that path and
stopping for the person at any other dialog: saving, signing in, updates or terms) and that click
path.
Assistant Settings is a window of Studio's own process, so `engine.apps` names Studio alone;
`engine.playerApps` names Roblox's player app (`com.roblox.RobloxPlayer`, `RobloxPlayerBeta.exe`),
which computer use never drives. The
setup actions are `native`: they write outside the plugin's storage or quit and open Studio, so a
fixture profile never runs them.

**Get Roblox Studio** (`studio-install.ts`, native, after its card) installs Studio for a person
who has none, in the order Roblox's installer sets. It downloads Roblox's own installer for the
system (`https://setup.rbxcdn.com/mac/RobloxStudio.dmg`, `…/RobloxStudioInstaller.exe`) over HTTPS
only, following a redirect only when it stays on exactly `setup.rbxcdn.com`, and stops past
`MAX_INSTALLER_BYTES` (64 MB). Roblox changes its installers with every release, so nothing pins a
hash: the signature is the check, and Node's downloads carry no quarantine mark. On a Mac
`codesign --verify --strict` must accept the DMG and the `RobloxStudioInstaller.app` on it against
Genex's own requirement (`-R`: Apple's root, its Developer ID authority and team `2CFABCH843` in the
leaf; a signature's own requirement is only its signer's word), each with Roblox's `TeamIdentifier`,
and Gatekeeper (`spctl --assess`) must accept the app; the DMG is attached read-only and unbrowsed
in a private temporary folder and always detached. On Windows Authenticode must call the installer
`Valid` with Roblox Corporation as the signer's whole CN or O (a subject with an escape is refused); PowerShell reads the path from its own
environment, never from the command text. A failed check runs nothing, and the temporary folder is
always removed. The installer and Studio run outside the process sandbox, as argument lists: the
install is the point, and Studio's sign-in must work. After the installer Genex waits for Studio,
lets the person sign in in the Studio the installer opens (it closes by itself after; Genex never
closes it and never sees the password), runs Set up while it is closed (the helper always; the
switch when a settings file exists), and opens Studio once. The action answers at once; `status`
carries the phase (`install`) and `install/state.json` in storage keeps the last one, and **Stop**
(`cancel-get-studio`) ends a download or a wait. The install has not been run live; it is proven
with fakes.

The Set up panel and the chat's steps card draw the same rows (`engine-steps.ts`): Studio (ticked
with its version, so Get Roblox Studio is never offered with Studio here), signing in, the helper,
the MCP server and the game's place, each with the same words, tick and button. `steps` answers the
card; `status` answers the rows, the step that is next (`now`: Studio, then Set up, which needs
Studio closed, then opening Studio, its MCP server and the place), the MCP switch read from
Studio's settings and the helper version Genex's record names, without reading `~/Documents`. On
the next step the panel adds Restart Studio beside Do it for me, Studio's click path, what Genex
waits for, and on a Mac before Set up the Documents note. Do it for me is offered only where Genex
can click (`canClick`, the host's `game.engine.canAssist`: a Mac or PC with computer control's driver;
elsewhere Restart Studio and Studio's click path) and only while the switch is off; while Studio doesn't answer, the MCP
row first says to sign in on Studio's sign-in screen, and with no place open, the place step's
buttons show beside it. Restart Studio reopens the game's own place. Answers are said in one
persistent live region; Do it for me and Publish an update first say a question may wait in the
game's chat, behind the panel. Choose your place calls `places` only on
the person's press. A linked place's block names the place, says when the person's own Rojo project
keeps the scripts, and warns when the last play found Studio can reach the game's live saved data
(`live-data/<game>.json` in storage, which the play adapter writes), with Studio's switch to turn
it off.

Its connection `studio` (connector `roblox-studio`, "Roblox Studio, for this game's open place.")
is Studio's own MCP server passed through. The node bridge (`studio-mcp.ts`, run per game in
`<storage>/mcp/<game>`) starts `StudioMCP` itself through `studio-client.ts`: on a Mac
`/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP` with the person's real home from the
system's user record (the host points HOME at the connection's own folder, and StudioMCP keeps its
connection token in the real one, which Genex never reads); on Windows `%LOCALAPPDATA%\Roblox\mcp.bat`
through `commandLaunch`'s cmd.exe line, from its real path inside that folder, refusing anything
cmd.exe would rewrite. The host points the Windows profile folders at the connection's own folder
too, so the bridge rebuilds them under the person's home from the same user record, at Windows'
default `AppData` layout (`personEnv`). Neither runs in Genex's process sandbox: Studio's own connection and the
person's sign-in must work. Studio joins a fresh StudioMCP a moment after it starts, so a call asks
`list_roblox_studios` until the game's Studio is listed (`STUDIO_JOIN_MS`). Every call is pinned
to that Studio: `studio_id` is filled from the binding file `studio.json` the backend keeps in the
connection's folder (`{studioId, session, at}`, believed for `BINDING_MAX_AGE_MS`), or with no file
yet from the game's linked place matched by name; two matching Studios, a stale binding and a call
naming another Studio are refused in plain words. `studio-tools.ts` gives each of StudioMCP 0.743's
30 tools a class: the reads pass with no card (the manifest's `reads`), `execute_luau` passes as a
write (Edit unless the agent names another data model) with `agent-busy.json` kept around it, once
its code passes `luau-screen.ts`: code that names Creator Store inserts, uploads, publishing, the
internet or a published game's live data, or that builds the names it looks up (`getfenv`,
`loadstring`, `game[…]`, a `GetService` of anything but one plain name, character codes), or whose
`require` takes anything but a script path (an instance reached by names, a `./` or `@` path, or a
variable never set to a number) or is passed on as a value, is refused
before it reaches Studio, naming the tool that asks first (`execute_luau` runs with a plugin's
rights, which reach all of these). The screen reads text: a name built in a variable and looked up
on an instance found by walking the tree still passes, so the asking tools stay the line. And a
tool the table doesn't know (a newer Studio's) is hidden and refused until Genex classes it, since
it could publish, upload or run Roblox's AI on the person's account. Hidden too: the play-lane tools (play goes through the
six play tools), `multi_edit` (scripts are the game's `.luau` files), `http_get` (Studio would
fetch any address for the agent: a path for leaking data and for planted instructions) and
`list_roblox_studios`; inserts, uploads and Roblox's AI tools are plugin tools that ask the person
every time (Ask first, below), and a call to one through the connection names the plugin tool to
use instead. A `screen_capture` JPEG over 1 MB is shrunk with `sips` or PowerShell's System.Drawing,
and refused in plain words when it can't be.

The binding file comes from the helper link (`helper-link.ts`), which the backend starts once Studio
is set up. It is a hand-written RFC 6455 server (`helper-socket.ts`, no dependency) on 127.0.0.1
only, on the first free port of `HELPER_PORTS` (47301–47304, which the helper tries in the same
order), path `/genex-helper`. It refuses any handshake carrying an `Origin` (every browser sends
one; Studio's `CreateWebStreamClient` sends none) or another Host, takes masked text frames only up
to `MAX_HELPER_FRAME_BYTES` (4 MB), and closes on anything else; it pings every `HELPER_PING_MS`
and ends a connection silent for a whole period. `helper-protocol.ts` checks every message once:
protocol version, ids that only grow (a repeated id is refused), a known type, exactly the fields
that type has, answers and data chunks only for requests the backend made, place parts that stay
plain paths under `.genex/place/`, and sources up to 1 MB. A script is named as Studio holds it
(the instance names from one of `SCRIPT_SERVICES` down, its class and a Script's run context); the
backend maps that to a file under `src/` (below) and resolves the file by real path
(`scriptTarget`, refused through any link). Both sides hash bytes with `helperHash`, FNV-1a over 32 bits. Binding
is exact: each connection gets a random session (`session.mark`), the helper puts the sessions of
its connections (at most two Genex apps) in a non-archivable `GenexHelperSession` StringValue in
CoreGui, and the backend reads that marker through `execute_luau` in Edit in every listed Studio;
the one that holds the session is the connection's. Only when no Studio lets CoreGui be read does
the place the helper names stand in, and two such Studios are refused. The game is the one whose
linked place that Studio has open (none when two live games link it; a removed game's link record,
its project file gone, doesn't count), read again each refresh with the Studio's place as StudioMCP
lists it then, so a publish that renames the place keeps the game bound. Before a connection's game is
first bound, `beforeBind` asks that helper (a save point's place waiting to load), and only then is
`studio.json` written, so agents reach that Studio after it; it is refreshed every
`BINDING_REFRESH_MS`, and after a Studio restart the helper's new connection rebinds the game to
the new Studio's id. The newest connection wins. A connection bound to no game is obeyed in
nothing. This stops games and profiles crossing wires; it does not stop a local process that
already holds StudioMCP.

The helper itself is readable Luau in `src/plugins/roblox/helper/` (one module per file, each
saying what it does at its top, and `VERSION`), which `scripts/build-plugins.mjs`
(`robloxHelperModel`) assembles into `GenexStudioHelper.rbxmx`: the entry Script (`init.luau`, run
context Plugin) holding a ModuleScript per module and a `constants` module generated from the
plugin's TypeScript (protocol, ports, names, limits, message and error vocabularies), the same
bytes for the same tree. The build refuses a `VERSION` other than `HELPER_VERSION`. Studio loads it
into each place opened after it is added. It returns at once outside the Edit data model, so the
copies in a play session's server and clients never connect, and it never raises an error in Studio
for a missing API: a request it can't serve answers `unsupported`. It lists, reads, writes (inside
a ChangeHistoryService recording, through `ScriptEditorService:UpdateSourceAsync`, refused as a
`conflict` when the source changed since `base`) and removes scripts (only while the hash still
matches), skips writing what Studio's Script Sync keeps, and sends `scripts.changed` for edits made
in Studio, never for its own writes or a place load. `place.export` serializes each saved service's
children with `SerializationService` (a child that can't be created is a container of its own, such
as `StarterPlayer/StarterPlayerScripts`), splits a container past `PLACE_PART_MAX_BYTES` (40 MB)
into one part per child under `<container>.split/`, adds `services.json` and `terrain.rbxm`, and
serializes again only the containers whose children changed; `place-files.ts` writes the parts
that differ from `.genex/place/manifest.json` whole or not at all, removes parts the place no longer
has, and loads a save point's parts back (`place.load`), each checked against the manifest first.
`pending-load.json` waits for a Studio that wasn't reachable and loads before the next binding.
`play.multiplayer` starts `StudioTestService:ExecuteMultiplayerTestAsync` (one session, at most
eight players); pausing or ending a test acts in the play session's own data models, out of the
Edit helper's reach, so those answer `unsupported`. `activity` and `team` (who else is in a Team
Create place) are sent on change and answered when asked; `device.set` and `gui.layout` drive the
Device Simulator; `model.import` builds a checked mesh (`GXM1`) as a MeshPart.

**Scripts as files.** A Roblox game's scripts are `.luau` files under its `src/<Service>/`, in
Rojo's names (`script-paths.ts`): `Name.server.luau` a Script, `Name.client.luau` a LocalScript,
`Name.luau` a ModuleScript, `Name.plugin.luau` and `Name.runcontext-server|client.luau` a Script
with that run context, folders for the instances on the way, and `init.<kind>.luau` inside its own
folder for a script with scripts below it. A character no file system keeps (separators,
`: * ? " < > |`, controls, trailing dots and spaces, a Windows device name's first letter, a dot
that would read as a kind, `%` itself) is written `%XX`; each name has one spelling, so a file
spelled otherwise is no script of the game's, and a name past 200 characters gets no file. Two
scripts of one name, or names differing only in letter case, get no file either. `script-sync.ts`
keeps them in step with Studio, `Source` only (attributes and tags stay in the place export). Its
record `.genex/roblox.json` holds each file's hash as of the last agreement and the files Genex
wrote at the game's top. When a game's helper binds, before `studio.json` is written, every script
is reconciled three ways (Studio's hash, the file's, the record's): the side that changed wins, a
new script is copied, a deletion is copied only when the other side is as recorded (in Studio only
while its hash still matches), and changed on both sides keeps Studio's version and moves the
file's to `.genex/conflicts/<when>/`; an edit beats a deletion. While bound, a change under `src/`
(watched, quiet for `SYNC_DEBOUNCE_MS`) is pushed with the record's hash as `base`, and Studio's
`scripts.changed` is written to its file; each write is recorded first, so its echo matches the
record. Scripts Studio's Script Sync keeps are skipped both ways; a `default.project.json` Genex
didn't write is the person's Rojo project, and then Genex keeps no script in step. A `src/` that is
a link is refused whole; writes stay in the game folder by real path and never go through a link;
a source past Studio's 200,000 characters stays on disk with a log line. A script file the scan
finds but can't take (that long, not UTF-8, unreadable, a link, in a folder it can't list, or past
the scan's limits) counts as present: neither side's copy is touched for it and the record keeps
it. A change Studio refuses while a play test runs (`busy`) is sent again every `BUSY_RETRY_MS`
(5 s) until it lands, and a new play test the agent starts flushes the pending changes first; a
watch that stops on an error is armed again after `WATCH_REARM_MS` (5 s), with a pass for what
changed meanwhile. The sync also adds
Studio's place lock files (`*.rbxl.lock`, `*.rbxlx.lock`) to the game's `.gitignore`. The backend
learns each game's folder from the plugin calls that carry one (`games/<game>.json` in its
storage). Script workers (`workerTypes` `scripts`, `isolation: copy`) check their files with
`check-scripts`.

**Luau checks.** `check-scripts` (agent tool, no card, reads only; `all: true` for every file)
runs, side by side from the game folder by full path with argument lists, `luau-lsp analyze
--formatter=gnu --platform=roblox` with luau-lsp's Roblox definitions and a sourcemap,
`selene --display-style=Json2` (the game's `selene.toml`, else Genex's with `std = "roblox"`) and
`stylua --check --output-format=json`, each within `CHECK_TOOL_MAX_MS` (90, 60 and 30 s) and
`MAX_CHECK_OUTPUT_BYTES` (2 MB) a stream, on at most `MAX_CHECK_FILES` (300) files
(`check-scripts.ts`). The sourcemap is `src/` in Rojo's format (`sourcemap.ts`: the script sync's
names, `Folder`s on the way, `StarterPlayerScripts` and `StarterCharacterScripts` by class, never
through a link), written in the plugin's storage for each check and removed after it; a game with
its own `sourcemap.json` (a Rojo project) uses that. Findings come back as plain lines at a file
and line (`TypeError` and `SyntaxError`, selene's `Error` and StyLua's parse errors are errors;
lints are warnings; StyLua's layout differences are format). A program that hangs, prints past the
cap, can't start or exits with another code is named and never counts as a clean check. A file
every program found clean is remembered with its sha256 and the programs that checked it
(`luau/clean/<game>.json`) and checked again only once it changes. The programs are found where
the person keeps them (PATH, then `~/.rokit/bin`, `~/.aftman/bin`, `~/.foreman/bin`), then in the
plugin's storage (`luau-tools.ts`); the definitions only in the storage. **Add Luau checks**
(`add-luau-checks`, native, a quiet button under the panel's steps once Studio is set up, its card
naming this computer's download size) downloads only what is missing of the `PINNED` releases
(luau-lsp 1.70.1, selene 0.32.0, StyLua 2.6.0 and luau-lsp's `globalTypes.None.d.luau` at the same
tag; Mac arm64 and x64, Windows x64; selene has no Intel Mac build): HTTPS, each redirect checked
to stay on GitHub's hosts, no larger than its pin and matching its sha256, all fetched into a
private folder in the storage before `ditto` (Mac) or Windows' own `tar` unpacks any, then moved
to `luau/<asset>-<version>/` together or not at all. Genex's own selene runs with its home in the
storage, where it caches Roblox's library (fetched by selene itself on its first run, which Add
Luau checks starts); on Windows selene keeps that cache in the person's local app data. The
programs run outside ProcessSandbox, as the person's own copies would; nothing is vendored into the
app. New Roblox game writes `selene.toml` and `stylua.toml` defaults into a game that has none.
A call bound to a worker's copy checks the copy and never hands its folder to the script sync.

**Places.** A Roblox game builds in one place (`places.ts`, `place-actions.ts`, all native).
**Choose your place** (`places`) lists the Studios open now first, each asked in Edit for its
`PlaceId` and `GameId` (two of one name are listed as "Place1" and "Place1 (2)"), then `.rbxl` and
`.rbxlx` files from Studio's recent list (a Mac's exported Studio preferences, recent-file names
only) and the top of `Documents/Roblox`: one row per real path, newest first, at most
`MAX_PLACES` (12), the scan kept for `SCAN_KEEP_MS`. Only this press reads them; `status`,
`toolbar-status` and `steps` never do. **Use in this game** (`use-place {file | studio}`) links a
local place file where it is (by real path; a link, another extension or another system's path is
refused); a published place through `default.project.json` in the game folder, listed in
`.genex/roblox.json`'s `written` before it is written (the person's own Rojo project is linked as
it is), with `remote {placeId, universeId}` as strings; a place never saved through that same file,
found in Studio by its name, which the backend keeps in `places/<game>.json` in its storage beside
each link (never in the game folder). A Studio of the same name refuses a link by name. A place
another game builds in is refused ("Place1 already builds in Sky Race") while that game's folder
still links it; once the game is gone the place is free. **New Roblox game** (`create`, and the
agent's `new-game` with `makes: ["roblox-project"]`, `ready: "engine-status"`, scaffold
`game` "Roblox game") writes `<game>.rbxlx` from `templates/baseplate.rbxlx` through a hidden file
beside it (whole or not at all, never over a file), adds the lock lines to `.gitignore`, links it
(with no game open, into a game `game.create` makes) and opens it with Studio's command line
(`studio-launch.ts`): `--task EditFile --localPlaceFile`, or `--task EditPlace --placeId
--universeId` for a published place (ids of digits only), each starting a Studio of its own, so
**Open Studio** brings Studio forward instead when the game's place is already listed. **Quit
Studio** and **Restart Studio** use Studio's normal quit and are refused while a build uses Studio
(`game.engine.runs`). `use-project` links a game to an open place by its label from `places` or a
file by path (the agent's own call when the game has no place or lost it; another place only when
the person asks), never reading Documents, Desktop or Downloads: a file there is linked by its label
once open in Studio. `show-steps` puts the steps card in the chat.

**Every press is also the agent's** (`tools.ts`, `setup-prompts.ts`). Setup is the agent's job, so
each press of the panel is an agent tool under the action's own name: `setup`, `undo-setup`,
`restart-studio`, `get-studio` and `add-luau-checks` (each with its press's card), `quit-studio`
(a card, though its press has none: an agent never closes Studio unasked), `do-it-for-me`,
`open-studio`, `cancel-get-studio` and `places` (no card; `places` lists open Studios and Studio's
recent files, never Documents), beside `use-project`, `new-game`, `publish-update` and
`first-publish`. Their answers, the connection's refusals ("isn't open for this game", "isn't
answering", "isn't linked") and the engine question's words name the tool for the next step,
never a click for the person; only signing in, macOS's own prompts and Studio's or Roblox's own
questions stay theirs. `do-it-for-me` starts the MCP switch's click itself when Studio is open,
set up and silent with its switch off, and otherwise answers which tool does the step that is
missing (`get-studio`, `restart-studio`, `open-studio`); a plugin that came with Genex may start
its setup assist from its own tool with no card of its own, computer control's card asking only
while the setting is off. The turn that answers the assist's message clicks it itself: its own
`do-it-for-me` answers `in-assist` and posts nothing. Where Genex can't click and Studio has no
settings file yet, `restart-studio` can't switch the MCP server on either, so that one click is the
person's and the answers give its path.

**Ask first.** Roblox's own AI tools, uploads and Creator Store inserts are plugin tools with a
`confirmation` card (`ai-tools.ts`, `insert-asset.ts`, `AskFirstTool` in `studio-tools.ts`), so
they ask the person every call in every chat mode, Bypass included: they run on the person's Roblox
account, against its limits, and Roblox's moderation of what they make or upload lands on that
account. Each card is at most 300 characters and says what goes to Roblox. `generate-mesh`,
`generate-model` (Studio's `generate_procedural_model`, about 50 a day), `generate-texture`,
`generate-material`, `segment-mesh`, `roblox-playtest` and `roblox-explore` (Studio's `subagent`
types `playtest` and `explore`), `upload-image`, `store-image` and `insert-asset` each call one
Studio tool in the game's own Studio as its helper is bound, `studio_id` filled by the backend.
Lists (part names, pictures) arrive as one string, comma-separated or a JSON array, and are checked
with every other argument before any call; what is refused reaches no Studio, and Studio's own
refusals (such as the daily cap) reach the agent in its words. The tools that change or play the
place hold the `studio` lock and run under the agent's marks (the playtest agent under the play
mark). Pictures are `.png` or `.jpg` files of at most 5 MB in the game folder, read with no link on
the way and checked by their first bytes, or `https` addresses on public names: `store-image` hands
Studio a private copy in the storage, removed when it answers, and `upload-image` serves the game's
pictures on 127.0.0.1 at random paths only for the call, answering each picture's `rbxassetid` by
the name the agent gave. `insert-asset` takes an id of plain digits, reads the price first (Studio's
`search_asset` for that id; one it doesn't find by its product info in Edit, free only when public
or the signed-in person's own), refuses a paid asset with nothing inserted, and answers every
script the asset brought, flagging `require` with an id, `loadstring`, `getfenv`, `HttpService` and
`MarketplaceService`.

**Models.** `check-model` (no card, no lock) runs the asset gate (`asset-gate.ts`) over a `.glb` or
`.gltf` in the game folder: at most 20,000 triangles, closed (every edge, once vertices at the same
place are welded, shared by exactly two triangles), one material, at most 4 bone influences per
vertex, the scene's roots at the origin, and textures at most 1024 by 1024 (`textureSide` asks for
less), their sizes read by hand from the PNG `IHDR` or the JPEG frame marker. The file is read as
hostile input: a plain path inside the game folder with no link on the way, a size cap checked
before any read, a GLB read stage by stage so nothing past a broken header is read; a `.gltf`'s
buffers and pictures follow the same rules or come inline as `data:` addresses. An FBX is answered
with how to export `.glb`, and a Draco or meshopt export with how to export one uncompressed.
`import-model` (a card; the `studio` lock) runs the gate and sends only a model that passes to the
helper's `model.import` (`model-import.ts`), as the helper's own mesh (`GXM1`) converted from
glTF's metres to studs, under the agent's busy mark; the helper builds an anchored MeshPart at the
origin, and the mesh is uploaded to the person's account only when they publish. Only the shape
comes in. When Studio can't add it, the answer names the checked file and Studio's own File ›
Import 3D.

**Publishing** (`publish.ts`, the `publish` skill). No Studio or plugin API publishes a place, and
Open Cloud's place publishing takes API keys Genex never asks for, so publishing is a Do it for me
that the person approves on a card: the game's changed script files go to Studio first, then the
game's chat is handed the task through `game.engine.assist`, and the turn that answers it (the
agent's own turn when the message joins it) clicks File › Publish to Roblox in Studio itself, as
the `publish` skill says. A place never published gets **Publish to
Roblox** (the panel's `first-publish`, native, with a name field filled with the game's title, its
card naming the name; the agent's `first-publish {name}`, whose card shows the name in a field the
person may edit, `confirmationInput`): "Publish this place to Roblox as a new game named "<name>"…",
keeping Studio's privacy and settings and an empty description, stopping at any age, ID, two-step,
terms or payment question. The name is one plain line of at most 50 characters (the game's title,
else the place's name); the agent's `name` is required, and one Roblox wouldn't take as the card
showed it (empty, longer, double quotes) clicks nothing and asks for one that fits, never
publishing under another. A published place gets **Publish an update** (`publish-update`, which
first links a place just published by hand): "Publish <place> to Roblox: File › Publish to Roblox
in its Roblox Studio window…". Each answers the other's case with the right tool, clicking nothing.
The place block keeps Studio's click path under either button, and where Genex can't click (no
driver, Windows, or the person said no), the answer and the block give it instead.

**After a publish** (`relink.ts`) Genex links the game to the published place by itself: Studio
reopens a newly published place under its name ("<name> (placeId: N)"), which the game's link no
longer matches. A first publish leaves a note (`publish/<game>.json`: the name, the linked
project, the Studio holding the game (the bound one, else one showing its own place) and the places
already published in the open Studios) for `PUBLISH_NOTE_MS` (30 minutes) once the chat has started
it; a hand-over the chat refused leaves none. Where Genex can't click, the panel's status leaves it
once per Studio holding the game when it shows Studio's clicks, never again as the panel keeps
looking. With no Studio holding the game nothing is noted, and only a note that names one follows
a reopening by name. The panel's status,
every Genex moment and each publish call then ask the Studios that could be the game's whether
Roblox has their place now: the noted Studio, the one bound now, and, once no open Studio still
holds the game's own unpublished place, one whose place carries the noted name. With no note, the
Studio the game's helper was last connected from is asked within `LOST_STUDIO_MS` (10 minutes) of
losing it while its place carries the game's own name or title, or while connected when a publish
call asks. Exactly one place published after the note that no other game builds in is linked with
its `remote` ids and its published name, keeping the link's project; the chat shows it with Undo,
and Use in this game is never needed. After Undo, or a link the host refused, the game finds its
own place file again: a place record with ids its link lacks is not followed by name. Two candidates, a place published before, a place another
game holds, or an old note link nothing.

**Moments, the person first and pictures.** The handlers answer in hook terms when
`context.hook` is set (`studio-moments.ts` over `MomentOps` from `moment-ops.ts`, words in
`hook-answers.ts`), each hooked for games with the `roblox-project` fact; nothing hooks `run.end`,
so the person's Studio stays open when a run ends.

| Handler at its moment | In a run | In a chat |
| --- | --- | --- |
| `open-for-run` at `run.prepare` | quiet once the helper is connected and answers; opens the place (`open-studio`'s way) and waits up to `OPEN_WAIT_MS` (3 minutes) for its helper (a note names the place); blocks with the step when Studio isn't set up, the game has no place, the helper doesn't answer (a dialog may be open) or never connects | — |
| `team-note` at `turn.start` | notes who else is in a Team Create place, only when that changed | same |
| `save-place` at `checkpoint.before` (`messages: true`) | sends the script sync's pending file changes, then has the helper export what changed into `.genex/place/` (up to 2 minutes); blocks while Studio isn't connected or the export fails | the same within the message's wait (`SAVE_PLACE_CHAT_MAX_MS`: the flush and `PLACE_EXPORT_MAX_MS`); never blocks, notes what it saved or why the checkpoint holds the scripts only |
| `hero-shots` at `checkpoint.after` | Studio's `screen_capture` of the game's Studio as one `viewport` picture | nothing |
| `save-place` at `restore.before` | the same export, so the newer state is saved first (Bring back newer version); blocks when it fails; notes that going back undoes the edits of others in Team Create | same |
| `load-place` at `restore.after` | the helper loads the restored export, then the script sync reconciles `src/` with the restored files winning (git put back `src/` and the record together, so Studio's listing stands in for the record), whether the load ran, failed or found no export; with Studio not connected, `pending-load.json` and `pending-scripts.json` wait and the helper's next connection loads the export, then lets the restored scripts win; never blocks | same |
| `studio-state` at `health` | quiet while the helper answers a ping within `STUDIO_PING_MS` (5 s) and Studio's MCP server lists the Studio; pending while Studio starts, its helper reconnects (`RECONNECT_WAIT_MS`), it doesn't answer ("a dialog may be open in Studio", with the hint to look with `app_look`, look only, on a Mac) or isn't listed; blocks when Studio is gone, open without the place past the reconnect wait, unlinked or not set up | same |
| `studio-crash-note` at `crash` | asks the person to reopen Studio with Open Studio; Genex never closes or kills it | same |
| `luau-note` at `worker.end` | the Luau checks over the scripts changed since they last passed, in the folder the call is bound to; a note of each finding, nothing when clean or not added | same |
| `luau-finish` at `finish` | the Luau checks over every script; errors hold the finish back, naming the first; warnings, format differences and missing checks are notes | — |

A helper that answers `unsupported` to an export (Studio with no way to serialize the place) never
blocks: the note says save points hold the scripts only. A part larger than the host's 50 MB file
cap is named in the note, and the host's checkpoint leaves it out and names it too. Only
`load-place` needs the `studio` lock: exporting and pictures read the place, so a message's
checkpoint never waits on the person. The lock's probe `studio-activity` answers `personActive`
from the helper's `activity` reports in the last `PERSON_ACTIVE_MS` (15 s), leaving out what the
agent's marks cover (`agent-marks.ts` in `<storage>/mcp/<game>`: `agent-busy.json` around the
connection's writes, 3 s after it included, since Studio records `execute_luau` runs as edits;
`agent-play.json` during the agent's play test; Genex's own load and reconcile run under the busy
mark too, and so do its own reads in a Studio another game is bound to (the helper link's marker
reads, Choose your place asking each Studio for its place); a mark older than 30 minutes or dated ahead is not believed); it claims nothing unsaved.
The `viewport` [observer](#observers) runs `hero-shots` and shows Live's `stills`.

Its skills reach a game that holds a Roblox place only (`facts: ["roblox-project"]`, never
`engines`): the inline `roblox-studio` (scripts are files, play goes through `computer` and
`judge_play`, the desktop tool never builds or play-tests in Studio, Roblox's AI tools, uploads and
inserts ask) and the file skills `luau`, `remotes` (server-authoritative), `player-data`
(session-locked, `UpdateAsync`, `BindToClose`), `purchases` (idempotent `ProcessReceipt`),
`ui-scale` (`UIScale`, `ScreenInsets`, touch targets), `assets` (Roblox's mesh and texture rules)
and `get-started`, adapted from Roblox's MIT `roblox-get-started` skill
([notices](../THIRD-PARTY-NOTICES.md#adapted-roblox-skill)). A web or Unreal game reads none of
them and is not offered `roblox__skill`.

## What Studio records around a tool call

A plugin never has to report its own activity, and Studio never takes a plugin's word for it. The
host writes two thread events around every tool call, on every engine path — the chat's local
harness, a delegated builder, the lead's own session and the `plugins.invoke` RPC:

- `plugin_tool_started`, before the backend is called: a `callId`, the plugin's id and display
  name, the bare and namespaced tool names, a one-line digest of the arguments, the project and
  thread, and the worker attribution (`runId`, `facetId`, `iteration`) at the payload's top level.
- `plugin_tool`, after the call returns or throws: the same fields plus `ok`, `error`, a capped
  digest of the result, how many images came back and — when the result is shaped like a job
  record — `jobId`, `generationId` and `files`.

Neither payload can carry image bytes, data URLs or credential-shaped keys: the digests drop them
before the event is written. The chat folds the pair by `callId` into one row of its work group,
and the Builds graph draws one asset job per call (asked for → making → delivered or failed),
joined to the `asset_delivered` record on `jobId`. Both are host-owned: a plugin cannot forge
them, and cannot suppress them by staying quiet. A run's sub-agent's calls carry its run and its
agent id (`attribution`) as `runId` and `facetId`, so they land on its own node. A tool only the
harness calls (`"audience": "harness"`, such as the Unreal Loop's editor polls) is a step of the
harness's loop, not an agent's work: it runs only as the harness's own step (`plugins.invoke` with
`step: true`; an agent's call is refused), with no pair, or a run's polls would bury the calls the
chat and the graph are for.

A connector call (a plugin's MCP server, or one the person added) gets its own pair:
`connector_tool_started` once consent allows it out and `connector_tool` when it ends, paired by
`callId` (`plugin-tools.ts`, `connector-record.ts`). Both name the plugin that ships the connector
(`pluginId`, `connectorName`), the toolset and tool a toolset gateway reached (Epic's `call_tool`:
`toolset_name`, `tool_name`) and that tool's own arguments, clipped to 1 KiB of JSON with
credential-named fields redacted. The closing record adds `ok`, the error or the first 4 KiB of the
answer, and the pictures: each image part is counted and, when it is a real picture of at most
16 MiB, saved in the game's `.studio/captures/` (`captures` lists the game-relative paths; past 60
files or 128 MiB the oldest go, and only files the host named). A `.studio` or `captures` that is a
link is never written through. The chat makes one row per call from these records, never from the
agent's own mirror of the call (`chat/connector-steps.ts`, `words.ts` `connectorStepWords`).

**Outcome unknown.** A call that went out and ended before it answered may have taken effect, and
Genex never sends it again. Its closing record (`plugin_tool` or `connector_tool`) carries `cutOff`
saying why (`CallCutOff`, `shared/plugins.ts`): `harness-ended` when the harness died under it,
`plugin-ended` when its plugin's backend exited, `app-lost` when a connector's error answer carries
`_meta: {"genex/outcome": "unknown"}` (`CONNECTOR_OUTCOME_META`, the Unreal bridge's crash answer),
and `turn-ended` for a Genex tool call a Claude Code session made after its turn had ended (a
background task woke it; `DelegateResult.cutAfterTurn`): the CLI answers such a call with its own
"The user doesn't want to take this action", and the notice says that was not the person declining.
The host notes it for the thread (`cut-off-calls.ts`, memory only), and the thread's next delegated
session reads a notice first, once, naming each call and saying to look at what it was to change
before repeating it (`delegation-prompts.ts` `cutOffNotice`). When the harness dies, plugins are
not stopped: their backends, unlocked accounts and connectors stay up, and only the calls in flight
end (`PluginRegistry.abortCalls`, `recovery.ts` `onHarnessDied`); quitting the app stops them all.

## Assets being made

While a call that makes an asset runs, the Assets canvas and the chat show it as one card in the
spot its files will land: the kind's drawing, the tool's name and picture, a clock and the prompt
(`shared/asset-making.ts`, `renderer/asset-making.ts`). A tool says what its calls make with
`tools[].asset`: `kind` one of `character`, `creature`, `model`, `rigged-model`, `animation`,
`image`, `texture`, `video`, `sound-effect`, `music`, `voice`; `prompt` the parameter that says what
to make (default `prompt`); `tool` the outside service doing the work (else the plugin's name, with
its icon). An MCP server, a plugin's or one the person added, says the same per tool in its
`tools/list` entry: `_meta: {"genex/asset": {kind, prompt?, tool?}}` (`MCP_ASSET_META`); a
malformed one says nothing. Either changes how a call is shown, never what it may do.

The host stamps the declaration on the call's own record (`making` on `plugin_tool_started` and
`connector_tool_started`, the prompt cut to 1000 characters) and lists the call in the game's
inventory (`ProjectAssets.jobs`, `jobId` the call's id) from the moment it goes out until it
answers, announcing each change (`asset.jobs`). The list is memory only (`main/core/asset-calls.ts`):
a call the app did not see end never shows as still being made. Genex's jobs come from its own job
records instead, with their kind, routed tool and phase (queued, making, waiting for a choice, not
downloaded, not in the game, failed, stopped, not confirmed): a request refused before Genex
started a generation has none, and one still making past `GENEX_MAKING_MAX_MS` is not confirmed.
Only media is an asset: a generation's data files are not, and a provider's `source` copy folds
into the finished model of its generation (`withoutGenexSources`). The chat's work shows the same cards
for its steps, read from the inventory by the call's, job's or generation's id, so a card ends
with its job; Bundled Blender declares `model`.

## The tool consent model

A tool declared with `confirmation` is an agent-invoked tool that spends, publishes or otherwise
acts beyond the game folder. One action beyond the game folder runs unasked: `unreal__use-project`
setting up a project it links (`game.engine.link {setUp}`), because the chat's one Undo takes back
the set-up with the link. The host — never the plugin, never the agent — asks the user:

- The registry's `consent` hook is called with the plugin id, the tool declaration, the arguments
  and the binding before the backend sees the call. When Studio has no way to ask (no hook in
  this session) the call fails closed: `This tool requires user consent, which is unavailable in
  this session`.
- Approval comes only from the user (`by: 'user'`). A request that times out, or whose run is
  stopped or whose turn ends first, is declined with `by: 'timeout' | 'stop' | 'turn'`. Agents
  never approve; a panel never supplies its own answer.
- A declined or expired request reaches the agent as **text** — `{consent: 'declined', by, message}`
  — never as a thrown error, so the model reads it and moves on. Skills that ship confirmed tools
  should say not to repeat a declined request.
- `tools()` keeps `confirmation` on the declaration so an engine can show it; engines do not
  enforce it themselves. Every agent path goes through the same host wrapper — an engine's live
  tool and the harness's `plugins.invoke` alike — so a confirmed tool cannot be reached around
  the card.
- The question and its answer ride the asking thread's log as `plugin_consent` events, which the
  chat folds onto one ASK card with Approve and Decline. The card's own channel,
  `studio:plugins.consent`, is Studio-UI only: it keeps the main-frame guard and the core's RPC
  table has no equivalent method, so nothing an agent can call answers a card.
- A card with a field (`confirmationInput`, API 3) shows the agent's value for that parameter under
  its question, in a field with the declared label. The person's own Allow sends what the field
  holds (`studio:plugins.consent {input}`), and the call runs with it as that parameter when it is
  one plain line of 1–200 characters; otherwise the agent's value stands. The answered card records
  the value the call ran with. A yes from a mode never edits. The Roblox plugin's `first-publish`
  uses it for the game's name on Roblox.
- A local plugin's agent tools ask too, each call, even with no `confirmation`: the card says the
  plugin was loaded from a folder on this Mac and runs with your access, and offers **Always
  allow** for that one tool. The grant (`PluginInfo.allowedTools`) goes when the plugin's code
  changes (an update or reload) or it is turned off; its page lists the grants with **Ask every
  time** (`studio:plugins.forget-allowed`). A yes answered after the plugin was loaded again or
  turned off runs nothing and keeps no grant: the call is refused and asks again. Its harness steps
  (hooks, `personFirst` probes, observers, `ready`) run without a card; the trust dialog names each
  kind it declares. Bypass, a run's own consent and an agent's message never answer it.
  A tool with its own `confirmation` asks it after those words, every call, with no Always allow, and
  so does each tool of a local plugin's own MCP server (`mcpServers`): no saved grant, Bypass or run
  answers for those either.
- Timing: a question nobody answers ends after nine minutes (`by: 'timeout'`) — deliberately under
  the Codex bridge's ten-minute tool ceiling, so the engine hears an answer instead of a dead tool
  call. It is not a no: the card reads "Nobody answered", and the agent reads that the person may be
  away and to carry on with other work and ask again later.
  Stop, a harness that died and the end of the turn withdraw the questions in their scope first.
  A run's session the user declined is not asked the same call again until the run is resumed, and
  a chat's not until the user writes again; a card nobody answered is no decline, so the next ask
  gets a new card. A build's lead, the
  chat's main agent, is asked each time. It is not the chat's turn either: its questions and
  connector calls outlive the chat's other turns and end with its own session instead. Its tools are bound to the worktree it leads, so
  what they deliver lands with the build ([tool permissions](tool-permissions.md)).
- The run's own consent: a Loop's lead in place (or the Unreal runner's, behind its switch: a
  director session whose grant is honoured for its own game's folder) calls its game's engine
  connector with no card while
  its run is active (held awake by the harness and running by its records), the run is this game's
  and was started in the chat the delegation names, and the connector belongs to the `game-engine`
  plugin holding the game's current link (`delegation.ts` `#runConsents`). Another game's run, a
  finished run, another connector, a web game, the chat's own session and a delegation naming no
  chat or another chat of the game still ask; that chat's Plan mode refuses before any of it. That session has
  no window: it gets only the run tools the harness forwards, never the computer, `look` or capture.

## Backend SDK

Export `async activate(host)` returning `tool(name, args, context)`, `action(name,args,context)`
and optionally `review(name,args,context)`. Initialization must be side-effect-free and must not
need host services: installation probes load the backend without account/project authority.
Context supplies project/directory/thread binding, an AbortSignal and `host(method,args)`.
Do not save the context globally; concurrent calls can belong to different workers. Host services
answer only during an active invocation: work that outlives the call (an upload, a long publish)
must finish detached and be polled through another tool or action, because a detached task's
`host(...)` call has no invocation to answer it.

A backend starts with `PATH`, `HOME`, `TMPDIR` and nothing else of Studio's (`pluginBackendEnv`).
Its `PATH` is the user's login-shell PATH Studio resolves for builds (`toolchain()`), else Studio's
own: an app started from the Finder has only `/usr/bin:/bin:/usr/sbin:/sbin`, where a backend
finds none of the user's tools (Genex's publish found no Homebrew `git-lfs` there).

Available services are capability checked and scoped to the calling plugin:

- `settings.read`: defaults plus host-owned settings; edits come from Studio's standard controls.
- `storage.root`: plugin-owned durable storage, outside games and exports.
- `project.read` / `project.write`: relative files in the bound worktree; private/internal paths
  and traversal are refused. Existing parent directories are required for writes.
- `assets.deliver`: copy plugin-owned output into a unique project asset directory
  (`assets/<plugin>/<job>/`: under `public/` for a web game with a build, under a Godot project's
  folder when the game has no web game at its root, `deliveryFolderFor` in
  `shared/project-workspace.ts`), refusing symlinks and overwrites; requires `project.write`. Studio records each delivery in the project's
  log as a host-owned `asset_delivered` event (plugin id, job id, files, sizes, kinds) and shows it
  on the Assets stage tab; plugins do not need to emit anything for that, and a ledger failure
  never fails the delivery.
- `jobs.read` / `jobs.write`: durable provider references, not a credit ledger.
- `events.emit`: sanitized progress to Studio, with host-bound project/thread attribution. A
  payload of kind `toolbar` is a toolbar status update (see above).
- `observe`: current game loading/capture/audio evidence for authorized local files. With
  `still` (API 3, additive) it photographs one named view instead: `{ project, root, files: [],
  still: { demo | camera, width, height, maxBytes? } }` loads the bound game on a hidden window of
  its own at `width`×`height` (whole pixels, 320–1920 × 240–1200), puts it in play, runs the
  `config.demos` entry to its end state or places the camera (one the page lists in `cameras()` or
  `eyes()`, or `default`; any other name is never called), and reads the canvas. The answer is `{ still: { image, mimeType, width, height, source,
  view, stats, preview } }`: a PNG, or the first JPEG at quality 95, 90 or 85 that fits `maxBytes`
  (64 KiB–16 MiB, default 8 MiB), never larger than asked; `stats` holds `lumaMean`, `lumaStdDev`,
  `nearBlackFraction` (luma below 0.10) and `litFraction`, each 0–1 on a small downscale; `preview`
  is a JPEG at most 1280 px. Otherwise it is `{ stillProblem: { code, reason?, available? } }` with
  `unavailable`, `load_failed`, `view_unknown` (with the names the game has, at most 32),
  `view_failed`, `capture_failed`, `too_large` or `timeout` (one minute for the whole still). A
  still never borrows Live: a build with no hidden window answers `unavailable`. Every field is
  checked before anything runs, and the window is given back however the still ends; once its
  budget gives a still up, nothing reaches that window again, and a closed preview refuses every
  later call rather than build a new view (`core/view-still.ts`).
- `export.stage` (capability `export`, API 2): Studio writes the public export of the bound game
  under the plugin's own storage (`publish/<project>/dist`) and returns the export result; it
  needs a project binding and is `Export unavailable` in sessions without the host export. The
  target is Studio's, never the game folder: the plugin names no path and the same audited
  exporter the Export button uses does the copying. The copy carries no package.json, so the
  result's `genex` field holds what the game's own one tells Genex (its Genex SDK versions and
  `genex` settings), read only when that file lives inside the game.
- `game.engine.link` / `game.engine.read` / `game.engine.steps` (capability `game-engine`): link
  the bound game to a project file of the engine the plugin declares (an Unreal `.uproject`, a
  Godot project's `project.godot`, a Roblox place), read its link, or show the plugin's steps card
  in the calling chat (see "A game's engine" below).
- `game.snapshot {reason}` (capability `game-engine`): an ordinary game snapshot of the bound game,
  listed in Rewind under `reason`, taken before the plugin changes files there (the Unreal plugin,
  before it updates the editor helper in the game's project). Refused without a bound game; a
  reason that is not one plain line of at most 200 characters is refused and takes nothing.
- `game.engine.runs` (capability `game-engine`): the games whose run (a Loop) is going now that this
  plugin linked to a project, each as `{game, title, project}`; no bound game needed. The host asks
  nothing while no run holds the studio awake. The Unreal plugin reads it so it never offers to quit
  an editor a Loop is using.
- `game.engine.assist {task}` (capability `game-engine`): Do it for me. Hands a setup task (one
  plain line, at most 300 characters) to the bound game's chat, posted there verbatim as
  "<plugin name> asks: <task>"; that chat's own session clicks it with the person's computer
  control, on the Mac apps the plugin's `engine.apps` declares and no others. It answers
  `{started, reason?}`, the reason one of `not-person` (a Genex moment's or an observer's step, or,
  from a plugin that did not come with Genex, neither an action the person pressed nor a tool call
  whose own `confirmation` card they approved; the host marks such a call `confirmed`; a plugin that
  came with Genex may start one from its own tools), `in-assist` (such an unasked one while the
  chat's own assist is under way: the turn answering it clicks), `no-chat`, `no-apps`,
  `unavailable` (a computer with no desktop driver: show the click path instead) or
  `declined`. A plugin that did not come with Genex shows the task on a card first, every time;
  with computer control off, the studio's own card offers to turn it on for every chat. It is for
  setup clicks and publishing the person approved, never for building or play-testing
  ([computer use](computer-use.md#the-persons-computer)).
- `game.engine.canAssist` (capability `game-engine`): whether Do it for me can run for the plugin
  on this computer: a desktop with its driver, and apps its `engine.apps` declares here (computer
  control that is off still counts, since its card offers to turn it on). It asks nothing and
  needs no bound game; offer Do it for me only when it answers true, and the click path otherwise.
- `sandbox.run {program, args, reads, writes, scratchEnv?, env?, timeoutMs}` / `sandbox.result {id}` /
  `sandbox.stop {id}` (capability `game-engine`, `substrate/plugins/sandbox-jobs.ts`): a long job of
  the plugin's (Unreal's package on Windows) run in the studio's ProcessSandbox. `sandbox.run` checks
  the request by real path (the program inside a folder it `reads`, no drive root or folder holding
  the home folder read, each folder it `writes` a real folder strictly inside the bound game and
  outside its hidden folders, no network share or device path, at most two running jobs per plugin,
  a deadline from 1 s to `PLUGIN_SANDBOX_MAX_TIMEOUT_MS`, 60 minutes), starts it and answers `{id}`
  at once; the host owns the job past the call, as `runtime.install` owns a download, and ends it
  with its process tree at its deadline, on `sandbox.stop`, and when the plugin's backend stops, the
  plugin is turned off or removed, or the studio stops. `sandbox.result` answers `running`, `exited`
  (with `exitCode` and each output stream's last 4 MiB, where a log's verdict is), `timed-out`,
  `stopped` or `failed` (an error code), or null for a job the host doesn't know (another plugin's
  included). The writes go to ProcessSandbox as the run's confinement and `scratchEnv` names
  variables set to folders in the job's own scratch. A `.bat` or `.cmd` program runs as `cmd.exe /d /v:off /s /c %GENEX_COMMAND_LINE%`:
  Git Bash would quote a prepared line again, so the host builds the line (`quotedScriptLine`: the
  file and every non-plain argument whole in double quotes, `-Name="value"`) and cmd.exe expands it;
  a quote, `%`, `!`, a control character or a backslash ending a quoted argument is refused. On
  Windows, srt-win grants writes for its whole session and refuses a per-command read grant, so the
  confinement there is the request rather than a fence, and the engine is read with the sandbox
  user's own rights ([Windows sandbox](windows-sandbox.md#residual-risks)).
- `credentials.read/write/clear`: plugin-scoped protected storage. Reserved account actions
  `unlock`, `connect`, `disconnect` authorize these operations; agents cannot invoke actions.
  Cache unlocked credentials only in the backend session. Background status must never unlock.

The host never retries a failed tool invocation. Persist remote references before returning and
reconcile uncertain submissions instead of creating again. Cancellation stops local waiting;
it does not promise remote cancellation or refunds. Genex keeps its CLI admission ledger as the
single billing authority. Every client of a Genex account shares one per-account request limit,
and a paid request refused by it fails: a status read asks Genex again only about generations it
has not seen settle (`completed`, `failed`, `canceled`; remembered by the backend until sign-out),
and the Genex page re-reads every 5 s only while a job is requested, submitting, accepted or
generating or a sign-in waits, otherwise once a minute (`genexPollMs`); behind another app it reads
once a minute (every 5 s still while a sign-in waits) and a hidden window reads nothing until shown.
A status read reuses a game's `genex budget` answer for 30 s, and any other CLI command in that
game forgets it. Plugin process failures
are shown in Plugins and reported as a `failed` change.

## Project facts

Every listed game carries `facts` (`GameProject.facts`, `shared/project-facts.ts`): what its folder
holds, as `{id, path, source}`, possibly several (`unreal-project` at `.` and `web-game` at
`site`). They come from a bounded walk of the folder (`substrate/project-facts.ts`: four folders
deep, 2,000 folders read, never through a link, skipping hidden folders, `node_modules` and the
folders engines write while they run) that keeps only the files a rule's glob names, at most 4,000
(`ruleFiles`), so a folder of other files (a run's thousands of screenshots) never uses up the walk
before it reaches a project's marker; the Unity plugin finds its project with the same walk. They
are matched against the core table (`web-game` by `index.html` outside
output and vendored folders, `unreal-project`, `unreal-plugin` outside a `Plugins/` folder,
`godot-project`, `unity-project`, `blender-assets`) and the `detect` rules of the **enabled**
plugins (an installed plugin that is off detects nothing; source `plugin:<id>`). A fact below a
folder that already has the same one is dropped. The engine link reads as its engine's declared
`fact` (`unreal-project` for Unreal) at the project file's folder (source `link`) and stands for the
game's project in that engine: another project of that engine the folder holds is not a second one. A scaffold recorded in `studio.json` adds its rules (source
`scaffold`, see [Scaffolds](#scaffolds)). Never counted: the web template beside an older engine link,
what a port replaced (`portedFrom` in `studio.json`, kept as the reference), and a starter an older
New game wrote that nothing has been built in yet (its `scaffoldStamp` still matching). A Unity or
Godot game's web version in `web/` (`ENGINE_WEB_FOLDER`, `Web/` too) is listed as its web game even
though a page at the root is above it; that root page is then left out when it is still the web
starter's page nobody built on (its `index.html` and `src/main.js` are the template's), whether or
not the port was recorded, and any other root page keeps its place (`withEngineWebVersion`). Live
loads such a web build by itself once it is finished (whole for its engine, no file written in the
last 2 s) and new since Live loaded the game (`PreviewService.offerLive`), and the game's file
server unpacks a Unity build's Brotli or gzip parts (`packedBuildFile`). The Web game tab on screen
asks for the same (`loadWebBuild`, decided in main in turn with Live's other loads, and asked again
while main answers `Unfinished`), so a game opened before its export existed shows it; never into a
stopped game or a build the person chose to view. New game
now makes an empty folder. Either way the game lists no facts and has no kind until its first
message picks one (`start_web_game`, or `game.start` from the harness, writes the web starter).
A Loop on any project that isn't a web game (`loopProfileOf`) is led in place by the chat's own
session, and the plugins whose facts reach the folder shape it with no code in Genex: their hooks
run at its moments, their observers feed its finish check and their worker types are its lead's
([the open Loop](harness-runtime.md)).
`web` is `web-game` at the root. A game New game made lists `awaitingFirstBuild` until an answer
in any of its chats, or a run on it, ends with the folder holding a kind (`core/build-ends.ts`);
it stays built after. `multiplayer` is set while the game's package.json names
`@genex-ai/multiplayer`, its page maps Studio's copy, its Godot project carries Genex's
multiplayer addon (`godot/addons/genex_multiplayer/plugin.cfg`) or its Unity project embeds Genex's
package (`[unity/]Packages/com.genex.multiplayer/package.json`) (`usesGenexMultiplayer`); a build's end tells the game list when it changed. The stage strip's
Multiplayer shows only on a built game that is not multiplayer (`showsMultiplayer`), and on an
engine's web export only for a Godot or Unity game (`takesEngineMultiplayer`), whose project takes it.

### Workspace rules

Before a game folder's first commit Genex writes the generic rules into its `.gitignore`
(`substrate/nested-repos.ts`: `.studio/`, `node_modules`, build output, `.env`, …) and then the
rules of the facts the folder holds; before every later snapshot and chat checkpoint it tops up an
existing file with the facts' rules alone (so a port never sweeps the new engine's scratch into
history, and a generic line the person removed, or a file they deleted, stays that way). The rules are those (`shared/project-workspace.ts`): Genex's table (`unreal-project`
`Saved/`, `Intermediate/`, `DerivedDataCache/`, `Binaries/` and its plugins' builds;
`unreal-plugin` `Intermediate/`, `Binaries/`; `godot-project` `.godot/`, keeping `*.import`;
`unity-project` `Library/`, `Temp/`, `Logs/`, `obj/`, `UserSettings/`; `blender-assets` backups at
any depth; none for `web-game`), then each enabled plugin's `workspace.ignore`, in plugin id order.
Every rule is anchored at its fact's folder (`/Saved/` at the root, `unreal/Saved/` for a project
in `unreal`), so a Unity `Library/` never hides a folder of that name inside `Assets/`; a pattern
starting `**/` reaches any depth below it. A plugin's `workspace` and `assets` reach the facts its
`detect` declares, or the 1–8 fact ids `facts` names (a plugin with no `detect` must name them).
Patterns use the facts' glob grammar, at most 16 per list and six segments each; one that is only
`*`, or can reach `studio.json`, `.gitignore`, `.git`, `.studio`, `.claude` or `references` (by name in
any case, or by a wildcard in its first part, or in any part after `**/`, such as `.*` or `*.json`), is
refused with the manifest. Rules follow the folder's raw facts (an untouched starter and a port's reference count); a fact in a
folder with characters an ignore line can't hold (or outside the game) gets none, a line the file
already names in any spelling (`Saved/`, `Saved/*`, `/[Ss]aved/`), or makes an exception of
(`!Saved/Config/`), is not added, and a `.gitignore` that is a link or no plain file is left alone:
nothing is written through a link. Files already tracked stay tracked, in history and in chat
checkpoints; checkpoints leave a rule's other matches out even when an earlier checkpoint captured
them, a rewind leaves them as they are, and restoring a save point never cleans away what the
rules ignore now; both write those rules back into the restored `.gitignore`, so what they leave
on disk stays out of every later commit. A line of the person's git reads as matching nothing
(`[z-a]`) says nothing.
A worker's copy is a git worktree and always holds every tracked file: `copySkip` and the ignore
rules apply to what it receives outside history, the files of the game's nested repositories (only
the ignore rules when the copy versions them). The Assets tab lists the media of `assets/` and
`public/assets/` (images, models, audio, video; data a script writes there is no asset, and a
model's `.bin`/`.mtl` stay readable beside it), then the folders of the facts the game holds (`assetFoldersFor`: none for `unreal-project` and
`unreal-plugin`, whose `.uasset`/`.umap` packages have no preview; `godot-project` the folder's media; `unity-project`
`Assets` media; `blender-assets` `.blend` and media; a `web-game` below the root its own two), then
each enabled plugin's `assets.folders` at its facts' folders, keeping only its `formats` (none: any
file). `assets.folders` may not name a hidden or bookkeeping folder. Each folder is walked only by
its exact spelling on disk (on a case-blind disk `assets` is not Unity's `Assets`) and a link at any
part of it is reported, never followed; a folder that is the fact's own (`.`) never enters hidden
folders, `NOT_WALKED` ones, `dist/`, `output/` or the root's `references/`, in any case. Previews and the canvas
reader open what those walks reach only (`isAssetPath`), plus a model's `.bin` and `.mtl` beside it
in a folder that lists models.

### Worker types

`workerTypes` (API 3, `substrate/plugins/worker-manifest.ts`) names the kinds of worker a lead may
start while the plugin is on (`shared/workers.ts`): `id` a slug (`^[a-z][a-z0-9_-]{0,39}$`, unique
in the manifest), `description` 1–200 characters, `tools` 1–8 distinct names and `isolation`.
A tool is the plugin's own agent tool by its name (`check-part`), or another plugin's by prefix
(`blender__`, every tool of it) or agent name (`genex__asset`). `isolation` says how the worker
stands in the project: `read` works in place and writes nothing, `copy` writes in a copy of its own
and hands its work back for the lead to merge (a copy follows the [workspace rules](#workspace-rules);
a copy too large to make is refused, and the lead is told to start it in place or as a reader), `lock` writes in place,
one such worker at a time per game. The registry's `workerTypes(scope)` lists the enabled plugins'
kinds in plugin-id order, each tool as an agent name (`<plugin>__<tool>` for the plugin's own), and
leaves a kind out when none of its tools reaches the game ([Scope by facts](#scope-by-facts), the
other plugin being on); the first declaration of an id wins. The bundled plugins declare the
Unreal lead's kinds: Unreal `cpp` (`check-part`, so only on an Unreal game), Local Blender
`blender_model` and `blender_prep`, Genex `genex_cast`, `sound` and `texture`, all in copies.
The harness reads a game's kinds with `plugins.workerTypes {project}` (by the game's facts, as
`plugins.tools`); `worker_start`'s `type` gives a worker its kind's tools (`toolAllow`) and, unless
the lead says otherwise, its isolation ([harness runtime](harness-runtime.md#workers-in-a-chat)).

### Scaffolds

`scaffolds` (API 3, `substrate/plugins/scaffold-manifest.ts`) names the kinds of project the
plugin's tools make: `id` a fact id, unique in the manifest; `label` 1–40 characters ("Unreal
plugin"); `tool` an agent tool of the manifest that declares `makes`, named by one scaffold only;
`game: false` when what it makes is no game (the Unreal plugin's "Unreal plugin"): the new game's
question never offers it, and the agent makes it when the request asks for it; `facts` at most four rules
in the `detect` grammar, each of a fact that tool makes (a scaffold with `facts` needs a `tool`).
Each scaffold whose tool reaches a game is a kind on offer of its own, named by its label (a plugin
with no scaffold naming a tool offers each reaching `makes` tool as before; one without a tool
offers nothing). Once a scaffold's tool made one of its kinds (`main/core/kind-change.ts`: a fact
its rules find counts as made only when it was not there before the call, read with the same rules), Genex
writes `scaffold: {plugin, id, label, facts}` into the game's `studio.json` beside `portedFrom`;
its rules join the folder's walk with source `scaffold` while the plugin is on or off, and the
listed game carries `scaffold: {plugin, id, label}`. A brief treats a plugin's own fact found only
by such a record (not by its plugin's `detect`, so the plugin may be off) as one Genex's own kinds
are: it looks for the plugin first. With no question card, a folder with no kind yet is told each
scaffold by its label, beside its own tool. A record that doesn't parse in full
(`parseScaffoldRecord`) adds nothing. The sidebar shows a project that isn't a game by its kind
beside its name: while a fact its scaffold's rules found is there, the app's word for that fact in
the app's language (`Unreal plugin`) or else the scaffold's label; otherwise `Unreal plugin` or
`Blender assets` for a folder holding no game (`renderer/project-kind.ts`). The Unreal plugin
declares `game` (`Unreal game`, `new-game`) and `plugin` (`Unreal plugin`, `new-plugin`, a rule
finding `**/*.uplugin` but not under the Genex editor helper's folder, so a host project's plugin
in `Plugins/` is an `unreal-plugin` fact).

### Folders

`folders` (API 3) lists the folders outside the game the plugin's engine programs write to, each
`{path, why}`: `path` one folder starting `~/` or `/`, at most 200 characters, with no `.` or `..`
part and no glob; `why` 1–120 characters. Turning the plugin on approves them as write roots for
the engine programs of workers and jobs (the registry's `workerFolders()`, `~` expanded and
deduped); the trust dialog of every install or update (each path and why, new ones marked; an
install turns the plugin on), the plugin's page (Information, Folders: each path and why) and the
Turn on button of its suggestion card in the chat (on hover: "Turning it on lets its programs write
in: …") name them first. A manifest is
refused when a folder is `/`, the home folder or a folder holding it, `~/Library`,
`~/Library/Application Support`, `~/Documents`, `~/Desktop` or `~/Downloads`, or is, holds or sits
inside a login or Genex's own data (`~/.claude`, `~/.codex`, `~/.genex`, `~/.ssh`, `~/.aws`,
`~/Library/Keychains`, `~/Library/HTTPStorages`, `~/Library/Roblox`,
`~/Library/Application Support/Genex`), compared case-blind. The Unreal
plugin names the two its build tool writes: `~/Library/Application Support/Epic/UnrealBuildTool`
and `/private/tmp/.dotnet`.

### Hooks: Genex's moments

`hooks` (API 3, `substrate/plugins/hook-manifest.ts`; vocabulary in `shared/plugin-hooks.ts`) names
the plugin's harness tools Genex runs at its moments: up to 32 `{on, tool, facts?, messages?}`, each
`(on, tool)` once. `tool` is one of the plugin's own tools with `audience: "harness"`, no `confirmation`
and no `host`; `facts` (1–8 fact ids, each once) narrows it to the games they reach ([Scope by
facts](#scope-by-facts)). Another plugin's tool, an agent tool or an unknown moment refuses the
manifest. `messages: true`, only on `checkpoint.before` (a boolean anywhere, or on any other moment,
refuses the manifest; `false` is dropped), runs that step before each chat message's checkpoints too,
the one before its answer and the one after ([Before each chat message](#before-each-chat-message)).

| Moment | When | A `block` |
| --- | --- | --- |
| `run.prepare` | before a run's first turn | closes the run with the reason |
| `run.end` | after a run's last turn | is a note |
| `turn.start`, `turn.end` | around a turn of the lead or the chat | at the start: the turn does not run |
| `checkpoint.before`, `checkpoint.after` | around a snapshot Genex takes as a save point | before: no snapshot |
| `restore.before`, `restore.after` | around a restore of the game's files (`forPerson` for the person's own Rewind) | before: no restore |
| `worker.start`, `worker.end` | around a worker | at the start: the worker does not start |
| `tool.before`, `tool.after` | around an agent's call of one of the plugin's **own** tools | before: the call answers the reason |
| `health` | while Genex watches what the plugin drives | a failed check |
| `crash` | after a failed health check | is a note |
| `finish` | when the lead says the work is done | the lead keeps working |

A moment runs the enabled plugins' handlers in plugin list order, then declaration order
(`registry.hookPlan(on, game, own?)`); `registry.hookEvents(game)` lists the moments some plugin
hooks for a game. A handler is told the moment in `context.hook` (`{on, runId?, turn?, label?,
worker?, tool?, args?, forPerson?}`; `args` is a digest, never the arguments) and answers `{block?,
note?, pending?, images?}` (`hookAnswerOf`: reasons up to 300 characters, notes up to 2,000, at most
8 base64 PNG images of 8 MiB): `pending` asks Genex to ask again, anything else is ignored. A
handler never rewrites arguments and never gives instructions, and git stays Genex's: no handler
takes or restores a snapshot. The moments that write (`run.prepare`, `checkpoint.*`, `restore.*`,
`crash`) wait while the chat plans, except the person's own Rewind.
In a Loop on a project that isn't a web game, Genex asks `health` every 15 s while the Loop runs
(only when a plugin hooks it), fires `crash` on a block, and fires `restore.*` around the lead's
rewind and alone for its `restart` (offered only when a plugin hooks a restore moment), whatever the
plugin's engine ([the open Loop's turns](harness-runtime.md)).
Genex's own gates run beside the plugins' hooks at the same moments (`loop/builtin-hooks.ts`):
`web.ready` at `run.prepare`, only where a web game is served at the root, refuses a Loop whose page
lacks the files it needs; a plugin's project is never refused for a missing `index.html`.

Genex runs them in `main/core/plugin-hooks.ts` (`HookService`), each step as a harness step through
the registry, under the union of the steps' locks held for the whole moment (a checkpoint's before
and after steps and its snapshot together); a run's moments pass the locks its own workers hold
(`runHolders`), so its recovery never waits on its own writer in place. A run's start or resume
(`run.prepare`) waits up to 10 minutes for the person to finish in the app (`HOOK_LOCK_WAIT_MS`), the
chat's line saying so, then starts; a checkpoint waits a minute, a restore two, `health` not at all, the rest 30 s or less. The host fires `checkpoint.*` (`checkpoint.take`, and
the chat's `checkpoint` tool on a game whose plugins hook checkpoints, which then answers what was
saved and the snapshot's id), `restore.*` around every restore of a game folder (the person's file
Rewind with `forPerson`: no wait for the person or the plan) and `tool.*` around an agent's call of
the plugin's own agent tool, once the call's arguments passed and its card was answered yes (a
`tool.before` block is the call's answer, `{blocked}`, and the tool never runs; the call's record,
opened before its card, closes as not run with the block's words; `tool.after` notes join the
answer under `genex.notes`; each waits at most 15 s for its locks, passing no worker's lock as the
call itself passes none, and its steps share one limit of a minute however many the plugin hooks
there, a step still running then failing and no later one running). An agent's call has one
deadline from its start (`AGENT_CALL_MS`, within the engine bridge's 10-minute one): its tool
moments and its lock wait get what is left of it after the card, the lock wait leaving the call its
ceiling (and its after steps theirs, when its plugin has `tool.after` steps for the game), and a
call with after steps or locks still running where its after steps' time begins is ended,
answering that whether it took effect is unknown. Such a call with too little of its time left to
start (5 s or less, or no time for its before steps) does not run and answers `{notRun: true,
message}`, as does one ended before it was sent; a call with neither steps around it nor locks keeps
the time it always had, so an approved call is never cut for a late card. A connector's lock wait
leaves the call its connector's own time. The harness announces
the rest through `hooks.fire` ([harness runtime](harness-runtime.md)): a chat turn its `turn.*`,
every worker pool, the director's builders and the Unreal lead's typed workers `worker.*` (a
`worker.start` block starts nothing and writes no record), the director `run.prepare`, `run.end`,
each wake turn's `turn.*` and the lead's own `finish`, and the Unreal runner its moments. A step that fails blocks a
blocking moment (fail closed), is `pending` at `health` (Genex can't tell is never a crash) and is a
note elsewhere; a `block` at `health` is a failed check. Every note a moment's steps add is logged. A checkpoint asked only if unsaved is
skipped when every probe of its steps' locks answers `unsaved: 0`, or one can't tell; it reads
that before Plan mode holds it. When Genex itself holds a moment, a checkpoint or a restore back,
the block carries `hold` (`HookHold`: `plan`, `person_first`, `cant_tell`, `busy`) and the lock's
`label` beside its reason (on `HookBlockedError` too), at a writing moment (`crash`) as at a blocking
one, and so do Genex's own `pending` at `health` and its note at any other moment; callers word the
person's line from them, never from the reason, which is written for agents. After an agent's call
that ran, a `tool.after` lock not given is only a note that the call ran and its after steps were
skipped. A run's moments pass the whole-life locks its own workers writing in place hold, a chat's
moments its chat's workers' (the person's Rewind and `tool.*` pass none); a hold passes only when
every holder of the lock is itself or such a worker holding that very lock for its whole life, so
two moments still go one at a time and none walks into a worker's single call, on that lock or
another; a moment queued behind such a worker joins it once the worker's hold is given, or once a
waiter ahead of it gives up, and a lock passed into stays held until every holder lets go (a hold is
counted the moment it is given). A hold whose wait was stopped before it began takes nothing. A wait
on the person in a run's moment is told in the chat the run was started from. The run's or the
chat's Stop (`engine.abort`) ends a moment the harness asked for (`main/core/moment-stops.ts`), its
own plugin calls through `plugins.invoke` too, their waits for locks included, and so does the
harness's end, which also cuts off its own connector calls (`mcp.invoke`); a moment, hold or
connector call asked for by a harness that has ended by the time its handler gets to it runs
stopped, holds nothing or is never made, and a host call an ended harness process wrote is never
served. Once a restore's files may have changed its after steps still
run (a restart's announced `restore.after` too), and neither a Stop nor the harness's end cuts them
short (`STOP_OUTLIVING_HOOK_EVENTS`); nor does the harness's end, or the Stop of everything a
harness sends as it shuts down, cut a step of the person's own Rewind (`outlivesHarness`). A Stop during a restore's before steps runs none; a Stop during a
checkpoint's after steps keeps its snapshot, with a note that they were stopped.
`GameProject.hookEvents` lists a game's moments; absent, no plugin hooks it and nothing runs.

#### Before each chat message

A game chat saves the game folder before each message is answered, so Rewind can bring it back
([the conversation coordinator](conversation-coordinator.md)). An engine whose state lives in its
app and reaches the folder only when exported opts in with `messages: true` on that
`checkpoint.before` step; the host then runs those steps, and only those
(`registry.messageCheckpointPlan(game)`, `HookService.prepareMessageCheckpoint`), right before each
of the message's two snapshots (before its answer and after it, so what an answer changed only in
the engine lands inside its own pair and Rewind finds it as the chat's own), under their locks, told
`{on: "checkpoint.before"}`. A `checkpoint.after` step
never runs for a message, so no pictures are posted at every message. The steps live inside the
message's own wait (`CHAT_CHECKPOINT_WAIT_MS`, 30 s, in `main/core/rewind.ts`), not the plugin call
ceiling (`HOOK_CALL_MS`): the lock wait and the steps' shared limit are what is left of it, less 5 s
kept for the snapshot. Plan mode, a lock not given in time or no time left skips the steps; a step
cut short, a failure or a `block` is a log line. In every case the files are still saved: a block
never stops a message's checkpoint. A message answered again after a restart keeps its first
checkpoint and runs no step for it. A step that opts in must be quick; Unreal does not opt in, so its
editor is saved at save points only. Roblox's `save-place` opts in: its incremental export
(`SAVE_PLACE_CHAT_MAX_MS`) ends within the message's 25 s.

### Locks: the person comes first

`locks` (API 3) names what one holder at a time may use, such as an editor: up to 8 `{id, label,
per, personFirst?}`. `id` is a slug (`^[a-z][a-z0-9-]{0,39}$`, unique in the manifest); `label`
names the app the person sees, 1–60 characters on one line; `per` is `project` (one holder per
game) or `app` (one on this Mac). A tool's or a plugin connector's `needs` (1–4 of the manifest's
lock ids, each once) says which locks a call holds while it runs (`registry.needsOf(agentName)`);
`registry.locksFor(game)` lists the `project` locks an agent tool or connector reaching the game
needs (a harness tool's `needs` never counts: no worker calls it).
`personFirst` names a tool as a hook's is chosen, which does not itself need the lock, answering
`{personActive, unsaved?}` (`personFirstOf`; anything else means Genex can't tell). A lock grants
nothing.

Genex holds them (`main/core/plugin-locks.ts`). A call of a tool or connector that needs locks takes
them in one key order, first come first served per lock, and then asks the probe straight through
the registry, ending a probe's call when the wait does and never asking again once it ran out (a
hold with no wait left, `health`'s or one whose turn came as its wait ran out, asks once for at most
5 s, once for the whole hold however many locks it takes): while the person uses what the lock guards
(or Genex can't tell) it asks again every 5 s, and once a probe saw the person at it the chat's working line (a running build's line too) reads "Waiting for you to finish
in <label>" (`UiEvent.PersonFirst`, once per chat however many of its calls wait, each app's wait kept on its own); a "not using it"
answer stands 3 s, unless a later probe sees the person at it. A hold queued behind a holder that
waits on the person is refused as the person's (`person_first` or `cant_tell`), never as `busy`.
A probe may let agents go ahead of the person (`personActive: false` while they use it, the
plugin's own setting); the first time for a game it adds `wentAhead: true`, and the chat the call
answers to gets one line, "An agent used <label> while you were playing.", with a <label> settings
button that opens the plugin's panel (`agent_went_ahead`, `renderer/chat/WentAheadLine.tsx`).
A refusal for the person stands 30 s (`PERSON_REFUSAL_STANDS_MS`): a call on that lock in that
time asks the probe once, for at most 5 s, instead of waiting its whole wait again, so an agent's
calls sent together don't each wait four minutes behind the first.
An agent's call has its
arguments checked and its card answered before it waits (`registry.prepareTool`), and waits up
to 4 minutes (less when its call's deadline leaves less), then answers like a
declined consent (`{blocker: "lock", lock, reason, hold, message}`: `reason` the lock's refusal,
`hold` Genex's `HookHold` the harness words the person's line from, its record closed with the message); a
person's own action never waits for the person. A wait ends early when the person writes in the
chat the calling session answers (`engine.steer` handed it their message, natively or by a cut at
its next step): the call answers the refusal `person_wrote`, telling the agent to read the message
first and call again if it still needs the tool; only a wait ends so, never a lock already given. A worker writing in place holds Genex's in-place
lock and the game's `project` locks for its whole life (`locks.hold`/`locks.release`,
[harness runtime](harness-runtime.md#workers-in-a-chat)); its own calls pass them (on an engine the
host seats no worker on too, as `unseatedHolder`), still giving way to the person, and its line and row read "Working in <label>". Any end of the harness, a planned
restart's too (which stops the old harness first, once any boot already under way has finished, so
it never hears its moments stopped; the watchdog's rewind stops it first as well), ends the moments
it asked for, tells those workers' sessions (and its runs' leads in place) to stop and, once each has let go (at most 10 s, on the
locks' clock), releases what it held for its workers (`releaseHarnessHolds`); a planned restart's
boot notice carries the runs an earlier crash left open (`openRuns`); the host's own holds (a restore, the
person's Rewind) end with their own work. Genex's own hold of the person's Rewind is worded for them
from its hold and label.

`needs` covers one call, never a job it leaves running: a tool that answers at once and works on
in the background (the Unreal plugin's `add-cpp-module`, `reopen-editor`, `run-part`,
`play-check`) lets its locks go as it answers, so another holder may take the editor while the job
still closes, reopens or plays it. This is a known gap in "editor work waits its turn"; the Unreal
runner covers adding C++ with its own wait (`whileAdding`).

The bundled locks: Unreal's `editor` (probe `editor-activity`: a play neither the agent nor the
plugin's queue started) and Roblox Studio's `studio` (probe `studio-activity`: the person's
selections, undo and redo, their own recordings and typing in Studio within 15 s, the agent's own
marks left out), each named under its plugin above.

### Observers

`observers` (API 3, `substrate/plugins/observer-manifest.ts`; vocabulary in `shared/observers.ts`)
names what Genex can capture of a project, as evidence a reviewer reads: up to 8 `{id, facts, tool,
live?, label?, status?}`. `id` is a slug (`^[a-z][a-z0-9-]{0,39}$`, unique in the manifest), never `preview` or
`proof`, which are Genex's own; `facts` is 1–8 fact ids, each once; `tool` is one of the manifest's
tools as a hook's is chosen (only the harness calls it, it asks nothing and runs no host program);
`live` is the Live view Genex draws for it: `stills` or `card` (any plugin), or `unreal-card` (only
the bundled Unreal plugin); `status` (a `card` only, which needs it) names an action of the manifest
that asks nothing; `label` names that view's tab when a folder has more than one view (1–24 printable
characters on one line, not blank; shown as plain text), else the tab takes the plugin's `name`. A
label that repeats, in any case, a name the stage strip already shows (a reserved toolbar label such
as `Live`, `Builds` or `Assets`, or Genex's own `Web game` and `Unreal`) is refused. Only
these keys are kept. `observersFor` (`registry.observers(game)`) lists a game's
observers: each plugin's in plugin order, one per folder its facts reach (the hooks' rule), then
Genex's own `preview` of each folder served as a web game (a game with no kind yet at its root). Only
a plugin that is on captures (`registry.observerTool(key)` answers null otherwise). The bundled Unreal
plugin's `viewport` observer runs `hero-shots` and shows the Unreal card. The bundled Roblox plugin's `viewport` observer runs its `hero-shots` (Studio's viewport) as a `stills` view.

How Genex runs one (`main/core/observers.ts` `ObserverService`, host call `observers.capture`
[in the harness runtime](harness-runtime.md)): only inside a run of the game, each observer of a
plugin that is on in turn, its tool called as a harness step with `context.observe = {observer,
runId, why: "finish", withinMs}` (never `context.hook`) under the locks the tool `needs`. The person
comes first and the run's own holds pass, as for a moment of the run: a lock not given within 30 s
(`OBSERVE_LOCK_WAIT_MS`) is a `problem` on that capture worded by Genex's hold, never the lock's
text, and the tool never runs; a call is cut at 40 s (`OBSERVE_CALL_MS`). Both fit in the time the
harness still waits (`withinMs` of the call, counted from the moment it comes in), less 3 s
(`OBSERVE_KEEP_MS`) for keeping the pictures and the answer's trip: past that no observer is asked,
and an answer after it is neither kept nor recorded, so the whole answer reaches the harness in time.
`withinMs` tells the tool its own time, so it can answer the pictures it has (the Unreal viewport
answers the stills taken by then, and asks for none that could not land before it). The answer is read as
a hook's is (`hookAnswerOf`): `images`, `recording` (a short play recording, at most 8 frames in
order) and `note`; a `block` or `pending` answer, or a call that fails, is that capture's `problem`
and the other observers still run. Plan mode never holds a capture: it only looks. The pictures
(PNG or JPEG by their bytes, 8 MiB each at most) are kept under the run's folder
(`runs/<run>/observers/<plugin>-<id>/`) and recorded as one `observer_capture` (files, never
data); the harness gets them back downscaled to 1280 px for a reviewer's prompt. A run's checkpoint
whose `checkpoint.after` step is an observer's tool keeps that step's pictures the same way, as a
capture with `source: checkpoint`, written and recorded only (nothing resized; none when no picture
was kept; the checkpoint's own answer is unchanged; a chat's checkpoint keeps none). The Unreal `hero-shots` asked as the viewport observer answers the hero cameras' stills
as `images` when Unreal answers, and nothing when it doesn't.

Live's views of a game come from these observers (`renderer/live-views.ts` `liveViewsFor`), one per
kind of view and one per `stills` or `card` observer, ordered: the Unreal project the game's engine link names first, then the game's root,
then by view (the Unreal card or a plugin's `card`, Genex's preview, a plugin's `stills`), then by folder. The first is the
default. A folder with one view keeps the strip's Live tab; one with more (a web game and an Unreal
project) gets a tab per view in Live's place (`panels/stage/stage-tabs.ts`): "Web game", "Unreal", or
a plugin observer's `label`; the default's tab keeps `data-stage-action="live"`, the others
`live-<view>` (`live-unreal-card`), a plugin view's with its observer key (`live-stills-<plugin>/<observer>`, `live-card-<plugin>/<observer>`). The last one chosen is remembered per game
(`studio.liveView.<game>`), and a web build put on the stage brings the Web game view forward. `unreal-card` is the Unreal card (where the project stands, and the
newest viewport capture as its shot, else the newest save point's still); Genex draws it for any
Unreal project fact, whatever the plugin list says (off, removed, older, not read yet). `preview` is
the web preview, also for a game with no kind yet; no plugin's `stills` take it over. A plugin's
`stills` and `card` count only while the plugin is on, never from an unlisted package. A `card`
(`panels/stage/PluginCardStage.tsx`, `[data-stage-plugin-card="<plugin>/<observer>"]`) is drawn as
the Unreal card is: the observer's newest capture as its shot, else the newest save point's still,
the game's name, and the answer of its `status` action, asked every 3 s while it shows (one ask at
a time; an answer for the game before is dropped, `status-poll.ts`) and read by
`shared/plugin-stage-card.ts` `stageCardFrom`: `{line, hint?, button?}`, each one printable line (160
characters, a label 40), the button `{label, action}` naming an action the manifest declares (run as
the panel runs it, a confirmed one asking natively) or `{label, panel: true}` opening the plugin's
toolbar panel; anything else is dropped, and no `line` shows the game's name and "Plays in <plugin>.". A folder no observer
draws (Godot with its plugin off, Blender, files of its own) shows the newest capture's pictures of the run the stage
shows, or of the newest earlier run that kept some (`data-live-view="stills"`), else a sentence.
Run, Reload, Sound and Full screen show, and Live probes a page, only while the view is the preview.
A `stills` observer's view shows its own newest capture the same way.

### Scope by facts

A tool, a skill or a plugin's MCP server may name the facts it is for (`facts`, API 3: 1–8 fact
ids, each once); one that names none reaches every game. A session gets it when one of its game's
**served facts** is named: the game's facts, or `web-game` at the root while it has no kind yet
(`kindPending`); a folder of a kind Genex can't name (`holds` `own-files` or `unreadable`) is served
by none, so it gets no web-only tool or skill and no Publish.
`registry.snapshot(facts, offered?)` applies the rule (`pluginReach` in `shared/plugins.ts`) to the
tools, the guidance and the applied skills a delegated session is handed; the capability facts, the
composer's tool count for a game and `plugins.tools {project}` (the local harness) read the same
rule, and `mcp.toolsFor(project, {facts})` leaves out a server that does not reach. A skill that
names `tools` reaches only while one of them does. A skill that applies only below the root says
where after its name: `[example/page] (for site/)`. A tool's `makes` (1–4 fact ids, agent tools
only) says which facts it makes in the game's folder; the snapshot lists the reaching ones as
`kinds` (`{plugin, name, tool, makes, asksReady?, scaffold?, label?}`, `asksReady` when the tool
declares `ready`; one per reaching scaffold when the plugin declares [scaffolds](#scaffolds)). For a game with no kind yet, `plugins.tools {project}`
asks each kind tool's `ready` harness tool (5 s at most, `main/core/kind-readiness.ts`) and adds
its answer as `ready` (a boolean) and `note` (the words the engine card offers the kind with); an
answer that is late, throws or is odd leaves both out. The card offers each scaffold by its label,
and one kind for a plugin with none: the one that answered, else one whose tool asks
(`asksReady`), else the first; beside a plugin's note it names the tool as the session calls it (a
plugin's note words its first kind; a later scaffold is offered by its own tool). An agent never sees `facts`, `makes` or `ready`. The Unreal
plugin's editor tools, skill and connector name `unreal-project`, so a web game's sessions get only
`use-project`, `show-steps`, `new-game` and `new-plugin` (`use-project` and `new-game` declare
`makes: ["unreal-project"]`, `new-plugin` also `unreal-plugin`). Publish goes by the same facts: a game served as a web game at its root may be
published, an Unreal project is refused as before, and any other kind is refused with its own code
(`not-web-game`).

A call to a tool that declares `makes` changes what its game is (`main/core/kind-change.ts`). While
a run of the game is going it is refused with an answer, `{refused: "run_going", message}`: nothing
runs and nothing is snapshotted. Otherwise Genex snapshots the game first (the way back). When the
call made one of its facts, the web game it took the place of (at the root, or at a made fact's
folder or one above it; an untouched starter's counts) joins `portedFrom` in `studio.json`, while
Blender files and other sub-projects keep counting; a `studio.json` that is a link is never
written through, so the web files stay
in the folder as the reference and no longer count as a kind; the app is told the game changed, and
the answer gains a note telling the session to end its reply (after a text answer's words, or under
`genex`). When the chat's own turn ends with the game's served facts different from its start's (a
port, or project files it wrote; a folder with no kind that took the web starter is no change), the
harness continues the same session by itself with the tools and the brief for the new kind
(`continueOnNewFacts` in `loop/delegated-turn.ts`, told `factsReadyPrompt`); a session that can't
be resumed starts afresh from a brief for the new kind. A run's turn never continues.

### Finding and suggesting a plugin

The chat's own session is handed Genex's plugin tools on every game, beside `start_web_game`
(`main/core/project-tools.ts`); a local model has the same names as harness tools
(`tools/plugin-finder.ts`, through `plugins.find` and `plugins.suggest`). Which ones a delegated
session gets is its seat's (`ProjectToolSeat`): a run's lead (a web run's director, an open Loop's lead in place)
gets both, and its card shows in the one chat its run was started in, as the host's records say,
never a thread the harness names; a worker the host seated gets `plugins_find` only and reports
what it found to its lead; any other session (a classic run's builder, a judge, a scout) gets
neither. Only the chat's own session gets `start_web_game`. `plugins_find {fact?, text?}` is read-only, so it runs in Plan mode: it lists
the installed plugins that match (on, then off or removed), then the entries of Genex's curated
catalog not installed, and never anything from another source (`main/core/plugin-finder.ts`). A
plugin matches when it detects, is scoped to or makes `fact`, or when a word of `text` other than a
generic one ("engine", "plugin", "editor"…) is a word, or starts a word, of its id, name, description
or facts: the agent's own search, not Genex deciding. Each found plugin carries
its `offer` (`turn-on`, `install`, or none when it is on) and its facts; the answer's `next` says
`suggest`, `use` (only plugins already on match) or `write-plugin` (none: the agent may offer to
write a local Genex plugin, or go on with its own tools on the person's word), and its note says
that an engine's own plugins are project files, not Genex plugins. With `write-plugin` the note
names the guide while the Genex plugin is on (read `genex__skill {"name":"plugin-author"}`, write the
plugin in the project, check it with `plugin_check`, tell the person how to load it) and otherwise
says the guide comes with the Genex plugin, to suggest with `plugins_suggest`. The `plugin-author` skill
(Studio's own, not vendored: `STUDIO_SKILLS` in `scripts/refresh-genex-skills.ts`) teaches the
manifest section by section with a complete example plugin for a made-up engine, its backend and
its skill, written into `genex-plugins/<id>/` in the project. The example's backend starts no
program (the scan marks `child_process` dangerous): it talks to the engine's editor on a local port
under `network` and `network.hosts: ["127.0.0.1"]`, and leaves the engine's command-line program to
the lead as a job, so `plugin_check`'s scan of it finds nothing but its skill file, not read. It says the agent cannot load or turn
on a plugin and gives the person's steps (Plugins → Add → Load local plugin…; it starts off).
`plugin_check {folder}` (`main/core/plugin-check.ts`) is the chat's own session's only and runs in
Plan mode: `folder` must be a plain relative path whose real path is a folder inside the game, read
in place by `inspectPackage` and the install-time scan; it answers `{ok, id, version, name, tools,
skills, sections, scan: {verdict, findings}, next}` or `{ok: false, problem}` (no path outside the
game is named) and never touches the registry, so nothing is installed, turned on or written. `plugins_suggest {plugin,
reason}` takes only a plugin that is installed but off (or removed) or in the catalog and not
installed, and only for a chat of its game: it appends `plugin_suggested` (`{pluginId, name,
description, offer, reason, project}`) to that chat and tells the session to end its reply (a local
turn stops). Anything else is refused and writes nothing. Only the host writes that record: the
harness's `events.append` refuses it. The chat draws the record as a card whose button, name and
description come from the live plugin list when the plugin is installed: **Turn on**
(`pluginEnable`), **Install…** (`pluginInstall`, which asks for review first) or **On**
(`chat/PluginSuggestionCard.tsx`). No tool turns a plugin on.

## A game's engine

A game builds in an engine when Genex links it to one; a plugin with `game-engine` asks for the
link and the host makes it (`substrate/plugins/engine-links.ts`), to a project of the engine the
plugin declares ([The engine declaration](#the-engine-declaration)); a plugin that declares none is
refused. `game.engine.link {project, remote?, name?, setUp?}` checks the project file by real path (absolute, no
`..`, at most 1,024 characters, one of the engine's `projectFiles`, a regular file once every link
is resolved), keeps the link in the plugin's storage as `links/<game>.json` (`{kind, project,
linkedAt, remote?, previous}`, `kind` being the engine's id, which the plugin's MCP servers read and
agents can't write), mirrors it into the game's `studio.json` as `engine`
(`substrate/game-engine-binding.ts`), and appends `engine_linked` (with the engine's id and
`label`) to the calling chat (the game's own chat for a link made in the panel): "Lantern Run now
builds in Unreal · Lantern" with Undo. `remote` keeps a published game's ids beside the link
(`{placeId, universeId}`, `parseEngineRemote`); ids of any other shape are dropped and the link is
still made. A record is believed only while its `kind` is an engine an installed plugin declares
(`PluginRegistry.engines()`, on or off: turning a plugin off never turns its games into web games;
removing it does) and its file is still of that engine's kind at that real path. A project's name
is its file name without the engine's longest matching extension (`a.project.json` is `a`), or its
folder's name for an engine whose `projectFiles` entry is a whole file name (Godot's `project.godot`); a
link's `name` (one plain line, at most 80 characters) names it in the chat's line and the answer
instead, for a project known by another name (a Roblox place linked through
`default.project.json`); any other shape is dropped.
Linking the project a game already uses, with the same ids, changes nothing; other ids make a new
link. `setUp` says the plugin set the project up to make this link: the record keeps it, the line
reads "Set up Lantern for Genex · Lantern Run now builds in Unreal", and linking the project the game
already uses makes a new link. Undo (`studio:game.engine.undo`) is offered on the game's newest link only and refused
once the link has changed; it restores the project the link replaced, or leaves the game a web
game that stays unlinked (`{unlinkedAt}`), and appends `engine_link_undone`. Undo of a `setUp` link
first runs the plugin's `undo-setup` action (`EngineHostAction.UndoSetUp`) with `{project, ifSetUp:
true}` and no question; a project no longer set up answers nothing, and a refusal (the project open
in Unreal) keeps the link and shows its reason (`setUpUndone` names the project when it worked).
While another game's current link names the same project (by real path), the set-up stays and only
the link is undone (no `setUpUndone`). A refused link changes nothing on disk.

A call to a `game-engine` plugin's MCP server never links a game: a game takes an engine project
only through the person (Use in this game) or a tool that declares `makes` (`use-project`,
`new-game`). `new-game` offers the plugin's steps card (`game.engine.steps` appends
`engine_steps`) while a step is open.

On a Mac without the Unreal Genex makes games with, `show-steps` brings the Unreal button out and
shows the install card instead (`unrealInstallCard`): Get the Epic Games Launcher (Epic's download
page; ticked once the launcher is in Applications), then Install Unreal 5.8 in it, the person's own
step (Epic's sign-in), with Open the Epic Games Launcher; Don't use Unreal (`skip`) in Hide's place;
once Unreal is found in a game whose chat chose it, the card closes and tells the agent.

The steps card ("Unreal setup") sits above the composer while nothing else waits there. A row's
button runs its plugin action as every surface does (`runPluginAction`): one that declares
`confirmation` is reviewed and approved in the native dialog first. Its
rows are the plugin's `steps` action, read every 5 s (one read at a time) while it shows, so Xcode
installed or opened outside Genex is ticked by itself; it goes when no step is open, is read no more
until the next offer, tells the agent its finish once, and Hide puts it away for that game until the
next offer. A card read for one game never shows in another game's chat. Unreal's rows: the project is set up, then Install Xcode (Open App Store) and
Open Xcode once, or the one Terminal line for another developer folder, or Update Xcode for one too
old for the engine, or Add Xcode N for one too new (Apple's developer downloads page; a second
installed Xcode in range is the one to select instead). `get-xcode` opens only the App Store page,
Apple's downloads page (`{step: downloads}`) or the Xcode app the probes found. The agent shows it again with `unreal__show-steps` when C++ would
help, links a game to a project with `unreal__use-project` (a set-up project by name, any by its
`.uproject` path: one not set up yet is set up first, unasked, and linked with `setUp`; while Unreal
has it open, or when setup would switch a project from an older Unreal to the supported one (the
panel's Set up warns first), the call is refused with that reason and nothing changes), and makes a game's
own project with `unreal__new-game {template, variant?, name}` (`Combat` with the third-person
template only): a new project exactly as the panel makes it from the open game (in its folder as
`unreal/`, set up, linked), then opened in Unreal, with the setup card offered while a step is
open; it refuses
without an open game and creates nothing in Documents › Unreal Projects (Plan mode refuses all
three). `unreal__new-plugin {name, template?}` makes an Unreal C++ plugin the way Epic's New Plugin
wizard does (`plugin-scaffold.ts`): every check first (the name, at most 16 characters, against the
engine's own modules and plugins and the Genex editor helper; the template, `window` (Epic's
Advanced, the default), `toolbar-button` (Basic) or `blank`; a game with no `unreal/` yet), then
New game's Blank project `unreal/<Name>Host.uproject` (set up), the host's own C++ module,
and `unreal/Plugins/<Name>/` copied from the engine's template with `PLUGIN_NAME` replaced and its
`.uplugin` written, enabled in the host's .uproject (`cpp-module.ts` `enableProjectPlugin`). The game
is linked to the host only once all of it is written: a step that fails links nothing and removes the
`unreal/` folder the call made (a real folder in the game, never through a link). It opens
nothing. A build of the host lets UnrealBuildTool's sandbox write each project plugin's
`Intermediate` and `Binaries`, nothing else of it (`ubt.ts` `projectPluginDirs`, `ubt-sandbox.ts`
`pluginDirs`). A game with an `unreal-plugin` fact gets four more tools and the `unreal-plugin` skill
that orders them (`plugin-ship.ts`; `plugin` names the folder under `Plugins/` when there are several).
The skill also gives Epic's toolset conventions for a plugin whose tools agents call through
Unreal's MCP (a registered `UToolsetDefinition`, static `AICallable` tools with real types, errors
raised, not returned).
`unreal__plugin-build` needs the editor lock and asks first: the call saves the person's work through
the Genex editor helper, quits Unreal and waits, then the host's editor target is built as the
plugin's background job, which opens Unreal again after a good build and leaves it closed after a
failed one. `unreal__plugin-test {filter?, stop?}` runs `UnrealEditor-Cmd` headless (the engine's
`Binaries/Mac/UnrealEditor-Cmd`, or `Binaries\Win64\UnrealEditor-Cmd.exe` on Windows)
(`automation-tests.ts`: `Automation RunTests <filter>`, the plugin's name by default, no shell, a
small environment, its own process group, 30 minutes) and keeps Epic's report and a `summary.md` in
`unreal/Saved/Genex/Tests/<Plugin>/`. Like `open-editor`, it runs outside ProcessSandbox and
UnrealBuildTool's Seatbelt profile: it loads the same host project and plugin binaries that the
person's own editor loads after every `plugin-build` (so the plugin's code gains no access it lacks
there), and the editor needs what that profile denies (its per-user engine folders, the derived data
cache, its shader workers). Its last lines and failure messages reach an agent with the project's
and engine's folders taken out and any other absolute path cut to its base name, Windows paths
(`C:\…`, `C:/…`, `\\server\…`) included and compared without case (`ubt.ts` `pathScrubber`). `unreal__plugin-package {stop?}` runs `RunUAT.sh BuildPlugin`
(`uat.ts`) in UnrealBuildTool's sandbox, which may also write the package folder (`extraWrites`), with
UAT's logs in the sandbox's scratch. On Windows it needs no Xcode: it hands `RunUAT.bat BuildPlugin
-Plugin=… -Package=… -TargetPlatforms=Win64 -NoP4` to Genex's own process sandbox as a host job
(`sandbox.run`, reading the engine and the project, writing the package folder, UAT's logs in the
job's scratch through `uebp_LogFolder`, within 45 minutes); the record stays running until a later
call of the plugin's tools sees the host's job ended, and that call writes the note (a job the host
no longer knows reads as failed). A game whose path holds a quote, `%` or `!`, or lies on a network
share, is refused before the package folder is made or emptied. Either way the package goes to `unreal/Saved/Genex/Packages/<Plugin>/` and a
note beside it (`<Plugin>.md`: path, version, files, platforms (`Mac` or `Win64`), or the errors; a new run removes the
last one first; the note is written only in the packages folder as it is when the job ends, never
through a link swapped in meanwhile, and the packaged descriptor is read only as a plain file within
its cap). One job runs at a time per project, reserved before anything is touched, and each job is
its plugin's own (a call naming another plugin never reads, answers for or stops it); a build
reads as Genex's own restart from before Unreal is quit and is refused while Genex reopens Unreal or
adds its C++ module; a call stopped before its job starts changes nothing (a build stopped once
Unreal was quit opens it again); and the backend stopping (Genex quits, the plugin is turned off)
ends every running job's process group (on Windows its tree, by `taskkill /T /F`: Genex closes the
backend's channel there instead of a SIGTERM, which would end the backend before it could). A headless editor that exits badly before Automation wrote
its report is a failed run, its summary naming the exit code, the counts so far and its last lines.
`unreal__plugin-status` answers each job's state and results and `proof`: the summary, the note and
`unreal/Saved/Genex/Shots/<Plugin>-window.jpg` (kept by `app_look`'s `save`) that exist, the summary
and note only for a run that finished, relative to the game, read from disk after a restart. A chat build of a game still with no kind, with the plugin on, first asks the
user Web or Unreal Engine with `ask_user`, unless the message names one
(`loop/unreal-prompts.ts` `engineChoiceRule`: one option per scaffold, else per plugin, among
`plugins.tools`'s `kinds` (Unreal's are `Unreal game` and `Unreal plugin`), each in its plugin's
readiness `note`, and the web answer calls `start_web_game`). The
Unreal kind's `note` comes from `engine-status`, so with no Unreal installed the agent points to the
Unreal button instead of `new-game`; any kind whose plugin says `ready: false` is never made: the
person finishes its setup from that plugin's button first. A host that lists no kinds offers no
question. When a chat turn changed the game's kind and the new kind's plugins hook `health`, the
chat waits on Genex's `health` moment before the same session goes on: it says the first pending
reason once (and on the status line), asks again every 5 s for up to 20 minutes, says a step's block
and stops there, and Stop ends the wait (`loop/delegated-turn.ts` `continueOnNewFacts`). A game from New game counts while it has no facts and nobody has answered in its chat;
a run's turns are never asked. With the plugin off a new game's brief never names Unreal, and an
Unreal project's brief says it has no Unreal tools and saves in the editor itself before a
checkpoint (`unrealWithoutPlugin`, `loop/project-prompts.ts`). In the panel, "Use in this game" links the open game to the shown set-up project;
a game that already builds in another project is offered it only for a project the person picked
in the panel (Change), never for one the panel opened on. A New
game made while a game is open goes in that game's folder as `unreal/<Name>.uproject` (refused when
`unreal` exists or the name or template would be refused, with nothing changed; the game's
`.gitignore` first gains Unreal's `Saved/`, `Intermediate/`,
`DerivedDataCache/` and `Binaries/` folders and `__pycache__/`) and becomes its project. Windows gets no Xcode rows; Visual
Studio comes later.

A chat keeps its apps' work. When a chat turn (never a run's or a stopped one) ends on a game whose
plugins hook `checkpoint.*`, it takes Genex's checkpoint only if something is unsaved
(`loop/hooks.ts` `endOfTurnCheckpoint`, `checkpoint.take {onlyIfUnsaved: true}`): on an Unreal game
the plugin's steps save the editor's work and Genex snapshots the game folder, and one line after the
reply says so with the steps' notes; a blocked checkpoint says why the work stays unsaved (a step's
reason, or Genex's own hold in the person's words: they were using the app, Genex couldn't tell
whether they were, or something else worked there; the chat's own workers writing in place never
hold it), and nothing unsaved (or an editor that can't say) or Plan mode says nothing. A turn that went on after a kind change
takes it when that leg ends. The chat turn also announces `turn.start` (a block ends the turn
before any engine works, with the reason) and `turn.end`. The chat's own session's `checkpoint` tool on an Unreal game is Genex's checkpoint: the
plugin's steps save the editor's work at once (a play blocks it; a save that fails or leaves work
is a note), then the game folder is snapshotted under its note, and the tool answers what they did
instead of only showing the note (`main/core/plugin-hooks.ts` `takeCheckpoint`,
`DelegateRequest.onCheckpoint`; in Plan mode, while the person plays, or when Genex can't tell
whether they do, it changes nothing). With the Unreal plugin off, a linked Unreal game's tool still
snapshots the game folder, running no step: the session is told to save in the editor first.

### The engine declaration

A `game-engine` plugin declares its engine in `engine` (API 3, `substrate/plugins/engine-manifest.ts`,
`EngineDeclaration` in `shared/game-engine.ts`), so an engine is the plugin's data rather than
Genex's code. Unreal's is `{"id": "unreal", "label": "Unreal", "projectFiles": [".uproject"],
"fact": "unreal-project", "projectInFolder": true}`; Godot's names the whole file
(`"projectFiles": ["project.godot"]`) and adds `"writesProjectFiles": true`. Unity declares none: it
plays through play tools scoped to its facts ([computer use](computer-use.md#game-engines-and-other-targets)).
The manifest is refused unless:

- `id` is the plugin's own id and an engine id (2–40 lowercase letters, digits and dashes, a letter
  first), never `web`, so a plugin cannot speak for another engine;
- `label`, the engine's name as people read it, is 1–40 characters on one line;
- `projectFiles` lists 1–4 distinct entries a linked project file must match: an extension of one
  or two lowercase dotted parts (`.uproject`, `.project.json`), or a whole lowercase file name
  (`project.godot`, `PROJECT_FILE_NAME`; `isProjectFileEntry`);
- `fact`, the fact a linked game holds, is one the plugin's `detect` declares or one of Genex's own
  (never `web-game`);
- `projectInFolder` is a boolean: true when the Loop needs the project inside the game folder,
  because its save points hold it;
- `writesProjectFiles`, when present, is `true`: the engine's agents change the project as files, so
  a linked project outside the game folder joins the reads and write roots of the sessions that
  build the game (`delegation.ts` `#linkedFolders`), as Godot's does;
- `play`, when present, is `{players?, clock?, pointer?, state?}`: at most `players` players (1–8)
  in one play, a `ClockLevel`, and whether the mouse aims as a player's does and the game's state
  can be read. The `computer` tool on the engine's games is built from it before play opens
  ([computer use](computer-use.md#game-engines-and-other-targets)); a plugin with a `play` of more
  than one player takes `players` on `play-open` and `player` on its other play tools;
- `apps`, when present, is `{mac?, windows?}`, each 1–4 distinct names: Mac bundle ids in
  reverse-DNS form and Windows `.exe` file names, never paths. They name the apps the editor runs
  as, which computer use never drives to build or play: while the plugin is on, the `desktop`
  tool refuses them outside its `game.engine.assist` turns, and those turns may drive only them;
- `playerApps`, when present, has `apps`' shape and names the apps the engine's published games are
  played in by everyone (Roblox's player app): while the plugin is on, the `desktop` tool refuses
  them always, an assist turn included, so no agent plays in a live server.

Unknown keys are dropped and the rest kept in a fixed order. `engineCatalog` lists the declared
engines by id, the first declaration of an id winning. `parseEngineRemote` reads a published game's
ids at its engine's service (`{placeId, universeId}`, decimal strings of at most 20 digits, never
numbers), and `isProjectPath(value, entries)` checks a project path against an engine's
`projectFiles`. A `game-engine` plugin without `engine` still loads.

A game linked to any declared engine is an engine game (`isEngineGame`, with the harness's copy in
`loop/engine-game.ts`): it gets no web rules, preview check, web Live view or web Loop, and only
Unreal's card, editor and words ask for Unreal by name. Its descriptor carries `linkedEngine`
(`{label, projectFiles, projectInFolder}`). With `projectInFolder` true and the project outside the
game folder, Mode offers no Loop and Rewind says what it can't undo, both in the engine's label
(`renderer/engine-game.ts`); with it false the Loop runs wherever the project is.

### Judges

An engine plugin may declare blind judges in `judges` (API 3, beside its `engine`;
`substrate/plugins/judge-manifest.ts`, `PluginJudge` in `shared/plugins.ts`). A judge is data: it
plays a game in the engine's editor through the play tools, never sees code, and answers from
playing. The manifest is refused unless there are at most 8 and each has:

- `id`, 2–40 lowercase letters, digits and dashes with a letter first, unique in the manifest, and
  `label`, 1–40 characters on one line;
- `facts`, when present, 1–8 fact ids: the games it judges (none: every game the plugin plays);
- `brief`, a Markdown file in the package outside every dot folder. Installing reads it and refuses
  a missing file, a folder, or more than `MAX_JUDGE_BRIEF_CHARS` (16 000) characters;
- `players`, when present, a whole number from 1 to the engine's `play.players` (one when it
  declares none);
- `probe`, when present, one of the plugin's harness tools that asks nothing, runs no host program
  and needs every lock `play-open` needs (`quietHarnessTool`).

Unknown keys are dropped and the rest kept in a fixed order. The harness's `game.list` marks a game
an engine plugin that is on plays in its editor `editorPlay`, with `judges` (`{id, label}`) that
reach it by its facts (`withEditorPlay` in `main/core/editor-play-session.ts`); a web game, or one no
plugin that is on plays, has neither. The chat's `judge_play` then takes `judge`, an id the host
checks against the game's own (an unknown one is refused in plain words and nothing plays), and a
judge's playtest grant names it. The host appends the judge's brief to the session's rubric (to its
first answer in the harness's own loop), opens its players, and right after the play opens runs its
probe once through the plugin's tool call, which holds the play's locks. The probe answers `{note,
images}`: measurements and pictures, never source. They open the judge's first answer, and the
pictures are kept in the game's captures folder and shown on the chat's judge line, only for the
trace the host wrote (`judge-probe-pictures.ts`). A `play-open` that answers `liveData: true` adds
the note that saved data there is the live game's and only the play's test players may be used.
In an open Loop the lead's `judge_play` names the game's judges too, and after each turn that keeps
a save point every one of them plays it in turn, each answer a run check carried to the lead
([harness runtime](harness-runtime.md)). Whether a chat's session calls a judge is its own choice: a
change that touches what a judge tests is a hint, not a rule.

The Roblox Studio plugin declares `multiplayer` (3 players, probe `players-state`), `cheater`
(1, `cheat-remotes`) and `phone` (1, `phone-check`), for `roblox-project` games. Their briefs are in
`judges/`; the cheater and phone probes send Luau the build copies beside `backend.mjs`
(`cheat-remotes.luau`, `phone-check.luau`), read from the package at run time
([computer use](computer-use.md#game-engines-and-other-targets) says what each measures).

### The bundled Unity plugin

Unity (`src/plugins/unity`, id `unity`, off until turned on, `game-engine` for its setup card and
its page's Editor state) reaches the person's open Unity editor
through Unity's Pipeline package (`com.unity.pipeline`), the HTTP server an editor runs on
127.0.0.1 while a project holding the package is open in it. It asks for no engine link: a game's
Unity project is the one in the game's own folder, found with the walk and the rule the host finds
the `unity-project` fact by (the game's own folder first, then `unity/`, then the first by path;
`project-folder.ts`), so the game's checkpoints and Rewind cover it. A project outside the game's
folder is not reached; a Unity project opened as a project of its own is its game's folder. Its
`detect` names a WebGL build's folder `unity-web-build` (a folder with `Build/*.loader.js`), so its
web version in `web/` is a plugin's web build (the seed's `web-build.ts`): briefs never hand it the
web template's rules, and a turn that only built it is no new kind. Genex
runs the harness tool `find-project` at `turn.start` and `run.prepare` of a game holding the fact:
it keeps the real paths of the project and of the game's folder in the plugin's storage as
`projects/<game>.json`, which the connector reads for every call (it knows only its game's id, from
its folder `mcp/<game>`) and believes only while that folder is still a Unity project at exactly
that path. The handler's trouble is a note, never a block.

The plugin makes, sets up and opens that project itself (`backend.ts`), with no sign-in of its own:

- `new-game` (`makes: ["unity-project"]`, `ready: "engine-status"`, the scaffold `Unity game`)
  writes an empty project into the game's folder as `unity/` (`new-project.ts`): `Assets/`,
  `ProjectSettings/ProjectVersion.txt` naming the newest installed Unity 6, and
  `Packages/manifest.json` asking for the Pipeline package at the version this plugin was run
  against (`PIPELINE_VERSION`), the built-in modules of Unity's own empty 3D project that this
  editor ships and its UI package. Unity writes the rest on first open. The project is built in a
  hidden sibling and renamed into place; a game that already holds a Unity project, or anything
  named `unity`, is refused with nothing changed. Once the editor answers, the plugin turns Run In
  Background on (a game otherwise runs at about 10 frames a second while Unity is behind other
  windows) and replaces the untitled scene a new project opens with by a saved
  `Assets/Scenes/Main.unity` holding a camera and a light, so no later save has a file name to ask
  for (`editor-life.ts` `firstSetup`). The harness tool `engine-status` answers the engine
  question's `{ready, note}`: ready with a Unity 6 installed, else that the agent calls
  `show-steps` and ends its reply.
- `show-steps` puts the Unity setup card in the game's chat (`game.engine.steps`) while a step is
  open. Its `steps` action answers the rows (`setup-steps.ts`): Unity Hub (`/Applications/Unity
  Hub.app`), the person's sign-in (a license file exists: `~/Library/Unity/licenses/
  UnityEntitlementLicense.xml` or `/Library/Application Support/Unity/Unity_lic.ulf`; never read)
  and a Unity 6 editor. `get-hub` downloads Unity's own `UnityHubSetup-<arch>.dmg`, mounts it
  read-only, copies `Unity Hub.app` into Applications only when `codesign` accepts it against
  Apple's Developer ID chain with Unity's team (`9QW8UQUTAA`) in the leaf and Gatekeeper
  (`spctl --assess`) accepts it (`substrate/app-install.ts`), and unmounts it; elsewhere than a Mac
  it opens Unity's page.
  `open-hub` opens Hub for the sign-in, which stays the person's. `install-unity` checks for about
  12 GB free, asks Hub for its releases (`-- --headless editors --releases --json`), picks the
  newest final release of the line Genex was measured on (`INSTALL_LINE`, else the newest final
  Unity 6) and starts `-- --headless install` on its own, its output kept in
  `unity-setup/editor-install.log` and read back for the row's percentage or why it stopped.
  `stop` (the card's Stop while Genex works) ends the download, the copy, the sign-in wait, Hub's
  listing of releases and Hub's install (its process group), starts no step after it, and keeps it
  as stopped for Try again, telling the agent nothing. The install counts as running only while its
  process is still Unity Hub; once Genex sees it ended its record says so, so a process that later
  gets its id is never shown as the install nor signalled, and the record goes once Unity is there. `skip`
  (**Don't use Unity**, in Hide's place) stops too and closes the card for that game, so the agent
  offers a web game, until it shows the card again. `set-up` (the card's Do it for me) runs these in order, its sign-in row waiting on the person for
  up to 30 minutes. Hub is copied into Applications under another name and renamed, so a half copy
  never reads as installed (an older app of that name goes to the person's Trash first); the row reads Hub's phase and percentage past its terminal escapes and
  Chromium's log lines. Once nothing is open the card tells the agent (`doneSays`) and the chat
  goes on; when an install stops it tells the agent once (`stuckSays`): finish it in Unity Hub's
  own window with the `desktop` tool when computer control is on, else say what stopped (a stop
  only the person can fix, such as disk space, never asks for clicking). A development test points
  the backend at a made-up Mac with `STUDIO_ENGINE_TEST_ROOT` (its `Applications/` and `home/`),
  which the host passes to the plugin's backend; the app never sets it.
- `setup` and `undo-setup` (each with a `confirmation`) add the Pipeline package's line to an
  existing project's manifest, or take it back (`setup.ts`): the manifest is read by real path
  inside the project, never through a link out of it; a copy is kept in the plugin's storage before
  the first change (`setup/<game>/manifest.json`); what was added is recorded, so Undo removes
  exactly that line and only while it is still the version Genex wrote. A project older than
  Unity 6 is refused.
- `open-editor` opens the project in the editor of exactly the version its `ProjectVersion.txt`
  names (`editor-open.ts`), never another one, and nothing when an editor already has it open.
  `new-game` and `setup` open it the same way. A Mac opens the app through `/usr/bin/open -n -a`,
  so the editor is the person's own app, not a child of Genex. The call then waits up to 150 s for
  the editor's `/api/status` to say `ready`, says which it was, and turns Pipeline's auto-tick on
  so the editor keeps running its loop while unfocused: the chat's own wait on `health` after a
  kind change follows an engine link, which Unity has none of.
- `restart-editor` (a `confirmation`, no lock) ends the game's editor and opens the project again,
  for an editor that stopped answering while somebody is there to confirm it. It waits 120 s for
  the new editor, not 150: ending the old one may take half a minute, and the host ends one plugin
  call at 190 s.

The six harness-only `play-*` tools implement the shared editor computer contract
([computer use](computer-use.md#game-engines-and-other-targets)). Each requires the `editor` lock
and the `unity-project` fact, so chat agents and judges can play this folder's Unity game without
an engine link. Pipeline carries Play mode, Game-view captures, pause and input; keyboard and
mouse control require an installed, active Input System package. Genex never adds that dependency
or changes the project's input settings implicitly. Unsupported input answers with the reason.
Fixed host-owned Pipeline code supplies the game clock, player state and relative mouse events;
agent-supplied C# remains subject to the connector's existing gate.

Whether an editor has a project open is read from the computer's processes (`processes.ts`: a
Unity editor whose command line names the project with `-projectPath`, in either spelling), and
from the Pipeline descriptor's process only while the list shows it as a Unity editor that names
this project or none. On Windows the editors are listed by WMI with their command lines
(`substrate/windows-processes.ts`; paths compared case-blind, either separator), else by the task
list, `tasklist`, which names Unity.exe without a command line; an editor is ended with its tree.
A stale descriptor whose id another app got blocks no Open, and that app is never signalled.
Unity's lock file (`Temp/UnityLockfile`) is no sign: a killed editor leaves it and its descriptor
behind. Installed
editors are found where Unity Hub puts them (`editors.ts`): its own folder
(`/Applications/Unity/Hub/Editor/<version>/Unity.app`) and the folder Hub records in
`secondaryInstallPath.json`; an editor that is a link to one is not listed.

#### Multiplayer

`multiplayer` (agent tool, `multiplayer.ts`; its `unity-multiplayer` file skill says how to write
the online play) puts Genex multiplayer into the game's Unity project, WebGL and native alike:
- **The package.** Genex's package is embedded as `Packages/com.genex.multiplayer/`, a copy of the
  Genex SDK's `sdks/unity` (`MULTIPLAYER_PACKAGE_SOURCE`). A changed file is kept beside it as
  `<name>.mine~`, a name Unity never imports.
- **Colyseus.** The Colyseus Unity SDK it runs on is asked for in `Packages/manifest.json` at the
  tested `upm` commit (`COLYSEUS_PACKAGE_URL`). Unity fetches it from Colyseus's repository, which
  needs git on the Mac. Studio ships none of it: its bundled serializer carries Asset Store terms.
  A version the person chose stays.
- **IL2CPP.** `Assets/Genex/link.xml` keeps the Genex and Colyseus assemblies from stripping, since
  the relay's schema is reached by reflection.
- **The game's settings.** `Assets/Resources/GenexSettings.json` holds the slug (when given) and
  API, which the game reads with `Resources.Load`. Matchmaking goes into the game's `genex.json`,
  as for Godot (`substrate/genex-game-settings.ts`).
- **Identity.** A WebGL build's player comes from the published page's `window.genexEmbed` (the
  connect module's). A native build's comes from `GenexNativeIdentity`: Play's gateway and ticket
  (`GENEX_API_URL`, `GENEX_EMBED_TICKET`), or a guest.
- **Not yet verified:** the package in a real Unity editor, an IL2CPP build or a WebGL build.

#### The panel and the toolbar button

The toolbar button (`unity:editor`, labelled Unity with the `unity` icon, only on a game with a
Unity project: `facts`) opens the plugin's one panel (`panel.html`, also on the plugin's page), an
[engine panel](../design/genex/README.md#engine-panels): the project's block (its folder, the state
in the button's words, the step, Engine, the step's buttons in the foot) and This computer (the
newest Unity installed). The button's status action `toolbar-status`
and the panel's `status` answer the same look (`panel-status.ts`), which only reads: the installed
editors, the project the game's folder holds and whether its manifest asks for the Pipeline
package, whether an editor has it open, and one `GET /api/editor_status`. It sends the editor no
command, so the toolbar may ask as often as it does.

| Step (`PanelStep`) | When | Badge | The panel offers |
| --- | --- | --- | --- |
| `get-unity` | No Unity 6 is installed and the game has no project to open | Not installed | Get Unity |
| `no-game`, `no-project` | No game is open, or its folder holds no Unity project | none | Words only |
| `old-project` | The project was saved with a Unity older than 6 | Not set up | Open Unity Hub |
| `not-set-up` | Its manifest does not ask for the Pipeline package | Not set up | Set up |
| `no-editor` | The Unity it was saved with is not installed | Not open | Open Unity Hub |
| `not-open` | No editor has it open | Not open | Open in Unity, Undo setup |
| `opening` | An editor has it open and does not answer yet | Starting | Restart Unity |
| `ready` | Its main thread answers (the panel says when it plays or compiles) | Ready | Restart Unity |
| `stalled` | Its server is there and its main thread runs nothing | Stalled, `warn`, `attention` | Restart Unity |
| `terms` | It does not answer and this Mac's Unity never had its Software Terms accepted (no `Terms-…` key in its preferences): the first start's terms window waits | Waiting for you, `warn`, `attention` | Words only |

Every badge but Stalled and Waiting for you is a `dot` (grey, amber while Starting, green once Ready). The first three
steps never reach the button, which a game without a Unity project doesn't show; the plugin page's
Editor connection reads the same word, so it never says Ready without Unity.

The actions take nothing from their arguments: each acts on the open game's own project.
`open-editor`, `setup`, `undo-setup` and `restart-editor` run the steps of the agent's tools of
those names and answer in codes the panel words itself (an `Opening`, `{changed, version, opening}`,
`{changed}`, `{ended, opening?}`); a refusal is worded for the person, not for an agent.
`get-unity` opens Unity Hub where its installer puts it (`/Applications/Unity Hub.app`, a folder
that is no link), else `https://unity.com/download`. These five and the setup card's four buttons
are `native`, so a fixture profile refuses them; `setup`, `undo-setup` and `restart-editor` carry a `confirmation`. No action makes a
project: that changes what a game is, which Genex snapshots around a tool that declares `makes`,
so a game without a project is sent to the chat. The panel asks `status` every 3 s while it is in
view and waits 200 s for an action that opens Unity, past the host's limit for one call, so the
host's answer always comes first; the host asks the button again when the panel closes. `tests/conformance/unity-panel.test.ts` runs the real panel against the
real backend in headless Chrome (opt-in: `STUDIO_BROWSER_TESTS=1`).

#### An editor that stops answering

Unity's main thread runs nothing while a system dialog is up. A save of a scene that has no file
yet opens one (the system save panel), and Pipeline does not see it: `/api/status` keeps saying
`ready`, `/api/dialog` lists none, and every command waits a minute, then fails with "Main thread
operation timed out". Three things keep an unattended agent out of it and get it back out:

- **No such save is sent.** The connector lists the open scenes before a `save_all`, or a
  `save_scene` with no `path` (alone or in a `batch`), and refuses it while a scene has no file.
  Genex's own save (`saveWork`) never calls `save_all`: it saves each named scene with unsaved work
  by its path, then `AssetDatabase.SaveAssets()`, and counts an unsaved untitled scene as work it
  could not save. `new-game` leaves no untitled scene behind.
- **A stall is read as one.** Before each command the connector looks at the main thread
  (`GET /api/editor_status`, ten seconds): no answer while the server itself answers is
  `PipelineProblem.Stalled`, the command is not sent, and the agent is told to wait, then to call
  `restart-editor`. Pipeline's own "Main thread operation timed out" reads the same; neither is
  recorded as outcome unknown, since the command never ran.
- **A run recovers by itself, when nobody is there.** `editor-state` at `health` is pending while
  Unity starts, reloads or imports, and for the first two minutes of a stall (`STALL_GRACE_MS`, kept
  between checks in `health/<game>.json`); after that it blocks only when nobody has touched the
  computer's keyboard or pointer for five minutes (`AWAY_AFTER_MS`, read from the Mac's
  `HIDIdleTime`): with somebody there the dialog may be their own, so the check stays pending and
  asks them to answer it, and their editor is never ended under them. Where the idle time can't be
  read, somebody may be there. A block, like no editor having the project open at all, is followed
  by `reopen-editor` at `crash`, which ends what is left of the editor and opens the project again. Ending is
  a clean `EditorApplication.Exit(0)` when the main thread answers and a signal to the project's own
  processes (TERM, then KILL) when it does not. Unsaved editor work is lost with a stalled editor,
  which is why every checkpoint saves first.
- **The reopened editor has nothing to ask.** An editor that was killed or crashed leaves its scene
  backups in the project (`Temp/__Backupscenes`), and the next Unity to open it asks whether to
  recover them, in a dialog before the project loads. Before Genex opens a project no editor has
  open, it moves that folder into the plugin's storage (`recovered/<game>/<time>/`; a folder of the
  project itself, never through a link out of it) and says where: the work is kept, not deleted
  (`setAsideBackups`).

#### Genex's moments and the lock

| Handler at its moment | What it does (`editor-moments.ts`) |
| --- | --- |
| `open-for-run` at `run.prepare` | Opens the editor and waits, recording when Genex itself opened it (`launched/<game>.json`); a project with no Pipeline package, or an editor that does not answer, closes the run with the reason. |
| `after-run` at `run.end` | An editor Genex opened for the run starts its idle time (below); with the **close-idle-editor** setting off, its record is dropped. |
| `save-all` at `checkpoint.before` | Saves as above. Unity not open: nothing. In the agent's own play, or in a run in the person's play while agents may use Unity as they play: stops it, then saves. In the person's play otherwise: a block (scenes can't be saved in play). Work it can't save: a block in a run, a note in a chat. |
| `scene-shots` at `checkpoint.after`, and as the `viewport` observer (`live: "stills"`) | The main camera's still (1280×720) as an image, in a run and for the reviewer; a chat's checkpoint takes none. A still of one flat colour (a scene that builds itself only when Play starts) is no image but a note saying so; the skill asks agents to build the level into the scene with an Editor script, saving the meshes, textures and materials it makes as assets. |
| `save-all`, then `end-editor`, at `restore.before` | Stops a play, saves, ends the editor and records that it did (`restore/<game>.json`); work it can't save, or an editor that won't end, blocks the restore. |
| `reopen-editor` at `restore.after` | Opens the project again only when `end-editor` closed it for this restore. |
| `editor-state` at `health`, `reopen-editor` at `crash` | As above. |

The `editor` lock (`per: project`) has `editor-activity` as its `personFirst` probe: the person is
using the editor while it plays a game the agent did not start, and `unsaved` is the open scenes
with unsaved work. The connector marks the agent's own play (`agent-play.ts`: a marker in its
folder written before its `editor_play`, alone or in a batch, reaches the editor, removed on its
`editor_stop`), so the agent's play never makes its own calls wait. The probe notes each time it
sees that play running (`seenAt`), and believes a marker for half an hour after it was written or
last seen; it forgets one once it sees the editor play nothing, but not while the editor reloads its
scripts to enter Play mode, nor, while no probe has seen it running, within 30 s of the play being
asked for (`PLAY_START_GRACE_MS`).
The panel's Agents block holds one checkbox for every game, **Agents may use Unity while you
play**, on unless the person turns it off (`substrate/engine-agents.ts`, `agents.json` in the plugin's
storage; actions `agents`, `agents-go-ahead`, `agents-wait`). While it is on, the probe answers that
nobody is at a play the agent did not start, saying `wentAhead` the first time for each game
(`went-ahead/<game>.json`); while it is off, agents wait for the person's play to end. An editor that can't be asked answers nothing: Genex can't
tell, and the agents' calls wait. A stalled one says nobody is there once the computer was left
alone for five minutes, so that the recovery above can take the lock. `save-all`, `end-editor`,
`reopen-editor`, `open-for-run` and `scene-shots` need the lock; the probe, `editor-state` and
`restart-editor` do not: a restart is the person's own confirmed word, and must not wait on a probe
a stalled editor can't answer.

#### The connector

The connector `unity-editor` (`editor-mcp.ts`; scoped to `unity-project`; it needs the `editor`
lock) offers three tools: `list_commands` (the editor's own catalogue: each command's name,
description and tags), `describe_command {command}` (its parameters: name, type, required,
description), both reads, and `run_command {command, parameters?}`. A call finds its editor by the
descriptor the package writes into the project (`Library/Pipeline/.unity-pipeline-port`: process,
port, token), read anew for every try, by real path inside the project, and only while that process
runs: Genex chooses and keeps no port. Requests go to `127.0.0.1` with the bearer and follow no
redirect (`pipeline.ts`). A call waits up to a minute for an editor that is busy (503: importing, a
dialog of Unity's own), reloading (nothing listens) or restarted (401: the descriptor is read again,
once), then says which. A command is never sent twice: one that was sent and got no answer is
recorded as outcome unknown. A captured picture (`capture_game_view`, `capture_scene_view`, in a
batch too) is handed over as an MCP image, at most four an answer, with a note in place of its
base64 text. A `capture_game_view` that names no `width` or `height` is sent with the size of
Genex's own looks at the game (`ENGINE_PLAY_VIEW`, 1280×720, in whichever of the two the editor's
catalogue lists): unsized, Unity captures the Game view at its full Retina size, and every picture
stays in the agent's transcript. Each command the connector sends is noted in its folder
(`agent-used.json`), for the idle editor below.

#### An idle editor Genex opened

Unity holds gigabytes of memory while it runs, so an editor Genex itself opened at a run's start is
closed once nobody uses it (`editor-idle.ts`). After the first `after-run`, the backend looks every
30 s (`IDLE_LOOK_MS`) at each such editor and closes it with a clean exit, its assets saved first,
once 15 minutes (`IDLE_CLOSE_MS`) passed since both the run's end and the connector's last command.
It is never closed while another run uses it, while it plays, compiles or reloads, or while its
main thread does not answer. The person taking it over drops its record for good, so it is never
closed: Unity seen as the app in front (`InternalEditorUtility.isApplicationActive`), its undo
group moving between two looks with no connector command between them, or an open scene with
unsaved work. An editor already open at the run's start, or opened from the panel or by an agent's
`open-editor`, is the person's and has no record. The plugin's **close-idle-editor** setting (on
unless turned off) is read at each run's end.

Before a command is sent the gate (`pipeline-gate.ts`) checks it against the catalogue just read.
It refuses a name the editor does not list; the commands agents never run (`eval`, `eval_file`,
`quit`, `set_authoring_root`, `set_runtime_pipeline_settings`, and the pre-0.8 `add_package` and
`remove_package`; `list_commands` leaves them out and `describe_command` describes none); and a
file outside the game's folder once links are resolved. Agents do what a person does in the
editor: `package_add`, `package_remove`, `package_resolve` and `package_embed` (a `file:` package's
folder, relative to the project's `Packages/`, must be inside the game, and any other reach to a
disk path such as `git+file:` is refused), `switch_build_target`, `build` (only with an `outputPath`
inside the game, since Unity otherwise builds into the person's last build folder; the skill names
`Builds/`, which Genex leaves out of history) and `menu`, except an item with a `Quit`, `Exit`,
`New Project`, `Open Project` or `Open Recent` segment, which would end the editor or open another
project in it. `run_script` stays available: it compiles
and runs a C# file of the game's own folder, which the game's checkpoints keep, and is how a scene
is built with code. Which parameters name files comes from the catalogue's own types: a text
parameter (`String`, `String[]`) named `path`, `paths`, `save_path`, `output`, `outputPath`,
`file`, `filename`, `assemblyDir`, `source`, `destination` or `scene_path` is one, relative to the
Unity project, while an `ObjectRef` (an asset path, a GUID, a hierarchy path such as `/Player`) is
Unity's to resolve inside the project. The bound is the game's folder, not only the Unity project
in it, so `import_asset` can take a file of the game's own `assets/`. Every operation of a `batch`
(`{id?, command, params}`) is held to the same rules, a batch inside a batch is refused, and so is
a file named by an earlier operation's answer (`$0.field`), which no check can read ahead of time.
Project settings and the build's scene list stay available: a game needs its tags, layers, input
and scenes. The gate is a guardrail for the person's editor, not a sandbox: C# an agent writes into
the project compiles and runs in that editor, and Genex's own steps run `eval` there themselves
(to save assets, to set Run In Background, to exit).

Not there yet: a still of every camera (only the main one), and a dialog of Unity's own
(`blocked_by_dialog`) answered for the person: it is waited out, then ends in the same restart. All of the above was run against Pipeline 0.8.0-exp.1 on Unity 6000.3.10f1
(2026-10-14) with the built package.

## Panels and trusted approval

Panels register `settings` or `project` placements. They are opaque-origin sandboxed frames
served over `studio-plugin:` with scripts enabled but no Node, Studio preload or direct IPC.
CSP refuses network, forms, external scripts and external images. Inline prebuilt JS/CSS and
image data URLs are supported. Use `src/plugin-sdk/panel.js` for request/response handling. The
same host (`PluginPanelHost`) serves a panel opened from the Plugins page and one opened from a
toolbar button.

`studioPlugin.call('context')` returns the selected project, host API version (`3`), the window's
language (`locale`, from `panelContext` in `renderer/panels/panel-bridge.ts`) and theme tokens:
`background`, `foreground`, the raw `accent`, and the readable button colours Studio's own primary
buttons use (`accentFill` under `accentForeground` text, at least 5:1, and `accentHover`);
`call('settings')` reads standard settings; `call('action', name, args)` invokes a declared action.
A failed call rejects with an `Error` carrying the host's words; when the person declined Studio's
confirmation it also carries `code: "cancelled"`, so a panel can stay quiet without matching text.
The parent validates source frame, opaque origin and request shape, and binds plugin/project
itself. A game change under an open panel cancels a review still waiting and posts
`studio-plugin-context-changed`; requests already asked are answered for their own game. Closing the panel removes the listener; the SDK bounds waiting promises.

A panel's words follow that language through the SDK's `words.js`: `studioPlugin.t(english,
params)` (the app's ICU syntax), `formatList`, `locale` and `ready`, and `data-t` marks in the page.
The translations are the plugin's own `locales/<lang>.json`, keyed by the English, which
`inlinePanelSdk` pastes into the panel as a JSON element (`plugin-sdk/panel-words.mjs`; the frame can
load nothing); `locales/messages.json` lists the English each panel asks for, and
`plugin-panel-words.test.ts` holds the bundled panels to it. A missing translation shows the
English. See [panels in the plugin guide](PLUGIN_GUIDE.md#3-panels).

The same catalogs hold the manifest's texts a person reads (`substrate/plugins/manifest-words.ts`,
listed in `messages.json` too). The window's plugin list (`displayList`), a panel's title, an
action's approval dialog and a tool's consent card show them in main's language, looked up when
served and kept per package folder and language until a plugin changes. Only those texts change:
the manifests the registry runs on, what agents read and every id stay English. A catalog read
through a link out of the package, over 512 KiB or not an object of strings is no translations,
and a translation that is not plain text of a fitting length, or names a strip button Studio's
own, shows the English (`plugin-manifest-words.test.ts`). Each bundled plugin ships its `locales/`
beside its plugin.json (`scripts/build-plugins.mjs`).

`studioPlugin.chooseFile({ title, extensions })` opens Studio's own native file picker over its
window, so a panel never asks the person to type a path. `title` is 1–80 characters on one line;
`extensions` lists 1–4 different extensions without the dot, each 1–10 lowercase letters or
digits (`['uproject']`); any other field is refused. The answer is the chosen file's real path,
or `null` when the person cancels. The panel host checks the request, and main checks it again
(`src/shared/plugin-file-request.ts`) and only for a panel of an enabled plugin. The picker
shows `<plugin name>: <title>`, takes one existing file, never starts in a folder the panel
names, and opens one at a time. An answer that is not a regular file whose real name ends in a
listed extension (a name typed past the filter, a link to another file) is refused. Picking reads
and writes nothing; the plugin acts on the path through its own actions. The SDK waits up to
30 minutes for the person. The channel (`studio:plugins.choose-file`) is native, so a fixture
profile answers `unsupported-in-fixture`.

Actions declaring `confirmation` open Studio-owned review UI followed by native confirmation.
Optional backend `review` (`PluginReview`) returns a `message`, a `detail` and labeled image data
URLs; a message over 2,000 characters, a detail over 4,000 or either one not text refuses the
review. With a message, the native dialog asks it instead of the manifest's confirmation, shows
`detail` under it (never the arguments) and confirms with the action's label; without one it asks
the confirmation over the action's arguments as JSON (nothing when there are none) and confirms
with Approve. Cancel is the default either way. Studio requires all images to load before
continuing. Approval tickets are short-lived, single-use and bound to
plugin/action/arguments/project. A panel never supplies its own approval ticket. Genex uses this
for candidate/remesh review, allowance changes and credential operations; a preview's review
carries only the candidate its arguments name, captioned as the one being approved, and a
remesh's carries every view. Account connection
URLs must be HTTPS and open only after an approved connection action.

## Marketplace

The Plugins page lists a remote, human-curated index: `{version: 1, updatedAt, plugins: []}`,
entries carrying `id`, `name`, `publisher`, `description`, `category` (`assets`, `publishing`,
`tools`, `analytics`, `other`), `tier` (`official` or `community`), `repo` as `owner/repo`, a
**40-hex commit sha**, an optional `subdir`, `version`, `capabilities`, and optional
`minStudioVersion`, `docsUrl` and a curated `artifact {url, sha256}`.

- Default URL: `https://plugins.genex.games/catalog/v1/index.json` (`DEFAULT_INDEX_URL`).
  A host-owned override file `engine-homes/plugins/marketplace.json` with `{indexUrl}` replaces it;
  the URL must be `https://`.
- The index is cached under `engine-homes/plugins/cache/index.json` for **6 hours**. Fetches time
  out at 15 s, refuse redirects and are capped at 1 MiB, and the whole document is re-validated
  before it is trusted. A failed fetch serves the last good entries with `stale: true` and an
  `error` the page shows, so the list never disappears because the network did.
- **Fixture profiles are offline**: the marketplace is constructed with `offline: true` and never
  calls out at all, reporting `Studio is offline in this profile`; with nothing to list, the page's
  Community plugins is only Coming soon (`[data-marketplace-soon]`), as it is whenever the catalog
  offers no community plugin you lack. `studio:plugins.install-github`,
  `studio:plugins.lookup-github`, `studio:plugins.github-versions` and `studio:plugins.update` are
  in `FIXTURE_BLOCKED_CHANNELS`.
- **Cataloged is not audited.** The index says where a plugin's code is pinned; Studio checks the
  commit and reports what the code appears to do. Nothing updates on its own: `updates()` compares
  strictly newer compatible stable versions from the same publisher/repository/subdirectory, and the page offers **Update to x**, which shows the
  trust dialog again — and re-asks for consent when the new version's capabilities have grown.
- An entry whose `minStudioVersion` is above this Studio reads **Needs Studio ≥ x** and offers no
  install.
- **The app holds the catalog policy too** (`STUDIO_CATALOG_POLICY` in
  `src/substrate/plugins/marketplace.ts`, the same rules as the catalog repository's `policy.json`).
  An entry under an official id (`genex` → Genex, `blender` → Studio, both from
  `genex-games/genex-desktop` or, until every official record names it, the legacy
  `Rabneba/ai-game-studio`) from any other publisher or repository is dropped. Both repositories are
  one source: an official plugin installed from either keeps its identity, account and data when
  its update names the other ([source repository moved](STUDIO-MARKETPLACE-RELEASE.md#source-repository-moved)). An `official` tier
  the policy does not grant is shown as `community`; an artifact from an origin other than
  `https://plugins.genex.games`, or at a path that does not end in `/<id>/<version>/<sha256>.json`,
  is dropped. The policy is applied on every read, cached copies included. The index itself is
  unsigned: community entries are listed only after maintainer review, with artifacts on the
  approved origin; signing the index with a key embedded in the app is later hardening.

The repository's `marketplace/index.json` is an empty scaffold, not the published catalog. The
published catalog lists official `genex` and `blender` releases, but both ids are bundled seeds, so
this build neither installs nor updates them from it: the bundled copy wins. The offline `catalog:prepare` command produces a
portable curated catalog repository and separate content-addressed artifact payload from
prebuilt packages. See [catalog preparation](../marketplace/README.md). Its base-policy CI
checks release identity/history and artifact bytes without executing submitted plugin code.
Same-version repacks, lower versions and publisher/source changes are not normal updates;
the host update IPC rechecks eligibility after refreshing the index. Installed disabled state
is preserved by the registry. No catalog publication, auto-update or endpoint change is implied.

## Install from GitHub

Plugins → Add → Install from GitHub takes a pasted link: `github.com/owner/repo`, a folder in it
(`…/tree/<ref>/<folder>`), a file link to its `plugin.json`, a release tag, a commit, bare
`owner/repo`, or the pinned `owner/repo[/subdir]@<40-hex sha>`. `parseGithubLink`
(`shared/github-link.ts`) refuses anything else (another host, userinfo, a port, a traversal,
an encoded separator), and the window answers such a link without asking GitHub.
`lookupGithub` (`studio:plugins.lookup-github`) then settles the link on **one exact commit**: its
own commit, what its branch or tag points at, else the latest release
(`GET /repos/{repo}/releases/latest` → `GET /repos/{repo}/commits/{tag}`), else the default
branch's newest commit. It reads that commit's tree and the `plugin.json` at the folder (or, when
the root has none, up to 12 a few folders down, offered to choose from), checks each against its
blob id, validates it, and shows name, owner, description and version. It answers a typed
problem (`not-a-link`, `not-found`, `no-plugin`, `invalid-plugin`, `rate-limited`) the window
words itself. **Change** lists recent releases and the default branch
(`studio:plugins.github-versions`). Install passes the pinned spec to the path below, so what is
installed is exactly the commit shown. There is **no archive extraction**:

- The tree comes from `GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1`. A `truncated` tree
  is refused with the advice to point the spec at a smaller subdirectory.
- Modes `120000` (symlink) and `160000` (submodule) are refused, as is any mode other than
  `100644` / `100755`. Every path goes through `safeRelative`, so nothing is written outside the
  staging folder.
- Caps: 400 files, 8 MiB per file, 64 MiB per package. The tree must contain a `plugin.json` at
  the spec's path.
- Each file is fetched individually and its bytes are checked against the **git blob object id**
  from the tree before it is written. A mismatch aborts the install.
- The staged package is then inspected and scanned, and only then is the user asked.

Installs from an index entry take the same path and additionally require `id`, `version`,
`publisher` and `capabilities` to match the `plugin.json` at that commit. Curated `artifact`
entries reuse the existing base64-JSON envelope and touch the GitHub API not at all — which
matters, because that API is unauthenticated here and rate-limited per IP.

## The install-time static scan

`scanPackage` reads `.js`, `.mjs`, `.cjs`, `.ts`, `.html` and `.json` files with line numbers and
reports what the code appears to do. Every other file (except a declared `icon` that is the
picture it says) is reported as `not-scanned` (caution),
because Node loads a file of any extension as JavaScript when asked to: a verdict of `safe` means
every file was read and nothing matched.

| Rule | Severity | What it matches |
| --- | --- | --- |
| `child-process` | dangerous | `child_process`, `spawn`, `exec*` |
| `dynamic-code` | dangerous | `eval(`, `new Function(`, `vm.runIn*` |
| `network-undeclared` | dangerous | `fetch`/`http(s)`/`net`/`WebSocket`, including `import('node:https')` and friends, without the `network` capability |
| `credential-path` | dangerous | `~/.ssh`, `id_rsa`, `.aws/credentials`, `.netrc`, `.npmrc`, Keychains, `.genex`, `.codex`, `.claude`, `.env`, `Application Support/AI Game Studio` or `Application Support/Genex`, browser login stores |
| `native-binary` | dangerous | a `.node` addon, a `#!` executable or `process.dlopen(` |
| `not-scanned` | caution | a file whose extension the rules do not read |
| `dynamic-import` | caution | `import(` of anything but a path inside the package — what it loads was not scanned |
| `host-undeclared` | caution | a literal `http(s)://host` not in `network.hosts` |
| `obfuscation` | caution | very long low-alphanumeric lines, long `\x`/`\u` runs, `String.fromCharCode` with many arguments, base64 decoding next to `eval` |

The verdict is the highest severity found, `safe` when there are none, and findings are sorted by
file then line. **This is disclosure, not isolation**: it changes what the trust dialog says, it
does not confine anything, and it is heuristic — a plugin that legitimately spawns a bundled CLI
reads `dangerous`. The verdict is stored on the install record and shown as `Scan: <verdict>` on
the plugin's detail page. A scan runs every time code is read: install, update, **Allow…**, a hot reload
and a restore from a local folder or a pinned commit all recompute it against the copy being
installed, so the page never keeps a verdict for code that has since changed. Bundled seeds are
not scanned.

The trust dialog is one function for every way a plugin can arrive from outside Genex
(`main/plugin-install-words.ts`). It asks **Install {name} {version}?**, **Update {name} to
{version}?** when another version is installed, or **Replace … with …?**, and its body is one
short block per fact: what a replacement erases; *From {GitHub owner/repo@sha (cataloged, not
audited) | a curated release | the folder … | Genex (built in)}* with the publisher; that the code
runs on the computer like an installed app and is not sandboxed; **It asks to:** with each
capability in plain words; the programs it starts with the environment each is given; the tools
Genex runs for it; the skills it adds; and **Scan: {verdict}, {findings}** or **Not scanned.** An
update marks what is new or changed. A bundled seed installs and updates without the dialog unless
it would replace a plugin from elsewhere.

## Hot reload and debug logs

**Watch folder** in a local plugin's detail-page More menu starts a recursive watcher on the folder it was loaded
from, debounced at 500 ms, and re-installs through the normal lease path: the new backend is started
once to prove it loads, then the new record waits for any session holding the plugin and lands as
`reloaded` when it is free. A reload that changes MCP servers or network hosts, or the steps Genex
runs without a card (hooks, observers, locks with their `personFirst` probes, `folders`, harness
tools, `ready`), is refused before anything starts and the person loads the folder again through the
trust dialog. Watch is refused for a folder agents write in (`PluginRegistry.agentWritable`: the
games folder, any game's folder, the scratch of workers' copies), since an agent's edit would run
on the next save with no card. Each reload scans the
folder again, so the detail page's `Scan:` verdict describes the code that was just loaded. Only a
`local` origin can be watched; disabling or removing the plugin clears the watcher, and a remove
that was queued first wins: the reload re-checks inside the serialized queue and bails rather than
bringing a removed plugin back. Recursive watching coalesces
events on macOS, so this is best-effort: if an edit does not appear, press Reinstall.

With `STUDIO_PLUGIN_DEBUG=1`, backend stderr is appended to
`engine-homes/plugins/logs/<id>.log`. It is a developer sink only; stderr may carry provider
output and is never shown as plugin status.

## Developer kit

| Command | What it does |
| --- | --- |
| `npm run plugin:new -- <id> [--out <dir>]` | Scaffolds a package from the SDK example with the id, name and tool names substituted; refuses reserved ids, malformed ids and occupied directories |
| `npm run plugin:doctor -- <dir> [--json]` | `inspectPackage` → `scanPackage` → a real ping probe with every host service throwing (stderr echoed) → toolbar reserved labels and aria uniqueness → panel CSP → `mcpServers` (every `node` server's script is really a file inside the package, and each server is listed with the environment sources it asked for). Exit 1 on an error; scan findings and CSP problems are warnings |
| `npm run plugin:pack -- <dir> <artifact.json>` | Writes the curated release envelope and prints the canonical manifest and its sha-256. Dotfiles and dot-folders (`.git`, `.env`) and the scaffold's authoring files (`AGENTS.md`, `jsconfig.json`, `tsconfig.json`, `plugin-sdk/`) stay out; a link is refused (`packEnvelope`, shared with `plugin:submit` and `catalog:prepare`) |
| `npm run plugin:submit -- <dir> --catalog <genex-plugins clone> --repo <owner/repo> --sha <commit> --category <category> [--subdir] [--docs-url] [--min-studio-version] [--artifact]` | Packs the package, writes the community release record `records/<id>/<version>.json` and its `index.json` entry into the clone, and checks them with the catalog's validator against the clone as it was; on any refusal nothing is kept. Refuses an official id, the scaffold's `Unpublished` publisher, a released version and an artifact path inside the catalog or package. The artifact goes beside the clone, for the author's GitHub release |
| `npm run plugin:unpack -- <artifact.json> <new-dir>` | Writes an envelope's files into a new folder for review (diff against the source commit, doctor, load); every name is checked before anything is written, and nothing runs |

A panel places `<!-- STUDIO_PANEL_SDK -->` where the bridge goes; `plugin:new` (and the build, for
the bundled example and Local Blender) replaces it with the current `panel.js` and `ui.js`
(`src/plugin-sdk/inline-panel-sdk.mjs`, also runnable as `node inline-panel-sdk.mjs panel.html`).
`<!-- STUDIO_PANEL_FONTS -->` takes Genex's Latin and Cyrillic faces as `data:` fonts (`inlinePanelFonts`,
used by the Unreal panel's build), the only fonts the panel CSP (`main/plugin-panel-csp.ts`) loads;
Japanese, Korean and Chinese use the Mac's own face for the panel's `lang`, since those faces would
add megabytes to every panel.
The source example's panel therefore has no bridge until built or scaffolded.

The scaffold itself needs nothing from Studio's tree: the panel carries the bridge and
`plugin-sdk/index.d.ts` the types. The three commands still run from a Studio checkout on Node 24
(they import the real validator, scanner and probe), and `jsconfig.json` has no Node types: add
`@types/node` to the plugin folder before a type-checked backend imports `node:` modules. A
versioned, separately published dev kit is not available yet.

`src/plugin-sdk/index.d.ts` is the typed contract: a self-contained mirror of the manifest, the
host-service overloads, `PluginContext`, `Activate` and the panel bridge. `tsconfig` has
`skipLibCheck`, so `tests/conformance/plugin-sdk-types.test.ts` is its only guard — it compiles
sources against it with lib checking on and pins the mirror to `src/shared/plugins.ts` in both
directions. `npm run watch` rebuilds plugin packages into `dist/resources` on every save,
logging `plugins rebuilt`.

The step-by-step walkthrough, the host-service table with capabilities, the panel CSP rules and
the publishing checklist live in [PLUGIN_GUIDE.md](PLUGIN_GUIDE.md).

## First-party privileges

Genex, and to a smaller degree Local Blender, use things a third-party package cannot. They are
listed here so the public model is not mistaken for the one these plugins use; each is to be
retired or turned into a manifest declaration or host service when a second plugin needs it.

Genex:

- Its account is the app's (`PluginRegistry.appAccount`, set by `studio-core.ts`; the app's view
  of it is `main/core/genex-account.ts`, see [Play](play.md)). Turned off, Genex keeps its account,
  its credential, its backend and the actions in `GENEX_ACCOUNT_ACTIONS` (sign-in, status, sign-out
  and Publish; `servesAction`); only its tools, MCP servers, skills and toolbar contributions go.
  It can't be removed. A finished sign-in turns it on unless the person turned it off themselves
  (the record's `turnedOff`, set only by `setEnabled(false)`).
- `host-cli` MCP servers run Studio's own bundled Genex CLI (`@genex-ai/cli-demo`, an app
  dependency unpacked from the asar) behind `src/genex-host/preload.mjs`. A bundled seed is copied
  into the profile without its `node_modules` (Windows 11 held the CLI's 2,394 fresh files past the
  start budget), so the CLI resolves from the seed in the app first (`genexCliPath`), and a bundled
  plugin's backend is told that seed's folder in `STUDIO_PLUGIN_SEED`. The manifest validator
  reserves the command for the id `genex`, and the launcher also requires source `bundled`.
- For `host-cli`, `credential-file` renders the `GENEX_TOKEN=` env-file line and a virtual env path.
  The preload answers only the CLI's per-origin sign-in record beside that path, for the origin in
  `GENEX_API_URL`; a request for any other origin finds nothing, so the CLI sends no token there. A
  plugin's own `node` server gets the bare token on fd 3 instead.
- The MCP launcher seeds `.genex/workspace.json` in a Genex server's working directory.
- Publish in Studio's own Publish dialog (`main/core/genex-publish.ts`) first lists the files a
  public copy would hold (`studio:plugins.genex-publish-review`: the same export, into scratch,
  removed), then `studio:plugins.genex-publish` runs `publish-gallery` with that list approved.
  Studio draws the dialog, so that press is the consent: no native dialog, and no chat card when
  the staged export holds exactly the approved files (`main/core/export-approvals.ts`: one use,
  only during that publish, five minutes at most). Other files are asked about in chat as usual.
  Only the bundled Genex, on; the same action from a panel or toolbar still goes through the
  review, ticket and native confirmation. The stage strip offers Publish (Genex's button or
  Studio's own) only for a game served as a web game at its root (`servedAsWebGame`): an Unreal or
  any other project's folder holds no web build (`genex-publish-view.ts` `stripEntries`). Main
  refuses the same games (`assertPublishable`, `PublishRefusedError` code `unreal-game` or
  `not-web-game`): the dialog's review and publish, `genex__publish`
  before its consent card, and `export.stage` (a panel's or toolbar's publish) before it exports.
- For a game linked to an engine, or one whose folder holds a player build, the dialog lists its
  platforms above the presses (`PublishPlatforms.tsx`, `publish-platforms-view.ts`; read by
  `studio:plugins.genex-publish-platforms` from `main/core/publish-platforms.ts`): Web, Mac app and
  Windows app. `main/core/native-builds.ts` finds the builds from the binaries themselves (a
  `.app`'s Mach-O program, a PE `.exe` beside its data; never through a link, engine caches skipped,
  the walk capped). A row says what its build runs on, when it was built and its size; "Built
  before your last change" with Build again when the game's sources changed more than a minute after
  it (builds, caches, history, hidden files, notes and logs, and Unity's `UserSettings` do not count);
  or "Not made yet" with Make with agent, which sends "Make a <Platform> app
  of <Game> so I can publish it for <Platform> players." through the game's chat at once (as Another
  cover does) and keeps the dialog open, the row then saying "Asked the agent". A Unity or Godot
  game's missing web row offers the same for a web version (`webOfferFor`, `makeWebAsk`); an Unreal
  game's says Unreal games don't run in a browser. A ready app goes
  with Publish (`publishedApps`, passed as `native` in `publish-gallery`'s arguments; the line under
  the rows says "Publish also sends the Mac app."): once the web build is public, the plugin sends
  each with `genex native publish <the .app, or the .exe's folder> --json` in the publish workspace
  (`publishApps`, `native-publish.ts`, one hour each), one at a time, after resolving each by real
  path inside the game folder. An app that fails never fails the publish; its row says "Not sent"
  and a line under the rows says why in the CLI's words. Each result is kept in the workspace's
  `native.json` and answered as `GenexPublishState.native` (Sending…, On Genex). A draft sends no app,
  and a stale build stays. While the pinned CLI is older than `genex native` (1.36.11), nothing is
  sent and a built app says "Coming soon" (`uploads: false`), its players getting the web version.
  The dialog sends apps only through an installed Genex plugin whose record says it can
  (`native.supported`, `gateByPlugin`): a profile still on a plugin from before apps is told to
  update it in Plugins. The plugin's `publishing-apps` skill tells the game's agent how to build an
  app or a web version (in `web/`) for Publish, how to make an app open in a window, and never to
  send the person to another store. A Unity web version is built from a full-window template the
  agent writes in `Assets/WebGLTemplates/Genex/`: Unity's own templates draw a fixed 960x600 box.
  A `WebGLTemplates/` folder is never taken for the game's web version (`NOT_A_WEB_GAME`).
  A game with no web build but a ready app (an Unreal or Unity game built for the Mac) gets Publish
  on the strip too (`stripEntries`' `apps`, read through the same channel); its press says "Publish
  Mac app" and runs `studio:plugins.genex-publish-apps` (`publishAppsFromDialog`, no web copy, no
  `assertPublishable`) → the plugin's `publish-apps` (`publishAppsOnly`): the hosted project is made
  the first time, each app goes with `genex native publish`, the first that goes carrying
  `--gallery --title <name>` (a refused listing exits 1 with its answer; the app is live either way).
  Listed, the record turns public with the game's genex.games page as its link; held for review or
  not listed, a line under the rows says so; refused, the publish fails in Genex's words. Multiplayer
  stays off for it. Like a web publish, it takes the cover again as it starts and sends it once its
  apps are on Genex (`#reshoot`, then the cover step). Its clip names as its build the first 40
  characters of a sent app's archive sha256 (`appClipCommit`, from `native.json`), which Genex
  matches as a prefix where a web game's names its staging commit; a stand that refuses it leaves a
  `failed` clip record, sent again by the next publish, and the picture stands. A web game with no app shows no rows. L4: `npm run test:ui -- publish-platforms-ui`.
- Every published copy gets a `<head>` tag when `deployment.ts` marks it (`withHead`): the games
  host injects its environment (`window.__GENEX__`), mobile kit, crash watchdog and cover
  responder only into one, and the marker never goes ahead of the doctype. A game whose
  package.json names no Genex package is connected by Studio (`plugins/genex/entry-page.ts`): once
  Genex names the project (a first publish creates it), the plugin copies its build of the pinned
  embed SDK (`embed-sdk/` beside its backend: the entry and the modules it reaches) and a connect
  module naming the slug into the copy's `vendor/genex/`, loads that module after the page's last
  import map, names the SDK in the copy's package.json so the CLI sends `embedSdkVersion`, and
  marks the copy again. A game that brings its own SDK connects itself; Studio never adds a second.
- That dialog also reads the cover record publish-status answers (`GenexPublishState.cover`, typed
  in `shared/genex.ts` with the plugin's outcome kinds as `GenexCoverOutcome`). While it reports no
  kept shot and no send running, the owner chose no cover on genex.games (`kept_owner`, which the
  plugin records whenever Genex reports the owner's pick, at a send or a status check, a shot kept
  or not; `outranked`) and no publish runs, the dialog asks the plugin to take one (`needsCover` in
  `genex-publish-view.ts`, action `cover-auto`): the `genex-cover` demo, or a plain frame of the game
  as it loads (`origin: "studio"`), never over a demo's frame; the strip asks the same once a game's
  turns settle (`use-cover-after-turns.ts`), and it records the `genex-clip` demo's clip when there is
  one. The banner flips between the record's `candidates` (the last four frames; `cover-pick` makes
  one the kept shot, pinned, which a publish sends without shooting again), shows a kept clip behind
  a Picture / Clip switch, and Another cover (`[data-genex-another-cover]`) opens a field whose Ask
  agent sends "Make another Genex cover for this game: …" through the chat's own send
  (`renderer/compose-in-chat.ts`) and closes the dialog there. Once the chat really sent it, the ask
  is kept per game on this Mac (`genex/cover-asks.ts`), so the banner opened again says one is being
  made until the agent's own frame arrives: the record's `agentTook` (`covers/<project>/agent.json`,
  set only by `genex__cover` shoot and clip, never by Studio's takes or a publish's shot). Roughly how
  long is left shows once that game's last ask was timed (ask to `agentTook`; no number before one,
  none once it runs over). A
  Genex plugin older than covers answers no record, and none of this shows. Genex-specific core UI, accepted
  by the owner; a second plugin with a cover would need a declared host surface instead.
- A game that runs as its own program (a Unity, Godot or Unreal fact, or nothing served as a web
  page: `takenFromReel` in `main/core/cover-reel.ts`) cannot be photographed, so its builder renders
  the cover inside the engine: the session that owns its build is told to (`appCoverGuidance`,
  `cover-reel-prompts.ts`, added to the brief in `core/delegation.ts`), with no Genex tool needed:
  `.studio/cover/cover.png` (1920x1080) and `.studio/cover/clip/0001.png` onward (five seconds at
  30 fps, 960x540), or one `clip.mp4`/`clip.webm`. A plugin's `observe` with a `still` or a `clip`
  of such a game takes it of its cover reel (`throughCoverReel`, through `ViewStillOptions.open`):
  the media copied, by `lstat` and never through a link, sniffed and capped, into a folder of the
  host's scratch (`cover-reels/`) beside a page whose `__studio` answers the `genex-cover` demo with
  the picture and `genex-clip` with the frames played from `start()`, removed when the take ends.
  So `cover-auto`, the banner and a publish work on it as on a web game. With no media, or for a
  web game, the game is served as before.
- The chat shows the game's kept Genex cover as one card (`chat/GenexCoverCard.tsx`) for the
  thread's latest `genex__cover` call from plugin `genex` whose operation is `shoot` and whose
  answer carried a picture (`chat-entries.ts`, the tool read with or without `genex__` and
  `mcp__studio__`). Like a build's result card it goes up once that work has ended, after the turn's
  reply (or a build's result card when the build's builder shot it), never mid-turn, and a newer
  kept shot takes it down at once; earlier shots stay rows of the work. Its picture is the kept shot
  read through `readProjectAsset`'s `genex-cover` scope (below), never a tool result's image, so a
  shot that can no longer be read leaves no card. Under it, the caption Genex cover and a primary
  Publish (`[data-genex-cover-publish]`) that dispatches the `studio:plugin-setup` window event with
  `{id: "genex"}` (`renderer/plugin-setup.ts`), so the stage strip opens Studio's own Publish
  dialog; that dialog's press is the consent, and for a live game it offers Publish update. Publish
  is left out while Genex puts no Publish on the strip (off or removed), while publish-status
  reports an attempt running, and once Genex has answered for the kept frame itself (`applied`,
  `unchanged`, `outranked` or `kept_owner` for its hash: a publish re-shoots and sends it, so the
  cover's next step is done; `failed` and `not_hosted` keep it) (`coverCardPublish`, read on mount,
  on Genex's plugin events and on the dialog's cadence by `use-genex-publishing.ts`). The cover
  guidance (inline `cover` skill, `genex-cover` preface) tells the builder to shoot the winner last
  and then say one line, never how to publish. Genex-specific on purpose and with no manifest field:
  when plugin pictures get a general home in the chat, the card moves onto it and keeps only
  Publish.
- `~/.genex` is on the protected and secret path lists every sandboxed engine and native job is
  denied, and the workspace content filters skip `.genex` folders.
- Core reads Genex job folders under `engine-homes/genex/projects/*/jobs` for the Assets inventory
  and provenance, resolves `@genex/` retained-asset references, and serves one saved inspection
  frame through the `genex-inspection` scope of `readProjectAsset`. Its `genex-cover` scope serves
  the game's kept cover shot (`readGenexCoverShot` in `main/game-assets.ts`): the host builds
  `engine-homes/genex/covers/<project>/` from the validated game name, never from a path the
  renderer or the plugin names, refuses a link anywhere on the way, and reads only `shot.png` or
  `shot.jpg` (no link, at most 8 MiB, bytes of the type its name says; the newer when both are
  there); anything else answers null. `genex-cover-shot.test.ts` holds its hostile table.
- A game using `@genex-ai/embed-sdk` is previewed with `?genex_local_test=1`. A template game whose
  page loads Studio's copy (`/vendor/genex/`, `pageLoadsGenexSdk` in `shared/genex-page.ts`) is
  previewed on its loopback origin, where the SDK runs in local test mode without the query.
- `tools[].host` (API 3, id `genex`, source `bundled`, else refused before any hook runs) names a
  program Studio runs for the tool through the registry's `hostTool` hook. `genex-cli` backs
  `genex__cli` and `genex-cli-paid` backs `genex__cli-paid`: Studio's pinned CLI runs in
  ProcessSandbox in a fresh `<userData>/genex-cli/<id>` folder (also its `HOME`), never a game
  folder, so the CLI's skill sync and contract healing touch only that folder, which is removed
  afterwards. `main/core/genex-cli-policy.ts` allows doctor, budget, `llm models|status|cancel`
  and `shop list` free, and `llm bench` and `shop add|set|remove|test` paid; everything else,
  `budget --assets` (its allowance would live only in the removed run folder) and every flag Studio
  sets itself is refused with a typed reason naming the tool to use instead. Studio adds `--env`,
  `--api-url https://api.genex.games`, `--no-auth` and `--json`, and `--user-approved` only for an
  approved bench. The consent card shows Studio's summary of the validated call (the command, what
  it spends first, the agent's text last and clipped), and a call Studio would refuse asks nobody. The token reaches the
  preload on stdin; the network is `api.genex.games` only; the games root and every game are
  write-denied; a run stops after 90 s; output is redacted and capped at 64 KiB. A project
  command sees only `{id, slug}` from the publish workspace. `genex-package` backs
  `genex__package`: it adds `@genex-ai/multiplayer` or `@genex-ai/embed-sdk` at the exact pin in
  `GENEX_GAME_PACKAGES` (`shared/genex.ts`) with the game's package manager, only in the bound
  game or a git worktree of it under Studio's scratch (by realpath). A template game has no
  `package.json`: for `@genex-ai/embed-sdk` the tool maps Studio's copy in its page's import map
  (`/vendor/genex/embed-sdk/index.js`, which the build copies from the pinned devDependency) and
  loads `/vendor/genex/connect.js` after the map (`withGenexSdkImport`); its page must be a
  regular file, never a link. Multiplayer is refused there. A Godot game (`godot/project.godot`)
  or a Unity game (`[unity/]ProjectSettings/ProjectVersion.txt`) is refused with a pointer to
  `godot__multiplayer` or `unity__multiplayer`: its multiplayer goes into its project. The paid tool and the package tool need consent; fixture profiles refuse
  both host steps (`studio:plugins.host-cli`, `studio:plugins.host-package`).
- `genex__asset` accepts only each lane's own options (`LANE_OPTIONS`, `plugins/genex/request.ts`),
  and a refusal names them (`Unsupported Genex option for <op>`). Each lane's provider is fixed and
  its description says which (the `model` lanes are Tripo; `character` and `creature` are Meshy;
  `character.import` is Uthana), with Local Blender first for hard-surface models when it is on; a
  chat's coordinator promises no provider a lane lacks (`coordinator-prompts.ts`).
- Genex's guide, seven platform cards and five lane cards (model, character, texture, audio,
  image) are vendored behind Studio-written prefaces in
  `src/plugins/genex/skills` (`vendor.json` pins each source and hash; `npm run genex:skills`
  refreshes them; `genex-skills-vendor.test.ts` catches drift) and served as file skills.
- The bundled CLI follows npm: every 6 hours `.github/workflows/genex-cli-follow.yml` compares
  npm's `latest` `@genex-ai/cli-demo` with the pin. When npm is ahead, `scripts/follow-genex-cli.ts`
  opens one bump PR against `dev` with the exact pin, refreshed skills, the plugin's next patch
  version and the version mentions it lists.
- Its backend and adapter import core substrate modules (session credentials, secrets, delivery,
  outcomes, atomic writes, snapshots), which `scripts/build-plugins.mjs` bundles from this repo.

Local Blender:

- Its enabled state is seeded from the core `settings.blender` value.
- Core reads its `plugins/data/blender/native-jobs` records for the Assets inventory.
- Its tool result says what to do with the delivery in the game's engine (the game's `studio.json`,
  read through `project.read`): a web game's loader, or an Unreal game's import (Blender metres
  become centimetres, +Z up, +X forward, the pivot at the base), with a word when a file holds
  several meshes or an armature was left out (`rig` exports armatures and their actions, each
  armature's scale applied to its bones and clips, so a rig made at 0.01 comes out in metres). Its renders
  show each material's colour: the wrapper copies a shader's Base Color to the viewport colour
  Workbench draws. Its stats give each mesh's material slots with their faces and triangles
  (`slots`), so a slot that draws nothing or the wrong part shows without opening Blender.
- `blender__model`'s `script` is the path of a `.py` in the game (`assets/src/<name>.py` when left
  out). Code passed as the script, a path the host would refuse, and a path that is no regular file
  of the game are refused before anything runs, in words that say to write the file first.
- It finds Blender on a Mac in Applications, and on Windows in Program Files (`Blender Foundation/
  Blender */`), beside the program `.blend` files open with, in its Microsoft Store package, Steam
  or Scoop, or wherever the person chose `blender.exe` (the `program` setting, Choose Blender… on
  its card). It pins Blender's Mac `.dmg` and Windows x64 and arm64 zips. On a Windows PC with no
  OpenGL 4.3 driver Workbench crashes Blender, so the wrapper checks with a child Blender first and
  renders with Cycles on the CPU instead.
- Run Blender through the tool: in a worker's sandbox Blender started from a shell cannot reach the
  GPU (Metal) and crashes while it picks its GPU backend at startup, even with `-b`. The tool's jobs
  run in the native-job sandbox, which allows the GPU.

Both: their ids are bundled seeds, so no GitHub, index or local package may take them over, the
scaffold refuses them (with `example` and `studio`), and the app's catalog policy reserves them as
official ids.

## Deferred work

- Agent behavior extension points beyond [Genex's moments](#hooks-genexs-moments): judges and
  learning hooks. These need a separate authority/evaluation design; API 3 registers none of them.
- Studio-owned asset canvas: implemented as the Assets stage tab over plugin-neutral metadata
  (the host ledger, read-only plugin job records and the game's own assets folders). Interactive
  3D viewing and model/audio thumbnails remain deferred.
- Strong OS sandboxing for arbitrary backend publishers is not claimed by this trusted-code host.

## API 3 managed-native services

Local Blender (`src/plugins/blender`) is the public SDK example for installed native software.
Core owns only generic runtime discovery, pinned installation, process execution, cancellation,
project-bound inputs and asset delivery. Blender-specific bpy wrapping, model export and renders
live inside its plugin. No private core Blender hook is part of an agent's tool list.

A manifest declares fixed `nativeRuntimes` candidates and version probes. An optional installer
requires an exact HTTPS URL, bytes, SHA-256, archive shape, executable and license notices, plus a
matching confirmed user action. `runtime.detect` is read-only; `runtime.installation` hydrates a
durable installation job; `runtime.cancelInstall` is a user-action service. `runtime.install` runs
from the person's confirmed action, or from an agent's tool of the same name that declares a
`confirmation`, so the person answers its card first (Local Blender's `install`); a tool's call
answers `{started: true}` as the download starts and the installation record says how it ended,
since a call's deadline must not cut the download short. An agent cannot choose a binary, download
URL or installation action: either way the manifest's pinned one is installed.

A candidate (`native-candidates.ts`) is an absolute POSIX path (skipped on Windows), a path under
`home:`, `studio:`, `storage:` or, on Windows, `programfiles:`, `programfilesx86:` and
`localappdata:`; a path beside the program Windows opens a file type with (`opens:.blend/…`, from
the registry's open command); a path inside this user's Microsoft Store package whose name starts so
(`package:<name>/…`, from its `PackageRootFolder`); or `setting:<key>`, the absolute path the person
chose in one of the plugin's declared string settings. One segment may hold one `*` (`Blender *`),
every match tried newest name first. A runtime pins one download (`install`, read as macOS Apple
Silicon) or one per platform (`installs`, each with its `platform`: `darwin-arm64`, `win32-x64`,
`win32-arm64`; at most four, one per platform) as a `dmg`, `tar.gz` or `zip`; Windows unpacks with
its own `tar.exe`. `runtime.detect` answers the pin for this computer as `download` (none where the
manifest pins none), and an install there is refused in words that say to install it yourself. A version
probe may take 30 s, and the first one after an install 2 minutes: antivirus scans a program's first
start (Blender's took 15.8 s on a Windows VM with Defender, then 0.2 s).

`nativeJobs` declares fixed argument arrays with package/input/output/value bindings, validated
value patterns, input/output names, deadline, byte limits and optional GPU access. `native.run`
stages only declared project input files; the child receives no full-project read grant.
`timeoutMs` is 1,000–300,000 milliseconds. `maxOutputBytes` retains the last 1–256,000 bytes
of each process log stream; it does not limit asset files. `maxAssetBytes` limits the combined
declared generated files to 1–104,857,600 bytes. Delivery additionally enforces `assetLimits`.
Set `gpu: true` for GPU rendering, including Blender EEVEE; it permits GPU services and the
runtime's own Metal cache, which the job may also hand to Metal's shader compiler as a read-write
sandbox extension (no other folder): the compiler builds Metal's shader module there, and without
it a cold cache (a new Mac, a macOS or runtime update) fails every shader and crashes the first
render. It grants no network or full-project access. Runtime detection runs
the declared version probe, but never starts a generation recipe or installs software.
Managed jobs use the macOS sandbox, deny network and protected host state, and retain a durable
job ID before process launch. The profile (`nativeSandboxProfile`) names what a job may do: start
programs only from its runtime's folder (the `.app` bundle, or the executable's directory), the
interpreter a script runtime's `#!` line names (for `#!/usr/bin/env <program>`, that program as
found on the job's `PATH`, `/usr/bin:/bin`), and a short list of text utilities (`JOB_UTILITIES`:
`dirname`, `head`, `yes`, `sed`, `awk` and the like); signal and inspect only itself, its children
and its own process group; and look up only logging, notification, preference and user-lookup mach
services. Every other system program (`open`, `lsappinfo`, `osascript`, `curl`) is refused, and a
shim that starts another program (`/usr/bin/python3`) is not followed: name the real interpreter. A `gpu` job still gets the other mach services, because a render starts an AppKit
session whose application check-in reaches LaunchServices, the quarantine resolver and TCC; opening
other applications, the pasteboard, screen capture and the Dock stay refused. A job may fork, but `setsid` and `setpgid` are denied, so every descendant stays in
the job's process group; on exit, timeout or cancel Studio kills that group and, while the job
still runs, every descendant by parent id. A descendant `posix_spawn`ed into its own session whose
parent has already exited is the known gap. The result is recorded once the job exits, after at
most 2 s more for its pipes. Only declared regular output files reach the delivery directory,
each opened without following links and checked by device and inode (`copyDeclaredOutput`): a
link, a hard-linked file or a file swapped during delivery is refused. A pinned `.dmg` runtime is
copied with its relative links kept (`copyRuntimeTree`; a link out of the runtime is refused) and
probed after the image is detached.
On Windows a managed job runs in the process sandbox like every other agent process
(`runSandboxedNativeProcess`: srt-win as the sandbox user, through Git Bash), with no network. Its
staged inputs, outputs, scratch and the plugin's package files live in the profile's `native-work`
folder, writable from the sandbox's start; pinned runtimes unpack into `native-runtimes`, readable
from the start, so an install never waits for a regrant. A runtime found elsewhere in the person's
profile is granted for reading when detected; one under Program Files or a Store package is readable
as it is. Output goes to log files whose tails are kept, and `gpu` grants nothing more.
A runtime's version is `x.y.z` or `x.y` (read as `x.y.0`). An enabled plugin's runtime also starts a
bridge game whose `studio.json` play names it as its `engine` (docs/play-protocol.md): the studio
detects it as above and runs it long-lived in the same profile with the GPU, its stdio open.

`native.jobs` / `native.result` read recorded jobs and never replay an interrupted operation.
The backend then calls `assets.deliver`, stores the reference and verifies actual preview use.
Raw host output roots and process logs should stay in the trusted setup UI, not agent results.
`assets.deliver` reuses the same project/plugin/job directory on retrieval. Existing regular
files must match the saved result byte-for-byte; changed files and symlinks fail without being
overwritten. Missing files can be restored, and only new bytes count against the remaining
project allowance. Retrieving a native result never reruns its generation recipe.

The bundled Godot plugin (`src/plugins/godot`) starts Godot from its backend through the same
sandbox (`runNativeProcess` in `godot-run.ts`) rather than `native.run`, because a check, a run or a
still needs the whole project, not staged inputs: each job reads Genex's shipped GDScript, writes
only the project (Godot's `.godot/` cache) and the job's own folder, gets a private home (a game's
`user://` and Godot's caches) and a deadline, and a still is drawn in a window off every screen
(`gpu`). On Windows each job is a host sandbox job instead (`sandbox.run`, `windowsRunner`):
ProcessSandbox as the sandbox user, reading Godot's folder, writing the project
(one inside the game: a project linked from elsewhere is refused there, and the panel offers and
links only projects inside the game); at most two at once, the host's limit, the others waiting
their turn;
a folder it writes outside the game (a capture's stills, the class reference) waits in the
project's `.godot/genex-jobs/`, and so do Genex's own scripts (the plugin's package is in the
person's profile, which the sandbox user can't read) and any other file it reads from outside the
game (with no project yet, as for the class reference, in a folder of the
job's own at the game's root, `genex-godot-job-*`, which the game's `.gitignore` names so no save
point keeps it; a stage Windows still holds is removed again a few times, and what a crash left is
cleared before the plugin's first job in that game) and is copied out (a file it reads from outside,
copied in), and its CRLF, coloured output is read as a Mac's. The backend runs as the person, so it
makes and lists a stage only through real folders (a link or a junction in place of `.godot`,
`genex-jobs` or a stage stops the job and is never followed), copies out only its stills and class
reference pages, one plain file at a time (`.png`, `.xml`, opened without following a link and kept
only while their folder still resolves to itself and their name still names the very file read), and never removes a stage itself: a sandbox job
runs Windows's `rd /s /q`, which removes a link rather than what it points to, as the sandbox user,
so even a junction swapped in mid-walk reaches only what that user may write (an empty folder `rd`
leaves goes by itself; one still there after its tries is a line in the backend's log, and the next
sweep tries again). The sweep takes only stages Genex named (a UUID). A job that waited for its
turn starts with what its call's budget leaves (`web-export`'s), or not at all. Godot's own spelling
of a stage's path (forward slashes) is named as its folder too. The Genex addon's folders
(`addons/genex`, `addons/genex_multiplayer`) are made one at a time as folders of their own, and
each file is written only while its folder still resolves to itself. A save point's or the observer's
stills that fail answer nothing, as the checkpoint's check does.
Its observer is a `card` whose `stage-status` says where the game stands (get Godot, set
it up for Genex's play, open it, or open in the person's Godot) and its manifest has no lock: it never drives the person's editor.
On a Mac without Godot 4.3 or newer, `show-steps` (and the refusals of `new-game` and the engine
question's note, which point to it) puts the Godot setup card in the chat (`godot-setup.ts`): one
step, with Do it for me (`install-godot`: the newest stable Godot 4 universal Mac zip from Godot's
GitHub releases, unpacked in the plugin's storage, `Godot.app` copied into Applications only when
`codesign` accepts it against Apple's Developer ID chain with Godot's team, `6K46PWY5DM`, and
Gatekeeper accepts it; an older `Godot.app` there goes to the person's Trash, and the download is
removed whether the install ends well or not), Stop (`stop-install`: it ends the download, the
unpacking or the copy) and Don't use Godot (`skip`) in Hide's place, and `doneSays` once Godot is
found. On Windows Do it for me (and the panel's Get Godot) is `download-godot`, which the person
confirms: the host installs the manifest's pinned Godot (the 4.7.2 x64 or arm64 zip, its sha256
checked) into `native-runtimes`, which the sandbox reads from its start, and the card follows the
host's install record; Stop cancels it. Windows finds Godot there (`runtime.detect`), in Program
Files, in every Steam library (`libraryfolders.vdf`) and on the PATH, never elsewhere in the person's profile, which the sandbox user
can't read. The editor opens as a window of its own and is found by its command line
(`windows-processes.ts`).
Set up (and New Godot game) also turns on the addon's editor plugin (`addons/genex/editor_bridge.gd`,
`[editor_plugins]` in `project.godot`). Its hooks reach the person's open editor through files in the
project's `.godot/genex/` (`editor-bridge.ts`; no port): the editor writes a heartbeat each second
(fresh for 5 s), Genex leaves `ask-<id>.json` (`save` or `reload`) and the editor answers
`answer-<id>.json` within 15 s, every file written whole and none through a link. `save-all` at
`checkpoint.before` saves the open scenes and the changed scripts whose text Godot holds, noting
scripts left unsaved or an editor that didn't answer; at `restore.before` either one blocks, so a
restore never replaces work the editor still holds. `reload-editor` at `restore.after` rescans and
reloads the open scenes. With no editor beating, each answers nothing.
Its panel is an engine panel (design README): This game's project (state, the step: Set up for
Genex or Open in Godot, Change project, ⋯ Export for the web) and This computer (Godot, the Web
template), and Choose a project behind Change project: New project on top, then the person's Godot
projects (`find-projects.ts`: Godot's own `projects.cfg` and Documents › Godot Projects or
GodotProjects one level down, each once by real path, at most 12) tagged In use or Outside game,
and Choose a project.godot…. `use-project {folder}` links the game to that project
(`game.engine.link`, kind `godot`); every tool, hook and the observer then work in the project the
link names (`project-link.ts` `projectOf`), else in the game's own. A game linked outside its
folder gets no Loop and a Rewind note (`renderer/engine-game.ts`), its brief says the work
happens there, Set up installs the addon there (bin/play naming it by its path), and the chat's
session, leads, workers and Genex's play engine reach that folder.
`web-export` (agent tool, and the panel's Export for the web) writes Godot's Web export into `web/`
at the game's root (`web-export.ts`): Genex's own `Genex Web` preset (no threads) added to
`export_presets.cfg` beside the person's, `web/.gdignore`, and the person's Web template for that
version (`export_templates/<version>.<status>[.mono]/web_nothreads_release.zip`, installed by
Godot's Export Template Manager in Godot's data folder, a Mac's Application Support or Windows's
`%APPDATA%`) linked read-only into a Mac job's private home; on Windows a Godot job of Genex's
(`genex_data.gd`) first copies it into the sandbox user's own data folder, where that user's Godot
looks, and the export stops with a plain message when that copy fails. A missing template is
fetched first (`export-templates.ts`): for an official stable Godot, the release's templates archive
is read by byte ranges (its central directory, then only the template, 10 MB of 1.3 GB), each file
checked against the archive's CRC-32 and size; when that fails the tool is refused before Godot
runs, naming Godot's Template Manager. Only a 206 answer naming the range asked is read (a server
that sends the whole archive is refused, its body cancelled); each request has a deadline by its
size and the call's stop, and is tried up to three times. `web-export` fits the fetch, the copy and
Godot's export in its one call, and starts no export with less than a minute left. Windows's Do it for me fetches the Web template with Godot, and its Stop stops that fetch too.
`export-templates {platforms}` (web, windows, mac) does the same for an app export the agent runs
with Godot's command line, puts them where the sandbox user's Godot reads them on Windows, and for
mac sets `textures/vram_compression/import_etc2_astc` (new games from either template have it).
The tools that run Godot declare `timeoutMs` of nine minutes. `keep-web-build` at `turn.end` and `restore.after` makes it again
whenever the project changed since the last build (its `.pck` older than the project's newest file,
`.godot/` left out), so Live's Web game tab and Publish follow the game; with no Web template it does
nothing (it never fetches one), and a failure is a note. The plugin's `detect` names the folder `godot-web-export` (a folder
with `index.pck`); a plugin's web build is no new kind (the seed's `web-build.ts` `kindKey`), so a
turn that only exported never continues as one for a new kind, and the session's end tells the app's
game list its facts changed (`delegation.ts` `#announceKindTaken`). A game with no web game at its root plays and publishes its first web game in a
folder (`webFolderOf`, `shared/project-workspace.ts`): Live's preview serves that folder's
`index.html`, and Publish uploads the folder in the root's place; Multiplayer stays off for it, as
the chat never edits a build, except for a Godot game, whose project takes it (below). Godot writes the exported settings through its own temporary name
(`tmpproject.binary-*`) in macOS's per-user temporary folder, the one place outside the project an
export may write (`writePrefixes` in the native profile: one name's prefix, never a folder). A web game a plugin's fact also
claims is told to chats as a web build, never with the web template's rules.

`multiplayer` (agent tool, `multiplayer.ts`; its `godot-multiplayer` file skill says how to write
the online play) puts Genex multiplayer into the game's Godot project, web and native alike:
- **The addon.** Genex's addon `addons/genex_multiplayer/` is a copy of the Genex SDK's
  `sdks/godot` (`MULTIPLAYER_ADDON_SOURCE`). A changed file is kept as `.mine`. Its
  `GenexMultiplayer` autoload goes into `project.godot`.
- **The Genex project.** The game's slug (when given) and API go into `project.godot`'s `[genex]`
  section. A native build joins that game; the web build reads its slug from the page.
- **Matchmaking.** The `matchmaking` argument (checked: a preset, a win condition, numeric knobs)
  goes into the game's `genex.json`, which `readGenexGameManifest` sends at publish with
  `@genex-ai/multiplayer` at Studio's pin.
- **The native GDExtension.** The official Colyseus GDExtension goes into `addons/colyseus/`:
  - The release `godot-v0.18.5` is downloaded once into the plugin's storage, its archive checked
    against its pinned sha256 before anything of it is unpacked. A mismatch is removed, never used.
  - Only the release libraries for macOS, Windows x86_64 and Linux x86_64 are unpacked. Genex
    writes its own `colyseus.gdextension` loading them in the editor too, plus its MIT license.
  - A native part that couldn't be added is a note; the web part still stands.
- **The web build.** Genex's Web preset gets the head include
  `<script src="genex-multiplayer-bridge.js">` and leaves `addons/colyseus/*` out. Every export of
  a game with the addon copies the pinned SDK's `bridge.global.js` beside the page, with `genex-multiplayer-bridge.LICENSES.md` (the licenses of what it bundles, made at build by `bridgeLicenses`), which the
  addon's web backend drives through `window.GenexMultiplayerBridge`. The publish connect module
  hands that bridge the page's one player (`setIdentity` with Studio's embed SDK), exposes it as
  `window.genexEmbed` for a Unity WebGL build (a page's own kept), and puts the game's slug into
  `window.__GENEX__`.
- **Not yet.** Native play inside Studio's sandbox has no network, so online play is tested in an
  exported build or on the published web page.

These managed-job restrictions do not sandbox the plugin backend itself. It remains trusted
executable code, as disclosed at installation. The isolated custom panel has no Node or IPC.

`credentials.session` lets an API 3 backend reuse a host-memory credential lease already
explicitly unlocked by the user. It never reads the protected OS store. Disable/revoke clears
that authority; app restart restores once only after a prior successful connection/unlock recorded remember intent. Explicit re-enable or reinstall also restores once under that prior intent; duplicate enable requests do not retry a refusal. Explicit disconnect clears that intent; plugins remaining disabled or removed are not restored. A child crash must not create a new remote
job or cause repeated protected-store reads.

Asset limits measure existing delivered files across the project's recorded host-authorized
workspaces, including after restart. Separate worktree copies consume disk and count separately;
removing files releases capacity. This is a filesystem limit, not a generation or credit ledger.

## Plugin acceptance

Run `tests/conformance/plugins.test.ts`, `plugin-toolbar.test.ts`, `plugin-consent.test.ts`,
`plugin-marketplace.test.ts`, `plugin-local-install.test.ts`, `plugin-scan.test.ts`, `plugin-sdk-types.test.ts`, `plugin-devkit.test.ts`,
`genex-plumbing.test.ts`, `genex-plugin-cli.test.ts` and `genex-publish-dialog.test.ts` for real
backend process, provider-parity, lifecycle, permission and file-boundary regressions.
`plugin-lifecycle.test.ts` also pins the backend's PATH: the login PATH when Studio has one, its
own when the login shell cannot answer. `plugin-local-install.test.ts` covers changed
local packages at reinstall, fresh scan/capability disclosure, cancellation, identity mismatch,
edits during approval, snapshot cleanup and disabled-state preservation. `plugins.test.ts` pins
API 1–3 compatibility (`apiVersion: 4` is rejected), canonical key order and unknown-key drop; `toolbar`, `network` and
`tools[].confirmation` rejected under API 1; toolbar validation (reserved labels including
`Assets`, undeclared targets, confirmed status actions, the four-item cap); `publish-draft` /
`publish-gallery` needing trusted confirmation; the `toolbar()` accessor and the status action's
badge; consent fail-closed / declined (`PluginConsentDeclined` with `by`) / approved with the hook's
arguments; `onChange` reasons including a leased update and a process failure; the canonical
catalog compare with reordered keys; restore by recorded local origin and the gone-folder message;
dropped code listed as `not-enabled` until `allowUnlisted` and out-of-storage records force-disabled;
`export.stage` capability-gated and staged under plugin storage; `assets.deliver` reporting to the
host ledger. `plugin-toolbar.test.ts` covers `toolbarItems` (enabled installed plugins only,
`requiresProject`) and `toolbarStatusFrom` sanitization. Build UI checks include the Plugins
surface, Genex's host-drawn page and, right after the example plugin is loaded, the plugin
toolbar: `[data-plugin-toolbar="example:demo"]` present with the Plugins page closed; the click
opening `[role="dialog"][aria-label="SDK demo"] iframe[sandbox="allow-scripts"]` whose frame has no
`window.studio`, `require` or `process`; the exact `Close SDK demo` button closing it; and the
button disappearing on `setEnabled('example', false)` and returning on re-enable through the real
`plugins.changed` event, never a synthetic push. The Genex publish checks sit in the same block:
`button[aria-label="Publish game"]` present while Genex is enabled, its click opening Studio's own
`[role="dialog"][data-testid="genex-publish"]` with `[data-genex-publish-status]` and no frame, the ticketed
`publish-draft` approval refused with `unsupported-in-fixture`, Genex's own Publish staying with
`setEnabled('genex', false)` and opening the same dialog (Publish is the account's), `remove('genex')`
refused (Genex holds the app's account), and Genex's Publish still there once it is back on.

Claude Code's permissions ([tool permissions](tool-permissions.md)): `chat-permissions.test.ts`
drives the host on a lite core (who asks, forged threads and rows, withdrawal, modes, restart),
`engine-permissions.test.ts` the engine options and absolute rules (Windows form included), and
`tool-permissions`, `permission-store`, `permission-words` and `permission-entries` the pure parts.

`plugin-consent.test.ts` pins the consent ledger on its own: approve, decline, the timeout
(`by: 'timeout'`), a turn's end and a game's Stop settling only the questions in their scope, an
unknown or already-settled id resolving to `false`, and the turn's abort signal withdrawing a
question as a stop; and the run's own consent, with a hostile table of sessions that still ask
with no call. `delegation-unreal-live.test.ts` pins the lead's tools (no window) and its
unattended seat; `plugin-game-snapshot.test.ts` pins `game.snapshot` and its refusals. `genex-plumbing.test.ts` pins the runtime across every agent path
(claude-code, codex and the local harness registry): a pending `plugin_consent` card appears, the
declaration handed to the engine carries `confirmation`, a decline reaches the agent as
`{consent: 'declined', by: 'user'}`, an approval reaches the backend, `genex__publish-status`
asks nothing, `core.api()` exposes no consent method, and the question is withdrawn by the
timeout, by Stop and by the end of a turn. `consent-nobody-answered.test.ts` pins what a timed-out
card tells the agent (not a no; ask again later), reads as ("Nobody answered") and that the next
ask in the same run or chat turn is asked, while a real no still blocks it.
`plugin-action-approval.test.ts` drives main's review and action channels: a review's question and
`detail` on the native dialog under the action's label, the arguments as JSON only without a
review, and a review whose words are not bounded text refused before anything is asked or run.

`genex-plugin-cli.test.ts` publishes for real against the pinned CLI with a local http fixture
API, a `file://` bare repo as the managed source remote and a no-op `git-lfs` shim on `PATH` (it
skips itself when git is absent, and the shim satisfies the pre-check that keeps the CLI from
trying to install git-lfs): the hosted `project.json` lands under Studio storage, the game folder
gains no `.genex`, `index.html` is uploaded, `refs/heads/preview` is pushed, one Publish press
deploys once to the draft page, promotes that build and lists the game, a second press deploys and
promotes without listing again or creating a second project, and a draft alone promotes nothing. The same test first runs a
publish on a `PATH` where `git lfs version` fails, and pins the refusal: no job is started and the
CLI is never spawned, because its `pushSource` would otherwise `brew install git-lfs`. **No live Genex publish, preview or promote is ever run
in verification** — no real account, no real upload, no paid generation. Retain all existing Genex accounting/recovery
tests; the source adapter re-export lets those tests exercise the extracted implementation
unchanged. Verify installed, disabled and removed Genex in the packaged application; existing game
assets remain ordinary files. A fixture `assets.deliver` must leave an `asset_delivered` event in
the project's log and a card on the Assets tab; no paid generation is needed for either. Use
fixture accounts and existing assets, with no additional paid generation.

`genex-cover.test.ts` pins the Genex cover the same way, with a fake `observe` and the cover routes
on the fixture API: `genex__cover` shoots only the `genex-cover` demo into the plugin's storage
(the game folder locked, never read) and answers its preview; a publish sends the frame only after
its upload is recorded (a draft's page check may still be running), sends nothing for unchanged
bytes or over the owner's own cover (recorded as such with no shot kept, by a publish and by a
status check), stays done with a warning when the commit is refused, limited,
failed or silent or the shot cannot be kept, skips the shot without enough of its invocation left,
never sends from a listed game's draft (listed from the dashboard too), sends the bytes it records
however shots interleave, and is stopped by the next publish; `genex__cover-set` waits for consent,
sends nothing without a hosted project and never sends the clip; a bad project name reaches no host and writes nothing.
The chat's cover card: `chat-transcript.test.ts` pins which shoot gets it (the latest that kept a
shot, read by plugin, tool and operation) and when (its turn or build ended, the work one group),
`genex-publish-view.test.ts` when it offers Publish,
and `npm run test:ui -- chat-cover-card-ui` renders the production chat beside the stage strip:
the kept shot at 16:9, Publish opening the dialog, Publish hidden while publishing, with Genex
off or once Genex took the frame, and no card once the shot is gone.

`plugin-marketplace.test.ts` drives `PluginMarketplace` with an injected `fetchImpl` and never
touches the network: index validation, spec parsing, the 6 h cache with its stale-plus-error path,
the `marketplace.json` override and its https-only rule, `offline: true` never fetching, GitHub
staging with the per-file blob-sha check, and the symlink, submodule, truncated-tree, size,
missing-manifest and index/manifest-mismatch refusals. `plugin-scan.test.ts` covers each rule, the
max-severity verdict, the finding sort order, and the example scanning `safe`.
`plugin-sdk-types.test.ts` is the only guard on `src/plugin-sdk/index.d.ts`, because `tsconfig`
has `skipLibCheck`: it compiles sources against the declaration with lib checking on and asserts
mutual assignability with `src/shared/plugins.ts`. `plugin-devkit.test.ts` spawns
`scripts/plugin-new.ts` and `scripts/plugin-doctor.ts` as real processes in a temporary directory
and checks their exit codes, refusals and JSON report.

Run `npm run plugin:doctor -- src/plugins/example`: it must exit 0, probe `ready`, scan `safe`
with no findings and no warnings. **Fixture profiles never fetch the marketplace index** — the
marketplace is constructed offline, Community plugins shows only Coming soon, and the
GitHub lookup, install and update channels are in `FIXTURE_BLOCKED_CHANNELS`; a readiness or smoke run that reaches GitHub is a defect, not a flake.
The readiness run also asserts that no two controls inside `[data-stage-strip]` share a label,
which is what the manifest's reserved-label and aria-uniqueness rules exist to protect.

Run `node tests/e2e/run-build-smoke.mjs --packaged` after packaging to exercise the same plugin
UI assertions from the actual app bundle, including the independent example, opaque frame,
standard settings, toolbar, fabricated approval rejection, the offline Marketplace, the
Install from GitHub window and `Scan: safe` on the example detail page. Also
inspect the page and the toolbar visually: semantic interaction assertions do not prove
background opacity or readable layout.

Hot reload is best-effort: the watch case in `plugins.test.ts` is deadline-based because recursive
file watching coalesces events on macOS. If it ever flakes, raise the test's nudge cadence — never
its deadline or its assertion.
