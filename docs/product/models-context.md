# Models and context

## Selecting a model

The model button opens Main agent, Workers and Reviewers by provider; Add more models opens
setup. Blocked plans keep the request, offering settings or retry.

Claude Code and Codex discover models without generating. The list names each family's newest
model of the newest generation; older ones switch on in Settings; a model in use stays listed.
An unset pick runs the CLI's named default, else a default row. Aliases follow the CLI;
versions stay pinned.

Settings shows CLI versions; Account rechecks or updates them; failed refreshes offer Try again.
Tabs switch [accounts](../connections-and-context.md#several-accounts-per-subscription).
Unavailable picks block sends; without models, Connect AI model replaces the model pill. A
listing proves no access.

Each chat keeps its model, effort and Loop; fresh games inherit the last picks. One effort, on the
main agent's levels, serves every role (Workers and Reviewers at most high).
Workers and Reviewers run only in Loop and
survive a main-agent change. Each Ollama job takes its own model; Reviewers must see images and
check a Loop's finish.

Local Models (Bonsai/Ollama) downloads and deletes. Metered OpenRouter and OpenCode show three once
set up, no default, never auto-chosen unless Free and alone
([details](../connections-and-context.md#openrouter-and-opencode)). Local server connects your LM
Studio, llama.cpp or TabbyAPI ([details](../connections-and-context.md#your-own-model-server)).

## What the model knows

The context ring shows reported orchestrator usage and capacity; unknown stays unknown. Its panel
offers Compact now (or `/compact`; Claude Code and Codex use
[their own](../connections-and-context.md#compact-now), others hand over); every provider, workers
included, compacts automatically. Then plan limits
([details](../connections-and-context.md#plan-limits)).

Ollama's context is a loaded model's report, else an unknown estimate. Tools and images
need reported capability; unsupported requests fail before inference.

Game files, instructions, reference images and enabled tools contribute through channels
([tool setup](assets-plugins.md)). Credentials stay in protected storage, never in messages
or logs.

## Permissions

Every chat's pill after Mode picks **Auto** (Recommended; stops dangerous actions),
**Manual**, **Accept edits**, **Plan** or **Bypass permissions** (confirmed; Rewind restores
only the game); modes the engine cannot honour are greyed with why
([by engine](../tool-permissions.md#other-engines)). Chats keep their mode; new ones inherit the
last Auto, Manual or Accept edits. Claude's chat and build lead work anywhere on your Mac with
your access, workers in your mode but never in sign-ins, Genex's data or other games; a Loop
worker's question lapses after five minutes ([details](../tool-permissions.md)).

Read denials cover sensitive system/account locations; Codex's are advisory, not whole-disk
isolation.

## Where to work

Start at [ModelsSection](../../src/renderer/panels/ModelsSection.tsx) and
[PromptBar](../../src/renderer/ui/PromptBar.tsx); see [Local models](../local-models.md),
[continuation](../conversation-coordinator.md),
[composer design](../agent/design.md#prompt-composer) and
[judge evaluation](../judge-evaluation.md).
