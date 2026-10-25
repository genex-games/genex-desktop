# Workspace and games

## What the user sees

The sidebar holds Search, Notifications, Send feedback
([data](../../PRIVACY.md#send-feedback)), the Play/Create switch, New game, Plugins,
Items ([Browse, Selling](../play.md#the-item-store)), Harness, Settings, Games, Friends and, once they wait, **Genex terms updated**,
**plugin updates** and **Relaunch to update** (Linux: **Download**). Pinned games lead, then recent activity. Every launch
opens **home** (also the wordmark): one composer over an optional picture. A game opens its
conversation beside the stage (Live, Builds once planned, Assets), Harness its conversation
and Activity; Plugins and Items fill the workspace.

Settings (a modal): Genex account, Model Providers, Local Models, Appearance, Games, Storage,
Harness, Permissions, Privacy, About; narrow windows: a drawer.

The bell keeps unanswered questions, plans, permission requests, then build endings and
sign-outs, each opening where answered; unfocused, macOS notifications and the Dock badge carry
them.

**Play** shows genex.games' games and their [Stores](../play.md#the-item-store), the Genex account and
nickname (kept offline), **Friends** with invites, profiles and **Stats** ([Play](../play.md)).

## First launch

An empty, never-welcomed profile opens a full-window welcome that ends connecting Claude Code,
ChatGPT, a local model, OpenRouter or OpenCode; Skip or Start building opens home, keeping a typed
idea.

A Genex card then offers **Connect Genex plugin** once.

A sandbox that cannot start opens **Set up the protected workspace** (Windows: one
administrator prompt, two if Secondary Logon is off).

## Main actions

- **Home's first message** starts a game the model names, where the chip says
  ([its kind](projects-engines.md)). Duplicates never overwrite; a greeting stays **Untitled game** until an idea. **New game**, Games **+** and Command-N open home.
- **Settings → Games** moves new games to an empty folder (default `~/AI Games`);
  **Storage** frees older builds (keeps paused, latest) and [moves data](../windows-sandbox.md#data-folder-on-another-drive) (Windows).
- **Settings → Privacy**: Share build metrics (off by default) with preview and delete, and
  policy links ([PRIVACY](../../PRIVACY.md)).
- Home's **Open a folder…** inspects before writing (Claude settings and hooks trusted unless
  switched off); only a web folder gets starter files.
- A game's menu: Rename (same folder), Pin/Unpin, Change image, Delete (only the library
  entry; active work blocks it; reopening restores it).
- The chat header: title, Show in Finder, Terminal, ⋯ (Export game…, Rename), **Free N GB**
  past 1 GB; Harness and unbound drafts have none. Search reaches older and unbound chats.
- Command-B toggles navigation, Command-K searches, Command-2 Harness, Command-1 the last chat.

## State and appearance

A game's folder owns its identity. Commits and checkpoints skip engine scratch (`Saved/`,
`.godot/`, Blender backups). Rollback snapshots first, refusing changed branches, commits or
merges. Snapshots and links use raw bytes, Git hooks and filters off; LFS pointers stay
pointers. Unsent text survives loading; hidden workspaces ignore keys.

Live is a native view; under an overlay the stage holds its frame.

## Where to work

- [Shell](../../src/renderer/shell): navigation, [home](../../src/renderer/shell/HomeScreen.tsx),
  selected conversation, stage, [notification feed](../../src/renderer/notifications.ts).
- [Onboarding](../../src/renderer/onboarding/Onboarding.tsx): first launch; [Play](../../src/renderer/play);
  [Items](../../src/renderer/panels/items).
- [Chat header](../../src/renderer/panels/ChatHeader.tsx) and
  [Settings](../../src/renderer/panels/SettingsDialog.tsx): workspace actions.
- [Architecture](../agent/architecture.md); [Feature Map](../agent/feature-map.md).
