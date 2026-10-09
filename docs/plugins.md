# Studio plugins — API 3

The composer's Add panel lists installed plugins with the same global enable switches, plus
configured MCP connectors. Enabled and connected are separate states. Connect lists tools on
the registry's live connection (or opens setup when trust/secrets are missing); Manage opens the
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
- API 3 adds `native-runtime`, `nativeRuntimes`, `nativeJobs`, `assetLimits`, host-memory credential-session access, file skills and (bundled Genex only) `tools[].host`. Lower-version manifests cannot claim those declarations.
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
update, allow or approve plugins.

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

Bundled seeds are inspected for explicit versioned updates. Existing profiles keep their pinned
version until the user chooses Update; active leases defer activation, while disabling still
blocks calls immediately. A removed preference suppresses the seed across Studio upgrades.
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
| `capabilities` | 1 | Host services the backend may call: `settings`, `project.read`, `project.write`, `jobs` (also `events.emit`), `observe`, `credentials`, `external-auth`, `network`, (API 2) `export`, and (API 3) `native-runtime` |
| `tools[]` | 1 | `{name, description, parameters}`; scalar properties only; agent-invoked as `<id>__<name>` |
| `tools[].confirmation` | 2 | 1–300 characters. The tool needs the user's consent before it runs; see the consent model below |
| `tools[].host` | 3 | A program Studio runs for the tool instead of the backend; reserved for the bundled Genex plugin (see [First-party privileges](#first-party-privileges)) |
| `skills[]` | 1 | Guidance for agents while the plugin is enabled: inline `{name, text}`, or (API 3) a file skill `{name, summary, file, references?}`; see [Skills](#skills) |
| `panels[]` | 1 | `{id, title, file, placement: settings \| project}` isolated HTML panels |
| `settings[]` | 1 | `{key, label, type, default}` host-owned standard settings |
| `actions[]` | 1 | `{name, label, confirmation?}` UI-invoked backend actions; never agent tools. Sensitive names (`unlock`, `connect`, `disconnect`, `approve`, `allowance`, `enable-paid`, `publish-draft`, `publish-gallery`) must carry a `confirmation` |
| `network` | 2 | `{hosts: string[]}` (at most 32 hostnames): the hosts the backend talks to, disclosed at install and checked by the static scan |
| `toolbar[]` | 2 | Up to 4 buttons in the stage strip; see below |
| `mcpServers[]` | 2 | Up to 4 MCP servers the plugin ships, run by the host as connectors the plugin owns; see below |
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
Each builder brief is built from one registry `snapshot()`, so its tools and skill lines agree. The
plugins and skills a session was handed ride its `tool_registry_applied` event; a resumed session
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
  `icon` at most 4 characters.
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
debounced to once per second, and every 30 s while a project is open. It returns a
`PluginToolbarStatus` — `{badge?, disabled?, title?, tone?: ok | warn | err | info, attention?}` —
sanitized by `toolbarStatusFrom` (badge ≤ 16 characters, title ≤ 120, unknown tones dropped,
`attention` a boolean). A button is drawn in the prompt bar's quiet pill fill, or in the accent while
its status sets `attention` (the action is due) and the game is not empty; Genex's Publish uses
only `title` and `attention`. A backend can also push a status without being asked through
`events.emit` with `{kind: "toolbar", item, badge, tone, title, attention}`; the renderer applies it
to that item, or re-asks the status action when the item is not named.

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
connector at 64 tools regardless. `callTimeoutMs` is 1 000–1 800 000. Unknown keys are dropped and
the section is canonicalised in a fixed key order like the rest of the manifest.

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
before the event is written. The chat folds the pair by `callId` into one `TOOL` line naming the
plugin, and the Builds graph draws one asset job per call (asked for → making → delivered or
failed), joined to the `asset_delivered` record on `jobId`. Both are host-owned: a plugin cannot
forge them, and cannot suppress them by staying quiet.

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
- Timing: a question nobody answers is declined after nine minutes — deliberately under the Codex
  bridge's ten-minute tool ceiling, so the engine hears "declined" instead of a dead tool call.
  Stop, a harness that died and the end of the turn withdraw the questions in their scope first.
  A run's session declined once is not asked again until the run is resumed; a build's lead, the
  chat's main agent, is asked each time. It is not the chat's turn either: its questions and
  connector calls outlive the chat's other turns and end with its own session instead. Its tools are bound to the worktree it leads, so
  what they deliver lands with the build ([tool permissions](tool-permissions.md)).

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
- `credentials.read/write/clear`: plugin-scoped protected storage. Reserved account actions
  `unlock`, `connect`, `disconnect` authorize these operations; agents cannot invoke actions.
  Cache unlocked credentials only in the backend session. Background status must never unlock.

The host never retries a failed tool invocation. Persist remote references before returning and
reconcile uncertain submissions instead of creating again. Cancellation stops local waiting;
it does not promise remote cancellation or refunds. Genex keeps its CLI admission ledger as the
single billing authority. Plugin process failures are shown in Plugins and reported as a
`failed` change.

## Panels and trusted approval

Panels register `settings` or `project` placements. They are opaque-origin sandboxed frames
served over `studio-plugin:` with scripts enabled but no Node, Studio preload or direct IPC.
CSP refuses network, forms, external scripts and external images. Inline prebuilt JS/CSS and
image data URLs are supported. Use `src/plugin-sdk/panel.js` for request/response handling. The
same host (`PluginPanelHost`) serves a panel opened from the Plugins page and one opened from a
toolbar button.

`studioPlugin.call('context')` returns the selected project, host API version (`3`) and theme tokens;
`call('settings')` reads standard settings; `call('action', name, args)` invokes a declared action.
The parent validates source frame, opaque origin and request shape, and binds plugin/project
itself. Closing the panel removes the listener; the SDK bounds waiting promises.

Actions declaring `confirmation` open Studio-owned review UI followed by native confirmation,
which lists the action's arguments under its question (nothing when there are none).
Optional backend `review` returns a message and labeled image data URLs. Studio requires all
images to load before continuing. Approval tickets are short-lived, single-use and bound to
plugin/action/arguments/project. A panel never supplies its own approval ticket. Genex uses this
for candidate/remesh review, allowance changes and credential operations. Account connection
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
reported as `bundled — not scanned`.

The trust dialog is one function for every way a plugin can arrive, and says: *"{name} {version}
from {GitHub owner/repo@sha (cataloged, not audited) | a curated release | local folder | bundled}
runs as trusted native code in a crash-isolated child process — not an OS sandbox. Publisher: …
Capabilities: … (new: …). Scan: …"*.

## Hot reload and debug logs

**Watch folder** in a local plugin's detail-page More menu starts a recursive watcher on the folder it was loaded
from, debounced at 500 ms, and re-installs through the normal lease path — so a reload waits for
any session holding the plugin and lands as `reloaded` when it is free. Each reload scans the
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
  review, ticket and native confirmation.
- That dialog also reads the cover record publish-status answers (`GenexPublishState.cover`, typed
  in `shared/genex.ts` with the plugin's outcome kinds as `GenexCoverOutcome`). While it reports no
  kept shot and no send running, the owner chose no cover on genex.games (`kept_owner`, which the
  plugin records whenever Genex reports the owner's pick, at a send or a status check, a shot kept
  or not; `outranked`) and no publish runs, one quiet line offers Ask for a cover (`[data-genex-cover-ask]`,
  `coverAsk` in `genex-publish-view.ts`): it closes the dialog and leaves "Make this game's Genex
  cover." in that game's chat composer (`renderer/compose-in-chat.ts`), never sent. A Genex plugin
  older than covers answers no record, and the line stays hidden. Genex-specific core UI, accepted
  by the owner; a second plugin with a cover would need a declared host surface instead.
- `~/.genex` is on the protected and secret path lists every sandboxed engine and native job is
  denied, and the workspace content filters skip `.genex` folders.
- Core reads Genex job folders under `engine-homes/genex/projects/*/jobs` for the Assets inventory
  and provenance, resolves `@genex/` retained-asset references, and serves one saved inspection
  frame through the `genex-inspection` scope of `readProjectAsset`.
- A game using `@genex-ai/embed-sdk` is previewed with `?genex_local_test=1`.
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
  command sees only `{id, slug}` from the publish workspace. On Windows, an offline native
  job keeps the run folder private while the harness is active; the host relays pinned-origin
  HTTP through anonymous pipes ([Windows sandbox](windows-sandbox.md)). `genex-package` backs
  `genex__package`: it adds `@genex-ai/multiplayer` or `@genex-ai/embed-sdk` at the exact pin in
  `GENEX_GAME_PACKAGES` (`shared/genex.ts`) with the game's package manager, only in the bound
  game or a git worktree of it under Studio's scratch (by realpath), never in a template game
  with no `package.json`. The paid tool and the package tool need consent; fixture profiles refuse
  both host steps (`studio:plugins.host-cli`, `studio:plugins.host-package`).
- Genex's guide and seven platform cards are vendored behind Studio-written prefaces in
  `src/plugins/genex/skills` (`vendor.json` pins each source and hash; `npm run genex:skills`
  refreshes them; `genex-skills-vendor.test.ts` catches drift) and served as file skills.
- Its backend and adapter import core substrate modules (session credentials, secrets, delivery,
  outcomes, atomic writes, snapshots), which `scripts/build-plugins.mjs` bundles from this repo.

Local Blender:

- Its enabled state is seeded from the core `settings.blender` value.
- Core reads its `plugins/data/blender/native-jobs` records for the Assets inventory.

Both: their ids are bundled seeds, so no GitHub, index or local package may take them over, the
scaffold refuses them (with `example` and `studio`), and the app's catalog policy reserves them as
official ids.

## Deferred work

- Agent behavior extension points: orchestration, judges and learning hooks. These need a
  separate authority/evaluation design; API 3 still registers none of them.
- Studio-owned asset canvas: implemented as the Assets stage tab over plugin-neutral metadata
  (the host ledger, read-only plugin job records and the game's own assets folders). Interactive
  3D viewing and model/audio thumbnails remain deferred.
- Strong OS sandboxing for arbitrary backend publishers is not claimed by this trusted-code host.

## API 3 managed-native services

Local Blender (`src/plugins/blender`) is the public SDK example for installed native software.
Core owns only generic runtime discovery, pinned installation, process execution, cancellation,
project-bound inputs and asset delivery. Blender-specific bpy wrapping, model export and renders
live inside its plugin. No private core Blender hook is part of an agent's tool list.

A manifest declares fixed `nativeRuntimes` candidates and version probes. Optional `platforms`
variants select candidates and installation metadata by exact `platform` (`darwin`, `win32`,
`linux`) and `arch` (`x64`, `arm64`); an unmatched variant is unsupported, with no fallback to
another platform's executable. Legacy runtimes keep their original candidates and installer.
An optional installer
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
On macOS, `gpu: true` permits GPU services and the runtime's own Metal cache. Windows managed
jobs retain their restricted token; Local Blender uses CPU Cycles for its two thumbnails.
Neither grants network or full-project access. Runtime detection runs
the declared version probe, but never starts a generation recipe or installs software.
Managed jobs deny network and protected host state, and retain a durable job ID before process
launch. Windows uses a distinct temporary Less Privileged AppContainer (LPAC) SID per job, with
only registry-read capability and grants to the runtime, staged inputs, declared output roots
and scratch folder. Overlapping jobs do not share file grants. A kill-on-close Job Object stops
all descendants on exit, timeout or cancel; the trusted broker removes its grants and profile
before returning. Flushed host-owned recovery records precede each ACL change; after a broker
crash, a fresh broker restores only that job's SID grants and original integrity labels. A failed
recovery retains those records and reports their location. A failed sandbox launch never falls
back to an unrestricted process. An
externally installed runtime whose ACL the current user cannot grant may be unusable; the
managed per-user ZIP installation avoids that requirement. This path needs the built-in Windows
PowerShell and .NET runtime. On macOS, the profile (`nativeSandboxProfile`) names what a job may do: start
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
probed after the image is detached. Windows pins use `format: "zip"`: the host streams a bounded,
verified archive into private staging, refuses absolute/traversal paths, duplicates, links and
special files, and probes the extracted executable before committing the installation.
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
question as a stop. `genex-plumbing.test.ts` pins the runtime across every agent path
(claude-code, codex and the local harness registry): a pending `plugin_consent` card appears, the
declaration handed to the engine carries `confirmation`, a decline reaches the agent as
`{consent: 'declined', by: 'user'}`, an approval reaches the backend, `genex__publish-status`
asks nothing, `core.api()` exposes no consent method, and the question is withdrawn by the
timeout, by Stop and by the end of a turn.

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
