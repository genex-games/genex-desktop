# Builds and Live

## From a request to a game

Auto edits directly; Loop can delegate workers (default four, unless chosen), with chat leading.
Parts grow boldly within the ask; an art director regularly reviews the whole game, names what
must not regress and, from the finish mark, sends defects back for polish, never a veto.
Timed builds use their window; until-satisfied ones finish on verified required outcomes, time
only a ceiling. Acceptance persists across workers and restarts. External blockers pause the
run at its checkpoint. User Finish overrides the clock, never the final judge.
[Harness runtime](../harness-runtime.md#goal-completion-and-worker-approvals) owns completion and
recovery details.

An active run opens Builds once; later tab choices are the user's, except that showing a
build from the chat opens Live. Without a plan or run, a stored Builds
choice falls back to Live. A file or image opened from the chat adds a tab named for it until
closed, with Show in Finder for game-folder files.

## The two views

**Live** plays the browser game in a native view (WebGL and WebGPU); hidden unobserved previews
pause. The strip holds Live/Builds/Assets, Play/Stop, Reload, the sound switch (⌥⌘M; only a shown
Live in front is heard), Full screen (hold Esc to leave) and plugin actions such as Publish (accent
until listed). Stop waits for pending loads, then halts the game until Play or Reload; Unity
stops the browser preview. Slow loads show a halftone loader and shimmering “Loading game”.
Empty scaffolds show “Ready for your first idea” (computer) or “Building your game” (crane), with
Watch progress during runs and Play latest when ready; the first healthy build appears automatically.
Otherwise only the user changes Live (opening a game, Reload, Play, Make live, a chat request
while Live is hidden). A newer healthy build, a
changed game folder (checkpoint, landing, rewind), a chat's show or landing, or a shown build found
broken lights Reload (accent dot, a tooltip naming it), which brings it in. While Live is hidden and
not stopped, all but a new build go in at once. A loaded page alone is not a successful build. The
preview reaches only public library CDNs; Open Game names other hosts.

**Builds** is a graph: You asked, a row per part, Your build, then the lead while no part
works. Tries at one step fold into one node; what reached the build forms the line, the rest
hangs below. An eye marks nodes the reviewers looked at. A new build is “Checking it starts…” until
it has run. Its header shows only time worked. A working node shows its agent's screen and action (“Pressing Space · 3s”). A selected
node opens in place as a card without zooming; an eye opens it on the reviewers' notes. **Follow up in chat** turns the next message into a note to that node's build.
An earlier build opens from its chat card.

Agents test in hidden windows, never in Live; the lead's frames the chat reuses
never certify a delivered build. A finished worker, passing checks, integration and Live's
revision are distinct facts that summaries never merge. Chat shows the delivery's capture and Play, failures included; Builds
and Studio report missing checks, coverage limits, counts and revisions.

## Continuation and interruption

After a chat-led build, its session takes follow-ups: game edits, resuming a paused run
with its time left, starting over only when asked. With Loop on, a small change is made directly;
more work reopens the build until checked. One the chat cannot continue, like Ollama's, is answered
as with Loop off, noting it once. **Stop** interrupts work immediately, preserving finished
work; a stopped Loop run shows one Stopped line with Resume, and Builds or a chat request makes its
build live. Limit, outage and crash pauses resume twice unless stopped (Settings → Harness); sign-in
pauses wait. A crash or restart settles abandoned activity from persisted state; stopped, failed,
incomplete and delivered outcomes stay distinct.

## Where to work

- [WorkspaceStage](../../src/renderer/shell/WorkspaceStage.tsx) selects the stage;
  [PreviewPanel](../../src/renderer/panels/PreviewPanel.tsx) manages Live/Builds/Assets.
- [run-steps](../../src/renderer/run-steps.ts) folds steps; [RunGraph](../../src/renderer/panels/RunGraph.tsx)
  and [RunInspector](../../src/renderer/panels/RunInspector.tsx) draw them.
- [Conversation coordinator](../conversation-coordinator.md): queue, continuation and Stop.
- Check [Architecture](../agent/architecture.md) and [Verification](../agent/verification.md)
  before changing a run, preview or recovery contract.
