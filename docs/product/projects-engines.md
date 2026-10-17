# Projects and engines

## What a folder holds

A project is any folder, several kinds at once: web, Unreal game or plugin, Roblox, Godot, Unity,
Blender assets or a plugin's kind. Facts suggest; the first message or the person decides. The
sidebar names a non-game's kind (**Unreal plugin**, **Blender assets**).

New game makes an empty folder; the first message picks its kind. A vague ask builds a web game;
with an engine plugin on, a game with no kind asks which engine. A port snapshots first, keeping
the web files as reference.

## Plugins on or off

Engine buttons show only on their games. Asked for an engine whose plugin is off, the chat shows its
card (**Turn on Unity** or **Install…**; × hides it); your click turns it on, then the chat goes
on. A missing engine gets a setup card. Told to, agents go on without: jobs, `app_look`, docs.

A plugin from a folder on this Mac starts off and runs with your access. Each tool asks first;
Always allow lists it under **Runs without asking** until new code or turning it off; its steps at
Genex's moments never ask.

## Loops in place

Except for web games at the folder's root (Blender files beside them allowed), the chat leads the
Loop in place on Claude Code, Codex or OpenCode. It keeps save points, starts workers, pauses if
blocked and claims finish; a reviewer checks (three no's stop it). Plugins add steps, reviewer
pictures and editor locks: while you use an editor, agents wait. A linked engine game is no web game; Unreal and Godot
projects outside the game get no Loop or Rewind.

## Unreal

The lead works in the open editor through Genex's helper, one holder at a time; while you play
there the chat reads “Waiting for you to finish in Unreal”. Rewind saves, closes and reopens Unreal.
Agents and blind judges play it. Mac games skip hardware ray tracing. An **Unreal plugin** project
is a host project with the plugin in `Plugins/`; its tools build, test and package it.

## Godot, Roblox, Unity

Godot 4.3+: its button gets Godot, makes a **New Godot game** (2D/3D, `godot/`) and opens your
editor, which saves at save points, reloads after Rewind; **Change project** links one anywhere.
Its `web/` build plays in Live.

**Roblox Studio** sets up your Studio; **New Roblox game** writes a Baseplate place, **Use in this
game** links one per game. Unity sets up and opens its project; agents add packages, build and
play (keys and mouse need Input System).

## Live's views

Live shows the web preview, an engine's card (latest shot and next step) or run pictures; only the
preview has web controls. A web game plus an engine project gets a tab each, the last chosen kept
per game; a chat's web build brings Web game forward.

## Where to work

[project-kind](../../src/renderer/project-kind.ts) labels the sidebar;
[live-views](../../src/renderer/live-views.ts) and
[stage-tabs](../../src/renderer/panels/stage/stage-tabs.ts) pick Live's views. Mechanisms:
[plugins](../plugins.md#project-facts),
[tool permissions](../tool-permissions.md#workers) and [harness runtime](../harness-runtime.md).
