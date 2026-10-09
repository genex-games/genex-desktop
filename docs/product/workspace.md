# Workspace and games

## What the user sees

The sidebar contains Search, Notifications, Send feedback
([what it sends](../../PRIVACY.md#send-feedback)), New game, Plugins, Harness, Settings, the Games
library and, once an update waits, **Relaunch to update** (Linux: **Download**); only games
scroll. Pinned games lead, then recent activity. Every launch opens **home** (also the wordmark): nothing
selected, one composer over an optional dithered picture. A game opens its conversation beside
the stage (Live, Builds once planned, Assets); Harness opens its conversation and Activity;
Plugins fills the workspace.

Settings is a modal: Model Providers, Local Models, Appearance, Games, Harness, Permissions,
Privacy and About. Narrow windows use a drawer; wide ones remember the sidebar.

The bell keeps questions, plans and permission requests until answered, then build endings and
sign-outs; a count marks waiting work, a dot unread news. Rows open where the answer lives;
unfocused, macOS notifications and the Dock badge carry them.

## First launch

An empty, never-welcomed profile opens a full-window welcome: a prompt plays through Plan your
game, Build with workers and Reviewers test it, then Claude Code, ChatGPT or a local model connects. Skip or
Start building opens home; a typed idea waits in its composer.

Then a bottom-right Genex Tools card offers **Connect Genex plugin** once.

Without the process sandbox, **Set up the protected workspace** shows what is missing, commands
to copy and Retry.

## Main actions

- **Home's first message** starts a game the model names, where the chip says: an empty folder
  until that message picks its kind. Duplicates never overwrite; a greeting stays **Untitled game** until an idea. **New game**, the Games **+** and Command-N open home.
- **Settings → Games** moves new games to another empty folder (default `~/AI Games`).
- **Settings → Privacy**: Share build metrics (off by default), See what would be sent and
  Delete what I shared ([PRIVACY](../../PRIVACY.md)).
- Home's **Open a folder…** inspects before writing (Claude settings and hooks trusted unless
  switched off); only a web folder gets starter files.
- A game's menu offers Rename (same folder), Pin/Unpin, Change image and Delete. Delete
  drops only the library entry (active work blocks it; reopening the folder restores it).
- The chat header shows the title, Show in Finder, Terminal and ⋯ (Export game…, Clear Rewind
  history… with the space it frees, Rename); Harness and unbound drafts have neither. Clearing
  keeps save points, the game's history and paused builds. Search reaches older and unbound chats.
- Command-B toggles navigation, Command-K searches, Command-2 opens Harness, Command-1 the
  last game chat.

## State and appearance

A game's folder owns its identity. Commits and checkpoints skip its current engines' scratch
(`Saved/`, `.godot/`, Blender backups); tracked files stay. Rollback snapshots first, refusing
changed branches, commits or merges. Snapshots and links use raw bytes, Git hooks and filters off; LFS pointers stay
pointers. [Design](../agent/design.md#studio-hierarchy-and-progressive-disclosure)
covers sphere/uploaded covers. Unsent text survives loading; hidden workspaces ignore keys.

The live game is a native view outside React that drawers, dialogs, Plugins, Builds, Assets and
the Genex card occlude; desktop captures cannot prove it works.

## Where to work

- [Shell](../../src/renderer/shell): navigation, [home](../../src/renderer/shell/HomeScreen.tsx),
  selected conversation, stage, [notification feed](../../src/renderer/notifications.ts).
- [Onboarding](../../src/renderer/onboarding/Onboarding.tsx): first launch.
- [Chat header](../../src/renderer/panels/ChatHeader.tsx) and
  [Settings](../../src/renderer/panels/SettingsDialog.tsx): workspace actions.
- [Architecture](../agent/architecture.md): persistence, native preview, boot;
  [Feature Map](../agent/feature-map.md): selectors and checks.
