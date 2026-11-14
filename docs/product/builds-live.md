# Builds and Live

## From a request to a game

No mode to set: the agent answers and makes quick fixes itself; a build (a Loop) makes only what's
asked: a paused one goes on, a new one starts only when needed. The chat
leads it beside workers [in the game's folder](projects-engines.md#loops-in-place); judges answer
only when asked. Only its lead or the person ends it; a turn ending idle pauses it. Given a time
("work 3h"), its lead works it all first. Acceptance survives restarts. Asked to
finish, the lead's last turn ends it ([details](../harness-runtime.md#goal-completion-and-worker-approvals)).
Ollama's chat starts no Loop.

An active run opens Builds once; a build shown from chat or empty Builds opens Live. Files and images opened from chat get tabs.

## The two views

**Live** plays the browser game natively; previews pause unwatched or hidden. Pages load
hidden at Live's size, shown once the game asks for a frame (3 s at most). Opened tabs stay. The strip
holds Live/Builds/[Design](../design-board.md)/Assets, Reload, Play/Stop and Sound (⌥⌘M; heard when shown) once the
game has content, Full screen (hold Esc), plugin actions, Multiplayer, Publish. Stop halts it until
Play/Reload. An empty scaffold shows “Ready for your first idea”, or
“Building your game” with Watch progress, then Play latest; the first healthy build shows itself.
Opening a game starts nothing. Otherwise only the user changes Live (Play,
Reload, Make live) or a finished engine `web/` build. A changed game folder or a broken shown
build lights Reload; hidden and not stopped, they go in at once. The
preview's network is open, as a web page's. Other folders' views:
[projects](projects-engines.md#lives-views).

**Builds** is a list filling the panel: Working now, then What changed, newest first; a finished run's
build heads it. A row is a step: its mark, when it ended, what it made (“Model · 2 versions”,
“12 sounds”) or how it stands, and its pictures (at work: its agent's screen). Steps left out of the
build gather under one “N left out” row. A failed build check is a row; the lead is one only while
it works itself. A pressed row opens under its unmoved header (arrows walk, Esc closes). Tries a pause cut off show Paused until added. **Follow up in chat** notes the
next message to its build. Tabs (one per build; past three, one picker, newest first) and chat
cards open earlier builds, by title. Past seven steps, the chat's Building card folds its done ones;
pressing one opens it here. Plan steps tick per save point ("Step 3 of 4 · …", else the lead's
last words); done, it reads "Version N is in your game".

Agents test hidden (Godot too), never Live. A finished worker, its merge and Live's revision
differ; chat shows a delivery's capture, failures too. A web game's finish loads its page once
(`?genex-shot=1`); unless clean (loads, no uncaught error, not blank), the Loop goes on. That look
pictures Your build and pictureless save points.

## Continuation and interruption

After a chat-led build, its session takes follow-ups: edits, resuming a paused run, or a
new Loop for more work than a reply holds. **Stop** interrupts at once, keeping finished
work: a stopped Loop shows one Stopped line with Resume. Resume refuses an earlier Genex's
paused web Loop; its card names the git ref keeping the work, for the chat to bring in. Limit, outage and crash pauses resume twice unless stopped (Settings → Harness); sign-in
pauses wait. A crash or restart settles leftover activity.

## Where to work

- [WorkspaceStage](../../src/renderer/shell/WorkspaceStage.tsx) picks the stage,
  [PreviewPanel](../../src/renderer/panels/PreviewPanel.tsx) its tabs; [run-steps](../../src/renderer/run-steps.ts)
  folds steps that [builds-list](../../src/renderer/panels/run-graph/builds-list.ts) lists,
  [RunGraph](../../src/renderer/panels/RunGraph.tsx) and
  [RunInspector](../../src/renderer/panels/RunInspector.tsx) draw.
- [Conversation lifecycle](../conversation-lifecycle.md): queue, continuation and Stop.
- [Architecture](../agent/architecture.md) and [Verification](../agent/verification.md): the run,
  preview and recovery contracts.
