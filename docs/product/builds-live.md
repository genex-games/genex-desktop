# Builds and Live

## From a request to a game

Auto edits directly or starts a Loop when asked: workers (four by default) while the chat leads.
Parts grow boldly within the ask; an art director reviews the whole game, its blockers alone
sending a part back. Other projects' Loops run [in place](projects-engines.md#loops-in-place).
Loop hours are a soft cap (a reviewer's yes ends early, in place after the lead's named gaps; 15
minutes' grace). Acceptance survives workers and restarts; external blockers pause at a
checkpoint; ∞ ends on verified outcomes with no blocker. Asked to finish, the lead lets rounds
end, then lands; Finish overrides the clock, never the final judge
([details](../harness-runtime.md#goal-completion-and-worker-approvals)).

An active run opens Builds once; a chat-shown build, or empty Builds, opens Live. Chat's files and images get closable tabs.

## The two views

**Live** plays the browser game in a native view; previews pause unwatched or hidden. The strip
holds Live/Builds/Assets, Reload, Play/Stop and Sound (⌥⌘M; heard when shown) once the
game has content, Full screen (hold Esc), plugin actions, Multiplayer, Publish. Stop halts it until
Play/Reload. An empty scaffold shows “Ready for your first idea”, or
“Building your game” with Watch progress, then Play latest; the first healthy build shows itself.
Otherwise only the user changes Live (opening a game, Reload, Play, Make live, a chat request while
hidden) or a finished Unity/Godot `web/` build. A newer healthy build, a changed folder
(checkpoint, landing, rewind), a chat's show or a broken shown build lights Reload and a line
above the game with Update (a compiled game's changed folder builds first, timed, for the view
shown); hidden and not stopped, all but a new build go in at once; Rust `assets/`-only changes swap in mid-play. The
preview reaches only public library CDNs; Open Game names other hosts. Other folders:
[projects](projects-engines.md#lives-views).

**Compiled games** (C++ · raylib; Rust · wgpu, needing WebGPU, on Apple-silicon Macs or Linux
x64) build per destination, sandboxed; **Web | Native** shows the Mac build in Live (of what Live
shows: a played build's copy, else the folder; the card counts its build time; Full screen; `game.mouseLook`
locks the pointer), a crash its card, Rust a profile strip and `[net]` room; only **On a device** installs a phone build
([more](../agent/feature-map.md)). Rust's `genex.toml` turns on nav, streaming and animation (off
in the starter).

**Builds** is a graph: You asked, a row per part, Your build, then the lead while no part
works. Tries at one step fold into one node: what reached the build forms the line, the rest
hangs below, and tries a pause cut off show Paused until added. An eye opens reviewers' notes. A
new build is “Checking it starts…” until it runs. A working node shows its agent's screen and
action; a selected one opens as a card; **Follow up in chat** notes the next message to its build.
Tabs (one per build; past three, a picker) and chat cards open earlier builds. A Loop, workers,
jobs or a claim make a tree: the lead (jobs below), then the finish check (Checking, Not yet with
reasons, Done, Stopped). In place, save points form one line, workers solid under the one taking
their work, else ghosts.

Agents test in hidden windows, never Live; blind judges play when screenshots can't decide;
chat frames never certify a build. A finished worker, passing checks, integration and Live's
revision are distinct facts; Builds and Studio report what is missing, coverage, revisions and
studio-verified plays.

## Continuation and interruption

After a chat-led build, its session takes follow-ups: edits, resuming a paused run
with its time left, starting over only when asked. With Loop on, small changes go direct;
more work reopens the build until checked (other projects start anew); a chat that cannot
(Ollama's) answers as with Loop off, saying so once. **Stop** interrupts at once, keeping finished
work: a stopped Loop shows one Stopped line with Resume, and Builds or chat makes it live. Limit, outage and crash pauses resume twice unless stopped (Settings → Harness); sign-in
pauses wait. A crash or restart settles abandoned activity from saved state.

## Where to work

- Stage: [WorkspaceStage](../../src/renderer/shell/WorkspaceStage.tsx),
  [PreviewPanel](../../src/renderer/panels/PreviewPanel.tsx); steps: [run-steps](../../src/renderer/run-steps.ts),
  [RunGraph](../../src/renderer/panels/RunGraph.tsx), [RunInspector](../../src/renderer/panels/RunInspector.tsx).
- [Conversation coordinator](../conversation-coordinator.md): queue, continuation, Stop;
  [Architecture](../agent/architecture.md), [Verification](../agent/verification.md): run, preview,
  recovery.
