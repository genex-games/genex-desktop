# Workspace and games

## What the user sees

The sidebar contains Search, Notifications, Send feedback
([what it sends](../../PRIVACY.md#send-feedback)), New game, Plugins, Harness, Settings, Games
and, once updates wait, **Update plugins** and **Relaunch to update** (Linux: **Download**); only
games scroll. Pinned games lead, then recent activity. Every launch opens **home** (also the
wordmark): nothing selected, one composer over an optional picture.

Settings is a modal: Model Providers, Local Models, Toolchains, Appearance, Games, Storage, Harness,
Permissions, Privacy, About. Narrow windows use a drawer; wide ones remember the sidebar.

The bell keeps questions, plans and permission requests until answered, then build endings and
sign-outs; a count marks waiting work, a dot unread news. Rows open where the answer lives;
unfocused, macOS notifications and the Dock badge carry them.

## First launch

A never-welcomed profile with no games opens a full-window welcome that ends connecting Claude
Code, ChatGPT, a local model, OpenRouter or OpenCode; Skip or Start building opens home, keeping a
typed idea.

Then a Genex Tools card offers **Connect Genex plugin** once.

A sandbox that cannot start opens **Set up the protected workspace**: what is missing or blocked,
commands to copy, Retry.

## Main actions

- **Home's first message** starts a game the model names, where the chip says
  ([its kind](projects-engines.md)). Duplicates never overwrite; a greeting stays **Untitled game** until an idea. **New game**, the Games **+** and Command-N open home.
- **Create game** offers Three.js or Rust · wgpu (not C++ · raylib), starting on Rust where it
  builds ([rollback](../release-operations.md#default-stack-and-rollback)).
- **Settings → Games** moves new games to an empty folder (default `~/AI Games`);
  **Storage** frees older builds, keeping paused and latest.
- **Settings → Privacy**: Share build metrics (off by default), See what would be sent and
  Delete what I shared ([PRIVACY](../../PRIVACY.md)).
- Home's **Open a folder…** inspects before writing (Claude settings and hooks trusted unless
  switched off); only a web folder gets starter files.
- A game's menu offers Rename (same folder), Pin/Unpin, Change image and Delete, which
  drops only the library entry (active work blocks it; reopening restores it).
- The chat header shows the title, Show in Finder, Terminal, ⋯ (Export game…, Rename) and
  **Free N GB** past 1 GB; Harness and unbound drafts have none. Compiled games export per
  destination (phones **Untested on real devices**). Search reaches older and unbound chats.
- Command-B toggles navigation, Command-K searches, Command-2 Harness, Command-1 the last chat.

## State and appearance

A game's folder owns its identity. Commits and checkpoints skip its engines' scratch (`Saved/`,
`.godot/`, Blender backups). Rollback snapshots first, refusing
changed branches, commits or merges. Snapshots and links use raw bytes, Git hooks and filters off; LFS pointers stay
pointers. Unsent text survives loading; hidden workspaces ignore keys.

The live game is a native view outside React that overlays occlude; desktop captures can't prove it.

## Where to work

- [Shell](../../src/renderer/shell): navigation, [home](../../src/renderer/shell/HomeScreen.tsx),
  selected conversation, stage, [notification feed](../../src/renderer/notifications.ts).
- [Onboarding](../../src/renderer/onboarding/Onboarding.tsx): first launch.
- [Chat header](../../src/renderer/panels/ChatHeader.tsx) and
  [Settings](../../src/renderer/panels/SettingsDialog.tsx): workspace actions.
- [Architecture](../agent/architecture.md); [Feature Map](../agent/feature-map.md): selectors.
