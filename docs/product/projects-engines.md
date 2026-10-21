# Projects and engines

## What a folder holds

A project is any folder: a web game, an Unreal game or plugin, Godot, Unity, Blender assets or a
plugin's kind, several at once. These facts suggest; the first message or the person decides.
The sidebar names a non-game's kind (**Unreal plugin**, **Blender assets**).

New game makes an empty folder; the first message picks its kind. A vague ask builds a web game;
with the Unreal plugin on, a game with no kind asks which engine until picked (Web or Unreal). A port (an Unreal
game from a web folder) snapshots first and keeps the web files as reference; the chat goes on in
the new kind.

## Plugins on or off

Asked for an engine whose plugin is off, the chat shows its card (**Turn on** or **Install…**; a
cross puts it away), which only your click acts on. On your word agents go on without it, as for
Godot: the lead and workers run its programs as background jobs in the chat's mode, look
at its windows with `app_look` (never clicking), read its docs, or write you a plugin.

A plugin loaded from a folder on this Mac starts off and runs with your access. Each of its tools
asks before an agent runs it; Always allow lists that tool on its page under **Runs without
asking**, with **Ask every time**. New code or turning it off clears those; its steps at Genex's
moments never ask.

## Loops in place

Any folder but a web game at its root (Blender files beside it allowed), Blender alone included:
the chat's session leads the Loop in place, on Claude Code, Codex or OpenCode (others refuse). The lead keeps save points (one row in Builds),
starts workers (of its plugins' types, if any) and claims finish; a reviewer checks (three no's
stop it). Plugins add steps at Genex's moments, reviewer pictures and locks: while you work in a
plugin's editor, agents wait.

## Unreal

The lead works in the open editor through the Genex editor helper, one holder at a time; while you
play there the chat reads “Waiting for you to finish in Unreal” (a build waits 10 minutes). A
turn saves and snapshots unsaved editor work. Rewind saves, closes and reopens Unreal; if it can't,
files stay and the chat says why. An **Unreal plugin** project is a host project with the
plugin in `Plugins/`; its tools build it, test it headless and package it.

## Live's views

Live shows what the folder holds: the web preview, the Unreal card (setup step, latest shot,
**Open in Unreal**) or a run's pictures; only the preview has web controls. A web game plus Unreal
project gets **Web game** and **Unreal** tabs in Live's place, the last chosen remembered per game;
a web build shown from the chat brings Web game forward.

## Where to work

[project-kind](../../src/renderer/project-kind.ts) labels the sidebar;
[live-views](../../src/renderer/live-views.ts) and
[stage-tabs](../../src/renderer/panels/stage/stage-tabs.ts) pick Live's views. Mechanisms:
[plugins](../plugins.md#project-facts),
[tool permissions](../tool-permissions.md#workers) and [harness runtime](../harness-runtime.md).
