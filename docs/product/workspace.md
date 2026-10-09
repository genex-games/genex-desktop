# Workspace and games

## What the user sees

Navigation offers Search, Notifications, Send feedback
([payload](../../PRIVACY.md#send-feedback)), New game, Plugins, Harness, Settings and Games.
Pending updates offer **Relaunch to update** (Linux: **Download**). Games scroll, pinned first then recent.
Launch opens **home**: one composer over an optional picture. A game opens its conversation beside
the stage (Live, Builds once planned, Assets); Harness opens its conversation and Activity;
Plugins fills the workspace.

Unity uses a native stage and activated Editor ([Unity](../unity.md)); browser-scored Auto/Loop remains browser-only.

Settings is a modal: Model Providers, Local Models, Appearance, Games, Harness, Permissions,
Privacy and About. Narrow windows use a drawer; wide ones remember the sidebar.
Windows respects the display's work area; acceptance keeps fixed dimensions.

The bell keeps questions, plans and permission requests until answered, then build endings and
sign-outs; a count marks waiting work, a dot unread news. Rows open where the answer lives;
unfocused, macOS notifications and the Dock badge carry them.

## First launch

New profiles open welcome: a prompt plays through Plan your
game, Build with workers and Reviewers test it, then Claude Code, ChatGPT or a local model connects. Skip or
Start building opens home; a typed idea waits in its composer.

Genex Tools then offers **Connect Genex plugin** once.

**Set up the protected workspace** handles missing sandbox prerequisites. Windows starts setup
once: private Git Bash when missing, then the shipped Sandbox through one administrator prompt.
Cancellation and failures keep Set up available. Linux offers install commands. Retry checks again.

## Main actions

- **Home's first message** starts a game the model names, where the chip says; duplicates
  never overwrite games. A greeting stays **Untitled game** until an idea. **New game**, the Games **+** and Cmd/Ctrl-N open home.
- **Settings → Games** moves new games to another empty folder (default `~/AI Games`).
- **Settings → Privacy**: Share build metrics (off by default), See what would be sent and
  Delete what I shared ([PRIVACY](../../PRIVACY.md)).
- Home's **Open a folder…** inspects before anything is written; the sheet trusts its
  Claude settings and hooks unless switched off.
- A game's menu offers Rename, Pin/Unpin, Change image and Delete. Renaming keeps the
  folder. Delete removes the library entry, keeping files and history; active
  work blocks it; reopening its folder restores it.
- The chat header shows the title, the file manager (Windows: Explorer), Terminal and ⋯ (Export game…, Rename);
  Harness and unbound drafts have no Export. Search reaches older and unbound chats.
- Cmd/Ctrl-B toggles navigation; Cmd/Ctrl-K searches; Cmd/Ctrl-2 opens Harness; Cmd/Ctrl-1
  returns to the last game chat. Shortcuts handle non-Latin layouts and yield to composition,
  dialogs, AltGr, modifiers and repeats.

## State and appearance

A game's folder owns its identity. Rollback snapshots adopted folders and refuses changed
branches, commits or merges. Chat links open game documents/media; executables appear
in the file manager. Snapshots and links use raw bytes with hooks and filters disabled; LFS pointers stay
pointers. [Design](../agent/design.md#studio-hierarchy-and-progressive-disclosure)
covers sphere/uploaded covers. Unsent text survives loading; hidden workspaces ignore keys.

The live game is a native view outside React: drawers, dialogs, Plugins, Builds, Assets and the
Genex card occlude it; a desktop capture cannot prove the game works.

## Where to work

- [Shell](../../src/renderer/shell): navigation, [home](../../src/renderer/shell/HomeScreen.tsx),
  selected conversation, stage and the [notification feed](../../src/renderer/notifications.ts).
- [Onboarding](../../src/renderer/onboarding/Onboarding.tsx): first launch.
- [Chat header](../../src/renderer/panels/ChatHeader.tsx) and
  [Settings](../../src/renderer/panels/SettingsDialog.tsx): workspace actions.
- [Architecture](../agent/architecture.md) covers library persistence, the native preview and
  boot state; the [Feature Map](../agent/feature-map.md) lists selectors and checks.
