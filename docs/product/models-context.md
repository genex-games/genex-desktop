# Models and context

## Selecting a model

The model button opens Main agent, Workers and Reviewers, grouped by provider; Add more models
opens setup. Blocked plans keep the request, offering model settings or retry. Fast mode is hidden.

Claude Code and Codex discover models without generating. The list names each family's newest
model of the newest generation; older ones switch on in Settings; a model in use stays listed.
An unset pick runs the CLI's named default, else a default row. Aliases follow the CLI;
versions stay pinned. OpenRouter and OpenCode show three, newest first, no default.

Settings shows CLI versions; connected rows list picker models; Account rechecks
or updates the CLI. Failed refreshes offer Try again, keeping names stale. Unavailable picks block sends; without models, Connect AI model replaces the
model pill. New models may need a CLI update; listing does not prove access.

Each chat keeps its model, effort and Loop; fresh games inherit the last picks. One effort,
on the main agent's levels, serves every role at its closest.
Workers and Reviewers run only in Loop and survive a main-agent change. Each Ollama job takes its
own model; Reviewers must see images.

Local Models (Bonsai/Ollama) downloads and deletes. Metered OpenCode and OpenRouter get their own
groups and are never auto-chosen ([details](../connections-and-context.md#openrouter-and-opencode)).

## What the model knows

The context ring shows reported orchestrator usage and capacity; unknown stays unknown. Its panel
offers Compact now, also typed as `/compact` (Claude Code and Codex use
[their own](../connections-and-context.md#compact-now); others hand over); every provider, workers
included, also compacts automatically. Then plan limits ([details](../connections-and-context.md#plan-limits)).

Ollama uses a loaded model's reported runtime context; an unloaded
model's budget is an estimate marked unknown. Tools and images need reported capability;
unsupported requests fail before inference.

Game files, instructions, reference images and enabled tools contribute through
channels ([tool setup](assets-plugins.md)). Enabling a plugin never signs in or authorizes paid
generation. Credentials stay in protected storage, never in messages, logs or docs.

Studio's assistant keeps its own model, effort and context ([Studio](studio-learning.md)).

## Permissions

Every chat's pill after Mode picks **Auto** (Recommended; stops dangerous actions),
**Manual**, **Accept edits**, **Plan** or **Bypass permissions** (confirmed; Rewind restores
only the game); modes the engine cannot honour are greyed with why (Codex: Auto, Plan,
Bypass; Bonsai, OpenRouter: no Bypass; OpenCode: Auto, Plan; Ollama: Auto). Chats keep their mode;
new ones inherit the last Auto, Manual or Accept edits. Claude's chat and build lead work anywhere
on your Mac with your access, workers in your mode but never in sign-ins, Genex's data or other
games; their questions wait unless **Don't wait for me** (Mode) is on ([details](../tool-permissions.md)).

Adopted folders' Claude settings/hooks load only once trusted in Open Game.
Read denials also cover sensitive system/account locations. Codex read restrictions are
advisory, not whole-disk isolation.

## Where to work

Start at [ModelsSection](../../src/renderer/panels/ModelsSection.tsx) and
[PromptBar](../../src/renderer/ui/PromptBar.tsx); see [Local models](../local-models.md),
[continuation](../conversation-coordinator.md),
[composer design](../agent/design.md#prompt-composer) and
[judge evaluation](../judge-evaluation.md).
