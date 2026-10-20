# Workspace and games

## What the user sees

The sidebar holds Search, Notifications, Send feedback
([what it sends](../../PRIVACY.md#send-feedback)), the Play/Create switch, New game, Plugins,
Harness, Settings, Games, Friends and, once they wait, **Genex terms updated**,
**plugin updates** and **Relaunch to update** (Linux: **Download**); lists scroll. Pinned games lead, then recent activity. Every launch
opens **home** (also the wordmark): one composer over an optional picture. A game opens its
conversation beside the stage (Live, Builds once planned, Assets); Harness opens its conversation
and Activity; Plugins fills the workspace.

Settings is a modal: Genex account, Model Providers, Local Models, Appearance, Games, Storage,
Harness, Permissions, Privacy, About. Narrow windows use a drawer; wide ones remember the sidebar.

The bell keeps unanswered questions, plans and permission requests, then build endings and
sign-outs, each opening where answered; unfocused, macOS notifications and the Dock badge carry
them.

**Play** shows genex.games' games, the Genex account and nickname (kept offline), **Friends**
with invites, profiles and **Stats** ([Play](../play.md)).

## First launch

An empty, never-welcomed profile opens a full-window welcome that ends connecting Claude Code,
ChatGPT, a local model, OpenRouter or OpenCode; Skip or Start building opens home, keeping a typed
idea.

Then a Genex plugin card offers **Connect Genex plugin** once.

A sandbox that cannot start opens **Set up the protected workspace**; Windows needs one
administrator prompt (two if Secondary Logon is off).

## Main actions

- **Home's first message** starts a game the model names, where the chip says
  ([its kind](projects-engines.md)). Duplicates never overwrite; a greeting stays **Untitled game** until an idea. **New game**, the Games **+** and Command-N open home.
- **Settings → Games** moves new games to an empty folder (default `~/AI Games`);
  **Storage** frees older builds, keeping paused and latest finished.
- **Settings → Privacy**: Share build metrics (off by default), its preview and delete, and
  policy links ([PRIVACY](../../PRIVACY.md)).
- Home's **Open a folder…** inspects before writing (Claude settings and hooks trusted unless
  switched off); only a web folder gets starter files.
- A game's menu offers Rename (same folder), Pin/Unpin, Change image and Delete, which
  drops only the library entry (active work blocks it; reopening restores it).
- The chat header shows the title, Show in Finder, Terminal, ⋯ (Export game…, Rename) and
  **Free N GB** past 1 GB; Harness and unbound drafts have none. Search reaches older and unbound chats.
- Command-B toggles navigation, Command-K searches, Command-2 Harness, Command-1 the last chat.

## State and appearance

A game's folder owns its identity. Commits and checkpoints skip engine scratch (`Saved/`,
`.godot/`, Blender backups). Rollback snapshots first, refusing changed branches, commits or
merges. Snapshots and links use raw bytes, Git hooks and filters off; LFS pointers stay
pointers. Unsent text survives loading; hidden workspaces ignore keys.

The live game is a native view; while an overlay covers it, the stage holds its frame.

## Where to work

- [Shell](../../src/renderer/shell): navigation, [home](../../src/renderer/shell/HomeScreen.tsx),
  selected conversation, stage, [notification feed](../../src/renderer/notifications.ts).
- [Onboarding](../../src/renderer/onboarding/Onboarding.tsx): first launch; [Play](../../src/renderer/play).
- [Chat header](../../src/renderer/panels/ChatHeader.tsx) and
  [Settings](../../src/renderer/panels/SettingsDialog.tsx): workspace actions.
- [Architecture](../agent/architecture.md); [Feature Map](../agent/feature-map.md).
