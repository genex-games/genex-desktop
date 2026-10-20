# Studio plugins — API 4

The composer's Add panel lists installed plugins with the same global enable switches, plus
configured MCP connectors. Enabled and connected are separate states. Connect lists tools on
the registry's live connection (or opens setup when trust/secrets are missing); Manage opens the
sidebar's Plugins workspace page, which includes MCP servers. Local Blender is an
independent first-party plugin using the public API 3 managed-native services, declared on API 4
so it is told when a game is Rust · wgpu and briefs that game for the genex facade. It needs no Genex account. No connector credentials enter the composer. See [connections and context](connections-and-context.md) for the current setup/session lifecycle.

Plugins contribute tools, skills, standard settings, isolated interactive panels and, since API 2,
buttons in the stage strip beside Live/Builds and MCP servers the host runs as connectors they own. Genex is bundled and enabled by default. Enablement
never signs in, unlocks credentials or enables paid assets. Core game creation, previews and
exports work with no enabled plugins.

## Compatibility policy

- `apiVersion` is `1`, `2`, `3` or `4`. All are accepted by the same validator (`substrate/plugins/manifest.ts`)
  and run on the same host; a manifest that names any other version is refused as incompatible.
- API 4 is additive over API 3: it adds `rust-wgpu` to the stacks a skill may name and a backend
  may be sent (see `stacks` below). Nothing else changes. Studio's games come in three stacks —
  `three-js` (a browser game), `raylib-cpp` (a C++ · raylib game) and `rust-wgpu` (a Rust game on
  the genex facade) — and a plugin on API 3 or earlier still loads and runs for all three; it is
  simply never told that a game is Rust (see [Backend SDK](#backend-sdk)). Local Blender declares
  API 4; the bundled Genex plugin is on API 3 and the SDK example on API 2, the API `plugin:new`
  scaffolds, because the catalog's check (`marketplace/template/scripts/check-catalog.mjs`) still
  accepts only API 1–3.
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
to `packages/<id>/<version>-<uuid>`; once the new copy is active (and its MCP servers moved to it)
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
| `apiVersion` | 1–4 | Supported SDK major; unrecognized versions are incompatible |
| `id`, `version`, `name`, `publisher`, `description`, `backend` | 1 | Identity, semver, display text and the backend module path |
| `capabilities` | 1 | Host services the backend may call: `settings`, `project.read`, `project.write`, `jobs` (also `events.emit`), `observe`, `credentials`, `external-auth`, `network`, (API 2) `export`, and (API 3) `native-runtime` |
| `tools[]` | 1 | `{name, description, parameters}`; scalar properties only; agent-invoked as `<id>__<name>` |
| `tools[].confirmation` | 2 | 1–300 characters. The tool needs the user's consent before it runs; see the consent model below |
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
| `workspace` | 3 | `{facts?, ignore?, copySkip?}`: what history and writers' copies leave out of a folder holding the plugin's facts; see [Workspace rules](#workspace-rules) |
| `assets` | 3 | `{facts?, folders, formats?}`: where the assets of a folder holding the plugin's facts live (1–8 folders inside the fact's folder or `.`, up to 32 lowercase extensions without the dot) |
| `workerTypes[]` | 3 | Up to 16 `{id, description, tools, isolation}`: the kinds of worker a lead may start while the plugin is on; see [Worker types](#worker-types) |
| `scaffolds[]` | 3 | Up to 8 `{id, label, tool?, game?, facts?}`: the kinds of project the plugin's tools make, each with its own label; see [Scaffolds](#scaffolds) |
| `folders[]` | 3 | Up to 8 `{path, why}`: folders outside the game the plugin's engine programs write to, workers' write roots; see [Folders](#folders) |
| `locks[]` | 3 | Up to 8 `{id, label, per, personFirst?}`: what one holder at a time may use, giving way to the person; see [Locks](#locks-the-person-comes-first) |
| `tools[].needs`, `mcpServers[].needs` | 3 | 1–4 of the manifest's lock ids a call of the tool, or of the connector's tools, holds while it runs; see [Locks](#locks-the-person-comes-first) |
| `hooks[]` | 3 | Up to 32 `{on, tool, facts?}`: the plugin's harness tools Genex runs at its moments; see [Hooks](#hooks-genexs-moments) |
| `observers[]` | 3 | Up to 8 `{id, facts, tool, live?, label?}`: what Genex can capture of a project with these facts, and the Live view it shows; see [Observers](#observers) |
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
- **`stacks`** (API 3, either kind): the games a skill serves, one to three of `three-js`,
  `raylib-cpp` and (API 4 only) `rust-wgpu`, each once; absent serves every game. On API 3 or
  earlier, `rust-wgpu` is refused, and a list naming both pre-Rust stacks means every stack, a
  Rust · wgpu game included; an API 3 backend's calls for a Rust game carry no `stack`, a stack its
  API does not know. A C++ · raylib game's delegated builders,
  planning and conversation are never handed a skill that names only `three-js`, nor its name in
  the skill tool, which refuses to read it on any call bound to that game; the bundled Genex plugin
  marks its two `genex-threejs-*` cards so. Local Blender serves Three.js and C++ · raylib games
  its `local-modeling` card and Rust · wgpu games `local-modeling-rust`, which loads the delivered
  GLB with `gfx.assets().model` instead of `GLTFLoader`.
- **Facts and tools** (API 3, either kind): `facts` limits the skill to the briefs of games that
  hold one of those facts, and `tools` (1–16 of the plugin's own agent tools) keeps it only while
  one of them reaches the session too ([Scope by facts](#scope-by-facts)). `engines`, a non-empty
  list of `GameEngine` values (`web`, `unreal`) each named once, is the older spelling: `web`
  reads as `web-game` and `unreal` as `unreal-project` (`skillScope`); `facts` wins when both are
  given. Without either a skill reaches every game. The bundled Local Blender skill (GLTFLoader)
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
| Stacks | 1–3 distinct `GameStack` values (`rust-wgpu` from API 4), or absent (API 1–2: ignored) |
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
Each builder brief is built from one registry `snapshot(scope, offered, stack)`, so its tools and
skill lines agree; `scope` is the game's kind (its facts, or the older `engine`: `studio.json`
`engine`, read by the delegation before it takes the plugin lease, and by the capability facts a
session without plugin tools reads), the web's when no game is named, and `stack` the game's stack
(`stacks` above). The tools are the same for every engine. The plugins and skills a session was
handed ride its `tool_registry_applied` event; a resumed session
that has since lost some is told first to ignore their earlier instructions and not to call their
tools (`delegation-prompts.ts`).

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
  `boxes`, `unreal`).
- `target` is either `{kind: "action", name, args?}` naming a declared action (scalar args, at
  most 16 keys) — pressed, it runs the same review → ticket → native approval sequence as the
  Plugins page — or `{kind: "panel", id}` naming a declared panel, which opens as a dialog over
  the stage (`role="dialog"`, labelled with the panel title, closed by a button reading
  `Close <title>`); the native game view is hidden while it is open.
- `requiresProject` (default `true`) hides the button until a game is loaded.
- Buttons render as `button[data-plugin-toolbar="<plugin>:<item>"]` immediately after the
  Live/Builds group, for enabled installed plugins only; a disabled, removed or not-enabled plugin
  contributes nothing.

**Status.** `status` names a declared action **without** confirmation. Studio calls it with no
arguments (and the current project binding) when the toolbar mounts, on every `plugins.changed`,
debounced to once per second, whenever the open game's own record changes (`game.changed` without a
file, as a link to an engine project does), and every 30 s while a project is open; switching games
clears the old game's words at once. It returns a
`PluginToolbarStatus` — `{badge?, disabled?, title?, tone?: ok | warn | err | info, attention?, dot?}`
— sanitized by `toolbarStatusFrom` (badge ≤ 16 characters, title ≤ 120, unknown tones dropped,
`attention` and `dot` booleans). The badge is a word in its tone, or with `dot` a 6 px dot in it
(green, amber, red, grey) whose word leads the tooltip. The title shows in the strip's own tooltip.
A button is drawn in the prompt bar's quiet pill fill, or in the accent while its status sets
`attention` (the action is due) and the game is not empty; Genex's Publish uses only `title` and
`attention`. An offered update's Update badge is always a word in the quiet tone. A backend can also
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
`storage:project`, never the package, which an update replaces and a remove deletes; `HOME` is set to
a folder inside whichever you pick, so a CLI that reads dotfiles on startup cannot reach the user's.
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
gets "set it up from the Unreal button", and no editor
is asked. Only with nothing chosen does the bridge use the first set-up project whose editor
answers. Each answer ends with `[Unreal project: <Name>]`. "Answering" means Epic's own server
completes an MCP `initialize` on the project's port: an empty `serverInfo.name` (UE 5.8.3 never
fills it, where other MCP apps name themselves) with both the `resources` and `tools`
capabilities. Nothing else counts, so another app's MCP server on the port is never taken for
Unreal. Epic's answer names no project, so the bridge and the status also ask the Genex editor
helper's `project_file` which project the editor has open, and use the editor only when it names
this project's real `.uproject`; another project's editor on the port gets no call and never
shows Connected. The panel and toolbar status remember a project's last good answer for 10 s:
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
navigation bounds rebuilds its nav mesh, so no AI stands on a stale one); `gx.scope` makes a script idempotent,
and `gx` places instanced meshes, bevelled Nanite kit pieces, world-aligned materials, an
atmosphere preset (`megastructure`, `daylight`), lights and hero cameras (`GX_Shot_<name>`).
`import_model {file, dest, name, collision, nanite}` combines a model file of the game's assets into
one static mesh in `<dest>/<name>/`; `import_character`, `import_animation` (with its `skeleton`),
`import_sound`, `retarget`, `attach_to_socket` and `audit` do what their names say, and no import
opens the Content Browser. Imports and retargets refuse during play, where Unreal makes only part of
an asset (a Skeleton with no mesh) and says so only in its log; a skeleton scaled at its root (the
root joint's own scale counted) comes back with `scaleWarning`, fixed by Local Blender's `rig`
export, which applies an armature's scale to its bones and clips. The eyes: `capture_shot {camera, width, height, delay_s}` (a still from a
hero camera, no play needed), `capture_play` (the player's 3D view during play, through the player's
console `HighResShot`, which leaves out on-screen UI), `motion_strip` (frames scheduled by the game clock, one at a time, each with
the pawn's and view's position) and `shot_cameras` (the hero cameras' labels). The bridge waits for
a capture's file and hands the agent the picture itself, with its tone numbers (black point,
contrast, near against far contrast, saturation; a nearly black frame is called out as a render to
doubt) and the frame rate (`editor-captures.ts`, `tone.ts`); a strip comes back as one contact sheet. `attach_mesh` puts a static mesh on a
Blueprint's component, and `set_route` (the route the play checks drive), `track_terrain` along it
and `dirt_material` serve racing games. The plugin's skill (`unreal-editor`) tells every agent to
look with these eyes, never `CaptureEditorImage` (the whole editor window) or `CaptureViewport` (the
editor camera), and the lead's brief says the same.

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
then `SIGTERM`, then `SIGKILL`; processes are listed on a Mac only), rebuilds the game's module with
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
`update-helper`, `add-cpp-module`, `export-reference`, `hero-shots`, `play-check`, `run-part`,
`rollback-part`, `reload-level`); lookups, the gate, the probe and the readers need none. While the
person plays in the game's editor, the agents' and Genex's calls there wait. A play the agent
started is not the person's: the connector marks the agent's `StartPIE` with `agent-play.json` in
its own folder (`<storage>/mcp/<game>`, `src/plugins/unreal/agent-play.ts`), cleared by its
`StopPIE`, a crash under a call or the connector closing, and a mark older than 30 minutes is not
believed; nor is a play the plugin's own queue is running. `new-game.ready` names `engine-status`,
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
with no network and a fresh environment. It builds with `-NoUBA`: the build accelerator lists the
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

**The Unreal projects panel** (`setup.ts`, `backend.ts` and the `setup` panel, titled "Unreal
projects") finds the engines in Epic's
launcher list (`LauncherInstalled.dat`). Its project list (`find-projects.ts`) joins Unreal's
recent list (each 5.8+ engine's `EditorSettings.ini`), `*/*.uproject` one level inside Documents ›
Unreal Projects, and the projects Genex created, set up or was shown. Each project appears once by
its real path, with the file's own name on disk (another case of the name is the same project),
newest first, at most 12; the folder scan is kept for 10 s. Types come from `lstat`, never from
`readdir`, so Windows OneDrive placeholders count as plain files and folders while real links are
still skipped or refused. There is no path box: **Choose another project…** calls
`studioPlugin.chooseFile({title, extensions: ["uproject"]})`. The list is "Choose an Unreal project".
In a web game with no Unreal project it leads with "Make this game in Unreal" (a new project in the
game's folder; what was made for the web stays, and Undo in the chat switches back), then "Or use a
project you have"; in a game, each row outside its folder is tagged "Chats only" (Loops and Rewind
can't reach it). A pick is linked only by
"Use … in this game", which leads, with Open in Unreal second, for a set-up project the game doesn't
use yet.

`stage-status` answers the same step for the open game's own project, which the Live card turns into
one button (`whereItStands` is shared with `status`). `status` returns the engines, the list, the
shown project and `next`, the panel's one primary step
(`PanelStep`: get-unreal, choose, quit-first, set-up, update-helper, open, starting, connected,
switch, not-answering, port-blocked, open-when-free). The shown project is, in order: the one the panel names,
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
Open is the step; a port another app holds by then shows set-up again), as it does for not-answering, and the toolbar's Not open says the same; no copy names the port's number. `busyPort` is the port Open found still held when it opened the
project, while its editor runs unanswered; the panel adds that to Starting and not-answering. While the shown set-up project
runs unanswered and isn't loading, status asks the other set-up projects on their own recorded
ports; when one answers, `openProject` names it and `next` is switch, which the panel turns into
one press: Unreal's normal quit, then Open in Unreal once it has closed. A project counts as set up with its plugins on, its own port and
a setup record; a Genex editor helper that is older or missing gives it the update-helper step
(setup again copies only the helper) rather than making it look never set up, and Connected then
adds a quiet note. A user's Open updates an older helper only in the open game's own linked project, so only
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
set-up project's port, `next` is set-up again, which moves the port (not yet on Windows). Xcode
is recommended to every Mac user, since without it Genex works in Blueprints only: status's `xcode`
(`xcode.ts`) gives the panel an Xcode row, last and only under a shown project, that says to get
Xcode, to open it once to finish its setup, to run one Terminal command (with Copy) when another
developer folder is selected, or the range the engine builds with (once ready, only its version
beside the engine's at the panel's end): one too new
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
  layout;
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
Editor", `requiresProject: false`) opens the setup panel and stays while the plugin is on, also
before any game exists and for a web game. Its `toolbar-status` is per game. While no Unreal 5.8 or
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
`_meta: {"genex/outcome": "unknown"}` (`CONNECTOR_OUTCOME_META`, the Unreal bridge's crash answer).
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
acts beyond the game folder. The host — never the plugin, never the agent — asks the user:

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
Context supplies project/directory/thread binding, the bound game's `stack` on a builder's call
(`three-js`, `raylib-cpp` or `rust-wgpu`: pick formats the game's stack loads), an AbortSignal and
`host(method,args)`. `rust-wgpu` reaches only an API 4 backend; an older backend bound to a Rust
game gets a context with no `stack`, as for a game whose stack the host does not know.
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
- `assets.deliver`: copy plugin-owned output into a unique project asset directory, refusing
  symlinks and overwrites; requires `project.write`. Studio records each delivery in the project's
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
  the bound game to an Unreal project file, read its link, or show the plugin's steps card in the
  calling chat (see "A game's engine" below).
- `game.snapshot {reason}` (capability `game-engine`): an ordinary game snapshot of the bound game,
  listed in Rewind under `reason`, taken before the plugin changes files there (the Unreal plugin,
  before it updates the editor helper in the game's project). Refused without a bound game; a
  reason that is not one plain line of at most 200 characters is refused and takes nothing.
- `game.engine.runs` (capability `game-engine`): the games whose run (a Loop) is going now that this
  plugin linked to a project, each as `{game, title, project}`; no bound game needed. The host asks
  nothing while no run holds the studio awake. The Unreal plugin reads it so it never offers to quit
  an editor a Loop is using.
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
generating or a sign-in waits, otherwise once a minute (`genexPollMs`). Plugin process failures
are shown in Plugins and reported as a `failed` change.

## Project facts

Every listed game carries `facts` (`GameProject.facts`, `shared/project-facts.ts`): what its folder
holds, as `{id, path, source}`, possibly several (`unreal-project` at `.` and `web-game` at
`site`). They come from a bounded walk of the folder (`substrate/project-facts.ts`: four folders
deep, 4,000 entries, never through a link, skipping hidden folders, `node_modules` and the folders
engines write while they run) matched against the core table (`web-game` by `index.html` outside
output and vendored folders, `unreal-project`, `unreal-plugin` outside a `Plugins/` folder,
`godot-project`, `unity-project`, `blender-assets`) and the `detect` rules of the **enabled**
plugins (an installed plugin that is off detects nothing; source `plugin:<id>`). A fact below a
folder that already has the same one is dropped. The engine link reads as `unreal-project` at its
`.uproject`'s folder (source `link`) and stands for the game's Unreal project: another `.uproject`
the folder holds is not a second one. A scaffold recorded in `studio.json` adds its rules (source
`scaffold`, see [Scaffolds](#scaffolds)). Never counted: the web template beside an older engine link,
what a port replaced (`portedFrom` in `studio.json`, kept as the reference), and a starter an older
New game wrote that nothing has been built in yet (its `scaffoldStamp` still matching). New game
now makes an empty folder. Either way the game lists no facts and has no kind until its first
message picks one (`start_web_game`, or `game.start` from the harness, writes the web starter).
A Loop on any project that isn't a web game (`loopProfileOf`) is led in place by the chat's own
session, and the plugins whose facts reach the folder shape it with no code in Genex: their hooks
run at its moments, their observers feed its finish check and their worker types are its lead's
([the open Loop](harness-runtime.md)).
`web` is `web-game` at the root.

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
beside its name: the scaffold's label while a fact its rules found is there, else `Unreal plugin`
or `Blender assets` for a folder holding no game (`renderer/project-kind.ts`). The Unreal plugin
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
`~/Library/Keychains`, `~/Library/Application Support/Genex`), compared case-blind. The Unreal
plugin names the two its build tool writes: `~/Library/Application Support/Epic/UnrealBuildTool`
and `/private/tmp/.dotnet`.

### Hooks: Genex's moments

`hooks` (API 3, `substrate/plugins/hook-manifest.ts`; vocabulary in `shared/plugin-hooks.ts`) names
the plugin's harness tools Genex runs at its moments: up to 32 `{on, tool, facts?}`, each `(on,
tool)` once. `tool` is one of the plugin's own tools with `audience: "harness"`, no `confirmation`
and no `host`; `facts` (1–8 fact ids, each once) narrows it to the games they reach ([Scope by
facts](#scope-by-facts)). Another plugin's tool, an agent tool or an unknown moment refuses the
manifest.

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
An agent's call has its
arguments checked and its card answered before it waits (`registry.prepareTool`), and waits up
to 4 minutes (less when its call's deadline leaves less), then answers like a
declined consent (`{blocker: "lock", lock, reason, hold, message}`: `reason` the lock's refusal,
`hold` Genex's `HookHold` the harness words the person's line from, its record closed with the message); a
person's own action never waits for the person. A worker writing in place holds Genex's in-place
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

### Observers

`observers` (API 3, `substrate/plugins/observer-manifest.ts`; vocabulary in `shared/observers.ts`)
names what Genex can capture of a project, as evidence a reviewer reads: up to 8 `{id, facts, tool,
live?, label?}`. `id` is a slug (`^[a-z][a-z0-9-]{0,39}$`, unique in the manifest), never `preview` or
`proof`, which are Genex's own; `facts` is 1–8 fact ids, each once; `tool` is one of the manifest's
tools as a hook's is chosen (only the harness calls it, it asks nothing and runs no host program);
`live` is the Live view Genex draws for it: `stills` (any plugin) or `unreal-card` (only the bundled
Unreal plugin); `label` names that view's tab when a folder has more than one view (1–24 printable
characters on one line, not blank; shown as plain text), else the tab takes the plugin's `name`. A
label that repeats, in any case, a name the stage strip already shows (a reserved toolbar label such
as `Live`, `Builds` or `Assets`, or Genex's own `Web game` and `Unreal`) is refused. Only
these keys are kept. `observersFor` (`registry.observers(game)`) lists a game's
observers: each plugin's in plugin order, one per folder its facts reach (the hooks' rule), then
Genex's own `preview` of each folder served as a web game (a game with no kind yet at its root). Only
a plugin that is on captures (`registry.observerTool(key)` answers null otherwise). The bundled Unreal
plugin's `viewport` observer runs `hero-shots` and shows the Unreal card.

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
kind of view and one per `stills` observer, ordered: the Unreal project the game's engine link names first, then the game's root,
then by view (the Unreal card, Genex's preview, a plugin's `stills`), then by folder. The first is the
default. A folder with one view keeps the strip's Live tab; one with more (a web game and an Unreal
project) gets a tab per view in Live's place (`panels/stage/stage-tabs.ts`): "Web game", "Unreal", or
a `stills` observer's `label`; the default's tab keeps `data-stage-action="live"`, the others
`live-<view>` (`live-unreal-card`), a `stills` view's with its observer key (`live-stills-<plugin>/<observer>`). The last one chosen is remembered per game
(`studio.liveView.<game>`), and a web build put on the stage brings the Web game view forward. `unreal-card` is the Unreal card (where the project stands, and the
newest viewport capture as its shot, else the newest save point's still); Genex draws it for any
Unreal project fact, whatever the plugin list says (off, removed, older, not read yet). `preview` is
the web preview, also for a game with no kind yet; no plugin's `stills` take it over. A plugin's
`stills` count only while the plugin is on, never from an unlisted package. A folder no observer
draws (Godot, Blender, files of its own) shows the newest capture's pictures of the run the stage
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
names the guide while Genex Tools is on (read `genex__skill {"name":"plugin-author"}`, write the
plugin in the project, check it with `plugin_check`, tell the person how to load it) and otherwise
says the guide comes with Genex Tools, to suggest with `plugins_suggest`. The `plugin-author` skill
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
link and the host makes it (`substrate/plugins/engine-links.ts`). `game.engine.link {project}`
checks the `.uproject` by real path (absolute, no `..`, a regular file once every link is
resolved), keeps the link in the plugin's storage as `links/<game>.json` (`{kind, project,
linkedAt, previous}`, which the plugin's MCP servers read and agents can't write), mirrors it into
the game's `studio.json` as `engine` (`substrate/game-engine-binding.ts`; believed only while the
file is still at that real path), and appends `engine_linked` to the calling chat (the game's own
chat for a link made in the panel): "Lantern Run now builds in Unreal · Lantern" with Undo. Linking the project a game already uses changes
nothing. Undo (`studio:game.engine.undo`) is offered on the game's newest link only and refused
once the link has changed; it restores the project the link replaced, or leaves the game a web
game that stays unlinked (`{unlinkedAt}`), and appends `engine_link_undone`. A refused link
changes nothing on disk.

A call to a `game-engine` plugin's MCP server never links a game: a game takes an engine project
only through the person (Use in this game) or a tool that declares `makes` (`use-project`,
`new-game`). `new-game` offers the plugin's steps card (`game.engine.steps` appends
`engine_steps`) while a step is open.

The steps card ("Unreal setup") sits above the composer while nothing else waits there. Its
rows are the plugin's `steps` action, read every 5 s while it shows, so Xcode installed or opened
outside Genex is ticked by itself; it goes when no step is open, and Not now hides it for that game
until the next offer. Unreal's rows: the project is set up, then Install Xcode (Open App Store) and
Open Xcode once, or the one Terminal line for another developer folder, or Update Xcode for one too
old for the engine, or Add Xcode N for one too new (Apple's developer downloads page; a second
installed Xcode in range is the one to select instead). `get-xcode` opens only the App Store page,
Apple's downloads page (`{step: downloads}`) or the Xcode app the probes found. The agent shows it again with `unreal__show-steps` when C++ would
help, switches a game to another set-up project with `unreal__use-project`, and makes a game's
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
`unreal__plugin-build` needs the editor lock and asks first: the call saves the person's work through
the Genex editor helper, quits Unreal and waits, then the host's editor target is built as the
plugin's background job, which opens Unreal again after a good build and leaves it closed after a
failed one. `unreal__plugin-test {filter?, stop?}` runs `UnrealEditor-Cmd` headless
(`automation-tests.ts`: `Automation RunTests <filter>`, the plugin's name by default, no shell, a
small environment, its own process group, 30 minutes) and keeps Epic's report and a `summary.md` in
`unreal/Saved/Genex/Tests/<Plugin>/`. Like `open-editor`, it runs outside ProcessSandbox and
UnrealBuildTool's Seatbelt profile: it loads the same host project and plugin binaries that the
person's own editor loads after every `plugin-build` (so the plugin's code gains no access it lacks
there), and the editor needs what that profile denies (its per-user engine folders, the derived data
cache, its shader workers). Its last lines and failure messages reach an agent with the project's
and engine's folders taken out and any other absolute path cut to its base name (`ubt.ts`
`pathScrubber`). `unreal__plugin-package {stop?}` runs `RunUAT.sh BuildPlugin`
(`uat.ts`) in UnrealBuildTool's sandbox, which may also write the package folder (`extraWrites`), with
UAT's logs in the sandbox's scratch; the package goes to `unreal/Saved/Genex/Packages/<Plugin>/` and a
note beside it (`<Plugin>.md`: path, version, files, platforms, or the errors; a new run removes the
last one first; the note is written only in the packages folder as it is when the job ends, never
through a link swapped in meanwhile, and the packaged descriptor is read only as a plain file within
its cap). One job runs at a time per project, reserved before anything is touched, and each job is
its plugin's own (a call naming another plugin never reads, answers for or stops it); a build
reads as Genex's own restart from before Unreal is quit and is refused while Genex reopens Unreal or
adds its C++ module; a call stopped before its job starts changes nothing (a build stopped once
Unreal was quit opens it again); and the backend stopping (Genex quits, the plugin is turned off)
ends every running job's process group. A headless editor that exits badly before Automation wrote
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

## Panels and trusted approval

Panels register `settings` or `project` placements. They are opaque-origin sandboxed frames
served over `studio-plugin:` with scripts enabled but no Node, Studio preload or direct IPC.
CSP refuses network, forms, external scripts and external images. Inline prebuilt JS/CSS and
image data URLs are supported. Use `src/plugin-sdk/panel.js` for request/response handling. The
same host (`PluginPanelHost`) serves a panel opened from the Plugins page and one opened from a
toolbar button.

`studioPlugin.call('context')` returns the selected project, host API version (`3`) and theme tokens:
`background`, `foreground`, the raw `accent`, and the readable button colours Studio's own primary
buttons use (`accentFill` under `accentForeground` text, at least 5:1, and `accentHover`);
`call('settings')` reads standard settings; `call('action', name, args)` invokes a declared action.
A failed call rejects with an `Error` carrying the host's words; when the person declined Studio's
confirmation it also carries `code: "cancelled"`, so a panel can stay quiet without matching text.
The parent validates source frame, opaque origin and request shape, and binds plugin/project
itself. Closing the panel removes the listener; the SDK bounds waiting promises.

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
  Marketplace is only Coming soon (`[data-marketplace-soon]`), as it is whenever the catalog offers
  nothing new. `studio:plugins.install-github`,
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
`<!-- STUDIO_PANEL_FONTS -->` takes Genex's two faces as `data:` fonts (`inlinePanelFonts`, used by
the Unreal panel's build), the only fonts the panel CSP (`main/plugin-panel-csp.ts`) loads.
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

- `host-cli` MCP servers run Studio's own bundled Genex CLI (`@genex-ai/cli-demo`, an app
  dependency unpacked from the asar) behind `src/genex-host/preload.mjs`. The manifest validator
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
  or not; `outranked`) and no publish runs, one quiet line offers Ask for a cover (`[data-genex-cover-ask]`,
  `coverAsk` in `genex-publish-view.ts`): it closes the dialog and leaves "Make this game's Genex
  cover." in that game's chat composer (`renderer/compose-in-chat.ts`), never sent. A Genex plugin
  older than covers answers no record, and the line stays hidden. Genex-specific core UI, accepted
  by the owner; a second plugin with a cover would need a declared host surface instead.
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
  regular file, never a link. Multiplayer is refused there. The paid tool and the package tool need consent; fixture profiles refuse
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
  Workbench draws.

CC0 Library: its backend imports the CC0 fetch core (`substrate/cc0-fetch.ts`, with fflate) and
the lock's texture-usage table, which `scripts/build-plugins.mjs` bundles from this repo.

Both: their ids are bundled seeds, so no GitHub, index or local package may take them over, the
scaffold refuses them (with `example` and `studio`), and the app's catalog policy reserves them as
official ids.

## The CC0 Library

The bundled `cc0` plugin (`src/plugins/cc0`, owner call C11, on by default, no account) gives every
game free CC0 assets. `cc0__search` reads Poly Haven's model, texture and HDRI lists (cached an hour
per kind) and ambientCG's material search; each result names the `source` and `id` that
`cc0__fetch` takes. `cc0__fetch` runs in the plugin's backend, never in an agent's sandbox, under
the CC0 fetch rules of `substrate/cc0-fetch.ts`: every URL is plain https on an allowlisted host
(the API hosts `api.polyhaven.com` and `ambientcg.com`; the download hosts `dl.polyhaven.org` and
`ambientcg.com`; `acg-download.struffelproductions.com` only as the one redirect ambientCG's `get`
answers), each download is checked against its published size and md5 and pinned by sha256, and
nothing is written until every file of the fetch has passed. A Poly Haven model is packed into one
self-contained GLB (its buffers and images embedded, `glb.ts`), because a Rust game loads a model
from one file's bytes; `maps` adds loose maps beside it. A texture brings its maps (Poly Haven `diff`,
`nor_gl`, `arm`; ambientCG's zip members `Color`, `NormalGL`, `Roughness`, `AmbientOcclusion`,
`Metalness` under those role names) and an HDRI one `.hdr`. Resolutions are 1k, 2k and 4k.

The files go through `assets.deliver` into `assets/cc0/<job>/`, where the job id is a UUID made from
the source, id and resolution, so fetching the same asset again lands in the same folder. The plugin
keeps a delivery record per job (`jobs.write`: source, page, authors, and each file's path, sha256,
role and URL); `provenance.ts` `cc0LockFacts` turns it into `genex-assets.lock` facts with origin
`cc0`, licence CC0-1.0, the source, and a map's usage from its role (`PROVENANCE_ROLE_USAGE`).
A refusal is the fetch core's typed code (`host-not-allowed`, `hash-mismatch`, …) or `curated-held`,
in the error text as `cc0 <code>: <detail>`. Every request names `Genex-CC0/<version>` in its
User-Agent, as Poly Haven's API terms ask, and Poly Haven's live results carry
`credit: "Powered by Poly Haven"`, which the plugin's panel shows under its search results.
`source: "curated"` fetches a sha256-pinned pack from `curated.ts`; packs that cannot be fetched
under the rules yet are listed as held with a typed reason (`no-stable-host`: Quaternius's itch.io
links are signed per download; `zip-nested`: Kenney's kits nest their files in folders).

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
durable installation job; `runtime.install` and `runtime.cancelInstall` are user-action services.
An agent cannot choose a binary, download URL or installation action.

`nativeJobs` declares fixed argument arrays with package/input/output/value bindings, validated
value patterns, input/output names, deadline, byte limits and optional GPU access. `native.run`
stages only declared project input files; the child receives no full-project read grant.
`timeoutMs` is 1,000–300,000 milliseconds. `maxOutputBytes` retains the last 1–256,000 bytes
of each process log stream; it does not limit asset files. `maxAssetBytes` limits the combined
declared generated files to 1–104,857,600 bytes. Delivery additionally enforces `assetLimits`.
Set `gpu: true` for GPU rendering, including Blender EEVEE; it permits GPU services and the
runtime's own Metal cache. It grants no network or full-project access. Runtime detection runs
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
`native.jobs` / `native.result` read recorded jobs and never replay an interrupted operation.
The backend then calls `assets.deliver`, stores the reference and verifies actual preview use.
Raw host output roots and process logs should stay in the trusted setup UI, not agent results.
`assets.deliver` reuses the same project/plugin/job directory on retrieval. Existing regular
files must match the saved result byte-for-byte; changed files and symlinks fail without being
overwritten. Missing files can be restored, and only new bytes count against the remaining
project allowance. Retrieving a native result never reruns its generation recipe.

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
own when the login shell cannot answer; and the stacks union: an API 1–3 plugin still loads and
runs with no stack for a Rust game, a bundled tool sees `rust-wgpu` exactly when its manifest
declares API 4 (Local Blender's does; the example's API 2 tool gets no stack), and Local Blender
hands a Rust game its Rust card only. `plugin-local-install.test.ts` covers changed
local packages at reinstall, fresh scan/capability disclosure, cancellation, identity mismatch,
edits during approval, snapshot cleanup and disabled-state preservation. `plugins.test.ts` pins
API 1–4 compatibility (`apiVersion: 5` is rejected), canonical key order and unknown-key drop; `toolbar`, `network` and
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
`[role="dialog"][aria-label="Publish to the web"]` with `[data-genex-publish-status]` and no frame, the ticketed
`publish-draft` approval refused with `unsupported-in-fixture`, Publish staying with
`setEnabled('genex', false)` as Studio's own button whose dialog offers Turn on Genex plugin, and Genex's
own button returning with `restore('genex')`.

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
however shots interleave, and is stopped by the next publish; `genex__cover-set` waits for consent
and sends nothing without a hosted project; a bad project name reaches no host and writes nothing.
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
marketplace is constructed offline, the Marketplace shows only Coming soon, and the
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
