# Builds and Live

## From a request to a game

No mode to set: the agent answers and makes quick fixes itself; making the game is a build (a
Loop): a paused one goes on, a new one starts only when needed. The chat
leads it beside workers [in the game's folder](projects-engines.md#loops-in-place); judges answer
only when asked. Only its lead or the person ends it; a turn ending idle pauses it. Given a time
("work 3h"), its lead works it all first. Acceptance survives restarts. Asked to
finish, the lead's last turn ends it ([details](../harness-runtime.md#goal-completion-and-worker-approvals)).
Ollama's chat answers and edits, starting no Loop.

An active run opens Builds once; a build shown from chat, or empty Builds, opens Live. Files and images opened from chat get closable tabs.

## The two views

**Live** plays the browser game natively; previews pause unwatched or hidden. Pages load
hidden at Live's size, never at none. The strip
holds Live/Builds/Assets, Reload, Play/Stop and Sound (⌥⌘M; heard when shown) once the
game has content, Full screen (hold Esc), plugin actions, Multiplayer, Publish. Stop halts it until
Play/Reload. An empty scaffold shows “Ready for your first idea”, or
“Building your game” with Watch progress, then Play latest; the first healthy build shows itself.
Opening a game starts nothing: Live keeps its game. Otherwise only the user changes Live (Play,
Reload, Make live) or a finished Unity/Godot `web/` build. A changed game folder or a broken shown
build lights Reload; hidden and not stopped, they go in at once. The
preview's network is open, as a web page's. Other folders' views:
[projects](projects-engines.md#lives-views).

**Builds** is a graph: You asked (latest ask, its pictures), a row per part, Your build, then the lead while no part
works. Tries at one step fold into one node; what reached the build forms the line, the rest
hangs below. Tries a pause cut off show Paused until added. An eye opens the reviewers' notes. A
working node shows its agent's screen; a selected one opens as a card. **Follow up in chat** notes
the next message to its build. Tabs (one per build; past three, one picker, newest first) and chat
cards open earlier builds. A Loop, workers, jobs or a claim make a tree: the lead (jobs below),
then, when asked, a finish check. A Loop's line is its save points
(an earlier Genex's web Loop: its builds); workers hang off them, solid under the one taking their
work, else ghosts, each asset they made a card below (made again: a version); past three finished
per point fold into “+N workers”. Compares show one frame (consecutive points or builds, asset
versions) only where pixels differ, else say nothing visibly changed.

Agents test hidden (Godot too), never Live. A finished worker, its merge and Live's revision
differ; chat shows a delivery's capture, failures too. A web game's finish first loads its page
once (`?genex-shot=1` a game may read); unless it loads, throws nothing uncaught and is not blank,
the Loop goes on.

## Continuation and interruption

After a chat-led build, its session takes follow-ups: edits, resuming a paused run, or a
new Loop for more work than a reply holds. **Stop** interrupts at once, keeping finished
work: a stopped Loop shows one Stopped line with Resume. Resume refuses an earlier Genex's
paused web Loop; its card names the git ref keeping the work, for the chat to bring in. Limit, outage and crash pauses resume twice unless stopped (Settings → Harness); sign-in
pauses wait. A crash or restart settles abandoned activity from saved state.

## Where to work

- [WorkspaceStage](../../src/renderer/shell/WorkspaceStage.tsx) picks the stage,
  [PreviewPanel](../../src/renderer/panels/PreviewPanel.tsx) its tabs; [run-steps](../../src/renderer/run-steps.ts)
  folds steps that [RunGraph](../../src/renderer/panels/RunGraph.tsx) and
  [RunInspector](../../src/renderer/panels/RunInspector.tsx) draw.
- [Conversation lifecycle](../conversation-lifecycle.md): queue, continuation and Stop.
- [Architecture](../agent/architecture.md) and [Verification](../agent/verification.md): the run,
  preview and recovery contracts.
