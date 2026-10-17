# Builds and Live

## From a request to a game

Auto edits directly; Loop delegates workers (four by default) while the chat
leads. Parts grow boldly within the ask; an art director reviews the whole game; only its
blockers send a part back (flaws and nits are reported). Other
projects' Loops run [in place](projects-engines.md#loops-in-place). Loop hours are a soft cap (a
reviewer's yes ends it early, in place after the lead's named gaps; 15 minutes' grace).
Acceptance survives workers and restarts. External blockers pause the run at its
checkpoint. ∞ ends on verified outcomes with no blocker. Asked in chat to finish, the lead lets
rounds end, then lands. Finish overrides the clock, never the final judge
([details](../harness-runtime.md#goal-completion-and-worker-approvals)).

An active run opens Builds once; a build shown from chat, or an empty Builds, opens
Live. Files and images opened from chat get closable tabs.

## The two views

**Live** plays the browser game in a native view; unwatched previews pause. The strip
holds Live/Builds/Assets, Reload, Play/Stop and Sound (⌥⌘M; heard only when shown) once the
game has content, Full screen (hold Esc), plugin actions, Multiplayer and Publish. Stop halts it until Play
or Reload. An empty scaffold shows “Ready for your first idea”, or
“Building your game” with Watch progress, then Play latest; the first healthy build shows itself.
Otherwise only the user changes Live (opening a game, Reload, Play, Make live, a chat request while
hidden). A newer healthy build, a changed game folder (checkpoint, landing, rewind), a chat's show
or landing, or a broken shown build lights Reload; hidden and not stopped, all but a new build go
in at once. The
preview reaches only public library CDNs; Open Game names other hosts. Other folders' views:
[projects](projects-engines.md#lives-views).

**Builds** is a graph: You asked, a row per part, Your build, then the lead while no part
works. Tries at one step fold into one node; what reached the build forms the line, the rest
hangs below. Tries a pause cut off show Paused until added. An eye marks (and opens) the reviewers'
notes. A new build is “Checking it starts…” until it runs. A working node shows its agent's
screen and action; a selected one opens as a card. **Follow up in chat** notes the next message to its build.
Chat cards open earlier builds. A Loop, workers, jobs or a claim make a tree: the lead (jobs
below), then the finish check tinted Checking, Not yet (reasons, round of 3), Done or Stopped, a chat
line each round. In place, save points form one line showing each change; workers hang off
it, solid under the save point taking their work, else ghosts. A chat message's
workers get a graph while newest.

Agents test in hidden windows, never Live; blind judges play when screenshots can't decide;
chat frames never certify a build. A finished worker, passing checks, integration and Live's
revision are distinct facts; Builds and Studio report missing checks, coverage, revisions and
studio-verified plays; chat shows a delivery's capture, failures too.

## Continuation and interruption

After a chat-led build, its session takes follow-ups: edits, resuming a paused run
with its time left, starting over only when asked. With Loop on, small changes are made directly;
more work reopens the build until checked (other projects start anew); a chat that cannot
(Ollama's) answers as with Loop off, saying so once. **Stop** interrupts at once, keeping finished
work: a stopped Loop shows one Stopped line with Resume, and Builds or chat makes it live. Limit, outage and crash pauses resume twice unless stopped (Settings → Harness); sign-in
pauses wait. A crash or restart settles abandoned activity from saved state.

## Where to work

- [WorkspaceStage](../../src/renderer/shell/WorkspaceStage.tsx) picks the stage,
  [PreviewPanel](../../src/renderer/panels/PreviewPanel.tsx) its tabs; [run-steps](../../src/renderer/run-steps.ts)
  folds steps that [RunGraph](../../src/renderer/panels/RunGraph.tsx) and
  [RunInspector](../../src/renderer/panels/RunInspector.tsx) draw.
- [Conversation coordinator](../conversation-coordinator.md): queue, continuation and Stop.
- [Architecture](../agent/architecture.md) and [Verification](../agent/verification.md): the run,
  preview and recovery contracts.
