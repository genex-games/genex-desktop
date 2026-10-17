# Genex: product overview

Genex (formerly AI Game Studio) is a macOS Electron application for making games with AI:
local browser games, and Unreal, Roblox Studio or other engines' projects. A person describes a
game or a change, answers questions, and reviews the running game and build results. Each game is
a real local project to open, edit and export.

## What the app contains

The sidebar's **Play** runs published games; **Create** opens games, Plugins, Studio and
Settings. Each game has one conversation on the left and a stage on the right. The stage
switches between **Live** (the playable
game), **Builds** (work and results) and **Assets** (files and generated media).

The prompt bar chooses the model, permissions, Auto or Loop mode, planning, references and
tools. Chat shows replies, questions, compact status and results; details expand on demand.

Studio pairs an assistant with Activity to review runs and instruction improvements. Settings owns
the games folder, appearance, provider/model setup and saved permissions. Accounts, local projects and installed harness edits
must survive application changes.

## Read the part you are changing

| Part | What it covers |
| --- | --- |
| [Workspace and games](../product/workspace.md) | Navigation, Play, library, new/open games, settings and export |
| [Chat and questions](../product/chat.md) | Messages, streaming, statuses, plans, questions and long history |
| [Builds and Live](../product/builds-live.md) | Auto/Loop, workers, progress, playback, checks and outcomes |
| [Models and context](../product/models-context.md) | Models, permissions, saved preferences, accounts and context |
| [Assets and plugins](../product/assets-plugins.md) | Media, previews, tools, plugin setup and permissions |
| [Projects and engines](../product/projects-engines.md) | Project kinds, engines, plugins on or off, ports |
| [Studio and learning](../product/studio-learning.md) | Studio chat, Activity, instruction proposals and rollback |

Product pages describe visible behavior, references mechanisms; code and tests resolve
discrepancies.

## For the developer

[AGENTS.md](../../AGENTS.md) owns development rules and PR policy, the
[design workflow](design.md) visual conventions, [verification](verification.md#choose-the-verification-scope)
the checks and the [field guide](../STUDIO-DEVELOPER-FIELD-GUIDE.md) running the app.
