# Builds and Live

## From a request to a game

Auto edits directly; Loop delegates workers (four by default; a chosen count stays) while the chat
leads. Parts grow boldly within the ask; an art director regularly reviews the whole game, names
what must not regress and, from the finish mark, returns defects for polish, never a veto. An
Unreal game has one lead building in the editor, judging its captures, with workers. Timed builds
use their window; until-satisfied ones finish on verified required outcomes, time only a ceiling.
Acceptance persists across workers and restarts. External blockers pause the run at its
checkpoint. User Finish overrides the clock, never the final judge
([details](../harness-runtime.md#goal-completion-and-worker-approvals)).

An active run opens Builds once; then the user chooses, but a build shown from the chat opens
Live. Without a plan or run, a stored Builds choice falls back to Live. A file or image
opened from the chat gets a closable tab, with Show in Finder for game-folder files.

## The two views

**Live** plays the browser game in a native view; unwatched previews pause. The strip
holds Live/Builds/Assets, Play/Stop, Reload, the sound switch (⌥⌘M; only a shown Live is heard),
Full screen (hold Esc to leave) and plugin actions such as Publish. Stop halts the game until Play
or Reload. An empty scaffold shows “Ready for your first idea”, or
“Building your game” with Watch progress while a run works, Play latest once a build is ready; the first healthy build then shows itself. Otherwise only the user changes Live (opening a
game, Reload, Play, Make live, a chat request while hidden). A newer healthy build, a
changed game folder (checkpoint, landing, rewind), a chat's show or landing, or a shown build found
broken lights Reload, which brings it in. While Live is hidden and
not stopped, all but a new build go in at once. A loaded page alone is not a successful build. The
preview reaches only public library CDNs; Open Game names other hosts. An Unreal game's Live shows
its project and next setup step, without web controls or Publish.

**Builds** is a graph: You asked, a row per part, Your build, then the lead while no part
works. Tries at one step fold into one node; what reached the build forms the line, the rest
hangs below. An eye marks nodes the reviewers looked at. A new build is “Checking it starts…” until
it has run. Its header shows time worked. A working node shows its agent's screen and action. A selected
node opens in place as a card; an eye opens it on the reviewers' notes. **Follow up in chat** turns the next message into a note to that node's build.
Earlier builds open from chat cards. An Unreal Loop's rows are the lead's kept milestone saves
(no eye), with worker nodes and critic advice. Workers, jobs or a lead
recording workers make a tree: the lead (jobs below), a row per worker, a Loop's finish check. Finished workers stand on the line, others are
ghosts. A chat message's workers get a graph, shown while newest.

Agents test in hidden windows, never in Live; lead frames reused in chat
never certify a delivered build. A finished worker, passing checks, integration and Live's
revision are distinct facts. Chat shows the delivery's capture and Play, failures included; Builds
and Studio report missing checks, coverage limits, counts and revisions.

## Continuation and interruption

After a chat-led build, its session takes follow-ups: game edits, resuming a paused run
with its time left, starting over only when asked. With Loop on, small changes are made directly;
more work reopens the build until checked (an Unreal game starts its next Loop). A chat that
cannot continue, like Ollama's, answers as with Loop off, noting it once. **Stop** interrupts at once, keeping finished
work; a stopped Loop run shows one Stopped line with Resume, and Builds or a chat request makes its
build live. Limit, outage and crash pauses resume twice unless stopped (Settings → Harness); sign-in
pauses wait. A crash or restart settles abandoned activity from saved state; stopped, failed, incomplete and
delivered outcomes stay distinct.

## Where to work

- [WorkspaceStage](../../src/renderer/shell/WorkspaceStage.tsx) picks the stage,
  [PreviewPanel](../../src/renderer/panels/PreviewPanel.tsx) its tabs; [run-steps](../../src/renderer/run-steps.ts)
  folds steps that [RunGraph](../../src/renderer/panels/RunGraph.tsx) and
  [RunInspector](../../src/renderer/panels/RunInspector.tsx) draw.
- [Conversation coordinator](../conversation-coordinator.md): queue, continuation and Stop.
- [Harness runtime](../harness-runtime.md): agent boundaries; [Unreal Loop](../plugins.md#mcp-servers).
- [Architecture](../agent/architecture.md) and [Verification](../agent/verification.md): the run,
  preview and recovery contracts.
