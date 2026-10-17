# The plugin's own skill

A plugin teaches agents how to use its engine with a skill: a Markdown file in the plugin's folder,
declared in `skills` with a one-line `summary`. Agents see the summary in their brief and read the
file on demand with `<id>__skill` (for Sketch, `sketch__skill {"name": "sketch"}`), so the summary
says when to read it and the file says what to do.

- Scope it: `facts` names the kinds of project it is for (none: every project), and `tools` the
  plugin tools it explains, so it reaches a session only while one of them does.
- Write what an agent can't find in the engine's own documentation: the project's layout, which
  tool to call for what, what each tool answers, what a failure means and how to fix it, and what
  never to do (files the engine writes itself, folders it locks while running).
- Keep it short and concrete. A long topic goes in a reference file the skill lists in `references`
  (read with `file`), each at most 128 KiB.
- A skill holds no secrets and gives no instructions to the person; it is read by agents.

Write `genex-plugins/sketch/skills/sketch.md`:

```markdown
# Sketch projects

A Sketch project is a folder with one `*.sketchproj` file at its top, its scenes in `scenes/`
(`*.skscene`) and Sketch's scratch in `Cache/`, which Genex keeps out of history.

- Build with `sketch__build`, optionally naming the `scene` to build first. It answers
  `{ok: true, output}` or `{ok: false, problem}`; a problem quotes the editor's own error, with the
  scene and line it names: fix that file and build again.
- `sketch__build` waits while the person works in the Sketch editor; never ask them to close it.
- A problem saying the Sketch editor isn't answering means it isn't open on this project: ask the
  person to open it, or build without it by running `sketchc build` as a job (it asks as the chat's
  permission mode says). Never try to install Sketch.
- Never edit files in `Cache/` or `Exports/`: sketchc writes them.
- Each scene is one file: a worker of the `scene` type edits one scene at a time, in its own copy.
```
