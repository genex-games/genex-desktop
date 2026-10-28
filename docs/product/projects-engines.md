# Projects and engines

## What a folder holds

A project is any folder, several kinds at once: web, Unreal game or plugin, Roblox, Godot, Unity,
Blender assets or a plugin's kind. Facts suggest; the first message or you decide. The
sidebar names a non-game's kind.

New game makes an empty folder; the first message picks its kind. A vague ask builds a web game;
with an engine plugin on, a kindless game asks which engine. A port snapshots first, keeping
the web files as reference.

## Plugins on or off

Engine buttons show only on their games. Asking for an engine whose plugin is off, or opening its
project, shows its card (**Turn on Unity** or **Install…**; × hides it); a click turns it on and
chat goes on. A missing engine gets a setup card. Told to, agents go on without: jobs, `app_look`, docs.

A plugin from a folder on this Mac starts off, runs with your access, and asks before each tool;
Always allow lists it under **Runs without asking** until new code or turning it off; its steps at
Genex's moments never ask.

## Loops in place

Except for web games at the folder's root (Blender files allowed), the chat leads the Loop in
place (Claude Code, Codex or OpenCode). It keeps save points, starts workers, pauses if blocked,
claims finish; a reviewer checks (no's stop it, timed Loops only late). Plugins add steps, reviewer
pictures and editor locks: while you use an editor, agents wait. A linked engine game is no web
game; Unreal and Godot projects outside it get no Loop or Rewind.

## Unreal

The lead works in the open editor through Genex's helper, one holder at a time; while you play
the chat reads “Waiting for you to finish in Unreal”. Rewind saves, closes and reopens Unreal.
Agents and blind judges play it. Mac games skip hardware ray tracing. Agents set up linked projects;
Undo reverts both. Agents package its apps. An **Unreal plugin** project
is a host project with the plugin in `Plugins/`; its tools build, test and package it.

## Godot, Roblox, Unity

Godot 4.3+ (Mac, Windows; Do it for me installs it): makes a **New Godot game**
(2D/3D, `godot/`), opens your editor (saving at save points, reloading after Rewind); **Change
project** links one. **Multiplayer** joins web, native.

**Set it up for me** readies Roblox Studio and a new place (you sign in); **Use in this
game** links yours. Unity sets up and opens its project; agents add packages,
**Multiplayer**, build, play (keys, mouse: Input System). Publish lists Web, Mac, Windows and Linux builds.

## Live's views

Live shows the web preview, an engine's card (its latest shot) or run pictures; only the preview
has web controls. A web game plus an engine project gets a tab each, the last chosen kept
per game; a chat's web build brings Web game forward.

## Where to work

[project-kind](../../src/renderer/project-kind.ts) labels the sidebar;
[live-views](../../src/renderer/live-views.ts) and
[stage-tabs](../../src/renderer/panels/stage/stage-tabs.ts) pick Live's views. Mechanisms:
[plugins](../plugins.md#project-facts),
[tool permissions](../tool-permissions.md#workers) and [harness runtime](../harness-runtime.md).
