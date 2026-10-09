# Genex: product overview

Genex (formerly AI Game Studio) is a macOS Electron application for making local browser games
with AI. A person describes a game or a change, answers questions when needed, and reviews
the running game and build results. The game is a real local project that can be opened,
edited and exported. Unity is retired.

## What the app contains

The sidebar opens games, Plugins, Studio and Settings. Each game has one main conversation
on the left and a stage on the right. The stage switches between **Live** (the playable
game), **Builds** (work and results) and **Assets** (files and generated media).

The prompt bar chooses the model, permissions, Auto or Loop mode, optional planning,
references and tools. Chat shows replies, real questions, compact work status and results. Detailed tools,
checks and worker activity expand on demand.

Studio is a separate assistant and Activity feed for reviewing runs and improvements to
the game-building instructions. Plugins add tools, assets and integrations. Settings owns
the games folder, appearance, provider/model setup and saved permissions. Accounts, local projects and installed harness edits
must survive application changes.

## Read the part you are changing

| Part | Current UI, behavior and implementation entry points |
| --- | --- |
| [Workspace and games](../product/workspace.md) | Navigation, library, new/open games, settings and export |
| [Chat and questions](../product/chat.md) | Messages, streaming, statuses, plans, questions and long history |
| [Builds and Live](../product/builds-live.md) | Auto/Loop, workers, progress, playback, checks and outcomes |
| [Models and context](../product/models-context.md) | Models, permissions, saved preferences, accounts and context |
| [Assets and plugins](../product/assets-plugins.md) | Media, asset previews, tools, plugin setup and permissions |
| [Studio and learning](../product/studio-learning.md) | Studio chat, Activity, instruction proposals and rollback |

Start here, then read only the relevant page, following its technical links only when
needed. Product pages describe visible behavior; references describe mechanisms. Code and
tests resolve discrepancies.

## For the developer

[AGENTS.md](../../AGENTS.md) supplies development rules, documentation upkeep and PR policy.
The [design workflow](design.md) owns visual conventions and
skill selection. Use [verification](verification.md#choose-the-verification-scope) to choose
checks and the [field guide](../STUDIO-DEVELOPER-FIELD-GUIDE.md) to run the app.

This handbook is shared knowledge, not a session diary: update the affected page in the behavior
change's PR, replacing outdated statements; `npm run verify:context` checks its size.

The in-app harness builds games with narrower authority; its history and learning are separate
from this handbook.
