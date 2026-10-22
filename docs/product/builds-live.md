# Builds and Live

## From a request to a game

Auto edits directly; Loop delegates workers (four by default) while the chat
leads. Parts grow boldly within the ask; an art director reviews the whole game, and only its
blockers send a part back (flaws and nits are reported). Other
projects' Loops run [in place](projects-engines.md#loops-in-place). Loop hours are a soft cap: a
reviewer's yes ends it early; 15 minutes' grace follows.
Acceptance persists across workers and restarts. External blockers pause the run at its
checkpoint. ∞ ends on verified outcomes with no blocker. Asked in chat to finish, the lead lets
rounds end, then lands. Finish overrides the clock, never the final judge
([details](../harness-runtime.md#goal-completion-and-worker-approvals)).

An active run opens Builds once; a build shown from the chat, or Builds with nothing to draw, opens
Live. Files and images opened from chat get closable tabs.

## The two views

**Live** plays the browser game in a native view; unwatched previews pause. The strip
holds Live/Builds/Assets, Play/Stop, Reload, the sound switch (⌥⌘M; only a shown Live is heard),
Full screen (hold Esc) and plugin actions (Publish). An empty scaffold shows “Ready for your first idea”, or
“Building your game” with Watch progress, then Play latest; the first healthy build shows itself.
Otherwise only the user changes Live (opening a game, Reload, Play, Make live, a chat request while
hidden). A newer healthy build, a changed game folder (checkpoint, landing, rewind), a chat's show
or landing, or a broken shown build lights Reload; hidden and not stopped, all but a new build go
in at once; Rust `assets/`-only changes swap in mid-play. The
preview reaches only public library CDNs; Open Game names other hosts. Other folders:
[projects](projects-engines.md#lives-views).

**Compiled games** (C++ · raylib; Rust · wgpu on Apple-silicon Macs or Linux x64) build per
destination, sandboxed; **Web | Native** shows the Mac build in Live. Rust needs WebGPU. Only your
**On a device** press installs a phone build ([feature map](../agent/feature-map.md)).
A crash shows its card. Rust adds a profile strip and a `[net]` loopback room (test
multiplayer in two Genex draft windows).

**Builds** is a graph: You asked, a row per part, Your build, then the lead while no part
works. Tries at one step fold into one node; what reached the build forms the line, the rest
hangs below. Tries a pause cut off show Paused until added. An eye opens reviewers'
notes. A new build is “Checking it starts…” until it runs. A working node shows its agent's
screen; a selected one opens as a card. **Follow up in chat** notes the next message to its build.
Earlier builds open from chat cards. A Loop's lead, workers and jobs make a tree ending in the finish check (Checking, Not
yet, Done or Stopped; [feature map](../agent/feature-map.md)); a chat message's workers get a graph.

Agents test in hidden windows, never Live; chat frames never certify a build. A finished
worker, passing checks, integration and Live's revision are distinct facts; Builds and Studio
report missing checks and coverage limits.

## Continuation and interruption

After a chat-led build, its session takes follow-ups: game edits, resuming a paused run
with its time left, starting over only when asked. With Loop on, small changes go direct;
more work reopens the build until checked (other projects start anew); a chat that cannot, like
Ollama's, answers as with Loop off, saying so once. **Stop** interrupts at once, keeping finished
work: a stopped Loop shows one Stopped line with Resume, and Builds or a chat request makes it live. Limit, outage and crash pauses resume twice unless stopped (Settings → Harness); sign-in
pauses wait. A crash or restart settles abandoned activity from saved state.

## Where to work

- [WorkspaceStage](../../src/renderer/shell/WorkspaceStage.tsx) picks the stage,
  [PreviewPanel](../../src/renderer/panels/PreviewPanel.tsx) its tabs; [run-steps](../../src/renderer/run-steps.ts)
  folds steps that [RunGraph](../../src/renderer/panels/RunGraph.tsx) and
  [RunInspector](../../src/renderer/panels/RunInspector.tsx) draw.
- [Conversation coordinator](../conversation-coordinator.md): queue, continuation and Stop.
- [Architecture](../agent/architecture.md) and [Verification](../agent/verification.md): run,
  preview and recovery contracts.
