# plugin.json, section by section

Every Genex plugin starts with `plugin.json` at the top of its folder. Use `"apiVersion": 3`: the
sections below that say "API 3" need it. A section you don't need is left out (the five lists the
manifest requires may be empty). `plugin_check` names the first thing Genex refuses.

## Identity (required)

- `apiVersion` 3; `id` lowercase letters, digits and dashes, starting with a letter (it is also the
  folder name and the prefix of the plugin's tools, `<id>__<tool>`); `version` like `0.1.0`; `name`
  the person reads; `publisher`; `description` one sentence saying what it does for the person.
- `backend` the module that answers its tools, `backend.mjs`; `capabilities` the Genex services the
  backend asks for (`[]` when it needs none; see Genex's plugin guide). A backend that talks to the
  engine over the network asks for `network` and names each host it reaches in `network: {hosts}`
  (`127.0.0.1` for a port on this Mac).

## Sections

- `detect` (API 3): how Genex knows a project of the engine's kind, as facts: `{fact, files,
  notUnder?}`, `files` globs such as `**/*.sketchproj`, `notUnder` folders to skip (vendored copies).
- `engine` (API 3, capability `game-engine`): the engine the plugin is, which games linked to its
  projects build in: `{id, label, projectFiles, fact, projectInFolder, play?, apps?}`. `id` is the
  plugin's own id; `label` the engine's name; `projectFiles` 1–4 extensions a project file has
  (`.sketchproj`); `fact` one of its `detect` facts; `projectInFolder` true when save points must
  hold the project inside the game folder; `apps` the editor's Mac bundle ids and Windows `.exe`
  names, which computer use never drives to build or play.
- `tools`: what agents call. Each `{name, description, parameters}` (a JSON schema object), with
  `facts` (the kinds of project it reaches; none: every project), `needs` (the locks a call holds),
  `makes` (the facts it makes in an empty folder) and `confirmation` (a question asked each call).
  `"audience": "harness"` makes a tool only Genex calls, at its moments or as a lock's probe.
- `skills`: what agents read. A file skill `{name, summary, file, facts?, tools?, references?}` is
  read on demand with `<id>__skill`; `tools` ties it to the tools it explains.
- `panels`, `settings`, `actions`: a plugin's own page, settings and buttons in Plugins (often `[]`).
- `toolbar`: buttons on the game's strip, `{id, label, ariaLabel, icon, facts, target, status}`,
  `target` `{kind: "panel", id}` and `status` an action answering `{badge, tone, dot}`. An engine's
  button names the engine's `facts`, so it shows only on that engine's games, never on every game,
  and an `icon`, as a narrow strip folds its buttons to icons; its status is a dot (`"dot": true`),
  green (`"tone": "ok"`) once the editor answers. Its panel: one outlined block per subject (this
  game's project first, then this computer), a quiet label above each, a rule between rows, the
  state in the button's words, and the block's actions in its foot.
- `locks` (API 3): what one holder at a time may use, such as the editor: `{id, label, per,
  personFirst?}`, `per` `project` or `app`; `personFirst` a harness tool answering `{personActive,
  unsaved}` so Genex waits while the person works in it.
- `folders` (API 3): folders outside the project the engine's programs write to, each `{path, why}`
  (never the home folder, `~/Library` or `~/Documents` themselves).
- `hooks` (API 3): harness tools Genex runs at its moments, `{on, tool}`: `run.prepare`, `run.end`,
  `turn.start`, `turn.end`, `checkpoint.before`, `checkpoint.after`, `restore.before`,
  `restore.after`, `worker.start`, `worker.end`, `tool.before`, `tool.after`, `health`, `crash`,
  `finish`. A handler answers `{}`, `{note}`, `{block}` (stops what blocks, a note elsewhere),
  `{pending}` or `{images}`.
- `observers` (API 3): what Genex captures as evidence for the reviewer, `{id, facts, tool, live?, label?}`,
  the tool a harness tool answering `{images}` (base64 PNG); `"live": "stills"` shows them in Live,
  and `label` names that view's tab when a folder has more than one view (else the plugin's name).
- `workspace` (API 3): `ignore` (kept out of the project's history) and `copySkip` (not copied into
  a worker's copy), folder patterns such as `Cache/`.
- `assets` (API 3): the folders the Assets tab lists, and the file `formats` it keeps (extensions
  without the dot, at most 10 lowercase letters or digits).
- `workerTypes` (API 3): kinds of worker a lead may start, `{id, description, tools, isolation}`,
  `isolation` `read` (in place, writes nothing), `copy` (its own copy, merged back) or `lock` (in
  place, one at a time).
- `scaffolds` (API 3): the kinds of project its tools make, `{id, label, tool}`, the tool one that
  declares `makes`; the label names the kind beside the project.
- `judges` (API 3, beside `engine`): blind judges that play the engine's games in its editor,
  `{id, label, facts?, brief, players?, probe?}`. `brief` is a Markdown file in the package (at most
  16 000 characters) added to the judge's rubric; `players` at most the engine's `play.players`;
  `probe` a harness tool that needs every lock `play-open` needs, which Genex runs once right after
  the judge's play opens (its `note` and `images`, never source, open the judge's first answer).

## A complete example: Sketch

Sketch is a made-up engine with a project file `*.sketchproj`, an editor the person also uses (it
answers on a control port on this Mac while it runs), a command-line program, `sketchc`, scenes in
`scenes/` and scratch in `Cache/`. The plugin's tools ask the editor; `sketchc` is the lead's to run
as a job. Every section above is here once.

Write `genex-plugins/sketch/plugin.json`:

```json
{
  "apiVersion": 3,
  "id": "sketch",
  "version": "0.1.0",
  "name": "Sketch",
  "publisher": "Written in this project",
  "description": "Builds and checks Sketch projects through the Sketch editor.",
  "backend": "backend.mjs",
  "capabilities": ["network", "game-engine"],
  "network": { "hosts": ["127.0.0.1"] },
  "detect": [{ "fact": "sketch-project", "files": ["**/*.sketchproj"], "notUnder": ["**/vendor/"] }],
  "engine": {
    "id": "sketch",
    "label": "Sketch",
    "projectFiles": [".sketchproj"],
    "fact": "sketch-project",
    "projectInFolder": true
  },
  "tools": [
    {
      "name": "build",
      "description": "Build the Sketch project in the Sketch editor and answer what went wrong.",
      "parameters": {
        "type": "object",
        "properties": { "scene": { "type": "string", "description": "The scene to build first." } }
      },
      "facts": ["sketch-project"],
      "needs": ["sketch-editor"]
    },
    {
      "name": "new-project",
      "description": "Make an empty folder a new Sketch project with the Sketch editor.",
      "parameters": {
        "type": "object",
        "properties": { "name": { "type": "string", "description": "The project's name." } },
        "required": ["name"]
      },
      "makes": ["sketch-project"]
    },
    {
      "name": "editor-state",
      "audience": "harness",
      "description": "Whether the person is using the Sketch editor, and how many scenes are unsaved.",
      "parameters": { "type": "object", "properties": {} }
    },
    {
      "name": "open-editor",
      "audience": "harness",
      "description": "Open this project in the running Sketch editor before a run; the run waits for the person when the editor is closed.",
      "parameters": { "type": "object", "properties": {} }
    },
    {
      "name": "save-scenes",
      "audience": "harness",
      "description": "Save every open scene before a save point.",
      "parameters": { "type": "object", "properties": {} }
    },
    {
      "name": "capture",
      "audience": "harness",
      "description": "Capture the Sketch editor's viewport.",
      "parameters": { "type": "object", "properties": {} }
    },
    {
      "name": "reload-scenes",
      "audience": "harness",
      "description": "Reload every scene from disk after a restore.",
      "parameters": { "type": "object", "properties": {} }
    },
    {
      "name": "check-editor",
      "audience": "harness",
      "description": "Whether the Sketch editor still answers.",
      "parameters": { "type": "object", "properties": {} }
    },
    {
      "name": "reopen-editor",
      "audience": "harness",
      "description": "After a crash, open this project in the Sketch editor again if the editor still runs; else say the person must reopen it.",
      "parameters": { "type": "object", "properties": {} }
    }
  ],
  "skills": [
    {
      "name": "sketch",
      "summary": "How a Sketch project is laid out, and how to build and check one.",
      "file": "skills/sketch.md",
      "facts": ["sketch-project"],
      "tools": ["build"]
    }
  ],
  "panels": [],
  "settings": [],
  "actions": [],
  "locks": [{ "id": "sketch-editor", "label": "Sketch editor", "per": "project", "personFirst": "editor-state" }],
  "folders": [{ "path": "~/Library/Application Support/SketchEngine", "why": "Sketch's settings and caches" }],
  "hooks": [
    { "on": "run.prepare", "tool": "open-editor" },
    { "on": "checkpoint.before", "tool": "save-scenes" },
    { "on": "checkpoint.after", "tool": "capture" },
    { "on": "restore.after", "tool": "reload-scenes" },
    { "on": "health", "tool": "check-editor" },
    { "on": "crash", "tool": "reopen-editor" }
  ],
  "observers": [{ "id": "viewport", "facts": ["sketch-project"], "tool": "capture", "live": "stills" }],
  "judges": [{ "id": "first-play", "label": "First play", "facts": ["sketch-project"], "brief": "judges/first-play.md" }],
  "workspace": { "ignore": ["Cache/"], "copySkip": ["Cache/", "Exports/"] },
  "assets": { "folders": ["scenes"], "formats": ["skscene"] },
  "workerTypes": [{ "id": "scene", "description": "Edits one Sketch scene", "tools": ["build"], "isolation": "copy" }],
  "scaffolds": [{ "id": "game", "label": "Sketch game", "tool": "new-project" }]
}
```

A judge's brief says what it checks, in the player's words; it never mentions code. Write
`genex-plugins/sketch/judges/first-play.md`:

```markdown
# First play

Play from the game's first screen as someone who has never seen it. Check that you can tell what to
do within a minute, that the controls answer at once, and that the first goal can be reached.
```
