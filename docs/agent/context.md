# Genex: product overview

Genex (formerly AI Game Studio) is an Electron application for making games with AI: local
games for the browser, desktop and phones, and Unreal or other engines' projects. A person
describes a game or a change, answers questions when needed, and reviews the running game and
build results. The game is a real local project that can be opened, edited and exported. New
games are Three.js or Rust · wgpu; C++ · raylib games keep working.

## What the app contains

The sidebar opens games, Plugins, Studio and Settings. Each game pairs one conversation with a
stage that switches between **Live** (the playable game), **Builds** (work and results) and
**Assets** (files and generated media). The prompt bar chooses the model, mode and
tools; chat shows replies, questions, work status and results.

Studio pairs an assistant with Activity, for reviewing runs and instruction improvements.
Plugins add tools, assets and integrations. Settings owns the games folder, appearance,
providers, models and permissions. Accounts, local projects and installed harness edits must
survive application changes.

## Read the part you are changing

| Part | What it covers |
| --- | --- |
| [Workspace and games](../product/workspace.md) | Navigation, library, new/open games, settings and export |
| [Chat and questions](../product/chat.md) | Messages, streaming, statuses, plans, questions and long history |
| [Builds and Live](../product/builds-live.md) | Auto/Loop, workers, progress, playback, checks and outcomes |
| [Models and context](../product/models-context.md) | Models, permissions, saved preferences, accounts and context |
| [Assets and plugins](../product/assets-plugins.md) | Media, previews, tools, plugin setup and permissions |
| [Projects and engines](../product/projects-engines.md) | Project kinds, engines, plugins on or off, ports |
| [Studio and learning](../product/studio-learning.md) | Studio chat, Activity, instruction proposals and rollback |

Read only the relevant page. Product pages describe visible behavior, references mechanisms;
code and tests resolve discrepancies.

## For the developer

[AGENTS.md](../../AGENTS.md) owns development rules and PR policy, the
[design workflow](design.md) visual conventions, [verification](verification.md#choose-the-verification-scope)
the checks and the [field guide](../STUDIO-DEVELOPER-FIELD-GUIDE.md) running the app.

Update the affected page in the behavior change's PR, replacing outdated statements, never as a
diary; `npm run verify:context` checks its size.
