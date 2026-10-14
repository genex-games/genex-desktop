# Writing a Studio plugin

This is the working guide for a person — or a coding agent — building a plugin. It is a
walkthrough plus the checks to run. The normative reference is [docs/plugins.md](plugins.md);
where the two disagree, that document wins. An agent in a Genex chat gets the short form as Genex
Tools' `plugin-author` skill: it writes the plugin into `genex-plugins/<id>/` in the game, checks it
with `plugin_check`, and leaves loading and turning it on to you.

A plugin is a **prebuilt directory**. Studio installs the files as they are: no `npm install`, no
build hook, no archive extraction. Build your JavaScript before you hand the folder over.

A backend is **trusted native code** in a crash-isolated child process, not an OS sandbox. That is
what the install dialog tells the user, and it is why installing is a decision a person makes.

## 1. Scaffold

```
npm run plugin:new -- my-plugin --out ~/studio-plugins
```

The scaffold is a copy of `src/plugins/example` with your id, display name and tool names
substituted in. Ids are lowercase letters, digits and dashes, starting with a letter, at most 48
characters; `genex`, `blender`, `example` and `studio` are reserved, and an existing directory is refused.
The scaffold includes the runnable package and a local typed authoring kit:

```
my-plugin/
  plugin.json    the manifest: identity, capabilities, tools, actions, panels, settings, toolbar
  backend.mjs    the module that exports activate()
  panel.html     an isolated UI panel with the current panel bridge inlined (optional; delete it
                 and its manifest entry if unused)
  AGENTS.md      notes for your coding agent: the rules that fail validation, and the commands
  jsconfig.json  editor/typecheck settings for the backend
  plugin-sdk/    self-contained index.d.ts
```

`AGENTS.md`, `jsconfig.json` and `plugin-sdk/` are for authoring: packing, installing and the scan
leave them out, as they do every dotfile and dot-folder.

The package needs nothing from Studio's tree. The `plugin:*` commands themselves run from a Studio
checkout on Node 24, because they use the real validator, scanner and probe; a separately
published dev kit does not exist yet. `jsconfig.json` has no Node types: before a type-checked
backend imports `node:` modules, add `@types/node` to the plugin folder and `"types": ["node"]`.

## 2. The contract

`backend.mjs` exports one function. Type it against `src/plugin-sdk/index.d.ts` — self-contained
(it imports nothing from Studio) and shipped beside the SDK bootstrap, at
`resources/plugin-sdk/index.d.ts` in an installed Studio. The scaffold already copies it locally and annotates the backend, so your editor and coding
agent can check the API without Studio source imports. Existing packages can copy it beside
their backend:

```js
/** @type {import('./plugin-sdk/index.d.ts').Activate} */
export async function activate(host) {
  return {
    async tool(name, args, ctx) { /* agent-invoked */ },
    async action(name, args, ctx) { /* user-invoked, from a panel, the dialog or the toolbar */ },
    async review(name, args, ctx) { /* optional evidence before a confirmed action */ },
  };
}
```

- **Activation must be side-effect-free and must not call the host.** Installation probes load the
  backend with no account and no project authority; `plugin:doctor` reproduces that exactly.
- `tool` is what an agent can call, named `<plugin>__<tool>` in every engine. Parameters are
  declared scalars (string, number, boolean) or structured objects. A declared object may
  opt into `acceptJsonString` for legacy bridge input; the host normalizes it before dispatch.
- A tool only Genex's own harness loop calls, never an agent, declares `"audience": "harness"`
  (API 3): no chat, builder or plan is handed it or told of it, and the harness still calls it
  by name as its own step, through the same consent; an agent naming it is refused and nothing
  runs. Studio records no call pair for it: it is a step of the harness's loop, and it runs in Plan
  mode unless the harness marks it a write (`checkpoint: true`: a save, a shot, a play or an editor change). `"agents"` is the default; any other value is refused.
- `action` is never an agent tool. It is what a button or a panel invokes.
- `ctx` carries `project`, `directory`, `threadId`, an `AbortSignal`, a `callId` and `host`, and
  the bound game's `stack` when the host knows it (see [Games of three stacks](#games-of-three-stacks)).
  **Do not store it**: concurrent calls can belong to different games and different workers, and
  host services answer only during an active invocation.
- The host never retries a failed invocation. Persist a remote reference before you return, and
  reconcile an uncertain submission instead of creating it again. Cancellation stops local
  waiting; it promises nothing about remote work or refunds.

### Your plugin's picture

Give the plugin an icon the way an app has one in the Dock: add `"icon": "icon.png"` to
`plugin.json` and put the file in the package. Use a square PNG (512 × 512 is plenty), JPEG,
WebP or SVG, at most 512 KiB, full-bleed: Studio rounds the corners itself, so leave out your
own rounded corners, padding and shadow. Studio shows it on the plugin's row, its page and the
composer's Add menu, and refuses a package whose icon is missing or is not the picture its
extension says. Without an icon Studio shows your plugin's initial. An MCP server you ship names
and pictures itself through its own `serverInfo.title` and `serverInfo.icons` when it connects;
until then, and when it sends none, it wears your plugin's icon.

### Showing what a tool makes

A tool that makes an asset can say so (API 3), and while a call runs Genex shows it as a card of
that kind on the Assets canvas and in the chat, where its files will land, with your plugin's icon:

```json
{ "name": "paint", "description": "…", "parameters": { … }, "asset": { "kind": "image", "prompt": "prompt", "tool": "Pixel Lab" } }
```

`kind` is one of `character`, `creature`, `model`, `rigged-model`, `animation`, `image`,
`texture`, `video`, `sound-effect`, `music`, `voice`; `prompt` names the parameter that says what
to make; `tool` names the service doing the work. See
[Assets being made](plugins.md#assets-being-made).

### Host services

Each is capability-gated and scoped to your plugin. `ctx.host('<method>', args)` is typed, so an
undeclared method is a compile error.

| Method | Capability | What it does |
| --- | --- | --- |
| `settings.read` | `settings` | Declared defaults plus the host-owned values a user edited |
| `storage.root` | none | Your durable folder, outside games and exports |
| `project.read` | `project.read` | A relative file in the bound worktree, utf8. Dot paths, `node_modules`, `AGENTS.md` and `CLAUDE.md` are refused |
| `project.write` | `project.write` | Writes a relative file; the parent must exist, symlink targets are refused |
| `assets.deliver` | `project.write` | Copies your output into a unique asset directory in the game; delivered files reach the host ledger |
| `jobs.read` / `jobs.write` | `jobs` | Durable provider references. Not a credit ledger |
| `events.emit` | `jobs` | Sanitized progress, attributed to the bound project/thread. `{kind:'toolbar', …}` updates a toolbar badge |
| `observe` | `observe` | Loading/capture/audio evidence for authorized files in the bound worktree. API 3: with `still: { demo \| camera, width, height, maxBytes? }` and `files: []`, one named view on a hidden window at that size, as a PNG (or JPEG past `maxBytes`) with exposure numbers, or a `stillProblem` code; an older host ignores `still` and answers a plain observation (`PluginStillIgnored`), so check for each |
| `export.stage` | `export` | Studio writes the public export of the bound game under `storage.root/publish/<project>/dist` and returns the result |
| `credentials.session` | `credentials`, API 3 | Reuse an explicitly unlocked host-memory lease; never opens the OS store |
| `runtime.detect` / `runtime.installation` | `native-runtime`, API 3 | Read declared native runtime readiness and durable installation progress |
| `runtime.install` / `runtime.cancelInstall` | `native-runtime`, API 3 | Fixed pinned installation through a real declared user action; installation requires its confirmation |
| `native.run` / `native.jobs` / `native.result` | `native-runtime`, API 3 | Project-bound fixed job recipes, cancellation and durable results; no automatic replay |
| `game.engine.link` / `game.engine.read` | `game-engine` | Link the bound game to an Unreal project file (checked by real path; the chat shows it with Undo), or read its link. The host keeps it in `storage.root/links/<game>.json`; a call to your MCP server never links a game |
| `game.engine.steps` | `game-engine` | Show your steps card (your `steps` action's answer, read live) in the calling chat |
| `game.snapshot` | `game-engine` | `{reason}` → `{snapshotId}`: a game snapshot of the bound game, listed in Rewind under `reason` (one plain line, at most 200 characters), before you change files there |
| `game.engine.runs` | `game-engine` | `{game, title, project}[]`: the games whose run (a Loop) is going now that your plugin linked to a project, with that project file; needs no bound game. Read it before you offer to quit an editor a run may be using |
| `game.create` | `game-engine` | `{title}` → `{project, directory}`: a new Genex game (title one plain line, at most 80 characters) for an engine project made with no game open; link it with `game.engine.link {project, game}`, which accepts only a game your plugin made, from outside any game |
| `credentials.read` / `write` / `clear` | `credentials` | Plugin-scoped protected storage; only the reserved `unlock` / `connect` / `disconnect` actions authorize these |

Declare `network` if the backend talks to a host, and list the hosts in `network.hosts`. That is
disclosure for the install-time scan; a plugin that reaches the network without declaring it reads
`dangerous` in the trust dialog.

### Skills

A skill tells agents how to use your tools. Studio adds it to builder briefs while your plugin is
enabled and drops it the moment it is not; nothing is written into the game. Keep a short rule
inline and put a long guide in a file:

```json
"apiVersion": 3,
"skills": [
  { "name": "basics", "text": "Use my-plugin__make for props. Never repeat a declined request." },
  {
    "name": "level-kit",
    "summary": "How to lay out a level with the kit's tiles. Read before building a level.",
    "file": "skills/level-kit/SKILL.md",
    "references": ["skills/level-kit/references/tiles.md"]
  }
]
```

- An inline skill's whole `text` goes into every brief. Any API version.
- A **file skill** (API 3) puts only its `summary` in the brief, with the call that reads it:
  `[my-plugin/level-kit] <summary> Read it with my-plugin__skill {"name":"level-kit"} before that
  work.` Write the summary so an agent knows *when* to read the file. Studio adds the
  `my-plugin__skill` tool itself and answers it from your package, never through your backend, so
  do not declare a tool named `skill`.
- The file and each reference are `.md` paths inside the package: no `..`, no absolute path, no
  dot file or dot folder (packing leaves those out), no link. The agent passes a reference as
  `file` exactly as you listed it; long files come back in pages it continues with `offset`.
- Caps: 32 skills with unique names, inline text up to 16,000 characters, a summary up to 300,
  16 references per skill, 128 KiB per file and 1 MiB of skill files in all. `plugin:doctor`
  checks them with the real validator. API 1 and 2 manifests keep their old leniency: a repeated
  skill name is dropped, empty text is allowed and other skill keys are ignored.
- A skill may name the game stacks it serves with `stacks`; `rust-wgpu` needs `apiVersion: 4`.
  The rules are in [plugins.md](plugins.md#skills).
- A skill for one kind of project names its facts (API 3): `"facts": ["toy-project"]` keeps it out
  of every other game's brief, and `"tools": ["build"]` keeps it only while one of your tools it
  explains reaches the session. A tool may name `facts` the same way, and so may an MCP server
  (never started for another game); a tool that makes a project of your kind says
  `"makes": ["toy-project"]`: it is refused while a run of the game is going, Genex snapshots the
  game before it runs, records the web game it replaced as the game's `portedFrom`, and tells the
  session to end its reply, which then goes on with your tools. A game with no kind yet is served as
  a web game (`web-game`); a folder of a kind Genex can't name is served by no fact. The
  older `"engines": ["web"]` / `["unreal"]` still works and reads as `web-game` / `unreal-project`;
  anything that names neither reaches every game.
- The trust dialog lists your skills, and an update marks each new or changed one and names each
  removed one. A hot reload that edits a skill reports the change on the plugin's page instead of
  applying it silently.

### Games of three stacks

A game is one of three stacks: `three-js` (a browser game on Three.js), `raylib-cpp` (a C++ ·
raylib game) or `rust-wgpu` (a Rust game on the genex facade, built for desktop, phones and the
web). `ctx.stack` names it on a call bound to a game, so a backend can deliver formats that stack
loads; a skill's `stacks` keeps guidance from games it does not fit.

- `rust-wgpu` exists from `apiVersion: 4`. API 4 changes nothing else, so moving a plugin up is
  one line. The scaffold still declares API 2, and the catalog accepts API 1–3 for now: a plugin
  you submit there stays on API 3 or earlier until the catalog check learns API 4.
- A plugin on API 1–3 keeps working for every game. Bound to a Rust game, its backend gets no
  `stack` at all, never a value its SDK does not name; and a skill listing both `three-js` and
  `raylib-cpp` still reaches Rust games, because on those APIs that list meant every game.
- When your guidance differs per stack, write one skill per stack, as Local Blender does: its
  `local-modeling` card (Three.js and C++ · raylib) loads the model with `GLTFLoader`, and
  `local-modeling-rust` loads it with `gfx.assets().model`.

### Knowing your kind of project

A plugin for an engine says how to recognise its projects (API 3), so Genex can tell what a folder
holds: `"detect": [{ "fact": "toy-project", "files": ["**/*.toyproj"], "notUnder": ["**/vendor/"] }]`.
While the plugin is on, a game whose files match holds the fact `toy-project` at the folder of the
match (`.` for the game's root); a match inside a `notUnder` folder, or below a folder that already
has the fact, counts for nothing. A glob is plain characters, `*` within one folder name and an
optional leading `**/` for any depth; a `notUnder` glob ends with `/`. At most 8 rules, each with
1–8 `files` and up to 8 `notUnder`; a fact id is lowercase letters, digits and dashes. Genex knows
web, Unreal, Godot, Unity and Blender folders itself ([Project facts](plugins.md#project-facts)).

What your engine generates while it runs stays out of the game's history when you say so:
`"workspace": { "ignore": ["Cache/"], "copySkip": ["Cache/"] }` puts `/Cache/` (or `sub/Cache/` for
a project in `sub`) in the game's `.gitignore` before its first commit and every snapshot after; `copySkip` names what
workers' copies leave out besides, of the files they receive outside history (tracked files are always copied). `"assets": { "folders": ["scenes"], "formats": ["toyscene"] }`
adds your project's `scenes/*.toyscene` files to the Assets tab (formats Genex can't show appear by name). Both reach the facts your `detect` declares, or those their
own `facts` list names; patterns use the same globs, at most 16 per list, never only `*` and never
Genex's own files (`studio.json`, `.gitignore`, `.git`, `.studio`, `references`). See
[Workspace rules](plugins.md#workspace-rules).

The kinds of worker a lead may start with your tools are yours to declare:
`"workerTypes": [{ "id": "scene", "description": "Edits one scene", "tools": ["build"], "isolation": "copy" }]`.
`tools` names your own agent tools, or another plugin's by prefix (`"blender__"`) or agent name
(`"genex__asset"`); `isolation` is `read` (in place, writes nothing), `copy` (its own copy, handed
back for the lead to merge) or `lock` (in place, one at a time per game). A kind is offered only
while one of its tools reaches the game. Folders outside the game your engine's programs write to
go in `"folders": [{ "path": "~/Library/Application Support/ToyEngine", "why": "The toy engine's settings" }]`:
turning your plugin on approves them as workers' write roots. A folder is one folder from `~/` or
`/`, never a glob, a whole personal folder (`~/Documents`, `~/Library`, …), a login or Genex's own
data. See [Worker types](plugins.md#worker-types) and [Folders](plugins.md#folders). Your plugin's
page and its suggestion card in the chat name these folders before anyone turns it on.

An editor one holder at a time may use is a lock:
`"locks": [{ "id": "toy-editor", "label": "Toy editor", "per": "project", "personFirst": "editor-state" }]`,
and a tool or connector that uses it says `"needs": ["toy-editor"]`. `personFirst` names one of
your harness tools answering `{ "personActive": false, "unsaved": 0 }`: while the person uses the
editor, the agents' work in it waits. Hooks run your harness tools at Genex's moments, such as
`"hooks": [{ "on": "checkpoint.before", "tool": "save-scenes" }]`; your handler reads
`context.hook` (`{ on, runId?, worker?, … }`, absent when called directly) and answers `{ block?,
note?, pending?, images? }`. A handler that throws blocks a moment that can be blocked, so answer
`note` for trouble that should not stop the work. It never changes another call's arguments, and
git stays Genex's. An agent tool that `makes` a kind
may name a harness tool in `ready` that answers `{ ready, note }`. See
[Hooks](plugins.md#hooks-genexs-moments) and [Locks](plugins.md#locks-the-person-comes-first).

A plugin whose tools make more than one kind of project names each with a label:
`"scaffolds": [{ "id": "plugin", "label": "Toy plugin", "tool": "new-toy-plugin", "facts": [{ "fact": "toy-plugin", "files": ["**/*.toyplug"] }] }]`.
Each scaffold whose `tool` (an agent tool that `makes` a kind) reaches a game is a kind of its own
on the first message's question, named by its label; `"game": false` keeps one that makes no game
(a plugin or tool project) off that question, made only when the request asks for it. Once that tool made its kind, Genex records
the scaffold in the game's `studio.json`, and its `facts` rules (at most 4, each of a fact the tool
makes) keep finding facts your `detect` skips, even while your plugin is off. See
[Scaffolds](plugins.md#scaffolds).

An observer is what Genex can capture of a project of your kind, for the reviewer who checks a
Loop's finish: `"observers": [{ "id": "viewport", "facts": ["toy-project"], "tool": "capture" }]`
names one of your harness tools that asks nothing and answers pictures. Add `"live": "stills"` to
have Live show its latest pictures for such a project (`unreal-card` is the bundled Unreal
plugin's own view; `preview` and `proof` are Genex's ids). Add `"label": "Board"` to name that
view's tab when a folder has more than one view (1–24 characters, not a name the stage strip
already shows); without it the tab takes your plugin's name. Your observer captures only while your
plugin is on, inside a run: the tool is called with `context.observe` set (`{observer, runId, why}`)
under its `needs` locks, and answers `{ images, recording?, note? }`, where `recording` is a short
play recording as at most 8 frames in order; a `block` or `pending` answer is reported as why
nothing was captured. See [Observers](plugins.md#observers).

Together these give your kind of project a Loop with no code in Genex. While your plugin is on, a
Loop on a folder your `detect` recognises is led in place by the chat's own session: your hooks run
at its start, its save points, rewinds, restarts, health checks and its end, its lead starts your
worker types, and your observers feed the reviewer who checks its finish. The toy engine plugin in
Genex's tests (`tests/fixtures/toy-engine-plugin/`) runs such a Loop, and so does a copy of it with
every tool renamed. See [the open Loop](harness-runtime.md).

## 3. Panels

A panel is served into an opaque-origin sandboxed frame with
`default-src 'none'; script-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'`. There is no
`window.studio`, no `require`, no `process` and no direct IPC.

- Inline your JavaScript and CSS. `<script src="…">` **will not load**. Put
  `<!-- STUDIO_PANEL_SDK -->` where the bridge goes and run
  `node src/plugin-sdk/inline-panel-sdk.mjs panel.html` (the scaffold already did): it pastes the
  current `panel.js` and `ui.js` in, so the bridge matches `index.d.ts`.
- No `fetch`, no forms, no external images, no external fonts. Images and fonts must be `data:` URLs
  (`inlinePanelFonts` in the same script pastes Genex's own type in at `<!-- STUDIO_PANEL_FONTS -->`), and
  `project.read` is utf8-only, so a panel cannot display a PNG read from the game folder.
- The whole bridge is `window.studioPlugin`: `call(method, name?, args?)` with
  `call('context')` → `{project, apiVersion, theme}` (`theme` carries `background`, `foreground`,
  `accent` and the readable button colours `accentFill`, `accentForeground`, `accentHover`),
  `call('settings')` → your standard settings
  and `call('action', name, args)` → a declared action, plus
  `chooseFile({ title, extensions })` → the chosen file's real path or `null` (1–4 extensions, each
  `[a-z0-9]{1,10}`; native, so a fixture profile answers `unsupported-in-fixture`; see
  [Panels](plugins.md#panels-and-trusted-approval)). Nothing else crosses. A call the person
  cancelled in Studio's confirmation rejects with `code: "cancelled"`; stay quiet then.

`plugin:doctor` warns about both of these mistakes, naming the file.

## 4. Consent and confirmation

Two different things, both asked by the host and never by the plugin or the agent:

- **`tools[].confirmation`** (API 2) — an agent-invoked tool that spends, publishes or acts beyond
  the game folder. Studio asks the user before the backend sees the call. With no way to ask, the
  call fails closed. A declined or expired request reaches the agent as text
  (`{consent:'declined', by, message}`), never as an error — say in your skill text that a declined
  request must not be repeated.
- **`actions[].confirmation`** — a user-invoked action behind a Studio-owned review and a native
  dialog. Your optional `review` returns `{message, detail, images:[{label, dataUrl}]}`: `message`
  (at most 2,000 characters) is the dialog's question instead of the manifest's `confirmation`, and
  `detail` (plain text, at most 4,000 characters, used only with a `message`) appears under it. With
  a `message` the dialog's buttons are Cancel and the action's label, otherwise Cancel and Approve
  over the arguments. Studio requires
  every image to load before it will continue. Approval tickets are short-lived, single-use and
  bound to plugin/action/arguments/project; a panel can never supply its own.

The sensitive action names `unlock`, `connect`, `disconnect`, `approve`, `allowance`,
`enable-paid`, `publish-draft` and `publish-gallery` **must** carry a confirmation; the validator
refuses a manifest where they do not.

## 5. Toolbar buttons

Up to four per plugin, rendered beside Live/Builds:

```json
"toolbar": [{
  "id": "demo",
  "label": "My plugin",
  "ariaLabel": "My plugin demo",
  "icon": "★",
  "requiresProject": false,
  "target": { "kind": "panel", "id": "demo" },
  "status": "count"
}]
```

`status` names a declared action **without** confirmation that returns
`{badge?, disabled?, title?, tone?: ok|warn|err|info, attention?, dot?}`; `attention: true` draws the
button in the accent (its action is due), otherwise it wears the quiet pill. `dot: true` draws the
badge as a dot in its tone and moves its word into the tooltip, above the title. Studio calls it on
mount, on every plugin change and every 30 s while a game is open; a backend can also push one with
`events.emit({kind:'toolbar', item:'demo', badge:'Draft'})`.

### Reserved labels and uniqueness

- `label` is 1–24 characters and may not be, case-insensitively, one of Studio's own stage-strip
  labels: **Retry, Ready, Live, Builds, Assets, Export, Plugins, Reload, State, Close plugins**.
- `ariaLabel` is 1–60 characters, unique inside your manifest and also not reserved. Studio's
  automation resolves a control by label and **refuses an ambiguous selector**, so two controls
  that share a label are two controls nobody can press. Name yours after your plugin.
- `id` is unique within the plugin; a panel target must name a declared panel and an action target
  a declared action (scalar args, at most 16 keys).

## 6. Shipping an MCP server

A plugin can hand Studio an MCP server to run. It becomes a **connector the plugin owns**: published
when the plugin is enabled, withdrawn the moment it is disabled, updated or removed, and trusted by
the install dialog the user already answered rather than by the connector trust dialog a typed-in
connector needs. Its tools reach Claude Code, Codex and the local harness as
`<pluginId>-<serverId>__<tool>`, on the same channel your own tools ride.

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
  "description": "What this server is for, and what a user has to set up before it works."
}]
```

What Studio will and will not do with it:

- **`command`** is `node`, and `args[0]` is a script **inside your package** — Studio starts it as
  `process.execPath` with `ELECTRON_RUN_AS_NODE=1`, because a packaged app has no `node` on its
  PATH. (`host-cli` runs a program Studio itself ships and is reserved for the bundled Genex
  plugin.)
- **`cwd`** is `storage` or `storage:project`, both inside your plugin's own storage — never the
  package, which is replaced on update and deleted on remove. `HOME` is set to a folder inside that
  directory, so a server that reads dotfiles on startup cannot reach the user's.
- **`env`** names *sources*, never values: `setting:<key>` (a declared setting), `literal:<value>`,
  or `credential-file` — which sets the variable to `/dev/fd/3` and sends your plugin's one
  credential, the bare token with no `NAME=` framing and no newline, down an anonymous pipe on
  **file descriptor 3**. Read it once at start-up with
  `readFileSync(process.env.SCENES_CREDENTIAL_FILE, 'utf8')`; empty means the account is locked. A
  token never travels in the environment, where every child and `ps` can read it. (`secret:<NAME>` is accepted too, but no UI
  in this version stores a secret for a plugin's server, so it resolves to nothing — use
  `setting:<key>` for anything the user types.) Beyond `PATH`, `HOME`, `TMPDIR` and `LANG`, nothing
  of Studio's environment is inherited — except that a server without the credential pipe is
  spawned by the MCP SDK's own transport, which adds `LOGNAME`, `SHELL`, `TERM` and `USER`.
- **`requires`** is what must be true before the server is started at all. `credential: true` means
  the server waits until the user has explicitly run your `unlock` action; until then it is listed,
  switched off, with the reason on it. `settings` names settings that must be filled in.
- **`toolPolicy`** and **`maxTools`** keep an enthusiastic server out of every prompt's tool list;
  Studio caps a connector at 64 tools regardless. **`reads`** (API 3) names the tools that only
  read (list or describe what the server offers): they run with no card in any mode. `callTimeoutMs` is at most 1 800 000 (30 minutes).
- At most **4 servers**, ids lowercase with no `_` (the `__` in a tool name must stay unambiguous),
  and the whole section needs `apiVersion: 2`.
- Changing what a server runs, where it runs or what it is handed is a **permission expansion**:
  the update asks the user again, exactly as a new capability does, and the dialog marks each
  server `(new)` or `(changed)`. Reinstalling a plugin the user removed is an install, not an
  update, so it is not refused.

Your server is trusted native code in a child process, not a sandbox. Declare the narrowest thing
that does the job, say in `description` what a user must set up, and let a call fail with a message
rather than starting a server that can only answer "not configured".

An MCP server's tool says what it makes in its own `tools/list` entry, so this works for any
server, yours or one a person added: `"_meta": { "genex/asset": { "kind": "image", "prompt": "text" } }`.

## 7. Check it

```
npm run plugin:doctor -- ~/studio-plugins/my-plugin        # human report
npm run plugin:doctor -- ~/studio-plugins/my-plugin --json  # machine report
```

The doctor runs the same checks Studio runs, exits 1 on an error, and reports scan findings
and panel CSP problems as warnings:

1. `inspectPackage` — the real manifest validator, plus the no-links/no-special-files rule.
2. `scanPackage` — the install-time static scan, so you see the verdict a user will see.
3. A real ping probe of `backend.mjs` in the SDK bootstrap, with every host service throwing.
   Backend stderr is echoed: that is where an import-time failure explains itself.
4. Toolbar reserved labels and aria-label uniqueness.
5. Panel CSP.
6. `mcpServers`: every `node` server's script is really a file inside the package, and each
   declared server is listed with the environment sources it asked for.

## 8. Load it, then edit with hot reload

In Studio: **Plugins → Add → Load local plugin…**, choose the folder, read the trust dialog (it names the
publisher, the capabilities and the scan verdict), and install. A plugin loaded from a folder starts
off: turn it on on its page; each of its tools then asks you before an agent runs it until you answer
Always allow for it, and new code asks again; its own steps at Genex's moments (hooks, observers,
person-first probes, readiness checks) run without asking. Then choose **Watch folder** in
the plugin's page's More (…) menu: every save re-installs the package (its new backend starts at once
to prove it loads), and the new version takes the old one's place as soon as no session is holding
the plugin. Hot reload is best-effort — recursive file watching coalesces
events on macOS — so if a change does not appear, press Reinstall. A reload that changes
`mcpServers` or `network.hosts` is refused (`MCP servers changed; load the folder again to review`),
and so is one that changes the steps Genex runs without asking (hooks, observers, locks, folders,
harness tools or `ready`): load the folder again so the user sees the dialog. Watch folder is refused
for a folder agents write in (a game's folder, the games folder, workers' copies), so a plugin an
agent wrote in a game is loaded again by hand after each change. Old package copies are deleted as each reload
lands, and stored settings keep only keys your current manifest declares, with the declared type.

If you are working inside this repository, `npm run watch` now rebuilds plugin packages into
`dist/resources` too, logging `plugins rebuilt`. Set `STUDIO_PLUGIN_DEBUG=1` to append backend
stderr to `engine-homes/plugins/logs/<id>.log`.

## 9. Publish

Two routes; neither is ever applied to a user automatically.

**A GitHub link.** Anyone can install your plugin without a catalog listing: Plugins → Add →
Install from GitHub, then paste your repository's link. Studio installs your **latest release**
(the commit its tag points at); a repository with no release gets the newest commit on its
default branch, and the window says so. So publish a GitHub release for each version you want
people to have. Keep `plugin.json` at the repository root, or have people paste the link to the
plugin's folder (`…/tree/main/plugins/my-plugin`); a repository with several plugins lets them
choose. Private repositories can't be installed, and the pinned `owner/repo[/subdir]@<sha>` still
works for an exact commit.

A GitHub install is **not** audited. Every package file is fetched from the pinned commit and
checked against its git object id; the repository's dotfiles and your authoring files are not
fetched. Symlinks, submodules, truncated trees, files over 8 MiB, packages over 64 MiB or 400
files, and a tree with no `plugin.json` are all refused.

**A Marketplace listing.** The catalog every Genex app reads is
[genex-games/genex-plugins](https://github.com/genex-games/genex-plugins); a maintainer reviews
each release before it is listed. Push the package to a public repository, take the 40-character
commit sha, set `publisher` to your name, and run from a Studio checkout with a clone of your
fork of genex-plugins:

```
npm run plugin:submit -- ~/studio-plugins/my-plugin --catalog ~/genex-plugins \
  --repo you/my-plugin --sha <commit> --category tools [--subdir <folder>] [--docs-url <https URL>]
```

It packs the package as `plugin:pack` does, writes the immutable release record
`records/<id>/<version>.json` and points the `index.json` entry at it, then checks the catalog the
way its CI will, with the catalog's own validator. It refuses an official id (`genex`,
`blender`), the scaffold's `Unpublished` publisher (the publisher owns every later release of the
id), a bad source and a version already released, and keeps nothing it wrote when it refuses. The
record copies `id`, `name`, `publisher`, `description`, `version` and `capabilities` from
`plugin.json`; `category` is one of `assets`, `publishing`, `tools`, `analytics`, `other`, and
`tier` is `community`.

The artifact it prints (`<id>-<version>.json`, beside the clone; `--artifact <file>` to choose)
belongs on your repository's GitHub release for that version, not in the catalog. Commit the
record and `index.json` on a branch of your fork, open a pull request against genex-plugins
`main` and fill in its template; its
[CONTRIBUTING.md](https://github.com/genex-games/genex-plugins/blob/main/CONTRIBUTING.md)
explains the two CI steps. A maintainer restores the artifact with `npm run plugin:unpack --
<artifact.json> <new-dir>`, compares it with your source at that commit, and uploads it. A fix
after release needs a higher `version`.

**A release artifact by itself.** `npm run plugin:pack -- <prebuilt-directory> <artifact.json>`
writes the base64-JSON envelope and prints the canonical manifest and its sha-256. Dotfiles and
dot-folders (`.git`, `.env`) and the scaffold's `AGENTS.md`, `jsconfig.json`, `tsconfig.json` and
`plugin-sdk/` are left out, and a link is refused. Studio accepts an artifact only from an origin
its catalog policy lists, at an address ending in `/<id>/<version>/<sha256>.json`, and shows
`official` only for the ids that policy reserves.

## Checklist before you publish

- [ ] `npm run plugin:doctor -- <dir>` exits 0 and the scan verdict is one you can explain.
- [ ] Every capability in the manifest is one the backend actually uses.
- [ ] `network.hosts` lists every host the backend contacts.
- [ ] Skill text names your real tools and says not to repeat a declined request.
- [ ] Each file skill's summary says when to read it, and its files are `.md` inside the package.
- [ ] Toolbar labels are yours, not Studio's, and every aria-label is unique.
- [ ] Panels inline all script and style and reference no `http(s)://` URL.
- [ ] Every `mcpServers` entry names the narrowest `cwd`, `env` and `toolPolicy` that works, and its
      `description` says what the user must set up.
- [ ] Activation touches nothing: no file writes, no network, no host calls.
- [ ] `publisher` is your name, and `version` is higher than every release you have published.
- [ ] `icon` is a square, full-bleed picture in the package, and the release you tag is the one
      people should get.

## 9. An independent native plugin

Use `src/plugins/blender/plugin.json` and `backend.ts` as the complete example (API 4; its native
declarations need API 3 or later). Its backend
imports only the public SDK type and its own wrapper. Adapt the runtime/version/pin and fixed job
recipe, not Studio internals. Keep credentials, process launch parameters and permission grants
out of agent tool schemas. Tools receive relative input references and return delivered relative
file paths plus durable job IDs. Installation belongs to a separate confirmed action.

For a custom panel, inline the distributed `plugin-sdk/panel.js`. Studio's bundled plugin build
replaces `<!-- STUDIO_PANEL_SDK -->` with that script; external authors must do equivalent inlining
in their own build. Referencing an external script URL or assuming `window.studioPlugin` exists
without the bootstrap produces a nonfunctional panel.

A long install can call `studioPlugin.call('action', 'install', {}, {timeoutMs: 1800000})`. Query
its durable installation state when opening the panel. A panel timeout does not cancel a job;
use a declared Cancel action. Clean up timers/subscriptions when the panel closes. Ordinary
actions keep their existing timeout; do not increase every plugin call to cover downloads.

To verify a native plugin, install it explicitly, invoke it from an existing conversation, observe
the delivered file in the game, disable/re-enable without resetting the conversation, and retrieve
the old job. Test with Genex disabled. Run doctor/pack against the prebuilt package and test the
actual installed app; a mocked host or a TypeScript pass is not native-runtime acceptance.

## Structured arguments and native model transforms

API 3 tool properties may declare `type: "object"`. For a migrated scalar interface,
`acceptJsonString: true` validates legacy JSON objects while advertising an object schema.
The backend must normalize that legacy string once at its boundary. Genex uses this for
`options` across the shared Claude, Codex and local-model tool registry.

The bundled Local Blender plugin demonstrates a transform recipe: the tool accepts `model`
(the authorized project-relative GLB) and a script. Both are staged as explicit native inputs.
The Python script imports `ASSET_INPUTS["model"]`; absolute project or temporary paths are
not sandbox inputs. The result includes `derivedFrom`, and the source is preserved. Output
size is a resource boundary of 100 MiB per native job including renders, not a Genex model
acceptance rule. A snake_case or capitalised `name` becomes a lowercase slug with dashes; other
invalid names, and missing inputs, fail before Blender starts. Extra game files the script reads go
in `inputs` (the `compose` recipe: fixed `input1..9` slots, unused ones carrying the script, the
`inputs` value naming the real ones); `rig` also exports armatures and their actions.

Native results include `inputs[name] = { file, sha256 }` for the actual staged bytes.
The host inventory uses this identity to retain derivative provenance after source renames;
recorded lineage does not by itself establish that a game loads the derivative.


## Curated public distribution

After local authoring/doctor/runtime acceptance, use `npm run catalog:prepare -- <config.json>
<new-output-directory>` to prepare a reviewed release candidate from prebuilt packages. See
[catalog preparation](../marketplace/README.md) for the JSON configuration, and
[public release gates](STUDIO-MARKETPLACE-RELEASE.md) before publishing. The command creates
catalog metadata separately from artifact envelopes and does not upload anything. Stable versions
are immutable: a fix uses a higher version. The static catalog gate does not execute the backend
or replace Studio's full installer validation, user consent, licensing review or live acceptance.

### Panel context notifications

`studioPlugin.onContextChanged(callback)` returns an unsubscribe function. The host notifies
the mounted plugin panel when its plugin changes; notifications carry no credentials. Re-read
status through declared actions, coalesce refreshes and ignore stale in-flight responses.
Declared Connect/Unlock actions can omit an extra confirmation: the UI gesture begins account
setup, while OS/browser authorization remains intact. Disconnect and publish still require confirmation.
